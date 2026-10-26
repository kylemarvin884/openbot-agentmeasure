import assert from "node:assert/strict";
import test from "node:test";
import { parseJsonl, validateDecisions } from "../src/schema.mjs";
import { LABEL_HEADERS, stratifiedSample, toLabelCsv } from "../src/sample.mjs";

function frame(count = 200) {
  const rows = [];
  for (let index = 0; index < count; index += 1) {
    rows.push({
      id: `d-${String(index + 1).padStart(4, "0")}`,
      ts: new Date(Date.UTC(2026, 9, 19, 0, index)).toISOString(),
      input: `工单 ${index}`,
      predicted: ["billing", "refund", "bug", "account"][index % 4],
      confidence: [0.95, 0.8, 0.6][index % 3],
      stored_label: ["billing", "refund", "bug", "account"][index % 4],
      label_source: index % 10 === 0 ? "human" : "model",
    });
  }
  return validateDecisions(parseJsonl(rows.map((row) => JSON.stringify(row)).join("\n"))).decisions;
}

test("sampling returns exactly n rows when the frame is larger", () => {
  const decisions = frame();
  const sampled = stratifiedSample(decisions, { n: 40, seed: 7 });
  assert.equal(sampled.rows.length, 40);
  assert.equal(new Set(sampled.rows.map((row) => row.id)).size, 40);
});

test("the same seed produces the same ids in the same order", () => {
  const decisions = frame();
  const first = stratifiedSample(decisions, { n: 40, seed: 7 });
  const second = stratifiedSample(decisions, { n: 40, seed: 7 });
  assert.deepEqual(first.rows.map((row) => row.id), second.rows.map((row) => row.id));
});

test("a different seed picks a different sample", () => {
  const decisions = frame();
  const first = stratifiedSample(decisions, { n: 40, seed: 7 }).rows.map((row) => row.id);
  const second = stratifiedSample(decisions, { n: 40, seed: 8 }).rows.map((row) => row.id);
  assert.notDeepEqual(first, second);
});

test("every non-empty stratum is represented", () => {
  const decisions = frame();
  const sampled = stratifiedSample(decisions, { n: 40, seed: 7 });
  for (const [stratum, size] of sampled.sizes) {
    assert.ok(size > 0, `${stratum} 应有数据`);
    assert.ok((sampled.byStratum.get(stratum) ?? 0) >= 1, `${stratum} 至少抽到 1 条`);
  }
});

test("a sample larger than the frame returns the whole frame", () => {
  const decisions = frame(12);
  const sampled = stratifiedSample(decisions, { n: 50, seed: 1 });
  assert.equal(sampled.rows.length, 12);
  assert.equal(sampled.capped, false, "n 大于帧时抽取全部，不算被截断");
});

test("sampling rejects a non-positive n", () => {
  assert.throws(() => stratifiedSample(frame(10), { n: 0, seed: 1 }), /正整数/);
  assert.throws(() => stratifiedSample(frame(10), { n: 1.5, seed: 1 }), /正整数/);
});

test("the label CSV keeps stored labels but never pre-fills human_label", () => {
  const sampled = stratifiedSample(frame(50), { n: 10, seed: 3 });
  const { csv } = toLabelCsv(sampled.rows);
  const [header, ...lines] = csv.trim().split("\n");
  assert.deepEqual(header.split(","), LABEL_HEADERS);
  assert.equal(lines.length, 10);
  for (const line of lines) {
    assert.match(line, /,$/, `human_label 应为空：${line}`);
  }
  assert.match(csv, /,model,/);
});

test("csv cells that look like formulas are prefixed", () => {
  const sampled = [
    {
      id: "=1+1",
      ts: "",
      predicted: "billing",
      confidence: 0.9,
      storedLabel: "",
      rawSource: "model",
      input: "@import",
    },
  ];
  const { csv } = toLabelCsv(sampled);
  assert.match(csv, /'=1\+1/);
  assert.match(csv, /'@import/);
});
