"use client";

import PropTypes from "prop-types";
import Card from "@/shared/components/Card";
import ProviderTile from "@/shared/components/ProviderTile";
import { deriveCommandCenterStatus } from "@/shared/utils/commandCenter";
import { WidgetEmpty, WidgetError, WidgetSkeleton } from "./WidgetStates";

/**
 * Map a connection record to the home health status.
 * warn = cooling down (model locks) or degrading test status; err = error/expired.
 * @param {object} connection
 * @param {number} [nowMs]
 * @returns {"ok"|"warn"|"err"|"off"}
 */
export function connectionHealth(connection, nowMs = Date.now()) {
  if (!connection) return "off";
  if (connection.isActive === false) return "off";
  const locked = Object.entries(connection).some(
    ([key, value]) => key.startsWith("modelLock_") && value && new Date(value).getTime() > nowMs,
  );
  if (locked || connection.testStatus === "cooldown") return "warn";
  const status = connection.testStatus;
  if (status === "active" || status === "success" || status === "ok") return "ok";
  if (status === "error" || status === "expired" || status === "unavailable") return "err";
  if (!status) return "ok";
  return "warn";
}

/**
 * Provider health: monogram tile grid with status dots plus a
 * "N need attention" link to Providers. Groups one tile per provider id.
 *
 * @param {object} props
 * @param {Array<object>} props.connections provider connections
 * @param {boolean} props.loading
 * @param {string|null} props.error
 * @param {() => void} props.onRetry
 */
export default function ProviderHealth({ connections, loading, error, onRetry }) {
  if (loading) return <WidgetSkeleton lines={3} label="Loading provider health" />;
  if (error) return <WidgetError message={error} onRetry={onRetry} />;
  if (connections.length === 0) {
    return (
      <WidgetEmpty
        icon="dns"
        title="No providers connected"
        body="Add a provider so traffic has somewhere to go."
        actionLabel="Add a provider"
        actionHref="/dashboard/providers"
      />
    );
  }

  const worstRank = { ok: 0, off: 0, warn: 1, err: 2 };
  const byProvider = new Map();
  for (const connection of connections) {
    const status = connectionHealth(connection);
    const current = byProvider.get(connection.provider);
    if (!current || worstRank[status] > worstRank[current.status]) {
      byProvider.set(connection.provider, { provider: connection.provider, status });
    }
  }
  const providers = [...byProvider.values()].sort((a, b) => a.provider.localeCompare(b.provider));
  const attention = providers.filter(
    (item) => item.status === "warn" || item.status === "err",
  ).length;
  const connected = providers.filter((item) => item.status !== "off").length;
  const statusLine = deriveCommandCenterStatus(
    providers.map((item) => ({ status: item.status === "off" ? "idle" : item.status })),
  );

  return (
    <div className="flex min-w-0 flex-col gap-4">
      <p className="text-[13px] text-muted">
        {connected} connected<span className="sr-only">. {statusLine}</span>
      </p>
      <ul
        className="grid min-w-0 grid-cols-3 gap-x-2.5 gap-y-3.5 sm:grid-cols-4"
        aria-label="Provider health"
      >
        {providers.slice(0, 12).map((item) => (
          <li key={item.provider} className="flex min-w-0 flex-col items-center gap-1.5">
            <ProviderTile
              providerId={item.provider}
              size="md"
              status={item.status === "off" ? "neutral" : item.status}
            />
            <span
              className="w-full truncate text-center text-[11px] text-muted"
              title={item.provider}
            >
              {item.provider}
            </span>
          </li>
        ))}
      </ul>
      {attention > 0 ? (
        <a
          href="/dashboard/providers"
          className="flex items-center gap-2.5 rounded-xl bg-err-bg px-3 py-2.5 text-[13px] text-text"
        >
          <span aria-hidden="true" className="size-2 shrink-0 rounded-full bg-err" />
          {attention} need attention
          <span className="ms-auto font-semibold text-err">Review</span>
        </a>
      ) : null}
    </div>
  );
}

ProviderHealth.propTypes = {
  connections: PropTypes.arrayOf(PropTypes.object),
  loading: PropTypes.bool,
  error: PropTypes.string,
  onRetry: PropTypes.func.isRequired,
};

/** Card wrapper so the page grid stays dumb. */
export function ProviderHealthCard(props) {
  return (
    <Card
      className="min-w-0"
      title="Providers"
      action={
        <a
          href="/dashboard/providers"
          className="text-[13px] font-semibold text-coral-ink hover:text-coral"
        >
          Manage →
        </a>
      }
    >
      <ProviderHealth {...props} />
    </Card>
  );
}
