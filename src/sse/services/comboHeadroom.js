// Weighted combo headroom (YAN-261). App-side: open-sse must not import localDb,
// so handlers build this fn here and inject it into handleComboChat.
import { getProviderConnections } from "@/lib/localDb";
import { getProviderHeadroom } from "open-sse/services/quotaSnapshot.js";
import { parseModel } from "./model.js";

/**
 * Build a synchronous, memoized `(modelStr) => headroom` for combo members.
 * One active-connections query per call; never throws. Unknown models, aliases,
 * nested combo names and custom-node prefixes get 1. DB errors give 1 for all.
 * @param {{ getProviderConnections?: Function }} [deps]
 * @returns {Promise<(modelStr: string) => number>}
 */
export async function loadComboHeadroomFn({
  getProviderConnections: listConnections = getProviderConnections,
} = {}) {
  const idsByProvider = new Map();
  try {
    for (const { id, provider } of await listConnections({ isActive: true })) {
      if (!idsByProvider.has(provider)) idsByProvider.set(provider, []);
      idsByProvider.get(provider).push(id);
    }
  } catch {
    return () => 1;
  }

  const cache = new Map();
  const compute = (modelStr) => {
    if (!modelStr.includes("/")) {
      // Bare provider id or alias (fetch/search combo members).
      // Parse as "<member>/" so bare ids get the same (local) alias resolution.
      const { provider } = parseModel(`${modelStr}/`);
      const ids = idsByProvider.get(provider);
      return ids ? getProviderHeadroom(provider, ids, null).headroom : 1;
    }
    const { provider, model, isAlias } = parseModel(modelStr);
    const ids = !isAlias && provider ? idsByProvider.get(provider) : null;
    return ids ? getProviderHeadroom(provider, ids, model).headroom : 1;
  };

  return (modelStr) => {
    if (typeof modelStr !== "string") return 1;
    if (!cache.has(modelStr)) {
      let headroom = 1;
      try {
        headroom = compute(modelStr);
      } catch {}
      cache.set(modelStr, headroom);
    }
    return cache.get(modelStr);
  };
}
