# Changelog

## 1.3.4

### 修复：模型勾选列表——点一行会把其它行的勾全抹掉

用户实测复现（原话：「我选的时最上面的模型，但你其他所有模型前面的对号被取消」）：

1. 勾选清单为空时，宿主与适配器把「空」理解成**不限制（全部开放）**，这是设计；
   但卡片把空清单渲染成了「每一行都打着勾」。
2. 点击某一行的处理只是普通的 toggle，于是点第一行（它显示着 ✓）其实是在**创建**
   一份「只包含这一行」的清单——其它行的 ✓ 随之消失。
3. 结果既不像列表、也不像选择：看到的是「只剩一个」，实际生效的也是「只剩一个」。

修复：

- 勾只代表**明确勾上**的模型。空清单在该栏显示状态行「不限制：该平台的全部模型都开放」，
  不再假装全部勾选。点一行只改这一行。
- 按钮语义写清楚：`全选` → `全部勾选`，`全不选` → `不限（全部开放）`。

### 修复：勾选清单从「一份全局」改成「按平台一份」

这是同一个 bug 的另一半，也是分栏卡片的必然结果：两个平台的模型 id 互不重叠，
一份全局清单等于**同时过滤两个平台**——在码道栏只留几个模型，果办的 13 个模型会被
一起从模型选择器里藏掉，而果办那一栏显示成「一个都没勾」。现在：

- settings 里的 `enabledModels` 是 `{ codearts: [...], officeace: [...] }`；
  某一栏为空 = 该栏不限制。
- 旧的扁平数组按「这个 id 属于哪个平台的目录」自动迁移；两个目录里都找不到的 id 落到
  码道，不丢用户的既有选择（迁移逻辑见 `lib/enabled.mjs`）。
- 保存一次写整份记录：切到另一栏再按保存不会丢掉上一栏的改动。

### 验证

- `node _hwc_models_smoke.mjs` 14/14：真加载客户端模块、真点行、真读点击之后的 className
  与勾，覆盖「点最上面一行后其余 9 行保持勾着」「果办的草稿不因码道的点击而改变」
  「保存写回整份记录」。用户上报的那一幕被钉进断言：`全部勾选` → 点第一行 → 其余仍在勾选态。
- `node _hwtest_enabled.mjs` 21/21：形状识别、旧数组迁移、未知 id 兜底、清洗、幂等。

## 1.3.3

### 修复：码道「本轮运行失败 API 密钥无效」——错在中间转发层，而错因被宿主改写成了密钥

实测链条（每一步都在本机复现过）：

1. 码道请求是 `SDK-HMAC-SHA256` 签名的。
2. 本机装的 `billion-context`（bili）在宿主进程里 patch 了 `fetch`，遇到签名请求就**拒收**：
   `403` + `{"type":"signed_request_requires_resign","code":"bili_resign_unavailable", ...}`。
   它默认的策略是「找凭据重签」而不是「原样转发」，而这条链路上没有可用的签名凭据。
3. shim 按设计把上游响应原文嵌进了报错文本。
4. 宿主的错误分类 `classifyPiAiError` 第一条规则就是「报文里出现独立 401/403 → `AUTH`」，
   这条转发层的回绝因此被判定为凭证问题。
5. 聊天界面把 `AUTH` 渲染成 `message.failure.auth` = **「API 密钥无效」**。

所以用户看到的「密钥无效」既不是密钥问题，也不是本插件单独能修掉的问题。

### 修复内容

- **真正让码道通起来的一步在 bili 侧**：给内置签名方案开「原样放行」。实测该方案的内置 id 是
  `sdk-hmac-sha256`（不是 `hmac-sha256`），配置写在
  `%USERPROFILE%\.config\billion-context\billion-context.json`：
  `{"resign":{"sdk-hmac-sha256":{"passthrough":true}}}`（等价于环境变量
  `BILI_RESIGN_PASSTHROUGH=1`）。改完**立刻生效**，不需要重启 DSH——bili 每次请求都重读配置。
  放行后它的日志会打出 `sdk-hmac-sha256-signed model request forwarded DIRECT`。
- **插件侧不再被误判成密钥失效**：新增 `hostSafeText()`，`describeFailure` 对非认证类失败
  把文案里独立的 `401`/`403` 抹成 `4xx`（认证类保留原样——那时用户确实该看到「密钥无效」）；
  shim 的内部错误路径同样处理。两条回环闸门（Host / Origin 不匹配）的状态码由 403 改为 400，
  免得把本地的防护拒绝伪装成上游鉴权失败。
- **`TM.00001001` 从「限流」改判「请求形状错误」**：实测它是「请求头 Agent-Type 为空」
  「参数 model 不合法」这一类，按限流处理会白做三件事（15 秒冷却 + 退避重试 + 换账号）。
- 回归断言 `node _hwtest_hostsafe.mjs`：15/15 通过。

### 验证证据

- bili 日志：`sdk-hmac-sha256-signed model request forwarded DIRECT (built-in passthrough opt-in (#1884) — byte-untouched, no compression)`。
- 在宿主进程内实跑一张 `codearts/deepseek-v4.1-flash-1017` 的任务卡片：结果 `succeeded`。
- 插件状态：码道 `successes` 由 0 变 1、`failures` 不再增长、`lastError` 清空。

## 1.3.2

### 账号池变成显式开关：默认就是单账号

- 新增按平台的 **账号池开关**，默认关闭 = **单账号模式（日常）**：只用一个账号，不做轮转。
- 单账号模式的挑选逻辑 `pickSingle`：健康度只用来「挑」，**不用来「删」**。账号被停用或在冷却时仍然会被选中，所以不会再出现“候选为空 → 503 unconfigured”这一类连锁故障。
- 账号池启用时才走原来的 `pools.rank()`：按健康度轮转并剔除不健康账号——那是它该有的行为，现在要用户显式打开。配两个以上账号才值得开。
- 新增 `GET/POST /api/huawei-connect/pool`（持久化到设置命名空间 `huawei-connect` 的 `poolEnabled`）；状态快照新增 `poolEnabled` 与 `activeAccount`，卡片因此能说出“当前使用的是哪个号”。
- 码道与果办**同一份逻辑、同一份 UI**，两个平台一起生效。

### 设置卡片

- 账号池从默认路径里摘出来，单独一个按钮 + 一个状态标签：`单账号模式（日常）` / `账号池已启用`，下面一句说明为什么默认关闭。
- **模型清单与账号列表都改成逐行列表**：此前两者共用一套 flex-wrap 的 chip 流，样式还完全一样，挤成一团又分不清边界。现在每行 = 标记位（勾选 ✓ / 当前账号 ●）+ 名称 + 右侧状态或模型 id，清单限高 320px 可滚动。
- 上游没给显示名（`name === id`）时，右侧不再重复同一串 id。

## 1.3.1

### 修复：码道反复 503「还没有可用的账号」——一次转发层拒绝换来的账号级停用

实测到的完整链条（每一项都有运行期证据）：

1. 码道的请求是 **SDK-HMAC-SHA256 签名**的。中间转发层拒收这种请求，回
   `{"type":"signed_request_requires_resign","code":"bili_resign_unavailable"}`。
2. 这条报文没有匹配上任何已知文案，落进了 `classifyUpstreamFailure` 末尾
   `if (status === 401 || status === 403) return { kind: 'authentication' }` 的兜底。
3. `authentication` 在池里的处置是 **`disable()`：停用整整 1 小时**。
4. `AccountPool.rank()` 把停用账号从候选里剔除，于是 `accounts('codearts')` 返回空，
   shim 在发起任何上游请求之前就回了 503 `unconfigured`。
5. 而「同步登录态」从来不会调用 `pool.enable()`——于是错误文案让用户去做的那个动作，
   恰恰是修不好它的那个动作。停用状态又只存在内存里，所以除了等满一小时或重启 DSH，
   没有任何出路。这就是"刚登录就又不行"的来源。

### 修复内容

- **新增 `proxy_refused` 分类**：转发层明确表示"不转这种签名请求"时，不再往 401/403
  兜底里掉。该分类不计错误、不冷却、不停用、不换号，并把上游原始报文原样报出来，
  文案直说"账号和凭证本身没有问题，重登也不会改变结果"。
- **只有 401 才算凭证失效**。裸 403 改为可恢复的限流冷却（15 秒 + 允许换号再试一次）：
  华为此类网关的 403 绝大多数是策略 / 签名 / 参数层面的拒绝，误判成认证失败会停用一个
  完全健康的账号，而停用后池没有任何自愈路径。
- **`model_unavailable` 改为按报文判定**（`ModelArts.81004 / 81009 / 81010`、`Invalid model`、
  `No available backend`），403 和 404 都认。此前 403 上的 81009 会被当成限流反复冷却，
  404 上的会被吞成 `not_found`。
- **「同步登录态」现在会解除池里的停用与冷却**。码道用本次同步刚认证成功的凭证作依据；
  果办在写入凭证后一并解除。错误文案让用户点的那一下，从此真的有效。
- **503 `unconfigured` 说明真实原因**：哪个账号、被停用了多久、上游最后报什么，
  或"这个平台还没有配置任何账号"。不再把"被停用"和"从没配过账号"混成同一句。
- **池快照新增 `disabledRemainingMs` / `blockedRemainingMs`**：停用是小时量级、冷却只有秒级，
  此前快照只报冷却，卡片会对一个停用账号显示"还剩 0 分钟"。

## 1.3.0

### 打包：成为可直接安装的 DSH 插件

- **声明 DSH 兼容区间**：`engines.dsh: ">=0.1.7-rc.1 <0.3.0-0"`。此前只有 peer 范围、
  且没有上界，宿主升到 0.3 也会被当成"兼容"。现在兼容性由这一条决定，装得上装不上
  一眼可判（当前桌面端 `0.2.1-rc.5` 在区间内）。
- **peer 范围收紧到与宿主同版本线**：`@deepseek-ai/dsh-*` 一律 `>=0.1.7-rc.1 <0.3.0-0`，
  `@deepseek-ai/cordis` `>=4.0.4 <5.0.0`，`@deepseek-ai/schemastery` `>=3.18.4 <4.0.0`，
  `@earendil-works/pi-ai` `>=0.85.1 <2.0.0` 并标为 optional，与同宿主上已验证可用的
  `dsh-connect-trae@4.6.4` 一致。
- **不再把 `@deepseek-ai/dsh-client-ui-primitives` 当成可安装的 peer 包**：它是 Web 前端的
  静态种子模块（`staticModules`），不是 node_modules 里的包。客户端对它的依赖改由
  `dsh.client.inject` 表达；服务端接受 `exports["./client"]` 即 `./lib/client/index.js`。
- 修正 `market-entry.json` 中文描述里的平台名（「果道」→「码道」），安装指令换成可执行
  的 `dsh plugin add` 形式，不再是让用户手工 clone 到 node_modules。

### 安装形式

三种，按可得性排序：

1. 本地压缩包：`dsh plugin --profile <profile> add file:<path>/dsh-huawei-connect-1.3.0.tgz`
2. npm 发布后：`dsh plugin --profile <profile> add dsh-huawei-connect@1.3.0`
3. 固定提交的 git：`dsh plugin --profile <profile> add git+https://github.com/wang111928/dsh-huawei-connect.git#<40位提交>`

### 客户端

- 设置卡片改为按平台分栏（码道 / 果办两个 Tab，`role="tablist"`），只渲染当前选中
  平台的那一块：两个平台都接的人不用再把整张长卡片从头翻到尾，一个平台的错误也不
  再把另一个平台挤到屏幕外。默认选中第一个有数据的平台，选择在同一次渲染里沿用。

## 1.2.0

### 文档：修正安装方式（未发布 npm 前）

- 安装改为 GitHub 源码 clone / 手动拷贝两种方式，移除对 npm registry 的依赖说明。
- 修正 README 全文反引号转义，恢复代码块与行内代码渲染。
- market-entry / awesome 列表 / PUBLISH-STEPS 同步改为 git 源安装。


自带登录 + 账号池。插件不再依赖上游客户端已经登录过。

### 浏览器登录（两个平台，一套引擎）

- 移植了 `dsh-codearts` 的 OAuth2 流程：PKCE(S256) + DPoP(ES256) + 本机回环回调。
- **实测发现果办的 client_id（`pdp5_for_agentarts`）同样接受
  `http://127.0.0.1:<port>` 的本机回调**，所以两个平台共用同一套引擎，差异只有
  client_id 与授权页拼法。
- DPoP 私钥与 refresh_token 一起落盘（私钥丢了 refresh_token 就废了）。
- 新增路由：`POST /api/huawei-connect/login`、`GET /login/status`、
  `DELETE /accounts`。
- 命令行：`node lib/bin.mjs login <codearts|officeace>`。

### 自动续期

- 实测验证：续期成功返回新 AK/SK + 轮换后的 refresh_token，有效期从 1.2h 延长到 2h。
- **单飞**：同一账号并发续期只真正执行一次（refresh_token 一次性，并发会让账号坏掉）。
- **失败降级**：续期失败但旧 token 未过期时继续用旧的，不让一次抖动毁掉能成功的请求。
- `sync` 时会**接管**上游客户端的 refresh_token（origin 记为 `import+oauth`），
  这样即使 `dsh-codearts` 被卸载，账号也不会两小时后失效。

### 账号池

- 每平台一个池：健康度（停用/冷却）、按"最少使用"轮转、按需续期。
- 分类惩罚：认证失败→停用；积分耗尽→冷却 30 分钟；**并发撞墙→不惩罚**（容量问题，
  踢掉好号只会更糟）；5xx→30 秒；TPM 限流→15 秒。
- 状态接口新增 `pool` 字段，卡片显示每个账号的可用性与剩余时间。
- 验证：两个账号 = 6 个并发槽，闸门与池配合正常。

### 卡片

- 每个平台分区新增「使用华为云账号登录」按钮、账号池列表、移除账号。

## 1.1.0

## 1.1.0

上游加固（把"拒绝"变成"不会发生"）与上下文完善。所有改动都基于 2026-10-23 的实测，
每条结论的探针方式记在 README §4/§5。

### 修复的五个真实拒绝来源

- **`max_tokens` 超限**：码道 >65536、果办 >131072 会在**流内**报参数非法
  （`InferHub.001001005.400` / `ModelArts.81001`）。此时已开流、无法重放，整轮报废。
  现在发送前钳制到实测上限。
- **`developer` 角色**：pi-ai 对"非标准端点"默认认为支持 `developer` 角色，而 DSH
  每轮都带 system 提示词、模型又被标为会推理 → 每一轮都发 `role: "developer"` →
  码道 `InferHub.001001044.400 Message role cannot empty`。现在钉死
  `supportsDeveloperRole: false`。
- **图片发给纯文本模型**：码道 `001001020.406 not multimodal`、果办
  `81001 unsupported content type`，都是硬拒绝且会让整个会话从此发不出去。现在按上游
  `supports_images` 判定，发送前把图换成文字占位（切回多模态模型后照常发送）。
- **并发超过 3 个会话**：`TM.00001041`。新增本地会话闸门（`gate.mjs`），同一账号
  最多 3 个在飞，其余排队，按实测的 ~60s 释放时间占位。实测 5 并发全部成功、零拒绝。
- **思考内容被丢弃**：`reasoning: false` 会让 pi-ai 静默丢掉 `reasoning_content`，
  多轮工具调用时上游拿不到自己上一轮的推理。现在如实声明 `reasoning: true`，
  档位限制在 `low`/`high`。

### 上下文

- **`contextWindow` 从 131072 改为 262144**。131072 会让 DSH 压缩器的预算算成
  `131072 - 65536 - 65536 = 0`，压缩器直接抛错、压缩彻底失效——这是最初版本的真实缺陷。
  262144 的三条校验（pressure/threshold/retain）全部通过。
- 上限依据实测：约 62.5 万 token 仍 200，125 万 token 网关超时，250 万 token 参数非法。

### 其它

- 错误分类补上实测到的业务码（`001001044`/`001001020`/`ModelArts.81001`/
  `ModelArts.81114`），并按类别给出不同退避时长。
- 卡片新增"会话槽位"一行，槽位占满时直接说明原因与解法。
- 模型能力改用上游的 `supports_images` 权威标记。
- 多模态模型不再被 `display_enabled` 误过滤（它们 enable=true、真能出图）。

## 1.0.0

## 1.0.0
首个可用版本。

- 两条 provider 路由：`codearts`（码道 CodeArts）与 `officeace`（果办 OfficeAce）。
- 积分余量：码道 `/snap-manager/v1/statistics/plugin`；果办本机控制面
  `/api/subscription/current` + `/api/codeagent-package/usage`。
- 模型勾选（写回 settings，适配器实时生效）。
- 登录态自动发现：码道读 `dsh-codearts` 账号文件，果办读 Windows 凭据管理器（只读）。
- 回环 shim：AK/SK 签名、Basic 认证、码道 SSE 逐帧翻译。
- 请求伪装：身份头、字段白名单、不携带自身身份（依据见 README §4）。
- 码道并发上限（3 会话/账号）按原地排队重试处理，而不是报错给用户。
- 设置卡片：一个卡片两个分区，积分、模型、错误就地显示。
- CLI：`status` / `models` / `sync`。
