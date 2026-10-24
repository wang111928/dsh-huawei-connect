/**
 * DPoP（RFC 9449）证明 JWT —— 华为云 IAM 换 token 的必需头。
 *
 * 华为的 STS（\`/v1/oauth2/tokens\`）要求每个换 token 请求带一个 DPoP proof：
 * ES256 签名的 JWT，header 里带**公钥**，payload 里绑定请求方法与地址。
 *
 * ## 为什么私钥必须与 refresh_token 一起保存
 *
 * refresh_token 在签发时就和当时的 DPoP **公钥**绑定。续期时服务端会核对
 * "这个 proof 的密钥是不是当初那个"——不是就报 \`InvalidDPoPHeader\`。
 * 所以私钥丢了，refresh_token 就等于废掉，只能重新走浏览器登录。
 *
 * ## 低 S 归一化
 *
 * ECDSA 签名值 (r, s) 里，s 与 (n - s) 等价，但部分服务端只接受 s <= n/2 的那一半，
 * 否则报签名非法。这里显式归一化，否则大约一半的请求会随机失败——这类 bug 极难排查，
 * 因为它取决于每次签名时的随机数。
 *
 * @module dsh-huawei-connect/dpop
 */
import { createPrivateKey, createSign, generateKeyPairSync, randomBytes } from 'node:crypto'

/** secp256r1 的阶。 */
const P256_ORDER = BigInt('0xFFFFFFFF00000000FFFFFFFFFFFFFFFFBCE6FAADA7179E84F3B9CAC2FC632551')
const P256_HALF = P256_ORDER >> 1n

/** 生成新的 DPoP 私钥（JWK 形态，便于直接落盘）。 */
export function newDpopKey() {
  const { privateKey } = generateKeyPairSync('ec', { namedCurve: 'P-256' })
  const jwk = privateKey.export({ format: 'jwk' })
  return { kty: jwk.kty, crv: jwk.crv, x: jwk.x, y: jwk.y, d: jwk.d }
}

/** 只含公钥的 JWK（写进 proof 的 header）。 */
function publicJwkOf(jwk) {
  return { kty: jwk.kty, crv: jwk.crv, x: jwk.x, y: jwk.y }
}

function base64url(buffer) {
  return Buffer.from(buffer).toString('base64url')
}

/**
 * 生成一个 DPoP proof JWT。
 *
 * \`htu\` 必须是**完整的 token 端点地址**（含 scheme 与 host），服务端会严格比对；
 * \`htm\` 是 HTTP 方法。\`jti\` 每次都要新，否则会被重放检测拒绝。
 */
export function signDpopProof(jwk, htu, htm = 'POST') {
  const key = createPrivateKey({ key: jwk, format: 'jwk' })

  const header = { alg: 'ES256', typ: 'dpop+jwt', jwk: publicJwkOf(jwk) }
  const payload = {
    htm,
    htu,
    iat: Math.floor(Date.now() / 1000),
    jti: randomBytes(16).toString('hex'),
  }

  const signingInput =
    base64url(Buffer.from(JSON.stringify(header))) + '.' + base64url(Buffer.from(JSON.stringify(payload)))

  // dsaEncoding: 'ieee-p1363' 给出固定 64 字节的 r||s，便于下面归一化 s。
  const signature = createSign('SHA256').update(signingInput).sign({ key, dsaEncoding: 'ieee-p1363' })

  let s = signature.subarray(32, 64)
  let sBig = BigInt('0x' + s.toString('hex'))
  if (sBig > P256_HALF) {
    sBig = P256_ORDER - sBig
    s = Buffer.from(sBig.toString(16).padStart(64, '0'), 'hex')
  }

  return signingInput + '.' + base64url(Buffer.concat([signature.subarray(0, 32), s]))
}
