/**
 * 账号池：多账号、自动续期、健康度与轮转。
 *
 * ## 为什么要账号池
 *
 * 码道对**每个账号**只开 3 个并发会话、每个占用约 1 分钟（实测 \`TM.00001041\`）。
 * 这不是"多买点额度"能解决的——它是账号级的硬计数。唯一的扩容办法就是**多账号**：
 * 两个账号 = 6 个槽，四个 = 12 个。
 *
 * 另外，额度是按账号算的：一个号的积分用完了，另一个号可能还有。所以池不仅要能
 * 扩容并发，还要能在"这个号积分耗尽"时自动换下一个。
 *
 * ## 设计
 *
 * - **每个账号独立凭证**：各自有 security_token / AK/SK / refresh_token / DPoP 私钥。
 * - **自动续期单飞**：refresh_token 是一次性的，两个请求同时去续会让其中一个失效。
 *   所以按账号加锁，且续完立刻落盘。
 * - **健康度**：认证失败 → 停用（要重新登录）；积分耗尽 → 冷却到额度周期结束；
 *   并发撞墙 → 不惩罚账号（那是容量问题，不是账号坏了）。
 * - **轮转顺序**：优先选"没被停用、没在冷却、还没试过"的账号，并且**按上次使用时间
 *   排序**（最少使用优先），避免总用同一个号把它的额度先耗光。
 *
 * @module dsh-huawei-connect/pool
 */
import { needsRefresh, refreshCredential, remainingMs } from './oauth.mjs'

/** 认证失败后停用多久再重试（一般要用户介入重新登录）。 */
const AUTH_DISABLED_MS = 60 * 60 * 1000
/** 积分耗尽后冷却多久（额度周期通常按天/月重置，这里给一个保守的短冷却）。 */
const QUOTA_COOLDOWN_MS = 30 * 60 * 1000
/** 上游 5xx 后的短冷却。 */
const SERVER_COOLDOWN_MS = 30 * 1000
/** 零散错误累计到阈值后冷却。 */
const ERROR_COOLDOWN_MS = 60 * 1000

/** 一条池成员。 */
function emptyState(accountId) {
  return {
    accountId,
    disabledUntil: 0,
    coolUntil: 0,
    errorCount: 0,
    lastUsedAt: 0,
    lastError: '',
    /** 成功/失败计数，仅用于卡片展示。 */
    successes: 0,
    failures: 0,
  }
}

/**
 * 一个平台的账号池。
 *
 * \`accounts()\` 由宿主注入（返回带凭证的账号列表），这样池本身不关心凭证从哪来——
 * 无论来自浏览器登录、还是从上游客户端读来的副本，行为都一样。
 */
export class AccountPool {
  constructor(options = {}) {
    this.platform = options.platform
    this.now = options.now ?? Date.now
    this.states = new Map()
    /** 按账号的单飞续期锁。 */
    this.refreshing = new Map()
    /** 续期成功后的回调（宿主用来落盘）。 */
    this.onRefreshed = options.onRefreshed ?? (() => {})
  }

  stateOf(accountId) {
    let state = this.states.get(accountId)
    if (state === undefined) {
      state = emptyState(accountId)
      this.states.set(accountId, state)
    }
    return state
  }

  /** 这个账号现在能不能用。 */
  usable(accountId) {
    const state = this.stateOf(accountId)
    const now = this.now()
    return now >= state.disabledUntil && now >= state.coolUntil
  }

  /** 停用（认证失败：必须重新登录）。 */
  disable(accountId, reason) {
    const state = this.stateOf(accountId)
    state.disabledUntil = this.now() + AUTH_DISABLED_MS
    state.lastError = reason
  }

  /** 冷却（额度耗尽 / 上游故障 / 零散错误）。 */
  cooldown(accountId, ms, reason) {
    const state = this.stateOf(accountId)
    state.coolUntil = this.now() + ms
    if (reason !== undefined) state.lastError = reason
  }

  /**
   * 重新启用（用户重登成功 / 凭证被证明可用时调用）。
   * 与 noteSuccess 的区别：那个只清冷却，不清"认证失败停用"。重登换了新凭证后，
   * 旧的 disabledUntil 还在，账号会继续被判定为不可用。
   */
  enable(accountId) {
    const state = this.stateOf(accountId)
    state.disabledUntil = 0
    state.coolUntil = 0
    state.lastError = ''
    state.errorCount = 0
  }

  noteSuccess(accountId) {
    const state = this.stateOf(accountId)
    state.successes += 1
    state.errorCount = 0
    state.coolUntil = 0
    state.lastError = ''
    state.lastUsedAt = this.now()
  }

  /** 记录一次失败，并按类型决定要不要冷却/停用。 */
  noteFailure(accountId, kind, message) {
    const state = this.stateOf(accountId)
    state.failures += 1
    state.lastError = String(message ?? '').slice(0, 200)
    switch (kind) {
      case 'authentication':
        this.disable(accountId, state.lastError)
        break
      case 'hard_credit':
        this.cooldown(accountId, QUOTA_COOLDOWN_MS, state.lastError)
        break
      case 'server':
        this.cooldown(accountId, SERVER_COOLDOWN_MS, state.lastError)
        break
      case 'concurrency':
        // 并发撞墙是容量问题，不是账号坏了——不惩罚账号，否则会把好号踢出池。
        break
      case 'soft_rate':
        this.cooldown(accountId, 15_000, state.lastError)
        break
      case 'client':
      case 'not_found':
      case 'model_unavailable':
      case 'proxy_refused':
        // 请求本身 / 模型层面 / 转发层的问题，与账号无关：不计错误、不冷却、不停用。
        // 尤其 model_unavailable：一个坏模型名就能把一个好账号踢出池。
        // proxy_refused：转发层拒收签名请求，账号是健康的，停用它等于让用户永久 503。
        break
      default:
        state.errorCount += 1
        if (state.errorCount >= 3) this.cooldown(accountId, ERROR_COOLDOWN_MS, state.lastError)
        break
    }
  }

  /**
   * 按"可用 + 最少使用"排序候选账号。
   *
   * 被排除的账号（停用/冷却）不出现——调用方据此判断"是不是真的没号了"。
   */
  rank(accounts) {
    const usable = accounts.filter((account) => this.usable(account.id))
    usable.sort((a, b) => {
      const sa = this.stateOf(a.id)
      const sb = this.stateOf(b.id)
      // 从没用过的排最前（0 会自然胜出）。
      if (sa.lastUsedAt !== sb.lastUsedAt) return sa.lastUsedAt - sb.lastUsedAt
      return String(a.id).localeCompare(String(b.id))
    })
    return usable
  }

  /**
   * 确保某个账号的凭证是新鲜的。
   *
   * 单飞：同一账号并发调用只会真正续期一次，其余等待同一个结果。这一点是必须的——
   * refresh_token 一次性，两个并发续期会让后到的那个失败并**把账号弄坏**。
   */
  async ensureFresh(account, options = {}) {
    if (!needsRefresh(account.credential)) return account.credential
    const inflight = this.refreshing.get(account.id)
    if (inflight !== undefined) return inflight

    const run = (async () => {
      try {
        const next = await refreshCredential(this.platform, account.credential)
        await this.onRefreshed(account.id, next)
        // 续期成功证明凭证可用：清掉之前因失败累积的禁用/冷却。
        this.enable(account.id)
        return next
      } catch (error) {
        // 续期失败但当前 token 还没过期：**继续用旧的**。
        // 这是关键：一次续期失败（网络抖动、上游 5xx）不该让一个本来能成功的请求失败。
        const remaining = remainingMs(account.credential)
        if (remaining !== undefined && remaining > 0) return account.credential
        this.disable(account.id, '续期失败: ' + String(error).slice(0, 120))
        // 已经彻底不能用了：返回旧凭证让调用方自己撞 401（比抛错更好定位），
        // 但账号已被停用，下一次选号不会再选到它。
        return account.credential
      } finally {
        this.refreshing.delete(account.id)
      }
    })()

    this.refreshing.set(account.id, run)
    return run
  }

  /** 池的观测快照（卡片展示）。 */
  snapshot(accounts) {
    return accounts.map((account) => {
      const state = this.stateOf(account.id)
      const now = this.now()
      return {
        id: account.id,
        userName: account.userName,
        usable: now >= state.disabledUntil && now >= state.coolUntil,
        disabled: now < state.disabledUntil,
        cooling: now < state.coolUntil,
        cooldownRemainingMs: Math.max(0, state.coolUntil - now),
        // "还要等多久"必须同时看停用与冷却：停用是 1 小时量级，比冷却重要得多，
        // 只报 cooldownRemainingMs 会让卡片在停用状态上显示"还剩 0 分钟"。
        disabledRemainingMs: Math.max(0, state.disabledUntil - now),
        blockedRemainingMs: Math.max(0, Math.max(state.disabledUntil, state.coolUntil) - now),
        lastError: state.lastError,
        successes: state.successes,
        failures: state.failures,
        remainingMs: remainingMs(account.credential),
      }
    })
  }
}
