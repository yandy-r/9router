# YAN-259 Quota Snapshot — Recommendations, Risks, Alternatives, Task Breakdown

## Executive Summary

Build one small Map store plus parser map plus pure weight function; hook `chatCore.js` post-success path only. Keep `antigravityQuota.js` strike-breaker live behind a facade until phase 2 reads snapshot. Poller reuses `USAGE_HANDLERS` fetchers with weighted-gating helper stub; plan tier persists into `providerSpecificData.planTier`. ~5 files new or touched core, rest incremental parsers.

## Implementation Recommendations

### Approach

- **One store module** `open-sse/services/quotaSnapshot.js` (~150 lines): `Map<connectionId, {windows:[{kind,usedFraction,resetsAt,source}],planTier,updatedAt}>`, functions `ingestHeaders(provider,connectionId,headers)`, `ingestProbeResult(connectionId,usageResult,source)`, `getSnapshot(connectionId)`, `computeEffectiveWeight({manualWeight,planTier,provider,snapshot,model,floor})`. All ingest wrapped try/catch, debug log only, never throw (mirrors `open-sse/rtk/index.js` fail-open convention).
- **One parser map** `open-sse/config/quotaHeaders.js` (~120 lines): per-provider `{match(headers)->windows[]}` keyed by provider id. Claude OAuth unified headers (0–1, epoch-s reset), Codex `x-codex-*` (0–100, classify by `limit_window_seconds`/`window-minutes`, never name), generic `x-ratelimit-*` (limit/remaining/reset triples), Anthropic API `anthropic-ratelimit-*` (RFC3339 resets — reuse `parseResetTime` from `open-sse/services/usage/shared.js:15`), OpenAI duration resets (`6m0s` — reuse `parseGroqDurationMs` pattern from `open-sse/services/usage/groq.js:22`, hoist to `shared.js`).
- **One hook point, not per-executor**: call `ingestHeaders` in `open-sse/handlers/chatCore.js` right after `providerResponse.ok` success path (~line 679 `sharedCtx` build, or inside `nonStreamingHandler.js:321` / `streamingHandler.js:132` `onRequestSuccess` chains). Headers already available on `providerResponse.headers`. Single call site covers all executors including `BaseExecutor.execute()` (`open-sse/executors/base.js:181`) return. Do not touch each executor.
- **Antigravity fold, not fork**: preserve strike state and behavior in `src/sse/services/antigravityQuota.js` (205 lines), but move quota values into shared snapshot store. Keep `STRIKE_THRESHOLD=3`, `STRIKE_WINDOW_MS`, `strikeBlocks`, `handleAntigravityQuotaError:141`, and `clearAntigravityStrikes:57`; only replace `quotaCache` reads/writes with snapshot accessors. `getAntigravityQuotaCache()` is an existing test/caller contract (`src/sse/services/auth.js:113-163`, `tests/unit/antigravity-quota-routing.test.js:31-344`), so retain a Map-like compatibility view backed by canonical snapshot Map, not a second cache. Update direct callers in phase 1; remove compatibility export after phase 2.
- **Poller reuse, not rewrite**: new `src/shared/services/quotaPoller.js` (next to autoping; needs `getProviderConnections`/`getSettings` from `@/lib/localDb` and `refreshAndUpdateCredentials` from usage route — all app-side) borrows tick loop, `failureCache`, `resetCache`, inflight-dedup patterns from `src/shared/services/quotaAutoPing.js` (342 lines: `runQuotaAutoPingTick:286`, `pingConnection:203`, `createDefaultDeps:274` DI shape). But it calls `getUsageForProvider` (`open-sse/services/usage.js:78`) + `ingestProbeResult`, never sends ping requests. Reuse Claude 5-min cache (`usage/claude.js:24-56`) and 3-min 429 cooldown (`:19-20`) as-is — do not add another cache layer. Gate on `isWeightedProvider(provider)` helper (stub returns false/reads settings now; phase 2/3 makes it true).
- **Plan-tier persistence**: `providerSpecificData.planTier` string on connection row via existing `updateProviderConnection` (`src/lib/db/repos/connectionsRepo.js:255`, JSON-merge semantics). Sources: Claude `GET /api/oauth/profile → organization.rate_limit_tier` (new tiny fetch in poller/ingest, 403 → null); Codex reuse `chatgptPlanType` (`src/lib/oauth/providerHelpers.js:80-89`, already persisted at `src/app/api/oauth/[provider]/[action]/route.js:480-485`); Gemini/Antigravity `paidTier.id ?? currentTier.id` — resolved in both `src/lib/oauth/providers/antigravity.js:67-98` and `src/lib/oauth/services/antigravity.js:123-133` but **dropped by `mapTokens`** — fix is one line adding to return object; Copilot `copilot_plan` from `usage/github.js:55`; Kiro `subscriptionInfo.subscriptionTitle` from `usage/kiro.js:46`.
- **Capacity table** `open-sse/config/planCapacity.js` (~60 lines): `{provider:{tierId:relativeWeight}}` with starting values from spec. `computeEffectiveWeight` resolves base = manual → table → 1; headroom = min over applicable windows of `1-usedFraction` (include `model:<id>` windows only on model match); floor default 0.05; unknown → base×1. Pure, no imports, trivially unit-testable.
- **Visibility**: extend existing `GET src/app/api/usage/[connectionId]/route.js` response with `{snapshot, effectiveWeight, planTier, sources}` rather than new route. `refreshAndUpdateCredentials` (`:23-119`) already exported for poller reuse.

### Overwrite and expiry semantics

- Same `(connectionId, kind, model?)`: newer ingest overwrites older values.
- Do not ingest obviously stale windows: skip when parsed `resetsAt <= Date.now()` unless upstream explicitly says exhausted with future reset.
- Snapshot TTL: retain last-known values for short fallback reads (e.g. 24h); mark `stale:true` after shorter freshness window (e.g. 15m or provider cadence) so poller knows to refresh.
- No deletion except automatic expiry; no manual cache-clear API in phase 1.
- Compatibility accessor must preserve existing antigravity model-keyed shape (`tests/unit/antigravity-quota-routing.test.js:62-344`); snapshot adds canonical window list alongside it.

### Phasing

1. Store + weight + capacity table + unit tests (no wiring; safe merge).
2. Header parser map + single chatCore hook + Claude/Codex acceptance (one request → 5h+weekly windows).
3. Poller + probe ingest + Antigravity facade adapter.
4. Plan-tier detection per provider + `mapTokens` fix + route visibility.

### Quick wins

- Groq pattern (`usage/groq.js:44-62` header-presence guard: check `headers.get()===null` before `Number()`) is the template for all parsers — copy it, prevents missing-header→0% false exhaustion.
- Hoist `parseGroqDurationMs` to `usage/shared.js` now; OpenAI `x-ratelimit-reset` durations need it.
- Antigravity `mapTokens` tier fix is a 1-line independent PR that unblocks tier work.
- `USAGE_HANDLERS` dispatch (`usage.js:42-76`) already takes `{force}` ctx — poller passes `force:false` and inherits Claude cooldown for free.

## Improvement Ideas

- Normalize at ingest, store only `usedFraction [0,1]` + ISO `resetsAt` — never raw provider scales; validation = `Number.isFinite` + clamp (spec §Snapshot model).
- Overwrite rule: latest ingest replaces window values; ignore ingest when `resetsAt <= now`. Removal only automatic expiry. Map cap prevents growth.
- Expose compatibility accessors plus semantic `getSnapshot/getWindows` from day one.
- Phase 2 switches providers/connections and auth pre-filter to semantic APIs; then remove compatibility export.
- `source: "header"|"probe"|"static"` per window; visibility route surfaces it so phase-2 debugging shows data provenance.
- Codex window classification **must** key on `limit_window_seconds` (5h vs 7d), because Pro reports weekly as "primary" (`usage/codex.js:62-85` currently name-based `session`/`weekly` — fix mapping in snapshot ingest, leave dashboard keys alone).
- Antigravity `quotaInfo.remainingFraction 1.0` → treat as unknown, skip window (spec; `usage/google.js:213` defaults missing to 0 — snapshot ingest must not copy that default).
- Copilot: prefer `percent_remaining` over `premium_interactions` post-2026-06-01 switch (unverified semantics per spec).
- Kiro: pick plan pool by matching `subscriptionInfo`, never assume `usageBreakdownList[0]`.
- Keep poller cadence per-provider, default 5–15 min, only when passive data stale (no header ingest within TTL) or at startup; skip when any applicable window fresh.

## Risk Assessment

| #   | Risk                                                                                                                                                 | Likelihood / Impact                                 | Mitigation                                                                                                                            |
| --- | ---------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------- |
| 1   | Undocumented OAuth usage endpoints change shape / 429 (Claude `oauth-2025-04-20` beta, Codex wham)                                                   | High / Medium — poller burns quota or breaks ingest | Reuse existing fetchers only (no new endpoints except Claude profile); keep Claude 5-min cache + 3-min cooldown; fail-open, debug log |
| 2   | Breaking antigravity strike-breaker (only dual-pool-mismatch defense, #3681)                                                                         | Medium / High — retry storms on 429/409             | Facade, not rewrite; keep `handleAntigravityQuotaError` + both test files green; `verify-no-regression.mjs` in CI                     |
| 3   | Header scale misread (0–1 vs 0–100; Google _remaining_ vs _used_) causes false 0% → accounts wrongly deprioritized                                   | Medium / High                                       | Parser unit tests per provider incl. boundary values; Groq null-guard pattern; Antigravity 1.0→unknown rule                           |
| 4   | Codex Pro weekly-as-primary misclassified as 5h window                                                                                               | Medium / Medium                                     | Classify by `limit_window_seconds`, test with Pro-shaped fixture                                                                      |
| 5   | `providerResponse.headers` consumed/unavailable in some executors (Codex rebuilds `Response` at `executors/codex.js:346-367`; binary/protobuf paths) | Medium / Low                                        | Hook reads headers defensively (`?.get?.()`), null → skip; covers chat path only, image/tts out of scope                              |
| 6   | `weighted` strategy doesn't exist yet — poller gating dead code or wrong trigger                                                                     | High / Low                                          | `isWeightedProvider()` stub with documented phase-2 contract; poller also runs when snapshot stale regardless                         |
| 7   | Plan-tier values unverified (Codex prolite=5x?, Copilot post-switch semantics, Kiro pool)                                                            | High / Low                                          | Capacity table isolated in one config file; wrong numbers only skew weights, floor 0.05 bounds damage; mark unverified with comments  |
| 8   | Claude profile needs `user:profile` scope; setup-tokens 403                                                                                          | Medium / Low                                        | 403 → `planTier:null`, no surfacing; tier falls back to base weight 1                                                                 |
| 9   | Poller + autoping double upstream calls (autoping sends real pings; poller probes quota)                                                             | Low / Medium                                        | Poller never pings, only reads `USAGE_HANDLERS`; separate scheduler in `initializeApp.js:165-169` pattern with own settings key       |
| 10  | Snapshot memory growth (Map per connection, no eviction)                                                                                             | Low / Low                                           | TTL expiry on read + size cap (e.g. 1000 entries, LRU-ish delete oldest); in-memory only, no DB migration                             |

## Alternative Approaches

| Approach                                                               | Pros                                                                         | Cons                                                                                                                                                                | Effort                       | Verdict                                                                                |
| ---------------------------------------------------------------------- | ---------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------- | -------------------------------------------------------------------------------------- |
| **A. Recommended: new snapshot store + facade over antigravity cache** | Single read model for phase 2/3; strike-breaker preserved; incremental       | Temporary dual-cache during phase 1                                                                                                                                 | ~400 lines new, ~50 touched  | **Do this**                                                                            |
| B. Extend `antigravityQuota.js` into generic store                     | Reuses tested cache/refresh/dedup (`inflightRefresh:16`, `lastRefreshAt:14`) | Module is Antigravity-shaped (model→remaining% map, strike logic, `src/sse` location wrong side of `open-sse` boundary); genericizing risks breaking #3681 behavior | ~200 touched high-risk lines | Reject — blast radius on proven code                                                   |
| C. Per-executor header parsing (each executor ingests own headers)     | Closest to source, no core hook                                              | Copy-paste across ~20 executors; violates open-sse DRY; misses `DefaultExecutor` generic path                                                                       | ~20 files touched            | Reject — spec explicitly forbids                                                       |
| D. Persist snapshots in SQLite instead of memory                       | Survives restart; dashboard reads without extra fetch                        | Needs migration (`src/lib/db/migrations/`), repo churn, stale-data semantics harder; phase 2 needs in-memory speed anyway                                           | Migration + repo code        | Reject — memory is sufficient; plan tier (slow-moving) already persisted on connection |
| E. Poll-only, no passive header ingest                                 | Simpler (one path); no chatCore hook                                         | Extra upstream calls on every window; misses acceptance criterion (no-extra-call after one request); burns Claude/Codex quota                                       | Less code, more runtime cost | Reject — violates core requirement                                                     |

## Task Breakdown Preview

| Group                    | Tasks                                                                                                                                                                                                                                                                                                                                                               | Files owned                                                                                                                                               | Parallel?                                    |
| ------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------- |
| G1 Store core            | `quotaSnapshot.js`: Map store, ingest/validate/clamp, TTL+reset expiry, `getSnapshot`, `computeEffectiveWeight`; `planCapacity.js` table                                                                                                                                                                                                                            | `open-sse/services/quotaSnapshot.js` (new), `open-sse/config/planCapacity.js` (new)                                                                       | G1+G2 parallel                               |
| G2 Header parsers        | `quotaHeaders.js` parser map (Claude/Codex/generic/Anthropic-API/OpenAI); hoist duration parser to `usage/shared.js`                                                                                                                                                                                                                                                | `open-sse/config/quotaHeaders.js` (new), `open-sse/services/usage/shared.js` (touch)                                                                      | G1+G2 parallel                               |
| G3 Hook wiring           | Single `ingestHeaders` call in chatCore success path; verify headers survive Codex `Response` rebuild                                                                                                                                                                                                                                                               | `open-sse/handlers/chatCore.js` (1 call site), maybe `handlers/chatCore/nonStreamingHandler.js`, `streamingHandler.js`                                    | After G1+G2                                  |
| G4 Probe ingest + poller | `ingestProbeResult` mapping `USAGE_HANDLERS` quota shapes → windows (Claude `session (5h)`/`weekly (7d)` keys at `usage/claude.js:102-114`, Codex `session`/`weekly` at `usage/codex.js:76-82`, Gemini buckets, Antigravity weekly overlay, Kiro breakdown, Copilot snapshots); `quotaPoller.js` tick loop; `isWeightedProvider` stub; wire into `initializeApp.js` | `src/shared/services/quotaPoller.js` (new), `src/shared/services/initializeApp.js` (1 import), `quotaSnapshot.js` (ingest fn)                             | After G1; parallel with G3                   |
| G5 Plan tier             | Claude profile fetch; Codex `chatgptPlanType` passthrough (already stored); Antigravity `mapTokens` tier fix; Copilot/Kiro from usage responses → `providerSpecificData.planTier`                                                                                                                                                                                   | `src/lib/oauth/providers/antigravity.js:115-122` (1 line), poller, `usage/github.js`, `usage/kiro.js` (read-only) + `updateProviderConnection` call sites | After G4; tier fixes independently shippable |
| G6 Visibility + tests    | Extend `GET usage/[connectionId]` with snapshot/weight/tier/sources; unit tests (parsers, expiry, weight matrix, poller cadence); run `verify-no-regression.mjs`                                                                                                                                                                                                    | `src/app/api/usage/[connectionId]/route.js`, `tests/unit/quota-snapshot.test.js` (+ parser/weight files)                                                  | Tests alongside each group; route last       |

Ownership rule: one group touches one new file + minimal appends; no group edits another's file. Total estimate: ~500 new lines, ~80 touched.

### Minimal file budget

- New runtime files: `quotaSnapshot.js`, `quotaHeaders.js`, `planCapacity.js`, `src/shared/services/quotaPoller.js` — four.
- Touched runtime files: `chatCore.js`, `antigravityQuota.js`, `auth.js`, `initializeApp.js`, usage route, Antigravity OAuth mapper, usage shared helper — seven, most 1–10 lines.
- New tests: prefer two files (`quota-snapshot.test.js`, `quota-poller.test.js`) over provider-per-file sprawl.
- No schema migration, dependency, new route, executor edits, or dashboard component required for phase 1.

## Test Strategy

- New `tests/unit/quota-snapshot.test.js`: scale normalization (0–1, 0–100, remaining-vs-used, non-finite, clamp), Codex window classification by minutes, expiry at `resetsAt`, TTL staleness, `computeEffectiveWeight` matrix (manual > table > 1, min-window, model-scoped match/miss, floor, unknown → base).
- Parser tests feed mocked `Response` objects with header fixtures — no live fetch needed (same approach as `tests/unit/groq-usage.test.js:17-30`).
- Poller test: copy DI style from `tests/unit/quota-auto-ping.test.js` (injected `deps` + `state`, see `runQuotaAutoPingTick(deps, state)` at `quotaAutoPing.js:286`) — asserts cadence, failure cooldown, stale-only polling, no ping calls.
- Regression: `antigravity-quota-routing.test.js`, `antigravity-weekly-quota.test.js`, `quota-auto-ping.test.js`, `codex-spark-quota-tracking.test.js` unchanged and green; then `node __baseline__/verify-no-regression.mjs results.json` from `tests/`.

## Key Decisions Needed

1. **Antigravity cutover with compat export**: recommend replacing `quotaCache` internals in phase 1 while keeping `getAntigravityQuotaCache()` shape — confirm no objection to updating `auth.js` + routing test imports in same change.
2. **Hook location**: chatCore post-`ok` (single site, all executors) vs `onRequestSuccess` callback chains — prefer chatCore, confirm streaming path headers still present.
3. **Poller home**: `src/shared/services/quotaPoller.js` (app side) — its deps (`localDb`, `refreshAndUpdateCredentials`, settings) are app-side, so `open-sse/` placement would invert the boundary. Store + parsers + weight stay in `open-sse/` (pure, importable by both sides and by phase 3 `combo.js`).
4. **Capacity starting values**: accept spec table as-is (several unverified) with comments, or trim to Claude/Codex-only until verified?
5. **`weighted` gating stub semantics**: poll when (a) provider in weighted combo OR (b) snapshot stale — confirm (b) alone suffices for phase-1 acceptance.

## Open Questions

- Exact Claude unified header names on non-streaming vs streaming responses (spec gives pattern `anthropic-ratelimit-unified-{5h,7d,7d_oi}-{utilization,reset,status}` — verify against live response)?
- Codex `limit_window_seconds` values for Pro weekly-as-primary (need live header dump)?
- Claude `/api/oauth/profile` response shape for `organization.rate_limit_tier` (endpoint path/field names)?
- Should `model:<id>` windows apply to combo member resolution in phase 3, or only exact-model match?
- Poller settings surface: reuse `claudeAutoPing`-style per-connection toggles or automatic-by-strategy with no UI?
