# Combo zero-quota skip — practices research

## 1. Existing Reusable Code

Do not build new quota plumbing. YAN-259/260/261 already shipped it:

| File                                                                                                                                                                                                                                         | Reuse                                                                                                            |
| -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------- |
| `open-sse/services/quotaSnapshot.js` — `getSnapshot(connectionId)`, `getProviderHeadroom(provider, connectionIds, model)`, `computeEffectiveWeight(...)`, window expiry predicate (`resetsAt <= now ⇒ drop`), `toUsedFraction` clamp `[0,1]` | Eligibility check reads these. No direct `Map` access from callers.                                              |
| `open-sse/services/weightedRoundRobin.js` — `pickSmoothWeighted`                                                                                                                                                                             | Unchanged. Skip-filter runs before pick, not inside it.                                                          |
| `open-sse/services/comboStrategy.js` — `resolveComboStrategy`, `COMBO_STRATEGIES`                                                                                                                                                            | Single strategy source; skip logic branches on resolved strategy, never re-parses settings.                      |
| `open-sse/services/combo.js` — `getRotatedModels`, `comboRotationState`, `resetComboRotation` / `comboWeighted.js` — `getWeightedModels`                                                                                                     | Filter member list before rotation/weighting, not inside each.                                                   |
| `src/sse/services/accountSelection.js` — `selectAccount(..., {snapshotFn})`                                                                                                                                                                  | Account-level skip reuses injected `snapshotFn`; weighted all-below-floor ⇒ fill-first precedent applies.        |
| `src/sse/services/comboHeadroom.js` — `buildComboHeadroomFn({getProviderConnections})`                                                                                                                                                       | Precedent for app-side closure: open-sse stays pure/sync, src/ resolves connections. Copy shape.                 |
| `open-sse/services/accountFallback.js`                                                                                                                                                                                                       | Runtime fallback stays as-is (error-path safety net). Skip is pre-filter only; never remove post-error fallback. |
| `src/sse/services/antigravityQuota.js` strike-breaker                                                                                                                                                                                        | Untouched. Zero-quota skip ≠ strike block; both filters compose (skip first, strikes still apply on failure).    |

Confirmed absent (expected net-new, small): a shared `isKnownExhausted` predicate. Everything else exists.

## 2. Modularity Findings

Layering constraint: `open-sse/services/*` never import `@/*` (app DB). Only `chatCore.js` touches app usage DB. Keep it:

- **Predicate lives in open-sse** (provider-neutral, pure, sync): e.g. `isSnapshotExhausted(snapshot, opts)` next to `computeEffectiveWeight` in `quotaSnapshot.js`. Takes snapshot as arg, no `Map` access. Testable without DB.
- **Connection resolution lives in src/**: thin closure like `comboHeadroom.js` maps combo member string → `connectionIds` → `getProviderHeadroom` / `getSnapshot`. `open-sse` receives numbers, never connections.
- **One filter point per layer**, not per strategy:
  - Combo: filter member list once at top of `handleComboChat` (after `resolveComboStrategy`), before `fallback`/`round-robin`/`weighted`/`fusion` branch. All strategies inherit skip.
  - Accounts: filter inside `selectAccount` before strategy branch (same position as floor-zero exclusion in YAN-260).
- Before: each strategy iterates full member list, may call known-zero provider.
- After: `eligibleMembers = members.filter(notKnownZero)` → existing strategy code unchanged → if empty, fall through to original list (fail-open, preserves current behavior exactly).
- Do NOT put skip inside `pickSmoothWeighted` (docstring: policy belongs to caller), inside executors, or inside `chatCore.js` hook (ingest path, not routing path).

## 3. KISS Assessment

| Decision             | Simple                                                                                                                                                                 | Rejected overkill                        |
| -------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------- |
| Exhausted definition | `min(1-usedFraction) <= floor` over long windows (`5h`,`7d`,`day`,`month`,`model:*`); ignore short-lived `requests`/`tokens` windows (expire in seconds, cause bounce) | Per-provider zero subclasses, config DSL |
| Unknown handling     | `null`/no-live-windows ⇒ eligible (fail-open). One `if`                                                                                                                | Retry queue, backoff scheduler           |
| All-exhausted        | Use original unfiltered order (same as YAN-260 all-below-floor ⇒ fill-first). Zero behavior change in worst case                                                       | Error out, return 429 to client          |
| Floor value          | Reuse `QUOTA_SNAPSHOT.floor` (0.05) — already accepted damage limit                                                                                                    | New threshold config                     |
| State                | No new `Map`, no persistence. Snapshot store is the state                                                                                                              | Second cache, DB column, migration       |

## 4. Abstraction Recommendations

- **Extract (5 call sites: 4 combo strategies + account selection — passes rule of three)**: one `isSnapshotExhausted(snapshot)` + one list-filter helper. ~20 lines total.
- **Reuse, don't wrap**: `getProviderHeadroom` (combo level: best headroom across provider connections), `getSnapshot` (account level), `normalizeStickyLimit`, `parseModel` for member→provider.
- **Leave duplicated**: per-handler `handleComboChat({...})` call shapes (fusion judge, capacity adapter) — do not unify callers (YAN-261 precedent).
- **Do NOT abstract**: per-provider "zero" semantics into classes (one clamp + kind allowlist covers all), validation framework (inline-400 at PATCH boundary per `combos/[id]` precedent), generic eligibility registry.

## 5. Interface Design

```js
// open-sse/services/quotaSnapshot.js (add, ~20 lines)
// Pure. Never throws. Unknown ⇒ false (eligible).
isSnapshotExhausted(snapshot, { kinds = LONG_WINDOW_KINDS, floor = QUOTA_SNAPSHOT.floor } = {}) → boolean
```

Rules matching repo norms:

- Fail-open: malformed snapshot ⇒ `false`. No throw (RTK convention).
- Finite-check + clamp at ingest already guarantee `usedFraction ∈ [0,1]`; predicate only reads.
- `kinds` allowlist as plain array const in same file (5 values, no enum module).
- Combo wiring: `handleComboChat` gains nothing new if `headroomFn` already injected (YAN-261) — filter via existing `headroomFn(modelStr) <= floor`. If account-level needs snapshot detail, use injected `snapshotFn`.
- `resetComboRotation` unchanged (no new state to clear).

## 6. Testability

Restricted to critical paths (no new framework, one runnable check per new function):

1. **Pure predicate** (`tests/unit/quota-snapshot*.test.js` extend): exhausted 5h (`usedFraction 1`) ⇒ `true`; `0.5` ⇒ `false`; `null`/empty/expired-windows ⇒ `false` (fail-open); short `requests` window at 1 ⇒ `false` (ignored kind); malformed (`NaN`, missing) ⇒ `false`.
2. **Combo filter**: `getWeightedModels`/`handleComboChat` with stub `headroomFn` — zero member skipped, order preserved for rest; all-zero ⇒ original order (no behavior change). Reuse `pickMany` loop helper + `resetComboWeightedState` in `beforeEach` (YAN-261 pattern).
3. **Account filter**: `selectAccount` with stub `snapshotFn` — zero account excluded; all-zero ⇒ fill-first fallback.
4. **Regression gate**: `combo-routing`, `combo-fusion`, `combo-autoswitch`, `quota-snapshot`, `antigravity-quota-routing`, `weighted-round-robin` stay green; `tests/__baseline__/verify-no-regression.mjs` passes (pass→fail blocks, new tests always allowed).

## 7. Build vs. Depend

Build. Zero new dependencies:

- Numbers come from in-repo snapshot store (`Headers` parsing already done at ingest).
- No scheduler (poller exists), no cache lib (Map precedent ×3), no validation lib (`Number.isFinite` inline precedent), no UI lib (no UI change — routing-only fix).

Skipped: per-member skip reasons in API response, dashboard surfacing, DB persistence of skip events. Add when operators ask why a member was skipped (visibility route already exposes `quotaSnapshot`; a `skipped: true` flag there is the upgrade path — `ponytail` ceiling).

## Open questions (for plan, not research)

1. Fusion strategy: skip applies to member shortlist, judge model never skipped — confirm.
2. Media-combo handlers (`fetch/search/tts/image`): same filter via shared helper, or chat-only scope? 7-site `resolveComboStrategy` precedent suggests all, but media path was excluded for weighted in YAN-261.
3. Short-window kinds (`requests`/`tokens`/`input-tokens`/`output-tokens`) excluded from zero definition — confirm, else rate-limit spikes flap routing.
