# A-13 / §20 端到端 worked example 运行记录（2026-11-05）

> **非真实模型环境，仅验证链路与数据形态。**
> 本次运行使用仓库内的本地 OpenAI 兼容 HTTP stub（127.0.0.1 随机端口），不是真实模型服务。
> Token 为 provider 实际返回的 `usage`；本地 stub 无计价口径，成本记为「未采集」，未做任何估算。

- 运行脚本：`node scripts/run-worked-example.js --out docs/e2e-worked-example-run-2026-11-05.json`
- 机器可读记录：`docs/e2e-worked-example-run-2026-11-05.json`
- 自动化用例：`tests/agent-worked-example-e2e.test.js`
- traceId：`trace_77086298-25a5-4ec1-82ab-5efdafbc3cbf`
- 运行时间：`2026-11-05T14:07:12.473Z` 起，总耗时 805 ms

## 九步记录

| 步骤 | 内容 | 输入摘要 | 输出 / 证据 |
| --- | --- | --- | --- |
| 1 | 准备本地 provider 与 Agent 配置 | 本地 HTTP stub、researcher / reviewer 配置 | `providerId` 见 JSON；环境标注 `realModel: false` |
| 2 | 两个 Worker 并行研究 | 两条独立研究目标（Vendor A 月订阅价） | 任务 `task_ed029110…` 与 `task_1b22a0c5…`；`parallel: true`（accepted/completed 事件窗口重叠） |
| 3 | 各写 A1 / B1 | Worker 模型输出 + 来源页快照 | A1 `art_467c54fd…`、B1 `art_1925fe1b…`；S1 `art_2b4997d4…`、S2 `art_fbe84c85…`；均带 `provenanceRefs`、`taintLabels`（含 `unverified`）与 `createdAt` |
| 4 | schema 检查 | A1/B1 的 `result_shape` / `required_fields` / `artifact_refs` / `content_readable` / `hash_match` | A1、B1 全过 |
| 5 | 引用检查 | `refs_resolvable` / `version_consistent` | A1、B1 全过 |
| 6 | 来源检查 | `evidence_resolvable` / `provenance_intact` | A1、B1 全过 |
| 7 | Reviewer 对照来源裁决冲突 C1 | A1=$99（2026-11-05 抓取）、B1=$129（2026-10-26 缓存） | Reviewer 任务 `task_ca32fc48…`；`reviewerIndependent: true`；冲突 `conflict_ad836ce0…`，方法 `review`，选中 A1 `art_467c54fd…` |
| 8 | 交付建议 + 来源 + 分歧 + 不确定性 | C1 裁决结果 + 两个来源 | 交付产物 `art_5101ee64…`；provenance 链完整；剩余不确定性 2 条（价格波动、来源时间差） |
| 9 | trace / 事件 / Token / 延迟 / 成本 | 三个任务的 runs[] 与事件流 | 事件 id 见 JSON `trace.eventIds`；Token 合计 **894**（A 244 + B 242 + Reviewer 408）；延迟 A 391 ms / B 431 ms / Reviewer 236 ms；成本**未采集** |

## 成本口径

- Token：取 provider 返回的真实 `usage`（`prompt_tokens` + `completion_tokens`），不使用字符数估算。
- 成本：本地 stub 无单价，记「未采集」；不得用公开价目表反推。
- 延迟：任务 `task.completed` 事件时间 − 任务 `createdAt`。

## 可复核方式

1. 打开 `docs/e2e-worked-example-run-2026-11-05.json`，按 `steps[0..8]` 逐步核对输入/输出摘要与事件 id。
2. 重跑脚本后与新记录比对九步形状与裁决结论（产物 id 每次不同，属正常）：
   `node scripts/run-worked-example.js --out <临时路径>`
3. 运行用例：`node --test tests/agent-worked-example-e2e.test.js`

## 限定

- 模型与来源均为本地 stub 构造的数据，不是真实外部检索或真实模型推理；本记录只证明「链路、字段、审计、裁决与成本口径」可跑通。
- 仲裁只覆盖事实型冲突（C1）；“谁有权申诉审批”等 A-08 规则不在此记录范围。
- 若换真实 provider，需重新跑一次并更新本文件与 JSON（Token/成本届时按真实账单口径记录）。
