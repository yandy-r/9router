# External Research: Exhausted Model-Specific Quotas in Multi-Provider Routing

Date: 2026-09-25. Read-only external scan, no source-code investigation. No new dependencies.

## Summary

- Industry pattern is: **exclude known-exhausted candidates pre-routing; fail open on unknown; mutate exclusion state on observed 429; honor `Retry-After`/reset hints; fall back across providers/models.**
- Known `0 remaining + reset timestamp` => temporary cooldown until reset, then auto-rejoin.
- Known `0 remaining + no reset` => longer/indefinite skip until success signal, spend-cycle rollover, or manual/budget reset. Uniform short TTL is a known foot-gun.
- Unknown quota => **fail open / include candidate**. Fail-closed only for explicit deny, auth, budget, or exhausted retries.
- No provider offers a reliable cross-model push quota API for gateways; routers learn from per-response headers + 429 bodies. Shared state (Redis/central store) required to avoid N-workers × limit overshoot and cooldown divergence.

## 1. Known exhausted (0%) handling

### Skip pre-routing, not retry-in-place

- LiteLLM Router pipeline is: all deployments for model -> drop unhealthy / cooldown / over-limit -> tag/budget filters -> strategy picks from survivors. **Confidence**: Medium (single authoritative vendor doc set).
  - Source: <https://docs.litellm.ai/docs/routing>
  - Source: <https://docs.litellm.ai/docs/proxy/load_balancing>
- OpenRouter default is price-weighted load balancing across stable providers, with remaining providers as fallbacks; `sort`/`order` disables balancing and tries in order. **Confidence**: High (official docs + consistent secondary coverage).
  - Source: <https://openrouter.ai/docs/guides/routing/provider-selection>
- Portkey fallback strategy triggers only on configured `on_status_codes` (e.g. `[429]`), then tries ordered targets. **Confidence**: Medium.
  - Source: <https://docs.portkey.ai/docs/guides/getting-started/tackling-rate-limiting>
  - Source: <https://portkey.ai/blog/failover-routing-strategies-for-llms-in-production>
- TrueFoundry/Kong pattern: mark unhealthy on breach/failure threshold, exclude for cooldown period, reroute. **Confidence**: Medium.
  - Source: <https://www.truefoundry.com/blog/rate-limiting-in-llm-gateway>
  - Source: <https://developer.konghq.com/ai-gateway/load-balancing>
- AISIX explicitly makes cooldown opt-in: without `cooldown.enabled`, every request retries failing primary before failover; with it, failing target drops from candidates for a while. Same for `fallback_on_statuses`. **Confidence**: Medium.
  - Source: <https://docs.api7.ai/ai-gateway/routing/routing-and-failover>

Implication for combo-zero-quota-skip: known 0% entries should be excluded from candidate selection before picking, not merely retried after failure.

### With reset timestamp: cooldown until reset

- Standard HTTP signal is `Retry-After`: seconds or HTTP-date; for 429 means wait before new request; for 503 means expected outage duration. **Confidence**: High (RFC + MDN agree).
  - Source: <https://developer.mozilla.org/en-US/docs/Web/HTTP/Reference/Headers/Retry-After>
  - Source: <https://www.rfc-editor.org/info/rfc6585>
  - Source: <https://httpwg.org/specs/rfc9110.html>
- OpenAI: `Retry-After` present only on temporary rate-limit 429 / temporary 503 overload; quota/billing errors requiring user action are not retry-resolvable. Also publishes `x-ratelimit-remaining-*` + `x-ratelimit-reset-*` on responses. **Confidence**: High (official docs).
  - Source: <https://developers.openai.com/api/docs/guides/rate-limits>
- Anthropic: 429 carries `retry-after` for RPM/ITPM/OTPM/acceleration/fast-mode limits; spend-cap 429 carries **no** `retry-after` and SDK retries fail until next month/tier change. Headers include `anthropic-ratelimit-*-remaining` + `*-reset` (RFC 3339). **Confidence**: High.
  - Source: <https://platform.claude.com/docs/en/api/rate-limits>
- OpenRouter platform-origin 429 carries `X-RateLimit-Limit/Remaining/Reset`; when all providers returned retry hints, response also carries `Retry-After`. Successful inference responses carry no `X-RateLimit-*`. **Confidence**: High.
  - Source: <https://openrouter.ai/docs/api_reference/limits>
- OpenRouter free-model envelope example carries provider retry data inside `error.metadata.headers` (`X-RateLimit-Limit/Remaining/Reset`), and upstream code in `error.metadata.provider_code`. A router must inspect envelope + metadata, not only top-level HTTP headers. **Confidence**: Medium (official limits doc + filed issue with raw payload).
  - Source: <https://openrouter.ai/docs/api_reference/limits>
  - Source: <https://github.com/BerriAI/litellm/issues/9035>

Implication: when 0% observation includes trustworthy reset/`Retry-After`, set exclusion TTL = min(reset delay, sane cap) + small jitter; re-admit on expiry.

### Without reset timestamp: long/indefinite skip

- Uniform short cooldown is insufficient for quota-exhausted vs burst-rate-limited. LiteLLM issue #27470 reports exactly this: single `cooldown_time` TTL cannot distinguish transient 429-rate-limit ("wait 60s") from monthly-quota 429 ("wait until rollover"); reporter retried every 60s for hours. Closed as not planned; no body-keyword classifier knob found. **Confidence**: Medium (single issue, but directly on-point).
  - Source: <https://github.com/BerriAI/litellm/issues/27470>
- Anthropic spend-cap precedent: no `retry-after`; clients must stop retrying and wait for calendar/tier event. Distinguish via `error.details.error_code=enforced_spend_limit_reached`, not status code alone. **Confidence**: High.
  - Source: <https://platform.claude.com/docs/en/api/rate-limits>
- OpenAI precedent: inspect `error.code`/`error.type`; `insufficient_quota`/billing vs `rate_limit_exceeded`/`slow_down`/`server_is_overloaded` require different actions; unsuccessful retries still count against per-minute limits. **Confidence**: High.
  - Source: <https://developers.openai.com/api/docs/guides/rate-limits>
  - Source: <https://help.openai.com/en/articles/5955604-troubleshooting-api-rate-limits-and-429-errors>
- Practical industry fallback: exhausted-no-reset stays out until an out-of-band signal (time window rolls, spend reset, key/budget refill, successful probe, config change), with periodic capped re-probe rather than hot retry. Portkey returns 412 pre-provider for budget/token/request caps vs 429 transient; AISIX/Kong use explicit cooldown/fail-timeout windows. **Confidence**: Medium.
  - Source: <https://docs.portkey.ai/docs/guides/use-cases/enforcing-limits-and-budgets>
  - Source: <https://docs.api7.ai/ai-gateway/routing/routing-and-failover>
  - Source: <https://developer.konghq.com/ai-gateway/load-balancing>

Implication: 0%-without-reset must not reuse short burst TTL; use long/indefinite exclusion + low-frequency re-probe or explicit reset event.

## 2. Unknown quota: fail open vs skip

Consensus found: **unknown = include (fail open); known-bad = exclude; deny/budget/auth = hard block.**

- LiteLLM filters only unhealthy/cooldown/over-limit/budget/tag-mismatched; everything else remains eligible. **Confidence**: Medium.
  - Source: <https://docs.litellm.ai/docs/routing>
- OpenRouter retries other providers for same model automatically before surfacing error; advises adding fallback models / relaxing provider prefs so more providers stay eligible. **Confidence**: High.
  - Source: <https://openrouter.ai/docs/api_reference/limits>
- Portkey/AISIX fallbacks are opt-in by status/model/user/team; Vercel AI Gateway skips denied fallback candidates but continues to next allowed model; only all-denied returns 403. **Confidence**: Medium.
  - Source: <https://docs.portkey.ai/docs/guides/getting-started/tackling-rate-limiting>
  - Source: <https://docs.api7.ai/ai-gateway/routing/routing-and-failover>
  - Source: <https://vercel.com/docs/ai-gateway/models-and-providers/routing-rules>
- Kong circuit breaker only excludes after `max_fails` within `fail_timeout`; first failures still go to target. **Confidence**: Medium.
  - Source: <https://developer.konghq.com/ai-gateway/load-balancing>

Implication: missing quota snapshot must not remove a candidate; only positive evidence of exhaustion (0% read or observed quota 429) excludes it. Fail-closed risks dropping healthy capacity on telemetry gaps.

## 3. Races and shared state

- Check-then-act race is inherent: quota snapshot -> pick -> upstream call can interleave with concurrent picks; multiple in-flight requests can all observe stale "has quota" then all get 429. Mitigation is reactive exclusion on 429 + shared counters, not perfect pre-check. **Confidence**: Medium (vendor + infra sources converge).
  - Source: <https://docs.litellm.ai/docs/proxy/redis_requirements>
  - Source: <https://www.truefoundry.com/blog/rate-limiting-in-llm-gateway>
  - Source: <https://redis.io/glossary/redis-race-condition>
- LiteLLM explicitly requires Redis for multi-instance coordination of rate limits, budgets, cooldowns, cache, config; without it each worker keeps its own copy, so `100 RPM × 4 workers ≈ 400`, revocations only apply where processed, cache hits are worker-local. Single-worker in-memory is dev/low-volume only. **Confidence**: High (official doc explicit).
  - Source: <https://docs.litellm.ai/docs/proxy/redis_requirements>
- Derived per-deployment concurrency caps are per-process, not shared across workers/pods. **Confidence**: Medium (LiteLLM routing doc).
  - Source: <https://docs.litellm.ai/docs/routing>
- OpenRouter in-flight spending budget shows server-side guard for same race: estimate cost up front, hold against balance, reject with 402 + `Retry-After` when running+settling requests fill budget. **Confidence**: Medium.
  - Source: <https://openrouter.ai/docs/api_reference/limits>
- Google recommends truncated exponential backoff + jitter for 429/503; OpenAI warns unsuccessful requests count toward per-minute limits, so tight retry loops worsen exhaustion. **Confidence**: High.
  - Source: <https://ai.google.dev/gemini-api/docs/troubleshooting>
  - Source: <https://cloud.google.com/blog/products/ai-machine-learning/learn-how-to-handle-429-resource-exhaustion-errors-in-your-llms>
  - Source: <https://developers.openai.com/api/docs/guides/rate-limits>

Implications without new deps:

1. Treat quota cache as hint; always handle post-pick 429 as authoritative mutation (exclude/extend TTL).
2. Share exclusion map through existing shared store if multi-process; otherwise accept per-process divergence and keep TTLs short for burst, long only for proven quota exhaustion.
3. Add jitter to re-admit/probe so N waiters do not thundering-herd at reset.
4. Bound retries/probes; never busy-loop a known 0%-no-reset entry.

## 4. Provider API quota limitations (why prefetch is unreliable)

- OpenAI: per-response `x-ratelimit-*` + `Retry-After` on temporary 429/503; org/project/model/shared limits on Limits page; monthly approved usage separate from RPM/TPM; no documented push/stream quota feed for gateways. **Confidence**: High.
  - Source: <https://developers.openai.com/api/docs/guides/rate-limits>
- Anthropic: token-bucket (continuous replenish, not fixed reset); per-model RPM/ITPM/OTPM; workspace caps; programmatic Rate Limits API + Console Usage page; `anthropic-ratelimit-tokens-*` shows most-restrictive limit in effect. **Confidence**: High.
  - Source: <https://platform.claude.com/docs/en/api/rate-limits>
- Gemini: RPM/TPM/RPD (+TPD/IPM on some models); per-project; RPD resets midnight Pacific; spend-based rolling 10-min caps return 429 `RESOURCE_EXHAUSTED`; active limits viewed in AI Studio, not a gateway quota API; error body carries `ErrorInfo` (`RATE_LIMIT_EXCEEDED`, `quota_metric`) + Help links; SDKs retry transient 429/5xx with backoff by default. **Confidence**: High.
  - Source: <https://ai.google.dev/gemini-api/docs/rate-limits>
  - Source: <https://ai.google.dev/gemini-api/docs/troubleshooting>
- OpenRouter: proactive signal is `GET /api/v1/key` (`limit_remaining`, free-model daily used/limit/remaining, usage windows); per-minute free cap not reported there; 429 root cause split OpenRouter-platform vs upstream provider; mid-stream limits arrive as SSE `finish_reason:"error"`, not HTTP 429. **Confidence**: High.
  - Source: <https://openrouter.ai/docs/api_reference/limits>
- LiteLLM operational notes: `rpm`/`tpm` config values are routing hints unless `enforce_model_rate_limits` pre-call check is on (RPM hard, TPM best-effort because tokens unknown until response); fallback to specific model ID can bypass cooldown checks; spend logs record `attempted_fallbacks` + `original_model_group`. **Confidence**: Medium.
  - Source: <https://docs.litellm.ai/docs/proxy/load_balancing>
  - Source: <https://docs.litellm.ai/docs/proxy/reliability>

Implication: do not depend on a unified "quota API"; combine (a) periodic lightweight reads where available, (b) per-response remaining/reset parsing, (c) 429 body/metadata classification, with (c) authoritative.

## 5. Recommended mapping for combo-zero-quota-skip

- Known 0% + reset in future: exclude until reset + jitter; keep entry visible as "cooling down".
- Known 0% + reset missing/past/unparseable: long/indefinite exclusion; re-probe on low-frequency timer or explicit quota-refresh success, not on every request.
- Unknown/missing: include; let normal fallback + 429-mutation handle it.
- On any quota-class 429: immediately exclude that model entry (short TTL if reset present, long if absent), continue to next candidate within same attempt; do not consume all retries on the same exhausted entry.
- Separate burst-rate-limit TTL (seconds) from quota-exhausted TTL (minutes→months/indefinite); single TTL reproduces LiteLLM #27470 failure.
- Propagate `Retry-After`/reset hints to caller when surfacing terminal 429; never fabricate a reset time.

## Sources

- <https://platform.claude.com/docs/en/api/rate-limits>
- <https://developers.openai.com/api/docs/guides/rate-limits>
- <https://help.openai.com/en/articles/5955604-troubleshooting-api-rate-limits-and-429-errors>
- <https://ai.google.dev/gemini-api/docs/rate-limits>
- <https://ai.google.dev/gemini-api/docs/troubleshooting>
- <https://cloud.google.com/blog/products/ai-machine-learning/learn-how-to-handle-429-resource-exhaustion-errors-in-your-llms>
- <https://openrouter.ai/docs/api_reference/limits>
- <https://openrouter.ai/docs/guides/routing/provider-selection>
- <https://docs.litellm.ai/docs/routing>
- <https://docs.litellm.ai/docs/proxy/load_balancing>
- <https://docs.litellm.ai/docs/proxy/reliability>
- <https://docs.litellm.ai/docs/proxy/redis_requirements>
- <https://github.com/BerriAI/litellm/issues/27470>
- <https://github.com/BerriAI/litellm/issues/9035>
- <https://developer.mozilla.org/en-US/docs/Web/HTTP/Reference/Headers/Retry-After>
- <https://www.rfc-editor.org/info/rfc6585>
- <https://httpwg.org/specs/rfc9110.html>
- <https://docs.portkey.ai/docs/guides/getting-started/tackling-rate-limiting>
- <https://portkey.ai/blog/failover-routing-strategies-for-llms-in-production>
- <https://docs.portkey.ai/docs/guides/use-cases/enforcing-limits-and-budgets>
- <https://docs.api7.ai/ai-gateway/routing/routing-and-failover>
- <https://developer.konghq.com/ai-gateway/load-balancing>
- <https://vercel.com/docs/ai-gateway/models-and-providers/routing-rules>
- <https://www.truefoundry.com/blog/rate-limiting-in-llm-gateway>
- <https://redis.io/glossary/redis-race-condition>

## Uncertainties & gaps

- No authoritative cross-provider quota-push API found; per-provider proactive reads (OpenRouter key endpoint, Anthropic Rate Limits API, AI Studio page) differ in shape and freshness. **Confidence**: Medium.
- Exact `Retry-After`/reset semantics vary by sender (seconds vs epoch-ms vs RFC 3339 vs HTTP-date); router must normalize defensively. **Confidence**: High.
- Whether a specific 0%-without-reset entry is monthly/daily/manual-refill cannot be inferred from status alone; needs provider-specific body/metadata mapping maintained over time. **Confidence**: High.
