# YAN-385 — Cursor PKCE login, token refresh, usage: technical research

## Executive Summary

Cursor can reuse the existing generic **device_code** machinery almost unchanged. The
dynamic route `src/app/api/oauth/[provider]/[action]/route.js` already has a generic
PKCE path. For any device-code provider **not** listed in `noPkceDeviceProviders`, the
route generates a PKCE pair, passes `codeChallenge` into `requestDeviceCode`, returns
`codeVerifier` to the modal, and on `poll` calls `pollForToken(provider, deviceCode,
codeVerifier)`. Cursor fits that path as-is if we treat `uuid` as `device_code`. The
`machineId` does not have to come from start time. Cursor's login and poll endpoints
never see it, so we generate it in `mapTokens` when login succeeds. That means **no route
changes and no `extraData`** are needed. That is simpler than the Qoder pattern.

Refresh means adding a `cursor` entry to `REFRESH_HANDLERS`, backed by a new
`refreshCursorToken` in `open-sse/services/tokenRefresh/providers.js`, and turning on
`supportsRefresh` in `CursorExecutor`. Usage is a new `open-sse/services/usage/cursor.js`
wired through `USAGE_HANDLERS`, `features.usage: true`, `transport.usage`, a `cursor`
case in `parseQuotaData`, and `kindForName` + `planTierFor` + `PLAN_CAPACITY.cursor` for
the weighted strategy.

Nothing needs a migration. `providerSpecificData` is stored in the JSON `data` column.
The OAuth-URL baseline is not affected. The providers baseline stays green because
`transport.usage` is in `ADDED_FIELDS`.

---

## Architecture Design

### Component diagram

```
Dashboard  providers/[id]/page.js ──► CursorAuthModal (tabs: "Browser login" | "Import")
                                          │ Browser tab renders
                                          ▼
                                   OAuthModal provider="cursor"   (device-code branch)
   GET /api/oauth/cursor/device-code ─────┘  │   POST /api/oauth/cursor/poll  (loop, 1s×1.2 → 10s)
            │                                 │
            ▼                                 ▼
  route.js generic PKCE branch        route.js generic PKCE else-branch
  generateAuthData() → PKCE pair      pollForToken("cursor", uuid, verifier)
  requestDeviceCode("cursor", challenge)       │
            │                                  ▼
            ▼                         src/lib/oauth/providers/cursor.js  pollToken → mapTokens
  src/lib/oauth/providers/cursor.js            │  (mints machineId, JWT exp → expiresIn)
  requestDeviceCode (uuid, loginUrl)           ▼
                                      createProviderConnection(authType "oauth") [route]

Runtime:  chat.js → checkAndRefreshToken (src/sse/services/tokenRefresh.js)
          → oauthCredentialManager.refreshProviderCredentials → REFRESH_HANDLERS.cursor
          → refreshCursorToken (POST /auth/exchange_user_api_key)
          chatCore 401/403 → CursorExecutor.refreshCredentials (now real)

Usage:    GET /api/usage/[id] → refreshAndUpdateCredentials (executor.needsRefresh/refreshCredentials)
          → getUsageForProvider → USAGE_HANDLERS.cursor → usage/cursor.js
              (GetCurrentPeriodUsage + GetPlanInfo, Promise.allSettled)
          → recordUsageSnapshot (kindForName/planTierFor "cursor") → quotaSnapshot + psd.planTier
          → ProviderLimits parseQuotaData("cursor") → QuotaTable
```

### New components

| File                                            | Purpose                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                            |
| ----------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `open-sse/shared/cursorAuth.js` (new)           | Single home for Cursor auth HTTP and helpers: `buildCursorLoginUrl({challenge, uuid})`, `pollCursorAuth({uuid, verifier})`, `exchangeCursorRefreshToken(refreshToken)`, `getCursorJwtExpiresIn(token)`, `generateCursorMachineId()`. Uses the same pattern as `open-sse/shared/zedAuth.js` and `mimoAccount.js`. It lives in open-sse because both `src/lib/oauth` (app side) and `open-sse/services/tokenRefresh` (engine side) need it. `src → open-sse` imports are normal; `open-sse → src` is the boundary crossing to avoid. |
| `open-sse/services/usage/cursor.js` (new)       | `getCursorUsage(accessToken, psd, proxyOptions)`, plus the pure `parseCursorUsage(periodUsage, planInfo)` and `cursorPlanTier(planName)` exported for tests.                                                                                                                                                                                                                                                                                                                                                                       |
| `tests/unit/cursor-oauth.test.js` (new)         | Tests `requestDeviceCode`/`pollToken`/`mapTokens` with mocked fetch: 404 → pending, 200 → tokens, 403 policy → `access_denied`, and the JWT exp → expiresIn mapping.                                                                                                                                                                                                                                                                                                                                                               |
| `tests/unit/cursor-token-refresh.test.js` (new) | Tests `refreshCursorToken`: success, a rotated vs missing refreshToken, 401 → `{error:"invalid_grant"}`, dedup. Also checks the `REFRESH_HANDLERS.cursor` dispatch.                                                                                                                                                                                                                                                                                                                                                                |
| `tests/unit/cursor-usage.test.js` (new)         | Parser windows, the plan label and tier, the 401 message, and a `parseQuotaData("cursor")` round-trip. Model it on `tests/unit/zed-usage.test.js`.                                                                                                                                                                                                                                                                                                                                                                                 |

### Integration points (existing code that is reused as-is)

- `generateAuthData` → `generatePKCE()` (`src/lib/oauth/providers/index.js:87-127`, `src/lib/oauth/utils/pkce.js`). This gives a 32-byte base64url verifier and an S256 challenge. That is exactly what Cursor's `loginDeepControl` expects.
- `pollForToken` (`src/lib/oauth/providers/index.js:174-224`). `{ok:false, data:{error:"authorization_pending"}}` → pending. `{ok:true, data:{access_token,...}}` → `mapTokens`.
- Route device-code (`route.js:272-326`) and poll (`route.js:543-616`): the generic PKCE branches (`route.js:311-313` and `route.js:576-582`).
- `createProviderConnection` dedup (`src/lib/db/repos/connectionsRepo.js:178-238`). It dedups only when `email` is set. `mergeReloginProviderData` (`:164-176`) lets fresh psd win but keeps `weight` and manual `planTier`.
- `checkAndRefreshToken` (`src/sse/services/tokenRefresh.js:225-270`) and background refresh (`src/sse/services/backgroundTokenRefresh.js:43-71`). This selects OAuth connections that have a `refreshToken` and whose `expiresAt` is inside `max(providerLead, 30min)`.
- `refreshAndUpdateCredentials` in `src/app/api/usage/[connectionId]/route.js:31-127`. It uses `executor.needsRefresh` / `executor.refreshCredentials`, so the executor **must** implement refresh or usage probes will never refresh.
- `recordUsageSnapshot` / `buildQuotaSnapshotView` (`src/sse/services/quotaSnapshotSync.js:175-221`) and the snapshot poller (`src/shared/services/quotaSnapshotPoller.js`).

---

## Data Models

Connection row (`providerConnections`). Top-level columns plus a JSON `data` blob that
holds `providerSpecificData` and the optional fields (`connectionsRepo.js:5-27`,
`rowToConn`). **No migration is needed.** Every new field lives in `providerSpecificData`
or in existing optional columns.

| Field                                | Browser (PKCE) login                                                   | Import (existing, updated)                                                    | Notes                                                                                                                                       |
| ------------------------------------ | ---------------------------------------------------------------------- | ----------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------- |
| `provider`                           | `"cursor"`                                                             | `"cursor"`                                                                    |                                                                                                                                             |
| `authType`                           | `"oauth"`                                                              | `"oauth"`                                                                     | Unchanged. Usage and refresh eligibility key off `oauth`.                                                                                   |
| `accessToken`                        | Cursor session JWT                                                     | IDE `cursorAuth/accessToken`                                                  |                                                                                                                                             |
| `refreshToken`                       | from `/auth/poll`                                                      | `null` today. Optionally `cursorAuth/refreshToken` (see Open Questions).      | A present refreshToken is what turns on proactive and background refresh.                                                                   |
| `expiresAt`                          | `now + expiresIn`, where expiresIn comes from the JWT `exp`            | **Fix:** JWT `exp` instead of the hard-coded 86400 (`services/cursor.js:122`) | Tokens last about 60 days.                                                                                                                  |
| `email`                              | `extractUserInfo(jwt).email` (= `email` or `sub`)                      | same                                                                          | Keeps PKCE and import rows deduping onto the same row per account.                                                                          |
| `psd.machineId`                      | **new**: `generateCursorMachineId()` = 64-hex (`sha256(randomUUID())`) | IDE `storage.serviceMachineId`                                                | Required: `CursorExecutor.buildHeaders` throws without it (`open-sse/executors/cursor.js:288-290`). Also required by `cursorModels.js:147`. |
| `psd.authMethod`                     | `"browser"` (or `"pkce"`)                                              | `"imported"`                                                                  | Lets the UI and debugging tell them apart.                                                                                                  |
| `psd.userId`                         | JWT `sub`                                                              | JWT `sub`                                                                     |                                                                                                                                             |
| `psd.planTier` / `planTierCheckedAt` | Written by `persistPlanTier` after a usage probe                       | same                                                                          | Kept across re-login unless it was set manually.                                                                                            |
| `psd.ghostMode`                      | unset (defaults true)                                                  | unset                                                                         | The existing executor reads it.                                                                                                             |

The poll payload flowing through `pollForToken` → `mapTokens` looks like this:
`{ access_token, refresh_token, expires_in }`. It is the snake_case OAuth-like shape
that `pollForToken` checks for (`result.data.access_token`).

---

## API Design

### `GET /api/oauth/cursor/device-code` (existing dynamic route, no code change)

- The route calls `generateAuthData("cursor", null)` → PKCE, then `requestDeviceCode("cursor", codeChallenge)`, because cursor is **not** added to `noPkceDeviceProviders`.
- `cursor.requestDeviceCode(config, codeChallenge)` makes no network call. It returns:

```json
{
  "device_code": "<uuid v4>",
  "user_code": null,
  "verification_uri": "https://cursor.com/loginDeepControl",
  "verification_uri_complete": "https://cursor.com/loginDeepControl?challenge=<S256>&uuid=<uuid>&mode=login&redirectTarget=cli",
  "expires_in": 300,
  "interval": 1,
  "interval_backoff": { "factor": 1.2, "max": 10 }
}
```

- The route adds `codeVerifier` (`route.js:315-320`). Errors: 400 if flowType is not `device_code`; 500 when something throws.

### `POST /api/oauth/cursor/poll` (existing, no code change)

- Body: `{ deviceCode: <uuid>, codeVerifier, extraData: null }`. The else-branch at `route.js:576-582` requires `codeVerifier` (400 `Missing code verifier` without it).
- `cursor.pollToken(config, uuid, verifier)` sends `GET https://api2.cursor.sh/auth/poll?uuid=&verifier=` and maps the result:
  - 404 → `{ok:false, data:{error:"authorization_pending"}}` → route returns `{success:false, pending:true}`.
  - 200 `{accessToken, refreshToken}` → `{ok:true, data:{access_token, refresh_token, expires_in}}`. `expires_in` comes from the JWT `exp`, with a floor of 1 day if it can't be decoded, similar to Qoder.
  - 403 whose body contains `sign_in_policy_violation` (the org device policy) → `{ok:false, data:{error:"access_denied", error_description:"Cursor organization sign-in policy rejected this device"}}`. **The modal only stops on `expired_token`/`access_denied`** (`OAuthModal.js:173-175`). Any other error keeps it polling until the deadline.
  - Other non-OK responses or a network error → `{ok:false, data:{error:"poll_failed", error_description}}`. The modal keeps polling. That is acceptable for transient 5xx errors.
- On success the route calls `createProviderConnection({provider:"cursor", authType:"oauth", ...mapTokens, expiresAt, testStatus:"active"})` (`route.js:584-601`) and returns `{success:true, connection:{id, provider}}`.

### Refresh (engine, not an HTTP route)

`POST https://api2.cursor.sh/auth/exchange_user_api_key`, header
`Authorization: Bearer <refreshToken>`, `Content-Type: application/json`, body `{}`.
The response is `{accessToken, refreshToken?}`.

`refreshCursorToken` returns
`{ accessToken, refreshToken: new ?? old, expiresIn: jwtExp(accessToken) }`.
On 401/403 it returns `{ error: "invalid_grant" }`, which `isUnrecoverableRefreshError`
treats as terminal. Any other failure returns `null`.

### Usage (engine)

- `POST https://api2.cursor.sh/aiserver.v1.DashboardService/GetCurrentPeriodUsage`
- `POST https://api2.cursor.sh/aiserver.v1.DashboardService/GetPlanInfo`
- Headers for both: `Authorization: Bearer`, `Content-Type: application/json`, `Connect-Protocol-Version: 1`, body `{}`.
- The handler returns this shape (it must match what `parseQuotaData` and `recordUsageSnapshot` consume):

```js
{
  plan: "Pro",                  // planInfo.planName (display)
  planName: "Pro",              // raw, used by planTierFor
  quotas: {
    "Total":           { used, total, remainingPercentage, resetAt },       // 100 - totalPercentUsed
    "Auto + Composer": { used, total: 100, remainingPercentage, resetAt },  // 100 - autoPercentUsed
    "API":             { used, total: 100, remainingPercentage, resetAt },  // 100 - apiPercentUsed
    "On-demand ($)":   { used, total, remainingPercentage, resetAt }        // spendLimitUsage (cents/100)
  },
  billingCycleStart, billingCycleEnd,   // ISO via parseResetTime
  message: null                         // MUST NOT be a string on success (poller treats string as failure)
}
```

- Errors: 401/403 → `{ message: "Cursor authentication expired (401). Re-authorize the connection." }`. The words "expired"/"401" trigger the force-refresh retry in `usage/[connectionId]/route.js:19-24,186-194`. Other errors → `{ message: "Cursor error: ..." }`.

---

## System Constraints

- **Proxy:** use `fetchWithTimeout(url, opts, ms, proxyOptions)` from `open-sse/services/usage/shared.js:167` for usage. The refresh code uses plain `fetch`, which `open-sse/index.js` patches for env proxies. That matches the other refreshers.
- **Timeouts:** usage has a 10s default. Run both RPCs with `Promise.allSettled`. If `GetPlanInfo` fails, show usage without a plan. If `GetCurrentPeriodUsage` fails, return the message.
- **Dedup and locks:** wrap refresh in `dedupRefresh("cursor", refreshToken, ...)`. `refreshProviderCredentials` already adds the per-connection lock.
- **Refresh lead:** 60-day tokens with a 5-minute default lead are fine. Adding `oauth.refreshLeadMs: 86_400_000` (1 day, the same as iflow) to the registry gives slack for sleeping or offline hosts. `REFRESH_LEAD_MS` is derived from the registry (`appConstants.js:205-209`).
- **Security:** `dashboardGuard.js` already protects `/api/oauth/*` (`:44`). `auto-import` is **LOCAL_ONLY** (`:65`). That is why browser login is the only way to connect a Docker or remote deployment (prod runs in a container). The PKCE verifier goes to the authenticated dashboard client, same as Qoder today. Never log tokens or the verifier.
- **Undocumented API:** all Cursor endpoints are reverse-engineered. Parse defensively (numbers may arrive as strings; `billingCycleEnd` may be epoch-ms strings or RFC3339 — `parseResetTime` handles both).
- **File size:** `OAuthModal.js` (1002 lines) and `ProviderLimits/index.js` (1539 lines) are already far over the ~500-line target. Keep edits there minimal and put the logic in the new modules.

---

## Codebase Changes

### Create

1. `open-sse/shared/cursorAuth.js`: the helpers listed above. Endpoints come from the registry `oauth` block (`PROVIDER_OAUTH.cursor`), never hard-coded, following the Trae precedent at `tokenRefresh/providers.js:754-757`.
2. `open-sse/services/usage/cursor.js`: `getCursorUsage` + `parseCursorUsage` + `cursorPlanTier`. Read URLs via `U("cursor")` (`usage/shared.js:7`).
3. The three unit test files listed under New components.

### Modify

| File:line                                                                        | Change                                                                                                                                                                                                                                                                                                                                                                                                                                                       |
| -------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `open-sse/providers/registry/cursor.js:15-27` (transport)                        | Add `usage: { url: "https://api2.cursor.sh/aiserver.v1.DashboardService/GetCurrentPeriodUsage", planInfoUrl: ".../GetPlanInfo" }`. `usage` is in `ADDED_FIELDS` (`verify-providers.mjs:13-34`), so the baseline stays green. **Do not** add `tokenUrl`/`clientId` to `oauth`. `OAUTH_INJECT_FIELDS` would copy them into `PROVIDERS.cursor`, and the generic `refreshAccessToken` fallback would start firing form-encoded OAuth2 refreshes.                 |
| `open-sse/providers/registry/cursor.js:44-57` (oauth)                            | Add `loginUrl: "https://cursor.com/loginDeepControl"`, `pollUrl: "https://api2.cursor.sh/auth/poll"`, `refreshUrl: "https://api2.cursor.sh/auth/exchange_user_api_key"`, `refreshLeadMs: 86400000`. `CURSOR_CONFIG` (`src/lib/oauth/constants/oauth.js:84-91`) spreads these automatically.                                                                                                                                                                  |
| `open-sse/providers/registry/cursor.js:58-60` (features)                         | Add `usage: true`. That puts cursor into `USAGE_SUPPORTED_PROVIDERS` (`src/shared/constants/providers.js:224`), the usage page list, and `/api/providers/client` eligibility.                                                                                                                                                                                                                                                                                |
| `src/lib/oauth/providers/cursor.js:1-19`                                         | `flowType: "device_code"`. Add `requestDeviceCode`, `pollToken`, and a `mapTokens` that handles both shapes: poll (`access_token`) and the legacy import camelCase (`accessToken`), used by nothing else. Keep `machineId` from input when present (import), otherwise mint one. Set `authMethod` by source. No other consumer reads `flowType: "import_token"` (grep confirms: only `route.js:274`, `providers/index.js:103,161,176`, `OAuthModal.js:434`). |
| `src/lib/oauth/services/cursor.js:95-125`                                        | `validateImportToken`: compute `expiresIn` from the JWT `exp` through the shared helper instead of `86400`. `extractUserInfo` (`:131-153`) can delegate to the shared JWT decode.                                                                                                                                                                                                                                                                            |
| `src/app/api/oauth/cursor/import/route.js:34-48`                                 | Uses `tokenData.expiresIn` (it now comes from the JWT). Optional: accept `refreshToken` in the body (see Open Questions).                                                                                                                                                                                                                                                                                                                                    |
| `open-sse/services/tokenRefresh/providers.js:855-861`                            | Add `export async function refreshCursorToken(refreshToken, log)` next to `refreshZedToken`. Update the "Mirrors cursor/kilocode null-refresh pattern" comment at `:857` so it no longer names cursor.                                                                                                                                                                                                                                                       |
| `open-sse/services/tokenRefresh.js:3-43,142-181`                                 | Import and re-export `refreshCursorToken`. Add `cursor: (c, log) => refreshCursorToken(c.refreshToken, log)` to `REFRESH_HANDLERS`.                                                                                                                                                                                                                                                                                                                          |
| `open-sse/executors/cursor.js:276-281`                                           | `this.supportsRefresh = true`. Add `canRefreshCredentials(c){ return !!c?.refreshToken; }`, which chatCore honors at `chatCore.js:584-585`, so imported rows with no RT skip the futile ~3s retry.                                                                                                                                                                                                                                                           |
| `open-sse/executors/cursor.js:830-832`                                           | `refreshCredentials(credentials, log)` → `refreshCursorToken(credentials.refreshToken, log)`. It must return `{accessToken, refreshToken, expiresIn}` for `usage/[connectionId]/route.js:73-96`.                                                                                                                                                                                                                                                             |
| `open-sse/executors/base.js:26-34`                                               | Remove `cursor` from the list of no-refresh executors in the comment.                                                                                                                                                                                                                                                                                                                                                                                        |
| `open-sse/services/usage.js:5-34,42-76`                                          | Import `getCursorUsage` and add `cursor: (c) => getCursorUsage(c.accessToken, c.providerSpecificData, c.proxyOptions)`.                                                                                                                                                                                                                                                                                                                                      |
| `src/app/(dashboard)/dashboard/usage/components/ProviderLimits/utils.js:659-690` | Add `case "cursor":` next to the `zed`/`kimi` cases. It must carry `remainingPercentage` (the `default:` branch at `:691-701` **drops** it, so the bars would read wrong), plus `unlimited` when relevant. The rows sort stably: PROVIDER_MODELS order (`:708-724`) gives 999 for every row, so insertion order is kept.                                                                                                                                     |
| `src/sse/services/quotaSnapshotSync.js:57-104` (`kindForName`)                   | `case "cursor"`: `"total"` → `"month"`, `"auto + composer"` → `"model:default"`, everything else → `null`. Update the JSDoc bullet list at `:46-56`.                                                                                                                                                                                                                                                                                                         |
| `src/sse/services/quotaSnapshotSync.js:112-135` (`planTierFor`)                  | `case "cursor": return cursorPlanTier(usage.planName ?? usage.plan)`. The normalizer only allows known ids, following `codexTier` at `:106-109`.                                                                                                                                                                                                                                                                                                             |
| `open-sse/config/quotaSnapshot.js:19-55` (`PLAN_CAPACITY`)                       | Add `cursor: { free: 0.05, pro: 1, pro_plus: 3, ultra: 20, team: 1 }` (all `_verify`). This also turns on the manual plan dropdown in `EditConnectionModal.js:109` and PUT validation at `src/app/api/providers/[id]/route.js:26-35`.                                                                                                                                                                                                                        |
| `src/shared/components/OAuthModal.js:286-297`                                    | Add `"cursor"` to `deviceCodeProviders`.                                                                                                                                                                                                                                                                                                                                                                                                                     |
| `src/shared/components/OAuthModal.js:130-190` (`startPolling`)                   | Accept an optional backoff param from `data.interval_backoff`. After each pending poll: `interval = Math.min(interval * factor, max)`. Keep the `slow_down` +5 rule. Pass it from the call at `:341-352`.                                                                                                                                                                                                                                                    |
| `src/shared/components/OAuthModal.js:920-936`                                    | Render the "Your Code" block only when `deviceData.user_code` is truthy. Cursor has no user code; Qoder fakes one.                                                                                                                                                                                                                                                                                                                                           |
| `src/shared/components/CursorAuthModal.js:11-50,91-211`                          | Add a mode switch with "Login with browser" (default) and "Import from Cursor IDE". Browser mode renders `<OAuthModal provider="cursor" .../>` the way `KiroOAuthWrapper.js:64-76` does. Move the auto-detect `useEffect` (`:47-50`) so it runs only when import mode is chosen. Otherwise the LOCAL_ONLY endpoint returns 403 noise on remote hosts. Add a `providerInfo` prop.                                                                             |
| `src/app/(dashboard)/dashboard/providers/[id]/page.js:2062-2067`                 | Pass `providerInfo={providerInfo}` to `CursorAuthModal`.                                                                                                                                                                                                                                                                                                                                                                                                     |
| `src/app/api/providers/[id]/test/testUtils.js:87`                                | Change `cursor: { tokenExists: true }` → `{ checkExpiry: true, refreshable: true }` and add `"cursor"` to the runtime-refresher list at `:289-300`. **Caveat:** legacy imported rows carry `expiresAt = import + 24h` and would now read as "Token expired". Either keep `tokenExists` for rows without `refreshToken`, or probe with `GetCurrentPeriodUsage` (recommended; see Technical Decisions).                                                        |
| `tests/unit/usage-dispatch.test.js:14-36`                                        | Add `"cursor"` to `SUPPORTED`.                                                                                                                                                                                                                                                                                                                                                                                                                               |
| `tests/__baseline__/*`                                                           | No change is required. `verify-oauth-urls.mjs` doesn't read cursor, and the new `oauth.refreshUrl` is not injected into `PROVIDERS`. `verify-providers.mjs` ignores `usage`. Run both after the change to confirm.                                                                                                                                                                                                                                           |

If the work lands on **`re-design`**, the same UI edits move. `OAuthModal.js` there is split
into `src/shared/components/oauth/authFlowHelpers.js`, `OAuthDeviceStep.js` and
`src/shared/hooks/useOAuthFlow.js`:

- `DEVICE_CODE_PROVIDERS` Set → add cursor.
- `nextDevicePollInterval(interval, slowDown)` → take the backoff there.
- `OAuthDeviceStep` → hide the user_code block when it is empty.
- `re-design` also rewrote `CursorAuthModal.js`. Expect conflicts.

---

## Technical Decisions

1. **Where the machineId is minted**
   - A) At device-code time, carried in `extraData` (the Qoder `_qoderMachineId` pattern, which needs edits to the route poll branch and the modal `extraData` chain).
   - B) In `mapTokens` when login succeeds.
   - **Recommend B.** Cursor's login and poll never bind the machineId, so the value only has to be stable per connection once it is stored. B needs zero route or modal plumbing. Re-login replaces the machineId, because `mergeReloginProviderData` lets fresh psd win. That is harmless: it only feeds `x-cursor-checksum`.
2. **PKCE source**
   - A) Cursor generates its own pair inside `requestDeviceCode` (as Qoder does).
   - B) Use the route's generic `generateAuthData` pair.
   - **Recommend B.** Cursor stays out of `noPkceDeviceProviders` and falls into the existing "Qwen and other PKCE providers" branches (`route.js:311-313`, `576-582`).
3. **Poll backoff (1s ×1.2 → 10s)**
   - A) Server-side `slow_down` responses.
   - B) A generic, optional `interval_backoff` in the device-code response, honored by the modal.
   - C) A fixed 1–2s interval.
   - **Recommend B.** It is additive: providers that don't set the field keep today's behavior.
4. **Refresh endpoint**
   - A) `/auth/exchange_user_api_key` with the refreshToken as Bearer (the spec).
   - B) `POST api2.cursor.sh/oauth/token` with `grant_type=refresh_token` and Cursor's public client_id (used by some third-party tools, not verified here).
   - **Recommend A** as specified, and return `invalid_grant` on 401/403. Record B as the fallback if A proves unreliable (Open Questions).
5. **Shared Cursor auth module location.** **Recommend `open-sse/shared/cursorAuth.js`.** `tokenRefresh/providers.js` needs it, and importing from `src/lib` is the existing boundary smell (`providers.js:6`). The `src/lib/oauth` side imports from open-sse, which is the normal direction.
6. **Weighted strategy mapping**
   - `Total` → `month` (a global window).
   - `Auto + Composer` → `model:default` (matches the `default` "Auto" model id via `modelWindowMatches`).
   - `API` and `On-demand` are not mapped. API usage is already part of Total, and on-demand is a spend budget, not headroom.
   - Tier ids are `free|pro|pro_plus|ultra|team`, normalized from `planName`.
   - Capacity follows Cursor's included-usage multiples: Pro+ 3×, Ultra 20×.
7. **Connection test probe.** **Recommend** replacing `tokenExists` with a JSON call to `GetCurrentPeriodUsage` (200 = valid, 401 = refresh when possible). This finally gives Cursor a real validity check, and it avoids false "expired" results on legacy 24h-expiry imported rows.

---

## Gotchas & Edge Cases

- **Modal stop conditions:** `OAuthModal` stops only on `success`, `expired_token`, `access_denied`, or the deadline (`:166-180`). Map the terminal Cursor 403 policy violation to `access_denied`.
- **Poller failure rule:** `quotaSnapshotPoller.js` treats `typeof usage.message === "string"` as a failure. A successful Cursor payload must use `message: null` or omit it.
- **`parseQuotaData` default branch** drops `remainingPercentage`. Without a dedicated `cursor` case, the percent-only windows ("Auto + Composer", "API") would render as 0/100.
- **`totalSpend` can exceed `limit`** because it includes `bonusSpend` (see the paseo issue in Relevant Docs). Drive the Total bar from `totalPercentUsed` and show `includedSpend/limit` in dollars as the used/total text.
- **Free or no-plan accounts** may return `limit: 0` or a missing `planUsage`. Omit rows rather than emitting 0%-remaining rows. If `limit` is 0 but `GetPlanInfo.includedAmountCents` is present, use that as the denominator.
- **Team plans:** `spendLimitUsage` may carry `pooledLimit/pooledUsed/pooledRemaining` instead of the `individual*` fields. Prefer individual and fall back to pooled. Skip the row when `limitType` means no limit.
- **Legacy imported rows** have `expiresAt = import + 24h` and no refreshToken. `shouldRefreshCredentials` is true for them, but `refreshTokenByProvider` returns null early (`tokenRefresh.js:209`), so nothing breaks. `canRefreshCredentials` stops the chatCore 3× retry loop.
- **Registry injection trap:** putting `tokenUrl` in `cursor.oauth` would inject it into `PROVIDERS.cursor` (`open-sse/providers/index.js:9-21`). The generic form-encoded `refreshAccessToken` path would then fire for any caller that misses `REFRESH_HANDLERS`, and the providers baseline would diff too (though `tokenUrl` is in `ADDED_FIELDS`). Use `refreshUrl` / `pollUrl` / `loginUrl`.
- **Dedup identity:** Cursor JWTs usually carry no `email`. `extractUserInfo` falls back to `sub` (e.g. `auth0|user_…`), which is also what the import stores. Use the same helper so browser login and import collapse onto one row per account.
- **CLI launcher:** `cli/src/cli/menus/providers.js:395` hard-codes `DEVICE_CODE_PROVIDERS = ["github","qwen","kiro"]`, so the `9router` CLI won't offer Cursor browser login. That is out of scope unless requested.
- **Import auto-detect** is a LOCAL_ONLY endpoint. Firing it on modal open from a remote host yields 403s, so gate it behind the Import tab.

---

## Open Questions

1. **`expires_in` for the device session:** how long does Cursor keep a `loginDeepControl` uuid pollable? The proposal is 300s, like Qoder. The cursor-agent CLI appears to wait several minutes.
2. **Refresh semantics:** does `exchange_user_api_key` rotate the refreshToken? Is the returned JWT's `exp` a fresh ~60 days? Verify with live credentials in the `9router-dev` container.
3. **Upgrade imported connections:** should auto-import also read `cursorAuth/refreshToken` from `state.vscdb` (a small change in `auto-import/route.js` `ACCESS_TOKEN_KEYS`-style lookup, plus the import body) so they become refreshable too?
4. **`planName` values:** confirm the exact `GetPlanInfo.planName` strings (e.g. "Pro", "Pro+", "Ultra", "Free", "Business"/"Team", "Hobby") before fixing the `cursorPlanTier` mapping and the `PLAN_CAPACITY` values.
5. **Target branch:** this worktree is based on `master` (27a7d59a). `re-design` has heavily refactored `OAuthModal.js` and `CursorAuthModal.js`. Decide whether to land on master and port, or to build the UI directly against `re-design`.
6. **Profile/email lookup:** is there a cheap authenticated endpoint that returns the account email, so dedup and display don't depend on the JWT `sub`?
7. **`On-demand ($)` display:** should it use the credit-balance styling (`isCreditBalance`, `QuotaTable.js:151-221`), or a normal bar with `remainingPercentage = individualRemaining / individualLimit`? The recommendation is a normal bar when a limit exists.

---

## Relevant Docs

- `docs/ARCHITECTURE.md` (request lifecycle; its persistence section is stale because storage is now SQLite), `open-sse/AGENTS.md`, `CLAUDE.md`
- `docs/plans/yan-259-quota-snapshot/`, `docs/plans/yan-260-weighted-account-strategy/` (snapshot and weighted design)
- Cursor PKCE flow and the 403 policy code: [wrfly/AgentLodge PR #65](https://github.com/wrfly/AgentLodge/pull/65), [cursed-gateway account SDK](https://pkg.go.dev/github.com/CoreUnit-NET/cursed-gateway/lib/cursor/account)
- Usage fields and gotchas: [OpenUsage Cursor provider](https://openusage.sh/docs/providers/cursor/), [paseo #4997 (totalSpend includes bonus)](https://github.com/getpaseo/paseo/issues/4997), [ClaudeBar #303 (auto/api percents)](https://github.com/tddworks/ClaudeBar/issues/303)
- Alternative refresh (`/oauth/token`): [quotabar PR #44](https://github.com/ttaatoo/quotabar/pull/44)
