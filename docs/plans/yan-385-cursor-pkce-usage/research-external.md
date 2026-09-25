# External Research: yan-385 Cursor PKCE login, token refresh, plan usage

Research date: 2026-09-25. No authenticated calls were made to Cursor endpoints. Primary evidence comes from
reading Cursor's own shipped client code, plus open-source implementations and PR write-ups that report live
verification:

- `@cursor/sdk@1.0.32` on npm (published 2026-09-22), `dist/esm/index.js`, and its typings `dist/esm/auth/login-flow.d.ts` and `login.d.ts`.
- The `cursor-agent` CLI bundle `2026.09.23-86fc751`, from the public installer `https://cursor.com/install`, which downloads `https://downloads.cursor.com/lab/2026.09.23-86fc751/linux/x64/agent-cli-package.tar.gz` (`index.js`, module `../cursor-config/dist/auth/login.js`).

## Executive Summary

1. **Refresh is the most important correction.** `POST /auth/exchange_user_api_key` is **API-key-only**. It
   accepts a `crsr_…` user API key and rejects both the session access JWT and the session refresh JWT with
   `401 Invalid User API Key`. That was live-verified in sudosubin/pi-frontier#30. The cursor-agent CLI only
   calls it through `loginWithApiKey(apiKey)`, and its refresh policy only re-exchanges an API key. The
   refresh that actually works for browser-login session tokens is the IDE's:
   `POST https://api2.cursor.sh/oauth/token` with JSON
   `{"grant_type":"refresh_token","client_id":"KbZUR41cY7W6zRSdpSUJ7I7mLYBKOCmB","refresh_token":<refreshToken>}`.
   It returns `200 {"access_token":<JWT, 60 days>,"id_token":<JWT>,"shouldLogout":false}` and **no new refresh
   token**. `shouldLogout:true` arrives on a 200 and means the session is permanently dead.
   **Confidence: High.** Live-verified in AixleHQ/flow#287 on 2026-09-17, used in production by robinebers/openusage,
   openchamber, and cbnsndwch/pacebar, and matches the CLI bundle.
   Several community routers (pi-cursor, opencodex, OmniRoute, cursed-gateway, and the upstream
   decolua/9router#2755) send the session refreshToken to `exchange_user_api_key`. Per the evidence above, that
   is broken, and we should not copy it.
2. **The CLI itself never refreshes browser-login sessions.** Session JWTs last about 60 days. When one
   expires, the CLI makes the user run `agent login` again. A "real refresh" for 9router therefore means the
   `/oauth/token` path. Re-login is the fallback when `shouldLogout` is true, on 401, or when the refresh
   token is missing.
3. **Poll success payload.** The body is `{accessToken, refreshToken}`, both strings. Validate those two
   fields. It may also contain `selectedTeamId`, but only when `supportsSelectedTeamLogin=true` is sent. Older
   IDE reverse-engineering also reports `authId`. Pending returns `404` with the plain-text body `Not found`.
   Cadence used by both official clients: delay `min(1000·1.2^n, 10000)` ms, 150 attempts (about 20 min),
   giving up after 3 consecutive non-404 errors.
   The CLI still uses `GET /auth/poll?uuid=&verifier=`. The **newer SDK uses `POST /auth/poll` with JSON
   `{uuid, verifier}`** so the verifier stays out of URLs and access logs. It falls back to GET when the
   route is missing. `redirectTarget` only changes attribution on the portal's confirmation page (`cli`,
   `sdk`, …). Both work.
4. **Usage schema is now authoritative.** The SDK bundle ships the protobuf descriptors for
   `GetCurrentPeriodUsageResponse`, `PlanUsage`, `SpendLimitUsage`, `GetPlanInfoResponse.PlanInfo`, and
   `NextUpgrade`, so field names and types are exact (see below).
   Two consequences:
   - int64 fields such as `billingCycleStart` and `billingCycleEnd` serialize as JSON strings.
   - proto3 JSON **omits default-valued fields**. `remaining: 0`, `limit: 0`, `enabled: false`, and
     `individualLimit` can all be absent. Treat a missing field as its zero value, not as an error.
5. **The IDE's `state.vscdb` does hold `cursorAuth/refreshToken`.** It sits next to `cursorAuth/accessToken`,
   `cursorAuth/cachedEmail`, `cursorAuth/stripeMembershipType`, and `cursorAuth/stripeSubscriptionStatus`.
   9router's current auto-import (`src/app/api/oauth/cursor/auto-import/route.js`) only reads the access-token
   keys, so it should also capture `cursorAuth/refreshToken`. The IDE writes the refreshed access token into
   **both** slots, so the IDE's "refresh token" is often identical to its access token.
6. **Headers.** Poll, refresh, and usage all work with no Cursor-specific headers; the only extra is
   `Connect-Protocol-Version: 1` on Connect RPCs. For fidelity, send the CLI's own headers:
   - `x-cursor-client-type: cli`
   - `x-cursor-client-version: cli-<build>` (for example `cli-2026.09.23-86fc751`)
   - `x-ghost-mode: true|false`
   - `x-request-id: <uuid>`

   You can also send `x-cursor-team-id` to scope a request to a team. No rate limits are documented.
   The SDK treats 429 as retryable (`resource_exhausted`) and 5xx as retryable (`internal`).

## Primary APIs

All endpoints are undocumented and reverse-engineered, so they can change without notice. The Cursor forum
position quoted in chatboxai/chatbox `docs/technical/subscription-oauth-research.md` is that third-party use of
private `api2.cursor.sh` RPCs with subscription tokens may breach the ToS. This is a product risk to note, not a
technical blocker.

### 1. Browser login (PKCE "deep control")

| Item         | Value                                                                                                                                                          | Source                                                                                               |
| ------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------- |
| Login URL    | `https://cursor.com/loginDeepControl?challenge=<b64url(sha256(verifier))>&uuid=<uuidv4>&mode=login&redirectTarget=<cli\|sdk>[&supportsSelectedTeamLogin=true]` | cursor-agent `cursor-config/dist/auth/login.js` `startLogin()`; `@cursor/sdk` `createLoginHandshake` |
| Verifier     | `base64url(randomBytes(32))` with no padding                                                                                                                   | same                                                                                                 |
| Website base | `CURSOR_WEBSITE_URL` or `https://cursor.com`                                                                                                                   | same                                                                                                 |
| API base     | `CURSOR_API_BASE_URL` (CLI) / `CURSOR_BACKEND_URL` (SDK) or `https://api2.cursor.sh`                                                                           | same                                                                                                 |

`redirectTarget`: the SDK typings say "`redirectTarget=sdk` attributes the login to the SDK on the portal's
confirmation and success pages" (`dist/esm/auth/login-flow.d.ts`), and the CLI defaults to `cli`. No evidence
suggests it changes the token type. Keep `cli`, which every router reference uses and which was live-verified
by us and by ccLoad#122. **Confidence: High.**

### 2. Poll

| Variant                                    | Request                                                                                                                                  | Used by                                                                               |
| ------------------------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------- |
| GET (legacy, still used by CLI 2026.09.23) | `GET /auth/poll?uuid=<uuid>&verifier=<verifier>`, headers `Content-Type: application/json` plus an optional `x-cursor-mdm-signin-policy` | cursor-agent `waitForResult`; pi-cursor, opencodex, OmniRoute, cursed-gateway, ccLoad |
| POST (preferred by SDK 1.0.32)             | `POST /auth/poll`, `content-type: application/json`, body `{"uuid":…,"verifier":…}`                                                      | `@cursor/sdk` `pollForLoginTokens`                                                    |

Response semantics, from `@cursor/sdk` `login-flow` and the cursor-agent `waitForResult` implementation:

- `404` with body exactly `Not found` means pending: back off and continue.
  - The SDK tells a pending 404 apart from a route-missing 404 by body. If the first POST 404 body is not
    `Not found`, it switches permanently to GET.
  - A route-missing body is JSON whose `message` matches `/^Route \w+:/` and contains `not found`, for example
    `{"message":"Route POST:/auth/poll not found"}`.
- `200` returns JSON. Accept it only if `accessToken` and `refreshToken` are strings; otherwise the CLI reports
  `bad_200`.
  - Extra fields: `selectedTeamId`, which the CLI reads as `w.selectedTeamId` after login and which only comes
    back with `supportsSelectedTeamLogin=true`.
  - The eisbaw reverse-engineering of IDE 2.3.41 lists `authId` (`eisbaw/cursor_api_demo`
    `reveng_2.3.41/analysis/TASK-68-workos-sso.md`). Treat it as optional. The CLI gets `authId` from
    `DashboardService/GetMe` instead.
- `403` with JSON `{"error":"sign_in_policy_violation"}` is terminal. It means an MDM or org device policy
  blocks sign-in, and the CLI throws `SignInPolicyViolationError`.
- Any other non-2xx counts as an error. Three consecutive errors, or 150 attempts, means give up.
- opencodex treats `400/401/403/410` as terminal on the first hit (`lidge-jun/opencodex`
  `src/oauth/cursor.ts`, `POLL_TERMINAL_STATUSES`). That is a reasonable hardening.

Cadence is identical in the CLI, the SDK, pi-cursor, opencodex, and cursed-gateway: `delay = min(1000 * 1.2^attempt, 10000)`,
`maxAttempts = 150`, which works out to about 20 minutes. The SDK typings say "timeout (~20 minutes with default
settings)". OmniRoute keeps its server-side login session for 15 minutes (`src/lib/oauth/services/cursorLogin.ts`
`SESSION_TTL_MS`). **Confidence: High.**

Security: the verifier is redeemable. With the uuid, anyone can finish the login and, through the SDK flow, mint
a durable API key. Keep it server-side. Never return it to the browser or log it, and prefer POST so it stays out
of URLs (`@cursor/sdk` typings). OmniRoute and opencodex keep verifiers in a server-side session map and return
only `{sessionId, loginUrl}`.

### 3. Token refresh

| Path                                                                                                                                                                                     | Credential                                                                   | Response                                                                                                                                             | Verdict                                                                                                                                                                                                                                                                                                                         |
| ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `POST https://api2.cursor.sh/oauth/token`, `Content-Type: application/json`, body `{"grant_type":"refresh_token","client_id":"KbZUR41cY7W6zRSdpSUJ7I7mLYBKOCmB","refresh_token":"<rt>"}` | Session refresh token (IDE `cursorAuth/refreshToken` or poll `refreshToken`) | `200 {"access_token":"<jwt>","id_token":"<jwt>","shouldLogout":false}`. On an invalid token: `{"access_token":"","id_token":"","shouldLogout":true}` | **Use this for session tokens.** Sources: AixleHQ/flow#287 (live, 2026-09-17: "200, new token, 60 days"); robinebers/openusage `Sources/OpenUsage/Providers/Cursor/CursorUsageClient.swift`; openchamber `packages/web/server/lib/quota/providers/cursor.js`; cbnsndwch/pacebar `docs/providers/cursor.md`; ttaatoo/quotabar#44 |
| `POST https://api2.cursor.sh/auth/exchange_user_api_key`, `Authorization: Bearer <crsr_ key>`, body `{}`                                                                                 | User API key `crsr_…` (from `cursor.com/dashboard/api`)                      | `200 {"accessToken","refreshToken"}`. The JWT has `type:"api_key_token"` and about a 1 h TTL, and the refreshToken has the same `exp`                | API-key connections only. "Refresh" means re-exchanging the key. Sources: cursor-agent `loginWithApiKey`; `@cursor/sdk` `gr()`; OmniRoute `open-sse/services/cursorApiKeyAuth.ts` and `docs/providers/CURSOR-API-KEY-AND-CLI.md`; weselben/GoModel#17                                                                           |
| `exchange_user_api_key` with a session access or refresh JWT                                                                                                                             | —                                                                            | `401 Invalid User API Key`                                                                                                                           | **Does not work.** Source: sudosubin/pi-frontier#30 live table, 2026-08-31                                                                                                                                                                                                                                                      |

Refresh semantics:

- **Rotation.** `/oauth/token` returns no refresh token. AixleHQ/flow#287 notes that the login-issued refresh
  token has its own roughly 60-day expiry, and that "the IDE writes the new access token into both" slots.
  The eisbaw IDE reconstruction shows the same thing: `storeAccessRefreshToken(result.access_token, result.access_token)`.
  Recommendation: after a successful refresh, set `accessToken = access_token` and `refreshToken = access_token`
  to mirror the IDE, so the credential doesn't die on the original refresh token's schedule.
  **Confidence: Medium.** It comes from two independent reverse-engineering sources, and we have not verified it
  ourselves.
- **Lifetime.**
  - Session access JWTs last about 60 days. We live-verified this on the imported token, and AixleHQ reports the
    same for refreshed tokens.
  - API-key-exchanged JWTs last about 1 h.
  - Refresh when `exp - now < 5 min`. The CLI's `isTokenExpiringSoon` uses `exp - now < 300 s`, and pi-cursor,
    opencodex, OmniRoute, and openchamber use a 5-minute skew. A 1 h fallback applies if `exp` can't be decoded.
- **Errors.**
  - `shouldLogout:true` on a 200 is permanent. Mark the connection as needing re-auth and don't retry.
  - HTTP 401 is permanent.
  - 429 and 5xx are transient; retry with jittered backoff (3 attempts, 300 ms base, as in opencodex and OmniRoute).
  - AixleHQ found that a wrong path returns an HTML 404, so treat a non-JSON body as an error.
- **Access token as refresh credential.** There is no evidence that exchanging the access token works, and
  pi-frontier#30 shows `exchange_user_api_key` rejects it. Whether `/oauth/token` accepts an access JWT as
  `refresh_token` is unverified. Given the IDE's both-slots behaviour it probably does after the first refresh,
  but it has not been tested.

Evidence conflict: eisbaw's reconstruction of IDE 2.3.41 shows `POST ${backendUrl}/auth/refresh` with
`{refreshToken}`. AixleHQ/flow#287 read the current IDE bundle (`_performAccessTokenRefresh`) and live-verified
`/oauth/token`. Three more production tools use `/oauth/token`. Prefer `/oauth/token`; eisbaw's pseudo-code is
reconstructed rather than literal.

### 4. Usage and plan (Connect JSON on `api2.cursor.sh`)

Common request: `POST`, `Authorization: Bearer <access>`, `Content-Type: application/json`,
`Connect-Protocol-Version: 1`, body `{}`.

Optional request fields from the proto:

- `GetCurrentPeriodUsageRequest { team_id int32?, include_pooled_usage bool? }`
- `GetCreditGrantsBalanceRequest { team_id? }`

Proto descriptors extracted from `@cursor/sdk@1.0.32` `dist/esm/index.js`. Type codes: `3` = int64, sent as a JSON
string; `5` = int32; `1` = double; `8` = bool; `9` = string; `?` = optional; `*` = repeated.

```text
GetCurrentPeriodUsageResponse
  1 billing_cycle_start int64 | 2 billing_cycle_end int64 | 3 plan_usage PlanUsage | 4 spend_limit_usage SpendLimitUsage
  5 display_threshold int32? | 6 enabled bool | 7 display_message string | 8 free_best_of_n_promotion {trials_used, trials_remaining}?
  11 auto_model_selected_display_message string? | 12 named_model_selected_display_message string? | 13 auto_bucket_models string[]
PlanUsage (all cents except *_percent_used)
  1 total_spend | 2 included_spend | 3 bonus_spend | 4 remaining | 5 limit | 6 remaining_bonus bool? | 7 bonus_tooltip string?
  8 auto_spend? | 9 api_spend? | 10 auto_limit? | 11 api_limit? | 12 auto_percent_used double? | 13 api_percent_used double? | 14 total_percent_used double?
SpendLimitUsage (cents)
  1 total_spend | 2 pooled_limit? | 3 pooled_used? | 4 pooled_remaining? | 5 individual_limit? | 6 individual_used | 7 individual_remaining
  8 limit_type string ("user" | "team") | 9 overall_limit? | 10 overall_used? | 11 overall_remaining?
GetPlanInfoResponse { 1 plan_info PlanInfo? | 2 next_upgrade NextUpgrade? }
PlanInfo { 1 plan_name | 2 included_amount_cents int32 | 3 price string? | 4 billing_cycle_end int64? | 5 plan_owner enum {UNSPECIFIED, STRIPE, APPLE} }
NextUpgrade { tier, name, included_amount_cents, price, description }
GetCreditGrantsBalanceResponse { has_credit_grants bool | credit_balance_cents int64 | total_cents int64 | used_cents int64 }
```

Other DashboardService RPCs in the same bundle that are relevant to quotas:

- `GetUsageLimitPolicyStatus`: `is_in_slow_pool`, `limit_type`, `reset_at_ms`, `current_on_demand_limit_cents`, and more.
- `GetUsageLimitStatusAndActiveGrants`.
- `GetSandUsageStatus`: the Grok Bot weekly allowance. OpenUsage maps it.
- `GetMe`: `auth_id`, `user_id`, `email`, `team_id?`, `is_enterprise_user?`, `team_name?`, `is_team_admin?`.
- `GetClientVisibleCreditGrants`.

Non-RPC endpoints:

- `GET https://api2.cursor.sh/auth/full_stripe_profile` (Bearer): `membershipType` / `membership_type`, `subscriptionStatus`, …
  - Normalize `pro+` / `proplus` to `pro_plus` (CoreUnit-NET/cursed-gateway `lib/cursor/account/account.go` `NormalizeTier`).
- Cookie endpoints (`cursor.com/api/usage-summary`, `/api/usage?user=<id>`, `/api/auth/stripe`,
  `/api/dashboard/get-current-period-usage`, `/api/dashboard/export-usage-events-csv`).
  - They use `Cookie: WorkosCursorSessionToken=<userId>%3A%3A<accessToken>`, where
    `userId = sub.split("|")[1] ?? sub` (openusage `CursorUsageClient.session(from:)`).
  - **They often return a Vercel Security Checkpoint HTML 403**, which is not an auth failure (ttaatoo/quotabar#44).
    Prefer the api2 Bearer RPCs and use cookies only as a fallback.
- `GET https://api2.cursor.sh/api/usage/summary`: we observed a 404. OmniRoute and opencodex still try it as a
  fallback, along with the legacy `GET /auth/usage` (`{"gpt-4":{numRequests,maxRequestUsage},startOfMonth}`)
  for request-based and Enterprise plans.

## Libraries and SDKs

| Package                                                                                                         | Relevance                                                         | Notes                                                                                                                                                                                                                                                                                                                                              |
| --------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `@cursor/sdk` (npm, 1.0.32, 2026-09-22)                                                                         | Official reference for the login flow, headers, and proto schemas | `Cursor.auth.login()` polls, then **mints a 90-day user API key** via `DashboardService.CreateUserApiKey {name, scopes[], expires_at}` and discards the session token (`DEFAULT_LOGIN_API_KEY_TTL_MS`). We should not add it as a dependency: the bundle is about 2 MB, it drags in the agent runtime, and our needs are about 150 lines of fetch. |
| `cursor-agent` CLI                                                                                              | Reference only                                                    | Stores `{accessToken, refreshToken, apiKey?}` in `~/.config/cursor/auth.json` on Linux (`~/.cursor/auth.json` on macOS in file mode), or in the Keychain services `cursor-access-token` / `cursor-refresh-token` / `cursor-api-key`.                                                                                                               |
| Node built-ins (`node:crypto` `randomBytes`, `createHash`, `randomUUID`; global `fetch`; `AbortSignal.timeout`) | Everything needed                                                 | No new dependency is needed. The existing SQLite driver chain (`src/lib/db/driver.js`) or `node:sqlite` can read `state.vscdb`; paseo uses `node:sqlite` with `{readOnly:true}`.                                                                                                                                                                   |

An alternative design, which the SDK's own login uses: after PKCE, call `CreateUserApiKey` to mint a `crsr_` key,
then refresh by re-exchanging it hourly through `exchange_user_api_key`. This avoids the IDE client_id entirely,
but it creates a visible key in the user's dashboard, and a team admin can block user API keys. The SDK surfaces
exactly that error. Treat it as an optional path. **Confidence: High** that it works, since it is Cursor's
official SDK behaviour.

## Integration Patterns

1. **Server-side login session.** This is the OmniRoute `cursorLogin.ts` and upstream decolua/9router#2755 pattern.
   - `POST /api/oauth/cursor/start` generates `{verifier, challenge, uuid}`, stores the verifier in a bounded
     map with a TTL of about 15 min, and returns `{sessionId, loginUrl}`.
   - The UI polls `GET /api/oauth/cursor/poll?sessionId=`, and the server does one `/auth/poll` per call.
     OmniRoute's `pollCursorAuthOnce` returns `pending | ok | error`, with the route layer owning the loop.
   - On `ok`, consume the session and persist the connection.
2. **Credential shape.** Store `accessToken`, `refreshToken`, `expiresAt` (from JWT `exp` minus 5 min), and
   `providerSpecificData.userId` (from JWT `sub`), plus `email` when present. Multi-account dedupe uses `sub`
   (opencodex `credentialsFromCursorTokens`).
3. **Refresh dispatcher.**
   - If the connection has a `crsr_` apiKey, re-exchange it.
   - Otherwise, if it has a refreshToken, call `/oauth/token`.
   - Otherwise, require re-login.
   - Use single-flight per connection; OmniRoute uses `inflightExchanges` for this.
   - On a 401 from any RPC, invalidate the token, refresh once, and retry once. This matches the SDK
     interceptor ("Auth expired, re-authenticating") and OpenUsage's usage fetch.
4. **Usage fetch.**
   - Fire `GetCurrentPeriodUsage` (required) and `GetPlanInfo` (optional, allowed to fail) in parallel, with
     optional `GetCreditGrantsBalance` (openchamber `fetchQuota`). Use a timeout of 10–12 s.
   - Fallback chain, if desired: OmniRoute `open-sse/services/usage/cursor.ts`, then
     `/api/usage/summary` → `/auth/usage` → the cookie dashboard.
5. **Mapping to Provider Limits windows.** This is the consensus across t3code, opencodex, OpenUsage, OmniRoute,
   and openchamber.
   - Primary "Total" is `totalPercentUsed`, falling back to `includedSpend / limit` or
     `(limit - remaining) / limit`. Reset comes from `billingCycleEnd`.
     - t3code notes: "Cursor's dashboard percentages include bonus usage; spend / limit does not"
       (`pingdotgg/t3code` `apps/server/src/provider/Layers/cursorUsageLimits.ts`).
   - Secondary windows are `autoPercentUsed` ("Auto + Composer" / "Cursor Models" / "First-party models") and
     `apiPercentUsed` ("API" / "Other Models"). They are separate pools and must not replace Total (opencodex comment).
   - On-demand: `individualLimit ?? pooledLimit`, remaining `individualRemaining ?? pooledRemaining`, shown
     only when the limit is greater than 0 (openchamber, OpenUsage).
   - Plan label: `GetPlanInfo.planInfo.planName`. Don't hard-code "Cursor Pro", which OmniRoute does. Our live
     token returned `Ultra`.

## Constraints and Gotchas

- **int64 values are strings.** `billingCycleStart` and `billingCycleEnd` are epoch-ms strings; parse them with
  `Number()`. paseo also handles second-based values (`< 1e10` gets multiplied by 1000).
- **proto3 omits zero values.**
  - A missing `remaining` or `limit` means 0 or unknown.
  - A missing `enabled` field means `false` under proto semantics. OpenUsage nonetheless treats "absent" as
    enabled and only an explicit `false` as off; openchamber checks `usage.enabled === false || !usage.planUsage`
    and reports "No active Cursor subscription".
  - Recommendation: when `enabled` is absent **and** `planUsage` is empty or missing, report no active
    subscription. Otherwise render what exists.
- **Free plan.** Payloads observed on 2026-03-06 may omit `limit` and carry only `totalPercentUsed`
  (cbnsndwch/pacebar `docs/providers/cursor.md`). Use percent-only windows.
- **Team and business plans.**
  - Detect a team when `planName == "Team"`, or `spendLimitUsage.limitType == "team"`, or `pooledLimit > 0`
    (OpenUsage `CursorPlanUsageFacts.isTeamByShape`, pacebar).
  - Show team Total in dollars (`totalSpend / limit`), and fail over to request-based `/api/usage` when `limit`
    is missing.
  - `GetCurrentPeriodUsageRequest.team_id` and `include_pooled_usage` exist for explicit team scoping; the
    `x-cursor-team-id` header does the same in the CLI.
- **Enterprise.** The plan is request-based: `gpt-4.numRequests / maxRequestUsage` from `cursor.com/api/usage?user=` (cookie).
- **"Unlimited" plans.** No explicit unlimited flag exists in `PlanUsage`. A limit of 0 together with no
  `totalPercentUsed` should render as "no data", not 100% used. OmniRoute substitutes a fake 100-cent limit
  there, which is misleading.
- **`membershipType` vs `individualMembershipType` disagree** in `full_stripe_profile`, as seen in our live test.
  Prefer `GetPlanInfo.planName` for the label.
- **Cookie endpoints hit the Vercel WAF.** An HTML 403 is not a logout, so don't clear credentials on it
  (ttaatoo/quotabar#44).
- **IDE import.** `cursorAuth/refreshToken` exists, but after an IDE-side refresh it often equals the access
  token. Both work as input to `/oauth/token` per AixleHQ; this is unverified for the access-equals-refresh case.
  - Also consider reading `~/.config/cursor/auth.json` (cursor-agent file store) and the `cursorAuthStatus`
    legacy JSON blob (paseo).
  - Docker: the host `state.vscdb` isn't visible inside the container, so PKCE login is the Docker path
    (OmniRoute `docs/providers/CURSOR-DOCKER.md`).
- **Don't reuse the upstream PR's refresh.** decolua/9router#2755 (open) implements refresh through
  `exchange_user_api_key` with the session refresh token, which is broken per pi-frontier#30.
- **Headers.** The CLI sets `x-cursor-client-version: cli-<build>[-channel]`, `x-cursor-client-type: cli`,
  `x-ghost-mode` (from a cached privacy mode, default `"true"`), and `x-request-id`.
  - ccLoad pins `User-Agent: cursor-agent/<ver>` (`caidaoli/ccLoad` `internal/cursorauth/headers.go`).
  - OmniRoute resolves the version from `CURSOR_AGENT_CLI_VERSION`, then an installer-script scrape, then a
    pinned id.
  - For DashboardService calls, t3code sends just `connect-protocol-version: 1` plus `x-cursor-client-type: cli`,
    and paseo and CodeNomad send no client headers at all. All of these work.
- **Rate limits.** Nothing is documented. Treat 429 as retryable with backoff, cache usage for at least 60 s,
  and single-flight refreshes.

## Code Examples

PKCE start and poll (plain JS ESM). This sketch covers POST-with-GET-fallback and the terminal statuses:

```js
import { randomBytes, createHash, randomUUID } from "node:crypto";
const b64url = (b) => b.toString("base64url");
export function createCursorLogin(web = "https://cursor.com") {
  const verifier = b64url(randomBytes(32));
  const challenge = b64url(createHash("sha256").update(verifier).digest());
  const uuid = randomUUID();
  const q = new URLSearchParams({ challenge, uuid, mode: "login", redirectTarget: "cli" });
  return { verifier, uuid, loginUrl: `${web}/loginDeepControl?${q}` };
}
// One poll attempt; caller owns cadence: delay = Math.min(1000 * 1.2 ** n, 10_000), n < 150.
export async function pollCursorOnce({
  uuid,
  verifier,
  api = "https://api2.cursor.sh",
  useGet = false,
  signal,
}) {
  const res = useGet
    ? await fetch(
        `${api}/auth/poll?uuid=${encodeURIComponent(uuid)}&verifier=${encodeURIComponent(verifier)}`,
        { signal },
      )
    : await fetch(`${api}/auth/poll`, {
        method: "POST",
        headers: { "content-type": "application/json", accept: "application/json" },
        body: JSON.stringify({ uuid, verifier }),
        signal,
      });
  if (res.status === 404) {
    const body = (await res.text()).trim();
    if (!useGet && body !== "Not found") return { status: "fallback-get" }; // route missing on backend
    return { status: "pending" };
  }
  if (res.status === 403) {
    const j = await res.json().catch(() => null);
    if (j?.error === "sign_in_policy_violation") return { status: "terminal", reason: "policy" };
  }
  if ([400, 401, 403, 410].includes(res.status))
    return { status: "terminal", httpStatus: res.status };
  if (!res.ok) return { status: "error", httpStatus: res.status };
  const d = await res.json();
  if (typeof d?.accessToken !== "string" || typeof d?.refreshToken !== "string")
    return { status: "error", reason: "bad_200" };
  return {
    status: "ok",
    accessToken: d.accessToken,
    refreshToken: d.refreshToken,
    selectedTeamId: d.selectedTeamId,
    authId: d.authId,
  };
}
```

Session refresh through the IDE endpoint:

```js
const CURSOR_CLIENT_ID = "KbZUR41cY7W6zRSdpSUJ7I7mLYBKOCmB"; // Cursor desktop public client id
export async function refreshCursorSession(refreshToken, { signal } = {}) {
  const res = await fetch("https://api2.cursor.sh/oauth/token", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      grant_type: "refresh_token",
      client_id: CURSOR_CLIENT_ID,
      refresh_token: refreshToken,
    }),
    signal: signal ?? AbortSignal.timeout(15_000),
  });
  const body = await res.json().catch(() => null); // HTML 404 => null => error
  if (body?.shouldLogout === true || res.status === 401)
    throw Object.assign(new Error("cursor session revoked"), { permanent: true });
  if (!res.ok)
    throw Object.assign(new Error(`cursor refresh HTTP ${res.status}`), {
      retryable: res.status === 429 || res.status >= 500,
    });
  if (typeof body?.access_token !== "string" || !body.access_token)
    throw new Error("cursor refresh: no access_token");
  // No refresh token is returned; mirror the IDE and store the new access token in both slots.
  return { accessToken: body.access_token, refreshToken: body.access_token };
}
```

Usage call:

```js
async function cursorRpc(method, token, body = {}) {
  const res = await fetch(`https://api2.cursor.sh/aiserver.v1.DashboardService/${method}`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json",
      "Connect-Protocol-Version": "1",
      "x-cursor-client-type": "cli",
      "x-request-id": crypto.randomUUID(),
    },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(12_000),
  });
  if (!res.ok)
    throw Object.assign(new Error(`${method} HTTP ${res.status}`), { status: res.status });
  return res.json();
}
// const [usage, plan] = await Promise.all([cursorRpc("GetCurrentPeriodUsage", t), cursorRpc("GetPlanInfo", t).catch(() => null)]);
// const n = (v) => (v == null || v === "" ? undefined : Number(v)); resetAt = n(usage.billingCycleEnd)
```

## Open Questions

1. **Does `/oauth/token` accept a PKCE (deep-control) session refreshToken?** AixleHQ verified it with a
   "freshly minted credential" from a CLI device login inside their container, which suggests yes, but the
   request isn't quoted verbatim. Verify once with our own token by making a single refresh call during
   implementation. **Confidence: Medium-High.**
2. **Are the poll's `accessToken` and `refreshToken` distinct JWTs, and does the refreshToken expire (about 60 days)?**
   Decode both locally after the first real login, without calling Cursor.
3. **Does POST `/auth/poll` already work on production `api2.cursor.sh`?** SDK 1.0.32 ships it with a GET
   fallback. Implement both, as the SDK does.
4. **What is the exact `enabled:false` payload for lapsed or free accounts, and are there plans with `limit: 0` but
   finite percentages?** No fixture was found. Handle defensively.
5. **Rate limits on DashboardService and `/oauth/token`** are unknown. None of the references hit limits at
   60 s–5 min polling intervals.
6. **ToS exposure.** Refreshing with the IDE's client_id impersonates the desktop app. The SDK-style alternative
   (mint a `crsr_` key with `CreateUserApiKey` and re-exchange it) uses an officially supported credential, but
   creates a visible key in the user's dashboard. This is a product decision.

## Search Queries and Sources Consulted

- `gh search code "exchange_user_api_key"`, `"auth/poll" "api2.cursor.sh"`, `"KbZUR41cY7W6zRSdpSUJ7I7mLYBKOCmB"`, `"cursorAuth/refreshToken"`.
- `gh search issues|prs "exchange_user_api_key"` and `"cursor auth/poll refresh token"`.
- Repos and files read:
  - diegosouzapw/OmniRoute: `open-sse/services/usage/cursor.ts`, `open-sse/services/tokenRefresh/providers/cursor.ts`, `src/lib/oauth/services/cursorLogin.ts`, `open-sse/services/cursorApiKeyAuth.ts`, `docs/providers/CURSOR-DOCKER.md`, `docs/providers/CURSOR-API-KEY-AND-CLI.md`
  - lidge-jun/opencodex: `src/oauth/cursor.ts`, `src/providers/quota/vendor-probes-oauth.ts`
  - schultzp2020/pi-extensions: `packages/pi-cursor/src/auth.ts`
  - pingdotgg/t3code: `apps/server/src/provider/Layers/cursorUsageLimits.ts`
  - openchamber/openchamber: `packages/web/server/lib/quota/providers/cursor.js`
  - getpaseo/paseo: `packages/server/src/services/quota-fetcher/providers/cursor.ts`
  - NeuralNomadsAI/CodeNomad: `packages/server/src/usage/providers/special.ts`
  - CoreUnit-NET/cursed-gateway: `lib/cursor/account/account.go`
  - robinebers/openusage: `Sources/OpenUsage/Providers/Cursor/{CursorUsageClient,CursorUsageMapper,CursorAuthStore}.swift`, `docs/providers/cursor.md`
  - cbnsndwch/pacebar: `docs/providers/cursor.md`
  - caidaoli/ccLoad: `internal/cursorauth/{constants,headers,credential,service,usage}.go`
  - eisbaw/cursor_api_demo: `reveng_2.3.41/analysis/TASK-68-workos-sso.md`
  - chatboxai/chatbox: `docs/technical/subscription-oauth-research.md`
- PRs and issues:
  - sudosubin/pi-frontier#30 (2026-08-31)
  - AixleHQ/flow#287 (merged 2026-09-17)
  - ttaatoo/quotabar#44 (merged 2026-09-14)
  - decolua/9router#2755 (open, 2026-07-21)
  - caidaoli/ccLoad#122 (merged 2026-08-21)
  - weselben/GoModel#17
  - kaitranntt/ccs#1017
- Shipped client code: `@cursor/sdk@1.0.32` (npm pack), `cursor-agent` `2026.09.23-86fc751` (public installer tarball).
