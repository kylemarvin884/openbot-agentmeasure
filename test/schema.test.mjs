import assert from "node:assert/strict";
import test from "node:test";
import {
  classifySource,
  guardCell,
  parseCsv,
  parseJsonl,
  serializeCsv,
  summarizeFrame,
  validateDecisions,
} from "../src/schema.mjs";

function record(overrides = {}) {
  return {
    id: "d-1",
    ts: "2026-10-20T00:00:00Z",
    input: "客户说发票开错了",
    predicted: "billing",
    confidence: 0.8,
    stored_label: "billing",
    label_source: "model",
    ...overrides,
  };
}

test("classifySource maps known vocabularies and keeps unknown values visible", () => {
  assert.equal(classifySource("model"), "model");
  assert.equal(classifySource("LLM"), "model");
  assert.equal(classifySource("human"), "human");
  assert.equal(classifySource("reviewer"), "human");
  assert.equal(classifySource("regex"), "rule");
  assert.equal(classifySource(""), "none");
  assert.equal(classifySource(undefined), "none");
  assert.equal(classifySource("imported-from-zendesk"), "other");
});

test("parseJsonl reports the offending line", () => {
  const text = `${JSON.stringify(record())}\n{not json}\n`;
  assert.throws(() => parseJsonl(text, "d.jsonl"), /第 2 行/);
});

test("parseJsonl rejects non-object lines and empty files", () => {
  assert.throws(() => parseJsonl("[1,2,3]", "d.jsonl"), /JSON 对象/);
  assert.throws(() => parseJsonl("\n\n", "d.jsonl"), /没有任何记录/);
});

test("parseCsv handles quotes, commas, embedded newlines and BOM", () => {
  const text = '\uFEFFid,predicted,input\r\n1,billing,"发票, 需要重开"\r\n2,bug,"第一行\n第二行"\r\n';
  const { headers, rows } = parseCsv(text);
  assert.deepEqual(headers, ["id", "predicted", "input"]);
  assert.equal(rows[0].input, "发票, 需要重开");
  assert.equal(rows[1].input, "第一行\n第二行");
});

test("parseCsv accepts doubled quotes and rejects ragged rows", () => {
  const ok = parseCsv('id,input\n1,"他说 ""好"""\n');
  assert.equal(ok.rows[0].input, '他说 "好"');

  assert.throws(() => parseCsv("id,input\n1,a,b\n"), /第 2 行有 3 列/);
});

test("parseCsv rejects duplicate or empty headers", () => {
  assert.throws(() => parseCsv("id,id\n1,2\n"), /表头重复/);
  assert.throws(() => parseCsv("id,\n1,2\n"), /空列名/);
});

test("serializeCsv round-trips through parseCsv", () => {
  const rows = [{ id: "a,1", note: 'say "hi"', human_label: "" }];
  const csv = serializeCsv(["id", "note", "human_label"], rows);
  const parsed = parseCsv(csv);
  assert.equal(parsed.rows[0].id, "a,1");
  assert.equal(parsed.rows[0].note, 'say "hi"');
  assert.equal(parsed.rows[0].human_label, "");
});

test("guardCell neutralises spreadsheet formulas", () => {
  assert.equal(guardCell("=1+1"), "'=1+1");
  assert.equal(guardCell("@user"), "'@user");
  assert.equal(guardCell("-3"), "'-3");
  assert.equal(guardCell("normal"), "normal");
  assert.match(serializeCsv(["input"], [{ input: "=cmd" }]), /'=cmd/);
});

test("validateDecisions normalises and classifies rows", () => {
  const { decisions, warnings } = validateDecisions(parseJsonl(`${JSON.stringify(record())}\n`));
  assert.equal(decisions.length, 1);
  assert.equal(decisions[0].labelSource, "model");
  assert.equal(decisions[0].storedLabel, "billing");
  assert.deepEqual(warnings, []);
});

test("validateDecisions rejects duplicate ids, bad confidence and missing predicted", () => {
  const duplicate = `${JSON.stringify(record())}\n${JSON.stringify(record())}\n`;
  assert.throws(() => validateDecisions(parseJsonl(duplicate)), /id 重复/);
  assert.throws(
    () => validateDecisions(parseJsonl(`${JSON.stringify(record({ confidence: 1.2 }))}\n`)),
    /confidence 必须在 0\.\.1/,
  );
  assert.throws(
    () => validateDecisions(parseJsonl(`${JSON.stringify(record({ confidence: "0.8" }))}\n`)),
    /confidence 必须是数字/,
  );
  assert.throws(
    () => validateDecisions(parseJsonl(`${JSON.stringify(record({ predicted: "  " }))}\n`)),
    /缺少 predicted/,
  );
});

test("validateDecisions warns when label_source is missing", () => {
  const row = record();
  delete row.label_source;
  const { decisions, warnings } = validateDecisions(parseJsonl(`${JSON.stringify(row)}\n`));
  assert.equal(decisions[0].labelSource, "none");
  assert.match(warnings[0], /label_source/);
});

test("summarizeFrame counts provenance, classes, values and strata", () => {
  const rows = [
    JSON.stringify(record({ id: "a", predicted: "billing", confidence: 0.95 })),
    JSON.stringify(record({ id: "b", predicted: "billing", confidence: 0.8, label_source: "human" })),
    JSON.stringify(record({ id: "c", predicted: "bug", confidence: 0.5, label_source: "none" })),
  ].join("\n");
  const { decisions } = validateDecisions(parseJsonl(rows));
  const summary = summarizeFrame(decisions);
  assert.equal(summary.total, 3);
  assert.deepEqual(summary.provenance, { human: 1, model: 1, rule: 0, none: 1, other: 0 });
  assert.deepEqual(summary.classes, [["billing", 2], ["bug", 1]]);
  assert.deepEqual(summary.confidence, { low: 1, mid: 1, high: 1 });
  assert.equal(summary.strata.length, 3);
  assert.deepEqual(summary.strata[0], ["billing|high", 1]);
});
