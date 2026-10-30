/**
 * 「卡片里勾选哪些模型」的存储形状。
 *
 * 语义（与 adapter.mjs 的过滤一致）：**每个平台一份清单；清单为空 = 该平台不限制**。
 * 也就是说这一列存的是"限制之后允许出现的模型"，不是"禁用的模型"。
 *
 * ## 为什么必须按平台分开存
 *
 * 1.3.3 及以前是一份**全局清单**（settings 键 enabledModels，扁平的 id 数组），两个平台共用。
 * 两个平台的模型 id 互不重叠，于是那份清单实际上在同时过滤两个平台：
 * 用户在码道栏"只留 3 个模型"，果办的 13 个模型会被一起从选择器里藏掉，而果办那一栏
 * 显示成"一个都没勾"。卡片本来就是分栏的，选择也必须分栏，否则界面和实际生效的东西对不上。
 *
 * normalizeEnabledModels 负责把旧的扁平数组按"这个 id 出现在哪个平台的目录里"拆到各平台。
 * 拆不掉的（目录当时还没拉到、或模型已下线）落到 fallbackPlatform，保证旧用户的选择不丢。
 *
 * @module dsh-huawei-connect/enabled
 */

export const ENABLED_PLATFORMS = ['codearts', 'officeace']

/** 是不是"每平台一份"的新形状。 */
export function isPlatformRecord(value) {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return false
  return ENABLED_PLATFORMS.some((platform) => Array.isArray(value[platform]))
}

function cleanList(value) {
  if (!Array.isArray(value)) return []
  const seen = new Set()
  const out = []
  for (const entry of value) {
    if (typeof entry !== 'string' || entry === '' || seen.has(entry)) continue
    seen.add(entry)
    out.push(entry)
  }
  return out
}

/** 某个平台当前生效的清单（空数组 = 不限制）。 */
export function enabledListFor(record, platform) {
  const value = record === null || typeof record !== 'object' ? undefined : record[platform]
  return cleanList(value)
}

/**
 * 把设置里的原值规范化成 { codearts: [...], officeace: [...] }。
 *
 * 接受三种输入：新的每平台对象、1.3.3 的扁平数组（旧）、以及任何坏值（当成两边都空 = 都不限制）。
 * catalogIds 是每个平台当前目录里的模型 id 数组，只用于给旧的扁平数组找归属。
 */
export function normalizeEnabledModels(raw, catalogIds, fallbackPlatform = ENABLED_PLATFORMS[0]) {
  if (isPlatformRecord(raw)) {
    const next = {}
    for (const platform of ENABLED_PLATFORMS) next[platform] = cleanList(raw[platform])
    return next
  }
  const flat = cleanList(raw)
  const next = {}
  for (const platform of ENABLED_PLATFORMS) next[platform] = []
  if (flat.length === 0) return next
  const catalog = catalogIds === null || typeof catalogIds !== 'object' ? {} : catalogIds
  for (const id of flat) {
    const owner = ENABLED_PLATFORMS.find(
      (platform) => Array.isArray(catalog[platform]) && catalog[platform].includes(id),
    )
    next[owner ?? fallbackPlatform].push(id)
  }
  return next
}

/** 只在某个平台这一栏里替换清单，其它平台原样保留。 */
export function withPlatformList(record, platform, list) {
  const next = {}
  for (const known of ENABLED_PLATFORMS) next[known] = enabledListFor(record, known)
  if (ENABLED_PLATFORMS.includes(platform)) next[platform] = cleanList(list)
  return next
}
