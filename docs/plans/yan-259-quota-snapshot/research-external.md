# External API Research: YAN-259 Quota Snapshot

## Executive Summary

- Passive response-header ingestion should be primary for Claude OAuth, Codex, OpenAI-compatible APIs, Groq, and Anthropic API keys. It adds no quota-probe traffic and keeps request handling fail-open. **Confidence: High** — official API docs and upstream Codex source confirm header contracts.
- Codex upstream source currently recognizes `x-codex-{primary,secondary}-{used-percent,window-minutes,reset-at}`. It does **not** recognize `reset-after-seconds`; that field belongs to `/backend-api/wham/usage` JSON windows, not current response-header parsing. **Confidence: High** — exact parser in `openai/codex` `rate_limits.rs`.
- Claude OAuth unified headers expose usage as a 0–1 fraction and resets as Unix epoch seconds; `/api/oauth/usage` exposes percentage-used values, normally 0–100, plus ISO `resets_at`. These endpoints/headers are undocumented consumer interfaces. **Confidence: Medium** — observed client behavior and multiple public implementations, but no official schema.
- Existing repo fetchers already normalize most probe responses. Reuse their output rather than adding provider-specific polling code. Missing pieces are persisted plan IDs and a shared passive-header hook. **Confidence: High** — verified in repository source.
- Plan fields already available: Codex `plan_type`/persisted `chatgptPlanType`; Copilot `copilot_plan`; Gemini/Antigravity `paidTier.id` or `currentTier.id`; Kiro `subscriptionInfo.subscriptionTitle`. Claude needs `/api/oauth/profile` and `organization.rate_limit_tier`. **Confidence: Medium** — repo confirms all except Claude profile, whose consumer endpoint is undocumented.

## Primary APIs

### Claude OAuth subscription quotas

- `GET https://api.anthropic.com/api/oauth/usage`
- Auth: `Authorization: Bearer <OAuth token>`; headers `anthropic-beta: oauth-2025-04-20` and `anthropic-version`. Repo implementation: `open-sse/services/usage/claude.js:58-78`.
- Shape: `five_hour`, `seven_day`, `seven_day_sonnet`, `seven_day_opus` objects containing `{ utilization, resets_at }`; newer model-scoped limits may appear in `limits[]` as `{ kind: "weekly_scoped", percent, resets_at, scope.model.display_name }`.
- Scale: repo assumes `utilization` and `percent` are percentage used, 0–100 (`claude.js:84-132`). Normalize with runtime scale detection because passive headers use 0–1.
- Rate behavior: repo has 5-minute success cache and 3-minute per-token 429 cooldown (`claude.js:17-55`, `142-145`). Poller must reuse this handler.
- Source: repo registry `open-sse/providers/registry/claude.js:38-42`; public reverse-engineering at <https://pypi.org/project/ccusage/> (accessed 2026-09-24; interface may drift).
- **Confidence: Medium** — endpoint works in existing code, but Anthropic does not publish this consumer API.

### Claude OAuth passive headers

Exact families required by issue evidence:

- `anthropic-ratelimit-unified-5h-utilization`
- `anthropic-ratelimit-unified-5h-reset`
- `anthropic-ratelimit-unified-5h-status`
- `anthropic-ratelimit-unified-7d-utilization`
- `anthropic-ratelimit-unified-7d-reset`
- `anthropic-ratelimit-unified-7d-status`
- `anthropic-ratelimit-unified-7d_oi-utilization`, `-reset`, `-status` when present; treat suffix as model-scoped and preserve unknown suffixes rather than hardcoding only one model.

`utilization` is observed as fraction used (for example `0.042598...`); `reset` is Unix seconds; status values include `allowed`, `allowed_warning`, and `rejected`. Do not convert status into utilization. Evidence: <https://gist.github.com/andrew-kramer-inno/34f9303a5cc29a14af7c2e729b676fc9> and <https://github.com/anthropics/claude-code/issues/12829> (accessed 2026-09-24).

**Confidence: Medium** — concrete captures agree on 0–1 and epoch seconds, but contract is undocumented and suffix naming may change.

### Claude plan profile

- `GET https://api.anthropic.com/api/oauth/profile`
- Auth: same OAuth bearer; requires `user:profile`. Repo requests that scope at `open-sse/providers/registry/claude.js:56`.
- Read `organization.rate_limit_tier`; expected IDs include `default_claude_pro`, `default_claude_max_5x`, and `default_claude_max_20x` (exact production IDs need capture verification).
- Setup tokens lacking profile scope may return 403; persist `null`, retain prior valid tier, and never fail chat.
- **Confidence: Low** — endpoint and shape come from observed consumer behavior, not official Anthropic docs.

### Codex response headers

Upstream parser: <https://github.com/openai/codex/blob/main/codex-rs/codex-api/src/rate_limits.rs> (accessed 2026-09-24).

Default family exact names:

- `x-codex-primary-used-percent`
- `x-codex-primary-window-minutes`
- `x-codex-primary-reset-at`
- `x-codex-secondary-used-percent`
- `x-codex-secondary-window-minutes`
- `x-codex-secondary-reset-at`
- `x-codex-rate-limit-reached-type`

Generic metered family uses `x-{normalized-limit-id}-{primary|secondary}-{used-percent|window-minutes|reset-at}` plus optional `x-{normalized-limit-id}-limit-name`. Source functions: `parse_all_rate_limits`, `parse_rate_limit_for_limit`, `parse_rate_limit_window`, and `parse_rate_limit_reached_type` (`rate_limits.rs:23-104`, `188-218`). Also exposed: `x-codex-credits-has-credits`, `x-codex-credits-unlimited`, `x-codex-credits-balance` (`rate_limits.rs:219-231`).

`used-percent` is 0–100; `window-minutes` identifies semantics; `reset-at` is Unix epoch seconds. Never assume primary means 5h or secondary means week: classify by duration. Current upstream file contains no `x-codex-*-reset-after-seconds` parser. **Confidence: High** — primary source with parser tests.

### Codex active usage and plan

- `GET https://chatgpt.com/backend-api/wham/usage`; bearer auth. Repo registry: `open-sse/providers/registry/codex.js:38-43`.
- Body supports `plan_type`; `rate_limit.primary_window` and `secondary_window`; windows may carry `used_percent`, `limit_window_seconds`, `reset_after_seconds`, and/or `reset_at`; `additional_rate_limits[]` carries model/feature limits.
- Repo parser currently accepts `used_percent`/`percent_used` and `reset_at` aliases but ignores `limit_window_seconds` and `reset_after_seconds` (`open-sse/services/usage/codex.js:41-84`). It maps primary to `session` and secondary to `weekly`, which is unsafe for Pro arrangements.
- Plan is returned as `data.plan_type || data.summary?.plan` (`codex.js:168-175`). OAuth JWT-derived `chatgpt_plan_type` is already persisted as `providerSpecificData.chatgptPlanType` in `src/lib/oauth/providerHelpers.js:87` and OAuth routes.
- **Confidence: High** for repo behavior; **Confidence: Medium** for undocumented WHAM body variants.

### OpenAI and Groq API-key headers

Official OpenAI fields: `x-ratelimit-limit-requests`, `x-ratelimit-remaining-requests`, `x-ratelimit-reset-requests`, and token equivalents. Reset is relative duration such as `1s` or `6m0s`, not timestamp. Project-token variants also exist. Source: <https://developers.openai.com/api/docs/guides/rate-limits> (current page, accessed 2026-09-24).

Groq documents same request/token families at <https://console.groq.com/docs/rate-limits>. Repo already parses Go-style durations with fractional values such as `2m59.56s` and `7.66s` in `open-sse/services/usage/groq.js:20-61`; requests and tokens can have different windows (`groq.js:102-129`).

**Confidence: High** — official docs plus working repo parser. Duration parser should require full-string consumption; current regex accepts junk around valid components.

### Anthropic API-key headers

Official families: `anthropic-ratelimit-{requests,tokens,input-tokens,output-tokens}-{limit,remaining,reset}`. Numeric limit/remaining; reset uses RFC 3339. `retry-after` is seconds on temporary 429s. Source: <https://platform.claude.com/docs/en/api/rate-limits> (updated/current 2026 documentation, accessed 2026-09-24).

**Confidence: High** — official Anthropic documentation.

### Copilot, Google, and Kiro probes

- Copilot: `GET https://api.github.com/copilot_internal/user`, `Authorization: token <GitHub OAuth token>`, editor headers. Shape includes `copilot_plan`, `quota_reset_date`, and `quota_snapshots.{chat,completions,premium_interactions}`. Repo uses entitlement/remaining, not server `percent_remaining`, at `open-sse/services/usage/github.js:46-106`. Endpoint is internal, absent from public REST docs. **Confidence: Medium**.
- Gemini CLI: POST `v1internal:loadCodeAssist` returns `cloudaicompanionProject`, `paidTier`, `currentTier`, and tier metadata; POST `v1internal:retrieveUserQuota` returns `buckets[].{modelId,remainingFraction,resetTime}`. Repo only sets display plan from `currentTier.name` and returns model quotas (`google.js:26-119`). **Confidence: Medium** — internal Google API.
- Antigravity: `loadCodeAssist` plus `fetchAvailableModels` and `retrieveUserQuotaSummary`; repo returns `subscriptionInfo`, uses `paidTier.id` only for free detection, and exposes `currentTier.name` as plan (`google.js:125-291`). Weekly parser reads `groups[].buckets[]` and `remainingFraction` (`antigravity-weekly.js:41-95`). **Confidence: Medium**.
- Kiro: GET `/getUsageLimits` or AWS JSON target `AmazonCodeWhispererService.GetUsageLimits`; bearer auth plus auth-method-specific token header. Shape uses `usageBreakdownList[]`, `subscriptionInfo`, and `nextDateReset`. Repo plan is only `subscriptionInfo.subscriptionTitle` (`kiro.js:12-48`) and tries three compatible transports (`kiro.js:51-165`). **Confidence: High** for repo behavior, Medium for external stability.

## Libraries and SDKs

- No new dependency needed. WHATWG `Headers`, `Number`, `Date`, and a small duration parser cover all contracts.
- Reuse `parseResetTime`, `toFiniteNumber`, and `fetchWithTimeout` from `open-sse/services/usage/shared.js:15-69`.
- Reuse `USAGE_HANDLERS` outputs for active snapshots; do not call provider SDKs or duplicate OAuth requests.
- **Confidence: High** — repository already has required transport and normalization helpers.

## Integration Patterns

1. One post-response hook receives provider ID, model ID, connection ID, and immutable response headers. Parser exceptions are caught and debug-logged.
2. Parser returns zero or more normalized windows; missing/malformed fields produce no update, preserving prior snapshot.
3. Prefer passive observations over probes when newer. Probe only stale weighted connections and pass through existing handler cache/cooldown.
4. Persist stable raw tier ID, not display name: Claude `rate_limit_tier`; Codex `chatgptPlanType`; Google `paidTier.id ?? currentTier.id`; Copilot `copilot_plan`; Kiro stable subscription ID if present, title only as fallback.
5. Map probe quotas by explicit metadata. Avoid Kiro list position, Codex primary/secondary labels, and Antigravity `remainingFraction === 1` from `fetchAvailableModels` as definitive availability.

## Constraints and Gotchas

- Header names are case-insensitive; `Headers.get()` handles this. Require both limit and remaining before creating generic quotas.
- Clamp only after finite-number validation. Detect scale: unified Claude fraction expected 0–1; OAuth usage and Codex expected 0–100. Ambiguous exact `1` needs provider-specific scale, not generic inference.
- Preserve reset semantics: Unix seconds, RFC 3339, and relative duration are distinct inputs.
- Codex source creates a default empty snapshot even with no headers; 9Router should not overwrite valid state with that empty observation.
- Streaming response headers must be captured before body translation, but ingestion must not consume or clone streamed bodies.
- Copilot `premium_interactions` semantics may change with AI Credits after 2026-06-01. Prefer `percent_remaining` when available and retain raw meter key.
- Undocumented OAuth/internal APIs can return 401/403/429 independently of chat. All failures remain invisible to request success.

## Code Examples

```js
const finite = (value) => {
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
};

export function parseCodexWindow(headers, slot, now = Date.now()) {
  const prefix = `x-codex-${slot}`;
  const used = finite(headers.get(`${prefix}-used-percent`));
  const minutes = finite(headers.get(`${prefix}-window-minutes`));
  const reset = finite(headers.get(`${prefix}-reset-at`));
  if (used === null || minutes === null) return null;
  return {
    kind: minutes <= 300 ? "5h" : minutes >= 7 * 1440 ? "7d" : `minutes:${minutes}`,
    usedFraction: Math.max(0, Math.min(1, used / 100)),
    resetsAt: reset === null ? null : new Date(reset * 1000).toISOString(),
    source: "header",
  };
}

export function parseClaudeUnified(headers, claim) {
  const prefix = `anthropic-ratelimit-unified-${claim}`;
  const used = finite(headers.get(`${prefix}-utilization`));
  const reset = finite(headers.get(`${prefix}-reset`));
  if (used === null) return null;
  return {
    kind: claim === "5h" ? "5h" : claim === "7d" ? "7d" : `model:${claim}`,
    usedFraction: Math.max(0, Math.min(1, used)),
    resetsAt: reset === null ? null : new Date(reset * 1000).toISOString(),
    source: "header",
  };
}
```

## Open Questions

- Capture real `/api/oauth/profile` payloads for Pro, Max 5x, Max 20x, setup-token, Team, and Enterprise accounts; confirm exact `rate_limit_tier` IDs.
- Confirm whether `7d_oi` is literal current Claude header suffix, and map it to Opus/model IDs without guessing.
- Confirm Codex plan mapping for `prolite` versus `pro`; current external evidence does not prove 5x/20x capacity factors.
- Decide whether WHAM `reset_after_seconds` should be converted when `reset_at` is absent; current repo drops it.
- Capture stable Kiro subscription identifier fields beyond `subscriptionTitle` across Free/Pro/Pro+/Max/Power.
- Verify Copilot post-AI-Credits meter shape and whether `percent_remaining` is more reliable than entitlement arithmetic.
- Verify Google `paidTier.id`/`currentTier.id` values for free, Google AI Pro/Ultra, Standard, and Enterprise after June 2026 migration.
