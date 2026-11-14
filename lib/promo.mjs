/**
 * 码道（DevCloud / CodeArts）的**活动福利**：查询 + 一键领取。
 *
 * ## 这条链路和插件里的模型调用完全不是一套鉴权
 *
 * 模型走的是 `snap-access.cn-north-4.myhuaweicloud.com` + IAM 的 `SDK-HMAC-SHA256` 签名，
 * 而活动福利是 DevCloud **网页端**的运营接口，认的是浏览器会话：
 *
 * ```
 * GET  /chat/PromptCenterService/v1/ops/delivery?channel=WEB   ← 活动列表（含能不能领）
 * POST /chat/PromptCenterService/v1/ops/events/trigger         ← 触发事件（如 user.login）
 * POST /chat/PromptCenterService/v1/ops/claim                  ← 领取
 * POST /chat/PromptCenterService/v1/ops/confirm                ← 确认到账
 * ```
 *
 * 也就是说：**IAM token 在这里没有用**，必须带上网页会话的 cookie（其中
 * `SessionID` / `devclouddevuibjJ_SESSION_ID` 负责登录态，`devclouddevuibjtcftk` 是客户端标识，
 * 它同时也作为 `cftk` 请求头单独发一遍）。所以这个功能是"粘贴一次 cookie，之后一键领取"，
 * 而不是"登录一次永久自动"。cookie 过期会返回未登录，插件把这句话原样告诉用户。
 *
 * ## 领取是"三步"而不是"一步"
 *
 * 前端自己在领取后立刻跟一个 `confirm`（把 CLAIMED 推到 CONFIRMED），实测确认这一步是有意义的：
 * 只 claim 不 confirm，记录会停在 CLAIMED。所以这里照抄前端的三步：trigger → claim → confirm。
 *
 * @module dsh-huawei-connect/promo
 */

/** DevCloud 网页端所在的 Region 域名。 */
export const PROMO_DEFAULT_ENDPOINT = 'https://devcloud.cn-north-4.huaweicloud.com'

/** 运营接口前缀（与前端 bundle 里 `ri = "/PromptCenterService/v1"` 一致）。 */
export const PROMO_PREFIX = '/chat/PromptCenterService/v1'

const BROWSER_UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/157.0.0.0 Safari/537.36'

const REQUEST_TIMEOUT_MS = 15_000

/**
 * 从一坨粘贴进来的东西里取出 cookie 串。
 *
 * 用户可能从 DevTools 复制的是 `Cookie: ...` 那一行、也可能只复制值、也可能整段请求头。
 * 这里全部接住：剥掉 "Cookie:" 前缀、把换行压成 "; "、丢掉空项。
 */
export function normalizeCookie(raw) {
  if (typeof raw !== 'string') return ''
  let text = raw.trim()
  if (text === '') return ''
  const header = /^cookie\s*:/i.exec(text)
  if (header !== null) text = text.slice(header[0].length)
  return text
    .split(/[\r\n]+/)
    .map((line) => line.trim())
    .filter((line) => line !== '')
    .join('; ')
}

/** 从 cookie 串里取某一个键（`devclouddevuibjtcftk` 要单独当 `cftk` 头发）。 */
export function cookieValue(cookie, name) {
  const pattern = new RegExp('(?:^|;\\s*)' + name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '=([^;]*)')
  const hit = pattern.exec(cookie)
  return hit === null ? '' : hit[1].trim()
}

/** 这份 cookie 里有没有登录态（缺了就一定未登录，不必发请求）。 */
export function cookieLooksSignedIn(cookie) {
  const text = normalizeCookie(cookie)
  if (text === '') return false
  // SessionID 与 devclouddevuibjJ_SESSION_ID 实测同时存在；任缺其一都还是让它去问服务端。
  return cookieValue(text, 'SessionID') !== '' || cookieValue(text, 'devclouddevuibjJ_SESSION_ID') !== ''
}

function requestHeaders(cookie) {
  const text = normalizeCookie(cookie)
  const cftk = cookieValue(text, 'devclouddevuibjtcftk')
  return {
    accept: 'application/json, text/plain, */*',
    'accept-language': 'zh-CN,zh;q=0.9',
    'content-type': 'application/json',
    'agent-type': 'PromptCenter',
    ...(cftk === '' ? {} : { cftk }),
    cookie: text,
    'x-codearts-doer-scenario-type': 'web',
    'x-language': 'zh-cn',
    'x-requested-with': 'XMLHttpRequest',
    'user-agent': BROWSER_UA,
  }
}

async function call(endpoint, cookie, path, { method = 'GET', body, signal } = {}) {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS)
  const onAbort = () => controller.abort()
  if (signal !== undefined) {
    if (signal.aborted) onAbort()
    else signal.addEventListener('abort', onAbort, { once: true })
  }
  try {
    const res = await fetch(endpoint + PROMO_PREFIX + path, {
      method,
      headers: requestHeaders(cookie),
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      signal: controller.signal,
    })
    const text = await res.text()
    let parsed
    try {
      parsed = text === '' ? undefined : JSON.parse(text)
    } catch {
      throw new Error('活动接口返回的不是 JSON（HTTP ' + res.status + '）：' + text.slice(0, 160))
    }
    if (parsed === undefined) throw new Error('活动接口返回空响应（HTTP ' + res.status + '）')
    // 前端把 code 0 / 200 都当成功；其余（含未登录）一律按失败返回，好让上层写人话。
    if (parsed.code !== 0 && parsed.code !== 200) {
      throw new Error(parsed.message || '活动接口返回 code ' + String(parsed.code))
    }
    return parsed.data
  } finally {
    clearTimeout(timer)
    if (signal !== undefined) signal.removeEventListener('abort', onAbort)
  }
}

/**
 * 把投递记录整理成卡片要用的形状。
 *
 * `claimable` 是**服务端**给的判断（它已经算过时间窗、每日限制、资格），不要自己再推一遍：
 * 例如「每日签到」在当天领过之后 claimable 就是 false，但 status 仍是 ELIGIBLE 的次日态。
 */
export function summarizeDelivery(data) {
  const items = Array.isArray(data?.items) ? data.items : []
  const rows = items.map((item) => ({
    campaignId: Number(item.campaignId),
    title: typeof item.title === 'string' ? item.title : String(item.campaignId),
    description: typeof item.description === 'string' ? item.description : '',
    claimable: item.claimable === true,
    status: typeof item.status === 'string' ? item.status : '',
    benefitAmount: Number(item.benefitAmount) || 0,
    benefitUnit: typeof item.benefitUnit === 'string' ? item.benefitUnit : '',
    pendingCount: Number(item.pendingCount) || 0,
    pendingTotalAmount: Number(item.pendingTotalAmount) || 0,
    startTime: item.extra?.startTime,
    endTime: item.extra?.endTime,
    triggerMode: item.extra?.triggerMode,
    triggerEvent: item.extra?.triggerEvent,
  }))
  const claimable = rows.filter((row) => row.claimable)
  return {
    serverTime: Number(data?.serverTime) || Date.now(),
    items: rows,
    claimable,
    claimableCount: claimable.length,
    claimableAmount: claimable.reduce((sum, row) => sum + (row.pendingTotalAmount || row.benefitAmount || 0), 0),
  }
}

/** 事件触发的幂等键：同一天同一个事件只该算一次，但重试要有新键，所以带上随机尾巴。 */
function eventKey(triggerEvent) {
  const day = new Date().toISOString().slice(0, 10).replace(/-/gu, '')
  return triggerEvent + '-' + day + '-' + Math.random().toString(36).slice(2, 8)
}

/**
 * 一个福利客户端。
 *
 * `cookie` 可以是字符串，也可以是 `() => string`（好让上层在用户改完 cookie 后立即生效，
 * 不必重建客户端）。
 */
export function createPromoClient(options = {}) {
  const { logger } = options
  const readCookie = typeof options.cookie === 'function' ? options.cookie : () => options.cookie
  const endpoint = (options.endpoint || PROMO_DEFAULT_ENDPOINT).replace(/\/+$/u, '')

  const withCookie = (signal) => {
    const cookie = normalizeCookie(readCookie())
    if (cookie === '') {
      throw new Error('还没有填写码道网页会话 cookie：卡片里粘贴一次 Cookie 请求头即可（活动福利用的是网页端会话，不是模型的 IAM token）')
    }
    if (!cookieLooksSignedIn(cookie)) {
      throw new Error('这份 cookie 里没有 SessionID，八成是复制少了；请在已登录的 DevCloud 页面重新复制完整的 Cookie 请求头')
    }
    return cookie
  }

  return {
    endpoint,

    /** 活动列表（服务端已算好 claimable）。 */
    async delivery(signal) {
      const cookie = withCookie(signal)
      return summarizeDelivery(await call(endpoint, cookie, '/ops/delivery?channel=WEB&_=' + Date.now(), { signal }))
    },

    /** 触发一个运营事件；`user.login` 是每日签到类活动的开关。 */
    async trigger(triggerEvent, signal) {
      const cookie = withCookie(signal)
      const data = await call(endpoint, cookie, '/ops/events/trigger', {
        method: 'POST',
        body: { triggerEvent, channel: 'WEB', idempotentKey: eventKey(triggerEvent) },
        signal,
      })
      logger?.debug?.('[huawei-connect] promo trigger ' + triggerEvent + ' ok')
      return data
    },

    /** 领取一个活动（`claim` 之后再 `confirm`，与前端一致）。 */
    async claim(campaignId, signal) {
      const cookie = withCookie(signal)
      const id = Number(campaignId)
      if (!Number.isInteger(id) || id <= 0) throw new Error('campaignId 不合法：' + String(campaignId))
      const claimed = await call(endpoint, cookie, '/ops/claim', {
        method: 'POST',
        body: { campaignId: id, idempotentKey: 'claim-' + id + '-' + Date.now(), channel: 'WEB' },
        signal,
      })
      let confirmed
      try {
        confirmed = await call(endpoint, cookie, '/ops/confirm', {
          method: 'POST',
          body: { campaignId: id },
          signal,
        })
      } catch (error) {
        // 领取本身已经成功，确认失败不该让上层以为没领到。
        logger?.warn?.('[huawei-connect] promo confirm ' + id + ' failed: ' + String(error))
        confirmed = undefined
      }
      return { campaignId: id, claimed, confirmed }
    },

    /**
     * 一键领取：先打一次 `user.login`（让"登录即得"类活动先变 ELIGIBLE），再逐个 claim。
     *
     * 返回每一单的结果，失败不中断后面的——福利是独立的，一个活动报错不该拖死其它的。
     */
    async claimAll(signal) {
      const results = []
      try {
        await this.trigger('user.login', signal)
      } catch (error) {
        results.push({ campaignId: 0, title: 'user.login', ok: false, error: String(error) })
      }
      const list = await this.delivery(signal)
      for (const row of list.claimable) {
        try {
          const outcome = await this.claim(row.campaignId, signal)
          results.push({
            campaignId: row.campaignId,
            title: row.title,
            ok: true,
            amount: row.pendingTotalAmount || row.benefitAmount,
            status: outcome.claimed?.status ?? 'CLAIMED',
            confirmed: outcome.confirmed !== undefined,
          })
        } catch (error) {
          results.push({ campaignId: row.campaignId, title: row.title, ok: false, error: String(error) })
        }
      }
      const after = await this.delivery(signal).catch(() => undefined)
      return {
        claimedCount: results.filter((entry) => entry.ok).length,
        claimedAmount: results.filter((entry) => entry.ok).reduce((sum, entry) => sum + (entry.amount ?? 0), 0),
        results,
        after,
      }
    },
  }
}
