import { dedupRefresh } from "./dedup.js";
import { exchangeCursorRefreshToken, cursorJwtExpiresIn } from "../../shared/cursorAuth.js";

/**
 * The token to send as Cursor's refresh_token. Any valid Cursor session JWT
 * (including the access token) is accepted, so legacy rows without a stored
 * refresh token fall back to the access token. Single rule shared by the
 * executor and REFRESH_HANDLERS so the two entry points never diverge.
 * @returns {string|null}
 */
export function cursorRefreshSource(credentials) {
  return credentials?.refreshToken || credentials?.accessToken || null;
}

/**
 * Refresh a Cursor session token.
 *
 * Cursor's /oauth/token (Cursor IDE public OAuth client) returns no new refresh
 * token: the IDE stores the new session JWT in both the access and refresh
 * slots, and any valid session JWT works as a refresh_token. We mirror that
 * behavior.
 *
 * @returns {Promise<{accessToken:string,refreshToken:string,expiresIn:number,idToken:string|null}|{error:"invalid_grant"}|null>}
 */
export async function refreshCursorToken(refreshToken, log, proxyOptions = null) {
  if (!refreshToken) return null;
  return dedupRefresh(
    "cursor",
    refreshToken,
    async () => {
      const r = await exchangeCursorRefreshToken(refreshToken, proxyOptions);
      if (r.ok) {
        log?.info?.("TOKEN_REFRESH", "Successfully refreshed token for cursor");
        return {
          accessToken: r.accessToken,
          refreshToken: r.accessToken,
          expiresIn: cursorJwtExpiresIn(r.accessToken),
          idToken: r.idToken,
        };
      }
      if (r.dead) {
        log?.warn?.("TOKEN_REFRESH", `cursor session rejected (${r.status})`);
        return { error: "invalid_grant" };
      }
      log?.warn?.("TOKEN_REFRESH", `cursor refresh failed (${r.status})`);
      return null;
    },
    log,
  );
}
