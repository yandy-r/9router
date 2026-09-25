# Feature Spec: Cursor browser login, token refresh, and plan usage (YAN-385)

## Executive Summary

9router can only add Cursor connections today by importing the IDE's `state.vscdb` token. That path does
not work on headless or Docker hosts. The imported connection gets a fake 24h expiry and can never
refresh, and Cursor usage is invisible in Provider Limits. This feature adds three things:

- A **"Login with browser"** flow. It uses Cursor's PKCE deep-control handshake (the `cursor-agent` CLI's
  login) and reuses the existing generic `device_code` route and modal.
- **Real token refresh** through `POST api2.cursor.sh/oauth/token` (`grant_type=refresh_token`, Cursor IDE
  public client id). This was live-verified on 2026-09-25. The originally planned `exchange_user_api_key`
  returns 401 for session tokens.
- **Cursor plan usage** (`DashboardService/GetCurrentPeriodUsage` + `GetPlanInfo`) in Provider Limits and
  the quota snapshot that feeds the weighted account strategy.

Nearly all plumbing exists: the device-code route, re-login dedup, the refresh registry, the usage dispatcher,
and the quota snapshot. The work is a new Cursor provider module, a small shared auth helper, a usage
handler, and targeted wiring. The main risks are undocumented-endpoint drift and the modal and
`CursorAuthModal` conflicting with the `re-design` branch. This work targets `master`.

## External Dependencies

### APIs and Services

#### Cursor auth (reverse-engineered, no public docs)

- **Documentation**: none official. The sources are Cursor's shipped `cursor-agent` build and `@cursor/sdk@1.0.32`,
  pi-cursor `auth.ts`, cursed-gateway `lib/cursor/account`, and AixleHQ/flow#287 (refresh). See
  `research-external.md`.
- **Authentication**: PKCE S256 (verifier 32 random bytes base64url) plus a random uuid. No client registration.
- **Key Endpoints**:
  - `GET https://cursor.com/loginDeepControl?challenge=<S256>&uuid=<uuid>&mode=login&redirectTarget=cli` is the
    browser page (live: 200).
  - `GET https://api2.cursor.sh/auth/poll?uuid=&verifier=` returns `404 "Not found"` while pending and
    `200 {accessToken, refreshToken, authId?}` on success. `403 {"error":"sign_in_policy_violation"}` is terminal
    (an org device policy).
  - `POST https://api2.cursor.sh/oauth/token` with JSON
    `{grant_type:"refresh_token", client_id:"KbZUR41cY7W6zRSdpSUJ7I7mLYBKOCmB", refresh_token}` returns
    **200** `{access_token, id_token, shouldLogout}` (live-verified with both a CLI-login token and an
    IDE-imported token). It never returns a new refresh token. The IDE stores the new access token in both
    slots, and any valid session JWT, including the access token itself, works as `refresh_token`. An invalid
    token **also returns 200**, with `{access_token:"", shouldLogout:true}`, which means a dead session.
  - `POST https://api2.cursor.sh/auth/exchange_user_api_key` is **not usable**. It returns 401 "Invalid User API Key"
    for session tokens (live-verified).
- **Rate Limits**: undocumented. Treat 429/5xx as transient.
- **Pricing**: n/a. The user's own Cursor subscription.

#### Cursor usage (Connect JSON)

- **Key Endpoints** (Bearer access token, `Content-Type: application/json`, `Connect-Protocol-Version: 1`, body `{}`;
  no checksum or machineId needed; live-verified):
  - `POST https://api2.cursor.sh/aiserver.v1.DashboardService/GetCurrentPeriodUsage` returns
    `{billingCycleStart, billingCycleEnd (epoch-ms strings), planUsage{totalSpend, includedSpend, bonusSpend, limit
(cents), autoPercentUsed, apiPercentUsed, totalPercentUsed, remainingBonus, bonusTooltip},
spendLimitUsage{totalSpend, individualLimit, individualUsed, individualRemaining, pooledLimit?, pooledUsed?,
pooledRemaining?, limitType}, enabled, displayMessage, …}`.
  - `POST …/DashboardService/GetPlanInfo` returns `{planInfo{planName ("Ultra"), price, billingCycleEnd, …}}`.
- proto3 JSON **omits zero/false fields**, so missing means 0, not an error.
- `api2 /api/usage/summary` returns 404, and `/auth/usage` is legacy and empty. Don't use either.

### Libraries and SDKs

- No new dependencies. PKCE comes from `src/lib/oauth/utils/pkce.js` (`generatePKCE`), crypto from `node:crypto`,
  and HTTP from the global `fetch` / `fetchWithTimeout` (`open-sse/services/usage/shared.js`).

### External Documentation

- [OpenUsage Cursor provider](https://openusage.sh/docs/providers/cursor/): usage field semantics.
- [paseo #4997](https://github.com/getpaseo/paseo/issues/4997): `totalSpend` includes bonus, so use the percentages.
- [wrfly/AgentLodge PR #65](https://github.com/wrfly/AgentLodge/pull/65): the PKCE flow and the 403 policy code.

## Business Requirements

### User Stories

**Primary User: self-hosting 9router operator**

- As an operator running 9router in Docker, I want to connect Cursor by logging in from any browser so that I
  don't need a Cursor IDE on the server.
- As an operator, I want Cursor connections to refresh automatically so that they don't die silently.
- As an operator, I want Provider Limits to show my Cursor plan and how much of the included and on-demand
  usage I've spent, so that I can see when Cursor will run out.

**Secondary: the routing engine**

- As the weighted account strategy, I want a Cursor plan tier and a monthly usage window so that Cursor
  accounts are weighted and drained like other subscription providers.

### Business Rules

1. **Identity**: dedup keys on the JWT `sub`, stored as the connection `email`, the same way `extractUserInfo`
   already does for import. A browser login for an account that's already imported updates that row. It
   doesn't create a duplicate.
2. **machineId**: every Cursor connection must have `providerSpecificData.machineId`, because the executor throws
   without one. Browser logins generate `sha256(randomUUID())` hex. Imports keep the IDE's id.
3. **Expiry**: `expiresAt` comes from the JWT `exp` (~60 days) for both flows. Never hard-code 24h.
4. **Refresh token**: store `refreshToken = poll.refreshToken`, or for an import, `IDE refreshToken ?? accessToken`.
   After a refresh, the new access token also becomes the refresh token (the IDE behavior).
5. **Dead session**: `shouldLogout:true`, an empty `access_token`, or 401/403 is a terminal `invalid_grant`. Other
   failures are transient (`null`).
6. **Usage percentages**: use Cursor's `*PercentUsed` fields. Never compute spend ÷ limit for the percent,
   because bonus usage makes that wrong.
7. **Fail soft**: a usage failure shows a message in the card and never blocks routing.

### Edge Cases

| Scenario                                  | Expected Behavior                                                                          | Notes                                              |
| ----------------------------------------- | ------------------------------------------------------------------------------------------ | -------------------------------------------------- |
| User closes the tab / never logs in       | The modal times out (~10 min) and can retry                                                | poll 404s until the deadline                       |
| Org device policy blocks sign-in          | Poll 403 `sign_in_policy_violation` becomes `access_denied`; the modal stops with an error |                                                    |
| Legacy imported row, no refreshToken      | Refresh falls back to the accessToken; heals on the first refresh                          | verified the access token works as a refresh token |
| Free/lapsed plan, omitted `limit`         | Only the percent rows are shown; zero-limit rows are skipped                               | proto3 omission                                    |
| Team plan (`pooled*`, `limitType:"team"`) | On-demand uses `individual* ?? pooled*`                                                    |                                                    |
| Percent > 100 (bonus)                     | The bar is clamped; text shows the real %                                                  |                                                    |
| GetPlanInfo fails                         | Usage is still shown, without a plan label                                                 | `Promise.allSettled`                               |

### Success Criteria

- [ ] A browser login in the dev container creates a working Cursor connection (chat succeeds) with a refresh token
      and a JWT-based `expiresAt`.
- [ ] A forced refresh (expiresAt in the past) obtains a new token through `/oauth/token` and chat keeps working.
- [ ] Provider Limits shows the Cursor plan and the Total / Auto + Composer / API / On-demand rows with the reset date.
- [ ] The quota snapshot records a Cursor `month` window and a `planTier`.
- [ ] The test gate (`known-fails.txt`), the baseline scripts, lint, and `next build` all pass.

## Technical Specifications

### Architecture Overview

```text
CursorAuthModal ── mode "browser" ─► OAuthModal provider="cursor" (device-code branch)
                │                     GET /api/oauth/cursor/device-code → generic PKCE branch
                │                        → providers/cursor.requestDeviceCode(config, challenge)  (no network)
                │                     POST /api/oauth/cursor/poll (every 2s) → pollForToken
                │                        → providers/cursor.pollToken → GET auth/poll → mapTokens
                │                        → createProviderConnection (dedup on sub)
                └─ mode "import" ──► existing import / auto-import (+ refreshToken, JWT expiry)

Refresh: REFRESH_HANDLERS.cursor / CursorExecutor.refreshCredentials
         → open-sse/shared/cursorAuth.refreshCursorSession → POST /oauth/token
Usage:   /api/usage/[id] → USAGE_HANDLERS.cursor → open-sse/services/usage/cursor.js
         → parseQuotaData("cursor") → QuotaTable; recordUsageSnapshot(kindForName/planTierFor "cursor")
```

### Data Models

#### providerConnections (no migration; JSON `data` column)

| Field          | Browser login                   | Import                          | Notes                                          |
| -------------- | ------------------------------- | ------------------------------- | ---------------------------------------------- |
| authType       | `oauth`                         | `oauth`                         | unchanged                                      |
| accessToken    | poll accessToken                | IDE token                       | top-level (the providers API strips it)        |
| refreshToken   | poll refreshToken               | IDE refreshToken ?? accessToken | top-level, **never** in `providerSpecificData` |
| expiresAt      | from the JWT `exp`              | from the JWT `exp`              | ISO                                            |
| email          | JWT sub (via `extractUserInfo`) | same                            | dedup key                                      |
| psd.machineId  | generated 64-hex                | IDE serviceMachineId            | required by the executor                       |
| psd.authMethod | `"browser"`                     | `"imported"`                    |                                                |
| psd.userId     | JWT sub                         | JWT sub                         |                                                |
| psd.planTier   | set by the usage snapshot       | same                            |                                                |

### API Design

#### `GET /api/oauth/cursor/device-code` (existing dynamic route, no change)

`cursor.requestDeviceCode(config, codeChallenge)` returns
`{device_code: uuid, user_code: null, verification_uri, verification_uri_complete: <loginUrl>, expires_in: 600, interval: 2}`.
The route adds `codeVerifier`.

#### `POST /api/oauth/cursor/poll` (existing, no change)

`pollToken(config, uuid, verifier)`:

- 404 → `{ok:false, data:{error:"authorization_pending"}}`
- 200 → `{ok:true, data:{access_token, refresh_token, expires_in}}`
- 403 policy → `{ok:false, data:{error:"access_denied", error_description}}`
- anything else → `{ok:false, data:{error:"poll_failed", error_description:<fixed text + status>}}`

On success the route creates the connection and returns only `{success:true, connection:{id, provider}}`. Tokens
are never returned to the browser.

#### Usage handler result

`{plan, planName, quotas:{Total, "Auto + Composer", API, "On-demand"}}`. Each quota is
`{used, total, remainingPercentage, resetAt, displayText?}`. Leave `message` unset on success. On a 401/403
return `{message:"Cursor authentication expired (401). Re-authorize the connection."}`.

### System Integration

#### Files to Create

- `open-sse/shared/cursorAuth.js`: `buildCursorLoginUrl`, `pollCursorLogin`, `refreshCursorSession`,
  `cursorJwtExpiresIn`, `generateCursorMachineId`. It holds all Cursor auth HTTP. URLs come from the registry `oauth` block.
- `open-sse/services/usage/cursor.js`: `getCursorUsage` plus a pure `parseCursorUsage` and `cursorPlanTier`.
- Tests (critical only): `tests/unit/cursor-auth.test.js` (poll mapping + refresh semantics) and
  `tests/unit/cursor-usage.test.js` (parser + tier).

#### Files to Modify

- `open-sse/providers/registry/cursor.js`: add `oauth.loginUrl/pollUrl/refreshUrl/refreshClientId` and
  `transport.usage` (with planInfoUrl), and set `features.usage: true`. Don't use the `tokenUrl`/`clientId` keys, which are
  injected into `PROVIDERS`.
- `src/lib/oauth/providers/cursor.js`: `flowType: "device_code"`, `requestDeviceCode`, `pollToken`, `mapTokens`.
- `src/lib/oauth/services/cursor.js`: `validateImportToken` uses JWT expiry and accepts a refreshToken.
- `src/app/api/oauth/cursor/import/route.js`, `auto-import/route.js`: carry the refreshToken (the IDE's
  `cursorAuth/refreshToken`).
- `open-sse/services/tokenRefresh.js`: `REFRESH_HANDLERS.cursor`.
- `open-sse/executors/cursor.js`: enable refresh (`supportsRefresh`, `canRefreshCredentials`, `refreshCredentials`),
  and map Connect `unauthenticated` → 401 and `permission_denied` → 403 in `classifyCursorError`.
- `open-sse/services/usage.js`: register the handler.
- `src/sse/services/quotaSnapshotSync.js` (`kindForName`, `planTierFor`) and `open-sse/config/quotaSnapshot.js`
  (`PLAN_CAPACITY.cursor`).
- `src/app/(dashboard)/dashboard/usage/components/ProviderLimits/utils.js`: a `cursor` case in `parseQuotaData`.
- `src/shared/components/OAuthModal.js`: add cursor to the device-code providers, and hide the user-code block when it's empty.
- `src/shared/components/CursorAuthModal.js`: a Browser (default) / Import mode switch. Auto-detect runs only in
  import mode.
- `tests/unit/usage-dispatch.test.js`: add cursor to the supported list.

#### Configuration

- `oauth.refreshLeadMs: 86_400_000` (1 day) so sleeping hosts still refresh before the 60-day expiry.

## UX Considerations

### User Workflows

#### Primary Workflow: Login with browser

1. **Add Connection → Cursor**. The modal opens on "Login with browser" (default) and "Import from Cursor IDE" tabs.
2. **Browser tab**. It shows the login URL with Open/Copy buttons (reusing the OAuthModal device step, without a user-code box)
   and a "Waiting for login…" spinner.
3. **User logs in** in any browser. The poll succeeds, the connection is created, and the modal shows success
   and closes.

#### Error Recovery Workflow

1. **Timeout / policy denied / poll error**: the modal shows the error with a Retry button (existing
   OAuthModal error state).
2. **Refresh dead** (`invalid_grant`): the connection is marked for re-auth (the existing unrecoverable-refresh
   path). The usage card message says "Re-authorize the connection".

### UI Patterns

| Component              | Pattern                                | Notes                                            |
| ---------------------- | -------------------------------------- | ------------------------------------------------ |
| CursorAuthModal        | Two-mode switch (like ProxyOAuthPanel) | Browser mode embeds OAuthModal                   |
| OAuthModal device step | Existing                               | Hide "Your Code" when `user_code` is null        |
| ProviderLimits         | Existing QuotaTable rows               | The plan label goes in the existing `plan` field |

### Accessibility Requirements

- Reuse the existing modal and button components, which already handle focus and keyboard. Add no new
  interactive primitives.

### Performance UX

- **Loading States**: the existing spinner while polling (2s interval) and the existing usage-card loading state.
- **Optimistic Updates**: none.
- **Error Feedback**: immediate on a terminal poll error, and the usage message on the next refresh.

## Recommendations

### Implementation Approach

**Recommended Strategy**: reuse the generic `device_code` route and modal with no route changes. Put all Cursor HTTP
in one `open-sse/shared/cursorAuth.js`. Use Cursor's percentages directly. Keep the edits to `OAuthModal.js` and
`ProviderLimits/index.js` minimal, because both are already over 1000 lines.

**Phasing:**

1. **Foundation**: registry constants plus `cursorAuth.js`.
2. **Parallel**:
   - A: login provider and import fixes
   - B: refresh and executor
   - C: usage handler and snapshot
   - D: UI
3. **Integration**: tests, baselines, build, and a live dev-container check.

### Technology Decisions

| Decision         | Recommendation                                                                              | Rationale                                                     |
| ---------------- | ------------------------------------------------------------------------------------------- | ------------------------------------------------------------- |
| Refresh endpoint | `/oauth/token` refresh_token grant                                                          | Live-verified. `exchange_user_api_key` returns 401            |
| PKCE state       | Generic route PKCE (the verifier goes to the authenticated dashboard client, same as Qoder) | No route changes. Tokens never reach the client. See Security |
| machineId        | Generated in `mapTokens`                                                                    | Login and poll don't bind it                                  |
| Poll cadence     | Fixed 2s interval, 600s expiry                                                              | KISS. No modal backoff changes needed                         |
| Usage source     | GetCurrentPeriodUsage + GetPlanInfo only                                                    | Bearer works for both flows. No cookie fallback               |

### Quick Wins

- The JWT-based `expiresAt` for imports fixes a spurious daily "expired" state.
- The `classifyCursorError` 401/403 mapping lets chat refresh and account fallback work for revoked tokens.

### Future Enhancements

- Show Cursor browser login in the CLI launcher menu (`cli/src/cli/menus/providers.js`).
- Add a "Reconnect" action for connections with dead refresh.
- Replace the connection test's `tokenExists` check with a usage probe.

## Risk Assessment

### Technical Risks

| Risk                                                | Likelihood | Impact | Mitigation                                                          |
| --------------------------------------------------- | ---------- | ------ | ------------------------------------------------------------------- |
| Undocumented endpoint drift                         | Medium     | Medium | Fail soft, keep the import fallback, keep constants in the registry |
| The IDE client_id for refresh is revoked or changed | Low        | High   | A single constant; dead refresh → re-login prompt                   |
| Merge conflict with `re-design` UI                  | High       | Low    | Minimal master edits; port the UI deltas later                      |
| Refresh races (request / background / usage)        | Low        | Low    | `dedupRefresh`; no rotation (the old token stays valid)             |

### Integration Challenges

- `OAuthModal` stops polling only on `access_denied`/`expired_token`. The policy 403 must map to `access_denied`.
- The quota poller treats a string `message` as failure, so successful usage must omit `message`.
- `parseQuotaData`'s default branch drops `remainingPercentage`, so it needs a dedicated `cursor` case.

### Security Considerations

#### Critical — Hard Stops

| Finding                       | Risk                                    | Required Mitigation                                                                                                                                              |
| ----------------------------- | --------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Tokens exposed to the browser | Credential theft via the dashboard APIs | Store tokens only as top-level `accessToken`/`refreshToken`, never in `providerSpecificData` (which `/api/providers` returns), and never return tokens from poll |

#### Warnings — Must Address

| Finding                                    | Risk                                                                               | Mitigation                                                                                                         | Alternatives                                                 |
| ------------------------------------------ | ---------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------ |
| PKCE verifier sent to the dashboard client | Someone holding the verifier and uuid could claim tokens during the pending window | Same pattern as Qoder/Qwen today. The route is behind the dashboard auth guard; the window is short and single-use | A server-side session map (deferred: generic route refactor) |
| Logging tokens or poll URLs                | Leaks                                                                              | Never log tokens or the verifier; error text is fixed strings + status                                             |                                                              |
| Treating `shouldLogout` 200 as success     | Stored empty token                                                                 | Explicit check → `invalid_grant`                                                                                   |                                                              |

#### Advisories — Best Practices

- Cursor ToS doesn't sanction third-party clients. This matches the existing executor exposure; document it in the
  PR (deferral justification: user-owned account, same as the current import).
- Tokens are plaintext in SQLite like every other provider (deferral justification: a consistent repo-wide policy).

## Task Breakdown Preview

### Phase 1: Foundation

**Focus**: the shared constants and helpers the parallel tracks depend on.
**Tasks**:

- Registry `oauth`/`transport.usage`/`features.usage` entries
- `open-sse/shared/cursorAuth.js` (login URL, poll, refresh, JWT expiry, machineId)

**Parallelization**: a single task, first.

### Phase 2: Core Implementation

**Focus**: four disjoint-file tracks.
**Dependencies**: Phase 1.
**Tasks**:

- A: the `src/lib/oauth/providers/cursor.js` device flow; the import/auto-import refreshToken + JWT expiry
- B: `REFRESH_HANDLERS.cursor`; executor refresh + error classification
- C: the usage handler + dispatcher + snapshot kind/tier + `PLAN_CAPACITY` + the `parseQuotaData` case
- D: the `CursorAuthModal` mode switch + the `OAuthModal` device list / user-code hide

### Phase 3: Integration & Testing

**Focus**: the critical tests, baselines, build, and live verification.
**Tasks**:

- `cursor-auth.test.js`, `cursor-usage.test.js`, and the usage-dispatch list
- The test gate + `verify-*` baselines + lint + `next build`
- A dev-container browser login → chat → forced refresh → usage

## Decisions Needed

1. **Refresh via the IDE client_id**
   - Options: `/oauth/token` with the IDE client id (verified), or minting a `crsr_` user API key (visible in the
     dashboard, and admins can block it).
   - Impact: the reliability of refresh.
   - Recommendation: use `/oauth/token`. It's what the IDE and several tools already do.
2. **Weighted-strategy mapping**
   - Options: Total → `month` only, or also Auto + Composer → `model:default`.
   - Impact: routing weight granularity.
   - Recommendation: Total → `month` only, for a simpler and more predictable first cut.

## Research References

For detailed findings, see:

- [research-external.md](./research-external.md): Cursor endpoints, payloads, refresh evidence
- [research-business.md](./research-business.md): rules, dedup, and refresh/fallback interactions
- [research-technical.md](./research-technical.md): architecture and exact file anchors
- [research-ux.md](./research-ux.md): the modal and ProviderLimits UX
- [research-security.md](./research-security.md): security analysis
- [research-practices.md](./research-practices.md): reuse and KISS
- [research-recommendations.md](./research-recommendations.md): phasing and risks
