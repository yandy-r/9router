# YAN-259 Quota Snapshot — Business Analysis

## Executive Summary

YAN-259 builds shared data layer for future Weighted balancing (YAN-260/261): per-connection in-memory quota snapshot (`windows[]` headroom + `planTier`) plus pure `computeEffectiveWeight()`.
Today usage fetchers (`open-sse/services/usage.js:42 USAGE_HANDLERS`) run on-demand for dashboard only (`src/app/api/usage/[connectionId]/route.js:124 GET`) and results thrown away; only Antigravity has routing cache (`src/sse/services/antigravityQuota.js:12 quotaCache`) filtering exhausted accounts.
New layer adds zero-extra-call passive header ingest + gated active polling + persisted plan-tier detection, all fail-open (never break requests).

## User Stories

1. **Multi-account Claude/Codex owner**: "My 5 accounts have different plans (Pro vs Max20x); route more traffic to big accounts automatically." Needs planTier + live headroom per connection.
2. **Combo user (fallback/round-robin today)**: "Round-robin sends equal traffic even when one account exhausted." Wants weighted pick using `min(1-usedFraction)` headroom.
3. **Idle-account owner**: "Account idle for hours shows stale 100% headroom." Needs poller refresh when passive data stale, only for `weighted` combos/providers.
4. **Setup-token / limited-scope owner**: "Don't break my requests or spam errors if plan detection fails." Needs `planTier=null`, base weight fallback, debug-only logs.
5. **Dashboard viewer**: "See why router picked account A." Needs visibility via existing `/api/usage/[connectionId]` + snapshot source (`header|probe|static|manual`).

## Business Rules

### Core rules

- **BR-1 Snapshot key**: `Map<connectionId, { windows[], planTier, updatedAt }>`; windows: `{ kind: "5h"|"7d"|"day"|"month"|"model:<id>", usedFraction [0,1], resetsAt ISO, source }`.
- **BR-2 Headroom**: `headroom = min_over_applicable_windows(1 - usedFraction)`; include `model:<id>` windows only when request model matches.
- **BR-3 Base weight precedence**: `manualWeight → planCapacity table → 1`. Manual = existing priority? No — manual weight new; do not conflate with `priority` sort in `connectionsRepo.js:139` / `auth.js:243 fill-first`.
- **BR-4 Effective weight**: `effective = base × headroom`, floored: `max(effective, floor=0.05)`. Floor keeps exhausted accounts reachable for recovery probes, mirrors strike-block expiry pattern.
- **BR-5 Fail-open**: ingest/poll/detect never throw into request path; catch → keep previous value or base×1; `log.debug` only. Precedent: `combo.js:426 catch → fallback continues`; `google.js:283 catch weekly ignore`; `quotaAutoPing.js:306 catch → failureCache`.
- **BR-6 Source priority**: `header` (freshest, zero cost) > `probe` (USAGE_HANDLERS poll) > `static/manual`. Expose source per window for visibility.
- **BR-7 Single hook**: one post-response hook (proposed `open-sse/handlers/chatCore.js` / `executors/base.js`), per-provider parser map in `open-sse/config/`. No per-executor copy-paste.

### Edge cases

- **Scales — normalize at ingest, clamp [0,1], validate finite**:
  - Claude unified headers `0–1`; `/api/oauth/usage` `0–100` (`usage/claude.js:89 used=utilization`, `90 remaining=100-used`) — detect runtime.
  - Codex `0–100` (`usage/codex.js:49 clamp 0..100`); Google/Gemini `remainingFraction 0–1` (`usage/google.js:76`, `213`); `USAGE_HANDLERS remainingPercentage 0–100` (`usage/github.js:98 formatGitHubQuotaSnapshot`, `usage/kiro.js:22 remaining=total-used`).
  - Non-finite/NaN → drop window, keep previous.
- **Unknown data → base×1**: missing headers, `{ message }` soft-failure payloads (`usage/claude.js:50 stale fallback`, `antigravityQuota.js:122 !usage.quotas → null`), 401/403 quota API (`google.js:150 403 quotas:{}`) all mean "no signal", not "exhausted".
- **Expiry at reset**: window expires when `now >= resetsAt`; stale windows excluded from `min()` (prevents phantom exhaustion). Precedent: `antigravityQuota.js:198 resetMs <= now → null`; `quotaAutoPing.js:89 shouldPingForReset`.
- **TTL**: whole snapshot expires after TTL (propose 5–10 min, align `claude.js:24 USAGE_CACHE_TTL_MS=300000`); expired snapshot → treat as unknown (base×1) + eligible for poll.
- **Floor 0.05**: exhausted (`usedFraction=1`) still gets `base×0.05`, never 0. Rationale: allow recovery detection, avoid divide-by-zero in weighted pick, match "never drop model" in `combo.js:67 reorderByCapabilities`.
- **Antigravity 1.0**: `fetchAvailableModels quotaInfo.remainingFraction` stuck at 1.0 → treat as **unknown**, skip window. Keep existing reconciliation (`google.js:246 allGeminiExhausted` override) and strike-breaker (`antigravityQuota.js:20 STRIKE_THRESHOLD=3`, `27 STRIKE_BLOCK_MS=15m`) — generalize, don't duplicate.
- **Setup-token 403 → unknown**: Claude profile `GET /api/oauth/profile → organization.rate_limit_tier` needs `user:profile` scope; setup-tokens 403 → `planTier=null`, no request error. Same for Kiro social-auth 401/403 (`usage/kiro.js:167 idc`, `176 google/github` → `{ message, quotas:{} }`).
- **Codex window classification by minutes, not name**: Pro reports weekly as "primary"; classify via `limit_window_seconds`/`window-minutes` (`x-codex-{primary,secondary}-{used-percent,window-minutes,reset-at}`). Probe `additional_rate_limits[]` + `rate_limits_by_limit_id` review/spark (`codex.js:87 getCodexReviewRateLimit`, `110 getCodexSparkRateLimit`) map to `model:<id>` windows.
- **Copilot AI-Credits switch (2026-06-01)**: `premium_interactions` semantics unverified; prefer `percent_remaining` from `quota_snapshots.{chat,completions,premium_interactions}` (`github.js:49`).
- **Kiro pool ambiguity**: `usageBreakdownList[]` multi-pool; don't assume index 0 is plan pool — filter `resourceType=AGENTIC_REQUEST` or aggregate min headroom.
- **API-key providers**: generic `x-ratelimit-{limit,remaining,reset}-{requests,tokens}`; Groq requests/day + tokens/min (`usage/groq.js:8`); OpenAI reset duration `"6m0s"` + `-1/0` on Responses API → parse duration, treat `-1` as unlimited; Anthropic API `anthropic-ratelimit-*-{limit,remaining,reset}` RFC3339.

## Workflows

### W-1 Passive ingest (hot path, zero extra calls)

1. Upstream response returns through executor (`open-sse/executors/base.js` / `executors/antigravity.js:420 x-ratelimit-reset-after` precedent; `executors/zed.js:245 execute()` returns `{ response }`).
2. Single post-response hook reads headers + `connectionId` from credentials (`auth.js:249 return { ..., providerSpecificData }` carries `connectionId` via `quotaAutoPing.js:166 credentials.connectionId` pattern).
3. Per-provider parser (`open-sse/config/*`, e.g. `grokCli.js`, `kiroConstants.js` precedent — all constants in config) normalizes → `quotaSnapshot.ingest(connectionId, windows[], source="header")`.
4. Fail-open: parse error → debug log, response passes through untouched (precedent `rtk/ headroom.js` fail-open per `open-sse/AGENTS.md`).

### W-2 Active poll (only where needed)

1. Poller tick (model on `src/shared/services/quotaAutoPing.js:286 runQuotaAutoPingTick`, global `g` singleton `29`, `startQuotaAutoPing 319` interval) — reuse, don't second scheduler.
2. Gate: only connections in provider/combo using `weighted` strategy (helper stub phase 2/3 makes true; `weighted` value doesn't exist yet — key off `settings.providerStrategies[provider].fallbackStrategy==="weighted"` / `settings.comboStrategies[name].fallbackStrategy`).
3. Gate: only when passive stale (no fresh window for TTL) or startup; per-provider cadence; respect `usage/claude.js:19 OAUTH_429_COOLDOWN_MS=180000` + `24 USAGE_CACHE_TTL_MS` (pass `{ force:false }`, never force-poll Claude).
4. Reuse `USAGE_HANDLERS` fetchers via `getUsageForProvider(connection, proxyOptions)` (`usage.js:78`); map `quotas` entries → snapshot windows; refresh creds first via `refreshAndUpdateCredentials` (`route.js:23`, reused by `quotaAutoPing.js:223`).
5. Dedup in-flight (`antigravityQuota.js:16 inflightRefresh`, `claude.js:25 usageCache promise`), 30s min interval (`antigravityQuota.js:18`).

### W-3 Plan-tier detection (persisted, lazy)

| Provider           | Source                                                                                                      | Persist to                      | Note                                                          |
| ------------------ | ----------------------------------------------------------------------------------------------------------- | ------------------------------- | ------------------------------------------------------------- |
| Claude             | `GET /api/oauth/profile → organization.rate_limit_tier` (`default_claude_max_20x/_5x/pro`)                  | `providerSpecificData.planTier` | needs `user:profile`; 403 → null                              |
| Codex              | `providerSpecificData.chatgptPlanType` (JWT, already stored) + probe `plan_type` (`codex.js:169`)           | `planTier` derived              | verify `prolite=Pro5x, pro=Pro20x` (unverified)               |
| Gemini/Antigravity | `loadCodeAssist paidTier.id` fallback `currentTier.id` (`google.js:174 paidTierId`, `subscriptionInfo 290`) | `planTier`                      | `mapTokens` drops it today (`antigravity.js:115`) — fix there |
| Copilot            | `copilot_internal/user → copilot_plan` (`github.js:55 plan`)                                                | `planTier`                      | take from usage response                                      |
| Kiro               | `GetUsageLimits → subscriptionInfo.subscriptionTitle` (`kiro.js:46 plan`)                                   | `planTier`                      | don't assume pool index                                       |

Persist via `updateProviderConnection(id, { providerSpecificData: {...existing, planTier} })` (`connectionsRepo.js:255` atomic merge tx; merge pattern `route.js:99 providerSpecificUpdates`). Detect lazily on poll/startup, never block chat.

### W-4 Error recovery

- 429/409 on chat → existing `handleAntigravityQuotaError` (`antigravityQuota.js:141`) refreshes cache + strike-counts; generalize: any provider error path may trigger snapshot refresh, throttled.
- Exhausted `min headroom≈0` → weight floor keeps account in rotation at 5%; strike-block (`15m`) still skips Antigravity pair via synthesized 0% entry (`antigravityQuota.js:185`).
- Success clears strikes (`clearAntigravityStrikes 57`) — snapshot ingest on success should same: clear error state, update windows.

## Domain Model

- **Snapshot**: `{ connectionId, windows: Window[], planTier: string|null, updatedAt: ISO, source: "header"|"probe"|"static"|"manual" }`. In-memory `Map` (no DB; precedent `antigravityQuota.js:12 quotaCache`, `combo.js:95 comboRotationState`, `quotaAutoPing.js:29 g`). Process-local; multi-instance staleness acceptable (fail-open).
- **Window**: `{ kind, usedFraction, resetsAt, source }`. `kind ∈ {"5h","7d","day","month"} ∪ {"model:<id>"}`. `usedFraction` normalized [0,1]. `resetsAt` ISO|null (null → TTL-only expiry).
- **PlanTier**: opaque string per provider, resolved to number only via `open-sse/config/planCapacity.js` (`{ provider: { tierId: relativeWeight } }`). Starting values per spec: Claude 1/5/20; Codex 1/5/20; Copilot 1/4.7/13.3; Gemini 1/1.5/2; Antigravity 1/5–20; Kiro 0.05/1/2/5/10. No hardcoded weights elsewhere.
- **State transitions**:
  - `∅ → live`: first header ingest or probe success.
  - `live → stale`: `now - updatedAt > TTL` or all windows past `resetsAt`.
  - `stale → live`: fresh ingest/probe.
  - `live → unknown`: consecutive probe failures (keep last-good for 1 TTL first — precedent `claude.js:50 stale`); unknown → `base×1`.
  - `planTier: null → <tier>` on detection; never `→ null` on failure (sticky last-known).

## Existing Codebase Integration

- **Connections store** (`src/lib/db/repos/connectionsRepo.js`): SQLite `providerConnections`, fat `data` JSON col (`connToRow 68`, `rowToConn 51` spreads `extra`). `providerSpecificData` lives inside `data` JSON — schemaless, add `planTier` freely. `getProviderConnections(filter)` (`122`, sorts priority `139`); `updateProviderConnection(id, data)` (`255` atomic tx merge + `updatedAt`). Re-exported via `src/lib/db/index.js:16`, `src/lib/localDb.js:8`. Plan-tier write = merge `providerSpecificData` (see `route.js:99`).
- **Settings/strategies**:
  - Account-level (`src/sse/services/auth.js:187`): `providerOverride.fallbackStrategy || settings.fallbackStrategy || "fill-first"`; `round-robin` sticky (`202`, `stickyRoundRobinLimit 203`, `lastUsedAt/consecutiveUseCount 221`) else `fill-first` priority order (`243`). Phase 2 plugs `weighted` here.
  - Combo-level (`open-sse/services/combo.js:218 getRotatedModels`, `328 handleComboChat`): strategies `fallback|round-robin|fusion` resolved `settings.comboStrategies[name].fallbackStrategy || settings.comboStrategy || "fallback"` (`src/sse/handlers/chat.js:111`, same in `imageGeneration.js:52`, `search.js:75`, `fetch.js:95`, `tts.js:57`). Defaults `settingsRepo.js:17 comboStrategy:"fallback"`, `19 comboStrategies:{}`. Phase 3 plugs `getWeightedModels` here.
  - Poller gate reads same keys; `weighted` doesn't exist yet → stub helper `isWeightedTarget(provider, comboName, settings)` returning false, phases 2/3 flip true.
- **Usage fetchers** (`open-sse/services/usage.js:42 USAGE_HANDLERS`, `78 getUsageForProvider`): per-provider `usage/*.js` (`claude/codex/google/github/kiro/groq/...`). Shapes differ (`remainingPercentage` vs `used/total` vs `remainingFraction`) — snapshot mapper normalizes. Reuse for polling; add `force` passthrough (`route.js:128 ?force=1`).
- **Quota-adjacent infra to reuse/fold**: `antigravityQuota.js` (30s throttle `18`, inflight dedup `16`, strike breaker `20-29`, `getAntigravityQuotaCache 73` read by `auth.js:159` pre-filter) — fold onto snapshot store, keep tests green (`antigravity-quota-routing`, `antigravity-weekly-quota`). `quotaAutoPing.js` (tick scheduler, `refreshAndUpdateCredentials`, proxy-aware fetch) — model poller on it. `capacityAdapter` (`settingsRepo.js:20`, `chat.js:162 augmentModelsWithCapacityAdapter`) — capability reorder precedent, orthogonal to weights.
- **Hook point**: `open-sse/handlers/chatCore.js` → `executors/*/execute()` return `{ response }` (`github.js:150`, `windsurf.js:442`); response headers available post-`execute`. Single wrapper in `executors/base.js` or chatCore post-response. Header precedents: `antigravity.js:420`, `groq.js:104` header names, `combo.js:381 retry-after` read.

## Success Criteria

- [ ] One Claude OAuth/Codex request → snapshot holds 5h + weekly `usedFraction` from headers, zero extra upstream calls (acceptance).
- [ ] PlanTier persisted for Claude/Codex/Gemini+Antigravity/Copilot/Kiro where credential allows; else `null`, no request-visible error.
- [ ] Malformed/missing header or probe failure → previous value or static weight; requests never fail from this layer.
- [ ] Unit tests `tests/unit/`: parsers per provider (0–1 vs 0–100, Codex minute-classification), expiry-at-reset, `computeEffectiveWeight` (manual/plan/min-window/floor/unknown→base), poller cadence + cooldown; then `tests/__baseline__/verify-no-regression.mjs` green; Antigravity tests green.

## Open Questions

1. `weighted` gating helper shape — new `settings.providerStrategies[p].fallbackStrategy==="weighted"` or separate flag? Phases 2/3 contract undefined.
2. `manualWeight` source — new connection field or reuse `priority`/`globalPriority` (`connectionsRepo.js:9`)? Spec says `manual → plan → 1` but manual storage unspecified.
3. Snapshot TTL value — 5 min (Claude cache) vs longer for weekly windows? Per-kind TTL?
4. `prolite = Pro 5x` mapping unverified; Copilot `4.7/13.3` and Antigravity `5–20` weights provisional — confirm from pricing/capacity data?
5. Claude profile endpoint path + `rate_limit_tier` enum values — confirm against live API (only `organization.rate_limit_tier` hint from research doc)?
6. Persist snapshot to DB or keep RAM-only? Multi-instance dashboard visibility needs shared read — new route reads local Map (stale on other instance) acceptable?
7. Kiro plan-pool selector — which `usageBreakdownList[]` entry is billable pool when multiple `resourceType`s present?
