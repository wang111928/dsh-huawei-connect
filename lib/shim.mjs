/**
 * 回环 shim：把两个华为平台包成 DSH 认得的 OpenAI 兼容端点。
 *
 * ## 为什么要有它
 *
 * DSH 的 pi-ai 适配器只会说 OpenAI。两个华为平台的认证却都不是"一个 Bearer 头"：
 * 码道要 x-auth-token + AK/SK HMAC 签名 + Agent-Type，果办要 Basic(appKey:appSecret)。
 * 把签名逻辑塞进 pi-ai 的请求路径是行不通的（它只给一个 apiKey），所以这里起一个
 * 只监听 127.0.0.1 的小 HTTP 服务：pi-ai 对它说标准 OpenAI，它替上游说话。
 *
 * ## 加固（照抄 dsh-codearts / dsh-codebuddy-cli 已验证的做法）
 *
 * - 只绑 127.0.0.1，端口随机
 * - 每次进程启动生成随机 secret，pi-ai 用它当 Bearer；常量时间比对
 * - Host 头必须是回环（挡 DNS rebinding）
 * - Origin 必须是回环或缺失（浏览器来的跨站请求挡掉；本机的 pi-ai 不发 Origin）
 * - 不把上游真凭证交给 pi-ai，shim 自己去 store 里解析
 *
 * ## 路由
 *
 *   GET  /<platform>/v1/models            模型清单
 *   POST /<platform>/v1/chat/completions  聊天（流式）
 *
 * 每个平台一条路由，彼此不可互换：它们签的接口、用的凭证、算的额度都不同。
 *
 * @module dsh-huawei-connect/shim
 */
import { createServer } from 'node:http'
import { randomBytes, timingSafeEqual } from 'node:crypto'
import { openCodeArtsChat, translateCodeArtsStream } from './codearts.mjs'
import { openOfficeAceChat, passthroughSse } from './officeace.mjs'
import { describeFailure, warrantsAccountRotation, warrantsRetry } from './disguise.mjs'
import { SessionGate } from './gate.mjs'

const LOOPBACK_HOSTS = new Set(['127.0.0.1', 'localhost', '[::1]'])
const BODY_LIMIT = 64 * 1024 * 1024

/**
 * 撞上并发上限时的重试间隔。
 *
 * 正常情况下本地闸门（gate.mjs）已经把并发压在限额以内，请求根本不会撞墙；这里
 * 留一个兜底循环，是为了处理"闸门的估计与实际不一致"（比如另一个客户端同时在用
 * 同一个账号）。这种情况下等到上游真正释放是唯一出路，所以间隔取实测的释放量级。
 */
const CONCURRENCY_WAIT_MS = 90_000
const CONCURRENCY_GAP_MS = 5_000

function hostnameOfHost(host) {
  let hostname = String(host).trim().toLowerCase()
  if (hostname.startsWith('[')) {
    const end = hostname.indexOf(']')
    return end === -1 ? hostname : hostname.slice(0, end + 1)
  }
  const colon = hostname.lastIndexOf(':')
  if (colon !== -1 && /^\d+$/u.test(hostname.slice(colon + 1))) hostname = hostname.slice(0, colon)
  return hostname
}

function hostIsLoopback(host) {
  return typeof host === 'string' && host.trim() !== '' && LOOPBACK_HOSTS.has(hostnameOfHost(host))
}

function originIsLoopback(origin) {
  if (origin === undefined || origin === '') return true
  try {
    const hostname = new URL(origin).hostname
    return LOOPBACK_HOSTS.has(hostname) || hostname === '::1'
  } catch {
    return false
  }
}

function writeJson(response, status, body) {
  const payload = JSON.stringify(body)
  response.writeHead(status, { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(payload) })
  response.end(payload)
}

function writeOpenAiError(response, status, kind, message) {
  writeJson(response, status, { error: { message, type: kind, code: kind } })
}

function readBody(request) {
  return new Promise((resolve, reject) => {
    const chunks = []
    let size = 0
    request.on('data', (chunk) => {
      size += chunk.length
      if (size > BODY_LIMIT) {
        reject(new Error('request body too large'))
        request.destroy()
        return
      }
      chunks.push(chunk)
    })
    request.on('end', () => resolve(Buffer.concat(chunks)))
    request.on('error', reject)
  })
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

/**
 * 把消息里的图片换成文字占位，供**不支持多模态**的模型使用。
 *
 * 实测（2026-10-23）两个平台的反应都是**硬拒绝**，不是"忽略图片"：
 *   码道   `InferHub.001001020.406 The request model is not multimodal`
 *   果办   `ModelArts.81001 ... has unsupported content type: 'image_url'`
 *
 * 也就是说：只要历史里有一张图、而用户切到了一个纯文本模型，这个会话就再也发不出去
 * ——换轮次、换账号都不解决，因为图一直在历史里。这与"提示词被拒"是同一类问题：
 * **拒的是请求，不是账号**。
 *
 * 这里在发送前把图片换成一段说明文字（而不是静默丢弃），模型仍能理解"这里曾有一张图"，
 * 用户也能从回答里看出插件做了什么。图片本身仍留在 DSH 的会话记录里，切回多模态模型
 * 后照常发送。
 */
function stripImagesForTextModel(body) {
  const messages = Array.isArray(body['messages']) ? body['messages'] : undefined
  if (messages === undefined) return body
  let stripped = 0
  for (const message of messages) {
    if (typeof message !== 'object' || message === null) continue
    const content = message['content']
    if (!Array.isArray(content)) continue
    const kept = []
    for (const part of content) {
      if (typeof part !== 'object' || part === null) {
        kept.push(part)
        continue
      }
      if (part['type'] === 'image_url' || part['type'] === 'image') {
        stripped += 1
        kept.push({ type: 'text', text: '[image omitted: this model does not accept images]' })
        continue
      }
      kept.push(part)
    }
    message['content'] = kept
  }
  return stripped === 0 ? body : { ...body, messages }
}

const IMAGE_UNSUPPORTED = {
  codearts: /not multimodal|001001020/iu,
  officeace: /unsupported content type|81001/iu,
}

/**
 * 起一个 shim。
 *
 * options:
 *   accounts(platform) -> account[]   当前可用账号（按偏好排序，调用方决定顺序）
 *   logger                            DSH 的 logger，可缺省
 *   onUsage(platform, model, usage)   用量回调（本机账本）
 */
export function createShim(options) {
  const { accounts, logger } = options
  const onUsage = options.onUsage ?? (() => {})
  /**
   * 某个模型是否吃图片。由调用方（index.mjs）从模型目录里查，因为只有它知道当前
   * 目录；缺省按"不吃"处理——把图片发给纯文本模型是**硬拒绝**，宁可先剥离。
   */
  const supportsImages = options.supportsImages ?? (() => false)
  const onAccountFailure = options.onAccountFailure ?? (() => {})
  const onAccountSuccess = options.onAccountSuccess ?? (() => {})
  /**
   * 按需续期。返回**新鲜凭证**；返回 undefined 表示"没变化，用原来的"。
   *
   * 放在这里而不是 accounts() 里，是因为续期要 await，而 accounts() 是同步接口。
   * 续期失败不阻断请求：池里已经保证了"续期失败但旧 token 还没过期就继续用"。
   */
  const refreshAccount = options.refreshAccount ?? (async () => undefined)
  /**
   * 只有码道有会话配额（每账号 3 个，占用约 60 秒）。果办没有这个限制，闸门对它
   * 不生效——给它加限制只会平白拖慢。
   */
  const gate = new SessionGate()
  const gated = (platform) => platform === 'codearts'
  const secret = randomBytes(32).toString('base64url')
  const secretBuffer = Buffer.from(secret)

  function bearerOk(request) {
    const header = request.headers.authorization
    if (typeof header !== 'string') return false
    const match = /^Bearer\s+(.+)$/iu.exec(header.trim())
    if (match === null) return false
    const presented = Buffer.from(match[1])
    if (presented.length !== secretBuffer.length) return false
    return timingSafeEqual(presented, secretBuffer)
  }

  const server = createServer((request, response) => {
    handle(request, response).catch((error) => {
      if (!response.headersSent) writeOpenAiError(response, 500, 'internal', String(error))
      else response.end()
    })
  })

  const ready = new Promise((resolve, reject) => {
    server.once('listening', () => resolve())
    server.once('error', reject)
  })
  server.listen(0, '127.0.0.1')

  function baseUrl() {
    const address = server.address()
    if (address === null || typeof address === 'string') throw new Error('shim has no listening address')
    return 'http://127.0.0.1:' + address.port
  }

  async function handle(request, response) {
    if (!hostIsLoopback(request.headers.host)) {
      writeOpenAiError(response, 403, 'host_not_allowed', 'Host header must name the loopback interface')
      return
    }
    if (!originIsLoopback(request.headers.origin)) {
      writeOpenAiError(response, 403, 'origin_not_allowed', 'Origin must be a loopback origin')
      return
    }
    if (!bearerOk(request)) {
      writeOpenAiError(response, 401, 'unauthorized', 'missing or invalid Authorization bearer')
      return
    }

    const url = request.url ?? '/'
    const match = /^\/(codearts|officeace)\/v1(\/.*)$/u.exec(url)
    if (match === null) {
      writeOpenAiError(response, 404, 'not_found', 'no such route: ' + request.method + ' ' + url)
      return
    }
    const platform = match[1]
    const path = match[2]
    if (path === '/models' && request.method === 'GET') {
      const list = accounts(platform)
      writeJson(response, 200, {
        object: 'list',
        data: list.map((account) => ({ id: account.modelId, object: 'model', created: 0, owned_by: platform })),
      })
      return
    }
    if (path === '/chat/completions' && request.method === 'POST') {
      await chat(platform, request, response)
      return
    }
    writeOpenAiError(response, 404, 'not_found', 'no such route: ' + request.method + ' ' + url)
  }

  async function chat(platform, request, response) {
    const raw = await readBody(request)
    let body
    try {
      body = JSON.parse(raw.toString('utf8'))
    } catch {
      writeOpenAiError(response, 400, 'invalid_json', 'request body is not JSON')
      return
    }
    const model = typeof body['model'] === 'string' ? body['model'] : ''
    // 纯文本模型收到图片会被硬拒绝（见 stripImagesForTextModel 的实测记录），
    // 所以在**发出之前**就把图换成占位。判定用上游目录里的 supports_images。
    if (!supportsImages(platform, model)) body = stripImagesForTextModel(body)
    const candidates = accounts(platform)
    if (candidates.length === 0) {
      writeOpenAiError(response, 503, 'unconfigured', platform + ' 还没有可用的账号，请先在设置卡片里同步。')
      return
    }

    const controller = new AbortController()
    // 用户在 UI 上点停止：把上游连接也断开，否则码道那边会占满一个并发槽近 1 分钟。
    request.on('close', () => controller.abort())

    let lastFailure
    const tried = []
    const deadline = Date.now() + CONCURRENCY_WAIT_MS
    const useGate = gated(platform)

    for (const account of candidates) {
      if (tried.length >= 3) break
      tried.push(account.id)

      // 码道：先在本地闸门排队，把"并发拒绝"变成"排队等待"。
      // 闸门只决定"什么时候发"，不改变发给谁；选号优先级仍由 candidates 的顺序决定。
      if (useGate) {
        const slot = await gate.acquire([account.id], controller.signal)
        if (slot.accountId === undefined) {
          // 被中止（用户点了停止），直接收尾，不必再试别的账号。
          if (controller.signal.aborted) return
          continue
        }
      }

      for (;;) {
        let opened
        try {
          // 发请求前先确保凭证新鲜（续期失败时池会退回旧凭证，不会让这次请求白掉）。
          let credential = account.credential
          let gateway = account.gateway
          try {
            const fresh = await refreshAccount(platform, account.id)
            if (fresh !== undefined) {
              if (platform === 'codearts') credential = fresh
              else gateway = fresh
            }
          } catch (error) {
            logger?.debug?.('[huawei-connect] refresh failed for ' + account.id + ': ' + String(error).slice(0, 120))
          }

          opened =
            platform === 'codearts'
              ? await openCodeArtsChat(credential, body, controller.signal)
              : await openOfficeAceChat(gateway, body, controller.signal)
        } catch (error) {
          lastFailure = { kind: 'server', status: 502, message: String(error) }
          break
        }
        if (opened.ok) {
          onAccountSuccess(platform, account.id)
          await pipeStream(platform, model, opened.stream, response, controller.signal)
          return
        }
        lastFailure = opened.failure
        onAccountFailure(platform, account.id, opened.failure.kind, opened.failure.message, model)
        logger?.debug?.(
          '[huawei-connect] ' + platform + ' ' + opened.failure.kind + ': ' + opened.failure.message.slice(0, 200),
        )

        // 撞上并发上限：闸门的估计不准（比如另一个客户端也在用同一账号）。
        // 这种情况下等到上游真正释放是唯一出路——原地等，不要换号（换了也一样）。
        if (opened.failure.kind === 'concurrency' && Date.now() < deadline) {
          await sleep(CONCURRENCY_GAP_MS)
          continue
        }
        // 其它可重试的失败：先在同账号退避一次，再考虑换号。
        if (warrantsRetry(opened.failure.kind) && Date.now() < deadline && tried.length === 1) {
          await sleep(CONCURRENCY_GAP_MS)
          continue
        }
        break
      }
      if (!warrantsAccountRotation(lastFailure?.kind)) break
    }

    const failure = lastFailure ?? { kind: 'server', status: 502, message: 'no attempt was made' }
    const status =
      failure.kind === 'authentication'
        ? 401
        : failure.kind === 'hard_credit'
          ? 402
          : failure.kind === 'client'
            ? 400
            : 502
    writeOpenAiError(response, status, failure.kind, describeFailure(failure, model))
  }

  async function pipeStream(platform, model, stream, response, signal) {
    response.writeHead(200, {
      'Content-Type': 'text/event-stream; charset=utf-8',
      'Cache-Control': 'no-cache',
      Connection: 'keep-alive',
    })
    try {
      const source = platform === 'codearts' ? translateCodeArtsStream(stream) : passthroughSse(stream)
      for await (const chunk of source) {
        if (signal.aborted) break
        response.write(chunk)
      }
    } catch (error) {
      logger?.warn?.('[huawei-connect] stream failed: ' + String(error))
    } finally {
      response.end()
      onUsage(platform, model)
    }
  }

  return {
    ready,
    baseUrl,
    token: () => secret,
    /** 码道的会话槽位占用（卡片上"会话槽位"那一行）。 */
    sessions: (accountIds) => gate.snapshot(accountIds),
    close: async () => {
      await new Promise((resolve) => server.close(() => resolve()))
    },
  }
}
