/**
 * 码道（CodeArts）上游客户端。
 *
 * 协议（全部实测，2026-10-23，账号 hw010200217）：
 *
 *   POST https://snap-access.cn-north-4.myhuaweicloud.com/api/v2/chat/completions
 *        x-auth-token: <STS security_token>
 *        Authorization: SDK-HMAC-SHA256 ...（AK/SK 签名）
 *        Agent-Type: PromptCenter
 *
 *   GET  /snap-manager/v1/statistics/plugin    -> 积分（总量/已用/剩余/到期/套餐）
 *   GET  /v1/model/builtin                     -> 内置模型清单（需 Agent-Type）
 *   GET  /snap-manager/v1/current/user         -> 稳定账号身份（归一重复条目用）
 *
 * 响应的 SSE 是 OpenAI 增量（choices[].delta.content / reasoning_content），但会夹带
 * 华为特有的事件（累积快照、结束态 error_code），所以不能原样透传，要逐帧翻译成标准
 * 的 OpenAI chunk。
 *
 * @module dsh-huawei-connect/codearts
 */
import { signHuaweiRequest } from './sign.mjs'
import {
  classifyUpstreamFailure,
  codeArtsHeaders,
  prepareCodeArtsBody,
  isImageUnsupportedError,
  CODEARTS_MAX_OUTPUT_TOKENS,
  CONTEXT_WINDOW,
} from './disguise.mjs'

/** 码道网关。cn-north-4 是国内唯一实测可用的区域。 */
export const CODEARTS_HOST = 'https://snap-access.cn-north-4.myhuaweicloud.com'
export const CODEARTS_CHAT_PATH = '/api/v2/chat/completions'
export const CODEARTS_CREDITS_PATH = '/snap-manager/v1/statistics/plugin'
export const CODEARTS_MODELS_PATH = '/v1/model/builtin'
export const CODEARTS_USER_PATH = '/snap-manager/v1/current/user'

function asRecord(value) {
  return typeof value === 'object' && value !== null && !Array.isArray(value) ? value : {}
}

function asArray(value) {
  return Array.isArray(value) ? value : []
}

function firstString(...values) {
  for (const value of values) {
    if (typeof value === 'string' && value.trim() !== '') return value.trim()
  }
  return ''
}

/** 非负数；上游用 -1 表示"该指标不适用"，一律当没有而不是 0。 */
function nonNegative(value) {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : undefined
}

/** 带 AK/SK 签名的请求。credential.securityToken 同时作 x-auth-token。 */
function signedFetch(credential, url, init) {
  const headers = signHuaweiRequest({
    method: init.method,
    url,
    body: init.body ?? '',
    headers: { 'x-auth-token': credential.securityToken, ...(init.headers ?? {}) },
    credentials: {
      accessKeyId: credential.accessKeyId,
      secretAccessKey: credential.secretAccessKey,
      securityToken: credential.securityToken,
    },
  })
  return fetch(url, {
    method: init.method,
    headers,
    ...(init.body === undefined ? {} : { body: init.body }),
    ...(init.signal === undefined ? {} : { signal: init.signal }),
  })
}

/** 解析 /snap-manager/v1/statistics/plugin。拿不到口径就返回 undefined。 */
export function parseCodeArtsCredits(raw) {
  const body = asRecord(raw)
  const metrics = body['metrics']
  if (!Array.isArray(metrics)) return undefined

  const metricNamed = (name) => {
    for (const item of asArray(metrics)) {
      const metric = asRecord(item)
      if (firstString(metric['name']) === name) return metric
    }
    return undefined
  }
  const groupOf = (metric) => {
    if (metric === undefined) return undefined
    const total = nonNegative(metric['package_credit_amount'])
    const used = nonNegative(metric['package_credit_used'])
    const remain = nonNegative(metric['package_credit_remain'])
    if (total === undefined && used === undefined && remain === undefined) return undefined
    const expiring = nonNegative(metric['package_credit_expiring_amount'])
    return {
      total: total ?? 0,
      used: used ?? 0,
      remain: remain ?? 0,
      ...(expiring === undefined ? {} : { expiring }),
    }
  }

  const total = groupOf(metricNamed('usageTotalPackageCredit'))
  if (total === undefined) return undefined
  const pkg = asRecord(body['package'])
  const bonus = groupOf(metricNamed('usageBonusPackageCredit'))
  const basic = groupOf(metricNamed('usageBasicPackageCredit'))
  const onDemand = groupOf(metricNamed('usageOnDemandPackageCredit'))
  const periodStart = firstString(body['start_date'])
  const periodEnd = firstString(body['end_date'])

  return {
    planName: firstString(pkg['package_name_cn'], pkg['package_name_en']) || undefined,
    planStatus: firstString(pkg['status']) || undefined,
    total,
    ...(bonus === undefined ? {} : { bonus }),
    ...(basic === undefined ? {} : { basic }),
    ...(onDemand === undefined ? {} : { onDemand }),
    ...(periodStart === '' ? {} : { periodStart }),
    ...(periodEnd === '' ? {} : { periodEnd }),
    fetchedAt: Date.now(),
  }
}

/** 拉一次积分。失败抛出，由调用方决定是报错还是沿用缓存。 */
export async function fetchCodeArtsCredits(credential, signal) {
  const response = await signedFetch(credential, CODEARTS_HOST + CODEARTS_CREDITS_PATH, {
    method: 'GET',
    ...(signal === undefined ? {} : { signal }),
  })
  const text = await response.text()
  if (!response.ok) {
    const failure = classifyUpstreamFailure(response.status, text)
    throw new Error('CodeArts 积分不可用 (' + failure.kind + '): ' + failure.message)
  }
  const parsed = parseCodeArtsCredits(JSON.parse(text))
  if (parsed === undefined) throw new Error('CodeArts 积分响应里没有额度口径')
  return parsed
}

/**
 * 模型清单。
 *
 * 先问 /v1/model/builtin（内置模型 + 上游给的描述）。上游只对 enable 的模型返回可用
 * 标记，被关掉的一律跳过。整路失败时返回空数组，由调用方退回种子清单——那条路径正是
 * "没登录 / 上游挂了"时还要能显示模型选择的保障。
 */
export async function fetchCodeArtsModels(credential, signal) {
  const response = await signedFetch(credential, CODEARTS_HOST + CODEARTS_MODELS_PATH, {
    method: 'GET',
    headers: codeArtsHeaders(),
    ...(signal === undefined ? {} : { signal }),
  })
  const text = await response.text()
  if (!response.ok) throw new Error('CodeArts 模型清单失败: ' + text.slice(0, 200))
  const body = asRecord(JSON.parse(text))
  const models = []
  for (const row of asArray(body['builtinModels'])) {
    const model = asRecord(row)
    const id = firstString(model['model_id'], model['model_name'])
    // enable=false 是真的不可用；display_enabled 只控制"官网列表里是否展示"。
    // 实测两个多模态模型（Qwen3-VL-235B、kimi-k2.6-vl）都是 display_enabled=false
    // 但 enable=true 且真能出图，所以**不能**用它过滤，否则用户会看不到唯一能看图的模型。
    if (id === '' || model['enable'] === false) continue
    const description = firstString(model['model_desc'])
    const supportsImages = resolveImageCapability(id, description, model['supports_images'])
    models.push({
      id,
      name: firstString(model['model_name']) || id,
      contextWindow: CONTEXT_WINDOW,
      maxTokens: CODEARTS_MAX_OUTPUT_TOKENS,
      supportsImages,
      ...(description === '' ? {} : { description }),
    })
  }
  return models
}

/**
 * 多模态能力的**实测判据**（2026-11-12 复测，账号 zxc147396）。
 *
 * 为什么需要这张表：`supports_images` 是上游给的**宣传性**标记，和真能不能看图并不
 * 总是一致；插件自己的种子清单当初按"GLM/盘古都是多模态"猜，结果猜反了。真发图
 * 的实测结果是：
 *
 *   能吃图（带 1KB PNG，正常返回内容）
 *     deepseek-v4.1-flash / deepseek-v4.1-flash-1017 / kimi-k3 / kimi-k3.1-pro
 *     glm-5.3-flash（能收，但内容会被它的安全策略判 81011，那是审核不是格式）
 *
 *   不吃图（流内直接 `InferHub.001001020.406 The request model is not multimodal`）
 *     GLM-5.2 / glm-5.3 / openpangu-2.0-pro / openpangu-2.0-flash / glm-5.2-sft-harmony
 *
 * 这张表**优先于**上游的 `supports_images`：判错的代价是整轮对话直接废掉（错误在
 * 开流之后才出现，无法重放），而多声明一次"不吃图"最多只是少一次看图机会。
 */
export const CODEARTS_IMAGE_VERDICT = {
  'deepseek-v4.1-flash': true,
  'deepseek-v4.1-flash-1017': true,
  'kimi-k3': true,
  'kimi-k3.1-pro': true,
  'kimi-k2.6-vl': true,
  'glm-5.3-flash': true,
  'Qwen3-VL-235B': true,
  'GLM-5.2': false,
  'glm-5.3': false,
  'openpangu-2.0-pro': false,
  'openpangu-2.0-flash': false,
  'glm-5.2-sft-harmony': false,
}

/**
 * 一个模型吃不吃图。
 *
 * 顺序：实测表 -> 上游 `supports_images` -> 按 id/描述推断。上游字段只在实测表没
 * 覆盖的新模型上生效（那时它是唯一线索），已知模型一律以实测为准。
 */
export function resolveImageCapability(id, description, upstreamFlag) {
  const verdict = CODEARTS_IMAGE_VERDICT[id]
  if (verdict !== undefined) return verdict
  if (typeof upstreamFlag === 'boolean') return upstreamFlag
  return /VL|vision|multimodal/iu.test(id) || /多模态|视觉/iu.test(description ?? '')
}

/** 上游的稳定账号身份（登录后用来把同一账号归一，避免重复条目）。 */
export async function fetchCodeArtsIdentity(credential, signal) {
  try {
    const response = await signedFetch(credential, CODEARTS_HOST + CODEARTS_USER_PATH, {
      method: 'GET',
      ...(signal === undefined ? {} : { signal }),
    })
    if (!response.ok) return undefined
    const body = asRecord(await response.json())
    const userId = firstString(body['user_id'])
    if (userId === '') return undefined
    return { userId, userName: firstString(body['user_name']) }
  } catch {
    return undefined
  }
}

/**
 * 打开发往码道的聊天流。
 *
 * ok:true 表示已开流；ok:false 是**开流前**的失败（HTTP 非 2xx），可以安全地换号重试。
 * 开流后的帧内错误由 translateCodeArtsStream 处理——那时已经不能重放了。
 */
export async function openCodeArtsChat(credential, requestBody, signal) {
  const prepared = prepareCodeArtsBody(requestBody)
  const model = typeof prepared['model'] === 'string' ? prepared['model'] : ''
  const body = JSON.stringify(prepared)
  const response = await signedFetch(credential, CODEARTS_HOST + CODEARTS_CHAT_PATH, {
    method: 'POST',
    body,
    headers: codeArtsHeaders(),
    ...(signal === undefined ? {} : { signal }),
  })
  if (!response.ok || response.body === null) {
    const text = await response.text().catch(() => '')
    return { ok: false, failure: classifyUpstreamFailure(response.status, text) }
  }
  return { ok: true, stream: response.body, model }
}

/**
 * 一帧该发多少增量。
 *
 * 上游绝大多数时候发的是**真增量**（实测：每个 content 帧只有一个词片），但偶尔会
 * 重发整段累积文本。两者的区分只能靠"这一帧与已发全文的关系"：
 *
 *   - 已发为 "abc"、本帧为 "abc" + 新内容  -> 整段快照，只发新内容
 *   - 已发为 "abc"、本帧为 "d"              -> 真增量，整帧发出
 *   - 已发为 ""                            -> 第一帧，整帧发出
 *
 * 判错的代价是可见的：把增量当快照会丢掉回答（早期版本正是这样），把快照当增量会让
 * 回答在界面上重复 N 遍。
 */
function deltaOf(frame, emitted) {
  if (frame === '') return { increment: '', full: emitted }
  if (emitted !== '' && frame.startsWith(emitted)) {
    const increment = frame.slice(emitted.length)
    return { increment, full: frame }
  }
  return { increment: frame, full: emitted + frame }
}

function sseFrame(chunk) {
  return 'data: ' + JSON.stringify(chunk) + '\n\n'
}

function finishChunk(model) {
  return sseFrame({
    id: 'codearts',
    object: 'chat.completion.chunk',
    created: Math.floor(Date.now() / 1000),
    model,
    choices: [{ index: 0, delta: {}, finish_reason: 'stop' }],
  })
}

/**
 * 把码道的 SSE 逐帧翻译成标准 OpenAI chunk。
 *
 * 华为特有的帧：
 * - delta.reasoning_content：思考过程，映射成 DSH 认的 reasoning 增量。
 * - 顶层 error_code/code + msg：帧内失败。这类错误**开流之后**才出现，无法重放，只能
 *   作为一条 error chunk 交出去。
 * - 累积全文快照（content 是整段重发）：只取增量部分，否则 UI 会把回答重复显示。
 * - 末尾 usage 帧：转成带 usage 的收尾 chunk。
 */
export async function* translateCodeArtsStream(stream, onImageUnsupported) {
  const reader = stream.getReader()
  const decoder = new TextDecoder()
  let buffer = ''
  // 已发出的全文与已发出的思考过程。用来分辨"这一帧是增量"还是"整段快照重发"。
  let emittedText = ''
  let emittedReasoning = ''
  let finishSent = false

  try {
    for (;;) {
      const { done, value } = await reader.read()
      if (done) break
      buffer += decoder.decode(value, { stream: true })

      for (;;) {
        const boundary = buffer.indexOf('\n\n')
        if (boundary === -1) break
        const frame = buffer.slice(0, boundary)
        buffer = buffer.slice(boundary + 2)

        for (const line of frame.split('\n')) {
          const trimmed = line.trim()
          if (!trimmed.startsWith('data:')) continue
          const payload = trimmed.slice(5).trim()
          if (payload === '') continue
          if (payload === '[DONE]') {
            if (!finishSent) {
              finishSent = true
              yield finishChunk('')
            }
            continue
          }

          let parsed
          try {
            parsed = asRecord(JSON.parse(payload))
          } catch {
            continue
          }

          const errorCode = firstString(parsed['error_code'], parsed['code'])
          if (errorCode !== '') {
            const message = firstString(parsed['error_msg'], parsed['msg'], parsed['message'])
            // "这个模型不吃图"：开流之后才到，本轮救不回来，但必须让下一轮知道。
            // 回调会把该模型记进"已拒图"集合，之后同一模型的请求在**发送前**剥离图片。
            if (isImageUnsupportedError(errorCode + ' ' + message)) {
              onImageUnsupported?.()
              yield sseFrame({
                error: {
                  message:
                    '这个模型不接受图片输入（上游 ' +
                    errorCode +
                    '）。本轮已中断；插件已记住该模型的图片能力，下一轮会自动把图片换成文字占位，' +
                    '你也可以切到支持图片的模型（如 deepseek-v4.1-flash / kimi-k3）继续。',
                  type: 'image_unsupported',
                  code: errorCode,
                },
              })
              continue
            }
            const failure = classifyUpstreamFailure(200, errorCode + ' ' + message)
            yield sseFrame({ error: { message: failure.message, type: failure.kind, code: errorCode } })
            continue
          }

          const choice = asRecord(asArray(parsed['choices'])[0])
          const delta = asRecord(choice['delta'])
          const model = firstString(parsed['model'])

          const content = typeof delta['content'] === 'string' ? delta['content'] : ''
          const reasoning = typeof delta['reasoning_content'] === 'string' ? delta['reasoning_content'] : ''

          const reasoningDelta = deltaOf(reasoning, emittedReasoning)
          if (reasoningDelta.increment !== '') emittedReasoning = reasoningDelta.full

          const contentDelta = deltaOf(content, emittedText)
          if (contentDelta.increment !== '') emittedText = contentDelta.full

          const outDelta = {}
          if (reasoningDelta.increment !== '') outDelta['reasoning_content'] = reasoningDelta.increment
          if (contentDelta.increment !== '') outDelta['content'] = contentDelta.increment

          const usage = asRecord(parsed['usage'])
          const hasUsage = Object.keys(usage).length > 0
          const toolCalls = delta['tool_calls']
          if (
            outDelta['content'] === undefined &&
            outDelta['reasoning_content'] === undefined &&
            toolCalls === undefined &&
            !hasUsage
          ) {
            continue
          }

          const chunk = {
            id: firstString(parsed['id']) || 'codearts',
            object: 'chat.completion.chunk',
            created: typeof parsed['created'] === 'number' ? parsed['created'] : Math.floor(Date.now() / 1000),
            model,
            choices: [
              {
                index: 0,
                delta: { ...outDelta, ...(toolCalls === undefined ? {} : { tool_calls: toolCalls }) },
                finish_reason: choice['finish_reason'] ?? null,
              },
            ],
          }
          if (hasUsage) {
            chunk['usage'] = {
              prompt_tokens: nonNegative(usage['prompt_tokens']) ?? 0,
              completion_tokens: nonNegative(usage['completion_tokens']) ?? 0,
              total_tokens: nonNegative(usage['total_tokens']) ?? 0,
            }
          }
          yield sseFrame(chunk)
        }
      }
    }
  } finally {
    reader.releaseLock()
  }

  if (!finishSent) yield finishChunk('')
  yield 'data: [DONE]\n\n'
}

/**
 * 上游不可达时的种子清单（可达时会被真实清单覆盖）。
 *
 * `supportsImages` 一律来自 CODEARTS_IMAGE_VERDICT 的实测结论，**不要按模型名猜**：
 * 早先"GLM/盘古都多模态"的猜测让 GLM-5.2、openpangu-2.0-pro 都被标成能吃图，而它们
 * 真收图时是 `001001020 not multimodal` 硬拒绝——用户一贴图，整轮就废。反过来
 * kimi-k3 明明能吃图却被标成 false，等于白白丢掉一个可用的视觉模型。
 */
export const CODEARTS_SEED_MODELS = [
  { id: 'GLM-5.2', name: 'GLM-5.2', contextWindow: CONTEXT_WINDOW, maxTokens: CODEARTS_MAX_OUTPUT_TOKENS, supportsImages: CODEARTS_IMAGE_VERDICT['GLM-5.2'] },
  { id: 'glm-5.3', name: 'GLM-5.3', contextWindow: CONTEXT_WINDOW, maxTokens: CODEARTS_MAX_OUTPUT_TOKENS, supportsImages: CODEARTS_IMAGE_VERDICT['glm-5.3'] },
  { id: 'glm-5.3-flash', name: 'GLM-5.3-Flash', contextWindow: CONTEXT_WINDOW, maxTokens: CODEARTS_MAX_OUTPUT_TOKENS, supportsImages: CODEARTS_IMAGE_VERDICT['glm-5.3-flash'] },
  { id: 'deepseek-v4.1-flash', name: 'DeepSeek-V4.1-Flash', contextWindow: CONTEXT_WINDOW, maxTokens: CODEARTS_MAX_OUTPUT_TOKENS, supportsImages: CODEARTS_IMAGE_VERDICT['deepseek-v4.1-flash'] },
  { id: 'Qwen3-VL-235B', name: 'Qwen3-VL-235B', contextWindow: CONTEXT_WINDOW, maxTokens: CODEARTS_MAX_OUTPUT_TOKENS, supportsImages: CODEARTS_IMAGE_VERDICT['Qwen3-VL-235B'] },
  { id: 'openpangu-2.0-pro', name: 'OpenPangu 2.0 Pro', contextWindow: CONTEXT_WINDOW, maxTokens: 8192, supportsImages: CODEARTS_IMAGE_VERDICT['openpangu-2.0-pro'] },
  { id: 'openpangu-2.0-flash', name: 'OpenPangu 2.0 Flash', contextWindow: CONTEXT_WINDOW, maxTokens: 8192, supportsImages: CODEARTS_IMAGE_VERDICT['openpangu-2.0-flash'] },
  { id: 'kimi-k3', name: 'Kimi K3', contextWindow: CONTEXT_WINDOW, maxTokens: CODEARTS_MAX_OUTPUT_TOKENS, supportsImages: CODEARTS_IMAGE_VERDICT['kimi-k3'] },
  { id: 'kimi-k3.1-pro', name: 'Kimi K3.1 Pro', contextWindow: CONTEXT_WINDOW, maxTokens: CODEARTS_MAX_OUTPUT_TOKENS, supportsImages: CODEARTS_IMAGE_VERDICT['kimi-k3.1-pro'] },
  { id: 'kimi-k2.6-vl', name: 'Kimi K2.6 VL', contextWindow: CONTEXT_WINDOW, maxTokens: CODEARTS_MAX_OUTPUT_TOKENS, supportsImages: CODEARTS_IMAGE_VERDICT['kimi-k2.6-vl'] },
]
