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
- **Per-model toggles**: tick models in the card; it writes to host settings and the picker updates live.
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

```sh
dsh plugin --profile web add dsh-huawei-connect
```

Then open **Settings → Plugins → DSH Huawei Connect**, sign in to either platform, and pick models.

## Requirements

- DeepSeek Harness 0.2.1 or newer
- Node.js `^22.19.0 || >=24.0.0`
- Windows for OfficeAce (it reads Windows Credential Manager); CodeArts works cross-platform

## License

MIT
