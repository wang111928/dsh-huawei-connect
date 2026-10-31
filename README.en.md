# DSH Huawei Connect

Connect Huawei's two platforms to [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) (DSH): **CodeArts** (coding) and **OfficeAce** (office suite). Both appear in DSH's model picker, each with credit balance, per-model toggles, and requests shaped like the official clients.

## Install

Install from npm (published as [`dsh-huawei-connect`](https://www.npmjs.com/package/dsh-huawei-connect)):

```sh
dsh plugin --profile <your profile> add dsh-huawei-connect@1.3.4
```

Other install methods are also supported:

```sh
# from the GitHub tag (verified)
dsh plugin --profile <your profile> add github:wang111928/dsh-huawei-connect#v1.3.4
# or from a local tarball
dsh plugin --profile <your profile> add file:/absolute/path/dsh-huawei-connect-1.3.4.tgz
```

On DSH Desktop, use **Settings → Plugins** and enter the same spec in the Git/GitHub or local-tarball install field.

## Requirements

- DeepSeek Harness `>=0.1.7-rc.1 <0.3.0-0` (declared in the plugin's `engines.dsh`; a host outside this range refuses the install)
- Node.js `^22.19.0 || >=24.0.0`
- Windows for OfficeAce (it reads the Windows Credential Manager); CodeArts works cross-platform
- CodeArts: sign in once via the CodeArts desktop client or `dsh-codearts`. OfficeAce: the desktop app must be running and signed in on Windows

After install, open **Settings → Plugins → DSH Huawei Connect**, sign in to either platform, and pick models from the model picker.

## Features

- **Two platforms, two routes** — `codearts` and `officeace` each show up in the model picker; use one or both.
- **Credit balances** — the card shows each account's remaining credits, metered per platform.
- **Per-model toggles, per platform** — each tab keeps its own list; ticks are written to host settings and the picker updates live. A tick means "explicitly allowed"; ticking nothing leaves that platform unrestricted.
- **Automatic credential discovery** — CodeArts reuses the existing `dsh-codearts` account; OfficeAce reads the Windows Credential Manager. Both are read-only and never require re-login.
- **Request shaping** — bodies and headers mirror the official clients so upstream channel fingerprinting does not reject them.
- **Auto-renewal** — CodeArts security tokens refresh before expiry; credit reads fall back to the last good snapshot when upstream is down.
- **Model blacklist** — models advertised upstream but actually unreachable (403/404) are dropped from the picker automatically.

## License

MIT
