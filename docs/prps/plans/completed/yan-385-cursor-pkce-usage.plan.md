# Plan: Cursor browser login, token refresh, and plan usage (YAN-385)

## Summary

Add a Cursor "Login with browser" flow. It uses Cursor's PKCE deep-control handshake and runs through the existing
generic `device_code` OAuth route and modal. It sits alongside the current IDE-token import.

Add real token refresh through `POST api2.cursor.sh/oauth/token`, which was live-verified. Fix the import's fake
24h expiry.

Add Cursor plan usage (`DashboardService/GetCurrentPeriodUsage` + `GetPlanInfo`) to Provider Limits and the quota
snapshot that feeds the weighted account strategy.

## User Story

As a self-hosting 9router operator (often running in Docker), I want to connect Cursor from any browser and have it
auto-refresh and show plan usage, so that I don't need a local Cursor IDE, connections don't silently die, and I can
see when Cursor usage will run out.

## Problem → Solution

The current state has three problems:

- The only way to add a connection is IDE `state.vscdb` import, and auto-import is local-only, so it can't work on Docker or remote hosts.
- `expiresAt` is hard-coded to import + 24h, and refresh is disabled (`refreshToken: null`, `supportsRefresh=false`).
- There is no Cursor usage or plan data.

After this change:

- Browser PKCE login works from anywhere.
- Every connection is refreshable through `/oauth/token`, with expiry taken from the JWT `exp`.
- Provider Limits shows the plan plus Total / Auto + Composer / API / On-demand usage, and the quota snapshot
  records a `month` window and a `planTier`.

## Metadata

- **Complexity**: Large
- **Source PRD**: N/A. The source spec is `docs/plans/yan-385-cursor-pkce-usage/feature-spec.md`, with research alongside it.
- **PRD Phase**: N/A
- **Estimated Files**: 20 (4 new + 16 updated)
- **Tracking**: Linear YAN-385, GitHub yandy-r/9router#253

## Batches

Tasks grouped by dependency for parallel execution. Tasks within the same batch run concurrently; batches run in order.

| Batch | Tasks              | Depends On | Parallel Width |
| ----- | ------------------ | ---------- | -------------- |
| B1    | 1.1, 1.2           | —          | 2              |
| B2    | 2.1, 2.2, 2.3, 2.4 | B1         | 4              |
| B3    | 3.1, 3.2           | B2         | 2              |
| B4    | 4.1                | B3         | 1              |

- **Total tasks**: 9
- **Total batches**: 4
- **Max parallel width**: 4

## Worktree Setup

- **Parent**: /home/yandy/Projects/github.com/yandy-r/9router/.config/opencode/worktrees/9router-yan-385-cursor-pkce-usage/ (branch: feat/yan-385-cursor-pkce-usage)

All tasks share this single feature worktree. It already exists and was branched off `master` at 27a7d59a.

---

## UX Design

### Before

```text
Add Connection → Cursor
┌ Connect Cursor IDE ─────────────────────┐
│ (auto-detects state.vscdb; local only)  │
│ Access Token [.................]        │
│ Machine ID   [.................]        │
│ [Import Token]  [Cancel]                │
└─────────────────────────────────────────┘
Usage page: no Cursor card
```

### After

```text
Add Connection → Cursor
┌ Connect Cursor ───────────────────────────┐
│ [ Login with browser ]  (recommended)     │
│ [ Import from Cursor IDE ]                │
└───────────────────────────────────────────┘
 Browser → OAuthModal device step: Login URL [Open][Copy], "Waiting for authorization…"
           (no "Your Code" box). Success → connection created.
 Import  → the existing form (auto-detect now runs only here, and also captures the refresh token)

Usage page → Cursor card, plan "Ultra"
  Total            ███████░░  85%     resets Oct 3
  Auto + Composer  █████████  96%
  API              ██░░░░░░░  19%
  On-demand        █████████  $94.69 / $100
```

### Interaction Changes

| Touchpoint            | Before                                      | After                                           | Notes                                      |
| --------------------- | ------------------------------------------- | ----------------------------------------------- | ------------------------------------------ |
| Cursor Add Connection | Import form only                            | Method chooser: browser login or import         | Browser login works on remote/Docker hosts |
| Device step           | Always shows "Your Code"                    | The code box is hidden when `user_code` is null | Cursor has no user code                    |
| Usage page            | No Cursor card                              | Cursor card with plan and 4 rows                | `features.usage: true`                     |
| Connection lifetime   | Looks expired after 24h and never refreshes | Real JWT expiry with auto-refresh               |                                            |

---

## Mandatory Reading

| Priority | File                                                                     | Lines                     | Why                                                                |
| -------- | ------------------------------------------------------------------------ | ------------------------- | ------------------------------------------------------------------ |
| P0       | `docs/plans/yan-385-cursor-pkce-usage/feature-spec.md`                   | all                       | Verified endpoint contracts and decisions                          |
| P0       | `src/lib/oauth/providers/qoder.js`                                       | 1-100                     | Device-code provider module to mirror                              |
| P0       | `src/lib/oauth/providers/index.js`                                       | 87-224                    | `generateAuthData` / `requestDeviceCode` / `pollForToken` contract |
| P0       | `src/app/api/oauth/[provider]/[action]/route.js`                         | 272-320, 543-616          | Generic PKCE device-code and poll branches (no change needed)      |
| P0       | `open-sse/services/tokenRefresh/providers.js`                            | 1-35, 830-869             | Refresher contract (`dedupRefresh`, `invalid_grant`, `null`)       |
| P0       | `open-sse/services/usage/zed.js`                                         | 1-220                     | Usage handler shape and error messages                             |
| P1       | `open-sse/executors/cursor.js`                                           | 230-295, 825-835          | `classifyCursorError`, constructor, `refreshCredentials`           |
| P1       | `open-sse/services/tokenRefresh.js`                                      | 1-60, 140-215             | `REFRESH_HANDLERS`, re-exports, no-refresh-token early return      |
| P1       | `src/sse/services/quotaSnapshotSync.js`                                  | 40-220                    | `kindForName`, `planTierFor`, `persistPlanTier`                    |
| P1       | `src/app/(dashboard)/dashboard/usage/components/ProviderLimits/utils.js` | 343-700                   | `parseQuotaData` cases                                             |
| P1       | `src/shared/components/OAuthModal.js`                                    | 130-190, 285-355, 890-940 | Device list, polling stop rules, code block                        |
| P1       | `src/shared/components/CursorAuthModal.js`                               | all                       | Component being extended                                           |
| P1       | `src/shared/components/KiroOAuthWrapper.js`                              | all                       | Method-chooser to OAuthModal wrapper pattern                       |
| P2       | `open-sse/shared/zedAuth.js`                                             | 1-40, 185-210             | Shared auth-helper module style                                    |
| P2       | `open-sse/providers/registry/cursor.js`                                  | all                       | Registry entry being extended                                      |
| P2       | `open-sse/providers/registry/zed.js`                                     | 30-70                     | `transport.usage` + `features.usage` example                       |
| P2       | `tests/unit/meta-code-provider.test.js`                                  | 1-130                     | `vi.stubGlobal("fetch")` device-poll test style                    |
| P2       | `tests/unit/zed-usage.test.js`                                           | 1-60                      | Usage test style                                                   |

## External Documentation

| Topic                              | Source                                                           | Key Takeaway                                                                                                                                                                                                                                                                                                                                   |
| ---------------------------------- | ---------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| PKCE deep-control login            | `docs/plans/yan-385-cursor-pkce-usage/research-external.md` §1-2 | `loginDeepControl?challenge&uuid&mode=login&redirectTarget=cli`. The poll returns 404 while pending, then 200 `{accessToken, refreshToken}`. A 403 `sign_in_policy_violation` is terminal                                                                                                                                                      |
| Refresh (live-verified 2026-09-25) | feature-spec § External Dependencies                             | `POST /oauth/token` with JSON `{grant_type:"refresh_token", client_id:"KbZUR41cY7W6zRSdpSUJ7I7mLYBKOCmB", refresh_token}` returns 200 `{access_token, id_token, shouldLogout}`. An invalid token returns **200** with `access_token:"", shouldLogout:true`. Any valid session JWT, including the access token itself, works as `refresh_token` |
| Usage RPCs (live-verified)         | feature-spec § Cursor usage                                      | Bearer, `Content-Type: application/json`, `Connect-Protocol-Version: 1`, body `{}`. proto3 omits zero/false fields. Percentages include bonus usage, so don't compute spend ÷ limit                                                                                                                                                            |

---

## Patterns to Mirror

### NAMING_CONVENTION

```js
// SOURCE: open-sse/shared/zedAuth.js:12-18,207,265
import crypto from "node:crypto";
export const ZED_WEB_BASE_URL = "https://zed.dev";
export async function fetchZedAuthenticatedUser(credentials, options = {}) {
export async function fetchZedLlmToken(credentials, options = {}) {
```

### DEVICE_CODE_PROVIDER (module contract)

```js
// SOURCE: src/lib/oauth/providers/qoder.js:3-9,18-27,63-68
const qoder = { config: QODER_CONFIG, flowType: "device_code",
  requestDeviceCode: async (config) => ({ device_code, user_code, verification_uri,
    verification_uri_complete, expires_in: 300, interval: 2 }),
  pollToken: async (config, deviceCode, codeVerifier) => ({ ok: true, data: { access_token, refresh_token, expires_in } }),
// pending → { ok:false, data:{ error:"authorization_pending" } }; failure → { ok:false, data:{ error:"poll_failed", error_description } }
```

### MAP_TOKENS

```js
// SOURCE: src/lib/oauth/providers/qoder.js:81-97
return { accessToken: tokens.access_token,
  refreshToken: tokens.refresh_token || null, expiresIn: tokens.expires_in, email, displayName,
  providerSpecificData: { authMethod: "device", userId, machineId: ... } };
// route.js:587-595 spreads this into createProviderConnection and sets expiresAt = now + expiresIn*1000
```

### ERROR_HANDLING (refresher)

```js
// SOURCE: open-sse/services/tokenRefresh/providers.js:9-11,27-33,842-848
export async function refreshXaiToken(refreshToken, log) {
  if (!refreshToken) return null;
  return dedupRefresh("xai", refreshToken, async () => { ... }, log);
// 401/403 → log?.warn?.("TOKEN_REFRESH", ...); return { error: "invalid_grant" };  other failures → return null
```

### LOGGING_PATTERN

```js
// SOURCE: open-sse/services/tokenRefresh/providers.js:129,138 ; open-sse/executors/cursor.js:577
log?.info?.("TOKEN_REFRESH", `Successfully refreshed token for ${provider}`);
log?.warn?.("TOKEN_REFRESH", `cursor refresh failed (${status})`); // never log tokens/verifier
log?.info?.("CURSOR", `...`);
```

### REPOSITORY_PATTERN (registry-driven config)

```js
// SOURCE: open-sse/providers/registry/zed.js:39-41,67-70 ; open-sse/providers/index.js:9
transport: { ..., usage: { url: "https://cloud.zed.dev/client/users/me" } },
features: { usage: true, liveModels: true },
const OAUTH_INJECT_FIELDS = ["clientId", "clientSecret", "tokenUrl"]; // NEVER use these keys in cursor.oauth
```

### SERVICE_PATTERN (usage handler)

```js
// SOURCE: open-sse/services/usage/zed.js:98-104,209-218 ; open-sse/services/usage/shared.js:9,15,52,69
import { U, parseResetTime, toFiniteNumber, fetchWithTimeout } from "./shared.js";
quotas[name] = { used, total, remainingPercentage, resetAt: resetAt || null };
if (status === 401 || status === 403) return { message: "... expired ... Re-authorize ..." };
return { plan, quotas }; // NO string `message` on success (quotaSnapshotPoller treats it as failure)
```

### TEST_STRUCTURE

```js
// SOURCE: tests/unit/meta-code-provider.test.js:4,113-127 ; tests/unit/zed-usage.test.js:3-12
import { afterEach, describe, expect, it, vi } from "vitest";
afterEach(() => vi.unstubAllGlobals());
vi.stubGlobal(
  "fetch",
  vi.fn(async () => json({ error }, 400)),
);
const { getZedUsage } = await import("../../open-sse/services/usage/zed.js");
```

---

## Files to Change

| File                                                                     | Action | Justification                                                                                                                  |
| ------------------------------------------------------------------------ | ------ | ------------------------------------------------------------------------------------------------------------------------------ |
| `open-sse/providers/registry/cursor.js`                                  | UPDATE | Add oauth login/poll/refresh constants, `refreshLeadMs`, `dbKeys.refreshToken`, `transport.usage`, and `features.usage`        |
| `open-sse/shared/cursorAuth.js`                                          | CREATE | Single home for Cursor auth HTTP and helpers (login URL, poll, refresh exchange, JWT exp/identity, machineId)                  |
| `src/lib/oauth/providers/cursor.js`                                      | UPDATE | `device_code` flow: `requestDeviceCode`, `pollToken`, `mapTokens`                                                              |
| `src/lib/oauth/services/cursor.js`                                       | UPDATE | JWT expiry and refresh token for import; `extractUserInfo` delegates to the shared helper; delete dead checksum/header methods |
| `src/app/api/oauth/cursor/import/route.js`                               | UPDATE | Accept an optional `refreshToken`; persist it and the real expiry                                                              |
| `src/app/api/oauth/cursor/auto-import/route.js`                          | UPDATE | Read `cursorAuth/refreshToken` and return it                                                                                   |
| `open-sse/services/tokenRefresh/cursor.js`                               | CREATE | `refreshCursorToken(refreshToken, log)` wrapped in `dedupRefresh`                                                              |
| `open-sse/services/tokenRefresh.js`                                      | UPDATE | Re-export the refresher and add `REFRESH_HANDLERS.cursor`                                                                      |
| `open-sse/services/tokenRefresh/providers.js`                            | UPDATE | Remove the stale "cursor" mention from the null-refresh comment                                                                |
| `open-sse/executors/cursor.js`                                           | UPDATE | Enable refresh; map Connect `unauthenticated`/`permission_denied` to 401/403                                                   |
| `open-sse/executors/base.js`                                             | UPDATE | Drop cursor from the no-refresh comment                                                                                        |
| `open-sse/services/usage/cursor.js`                                      | CREATE | `getCursorUsage`, `parseCursorUsage`, `cursorPlanTier`                                                                         |
| `open-sse/services/usage.js`                                             | UPDATE | Register the cursor usage handler                                                                                              |
| `src/sse/services/quotaSnapshotSync.js`                                  | UPDATE | Cursor cases in `kindForName` and `planTierFor`                                                                                |
| `open-sse/config/quotaSnapshot.js`                                       | UPDATE | `PLAN_CAPACITY.cursor`                                                                                                         |
| `src/app/(dashboard)/dashboard/usage/components/ProviderLimits/utils.js` | UPDATE | `parseQuotaData` cursor case that keeps `remainingPercentage`                                                                  |
| `src/shared/components/OAuthModal.js`                                    | UPDATE | Add cursor to the device-code providers; hide the code block when `user_code` is empty                                         |
| `src/shared/components/CursorAuthModal.js`                               | UPDATE | Method chooser (browser / import); auto-detect only in import mode; pass the refresh token                                     |
| `src/app/(dashboard)/dashboard/providers/[id]/page.js`                   | UPDATE | Pass `providerInfo` to `CursorAuthModal`                                                                                       |
| `tests/unit/usage-dispatch.test.js`                                      | UPDATE | Add `cursor` to the supported list                                                                                             |
| `tests/unit/cursor-auth.test.js`                                         | CREATE | Critical: poll mapping, `mapTokens`, refresh semantics (including the 200 `shouldLogout`)                                      |
| `tests/unit/cursor-usage.test.js`                                        | CREATE | Critical: usage parser against the live payload shape, tier, auth message, snapshot kind                                       |

## NOT Building

- A server-side PKCE session store. The generic device-code route returns `codeVerifier` to the authenticated dashboard client, the same as Qwen/Qoder today; refactoring the route is out of scope.
- Poll exponential backoff in `OAuthModal`. A fixed 2s interval with a 600s deadline is enough.
- The cookie (`cursor.com/api/...`) usage fallback, `full_stripe_profile`, and team `pooled*` scoping beyond a simple `individual* ?? pooled*` fallback.
- Cursor browser login in the CLI launcher menu (`cli/src/cli/menus/providers.js`).
- A new usage-probe-based connection test (`testUtils.js` keeps `tokenExists`).
- Porting to the `re-design` branch. That happens through the normal master→re-design sync.
- Minting `crsr_` user API keys.

---

## Step-by-Step Tasks

### Task 1.1: Registry constants for Cursor auth and usage — Depends on [none]

- **BATCH**: B1
- **ACTION**: Extend `open-sse/providers/registry/cursor.js`.
- **IMPLEMENT**:
  - In `oauth`, add `loginUrl: "https://cursor.com/loginDeepControl"`, `pollUrl: "https://api2.cursor.sh/auth/poll"`, `refreshUrl: "https://api2.cursor.sh/oauth/token"`, `refreshClientId: "KbZUR41cY7W6zRSdpSUJ7I7mLYBKOCmB"` (with a comment: the Cursor IDE public client, verified 2026-09-25), and `refreshLeadMs: 86_400_000`. Also add `dbKeys.refreshToken: "cursorAuth/refreshToken"`.
  - In `transport`, add `usage: { url: "https://api2.cursor.sh/aiserver.v1.DashboardService/GetCurrentPeriodUsage", planInfoUrl: "https://api2.cursor.sh/aiserver.v1.DashboardService/GetPlanInfo" }`.
  - In `features`, add `usage: true`.
- **MIRROR**: REPOSITORY_PATTERN (the zed registry).
- **IMPORTS**: none.
- **GOTCHA**:
  - Do NOT use the keys `clientId`, `clientSecret` or `tokenUrl`. `OAUTH_INJECT_FIELDS` copies them into `PROVIDERS.cursor`, which would turn on the generic form-encoded refresh.
  - `providers/registry/index.js` is auto-generated. Don't touch it; cursor is already listed.
- **VALIDATE**: `node tests/__baseline__/verify-providers.mjs` and `node tests/__baseline__/verify-oauth-urls.mjs` both pass (`usage` is in ADDED_FIELDS). `node -e "import('./open-sse/config/appConstants.js').then(m=>console.log(m.REFRESH_LEAD_MS.cursor))"` prints 86400000.

### Task 1.2: Shared Cursor auth helper module — Depends on [none]

- **BATCH**: B1
- **ACTION**: Create `open-sse/shared/cursorAuth.js`. It holds every Cursor auth HTTP call and helper, with URLs read from `PROVIDER_OAUTH.cursor` (import from `../providers/index.js`) and fallback constants for when the registry key is missing.
- **IMPLEMENT**: Exports:
  - `buildCursorLoginUrl({ challenge, uuid })` returns `${loginUrl}?challenge&uuid&mode=login&redirectTarget=cli` (use URLSearchParams).
  - `pollCursorLogin({ uuid, verifier })` does GET `${pollUrl}?uuid&verifier` and returns `{status:"pending"}` on 404, `{status:"success", accessToken, refreshToken}` on 200 with an accessToken, `{status:"denied", message:"Cursor organization sign-in policy blocked this device"}` on a 403 whose body contains `sign_in_policy_violation`, and otherwise `{status:"error", message:\`Cursor login poll failed (${status})\`}`. Network errors give`{status:"error", message:"Cursor login poll failed (network error)"}`. It never throws and never echoes the upstream body or URL.
  - `exchangeCursorRefreshToken(refreshToken)` does POST `refreshUrl` with JSON `{grant_type:"refresh_token", client_id: refreshClientId, refresh_token}`. It returns `{ok:true, accessToken, idToken}` when 200 with a non-empty `access_token` and `shouldLogout !== true`. It returns `{ok:false, dead:true, status}` when `shouldLogout === true`, the access_token is empty, or the status is 401/403. Anything else returns `{ok:false, dead:false, status}`. Never throw on HTTP; catch network errors as `{ok:false, dead:false, status:0}`.
  - `decodeCursorJwt(token)` returns the payload or null and never throws; use base64url via `Buffer.from(part,"base64url")`.
  - `cursorJwtExpiresIn(token, fallbackSec = 86400)` returns seconds until `exp`, minimum 60, falling back to fallbackSec.
  - `getCursorTokenIdentity(token)` returns `{email: payload.email || payload.sub || null, userId: payload.sub || null}`.
  - `generateCursorMachineId()` returns `crypto.createHash("sha256").update(crypto.randomUUID()).digest("hex")`.
- **MIRROR**: NAMING_CONVENTION (zedAuth), ERROR_HANDLING.
- **IMPORTS**: `import crypto from "node:crypto"; import { PROVIDER_OAUTH } from "../providers/index.js";`
- **GOTCHA**:
  - Use the global `fetch` (tests stub it).
  - Add a `AbortSignal.timeout(15000)` to each call.
  - Never log tokens, the verifier, or the poll URL.
  - Keep the file under ~150 lines.
- **VALIDATE**: `node -e "import('./open-sse/shared/cursorAuth.js').then(m=>{console.log(m.buildCursorLoginUrl({challenge:'c',uuid:'u'}), m.generateCursorMachineId().length)})"` prints the URL and 64.

### Task 2.1: Track A — Cursor device-code provider and import fixes — Depends on [1.1, 1.2]

- **BATCH**: B2
- **ACTION**: Convert `src/lib/oauth/providers/cursor.js` to a `device_code` provider. Fix the import service and routes. This task owns `src/lib/oauth/providers/cursor.js`, `src/lib/oauth/services/cursor.js`, `src/app/api/oauth/cursor/import/route.js` and `src/app/api/oauth/cursor/auto-import/route.js`.
- **IMPLEMENT**:
  - **Provider**:
    - Set `flowType: "device_code"`.
    - `requestDeviceCode(config, codeChallenge)`: `uuid = crypto.randomUUID()`. Return `{device_code: uuid, user_code: null, verification_uri: config.loginUrl, verification_uri_complete: buildCursorLoginUrl({challenge: codeChallenge, uuid}), expires_in: 600, interval: 2}`.
    - `pollToken(config, deviceCode, codeVerifier)`: if a param is missing, return `{ok:false,data:{error:"invalid_request"}}`. Otherwise call `pollCursorLogin` and map pending to `authorization_pending`. Map success to `{ok:true,data:{access_token, refresh_token, expires_in: cursorJwtExpiresIn(accessToken)}}`, denied to `access_denied`, and error to `poll_failed`, each with `error_description`.
    - `mapTokens(tokens)`: `identity = getCursorTokenIdentity(access_token)`. Return `{accessToken, refreshToken: refresh_token || access_token, expiresIn: expires_in, email: identity.email, providerSpecificData: {machineId: generateCursorMachineId(), authMethod: "browser", userId: identity.userId}}`.
  - **Service**:
    - `validateImportToken(accessToken, machineId, refreshToken)` keeps its validations and returns `expiresIn: cursorJwtExpiresIn(accessToken)` plus `refreshToken: refreshToken?.trim() || accessToken`.
    - `extractUserInfo` delegates to `getCursorTokenIdentity`, returning null when both fields are null.
    - Delete `generateChecksum`, `buildHeaders`, `detectOS` and `detectArch` if grep shows no callers outside the file. Keep `getTokenStorageInstructions` if it is used.
  - **Import route**: read an optional `refreshToken` from the body (must be a string if present), pass it to `validateImportToken`, and store `refreshToken: tokenData.refreshToken`.
  - **Auto-import route**: add `REFRESH_TOKEN_KEYS = ["cursorAuth/refreshToken"]`, read it in both the exact-key and CLI/fuzzy paths the same way as the accessToken, and include `refreshToken` in the `{found:true}` JSON.
- **MIRROR**: DEVICE_CODE_PROVIDER, MAP_TOKENS.
- **IMPORTS**: `import crypto from "node:crypto"` (provider), plus `{ buildCursorLoginUrl, pollCursorLogin, cursorJwtExpiresIn, getCursorTokenIdentity, generateCursorMachineId } from "open-sse/shared/cursorAuth.js"`.
- **GOTCHA**:
  - The generic route (`route.js` device-code/poll else-branches) already handles PKCE, so do NOT add cursor to either `noPkce*` list and do NOT edit `route.js`.
  - `pollForToken` counts only `ok && data.access_token` as success.
  - `email` must be the JWT `sub` fallback, the same as import, so re-login dedups onto the same row.
  - The existing `oauth-cursor-auto-import.test.js` cases are all in known-fails already. Don't try to fix that file.
- **VALIDATE**: `npx vitest run unit/oauth-cursor-auto-import.test.js` (from `tests/`) fails only on its known cases. Grep confirms that nothing else imports the deleted methods.

### Task 2.2: Track B — Cursor refresher and executor refresh — Depends on [1.2]

- **BATCH**: B2
- **ACTION**: Implement refresh and enable it in the executor. This task owns `open-sse/services/tokenRefresh/cursor.js` (new), `open-sse/services/tokenRefresh.js`, `open-sse/services/tokenRefresh/providers.js` (comment only), `open-sse/executors/cursor.js` and `open-sse/executors/base.js` (comment only).
- **IMPLEMENT**:
  - **New file** `refreshCursorToken(refreshToken, log)`: return null if there is no token. Otherwise run `dedupRefresh("cursor", refreshToken, async () => {...}, log)`:
    - Call `exchangeCursorRefreshToken`.
    - On `ok`, return `{accessToken, refreshToken: accessToken, expiresIn: cursorJwtExpiresIn(accessToken), idToken}`. This follows the Cursor IDE, which stores the new session JWT in both slots.
    - On `dead`, `log?.warn?.("TOKEN_REFRESH", \`cursor session rejected (${status})\`)`and return`{error:"invalid_grant"}`.
    - Otherwise warn and return null.
    - On success, `log?.info?.("TOKEN_REFRESH","Successfully refreshed token for cursor")`.
  - **`tokenRefresh.js`**: import and re-export `refreshCursorToken`, and add `cursor: (c, log) => refreshCursorToken(c.refreshToken, log)` to `REFRESH_HANDLERS`.
  - **`providers.js`**: change the "Mirrors cursor/kilocode null-refresh pattern" comment so it no longer names cursor.
  - **Executor**:
    - Delete `this.supportsRefresh = false` and its comment.
    - Add `canRefreshCredentials(c) { return Boolean(c?.refreshToken || c?.accessToken); }`.
    - Add `async refreshCredentials(credentials, log) { return refreshCursorToken(credentials?.refreshToken || credentials?.accessToken, log); }`. The accessToken fallback heals legacy imported rows that have no refresh token; a session JWT is a valid refresh_token.
    - In `classifyCursorError`, add `jsonError?.error?.code === "unauthenticated"` → `{status: HTTP_STATUS.UNAUTHORIZED, type: "authentication_error", code: "unauthenticated", message}` and `"permission_denied"` → `{status: HTTP_STATUS.FORBIDDEN, type: "permission_error", code: "permission_denied", message}`, placed before the generic 400 fallback.
  - **`base.js`**: remove cursor from the no-refresh executors comment.
- **MIRROR**: ERROR_HANDLING, LOGGING_PATTERN.
- **IMPORTS**: `import { dedupRefresh } from "./dedup.js"; import { exchangeCursorRefreshToken, cursorJwtExpiresIn } from "../../shared/cursorAuth.js";` (new file). The executor imports `refreshCursorToken` from `../services/tokenRefresh/cursor.js`.
- **GOTCHA**:
  - `isUnrecoverableRefreshError` already recognizes `invalid_grant`.
  - A **200** response can still mean a dead session (`shouldLogout`).
  - Don't touch the protobuf/stream code in the executor.
  - `HTTP_STATUS.UNAUTHORIZED`/`FORBIDDEN` exist in `open-sse/config/runtimeConfig.js`.
- **VALIDATE**: `npx vitest run unit/token-refresh-dispatch.test.js unit/cursor-agent-proto.test.js unit/cursor-agent-exec-request.test.js` (from `tests/`) passes.

### Task 2.3: Track C — Usage handler, snapshot, capacity, parser — Depends on [1.1]

- **BATCH**: B2
- **ACTION**: Add the Cursor usage handler and wire it through the dispatcher, quota snapshot, plan capacity and the ProviderLimits parser. This task owns `open-sse/services/usage/cursor.js` (new), `open-sse/services/usage.js`, `src/sse/services/quotaSnapshotSync.js`, `open-sse/config/quotaSnapshot.js`, `ProviderLimits/utils.js` and `tests/unit/usage-dispatch.test.js`.
- **IMPLEMENT**:
  - **`getCursorUsage(accessToken, psd, proxyOptions)`**:
    - If there is no token, return `{message:"Cursor access token not available. Re-authorize the connection."}`.
    - Run POST to `U("cursor").url` and `.planInfoUrl` through `Promise.allSettled([fetchWithTimeout(...), ...])` with headers `Authorization: Bearer`, `Content-Type: application/json`, `Connect-Protocol-Version: 1` and body `"{}"`.
    - If the usage call returns 401/403, return `{message:"Cursor authentication expired (401). Re-authorize the connection."}`. If it fails otherwise, return `{message:\`Cursor usage unavailable (${status||"network error"})\`}`.
    - Otherwise return `parseCursorUsage(usageJson, planJson?.planInfo)`.
  - **`parseCursorUsage(data, planInfo)`**, pure:
    - `resetAt = parseResetTime(Number(data.billingCycleEnd))`, and `pct(x) = clamp(toFiniteNumber(x,0),0,100)`.
    - Rows `Total` (totalPercentUsed), `Auto + Composer` (autoPercentUsed) and `API` (apiPercentUsed) are each `{used: round(pct,1), total: 100, remainingPercentage: 100 - pct, resetAt}`. Emit them only when `planUsage` exists.
    - `On-demand` uses `limit = individualLimit ?? pooledLimit` and `used = individualUsed ?? pooledUsed` (cents). Emit it only when limit > 0: `{used: used/100, total: limit/100, remainingPercentage: clamp((1 - used/limit)*100), resetAt}`.
    - Return `{plan: planInfo?.planName || null, planName: planInfo?.planName || null, quotas}`, with no `message` key.
  - **`cursorPlanTier(name)`**: lowercase and trim; map `pro+`/`pro plus`/`proplus` to `pro_plus` and `hobby` to `free`; return the value only if it is in `["free","pro","pro_plus","ultra","team","business","enterprise"]`, else null.
  - **`usage.js`**: add `cursor: (c) => getCursorUsage(c.accessToken, c.providerSpecificData, c.proxyOptions)`.
  - **`quotaSnapshotSync.js`**:
    - In `kindForName`, add `case "cursor": return lower === "total" ? "month" : null;`.
    - In `planTierFor`, add `case "cursor": return cursorPlanTier(usage.planName ?? usage.plan);`.
    - Update the JSDoc bullet list.
    - Import `cursorPlanTier` from `open-sse/services/usage/cursor.js`.
  - **`PLAN_CAPACITY`**: add `cursor: { free: 0.1, pro: 1, pro_plus: 3, ultra: 20, team: 1, business: 1, enterprise: 1 }`, with `// _verify` on the estimates.
  - **`parseQuotaData`**: add `case "cursor":`, which pushes `{name, used, total, resetAt, remainingPercentage}` like the kimi case.
  - **`usage-dispatch.test.js`**: add `"cursor"` to `SUPPORTED`.
- **MIRROR**: SERVICE_PATTERN.
- **IMPORTS**: `import { U, parseResetTime, toFiniteNumber, fetchWithTimeout } from "./shared.js";`
- **GOTCHA**:
  - A success result must NOT have a string `message`; the poller treats that as failure.
  - The 401 message must contain "expired"/"401" so the usage route force-refreshes and retries.
  - proto3 omits zero fields, so a missing value means 0.
  - `billingCycleEnd` is an epoch-ms string.
  - `ProviderLimits/index.js` is 1500+ lines; don't touch it.
- **VALIDATE**: `npx vitest run unit/usage-dispatch.test.js unit/zed-usage.test.js` (from `tests/`) passes.

### Task 2.4: Track D — Cursor connect UI — Depends on [1.1]

- **BATCH**: B2
- **ACTION**: Add a method chooser to `CursorAuthModal` and turn on the cursor device step in `OAuthModal`. This task owns `src/shared/components/OAuthModal.js`, `src/shared/components/CursorAuthModal.js` and `src/app/(dashboard)/dashboard/providers/[id]/page.js`.
- **IMPLEMENT**:
  - **`OAuthModal`**: add `"cursor"` to `deviceCodeProviders`, and wrap the "Your Code" block so it renders only when `deviceData.user_code` is truthy.
  - **`CursorAuthModal({isOpen, providerInfo, onSuccess, onClose})`**:
    - Add `const [method, setMethod] = useState(null)`. When `method === "browser"`, return `<OAuthModal isOpen={isOpen} provider="cursor" providerInfo={providerInfo} onSuccess={() => { setMethod(null); onSuccess?.(); onClose(); }} onClose={() => setMethod(null)} />`, following the KiroOAuthWrapper pattern.
    - When `method === null`, render the `<Modal title="Connect Cursor">` with two full-width buttons: "Login with browser" (primary, subtitle "Works on remote/Docker hosts") and "Import from Cursor IDE" (secondary).
    - When `method === "import"`, render the existing import form with a Back button.
    - Run the auto-detect `useEffect` only when `isOpen && method === "import"`.
    - Store `refreshToken` from the auto-detect response in state and include it in the import POST body when present.
    - Reset `method` to null when the modal closes.
    - Update propTypes to add `providerInfo`.
  - **`page.js`**: pass `providerInfo={providerInfo}` to `CursorAuthModal`.
- **MIRROR**: `KiroOAuthWrapper.js` (method chooser to OAuthModal).
- **IMPORTS**: `import OAuthModal from "./OAuthModal";` in CursorAuthModal. Use the same import style as KiroOAuthWrapper.
- **GOTCHA**:
  - Keep the edits to `OAuthModal.js` minimal; it is 1000+ lines and is being rewritten on `re-design`.
  - `OAuthModal` reads `providerInfo.name`, so pass providerInfo through.
  - The auto-import endpoint is LOCAL_ONLY, so don't call it until the user picks Import.
  - Don't add new a11y lint warnings; use the existing `Button` and `Modal` components.
- **VALIDATE**: `npx biome check src/shared/components/CursorAuthModal.js src/shared/components/OAuthModal.js "src/app/(dashboard)/dashboard/providers/[id]/page.js"` reports no new errors.

### Task 3.1: Critical tests — Cursor auth (login + refresh) — Depends on [2.1, 2.2]

- **BATCH**: B3
- **ACTION**: Create `tests/unit/cursor-auth.test.js`.
- **IMPLEMENT**: Use `vi.stubGlobal("fetch")` with a JWT fixture helper (`header.base64url(JSON{sub:"github|user_1",exp:now+86400*60}).sig`). Cases:
  1. `requestDeviceCode` returns a `loginDeepControl` URL with `challenge`, `uuid`, `mode=login` and `redirectTarget=cli`, and `user_code` is null.
  2. `pollToken` maps 404 to `authorization_pending`, 200 to `ok` with `access_token` and `expires_in ≈ 60d`, and a 403 `sign_in_policy_violation` to `access_denied`.
  3. `mapTokens` generates a 64-hex machineId, sets `email` to the sub, and falls back to the accessToken for refreshToken.
  4. `refreshCursorToken`: a 200 with a token returns `{accessToken, refreshToken === accessToken, expiresIn>0}`; a 200 with `shouldLogout:true`/empty returns `{error:"invalid_grant"}`; 401 returns `invalid_grant`; 500 returns null. Use distinct refresh tokens per case because of dedup caching. Assert the fetch body has the `grant_type:"refresh_token"` and `client_id`.
  5. `REFRESH_HANDLERS`: `refreshTokenByProvider("cursor", {refreshToken})` dispatches.
- **MIRROR**: TEST_STRUCTURE.
- **IMPORTS**: `vitest`; dynamic imports of `../../src/lib/oauth/providers/cursor.js`, `../../open-sse/services/tokenRefresh/cursor.js` and `../../open-sse/services/tokenRefresh.js`.
- **GOTCHA**: Tests run with an isolated DATA_DIR. `afterEach(vi.unstubAllGlobals)`. Keep it to about 120 lines and only these critical cases.
- **VALIDATE**: `cd tests && npx vitest run unit/cursor-auth.test.js` passes.

### Task 3.2: Critical tests — Cursor usage parsing — Depends on [2.3]

- **BATCH**: B3
- **ACTION**: Create `tests/unit/cursor-usage.test.js`.
- **IMPLEMENT**: Use a fixture shaped like the live payload: `planUsage{totalSpend:297695, includedSpend:40000, bonusSpend:257695, limit:40000, autoPercentUsed:96.1, apiPercentUsed:18.6, totalPercentUsed:85.1}`, `spendLimitUsage{individualLimit:10000, individualUsed:9469, individualRemaining:531, limitType:"user"}` and `billingCycleEnd:"1791041503000"`. Cases:
  1. `parseCursorUsage` returns the Total `remainingPercentage ≈ 14.9` (not a spend-derived 0), an On-demand row of `{used:94.69,total:100}`, a resetAt ISO string, the plan "Ultra", and no `message` key.
  2. With `planUsage` missing and `spendLimitUsage` missing, the result has empty quotas and no message.
  3. `cursorPlanTier("Pro+") === "pro_plus"`, `"Ultra" === "ultra"`, and `"weird" === null`.
  4. `getCursorUsage` with a fetch stub returning 401 gives a message matching `/expired/`.
  5. `kindForName("cursor","Total") === "month"` and `kindForName("cursor","API") === null`.
- **MIRROR**: TEST_STRUCTURE.
- **IMPORTS**: `../../open-sse/services/usage/cursor.js`, `../../src/sse/services/quotaSnapshotSync.js`.
- **GOTCHA**: `fetchWithTimeout` goes through `proxyAwareFetch`. Stub it with `vi.mock("../../open-sse/utils/proxyFetch.js")` as `usage-dispatch.test.js` does, or stub global fetch if `proxyAwareFetch` falls through to it. Check which before writing the test.
- **VALIDATE**: `cd tests && npx vitest run unit/cursor-usage.test.js` passes.

### Task 4.1: Integration validation — Depends on [3.1, 3.2]

- **BATCH**: B4
- **ACTION**: Run the full validation suite and fix any regressions in files owned by this feature.
- **IMPLEMENT**:
  - Run `npm run lint`, the full test gate (`npm test`), `node tests/__baseline__/verify-providers.mjs`, `node tests/__baseline__/verify-alias.mjs`, `node tests/__baseline__/verify-oauth-urls.mjs` and `npm run build`.
  - Delete any untracked `tests/translator/__snapshots__/golden-url-header.test.js.snap`.
- **MIRROR**: n/a.
- **IMPORTS**: n/a.
- **GOTCHA**:
  - The suite isn't all-green on master. Judge only against `known-fails.txt`.
  - A pre-push ShellCheck failure caused by the local environment is not a code issue.
- **VALIDATE**: The regression gate prints no regressions, the baselines pass, lint has 0 errors, and `next build` succeeds.

---

## Testing Strategy

### Unit Tests

| Test                         | Input                                       | Expected Output                           | Edge Case? |
| ---------------------------- | ------------------------------------------- | ----------------------------------------- | ---------- |
| requestDeviceCode            | codeChallenge                               | loginDeepControl URL, `user_code` null    | No         |
| pollToken pending            | fetch 404                                   | `authorization_pending`                   | No         |
| pollToken policy             | fetch 403 `sign_in_policy_violation`        | `access_denied` (stops the modal)         | Yes        |
| mapTokens                    | poll tokens (JWT)                           | 64-hex machineId, email = sub, JWT expiry | No         |
| refreshCursorToken dead      | 200 `{access_token:"", shouldLogout:true}`  | `{error:"invalid_grant"}`                 | Yes        |
| refreshCursorToken transient | 500                                         | null                                      | Yes        |
| parseCursorUsage bonus       | totalPercentUsed 85, includedSpend == limit | Total remaining ≈ 15% (not 0)             | Yes        |
| parseCursorUsage omitted     | no planUsage/spendLimitUsage                | empty quotas, no message                  | Yes        |
| getCursorUsage 401           | fetch 401                                   | message containing "expired"              | Yes        |
| kindForName cursor           | "Total" / "API"                             | "month" / null                            | No         |

### Edge Cases Checklist

- [x] Empty input (omitted proto3 fields)
- [x] Invalid types (non-JWT token → fallback expiry)
- [ ] Concurrent access (covered by the existing `dedupRefresh`; no new test)
- [x] Network failure (poll/refresh return error/null; usage returns a message)
- [x] Permission denied (403 policy → access_denied; 401 usage → re-auth message)

---

## Validation Commands

### Static Analysis

```bash
npm run lint
```

EXPECT: 0 errors (existing warnings allowed, no new ones)

### Unit Tests

```bash
cd tests && npx vitest run unit/cursor-auth.test.js unit/cursor-usage.test.js unit/usage-dispatch.test.js unit/token-refresh-dispatch.test.js
```

EXPECT: All pass

### Full Test Suite

```bash
npm test
node tests/__baseline__/verify-providers.mjs && node tests/__baseline__/verify-alias.mjs && node tests/__baseline__/verify-oauth-urls.mjs
```

EXPECT: No regressions against known-fails.txt; baselines pass

### Build

```bash
npm run build
```

EXPECT: next build succeeds

### Browser Validation

```bash
docker exec -i 9router-dev node - < live-probe.js   # dev container bind-mounts the checkout at /app
```

EXPECT: the new usage handler returns plan "Ultra" plus 4 quota rows for the existing imported connection, and the executor-path refresh returns a fresh token for a legacy row with no refresh token

### Manual Validation

- [ ] Add Connection → Cursor → "Login with browser" → complete the login at cursor.com → the connection is created, with a refresh token and a ~60d expiry
- [ ] Chat through the new connection works
- [ ] Force `expiresAt` into the past → the next request refreshes through `/oauth/token` and chat still works
- [ ] Usage page shows the Cursor card with the plan and rows; the quota snapshot has a `month` window and `planTier`

---

## Acceptance Criteria

- [ ] All tasks completed
- [ ] All validation commands pass
- [ ] Critical tests written and passing
- [ ] No lint errors
- [ ] Matches UX design
- [ ] Live verification in the dev container: usage, refresh and the (user-driven) browser login

## Completion Checklist

- [ ] Code follows discovered patterns (device-code provider, refresher contract, usage handler)
- [ ] Error handling matches codebase style (never throw from poll/refresh/usage; fixed-text messages)
- [ ] Logging follows codebase conventions (`TOKEN_REFRESH` / `CURSOR` tags, no secrets)
- [ ] Tests follow test patterns
- [ ] No hardcoded values outside the registry (and cursorAuth fallbacks)
- [ ] No unnecessary scope additions
- [ ] Self-contained: no questions needed during implementation

## Risks

| Risk                                                            | Likelihood | Impact | Mitigation                                                                                         |
| --------------------------------------------------------------- | ---------- | ------ | -------------------------------------------------------------------------------------------------- |
| Undocumented endpoint drift (poll/refresh/usage)                | Medium     | Medium | Constants live in the registry; everything fails soft; import stays as a fallback                  |
| The IDE client_id used for refresh changes                      | Low        | High   | A single registry constant; dead refresh surfaces as a re-auth prompt                              |
| The generic poll returns `codeVerifier` to the dashboard client | Low        | Low    | Same as the existing Qwen/Qoder flows; the route is auth-guarded and tokens never go to the client |
| Conflicts with the `re-design` UI rewrite                       | High       | Low    | Minimal edits to OAuthModal/CursorAuthModal; resolved in the next master→re-design sync            |
| PLAN_CAPACITY values are estimates                              | Medium     | Low    | Marked `_verify`; the manual plan override exists                                                  |

## Notes

- Refresh semantics were verified live on 2026-09-25 against both a `cursor-agent` CLI login token and a 9router-dev IDE-imported token: `/oauth/token` returns 200 and a fresh ~60-day JWT with the same `sub`; `exchange_user_api_key` returns 401.
- `docs/*` is gitignored except `docs/plans/` and `docs/prps/`. This plan and the feature research are committed as `docs(internal)`.
- A PR into `master` auto-closes GitHub #253 through `Closes #253`. Linear YAN-385 is closed manually.
