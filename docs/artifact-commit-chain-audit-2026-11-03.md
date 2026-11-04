# Artifact 完成提交链审计（Bluebird Agent Runtime）

> 审计日期：2026-11-03
> 任务性质：只读取证，未修改任何源码、测试、配置、数据；未 commit、未 push、未切分支。
> 取证方式：静态读码 + 全仓检索。标注约定：
> - **【已验证】**：读码确认，可直接复核。
> - **【代码推断】**：结论来自控制流/调用顺序推导，未运行验证。
> - **【未取证】**：仓库内无材料可证，或需要运行才能确认。
>
> 口径说明：任务中所述“§11 完成提交五步”原文不在本仓库（v1.3 文档只含 §31–§42）。本审计的五步口径转引自 [phase0-baseline-audit-2026-11-03.md](file:///C:/Users/Administrator/Documents/Qoder/2026-10-27/975cfd2c/Bluebird/docs/phase0-baseline-audit-2026-11-03.md#L231-L240)，该处原文为：“产物持久化 → 提交引用 → 校验引用/schema/必需产物 → 才 completed → 失败进 retry/recovery”。**§11 原文本身：未取证。**

## 相关文档（链位置）

- 上游：[Phase 0 基线审计](phase0-baseline-audit-2026-11-03.md)（§4.4 五步口径转引；§11 原文未取证，见上方口径说明）、源码只读取证。
- 下游：[Phase 0 基线审计](phase0-baseline-audit-2026-11-03.md) 文末「勘误（后续查证 2026-11-03）」段（本次回写本审计 §2.2 的差异项：3 处描述偏差 + 1 处作用域限定 + 1 处遗漏）、[文档链总索引](doc-chain-index-2026-11-03.md)。
- 本文件位置：**产物与完成提交链的唯一现状口径**；`updateTask` 重启重跑等推断项仍标【代码推断】。

---

## 结论先行

1. **产物（artifact）在整条完成链中没有被持久化。** 成功结果的唯一构造点是 [runtime.js](file:///C:/Users/Administrator/Documents/Qoder/2026-10-27/975cfd2c/Bluebird/server/agents/runtime.js#L710-L723)，其中 `artifacts: []` 是**字面量**。全仓不存在 artifact store、artifact registry、artifact 数据文件或 artifact API。【已验证】
2. **`artifacts` 恒为空的原因是“从未写入”，不是“写入后被覆盖/丢弃”。** 上游 `execute()` 的返回值（`runtime.js:383-397`）与 `runAgentTurn()` 的返回值（`agent-runtime.js:1059-1070`）都不包含任何产物字段；唯一的证据收集函数 `extractEvidence()`（`runtime.js:157-186`）只写 `evidence` / `changes`。【已验证】
3. **§11 五步协议：第 1、2、3 步缺失；第 4 步（写 completed）有实现但无门禁；第 5 步（失败进 retry/recovery）只覆盖模型类错误，不含产物失败。** 缺失分别落在 Worker 层（不产出产物）、Workflow 层（无提交协议）、存储层（无 artifact store、无版本、无 CAS）。【已验证】
4. **状态一致性风险存在，但不在 artifact 维度：** 当前不存在 `pending-commit` / `orphan` 概念，也没有 artifact 恢复扫描。真正的风险是 `updateTask()` **先改内存、后落盘**（`tasks.js:700-703` 对 `:853-854`），落盘失败时内存已显示 `completed`，`runTask` 的 catch 分支会因“已终态”直接返回，可能造成“内存 completed / 磁盘 running”的分裂，重启后被 `recoverInterrupted()` 重新排队并**重复执行**。【代码推断】+【已验证：控制流】
5. **最小改动落点：** 新增 `server/agents/artifact-store.js` → 改 `worker-result.js` 的 ref schema → 改 `runtime.js` 的产物收集与提交顺序 → 在 `tasks.js` 增加**显式提交函数**（不要给通用 `updateTask` 加强制门禁）→ 改 `task-store.js` 增加 CAS → 在 `initializeTaskQueue()` 增加 pending-commit 扫描。现有测试**没有任何一条断言 `artifacts: []`**；但有多条测试直接用 `updateTask` 写入 `completed`，若把门禁塞进 `updateTask` 会直接打断它们。

---

## 1. 实际调用链：Worker 产出结果 → task 置为 completed

### 1.1 链的起点（任务创建与入队）

| # | 函数 / 位置 | 作用 | 证据 |
|---|---|---|---|
| 0-a | `routes.js` `POST /agent-tasks` 处理器 | 接收派发请求，调用 `agentRouter.dispatch(...)`，返回 202 + 任务快照 | [routes.js:441-478](file:///C:/Users/Administrator/Documents/Qoder/2026-10-27/975cfd2c/Bluebird/server/agents/routes.js#L441-L478)（`res.status(202)` 在 `:477`） |
| 0-b | `router.dispatch()` → `taskStore.createTask()` | 落任务（`status: 'queued'`），然后立刻 `startTask(task.taskId)` | [router.js:482](file:///C:/Users/Administrator/Documents/Qoder/2026-10-27/975cfd2c/Bluebird/server/agents/router.js#L482)、[router.js:537](file:///C:/Users/Administrator/Documents/Qoder/2026-10-27/975cfd2c/Bluebird/server/agents/router.js#L537)、[tasks.js:484-666](file:///C:/Users/Administrator/Documents/Qoder/2026-10-27/975cfd2c/Bluebird/server/agents/tasks.js#L484-L666)（初始 `status: 'queued'` 在 `:639`） |
| 0-c | `runtime.startTask()` | `setImmediate` → `scheduleTaskQueue()` | [runtime.js:917-924](file:///C:/Users/Administrator/Documents/Qoder/2026-10-27/975cfd2c/Bluebird/server/agents/runtime.js#L917-L924) |
| 0-d | `runtime.scheduleTaskQueue()` | 按并发额度取 `tasks.nextQueuedTask()`，调用 `runTask()` | [runtime.js:51-89](file:///C:/Users/Administrator/Documents/Qoder/2026-10-27/975cfd2c/Bluebird/server/agents/runtime.js#L51-L89) |

### 1.2 主链（`runTask` 内部，按执行顺序）

| # | 函数 | 文件:行 | 说明 |
|---|---|---|---|
| 1 | `tasks.getRawTask()` / 终态与 wait 检查 | [runtime.js:491-494](file:///C:/Users/Administrator/Documents/Qoder/2026-10-27/975cfd2c/Bluebird/server/agents/runtime.js#L491-L494) | `waiting_approval` 不是终态，直接返回不执行 |
| 2 | `tasks.acquireLease()` | [runtime.js:532-535](file:///C:/Users/Administrator/Documents/Qoder/2026-10-27/975cfd2c/Bluebird/server/agents/runtime.js#L532-L535) → [tasks.js:882-906](file:///C:/Users/Administrator/Documents/Qoder/2026-10-27/975cfd2c/Bluebird/server/agents/tasks.js#L882-L906) | 租约互斥（非 CAS，见 §4） |
| 3 | `tasks.recordRunStart()` | [runtime.js:536-540](file:///C:/Users/Administrator/Documents/Qoder/2026-10-27/975cfd2c/Bluebird/server/agents/runtime.js#L536-L540) → [tasks.js:941-962](file:///C:/Users/Administrator/Documents/Qoder/2026-10-27/975cfd2c/Bluebird/server/agents/tasks.js#L941-L962) | 向 `runs[]` 追加 running 记录 |
| 4 | `tasks.updateTask({ status: 'accepted', ... })` | [runtime.js:541-547](file:///C:/Users/Administrator/Documents/Qoder/2026-10-27/975cfd2c/Bluebird/server/agents/runtime.js#L541-L547) → [tasks.js:695-856](file:///C:/Users/Administrator/Documents/Qoder/2026-10-27/975cfd2c/Bluebird/server/agents/tasks.js#L695-L856) | `assertTransition()` 在 `:700-703` |
| 5 | Worker 会话归属/生命周期 | [runtime.js:565-604](file:///C:/Users/Administrator/Documents/Qoder/2026-10-27/975cfd2c/Bluebird/server/agents/runtime.js#L565-L604) | 不涉及产物 |
| 6 | `tasks.updateTask({ status: 'running' })` | [runtime.js:607-617](file:///C:/Users/Administrator/Documents/Qoder/2026-10-27/975cfd2c/Bluebird/server/agents/runtime.js#L607-L617) | 心跳/截止时间计时从 `:607-657` 起 |
| 7 | `projectWorkerContext()` + `createToolAuthorizer()` | [runtime.js:660-666](file:///C:/Users/Administrator/Documents/Qoder/2026-10-27/975cfd2c/Bluebird/server/agents/runtime.js#L660-L666) | 只投影摘要/引用/授权数据 |
| 8 | `runtime.execute()` | [runtime.js:668-694](file:///C:/Users/Administrator/Documents/Qoder/2026-10-27/975cfd2c/Bluebird/server/agents/runtime.js#L668-L694) → 定义在 [runtime.js:201-398](file:///C:/Users/Administrator/Documents/Qoder/2026-10-27/975cfd2c/Bluebird/server/agents/runtime.js#L201-L398) | 组装 policy、runId（`:236`）、证据数组 |
| 9 | `runAgentTurn()` | [runtime.js:246-352](file:///C:/Users/Administrator/Documents/Qoder/2026-10-27/975cfd2c/Bluebird/server/agents/runtime.js#L246-L352) → [agent-runtime.js:1059-1070](file:///C:/Users/Administrator/Documents/Qoder/2026-10-27/975cfd2c/Bluebird/server/agent-runtime.js#L1059-L1070) | 返回 `{ rawReply, toolSteps, rounds, maxRounds, completion, stopReason, toolCallCount, readOnlyRetries, reachedMaxRounds, delegationEnforced }`；**无 artifacts** |
| 10 | `execute()` 组装返回值 | [runtime.js:383-397](file:///C:/Users/Administrator/Documents/Qoder/2026-10-27/975cfd2c/Bluebird/server/agents/runtime.js#L383-L397) | 返回 `rawReply / toolSteps / rounds / stopReason / evidence / changes / runId`；**无 artifacts** |
| 11 | 终态/取消/waiting 复查 | [runtime.js:696-703](file:///C:/Users/Administrator/Documents/Qoder/2026-10-27/975cfd2c/Bluebird/server/agents/runtime.js#L696-L703) | `waiting_approval` 保留等待态 |
| 12 | `normalizeWorkerResult({ status:'completed', artifacts: [] })` | [runtime.js:710-723](file:///C:/Users/Administrator/Documents/Qoder/2026-10-27/975cfd2c/Bluebird/server/agents/runtime.js#L710-L723) | **产物在此被硬编码为空**（`:713`） |
| 13 | `tasks.updateTask({ status:'completed', completedAt, result })` | [runtime.js:725-729](file:///C:/Users/Administrator/Documents/Qoder/2026-10-27/975cfd2c/Bluebird/server/agents/runtime.js#L725-L729) → [tasks.js:784-854](file:///C:/Users/Administrator/Documents/Qoder/2026-10-27/975cfd2c/Bluebird/server/agents/tasks.js#L784-L854) | **状态与结果在同一次调用内落库** |
| 14 | `tasks.saveTasks()` → `taskStore.write()` → `writeFileAtomicSync()` | [tasks.js:180-182](file:///C:/Users/Administrator/Documents/Qoder/2026-10-27/975cfd2c/Bluebird/server/agents/tasks.js#L180-L182) → [task-store.js:110-113](file:///C:/Users/Administrator/Documents/Qoder/2026-10-27/975cfd2c/Bluebird/server/agents/task-store.js#L110-L113) → [atomic-write.js:51-81](file:///C:/Users/Administrator/Documents/Qoder/2026-10-27/975cfd2c/Bluebird/server/atomic-write.js#L51-L81) | 整文件原子重写，无版本比较 |
| 15 | `tasks.recordRunFinish()` / `tasks.releaseLease()` | [runtime.js:730-735](file:///C:/Users/Administrator/Documents/Qoder/2026-10-27/975cfd2c/Bluebird/server/agents/runtime.js#L730-L735) → [tasks.js:964-992](file:///C:/Users/Administrator/Documents/Qoder/2026-10-27/975cfd2c/Bluebird/server/agents/tasks.js#L964-L992)、[tasks.js:931-939](file:///C:/Users/Administrator/Documents/Qoder/2026-10-27/975cfd2c/Bluebird/server/agents/tasks.js#L931-L939) | 二次落盘（同一文件再写一遍） |
| 16 | `safeEvent('task.completed')` → `tasks.appendEvent()` | [runtime.js:736-746](file:///C:/Users/Administrator/Documents/Qoder/2026-10-27/975cfd2c/Bluebird/server/agents/runtime.js#L736-L746) → [tasks.js:255-321](file:///C:/Users/Administrator/Documents/Qoder/2026-10-27/975cfd2c/Bluebird/server/agents/tasks.js#L255-L321) | 先写 outbox（`:280-299`），再写主事件文件（`:301-310`） |
| 17 | `resultDelivery.deliverTaskOutcome()` | [runtime.js:747-750](file:///C:/Users/Administrator/Documents/Qoder/2026-10-27/975cfd2c/Bluebird/server/agents/runtime.js#L747-L750) → [result-delivery.js:104-204](file:///C:/Users/Administrator/Documents/Qoder/2026-10-27/975cfd2c/Bluebird/server/agents/result-delivery.js#L104-L204) | 写父主控会话消息 `bot-result-<taskId>`（`:120`、`:156-166`），再 `markDelivery()` 回写投递字段（`:187-192`） |

### 1.3 第二条到达 `completed` 的路径（审批执行）

`approvals.execute()` 在审批执行成功后也会把关联任务写成 `completed`，并自行构造结果，**同样不携带产物**：

- [approvals.js:413-445](file:///C:/Users/Administrator/Documents/Qoder/2026-10-27/975cfd2c/Bluebird/server/agents/approvals.js#L413-L445)：`normalizeWorkerResult({ status:'completed', ... })`（`:418-436`）→ `tasks.updateTask({ status:'completed', result })`（`:437-441`）→ `deliverTaskResult()`（`:442-445`）。
- 该构造函数没有传 `artifacts`，因此落到 [worker-result.js:60](file:///C:/Users/Administrator/Documents/Qoder/2026-10-27/975cfd2c/Bluebird/server/agents/worker-result.js#L60) 的默认 `[]`。

结论：**全仓只有这两个“→ completed”的写入点**（`runTask` 与 `approvals.execute`），两者都没有产物写入动作。【已验证】

### 1.4 产物是否被持久化？写到哪里、什么键、有没有版本号？

**没有被持久化。** 逐层证据：

| 层 | 是否产出/持久化产物 | 证据 |
|---|---|---|
| Worker（模型工具循环） | 否。返回值无产物字段 | [agent-runtime.js:1059-1070](file:///C:/Users/Administrator/Documents/Qoder/2026-10-27/975cfd2c/Bluebird/server/agent-runtime.js#L1059-L1070)；工具结果只推入 `toolSteps`（[agent-runtime.js:763](file:///C:/Users/Administrator/Documents/Qoder/2026-10-27/975cfd2c/Bluebird/server/agent-runtime.js#L763)） |
| Worker 包装层 `execute()` | 否。只有 `evidence`/`changes` 聚合 | [runtime.js:383-397](file:///C:/Users/Administrator/Documents/Qoder/2026-10-27/975cfd2c/Bluebird/server/agents/runtime.js#L383-L397)；`extractEvidence()` 只处理 `memory_search` / `memory_remember` / `knowledge_search`（`:157-186`） |
| Workflow（`runTask`） | 否。直接写 `artifacts: []` | [runtime.js:710-723](file:///C:/Users/Administrator/Documents/Qoder/2026-10-27/975cfd2c/Bluebird/server/agents/runtime.js#L710-L723) |
| 结果规范化 | 能做到“保留”，但输入永远为空 | [worker-result.js:21-30](file:///C:/Users/Administrator/Documents/Qoder/2026-10-27/975cfd2c/Bluebird/server/agents/worker-result.js#L21-L30)、[worker-result.js:79](file:///C:/Users/Administrator/Documents/Qoder/2026-10-27/975cfd2c/Bluebird/server/agents/worker-result.js#L79) |
| 存储层 | 只在任务对象内保存 ref 数组，不存产物正文 | [tasks.js:797-805](file:///C:/Users/Administrator/Documents/Qoder/2026-10-27/975cfd2c/Bluebird/server/agents/tasks.js#L797-L805) 写入 `agent-tasks.json` 的 `task.result.artifacts` |
| Artifact Store | **不存在** | `server/` 目录内 `grep artifact`（排除 `node_modules`）仅命中：`worker-result.js:6,60,79`、`tasks.js:797-798`、`runtime.js:713`、`backup.js:67,252,1311`（`isRuntimeArtifact` 指备份临时文件，与本主题无关）；`lib/`、`components/`、`hooks/` 零命中 |

**键与版本号：**

- 若产物 ref 非空，落库位置是任务对象 `result.artifacts`，文件为 `DATA_DIR/agents/agent-tasks.json`（[task-store.js:22](file:///C:/Users/Administrator/Documents/Qoder/2026-10-27/975cfd2c/Bluebird/server/agents/task-store.js#L22)），键为 `tasks[taskId].result.artifacts[]`。
- **无 artifact 版本的任何字段**。现存的“版本号”与产物无关：
  - `contractVersion: 1`：Task Contract 版本（[tasks.js:41](file:///C:/Users/Administrator/Documents/Qoder/2026-10-27/975cfd2c/Bluebird/server/agents/tasks.js#L41)、`:605`）；
  - 任务文件 `version: 2`：Store schema 版本（`SCHEMA_VERSION = 2` 在 [task-store.js:25](file:///C:/Users/Administrator/Documents/Qoder/2026-10-27/975cfd2c/Bluebird/server/agents/task-store.js#L25)，写入空库时在 `:29`）；
  - `checkpointVersion`：checkpoint 计数器（[tasks.js:1005-1006](file:///C:/Users/Administrator/Documents/Qoder/2026-10-27/975cfd2c/Bluebird/server/agents/tasks.js#L1005-L1006)），与产物无关。
- 即使调用方传入 `artifactId` / `version` / `contentRef`，也会在规范化时被**静默裁剪**：`refs()` 只保留 `{kind,id}` 两个字符串字段（[worker-result.js:21-30](file:///C:/Users/Administrator/Documents/Qoder/2026-10-27/975cfd2c/Bluebird/server/agents/worker-result.js#L21-L30)），`updateTask()` 再做一次同样的裁剪（[tasks.js:797-805](file:///C:/Users/Administrator/Documents/Qoder/2026-10-27/975cfd2c/Bluebird/server/agents/tasks.js#L797-L805)）。【已验证】

---

## 2. 为什么 `artifacts` 恒为空

### 2.1 判断：**从未写入**，不是“写入后被覆盖/丢弃”

依据链条：

1. **唯一的成功结果构造点就是硬编码空数组**：[runtime.js:710-723](file:///C:/Users/Administrator/Documents/Qoder/2026-10-27/975cfd2c/Bluebird/server/agents/runtime.js#L710-L723)，`:713` 为 `artifacts: [],`。这行没有任何变量参与，因此无论 Worker 产出什么，结果都为空。【已验证】
2. **上游没有可写入的数据源**：
   - `execute()` 的返回对象（[runtime.js:383-397](file:///C:/Users/Administrator/Documents/Qoder/2026-10-27/975cfd2c/Bluebird/server/agents/runtime.js#L383-L397)）不含 `artifacts`；
   - `runAgentTurn()` 的返回对象（[agent-runtime.js:1059-1070](file:///C:/Users/Administrator/Documents/Qoder/2026-10-27/975cfd2c/Bluebird/server/agent-runtime.js#L1059-L1070)）不含 `artifacts`；
   - `extractEvidence()`（[runtime.js:157-186](file:///C:/Users/Administrator/Documents/Qoder/2026-10-27/975cfd2c/Bluebird/server/agents/runtime.js#L157-L186)）只往 `evidence` / `changes` 里推对象。
   → 即“上游根本没有产物概念”，属于 **generate 侧缺失**，而不是 commit 侧丢失。【已验证】
3. **失败路径同样默认空**：`normalizeWorkerResult()` 的 `artifacts = []` 默认参数（[worker-result.js:60](file:///C:/Users/Administrator/Documents/Qoder/2026-10-27/975cfd2c/Bluebird/server/agents/worker-result.js#L60)）在 `runtime.js:776-782`（租约丢失）与 `:851-857`（通用失败/取消/超时）都未显式传值。【已验证】
4. **不存在“覆盖”路径**：`updateTask()` 只在 `patch.result !== undefined` 时整块重建 `result`（[tasks.js:784-852](file:///C:/Users/Administrator/Documents/Qoder/2026-10-27/975cfd2c/Bluebird/server/agents/tasks.js#L784-L852)）。`runTask` 在完成前会先检查 `latest.status`，不会用旧结果覆盖已终态任务（[runtime.js:696-703](file:///C:/Users/Administrator/Documents/Qoder/2026-10-27/975cfd2c/Bluebird/server/agents/runtime.js#L696-L703)）；完成后的 `recordRunFinish`/`releaseLease` 只改 `runs`/`lease`，不触碰 `result`（[tasks.js:964-992](file:///C:/Users/Administrator/Documents/Qoder/2026-10-27/975cfd2c/Bluebird/server/agents/tasks.js#L964-L992)、[tasks.js:931-939](file:///C:/Users/Administrator/Documents/Qoder/2026-10-27/975cfd2c/Bluebird/server/agents/tasks.js#L931-L939)）。【已验证】

### 2.2 与审计报告的差异

| 审计原文 | 代码实际 | 判定 |
|---|---|---|
| “`runtime.js:713`”（[audit:69](file:///C:/Users/Administrator/Documents/Qoder/2026-10-27/975cfd2c/Bluebird/docs/phase0-baseline-audit-2026-11-03.md#L69)、`:167`、`:209`） | 实际路径是 **`server/agents/runtime.js`**；同目录另有 `server/agent-runtime.js`（`runAgentTurn`），两者不同。仅写 `runtime.js` 会产生歧义。 | 审计描述不精确，结论仍成立 |
| “`artifacts` 数组元素是字符串 ref”（[audit:148](file:///C:/Users/Administrator/Documents/Qoder/2026-10-27/975cfd2c/Bluebird/docs/phase0-baseline-audit-2026-11-03.md#L148)）、“只接受字符串 ref 数组”（`audit:69`） | 元素是**对象** `{ kind, id }`，只是两个字段值被 `String()` 转成字符串；见 [worker-result.js:21-30](file:///C:/Users/Administrator/Documents/Qoder/2026-10-27/975cfd2c/Bluebird/server/agents/worker-result.js#L21-L30)。 | 审计描述有误；“无 artifactId/version”的结论仍成立 |
| “无对应测试”（[audit:209](file:///C:/Users/Administrator/Documents/Qoder/2026-10-27/975cfd2c/Bluebird/docs/phase0-baseline-audit-2026-11-03.md#L209)） | 全仓 `tests/` 检索 `artifacts` **零命中**。 | 结论成立 |
| “§11 完成协议 1–5 **均未实现**”（`audit:209`） | 第 4 步已有实际写入路径（[runtime.js:725-729](file:///C:/Users/Administrator/Documents/Qoder/2026-10-27/975cfd2c/Bluebird/server/agents/runtime.js#L725-L729)），第 5 步已有模型类错误重试（[runtime.js:820-847](file:///C:/Users/Administrator/Documents/Qoder/2026-10-27/975cfd2c/Bluebird/server/agents/runtime.js#L820-L847)）。准确说法是“4、5 部分实现，1–3 缺失”。 | 审计表述过宽，需按步拆分 |
| “无 `pending-commit/orphan`”（`audit:209`） | Agent 域无此概念；但 `orphan` 一词在仓库其他域存在（`sessions.js:134-149` 的 orphan messages、`retrieval/store.js:698-719` 的 orphan chunks）。审计未限定作用域，易被误读为“全仓无 orphan”。 | 需限定域 |
| 审计未指出 | `updateTask()` **先改内存后落盘**，这是比“结果与状态同一次写”更关键的失败语义（见 §4.1）。 | 审计遗漏 |

---

## 3. 对照 §11 五步协议

> 口径转引：`phase0-baseline-audit §4.4`。原文：**产物持久化 → 提交引用 → 校验引用/schema/必需产物 → 才 completed → 失败进 retry/recovery**。
>
> **【一手原文核对 2026-11-03 补注】** 上述转引有错位：一手原文 v1.1 §11 是 **5 条并列步骤**，第 3 步包含「才允许 task completed」，第 4 步才涉及失败进 retry/recovery，第 5 步涉及 `pending-commit`/`orphan`。逐字原文与更正对照见「附二 §附2.1」；本节原表保留不改，以附二为准。

| 步骤 | 结论 | 缺在哪一层 | 代码依据 |
|---|---|---|---|
| **1. 产物持久化** | **缺失** | Worker 层（不产出）+ Collaboration Store（无 artifact store） | 产物无生产源：[runtime.js:383-397](file:///C:/Users/Administrator/Documents/Qoder/2026-10-27/975cfd2c/Bluebird/server/agents/runtime.js#L383-L397)、[agent-runtime.js:1059-1070](file:///C:/Users/Administrator/Documents/Qoder/2026-10-27/975cfd2c/Bluebird/server/agent-runtime.js#L1059-L1070)；唯一结果点硬编码空：[runtime.js:713](file:///C:/Users/Administrator/Documents/Qoder/2026-10-27/975cfd2c/Bluebird/server/agents/runtime.js#L713)；无 artifact 文件/模块（`server/` 检索，见 §1.4） |
| **2. 提交引用（含版本）** | **缺失** | Workflow + Storage | ref 只有 `{kind,id}`，无 `artifactId`/`version`/`contentRef`（[worker-result.js:21-30](file:///C:/Users/Administrator/Documents/Qoder/2026-10-27/975cfd2c/Bluebird/server/agents/worker-result.js#L21-L30)、[tasks.js:797-805](file:///C:/Users/Administrator/Documents/Qoder/2026-10-27/975cfd2c/Bluebird/server/agents/tasks.js#L797-L805)）；无 CAS/expectedVersion（[tasks.js:695-703](file:///C:/Users/Administrator/Documents/Qoder/2026-10-27/975cfd2c/Bluebird/server/agents/tasks.js#L695-L703) 只做状态迁移断言；[task-store.js:110-113](file:///C:/Users/Administrator/Documents/Qoder/2026-10-27/975cfd2c/Bluebird/server/agents/task-store.js#L110-L113) 整文件覆盖写） |
| **3. 校验引用可读 / schema / 必需产物** | **缺失** | Workflow 层 | 无任何“提交前校验器”；`normalizeWorkerResult()` 只做截断/类型转换（[worker-result.js:57-98](file:///C:/Users/Administrator/Documents/Qoder/2026-10-27/975cfd2c/Bluebird/server/agents/worker-result.js#L57-L98)）；`updateTask()` 对 `result.artifacts` 只做 shape 过滤（[tasks.js:797-805](file:///C:/Users/Administrator/Documents/Qoder/2026-10-27/975cfd2c/Bluebird/server/agents/tasks.js#L797-L805)），不读取被引用对象 |
| **4. 才置为 completed** | **部分实现** | Workflow 层（有写入，无门禁） | 状态机允许 `running/accepted → completed`（[state-machine.js:33-52](file:///C:/Users/Administrator/Documents/Qoder/2026-10-27/975cfd2c/Bluebird/server/agents/state-machine.js#L33-L52)）；`runTask` 直接写 completed（[runtime.js:725-729](file:///C:/Users/Administrator/Documents/Qoder/2026-10-27/975cfd2c/Bluebird/server/agents/runtime.js#L725-L729)）。前置条件仅“有 summary、非终态、非 cancel、非 waiting”（[runtime.js:696-708](file:///C:/Users/Administrator/Documents/Qoder/2026-10-27/975cfd2c/Bluebird/server/agents/runtime.js#L696-L708)），与产物无关 |
| **5. 失败进 retry / recovery** | **部分实现（仅模型类错误）** | Workflow 层（无 recovery 状态；无产物失败分支） | 重试只对 `model_connection` / `model_rate_limit` / `model_timeout` 且 `attempts < maxAttempts`、无 `memory_remember` 生效（[runtime.js:818-847](file:///C:/Users/Administrator/Documents/Qoder/2026-10-27/975cfd2c/Bluebird/server/agents/runtime.js#L818-L847)；`tasks.setRetry()` 在 [tasks.js:1013-1034](file:///C:/Users/Administrator/Documents/Qoder/2026-10-27/975cfd2c/Bluebird/server/agents/tasks.js#L1013-L1034)）；其余落 `failed/cancelled/timed_out`（[runtime.js:849-885](file:///C:/Users/Administrator/Documents/Qoder/2026-10-27/975cfd2c/Bluebird/server/agents/runtime.js#L849-L885)）。状态集无 `retrying` / `recovery`（[state-machine.js:11-29](file:///C:/Users/Administrator/Documents/Qoder/2026-10-27/975cfd2c/Bluebird/server/agents/state-machine.js#L11-L29)）；`uncertain` 只用于“有副作用工具的任务在重启后结果未知”（[tasks.js:1036-1041](file:///C:/Users/Administrator/Documents/Qoder/2026-10-27/975cfd2c/Bluebird/server/agents/tasks.js#L1036-L1041)、[tasks.js:1072-1086](file:///C:/Users/Administrator/Documents/Qoder/2026-10-27/975cfd2c/Bluebird/server/agents/tasks.js#L1072-L1086)） |

> **【一手原文核对 2026-11-03 补注】** 上表按旧转引填写，存在**错位一格 + 丢失原文第 5 步**。按一手原文（v1.1 §11，5 条并列，逐字见「附二 §附2.1」）：
> - 第 **4** 行「才置为 completed 部分实现」对应当年旧转引的第 4 项，实际是原文**第 3 步的后半句**；按原文口径，第 3 步是「校验后才允许 completed」，当前**无校验 → 缺失**，写入动作本身不算实现门禁。
> - 第 **5** 行「失败进 retry / recovery 部分实现」实际对应原文**第 4 步**，该判定保留（仅模型类错误重试、无 recovery 状态、无产物失败分支）。
> - 原文**第 5 步**（Artifact 已写但 task 状态提交失败 → `pending-commit` / `orphan` → 幂等重试关联 → 确认无引用后才可清理）在本表**整行缺失**，判定为**完全缺失**：`pending-commit` 在 `server/` 零命中、`orphan` 在 Agent 域零命中（§4.2）。
>
> 结论：本表第 5 行应改为「**完全缺失**」，依据是原文第 5 步原句；上表文字保留不改，以本补注与附二为准。本审计其他判断不变。

补充：`v1.3 §42 A-03` 要求“提交意图/Outbox + 恢复扫描”，当前只有**事件 outbox**（写入与回退见 [tasks.js:280-310](file:///C:/Users/Administrator/Documents/Qoder/2026-10-27/975cfd2c/Bluebird/server/agents/tasks.js#L280-L310)）与**投递补投**（[result-delivery.js:206-224](file:///C:/Users/Administrator/Documents/Qoder/2026-10-27/975cfd2c/Bluebird/server/agents/result-delivery.js#L206-L224)），没有“产物提交意图 + 状态提交”的双写协议。`B-06` 提到的原子预算计量也不在完成链内：完成链结果 schema（[worker-result.js:57-98](file:///C:/Users/Administrator/Documents/Qoder/2026-10-27/975cfd2c/Bluebird/server/agents/worker-result.js#L57-L98)）无 token/费用/usage 字段，`tasks.js` 的 `updateTask` 也不写预算。【已验证】

---

## 4. 状态一致性风险

### 4.1 “产物写成功 / 状态提交失败”在当前代码下会发生什么

**前提：当前不存在产物写入**，因此“产物成功 + 状态失败”这一组合**今天不可能发生**（无写入者）。但一旦按 §5 补上产物写入，现有状态提交的失败语义会放大问题：

1. **`updateTask()` 先改内存、后落盘。**
   - 状态赋值：[tasks.js:700-703](file:///C:/Users/Administrator/Documents/Qoder/2026-10-27/975cfd2c/Bluebird/server/agents/tasks.js#L700-L703)；
   - `result` 重建：[tasks.js:784-852](file:///C:/Users/Administrator/Documents/Qoder/2026-10-27/975cfd2c/Bluebird/server/agents/tasks.js#L784-L852)；
   - 真正落盘在最后：[tasks.js:853-854](file:///C:/Users/Administrator/Documents/Qoder/2026-10-27/975cfd2c/Bluebird/server/agents/tasks.js#L853-L854) → [tasks.js:180-182](file:///C:/Users/Administrator/Documents/Qoder/2026-10-27/975cfd2c/Bluebird/server/agents/tasks.js#L180-L182)。
   - 因而 `saveTasks()` 抛错时，**进程内 `taskCache` 已经是 completed**，磁盘仍是旧状态（`atomic-write.js` 只保证单文件“旧或新”，不保证业务回滚）。【已验证：赋值顺序】+【代码推断：缓存未回滚】
2. **`runTask` 的 catch 会把这种失败吞掉。**
   - 落盘异常冒泡到 [runtime.js:751-755](file:///C:/Users/Administrator/Documents/Qoder/2026-10-27/975cfd2c/Bluebird/server/agents/runtime.js#L751-L755)，`latest = tasks.getRawTask()` 读到的正是内存里的 completed，于是 `isTerminalStatus(latest.status)` 为真 → **直接 return**，不写失败结果、不补发事件、不改投递状态。【已验证：控制流】
3. **后果（推断）**：
   - 进程继续运行：内存认为已完成，后续任一 `saveTasks()`（心跳失败、别的任务更新）都可能把这台内存状态**整体写回磁盘**，磁盘随之“变成 completed”；
   - 若在写回前重启：磁盘仍是 `running`，`initializeTaskQueue()` → `recoverInterrupted()`（[runtime.js:934](file:///C:/Users/Administrator/Documents/Qoder/2026-10-27/975cfd2c/Bluebird/server/agents/runtime.js#L934)、[tasks.js:1046-1106](file:///C:/Users/Administrator/Documents/Qoder/2026-10-27/975cfd2c/Bluebird/server/agents/tasks.js#L1046-L1106)）会把它重新 `queued` 并**再执行一次**（若任务允许 `memory_remember` 则转 `uncertain`，[tasks.js:1072-1086](file:///C:/Users/Administrator/Documents/Qoder/2026-10-27/975cfd2c/Bluebird/server/agents/tasks.js#L1072-L1086)）；
   - 若未来已有产物落库，则会出现“**产物在、任务被重跑**”的重复产物/重复副作用，因为没有任何“产物已提交”的标记可供恢复扫描识别。
   - 上述“重启后重跑”需实际注入磁盘故障才能确认端到端行为，标注 **【未验证，需运行】**；但代码路径本身已确认。

4. **反向失败（状态提交成功、产物写失败）**：当前不存在该顺序（先状态后产物），若将来仍按“先 `updateTask` 后写产物”实现，就会出现“completed 但引用了不存在的产物”，且因为任务已终态，`runTask` 无法自动回退（[runtime.js:696-703](file:///C:/Users/Administrator/Documents/Qoder/2026-10-27/975cfd2c/Bluebird/server/agents/runtime.js#L696-L703)）。这正是 §11 要求“产物先落库、再提交状态”的原因。【代码推断】

### 4.2 有没有 `pending-commit` / `orphan`？有没有恢复扫描？

| 概念 | 现状 | 证据 |
|---|---|---|
| `pending-commit`（产物待提交意图） | **不存在** | `server/` 目录检索 `pending-commit/pendingCommit/pending_commit` **零命中**；全仓仅文档中出现该词 |
| `orphan`（产物孤儿） | **Agent 域不存在**；仓库其他域有同名概念但无关 | Agent 域零命中；`orphan messages` 在 [sessions.js:134-149](file:///C:/Users/Administrator/Documents/Qoder/2026-10-27/975cfd2c/Bluebird/server/sessions.js#L134-L149)、`orphan_chunks` 在 [retrieval/store.js:698-719](file:///C:/Users/Administrator/Documents/Qoder/2026-10-27/975cfd2c/Bluebird/server/retrieval/store.js#L698-L719)，均与产物无关 |
| Artifact 恢复扫描 | **不存在** | 启动恢复 [runtime.js:926-969](file:///C:/Users/Administrator/Documents/Qoder/2026-10-27/975cfd2c/Bluebird/server/agents/runtime.js#L926-L969) 只做：`flushEventOutbox()`（`:928-931`）、`tasks.recoverInterrupted()`（`:934-944`）、`resultDelivery.recoverPending()`（`:955-960`）、`scheduleTaskQueue()`（`:961`） |
| 投递恢复扫描（存在，但只覆盖消息投递） | 有 | `recoverPending()` 遍历终态且未投递任务，重投父会话消息（[result-delivery.js:206-224](file:///C:/Users/Administrator/Documents/Qoder/2026-10-27/975cfd2c/Bluebird/server/agents/result-delivery.js#L206-L224)）；`snapshotForSession()` 建连时也会触发（`:229`） |
| Watchdog 状态扫描 | 有，但不涉及产物 | 只检查 `lease_expired` / `heartbeat_stale` / 队列积压 / 存储不可读 / 磁盘 / 服务存活 / 投递失败（[watchdog-policy.js:45-112](file:///C:/Users/Administrator/Documents/Qoder/2026-10-27/975cfd2c/Bluebird/server/agents/watchdog-policy.js#L45-L112)） |

### 4.3 结论

- **当前代码不可能出现“产物写成功但状态提交失败”**，因为**没有产物写入**；风险隐患留在“一旦加产物写入”的接口顺序上。
- **当前代码也没有任何机制能发现或修复“已提交状态 ↔ 产物缺失/孤儿”**：无 pending-commit、无 orphan TTL、无 artifact 扫描。§38 的 168 小时 TTL 完全未落地。【已验证】
- **真正现存的一致性缺口是 `updateTask()` 的“内存先行 + 异常被 catch 吞掉”**（§4.1），它与产物无关，但会直接影响未来提交协议的可靠性，建议在补协议时一并处理（例如提交函数内先快照、失败回滚内存，或改为“从磁盘重新加载”）。

---

## 5. 最小改动落点

> 目标：只补“产物先落库 → 再提交状态 → 引用可读校验”，不引入 Blackboard/Verification/冲突裁决等更大范围。
> 原则：**不要**在通用 `updateTask()` 里加“必须通过校验才能 completed”的硬门禁——现有测试大量直接调它写终态。

### 5.1 按依赖顺序

| 序 | 文件 | 函数 / 位置 | 改什么 | 对现有测试的影响 |
|---|---|---|---|---|
| 1 | **新增** `server/agents/artifact-store.js` | `writeArtifact()` / `assertReadable()` / `listPendingCommits()` | 产物落盘：`DATA_DIR/agents/artifacts/<artifactId>.json`（或按 task 分目录），含 `artifactId/taskId/producerAgentId/type/contentRef/version/createdAt/trustLevel`；`writeFileAtomicSync` 复用 [atomic-write.js:51](file:///C:/Users/Administrator/Documents/Qoder/2026-10-27/975cfd2c/Bluebird/server/atomic-write.js#L51)；版本按 `taskId` 单调递增 | 无测试引用该模块；新增文件不影响现有断言。相关 agent 测试均把 `BLUEBIRD_DATA_DIR` 指到临时目录（如 [agent-worker.test.js:17](file:///C:/Users/Administrator/Documents/Qoder/2026-10-27/975cfd2c/Bluebird/tests/agent-worker.test.js#L17)、[agent-recovery.test.js:18](file:///C:/Users/Administrator/Documents/Qoder/2026-10-27/975cfd2c/Bluebird/tests/agent-recovery.test.js#L18)），不会污染仓库数据 |
| 2 | `server/agents/worker-result.js` | `refs()`（[L21-30](file:///C:/Users/Administrator/Documents/Qoder/2026-10-27/975cfd2c/Bluebird/server/agents/worker-result.js#L21-L30)）、`normalizeWorkerResult()`（[L57-98](file:///C:/Users/Administrator/Documents/Qoder/2026-10-27/975cfd2c/Bluebird/server/agents/worker-result.js#L57-L98)） | 扩展 ref 形状为 `{kind,id,artifactId,version,contentRef}`（保留 `kind/id` 兼容），默认仍允许空数组 | 安全。[agent-worker.test.js:289-324](file:///C:/Users/Administrator/Documents/Qoder/2026-10-27/975cfd2c/Bluebird/tests/agent-worker.test.js#L289-L324) 只断言 status/summary/toolSteps/evidence 等既有字段，**未断言 artifacts**；全仓 tests 检索 `artifacts` 零命中 |
| 3 | `server/agents/runtime.js` | `execute()` 返回（[L383-397](file:///C:/Users/Administrator/Documents/Qoder/2026-10-27/975cfd2c/Bluebird/server/agents/runtime.js#L383-L397)）+ `runTask` 完成段（[L705-729](file:///C:/Users/Administrator/Documents/Qoder/2026-10-27/975cfd2c/Bluebird/server/agents/runtime.js#L705-L729)） | 从工具结果/`rawReply` 收集产物；**先** `artifactStore.writeArtifact()`，**再** `normalizeWorkerResult({ artifacts })`，最后 `updateTask(completed)`；写产物失败 → 走 `failed`/`uncertain` 而不是 `completed`；替换 [L713](file:///C:/Users/Administrator/Documents/Qoder/2026-10-27/975cfd2c/Bluebird/server/agents/runtime.js#L713) 的 `artifacts: []` | 有影响但可控：[memory-bot.test.js:651-684](file:///C:/Users/Administrator/Documents/Qoder/2026-10-27/975cfd2c/Bluebird/tests/memory-bot.test.js#L651-L684) 断言队列任务最终 `completed`；[agent-dispatch.test.js:725](file:///C:/Users/Administrator/Documents/Qoder/2026-10-27/975cfd2c/Bluebird/tests/agent-dispatch.test.js#L725) 直接调 `runTask`。若把“必须有产物”设为硬条件，这些用例都会失败；**最小实现应对空产物放行**，仅对非空 refs 做可读校验 |
| 4 | `server/agents/tasks.js` | **新增** `commitTaskCompletion(taskId, { result, expectedVersion })`，位于 [updateTask](file:///C:/Users/Administrator/Documents/Qoder/2026-10-27/975cfd2c/Bluebird/server/agents/tasks.js#L695) 之外；内部先 `artifactStore.assertReadable(result.artifacts)`，再 `assertTransition`，最后一次性写入 | 把“校验 + 提交”封装成唯一入口，避免污染通用 `updateTask` | 若坚持把校验塞进 `updateTask`，会打断：[agent-recovery.test.js:404-407](file:///C:/Users/Administrator/Documents/Qoder/2026-10-27/975cfd2c/Bluebird/tests/agent-recovery.test.js#L404-L407)、[:428-431](file:///C:/Users/Administrator/Documents/Qoder/2026-10-27/975cfd2c/Bluebird/tests/agent-recovery.test.js#L428-L431)、[agent-worker.test.js:446-469](file:///C:/Users/Administrator/Documents/Qoder/2026-10-27/975cfd2c/Bluebird/tests/agent-worker.test.js#L446-L469)。因此**新增独立入口**是最小影响方案 |
| 5 | `server/agents/task-store.js` | `write()`（[L110-113](file:///C:/Users/Administrator/Documents/Qoder/2026-10-27/975cfd2c/Bluebird/server/agents/task-store.js#L110-L113)） | 增加 `expectedVersion` / 存储层单调 `storeVersion`，写入前比较 | 无直接测试断言 `write()` 签名；[agent-recovery.test.js:444-461](file:///C:/Users/Administrator/Documents/Qoder/2026-10-27/975cfd2c/Bluebird/tests/agent-recovery.test.js#L444-L461) 直接替换 `taskStore.write` 模拟 EACCES，**改签名时需同步该桩函数** |
| 6 | `server/agents/approvals.js` | `execute()` 的完成写入（[L413-445](file:///C:/Users/Administrator/Documents/Qoder/2026-10-27/975cfd2c/Bluebird/server/agents/approvals.js#L413-L445)） | 改走 `commitTaskCompletion()`，显式传空产物或审批产物 | [memory-maintenance.test.js:190-197](file:///C:/Users/Administrator/Documents/Qoder/2026-10-27/975cfd2c/Bluebird/tests/memory-maintenance.test.js#L190-L197) 断言 `approvals.execute()` 后 `status === 'completed'`；只要空产物放行即通过 |
| 7 | `server/agents/runtime.js` | `initializeTaskQueue()`（[L926-969](file:///C:/Users/Administrator/Documents/Qoder/2026-10-27/975cfd2c/Bluebird/server/agents/runtime.js#L926-L969)） | 增加 `artifactStore.recoverPendingCommits()` 与 orphan TTL 扫描（§38：168h 默认） | [memory-bot.test.js:680-684](file:///C:/Users/Administrator/Documents/Qoder/2026-10-27/975cfd2c/Bluebird/tests/memory-bot.test.js#L680-L684) 断言 `recovered.recovered >= 1`；新扫描不得改变 `recoverInterrupted()` 的计数语义，否则失败 |
| 8 | **新增测试**（非必须但建议） | 双 Store 故障注入、引用不可读、空产物放行 | 对应 A-03 / §11 | 无 |

### 5.2 关于“哪些测试断言了 `artifacts: []` 或相关行为”

- **断言 `artifacts: []` 的测试：0 条。** 全仓 `tests/` 检索 `artifacts` 零命中（含 `.js` / `.ts` / `.tsx`）。
- **间接依赖“完成即可”的测试（会被强制门禁打断）：**
  - [agent-recovery.test.js:399-421](file:///C:/Users/Administrator/Documents/Qoder/2026-10-27/975cfd2c/Bluebird/tests/agent-recovery.test.js#L399-L421)（直接 `updateTask` → completed → 投递幂等）
  - [agent-recovery.test.js:423-440](file:///C:/Users/Administrator/Documents/Qoder/2026-10-27/975cfd2c/Bluebird/tests/agent-recovery.test.js#L423-L440)（终态补投）
  - [agent-worker.test.js:446-469](file:///C:/Users/Administrator/Documents/Qoder/2026-10-27/975cfd2c/Bluebird/tests/agent-worker.test.js#L446-L469)（结果落库 schema）
  - [memory-bot.test.js:651-684](file:///C:/Users/Administrator/Documents/Qoder/2026-10-27/975cfd2c/Bluebird/tests/memory-bot.test.js#L651-L684)（真实队列跑完 → completed；恢复后 completed）
  - [agent-dispatch.test.js:725](file:///C:/Users/Administrator/Documents/Qoder/2026-10-27/975cfd2c/Bluebird/tests/agent-dispatch.test.js#L725)（直接 `runTask`）
  - [memory-maintenance.test.js:196-197](file:///C:/Users/Administrator/Documents/Qoder/2026-10-27/975cfd2c/Bluebird/tests/memory-maintenance.test.js#L196-L197)（审批执行 → completed）
  - [agent-watchdog.test.js:57-58](file:///C:/Users/Administrator/Documents/Qoder/2026-10-27/975cfd2c/Bluebird/tests/agent-watchdog.test.js#L57-L58)、[agent-router.test.js:441-443](file:///C:/Users/Administrator/Documents/Qoder/2026-10-27/975cfd2c/Bluebird/tests/agent-router.test.js#L441-L443)（只推进到 accepted/running，不触及完成校验）
- **不经过 `updateTask`、因此不受提交门禁影响的种子数据**：[memory-bot.test.js:844-896](file:///C:/Users/Administrator/Documents/Qoder/2026-10-27/975cfd2c/Bluebird/tests/memory-bot.test.js#L844-L896) 直接 `fs.writeFileSync(TASKS_FILE, ...)` 写 `status:'completed'`，然后 `reloadForTests()`。
- **唯一会因签名变化而需改的测试桩**：[agent-recovery.test.js:444-461](file:///C:/Users/Administrator/Documents/Qoder/2026-10-27/975cfd2c/Bluebird/tests/agent-recovery.test.js#L444-L461)（直接替换 `taskStore.write`）。若只新增 `commitTaskCompletion` 而不改 `write()` 签名，可完全不碰该测试。

### 5.3 建议的最小形态（避免过度工程）

- **产物允许为空**：现阶段 Worker 没有产物生产器，若强制“必备产物”，所有成功任务都会失败。最小协议应为：
  1. 有产物 → 先写 artifact store（含版本），回填 `{kind,id,artifactId,version,contentRef}`；
  2. 无产物 → `artifacts: []` 合法；
  3. 提交前 `assertReadable()` 只针对非空 refs；
  4. 上述任一失败 → 不写 completed，走 `failed` / `uncertain`。
- **顺序固定**：`artifactStore.write → result 规范化 → tasks 提交（含状态与 result） → 事件 → 投递`，且**提交动作单独成函数**，方便日后在 `initializeTaskQueue()` 挂恢复扫描。

---

## 附：取证清单

| 断言 | 类型 | 位置 |
|---|---|---|
| 成功结果 `artifacts: []` 硬编码 | 已验证 | `server/agents/runtime.js:713` |
| `execute()` 返回无产物字段 | 已验证 | `server/agents/runtime.js:383-397` |
| `runAgentTurn()` 返回无产物字段 | 已验证 | `server/agent-runtime.js:1059-1070` |
| `normalizeWorkerResult()` 默认空产物、ref 只留 `{kind,id}` | 已验证 | `server/agents/worker-result.js:21-30, 57-98` |
| `updateTask()` 先改内存后落盘 | 已验证 | `server/agents/tasks.js:700-703, 784-854` |
| 落盘失败异常被 `runTask` catch 吞掉（因内存已终态） | 代码推断 | `server/agents/runtime.js:751-755` + `tasks.js:700-703` |
| 任务文件整文件覆盖、无 CAS | 已验证 | `server/agents/task-store.js:110-113`、`server/atomic-write.js:51-81` |
| 状态机无 `retrying`/`recovery` | 已验证 | `server/agents/state-machine.js:11-29` |
| 启动恢复只含事件 outbox / 任务恢复 / 投递补投 | 已验证 | `server/agents/runtime.js:926-969` |
| 无 pending-commit / Agent 域无 orphan | 已验证（全仓检索） | — |
| 第二条 completed 写入点为 `approvals.execute` | 已验证 | `server/agents/approvals.js:413-445` |
| 测试未断言 `artifacts` | 已验证（全仓 `tests/` 检索） | — |
| 生产数据文件现状（`server/data/agents`） | 未取证 | 本机该目录不存在，无法读取实际 `agent-tasks.json` |
| “重启后重跑产生重复产物”端到端行为 | 未验证（需注入磁盘故障运行） | — |
| §11 原文五步表述 | 未取证（仓库内无原文，仅审计转引）→ **已由下一行更新** | — |
| §11 原文五步表述（一手原文核对 2026-11-03） | **已核对** | Notion 页面 `40da9575-23c2-8135-9607-e23f6a3c784f` v1.1 §11，5 条逐字见「附二 §附2.1」 |

---

## 附二：一手原文补充（2026-11-03）

> 来源：**一手原文核对（2026-11-03，来源 Notion 页面 `40da9575-23c2-8135-9607-e23f6a3c784f`，v1.1 §11）**。本节逐字引用，不改写本审计 §0–§5 既有判断；与 §3 表冲突时，以本节为准并保留 §3 原文。

### 附2.1 §11 五步原文（逐字，5 条并列）

1. Worker 先将产物持久化到 Blackboard，取得 artifactRef 和版本。
2. 再向 Workflow Engine 提交结果引用。
3. Workflow Engine 校验引用可读、schema 合格、必需产物齐全后，才允许 task completed。
4. Artifact 写失败则 task 不得 completed，进入 retry / recovery。
5. Artifact 已写但 task 状态提交失败，产物标记 pending-commit / orphan，通过幂等重试关联；确认无引用后才可清理。

**错位更正**：旧转引把第 3 步末句「才允许 task completed」拆成独立项，导致第 3–5 项右移一格并丢失第 5 步。按原文口径的判定：

| 原文步骤 | 现行代码 | 判定 |
|---|---|---|
| 1. 产物持久化到 Blackboard，取得 artifactRef 和版本 | 无 artifact store，`artifacts: []` 硬编码 | **缺失** |
| 2. 提交结果引用（含版本） | ref 只有 `{kind,id}`，无版本 | **缺失** |
| 3. 校验可读 / schema / 必需产物后才允许 completed | 有 `completed` 写入，无任何提交前校验门禁 | **缺失** |
| 4. Artifact 写失败则不得 completed，进 retry / recovery | 仅 `model_connection` / `model_rate_limit` / `model_timeout` 进 retry；无 `recovery` 状态、无产物失败分支 | **部分实现** |
| 5. Artifact 已写但状态提交失败 → `pending-commit` / `orphan` → 幂等重试关联 → 确认无引用后清理 | `pending-commit` 在 `server/` 零命中、`orphan` 在 Agent 域零命中（§4.2） | **完全缺失** |

→ 因此 §3 表第 5 行「部分实现（仅模型类错误）」应按本条改为**完全缺失**；§3 表第 4 行「才置为 completed 部分实现」是旧错位的产物，按原文第 3 步口径应为**缺失**，其「部分实现」实际属于原文第 4 步。§3 表原文与 §4.2 证据均保留。

### 附2.2 原文硬约束（逐字）

> 跨 Store 不假设分布式原子事务；采用提交意图 / Outbox、幂等关联和恢复扫描。不得删除已提交产物来伪装状态回滚；错误产物应标记 superseded / invalidated 并保留审计。

对当前实现的含义（**推断**，不新增裁决）：仓库既无 Artifact Store，也无「产物提交意图 + 状态提交」双写，因此这条约束今天无落地对象；它在 Phase 1 补产物写入时生效，尤其禁止用删除产物来掩盖状态回滚。

### 附2.3 事实权威边界（逐字，三句）

- State Store 对 Task/Workflow 唯一权威；
- Blackboard 对 Artifact 唯一权威；
- Event Bus 仅通知。

### 附2.4 §10 逐节点迁移记录枚举（补漏）

仓库此前只写「逐节点迁移记录」，从未列出枚举值。一手原文的六个值为 **并列无序**（不是等级，也不是优先级）：

`reused / continued / replaced / cancelled / superseded / revalidated`

引用时必须注明「**原文并列无序**」，不得按书写顺序解读为强弱、先后或推荐级。

### 附2.5 需人工判断（工作量与范围）

> 以下只提出问题，**不自行改方案、不改 S1–S10 编号**。

1. 第 5 节最小落点表第 7 行已写 `recoverPendingCommits()` 与 orphan TTL 扫描（§38：168h），但**没有**写「状态提交失败时先给产物打 `pending-commit` 标记、再做幂等重试关联」这一**写入侧**动作。原文第 5 步是完整闭环（标记 → 关联 → 确认无引用 → 清理），当前落点只覆盖扫描/清理侧。
2. 因此需判断：是否在实施计划中补一条「提交失败标记 + 幂等关联」，以及是否据此调整工作量估算。**本审计不新增步骤编号，也不改 S1–S10**；由项目所有者决定。

### 附2.6 未改动声明

- 本节为**追加段**；§0–§5 与「附：取证清单」既有判断的文字未改写（仅在其后追加一行已核对状态）。
- 不改协议方案的 S1–S10 编号；工作量与范围问题见 §附2.5，未在正文自行调整。
- 未修改源码、测试、配置或数据；未 commit、未 push。
