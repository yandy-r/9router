import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("next/server", () => ({
  NextResponse: { json: (body, options = {}) => ({ body, status: options.status ?? 200 }) },
}));
vi.mock("@/lib/localDb", () => ({
  getSettings: vi.fn(),
  updateSettings: vi.fn(),
  getCombos: vi.fn(),
  getProviderConnections: vi.fn(),
  updateProviderConnection: vi.fn(),
}));
vi.mock("@/lib/network/outboundProxy", () => ({ applyOutboundProxyEnv: vi.fn() }));
vi.mock("open-sse/services/combo.js", () => ({ resetComboRotation: vi.fn() }));
vi.mock("@/sse/services/auth", () => ({ resetAccountSelection: vi.fn() }));
vi.mock("open-sse/index.js", () => ({}));
vi.mock("@/lib/network/connectionProxy", () => ({ resolveConnectionProxyConfig: vi.fn() }));
vi.mock("@/app/api/usage/[connectionId]/route.js", () => ({
  refreshAndUpdateCredentials: vi.fn(),
}));
vi.mock("open-sse/services/usage.js", () => ({ getUsageForProvider: vi.fn() }));
vi.mock("@/sse/services/quotaSnapshotSync", () => ({
  fetchAndPersistClaudePlanTier: vi.fn(),
  recordUsageSnapshot: vi.fn(),
}));

import { getCombos, getProviderConnections, getSettings, updateSettings } from "@/lib/localDb";
import { resetAccountSelection } from "@/sse/services/auth";
import { PATCH } from "../../src/app/api/settings/route.js";
import {
  weightedProviders,
  isWeightedProvider,
} from "../../src/shared/services/weightedTargets.js";
import {
  configureQuotaSnapshotPoller,
  runQuotaSnapshotTick,
  stopQuotaSnapshotPoller,
} from "../../src/shared/services/quotaSnapshotPoller.js";

const patch = (body) => PATCH({ json: async () => body });

beforeEach(() => {
  vi.clearAllMocks();
  updateSettings.mockImplementation(async (body) => body);
  // Scheduler start runs one real-deps tick; keep it inert.
  getSettings.mockResolvedValue({});
  getCombos.mockResolvedValue([]);
  getProviderConnections.mockResolvedValue([]);
  vi.useFakeTimers();
});
afterEach(() => {
  stopQuotaSnapshotPoller();
  vi.useRealTimers();
});

describe("weighted settings validation", () => {
  it.each([
    { fallbackStrategy: "random" },
    { fallbackStrategy: null },
    { stickyRoundRobinLimit: 0 },
    { stickyRoundRobinLimit: 101 },
    { stickyRoundRobinLimit: "3" },
    { providerStrategies: null },
    { providerStrategies: [] },
    { providerStrategies: { "": {} } },
    { providerStrategies: { "  ": {} } },
    { providerStrategies: { constructor: {} } },
    { providerStrategies: JSON.parse('{"__proto__":{}}') },
    { providerStrategies: { claude: null } },
    { providerStrategies: { claude: { fallbackStrategy: "random" } } },
    { providerStrategies: { claude: { stickyRoundRobinLimit: 1.5 } } },
    { providerStrategies: { " claude ": {} } },
    { providerStrategies: { claude: JSON.parse('{"__proto__":{}}') } },
    null,
    ["weighted"],
    "weighted",
  ])("rejects invalid account settings without persisting: %j", async (body) => {
    const response = await patch(body);
    expect(response.status).toBe(400);
    expect(updateSettings).not.toHaveBeenCalled();
  });

  it("preserves proxy rotation fields and resets selection for valid weighted settings", async () => {
    const body = {
      fallbackStrategy: "weighted",
      stickyRoundRobinLimit: 1,
      providerStrategies: {
        claude: { fallbackStrategy: "weighted", stickyRoundRobinLimit: 100 },
        noauth: { rotateStrategy: "random", proxyPoolId: "pool-1" },
      },
    };
    expect((await patch(body)).status).toBe(200);
    expect(updateSettings).toHaveBeenCalledWith(body);
    await vi.waitFor(() => expect(resetAccountSelection).toHaveBeenCalledOnce());
  });
});

describe("global weighted poller", () => {
  const settings = {
    fallbackStrategy: "weighted",
    providerStrategies: { codex: { fallbackStrategy: "fill-first" } },
  };

  it("resolves active providers, excluding per-provider opt-out but keeping weighted combos", async () => {
    expect([...weightedProviders(settings, [], ["claude", "codex"])]).toEqual(["claude"]);
    const weightedCombo = { ...settings, comboStrategy: "weighted" };
    expect(
      weightedProviders(weightedCombo, [{ name: "mix", models: ["cx/gpt-5"] }], []).has("codex"),
    ).toBe(true);
    expect(
      await isWeightedProvider("claude", {
        getSettings: async () => settings,
        getCombos: async () => [],
      }),
    ).toBe(true);
    expect(
      await isWeightedProvider("codex", {
        getSettings: async () => settings,
        getCombos: async () => [],
      }),
    ).toBe(false);

    const getProviderConnections = vi.fn(async ({ provider }) =>
      provider ? [] : [{ provider: "claude" }, { provider: "codex" }],
    );
    await runQuotaSnapshotTick(
      {
        getSettings: async () => settings,
        getCombos: async () => [],
        getProviderConnections,
      },
      { running: false, failureCache: {} },
    );
    expect(getProviderConnections.mock.calls.map(([filter]) => filter)).toEqual([
      { isActive: true },
      { provider: "claude", isActive: true },
    ]);
  });

  it("starts for global weighted and stops when disabled", () => {
    configureQuotaSnapshotPoller(settings);
    expect(vi.getTimerCount()).toBe(1);
    configureQuotaSnapshotPoller({ fallbackStrategy: "fill-first" });
    expect(vi.getTimerCount()).toBe(0);
  });
});
