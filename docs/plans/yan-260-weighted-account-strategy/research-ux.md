# UX Research — YAN-260 Weighted Account Strategy

## Executive Summary

Dashboard has zero weighted-strategy UI today: per-provider control is a Round-Robin `Toggle` (binary on/off, default = fill-first) plus a bare numeric "Sticky" input. The backend already understands `"weighted"` (`src/shared/services/weightedTargets.js:9-16`) and computes effective weight from plan tier, quota headroom, and a manual override (`open-sse/services/quotaSnapshot.js:336-380`). Three UI additions needed, all using existing components — no new component files required: (1) strategy `Toggle` → `Select` in two places (provider detail page + profile settings), (2) Plan/Weight fields in the shared `EditConnectionModal`, (3) weight/share badges in the two `ConnectionRow` implementations.

## Existing Components to Reuse

| Component          | Path                                          | API notes                                                                                            |
| ------------------ | --------------------------------------------- | ---------------------------------------------------------------------------------------------------- |
| `Select`           | `src/shared/components/Select.js:5`           | `{ value, label }[]` options, built-in `label`, `hint`, `error` props; native `<select>` (free a11y) |
| `Input`            | `src/shared/components/Input.js:5`            | `label`, `hint`, `error`, `type="number"` supported                                                  |
| `Toggle`           | `src/shared/components/Toggle.js:5`           | `role="switch"`, `aria-checked` — pattern to keep for booleans only                                  |
| `Badge`            | `src/shared/components/Badge.js:20`           | variants `default/primary/success/warning/error/info`, `size="sm"`, `dot`                            |
| `Modal`            | `src/shared/components/Modal.js:8`            | sizes `sm..full`, body scrolls; edit modal uses default `md`                                         |
| `Tooltip`          | `src/shared/components/Tooltip.js:3`          | hover-only, `max-w-56`, used for icon explanation (`CapacityBadges.js:17`)                           |
| `SegmentedControl` | `src/shared/components/SegmentedControl.js:5` | icon+label pills — alternative to Select for strategy, but no disabled/hint support                  |

Key integration points:

- Provider page strategy block: `src/app/(dashboard)/dashboard/providers/[id]/page.js:1571-1591` (Toggle + Sticky input), state/save at `:100-101,390-392,451-453,475-476`.
- Global strategy control: `src/app/(dashboard)/dashboard/profile/page.js:1613-1650` (Round Robin Toggle `:1620-1628`, Sticky Limit Input `:1640-1648`), summary line `:1690-1697`.
- Edit modal: `src/shared/components/EditConnectionModal.js` — region `Select` precedent at `:282-289`, `providerSpecificData` write precedent at `:168-182`.
- Connections list rows: `src/app/(dashboard)/dashboard/providers/[id]/ConnectionRow.js:197-228` (badge row — already renders `#{priority}`, `Auto: {globalPriority}`) and `src/app/(dashboard)/dashboard/providers/components/ConnectionsCard.js:179-200` (legacy; only used by media-providers page — keep parity but lower priority).
- Plan capacity source: `open-sse/config/quotaSnapshot.js:19-55` (`PLAN_CAPACITY`, only 6 providers; `_verify` flags exist).
- Tier persistence: `providerSpecificData.planTier` written by `src/sse/services/quotaSnapshotSync.js:141-165` (auto-detected, debounced). Manual flag must live alongside (e.g. `planTierManual: true`) so the syncer can skip manual rows.
- Effective-weight inputs: `computeEffectiveWeight` returns `{ weight, base, baseSource ("manual"|"plan"|"default"), headroom, headroomSource ("header"|"probe"|"static"), belowFloor }` — exactly the fields the visibility badges need (`open-sse/services/quotaSnapshot.js:336-380`).
- Existing usage API already returns `quotaSnapshot` per connection (`src/app/api/usage/[connectionId]/route.js:212-215`).

## User Workflows

1. **Enable weighted routing** (per provider): provider detail page → Strategy select → "Weighted — by plan & remaining quota". Sticky input stays visible (weighted honors sticky for OAuth anti-abuse); default changes to >1 with helper text.
2. **Enable globally**: profile → Routing Strategy card → select replaces Toggle; sticky shown for both round-robin and weighted.
3. **Correct a plan tier**: Edit Connection → Plan select shows "Auto-detected: Max 20x"; user picks another tier or "Auto (detected)". Stored as `providerSpecificData.planTier` + manual flag.
4. **Exclude/tune an account**: Edit Connection → Weight override numeric (blank = auto from plan; 0 = exclude). Reflected next refresh as row badge `w=0 (manual) — excluded`.
5. **Audit distribution**: connections list shows per-row `Badge`: weight, share %, source (header/probe/plan/manual).

## Proposed Minimal UX (labels / placement)

**Strategy select (both locations)** — `Select` with options:

- `fill-first` → "Fill First — priority order (default)"
- `round-robin` → "Round Robin — equal rotation"
- `weighted` → "Weighted — by plan & remaining quota"

Hint under weighted (provider page: small `<p className="text-xs text-text-muted">`; profile: existing hint pattern `profile/page.js:1616-1618`):

> "Distributes requests by plan capacity × remaining quota. OAuth subscription accounts keep a sticky limit above 1 — per-request balancing across Claude OAuth accounts risks anti-abuse flags."

**Edit modal additions** (after Priority, before API Key block — `EditConnectionModal.js:214`):

- `Select label="Plan"`, options from `PLAN_CAPACITY[provider]` humanized, first option `""` → "Auto (detected)". Hint: `Auto-detected: Max 20x` when `providerSpecificData.planTier` known; else "Not detected yet — leave on Auto". Only render when `PLAN_CAPACITY[provider]` exists.
- `Input label="Weight override" type="number" min={0}`, placeholder "Auto", hint: "Blank = derive from plan. 0 excludes this account from weighted routing."

**Row visibility** (both ConnectionRow files, in badge row):
`<Badge variant="info" size="sm">w 4.2 · 38%</Badge>` + `<Badge variant="default" size="sm">plan</Badge>` (source: header/probe/plan/manual). `w 0` → `variant="warning"`, text "excluded". Only render when provider strategy is weighted.

**Plan tier humanization** — one helper (e.g. `src/shared/utils/planTier.js`): `default_claude_max_20x` → strip provider prefix `default_claude_`, replace `_` → space, title-case → "Max 20x". Mapping table for the ~25 known tiers beats regex guessing; fallback = title-cased remainder.

## Error Handling — Validation States

| Field            | State                                   | UI behavior                                                                     |
| ---------------- | --------------------------------------- | ------------------------------------------------------------------------------- |
| Weight override  | negative / NaN                          | `Input error="Must be 0 or greater"`; block save                                |
| Weight override  | `0`                                     | allowed; hint flips to "Account excluded from weighted routing" (warning color) |
| Weight override  | blank                                   | valid = auto; no error                                                          |
| Plan select      | provider not in `PLAN_CAPACITY`         | field hidden entirely                                                           |
| Plan select      | tier detected, user overrides           | show subtle "Manual" `Badge` next to label; syncer must not overwrite           |
| Sticky limit     | weighted + sticky = 1 on OAuth provider | non-blocking `warning` Badge: "Sticky > 1 recommended for OAuth accounts"       |
| Snapshot unknown | no headroom data                        | row badge shows `w —` with `Tooltip` "No quota data yet; static weight used"    |

## Performance UX

- Weight/share badges derive from data already fetched (`/api/providers` connections + `quotaSnapshot` from usage route); compute share client-side (Σ weights), no new endpoints strictly required. If snapshot data isn't in the list payload, add one lightweight `/api/providers/[id]/weights` fetch — debounced, `cache: "no-store"`, matching existing fetch patterns (`ConnectionsCard.js:473-477`).
- No polling: weights refresh on page load / after edit save (`fetch_()` already re-runs, `page.js:1940`).
- Badges are pure render — no per-row timers (unlike `CooldownTimer`).

## Competitive Analysis

- **LiteLLM**: weight is a plain integer field per deployment (`weight: 9` = picked 9× more); strategy chosen as a routing-strategy enum (`simple-shuffle` default). UI offers no source attribution — 9Router's plan/probe/header source badge is a differentiator. Docs emphasize "weight N → picked N× more often" phrasing — mirror that in helper text.
- **new-api**: channel edit dialog has `Priority` (tier ordering) + `Weight` (random pick among same priority, default 0) under an "advanced config" disclosure; multi-key mode offers "Round Robin | Weighted Random" select per channel. Takeaway: keep priority vs weight visually separate (9Router already has `#{priority}`); put weight next to plan, not next to priority.
- Common pattern across both: **integer weights, default auto/0, no percentages in edit UI** — percentages only appear (if at all) in list/monitoring views. Matches the proposal: numeric input in modal, % share only in row badge.

## Recommendations

**Must**

1. Replace both strategy Toggles with `Select` (3 options above); keep sticky input, visible for round-robin and weighted.
2. Add Plan `Select` + Weight `Input` to shared `EditConnectionModal` (one edit modal serves provider page + ConnectionsCard).
3. Weight/share/source badges in `[id]/ConnectionRow.js` badge row (only under weighted strategy).
4. Anti-abuse helper text wherever weighted + OAuth (`isOAuth` flag already passed to rows).
5. Manual-tier flag (`planTierManual`) so auto-detection never clobbers user choice.

**Should** 6. Warning Badge when weighted OAuth provider has sticky = 1. 7. `src/shared/utils/planTier.js` humanizer with explicit tier-label map (i18n-ready, project already uses `translate()`). 8. Weight=0 confirmation inline (hint color change), not a modal.

**Nice** 9. Mini share bar (stacked % bar above list) once weighted — pure CSS, one div per connection. 10. "Reset to auto-detected" link-button beside Plan select when manual. 11. `SegmentedControl` variant of strategy picker on desktop; Select is safer for i18n string length.

## Accessibility

- `Select`/`Input` already render `<label>` + hint/error text; always pass `label`, never placeholder-only.
- Strategy select is not a Toggle — do not reuse `role="switch"`; native select keyboard flow is correct.
- Badges are decorative status: wrap weight info in the badge text itself (`w 4.2 · 38% · plan`), not color-only.
- Tooltip (hover-only) must duplicate info available in text — do not put exclusive info in `Tooltip`.

## Open Questions

1. Where does the list view get weights — extend `/api/providers` response with `computeEffectiveWeight` output, or separate endpoint? (Backend task; affects badge freshness.)
2. Does per-provider sticky limit for weighted share the existing `stickyRoundRobinLimit` key or a new `stickyWeightedLimit` key? Sharing is simpler; default value differs (>1 for OAuth).
3. Should `planTierManual` live in `providerSpecificData` (alongside `planTier`) or as top-level connection column? Syncer (`quotaSnapshotSync.js:150-164`) currently rewrites the whole `providerSpecificData` blob — flag must be merged, not replaced.
4. Media-providers `ConnectionsCard` (legacy strategy UI): full parity or round-robin-only? Weighted has no meaning for non-quota providers — likely hide the weighted option there.
5. Humanized tier labels: translate via i18n runtime or keep English (plan names are brand terms)?
