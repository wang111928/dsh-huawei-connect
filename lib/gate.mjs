/**
 * 会话闸门：把"拒绝"变成"排队"。
 *
 * ## 为什么需要它
 *
 * 码道对**每个账号**只开 3 个并发会话，且一个会话要占用约 1 分钟才释放——**中途停止
 * 生成并不减免**（实测 \`TM.00001041 并发会话数已达上限(3个)\`）。这不是限流，是对
 * "同时开着几个客户端"的硬计数。
 *
 * 三个直接后果：
 *
 * 1. **并发请求必然撞墙**。DSH 一次对话可能触发多个模型请求（主对话、标题生成、
 *    压缩摘要），同时发出去就超了。
 * 2. **"停止后立刻重问"一定失败**。用户以为停了就释放了，实际上那个槽还要占满
 *    接近一分钟。
 * 3. **重试反而更糟**。撞墙后立刻重试只会拿到同一个 400，还把重试预算烧光。
 *
 * 所以本插件不把 400 交给用户，而是在本地维护一个**按账号计数**的闸门：同一个账号
 * 同时最多 N 个在飞，超出的排队等位；一次成功/失败后按实测的释放时间占位，再放行。
 *
 * ## 与 workbuddy 的做法对照
 *
 * workbuddy 那个上游是"渠道指纹"问题，与并发无关；这边的问题**纯粹是配额计数**，
 * 所以解法也必须是配额计数，而不是改请求内容。
 *
 * @module dsh-huawei-connect/gate
 */

/** 码道每账号的并发会话上限（实测：3）。 */
export const CODEARTS_SESSION_LIMIT = 3

/**
 * 一个会话从开始到被上游释放的保守估计。
 *
 * 实测约 50-60 秒，而且**停止生成不减免**，所以这里按 60 秒占位。保守取值只影响
 * "晚一点放行"，取小了就会放行太早、又撞墙。
 */
export const CODEARTS_SESSION_HOLD_MS = 60_000

const sleep = (ms, signal) =>
  new Promise((resolve) => {
    if (signal?.aborted === true) return resolve()
    const timer = setTimeout(finish, ms)
    timer.unref?.()
    function finish() {
      clearTimeout(timer)
      signal?.removeEventListener('abort', finish)
      resolve()
    }
    signal?.addEventListener('abort', finish, { once: true })
  })

/**
 * 一个账号的闸门状态。
 *
 * \`holds\` 是"还占着槽"的记录：每条有一个到期时间，到期即视为上游已释放。用到期时间
 * 而不是"请求结束就释放"，是因为上游**不**按请求结束释放——提前放行就是提前撞墙。
 */
class AccountGate {
  constructor(limit, holdMs, now) {
    this.limit = limit
    this.holdMs = holdMs
    this.now = now
    /** 到期时间戳列表，长度即在飞 + 冷却中的会话数。 */
    this.holds = []
  }

  /** 清掉已到期的占位，返回当前仍在占用的数量。 */
  prune() {
    const now = this.now()
    this.holds = this.holds.filter((expiresAt) => expiresAt > now)
    return this.holds.length
  }

  /** 有没有空槽。 */
  hasRoom() {
    return this.prune() < this.limit
  }

  /** 占一个槽。 */
  occupy() {
    this.holds.push(this.now() + this.holdMs)
  }

  /** 还要等多久才有空槽（0 表示立刻可用）。 */
  waitMs() {
    const used = this.prune()
    if (used < this.limit) return 0
    // 最早到期的那一个释放后就有空位。
    this.holds.sort((a, b) => a - b)
    return Math.max(0, this.holds[0] - this.now())
  }
}

/**
 * 一组账号的闸门。
 *
 * 选号时的语义是"**优先选还有空槽的账号**"：两个账号各有 3 个槽就是 6 个并发容量，
 * 这正是"在卡片里再登录一个账号"能根治并发问题的原因。全部排满时才等最早释放的那个，
 * 而不是直接失败。
 */
export class SessionGate {
  constructor(options = {}) {
    this.limit = options.limit ?? CODEARTS_SESSION_LIMIT
    this.holdMs = options.holdMs ?? CODEARTS_SESSION_HOLD_MS
    this.now = options.now ?? Date.now
    this.gates = new Map()
  }

  gateOf(accountId) {
    let gate = this.gates.get(accountId)
    if (gate === undefined) {
      gate = new AccountGate(this.limit, this.holdMs, this.now)
      this.gates.set(accountId, gate)
    }
    return gate
  }

  /**
   * 挑一个账号并在它的闸门上占位。
   *
   * 返回 \`{ accountId }\`；没有任何空槽时返回 \`{ waitMs }\`，调用方等这么久再试。
   * \`candidates\` 的顺序由调用方决定（它可能已经按偏好排过），这里只按"有空槽"过滤，
   * 保持同序——不重新排序，否则用户的账号优先级会被悄悄打乱。
   */
  async acquire(candidates, signal) {
    for (;;) {
      if (signal?.aborted === true) return { accountId: undefined }
      let earliest = Infinity
      for (const candidate of candidates) {
        const gate = this.gateOf(candidate)
        if (gate.hasRoom()) {
          gate.occupy()
          return { accountId: candidate }
        }
        earliest = Math.min(earliest, gate.waitMs())
      }
      // 一个候选都没有：交给调用方报"没有可用账号"，不要在这里死等。
      if (!Number.isFinite(earliest)) return { accountId: undefined }
      await sleep(Math.min(earliest, 5_000) + 50, signal)
    }
  }

  /** 观测用的快照（卡片上"会话槽位"那一行）。 */
  snapshot(accountIds) {
    return accountIds.map((accountId) => {
      const gate = this.gateOf(accountId)
      const used = gate.prune()
      return { accountId, used, limit: this.limit, waitMs: gate.waitMs() }
    })
  }
}
