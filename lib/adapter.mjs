/**
 * DSH 适配器：把 shim 暴露成 pi-ai 认得的 provider 路由。
 *
 * ## 这里有两个必须钉死的 compat 开关，否则会被上游拒绝
 *
 * pi-ai 在把 DSH 的消息翻译成 OpenAI 请求时，会按 \`model.compat\` 选择行为。默认值
 * 对**通用 OpenAI 端点**是合理的，对华为这两个端点则会产生上游不接受的请求：
 *
 * ### 1. \`supportsDeveloperRole: false\` —— 不设就必定被拒
 *
 * \`instructionRole = model.reasoning && compat.supportsDeveloperRole ? "developer" : "system"\`
 *
 * 非标准端点检测给出 \`supportsDeveloperRole: true\`，于是一个**带推理**的模型会让
 * pi-ai 把 system 提示词发成 \`role: "developer"\`。码道的实测反应是
 * \`InferHub.001001044.400 Message role cannot empty\` —— 整轮直接失败，而且这不是
 * 偶发：凡是带 system 提示词的请求都会中（DSH 每一轮都带）。
 *
 * 所以这里显式关掉。\`system\` 两个平台都接受（实测），这才是它们认的形状。
 *
 * ### 2. \`reasoning\` 如实声明 —— 影响思考内容能否透传
 *
 * pi-ai 只在 \`model.reasoning\` 为真时，才把 \`delta.reasoning_content\` 收进
 * thinking 块并回放成 \`assistant.reasoning_content\`。声明成 false 的后果是：思考
 * 过程被静默丢弃，多轮工具调用时上游拿不到它自己上一轮的推理，回答质量下降。
 *
 * 两个平台**都**会发 \`reasoning_content\`（实测），所以这里统一声明为 true，并把
 * 可选档位限制在它们真认的 \`low\`/\`high\`（其余档位置 null，pi-ai 会把 null 当
 * "不支持"从而不下发该字段）。
 *
 * 注意 \`reasoning: true\` 不会主动打开思考——上游本来就一直思考。它只控制 DSH
 * 怎么**读**与怎么**回放**。
 *
 * @module dsh-huawei-connect/adapter
 */
import { createProvider } from '@earendil-works/pi-ai'
import { openAICompletionsApi } from '@earendil-works/pi-ai/api/openai-completions.lazy'
import { PiAiAdapter } from '@deepseek-ai/dsh-llm-pi-ai'
import { resolveImageAttachmentAccess, resolveRetryPolicy } from '@deepseek-ai/dsh-llm'
import { CONTEXT_WINDOW } from './disguise.mjs'

/** 订阅/额度制，无法给出每 token 价格；报 0 比编一个数字诚实。 */
const NO_COST = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }

/** 空闲上限。华为的免费推理后端偶尔吐几个 token 后长时间静默，90s 让重试更早接管。 */
export const HUAWEI_STREAM_IDLE_TIMEOUT_MS = 90_000

/**
 * 图片请求的预算（全部交给 dsh-llm-pi-ai 执行）。
 *
 * `maxRequestImageBytes` 是**整个请求体里 base64 图片**的上限：历史里的每一张图都会
 * 被重新编码进每个请求，不设上限迟早顶爆网关。1 MiB/图 是归一化后的目标字节，
 * 4.19 MP 是像素预算——两者都是 dsh 的默认量级，码道实测能吃下这个尺寸。
 */
const REQUEST_IMAGE_BUDGETS = {
  maxRequestImageBytes: 20_971_520,
  /** 单请求图片张数上限；超出的旧图由宿主按 offload 规则降级成文字占位。 */
  maxRequestImages: 20,
  /** offload 的计数粒度（宿主每次腾出多少张旧图）。 */
  imageOffloadCountQuantum: 10,
  requestImagePixelBudget: 4_194_304,
  requestImageMaxBytes: 1_048_576,
}

/** 两个平台都认 system 角色、都不认 developer（实测）。 */
const COMPAT = {
  supportsDeveloperRole: false,
  supportsMidConvoSystemMessages: false,
  supportsReasoningEffort: false,
  requiresAssistantAfterToolResult: false,
  requiresReasoningContentOnAssistantMessages: false,
}

/**
 * pi-ai 的凭证平面在这里是空转的：真正的鉴权由 shim 完成，适配器只需要一个能通过
 * shim 校验的 bearer。
 */
const INERT_AUTH = {
  credentials: {
    async read() {
      return undefined
    },
    async list() {
      return []
    },
    async modify() {
      throw new Error('dsh-huawei-connect has no pi-ai credential lifecycle')
    },
    async delete() {},
  },
  authContext: {
    async env() {
      return undefined
    },
    async fileExists() {
      return false
    },
  },
}

/** 一个平台模型的元数据形状（与 codearts.mjs / officeace.mjs 返回的一致）。 */
function toPiModel(platform, model, shimBaseUrl, imagesUsable) {
  const contextWindow =
    Number.isInteger(model.contextWindow) && model.contextWindow > 0 ? model.contextWindow : CONTEXT_WINDOW
  return {
    id: model.id,
    name: model.name || model.id,
    api: 'openai-completions',
    provider: platform,
    baseUrl: shimBaseUrl + '/' + platform + '/v1',
    // 两个条件缺一不可：模型自己吃图，且宿主里有 durable attachment 服务能把它读出来。
    // 少了后者，PiAiAdapter 会在**每一轮带图请求**上抛
    // `pi-ai image input requires the durable attachment service`——这比"不支持图片"
    // 更糟：用户贴了图才炸，而且炸在请求发出之前，连会话自愈都够不着。
    input: model.supportsImages === true && imagesUsable ? ['text', 'image'] : ['text'],
    cost: NO_COST,
    // 如实声明：两个平台都发 reasoning_content，声明 false 会让思考内容被丢弃。
    reasoning: true,
    thinkingLevelMap: { off: null, minimal: null, low: 'low', medium: null, high: 'high', xhigh: null, max: null },
    contextWindow,
    maxTokens: model.maxTokens,
    compat: COMPAT,
  }
}

/**
 * 一个平台的适配器。
 *
 * catalog 是实时的：模型清单会在后台刷新，getModels() 每次都读最新值，所以用户在
 * 卡片里勾选/取消之后不必重启 DSH。
 */
/**
 * 图片输入要靠宿主的两项服务，插件自己造不出来：
 *
 * - `attachments`（durable attachment service）：会话里的图片是**引用**，字节留在
 *   附件库里。pi-ai 要用它把引用换成归一化后的请求图（尺寸/质量阶梯都在那边做）。
 * - `fs.processPathFromHostPath`：把附件在宿主上的绝对路径映射进工具执行世界，
 *   让模型/工具真能读到那张归一化后的图。
 *
 * `PiAiAdapter` 的 `resolveAttachments` / `resolveImageAccess` 就是这两个入口。
 * 不传它们，适配器对任何带图请求都直接抛
 * `pi-ai image input requires the durable attachment service`——1.3.5 之前正是这么
 * 坏的：shim 层把图转发得很正常，但图根本走不到 shim（宿主适配器先拒了）。
 */
export function createHuaweiAdapter(options) {
  const { platform, displayName, catalog, shim, enabledModels, services } = options

  /**
   * 附件服务在不在、够不够用。不在就把所有模型按纯文本声明，别让用户贴完图才炸。
   *
   * 这里连 `imageHostPath` 一起验：PiAiAdapter 的 `resolveImageAccess` 第一件事就是调它，
   * 服务残缺（被别的插件替换成桩）时提前降级，好过在请求路径上抛内部错误。
   */
  const imagesUsable = () => {
    try {
      const attachments = services?.attachments?.()
      return attachments !== undefined && typeof attachments.imageHostPath === 'function'
    } catch {
      return false
    }
  }

  const buildModels = () => {
    const baseUrl = shim.baseUrl()
    const allowed = enabledModels === undefined ? undefined : new Set(enabledModels())
    const usable = imagesUsable()
    return catalog
      .current()
      .filter((model) => allowed === undefined || allowed.size === 0 || allowed.has(model.id))
      .map((model) => toPiModel(platform, model, baseUrl, usable))
  }

  const provider = {
    ...createProvider({
      id: platform,
      name: displayName,
      auth: {
        apiKey: {
          name: displayName + ' shim',
          async resolve({ credential }) {
            const apiKey = credential?.key
            return apiKey === undefined || apiKey.length === 0 ? undefined : { auth: { apiKey }, source: displayName }
          },
        },
      },
      models: buildModels(),
      api: openAICompletionsApi(),
    }),
    getModels: () => buildModels(),
  }

  const profile = {
    provider: platform,
    displayName,
    streamIdleTimeoutMs: HUAWEI_STREAM_IDLE_TIMEOUT_MS,
    retryPolicy: resolveRetryPolicy(undefined, 'dsh-huawei-connect retryPolicy'),
    configuredMaxTokens: new Map(),
    modelErrors: new Map(),
    ...REQUEST_IMAGE_BUDGETS,
    piProvider: provider,
  }

  const adapter = new PiAiAdapter({
    profiles: () => new Map([[platform, profile]]),
    auth: INERT_AUTH,
    resolveApiKey: async () => shim.token(),
    resolveAttachments: () => services?.attachments?.(),
    resolveImageAccess: (attachments, ref) =>
      resolveImageAttachmentAccess(attachments, (hostPath) => services?.hostPathToProcessPath?.(hostPath), ref),
  })

  return { adapter, provider }
}
