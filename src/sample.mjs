import { serializeCsv } from "./schema.mjs";
import { allocateStrata, confidenceBucket, hashSeed, mulberry32, shuffleInPlace } from "./stats.mjs";

export const LABEL_HEADERS = [
  "id",
  "ts",
  "predicted",
  "confidence",
  "stored_label",
  "label_source",
  "input",
  "human_label",
];

export function stratumKey(decision) {
  return `${decision.predicted}|${confidenceBucket(decision.confidence)}`;
}

/**
 * Stratified sample by predicted class x confidence bucket.
 * Same decisions + seed + n always produce the same ids, in the same order.
 */
export function stratifiedSample(decisions, { n, seed }) {
  if (!Number.isInteger(n) || n <= 0) throw new RangeError("n 必须是正整数");
  const strata = new Map();
  for (const decision of decisions) {
    const key = stratumKey(decision);
    if (!strata.has(key)) strata.set(key, []);
    strata.get(key).push(decision);
  }

  const sizes = new Map([...strata.entries()].map(([key, items]) => [key, items.length]));
  const quota = allocateStrata(sizes, n);

  const picked = [];
  for (const key of [...strata.keys()].sort()) {
    const take = quota.get(key) ?? 0;
    if (take === 0) continue;
    const pool = [...strata.get(key)].sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
    const random = mulberry32(hashSeed(seed, key));
    shuffleInPlace(pool, random);
    picked.push(...pool.slice(0, take));
  }

  picked.sort(
    (a, b) => (a.ts < b.ts ? -1 : a.ts > b.ts ? 1 : a.id < b.id ? -1 : a.id > b.id ? 1 : 0),
  );

  const byStratum = new Map();
  for (const decision of picked) {
    const key = stratumKey(decision);
    byStratum.set(key, (byStratum.get(key) ?? 0) + 1);
  }

  return {
    rows: picked,
    quota,
    sizes,
    byStratum,
    requested: n,
    capped: picked.length < Math.min(n, decisions.length),
  };
}

export function toLabelCsv(sampled) {
  const rows = sampled.map((decision) => ({
    id: decision.id,
    ts: decision.ts,
    predicted: decision.predicted,
    confidence: String(decision.confidence),
    stored_label: decision.storedLabel,
    label_source: decision.rawSource,
    input: decision.input,
    human_label: "",
  }));
  return { csv: serializeCsv(LABEL_HEADERS, rows), rows };
}
