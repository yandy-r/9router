// Weighted-target resolution (YAN-259). Neutral module so the usage route and the
// snapshot poller can share it without a route <-> poller import cycle.
import { getSettings, getCombos } from "@/lib/localDb";
import { parseModel } from "open-sse/services/model.js";

import { resolveComboStrategy } from "open-sse/services/comboStrategy.js";

// Weighted combos name their providers by combo model prefix; combos without a
// per-combo entry inherit settings.comboStrategy. Prefix before "/" is enough.
function comboIsWeighted(combo, settings) {
  return resolveComboStrategy(settings, combo?.name).strategy === "weighted";
}

export function weightedProviders(settings, combos, providerIds = []) {
  const direct = new Set(
    Object.entries(settings?.providerStrategies || {})
      .filter(([, strategy]) => strategy?.fallbackStrategy === "weighted")
      .map(([provider]) => provider),
  );
  if (settings?.fallbackStrategy === "weighted") {
    for (const provider of providerIds) {
      if (
        provider &&
        (settings.providerStrategies?.[provider]?.fallbackStrategy || "weighted") === "weighted"
      ) {
        direct.add(provider);
      }
    }
  }
  for (const combo of combos || []) {
    if (!comboIsWeighted(combo, settings)) continue;
    for (const model of combo?.models || []) {
      try {
        const raw = typeof model === "string" ? model : (model?.model ?? model?.name);
        if (typeof raw !== "string") continue;
        const { provider, isAlias } = parseModel(raw);
        if (!isAlias && provider) direct.add(provider);
      } catch {
        // One malformed combo model must not abort resolution.
      }
    }
  }
  return direct;
}

// Never throws: any lookup failure means "not weighted".
export async function isWeightedProvider(provider, deps = { getSettings, getCombos }) {
  try {
    const settings = await deps.getSettings();
    const combos = deps.getCombos ? await deps.getCombos().catch(() => []) : [];
    // Global weighted applies to any provider without its own override.
    return weightedProviders(settings, combos, [provider]).has(provider);
  } catch {
    return false;
  }
}
