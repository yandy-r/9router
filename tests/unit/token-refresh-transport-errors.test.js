import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

const originalFetch = global.fetch;
const PROFILE_ARN = "arn:aws:codewhisperer:us-east-1:123456789012:profile/ABC";
const EXTERNAL_IDP = {
  authMethod: "external_idp",
  clientId: "00000000-0000-4000-8000-000000000000",
  tokenEndpoint: "https://login.microsoftonline.com/tenant-id/oauth2/v2.0/token",
  scope: "offline_access",
  profileArn: PROFILE_ARN,
};
const AWS = { authMethod: "idc", clientId: "cid", clientSecret: "secret", profileArn: PROFILE_ARN };
const SOCIAL = { profileArn: PROFILE_ARN };

const makeLog = () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn() });
const badJson = { ok: true, json: () => Promise.reject(new SyntaxError("bad json")) };

async function loadKiro(proxyAwareFetch) {
  vi.doMock("../../open-sse/utils/proxyFetch.js", () => ({ proxyAwareFetch }));
  const { refreshKiroToken } = await import("../../open-sse/services/tokenRefresh/providers.js");
  return refreshKiroToken;
}

describe("token refresh transport and parse failures", () => {
  beforeEach(() => {
    vi.resetModules();
    global.fetch = originalFetch;
  });

  afterEach(() => {
    vi.doUnmock("../../open-sse/utils/proxyFetch.js");
    global.fetch = originalFetch;
  });

  it.each([
    ["external_idp", EXTERNAL_IDP],
    ["AWS", AWS],
    ["social", SOCIAL],
  ])("Kiro %s returns null on transport and parse errors", async (_name, psd) => {
    for (const fetchImpl of [
      vi.fn().mockRejectedValue(new Error("socket hang up")),
      vi.fn().mockResolvedValue(badJson),
    ]) {
      vi.resetModules();
      const refreshKiroToken = await loadKiro(fetchImpl);
      const log = makeLog();
      await expect(refreshKiroToken(`rt-${_name}`, psd, log)).resolves.toBeNull();
      expect(fetchImpl).toHaveBeenCalledTimes(1);
      expect(log.error).toHaveBeenCalledWith("TOKEN_REFRESH", expect.stringContaining("Kiro"));
    }
  });

  it("Kiro invalid external_idp config still returns null without fetching", async () => {
    const fetchImpl = vi.fn();
    const refreshKiroToken = await loadKiro(fetchImpl);
    const log = makeLog();
    const out = await refreshKiroToken(
      "rt-invalid",
      { ...EXTERNAL_IDP, tokenEndpoint: "https://evil.example.com/token" },
      log,
    );
    expect(out).toBeNull();
    expect(fetchImpl).not.toHaveBeenCalled();
    expect(log.warn).toHaveBeenCalledWith(
      "TOKEN_REFRESH",
      expect.stringContaining("Invalid Kiro external_idp refresh config"),
    );
  });

  it("Kiro social success path is preserved", async () => {
    const fetchImpl = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ accessToken: "acc", refreshToken: "rot", expiresIn: 3600 }),
    });
    const refreshKiroToken = await loadKiro(fetchImpl);
    await expect(refreshKiroToken("rt-ok", SOCIAL, makeLog())).resolves.toEqual({
      accessToken: "acc",
      refreshToken: "rot",
      expiresIn: 3600,
    });
  });

  it.each([
    ["refreshCodebuddyToken", "CodeBuddy"],
    ["refreshCodebuddyIntlToken", "CodeBuddy intl"],
  ])("%s returns null on transport and parse errors, keeps success", async (fnName, label) => {
    for (const fetchImpl of [
      vi.fn().mockRejectedValue(new Error("ECONNRESET")),
      vi.fn().mockResolvedValue(badJson),
    ]) {
      vi.resetModules();
      global.fetch = fetchImpl;
      const mod = await import("../../open-sse/services/tokenRefresh/providers.js");
      const log = makeLog();
      await expect(mod[fnName]("cb-rt", log)).resolves.toBeNull();
      expect(log.error).toHaveBeenCalledWith(
        "TOKEN_REFRESH",
        expect.stringContaining(`Error refreshing ${label} token`),
      );
    }

    vi.resetModules();
    global.fetch = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ code: 0, data: { accessToken: "cb-acc", expiresIn: 60 } }),
    });
    const mod = await import("../../open-sse/services/tokenRefresh/providers.js");
    await expect(mod[fnName]("cb-rt", makeLog())).resolves.toEqual({
      accessToken: "cb-acc",
      refreshToken: "cb-rt",
      expiresIn: 60,
    });
  });
});
