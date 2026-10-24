/**
 * 本插件自己的落盘位置。
 *
 * 刻意**不**复用上游客户端的目录：本插件只读取它们（登录态、模型清单），所有写入
 * 都落在 $DSH_HOME 下，这样卸载插件、或者上游客户端升级换目录，都不会互相破坏。
 * $DSH_HOME 的判定顺序与 DSH 保持一致（DSH_HOME 环境变量优先，其次 ~/.dsh），否则
 * 同一个账号会被当成两份。
 *
 * @module dsh-huawei-connect/paths
 */
import { homedir } from 'node:os'
import { join } from 'node:path'

/** DSH 家目录：与宿主同一套判定，避免把同一账号认成两份。 */
export function dshHome(env = process.env) {
  const explicit = env['DSH_HOME']
  if (explicit !== undefined && explicit.trim() !== '') return explicit.trim()
  return join(homedir(), '.dsh')
}

/** 本插件的凭证与偏好（与上游客户端的文件完全分开）。 */
export function pluginHome(env = process.env) {
  return join(dshHome(env), '.huawei-connect')
}

/** 账号档案（含每个平台的凭证副本与刷新结果）与模型缓存、用量账本。 */
export function accountsPath(env = process.env) {
  return join(pluginHome(env), 'accounts.json')
}

export function catalogPath(env = process.env) {
  return join(pluginHome(env), 'catalog.json')
}

export function usagePath(env = process.env) {
  return join(pluginHome(env), 'usage.json')
}

/**
 * 码道（CodeArts）桌面端已有的登录态。
 *
 * dsh-codearts 插件与本插件读同一个文件：两边都是"用户的码道登录"，让用户在两个
 * 插件里各登一次是没必要的重复。只读。
 */
export function codeartsAccountsPath(env = process.env) {
  return join(dshHome(env), '.codearts-accounts.json')
}

/** 果办（OfficeAce）的 Windows 凭据前缀。 */
export const OFFICEACE_CREDENTIAL_PREFIX = 'OfficeAce/auth-sessions'

/** 果办用户目录（只读）。 */
export function officeAceUserRoot(env = process.env) {
  const explicit = env['OFFICE_CLAW_HOME']
  if (explicit !== undefined && explicit.trim() !== '') return explicit.trim()
  return join(homedir(), '.office-claw')
}

/** 果办本机控制面的会话 cookie 文件（DPAPI 加密）。 */
export function officeAceSessionCookiePath(env = process.env) {
  return join(officeAceUserRoot(env), 'session.cookie')
}
