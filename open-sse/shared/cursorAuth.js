// Cursor auth helpers — PKCE browser login, refresh-token exchange, JWT expiry/identity.
//
// Cursor's CLI login (cursor-agent) is a PKCE "deep control" flow:
//   1. Client generates verifier/challenge + a random uuid.
//   2. User opens cursor.com/loginDeepControl?challenge&uuid&mode=login&redirectTarget=cli.
//   3. Client polls api2.cursor.sh/auth/poll?uuid&verifier (404 = pending) until tokens arrive.
// Refresh uses api2.cursor.sh/oauth/token with the Cursor IDE public OAuth client.
//
// Endpoints and the client id come from the provider registry (PROVIDER_OAUTH.cursor).
// Network helpers are non-throwing and never echo tokens, the verifier or URLs.

import crypto from "node:crypto";
import { PROVIDER_OAUTH } from "../providers/index.js";
import { decodeJwtPayload } from "../utils/jwt.js";
import { proxyAwareFetch } from "../utils/proxyFetch.js";

const REQUEST_TIMEOUT_MS = 15_000;
const MIN_EXPIRES_IN_SEC = 60;
const REQUIRED_OAUTH_KEYS = ["loginUrl", "pollUrl", "refreshUrl", "refreshClientId"];
const POLL_EXPIRED_MESSAGE = "Cursor login expired or was rejected. Start the login again.";

/**
 * Resolve Cursor auth endpoints from the provider registry.
 * @throws {Error} when a required key is missing — a registry/config bug, not a runtime condition.
 */
function cursorOAuthConfig() {
  const oauth = PROVIDER_OAUTH.cursor;
  const missing = REQUIRED_OAUTH_KEYS.filter((key) => !oauth?.[key]);
  if (missing.length > 0) {
    throw new Error(`Cursor OAuth registry config is missing: ${missing.join(", ")}`);
  }
  const { loginUrl, pollUrl, refreshUrl, refreshClientId } = oauth;
  return { loginUrl, pollUrl, refreshUrl, refreshClientId };
}

/** Build the browser login URL for a PKCE challenge + session uuid. */
export function buildCursorLoginUrl({ challenge, uuid }) {
  const params = new URLSearchParams({ challenge, uuid, mode: "login", redirectTarget: "cli" });
  return `${cursorOAuthConfig().loginUrl}?${params}`;
}

/**
 * Poll Cursor for login completion.
 * - 404 → pending; 200 with accessToken → success
 * - 403 sign_in_policy_violation → denied (terminal)
 * - other 4xx (not 429) or 200 without a token → expired (terminal; uuid is dead)
 * - 429 / 5xx / network → error (transient; keep polling)
 * @param {{uuid:string, verifier:string}} session
 * @param {object|null} [proxyOptions] per-connection proxy settings for proxyAwareFetch
 * @returns {Promise<{status:"pending"}|{status:"success",accessToken:string,refreshToken:string|null}|{status:"denied"|"expired"|"error",message:string}>}
 */
export async function pollCursorLogin({ uuid, verifier }, proxyOptions = null) {
  const { pollUrl } = cursorOAuthConfig();
  const params = new URLSearchParams({ uuid, verifier });
  let res;
  try {
    res = await proxyAwareFetch(
      `${pollUrl}?${params}`,
      { method: "GET", signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS) },
      proxyOptions,
    );
  } catch {
    return { status: "error", message: "Cursor login poll failed (network error)" };
  }

  const { status } = res;
  if (status === 404) return { status: "pending" };
  if (status === 200) {
    const data = await res.json().catch(() => null);
    if (data?.accessToken) {
      return {
        status: "success",
        accessToken: data.accessToken,
        refreshToken: data.refreshToken || null,
      };
    }
    return { status: "expired", message: POLL_EXPIRED_MESSAGE };
  }
  if (status === 403) {
    const text = await res.text().catch(() => "");
    if (text.includes("sign_in_policy_violation")) {
      return {
        status: "denied",
        message: "Cursor organization sign-in policy blocked this device",
      };
    }
  }
  if (status >= 400 && status < 500 && status !== 429) {
    return { status: "expired", message: POLL_EXPIRED_MESSAGE };
  }
  return { status: "error", message: `Cursor login poll failed (${status})` };
}

/**
 * Exchange a Cursor refresh token for a new access token.
 * Cursor answers HTTP 200 `{access_token:"", shouldLogout:true}` for dead sessions.
 * @param {string} refreshToken
 * @param {object|null} [proxyOptions] per-connection proxy settings for proxyAwareFetch
 * @returns {Promise<{ok:true,accessToken:string,idToken:string|null}|{ok:false,dead:boolean,status:number}>}
 */
export async function exchangeCursorRefreshToken(refreshToken, proxyOptions = null) {
  const { refreshUrl, refreshClientId } = cursorOAuthConfig();
  let res;
  try {
    res = await proxyAwareFetch(
      refreshUrl,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          grant_type: "refresh_token",
          client_id: refreshClientId,
          refresh_token: refreshToken,
        }),
        signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
      },
      proxyOptions,
    );
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

/** Seconds until the JWT `exp` (minimum 60), or `fallbackSec` when unknown. */
export function cursorJwtExpiresIn(token, fallbackSec = 86400) {
  const exp = decodeJwtPayload(token)?.exp;
  if (typeof exp !== "number" || !Number.isFinite(exp)) return fallbackSec;
  return Math.max(MIN_EXPIRES_IN_SEC, Math.floor(exp - Date.now() / 1000));
}

/** Extract `{ email, userId }` from a Cursor access token (fields null when absent). */
export function getCursorTokenIdentity(token) {
  const p = decodeJwtPayload(token);
  return { email: p?.email || p?.sub || null, userId: p?.sub || null };
}

/** Generate a random 64-char hex machine id for a new Cursor connection. */
export function generateCursorMachineId() {
  return crypto.createHash("sha256").update(crypto.randomUUID()).digest("hex");
}
