// Meta Code (Muse Spark): registry routing, subscription-key mint, quota mapping.
import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("../../open-sse/utils/proxyFetch.js", () => ({ proxyAwareFetch: vi.fn() }));

import { proxyAwareFetch } from "../../open-sse/utils/proxyFetch.js";
import { PROVIDERS, PROVIDER_MODELS } from "../../open-sse/providers/index.js";
import { getModelTargetFormat } from "../../open-sse/config/providerModels.js";
import { DefaultExecutor } from "../../open-sse/executors/default.js";
import {
  META_CODE_KEY_URL,
  getMetaCodeUsage,
  mintMetaCodeKey,
  parseMetaSubsUsage,
} from "../../open-sse/services/metaCode.js";

const json = (body, status = 200) => new Response(JSON.stringify(body), { status });
const MINT = {
  api_key: "LLM|1|abc",
  is_subs_active: true,
  subs_tier_name: "Muse Code Everyday",
  subs_usage: {
    window: { used_percent: 12, window_duration_mins: 300, resets_at: 1790275673 },
    weekly: { used_percent: 140, resets_at: 1790553600 },
  },
};

describe("meta-code registry", () => {
  it("routes Muse models over the Responses API with no client id in source", () => {
    const cfg = PROVIDERS["meta-code"];
    expect(cfg.baseUrl).toBe("https://api.meta.ai/v1/responses");
    expect(cfg.format).toBe("openai-responses");
    expect(PROVIDER_MODELS.mc.map((m) => m.id)).toContain("muse-spark-1.3");
    expect(getModelTargetFormat("mc", "muse-spark-1.3")).toBe("openai-responses");
  });

  it("folds chat reasoning_effort into Responses reasoning (Meta 400s on it)", () => {
    const out = new DefaultExecutor("meta-code").transformRequest("muse-spark-1.3", {
      model: "muse-spark-1.3",
      input: [],
      reasoning_effort: "high",
    });
    expect(out.reasoning_effort).toBeUndefined();
    expect(out.reasoning).toEqual({ summary: "auto", effort: "high" });
  });
});

describe("meta-code mint + quota", () => {
  beforeEach(() => vi.mocked(proxyAwareFetch).mockReset());

  it("mints with the dca token as Bearer", async () => {
    vi.mocked(proxyAwareFetch).mockResolvedValue(json(MINT));
    const data = await mintMetaCodeKey("dca:tok");
    const [url, opts] = vi.mocked(proxyAwareFetch).mock.calls[0];
    expect(url).toBe(META_CODE_KEY_URL);
    expect(opts.method).toBe("POST");
    expect(opts.headers.Authorization).toBe("Bearer dca:tok");
    expect(data.api_key).toBe("LLM|1|abc");
  });

  it("throws with status on HTTP failure and on missing key", async () => {
    vi.mocked(proxyAwareFetch).mockResolvedValue(json({ title: "x" }, 401));
    await expect(mintMetaCodeKey("dca:bad")).rejects.toMatchObject({ status: 401 });
    vi.mocked(proxyAwareFetch).mockResolvedValue(json({ api_key: "", action_url: "https://x" }));
    await expect(mintMetaCodeKey("dca:tok")).rejects.toThrow(/https:\/\/x/);
  });

  it("maps 5h + weekly windows to clamped percent quotas", () => {
    const q = parseMetaSubsUsage(MINT.subs_usage);
    expect(q["Session (5h)"]).toMatchObject({ used: 12, total: 100, remainingPercentage: 88 });
    expect(q["Session (5h)"].resetAt).toBe(new Date(1790275673 * 1000).toISOString());
    expect(q.Weekly).toMatchObject({ used: 100, remainingPercentage: 0 });
  });

  it("usage: API-key connections and expired sign-ins return a message", async () => {
    expect((await getMetaCodeUsage(null)).message).toMatch(/sign-in/);
    vi.mocked(proxyAwareFetch).mockResolvedValue(json({}, 401));
    expect((await getMetaCodeUsage("dca:old")).message).toMatch(/re-authorize/);
    vi.mocked(proxyAwareFetch).mockResolvedValue(json(MINT));
    const ok = await getMetaCodeUsage("dca:tok");
    expect(ok.plan).toBe("Muse Code Everyday");
    expect(Object.keys(ok.quotas)).toEqual(["Session (5h)", "Weekly"]);
  });
});
