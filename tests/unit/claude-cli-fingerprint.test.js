/**
 * Unit tests for the Claude Code client fingerprint (open-sse/config/claudeCliFingerprint.js)
 *
 * Tests cover:
 *  - defaults match the captured Claude Code 2.1.280 request
 *  - CLAUDE_CLI_* env overrides flow into User-Agent, Stainless headers, betas, billing header
 *  - malformed env overrides fail fast at module load
 *  - the fast-mode beta is sent only when the request opts in with speed:"fast"
 *  - x-claude-code-session-id is emitted from metadata.user_id and stripped for third-party hosts
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

const ENV_KEYS = ["CLAUDE_CLI_VERSION", "CLAUDE_CLI_SDK_VERSION", "CLAUDE_CLI_RUNTIME_VERSION", "CLAUDE_CLI_BETA_FLAGS"];
const SESSION = "11111111-2222-4333-8444-555555555555";
const USER_ID = JSON.stringify({ device_id: "d".repeat(64), account_uuid: "", session_id: SESSION });

let savedEnv;
beforeEach(() => {
  savedEnv = Object.fromEntries(ENV_KEYS.map((k) => [k, process.env[k]]));
  for (const k of ENV_KEYS) delete process.env[k];
  vi.resetModules();
});
afterEach(() => {
  for (const k of ENV_KEYS) {
    if (savedEnv[k] === undefined) delete process.env[k];
    else process.env[k] = savedEnv[k];
  }
});

const loadShared = () => import("open-sse/providers/shared.js");

describe("Claude CLI fingerprint defaults", () => {
  it("matches the captured Claude Code 2.1.280 identity", async () => {
    const { CLAUDE_CLI_SPOOF_HEADERS: h } = await loadShared();
    expect(h["User-Agent"]).toBe("claude-cli/2.1.280 (external, sdk-cli)");
    expect(h["X-Stainless-Package-Version"]).toBe("0.112.1");
    expect(h["X-Stainless-Runtime-Version"]).toBe("v26.3.0");
  });

  it("does not send headers the real client never sends", async () => {
    const { CLAUDE_CLI_SPOOF_HEADERS: h } = await loadShared();
    expect(h).not.toHaveProperty("X-Stainless-Helper-Method");
    expect(h["Anthropic-Beta"].split(",")).not.toContain("token-efficient-tools-2026-03-28");
  });

  it("includes the betas Claude Code sends on every request", async () => {
    const { selectAnthropicBeta } = await loadShared();
    const flags = selectAnthropicBeta("claude-haiku-4-5-20251001").split(",");
    for (const f of ["thinking-token-count-2026-05-13", "mid-conversation-system-2026-04-07", "extended-cache-ttl-2025-04-11"]) {
      expect(flags).toContain(f);
    }
  });

  it("sends the fast-mode beta only for speed:\"fast\" requests, once", async () => {
    const { CLAUDE_CLI_SPOOF_HEADERS: h, selectAnthropicBeta, ANTHROPIC_BETA_FAST_MODE } = await loadShared();
    expect(h["Anthropic-Beta"].split(",")).not.toContain(ANTHROPIC_BETA_FAST_MODE);
    expect(selectAnthropicBeta("claude-opus-5").split(",")).not.toContain(ANTHROPIC_BETA_FAST_MODE);
    const flags = selectAnthropicBeta("claude-opus-5", { speed: "fast" }).split(",");
    expect(flags.filter((f) => f === ANTHROPIC_BETA_FAST_MODE)).toHaveLength(1);
  });

  it("keeps the registry entry pinned to a MacOS/arm64 host", async () => {
    const { default: claude } = await import("open-sse/providers/registry/claude.js");
    expect(claude.transport.headers["X-Stainless-Os"]).toBe("MacOS");
    expect(claude.transport.headers["X-Stainless-Arch"]).toBe("arm64");
  });
});

describe("Claude CLI fingerprint env overrides", () => {
  it("applies CLAUDE_CLI_VERSION / SDK / runtime overrides everywhere", async () => {
    process.env.CLAUDE_CLI_VERSION = "2.2.0";
    process.env.CLAUDE_CLI_SDK_VERSION = "0.120.0";
    process.env.CLAUDE_CLI_RUNTIME_VERSION = "v26.4.1";
    const { CLAUDE_CLI_SPOOF_HEADERS: h } = await loadShared();
    const { default: claude } = await import("open-sse/providers/registry/claude.js");
    const { applyCloaking } = await import("open-sse/utils/claudeCloaking.js");

    expect(h["User-Agent"]).toBe("claude-cli/2.2.0 (external, sdk-cli)");
    expect(claude.transport.headers["User-Agent"]).toBe("claude-cli/2.2.0 (external, sdk-cli)");
    expect(h["X-Stainless-Package-Version"]).toBe("0.120.0");
    expect(h["X-Stainless-Runtime-Version"]).toBe("v26.4.1");
    const body = applyCloaking({ messages: [] }, "sk-ant-oat-test", SESSION);
    expect(body.system[0].text).toMatch(/^x-anthropic-billing-header: cc_version=2\.2\.0\.[0-9a-f]{3};/);
  });

  it("replaces the beta base list with CLAUDE_CLI_BETA_FLAGS", async () => {
    process.env.CLAUDE_CLI_BETA_FLAGS = " claude-code-20250219 , oauth-2025-04-20 ";
    const { selectAnthropicBeta } = await loadShared();
    expect(selectAnthropicBeta("claude-haiku-4-5-20251001")).toBe("claude-code-20250219,oauth-2025-04-20");
    expect(selectAnthropicBeta("claude-opus-5")).toBe(
      "claude-code-20250219,oauth-2025-04-20,advanced-tool-use-2025-11-20,effort-2025-11-24",
    );
  });

  it("sends a fast-mode flag listed in CLAUDE_CLI_BETA_FLAGS only for speed:\"fast\", once", async () => {
    process.env.CLAUDE_CLI_BETA_FLAGS = "claude-code-20250219,fast-mode-2026-02-01";
    const { selectAnthropicBeta, CLAUDE_CLI_SPOOF_HEADERS } = await loadShared();
    expect(CLAUDE_CLI_SPOOF_HEADERS["Anthropic-Beta"]).not.toContain("fast-mode-2026-02-01");
    expect(selectAnthropicBeta("claude-haiku-4-5-20251001")).toBe("claude-code-20250219");
    expect(selectAnthropicBeta("claude-haiku-4-5-20251001", { speed: "fast" })).toBe("claude-code-20250219,fast-mode-2026-02-01");
  });

  it.each([
    ["CLAUDE_CLI_VERSION", "2.1"],
    ["CLAUDE_CLI_VERSION", "v2.1.280"],
    ["CLAUDE_CLI_SDK_VERSION", "latest"],
    ["CLAUDE_CLI_RUNTIME_VERSION", "26.3.0"],
    ["CLAUDE_CLI_BETA_FLAGS", "claude-code-20250219,not a flag"],
    ["CLAUDE_CLI_BETA_FLAGS", " , "],
  ])("fails fast on malformed %s=%j", async (key, value) => {
    process.env[key] = value;
    await expect(loadShared()).rejects.toThrow(new RegExp(`Invalid ${key}`));
  });

  it("ignores empty overrides and keeps defaults", async () => {
    process.env.CLAUDE_CLI_VERSION = "   ";
    const { CLAUDE_CLI_VERSION } = await loadShared();
    expect(CLAUDE_CLI_VERSION).toBe("2.1.280");
  });
});

describe("x-claude-code-session-id header", () => {
  const build = async (provider, body, credentials = { accessToken: "sk-ant-oat-x" }) => {
    const { DefaultExecutor } = await import("open-sse/executors/default.js");
    return new DefaultExecutor(provider).buildHeaders(credentials, true, undefined, "claude-sonnet-5", body);
  };

  it("mirrors metadata.user_id session_id for the claude provider", async () => {
    const headers = await build("claude", { metadata: { user_id: USER_ID } });
    expect(headers["x-claude-code-session-id"]).toBe(SESSION);
  });

  it("is omitted when the body carries no session", async () => {
    const headers = await build("claude", { metadata: { user_id: "plain-user" } });
    expect(headers).not.toHaveProperty("x-claude-code-session-id");
  });

  it("is stripped for non-Anthropic anthropic-compatible hosts", async () => {
    const headers = await build("anthropic-compatible-test", { metadata: { user_id: USER_ID } }, {
      apiKey: "sk-third-party",
      providerSpecificData: { baseUrl: "https://gateway.example.com/v1" },
    });
    expect(headers).not.toHaveProperty("x-claude-code-session-id");
  });
});
