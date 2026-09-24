/**
 * Meta Code (Muse Spark) subscription helpers.
 *
 * The muse CLI signs in with a device-code OAuth grant, then trades the resulting
 * `dca:` token for the API key tied to the Muse Code subscription ("mint"). Only
 * that key is billed at subscription rates; any other key is pay-as-you-go.
 * Minting is idempotent: it returns the same key every time and does not rotate it.
 * The mint response also includes the current subscription usage (5h + weekly windows).
 */

import { fetchWithTimeout, parseResetTime, toFiniteNumber } from "./usage/shared.js";

export const META_CODE_KEY_URL = "https://api.meta.ai/muse-code/key";

/**
 * Mint (or re-fetch) the subscription API key for a Meta device-code token.
 * @param {string} dcaToken - OAuth access token from auth.meta.com (`dca:…`)
 * @returns {Promise<object>} Mint payload; `api_key` is guaranteed non-empty.
 * @throws {Error} with `.status` on HTTP failure, or when Meta returns no key.
 */
export async function mintMetaCodeKey(dcaToken, proxyOptions = null) {
  if (!dcaToken) throw new Error("Meta Code: missing OAuth token");
  const res = await fetchWithTimeout(
    META_CODE_KEY_URL,
    {
      method: "POST",
      headers: {
        Authorization: `Bearer ${dcaToken}`,
        "x-api-version": "1.0.0",
        "Content-Type": "application/json",
        Accept: "application/json",
      },
      body: "{}",
    },
    15000,
    proxyOptions,
  );
  if (!res.ok) {
    const detail = await res.text().catch(() => "");
    const err = new Error(`Meta Code key mint failed (${res.status}): ${detail.slice(0, 200)}`);
    err.status = res.status;
    throw err;
  }
  const data = await res.json();
  if (!data?.api_key) {
    const hint = data?.action_url ? ` Finish setup at ${data.action_url}` : "";
    throw new Error(`Meta Code: account has no Model API key yet.${hint}`);
  }
  return data;
}

function percentQuota(win) {
  const used = Math.min(100, Math.max(0, toFiniteNumber(win?.used_percent, 0)));
  return {
    used,
    total: 100,
    remainingPercentage: 100 - used,
    resetAt: parseResetTime(win?.resets_at),
    unlimited: false,
  };
}

/** Map Meta `subs_usage` ({window, weekly}) to dashboard percent quotas. */
export function parseMetaSubsUsage(subs) {
  const quotas = {};
  if (subs?.window) quotas["Session (5h)"] = percentQuota(subs.window);
  if (subs?.weekly) quotas.Weekly = percentQuota(subs.weekly);
  return quotas;
}

/** Usage handler: re-mint with the stored `dca:` token (refreshToken) to read quota. */
export async function getMetaCodeUsage(dcaToken, proxyOptions = null) {
  if (!dcaToken) {
    return { message: "Quota is only available for Meta Code accounts connected via sign-in." };
  }
  try {
    const data = await mintMetaCodeKey(dcaToken, proxyOptions);
    if (!data.is_subs_active) {
      return { plan: "Pay-as-you-go", message: "No active Muse Code subscription." };
    }
    return {
      plan: data.subs_tier_name || "Muse Code",
      quotas: parseMetaSubsUsage(data.subs_usage),
    };
  } catch (error) {
    if (error.status === 401 || error.status === 403) {
      return { message: "Meta Code sign-in expired. Please re-authorize." };
    }
    return { message: `Meta Code connected. Unable to fetch usage: ${error.message}` };
  }
}
