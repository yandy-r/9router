import { dedupRefresh } from "./dedup.js";
import { exchangeCursorRefreshToken, cursorJwtExpiresIn } from "../../shared/cursorAuth.js";

/**
 * Refresh a Cursor session token.
 *
 * Cursor's /oauth/token (IDE client) returns no new refresh token: the IDE
 * stores the new session JWT in both the access and refresh slots, and any
 * valid session JWT works as a refresh_token. We mirror that behavior.
 *
 * @returns {Promise<{accessToken:string,refreshToken:string,expiresIn:number,idToken:string|null}|{error:"invalid_grant"}|null>}
 */
export async function refreshCursorToken(refreshToken, log) {
  if (!refreshToken) return null;
  return dedupRefresh(
    "cursor",
    refreshToken,
    async () => {
      const r = await exchangeCursorRefreshToken(refreshToken);
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
