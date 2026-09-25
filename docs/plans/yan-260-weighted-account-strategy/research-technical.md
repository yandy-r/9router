# YAN-260 Weighted Account Strategy — Technical Design

## Executive Summary

Add `weighted` strategy to `getProviderCredentials` (`src/sse/services/auth.js:184-245`): new pure helper `src/sse/services/accountSelection.js` computes effective weights via `computeEffectiveWeight` (`open-sse/services/quotaSnapshot.js:336`), applies existing sticky-window semantics, then `pickSmoothWeighted` (`open-sse/services/weightedRoundRobin.js:12`). Persistence reuses round-robin DB writes; poller gating (`weightedTargets.js`, `quotaSnapshotPoller.js:172-183`) already keys on `fallbackStrategy === "weighted"`. Manual `weight`/`planTier` ride in `providerSpecificData` (no migration); settings PATCH needs a first-ever whitelist.

## Architecture Design

```
getProviderCredentials(auth.js:184) → strategy resolve (:187) → weighted branch (NEW)
  → selectWeightedConnection(accountSelection.js, pure)
      weights = computeEffectiveWeight({manualWeight: psd.weight, provider, planTier: psd.planTier, snapshot: getSnapshot(id), model})
      sticky check: most-recent lastUsedAt, consecutiveUseCount < stickyLimit, weight > 0
      else pickSmoothWeighted(weight>0 candidates) | all-available fallback
  → auth.js persists lastUsedAt/consecutiveUseCount (existing pattern :221-239)
  → resolveConnectionProxyConfig → return credentials (unchanged shape :250-276)
```

- SWRR state: module-scope `Map<providerId, currentWeights>` in `accountSelection.js`; `pickSmoothWeighted` already prunes stale ids per pick (`weightedRoundRobin.js:18-44`). Reset on strategy change via `settings/route.js` side-effect (precedent: `resetComboRotation`, `:98-104`).
- Existing pre-filters run first and unchanged: exclude-set, `isModelLockActive`, Antigravity quota-cache block (`auth.js:116-137`). Weighted applies to `availableConnections` only.
- `preferredConnectionId` pin (`auth.js:191-199`) bypasses strategy — keep.
- Retry path unchanged: `chat.js:284-289` while-loop over `getProviderCredentials` with exclude set; `markAccountUnavailable` (`auth.js:292`) writes `modelLock_*`. No snapshot write on 429 today (see Constraints).

### Helper signature

```js
// src/sse/services/accountSelection.js
selectWeightedConnection({
  connections,
  provider,
  model,
  stickyLimit,
  swrrState,
  getSnapshot,
  nowMs,
});
// → { connection, nextState, stayed: boolean, weights: Map<id, {weight, base, baseSource, headroom, headroomSource, belowFloor}> }
```

- `connections`: already-filtered available list. `swrrState`: prior `Map` for this provider (or null). `getSnapshot`: injectable (default re-export from `quotaSnapshotSync.js:15`). `nowMs`: injectable clock.
- Sticky: current = max `lastUsedAt`; stay iff `lastUsedAt` set AND `consecutiveUseCount < stickyLimit` AND current effective weight > 0 (covers below-floor and manual-0). Else SWRR over weight>0; none → all available, equal weight 1.
- Fallback decision: **equal weights** (not base weights). Rationale: all-below-floor means every quota signal says exhausted; re-applying base/plan ratios re-concentrates on the biggest account. Equal spread minimizes further damage; `modelLock_*` will still remove hard-429 accounts on next loop.

### Wiring into auth.js (minimal diff)

- Insert `else if (strategy === "weighted")` between round-robin (`:202`) and fill-first (`:242`).
- Branch: build inputs (stickyLimit resolve identical to `:203-204`), call helper, persist winner with same two `updateProviderConnection` shapes (stay: count+1; switch: count=1), store `nextState`.
- Do NOT refactor round-robin/fill-first into helper in this phase (minimal diff; round-robin inline logic stays). Extract shared `resolveStickyLimit` 3-liner only.

## Data Models

- `providerSpecificData.weight` (NEW, number 0..1000): manual override → `computeEffectiveWeight.manualWeight` (manual wins, `quotaSnapshot.js:340-348`). `manual === 0` hard-excludes (`:359-368`).
- `providerSpecificData.planTier` (EXISTS, string): already written by gemini-cli (`oauth/gemini-cli.js:83-94`), antigravity (`:119-131`), `persistPlanTier` (`quotaSnapshotSync.js:141-165`). `computeEffectiveWeight` prefers explicit `planTier` arg over `snapshot.planTier` (`:342`).
- `providerSpecificData.planTierManual` (NEW, boolean): when true, `persistPlanTier`/`recordUsageSnapshot` skip auto-persist; snapshot still filled via `fallbackTier` path (`:201-209`).
- Settings: `providerStrategies[providerId] = { fallbackStrategy: "weighted", stickyRoundRobinLimit?: n }`. Global `settings.fallbackStrategy` read at `auth.js:187` (no default key in `settingsRepo.js:7-65`; fallback `"fill-first"` at read time).
- No schema migration: `providerSpecificData` is free-form JSON bag; connection list sorts by `priority` (`connectionsRepo.js:137`).

## API Design

- `PUT /api/providers/[id]` (`providers/[id]/route.js:87-172`): currently spread-merges arbitrary psd (`:138-141`, finding C1). Add: allow-list psd keys incl. `weight`, `planTier`, `planTierManual`; validate `weight` finite 0..1000 else 400; `planTier` via `sanitizePlanTier` (exists, `quotaSnapshot.js:236`), must exist in `PLAN_CAPACITY[provider]` when provider known else 400; `planTierManual` boolean. Reject `__proto__/constructor/prototype` keys.
- `PATCH /api/settings` (`settings/route.js:45-141`): no strategy validation today (shallow merge `settingsRepo.js:98-111`). Add: `fallbackStrategy ∈ {fill-first, round-robin, weighted}`; `providerStrategies` keys must be registry provider ids; each `fallbackStrategy` same enum; `stickyRoundRobinLimit` (global + per-provider) integer 1..100 (current `|| 3` pattern at `auth.js:203-204` swallows 0 — replace with explicit clamp); unknown keys rejected 400. Keep side-effects: `configureQuotaSnapshotPoller` (`:115-128`).
- `GET /api/usage/[connectionId]` (`usage/[connectionId]/route.js:212-215`): already attaches `quotaSnapshot: buildQuotaSnapshotView(id, {})`. Pass `manualWeight: connection.providerSpecificData.weight` so view reflects override; add `sharePct` client-side (weight / Σ weights). No new endpoint.
- `GET /api/providers`: optionally attach `effectiveWeight`/`sharePct` per connection (server computes via snapshot store; in-memory only, no extra upstream calls). Prefer extending this response over a new route.

## System Constraints

- Poller gap: `configureQuotaSnapshotPoller` (`quotaSnapshotPoller.js:172-183`) and `weightedProviders` (`weightedTargets.js:13-33`) gate on per-provider/combo strategies only — global `settings.fallbackStrategy === "weighted"` does NOT start the poller. Must add to both gates or global-weighted accounts run on stale snapshots (fail-open headroom 1).
- 429→snapshot bridge missing: `chatCore.js:642-646` ingests headers only; codex 429 `resetsAtMs` (`executors/codex.js:474-503`) flows only to `modelLock_*` (`auth.js:314-321`). A 429 body/reset time never creates a snapshot window (`recordWindows` needs `usedFraction`, `quotaSnapshot.js:66-68`). Out of scope for YAN-260 except: do not claim weights react to 429s without a poller tick/probe.
- Mutex contention: selection holds `selectionMutex` (`auth.js:52-70`) across awaited DB writes. Weighted keeps one write per pick (same as round-robin) — acceptable.
- SWRR state is per-process memory (combo rotation precedent `combo.js:95,254-256`); multi-instance drift accepted.
- Sticky default: `settingsRepo.js:14` global default 3; per-provider default in `ConnectionsCard.js:487` is `"1"`. OAuth = registry `category: "oauth"` (`providers.js:77`), 21 ids; note `gemini-cli` is `category: "free"`, not oauth — any oauth-default table must include it explicitly.
- UI: `profile/page.js:1620-1697` global control is boolean Toggle round-robin/fill-first + sticky input (1..10); `ConnectionsCard.js:640-670` per-provider Toggle (on saves `sticky || 1`, off deletes the key `:509-511`). Both must become Select `fill-first/round-robin/weighted` (shared `STRATEGY_OPTIONS`).

## Codebase Changes

Create:

- `src/sse/services/accountSelection.js` (~120 lines): `selectWeightedConnection` + module `swrrState` + `_resetAccountSelection()` test helper. Reuse `computeEffectiveWeight`, `pickSmoothWeighted`, `QUOTA_SNAPSHOT.floor`, `PLAN_CAPACITY` — no value duplication.
- `tests/unit/weighted-account-selection.test.js`: distribution (≈18:4:1), stickiness, manual-0 exclusion, below-floor zeroing, all-exhausted equal fallback, model-scoped headroom. Template: `tests/unit/weighted-round-robin.test.js:5-14` (`pickMany`), `antigravity-quota-routing.test.js:1-40` (vi.mock pattern).

Modify:

- `src/sse/services/auth.js:184-245`: add weighted branch + persist; replace `|| 3` with clamp 1..100.
- `src/app/api/settings/route.js:86-128`: validation + keep poller side-effect.
- `src/app/api/providers/[id]/route.js:130-156`: psd allow-list + weight/tier validation.
- `src/shared/services/weightedTargets.js:13-33` + `quotaSnapshotPoller.js:172-183`: add global-fallbackStrategy gate.
- `src/sse/services/quotaSnapshotSync.js:141-165,201-209`: honor `planTierManual`.
- `src/app/api/usage/[connectionId]/route.js:194-215`: pass `manualWeight` into view.
- UI: `profile/page.js:1620-1697`, `ConnectionsCard.js:471-520,640-670` (Toggle→Select), `GET /api/providers` (`providers/route.js:62-97`) weight fields.

## Technical Decisions

- Equal-weight (not base-weight) all-exhausted fallback — spreads load when all signals say stop.
- Sticky gate requires weight > 0 — prevents pinning a depleted/manual-0 account; matches recommendations R2.
- `weight`/`planTierManual` in psd, not columns — zero migration; precedented bag keys.
- In-memory SWRR Map, no DB persistence — matches combo precedent; reset on strategy change.
- Default sticky: `max(configured, 3)` for OAuth-subscription providers (claude/codex/antigravity/gemini-cli/kiro/github), 1 for API-key providers; cap 10. Table lives in `open-sse/config/` (never hardcode per AGENTS.md).
- Minimal auth.js diff: no round-robin extraction this phase (testability payoff deferred; keeps review small).

## Open Questions

1. Global `fallbackStrategy === "weighted"`: poll all providers or OAuth-only?
2. `manualWeight` upper bound: 100 or 1000? (Ratios only matter; cap bounds blast radius.)
3. All-below-floor UI: silent equal-split or explicit `belowFloor` badge? (Recommend badge.)
4. Should strategy/weight edits require re-auth when `requireLogin=false`? (Security W6.)
5. Reuse `selectWeightedConnection` for YAN-261 combos now — export stable API?
