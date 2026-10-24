/**
 * 华为云 OAuth2 登录与续期 —— 两个平台共用一套引擎。
 *
 * ## 为什么能共用
 *
 * 码道（\`codearts-agent\`）与果办（\`pdp5_for_agentarts\`）用的是**同一个 IAM**：
 * 同一个授权页（\`auth.huaweicloud.com/authui/v1/oauth2/authorize\`）、同一个换 token
 * 端点（\`sts.cn-north-4.myhuaweicloud.com/v1/oauth2/tokens\`）、同一套 PKCE + DPoP。
 *
 * 实测确认（2026-10-23）：两个 client_id 都接受 \`http://127.0.0.1:<port>/...\` 形式的
 * 本机回调（都返回 302 跳登录页），所以同一段"起本地回调服务"的代码对两者都成立。
 * 差异只在 client_id 与 redirect_uri 的路径，因此做成参数。
 *
 * ## 流程
 *
 *   1. 本机 127.0.0.1 随机端口起回调服务
 *   2. 生成 PKCE（verifier + S256 challenge）与 DPoP 密钥对
 *   3. 浏览器打开授权页；用户登录后华为回调 \`?code=...\`
 *   4. 用 code + verifier + DPoP proof 换 security_token + 临时 AK/SK + refresh_token
 *   5. 私钥随凭证一起保存（续期要用同一个公钥，见 dpop.mjs）
 *
 * ## 续期
 *
 * refresh_token 是一次性的：每续一次上游就换一个新的。所以续期必须**串行**并且
 * 立刻落盘，否则下一次拿旧 token 去换会被拒。这里用单飞（同一个账号同时只有一个
 * 续期在跑）保证这一点。
 *
 * @module dsh-huawei-connect/oauth
 */
import { createHash, randomBytes } from 'node:crypto'
import { createServer } from 'node:http'
import { newDpopKey, signDpopProof } from './dpop.mjs'

/** 两个平台的登录参数。 */
export const PLATFORMS = {
  codearts: {
    clientId: 'codearts-agent',
    // 官方桌面端自称的身份；换 token 时一起带上。
    pluginName: 'snap_AIIDE',
    pluginVersion: '5.2.0',
    redirectPath: '/oauth/callback',
    authorizeBase: 'https://codearts.huaweicloud.com/portal/authorize',
    /** 码道的授权页用 query 参数直接拼。 */
    authorizeStyle: 'codearts',
  },
  officeace: {
    clientId: 'pdp5_for_agentarts',
    pluginName: 'officeace',
    pluginVersion: '1.0.0',
    redirectPath: '/oauth/callback',
    authorizeBase: 'https://auth.huaweicloud.com/authui/login.html',
    authorizeStyle: 'officeace',
  },
}

/** 两个平台共用的 IAM 端点。 */
export const STS_TOKEN_URL = 'https://sts.cn-north-4.myhuaweicloud.com/v1/oauth2/tokens'
export const AUTH_BASE = 'https://auth.huaweicloud.com'

function base64url(buffer) {
  return Buffer.from(buffer).toString('base64url')
}

/** PKCE S256。 */
function pkce() {
  const verifier = base64url(randomBytes(64))
  return {
    verifier,
    // 华为要求 method 明确写成 SHA-256（不是 S256），否则报 IAM.0007。
    challenge: createHash('sha256').update(verifier).digest('base64url'),
    method: 'SHA-256',
  }
}

/**
 * 拼授权页地址。
 *
 * 码道的官方客户端把参数直接挂在自己的 portal 上；果办则套一层
 * \`authui/login.html?service=<真正的授权 URL>\`。两种都实测可用，所以分开处理。
 */
function buildAuthorizeUrl(platform, config, ticketId, challenge, redirectUri) {
  const inner = new URLSearchParams({
    client_id: config.clientId,
    response_type: 'code',
    redirect_uri: redirectUri,
    scope: 'openid',
    state: ticketId,
    code_challenge: challenge,
    code_challenge_method: 'SHA-256',
  })

  if (config.authorizeStyle === 'codearts') {
    // 码道：参数挂在 portal/authorize 上，并带上官方客户端的身份标记。
    inner.set('theme', '2')
    inner.set('locale', 'zh-cn')
    inner.set('uri_scheme', config.clientId)
    inner.set('port', String(new URL(redirectUri).port))
    inner.set('ticket_id', ticketId)
    inner.set('plugin-name', config.pluginName)
    inner.set('plugin-version', config.pluginVersion)
    return config.authorizeBase + '?' + inner.toString()
  }

  // 果办：真正的授权地址作为 service 参数塞进登录页。
  const oauthUrl = AUTH_BASE + '/authui/v1/oauth2/authorize?' + inner.toString()
  const login = new URLSearchParams({ service: oauthUrl })
  return config.authorizeBase + '?' + login.toString()
}

/**
 * 对外暴露"给我一个授权地址"（宿主在登录流程之外也可能需要预构造，比如先显示链接）。
 *
 * 与 startLogin 内部用的是同一个 buildAuthorizeUrl，参数一致，不会漂。
 */
export function buildAuthorizeUrlForTest(platform, port) {
  const config = PLATFORMS[platform]
  if (config === undefined) throw new Error('unknown platform: ' + platform)
  const { challenge } = pkce()
  const ticketId = randomBytes(16).toString('hex')
  const redirectUri = 'http://127.0.0.1:' + port + config.redirectPath
  return buildAuthorizeUrl(platform, config, ticketId, challenge, redirectUri)
}

/** 换 token / 续期共用的请求。 */
async function requestToken(config, body, dpopKey) {
  const proof = signDpopProof(dpopKey, STS_TOKEN_URL)
  const response = await fetch(STS_TOKEN_URL, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/x-www-form-urlencoded',
      DPoP: proof,
      'plugin-name': config.pluginName,
      'plugin-version': config.pluginVersion,
    },
    body: new URLSearchParams(body).toString(),
    signal: AbortSignal.timeout(30_000),
  })
  const text = await response.text()
  if (!response.ok) {
    throw new Error('换 token 失败 (' + response.status + '): ' + text.slice(0, 300))
  }
  let parsed
  try {
    parsed = JSON.parse(text)
  } catch {
    throw new Error('换 token 响应不是 JSON: ' + text.slice(0, 200))
  }
  return parsed
}

/** 把上游响应归一成插件自己的凭证形状。 */
function normalizeToken(json, dpopKey, clientId, previous) {
  const credentials = json['credentials'] ?? {}
  return {
    securityToken: credentials['security_token'] ?? credentials['SecurityToken'] ?? '',
    accessKeyId: credentials['access_key_id'] ?? credentials['AccessKeyID'] ?? '',
    secretAccessKey: credentials['secret_access_key'] ?? credentials['SecretAccessKey'] ?? '',
    expiration: credentials['expiration'] ?? credentials['Expiration'] ?? '',
    refreshToken: json['refresh_token'] ?? json['RefreshToken'] ?? previous?.refreshToken ?? '',
    userId: json['user_id'] ?? previous?.userId ?? '',
    userName: json['user_name'] ?? previous?.userName ?? '',
    domainId: json['domain_id'] ?? previous?.domainId ?? '',
    clientId,
    dpopKey,
    obtainedAt: Date.now(),
  }
}

/**
 * 起一次浏览器登录。
 *
 * 返回 \`{ authorizeUrl, promise, close }\`：
 *   - \`authorizeUrl\` 交给用户去打开（由宿主决定是弹浏览器还是显示链接）
 *   - \`promise\` 在用户完成授权后 resolve 成凭证
 *   - \`close\` 提前放弃（比如用户关掉了卡片）
 *
 * 回调服务只监听 127.0.0.1 的随机端口，且只接受预设路径，其它请求一律 404。
 */
export function startLogin(platform, options = {}) {
  const config = PLATFORMS[platform]
  if (config === undefined) throw new Error('unknown platform: ' + platform)

  const timeoutMs = options.timeoutMs ?? 5 * 60 * 1000
  const ticketId = randomBytes(16).toString('hex')
  const { verifier, challenge } = pkce()
  const dpopKey = newDpopKey()

  const server = createServer()
  let settled = false
  let settle

  const codePromise = new Promise((resolve) => {
    settle = resolve
  })

  server.on('request', (request, response) => {
    const url = new URL(request.url ?? '/', 'http://127.0.0.1')
    if (url.pathname !== config.redirectPath) {
      response.writeHead(404).end()
      return
    }
    const code = url.searchParams.get('code')
    if (code === null || code === '') {
      response.writeHead(400, { 'Content-Type': 'text/html; charset=utf-8' })
      response.end('<h3>授权未返回 code，请重试。</h3>')
      return
    }
    response.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' })
    response.end('<h3>授权成功，可以关闭此页面回到 DSH。</h3>')
    if (!settled) {
      settled = true
      settle(code)
    }
  })

  const listening = new Promise((resolve, reject) => {
    server.once('error', reject)
    server.listen(0, '127.0.0.1', () => resolve(server.address().port))
  })

  const promise = (async () => {
    const port = await listening
    const redirectUri = 'http://127.0.0.1:' + port + config.redirectPath
    const authorizeUrl = buildAuthorizeUrl(platform, config, ticketId, challenge, redirectUri)

    const timer = setTimeout(() => {
      if (!settled) {
        settled = true
        settle(undefined)
      }
    }, timeoutMs)
    timer.unref?.()

    try {
      const code = await codePromise
      if (code === undefined) throw new Error('登录超时或已取消')
      const json = await requestToken(
        config,
        {
          client_id: config.clientId,
          code,
          code_verifier: verifier,
          grant_type: 'authorization_code',
          redirect_uri: redirectUri,
        },
        dpopKey,
      )
      return normalizeToken(json, dpopKey, config.clientId)
    } finally {
      clearTimeout(timer)
      server.close()
    }
  })()

  return {
    promise,
    /** 授权地址（等端口就绪后可用）。 */
    authorizeUrl: listening.then((port) => buildAuthorizeUrl(platform, config, ticketId, challenge, 'http://127.0.0.1:' + port + config.redirectPath)),
    close: () => {
      if (!settled) {
        settled = true
        settle(undefined)
      }
      server.close()
    },
    /** 端口要给前端显示（有些环境需要用户手动打开回调地址）。 */
    ready: listening.then((port) => ({
      port,
      authorizeUrl: undefined,
    })),
  }
}

/**
 * 用 refresh_token 续期。
 *
 * 注意这是**破坏性**操作：成功之后旧的 refresh_token 立即失效，所以调用方必须
 * 把返回值立刻落盘，并且保证同一账号同一时刻只有一个续期在跑（见 pool.mjs 的单飞）。
 */
export async function refreshCredential(platform, credential, options = {}) {
  const config = PLATFORMS[platform]
  if (config === undefined) throw new Error('unknown platform: ' + platform)
  if (credential.refreshToken === undefined || credential.refreshToken === '') {
    throw new Error('没有 refresh_token，无法续期（需要重新登录）')
  }
  if (credential.dpopKey === undefined) {
    throw new Error('缺少 DPoP 私钥，无法续期（refresh_token 与它绑定）')
  }
  const json = await requestToken(
    config,
    { client_id: config.clientId, grant_type: 'refresh_token', refresh_token: credential.refreshToken },
    credential.dpopKey,
  )
  return normalizeToken(json, credential.dpopKey, config.clientId, credential)
}

/** 凭证还剩多少毫秒过期；解析不出来返回 undefined。 */
export function remainingMs(credential) {
  if (typeof credential?.expiration !== 'string' || credential.expiration === '') return undefined
  const at = Date.parse(credential.expiration)
  if (!Number.isFinite(at)) return undefined
  return at - Date.now()
}

/** 要不要在请求前先续期（留 5 分钟余量）。 */
export function needsRefresh(credential, marginMs = 5 * 60 * 1000) {
  const remaining = remainingMs(credential)
  if (remaining === undefined) return false
  return remaining < marginMs
}
