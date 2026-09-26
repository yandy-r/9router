import { getErrorCode, getRelativeTime } from "@/shared/utils";

export const LIST_FILTERS = {
  ALL: "all",
  CONNECTED: "connected",
  NEEDS_ATTENTION: "needs-attention",
  OAUTH: "oauth",
  FREE: "free",
  APIKEY: "apikey",
};

export const PROVIDER_LIST_FILTERS = [
  { value: LIST_FILTERS.ALL, label: "All" },
  { value: LIST_FILTERS.CONNECTED, label: "Connected" },
  { value: LIST_FILTERS.NEEDS_ATTENTION, label: "Needs attention" },
  { value: LIST_FILTERS.OAUTH, label: "OAuth" },
  { value: LIST_FILTERS.FREE, label: "Free tier" },
  { value: LIST_FILTERS.APIKEY, label: "API key" },
];

// Backward compatibility with previous select options
export const STATUS_FILTER_OPTIONS = [
  { value: "all", label: "All" },
  { value: "active", label: "Active" },
  { value: "inactive", label: "Inactive" },
  { value: "none", label: "No connection" },
];

export function getConnectionStatus(stats, isNoAuth = false) {
  if (isNoAuth) return "active";
  if (!stats || stats.total === 0) return "none";
  return stats.allDisabled ? "inactive" : "active";
}

export function matchesStatusFilter(statusFilter, stats, isNoAuth = false) {
  if (statusFilter === "all") return true;
  return getConnectionStatus(stats, isNoAuth) === statusFilter;
}

export function getConnectionErrorTag(connection) {
  if (!connection) return null;

  const explicitType = connection.lastErrorType;
  if (explicitType === "runtime_error") return "RUNTIME";
  if (
    explicitType === "upstream_auth_error" ||
    explicitType === "auth_missing" ||
    explicitType === "token_refresh_failed" ||
    explicitType === "token_expired"
  )
    return "AUTH";
  if (explicitType === "upstream_rate_limited") return "429";
  if (explicitType === "upstream_unavailable") return "5XX";
  if (explicitType === "network_error") return "NET";

  const numericCode = Number(connection.errorCode);
  if (Number.isFinite(numericCode) && numericCode >= 400) return String(numericCode);

  const fromMessage = getErrorCode(connection.lastError);
  if (fromMessage === "401" || fromMessage === "403") return "AUTH";
  if (fromMessage && fromMessage !== "ERR") return fromMessage;

  const msg = (connection.lastError || "").toLowerCase();
  if (msg.includes("runtime") || msg.includes("not runnable") || msg.includes("not installed"))
    return "RUNTIME";
  if (
    msg.includes("invalid api key") ||
    msg.includes("token invalid") ||
    msg.includes("revoked") ||
    msg.includes("unauthorized")
  )
    return "AUTH";

  return "ERR";
}

export function getCooldownUntil(connection) {
  if (!connection) return null;
  const now = Date.now();
  let earliest = null;
  for (const [key, value] of Object.entries(connection)) {
    if (key.startsWith("modelLock_") && value) {
      const time = new Date(value).getTime();
      if (!Number.isNaN(time) && time > now) {
        if (!earliest || time < earliest.time) {
          earliest = { time, iso: value };
        }
      }
    }
  }
  return earliest ? earliest.iso : null;
}

export function getEffectiveStatus(connection) {
  const isCooldown = Boolean(getCooldownUntil(connection));
  return connection.testStatus === "unavailable" && !isCooldown
    ? "active"
    : connection.testStatus || "unknown";
}

export function getProviderStats(connections, providerId, authType) {
  const authTypes = Array.isArray(authType) ? authType : [authType];
  const providerConnections = connections.filter(
    (c) => c.provider === providerId && authTypes.includes(c.authType),
  );

  const connected = providerConnections.filter((c) => {
    const status = getEffectiveStatus(c);
    return status === "active" || status === "success";
  }).length;

  const errorConns = providerConnections.filter((c) => {
    const status = getEffectiveStatus(c);
    return status === "error" || status === "expired" || status === "unavailable";
  });

  const error = errorConns.length;
  const total = providerConnections.length;
  const allDisabled = total > 0 && providerConnections.every((c) => c.isActive === false);

  const latestError = errorConns.sort(
    (a, b) => new Date(b.lastErrorAt || 0) - new Date(a.lastErrorAt || 0),
  )[0];
  const errorCode = latestError ? getConnectionErrorTag(latestError) : null;
  const errorTime = latestError?.lastErrorAt ? getRelativeTime(latestError.lastErrorAt) : null;

  return { connected, error, total, errorCode, errorTime, allDisabled };
}

export function getAccountSegments(providerConnections) {
  if (!providerConnections || providerConnections.length === 0) {
    return [{ value: 0, kind: "none", label: "No accounts" }];
  }
  return providerConnections.map((c, i) => {
    const label = c.name || c.email || `Account ${i + 1}`;
    if (c.isActive === false) {
      return { value: 0, kind: "none", label };
    }
    const isCool = Boolean(getCooldownUntil(c));
    const effective = getEffectiveStatus(c);
    if (isCool) {
      return { value: 50, kind: "warn", label };
    }
    if (effective === "error" || effective === "expired") {
      return { value: 100, kind: "err", label };
    }
    return { value: 100, kind: "ok", label };
  });
}

export function matchesProviderListFilter(filter, stats, isNoAuth = false, authGroup = null) {
  if (filter === LIST_FILTERS.ALL) return true;
  if (filter === LIST_FILTERS.CONNECTED) {
    if (isNoAuth) return true;
    return (stats?.connected || 0) > 0;
  }
  if (filter === LIST_FILTERS.NEEDS_ATTENTION) {
    if (isNoAuth) return false;
    return (stats?.error || 0) > 0;
  }
  if (filter === LIST_FILTERS.OAUTH) return authGroup === "oauth";
  if (filter === LIST_FILTERS.FREE) return authGroup === "free";
  if (filter === LIST_FILTERS.APIKEY) return authGroup === "apikey" || authGroup === "compatible";
  return true;
}

export function buildProviderListFilterCounts(entries) {
  const counts = {
    [LIST_FILTERS.ALL]: entries.length,
    [LIST_FILTERS.CONNECTED]: 0,
    [LIST_FILTERS.NEEDS_ATTENTION]: 0,
    [LIST_FILTERS.OAUTH]: 0,
    [LIST_FILTERS.FREE]: 0,
    [LIST_FILTERS.APIKEY]: 0,
  };

  for (const entry of entries) {
    const { stats, isNoAuth, authGroup, hasCooldown } = entry;
    if (isNoAuth || (stats?.connected || 0) > 0) {
      counts[LIST_FILTERS.CONNECTED] += 1;
    }
    if (!isNoAuth && ((stats?.error || 0) > 0 || hasCooldown)) {
      counts[LIST_FILTERS.NEEDS_ATTENTION] += 1;
    }
    if (authGroup === "oauth") counts[LIST_FILTERS.OAUTH] += 1;
    else if (authGroup === "free") counts[LIST_FILTERS.FREE] += 1;
    else if (authGroup === "apikey" || authGroup === "compatible") counts[LIST_FILTERS.APIKEY] += 1;
  }

  return counts;
}

export function countNeedsAttention(entries) {
  return entries.filter((e) => !e.isNoAuth && ((e.stats?.error || 0) > 0 || e.hasCooldown)).length;
}
