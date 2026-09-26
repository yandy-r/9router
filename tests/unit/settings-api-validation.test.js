import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, it, expect, beforeAll, afterAll, vi } from "vitest";

const originalDataDir = process.env.DATA_DIR;
let tempDir;

beforeAll(async () => {
  tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "9router-settings-validation-"));
  process.env.DATA_DIR = tempDir;
  vi.resetModules();
  const db = await import("@/lib/db/index.js");
  await db.initDb();
});

afterAll(() => {
  if (tempDir) fs.rmSync(tempDir, { recursive: true, force: true });
  if (originalDataDir === undefined) delete process.env.DATA_DIR;
  else process.env.DATA_DIR = originalDataDir;
});

const settingsPatch = (body) =>
  import("@/app/api/settings/route.js").then(({ PATCH }) =>
    PATCH(
      new Request("http://localhost/api/settings", {
        method: "PATCH",
        body: JSON.stringify(body),
      }),
    ),
  );

describe("PATCH /api/settings validation for YAN-309 keys", () => {
  it("accepts requireLogin / requireApiKey / tunnelDashboardAccess booleans", async () => {
    const res = await settingsPatch({
      requireLogin: false,
      requireApiKey: false,
      tunnelDashboardAccess: false,
    });
    expect(res.status).toBe(200);
    const data = await res.json();
    expect(data.requireLogin).toBe(false);
    expect(data.requireApiKey).toBe(false);
    expect(data.tunnelDashboardAccess).toBe(false);
    await settingsPatch({ requireLogin: true, requireApiKey: true, tunnelDashboardAccess: true });
  });

  it("rejects non-boolean security toggles", async () => {
    for (const body of [
      { requireLogin: "yes" },
      { requireApiKey: 1 },
      { tunnelDashboardAccess: "x" },
    ]) {
      const res = await settingsPatch(body);
      expect(res.status).toBe(400);
      expect((await res.json()).error).toBeTruthy();
    }
  });

  it("accepts authMode password/both/sso and ssoType oidc/saml", async () => {
    const res = await settingsPatch({ authMode: "both", ssoType: "saml" });
    expect(res.status).toBe(200);
    const data = await res.json();
    expect(data.authMode).toBe("both");
    expect(data.ssoType).toBe("saml");
    await settingsPatch({ authMode: "password", ssoType: "oidc" });
  });

  it("rejects unknown authMode / ssoType", async () => {
    for (const body of [{ authMode: "magic" }, { ssoType: "kerberos" }, { authMode: 42 }]) {
      const res = await settingsPatch(body);
      expect(res.status).toBe(400);
    }
  });

  it("accepts OIDC fields within lengths and rejects bad URLs / overlong values", async () => {
    const good = await settingsPatch({
      oidcIssuerUrl: "https://auth.example.com/app",
      oidcClientId: "client-1",
      oidcScopes: "openid profile email",
      oidcLoginLabel: "Sign in",
    });
    expect(good.status).toBe(200);
    const badUrl = await settingsPatch({ oidcIssuerUrl: "not a url" });
    expect(badUrl.status).toBe(400);
    const tooLong = await settingsPatch({ oidcClientId: "x".repeat(300) });
    expect(tooLong.status).toBe(400);
  });

  it("accepts SAML fields within lengths and rejects bad URLs / overlong certs", async () => {
    const good = await settingsPatch({
      samlEntryPoint: "https://idp.example.com/sso",
      samlIssuer: "urn:9router:sp",
      samlCert: "QUJD",
      samlLoginLabel: "Sign in with SAML SSO",
      samlAttributeEmail: "email",
      samlAttributeName: "name",
    });
    expect(good.status).toBe(200);
    expect((await settingsPatch({ samlEntryPoint: ":::bad" })).status).toBe(400);
    expect((await settingsPatch({ samlCert: "x".repeat(20000) })).status).toBe(400);
  });

  it("rejects overlong password payloads at the boundary", async () => {
    const res = await settingsPatch({
      currentPassword: "x",
      newPassword: "y".repeat(300),
    });
    expect(res.status).toBe(400);
  });
});
