# Feature Spec: Weighted combo strategy + per-model weights editor (YAN-261)

## Executive Summary

Adds `weighted` as a fourth combo strategy (Linear YAN-261, GitHub #105, phase 3 of YAN-258). Each request's first-choice model is picked by smooth weighted round-robin over `userWeight × providerHeadroom`. The other models stay in their original order as the fallback tail, so failover, Retry-After and capability auto-switch are unchanged. YAN-259 already ships `pickSmoothWeighted` and `getProviderHeadroom`, so this phase is wiring: one strategy resolver for seven call sites, settings validation, strategy migration on rename/delete, and a per-model weight editor with live share preview. Main risk: regressions in existing strategies.

## External Dependencies

### APIs and Services

No external APIs. Headroom comes from the in-memory quota snapshot store built in YAN-259 (`open-sse/services/quotaSnapshot.js`). It is filled passively from upstream rate-limit headers and by the weighted-gated poller (`src/shared/services/quotaSnapshotPoller.js`), which already starts when any combo has `fallbackStrategy: "weighted"`.

Prior art that matches the design (see `research-external.md`):

- nginx smooth WRR (`ngx_http_upstream_round_robin.c`): deterministic. `{A:3,B:1}` gives exactly 750/250 over 1000 picks.
- Envoy ORCA / Angie `effective_weight`: static weight × live utilization, which is the same model as `weight × headroom`.
- OpenRouter provider routing: weighted first pick, then an ordered fallback.
- HAProxy / AWS Route 53: weight 0 means no primary traffic, but the target stays available.

### Libraries and SDKs

| Library                                                | Version | Purpose    | Installation |
| ------------------------------------------------------ | ------- | ---------- | ------------ |
| none (reuse `open-sse/services/weightedRoundRobin.js`) | n/a     | smooth WRR | n/a          |

Weighted random (LiteLLM `simple-shuffle`, Portkey) was rejected. It is non-deterministic, and a 1000-draw ±2% test would fail about 14–19% of the time.

### External Documentation

- nginx upstream weights: <https://nginx.org/en/docs/http/ngx_http_upstream_module.html#server>
- Envoy load-balancing weights: <https://www.envoyproxy.io/docs/envoy/latest/intro/arch_overview/upstream/load_balancing/overview>
- OpenRouter provider routing: <https://openrouter.ai/docs/features/provider-routing>

## Business Requirements

### User Stories

**Primary user: 9Router operator with several subscriptions**

- As an operator, I want a combo such as `[cc/claude-opus, cx/gpt-5.5, gc/gemini-pro]` to lean on whichever subscription has the most room left, so that no single weekly cap runs out early.
- As an operator, I want to set a relative weight per model (default 1), so that I can prefer one model without dropping the others.
- As an operator, I want weight 0 to mean "fallback only", so that I can park a model without removing it.
- As an operator, I want renaming a combo to keep its strategy and weights.

### Business Rules

1. **Effective weight** = `weights[model] ?? 1` × provider headroom. Unknown headroom counts as 1. There is no floor and no plan-tier base, because tier numbers are not comparable across providers.
   - Validation: weights are finite numbers from 0 to 1000. Anything else is rejected with a 400 at `PATCH /api/settings`.
2. **Pick rule**: the head is chosen by smooth WRR. State is keyed by combo name, and `comboStickyRoundRobinLimit` is honored by holding the pick for N requests. The returned list is `[pick, ...rest in original order]`.
3. **Weight 0 and zero headroom**: the model is excluded from the draw and stays in the tail.
4. **All effective weights 0**: the combo uses plain fallback order and no state is written.
5. **Reset**: `resetComboRotation()` clears the weighted state too. It already runs on settings PATCH and on combo PUT/DELETE.
6. **Strategy whitelist**: `fallback | round-robin | fusion | weighted`, for both `comboStrategy` and `comboStrategies[*].fallbackStrategy`. On read, unknown stored values resolve to `fallback`.
7. **Rename/delete**: a rename moves `comboStrategies[old]` to `comboStrategies[new]` on the server. A delete drops the entry.
   - Exception: when no entry exists, nothing is written.
8. **Fusion unaffected**: fusion is a panel strategy and weighted is only a first-choice picker.

### Edge Cases

| Scenario                                                       | Expected Behavior                                                                | Notes                                                       |
| -------------------------------------------------------------- | -------------------------------------------------------------------------------- | ----------------------------------------------------------- |
| One model                                                      | returned unchanged                                                               | no state                                                    |
| `weights` missing                                              | every model weight 1, so the draw is an even split                               | global `comboStrategy: "weighted"` with no entry            |
| Weight key for a model no longer in the combo                  | ignored                                                                          | read path fails open                                        |
| Nested combo as a member                                       | outer draw uses headroom 1 for it; the child resolves its own strategy           | cycle guard unchanged                                       |
| Capability auto-switch                                         | runs after the pick; the stable sort keeps the head when tiers are equal         | same as round-robin                                         |
| Capacity-adapter pool models prepended                         | weight 1                                                                         | rare; the original members cannot serve that request anyway |
| Sticky model loses eligibility (weight or headroom drops to 0) | stickiness is dropped and a new draw happens                                     |                                                             |
| Media combos (tts / image / fetch / search)                    | engine supports weighted through the shared `handleComboChat` path; no editor UI | decision below                                              |
| Combo named `__proto__` or similar                             | rejected by the settings validator (blocked keys)                                |                                                             |

### Success Criteria

- [ ] `{A:3,B:1}`, full headroom, sticky 1: A is first 75% ±2% over 1000 requests.
- [ ] A headroom 0.2: A ≈ 37.5% ±2%.
- [ ] Unknown headroom keeps the configured weights; all-zero weights give the original order.
- [ ] Weight 0 is never first but is still in the returned list.
- [ ] Sticky N holds the pick N times, and the WRR state does not advance during the hold.
- [ ] `resetComboRotation()` clears the weighted state.
- [ ] `combo-routing`, `combo-fusion`, `combo-autoswitch` and `combo-cycles-errors` tests stay green, and `verify-no-regression.mjs` passes.
- [ ] Settings PATCH returns 400 for an unknown strategy and for bad weights.
- [ ] Renaming a combo keeps its weights.

## Technical Specifications

### Architecture Overview

```text
settings.comboStrategies[name] ─▶ resolveComboStrategy()        (open-sse/services/comboStrategy.js, pure)
                                        │
chat / fetch / search / tts / image ────┤ strategy === "weighted" ─▶ loadComboHeadroomFn(models)
handlers (src/sse/handlers/*)           │                              (src/sse/services/comboHeadroom.js:
                                        ▼                               getProviderConnections + getProviderHeadroom)
                               handleComboChat({ comboStrategy, comboWeights, headroomFn, comboStickyLimit })
                                        │
                                        ├─ weighted   ─▶ getWeightedModels() ─▶ pickSmoothWeighted()
                                        └─ otherwise  ─▶ getRotatedModels()   (unchanged)
                                        ▼
                               reorderByCapabilities ─▶ fallback loop (unchanged)
```

### Data Models

No schema change. The `settings` JSON blob (`src/lib/db/repos/settingsRepo.js:17-19`):

| Field                                               | Type                | Constraints                                  | Description                        |
| --------------------------------------------------- | ------------------- | -------------------------------------------- | ---------------------------------- |
| `comboStrategy`                                     | string              | enum of 4                                    | global default                     |
| `comboStickyRoundRobinLimit`                        | int                 | ≥1                                           | shared by round-robin and weighted |
| `comboStrategies[name].fallbackStrategy`            | string              | enum of 4                                    | per-combo                          |
| `comboStrategies[name].weights`                     | `{[model]: number}` | finite, 0..1000, no blocked keys, ≤ 200 keys | new; a missing key means 1         |
| `comboStrategies[name].judgeModel` / `fusionTuning` | —                   | unchanged                                    | fusion only                        |

In-memory only: `comboWeightedState: Map<comboName, { currentWeights: Map, stickyId, count }>`, which lives in `combo.js` next to `comboRotationState`.

### API Design

#### `PATCH /api/settings` (existing)

**Purpose**: persist settings. It now validates `comboStrategy` and `comboStrategies` before `updateSettings`.
**Authentication**: dashboard guard (`/api/settings` is in `PROTECTED_API_PATHS`).
**Errors**: 400 `{ "error": "<message>" }`, the same shape the route already uses.

```json
{
  "comboStrategies": {
    "code": { "fallbackStrategy": "weighted", "weights": { "cc/claude-opus": 3, "cx/gpt-5.5": 1 } }
  }
}
```

Example errors: `Invalid comboStrategy`, `Invalid strategy for combo "code"`, `Invalid weight for combo "code" model "cc/claude-opus"`.

#### `GET /api/combos/[id]/headroom` (new, read-only)

**Purpose**: provides the live share preview. It returns `{ headroom: { [model]: number } }`, built with the same `loadComboHeadroomFn` the router uses. It reads the in-memory snapshot only: no upstream probe and no token refresh.
**Authentication**: covered by `/api/combos` in `PROTECTED_API_PATHS`.
**Errors**: 404 when the combo is not found.

#### `PUT` / `DELETE /api/combos/[id]` (existing)

A rename moves the `comboStrategies` entry, and a delete drops it. Both happen after the combo write succeeds.

### System Integration

#### Files to Create

- `open-sse/services/comboStrategy.js`: `COMBO_STRATEGIES`, `resolveComboStrategy(settings, comboName)`, `validateComboStrategySettings(body)` (returns an error string or null).
- `src/sse/services/comboHeadroom.js`: `loadComboHeadroomFn(models)` returns a synchronous `(model) => headroom`. It makes one `getProviderConnections({ isActive: true })` call, groups the results by provider, and resolves each model with `parseModel` (a bare provider ID works for fetch/search). Unknown models get 1.
- `src/app/api/combos/[id]/headroom/route.js`.
- `tests/unit/combo-weighted.test.js`.

#### Files to Modify

- `open-sse/services/combo.js`: add `getWeightedModels`; `resetComboRotation` clears both maps; `handleComboChat` gets `comboWeights` and `headroomFn`.
- `src/sse/handlers/{chat,fetch,search,tts,imageGeneration}.js`: switch to the resolver, and build `headroomFn` only when the strategy is weighted.
- `src/shared/services/weightedTargets.js`: `comboIsWeighted` delegates to the resolver.
- `src/app/api/settings/route.js`: call the validator.
- `src/app/api/combos/[id]/route.js`: rename/delete migration.
- `src/app/(dashboard)/dashboard/combos/page.js`: strategy option, header bullet, and weights editor. The editor is kept small and inline, following the existing `ComboCard` layout.

## UX Considerations

### User Workflows

#### Primary Workflow: set up weighted

1. **Pick the strategy**: the user picks "Weighted — by weight & remaining quota" in the card `Select`.
2. **Edit weights**: the card shows one row per model with a number input (min 0, step 1, default 1) and "≈ N%".
3. **Save**: the value persists on blur or change through `handleSetComboStrategy({ weights })`, and the preview updates right away.
4. **Read the preview**: share = effective / sum(effective), using live headroom from the new endpoint (1 when unknown).

#### Error Recovery Workflow

1. **Error**: PATCH returns 400.
2. **User sees**: the local state is not updated. `handleSetComboStrategy` now checks `res.ok` and logs the error.
3. **Recovery**: the input goes back to the last saved value.

### UI Patterns

| Component     | Pattern                                | Notes                                 |
| ------------- | -------------------------------------- | ------------------------------------- |
| Weight input  | existing `Input` / native number input | `aria-label="Weight for <model>"`     |
| Share         | muted `text-[11px]` text               | "Fallback only" when the weight is 0  |
| All-zero      | one-line notice                        | "All weights 0 — uses fallback order" |
| Unknown quota | no badge; headroom 1                   | never shown as exhausted              |

### Accessibility Requirements

- Each input has an `aria-label` that names the model. The share is plain text next to it, not conveyed by color alone.

### Performance UX

- Headroom is fetched once when the weighted editor mounts. That is one cheap in-memory endpoint call per card, with no polling.

## Recommendations

### Implementation Approach

**Recommended strategy**: pure helpers first, then wiring, then the UI.

**Phasing:**

1. **Foundation**: the resolver and validator module, `getWeightedModels`, and the tests.
2. **Wiring**: handlers, `headroomFn`, settings validation, rename/delete migration, `weightedTargets`.
3. **UI**: strategy option, weight editor, headroom endpoint.

### Technology Decisions

| Decision                     | Recommendation                                      | Rationale                                                                                    |
| ---------------------------- | --------------------------------------------------- | -------------------------------------------------------------------------------------------- |
| Resolver location            | new pure `open-sse/services/comboStrategy.js`       | no `src` import, usable by both sides, keeps `combo.js` (731 lines) from growing more        |
| `getWeightedModels` location | `combo.js`, next to `getRotatedModels`              | issue requirement; shares `normalizeStickyLimit` and the reset                               |
| Headroom source              | `getProviderHeadroom`, not `computeEffectiveWeight` | the latter adds plan-tier bases and a 0.05 floor that break the acceptance math              |
| Weighted state               | a separate map                                      | round-robin state has a different shape                                                      |
| Sticky                       | hold `stickyId`; skip the WRR call during the hold  | keeps the smooth counters accurate                                                           |
| Media combos                 | engine on, no editor                                | the media page is a round-robin toggle, and adding weights there is out of scope; documented |
| Share preview                | small read-only headroom endpoint                   | the usage route probes upstream and is per connection                                        |

### Quick Wins

- The DRY resolver removes about 30 duplicated lines.
- Checking `res.ok` in `handleSetComboStrategy` fixes a silent optimistic update.

### Future Enhancements

- A weight editor for media combos.
- Keeping weights when switching the strategy away from weighted and back.

## Risk Assessment

### Technical Risks

| Risk                                          | Likelihood | Impact | Mitigation                                                                           |
| --------------------------------------------- | ---------- | ------ | ------------------------------------------------------------------------------------ |
| Regression in fallback / round-robin / fusion | Low        | High   | the weighted branch is additive; the existing suites and the baseline gate must pass |
| Headroom lookup cost per request              | Low        | Low    | one DB query, only when weighted                                                     |
| Auto-switch overrides the pick                | Med        | Low    | documented; same as round-robin                                                      |
| Rename/settings race                          | Low        | Low    | same read-modify-write pattern the UI already uses                                   |

### Integration Challenges

- `open-sse` must not import `@/lib/localDb`. The handlers build `headroomFn` and inject it.

### Security Considerations

#### Critical — Hard Stops

| Finding | Risk | Required Mitigation |
| ------- | ---- | ------------------- |
| None    | —    | —                   |

#### Warnings — Must Address

| Finding                           | Risk                                   | Mitigation                                            | Alternatives                |
| --------------------------------- | -------------------------------------- | ----------------------------------------------------- | --------------------------- |
| W1 no strategy whitelist          | silent misrouting                      | enum check → 400                                      | —                           |
| W2 no weights validation          | NaN / negative / huge values persisted | finite 0..1000, ≤ 200 keys → 400                      | clamp (rejected: fail fast) |
| W3 rename leaves the entry behind | weights lost; poller pinned on         | migrate on PUT, drop on DELETE                        | lazy GC                     |
| W4 `__proto__` keys               | prototype setter in the UI             | reject blocked keys                                   | —                           |
| W5 unbounded state map            | memory growth                          | keyed by existing combo names only and reset on edits | size cap (deferred)         |

#### Advisories — Best Practices

- A1: when `requireLogin=false`, the dashboard is open to anyone on the network. This existing posture is not introduced here.
- A2: `judgeModel` / `fusionTuning` shape is not validated. Out of scope.
- A5: combos PUT merges the whole request body. Existing behavior, deferred.

## Task Breakdown Preview

### Phase 1: Foundation

**Focus**: pure logic.
**Tasks**: T1 `comboStrategy.js` (resolver + validator); T2 `getWeightedModels` + `handleComboChat` params + reset; T3 `tests/unit/combo-weighted.test.js`.
**Parallelization**: T1 and T2 in parallel; T3 after both.

### Phase 2: Wiring

**Dependencies**: Phase 1.
**Tasks**: T4 `comboHeadroom.js` + handlers + `weightedTargets`; T5 settings validation + combo rename/delete migration.

### Phase 3: UI

**Tasks**: T6 headroom endpoint + `combos/page.js` editor.

## Decisions Needed

1. **Media combos**: the engine supports weighted with no UI, documented as excluded (decided).
2. **Weight cap**: 1000 (decided; protects WRR float precision and matches the security recommendation).
3. **Keeping weights after switching to fallback**: no. The existing prune stays and the weights are dropped (decided; simplest).

## Research References

- [research-external.md](./research-external.md): SWRR prior art, determinism, no new dependencies
- [research-business.md](./research-business.md): rules, edge cases
- [research-technical.md](./research-technical.md): call sites, algorithm, API contract
- [research-ux.md](./research-ux.md): editor and preview patterns
- [research-security.md](./research-security.md): W1–W5, A1–A5
- [research-practices.md](./research-practices.md): reuse, module boundaries
- [research-recommendations.md](./research-recommendations.md): phasing, risks
