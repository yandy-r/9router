# YAN-261 weighted combo — technical design

## Executive Summary

Weighted is a 4th combo strategy resolved by one pure helper, then ordered inside `handleComboChat` by smooth WRR over `userWeight × providerHeadroom`. All six combo loops (chat, nested chat, fetch, search, tts, image) already call `handleComboChat`; fusion does not. No schema change. Settings PATCH is the trust boundary (`{ error: string }`, 400). Combo rename does not move `settings.comboStrategies[name]` today and must. Share preview is client-side from user weights only; do not call `GET /api/usage/[connectionId]` (it probes upstream).

## Architecture Design

### `resolveComboStrategy` — `open-sse/services/combo.js`

Pure. No DB. Handlers already import this module. `src/shared/services/weightedTargets.js` may import it too: `combo.js` does not import `src/` or `weightedTargets.js`. Do not put it in `src/` — unit tests would need Next/localDb, and `getWeightedModels` belongs beside it.

```js
export function resolveComboStrategy(settings, comboName) {
  const entry = settings?.comboStrategies?.[comboName];
  const specific = entry && typeof entry === "object" ? entry : {};
  const raw = specific.fallbackStrategy || settings?.comboStrategy || "fallback";
  const strategy = COMBO_STRATEGIES.has(raw) ? raw : "fallback";
  const weights =
    specific.weights && typeof specific.weights === "object" && !Array.isArray(specific.weights)
      ? specific.weights
      : {};
  return {
    strategy, // "fallback" | "round-robin" | "fusion" | "weighted"
    stickyLimit: settings?.comboStickyRoundRobinLimit,
    weights, // { [modelStr]: number } missing key → 1 at pick time
    judgeModel: specific.judgeModel,
    fusionTuning: specific.fusionTuning,
  };
}
```

`COMBO_STRATEGIES = new Set(["fallback","round-robin","fusion","weighted"])`. Unknown stored values fail open to `"fallback"` (same as today's `getRotatedModels`, which rotates only when strategy is `"round-robin"`).

Call sites (replace the duplicated `comboStrategies[name]?.fallbackStrategy || settings.comboStrategy || "fallback"`):

| Site                                     | Lines                 | Notes                                                                   |
| ---------------------------------------- | --------------------- | ----------------------------------------------------------------------- |
| `src/sse/handlers/chat.js`               | 111–113, 141, 146–157 | Top-level combo                                                         |
| `src/sse/handlers/chat.js`               | 218–222, 254, 259–270 | Nested combo                                                            |
| `src/sse/handlers/fetch.js`              | 95–111                | Members are provider ids                                                |
| `src/sse/handlers/search.js`             | 75–91                 | Same                                                                    |
| `src/sse/handlers/tts.js`                | 57–73                 | `provider/model`                                                        |
| `src/sse/handlers/imageGeneration.js`    | 52–69                 | `provider/model`                                                        |
| `src/shared/services/weightedTargets.js` | 8–11                  | `comboIsWeighted` → `resolveComboStrategy(...).strategy === "weighted"` |

Do **not** use the helper on the capacity-adapter solo path (`chat.js` 173–183). That strategy is `getActiveAdapterStrategy` (`"round-robin"` | `"fallback"` only, `capacityAdapter.js` 72–79).

Fusion branches (`chat.js` 121–138 and 231–251) keep `handleFusionChat` with `judgeModel` / `fusionTuning` from the helper. No weights, no headroom.

### `getWeightedModels` — sibling of `getRotatedModels` (`combo.js` 218–248)

```js
export function getWeightedModels(models, comboName, weights, headroomFn, stickyLimit = 1)
```

Separate map. Do not reuse `comboRotationState` (`{ index, consecutiveUseCount }` or a legacy number, `combo.js` 91–95, 225–229).

```js
/** @type {Map<string, { currentWeights: Map<string, number>, consecutiveUseCount: number, stickyId: string|null }>} */
const comboWeightedState = new Map();
```

Key: `comboName || "__default__"` (same key rule as round-robin).

Algorithm:

1. `models.length <= 1` → return `models` unchanged.
2. Per model, `base =` finite `weights[model] >= 0` else `1`. `base === 0` → exclude from the draw (fallback-only).
3. `headroom = headroomFn(model)` when finite and `>= 0`, else `1` (throw or missing fn → `1`). `effective = base * headroom`. `effective <= 0` → exclude.
4. No positive candidates (all-zero weights or all headroom 0) → return `models` in original order. Do not write state.
5. Sticky: reuse `stickyId` while `consecutiveUseCount < normalizeStickyLimit(stickyLimit)` (existing helper, `combo.js` 196–199) **and** that id is still a positive candidate. Do **not** call `pickSmoothWeighted` during the window (would subtract `total` and skew the next draw). Increment `consecutiveUseCount` only.
6. Else `pickSmoothWeighted(candidates, state.currentWeights)` (`weightedRoundRobin.js` 12–47). Store returned `currentWeights`, `consecutiveUseCount = 1`, `stickyId = id`. `id === null` → original order.
7. Return `[pick, ...before, ...after]` via `indexOf` so only the first matching entry moves. Other duplicates stay in the tail.

`stickyLimit` 1 → every request draws (round-robin does the same: `nextUseCount >= 1` advances, `combo.js` 233–239). Acceptance `{A:3,B:1}` full headroom is ~75% A over 1000 draws (±2%). A headroom 0.2 → effective `0.6:1` → ~37.5% A. Smooth WRR is deterministic, not random.

`resetComboRotation` (`combo.js` 254–257) must `delete`/`clear` **both** maps. Settings PATCH already calls it with no args (`settings/route.js` 97–104). Combo PUT/DELETE already reset by name (`combos/[id]/route.js` 78–79, 99).

### `handleComboChat`

Add optional `comboWeights` and `headroomFn`. Existing callers stay valid.

```js
let ordered =
  comboStrategy === "weighted"
    ? getWeightedModels(models, comboName, comboWeights, headroomFn, comboStickyLimit)
    : getRotatedModels(models, comboName, comboStrategy, comboStickyLimit);
```

Then existing `autoSwitch` / `reorderByCapabilities` (`combo.js` 339–350). Stable sort keeps the weighted head when every member shares a capability tier. A worse-tier head still loses to a capable model — same as round-robin. Do not special-case. Failover, Retry-After, and 503 behavior stay in the loop (`combo.js` 357–452).

Fetch, search, tts, and image do not own a loop. They call `handleComboChat` (`fetch.js` 103, `search.js` 83, `tts.js` 65, `imageGeneration.js` 60). Passing weights + `headroomFn` is enough. `autoSwitch` is a no-op for those bodies (no chat modalities).

### `headroomFn` — `src/sse/services/comboHeadroom.js` (new)

`open-sse` must not import `@/lib/localDb`. Build the fn in `src`, pass it in.

```js
export async function loadComboHeadroomFn(models) // → (modelStr) => number
```

- One `getProviderConnections({ isActive: true })` per combo request (`connectionsRepo.js` 122–138). Group ids by `connection.provider`. Same filter as the poller (`quotaSnapshotPoller.js` 137).
- Call only when `strategy === "weighted"` so fallback/round-robin/fusion pay nothing.
- Sync fn, memoized per model string. `getWeightedModels` stays sync.
- `"prov/model"`: `parseModel` from `src/sse/services/model.js` (local alias overlay, `model.js` 23–28). Use `provider` + bare `model` (not the full string). `getProviderHeadroom` matches model windows on the bare id (`quotaSnapshot.js` 249–258, 303–329).
- No slash (fetch/search provider id): `resolveProviderId` (`providers.js` 184). If that id is a known provider, `model` is `null` (global windows only). Else headroom `1` (nested combo name).
- Alias-only names and unknown custom-node prefixes: headroom `1`. Do not call `getModelInfo` (extra DB, and a combo name returns `{ provider: null }` at `model.js` 73–79).
- Use `getProviderHeadroom`, **not** `computeEffectiveWeight`. The latter applies plan-tier bases and a floor (`quotaSnapshot.js` 336–379). Plan tiers are not comparable across providers; floor would zero a model the spec still wants scaled.

Best-of connections: `getProviderHeadroom` returns the **max** headroom, first id on ties (`quotaSnapshot.js` 298–329). One full account hides an exhausted sibling.

Nested combos (`chat.js` 208–270): outer draw treats a child combo name as headroom 1. The child resolves its own strategy when `handleSingleModelChat` re-enters. Cycle guard stays (`chat.js` 212–216).

### Media combos

Engine: supported. Same `handleComboChat` path.

UI: **exclude.** `media-providers/combo/[id]/page.js` 176–187 is a round-robin boolean. On, it writes `{ fallbackStrategy: "round-robin" }`. Off, it `delete`s `comboStrategies[name]`, which would wipe weights. Do not add a weight editor there. Chat combos page is the only editor.

## Data Models

No migration. `settingsRepo.js` 17–19 already has `comboStrategy`, `comboStickyRoundRobinLimit`, `comboStrategies: {}`. `updateSettings` shallow-merges (`settingsRepo.js` 98–110): a PATCH `comboStrategies` **replaces** the whole map. The UI already sends the full map (`combos/page.js` 207–211). Keep that.

```js
settings.comboStrategies[comboName] = {
  fallbackStrategy: "weighted", // "fallback" | "round-robin" | "fusion" | "weighted"
  weights: { "cc/claude-opus": 3 }, // omitted key → 1; 0 → fallback-only
  judgeModel: "", // fusion only; unchanged
  fusionTuning: { minPanel, stragglerGraceMs, panelHardTimeoutMs },
};
settings.comboStrategy; // global default when the per-combo key is absent
settings.comboStickyRoundRobinLimit; // one sticky for round-robin and weighted; not per combo
```

In-memory weighted state is not persisted. Settings PATCH, combo rename, and combo delete clear it.

## API Design

### `PATCH /api/settings`

Validate **before** `updateSettings` (`route.js` 86). Failure shape matches this route and combo routes: `{ "error": "<string>" }` with 400 (`route.js` 60, `combos/[id]/route.js` 40–41). Not `{ error: { message } }`.

- `comboStrategy` if present: whitelist, else `{ "error": "Invalid comboStrategy" }`.
- `comboStrategies` if present: plain object (not array).
- Each entry: plain object. `fallbackStrategy` if present: whitelist, else `{ "error": "Invalid combo strategy for \"<name>\"" }`.
- `weights` if present: plain object. Each value `typeof number && Number.isFinite && >= 0`. Reject numeric strings, `NaN`, `Infinity`, negatives, `null`. `{ "error": "Invalid weight for \"<combo>\" model \"<model>\"" }`.
- Absent `weights` is fine. Do not require keys to be current combo members.
- Leave `judgeModel` / `fusionTuning` unchecked.
- On success, existing `resetComboRotation()` and `configureQuotaSnapshotPoller` stay (`route.js` 97–128). Global or per-combo `"weighted"` already starts the poller (`quotaSnapshotPoller.js` 172–182). No poller change.

### Combo rename — `PUT /api/combos/[id]`

Does **not** migrate strategies today. Lines 78–79 only `resetComboRotation`. `comboStrategies` is keyed by name (`weightedTargets.js` 9, UI 293).

After a successful `updateCombo`, if `combo.name !== prev.name`:

1. `getSettings()`. If `comboStrategies[prev.name]` exists, copy it to `comboStrategies[combo.name]`, delete the old key, `updateSettings({ comboStrategies })` with the full map.
2. `resetComboRotation(prev.name)` and `resetComboRotation(combo.name)` (already there).

Name uniqueness is already enforced (`combos/[id]/route.js` 46–49), so the new key cannot collide.

`DELETE`: also delete `comboStrategies[prev.name]` before reset. An orphan `fallbackStrategy: "weighted"` keeps the poller on (`quotaSnapshotPoller.js` 178–180) after the combo is gone.

### Share % preview

No new route. `GET /api/usage/[connectionId]` returns `quotaSnapshot` from `buildQuotaSnapshotView` (`usage/.../route.js` 212–215, `quotaSnapshotSync.js` 251–276) but refreshes tokens and probes the provider (129–180). Wrong grain (per connection, not per combo model) and too expensive for a card.

Preview is local, weights only:

```
base(m) = finite weights[m] >= 0 ? weights[m] : 1
share(m) = base === 0 || sum(base>0) === 0 ? 0 : base / sum(positive bases)
```

Label it as weight share, not live quota. Quota still scales the real draw.

## System Constraints

- `combo.js` is already ~731 lines. Add the helper, map, and branch in place. Do not split the file for this change.
- `pickSmoothWeighted` drops non-finite and `<= 0` weights and dedupes ids (`weightedRoundRobin.js` 27–31). Callers must pre-filter weight 0 so those models remain in the fallback tail instead of disappearing.
- Headroom is fail-open: no snapshot → 1 (`quotaSnapshot.js` 320–323). Never treat unknown as exhausted.
- Multi-account headroom is the best connection, not the sum.
- `augmentModelsWithCapacityAdapter` runs **before** `handleComboChat` and prepends pool models only when no original member satisfies the hard capability (`capacityAdapter.js` 96–105). Those extras are not in `weights`, so they draw at weight 1. Rare, and the originals cannot serve the request anyway.
- Auto-switch can still move a weighted head back when it is a worse capability tier.
- Nested combo members contribute headroom 1 at the outer draw.
- Media round-robin toggle deletes the whole strategy entry.
- `handleSetComboStrategy` deletes the entry when strategy is missing or `"fallback"` (`combos/page.js` 201–204). Weighted must send `fallbackStrategy: "weighted"` or the weights never persist. Switching to fallback drops weights. Switching to round-robin keeps a stale `weights` object; harmless.
- PATCH replace of `comboStrategies` is not a deep merge. Validation must see the full object the client intends to store.

## Codebase Changes

| File                                           | Change                                                                                                                                                                                                                                                         |
| ---------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `open-sse/services/combo.js`                   | `COMBO_STRATEGIES`, `resolveComboStrategy`, `comboWeightedState`, `getWeightedModels`. `resetComboRotation` clears both maps. `handleComboChat` accepts `comboWeights` + `headroomFn` and branches before auto-switch.                                         |
| `src/sse/services/comboHeadroom.js`            | **New.** `loadComboHeadroomFn(models)`.                                                                                                                                                                                                                        |
| `src/sse/handlers/chat.js`                     | Both combo branches: `resolveComboStrategy`; pass weights, sticky, headroom fn into `handleComboChat`. Fusion reads judge/tuning from the helper. Leave 173–183 adapter call as-is.                                                                            |
| `src/sse/handlers/fetch.js`                    | Same wiring, provider-id members.                                                                                                                                                                                                                              |
| `src/sse/handlers/search.js`                   | Same.                                                                                                                                                                                                                                                          |
| `src/sse/handlers/tts.js`                      | Same.                                                                                                                                                                                                                                                          |
| `src/sse/handlers/imageGeneration.js`          | Same.                                                                                                                                                                                                                                                          |
| `src/shared/services/weightedTargets.js`       | `comboIsWeighted` delegates to `resolveComboStrategy`.                                                                                                                                                                                                         |
| `src/app/api/settings/route.js`                | Whitelist + weight checks before `updateSettings`. 400 `{ error }`.                                                                                                                                                                                            |
| `src/app/api/combos/[id]/route.js`             | Rename copies `comboStrategies[old]` → `[new]`. Delete drops the key.                                                                                                                                                                                          |
| `src/app/(dashboard)/dashboard/combos/page.js` | `STRATEGY_OPTIONS` entry `{ value: "weighted", label: "Weighted — by weight & remaining quota" }`. When selected, per-model number input (default 1) and local share %. `onSetStrategy({ fallbackStrategy: "weighted", weights })`.                            |
| `tests/unit/combo-weighted.test.js`            | **New.** Distribution ±2% / 1000 (sticky 1), headroom 0.2 → 37.5%, unknown headroom, weight 0 stays in tail, all-zero → original order, sticky window does not advance WRR, `resetComboRotation` clears weighted state, resolver whitelist / default weight 1. |
| `tests/unit/settings-combo-validation.test.js` | **New** if no route test exists. 400 on bad strategy, negative/NaN/string weight; 200 does not persist the bad body.                                                                                                                                           |

Unchanged on purpose: `quotaSnapshotPoller.js`, `weightedRoundRobin.js`, `quotaSnapshot.js`, `media-providers/combo/[id]/page.js`, fusion, capacity-adapter strategy.

`combo-routing`, `combo-fusion`, `combo-autoswitch`, `combo-cycles-errors` must stay green. Run `tests/__baseline__/verify-no-regression.mjs`.

## Technical Decisions

- Resolver + picker live in `open-sse/services/combo.js`. Headroom lookup lives in `src` and is injected. Avoids an `open-sse` → `src` import.
- Weighted state is a second map. Shared state would corrupt round-robin's index/count shape.
- Sticky holds the last pick and skips `pickSmoothWeighted` until the limit. Matches `normalizeStickyLimit` and keeps the smooth counters honest.
- Effective weight is `userWeight × getProviderHeadroom`. No plan-tier base, no `QUOTA_SNAPSHOT.floor`.
- One active-connection query per weighted combo request. No usage probe on the hot path.
- Preview skips live headroom. The usage route is the wrong API.
- Media: engine on, editor off.
- Capability reorder stays after the draw. Within one tier the weighted head sticks.

## Open Questions

- Should a weighted head that fails a hard capability stay first (failed attempt, then tail) or keep today's full reorder? This design keeps today's reorder.
- Capacity-adapter models draw at weight 1 when they are prepended. Acceptable, or should they be tail-only and excluded from the draw?
- Rename migration read-modify-writes `comboStrategies` and can race a concurrent settings PATCH. Same race the UI already has. Worth a transaction only if we already have one around settings — we do inside `updateSettings`, but the route's read is outside it.
- Delete-combo strategy cleanup is slightly beyond the brief's rename sentence. It stops a dead combo from pinning the quota poller on. Ship it with the rename.
