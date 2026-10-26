# agentmeasure

测量一个已上线分类 / triage agent 的真实错误率：从生产日志分层抽样，生成给人标注的 CSV，再算准确率和 Wilson 置信区间。零依赖；不调用模型，结果可复现。

> GitHub 仓库名是 `openbot-agentmeasure`，CLI 可执行名是 `agentmeasure`。

## 安装

需要 Node >= 22。没有第三方依赖，不需要 `npm install`。

```bash
node src/cli.mjs --help
```

不想每次写路径，可以在本目录执行 `npm install -g .`，之后用 `agentmeasure`。

## 一条命令

```bash
node src/cli.mjs sample demo/decisions.jsonl --n 60 --seed 7 --out to_label.csv
```

2026-10-26，Node v24.19.0，在本机跑出的输出（demo 是合成数据，见文末）：

```text
agentmeasure 0.1.0 — 分层抽样
frame: demo\decisions.jsonl  200 条 · 5 类 · 15 层
source: human 20 · model 180 · rule 0 · none 0
⚠ frame 里 180/200 条标签来自模型。抽样 CSV 里它们只作为 stored_label 参考列，不是答案。

sample: 60 / 200 条（请求 60，seed 7，按 predicted × confidence 分层）
confidence: low 16 · mid 29 · high 15

  account|high               3 / 7
  account|low                2 / 6
  account|mid                4 / 14
  ...
  spam|mid                   6 / 20

to_label.csv: 60 行，human_label 列已留空
下一步：在表格里填 human_label，然后 agentmeasure score to_label.csv

说明：抽样结果由 seed 决定，同样的输入和 seed 会得到同一批 id。
```

人工填完 `human_label` 后评分：

```bash
node src/cli.mjs score to_label.csv --out report.md
```

```text
agentmeasure 0.1.0 — 评分
file: demo\labeled.csv  60 行 · 已标注 54 · 缺失 6

accuracy 0.78  95% CI [0.65, 0.87]  (Wilson, n=54)
account        P 0.75  R 0.67  (n=9)
billing        P 0.93  R 0.87  (n=15)
bug            P 0.77  R 0.77  (n=13)
refund         P 0.67  R 0.86  (n=7)
spam           P 0.70  R 0.70  (n=10)

→ 要把误差压到 ±5%，还需要约 212 条人工标注（目标样本量 266）
top disagreements: 10（见报告）

结论有效 → exit 0
```

同一批数据，如果把日志里模型自己写的 `stored_label` 当答案，工具会拒绝给结论：

```text
accuracy 0.98  95% CI [0.91, 1.00]  (Wilson, n=60)

✗ 用来当答案的标签有 55/60 条来自模型自己。这不是评测，是自证。换成人写的标签再跑。

→ 结论无效，样本量建议不适用。先把答案换成人工标签。
结论无效 → exit 1
```

这个 0.98 不是模型变准了，是把模型输出和模型输出比了一遍。

## 完整 demo

```bash
npm run demo
```

依次跑 check → sample → score → 泄漏判定，产物写到 `demo/out/`。

## 为什么不是又一个 eval 框架

- **promptfoo / ragas / LangSmith 默认你已经有 golden set**，而且常用 LLM 当裁判。生产 triage 系统通常没有标签，唯一有的标签还是模型自己写进日志的那一列。
- **本工具从日志分层抽样**（按 `predicted` × 置信度分桶），生成一份给人标注的 CSV，再算每类 P/R 和 Wilson 区间。全程零模型调用，seed 写进报告，结果可复现。
- **它拦自标注泄漏**：如果你用来当答案的标签来自模型自己（`label_source: model`），结论直接判 invalid，退出码 1。这是现有 eval 工具默认不拦的失败模式。
- **它回答"还要标多少条"**：按当前观测准确率和有限总体修正，算出把区间压到 ±5% 还需要多少条人工标注，避免标 20 条就下结论。

## 输入格式

`decisions.jsonl`，一行一条决策：

```json
{"id":"d-0001","ts":"2026-10-20T09:12:00Z","input":"客户说发票金额对不上，要求重开","predicted":"billing","confidence":0.82,"stored_label":"billing","label_source":"model"}
```

| 字段 | 必需 | 说明 |
| --- | --- | --- |
| `id` | 是 | 唯一。用于把标注结果 join 回日志 |
| `predicted` | 是 | agent 输出的类别 |
| `confidence` | 是 | 0–1。缺失时无法分层，直接报错而不是猜 |
| `input` | 否 | 原文。抽样 CSV 会带上，方便标注时判断 |
| `stored_label` | 否 | 日志里原有的标签（可能是模型写的） |
| `label_source` | 否 | `model` / `human` / `rule` / `none`。决定泄漏检测 |

字段名不猜别名：`predicted` 就是 `predicted`，`label` 不是它的别名。写错会被 `check` 直接拒绝并给出行号。

## 命令

### `check <decisions.jsonl>`

校验 schema，统计帧里标签的来源构成。重复 id、超范围置信度、缺字段都会指出行号。

### `sample <decisions.jsonl> --n <数量> --seed <整数> --out <csv>`

分层抽样：层 = `predicted` × 置信度桶（`low` < 0.7 ≤ `mid` < 0.9 ≤ `high`）。先保证每个非空层至少 1 条，剩余按最大余数法按比例分配；层内用按层派生的种子打乱。

CSV 列：`id, ts, predicted, confidence, stored_label, label_source, input, human_label`。`human_label` 留空。以 `= + - @` 开头的单元格会加前缀，避免被表格软件当公式执行。

### `score <labeled.csv>`

| 选项 | 默认 | 说明 |
| --- | --- | --- |
| `--label-column <列名>` | `human_label` | 当答案用的列。用别的列会触发来源检查 |
| `--fail-under <0-1>` | 无 | 准确率低于它就退 1，可当 CI gate |
| `--min-support <整数>` | `1` | 文本输出里只列出 support 达到该值的类别 |
| `--out <file>` | 无 | 写 Markdown 报告 |
| `--report <file>` | 无 | 写 JSON 报告 |
| `--frame-size <整数>` | 无 | 原始日志条数，用于有限总体修正 |
| `--target-margin <0-1>` | `0.05` | 样本量建议的目标误差 |
| `--json` | 关 | 把 JSON 打到 stdout，替代文本输出 |

退出码：`0` 评分完成；`1` 判定无效（自标注泄漏）或低于 `--fail-under`；`2` 参数或数据格式错误。

## 限制（先说清楚）

- **不做标注**，只生成表格并计算。标得对不对，工具不知道。
- **分层只按 predicted × confidence**。如果错误集中在某个输入长度区间，本工具不会自动发现。
- **Wilson 区间假设样本近似随机**。分层抽样合并后的区间是近似值，权重不同时会有偏差。
- **只测类别对不对**，不测延迟、成本或工具调用成功率。
- **demo 数据是合成的**。`demo/decisions.jsonl` 由 `tools/make-demo.mjs` 用一个固定种子生成；`demo/labeled.csv` 里的 `human_label` 是"模拟标注员"按生成器真值填的，用来演示报告格式，**不是真实评测结果，也不是真人标注**。重新生成：`npm run make-demo`，测试会校验它与提交的文件一致。

## 测试

```bash
npm test
```

59 个用例，覆盖：Wilson 区间边界、分层配额分配、抽样可复现、CSV 转义与公式注入、混淆矩阵与 P/R、泄漏判定、退出码、demo 数据可复现。

## License

MIT
