# YAN-16 parallel plan: keep function-tool `strict` on Responses upstreams

Research: `research.md`. The design below was validated in a scratch copy: the new test goes from 13/19 failing to 19/19 passing, the full suite has no regressions, and eslint is clean.

## Design

- **Chat→Responses translator:** an absent or non-boolean `function.strict` becomes `strict: false`, because Chat semantics are non-strict and Responses treats an absent `strict` as strict. A boolean is preserved.
- **Responses executors** (codex, opencode, opencode-go, grok-cli): capture a boolean `strict` (flat `tool.strict` wins over `tool.function.strict`) **before** the wipe-and-rebuild loop, and restore it afterwards. If it was absent, it stays absent: native Responses clients chose the Responses default, and semantics belong in the translator. No default is added in the executors.
- **Responses→Chat direction** is unchanged; Chat already treats absent as non-strict.
- **DRY:** one shared reader, `readFunctionToolStrict(tool)`, in `open-sse/translator/formats/responsesApi.js`, a module that the translator and all 4 executors already import. Merging the 4 normalizers is out of scope because they differ on hosted/namespace/custom tools, pattern stripping and name limits.
- **Upstream acceptance** (verified externally): Codex (codex-rs always sends `strict:false`), OpenCode Zen, Copilot, Zed and Perplexity accept `strict`; for Perplexity, omitting it can even 400. xAI treats tools as always strict, so `strict:false` is ignored, not rejected. No upstream is flagged as risky.

## Tasks (file ownership, no overlap)

### Batch 1 (all parallel; the helper name and signature are fixed by this plan)

- **T1: helper + translator.** Files: `open-sse/translator/formats/responsesApi.js`, `open-sse/translator/request/openai-responses.js`.
  - Add the exported `readFunctionToolStrict(tool)` with JSDoc after `coerceResponsesArguments`.
  - In the translator, import it and change L440 to `strict: readFunctionToolStrict(tool) ?? false`, with a one-line "why" comment.
- **T2: executors.** Files: `open-sse/executors/codex.js`, `opencode.js`, `opencode-go.js`, `grok-cli.js`.
  - Import `readFunctionToolStrict`.
  - Add `const strict = readFunctionToolStrict(tool);` before `for (const k of Object.keys(tool)) delete tool[k];`.
  - Add `if (strict !== undefined) tool.strict = strict;` after `tool.parameters = …`.
- **T3: regression test.** File: `tests/unit/responses-tool-strict.test.js`. Covers:
  - translator: absent→false, false kept, true kept
  - each of the 4 executors: flat false, nested false and flat true are kept; absent stays absent

### Batch 2: verification (orchestrator)

- `npx vitest run unit/responses-tool-strict.test.js`, plus the related unit files
- the full suite followed by `verify-no-regression.mjs`
- `npx eslint` on the touched files
- `npm run build`
- delete the stray `golden-url-header` snapshot

## Out of scope (follow-up tickets)

- The Gemini `removeUnsupportedKeywords` cleaner deletes real parameters named `format`/`title`/`default`/…
- Claude→OpenAI drops a Claude tool's `strict:true`.
