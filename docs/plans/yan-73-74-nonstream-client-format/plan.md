# YAN-73 + YAN-74: non-streaming responses returned in the client's format

GitHub: #91 (YAN-73), #92 (YAN-74).

## Research

- `translateNonStreamingResponse(body, providerFormat, clientFormat, customToolNames)`
  (`open-sse/handlers/chatCore/nonStreamingHandler.js`) converts back to the client
  format only when the upstream is `openai`. The Gemini-family, Claude and Ollama
  branches build an OpenAI `chat.completion` and return it whatever the client format,
  so `/v1/messages` and `/v1/responses` clients with `stream:false` get `choices[]`.
- `handleForcedSSEToJson` (`sseToJsonHandler.js`, used when a `forceStream` provider
  serves a `stream:false` client) converts only for Responses clients (and, on the
  Responses-upstream branch, Gemini clients). Claude clients get `chat.completion`.
- Converters `openAICompletionToClaudeMessage` / `openAICompletionToResponses` exist in
  `nonStreamingHandler.js` but are private. `sseToJsonHandler.js` keeps an inlined copy
  of the Responses one (`chatCompletionToResponses`) because `nonStreamingHandler.js`
  imports `parseSSEToOpenAIResponse` from it (import cycle).
- `openAICompletionToClaudeMessage` drops cache counters. The streaming converter
  (`translator/response/openai-to-claude.js`) maps
  `input_tokens = prompt_tokens - cached - cache_creation` plus
  `cache_read_input_tokens` / `cache_creation_input_tokens`.
- Downstream of the translation, `handleNonStreamingResponse` already skips
  chat-specific post-processing for Claude (`type:"message"`) and Responses
  (`object:"response"`) bodies, and `filterUsageForFormat(usage, clientFormat)` keeps the
  Claude / Responses usage keys these converters emit.
- Gemini-family clients always take the streaming path (`clientRequestedStreaming`),
  so no Gemini JSON converter is needed.

## Design

1. New module `open-sse/handlers/chatCore/completionToClient.js` (no handler imports,
   so no cycle). It holds `openAICompletionToClaudeMessage` and
   `openAICompletionToResponses`, moved as-is, and exports
   `openAICompletionToClientFormat(body, clientFormat, customToolNames)`:
   Claude → Claude message, Responses → Responses body, anything else → unchanged.
   - Claude usage maps OpenAI cache details the way the streaming converter does.
   - Responses `status` is `completed`, or `incomplete` with
     `incomplete_details.reason = "max_output_tokens"` when `finish_reason` is `length`
     (the old copy returned the invalid status `"length"`).
2. `translateNonStreamingResponse`: same-format passthrough stays. Otherwise the body is
   normalised to `chat.completion` (existing branches, unchanged), then
   `openAICompletionToClientFormat(...)`.
3. `handleForcedSSEToJson`: delete the inlined `chatCompletionToResponses` and
   `extractCustomToolInput` copies. Pass both the Chat-SSE `parsed` body and the
   Responses-upstream `chat.completion` through `openAICompletionToClientFormat`.
   The Responses-client early return and the Gemini-client branch stay.

## Tasks

| #   | Task                           | Files                                              | Depends      |
| --- | ------------------------------ | -------------------------------------------------- | ------------ |
| 1   | Shared converter module        | `completionToClient.js` (new)                      | none         |
| 2   | Wire the non-stream translator | `nonStreamingHandler.js`                           | 1            |
| 3   | Wire forced SSE→JSON           | `sseToJsonHandler.js`                              | 1            |
| 4   | Regression tests               | `tests/unit/nonstream-client-format.test.js` (new) | 1 (API only) |

Tasks 2, 3 and 4 run in parallel after task 1.

## Tests (critical only)

- `translateNonStreamingResponse(claudeToolUse, CLAUDE, OPENAI_RESPONSES)` returns a Responses body with a `function_call`.
- `translateNonStreamingResponse(geminiFunctionCall, GEMINI, CLAUDE)` returns a Claude message with a `tool_use` block.
- `handleForcedSSEToJson`, Chat SSE upstream, Claude client: Claude message.
- `handleForcedSSEToJson`, Responses upstream, Claude client: Claude message with cache usage.

## Validation

`npm run lint`, then `cd tests && npx vitest run --reporter=json --outputFile=results.json && node __baseline__/verify-no-regression.mjs results.json`.
