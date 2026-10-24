# Changelog

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
