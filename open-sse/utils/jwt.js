// Unverified JWT helpers. Signature is NOT checked — use only for reading
// claims (exp, sub, email) from tokens we already trust by provenance.

/**
 * Decode a JWT payload (base64url) without verifying it.
 * @param {unknown} token
 * @returns {Record<string, unknown>|null} the payload object, or null on any failure (never throws)
 */
export function decodeJwtPayload(token) {
  try {
    const part = String(token || "").split(".")[1];
    if (!part) return null;
    const payload = JSON.parse(Buffer.from(part, "base64url").toString("utf8"));
    return payload && typeof payload === "object" ? payload : null;
  } catch {
    return null;
  }
}
