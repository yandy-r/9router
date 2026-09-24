// /v1/api/chat response shaping (GH #106): errors, non-stream JSON, UTF-8 splits, single done.
import { describe, it, expect } from "vitest";
import { transformToOllama } from "../../open-sse/utils/ollamaTransform.js";

function sseResponse(chunks) {
  const body = new ReadableStream({
    start(c) {
      for (const chunk of chunks) c.enqueue(chunk);
      c.close();
    },
  });
  return new Response(body, { headers: { "Content-Type": "text/event-stream" } });
}

const sse = (obj) => `data: ${JSON.stringify(obj)}\n\n`;

async function ndjson(res) {
  return (await res.text())
    .split("\n")
    .filter(Boolean)
    .map((l) => JSON.parse(l));
}

describe("transformToOllama", () => {
  it("keeps upstream error status and message", async () => {
    const upstream = new Response(JSON.stringify({ error: { message: "bad key" } }), {
      status: 401,
      headers: { "Content-Type": "application/json" },
    });
    const res = await transformToOllama(upstream, "m");
    expect(res.status).toBe(401);
    expect(await res.json()).toEqual({ error: "bad key" });
  });

  it("converts a non-stream chat.completion into one Ollama message", async () => {
    const completion = {
      object: "chat.completion",
      choices: [
        {
          message: {
            role: "assistant",
            content: "hi",
            tool_calls: [{ id: "c1", function: { name: "f", arguments: '{"a":1}' } }],
          },
          finish_reason: "tool_calls",
        },
      ],
    };
    const upstream = new Response(JSON.stringify(completion), {
      headers: { "Content-Type": "application/json" },
    });
    const body = await (await transformToOllama(upstream, "m")).json();
    expect(body.done).toBe(true);
    expect(body.message.content).toBe("hi");
    expect(body.message.tool_calls).toEqual([{ function: { name: "f", arguments: { a: 1 } } }]);
  });

  it("decodes UTF-8 split across chunks and emits exactly one done line", async () => {
    const bytes = new TextEncoder().encode(
      sse({ choices: [{ delta: { content: "é🙂" } }] }) +
        sse({ choices: [{ delta: {}, finish_reason: "stop" }] }) +
        "data: [DONE]\n\n",
    );
    const split = bytes.indexOf(0xf0) + 2; // mid-emoji
    const lines = await ndjson(
      await transformToOllama(sseResponse([bytes.slice(0, split), bytes.slice(split)]), "m"),
    );
    expect(lines.map((l) => l.message.content).join("")).toBe("é🙂");
    expect(lines.filter((l) => l.done)).toHaveLength(1);
  });

  it("surfaces a mid-stream error frame instead of a clean done", async () => {
    const bytes = new TextEncoder().encode(
      sse({ choices: [{ delta: { content: "a" } }] }) + sse({ error: { message: "boom" } }),
    );
    const lines = await ndjson(await transformToOllama(sseResponse([bytes]), "m"));
    expect(lines.at(-1)).toEqual({ error: "boom" });
    expect(lines.some((l) => l.done)).toBe(false);
  });
});
