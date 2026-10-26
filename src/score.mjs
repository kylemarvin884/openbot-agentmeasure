import { schemaError } from "./errors.mjs";
import { classifySource } from "./schema.mjs";
import { formatPercent, requiredSampleSize, round, wilsonInterval, Z_95 } from "./stats.mjs";

const DEFAULT_LABEL_COLUMN = "human_label";

function truthProvenance(row, labelColumn) {
  if (labelColumn === "human_label") return "human";
  if (labelColumn === "stored_label" || labelColumn === "label") {
    const source = classifySource(row.label_source);
    return source === "none" ? "unknown" : source;
  }
  return "unknown";
}

/**
 * Scores a labeled CSV. Pure function: no IO, no clock, no randomness, no model.
 * Returns a report object plus exitCode.
 */
export function scoreLabels(
  csvRows,
  {
    labelColumn = DEFAULT_LABEL_COLUMN,
    minSupport = 1,
    failUnder = null,
    targetMargin = 0.05,
    frameSize = null,
    disagreementLimit = 10,
    z = Z_95,
  } = {},
) {
  if (!Array.isArray(csvRows) || csvRows.length === 0) throw schemaError("CSV 没有数据行");
  const headers = Object.keys(csvRows[0]);
  if (!headers.includes("predicted")) throw schemaError("CSV 缺少 predicted 列");
  if (!headers.includes(labelColumn)) {
    throw schemaError(`CSV 没有 ${labelColumn} 列。可用列：${headers.join(", ")}`);
  }
  if (!Number.isInteger(minSupport) || minSupport < 1) throw schemaError("minSupport 必须是正整数");
  if (!(targetMargin > 0) || targetMargin >= 1) throw schemaError("targetMargin 必须在 (0, 1) 内");

  const labeled = [];
  const missing = [];
  const invalid = [];

  for (const [offset, row] of csvRows.entries()) {
    const predicted = String(row.predicted ?? "").trim();
    if (predicted === "") {
      invalid.push({ line: offset + 2, reason: "predicted 为空" });
      continue;
    }
    const truth = String(row[labelColumn] ?? "").trim();
    if (truth === "") {
      missing.push({ line: offset + 2, id: String(row.id ?? ""), predicted });
      continue;
    }
    labeled.push({
      id: String(row.id ?? ""),
      predicted,
      truth,
      confidence: Number(row.confidence),
      input: row.input ?? "",
      storedLabel: String(row.stored_label ?? "").trim(),
      storedSource: classifySource(row.label_source),
      provenance: truthProvenance(row, labelColumn),
    });
  }

  const scored = labeled.length;
  if (scored === 0) {
    throw schemaError(`没有任何一行填了 ${labelColumn}，无法评分。填完再跑，或用 --label-column 指定别的列。`);
  }

  const confusion = new Map();
  const classSet = new Set();
  for (const item of labeled) {
    classSet.add(item.predicted);
    classSet.add(item.truth);
    if (!confusion.has(item.truth)) confusion.set(item.truth, new Map());
    const row = confusion.get(item.truth);
    row.set(item.predicted, (row.get(item.predicted) ?? 0) + 1);
  }

  const classes = [...classSet].sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
  const perClass = classes.map((label) => {
    let tp = 0;
    let fp = 0;
    let fn = 0;
    for (const item of labeled) {
      if (item.truth === label && item.predicted === label) tp += 1;
      else if (item.truth !== label && item.predicted === label) fp += 1;
      else if (item.truth === label && item.predicted !== label) fn += 1;
    }
    return {
      label,
      tp,
      fp,
      fn,
      support: tp + fn,
      precision: tp + fp === 0 ? null : tp / (tp + fp),
      recall: tp + fn === 0 ? null : tp / (tp + fn),
    };
  });

  const correct = labeled.filter((item) => item.predicted === item.truth).length;
  const interval = wilsonInterval(correct, scored, z);

  const provenance = { human: 0, model: 0, rule: 0, none: 0, unknown: 0, other: 0 };
  for (const item of labeled) provenance[item.provenance] += 1;
  const modelShare = provenance.model / scored;

  const findings = [];
  let verdict = "valid";
  if (modelShare >= 0.5) {
    verdict = "invalid";
    findings.push({
      level: "error",
      code: "self-label-leak",
      message: `用来当答案的标签有 ${provenance.model}/${scored} 条来自模型自己。这不是评测，是自证。换成人写的标签再跑。`,
    });
  } else if (provenance.model > 0) {
    findings.push({
      level: "warning",
      code: "model-label-mix",
      message: `${provenance.model}/${scored} 条答案标签来自模型，会抬高准确率。结论要标注这一点。`,
    });
  }
  if (provenance.unknown > 0) {
    findings.push({
      level: "warning",
      code: "unknown-provenance",
      message: `${provenance.unknown}/${scored} 条答案标签来源未知（缺 label_source 列或列名不是 human_label/stored_label）。`,
    });
  }

  const withStored = labeled.filter((item) => item.storedLabel !== "");
  if (withStored.length > 0) {
    const same = withStored.filter((item) => item.storedLabel === item.truth).length;
    const sameShare = same / withStored.length;
    const storedModelShare =
      withStored.filter((item) => item.storedSource === "model").length / withStored.length;
    if (sameShare >= 0.95 && storedModelShare >= 0.5) {
      findings.push({
        level: "warning",
        code: "possible-copy",
        message: `${same}/${withStored.length} 条答案与日志里的 stored_label 完全相同，且这些 stored_label 多数由模型写入。标注员可能照着预测抄了，这个准确率需要复核。`,
      });
    }
  }

  const needed = requiredSampleSize(interval.p, {
    margin: targetMargin,
    z,
    population: Number.isFinite(frameSize) && frameSize > 0 ? frameSize : null,
  });

  const disagreements = labeled
    .filter((item) => item.predicted !== item.truth)
    .sort(
      (a, b) =>
        (Number.isFinite(b.confidence) ? b.confidence : -1) - (Number.isFinite(a.confidence) ? a.confidence : -1) ||
        (a.id < b.id ? -1 : a.id > b.id ? 1 : 0),
    )
    .slice(0, disagreementLimit)
    .map((item) => ({
      id: item.id,
      confidence: Number.isFinite(item.confidence) ? item.confidence : null,
      predicted: item.predicted,
      human: item.truth,
      input: String(item.input).slice(0, 120),
    }));

  const belowTarget = failUnder !== null && interval.p < failUnder;
  const exitCode = verdict === "invalid" || belowTarget ? 1 : 0;

  return {
    tool: "agentmeasure",
    version: "0.1.0",
    labelColumn,
    verdict,
    exitCode,
    passed: exitCode === 0,
    failUnder,
    minSupport,
    counts: {
      rows: csvRows.length,
      labeled: scored,
      missing: missing.length,
      invalid: invalid.length,
      frame: Number.isFinite(frameSize) && frameSize > 0 ? frameSize : null,
    },
    accuracy: round(interval.p, 4),
    interval: { low: round(interval.low, 4), high: round(interval.high, 4), level: 0.95, method: "wilson", n: scored },
    perClass: perClass.map((item) => ({
      ...item,
      precision: item.precision === null ? null : round(item.precision, 4),
      recall: item.recall === null ? null : round(item.recall, 4),
    })),
    confusion: Object.fromEntries(
      [...confusion.entries()].sort((a, b) => (a[0] < b[0] ? -1 : 1)).map(([truth, row]) => [
        truth,
        Object.fromEntries([...row.entries()].sort((a, b) => (a[0] < b[0] ? -1 : 1))),
      ]),
    ),
    provenance,
    sampleSize: {
      targetMargin,
      required: needed,
      additional: Math.max(0, needed - scored),
    },
    findings,
    disagreements,
    missingSample: missing.slice(0, 10),
    invalidRows: invalid.slice(0, 10),
    limitations: [
      "Wilson 区间按随机样本计算；分层抽样合并后的区间是近似值。",
      "只测类别对不对，不测延迟、成本或工具调用成功率。",
      `答案列：${labelColumn}。tool 不判断标注质量。`,
    ],
  };
}

export function formatScoreText(report, source) {
  const lines = [];
  lines.push(`agentmeasure 0.1.0 — 评分`);
  lines.push(
    `file: ${source}  ${report.counts.rows} 行 · 已标注 ${report.counts.labeled} · 缺失 ${report.counts.missing}` +
      (report.counts.invalid ? ` · 无法解析 ${report.counts.invalid}` : ""),
  );
  lines.push("");
  lines.push(
    `accuracy ${report.accuracy.toFixed(2)}  95% CI [${report.interval.low.toFixed(2)}, ${report.interval.high.toFixed(2)}]  (Wilson, n=${report.counts.labeled})`,
  );
  const shown = report.perClass.filter((item) => item.support >= report.minSupport);
  for (const item of shown) {
    const precision = item.precision === null ? "n/a" : item.precision.toFixed(2);
    const recall = item.recall === null ? "n/a" : item.recall.toFixed(2);
    lines.push(`${item.label.padEnd(14)} P ${precision}  R ${recall}  (n=${item.support})`);
  }
  lines.push("");
  for (const finding of report.findings) {
    const mark = finding.level === "error" ? "✗" : "⚠";
    lines.push(`${mark} ${finding.message}`);
  }
  if (report.findings.length > 0) lines.push("");
  if (report.verdict === "invalid") {
    lines.push("→ 结论无效，样本量建议不适用。先把答案换成人工标签。");
  } else {
    lines.push(
      `→ 要把误差压到 ±${formatPercent(report.sampleSize.targetMargin)}，还需要约 ${report.sampleSize.additional} 条人工标注（目标样本量 ${report.sampleSize.required}）`,
    );
  }
  lines.push(`top disagreements: ${report.disagreements.length}（见报告）`);
  lines.push("");
  lines.push(
    `${report.verdict === "invalid" ? "结论无效" : "结论有效"}${report.failUnder === null ? "" : ` · fail-under ${report.failUnder}`} → exit ${report.exitCode}`,
  );
  return `${lines.join("\n")}\n`;
}
