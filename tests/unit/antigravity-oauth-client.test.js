// Guards the Google OAuth clients (Antigravity, Gemini): read from env in one place
// (shared.js), spread into registry + src/lib/oauth, never hard-coded in source.
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

const ENV = {
  ANTIGRAVITY_OAUTH_CLIENT_ID: "ag-test-client.apps.example",
  ANTIGRAVITY_OAUTH_CLIENT_SECRET: "ag-test-secret",
  GEMINI_OAUTH_CLIENT_ID: "gemini-test-client.apps.example",
  GEMINI_OAUTH_CLIENT_SECRET: "gemini-test-secret",
};
const EXPECTED = { clientId: ENV.ANTIGRAVITY_OAUTH_CLIENT_ID, clientSecret: ENV.ANTIGRAVITY_OAUTH_CLIENT_SECRET };
const GOOGLE = { clientId: ENV.GEMINI_OAUTH_CLIENT_ID, clientSecret: ENV.GEMINI_OAUTH_CLIENT_SECRET };

let savedEnv;
beforeEach(() => {
  savedEnv = Object.fromEntries(Object.keys(ENV).map((k) => [k, process.env[k]]));
  Object.assign(process.env, ENV);
  vi.resetModules();
});
afterEach(() => {
  for (const [k, v] of Object.entries(savedEnv)) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
});

describe("google oauth clients (env-sourced)", () => {
  it("shared source reads the antigravity client from env", async () => {
    const { ANTIGRAVITY_OAUTH_CLIENT } = await import("../../open-sse/providers/shared.js");
    expect(ANTIGRAVITY_OAUTH_CLIENT).toEqual(EXPECTED);
  });

  it("registry transport keeps clientId/clientSecret", async () => {
    const ag = (await import("../../open-sse/providers/registry/antigravity.js")).default;
    expect(ag.transport.clientId).toBe(EXPECTED.clientId);
    expect(ag.transport.clientSecret).toBe(EXPECTED.clientSecret);
  });

  it("google client shared by gemini + gemini-cli", async () => {
    const { GOOGLE_OAUTH_CLIENT } = await import("../../open-sse/providers/shared.js");
    expect(GOOGLE_OAUTH_CLIENT).toEqual(GOOGLE);
    const gemini = (await import("../../open-sse/providers/registry/gemini.js")).default;
    const gc = (await import("../../open-sse/providers/registry/gemini-cli.js")).default;
    expect(gemini.transport.clientSecret).toBe(GOOGLE.clientSecret);
    expect(gc.transport.clientSecret).toBe(GOOGLE.clientSecret);
  });

  it("is undefined when env is unset and assertOAuthClient names the missing vars", async () => {
    for (const k of Object.keys(ENV)) delete process.env[k];
    const { ANTIGRAVITY_OAUTH_CLIENT, GOOGLE_OAUTH_CLIENT, assertOAuthClient } = await import("../../open-sse/providers/shared.js");
    expect(ANTIGRAVITY_OAUTH_CLIENT).toEqual({ clientId: undefined, clientSecret: undefined });
    expect(() => assertOAuthClient(GOOGLE_OAUTH_CLIENT, "gemini")).toThrow(/GEMINI_OAUTH_CLIENT_ID and GEMINI_OAUTH_CLIENT_SECRET/);
    expect(() => assertOAuthClient(ANTIGRAVITY_OAUTH_CLIENT, "antigravity")).toThrow(/ANTIGRAVITY_OAUTH_CLIENT_ID/);
  });

  it("OAuth login fails fast before building an auth URL when unconfigured", async () => {
    for (const k of Object.keys(ENV)) delete process.env[k];
    const { generateAuthData } = await import("../../src/lib/oauth/providers/index.js");
    await expect(generateAuthData("gemini-cli", "http://localhost/callback")).rejects.toThrow(/GEMINI_OAUTH_CLIENT_ID/);
    await expect(generateAuthData("antigravity", "http://localhost/callback")).rejects.toThrow(/ANTIGRAVITY_OAUTH_CLIENT_ID/);
  });

  it("OAuth login builds the auth URL with the env client id", async () => {
    const { generateAuthData } = await import("../../src/lib/oauth/providers/index.js");
    const { authUrl } = await generateAuthData("gemini-cli", "http://localhost/callback");
    expect(new URL(authUrl).searchParams.get("client_id")).toBe(GOOGLE.clientId);
  });

  it("token refresh returns null and logs when the client is unconfigured", async () => {
    const { refreshGoogleToken } = await import("../../open-sse/services/tokenRefresh/providers.js");
    const log = { error: vi.fn(), info: vi.fn() };
    const fetchSpy = vi.spyOn(globalThis, "fetch");
    await expect(refreshGoogleToken("refresh-token", undefined, undefined, log)).resolves.toBeNull();
    expect(fetchSpy).not.toHaveBeenCalled();
    expect(log.error).toHaveBeenCalledWith("TOKEN_REFRESH", expect.stringMatching(/GEMINI_OAUTH_CLIENT_ID/));
    fetchSpy.mockRestore();
  });

  // Guard: oauth.js must spread shared clients + derive from registry (PROVIDER_OAUTH).
  it("src oauth.js imports shared client + keeps full shape", async () => {
    const { readFileSync } = await import("node:fs");
    const { fileURLToPath } = await import("node:url");
    const { dirname, join } = await import("node:path");
    const here = dirname(fileURLToPath(import.meta.url));
    const src = readFileSync(join(here, "../../src/lib/oauth/constants/oauth.js"), "utf8");
    expect(src).toContain('import { ANTIGRAVITY_OAUTH_CLIENT, GOOGLE_OAUTH_CLIENT } from "open-sse/providers/shared.js"');
    expect(src).toContain("...ANTIGRAVITY_OAUTH_CLIENT");
    expect(src).toContain("...GOOGLE_OAUTH_CLIENT");
    // authorizeUrl now lives in registry; oauth.js derives via PROVIDER_OAUTH spread
    expect(src).toContain('PROVIDER_OAUTH["antigravity"]');
    expect(src).toContain('PROVIDER_OAUTH["gemini-cli"]');
  });

  it("no Google OAuth client credentials are hard-coded in source", async () => {
    const { execFileSync } = await import("node:child_process");
    const { fileURLToPath } = await import("node:url");
    const { dirname, join } = await import("node:path");
    const root = join(dirname(fileURLToPath(import.meta.url)), "../..");
    // Split so this file does not match its own search.
    const pattern = ["GOC", "SPX-|[0-9]{6,}-[a-z0-9]{32}\\.apps\\.googleusercontent\\.com"].join("");
    let hits = "";
    try {
      hits = execFileSync("git", ["grep", "-lE", pattern, "--", "open-sse", "src", "cli", "tests"], { cwd: root, encoding: "utf8" });
    } catch (e) {
      if (e.status !== 1) throw e; // exit 1 = no matches
    }
    expect(hits).toBe("");
  });
});
