# YAN-259 parallel plan: per-connection quota snapshot service + plan-tier detection

Research: `research-*.md`, `feature-spec.md`. Phase 1 of YAN-258 (GitHub #102/#103). Creates the shared quota/weight data layer only. No routing behavior changes: `weighted` does not exist yet (YAN-260/YAN-261 follow-ups), and the poller idles until a combo needs it.

## Design

- **Store** `open-sse/services/quotaSnapshot.js` — bounded `Map<connectionId, Snapshot>`, all normalization in one place. Snapshot: `{ provider, windows: [{ kind, usedFraction, resetsAt|0, observedAt, source }], planTier, updatedAt }`. Windows expire at `resetsAt` (or `ttlMs` without reset); empty snapshots dropped on read. `sanitizedWindowKind` allowlists `5h/7d/day/month/requests/tokens/input-tokens/output-tokens/model:<id>` (lowercased, ≤128 chars, `model:` prefix-special-cased because model ids contain dots/spaces that the identifier regex rejects). `sanitizePlanTier` lowercases/trims, rejects `__proto__`, caps 64 chars. All finite-check + clamp, never throws.
- **Parsers** `open-sse/services/quotaHeaders.js` — pure `parseQuotaHeaders(provider, headers, nowMs)`, header-map pickers by family: Claude unified (`5h/7d/<claim>`, 0–1, epoch seconds; `claim===status|reset` excluded by suffix regex; `-representative-claim` and bare `...unified-status/reset` never become windows); Codex `x-codex-{primary,secondary}-{used-percent,window-minutes,reset-at}` + generic `x-<id>-{primary,secondary}-*` families with `x-<id>-limit-name` (normalized: lowercase, `-`→`_`); generic `x-ratelimit-{remaining}-{requests,tokens}` / Anthropic API `anthropic-ratelimit-{remaining}-{requests,tokens,input-tokens,output-tokens}` (RFC-3339 or duration reset via `parseResetTime`). Codex classification by `window-minutes` (`≤300→5h`, `≥6000→7d`, else `day`); probe mapping uses the same cutoffs on `limit_window_seconds`. API-key families map to `requests`/`tokens` window kinds. Defensive on plain-object doubles (`Headers.get` is case-insensitive; parsers lowercase keys first). Fail-open `ingestResponseHeaders(provider, connectionId, headers)` — no connectionId or no parse = skip silently.
- **Config** `open-sse/config/quotaSnapshot.js` — `QUOTA_SNAPSHOT` tunables (floor/threshold names documented for phase 2), `PLAN_CAPACITY` table with `_verified`/`_verify` provenance comments (Codex `prolite`/`pro` and Antigravity `g1-ultra-*` unverified), and `QUOTA_HEADER_FAMILIES` doc-map keyed to parser functions.
- **Usage/probe** — Usage handlers keep display shape; the snapshot mapper reads their stable fields with a documented adapter (`kindForName`): Claude `session (5h)→5h`, `weekly…(7d)→7d` (+`limits[]` weekly_scoped percent→model window, model-scoped key check first); Codex `session/weekly` with generics for `review_*/spark_*`; Google/Antigravity buckets→`model:<id>` (`_verify` weekly overlay); GitHub chat/completions/premium_interactions (+percent_remaining preferred); Kiro resourceType→`model:<id>`; groq `buildGroqQuotaWindows(headers)` (moved groq parser + Go-duration `_parseGoDurationMs`/full-consumption guard from `groq.js`). `usage/shared.js` gains only `parseDurationToMs`. Claude `fetchClaudePlanTier` (profile ≥24h TTL, 403→null, ≤64-char) exposes `getClaudeProfileUrl` from registry `usage.profileUrl`.
- **Sync/app side** `src/sse/services/quotaSnapshotSync.js` — app-only (DB + `updateProviderConnection`): `recordUsageSnapshot({connectionId, provider, usage, source})`, debounced tier persist (`updateProviderConnection` only on change), `fetchAndPersistClaudePlanTier` wrapper, `getSnapshot` re-export, `buildQuotaSnapshotView` (windows + decomposed `effectiveWeight`, API shape owned here).
- **Poller** `src/shared/services/quotaSnapshotPoller.js` — DI-shaped like `quotaAutoPing` (`{runQuotaSnapshotTick(deps,state)}` + `start/stop/configure`): ticks 60s, reads DB directly, targets weighted-provider connections or missing/stale snapshots, calls `getUsageForProvider(force:false)`, failures cached `failureCooldownMs`, never refreshes credentials or sends chat pings.
- **Antigravity** `src/sse/services/antigravityQuota.js` — `quotaCache` Map stays (tests), but all writes go through the snapshot store (`_toSnapshotOpts` adapter: remainingPercentage→usedFraction, `remainingPercentage>=100`→unknown, strike syntheses write as probe `model:` windows); strike state untouched. `handleAntigravityQuotaError` third arg normalized (`model ?? null`) so refresh-only paths don't write `model:undefined` windows. Tests get a few lines of adapter/comment nits only (e.g. a test that used `undefined` model now asserts a keyed `model:undefined` snapshot entry).
- **Hook** `open-sse/handlers/chatCore.js` — one `ingestResponseHeaders(provider, connectionId, providerResponse.headers)` inside try/catch before the `!ok` guard, so 429 bodies ingested too. No executor edits.

## Tasks (file ownership, no overlap)

### Batch 1 (all parallel)

- **T1 config+store+weight.** Create `open-sse/config/quotaSnapshot.js`, `open-sse/services/quotaSnapshot.js`.
- **T2 header parsers.** Create `open-sse/services/quotaHeaders.js`.
- **T3 usage/OAuth tweaks.** Modify `open-sse/services/usage/groq.js` (move parser; handler delegates), `usage/shared.js` (+`parseDurationToMs` only), `usage/claude.js` (+`fetchClaudePlanTier`; `_fetchClaudeUsageRaw` untouched), `usage/codex.js` (+`windowMinutes` only), `providers/registry/claude.js` (+`usage.profileUrl` display-safe), `src/lib/oauth/providers/{antigravity,gemini-cli}.js` (persist `planTier` in `mapTokens` extra only; provider `mapTokens` stays `(tokens, extra)`).

### Batch 2 (after Batch 1; all parallel)

- **T4 core tests.** Create `tests/unit/quota-snapshot.test.js` (store/weight/parsers/planTier sanitizers).
- **T5 hook + antigravity fold.** Modify `open-sse/handlers/chatCore.js` (one call), `src/sse/services/antigravityQuota.js`, `tests/unit/antigravity-quota-routing.test.js` (nits only).
- **T6 sync + poller + route + init.** Create `src/sse/services/quotaSnapshotSync.js`, `src/shared/services/quotaSnapshotPoller.js`; modify `src/app/api/usage/[connectionId]/route.js` (additive `quotaSnapshot`), `src/shared/services/initializeApp.js`, `src/app/api/settings/route.js`.
- **T7 sync/poller tests.** Create `tests/unit/quota-snapshot-poller.test.js` (DI fakes; no module mocking of the store — real store + cleanup).

### Batch 3: verification (orchestrator)

- `npx vitest run unit/quota-snapshot.test.js unit/quota-snapshot-poller.test.js unit/antigravity-quota-routing.test.js unit/antigravity-weekly-quota.test.js unit/quota-auto-ping.test.js`
- full suite (`npx vitest run --reporter=json --outputFile=results.json`) + `node __baseline__/verify-no-regression.mjs results.json`
- `npm run lint`, `npm run build`

## File ownership (T4–T7 authors hold)

- T1: config + store; T2: header parsers; T3: usage/oauth files; T4: core tests; T5 hook folding must stay ≤ 20 lines net in `chatCore.js`/`antigravityQuota.js` outside the adapter; T6/T7 own sync/poller/route/tests.
- `feature-spec.md` changes live with the implementor touching the spec'd behavior (T1 owns weight semantics, T2 owns header classification, T6 owns API shape), approved by the orchestrator.
- Every task: additive only; no existing behavior changes unless the task says so.

## Phase 1 additions (shared primitives for phases 2 and 3)

- **Smooth weighted round-robin** `open-sse/services/weightedRoundRobin.js`: one pure function, `pickSmoothWeighted(candidates, currentWeights)` (nginx smooth WRR). It never mutates its input, prunes stale ids, and returns `{ id: null }` when no candidate is eligible. Stickiness, floor policy and state storage stay with the callers. YAN-260 (accounts) and YAN-261 (combos) both import it. Test: `tests/unit/weighted-round-robin.test.js`.
- **`getProviderHeadroom(provider, connectionIds, model)`** in `open-sse/services/quotaSnapshot.js`: the best headroom across a provider's connections. A connection with no snapshot counts as headroom 1 (static), and a mismatched provider is skipped. YAN-261 calls this instead of reading the store directly.

## Out of scope (follow-ups)

- YAN-260 (account-level `weighted` + SWRR + UI), YAN-261 (combo-level `weighted` + `getWeightedModels` + UI).
- Pace/forecast, aggregate `/api/usage/snapshots`, capacity-table version hash, manual-weight UI, `weighted` validation in `/api/settings`.
- Poller targeting/staleness keyed off combos (`getCombos`); poller fires `getUsageForProvider` per connection (no fan-in).
