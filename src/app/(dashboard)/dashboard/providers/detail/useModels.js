"use client";

import { useCallback, useEffect, useState } from "react";
import { getModelKind } from "@/shared/constants/models";
import { fetchSuggestedModels } from "@/shared/utils/providerModelsFetcher";
import { getProviderCustomModelRows } from "@/shared/utils/providerCustomModels";
import { getModelsFetcher } from "./providerDetailMeta";

/**
 * Models state for one provider detail page: aliases, custom models,
 * suggested catalog, disabled ids, thinking mode, per-model tests.
 *
 * @param {object} args
 * @param {string} args.providerId
 * @param {string} args.storageAlias
 * @param {Array<object>} args.staticModels
 * @param {Array<object>} args.catalogModels
 * @param {(message: string) => void} [args.notifyError]
 */
export function useModels({ providerId, storageAlias, staticModels, catalogModels, notifyError }) {
  const [modelAliases, setModelAliases] = useState({});
  const [customModels, setCustomModels] = useState([]);
  const [suggestedModels, setSuggestedModels] = useState([]);
  const [kiloFreeModels, setKiloFreeModels] = useState([]);
  const [disabledModelIds, setDisabledModelIds] = useState([]);
  const [thinkingMode, setThinkingMode] = useState("auto");
  const [testResults, setTestResults] = useState({});
  const [testError, setTestError] = useState("");
  const [testingIds, setTestingIds] = useState(() => new Set());
  const [showAddCustomModel, setShowAddCustomModel] = useState(false);

  const fetchAliases = useCallback(async () => {
    try {
      const res = await fetch("/api/models/alias");
      const data = await res.json().catch(() => ({}));
      if (res.ok) setModelAliases(data.aliases || {});
    } catch (error) {
      console.log("Error fetching aliases:", error);
    }
  }, []);

  const fetchCustomModels = useCallback(async () => {
    try {
      const res = await fetch("/api/models/custom", { cache: "no-store" });
      const data = await res.json().catch(() => ({}));
      if (res.ok) setCustomModels(data.models || []);
    } catch (error) {
      console.log("Error fetching custom models:", error);
    }
  }, []);

  const fetchDisabledModels = useCallback(async () => {
    try {
      const res = await fetch(
        `/api/models/disabled?providerAlias=${encodeURIComponent(storageAlias)}`,
        { cache: "no-store" },
      );
      const data = await res.json().catch(() => ({}));
      if (res.ok) setDisabledModelIds(data.ids || []);
    } catch (error) {
      console.log("Error fetching disabled models:", error);
    }
  }, [storageAlias]);

  const load = useCallback(async () => {
    await Promise.all([fetchAliases(), fetchCustomModels(), fetchDisabledModels()]);
  }, [fetchAliases, fetchCustomModels, fetchDisabledModels]);

  useEffect(() => {
    if (providerId !== "kilocode") return;
    fetch("/api/providers/kilo/free-models")
      .then((res) => res.json())
      .then((data) => {
        if (data.models?.length) setKiloFreeModels(data.models);
      })
      .catch(() => {});
  }, [providerId]);

  useEffect(() => {
    const fetcher = getModelsFetcher(providerId);
    if (!fetcher) return;
    fetchSuggestedModels(fetcher).then(setSuggestedModels);
  }, [providerId]);

  const loadThinking = useCallback(async () => {
    try {
      const res = await fetch("/api/settings", { cache: "no-store" });
      const data = res.ok ? await res.json() : {};
      const thinkingCfg = data.providerThinking?.[providerId] || {};
      setThinkingMode(thinkingCfg.mode || "auto");
    } catch (error) {
      console.log("Error loading thinking config:", error);
    }
  }, [providerId]);

  const changeThinking = useCallback(
    async (mode) => {
      setThinkingMode(mode);
      try {
        const settingsRes = await fetch("/api/settings", { cache: "no-store" });
        const settingsData = settingsRes.ok ? await settingsRes.json() : {};
        const current = settingsData.providerThinking || {};
        const updated = { ...current };
        if (!mode || mode === "auto") delete updated[providerId];
        else updated[providerId] = { mode };
        await fetch("/api/settings", {
          method: "PATCH",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ providerThinking: updated }),
        });
      } catch (error) {
        console.log("Error saving thinking config:", error);
      }
    },
    [providerId],
  );

  const testModel = useCallback(
    async (modelId) => {
      if (!modelId) return;
      let started = false;
      setTestingIds((prev) => {
        if (prev.has(modelId)) return prev;
        started = true;
        return new Set(prev).add(modelId);
      });
      if (!started) return;
      try {
        const res = await fetch("/api/models/test", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ model: `${storageAlias}/${modelId}` }),
        });
        const data = await res.json().catch(() => ({}));
        setTestResults((prev) => ({ ...prev, [modelId]: data.ok ? "ok" : "error" }));
        setTestError(data.ok ? "" : data.error || "Model not reachable");
        if (!data.ok) notifyError?.(data.error || "Model not reachable");
      } catch {
        setTestResults((prev) => ({ ...prev, [modelId]: "error" }));
        setTestError("Network error");
        notifyError?.("Network error");
      } finally {
        setTestingIds((prev) => {
          const next = new Set(prev);
          next.delete(modelId);
          return next;
        });
      }
    },
    [notifyError, storageAlias],
  );

  const setAlias = useCallback(
    async (modelId, alias, aliasOverride = null) => {
      const fullModel = `${aliasOverride || storageAlias}/${modelId}`;
      try {
        const res = await fetch("/api/models/alias", {
          method: "PUT",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ model: fullModel, alias }),
        });
        if (res.ok) await fetchAliases();
        else {
          const data = await res.json().catch(() => ({}));
          notifyError?.(data.error || "Failed to set alias");
        }
      } catch (error) {
        console.log("Error setting alias:", error);
      }
    },
    [fetchAliases, notifyError, storageAlias],
  );

  const deleteAlias = useCallback(
    async (alias) => {
      try {
        const res = await fetch(`/api/models/alias?alias=${encodeURIComponent(alias)}`, {
          method: "DELETE",
        });
        if (res.ok) await fetchAliases();
      } catch (error) {
        console.log("Error deleting alias:", error);
      }
    },
    [fetchAliases],
  );

  const addCustomModel = useCallback(
    async (modelId, type = "llm", aliasOverride = storageAlias, caps) => {
      try {
        const res = await fetch("/api/models/custom", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            providerAlias: aliasOverride,
            id: modelId,
            type,
            ...(caps ? { caps } : {}),
          }),
        });
        if (res.ok) {
          await fetchCustomModels();
          if (typeof window !== "undefined") {
            window.dispatchEvent(new CustomEvent("customModelChanged"));
          }
        } else {
          const data = await res.json().catch(() => ({}));
          notifyError?.(data.error || "Failed to add custom model");
        }
      } catch (error) {
        console.log("Error adding custom model:", error);
      }
    },
    [fetchCustomModels, notifyError, storageAlias],
  );

  const deleteCustomModel = useCallback(
    async (modelId, type = "llm", aliasOverride = storageAlias) => {
      try {
        const params = new URLSearchParams({
          providerAlias: aliasOverride,
          id: modelId,
          type,
        });
        const res = await fetch(`/api/models/custom?${params}`, { method: "DELETE" });
        if (res.ok) {
          await fetchCustomModels();
          if (typeof window !== "undefined") {
            window.dispatchEvent(new CustomEvent("customModelChanged"));
          }
        }
      } catch (error) {
        console.log("Error deleting custom model:", error);
      }
    },
    [fetchCustomModels, storageAlias],
  );

  const disableModel = useCallback(
    async (modelId) => {
      try {
        const res = await fetch("/api/models/disabled", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ providerAlias: storageAlias, ids: [modelId] }),
        });
        if (res.ok) await fetchDisabledModels();
      } catch (error) {
        console.log("Error disabling model:", error);
      }
    },
    [fetchDisabledModels, storageAlias],
  );

  const enableModel = useCallback(
    async (modelId) => {
      try {
        const res = await fetch(
          `/api/models/disabled?providerAlias=${encodeURIComponent(storageAlias)}&id=${encodeURIComponent(modelId)}`,
          { method: "DELETE" },
        );
        if (res.ok) await fetchDisabledModels();
      } catch (error) {
        console.log("Error enabling model:", error);
      }
    },
    [fetchDisabledModels, storageAlias],
  );

  const disableAll = useCallback(
    async (ids, requestConfirm) => {
      if (!ids.length) return;
      requestConfirm({
        title: "Disable All Models",
        message: `Disable all ${ids.length} model(s)?`,
        onConfirm: async () => {
          try {
            const res = await fetch("/api/models/disabled", {
              method: "POST",
              headers: { "Content-Type": "application/json" },
              body: JSON.stringify({ providerAlias: storageAlias, ids }),
            });
            if (res.ok) await fetchDisabledModels();
          } catch (error) {
            console.log("Error disabling all models:", error);
          }
        },
      });
    },
    [fetchDisabledModels, storageAlias],
  );

  const enableAll = useCallback(async () => {
    try {
      const res = await fetch(
        `/api/models/disabled?providerAlias=${encodeURIComponent(storageAlias)}`,
        { method: "DELETE" },
      );
      if (res.ok) await fetchDisabledModels();
    } catch (error) {
      console.log("Error enabling all models:", error);
    }
  }, [fetchDisabledModels, storageAlias]);

  const allModels = [
    ...catalogModels,
    ...kiloFreeModels.filter((free) => !catalogModels.some((model) => model.id === free.id)),
  ].filter((model) => {
    const kind = getModelKind(model);
    return !kind || kind === "llm";
  });
  const disabledSet = new Set(disabledModelIds);
  const enabledModels = allModels.filter((model) => !disabledSet.has(model.id));
  const disabledModels = allModels.filter((model) => disabledSet.has(model.id));
  const customModelRows = getProviderCustomModelRows({
    customModels,
    modelAliases,
    providerAlias: storageAlias,
    builtInModels: staticModels,
    type: "llm",
  });

  return {
    modelAliases,
    customModels,
    customModelRows,
    suggestedModels,
    kiloFreeModels,
    disabledModelIds,
    enabledModels,
    disabledModels,
    thinkingMode,
    testResults,
    testError,
    testingIds,
    showAddCustomModel,
    setShowAddCustomModel,
    load,
    loadThinking,
    changeThinking,
    testModel,
    setAlias,
    deleteAlias,
    addCustomModel,
    deleteCustomModel,
    disableModel,
    enableModel,
    disableAll,
    enableAll,
  };
}
