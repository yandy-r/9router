// Quota snapshot poller (YAN-259): backfills the snapshot store from USAGE_HANDLERS
// probes for connections of weighted providers/combos. Never sends chat pings.
// DI shape mirrors quotaAutoPing: runQuotaSnapshotTick(deps, state).
import "open-sse/index.js";

import {
  getSettings,
  getProviderConnections,
  getCombos,
  updateProviderConnection,
} from "@/lib/localDb";
import { getUsageForProvider } from "open-sse/services/usage.js";
import { getSnapshot } from "open-sse/services/quotaSnapshot.js";
import { QUOTA_SNAPSHOT } from "open-sse/config/quotaSnapshot.js";
import { parseModel } from "open-sse/services/model.js";
import { resolveConnectionProxyConfig } from "@/lib/network/connectionProxy";
import { refreshAndUpdateCredentials } from "@/app/api/usage/[connectionId]/route.js";
import { USAGE_APIKEY_PROVIDERS } from "@/shared/constants/providers";
import {
  fetchAndPersistClaudePlanTier,
  recordUsageSnapshot,
} from "@/sse/services/quotaSnapshotSync";

const C = QUOTA_SNAPSHOT.poller;

// Survive Next.js hot reload; one scheduler per server process.
if (!global.__quotaSnapshotPoller) {
  global.__quotaSnapshotPoller = {
    timer: null,
    running: false,
    failureCache: {},
  };
}
const g = global.__quotaSnapshotPoller;

function buildProxyOptions(cfg) {
  return {
    connectionProxyEnabled: cfg?.connectionProxyEnabled === true,
    connectionProxyUrl: cfg?.connectionProxyUrl || "",
    connectionNoProxy: cfg?.connectionNoProxy || "",
    vercelRelayUrl: cfg?.vercelRelayUrl || "",
    strictProxy: false,
  };
}

// Same eligibility as GET /api/usage/[connectionId].
function isEligible(connection) {
  if (connection?.authType === "oauth") return true;
  const isApikey = connection?.authType === "apikey" || connection?.authType === "api_key";
  return isApikey && USAGE_APIKEY_PROVIDERS.includes(connection.provider);
}

export function createDefaultDeps() {
  return {
    getSettings,
    getProviderConnections,
    getCombos,
    updateProviderConnection,
    resolveConnectionProxyConfig,
    refreshAndUpdateCredentials,
    getUsageForProvider,
  };
}

// Weighted combos name their providers by combo model prefix; combos without a
// per-combo entry inherit settings.comboStrategy. Prefix before "/" is enough.
function comboIsWeighted(combo, settings) {
  const specific = settings?.comboStrategies?.[combo?.name]?.fallbackStrategy;
  return (specific || settings?.comboStrategy || "fallback") === "weighted";
}

const FAILURE_CACHE_CAP = 1000;

function pruneFailureCache(failureCache) {
  const cutoff = Date.now() - C.failureCooldownMs;
  for (const [key, at] of Object.entries(failureCache)) {
    if (at <= cutoff) delete failureCache[key];
  }
  const keys = Object.keys(failureCache);
  if (keys.length > FAILURE_CACHE_CAP) {
    for (const key of keys
      .sort((a, b) => failureCache[a] - failureCache[b])
      .slice(0, keys.length - FAILURE_CACHE_CAP)) {
      delete failureCache[key];
    }
  }
}

function weightedProviders(settings, combos) {
  const direct = new Set(
    Object.entries(settings?.providerStrategies || {})
      .filter(([, strategy]) => strategy?.fallbackStrategy === "weighted")
      .map(([provider]) => provider),
  );
  for (const combo of combos || []) {
    if (!comboIsWeighted(combo, settings)) continue;
    for (const model of combo?.models || []) {
      try {
        const raw = typeof model === "string" ? model : (model?.model ?? model?.name);
        if (typeof raw !== "string") continue;
        const { provider, isAlias } = parseModel(raw);
        if (!isAlias && provider) direct.add(provider);
      } catch {
        // One malformed combo model must not abort the tick.
      }
    }
  }
  return direct;
}

function fresh(connectionId) {
  const snapshot = getSnapshot(connectionId);
  return snapshot && Date.now() - snapshot.updatedAt < C.staleMs;
}

async function pollConnection(connection, deps, state) {
  const key = `${connection.provider}:${connection.id}`;
  if (state.failureCache[key] && Date.now() - state.failureCache[key] < C.failureCooldownMs) {
    return;
  }
  try {
    const proxyConfig = await deps.resolveConnectionProxyConfig(connection.providerSpecificData);
    const proxyOptions = buildProxyOptions(proxyConfig);
    // Reuse route refresh for OAuth only; API keys have no refresh flow.
    const freshConnection =
      connection.authType === "oauth"
        ? (await deps.refreshAndUpdateCredentials(connection, false, proxyOptions)).connection
        : connection;
    const usage = await deps.getUsageForProvider(freshConnection, proxyOptions, { force: false });
    if (!usage || typeof usage.message === "string") {
      state.failureCache[key] = Date.now();
      return;
    }
    await recordUsageSnapshot({
      connectionId: freshConnection.id,
      provider: freshConnection.provider,
      usage,
      fallbackTier:
        freshConnection.providerSpecificData?.planTier ??
        freshConnection.providerSpecificData?.chatgptPlanType,
    });
    if (freshConnection.provider === "claude") {
      await fetchAndPersistClaudePlanTier(freshConnection, proxyOptions);
    }
    delete state.failureCache[key];
  } catch (error) {
    state.failureCache[key] = Date.now();
    console.warn(`[QuotaSnapshotPoller] ${key}: ${error?.message}`);
  }
}

export async function runQuotaSnapshotTick(deps = createDefaultDeps(), state = g) {
  if (state.running) return;
  state.running = true;
  try {
    if (!state.failureCache) state.failureCache = {};
    pruneFailureCache(state.failureCache);
    const settings = await deps.getSettings();
    const combos = deps.getCombos ? await deps.getCombos().catch(() => []) : [];
    const providers = weightedProviders(settings, combos);
    if (providers.size === 0) return;

    for (const provider of providers) {
      let connections = [];
      try {
        connections = await deps.getProviderConnections({ provider, isActive: true });
      } catch {
        continue;
      }
      for (const connection of connections) {
        if (!isEligible(connection) || fresh(connection.id)) continue;
        await pollConnection(connection, deps, state);
      }
    }
  } catch (error) {
    console.warn(`[QuotaSnapshotPoller] tick: ${error?.message}`);
  } finally {
    state.running = false;
  }
}

export function startQuotaSnapshotPoller() {
  if (g.timer) return;
  console.log("[QuotaSnapshotPoller] scheduler started");
  runQuotaSnapshotTick().catch(() => {});
  g.timer = setInterval(() => {
    runQuotaSnapshotTick().catch(() => {});
  }, C.tickMs);
  if (g.timer.unref) g.timer.unref();
}

export function stopQuotaSnapshotPoller() {
  if (!g.timer) return;
  clearInterval(g.timer);
  g.timer = null;
  console.log("[QuotaSnapshotPoller] scheduler stopped");
}

// Weighted targets only: start when some provider strategy, combo strategy, or the
// global comboStrategy is weighted; member resolution happens on each tick.
export function configureQuotaSnapshotPoller(settings) {
  const hasWeighted =
    Object.values(settings?.providerStrategies || {}).some(
      (strategy) => strategy?.fallbackStrategy === "weighted",
    ) ||
    (settings?.comboStrategy || "fallback") === "weighted" ||
    Object.values(settings?.comboStrategies || {}).some(
      (strategy) => strategy?.fallbackStrategy === "weighted",
    );
  if (hasWeighted) startQuotaSnapshotPoller();
  else stopQuotaSnapshotPoller();
}
