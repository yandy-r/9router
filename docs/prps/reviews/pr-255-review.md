# PR Review #255 — feat(cursor): browser login, session refresh, and plan usage

**Reviewed**: 2026-09-25
**Mode**: PR
**Author**: yandy-r
**Branch**: feat/yan-385-cursor-pkce-usage → master
**Decision**: REQUEST CHANGES → resolved (fix pass applied)

## Worktree Setup

- **Parent**: /home/yandy/Projects/github.com/yandy-r/9router/.config/opencode/worktrees/9router-yan-385-cursor-pkce-usage/ (branch: feat/yan-385-cursor-pkce-usage)

## Summary

The feature is correct and live-verified, and it has no security issues. One HIGH needs fixing before merge: closing the browser-login step leaves an orphaned device-poll loop running. Several MEDIUM items should also be fixed:

- Legacy imported rows are never refreshed proactively.
- A failed login polls silently for 10 minutes.
- Pooled-limit pairing on team plans.
- Duplicated constants.

(Merged from the correctness, security and quality reviewers.)

## Findings

### CRITICAL

(none)

### HIGH

- **[F001]** `src/shared/components/CursorAuthModal.js:128` — Closing the browser sub-modal (`onClose={() => setMethod(null)}`) unmounts OAuthModal while `isOpen` is still true. OAuthModal aborts polling only in its `!isOpen` effect (`OAuthModal.js:514-520`), so the `/api/oauth/cursor/poll` loop keeps running for up to 600s. A later sign-in can create the connection and close the dialog unexpectedly, and re-opening stacks more loops.
  - **Status**: Fixed
  - **Category**: Correctness
  - **Suggested fix**: Add an unmount cleanup in OAuthModal that sets `pollingAbortRef.current = true`, and/or keep OAuthModal mounted with `isOpen={isOpen && method === "browser"}`.

### MEDIUM

- **[F002]** `open-sse/services/tokenRefresh.js:177` — `REFRESH_HANDLERS.cursor` uses only `c.refreshToken`, and `refreshTokenByProvider` and the background refresher skip rows without one. The executor falls back to `accessToken`, so the two entry points disagree. Legacy imported rows (`refreshToken: null`, `expiresAt` import + 24h) trigger a useless "refresh proactively" on every request and are healed only by a reactive 401.
  - **Status**: Fixed
  - **Category**: Completeness
  - **Suggested fix**: Use one shared fallback helper for both entry points, and backfill `refreshToken = accessToken` plus the JWT-based `expiresAt` for existing Cursor rows (data migration).
- **[F003]** `open-sse/executors/cursor.js:625` — Cursor `unauthenticated` delivered in a streaming Connect trailer becomes an in-band SSE error after a 200 Response, so reactive refresh/fallback doesn't fire for streaming requests.
  - **Status**: Fixed (documented limitation; proactive refresh + backfill migration cover it)
  - **Category**: Completeness
  - **Suggested fix**: Rely on proactive refresh (1-day lead) once F002 is fixed; document the limitation. Peeking the first frame is out of scope.
- **[F004]** `src/lib/oauth/providers/cursor.js:63` — Every non-404, non-policy poll response (e.g. 400/410 for an expired uuid, or a 200 without a token) maps to `poll_failed`, which OAuthModal does not treat as terminal. The result is ~300 silent polls over 10 minutes.
  - **Status**: Fixed
  - **Category**: Performance
  - **Suggested fix**: Keep `poll_failed` for network errors and 5xx. Map other 4xx and a 200 without a token to the terminal `expired_token` with a message.
- **[F005]** `open-sse/services/usage/cursor.js:49` — `individualLimit ?? pooledLimit` and `individualUsed ?? pooledUsed` are chosen independently. Because proto3 omits zero values, the result can mix individual usage with the pooled limit.
  - **Status**: Fixed
  - **Category**: Correctness
  - **Suggested fix**: Pick the limit/used pair together based on `individualLimit > 0`, and add a mixed-fields test.
- **[F006]** `open-sse/shared/cursorAuth.js:14` — The exported fallback constants duplicate the registry values (including the client id), are never imported, and their `||` fallbacks can never run.
  - **Status**: Fixed
  - **Category**: Maintainability
  - **Suggested fix**: Read `PROVIDER_OAUTH.cursor` only and fail fast if a key is missing.
- **[F007]** `src/app/(dashboard)/dashboard/usage/components/ProviderLimits/utils.js:675` — The `case "cursor"` block is identical to `case "ollama"`.
  - **Status**: Fixed
  - **Category**: Maintainability
  - **Suggested fix**: Use a fallthrough `case "ollama": case "cursor":`.
- **[F008]** `open-sse/shared/cursorAuth.js:110` — `decodeCursorJwt` is a generic JWT-payload decoder with a Cursor name (a third copy in the repo).
  - **Status**: Fixed
  - **Category**: Maintainability
  - **Suggested fix**: Move it to `open-sse/utils/jwt.js` as `decodeJwtPayload` so it can be shared.
- **[F009]** `tests/unit/cursor-auth.test.js:127` — Critical paths are untested: executor `refreshCredentials` accessToken fallback, import-route refresh-token handling, and the modal close/poll lifecycle.
  - **Status**: Fixed
  - **Category**: Completeness
  - **Suggested fix**: Add unit tests for the executor fallback and the import-route validation. The modal lifecycle is covered by the F001 fix.

### LOW

- **[F010]** `open-sse/executors/cursor.js:267` — Mapping `permission_denied` to 403 triggers refresh + retry + cooldown even for plan or policy denials that aren't about credentials.
  - **Status**: Fixed
  - **Category**: Performance
  - **Suggested fix**: Map only `unauthenticated` → 401, and keep `permission_denied` request-scoped.
- **[F011]** `src/lib/oauth/providers/cursor.js:77` — A browser re-login deduped onto an existing row replaces the stored machineId (possibly the real IDE id) with a random one.
  - **Status**: Fixed
  - **Category**: Correctness
  - **Suggested fix**: Preserve the existing `machineId` on Cursor re-login.
- **[F012]** `open-sse/executors/cursor.js:851` — `refreshCredentials` drops `proxyOptions`, and `cursorAuth` uses bare `fetch`, so refresh ignores per-connection proxies.
  - **Status**: Fixed
  - **Category**: Pattern Compliance
  - **Suggested fix**: Thread `proxyOptions` through and use `proxyAwareFetch`.
- **[F013]** `open-sse/services/usage/cursor.js:103` — Unread response bodies are never cancelled on error paths, and a 403 is reported as "(401)".
  - **Status**: Fixed
  - **Category**: Performance
  - **Suggested fix**: Cancel unused bodies and report the real status.
- **[F014]** `open-sse/services/tokenRefresh/dedup.js:22` — Dedup cache entries keyed by full JWTs are only evicted on re-lookup.
  - **Status**: Skipped (pre-existing shared dedup module; growth negligible — deferred)
  - **Category**: Security
  - **Suggested fix**: Evict after the TTL. This is a pre-existing module with tiny growth, so it can be deferred.
- **[F015]** `src/app/api/oauth/cursor/import/route.js:17` — The `refreshToken` has no length cap.
  - **Status**: Fixed
  - **Category**: Security
  - **Suggested fix**: Cap the length (e.g. 16 KB).
- **[F016]** `open-sse/shared/cursorAuth.js:7` — Three comments describe the refresh client inconsistently (CLI vs IDE).
  - **Status**: Fixed
  - **Category**: Maintainability
  - **Suggested fix**: Use one wording: "Cursor IDE public OAuth client".
- **[F017]** `open-sse/services/tokenRefresh/providers.js:857` — The comment "Mirrors kilocode null-refresh pattern" references a refresher that doesn't exist.
  - **Status**: Fixed
  - **Category**: Maintainability
  - **Suggested fix**: Remove the sentence.
- **[F018]** `src/app/api/providers/[id]/test/testUtils.js:87` — The Cursor test config still says "can only verify token exists", which is stale now that JSON usage and refresh exist.
  - **Status**: Skipped (follow-up: connection-test usage probe tracked separately)
  - **Category**: Completeness
  - **Suggested fix**: Handle as a follow-up (switch to a usage probe with checkExpiry/refreshable).
- **[F019]** `src/app/api/oauth/cursor/auto-import/route.js:86` — The first-matching-key loop now appears six times.
  - **Status**: Fixed
  - **Category**: Maintainability
  - **Suggested fix**: Extract a `firstValue(keys, query)` helper.

## Validation Results

| Check      | Result                                      |
| ---------- | ------------------------------------------- |
| Type check | Skipped (plain JS)                          |
| Lint       | Pass                                        |
| Tests      | Pass (no regression vs known-fails; 22 new) |
| Build      | Pass                                        |

## Files Reviewed

- `open-sse/config/quotaSnapshot.js` (Modified)
- `open-sse/executors/base.js` (Modified)
- `open-sse/executors/cursor.js` (Modified)
- `open-sse/providers/registry/cursor.js` (Modified)
- `open-sse/services/tokenRefresh.js` (Modified)
- `open-sse/services/tokenRefresh/cursor.js` (Added)
- `open-sse/services/tokenRefresh/providers.js` (Modified)
- `open-sse/services/usage.js` (Modified)
- `open-sse/services/usage/cursor.js` (Added)
- `open-sse/shared/cursorAuth.js` (Added)
- `src/app/(dashboard)/dashboard/providers/[id]/page.js` (Modified)
- `src/app/(dashboard)/dashboard/usage/components/ProviderLimits/utils.js` (Modified)
- `src/app/api/oauth/cursor/auto-import/route.js` (Modified)
- `src/app/api/oauth/cursor/import/route.js` (Modified)
- `src/lib/oauth/providers/cursor.js` (Modified)
- `src/lib/oauth/services/cursor.js` (Modified)
- `src/shared/components/CursorAuthModal.js` (Modified)
- `src/shared/components/OAuthModal.js` (Modified)
- `src/sse/services/quotaSnapshotSync.js` (Modified)
- `tests/unit/cursor-auth.test.js` (Added)
- `tests/unit/cursor-usage.test.js` (Added)
- `tests/unit/usage-dispatch.test.js` (Modified)

## Fix Pass

All findings were addressed in the follow-up commit, except F014 (deferred) and F018 (follow-up).

- **F001**: `OAuthModal` now aborts polling on unmount and in `handleClose`. `CursorAuthModal` ignores a success that arrives after the user has left the browser step.
- **F002**: a single `cursorRefreshSource` is shared by the refresher and the executor. Data migration `002-cursor-refresh-backfill` sets `refreshToken` to the access token and restores the real JWT `expiresAt` on legacy Cursor rows.
- **F004**: terminal poll failures now map to `expired_token`, so the modal stops.
- **F005**: the pooled pair is chosen as a unit.
- **F010**: only `unauthenticated` maps to 401.
- **F011**: the IDE `machineId` is preserved on browser re-login.
- **F012**: `proxyOptions` is threaded through, and requests use `proxyAwareFetch`.

Re-validation:

- Lint passes.
- Test gate: no regression.
- Baselines are equal.
- Build succeeds.
- A live re-probe in 9router-dev confirmed usage, the legacy-row refresh, dead-session handling and the login start.
