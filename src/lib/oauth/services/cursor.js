import { cursorJwtExpiresIn, getCursorTokenIdentity } from "open-sse/shared/cursorAuth.js";
import { CURSOR_CONFIG } from "../constants/oauth.js";

/**
 * Cursor IDE Import Token Service
 * Imports a session from Cursor IDE's local SQLite database. (Browser PKCE
 * login lives in the device-code provider, src/lib/oauth/providers/cursor.js.)
 *
 * Token Location:
 * - Linux: ~/.config/Cursor/User/globalStorage/state.vscdb
 * - macOS: /Users/<user>/Library/Application Support/Cursor/User/globalStorage/state.vscdb
 * - Windows: %APPDATA%\Cursor\User\globalStorage\state.vscdb
 *
 * Database Keys:
 * - cursorAuth/accessToken: The access token (session JWT; expiry read from `exp`)
 * - cursorAuth/refreshToken: Optional refresh token (the session JWT also works)
 * - storage.serviceMachineId: Machine ID for checksum
 */

export class CursorService {
  constructor() {
    this.config = CURSOR_CONFIG;
  }

  /**
   * Validate and import token from Cursor IDE
   * Note: We skip API validation because Cursor API uses complex protobuf format.
   * Token will be validated when actually used for requests.
   * @param {string} accessToken - Access token from state.vscdb
   * @param {string} machineId - Machine ID from state.vscdb
   * @param {string} [refreshToken] - Optional refresh token from state.vscdb
   */
  async validateImportToken(accessToken, machineId, refreshToken) {
    // Basic validation
    if (!accessToken || typeof accessToken !== "string") {
      throw new Error("Access token is required");
    }

    if (!machineId || typeof machineId !== "string") {
      throw new Error("Machine ID is required");
    }

    // Token format validation (Cursor tokens are typically long strings)
    if (accessToken.length < 50) {
      throw new Error("Invalid token format. Token appears too short.");
    }

    // Machine ID format validation (should be UUID-like)
    const uuidRegex = /^[a-f0-9-]{32,}$/i;
    if (!uuidRegex.test(machineId.replace(/-/g, ""))) {
      throw new Error("Invalid machine ID format. Expected UUID format.");
    }

    // Note: We don't validate against API because Cursor uses complex protobuf.
    // Token will be validated when used for actual requests.

    return {
      accessToken,
      machineId,
      // The session JWT doubles as a refresh token when none was provided.
      refreshToken: (typeof refreshToken === "string" && refreshToken.trim()) || accessToken,
      expiresIn: cursorJwtExpiresIn(accessToken),
      authMethod: "imported",
    };
  }

  /**
   * Extract user info from the token's JWT payload.
   * @returns {{email: string|null, userId: string|null}|null} null when the token carries neither
   */
  extractUserInfo(accessToken) {
    const identity = getCursorTokenIdentity(accessToken);
    if (!identity.email && !identity.userId) return null;
    return identity;
  }

  /**
   * Get token storage path instructions for user
   */
  getTokenStorageInstructions() {
    return {
      title: "How to get your Cursor token",
      steps: [
        "1. Open Cursor IDE and make sure you're logged in",
        "2. Find the state.vscdb file:",
        `   - Linux: ${this.config.tokenStoragePaths.linux}`,
        `   - macOS: ${this.config.tokenStoragePaths.macos}`,
        `   - Windows: ${this.config.tokenStoragePaths.windows}`,
        "3. Open the database with SQLite browser or CLI:",
        "   sqlite3 state.vscdb \"SELECT value FROM itemTable WHERE key='cursorAuth/accessToken'\"",
        "4. Also get the machine ID:",
        "   sqlite3 state.vscdb \"SELECT value FROM itemTable WHERE key='storage.serviceMachineId'\"",
        "5. Optionally get the refresh token (enables automatic token refresh):",
        "   sqlite3 state.vscdb \"SELECT value FROM itemTable WHERE key='cursorAuth/refreshToken'\"",
        "6. Paste the values in the form below",
      ],
      alternativeMethod: [
        "Or use this one-liner to get both values:",
        "sqlite3 state.vscdb \"SELECT key, value FROM itemTable WHERE key IN ('cursorAuth/accessToken', 'cursorAuth/refreshToken', 'storage.serviceMachineId')\"",
      ],
    };
  }
}
