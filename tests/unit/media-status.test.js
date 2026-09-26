import { describe, it, expect } from "vitest";
import { getMediaProviderStatus, buildPlaygroundCurl } from "@/shared/constants/mediaStatus.js";

describe("getMediaProviderStatus", () => {
  it("returns Ready · no key for noAuth providers", () => {
    expect(getMediaProviderStatus({ isNoAuth: true, connections: [] })).toEqual({
      label: "Ready · no key",
      variant: "live",
    });
  });

  it("returns Not connected when no connections", () => {
    expect(getMediaProviderStatus({ connections: [] })).toEqual({
      label: "Not connected",
      variant: "neutral",
    });
  });

  it("returns Disabled when all connections disabled", () => {
    expect(
      getMediaProviderStatus({
        connections: [
          { provider: "x", isActive: false, testStatus: "active" },
          { provider: "x", isActive: false, testStatus: "active" },
        ],
      }),
    ).toEqual({ label: "Disabled", variant: "neutral" });
  });

  it("returns N connected when active connections exist", () => {
    expect(
      getMediaProviderStatus({
        connections: [
          { provider: "x", isActive: true, testStatus: "active" },
          { provider: "x", isActive: true, testStatus: "success" },
          { provider: "x", isActive: true, testStatus: "error" },
        ],
      }),
    ).toEqual({ label: "2 connected", variant: "ok" });
  });

  it("returns Auth error when errors exist and none connected", () => {
    expect(
      getMediaProviderStatus({
        connections: [{ provider: "x", isActive: true, testStatus: "error" }],
      }),
    ).toEqual({ label: "Auth error", variant: "err" });
  });

  it("treats expired/unavailable as error", () => {
    expect(
      getMediaProviderStatus({
        connections: [{ provider: "x", isActive: true, testStatus: "expired" }],
      }),
    ).toEqual({ label: "Auth error", variant: "err" });
  });

  it("returns added when no connected and no error", () => {
    expect(
      getMediaProviderStatus({
        connections: [{ provider: "x", isActive: true, testStatus: "pending" }],
      }),
    ).toEqual({ label: "1 added", variant: "neutral" });
  });

  it("treats unavailable without cooldown as active", () => {
    const now = Date.now();
    expect(
      getMediaProviderStatus({
        now,
        connections: [{ provider: "x", isActive: true, testStatus: "unavailable" }],
      }),
    ).toEqual({ label: "1 connected", variant: "ok" });
  });

  it("treats unavailable with active modelLock as error", () => {
    const now = Date.now();
    expect(
      getMediaProviderStatus({
        now,
        connections: [
          {
            provider: "x",
            isActive: true,
            testStatus: "unavailable",
            modelLock_foo: new Date(now + 60_000).toISOString(),
          },
        ],
      }),
    ).toEqual({ label: "Auth error", variant: "err" });
  });
});

describe("buildPlaygroundCurl", () => {
  it("builds basic cURL with masked key default", () => {
    const curl = buildPlaygroundCurl({
      method: "POST",
      url: "http://localhost/v1/embeddings",
      body: { model: "x/y", input: "hi" },
    });
    expect(curl).toContain("curl -X POST http://localhost/v1/embeddings");
    expect(curl).toContain("Bearer YOUR_KEY");
    expect(curl).toContain(`-d '{"model":"x/y","input":"hi"}'`);
  });

  it("includes API key and connection id", () => {
    const curl = buildPlaygroundCurl({
      method: "POST",
      url: "http://x/v1",
      apiKey: "sk-abc",
      pinnedConnectionId: "conn-1",
      body: {},
    });
    expect(curl).toContain("Bearer sk-abc");
    expect(curl).toContain("x-connection-id: conn-1");
  });

  it("appends --output for binary", () => {
    const curl = buildPlaygroundCurl({
      method: "POST",
      url: "http://x/v1/images/generations",
      body: {},
      isBinary: true,
      binaryFilename: "image.png",
    });
    expect(curl).toContain("--output image.png");
  });
});
