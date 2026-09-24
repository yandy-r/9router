const DURATION_RE = /^(?:\d+(?:\.\d+)?(?:ns|us|µs|μs|ms|s|m|h))+$/i;
const UNIT_MS = {
  ns: 1e-6,
  us: 1e-3,
  µs: 1e-3,
  μs: 1e-3,
  ms: 1,
  s: 1000,
  m: 60000,
  h: 3600000,
};

export function isDurationString(value) {
  return typeof value === "string" && DURATION_RE.test(value);
}

/** Parse a full Go-style duration string to milliseconds; null when invalid. */
export function parseDurationToMs(value) {
  if (typeof value !== "string") return null;
  const duration = value.trim();
  if (!duration || !isDurationString(duration)) return null;

  let totalMs = 0;
  for (const [, amount, unit] of duration.matchAll(/(\d+(?:\.\d+)?)(ns|us|µs|μs|ms|s|m|h)/gi)) {
    totalMs += Number(amount) * UNIT_MS[unit.toLowerCase()];
  }
  return Number.isFinite(totalMs) ? totalMs : null;
}
