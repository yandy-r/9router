"use client";

import { useState } from "react";
import PropTypes from "prop-types";
import { translate } from "@/i18n/runtime";
import { selectModelsToImport } from "@/shared/utils/liveModels";

/**
 * Re-fetches the provider's live catalog (bypassing the server cache) and imports
 * every model not already available as a custom model.
 */
export default function FetchModelsButton({
  providerId,
  refresh,
  staticModels,
  customModels,
  modelAliases,
  providerStorageAlias,
  onAddModel,
}) {
  const [fetching, setFetching] = useState(false);

  const handleClick = async () => {
    if (fetching) return;
    setFetching(true);
    try {
      const { models, warning } = await refresh();
      if (models.length === 0) {
        alert(translate("No models returned") + (warning ? `: ${warning}` : ""));
        return;
      }

      const ids = selectModelsToImport({
        providerId,
        liveModels: models,
        staticModels,
        customModels,
        modelAliases,
        providerStorageAlias,
      });
      // Sequential on purpose: each add refetches the custom model list.
      for (const id of ids) {
        await onAddModel(id);
      }

      if (ids.length === 0) {
        alert(translate("All models already exist, no new models added"));
      } else {
        alert(translate("Successfully added") + ` ${ids.length} ` + translate("models"));
      }
    } catch (error) {
      console.log(`Error fetching ${providerId} models:`, error);
      alert(translate("Error fetching models") + ": " + error.message);
    } finally {
      setFetching(false);
    }
  };

  return (
    <button
      onClick={handleClick}
      disabled={fetching}
      className="flex w-full items-center justify-center gap-1.5 rounded-lg border border-dashed border-blue-500/40 px-3 py-2 text-xs text-blue-600 dark:text-blue-400 transition-colors hover:border-blue-500 hover:bg-blue-500/5 sm:w-auto disabled:opacity-50 disabled:cursor-not-allowed"
    >
      <span
        className="material-symbols-outlined text-sm"
        style={fetching ? { animation: "spin 1s linear infinite" } : undefined}
      >
        {fetching ? "progress_activity" : "download"}
      </span>
      {fetching ? translate("Fetching...") : translate("Fetch Models")}
    </button>
  );
}

FetchModelsButton.propTypes = {
  providerId: PropTypes.string.isRequired,
  refresh: PropTypes.func.isRequired,
  staticModels: PropTypes.array.isRequired,
  customModels: PropTypes.array.isRequired,
  modelAliases: PropTypes.object.isRequired,
  providerStorageAlias: PropTypes.string.isRequired,
  onAddModel: PropTypes.func.isRequired,
};
