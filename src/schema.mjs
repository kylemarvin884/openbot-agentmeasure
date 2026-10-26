import { schemaError } from "./errors.mjs";

const MODEL_SOURCES = new Set(["model", "self", "auto", "predicted", "llm", "agent"]);
const HUMAN_SOURCES = new Set(["human", "manual", "reviewer", "operator", "labeler"]);
const RULE_SOURCES = new Set(["rule", "rules", "regex", "heuristic"]);

/** Classify a `label_source` value into model / human / rule / none / other. */
export function classifySource(raw) {
  if (raw === undefined || raw === null || String(raw).trim() === "") return "none";
  const value = String(raw).trim().toLowerCase();
  if (MODEL_SOURCES.has(value)) return "model";
  if (HUMAN_SOURCES.has(value)) return "human";
  if (RULE_SOURCES.has(value)) return "rule";
  if (value === "none") return "none";
  return "other";
}

export function parseJsonl(text, label = "decisions") {
  const rows = [];
  const lines = text.split(/\r?\n/);
  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index].trim();
    if (line === "") continue;
    let record;
    try {
      record = JSON.parse(line);
    } catch (error) {
      throw schemaError(`${label} 第 ${index + 1} 行不是合法 JSON：${error instanceof Error ? error.message : String(error)}`);
    }
    if (record === null || typeof record !== "object" || Array.isArray(record)) {
      throw schemaError(`${label} 第 ${index + 1} 行必须是 JSON 对象，收到 ${Array.isArray(record) ? "数组" : typeof record}`);
    }
    rows.push({ record, line: index + 1 });
  }
  if (rows.length === 0) throw schemaError(`${label} 没有任何记录`);
  return rows;
}

/**
 * Minimal RFC 4180 reader: quoted fields, doubled quotes, embedded newlines,
 * CRLF, UTF-8 BOM. Returns { headers, rows } where rows are objects keyed by header.
 */
export function parseCsv(text, label = "csv") {
  const input = text.replace(/^\uFEFF/, "");
  const rows = [];
  let field = "";
  let row = [];
  let quoted = false;
  let index = 0;

  const pushField = () => {
    row.push(field);
    field = "";
  };
  const pushRow = () => {
    pushField();
    rows.push(row);
    row = [];
  };

  while (index < input.length) {
    const char = input[index];
    if (quoted) {
      if (char === '"') {
        if (input[index + 1] === '"') {
          field += '"';
          index += 2;
          continue;
        }
        quoted = false;
        index += 1;
        continue;
      }
      field += char;
      index += 1;
      continue;
    }
    if (char === '"' && field === "") {
      quoted = true;
      index += 1;
      continue;
    }
    if (char === ",") {
      pushField();
      index += 1;
      continue;
    }
    if (char === "\r") {
      if (input[index + 1] === "\n") index += 1;
      pushRow();
      index += 1;
      continue;
    }
    if (char === "\n") {
      pushRow();
      index += 1;
      continue;
    }
    field += char;
    index += 1;
  }
  if (field !== "" || row.length > 0) pushRow();

  const nonEmpty = rows.filter((cells) => cells.some((cell) => cell.trim() !== ""));
  if (nonEmpty.length === 0) throw schemaError(`${label} 没有任何数据`);
  const headers = nonEmpty[0].map((header) => header.trim());
  if (headers.some((header) => header === "")) throw schemaError(`${label} 的表头有空列名`);
  const duplicates = headers.filter((header, at) => headers.indexOf(header) !== at);
  if (duplicates.length > 0) throw schemaError(`${label} 表头重复：${[...new Set(duplicates)].join(", ")}`);

  const objects = nonEmpty.slice(1).map((cells, offset) => {
    if (cells.length !== headers.length) {
      throw schemaError(
        `${label} 第 ${offset + 2} 行有 ${cells.length} 列，表头是 ${headers.length} 列。含逗号的字段需要用双引号包住。`,
      );
    }
    const object = {};
    headers.forEach((header, column) => {
      object[header] = cells[column];
    });
    return object;
  });
  return { headers, rows: objects };
}

/** Prefix cells that a spreadsheet would treat as a formula. */
export function guardCell(value) {
  const text = value === undefined || value === null ? "" : String(value);
  return /^[=+\-@\t\r]/.test(text) ? `'${text}` : text;
}

export function serializeCsv(headers, rows) {
  const escape = (value) => {
    const text = guardCell(value);
    return /[",\r\n]/.test(text) ? `"${text.replaceAll('"', '""')}"` : text;
  };
  const lines = [headers.map(escape).join(",")];
  for (const row of rows) lines.push(headers.map((header) => escape(row[header])).join(","));
  return `${lines.join("\n")}\n`;
}

/**
 * Validates decision records. Fatal problems throw with a line number; cosmetic
 * gaps are collected into `warnings` so `check` can show them without failing.
 */
export function validateDecisions(parsedRows) {
  const seen = new Map();
  const warnings = [];
  const decisions = [];

  for (const { record, line } of parsedRows) {
    const id = record.id;
    if (typeof id !== "string" || id.trim() === "") {
      throw schemaError(`第 ${line} 行缺少 id（字符串）。没有 id 就无法把人工标注 join 回日志。`);
    }
    if (seen.has(id)) {
      throw schemaError(`id 重复：${id}（第 ${seen.get(id)} 行与第 ${line} 行）`);
    }
    seen.set(id, line);

    const predicted = record.predicted;
    if (typeof predicted !== "string" || predicted.trim() === "") {
      throw schemaError(`第 ${line} 行（${id}）缺少 predicted（字符串）`);
    }

    const confidence = record.confidence;
    if (typeof confidence !== "number" || !Number.isFinite(confidence)) {
      throw schemaError(`第 ${line} 行（${id}）的 confidence 必须是数字，收到 ${JSON.stringify(confidence)}`);
    }
    if (confidence < 0 || confidence > 1) {
      throw schemaError(`第 ${line} 行（${id}）的 confidence 必须在 0..1，收到 ${confidence}`);
    }

    if (record.label_source === undefined) {
      warnings.push(`第 ${line} 行（${id}）没有 label_source，按 none 处理`);
    }
    if (record.ts !== undefined && typeof record.ts !== "string") {
      warnings.push(`第 ${line} 行（${id}）的 ts 不是字符串，已按空值处理`);
    }

    decisions.push({
      id,
      line,
      ts: typeof record.ts === "string" ? record.ts : "",
      input: typeof record.input === "string" ? record.input : "",
      predicted: predicted.trim(),
      confidence,
      storedLabel: typeof record.stored_label === "string" ? record.stored_label : "",
      labelSource: classifySource(record.label_source),
      rawSource: record.label_source === undefined ? "" : String(record.label_source),
      truth: typeof record.truth === "string" ? record.truth : "",
    });
  }

  return { decisions, warnings };
}

export function summarizeFrame(decisions) {
  const provenance = { human: 0, model: 0, rule: 0, none: 0, other: 0 };
  const predicted = new Map();
  const confidence = { low: 0, mid: 0, high: 0 };
  for (const decision of decisions) {
    provenance[decision.labelSource] += 1;
    predicted.set(decision.predicted, (predicted.get(decision.predicted) ?? 0) + 1);
    const bucket = decision.confidence >= 0.9 ? "high" : decision.confidence >= 0.7 ? "mid" : "low";
    confidence[bucket] += 1;
  }
  return {
    total: decisions.length,
    classes: [...predicted.entries()].sort((a, b) => b[1] - a[1] || (a[0] < b[0] ? -1 : 1)),
    strata: countStrata(decisions),
    provenance,
    confidence,
  };
}

export function countStrata(decisions) {
  const strata = new Map();
  for (const decision of decisions) {
    const bucket = decision.confidence >= 0.9 ? "high" : decision.confidence >= 0.7 ? "mid" : "low";
    const key = `${decision.predicted}|${bucket}`;
    strata.set(key, (strata.get(key) ?? 0) + 1);
  }
  return [...strata.entries()].sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0));
}
