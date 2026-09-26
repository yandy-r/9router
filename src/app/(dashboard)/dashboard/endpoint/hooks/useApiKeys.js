"use client";

import { useState, useEffect, useCallback } from "react";

/**
 * API-key state for the endpoint page: list (with first-run "Default Key"
 * auto-provision), create (plain text captured once into `revealed`), pause /
 * resume, delete, visibility, and the pause-confirm payload the parent renders.
 * Clipboard stays in the parent via useCopyToClipboard — not here.
 *
 * @returns {object} keys, loading, error, modal/new-name state, revealed +
 * dismissRevealed, visibleIds + toggleVisibility, togglingId, deletingId,
 * confirmState + confirmPauseKey, and the fetch/create/toggle/delete actions.
 */
export function useApiKeys() {
  const [keys, setKeys] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);
  const [showAddModal, setShowAddModal] = useState(false);
  const [newKeyName, setNewKeyName] = useState("");
  /** Just-created key, one-time reveal: { id, name, plain } | null. */
  const [revealed, setRevealed] = useState(null);
  const [visibleKeys, setVisibleKeys] = useState(new Set());
  const [confirmState, setConfirmState] = useState(null);
  const [togglingId, setTogglingId] = useState(null);
  const [deletingId, setDeletingId] = useState(null);

  const fetchKeys = useCallback(async () => {
    const res = await fetch("/api/keys");
    if (!res.ok) return [];
    const data = await res.json();
    return data.keys || [];
  }, []);

  const refresh = useCallback(async () => {
    try {
      setKeys(await fetchKeys());
    } catch (err) {
      setError(err?.message || "Failed to load API keys.");
    }
  }, [fetchKeys]);

  useEffect(() => {
    (async () => {
      try {
        let existing = await fetchKeys();
        // Auto-provision a default key for first-time users so the endpoint works out of the box.
        if (existing.length === 0) {
          try {
            const createRes = await fetch("/api/keys", {
              method: "POST",
              headers: { "Content-Type": "application/json" },
              body: JSON.stringify({ name: "Default Key" }),
            });
            if (createRes.ok) existing = await fetchKeys();
          } catch {
            /* fall through to empty render */
          }
        }
        setKeys(existing);
      } catch (err) {
        setError(err?.message || "Failed to load API keys.");
      } finally {
        setLoading(false);
      }
    })();
  }, [fetchKeys]);

  const createKey = async () => {
    const name = newKeyName.trim();
    if (!name) return;
    try {
      const res = await fetch("/api/keys", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ name }),
      });
      const data = await res.json();
      if (!res.ok) {
        setError(data?.error || "Failed to create API key.");
        return;
      }
      setRevealed({
        id: data.id || data.key?.id,
        name: data.name || name,
        plain: typeof data.key === "string" ? data.key : data.plain || "",
      });
      await refresh();
      setNewKeyName("");
      setShowAddModal(false);
    } catch (err) {
      setError(err?.message || "Failed to create API key.");
    }
  };

  const deleteKey = async (id) => {
    setDeletingId(id);
    try {
      const res = await fetch(`/api/keys/${id}`, { method: "DELETE" });
      if (res.ok) {
        setKeys((prev) => prev.filter((k) => k.id !== id));
        setVisibleKeys((prev) => {
          const next = new Set(prev);
          next.delete(id);
          return next;
        });
      }
    } catch (err) {
      setError(err?.message || "Failed to delete API key.");
    } finally {
      setDeletingId(null);
    }
  };

  const toggleKey = async (id, isActive) => {
    setTogglingId(id);
    try {
      const res = await fetch(`/api/keys/${id}`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ isActive }),
      });
      if (res.ok) {
        setKeys((prev) => prev.map((k) => (k.id === id ? { ...k, isActive } : k)));
      }
    } catch (err) {
      setError(err?.message || "Failed to update API key.");
    } finally {
      setTogglingId(null);
    }
  };

  const toggleVisibility = (keyId) => {
    setVisibleKeys((prev) => {
      const next = new Set(prev);
      if (next.has(keyId)) next.delete(keyId);
      else next.add(keyId);
      return next;
    });
  };

  const dismissRevealed = () => setRevealed(null);

  /**
   * Build the pause-confirm payload for a key; the parent renders it in a
   * ConfirmDialog. Confirm pauses the key then clears.
   * @param {{ id: string, name: string }} apiKey
   */
  const confirmPauseKey = (apiKey) => {
    setConfirmState({
      title: "Pause API Key",
      message: `Pause API key "${apiKey.name}"?\n\nThis key will stop working immediately but can be resumed later.`,
      onConfirm: async () => {
        setConfirmState(null);
        await toggleKey(apiKey.id, false);
      },
    });
  };

  return {
    keys,
    loading,
    error,
    showAddModal,
    setShowAddModal,
    newKeyName,
    setNewKeyName,
    revealed,
    dismissRevealed,
    visibleKeys,
    toggleVisibility,
    confirmState,
    setConfirmState,
    confirmPauseKey,
    togglingId,
    deletingId,
    fetchKeys: refresh,
    createKey,
    deleteKey,
    toggleKey,
  };
}
