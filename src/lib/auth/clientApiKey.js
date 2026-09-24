/**
 * Extract client API key from request headers or query string.
 * Precedence: Bearer (`Authorization: Bearer ...`) -> `x-api-key` ->
 * `x-goog-api-key` -> `key` search param parsed from `request.url`.
 * @param {Request|{headers: Headers, url?: string}} request
 * @returns {string|null} The client API key, or null when none is present.
 */
export function extractClientApiKey(request) {
  const authHeader = request.headers.get("Authorization");
  if (authHeader?.startsWith("Bearer ")) return authHeader.slice(7);
  const apiKeyHeader = request.headers.get("x-api-key");
  if (apiKeyHeader) return apiKeyHeader;
  const googleApiKeyHeader = request.headers.get("x-goog-api-key");
  if (googleApiKeyHeader) return googleApiKeyHeader;
  if (!request.url) return null;
  try {
    return new URL(request.url).searchParams.get("key") || null;
  } catch {
    return null;
  }
}
