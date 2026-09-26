"use client";

import PropTypes from "prop-types";
import { useCallback, useEffect, useState } from "react";
import { Button, Field, Input, Modal, StatusPill } from "@/shared/components";
import { fetchJson } from "./tokenSaverApi";

/**
 * PXPIPE status label from probe + health payloads.
 * @param {object} status
 * @param {{ healthy?: boolean }|null} health
 * @returns {string}
 */
export function pxpipeStatusLabel(status, health) {
  if (!status || status.loading) return "Checking…";
  if (status.installing) return "Installing…";
  if (!status.installed) return "Not installed";
  if (health?.healthy === true) return "Healthy";
  return status.running ? "Running" : "Stopped";
}

/**
 * Experimental row body: min-size + timeout fields, status pill, Setup/Manage
 * and Dashboard actions. Mirrors the board's experimental PXPIPE row.
 * @param {object} props
 * @param {object} props.pxpipe pxpipe status payload
 * @param {{ healthy?: boolean }|null} props.health
 * @param {string|number} props.minChars
 * @param {(value: string|number) => void} props.onMinCharsChange
 * @param {(value: string|number) => void} props.onMinCharsBlur
 * @param {string|number} props.timeoutMs
 * @param {(value: string|number) => void} props.onTimeoutChange
 * @param {(value: string|number) => void} props.onTimeoutBlur
 * @param {() => void} props.onManage
 */
export function PxpipeFields({
  pxpipe,
  health,
  minChars,
  onMinCharsChange,
  onMinCharsBlur,
  timeoutMs,
  onTimeoutChange,
  onTimeoutBlur,
  onManage,
}) {
  const label = pxpipeStatusLabel(pxpipe, health);
  return (
    <div className="flex flex-wrap items-end gap-3">
      <Field label="Min size" hint="Requests smaller than this bypass PXPIPE." className="w-36">
        {({ inputId, describedBy }) => (
          <Input
            id={inputId}
            aria-describedby={describedBy}
            value={String(minChars ?? 25000)}
            onChange={(event) => onMinCharsChange(event.target.value)}
            onBlur={(event) => onMinCharsBlur(event.target.value)}
            className="font-mono text-[13px]"
          />
        )}
      </Field>
      <Field label="Timeout" hint="PXPIPE render timeout in milliseconds." className="w-32">
        {({ inputId, describedBy }) => (
          <Input
            id={inputId}
            aria-describedby={describedBy}
            value={String(timeoutMs ?? 15000)}
            onChange={(event) => onTimeoutChange(event.target.value)}
            onBlur={(event) => onTimeoutBlur(event.target.value)}
            className="font-mono text-[13px]"
          />
        )}
      </Field>
      <span className="ms-auto inline-flex items-center gap-2">
        <StatusPill variant={health?.healthy === true || pxpipe.running ? "ok" : "warn"} size="sm">
          {label}
        </StatusPill>
        <Button variant="ghost" size="sm" onClick={onManage}>
          {pxpipe.installed ? "Manage" : "Setup"}
        </Button>
        <Button variant="ghost" size="sm" href="/dashboard/pxpipe">
          Dashboard
        </Button>
      </span>
    </div>
  );
}

PxpipeFields.propTypes = {
  pxpipe: PropTypes.object.isRequired,
  health: PropTypes.object,
  minChars: PropTypes.oneOfType([PropTypes.string, PropTypes.number]),
  onMinCharsChange: PropTypes.func.isRequired,
  onMinCharsBlur: PropTypes.func.isRequired,
  timeoutMs: PropTypes.oneOfType([PropTypes.string, PropTypes.number]),
  onTimeoutChange: PropTypes.func.isRequired,
  onTimeoutBlur: PropTypes.func.isRequired,
  onManage: PropTypes.func.isRequired,
};

/**
 * Manage PXPIPE modal: install/repair/start/stop/restart with progress and
 * error, health panel, min-size + timeout fields.
 * @param {object} props
 * @param {boolean} props.open
 * @param {() => void} props.onClose
 * @param {object} props.pxpipe status payload
 * @param {{ healthy?: boolean, checks?: Array, error?: string }|null} props.health
 * @param {() => Promise<void>} props.onRecheck
 */
export function PxpipeModal({ open, onClose, pxpipe, health, onRecheck }) {
  const [minCharsDraft, setMinCharsDraft] = useState("");
  const [timeoutDraft, setTimeoutDraft] = useState("");
  const [actionLoading, setActionLoading] = useState(false);
  const [actionError, setActionError] = useState("");
  const label = pxpipeStatusLabel(pxpipe, health);

  useEffect(() => {
    if (open) {
      (async () => {
        try {
          const settings = await fetchJson("/api/settings");
          setMinCharsDraft(String(settings.pxpipeMinChars ?? 25000));
          setTimeoutDraft(String(settings.pxpipeTimeoutMs ?? 15000));
        } catch {
          /* keep previous drafts */
        }
      })();
    }
  }, [open]);

  const savePatch = async (patch) => {
    try {
      await fetchJson("/api/settings", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(patch),
      });
      return true;
    } catch (error) {
      setActionError(error.message);
      return false;
    }
  };

  const action = async (endpoint) => {
    setActionError("");
    setActionLoading(true);
    try {
      await fetchJson(`/api/pxpipe/${endpoint}`, { method: "POST" });
      await onRecheck();
    } catch (error) {
      setActionError(error.message);
    } finally {
      setActionLoading(false);
    }
  };

  const handleMinCharsBlur = async () => {
    const next = Math.max(0, Number(minCharsDraft) || 25000);
    setMinCharsDraft(String(next));
    await savePatch({ pxpipeMinChars: next });
  };

  const handleTimeoutBlur = async () => {
    const raw = Math.round(Number(timeoutDraft));
    const next = Number.isFinite(raw) && raw > 0 ? raw : 15000;
    setTimeoutDraft(String(next));
    await savePatch({ pxpipeTimeoutMs: next });
  };

  return (
    <Modal isOpen={open} title={pxpipe.installed ? "PXPIPE" : "Setup PXPIPE"} onClose={onClose}>
      <div className="flex flex-col gap-4">
        <p className="text-sm text-muted">
          Compress prompts using multimodal encoding. Runs in-process — no extra server or
          environment variables required.
        </p>
        <div className="flex items-center justify-between text-sm">
          <span>Status</span>
          <span className={health?.healthy === true || pxpipe.running ? "text-ok" : "text-warn"}>
            {label}
            {pxpipe.version ? ` · v${pxpipe.version}` : ""}
          </span>
        </div>
        {health?.checks?.length > 0 && (
          <div className="flex flex-col gap-1 rounded-xl border border-line p-3">
            <p className="mb-1 text-sm font-medium">Health check</p>
            {health.checks.map((check) => (
              <div key={check.id} className="flex items-center justify-between text-xs">
                <span className={check.ok ? "text-ok" : "text-warn"}>
                  {check.ok ? "●" : "○"} {check.label}
                </span>
                {check.detail && (
                  <span className="max-w-[50%] truncate font-mono text-muted">{check.detail}</span>
                )}
              </div>
            ))}
            {health.error && <p className="mt-1 text-xs text-warn">{health.error}</p>}
          </div>
        )}
        {!pxpipe.installed ? (
          <div className="flex flex-col gap-2">
            <p className="text-sm text-warn">PXPIPE is not installed.</p>
            <Button
              onClick={() => action("install")}
              fullWidth
              loading={actionLoading || pxpipe.installing}
            >
              Install
            </Button>
            <p className="text-xs text-muted">
              Installs the npm package <code className="font-mono">pxpipe-proxy</code> into the
              9Router data directory. May take a few minutes.
            </p>
          </div>
        ) : (
          <div className="grid grid-cols-2 gap-2">
            {pxpipe.running ? (
              <>
                <Button onClick={() => action("restart")} variant="ghost" loading={actionLoading}>
                  Restart
                </Button>
                <Button onClick={() => action("stop")} variant="ghost" loading={actionLoading}>
                  Stop
                </Button>
              </>
            ) : (
              <Button onClick={() => action("start")} loading={actionLoading}>
                Start
              </Button>
            )}
            <Button onClick={() => action("install")} variant="ghost" loading={actionLoading}>
              Repair
            </Button>
            <a
              href="/dashboard/pxpipe#logs"
              className="col-span-2 rounded-xl border border-line px-4 py-2 text-center text-sm hover:bg-raised"
            >
              Open Logs
            </a>
          </div>
        )}
        <Field
          label="Minimum prompt size (chars)"
          hint="Requests smaller than this bypass PXPIPE and are sent as-is."
        >
          {({ inputId, describedBy }) => (
            <Input
              id={inputId}
              aria-describedby={describedBy}
              value={minCharsDraft}
              onChange={(event) => setMinCharsDraft(event.target.value)}
              onBlur={handleMinCharsBlur}
              className="font-mono text-sm"
            />
          )}
        </Field>
        <Field label="Timeout (ms)" hint="PXPIPE render timeout in milliseconds.">
          {({ inputId, describedBy }) => (
            <Input
              id={inputId}
              aria-describedby={describedBy}
              value={timeoutDraft}
              onChange={(event) => setTimeoutDraft(event.target.value)}
              onBlur={handleTimeoutBlur}
              className="font-mono text-sm"
            />
          )}
        </Field>
        {actionError && <p className="text-sm text-warn">{actionError}</p>}
        <div className="flex gap-2">
          <Button onClick={onRecheck} variant="ghost" fullWidth>
            Recheck
          </Button>
          <Button onClick={onClose} fullWidth>
            Done
          </Button>
        </div>
      </div>
    </Modal>
  );
}

PxpipeModal.propTypes = {
  open: PropTypes.bool.isRequired,
  onClose: PropTypes.func.isRequired,
  pxpipe: PropTypes.object.isRequired,
  health: PropTypes.object,
  onRecheck: PropTypes.func.isRequired,
};

/**
 * PXPIPE probe state: status + health with a single recheck. Self-fetches on
 * mount so the pill never sticks on "Checking…" when the parent settings load fails.
 * @returns {{ pxpipe: object, health: object|null, recheck: () => Promise<void> }}
 */
export function usePxpipeStatus() {
  const [pxpipe, setPxpipe] = useState({ loading: true });
  const [health, setHealth] = useState(null);

  const recheck = useCallback(async () => {
    setPxpipe((s) => ({ ...s, loading: true }));
    try {
      const data = await fetchJson("/api/pxpipe/status");
      setPxpipe({ ...data, loading: false });
    } catch {
      setPxpipe({ installed: false, installing: false, running: false, loading: false });
    }
    try {
      const healthRes = await fetch("/api/pxpipe/health", { method: "POST" });
      const healthData = await healthRes.json().catch(() => ({}));
      if (!healthRes.ok)
        throw new Error(healthData.error || `Health check failed (${healthRes.status})`);
      setHealth(healthData);
    } catch (error) {
      setHealth({ healthy: false, checks: [], error: error.message });
    }
  }, []);

  useEffect(() => {
    recheck();
  }, [recheck]);

  return { pxpipe, health, recheck };
}
