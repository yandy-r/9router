/**
 * Passive quota header parsers (YAN-259 phase 1).
 *
 * Pure functions: upstream response headers → normalized quota windows.
 * All parsers are fail-open — malformed or missing headers yield no window,
 * never a throw. Storage/normalization lives in `./quotaSnapshot.js`.
 */

import {
  normalizeUsedFraction,
  parseResetMs,
  recordHeaderWindows,
  sanitizedWindowKind,
} from "./quotaSnapshot.js";
import { parseDurationToMs } from "./usage/shared.js";

/**
 * Read one header value case-insensitively.
 * @param {Headers|Record<string, unknown>|null|undefined} headers
 * @param {string} name
 * @returns {string|null} raw string value, or null when absent
 */
export function getHeader(headers, name) {
  try {
    if (!headers) return null;
    if (typeof headers.get === "function") {
      const value = headers.get(name);
      return value === null || value === undefined ? null : String(value);
    }
    if (typeof headers === "object") {
      const wanted = String(name).toLowerCase();
      for (const key of Object.keys(headers)) {
        if (typeof key === "string" && key.toLowerCase() === wanted) {
          const value = headers[key];
          return value === null || value === undefined ? null : String(value);
        }
      }
    }
    return null;
  } catch {
    return null;
  }
}

/**
 * Finite-number coercion with empty-string rejection.
 * @param {unknown} value
 * @returns {number|null}
 */
function toFiniteOrNull(value) {
  if (value === null || value === undefined) return null;
  if (typeof value === "string" && !value.trim()) return null;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

/**
 * Validated timestamp base for window observations.
 * @param {unknown} nowMs
 * @returns {number}
 */
function validNow(nowMs) {
  return Number.isFinite(nowMs) ? nowMs : Date.now();
}

/**
 * Claude unified claims to parse. Real Headers instances cannot be enumerated
 * reliably, so only the known claims are tried; plain objects are scanned for
 * extra `...-utilization` claims (e.g. `7d_oi` or future model scopes).
 * @param {Headers|Record<string, unknown>|null|undefined} headers
 * @returns {string[]}
 */
function collectClaudeClaims(headers) {
  const base = ["5h", "7d"];
  try {
    if (headers && typeof headers.get === "function") return [...base, "7d_oi"];
    if (!headers || typeof headers !== "object") return base;
    const prefix = "anthropic-ratelimit-unified-";
    const suffix = "-utilization";
    const claims = [...base];
    for (const key of Object.keys(headers)) {
      if (typeof key !== "string") continue;
      const lower = key.toLowerCase();
      if (!lower.startsWith(prefix) || !lower.endsWith(suffix)) continue;
      const claim = lower.slice(prefix.length, lower.length - suffix.length);
      if (!claim || claim === "status" || claim === "reset") continue;
      if (!claims.includes(claim)) claims.push(claim);
    }
    return claims;
  } catch {
    return base;
  }
}

/**
 * Parse Claude OAuth unified headers (`anthropic-ratelimit-unified-*`).
 * Utilization is 0–1 used; reset is epoch seconds. `status`/`reset` claims and
 * `-representative-claim` suffixes never become windows.
 * @param {Headers|Record<string, unknown>|null|undefined} headers
 * @param {number} [nowMs]
 * @returns {Array<object>} header-source windows
 */
export function parseClaudeHeaders(headers, nowMs = Date.now()) {
  const windows = [];
  const now = validNow(nowMs);
  for (const claim of collectClaudeClaims(headers)) {
    // Bare `...unified-status` / `...unified-reset` repeat the 5h values.
    if (claim === "status" || claim === "reset") continue;
    const used = toFiniteOrNull(
      getHeader(headers, `anthropic-ratelimit-unified-${claim}-utilization`),
    );
    if (used === null) continue;
    const usedFraction = normalizeUsedFraction(used, "used01");
    if (usedFraction === null) continue;
    const kind = claim === "5h" ? "5h" : claim === "7d" ? "7d" : `model:${claim}`;
    const sanitized = sanitizedWindowKind(kind);
    if (!sanitized) continue;
    windows.push({
      kind: sanitized,
      usedFraction,
      resetsAt: parseResetMs(getHeader(headers, `anthropic-ratelimit-unified-${claim}-reset`), now),
      observedAt: now,
      source: "header",
    });
  }
  return windows;
}

/**
 * Collect generic Codex metered families (`x-<id>-<primary|secondary>-*`).
 * @param {Headers|Record<string, unknown>|null|undefined} headers
 * @returns {Array<{id: string, slot: string}>}
 */
function collectCodexFamilies(headers) {
  const families = [];
  const seen = new Set();
  const pattern = /^x-(.+)-(primary|secondary)-used-percent$/;
  const consider = (name) => {
    if (typeof name !== "string") return;
    const match = pattern.exec(name.toLowerCase());
    if (!match || match[1] === "codex") return;
    const key = `${match[1]}/${match[2]}`;
    if (seen.has(key)) return;
    seen.add(key);
    families.push({ id: match[1], slot: match[2] });
  };
  try {
    if (headers && typeof headers.forEach === "function") {
      headers.forEach((_, name) => {
        consider(name);
      });
    } else if (headers && typeof headers === "object") {
      for (const key of Object.keys(headers)) consider(key);
    }
  } catch {
    // fail-open: default family already parsed
  }
  return families;
}

/**
 * Build one Codex window from a `<prefix>-<slot>-*` header family.
 * @param {Headers|Record<string, unknown>|null|undefined} headers
 * @param {string} prefix lowercased header prefix (e.g. `x-codex`)
 * @param {string|null} modelLabel sub-model label, or null for the default family
 * @param {string} slot `primary` or `secondary`
 * @param {number} now
 * @returns {object|null}
 */
function buildCodexWindow(headers, prefix, modelLabel, slot, now) {
  const used = toFiniteOrNull(getHeader(headers, `${prefix}-${slot}-used-percent`));
  if (used === null) return null;
  const usedFraction = normalizeUsedFraction(used, "used100");
  if (usedFraction === null) return null;
  const minutes = toFiniteOrNull(getHeader(headers, `${prefix}-${slot}-window-minutes`));
  let kind;
  if (modelLabel) {
    kind = `model:${modelLabel}`;
  } else {
    // Classify by window length, never by slot name: Pro reports its weekly
    // window as "primary".
    kind = !Number.isFinite(minutes)
      ? "day"
      : minutes <= 300
        ? "5h"
        : minutes >= 6000
          ? "7d"
          : "day";
  }
  const sanitized = sanitizedWindowKind(kind);
  if (!sanitized) return null;
  return {
    kind: sanitized,
    usedFraction,
    resetsAt: parseResetMs(getHeader(headers, `${prefix}-${slot}-reset-at`), now),
    observedAt: now,
    source: "header",
  };
}

/**
 * Parse Codex response headers: default `x-codex-*` family plus generic
 * `x-<id>-*` metered families with `x-<id>-limit-name` model labels.
 * `used-percent` is 0–100; `reset-at` is epoch seconds.
 * @param {Headers|Record<string, unknown>|null|undefined} headers
 * @param {number} [nowMs]
 * @returns {Array<object>} header-source windows
 */
export function parseCodexHeaders(headers, nowMs = Date.now()) {
  const windows = [];
  const now = validNow(nowMs);
  // NOTE: `x-codex-rate-limit-reached-type` names the exhausted bucket but
  // carries no utilization or window length, so it cannot map to a Window.
  // Read nothing from it — the per-slot families below hold the real data.
  for (const slot of ["primary", "secondary"]) {
    const window = buildCodexWindow(headers, "x-codex", null, slot, now);
    if (window) windows.push(window);
  }
  // Labeled families map both slots to one `model:<label>` kind (a length
  // suffix would break getHeadroom's model token matching). Headroom is the
  // min over windows, so only the binding slot matters: merge slots into one
  // window with max usedFraction and the later resetsAt, instead of letting
  // the store keep whichever slot merged last.
  const labeled = new Map();
  for (const { id, slot } of collectCodexFamilies(headers)) {
    const limitName = getHeader(headers, `x-${id}-limit-name`);
    const label = limitName?.trim() ? limitName.trim() : id;
    const window = buildCodexWindow(headers, `x-${id}`, label, slot, now);
    if (!window) continue;
    const key = window.kind.toLowerCase();
    const prev = labeled.get(key);
    labeled.set(
      key,
      prev
        ? {
            ...prev,
            usedFraction: Math.max(prev.usedFraction, window.usedFraction),
            resetsAt: Math.max(prev.resetsAt, window.resetsAt),
          }
        : window,
    );
  }
  windows.push(...labeled.values());
  return windows;
}

/**
 * Parse one limit/remaining/reset header triple into a window.
 * @param {Array<object>} windows sink
 * @param {Headers|Record<string, unknown>|null|undefined} headers
 * @param {string} limitName
 * @param {string} remainingName
 * @param {string} resetName
 * @param {string} kind
 * @param {number} now
 * @returns {void}
 */
function pushLimitRemainingWindow(
  windows,
  headers,
  limitName,
  remainingName,
  resetName,
  kind,
  now,
) {
  // Groq null-guard: headers.get() returns null when absent and Number(null)
  // is 0 — require both raw values present before converting.
  const limitRaw = getHeader(headers, limitName);
  const remainingRaw = getHeader(headers, remainingName);
  if (limitRaw === null || remainingRaw === null) return;
  const limit = toFiniteOrNull(limitRaw);
  const remaining = toFiniteOrNull(remainingRaw);
  if (limit === null || remaining === null || limit <= 0) return;
  const usedFraction = normalizeUsedFraction((limit - remaining) / limit, "used01");
  if (usedFraction === null) return;
  const sanitized = sanitizedWindowKind(kind);
  if (!sanitized) return;
  const resetRaw = getHeader(headers, resetName);
  let resetsAt = parseResetMs(resetRaw, now);
  // parseResetMs returns null only for Go durations; RFC3339/epoch stay as-is.
  if (resetsAt === null) {
    const ms = parseDurationToMs(resetRaw);
    resetsAt = ms === null ? 0 : now + ms;
  }
  windows.push({
    kind: sanitized,
    usedFraction,
    resetsAt,
    observedAt: now,
    source: "header",
  });
}

/**
 * Parse API-key rate-limit headers: OpenAI/Groq `x-ratelimit-*` (reset is a
 * Go-style duration, converted via parseDurationToMs) and Anthropic API
 * `anthropic-ratelimit-*` (RFC 3339 reset).
 * @param {Headers|Record<string, unknown>|null|undefined} headers
 * @param {number} [nowMs]
 * @returns {Array<object>} header-source windows
 */
export function parseGenericRateLimitHeaders(headers, nowMs = Date.now()) {
  const windows = [];
  const now = validNow(nowMs);
  for (const bucket of ["requests", "tokens"]) {
    pushLimitRemainingWindow(
      windows,
      headers,
      `x-ratelimit-limit-${bucket}`,
      `x-ratelimit-remaining-${bucket}`,
      `x-ratelimit-reset-${bucket}`,
      bucket,
      now,
    );
  }
  for (const bucket of ["requests", "tokens", "input-tokens", "output-tokens"]) {
    pushLimitRemainingWindow(
      windows,
      headers,
      `anthropic-ratelimit-${bucket}-limit`,
      `anthropic-ratelimit-${bucket}-remaining`,
      `anthropic-ratelimit-${bucket}-reset`,
      bucket,
      now,
    );
  }
  return windows;
}

/**
 * Dispatch headers to the provider's parser. Never throws.
 * @param {string} provider provider id
 * @param {Headers|Record<string, unknown>|null|undefined} headers
 * @param {number} [nowMs]
 * @returns {Array<object>} header-source windows, [] on any failure
 */
export function parseQuotaHeaders(provider, headers, nowMs = Date.now()) {
  try {
    if (!headers) return [];
    const id = typeof provider === "string" ? provider.trim().toLowerCase() : "";
    if (id === "claude") return parseClaudeHeaders(headers, nowMs);
    if (id === "codex") return parseCodexHeaders(headers, nowMs);
    return parseGenericRateLimitHeaders(headers, nowMs);
  } catch {
    return [];
  }
}

/**
 * Fail-open ingest: parse response headers and record windows. No-ops when
 * connectionId/headers are absent or nothing parses. Never throws.
 * @param {string} provider provider id
 * @param {string} connectionId connection id
 * @param {Headers|Record<string, unknown>|null|undefined} headers
 * @returns {void}
 */
export function ingestResponseHeaders(provider, connectionId, headers) {
  try {
    if (!connectionId || !headers) return;
    const windows = parseQuotaHeaders(provider, headers);
    if (!windows || windows.length === 0) return;
    recordHeaderWindows(connectionId, provider, windows);
  } catch {
    // fail-open: quota ingest never breaks the request path
  }
}
