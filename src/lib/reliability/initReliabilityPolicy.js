// YAN-311: bridge stored reliability settings (src/) into open-sse without
// open-sse importing src/. Called at server boot and on every settings PATCH
// touching reliability keys. Fail-open: a missing/throwing store keeps the
// previous policy (defaults on a cold start).
import { setReliabilityOverrides } from "open-sse/config/reliabilityPolicy.js";

let bootstrapped = false;

/**
 * Read stored reliability slice and inject it into open-sse.
 * @param {() => Promise<object>} getSettings Lazy settings reader (avoids import cycles).
 */
export async function syncReliabilityPolicy(getSettings) {
  try {
    const settings = await getSettings();
    setReliabilityOverrides(extractReliabilitySlice(settings));
  } catch {
    /* keep previous policy */
  }
}

/**
 * Pick the reliability slice out of merged settings.
 * @param {object} settings Merged settings object.
 * @returns {object} { retryPolicy, cooldowns, backoff, streamTimeouts } (keys present only when stored).
 */
export function extractReliabilitySlice(settings) {
  const slice = {};
  for (const key of ["retryPolicy", "cooldowns", "backoff", "streamTimeouts"]) {
    if (settings?.[key] !== undefined) slice[key] = settings[key];
  }
  return slice;
}

/**
 * Re-sync after a settings PATCH body was accepted. No-op unless a
 * reliability key changed.
 * @param {object} body Accepted PATCH body.
 * @param {object} mergedSettings Merged settings echoed by the store.
 */
export function syncReliabilityAfterPatch(body, mergedSettings) {
  if (!body || typeof body !== "object") return;
  if (
    !(
      Object.hasOwn(body, "retryPolicy") ||
      Object.hasOwn(body, "cooldowns") ||
      Object.hasOwn(body, "backoff") ||
      Object.hasOwn(body, "streamTimeouts")
    )
  )
    return;
  try {
    setReliabilityOverrides(extractReliabilitySlice(mergedSettings));
  } catch {
    /* keep previous policy */
  }
}

// Defer init so the HTTP server accepts connections first (same pattern as
// src/lib/network/initOutboundProxy.js).
setImmediate(() => {
  if (bootstrapped) return;
  bootstrapped = true;
  import("@/lib/localDb")
    .then(({ getSettings }) => syncReliabilityPolicy(getSettings))
    .catch(() => {});
});
