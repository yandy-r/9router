# Feature Spec: YAN-259 — Per-connection quota snapshot + plan-tier detection

## Executive Summary

Phase 1 of the Weighted balancing strategy (YAN-258, GitHub #102/#103). It adds a single bounded, in-memory **quota snapshot store** per connection (`open-sse/services/quotaSnapshot.js`), filled passively from upstream response headers at one hook in `open-sse/handlers/chatCore.js` and actively from the existing `USAGE_HANDLERS` probes. It also adds **plan-tier detection** persisted as `providerSpecificData.planTier`, and a pure **`computeEffectiveWeight`** that phases 2 (YAN-260, accounts) and 3 (YAN-261, combos) consume. The Antigravity quota cache (`src/sse/services/antigravityQuota.js`) is folded onto the store behind its existing API. The strike-breaker is unchanged. Everything is fail-open: parsers and pollers never throw into the request path. Routing behavior does not change in phase 1, because no `weighted` strategy exists yet, so the poller stays idle until phase 2/3 turn it on.

## External Dependencies

### APIs and Services

#### Claude OAuth (passive + profile)

- **Documentation**: undocumented. Captures: <https://github.com/anthropics/claude-code/issues/12829>
- **Authentication**: OAuth bearer (`user:profile` scope for profile)
- **Key Endpoints**:
  - response headers `anthropic-ratelimit-unified-{5h,7d,<claim>}-{utilization,reset,status}`: utilization is a 0–1 fraction used, reset is epoch seconds
  - `GET https://api.anthropic.com/api/oauth/profile` → `organization.rate_limit_tier` (`default_claude_max_20x`, `default_claude_max_5x`, pro…). Setup tokens get 403, which means unknown.
  - `GET /api/oauth/usage` (existing `usage/claude.js`): 0–100 used; 5-min cache and 3-min 429 cooldown already in place

#### Codex (ChatGPT OAuth)

- **Documentation**: [`codex-rs/codex-api/src/rate_limits.rs`](https://github.com/openai/codex/blob/main/codex-rs/codex-api/src/rate_limits.rs)
- **Key Endpoints**: headers `x-codex-{primary,secondary}-{used-percent,window-minutes,reset-at}` (0–100, minutes, epoch seconds); `x-codex-rate-limit-reached-type`; extra families `x-<id>-primary-used-percent` + `x-<id>-limit-name`. The `wham/usage` probe windows carry `limit_window_seconds`.

#### API-key providers

- OpenAI/Groq: `x-ratelimit-{limit,remaining,reset}-{requests,tokens}`. Reset is a duration such as `6m0s`. See [OpenAI rate limits](https://developers.openai.com/api/docs/guides/rate-limits) and [Groq rate limits](https://console.groq.com/docs/rate-limits).
- Anthropic API: `anthropic-ratelimit-{requests,tokens,input-tokens,output-tokens}-{limit,remaining,reset}`. Reset is RFC 3339. See [Anthropic rate limits](https://platform.claude.com/docs/en/api/rate-limits).

### Libraries and SDKs

None added. Uses WHATWG `Headers`, `Number`, `Date`, and the existing `parseResetTime`/`toFiniteNumber` in `open-sse/services/usage/shared.js`.

### External Documentation

- [Research: provider quota/plan data sources](./research-external.md): header and endpoint shapes

## Business Requirements

### User Stories

**Primary User: 9Router operator with several subscriptions**

- As an operator, I want each connection's remaining 5h/weekly headroom known without extra upstream calls, so the Weighted strategy can favor accounts that have room left.
- As an operator, I want the plan tier (Max 20x vs Pro) detected automatically, so heavier plans get proportionally more traffic.
- As an operator, I want to see why an account got its weight (plan, headroom, and the data source), so I can trust or override it.

### Business Rules

1. **Scale normalization**: every stored `usedFraction` is finite and clamped to [0,1]. Non-finite values drop the window. Claude headers use 0–1, Codex and USAGE_HANDLERS use 0–100, Google reports _remaining_ as 0–1.
2. **Unknown ≠ 0 or 100**: missing or malformed data keeps the previous value, or contributes nothing (headroom 1). An Antigravity `remainingPercentage >= 100` reading means unknown.
3. **Expiry**: a window expires at `resetsAt`, or `ttlMs` after it was observed when there is no reset. A snapshot with no live windows is dropped.
4. **Codex classification by window length**, never by slot name, because Pro reports its weekly window as "primary".
5. **Effective weight**: `base × headroom`. The base comes from the manual weight, then the plan table, then 1. Headroom is the minimum of `(1 − usedFraction)` over applicable windows. Headroom below the floor (0.05) gives weight 0.
6. **Fail-open**: ingest, poll and plan detection never throw into request handling. They log at debug level only.

### Edge Cases

| Scenario                                           | Expected Behavior                            | Notes                   |
| -------------------------------------------------- | -------------------------------------------- | ----------------------- |
| Setup-token Claude (profile 403)                   | `planTier` stays null, rechecked after 24h   | no error surfaced       |
| Header missing or `abc`                            | window skipped, previous value kept          | Groq null-guard pattern |
| Codex Pro weekly in "primary"                      | classified `7d` by `window-minutes`          | unit tested             |
| Strike-blocked Antigravity pair + optimistic probe | block survives                               | existing tests          |
| Connection deleted                                 | entry ages out via TTL; store capped at 1000 | bounded memory          |

### Success Criteria

- [ ] One Claude OAuth or Codex request fills the 5h and 7d windows from headers, with no extra upstream call.
- [ ] Plan tier is persisted for Claude, Codex, Gemini/Antigravity, Copilot and Kiro where the credential allows, otherwise null.
- [ ] Malformed headers or probes never fail a request.
- [ ] `antigravity-quota-routing.test.js` and `antigravity-weekly-quota.test.js` stay green, and `verify-no-regression.mjs` passes.

## Technical Specifications

### Architecture Overview

```text
executor.execute ──▶ chatCore.js (ok + error responses)
                      │ ingestResponseHeaders(provider, connectionId, headers)   [fail-open]
                      ▼
              quotaHeaders.parseQuotaHeaders ──▶ quotaSnapshot store (Map, bounded)
                                                   ▲            ▲
 /api/usage/[id] ─┐                                 │            │ view
 quotaSnapshotPoller (weighted-gated) ─▶ quotaSnapshotSync.recordUsageSnapshot
                                         (USAGE_HANDLERS result → windows + planTier persist)
 antigravityQuota.js (strike-breaker) ─── getAntigravityQuotaCache() = Map-like view ─┘
 computeEffectiveWeight(...) ◀── phases 2/3, visibility route
```

### Data Models

#### Snapshot (in memory, not persisted)

| Field     | Type         | Constraints | Description     |
| --------- | ------------ | ----------- | --------------- |
| provider  | string       | required    | provider id     |
| windows   | Window[]     | ≤ 32        | live windows    |
| planTier  | string\|null | ≤ 64 chars  | last known tier |
| updatedAt | number       | ms          | last ingest     |

Window: `{ kind: "5h"|"7d"|"day"|"month"|"requests"|"tokens"|"input-tokens"|"output-tokens"|"model:<id>", usedFraction: 0..1, resetsAt: ms|null, observedAt: ms, source: "header"|"probe" }`

#### `providerSpecificData.planTier`

Raw provider tier id, lowercased and trimmed, at most 64 characters. Codex falls back to the existing `chatgptPlanType`. No migration: it is stored in the JSON column.

### API Design

#### `GET /api/usage/[connectionId]`

**Purpose**: existing usage payload plus an additive `quotaSnapshot` field.
**Authentication**: existing dashboard guard, unchanged.

**Response (200):**

```json
{
  "plan": "…",
  "quotas": {},
  "quotaSnapshot": {
    "planTier": "default_claude_max_20x",
    "windows": [
      {
        "kind": "5h",
        "usedFraction": 0.12,
        "resetsAt": "2026-09-24T20:00:00.000Z",
        "source": "header"
      }
    ],
    "updatedAt": "2026-09-24T18:00:00.000Z",
    "effectiveWeight": {
      "weight": 17.6,
      "base": 20,
      "baseSource": "plan",
      "headroom": 0.88,
      "headroomSource": "header",
      "belowFloor": false
    }
  }
}
```

**Errors:**

| Status | Condition                 | Response  |
| ------ | ------------------------- | --------- |
| 404    | unknown connection        | unchanged |
| 401    | credential refresh failed | unchanged |

### System Integration

#### Files to Create

- `open-sse/config/quotaSnapshot.js`: `QUOTA_SNAPSHOT` tunables, `PLAN_CAPACITY` table, `QUOTA_HEADER_FAMILIES`
- `open-sse/services/quotaSnapshot.js`: store, normalization, usage→windows mapper, plan-tier resolution, `computeEffectiveWeight`
- `open-sse/services/quotaHeaders.js`: pure header parsers plus fail-open `ingestResponseHeaders`
- `src/sse/services/quotaSnapshotSync.js`: `recordUsageSnapshot`, Claude profile throttle, planTier persist, `buildQuotaSnapshotView`
- `src/shared/services/quotaSnapshotPoller.js`: weighted-gated DI poller
- `open-sse/services/weightedRoundRobin.js`: shared smooth weighted round-robin `pickSmoothWeighted` (one pure function), imported by phases 2 and 3
- `tests/unit/quota-snapshot.test.js`, `tests/unit/quota-snapshot-poller.test.js`, `tests/unit/weighted-round-robin.test.js`

`open-sse/services/quotaSnapshot.js` also exports `getProviderHeadroom(provider, connectionIds, model)`: the best headroom across a provider's connections, with unknown counting as 1. Phase 3 calls it instead of reading the store.

#### Files to Modify

- `open-sse/handlers/chatCore.js`: one hook call
- `src/sse/services/antigravityQuota.js`: fold the cache onto the store
- `open-sse/services/usage/claude.js` (+ `providers/registry/claude.js` `usage.profileUrl`): `fetchClaudePlanTier`
- `open-sse/services/usage/codex.js`: expose `windowMinutes`
- `src/lib/oauth/providers/{antigravity,gemini-cli}.js`: persist the tier in `mapTokens`
- `src/app/api/usage/[connectionId]/route.js`, `src/shared/services/initializeApp.js`, `src/app/api/settings/route.js`

#### Configuration

`QUOTA_SNAPSHOT` = `{ ttlMs: 3_600_000, floor: 0.05, maxConnections: 1000, maxWindows: 32, profileRecheckMs: 86_400_000, poller: { tickMs: 60_000, staleMs: 900_000, failureCooldownMs: 900_000 } }`.

## UX Considerations

### User Workflows

#### Primary Workflow: Inspect a connection's weight

1. **Open the usage/quota view**: the dashboard calls `/api/usage/[id]`.
2. **System**: returns the existing quotas plus `quotaSnapshot`. Phase 2 and 3 UIs render the plan chip, the bars per window and the weight breakdown.

#### Error Recovery Workflow

1. **Error occurs**: the probe fails or the profile returns 403.
2. **User sees**: the unchanged usage message. `quotaSnapshot.windows` may be empty and `effectiveWeight.headroomSource` is `"static"`.
3. **Recovery**: the next request refreshes the data passively.

### UI Patterns

| Component        | Pattern                  | Notes                       |
| ---------------- | ------------------------ | --------------------------- |
| Weight breakdown | base × headroom = weight | phase 2/3 UI; API ready now |

### Accessibility Requirements

No UI changes in phase 1.

### Performance UX

- **Loading States**: the snapshot is an in-memory read. The dashboard GET never causes an extra probe beyond the existing one.

## Recommendations

### Implementation Approach

**Recommended Strategy**: one bounded store, one hook, reuse `USAGE_HANDLERS`, and fold Antigravity behind a Map-like view (see [research-recommendations](./research-recommendations.md)).

**Phasing:**

1. **Foundation**: config, store, parsers and usage tweaks (parallel).
2. **Wiring**: chatCore hook, Antigravity fold, sync/poller/route.
3. **Tests**: critical unit tests and the regression gate.

### Technology Decisions

| Decision         | Recommendation                       | Rationale                                                               |
| ---------------- | ------------------------------------ | ----------------------------------------------------------------------- |
| Hook location    | `chatCore.js` before the `!ok` guard | one site, sees ok and 429 headers, has provider, model and connectionId |
| Antigravity fold | Map-like view over the store         | keeps `auth.js` and the tests, removes the second cache                 |
| Poller home      | `src/shared/services/`               | app-side deps (DB, credential refresh), same as `quotaAutoPing`         |
| Persistence      | memory only, except `planTier`       | no migration; fast reads                                                |

### Quick Wins

- Codex `windowMinutes` from `limit_window_seconds` fixes the Pro weekly-as-primary mislabel.
- Persist the Antigravity/Gemini tier already fetched in `postExchange`.

### Future Enhancements

- Pace/forecast fields and an aggregate `/api/usage/snapshots` route.
- Runtime 0–1 vs 0–100 detection for `/api/oauth/usage` if Anthropic changes the scale.

## Risk Assessment

### Technical Risks

| Risk                                    | Likelihood | Impact | Mitigation                                  |
| --------------------------------------- | ---------- | ------ | ------------------------------------------- |
| Undocumented endpoints change shape     | High       | Medium | fail-open, reuse existing fetchers          |
| Scale misread                           | Medium     | High   | per-provider parsers + tests                |
| Breaking the Antigravity strike-breaker | Medium     | High   | view keeps API; tests stay green            |
| Unverified tier ids and weights         | High       | Low    | isolated in config; floor limits the damage |

### Integration Challenges

- Codex rebuilds the `Response` but keeps its headers (`executors/codex.js`). The hook reads headers defensively.

### Security Considerations

#### Critical — Hard Stops

| Finding | Risk | Required Mitigation |
| ------- | ---- | ------------------- |
| None    | —    | —                   |

#### Warnings — Must Address

| Finding                  | Risk               | Mitigation                                             | Alternatives          |
| ------------------------ | ------------------ | ------------------------------------------------------ | --------------------- |
| Unbounded maps           | memory DoS         | cap connections and windows, TTL                       | —                     |
| Untrusted header numbers | routing corruption | finite check, clamp, cap on reset horizon              | —                     |
| Claude profile ban risk  | account flag       | at most once per 24h per connection, never per request | persist on login only |
| Token/header logging     | secret leak        | log only parsed numbers + 8-char id prefix             | —                     |

#### Advisories — Best Practices

- Model ids go into a `Map` or plain arrays, never used as object keys; kinds are sanitized.

## Task Breakdown Preview

### Phase 1: Foundation

**Tasks**: config + store + weight; header parsers; usage/OAuth tweaks.
**Parallelization**: three tasks in parallel.

### Phase 2: Wiring

**Dependencies**: Phase 1.
**Tasks**: chatCore hook; Antigravity fold; sync + poller + route + init.

### Phase 3: Tests

**Tasks**: pure tests; poller/sync tests; regression gate.

## Decisions Needed

1. **Codex `prolite` = 5x, `pro` = 20x**: unverified. Ship the table with a comment.
2. **API-key windows** (`requests`/`tokens`) count toward headroom while live. They expire fast, so they don't cause bounce.

## Research References

- [research-external.md](./research-external.md): APIs and headers
- [research-business.md](./research-business.md): rules
- [research-technical.md](./research-technical.md): architecture
- [research-ux.md](./research-ux.md): response shape
- [research-security.md](./research-security.md): severity findings
- [research-practices.md](./research-practices.md): reuse
- [research-recommendations.md](./research-recommendations.md): risks and phasing
