import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { buildDemo } from "../tools/make-demo.mjs";

const root = fileURLToPath(new URL("..", import.meta.url));
const cli = fileURLToPath(new URL("../src/cli.mjs", import.meta.url));
const frame = "demo/decisions.jsonl";
const labeled = "demo/labeled.csv";

function run(args) {
  return spawnSync(process.execPath, [cli, ...args], { cwd: root, encoding: "utf8" });
}

function withTempDir(t) {
  const dir = mkdtempSync(path.join(tmpdir(), "agentmeasure-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  return dir;
}

test("help exits 0 and documents the three commands", () => {
  const child = run(["--help"]);
  assert.equal(child.status, 0, child.stderr);
  assert.match(child.stdout, /agentmeasure check <decisions\.jsonl>/);
  assert.match(child.stdout, /agentmeasure sample/);
  assert.match(child.stdout, /agentmeasure score/);
  assert.equal(child.stderr, "");
});

test("an unknown command is a usage error, not a crash", () => {
  const child = run(["eval"]);
  assert.equal(child.status, 2);
  assert.equal(child.stdout, "");
  assert.match(child.stderr, /未知命令/);
});

test("check reports the frame shape and the self-label share", () => {
  const child = run(["check", frame]);
  assert.equal(child.status, 0, child.stderr);
  assert.match(child.stdout, /200 条 · 5 类 · 15 层/);
  assert.match(child.stdout, /human 20 · model 180/);
  assert.match(child.stdout, /不能当评测答案/);
});

test("check --json is parseable and keeps stdout clean", () => {
  const child = run(["check", frame, "--json"]);
  assert.equal(child.status, 0, child.stderr);
  const payload = JSON.parse(child.stdout);
  assert.equal(payload.ok, true);
  assert.equal(payload.summary.total, 200);
  assert.equal(payload.summary.provenance.model, 180);
});

test("sample writes a CSV with an empty human_label column and is reproducible", (t) => {
  const dir = withTempDir(t);
  const first = path.join(dir, "a.csv");
  const second = path.join(dir, "b.csv");
  const one = run(["sample", frame, "--n", "40", "--seed", "7", "--out", first]);
  assert.equal(one.status, 0, one.stderr);
  assert.match(one.stdout, /sample: 40 \/ 200 条/);
  const two = run(["sample", frame, "--n", "40", "--seed", "7", "--out", second]);
  assert.equal(two.status, 0, two.stderr);
  assert.equal(readFileSync(first, "utf8"), readFileSync(second, "utf8"));

  const lines = readFileSync(first, "utf8").trim().split("\n");
  assert.equal(lines.length, 41);
  assert.equal(lines[0], "id,ts,predicted,confidence,stored_label,label_source,input,human_label");
  assert.match(lines[1], /,$/);
});

test("sample --json exposes the ids so a run can be audited", (t) => {
  const dir = withTempDir(t);
  const out = path.join(dir, "s.csv");
  const child = run(["sample", frame, "--n", "10", "--seed", "11", "--out", out, "--json"]);
  assert.equal(child.status, 0, child.stderr);
  const payload = JSON.parse(child.stdout);
  assert.equal(payload.sampled, 10);
  assert.equal(payload.ids.length, 10);
  assert.equal(payload.seed, 11);
});

test("score renders a report and exits 0 for a valid label set", (t) => {
  const dir = withTempDir(t);
  const md = path.join(dir, "report.md");
  const json = path.join(dir, "report.json");
  const child = run(["score", labeled, "--out", md, "--report", json, "--frame-size", "200"]);
  assert.equal(child.status, 0, child.stderr);
  assert.match(child.stdout, /accuracy 0\.78/);
  assert.match(child.stdout, /结论有效 → exit 0/);
  const markdown = readFileSync(md, "utf8");
  assert.match(markdown, /## 准确率/);
  assert.match(markdown, /## 每类 P\/R/);
  const payload = JSON.parse(readFileSync(json, "utf8"));
  assert.equal(payload.verdict, "valid");
  assert.equal(payload.counts.labeled, 54);
  assert.equal(payload.counts.missing, 6);
  assert.equal(payload.counts.frame, 200);
});

test("score against model-written labels refuses with exit 1", () => {
  const child = run(["score", labeled, "--label-column", "stored_label"]);
  assert.equal(child.status, 1);
  assert.match(child.stdout, /结论无效/);
  assert.match(child.stdout, /来自模型自己/);
});

test("--fail-under turns a low accuracy into a failing gate", () => {
  const child = run(["score", labeled, "--fail-under", "0.9"]);
  assert.equal(child.status, 1);
  assert.match(child.stdout, /结论有效/);
  assert.match(child.stdout, /exit 1/);
});

test("a missing file exits 1 and --json keeps the error on stderr", () => {
  const child = run(["score", "nope.csv", "--json"]);
  assert.equal(child.status, 1);
  assert.equal(child.stdout, "");
  const payload = JSON.parse(child.stderr);
  assert.equal(payload.ok, false);
  assert.equal(payload.error.code, "E_IO");
});

test("a CSV without a predicted column exits 2 with the column list", (t) => {
  const dir = withTempDir(t);
  const bad = path.join(dir, "bad.csv");
  writeFileSync(bad, "id,answer\n1,billing\n", "utf8");
  const child = run(["score", bad]);
  assert.equal(child.status, 2);
  assert.match(child.stderr, /缺少 predicted 列/);
});

test("the committed demo data matches the generator", () => {
  const { frameText, labeledCsv } = buildDemo();
  assert.equal(readFileSync(path.join(root, "demo", "decisions.jsonl"), "utf8"), frameText);
  assert.equal(readFileSync(path.join(root, "demo", "labeled.csv"), "utf8"), labeledCsv);
});
