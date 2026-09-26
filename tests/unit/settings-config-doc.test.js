import { describe, it, expect } from "vitest";
import {
  CONFIG_SCHEMA_VERSION,
  buildConfigDocument,
  validateConfigDocument,
  diffConfig,
} from "@/lib/settingsConfigDoc.js";

const LIVE = {
  settings: { requireLogin: true, stickyRoundRobinLimit: 3 },
  combos: [{ id: "db-id", name: "code", kind: null, models: ["a/b"] }],
  pricingOverrides: { anthropic: { opus: { input: 1 } } },
};

const KNOWN = new Set(["requireLogin", "stickyRoundRobinLimit"]);

describe("YAN-313 config doc pure logic", () => {
  it("exports the versioned shape, portable combos, no secrets or machine-local state", () => {
    const doc = buildConfigDocument({
      settings: {
        requireLogin: true,
        password: "hash",
        oidcClientSecret: "shh",
        tunnelUrl: "https://x.trycloudflare.com",
        tunnelProvider: "cloudflare",
      },
      combos: LIVE.combos,
      pricingOverrides: LIVE.pricingOverrides,
      version: "0.4.0-test",
    });
    expect(doc.schemaVersion).toBe(CONFIG_SCHEMA_VERSION);
    expect(typeof doc.exportedAt).toBe("string");
    expect(doc.app).toEqual({ version: "0.4.0-test" });
    expect(doc.settings).toEqual({ requireLogin: true });
    expect(doc.combos).toEqual([{ name: "code", kind: null, models: ["a/b"] }]);
    expect(doc.pricingOverrides).toEqual(LIVE.pricingOverrides);
  });

  it("round-trips with zero diff", () => {
    const doc = buildConfigDocument({ ...LIVE, version: "t" });
    const checked = validateConfigDocument(JSON.parse(JSON.stringify(doc)), KNOWN);
    expect(checked.valid).toBe(true);
    expect(checked.warnings).toEqual([]);
    const diff = diffConfig(checked.doc, {
      settings: { requireLogin: true, stickyRoundRobinLimit: 3 },
      combos: LIVE.combos,
      pricingOverrides: LIVE.pricingOverrides,
    });
    expect([diff.settings.changed, diff.settings.added]).toEqual([0, 0]);
    expect(diff.settings.unchanged).toBe(2);
    expect(diff.restartRequired).toBe(false);
  });

  it("derives known keys from schema, stored extras and the registry", async () => {
    const { deriveKnownSettingKeys } = await import("@/lib/settingsConfigDoc.js");
    const { SETTINGS_SECTIONS } = await import("@/app/(dashboard)/dashboard/settings/registry.js");
    const keys = deriveKnownSettingKeys({
      defaults: { requireLogin: true },
      stored: { tunnelEnabled: false, storedExtra: 1 },
      sections: SETTINGS_SECTIONS,
    });
    // Registry rows flow through: YAN-311/312 keys are importable after rebase.
    // Env-tagged rows (requestLogsEnabled/translatorEnabled: env-overridable)
    // are deliberately excluded — the import never overrides an env var.
    for (const key of ["fallbackStrategy", "tunnelEnabled", "startPage", "uiDensity"]) {
      expect(keys.has(key)).toBe(true);
    }
    for (const key of ["requestLogsEnabled", "translatorEnabled"]) {
      expect(keys.has(key)).toBe(false);
    }
    // UI actions, pseudo-rows and env pins are not importable settings.
    for (const key of [
      "theme",
      "language",
      "password",
      "ssoRedirect",
      "ssoTest",
      "pricingEdit",
      "backup",
      "logout",
      "shutdown",
      "SEARXNG_URL",
    ]) {
      expect(keys.has(key)).toBe(false);
    }
    // Unknown keys still warn instead of storing.
    const checked = validateConfigDocument(
      {
        schemaVersion: 1,
        settings: { storedExtra: 1, bogus: 2 },
        combos: [],
        pricingOverrides: {},
      },
      keys,
    );
    expect(checked.valid).toBe(true);
    expect(checked.doc.settings).toEqual({ storedExtra: 1 });
    expect(checked.warnings).toEqual(['Unknown setting "bogus" ignored']);
  });

  it("rejects secrets, versions, shapes; warns unknown and machine-local", () => {
    for (const secret of ["password", "oidcClientSecret"]) {
      const bad = validateConfigDocument(
        { schemaVersion: 1, settings: { [secret]: "x" }, combos: [], pricingOverrides: {} },
        KNOWN,
      );
      expect(bad.valid).toBe(false);
    }
    expect(
      validateConfigDocument(
        { schemaVersion: 999, settings: {}, combos: [], pricingOverrides: {} },
        KNOWN,
      ).valid,
    ).toBe(false);
    expect(
      validateConfigDocument(
        { schemaVersion: 1, settings: "no", combos: [], pricingOverrides: {} },
        KNOWN,
      ).valid,
    ).toBe(false);
    expect(
      validateConfigDocument(
        {
          schemaVersion: 1,
          settings: { tunnelUrl: "x", futureKey: 1 },
          combos: [{ name: "dup", models: [] }],
          pricingOverrides: {},
        },
        KNOWN,
      ),
    ).toMatchObject({ valid: true, warnings: expect.any(Array) });
  });

  it("flags added/changed groups and restart-required settings", () => {
    const checked = validateConfigDocument(
      {
        schemaVersion: 1,
        settings: { requireLogin: false, stickyRoundRobinLimit: 3 },
        combos: [
          { name: "code", kind: null, models: ["a/c"] },
          { name: "fresh", models: [] },
        ],
        pricingOverrides: { anthropic: { opus: { input: 2 } } },
      },
      new Set(["requireLogin", "stickyRoundRobinLimit", "tunnelEnabled"]),
    );
    expect(checked.valid).toBe(true);
    const diff = diffConfig(checked.doc, {
      settings: { requireLogin: true, stickyRoundRobinLimit: 3 },
      combos: LIVE.combos,
      pricingOverrides: LIVE.pricingOverrides,
    });
    expect(diff.settings.changed).toBe(1);
    expect(diff.combos.changed).toBe(1);
    expect(diff.combos.added).toBe(1);
    expect(diff.pricing.changed).toBe(1);
  });

  it("rejects invalid combos and pricing entries", () => {
    for (const combos of [
      [{ name: "__proto__" }],
      [
        { name: "dup", models: [] },
        { name: "dup", models: [] },
      ],
      [{ name: "bad models", models: "no" }],
    ]) {
      expect(
        validateConfigDocument(
          { schemaVersion: 1, settings: {}, combos, pricingOverrides: {} },
          KNOWN,
        ).valid,
      ).toBe(false);
    }
    for (const pricingOverrides of [
      { p: { m: { input: -1 } } },
      { p: { m: { bogus: 1 } } },
      { p: "no" },
    ]) {
      expect(
        validateConfigDocument(
          { schemaVersion: 1, settings: {}, combos: [], pricingOverrides },
          KNOWN,
        ).valid,
      ).toBe(false);
    }
  });
});
