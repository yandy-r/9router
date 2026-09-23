// GET /api/providers/[connectionId]/models for Claude connections. Subscription
// (OAuth) tokens used to be sent as `x-api-key`, which Anthropic rejects, so the
// live model list never loaded and new models had to be added by hand.
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { GET } from "@/app/api/providers/[id]/models/route.js";
import { createProviderConnection } from "@/models/index.js";

const LIVE_MODELS = { data: [{ id: "claude-opus-5-5", display_name: "Claude Opus 5.5" }, { id: "claude-opus-5", display_name: "Claude Opus 5" }], has_more: false };

let calls;
beforeEach(() => {
  calls = [];
  const nativeFetch = globalThis.fetch.bind(globalThis);
  vi.stubGlobal("fetch", async (url, init) => {
    if (!String(url).startsWith("https://api.anthropic.com/v1/models")) return nativeFetch(url, init);
    calls.push({ url: String(url), headers: init.headers });
    return Response.json(LIVE_MODELS);
  });
});
afterEach(() => {
  vi.unstubAllGlobals();
});

async function getModels(connectionId) {
  const req = new Request(`http://localhost/api/providers/${connectionId}/models`);
  return GET(req, { params: Promise.resolve({ id: connectionId }) });
}

describe("Claude live models", () => {
  it("lists models for an OAuth connection with a Bearer token and the OAuth beta", async () => {
    const conn = await createProviderConnection({ provider: "claude", authType: "oauth", accessToken: `sk-ant-oat01-${Date.now()}`, testStatus: "active" });

    const res = await getModels(conn.id);

    expect(res.status).toBe(200);
    expect((await res.json()).models.map((m) => m.id)).toEqual(["claude-opus-5-5", "claude-opus-5"]);
    expect(calls).toHaveLength(1);
    expect(calls[0].url).toContain("limit=1000");
    expect(calls[0].headers).toMatchObject({ "Authorization": `Bearer ${conn.accessToken}`, "Anthropic-Beta": "oauth-2025-04-20" });
    expect(calls[0].headers).not.toHaveProperty("x-api-key");
  });

  it("keeps x-api-key auth for an API-key connection", async () => {
    const conn = await createProviderConnection({ provider: "claude", authType: "apikey", apiKey: `sk-ant-api03-${Date.now()}`, testStatus: "active" });

    const res = await getModels(conn.id);

    expect(res.status).toBe(200);
    expect(calls[0].headers).toMatchObject({ "x-api-key": conn.apiKey });
    expect(calls[0].headers).not.toHaveProperty("Authorization");
  });
});
