#!/usr/bin/env node
// End-to-end demo. Runs from the project root: `npm run demo`.
// Steps 1-3 show the normal flow; step 4 shows the leak gate refusing to score
// against labels the model wrote itself.
import { mkdirSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { main } from "../src/cli.mjs";

const ROOT = fileURLToPath(new URL("..", import.meta.url));
process.chdir(ROOT);
mkdirSync(path.join(ROOT, "demo", "out"), { recursive: true });

const frame = "demo/decisions.jsonl";
const labeled = "demo/labeled.csv";
const sampleCsv = "demo/out/to_label.csv";
const markdown = "demo/out/report.md";
const json = "demo/out/report.json";

const steps = [
  {
    title: "1/4 检查日志 schema 和标签来源",
    args: ["check", frame],
    expect: 0,
  },
  {
    title: "2/4 分层抽样，生成待标注 CSV",
    args: ["sample", frame, "--n", "60", "--seed", "7", "--out", sampleCsv],
    expect: 0,
  },
  {
    title: "3/4 给填好的 CSV 评分（demo/labeled.csv 的 human_label 是模拟标注，不是真人）",
    args: ["score", labeled, "--out", markdown, "--report", json],
    expect: 0,
  },
  {
    title: "4/4 把 stored_label 当答案：自标注泄漏，判 invalid 并退出 1",
    args: ["score", labeled, "--label-column", "stored_label"],
    expect: 1,
  },
];

let failed = 0;
for (const step of steps) {
  process.stdout.write(`\n${"=".repeat(72)}\n${step.title}\n$ agentmeasure ${step.args.join(" ")}\n${"=".repeat(72)}\n`);
  const code = main(step.args);
  if (code !== step.expect) {
    process.stderr.write(`demo：这一步预期退出 ${step.expect}，实际 ${code}\n`);
    failed += 1;
  }
}

process.stdout.write(`\n产物：\n  ${path.relative(ROOT, sampleCsv)}\n  ${path.relative(ROOT, markdown)}\n  ${path.relative(ROOT, json)}\n`);
if (failed > 0) {
  process.stderr.write(`${failed} 个步骤的退出码与预期不符\n`);
  process.exitCode = 1;
}
