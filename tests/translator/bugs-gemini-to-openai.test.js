// Gemini ({ contents }) → OpenAI: parallel same-name calls and parallel results.
import { describe, it, expect } from "vitest";
import "./registerAll.js";
import { translateRequest } from "../../open-sse/translator/index.js";
import { FORMATS } from "../../open-sse/translator/formats.js";

const G2O = (body) => translateRequest(FORMATS.GEMINI, FORMATS.OPENAI, "m", body, true, null, null);

describe("Gemini → OpenAI", () => {
  // gemini-to-openai.js — parallel same-name functionCalls without ids must get
  // distinct ids, FIFO-paired to their functionResponses in order (YAN-31/#165)
  it("parallel same-name calls get distinct ids paired to results in order", () => {
    const out = G2O({
      contents: [
        {
          role: "model",
          parts: [
            { functionCall: { name: "read_file", args: { path: "a" } } },
            { functionCall: { name: "read_file", args: { path: "b" } } },
          ],
        },
        {
          role: "user",
          parts: [
            { functionResponse: { name: "read_file", response: { result: "AAA" } } },
            { functionResponse: { name: "read_file", response: { result: "BBB" } } },
          ],
        },
      ],
    });
    const asst = out.messages.find((m) => m.tool_calls);
    const callIds = asst?.tool_calls?.map((tc) => tc.id) ?? [];
    const tools = out.messages.filter((m) => m.role === "tool");
    expect(new Set(callIds).size, "parallel call ids collided").toBe(2);
    expect(tools).toHaveLength(2);
    expect(tools[0]?.tool_call_id, "first result not paired to first call").toBe(callIds[0]);
    expect(tools[1]?.tool_call_id, "second result not paired to second call").toBe(callIds[1]);
    expect(tools[0]?.content).toBe('"AAA"');
    expect(tools[1]?.content).toBe('"BBB"');
  });

  it("keeps user text role when sharing a function response", () => {
    const out = G2O({
      contents: [
        { role: "model", parts: [{ functionCall: { id: "A", name: "foo" } }] },
        {
          role: "user",
          parts: [
            { text: "next prompt" },
            { functionResponse: { id: "A", name: "foo", response: { result: "ok" } } },
          ],
        },
      ],
    });
    expect(out.messages.map((message) => message.role)).toEqual(["assistant", "tool", "user"]);
    expect(out.messages[1]?.tool_call_id).toBe("A");
    expect(out.messages[2]?.content).toBe("next prompt");
  });

  it("places a co-located assistant call before its explicit-id result", () => {
    const out = G2O({
      contents: [
        {
          role: "model",
          parts: [
            { functionCall: { id: "A", name: "foo" } },
            { functionResponse: { id: "A", name: "foo", response: { result: "ok" } } },
          ],
        },
      ],
    });
    expect(out.messages.map((message) => message.role)).toEqual(["assistant", "tool"]);
    expect(out.messages[0]?.tool_calls?.[0]?.id).toBe(out.messages[1]?.tool_call_id);
  });

  it("keeps a lone image when sharing a function response", () => {
    const out = G2O({
      contents: [
        { role: "model", parts: [{ functionCall: { id: "A", name: "foo" } }] },
        {
          role: "user",
          parts: [
            { inlineData: { mimeType: "image/png", data: "aGVsbG8=" } },
            { functionResponse: { id: "A", name: "foo", response: { result: "ok" } } },
          ],
        },
      ],
    });
    expect(out.messages[2]?.content).toEqual([
      { type: "image_url", image_url: { url: "data:image/png;base64,aGVsbG8=" } },
    ]);
  });

  it("removes an explicitly answered id from every function queue", () => {
    const out = G2O({
      contents: [
        {
          role: "model",
          parts: [
            { functionCall: { id: "A", name: "foo" } },
            { functionCall: { id: "B", name: "bar" } },
          ],
        },
        { role: "user", parts: [{ functionResponse: { id: "B", name: "foo" } }] },
        { role: "user", parts: [{ functionResponse: { name: "bar" } }] },
      ],
    });
    expect(out.messages[1]?.tool_call_id).toBe("B");
    expect(out.messages[2]?.tool_call_id).not.toBe("B");
  });
});
