# Feature Spec: YAN-260 Weighted Account Strategy

## Executive Summary

Add `weighted` as third account-routing strategy, alongside `fill-first` and `round-robin`. Reuse YAN-259 quota snapshots, `computeEffectiveWeight`, plan capacities, and smooth weighted round-robin (SWRR). Sticky windows stay on same account for configured request count; manual plan/weight overrides and weight/share/source visibility make behavior controllable and explainable. Current retry/lock behavior stays intact. Risks: global-weighted mode currently leaves quota poller idle, auto tier detection overwrites manual selections, and per-request Claude OAuth rotation can trip anti-abuse controls.

## External Dependencies

### APIs and Services

No new network APIs. Existing Claude OAuth `anthropic-ratelimit-unified-5h/7d-utilization` and Codex `x-codex-*-used-percent` headers feed `open-sse/services/quotaHeaders.js`; existing probes feed `src/sse/services/quotaSnapshotSync.js`. Codex 429 `resets_at` reaches model lock already, while response headers are ingested before error handling. A reset-only 429 body has no utilization to persist as a headroom window; keep model lock as authority, do not fabricate quota fractions.

### Libraries and SDKs

No new dependencies. Use `pickSmoothWeighted` (`open-sse/services/weightedRoundRobin.js`) and `computeEffectiveWeight`/`getSnapshot` (`open-sse/services/quotaSnapshot.js`). [nginx load balancing](https://nginx.org/en/docs/http/load_balancing.html) describes weighted round-robin; [ccflare load balancing](https://github.com/snipeship/ccflare/blob/main/docs/load-balancing.md) documents OAuth anti-abuse stickiness. See [external research](research-external.md) for headers and competitor details.

## Business Requirements

### User Stories

- Multi-account operator enables weighted routing per provider or globally and sees traffic proportional to plan capacity × remaining quota.
- Operator sets a plan tier manually if detection fails, or enters a nonnegative weight override; zero excludes account while another positive candidate exists.
- Operator sees effective weight, approximate share percentage, and base/headroom source per connection.
- Caller keeps existing retries, model locks, pins, and fail-open behavior when all quota windows are below floor.

### Business Rules

1. Filter model locks, excludes, and Antigravity quota-cache blocks first. Explicit preferred connection still bypasses strategy.
2. Weight = manual base (if present), else capacity of persisted plan tier, else snapshot tier, else 1; multiplied by model-applicable headroom. Below floor (0.05) yields 0. Filter weight > 0; if none, use all available at equal fallback weights. Single manually excluded account still works.
3. Sticky current account if it is most recently used, its consecutive count < limit, and effective weight > 0. Otherwise start a new window via SWRR. Sticky default 3 for OAuth subscription providers; explicitly configured 1 remains valid (UI warns about abuse risk). Non-subscription providers default 1. Existing round-robin default remains unchanged.
4. SWRR state in memory per provider; losing it on restart affects balance precision only. Persist `lastUsedAt`/`consecutiveUseCount` on each weighted selection under existing mutex.
5. Global and per-provider strategy values restricted to `fill-first|round-robin|weighted`. Manual weight finite 0..1000, plan tier from provider's `PLAN_CAPACITY` list; blank resets to auto.
6. Provider connection re-login must preserve existing manual override metadata even if fresh OAuth tokens replace the nested `providerSpecificData` object. Tier sync must not overwrite manual plan.

### Edge Cases

| Scenario                                   | Result                                                                                   |
| ------------------------------------------ | ---------------------------------------------------------------------------------------- |
| No snapshot and no plan                    | Equal-weight SWRR                                                                        |
| All candidates below floor or manual zero  | Equal-weight fail-open selection among available accounts                                |
| Current account drops below floor          | Next request opens new window with eligible account; existing pre-filter locks still win |
| Retry excludes last pick                   | SWRR sees only filtered candidates; retry mechanics unchanged                            |
| Explicit pin or virtual no-auth connection | Unchanged, bypass weighted logic                                                         |
| Strategy changed to/from weighted          | Reset in-memory SWRR state; persisted sticky count may be reused safely                  |

### Success Criteria

- 1000 selections across Max20x 10% used, Max20x 80% used, Pro 0% used with sticky 1 give shares ≈18:4:1 ±2% total.
- Unit checks cover sticky/floor/all-exhausted/zero/manual/no-data and existing fill-first/round-robin. Integration check covers `getProviderCredentials`; baseline gate stays green.

## Technical Specifications

### Architecture Overview

`GET /api/providers` enriches safe connection rows with current effective weights. Dashboard presents share and source. `PATCH /api/settings` validates strategy and triggers poller and SWRR reset. `PUT /api/providers/[id]` validates manual plan/weight and merges with existing settings. On request, `getProviderCredentials` filters, resolves strategy, invokes pure `selectWeightedConnection` (weight computation, sticky check, SWRR) and persists sticky count. Snapshot store stays bounded and in-memory.

### Data Models

- Existing `providerConnections.providerSpecificData` JSON: `planTier` (string or absent), `planTierManual` (boolean), `weight` (number 0..1000 or absent). No migration. Auto plan follows existing detection; manual tier persists across sync/re-login. `weight` overrides base, not live headroom.
- Existing persisted `lastUsedAt`, `consecutiveUseCount` provide sticky window. `Map<providerId, Map<connectionId,currentWeight>>` in-memory only, pruned by SWRR on pick and reset when account strategy changes.
- Existing settings: `fallbackStrategy`, `stickyRoundRobinLimit`, `providerStrategies[providerId].fallbackStrategy`/`.stickyRoundRobinLimit`.
- Derived display: `{weight, base, baseSource, headroom, headroomSource, belowFloor, sharePct}`; share denominator excludes inactive/locked? UI should count active connections and weight>0; model locks are request-specific, so UI states estimate not guarantee.

### API Design

- `PATCH /api/settings`: reject invalid global/per-provider `fallbackStrategy` (400); reject unsafe provider-strategy map keys and invalid sticky values. Other existing setting keys/strategy shapes unchanged. Reset SWRR and configure poller when global/per-provider settings change.
- `PUT /api/providers/[id]`: validate `providerSpecificData.weight` (finite number 0..1000 or null to clear), `planTier` (known tier for provider or null to reset), `planTierManual` boolean. Preserve existing proxy/region/auth metadata untouched, reject malformed weighted fields and unsafe map keys. Current route accepts other provider-specific fields; do not break existing fields while narrowing new weighted input.
- `GET /api/providers`: add `effectiveWeight` for each connection from `computeEffectiveWeight` using persisted tier/manual weight and `getSnapshot`. Do not expose credentials. Client computes share among active peers. `GET /api/usage/[connectionId]` passes manual fields to `buildQuotaSnapshotView`, including when snapshot absent if needed.
- No new endpoints or tables.

### System Integration

- `src/sse/services/accountSelection.js`: pure helper with inputs available connections, provider, model, sticky limit, previous SWRR map, snapshot getter, timestamp; returns selected connection, next SWRR map and new/sticky-window flag. No DB side effects. `auth.js` owns per-provider map and DB writes.
- `src/shared/services/weightedTargets.js` + `quotaSnapshotPoller.js`: global `fallbackStrategy === 'weighted'` includes all eligible providers (can use connection provider IDs; bounded existing poller) and starts scheduler.
- `src/sse/services/quotaSnapshotSync.js`: detection preserves manual plan. `connectionsRepo.js` preserves manual metadata on OAuth re-login; no new credential fields logged.
- UI: shared `Select` and `Input`; shared strategy options constant for profile, provider page, media-provider `ConnectionsCard`. Shared edit modal gets plan/weight; both connection-list variants show weight/share/source.

## UX Considerations

### User Workflows

1. Pick “Weighted — by plan & remaining quota” globally or per provider. Sticky limit remains editable and defaults to 3 for OAuth subscriptions, 1 elsewhere unless set.
2. Edit connection: Plan “Auto-detected: Max 20x” or known capacity tier; Weight blank=auto, 0=exclude, positive=manual capacity. Save once; row updates.
3. Read connection badge: effective weight, estimated share, and source (manual/plan/default plus header/probe/static), with below-floor/excluded text.

### UI Patterns

Native `Select` for three strategies, labelled numeric `Input`, textual `Badge`; do not convey meaning by color alone. Explain OAuth risk: rapid per-request switching between Claude subscription accounts may trigger anti-abuse flags; prefer sticky limit above 1. No new polling or per-row network request; use existing provider list response. Display static/unknown when snapshot absent rather than claim live quota.

## Recommendations

### Implementation Approach

Split work into independent backend routing, persistence/settings, and UI batches. Keep previous routing behavior unchanged; avoid a new dependency. Prefer pure helper + narrow integration test. Preserve explicit user sticky=1 while warning on OAuth risk; do not silently override preference.

### Technology Decisions

Use equal-weight fallback when all effective weights are zero; concentration under exhausted quota is riskier than spreading attempts. Keep SWRR per process (no DB writes beyond existing sticky persistence). `planTierManual` is explicit flag so “Auto” clears it. Do not synthesize 429 quota fractions from reset-only error bodies: headers already ingested and locks handle 429 precisely.

## Risk Assessment

### Technical Risks

- Global weighted poller gap: fix both scheduler gate and provider targeting, test.
- Manual plan overwrites on probe or re-login: skip auto-persist and preserve manual metadata in dedup merge, test.
- Round-robin regression due to shared sticky columns: leave its selection branch unchanged, test old behavior.
- UI share estimates lack model-specific quota context: label approximate, compute from current static/general windows.

### Security Considerations

- **Critical:** settings and connection routes historically spread arbitrary dashboard JSON; validate new weighted fields before merges and block dangerous keys; broader mass-assignment hardening outside this feature should not break existing OAuth/proxy flows.
- **Warning:** bound finite weight/sticky values and tier strings; retain dashboard auth boundary and never send credentials with weight metadata. OAuth rapid rotation can risk bans, so default sticky >1 and display warning for 1.
- **Advisory:** multi-process SWRR precision and stale in-memory state are acceptable for this phase.

## Task Breakdown Preview

1. Backend selection and focused tests, including fill-first/round-robin regression coverage.
2. Settings/connection validation, global poller gate, manual-tier persistence, GET visibility fields, critical API tests.
3. UI strategy/select/edit/list in parallel by disjoint file ownership, then integration check, lint/build/baseline.
4. PR review, fixes, green CI, squash merge, branch/worktree cleanup, Linear close.

## Decisions Needed

None blocking. Chosen: sticky OAuth default 3 (explicit 1 allowed), weight cap 1000, equal fail-open weights, JSON override storage, approximate active-account share, no fabricated 429 window.

## Research References

[External](research-external.md) · [Business](research-business.md) · [Technical](research-technical.md) · [UX](research-ux.md) · [Security](research-security.md) · [Practices](research-practices.md) · [Recommendations](research-recommendations.md). Issue: [YAN-260](https://linear.app/yandy-r/issue/YAN-260/accounts-weighted-account-selection-strategy-manual-planweight), [GitHub #104](https://github.com/yandy-r/9router/issues/104).
