// Deterministic statistics + sampling primitives. No dependencies.

export const Z_95 = 1.959963984540054;

/** FNV-1a over a string, used to derive a per-stratum seed. */
export function hashSeed(...parts) {
  let hash = 0x811c9dc5;
  const text = parts.join("\u0000");
  for (let index = 0; index < text.length; index += 1) {
    hash ^= text.charCodeAt(index);
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return hash >>> 0;
}

/** Small, fast, deterministic PRNG. Same seed -> same sequence, on every platform. */
export function mulberry32(seed) {
  let state = seed >>> 0;
  return function next() {
    state = (state + 0x6d2b79f5) >>> 0;
    let value = state;
    value = Math.imul(value ^ (value >>> 15), value | 1);
    value ^= value + Math.imul(value ^ (value >>> 7), value | 61);
    return ((value ^ (value >>> 14)) >>> 0) / 4294967296;
  };
}

export function shuffleInPlace(items, random) {
  for (let index = items.length - 1; index > 0; index -= 1) {
    const pick = Math.floor(random() * (index + 1));
    const held = items[index];
    items[index] = items[pick];
    items[pick] = held;
  }
  return items;
}

export function confidenceBucket(confidence) {
  if (!(confidence >= 0)) return "unknown";
  if (confidence >= 0.9) return "high";
  if (confidence >= 0.7) return "mid";
  return "low";
}

/**
 * Wilson score interval for a binomial proportion.
 * Returns { p, low, high }. Throws on impossible inputs instead of returning NaN.
 */
export function wilsonInterval(successes, total, z = Z_95) {
  if (!Number.isInteger(successes) || !Number.isInteger(total)) {
    throw new TypeError("wilsonInterval 需要整数计数");
  }
  if (total <= 0) throw new RangeError("wilsonInterval 需要 total > 0");
  if (successes < 0 || successes > total) throw new RangeError("wilsonInterval 的 successes 必须在 0..total");
  const p = successes / total;
  const denominator = 1 + (z * z) / total;
  const center = (p + (z * z) / (2 * total)) / denominator;
  const margin = (z * Math.sqrt((p * (1 - p)) / total + (z * z) / (4 * total * total))) / denominator;
  return { p, low: Math.max(0, center - margin), high: Math.min(1, center + margin) };
}

/**
 * How many labels are needed so the 95% interval is about +/- margin wide,
 * with a finite-population correction when the frame size is known.
 */
export function requiredSampleSize(p, { margin = 0.05, z = Z_95, population = null } = {}) {
  if (!(margin > 0) || margin >= 1) throw new RangeError("margin 必须在 (0, 1) 内");
  const rate = p >= 0 && p <= 1 ? p : 0.5;
  const raw = Math.ceil((z * z * rate * (1 - rate)) / (margin * margin));
  if (!Number.isFinite(population) || population === null || population <= 0) return Math.max(1, raw);
  const corrected = Math.ceil(raw / (1 + (raw - 1) / population));
  return Math.max(1, Math.min(corrected, population));
}

/**
 * Allocate n samples across strata with one guaranteed sample per non-empty
 * stratum, then largest-remainder proportional allocation. Deterministic.
 */
export function allocateStrata(sizes, n) {
  const entries = [...sizes.entries()].sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0));
  const total = entries.reduce((sum, [, size]) => sum + size, 0);
  const counts = new Map(entries.map(([key]) => [key, 0]));
  if (n <= 0 || total === 0) return counts;
  if (n >= total) {
    for (const [key, size] of entries) counts.set(key, size);
    return counts;
  }

  if (n < entries.length) {
    const chosen = [...entries]
      .sort((a, b) => b[1] - a[1] || (a[0] < b[0] ? -1 : 1))
      .slice(0, n);
    for (const [key] of chosen) counts.set(key, 1);
    return counts;
  }

  const pool = entries;
  for (const [key] of pool) counts.set(key, 1);
  let remaining = n - pool.length;

  const poolTotal = pool.reduce((sum, [, size]) => sum + size, 0);
  const shares = [];
  let handedOut = 0;
  for (const [key, size] of pool) {
    const exact = (remaining * size) / poolTotal;
    const base = Math.floor(exact);
    // Never exceed the stratum size.
    const granted = Math.min(base, size - 1);
    counts.set(key, counts.get(key) + granted);
    handedOut += granted;
    shares.push({ key, fraction: exact - base, size });
  }

  let left = remaining - handedOut;
  const ranked = shares.sort(
    (a, b) => b.fraction - a.fraction || b.size - a.size || (a.key < b.key ? -1 : 1),
  );
  while (left > 0) {
    let progressed = false;
    for (const share of ranked) {
      if (left === 0) break;
      if (counts.get(share.key) >= share.size) continue;
      counts.set(share.key, counts.get(share.key) + 1);
      left -= 1;
      progressed = true;
    }
    if (!progressed) break;
  }
  return counts;
}

export function round(value, digits = 2) {
  const factor = 10 ** digits;
  return Math.round(value * factor) / factor;
}

export function formatRate(value) {
  return Number.isFinite(value) ? round(value, 2).toFixed(2) : "n/a";
}

export function formatPercent(value, digits = 0) {
  return Number.isFinite(value) ? `${(value * 100).toFixed(digits)}%` : "n/a";
}
