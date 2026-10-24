/**
 * 果办（OfficeAce）上游客户端。
 *
 * 两个不同的地址面，别混：
 *
 *  1. **模型网关**（真正的推理）：OpenAI 兼容，认证是 Basic(appKey:appSecret)。
 *     base 由云端下发的 model_api_url_base 决定，实测
 *     https://modelgw-0009.officeace.cn-southwest-2.huaweicloud-agentarts.com/v2
 *     GET  {base}/models             -> OpenAI 形态的模型清单
 *     POST {base}/chat/completions   -> SSE（标准的 chat.completion.chunk）
 *
 *  2. **本机控制面**（积分/套餐）：OfficeAce 桌面端自己起的 https 服务。
 *     实测 :3004 与 :3003 都通，TLS 是自签的（要关校验才连得上），关键是那条
 *     cookie：**oc_sid=<DPAPI 解出来的 session value>**。cookie 名字写错（oc_session、
 *     oc_pt、auth 都试过）一律 401 AUTH_SESSION_INVALID，而正确的名字直接 200。
 *     GET /api/subscription/current    -> 套餐/总积分/已用/各积分组/活动期
 *     GET /api/codeagent-package/usage -> creditTotal/creditUsed/creditRemaining
 *
 * 两条链路都不按提示词内容拦截（与 workbuddy 的上游完全不同），实测裸请求、
 * DSH 官方 system 提示词、Claude Code 身份句全部 200。见 disguise.mjs 的证据表。
 *
 * @module dsh-huawei-connect/officeace
 */
import { huaweiBasicAuth } from './sign.mjs'
import { classifyUpstreamFailure, prepareOfficeAceBody, OFFICEACE_MAX_OUTPUT_TOKENS, CONTEXT_WINDOW } from './disguise.mjs'

/** 走本机控制面时要用的两个已知端口（按顺序试）。 */
export const OFFICEACE_LOCAL_PORTS = [3004, 3003]


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

function nonNegative(value) {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : undefined
}

/**
 * 从 providerState 里取出模型网关的地址与凭据。
 *
 * 云端下发的形状（实测）：
 *   modelInfo.model_api_url_base          "modelgw-0009.officeace.cn-southwest-2.huaweicloud-agentarts.com"
 *   modelInfo.model_auth_info.model_app_key / .model_app_secret
 *
 * base 只给主机名，没有 https:// 也没有 /v2 —— 两样都要补上。缺任何一项都返回
 * undefined，由调用方报"需要重新登录果办"。
 */
export function modelGatewayOf(providerState) {
  const modelInfo = asRecord(asRecord(providerState)['modelInfo'])
  const auth = asRecord(modelInfo['model_auth_info'])
  const rawBase = firstString(modelInfo['model_api_url_base'])
  const appKey = firstString(auth['model_app_key'])
  const appSecret = firstString(auth['model_app_secret'])
  if (rawBase === '' || appKey === '' || appSecret === '') return undefined

  let base = rawBase.replace(/\/+$/u, '')
  if (!/^https?:\/\//iu.test(base)) base = 'https://' + base
  if (!base.endsWith('/v2')) base += '/v2'
  return { base, appKey, appSecret, maasApiKey: firstString(auth['maas_api_key']) }
}

/** providerState 里的账号身份，用于把同一账号归一到同一条。 */
export function identityOfProviderState(providerState) {
  const state = asRecord(providerState)
  const userId = firstString(state['user_id'])
  const userName = firstString(state['user_name'])
  if (userId === '') return undefined
  return { userId, userName }
}

/** 果办模型（OpenAI 形态的 /models 返回）。 */

/**
 * 拉模型清单。
 *
 * 上游 /models 只给 id，没有上下文长度也没有能力标记，所以这里按 id 推断能力，
 * 并用一个保守的上下文窗口——DSH 要求每行都有正值，缺了会让整条路由不可用。
 */
export async function fetchOfficeAceModels(gateway, signal) {
  const response = await fetch(gateway.base + '/models', {
    method: 'GET',
    headers: { Authorization: huaweiBasicAuth(gateway.appKey, gateway.appSecret) },
    ...(signal === undefined ? {} : { signal }),
  })
  const text = await response.text()
  if (!response.ok) {
    const failure = classifyUpstreamFailure(response.status, text)
    throw new Error('果办模型清单失败 (' + failure.kind + '): ' + failure.message)
  }
  const body = asRecord(JSON.parse(text))
  const rows = asArray(body['data'])
  const models = []
  for (const row of rows) {
    const id = firstString(asRecord(row)['id'])
    if (id === '') continue
    models.push({
      id,
      name: id,
      contextWindow: CONTEXT_WINDOW,
      maxTokens: OFFICEACE_MAX_OUTPUT_TOKENS,
      supportsImages: /vl|vision|multimodal/iu.test(id),
    })
  }
  return models
}

/** 打开发往果办模型网关的聊天流。 */
export async function openOfficeAceChat(gateway, requestBody, signal) {
  const prepared = prepareOfficeAceBody(requestBody)
  const model = typeof prepared['model'] === 'string' ? prepared['model'] : ''
  const response = await fetch(gateway.base + '/chat/completions', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: huaweiBasicAuth(gateway.appKey, gateway.appSecret) },
    body: JSON.stringify(prepared),
    ...(signal === undefined ? {} : { signal }),
  })
  if (!response.ok || response.body === null) {
    const text = await response.text().catch(() => '')
    return { ok: false, failure: classifyUpstreamFailure(response.status, text) }
  }
  return { ok: true, stream: response.body, model }
}

/**
 * 果办自己的模型网关已经是标准 OpenAI SSE，**原样透传**即可 —— 不做翻译，避免
 * 引入本插件自己的失真。上游偶发把业务错误塞进 data 帧，这种情况留给 DSH 的
 * pi-ai 层按 OpenAI 语义处理。
 */
export async function* passthroughSse(stream) {
  const reader = stream.getReader()
  const decoder = new TextDecoder()
  try {
    for (;;) {
      const { done, value } = await reader.read()
      if (done) break
      yield decoder.decode(value, { stream: true })
    }
  } finally {
    reader.releaseLock()
  }
}

/**
 * 用 oc_sid cookie 读一次本机控制面接口。
 *
 * 两个坑都在这里处理掉了：
 *  - TLS 是自签的。Node 的 fetch 不提供 per-request 的"忽略证书"开关，所以用
 *    undici 的 Agent（Node 22+ 内置 undici，但作为模块不一定可 import）……
 *    这里改用 NODE_TLS_REJECT_UNAUTHORIZED 的**局部**等价物：把请求交给一个
 *    只用于本机回环的 fetch 实现。见 resolveLocalFetcher()。
 *  - 端口不固定：3004/3003 都可能，任一返回非 401 就用它。
 */

let localFetcherCache

/**
 * 拿到一个"能连本机自签 https"的 fetch。
 *
 * 优先 undici 的 Agent（能只对这一个请求放行证书），拿不到就退回全局开关 ——
 * 后者会影响进程内所有请求，所以只在本机回环地址上、且仅在 undici 不可用时使用，
 * 用完立刻恢复。
 */
async function resolveLocalFetcher() {
  if (localFetcherCache !== undefined) return localFetcherCache
  try {
    const undici = await import('undici')
    const agent = new undici.Agent({ connect: { rejectUnauthorized: false } })
    localFetcherCache = (url, init) => undici.fetch(url, { ...init, dispatcher: agent })
    return localFetcherCache
  } catch {
    localFetcherCache = undefined
    return undefined
  }
}

/** 调一次本机控制面接口，返回解析后的 JSON；全部端口都失败时抛错。 */
export async function fetchLocalControl(sessionValue, path, signal) {
  const cookie = 'oc_sid=' + sessionValue
  const localFetch = await resolveLocalFetcher()
  let lastError
  for (const port of OFFICEACE_LOCAL_PORTS) {
    const url = 'https://127.0.0.1:' + port + path
    try {
      let response
      if (localFetch !== undefined) {
        response = await localFetch(url, {
          headers: { Cookie: cookie, Accept: 'application/json' },
          ...(signal === undefined ? {} : { signal }),
        })
      } else {
        const previous = process.env['NODE_TLS_REJECT_UNAUTHORIZED']
        process.env['NODE_TLS_REJECT_UNAUTHORIZED'] = '0'
        try {
          response = await fetch(url, {
            headers: { Cookie: cookie, Accept: 'application/json' },
            ...(signal === undefined ? {} : { signal }),
          })
        } finally {
          if (previous === undefined) delete process.env['NODE_TLS_REJECT_UNAUTHORIZED']
          else process.env['NODE_TLS_REJECT_UNAUTHORIZED'] = previous
        }
      }
      if (response.status === 401) {
        lastError = new Error('果办本机接口拒绝了这个会话（AUTH_SESSION_INVALID）：请先打开果办并保持登录')
        continue
      }
      if (!response.ok) {
        lastError = new Error('果办本机接口 ' + path + ' 返回 ' + response.status)
        continue
      }
      return await response.json()
    } catch (error) {
      lastError = error instanceof Error ? error : new Error(String(error))
    }
  }
  throw lastError ?? new Error('果办本机接口不可达')
}

/**
 * 解析 /api/subscription/current。
 *
 * 返回 undefined 表示这份文档里没有可用的额度口径（上游改形状 / 账号没订阅），
 * 调用方据此报"积分不可用"，而不是显示一排 0 假装是真的。
 */
export function parseOfficeAceSubscription(raw) {
  const body = asRecord(raw)
  const total = nonNegative(body['totalCredits'])
  const used = nonNegative(body['usedCredits'])
  if (total === undefined && used === undefined) return undefined

  const groups = []
  for (const row of asArray(body['creditGroups'])) {
    const group = asRecord(row)
    const remaining = nonNegative(group['remaining'])
    const groupTotal = nonNegative(group['total'])
    if (remaining === undefined && groupTotal === undefined) continue
    groups.push({
      key: firstString(group['key']),
      name: firstString(group['name']),
      kind: firstString(group['kind']),
      remaining: remaining ?? 0,
      total: groupTotal ?? 0,
      used: nonNegative(group['used']) ?? 0,
      expiresAt: firstString(group['expiresAt']) || undefined,
    })
  }

  return {
    planName: firstString(body['planName']) || undefined,
    tier: firstString(body['tier']) || undefined,
    status: firstString(body['status']) || undefined,
    expiresAt: firstString(body['expiresAt']) || undefined,
    total: total ?? 0,
    used: used ?? 0,
    remain: Math.max(0, (total ?? 0) - (used ?? 0)),
    groups,
    fetchedAt: Date.now(),
  }
}

/** 解析 /api/codeagent-package/usage（与码道积分同口径的剩余量）。 */
export function parseOfficeAcePackageUsage(raw) {
  const body = asRecord(raw)
  if (body['available'] !== true) return undefined
  const usage = asRecord(body['usage'])
  const total = nonNegative(usage['creditTotal'])
  const used = nonNegative(usage['creditUsed'])
  const remaining = nonNegative(usage['creditRemaining'])
  if (total === undefined && remaining === undefined) return undefined
  return {
    packageName: firstString(usage['packageNameCn'], usage['packageNameEn']) || undefined,
    total: total ?? 0,
    used: used ?? 0,
    remain: remaining ?? Math.max(0, (total ?? 0) - (used ?? 0)),
    fetchedAt: Date.now(),
  }
}

/** 上游不可达时的种子清单。 */
export const OFFICEACE_SEED_MODELS = [
  { id: 'deepseek-v4.1-flash', name: 'DeepSeek-V4.1-Flash', contextWindow: CONTEXT_WINDOW, maxTokens: OFFICEACE_MAX_OUTPUT_TOKENS, supportsImages: true },
  { id: 'deepseek-v4-pro', name: 'DeepSeek-V4-Pro', contextWindow: CONTEXT_WINDOW, maxTokens: OFFICEACE_MAX_OUTPUT_TOKENS, supportsImages: true },
  { id: 'glm-5.2', name: 'GLM-5.2', contextWindow: CONTEXT_WINDOW, maxTokens: OFFICEACE_MAX_OUTPUT_TOKENS, supportsImages: true },
  { id: 'glm-5.3', name: 'GLM-5.3', contextWindow: CONTEXT_WINDOW, maxTokens: OFFICEACE_MAX_OUTPUT_TOKENS, supportsImages: true },
  { id: 'kimi-k3', name: 'Kimi K3', contextWindow: CONTEXT_WINDOW, maxTokens: OFFICEACE_MAX_OUTPUT_TOKENS, supportsImages: false },
  { id: 'openpangu-2.0-pro', name: 'OpenPangu 2.0 Pro', contextWindow: CONTEXT_WINDOW, maxTokens: OFFICEACE_MAX_OUTPUT_TOKENS, supportsImages: true },
  { id: 'qwen3-32b', name: 'Qwen3-32B', contextWindow: CONTEXT_WINDOW, maxTokens: OFFICEACE_MAX_OUTPUT_TOKENS, supportsImages: false },
]
