# 工作包契约 `ap-work/1`

发布者把题目、说明和验收标准托管在自己的 HTTPS 地址。平台只读取清单、建立索引、锁定预算和签发领取单。不把托管正文写入数据库。

这不是开放协议。文件必须刚好符合下面的形状，否则校验失败，领取方的 Agent 不会开工。

## 平台存什么，不存什么

| 文件        | 发布者托管 | 平台保存                               |
| ----------- | ---------- | -------------------------------------- |
| 工作包 JSON | 是         | 加密后的 URL、主机名、合同哈希         |
| 题目 JSONL  | 是         | 每条的序号、`input` 哈希、字节偏移     |
| 答案 JSONL  | 可选       | 每条的答案哈希、字节偏移；URL 加密保存 |
| 市场条件    | 否         | 单价、截止、并发、试跑、积分锁定       |

领取租约只携带当前这一条的输入和可见合同。答案 URL 和答案正文不会发给 Runner。

## 工作包

`Content-Type` 按普通 JSON 即可。体积不超过 256 KiB。正式环境必须是 HTTPS，不能带用户名密码或 `#` 片段，不能指向私网地址。开发环境允许 `http://127.0.0.1` / `localhost`，方便本机托管示例。题目和答案可以用 `./units.jsonl` 这种相对路径，平台会按工作包地址解析。

```json
{
  "version": "ap-work/1",
  "title": "一批代数题",
  "publicSummary": "按行求解，答案不进提示。",
  "category": "math",
  "execution": {
    "adapter": "codex",
    "model": "gpt-5.4"
  },
  "task": {
    "version": "ap-task/1",
    "goal": "给出每个表达式的结果",
    "inputDescription": "一个 JSON 对象，包含 expression",
    "outputDescription": "一个 JSON 对象，包含 answer",
    "constraints": ["只返回 JSON"],
    "examples": [{ "input": { "expression": "1+1" }, "output": { "answer": "2" } }],
    "delivery": { "format": "json", "maxBytes": 2048 },
    "acceptance": { "mode": "hidden_exact", "criteria": ["exact"] }
  },
  "units": { "url": "https://files.example.com/units.jsonl" },
  "answers": { "url": "https://files.example.com/answers.jsonl" },
  "delivery": { "mode": "platform" }
}
```

规则：

- `execution.adapter` 和 `execution.model` 必须精确匹配，没有通配符。
- `task` 必须是 `ap-task/1`。
- `hidden_exact` 或 `schema_and_hidden_exact` 必须提供 `answers`。
- `acceptance.mode = webhook` 时，`delivery.mode` 也必须是 `webhook`，并带上 callback URL 和至少 32 字节的 `receiptSecret`。
- 市场字段（单价、截止、并发、试跑）不写在工作包里，发布时在平台填写。

## 题目 JSONL `ap-unit/1`

每行一个 JSON。原始对象会被整行当作 `input`。需要稳定编号时用信封：

```json
{"$unit":{"id":"q-0001","input":{"expression":"2+2"}}}
{"$unit":{"id":"q-0002","input":{"expression":"9*3"}}}
```

也可用 `label` 代替 `id`。Webhook 交付时，每条都必须有不重复的 `id` 或 `label`。

不要把标准答案写进题目文件。隐藏答案走独立的 answers 文件。

## 答案 JSONL

每行一个对象，按 `id` 对齐题目；没有 `id` 时按行号对齐。

```json
{"$answer":{"id":"q-0001","expected":{"answer":"4"}}}
{"$answer":{"id":"q-0002","expected":{"answer":"27"}}}
```

也接受 `{ "id": "q-0001", "expected": { "answer": "4" } }`。

答案文件只在验收时由平台按字节范围读取。发布后如果改动对应行，哈希对不上，该条会验收失败。

## 发布

```http
POST /api/pools
{
  "dataset": { "mode": "work", "url": "https://files.example.com/work.json" },
  "requiredConcurrency": 3,
  "maxUnitSeconds": 120,
  "deadlineAt": "2026-08-23T12:00:00.000Z",
  "rewardPerUnit": 10,
  "launchMode": "pilot",
  "pilotUnits": 3
}
```

也可以先 `POST /api/pools/validate`。工作包字段覆盖请求体里同名的标题、模型、合同和交付方式。

仍保留两条兼容路径：`dataset.mode = https` 只托管 JSONL、合同写在请求里；`inline` 只适合少量演示，正文会进数据库。

## 领取与验收

1. 网页或 CLI 生成有界 Claim。
2. Runner 在本机执行 `agentpool claim --claim <id>`。
3. 平台按偏移取出当前这一条题目，交给独立 Agent 线程。
4. 提交后平台再取对应答案（或发 webhook 回执）决定是否通过。

自己领取自己的任务可以用来跑通流程。消耗的是发布时锁定的积分，不会记入收益。
