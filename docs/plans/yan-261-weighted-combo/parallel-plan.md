# YAN-261 parallel plan: weighted combo strategy + per-model weights editor

Research: `research-*.md`, design: `feature-spec.md`. Phase 3 of YAN-258 (GitHub #105). This plan adds combo-level `weighted`. It builds on `pickSmoothWeighted` and `getProviderHeadroom` from YAN-259.

## Design contract (all tasks)

- **`open-sse/services/comboStrategy.js`** (new, pure, no imports from `src`):
  - `COMBO_STRATEGIES = ["fallback","round-robin","fusion","weighted"]`.
  - `resolveComboStrategy(settings, comboName)` returns `{ strategy, stickyLimit, weights, judgeModel, fusionTuning }`. Read it with `Object.hasOwn` so `__proto__` never resolves through the prototype chain. An unknown stored strategy becomes `"fallback"`. `weights` is `{}` unless it is a plain object.
  - `validateComboStrategySettings(body)` returns an error string or `null`. It checks `comboStrategy` when present (enum) and `comboStrategies` when present: plain object, no blocked keys (`__proto__`, `constructor`, `prototype`), each entry a plain object, `fallbackStrategy` in the enum if present, and `weights` if present a plain object with at most 200 keys, no blocked keys, and every value `typeof number`, finite, and between 0 and 1000.
- **`getWeightedModels(models, comboName, weights, headroomFn, stickyLimit = 1)`** in `open-sse/services/combo.js`:
  - Uses a separate map, `comboWeightedState`: `name → { currentWeights: Map, stickyId, count }`.
  - Candidates: first occurrence of each model, with `base = finite weights[m] ≥ 0 ? weights[m] : 1` and `headroom = headroomFn?.(m)`. The headroom is used only when it is a finite number ≥ 0; otherwise, or if `headroomFn` throws, it is 1. `weight = base × headroom`, and models with weight ≤ 0 are excluded.
  - With no candidates, return `models` unchanged and write no state.
  - Sticky: while `count < normalizeStickyLimit(stickyLimit)` and `stickyId` is still a candidate, reuse it (`count++`) without calling `pickSmoothWeighted`. Otherwise run a new SWRR draw, store the new `currentWeights`, and set `count = 1`.
  - Return `[pick, ...models without the first occurrence of pick]`.
  - `resetComboRotation(name?)` clears both maps.
  - `handleComboChat` accepts `comboWeights` and `headroomFn`, and calls `getWeightedModels` only when `comboStrategy === "weighted"`. Everything else is unchanged.
- **`src/sse/services/comboHeadroom.js`** (new): `loadComboHeadroomFn(models)` returns a synchronous memoized `(m) => number`.
  - It makes one `getProviderConnections({ isActive: true })` call and builds a `provider → ids` map.
  - For `m` with a `/`, it uses `parseModel(m)` from `@/sse/services/model.js` and calls `getProviderHeadroom(provider, ids, model)`.
  - For `m` without a `/` whose provider IDs exist in the map (fetch/search members), it calls `getProviderHeadroom(m, ids, null)`.
  - Anything else gets 1. It never throws: on a DB error every model returns 1.
- Handlers call `loadComboHeadroomFn` only when the strategy is weighted.

## Tasks (file ownership, no overlap)

### Batch 1 (parallel)

- **T1 resolver + validator.** Create `open-sse/services/comboStrategy.js`.
- **T2 engine.** Modify `open-sse/services/combo.js`: add `getWeightedModels` and `comboWeightedState`, extend `resetComboRotation`, and add the `handleComboChat` params and JSDoc.
- **T3 headroom fn.** Create `src/sse/services/comboHeadroom.js`.

### Batch 2 (after Batch 1; parallel)

- **T4 handlers.** Modify `src/sse/handlers/{chat,fetch,search,tts,imageGeneration}.js` to use `resolveComboStrategy` and pass `comboWeights`, `headroomFn` and `comboStickyLimit`. Fusion reads `judgeModel` and `fusionTuning` from the resolver. The capacity-adapter solo path stays unchanged. Also modify `src/shared/services/weightedTargets.js` so `comboIsWeighted` uses the resolver.
- **T5 API.** In `src/app/api/settings/route.js`, run `validateComboStrategySettings(body)` before `updateSettings` and return 400 `{ error }`. In `src/app/api/combos/[id]/route.js`, a PUT rename moves `comboStrategies[prev.name]` to `[combo.name]` and a DELETE drops `comboStrategies[prev.name]`, both through `getSettings`/`updateSettings`, and each is written only when an entry exists. Create `src/app/api/combos/[id]/headroom/route.js`: a GET that loads the combo (404 if missing) and returns `{ headroom: { [model]: fn(model) } }`.
- **T6 tests.** Create `tests/unit/combo-weighted.test.js` to cover:
  - distribution of 3:1 at 75% ±2% over 1000 draws;
  - headroom 0.2, giving 37.5%;
  - unknown/NaN headroom, which keeps the configured weights;
  - weight 0, which is never first but is still in the list;
  - all-zero weights, which keep the original order;
  - sticky 3, which holds the pick without advancing SWRR;
  - reset, which clears state;
  - `handleComboChat` with weighted failing over to the tail in order;
  - resolver defaults and the unknown-strategy fallback;
  - validator rejects: bad enum, negative/NaN/string/>1000 weights, `__proto__` keys.

### Batch 3 (after T5)

- **T7 UI.** Modify `src/app/(dashboard)/dashboard/combos/page.js`:
  - Add the `STRATEGY_OPTIONS` entry and a header bullet.
  - `handleSetComboStrategy` checks `res.ok`, and on failure it does not update the local state.
  - When `current === "weighted"`, `ComboCard` renders one row per model: the model ID, a number input (min 0, step 1, default 1, `aria-label`) that saves on blur/change through `onSetStrategy({ weights })`, and "≈ N%" computed from `(weight ?? 1) × headroom`. Headroom is fetched once from `/api/combos/[id]/headroom`, and 1 is used when it is unknown. Show "fallback only" at weight 0 and an all-zero notice.
  - Media page untouched: excluded, documented in the spec.

### Batch 4: verification (orchestrator)

- `cd tests && npx vitest run unit/combo-weighted.test.js unit/combo-routing.test.js unit/combo-fusion.test.js unit/combo-autoswitch.test.js unit/combo-cycles-errors.test.js`
- Full suite (`npx vitest run --reporter=json --outputFile=results.json`), then `node __baseline__/verify-no-regression.mjs results.json`.
- `npm run lint`, `npm run build`.

## Out of scope

- Weight editor for media combos (the engine supports it).
- Keeping weights after switching to fallback.
- `judgeModel`/`fusionTuning` shape validation.
- Allowlisting the combos PUT body.
