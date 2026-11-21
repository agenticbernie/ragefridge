/** Bounded, single-process limiter. Use socket IPs, never untrusted forwarded headers. */
export function createRateLimit({ limit, windowMs, maxKeys = 10_000, now = Date.now }) {
  if (!Number.isSafeInteger(limit) || limit <= 0 || !Number.isSafeInteger(windowMs) || windowMs <= 0 ||
      !Number.isSafeInteger(maxKeys) || maxKeys <= 0) throw new TypeError('Invalid rate limit.');
  const entries = new Map();
  return (key) => {
    const time = now();
    let entry = entries.get(key);
    if (entry && time >= entry.expires) { entries.delete(key); entry = null; }
    if (!entry) {
      if (entries.size >= maxKeys) {
        for (const [address, value] of entries) if (time >= value.expires) entries.delete(address);
        if (entries.size >= maxKeys) return false;
      }
      entry = { count: 0, expires: time + windowMs };
      entries.set(key, entry);
    }
    if (entry.count >= limit) return false;
    entry.count++;
    return true;
  };
}
