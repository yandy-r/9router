# YAN-260 Weighted Account Strategy — Security Review

## Executive Summary

Feature adds `weighted` strategy: per-provider SWRR `Map` in new module, `manualWeight`/`planTier` via connection PUT, `fallbackStrategy` whitelist in settings PATCH. Authz posture good (deny-by-default proxy); main risks are mass-assignment on both write routes and fail-open weight defaults. No new deps, no secrets, no outbound calls beyond existing poller.

## Findings by Severity

### CRITICAL

| #   | Finding                                                                                                                                      | Evidence                                                      | Fix                                                                                            |
| --- | -------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------- | ---------------------------------------------------------------------------------------------- |
| C1  | Connection PUT merges arbitrary `providerSpecificData` — attacker with dashboard access can set `manualWeight`, `copilotToken`, OAuth fields | `providers/[id]/route.js:138-141` spread-merge, no allow-list | Allow-list psd keys; validate `manualWeight` numeric bounds server-side                        |
| C2  | Settings PATCH mass-assigns full body via shallow merge — unknown keys persist, `providerStrategies` unbounded                               | `settings/route.js:86`, `settingsRepo.js:98-111`              | Zod-ish manual validation: whitelist strategies, reject unknown, 400 on bad `fallbackStrategy` |

### WARNING

| #   | Finding                                                                                                    | Evidence                                                                                                                                                                                         | Fix                                                                                                                                                               |
| --- | ---------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| W1  | `__proto__` provider-strategy key pollutes merged settings object                                          | `updateSettings` `{...current,...updates}`; `(settings.providerStrategies\|\|{})[providerId]` in `auth.js:76,186`                                                                                | Reject keys in `__proto__/constructor/prototype`; validate provider IDs against registry                                                                          |
| W2  | `Number(stickyLimit) \|\| 3` collapses 0/NaN; unbounded sticky pins account, hurts OAuth ban posture       | `auth.js:203-204`, UI `Number(stickyLimit)\|\|3` (`ConnectionsCard.js:508`)                                                                                                                      | Clamp to 1..100 integer; NaN/non-finite → 400                                                                                                                     |
| W3  | `manualWeight` Infinity/huge/negative skews SWRR or starves accounts; `manual===0` hard-excludes           | `quotaSnapshot.js:340` only `>=0` finite check; no upper cap                                                                                                                                     | Cap e.g. 0..1000; reject non-numeric strings (avoid silent `Number("5")` acceptance unless intended)                                                              |
| W4  | SWRR `Map<provider, currentWeights>` grows with stale connection IDs; no eviction precedent                | `pickSmoothWeighted` returns `next` with only live candidates (prunes on pick), but deleted-connection keys linger between picks; combo precedent has no eviction either (`combo.js:95,254-256`) | Prune on delete path + cap entries; reset on strategy/pool change                                                                                                 |
| W5  | Manual `planTier` overwritten by auto-detect poller (`persistPlanTier`, `quotaSnapshotSync.js:141-165`)    | Same finding in recommendations R5                                                                                                                                                               | `providerSpecificData.planTierManual` flag; skip auto-persist when set; sanitize via existing `sanitizePlanTier` (already blocks `__proto__`, 64-char cap — good) |
| W6  | Auth bypass when `requireLogin=false`: local dashboard keys fully open including settings/providers writes | `dashboardGuard.js:161-166` `isAuthenticated` true when disabled; deny-by-default otherwise OK                                                                                                   | Document; consider re-auth (password) for strategy/weight changes even when login disabled                                                                        |

### ADVISORY

| #   | Finding                                                                                                                                                 | Evidence                                                                            | Fix                                                                          |
| --- | ------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------- | ---------------------------------------------------------------------------- |
| A1  | Quota snapshot surfaces plan/usage per connection; `providers/client` allow-list already excludes `planTier` — weighted UI chips must not leak it there | `providers/client/route.js:28-51` no `planTier`/`manualWeight` in `SAFE_PSD_FIELDS` | Add explicit fields to allow-list only where intended; keep tier server-side |
| A2  | `preferredConnectionId` (`x-connection-id` header) bypasses strategy — fine (explicit pin) but weighted telemetry should log it                         | `auth.js:191-199`                                                                   | Keep; log strategy bypass                                                    |
| A3  | Fail-open weight (`catch → weight 1`, unknown snapshot → headroom 1) is availability-correct; under attacker-controlled NaN input it silently equalizes | `quotaSnapshot.js:320-323,381-390`                                                  | Fail-open only for missing data; 400 on malformed stored values              |
| A4  | `sameSite: lax` dashboard cookie + PATCH JSON API: CSRF via top-level form unlikely (JSON content-type), but no explicit CSRF token                     | `dashboardSession.js:66`                                                            | Accept for localhost-first app; note if tunnel-exposed                       |

## Authentication and Authorization

- Proxy deny-by-default: `/api/*` requires JWT/CLI token; `/api/settings`, `/api/providers`, `/api/usage`, `/api/oauth` all in protected list (`dashboardGuard.js:35-53,204-209`). Good.
- `ALWAYS_PROTECTED` covers shutdown/database; settings PATCH relies on standard gate — acceptable, but W6 applies.
- No authz gap specific to weighted: same routes, new fields. Validate at handler, not guard.

## Data Protection

- No new PII/secrets. `planTier`/`manualWeight` non-sensitive. Secrets (`apiKey`, tokens) already stripped in GET (`providers/[id]/route.js:73-77`).
- Quota data (usedFraction, reset times) reveals usage cadence — restrict visibility chips to authenticated dashboard (already gated), don't add to public LLM API responses.

## Dependency Security

- Zero new dependencies (pure JS + existing store). No audit needed.

## Input Validation

| Input                                           | Today                                                       | Required                                                    |
| ----------------------------------------------- | ----------------------------------------------------------- | ----------------------------------------------------------- |
| `providerStrategies[*].fallbackStrategy`        | saved as-is                                                 | whitelist `fill-first\|round-robin\|weighted`, else 400     |
| `stickyRoundRobinLimit` (global + per-provider) | `Number(x)\|\|3`, no upper bound                            | integer 1..100, reject NaN/Infinity/strings                 |
| `providerStrategies` keys                       | any string incl. `__proto__`                                | registry-validated provider IDs only                        |
| `manualWeight` (psd)                            | no validation exists yet                                    | finite number 0..1000, reject NaN/Infinity/negative/strings |
| `planTier` override                             | `sanitizePlanTier` good (lowercase, ≤64, blocks proto keys) | reuse it; add manual flag                                   |
| `floor` override                                | clamped 0..1 (`quotaSnapshot.js:371`) — good                | keep                                                        |

## Infrastructure Security

- SWRR state in-memory per process: multi-instance drift (each replica balances independently) — availability-neutral, no shared-secret risk. Cap + prune (W4).
- Poller does extra upstream usage fetches for weighted providers only when gated — bounded by existing tick/stale/failure-cooldown (`quotaSnapshot.js:12`). No new DoS amplifier beyond opt-in.
- `updateProviderConnection` per-request DB write inside mutex already exists for round-robin; weighted sticky keeps same contention — no new DoS, note latency.

## Secure Coding Guidelines

1. Validate-then-merge: never spread raw body into settings/psd.
2. Reject `__proto__`/`constructor`/`prototype` keys on any user-keyed object.
3. Numeric inputs: `Number.isFinite` + explicit range; never `\|\|` defaults (swallows 0).
4. Fail-open for missing upstream data; fail-closed (400) for malformed stored config.
5. Reset in-memory routing state on strategy/pool/connection-delete changes.

## Trade-off Recommendations

- Server-side whitelist strictness vs UI convenience: be strict (400 with field-level error) — dashboard is single-client, cheap to fix UI.
- `manualWeight` strings: reject (don't coerce) — coercion hides injection probes; UI sends numbers.
- Sticky default >1 for OAuth subscription providers (anti-ban): keep as config table, cap at ~10 to bound blast radius of a pinned sick account.

## Open Questions

1. Should weight/strategy edits require password re-auth when `requireLogin=false`?
2. Upper bound for `manualWeight` — 100? 1000? (distribution tests assume ratios, not absolutes)
3. Single global SWRR module vs per-worker: acceptable drift on multi-instance deploys?
4. ToS/ban risk: default sticky values per OAuth provider — product call, not security gate.
