# YAN-205 — Cursor AgentService IDE exec requests abort the turn

Linear: YAN-205 · GitHub: #32 · Branch: `fix/yan-205-cursor-exec-reject`

## Research summary

Source of truth: reverse-engineered `agent.proto` (enderzcx/cursor-agent2api, pinned from
can1357/oh-my-pi, 2026-09-19); cross-checked with cursed-gateway, pi-cursor, cursor-tap.
Full notes: scratchpad `research-proto.md`.

- ExecServerMessage envelope: `1 id` (varint), `15 exec_id` (string), `19 span_context`
  (message), `55 accept_hook_additional_contexts` (bool varint, outside the oneof).
  ExecClientMessage echoes only `1` and `15`.
- Prod (72h): only grep (5) and read (7) are logged as rejected; those turns end with
  11–16 output tokens → our rejection payload is wrong (grep gets `GrepError{error:""}`).
- Result `rejected` field differs per variant; many results only have `error` (2).
  Args→result field numbers are equal for 2–44, 53–54; **45–51 → 46–52, 52 → 55**.
- Since 2026-09-21 Grok models send **`36 mcp_state_exec_args {server_identifiers, kick_only}`**
  and expect `McpStateExecResult.success{servers:[McpStateServer{server_name,
server_identifier, tools, instructions}]}` (pi-extensions#48). 36 > 19 → today's picker
  selects 19 → null → "unsupported IDE tool". This is the most likely prod trigger.
- No proto flag disables built-in tools. Only instruction channels exist
  (`McpStateServer.instructions`, RequestContext rules / cloud_rule / mcp_instructions,
  or the user text where system text is already folded).
- Error retryability: stream → 200 + SSE error; non-stream → 400 request-scoped. No account
  cooldown/fallback. OpenCode's retry is client-side. After the fix the fatal path remains
  only for a malformed exec frame with no variant; give it a stable code.

## Design

New module `open-sse/utils/cursorAgentExec.js` (moves exec helpers out of the 910-line
executor):

- `EXEC_ENVELOPE_FIELDS = {1,15,19,55}`; `execVariant(execRequest)` → first LEN-typed field
  not in the envelope set, else `null`.
- `EXEC_REJECTIONS` table: `argsField → {name, resultField, caseField, messageField}`
  (proto-exact, incl. 45–52 off-by-one and precheck variants 41–43 → empty result).
- `buildExecReply(execRequest, {tools})` → `{frame, variant, kind}` or `null`:
  - `request_context` (10) → existing empty ack (unchanged behaviour).
  - `mcp_state` (36) → success with one server per requested identifier; `9router` gets
    the declared tools + environment instructions.
  - `rejected` (table) → typed rejection/error with the reason string.
  - `generic` (unknown) → `result{2 error:{1 reason}}` on the same field number.
  - `null` → no variant field (malformed).
- `buildMcpMissingNameReply(execRequest)` → `McpResult.error` for MCP exec without a name.
- `AGENT_ENVIRONMENT_NOTE` constant (not an IDE; only the provided tools).

`cursor.js` wiring:

- MCP (11) with name → tool_call (unchanged); without name → reply + `log.warn`, continue.
- Else `buildExecReply`: log info for known kinds (keep `rejected IDE exec` wording, add
  `variant=`), `log.warn` naming the variant for `generic`; `null` → `log.warn` + fatal error
  with `code: cursor_unsupported_exec`.
- `buildAgentRunFrame` prepends `AGENT_ENVIRONMENT_NOTE` to the folded system text.
- `CURSOR_MCP_PROVIDER` exported from `cursorProtobuf.js` (replaces the hard-coded
  `"9router"`); `concatArrays` exported and reused instead of the duplicate `concatBuffers`.

## Tasks

1. (impl) `cursorAgentExec.js` + `cursorProtobuf.js` exports.
2. (impl) `cursor.js` wiring + environment note.
3. (tests, parallel with 1–2 against this spec) extend `tests/unit/cursor-agent-exec-request.test.js`:
   frame helper with envelope fields `1,15,19,55`; variants 20, 23, 36, 17, 24 (unknown) in
   stream + non-stream; decoded rejection payload for grep/read/shell; mcp_state success
   carries tools; MCP-no-name continues; warn log names the variant; run frame contains note.
4. Validate: targeted tests, full vitest vs baseline, `npm run lint`, `npm run build`.

## Out of scope (follow-up)

- Redirecting native tool calls (read/grep/shell) onto the client's equivalent tools
  (pi-cursor `nativeToolsMode: "redirect"`) — Grok 4.7 prefers native tools.
- `x-cursor-client-type: cli`, `stream_close` control messages.
