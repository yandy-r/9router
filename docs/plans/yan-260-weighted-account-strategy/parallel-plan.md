# YAN-260: Weighted account strategy implementation plan

Research: seven `research-*.md` files and `feature-spec.md` here. YAN-259 shipped `computeEffectiveWeight`, quota snapshots, capacity table and SWRR; this phase wires account selection plus controls. No new dependencies or schema. Keep existing round-robin/fill-first branches stable; no 429 reset-only synthetic quota window.

## Worktree Setup

- **Parent**: /home/yandy/Projects/github.com/yandy-r/9router/.config/opencode/worktrees/9router-feat-yan-260/ (branch: feat/yan-260-weighted-account-strategy; already created)

## Critically Relevant Files and Documentation

- `CLAUDE.md`, `open-sse/AGENTS.md`, `docs/ARCHITECTURE.md`; read before editing routing/OAuth.
- `open-sse/services/quotaSnapshot.js`, `open-sse/services/weightedRoundRobin.js`, `open-sse/config/quotaSnapshot.js` — phase-1 primitives, do not duplicate.
- `src/sse/services/auth.js`, `src/sse/services/quotaSnapshotSync.js`, `src/lib/db/repos/connectionsRepo.js` — selection, tier sync, re-login merge.
- `src/app/api/settings/route.js`, `src/app/api/providers/[id]/route.js`, `src/app/api/providers/route.js`, `src/app/api/usage/[connectionId]/route.js` — dashboard API contracts.
- `src/shared/services/weightedTargets.js`, `src/shared/services/quotaSnapshotPoller.js` — global weighted gate.
- `src/shared/components/EditConnectionModal.js`, `src/app/(dashboard)/dashboard/providers/[id]/{page.js,ConnectionRow.js}`, `src/app/(dashboard)/dashboard/providers/components/ConnectionsCard.js`, `src/app/(dashboard)/dashboard/profile/page.js`, `src/shared/components/NoAuthProxyCard.js` — strategy UI surfaces. Usage `ProviderLimits/index.js` uses shared edit modal and already passes form data through unchanged.
- `tests/unit/antigravity-quota-routing.test.js`, `tests/unit/weighted-round-robin.test.js` — test patterns.

## Design

- Pure `selectWeightedConnection({connections, provider, model, stickyLimit, state, getSnapshot, now})` returns `{connection, nextState, continued}`; caller owns DB and `Map` per provider. Use `computeEffectiveWeight` and `pickSmoothWeighted`. SWRR candidates weight>0; none => all at 1. Sticky holder must have weight>0, lastUsedAt and count<limit. Explicit preferred pin still wins. `auth.js` persists `lastUsedAt` and `consecutiveUseCount` exactly as old round-robin pattern, without altering old branches.
- Weighted default sticky 3 for OAuth subscription IDs, 1 for others; explicit configured 1 allowed with warning. Reuse existing settings key. Snapshot header/probe data has model-specific windows; pass request model.
- Manual override `providerSpecificData.{planTier,planTierManual,weight}`; plan tier selected only from provider capacity table. Null clears fields. Detection must preserve manual tier, OAuth re-login must preserve manual metadata. API returns derived weight even without snapshot; share % computed from active peer weights in UI, marked estimate.
- Selection passes `psd.planTier` only when `planTierManual === true`; otherwise detected snapshot tier wins (avoids freezing stale auto tier), with persisted auto tier as fallback only if snapshot lacks tier. Manual flag blocks `persistPlanTier` and `fetchAndPersistClaudePlanTier` writes, but not probe `fallbackTier` snapshot fill. Sticky test fixtures use tier keys `default_claude_max_20x`/`pro`, used fractions 0.1/0.8/0.
- Existing per-provider override preserves unrelated keys (`rotateStrategy`, `proxyPoolId`) when UI saves fallback/sticky. Edit modal merges existing psd plus region/Azure/Cloudflare fields plus weighted fields in one object; blank sends null to clear.
- Settings PATCH validates strategy enum and sticky bounds (without rejecting existing rotateStrategy/proxyPoolId from no-auth settings). Retain unknown existing per-provider fields for compatibility. Global weighted starts quota poller and polls eligible connections. No secrets in docs or tests.

## Implementation Plan

### Phase 1 — Core + independent backend (parallel, disjoint files)

#### Task 1.1: Account selection and routing

**Depends on:** [none]. **Files to Modify/Create:** `src/sse/services/accountSelection.js` (create), `src/sse/services/auth.js`, `tests/unit/weighted-account-selection.test.js` (create).

**READ THESE BEFORE TASK:** `feature-spec.md`, `auth.js:46-280`, `quotaSnapshot.js:261-390`, `weightedRoundRobin.js`, `antigravity-quota-routing.test.js`, `open-sse/AGENTS.md`, `docs/ARCHITECTURE.md`.

Implement pure helper, in-memory per-provider SWRR state with reset export, weighted branch after pin and existing filters, sticky persistence. No-op for fill-first/round-robin; add focused tests for both via `getProviderCredentials` integration mocks and weighted distribution (18:4:1 ±2% of 1000), floor, zero, all exhausted, model window, no-data, sticky, excludes/pins. Keep tests lean (single file if practical). Prove tests pass.

#### Task 1.2: Manual tier persistence and connection validation

**Depends on:** [none]. **Files to Modify/Create:** `src/sse/services/quotaSnapshotSync.js`, `src/lib/db/repos/connectionsRepo.js`, `src/app/api/providers/[id]/route.js`, `tests/unit/weighted-account-overrides.test.js` (create).

**READ THESE BEFORE TASK:** `feature-spec.md`, `quotaSnapshotSync.js:141-244`, `connectionsRepo.js:162-230`, `providers/[id]/route.js`, `open-sse/services/quotaSnapshot.js` (sanitizer), `open-sse/config/quotaSnapshot.js`.

Validate new `weight` finite 0..1000, `planTier` allowed tier, `planTierManual` boolean, null clears; reject dangerous psd keys; keep existing unrelated psd fields (OAuth/proxy/region compatibility). Preserve manual plan/weight/flag on OAuth re-login (same provider+identity dedup) without overwriting other OAuth fields; auto-detected tier only persists when manual flag not set. Write critical regression tests for validation, reset and preservation. Probe snapshot may hold detected tier, but selection explicitly passes manual `psd.planTier`.

#### Task 1.3: Settings + poller gate

**Depends on:** [1.1] (imports account-selection reset export). **Files to Modify/Create:** `src/app/api/settings/route.js`, `src/shared/services/weightedTargets.js`, `src/shared/services/quotaSnapshotPoller.js`, `tests/unit/weighted-settings-poller.test.js` (create or extend existing poller test).

**READ THESE BEFORE TASK:** `feature-spec.md`, `settings/route.js`, `weightedTargets.js`, `quotaSnapshotPoller.js:120-183`, `tests/unit/quota-snapshot-poller.test.js`, `NoAuthProxyCard.js`.

Validate global/per-provider fallbackStrategy enum, sticky integer 1..100, dangerous map keys; preserve `rotateStrategy` and noauth settings. Reset SWRR on account strategy edits, reconfigure poller on global fallbackStrategy edits. `weightedProviders` must include all eligible providers when global account strategy is weighted; per-provider fill-first override should exclude it unless combo needs it. `configureQuotaSnapshotPoller` starts on global weighted. Tests for invalid input 400/no persist and global-only poller target/gate; avoid full suite for CI-only changes, but this touches app.

### Phase 2 — Visibility and UI (parallel by file ownership)

#### Task 2.1: Weight API and read view

**Depends on:** [1.2]. **Files to Modify/Create:** `src/app/api/providers/route.js`, `src/app/api/usage/[connectionId]/route.js`, `tests/unit/weighted-provider-view.test.js` (create if missing contract coverage).

**READ THESE BEFORE TASK:** `feature-spec.md`, `providers/route.js:62-97`, `usage/[connectionId]/route.js:194-215`, `quotaSnapshotSync.js:251-280`, `quotaSnapshot.js:336-390`.

Add `effectiveWeight` (decomposed object) to safe provider-list rows, using persisted manual weight and tier even when snapshot absent. Pass manual weight to usage snapshot view. Do not leak access tokens. Tiny API contract check.

#### Task 2.2: Shared edit modal + strategy options

**Depends on:** [1.2]. **Files to Modify/Create:** `src/shared/components/EditConnectionModal.js`, `src/shared/constants/accountStrategies.js` (create), optionally small `src/shared/components/WeightedConnectionFields.js` (create if modal large). No other files.

**READ THESE BEFORE TASK:** `feature-spec.md`, `EditConnectionModal.js`, `Select.js`, `Input.js`, `PLAN_CAPACITY` config.

Add Plan (Auto + known provider tiers; detected label), Weight override (blank auto, 0 exclude), client-side bounds, safe partial psd merge with existing region/proxy save; label/hint accessible. Share one constant for strategy options/labels across three pickers. Keep modal's unrelated fields intact.

#### Task 2.3: Provider page and connection row

**Depends on:** [2.1, 2.2]. **Files to Modify/Create:** `src/app/(dashboard)/dashboard/providers/[id]/page.js`, `src/app/(dashboard)/dashboard/providers/[id]/ConnectionRow.js`.

**READ THESE BEFORE TASK:** `feature-spec.md`, page strategy handlers/JSX, row badge area, `accountStrategies.js`.

Replace boolean per-provider toggle with select offering Inherit, Fill First, Round Robin, Weighted; retain sticky field for round-robin/weighted; save per-provider override and preserve unrelated per-provider settings keys; show OAuth anti-abuse hint/warning. Pass derived `effectiveWeight`/share for active peers to rows and render text badges for weight/share/base/headroom source; static/unknown distinguishable. No new network fetch.

#### Task 2.4: Global and media provider controls

**Depends on:** [2.1, 2.2]. **Files to Modify/Create:** `src/app/(dashboard)/dashboard/profile/page.js`, `src/app/(dashboard)/dashboard/providers/components/ConnectionsCard.js`. NoAuthProxyCard already uses separate `rotateStrategy`, so it must stay unchanged; media page must preserve that field when saving fallbackStrategy.

**READ THESE BEFORE TASK:** `feature-spec.md`, controls in both pages, `accountStrategies.js`.

Replace global boolean toggle with select and per-media provider toggle with select (including Inherit). Weighted sticky field/help and OAuth warning; preserve existing round-robin values and noauth `rotateStrategy`. For media list, show derived weight/share badges when weighted (if rows have data from GET). Avoid editing T6-owned files.

### Phase 3 — Verification, review, ship

#### Task 3.1: Verify, review, ship

**Depends on:** [2.1, 2.2, 2.3, 2.4]. **Files to Modify:** only review-fix targets. **READ THESE BEFORE TASK:** all task diffs, `.github/pull_request_template.md`.

- Reconcile T1/T3 shared reset import and T4–T7 display fields. Run focused tests after each batch, then `npm test` (full suite because app changed, assess known-fails gate), `npm run lint`, `npm run build`, `node tests/__baseline__/verify-no-regression.mjs tests/results.json` if needed. No live provider calls/secrets.
- Review uncommitted changes with independent code-reviewer (security, routing, UI, test coverage), fix all material findings, re-run focused checks. Open PR using repo template, link `Closes #104` and YAN-260; conduct PR review and fix review findings. Monitor GitHub CI to green; squash merge; remove local/remote branch and worktree, close Linear ticket only after merge verified.

## Advice

- Verify no existing user work overwritten. All agents share one worktree; own only assigned files.
- `weightedProviders` currently ignores global strategy; avoid polling every provider when overrides opt out.
- Never set `planTierManual` on auto-detected OAuth writes; preserve only user-marked manual tier on re-login.
- Explicit weight 0 still fail-opens if sole candidate; UI must not promise hard disable (use isActive=false for that).
- Review constraint: no new tests beyond routing/validation/persistence/visibility-critical contracts. Formatting and documentation-only edits do not trigger full suite.
