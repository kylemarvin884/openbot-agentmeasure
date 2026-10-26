import assert from "node:assert/strict";
import test from "node:test";
import {
  allocateStrata,
  confidenceBucket,
  hashSeed,
  mulberry32,
  requiredSampleSize,
  shuffleInPlace,
  wilsonInterval,
} from "../src/stats.mjs";

test("wilson interval matches known values for 0/10 and 10/10", () => {
  const none = wilsonInterval(0, 10);
  assert.equal(none.p, 0);
  assert.equal(none.low, 0);
  assert.ok(Math.abs(none.high - 0.2775) < 0.001, `high=${none.high}`);

  const all = wilsonInterval(10, 10);
  assert.equal(all.p, 1);
  assert.ok(Math.abs(all.high - 1) < 1e-9, `high=${all.high}`);
  assert.ok(Math.abs(all.low - 0.7225) < 0.001, `low=${all.low}`);
});

test("wilson interval is symmetric around p for a balanced sample", () => {
  const { low, high } = wilsonInterval(25, 50);
  assert.ok(Math.abs((low + high) / 2 - 0.5) < 1e-9);
  assert.ok(low < 0.5 && high > 0.5);
});

test("wilson interval rejects impossible inputs instead of returning NaN", () => {
  assert.throws(() => wilsonInterval(0, 0), /total > 0/);
  assert.throws(() => wilsonInterval(11, 10), /0\.\.total/);
  assert.throws(() => wilsonInterval(1.5, 10), /整数/);
});

test("required sample size shrinks with the finite population correction", () => {
  const open = requiredSampleSize(0.5, { margin: 0.05 });
  assert.equal(open, 385);
  const bounded = requiredSampleSize(0.5, { margin: 0.05, population: 500 });
  assert.ok(bounded < open, `${bounded} < ${open}`);
  assert.ok(bounded > 0);
  const tiny = requiredSampleSize(0.9, { margin: 0.05, population: 60 });
  assert.equal(tiny, 43);
  assert.ok(tiny <= 60);
});

test("required sample size rejects a margin outside (0, 1)", () => {
  assert.throws(() => requiredSampleSize(0.5, { margin: 0 }), /margin/);
  assert.throws(() => requiredSampleSize(0.5, { margin: 1 }), /margin/);
});

test("allocateStrata covers every non-empty stratum when n >= strata", () => {
  const sizes = new Map([
    ["a", 50],
    ["b", 30],
    ["c", 20],
  ]);
  const counts = allocateStrata(sizes, 10);
  assert.equal([...counts.values()].reduce((sum, value) => sum + value, 0), 10);
  for (const [key, size] of sizes) {
    assert.ok(counts.get(key) >= 1, `${key} 至少 1 条`);
    assert.ok(counts.get(key) <= size, `${key} 不能超过总体`);
  }
});

test("allocateStrata is proportional when n is large and never exceeds a stratum", () => {
  const sizes = new Map([
    ["a", 10],
    ["b", 90],
  ]);
  const counts = allocateStrata(sizes, 100);
  assert.equal(counts.get("a"), 10);
  assert.equal(counts.get("b"), 90);

  const squeezed = allocateStrata(new Map([["one", 1], ["many", 999]]), 50);
  assert.equal(squeezed.get("one"), 1);
  assert.equal([...squeezed.values()].reduce((sum, value) => sum + value, 0), 50);
});

test("allocateStrata with n below the stratum count picks the largest strata", () => {
  const sizes = new Map([
    ["small", 2],
    ["large", 80],
    ["medium", 18],
  ]);
  const counts = allocateStrata(sizes, 2);
  assert.equal(counts.get("large"), 1);
  assert.equal(counts.get("medium"), 1);
  assert.equal(counts.get("small"), 0);
});

test("allocateStrata returns everything when n covers the frame", () => {
  const sizes = new Map([["a", 3], ["b", 4]]);
  const counts = allocateStrata(sizes, 100);
  assert.equal(counts.get("a"), 3);
  assert.equal(counts.get("b"), 4);
});

test("allocateStrata is deterministic regardless of Map insertion order", () => {
  const forward = allocateStrata(new Map([["a", 7], ["b", 3], ["c", 5]]), 9);
  const reverse = allocateStrata(new Map([["c", 5], ["b", 3], ["a", 7]]), 9);
  assert.deepEqual([...forward.entries()].sort(), [...reverse.entries()].sort());
});

test("mulberry32 and hashSeed are stable across runs", () => {
  const first = mulberry32(42);
  const second = mulberry32(42);
  for (let index = 0; index < 5; index += 1) assert.equal(first(), second());
  assert.equal(hashSeed(7, "billing|high"), hashSeed(7, "billing|high"));
  assert.notEqual(hashSeed(7, "billing|high"), hashSeed(8, "billing|high"));
});

test("shuffleInPlace permutes without losing items and respects the seed", () => {
  const items = Array.from({ length: 20 }, (_, index) => index);
  const copy = [...items];
  shuffleInPlace(items, mulberry32(3));
  assert.deepEqual([...items].sort((a, b) => a - b), copy);
  assert.notDeepEqual(items, copy);
});

test("confidenceBucket uses documented cut points", () => {
  assert.equal(confidenceBucket(0.9), "high");
  assert.equal(confidenceBucket(0.89), "mid");
  assert.equal(confidenceBucket(0.7), "mid");
  assert.equal(confidenceBucket(0.69), "low");
  assert.equal(confidenceBucket(0), "low");
});
