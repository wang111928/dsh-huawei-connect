# Changelog

## 1.3.4

- **Published to npm** as [`dsh-huawei-connect`](https://www.npmjs.com/package/dsh-huawei-connect). Install with `dsh plugin --profile <profile> add dsh-huawei-connect@1.3.4`.
- GitHub-tag and local-tarball installs remain supported.
- **Fixed**: per-model toggles — clicking one row no longer clears the ticks on other rows; ticks now mean "explicitly allowed", and an empty list on a platform means "unrestricted".
- **Fixed**: model selection split into one independent list per platform (`enabledModels: { codearts: [...], officeace: [...] }`); old flat arrays migrate automatically.

## 1.3.3

- **Fixed**: CodeArts "API key invalid" error when a local request-rewriting proxy (e.g. `billion-context`) sits in front — the plugin no longer lets that misreport as an auth failure. Pass through the `SDK-HMAC-SHA256` signature with `BILI_RESIGN_PASSTHROUGH=1` or the equivalent config.
- `TM.00001001` (missing `Agent-Type`) reclassified from rate-limit to request-shape error.

## 1.3.2

- Account pool is now an explicit toggle, default off = single-account mode (no rotation).
- Reuse the existing `dsh-codearts` account file; OfficeAce reads the Windows Credential Manager. Both read-only.

## 1.3.1

- Built-in browser login for both platforms (PKCE + DPoP, local loopback callback); no longer depends on the upstream client already being signed in.
- Auto-renew tokens (refresh before expiry; persist new refresh token immediately).

## 1.3.0

- First public release. CodeArts and OfficeAce routes, credit balances, per-model toggles, request shaping, and a local concurrency gate.
- Published on GitHub at `wang111928/dsh-huawei-connect`.
