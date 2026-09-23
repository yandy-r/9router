// Fast mode on a Claude subscription is billed only to extra usage. When that is
// exhausted, the executor must retry once at standard speed (no `speed`, no
// fast-mode beta) instead of failing the request, as Claude Code does.
import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("../../open-sse/utils/proxyFetch.js", async (importOriginal) => ({
  ...(await importOriginal()),
  proxyAwareFetch: vi.fn(),
}));

import { proxyAwareFetch } from "../../open-sse/utils/proxyFetch.js";
import { DefaultExecutor } from "../../open-sse/executors/default.js";
import { ANTHROPIC_BETA_FAST_MODE } from "../../open-sse/providers/shared.js";
const EXTRA_USAGE_ERROR = JSON.stringify({
  type: "error",
  error: {
    type: "invalid_request_error",
    message: "You're out of extra usage. Add more at claude.ai/settings/usage and keep going.",
  },
});

const OTHER_ERROR = JSON.stringify({
  type: "error",
  error: { type: "invalid_request_error", message: "max_tokens: must be positive" },
});

function jsonResponse(status, text) {
  return new Response(text, { status, headers: { "content-type": "application/json" } });
}

// Resolves to the executor result plus the exact body object passed in, so
// tests can check the caller's body is never mutated.
async function run(body, provider = "claude") {
  const executor = new DefaultExecutor(provider);
  const requestBody = {
    model: "claude-opus-5",
    max_tokens: 64,
    messages: [{ role: "user", content: "hi" }],
    ...body,
  };
  const result = await executor.execute({
    model: "claude-opus-5",
    body: requestBody,
    stream: false,
    credentials: { accessToken: "oauth-token" },
    log: { warn: vi.fn() },
  });
  return { ...result, requestBody };
}

function sentRequest(callIndex) {
  const [, init] = proxyAwareFetch.mock.calls[callIndex];
  return { body: JSON.parse(init.body), betas: init.headers["Anthropic-Beta"].split(",") };
}

beforeEach(() => {
  proxyAwareFetch.mockReset();
});

describe("DefaultExecutor — fast mode downgrade on exhausted extra usage", () => {
  it("retries a fast request once at standard speed", async () => {
    proxyAwareFetch
      .mockResolvedValueOnce(jsonResponse(400, EXTRA_USAGE_ERROR))
      .mockResolvedValueOnce(jsonResponse(200, "{}"));

    const { response } = await run({ speed: "fast" });

    expect(response.status).toBe(200);
    expect(proxyAwareFetch).toHaveBeenCalledTimes(2);

    const first = sentRequest(0);
    expect(first.body.speed).toBe("fast");
    expect(first.betas).toContain(ANTHROPIC_BETA_FAST_MODE);

    const second = sentRequest(1);
    expect(second.body).not.toHaveProperty("speed");
    expect(second.betas).not.toContain(ANTHROPIC_BETA_FAST_MODE);
  });

  it("does not retry a non-fast request", async () => {
    proxyAwareFetch.mockResolvedValueOnce(jsonResponse(400, EXTRA_USAGE_ERROR));

    const { response } = await run({});

    expect(response.status).toBe(400);
    expect(proxyAwareFetch).toHaveBeenCalledTimes(1);
  });

  it("does not retry a fast request rejected for another reason, and keeps the body readable", async () => {
    proxyAwareFetch.mockResolvedValueOnce(jsonResponse(400, OTHER_ERROR));

    const { response } = await run({ speed: "fast" });

    expect(proxyAwareFetch).toHaveBeenCalledTimes(1);
    expect(await response.text()).toBe(OTHER_ERROR);
  });

  it("returns the second extra-usage 400 when the standard-speed retry is also rejected", async () => {
    proxyAwareFetch
      .mockResolvedValueOnce(jsonResponse(400, EXTRA_USAGE_ERROR))
      .mockResolvedValueOnce(jsonResponse(400, EXTRA_USAGE_ERROR));

    const { response, requestBody } = await run({ speed: "fast" });

    expect(proxyAwareFetch).toHaveBeenCalledTimes(2);
    expect(response.status).toBe(400);
    expect(await response.text()).toContain("out of extra usage");
    expect(requestBody.speed).toBe("fast");
  });

  it("does not retry for a provider that never sends Claude betas", async () => {
    proxyAwareFetch.mockResolvedValueOnce(jsonResponse(400, EXTRA_USAGE_ERROR));

    const { response } = await run({ speed: "fast" }, "openai");

    expect(response.status).toBe(400);
    expect(proxyAwareFetch).toHaveBeenCalledTimes(1);
  });
});
