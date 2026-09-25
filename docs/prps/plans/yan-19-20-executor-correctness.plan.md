# YAN-19 / YAN-20 executor correctness

## Goal

Fix two high-priority stream/routing bugs on current master (`45cd15d6`). Linked GitHub issues: #121, #122. Linear issues: YAN-19, YAN-20.

## Research

- `open-sse/executors/base.js`: `buildUrl` runs before `transformRequest` per URL fallback; body reused across retries.
- `open-sse/executors/codex.js`: singleton `this._isCompact` set in `transformRequest` after URL chosen; `_compact` deleted on first iteration. Other `buildUrl` overrides ignore extra trailing args.
- `open-sse/executors/commandcode.js`: peek loop splits all complete lines but breaks after first content event. `createReplayedStream` joins buffered lines and trailing partial buffer with newline, so preserving remaining complete lines in `bufferedLines` keeps exact order.
- Existing tests: `tests/unit/codex-image-fetch.test.js`, `tests/unit/commandcode-executor.test.js`. Test runner: `tests/vitest.config.js`; regression gate: `tests/__baseline__/verify-no-regression.mjs`.

## Design

- YAN-19: Add optional request-body argument to `BaseExecutor.buildUrl` call, then have Codex `buildUrl` read `_compact` from that body. Remove singleton compact flag. Preserve routing on repeated calls by retaining `_compact` on original body until URL selection while ensuring it is not sent upstream (transform strips it). Avoid reordering base flow or storing per-request data on singleton.
- YAN-20: Preserve every unvisited complete NDJSON line after peek stops, before replaying; error case returns synthetic error response and cancels reader. Keep trailing partial buffer intact.
- Alternatives rejected: reorder `transformRequest` (retains singleton race), capture flag on `this` (concurrency race), prepend lines to partial buffer (newline hazard).
- No UX or persistence changes. Out of scope: other executor singleton-state issues and unrelated translator bugs.

## Plan

1. Implement YAN-19 in `open-sse/executors/base.js` and `open-sse/executors/codex.js`. Add critical request-sequence and retry regression checks in `tests/unit/codex-compact-routing.test.js` or existing test module.
2. Implement YAN-20 in `open-sse/executors/commandcode.js`; add one single-chunk regression test to `tests/unit/commandcode-executor.test.js` asserting text, finish and usage; check `[DONE]` and error handling.
3. Run focused tests; lint, full test regression gate and build because application code changed. Review full diff and PR, fix findings, monitor CI, squash merge, cleanup worktree and branches, close Linear issues.

## Risks

- `transformRequest` mutates and strips `_compact`; fallback/retry must retain routing. Preserve flag outside mutable body or transform a copy.
- Replay must not duplicate lines or reveal post-error frames; `[DONE]` path must preserve subsequent bytes in replay.

## Acceptance

- Compact request routes to `/compact` even as first request; ordinary request after it never does. Concurrent requests and retries route correctly; upstream body has no `_compact`.
- Single-chunk CommandCode response retains every content, finish, usage event.
- Focused tests, lint, regression gate, build and CI pass.
