# YAN-261 — Weighted Combo Strategy: Recommendations

Role: recommendations-agent. Scope: implementation approach/phasing, risks, alternatives, task breakdown, key decisions. Grounded in the YAN-261 brief and sibling research (codebase/API research, Linear YAN-261, GH #105).

## Executive Summary

Phase 1 (YAN-259) left deliberately complete seams: `pickSmoothWeighted` (open-sse/services/weightedRoundRobin.js:12), `getProviderHeadroom` fail-open semantics (open-sse/services/quotaSnapshot.js:303), the "best headroom across a provider's connections" model (quotaSnapshot.js:297-301), and a poller that already starts when a combo strategy is `"weighted"` (src/shared/services/quotaSnapshotPoller.js:172-182). Phase 3 is therefore mostly wiring: one DRY resolver, one `getWeightedModels` sibling of `getRotatedModels` (open-sse/services/combo.js:218), settings validation, and a weights editor in ComboCard. Highest risks are **not** the algorithm — they are boundary interactions: `reorderByCapabilities` overriding the weighted pick (combo.js:339-351), the duplicate nested-combo path in chat.js:208-270, rename leaving `comboStrategies` keyed by the old name (src/app/api/combos/[id]/route.js:71-79 resets rotation but never migrates settings), and headroom lookup needing live DB access inside request handlers.

## Implementation Recommendations

### 1. Strategy resolver (DRY, scope item 1)

- Put `resolveComboStrategy(settings, comboName)` in `src/shared/services/weightedTargets.js` (or a new `comboStrategy.js` beside it) — it is the existing neutral module both dashboard and open-sse-adjacent code already import without cycles (weightedTargets.js:1-2). Return `{ strategy, stickyLimit, weights, judgeModel, fusionTuning }` with defaults `{strategy:"fallback", stickyLimit: settings.comboStickyRoundRobinLimit, weights:{}}`.
- Replace the 7 copy-pasted sites: src/sse/handlers/chat.js:111-113 and 220-222, fetch.js:95-97, search.js:75-77, tts.js:57-59, imageGeneration.js:52-54. Pattern everywhere is `comboStrategies[name]?.fallbackStrategy || settings.comboStrategy || "fallback"` — mechanical swap.
- Keep `weightedTargets.comboIsWeighted` (weightedTargets.js:8-11) and reimplement it on top of the resolver so poller gating and request routing can never disagree on what "weighted" means.

### 2. `getWeightedModels` in combo.js

- Sibling of `getRotatedModels` (combo.js:218-248), same state-map idiom (`comboRotationState`, combo.js:95). Recommended state shape per combo: `{ currentWeights: Map, lastPick: string|null, consecutiveUseCount: number }`.
- Per pick: build candidates from effective weight `(weights[model] ?? 1) × headroom(provider, model)`; feed `pickSmoothWeighted`. Honor sticky: if `lastPick` still has count < stickyLimit and its effective weight > 0, keep it; else re-pick. Weight 0 = never head (stays in tail); all-zero → return models unchanged (plain fallback order, matches brief acceptance).
- `resetComboRotation` (combo.js:254-257) must clear weighted state too — same map or a second map cleared in the same function; every existing caller (settings PATCH route.js:98-104, combos [id] route.js:78-79,99) then resets both for free. **Do not** add a separate reset entry point.
- Async seam: `getProviderHeadroom` needs connection IDs, which live in the dashboard DB (`getProviderConnections({provider, isActive:true})`, src/sse/services/auth.js:100). open-sse must stay DB-free. Recommended: `handleComboChat` gains an optional `resolveHeadroom` injectable; when strategy is "weighted" and no resolver is provided, log once and fall back to plain fallback order (fail-open, mirrors "unknown = headroom 1" philosophy at quotaSnapshot.js:320). Dashboard handlers inject a resolver backed by one `getProviderConnections()` call per request (fetch all, group by provider in JS — the repo has no bulk per-provider API; connectionsRepo.js:122-139 is sync better-sqlite3 so a second option, one filtered query per distinct provider, is also cheap, but the unfiltered single call is fewer queries and simpler).

### 3. Wire order inside `handleComboChat`

Current order (combo.js:339-351): rotate → auto-switch (`reorderByCapabilities`) → fallback loop. Keep weighted in the same slot as rotation, **before** capability reorder. Consequence to document: a request needing vision reorders the head — this is intentional (hard caps must win, combo.js:10-12) but means the weighted distribution only holds for capability-neutral traffic. Acceptance-test distribution runs must use text-only requests.

- chat.js:114-118 / 224-228 `augmentModelsWithCapacityAdapter` can inject adapter models not in `combo.models`; they get default weight 1, which is correct (they should be pickable), but exclude them from the UI weights editor or they will look editable-yet-unsavable.

### 4. Validation at trust boundary (scope item 6)

- src/app/api/settings/route.js PATCH currently validates nothing about strategy values. Add a whitelist check before `updateSettings(body)` (route.js:86): `fallbackStrategy ∈ {fallback, round-robin, fusion, weighted}`; `weights` values finite numbers ≥ 0 (reject NaN/Infinity/negative — `pickSmoothWeighted` already skips non-finite, weightedRoundRobin.js:31, but silently persisting garbage config is worse than a 400). Keep it small: a `validateComboStrategies` helper in the route file or beside the resolver.
- Constants live in `open-sse/config/` per open-sse/AGENTS.md — a `COMBO_STRATEGIES` enum there (or reuse wherever `STRATEGY_OPTIONS` values are defined) shared by validator + UI avoids a third hardcoded list (UI's is combos/page.js:343-347).

### 5. UI (scope item 4)

- Add `{ value: "weighted", label: "Weighted — by weight & remaining quota" }` to STRATEGY_OPTIONS (combos/page.js:343-347); `handleSetComboStrategy` (page.js:196-217) already persists arbitrary patches into `comboStrategies[name]`, so weights ride the same channel — keep its prune behavior (empty patch → delete entry).
- ComboCard (page.js:349+): when `current === "weighted"`, render a small numeric input per model mirroring the fusion judge-picker pattern (page.js:392-416). Default display value 1.
- Share-% preview data source: compute client-side from `/api/settings` + `/api/usage/[connectionId]`'s existing `quotaSnapshot.effectiveWeight` (src/app/api/usage/[connectionId]/route.js:214, src/sse/services/quotaSnapshotSync.js:251-275). Cheapest correct option: expose provider headroom via a tiny read-only endpoint (e.g. extend the usage route or a `/api/quota/headroom?provider=`) that calls `getProviderHeadroom`; UI then computes shares with the exact same formula the router uses. **Do not** reimplement headroom math in the browser.

### 6. Rename migration (brief flags this; confirmed broken)

- comboStrategies is keyed by combo **name**; PUT /api/combos/[id] renames the combo and resets rotation (route.js:78-79) but never moves the settings entry — renamed combo silently reverts to global strategy and the old entry leaks forever (also breaks poller gating via weightedTargets.js:9). Fix inside the same PUT handler: when `body.name !== prev.name`, read settings, move `comboStrategies[prev.name]` → `comboStrategies[newName]`, PATCH/persist once. Also drop stale `weights` keys for models no longer in the combo (membership edits already validate cycles but never prune weights).

### 7. Media combos (scope item 5)

- Handlers tts.js, imageGeneration.js, fetch.js, search.js all call the same `handleComboChat`, so weighted works there the moment the resolver returns "weighted" — the only work is UI: media combo page (media-providers/combo/[id]/page.js:176-188) hardcodes a round-robin toggle and **deletes the whole comboStrategies entry** when toggled off, which would silently wipe weights if a chat combo name collides. Recommendation (see Key Decisions): v1 = engine support yes, media UI no — but fix the toggle to preserve other keys in the entry.

## Improvement Ideas

- **Sticky default**: `comboStickyRoundRobinLimit` default is 1 (settingsRepo.js:18); smooth WRR with sticky 1 already approximates the target distribution tightly (nginx algorithm), so no new sticky setting is needed — reuse the existing one.
- **Weight input UX**: slider or number input with a computed "≈ X%" label per model (sum-normalized), plus a muted note when headroom is unknown (=1, fail-open) so users aren't confused why shares match raw weights.
- **Observability**: extend the existing `log.info("COMBO", ...)` line with `pick=<model> w=<eff>` when weighted — the combo logs are already the debugging surface (combo.js:359).
- **Floor semantics**: `computeEffectiveWeight` has a `floor` (default 0.05, config/quotaSnapshot.js:8) that zeroes weight below it. Decide whether combo weighting uses raw `headroom` scaling (brief: "only scales weight down") or the floor; recommend raw scaling for combos and leave floor to provider-level phase 2, to match acceptance numbers (A headroom 0.2 → 37.5% requires no floor cutoff).

## Risk Assessment

| Risk                                                                                    | Severity                          | Mitigation                                                                                                                                                                                                                                                                                                                      |
| --------------------------------------------------------------------------------------- | --------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Behaviour regression for fallback/round-robin/fusion                                    | High blast radius, low likelihood | Resolver must return byte-identical defaults for non-weighted combos; gate new code on `strategy === "weighted"` only; run combo-routing / combo-fusion / combo-cycles-errors / combo-autoswitch tests + tests/**baseline**/verify-no-regression.mjs                                                                            |
| `reorderByCapabilities` overrides weighted pick on media requests                       | Medium                            | Documented order (rotate→reorder, combo.js:339-351); add an autoswitch test asserting weighted combos still float vision-capable models to head                                                                                                                                                                                 |
| Stale weighted state (rename, model removal, strategy switch)                           | Medium                            | Single map cleared by existing `resetComboRotation`; fix rename migration (route.js:71-79); key state by combo name exactly as round-robin does                                                                                                                                                                                 |
| Headroom lookup cost per request                                                        | Low                               | One unfiltered `getProviderConnections()` per weighted request; better-sqlite3 sync, trivial. Snapshot reads are in-memory Map (quotaSnapshot.js:4). If it ever shows in profiles, cache connection IDs per provider with the same invalidation hook as `resetComboRotation`.                                                   |
| Nested combos (combo member = another combo)                                            | Medium                            | Nested path re-resolves strategy at chat.js:208-270 — inner combo may be weighted while outer isn't (and vice versa). Weights keyed by member string; a nested combo name has no "/" so its "provider" lookup yields nothing → headroom 1, weight default 1: acceptable, test it. Cycle guard already exists (chat.js:212-216). |
| Duplicate code path drift (chat.js has two combo blocks)                                | Medium                            | chat.js:107-158 (top-level) and 208-270 (nested `handleSingleModelChat`) are near-copies; resolver helper collapses both — do the DRY refactor first so weighted logic lands in exactly one place per concern                                                                                                                   |
| `pickSmoothWeighted` swallows errors, returns `{id:null}` (weightedRoundRobin.js:48-50) | Low                               | `getWeightedModels` must treat null pick as "return models unchanged" (fallback order) — never crash the request path                                                                                                                                                                                                           |
| Retry-After / failover regression                                                       | Low if untouched                  | Do not modify the fallback loop (combo.js:357-453); weighted only reorders head, tail stays original order, so combo-cycles-errors.test.js semantics hold                                                                                                                                                                       |
| Poller/UI disagree on "weighted"                                                        | Low                               | Both must go through the same resolver (rec. 1)                                                                                                                                                                                                                                                                                 |

## Alternative Approaches

1. **Status quo per-handler inline logic** (no resolver): rejected — 7 duplicated sites already drifted (chat.js resolves twice); every new strategy multiplies the mess.
2. **Extend `getRotatedModels` with strategy branch** instead of new `getWeightedModels`: viable, smaller diff, but mixes sync round-robin with async headroom needs; the resolver-injection seam argues for a separate function. Either is defensible; brief explicitly says sibling function — follow it.
3. **Server-computed share preview endpoint** (`/api/combos/[id]/weighted-preview`): more accurate (same code path), one extra route; vs client-computed from headroom endpoint: fewer moving parts, tiny formula duplication risk. Recommend server endpoint only if client preview drifts in review; start client-side.
4. **Persist weighted state** (survive restarts): rejected for v1 — round-robin state is already in-memory only (combo.js:95); smooth WRR reconverges within N requests; persistence is unrequested scope.
5. **Weight 0 = excluded entirely vs fallback-only**: brief picks fallback-only (stays in tail, never head). Matches pickSmoothWeighted's `weight <= 0` skip (weightedRoundRobin.js:31) — no code needed for exclusion, just ordering. Keep brief semantics.

## Task Breakdown Preview

Ordered; each task independently testable. `→` = depends on.

1. **Resolver helper** `resolveComboStrategy` + refactor 7 call sites + unit tests. (No deps.)
2. **Settings PATCH validation** (strategy whitelist, weights shape) + tests. (No deps; do early to protect all later writes.)
3. **Rename migration** in PUT /api/combos/[id] + weight-key pruning on membership change + tests. (→ 1 for shared strategy-key logic.)
4. **`getWeightedModels`** + state map + sticky + `resetComboRotation` coverage + unit tests (distribution 75%±2, headroom scaling 37.5%, weight-0, all-zero, stickiness, reset). (→ 1.)
5. **Headroom resolver injection** into `handleComboChat` + dashboard wiring (`getProviderConnections` grouping, `parseModel` alias skip as in weightedTargets.js:25-27). (→ 4.)
6. **Wire chat.js top-level + nested paths; fetch/search/tts/imageGeneration opt-in via resolver**; autoswitch-order test. (→ 5.)
7. **UI**: STRATEGY_OPTIONS entry, per-model weight inputs in ComboCard, share-% preview, weighted explainer line in the header list (page.js:236-249). (→ 2 for server validation; → 5 for preview data source.)
8. **Media combo decision + toggle-preserves-entry fix** (media-providers/combo/[id]/page.js:176-188). (→ 7 pattern.)
9. **Regression gate**: full vitest + tests/**baseline**/verify-no-regression.mjs; distribution acceptance run. (→ all.)

## Key Decisions Needed

1. **Media combos: support or exclude?** Engine gets support for free via shared `handleComboChat`. Options: (a) support silently (media UI just can't edit weights — global `comboStrategy:"weighted"` would still affect them); (b) explicitly exclude in resolver by combo `kind`; (c) full UI support. Recommend (a) + fix the destructive round-robin toggle, document in feature spec. **Needs owner call.**
2. **Share-% preview data source**: client-side from a headroom read endpoint vs dedicated server preview endpoint. Recommend client-side first (reuses quotaSnapshotSync view), server endpoint as fallback. **Needs owner call.**
3. **Floor semantics for combos**: raw `weight × headroom` (matches acceptance math) vs `computeEffectiveWeight` with 0.05 floor. Recommend raw for combos. **Confirm against YAN-259 phase-2 intent** (config/quotaSnapshot.js:3-4 explicitly defers floor semantics to phase 2).
4. **Nested weighted combos**: allow inner-combo weighted resolution (current architecture naturally does) or restrict weighted to leaf members? Recommend allow, document weight-default-1 behavior for combo-name members.

## Open Questions

- Should `comboStrategy: "weighted"` **global** default be allowed (poller already supports it, quotaSnapshotPoller.js:177)? If yes, every combo without a per-combo entry gets weightless (all-1) weighting — is that desirable or should global weighted require per-combo weights?
- Sticky limit is global (`comboStickyRoundRobinLimit`); do weighted combos need a per-combo sticky override in `comboStrategies[name]`? v1: no.
- Where does the `COMBO_STRATEGIES` whitelist constant live so open-sse config rules (no hardcode, open-sse/AGENTS.md) and the dashboard both see it without a cycle? Candidate: `open-sse/config/` export imported by settings route + UI constants module.
- Distribution acceptance test (1000 requests, ±2%): run as a unit test with deterministic seeded sequence (smooth WRR is deterministic — exact counts assertable, no flake) or as a statistical test? Deterministic exact-count assertions recommended; smooth WRR gives exact proportions over full cycles.
