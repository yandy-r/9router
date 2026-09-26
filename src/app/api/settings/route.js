import { NextResponse } from "next/server";
import { getSettings, updateComboStrategies, updateSettings } from "@/lib/localDb";
import { applyOutboundProxyEnv } from "@/lib/network/outboundProxy";
import { resetComboRotation } from "open-sse/services/combo.js";
import { validateComboStrategySettings } from "open-sse/services/comboStrategy.js";
import bcrypt from "bcryptjs";

export const dynamic = "force-dynamic";
export const revalidate = 0;

const SETTINGS_RESPONSE_HEADERS = {
  "Cache-Control": "no-store",
};

// Secrets must never be mass-assigned from request body (CWE-915)
const PROTECTED_SETTING_KEYS = ["password", "mitmSudoEncrypted"];
const VALID_COMBO_NAME = /^[a-zA-Z0-9_.-]+$/;
const BLOCKED_COMBO_NAMES = new Set(["__proto__", "constructor", "prototype"]);

function safeSettingsResponse(settings) {
  const { password, oidcClientSecret, ...safeSettings } = settings;
  safeSettings.oidcConfigured = !!(
    safeSettings.oidcIssuerUrl &&
    safeSettings.oidcClientId &&
    oidcClientSecret
  );
  return NextResponse.json(safeSettings, { headers: SETTINGS_RESPONSE_HEADERS });
}

async function handleComboStrategyPatch(body) {
  const { name, patch } = body.comboStrategyPatch || {};
  if (typeof name !== "string" || !VALID_COMBO_NAME.test(name) || BLOCKED_COMBO_NAMES.has(name)) {
    return NextResponse.json({ error: "Invalid combo name" }, { status: 400 });
  }
  if (!patch || typeof patch !== "object" || Array.isArray(patch)) {
    return NextResponse.json({ error: "Invalid combo strategy patch" }, { status: 400 });
  }
  // Preserve fusion settings edits; reject unknown keys instead of silently storing them.
  const allowed = new Set(["fallbackStrategy", "weights", "judgeModel", "fusionTuning"]);
  if (Object.keys(patch).some((key) => !allowed.has(key))) {
    return NextResponse.json({ error: "Invalid combo strategy patch" }, { status: 400 });
  }
  const error = validateComboStrategySettings({ comboStrategies: { [name]: patch } });
  if (error) return NextResponse.json({ error }, { status: 400 });

  // Validation against the merged entry happens inside the transaction too (weight-count cap).
  let mergedError;
  let missingWeightedEntry = false;
  let settings;
  try {
    settings = await updateComboStrategies((strategies) => {
      const base = Object.hasOwn(strategies, name) ? strategies[name] : {};
      if (
        Object.hasOwn(patch, "weights") &&
        !Object.hasOwn(patch, "fallbackStrategy") &&
        base?.fallbackStrategy !== "weighted"
      ) {
        missingWeightedEntry = true;
        return strategies;
      }
      const next = { ...base, ...patch };
      if (patch.weights) next.weights = { ...base?.weights, ...patch.weights };
      mergedError = validateComboStrategySettings({ comboStrategies: { [name]: next } });
      if (mergedError) return strategies;
      const updated = { ...strategies };
      if (!next.fallbackStrategy || next.fallbackStrategy === "fallback") {
        delete updated[name];
      } else {
        updated[name] = next;
      }
      return updated;
    }, name);
  } catch (error) {
    if (error.code === "COMBO_NOT_FOUND") {
      return NextResponse.json({ error: "Combo not found" }, { status: 409 });
    }
    throw error;
  }
  if (missingWeightedEntry) return NextResponse.json({ error: "Combo not found" }, { status: 409 });
  if (mergedError) return NextResponse.json({ error: mergedError }, { status: 400 });

  resetComboRotation();
  import("@/shared/services/quotaSnapshotPoller")
    .then(({ syncQuotaSnapshotPoller }) => syncQuotaSnapshotPoller())
    .catch((error) => console.warn("[QuotaSnapshotPoller] settings update failed:", error.message));
  return safeSettingsResponse(settings);
}

const ACCOUNT_STRATEGIES = new Set(["fill-first", "round-robin", "weighted"]);
const AUTH_MODES = new Set(["password", "sso", "both", "saml", "oidc"]);
const SSO_TYPES = new Set(["oidc", "saml"]);
const UNSAFE_KEYS = new Set(["__proto__", "constructor", "prototype"]);
const MAX_TEXT_LEN = 256;
const MAX_URL_LEN = 2048;
const MAX_PASSWORD_LEN = 256;
const MAX_CERT_LEN = 16384;

function validStickyLimit(value) {
  return Number.isInteger(value) && value >= 1 && value <= 100;
}

function validText(value, max = MAX_TEXT_LEN) {
  return typeof value === "string" && value.length <= max;
}

// Empty clears the value; otherwise require an http(s) URL.
function validUrl(value) {
  if (typeof value !== "string" || value.length > MAX_URL_LEN) return false;
  if (!value.trim()) return true;
  try {
    const url = new URL(value.trim());
    return url.protocol === "http:" || url.protocol === "https:";
  } catch {
    return false;
  }
}

/**
 * Boundary validation for keys touched by the YAN-309 Settings page:
 * security toggles, auth mode/protocol, OIDC + SAML fields, passwords.
 * Returns an error message string, or "" when valid.
 */
function validSecuritySettings(body) {
  for (const key of ["requireLogin", "requireApiKey", "tunnelDashboardAccess"]) {
    if (Object.hasOwn(body, key) && typeof body[key] !== "boolean") {
      return `Invalid ${key}: must be a boolean`;
    }
  }
  if (Object.hasOwn(body, "authMode") && !AUTH_MODES.has(body.authMode)) {
    return "Invalid authMode";
  }
  if (Object.hasOwn(body, "ssoType") && !SSO_TYPES.has(body.ssoType)) {
    return "Invalid ssoType";
  }
  for (const key of ["oidcClientId", "oidcScopes", "oidcLoginLabel"]) {
    if (Object.hasOwn(body, key) && !validText(body[key])) {
      return `Invalid ${key}`;
    }
  }
  if (Object.hasOwn(body, "oidcIssuerUrl") && !validUrl(body.oidcIssuerUrl)) {
    return "Invalid oidcIssuerUrl: must be an http(s) URL";
  }
  if (Object.hasOwn(body, "oidcClientSecret") && !validText(body.oidcClientSecret, MAX_URL_LEN)) {
    return "Invalid oidcClientSecret";
  }
  if (Object.hasOwn(body, "samlEntryPoint") && !validUrl(body.samlEntryPoint)) {
    return "Invalid samlEntryPoint: must be an http(s) URL";
  }
  for (const key of ["samlIssuer", "samlLoginLabel", "samlAttributeEmail", "samlAttributeName"]) {
    if (Object.hasOwn(body, key) && !validText(body[key])) {
      return `Invalid ${key}`;
    }
  }
  if (Object.hasOwn(body, "samlCert") && !validText(body.samlCert, MAX_CERT_LEN)) {
    return "Invalid samlCert";
  }
  for (const key of ["currentPassword", "newPassword"]) {
    if (
      Object.hasOwn(body, key) &&
      (typeof body[key] !== "string" || body[key].length > MAX_PASSWORD_LEN)
    ) {
      return `Invalid ${key}`;
    }
  }
  return "";
}

function isPlainObject(value) {
  return (
    value !== null &&
    typeof value === "object" &&
    !Array.isArray(value) &&
    Object.getPrototypeOf(value) === Object.prototype
  );
}

function validAccountSettings(body) {
  if (Object.hasOwn(body, "fallbackStrategy") && !ACCOUNT_STRATEGIES.has(body.fallbackStrategy)) {
    return false;
  }
  if (
    Object.hasOwn(body, "stickyRoundRobinLimit") &&
    !validStickyLimit(body.stickyRoundRobinLimit)
  ) {
    return false;
  }
  if (Object.hasOwn(body, "providerStrategies")) {
    if (!isPlainObject(body.providerStrategies)) return false;
    for (const [provider, strategy] of Object.entries(body.providerStrategies)) {
      if (
        provider !== provider.trim() ||
        !provider ||
        UNSAFE_KEYS.has(provider) ||
        !isPlainObject(strategy) ||
        Object.keys(strategy).some((key) => UNSAFE_KEYS.has(key))
      ) {
        return false;
      }
      if (
        Object.hasOwn(strategy, "fallbackStrategy") &&
        !ACCOUNT_STRATEGIES.has(strategy.fallbackStrategy)
      ) {
        return false;
      }
      if (
        Object.hasOwn(strategy, "stickyRoundRobinLimit") &&
        !validStickyLimit(strategy.stickyRoundRobinLimit)
      ) {
        return false;
      }
    }
  }
  return true;
}

export async function GET() {
  try {
    const settings = await getSettings();
    const { password, oidcClientSecret, ...safeSettings } = settings;
    safeSettings.oidcConfigured = !!(
      safeSettings.oidcIssuerUrl &&
      safeSettings.oidcClientId &&
      oidcClientSecret
    );

    const enableRequestLogs = process.env.ENABLE_REQUEST_LOGS === "true";
    const enableTranslator = process.env.ENABLE_TRANSLATOR === "true";

    return NextResponse.json(
      {
        ...safeSettings,
        enableRequestLogs,
        enableTranslator,
        hasPassword: !!password,
      },
      { headers: SETTINGS_RESPONSE_HEADERS },
    );
  } catch (error) {
    console.log("Error getting settings:", error);
    return NextResponse.json({ error: error.message }, { status: 500 });
  }
}

export async function PATCH(request) {
  try {
    const body = await request.json();
    if (!isPlainObject(body)) {
      return NextResponse.json({ error: "Settings body must be an object" }, { status: 400 });
    }

    if (Object.hasOwn(body, "comboStrategyPatch") && Object.keys(body).length !== 1) {
      return NextResponse.json(
        { error: "comboStrategyPatch must be the only setting" },
        { status: 400 },
      );
    }

    // Strip protected secrets before any internal handling sets them
    for (const key of PROTECTED_SETTING_KEYS) delete body[key];

    if (Object.hasOwn(body, "comboStrategyPatch")) {
      return await handleComboStrategyPatch(body);
    }

    const comboStrategyError = validateComboStrategySettings(body);
    if (comboStrategyError) {
      return NextResponse.json({ error: comboStrategyError }, { status: 400 });
    }
    if (!validAccountSettings(body)) {
      return NextResponse.json({ error: "Invalid account strategy settings" }, { status: 400 });
    }
    const securityError = validSecuritySettings(body);
    if (securityError) {
      return NextResponse.json({ error: securityError }, { status: 400 });
    }

    // Password updates hash into `password`; raw password keys must never persist (CWE-915).
    // Raw password material for verification/hashing only; never persisted (CWE-915).
    const rawNewPassword = typeof body.newPassword === "string" ? body.newPassword : "";
    const attemptedCurrent = typeof body.currentPassword === "string" ? body.currentPassword : "";
    delete body.newPassword;
    delete body.currentPassword;
    if (rawNewPassword) {
      const settings = await getSettings();
      const currentHash = settings.password;

      // Verify current password if it exists
      if (currentHash) {
        if (!attemptedCurrent) {
          return NextResponse.json({ error: "Current password required" }, { status: 400 });
        }
        const isValid = await bcrypt.compare(attemptedCurrent, currentHash);
        if (!isValid) {
          return NextResponse.json({ error: "Invalid current password" }, { status: 401 });
        }
      } else if (attemptedCurrent && attemptedCurrent !== "123456") {
        // First time setting password, no current password needed
        return NextResponse.json({ error: "Invalid current password" }, { status: 401 });
      }

      const salt = await bcrypt.genSalt(10);
      body.password = await bcrypt.hash(rawNewPassword, salt);
    }

    if (Object.hasOwn(body, "oidcClientSecret")) {
      if (!body.oidcClientSecret || !String(body.oidcClientSecret).trim()) {
        delete body.oidcClientSecret;
      }
    }

    const settings = await updateSettings(body);

    // Apply outbound proxy settings immediately (no restart required)
    if (
      Object.hasOwn(body, "outboundProxyEnabled") ||
      Object.hasOwn(body, "outboundProxyUrl") ||
      Object.hasOwn(body, "outboundNoProxy")
    ) {
      applyOutboundProxyEnv(settings);
    }

    // Invalidate combo rotation state when strategy settings change
    if (
      Object.hasOwn(body, "comboStrategy") ||
      Object.hasOwn(body, "comboStickyRoundRobinLimit") ||
      Object.hasOwn(body, "comboStrategies")
    ) {
      resetComboRotation();
    }

    if (
      Object.hasOwn(body, "fallbackStrategy") ||
      Object.hasOwn(body, "stickyRoundRobinLimit") ||
      Object.hasOwn(body, "providerStrategies")
    ) {
      // Reset in-memory SWRR state when account strategy changes. Lazy import keeps
      // auth.js's DB imports out of the route's static graph.
      import("@/sse/services/auth")
        .then(({ resetAccountSelection }) => resetAccountSelection?.())
        .catch((error) => console.warn("[AccountSelection] reset failed:", error.message));
    }

    if (Object.hasOwn(body, "claudeAutoPing") || Object.hasOwn(body, "codexAutoPing")) {
      // Keep the scheduler absent when no account opted in; load its provider graph only on demand.
      import("@/shared/services/quotaAutoPing")
        .then(({ configureQuotaAutoPing }) => {
          configureQuotaAutoPing(settings);
        })
        .catch((error) => console.warn("[AutoPing] settings update failed:", error.message));
    }

    if (
      Object.hasOwn(body, "fallbackStrategy") ||
      Object.hasOwn(body, "providerStrategies") ||
      Object.hasOwn(body, "comboStrategies") ||
      Object.hasOwn(body, "comboStrategy")
    ) {
      // Weighted gating changed: start/stop the snapshot backfill poller (YAN-259).
      import("@/shared/services/quotaSnapshotPoller")
        .then(({ syncQuotaSnapshotPoller }) => {
          syncQuotaSnapshotPoller();
        })
        .catch((error) =>
          console.warn("[QuotaSnapshotPoller] settings update failed:", error.message),
        );
    }

    return safeSettingsResponse(settings);
  } catch (error) {
    console.log("Error updating settings:", error);
    return NextResponse.json({ error: error.message }, { status: 500 });
  }
}
