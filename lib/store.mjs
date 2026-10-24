/**
 * 账号档案与上游登录态的同步。
 *
 * ## 两种上游登录态，两种读法
 *
 * **码道**：dsh-codearts 插件与本插件共用 $DSH_HOME/.codearts-accounts.json（用户只
 * 需要登录一次码道）。那份文件里每个账号带 STS token、临时 AK/SK、refresh_token 与
 * 绑定刷新用的 DPoP 私钥。本插件**只读**它，自己持有的是"上次同步到的一份副本"，
 * 这样上游插件改文件、删账号都不会让本插件拿着半截状态。
 *
 * **果办**：登录态在 Windows 凭据管理器里，是分块加密的 providerState（见 wincred.mjs）。
 * 本插件同样只读，读出后取其中的模型网关地址与 appKey/appSecret。
 *
 * ## 为什么要落盘副本
 *
 * 读果办要起 PowerShell（400ms），读码道要解析大 JSON；而卡片会轮询状态。落盘副本让
 * 轮询变成一次文件读，只有"重新同步"这类显式动作才回去碰上游。
 *
 * 副本里含密钥，所以权限收紧到当前用户（0o600）；文件损坏时按"没有账号"处理，绝不
 * 让一条坏记录把整个插件带崩。
 *
 * @module dsh-huawei-connect/store
 */
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises'
import { dirname } from 'node:path'
import { accountsPath, codeartsAccountsPath, OFFICEACE_CREDENTIAL_PREFIX, officeAceUserRoot } from './paths.mjs'
import { readChunkedCredential } from './wincred.mjs'
import { identityOfProviderState, modelGatewayOf } from './officeace.mjs'

/** 一个平台账户。 */
export function emptyAccount(platform, id) {
  return {
    platform,
    id,
    label: '',
    userName: '',
    userId: '',
    /** 上次成功同步到上游登录态的时间（毫秒）。 */
    syncedAt: 0,
    /** 上一次同步失败的原因（给卡片显示，不参与鉴权）。 */
    syncError: '',
    /** 码道：STS token + AK/SK（可能来自浏览器登录，也可能是上游客户端的副本）。 */
    codeArts: undefined,
    /** 果办：模型网关地址与 Basic 凭据。 */
    officeAce: undefined,
    /**
     * 本插件自己登录得到的 OAuth 凭证（含 refresh_token 与 DPoP 私钥）。
     *
     * 与 codeArts/officeAce 分开存：前者是"能发请求的凭证"，这里是"能续期的凭证"。
     * 从上游客户端读来的副本**没有**这一项（我们刻意不抄它的 refresh_token，见
     * readCodeArtsAccounts 的注释），所以那种账号只能用到过期为止。
     */
    oauth: undefined,
    /** 凭证来源：'login' = 本插件登录，'import' = 从上游客户端读取。 */
    origin: 'import',
  }
}

function asRecord(value) {
  return typeof value === 'object' && value !== null && !Array.isArray(value) ? value : {}
}

function firstString(...values) {
  for (const value of values) {
    if (typeof value === 'string' && value.trim() !== '') return value.trim()
  }
  return ''
}

/** 读 JSON 文件；不存在或坏掉都返回 undefined（坏文件不该让插件起不来）。 */
async function readJson(path) {
  try {
    return JSON.parse(await readFile(path, 'utf8'))
  } catch {
    return undefined
  }
}

/**
 * 原子写：先写临时文件再 rename。
 *
 * rename 在同一卷上是原子的，所以读者要么看到旧文件、要么看到新文件，不会读到半截
 * JSON —— 卡片轮询与这里写入是并发的。
 */
async function writeJsonAtomic(path, value) {
  await mkdir(dirname(path), { recursive: true })
  const temp = path + '.tmp-' + process.pid + '-' + Date.now()
  await writeFile(temp, JSON.stringify(value, null, 2), { encoding: 'utf8', mode: 0o600 })
  await rename(temp, path)
}

/** 磁盘上的账号档案形状。 */
function emptyDocument() {
  return { version: 1, accounts: {}, order: [] }
}

/**
 * 账号档案。所有变更都串行化（同一实例上的操作排队），避免"读到旧档—写回"覆盖
 * 掉同时发生的另一次更新。
 */
export class AccountStore {
  constructor(path = accountsPath()) {
    this.path = path
    this.document = undefined
    this.queue = Promise.resolve()
  }

  async load() {
    const raw = await readJson(this.path)
    const document = emptyDocument()
    if (raw !== undefined && typeof raw === 'object') {
      const accounts = asRecord(raw['accounts'])
      for (const [key, value] of Object.entries(accounts)) {
        const record = asRecord(value)
        const platform = firstString(record['platform'])
        if (platform !== 'codearts' && platform !== 'officeace') continue
        document.accounts[key] = { ...emptyAccount(platform, firstString(record['id']) || key), ...record }
      }
      const order = raw['order']
      document.order = Array.isArray(order) ? order.filter((key) => typeof key === 'string' && document.accounts[key]) : []
      for (const key of Object.keys(document.accounts)) {
        if (!document.order.includes(key)) document.order.push(key)
      }
    }
    this.document = document
    return document
  }

  /** 串行执行一次读改写。 */
  async mutate(fn) {
    const run = this.queue.then(async () => {
      if (this.document === undefined) await this.load()
      const result = await fn(this.document)
      await writeJsonAtomic(this.path, this.document)
      return result
    })
    // 即使这一次失败，队列也要继续跑下去，否则后续所有写都被卡死。
    this.queue = run.then(
      () => undefined,
      () => undefined,
    )
    return run
  }

  /** 当前快照（不触发写入）。 */
  snapshot() {
    const document = this.document ?? emptyDocument()
    return document.order.map((key) => document.accounts[key]).filter(Boolean)
  }

  list(platform) {
    return this.snapshot().filter((account) => platform === undefined || account.platform === platform)
  }

  get(key) {
    return this.document?.accounts[key]
  }

  /** 写入一个账号（按 platform + id 归一，重复同步不会产生新条目）。 */
  async upsert(account) {
    const key = account.platform + ':' + account.id
    return this.mutate((document) => {
      const previous = document.accounts[key]
      document.accounts[key] = { ...(previous ?? emptyAccount(account.platform, account.id)), ...account }
      if (!document.order.includes(key)) document.order.push(key)
      return document.accounts[key]
    })
  }

  /**
   * 存入一次续期结果。
   *
   * 单独走一个方法而不是 upsert：续期只更新凭证，不该改动 label/userName 这些
   * 用户可见字段，否则一次后台续期会悄悄覆盖掉用户设置的名字。
   */
  async saveRefreshed(key, credential) {
    return this.mutate((document) => {
      const record = document.accounts[key]
      if (record === undefined) return undefined
      record.oauth = credential
      record.syncedAt = Date.now()
      record.syncError = ''
      return record
    })
  }

  async remove(key) {
    return this.mutate((document) => {
      delete document.accounts[key]
      document.order = document.order.filter((entry) => entry !== key)
    })
  }
}

/**
 * 从 dsh-codearts 的账号文件里读出码道凭证。
 *
 * 那份文件的结构（实测）：
 *   { "version":1, "order":[...], "accounts": { "<userId>": {
 *       token, accessKeyId, secretAccessKey, refreshToken, dpopPrivateKey,
 *       clientId, expiration, userId, userName, domainId, label, storedAt } } }
 *
 * ## 关于 refresh_token 的接管
 *
 * 早期版本**不**抄 refreshToken / dpopPrivateKey，续期交给 dsh-codearts。这样做安全
 * 但有个明显缺陷：dsh-codearts 被卸载或没启用时，本插件两小时后就会失效。
 *
 * 现在本插件也能自己续期了（oauth.mjs），所以这里把 refresh_token 与 DPoP 私钥一并
 * 读出来。**风险**：refresh_token 是一次性的，两个插件同时续期会让先续的那个把后一个
 * 的 token 作废。因此：
 *   - 只有在账号**没有**自己的 oauth 凭证时才接管（首次）；
 *   - 接管之后由本插件独占，账号里记 `origin: 'import+oauth'`；
 *   - 如果两个插件都在用同一个账号，建议只保留一个（或让 dsh-codearts 停用该账号）。
 */
export async function readCodeArtsAccounts(env = process.env) {
  const raw = await readJson(codeartsAccountsPath(env))
  if (raw === undefined) return []
  const accounts = asRecord(asRecord(raw)['accounts'])
  const out = []
  for (const [key, value] of Object.entries(accounts)) {
    const record = asRecord(value)
    const securityToken = firstString(record['token'])
    const accessKeyId = firstString(record['accessKeyId'])
    const secretAccessKey = firstString(record['secretAccessKey'])
    if (securityToken === '' || accessKeyId === '' || secretAccessKey === '') continue
    const userId = firstString(record['userId']) || key
    const refreshToken = firstString(record['refreshToken'])
    const dpopKey = asRecord(record['dpopPrivateKey'])
    // 只有 refresh_token 与 DPoP 私钥都在，才构成可续期的凭证（私钥与 token 绑定）。
    const oauth =
      refreshToken !== '' && typeof dpopKey['d'] === 'string' && dpopKey['d'] !== ''
        ? {
            securityToken,
            accessKeyId,
            secretAccessKey,
            refreshToken,
            dpopKey,
            expiration: firstString(record['expiration']) || '',
            userId,
            userName: firstString(record['userName']),
            domainId: firstString(record['domainId']),
            clientId: firstString(record['clientId']) || 'codearts-agent',
            obtainedAt: typeof record['storedAt'] === 'number' ? record['storedAt'] : Date.now(),
          }
        : undefined
    out.push({
      id: userId,
      userName: firstString(record['userName']) || userId,
      label: firstString(record['label']),
      credential: {
        accessKeyId,
        secretAccessKey,
        securityToken,
        userId,
        userName: firstString(record['userName']),
        expiresAt: firstString(record['expiration']) || undefined,
      },
      ...(oauth === undefined ? {} : { oauth }),
    })
  }
  return out
}

/**
 * 从 Windows 凭据管理器里读出果办登录态。
 *
 * 目标名形如
 *   OfficeAce/auth-sessions/huawei-oauth/<domainId>%3A<userId>/provider-state
 * 但我们不知道 domainId/userId，所以用 cmdkey 的清单不可行（它不给 blob 大小）；
 * 这里改为读 OfficeAce 自己的 users 目录来枚举（目录名就是 <domainId>%3A<userId>）。
 */
export async function listOfficeAceCredentialTargets(env = process.env) {
  const root = officeAceUserRoot(env)
  let entries = []
  try {
    const { readdir } = await import('node:fs/promises')
    entries = await readdir(root + '/users', { withFileTypes: true })
  } catch {
    return []
  }
  const targets = []
  for (const entry of entries) {
    if (!entry.isDirectory()) continue
    // 目录名已经是 URL 编码过的 <domainId>%3A<userId>，直接拼即可。
    targets.push(OFFICEACE_CREDENTIAL_PREFIX + '/huawei-oauth/' + entry.name + '/provider-state')
  }
  return targets
}

/** 读一个果办账号的 providerState，并抽出模型网关与身份。 */
export async function readOfficeAceAccount(target) {
  const text = await readChunkedCredential(target)
  if (text === undefined) return undefined
  let parsed
  try {
    parsed = JSON.parse(text)
  } catch {
    return undefined
  }
  const providerState = asRecord(asRecord(parsed)['providerState'])
  const gateway = modelGatewayOf(providerState)
  if (gateway === undefined) return undefined
  const identity = identityOfProviderState(providerState)
  if (identity === undefined) return undefined
  const credentialV3 = asRecord(providerState['credentialV3'])
  const credential = asRecord(providerState['credential'])
  return {
    id: identity.userId,
    userName: identity.userName || identity.userId,
    label: firstString(providerState['principalUrn']),
    gateway,
    /** 本机控制面用的会话 cookie 值由 session.cookie 单独提供，这里只记身份。 */
    userKey: firstString(providerState['accountId']) + ':' + identity.userId,
    expiresAt: firstString(credentialV3['expires_at'], credential['expires_at']) || undefined,
  }
}
