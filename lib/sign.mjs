/**
 * 华为云请求签名（SDK-HMAC-SHA256）。
 *
 * 两个平台都要它，只是签的位置不同：
 *   - 码道 CodeArts：聊天、模型、积分三处接口，必须 x-auth-token + AK/SK 签名同时在
 *     场。官方 IDE 里只写 x-auth-token，是因为它走进程内通道；本插件是直连，只带
 *     token 会被 APIG 拒成 APIG.0301 decrypt token fail（实测）。
 *   - 果办 OfficeAce：模型网关用 Basic(appKey:appSecret)，而订阅/额度这类开放接口
 *     同样要 AK/SK 签名。
 *
 * canonical request 必须与华为云服务端逐字节一致，否则报
 * "Incorrect IAM authentication information"，且不会告诉你差在哪个字段。这里的排列
 * 规则（header 小写、按 key 升序、query 值也排序、path 每段 encodeURIComponent 且以
 * / 结尾）全部按实测复现，改动前请先用 probe 脚本核对。
 *
 * @module dsh-huawei-connect/sign
 */
import { createHash, createHmac } from 'node:crypto'

const ALGORITHM = 'SDK-HMAC-SHA256'

function sha256Hex(input) {
  return createHash('sha256').update(input).digest('hex')
}

function hmacHex(key, message) {
  return createHmac('sha256', key).update(message).digest('hex')
}

/** 华为云 X-Sdk-Date 格式：20060102T150405Z（UTC，无分隔符、无毫秒）。 */
export function sdkDate(date = new Date()) {
  const pad = (n) => String(n).padStart(2, '0')
  return (
    String(date.getUTCFullYear()) +
    pad(date.getUTCMonth() + 1) +
    pad(date.getUTCDate()) +
    'T' +
    pad(date.getUTCHours()) +
    pad(date.getUTCMinutes()) +
    pad(date.getUTCSeconds()) +
    'Z'
  )
}

/** 每一段单独 encode，且规整为以 / 结尾（华为云对空段也保留）。 */
function canonicalUri(pathname) {
  let out = pathname.split('/').map((segment) => encodeURIComponent(segment)).join('/')
  if (!out.endsWith('/')) out += '/'
  return out
}

/** query 按 key 排序，同 key 的多个值也排序。 */
function canonicalQuery(search) {
  if (search === '') return ''
  const params = new URLSearchParams(search)
  const keys = [...new Set(params.keys())].sort()
  const parts = []
  for (const key of keys) {
    for (const value of params.getAll(key).sort()) {
      parts.push(encodeURIComponent(key) + '=' + encodeURIComponent(value))
    }
  }
  return parts.join('&')
}

/**
 * 给一组请求头补上签名四件套：X-Sdk-Date、X-Sdk-Content-Sha256、
 * X-Security-Token（有才带）、Authorization。
 *
 * 返回**新的**头对象：调用方传给 fetch 的必须是这一份，因为 Authorization 里的
 * SignedHeaders 与实际发出的头必须完全对应，少一个都会被拒。
 */
export function signHuaweiRequest(options) {
  const { method, url, body = '', credentials, now } = options
  const parsed = new URL(url)
  const xSdkDate = sdkDate(now)
  const payloadHash = sha256Hex(body)

  const headers = {
    ...(options.headers ?? {}),
    'X-Sdk-Date': xSdkDate,
    'X-Sdk-Content-Sha256': payloadHash,
  }
  if (typeof credentials.securityToken === 'string' && credentials.securityToken !== '') {
    headers['X-Security-Token'] = credentials.securityToken
  }

  // Host 不在 headers 里（fetch 禁止手设），但签名必须包含它。
  const entries = Object.entries(headers).map(([key, value]) => [key.toLowerCase(), String(value).trim()])
  entries.push(['host', parsed.host])
  entries.sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0))

  let canonicalHeaders = ''
  const signedNames = []
  for (const [key, value] of entries) {
    canonicalHeaders += key + ':' + value + '\n'
    signedNames.push(key)
  }
  const signedHeaders = signedNames.join(';')

  const canonicalRequest = [
    String(method).toUpperCase(),
    canonicalUri(parsed.pathname),
    canonicalQuery(parsed.search.replace(/^\?/u, '')),
    canonicalHeaders,
    signedHeaders,
    payloadHash,
  ].join('\n')

  const stringToSign = [ALGORITHM, xSdkDate, sha256Hex(canonicalRequest)].join('\n')
  const signature = hmacHex(credentials.secretAccessKey, stringToSign)

  headers['Authorization'] =
    ALGORITHM + ' Access=' + credentials.accessKeyId + ', SignedHeaders=' + signedHeaders + ', Signature=' + signature
  return headers
}

/** 果办模型网关的认证形态：Basic base64(appKey:appSecret)。 */
export function huaweiBasicAuth(appKey, appSecret) {
  return 'Basic ' + Buffer.from(appKey + ':' + appSecret, 'utf8').toString('base64')
}
