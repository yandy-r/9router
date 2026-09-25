// Cursor PKCE browser login, token refresh, refresh dispatch, and auth error mapping.
import { afterEach, describe, expect, it, vi } from "vitest";

import { CursorExecutor, classifyCursorError } from "../../open-sse/executors/cursor.js";
import { refreshTokenByProvider } from "../../open-sse/services/tokenRefresh.js";
import { refreshCursorToken } from "../../open-sse/services/tokenRefresh/cursor.js";
import cursorOAuth from "../../src/lib/oauth/providers/cursor.js";

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

  it("maps Connect unauthenticated/permission_denied to 401/403", () => {
    expect(classifyCursorError({ error: { code: "unauthenticated", message: "x" } }).status).toBe(
      401,
    );
    expect(classifyCursorError({ error: { code: "permission_denied", message: "x" } }).status).toBe(
      403,
    );
  });
});
