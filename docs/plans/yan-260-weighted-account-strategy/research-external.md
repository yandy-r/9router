# External research: weighted account strategy (YAN-260)

Fetched 2026-09-24. Scope: Claude OAuth multi-account stickiness, quota headers, smooth weighted round-robin (SWRR), and how other gateways weight + stick.

## Executive Summary

- ccflare and better-ccflare **removed** per-request strategies (round-robin, least-requests, weighted). Only a **session stick** remains. Default duration **5 hours** (`SESSION_DURATION_MS=18000000`). They cite Claude anti-abuse / account-ban risk from rapid account switching. **Confidence**: High. Primary docs, both repos, same warning.
- Anthropic consumer plans use a rolling **5-hour** session window plus a **7-day** window. OAuth responses expose `anthropic-ratelimit-unified-*` (utilization 0–1, reset = epoch seconds). Codex plan limits use `x-codex-*-used-percent` (0–100) and `x-codex-*-reset-at`. 9router already parses these in `open-sse/services/quotaHeaders.js`. **Confidence**: High for header names already in-repo; Medium for undocumented unified-header semantics (Anthropic documents API-key headers, not the OAuth unified set).
- Nginx default weighted round-robin **is** SWRR: each pick adds `weight` to `current_weight`, chooses the max, subtracts `total`. Over `sum(weights)` picks, each peer is chosen exactly `weight` times, interleaved (not burst). **Confidence**: High.
- LiteLLM `weight` is **weighted random** (`simple-shuffle`), with optional **session affinity** (default idle TTL 3600s) that pins before the strategy runs. new-api uses **priority then weighted random**. OpenRouter weights by **inverse square of price**, no sticky session. None of them do SWRR + short sticky window. **Confidence**: High for LiteLLM and OpenRouter docs; High for new-api priority/weight; Medium for new-api "channel affinity" (named, mechanism not extracted).

## Primary APIs

### Claude OAuth quota (headroom)

| Header                                                                  | Meaning                                |
| ----------------------------------------------------------------------- | -------------------------------------- |
| `anthropic-ratelimit-unified-5h-utilization`                            | Fraction used, 0–1, rolling 5h window  |
| `anthropic-ratelimit-unified-5h-reset`                                  | Unix epoch **seconds**                 |
| `anthropic-ratelimit-unified-7d-utilization` / `-7d-reset`              | Weekly window, same units              |
| `anthropic-ratelimit-unified-status`, `-reset`, `-representative-claim` | Summary; do not treat as extra windows |

API-key traffic is a **different** family: `anthropic-ratelimit-{requests,tokens,input-tokens,output-tokens}-{limit,remaining,reset}` with **RFC 3339** resets ([Claude rate limits](https://platform.claude.com/docs/en/api/rate-limits)). Plan usage: [Usage limit best practices](https://support.claude.com/en/articles/9797557-usage-limit-best-practices) (5-hour session + weekly; page updated ~2026-09-22).

Observed OAuth dumps (not an Anthropic spec): [SSD Nodes, 2026-09-20](https://www.ssdnodes.com/learn/claude-api-rate-limit-headers-explained), [Claude Code Camp](https://www.claudecodecamp.com/p/i-tried-to-reverse-engineer-claude-code-s-usage-limits). `5h-utilization * 100` matches Claude Code `rate_limits.five_hour.used_percentage`.

**Confidence**: High that 5h/7d utilization+reset exist and match `parseClaudeHeaders`. Medium that `-status` always mirrors 5h (SSD Nodes: undocumented).

### Codex plan quota

| Header                                                            | Meaning                                    |
| ----------------------------------------------------------------- | ------------------------------------------ |
| `x-codex-primary-used-percent` / `x-codex-secondary-used-percent` | 0–100 used                                 |
| `x-codex-primary-reset-at` / `secondary`                          | Epoch seconds                              |
| `x-codex-*-window-minutes`                                        | Classifies 5h (≤300), 7d (≥6000), else day |
| `x-<id>-<primary\|secondary>-used-percent` + `x-<id>-limit-name`  | Extra metered family → `model:<label>`     |

Field reports: [hermes-agent #9085](https://github.com/NousResearch/hermes-agent/issues/9085), [openai/codex #44251](https://github.com/openai/codex/issues/44251) (2026-09; primary percent oscillates with reset window). **Confidence**: Medium — header names are consistent in issues and already parsed; OpenAI has no public spec page for them.

`computeEffectiveWeight` = plan capacity × headroom, **0 below floor 0.05** (`open-sse/services/quotaSnapshot.js`). Headroom is the **minimum** applicable window (5h and 7d both bind). Unknown snapshot fails open at headroom 1.

## Libraries and SDKs

No new dependency. SWRR is ~15 lines and already in `open-sse/services/weightedRoundRobin.js` (`pickSmoothWeighted`). Reference ports:

- Nginx `ngx_http_upstream_get_peer` (integer `effective_weight` / `current_weight`). Docs: [HTTP load balancing](https://docs.nginx.com/nginx/admin-guide/load-balancer/http-load-balancer/) (weights; default method is round-robin **with** weight), [nginx.org load_balancing](https://nginx.org/en/docs/http/load_balancing.html).
- [smallnest/weighted](https://github.com/smallnest/weighted) — same algorithm, cites the nginx commit: on each selection add `weight` to `current_weight`, pick max, subtract total.
- Proof: over `S = sum(Wi)` consecutive picks, peer _i_ is chosen `Wi` times ([Stack Overflow 53947129](https://stackoverflow.com/questions/53947129/how-to-prove-the-nginx-smoothing-weight-load-balancing-algorithm-mathematically)).

LiteLLM is a Python router, not a library to embed. new-api is a Go gateway. Neither is an SDK for this feature.

## Integration Patterns

### ccflare / better-ccflare (anti-pattern for per-request balance)

- [snipeship/ccflare load-balancing.md](https://github.com/snipeship/ccflare/blob/main/docs/load-balancing.md): `LB_STRATEGY=session` only. `SESSION_DURATION_DEFAULT = 18000000` (5h). Invalid config falls back to **1h**. Active session = account with latest `session_start` still inside the window; else first available. One global stick, not per client.
- [better-ccflare load-balancing.md](https://github.com/open-horizon-labs/better-ccflare/blob/main/docs/load-balancing.md) (same warning; [tombii/better-ccflare](https://github.com/tombii/better-ccflare) is the same fork family): stick **aligns with Anthropic `rate_limit_reset`** for provider `anthropic` only. Priority 0–100, **lower number = higher priority**, used when no active session. Auto-fallback switches to a higher-priority account when `rate_limit_reset <= now`. Non-Anthropic providers are pay-as-you-go and **do not** get a 5h session.
- Both docs: round-robin / least-requests / weighted were **deleted** because rapid switching looks like abuse and can ban accounts. Safe pattern they keep: switch about once per 5h window.

**Design implication**: weighted spread is opt-in, and OAuth providers must default `stickyRoundRobinLimit > 1` so SWRR does not rotate every request. Sticky window should be long relative to a chat turn; 5h is the Claude **quota** window, not a requirement that the gateway stick for 5h. Per-request SWRR across Claude OAuth accounts is the behavior those proxies removed.

### Other gateways

| System                                                                                                                                                                         | Weight                                                                                                                                                                                                                            | Sticky                                                                                                                                                                                                                                                                                                                      |
| ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| [LiteLLM router](https://docs.litellm.ai/docs/routing)                                                                                                                         | `simple-shuffle`: `weight` (else rpm/tpm). `weight: 2` ≈ 2× pick probability. Not SWRR.                                                                                                                                           | `optional_pre_call_checks: [session_affinity]`. Header `x-litellm-session-id` (also `x-litellm-trace-id`, `x-<vendor>-session-id`, `metadata.session_id`). Pin before strategy. `deployment_affinity_ttl_seconds` default **3600**, refreshed each request (idle TTL). Redis shares pins. Dead pin falls through; pin kept. |
| [OpenRouter provider routing](https://openrouter.ai/docs/guides/routing/provider-selection)                                                                                    | Among healthy cheap providers, P(first) ∝ `1/price²`. Example: $1 vs $3 → 9×. `sort` or `order` **disables** load balancing.                                                                                                      | None. Fallback chain after the weighted first pick.                                                                                                                                                                                                                                                                         |
| [new-api channel docs](https://docs.newapi.ai/en/docs/guide/feature-guide/admin/channel) + [FAQ](https://github.com/QuantumNous/new-api-docs/blob/main/docs/en/support/faq.md) | **Priority first** (higher number wins; default 0). Same priority: **weighted random** by `weight` (2:1 → 2:1). Multi-key mode has the same "Weighted Random" poll. Upstream: [one-api](https://github.com/songquanpeng/one-api). | README lists "channel affinity" beside weights ([new-api README](https://github.com/QuantumNous/new-api)). Selection rule for affinity not fetched.                                                                                                                                                                         |

Closest analogue to this feature: **LiteLLM weight + session affinity**, but affinity is an explicit session id (1h idle), and the picker is random. 9router's `pickSmoothWeighted` is deterministic and smoother; the sticky **count/window** is what keeps OAuth safe, not the picker.

Manual plan/weight override belongs in connection `providerSpecificData.planTier` / `weight`. `computeEffectiveWeight` already prefers `manualWeight`, else `PLAN_CAPACITY[provider][tier]`, else 1, then × headroom. Strategy enum must allow `weighted` and `/api/settings` must reject unknown `providerStrategies` values.

## Constraints and Gotchas

1. **Per-request rotation on Claude OAuth is the documented ban risk.** ccflare/better-ccflare (docs current on main, fetched 2026-09-24). Default sticky limit must be >1 for OAuth subscription providers. API-key providers are outside that warning.
2. **5h is Anthropic's quota window**, also ccflare's stick. better-ccflare resets the stick when `rate_limit_reset` passes, using `<` not `<=` to avoid a boundary race. 9router should drop weight to 0 from headers (`resetsAt`, floor), not copy their global single-account stick.
3. **SWRR vs alternatives**
   - Naive WRR (`AAAAABB`) bursts the heavy account — worst for anti-abuse.
   - Weighted random / lottery: right **expectation**, high short-window variance. Bad when N is small (two Max + one Pro).
   - SWRR: exact ratios in exact arithmetic, smooth interleave (`A,B,A,A,B,…`). O(n), no RNG. State is the `currentWeights` Map the helper already returns.
4. **Precision.** Nginx uses integers. The proof is "exactly Wi times per S picks." `computeEffectiveWeight` returns a **float** (`base * headroom`). The algorithm is linear and fair for positive reals in exact math; IEEE-754 error accumulates. Candidate sets are tiny (handful of accounts), so drift is negligible. Scale to integers (e.g. ×10_000) only if tests require bit-exact quotas. Zero / below-floor weights must be omitted before pick (helper already skips `weight <= 0`).
5. **State is process-local.** Nginx docs: without a shared `zone`, each worker has its own counters. Same for an in-memory Map. Multi-process 9router will not share SWRR cursors or sticks. Acceptable for a single Node process; do not pretend it is global.
6. **Changing weights** (headroom updates every response) resets fairness from that point. Do not require the previous cycle to finish. Drop ids that left the candidate set (helper rebuilds the map from this call's ids).
7. **Header pitfalls.** Unified utilization is 0–1; Codex used-percent is 0–100 (`used100` vs `used01`). Unified reset is epoch seconds, not RFC 3339. A regex that only keeps `-limit/-remaining/-reset` **drops** `-utilization`. Codex "primary" is not always 5h — classify by `window-minutes`. `x-codex-rate-limit-reached-type` has no utilization (already ignored).
8. **Floor 0.05.** All accounts below floor must fall back to "use everyone" or the provider goes dark. That policy stays in the caller, not in `pickSmoothWeighted`.
9. **OpenRouter inverse-square** optimizes price, not plan capacity. Do not copy it for Max vs Pro. Capacity × headroom is the right base; manual weight overrides it.

⚠️ **Freshness**: ccflare strategy removal and 5h default are long-standing (stable). Unified/Codex header **names** are 2026 observations plus in-repo parsers; Anthropic can add claims. `parseClaudeHeaders` already accepts extra `*-utilization` claims on plain header objects.

## Code Examples

Nginx SWRR (integer). `pickSmoothWeighted` is this, with JS numbers:

```text
total = 0; best = null
for peer in peers:
  peer.current_weight += peer.weight
  total += peer.weight
  if best is null or peer.current_weight > best.current_weight:
    best = peer
best.current_weight -= total
return best
```

Weights `{A:5, B:1, C:1}` → sequence spreads A, not `AAAAABC`. Over 7 picks: A×5, B×1, C×1.

LiteLLM (weighted random, not SWRR) — [docs](https://docs.litellm.ai/docs/routing):

```yaml
litellm_params:
  model: azure/chatgpt-v-2
  weight: 9 # picked ~9× vs weight 1
router_settings:
  routing_strategy: simple-shuffle
  optional_pre_call_checks: ["session_affinity"]
  deployment_affinity_ttl_seconds: 3600
```

ccflare stick (only legal strategy) — [docs](https://github.com/snipeship/ccflare/blob/main/docs/load-balancing.md):

```json
{ "lb_strategy": "session", "session_duration_ms": 18000000 }
```

## Open Questions

- Anthropic has not published a spec for `anthropic-ratelimit-unified-*`. Which claim `-representative-claim` selects when 7d binds first is undocumented (**Low** outside observed dumps).
- No primary source states a numeric ban threshold for account switching. Evidence is the two proxies' removal notice, not an Anthropic policy page. How large a sticky limit is "safe" is a product choice (they use 5h / one account).
- new-api "channel affinity" behavior (session key, TTL, interaction with weight) was not read in source. Do not treat it as SWRR.
- Codex primary/secondary mapping to 5h vs weekly **flips by plan**; rely on `window-minutes`, not slot name. Confirmed by in-repo comment and codex issue oscillation (**Medium**).

## Sources

- <https://github.com/snipeship/ccflare/blob/main/docs/load-balancing.md>
- <https://github.com/open-horizon-labs/better-ccflare/blob/main/docs/load-balancing.md>
- <https://github.com/tombii/better-ccflare>
- <https://support.claude.com/en/articles/9797557-usage-limit-best-practices>
- <https://platform.claude.com/docs/en/api/rate-limits>
- <https://www.ssdnodes.com/learn/claude-api-rate-limit-headers-explained>
- <https://www.claudecodecamp.com/p/i-tried-to-reverse-engineer-claude-code-s-usage-limits>
- <https://github.com/NousResearch/hermes-agent/issues/9085>
- <https://github.com/openai/codex/issues/44251>
- <https://docs.nginx.com/nginx/admin-guide/load-balancer/http-load-balancer/>
- <https://nginx.org/en/docs/http/load_balancing.html>
- <https://github.com/smallnest/weighted>
- <https://stackoverflow.com/questions/53947129/how-to-prove-the-nginx-smoothing-weight-load-balancing-algorithm-mathematically>
- <https://docs.litellm.ai/docs/routing>
- <https://openrouter.ai/docs/guides/routing/provider-selection>
- <https://docs.newapi.ai/en/docs/guide/feature-guide/admin/channel>
- <https://github.com/QuantumNous/new-api-docs/blob/main/docs/en/support/faq.md>
- <https://github.com/QuantumNous/new-api>
- <https://github.com/songquanpeng/one-api>
