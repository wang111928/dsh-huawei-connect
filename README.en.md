# DSH Huawei Connect

Connect Huawei's two platforms to [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) (DSH):
**CodeArts** (coding) and **OfficeAce** (office suite). One setup, two provider routes,
with credit balances, per-model toggles, and requests shaped like the official clients.

## Features

- **Two platforms, two routes**: `codearts` and `officeace` each appear in DSH's model picker.
  Use one, or both at once.
- **Credit balances**: CodeArts reads `/snap-manager/v1/statistics/plugin` (measured 10500 on the trial plan);
  OfficeAce reads the local control plane `/api/subscription/current` (measured 4600) and
  `/api/codeagent-package/usage`. The two platforms meter differently, so the card shows them separately.
- **Per-model toggles, per platform**: the two tabs keep independent lists; ticks are written to host settings and the picker updates live. A tick means "explicitly allowed"; ticking nothing on a platform leaves that platform unrestricted (the card says so). Clicking a row changes only that row.
- **Automatic credential discovery**: CodeArts reads the existing `dsh-codearts` account file;
  OfficeAce reads Windows Credential Manager.
- **Request shaping**: bodies and headers mirror the official clients so upstream channel
  fingerprinting does not reject them.
- **Credit readout in the composer**: a compact pill in the input toolbar (and a full-width row on
  the new-conversation page) shows the live balance for the active platform.
- **Auto-renewal**: CodeArts security tokens refresh before expiry and the new refresh token is
  persisted immediately; credit reads fall back to the last successful snapshot when upstream is down.
- **Model blacklist**: models advertised upstream but actually unreachable (403/404) are dropped
  from the picker automatically instead of being retried.

## Install

This is a standard DSH bundle: the host reads `dsh.bundle.patch` for the server half and
`exports["./client"]` for the settings card in the browser. Installation therefore goes
through the host's own plugin channel — never by copying files into `node_modules` by hand.

Compatibility is declared once, as `engines.dsh: ">=0.1.7-rc.1 <0.3.0-0"`. A host outside
that range refuses the install with a named reason instead of loading and crashing later.
The current desktop runtime (`0.2.1-rc.5`) and `dsh web 0.2.1` are both inside it.

### A. Tarball (works today)

```sh
dsh plugin --profile <your profile> add file:/absolute/path/dsh-huawei-connect-1.3.4.tgz
```

On DSH Desktop use its own **Settings → Plugins** flow instead: that profile belongs to the
app's plugin manager, and the CLI cannot change it while the app is running. Point it at the
same `.tgz`.

### B. npm (after publishing)

```sh
dsh plugin --profile <your profile> add dsh-huawei-connect@1.3.4
```

### C. Pinned git commit (reproducible; the commit must already exist upstream)

```sh
dsh plugin --profile <your profile> add git+https://github.com/wang111928/dsh-huawei-connect.git#<40-char commit>
```

Then open **Settings → Plugins → DSH Huawei Connect**, sign in to either platform, and pick models.

## Requirements

- CodeArts signs its requests with `SDK-HMAC-SHA256`. If a body-rewriting proxy sits in front
  (e.g. `billion-context` on the same machine), it must be told to forward them untouched:
  `{"resign":{"sdk-hmac-sha256":{"passthrough":true}}}` in its config, or
  `BILI_RESIGN_PASSTHROUGH=1`. Otherwise every turn fails, and the host UI may report it as
  "invalid API key" — that is an error classifier reading the refused signature as an auth
  failure, not a problem with your account (fixed on our side in 1.3.3).
- DeepSeek Harness 0.2.1 or newer
- Node.js `^22.19.0 || >=24.0.0`
- Windows for OfficeAce (it reads Windows Credential Manager); CodeArts works cross-platform

## License

MIT
