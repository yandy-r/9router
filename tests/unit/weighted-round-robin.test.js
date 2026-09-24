import { describe, expect, it } from "vitest";

import { pickSmoothWeighted } from "../../open-sse/services/weightedRoundRobin.js";

function pickMany(candidates, count) {
  const picks = [];
  let currentWeights = new Map();

  for (let i = 0; i < count; i++) {
    const result = pickSmoothWeighted(candidates, currentWeights);
    picks.push(result.id);
    currentWeights = result.currentWeights;
  }

  return picks;
}

function counts(picks) {
  return Object.fromEntries(
    [...new Set(picks)].map((id) => [id, picks.filter((pick) => pick === id).length]),
  );
}

describe("pickSmoothWeighted", () => {
  it("smoothly distributes an 18:4:1 cycle", () => {
    const picks = pickMany(
      [
        { id: "A", weight: 18 },
        { id: "B", weight: 4 },
        { id: "C", weight: 1 },
      ],
      23,
    );

    expect(counts(picks)).toEqual({ A: 18, B: 4, C: 1 });
    expect(picks.indexOf("B")).toBeLessThan(22);
    expect(picks.indexOf("C")).toBeLessThan(22);
  });

  it("preserves a 3:1 ratio over many picks", () => {
    const picks = pickMany(
      [
        { id: "A", weight: 3 },
        { id: "B", weight: 1 },
      ],
      1000,
    );

    expect(counts(picks)).toEqual({ A: 750, B: 250 });
  });

  it("excludes invalid weights and duplicate ids", () => {
    const result = pickSmoothWeighted([
      { id: "zero", weight: 0 },
      { id: "negative", weight: -1 },
      { id: "nan", weight: Number.NaN },
      { id: "valid", weight: 2 },
      { id: "valid", weight: 100 },
    ]);

    expect(result.id).toBe("valid");
    expect([...result.currentWeights.keys()]).toEqual(["valid"]);
  });

  it("returns null when all candidates are ineligible", () => {
    const result = pickSmoothWeighted([
      { id: "", weight: 1 },
      { id: "zero", weight: 0 },
    ]);

    expect(result).toEqual({ id: null, currentWeights: new Map() });
  });

  it("does not mutate input state and prunes stale ids", () => {
    const currentWeights = new Map([
      ["A", 5],
      ["stale", 9],
    ]);
    const original = new Map(currentWeights);
    const result = pickSmoothWeighted([{ id: "A", weight: 1 }], currentWeights);

    expect(currentWeights).toEqual(original);
    expect(result.currentWeights.has("stale")).toBe(false);
    expect([...result.currentWeights.keys()]).toEqual(["A"]);
  });

  it("breaks ties by input order", () => {
    const first = pickSmoothWeighted([
      { id: "A", weight: 1 },
      { id: "B", weight: 1 },
    ]);
    const reversed = pickSmoothWeighted([
      { id: "B", weight: 1 },
      { id: "A", weight: 1 },
    ]);

    expect(first.id).toBe("A");
    expect(reversed.id).toBe("B");
  });
});
