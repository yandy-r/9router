// YAN-12 / #8 — authenticated Zed connection showed "Zed returned no live models."
//
// Covers:
//   - client fingerprint: upstream User-Agent format, ZED_CLIENT_VERSION override, fail-fast
//   - every Zed cloud call (users/me, llm_tokens, models) carries the Zed User-Agent
//   - disabled models are kept with their reason instead of silently vanishing
//   - x-zed-minimum-required-version surfaces as an actionable error
//   - an empty catalog is explained (disabled reasons / org config / plan)
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";

const CREDS = {
  accessToken: "access-token",
  providerSpecificData: { userId: "u-1", systemId: "sys-1", organizationId: "org-1" },
};

const MODEL = (id, extra = {}) => ({
  provider: "anthropic",
  id,
  display_name: id,
  max_token_count: 200000,
  max_output_tokens: 8192,
  supports_tools: true,
  supports_images: true,
  supports_thinking: false,
  supported_effort_levels: [],
  ...extra,
});

let calls;
let routes;

/** Install a fetch stub BEFORE importing (proxyFetch captures fetch at load). */
async function loadWithFetch() {
  calls = [];
  vi.stubGlobal("fetch", async (url, init = {}) => {
    const u = new URL(String(url));
    calls.push({ path: u.pathname, headers: new Headers(init.headers) });
    const handler = routes[u.pathname];
    if (!handler) return new Response("not stubbed", { status: 599 });
    return handler(init);
  });
  vi.resetModules();
  const zedAuth = await import("open-sse/shared/zedAuth.js");
  const diagnostics = await import("open-sse/shared/zedModelDiagnostics.js");
  const fingerprint = await import("open-sse/config/zedClientFingerprint.js");
  zedAuth.clearZedCaches();
  return { ...zedAuth, ...diagnostics, ...fingerprint };
}

const json = (body, init = {}) => new Response(JSON.stringify(body), {
  status: 200,
  headers: { "Content-Type": "application/json" },
  ...init,
});

beforeEach(() => {
  delete process.env.ZED_CLIENT_VERSION;
  routes = {
    "/client/llm_tokens": () => json({ token: "llm-token" }),
    "/models": () => json({ models: [MODEL("claude-sonnet-4")], default_model: "claude-sonnet-4" }),
  };
});
afterEach(() => {
  vi.unstubAllGlobals();
  delete process.env.ZED_CLIENT_VERSION;
});

describe("Zed client fingerprint", () => {
  it("formats the User-Agent like upstream Zed (Rust os/arch spellings)", async () => {
    const { zedUserAgent, ZED_CLIENT_VERSION, ZED_CLIENT_USER_AGENT } = await loadWithFetch();
    expect(ZED_CLIENT_VERSION).toMatch(/^\d+\.\d+\.\d+$/);
    expect(ZED_CLIENT_USER_AGENT).toMatch(/^Zed\/\d+\.\d+\.\d+ \([a-z]+; [a-z0-9_]+\)$/);
    expect(zedUserAgent("1.2.3", "darwin", "arm64")).toBe("Zed/1.2.3 (macos; aarch64)");
    expect(zedUserAgent("1.2.3", "linux", "x64")).toBe("Zed/1.2.3 (linux; x86_64)");
    expect(zedUserAgent("1.2.3", "win32", "x64")).toBe("Zed/1.2.3 (windows; x86_64)");
  });

  it("honors ZED_CLIENT_VERSION and rejects malformed values at load", async () => {
    process.env.ZED_CLIENT_VERSION = "1.99.0";
    const { ZED_CLIENT_VERSION, ZED_CLIENT_USER_AGENT } = await loadWithFetch();
    expect(ZED_CLIENT_VERSION).toBe("1.99.0");
    expect(ZED_CLIENT_USER_AGENT.startsWith("Zed/1.99.0 (")).toBe(true);

    process.env.ZED_CLIENT_VERSION = "latest";
    await expect(loadWithFetch()).rejects.toThrow(/Invalid ZED_CLIENT_VERSION/);
  });
});

describe("Zed cloud calls carry the client identity", () => {
  it("users/me, llm_tokens and models all send the Zed User-Agent", async () => {
    routes["/client/users/me"] = () => json({ default_organization_id: "org-1", organizations: [] });
    const { resolveZedModels, fetchZedAuthenticatedUser, ZED_CLIENT_USER_AGENT } = await loadWithFetch();
    await fetchZedAuthenticatedUser(CREDS);
    await resolveZedModels(CREDS, { forceRefresh: true });

    const byPath = Object.fromEntries(calls.map((c) => [c.path, c.headers]));
    for (const path of ["/client/users/me", "/client/llm_tokens", "/models"]) {
      expect(byPath[path]?.get("user-agent"), path).toBe(ZED_CLIENT_USER_AGENT);
    }
    expect(byPath["/models"].get("authorization")).toBe("Bearer llm-token");
  });
});

describe("disabled models are kept with their reason", () => {
  it("splits enabled vs disabled instead of dropping disabled ones", async () => {
    routes["/models"] = () => json({
      models: [
        MODEL("claude-sonnet-4"),
        MODEL("claude-opus-4", { is_disabled: true, disabled_reason: "Requires Zed Pro." }),
      ],
    });
    const { resolveZedModels } = await loadWithFetch();
    const catalog = await resolveZedModels(CREDS, { forceRefresh: true });
    expect(catalog.models.map((m) => m.id)).toEqual(["claude-sonnet-4"]);
    expect(catalog.disabledModels.map((m) => [m.id, m.disabledReason])).toEqual([
      ["claude-opus-4", "Requires Zed Pro."],
    ]);
  });

  it("surfaces x-zed-minimum-required-version on a rejected /models call", async () => {
    routes["/models"] = () => new Response("upgrade required", {
      status: 426,
      headers: { "x-zed-minimum-required-version": "1.30.0" },
    });
    const { resolveZedModels } = await loadWithFetch();
    await expect(resolveZedModels(CREDS, { forceRefresh: true })).rejects.toThrow(
      /426 upgrade required \(Zed requires client version >= 1\.30\.0; set ZED_CLIENT_VERSION\)/,
    );
  });
});

describe("empty catalog is explained", () => {
  it("lists Zed's disabled reasons when every model is disabled", async () => {
    const { describeDisabledZedModels } = await loadWithFetch();
    expect(describeDisabledZedModels([
      { id: "a", disabledReason: "Requires Zed Pro." },
      { id: "b", disabledReason: "Requires Zed Pro." },
      { id: "c", disabledReason: null },
    ])).toBe("Zed lists 3 model(s), but all are disabled: Requires Zed Pro.");
    expect(describeDisabledZedModels([])).toBeNull();
  });

  it("reports an organization that disabled Zed's model provider", async () => {
    const { describeZedAccountAccess } = await loadWithFetch();
    const msg = describeZedAccountAccess(CREDS, {
      organizations: [{ id: "org-1", name: "Acme", is_personal: false }],
      configuration_by_organization: { "org-1": { is_zed_model_provider_enabled: false } },
    });
    expect(msg).toBe(`Zed's hosted models are disabled by the "Acme" organization's configuration.`);
  });

  it("reports the plan (and the free-plan hint) for the resolved organization", async () => {
    const { describeZedAccountAccess } = await loadWithFetch();
    const msg = describeZedAccountAccess(
      { ...CREDS, providerSpecificData: { userId: "u-1" } },
      {
        default_organization_id: "org-2",
        organizations: [{ id: "org-2", name: "yandy", is_personal: true }],
        plans_by_organization: { "org-2": "zed_free" },
        configuration_by_organization: { "org-2": { is_zed_model_provider_enabled: true } },
        plan: { plan_v3: "zed_free", is_account_too_young: true, has_overdue_invoices: false },
      },
    );
    expect(msg).toContain(`Zed returned no live models for "yandy" (plan: Zed Free).`);
    expect(msg).toContain("too new");
    expect(msg).toContain("Zed Pro plan or trial");
  });

  it("explainEmptyZedCatalog looks up the account when nothing was disabled", async () => {
    routes["/client/users/me"] = () => json({
      default_organization_id: "org-1",
      organizations: [{ id: "org-1", name: "Acme", is_personal: false }],
      plans_by_organization: { "org-1": "zed_business" },
      configuration_by_organization: { "org-1": { is_zed_model_provider_enabled: true } },
      plan: { plan_v3: "zed_business", is_account_too_young: false, has_overdue_invoices: false },
    });
    const { explainEmptyZedCatalog, ZED_CLIENT_USER_AGENT } = await loadWithFetch();
    const msg = await explainEmptyZedCatalog(CREDS, { models: [], disabledModels: [] });
    expect(msg).toBe(`Zed returned no live models for "Acme" (plan: Zed Business).`);
    expect(calls.find((c) => c.path === "/client/users/me").headers.get("user-agent")).toBe(ZED_CLIENT_USER_AGENT);
  });

  it("falls back to a message carrying the lookup error", async () => {
    routes["/client/users/me"] = () => new Response("nope", { status: 401 });
    const { explainEmptyZedCatalog } = await loadWithFetch();
    const msg = await explainEmptyZedCatalog(CREDS, { models: [], disabledModels: [] });
    expect(msg).toBe("Zed returned no live models (account lookup failed: nope).");
  });
});
