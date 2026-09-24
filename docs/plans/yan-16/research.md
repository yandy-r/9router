# YAN-16 research: OpenCode v2 subagent `sessionID` filled with `ses_invalid` through 9router

## Root cause (confirmed)

In the Responses API, a function tool with no `strict` key **attempts strict mode**. Strict mode silently rewrites the schema: every property is moved into `required` and none is made nullable. The model is therefore forced to emit every optional field. OpenCode v2's `subagent` tool has the optional fields `model`, `sessionID` and `background`; the model fills them with `sessionID:"ses_invalid"` and `model:""`, and OpenCode fails with "Subagent session not found".

- OpenAI's migration guide: "In Chat Completions, functions are non-strict by default… In Responses, omitting `strict` attempts strict mode… To keep non-strict behavior in Responses explicitly, set `strict: false`."
- Other gateways have fixed the same bug: Open WebUI PR #30046 defaults `strict` to false when the source tool does not set it; copilot-relay #74 shows the A/B.
- OpenCode issues #43610, #43619 and #43297 report exactly this failure through `9router/cx/*`.

## What 9router does wrong (HEAD 6be007ae)

1. **Chat→Responses translator** `open-sse/translator/request/openai-responses.js:440`: `strict: tool.function.strict`. When a Chat client omits `strict` this is `undefined` and drops out on serialization, so the Responses default of strict applies. Chat semantics for an absent `strict` are non-strict, so the faithful translation is `false`.
2. **Executors that wipe and rebuild tools**, deleting `strict` even when the client sent `strict:false` explicitly. Each does `for (const k of Object.keys(tool)) delete tool[k]` and rebuilds only `{type,name,description?,parameters}`:
   - `open-sse/executors/codex.js` `normalizeCodexTools` (~L73-124, wipe L107). Namespace subtools keep theirs.
   - `open-sse/executors/opencode-go.js` `normalizeResponsesTools` (~L58-88, wipe L74)
   - `open-sse/executors/opencode.js` `normalizeResponsesTools` (~L371-399, wipe L385)
   - `open-sse/executors/grok-cli.js` `normalizeGrokCliTools` (~L243-320, wipe L300)
     These run even for same-format Responses passthrough (`base.js:138` transformRequest), so Codex CLI's own `strict:false` is lost too.
3. Paths that call the translator and send its output as-is (fixed by item 1 alone): github Copilot `/responses` (`github.js:167-172`), zed OpenAI models (`zed.js:75-85`), perplexity-agent, openai-compatible providers with `apiType:"responses"`.

## Client evidence (user's machine)

- OpenCode v2.0.14, with provider `@opencode/ai/providers/openai-compatible` (Chat Completions). It sends `function.strict:false` for 9router (`supportsStrictMode` defaults true). So in the user's case the translator keeps `strict:false`, and **the Codex executor deletes it**.
- 495 subagent calls with `call_`+24-char IDs (OpenAI/Codex) had every optional key filled. Claude and Kimi calls did not. `9router/cx/gpt-6-astra` failed while `openai/gpt-6-astra` direct worked.
- OpenCode v1 with `@ai-sdk/openai-compatible` omits `strict`, which is covered by fix item 1.

## Unaffected paths

Chat targets (the tools pass through), Claude (non-strict by default; `strict` dropped harmlessly), Gemini/Antigravity (VALIDATED mode, optional fields stay optional), Kiro, Cursor, Ollama, CommandCode. Token savers (RTK/headroom/caveman/pxpipe) never touch `tools`. No response translator injects placeholder arguments.

## Existing tests likely affected

- `tests/unit/codex-tool-normalization.test.js`: the natural place for the codex regression test
- `tests/unit/opencode-go-muse-spark-responses.test.js` (~98-137)
- `tests/unit/opencode-muse-spark-thinking.test.js:218` and `tests/unit/opencode-free-tool-choice.test.js:39,49,56,87` use exact `toEqual` on tools, so they may need `strict:false` added once the translator defaults it
- `tests/unit/grok-cli-executor.test.js:355` (objectContaining)
- `tests/unit/openai-responses-*.test.js`, `github-responses-routing.test.js`, `zed-completions-wire.test.js`

## Out of scope side findings (follow-up tickets)

- The Gemini cleaner `removeUnsupportedKeywords` (`formats/gemini.js:140-161`) walks into `properties` maps and deletes real **parameters** named `format`, `title`, `default`, etc. (OpenCode's `webfetch` has `format`).
- Kiro `cleanSchemaValue` drops a property literally named `additionalProperties`.
