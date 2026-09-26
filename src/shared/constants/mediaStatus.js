/**
 * Pure status and playground request helpers for Media Providers (YAN-305).
 * No React/DOM dependencies so they are fully testable in Node.
 */

/**
 * Maps connection test status to effective status considering cooldown locks.
 *
 * @param {object} conn Connection object
 * @param {number} [now=Date.now()] Current timestamp in ms
 * @returns {string} Effective status
 */
export function getEffectiveConnectionStatus(conn, now = Date.now()) {
  if (!conn || typeof conn !== "object") return "none";
  const isCooldown = Object.entries(conn).some(
    ([k, v]) => k.startsWith("modelLock_") && v && new Date(v).getTime() > now,
  );
  return conn.testStatus === "unavailable" && !isCooldown ? "active" : conn.testStatus;
}

/**
 * Computes status pill info for a provider card in media providers view.
 * Status rules:
 * 1. isNoAuth: { label: "Ready · no key", variant: "live" }
 * 2. total > 0 && allDisabled: { label: "Disabled", variant: "neutral" }
 * 3. total === 0: { label: "Not connected", variant: "neutral" }
 * 4. error > 0 && connected === 0: { label: "Auth error", variant: "err" }
 * 5. connected > 0: { label: `${connected} connected`, variant: "ok" }
 * 6. other with total > 0: { label: `${total} added`, variant: "neutral" }
 *
 * @param {object} params
 * @param {boolean} [params.isNoAuth=false]
 * @param {Array<object>} [params.connections=[]]
 * @param {number} [params.now=Date.now()]
 * @returns {{ label: string, variant: "ok" | "warn" | "err" | "info" | "brand" | "live" | "neutral" }}
 */
export function getMediaProviderStatus({
  isNoAuth = false,
  connections = [],
  now = Date.now(),
} = {}) {
  if (isNoAuth) {
    return { label: "Ready · no key", variant: "live" };
  }

  const conns = Array.isArray(connections) ? connections : [];
  const total = conns.length;

  if (total === 0) {
    return { label: "Not connected", variant: "neutral" };
  }

  const allDisabled = conns.every((c) => c && c.isActive === false);
  if (allDisabled) {
    return { label: "Disabled", variant: "neutral" };
  }

  const connected = conns.filter((c) => {
    if (!c || c.isActive === false) return false;
    const s = getEffectiveConnectionStatus(c, now);
    return s === "active" || s === "success";
  }).length;

  const error = conns.filter((c) => {
    if (!c || c.isActive === false) return false;
    const s = getEffectiveConnectionStatus(c, now);
    return s === "error" || s === "expired" || s === "unavailable";
  }).length;

  if (connected > 0) {
    return { label: `${connected} connected`, variant: "ok" };
  }

  if (error > 0) {
    return { label: "Auth error", variant: "err" };
  }

  return { label: `${total} added`, variant: "neutral" };
}

/**
 * Builds cURL preview string for media playground requests.
 *
 * @param {object} params
 * @param {string} params.method HTTP method (POST, etc.)
 * @param {string} params.url Full endpoint URL
 * @param {string} [params.apiKey] Bearer API key
 * @param {string} [params.pinnedConnectionId] Optional x-connection-id header
 * @param {object} [params.body] Request payload
 * @param {boolean} [params.isBinary] Whether to append --output flag
 * @param {string} [params.binaryFilename="output.bin"]
 * @returns {string} Formatted cURL command
 */
export function buildPlaygroundCurl({
  method = "POST",
  url = "",
  apiKey = "",
  pinnedConnectionId = "",
  body = {},
  isBinary = false,
  binaryFilename = "output.bin",
} = {}) {
  const parts = [`curl -X ${method} ${url} \\`];
  parts.push('  -H "Content-Type: application/json" \\');
  parts.push(
    `  -H "Authorization: Bearer ${apiKey || "YOUR_KEY"}"${pinnedConnectionId ? " \\" : ""}`,
  );
  if (pinnedConnectionId) {
    parts.push(`  -H "x-connection-id: ${pinnedConnectionId}"`);
  }
  const bodyJson = JSON.stringify(body);
  if (isBinary) {
    parts[parts.length - 1] = `${parts[parts.length - 1]} \\`;
    parts.push(`  -d '${bodyJson}' \\`);
    parts.push(`  --output ${binaryFilename}`);
  } else {
    parts[parts.length - 1] = `${parts[parts.length - 1]} \\`;
    parts.push(`  -d '${bodyJson}'`);
  }
  return parts.join("\n");
}
