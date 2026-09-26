/**
 * Pure helpers for the Token saver page (YAN-303). No React/DOM.
 * Headroom status mapping mirrors the legacy TokenSaverClient labels;
 * savings share + $ estimate are driven by the YAN-292 aggregation.
 */

/**
 * Map headroom probe status to the board pill label.
 * @param {{ loading?: boolean, running?: boolean, installed?: boolean, localUrl?: boolean }|null|undefined} status
 * @returns {"Checking…"|"Running"|"Not installed"|"Stopped"|"External"}
 */
export function headroomStatusLabel(status) {
  if (!status || status.loading) return "Checking…";
  if (status.running) return "Running";
  if (status.localUrl === false) return "External";
  return status.installed ? "Stopped" : "Not installed";
}

/**
 * Per-method share of total saved tokens as whole percents. Largest-remainder
 * rounded so hero segments + footers always sum to 100.
 * @param {{ tokensSavedEst?: number, byMethod?: Record<string, { tokensSavedEst?: number }> }|null|undefined} savings
 * @returns {Record<string, number>}
 */
export function savingsShare(savings) {
  const total = Number(savings?.tokensSavedEst) || 0;
  if (total <= 0) return {};
  const entries = [];
  for (const [method, entry] of Object.entries(savings?.byMethod || {})) {
    const saved = Number(entry?.tokensSavedEst) || 0;
    if (saved > 0) entries.push({ method, exact: (saved / total) * 100 });
  }
  if (entries.length === 0) return {};
  // Largest remainder: floor all, hand leftover points to biggest fractions.
  const floored = entries.map(({ method, exact }) => ({
    method,
    base: Math.floor(exact),
    frac: exact - Math.floor(exact),
  }));
  const leftover = 100 - floored.reduce((sum, item) => sum + item.base, 0);
  floored.sort((a, b) => b.frac - a.frac);
  const out = {};
  for (const [index, item] of floored.entries()) {
    out[item.method] = item.base + (index < leftover ? 1 : 0);
  }
  return out;
}

/**
 * Approximate $ value of saved tokens at list prices. Saved traffic is mostly
 * prompt-side compression, so blend input/output list rates instead of
 * assuming a single rate; callers pass resolved pricing (never hardcoded).
 * @param {number} tokensSavedEst
 * @param {{ input?: number, output?: number }|null|undefined} pricing $/1M tokens
 * @returns {number} dollars
 */
export function estimateSavingsCost(tokensSavedEst, pricing) {
  const saved = Number(tokensSavedEst) || 0;
  const input = Number(pricing?.input);
  const output = Number(pricing?.output);
  if (saved <= 0 || !Number.isFinite(input) || !Number.isFinite(output)) return 0;
  return (saved * ((input + output) / 2)) / 1_000_000;
}

/**
 * Human names for recorded token-saver methods.
 */
export const SAVINGS_METHOD_LABELS = {
  rtk: "Tool output",
  headroom: "Context",
  pxpipe: "PXPIPE",
};

/**
 * Stacked-bar segment opacities (darkest = largest share), board order.
 */
export const SAVINGS_SEGMENT_ORDER = ["rtk", "headroom", "pxpipe"];

export const SAVINGS_PERIODS = [
  { value: "today", label: "Today" },
  { value: "7d", label: "7d" },
  { value: "30d", label: "30d" },
];
