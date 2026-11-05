# A-13 / §20 端到端 worked example 运行记录（真实模型，2026-11-05）

> **真实模型环境。**
> Provider：LongCat OpenAI 兼容端点 `https://api.longcat.chat/openai`，模型 `LongCat-2.5`。
> 凭据仅在运行期间从 `server/.env`（已被 `.gitignore` 覆盖）读取，运行结束即删除；本记录不含凭据明文或片段。
> Token 取 provider 返回的 `usage`；成本按 provider 上报口径记录（未返回则写「provider 未返回」，不估算）。

- 运行脚本：`node scripts/run-worked-example.js --real-provider --out docs/e2e-worked-example-run-2026-11-05-realmodel.json`
- 机器可读记录：`docs/e2e-worked-example-run-2026-11-05-realmodel.json`
- 并列保留的 stub 记录：`docs/e2e-worked-example-2026-11-05.md` / `docs/e2e-worked-example-run-2026-11-05.json`（未覆盖）
- traceId：`trace_9b0c48ab-f21f-46db-b9f6-b72763691210`
- 运行时间：`2026-11-05T16:05:32.215Z` 起，`2026-11-05T16:06:15.876Z` 止，总耗时 **43,661 ms**

## 判定

**通过。** 九步全部真实执行，三个模型调用均由 LongCat-2.5 返回；两个 Worker 并行窗口成立（`parallel: true`，任务 `startedAt/completedAt` 区间重叠）；Reviewer 独立裁决 `pass`，冲突 C1 以 `review` 方法选中 A1，交付产物与来源链闭合。

## 九步记录

| 步骤 | 内容 | 输入摘要 | 输出 / 证据 |
| --- | --- | --- | --- |
| 1 | 准备真实 provider 与 Agent 配置 | LongCat 端点、`researcher` / `reviewer` 配置与凭据引用 | `providerId=1f13b921-6f9d-43e3-a668-6eb33e55579f`；环境 `realModel: true`；耗时 29 ms |
| 2 | 两个 Worker 并行研究 | 两条独立研究目标（Vendor A 月订阅价），要求严格 JSON | 任务 `task_64a130c0-d125-4506-bfa9-372ebd473c55` / `task_a3ed7220-734d-45c2-8dbc-7c063de8013c`；`parallel: true`；两段区间均在 7,304 ms 窗口内完成 |
| 3 | 各写 A1 / B1 | Worker 模型输出 + 来源页快照 | A1 `art_212abb65044776ad870cf1a5fecebcf1`、B1 `art_e5bbbc1b701e3838ea399b4a281100f0`；S1 `art_46315bf46e254c1b9bcc3495b8a73327`、S2 `art_cfc1108723e7f1ce4b66aa1fb1e15058`；均带 `provenanceRefs`、`taintLabels`（`unverified` + `web:vendor-a.example`）与 `createdAt` |
| 4 | schema 检查 | `result_shape` / `required_fields` / `artifact_refs` / `content_readable` / `hash_match` | A1、B1 全过 |
| 5 | 引用检查 | `refs_resolvable` / `version_consistent` | A1、B1 全过 |
| 6 | 来源检查 | `evidence_resolvable` / `provenance_intact` | A1、B1 全过 |
| 7 | Reviewer 对照来源裁决冲突 C1 | A1=$99（2026-11-05 抓取）、B1=$129（2026-10-26 缓存） | Reviewer 任务 `task_2069e6b0-382d-41f7-bf92-3723468674df`；`reviewerIndependent: true`；`decision=pass`；冲突 `conflict_b56a4de3c1ac7c2ee840cd0b6f67849d` 状态 `resolved`，选中 A1 `art_212abb65…`；证据为两个 source 产物；耗时 36,279 ms |
| 8 | 交付建议 + 来源 + 分歧 + 不确定性 | C1 裁决结果 + 两个来源 | 交付产物 `art_2778a31645988392434081ac0eea2d85`；provenance 链 5 级完整；剩余不确定性 2 条（来源时间差 10 天、`$99`/`$129` 差异原因需重抓确认） |
| 9 | trace / 事件 / Token / 延迟 / 成本 | 三个任务的 runs[] 与事件流 | 事件 id 见 JSON；Token 合计 **4,142**（A 560 + B 571 + Reviewer 3,011）；延迟 A 7,266 ms / B 4,293 ms / Reviewer 36,237 ms；成本**provider 未返回** |

## 真实 Token / 延迟 / 成本

| 阶段 | prompt_tokens | completion_tokens | total_tokens | 延迟 |
| --- | --- | --- | --- | --- |
| Worker A | 374 | 186 | 560 | 7,266 ms |
| Worker B | 387 | 184 | 571 | 4,293 ms |
| Reviewer | 597 | 2,414 | 3,011 | 36,237 ms |
| **合计** | **1,358** | **2,784** | **4,142** | 任务级合计 47,796 ms；整轮墙钟 43,661 ms |

- Token 口径：provider 返回的 `usage`（`prompt_tokens` / `completion_tokens` / `total_tokens`），未做字符估算。
- 成本：LongCat 响应未返回计价字段，记「provider 未返回」。
- 延迟口径：任务 `completedAt − createdAt`；Reviewer 包含模型推理耗时，故显著高于 Worker。

## 失败轮次与作废消耗

本轮为拿到稳定真实输出共执行 7 次真实模型调用链（1 次首次 + 6 次调整/复跑）。失败与作废轮如实记录如下，未用 stub 数据补位：

| 轮次 | traceId | 结果 | 可核实 Token | 说明 |
| --- | --- | --- | --- | --- |
| 1 | `trace_7e1ccaad-5dad-4d04-b132-a3c732c4d22b` | Worker B `finishReason=length`（maxTokens 640 被 reasoning 占满） | 未采集 | 失败记录尚未捕获 usage；A 已完成，B 空回复 |
| 2 | `trace_5c147f2c-a55f-44bd-a2e4-0de8a455d709` | Reviewer `tool_call_budget` | 1,842（A 799 + B 1,043；Reviewer 未采集） | Reviewer maxTokens 未单独提高 |
| 3 | `trace_73d51ca2-e03d-41ee-9a6c-ee10c936f148` | 冲突 C1 `unresolved/review_rejected` | 3,718（1,239 + 1,240 + 1,239） | Reviewer 输出未形成 `pass` 裁决 |
| 4 | `trace_ec5bd8b3-f7fd-4da1-bf4c-688f8e2c01f7` | 九步跑通，但脚本并行断言因事件窗口裁剪为 `undefined` 而退出 2 | 6,148 | 链路本身已通过；作废原因是断言实现 |
| 5 | `trace_69162bd0-35e7-4abb-82b5-67d2888f99b1` | Worker B `finishReason=length`（maxTokens 2048 被占满） | 551（A；B 未采集） | 复现截断 |
| 6 | `trace_4998ee58-59d4-4bb5-aa87-004c9aab4dec` | 九步跑通，但 Worker B 延迟因事件裁剪未取到 | 5,611 | 指标不完整，作废 |
| 7（最终） | `trace_9b0c48ab-f21f-46db-b9f6-b72763691210` | **通过** | 4,142 | 本记录采用 |

可核实作废 Token 合计：**17,870**（不含第 1 轮未采集部分）；另有 Reviewer/Worker 在失败轮中未回传 usage 的消耗未计入。

失败轮记录文件：
- `docs/e2e-worked-example-run-2026-11-05-realmodel-round1-failed.json`
- `docs/e2e-worked-example-run-2026-11-05-realmodel-round2-failed.json`
- `docs/e2e-worked-example-run-2026-11-05-realmodel-round3-failed.json`
- `docs/e2e-worked-example-run-2026-11-05-realmodel-round4-failed.json`（九步记录，并行断言退出）
- `docs/e2e-worked-example-run-2026-11-05-realmodel-round5-failed.json`
- `docs/e2e-worked-example-run-2026-11-05-realmodel-round6-wasted-metrics.json`（九步记录，Worker B 延迟未取到）

## 脚本改动（保持默认 stub 行为不变）

- 新增 `--real-provider` / `--provider longcat` 分支：注册 LongCat provider，凭据经 `server/.env` 注入，不落日志。
- Worker 输出增加 JSON 提取容错（代码围栏、前后缀）；Reviewer 使用既有 `parseVerdict` 的提取逻辑；真实模型仍按严格 JSON 结构产出。
- 真实模式提高 `maxTokens`（Worker 4,000 / Reviewer 4,000）与 deadline（120 s），避免 reasoning tokens 截断。
- 并行窗口判定改用任务记录的 `startedAt/completedAt`（事件日志按 bot 只保留最近 200 条，长耗时会把 `task.accepted` 挤出窗口）。
- 失败时写出可复核 JSON（步骤、任务状态、已取到的 usage），不补位。

## 可复核方式

1. 打开 `docs/e2e-worked-example-run-2026-11-05-realmodel.json`，按 `steps[0..8]` 核对输入/输出摘要、trace 与事件 id。
2. 复跑（需本机 `server/.env` 中有 LongCat 凭据；跑完删除）：
   `node scripts/run-worked-example.js --real-provider --out <临时路径>`
3. 默认 stub 回归：
   `node scripts/run-worked-example.js --out <临时路径>`
   `node --test tests/agent-worked-example-e2e.test.js`

## 限定

- 本记录证明真实模型链路（并行研究 → A1/B1 → 验证 → 独立裁决 → 交付）可跑通；不证明外部检索真实性：A/B 的事实材料由脚本给定，模型负责结构化与裁决。
- 仲裁只覆盖事实型冲突（C1）；`planVersion v2` / `fencing` / `waiting_approval` 仍未纳入本 worked example（保持 A-13 原有范围限定）。
- 成本未由 provider 返回，无法给出货币金额；不得用公开价目表反推。
- 真实模型存在输出波动：同一任务在不同轮次可能截断或裁决不一致；失败轮消耗已如实记录。
