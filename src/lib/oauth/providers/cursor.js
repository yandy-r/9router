import crypto from "node:crypto";
import {
  buildCursorLoginUrl,
  cursorJwtExpiresIn,
  generateCursorMachineId,
  getCursorTokenIdentity,
  pollCursorLogin,
} from "open-sse/shared/cursorAuth.js";
import { CURSOR_CONFIG } from "../constants/oauth.js";

const cursor = {
  config: CURSOR_CONFIG,
  flowType: "device_code",
  // Cursor's CLI login is a PKCE "deep control" flow: the user opens
  // cursor.com/loginDeepControl with our challenge + a random uuid, and we
  // poll api2.cursor.sh/auth/poll with uuid + verifier until tokens arrive.
  // The generic device-code route supplies the PKCE pair:
  //   device_code  = uuid          (modal forwards as deviceCode on poll)
  //   codeVerifier = PKCE verifier (route forwards on poll)
  requestDeviceCode: async (config, codeChallenge) => {
    if (!codeChallenge) {
      throw new Error("Cursor login requires a PKCE challenge");
    }
    const uuid = crypto.randomUUID();
    return {
      device_code: uuid,
      user_code: null,
      verification_uri: config.loginUrl,
      verification_uri_complete: buildCursorLoginUrl({ challenge: codeChallenge, uuid }),
      expires_in: 600,
      interval: 2,
    };
  },
  pollToken: async (_config, deviceCode, codeVerifier) => {
    if (!deviceCode || !codeVerifier) {
      return {
        ok: false,
        data: { error: "invalid_request", error_description: "Missing uuid/verifier" },
      };
    }
    const result = await pollCursorLogin({ uuid: deviceCode, verifier: codeVerifier });
    if (result.status === "pending") {
      return { ok: false, data: { error: "authorization_pending" } };
    }
    if (result.status === "success") {
      return {
        ok: true,
        data: {
          access_token: result.accessToken,
          refresh_token: result.refreshToken,
          expires_in: cursorJwtExpiresIn(result.accessToken),
        },
      };
    }
    if (result.status === "denied") {
      return {
        ok: false,
        data: { error: "access_denied", error_description: result.message },
      };
    }
    // Terminal: the login session is dead, so the modal must stop polling.
    if (result.status === "expired") {
      return {
        ok: false,
        data: { error: "expired_token", error_description: result.message },
      };
    }
    // Transient (429/5xx/network): the modal keeps polling.
    return {
      ok: false,
      data: { error: "poll_failed", error_description: result.message },
    };
  },
  mapTokens: (tokens) => {
    // Email falls back to the JWT `sub`, same as the import route, so a
    // browser re-login dedups onto an imported row for the same account.
    const identity = getCursorTokenIdentity(tokens.access_token);
    return {
      accessToken: tokens.access_token,
      // A Cursor session JWT is itself a valid refresh_token.
      refreshToken: tokens.refresh_token || tokens.access_token,
      expiresIn: tokens.expires_in,
      email: identity.email,
      providerSpecificData: {
        machineId: generateCursorMachineId(),
        authMethod: "browser",
        userId: identity.userId,
      },
    };
  },
};

export default cursor;
