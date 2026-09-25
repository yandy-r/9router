# YAN-384: Skip exhausted combo accounts

## Research

Sources: [external](research-external.md), [security](research-security.md), [UX](research-ux.md), [practices](research-practices.md), and codebase discovery in `docs/prps/plans/.prp-research/combo-zero-quota-skip/`.

## Root cause

`getProviderCredentials` filters locks and Antigravity cache, not quota snapshots. All combo strategies, including fusion, reach that selector; weighted combo headroom only changes pick order and leaves exhausted members in fallback tail. The snapshot poller only runs for weighted routing. Existing quota sync recognizes a small provider subset, so some visible 0% usage rows never become routing snapshots.

## Requirements

- Skip a connection with a live, applicable, known 0%-remaining snapshot, under every account and combo strategy. Never send a known-zero connection upstream, even when every member is exhausted.
- Unknown/malformed/stale/provider-mismatched snapshot stays eligible. Match model windows only to their own models. A healthy alternate account stays eligible.
- Re-admit after reset or bounded re-probe. Short request/token windows must not be treated as plan-wide exhaustion. Preserve model locks, Antigravity cache, and weighted near-floor/manual-weight semantics.
- Poll eligible direct providers in all combos; preserve `isWeightedProvider` semantics and avoid a timer when no eligible combo exists. Do not leak secrets or add dependencies.
- Preserve current 503 `allRateLimited` response contract; switching to 429 is a separate API change.

## Scope limits

No UI changes, no new quota cache, no executor rewrites, no unrequested dependency. A provider with no trustworthy quota telemetry remains fail-open. Existing upstream 429/403 locks remain authoritative as a fallback.
