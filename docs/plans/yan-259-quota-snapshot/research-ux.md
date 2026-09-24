# YAN-259 — UX Research: Quota Snapshot Visibility (Phase 1 = API shape)

Phase 1 ships data layer + API visibility only. UI lands in phases 2/3. This research therefore
specifies the API response shape that makes the future UI trivial to build, and documents the
competitor UX patterns the dashboard should eventually copy. All UI recommendations are
forward-looking design constraints on the payload, not Phase 1 deliverables.

## Executive Summary

- 9Router's quota page (`src/app/(dashboard)/dashboard/quota/page.js` → `ProviderLimits`) already
  consumes `GET /api/usage/[connectionId]` per connection and parses a loosely-normalized payload
  of `{ quotas: {...}, plan, message }` via `parseQuotaData(provider, data)` in
  `ProviderLimits/utils.js`. Phase 1 must **add fields, never reshape existing ones** — the parser
  switch is per-provider and brittle; breaking `quotas`/`plan`/`message` would break the existing UI.
- Competitors converge on the same per-connection card: identity (account, plan tier), one progress
  bar per quota window, percent remaining, reset countdown, and a data-freshness hint. CodexBar adds
  pace ("on pace / X% in deficit / runs out in"); CLIProxyAPI ecosystem tools add plan-aware sorting
  and status coloring. None expose "why this account got this share" — that is 9Router's differentiator
  once weighted routing lands: show `effectiveWeight = base × headroom` with its inputs.
- Recommended API shape: extend the existing usage payload with a `snapshot` block
  (`windows[]` with `kind`, `usedFraction` 0–1, `resetsAt`, `source`), plus top-level
  `planTier`, `effectiveWeight` breakdown, and `meta` (`updatedAt`, `stale`, `status`).
  Every numeric field normalized to 0–1 fractions so the future UI never branches on provider scale.

## User Workflows

1. **"Why did routing pick account B over A?"** (weighted strategy, phases 2/3). User opens quota
   page, compares cards: plan tier chip (Max 20x vs Pro), per-window bars, effective-weight number
   with tooltip decomposition (`manual 1 × plan 20 × headroom 0.42 → 8.4`). Phase 1 requirement:
   payload must carry the decomposition, not just the final number.
2. **"How much headroom before I hit the wall?"** Existing workflow: scan bars + countdowns.
   CodexBar pattern proves countdown + percent-left is the core glanceable unit. Phase 1
   requirement: `resetsAt` (ISO) and `usedFraction` per window — countdown is pure client math.
3. **"Is this number live or stale?"** Snapshot can come from passive headers (fresh) or a probe
   minutes old. Phase 1 requirement: per-window `source: "header"|"probe"` and `updatedAt`, so the
   UI can badge "live from last request" vs "polled 4m ago".
4. **"Why is this account greyed out / unknown?"** Setup-token Claude gets 403 on profile scope;
   Antigravity `quotaInfo` stuck at 1.0 means unknown. Phase 1 requirement: explicit
   `status: "unknown"` with `reason` instead of a null that looks like a bug.
5. **"Which account is biggest?"** Plan-aware sorting (CLIProxyAPI Quota Inspector, Pool Watch)
   needs a comparable capacity scalar. Phase 1 requirement: plan tier id + the relative weight from
   `planCapacity.js`, so sorting is `effectiveWeight desc` with no client-side table.

## UI/UX Best Practices (distilled from competitors)

- **One card per connection, one bar per window** — universal pattern (9Router today, CodexBar,
  CLIProxyAPI-QuotaDashboard, Quota Inspector). Keep `windows` an array, not a map, with stable
  `kind` so ordering is deterministic.
- **Remaining, not used** — every competitor renders "% left" with green→yellow→red thresholds
  (9Router already: >70 green, ≥30 yellow, else red in `getStatusColor`). API carries `usedFraction`;
  remaining = `1 - usedFraction` client-side. Do not also ship `remainingFraction` — single source
  of truth avoids the Qoder/Grok "remaining as absolute count" bugs documented in `utils.js`.
- **Reset as absolute timestamp + client countdown** — CodexBar, QuotaTable both do
  `resetsAt` ISO → "in 2h 53m" client-side. Ship ISO 8601 only; never pre-formatted strings.
- **Plan tier as a chip next to account identity** — CodexBar shows `user@example.com Plus`;
  Quota Inspector sorts by plan. Ship raw tier id (`default_claude_max_20x`) AND a display label is
  _not_ Phase 1's job — tier ids map to labels in UI phase. But payload must include the id even
  when unknown: `planTier: null` + `planTierStatus: "unknown"` beats omission (distinguishes
  "not probed yet" from "probed, scope denied").
- **Data source badge** — "header" vs "probe" matters for trust. CodexBar's "Updated just now" line
  is the pattern: freshness is conveyed by timestamp + source, not hidden.
- **Fail-soft, never error the card** — existing UI renders `quota.message` as inline muted text,
  not a crash. Keep that contract: snapshot errors ride in-band (`status`/`message`), HTTP stays 200
  unless the connection itself is gone (404) or auth broke (401, existing handling).
- **Effective weight is a debug affordance, not primary UI** — show as small number with tooltip
  decomposition (CodexBar's pace tooltip pattern), not a headline metric. Users care about bars;
  operators care about weight.

## Error Handling

Phase 1 must encode these states explicitly so phases 2/3 never re-derive them from raw errors:

| State          | Trigger                                                                     | API representation                                                 | UI behavior (phase 2/3)                                                                               |
| -------------- | --------------------------------------------------------------------------- | ------------------------------------------------------------------ | ----------------------------------------------------------------------------------------------------- |
| `ok`           | snapshot has ≥1 fresh window                                                | `status:"ok"`, windows populated                                   | normal bars                                                                                           |
| `unknown`      | never probed, no headers seen yet (startup, idle)                           | `status:"unknown"`, `windows:[]`, `updatedAt:null`                 | grey card, "No data yet — send a request or wait for poll"; effective weight falls back to base       |
| `stale`        | snapshot past TTL, poller hasn't refreshed (or weighted gating off)         | `status:"stale"`, windows present, `updatedAt` old                 | bars dimmed + "last updated Xm ago"; never hide data                                                  |
| `probe_failed` | active poll errored (network, 5xx, parse)                                   | `status:"probe_failed"`, previous windows preserved, `message` set | keep last bars, warning icon; log detail stays server-side                                            |
| `scope_denied` | plan-tier probe 403 (Claude setup-token without `user:profile`)             | `planTier:null`, `planTierStatus:"scope_denied"`                   | plan chip shows "Unknown plan" with tooltip "re-auth with profile scope"; weight uses base × headroom |
| `unsupported`  | provider/auth type has no quota API (existing `"Usage not available"` path) | unchanged: `{ message }` no `snapshot` key                         | existing muted-message render                                                                         |
| `auth_expired` | token refresh failed (existing 401 path)                                    | unchanged: HTTP 401 `{ error }`                                    | existing re-authorize prompt                                                                          |

Rules: HTTP 200 with in-band status for all per-connection data problems; preserve previous window
values on failure (acceptance criterion: "malformed/missing header or probe leaves previous value");
`message` field reused so existing `quota.message` UI path renders Phase 1 failures with zero UI
changes.

## Performance UX

- Existing page polls per connection: `REFRESH_INTERVAL_MS = 60000`, Claude-specific
  `CLAUDE_REFRESH_INTERVAL_MS = 600000`, plus localStorage cache (`QUOTA_CACHE_KEY`) with `cachedAt`.
  Phase 1 snapshot responses are in-memory reads — effectively free — so the API must not regress:
  keep the response under the existing `getUsageForProvider` envelope; do **not** trigger a live
  probe on every dashboard GET (probe cadence belongs to the poller, respecting Claude's 5-min cache
  / 3-min 429 cooldown).
- Response size: windows array is ≤ ~6 entries/connection; snapshot block adds <1 KB. No pagination
  concern.
- Freshness contract: `updatedAt` lets the client skip re-render when unchanged (memo on
  `updatedAt`), and lets phase 2/3 show "Updated just now" without polling harder. CodexBar's
  bounded-redraw lesson (loading animation ceiling so hung providers can't pin the UI) maps to:
  client should render last-known snapshot immediately from localStorage cache, then reconcile.
- `?force=1` already exists for manual refresh — Phase 1 keeps semantics; force may trigger a probe
  but must still return last-known snapshot if probe fails (fail-open).

## Competitive Analysis

| Tool                                                                                | Surface           | What they show                                                                                                                                                            | Takeaway for 9Router                                                                                                                                                                                                               |
| ----------------------------------------------------------------------------------- | ----------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **CodexBar** (steipete, macOS menu bar)                                             | Per-provider card | Session/weekly % left, reset countdown, plan chip (`user@example.com Plus`), pace ("on pace / X% deficit / runs out in"), credits, "Updated just now"                     | Countdown + % left + plan chip is the core card. Pace needs history — out of Phase 1 scope; but `resetsAt` + `usedFraction` now enables pace later.                                                                                |
| **Codex CLI /status**                                                               | CLI               | `67% left (resets 13:28)` per window; community asked for time-vs-quota pacing bar (issue #12512, closed not_planned)                                                     | Confirms percent-left + reset is the minimum viable unit; pacing is user-desired but deferred.                                                                                                                                     |
| **ccflare / better-ccflare**                                                        | Web dashboard     | Account list with rate-limit reset times, auto-fallback status, priorities; Codex card bars update only from `x-codex-*` headers on real traffic (no free probe endpoint) | Validates YAN-259's passive-header-first design: where probes are expensive, header-derived freshness ("bars update when traffic flows") is accepted UX — badge it.                                                                |
| **CLIProxyAPI ecosystem** (Quota Inspector, Pool Watch, Panopticon, QuotaDashboard) | CLI + web         | Per-account 5h/7d bars, plan-aware sorting, status coloring, plan weights, restore forecasts, one-click reset                                                             | Plan-aware sorting + plan weights are table stakes in this niche. Effective-weight number + decomposition is 9Router's equivalent of Pool Watch's "plan weights".                                                                  |
| **LiteLLM Admin UI**                                                                | Web               | Budget windows per key/team (`budget_limit` + `time_period`), spend per model, per-customer tabs                                                                          | Budget-window model (`limit`, `period`, `used`) matches YAN-259's window model; LiteLLM's `/key/info` returning `model_max_budget_usage` in same shape as config is a good symmetry: snapshot mirrors the config table's tier ids. |

**Confidence**: Medium-High — CodexBar docs/issue tracker and CLIProxyAPI READMEs are primary
sources (fresh, 2026); LiteLLM docs primary. better-ccflare behavior from repo docs (Medium).

## Recommendations

### Must (Phase 1 API contract)

1. Extend `GET /api/usage/[connectionId]` payload additively — existing `quotas`, `plan`, `message`
   untouched. Add:

   ```json
   {
     "planTier": "default_claude_max_20x" | null,
     "planTierStatus": "ok" | "unknown" | "scope_denied",
     "snapshot": {
       "windows": [
         { "kind": "5h", "usedFraction": 0.61, "resetsAt": "2026-09-24T15:00:00Z", "source": "header" }
       ],
       "updatedAt": "2026-09-24T10:07:00Z",
       "status": "ok" | "unknown" | "stale" | "probe_failed",
       "message": null
     },
     "effectiveWeight": {
       "value": 8.4,
       "base": 20, "baseSource": "plan" | "manual" | "static",
       "headroom": 0.42, "floor": 0.05, "model": null
     }
   }
   ```

2. All fractions normalized 0–1 at ingest (never 0–100); clamp [0,1]; absent = omit key, not 0.
3. `resetsAt` ISO 8601 absolute; no pre-formatted durations server-side.
4. In-band `status`/`message` for data failures; HTTP codes only for connection-level failures
   (404/401 as today). Never throw out of the snapshot path.
5. `effectiveWeight` decomposition fields present whenever computable; when unknown → `value = base`,
   `headroom: null` (distinguishes "full headroom" from "no data").
6. Window `kind` vocabulary fixed: `5h | 7d | day | month | model:<id>` — UI will switch on it.

### Should

1. `planTier` raw tier id only (no display label server-side); label map lands with UI phase.
2. Per-window `source` so "live header" vs "polled" badging is possible.
3. Keep `plan` (legacy display string) populated alongside `planTier` — existing UI reads `data.plan`;
   deprecation is a phase-2/3 decision.
4. Snapshot block omitted entirely for unsupported providers (keeps current muted-message path).

### Nice (defer, note now)

1. Pace fields (`pace: "deficit" | "reserve" | "on_pace"`, `runsOutAt`) — needs history; CodexBar
   proves demand. Payload leaves room: add under `snapshot` later without breaking.
2. Aggregate endpoint `GET /api/usage/snapshots` (all connections, one call) — page currently
   N-fetches; fine at current scale, revisit when connection count grows.
3. `planCapacity` table version hash in payload, so UI can warn when client cache has stale weights.

## Open Questions

1. Does `getUsageForProvider` (open-sse/services/usage.js) have a natural seam to attach the
   snapshot block, or must the route merge it post-fetch? (Affects whether `snapshot` lives inside
   the usage payload or as sibling — recommend sibling merge in route, zero executor changes.)
2. Effective weight is model-dependent (`model:<id>` windows). Phase 1 dashboard has no model
   context — expose `effectiveWeight` for `model: null` (account-level) only, or accept `?model=`
   param now? Recommend: account-level only, param deferred.
3. `manualWeight` is a phase-2/3 concept (weighted strategy doesn't exist yet) — is
   `baseSource: "manual"` reachable in Phase 1, or always `plan`/`static` until then?
4. Antigravity `quotaInfo` stuck at 1.0 → "unknown": does that map to window-level
   `status:"unknown"` (per-window) or snapshot-level? Current model has status only at snapshot
   level; per-window unknown may need `usedFraction: null` + omitted from headroom calc.
5. Copilot `percent_remaining` post-2026-06-01 AI Credits semantics unverified (per issue notes) —
   flag payload consumers that Copilot windows may be credit-based, not request-based; `kind`
   vocabulary may need a `credits` entry.
6. localStorage quota cache (`QUOTA_CACHE_KEY`) stores the parsed entry; adding `snapshot` grows
   per-entry size ~1 KB × N connections — localStorage 5 MB cap fine today, but no eviction exists.

## Sources

- Repo: `src/app/api/usage/[connectionId]/route.js`, `src/app/(dashboard)/dashboard/quota/page.js`,
  `src/app/(dashboard)/dashboard/usage/components/ProviderLimits/{index.js,utils.js,QuotaTable.js}`,
  `open-sse/services/usage/{claude,kiro,deepseek,opencode-go}.js` (read 2026-09-24).
- CodexBar docs/ui.md (pace, menu card, freshness): <https://raw.githubusercontent.com/steipete/CodexBar/main/docs/ui.md>
- CodexBar site (card layout, plan chip, "Updated just now"): <https://codexbar.app/>
- openai/codex issue #12512 (pacing bar request): <https://github.com/openai/codex/issues/12512>
- better-ccflare providers.md (Codex header-only quota updates, no probe): <https://github.com/tombii/better-ccflare/blob/main/docs/providers.md>
- CLIProxyAPI Quota Inspector (plan sorting, status coloring): <https://github.com/AllenReder/CLIProxyAPI-Quota-Inspector>
- CLIProxyAPI-QuotaDashboard (per-account refresh, bars, reset time): <https://github.com/xuan-wei/CLIProxyAPI-QuotaDashboard>
- CLIProxyAPI Pool Watch / Panopticon (plan weights, 5h/weekly bars): <https://github.com/router-for-me/CLIProxyAPI>
- LiteLLM budgets/rate limits UI (budget windows, model_max_budget_usage): <https://docs.litellm.ai/docs/proxy/users>
