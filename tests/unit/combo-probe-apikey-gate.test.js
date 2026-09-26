// Merge-gate: probe succeeds under default requireApiKey=true via the
// in-process skipApiKeyCheck option; /v1 without a key still 401s; the
// option is unreachable from request content.
import { describe, expect, it, vi, beforeEach } from "vitest";

const { executeMock } = vi.hoisted(() => ({ executeMock: vi.fn() }));

vi.mock("../../open-sse/executors/index.js", () => ({
  getExecutor: () => ({ execute: executeMock }),
}));

vi.mock("../../open-sse/utils/requestLogger.js", () => ({
  createRequestLogger: async () => ({
    logClientRawRequest: vi.fn(),
    logRawRequest: vi.fn(),
    logTargetRequest: vi.fn(),
    logProviderResponse: vi.fn(),
    logConvertedResponse: vi.fn(),
    logError: vi.fn(),
  }),
}));

vi.mock("../../open-sse/utils/stream.js", () => ({
  COLORS: { red: "", reset: "" },
  createPassthroughStreamWithLogger: vi.fn(() => new TransformStream()),
}));

vi.mock("@/lib/usageDb.js", () => ({
  trackPendingRequest: vi.fn(),
  appendRequestLog: vi.fn(async () => {}),
  saveRequestDetail: vi.fn(async () => {}),
}));

const db = await import("@/lib/localDb.js");
const { handleChat } = await import("../../src/sse/handlers/chat.js");
const { runComboProbe, resetProbeRateLimit } = await import("../../src/sse/services/comboProbe.js");

function okUpstream() {
  return {
    response: new Response(
      JSON.stringify({
        choices: [{ message: { role: "assistant", content: "ok" }, finish_reason: "stop" }],
        usage: { prompt_tokens: 8, completion_tokens: 2 },
      }),
      { status: 200, headers: { "content-type": "application/json" } },
    ),
    url: "https://fake.local/v1/chat/completions",
    headers: {},
    transformedBody: null,
  };
}

function probeRequest(model) {
  return {
    url: "http://localhost/api/combos/probe",
    headers: {
      get: (name) =>
        String(name).toLowerCase() === "user-agent" ? "9router-combo-probe/1.0" : null,
      entries: () => [][Symbol.iterator](),
    },
    json: async () => ({ model, messages: [{ role: "user", content: "hi" }], stream: false }),
  };
}

const v1Request = (body) =>
  new Request("http://localhost/v1/chat/completions", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });

describe("probe API-key gate (merge gate)", () => {
  beforeEach(async () => {
    vi.clearAllMocks();
    resetProbeRateLimit();
    // Default settings: requireApiKey true (DEFAULT_SETTINGS).
    await db.updateSettings({ requireApiKey: true });
    await db.createProviderConnection({
      provider: "openai",
      name: "probe-conn",
      apiKey: "sk-probe",
      isActive: true,
    });
    // beforeEach re-runs per test; the temp DATA_DIR is per-file, so reuse the
    // same combo name only if it does not exist yet.
    if (!(await db.getComboByName("probe-gate"))) {
      await db.createCombo({ name: "probe-gate", models: ["openai/gpt-4o-mini"] });
    }
    executeMock.mockResolvedValue(okUpstream());
  });

  it("probe succeeds under default requireApiKey=true", async () => {
    const result = await runComboProbe({ comboId: (await db.getComboByName("probe-gate")).id });
    expect(result.served?.outcome).toBe("served");
    expect(result.attempts).toHaveLength(1);
  });

  it("/v1 without a key still 401s under default settings", async () => {
    const res = await handleChat(
      v1Request({ model: "probe-gate", messages: [{ role: "user", content: "hi" }] }),
    );
    expect(res.status).toBe(401);
  });

  it("skipApiKeyCheck cannot be set from request content", async () => {
    // Every request-content channel an attacker controls: body, Authorization
    // header value, URL. handleChat reads the option only from its third
    // argument, so all of these still 401.
    const bodies = [
      { model: "probe-gate", messages: [], skipApiKeyCheck: true },
      { model: "probe-gate", messages: [], options: { skipApiKeyCheck: true } },
    ];
    for (const body of bodies) {
      const res = await handleChat(v1Request(body));
      expect(res.status).toBe(401);
    }
    const withHeader = new Request("http://localhost/v1/chat/completions", {
      method: "POST",
      headers: { "Content-Type": "application/json", "x-skip-api-key-check": "true" },
      body: JSON.stringify({ model: "probe-gate", messages: [] }),
    });
    expect((await handleChat(withHeader)).status).toBe(401);
    const withUrl = new Request("http://localhost/v1/chat/completions?skipApiKeyCheck=true", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ model: "probe-gate", messages: [] }),
    });
    expect((await handleChat(withUrl)).status).toBe(401);
  });
});
