import { describe, expect, it } from "vitest";
import {
  LEGACY_PILL_VARIANTS,
  PILL_SIZES,
  PILL_VARIANTS,
  meterVariant,
  meterValue,
  pillClasses,
  resolvePillVariant,
  statusVariant,
  TERMINAL_LEVELS,
  terminalLevelClass,
} from "../../src/shared/components/displayPrimitives.js";
import { PROVIDER_BRANDS } from "../../src/shared/constants/providerBrands.js";
import { contrastRatio } from "../../src/shared/utils/contrast.js";

describe("Signal meter", () => {
  it.each([
    [0, "err"],
    [20, "err"],
    [21, "warn"],
    [45, "warn"],
    [46, "ok"],
    [100, "ok"],
  ])("maps %i percent to %s", (value, variant) => {
    expect(meterVariant(value)).toBe(variant);
    expect(meterValue(value)).toBe(value);
  });
  it("uses dedicated unlimited and credit fills", () => {
    expect(meterVariant(0, "unlimited")).toBe("live");
    expect(meterVariant(0, "credits")).toBe("info");
  });
  it("clamps display values and rejects invalid input", () => {
    expect(meterValue(-10)).toBe(0);
    expect(meterValue(120)).toBe(100);
    expect(() => meterVariant(Number.NaN)).toThrow();
    expect(() => meterVariant(30, "unknown")).toThrow();
  });
});

describe("Signal status", () => {
  it.each([
    ["connected", "ok"],
    ["healthy", "ok"],
    ["active", "ok"],
    ["cooldown", "warn"],
    ["warning", "warn"],
    ["low", "warn"],
    ["error", "err"],
    ["empty", "err"],
    ["oauth", "info"],
    ["api-key", "brand"],
    ["live", "live"],
    ["disabled", "neutral"],
  ])("maps %s to %s", (status, variant) => {
    expect(statusVariant(status)).toBe(variant);
  });
  it("rejects unknown status", () => expect(() => statusVariant("unknown")).toThrow());
});

describe("provider monogram colors", () => {
  it("keeps white text >= 4.5:1 for every registry brand", () => {
    expect(Object.keys(PROVIDER_BRANDS).length).toBeGreaterThan(40);
    for (const [id, brand] of Object.entries(PROVIDER_BRANDS)) {
      expect(brand.monogram, id).toBeTruthy();
      expect(contrastRatio("#ffffff", brand.color), id).toBeGreaterThanOrEqual(4.5);
    }
  });
});

describe("pill variant normalization", () => {
  it.each(Object.entries(LEGACY_PILL_VARIANTS))("maps legacy %s to %s", (legacy, signal) => {
    expect(resolvePillVariant(legacy)).toBe(signal);
    expect(pillClasses(legacy, "md")).toBe(pillClasses(signal, "md"));
  });

  it("resolves status words the same way as statusVariant", () => {
    for (const status of ["connected", "cooldown", "empty", "oauth", "api-key", "disabled"]) {
      expect(resolvePillVariant(status)).toBe(statusVariant(status));
      expect(pillClasses(status)).toContain(PILL_VARIANTS[statusVariant(status)]);
    }
  });

  it("keeps legacy xs at the compact pill height", () => {
    expect(PILL_SIZES.xs).toBe(PILL_SIZES.sm);
    expect(pillClasses("success", "xs")).toBe(`${PILL_VARIANTS.ok} ${PILL_SIZES.sm}`);
  });

  it("rejects unknown variants and sizes", () => {
    expect(() => resolvePillVariant("enterprise")).toThrow('unknown variant "enterprise"');
    expect(() => pillClasses("ok", "xl")).toThrow('unknown size "xl"');
  });
});

describe("terminal level classes", () => {
  it("maps every level to a fixed-light .signal-terminal-* class", () => {
    for (const level of ["LOG", "INFO", "WARN", "ERROR", "DEBUG"]) {
      expect(terminalLevelClass(level)).toBe(`signal-terminal-${level.toLowerCase()}`);
    }
    expect(Object.keys(TERMINAL_LEVELS)).toHaveLength(5);
  });
  it("rejects unknown levels", () => expect(() => terminalLevelClass("TRACE")).toThrow());
});
