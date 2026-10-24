/**
 * 设置卡片：两个平台一份 UI。
 *
 * ## 设计取舍
 *
 * 1. **一个卡片、两个分区**，而不是两张卡：用户往往两个平台都接，分开就要在两处
 *    来回对照积分，反而更难判断"现在该用哪个"。
 * 2. **积分放在最上面**且用大字号：这是用户最常看的那一行（"还能不能用"），
 *    也是最容易过期的一条信息（额度周期会重置）。
 * 3. **错误就地显示**，不弹全局提示：一个平台挂了不该遮住另一个平台的状态。
 *    额度失败只污染自己那一块，文案直接说"去重新登录"或"打开果办"。
 * 4. **模型勾选是草稿态**：本地先改，点保存才写回宿主。这样误点不会立刻改变
 *    模型选择器，用户可以先看清再提交。
 *
 * 绑定在 plugins.bundle.config 槽位上，与 dsh-codearts / dsh-connect-trae 一致，
 * 因此它出现在"设置 → 插件"里，不需要额外的导航入口。
 *
 * @module dsh-huawei-connect/client
 */

window.__ModuleLoader__.load({
  id: 'dsh-huawei-connect',
  factory(require) {
const name = 'dsh-huawei-connect-client'
const inject = ['slots', 'locale']
// React 在 factory 顶层取一次：组件渲染期 require('react') 会抛错（实测 dock-component-invoked 之后立刻断流）。
const ReactTop = require('react')

const zh = {
  title: '华为双平台',
  subtitle: '码道 CodeArts 与果办 OfficeAce 的模型，一起接进 DSH',
  sync: '同步登录态',
  signIn: '使用华为云账号登录',
  signingIn: '等待浏览器完成授权…',
  signInHint: '会打开浏览器让你在华为云登录，凭证会自动落到本插件。',
  signInFailed: '登录失败：{message}',
  signInTimeout: '登录超时，请重试。',
  openManually: '如果浏览器没有自动打开，请访问：',
  signOut: '移除',
  pool: '账号',
  poolOk: '可用',
  poolDisabled: '需要重新登录',
  poolCooling: '冷却 {mins} 分钟',
  poolExpires: '剩 {mins} 分钟',
  addAccount: '再加一个账号可以把并发容量翻倍',
  syncing: '正在同步…',
  refresh: '刷新模型',
  refreshing: '正在刷新…',
  credits: '积分余量',
  creditsUnavailable: '积分不可用：{message}',
  noAccount: '还没有同步到账号',
  plan: '{plan}',
  remainOfTotal: '剩 {remain} / 共 {total}',
  used: '已用 {used}',
  resetsAt: '额度周期至 {date}',
  models: '模型',
  modelsCount: '{n} 个',
  modelsSource: { upstream: '上游实时', cache: '上次缓存', seed: '内置种子' },
  save: '保存选择',
  saving: '保存中…',
  saved: '已保存',
  selectAll: '全选',
  selectNone: '全不选',
  enabledHint: '勾选要出现在 DSH 模型选择器里的模型；不勾选等同于全部开放。',
  syncResult: { ok: '已同步 {n} 个账号', failed: '同步失败：{message}' },
  packageUsage: '码道兼容包：剩 {remain} / 共 {total}',
  accounts: '账号',
  slots: '会话槽位',
  slotsDetail: '已占 {used} / {limit}',
  slotsBusy: '3 个槽位都占着——下一个请求会等其中之一的会话释放（约 1 分钟）。再登录一个账号可以把容量翻倍。',
  slotFree: '空闲',
  slotsHint: '码道对每个账号只开 3 个并发会话，每个会话要占用约 1 分钟——中途停止也不减免。',
  lastSync: '上次同步 {time}',
  openOfficeAce: '请先打开果办并保持登录，再点同步',
}

const en = {
  title: 'Huawei dual platform',
  subtitle: 'CodeArts 码道 and OfficeAce 果办 models in one place',
  sync: 'Sync sign-in',
  signIn: 'Sign in with Huawei Cloud',
  signingIn: 'Waiting for browser sign-in…',
  signInHint: 'A browser window opens for Huawei Cloud sign-in. The credential lands here automatically.',
  signInFailed: 'Sign-in failed: {message}',
  signInTimeout: 'Sign-in timed out — try again.',
  openManually: 'If the browser did not open, visit:',
  signOut: 'Remove',
  pool: 'Accounts',
  poolOk: 'ready',
  poolDisabled: 'needs sign-in',
  poolCooling: 'cooling {mins}m',
  poolExpires: '{mins}m left',
  addAccount: 'Add another account to raise concurrency',
  syncing: 'Syncing…',
  refresh: 'Refresh models',
  refreshing: 'Refreshing…',
  credits: 'Credits',
  creditsUnavailable: 'Credits unavailable: {message}',
  noAccount: 'No account synced yet',
  plan: '{plan}',
  remainOfTotal: '{remain} left of {total}',
  used: '{used} used',
  resetsAt: 'Quota period ends {date}',
  models: 'Models',
  modelsCount: '{n}',
  modelsSource: { upstream: 'live', cache: 'cached', seed: 'built-in' },
  save: 'Save selection',
  saving: 'Saving…',
  saved: 'Saved',
  selectAll: 'All',
  selectNone: 'None',
  enabledHint: 'Tick the models that should appear in the DSH picker. Nothing ticked means all are offered.',
  syncResult: { ok: 'Synced {n} account(s)', failed: 'Sync failed: {message}' },
  packageUsage: 'CodeArts package: {remain} left of {total}',
  accounts: 'Accounts',
  slots: 'Session slots',
  slotsDetail: '{used} / {limit} in use',
  slotsBusy: 'All {limit} slots busy — the next request waits for one to free (about a minute). Sign in a second account to double the capacity.',
  slotFree: 'Free',
  slotsHint: 'CodeArts allows 3 concurrent sessions per account, each held about a minute even after you stop.',
  lastSync: 'Synced {time}',
  openOfficeAce: 'Open OfficeAce and stay signed in, then sync again',
}

const CSS = [
  '.hwc-card{border:.5px solid var(--dsw-alias-settings-card-stroke);border-radius:var(--dsw-radius-lg);background:var(--dsw-alias-settings-card-fill);max-width:760px}',
  '.hwc-tabs{display:flex;gap:4px;margin:0 16px;padding:0 0 10px;border-bottom:1px solid var(--dsw-alias-border-l1,rgba(127,127,127,.24))}',
  '.hwc-tabs-item{appearance:none;font:inherit;cursor:pointer;border:0;background:transparent;padding:7px 11px;margin-bottom:-1px;border-bottom:2px solid transparent;color:var(--dsw-alias-label-tertiary,#999);font-size:13px;font-weight:600;line-height:20px;white-space:nowrap;transition:color .15s,border-color .15s}',
  '.hwc-tabs-item:hover{color:var(--dsw-alias-label-primary,CanvasText)}',
  '.hwc-tabs-itemOn{color:var(--dsw-alias-label-primary,CanvasText);border-bottom-color:var(--dsw-alias-brand-primary,#5686fe)}',
  '.hwc-header{align-items:flex-start;gap:12px;padding:14px 16px;display:flex}',
  '.hwc-headText{flex:1;flex-direction:column;gap:4px;min-width:0;display:flex}',
  '.hwc-title{color:var(--dsw-alias-label-primary);font-size:15px;font-weight:600;line-height:22px}',
  '.hwc-sub{color:var(--dsw-alias-label-tertiary);font-size:13px;line-height:20px}',
  '.hwc-toolbar{display:flex;gap:8px;padding:0 16px 12px}',
  '.hwc-section{border-top:.5px solid var(--dsw-alias-border-l2);margin:0 16px;padding:12px 0}',
  '.hwc-sectionHead{display:flex;align-items:baseline;gap:8px;margin-bottom:8px}',
  '.hwc-sectionName{color:var(--dsw-alias-label-primary);font-size:14px;font-weight:600}',
  '.hwc-badge{color:var(--dsw-alias-label-tertiary);font-size:12px}',
  '.hwc-creditRow{display:flex;align-items:baseline;gap:6px;flex-wrap:wrap}',
  '.hwc-credit{color:var(--dsw-alias-label-primary);font-size:26px;font-weight:600;font-variant-numeric:tabular-nums;letter-spacing:-.02em;line-height:32px}',
  '.hwc-creditMeta{color:var(--dsw-alias-label-tertiary);font-size:12px}',
  '.hwc-error{color:var(--dsw-alias-label-warning, #b45309);font-size:12px;line-height:18px}',
  '.hwc-models{display:flex;flex-wrap:wrap;gap:6px;margin-top:8px}',
  '.hwc-chip{border:.5px solid var(--dsw-alias-border-l3);border-radius:var(--dsw-radius-md);padding:3px 8px;font-size:12px;cursor:pointer;user-select:none}',
  '.hwc-chipOn{border-color:var(--dsw-alias-label-primary);color:var(--dsw-alias-label-primary)}',
  '.hwc-chipOff{color:var(--dsw-alias-label-tertiary)}',
  '.hwc-hint{color:var(--dsw-alias-label-tertiary);font-size:12px;line-height:18px;margin-top:8px}',
].join('')

function formatNumber(value) {
  if (typeof value !== 'number' || !Number.isFinite(value)) return '—'
  return value.toFixed(value >= 100 ? 0 : 2).replace(/\.00$/u, '')
}

/** 相对时间：超过一天就显示日期，"刚刚"比精确时间更好读。 */
function relativeTime(timestamp) {
  if (typeof timestamp !== 'number' || timestamp <= 0) return '—'
  const delta = Date.now() - timestamp
  if (delta < 60_000) return 'just now'
  if (delta < 3_600_000) return Math.floor(delta / 60_000) + 'm'
  if (delta < 86_400_000) return Math.floor(delta / 3_600_000) + 'h'
  return new Date(timestamp).toISOString().slice(0, 10)
}

/** 把一份平台的积分口径归一成 {total, used, remain}——两个平台的字段形状不同。 */
function creditNumbers(credits) {
  if (credits === undefined || credits === null) return undefined
  const group = credits['total']
  if (group !== undefined && group !== null && typeof group === 'object') {
    return { total: group['total'], used: group['used'], remain: group['remain'] }
  }
  return { total: credits['total'], used: credits['used'], remain: credits['remain'] }
}

function HuaweiConnectCard(props) {
  const { React, primitives } = props
  const { useEffect, useState, useCallback } = React
  const Button = primitives.Button
  const t = props.t

  const [status, setStatus] = useState(undefined)
  const [busy, setBusy] = useState('')
  const [draft, setDraft] = useState(undefined)
  const [notice, setNotice] = useState('')
  // tabs 分栏：当前激活的平台（码道/果办）。默认空 = 自动选第一个有数据的平台。
  const [tab, setTab] = useState('')

  const load = useCallback(async () => {
    try {
      const response = await fetch('/api/huawei-connect/status')
      if (!response.ok) throw new Error('status ' + response.status)
      const next = await response.json()
      setStatus(next)
      setDraft((previous) => previous ?? next.platforms[0]?.enabled ?? [])
    } catch (error) {
      setNotice(String(error))
    }
  }, [])

  useEffect(() => {
    void load()
    const timer = setInterval(() => void load(), 60_000)
    return () => clearInterval(timer)
  }, [load])

  /**
   * 开始一次浏览器登录。
   *
   * 授权页在新窗口打开，然后轮询 /login/status 直到拿到结果——登录本身发生在
   * 华为云的页面上，前端只能等。
   */
  const signIn = async (platform) => {
    setBusy('login:' + platform)
    setNotice('')
    try {
      const started = await call('/api/huawei-connect/login', { platform })
      if (typeof window !== 'undefined' && started.authorizeUrl) {
        window.open(started.authorizeUrl, '_blank', 'noopener')
      }
      const deadline = Date.now() + 5 * 60 * 1000
      for (;;) {
        await new Promise((resolve) => setTimeout(resolve, 2000))
        const state = await call('/api/huawei-connect/login/status?platform=' + encodeURIComponent(platform))
        if (state.last && state.last.ok) {
          setNotice(t('saved'))
          await load()
          break
        }
        if (state.last && state.last.ok === false) {
          setNotice(t('signInFailed', { message: state.last.message || '' }))
          break
        }
        if (Date.now() > deadline) {
          setNotice(t('signInTimeout'))
          break
        }
      }
    } catch (error) {
      setNotice(t('signInFailed', { message: String(error) }))
    } finally {
      setBusy('')
    }
  }

  const removeAccount = async (platform, id) => {
    setBusy('remove')
    try {
      await fetch('/api/huawei-connect/accounts?platform=' + encodeURIComponent(platform) + '&id=' + encodeURIComponent(id), { method: 'DELETE' })
      await load()
    } catch (error) {
      setNotice(String(error))
    } finally {
      setBusy('')
    }
  }

  const call = async (path, body) => {
    const response = await fetch(path, {
      method: body === undefined ? 'POST' : 'POST',
      headers: { 'Content-Type': 'application/json' },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    })
    if (!response.ok) throw new Error('HTTP ' + response.status)
    return response.json()
  }

  const onSync = async () => {
    setBusy('sync')
    setNotice('')
    try {
      const result = await call('/api/huawei-connect/sync')
      if (result.status) setStatus(result.status)
      const total = (result.codearts?.accounts ?? 0) + (result.officeace?.accounts ?? 0)
      setNotice(t('syncResult.ok', { n: total }))
    } catch (error) {
      setNotice(t('syncResult.failed', { message: String(error) }))
    } finally {
      setBusy('')
    }
  }

  const onRefresh = async () => {
    setBusy('refresh')
    setNotice('')
    try {
      const result = await call('/api/huawei-connect/refresh-models')
      if (result.status) setStatus(result.status)
    } catch (error) {
      setNotice(String(error))
    } finally {
      setBusy('')
    }
  }

  const onSave = async () => {
    setBusy('save')
    setNotice('')
    try {
      await call('/api/huawei-connect/enabled-models', { enabled: draft ?? [] })
      setNotice(t('saved'))
      await load()
    } catch (error) {
      setNotice(String(error))
    } finally {
      setBusy('')
    }
  }

  const toggle = (id) => {
    setDraft((previous) => {
      const current = previous ?? []
      return current.includes(id) ? current.filter((entry) => entry !== id) : [...current, id]
    })
  }

  const platforms = status?.platforms ?? []
  // tabs 分栏：默认选中第一个平台；若已有激活选择且平台仍存在则沿用。
  const activeTab = tab !== '' && platforms.some((p) => p.platform === tab)
    ? tab
    : (platforms.length > 0 ? platforms[0].platform : '')
  const activePlatform = platforms.find((p) => p.platform === activeTab)

  return React.createElement(
    'div',
    { className: 'hwc-card' },
    React.createElement('style', null, CSS),
    React.createElement(
      'div',
      { className: 'hwc-header' },
      React.createElement(
        'div',
        { className: 'hwc-headText' },
        React.createElement('div', { className: 'hwc-title' }, t('title')),
        React.createElement('div', { className: 'hwc-sub' }, t('subtitle')),
      ),
    ),
    React.createElement(
      'div',
      { className: 'hwc-toolbar' },
      React.createElement(Button, { onClick: onSync, disabled: busy !== '' }, busy === 'sync' ? t('syncing') : t('sync')),
      React.createElement(Button, { onClick: onRefresh, disabled: busy !== '' }, busy === 'refresh' ? t('refreshing') : t('refresh')),
    ),
    notice === '' ? null : React.createElement('div', { className: 'hwc-hint', style: { padding: '0 16px 8px' } }, notice),
    React.createElement(
      'div',
      { className: 'hwc-tabs', role: 'tablist' },
      platforms.map((platform) =>
        React.createElement(
          'div',
          {
            key: platform.platform,
            role: 'tab',
            'aria-selected': platform.platform === activeTab ? 'true' : 'false',
            className: 'hwc-tabs-item' + (platform.platform === activeTab ? ' hwc-tabs-itemOn' : ''),
            onClick: () => setTab(platform.platform),
          },
          platform.displayName,
        ),
      ),
    ),
    (activePlatform === undefined ? [] : [activePlatform]).map((platform) => {
      const numbers = creditNumbers(platform.credits)
      const models = platform.models?.models ?? []
      const enabledSet = new Set(draft ?? [])
      return React.createElement(
        'div',
        { className: 'hwc-section', key: platform.platform },
        React.createElement(
          'div',
          { className: 'hwc-sectionHead' },
          React.createElement('div', { className: 'hwc-sectionName' }, platform.displayName),
          platform.credits?.planName === undefined
            ? null
            : React.createElement('div', { className: 'hwc-badge' }, platform.credits.planName),
        ),
        platform.accounts.length === 0
          ? React.createElement('div', { className: 'hwc-error' }, t('noAccount'))
          : null,
        // 账号池：谁可用、谁在冷却、各自还剩多久。登录/移除都在这一块。
        React.createElement(
          'div',
          { className: 'hwc-models', style: { marginTop: 6 } },
          (platform.pool || []).map((member) =>
            React.createElement(
              'div',
              {
                key: member.id,
                className: 'hwc-chip ' + (member.usable ? 'hwc-chipOn' : 'hwc-chipOff'),
                title: member.lastError || member.id,
              },
              String(member.id).slice(0, 8) +
                ' · ' +
                (member.disabled
                  ? t('poolDisabled')
                  : member.cooling
                    ? t('poolCooling', { mins: Math.ceil((member.cooldownRemainingMs || 0) / 60000) })
                    : t('poolOk')),
            ),
          ),
        ),
        React.createElement(
          'div',
          { className: 'hwc-toolbar', style: { padding: '6px 0 0 0' } },
          React.createElement(
            Button,
            { onClick: () => void signIn(platform.platform), disabled: busy !== '' },
            busy === 'login:' + platform.platform ? t('signingIn') : t('signIn'),
          ),
        ),
        React.createElement('div', { className: 'hwc-hint' }, t('signInHint')),
        numbers === undefined
          ? platform.creditsError === undefined
            ? null
            : React.createElement('div', { className: 'hwc-error' }, t('creditsUnavailable', { message: platform.creditsError }))
          : React.createElement(
              'div',
              { className: 'hwc-creditRow' },
              React.createElement('div', { className: 'hwc-credit' }, formatNumber(numbers.remain)),
              React.createElement('div', { className: 'hwc-creditMeta' }, t('remainOfTotal', { remain: formatNumber(numbers.remain), total: formatNumber(numbers.total) })),
              React.createElement('div', { className: 'hwc-creditMeta' }, t('used', { used: formatNumber(numbers.used) })),
            ),
        Array.isArray(platform.sessions) && platform.sessions.length > 0
          ? React.createElement(
              'div',
              { className: 'hwc-creditMeta', style: { marginTop: 4 } },
              t('slots') + ':' + ' ' +
                platform.sessions
                  .map((slot) => t('slotsDetail', { used: slot.used, limit: slot.limit }))
                  .join(' · ') +
                (platform.sessions.every((slot) => slot.used >= slot.limit) ? ' — ' + t('slotsBusy') : ''),
            )
          : null,
        platform.packageUsage === undefined
          ? null
          : React.createElement(
              'div',
              { className: 'hwc-creditMeta', style: { marginTop: 4 } },
              t('packageUsage', { remain: formatNumber(platform.packageUsage.remain), total: formatNumber(platform.packageUsage.total) }),
            ),
        React.createElement(
          'div',
          { className: 'hwc-sectionHead', style: { marginTop: 12 } },
          React.createElement('div', { className: 'hwc-sectionName' }, t('models')),
          React.createElement('div', { className: 'hwc-badge' }, t('modelsCount', { n: models.length }) + ' · ' + t('modelsSource.' + (platform.models?.source ?? 'seed'))),
        ),
        React.createElement(
          'div',
          { className: 'hwc-models' },
          models.map((model) =>
            React.createElement(
              'div',
              {
                key: model.id,
                className: 'hwc-chip ' + (enabledSet.size === 0 || enabledSet.has(model.id) ? 'hwc-chipOn' : 'hwc-chipOff'),
                onClick: () => toggle(model.id),
                title: model.id,
              },
              model.name || model.id,
            ),
          ),
        ),
        React.createElement('div', { className: 'hwc-hint' }, t('enabledHint')),
      )
    }),
    React.createElement(
      'div',
      { className: 'hwc-toolbar', style: { paddingTop: 8, paddingBottom: 14 } },
      React.createElement(Button, { onClick: onSave, disabled: busy !== '' }, busy === 'save' ? t('saving') : t('save')),
      React.createElement(
        Button,
        { onClick: () => setDraft((status?.platforms ?? []).flatMap((p) => (p.models?.models ?? []).map((m) => m.id))) },
        t('selectAll'),
      ),
      React.createElement(Button, { onClick: () => setDraft([]) }, t('selectNone')),
    ),
  )
}


// ---- 客户端自检上报：渲染进程沙箱里拿不到控制台，把执行情况 POST 给宿主落盘 ----
function reportDiag(payload) {
  try {
    const body = JSON.stringify(payload)
    if (typeof navigator !== 'undefined' && typeof navigator.sendBeacon === 'function') {
      const blob = new Blob([body], { type: 'application/json' })
      if (navigator.sendBeacon('/api/huawei-connect/client-diag', blob)) return
    }
    void fetch('/api/huawei-connect/client-diag', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body,
      keepalive: true,
    }).catch(function () {})
  } catch (error) { /* 上报失败不影响 UI */ }
}

/**
 * 输入框积分条：input.left（工具行药丸，已有会话）+ input.dock（满行，新对话页兜底）。
 * 用宿主传入的 sessionId 防双显。React 用顶层 ReactTop（渲染期 require 会崩）。
 */
function HuaweiCreditDock(props) {
  const ReactHwc = ReactTop
  const useProjection = props.useProjection
  // input.dock 只在"没有 sessionId"（新对话页）时渲染；已有会话由 input.left 负责。
  if (props.name === 'conversation.input.dock' && (props.sessionId !== undefined && props.sessionId !== null)) return null

  let platform
  try {
    const selection = useProjection === undefined ? undefined : useProjection('modelSelection')
    // 运行时投影字段是 lastUsed/next（会话缓存层叫 pending），三个都兜住。
    const current = selection?.pending ?? selection?.next ?? selection?.lastUsed
    const provider = current?.provider
    if (provider === 'codearts' || provider === 'officeace') platform = provider
  } catch { /* projection 读不到就当作没选中，别让底栏崩 */ }

  const [numbers, setNumbers] = ReactHwc.useState(null)
  const alive = ReactHwc.useRef(true)
  ReactHwc.useEffect(() => {
    alive.current = true
    return () => { alive.current = false }
  }, [])

  ReactHwc.useEffect(() => {
    if (platform === undefined) { setNumbers(null); return undefined }
    reportDiag({ step: 'dock-active', platform: platform })
    const pull = async () => {
      try {
        const response = await fetch('/api/huawei-connect/status')
        if (!response.ok) { reportDiag({ step: 'dock-http-' + response.status, platform: platform }); return }
        const data = await response.json()
        const row = (data.platforms || []).find((entry) => entry.platform === platform)
        const credits = row === undefined ? undefined : row.credits
        if (credits === undefined || credits === null) { reportDiag({ step: 'dock-no-credits', platform: platform }); return }
        const group = credits.total
        const parsed = (group !== undefined && group !== null && typeof group === 'object')
          ? { remain: group.remain, total: group.total }
          : (typeof credits.total === 'number' ? { remain: credits.remain, total: credits.total } : null)
        if (parsed === null) reportDiag({ step: 'dock-parse-null', platform: platform, keys: Object.keys(credits) })
        if (alive.current) setNumbers(parsed)
      } catch (error) {
        reportDiag({ step: 'dock-fetch-failed', platform: platform, error: String(error) })
      }
    }
    void pull()
    const timer = setInterval(pull, 60000)
    return () => clearInterval(timer)
  }, [platform])

  if (platform === undefined || numbers === null) return null
  const remain = Math.round(numbers.remain || 0)
  // input.dock（新对话页）是满行容器，左边距对齐输入框；input.left（工具行药丸）不需要内边距。
  const isDock = props.name === 'conversation.input.dock'
  return ReactHwc.createElement(
    'div',
    {
      style: {
        display: 'inline-flex',
        alignItems: 'center',
        gap: 6,
        color: 'var(--dsw-alias-label-tertiary)',
        fontSize: 'var(--dsh-content-font-size-secondary, 13px)',
        whiteSpace: 'nowrap',
        ...(isDock ? { paddingLeft: 16, paddingTop: 2, paddingBottom: 2 } : {}),
      },
      title: (numbers.total !== undefined ? Math.round(numbers.total) : '?') + ' 总额中剩余 ' + remain,
    },
    ReactHwc.createElement('span', null, '积分 ' + new Intl.NumberFormat().format(remain)),
  )
}

function apply(ctx) {
  try {
    const namespace = 'settings.huawei-connect'
    ctx.effect(() => ctx.locale.register(namespace, { zh, en }), 'dsh-huawei-connect: settings copy')
    const t = ctx.locale.bind(namespace)
    // 卡片需要 React 与基础组件：DSH 的客户端 bundler 会把它们作为 external 注入。
    const React = require('react')
    const primitives = require('@deepseek-ai/dsh-client-ui-primitives')
    ctx.slots.inject('plugins.bundle.config', () =>
      ctx.slots.register({ name: 'plugins.bundle.config', key: 'dsh-huawei-connect', locale: namespace }, () =>
        React.createElement(HuaweiConnectCard, { React, primitives, t }),
      ),
    )
    // 输入框积分条：input.left（工具行药丸，已有会话）+ input.dock（满行，新对话页）。
    // 必须包一层注入 name：宿主不会把槽位名当 prop 传进来，防双显全靠它。
    try {
      ctx.slots.inject('conversation.input.left', () =>
        ctx.slots.register(
          { name: 'conversation.input.left', id: 'huawei-connect-credits', order: 21, locale: namespace, inject: () => ({ t }) },
          (props) => HuaweiCreditDock({ ...props, name: 'conversation.input.left' }),
        ),
      )
      ctx.slots.inject('conversation.input.dock', () =>
        ctx.slots.register(
          { name: 'conversation.input.dock', id: 'huawei-connect-credits', order: 21, locale: namespace, inject: () => ({ t }) },
          (props) => HuaweiCreditDock({ ...props, name: 'conversation.input.dock' }),
        ),
      )
      console.log('[dsh-huawei-connect] credit docks registered')
      reportDiag({ step: 'dock-registered' })
    } catch (dockError) {
      console.error('[dsh-huawei-connect] credit dock register failed:', dockError)
      reportDiag({ step: 'dock-register-failed', error: String(dockError) })
    }
  } catch (error) {
    // 卡片失败不能影响已经注册好的 provider。
    console.error('[dsh-huawei-connect] client card failed to load:', error)
  }
}

return { apply, inject, name }
  }
})
