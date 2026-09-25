# Provider test reliability — YAN-106 / YAN-107

## Research and design

- `testUtils.js` treats unknown OAuth test config as invalid and persists `testStatus: "error"`. Valid OAuth flows for xai, clinepass, zed, codebuddy-intl, xiaomi-mimo have no entries. `api_key` connections store credentials in `accessToken`, not `apiKey`.
- `test-models/route.js` calls login-gated `/api/providers/[id]/models` over HTTP without auth. `models/route.js` already owns provider model listing. `/v1/audio/voices` fixed analogous self-fetch by calling GET in-process. `pingModelByKind` already supplies internal credentials for subsequent pings.
- `claude` live model listing already fixed on master (`liveResolvers.js`); do not duplicate YAN-114.

## Scope and sequence

1. YAN-107: replace bare HTTP self-fetch with direct `GET` handler call; test compatible node using mocked upstream, assert no internal request. Preserve existing empty-list behavior.
2. YAN-106: add provider-aware OAuth test configuration. Use authenticated read probes for xai / xiaomi; zed uses existing `fetchZedAuthenticatedUser`; codebuddy-intl validates expiry and refreshes near-expiry tokens. ClinePass OAuth is rejected by its consumer API: report an actionable API-key-required error rather than false success. `api_key` Xiaomi credentials remain on OAuth test path, which probes the stored `accessToken`. Add critical tests for provider cases, expired refresh and `api_key`.
3. Run targeted tests, lint, build, then code review and fix; commit, PR, review PR, CI, squash merge, cleanup, close tickets.

## Risks

- OAuth tokens differ from API keys; xai `/models` may reject subscription tokens. Detect auth failures rather than hiding them.
- Kiro `api_key` uses Amazon Q access token, not a generic `/models` API key. Keep its existing OAuth token-existence path unless a safe credential probe is established.
- No broad authentication bypass or secret disclosure in model tests.

## Outcome

- Changed `test-models` to invoke models GET in-process; added OAuth probes / clear failures and near-expiry refresh coverage.
- Baseline comparison: 88 known failures versus 89 baseline, no regression. `npm run lint` and `npm run build` passed.
- Review caught false ClinePass OAuth success and proxyless Cline probe; both fixed before PR.
