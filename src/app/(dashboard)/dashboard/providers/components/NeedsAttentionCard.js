"use client";

import PropTypes from "prop-types";
import { useState, useEffect } from "react";
import { Button, ProviderTile } from "@/shared/components";
import { getRelativeTime } from "@/shared/utils";
import { getCooldownUntil, getConnectionErrorTag } from "../utils";

function CooldownTimer({ until }) {
  const [remaining, setRemaining] = useState("");

  useEffect(() => {
    const update = () => {
      const diff = new Date(until).getTime() - Date.now();
      if (diff <= 0) {
        setRemaining("");
        return;
      }
      const s = Math.floor(diff / 1000);
      if (s < 60) setRemaining(`${s}s`);
      else if (s < 3600) setRemaining(`${Math.floor(s / 60)}m ${s % 60}s`);
      else setRemaining(`${Math.floor(s / 3600)}h ${Math.floor((s % 3600) / 60)}m`);
    };
    update();
    const t = setInterval(update, 1000);
    return () => clearInterval(t);
  }, [until]);

  if (!remaining) return null;
  return (
    <span className="font-mono text-xs text-warn" aria-live="off">
      {remaining} left
    </span>
  );
}

CooldownTimer.propTypes = { until: PropTypes.string.isRequired };

function shorten(message) {
  const clean = String(message || "")
    .replace(/\s+/g, " ")
    .trim();
  return clean.length > 90 ? `${clean.slice(0, 90)}…` : clean;
}

export default function NeedsAttentionCard({ entry, connections, testing, onRetry, onOpen }) {
  const cooldownConn = connections.find((c) => getCooldownUntil(c));
  const errorConn = [...connections].sort(
    (a, b) => new Date(b.lastErrorAt || 0) - new Date(a.lastErrorAt || 0),
  )[0];
  const until = cooldownConn ? getCooldownUntil(cooldownConn) : null;
  const isAuth = getConnectionErrorTag(errorConn) === "AUTH";

  const reason = cooldownConn
    ? `${getConnectionErrorTag(cooldownConn)} on ${
        connections.length > 1 ? `${connections.length} accounts` : "1 account"
      }`
    : errorConn?.lastError
      ? shorten(errorConn.lastError)
      : "Requests are skipping this provider";
  const actionLabel = cooldownConn ? "Retry now" : isAuth ? "Reconnect" : "Retry now";

  return (
    <div
      className={`flex items-center gap-3.5 rounded-2xl border p-4 ${
        cooldownConn ? "border-warn bg-warn-bg" : "border-err bg-err-bg"
      }`}
    >
      <ProviderTile providerId={entry.id} size="md" />
      <div className="flex min-w-0 flex-1 flex-col gap-0.5">
        <button
          type="button"
          onClick={onOpen}
          className="truncate text-start text-[15px] font-semibold focus-visible:outline-none focus-visible:shadow-focus"
        >
          {entry.info.name} {cooldownConn ? "is cooling down" : "needs attention"}
        </button>
        <span className="flex flex-wrap items-center gap-x-2 gap-y-0.5 text-[13px] text-muted">
          <span>{reason}</span>
          {until && <CooldownTimer until={until} />}
          {errorConn?.lastErrorAt && <span>{getRelativeTime(errorConn.lastErrorAt)}</span>}
        </span>
      </div>
      <Button
        size="sm"
        variant={isAuth && !cooldownConn ? "primary" : "secondary"}
        loading={testing}
        disabled={testing}
        onClick={onRetry}
      >
        {testing ? "Retrying…" : actionLabel}
      </Button>
    </div>
  );
}

NeedsAttentionCard.propTypes = {
  entry: PropTypes.object.isRequired,
  connections: PropTypes.array.isRequired,
  testing: PropTypes.bool,
  onRetry: PropTypes.func.isRequired,
  onOpen: PropTypes.func.isRequired,
};
