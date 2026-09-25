# Research UX: Combo All-Members Quota Exhausted

## Decision: Status Code

**Use `429`, not `503`.**

- `429 Too Many Requests` = client-side quota/rate condition, retryable after window/reset. Matches upstream semantics: OpenAI (`429 credit_balance_exhausted`, `organization_spend_limit_exceeded`, `RateLimitError`), Anthropic (`429 rate_limit_error`, spend-cap 429 with no `retry-after`). RFC 6585 §4: 429 signals "sent too many requests in given amount of time", MAY include `Retry-After`.
  **Confidence**: High
- `503 Service Unavailable` = server-side overload/no capacity (`server_is_overloaded`, Anthropic `overloaded_error` is 529). Implies gateway fault, triggers wrong client behavior (circuit-breaker, paging, failover) and misleads ops dashboards.
  **Confidence**: High
- Exception: return `503` only if quota subsystem itself errors (DB/state unreadable, cannot determine quota) — that is genuinely server-side.
  **Confidence**: Medium

⚠️ **Freshness Note**: Upstream codes verified 2026-09-25 (Anthropic errors page, OpenAI error-codes page, RFC 6585). Stable semantics, low drift risk.

## Response Contract

```json
{
  "error": {
    "type": "rate_limit_error",
    "code": "combo_quota_exhausted",
    "message": "All models in combo '<name>' have exhausted quota. Retry after <earliest-reset> or switch combo.",
    "combo": "<combo-name>",
    "exhausted_members": ["member-a", "member-b"],
    "earliest_reset": "2026-09-25T12:00:00Z | null",
    "retry_after_seconds": 3600 | null
  }
}
```

Rules:

- HTTP `429` + `Retry-After: <seconds>` header when earliest reset known. Omit header when unknown (mirrors Anthropic tier spend-cap 429 with no `retry-after`).
- OpenAI-compatible passthrough: also set `error.type = "insufficient_quota"` if gateway normalizes to OpenAI shape; keep `code = "combo_quota_exhausted"` for machine handling.
- SSE/streaming: fail fast before first token with same 429 JSON; never open stream then mid-stream error.
- `Cache-Control: no-store` (RFC 6585: 429 MUST NOT be cached).

## Retry-After Semantics

| Situation                          | `Retry-After`                         | `earliest_reset`                         |
| ---------------------------------- | ------------------------------------- | ---------------------------------------- |
| All members have known reset times | `min(reset) - now` (seconds, floor 0) | that timestamp                           |
| Mixed known + unknown              | `min(known)`                          | that timestamp + `partial_unknown: true` |
| All unknown / no reset advertised  | omit header                           | `null`                                   |
| Stale reset in past (clock skew)   | `0` or omit; never negative           | `null` + `stale: true`                   |

- Cap `Retry-After` at a sane max (e.g. 3600s); larger values cause client timeout misbehavior.
- Do not emit `Retry-After` based on guess/interpolation — only on authoritative reset signals.
- Reset timestamps in UTC ISO-8601; clients must not be expected to parse provider-specific strings.

## Fusion Panel / Judge Skip Behavior

- Judge/fusion step that calls a quota-exhausted member must be **skipped, not failed**: mark member `skipped: quota_exhausted` in trace, continue with remaining members.
- If ALL voting/judge members exhausted → whole combo request fails with the 429 contract above, not a partial/degraded answer. Rationale: silent single-member answer masquerading as fused consensus is misleading.
- If at least one member answers: return success (200), with per-member status array showing `ok` vs `skipped_quota`. Never 429 a request that produced a valid member answer.
- Fusion panel UI: show exhausted members greyed with "quota exhausted · resets <time>" chip, not error-red; keep their last-known-good output out of the consensus input set.

## Unknown Quota Behavior

- Member with indeterminate quota state = **treated as available** (attempt request). Only hard 429/quota signals mark exhausted.
- Rationale: fail-open preserves availability; fail-closed on ambiguous signals causes false 429s and support load.
- Cap consecutive unknown-state attempts per member (e.g. short-circuit after N hard 429s) to avoid hammering a dead provider — but surface that as per-member backoff, not combo-level 429, until all members confirmed exhausted.
- Log `quota_state: unknown` distinctly from `exhausted` for ops triage.

## Reset Expiry

- Quota-exhausted marks must carry TTL = reset time (or short default e.g. 60s when unknown — re-probe rather than sticky-fail).
- On reset time passing, next request re-probes member; no manual clear needed.
- Clock: server-side `now()` only; never trust client-supplied time.
- Admin/ops override: manual quota-state clear endpoint or dashboard button for bad marks.

## User-Visible Messaging

- Dashboard/API consumer message (concise, actionable):
  > `Combo "fast-cheap" paused — all 3 models out of quota. Earliest reset 12:00 UTC (≈45m). Switch combo or wait.`
- Required elements: combo name, count exhausted/total, earliest reset or "reset time unknown", one action (switch combo / wait / check billing).
- Do NOT expose: provider keys, raw upstream error bodies, per-key spend numbers.
- Fusion panel: per-member line `out of quota · resets 12:00 UTC` + combo banner only when request actually 429s.

## Acceptance Scenarios

1. **All members exhausted, resets known** → `429` + `Retry-After: <min>` + body with `earliest_reset`; dashboard banner shows reset countdown.
2. **All exhausted, resets unknown** → `429`, no `Retry-After`, `earliest_reset: null`, message says "reset time unknown — check provider billing".
3. **One member healthy** → `200`, member-status array marks others `skipped_quota`; no 429.
4. **All judges exhausted but worker OK (or vice versa)** → if consensus impossible, `429`; never return unlabelled single-member output as "fused".
5. **Reset passes** → next request re-probes, succeeds if provider recovered; no stale 429.
6. **Quota subsystem down** → `503` (not 429), generic "try again" message, ops alert.
7. **Streaming request, all exhausted** → immediate 429 JSON, no open-then-abort stream.

## Risks

1. **429 vs 503 client-retry confusion** — SDKs retry both with backoff; 503 triggers infra paging while 429 doesn't. Wrong code = either silent quota burn (retry storm on 503 path) or missed ops alert. Mitigate: strict 429-for-quota rule + `code` field clients can match.
2. **Retry-After fabrication** — guessing reset times causes thundering-herd retries at wrong instant. Mitigate: omit when unknown; cap max.
3. **Partial-consensus masquerade** — returning single-member answer as fused when judges skipped. Mitigate: all-judges-exhausted → 429, never degraded-200.
4. **Sticky false-exhaustion** — unknown/transient 429 cached forever blocks combo. Mitigate: TTL on marks, re-probe, manual clear.
5. **Message leakage** — raw upstream quota errors may contain account IDs/quotas. Mitigate: fixed message template, allowlist fields only.

## Sources

- Anthropic API errors — 429 `rate_limit_error`, spend-cap 429 without `retry-after`, SDK retry honoring `retry-after`: <https://platform.claude.com/docs/en/api/errors>
- OpenAI error codes — 429 `credit_balance_exhausted` / spend-limit codes vs 503 `server_is_overloaded`, `Retry-After` guidance: <https://platform.openai.com/docs/guides/error-codes>
- RFC 6585 §4 — 429 semantics, `Retry-After` MAY, MUST NOT cache: <https://www.rfc-editor.org/rfc/rfc6585#section-4>

## Uncertainties & Gaps

- Whether gateway normalizes errors to OpenAI shape (`insufficient_quota`) or Anthropic shape — contract above covers both, confirm with gateway owner. **Confidence**: Medium
- Exact reset-signal availability per provider (headers vs none) not researched — no source-code research per task scope; needs provider-matrix follow-up. **Confidence**: Low
