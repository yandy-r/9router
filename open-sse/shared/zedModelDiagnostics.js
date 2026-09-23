// Explains why a Zed model catalog has no usable models, so the dashboard can
// show an actionable reason instead of a bare "no live models".
//
// Sources, in order: the `disabled_reason` Zed attached to disabled models,
// then the account's plan / organization configuration from
// /client/users/me (same fields upstream Zed uses to describe access).

import { fetchZedAuthenticatedUser, resolveZedOrganizationId } from "./zedAuth.js";

const PLAN_LABELS = {
  zed_free: "Zed Free",
  zed_pro: "Zed Pro",
  zed_pro_trial: "Zed Pro trial",
  zed_business: "Zed Business",
  zed_vip: "Zed VIP",
  zed_student: "Zed Student",
};

function planName(plan) {
  const value = typeof plan === "string" ? plan : plan?.plan_v3;
  if (!value) return null;
  return PLAN_LABELS[value] || String(value);
}

/** Summarize the disabled reasons Zed attached to the catalog, or null if none were disabled. */
export function describeDisabledZedModels(disabledModels = []) {
  if (!disabledModels.length) return null;
  const reasons = [...new Set(disabledModels.map((m) => m.disabledReason).filter(Boolean))];
  const detail = reasons.length ? reasons.join("; ") : "Zed gave no reason";
  return `Zed lists ${disabledModels.length} model(s), but all are disabled: ${detail}`;
}

/** Describe the account's access to hosted models from GET /client/users/me. */
export function describeZedAccountAccess(credentials, userInfo) {
  const organizationId = resolveZedOrganizationId(credentials, userInfo);
  const organization = (userInfo?.organizations || []).find((org) => org?.id === organizationId);
  const orgLabel = organization?.name ? `"${organization.name}"` : organizationId ? `"${organizationId}"` : "your account";

  const config = userInfo?.configuration_by_organization?.[organizationId];
  if (config && config.is_zed_model_provider_enabled === false) {
    return `Zed's hosted models are disabled by the ${orgLabel} organization's configuration.`;
  }

  const plan = planName(userInfo?.plans_by_organization?.[organizationId]) || planName(userInfo?.plan);
  const parts = [`Zed returned no live models for ${orgLabel}${plan ? ` (plan: ${plan})` : ""}.`];
  if (userInfo?.plan?.is_account_too_young) parts.push("Zed reports the account is too new to use hosted models.");
  if (userInfo?.plan?.has_overdue_invoices) parts.push("Zed reports overdue invoices on the account.");
  if (plan === PLAN_LABELS.zed_free) {
    parts.push("Hosted models may require a Zed Pro plan or trial; check your plan at zed.dev/account.");
  }
  return parts.join(" ");
}

/**
 * Build the warning shown when a resolved catalog has no enabled models.
 * Never throws: falls back to a generic message if the account lookup fails.
 */
export async function explainEmptyZedCatalog(credentials, catalog, options = {}) {
  const disabled = describeDisabledZedModels(catalog?.disabledModels);
  if (disabled) return disabled;
  try {
    const userInfo = await fetchZedAuthenticatedUser(credentials, options);
    return describeZedAccountAccess(credentials, userInfo);
  } catch (error) {
    return `Zed returned no live models (account lookup failed: ${error.message}).`;
  }
}
