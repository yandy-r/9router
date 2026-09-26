import { describe, it, expect } from "vitest";
import {
  headroomStatusLabel,
  savingsShare,
  estimateSavingsCost,
} from "../../src/app/(dashboard)/dashboard/token-saver/tokenSaverUtils.js";

describe("headroomStatusLabel", () => {
  it("maps loading first", () => {
    expect(headroomStatusLabel({ loading: true, running: true })).toBe("Checking…");
  });
  it("maps Running when proxy reachable", () => {
    expect(headroomStatusLabel({ loading: false, running: true })).toBe("Running");
  });
  it("maps Not installed for local URL without install", () => {
    expect(
      headroomStatusLabel({ loading: false, running: false, localUrl: true, installed: false }),
    ).toBe("Not installed");
  });
  it("maps Stopped for local URL with install", () => {
    expect(
      headroomStatusLabel({ loading: false, running: false, localUrl: true, installed: true }),
    ).toBe("Stopped");
  });
  it("maps External for remote URL", () => {
    expect(
      headroomStatusLabel({ loading: false, running: false, localUrl: false, installed: true }),
    ).toBe("External");
  });
});

describe("savingsShare", () => {
  it("splits per-method shares summing to 100", () => {
    const out = savingsShare({
      tokensSavedEst: 1000,
      byMethod: {
        rtk: { tokensSavedEst: 700 },
        headroom: { tokensSavedEst: 200 },
        pxpipe: { tokensSavedEst: 100 },
      },
    });
    expect(out.rtk).toBe(70);
    expect(out.headroom).toBe(20);
    expect(out.pxpipe).toBe(10);
    expect(out.rtk + out.headroom + out.pxpipe).toBe(100);
  });
  it("largest-remainder rounds shares to sum 100", () => {
    const out = savingsShare({
      tokensSavedEst: 1000,
      byMethod: {
        rtk: { tokensSavedEst: 333 },
        headroom: { tokensSavedEst: 333 },
        pxpipe: { tokensSavedEst: 334 },
      },
    });
    expect(Object.values(out).reduce((sum, share) => sum + share, 0)).toBe(100);
  });
  it("returns empty shares when nothing saved", () => {
    expect(savingsShare({ tokensSavedEst: 0, byMethod: {} })).toEqual({});
    expect(savingsShare(null)).toEqual({});
  });
});

describe("estimateSavingsCost", () => {
  const pricing = { input: 3.0, output: 15.0 };
  it("values saved tokens at blended list rates (no hardcoded prices)", () => {
    expect(estimateSavingsCost(1_000_000, pricing)).toBeCloseTo(9.0, 6);
  });
  it("returns 0 for missing inputs", () => {
    expect(estimateSavingsCost(0, pricing)).toBe(0);
    expect(estimateSavingsCost(100, null)).toBe(0);
    expect(estimateSavingsCost(100, {})).toBe(0);
  });
});
