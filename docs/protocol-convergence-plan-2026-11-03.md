# 协议收敛方案（Phase 1 前置 ①）

> 范围：只处理"单一事实源"与状态/版本契约收敛，不实现 CAS（②）、最小 Artifact（③）、审批 TTL（④），不开启动态组队。
> 规则：所有分歧点先按架构文档条款裁定；文档冲突按 `v1.3 > v1.2 > v1.1 > v1.0` 裁决；文档无覆盖的进入"未覆盖、按最小风险默认推进"，不等用户裁定。
> 基线：`docs/phase0-baseline-audit-2026-11-03.md`（已读）。
> 裁决依据：v1.0 §0–§22 / v1.1 §10–§22 / v1.2 §23–§30 来自 Notion 页面 `40da9575-23c2-8135-9607-e23f6a3c784f`；v1.3 §31–§42 来自仓库内已封版文件 `docs/v1.3-decisions-and-verification-checklist-2026-11-03.md`（封版 2026-11-03，本次已实际逐节读取）。按该文件 §31.1："同一章内按小节编号靠后者优先（例如 §32 与 §24.2 冲突时以 §32 为准）"。
> 本文只新建本文件，不改源码、测试、配置、数据，不 commit、不 push。

## 一句话结论

**能小步完成，但不是全程零行为变化**：权威声明归位、Session 生命周期投影化、plan/planVersion 归属、版本字段治理都可以在不改现有行为的前提下分步提交。必须改变可见行为的只有两处，且都能独立成步、独立回滚：① v1.2 §24.1/§30 要求的 `uncertain → recovery` 与 `retrying` 正式化；② 迁移表对齐（含 v1.3 §32.2 对 §24.2 `waiting_approval` 行的修订）带来的审批入口/出口重排——`waiting_approval` 不能直接从 `queued` 进入，批准后必须先回 `running` 再执行，且资源期限耗尽可从 `waiting_approval` 直接进入 `timed_out` 或 `recovery`。前者改状态词，后者改审批时序，均需同步前端、测试与文档计数。

---

## 1. 现状取证

标记说明：**【已验证】**=本次实际读码确认；**【未取证】**=仓库内没有可读证据，不做推断。

### 1.1 三处"唯一事实来源"各自声明了什么、谁在写、谁在读

| # | 声明位置 | 原文（摘要） | 实际写者 | 实际读者 | 判定 |
| --- | --- | --- | --- | --- | --- |
| 1 | `server/agents/tasks.js:5-7` | "事件只允许安全标量字段……**事件是 UI 状态的唯一事实来源**；客户端不得自行编造进度。" | 事件：`appendEvent`（`tasks.js:255-279`），落 `agent-events.json` 与 `agent-event-outbox.json`（`tasks.js:24-25`）。任务状态：`updateTask`（`tasks.js:695-703`）与两处直接赋值（`tasks.js:1073`、`1088`）。 | 事件：仅 `GET /agents/:botId/events`（`server/agents/routes.js:336-341`）。UI 任务页实际读 `GET /agent-tasks`（`components/TasksPanel.tsx:48-54` → `routes.js:482`、`498`）。 | **不成立**。事件只是通知/审计，不是 UI 状态事实源；这与 §11"Event Bus 仅负责通知，不拥有事实权威"一致，`tasks.js:5-7` 的表述需要改正。 |
| 2 | `server/agents/state-machine.js:5` | "**合法迁移是唯一事实来源**：任务状态只能沿这里声明的边变化。" | 经 `assertTransition` 的写入只有 2 处：`updateTask`（`tasks.js:700-703`）与 `setRetry`（`tasks.js:1017-1019`）。绕过校验的直接赋值 2 处：`recoverInterrupted`（`tasks.js:1073`、`1088`）。 | `isTerminalStatus` 15 个调用点（`approvals.js` 3、`result-delivery.js` 1、`router.js` 1、`tasks.js` 1、`runtime.js` 9）。 | **半成立**。它是"迁移合法性定义"，不是"事实源"；事实源在持久化记录。且存在 2 处合法边之外的直接写入路径（虽然当前取值仍在合法边内）。 |
| 3 | `server/agents/task-store.js:5-11` | "业务层只依赖这里声明的读写接口，不直接碰文件名或 JSON 结构……单机原子文件……只有一个写者。" | 任务文件唯一写入：`taskStore.write`（`task-store.js:110-113`），业务层经 `saveTasks`（`tasks.js:180-182`）。但 `loadTasks` 把可变 `store` 直接交给业务层（`tasks.js:151-163`），业务层直接改对象字段。事件/outbox 由 `tasks.js:183-186` 自己写；Session、Approval 各自有独立 store（`sessions.js:19-20`、`approvals.js:27-28`）。 | `taskStore.read` 1 处（`tasks.js:153`）；`migrate` 间接；其余模块不直接读文件。 | **只对 `agent-tasks.json` 成立**，不是全局单一事实源；"只依赖接口"目前是约定，不是封装（返回的是可变引用）。 |

补充【已验证】：`tasks.js:26` 自己承认"任务存储用 Store 的 schema 版本；事件/outbox 仍使用自己的 v1 结构"，即三套存储各有版本，不存在全局统一版本。

### 1.2 Session 与 Task 重复的 5 个状态

定义位置：
- Task：`state-machine.js:11-21`（9 态）；终态 `23-29`；迁移表 `31-58`。
- Session：`sessions.js:26-34`（7 态：`active/running/completed/failed/cancelled/timed_out/closed`）。

| 重复状态 | Task 定义 | Session 定义 | Task 实际写者 | Session 实际写者 | 语义是否一致 |
| --- | --- | --- | --- | --- | --- |
| `running` | `state-machine.js:14` | `sessions.js:28` | `runtime.js:609`（`updateTask`） | `sessions.js:275-294`（`markRunning`），由 `runtime.js:604` 调用 | **不一致**。`runtime.js:604` 先 `markRunning`，`609` 才写 Task `running`，存在 Session 已 running、Task 仍 `accepted` 的窗口。 |
| `completed` | `:16` | `:29` | `runtime.js:726`；`approvals.js:437-441` | `runtime.js:899-909`（复制 Task 终态）；`approvals.js:446-449`（字面量） | 取值一致；但写入者是"复制"而非派生 API，两处各自拼装。 |
| `failed` | `:17` | `:30` | `runtime.js:777`；`approvals.js:458-462`、`517` | `runtime.js:899-909`；`approvals.js:469-471` | 取值一致，来源同为任务失败；`approvals.js:517` 的 interrupted 恢复会把任务置 `failed`，并经 `deliverTaskResult` 间接关闭 Session。 |
| `cancelled` | `:18` | `:31` | `runtime.js:994`；`approvals.js:302-307` | `runtime.js:899-909`；`approvals.js:319-322` | 取值一致；审批驳回的取消同时改 Task 与 Session。 |
| `timed_out` | `:19` | `:32` | `runtime.js:849-859`（`status` 变量） | `runtime.js:899-909`（复制） | 取值一致；`approvals.js` 从不写该值。 |

【已验证】不重复项：Session 独有 `active`、`closed`；Task 独有 `queued`、`accepted`、`uncertain`。因此"5 个重复"是词表重叠，不是两套独立状态机：Session 的终态是从 Task 复制出来的**投影**。

#### 1.2.1 迁移表与 §24.2 的逐行差异（关键缺口）

`state-machine.js:31-58` 与 v1.2 §24.2 合法迁移表并非同一张表；其中 `waiting_approval` 行以 **v1.3 §32.2 修订后**的目标集合为准（`running`、`cancelled`、`failed`、`timed_out`、`recovery`）。

| 当前状态 | §24.2 允许（`waiting_approval` 行经 v1.3 §32.2 修订） | 当前实现（`state-machine.js`） | 差异 | 现有调用点 |
| --- | --- | --- | --- | --- |
| `queued` | accepted、cancelled、timed_out | accepted、cancelled、waiting_approval | 多 `waiting_approval`，少 `timed_out` | `approvals.js:249`（对任意非终态任务请求审批，可能是 queued） |
| `accepted` | running、cancelled、timed_out | running、queued、waiting_approval、completed、cancelled、failed、timed_out、uncertain | 多 5 条宽松边 | 【未取证】到具体调用点；当前无写入者使用这 5 条 |
| `running` | waiting_approval、retrying、recovery、completed、failed、cancelled、timed_out | waiting_approval、queued、completed、failed、cancelled、timed_out、uncertain | 多 `queued`、`uncertain`；少 `retrying`、`recovery` | `runtime.js:833`（失败重试走 `setRetry` → `queued`） |
| `waiting_approval` | running、cancelled、failed、timed_out、recovery（v1.3 §32.2） | completed、failed、cancelled、uncertain | 少 `running`、`timed_out`、`recovery`；多 `completed`、`uncertain` | `approvals.js:437-441`（批准后直接 completed） |
| `retrying` / `recovery` | 新增正式状态 | 不存在 | 缺两态及其边 | `tasks.js:1073`（uncertain）、`1013-1019`（queued+retryAt） |

结论【已验证】：仅改词表名不够；迁移表对齐必然触碰审批入口（queued 不得直接进 waiting_approval）和审批出口（approval → running → 执行 → completed/failed），这是本方案里除状态改名外唯一的结构性行为变化。另【已验证】v1.3 §32.2 的 `timed_out` 仅表示"因资源期限终止"，"与审批期限无关；不改变 Approval Request 的 `pending` 状态，也不产生批准效果"（`docs/v1.3-decisions-and-verification-checklist-2026-11-03.md:68`）。

### 1.3 `plan` 缺 `planVersion`、与 task 无关联的具体位置

【已验证】当前存在两个不同概念，均未被命名区分：

1. **Context Orchestrator 的 plan**（请求级上下文策略，不是 Workflow 计划）
   - 生成：`server/context/orchestrator.js:71-189`（`planForIntent`），`191-206`（`planContext`）；返回 `intent/layers/budgets/noAnswerThreshold/reasons/enabled`，**没有 id、没有 version**。
   - 消费：`server/context/engine.js:117-127`（`planContext` 与 `applyPlanToConfig`）。
   - 落痕：`server/context/trace.js:126-133` 定义 `orchestration` 快照，`152-189` 复制 plan 字段；**无 planVersion、无 planId**。
   - 与任务的关系：`server/context/trace.js:79-84` 的 `createTrace` 只有 `taskLength`（文本长度）、`sessionId`、`requestId`，**没有 taskId**；`server/index.js:2750-2774` 调用 `runContextRuntime` 也只传 `task: memoryQuery`（文本），不传任务 ID。**【已验证】Context plan 无法关联到任何 Task。**
2. **Task Contract 缺字段**
   - 创建/返回：`tasks.js:603-650`（createTask 字段）、`tasks.js:350-403`（publicTask），**无 `planVersion`**。
   - 前端类型：`lib/api/types.ts:989-1031`，**无 `planVersion`**。
   - 路由决策：`router.js:205` 有 `contractVersion`，**无 `planVersion`**。
3. 架构要求：§3 规定 Task Contract 必须包含 `planVersion`；§10 规定每次重规划生成**不可变的新 Plan Version**，记录 `supersedesPlanVersion`、原因、变更摘要和迁移策略，旧计划不覆盖、不删除（`v1.1 §10` 第一段与 Plan-level 规则）。

【未取证】`orchestration` 快照是否被 monitoring 持久化到磁盘、是否有外部消费者；仓库内只看到 `trace` 内存对象与 `server/index.js:2777` 的 `monitoring.recordContextBuild`，未读到落盘实现。

### 1.4 多套版本字段各自管辖范围

| 字段 | 定义/写入位置 | 谁写 | 管辖范围 | 是否 CAS 版本 |
| --- | --- | --- | --- | --- |
| `checkpointVersion` | 定义 `tasks.js:381-383`、初值 `626`；可被 patch `769-771`；唯一递增 `1005-1006` | `recordCheckpoint` 递增；`updateTask` 理论上可覆写（仓库内**未取证到调用方**传该 patch） | 单个 Task 的 checkpoint 写入次数 | **否**。没有 `expectedVersion` 校验；测试也按"计数 1、2"断言（`tests/agent-recovery.test.js:220-226`）。 |
| `decisionVersion` | `memory.js:609-610`、`697-698`、`1523-1524`、`1558-1559`；常量 `memory-evidence.js:9-10`；另有硬编码 `memory.js:4998-4999` | 记忆决策/候选链路写入；读取在 `memory.js:209` | 记忆策略/裁决规则版本标签（值形如 `p1.0`、`p5.0`） | **否**。不是计数器；同一文件存在 `p1.0` 常量与 `p5.0` 字面量两套来源。 |
| 文件 `version`（任务 store） | `task-store.js:24-26`（`SCHEMA_VERSION=2`，支持 `[1,2]`） | `migrate`（`72-94`）、`write`（`110-113`） | `agent-tasks.json` 的结构 schema | **否**。schema 版本，不是实体乐观锁版本。 |
| 文件 `version`（会话 store） | `sessions.js:20`（`STORE_VERSION=1`） | `emptyStore`（`50-52`）、`save` | `agent-sessions.json` 的 schema | **否** |
| 文件 `version`（审批 store） | `approvals.js:28`（`SCHEMA_VERSION=1`） | `load/save` | `agent-approvals.json` 的 schema | **否** |
| `contractVersion` | `tasks.js:41` 与 `router.js:18` **各自定义常量 1**；写入 `tasks.js:605`、`router.js:205`；返回 `tasks.js:357` | createTask / router decision | Task Contract v1 的结构版本 | **否**。是契约版本，不是 per-task 状态版本。 |
| `planVersion` | **不存在** | — | — | — |

【已验证】全仓 `expectedVersion`/`expectedStateVersion` 在源码中检索结果为 0 处；`updateTask` 的写入是无条件覆盖（`tasks.js:695-703`）。因此 §11"更新必须携带 expectedVersion"、§24.3"当前持久化状态与 expectedStateVersion 匹配"目前均未落地，属 Phase 1 ②。

---

## 2. 收敛方案

### 2.1 单一事实源的目标归属

| 对象 | 目标唯一归属 | 依据 | 当前差距（已验证） |
| --- | --- | --- | --- |
| **Task 状态** | `task-store.js` 的持久化记录是唯一事实源；`state-machine.js` 只负责"合法边 + 前置条件"校验；所有写入经 `tasks.transitionTask`（Engine 门面），`updateTask` 不再接受 `status`。 | §11：`State Store 是 Task / Workflow 状态的唯一事实来源`；§24.3：`只有 Workflow Engine 可写 Task 状态`；§30：`状态迁移表、前置条件、expectedStateVersion 和非法迁移审计可测试`；v1.3 §32.2 修订后的 §24.2 迁移表。 | 12 处经 `updateTask` 写 status（`runtime.js` 7、`approvals.js` 5），2 处直接赋值（`tasks.js:1073/1088`）；`approvals.js` 作为"审批人"直接写 Task 状态，违反 §24.3；迁移表与 §24.2（经 §32.2 修订）有 5 行差异（见 1.2.1）。 |
| **Workflow / plan** | 新增 Workflow Store（当前不存在，`server/agents` 无 workflow 模块）；Plan 版本记录归它；Task 只存 `planVersion` + `planId` 指针。 | §10：重规划生成不可变 Plan Version，记录 `supersedesPlanVersion`，旧计划不覆盖不删除；§11：Workflow 状态归 State Store。 | 无 Workflow Store；Context plan 未关联 taskId；Task Contract 无 `planVersion`。 |
| **Artifact** | 新增 Blackboard / Artifact Store（当前不存在）；Task/Result 只存 `artifactRefs`。 | §11：`Blackboard 是 Artifact 内容、版本、来源和验证状态的唯一事实来源`；§11 完成提交协议 1-5。 | `result.artifacts` 只保留 `{kind,id}`（`tasks.js:797-805`），无内容、无版本、无 trustLevel。 |
| **Approval Request** | `approvals.js` 的 store 是 Approval 的唯一事实源；状态词表按 §29 六态；执行结果不再塞进审批状态。 | §29：`Approval Request 自身使用 pending、approved、rejected、expired、escalated、cancelled`；§24.3 审批人只提交 decision。 | 当前是 `pending → approved/rejected → executing → completed/failed`（`approvals.js:4`），缺 `expired/escalated`，且把执行结果混入审批记录。落地归 Phase 1 ④。 |
| **Session** | `sessions.js` 的 store 是 Session 元数据的事实源；`lifecycle` 是所属 Task 状态的**投影**，不是第二套状态机。 | §11 的权威边界只覆盖 Task/Workflow 与 Artifact，**未覆盖 Session 状态词表**（见 3.8）。 | 5 个词重复；终态复制、`running` 可能先于 Task；`closeSession` 接受任意 `LIFECYCLE_STATES`（`sessions.js:296-301`）。 |
| **Event** | `appendEvent` 是通知/审计通道，不拥有状态权威。 | §11：`Event Bus 仅负责通知，不拥有事实权威`；v1.0 §4"关键状态持久化后发事件"。 | `tasks.js:7` 反向声明。 |

### 2.2 重复字段/重复状态处置

| 字段/状态 | 处置 | 新写入者 | 调用点数量（已统计） | 涉及测试文件（用例数） |
| --- | --- | --- | --- | --- |
| `Task.status` | 保留字段；`updateTask` 删除 status 分支，新增 `transitionTask` 统一写入 | `tasks.transitionTask`（Engine 门面）：`runtime.js`、`approvals.js` 改为提交决策/结果 | 17 个 `updateTask` 调用点，其中 12 个传 status；2 个直接赋值 | `agent-recovery`(26)、`agent-worker`(26)、`agent-watchdog`(26)、`agent-router`(49)、`api`(36)、`agent-dispatch`(13)、`memory-bot`(9) |
| `Task` 迁移表 | **按 v1.3 §32.2 修订后的 §24.2 重写**：10 态的边逐条对齐；删除 10 条宽松边，补 `queued→timed_out`、`waiting_approval→running/timed_out/recovery`、`retrying/recovery` 边 | `state-machine.js` 作为唯一迁移定义，被 `transitionTask` 调用 | 1 个迁移表；受影响写入路径 3 条（审批入口、审批出口、失败重试） | `agent-recovery`(26)、`memory-maintenance`(5)、`memory-lifecycle-decisions`(19)、`memory-bot`(9)、`agent-worker`(26) |
| `Session.lifecycle.status` 的 5 个重复词 | **保留值，降级为投影**；新增 `deriveLifecycleStatus(taskStatus)`，`running` 改为由 Task `running` 投影后再写会话 | `sessions.closeSession` 与 `runtime.js:899-909` 共用投影函数；`approvals.js` 不再手拼终态 | `closeSession` 5 处（`approvals` 3、`runtime` 2）；`markRunning` 1 处（`runtime.js:604`） | `agent-worker`(26，含 12 处 lifecycle)；`sessions`(61)；`memory-bot`(9) |
| `uncertain` | **删除**，改为 `recovery`；读边界提供一次性别名（旧数据/旧客户端仍可读） | `tasks.recoverInterrupted`（`tasks.js:1073/1079`） | 21 处测试字符串（`agent-recovery` 18、`agent-watchdog` 3）；`worker-result.js:12-18`；`tasks.js:1117/1124` | `agent-recovery`(26)、`agent-watchdog`(26)；前端 2 文件 |
| `queued + retryAt`（隐式重试态） | 正式化为 `retrying`；退避到期由 Engine 从 `retrying` 直接启动 attempt | `tasks.setRetry`（`tasks.js:1013-1034`） | 队列读取 7 处：`tasks.js:1104/1126/1158/1172`、`runtime.js:67`、`watchdog-policy.js:52`、`router.js:350` | `agent-recovery`(26)、`agent-watchdog`(26)、`agent-router`(49)、`agent-runtime-guards`(4) |
| `planVersion` | **新增**：Workflow Store 持计划版本记录；Task 存可空指针（未接入 Workflow 前为 `null`，不伪造版本） | `transitionTask`/Workflow Engine 在计划创建与重规划时写 | 新增字段，无既有调用点；契约读取点 `tasks.js:350-403`、`lib/api/types.ts:989-1031` | `agent-router`(49)、`api`(36)、`agent-worker`(26) |
| `Context plan`（`orchestrator.js`） | **改名定性**：文档与注释称 `contextPolicy` / 上下文策略快照，不授予 `planVersion` | 仍由 `context/orchestrator.js` 生成 | 1 处生成、1 处消费（`engine.js:120`）、1 处落痕（`trace.js:152-189`） | `context-orchestrator-p3`(11)、`context-engine-e2e`(38)、`context-trace-verify`(9) |
| `checkpointVersion` | **保留字段、收敛语义**：明确为 checkpoint 序号；删除 `updateTask` 对它的 patch 入口（`tasks.js:769-771`）；CAS 用独立 `stateVersion`（② 落地） | 仅 `recordCheckpoint`（`tasks.js:1005-1006`） | 1 个写入点；0 个外部 patch 调用（仓库内） | `agent-recovery`(26，3 处断言)、`agent-worker`(26，1 处) |
| `decisionVersion` | **保留字段、单一常量来源**；`p5.0` 改为具名常量，保持现有输出值不变 | 记忆决策链（`memory.js:609-610/697-698/1523-1524/1558-1559/4998-4999`） | 7 处写入/读取 | `memory-evidence-policy`(14)、`memory-lifecycle-decisions`(19)、`memory-observability`(10)、`profile-p5`(44)、`memory-lifecycle-golden`(24) |
| `contractVersion` | **单一常量**（新建 `server/agents/contract.js`），删除 `tasks.js:41` 与 `router.js:18` 的重复定义 | `createTask`、`router decision` 从同一常量读 | 2 个定义、3 处断言 | `agent-router`(49，3 处断言)、`agent-worker`(26) |
| 文件 `version`（三个 store） | 保留，各 store 独立；只允许各自 `migrate/write` 写 | 各 store 自身 | 3 个 store | `agent-recovery`(26)、`sessions`(61)、`memory-maintenance`(5) |
| `Approval.status` | 目标改为 §29 六态；执行结果移出审批记录。**本阶段只记录归属，不改代码**（归 ④） | `approvals.decide/execute` | 当前 6 个执行/状态值（`approvals.js:4`） | `memory-maintenance`(5)、`memory-lifecycle-decisions`(19)、`memory-bot`(9) |

### 2.3 目标读写路径（收敛后）

```
Runtime / Approval ──(提交结果或 decision 事件)──> tasks.transitionTask
                                                        │
                                        ┌───────────────┴───────────────┐
                                        ▼                               ▼
                               state-machine.assertTransition    task-store.write
                               （合法边 + 前置条件）              （唯一持久化）
                                        │
                                        └──> appendEvent（仅通知/审计）

Workflow Engine ──> Workflow Store（planVersion 不可变历史）
                └─> Task.planVersion 指针

Worker ──> Artifact Store（内容+版本+trustLevel）──> Result.artifactRefs ──> Engine 校验后 completed
Session.lifecycle = f(Task.status)，不单独决策
```

---

## 3. 裁决记录（依文档条款，不提交用户裁定）

### 3.1 状态集以哪一套为准（Task）

- **文档依据**：v1.2 §24.1："Task 状态固定为：queued、accepted、running、waiting_approval、retrying、recovery、completed、failed、cancelled、timed_out"；§24.1 还明确 `retrying`=可重试失败已被 Engine 接受、等待下一次 attempt，`recovery`=提交记录/Task 状态/Artifact 持久化不一致或副作用结果不确定；§30 验收项："retrying / recovery 是正式状态，且仅 Engine 可写"。v1.3 §31.1 补充硬不变量："终态不可被普通事件覆盖（§24.2）"（`docs/v1.3-decisions-and-verification-checklist-2026-11-03.md:23`），与既有 `state-machine.js:23-29` 的 `TERMINAL` 语义一致，不构成冲突。
- **曾考虑的两种做法**：
  - A. 保留现有 9 态（含 `uncertain`），把 `retrying/recovery` 做成派生视图。代价：§24.1 的"固定"状态集未满足，§30 验收项（v1.3 §42.2 B-03）无法通过；派生值无法承载 `recovery` 的"核对/修复流程"持久状态。
  - B. 采用 §24.1 十态，`uncertain → recovery`，`queued+retryAt → retrying`。代价：对外可见状态词变化，需同步前端与 21 处测试引用。
- **裁定：B**。理由：v1.2 高于 v1.0；v1.0 §3 只说"至少区分 8 态，还需定义 retrying/recovery 等中间语义"，v1.2 已把"中间语义"固化成正式状态；"正式状态"只能持久化，不能派生。审计报告 §6 第 2 条"不新增持久化状态"的建议与 v1.2 §24.1/§30 直接冲突，**以 v1.2 为准，驳回该建议**。
- **影响面**：`state-machine.js:11-58`、`worker-result.js:12-18`、`tasks.js:1073/1117/1124`、`runtime.js:951`、`sessions.js:26-34`（投影映射）、`lib/api/types.ts:1003-1011`、`components/TasksPanel.tsx:16-25`、`scripts/sync-doc-counts.js` 的 `agent-recovery` 描述、`AGENTS.md` 生成块；迁移表逐边对齐另见 S6。

### 3.2 `waiting_approval → timed_out`：§24.2 与 §29 的冲突

- **冲突原文**：
  - v1.2 §24.2 迁移表：`waiting_approval → running、cancelled、failed、timed_out`，条件"Engine 收到有效批准 / 拒绝 / 取消 / 超时策略结果"。
  - v1.2 §29 R3："不设自动批准超时……未批准期间保持 waiting_approval，允许人工取消 / 驳回，**不允许超时放行**"；R2 超时"Task 保持 waiting_approval / escalated，不得自动执行"。
- **v1.3 裁决依据（已在仓库内实际读取，封版 2026-11-03）**：
  - §31.1：`v1.3 > v1.2 > v1.1 > v1.0`；"同一章内按小节编号靠后者优先（例如 §32 与 §24.2 冲突时以 §32 为准）"（`docs/v1.3-decisions-and-verification-checklist-2026-11-03.md:10,22`）。
  - §32.1："**审批期限**：R3 不设自动批准超时，Approval Request 可长期 `pending`；任何人不得以'等待过久'为由自动批准或超时放行"；"**资源期限**：Task `deadline`、Task Token 预算、Run 总预算在 `waiting_approval` 期间照常有效；等待墙钟时间计入 Run 时间预算"；"**任一硬约束耗尽**：立即停止执行。无未核清副作用 → `timed_out`；副作用结果未知或未核清 → 先 `recovery`（沿用 §24.1）"（同上 `:49-51`）。
  - §32.2 直接修订 §24.2 的 `waiting_approval` 行：允许 `running`、`cancelled`、`failed`、`timed_out`、`recovery`；并注明 `timed_out` "表示因资源期限终止，与审批期限无关；不改变 Approval Request 的 `pending` 状态，也不产生批准效果"（同上 `:66-68`）。
  - §31.1 不变量："审批超时不能被解释为批准（§29、§30）"（同上 `:23`）。
- **裁定：按 v1.3 §32.2 补齐 `waiting_approval → running`、`waiting_approval → timed_out`、`waiting_approval → recovery` 三条边，且 `timed_out`/`recovery` 的触发条件只允许"Task deadline / Token 预算 / Run 预算耗尽"，禁止"审批 SLA 到期"触发。** 理由（按优先级）：
  1. v1.3 高于 v1.2，且 §32 与 §24.2 同属冲突时 §32 优先（§31.1 明文）；
  2. §32.1 把"审批期限"与"资源期限"拆成两套独立约束，既保留了 §29 R3"不设自动批准超时"，又允许资源耗尽终止任务；
  3. §32.2 的 `timed_out` 语义被显式限定为"因资源期限终止"，因此 §29 的"不允许超时放行"不被违反——任务终止 ≠ 审批被批准；
  4. 副作用未知时不得直接 `timed_out`（会掩盖未核清副作用），必须先 `recovery`，这是 §32.1 第 3 条的明文要求。
- **现状**：这三条边当前**均不存在**（`state-machine.js:52` 只有 `completed/failed/cancelled/uncertain`）；因此 3.2 的裁定同时要求补齐 `waiting_approval → running`，否则"批准后执行"无法从 `waiting_approval` 合法进入 `running`。
- **落地含义（本阶段不改代码）**：`state-machine.js` 按 v1.3 §32.2 重写 `waiting_approval` 行；Phase 1 ④ 增加 `escalationAt/expiresAt` 时，审批 SLA 超时只写 Approval `escalated/expired` 或 `overdue` 标记，**不改 Task 状态**；只有 Task deadline/预算耗尽才走 `timed_out`（无未核清副作用）或 `recovery`（副作用未知）。§32.3 另明确："`overdue` 是 Approval Request 上的标记，不是 Task 状态，不进入 §24.1 状态集合"（同上 `:76`），因此不新增第 11 个 Task 状态。

### 3.3 Session 的 5 个重复状态怎么并

- **文档依据**：§11 的"事实权威边界"只声明 State Store 对 Task/Workflow、Blackboard 对 Artifact；**没有给 Session 状态词表任何条款**。§2.3 只要求"每个 Agent 仍拥有私有 Session"；§5 Phase 1 验收只要求"Worker Session 隔离"。→ 状态词表本身属"未覆盖"（见 3.8）。
- **可依条款裁定的部分**：Session 不得成为 Task 状态的第二事实源。依据 §11"State Store 是 Task 状态的唯一事实来源"+§24.3"审批人/Worker 只能提交事件"。
- **曾考虑的两种做法**：
  - A. 立即把 Session 词表收缩为 `active/running/closed`，终态只写 `closed`，原因放 `closeReason`。代价：`GET /agents/:botId/sessions` 返回值变化；`agent-worker.test.js` 4 处终态断言（`406/503/528/540`）与 `sessions.js:296-301` 需改；无 UI 消费者，收益仅为词表纯净。
  - B. 保留 7 值作为**投影枚举**，终态值由 Task 派生，写入路径统一。代价：词表仍有 5 个重复词。
- **裁定：B（当前阶段）**，A 作为 Phase 2 清理项。理由：§11 只约束权威归属，不约束 Session 词表；在没有文档条款要求的情况下，选择不改 API 行为的最小风险方案。B 已消除"第二事实源"，重复词降级为投影别名。

### 3.4 `planVersion` 落盘还是从 plan 派生

- **文档依据**：§3 Task Contract 字段含 `planVersion`；§10"每次重规划生成不可变的新 Plan Version，记录 supersedesPlanVersion、原因、变更摘要和迁移策略。旧计划不覆盖、不删除"；§10 Plan-level 规则要求 `supersedesPlanVersion`、`migrationPolicyVersion`、逐节点迁移记录；§11"State Store 是 Task / Workflow 状态的唯一事实来源"。
- **曾考虑的两种做法**：
  - A. 从 plan 内容哈希/结构派生 `planVersion`，不落盘。代价：无法满足 §10 的不可变历史、`supersedesPlanVersion` 链和 fencing token（§10"迁移期间使用 generation / fencing token"）；哈希相同也可能语义不同（审批有效期、来源污点）。
  - B. 落盘：Workflow Store 持不可变 Plan Version 记录，Task 持 `planVersion` + `planId` 指针。代价：需要新 Store，Phase 1 Workflow 落地前 Task 的 `planVersion` 只能为空。
- **裁定：B**。理由：派生值不能承载"旧计划不覆盖、不删除"和 supersedes 链；§10 的迁移审计要求可序列化记录。**并明确区分概念**：`context/orchestrator.js:71-189` 的 plan 是请求级上下文策略，不是 Workflow 计划，**不得**叫 `planVersion`，应称 `contextPolicy`（§3 的 Task Contract 字段只指 Workflow 计划）。
- **过渡值**：Workflow Store 落地前，`planVersion` 字段存在但为 `null`（可空），不写 `'v1'` 之类假版本；避免制造无法追溯的"版本"。

### 3.5 `checkpointVersion` 是否改名为 CAS 版本

- **文档依据**：§11"更新必须携带 expectedVersion；仅当前版本匹配才提交，存储层分配单调递增版本"；§24.3 第 1 条"当前持久化状态与 expectedStateVersion 匹配"；§30"expectedStateVersion……可测试"。
- **曾考虑的两种做法**：
  - A. 把 `checkpointVersion` 直接当 `stateVersion` 用于 CAS。代价：语义错误（checkpoint 可多次写、状态可不变），现有测试按 1/2 计数（`agent-recovery.test.js:220-226`）会被误读；心跳/进度写入会制造假冲突。
  - B. 保留 `checkpointVersion` 为进度序号，新增独立 `stateVersion` 做 CAS。代价：多一个字段、多一次迁移（②）。
- **裁定：B**。理由：§11 的版本是"实体状态版本"，不是"checkpoint 次数"；§11 还允许 LWW 仅用于心跳这类可丢弃临时状态，说明 CAS 版本必须与心跳/进度分离。`checkpointVersion` 的 patch 入口（`tasks.js:769-771`）应删除，写入只留 `recordCheckpoint`。

### 3.6 `decisionVersion` 到底管什么

- **文档依据**：§28 ConflictRecord 字段 `policyVersion`="使用的冲突裁决规则版本"；§23 前言"后续调整必须走版本化配置、评测和审批"；§12 要求裁决保留依据、主体、时间。
- **裁定**：`decisionVersion` 是**记忆决策规则版本标签**，不是实体版本计数器，也不是 CAS 版本。必须单一常量来源：以 `memory-evidence.js:9-10` 的 `POLICY_VERSION/DECISION_VERSION` 为唯一来源，`memory.js:4998-4999` 的 `p5.0` 改为具名常量（例如 `FEEDBACK_POLICY_VERSION`），**保持输出值仍是 `p5.0`**，避免改变已存记忆数据。理由：§23 要求版本化配置；同一个"版本"存在 `p1.0` 常量与 `p5.0` 字面量两套来源，违反可审计性。

### 3.7 Approval 状态集

- **文档依据**：§29 "Approval Request 自身使用 pending、approved、rejected、expired、escalated、cancelled；Task 的 waiting_approval 由 Engine 管理"；§24.3"审批人只能提交 decision，不能直接改 Task 状态"。v1.3 §31.1 不变量："审批超时不能被解释为批准（§29、§30）"（`docs/v1.3-decisions-and-verification-checklist-2026-11-03.md:23`）；v1.3 §32.3："`overdue` 是 Approval Request 上的标记，不是 Task 状态，不进入 §24.1 状态集合"（同上 `:76`）。
- **裁定**：Approval 的六态是唯一审批状态集；`executing/completed/failed` 是执行结果，不属于审批状态，应写入 Task/Result。`overdue` 只作为 Approval 上的派生标记/升级信号，**不新增状态值**（否则会变成第 7 个审批态并与 §29 冲突）。当前 `approvals.js:4` 的五段式与 §29 冲突，以 §29 为准。
- **范围**：归属本方案，**代码落地归 Phase 1 ④（审批 TTL）**，因为 `expired/escalated` 必须有 `deadline/escalationAt` 持久化字段（`approvals.js:222-240` 当前无此字段）。本阶段不改。

### 3.8 未覆盖、按最小风险默认推进

以下各项在 v1.0–v1.3 中**没有任何条款覆盖**（不是冲突，是空白），按最小风险默认推进，不需要用户裁定；后续若要改，写明改动点。已核对 v1.3 §31–§42：它与 Session 词表、Context plan 命名、`checkpointVersion` 字段名均无交集，因此下列各项仍属未覆盖。

| 项 | 采用的默认值 | 为什么风险最小 | 后续要改哪里 |
| --- | --- | --- | --- |
| Session 生命周期词表 | 保留 7 值，声明为 Task 状态的投影；只统一写入路径，不删值 | 后端 API 返回值不变，`agent-worker` 4 处断言不变；前端无 Session lifecycle 消费者；§11 只约束权威，不约束词表 | 若要收缩为 `active/running/closed`：`sessions.js:26-34`、`296-309`、`agent-worker.test.js:406/503/528/540`、`routes.js:241-252`；Phase 2 做 |
| Context plan 的命名 | 文档/注释改称"上下文策略快照（contextPolicy）"，不授予 `planVersion`，不新增 trace 字段 | 不改 `trace.orchestration` 结构，`context-engine-e2e`(38)/`context-orchestrator-p3`(11) 不受影响；避免与 Workflow 计划混淆 | 若将来要在 trace 中显式标识：`trace.js:126-133`、`152-189`、`engine.js:127`；属可观测性变更，不改协议 |
| `planVersion` 过渡值 | 字段可空，Workflow Store 落地前为 `null` | 不伪造版本、不改变现有返回字段语义（新增可空字段对旧客户端无破坏） | Workflow Store 落地时由 Engine 写入：`tasks.js:603-650`、`350-403`、`task-store.js:44-69` |
| `checkpointVersion` 字段名 | 不改名，只收敛语义与写入点 | 现有测试按字段名与计数断言；改名收益仅是措辞，风险是数据迁移 | 若确需统一命名：`tasks.js:381/626/769/1005`、`agent-recovery.test.js:128/220-226` |
| `approvals.js` 的执行状态值 | 本阶段保持，不改；④ 再按 §29 拆出 | 审批 TTL 需要 schema 变更与通知链路，与 ① 无关；现在改会波及 `memory-maintenance`(5) 与 `memory-lifecycle-decisions`(19) | ④ 落地时：`approvals.js:4/28/222-240/284/437-462`、`Approval` 前端类型 |

---

## 4. 改动拆解（可独立验证、可独立提交）

前置：每步完成后必须五门禁全绿：
`npx tsc --noEmit`、`npx expo lint`、`node scripts/verify-test-coverage.js`、`node scripts/sync-doc-counts.js --check`、`node scripts/verify-api-capabilities.js`。
新增/删除测试或改变用例数时，同一提交更新 `scripts/test-coverage-baseline.json`（`files`、`backendTotal`、`nodeTestSuiteTotal`、`runnerTotal`、`frontend`、`nodeTestSuiteFiles`/`runnerFiles`），并运行 `node scripts/sync-doc-counts.js --write` 刷新 `AGENTS.md`；否则 `--check` 必红。

### 4.1 步骤表

| 步 | 内容 | 改哪些文件 | 如何证明没破坏现有行为 | 测试计数影响 |
| --- | --- | --- | --- | --- |
| **S1** | 权威声明归位（纯注释/文档）：改正 `tasks.js:5-7`；把 `state-machine.js:5` 改为"迁移合法性定义"；把 `task-store.js:5-11` 限定为"agent-tasks.json 单文件权威"；补一句"Event 仅通知" | `server/agents/tasks.js`、`state-machine.js`、`task-store.js`；`docs/phase0-baseline-audit-2026-11-03.md` 不改本体，只在后续 PR 说明中引用 | `git diff` 只含注释行；五门禁全绿；现有 2056 个后端用例不变 | **无**（0 用例变化，baseline/AGENTS 不动） |
| **S2** | 词表单一导出：新增 `status-vocabulary.js`，导出 10 态 + `LEGACY_ALIASES = { uncertain: 'recovery' }`；`state-machine.js`、`worker-result.js` 从它导入；**不改任何写入值** | 新增 `server/agents/status-vocabulary.js`；`state-machine.js:11-29`、`worker-result.js:12-18` | 现有 suites 不变；额外用 `node -e` 断言 `STATUSES` 与 §24.1 十态逐字相等（可写成一次性校验，不新增用例） | **无**（不新增 test case；若加 1 条 parity 用例则 backend 2057/nodeSuite 223/runner 1835，需同步 baseline） |
| **S3** | Task 状态写权限收口：`updateTask` 移除 `status` 分支（`tasks.js:700-703`），新增 `transitionTask(taskId, {to, expectedVersion=null, writer})`；12 处 status 写入改走它；`recoverInterrupted` 两处直接赋值改走它 | `tasks.js:695-703/1013-1034/1046-1095`；`runtime.js`（7 处 status，含 `:73` 启动失败）；`approvals.js`（5 处 status） | `agent-recovery`(26)/`agent-dispatch`(13)/`memory-maintenance`(5)/`memory-bot`(9) 全绿；非法迁移仍返回 409；事件顺序不变 | **无**（调用点重构，不增删用例） |
| **S4** | Session 投影化：新增 `deriveLifecycleStatus(taskStatus)`（identity 映射 + 兜底 `closed`）；`runtime.js:899-909` 与 `approvals.js:446/469/319` 共用；`closeSession` 不再接受任意值 | `sessions.js:26-34/296-309`；`runtime.js:899-909`；`approvals.js:446-449/469-471/319-322` | `agent-worker`(26) 的 4 处终态断言（`406/503/528/540`）仍通过；`sessions`(61) 全绿；`GET /agents/:botId/sessions` 返回值不变 | **无**（不增删用例） |
| **S5** | `uncertain → recovery` 正式化（**可见行为**）：状态机删 `uncertain`、加 `recovery`；`recoverInterrupted` 写 `recovery`；`healthSnapshot` 改 `counts.recovery`；`worker-result` 终态集改 `recovery`；读边界保留旧值别名 | `state-machine.js:11-58`；`tasks.js:1046-1095/1109-1133`；`worker-result.js:12-18`；`runtime.js:951`；`lib/api/types.ts:1003-1011`；`components/TasksPanel.tsx:16-25`；`scripts/sync-doc-counts.js` 中 `agent-recovery` 描述 | `agent-recovery`(26) 与 `agent-watchdog`(26) 的 21 处 `uncertain` 断言改为 `recovery` 后全绿；旧数据读取仍返回 `recovery`；`tsc` + `expo lint` 通过 | **无计数变化**；仅改断言字符串。若新增"旧数据别名"用例则 +1（2057/223/1835） |
| **S6** | 迁移表对齐（**结构性行为变化**）：审批请求发生在 `queued/accepted` 时，Engine 先走 `queued→accepted→running`，再 `running→waiting_approval`（在执行副作用前暂停）；批准后 `waiting_approval→running`，再由执行结果写 `completed/failed`；按 v1.3 §32.2 补 `waiting_approval→timed_out`（资源期限耗尽且无未核清副作用）与 `waiting_approval→recovery`（资源期限耗尽但副作用未知），**审批 SLA 永不触发这两条边**；删除 `waiting_approval→completed/uncertain`、`accepted→completed/failed/queued/waiting_approval`、`running→queued`（由 `retrying` 取代） | `state-machine.js:31-58`；`approvals.js:245-253/302-307/425-478`；`tasks.js:1013-1034`；`router.js` 审批前置判定 | `memory-maintenance`(5)/`memory-lifecycle-decisions`(19)/`memory-bot`(9)/`agent-worker`(26) 全绿；审批终态不变（仍 completed/failed），只多 `running` 中间态与事件；`approvals.js:250-252` 的静默 catch 不再吞掉非法迁移；资源耗尽分支需独立用例证明"审批仍 pending、Task 已 timed_out/recovery" | **无计数变化**；若补"审批入口必须 running"或"资源耗尽不改 Approval"用例则 +1（2057/223/1835） |
| **S7** | `retrying` 正式化：`setRetry` 写 `retrying`；退避到期由 Engine `retrying → running`（不经过 `queued` 中转）；更新 7 处队列/健康读取 | `tasks.js:1013-1034/1104/1126/1158-1172`；`runtime.js:67/838`；`watchdog-policy.js:52`；`router.js:350`；`state-machine.js:31-58` | `agent-recovery`(26)/`agent-watchdog`(26)/`agent-router`(49)/`agent-runtime-guards`(4) 全绿；失败后重试不立即出队（`retryAt` 仍生效） | **预计 +2 用例**（退避到期、重复重试熔断）：`agent-recovery` 26→27、`agent-watchdog` 26→27；`backendTotal` 2056→2058、`nodeTestSuiteTotal` 222→224、`runnerTotal` 1834→1836；`frontend` 188/22 不变；同步 baseline + `sync-doc-counts --write` |
| **S8** | `planVersion` 契约：Task 新增可空 `planVersion`/`planId`；`publicTask` 返回；`task-store.normalizeTask` 补默认 `null`；前端类型加可空字段。不接 Workflow Store，不写假值 | `tasks.js:350-403/603-650`；`task-store.js:44-69`；`lib/api/types.ts:989-1031` | `agent-router`(49) 的 3 处 `contractVersion` 断言仍通过；`api`(36) 响应兼容（新增可空键）；`tsc` 通过 | **无计数变化**（仅在既有用例中加字段存在性断言不增用例数） |
| **S9** | 版本字段治理：`updateTask` 删除 `checkpointVersion` patch（`769-771`）；`checkpointVersion` 注释定性；`contractVersion` 收口到 `server/agents/contract.js`；`decisionVersion` 收口到 `memory-evidence` 常量（保留 `p5.0` 输出） | `tasks.js:769-771/41`；新增 `server/agents/contract.js`；`router.js:18`；`memory.js:4998-4999`；`memory-evidence.js:9-10` | `agent-recovery`(26) 的 checkpoint 1/2 断言不变；`agent-router`(49) 的 contractVersion 断言不变；`profile-p5`(44)/`memory-evidence-policy`(14) 全绿 | **无**（纯收敛，不增删用例） |
| **S10** | 文档与登记收口：`AGENTS.md` 中状态/版本描述、测试描述、API 能力登记块由脚本刷新；不改路由 | `AGENTS.md`（生成块）；`scripts/sync-doc-counts.js`（仅描述文本，若 S5/S6/S7 需要） | `node scripts/sync-doc-counts.js --check`、`node scripts/verify-api-capabilities.js` 全绿；路由仍 95 条 | **无**（若前面有计数变化，本步承接 `--write` 结果） |

### 4.1.1 S6 的资源期限前置条件（重要，已读码确认）

【已验证】`deadlineMs` 在仓库中**已被强制执行**，但计时起点是"任务真正开始执行"：`runtime.js:645-657` 在 `execute()` 之前起 `setTimeout`，到期置 `deadlineExceeded` 并 `abort`；`runtime.js:811-816` 把它归一为 `deadline_exceeded`，`runtime.js:849` 写 `timed_out`。因此：

- 若审批请求发生在 `queued`（当前 `approvals.js:245-253` 允许，直接写 `waiting_approval`），**deadline 计时尚未启动**，`waiting_approval` 期间不存在资源期限约束——这正好违反 v1.3 §32.1 第 2 条"Task `deadline`……在 `waiting_approval` 期间照常有效"。
- S6 把审批入口改为 `queued→accepted→running→waiting_approval` 后，deadline 计时已在 `execute()` 前启动，`waiting_approval` 的墙钟时间自然计入，**无需新写计时器**。
- 【未覆盖/未实现】Task Token 预算与 Run 总预算当前不存在（全仓无 `tokenBudget` 的 Task 侧计量、无 `budget_exceeded`；`runtime.js` 只有 `deadlineMs` 一条硬约束）。因此 v1.3 §32.1 第 3 条的两条边（`timed_out`/`recovery`）**先只做"边合法化"**，Token/Run 预算的写入者随后续预算条款落地；deadline 分支可在 S6 直接生效。

### 4.2 步骤依赖关系

- S1 独立，可先合。
- S2 → S3 → S5/S6/S7（S3 是写权限前提；S5/S6/S7 才能在唯一入口改词表与边）。
- S4 可与 S3 并行（不同文件），但必须在 S5 前，避免 `uncertain` 映射两处。
- S6 依赖 S3；S7 依赖 S6（`running → queued` 删除后由 `retrying` 承接）。
- S8/S9 独立于 S5–S7，可在 S3 后任意时间做。
- S10 最后做，承接所有计数与描述变化。
- **不可合并提交**：S5、S6、S7 都能单独回滚；S3 与 S5 合并会让"写权限重构"和"状态改名"无法区分回滚；S6 与 S7 合并会让"审批时序"和"重试语义"无法区分回滚。

### 4.3 本次实测基线（只读）

已运行并通过（2026-11-03，工作目录 `C:/Users/Administrator/Documents/Qoder/2026-10-27/975cfd2c/Bluebird`）：

```
node scripts/verify-test-coverage.js   → PASS 72/72 文件；backend 2056/2056；nodeSuite 222/222；runner 1834/1834；frontend 188/188、22/22
node scripts/sync-doc-counts.js --check → 文档计数与基线一致
node scripts/verify-api-capabilities.js → 后端路由 95 条、路由族 20 个、仅 API 能力 9 个
```

【未取证】`npx tsc --noEmit` 与 `npx expo lint` 本次未运行（属方案阶段，未改代码）；实施每一步时必须实跑。

---

## 5. 风险与回滚点

| 风险 | 触发步骤 | 具体表现 | 回滚/缓解 |
| --- | --- | --- | --- |
| 审批路径绕过 Engine 后行为时序变化 | S3 | `approvals.js` 同步执行后立即 transition；若 `transitionTask` 抛错，现有 `try/catch` 仍吞掉，任务可能停在 `waiting_approval` | 保持 `transitionTask` 的异常类型与 409 语义不变；S3 只改调用形状，不改重试/执行顺序 |
| 审批时序改变 | S6 | 原本"批准即完成"的任务会多出 `running` 状态与事件；对正在轮询的客户端可见 | 保持审批接口同步返回与最终终态不变；事件只增不改；若前端按终态轮询，需同提交补 `running` label |
| 把审批 SLA 误当资源期限 | S6 | 若用 Approval 的 `expiresAt`/`overdue` 触发 `waiting_approval→timed_out`，等价于"超时放行/超时终止"，违反 v1.3 §31.1 不变量与 §32.2（`timed_out` 只表示资源期限终止） | 触发源只允许 `deadlineExceeded`/预算耗尽；审批侧只能写 Approval 状态与 `overdue` 标记，代码审查时禁止 `approvals.js` 直接写 Task `timed_out`/`recovery` |
| 旧数据含 `uncertain` | S5 | 直接删除该值会让旧记录 `isTerminalStatus` 为 false，任务被当活任务恢复扫描 | 读边界保留 `uncertain → recovery` 别名；`task-store.migrate` 不批量改写，先只读映射 |
| `retrying` 改变队列语义 | S7 | 调度器只查 `queued` 会漏掉重试任务，造成"永不重试" | S7 同时更新 7 处读取；先加"retrying 到期即 running"用例，再加状态写入，可单独回滚 |
| 前端未知状态 | S5/S6/S7 | `TasksPanel` 的 `STATUS_LABEL` 无新状态时显示原始英文 | 同提交补 label；`tsc` 的联合类型会强制覆盖 |
| 计数不同步 | S5/S6/S7 | `verify-test-coverage` / `sync-doc-counts --check` 红 | 同提交改 baseline 六个字段 + `sync-doc-counts --write` |

## 6. 非目标（明确不做）

- 不实现 CAS/`expectedVersion`（Phase 1 ②）；本文只定 `stateVersion` 与 `checkpointVersion` 的边界。
- 不实现 Artifact Store / 完成提交协议（Phase 1 ③）；本文只定 Blackboard 归属，当前 `result.artifacts` 的 `{kind,id}` 引用形态保留。
- 不改审批 TTL、`deadline/escalationAt`、`expired/escalated`（Phase 1 ④）；本文只定 Approval 六态归属。
- 不收缩 Session 词表（保留为投影，Phase 2 再评估）。
- 不做动态组队、不新增路由、不改 HTTP 契约（S8 只加可空字段）。
