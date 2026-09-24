# UX research: weighted combo strategy (YAN-261)

Scope: dashboard combo card + media combo page. Engine formula is fixed by the brief; this file only covers how to show and edit it. Reuse `Select`, `Input`, `Card`, `Toggle`. No new component.

## Executive Summary

Add `weighted` to `STRATEGY_OPTIONS` and, only when that strategy is selected, show one relative-weight control per model inside `ComboCard`. Preview first-choice share as `weight × headroom`, renormalized across the combo. Weight `0` is "fallback only", not "delete". Unknown quota is full weight (headroom 1), never "exhausted".

**Confidence**: High — matches `combos/page.js` strategy UI (`STRATEGY_OPTIONS` 343–347, `ComboCard` 349–483, `handleSetComboStrategy` 194–217) and phase-1 headroom (`getProviderHeadroom` treats missing snapshot as headroom 1, `quotaSnapshot.js` 297–323).

Competitors agree on one rule: share = this weight / sum of weights; the numbers do not need to total 100. They disagree on all-zero. Route 53 then sends equal traffic. This product must not: all-zero stays fallback order. Say that in the card.

**Confidence**: High for the formulas (Cloudflare, Route 53, Portkey official docs). Route 53's zero-weight + health-check rule is a close precedent for our "fallback only" semantics (see Competitive Analysis). Medium on LiteLLM dashboard widgets — its weight UI is config-first; LiteLLM `simple-shuffle` does honor weights with failover exclusion, but only within that strategy.

## User Workflows

1. **Pick strategy.** User opens `/dashboard/combos`. `Select` already sits on the card (`combos/page.js` 422–429). New option: `{ value: "weighted", label: "Weighted — by weight & remaining quota" }`. Add the same one-line explanation under the page header list (234–249), next to Fallback / Round Robin / Fusion.
2. **Set weights.** Strategy `weighted` reveals a block under the model chips, same placement as the Fusion judge row (392–416). One row per `combo.models` entry: model id, number input default **1**, live "≈ share %". Missing key means 1 (`weights[model] ?? 1`). Do not write a `1` into settings until the user changes it.
3. **Read the preview.** Share is first-choice probability, not "this model always answers". Copy: "≈ 75% first choice". Tail order stays the list order (drag order in the edit modal). Do not imply failover percentage.
4. **Park a model.** User sets weight `0`. Row label switches to **Fallback only**. Share shows 0%. Model stays in the list and in the failover tail.
5. **All weights 0.** Banner on the card: "No model leads. Requests use fallback order." Do not show equal split. Route 53 does the opposite; copying that label would be wrong.
6. **Quota moves.** Headroom only scales a weight down. User weight `3` stays `3` in the input. Share % moves. If quota data is absent, share uses headroom 1 and the row says quota is unknown — do not render a fake 0% or a red "empty" bar.
7. **Switch away and back.** Leaving `weighted` for `fallback` deletes the `comboStrategies` entry today (`handleSetComboStrategy` 201–205 drops the entry when strategy is fallback, which also drops `weights`). Returning to weighted restores defaults (all 1), not a deleted map. Keeping weights across strategy changes is a storage change — see Open Questions.
8. **Media combo.** `media-providers/combo/[id]/page.js` 176–187 is a round-robin `Toggle` that **replaces** the whole strategy object (`updated[combo.name] = { fallbackStrategy: "round-robin" }`). No weight editor there. Exclude media from weighted in this phase. Do not add a third control that would wipe `weights` if someone later stores them under the same key.

## UI/UX Best Practices

**Control.** Native number input via existing `Input` (`src/shared/components/Input.js`). `type="number"`, `min={0}`, `step={1}`, `inputMode="numeric"`. Integers, not Cloudflare's 0.00–1.00. Acceptance example is `{A:3, B:1}`. Default 1 matches "unset". `Input` already forwards extra props and renders `error` / `hint`.

**Do not use a slider.** Sliders hide the relative-integer model and fight min 0 plus an unbounded top. Route 53 caps at 255; do not copy that cap unless API validation adds one. Soft ceiling: a huge finite value still shares correctly; no max on the control.

**Share preview.** Integer percent; one decimal only when the share is above 0% but under 1% (so it never rounds to a misleading `0%`). Formula:

`effective = (weight ?? 1) * headroom` (headroom missing → 1)

`share = effective / sum(effective)` over models with finite weight ≥ 0

Show `≈ 75%` in `text-[11px] text-text-muted`, same scale as the Judge label. Renormalize when a peer is weight 0. Do not require the inputs to sum to 100 — Cloudflare, Route 53, and Portkey all normalize server-side. A "must total 100" error is the pitfall to avoid.

**Headroom.** Text, not a new badge component. Examples:

- Known: `quota 20% left` (headroom 0.2). Share updates; input does not.
- Unknown / no snapshot (`source: "static"`, `getProviderHeadroom` fallback `{ headroom: 1 }`, `quotaSnapshot.js` 303–329): `quota unknown — full weight`. Share equals user-weight share. Healthy state, not an error color.
- Weight 0: ignore headroom in the label. **Fallback only** wins. Engine keeps headroom on the object but pick weight is 0 (`computeEffectiveWeight` 359–367).

**Floor mismatch (do not hide).** `open-sse/config/quotaSnapshot.js` `floor: 0.05`. `computeEffectiveWeight` forces weight 0 when headroom < floor (370–374). The brief's combo formula is plain multiply, no floor. Preview must use the **combo** formula the picker will use. If the picker calls `computeEffectiveWeight`, a model at headroom 0.04 would show a small % and never lead. Until that choice is fixed, label the preview "user weight × quota" and do not mention the floor in the UI.

**Layout.** Keep the strategy `Select` at `sm:w-[200px]`. Weighted rows go full width under the title block so the select column does not grow. Mirror Fusion: conditional block, no modal. Model ids already render as `code` chips; chips truncate at 3 (`combos/page.js` 378–389), so the weight row must show the full id.

**Accessibility.**

- Each `Input` `label={`Weight for ${model}`}` so the visible name is the accessible name. `Input` does not wire `htmlFor` (`Input.js` 22–26); also pass `aria-label` on the input via props.
- Point `aria-describedby` at the share text and, when weight is 0, the "Fallback only" text.
- Strategy `Select` has no label on the card (424–429). Pass `aria-label="Combo strategy"`. `Select` spreads `...props` onto `<select>` (`Select.js` 41).
- Weight 0 state is text, not color alone.
- Number input stays keyboard editable. No drag handle on the weight (order already has dnd in the edit modal).

**Save behaviour (match the page).** Strategy select: save immediately, same as today (`onChange` → `onSetStrategy`). Weight typing: do **not** PATCH per keystroke. Debounce ~400ms after the value is finite and ≥ 0, and also save on blur — the media name field already saves on blur (`handleSaveName`, media page 138–143). Share preview stays instant in local state. `handleSetComboStrategy` sends the **entire** `comboStrategies` map (207–210); a debounced patch must merge into latest state or a fast strategy change can clobber weights.

## Error Handling

Client, before PATCH (API will 400 anyway):

| Input               | UI                                            | Save                      |
| ------------------- | --------------------------------------------- | ------------------------- |
| empty while focused | no error                                      | do not save               |
| blur while empty    | reset displayed value to 1 (or last saved)    | save 1 only if it changed |
| `-1`, `NaN`, `e`    | `Input` `error="Weight must be 0 or greater"` | do not PATCH              |
| `0`                 | status "Fallback only", no error              | save `0`                  |
| `1.5`               | error "Use a whole number" while step stays 1 | do not PATCH              |

`Select` / `Input` already paint `error` in red with an `error` icon (`Input.js` 54–58). Reuse that. Do not `alert()` — create/update already use `alert` (150, 169); weights stay inline.

PATCH failure: `handleSetComboStrategy` does not check `res.ok` before `setComboStrategies` (207–213). For weights, check `res.ok`; on failure set `Input` `error` and roll the input back to the last saved value.

Unknown headroom is not an error and not `role="alert"`.

All-zero is a warning status (`text-text-muted`), not a field error. Saving it is valid.

## Performance UX

- Preview math is local. No request per digit.
- Headroom is not on `/api/combos` or `/api/settings`. Combo page fetch is only those plus `/api/providers` (`fetchData` 94–100). Per-connection snapshot exists at `/api/usage/[connectionId]` (`quotaSnapshot` on that route, ~line 214). Do not call it once per model per keystroke.
- If a headroom read is added, fetch once when the card enters `weighted`, then refresh no faster than the existing quota poller. Stale snapshot: keep last share. Missing data → unknown state, not a spinner that blocks the inputs.
- Debounce collapses weight edits into one settings PATCH. That PATCH already resets combo rotation server-side (brief). Rapid saves reshuffle the WRR cursor; debouncing is both UX and routing stability.
- Long model lists: the edit modal already caps the list at `max-h-[55vh]` (890). Weight rows on the card should use the same cap plus scroll. Do not mount a second dnd-kit list.

## Competitive Analysis

|                                | Weight control                                                              | Share                                                                                                            | Weight 0                                                                                                    | All zero                 | Sum-to-100               |
| ------------------------------ | --------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------- | ------------------------ | ------------------------ |
| Cloudflare LB, origin steering | 0–1, step 0.01; dashboard shows a read-only **Percent** field beside weight | `weight / sum(weights)`                                                                                          | no traffic (still health-checked)                                                                           | n/a (relative)           | not required             |
| Route 53 weighted              | integer 0–255                                                               | `weight / sum`                                                                                                   | stop sending; **with health checks, zero-weight records serve only when all nonzero records are unhealthy** | **equal** traffic to all | not required             |
| LiteLLM router                 | integer `weight` in YAML / config                                           | weighted pick on `simple-shuffle`; on failure, failed deployment excluded and weights renormalized over the rest | not documented (weighted-random math implies never picked; unverified)                                      | not documented           | not required             |
| Portkey loadbalance            | relative `weight` on targets                                                | normalized, e.g. 5, 3, 1 → 55%, 33%, 11%                                                                         | not specified as fallback-only                                                                              | not specified            | docs say do not need 100 |

Sources (fetched 2026-09-24):

- Cloudflare: <https://developers.cloudflare.com/load-balancing/understand-basics/traffic-steering/origin-level-steering/> — official living docs, retrieved 2026-09-24. Weight 0–1 step .01; `% = endpoint weight ÷ sum of weights`; dashboard exposes Percent.
- Route 53: <https://docs.aws.amazon.com/Route53/latest/DeveloperGuide/routing-policy-weighted.html> and <https://docs.aws.amazon.com/Route53/latest/DeveloperGuide/resource-record-sets-values-weighted.html> — official living docs, retrieved 2026-09-24. Integer 0–255; weight 0 stops primary routing; with health checks it becomes last-resort; **all weights 0 → equal probability**.
- LiteLLM: <https://docs.litellm.ai/docs/routing> — official living docs, retrieved 2026-09-24. `weight` on deployments, weighted `simple-shuffle`, fallback exclusion + renormalization. Docs are YAML-first; no first-party share-% widget found. 2025 correction on strategy scope: <https://github.com/BerriAI/litellm/discussions/9200>.
- Portkey: <https://docs.portkey.ai/docs/product/ai-gateway/load-balancing> — official living docs, retrieved 2026-09-24. Relative weights; gateway normalizes to 100%.

**Confidence**: High on Cloudflare, Route 53, Portkey formulas (official docs). Medium on LiteLLM dashboard widgets — docs are config-first; no share-% control confirmed.

⚠️ **Freshness Note**: LiteLLM weight semantics (2025) change across releases; confirm before copying LiteLLM behavior.

Copy: relative weights, live renormalized percent, no sum check. Do not copy: Route 53 all-zero = equal; Cloudflare 0–1 floats; a 255 cap; LiteLLM's strategy-dependent "weight might be ignored". Our select already makes the strategy explicit.

## Recommendations

1. `STRATEGY_OPTIONS` + header bullet only. Label from the brief.
2. Weighted block inside `ComboCard`, gated by `current === "weighted"`, same pattern as `isFusion`.
3. Per model: `Input` number, min 0, step 1, default display 1. Persist only keys the user set, value finite and ≥ 0.
4. Right of the input: `≈ {pct}%` from `(weight ?? 1) * headroom`, headroom default 1. Second line: quota percent, or `quota unknown — full weight`.
5. Weight 0: replace the percent emphasis with **Fallback only**. Still show `≈ 0%`.
6. All-zero: one line on the card, fallback-order wording. Not Route 53 wording.
7. Strategy change saves immediately. Weight saves debounced (~400ms) and on blur, only when valid. On 400/network error, revert the field and set `Input` `error`.
8. `aria-label` on the strategy select and on each weight input. Status text for 0 and for unknown quota.
9. Media combo: no weighted control. Leave the round-robin toggle.
10. No traffic chart, slider, or "balance to 100%" button.

Skipped: headroom sparkline, per-provider plan tier in the combo UI (brief: plan tiers are not comparable; user weights are the combo control).

## Open Questions

1. **Does `getWeightedModels` apply `floor` 0.05?** Brief says multiply only. `computeEffectiveWeight` zeroes headroom below 0.05. Preview and picker must match. UX assumes plain multiply until told otherwise.
2. **Where does the card read headroom?** No combo-level field on the settings payload. v1 without a batch endpoint should not N+1 `/api/usage/:id`. Honest fallback: always show `quota unknown — full weight` until a batch read exists.
3. **Switching strategy to fallback deletes `weights`.** Confirm that is wanted. If not, prune logic in `handleSetComboStrategy` (201–205) must keep `weights`.
4. **Media later.** Toggle overwrite (181) cannot grow a `weights` object safely. Any future media weights need a merge, not a replace.
5. **Non-integer.** API allows any finite ≥ 0. UI recommendation is integers only. If product wants `0.5`, drop the integer error and set `step="any"`.
6. **Sticky limit** is not on this card today (`comboStickyRoundRobinLimit` is settings-level). Do not surface it in the weight UI unless a later task asks.
