import { afterEach, describe, expect, it, vi } from "vitest";
import { CodexExecutor } from "../../open-sse/executors/codex.js";
import { translateRequest } from "../../open-sse/translator/index.js";
import * as proxyFetchModule from "../../open-sse/utils/proxyFetch.js";

const BASE = "https://chatgpt.com/backend-api/codex/responses";
const credentials = { accessToken: "t", connectionId: "c" };
const ok = () =>
  new Response("data: {}\n\n", { status: 200, headers: { "content-type": "text/event-stream" } });

function run(executor, body) {
  return executor.execute({ model: "gpt-5", body, stream: true, credentials });
}

describe("CodexExecutor compact routing (YAN-19)", () => {
  afterEach(() => vi.restoreAllMocks());

  it("routes each concurrent request by its own body", async () => {
    const fetchSpy = vi
      .spyOn(proxyFetchModule, "proxyAwareFetch")
      .mockImplementation(async () => ok());
    const executor = new CodexExecutor();

    const [compact, plain] = await Promise.all([
      run(executor, { input: "hi", _compact: true }),
      run(executor, { input: "hi" }),
    ]);

    expect(compact.url).toBe(`${BASE}/compact`);
    expect(plain.url).toBe(BASE);
    for (const [, init] of fetchSpy.mock.calls) expect(init.body).not.toContain("_compact");
  });

  it("keeps /compact on retries after _compact is stripped from the upstream body", async () => {
    const fetchSpy = vi
      .spyOn(proxyFetchModule, "proxyAwareFetch")
      .mockResolvedValueOnce(new Response("busy", { status: 503 }))
      .mockImplementation(async () => ok());
    const executor = new CodexExecutor();
    executor.config = { ...executor.config, retry: { 503: { attempts: 1, delayMs: 0 } } };

    await run(executor, { input: "hi", _compact: true });

    expect(fetchSpy.mock.calls.map(([url]) => url)).toEqual([`${BASE}/compact`, `${BASE}/compact`]);
  });

  // YAN-272: /v1/responses/compact forces openai-responses; chat/claude bodies
  // must still be translated to `input` and keep the compact flag.
  it.each([
    ["chat body on the responses endpoint", "openai-responses"],
    ["claude body", "claude"],
  ])("routes a translated %s to /compact with input", async (_, sourceFormat) => {
    const fetchSpy = vi
      .spyOn(proxyFetchModule, "proxyAwareFetch")
      .mockImplementation(async () => ok());
    const body = translateRequest(sourceFormat, "openai-responses", "gpt-5", {
      model: "gpt-5",
      messages: [{ role: "user", content: "hello there" }],
      _compact: true,
    });

    const { url } = await run(new CodexExecutor(), body);

    expect(url).toBe(`${BASE}/compact`);
    const sent = JSON.parse(fetchSpy.mock.calls[0][1].body);
    expect(JSON.stringify(sent.input)).toContain("hello there");
    expect(sent).not.toHaveProperty("_compact");
    expect(sent).not.toHaveProperty("messages");
  });
});
