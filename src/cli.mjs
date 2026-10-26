#!/usr/bin/env node
import { readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { parseArgs } from "node:util";
import { AgentmeasureError, EXIT, ioError, usageError } from "./errors.mjs";
import { formatCheckText, formatSampleText, formatScoreJson, formatScoreMarkdown } from "./report.mjs";
import { parseCsv, parseJsonl, summarizeFrame, validateDecisions } from "./schema.mjs";
import { stratifiedSample, toLabelCsv } from "./sample.mjs";
import { formatScoreText, scoreLabels } from "./score.mjs";

const HELP = `agentmeasure — 测量已上线分类 agent 的真实错误率

Usage:
  agentmeasure check <decisions.jsonl> [--json]
  agentmeasure sample <decisions.jsonl> [--n 40] [--seed 7] [--out to_label.csv] [--json]
  agentmeasure score <labeled.csv> [options]
  agentmeasure --help

score 选项:
  --label-column <name>   当答案用的列，默认 human_label
  --out <file>            写 Markdown 报告
  --report <file>         写 JSON 报告
  --fail-under <0-1>      准确率低于它就退 1
  --min-support <int>     文本输出里只列出 support >= 该值的类别，默认 1
  --frame-size <int>      原始日志条数，用于有限总体修正的样本量建议
  --target-margin <0-1>   样本量建议的目标误差，默认 0.05
  --json                  把 JSON 打到 stdout
  -h, --help              显示帮助

Exit codes:
  0  完成（评分时表示结论有效且未低于 --fail-under）
  1  结论无效（自标注泄漏）或低于 --fail-under，或文件读不到
  2  参数 / 数据格式错误

不调用模型，不联网。分数只说明这批标签上的分类表现，不说明标注质量。
`;

function parseInteger(raw, flag, { min, max }) {
  if (typeof raw !== "string" || !/^-?\d+$/.test(raw)) {
    throw usageError(`${flag} 需要一个整数，收到：${raw}`);
  }
  const value = Number(raw);
  if (!Number.isSafeInteger(value) || value < min || value > max) {
    throw usageError(`${flag} 必须是 ${min} 到 ${max} 的整数，收到：${raw}`);
  }
  return value;
}

function parseRatio(raw, flag) {
  if (typeof raw !== "string" || raw.trim() === "") throw usageError(`${flag} 需要一个 0-1 的小数`);
  const value = Number(raw);
  if (!Number.isFinite(value) || value < 0 || value > 1) {
    throw usageError(`${flag} 必须在 0 到 1 之间，收到：${raw}`);
  }
  return value;
}

function readText(file, flag) {
  try {
    return readFileSync(file, "utf8");
  } catch (error) {
    const code = error && typeof error === "object" && "code" in error ? error.code : "E_IO";
    throw ioError(`无法读取${flag}：${file}（${code}）`);
  }
}

function loadDecisions(file) {
  const text = readText(file, "日志文件");
  const parsed = parseJsonl(text, path.basename(file));
  const { decisions, warnings } = validateDecisions(parsed);
  return { decisions, warnings, summary: summarizeFrame(decisions) };
}

function printError(error, jsonMode) {
  const known = error instanceof AgentmeasureError;
  const code = known ? error.code : "E_INTERNAL";
  const message = known ? error.message : `未预期错误：${error instanceof Error ? error.message : String(error)}`;
  if (jsonMode) {
    process.stderr.write(`${JSON.stringify({ ok: false, error: { code, message } }, null, 2)}\n`);
  } else {
    process.stderr.write(`agentmeasure: ${message}\n`);
  }
  return known ? error.exitCode : EXIT.FAIL;
}

export function main(argv = process.argv.slice(2)) {
  const jsonMode = argv.includes("--json");
  try {
    let parsed;
    try {
      parsed = parseArgs({
        args: argv,
        allowPositionals: true,
        strict: true,
        options: {
          n: { type: "string" },
          seed: { type: "string" },
          out: { type: "string" },
          report: { type: "string" },
          "label-column": { type: "string" },
          "fail-under": { type: "string" },
          "min-support": { type: "string" },
          "frame-size": { type: "string" },
          "target-margin": { type: "string" },
          json: { type: "boolean" },
          help: { type: "boolean", short: "h" },
        },
      });
    } catch (cause) {
      const detail = cause instanceof Error ? cause.message : String(cause);
      throw usageError(`参数错误：${detail}\n运行 agentmeasure --help 查看用法。`);
    }

    const { values, positionals } = parsed;
    if (values.help || positionals.length === 0) {
      process.stdout.write(HELP);
      return EXIT.OK;
    }

    const command = positionals[0];
    if (command === "help") {
      process.stdout.write(HELP);
      return EXIT.OK;
    }
    if (!["check", "sample", "score"].includes(command)) {
      throw usageError(`未知命令：${command}`);
    }
    if (positionals.length < 2) throw usageError(`${command} 需要一个文件路径`);
    if (positionals.length > 2) throw usageError(`多余的参数：${positionals.slice(2).join(" ")}`);

    const file = positionals[1];

    if (command === "check") {
      const { summary, warnings } = loadDecisions(file);
      if (values.json) {
        process.stdout.write(`${JSON.stringify({ ok: true, file, summary, warnings }, null, 2)}\n`);
      } else {
        process.stdout.write(formatCheckText(summary, file, warnings));
      }
      return EXIT.OK;
    }

    if (command === "sample") {
      const n = values.n === undefined ? 40 : parseInteger(values.n, "--n", { min: 1, max: 10_000_000 });
      const seed = values.seed === undefined ? 7 : parseInteger(values.seed, "--seed", { min: 0, max: 2 ** 31 - 1 });
      const { decisions, summary } = loadDecisions(file);
      const sampled = stratifiedSample(decisions, { n, seed });
      const { csv } = toLabelCsv(sampled.rows);
      const outPath = values.out ?? "to_label.csv";
      writeFileSync(path.resolve(outPath), csv, "utf8");
      if (values.json) {
        process.stdout.write(
          `${JSON.stringify(
            {
              ok: true,
              file,
              out: outPath,
              seed,
              requested: sampled.requested,
              sampled: sampled.rows.length,
              strata: [...sampled.byStratum.entries()].map(([stratum, count]) => ({
                stratum,
                sampled: count,
                frame: sampled.sizes.get(stratum) ?? 0,
              })),
              ids: sampled.rows.map((decision) => decision.id),
              summary,
            },
            null,
            2,
          )}\n`,
        );
      } else {
        process.stdout.write(formatSampleText({ source: file, summary, sampled, outPath, seed, n }));
      }
      return EXIT.OK;
    }

    const labelColumn = values["label-column"] ?? "human_label";
    const minSupport = values["min-support"] === undefined ? 1 : parseInteger(values["min-support"], "--min-support", { min: 1, max: 100_000 });
    const failUnder = values["fail-under"] === undefined ? null : parseRatio(values["fail-under"], "--fail-under");
    const targetMargin = values["target-margin"] === undefined ? 0.05 : parseRatio(values["target-margin"], "--target-margin");
    if (targetMargin === 0) throw usageError("--target-margin 必须大于 0");
    const frameSize = values["frame-size"] === undefined
      ? null
      : parseInteger(values["frame-size"], "--frame-size", { min: 1, max: 1e9 });

    const text = readText(file, "标注文件");
    const { rows } = parseCsv(text, path.basename(file));
    const report = scoreLabels(rows, { labelColumn, minSupport, failUnder, targetMargin, frameSize });

    if (values.out) writeFileSync(path.resolve(values.out), formatScoreMarkdown(report, file), "utf8");
    if (values.report) writeFileSync(path.resolve(values.report), formatScoreJson(report), "utf8");

    if (values.json) process.stdout.write(formatScoreJson(report));
    else process.stdout.write(formatScoreText(report, file));

    return report.exitCode;
  } catch (error) {
    return printError(error, jsonMode);
  }
}

const isDirectRun = process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href;
if (isDirectRun) process.exitCode = main();
