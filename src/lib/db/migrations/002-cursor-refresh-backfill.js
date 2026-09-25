// Backfill legacy Cursor OAuth rows imported before refresh support existed:
// they stored `refreshToken: null` and `expiresAt` = import time + 24h. Any
// valid Cursor session JWT works as a refresh_token, so seed it from the
// access token and derive `expiresAt` from the JWT `exp` claim.
// Idempotent: rows that already carry a refreshToken are left untouched.
import { decodeJwtPayload } from "open-sse/utils/jwt.js";

function backfillCursorData(data) {
  if (!data || typeof data !== "object" || Array.isArray(data)) return null;
  if (data.refreshToken || typeof data.accessToken !== "string" || !data.accessToken) return null;

  const next = { ...data, refreshToken: data.accessToken };
  const exp = decodeJwtPayload(data.accessToken)?.exp;
  if (typeof exp === "number" && Number.isFinite(exp)) {
    next.expiresAt = new Date(exp * 1000).toISOString();
  }
  return next;
}

export default {
  version: 2,
  name: "cursor-refresh-backfill",
  up(db) {
    const rows = db.all(
      `SELECT id, data FROM providerConnections WHERE provider = 'cursor' AND authType = 'oauth'`,
    );
    for (const row of rows) {
      let data;
      try {
        data = JSON.parse(row.data);
      } catch {
        continue; // malformed JSON — leave the row for the repo layer to handle
      }
      const next = backfillCursorData(data);
      if (!next) continue;
      db.run(`UPDATE providerConnections SET data = ? WHERE id = ?`, [
        JSON.stringify(next),
        row.id,
      ]);
    }
  },
};
