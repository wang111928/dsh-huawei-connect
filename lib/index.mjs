/**
 * dsh-huawei-connect：把华为「果办 OfficeAce」与「码道 CodeArts」接进 DSH。
 *
 * ## 这一版做了什么
 *
 * - 两条 provider 路由：codearts / officeace，模型出现在 DSH 原生模型选择器里。
 * - 积分余量：码道走 /snap-manager/v1/statistics/plugin（实测 10500 分，体验版），
 *   果办走本机控制面 /api/subscription/current（实测 4600 分）与
 *   /api/codeagent-package/usage（剩余 10499.94）。
 * - 模型勾选：卡片里按平台勾选，写进 settings，适配器实时生效。
 * - 官方客户端同形态的请求伪装：见 disguise.mjs 的实测证据表。
 * - 账号自动发现：码道读 dsh-codearts 的账号文件，果办读 Windows 凭据管理器，
 *   都只读、都带缓存，不会让用户登两次。
 *
 * ## 与 workbuddy 那几个坑的对照
 *
 * workbuddy 的问题根子在"上游按提示词内容做渠道指纹拦截"。本插件在建时对华为两条
 * 链路逐条实测过（裸请求 / DSH 官方提示词 / Claude Code 身份句，全部 200），**没有
 * 抄那套提示词改写**——那会改写用户的提示词却换不到任何好处。
 *
 * 华为真正的限制是**码道每账号 3 个并发会话、每个会话占用约 1 分钟且中途停止不减免**。
 * 这里把它当成一等公民：撞上就原地排队重试（45s 预算），而不是把 400 甩给用户。
 *
 * @module dsh-huawei-connect
 */
import { randomUUID } from 'node:crypto'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { dirname } from 'node:path'
import { join } from 'node:path'
import { accountsPath, catalogPath, usagePath, pluginHome } from './paths.mjs'
import {
  AccountStore,
  listOfficeAceCredentialTargets,
  readCodeArtsAccounts,
  readOfficeAceAccount,
} from './store.mjs'
import {
  CODEARTS_SEED_MODELS,
  fetchCodeArtsCredits,
  fetchCodeArtsIdentity,
  fetchCodeArtsModels,
} from './codearts.mjs'
import {
  OFFICEACE_SEED_MODELS,
  fetchLocalControl,
  fetchOfficeAceModels,
  parseOfficeAcePackageUsage,
  parseOfficeAceSubscription,
} from './officeace.mjs'
import { readOfficeAceSession, invalidateOfficeAceSession } from './session.mjs'
import { startLogin, refreshCredential, needsRefresh, remainingMs } from './oauth.mjs'
import { AccountPool } from './pool.mjs'
import { createShim } from './shim.mjs'
import { createHuaweiAdapter } from './adapter.mjs'
import { describeFailure, classifyUpstreamFailure } from './disguise.mjs'
import { enabledListFor, isPlatformRecord, normalizeEnabledModels, withPlatformList } from './enabled.mjs'

export const PLATFORMS = ['codearts', 'officeace']

export const PLATFORM_DISPLAY_NAMES = {
  codearts: '码道 CodeArts',
  officeace: '果办 OfficeAce',
}

const SETTINGS_NAMESPACE = 'huawei-connect'

/** 卡片状态轮询的预算：积分慢请求不该把整张卡拖成转圈。 */
const CREDIT_TIMEOUT_MS = 12_000
/** 模型目录刷新周期（与 dsh-codearts 一致，每小时）。 */
const CATALOG_REFRESH_MS = 3_600_000

/** 一个平台的模型目录（内存态 + 落盘缓存）。 */
class ModelCatalog {
  constructor(seed, blacklist = new Set()) {
    this.models = [...seed].filter((model) => !blacklist.has(model.id ?? model.name))
    this.updatedAt = 0
    this.source = 'seed'
    this.blacklist = blacklist
  }

  current() {
    return this.models
  }

  replace(models, source) {
    if (models.length === 0) return false
    const filtered = models.filter((model) => !this.blacklist.has(model.id ?? model.name))
    if (filtered.length === 0) return false
    this.models = filtered
    this.updatedAt = Date.now()
    this.source = source
    return true
  }

  /** 记下一个实测不可用的模型 id（只在真正调用失败时走到这里，不额外消耗额度）。 */
  dropUnavailable(id) {
    if (typeof id !== 'string' || id === '') return false
    this.blacklist.add(id)
    const next = this.models.filter((model) => (model.id ?? model.name) !== id)
    if (next.length === this.models.length) return false
    this.models = next
    this.updatedAt = Date.now()
    return true
  }

  snapshot() {
    return { models: this.models, updatedAt: this.updatedAt, source: this.source }
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

async function readJson(path) {
  try {
    return JSON.parse(await readFile(path, 'utf8'))
  } catch {
    return undefined
  }
}

async function writeFileJson(path, value) {
  await mkdir(dirname(path), { recursive: true })
  await writeFile(path, JSON.stringify(value, null, 2), { encoding: 'utf8', mode: 0o600 })
}

// ---- 积分磁盘缓存：关掉桌面端 / 云端抖动时，卡片与 dock 仍能显示"上次读取"的积分 ----
function officeAceCreditsCachePath() { return join(pluginHome(), 'officeace-credits-cache.json') }
async function writeOfficeAceCreditsCache(value) {
  try { await writeFileJson(officeAceCreditsCachePath(), { ...value, cachedAt: Date.now() }) } catch {}
}
async function readOfficeAceCreditsCache() {
  const c = readJson(officeAceCreditsCachePath())
  if (c === undefined) return undefined
  if (typeof c.credits !== 'object' || c.credits === null) return undefined
  return { credits: c.credits, packageUsage: c.packageUsage }
}
function codeArtsCreditsCachePath() { return join(pluginHome(), 'codearts-credits-cache.json') }
async function writeCodeArtsCreditsCache(value) {
  try { await writeFileJson(codeArtsCreditsCachePath(), { ...value, cachedAt: Date.now() }) } catch {}
}
async function readCodeArtsCreditsCache() {
  const c = readJson(codeArtsCreditsCachePath())
  if (c === undefined) return undefined
  if (typeof c.credits !== 'object' || c.credits === null) return undefined
  return { credits: c.credits }
}

/** 实测不可用的模型黑名单（上游 /models 清单会反复灌回坏模型，必须持久化过滤）。 */
function modelBlacklistPath() { return join(pluginHome(), 'model-blacklist.json') }
const MODEL_BLACKLIST_SEED = {
  officeace: [
    'kimi-k3-test-1009','kimi-k3-1019','glm-5.2-a3','glm-5.2-harmony','glm-5.3-flash',
    'glm-5.3-test','deepseek-v4-pro','deepseek-v4.1-flash-1017','deepseek-v4.1-flash-bnt',
    'glm-5.2-zx','glm-5.3-zx','glm.5.2-arkts-spark','openpangu-2.0-pro','openpangu-2.0-flash',
  ],
  codearts: [],
}
function loadModelBlacklist() {
  const raw = readJson(modelBlacklistPath())
  const out = {}
  for (const platform of PLATFORMS) {
    const saved = Array.isArray(asRecord(raw)[platform]) ? asRecord(raw)[platform] : []
    const seed = MODEL_BLACKLIST_SEED[platform] ?? []
    out[platform] = new Set([...seed, ...saved.filter((x) => typeof x === 'string')])
  }
  return out
}
async function saveModelBlacklist(blacklists) {
  const payload = { version: 1 }
  for (const platform of PLATFORMS) payload[platform] = [...(blacklists[platform] ?? [])]
  await writeFileJson(modelBlacklistPath(), payload).catch(() => {})
}

/**
 * 本机用量账本。
 *
 * 只统计**本机经本插件发出**的请求数，不等于账号额度——码道与果办的官方额度以各自
 * 控制台为准，卡片上都会给出链接。这样做是因为两个平台的额度接口都是账号级的、且
 * 只有积分总数，没有"这次请求花了多少"的明细。
 */
class UsageLedger {
  constructor(path = usagePath()) {
    this.path = path
    this.days = {}
    this.loaded = false
    this.dirty = false
  }

  async load() {
    if (this.loaded) return
    this.loaded = true
    const raw = await readJson(this.path)
    if (raw !== undefined) this.days = asRecord(asRecord(raw)['days'])
  }

  record(platform, model) {
    const day = new Date().toISOString().slice(0, 10)
    const days = this.days
    const entry = asRecord(days[day])
    const platformEntry = asRecord(entry[platform])
    platformEntry['requests'] = (typeof platformEntry['requests'] === 'number' ? platformEntry['requests'] : 0) + 1
    platformEntry['lastModel'] = model
    platformEntry['lastAt'] = Date.now()
    entry[platform] = platformEntry
    days[day] = entry
    this.dirty = true
    return this.flush()
  }

  async flush() {
    if (!this.dirty) return
    this.dirty = false
    // 只保留 90 天，避免账本无限增长。
    const cutoff = new Date(Date.now() - 90 * 86_400_000).toISOString().slice(0, 10)
    for (const day of Object.keys(this.days)) {
      if (day < cutoff) delete this.days[day]
    }
    await writeFileJson(this.path, { version: 1, days: this.days }).catch(() => {})
  }

  snapshot() {
    const day = new Date().toISOString().slice(0, 10)
    const today = asRecord(this.days[day])
    return {
      today: Object.fromEntries(PLATFORMS.map((platform) => [platform, asRecord(today[platform])])),
      days: Object.keys(this.days).length,
    }
  }
}

/**
 * 插件主体。
 *
 * 装配顺序刻意是"先建 shim、再注册适配器"：适配器的 baseUrl 来自 shim 的随机端口，
 * 反过来拿不到。shim 起不来就不注册适配器——宁可让用户在卡片上看到错误，也不要
 * 注册一条所有请求都失败的 provider。
 */
export function apply(ctx, rawConfig) {
  const logger = ctx.logger
  const store = new AccountStore(accountsPath())
  /**
   * 每个平台一个账号池：健康度、轮转、自动续期。
   *
   * 池不关心凭证从哪来（浏览器登录 vs 上游客户端副本），只关心"这个号现在能不能用"。
   * onRefreshed 负责把续期结果落盘——refresh_token 一次性，不落盘就等于丢了。
   */
  const pools = {}
  for (const platform of PLATFORMS) {
    pools[platform] = new AccountPool({
      platform,
      onRefreshed: async (accountId, credential) => {
        await store.saveRefreshed(platform + ':' + accountId, credential)
      },
    })
  }
  const usage = new UsageLedger()
  const modelBlacklists = loadModelBlacklist()
  const catalogs = {
    codearts: new ModelCatalog(CODEARTS_SEED_MODELS, modelBlacklists.codearts),
    officeace: new ModelCatalog(OFFICEACE_SEED_MODELS, modelBlacklists.officeace),
  }
  /**
   * 卡片里勾选的模型 id，**按平台一份**；某个平台的清单为空 = 该平台不限制（全部开放）。
   *
   * 1.3.3 及以前是一份全局清单，两个平台共用。两个平台的模型 id 互不重叠，那份清单
   * 实际上同时过滤了两个平台：在码道栏只留几个模型，果办的模型会被一起从选择器里藏掉。
   * 形状与迁移见 enabled.mjs。
   */
  let enabledModels = {}
  /**
   * 账号池开关（按平台）：数组里出现的平台才启用账号池，空数组 = 全部单账号模式。
   *
   * 默认关闭是刻意的。账号池会按健康度轮转，并把"不健康"的账号从候选里**剔除**；
   * 一旦健康度被误判（1.3.1 之前转发层拒收签名请求就被当成凭证失效），被剔除的账号
   * 会让整个平台回 503 unconfigured。日常只接一个号的人根本不需要那套机制，
   * 所以它必须由用户显式打开——见 pickSingle。
   */
  let poolEnabled = loadCollection([], 'poolEnabled').filter((entry) => PLATFORMS.includes(entry))
  let shutDown = false
  /** 正在进行的登录（每平台最多一个）。 */
  const activeLogins = {}
  /** 最近一次登录的结果，供前端轮询。 */
  const lastLogins = {}

  function currentConfig() {
    const config = typeof rawConfig === 'function' ? rawConfig() : rawConfig
    return asRecord(config)
  }

  function loadCollection(fallback, key) {
    const value = currentConfig()[key]
    return Array.isArray(value) ? value.filter((entry) => typeof entry === 'string') : fallback
  }

  /**
   * 卡片轮询用的状态快照。
   *
   * 每个平台各自返回"账号 / 模型 / 积分 / 错误"，一个平台坏掉不影响另一个——这是
   * 用户同时接了两个平台时最需要的性质。
   */
  async function statusSnapshot(signal) {
    await store.load()
    const accounts = store.snapshot()
    const rows = []
    for (const platform of PLATFORMS) {
      const platformAccounts = accounts.filter((account) => account.platform === platform)
      const poolOn = poolEnabled.includes(platform)
      // 单账号模式也得让卡片说得出"现在在用谁"，否则用户只能靠猜。
      const active = (poolOn ? pools[platform].rank(platformAccounts) : pickSingle(platform, platformAccounts))[0]
      rows.push({
        platform,
        displayName: PLATFORM_DISPLAY_NAMES[platform],
        accounts: platformAccounts.map((account) => ({
          id: account.id,
          label: account.label || account.userName || account.id,
          userName: account.userName,
          syncedAt: account.syncedAt,
          syncError: account.syncError,
        })),
        models: catalogs[platform].snapshot(),
        enabled: enabledListFor(enabledModels, platform),
        // 单账号模式（false）还是账号池轮转（true），以及当前服务的是哪个号。
        poolEnabled: poolOn,
        activeAccount:
          active === undefined
            ? undefined
            : { id: active.id, label: active.label || active.userName || active.id },
        // 账号池健康度：谁被停用、谁在冷却、各自还剩多少时间。
        // 单账号模式下这仍然只是"显示"，不参与选择——见 pickSingle。
        pool: pools[platform].snapshot(platformAccounts),
        // 码道有"每账号 3 个并发会话"的配额，把这个占用暴露出来：
        // 用户看到"3 个槽都占着"就能理解为什么刚才要等，而不用猜。
        ...(platform === 'codearts'
          ? { sessions: shim.sessions(platformAccounts.map((account) => account.id)) }
          : {}),
        ...(await creditSnapshotFor(platform, platformAccounts, signal)),
      })
    }
    return {
      platforms: rows,
      usage: usage.snapshot(),
      settingsNamespace: SETTINGS_NAMESPACE,
    }
  }

  /** 每个平台的积分快照；失败只影响自己那一块。 */
  async function creditSnapshotFor(platform, platformAccounts, signal) {
    if (platformAccounts.length === 0) return { creditsError: '还没有同步到账号' }
    const account = platformAccounts[0]
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), CREDIT_TIMEOUT_MS)
    timer.unref?.()
    signal?.addEventListener('abort', () => controller.abort(), { once: true })
    try {
      if (platform === 'codearts') {
        // 码道积分走云端开放接口，先按需续期再查询；成功落盘缓存，失败回退缓存（灰字"上次读取"）。
        try {
          const credential = account.oauth === undefined
            ? account.codeArts
            : await pools.codearts.ensureFresh({ id: account.id, credential: account.oauth })
          const credits = await fetchCodeArtsCredits(credential, controller.signal)
          await writeCodeArtsCreditsCache({ credits }).catch(() => {})
          return { credits }
        } catch (error) {
          // 认证失败但档案里有 refresh_token：强制续期一次再试。
          const authFailed = /decrypt token fail|Incorrect IAM authentication|authentication|401|403|token/i.test(String(error))
          if (authFailed && account.oauth !== undefined) {
            try {
              const fresh = await refreshCredential('codearts', account.oauth)
              await store.saveRefreshed('codearts:' + account.id, fresh).catch(() => {})
              const credits = await fetchCodeArtsCredits(fresh, controller.signal)
              await writeCodeArtsCreditsCache({ credits }).catch(() => {})
              return { credits }
            } catch { /* 续期也失败，落到缓存兜底 */ }
          }
          const cached = await readCodeArtsCreditsCache()
          if (cached !== undefined) return { credits: cached.credits, creditsStale: true }
          return { creditsError: '码道积分接口读取失败：' + String(error).slice(0, 120) + '（不影响对话）' }
        }
      }
      const session = await readOfficeAceSession()
      if (session === undefined) {
        // 果办桌面端没在运行：回退到磁盘上"上次成功读到的积分"，关掉桌面端也能看到数字。
        const cached = await readOfficeAceCreditsCache()
        if (cached !== undefined) {
          return {
            credits: cached.credits,
            ...(cached.packageUsage === undefined ? {} : { packageUsage: cached.packageUsage }),
            creditsStale: true,
          }
        }
        return { creditsError: '读不到果办本机会话，请先打开果办并保持登录（不影响对话）' }
      }
      const subscription = parseOfficeAceSubscription(
        await fetchLocalControl(session.value, '/api/subscription/current', controller.signal),
      )
      let packageUsage
      try {
        packageUsage = parseOfficeAcePackageUsage(
          await fetchLocalControl(session.value, '/api/codeagent-package/usage', controller.signal),
        )
      } catch {
        packageUsage = undefined
      }
      // 成功读到就落盘缓存：果办桌面端关掉后，下次轮询仍能显示"上次读取"的积分。
      await writeOfficeAceCreditsCache({ credits: subscription, packageUsage }).catch(() => {})
      return {
        credits: subscription,
        ...(packageUsage === undefined ? {} : { packageUsage }),
      }
    } catch (error) {
      const failure = classifyUpstreamFailure(500, String(error))
      return { creditsError: describeFailure(failure) }
    } finally {
      clearTimeout(timer)
    }
  }

  /**
   * 登录成功后拿稳定身份。
   *
   * 码道：用刚拿到的凭证问 /snap-manager/v1/current/user（上游有时返回空串，
   * 那就退回凭证里的 userId，再退回 domain）。果办：用 providerState 里的 user_id；
   * 新建登录时先拉一次 providerState 才能拿到，拿不到就用 OAuth 返回的身份。
   */
  async function resolveIdentity(platform, credential) {
    if (platform === 'codearts') {
      const fromToken = credential.userId || credential.domainId
      if (fromToken) return { id: fromToken, userName: credential.userName || fromToken }
      const identity = await fetchCodeArtsIdentity(
        {
          accessKeyId: credential.accessKeyId,
          secretAccessKey: credential.secretAccessKey,
          securityToken: credential.securityToken,
        },
        AbortSignal.timeout(15_000),
      ).catch(() => undefined)
      const id = identity?.userId || credential.domainId || credential.userId
      if (!id) throw new Error('登录成功但拿不到稳定身份，请重试')
      return { id, userName: identity?.userName || credential.userName || id }
    }
    const id = credential.userId || credential.domainId
    if (!id) throw new Error('登录成功但拿不到稳定身份，请重试')
    return { id, userName: credential.userName || id }
  }

  /**
   * 果办登录之后要找模型网关。
   *
   * OAuth 只给 IAM token，模型网关的地址与 appKey 来自云端下发的 providerState
   * （开通订阅时才生成）。所以这里问一次 /client-subscription；拿到就存进账号，
   * 拿不到就标记出来，让用户知道要去果办里开通/打开一次。
   */
  async function refreshOfficeAceGateway(key) {
    const account = store.get(key)
    if (account?.oauth === undefined) return false
    try {
      const response = await fetch('https://versatile.cn-north-4.myhuaweicloud.com/v1/claw/client-subscription', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json;charset=utf8',
          'x-auth-token': account.oauth.securityToken,
          'X-Project-Id': account.oauth.domainId ?? '',
          'x-subscription-type': 'v2',
        },
        body: '{}',
        signal: AbortSignal.timeout(20_000),
      })
      if (!response.ok) return false
      const body = await response.json()
      const modelInfo = body?.model_info ?? body?.subscription?.model_info
      const gateway = modelGatewayOf({ modelInfo })
      if (gateway === undefined) return false
      await store.upsert({ ...account, platform: 'officeace', id: account.id, officeAce: { gateway }, syncError: '' })
      return true
    } catch {
      return false
    }
  }

  /**
   * 从上游同步登录态。
   *
   * 幂等：重复调用只是刷新同一批条目。某个平台失败不影响另一个——用户可能只登了
   * 其中一个。失败原因写进条目（syncError），卡片上直接显示，不需要看日志。
   */
  async function sync() {
    const results = {}

    // ---- 码道 ----
    try {
      const found = await readCodeArtsAccounts()
      for (const entry of found) {
        const identity = await fetchCodeArtsIdentity(entry.credential).catch(() => undefined)
        const id = identity?.userId || entry.id
        // 上游客户端那份文件里**有** refresh_token 与 DPoP 私钥。既然本插件现在
        // 自己也能续期了，就把它们一并接管：这样即使 dsh-codearts 被卸载，账号也
        // 不会在两小时后失效。注意这会与 dsh-codearts 共享同一个 refresh_token——
        // 两边都续期会让对方的 token 作废，所以 sync 时只**首次接管**，之后由本插件
        // 独占（见 tryAdoptOAuth 的注释）。
        // 不能无条件用上游文件覆盖本插件自己的登录凭证（.codearts-accounts.json 可能是
        // 已过期/已标 stale 的旧凭证）。本地 oauth 还有效且上游这份不比本地新时只更新展示字段。
        const existing = store.get('codearts:' + id)
        const localOAuth = existing?.oauth
        const incomingRemaining = entry.oauth === undefined ? undefined : remainingMs(entry.oauth)
        const localRemaining = localOAuth === undefined ? undefined : remainingMs(localOAuth)
        const localStillUsable = localOAuth !== undefined && localRemaining !== undefined && localRemaining > 0
        const incomingUsable = entry.oauth !== undefined && incomingRemaining !== undefined && incomingRemaining > 0
        if (localStillUsable && !(incomingUsable && (incomingRemaining ?? 0) > (localRemaining ?? 0))) {
          await store.upsert({
            platform: 'codearts', id,
            label: entry.label || existing?.label || '',
            userName: identity?.userName || existing?.userName || entry.userName,
            userId: id,
            syncedAt: existing?.syncedAt ?? Date.now(),
            syncError: '',
          })
        } else {
          await store.upsert({
            platform: 'codearts',
            id,
            label: entry.label || '',
            userName: identity?.userName || entry.userName,
            userId: id,
            syncedAt: Date.now(),
            syncError: '',
            codeArts: entry.credential,
            ...(entry.oauth === undefined ? {} : { oauth: entry.oauth, origin: 'import+oauth' }),
          })
        }
        // 用户显式点了「同步登录态」，而且这次同步里刚用这份凭证向上游认证成功过
        // （identity 拿到了）。那池里可能残留的"认证失败停用"标记就必须清掉：
        // 503 的文案让用户"去设置卡片里同步"，那同步就得真的能修好它，否则
        // 用户会一直重复"登录 → 还是 503"这个循环。
        if (identity !== undefined) pools.codearts?.enable(id)
      }
      results.codearts = { ok: true, accounts: found.length }
      if (found.length === 0) results.codearts = { ok: false, accounts: 0, message: '没有找到码道登录态：请先用码道桌面端登录（或装 dsh-codearts 插件登录一次）' }
    } catch (error) {
      results.codearts = { ok: false, accounts: 0, message: String(error) }
    }

    // ---- 果办 ----
    try {
      const targets = await listOfficeAceCredentialTargets()
      let count = 0
      for (const target of targets) {
        const account = await readOfficeAceAccount(target)
        if (account === undefined) continue
        count += 1
        await store.upsert({
          platform: 'officeace',
          id: account.id,
          label: account.label || '',
          userName: account.userName,
          userId: account.id,
          syncedAt: Date.now(),
          syncError: '',
          officeAce: { gateway: account.gateway },
        })
        // 与码道同理：果办是用户为了让路由重新可用才点的同步，池里的停用/冷却要一起清。
        pools.officeace?.enable(account.id)
      }
      results.officeace =
        count === 0
          ? { ok: false, accounts: 0, message: '没有找到果办登录态：请先打开果办并登录，再点同步' }
          : { ok: true, accounts: count }
    } catch (error) {
      results.officeace = { ok: false, accounts: 0, message: String(error) }
    }

    await refreshCatalogs().catch(() => {})
    return results
  }

  /** 刷新两个平台的模型目录。任一失败保留旧目录（不要让选择器空掉）。 */
  async function refreshCatalogs() {
    await store.load()
    const accounts = store.snapshot()

    const codeArtsAccount = accounts.find((account) => account.platform === 'codearts')
    if (codeArtsAccount !== undefined) {
      try {
        const models = await fetchCodeArtsModels(codeArtsAccount.codeArts, AbortSignal.timeout(20_000))
        if (catalogs.codearts.replace(models, 'upstream')) {
          logger?.debug?.('[huawei-connect] codearts catalog: ' + models.length + ' models')
        }
      } catch (error) {
        logger?.debug?.('[huawei-connect] codearts catalog refresh failed: ' + String(error))
      }
    }

    const officeAceAccount = accounts.find((account) => account.platform === 'officeace')
    if (officeAceAccount !== undefined) {
      try {
        const models = await fetchOfficeAceModels(officeAceAccount.officeAce.gateway, AbortSignal.timeout(20_000))
        if (catalogs.officeace.replace(models, 'upstream')) {
          logger?.debug?.('[huawei-connect] officeace catalog: ' + models.length + ' models')
        }
      } catch (error) {
        logger?.debug?.('[huawei-connect] officeace catalog refresh failed: ' + String(error))
      }
    }

    await writeFileJson(catalogPath(), {
      version: 1,
      codearts: catalogs.codearts.snapshot(),
      officeace: catalogs.officeace.snapshot(),
    }).catch(() => {})
    return { codearts: catalogs.codearts.current().length, officeace: catalogs.officeace.current().length }
  }

  /** 从落盘缓存恢复上次的模型目录（冷启动先有东西可选）。 */
  async function restoreCatalogs() {
    const cached = await readJson(catalogPath())
    if (cached === undefined) return
    for (const platform of PLATFORMS) {
      const entry = asRecord(asRecord(cached)[platform])
      const models = entry['models']
      if (Array.isArray(models) && models.length > 0) {
        catalogs[platform].replace(models, 'cache')
        catalogs[platform].updatedAt = typeof entry['updatedAt'] === 'number' ? entry['updatedAt'] : 0
      }
    }
  }

  /**
   * 这个平台现在为什么没有可用账号——把池里的停用 / 冷却状态摊开说。
   *
   * 不区分的话，"账号被停用"和"从来没配过账号"在用户眼里是同一个 503，而文案又会
   * 把他指向「同步登录态」——那正是修不好它的动作（sync 现在会 enable，所以这句话
   * 从 1.3.1 起是真的，但用户仍然需要知道到底是谁、被卡了多久、上游说了什么）。
   */
  function explainUnavailable(platform) {
    const rows = store.list(platform)
    if (rows.length === 0) {
      return '这个平台还没有配置任何账号：请在卡片里登录，或点「同步登录态」从上游客户端读一份。'
    }
    const parts = []
    for (const account of rows) {
      const view = pools[platform].snapshot([account])[0]
      const who = account.label || account.userName || account.id
      if (account.platform === 'codearts' && account.codeArts === undefined) {
        parts.push(who + ' 没有可用的凭证（codeArts 缺失）')
        continue
      }
      if (account.platform === 'officeace' && account.officeAce === undefined) {
        parts.push(who + ' 没有可用的凭证（officeAce 缺失）')
        continue
      }
      if (view.disabled) {
        parts.push(
          who + ' 已被停用，还剩 ' + Math.ceil(view.disabledRemainingMs / 60000) + ' 分钟' +
            (view.lastError === '' ? '' : '（上游最后报：' + view.lastError + '）'),
        )
        continue
      }
      if (view.cooling) {
        parts.push(who + ' 正在冷却，还剩 ' + Math.ceil(view.cooldownRemainingMs / 1000) + ' 秒')
        continue
      }
      parts.push(who + ' 凭证已过期且续期失败')
    }
    return parts.join('；') + '。点「同步登录态」或重新登录即可解除停用。'
  }

  /**
   * 单账号模式交给 shim 的那**一个**账号。
   *
   * 与池的关键区别是"健康标记只用来挑，不用来删"：优先挑一个健康的，一个健康的都没有
   * 就退回到第一个有凭证的号。因此单账号模式**永远不会**出现"候选为空"的 503——
   * 账号被误判停用也好、正在冷却也好，请求照样发得出去，用户看到的是真实的上游错误。
   *
   * 不做轮转：同一时刻只有一个号在服务，这就是"日常用单账号"。
   */
  function pickSingle(platform, rows) {
    const withCredential = rows.filter((account) =>
      platform === 'codearts' ? account.codeArts !== undefined : account.officeAce !== undefined,
    )
    if (withCredential.length === 0) return []
    const [healthy] = pools[platform].rank(withCredential)
    return [healthy ?? withCredential[0]]
  }

  /**
   * shim 的账号来源。
   *
   * 每次请求都从 store 读最新快照：用户刚同步完不该需要重启。凭证缺失的账号直接
   * 跳过（而不是带着空凭证去签一个必失败的请求）。
   */
  const shim = createShim({
    /**
     * 交给 shim 的候选账号：已经过池的健康度过滤，并按"最少使用"排序。
     *
     * 这里只做「谁可以用」的判断；续期在 request 路径上按需触发（见 refreshInline），
     * 因为续期要 await，而 accounts() 是同步接口。
     */
    accounts: (platform) => {
      const rows = store.list(platform)
      // 池开着才按健康度轮转；默认的单账号模式只交一个号，且不因健康标记被排除。
      const candidates = poolEnabled.includes(platform)
        ? pools[platform].rank(rows)
        : pickSingle(platform, rows)
      if (platform === 'codearts') {
        return candidates
          .filter((account) => account.codeArts !== undefined)
          .map((account) => ({ id: account.id, credential: account.codeArts }))
      }
      return candidates
        .filter((account) => account.officeAce !== undefined)
        .map((account) => ({ id: account.id, gateway: account.officeAce.gateway }))
    },
    /**
     * 候选为空时，用来说明"为什么一个都用不了"。见 explainUnavailable。
     */
    explainUnavailable,
    /**
     * 请求失败时回报给池，让健康度跟着真实结果走。
     * 并发撞墙不惩罚账号——那是容量问题，把好号踢出池只会更糟。
     */
    onAccountFailure: (platform, accountId, kind, message, model) => {
      // 模型级失败（403 无权限 / 404 不存在）：把这个模型从目录里剔除，而不是惩罚账号。
      if (kind === 'model_unavailable') {
        if (model !== undefined && catalogs[platform]?.dropUnavailable(model)) {
          logger?.debug?.('[huawei-connect] drop unavailable model: ' + platform + '/' + model)
          void saveModelBlacklist(modelBlacklists)
          void writeFileJson(catalogPath(), {
            version: 1,
            codearts: catalogs.codearts.snapshot(),
            officeace: catalogs.officeace.snapshot(),
          }).catch(() => {})
        }
        return
      }
      pools[platform]?.noteFailure(accountId, kind, message)
    },
    onAccountSuccess: (platform, accountId) => {
      pools[platform]?.noteSuccess(accountId)
    },
    /**
     * 按需续期：shim 在发请求前调用，拿到新鲜凭证。
     *
     * 单飞在池里（同一账号并发只会真续一次）。续期成功会落盘，
     * 所以下次启动也能直接用新 token。
     */
    refreshAccount: async (platform, accountId) => {
      const account = store.get(platform + ':' + accountId)
      if (account === undefined) return undefined
      if (platform === 'codearts') {
        if (account.oauth === undefined) return account.codeArts
        const fresh = await pools[platform].ensureFresh({
          id: account.id,
          credential: account.oauth,
        })
        return { accessKeyId: fresh.accessKeyId, secretAccessKey: fresh.secretAccessKey, securityToken: fresh.securityToken }
      }
      // 果办的模型网关用 appKey/appSecret，不随 OAuth token 过期，无需续期。
      return account.officeAce?.gateway
    },
    logger,
    /**
     * 该模型是否吃图片。只有码道/果办目录里明确 supportsImages 为真的模型才算——
     * 缺省 false，因为把图发给纯文本模型是硬拒绝（码道 001001020 / 果办 81001）。
     */
    supportsImages: (platform, modelId) => {
      const entry = catalogs[platform]
        ?.current()
        .find((model) => model.id === modelId)
      return entry?.supportsImages === true
    },
    onUsage: (platform, model) => {
      void usage.record(platform, model)
    },
  })

  let releases = []

  ctx.effect(() => () => {
    shutDown = true
    for (const release of releases) {
      try {
        release()
      } catch {
        /* ignore */
      }
    }
    releases = []
    void shim.close()
  })

  shim.ready
    .then(async () => {
      if (shutDown) return
      await restoreCatalogs()
      await store.load()

      // 勾选清单：形状可能是 1.3.3 的扁平全局数组（旧），按"这个 id 属于哪个平台的目录"
      // 拆成每平台一份并写回，之后每次启动都是新形状，不再需要迁移。
      const storedEnabled = currentConfig()['enabledModels']
      enabledModels = normalizeEnabledModels(storedEnabled, {
        codearts: catalogs.codearts.current().map((model) => model.id),
        officeace: catalogs.officeace.current().map((model) => model.id),
      })
      if (!isPlatformRecord(storedEnabled)) {
        const settingsService = ctx.get('settings')
        if (settingsService !== undefined && typeof settingsService.update === 'function') {
          void settingsService.update(SETTINGS_NAMESPACE, { enabledModels }).catch(() => {})
        }
      }

      for (const platform of PLATFORMS) {
        const built = createHuaweiAdapter({
          platform,
          displayName: PLATFORM_DISPLAY_NAMES[platform],
          catalog: catalogs[platform],
          shim,
          enabledModels: () => enabledListFor(enabledModels, platform),
        })
        try {
          const releaseAdapter = ctx.llm.registerAdapter([platform], built.adapter)
          const releaseDirectory = ctx.llm.registerConfigurableProviders([
            {
              provider: platform,
              displayName: PLATFORM_DISPLAY_NAMES[platform],
              settingsNs: SETTINGS_NAMESPACE,
              settingsPath: [],
              declared: false,
            },
          ])
          releases.push(releaseAdapter, releaseDirectory)
        } catch (error) {
          logger?.error?.('[huawei-connect] cannot register ' + platform + ' provider: ' + String(error))
        }
      }

      // 启动时同步一次，并且每小时刷新一次模型目录。
      void sync().catch((error) => logger?.debug?.('[huawei-connect] initial sync failed: ' + String(error)))
      // 后台积分轮询：每小时自动刷新两个平台的积分快照（码道云端自动续期、果办缓存兜底）。
      async function refreshCredits() {
        await store.load()
        const accounts = store.snapshot()
        for (const platform of PLATFORMS) {
          const platformAccounts = accounts.filter((account) => account.platform === platform)
          if (platformAccounts.length === 0) continue
          const controller = new AbortController()
          const ctimer = setTimeout(() => controller.abort(), CREDIT_TIMEOUT_MS)
          ctimer.unref?.()
          try {
            await creditSnapshotFor(platform, platformAccounts, controller.signal)
          } catch { /* 后台失败不影响前台 */ } finally {
            clearTimeout(ctimer)
          }
        }
      }
      const timer = setInterval(() => void refreshCatalogs().catch(() => {}), CATALOG_REFRESH_MS)
      timer.unref?.()
      ctx.effect(() => () => clearInterval(timer))
      const creditTimer = setInterval(() => void refreshCredits().catch(() => {}), CATALOG_REFRESH_MS)
      creditTimer.unref?.()
      ctx.effect(() => () => clearInterval(creditTimer))
    })
    .catch((error) => {
      logger?.error?.('[huawei-connect] shim failed to start; providers not registered: ' + String(error))
    })

  // ---- web 状态接口（卡片用） ----
  ctx.inject(['webServer'], (webCtx) => {
    const routes = []
    const register = (path, handler) => {
      const dispose = webCtx.webServer.register({ kind: 'exact', path, handler })
      routes.push(dispose)
    }

    register('/api/huawei-connect/status', async (request, response) => {
      try {
        const snapshot = await statusSnapshot()
        writeResponseJson(response, 200, snapshot)
      } catch (error) {
        writeResponseJson(response, 500, { error: String(error) })
      }
    })

    // 客户端自检上报：把 dock 执行情况写盘，排查"积分条不显示"。
    register('/api/huawei-connect/client-diag', async (request, response) => {
      try {
        const body = JSON.parse((await readBodyOf(request)).toString('utf8') || '{}')
        const path = join(pluginHome(), 'client-diag.json')
        await mkdir(dirname(path), { recursive: true }).catch(() => {})
        const previous = (await readJson(path)) ?? { events: [] }
        const events = Array.isArray(previous.events) ? previous.events : []
        events.push({ at: Date.now(), ...body })
        await writeFile(path, JSON.stringify({ events: events.slice(-200) }, null, 2), 'utf8')
        writeResponseJson(response, 200, { ok: true })
      } catch (error) {
        writeResponseJson(response, 500, { error: String(error) })
      }
    })

    register('/api/huawei-connect/sync', async (request, response) => {
      try {
        const result = await sync()
        writeResponseJson(response, 200, { ...result, status: await statusSnapshot() })
      } catch (error) {
        writeJson(response, 500, { error: String(error) })
      }
    })

    register('/api/huawei-connect/refresh-models', async (request, response) => {
      try {
        const counts = await refreshCatalogs()
        writeResponseJson(response, 200, { ...counts, status: await statusSnapshot() })
      } catch (error) {
        writeJson(response, 500, { error: String(error) })
      }
    })

    /**
     * 开始一次浏览器登录。
     *
     * 返回授权地址，前端负责打开（有些环境用 window.open，有些环境要用户自己复制）。
     * 登录结果通过 /login/status 轮询拿。
     */
    register('/api/huawei-connect/login', async (request, response) => {
      if (request.method !== 'POST') {
        writeResponseJson(response, 405, { error: 'method not allowed' })
        return
      }
      try {
        const body = JSON.parse((await readBodyOf(request)).toString('utf8'))
        const platform = String(body['platform'] ?? '')
        if (!PLATFORMS.includes(platform)) {
          writeResponseJson(response, 400, { error: 'unknown platform: ' + platform })
          return
        }
        if (activeLogins[platform] !== undefined) {
          writeResponseJson(response, 409, { error: '该平台已有登录在进行中', authorizeUrl: activeLogins[platform].authorizeUrl })
          return
        }

        const session = startLogin(platform)
        // 授权地址要等本地端口就绪才能拼出来。
        const authorizeUrl = await session.authorizeUrl
        activeLogins[platform] = { session, authorizeUrl, startedAt: Date.now() }

        session.promise
          .then(async (credential) => {
            const identity = await resolveIdentity(platform, credential)
            const key = platform + ':' + identity.id
            await store.upsert({
              platform,
              id: identity.id,
              userName: identity.userName || identity.id,
              userId: identity.id,
              label: '',
              syncedAt: Date.now(),
              syncError: '',
              origin: 'login',
              oauth: credential,
              ...(platform === 'codearts'
                ? {
                    codeArts: {
                      accessKeyId: credential.accessKeyId,
                      secretAccessKey: credential.secretAccessKey,
                      securityToken: credential.securityToken,
                      userId: identity.id,
                      userName: identity.userName,
                      expiresAt: credential.expiration || undefined,
                    },
                  }
                : {}),
            })
            // 重登换了新凭证：必须清掉池里可能残留的"认证失败停用"标记。
            pools[platform]?.enable(identity.id)
            if (platform === 'officeace') await refreshOfficeAceGateway(key)
            lastLogins[platform] = { ok: true, at: Date.now(), accountId: identity.id }
            await refreshCatalogs().catch(() => {})
          })
          .catch((error) => {
            lastLogins[platform] = { ok: false, at: Date.now(), message: String(error).slice(0, 300) }
          })
          .finally(() => {
            delete activeLogins[platform]
            session.close()
          })

        writeResponseJson(response, 200, { authorizeUrl, platform })
      } catch (error) {
        writeResponseJson(response, 500, { error: String(error) })
      }
    })

    /** 轮询登录结果。 */
    register('/api/huawei-connect/login/status', async (request, response) => {
      const url = new URL(request.url ?? '/', 'http://localhost')
      const platform = url.searchParams.get('platform') ?? ''
      if (!PLATFORMS.includes(platform)) {
        writeResponseJson(response, 400, { error: 'unknown platform: ' + platform })
        return
      }
      const pending = activeLogins[platform]
      const last = lastLogins[platform]
      writeResponseJson(response, 200, {
        pending: pending !== undefined,
        ...(pending === undefined ? {} : { authorizeUrl: pending.authorizeUrl }),
        ...(last === undefined ? {} : { last }),
      })
    })

    /** 删掉一个账号（只从本插件的档案里移除，不动上游客户端）。 */
    register('/api/huawei-connect/accounts', async (request, response) => {
      if (request.method !== 'DELETE') {
        writeResponseJson(response, 405, { error: 'method not allowed' })
        return
      }
      const url = new URL(request.url ?? '/', 'http://localhost')
      const platform = url.searchParams.get('platform') ?? ''
      const id = url.searchParams.get('id') ?? ''
      if (!PLATFORMS.includes(platform) || id === '') {
        writeResponseJson(response, 400, { error: 'platform and id are required' })
        return
      }
      await store.remove(platform + ':' + id)
      writeResponseJson(response, 200, { removed: true, status: await statusSnapshot() })
    })

    /**
     * 模型勾选清单，**按平台一份**（形状见 enabled.mjs）。
     *
     * POST 接受三种体：
     *   { enabled: { codearts: [...], officeace: [...] } }  —— 卡片保存整份记录（切栏不丢改动）
     *   { platform, enabled: [...] }                       —— 只改一个平台
     *   { enabled: [...] }                                 —— 旧形状：按目录归属拆到各平台
     */
    register('/api/huawei-connect/enabled-models', async (request, response) => {
      if (request.method === 'GET') {
        writeResponseJson(response, 200, { enabled: enabledModels })
        return
      }
      if (request.method !== 'POST') {
        writeResponseJson(response, 405, { error: 'method not allowed' })
        return
      }
      try {
        const body = JSON.parse((await readBodyOf(request)).toString('utf8'))
        const platform = typeof body['platform'] === 'string' ? body['platform'] : ''
        if (isPlatformRecord(body['enabled'])) {
          enabledModels = normalizeEnabledModels(body['enabled'], undefined)
        } else if (PLATFORMS.includes(platform)) {
          enabledModels = withPlatformList(enabledModels, platform, body['enabled'])
        } else if (Array.isArray(body['enabled'])) {
          // 旧形状（没有 platform 的扁平数组）：按"这个 id 属于哪个平台"拆开，
          // 而不是当成"两个平台共用同一份"——后者正是要修掉的那个行为。
          enabledModels = normalizeEnabledModels(body['enabled'], {
            codearts: catalogs.codearts.current().map((model) => model.id),
            officeace: catalogs.officeace.current().map((model) => model.id),
          })
        } else {
          writeResponseJson(response, 400, { error: 'enabled is required' })
          return
        }
        const settings = ctx.get('settings')
        if (settings !== undefined && typeof settings.update === 'function') {
          await settings.update(SETTINGS_NAMESPACE, { enabledModels })
        }
        writeResponseJson(response, 200, { enabled: enabledModels, status: await statusSnapshot() })
      } catch (error) {
        writeResponseJson(response, 400, { error: String(error) })
      }
    })

    /**
     * 账号池开关。默认关闭 = 单账号模式。
     *
     * 单独一条路由、单独一个按钮：这是刻意的"显式启用"，因为它会改变选号策略
     * （多个账号之间轮转 + 按健康度剔除候选），而不是一个纯展示选项。
     */
    register('/api/huawei-connect/pool', async (request, response) => {
      if (request.method === 'GET') {
        writeResponseJson(response, 200, { poolEnabled })
        return
      }
      if (request.method !== 'POST') {
        writeResponseJson(response, 405, { error: 'method not allowed' })
        return
      }
      try {
        const body = JSON.parse((await readBodyOf(request)).toString('utf8'))
        const platform = typeof body['platform'] === 'string' ? body['platform'] : ''
        if (!PLATFORMS.includes(platform)) {
          writeResponseJson(response, 400, { error: 'platform must be one of ' + PLATFORMS.join(', ') })
          return
        }
        const want = body['enabled'] === true
        poolEnabled = want
          ? PLATFORMS.filter((entry) => entry === platform || poolEnabled.includes(entry))
          : poolEnabled.filter((entry) => entry !== platform)
        const settings = ctx.get('settings')
        if (settings !== undefined && typeof settings.update === 'function') {
          await settings.update(SETTINGS_NAMESPACE, { poolEnabled })
        }
        writeResponseJson(response, 200, { poolEnabled, status: await statusSnapshot() })
      } catch (error) {
        writeResponseJson(response, 400, { error: String(error) })
      }
    })

    ctx.effect(() => () => {
      for (const dispose of routes) {
        try {
          dispose()
        } catch {
          /* ignore */
        }
      }
    })
  })
}

/** 一次 HTTP JSON 响应。名字与文件写入器分开，避免把响应对象当路径传进去。 */
function writeResponseJson(response, status, body) {
  const payload = JSON.stringify(body)
  response.writeHead(status, { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(payload) })
  response.end(payload)
}

function readBodyOf(request) {
  return new Promise((resolve, reject) => {
    const chunks = []
    request.on('data', (chunk) => chunks.push(chunk))
    request.on('end', () => resolve(Buffer.concat(chunks)))
    request.on('error', reject)
  })
}

/** DSH 依赖注入：需要 llm 服务；webServer 与 settings 是可选增强。 */
export const inject = ['llm']
export const name = 'dsh-huawei-connect'
