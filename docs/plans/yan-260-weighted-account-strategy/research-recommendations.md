# YAN-260 Weighted Account Strategy — Recommendations

## Executive Summary

Add `weighted` branch to `getProviderCredentials` reusing sticky-window pattern (`auth.js:202-241`), `computeEffectiveWeight` + `pickSmoothWeighted` + `weightedTargets`. Highest risks: poller gate gap for global `fallbackStrategy === "weighted"`, sticky--SWRR state split, auto planTier overwrite of manual override.

## Key Components

- `src/sse/services/auth.js`: strategy branch insertion point (`:184-245`)
- `open-sse/services/quotaSnapshot.js`: `computeEffectiveWeight`, `getSnapshot` (`:336-391`)
- `open-sse/services/weightedRoundRobin.js`: pure SWRR, caller owns state
- `src/shared/services/weightedTargets.js`: per-provider + combo-member resolution
- `src/shared/services/quotaSnapshotPoller.js`: weighted gating (`:172-183`)
- `src/app/api/settings/route.js`: no whitelist today, PATCH merges body
- `src/shared/components/EditConnectionModal.js`: name/priority only today

## Implementation Recommendations

### Approach

- New module `src/sse/services/weightedAccount.js`: pure candidate builder (weight>0 filter else all, sticky eligibility) + in-memory `Map<provider, currentWeights>`. Keep `auth.js` diff to strategy dispatch + persistence call.
- Sticky first, SWRR second: sticky holder = most-recent connection while `consecutiveUseCount < limit` AND headroom >= floor; else SWRR. Fallback chain: preferred > weighted > fill-first.
- Manual weight lives on connection as `manualWeight` column or `providerSpecificData.manualWeight`; source priority already `manual > plan > default` in `computeEffectiveWeight`. Same precedence for plan display.
- Default sticky: `>1` for OAuth subscription providers (claude/codex/antigravity/gemini-cli/kiro/github), `1` for API-key providers. Put table in config, not inline.
- 429 retry path: no change to `markAccountUnavailable` model-lock logic; snapshot refresh piggybacks on existing usage route. Add header/429-body ingest only where `resetsAt`/`usedFraction` parse fails-open.

### Phasing

1. Core routing (auth branch + SWRR state + unit tests). Safe merge, no UI.
2. Settings + connection UI (strategy select, sticky input, manual weight/plan, visibility chips).
3. Poller gate + dirty-state reset + integration/regression tests.

### Quick wins

- `Number(stickyLimit) || 3` pattern (`auth.js:203-204`) collapses `0` to default; clamp `1..100` explicitly for weighted.
- Reuse `buildQuotaSnapshotView` for visibility API — zero new shape.
- `resetComboRotation` precedent (`combo.js:254`): reset SWRR map on strategy change.

## Improvement Ideas

- Expose per-connection `effectiveWeight/share%/source` in existing providers GET; reuse route, no new endpoint.
- Surface `belowFloor` as UI badge, not silent zero.
- Sticky telemetry: log `weight/headroom/source` at debug like existing AUTH logs.
- Cap SWRR map (e.g. 500 providers, prune stale ids — `pickSmoothWeighted` already prunes).
- Consider `globalPriority` interplay: weighted ignores priority by design; document.

## Risk Assessment

| #   | Risk                                            | Evidence                                                                                                                                                                                 | Mitigation                                                                                       |
| --- | ----------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------ |
| 1   | Poller never starts for global account strategy | `configureQuotaSnapshotPoller` checks provider/combo strategies only (`quotaSnapshotPoller.js:172-183`), never `settings.fallbackStrategy`; `weightedTargets.weightedProviders` same gap | Add `settings.fallbackStrategy === "weighted"` to both gates + test                              |
| 2   | 18:4:1 AC fights sticky window                  | SWRR distributes smoothly, sticky pins head-of-line N calls (`auth.js:217-224`)                                                                                                          | Run distribution test with sticky=1; stickiness test separate                                    |
| 3   | SWRR state vs sticky DB state diverge           | SWRR map in-memory; sticky in `lastUsedAt/consecutiveUseCount` DB                                                                                                                        | Single owner module; reset both on strategy/pool change                                          |
| 4   | Sticky persists write per request               | `updateProviderConnection` awaited inside mutex (`auth.js:221-224`) serializes all account selection                                                                                     | Accept for phase 2 (same as round-robin); note contention                                        |
| 5   | Manual planTier overwritten by auto-detect      | `recordUsageSnapshot` persists detected tier (`quotaSnapshotSync.js:141-165`)                                                                                                            | Manual override flag in psd; skip auto-persist when set                                          |
| 6   | No settings whitelist                           | `updateSettings` merges arbitrary body (`settingsRepo.js:98-111`); route strips only secrets                                                                                             | Validate `fallbackStrategy ∈ {fill-first,round-robin,weighted}` + numeric ranges, reject unknown |
| 7   | Boolean→select migration                        | Profile + provider pages use toggles (`profile/page.js:1620-1628`, `[id]/page.js:473-479`)                                                                                               | Migrate UI to select with `fill-first/round-robin/weighted`; keep stored values compatible       |
| 8   | Model-specific windows narrow headroom          | `getHeadroom` min over applicable incl. `model:` match (`quotaSnapshot.js:261-295`)                                                                                                      | Pass `model` through from `getProviderCredentials`; test matched vs unmatched                    |
| 9   | All-exhausted must fall back to all             | `availableConnections` empty returns null/locked (`auth.js:155-182`) before strategy                                                                                                     | Filter weight>0 else use all, before empty-check                                                 |
| 10  | Antigravity dual filter confusion               | Model-lock + quota-cache pre-filter (`auth.js:116-137`) runs before weights                                                                                                              | Weighted applies after existing filters; document order                                          |

## Alternative Approaches

| Approach                     | Verdict                                                                   |
| ---------------------------- | ------------------------------------------------------------------------- |
| DB-persisted SWRR counters   | Reject — write amplification inside mutex; memory matches combo precedent |
| Sticky via SWRR weight boost | Reject — obscures semantics; keep explicit window                         |
| Separate weighted poller     | Reject — extend existing gated poller                                     |

## Task Breakdown Preview

| Phase    | Tasks                                                                                                                                                         | Files owned                                                 | Parallel?                                     |
| -------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------- | --------------------------------------------- |
| P1 core  | weighted branch; `weightedAccount.js`; SWRR map; unit tests (18:4:1 ±2%, stickiness, floor, all-exhausted, manual)                                            | `auth.js`, new module                                       | P1a branch + P1b module parallel; tests after |
| P2 UI    | strategy select global+per-provider; sticky input; manual weight/plan in edit modal; visibility chips                                                         | `profile/page.js`, `[id]/page.js`, `EditConnectionModal.js` | Three UI tasks parallel (disjoint files)      |
| P3 gates | settings validation; poller global-strategy gate; reset on change; integration test mirroring `antigravity-quota-routing.test.js`; `verify-no-regression.mjs` | `settings/route.js`, `weightedTargets.js`, poller           | After P1; validation parallel with poller     |

Ownership: one task one file; `auth.js` single writer.

## Key Decisions Needed

1. Manual weight/plan storage: new columns vs `providerSpecificData`? Recommend psd + explicit `manualOverride: true` flag.
2. Default sticky per provider table values?
3. `preferredConnectionId` pins bypass weighted — keep? Recommend yes.
4. Share SWRR state across server processes? Recommend no (single-process parity with combo rotation).

## Open Questions

- Should `settings.fallbackStrategy === "weighted"` activate poller for all providers or only OAuth ones?
- Floor configurable per provider or global `QUOTA_SNAPSHOT.floor` only?
- Visibility: extend providers GET or usage view only?
- YAN-261 combo strategy reuses `weightedAccount.js` helper — export stable API now?
