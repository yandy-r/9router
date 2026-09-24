# YAN-261 — External Research: Weighted Routing Algorithms & Gateway Patterns

Role: api-researcher. Date: 2026-09-24.

## Executive Summary

- **Algorithm is settled: nginx smooth weighted round-robin (SWRR)**, already shipped as
  `pickSmoothWeighted` (`open-sse/services/weightedRoundRobin.js:12-51`). It is deterministic.
  With integer weights summing to `S`, every window of `S` consecutive picks gives candidate
  `i` exactly `w_i` picks. **Confidence: High** (nginx commit + formal proof below).
- **Use deterministic SWRR, not weighted random (LiteLLM/Portkey style).** The acceptance test
  (A≈75% ±2% over 1000 requests) is **exact** under SWRR: 750 ±1. Under weighted random,
  σ≈1.37%. That puts ±2% at about 1.46σ, so the test fails about 14% of runs. For A≈37.5%,
  σ≈1.53%, so the test fails about 19% of runs. **Confidence: High** (binomial arithmetic).
- **Static weight × live capacity is standard.** nginx `effective_weight`, Angie/nginx Plus
  `slow_start` throttle, Envoy ORCA client-side WRR, and GCP's
  `X-Load-Balancing-Endpoint-Weight` all scale a configured weight at runtime. The plan's
  `userWeight × providerHeadroom` (unknown=1) matches this pattern. OpenRouter and LiteLLM
  also fail open on unknown or healthy capacity. **Confidence: High**
- **Weight 0 means "no new primary traffic, still reachable"** in HAProxy, Portkey, AWS, and
  GCP. This matches the brief: weight 0 stays in the fallback tail only. **Confidence: High**
- **Fallback tail after the weighted head is the OpenRouter pattern.** OpenRouter picks the
  first provider by weight, then uses the rest as ordered fallbacks. LiteLLM
  `enable_weighted_failover` instead re-picks by weight among the rest. The plan uses the
  original order for the tail, which is simpler and keeps the existing `handleComboChat` loop.
  **Confidence: High**
- **No new dependency is needed.** SWRR is about 20 lines and already in the repo. The npm
  weighted-pick packages found are random-based or unmaintained and would not help the
  deterministic tests. **Confidence: High**

## Primary APIs

### nginx upstream (reference implementation)

- Docs: <https://nginx.org/en/docs/http/ngx_http_upstream_module.html> (`weight=number`,
  default 1; `backup`; `down`; `slow_start` recovers weight "from zero to a nominal value",
  Plus only).
- Algorithm commit: <https://github.com/nginx/nginx/commit/52327e0627f49dbda1e8db695e63a4b0af4448b1>
  - Each pick adds `effective_weight` to each eligible peer's `current_weight`.
  - It selects the maximum, then subtracts the total.
  - For `{5,1,1}`, the sequence is `a a b a c a a`.
- `effective_weight` is lowered on failures (`-= weight/max_fails`) and recovers by +1 per
  pick. This is nginx's version of "live capacity scales static weight down".
  Source: <https://github.com/phusion/nginx/blob/master/src/http/ngx_http_upstream_round_robin.c>
- Angie fork: `effective_weight * ngx_http_upstream_throttle_peer(peer)` is a multiplicative
  runtime scaler, the same shape as `weight × headroom`.
  Source: <https://github.com/webserver-llc/angie/blob/f3e414a3/src/http/ngx_http_upstream_round_robin.c>
- Proof of exact distribution (sum of current weights is always 0, and no peer with negative
  current weight is picked): <https://stackoverflow.com/questions/53947129> (2019; stable topic).

### LiteLLM Router

- Docs: <https://docs.litellm.ai/docs/routing> and <https://docs.litellm.ai/docs/proxy/load_balancing>
- `simple-shuffle` is the default and does a **weighted random** pick. It uses `weight`, then
  `rpm`, then `tpm`, whichever is set first; with none set it does a uniform shuffle.
  Deepwiki: <https://deepwiki.com/BerriAI/litellm/2.3.1-routing-strategies>
- `order` works like priority tiers. Weight only picks within the lowest order tier.
  - A 429 puts the deployment in cooldown.
  - `enable_weighted_failover` excludes failed deployment IDs and renormalizes weights over the
    rest (async only, capped by `max_fallbacks`).
- Weight is honored only by `simple-shuffle`. Docs once claimed otherwise; fixed per
  <https://github.com/BerriAI/litellm/discussions/9200> (2025-03). **Confidence: Medium-High**
- RPM/TPM feed routing but are not hard limits unless `enforce_model_rate_limits` is set.

### OpenRouter provider routing

- Docs: <https://openrouter.ai/docs/guides/routing/provider-selection>
- Default steps:
  1. Drop providers with outages in the last 30s.
  2. Among the cheapest candidates, pick one **weighted by inverse-square price**.
  3. Use the remaining providers as fallbacks.
- `order` or `sort` disables load balancing and uses strict order. `allow_fallbacks: false`
  pins routing.
- Model fallbacks (`models: [...]`) are tried in array order:
  <https://openrouter.ai/docs/guides/routing/model-fallbacks>
- Closest analogue to YAN-261: a weighted first choice plus an ordered fallback tail.
  **Confidence: High**

### Portkey gateway `loadbalance`

- Docs: <https://docs.portkey.ai/docs/product/ai-gateway/load-balancing>
- Weights are normalized (5,3,1 → 55/33/11%), then each request routes by probability
  (random).
- Default `weight` is `1`, minimum is `0`, and `"weight": 0` "stop[s] routing traffic to it
  without removing it from your Config". Source:
  <https://docs.portkey.ai/docs/virtual_key_old/product/ai-gateway/load-balancing>
- Sticky mode is `sticky: { enabled, hash_fields: ["metadata.user_id"], ttl }`. It is
  hash-keyed session affinity, not a count-based window.
- Composable: a `loadbalance` target can nest a `fallback` strategy and the reverse:
  <https://portkey.ai/docs/guides/use-cases/combining-routing-strategies>

### Envoy

- Docs: <https://www.envoyproxy.io/docs/envoy/latest/intro/arch_overview/upstream/load_balancing/load_balancers>
- Unequal host weights use a weighted RR schedule. It is EDF-based, not nginx SWRR, but has the
  same long-run proportions.
  Explainer: <https://dev.to/spacewander/rambling-about-load-balancing-algorithms-19fd>
- `ClientSideWeightedRoundRobin` gets weights from ORCA load reports (QPS, EPS, utilization).
  This is live-capacity weighting.
- Locality weights are adjusted down when endpoints are unhealthy, with an over-provision
  factor of 1.4:
  <https://www.envoyproxy.io/docs/envoy/latest/intro/arch_overview/upstream/load_balancing/locality_weight>
- Endpoint `load_balancing_weight` must be ≥1. Route-level `weighted_clusters` allow 0.
  **Confidence: Medium** (from proto memory, not re-fetched).

### HAProxy

- Manual: <https://www.haproxy.com/documentation/haproxy-configuration-manual/latest>
- `weight` is 0–256 with default 1. Weight 0 removes the server from load balancing, but
  existing and persistent connections continue.
- The `backup` keyword and the `first` algorithm give strict-order fallback.
  Community thread: <https://discourse.haproxy.org/t/how-to-have-a-primary-and-a-backup-server-and-switch-them/4361>
- Confirms: weight 0 means no primary traffic, not deletion. **Confidence: High**

## Libraries and SDKs

| Option                                                                                             | Type                                         | Verdict                                    |
| -------------------------------------------------------------------------------------------------- | -------------------------------------------- | ------------------------------------------ |
| In-repo `pickSmoothWeighted` (`open-sse/services/weightedRoundRobin.js:12`)                        | SWRR, float weights, Map state, never throws | **Use**                                    |
| `smallnest/weighted` (Go) — <https://github.com/smallnest/weighted/blob/master/smooth_weighted.go> | SWRR reference                               | Reference only                             |
| npm weighted-random pickers                                                                        | `Math.random`                                | Reject: non-deterministic, breaks ±2% gate |
| LiteLLM / Portkey SDKs                                                                             | Full gateways                                | Out of scope; 9Router _is_ the gateway     |

**New dependency: not warranted.** **Confidence: High**

## Integration Patterns

1. **Effective weight = static × live factor** (nginx, Angie, Envoy ORCA, GCP header):
   `eff = (weights[model] ?? 1) × getProviderHeadroom(...).headroom`. `getProviderHeadroom` is
   already fail-open: an unknown connection has headroom 1 and takes the max across
   connections (`open-sse/services/quotaSnapshot.js:303-333`). Take the max, not the min. One
   healthy account means the provider can still serve.
2. **Weighted head + ordered tail** (OpenRouter): return `[pick, ...models.filter(m => m !== pick)]`.
   This keeps the existing sequential failover and Retry-After handling in `handleComboChat`
   unchanged.
3. **Weight 0 = fallback-only** (HAProxy, Portkey, AWS NLB): `pickSmoothWeighted` already skips
   `weight <= 0` (`weightedRoundRobin.js:31`). The model stays in the tail because the tail is
   built from the full `models` list.
4. **All effective weights zero, so plain fallback order** (nginx: "no peers" becomes a backup
   list): `id === null` from `pickSmoothWeighted` means return `models` unchanged. This also
   covers "every provider exhausted (headroom 0)". Stay fail-open and let the upstream
   429/Retry-After decide.
5. **Stickiness as a count window.** Mirror the `getRotatedModels` state shape
   (`combo.js:218-248`): `{ head, remaining, currentWeights }`.
   - Keep `head` for `stickyLimit` requests, then call `pickSmoothWeighted` again.
   - Proportions hold across sticky windows because each pick covers `k` requests.
   - Also re-pick early when the sticky head's effective weight becomes 0 (weight edited to 0,
     or headroom exhausted). nginx does the same: peers that are down or over `max_fails` are
     skipped immediately. Portkey's hash sticky is a different feature, so skip it.
6. **State lifecycle.** Key state by combo name, same map as round-robin or a sibling map.
   - Clear it in `resetComboRotation` (`combo.js:254-256`), which settings PATCH already calls.
   - A candidate that leaves the eligible set loses its `currentWeight` (the `next` map only
     keeps eligible IDs), so it re-enters at 0. This is harmless.
   - On combo rename, drop the old key.

## Constraints and Gotchas

- **Determinism vs randomness.** SWRR from fresh state always picks the heaviest first, and
  ties go to the earliest in input order (strict `>`, `weightedRoundRobin.js:36`).
  - For `{A:3,B:1}` the sequence is `A A B A` (repeats). Tests can assert exact counts: 750/250
    over 1000 at sticky 1.
  - For `{A:0.6,B:1}` (headroom 0.2) the long-run share is 0.6/1.6 = 37.5%.
- **Deviation bound (float weights).** `picks_i(n) − n·w_i/S = −CW_i(n)/S`, and `|CW_i|` stays
  below `S·(N−1)`. So deviation is under `N−1` picks. For N=2 that is under 1 request, far
  inside ±2% (±20). With sticky `k`, the bound becomes under `k·(N−1)` requests, so a sticky
  test must use `1000 % k === 0` or a looser tolerance. **Confidence: High** (follows from the
  zero-sum property).
- **Float drift.** Repeated `+w`/`−S` on floats accumulates tiny error. It does not matter over
  thousands of picks, but tests should assert counts, not exact `currentWeights`.
- **Herd effect.** nginx-devel (2020-11) proposed random initial `current_weight` so many
  workers do not all hit the heaviest peer first:
  <https://mailman.nginx.org/pipermail/nginx-devel/2020-November/013589.html>
  9Router runs in one process, so skip it. It would also break deterministic tests.
- **Per-process state.** Multiple Node workers would each keep separate SWRR state. Each stays
  exact, and the union stays proportional. LiteLLM needs Redis only for shared RPM/TPM. Not
  needed here.
- **Headroom churn.** When headroom changes between picks, SWRR adapts on the next pick with no
  reset. Accumulated current weight is bounded by `S`, so lag is at most one cycle.
- **Weight semantics differ by gateway.** Portkey normalizes floats. LiteLLM accepts any
  positive number. HAProxy uses integers 0–256. Validation should accept any finite number
  ≥ 0 (brief §6) and reject NaN, Infinity, negatives, and non-numbers with 400.
- **Plan-tier numbers do not compare across providers** (brief). No external gateway compares
  them either. LiteLLM's `rpm`/`tpm` weights apply only among deployments of one model group.
  This backs using user weights at combo level.
- **LiteLLM weight-docs drift** (discussion #9200) is a reminder to document exactly which
  strategy honors `weights` (weighted only; ignored by fallback, round-robin, and fusion).

## Code Examples

Target shape for `getWeightedModels`. Sketch only; the implementer owns the final code.

```js
import { pickSmoothWeighted } from "./weightedRoundRobin.js";

const weightedState = new Map(); // comboName -> { head, remaining, currentWeights }

export function getWeightedModels(
  models,
  comboName,
  weights = {},
  headroomFn = () => 1,
  stickyLimit = 1,
) {
  if (!comboName || models.length <= 1) return models;
  const eff = (m) => (weights[m] ?? 1) * headroomFn(m);
  const state = weightedState.get(comboName);
  // Sticky: keep head while window open and head still eligible.
  if (state?.remaining > 0 && models.includes(state.head) && eff(state.head) > 0) {
    state.remaining--;
    return [state.head, ...models.filter((m) => m !== state.head)];
  }
  const { id, currentWeights } = pickSmoothWeighted(
    models.map((m) => ({ id: m, weight: eff(m) })),
    state?.currentWeights,
  );
  if (id === null) return models; // all-zero -> plain fallback order
  weightedState.set(comboName, {
    head: id,
    remaining: normalizeStickyLimit(stickyLimit) - 1,
    currentWeights,
  });
  return [id, ...models.filter((m) => m !== id)];
}
```

Distribution test (vitest; exact under SWRR):

```js
const counts = { A: 0, B: 0 };
for (let i = 0; i < 1000; i++)
  counts[getWeightedModels(["A", "B"], "c", { A: 3, B: 1 }, () => 1, 1)[0]]++;
expect(counts.A).toBeGreaterThanOrEqual(730); // spec ±2%; SWRR gives exactly 750
expect(counts.A).toBeLessThanOrEqual(770);
```

Headroom scaling: `headroomFn = (m) => (m === "A" ? 0.2 : 1)` gives `counts.A ≈ 375` (±20).

Weighted-random counterexample (do **not** use; LiteLLM/Portkey style):

```js
const r = Math.random() * total; // σ ≈ 13.7 requests at p=0.75, n=1000 -> ±2% gate flakes ~14%
```

## Open Questions

1. **Duplicate models in a combo** (e.g. `["cc/opus","cc/opus"]`): `pickSmoothWeighted`
   dedupes IDs (`weightedRoundRobin.js:27`), so weights are keyed by model string. Confirm
   duplicates are rejected or collapsed upstream.
2. **Headroom per model vs per provider.** `getProviderHeadroom(provider, connectionIds, model)`
   needs the provider's active connection IDs at routing time. Where does the combo layer get
   them cheaply? This is a codebase question for the integration researcher.
3. **Nested combos** (a model entry that is itself a combo): headroom is undefined, so treat it
   as 1 (fail-open). Confirm this is acceptable.
4. **Capability auto-switch order.** Should `reorderByCapabilities` run before or after the
   weighted head pick? After would override weights for image or tool requests. OpenRouter
   filters capability first (`require_parameters`), which suggests filter first, then weight.
5. **Media combos.** Weighted adds little when headroom is mostly unknown for media providers.
   The external pattern (Portkey, LiteLLM) applies weights to every modality, but it is fine to
   exclude media explicitly for phase 3.
6. **Envoy endpoint weight ≥1 constraint** is from memory and not re-verified. It does not
   affect the design.

## Search Queries Executed

1. nginx smooth weighted round robin algorithm currentWeight effectiveWeight
2. LiteLLM router weighted routing load balancing weights
3. OpenRouter provider routing load balancing weight fallback
4. Portkey gateway loadbalance weight routing strategy
5. Envoy weighted clusters load balancing smooth round robin weight 0 semantics
6. HAProxy server weight 0 drain backup
7. Portkey loadbalance weight 0 target excluded
8. nginx upstream server weight parameter default 1 backup down slow_start documentation
