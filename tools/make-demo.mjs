#!/usr/bin/env node
// Generates the synthetic demo frame and a simulated labeled CSV.
// Deterministic: same code -> same bytes. Run `npm run make-demo` after changing it.
import { writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { serializeCsv } from "../src/schema.mjs";
import { stratifiedSample } from "../src/sample.mjs";
import { LABEL_HEADERS } from "../src/sample.mjs";
import { mulberry32 } from "../src/stats.mjs";

const ROOT = fileURLToPath(new URL("..", import.meta.url));

const CLASSES = [
  { name: "billing", weight: 0.34, accuracy: 0.92 },
  { name: "refund", weight: 0.16, accuracy: 0.68 },
  { name: "bug", weight: 0.24, accuracy: 0.8 },
  { name: "account", weight: 0.14, accuracy: 0.74 },
  { name: "spam", weight: 0.12, accuracy: 0.94 },
];

const TEMPLATES = {
  billing: [
    "客户说发票金额对不上，要求重开一张",
    "订阅扣了两次款，问什么时候退",
    "账单显示升级了套餐但我没点过",
    "想把月付改成按年付，差价怎么算",
    "发票抬头写错了，需要重开",
  ],
  refund: [
    "收到货是坏的，申请退款",
    "订单取消三天了还没退款到账",
    "退款金额比订单少了 20 元",
    "重复下单了，想退掉其中一单",
    "说好 7 天无理由，现在不给退",
  ],
  bug: [
    "导出 CSV 后中文全是问号",
    "登录后一直转圈，进不去工作台",
    "保存草稿按钮点了没反应",
    "手机上图片加载不出来",
    "搜索框输入后页面白屏",
  ],
  account: [
    "换了手机号，验证码收不到",
    "团队成员离职，怎么移除账号",
    "登录提示账号停用，但我没操作过",
    "想合并两个账号的数据",
    "两步验证的备用码丢了",
  ],
  spam: [
    "加微信领取免费课程",
    "低价代开发票，当天出票",
    "我们提供 SEO 排名服务",
    "点击链接领取 500 元红包",
    "合作吗？我们有 10 万粉丝",
  ],
};

function pickClass(random) {
  const roll = random();
  let cumulative = 0;
  for (const entry of CLASSES) {
    cumulative += entry.weight;
    if (roll < cumulative) return entry;
  }
  return CLASSES[CLASSES.length - 1];
}

function pickOther(current, random) {
  const pool = CLASSES.filter((entry) => entry.name !== current);
  return pool[Math.floor(random() * pool.length)].name;
}

/** Builds the frame plus a simulated labeled CSV. No IO. */
export function buildDemo({ total = 200, sampleSize = 60, seed = 7, blankRows = [4, 13, 22, 31, 40, 49] } = {}) {
  const random = mulberry32(20261026);
  const base = Date.parse("2026-10-19T00:00:00Z");
  const decisions = [];

  for (let index = 0; index < total; index += 1) {
    const entry = pickClass(random);
    const correct = random() < entry.accuracy;
    const predicted = correct ? entry.name : pickOther(entry.name, random);
    const confidence = correct
      ? 0.62 + random() * 0.37
      : 0.52 + random() * 0.36;
    const humanStored = index % 10 === 3; // every 10th row has a stored label written by a person
    const template = TEMPLATES[entry.name][index % TEMPLATES[entry.name].length];
    const rawSource = humanStored ? "human" : "model";
    decisions.push({
      id: `d-${String(index + 1).padStart(4, "0")}`,
      line: index + 1,
      ts: new Date(base + index * 7 * 60 * 1000).toISOString().replace(".000Z", "Z"),
      input: `${template}（工单 #${1200 + index}）`,
      predicted,
      confidence: Math.round(confidence * 100) / 100,
      storedLabel: humanStored ? entry.name : predicted,
      rawSource,
      labelSource: rawSource,
      truth: entry.name,
    });
  }

  const frameText = `${decisions
    .map((decision) =>
      JSON.stringify({
        id: decision.id,
        ts: decision.ts,
        input: decision.input,
        predicted: decision.predicted,
        confidence: decision.confidence,
        stored_label: decision.storedLabel,
        label_source: decision.rawSource,
      }),
    )
    .join("\n")}\n`;

  const sampled = stratifiedSample(decisions, { n: sampleSize, seed });
  const truthById = new Map(decisions.map((decision) => [decision.id, decision.truth]));
  const csvRows = sampled.rows.map((decision, index) => ({
    id: decision.id,
    ts: decision.ts,
    predicted: decision.predicted,
    confidence: String(decision.confidence),
    stored_label: decision.storedLabel,
    label_source: decision.rawSource,
    input: decision.input,
    human_label: blankRows.includes(index) ? "" : truthById.get(decision.id) ?? "",
  }));
  const labeledCsv = serializeCsv(LABEL_HEADERS, csvRows);

  return { frameText, labeledCsv, sampled, decisions };
}

function main() {
  const { frameText, labeledCsv } = buildDemo();
  writeFileSync(path.join(ROOT, "demo", "decisions.jsonl"), frameText, "utf8");
  writeFileSync(path.join(ROOT, "demo", "labeled.csv"), labeledCsv, "utf8");
  process.stdout.write("wrote demo/decisions.jsonl and demo/labeled.csv\n");
}

const isDirectRun = process.argv[1] !== undefined && fileURLToPath(import.meta.url) === path.resolve(process.argv[1]);
if (isDirectRun) main();
