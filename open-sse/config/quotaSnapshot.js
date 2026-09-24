/**
 * Quota snapshot tunables (YAN-259 phase 1).
 * Threshold/floor semantics (floor vs weight-0 exclusion) are phase-2-owned;
 * computeEffectiveWeight signature carried there — this file holds values only.
 */
export const QUOTA_SNAPSHOT = {
  snapshotTtlMs: 3_600_000,
  floor: 0.05,
  maxConnections: 1000,
  maxWindowsPerConnection: 32,
  profileRecheckMs: 86_400_000,
  poller: { tickMs: 60_000, staleMs: 900_000, failureCooldownMs: 900_000 },
};

/**
 * Relative capacity per provider plan tier. Values are estimates; `_verify`
 * marks rows needing runtime confirmation. Tiers lowercased/trimmed at use.
 */
export const PLAN_CAPACITY = {
  claude: {
    pro: 1,
    default_claude_max_5x: 5,
    default_claude_max_20x: 20,
  },
  codex: {
    plus: 1,
    team: 1,
    business: 1,
    prolite: 5, // _verify
    pro: 20, // _verify
  },
  github: {
    copilot_pro: 1,
    copilot_pro_plus: 4.7, // _verify
    copilot_max: 13.3, // _verify
  },
  "gemini-cli": {
    free: 1,
    "g1-pro-tier": 1.5,
    "g1-ultra-tier": 2, // _verify
  },
  antigravity: {
    "free-tier": 1,
    "legacy-tier": 1,
    "g1-pro-tier": 1.5,
    "g1-ultra-tier": 5, // _verify, no SKU split 5 vs 20
  },
  kiro: {
    free: 0.05,
    pro: 1,
    pro_plus: 2, // _verify ids
    pro_max: 5, // _verify ids
    power: 10, // _verify ids
  },
};
