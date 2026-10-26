import assert from "node:assert/strict";
import test from "node:test";
import { formatScoreText, scoreLabels } from "../src/score.mjs";

// 6 labeled rows + 1 unlabeled. Human labels: 4 of 6 correct.
const rows = [
  { id: "1", predicted: "billing", human_label: "billing", confidence: "0.9", stored_label: "billing", label_source: "model" },
  { id: "2", predicted: "billing", human_label: "refund", confidence: "0.8", stored_label: "billing", label_source: "model" },
  { id: "3", predicted: "refund", human_label: "refund", confidence: "0.95", stored_label: "refund", label_source: "model" },
  { id: "4", predicted: "bug", human_label: "bug", confidence: "0.7", stored_label: "bug", label_source: "human" },
  { id: "5", predicted: "bug", human_label: "account", confidence: "0.6", stored_label: "bug", label_source: "model" },
  { id: "6", predicted: "spam", human_label: "spam", confidence: "0.99", stored_label: "spam", label_source: "model" },
  { id: "7", predicted: "account", human_label: "", confidence: "0.75", stored_label: "account", label_source: "model" },
];

test("accuracy and Wilson interval are computed on labeled rows only", () => {
  const report = scoreLabels(rows);
  assert.equal(report.counts.labeled, 6);
  assert.equal(report.counts.missing, 1);
  assert.equal(report.accuracy, 0.6667);
  assert.ok(Math.abs(report.interval.low - 0.3001) < 0.001, `low=${report.interval.low}`);
  assert.ok(Math.abs(report.interval.high - 0.9031) < 0.001, `high=${report.interval.high}`);
  assert.equal(report.verdict, "valid");
  assert.equal(report.exitCode, 0);
});

test("per-class precision and recall match a hand-computed confusion matrix", () => {
  const report = scoreLabels(rows);
  const byLabel = new Map(report.perClass.map((item) => [item.label, item]));
  assert.deepEqual(
    { p: byLabel.get("billing").precision, r: byLabel.get("billing").recall, n: byLabel.get("billing").support },
    { p: 0.5, r: 1, n: 1 },
  );
  assert.deepEqual(
    { p: byLabel.get("refund").precision, r: byLabel.get("refund").recall, n: byLabel.get("refund").support },
    { p: 1, r: 0.5, n: 2 },
  );
  assert.deepEqual(
    { p: byLabel.get("bug").precision, r: byLabel.get("bug").recall, n: byLabel.get("bug").support },
    { p: 0.5, r: 1, n: 1 },
  );
  assert.equal(byLabel.get("account").precision, null, "没有预测为 account 的行");
  assert.equal(byLabel.get("account").recall, 0);
});

test("the confusion matrix keeps truth -> predicted counts", () => {
  const report = scoreLabels(rows);
  assert.deepEqual(report.confusion.billing, { billing: 1 });
  assert.deepEqual(report.confusion.refund, { billing: 1, refund: 1 });
});

test("scoring against model-written stored labels is rejected as invalid", () => {
  const report = scoreLabels(rows, { labelColumn: "stored_label" });
  assert.equal(report.verdict, "invalid");
  assert.equal(report.exitCode, 1);
  assert.equal(report.provenance.model, 6);
  assert.equal(report.counts.labeled, 7, "stored_label 有值时第 7 行也会参与评分");
  assert.equal(report.findings.some((finding) => finding.code === "self-label-leak"), true);
  assert.equal(report.sampleSize.additional >= 0, true);
});

test("stored labels written by humans stay valid", () => {
  const humanRows = rows.map((row) => ({ ...row, label_source: "human" }));
  const report = scoreLabels(humanRows, { labelColumn: "stored_label" });
  assert.equal(report.verdict, "valid");
  assert.equal(report.provenance.human, 7);
});

test("labels copied from model output raise a copy warning", () => {
  const copied = rows.slice(0, 4).map((row) => ({ ...row, human_label: row.stored_label }));
  const report = scoreLabels(copied);
  assert.equal(report.accuracy, 1);
  assert.equal(report.findings.some((finding) => finding.code === "possible-copy"), true);
});

test("--fail-under flips the exit code without pretending the verdict is invalid", () => {
  const report = scoreLabels(rows, { failUnder: 0.9 });
  assert.equal(report.passed, false);
  assert.equal(report.exitCode, 1);
  assert.equal(report.verdict, "valid");
  const pass = scoreLabels(rows, { failUnder: 0.6 });
  assert.equal(pass.exitCode, 0);
});

test("a frame size tightens the sample-size recommendation", () => {
  const open = scoreLabels(rows, { targetMargin: 0.05 });
  const bounded = scoreLabels(rows, { targetMargin: 0.05, frameSize: 40 });
  assert.ok(bounded.sampleSize.required < open.sampleSize.required);
  assert.equal(open.counts.frame, null);
  assert.equal(bounded.counts.frame, 40);
});

test("missing labels and invalid predicted values are reported, not silently dropped", () => {
  const withBadRow = [...rows, { id: "8", predicted: "", human_label: "bug", confidence: "0.5" }];
  const report = scoreLabels(withBadRow);
  assert.equal(report.counts.invalid, 1);
  assert.equal(report.invalidRows[0].line, 9);
  assert.equal(report.counts.labeled, 6);
});

test("disagreements are ordered by confidence", () => {
  const report = scoreLabels(rows);
  assert.deepEqual(report.disagreements.map((item) => item.id), ["2", "5"]);
  assert.equal(report.disagreements[0].human, "refund");
});

test("scoring with no labels at all is a schema error with a usable message", () => {
  assert.throws(() => scoreLabels(rows.map((row) => ({ ...row, human_label: "" }))), /没有任何一行填了 human_label/);
});

test("a missing label column is reported with the available columns", () => {
  assert.throws(() => scoreLabels(rows, { labelColumn: "truth" }), /没有 truth 列/);
});

test("text output shows the verdict, the interval and how many labels are still needed", () => {
  const report = scoreLabels(rows, { targetMargin: 0.05 });
  const text = formatScoreText(report, "to_label.csv");
  assert.match(text, /accuracy 0\.67 {2}95% CI \[0\.30, 0\.90\]/);
  assert.match(text, /billing\s+P 0\.50\s+R 1\.00\s+\(n=1\)/);
  assert.match(text, /还需要约 \d+ 条人工标注/);
  assert.match(text, /结论有效 → exit 0/);
});

test("text output suppresses the sample-size advice when the verdict is invalid", () => {
  const report = scoreLabels(rows, { labelColumn: "stored_label" });
  const text = formatScoreText(report, "to_label.csv");
  assert.match(text, /结论无效/);
  assert.match(text, /样本量建议不适用/);
  assert.doesNotMatch(text, /还需要约/);
});
