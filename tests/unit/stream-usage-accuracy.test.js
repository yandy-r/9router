import { describe, expect, it } from "vitest";

import { FORMATS } from "../../open-sse/translator/formats.js";
import {
  createPassthroughStreamWithLogger,
  createSSETransformStreamWithLogger,
} from "../../open-sse/utils/stream.js";
import { canonicalizeUsage } from "../../open-sse/utils/usageTracking.js";

// Pipe raw SSE text through the transform, drain it, and return the usage handed
// to onStreamComplete (what gets persisted).
async function completedUsage(makeStream, input) {
  let usage;
  const onStreamComplete = (_content, u) => {
    usage = u;
  };
  const encoder = new TextEncoder();
  const source = new ReadableStream({
    start(controller) {
      controller.enqueue(encoder.encode(input));
      controller.close();
    },
  });
  const reader = source.pipeThrough(makeStream(onStreamComplete)).getReader();
  while (!(await reader.read()).done) {}
  return usage;
}

const passthrough = (onStreamComplete) =>
  createPassthroughStreamWithLogger("openai", null, "m", null, { messages: [] }, onStreamComplete);

const data = (obj) => `data: ${JSON.stringify(obj)}\n`;
const contentChunk = data({
  id: "chatcmpl-abcdefgh",
  choices: [{ index: 0, delta: { content: "hello" } }],
});
const finishChunk = data({
  id: "chatcmpl-abcdefgh",
  choices: [{ index: 0, delta: {}, finish_reason: "stop" }],
});

describe("passthrough stream usage", () => {
  it("persists the real usage chunk that follows a usage-less finish chunk", async () => {
    const usage = await completedUsage(
      passthrough,
      contentChunk +
        finishChunk +
        data({ choices: [], usage: { prompt_tokens: 8, completion_tokens: 2, total_tokens: 10 } }) +
        "data: [DONE]\n",
    );
    expect(usage.prompt_tokens).toBe(8);
    expect(usage.completion_tokens).toBe(2);
    expect(usage.estimated).toBeUndefined();
  });

  it("falls back to an estimate when no usage ever arrives", async () => {
    const usage = await completedUsage(passthrough, `${contentChunk}${finishChunk}data: [DONE]\n`);
    expect(usage.estimated).toBe(true);
  });
});

describe("Claude → OpenAI stream usage", () => {
  it("does not fold cache into prompt_tokens twice", async () => {
    const event = (type, obj) => `event: ${type}\ndata: ${JSON.stringify({ type, ...obj })}\n`;
    const usage = await completedUsage(
      (onStreamComplete) =>
        createSSETransformStreamWithLogger(
          FORMATS.CLAUDE,
          FORMATS.OPENAI,
          "claude",
          null,
          null,
          "m",
          null,
          { messages: [] },
          onStreamComplete,
        ),
      event("message_start", {
        message: {
          id: "msg_1",
          model: "m",
          usage: {
            input_tokens: 100,
            output_tokens: 1,
            cache_read_input_tokens: 200,
            cache_creation_input_tokens: 30,
          },
        },
      }) +
        event("content_block_start", { index: 0, content_block: { type: "text", text: "" } }) +
        event("content_block_delta", { index: 0, delta: { type: "text_delta", text: "hi" } }) +
        event("content_block_stop", { index: 0 }) +
        event("message_delta", {
          delta: { stop_reason: "end_turn" },
          usage: { output_tokens: 5 },
        }) +
        event("message_stop", {}),
    );
    const canonical = canonicalizeUsage(usage);
    expect(canonical.prompt_tokens).toBe(330);
    expect(canonical.completion_tokens).toBe(5);
    expect(canonical.cached_tokens).toBe(200);
    expect(canonical.cache_creation_input_tokens).toBe(30);
  });
});
