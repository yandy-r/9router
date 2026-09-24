# YAN-259 Quota Snapshot — Technical Design

## Executive Summary

Per-connection in-memory snapshot store (`open-sse/services/quotaSnapshot.js`) normalizes all quota signals (passive response headers + active `USAGE_HANDLERS` probes in `open-sse/services/usage.js:42-76`) into `windows[]` with `usedFraction` in `[0,1]`. Single header-ingest hook in `open-sse/handlers/chatCore.js:678` (after `providerResponse.ok` guard, before streaming/non-streaming branch) sees `provider + connectionId + providerResponse.headers` for both paths. `src/sse/services/antigravityQuota.js` becomes a thin strike-breaker adapter over the new store (exports unchanged, tests green). Plan tier persists on `providerSpecificData.planTier` (Codex reuses `chatgptPlanType`); capacity table lives in `open-sse/config/planCapacity.js`. Poller extends `src/shared/services/quotaAutoPing.js` patterns but reuses `USAGE_HANDLERS`. Fail-open everywhere: ingest/poll never throw.

## Architecture Design

```
upstream Response (headers)
  -> BaseExecutor.execute return {response,url,headers} (open-sse/executors/base.js:210)
  -> chatCore.js:519-534 executor.execute → providerResponse
  -> chatCore.js:642 !ok guard (errors → existing markAccountUnavailable / handleAntigravityQuotaError)
  -> *** NEW ingestResponseHeaders(provider, connectionId, model, providerResponse.headers) (:678) ***
  -> sharedCtx {provider, model, connectionId} (:679-694)
  -> handleNonStreamingResponse / handleStreamingResponse (headers already consumed at hook)
  -> quotaSnapshot.js Map<connectionId, Snapshot>

USAGE_HANDLERS probes (open-sse/services/usage.js:78 getUsageForProvider)
  -> usage/[connectionId]/route.js:174 GET + refreshAndUpdateCredentials(:23)
  -> NEW snapshot poller (weighted-gated) → ingestProbeResult(connectionId, provider, usageResult)
  -> plan-tier persist hook (same call site, debounced updateProviderConnection)

getProviderCredentials (src/sse/services/auth.js:46) reads snapshot (phase 2 consumes;
  phase 1 only adds antigravity-compatible projection + effectiveWeight export).
```

### New components

- `open-sse/services/quotaSnapshot.js` — store + ingest + `computeEffectiveWeight`. Only new stateful module. Backed by two `Map`s (`snapshots`, `inflight` none needed — ingest is sync).
- `open-sse/services/quotaHeaders.js` — per-provider header parsers (`parseClaudeHeaders`, `parseCodexHeaders`, `parseGenericRateLimitHeaders`), pure + unit-testable. Called only by the chatCore hook.
- `open-sse/services/quotaProbeMapper.js` (or fold into `quotaSnapshot.js` if <500 lines) — `usageResult → windows[]` mapper per provider. Keeps probe-shape knowledge out of store.
- `open-sse/services/quotaPlan.js` — `resolvePlanTier(provider, usageResult, credentials)` + `maybePersistPlanTier()`. Pure resolver + one debounced DB write.
- `open-sse/config/planCapacity.js` — `{ provider: { tierId: relativeWeight } }` + `isWeightedProvider()` helper stub for phase 2/3 gating.
- `open-sse/services/quotaPoller.js` — weighted-gated background poller modeled on `quotaAutoPing.js`.

### Integration points (exact file:line)

- Hook: `open-sse/handlers/chatCore.js:678` — after `if (!providerResponse.ok)` block ends `:677`, before `const sharedCtx = {:679`. Has `provider, model, connectionId` in scope + `providerResponse.headers`. Covers streaming + non-streaming + forced-SSE-to-JSON (`:700`) because all three branch after it. Non-streaming handler (`chatCore/nonStreamingHandler.js:261 handleNonStreamingResponse`) and streaming handler (`chatCore/streamingHandler.js:105 handleStreamingResponse`, headers peek `:147`) both run later — no second hook needed.
- `connectionId` provenance: `src/sse/handlers/chat.js:347 connectionId: credentials.connectionId` → `handleChatCore({connectionId}:89)`. `credentials.connectionId` set in `src/sse/services/auth.js:270`. No plumbing change; hook just uses the existing parameter. `sharedCtx` already carries it (`chatCore.js:687`).
- Executor return contract (unchanged): `open-sse/executors/base.js:181-210` — `proxyAwareFetch` → `return { response, url, headers, transformedBody }`. `CodexExecutor.execute` (`open-sse/executors/codex.js:311-352`) preserves headers when rebuilding Response after SSE peek (`:347-350 new Response(body,{headers: response.headers})`). Antigravity `computeRetryDelay` (`open-sse/executors/antigravity.js:468`) clones response — header ingest must run on the final `providerResponse`, not inside retry loop.
- Probe reuse: `open-sse/services/usage.js:78 getUsageForProvider(connection, proxyOptions, {force})`; route call site `src/app/api/usage/[connectionId]/route.js:174` (+ retry-after-refresh `:178-186`). Poller calls the same function.
- Persist: `src/lib/db/repos/connectionsRepo.js:255 updateProviderConnection(id, data)` (transactional merge; `providerSpecificData` merged by callers). Auth read path `src/sse/services/auth.js:100 getProviderConnections`, `auth.js:262-269` rehydrates `providerSpecificData` into credentials per request — so persisted `planTier` is visible next request with no extra plumbing.
- Scheduler start: `src/shared/services/initializeApp.js:165-169` (`hasQuotaAutoPingEnabled`) + `src/app/api/settings/route.js:109-110 configureQuotaAutoPing(settings)`. New poller starts alongside (same lazy-`import()` pattern).

## Data Models

### Snapshot shape (`Map<connectionId, Snapshot>`)

```js
Snapshot = {
  connectionId: string,
  provider: string,            // denormalized for weight lookup without DB read
  windows: Window[],
  updatedAt: string,           // ISO, last ingest (any source)
  expiresAt: string,           // ISO, whole-snapshot TTL fallback
}
Window = {
  kind: "5h" | "7d" | "day" | "month" | "model:<id>",  // Codex weekly→"7d" (see below)
  usedFraction: number,        // [0,1] clamped, NaN/Inf rejected → window dropped
  resetsAt: string | null,     // ISO or null (unknown)
  source: "header" | "probe",  // + "static" only in visibility layer, never stored
  updatedAt: string,           // ISO per-window
}
```

- Stale rule: window expired when `resetsAt <= now` → excluded from `min()` (lazy filter on read, no timer). Whole snapshot expired when `now > expiresAt` (default 30 min, per-provider override; Claude probes refresh at 5-min cache cadence so TTL rarely binds).
- Key normalization: header names lowercased before lookup (`Headers.get` is case-insensitive; plain-object test doubles are not — parser lowercases keys first).
- `1.0 = unknown` rule (Antigravity/Gemini `remainingFraction: 1.0` stuck): `usage/google.js:213` `remainingFraction * 100` and `:84` — when source is `fetchAvailableModels quotaInfo` and value is exactly `1.0`, mapper emits **no window** (unknown), never `usedFraction: 0`. Real `0.0` (exhausted) still emits `usedFraction: 1`.

### `providerSpecificData.planTier`

- New canonical key: `providerSpecificData.planTier: string | null`. Tier IDs are provider-native (`default_claude_max_20x`, `g1-pro-tier`, `copilot_pro_plus`, …); human names stay in `usageResult.plan` (display only).
- Codex: **reuse** `providerSpecificData.chatgptPlanType` (persisted `src/lib/oauth/providers/codex.js:59-63` via `extractCodexAccountInfo`: `providerHelpers.js:80-89`, refreshed `src/app/api/oauth/[provider]/[action]/route.js:480-485` + `codex/import-token/route.js:44-62`). `resolvePlanTier("codex")` reads `chatgptPlanType` first, copies to `planTier` only if absent (no migration script; lazy copy on next probe).
- Claude: `planTier` from `GET /api/oauth/profile → organization.rate_limit_tier` (new lazy fetch in `quotaPlan.js`; 403/no-scope → `null`, cached negative for 24h to avoid setup-tokens spam).
- Gemini CLI / Antigravity: `paidTier.id` fallback `currentTier.id` from `loadCodeAssist` (`usage/google.js:301 getAntigravitySubscriptionInfo`, `google.js:100 getGeminiSubscriptionInfo`). Today `postExchange` resolves a tier-ish value then drops it — `antigravity.js:67-84` (`tierId` from `allowedTiers[].isDefault`, defaults `legacy-tier`) and `gemini-cli.js:54-74` (projectId only). Fix: include `planTier: tierId` in `mapTokens` return (`antigravity.js:115-122`, `gemini-cli.js:81-88`).
- Copilot: `data.copilot_plan` (`usage/github.js:55,73`); Kiro: `data.subscriptionInfo` (`usage/kiro.js:46 subscriptionTitle`) — persisted by the usage-result hook (see below), not by header parsers.

### Scale normalization at ingest

- `normalizeUsedFraction(raw, { scale: "0-1-used" | "0-100-used" | "0-1-remaining" | "0-100-remaining" })` in `quotaSnapshot.js`: finite-check → convert → clamp `[0,1]`. Non-finite → drop window, `debug`-log.
- Claude unified headers `0–1 used`; `/api/oauth/usage` `0–100 used` (`usage/claude.js:88-99`); Codex probe `0–100 used` (`usage/codex.js:48-60`); Codex headers `used-percent 0–100`; Google buckets `0–1 remaining` (`usage/google.js:76`); `USAGE_HANDLERS remainingPercentage 0–100 remaining`. Runtime detect for `/api/oauth/usage`-shaped payloads: values `>1` → `0–100` scale (same trick as `usage/codex.js` clamp).

## API Design

Extend existing `GET /api/usage/[connectionId]` (`src/app/api/usage/[connectionId]/route.js:124`) — additive, no UI break:

```jsonc
{
  // ... existing fields unchanged (plan, quotas, message) ...
  "snapshot": {
    "windows": [{ "kind": "5h", "usedFraction": 0.87, "resetsAt": "…", "source": "header" }],
    "planTier": "default_claude_max_5x",
    "updatedAt": "…",
    "stale": false,
  },
  "effectiveWeight": { "weight": 0.65, "base": 5, "headroom": 0.13, "floorApplied": false },
  "weightSource": "header", // "header" | "probe" | "static" | "manual"
}
```

- `snapshot` built from store; `stale` = whole-snapshot TTL expired or all windows expired.
- `effectiveWeight` computed with stored `manualWeight` (settings) + capacity table; `weightSource` = min-window source, `static` when no windows, `manual` when manual override present (phase 2 reads same fn).
- No new route. Optional `?snapshot=1` is unnecessary — payload is small. Plan-tier persist side-effect (see below) runs on this path but is debounced (max 1 DB write / 1h per connection unless tier changed).

## System Constraints

- No new deps; stdlib + existing `proxyAwareFetch` (`open-sse/utils/proxyFetch.js`), existing `USAGE_HANDLERS`. Reuse executors' UA for probes (undocumented OAuth endpoints are UA-sensitive).
- ~500 lines/file soft cap: split store / header parsers / probe mapper / plan / poller into five small modules, not one god file.
- Fail-open: `try/catch` around ingest body, `log.debug` only; malformed/missing header or probe leaves previous value; quota layer never rejects `handleChatCore`.
- Respect existing cadences: Claude 5-min usage cache (`usage/claude.js:24`) + 3-min OAuth 429 cooldown (`:19`); Antigravity 30-s min-refresh (`antigravityQuota.js:18`) + weekly 3-min cache (`antigravity-weekly.js:16`); Groq-style duration resets parsed with existing `parseGroqDurationMs` logic (move, don't duplicate).
- Clock formats: epoch-seconds (Claude headers), ISO/`parseResetTime` (`usage/shared.js:15`), Go durations (`usage/groq.js:22-37`), `reset-after-seconds` (Codex headers). All converge to ISO `resetsAt` via shared helpers.
- Poller never sends chat pings (unlike `quotaAutoPing.js:111-196 sendClaudePing/sendCodexPing` which spend tokens) — it calls quota endpoints only.

## Codebase Changes

Create:

- `open-sse/services/quotaSnapshot.js` — `Map` store, `ingestHeaderWindows`, `ingestProbeWindows`, `getSnapshot`, `getHeadroom`, `computeEffectiveWeight`, scale normalizer, expiry filter.
- `open-sse/services/quotaHeaders.js` — `parseResponseHeaders(provider, headersLike, { model }) → Window[]`: Claude unified (`anthropic-ratelimit-unified-{5h,7d,7d_oi}-{utilization,reset,status}`), Codex `x-codex-{primary,secondary}-{used-percent,window-minutes,reset-at|reset-after-seconds}` + `x-codex-rate-limit-reached-type`, generic `x-ratelimit-{limit,remaining,reset}-{requests,tokens}` + Anthropic API `anthropic-ratelimit-{requests,tokens,input-tokens,output-tokens}-{limit,remaining,reset}` (RFC3339). Header lookup via lowercased map.
- `open-sse/services/quotaProbeMapper.js` — `mapUsageToWindows(provider, usageResult)`: Claude keys (`usage/claude.js:101-115` `"session (5h)"`, `"weekly (7d)"`, `"weekly <model> (7d)"`, `limits[]` weekly_scoped), Codex (`usage/codex.js:62-85` primary→`5h`-or-`7d` by `limit_window_seconds`, secondary likewise; review/spark → `model:review`/`model:spark-*`), Gemini/Antigravity (buckets→`model:<id>`, weekly overlay→`7d`-family keys `antigravity-weekly.js:29-32`), GitHub (`usage/github.js:57-64` chat/completions→`month`? see OQ-3), Kiro (`usage/kiro.js:17-28` resourceType→`month`), Groq passthrough (no probe needed; headers only).
- `open-sse/services/quotaPlan.js` — `resolvePlanTier` (pure) + `maybePersistPlanTier(connectionId, tier)` (debounced `updateProviderConnection`) + lazy Claude profile fetch.
- `open-sse/config/planCapacity.js` — capacity table from issue §Capacity + `resolveBaseWeight({provider, planTier, manualWeight})` + `isWeightedProvider(provider, settings)` stub (false until phase 2 registers `weighted`).
- `open-sse/services/quotaPoller.js` — `runQuotaSnapshotTick` + `startQuotaSnapshotPoller` (tick 60s; per-provider cadence inside; skips when snapshot fresh or provider not weighted-gated).
- `tests/unit/quota-*.test.js` — header parsers (5 files: claude/codex/generic/groq-duration/antigravity-1.0-unknown), snapshot expiry, `computeEffectiveWeight`, poller cadence/cooldown, plan resolver.

Modify:

- `open-sse/handlers/chatCore.js` (+~10 lines at `:678`): call `ingestResponseHeaders` in `try/catch`, `log.debug` on parse. Pass `provider, connectionId, model, providerResponse.headers`.
- `src/sse/services/antigravityQuota.js` — keep exports + strike logic; replace internal `quotaCache` writes with snapshot writes + projection read (see Technical Decisions D-1). `auth.js:19,111-137` untouched (still calls `getAntigravityQuotaCache()`).
- `src/lib/oauth/providers/antigravity.js:115-122` + `gemini-cli.js:81-88` — persist `planTier` in `mapTokens` (one line each; value already fetched in `postExchange`).
- `src/app/api/usage/[connectionId]/route.js:174-188` — after `getUsageForProvider`, call `ingestProbeWindows` + `maybePersistPlanTier` (fire-and-forget, debounced). Response adds `snapshot/effectiveWeight/weightSource`.
- `src/app/api/oauth/[provider]/[action]/route.js:480-485` — also copy `planType → planTier` for Codex on refresh (keeps `chatgptPlanType` canonical).
- `src/shared/services/initializeApp.js:165-169` + `src/app/api/settings/route.js:109-110` — start `quotaPoller` next to autoping.

## Technical Decisions

- **D-1 Antigravity fold (keep tests green).** Option A (rewrite auth to read snapshot, delete old module) breaks `antigravity-quota-routing.test.js` (imports `getAntigravityQuotaCache/handleAntigravityQuotaError/refreshAntigravityQuota/clearAntigravityStrikes`) and `antigravity-weekly-quota.test.js`. Option B (second parallel cache) violates scope. **Recommend C: adapter.** `quotaCache` becomes a projection: `getAntigravityQuotaCache()` returns a `Map`-like view built from snapshot `model:<id>` windows + active strike blocks (`applyActiveStrikeBlocks` stays verbatim). `_doRefresh` still calls `getAntigravityUsage` (mocks keep working), then writes via `ingestProbeWindows` instead of `quotaCache.set`. Strike maps (`strikeCounts/StrikeBlocks/STRIKE_*` constants) stay in `antigravityQuota.js` — they are routing policy, not quota data. `handleAntigravityQuotaError` / `clearAntigravityStrikes` bodies unchanged except cache read/write going through the projection. `MIN_REFRESH_INTERVAL_MS`/inflight dedup stay (probe path needs them; header path bypasses).
- **D-2 Hook location.** Executor-level (per-executor `afterExecute`) = ~30 copy-paste sites, and executors lack `connectionId` (only `credentials.connectionId`, and some paths use refreshed copies). ChatCore `:678` has all three (`provider, model, connectionId`) + final `providerResponse` post-retry, covering streaming, non-streaming, forced-SSE-to-JSON in one `try/catch`. **Recommend chatCore hook; no executor changes.**
- **D-3 Codex window classification by minutes, not name.** Pro reports weekly as `primary`. Parser reads `window-minutes`/`limit_window_seconds`: `<=600` → `5h`, `>=6000` (≈7d=10080) → `7d`, else `day`-ish generic window with same kind mapping (document thresholds in `quotaHeaders.js`). Probe mapper uses identical classifier on `limit_window_seconds` (`usage/codex.js` currently hardcodes primary→session — mapper supersedes for snapshot; probe display keys unchanged).
- **D-4 Plan hooks.** `mapTokens` (connect-time, cheapest, covers Codex JWT + Antigravity/Gemini tier already in hand), usage-route result hook (covers Copilot `copilot_plan`, Kiro `subscriptionInfo`, Gemini/Antigravity `paidTier`, Codex `plan_type` drift), lazy Claude profile fetch (only from poller/route, never request path — needs `user:profile` scope, 403-prone). Token-refresh path needs no separate hook: refresh responses don't carry tier; next probe/route call re-resolves. Persist is debounced + tier-change-only.
- **D-5 Poller gating without `weighted` value.** `isWeightedProvider()` returns true when `settings.providerStrategies[provider].fallbackStrategy === "weighted"` OR combo-level equivalent; until phase 2/3 define those keys it returns false and the poller idles (startup backfill only: one `ingestProbeWindows` per connection when snapshot absent — bounded, respects Claude 5-min cache/3-min cooldown). No behavior change until phases land.
- **D-6 `computeEffectiveWeight`.** Pure, in `quotaSnapshot.js`: `base = manual ?? capacity[provider][planTier] ?? 1`; `headroom = min(1 − usedFraction)` over non-expired windows applicable to `model` (global `5h/7d/day/month` always apply; `model:<id>` applies on exact/family match only); `weight = max(base × headroom, floor=0.05)`. Unknown (no windows) → `base × 1`. Never throws; non-finite inputs → defaults.

## Open Questions

- OQ-1 Codex `prolite = Pro 5x / pro = Pro 20x` mapping unverified — ship table with `prolite: 5, pro: 20` behind comment, confirm from billing docs?
- OQ-2 Claude `organization.rate_limit_tier` exact string set (`default_claude_max_20x/_5x/pro` + Enterprise?) — log-and-persist raw value, add table rows as observed?
- OQ-3 GitHub `quota_reset_date` cadence is monthly but field name is generic — map Copilot windows to `month`, or `day`? (Recommend `month`; verify against `limited_user_reset_date` path `usage/github.js:70`.)
- OQ-4 Kiro `usageBreakdownList` — which `resourceType` is the plan pool vs overage (`usage/kiro.js:18`)? Never assume index 0; persist `subscriptionTitle` as tier and map all breakdowns as `model:<resourceType>`?
- OQ-5 Copilot `premium_interactions` semantics post-2026-06-01 AI Credits switch unverified — prefer `percent_remaining` over raw counts per issue; confirm field name?
- OQ-6 Antigravity free-tier `retrieveUserQuotaSummary remainingFraction: 1` bug (`usage/google.js:234-285` reconcile) — snapshot mapper reuses that reconcile; keep reconcile in `google.js` or move into mapper?
- OQ-7 `x-codex-rate-limit-reached-type` values (`primary`/`secondary`/model?) — treat as `usedFraction: 1` for the matching window with `resetsAt` from paired reset header; confirm enum?
- OQ-8 Anthropic API `anthropic-ratelimit-*-reset` RFC3339 vs epoch — `parseResetTime` handles both; generic API-key windows map to `day`? key limits are usually per-minute — use `5h`?
