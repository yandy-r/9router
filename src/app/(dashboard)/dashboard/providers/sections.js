import {
  OAUTH_PROVIDERS,
  APIKEY_PROVIDERS,
  FREE_PROVIDERS,
  FREE_TIER_PROVIDERS,
  OPENAI_COMPATIBLE_PREFIX,
  ANTHROPIC_COMPATIBLE_PREFIX,
} from "@/shared/constants/providers";
import { getProviderStats } from "./utils";

function dualAuthTypes(info, key) {
  if (key === "kiro") return ["oauth", "apikey", "api_key"];
  const modes = info?.authModes;
  if (!Array.isArray(modes)) {
    return key in FREE_TIER_PROVIDERS || key in APIKEY_PROVIDERS
      ? ["oauth", "apikey", "api_key"]
      : "oauth";
  }
  if (!modes.includes("apikey")) return "oauth";
  return ["oauth", "apikey", "api_key"];
}

function sortOAuth(entries, connections) {
  return [...entries].sort((ea, eb) => {
    const pa = ea.info.priority ?? 999;
    const pb = eb.info.priority ?? 999;
    if (pa !== pb) return pa - pb;
    const sa = getProviderStats(connections, ea.id, "oauth");
    const sb = getProviderStats(connections, eb.id, "oauth");
    const ca = sa.connected > 0 ? 1 : 0;
    const cb = sb.connected > 0 ? 1 : 0;
    if (ca !== cb) return cb - ca;
    return (ea.info.name || "").localeCompare(eb.info.name || "");
  });
}

export function PROVIDER_SECTIONS({ connections, providerNodes, statsFor }) {
  const compatibleEntries = (providerNodes || [])
    .filter((node) => node.type === "openai-compatible")
    .map((node) => ({
      id: node.id,
      info: {
        id: node.id,
        name: node.name || "OpenAI Compatible",
        apiType: node.apiType,
      },
      stats: statsFor(node.id, "apikey"),
      authGroup: "compatible",
      authTypes: ["apikey"],
      isNoAuth: false,
      compatibleType: "openai",
      compatibleLabel: node.apiType === "responses" ? "Responses" : "Chat",
    }));

  const anthropicEntries = (providerNodes || [])
    .filter((node) => node.type === "anthropic-compatible")
    .map((node) => ({
      id: node.id,
      info: { id: node.id, name: node.name || "Anthropic Compatible" },
      stats: statsFor(node.id, "apikey"),
      authGroup: "compatible",
      authTypes: ["apikey"],
      isNoAuth: false,
      compatibleType: "anthropic",
      compatibleLabel: "Messages",
    }));

  const oauthEntries = sortOAuth(
    Object.entries(OAUTH_PROVIDERS)
      .filter(([, info]) => !info.hidden)
      .map(([key, info]) => {
        const authTypes = dualAuthTypes(info, key);
        return {
          id: key,
          info,
          stats: statsFor(key, authTypes),
          authGroup: "oauth",
          authTypes: Array.isArray(authTypes) ? authTypes : [authTypes],
          isNoAuth: !!info.noAuth,
        };
      }),
    connections,
  );

  const freeEntries = Object.entries(FREE_PROVIDERS)
    .filter(([, info]) => !info.hidden)
    .map(([key, info]) => {
      const authTypes = dualAuthTypes(info, key);
      return {
        id: key,
        info,
        stats: statsFor(key, authTypes),
        authGroup: "free",
        authTypes: Array.isArray(authTypes) ? authTypes : [authTypes],
        isNoAuth: !!info.noAuth,
      };
    })
    .sort((ea, eb) => (eb.info.noAuth ? 1 : 0) - (ea.info.noAuth ? 1 : 0));

  const freeTierEntries = Object.entries(FREE_TIER_PROVIDERS)
    .filter(([, info]) => !info.hidden && (info.serviceKinds ?? ["llm"]).includes("llm"))
    .map(([key, info]) => {
      const authTypes = dualAuthTypes(info, key);
      return {
        id: key,
        info,
        stats: statsFor(key, authTypes),
        authGroup: "free",
        authTypes: Array.isArray(authTypes) ? authTypes : [authTypes],
        isNoAuth: !!info.noAuth,
      };
    })
    .sort((ea, eb) => {
      const pa = ea.info.priority ?? 999;
      const pb = eb.info.priority ?? 999;
      if (pa !== pb) return pa - pb;
      const noAuthDiff = (eb.info.noAuth ? 1 : 0) - (ea.info.noAuth ? 1 : 0);
      if (noAuthDiff !== 0) return noAuthDiff;
      const ca = ea.stats.connected > 0 ? 0 : 1;
      const cb = eb.stats.connected > 0 ? 0 : 1;
      if (ca !== cb) return ca - cb;
      return (ea.info.name || "").localeCompare(eb.info.name || "");
    });

  const apikeyEntries = Object.entries(APIKEY_PROVIDERS)
    .filter(([, info]) => !info.hidden && (info.serviceKinds ?? ["llm"]).includes("llm"))
    .map(([key, info]) => ({
      id: key,
      info,
      stats: statsFor(key, "apikey"),
      authGroup: "apikey",
      authTypes: ["apikey"],
      isNoAuth: !!info.noAuth,
    }))
    .sort((ea, eb) => {
      const ca = ea.stats.total > 0 ? 0 : 1;
      const cb = eb.stats.total > 0 ? 0 : 1;
      if (ca !== cb) return ca - cb;
      return (ea.info.name || "").localeCompare(eb.info.name || "");
    });

  return [
    {
      id: "oauth",
      title: "Subscriptions & OAuth",
      subtitle: "Sign in once. 9router refreshes tokens for you.",
      testMode: "oauth",
      entries: oauthEntries,
      totalCount: oauthEntries.length,
    },
    {
      id: "free",
      title: "Free Tier Providers",
      subtitle: "Free quotas and no-key proxies.",
      testMode: "free",
      entries: [...freeEntries, ...freeTierEntries],
      totalCount: freeEntries.length + freeTierEntries.length,
      actions: true,
    },
    {
      id: "apikey",
      title: "API keys & free tiers",
      subtitle: "Paste a key, pick models, done.",
      testMode: "apikey",
      entries: apikeyEntries,
      totalCount: apikeyEntries.length,
      actions: true,
    },
    {
      id: "custom",
      title: "Custom Providers",
      subtitle: "OpenAI- or Anthropic-compatible endpoints.",
      testMode: "compatible",
      entries: [...compatibleEntries, ...anthropicEntries],
      totalCount: compatibleEntries.length + anthropicEntries.length,
    },
  ];
}

export { OPENAI_COMPATIBLE_PREFIX, ANTHROPIC_COMPATIBLE_PREFIX };
