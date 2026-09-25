# YAN-385 Cursor PKCE login, refresh, and usage: recommendations

Linear YAN-385 / GitHub #253. Branch `feat/yan-385-cursor-pkce-usage` (based on `origin/master` at v0.3.1).

## Executive Summary

All three parts fit patterns the codebase already has, so the change needs very little new plumbing:

- **PKCE login.** Cursor's deep-control PKCE login fits the existing `device_code` flow almost exactly. Qoder already does this: it generates a local PKCE pair, the user opens a browser URL, and the server polls until a token comes back. `/api/oauth/[provider]/device-code` and `/poll` should work **without route changes**, because `cursor` is not in the route's no-PKCE lists. The route passes `authData.codeChallenge` in and returns the matching `codeVerifier`. The flow also has no local callback port, so it works in the production Docker container, where IDE import (localhost-only, reads `state.vscdb`) cannot.
- **Refresh.** Wire it in two places. `REFRESH_HANDLERS` covers proactive and background refresh. `CursorExecutor.refreshCredentials` covers the usage route and the chatCore 401 retry. Both should call one shared `refreshCursorToken`. Separately, `expiresAt` must come from the JWT `exp` claim everywhere, including the import path. Today the import path hard-codes 24h, so connections show as expired after one day and every request does a futile refresh check.
- **Usage.** Add one handler file (`open-sse/services/usage/cursor.js`), one `USAGE_HANDLERS` entry, `features.usage: true` in the registry, and a `cursor` case in `ProviderLimits/utils.js`. The generic fallback there drops `remainingPercentage`. Also add the weighted-strategy hooks: `kindForName`, `planTierFor`, and `PLAN_CAPACITY.cursor`.
- **Baselines.** CI baseline risk is low. `tokenUrl` and `usage` are in `verify-providers.mjs` `ADDED_FIELDS`. `verify-oauth-urls.mjs` only checks providers it lists explicitly. Aliases are unchanged.
- **Main risks.** The endpoints are undocumented and may drift, especially the auth and body shape of `exchange_user_api_key`. Refresh-token rotation can race. The master UI will diverge from the `re-design` branch, which has already split `OAuthModal` into `useOAuthFlow` and `oauth/authFlowHelpers.js`.

## Implementation Recommendations

### Approach

1. **Login: model it as `flowType: "device_code"`.** Follow `src/lib/oauth/providers/qoder.js` in `src/lib/oauth/providers/cursor.js`:
   - `requestDeviceCode(config, codeChallenge)`:
     - Generate `uuid = crypto.randomUUID()`.
     - Build `verification_uri_complete = ${loginUrl}?challenge=${codeChallenge}&uuid=${uuid}&mode=login&redirectTarget=cli`.
     - Return `device_code: uuid`, `user_code` (short uuid prefix, like qoder, so the modal's "Your Code" box isn't empty), `expires_in: 300`, `interval: 2`.
   - `pollToken(config, uuid, verifier)`:
     - Call `GET {pollUrl}?uuid=&verifier=`.
     - **404 means `authorization_pending`.**
     - 200 returns `{accessToken, refreshToken, [userId]}`.
     - **403 with `sign_in_policy_violation` must map to `access_denied`.** The modal only stops early on `expired_token` or `access_denied`; any other error keeps polling until the deadline.
   - `mapTokens`:
     - `refreshToken` is the real one.
     - `expiresIn` comes from JWT `exp`.
     - `email` is `jwt.email || jwt.sub`. This matches the import path, so the same account merges onto the same row.
     - `providerSpecificData: { machineId, authMethod: "browser", userId }`.
2. **Refresh: add a new refresher module.**
   - Create `refreshCursorToken(refreshToken, log, proxyOptions)` in a **new** `open-sse/services/tokenRefresh/cursor.js`. `tokenRefresh/providers.js` is already about 900 lines, well past the 500-line soft cap.
   - It sends `POST {refreshUrl}` with `Authorization: Bearer <refreshToken>`.
   - It returns `{accessToken, refreshToken: new ?? old, expiresAt: fromJwt(accessToken)}`. Return `expiresAt` rather than `expiresIn`; `updateProviderCredentials` and `mergeRefreshedCredentials` both handle it.
   - Wrap it in `dedupRefresh("cursor", refreshToken, ...)`.
   - On 401/403, return `{error: "unrecoverable_refresh_error"}` so it is not retried.
3. **Executor changes.**
   - Remove `supportsRefresh = false`.
   - Add `canRefreshCredentials(c) => !!c?.refreshToken`. Legacy imports without an RT then still skip the futile 3-attempt `refreshWithRetry`. Handlers already consult this hook.
   - `refreshCredentials(credentials, log, proxyOptions)` delegates to `refreshCursorToken`.
4. **Usage.**
   - Add `getCursorUsage(accessToken, psd, proxyOptions)`. It calls Connect-JSON `POST https://api2.cursor.sh/aiserver.v1.DashboardService/GetCurrentPeriodUsage` and `/GetPlanInfo` with body `{}`, using `Promise.allSettled` so a plan failure never blanks the usage.
   - Emit quota rows **only from Cursor's percentages**:
     - `Total` from `totalPercentUsed`.
     - `Auto` from `autoPercentUsed`.
     - `API` from `apiPercentUsed`.
     - Optionally `On-demand` from `spendLimitUsage.individualUsed/individualLimit`, but only when `individualLimit > 0`.
   - Each row gets `remainingPercentage = 100 - pct` and `resetAt = parseResetTime(billingCycleEnd)`.
   - Return `{ plan, planId, quotas, message }`, following the zed handler shape (`open-sse/services/usage/zed.js`).
5. **Weighted strategy (YAN-258/260).**
   - In `src/sse/services/quotaSnapshotSync.js`:
     - `kindForName("cursor")` maps `Total` to `"month"` and everything else to `null`. `Auto` and `API` do not correspond to model ids, so keep them out of routing headroom for now.
     - `planTierFor("cursor")` returns the normalized `usage.planId`.
   - Add a `PLAN_CAPACITY.cursor` table in `open-sse/config/quotaSnapshot.js`.

### Technology choices

- **Transport.**
  - Use `fetchWithTimeout` / `proxyAwareFetch` from `open-sse/services/usage/shared.js` for poll, refresh, and usage. These are api2 HTTP/1.1 Connect-JSON and REST endpoints, so they need neither HTTP/2 nor protobuf. That keeps them proxy-aware, unlike AgentService, which is HTTP/2-only and has no proxy path.
  - Poll runs in the Next route through the global fetch, which `open-sse/index.js` patches.
- **Headers.**
  - Start with `Authorization`, `Content-Type: application/json`, and `connect-protocol-version: 1`.
  - If live testing shows the checksum is required, reuse `buildCursorHeaders()` from `open-sse/utils/cursorChecksum.js` and override `content-type`. Do not use `CursorService.buildHeaders`: it is a stale duplicate with a different checksum algorithm and no callers.
- **JWT exp.**
  - Add one helper, e.g. `getJwtExpiryMs(token)`, in a new `open-sse/shared/cursorAuth.js`. Model it on `decodeJwtPayload` in `src/lib/oauth/kiroExternalIdp.js`.
  - `src/lib/oauth/**` may import `open-sse/*`; the reverse is not allowed.
  - If `exp` is missing, fall back to a registry constant, not a literal.
- **machineId.**
  - Generate `crypto.randomBytes(32).toString("hex")` (64-hex, which `validateImportToken`'s regex accepts), **or** derive it deterministically (see Key Decisions).
  - Store it only in `providerSpecificData`; nothing touches the filesystem.
- **Constants.** Put every URL and path in `open-sse/providers/registry/cursor.js` under `oauth` (`loginUrl`, `pollUrl`, `refreshUrl`, `dashboardService` paths, `refreshLeadMs`). No hard-coded strings in handlers, per the AGENTS.md config-driven rule.

### Phasing

| Phase | Scope                                                                                                              | Parallel?                         |
| ----- | ------------------------------------------------------------------------------------------------------------------ | --------------------------------- |
| 0     | Contract: registry constants, `features.usage`, `open-sse/shared/cursorAuth.js` (JWT exp, machineId, URL builders) | Single owner; small; blocks 1     |
| 1     | A: login backend. B: refresh backend and executor. C: usage and weighted hooks. D: UI                              | 4 parallel agents, disjoint files |
| 2     | Integration: baseline scripts, `npm test` gate, `next build`, live check in the dev container, CHANGELOG           | Single owner                      |

### Quick wins

- **Fix import `expiresAt`** in `src/app/api/oauth/cursor/import/route.js` and `CursorService.validateImportToken` so it comes from JWT `exp`. That is a one-line behavior fix: the connection no longer looks expired after 24h, and `shouldRefreshCredentials` stops being true on every request.
- **Put `cursor` in the device-code provider list** in `OAuthModal.js`. It is one line. Without it the modal throws "not wired in the OAuth modal device-code list" (`OAuthModal.js` ~L434).
- **Add an explicit `cursor` case** in `ProviderLimits/utils.js` `parseQuotaData` that passes `remainingPercentage` through. The `default` branch drops it, which would render 0/0 bars.
- **Upgrade the provider test.** In `src/app/api/providers/[id]/test/testUtils.js`, change `cursor: { tokenExists: true }` to `{ checkExpiry: true, refreshable: true }` once refresh exists.

## Improvement Ideas

- **Preserve upstream auth status.** `classifyCursorError` (`open-sse/executors/cursor.js` ~L237) downgrades every Connect JSON error that isn't update-required or quota to **400**. An expired or revoked token (`unauthenticated` / `permission_denied`) therefore never reaches the chatCore 401/403 refresh path. Map those codes to 401/403 so the refresh path actually runs. The change is small, but coordinate it with B's executor ownership.
- **Derive modal device-code support from the server.** The `/authorize` response already returns `flowType`. The modal could route every `device_code` provider generically instead of keeping hard-coded lists in `OAuthModal.js` (master) or `DEVICE_CODE_PROVIDERS` (re-design). This avoids editing a list for every provider. Do it on `re-design`, not here.
- **Auto-import could also read `cursorAuth/refreshToken`** from `state.vscdb`. However, that shares the RT with the running IDE; see the rotation risk. If adopted, keep it opt-in.
- **Plan fetch cadence.** `GetPlanInfo` rarely changes. It could follow the claude pattern (`planTierCheckedAt`, 24h `profileRecheckMs`), but two cheap calls per probe are acceptable for v1.
- **Dead code.** `CursorService.generateChecksum` / `buildHeaders` / `detectOS` / `detectArch` duplicate `cursorChecksum.js` with a different, outdated algorithm. Remove them in A's scope.
- **Alternative tier source.** `api2.cursor.sh/auth/full_stripe_profile` (`membershipType`) is what community clients use. Keep it as a fallback if `GetPlanInfo` drifts.

## Risk Assessment

### Technical risks

| Risk                                                                                                                                                                         | Likelihood | Impact                                              | Mitigation                                                                                                                                                                                                                                               |
| ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------- | --------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Undocumented endpoint drift (`loginDeepControl` params, `auth/poll` 404 semantics, DashboardService field names)                                                             | Med        | High (login or usage breaks silently)               | All URLs in registry; tolerant parsing (camelCase and snake_case, int64-as-string); usage returns a `message` instead of throwing; unit tests pin fixtures from the live-verified payload                                                                |
| `exchange_user_api_key` contract unclear. One community client posts an **API key** there and says "nothing known accepts" the RT; the spec and cursed-gateway say Bearer RT | Med        | High (no refresh, and after about 60 days re-login) | Live-verify in the `9router-dev` container before merging; on 4xx return unrecoverable so the UI shows re-auth; keep `expiresAt` accurate so failure is visible, not silent                                                                              |
| Refresh-token rotation race (request path, background refresher, usage poller, cloud sync across instances; IDE sharing an imported RT)                                      | Med        | Med (connection invalidated)                        | `withCredentialRefreshLock` (per connectionId) plus `dedupRefresh` cover a single process; `refreshLeadMs` of about 24h means refresh is rare; don't refresh imported connections unless they came with their own RT; document the multi-instance caveat |
| Percent scale ambiguity (0–1 vs 0–100)                                                                                                                                       | Low-Med    | Med (bars 100x off)                                 | Pin with the live fixture; clamp to 0–100; test both edges                                                                                                                                                                                               |
| Connect-JSON int64 serialized as strings (`billingCycleEnd`, cents fields)                                                                                                   | High       | Low                                                 | `parseResetTime` / `toFiniteNumber` already accept numeric strings                                                                                                                                                                                       |
| Plan name normalization (`"Pro+"`, `"Ultra"`, `"Business"`) vs `PLAN_CAPACITY` keys                                                                                          | Med        | Low (weight falls back to 1)                        | Normalize in the handler (`pro+` to `pro_plus`, and so on); mark capacity values `_verify`                                                                                                                                                               |
| `mergeReloginProviderData`: fresh values win, so a re-login overwrites `machineId` (and PKCE over an imported row replaces the IDE machineId)                                | High       | Low                                                 | Deterministic machineId, or accept rotation (see decisions)                                                                                                                                                                                              |
| `email` is the JWT `sub` (Cursor JWTs usually lack email), so the display shows `auth0\|user_...`                                                                            | High       | Low (cosmetic)                                      | Set `displayName` from plan or profile if one is available; keep `sub` as the dedup key                                                                                                                                                                  |

### Integration challenges

- **Master/re-design divergence.** `re-design` has rewritten `OAuthModal.js` (hook plus `oauth/authFlowHelpers.js` `DEVICE_CODE_PROVIDERS`/`buildDeviceExtraData`) and `CursorAuthModal.js` (Signal overlays). Keep master UI edits to the smallest possible diff: one list entry, plus a new `CursorOAuthWrapper.js` modeled on `KiroOAuthWrapper.js`, plus a one-line swap in `providers/[id]/page.js`. The next `chore(redesign): sync master` should then only need a trivial conflict resolution. Flag it for whoever runs the sync.
- **Two refresh entry points.** `checkAndRefreshToken` goes through `REFRESH_HANDLERS`. `/api/usage/[connectionId]`, the quota poller, and chatCore go through `executor.refreshCredentials`. Missing either one leaves a stale-token path.
- **Background refresher** (`src/sse/services/backgroundTokenRefresh.js`) only selects connections with a `refreshToken` and a finite expiry. PKCE connections join automatically. Legacy imports stay excluded, which is correct.
- **`USAGE_SUPPORTED_PROVIDERS`** is derived from `features.usage`, so turning it on makes Cursor rows appear in ProviderLimits and `/api/providers/client` ordering. Make sure the handler lands in the same PR.
- **Dashboard guard.** New traffic uses the existing `/api/oauth/cursor/device-code|poll`, which falls under `/api/oauth` (protected but not local-only). This is correct: browser login must work remotely. Do **not** add it to `LOCAL_ONLY_PATHS`.

### CI and baselines

- `verify-providers.mjs`: adding `oauth.tokenUrl` would inject `PROVIDERS.cursor.tokenUrl`, which is ignored via `ADDED_FIELDS`. Prefer a distinct key such as `refreshUrl` inside `oauth`; it is not injected into transport, so there is no diff. Do not change `transport` fields or `clientVersion`.
- `verify-oauth-urls.mjs`: unaffected unless someone opts to add cursor URLs. If so, regenerate with `--snapshot` in the same PR and call it out in the PR body.
- `verify-alias.mjs`: unaffected.
- **known-fails gate.** Any new test failure outside `known-fails.txt` fails CI, so new tests must be green in the isolated run. All 8 existing `oauth-cursor-auto-import.test.js` cases are already known-fail; leave that file alone. If a change turns a known failure green, the gate still passes, but refresh `known-fails.txt` for hygiene.

### Performance

- Usage makes two small JSON calls per probe, with a 10s timeout each, in parallel. The poller runs only for weighted providers and is stale-gated at 15 min, which is negligible.
- Login polling: every 2s for at most 300s, all client-driven, with no server-side state or timers.

### Security

- The PKCE verifier and uuid are returned to the authenticated dashboard client (same as qoder and other device flows). Anyone holding both can claim the tokens until they are consumed. Never log poll or refresh responses or tokens; the existing `console.log("OAuth POST error:", error)` logs errors only.
- Tokens persist only in SQLite under `DATA_DIR`. Nothing writes to the filesystem, which keeps the production Docker read-only root filesystem safe. There is no `node-machine-id` dependency and no temp files.
- The refresh token lasts about 60 days or more and is a high-value secret. Make sure it is covered by whatever encrypts or redacts `refreshToken` elsewhere (cloud sync, export, and the connection API responses that strip tokens).
- `redirectTarget=cli` impersonates the cursor-agent CLI login. Assume the same ToS and anti-abuse exposure as the existing executor (which already spoofs IDE headers).

## Alternative Approaches

| Option                                                                                               | Pros                                                                              | Cons                                                                                                     |
| ---------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------- |
| **A. Reuse `device_code` flow (recommended)**                                                        | No route changes; the modal already supports it; qoder precedent; works in Docker | `user_code` is synthetic; the modal list needs one entry                                                 |
| B. New bespoke routes `/api/oauth/cursor/login-start` and `/login-poll` plus a custom modal          | Full UX control                                                                   | Duplicates poll/persist logic; more re-design conflicts; needs `dashboardGuard` review                   |
| C. Server-side poll loop (server polls, client polls `poll-status`, like the codex/xai session maps) | Verifier never leaves the server                                                  | In-memory session maps break across restarts and multiple instances; more code; nothing already needs it |
| Refresh via `oauth/token` (`grant_type=refresh_token`) instead of `exchange_user_api_key`            | Standard shape; could reuse `refreshAccessToken` profiles                         | No client id known, and it contradicts the live verification; keep only as a documented fallback         |
| Usage from `usage-summary` / `full_stripe_profile` REST                                              | Simpler JSON                                                                      | Less detail (no auto/api split); spend/limit is misleading with bonus credits                            |

## Task Breakdown Preview

**Phase 0: contract (one owner, first)**

- T0.1 `open-sse/providers/registry/cursor.js`:
  - Add `oauth.loginUrl`, `oauth.pollUrl`, `oauth.refreshUrl`, `oauth.usagePaths` (`GetCurrentPeriodUsage`, `GetPlanInfo` under `/aiserver.v1.DashboardService/`), `oauth.refreshLeadMs` (e.g. 86_400_000), `oauth.defaultTokenTtlSec`.
  - Add `features.usage: true`.
  - Run `verify-providers.mjs` afterwards.
- T0.2 New `open-sse/shared/cursorAuth.js`: `getJwtExpiryMs(token)`, `getJwtSubject(token)`, `generateCursorMachineId(seed?)`, `buildCursorLoginUrl({challenge, uuid})`, `normalizeCursorPlan(name)`. These are pure functions.

**Phase 1: parallel (disjoint ownership)**

- **A. Login backend.** Owns `src/lib/oauth/providers/cursor.js`, `src/lib/oauth/services/cursor.js`, `src/app/api/oauth/cursor/import/route.js`, and new `tests/unit/cursor-oauth-pkce.test.js`.
  - Device-code provider (request, poll, map).
  - Poll status mapping: 404 is pending, 200 is success, 403 is `access_denied`.
  - Import `expiresAt` from JWT.
  - Remove dead checksum code.
  - Depends on T0.
- **B. Refresh backend.** Owns new `open-sse/services/tokenRefresh/cursor.js`, `open-sse/services/tokenRefresh.js` (handler plus re-export), `open-sse/executors/cursor.js` (`supportsRefresh`, `canRefreshCredentials`, `refreshCredentials`, optional 401 classification), `src/app/api/providers/[id]/test/testUtils.js`, and new `tests/unit/cursor-token-refresh.test.js`. Depends on T0.
- **C. Usage and weighting.** Owns new `open-sse/services/usage/cursor.js`, `open-sse/services/usage.js`, `src/sse/services/quotaSnapshotSync.js`, `open-sse/config/quotaSnapshot.js`, and new `tests/unit/cursor-usage.test.js`. Depends on T0.
- **D. UI.** Owns:
  - New `src/shared/components/CursorOAuthWrapper.js` (method picker: "Login with browser", which uses `OAuthModal`, or "Import from Cursor IDE", which uses the existing `CursorAuthModal`).
  - `src/shared/components/index.js` export.
  - `src/shared/components/OAuthModal.js` (add `cursor` to the list).
  - `src/app/(dashboard)/dashboard/providers/[id]/page.js` (swap the modal).
  - `src/app/(dashboard)/dashboard/usage/components/ProviderLimits/utils.js` (`cursor` case).
  - Depends only on API shapes, so it can start immediately against the contract.

**Phase 2: integration (one owner)**

- T2.1 Run `node tests/__baseline__/verify-{providers,alias,oauth-urls}.mjs`, then `npm test` (known-fails gate), `npm run lint`, and `npm run build`.
- T2.2 Live smoke test in the `9router-dev` container:
  - Browser login.
  - Chat request.
  - Force refresh by setting `expiresAt` to the past.
  - Usage card, plan badge, and weight.
- T2.3 CHANGELOG entry; PR with `Closes #253`, a note for the re-design sync, and a Conventional Commit title (`feat(cursor): …`).

**Critical tests only**

- (A) Poll mapping: 404 is pending, 200 is tokens with `expiresIn` from JWT, 403 is `access_denied`. `mapTokens` sets `machineId`, `refreshToken`, and email from `sub`.
- (B) Refresher:
  - Sends Bearer RT.
  - Keeps the old RT when the response has none.
  - Takes `expiresAt` from the new JWT.
  - Returns unrecoverable on 401.
  - `CursorExecutor.canRefreshCredentials` is false without an RT.
- (C) Usage parser:
  - Percent rows, with `remainingPercentage` = 100 − pct.
  - `billingCycleEnd` string epoch-ms converts to ISO.
  - Plan normalization.
  - A plan-call failure still returns quotas.
  - `kindForName("cursor","Total")` returns `"month"`.

## Key Decisions Needed

1. **machineId strategy.** Random per connection (spec wording; rotates on re-login because fresh `psd` wins in `mergeReloginProviderData`), or deterministic `sha256(sub + install salt)`, which is stable across re-logins without a DB lookup. Recommendation: deterministic.
2. **PKCE over an existing imported row.** Both paths use `sub` as the email, so they collapse onto one row. Accept this and treat it as an upgrade path (recommended), or keep them separate by setting `providerSpecificData.username`?
3. **Should imported connections get refresh?** Only if the import supplies its own RT. Reading the IDE's RT risks rotation fights with the IDE. Recommendation: no for v1.
4. **Which quota rows drive weighting.** `Total` maps to `month` only (recommended), or also `Auto`/`API` as `model:*` windows.
5. **`PLAN_CAPACITY.cursor` values.** Suggested: free 0.05, pro 1, pro_plus 3, ultra 20, business/team 1, all marked `_verify`.
6. **Scope of the `classifyCursorError` 401/403 fix.** Include it in B, or split it into a follow-up?
7. **Opt-in `verify-oauth-urls` coverage** for the Cursor URLs (requires a snapshot refresh in this PR).

## Open Questions

- What exactly does `exchange_user_api_key` accept (Bearer RT vs body `{apiKey}`), and does it rotate the RT? What is the token TTL in the response?
- Are `totalPercentUsed` and similar values on a 0–100 or 0–1 scale, and are they null for free or legacy (request-based) plans?
- Does DashboardService require the `x-cursor-checksum` / client-version headers, or is Bearer alone enough?
- Which `GetPlanInfo.planName` strings exist (`Pro`, `Pro+`, `Ultra`, `Business`, `Free Trial`)? Is a machine-readable plan id available?
- Does the deep-control login return `userId` in the poll response, and can we get an email for display?
- Do CLI-issued tokens (`redirectTarget=cli`) have the same AgentService entitlements and rate limits as IDE tokens?
- Are team or enterprise accounts affected by `sign_in_policy_violation` (device policy), and what should the UI say?
- Does cloud sync push refreshed tokens between instances fast enough to avoid rotation conflicts?

## Relevant Docs

- `CLAUDE.md`, `open-sse/AGENTS.md` (config-driven constants, executor conventions), `docs/plans/yan-259-quota-snapshot/`, `docs/plans/yan-260-weighted-account-strategy/`
- [cursed-gateway Cursor account SDK (poll 404 = pending, `exchange_user_api_key`, `full_stripe_profile`)](https://pkg.go.dev/github.com/CoreUnit-NET/cursed-gateway/lib/cursor/account)
- [AgentLodge PR #65 (deep-control PKCE, 403 `sign_in_policy_violation`, refresh caveats)](https://github.com/wrfly/AgentLodge/pull/65)
