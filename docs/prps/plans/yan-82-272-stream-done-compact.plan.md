# Plan: passthrough `[DONE]` dedupe + `/responses/compact` chat bodies

Linear: YAN-82, YAN-272 · GitHub: #186, #187

## Research summary

- **YAN-82** — `open-sse/utils/stream.js` passthrough branch forwards upstream
  `data: [DONE]` but never sets `streamDoneSent`; `flush()` appends a second one.
  Same for a `[DONE]` left in the trailing buffer.
- **YAN-272** — `src/sse/handlers/chat.js` forces `sourceFormat = openai-responses`
  for every `/v1/responses*` path (`detectFormatByEndpoint`). A chat-shaped body
  (`messages`, no `input`) to a Codex model therefore skips translation, and the
  Codex allowlist strips `messages` (upstream gets `input: "..."`). When
  translation does run (`openai → openai-responses`, or `claude → openai → openai-responses`)
  each translator builds a fresh body and drops `_compact`, so Codex routes to
  `/responses` instead of `/responses/compact`.

## Design

1. `stream.js` passthrough: detect `[DONE]` lines (`data:[DONE]` too); forward the
   first, set `streamDoneSent`, drop repeats. In `flush()`, mark a trailing
   `[DONE]` buffer as sent.
2. `translator/index.js` `translateRequest`:
   - request-side source is `openai` when `sourceFormat === openai-responses` and
     the body is chat-shaped (response translation keeps the endpoint format, so
     clients still get Responses events);
   - re-apply `_compact` from the original body after all hops.

## Tasks

| #   | File                                         | Change                                                                  |
| --- | -------------------------------------------- | ----------------------------------------------------------------------- |
| 1   | `open-sse/utils/stream.js`                   | `[DONE]` dedupe in passthrough transform + flush                        |
| 2   | `open-sse/translator/index.js`               | chat-shaped request source + `_compact` carry                           |
| 3   | `tests/unit/stream-passthrough-done.test.js` | one `[DONE]` across newline / no-space / trailing / absent              |
| 4   | `tests/unit/codex-compact-routing.test.js`   | chat + claude body via `translateRequest` → `/compact` URL with `input` |

## Validation

`npm run lint`, targeted vitest files, then `npm test` (touches gateway code).
