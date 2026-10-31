# DSH Huawei Connect

把华为两个平台的模型接进 [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness)（DSH）：**码道 CodeArts**（编码）与 **果办 OfficeAce**（办公）。两个平台都出现在 DSH 的模型选择器里，各带积分余量、模型勾选，以及按官方客户端形态构造的请求。

## 安装

从 npm 安装（已发布为 [`dsh-huawei-connect`](https://www.npmjs.com/package/dsh-huawei-connect)）：

```sh
dsh plugin --profile <你的 profile> add dsh-huawei-connect@1.3.4
```

也支持其他方式：

```sh
# 从 GitHub tag 安装（已实测）
dsh plugin --profile <你的 profile> add github:wang111928/dsh-huawei-connect#v1.3.4
# 或从本地压缩包安装
dsh plugin --profile <你的 profile> add file:/绝对路径/dsh-huawei-connect-1.3.4.tgz
```

桌面端（DSH Desktop）请在 **设置 → 插件** 中，于「从 Git / GitHub 安装」或「从本地压缩包安装」填入同一个 spec。

## 前置要求

- DeepSeek Harness `>=0.1.7-rc.1 <0.3.0-0`（写在插件的 `engines.dsh` 里，区间外的宿主会拒绝安装）
- Node.js `^22.19.0 || >=24.0.0`
- 果办需要 Windows（读取 Windows 凭据管理器）；码道跨平台可用
- 码道：用码道桌面端或 `dsh-codearts` 登录过一次。果办：桌面端需在 Windows 上运行并登录

装好后，打开 **设置 → 插件 → 华为双平台**，登录任一平台，即可在模型选择器里挑选模型。

## 功能

- **两个平台、两条路由** —— `codearts` 与 `officeace` 各自出现在模型选择器，可只用其一，也可两者同用。
- **积分余量** —— 卡片显示每个账号的剩余积分，按平台分别计。
- **模型勾选** —— 按平台勾选，写回宿主 settings，模型选择器实时生效；勾代表「明确勾上」，整栏不勾即该平台不设限制。
- **登录态自动发现** —— 码道复用 `dsh-codearts` 账号，果办读 Windows 凭据管理器；两者只读，不要求重复登录。
- **请求伪装** —— 按官方客户端形态构造请求，避免被上游按渠道指纹拒绝。
- **自动续期** —— 码道安全令牌到期前自动刷新；上游不可达时回退到上一次成功的积分快照。
- **模型黑名单** —— 上游列出但实际不可达（403/404）的模型会自动从选择器移除。

## 使用

1. 设置 → 插件 → 华为双平台 → **同步登录态**。
2. 卡片显示每个平台的账号、积分余量、模型数。
3. 新建对话 → 在模型选择器里选 `码道 CodeArts` 或 `果办 OfficeAce` 下的模型。
4. 只想留几个模型：在卡片里点掉其它模型 → **保存选择**。

## 已知限制

- 码道请求使用 `SDK-HMAC-SHA256` 签名；若本机有会重写请求体的转发层（如 `billion-context`），需让它原样放行：`{"resign":{"sdk-hmac-sha256":{"passthrough":true}}}` 或环境变量 `BILI_RESIGN_PASSTHROUGH=1`，否则每个回合都会失败。
- 码道每账号最多 3 个并发会话，约 1 分钟释放；在卡片里再登录一个账号可翻倍。
- 果办积分接口要求本机会话：必须开着果办并保持登录。

## 许可证

MIT
