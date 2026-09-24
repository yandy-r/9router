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
  const settings = await updateComboStrategies((strategies) => {
    const base = Object.hasOwn(strategies, name) ? strategies[name] : {};
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
  });
  if (mergedError) return NextResponse.json({ error: mergedError }, { status: 400 });

  resetComboRotation();
  import("@/shared/services/quotaSnapshotPoller")
    .then(({ configureQuotaSnapshotPoller }) => configureQuotaSnapshotPoller(settings))
    .catch((error) => console.warn("[QuotaSnapshotPoller] settings update failed:", error.message));
  return safeSettingsResponse(settings);
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

    // If updating password, hash it
    if (body.newPassword) {
      const settings = await getSettings();
      const currentHash = settings.password;

      // Verify current password if it exists
      if (currentHash) {
        if (!body.currentPassword) {
          return NextResponse.json({ error: "Current password required" }, { status: 400 });
        }
        const isValid = await bcrypt.compare(body.currentPassword, currentHash);
        if (!isValid) {
          return NextResponse.json({ error: "Invalid current password" }, { status: 401 });
        }
      } else {
        // First time setting password, no current password needed
        // Allow empty currentPassword or default "123456"
        if (body.currentPassword && body.currentPassword !== "123456") {
          return NextResponse.json({ error: "Invalid current password" }, { status: 401 });
        }
      }

      const salt = await bcrypt.genSalt(10);
      body.password = await bcrypt.hash(body.newPassword, salt);
      delete body.newPassword;
      delete body.currentPassword;
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

    if (Object.hasOwn(body, "claudeAutoPing") || Object.hasOwn(body, "codexAutoPing")) {
      // Keep the scheduler absent when no account opted in; load its provider graph only on demand.
      import("@/shared/services/quotaAutoPing")
        .then(({ configureQuotaAutoPing }) => {
          configureQuotaAutoPing(settings);
        })
        .catch((error) => console.warn("[AutoPing] settings update failed:", error.message));
    }

    if (
      Object.hasOwn(body, "providerStrategies") ||
      Object.hasOwn(body, "comboStrategies") ||
      Object.hasOwn(body, "comboStrategy")
    ) {
      // Weighted gating changed: start/stop the snapshot backfill poller (YAN-259).
      import("@/shared/services/quotaSnapshotPoller")
        .then(({ configureQuotaSnapshotPoller }) => {
          configureQuotaSnapshotPoller(settings);
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
