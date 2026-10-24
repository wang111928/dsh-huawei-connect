/**
 * 果办本机控制面的会话 cookie。
 *
 * OfficeAce 把登录会话写进 $HOME/.office-claw/session.cookie，格式是两行：
 *
 *   OC-DPAPI-1
 *   <base64 的 DPAPI 密文>
 *
 * 第一行是编码标记，第二行是 Windows DPAPI（CurrentUser 作用域）加密后的 JSON：
 *
 *   {"value":"<domainId>%3A<userId>.<sessionId>.<sig>","expires":<unix 秒>}
 *
 * 关键细节：请求本机 API 时 cookie 的名字是 **oc_sid**，值就是上面整个 value。名字写错
 * （oc_session / oc_pt / auth 都试过）一律 401 AUTH_SESSION_INVALID；正确的名字直接
 * 200。这是实测出来的，不是猜的。
 *
 * DPAPI 解密只能通过 Windows 的 CryptUnprotectData。这里用 PowerShell 调
 * System.Security.Cryptography.ProtectedData（同样 -EncodedCommand，避免引号问题），
 * 结果按 expires 缓存在内存里——卡片轮询不该每次都起一个进程。
 *
 * @module dsh-huawei-connect/session
 */
import { execFile } from 'node:child_process'
import { readFile } from 'node:fs/promises'
import { promisify } from 'node:util'
import { officeAceSessionCookiePath } from './paths.mjs'

const execFileAsync = promisify(execFile)

const DPAPI_MARKER = 'OC-DPAPI-1'

const DECRYPT_SCRIPT = `
$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName System.Security
$path = $env:DSH_HUAWEI_COOKIE_FILE
if ([string]::IsNullOrEmpty($path) -or -not (Test-Path -LiteralPath $path)) { 'MISSING'; exit }
$lines = @(Get-Content -LiteralPath $path) 
$payload = ''
foreach ($line in $lines) {
  $trimmed = $line.Trim()
  if ($trimmed -eq '' -or $trimmed -eq 'OC-DPAPI-1') { continue }
  $payload = $trimmed
  break
}
if ([string]::IsNullOrEmpty($payload)) { 'MISSING'; exit }
$bytes = [Convert]::FromBase64String($payload)
$plain = [System.Security.Cryptography.ProtectedData]::Unprotect($bytes, $null, 'CurrentUser')
[Convert]::ToBase64String($plain)
`

const ENCODED_SCRIPT = Buffer.from(DECRYPT_SCRIPT, 'utf16le').toString('base64')

/** 解出来的会话；value 就是 oc_sid 的值。 */
function cached() {
  return state.entry ?? undefined
}

const state = { entry: undefined, expiresAt: 0 }

/**
 * 读一次果办会话。
 *
 * 缓存到 cookie 自身的 expires 为止（提前 60 秒失效，避免边界上刚好过期）。文件不
 * 存在或解不开都返回 undefined —— 调用方据此提示"请先打开果办"。
 */
export async function readOfficeAceSession() {
  const now = Date.now()
  const hit = cached()
  if (hit !== undefined && state.expiresAt > now) return hit

  const cookiePath = officeAceSessionCookiePath()
  let raw
  try {
    raw = await readFile(cookiePath, 'utf8')
  } catch {
    return undefined
  }
  // 文件第一行不是 DPAPI 标记说明上游换了形态；此时不做猜测。
  if (!raw.trimStart().startsWith(DPAPI_MARKER)) return undefined

  let plainBase64
  try {
    const { stdout } = await execFileAsync(
      'powershell.exe',
      ['-NoProfile', '-NonInteractive', '-EncodedCommand', ENCODED_SCRIPT],
      { env: { ...process.env, DSH_HUAWEI_COOKIE_FILE: cookiePath }, windowsHide: true, timeout: 20_000 },
    )
    plainBase64 = String(stdout).trim()
  } catch {
    return undefined
  }
  if (plainBase64 === '' || plainBase64 === 'MISSING') return undefined

  let parsed
  try {
    parsed = JSON.parse(Buffer.from(plainBase64, 'base64').toString('utf8'))
  } catch {
    return undefined
  }
  const value = typeof parsed['value'] === 'string' ? parsed['value'] : ''
  if (value === '') return undefined
  const expiresSeconds = typeof parsed['expires'] === 'number' ? parsed['expires'] : 0
  const expiresAt = expiresSeconds > 0 ? expiresSeconds * 1000 - 60_000 : now + 60_000

  state.entry = { value, expiresAt }
  state.expiresAt = expiresAt
  return state.entry
}

/** 清掉缓存（用户重新登录果办后调用）。 */
export function invalidateOfficeAceSession() {
  state.entry = undefined
  state.expiresAt = 0
}
