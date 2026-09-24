# YAN-260 practices research: weighted account strategy

## Executive Summary

All heavy math already exists (YAN-259). New work is thin glue: pure `selectAccount`
helper in `src/sse/services/accountSelection.js`, one `Map` for SWRR state, small UI
additions. No new deps. Biggest risk is UI sprawl — three strategy pickers must share
one options constant, and both large pages (1900+ lines) need a new small component,
not inline JSX.

## Existing Reusable Code

| What                                                                          | Where                                               | Reuse as-is?                          |
| ----------------------------------------------------------------------------- | --------------------------------------------------- | ------------------------------------- |
| `computeEffectiveWeight({manualWeight, provider, planTier, snapshot, model})` | `open-sse/services/quotaSnapshot.js:336`            | Yes — core weight math                |
| `getSnapshot(connectionId)`                                                   | `open-sse/services/quotaSnapshot.js:137`            | Yes, inject as `snapshotFn` for tests |
| `pickSmoothWeighted(candidates, currentWeights)`                              | `open-sse/services/weightedRoundRobin.js`           | Yes — stateless, caller owns `Map`    |
| `buildQuotaSnapshotView(connectionId, {manualWeight, model})`                 | `src/sse/services/quotaSnapshotSync.js:251`         | Yes — weight/share% display API       |
| `PLAN_CAPACITY`, `QUOTA_SNAPSHOT.floor`                                       | `open-sse/config/quotaSnapshot.js`                  | Yes — never duplicate values          |
| `weightedProviders` / `isWeightedProvider`                                    | `src/shared/services/weightedTargets.js`            | Yes — gating pattern                  |
| `sanitizePlanTier`                                                            | `open-sse/services/quotaSnapshot.js:236`            | Yes — backend only, no UI twin        |
| `Select`, `Toggle`, `Input`, `Card`                                           | `src/shared/components/`                            | Yes — `Select` fits strategy picker   |
| `saveStrategy` merge pattern                                                  | `ConnectionsCard.js:500`                            | Copy shape, not code                  |
| `resetComboRotation` on strategy change                                       | `src/app/api/settings/route.js`                     | Precedent: reset SWRR `Map` same way  |
| Test mock pattern (`vi.hoisted` + `vi.mock`)                                  | `tests/unit/antigravity-quota-routing.test.js:1-40` | Yes — template for new tests          |
| `pickMany` loop helper                                                        | `tests/unit/weighted-round-robin.test.js:5-14`      | Yes — distribution assertions         |

No `manualWeight` field exists anywhere yet. No validation of `providerStrategies`
exists — `PATCH /api/settings` passes body straight to `updateSettings`
(`src/lib/db/repos/settingsRepo.js:98`, wholesale merge). No plan-tier label
humanizer exists in UI (only `ProviderInfoCard.js` freeTier label; tier strings are
raw like `default_claude_max_5x`).

## Modularity Design

New: `src/sse/services/accountSelection.js` (~120 lines) exporting pure
`selectAccount(connections, opts)` plus module-scope `swrrState = new Map()` keyed by
provider and `_resetAccountSelection()` test helper. `auth.js` keeps DB writes and
proxy resolution; calls helper, persists returned `dbUpdates`.

Before: `getProviderCredentials` mixes fetch, strategy branch, `updateProviderConnection`.
After: fetch → `selectAccount` (pure) → persist → resolve proxy. One seam, three
strategies testable.

UI: new `StrategySelect.js` (~60 lines, wraps shared `Select` with
`STRATEGY_OPTIONS = fill-first/round-robin/weighted`) used in all three pickers.
New `WeightedAccountMeta.js` (~50 lines, weight input + share%) used in connection
edit + row display. Both under `dashboard/providers/components/`.

## KISS Assessment

- Move round-robin + fill-first into `accountSelection.js` too. Cost: ~45 moved lines.
  Payoff: required new tests get a seam; round-robin sticky logic is currently
  untestable inline (DB calls interleaved). Leaving it inline means testing through
  full `getProviderCredentials` mocks — heavier, not simpler.
- No separate SWRR state module. `pickSmoothWeighted` docs say caller owns the `Map`;
  one module-scope `Map` + reset-on-strategy-change (combo.js precedent) is enough.
  Separate module = interface with one implementation.
- Strategy picker in `profile/page.js` must change boolean Toggle → `Select`, but keep
  Toggle for combo strategy (unchanged scope). Don't redesign routing card.
- Share% denominator: effective weight (post-floor). One definition, no toggle.

## Abstraction vs. Repetition

- Extract: `STRATEGY_OPTIONS` label list (3 usages — meets rule of three).
- Extract: `WeightedAccountMeta` (edit input + row display = 2 usages, but same
  markup/behavior — justified shared component).
- Do NOT extract: tier-name humanizer (1 usage planned — local `formatTier` in the
  meta component, ~5 lines, promote only on third use). Do NOT extract generic
  "strategy saver" hook (two call sites differ: global vs per-provider merge).

## Interface Design

```js
selectAccount(connections, { strategy, stickyLimit, weights, snapshotFn, model });
// → { connection, dbUpdates: {lastUsedAt, consecutiveUseCount} | null, nextSwrr: Map }
```

Pure except injected `snapshotFn` (default `getSnapshot`). Weighted branch: build
`[{id, weight: computeEffectiveWeight(...)}]`, floor-zeroed candidates excluded,
all-below-floor falls back to fill-first (matches SWRR "policy belongs to caller").
`dbUpdates: null` for weighted (no `lastUsedAt` churn — SWRR state is the memory).
Settings validation: allowlist `fallbackStrategy ∈ {fill-first, round-robin, weighted}`,
coerce `stickyRoundRobinLimit` to int ≥ 1. Connection `manualWeight` rides inside
`providerSpecificData` (route merges wholesale, no backend change needed).

## Testability Patterns

- `tests/` is own package (`9router-tests`, vitest 5). Aliases: `@/` → `src`,
  `open-sse/` → `open-sse`. Setup isolates `DATA_DIR` per file (`tests/setup/`).
- Mock external seams with `vi.hoisted` + `vi.mock` (localDb, logger) per
  antigravity-quota-routing precedent; pass `snapshotFn` stub + fixed `weights`
  for deterministic weighted tests; reuse `pickMany` loop for distribution checks.
- Single test: `cd tests && npx vitest run unit/<name>.test.js`. Full gate:
  `npm test` from root (vitest JSON + `__baseline__/verify-no-regression.mjs` vs
  `known-fails.txt` — new tests always allowed, only pass→fail regressions block).

## Build vs. Depend

Nothing to depend on. Smooth-WRR, snapshot store, capacity tables all in-repo from
YAN-259 — reimplementing any is pure waste. No new npm package (a `Select` already
exists; a validation lib like zod for one enum is overkill — hand-check 3 lines).

## Open Questions

1. SWRR `Map` is in-memory: acceptable loss on restart (combo rotation precedent?) or
   persist `currentWeights` per provider in settings?
2. `manualWeight` storage: `providerSpecificData.manualWeight` (zero migration) vs
   top-level column (queryable, needs migration)?
3. Weight input lives in shared `EditConnectionModal.js` (336 lines, multi-provider)
   or only provider `[id]` edit form — which edit surface is canonical?
4. All-below-floor fallback: fill-first (priority) or round-robin (spread)? Pick one.
5. File sizes force new components: `ConnectionsCard.js` 742, `profile/page.js` 1907,
   `providers/[id]/page.js` 2014 lines (soft cap 500). Confirm no inline JSX added.
