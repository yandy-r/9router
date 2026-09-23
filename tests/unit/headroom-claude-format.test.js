// Headroom compressed a Claude body by translating it to OpenAI and back, then
// wrote the rebuilt `system` over the original. The OpenAI hop strips the
// `x-anthropic-billing-header` block that cloaking puts at system[0], and
// without it Anthropic bills a subscription (OAuth) request to extra usage:
// once that is spent, every Claude request that Headroom touched failed with
// 400 "You're out of extra usage". Only messages[] may round-trip.
import { describe, it, expect, vi, afterEach } from "vitest";
import { compressWithHeadroom } from "../../open-sse/rtk/headroom.js";
import { translateRequest } from "../../open-sse/translator/index.js";

const MODEL = "claude-opus-5";
const BILLING_HEADER_PREFIX = "x-anthropic-billing-header:";

// A cloaked Claude body, built the way chatCore builds one for an OpenAI client
// routed to a Claude OAuth account.
function cloakedClaudeBody() {
  const openaiBody = {
    model: MODEL,
    stream: true,
    messages: [
      { role: "system", content: "You are opencode." },
      { role: "user", content: "a long original message ".repeat(20) },
    ],
    tools: [{ type: "function", function: { name: "read", description: "Read a file", parameters: { type: "object", properties: { path: { type: "string" } } } } }],
  };
  return translateRequest("openai", "claude", MODEL, openaiBody, true, { accessToken: "sk-ant-oat01-test" }, "claude");
}

// Headroom echoes the messages it was sent, with user text compressed.
function stubHeadroom() {
  global.fetch = vi.fn(async (_url, init) => {
    const { messages } = JSON.parse(init.body);
    return new Response(JSON.stringify({
      messages: messages.map((m) => (m.role === "user" ? { ...m, content: "compressed text" } : m)),
      tokens_before: 100,
      tokens_after: 10,
      tokens_saved: 90,
    }), { status: 200 });
  });
}

describe("compressWithHeadroom claude format", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("leaves system untouched, keeping the billing header at system[0]", async () => {
    const body = cloakedClaudeBody();
    const originalSystem = structuredClone(body.system);
    expect(originalSystem[0].text.startsWith(BILLING_HEADER_PREFIX)).toBe(true);
    stubHeadroom();

    const data = await compressWithHeadroom(body, { enabled: true, url: "http://headroom.test", model: MODEL, format: "claude" });

    expect(data).not.toBeNull();
    expect(body.system).toEqual(originalSystem);
  });

  it("sends only conversation messages to the proxy and applies the compressed ones", async () => {
    const body = cloakedClaudeBody();
    stubHeadroom();

    await compressWithHeadroom(body, { enabled: true, url: "http://headroom.test", model: MODEL, format: "claude" });

    const sent = JSON.parse(global.fetch.mock.calls[0][1].body).messages;
    expect(sent.map((m) => m.role)).toEqual(["user"]);
    expect(body.messages).toEqual([{ role: "user", content: [{ type: "text", text: "compressed text" }] }]);
  });
});
