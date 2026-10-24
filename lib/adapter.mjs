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
import { resolveRetryPolicy } from '@deepseek-ai/dsh-llm'
import { CONTEXT_WINDOW } from './disguise.mjs'

/** 订阅/额度制，无法给出每 token 价格；报 0 比编一个数字诚实。 */
const NO_COST = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }

/** 空闲上限。华为的免费推理后端偶尔吐几个 token 后长时间静默，90s 让重试更早接管。 */
export const HUAWEI_STREAM_IDLE_TIMEOUT_MS = 90_000

const REQUEST_IMAGE_BUDGETS = {
  maxRequestImageBytes: 20_971_520,
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
function toPiModel(platform, model, shimBaseUrl) {
  const contextWindow =
    Number.isInteger(model.contextWindow) && model.contextWindow > 0 ? model.contextWindow : CONTEXT_WINDOW
  return {
    id: model.id,
    name: model.name || model.id,
    api: 'openai-completions',
    provider: platform,
    baseUrl: shimBaseUrl + '/' + platform + '/v1',
    input: model.supportsImages === true ? ['text', 'image'] : ['text'],
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
export function createHuaweiAdapter(options) {
  const { platform, displayName, catalog, shim, enabledModels } = options

  const buildModels = () => {
    const baseUrl = shim.baseUrl()
    const allowed = enabledModels === undefined ? undefined : new Set(enabledModels())
    return catalog
      .current()
      .filter((model) => allowed === undefined || allowed.size === 0 || allowed.has(model.id))
      .map((model) => toPiModel(platform, model, baseUrl))
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
  })

  return { adapter, provider }
}
