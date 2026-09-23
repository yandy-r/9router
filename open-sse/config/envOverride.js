// Validated env overrides for client-fingerprint config. A malformed value
// throws at module load instead of silently sending an identity no real
// client would produce.

export function envString(name, def, pattern) {
  const raw = process.env[name]?.trim();
  if (!raw) return def;
  if (!pattern.test(raw)) {
    throw new Error(`Invalid ${name}="${raw}": expected a value matching ${pattern}`);
  }
  return raw;
}

export function envList(name, def, itemPattern) {
  const raw = process.env[name]?.trim();
  if (!raw) return def;
  const items = raw.split(",").map((s) => s.trim()).filter(Boolean);
  const bad = items.filter((item) => !itemPattern.test(item));
  if (items.length === 0 || bad.length) {
    throw new Error(`Invalid ${name}: ${bad.length ? `malformed entries ${bad.join(", ")}` : "empty list"}`);
  }
  return items;
}
