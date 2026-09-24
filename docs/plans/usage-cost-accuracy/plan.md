# Usage and cost accuracy: YAN-72, YAN-257, YAN-252, YAN-66, YAN-65

GitHub: #95 (YAN-72), #99 (YAN-257), #94 (YAN-252), #96 (YAN-66), #97 (YAN-65).

## Research

- **YAN-72**: `open-sse/utils/stream.js` passthrough sets `usage = estimated` (chars/4 plus
  a 2000-token buffer) on a finish chunk that has no usage. With
  `stream_options.include_usage`, the real usage chunk comes after the finish chunk.
  `mergeUsage` keeps the larger value for each field, so the estimate is what gets saved.
  Translate mode has the same assignment (`state.usage = estimated`). `finalizeStream`
  already estimates when no real usage ever arrives, so neither assignment is needed.
  `mergeUsage` has to keep its max semantics, because the Claude `message_start` and
  `message_delta` usage is split across events.
- **YAN-257** (found while probing): `translator/response/claude-to-openai.js` stores
  `state.usage` with `prompt_tokens` already folded (input + cache_read + cache_creation)
  and still carries `cache_read_input_tokens` / `cache_creation_input_tokens`.
  `canonicalizeUsage` sees Claude cache keys without `cached_tokens` and folds them a
  second time. Probe: 100 + 200 + 30 is stored as 560 instead of 330.
- **YAN-252**: `convertResponsesStreamToJson` keeps only `input_tokens`, `output_tokens`
  and `total_tokens` from `response.completed`. `handleForcedSSEToJson` reads cache only
  from the Claude-shaped `cache_read_input_tokens` / `cached_tokens`.
  `canonicalizeUsage` never reads `input_tokens_details.cached_tokens`. In OpenAI
  Responses usage, `input_tokens` already **includes** `input_tokens_details.cached_tokens`.
  Claude-shaped `cache_read_input_tokens` is **excluded** from `input_tokens`.
- **YAN-66**: `calculateCostFromTokens` bills `completion * output + reasoning * reasoning`.
  OpenAI Chat/Responses `completion_tokens` / `output_tokens` already include reasoning.
  Gemini `candidatesTokenCount` does not, but the streaming translator (`toOpenAIUsage`)
  already stores `candidates + thoughts`. The raw Gemini extractors
  (`extractUsage`, `extractUsageFromResponse`) and the Gemini non-stream client body
  (`nonStreamingHandler.js`, which adds thoughts to **prompt**) are the ones that are
  inconsistent. Reasoning counts are also dropped on translator-built usage
  (`completion_tokens_details.reasoning_tokens` is not read by `canonicalizeUsage`) and on
  Responses usage.
- **YAN-65**: `pricingRepo.getPricingForModel` returns the raw user override. A partial
  override (`{input: 5}`) leaves `output` undefined, so the cost is NaN, stored as 0.
  `getPricing` (display) already merges `{...defaults, ...user}`.

## Design

One convention for stored usage: `completion_tokens` **includes** `reasoning_tokens`, and
`prompt_tokens` **includes** `cached_tokens` and `cache_creation_input_tokens`.

1. Stream usage (YAN-72): estimates go only onto the client-facing finish chunk and never
   into `usage` / `state.usage`. `finalizeStream` stays the single place that falls back
   to an estimate for persistence. In translate mode, a finish chunk takes the buffered
   real `state.usage` when it is valid and the estimate only when it is not.
2. Claude→OpenAI state (YAN-257): also set `cached_tokens` (the canonical marker) on the
   folded `state.usage`, so `canonicalizeUsage` passes it through without folding again.
3. Forced Responses SSE→JSON (YAN-252): the converter keeps the whole upstream `usage`
   object. The handler treats `input_tokens_details.cached_tokens` as already included in
   `input_tokens` (reported as cached, not added), and Claude-shaped cache fields as
   excluded (folded, as today). `canonicalizeUsage` falls back to
   `input_tokens_details.cached_tokens`.
4. Reasoning (YAN-66): `calculateCostFromTokens` bills `max(0, completion - reasoning)` at
   the output rate plus reasoning at the reasoning rate. The Gemini extractors store
   `completion = candidates + thoughts`. The Gemini non-stream client body moves thoughts
   from prompt to completion. `canonicalizeUsage` falls back to nested
   `completion_tokens_details` / `output_tokens_details` reasoning. Responses extractors
   keep `output_tokens_details.reasoning_tokens`.
5. Pricing (YAN-65): `getPricingForModel` returns `{...defaults, ...user}`, or the user
   entry alone when there is no default. `calculateCostFromTokens` treats a missing
   `input` / `output` rate as 0 instead of producing NaN.

## Tasks

| #   | Task                          | Files                                                                                                                                                                                                                                          | Depends |
| --- | ----------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------- |
| A   | Stream usage + Claude state   | `utils/stream.js`, `translator/response/claude-to-openai.js`, new `tests/unit/stream-usage-accuracy.test.js`                                                                                                                                   | none    |
| B   | Forced Responses SSE→JSON     | `transformer/streamToJsonConverter.js`, `handlers/chatCore/sseToJsonHandler.js`, `tests/unit/nonstream-client-format.test.js`                                                                                                                  | C (1)   |
| C   | Reasoning, canonical, pricing | `providers/pricing.js`, `src/lib/db/repos/pricingRepo.js`, `utils/usageTracking.js`, `chatCore/requestDetail.js`, `chatCore/nonStreamingHandler.js`, `translator/response/openai-responses.js`, new `tests/unit/pricing-cost-accuracy.test.js` | none    |

(1) B relies on C's `canonicalizeUsage` fallback for the DB value only. The files do not
overlap, so A, B and C run in parallel.

## Tests (critical only)

- Passthrough: a finish chunk followed by a real usage chunk stores the real usage. A
  stream with no usage still falls back to an estimate.
- Claude→OpenAI stream with cache: `canonicalizeUsage(onStreamComplete usage)` gives
  prompt 330, not 560.
- Forced Responses SSE→JSON with `input_tokens_details.cached_tokens`: a Claude client gets
  `cache_read_input_tokens`, and a Responses client keeps `input_tokens_details`.
- `calculateCostFromTokens({completion_tokens: 1e6, reasoning_tokens: 8e5}, {input: 1, output: 10})`
  gives 10. A partial user override resolves merged with the defaults.
- Update `antigravity-nonstream-usage-3260.test.js` for inclusive Gemini completion.

## Validation

`npm run lint`, `npm test` (vitest plus the known-fails gate), `npm run build`.
