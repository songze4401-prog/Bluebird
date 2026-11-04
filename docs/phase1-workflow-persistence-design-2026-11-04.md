# Phase 1 本体第一段：持久化 Workflow 与崩溃恢复设计（2026-11-04）

分支：`phase1/persistent-workflow-2026-11-04`（基于 `e08b168`）。本文件只做设计，不含任何实现；带「推断」的结论未经运行验证。

## 结论先行

- **推荐方案：Outbox / 两阶段（意图先落盘 + 执行后补结果 + 幂等键）**，不选「单文件原子提交」。理由：外部工具副作用不在任何文件里，单文件提交只能解决「文件 A vs 文件 B」，解决不了「副作用已发生但记录没写」——后者正是本链路最危险的窗口。
- **最危险崩溃窗口：审批执行 `executing` 之后、`memoryService.execute` 返回之后、审批 `completed` 落盘之前**（[approvals.js](file:///C:/Users/Administrator/Documents/Qoder/2026-10-27/975cfd2c/Bluebird/server/agents/approvals.js#L591-L622) L591-L622）。崩在这里：副作用可能已经发生，重启后 `recoverInterrupted` 把审批与任务都标成 `failed`（[approvals.js](file:///C:/Users/Administrator/Documents/Qoder/2026-10-27/975cfd2c/Bluebird/server/agents/approvals.js#L745-L784) L749-L784），系统既不重试也无法证明执行过；若人工再批准一次，就会重复执行。
- **工作量（估算）**：5 个可独立回滚的提交，约 600–900 行新增（含测试），新增 1 个存储模块 + 3 个测试文件；不含 Worker Pool / Blackboard。

## 一、现状盘点

| 状态 | 存在哪 | 关键行号 | 内存 / 落盘 | 版本字段 |
| --- | --- | --- | --- | --- |
| 任务事实（状态、result、lease、retryAt、checkpoint） | `DATA_DIR/agents/agent-tasks.json` | [task-store.js](file:///C:/Users/Administrator/Documents/Qoder/2026-10-27/975cfd2c/Bluebird/server/agents/task-store.js#L26-L27) L26-L27；原子写 [task-store.js](file:///C:/Users/Administrator/Documents/Qoder/2026-10-27/975cfd2c/Bluebird/server/agents/task-store.js#L125-L126) L125-L126 → [atomic-write.js](file:///C:/Users/Administrator/Documents/Qoder/2026-10-27/975cfd2c/Bluebird/server/atomic-write.js#L50-L81) L50-L81（临时文件 + fsync + rename + 目录 fsync） | 落盘 | `stateVersion` 每次写 +1（[tasks.js](file:///C:/Users/Administrator/Documents/Qoder/2026-10-27/975cfd2c/Bluebird/server/agents/tasks.js#L739-L742) L739-L742、L935-L937）；CAS 校验 L747-L759 |
| 检查点 | 任务记录的 `checkpoint` 字段内，无独立文件 | 写入 [tasks.js](file:///C:/Users/Administrator/Documents/Qoder/2026-10-27/975cfd2c/Bluebird/server/agents/tasks.js#L1129-L1147) L1129-L1147；调用 [runtime.js](file:///C:/Users/Administrator/Documents/Qoder/2026-10-27/975cfd2c/Bluebird/server/agents/runtime.js#L569-L592) L569-L592 | 落盘（随整文件重写） | `checkpointVersion` 序号 +1，不是 CAS 版本（L664-L666 注释） |
| 队列 / 调度 | 无独立队列；队列 = 文件中 `queued`/`retrying` + `retryAt` | `nextQueuedTask` [tasks.js](file:///C:/Users/Administrator/Documents/Qoder/2026-10-27/975cfd2c/Bluebird/server/agents/tasks.js#L1380-L1397) L1380-L1397；调度循环 [runtime.js](file:///C:/Users/Administrator/Documents/Qoder/2026-10-27/975cfd2c/Bluebird/server/agents/runtime.js#L53-L80) L53-L80 | 队列成员落盘；并发槽 `activeRuns`/`scheduling` 纯内存（L42-L47） | 无 |
| 租约 / 心跳 | 任务记录 `lease` 字段 | 结构 L837-L850；TTL 默认 60s [runtime.js](file:///C:/Users/Administrator/Documents/Qoder/2026-10-27/975cfd2c/Bluebird/server/agents/runtime.js#L38-L41) L38-L41；心跳 L702-L726 | 落盘（随任务） | 无 |
| 审批记录 | `DATA_DIR/agents/agent-approvals.json` | [approvals.js](file:///C:/Users/Administrator/Documents/Qoder/2026-10-27/975cfd2c/Bluebird/server/agents/approvals.js#L29) L29 | 落盘 | 冻结 `policyVersion`（L420、L432） |
| 产物 / 产物审计 | `agent-artifacts.json`、`agent-artifact-audit.json` | [artifact-store.js](file:///C:/Users/Administrator/Documents/Qoder/2026-10-27/975cfd2c/Bluebird/server/agents/artifact-store.js#L32-L33) L32-L33；引用提交 [artifact-commit.js](file:///C:/Users/Administrator/Documents/Qoder/2026-10-27/975cfd2c/Bluebird/server/agents/artifact-commit.js#L33-L54) L33-L54 | 落盘 | 产物自身 `version`；引用带 `version` |
| 事件 / Outbox | `agent-events.json`、`agent-event-outbox.json` | [tasks.js](file:///C:/Users/Administrator/Documents/Qoder/2026-10-27/975cfd2c/Bluebird/server/agents/tasks.js#L30-L31) L30-L31；flush L234；启动补投 [runtime.js](file:///C:/Users/Administrator/Documents/Qoder/2026-10-27/975cfd2c/Bluebird/server/agents/runtime.js#L1033-L1035) L1033-L1035 | 落盘 | 无 |
| 会话与消息 | `DATA_DIR/sessions.json` | [sessions.js](file:///C:/Users/Administrator/Documents/Qoder/2026-10-27/975cfd2c/Bluebird/server/sessions.js#L17) L17；追加 [sessions.js](file:///C:/Users/Administrator/Documents/Qoder/2026-10-27/975cfd2c/Bluebird/server/sessions.js#L751-L771) L751-L771 | 落盘 | 无 |
| 结果投递幂等 | 任务记录 `deliveryStatus`/`deliveryMessageId` + 会话消息 | 消息 id 确定式 [result-delivery.js](file:///C:/Users/Administrator/Documents/Qoder/2026-10-27/975cfd2c/Bluebird/server/agents/result-delivery.js#L20-L22) L20-L22；已存在判定 L97-L135；启动补投 L206-L224 | 落盘 | 无 |
| 计划 / Workflow | **不存在** | `planId`/`planVersion` 只在创建时置 `null`（[tasks.js](file:///C:/Users/Administrator/Documents/Qoder/2026-10-27/975cfd2c/Bluebird/server/agents/tasks.js#L652-L656) L652-L656）、回读 L398-L401、旧数据补 null（[task-store.js](file:///C:/Users/Administrator/Documents/Qoder/2026-10-27/975cfd2c/Bluebird/server/agents/task-store.js#L63-L64) L63-L64） | 无存储 | S8 预埋，**至今没有任何写入者** |

`planId`/`planVersion` 本该指什么：[context/orchestrator.js](file:///C:/Users/Administrator/Documents/Qoder/2026-10-27/975cfd2c/Bluebird/server/context/orchestrator.js#L9) L9 明确为「Workflow Engine 计划版本指针」。也就是说它应指向 Workflow Store 中的 `planId` 与「该计划被第几次重规划后的版本」；在该 Store 落地前必须保持 `null`，禁止占位值（L652-L654）。目前也没有消费者：只有 `failopen-policy` 的 `actionScope.planVersion` 读取该字段，且该判定未接执行器。

单写者假设：进程启动时有单实例锁（[single-instance.js](file:///C:/Users/Administrator/Documents/Qoder/2026-10-27/975cfd2c/Bluebird/server/single-instance.js#L182-L285) L182-L285；`BLUEBIRD_ALLOW_MULTI=1` 可绕过，绕过即失去该假设）；任务存储注释也写明「单机原子文件 + 单实例锁保证只有一个写者」（[task-store.js](file:///C:/Users/Administrator/Documents/Qoder/2026-10-27/975cfd2c/Bluebird/server/agents/task-store.js#L13-L16) L13-L16）。Worker 是**同进程内**异步执行，不是子进程/线程（[runtime.js](file:///C:/Users/Administrator/Documents/Qoder/2026-10-27/975cfd2c/Bluebird/server/agents/runtime.js#L42-L47) L42-L47、L53-L58）。

## 二、崩溃点清单（按链路顺序）

| # | 窗口 | 位置 | 崩在这里丢什么 | 会重复什么 | 现有系统会怎样 |
| --- | --- | --- | --- | --- | --- |
| W1 | 创建任务：幂等命中检查 → `saveTasks` | tasks.js L619-L701 | 落盘前崩：任务不存在；落盘后崩：`task.created` 事件丢 | 无（幂等键已落盘，重试返回同任务） | 落盘前重试=新任务；落盘后只是事件缺失 |
| W2 | 调度 → 拿租约 → `recordRunStart` → `accepted` | runtime.js L601-L628 | `attempts` 已 +1 但状态未推进 | 无 | 租约过期后可被重新领取；未进入 `accepted` 的任务仍属可调度状态 |
| W3 | `accepted` → 会话归属 → `running` | runtime.js L622-L694 | 会话标记 running、任务仍 `accepted` | 无（还没执行模型） | 重启按可恢复态处理：只读任务 → `retrying`；含 `memory_remember` → `recovery`（tasks.js L1264-L1314） |
| W4 | 模型/工具执行中（含 checkpoint） | runtime.js L751-L777；checkpoint L569-L592 | 最后一次 checkpoint 之后的进度 | **只读工具可能重跑**；含副作用工具不重跑 | 重启：有副作用 → `recovery` 等人工；只读 → `retrying` 自动重跑（tasks.js L1280-L1314） |
| W5 | 创建审批：**先把任务移到 `waiting_approval`，再保存审批记录** | approvals.js L399-L406 → L448-L449 | 任务已 `waiting_approval`，但审批记录不存在 | 无 | 若任务没有 `deadlineMs`，启动恢复 `getTaskDeadlineAt` 为 null 直接 `continue`（tasks.js L1252-L1258）→ **永久卡在等待态** |
| W6a | 审批执行：任务回 `running` 后、审批置 `executing` 前 | approvals.js L588-L594 | 审批保持 `approved`、任务 `running` | 可能重跑模型 | 重启把 running 任务按只读/副作用分类处理（tasks.js L1264-L1314）；审批仍可再次点击执行 |
| W6b | 审批 `executing` 已落盘、副作用调用前 | approvals.js L591-L600 | 无副作用 | 无 | 重启把审批与任务标 `failed`（`interrupted`/`approval_interrupted`，approvals.js L749-L784）——**假失败** |
| **W6c** | **副作用调用返回后、审批 `completed` 落盘前** | approvals.js L600-L622 | **副作用已发生但没有成功记录** | 自动重试不会发生；**人工再次批准会重复执行** | 重启标 `failed`；无任何「已执行」证据，最危险 |
| W6d | 审批 `completed` 已落盘、任务 `completed` 前 | approvals.js L622-L650+ | 审批成功、任务仍 `running` | 推断：任务可能被按失败/恢复收口 | 重启按 running 任务处理；审批与任务结论不一致 |
| W6e | 审批产物已落盘、任务提交前 | approvals.js L630-L650 | 产物成为 orphan | 无 | 依赖 TTL 168h 清理（artifact-commit 顶部常量） |
| W7 | 完成路径：产物落盘 → `completeTask` → `recordRunFinish` → 释放租约 → 投递 | runtime.js L795-L847 | 各段各丢一段 | 投递有幂等保护（见下） | 见分项 |
| W7a | 产物已落盘、`completeTask` 前 | runtime.js L800-L826 | 产物 orphan；任务仍 running | 无 | 重启 → `retrying`/`recovery`；orphan 靠 TTL 清理 |
| W7b | `completeTask` 后、`recordRunFinish` 前 | runtime.js L823-L831 | run history 少一条收口 | 无 | 任务已是 completed，启动恢复不修 run history（**证据缺口**） |
| W7c | `recordRunFinish` 后、投递前/投递中 | runtime.js L827-L847；result-delivery L153-L192 | 结果未进父会话 | **不会重复**：消息 id 由 taskId 确定（L20-L22），投递前先按 id 查已存在（L120-L135），崩在「追加消息后、markDelivery 前」下次启动补投时命中已存在分支 | `recoverPending` 启动补投（L206-L224、runtime L1081） |
| W8 | 失败路径：`recordRunFinish(retry)` → `setRetry`；或 transition → run finish → 投递 | runtime.js L931-L986 | 重试序号或 run history 丢一段 | 只读任务重试 | 任务状态已落盘；history 可能缺 |
| W9 | 启动恢复本身 | tasks.js L1239-L1316（末尾 L1316 单次 `saveTasks`）；approvals.js L745-L793 | 循环中崩：未落盘（下次启动重算） | 无 | 批量恢复是「全有或全无」，设计上安全 |

**最重要结论**：W6c 是唯一「副作用已发生、系统却断言失败、且无证据」的窗口；W5 是唯一「无副作用但永久卡死」的窗口。两者都需要「意图先落盘」才能收敛，单靠文件原子写做不到。

## 三、一致性方案二选一

| 维度 | A. 单文件原子提交（任务/审批/产物引用/投递状态合成一个 `workflow.json`，每次一次原子写） | B. Outbox / 两阶段（每次副作用先写意图，执行后补结果；幂等键去重） |
| --- | --- | --- |
| 正确性 | 只能保证「本文件内多个事实一起生效」；**外部副作用仍无法纳入**（工具写记忆、发消息都在文件外），W6c 原样存在 | 能覆盖「外部副作用 vs 记录」：意图在调用前落盘，崩溃后一定知道「可能有副作用」，可判 `recovery` 而非 `failed` |
| 实现复杂度 | 高：要把 4 个 store 的 schema、写入点、迁移、兼容读全部合并；2 个模块互相 import 的循环依赖要拆 | 中：新增 1 个 ledger 存储 + 3 个调用点（runtime 工具执行、approval execute、启动恢复） |
| 性能开销 | 每次状态变更重写整个合并文件（现有已是整文件重写，合并后更大），写放大最严重 | 追加式小文件 + 现有整文件写入不变；每次副作用多 1 次小写（可 fsync） |
| 迁移成本 | 高：旧 4 文件需一次性迁移 + 双读兼容；回滚要还原分片 | 低：新 ledger 独立文件，旧数据可空启动；不改现有 schema |
| 回滚方式 | 只能整体回退版本 + 数据回灌 | 删 ledger 文件 / 关闭开关即可回到现状；现有 store 不受影响 |
| 失败模式 | 单点文件损坏影响全部事实；大文件写放大导致抖动；合并后仍无法证明副作用 | ledger 写失败 → fail-closed 不执行；ledger 与真实结果不一致 → 标记 `recovery` 人工核对 |
| 结论 | 不选 | **推荐** |

**为什么不选 A**：A 的正确性上限是「文件内原子」，而本链路真正会出事的是文件外副作用（W4/W6b/W6c）。把 4 个 store 合成一个文件，付出了最高迁移与写放大成本，却仍然无法回答「这次 memory 写到底执行没执行」。B 用「意图 + 幂等键」正面回答这个问题，且对现有代码改动面最小。

## 四、幂等键设计

- **构造（P2 实际实现，已取代原稿）**：`opKey = sha256(JSON.stringify([agentId, taskId, stepId, toolName, canonicalArgs]))`，`stepId = sha256(JSON.stringify([toolName, canonicalArgs, dedupeKeyOverride || '']))`——**内容寻址**。
  - **为什么否掉 `checkpointVersion + round + toolIndex`**：这三个都是位置量，会在重试和重启后漂移（`checkpointVersion` 随运行推进、`round` 从 1 重新计数）。同一笔副作用在崩溃重启后会算出不同的键，幂等直接失效——这是比「多执行一次」更隐蔽的错误。内容寻址下，同一任务同一工具同一参数，无论跑在第几轮、第几次重试，键都一样。
  - **已知代价**：同一任务里两次**参数完全相同**的合法副作用调用会被合并成一次。
  - **逃生阀**：确实需要同参执行两次时，在参数里带 `dedupeKeyOverride`（如调用序号，`1`/`2`）；该字段只参与幂等键，执行前被剥离，不会进入 handler 参数或业务语义。相同覆盖值仍命中同一个键（见 `tests/agent-side-effect-ledger.test.js` 的 a2 用例）。
  - 刻意**不含** `runId`/`attempt`：同一逻辑操作跨重试必须同键，否则重试会重复执行。
  - 参数规范化（`server/agents/op-ledger.js`）：对象键递归排序；`undefined` 键视为可选字段缺省丢弃、显式 `null` 保留；数字字符串与数字**不互相转换**（`"01"` 与 `1` 若强转会撞键）；数组顺序敏感；拒绝 NaN/Infinity/循环引用/Date（JSON 会把 NaN 变成 null 造成静默撞键）。易变参数白名单仍属工具元数据，尚未实现（P2 未做）。
- **存在哪**：`DATA_DIR/agents/agent-op-ledger.json`（结构化 ledger，按 key 查询），不塞进 `agent-tasks.json`。
- **记录形状**：`{ opKey, taskId, toolName, status: started|succeeded|failed|unknown, attempt, startedAt, finishedAt, resultDigest, errorCode, result, resultOmitted }`。`succeeded` 时结果原文 ≤4096 字节随账本落盘，供重复调用真正复用；超限只存 `resultDigest` 并标 `resultOmitted`。
- **保留多久**：终态条目保留 7 天（与 orphan TTL 同口径，A 类待校准）；上限 5000 条；只淘汰 `succeeded/failed` 且所属任务已终态的条目。
- **清理**：`cleanup()` 由恢复流程/定时任务调用（P2 尚未挂定时器）；`started/unknown` 永不自动删除。容量耗尽时只报告 `overCap`，不误删。
- **命中判定**：执行前查 `opKey`：`succeeded` → 复用结果（带回 `resultDigest`/`opKey`），不再执行；`started` → 先收敛为 `unknown`，任务转 `recovery`，**绝不自动重试**；`unknown` → 同样进 `recovery`；`failed` 且允许重试 → 原地 `attempt+1` 重新置 `started`（同键仍只有一行）；无记录 → 写 `started`（fsync）后执行。账本写不下去 = 不执行（fail-closed）。
- 投递侧已有幂等键，不重复设计：`messageIdFor(taskId)` 确定式（result-delivery.js L20-L22）。

## 五、恢复流程时序

启动入口现状：`agentApprovals.recoverInterrupted()` → `agentRuntime.initializeTaskQueue()`（[index.js](file:///C:/Users/Administrator/Documents/Qoder/2026-10-27/975cfd2c/Bluebird/server/index.js#L4024-L4025) L4024-L4025）；后者内部 flush outbox → tasks 恢复 → 启动投递补偿 → 开调度（[runtime.js](file:///C:/Users/Administrator/Documents/Qoder/2026-10-27/975cfd2c/Bluebird/server/agents/runtime.js#L1033-L1081) L1033-L1081）。

新增/调整后的顺序（每步给输入输出与失败分支）：

1. **单实例锁**之后加载 stores（输入：磁盘文件；输出：内存快照；失败：`agent_tasks_corrupted` 直接退出，不自动重建）。
2. **审批恢复**（现状 L745-L793）：`executing` → 新增「先查 op ledger：有 `started/succeeded` 则标 `unknown` 而不是 `failed`」；R2 overdue 标记；输出待人工清单。
3. **任务恢复**（现状 tasks.js L1239-L1316）：`waiting_approval` 先做**孤儿审批对账**——任务在等待但 `approvals` 无对应记录 → 无 `deadlineMs` 的转 `recovery`（而非永久 `pending`），有 deadline 的按到期收敛；`running/accepted` 按 side-effect 分类；输出：排队队列 + recovery 清单。
4. **op ledger 扫描**：把 `started` 超期条目转 `unknown`，并对其 task 打 `requiresReview`；输出：需人工核对的 op 列表。
5. **投递补偿**（现状 L206-L224）+ **事件 outbox flush**：输入终态且未投递任务；失败：`deliveryStatus=failed` 并留事件，不阻塞启动。
6. **开调度**（现状 L53-L80）：只取 `queued/retrying` 且 `retryAt <= now`；失败：延后 2s 重排，不原地热循环（现状 L67-L73）。

失败分支统一原则：恢复阶段任何单条失败只影响该条，不整体中止；恢复动作本身批量一次落盘（现状 L1316）。

## 六、测试设计

**崩溃注入**（优先黑盒，避免生产代码里埋测试钩子）：

- 子进程 + `SIGKILL`：用 `child_process.spawn` 启动一个最小 runner（临时数据目录），轮询目标文件直到出现期望中间态（如 `agent-tasks.json` 中 `status=running`、`agent-approvals.json` 中 `status=executing`），立即 `process.kill(pid,'SIGKILL')`，再以同一数据目录重启恢复流程。
- 覆盖窗口：W4（工具执行中）、W6b/W6c（审批执行前后）、W7a/W7c（产物/投递）。
- 局限：只能命中「文件已写、下一写未写」的窗口；纯内存中间态无法定点命中（推断：若最终需要确定性，再引入 `BLUEBIRD_TEST_CRASH_AT` 环境变量钩子，作为第二个提交）。

**证明「有副作用工具只执行一次」**：

- 用一个**测试专用副作用工具**：以 `opKey` 为唯一键，向临时目录 append-only 文件写一行并 `fsync`；不依赖任何真实记忆服务。
- 观测点 4 个：副作用账本行数/唯一键数、`agent-tasks.json` 的 `status`/`recovery`、`agent-op-ledger.json` 的 `status`、`agent-approvals.json` 的 `status`。
- 断言：同一 `opKey` 的账本行数 **恰为 1**；重放恢复后第二个实例不再产生第二行；任务终态不是「假装成功」（completed 只在副作用账本有对应行时出现）。
- **能证明**：在本机文件语义与单进程模型下，被测窗口内副作用不会重复，且 `unknown` 不会被误报为成功。
- **不能证明**：真实外部服务（记忆服务/网络）的幂等性；断电级持久性（只验证到 `fsync` 返回）；未采样到的时序窗口；多进程/多机并发；参数规范化覆盖不到的工具。

## 七、分步实施计划

| 步 | 提交内容 | 独立验证 | 回滚 |
| --- | --- | --- | --- |
| P1 | 新增 `op-ledger` 存储模块（schema、读写、哈希键、清理）+ 单测（不接任何执行器） | 新测试文件全绿；现有套件不变 | 删除模块与新测试 |
| P2 | runtime 副作用工具路径接 ledger：执行前写 `started`，成功后补 `succeeded`；崩溃 → `unknown` → `recovery` | 崩溃注入 W4 用例：账本唯一键=1，任务 `recovery` 非 `completed` | 还原调用点，保留 P1 模块 |
| P3 | 审批执行接 ledger（W6b/W6c）+ 审批恢复区分 `unknown|failed` | W6c 用例：账本 1 行、审批/Task 标 `unknown` 人工核对，不标 `failed` | 还原 approvals.js 调用点 |
| P4 | 修复 W5：创建审批顺序（记录先落盘再移任务，或启动对账兜底）+ 启动恢复对账 | 用例：等待态无审批记录 → 启动后不再永久卡死 | 还原排序/对账 |
| P5 | 跑完 `run-tests.js` 崩溃注入集 + 计数同步（baseline、doc-counts、CI 注释） | 五门禁 + 全量回归 | 单独回滚该提交 |

每步只碰 1–2 个模块，均可在 `phase1/persistent-workflow-2026-11-04` 上单独 revert。

## 八、风险与明确不做

**风险**
- 写放大：`agent-tasks.json` 已是整文件重写，ledger 只是增量，但 `fsync` 次数上升；高频工具会放大 I/O（推断：需要按工具白名单启用）。
- 单写者假设：`BLUEBIRD_ALLOW_MULTI=1` 或多机部署时，ledger 与任务文件的并发写没有保证。
- 参数规范化：不同工具的参数语义不同，哈希键可能误判「两次合法相同调用」为重复（需要稳定参数白名单，属产品决策）。
- `sessions.json` 的写入方式本轮未验证是否原子（标「未验证」），W7c 的结论依赖其按 id 可查。
- ledger 清理与任务裁剪顺序错配会留下悬挂条目（设计上以任务终态为准）。

**明确不做**：Worker Pool（多进程/线程）、Blackboard、`trustLevel`、云端部署；不改状态词表与 `state-machine.js`；不做 `planId`/`planVersion` 的写入（留给下一段 Workflow Store 本体）。

本轮只产出本设计文档，**未写任何实现代码，未开始 Phase 1 本体，未合并、未开 PR、未触碰 `main`**。
