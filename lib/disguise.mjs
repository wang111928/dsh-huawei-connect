/**
 * 渠道伪装（channel disguise）。
 *
 * ## 为什么需要它
 *
 * 上游两个平台都只服务"官方客户端"。它们识别的不是密钥（密钥是账号自己的），而是
 * **请求的形状**：谁在发请求、按什么协议、带哪些身份痕迹。dsh-connect-workbuddy 踩过
 * 的坑正是这一类：网关照自己的名单匹配请求内容，一旦发现"这不是我们的客户端发的"，
 * 就回一个业务码，而 displayTips 一律写成"渠道校验失败"——**它从不告诉你是谁触发的**。
 *
 * ## 实测结论（本插件在建时逐条核过，2026-10-23，两平台同一账号）
 *
 *   裸 user 消息                       码道 200 / 果办 200
 *   system 开头是 DSH 官方提示词       码道 200 / 果办 200
 *   system 开头是 Claude Code 身份句   码道 200
 *   assistant 历史里复述上述身份句     码道 200（被 3 会话上限挡过一次，复测通过）
 *
 * 也就是说：**华为这两条链路目前不按提示词内容拦截**。这与 workbuddy 完全不同，是本
 * 插件不去做"给提示词加中性头 / 插零宽空格"那套的理由——那是为另一个上游的具体缺陷写
 * 的补丁，抄过来只会改写用户的提示词而换不到任何好处。
 *
 * 真正需要伪装的是**请求形态**，而且每条都有实测依据：
 *
 * 1. **身份头**。码道的模型清单接口不带 Agent-Type 直接 400
 *    （TM.00001001 请求头Agent-Type为空），值必须是 PromptCenter——官方桌面端自己
 *    用的那个。带上之后 200。聊天接口同样接受这个头。
 * 2. **协议形状**。码道的 /api/v2/chat/completions 虽然长得像 OpenAI，但它严格校验
 *    字段：多余的 temperature/top_p/response_format 会触发 InferHub.001001005.400，
 *    而官方客户端从不发那些。所以出站体必须**只保留**官方会发的字段。
 * 3. **不要自报家门**。两条链路都没有理由让上游看见 DeepSeek Harness、插件名或本机
 *    路径。默认出站头里不含任何这类字样。
 * 4. **并发上限**。码道对**每个账号**只有 3 个并发会话，且一个会话要占用约 1 分钟才
 *    释放——**中途停止生成并不减免**。这是 dsh-codearts README 里记的同一个事实，
 *    本插件把它当成一等公民：撞上就排队重试，而不是把 400 直接甩给用户。
 *
 * ## 本模块做什么、不做什么
 *
 * 做：把请求体裁剪成官方形状、给上游带官方身份头、把失败按"请求的错 / 账号的错 /
 * 一时的排队"分类（分类错了会导致换号、退避、重试全做错）。
 *
 * 不做：篡改用户的提示词内容、伪造设备指纹、伪造客户端签名。前者没有实测依据支撑
 * （见上表），后两者属于另一回事，不在本项目范围内。
 *
 * @module dsh-huawei-connect/disguise
 */

/**
 * 码道聊天端点接受的字段白名单。
 *
 * 这份清单是**实测**得来的：官方 AgentKernel 只发这些，多一个就会被
 * InferHub.001001005.400 拒掉。新增字段前请先用 probe 脚本确认上游确实接受。
 */
const CODEARTS_CHAT_FIELDS = new Set([
  'model',
  'messages',
  'stream',
  'max_tokens',
  'tools',
  'tool_choice',
  'reasoning_effort',
])

/**
 * 把 OpenAI 形态的请求体裁成码道端点接受的形状。
 *
 * 三条硬规则（全部实测）：
 * 1. stream 必须是 true——上游只发 SSE，非流式会挂住。
 * 2. tool_choice 只接受字符串形态（auto/none）；DSH/OpenAI 的
 *    {"type":"function",...} 对象形态会被拒，这里压成字符串。
 * 3. 白名单外的字段一律丢弃，且**不改写内容**——消息体逐字节保留。
 *
 * 返回新对象；入参不被修改。
 */
export function prepareCodeArtsBody(raw) {
  const out = {}
  for (const [key, value] of Object.entries(raw)) {
    if (!CODEARTS_CHAT_FIELDS.has(key)) continue
    if (value === undefined || value === null) continue
    out[key] = value
  }
  out['stream'] = true

  if (Array.isArray(out['tools']) && out['tools'].length === 0) delete out['tools']

  const toolChoice = out['tool_choice']
  if (typeof toolChoice === 'object' && toolChoice !== null) {
    const type = toolChoice['type']
    out['tool_choice'] = type === 'none' ? 'none' : 'auto'
  }
  if (out['tool_choice'] === undefined) delete out['tool_choice']
  if (out['tools'] === undefined) delete out['tool_choice']

  clampOutputTokens(out, CODEARTS_MAX_OUTPUT_TOKENS)
  return out
}

/**
 * 把 max_tokens 钳到上游真能接受的值。
 *
 * 实测有两个坑：
 *  1. 超过硬上限会**在流内**报参数非法 —— 已经开流，无法重放，等于这次对话直接废掉。
 *  2. 上游标的上下文长度与"单次输出上限"是两回事，不能拿后者当前者。
 *
 * 钳制是**静默**的：报错给用户没有任何价值（他不知道为什么），而钳到一个一定成功的
 * 值能让这次对话正常完成。上限之外的部分由 DSH 的续写/压缩处理。
 */
function clampOutputTokens(out, ceiling) {
  const value = out['max_tokens']
  if (typeof value !== 'number' || !Number.isFinite(value)) return
  if (value > ceiling) out['max_tokens'] = ceiling
  if (value < 1) out['max_tokens'] = 1
}

/** 官方桌面端的出站身份头（码道）。Agent-Type 是硬要求，不是可选。 */
export function codeArtsHeaders() {
  return {
    'Agent-Type': 'PromptCenter',
    'Content-Type': 'application/json',
  }
}

/**
 * 果办模型网关已经是标准 OpenAI 兼容端点，**不需要**裁剪字段——但同样只保留上游认
 * 得的那些，避免把 DSH 私有的字段（如 stop、response_format）发上去换一个 400。
 */
const OFFICEACE_CHAT_FIELDS = new Set([
  'model',
  'messages',
  'stream',
  'max_tokens',
  'temperature',
  'top_p',
  'tools',
  'tool_choice',
  'reasoning_effort',
])

export function prepareOfficeAceBody(raw) {
  const out = {}
  for (const [key, value] of Object.entries(raw)) {
    if (!OFFICEACE_CHAT_FIELDS.has(key)) continue
    if (value === undefined || value === null) continue
    out[key] = value
  }
  out['stream'] = true
  if (Array.isArray(out['tools']) && out['tools'].length === 0) {
    delete out['tools']
    delete out['tool_choice']
  }
  clampOutputTokens(out, OFFICEACE_MAX_OUTPUT_TOKENS)
  return out
}


/**
 * 上游硬上限（全部实测，2026-10-23）。
 *
 * 这些不是"保守估计"，是**边界**：超过就报 `InferHub.001001005.400 The request param
 * is invalid`（码道）或 `ModelArts.81001 InvalidParamException`（果办），而且这两种
 * 错误在流内出现、此时已经开流，无法重放。所以必须在**发送前**钳住。
 *
 * 实测数据：
 *   - 码道 max_tokens：65536 通过，65537 立刻 400。上限就是 65536。
 *   - 果办 max_tokens：131072 通过，200000 拒绝。
 *   - 上下文：码道 1.4M 字符、果办 1.2M 字符仍 200（远大于任何实际会话）。
 */
export const CODEARTS_MAX_OUTPUT_TOKENS = 65536
export const OFFICEACE_MAX_OUTPUT_TOKENS = 131072

/**
 * 模型上下文窗口的**对外声明值**。
 *
 * 这个数字要同时满足两个约束，少一个就出事：
 *
 * ### 约束一：必须让 DSH 的压缩器算得出预算
 *
 * compaction-basic 的算法（源码实测）：
 *
 * ```
 * messageBudget  = contextWindow - reservedCompletionTokens
 * pressureBudget = messageBudget  - headroomTokens        // headroom 默认 65536
 * threshold      = min(contextWindow * 0.8, pressureBudget)
 * ```
 *
 * `pressureBudget <= 0` 会**抛 TargetPressureConfigError**，也就是压缩彻底失效——
 * 会话一路长到把上游撑爆，然后每一轮都失败。
 *
 * 这条约束是最容易踩的：131072 - 65536 - 65536 = 0，看起来"标称 128k 很合理"，
 * 实际正好把压缩预算吃干净。所以窗口必须比 `maxTokens + headroom` 明显大。
 *
 * ### 约束二：不能超过上游真能吃下的量
 *
 * 实测（2026-10-23，GLM-5.2）：
 *   约 62.5 万 token  -> 200 OK
 *   约 125 万 token    -> HTTP 504 Backend timeout
 *   约 250 万 token    -> InferHub.001001005.400 参数非法
 *
 * 也就是说上游大致能到 60 万 token 量级，但**大输入要等很久**（504 是网关超时，
 * 不是拒绝）。声明得越接近这个天花板，用户越容易撞上超时。
 *
 * ### 取值
 *
 * 262144（256k）是两者的折中：压缩预算 131072 很充裕，距离实测的 ~60 万天花板
 * 也留了一倍余量，大会话不会因为"窗口声明得太满"而长时间卡住。
 *
 * 代入 compaction-basic 的默认值验算（headroom 65536、ratio 0.8、retainRatio 0.16）：
 *
 *   messageBudget  = 262144 - 65536 = 196608
 *   pressureBudget = 196608 - 65536 = 131072   > 0   ✓
 *   threshold      = min(209715, 131072) = 131072    ✓
 *   retainTokens   = 196608 * 0.16 = 31457    < threshold  ✓
 *
 * 三条校验全过。**131072 会失败**（pressureBudget = 0，压缩器直接抛错），这是本插件
 * 最初的错误取值，已被实测证伪，不要再改回去。
 */
export const CONTEXT_WINDOW = 262144

/**
 * 上游失败的分类。分错会导致换号/退避/重试全做错，所以逐条按实测文案判。
 *
 *   authentication  凭证失效：只能重新登录，重试无意义
 *   hard_credit     积分/额度耗尽：账号级硬墙
 *   concurrency     撞上并发会话上限（3 个）：等一等就能过，**不是**账号的错
 *   queued          上游排队：换号也没用，等
 *   soft_rate       短时限流：退避重试
 *   client          请求本身不合法：换号/重试都是浪费
 *   not_found       模型不存在或未开通
 *   server          上游故障
 */

/**
 * 从一段上游错误文本里判定失败类型。
 *
 * 码道的业务码与文案（实测）：
 *   TM.00001041 "并发会话数已达上限(3个)"        -> concurrency
 *   InferHub.001001005.400 参数非法              -> client
 *   APIG.0301 decrypt token fail                 -> authentication
 *
 * 果办（APIG 网关）：
 *   APIG.1009 AppKey/AppSecret 无效              -> authentication
 *   APIGW.0301 token 解密失败                    -> authentication
 *
 * 判不出来时按 HTTP 状态兜底，仍判不出来才算 client——那是唯一"既不换号也不退避"的
 * 分类，宁可保守也不要误伤账号。
 */
export function classifyUpstreamFailure(status, text) {
  const message = String(text ?? '').trim().slice(0, 600)

  if (/并发会话数已达上限|concurrency limit|TM\.00001041/u.test(message)) {
    return { kind: 'concurrency', status, message }
  }
  if (/排队|queue|please wait/iu.test(message) && status < 500) {
    const position = /(?:position|第)\s*(\d+)/u.exec(message)
    const length = /(?:of|共)\s*(\d+)/u.exec(message)
    return {
      kind: 'queued',
      status,
      message,
      ...(position === null ? {} : { queuePosition: Number(position[1]) }),
      ...(length === null ? {} : { queueLength: Number(length[1]) }),
    }
  }
  // 中间转发层明确说"我不转这种签名请求"：这不是凭证问题。换号、重登、续期都修不了它，
  // 唯一正确的事是**如实报出来**，并且绝不能让账号背这个锅。
  // 实测文案（码道 APIG 的 SDK-HMAC-SHA256 签名请求被挡）：
  //   {"type":"signed_request_requires_resign","code":"bili_resign_unavailable",
  //    "message":"... refused to forward this sdk-hmac-sha256 (...)-signed request"}
  // 必须排在下面的认证正则与 401/403 兜底**之前**：落进兜底会把一个健康的账号停用一小时，
  // 而停了之后池又没有任何自愈路径（见 pool.rank 与 index.mjs 的 explainUnavailable）。
  if (/signed_request_requires_resign|resign_unavailable|refused to forward|require[sd]?[ _]resign/iu.test(message)) {
    return { kind: 'proxy_refused', status, message }
  }
  if (
    /APIG\.0301|APIG\.1009|APIGW\.0301|decrypt token fail|x-auth-token not found|AppKey or AppSecret is invalid|invalid[ _]credential|unauthori[sz]ed/iu.test(
      message,
    )
  ) {
    return { kind: 'authentication', status, message }
  }
  if (/积分|额度|credits?\s*(?:exhaust|insufficient)|quota|余额不足|balance insufficient/iu.test(message)) {
    return { kind: 'hard_credit', status, message }
  }
  // 实测到的参数类拒绝（都是"请求形状不对"，换号/重试都无意义）：
  //   InferHub.001001005.400  参数非法（max_tokens 超限、多余字段）
  //   InferHub.001001044.400  Message role cannot empty（developer 角色）
  //   ModelArts.81001         InvalidParamException（果办参数校验）
  //   ModelArts.81114.429     TPM 限流（这个例外，属于限流）
  if (/ModelArts\.81114|rate limit is \d+ tokens per minute/iu.test(message)) {
    return { kind: 'soft_rate', status, message }
  }
  if (
    /InferHub\.001001005|InferHub\.001001044|ModelArts\.81001|TM\.00001001|param is invalid|参数非法|invalid[ _]param|Message role cannot empty/iu.test(
      message,
    )
  ) {
    return { kind: 'client', status, message }
  }
  // TM.0000100\d 原来挂在这里，是错的：实测 TM.00001001 表示**请求形状不合法**
  //   - 模型清单不带 Agent-Type："TM.00001001 请求头Agent-Type为空"（本文件上方第 1 条）
  //   - 聊天 model 名不对："{\"error_code\":\"TM.00001001\",\"error_msg\":\"参数model不合法\"}"（出进程实测）
  // 当限流处理会让"请求形状不对"变成 15 秒冷却 + 退避重试 + 换号，三件事全是白费，
  // 所以它归下面的 client（唯一的"既不换号也不退避"分类）。
  if (/rate limit|too many requests/iu.test(message)) {
    return { kind: 'soft_rate', status, message }
  }
  // "这个模型这个账号用不了"：换号、重登、续期、冷却全都无解，只能换模型。
  // 上游会把它挂在 403 **或者** 404 上（81004 没开权限 / 81009 模型不存在 /
  // 81010 没有可用后端），所以按报文判定，不看状态码——只看状态码的话，403 会被
  // 下面当成限流反复冷却，404 会被当成 not_found 丢掉"模型不可用"这个关键信息。
  if (
    /ModelArts\.81004|ModelArts\.81009|ModelArts\.81010|do not have access|not authorized for|Invalid model|No available backend/iu.test(
      message,
    )
  ) {
    return { kind: 'model_unavailable', status, message }
  }
  // 只有 401 才是"凭证真不行"。403 在华为此类网关下绝大多数是策略 / 签名 / 参数层面的
  // 拒绝（本文件上方的 signed_request_requires_resign 就是实测到的一例），把它当成认证
  // 失败会停用一个完全健康的账号整整一小时；而停用之后账号被排除在候选之外，
  // 池里的自动续期再也够不到它——**一小时静默黑洞，只能重启才恢复**。
  // 所以裸 403 按可恢复的限流处理：15 秒冷却 + 允许换号再试一次。
  if (status === 401) return { kind: 'authentication', status, message }
  if (status === 403) return { kind: 'soft_rate', status, message }
  if (status === 402) return { kind: 'hard_credit', status, message }
  // 模型清单 / 模型可用性的判定已经在上面的 model_unavailable 里做完了，这里只剩
  // "这个路径或这个模型名根本不存在"。
  if (status === 404) return { kind: 'not_found', status, message }
  if (status === 429) return { kind: 'soft_rate', status, message }
  if (status >= 500) return { kind: 'server', status, message }
  return { kind: 'client', status, message }
}

/**
 * 一次失败值不值得换一个账号再试。
 *
 * concurrency 换号确实有用（另一个账号有自己的 3 个槽），但前提是真有第二个账号；
 * queued 是模型级排队，换号一样要排；client/not_found 换号纯属浪费一次真实额度。
 */
export function warrantsAccountRotation(kind) {
  // model_unavailable：模型层面的问题，换号也解决不了，绝不能因此停用账号。
  if (kind === 'model_unavailable') return false
  return (
    kind === 'concurrency' ||
    kind === 'authentication' ||
    kind === 'hard_credit' ||
    kind === 'soft_rate' ||
    kind === 'server'
  )
}

/** 同类失败在同一账号上重试是否可能成功（用于决定"等一等再发"）。 */
export function warrantsRetry(kind) {
  return kind === 'concurrency' || kind === 'queued' || kind === 'soft_rate' || kind === 'server'
}

/**
 * 建议的退避时长（毫秒）。
 *
 * 不同失败的真实成因差着量级，用同一个数字要么等太久、要么等太短：
 *   - concurrency：上游会话约 60 秒才释放，等短了必再撞。
 *   - soft_rate（TPM 限流）：实测是"每分钟 2000 万 token"级别的窗口，等 5 秒不够，
 *     但也不必等满一分钟。
 *   - server：指数退避的起点。
 *   - queued：上游自己会给位置，短等待即可。
 */
export function backoffMs(kind) {
  switch (kind) {
    case 'concurrency':
      return 60_000
    case 'soft_rate':
      return 15_000
    case 'queued':
      return 3_000
    case 'server':
      return 2_000
    default:
      return 0
  }
}

/**
 * 出站给宿主的文案里不允许出现独立的 `401` / `403`。
 *
 * 宿主的失败分类器（@deepseek-ai/dsh-llm-pi-ai 的 classifyPiAiError）**第一条**就是
 * `/\b(?:401|403)\b/.test(message) → "AUTH"`，而 AUTH 在聊天 UI 上被渲染成
 * 「API 密钥无效」。pi-ai 还会把 HTTP 状态码拼进报文（`formatProviderError` 产出
 * `"<status>: <body>"`），所以**任何** 401/403 响应都会变成"密钥无效"。
 *
 * 我们的失败报文里嵌着上游原文，而 bili 的拒签原文里同时出现 403（它自己的状态码）
 * 与 401（它引用的上游 APIG.0301 文案）——嵌进去就等于把真实原因换成"密钥无效"。
 * 诊断信息不必牺牲：池的 lastError、设置卡片、插件日志都还是原文，只有**发给宿主
 * 的那一份**把这两个魔数抹成 4xx。
 *
 * 注意：kind === 'authentication' 的 401 是**真的**凭证失败，那条路径不做替换。
 */
export function hostSafeText(text) {
  return String(text ?? '').replace(/\b(?:401|403)\b/gu, '4xx')
}

function describeFailureRaw(failure, model) {
  const suffix = model === undefined || model === '' ? '' : '（模型 ' + model + '）'
  switch (failure.kind) {
    case 'concurrency':
      return '码道对每个账号只开 3 个并发会话，且一个会话要占用约 1 分钟才释放——中途停止生成也不减免。稍等一会儿再发，或在卡片里再登录一个账号。' + suffix
    case 'queued':
      return '上游正在排队' + (failure.queuePosition === undefined ? '' : '（第 ' + failure.queuePosition + ' 位）') + '，稍后重试即可。' + suffix
    case 'authentication':
      return '登录态已失效，请在设置卡片里重新登录。' + suffix
    case 'hard_credit':
      return '积分/额度不足。' + suffix
    case 'soft_rate':
      return '上游限流，稍等片刻再试。' + suffix
    case 'not_found':
      return '该模型当前未对账号开放。' + suffix
    case 'server':
      return '上游服务暂时不可用。' + suffix
    case 'proxy_refused':
      return '请求在转发这一层被拦下了：这一跳拒绝转发本插件的 SDK-HMAC-SHA256 签名请求（上游回 ' +
        (failure.status === undefined ? '?' : failure.status) + '），账号和凭证本身没有问题，重登也不会改变结果。原始响应：' +
        failure.message
    default:
      return '上游拒绝了这次请求：' + failure.message
  }
}

/** 面对用户的一句话解释。分类已经做对了，文案不该再把用户引向"账号被封"。 */
export function describeFailure(failure, model) {
  const text = describeFailureRaw(failure, model)
  // 认证失败以外的任何原因都不该以 401/403 的形态到达宿主，否则会被显示成"密钥无效"。
  return failure.kind === 'authentication' ? text : hostSafeText(text)
}
