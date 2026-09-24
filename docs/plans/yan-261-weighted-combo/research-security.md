# YAN-261 Security Research: Weighted Combo Strategy + Weights Editor

## Executive Summary

No CRITICAL findings. Settings/combos routes inherit auth from `src/dashboardGuard.js:proxy` (`/api/settings`, `/api/combos` in `PROTECTED_API_PATHS`, dashboardGuard.js:36-42) — no in-route auth, single enforcement point. Biggest real risks: (1) no validation on `comboStrategies`/`weights` in `PATCH /api/settings` (settings/route.js:45-141) — fail-safe today (unknown strategy falls through to fallback) but weighted gate is exact-match `=== "weighted"`; (2) `__proto__` passes combo-name regex (combos/[id]/route.js:6) and `updated[comboName] = next` assignment (combos/page.js:204) triggers the prototype setter; server spread-merge is safe; (3) combo rename orphans `comboStrategies[oldName]` (combos/[id]/route.js:71-79 resets memory only, no settings migration) — stale strategy + slow state bloat. Quota snapshot pipeline (YAN-259) already sanitizes (`BLOCKED_KEYS`, quotaSnapshot.js:15) and fails open — reuse those helpers. **Confidence**: High (all claims traced to cited lines).

## Findings by Severity

### CRITICAL

| #   | Finding                                                                                                                                                                                                  | Evidence                                        | Mitigation                                               |
| --- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------- | -------------------------------------------------------- |
| —   | None. Auth enforced at middleware, secrets stripped (`password`, `oidcClientSecret`, settings/route.js:15,20,130), no new trust boundary (dashboard-authenticated user already has full settings write). | dashboardGuard.js:204-209; settings/route.js:50 | Keep it that way: validate in-route, never bypass guard. |

### WARNING

| #   | Finding                                                                                                                                                                                                                                                                                                                                                                         | Evidence                                                                              | Mitigation                                                                                                                                                                                                                                                    |
| --- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| W1  | No strategy whitelist: any `fallbackStrategy` string persists; unknown values silently behave as fallback at all ~7 call sites. Typo (`"weightd"`) = silent misroute; only exact `"weighted"` starts poller.                                                                                                                                                                    | settings/route.js:86 (no validation); chat.js:112-113; quotaSnapshotPoller.js:172-180 | Whitelist `fallback\|round-robin\|fusion\|weighted` in PATCH → 400 else (brief §6). Validate `comboStrategy` global too.                                                                                                                                      |
| W2  | No weights validation: `weights` object accepted verbatim via mass-merge `updateSettings` (`{...current, ...updates}`, settingsRepo.js:104). Negative/NaN-as-null/huge objects persist to DB and flow into per-request path.                                                                                                                                                    | settingsRepo.js:98-111; settings/route.js:86                                          | Fail-closed validator at PATCH: plain object, string keys ≤128 chars, values finite numbers `0 ≤ w ≤ MAX` (suggest 1000), entry cap (suggest ≤200). Reject `__proto__`/`constructor`/`prototype` keys → 400. Cap stops DB bloat + per-request iteration cost. |
| W3  | Combo rename orphans `comboStrategies[oldName]`: PUT migrates nothing in settings; `resetComboRotation` clears memory only. Stale `{fallbackStrategy:"weighted"}` keeps poller running for a dead name; repeated renames grow the map.                                                                                                                                          | combos/[id]/route.js:71-79; weightedTargets.js:9; quotaSnapshotPoller.js:178-180      | On rename, move `comboStrategies[old]→new` (delete old) in same request; on delete, drop entry. Do it server-side (client `handleSetComboStrategy`, combos/page.js:196-217, cannot be trusted to run).                                                        |
| W4  | `__proto__` passes `VALID_NAME_REGEX` (`/^[a-zA-Z0-9_.-]+$/`); dashboard `updated[comboName] = next` (combos/page.js:204) with `comboName="__proto__"` hits the prototype setter, not an own property. Server spread (`{...}`) is safe (CreateDataProperty), so blast radius is the browser session, but `comboStrategies["__proto__"]` reads then resolve via prototype chain. | combos/[id]/route.js:6; combos/page.js:198-205                                        | Block `__proto__`/`constructor`/`prototype` as combo names (400) + build maps with `Object.create(null)` or `Map` in new code; use `Object.hasOwn` guards on read (already used in settings/route.js:99-101 — extend pattern).                                |
| W5  | State maps keyed by combo name are unbounded across renames/deletes: `comboRotationState` (combo.js:95) + planned weighted WRR state. Deletes clear one key (combos/[id]/route.js:99); orphaned settings entries (W3) keep poller-side work alive. Authenticated-only writers bound the rate, so DoS needs a malicious/buggy dashboard client, not an LLM API caller.           | combo.js:95,254-257                                                                   | W3 fix covers most; add `Map` size cap with oldest-eviction (mirror `evictOldestIfNeeded`, quotaSnapshot.js:41-58) to new weighted state; `resetComboRotation()` full clear already exists for settings-wide change.                                          |

### ADVISORY

| #   | Finding                                                                                                                                                                                                                                                                                                                                  | Evidence                                              | Mitigation                                                                                                                                 |
| --- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------ |
| A1  | `requireLogin=false` opens `/api/settings` + `/api/combos` to anyone with network access (deny-by-default bypass, dashboardGuard.js:161-166,206). Weights tampering then needs no credential. Pre-existing posture, not introduced by YAN-261.                                                                                           | dashboardGuard.js:161-166                             | Document: weighted editing assumes trusted LAN when login disabled; no code change in scope.                                               |
| A2  | `judgeModel`/`fusionTuning` also unvalidated in `comboStrategies[*]` — out of scope (fusion unaffected) but same PATCH validator should whitelist entry shape so weights work doesn't leave a hole next to it.                                                                                                                           | chat.js:136-137                                       | Validate entry as `{fallbackStrategy enum, weights?, judgeModel string ≤256?, fusionTuning object?}`; reject unknown fields or strip them. |
| A3  | Share-% preview exposes relative quota (`usedFraction`, `planTier`) to dashboard viewers via `buildQuotaSnapshotView` (quotaSnapshotSync.js:251-277) served by usage route (usage/[connectionId]/route.js:212-215, auth-gated). No LLM-API-client exposure (`/v1/*` never returns snapshots). Low sensitivity, already-trusted audience. | quotaSnapshotSync.js:251-277; dashboardGuard.js:35-53 | No change; do not send raw windows to UI if only a % is needed — compute share server-side or keep as-is (accepted).                       |
| A4  | Enabling weighted starts background upstream usage polling (`configureQuotaSnapshotPoller`, settings/route.js:115-128). Authenticated-only trigger; probes reuse existing usage handlers, throttled + failure-cached. Side effect worth noting, not a vuln.                                                                              | quotaSnapshotPoller.js:87-121,172-183                 | Log poller start/stop (already `console.log`, :156,167); no change.                                                                        |
| A5  | `updateCombo` mass-merges `data` (`{...rowToCombo(row), ...data}`, combosRepo.js:66) — a PUT body with `id`/`createdAt` overwrites identity fields. Pre-existing, adjacent to rename work.                                                                                                                                               | combosRepo.js:60-77                                   | Allowlist body fields (`name`, `models`, `kind`) in combos PUT; zero cost.                                                                 |

## Authentication and Authorization

- Enforcement is middleware-only: `proxy()` deny-by-default for `/api/*` (dashboardGuard.js:204-209); `ALWAYS_PROTECTED` unaffected. Neither settings nor combos route does in-route auth — correct DRY, but any future route bypassing middleware inherits nothing. **Confidence**: High.
- `LOCAL_ONLY_PATHS` does not include settings/combos — remote dashboard users with JWT can edit weights by design. **Confidence**: High.
- `requireLogin=false` degrades to network-trust (A1). Recommend noting in feature docs, not code.

## Data Protection

- GET `/api/settings` strips `password`, `oidcClientSecret` (settings/route.js:20,130); weights contain no secrets. Quota view exposes `planTier` + fractions only — no tokens (usage route builds `credentials` server-side, never returns them, usage/[connectionId]/route.js:33-44). **Confidence**: High.
- `updateSettings` persists whole `comboStrategies` blob to SQLite/JSON store via `stringifyJson` (settingsRepo.js:105-108) — attacker-shaped keys survive round-trip (`JSON.parse` restores own `__proto__` data property), so validation must sit before persistence (PATCH), not at read. **Confidence**: Medium (adapter escaping relies on parameterized `?`, settingsRepo.js:106 — parameterized, safe).

## Dependency Security

- No new dependencies needed: validation is stdlib (`Number.isFinite`, `Object.hasOwn`, `typeof` checks); smooth-WRR + headroom already vendored (weightedRoundRobin.js, quotaSnapshot.js). `bcryptjs` (password hashing, settings/route.js:5) untouched. Recommendation: add none. **Confidence**: High.

## Input Validation

Required PATCH contract (fail-closed, 400 on violation):

- `comboStrategy`: enum `fallback|round-robin|fusion|weighted`.
- `comboStrategies`: plain object; keys = combo-name charset, ≤64 chars, not in `{__proto__, constructor, prototype}`; entry cap (suggest 200).
- Entry: `fallbackStrategy` enum; `weights` optional plain object — keys string ≤128, blocked-keys rejected, values `typeof number && Number.isFinite && 0 ≤ v ≤ 1000`; key-count cap (suggest 200 or `combo.models.length` when known — prefer static cap, membership drifts independently); `judgeModel` optional string ≤256; `fusionTuning` optional object.
- Read path stays fail-open (ignore unknown weight keys, `?? 1` default, all-zero → fallback order) so a DB edited out-of-band can't break routing — defense in depth behind the write validator.
- Reuse `BLOCKED_KEYS` convention from quotaSnapshot.js:15 (import or duplicate one-liner; do not invent a third list).

## Infrastructure Security

- Poller is the only new background workload; single-instance guard via `global.__quotaSnapshotPoller` (quotaSnapshotPoller.js:27-34), `unref`'d timer (:160) — no process-hang risk. Refresh reuses route helper (quotaSnapshotPoller.js:16,98) — credential handling unchanged. **Confidence**: High.
- No child-process, SSRF, or new network surface: weights never become URLs/commands; `headroomFn` is internal (`getProviderHeadroom`, quotaSnapshot.js:303). **Confidence**: High.

## Secure Coding Guidelines

1. Validate at PATCH (trust boundary), sanitize-again at read (unknown keys ignored, finite-clamped).
2. Never `obj[userKey] = …` with user keys — use `Map` or `Object.create(null)` + blocked-key deny; prefer `Object.hasOwn` over truthiness (existing good pattern, settings/route.js:99-101).
3. Keep weighted read path exception-free (precedent: `pickSmoothWeighted` try/catch → `{id:null}`, weightedRoundRobin.js:12-51; `getHeadroom` fail-open headroom 1, quotaSnapshot.js:261-295).
4. Migrate-or-delete `comboStrategies` entries on combo rename/delete server-side — client cleanup is best-effort only.
5. No secrets in weights/strategies; nothing added to GET responses beyond existing settings blob.

## Trade-off Recommendations

- Static key-count/charset caps over combo-membership validation: membership changes independently of settings writes; read-time ignore covers drift. Cheaper, no cross-table transaction.
- Fail-closed write + fail-open read (chosen above): a 400 protects the DB; ignoring junk at request time protects availability from legacy/out-of-band edits. Slight duplication is intentional.
- Rename migration in combos PUT vs lazy cleanup: do it eagerly in PUT (one `getSettings`+`updateSettings` pair, atomic-ish like settingsRepo.js:101-110) — lazy leaves poller running on ghost names (W3).
- Cap weight at 1000 (not ∞): smooth-WRR accumulates `current += weight` per request (weightedRoundRobin.js:33) — unbounded weights risk float-precision starvation of small weights; UI slider 0–10 with free numeric entry to 1000 is plenty.

## Open Questions

1. Should weights exceeding cap clamp (UX-friendly) or 400 (fail-fast)? Brief says 400 — confirm clamp-vs-reject for UI numeric input.
2. Media combos (`media-providers/combo/[id]/page.js:97,180-186` round-robin toggle only): if excluded from weighted, must PATCH reject `weighted` for `kind:"media"` combos or just hide UI? Needs a decision before validator scoping.
3. Should `comboStrategies` entries for deleted combos be garbage-collected on settings read as backstop (in addition to PUT-time delete)?
