// Weighted-target resolution (YAN-259). Neutral module so the usage route and the
// snapshot poller can share it without a route <-> poller import cycle.
import { getSettings, getCombos } from "@/lib/localDb";
import { parseModel } from "open-sse/services/model.js";

// Weighted combos name their providers by combo model prefix; combos without a
// per-combo entry inherit settings.comboStrategy. Prefix before "/" is enough.
function comboIsWeighted(combo, settings) {
  const specific = settings?.comboStrategies?.[combo?.name]?.fallbackStrategy;
  return (specific || settings?.comboStrategy || "fallback") === "weighted";
}

export function weightedProviders(settings, combos) {
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
    return weightedProviders(settings, combos).has(provider);
  } catch {
    return false;
  }
}
