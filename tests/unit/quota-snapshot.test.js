import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { QUOTA_SNAPSHOT } from "../../open-sse/config/quotaSnapshot.js";
import { ingestResponseHeaders, parseQuotaHeaders } from "../../open-sse/services/quotaHeaders.js";
import {
  clearQuotaSnapshots,
  computeEffectiveWeight,
  getHeadroom,
  getProviderHeadroom,
  getSnapshot,
  normalizeUsedFraction,
  parseResetMs,
  recordHeaderWindows,
  recordProbeWindows,
  sanitizedWindowKind,
  sanitizePlanTier,
} from "../../open-sse/services/quotaSnapshot.js";

const NOW = Date.UTC(2026, 8, 24, 18, 0, 0);
const NOW_SEC = NOW / 1000;
const HOUR = 3_600_000;
const DAY = 86_400_000;

beforeEach(() => {
  clearQuotaSnapshots();
  vi.useFakeTimers();
  vi.setSystemTime(NOW);
});

afterEach(() => {
  vi.useRealTimers();
  clearQuotaSnapshots();
});

const byKind = (windows) => Object.fromEntries(windows.map((w) => [w.kind, w]));

describe("normalizeUsedFraction", () => {
  it("normalizes all four scales", () => {
    expect(normalizeUsedFraction(0.3, "used01")).toBeCloseTo(0.3);
    expect(normalizeUsedFraction(30, "used100")).toBeCloseTo(0.3);
    expect(normalizeUsedFraction(0.25, "remaining01")).toBeCloseTo(0.75);
    expect(normalizeUsedFraction(25, "remaining100")).toBeCloseTo(0.75);
    expect(normalizeUsedFraction("40", "used100")).toBeCloseTo(0.4);
  });

  it("returns null for non-finite input or unknown scale", () => {
    for (const raw of [Number.NaN, Infinity, -Infinity, "abc", "", "  ", null, undefined, {}]) {
      expect(normalizeUsedFraction(raw, "used01")).toBeNull();
    }
    expect(normalizeUsedFraction(0.5, "bogus")).toBeNull();
  });

  it("clamps to [0, 1]", () => {
    expect(normalizeUsedFraction(1.5, "used01")).toBe(1);
    expect(normalizeUsedFraction(-0.2, "used01")).toBe(0);
    expect(normalizeUsedFraction(150, "used100")).toBe(1);
    expect(normalizeUsedFraction(-1, "remaining01")).toBe(1);
    expect(normalizeUsedFraction(200, "remaining100")).toBe(0);
  });
});

describe("parseResetMs", () => {
  it("parses epoch seconds/ms numbers and numeric strings", () => {
    expect(parseResetMs(NOW_SEC + 3600, NOW)).toBe(NOW + HOUR);
    expect(parseResetMs(NOW + HOUR, NOW)).toBe(NOW + HOUR);
    expect(parseResetMs(String(NOW_SEC + 3600), NOW)).toBe(NOW + HOUR);
    expect(parseResetMs(String(NOW + HOUR), NOW)).toBe(NOW + HOUR);
  });

  it("parses ISO strings", () => {
    const iso = new Date(NOW + HOUR).toISOString();
    expect(parseResetMs(iso, NOW)).toBe(NOW + HOUR);
  });

  it("returns 0 outside [now-1d, now+400d]", () => {
    expect(parseResetMs(NOW + 401 * DAY, NOW)).toBe(0);
    expect(parseResetMs(NOW - 2 * DAY, NOW)).toBe(0);
    expect(parseResetMs(NOW - HOUR, NOW)).toBe(NOW - HOUR);
  });

  it("returns null for duration strings", () => {
    expect(parseResetMs("6m0s", NOW)).toBeNull();
    expect(parseResetMs("2m59.56s", NOW)).toBeNull();
    expect(parseResetMs("7.66s", NOW)).toBeNull();
  });

  it("returns 0 for empty/unknown input", () => {
    expect(parseResetMs("", NOW)).toBe(0);
    expect(parseResetMs(null, NOW)).toBe(0);
    expect(parseResetMs(undefined, NOW)).toBe(0);
    expect(parseResetMs(Number.NaN, NOW)).toBe(0);
    expect(parseResetMs("not a date", NOW)).toBe(0);
    expect(parseResetMs({}, NOW)).toBe(0);
  });
});

describe("sanitizedWindowKind", () => {
  it("allowlists global kinds, lowercased", () => {
    for (const kind of [
      "5h",
      "7d",
      "day",
      "month",
      "requests",
      "tokens",
      "input-tokens",
      "output-tokens",
    ]) {
      expect(sanitizedWindowKind(kind)).toBe(kind);
    }
    expect(sanitizedWindowKind(" 5H ")).toBe("5h");
    expect(sanitizedWindowKind("hourly")).toBeNull();
    expect(sanitizedWindowKind("")).toBeNull();
    expect(sanitizedWindowKind(42)).toBeNull();
    expect(sanitizedWindowKind(null)).toBeNull();
  });

  it("preserves model ids after the model: prefix", () => {
    expect(sanitizedWindowKind("model:Claude Opus 4.1")).toBe("model:Claude Opus 4.1");
    expect(sanitizedWindowKind("MODEL:gemini-2.5-pro")).toBe("model:gemini-2.5-pro");
    expect(sanitizedWindowKind("model:")).toBeNull();
    expect(sanitizedWindowKind("model:   ")).toBeNull();
  });

  it("rejects prototype keys", () => {
    for (const key of ["__proto__", "constructor", "prototype"]) {
      expect(sanitizedWindowKind(key)).toBeNull();
      expect(sanitizedWindowKind(`model:${key}`)).toBeNull();
    }
    expect(sanitizedWindowKind("model:Constructor")).toBeNull();
  });

  it("caps length at 128", () => {
    const ok = `model:${"a".repeat(122)}`;
    expect(ok).toHaveLength(128);
    expect(sanitizedWindowKind(ok)).toBe(ok);
    expect(sanitizedWindowKind(`model:${"a".repeat(123)}`)).toBeNull();
  });
});

describe("sanitizePlanTier", () => {
  it("lowercases and trims", () => {
    expect(sanitizePlanTier(" Default_Claude_Max_20x ")).toBe("default_claude_max_20x");
  });

  it("rejects prototype keys, empty, non-string, over 64 chars", () => {
    for (const key of ["__proto__", "constructor", "Prototype"]) {
      expect(sanitizePlanTier(key)).toBeNull();
    }
    expect(sanitizePlanTier("")).toBeNull();
    expect(sanitizePlanTier("   ")).toBeNull();
    expect(sanitizePlanTier(5)).toBeNull();
    expect(sanitizePlanTier(null)).toBeNull();
    expect(sanitizePlanTier("a".repeat(64))).toBe("a".repeat(64));
    expect(sanitizePlanTier("a".repeat(65))).toBeNull();
  });
});

describe("snapshot store", () => {
  it("round-trips header windows", () => {
    recordHeaderWindows(
      "c1",
      "Claude",
      [{ kind: "5h", usedFraction: 0.2, resetsAt: NOW + HOUR }],
      NOW,
    );
    expect(getSnapshot("c1", NOW)).toEqual({
      provider: "claude",
      windows: [
        { kind: "5h", usedFraction: 0.2, resetsAt: NOW + HOUR, observedAt: NOW, source: "header" },
      ],
      planTier: null,
      updatedAt: NOW,
    });
  });

  it("records probe windows with a sanitized plan tier", () => {
    recordProbeWindows(
      "c1",
      "claude",
      [{ kind: "7d", usedFraction: 0.5 }],
      { planTier: " Pro " },
      NOW,
    );
    const snap = getSnapshot("c1", NOW);
    expect(snap.planTier).toBe("pro");
    expect(snap.windows[0]).toMatchObject({ kind: "7d", source: "probe", resetsAt: 0 });
  });

  it("drops invalid windows and ignores invalid ids", () => {
    recordHeaderWindows(
      "c1",
      "claude",
      [
        { kind: "bogus", usedFraction: 0.1 },
        { kind: "5h", usedFraction: "abc" },
        null,
        { kind: "7d", usedFraction: 0.4 },
      ],
      NOW,
    );
    expect(getSnapshot("c1", NOW).windows.map((w) => w.kind)).toEqual(["7d"]);
    expect(recordHeaderWindows("", "claude", [{ kind: "5h", usedFraction: 0.1 }], NOW)).toBeNull();
    expect(recordHeaderWindows("c2", "", [{ kind: "5h", usedFraction: 0.1 }], NOW)).toBeNull();
  });

  it("expires windows at resetsAt", () => {
    recordHeaderWindows(
      "c1",
      "claude",
      [{ kind: "5h", usedFraction: 0.2, resetsAt: NOW + 30 * 60_000 }],
      NOW,
    );
    expect(getSnapshot("c1", NOW + 30 * 60_000 - 1).windows).toHaveLength(1);
    // Window expired, snapshot kept until its TTL.
    expect(getSnapshot("c1", NOW + 30 * 60_000).windows).toEqual([]);
    expect(getSnapshot("c1", NOW + QUOTA_SNAPSHOT.snapshotTtlMs)).toBeNull();
  });

  it("drops empty snapshots after TTL", () => {
    recordHeaderWindows("c1", "claude", [{ kind: "requests", usedFraction: 0.2 }], NOW);
    expect(getSnapshot("c1", NOW + QUOTA_SNAPSHOT.snapshotTtlMs - 1).windows).toHaveLength(1);
    expect(getSnapshot("c1", NOW + QUOTA_SNAPSHOT.snapshotTtlMs)).toBeNull();
    expect(getSnapshot("c1", NOW)).toBeNull();
  });

  it("keeps the newest observedAt on same-kind merge", () => {
    recordHeaderWindows("c1", "claude", [{ kind: "5h", usedFraction: 0.2, observedAt: NOW }], NOW);
    recordHeaderWindows(
      "c1",
      "claude",
      [{ kind: "5h", usedFraction: 0.5, observedAt: NOW - 1000 }],
      NOW,
    );
    expect(getSnapshot("c1", NOW).windows[0].usedFraction).toBe(0.2);
    recordHeaderWindows(
      "c1",
      "claude",
      [{ kind: "5h", usedFraction: 0.7, observedAt: NOW + 1000 }],
      NOW + 1000,
    );
    const snap = getSnapshot("c1", NOW + 1000);
    expect(snap.windows).toHaveLength(1);
    expect(snap.windows[0].usedFraction).toBe(0.7);
  });

  it("caps windows per connection", () => {
    const windows = Array.from({ length: 40 }, (_, i) => ({
      kind: `model:m${i}`,
      usedFraction: 0.1,
    }));
    recordHeaderWindows("c1", "claude", windows, NOW);
    expect(getSnapshot("c1", NOW).windows).toHaveLength(QUOTA_SNAPSHOT.maxWindowsPerConnection);
  });

  it("evicts the oldest connection past maxConnections", () => {
    const max = QUOTA_SNAPSHOT.maxConnections;
    for (let i = 0; i < max; i++) {
      recordHeaderWindows(`c${i}`, "claude", [{ kind: "5h", usedFraction: 0.1 }], NOW + i);
    }
    // Updating an existing id when full does not evict.
    recordHeaderWindows("c0", "claude", [{ kind: "5h", usedFraction: 0.2 }], NOW + max);
    expect(getSnapshot("c1", NOW + max)).not.toBeNull();
    recordHeaderWindows("new", "claude", [{ kind: "5h", usedFraction: 0.1 }], NOW + max + 1);
    expect(getSnapshot("c1", NOW + max + 1)).toBeNull();
    expect(getSnapshot("c0", NOW + max + 1)).not.toBeNull();
    expect(getSnapshot("new", NOW + max + 1)).not.toBeNull();
  });

  it("dedupes model kinds case-insensitively, keeping incoming display case", () => {
    recordHeaderWindows("c1", "codex", [{ kind: "model:GPT-5-Mini", usedFraction: 0.2 }], NOW);
    recordHeaderWindows(
      "c1",
      "codex",
      [{ kind: "model:gpt-5-mini", usedFraction: 0.6 }],
      NOW + 1000,
    );
    const { windows } = getSnapshot("c1", NOW + 1000);
    expect(windows).toHaveLength(1);
    expect(windows[0]).toMatchObject({ kind: "model:gpt-5-mini", usedFraction: 0.6 });
  });

  it("clears stale snapshots before evicting live ones", () => {
    const max = QUOTA_SNAPSHOT.maxConnections;
    const ttl = QUOTA_SNAPSHOT.snapshotTtlMs;
    const reset = NOW - ttl - HOUR;
    recordHeaderWindows(
      "stale",
      "claude",
      [{ kind: "5h", usedFraction: 0.1, resetsAt: reset }],
      NOW - ttl,
    );
    for (let i = 0; i < max - 1; i++) {
      recordHeaderWindows(`c${i}`, "claude", [{ kind: "5h", usedFraction: 0.1 }], NOW - HOUR + i);
    }
    recordHeaderWindows("new", "claude", [{ kind: "5h", usedFraction: 0.1 }], NOW);
    expect(getSnapshot("stale", NOW)).toBeNull();
    expect(getSnapshot("c1", NOW)).not.toBeNull();
    expect(getSnapshot("new", NOW)).not.toBeNull();
  });

  it("returns copies", () => {
    const recorded = recordHeaderWindows("c1", "claude", [{ kind: "5h", usedFraction: 0.2 }], NOW);
    recorded.windows[0].usedFraction = 0.9;
    const snap = getSnapshot("c1", NOW);
    snap.windows[0].usedFraction = 0.99;
    snap.windows.push({ kind: "7d", usedFraction: 1 });
    snap.planTier = "hacked";
    expect(getSnapshot("c1", NOW)).toMatchObject({
      planTier: null,
      windows: [{ kind: "5h", usedFraction: 0.2 }],
    });
    expect(getSnapshot("c1", NOW).windows).toHaveLength(1);
  });

  it("clearQuotaSnapshots empties the store", () => {
    recordHeaderWindows("c1", "claude", [{ kind: "5h", usedFraction: 0.2 }], NOW);
    clearQuotaSnapshots();
    expect(getSnapshot("c1", NOW)).toBeNull();
  });
});

describe("getHeadroom", () => {
  const snapshot = {
    windows: [
      { kind: "5h", usedFraction: 0.2, source: "header" },
      { kind: "7d", usedFraction: 0.6, source: "probe" },
      { kind: "model:claude-opus-4", usedFraction: 0.9, source: "header" },
    ],
  };

  it("binds on the minimum global window", () => {
    const result = getHeadroom("claude", snapshot);
    expect(result.headroom).toBeCloseTo(0.4);
    expect(result.source).toBe("probe");
  });

  it("applies model windows only on match", () => {
    expect(getHeadroom("claude", snapshot, "claude-opus-4").headroom).toBeCloseTo(0.1);
    expect(getHeadroom("claude", snapshot, "Claude-Opus-4-20250514").headroom).toBeCloseTo(0.1);
    // Request model shorter than the window id no longer matches (token boundary).
    expect(getHeadroom("claude", snapshot, "opus").headroom).toBeCloseTo(0.4);
    expect(getHeadroom("claude", snapshot, "gpt-5").headroom).toBeCloseTo(0.4);
  });

  it("matches model windows on contiguous token boundaries", () => {
    const headroom = (kind, model) =>
      getHeadroom(
        "x",
        { windows: [{ kind: `model:${kind}`, usedFraction: 0.9, source: "header" }] },
        model,
      ).headroom;
    expect(headroom("opus", "claude-opus-5")).toBeCloseTo(0.1);
    expect(headroom("gemini", "gemini-3-pro")).toBeCloseTo(0.1);
    expect(headroom("claude-opus-4-6-thinking", "claude-opus-4-6-thinking")).toBeCloseTo(0.1);
    expect(headroom("gemini-3-pro", "pro")).toBe(1);
    expect(headroom("pro", "prolite")).toBe(1);
  });

  it("always applies global kinds", () => {
    const snap = { windows: [{ kind: "requests", usedFraction: 0.75, source: "header" }] };
    expect(getHeadroom("openai", snap, "gpt-5").headroom).toBeCloseTo(0.25);
    expect(getHeadroom("openai", snap).headroom).toBeCloseTo(0.25);
  });

  it("returns static headroom 1 without a snapshot or applicable window", () => {
    expect(getHeadroom("claude", null)).toMatchObject({ headroom: 1, source: "static" });
    expect(getHeadroom("claude", undefined)).toMatchObject({ headroom: 1, source: "static" });
    expect(getHeadroom("claude", { windows: [] })).toMatchObject({ headroom: 1, source: "static" });
    expect(
      getHeadroom("claude", { windows: [{ kind: "model:x", usedFraction: 0.5 }] }),
    ).toMatchObject({ headroom: 1, source: "static" });
  });
});

describe("getProviderHeadroom", () => {
  it("returns best provider headroom and keeps first connection on ties", () => {
    recordHeaderWindows("c1", "Claude", [{ kind: "5h", usedFraction: 0.8 }], NOW);
    recordHeaderWindows("c2", "claude", [{ kind: "5h", usedFraction: 0.3 }], NOW);
    recordHeaderWindows("c3", "claude", [{ kind: "5h", usedFraction: 0.3 }], NOW);
    expect(getProviderHeadroom(" CLAUDE ", ["c1", "c2", "c3", "c2"], null, NOW)).toEqual({
      headroom: 0.7,
      source: "header",
      connectionId: "c2",
    });
  });

  it("treats an unknown connection as static headroom 1", () => {
    recordHeaderWindows("known", "claude", [{ kind: "5h", usedFraction: 0.2 }], NOW);
    expect(getProviderHeadroom("claude", ["known", "unknown"], null, NOW)).toEqual({
      headroom: 1,
      source: "static",
      connectionId: "unknown",
    });
  });

  it("skips provider mismatches", () => {
    recordHeaderWindows("other", "codex", [{ kind: "5h", usedFraction: 0 }], NOW);
    recordHeaderWindows("match", "claude", [{ kind: "5h", usedFraction: 0.6 }], NOW);
    expect(getProviderHeadroom("claude", ["other", "match"], null, NOW)).toEqual({
      headroom: 0.4,
      source: "header",
      connectionId: "match",
    });
  });

  it("returns static null for empty or invalid lists", () => {
    const fallback = { headroom: 1, source: "static", connectionId: null };
    expect(getProviderHeadroom("claude", [], null, NOW)).toEqual(fallback);
    expect(getProviderHeadroom("claude", [null, 42, ""], null, NOW)).toEqual(fallback);
    expect(getProviderHeadroom("claude", null, null, NOW)).toEqual(fallback);
  });
});

describe("computeEffectiveWeight", () => {
  it("prefers manual over plan over default", () => {
    expect(
      computeEffectiveWeight({
        manualWeight: 3,
        provider: "claude",
        planTier: "default_claude_max_20x",
      }),
    ).toMatchObject({ weight: 3, base: 3, baseSource: "manual" });
    expect(
      computeEffectiveWeight({ provider: "claude", planTier: "Default_Claude_Max_20x" }),
    ).toMatchObject({ weight: 20, base: 20, baseSource: "plan" });
    expect(
      computeEffectiveWeight({
        provider: "claude",
        snapshot: { planTier: "default_claude_max_5x", windows: [] },
      }),
    ).toMatchObject({ base: 5, baseSource: "plan" });
    expect(computeEffectiveWeight({ provider: "claude" })).toMatchObject({
      weight: 1,
      base: 1,
      baseSource: "default",
      headroom: 1,
      headroomSource: "static",
      belowFloor: false,
    });
  });

  it("manual 0 gives weight 0", () => {
    expect(
      computeEffectiveWeight({ manualWeight: 0, provider: "claude", planTier: "pro" }),
    ).toMatchObject({ weight: 0, base: 0, baseSource: "manual", belowFloor: false });
  });

  it("unknown tier or provider falls back to base 1", () => {
    expect(
      computeEffectiveWeight({ provider: "claude", planTier: "enterprise_ultra" }),
    ).toMatchObject({
      base: 1,
      baseSource: "default",
    });
    expect(computeEffectiveWeight({ provider: "nope", planTier: "pro" })).toMatchObject({
      base: 1,
    });
    expect(computeEffectiveWeight({ manualWeight: -2, provider: "nope" })).toMatchObject({
      base: 1,
      baseSource: "default",
    });
  });

  it("multiplies base by min-window headroom", () => {
    const result = computeEffectiveWeight({
      provider: "claude",
      planTier: "default_claude_max_20x",
      snapshot: {
        windows: [
          { kind: "5h", usedFraction: 0.12, source: "header" },
          { kind: "7d", usedFraction: 0.05, source: "header" },
        ],
      },
    });
    expect(result.weight).toBeCloseTo(17.6);
    expect(result.headroom).toBeCloseTo(0.88);
    expect(result.headroomSource).toBe("header");
    expect(result.belowFloor).toBe(false);
  });

  it("drops to 0 below the floor", () => {
    const snapshot = { windows: [{ kind: "5h", usedFraction: 0.97, source: "header" }] };
    expect(computeEffectiveWeight({ provider: "claude", planTier: "pro", snapshot })).toMatchObject(
      {
        weight: 0,
        belowFloor: true,
      },
    );
    expect(
      computeEffectiveWeight({ provider: "claude", planTier: "pro", snapshot, floor: 0.01 }),
    ).toMatchObject({ belowFloor: false });
  });

  it("never throws on garbage input", () => {
    const throwing = new Proxy(
      {},
      {
        get() {
          throw new Error("boom");
        },
      },
    );
    const inputs = [
      undefined,
      null,
      "x",
      42,
      throwing,
      { snapshot: "bad", manualWeight: Number.NaN, provider: 5 },
      { snapshot: { windows: "no" } },
      { snapshot: { windows: [null, 1, { kind: "5h", usedFraction: "abc" }] } },
      { provider: "__proto__", planTier: "constructor" },
      { provider: "claude", planTier: "__proto__" },
    ];
    for (const input of inputs) {
      let result;
      expect(() => {
        result = computeEffectiveWeight(input);
      }).not.toThrow();
      expect(Number.isFinite(result.weight)).toBe(true);
    }
  });
});

describe("parseQuotaHeaders (claude)", () => {
  it("parses 5h/7d utilization with epoch-second resets", () => {
    const windows = parseQuotaHeaders(
      "claude",
      new Headers({
        "anthropic-ratelimit-unified-5h-utilization": "0.25",
        "anthropic-ratelimit-unified-5h-reset": String(NOW_SEC + 3600),
        "anthropic-ratelimit-unified-7d-utilization": "0.6",
        "anthropic-ratelimit-unified-7d-reset": String(NOW_SEC + 3 * 86400),
      }),
      NOW,
    );
    const kinds = byKind(windows);
    expect(kinds["5h"]).toMatchObject({
      usedFraction: 0.25,
      resetsAt: NOW + HOUR,
      source: "header",
    });
    expect(kinds["7d"]).toMatchObject({ usedFraction: 0.6, resetsAt: NOW + 3 * DAY });
    expect(windows).toHaveLength(2);
  });

  it("drops non-finite utilization", () => {
    const windows = parseQuotaHeaders(
      "claude",
      {
        "anthropic-ratelimit-unified-5h-utilization": "abc",
        "anthropic-ratelimit-unified-7d-utilization": "Infinity",
      },
      NOW,
    );
    expect(windows).toEqual([]);
  });

  it("maps 7d_oi to a model window (Headers and plain object)", () => {
    const raw = { "anthropic-ratelimit-unified-7d_oi-utilization": "0.4" };
    expect(parseQuotaHeaders("claude", new Headers(raw), NOW)).toEqual([
      expect.objectContaining({ kind: "model:7d_oi", usedFraction: 0.4 }),
    ]);
    expect(parseQuotaHeaders("claude", raw, NOW)).toEqual([
      expect.objectContaining({ kind: "model:7d_oi", usedFraction: 0.4 }),
    ]);
  });

  it("ignores bare unified-status/reset and representative-claim", () => {
    const raw = {
      "anthropic-ratelimit-unified-status": "allowed",
      "anthropic-ratelimit-unified-reset": String(NOW_SEC + 3600),
      "anthropic-ratelimit-unified-representative-claim": "five_hour",
      "anthropic-ratelimit-unified-status-utilization": "0.5",
      "anthropic-ratelimit-unified-reset-utilization": "0.5",
    };
    expect(parseQuotaHeaders("claude", raw, NOW)).toEqual([]);
    expect(parseQuotaHeaders("claude", new Headers(raw), NOW)).toEqual([]);
  });
});

describe("parseQuotaHeaders (codex)", () => {
  it("classifies by window-minutes, not slot name", () => {
    const windows = parseQuotaHeaders(
      "codex",
      new Headers({
        "x-codex-primary-used-percent": "40",
        "x-codex-primary-window-minutes": "10080",
        "x-codex-primary-reset-at": String(NOW_SEC + 86400),
        "x-codex-secondary-used-percent": "10",
        "x-codex-secondary-window-minutes": "300",
      }),
      NOW,
    );
    const kinds = byKind(windows);
    expect(kinds["7d"]).toMatchObject({ usedFraction: 0.4, resetsAt: NOW + DAY });
    expect(kinds["5h"]).toMatchObject({ usedFraction: 0.1, resetsAt: 0 });
    expect(windows).toHaveLength(2);
  });

  it("classifies missing window-minutes as day", () => {
    expect(parseQuotaHeaders("codex", { "x-codex-primary-used-percent": "50" }, NOW)).toEqual([
      expect.objectContaining({ kind: "day", usedFraction: 0.5 }),
    ]);
  });

  it("labels extra families via x-<id>-limit-name", () => {
    const raw = {
      "x-bengalfox-primary-used-percent": "20",
      "x-bengalfox-primary-window-minutes": "300",
      "x-bengalfox-limit-name": "GPT-5.1-Codex-Mini",
      "x-other-secondary-used-percent": "30",
    };
    for (const headers of [raw, new Headers(raw)]) {
      const kinds = byKind(parseQuotaHeaders("codex", headers, NOW));
      expect(kinds["model:GPT-5.1-Codex-Mini"]).toMatchObject({ usedFraction: 0.2 });
      expect(kinds["model:other"]).toMatchObject({ usedFraction: 0.3 });
    }
  });

  it("merges labeled family slots into one binding window", () => {
    const raw = {
      "x-codex-bengalfox-primary-used-percent": "20",
      "x-codex-bengalfox-primary-window-minutes": "300",
      "x-codex-bengalfox-primary-reset-at": String(NOW_SEC + 3600),
      "x-codex-bengalfox-secondary-used-percent": "80",
      "x-codex-bengalfox-secondary-window-minutes": "10080",
      "x-codex-bengalfox-secondary-reset-at": String(NOW_SEC + 86400),
      "x-codex-bengalfox-limit-name": "gpt-5.2-codex-sonic",
    };
    for (const headers of [raw, new Headers(raw)]) {
      const windows = parseQuotaHeaders("codex", headers, NOW);
      expect(windows).toEqual([
        expect.objectContaining({
          kind: "model:gpt-5.2-codex-sonic",
          usedFraction: 0.8,
          resetsAt: NOW + DAY,
        }),
      ]);
    }
  });

  it("skips a family without used-percent", () => {
    expect(
      parseQuotaHeaders(
        "codex",
        {
          "x-codex-primary-window-minutes": "300",
          "x-codex-primary-reset-at": String(NOW_SEC + 60),
        },
        NOW,
      ),
    ).toEqual([]);
  });

  it("ignores rate-limit-reached-type", () => {
    expect(
      parseQuotaHeaders("codex", { "x-codex-rate-limit-reached-type": "primary" }, NOW),
    ).toEqual([]);
  });
});

describe("parseQuotaHeaders (generic)", () => {
  it("parses OpenAI x-ratelimit requests pair", () => {
    const windows = parseQuotaHeaders(
      "openai",
      new Headers({
        "x-ratelimit-limit-requests": "100",
        "x-ratelimit-remaining-requests": "75",
        "x-ratelimit-reset-requests": "6m0s",
      }),
      NOW,
    );
    expect(windows).toHaveLength(1);
    expect(windows[0]).toMatchObject({
      kind: "requests",
      usedFraction: 0.25,
      resetsAt: NOW + 360_000,
    });
  });

  it("skips pairs with a missing or invalid limit", () => {
    expect(parseQuotaHeaders("groq", { "x-ratelimit-remaining-requests": "75" }, NOW)).toEqual([]);
    expect(
      parseQuotaHeaders(
        "groq",
        { "x-ratelimit-limit-tokens": "0", "x-ratelimit-remaining-tokens": "0" },
        NOW,
      ),
    ).toEqual([]);
    expect(
      parseQuotaHeaders(
        "groq",
        { "x-ratelimit-limit-tokens": "abc", "x-ratelimit-remaining-tokens": "1" },
        NOW,
      ),
    ).toEqual([]);
  });

  it("parses the Anthropic API input-tokens family", () => {
    const reset = new Date(NOW + 60_000).toISOString();
    const windows = parseQuotaHeaders(
      "anthropic",
      {
        "anthropic-ratelimit-input-tokens-limit": "1000",
        "anthropic-ratelimit-input-tokens-remaining": "400",
        "anthropic-ratelimit-input-tokens-reset": reset,
      },
      NOW,
    );
    expect(windows).toEqual([
      expect.objectContaining({ kind: "input-tokens", usedFraction: 0.6, resetsAt: NOW + 60_000 }),
    ]);
  });

  it("returns [] without headers", () => {
    expect(parseQuotaHeaders("openai", null, NOW)).toEqual([]);
    expect(parseQuotaHeaders("openai", undefined, NOW)).toEqual([]);
  });
});

describe("ingestResponseHeaders", () => {
  it("round-trips parsed headers into the store", () => {
    ingestResponseHeaders(
      "claude",
      "conn-1",
      new Headers({
        "anthropic-ratelimit-unified-5h-utilization": "0.3",
        "anthropic-ratelimit-unified-5h-reset": String(NOW_SEC + 3600),
      }),
    );
    expect(getSnapshot("conn-1", NOW)).toMatchObject({
      provider: "claude",
      windows: [
        { kind: "5h", usedFraction: 0.3, resetsAt: NOW + HOUR, observedAt: NOW, source: "header" },
      ],
    });
  });

  it("no-ops without a connectionId", () => {
    const headers = { "x-ratelimit-limit-requests": "10", "x-ratelimit-remaining-requests": "5" };
    for (const id of [undefined, null, ""]) {
      expect(() => ingestResponseHeaders("openai", id, headers)).not.toThrow();
      expect(getSnapshot(id, NOW)).toBeNull();
    }
  });

  it("never throws on hostile headers objects", () => {
    const throwingGet = {
      get() {
        throw new Error("boom");
      },
      forEach() {
        throw new Error("boom");
      },
    };
    const throwingKeys = new Proxy(
      {},
      {
        ownKeys() {
          throw new Error("boom");
        },
      },
    );
    for (const headers of [throwingGet, throwingKeys]) {
      for (const provider of ["claude", "codex", "openai"]) {
        expect(() => ingestResponseHeaders(provider, "conn-x", headers)).not.toThrow();
      }
    }
    expect(getSnapshot("conn-x", NOW)).toBeNull();
  });
});
