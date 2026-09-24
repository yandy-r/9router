// /v1 routes without a handler-level check must still enforce requireApiKey
// (local callers bypass the middleware), and /v1/audio/voices must not
// self-fetch the login-gated /api/media-providers routes.
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  getSettings: vi.fn(),
  validateApiKey: vi.fn(),
}));

vi.mock("@/lib/localDb", () => ({
  getSettings: mocks.getSettings,
  validateApiKey: mocks.validateApiKey,
}));
vi.mock("@/shared/utils/machineId", () => ({
  getConsistentMachineId: vi.fn(async () => "cli-token"),
}));
vi.mock("open-sse/handlers/ttsCore.js", () => ({
  VOICE_FETCHERS: {
    "edge-tts": async () => [
      { ShortName: "en-US-AvaNeural", FriendlyName: "Ava", Locale: "en-US", Gender: "Female" },
    ],
  },
}));

const { requireClientApiKey } = await import("@/lib/auth/requireClientApiKey");
const { GET: getVoices } = await import("@/app/api/v1/audio/voices/route.js");

const req = (headers = {}, url = "http://localhost/v1/models") => new Request(url, { headers });

describe("requireClientApiKey", () => {
  beforeEach(() => {
    mocks.getSettings.mockResolvedValue({ requireApiKey: true });
    mocks.validateApiKey.mockImplementation(async (k) => k === "sk-good");
  });

  it("allows everything when requireApiKey is off", async () => {
    mocks.getSettings.mockResolvedValue({ requireApiKey: false });
    expect(await requireClientApiKey(req())).toBeNull();
  });

  it("rejects missing and invalid keys with 401", async () => {
    expect((await requireClientApiKey(req())).status).toBe(401);
    expect((await requireClientApiKey(req({ Authorization: "Bearer sk-bad" }))).status).toBe(401);
  });

  it("accepts a valid key or the local CLI token", async () => {
    expect(await requireClientApiKey(req({ Authorization: "Bearer sk-good" }))).toBeNull();
    expect(await requireClientApiKey(req({ "x-9r-cli-token": "cli-token" }))).toBeNull();
  });
});

describe("GET /v1/audio/voices", () => {
  beforeEach(() => {
    mocks.getSettings.mockResolvedValue({ requireApiKey: true });
    mocks.validateApiKey.mockImplementation(async (k) => k === "sk-good");
  });

  it("returns 401 without a key", async () => {
    const res = await getVoices(req({}, "http://localhost/v1/audio/voices?provider=edge-tts"));
    expect(res.status).toBe(401);
  });

  it("lists voices in-process with a valid key", async () => {
    const fetchSpy = vi.spyOn(globalThis, "fetch");
    const res = await getVoices(
      req({ "x-api-key": "sk-good" }, "http://localhost/v1/audio/voices?provider=edge-tts"),
    );
    expect(res.status).toBe(200);
    expect((await res.json()).data[0].model).toBe("edge-tts/en-US-AvaNeural");
    expect(fetchSpy).not.toHaveBeenCalled();
    fetchSpy.mockRestore();
  });
});
