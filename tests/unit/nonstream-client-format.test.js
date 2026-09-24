import { describe, expect, it, vi } from "vitest";

vi.mock("@/lib/usageDb.js", () => ({
  appendRequestLog: vi.fn(async () => {}),
  saveRequestDetail: vi.fn(async () => {}),
  saveRequestUsage: vi.fn(async () => {}),
}));

const { FORMATS } = await import("../../open-sse/translator/formats.js");
const { translateNonStreamingResponse } = await import(
  "../../open-sse/handlers/chatCore/nonStreamingHandler.js"
);
const { handleForcedSSEToJson } = await import(
  "../../open-sse/handlers/chatCore/sseToJsonHandler.js"
);

// Forced-SSE ctx: `raw` is the upstream SSE text.
const sseCtx = (raw, { sourceFormat, targetFormat, provider }) => {
  const encoder = new TextEncoder();
  return {
    providerResponse: new Response(
      new ReadableStream({
        start(controller) {
          controller.enqueue(encoder.encode(raw));
          controller.close();
        },
      }),
      { headers: { "content-type": "text/event-stream" } },
    ),
    sourceFormat,
    targetFormat,
    provider,
    model: "gpt-x",
    body: { model: "gpt-x", messages: [] },
    stream: false,
    requestStartTime: Date.now(),
    connectionId: "test-connection",
    clientRawRequest: { endpoint: "/v1/messages" },
    trackDone: vi.fn(),
    appendLog: vi.fn(),
  };
};

describe("non-stream responses in the client's format (YAN-73 / YAN-74)", () => {
  it("YAN-74: Claude upstream body → Responses body for a Responses client", () => {
    const claudeBody = {
      id: "msg_1",
      type: "message",
      role: "assistant",
      model: "claude-x",
      content: [
        { type: "text", text: "hi" },
        { type: "tool_use", id: "toolu_1", name: "read", input: { path: "a" } },
      ],
      stop_reason: "tool_use",
      usage: { input_tokens: 10, output_tokens: 5 },
    };
    const out = translateNonStreamingResponse(claudeBody, FORMATS.CLAUDE, FORMATS.OPENAI_RESPONSES);
    expect(out.object).toBe("response");
    expect(out).not.toHaveProperty("choices");
    const msg = out.output.find((o) => o.type === "message");
    expect(msg.content[0]).toMatchObject({ type: "output_text", text: "hi" });
    const fc = out.output.find((o) => o.type === "function_call");
    expect(fc).toMatchObject({ call_id: "toolu_1", name: "read" });
    expect(JSON.parse(fc.arguments)).toEqual({ path: "a" });
  });

  it("YAN-74: Gemini upstream body → Claude message for a Claude client", () => {
    const geminiBody = {
      candidates: [
        {
          content: {
            role: "model",
            parts: [{ text: "ok" }, { functionCall: { name: "grep", args: { q: "x" } } }],
          },
          finishReason: "STOP",
        },
      ],
      usageMetadata: { promptTokenCount: 7, candidatesTokenCount: 3, totalTokenCount: 10 },
    };
    const out = translateNonStreamingResponse(geminiBody, FORMATS.GEMINI, FORMATS.CLAUDE);
    expect(out).toMatchObject({ type: "message", role: "assistant", stop_reason: "tool_use" });
    expect(out).not.toHaveProperty("choices");
    expect(out.content).toContainEqual({ type: "text", text: "ok" });
    expect(out.content.find((b) => b.type === "tool_use")).toMatchObject({
      name: "grep",
      input: { q: "x" },
    });
    expect(out.usage).toEqual({ input_tokens: 7, output_tokens: 3 });
  });

  it("YAN-73: forced Chat SSE upstream → Claude message with cache usage", async () => {
    const chunk = (extra) =>
      `data: ${JSON.stringify({ id: "chatcmpl-sse", object: "chat.completion.chunk", created: 1700000000, model: "gpt-x", ...extra })}`;
    const raw = [
      chunk({ choices: [{ delta: { content: "Hello" }, finish_reason: null }] }),
      chunk({
        choices: [
          {
            delta: {
              tool_calls: [
                {
                  index: 0,
                  id: "call_1",
                  type: "function",
                  function: { name: "shell", arguments: '{"cmd":"ls"}' },
                },
              ],
            },
            finish_reason: null,
          },
        ],
      }),
      chunk({ choices: [{ delta: {}, finish_reason: "tool_calls" }] }),
      chunk({
        choices: [],
        usage: {
          prompt_tokens: 20,
          completion_tokens: 4,
          total_tokens: 24,
          prompt_tokens_details: { cached_tokens: 15 },
        },
      }),
      "data: [DONE]",
      "",
    ].join("\n\n");
    const result = await handleForcedSSEToJson(
      sseCtx(raw, {
        sourceFormat: FORMATS.CLAUDE,
        targetFormat: FORMATS.OPENAI,
        provider: "openai",
      }),
    );
    expect(result.success).toBe(true);
    const json = await result.response.json();
    expect(json.type).toBe("message");
    expect(json.content).toContainEqual({ type: "text", text: "Hello" });
    expect(json.content.find((b) => b.type === "tool_use")).toMatchObject({
      id: "call_1",
      name: "shell",
      input: { cmd: "ls" },
    });
    expect(json.stop_reason).toBe("tool_use");
    expect(json.usage).toEqual({
      input_tokens: 5,
      output_tokens: 4,
      cache_read_input_tokens: 15,
    });
  });

  it("YAN-73: forced Responses SSE upstream → Claude message", async () => {
    const event = (type, data) => `event: ${type}\ndata: ${JSON.stringify(data)}`;
    const raw = [
      event("response.created", { response: { id: "resp_1", created_at: 1700000000 } }),
      event("response.output_item.done", {
        output_index: 0,
        item: {
          type: "message",
          role: "assistant",
          content: [{ type: "output_text", text: "Done", annotations: [] }],
        },
      }),
      event("response.completed", {
        response: {
          status: "completed",
          usage: {
            input_tokens: 4,
            output_tokens: 2,
            total_tokens: 6,
          },
        },
      }),
      "",
    ].join("\n\n");
    const result = await handleForcedSSEToJson(
      sseCtx(raw, {
        sourceFormat: FORMATS.CLAUDE,
        targetFormat: FORMATS.OPENAI_RESPONSES,
        provider: "codex",
      }),
    );
    expect(result.success).toBe(true);
    const json = await result.response.json();
    expect(json.type).toBe("message");
    expect(json.content).toContainEqual({ type: "text", text: "Done" });
    expect(json.stop_reason).toBe("end_turn");
    expect(json.usage).toEqual({ input_tokens: 4, output_tokens: 2 });
  });
});
