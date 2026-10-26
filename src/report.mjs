import { formatPercent, round } from "./stats.mjs";

/** Markdown report for `score`. Fixed section order so diffs stay readable in CI. */
export function formatScoreMarkdown(report, source) {
  const lines = [];
  const rate = (value) => (value === null || value === undefined ? "n/a" : value.toFixed(2));

  lines.push(`# agentmeasure report`);
  lines.push("");
  lines.push(`- 文件：\`${source}\``);
  lines.push(`- 生成：agentmeasure ${report.version}`);
  lines.push(`- 答案列：\`${report.labelColumn}\``);
  lines.push(
    `- 行数：${report.counts.rows} · 已标注 ${report.counts.labeled} · 缺失 ${report.counts.missing}` +
      (report.counts.invalid ? ` · 无法解析 ${report.counts.invalid}` : ""),
  );
  lines.push(`- 结论：${report.verdict === "invalid" ? "**无效**（见下方发现）" : "有效"}`);
  lines.push("");

  lines.push("## 准确率");
  lines.push("");
  lines.push("| 指标 | 值 |");
  lines.push("| --- | --- |");
  lines.push(`| accuracy | ${report.accuracy.toFixed(2)} |`);
  lines.push(
    `| 95% CI (Wilson) | ${report.interval.low.toFixed(2)} – ${report.interval.high.toFixed(2)}（n=${report.counts.labeled}） |`,
  );
  lines.push(`| 目标误差 | ±${formatPercent(report.sampleSize.targetMargin)} |`);
  lines.push(
    report.verdict === "invalid"
      ? `| 还需要的标注数 | 不适用（结论无效） |`
      : `| 还需要的标注数 | ${report.sampleSize.additional}（目标 ${report.sampleSize.required} 条，帧 ${report.counts.frame ?? "未知"}） |`,
  );
  lines.push("");

  lines.push("## 每类 P/R");
  lines.push("");
  lines.push("| 类别 | precision | recall | support | tp | fp | fn |");
  lines.push("| --- | --- | --- | --- | --- | --- | --- |");
  for (const item of report.perClass) {
    lines.push(
      `| ${item.label} | ${rate(item.precision)} | ${rate(item.recall)} | ${item.support} | ${item.tp} | ${item.fp} | ${item.fn} |`,
    );
  }
  lines.push("");
  lines.push("support = 该类在人工标注里的出现次数。support 小于 5 的类别，P/R 波动很大，不要单独引用。");
  lines.push("");

  lines.push("## 标签来源");
  lines.push("");
  lines.push(
    `human ${report.provenance.human} · model ${report.provenance.model} · rule ${report.provenance.rule} · none ${report.provenance.none} · unknown ${report.provenance.unknown}`,
  );
  lines.push("");

  if (report.findings.length > 0) {
    lines.push("## 发现");
    lines.push("");
    for (const finding of report.findings) {
      lines.push(`- **${finding.level === "error" ? "错误" : "警告"}** \`${finding.code}\`：${finding.message}`);
    }
    lines.push("");
  }

  lines.push("## 分歧样本");
  lines.push("");
  if (report.disagreements.length === 0) {
    lines.push("没有分歧。");
  } else {
    lines.push("| id | confidence | predicted | human | input |");
    lines.push("| --- | --- | --- | --- | --- |");
    for (const item of report.disagreements) {
      const confidence = item.confidence === null ? "n/a" : item.confidence.toFixed(2);
      const input = item.input.replaceAll("|", "\\|").replaceAll("\n", " ");
      lines.push(`| ${item.id} | ${confidence} | ${item.predicted} | ${item.human} | ${input} |`);
    }
  }
  lines.push("");

  if (report.counts.missing > 0) {
    lines.push("## 缺失标注");
    lines.push("");
    lines.push(`有 ${report.counts.missing} 行没有填 ${report.labelColumn}，已从评分里排除。`);
    if (report.missingSample.length > 0) {
      lines.push("");
      lines.push(
        `前 ${report.missingSample.length} 行：` +
          report.missingSample.map((item) => `L${item.line}${item.id ? ` (${item.id})` : ""}`).join("、"),
      );
    }
    lines.push("");
  }

  lines.push("## 限制");
  lines.push("");
  for (const limitation of report.limitations) lines.push(`- ${limitation}`);
  lines.push("");
  lines.push(
    `退出码：${report.exitCode}${report.failUnder === null ? "" : `（--fail-under ${report.failUnder}）`}`,
  );
  lines.push("");

  return `${lines.join("\n")}`;
}

export function formatCheckText(summary, source, warnings) {
  const lines = [];
  lines.push("agentmeasure 0.1.0 — schema 检查");
  lines.push(`file: ${source}`);
  lines.push(`${summary.total} 条 · ${summary.classes.length} 类 · ${summary.strata.length} 层`);
  lines.push(
    `source: human ${summary.provenance.human} · model ${summary.provenance.model} · rule ${summary.provenance.rule} · none ${summary.provenance.none}` +
      (summary.provenance.other ? ` · other ${summary.provenance.other}` : ""),
  );
  lines.push(
    `confidence: low ${summary.confidence.low} · mid ${summary.confidence.mid} · high ${summary.confidence.high}`,
  );
  lines.push("");
  lines.push("classes:");
  const width = Math.max(...summary.classes.map(([name]) => name.length), 4);
  for (const [name, count] of summary.classes) {
    lines.push(`  ${name.padEnd(width)}  ${count}`);
  }
  const modelShare = summary.total === 0 ? 0 : summary.provenance.model / summary.total;
  if (modelShare >= 0.5) {
    lines.push("");
    lines.push(
      `⚠ ${summary.provenance.model}/${summary.total} 条标签由模型写入。这些不能当评测答案，抽样后必须人工填 human_label。`,
    );
  }
  if (warnings.length > 0) {
    lines.push("");
    for (const warning of warnings.slice(0, 10)) lines.push(`  ${warning}`);
    if (warnings.length > 10) lines.push(`  ……另有 ${warnings.length - 10} 条同类提示`);
  }
  lines.push("");
  lines.push(`ok: schema 通过${modelShare >= 0.5 ? "，但标签来源不可直接当答案" : ""} → exit 0`);
  return `${lines.join("\n")}\n`;
}

export function formatSampleText({ source, summary, sampled, outPath, seed, n }) {
  const lines = [];
  const bucket = { low: 0, mid: 0, high: 0 };
  for (const decision of sampled.rows) {
    const key = decision.confidence >= 0.9 ? "high" : decision.confidence >= 0.7 ? "mid" : "low";
    bucket[key] += 1;
  }
  lines.push("agentmeasure 0.1.0 — 分层抽样");
  lines.push(`frame: ${source}  ${summary.total} 条 · ${summary.classes.length} 类 · ${summary.strata.length} 层`);
  lines.push(
    `source: human ${summary.provenance.human} · model ${summary.provenance.model} · rule ${summary.provenance.rule} · none ${summary.provenance.none}`,
  );
  if (summary.provenance.model > 0) {
    lines.push(
      `⚠ frame 里 ${summary.provenance.model}/${summary.total} 条标签来自模型。抽样 CSV 里它们只作为 stored_label 参考列，不是答案。`,
    );
  }
  lines.push("");
  lines.push(`sample: ${sampled.rows.length} / ${summary.total} 条（请求 ${n}，seed ${seed}，按 predicted × confidence 分层）`);
  lines.push(`confidence: low ${bucket.low} · mid ${bucket.mid} · high ${bucket.high}`);
  lines.push("");
  const stratumLines = [...sampled.byStratum.entries()].sort((a, b) => (a[0] < b[0] ? -1 : 1));
  for (const [key, count] of stratumLines) {
    lines.push(`  ${key.padEnd(24)} ${String(count).padStart(3)} / ${sampled.sizes.get(key) ?? 0}`);
  }
  lines.push("");
  lines.push(`${outPath}: ${sampled.rows.length} 行，human_label 列已留空`);
  lines.push("下一步：在表格里填 human_label，然后 agentmeasure score " + outPath);
  lines.push("");
  lines.push(
    `说明：抽样结果由 seed 决定，同样的输入和 seed 会得到同一批 id。${sampled.capped ? "样本量超过帧容量，已取全部。" : ""}`,
  );
  return `${lines.join("\n").replace(/\n+$/, "\n")}`;
}

export function formatScoreJson(report) {
  return `${JSON.stringify(report, null, 2)}\n`;
}

export { round };
