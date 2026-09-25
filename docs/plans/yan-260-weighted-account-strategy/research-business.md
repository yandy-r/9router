# YAN-260 Weighted Account Strategy — Business Analysis

## Executive Summary

Add `weighted` as third per-provider/global account strategy in `getProviderCredentials`, spreading traffic by `computeEffectiveWeight` (plan capacity × live headroom, manual override wins). All detection, snapshot, and poller plumbing from YAN-259 exists; YAN-260 adds selection logic, settings validation, manual-override UI, and weight visibility. Biggest risk: detected `planTier` overwrites manual values today — a manual flag/source field is required or overrides silently vanish.

## User Stories

- As multi-account owner, traffic splits by plan size and remaining quota, so big accounts serve proportionally more.
- As operator, I pin Plan + Weight per account (0 = exclude) with "Auto-detected: X" fallback, so edge tiers work without code changes.
- As viewer, I see per-account effective weight, share %, and source (header/probe/plan/manual), so skew is explainable.
- As requester, exhausted accounts drain to zero and recover automatically; when all are below floor, requests still try (never self-block).

## Business Rules

**Core**

- `weight = base × headroom`; `base` = manualWeight ?? `PLAN_CAPACITY[provider][tier]` ?? 1 (`open-sse/services/quotaSnapshot.js:336-390`).
- `manualWeight 0` → weight 0, `belowFloor: false`; headroom < floor (0.05, `open-sse/config/quotaSnapshot.js:8`) → weight 0, `belowFloor: true`.
- Filter to weight>0; if empty, use all available (fail-open, never self-block).
- Sticky window (`stickyRoundRobinLimit`) reuses `lastUsedAt`/`consecutiveUseCount`; new window starts only if current headroom ≥ floor; at window end pick via `pickSmoothWeighted` (`open-sse/services/weightedRoundRobin.js:12-51`) with in-memory `currentWeight` Map per provider.
- Headroom = min applicable window (`getHeadroom`); unknown connection = headroom 1 static. Model windows match on token-run rule.
- OAuth subscription providers default sticky >1 under weighted (unset limit must not default to 1).
- Retry path unchanged: `chat.js` excludes failed account via `excludeConnectionIds` + `markAccountUnavailable`; weighted selection must honor exclude set.
- `/api/settings` whitelists `providerStrategies[].fallbackStrategy` and global `fallbackStrategy` to `fill-first|round-robin|weighted`, 400 otherwise.

**Edge cases**

- `preferredConnectionId` pinning (`auth.js:191-201`, image/video `x-connection-id`) bypasses strategy entirely — weighted must keep pin-first.
- `noauth` free providers (`auth.js:74-98`) return virtual connection; strategy N/A.
- Model locks (`isModelLockActive`, `open-sse/services/accountFallback.js:149`) + Antigravity RAM quota-cache filter BEFORE weighting; all-locked returns `allRateLimited` + `retryAfter`, never a pick.
- **Detection overwrites manual tier today**: `persistPlanTier` (`quotaSnapshotSync.js:141-165`) persists any `detectedTier` when changed, no manual flag; re-login merge (`connectionsRepo.js:162-230`, `{...existing, ...normalized}`) also replaces `providerSpecificData`. Manual Plan needs `planTierSource: manual` (or equivalent) consulted before both write paths.
- `fallbackTier` fills snapshot memory only, never re-persisted (`quotaSnapshotSync.js:168-215`).
- Claude tier comes only from profile endpoint, throttled 24h (`profileRecheckMs`), 403 marks checked-only.
- No snapshot → equal SWRR (base 1, headroom 1 static) — matches "no data" acceptance.
- `pickSmoothWeighted` drops `weight<=0`/dup ids, resets state when nothing pickable; callers own Map lifecycle (hot-reload/serverless resets = harmless re-balance).
- Sticky counters shared with round-robin columns; switching strategies reuses stale counts (acceptable; first window may be short/long).
- `PLAN_CAPACITY` has `_verify` estimates (codex pro 20, github tiers, kiro ids); unknown tier → base 1 default, no error.
- Poller gap: `configureQuotaSnapshotPoller` starts only on provider/combo `weighted`, NOT global `fallbackStrategy: weighted` — global weighted would poll nothing unless fixed.
- Settings PATCH today mass-assigns with zero validation (`settings/route.js:45-141`); `fallbackStrategy` isn't even in `DEFAULT_SETTINGS` (`settingsRepo.js:7-65`).

## Workflows

**Primary (per request)**: filter excluded/locked/cache-blocked → resolve strategy (per-provider override else global) → pin? → weighted: compute weights (snapshot + psd plan/weight) → weight>0 subset else all → sticky incumbent if count<limit and headroom≥floor → else SWRR pick → persist `lastUsedAt`/`consecutiveUseCount` under `selectionMutex` → return credentials.
**Manual override**: Plan select (options = `PLAN_CAPACITY[provider]` keys + "Auto-detected: X") + numeric Weight (0 = exclude) → `PUT /api/providers/[id]` merges `providerSpecificData` (`[id]/route.js:130-156`) → next selection + `buildQuotaSnapshotView` reflect it.
**Error recovery**: failure → `markAccountUnavailable` (model lock) → retry with `excludeConnectionIds.add(id)` → next weighted pick excludes it; Antigravity 409/429 also RAM-blocks until `resetAt`; success clears locks. All-locked → 503 with earliest `retryAfter`.

## Domain Model

- **Connection**: `{id, provider, authType, priority, isActive, lastUsedAt, consecutiveUseCount, modelLock_*, providerSpecificData:{planTier, weight/manualWeight, planTierSource?, chatgptPlanType, proxy...}}`.
- **Snapshot** (RAM, keyed by `connectionId`): `{provider, windows:[{kind, usedFraction, resetsAt, observedAt, source}], planTier, updatedAt}`.
- **Settings**: `{fallbackStrategy, stickyRoundRobinLimit=3, providerStrategies:{[p]:{fallbackStrategy, stickyRoundRobinLimit}}}`.
- **Weight view** (`buildQuotaSnapshotView`): `{planTier, windows[], stale, effectiveWeight:{weight, base, baseSource, headroom, headroomSource, belowFloor}}`.

## Existing Codebase Integration

- Selection: `src/sse/services/auth.js:46-245` (mutex, noauth, filters, pin, round-robin sticky pattern to mirror).
- Weight math: `open-sse/services/quotaSnapshot.js:336-390` (`computeEffectiveWeight`), `:240-333` (`getHeadroom`, `getProviderHeadroom`), SWRR `open-sse/services/weightedRoundRobin.js:12-51`.
- Detection/persist: `src/sse/services/quotaSnapshotSync.js:57-244` (`kindForName`, `planTierFor`, `persistPlanTier`, `recordUsageSnapshot`, `fetchAndPersistClaudePlanTier`, `buildQuotaSnapshotView`).
- OAuth tier sources: `src/lib/oauth/providers/antigravity.js:47-131`, `gemini-cli.js:60-95` (`mapTokens` → `psd.planTier`); save path `src/lib/oauth/utils/server.js` → `createProviderConnection` (`connectionsRepo.js:162-230`).
- Snapshot view API: `src/app/api/usage/[connectionId]/route.js:194-215` (record + `quotaSnapshot` in response; Claude extra call gated by `isWeightedProvider`).
- Settings: `src/app/api/settings/route.js:45-141` (PATCH, no validation — add whitelist), `src/lib/db/repos/settingsRepo.js:7-111` (defaults/merge/atomic write).
- Poller gating: `src/shared/services/weightedTargets.js:13-43`, `src/shared/services/quotaSnapshotPoller.js:123-183` (weighted-only, eligible = oauth or `USAGE_APIKEY_PROVIDERS`, fresh<15m skip, 60s tick).
- UI: `ConnectionsCard.js:484-663` (per-provider toggle+sticky), `providers/[id]/page.js:389-466` (same), `profile/page.js:1621-1695` (global boolean → must become select), `NoAuthProxyCard.js:34-62` (untouched pattern).
- Retry: `src/sse/handlers/chat.js:284-435` (exclude-set loop, `markAccountUnavailable`); locks `open-sse/services/accountFallback.js:149-180`.
- Tests: `tests/unit/antigravity-quota-routing.test.js:1-280` (mock pattern for `getProviderCredentials` integration); gate `tests/__baseline__/verify-no-regression.mjs` (pass→fail vs `known-fails.txt`).

## Success Criteria

- 3 Claude accts (Max20x 10%, Max20x 80%, Pro 0%), 1000 picks sticky-1 ≈ 18:4:1 ±2%.
- Floor crossing stops new sticky windows; all-below-floor still returns account; no-data = equal SWRR; manual weight overrides plan; weight 0 excludes unless sole account.
- fill-first/round-robin unchanged + new tests for both; unit tests for helper + integration test mirroring `antigravity-quota-routing.test.js`; `verify-no-regression.mjs` green.

## Open Questions

1. Manual storage shape: `psd.planTier` + `psd.planTierSource='manual'|'detected'` + `psd.weight`? Who strips manual flag on "Auto"?
2. Fix poller gap (global weighted starts poller) in this ticket or separate?
3. Default sticky for OAuth subscription providers under weighted: which value (3? per-provider)?
4. Weight visibility UI location: extend `ConnectionRow` inline, or new quota panel fed by `quotaSnapshot` view?
5. Validation error shape for 400 (field-level vs generic) + Ultrasound/i18n strings?
6. SWRR `currentWeight` Map scope: module-global per provider in `accountSelection.js` — survives multi-instance? (single-instance assumption OK?)
