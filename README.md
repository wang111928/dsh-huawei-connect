# DSH Huawei Connect

把华为两个平台的模型接进 [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness)（DSH）：
**码道 CodeArts**（编码）与 **果办 OfficeAce**（办公）。一次装配，两条 provider 路由，
积分余量、模型勾选、以及按官方客户端形态构造的请求，全在设置卡片里。

## 功能

- **两个平台、两条路由**：`codearts` 与 `officeace` 各自出现在 DSH 的模型选择器里。
  可以只用其中一个，也可以两个一起用。
- **积分余量**：码道走 `/snap-manager/v1/statistics/plugin`（实测体验版 10500 分），
  果办走本机控制面 `/api/subscription/current`（实测 4600 分）与
  `/api/codeagent-package/usage`（码道兼容包剩余）。两个平台的额度口径不同，卡片
  分开显示，互不影响。
- **模型勾选**：卡片里按平台勾选，写回宿主 settings，模型选择器实时生效。
- **登录态自动发现**：码道读 `dsh-codearts` 已有的账号文件，果办读 Windows 凭据管理器。
  两边都**只读**，都不要求用户重复登录。
- **请求伪装**：按官方客户端的请求形态构造（身份头、字段白名单、认证方式），
  详见 [§4](#4-请求伪装实测依据)。
- **不影响另一个平台**：一个平台挂了，另一个照常；卡片上的错误就地显示。

## 安装

本插件以源码形式托管在 GitHub，尚未发布到 npm registry。安装有两种方式，任选其一：

### 方式 A：从 GitHub 源码安装（推荐）

```sh
# 把仓库克隆到 DSH profile 的 node_modules 下
PROFILE="$HOME/.dsh/profiles/desktop"
cd "$PROFILE/node_modules"
git clone https://github.com/wang111928/dsh-huawei-connect.git dsh-huawei-connect
# 若已存在旧目录，先删除再 clone
# 然后在 $PROFILE/package.json 的 dependencies 里加条依赖并重启 DSH
```

> 说明：本插件依赖的 `@deepseek-ai/*` peer 包与 `react` 在你的 profile 里通常已具备；
> 若首次拷贝后启动报缺包，在 profile 根目录执行一次 `pnpm install` 即可。

### 方式 B：纯文件拷贝（已有本仓库源码时）

```sh
PROFILE="$HOME/.dsh/profiles/desktop"
mkdir -p "$PROFILE/node_modules/dsh-huawei-connect"
cp -r package.json lib cordis.patch.yml "$PROFILE/node_modules/dsh-huawei-connect/"
# 在 $PROFILE/package.json 的 dependencies 里登记 "dsh-huawei-connect": "1.2.0"，然后重启 DSH
```

重启 DSH → 设置 → 插件 → **华为双平台** 卡片 → 「同步登录态」。

### 前置条件

| 平台 | 需要 |
|---|---|
| 码道 | 用码道桌面端登录过（或装过 `dsh-codearts` 并登录）。读 `$DSH_HOME/.codearts-accounts.json` |
| 果办 | 打开果办并登录。读 Windows 凭据管理器 `OfficeAce/auth-sessions/...` 与 `~/.office-claw/session.cookie` |

## 使用

1. 设置 → 插件 → 华为双平台 → **同步登录态**。
2. 卡片上会显示每个平台的账号、积分余量、模型数。
3. 新建对话 → 模型选择器里选 `码道 CodeArts` 或 `果办 OfficeAce` 下的模型。
4. 想只留几个模型：在卡片里点掉其它模型 → **保存选择**。

### 命令行

```sh
node lib/bin.mjs status    # 账号、积分、套餐（不含任何密钥，可直接贴出来）
node lib/bin.mjs models    # 上游真实模型清单
node lib/bin.mjs sync      # 从上游同步登录态
```

## 3. 登录与账号池

插件**自带**浏览器登录，不再依赖上游客户端已经登录过。

### 3.1 为什么能一套代码登两个平台

实测（2026-10-23）：码道（`codearts-agent`）与果办（`pdp5_for_agentarts`）用的是
**同一个 IAM**——同一个授权页、同一个换 token 端点、同一套 PKCE + DPoP。而且两个
client_id 都接受 `http://127.0.0.1:<port>/...` 的本机回调（都返回 302 跳登录页）。

所以 `lib/oauth.mjs` 是一套引擎，平台差异只有 client_id 与授权页的拼法：

| | 码道 | 果办 |
|---|---|---|
| client_id | `codearts-agent` | `pdp5_for_agentarts` |
| 授权页 | `codearts.huaweicloud.com/portal/authorize?...` | `auth.huaweicloud.com/authui/login.html?service=...` |
| 换 token | `sts.cn-north-4.myhuaweicloud.com/v1/oauth2/tokens` | 同左 |

### 3.2 流程

```
点「使用华为云账号登录」
   → 本机 127.0.0.1 随机端口起回调服务
   → 生成 PKCE（verifier + S256 challenge）与 DPoP 密钥对
   → 浏览器打开授权页，用户登录
   → 华为回调 ?code=... 到本机
   → 用 code + verifier + DPoP proof 换 STS token + 临时 AK/SK + refresh_token
   → 凭证落盘到 ~/.dsh/.huawei-connect/accounts.json (0600)
```

**DPoP 私钥必须与 refresh_token 一起保存**：refresh_token 签发时就和那时的公钥绑定，
续期时服务端会核对"是不是当初那把钥匙"。私钥丢了，refresh_token 就废了，只能重新登录。

### 3.3 自动续期

凭证约 24 小时过期（实测），续期用 refresh_token。三个关键点：

1. **refresh_token 是一次性的**——每续一次上游就换一个新的，所以续完必须立刻落盘。
2. **单飞**——同一账号并发续期只会真正续一次（`pool.mjs` 按账号加锁）。两个并发
   续期会让后到的那个失败，**并把账号弄坏**。
3. **失败不致命**——续期失败但当前 token 还没过期时，继续用旧的。一次网络抖动不该
   让一个本来能成功的请求失败。

### 3.4 账号池

**为什么需要**：码道对每个账号只开 3 个并发会话（见 §4.4）。这不是买额度能解决的，
是账号级硬计数。**两个账号 = 6 个槽，四个 = 12 个**。

池的行为：

| 事件 | 处理 | 为什么 |
|---|---|---|
| 认证失败 | **停用** 1 小时 | 只能重新登录，重试无意义 |
| 积分耗尽 | **冷却** 30 分钟 | 额度周期会重置，不该永久踢出 |
| 并发撞墙 | **不惩罚** | 这是容量问题，不是账号坏了——踢掉好号只会更糟 |
| 上游 5xx | 冷却 30 秒 | 通常是暂时的 |
| TPM 限流 | 冷却 15 秒 | 按分钟窗口重置 |

**轮转顺序**：可用账号里按"最少使用"排序。这样不会总用同一个号把它的额度先耗光。

### 3.5 凭证来源的三种情况

| origin | 含义 | 能续期吗 |
|---|---|---|
| `login` | 在本插件里点的登录 | ✅ 有完整 OAuth 凭证 |
| `import` | 从上游客户端读来的副本 | ❌ 只能用到过期 |
| `import+oauth` | 从上游读来，但**接管**了它的 refresh_token | ✅ 接管后由本插件独占 |

**接管的风险**：如果 `dsh-codearts` 与本插件同时在用同一个账号，两边都续期会让对方的
token 作废。建议只保留一个。接管时机是首次 `同步登录态`。

### 3.6 命令行

```sh
node lib/bin.mjs login codearts     # 打印授权地址，在浏览器打开
node lib/bin.mjs login officeace
node lib/bin.mjs status             # 账号、积分、池健康度
```

## 4. 请求伪装：实测依据

这一节是本文档最需要读的部分——它说明本插件**做了**什么伪装、**没做**什么，以及为什么。
每一条结论前面都标了实测日期与探针方式。

### 4.1 为什么 workbuddy 那套不能照搬

`dsh-connect-workbuddy` 的核心问题在上游：它按**提示词内容**做渠道指纹拦截。
网关拿到请求后逐条匹配 `system` / `assistant` 消息的开头（以及提示词中段的某些长
字符串），命中就回 `11128`，而 `displayTips` 一律写成"渠道校验失败"——从不告诉你是
哪一句触发的。那套解法（加中性头、在句读处插零宽空格、失败后重放整轮）是为**那个
具体缺陷**写的补丁。

### 4.2 华为这两个平台不做这件事（逐条实测）

2026-10-23，同一个真实账号，两个平台各发一次：

| 探针 | 码道 | 果办 |
|---|---|---|
| 裸 user 消息 | 200 | 200 |
| `system` 开头是 DSH 官方提示词 *"You are an AI agent powered by DeepSeek Harness."* | **200** | **200** |
| `system` 开头是 Claude Code 的身份句 | **200** | — |
| `assistant` 历史里复述上述身份句 | **200** | — |

所以本插件**不**改写用户的提示词。抄那套补丁只会让你的提示词被无声篡改，
换不到任何好处——那是针对另一个上游的具体缺陷的方案。

### 4.3 真正会被拒的五件事（全部实测，全部已在插件里处理）

这些才是"拒绝"的真实来源。每一条都不是偶发，而是**只要请求长成那样就必定失败**。

| # | 触发条件 | 上游反应 | 插件怎么处理 |
|---|---|---|---|
| 1 | `max_tokens` > 65536（码道）/ > 131072（果办） | 流内 `InferHub.001001005.400` / `ModelArts.81001` | 发送前**钳制**到上限（`disguise.mjs`） |
| 2 | 消息里出现 `role: "developer"` | `InferHub.001001044.400 Message role cannot empty` | 适配器钉 `supportsDeveloperRole: false`，让 pi-ai 只发 `system` |
| 3 | 把图片发给**纯文本**模型 | 码道 `InferHub.001001020.406 not multimodal`；果办 `81001 unsupported content type` | 发送前把图换成文字占位（判定用上游的 `supports_images`） |
| 4 | 同一账号并发 > 3 个会话 | `TM.00001041 并发会话数已达上限(3个)` | 本地**会话闸门**排队（`gate.mjs`），而不是把 400 甩给用户 |
| 5 | `Agent-Type` 缺失（码道） | `TM.00001001 请求头Agent-Type为空` | 固定带 `Agent-Type: PromptCenter` |

**为什么第 1、3 条特别危险**：它们的错误是在**流内**出现的（HTTP 已经 200），
此时已经开流、无法重放，那一轮对话直接废掉。所以必须在**发送之前**治好。

**为什么第 2 条是隐形杀手**：`developer` 是 OpenAI 的新角色，pi-ai 对"非标准端点"
默认认为支持它；而 DSH 每一轮都带 system 提示词，所以**只要模型被标为会推理，每一轮
都必挂**。这条不实测根本发现不了——单测裸请求永远通，只有走完整链路才暴露。

### 4.4 认证方式本身也要伪装

两个平台的认证都不是"一个 Bearer 头"：

- **码道**：`x-auth-token` + **AK/SK SDK-HMAC-SHA256 签名**同时在场。只带 token 会被
  APIG 拒成 `APIG.0301 decrypt token fail`。
- **果办**：`Basic base64(appKey:appSecret)`。

这正是本插件需要回环 shim 的原因——pi-ai 只会说 Bearer。

### 4.5 不自报家门

出站请求里没有 `DeepSeek Harness`、插件名或本机路径。

### 4.6 真正的限制不是"封号"，是并发与配额

码道对**每个账号**只开 **3 个并发会话**，且一个会话要占用约 **1 分钟**才释放——
**中途停止生成并不减免**（上游行为，客户端无法提前释放）。

本插件的处理是**本地闸门**：同一个账号同时最多 3 个在飞，超出的排队；一次请求结束
后按实测的释放时间占位，到点才放行。表现上用户只是"慢一点"，而不是"报错"。

**在卡片里再登录一个账号**是根治办法——两个账号各有自己的 3 个槽，正好翻倍。

### 4.7 停止生成会断开上游

用户点停止时，插件会 abort 上游连接。否则码道那边的一个并发槽会被一个已经没人要的
请求占满一分钟，用户手一快就连续撞墙。

## 5. 上下文处理

上下文是另一类"拒绝"来源，而且更隐蔽：**会话越长越容易挂，而且挂的时候看起来像模型
的问题**。这一节记录本插件的取值依据。

### 5.1 声明的上下文窗口必须是 262144，不能是 131072

这是一个**真实的坑**，值得单独说。DSH 的压缩器（`compaction-basic`）用适配器声明的
`contextWindow` 算预算，算法是：

```
messageBudget  = contextWindow - maxTokens
pressureBudget = messageBudget  - headroomTokens      // headroom 默认 65536
threshold      = min(contextWindow * 0.8, pressureBudget)
```

如果 `pressureBudget <= 0`，压缩器**直接抛错**，压缩彻底失效——会话一路长到把上游
撑爆，然后每一轮都失败。

而 `131072 - 65536 - 65536 = 0`。也就是说：**声明成"标称的 128k"正好把压缩预算吃干净**。
这是本插件最初的取值，被实测证伪。

262144 的验算（`headroom 65536`、`ratio 0.8`、`retainRatio 0.16`）：

```
messageBudget  = 262144 - 65536 = 196608
pressureBudget = 196608 - 65536 = 131072   > 0      ✓
threshold      = min(209715, 131072) = 131072        ✓
retainTokens   = 196608 * 0.16 = 31457    < threshold ✓
```

三条校验全过，压缩会在 131072 token 处接管。

### 5.2 为什么不声明得更大

上游实测能吃下远超 128k 的输入：

| 输入规模 | 结果 |
|---|---|
| 约 62.5 万 token | 200 OK |
| 约 125 万 token | HTTP 504 Backend timeout |
| 约 250 万 token | `InferHub.001001005.400` 参数非法 |

也就是说上游大致能到 60 万 token 量级，但**大输入要等很久**（504 是网关超时，不是拒绝）。
声明得越接近这个天花板，用户越容易撞上超时。262144 留了一倍余量。

### 5.3 思考内容（reasoning）要如实声明

两个平台**都**会发 `delta.reasoning_content`。pi-ai 只在 `model.reasoning` 为真时
才把思考内容收进 thinking 块、并在下一轮回放成 `assistant.reasoning_content`。

声明成 false 的后果不是报错，而是**静默变笨**：思考过程被丢弃，多轮工具调用时上游拿不到
它自己上一轮的推理。所以插件声明 `reasoning: true`，并把可选档位限制在它们真认的
`low`/`high`。

（注意：`reasoning: true` 不会主动打开思考——上游本来就一直思考。它只控制 DSH 怎么
**读**与怎么**回放**。）

## 6. 架构

```
DSH 对话窗口
   |  OpenAI /chat/completions（Bearer = 本进程随机 secret）
   v
dsh-huawei-connect shim（127.0.0.1:随机端口）
   |-- /codearts/v1/...  → x-auth-token + AK/SK 签名 + Agent-Type → snap-access.../api/v2/chat/completions
   |-- /officeace/v1/... → Basic(appKey:appSecret)               → modelgw-.../v2/chat/completions
```

- shim 只监听回环、校验 Host/Origin/Bearer（常量时间比对）；上游真凭证永远不出进程。
- 码道的 SSE 有华为特有帧（`reasoning_content`、累积快照、帧内 `error_code`），
  逐帧翻译成标准 OpenAI chunk；果办本来就是标准 SSE，**原样透传**。
- 模型目录启动时与每小时各刷新一次，失败保留旧目录（选择器不会空掉）。

## 7. 已知限制

- **码道每账号 3 并发会话，占满约 1 分钟**（见 §4.4）。
- **码道凭证有效期约 24 小时**，由 `dsh-codearts` 负责续期；本插件只读它的账号文件，
  不抢刷新职责（两个插件同时用一个 `refresh_token` 会让其中一个失效）。
- **果办积分接口要求本机会话**：必须开着果办并保持登录，关掉就报"读不到会话"。
  它的 TLS 是自签的，插件对此只在本机回环请求上放宽证书校验。
- 积分是**账号级**口径，没有"这一次请求花了多少分"的明细；卡片显示的是账号余额，
  官方明细请走各平台控制台。
- 模型的能力（是否支持图片、上下文长度）部分靠 id 推断：上游 `/models` 只给 id。

## 8. 免责声明

本项目**仅供个人学习和研究使用**，只驱动使用者自己的账号在本机调用。使用者需遵守
华为云、码道与果办的服务条款；因使用本项目产生的任何后果由使用者自行承担。本项目与
华为、DeepSeek 均无关联，文中出现的名称仅用于描述兼容关系，商标权利归各自所有。

## 许可证

MIT
