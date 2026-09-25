"use client";

import { useState, useEffect, useCallback } from "react";
import PropTypes from "prop-types";
import Modal from "./Modal";
import Button from "./Button";
import Callout from "./Callout";
import Input from "./Input";
import Textarea from "./Textarea";
import { Spinner } from "./Loading";

/**
 * Cursor token import: auto-detects from the IDE's local SQLite database,
 * falls back to manual paste. Windows may need an explicit retry.
 */
export default function CursorAuthModal({ isOpen, onSuccess, onClose }) {
  const [accessToken, setAccessToken] = useState("");
  const [machineId, setMachineId] = useState("");
  const [error, setError] = useState(null);
  const [importing, setImporting] = useState(false);
  const [autoDetecting, setAutoDetecting] = useState(false);
  const [autoDetected, setAutoDetected] = useState(false);
  const [windowsManual, setWindowsManual] = useState(false);

  const runAutoDetect = useCallback(async () => {
    setAutoDetecting(true);
    setError(null);
    setAutoDetected(false);
    setWindowsManual(false);

    try {
      const res = await fetch("/api/oauth/cursor/auto-import");
      const data = await res.json();

      if (data.found) {
        setAccessToken(data.accessToken);
        setMachineId(data.machineId);
        setAutoDetected(true);
      } else if (data.windowsManual) {
        setWindowsManual(true);
      } else {
        setError(data.error || "Could not auto-detect tokens");
      }
    } catch {
      setError("Failed to auto-detect tokens");
    } finally {
      setAutoDetecting(false);
    }
  }, []);

  // Auto-detect tokens when modal opens
  useEffect(() => {
    if (!isOpen) return;
    runAutoDetect();
  }, [isOpen, runAutoDetect]);

  const handleImportToken = async () => {
    if (!accessToken.trim()) {
      setError("Please enter an access token");
      return;
    }
    if (!machineId.trim()) {
      setError("Please enter a machine ID");
      return;
    }
    setImporting(true);
    setError(null);
    try {
      const res = await fetch("/api/oauth/cursor/import", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ accessToken: accessToken.trim(), machineId: machineId.trim() }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || "Import failed");
      onSuccess?.();
      onClose();
    } catch (err) {
      setError(err.message);
    } finally {
      setImporting(false);
    }
  };

  return (
    <Modal isOpen={isOpen} title="Connect Cursor IDE" onClose={onClose}>
      <div className="flex flex-col gap-4">
        {autoDetecting && (
          <div className="py-6 text-center">
            <div className="mx-auto mb-4 flex size-16 items-center justify-center rounded-full bg-coral-bg">
              <Spinner size="lg" />
            </div>
            <h3 className="mb-2 text-lg font-semibold">Auto-detecting tokens...</h3>
            <p className="text-sm text-muted">Reading from Cursor IDE database</p>
          </div>
        )}

        {!autoDetecting && (
          <>
            {autoDetected && (
              <Callout variant="ok">Tokens auto-detected from Cursor IDE successfully!</Callout>
            )}

            {windowsManual && (
              <Callout
                variant="warn"
                icon="info"
                title="Could not read Cursor database automatically."
              >
                Make sure Cursor IDE has been opened at least once, then click Retry. If the problem
                persists, paste your tokens manually below.
                <Button onClick={runAutoDetect} variant="outline" fullWidth className="mt-2">
                  Retry
                </Button>
              </Callout>
            )}

            {!autoDetected && !windowsManual && !error && (
              <Callout variant="info">
                Cursor IDE not detected. Please paste your tokens manually.
              </Callout>
            )}

            <Textarea
              label="Access Token"
              required
              rows={3}
              value={accessToken}
              onChange={(e) => setAccessToken(e.target.value)}
              placeholder="Access token will be auto-filled..."
              textareaClassName="font-mono text-sm"
            />

            <Input
              label="Machine ID"
              required
              value={machineId}
              onChange={(e) => setMachineId(e.target.value)}
              placeholder="Machine ID will be auto-filled..."
              inputClassName="font-mono text-sm"
            />

            {error && <Callout variant="err">{error}</Callout>}

            <div className="flex gap-2">
              <Button
                onClick={handleImportToken}
                fullWidth
                disabled={importing || !accessToken.trim() || !machineId.trim()}
              >
                {importing ? "Importing..." : "Import Token"}
              </Button>
              <Button onClick={onClose} variant="ghost" fullWidth>
                Cancel
              </Button>
            </div>
          </>
        )}
      </div>
    </Modal>
  );
}

CursorAuthModal.propTypes = {
  isOpen: PropTypes.bool.isRequired,
  onSuccess: PropTypes.func,
  onClose: PropTypes.func.isRequired,
};
