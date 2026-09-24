# YAN-261 Business Analysis — Weighted Combo Strategy

## Executive Summary

Weighted adds a 4th combo strategy that picks each request's head model proportional to `userWeight × providerHeadroom`, keeping the remaining models as the ordered fallback tail. Business intent: spread load across quota-bearing accounts while honoring operator preference; headroom only scales weight down, never up (brief lines 9, 20). Storage reuses `settings.comboStrategies[name]` (no schema change); rotation state, fallback semantics, Retry-After propagation, and capability auto-switch behavior must stay identical to round-robin/fallback.

## User Stories

1. **Operator with multiple quota accounts**: "Combo [claude-opus, codex-gpt] — send 75% of first-choice traffic to opus, 25% to codex, but if opus quota drains, shift load automatically." (acceptance: `{A:3,B:1}` → ~75/25 at full headroom; A headroom 0.2 → 60/40.)
2. **Operator pinning a backup**: "Model B is emergency-only. Set weight 0 so it never gets picked first but still serves as fallback when A fails." (weight 0 = fallback-only, brief line 20.)
3. **Operator with no quota probes**: "My providers have no usage endpoints. Weighted must behave exactly like my manual weights — unknown headroom must not look exhausted." (`getProviderHeadroom` fail-open 1, `quotaSnapshot.js:320-323`; acceptance "unknown headroom keeps weights".)
4. **Operator editing a combo**: rename / member changes must not silently orphan or corrupt weight config; strategy/weight edits reset rotation state immediately.
5. **API client**: unchanged contract — same model string in request, same SSE stream, same error/Retry-After shape when all members fail (`combo.js:434-452`).

## Business Rules

### Strategy resolution (per request)

- Per-combo entry wins: `comboStrategies[name].fallbackStrategy` else global `settings.comboStrategy` else `"fallback"` — identical shape at all 5 handlers (chat.js:111-113, 220-222; tts.js:57-59; fetch.js:95-97; search.js:75-77; imageGeneration.js:52-54).
- `weighted` whitelist member alongside fallback|round-robin|fusion; anything else rejected 400 at PATCH boundary (currently zero validation, settings/route.js:45-104).

### Effective weight

- `effective(model) = (weights[model] ?? 1) × headroom(provider of model)`. Default 1 for unset members (brief line 20).
- Headroom = best across the provider's active connections; unknown/missing snapshot = 1, never 0 (`quotaSnapshot.js:297-333`, comment "Unknown ≠ 0", line 320).
- Headroom is multiplicative down-scaler only. Plan-tier capacity (`PLAN_CAPACITY`, config/quotaSnapshot.js:19-55) explicitly NOT used at combo level — tiers incomparable across providers (brief line 9); combo weights are operator-relative.
- Weights must be finite numbers ≥ 0; reject otherwise (400). No upper bound; normalize client-side for display only.

### Edge cases

- **Weight 0**: excluded from head pick, stays in fallback tail at original position (brief line 20). Note: `pickSmoothWeighted` silently skips weight ≤ 0 (weightedRoundRobin.js:31), so filter before calling.
- **All-zero weights** (or all effective weights 0, e.g. every provider below headroom): degrade to plain fallback order — combo still usable (brief line 20, acceptance line 30).
- **Unknown headroom**: weight passes through unscaled (`getProviderHeadroom` fallback 1, quotaSnapshot.js:304,330-331).
- **Headroom floor**: `QUOTA_SNAPSHOT.floor = 0.05` and `computeEffectiveWeight`'s `belowFloor→0` are phase-2-owned (config/quotaSnapshot.js:3-4) — phase 3 must decide whether combo weighting adopts the floor or treats any >0 headroom as eligible. Open question below.
- **Nested combos** (combo member without "/" resolves to another combo, chat.js:208-271): weights apply at each nesting level independently; each level uses its own `comboStrategies[innerName]` entry. Weighted state keyed by combo name — inner and outer combo state maps are separate.
- **Capability auto-switch**: runs AFTER strategy ordering (combo.js:339-351) and re-floats capable models to front when the request needs vision/pdf/audio/video. This overrides a weighted pick — acceptable and consistent with round-robin behavior; document that hard capabilities trump weight.
- **Capacity adapter models** (`augmentModelsWithCapacityAdapter`, chat.js:114-118): adapter-prepended models have no user weight → default 1; when adapter pool is prepended (no member satisfies hard caps), weighted pick runs over pool+members. `getActiveAdapterStrategy` only returns fallback|round-robin (capacityAdapter.js:72-80), so single-model adapter path never weighted — fine.
- **Combo rename**: `comboStrategies` keyed by NAME. PUT /api/combos/[id] only calls `resetComboRotation(prev.name)` + `(combo.name)` (route.js:77-79) — it does NOT migrate the `comboStrategies` settings entry. Rename silently drops strategy/weights config → falls back to global. Must fix in this phase (brief line 21).
- **Combo delete**: DELETE resets rotation (route.js:99) but also leaves orphaned `comboStrategies[name]` entry. Harmless (unreachable key) but should be cleaned; consistent handling with rename.
- **Weights for removed models**: stale keys in `weights` map for models no longer in combo are ignored at runtime (lookup is per current member). UI should prune or gray them; storage can keep them (member re-add restores weight). No migration needed.
- **Global `comboStrategy=weighted` without per-combo weights**: all members default weight 1 → smooth WRR over headroom alone ≈ round-robin scaled by quota. Poller already starts for this case (quotaSnapshotPoller.js:177). Valid configuration.
- **Media combos** (webSearch/webFetch/image/tts, media-providers/combo/[id]/page.js:97,176-188): today only boolean round-robin toggle that writes/deletes `comboStrategies[name] = {fallbackStrategy:"round-robin"}`. These handlers DO resolve `comboStrategies` (tts.js:57-71, fetch.js:95-109, search.js:75-89, imageGeneration.js:52-67), so `weighted` set elsewhere would take effect on media combos — but quota probes likely don't exist for media providers → headroom 1 everywhere → behaves as pure weight-based WRR. Decision needed: expose weight editor there or explicitly document exclusion (brief line 23).
- **Sticky limit with weighted**: `comboStickyRoundRobinLimit` (default 1, settingsRepo.js:18) must hold the weighted pick for N consecutive requests before re-picking, mirroring round-robin sticky semantics (combo.js:196-248).
- **1-member or empty combos**: `getRotatedModels` early-returns for `models.length <= 1` (combo.js:219); weighted must match — no pick needed.
- **Duplicate members**: combo models are strings; `pickSmoothWeighted` dedupes by id (weightedRoundRobin.js:27-28). Weights map keyed by model string — duplicate entries share one weight. Rare; acceptable.
- ****proto** keys**: weights map keyed by user-entered model strings; settings stored as JSON blob (settingsRepo.js:98-111) — `__proto__` key pollution risk when merging `weights` objects in JS. Use `Object.hasOwn` / Map-safe access in resolver (precedent: BLOCKED_KEYS in quotaSnapshot.js:15).

## Workflows

1. **Configure weighted combo**: Dashboard combos page → strategy Select (page.js:343-347, 423-430) gains "Weighted" option → ComboCard shows per-model weight inputs + "≈ share %" preview from current headroom → `handleSetComboStrategy` merges `{fallbackStrategy:"weighted", weights:{...}}` into `comboStrategies[name]` and PATCHes /api/settings (page.js:196-217) → PATCH resets rotation state (route.js:97-104) and reconfigures quota poller (route.js:115-128).
2. **Request-time routing (chat)**: `getComboModels` → resolve strategy → (new) `getWeightedModels(models, comboName, weights, headroomFn, stickyLimit)` returns `[pick, ...rest original order]` → auto-switch reorder if capabilities demand → `handleComboChat` fallback loop unchanged (combo.js:328-453).
3. **Failover**: head model errors → `checkFallbackError` decides → transient 502/503/504 cooldown wait → next model in tail order (combo.js:398-431). Retry-After earliest across failures surfaced when all fail (combo.js:380-387,442-446). Unchanged.
4. **Quota refresh**: poller ticks (60s, quotaSnapshotPoller.js:157-161) probing weighted providers' connections; next request's headroom reflects freshest snapshot; stale/missing → 1.
5. **Rename combo**: PUT /api/combos/[id] → must also PATCH `comboStrategies` (rename key, preserve weights) + reset rotation under both names.
6. **Validation failure**: PATCH /api/settings with non-whitelisted strategy or non-finite/negative weight → 400, no state mutation (fail-fast at boundary).

## Domain Model

- **Combo** (combosRepo.js): `{id, name, kind, models[]}` — `kind` distinguishes chat vs media combos. Name is the settings key (name regex `^[a-zA-Z0-9_.-]+$`, combos/[id]/route.js:6).
- **Settings.comboStrategies**: `Map<comboName, {fallbackStrategy, judgeModel?, fusionTuning?, weights?}>`. New field: `weights: Map<modelString, number≥0>`. No DB migration (JSON blob, settingsRepo.js:17-19).
- **Settings.comboStrategy / comboStickyRoundRobinLimit**: global defaults; sticky shared across round-robin and weighted.
- **Weight semantics**: relative, dimensionless, default 1; multiplied by headroom ∈ [0,1]; product feeds smooth WRR (`pickSmoothWeighted`, weightedRoundRobin.js).
- **Headroom**: per-provider best-of-connections, fail-open 1 (quotaSnapshot.js:303-333); sourced from header windows + probe windows (snapshotTtlMs 1h, poller stale 15min).
- **Rotation state**: in-memory `comboRotationState` Map keyed by combo name (combo.js:95); weighted needs parallel smooth-WRR `currentWeights` state map, keyed identically, cleared by `resetComboRotation` (combo.js:254-257). In-memory only — restart resets distribution counters (acceptable; smooth WRR converges fast).

## Existing Codebase Integration

| Concern                   | File:line                                                                                         | Note                                                                                                                              |
| ------------------------- | ------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------- |
| Strategy resolution (×7)  | chat.js:111-113, 220-222; tts.js:57-59; fetch.js:95-97; search.js:75-77; imageGeneration.js:52-54 | Duplicated pattern → one resolver helper                                                                                          |
| Rotation/pick             | combo.js:218-248 (`getRotatedModels`), 254-257 (`resetComboRotation`)                             | Add sibling `getWeightedModels`; extend reset                                                                                     |
| Smooth WRR primitive      | weightedRoundRobin.js:12-51                                                                       | Reuse; caller owns state + floor policy (lines 5-6)                                                                               |
| Headroom source           | quotaSnapshot.js:303-333 (`getProviderHeadroom`)                                                  | Needs connectionIds per provider — open-sse can't reach src/lib DB; headroomFn must be injected from src/sse side (open question) |
| Weighted detection/poller | weightedTargets.js:8-33; quotaSnapshotPoller.js:170-183                                           | Already combo-aware; no change                                                                                                    |
| Settings defaults         | settingsRepo.js:17-19                                                                             | No defaults change needed                                                                                                         |
| Settings PATCH            | api/settings/route.js:97-128                                                                      | Add whitelist + weight validation before `updateSettings`                                                                         |
| Combo rename/delete       | api/combos/[id]/route.js:26-106                                                                   | Add comboStrategies key migration/cleanup                                                                                         |
| Chat UI                   | combos/page.js:196-217, 343-347, 349-430                                                          | Add option + weight editor + share preview                                                                                        |
| Media combo UI            | media-providers/combo/[id]/page.js:97, 176-188                                                    | Boolean toggle only; decide support                                                                                               |
| Fusion                    | chat.js:121-139, 231-252                                                                          | Unaffected; weighted and fusion mutually exclusive per combo                                                                      |
| Regression gate           | tests/unit/combo-{routing,fusion,autoswitch,cycles-errors}.test.js                                | Must stay green                                                                                                                   |

## Success Criteria

1. Distribution: `{A:3,B:1}` full headroom → A first 73-77% over 1000 requests, sticky 1 (smooth WRR is deterministic-fair, well within ±2%).
2. Headroom scaling: A at 0.2 → A:B ratio 0.6:1 (A ≈ 37.5%).
3. Unknown headroom → weights honored exactly; all-zero → fallback order; weight 0 → fallback-only.
4. Failover order, transient-error cooldown, Retry-After propagation identical to fallback/round-robin (combo-cycles-errors.test.js green).
5. Rename preserves strategy+weights; delete cleans entry; stale weight keys harmless.
6. PATCH rejects invalid strategy/weights with 400; valid PATCH resets rotation + poller.
7. UI: weighted selectable per combo, per-model weights editable, live share-% preview; fusion UI untouched.
8. New unit tests (distribution, headroom, weight 0, all-zero, sticky, reset, resolver, rename migration) + `tests/__baseline__/verify-no-regression.mjs` green.

## Open Questions

1. **Headroom floor at combo level**: adopt `QUOTA_SNAPSHOT.floor = 0.05` (near-exhausted provider gets weight 0, "all below floor → use everyone" per weightedRoundRobin.js:4-6 caller policy) or multiply raw headroom with no floor? Brief says "headroom only scales weight down" — suggests raw multiply; floor belongs to provider-level phase 2. Recommend raw multiply, no floor, for v1.
2. **headroomFn wiring**: `getProviderHeadroom` needs `connectionIds` per provider; combo.js (open-sse) has no DB access. Where does the connection list come from at request time — resolve in src/sse handler (e.g. `getProviderConnections({provider, isActive:true})` as poller does, quotaSnapshotPoller.js:137) and inject? Cost per request acceptable (poller does it per tick)?
3. **Media combos**: expose weighted in media combo UI, or document "chat combos only" while engine silently honors weighted if set? Brief item 5 requires explicit decision.
4. **Sticky with weighted**: does sticky pin the picked head for N requests then re-run WRR, or pin then advance like round-robin? Recommend: pin pick, decrement counter, re-pick after N (matches "sticky = requests per model before switching").
5. **Share-% preview data source**: dashboard needs headroom per provider — new endpoint or reuse /api/usage data? Preview accuracy vs cost.
6. **Rename sync atomicity**: combo PUT + settings PATCH are two writes; partial failure leaves orphan entry. Acceptable (self-heals: old key unreachable, new key absent→global) or must the PUT route do both in one transaction? Settings is single-row JSON (settingsRepo.js:98-111) — same DB adapter, could wrap.
7. **Weights on capacity-adapter pool models**: adapter models get implicit weight 1 — should they be excludable/weightable, or always tail-only? Current augment puts pool FIRST (capacityAdapter.js:90-106) then auto-switch may reorder — interaction with weighted pick needs one test.
