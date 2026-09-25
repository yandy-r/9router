# Translator request bugs — YAN-31, YAN-32, YAN-34, YAN-35

## Summary

Fix four confirmed translator regressions in one focused PR to `master`. GitHub #165–#168. Scope: Gemini/Antigravity duplicate tool ids and dropped parallel results; Kiro array tool content; Claude string image URL and `tool_choice: "none"`.

## Metadata

- Complexity: Medium (4 translator request modules, shared helper, focused tests)
- Source: Linear YAN-31, YAN-32, YAN-34, YAN-35; GitHub #165–#168
- Base: `origin/master`, branch `fix/translator-request-bugs`, one worktree `.claude/worktrees/9router-translator-request-bugs`

## Mandatory Reading

- `CLAUDE.md`, `open-sse/AGENTS.md`, `docs/ARCHITECTURE.md`
- `open-sse/translator/request/gemini-to-openai.js`, `antigravity-to-openai.js`, `openai-to-kiro.js`, `openai-to-claude.js`
- `open-sse/translator/concerns/toolCall.js`
- `tests/translator/bugs-antigravity.test.js`, `tests/unit/openai-to-claude.test.js`, `tests/translator/bugs-toClaude-context.test.js`
- Research: `docs/prps/plans/.prp-research/translator-request-bugs/{gemini-research,kiro-claude-research}.md`

## Research & Design

- `gemini-to-openai.js` returns first `functionResponse` and caller pushes one converted item; Antigravity collects results and spreads arrays already.
- Both generate fallback `call_${name}`; same-name parallel calls collide. Shared request-scoped FIFO by name is needed. Generated ids must be deterministic, Claude-safe, unique per call; explicit ids must retain pairing. Existing positional helper `generateToolCallId` handles deterministic formatting but no pairing.
- `openai-to-kiro.js` already joins array text into local `content`; tool branch ignores it.
- `openai-to-claude.js` dereferences `part.image_url.url` without checking string form; elsewhere inline string/object ternary is common. `"none"` mapping to auto contradicts Claude accepted types.
- No new deps; no UI/DB changes. Do not alter unrelated translator bugs.
- Security: preserve client `tool_choice: none` restriction. Invalid image input must not crash; don't silently synthesize an image from malformed URL.

## Batches

| Batch | Tasks                                                  | Depends on |
| ----- | ------------------------------------------------------ | ---------- |
| B1    | T1 shared id helper; T2 Kiro + test; T3 Claude + tests | none       |
| B2    | T4 Gemini + Antigravity + tests                        | T1         |
| B3    | T5 validate, review, PR, CI, merge, cleanup            | B1–B2      |

## Step-by-Step Tasks

### T1 — Shared per-request tool-id assigner (B1)

- ACTION: Add tiny request-scoped FIFO id pairing in `open-sse/translator/concerns/toolCall.js` for Gemini/Antigravity. Explicit ids pass through. Missing ids use unique stable positional ids; queue by name, response consumes FIFO, orphan fallback deterministic. Avoid collisions between explicit and generated ids. Add focused check in T4.
- MIRROR: `generateToolCallId` in same file, `openai-to-gemini.js` explicit-id mapping.
- VALIDATE: `node --check open-sse/translator/concerns/toolCall.js`.

### T2 — Kiro tool content (B1)

- ACTION: Use already-flattened `content` for `role:tool`; add one regression test with array text parts and structured tool result.
- MIRROR: `tests/unit/openai-to-kiro.test.js`.
- VALIDATE: `cd tests && npx vitest run unit/openai-to-kiro.test.js`.

### T3 — Claude image and tool choice (B1)

- ACTION: Normalize `image_url` string/object and guard non-string before `startsWith`. Map `"none"` to `{type:"none"}`. Update old incorrect unit expectation, turn `it.fails` into regular test; add string-image regression test.
- MIRROR: `openai-to-ollama.js` URL normalization, `tests/unit/openai-to-claude.test.js`.
- VALIDATE: `cd tests && npx vitest run unit/openai-to-claude.test.js translator/bugs-toClaude-context.test.js` (compare known failures).

### T4 — Gemini and Antigravity response preservation (B2)

- ACTION: Instantiate helper per request; pass to converters; spread array results in Gemini request; collect all `functionResponse` parts into tool messages, preserving any co-located assistant text/calls. Antigravity uses helper for fallback IDs. Add tests for duplicate same-name calls and parallel results, explicit ids, both formats.
- MIRROR: `antigravity-to-openai.js` mixed-part array return and `tests/translator/bugs-antigravity.test.js`.
- VALIDATE: `cd tests && npx vitest run translator/bugs-antigravity.test.js translator/bugs-gemini-cursor-commandcode.test.js`.

### T5 — Full verification and delivery (B3)

- ACTION: Run lint, `npm test` baseline gate, `npm run build`; inspect diff; independent code review, fix findings, commit, open PR explicitly with `--base master`, review PR, monitor CI, squash merge, delete remote/local branch/worktree, mark Linear issues Done.
- VALIDATE: `git diff --check`; CI checks all green; merged PR base `master`.

## Testing Strategy

Critical focused regressions: parallel same-name IDs paired to corresponding results for Gemini and Antigravity; mixed/multiple results; Kiro array text; Claude string image and none tool choice. Existing known-fails gate is authoritative for full suite. No live upstream calls or credentials required.

## Acceptance Criteria

- All four behavior changes verified with focused tests.
- `npm run lint`, `npm test` (baseline), `npm run build` pass or failures identified as pre-existing.
- PR closes #165–#168, base `master`, complete review + fixes, CI green, squash merged.
- Linear YAN-31/32/34/35 Done; branch and worktree removed.

## Risks

- Missing Gemini ids require FIFO pairing by function name. Explicit ids may coexist with missing ids; use a queue per name and reserve explicit ids to avoid collisions.
- `tests/translator/bugs-toClaude-context.test.js` has `it.fails` for `none`; unmark with fix or suite will regress.
- Worktree starts from `origin/master`, not active `re-design`.
