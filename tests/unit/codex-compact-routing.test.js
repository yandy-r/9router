import { describe, expect, it } from "vitest";
import { CodexExecutor } from "../../open-sse/executors/codex.js";

const BASE = "https://chatgpt.com/backend-api/codex/responses";

// Mirrors BaseExecutor.execute order: buildUrl runs before transformRequest.
function route(executor, body) {
  const url = executor.buildUrl("gpt-5", true, 0, null, body);
  executor.transformRequest("gpt-5", body, true, null);
  return url;
}

describe("CodexExecutor compact routing", () => {
  it("routes by the current request, not the previous one", () => {
    const executor = new CodexExecutor();
    expect(route(executor, { input: "hi", _compact: true })).toBe(`${BASE}/compact`);
    expect(route(executor, { input: "hi" })).toBe(BASE);
  });

  it("keeps /compact on retries after _compact is stripped from the upstream body", () => {
    const executor = new CodexExecutor();
    const body = { input: "hi", _compact: true };
    route(executor, body);
    expect(body).not.toHaveProperty("_compact");
    expect(route(executor, body)).toBe(`${BASE}/compact`);
  });
});
