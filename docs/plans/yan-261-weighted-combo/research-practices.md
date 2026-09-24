# YAN-261 practices research

## Executive Summary

- Resolver duplication real: 7 sites (`src/sse/handlers/chat.js:111-113,208-270`, `fetch.js:95-109`, `search.js:75-89`, `tts.js:57-71`, `imageGeneration.js:52-67`). Extract `resolveComboStrategy`. Rule-of-three passed.
- All primitives exist: `pickSmoothWeighted` (`open-sse/services/weightedRoundRobin.js:12`), `getProviderHeadroom` (`open-sse/services/quotaSnapshot.js:303`), `normalizeStickyLimit` + `comboRotationState` (`open-sse/services/combo.js:95,196`), `weightedTargets.js`, `parseModel` (`open-sse/services/model.js:34`). No new dep.
- New logic goes in **new small files**, not `combo.js` (731 lines) or `combos/page.js` (958 lines). Both past ~500 soft cap.
- `resolveComboStrategy` must be pure + live in `open-sse/` so both sides import without cycle. `headroomFn` injected for testability. `comboIsWeighted` should reuse resolver.

## Existing Reusable Code

- `pickSmoothWeighted(candidates[{id,weight}], currentWeights)->{id,currentWeights}` (`weightedRoundRobin.js:12-51`): nginx smooth WRR, skips non-finite/`<=0`, prunes stale ids, never throws, never mutates input. Use directly. Do not wrap with new algorithm.
- `getProviderHeadroom(provider, connectionIds, model)` (`quotaSnapshot.js:303-333`): best headroom across connections, unknown=1 fail-open, never throws. Exact scaling input needed. Do not re-read snapshot store directly.
- `normalizeStickyLimit` (`combo.js:196-199`): `parseInt>0 else 1`. Reuse for weighted sticky. Not exported; export it.
- `comboRotationState` (`combo.js:95`): `Map<key,{index,consecutiveUseCount}>`, keyed `comboName||"__default__"`, note legacy numeric-state compat (`combo.js:226-229`). New weighted SWRR state needs **separate** `Map` (shape differs: `{currentWeights:Map,lastPick,consecutiveUseCount}`); share key scheme only. `resetComboRotation` (`combo.js:254-257`) must clear both.
- `getRotatedModels` (`combo.js:218-248`): pattern to mirror — early return for `length<=1`/wrong strategy, sticky counting, pure ordering. `getWeightedModels` sibling, same shape.
- `parseModel` (`model.js:34-55`): `"provider/model"` split + alias resolve. Use to derive provider from combo member string before headroom lookup. Already precedent in `weightedTargets.js:25`.
- `weightedTargets.js` (44 lines): `weightedProviders(settings,combos)` + `isWeightedProvider` with DI default `{getSettings,getCombos}`. Poller already gates on it (`quotaSnapshotPoller.js:configureQuotaSnapshotPoller`). Private `comboIsWeighted` (`weightedTargets.js:8-11`) duplicates resolution string — replace with resolver import.
- `computeEffectiveWeight` (`quotaSnapshot.js:336+`): base×headroom with floor. **Do not use** at combo level — brief mandates combo level uses user weights only, headroom scales down. Different policy, same inputs.
- Validation precedent: almost none. `settings/route.js` PATCH validates nothing except password/OIDC; only models are `VALID_NAME_REGEX` + `isModelList` in `combos/[id]/route.js:6,38,52`. New whitelist/weights checks follow that inline-400 style.
- DI precedent: `runQuotaSnapshotTick(deps,state)` (`quotaSnapshotPoller.js:122`), `isWeightedProvider(provider,deps)`. Copy for headroom injection.
- UI precedent: `handleSetComboStrategy(comboName,patch)` prune-on-default (`combos/page.js:196-217`), `STRATEGY_OPTIONS` (`:343-347`), judge picker conditional block (`:393-417`). Extend, don't restructure.

## Modularity Design

- Home for `resolveComboStrategy(settings,comboName)->{strategy,stickyLimit,weights,judgeModel,fusionTuning}`: new pure module `open-sse/services/comboStrategy.js` (~70 lines). Re-export from `combo.js` to keep existing imports stable.
- Why not `src/shared/...`: direction wrong. `src/sse/handlers/*` already import `open-sse/services/combo.js`; `open-sse/services/*` never import `@/*` (only `open-sse/handlers/chatCore.js` touches `@/lib/usageDb.js`, services stay clean). Pure resolver in `open-sse/` importable both sides, zero cycle. `weightedTargets.js` (app side) imports resolver upward — allowed.
- Why not inside `combo.js`: file 731 lines, over cap; resolver + weighted picker + state ≈150 lines would push ~900. New files:
  - `open-sse/services/comboStrategy.js`: `COMBO_STRATEGIES` const, `resolveComboStrategy`, export `normalizeStickyLimit` (move, re-export from combo.js).
  - `open-sse/services/comboWeighted.js`: weighted state Map + `getWeightedModels` + `resetComboWeightedState`. `combo.js` imports both; `resetComboRotation` also clears weighted map (or routes call through).
  - `src/sse/services/comboHeadroom.js` (new, ~40 lines): `buildComboHeadroomFn({getProviderConnections})` returning `async (modelStr)=>number`. Reason: `combo.js` cannot touch app DB; all 5 handlers need same closure. One builder kills 5x duplication without polluting `open-sse/`.
  - UI: `combos/_components/WeightedWeightsEditor.js` + pure `src/shared/services/comboWeightShare.js` (`sharePreview(weights,headrooms)->{model:pct}`).
- `handleComboChat` wiring: add opts `{weights, headroomFn}`; `if strategy==="weighted"` delegate to `getWeightedModels`, else existing path. Fusion untouched.
- Before:
  `chat.js:111-113` + `fetch.js:96-97` + `search.js:76-77` + `tts.js:58-59` + `image.js:53-54` each inline `comboStrategies[name]?.fallbackStrategy || settings.comboStrategy || "fallback"`.
- After:
  `const {strategy,stickyLimit,weights,judgeModel} = resolveComboStrategy(settings, modelStr)` — one line per site, fusion branch reads `strategy`/`judgeModel`.

## KISS Assessment

- Risk 1: live "≈share %" preview. Browser has no snapshot store; live headroom needs usage-API fetch per model. Simpler: static share from weights (`w/sum`), optional headroom prop when already loaded, degrade to weights-only on unknown. No new endpoint, no poller in browser.
- Risk 2: sticky×SWRR reimplementation. Keep sticky outside `pickSmoothWeighted` (its docstring says callers own stickiness). Wrapper holds `lastPick+count`; if `count<stickyLimit` return same head, skip SWRR call. Mirrors `getRotatedModels` counting.
- Risk 3: weight normalization framework. Skip. `weights[m] ?? 1`, finite/`>=0` else 1 at read time; `0`=fallback-only; all-zero→return original order without calling SWRR. Validation at PATCH boundary rejects garbage; runtime stays fail-open.
- Risk 4: rename migration framework. `comboStrategies` keyed by NAME; `combos/[id]/route.js:71-79` updates combo + resets rotation but never migrates settings entry — rename orphans weights/strategy. Minimal fix: in same PUT, if `body.name` changed, move `settings.comboStrategies[prev.name]` key. ~10 lines, no new service.
- Risk 5: media combos support. `media-providers/combo/[id]/page.js:97,180-186` only toggles round-robin. Explicit exclusion + one-line doc comment cheaper than wiring weighted+headroom through media path. Decide exclusion.

## Abstraction vs. Repetition

- Extract (≥3 sites): `resolveComboStrategy` (7 sites) — yes. Headroom closure builder (5 handlers) — yes, one `buildComboHeadroomFn`.
- Reuse, don't extract: `normalizeStickyLimit` — export existing, no rewrite. Share-% math — pure 10-line helper, tested once, used by editor + tooltip.
- Leave duplicated: per-handler `handleComboChat({...})` call shapes differ (fusion judge, capacity-adapter wrapping in chat.js) — do not unify callers. Weight `<input>` markup appears once — no generic field component.
- Do not abstract: validation framework, strategy registry, weighted-state class. Single Map + functions suffice.

## Interface Design

```js
// open-sse/services/comboStrategy.js
export const COMBO_STRATEGIES = ["fallback","round-robin","fusion","weighted"];
export function resolveComboStrategy(settings, comboName)
// -> { strategy, stickyLimit, weights, judgeModel, fusionTuning }
// strategy: allowlisted else "fallback". stickyLimit: normalizeStickyLimit(settings.comboStickyRoundRobinLimit).
// weights: settings.comboStrategies[name]?.weights ?? {}. Never throws.

// open-sse/services/comboWeighted.js
export function getWeightedModels(models, comboName, weights={}, headroomFn=()=>1, stickyLimit=1)
// -> [pick, ...rest-original-order]. headroomFn(modelStr)->number|Promise<number>? Sync only;
// handlers resolve headroom before call (keeps combo.js sync like getRotatedModels).
export function resetComboWeightedState(comboName?) // omit clears all
```

- `handleComboChat` gains `{ weights={}, headroomFn }` opts, default `()=>1` keeps existing tests green without fixtures.
- `weightedTargets.js`: delete private `comboIsWeighted`, `import {resolveComboStrategy} from "open-sse/services/comboStrategy.js"`, `comboIsWeighted = (c,s)=>resolveComboStrategy(s,c?.name).strategy==="weighted"`. Single semantics source.
- Validation (`settings/route.js` PATCH, before `updateSettings`): `fallbackStrategy` ∈ whitelist, `comboStrategy` ∈ whitelist, `weights` values finite `>=0` else 400. Reuse `COMBO_STRATEGIES` import — app→open-sse import already established.

## Testability Patterns

- Inject `headroomFn`: distribution test passes `()=>1`, scaling test `(m)=>m==="A"?0.2:1`, unknown `()=>1`, all-zero weights. No DB/snapshot fixtures for routing math. Precedent: poller `deps` injection.
- Keep `getWeightedModels` sync + deterministic given `headroomFn` + cleared state; statistical test (1000 picks ±2%) seeds state via `resetComboWeightedState(name)` in `beforeEach`, same as `combo-routing.test.js:7` pattern.
- Pure helpers tested without React: `resolveComboStrategy` (fallback chain, bad strategy→fallback, sticky parse), `sharePreview` (3:1→75/25, zero-sum→equal/fallback order).
- Existing suites stay green: `combo-routing`, `combo-fusion`, `combo-autoswitch`, `combo-cycles-errors`, `weighted-round-robin`, `quota-snapshot` — run `tests/__baseline__/verify-no-regression.mjs`.
- One runnable check per new module; no new framework.

## Build vs. Depend

- No new dependency. SWRR, headroom, parse, state all in-repo. UI needs numeric input + % label — native input + existing `Select`/`Card`, no chart lib for preview (text % suffices).
- `computeEffectiveWeight` deliberately not reused (plan-tier policy differs from combo user-weight policy). `getProviderHeadroom` reused as-is.

## Open Questions

1. Media combos: exclude weighted (recommended) or support? Exclusion needs one doc line; support needs headroom wiring through media handlers.
2. Rename migration: confirm `combos/[id]` PUT should move `comboStrategies[oldName]` entry (recommend yes, ~10 lines).
3. Sticky semantics for weighted: repeat same head pick (recommended, mirrors round-robin) vs freeze full SWRR state — confirm former.
4. `headroomFn` sync vs async: recommend sync (handlers pre-resolve via `getProviderHeadroom` + `getProviderConnections({provider,isActive:true})` per member); async would force `handleComboChat` async-state changes.
5. Share-% preview data source in browser: weights-only fallback acceptable when headroom unknown? Recommend yes.
