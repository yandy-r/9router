import { beforeEach, describe, expect, it, vi } from "vitest";
import { clearQuotaSnapshots, recordProbeWindows } from "open-sse/services/quotaSnapshot.js";

const mocks = vi.hoisted(() => ({ getProviderConnections: vi.fn() }));

vi.mock("next/server", () => ({
  NextResponse: { json: (body, init) => ({ status: init?.status || 200, body }) },
}));
vi.mock("@/models", () => ({
  getProviderConnections: mocks.getProviderConnections,
  getProviderNodes: vi.fn(async () => []),
  createProviderConnection: vi.fn(),
  getProviderNodeById: vi.fn(),
  getProxyPoolById: vi.fn(),
}));

const { GET } = await import("@/app/api/providers/route.js");

describe("GET /api/providers effectiveWeight", () => {
  beforeEach(() => clearQuotaSnapshots());

  it("adds decomposed weight using manual tier/weight and hides credentials", async () => {
    // Snapshot detected pro, but manual tier wins; one has manual weight override.
    recordProbeWindows("a", "claude", [{ kind: "5h", usedFraction: 0.5 }], { planTier: "pro" });
    mocks.getProviderConnections.mockResolvedValue([
      {
        id: "a",
        provider: "claude",
        accessToken: "secret-a",
        refreshToken: "secret-r",
        providerSpecificData: { planTier: "default_claude_max_20x", planTierManual: true },
      },
      { id: "b", provider: "claude", apiKey: "secret-k", providerSpecificData: { weight: 3 } },
      { id: "c", provider: "claude", providerSpecificData: {} },
    ]);

    const { body } = await GET();
    const [a, b, c] = body.connections;

    expect(a.effectiveWeight).toEqual({
      weight: 10,
      base: 20,
      baseSource: "plan",
      headroom: 0.5,
      headroomSource: "probe",
      belowFloor: false,
    });
    expect(b.effectiveWeight).toMatchObject({
      weight: 3,
      baseSource: "manual",
      headroomSource: "static",
    });
    expect(c.effectiveWeight).toMatchObject({ weight: 1, baseSource: "default" });
    expect(JSON.stringify(body)).not.toMatch(/secret-/);
  });
});
