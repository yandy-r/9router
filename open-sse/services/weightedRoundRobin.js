/**
 * Pick one candidate using nginx-style smooth weighted round-robin.
 *
 * Stickiness windows, floor filtering, and "all below floor -> use everyone"
 * policies belong to callers. Callers also own state persistence, such as an
 * in-memory Map per provider or combo.
 *
 * @param {Array<{id: string, weight: number}>} candidates Effective-weight candidates.
 * @param {Map<string, number> | null | undefined} currentWeights Prior smooth-WRR state.
 * @returns {{id: string | null, currentWeights: Map<string, number>}}
 */
export function pickSmoothWeighted(candidates, currentWeights) {
  try {
    if (!Array.isArray(candidates)) {
      return { id: null, currentWeights: new Map() };
    }

    const previous = currentWeights instanceof Map ? currentWeights : new Map();
    const next = new Map();
    const seen = new Set();
    let total = 0;
    let pickedId = null;
    let pickedWeight = -Infinity;

    for (const candidate of candidates) {
      const id = candidate?.id;
      if (typeof id !== "string" || id.length === 0 || seen.has(id)) continue;
      seen.add(id);

      const weight = candidate?.weight;
      if (!Number.isFinite(weight) || weight <= 0) continue;

      const current = (previous.get(id) ?? 0) + weight;
      next.set(id, current);
      total += weight;
      if (current > pickedWeight) {
        pickedId = id;
        pickedWeight = current;
      }
    }

    if (pickedId === null) {
      return { id: null, currentWeights: new Map() };
    }

    next.set(pickedId, next.get(pickedId) - total);
    return { id: pickedId, currentWeights: next };
  } catch {
    return { id: null, currentWeights: new Map() };
  }
}
