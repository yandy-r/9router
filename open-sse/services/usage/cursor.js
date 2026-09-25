/**
 * Cursor usage — Connect-RPC (JSON) on api2.cursor.sh DashboardService:
 * - GetCurrentPeriodUsage → planUsage percentages + spendLimitUsage (on-demand, cents)
 * - GetPlanInfo → planInfo.planName (best-effort)
 * Auth: Authorization: Bearer {accessToken}
 *
 * proto3 JSON omits zero/false fields, so a missing numeric field means 0.
 */

import { U, parseResetTime, toFiniteNumber, fetchWithTimeout } from "./shared.js";

const CURSOR_PLAN_TIERS = new Set([
  "free",
  "pro",
  "pro_plus",
  "ultra",
  "team",
  "business",
  "enterprise",
]);
const PRO_PLUS_ALIASES = new Set(["pro+", "pro plus", "proplus", "pro_plus"]);

const clampPct = (value) => Math.min(100, Math.max(0, value));
const pct = (value) => clampPct(toFiniteNumber(value, 0));

function percentRow(value, resetAt) {
  const p = pct(value);
  return { used: Math.round(p * 10) / 10, total: 100, remainingPercentage: 100 - p, resetAt };
}

/**
 * Map GetCurrentPeriodUsage JSON (+ optional GetPlanInfo.planInfo) → { plan, planName, quotas }.
 * Never sets `message` — the quota snapshot poller treats a string message as failure.
 */
export function parseCursorUsage(data, planInfo) {
  const resetAt = parseResetTime(Number(data?.billingCycleEnd)) || null;
  const quotas = {};

  const planUsage = data?.planUsage;
  if (planUsage && typeof planUsage === "object") {
    quotas.Total = percentRow(planUsage.totalPercentUsed, resetAt);
    quotas["Auto + Composer"] = percentRow(planUsage.autoPercentUsed, resetAt);
    quotas.API = percentRow(planUsage.apiPercentUsed, resetAt);
  }

  const spend = data?.spendLimitUsage;
  if (spend && typeof spend === "object") {
    // Individual caps first; team plans may report pooled caps instead. Values are cents.
    const limit = toFiniteNumber(spend.individualLimit ?? spend.pooledLimit, 0);
    const used = toFiniteNumber(spend.individualUsed ?? spend.pooledUsed, 0);
    if (limit > 0) {
      quotas["On-demand"] = {
        used: Math.round(used) / 100,
        total: Math.round(limit) / 100,
        remainingPercentage: clampPct((1 - used / limit) * 100),
        resetAt,
      };
    }
  }

  const planName = planInfo?.planName || null;
  return { plan: planName, planName, quotas };
}

/** Normalize a Cursor plan name to a PLAN_CAPACITY tier key (null when unknown). */
export function cursorPlanTier(name) {
  if (typeof name !== "string") return null;
  let tier = name.trim().toLowerCase();
  if (PRO_PLUS_ALIASES.has(tier)) tier = "pro_plus";
  else if (tier === "hobby") tier = "free";
  return CURSOR_PLAN_TIERS.has(tier) ? tier : null;
}

async function readJson(res) {
  try {
    return await res.json();
  } catch {
    return null;
  }
}

/**
 * @param {string|null|undefined} accessToken
 * @param {object|null|undefined} _providerSpecificData
 * @param {object|null|undefined} proxyOptions
 */
export async function getCursorUsage(accessToken, _providerSpecificData, proxyOptions = null) {
  if (!accessToken) {
    return { message: "Cursor access token not available. Re-authorize the connection." };
  }

  const endpoints = U("cursor");
  const opts = {
    method: "POST",
    headers: {
      Authorization: `Bearer ${accessToken}`,
      "Content-Type": "application/json",
      "Connect-Protocol-Version": "1",
    },
    body: "{}",
  };

  const [usageResult, planResult] = await Promise.allSettled([
    fetchWithTimeout(endpoints.url, opts, 10000, proxyOptions),
    fetchWithTimeout(endpoints.planInfoUrl, opts, 10000, proxyOptions),
  ]);

  if (usageResult.status !== "fulfilled" || !usageResult.value) {
    return { message: "Cursor usage unavailable (network error)" };
  }
  const usageRes = usageResult.value;
  if (usageRes.status === 401 || usageRes.status === 403) {
    return { message: "Cursor authentication expired (401). Re-authorize the connection." };
  }
  if (!usageRes.ok) {
    return { message: `Cursor usage unavailable (${usageRes.status})` };
  }

  const usageJson = await readJson(usageRes);
  if (!usageJson || typeof usageJson !== "object") {
    return { message: "Cursor usage unavailable (invalid response)" };
  }

  let planInfo = null;
  if (planResult.status === "fulfilled" && planResult.value?.ok) {
    planInfo = (await readJson(planResult.value))?.planInfo ?? null;
  }

  return parseCursorUsage(usageJson, planInfo);
}
