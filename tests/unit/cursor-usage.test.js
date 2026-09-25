import { describe, it, expect, vi, beforeEach } from "vitest";

// fetchWithTimeout → proxyAwareFetch; stub it so no network is touched.
vi.mock("../../open-sse/utils/proxyFetch.js", () => ({
  proxyAwareFetch: vi.fn(),
}));

import { proxyAwareFetch } from "../../open-sse/utils/proxyFetch.js";
import {
  cursorPlanTier,
  getCursorUsage,
  parseCursorUsage,
} from "../../open-sse/services/usage/cursor.js";
import { kindForName } from "../../src/sse/services/quotaSnapshotSync.js";

const FIXTURE = {
  billingCycleStart: "1788449503000",
  billingCycleEnd: "1791041503000",
  planUsage: {
    totalSpend: 297695,
    includedSpend: 40000,
    bonusSpend: 257695,
    limit: 40000,
    autoPercentUsed: 96.125,
    apiPercentUsed: 18.638,
    totalPercentUsed: 85.056,
  },
  spendLimitUsage: {
    totalSpend: 9469,
    individualLimit: 10000,
    individualUsed: 9469,
    individualRemaining: 531,
    limitType: "user",
  },
};

const jsonResponse = (status, body) => ({
  ok: status >= 200 && status < 300,
  status,
  json: async () => body,
});

describe("parseCursorUsage", () => {
  it("maps the live-shaped payload to percentage + on-demand rows", () => {
    const result = parseCursorUsage(FIXTURE, { planName: "Ultra" });
    const resetAt = new Date(1791041503000).toISOString();

    // Percentages include bonus spend; spend/limit would clamp to 0 remaining.
    expect(result.quotas.Total.remainingPercentage).toBeCloseTo(14.944, 2);
    expect(result.quotas.Total.resetAt).toBe(resetAt);
    expect(result.quotas["Auto + Composer"]).toMatchObject({ total: 100, resetAt });
    expect(result.quotas.API).toMatchObject({ total: 100, resetAt });
    expect(result.quotas["On-demand"]).toMatchObject({ used: 94.69, total: 100, resetAt });
    expect(result.plan).toBe("Ultra");
    expect("message" in result).toBe(false);
  });

  it("returns empty quotas and no message for an empty payload", () => {
    const result = parseCursorUsage({}, undefined);
    expect(result.quotas).toEqual({});
    expect("message" in result).toBe(false);
  });

  it("falls back to pooled caps for team plans", () => {
    const result = parseCursorUsage(
      { spendLimitUsage: { pooledLimit: 50000, pooledUsed: 10000, limitType: "team" } },
      undefined,
    );
    expect(result.quotas["On-demand"]).toMatchObject({ used: 100, total: 500 });
  });

  it("uses the pooled limit/used pair when individualLimit is omitted", () => {
    const result = parseCursorUsage(
      { spendLimitUsage: { individualUsed: 9469, pooledLimit: 50000, pooledUsed: 10000 } },
      undefined,
    );
    expect(result.quotas["On-demand"]).toMatchObject({ used: 100, total: 500 });
  });
});

describe("cursorPlanTier", () => {
  it.each([
    ["Pro+", "pro_plus"],
    ["Ultra", "ultra"],
    ["Hobby", "free"],
    ["weird", null],
    [undefined, null],
  ])("%s → %s", (name, tier) => {
    expect(cursorPlanTier(name)).toBe(tier);
  });
});

describe("getCursorUsage", () => {
  beforeEach(() => vi.mocked(proxyAwareFetch).mockReset());

  it("reports an expired-auth message on 401", async () => {
    vi.mocked(proxyAwareFetch).mockResolvedValue(jsonResponse(401, {}));
    const result = await getCursorUsage("tok", {}, null);
    expect(result.message).toMatch(/expired/i);
    expect(result.message).toMatch(/401/);
  });

  it("reports the real status in the expired-auth message on 403", async () => {
    vi.mocked(proxyAwareFetch).mockResolvedValue(jsonResponse(403, {}));
    const result = await getCursorUsage("tok", {}, null);
    expect(result.message).toMatch(/expired/i);
    expect(result.message).toMatch(/403/);
  });

  it("combines usage + plan info and sends Connect headers", async () => {
    vi.mocked(proxyAwareFetch).mockImplementation(async (url) =>
      String(url).includes("GetPlanInfo")
        ? jsonResponse(200, { planInfo: { planName: "Pro" } })
        : jsonResponse(200, FIXTURE),
    );

    const result = await getCursorUsage("tok", {}, null);
    expect(result.plan).toBe("Pro");
    expect(Object.keys(result.quotas)).toHaveLength(4);

    const usageCall = vi
      .mocked(proxyAwareFetch)
      .mock.calls.find(([url]) => String(url).endsWith(".DashboardService/GetCurrentPeriodUsage"));
    expect(usageCall).toBeDefined();
    const [, opts] = usageCall;
    expect(opts.method).toBe("POST");
    expect(opts.headers.Authorization).toBe("Bearer tok");
    expect(opts.headers["Connect-Protocol-Version"]).toBe("1");
  });
});

describe("kindForName (cursor)", () => {
  it("maps Total to the monthly window and skips other rows", () => {
    expect(kindForName("cursor", "Total")).toBe("month");
    expect(kindForName("cursor", "API")).toBeNull();
  });
});
