// Cursor auth helpers — PKCE browser login, refresh-token exchange, JWT decode.
//
// Cursor's CLI login (cursor-agent) is a PKCE "deep control" flow:
//   1. Client generates verifier/challenge + a random uuid.
//   2. User opens cursor.com/loginDeepControl?challenge&uuid&mode=login&redirectTarget=cli.
//   3. Client polls api2.cursor.sh/auth/poll?uuid&verifier (404 = pending) until tokens arrive.
// Refresh uses api2.cursor.sh/oauth/token with the public CLI client_id.
//
// Every function here is non-throwing and never echoes tokens, the verifier or URLs.

import crypto from "node:crypto";
import { PROVIDER_OAUTH } from "../providers/index.js";

export const CURSOR_LOGIN_URL = "https://cursor.com/loginDeepControl";
export const CURSOR_POLL_URL = "https://api2.cursor.sh/auth/poll";
export const CURSOR_REFRESH_URL = "https://api2.cursor.sh/oauth/token";
export const CURSOR_REFRESH_CLIENT_ID = "KbZUR41cY7W6zRSdpSUJ7I7mLYBKOCmB";

const REQUEST_TIMEOUT_MS = 15_000;
const MIN_EXPIRES_IN_SEC = 60;

/** Resolve Cursor auth endpoints from the provider registry, with fallbacks. */
function cursorOAuthConfig() {
  const oauth = PROVIDER_OAUTH.cursor || {};
  return {
    loginUrl: oauth.loginUrl || CURSOR_LOGIN_URL,
    pollUrl: oauth.pollUrl || CURSOR_POLL_URL,
    refreshUrl: oauth.refreshUrl || CURSOR_REFRESH_URL,
    refreshClientId: oauth.refreshClientId || CURSOR_REFRESH_CLIENT_ID,
  };
}

/** Build the browser login URL for a PKCE challenge + session uuid. */
export function buildCursorLoginUrl({ challenge, uuid }) {
  const params = new URLSearchParams({ challenge, uuid, mode: "login", redirectTarget: "cli" });
  return `${cursorOAuthConfig().loginUrl}?${params}`;
}

/**
 * Poll Cursor for login completion.
 * @returns {Promise<{status:"pending"}|{status:"success",accessToken:string,refreshToken:string|null}|{status:"denied"|"error",message:string}>}
 */
export async function pollCursorLogin({ uuid, verifier }) {
  const params = new URLSearchParams({ uuid, verifier });
  try {
    const res = await fetch(`${cursorOAuthConfig().pollUrl}?${params}`, {
      method: "GET",
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });
    if (res.status === 404) return { status: "pending" };
    if (res.status === 200) {
      const data = await res.json().catch(() => null);
      if (data?.accessToken) {
        return {
          status: "success",
          accessToken: data.accessToken,
          refreshToken: data.refreshToken || null,
        };
      }
    }
    if (res.status === 403) {
      const text = await res.text().catch(() => "");
      if (text.includes("sign_in_policy_violation")) {
        return {
          status: "denied",
          message: "Cursor organization sign-in policy blocked this device",
        };
      }
    }
    return { status: "error", message: `Cursor login poll failed (${res.status})` };
  } catch {
    return { status: "error", message: "Cursor login poll failed (network error)" };
  }
}

/**
 * Exchange a Cursor refresh token for a new access token.
 * Cursor answers HTTP 200 `{access_token:"", shouldLogout:true}` for dead sessions.
 * @returns {Promise<{ok:true,accessToken:string,idToken:string|null}|{ok:false,dead:boolean,status:number}>}
 */
export async function exchangeCursorRefreshToken(refreshToken) {
  const { refreshUrl, refreshClientId } = cursorOAuthConfig();
  let res;
  try {
    res = await fetch(refreshUrl, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        grant_type: "refresh_token",
        client_id: refreshClientId,
        refresh_token: refreshToken,
      }),
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });
  } catch {
    return { ok: false, dead: false, status: 0 };
  }

  const { status } = res;
  if (status === 401 || status === 403) return { ok: false, dead: true, status };
  if (status !== 200) return { ok: false, dead: false, status };

  const data = await res.json().catch(() => null);
  if (!data) return { ok: false, dead: false, status };
  if (data.shouldLogout === true || !data.access_token) return { ok: false, dead: true, status };
  return { ok: true, accessToken: data.access_token, idToken: data.id_token || null };
}

/** Decode a JWT payload without verifying it. Returns null on any failure. */
export function decodeCursorJwt(token) {
  try {
    const part = String(token || "").split(".")[1];
    if (!part) return null;
    const payload = JSON.parse(Buffer.from(part, "base64url").toString("utf8"));
    return payload && typeof payload === "object" ? payload : null;
  } catch {
    return null;
  }
}

/** Seconds until the JWT `exp` (minimum 60), or `fallbackSec` when unknown. */
export function cursorJwtExpiresIn(token, fallbackSec = 86400) {
  const exp = decodeCursorJwt(token)?.exp;
  if (typeof exp !== "number" || !Number.isFinite(exp)) return fallbackSec;
  return Math.max(MIN_EXPIRES_IN_SEC, Math.floor(exp - Date.now() / 1000));
}

/** Extract `{ email, userId }` from a Cursor access token (fields null when absent). */
export function getCursorTokenIdentity(token) {
  const p = decodeCursorJwt(token);
  return { email: p?.email || p?.sub || null, userId: p?.sub || null };
}

/** Generate a random 64-char hex machine id for a new Cursor connection. */
export function generateCursorMachineId() {
  return crypto.createHash("sha256").update(crypto.randomUUID()).digest("hex");
}
