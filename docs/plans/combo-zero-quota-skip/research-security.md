# Research: Security / Reliability — Skip Providers on Zero Quota Telemetry

## Scope

Decision: skip provider when quota telemetry says 0, before attempting request.
Threat model: headers + cache untrusted input. Failure mode preference: fail-open vs fail-closed.

## Findings (severity-ranked)

### S1 — Untrusted headers drive routing: cache-poison / header-spoof causes starvation

Quota headers (`x-*-quota`, `remaining`, `reset`, rate-limit headers) are provider-controlled, unauthenticated metadata. Treat as advisory, never authoritative.
Attack / failure: malicious or buggy upstream sends `remaining: 0`; router permanently skips healthy provider → traffic concentrates elsewhere → cost spike / induced DoS. Reverse: upstream omits headers; router assumes healthy, hammers exhausted key → 429 storm.
Mitigation: cap skip TTL; require N consecutive zero-signals or error corroboration before long skip; always keep one probe path; log header source + decision.
**Confidence**: High

### S1 — Stale cache converts transient zero into prolonged outage

Zero-quota cache entry outlives actual quota recovery (minute/hour TTL, no invalidation on time-window rollover). All requests skip provider even after reset.
Worse with clock skew: `reset` timestamp in future due to provider clock drift extends skip.
Mitigation: TTL << smallest reset window; absolute max TTL cap (e.g. 60s); jitter; opportunistic re-probe (1% or after short backoff); `reset` parsed defensively, clamped to [min, max].
**Confidence**: High

### S2 — Time-of-check / time-of-use (TOCTOU) race

Check (cache says >0) → dispatch → quota hits 0 mid-flight → 429 anyway. Or check says 0 → skip → quota frees milliseconds later → missed capacity. Skip logic reduces but never eliminates 429s; must not assume pre-check correctness.
Mitigation: skip is optimization only; downstream 429 path stays authoritative and must update cache. Never remove retry-on-429 because skip exists.
**Confidence**: High

### S2 — Invalid / adversarial `reset` value → permanent skip (DoS)

`reset: 9999999999`, unparsable date, `reset: 0`, negative TTL, huge `retry-after`. Naive `skipUntil = reset` = provider dead for hours/forever.
Mitigation: strict parse; reject-to-fail-open on invalid; clamp `skipUntil` to `[now+minBackoff, now+maxSkip]`; metric + warn on invalid values.
**Confidence**: High

### S2 — Fail-open unknown vs fail-closed zero: wrong default breaks availability

Fail-closed (unknown = skip, zero = skip): any telemetry gap or new provider without headers gets skipped → cold-start starvation, single-provider dependence.
Fail-open (unknown = try, zero = skip): exhausted key gets retried until error feedback → 429 burst but self-corrects.
Recommendation: fail-open on unknown/invalid; fail-closed only on corroborated zero (header zero + recent 429/402, or repeated zeros). Unknown providers must receive traffic.
**Confidence**: Medium — depends on provider billing vs availability priority; state assumption explicitly.

### S2 — Antigravity special cache: separate path = separate bypass risk

If Antigravity (or any special-cased provider) uses distinct quota cache/keying, bugs diverge: (a) special cache never invalidated → silent permanent skip; (b) special cache keyed differently → skip applies to wrong model/key scope → over-skip or under-skip; (c) special path skips shared 429-feedback update → feedback loop broken.
Mitigation: one shared skip-decision interface; special providers only supply parser params, not separate control flow; same TTL caps + same 429 feedback; test matrix covers special path explicitly.
**Confidence**: Medium — structural risk, no code inspected per task boundary.

### S3 — Potential starvation loop / traffic concentration DoS

All providers report zero (real exhaustion or spoofed) → router skips all → no candidate → must still do something. Options: return 429 immediately (fail-closed, user-visible outage) or try least-bad candidate anyway (fail-open, extra upstream 429s).
Second-order: skipping healthy-but-falsely-zero provider shifts load to expensive/fragile fallback → cost / cascade failure.
Mitigation: "all-skipped" escape hatch: pick lowest-penalty candidate and attempt with short timeout; emit `all_providers_skipped` metric + alert; per-provider skip, never global lock.
**Confidence**: High

### S3 — Negative-value / type-confusion headers

`remaining: -1` (means unlimited on some APIs), `"0"` vs `0` vs `""` vs missing. String compare or falsy check misclassifies unlimited as zero or vice versa.
Mitigation: explicit numeric parse; `-1`/negative = unlimited convention documented per provider; missing/NaN = unknown → fail-open.
**Confidence**: High

## Recommended Decision Rules

1. Unknown / invalid / unparsable → attempt (fail-open).
2. Zero → short skip only, TTL clamped, max ~60s.
3. Long skip only with corroboration (recent 429/402 or N consecutive zeros).
4. All-skipped → attempt least-bad candidate, alert.
5. Single skip-decision code path for all providers including Antigravity; only parsers differ.
6. 429/402 response always overrides cache (authoritative feedback).

## Uncertainties & Gaps

- Provider-specific zero semantics (`0` vs `-1` vs missing) need per-provider table; not verified here.
- Optimal TTL / corroboration threshold (N, backoff values) needs load-test data.
- No code inspected (per task boundary); cache keying / invalidation assumptions unverified — confirm with owning researcher.
