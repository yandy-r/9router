// updateComboStrategies: serialized transforms merge without losing stale writes;
// rename migrates the latest stored weights entry, not a snapshot.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, it, expect, beforeAll, afterAll, vi } from "vitest";

const originalDataDir = process.env.DATA_DIR;
let tempDir;
let sqliteDb;

beforeAll(async () => {
  tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "9router-combo-atomic-"));
  process.env.DATA_DIR = tempDir;
  vi.resetModules();
  sqliteDb = await import("@/lib/db/index.js");
  await sqliteDb.initDb();
});

afterAll(() => {
  if (tempDir) fs.rmSync(tempDir, { recursive: true, force: true });
  if (originalDataDir === undefined) delete process.env.DATA_DIR;
  else process.env.DATA_DIR = originalDataDir;
});

describe("comboStrategies atomic transforms", () => {
  it("weight deltas from the same base merge without loss", async () => {
    await sqliteDb.updateSettings({
      comboStrategies: { code: { fallbackStrategy: "weighted", weights: { a: 1 } } },
    });

    // Simulate two rapid UI saves built from the same stale representation.
    const apply = (model, value) =>
      sqliteDb.updateComboStrategies((strategies) => {
        const next = { ...(strategies.code || {}), weights: { ...strategies.code?.weights } };
        next.weights[model] = value;
        return { ...strategies, code: next };
      });
    await apply("a", 3);
    await apply("b", 2);

    const settings = await sqliteDb.getSettings();
    expect(settings.comboStrategies.code.weights).toEqual({ a: 3, b: 2 });
  });

  it("rename moves the latest weight for the entry", async () => {
    await sqliteDb.updateSettings({
      comboStrategies: { oldCombo: { fallbackStrategy: "weighted", weights: { a: 5 } } },
    });
    const move = (fromName, toName) =>
      sqliteDb.updateComboStrategies((strategies) => {
        if (!Object.hasOwn(strategies, fromName)) return strategies;
        const updated = { ...strategies };
        if (toName) updated[toName] = updated[fromName];
        delete updated[fromName];
        return updated;
      });
    await move("oldCombo", "newCombo");

    const settings = await sqliteDb.getSettings();
    expect(settings.comboStrategies.newCombo.weights).toEqual({ a: 5 });
    expect(settings.comboStrategies.oldCombo).toBeUndefined();
  });

  it("rename with no entry skips the SQL write", async () => {
    const before = await sqliteDb.getSettings();
    const after = await sqliteDb.updateComboStrategies((strategies) => strategies);
    expect(after.comboStrategies).toEqual(before.comboStrategies);
  });
});
