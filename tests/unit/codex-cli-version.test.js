// CODEX_CLI_VERSION env override (open-sse/config/codexCliFingerprint.js) flows into
// the codex User-Agent and the live model catalog's client_version; malformed fails fast.
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

let saved;
beforeEach(() => {
  saved = process.env.CODEX_CLI_VERSION;
  delete process.env.CODEX_CLI_VERSION;
  vi.resetModules();
});
afterEach(() => {
  if (saved === undefined) delete process.env.CODEX_CLI_VERSION;
  else process.env.CODEX_CLI_VERSION = saved;
});

describe("CODEX_CLI_VERSION", () => {
  it("overrides the User-Agent and the model catalog client_version", async () => {
    process.env.CODEX_CLI_VERSION = "9.8.7";
    const { PROVIDERS } = await import("open-sse/providers/index.js");
    const { CODEX_MODELS_URL } = await import("@/lib/providerModels/codexModels.js");
    expect(PROVIDERS.codex.headers["User-Agent"]).toBe("codex_cli_rs/9.8.7");
    expect(CODEX_MODELS_URL).toContain("client_version=9.8.7");
  });

  it("fails fast on a malformed value", async () => {
    process.env.CODEX_CLI_VERSION = "v0.155";
    await expect(import("open-sse/config/codexCliFingerprint.js")).rejects.toThrow(
      /Invalid CODEX_CLI_VERSION/,
    );
  });
});
