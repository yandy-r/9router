// Cursor PKCE browser login, token refresh, refresh dispatch, and auth error mapping.
import { afterEach, describe, expect, it, vi } from "vitest";

import { CursorExecutor, classifyCursorError } from "../../open-sse/executors/cursor.js";
import { refreshTokenByProvider } from "../../open-sse/services/tokenRefresh.js";
import {
  cursorRefreshSource,
  refreshCursorToken,
} from "../../open-sse/services/tokenRefresh/cursor.js";
import cursorOAuth from "../../src/lib/oauth/providers/cursor.js";
import { CursorService } from "../../src/lib/oauth/services/cursor.js";

// cursorAuth routes through proxyAwareFetch, which captures the real fetch at import
// (and DNS-bypasses api2.cursor.sh). Delegate to the per-test global fetch stub instead.
vi.mock("../../open-sse/utils/proxyFetch.js", async (importOriginal) => ({
  ...(await importOriginal()),
  proxyAwareFetch: (url, options) => globalThis.fetch(url, options),
}));

const json = (body, status = 200) => new Response(JSON.stringify(body), { status });
const fakeJwt = (payload) => `h.${Buffer.from(JSON.stringify(payload)).toString("base64url")}.s`;
const SIXTY_DAYS = 60 * 24 * 3600;
const nowSec = () => Math.floor(Date.now() / 1000);

afterEach(() => vi.unstubAllGlobals());

describe("cursor oauth provider", () => {
  it("requestDeviceCode builds the loginDeepControl URL with challenge + uuid", async () => {
    const res = await cursorOAuth.requestDeviceCode(cursorOAuth.config, "chal");
    const url = new URL(res.verification_uri_complete);
    expect(`${url.origin}${url.pathname}`).toBe("https://cursor.com/loginDeepControl");
    expect(url.searchParams.get("challenge")).toBe("chal");
    expect(url.searchParams.get("uuid")).toBe(res.device_code);
    expect(url.searchParams.get("mode")).toBe("login");
    expect(url.searchParams.get("redirectTarget")).toBe("cli");
    expect(res.user_code).toBeNull();
  });

  it("pollToken maps 404 to authorization_pending and hits /auth/poll with uuid + verifier", async () => {
    const fetchMock = vi.fn(async () => new Response("", { status: 404 }));
    vi.stubGlobal("fetch", fetchMock);
    const out = await cursorOAuth.pollToken(cursorOAuth.config, "uuid-1", "verifier-1");
    expect(out).toEqual({ ok: false, data: { error: "authorization_pending" } });
    const url = new URL(fetchMock.mock.calls[0][0]);
    expect(`${url.origin}${url.pathname}`).toBe("https://api2.cursor.sh/auth/poll");
    expect(url.searchParams.get("uuid")).toBe("uuid-1");
    expect(url.searchParams.get("verifier")).toBe("verifier-1");
  });

  it("pollToken returns tokens with JWT-derived expires_in on 200", async () => {
    const access = fakeJwt({ sub: "github|user_1", exp: nowSec() + SIXTY_DAYS });
    const refresh = fakeJwt({ sub: "github|user_1", exp: nowSec() + SIXTY_DAYS * 2 });
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => json({ accessToken: access, refreshToken: refresh })),
    );
    const out = await cursorOAuth.pollToken(cursorOAuth.config, "uuid-2", "verifier-2");
    expect(out.ok).toBe(true);
    expect(out.data.access_token).toBe(access);
    expect(out.data.refresh_token).toBe(refresh);
    expect(Math.abs(out.data.expires_in - SIXTY_DAYS)).toBeLessThanOrEqual(5);
  });

  it("pollToken maps a 403 sign_in_policy_violation to access_denied", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => json({ error: "sign_in_policy_violation" }, 403)),
    );
    const out = await cursorOAuth.pollToken(cursorOAuth.config, "uuid-3", "verifier-3");
    expect(out.ok).toBe(false);
    expect(out.data.error).toBe("access_denied");
  });

  it("pollToken maps a dead session (410 or tokenless 200) to terminal expired_token", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response("", { status: 410 })),
    );
    const gone = await cursorOAuth.pollToken(cursorOAuth.config, "uuid-4", "verifier-4");
    expect(gone.ok).toBe(false);
    expect(gone.data.error).toBe("expired_token");
    expect(gone.data.error_description).toMatch(/expired or was rejected/);

    vi.stubGlobal(
      "fetch",
      vi.fn(async () => json({})),
    );
    const empty = await cursorOAuth.pollToken(cursorOAuth.config, "uuid-5", "verifier-5");
    expect(empty.data.error).toBe("expired_token");
  });

  it("pollToken maps 503, 429 and network errors to transient poll_failed", async () => {
    for (const status of [503, 429]) {
      vi.stubGlobal(
        "fetch",
        vi.fn(async () => new Response("", { status })),
      );
      const out = await cursorOAuth.pollToken(cursorOAuth.config, "uuid-6", "verifier-6");
      expect(out.data.error).toBe("poll_failed");
    }
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => {
        throw new TypeError("fetch failed");
      }),
    );
    const out = await cursorOAuth.pollToken(cursorOAuth.config, "uuid-7", "verifier-7");
    expect(out.data.error).toBe("poll_failed");
  });

  it("mapTokens derives identity, a hex machineId, and falls back refreshToken to access", () => {
    const access = fakeJwt({ sub: "github|user_1" });
    const out = cursorOAuth.mapTokens({ access_token: access, expires_in: 100 });
    expect(out.email).toBe("github|user_1");
    expect(out.refreshToken).toBe(access);
    expect(out.expiresIn).toBe(100);
    expect(out.providerSpecificData.machineId).toMatch(/^[0-9a-f]{64}$/);
    expect(out.providerSpecificData.authMethod).toBe("browser");
  });
});

describe("CursorService.validateImportToken", () => {
  const machineId = "a".repeat(64);

  it("falls back refreshToken to the access token and derives expiresIn from the JWT", async () => {
    const access = fakeJwt({
      sub: "github|user_1",
      exp: nowSec() + SIXTY_DAYS,
      pad: "x".repeat(40),
    });
    const out = await new CursorService().validateImportToken(access, machineId);
    expect(out.refreshToken).toBe(access);
    expect(Math.abs(out.expiresIn - SIXTY_DAYS)).toBeLessThanOrEqual(5);
    expect(out.authMethod).toBe("imported");
  });

  it("keeps an explicit refresh token", async () => {
    const access = fakeJwt({ sub: "u", exp: nowSec() + 3600, pad: "x".repeat(40) });
    const out = await new CursorService().validateImportToken(access, machineId, "rt-explicit");
    expect(out.refreshToken).toBe("rt-explicit");
  });
});

describe("refreshCursorToken", () => {
  it("exchanges the refresh token and stores the new JWT in both slots", async () => {
    const jwt = fakeJwt({ sub: "u", exp: nowSec() + 3600 });
    const fetchMock = vi.fn(async () =>
      json({ access_token: jwt, id_token: jwt, shouldLogout: false }),
    );
    vi.stubGlobal("fetch", fetchMock);
    const out = await refreshCursorToken("rt-success", null);
    expect(out.accessToken).toBe(jwt);
    expect(out.refreshToken).toBe(jwt);
    expect(out.expiresIn).toBeGreaterThan(0);
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe("https://api2.cursor.sh/oauth/token");
    expect(init.method).toBe("POST");
    expect(JSON.parse(init.body)).toEqual({
      grant_type: "refresh_token",
      client_id: "KbZUR41cY7W6zRSdpSUJ7I7mLYBKOCmB",
      refresh_token: "rt-success",
    });
  });

  it("treats a 200 shouldLogout response as invalid_grant", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => json({ access_token: "", shouldLogout: true })),
    );
    expect(await refreshCursorToken("rt-logout", null)).toEqual({ error: "invalid_grant" });
  });

  it("treats 401 as invalid_grant and 500 as transient (null)", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => json({}, 401)),
    );
    expect(await refreshCursorToken("rt-401", null)).toEqual({ error: "invalid_grant" });
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => json({}, 500)),
    );
    expect(await refreshCursorToken("rt-500", null)).toBeNull();
  });

  it("refreshTokenByProvider dispatches cursor to the Cursor refresher", async () => {
    const jwt = fakeJwt({ sub: "u", exp: nowSec() + 3600 });
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => json({ access_token: jwt, shouldLogout: false })),
    );
    const out = await refreshTokenByProvider("cursor", { refreshToken: "rt-dispatch" }, null);
    expect(out.accessToken).toBe(jwt);
  });
});

describe("cursor executor auth", () => {
  it("can refresh with either a refresh or access token", () => {
    const ex = new CursorExecutor();
    expect(ex.canRefreshCredentials({ refreshToken: "r" })).toBe(true);
    expect(ex.canRefreshCredentials({ accessToken: "a" })).toBe(true);
    expect(ex.canRefreshCredentials({})).toBe(false);
  });

  it("maps Connect unauthenticated to 401 and keeps permission_denied request-scoped", () => {
    expect(classifyCursorError({ error: { code: "unauthenticated", message: "x" } }).status).toBe(
      401,
    );
    const denied = classifyCursorError({ error: { code: "permission_denied", message: "x" } });
    expect(denied.status).toBe(400);
    expect(denied.code).toBe("permission_denied");
  });

  it("refreshCredentials falls back to the access token as refresh_token", async () => {
    const access = fakeJwt({ sub: "u", exp: nowSec() + 3600, n: "exec-fallback" });
    const fresh = fakeJwt({ sub: "u", exp: nowSec() + SIXTY_DAYS });
    const fetchMock = vi.fn(async () => json({ access_token: fresh, shouldLogout: false }));
    vi.stubGlobal("fetch", fetchMock);
    const out = await new CursorExecutor().refreshCredentials(
      { accessToken: access, refreshToken: null },
      null,
    );
    expect(out.accessToken).toBe(fresh);
    expect(out.refreshToken).toBe(fresh);
    expect(JSON.parse(fetchMock.mock.calls[0][1].body).refresh_token).toBe(access);
  });

  it("refreshCredentials prefers a stored refresh token over the access token", async () => {
    const fresh = fakeJwt({ sub: "u", exp: nowSec() + 3600 });
    const fetchMock = vi.fn(async () => json({ access_token: fresh, shouldLogout: false }));
    vi.stubGlobal("fetch", fetchMock);
    await new CursorExecutor().refreshCredentials(
      { accessToken: "at-ignored", refreshToken: "rt-exec-preferred" },
      null,
    );
    expect(JSON.parse(fetchMock.mock.calls[0][1].body).refresh_token).toBe("rt-exec-preferred");
  });
});

describe("cursorRefreshSource", () => {
  it("prefers refreshToken, falls back to accessToken, else null", () => {
    expect(cursorRefreshSource({ refreshToken: "r", accessToken: "a" })).toBe("r");
    expect(cursorRefreshSource({ refreshToken: null, accessToken: "a" })).toBe("a");
    expect(cursorRefreshSource({})).toBeNull();
    expect(cursorRefreshSource(null)).toBeNull();
  });
});
