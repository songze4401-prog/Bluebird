# Phase 1 本体第一段：持久化 Workflow 与崩溃恢复设计（2026-11-04）

分支：`phase1/persistent-workflow-2026-11-04`（基于 `e08b168`）。第四、五、九节已按 P1–P3 的实际实现改写；第一至三、六至八节仍是设计原稿（带「推断」的结论未经运行验证）。

## 结论先行

- **推荐方案：Outbox / 两阶段（意图先落盘 + 执行后补结果 + 幂等键）**，不选「单文件原子提交」。理由：外部工具副作用不在任何文件里，单文件提交只能解决「文件 A vs 文件 B」，解决不了「副作用已发生但记录没写」——后者正是本链路最危险的窗口。
- **最危险崩溃窗口：审批执行 `executing` 之后、`memoryService.execute` 返回之后、审批 `completed` 落盘之前**（原 W6c）。**已由 P3 关闭**：审批执行的 `begin` 先于 handler 落盘，重启时按账本三分支收敛（`succeeded` → 收敛为已执行；`started/unknown` → 任务 `recovery` 待核对；只有账本确认没执行过才判失败），详见第九节。
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
| W5 | 创建审批：**先把任务移到 `waiting_approval`，再保存审批记录** | approvals.js L399-L406 → L448-L449 | 任务已 `waiting_approval`，但审批记录不存在 | 无 | 若任务没有 `deadlineMs`，启动恢复 `getTaskDeadlineAt` 为 null 直接 `continue`（tasks.js L1252-L1258）→ **永久卡在等待态**。**P3 已修复**：改为先落审批记录再迁任务（失败回滚记录），并对「pending 记录 + 任务未进等待态」与「等待态无审批记录」两种中间态做启动对账（见第九节） |
| W6a | 审批执行：任务回 `running` 后、审批置 `executing` 前 | approvals.js L588-L594 | 审批保持 `approved`、任务 `running` | 可能重跑模型 | 重启把 running 任务按只读/副作用分类处理（tasks.js L1264-L1314）；审批仍可再次点击执行 |
| W6b | 审批 `executing` 已落盘、副作用调用前 | approvals.js L591-L600 | 无副作用 | 无 | 重启把审批与任务标 `failed`（`interrupted`/`approval_interrupted`，approvals.js L749-L784）——**假失败**。**P3 已修复**：账本有 `started` 行（begin 先于 handler）→ 任务 `recovery`、审批退回 `approved` 带 `side_effect_unknown`，不写 `failed` |
| **W6c** | **副作用调用返回后、审批 `completed` 落盘前** | approvals.js L600-L622 | **副作用已发生但没有成功记录** | 自动重试不会发生；**人工再次批准会重复执行** | 重启标 `failed`；无任何「已执行」证据，最危险。**P3 已修复**：账本 `started` + handler 已返回时，重启按 `started` 分支进 `recovery` 等人工核对；同键再点执行会被闸门拦住（`side_effect_unknown`），不会重跑 |
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
2. **审批恢复**（P3 已改）：`executing` 逐条查 op ledger 三分支收敛（`succeeded` → 已执行；`started/unknown` → `recovery`；账本确认无行 → `failed`）；再做两条中间态对账（pending 记录推回等待态、等待态无审批记录 → `recovery`）；R2 overdue 标记；输出待人工清单。
3. **任务恢复**（现状 tasks.js L1239-L1316）：`running/accepted` 按 side-effect 分类；输出：排队队列 + recovery 清单。
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
| P4 | 修复 W5：创建审批顺序（记录先落盘再移任务，或启动对账兜底）+ 启动恢复对账。**已并入 P3 落地**（用户要求审批接入与 W5 同一轮收口），剩 P4 只做本轮未覆盖的窗口 | 用例：等待态无审批记录 → 启动后不再永久卡死 | 还原排序/对账 |
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

## 九、P3 审批接入实现口径（已落地）

**执行顺序（`approvals.execute`）**

1. 校验：`approved`、策略、权限、关联任务处于 `waiting_approval`（只读检查，不提前迁状态）。
2. 算幂等键 `opKey`：`taskId` 取 `record.taskId`（无关联任务时退化为 `approvalId`，账本要求非空）；`stepId` 仍内容寻址，用 `approvalId` 作第三分量加盐——每个审批是一次独立的用户授权，两条同参审批不能合并成一次；`approvalId` 是稳定身份而非位置量，重启后算得出同一个键。
3. `executing` 与 `opKey` 同一笔落盘。
4. `guard.before`（账本 `begin`，fsync）先于 handler；写不下去就不执行。命中 `succeeded` 走复用收敛，命中 `started/unknown` 直接进「不确定」分支，不执行。
5. `begin` 之后才把任务从 `waiting_approval` 迁回 `running`。
6. `memoryService.execute`（handler）。
7. `guard.after` 补终态：成功 `succeeded`（存 summary 原文，≤4096 字节）、业务失败 `failed`、抛异常 `unknown`。
8. 审批记录落终态，再补任务产物与任务状态。

**崩溃分支（`recoverInterrupted` → `reconcileExecuting`）**

| 账本状态 | 审批记录 | 任务 |
| --- | --- | --- |
| `succeeded` | `completed`，result 取账本原文 | 补产物后 `completed` |
| `started` | 先 `markUnknown` 封账，再退回 `approved` + `side_effect_unknown` | `recovery` |
| `unknown` | 退回 `approved` + `side_effect_unknown` | `recovery` |
| `failed` | `failed`（沿用账本 errorCode） | `failed` |
| 无 `opKey`（旧版本残留）/ 账本读不出来 | 退回 `approved` + `side_effect_unknown` | `recovery` |
| 有 `opKey` 但账本无该行 | `failed`（`approval_interrupted`） | `failed` |

- 审批状态词表没有 `recovery`，所以「不确定」的审批一律退回 `approved` 并带 `errorCode`，由任务侧的 `recovery` 表达「等人工核对」；不新增状态词、不改迁移表。
- **旧记录**：P3 之前写下的 `executing` 记录没有 `opKey`，旧版本执行前不写账本，查不到行**不能**证明没执行过——按不确定处理，比原来的「一律 failed」更保守。
- 业务失败（`result.reason !== 'ok'`）与抛异常分开：前者是结构化的「确定没做成」，可判 `failed`；后者可能已写了一半，只能 `unknown`。

**W5 修复**

- `createApproval`：先 `save()` 审批记录，再 `moveTaskToApproval`；迁移失败删除记录、重新保存后抛出。崩在两步之间 → 「记录 pending、任务还在原状态」，不再出现「任务等审批、审批记录不存在」。
- 启动对账两条：① pending 记录 + 任务未进 `waiting_approval` → 推回等待态；② 任务停在 `waiting_approval` 且没有任何未终结审批记录 → 任务 `recovery` + `approval_record_missing`。

**已知边界**

- 「审批记录已 `completed`、任务还没完成」的极窄窗口未单独对账：若同时丢了产物引用，会按「等待态无未终结审批记录」的规则落 `recovery`——保守，不假装成功。
- 审批与运行时共用同一个账本文件，靠 `approvalId` 加盐隔离键空间，两者不会互相命中。

P1–P3 已在本分支落地（每步独立提交），**未合并、未开 PR、未触碰 `main`**；P4 已并入 P3；P5 见下一节。

## 十、P5 真崩溃注入实跑结果（2026-11-04）

### 10.1 注入方法（如何保证「每次都杀在同一个窗口」）

- **落点写在代码里，不靠猜状态**：`server/agents/crash-hook.js` 只暴露一个 `hold(point)`；四个注入点是代码中的固定语句（见 10.2 表），不是「轮询到某个状态就杀」。
- **未启用时零副作用**：`BLUEBIRD_TEST_CRASH_HOOK` 为空时，每个调用点只做一次字符串比较就返回。
- **先写 marker 再阻塞**：命中后同步写 `<markerDir>/crash-<pid>-<point>.json`（含 pid / 点 / 时间），再用 `Atomics.wait` 阻塞事件循环。父进程**只在 marker 出现后**才读磁盘快照并 `child.kill('SIGKILL')`。marker 与阻塞在同一条同步路径上，所以「看到 marker」等价于「进程已停在窗口内且不会再往前走」。
- **真信号**：断言子进程 `exit.signal === 'SIGKILL'`（或非零退出码），不是 mock、不是抛异常模拟。
- **不挂死、不静默跳过**：`hold` 最多阻塞 20s（父进程 25s 内没看到 marker 就判失败），子进程用例 `timeout: 90000`，超时即失败；注入点没命中、没被杀掉、重启没收敛，一律 fail，不 skip。
- **重启侧**：另一个进程以同一 `BLUEBIRD_DATA_DIR` 重新跑 `initializeTaskQueue()` / `approvals.recoverInterrupted()`，按真实启动恢复流程收敛，再把磁盘上的实际状态打成一行 JSON 交给父进程断言。

### 10.2 四个注入点的实测（本机原始输出）

| # | 注入点（代码位置） | 杀掉时的实际状态 | 重启后的实际状态 | 账本实际内容 |
| --- | --- | --- | --- | --- |
| c1 | `agent-runtime.js` handler 返回之后、`sideEffect.after` 之前（`tool.after-handler`） | 任务 `running`；账本 1 行 `started` | 任务 `recovery` / `recovery_uncertain_side_effects`；账本仍 1 行但变 `unknown`（`attempt=1`）；`sealedOps=1`；handler 未重跑 | 1 行，`started → unknown` |
| c2 | `approvals.js` `persistTaskArtifacts` 之后、`normalizeWorkerResult` 之前（`artifact.after-persist`） | 审批 `completed`、任务 `running`、产物 `pending-commit`、账本 1 行 `succeeded` | 审批 `completed`、任务 `recovery`、产物仍 `pending-commit`；扫描 `scanned=1 reconciled=0 orphaned=0 pending=1` | 1 行 `succeeded` |
| c3 | `approvals.js` 审批记录 `save()` 之后、`moveTaskToApproval` 之前（W5 窗口，`approval.after-record-save`） | 审批 `pending`、任务 `running`、账本为空 | `reconciled=1 dangling=0`；任务回到 `waiting_approval`、审批仍 `pending` | 空（还没执行） |
| c4 | `runtime.js` 任务迁到 `running` 之后、`task.started` 事件之前（`task.after-running`） | 任务 `running`；账本 0 行（只读工具） | 任务 `failed`（`bot_not_ready`，attempts=2），terminal=true，不是中间态 | 0 行 |

原始输出（同一轮）：

```
[p5-c1] atKill task=running ledger=started | after task=recovery/recovery_uncertain_side_effects ledger=unknown rows=1 sealed=1 handlerRerun=false
[p5-c2] atKill approval=completed task=running artifact=pending-commit ledger=succeeded | after approval=completed task=recovery artifact=pending-commit scan(scanned=1,reconciled=0,orphaned=0,pending=1)
[p5-c3] atKill approval=pending task=running | after reconciled=1 dangling=0 task=waiting_approval approval=pending
[p5-c4] atKill task=running ledgerRows=0 | after task=failed terminal=true retryAt=null attempts=2 errorCode=bot_not_ready
```

**逐条结论**

1. **工具已执行、结果未落盘**：真 SIGKILL 之后账本停在 `started`；重启先 `recoverInterrupted` 再 `opLedger.sealStarted()`（启动即把遗留 `started` 封成 `unknown`），任务是 `recovery`，账本只有一行、handler 没有第二次执行。这一条是「崩溃不重复执行」的直接证据。
2. **产物已写、状态未提交**：产物留在 `pending-commit`，任务不假装 `completed`（落 `recovery`），扫描把它计为 `pending` 而不是 `committed`。没有出现「状态完成但产物没落」，也没有出现「产物已确认但任务状态没提交」。注意 `reconciled=0`：此刻任务 `result` 里没有产物引用，扫描正确地**不**做幂等关联，只记 pending 等 TTL——这正是「宁可不合并，也不猜」。
3. **W5 窗口**：审批记录已落盘、任务还没进 `waiting_approval`，重启的双向对账把任务推回等待态（`reconciled=1`、`dangling=0`），任务不悬空、审批不丢失。结论是确定的「推回等待态」，不是「靠事件重放碰运气」。
4. **正常执行中途崩溃（只读工具）**：任务离开 `running`，落到终态 `failed`。**这条有偏离**：本沙箱没有可用模型，重启后的续跑走不到「模型成功返回」，最终以 `bot_not_ready` 明确失败收口。所以这里证明的是「不悬空、有确定去向」，**没有**证明「续跑完成」。

### 10.3 这套注入能证明什么、不能证明什么

**能证明**
- 进程内状态（Promise 链、内存里的任务对象、未 flush 的结果）在真 SIGKILL 后确实丢失，而磁盘上的账本/产物/审批记录能作为唯一事实来源把状态收敛到确定态。
- 「handler 已执行、结果未落账本」这种最危险窗口下，重启不会重跑 handler（账本行数不变且为 `unknown`）。
- 四个窗口的收敛结果是可重复的（见 10.4），不是一次性偶然。

**不能证明（仍标「未验证」）**
- **断电级磁盘一致性**：SIGKILL 只杀进程，页缓存仍由 OS 正常回刷；没有测掉电 / 内核崩溃 / 磁盘写坏。`writeFileAtomicSync` 的 `fsync` 顺序在真实掉电下是否成立，本段没有证据。
- **多进程 / 多机并发**：所有用例都是单进程写入，`BLUEBIRD_ALLOW_MULTI=1` 或两个实例共享数据目录时的并发写、租约竞争、账本互相覆盖，全部未验证。
- **模型路径的续跑完成**：c4 只能在无模型沙箱里落到 `failed`，带真实模型的「中断后自动续跑并完成」没有演练。

### 10.4 稳定性（本机连续 3 次）

三次均为 `tests 4 / pass 4 / fail 0 / skipped 0`、`EXIT 0`，逐用例输出与 10.2 完全一致（c1 `sealed=1 handlerRerun=false`、c2 `pending=1`、c3 `reconciled=1 dangling=0`、c4 `failed/bot_not_ready`）。用例本身没有 `skip` 分支，CI 环境若不支持子进程 SIGKILL 也只能整条 fail，不会静默通过。

### 10.5 本段计数

本段新增 1 个测试文件 `tests/agent-crash-injection.test.js`（4 个用例，`node:test`，runner 逐文件执行），计数由基线派生：

- 文件：77 → **78**
- 后端用例：2107 → **2111**（node:test 222 不变 + 自建 runner 1885 → 1889）
- runner 条目：70 → **71**（其中 `node:test` 文件 30 → 31）
- 前端不变：22 套 / 188 项

### 10.6 全量回归与五门禁（2026-11-04，本机）

| 项 | EXIT | 关键输出 |
| --- | --- | --- |
| `node scripts/run-tests.js` | 0 | `78 个测试文件，全部通过`；`p5-c1`–`p5-c4` 四条实测行与 10.2 一致 |
| `npx tsc --noEmit` | 0 | 无输出 |
| `npx expo lint` | 0 | 无输出 |
| `node scripts/verify-test-coverage.js` | 0 | `backend=2111/2111 nodeSuite=222/222 runner=1889/1889`；`frontend=188/188 suites=22/22 failed=0`；`CI runner 覆盖：78/78` |
| `node scripts/sync-doc-counts.js --check` | 0 | `backend 2111、nodeSuite 222、runner 1889、frontend 188、文件 78` |
| `node scripts/verify-api-capabilities.js` | 0 | `后端路由 95 条、路由族 20 个、仅 API 的能力 9 个` |

### 10.7 仍未验证的边界（照旧）

- 断电级磁盘一致性（本段只有 SIGKILL）。
- 多进程 / 多机并发写同一数据目录。
- 带真实模型的「崩溃后自动续跑完成」（c4 只到 `failed/bot_not_ready`）。

## 十一、Workflow Store 实体化方案（只出方案，不含实现）

### 11.1 结论先行

1. **存法**：新建独立文件 `DATA_DIR/agents/agent-workflows.json`，单实例锁下的单写者、每次变更一次原子写。不塞进 `agent-tasks.json`，也不做「一计划一文件」。
2. **请求级 plan 现在不是执行计划**：它是按意图选出的「上下文加载模板」（纯函数、无请求级状态）。可持久化的只有它的**决策字段**；检索结果、摘要正文、prompt、token 计数、trace 都不落盘。
3. **`planId/planVersion` 恒为 null 的原因**：S8 只预埋了字段、读取归一化与注释，没有任何模块产出过「计划」这个实体；任务创建的唯一入口 `router.createTask` 只写 route/budget。接上之后：`planId` 是一条计划血缘的稳定 id，`planVersion` 是该血缘里被任务**冻结**的那一版（正整数、单调、不复用）。
4. **与 checkpoint 不打架**：checkpoint 是「这次跑到哪」（任务内、可变、序号 +1）；plan 是「要做什么」（任务外、不可变、按版本追加）。恢复只读 plan 定意图、checkpoint 只当遥测，两者都不参与幂等键。
5. **最大设计风险**：把 `planVersion` 变成第二个并发口径（和 `stateVersion` 抢「谁是最新」），或允许原地改计划让老任务读到被改过的内容。抑制手段见 11.7。

### 11.2 请求级 plan 的真实形状

生成处：[orchestrator.js](file:///C:/Users/Administrator/Documents/Qoder/2026-10-27/975cfd2c/Bluebird/server/context/orchestrator.js#L75-L193) `planForIntent`；入口 [orchestrator.js](file:///C:/Users/Administrator/Documents/Qoder/2026-10-27/975cfd2c/Bluebird/server/context/orchestrator.js#L195-L210) `planContext`；消费处 [engine.js](file:///C:/Users/Administrator/Documents/Qoder/2026-10-27/975cfd2c/Bluebird/server/context/engine.js#L103-L149)。

| 字段 | 来源 | 性质 | 是否落盘 |
| --- | --- | --- | --- |
| `intent` | L75-L193（`INTENTS` 枚举） | 决策事实 | 是 |
| `enabled` | L195-L210 | 决策事实 | 是 |
| `layers` | L61-L73（8 个子字段） | 决策事实（不是数据） | 是 |
| `budgets.history` | L87-L95 等 | 决策事实（数字） | 是 |
| `budgets.retrieval` | L109-L114 等 | 决策事实 | 是 |
| `budgets.knowledge` | L128 等 | 决策事实 | 是 |
| `noAnswerThreshold` | L96 等 | 决策事实 | 是 |
| `reasons[]` | L97 等（短字符串） | 审计标签 | 是 |
| `applyPlanToConfig` 的派生 config | L212-L223 | 派生值，可重算 | 否 |
| 记忆/文档/网页命中正文与分数 | retriever 与 engine 内 | 一次性检索结果 | **否** |
| 摘要文本、conflicts、sources | [engine.js](file:///C:/Users/Administrator/Documents/Qoder/2026-10-27/975cfd2c/Bluebird/server/context/engine.js#L151-L169) | 一次性上下文 | **否** |
| 拼装后的 prompt / modelMessage / 图片渲染 | [engine.js](file:///C:/Users/Administrator/Documents/Qoder/2026-10-27/975cfd2c/Bluebird/server/context/engine.js#L129-L149) | token 级中间态 | **否** |
| `trace.recordOrchestration(plan)` | [engine.js](file:///C:/Users/Administrator/Documents/Qoder/2026-10-27/975cfd2c/Bluebird/server/context/engine.js#L124-L127) | 可观测性 | **否**（trace 随响应，不是任务事实） |

**结论**：整块序列化是错的——真正需要跨重启复现的只有「用哪套策略」，而不是「检索到了什么」。计划文档只装左列的决策字段。

补充：`runContextRuntime` 已经接受 `plan` 覆盖参数（[engine.js](file:///C:/Users/Administrator/Documents/Qoder/2026-10-27/975cfd2c/Bluebird/server/context/engine.js#L117-L120)），接上计划时**不需要改签名**（推断：现有调用方是否都传 `null` 需在实施时核对一遍）。

### 11.3 `planId` / `planVersion`：为什么是 null，接上后是什么

现状证据：

- 创建时写 `null`：[tasks.js](file:///C:/Users/Administrator/Documents/Qoder/2026-10-27/975cfd2c/Bluebird/server/agents/tasks.js#L652-L656)。
- 回读把非法值归一成 `null`：[tasks.js](file:///C:/Users/Administrator/Documents/Qoder/2026-10-27/975cfd2c/Bluebird/server/agents/tasks.js#L398-L401)。
- 旧数据补 `null`：[task-store.js](file:///C:/Users/Administrator/Documents/Qoder/2026-10-27/975cfd2c/Bluebird/server/agents/task-store.js#L63-L64)。
- 契约注释明确它既不是 checkpoint 序号也不是 CAS 版本：[contract.js](file:///C:/Users/Administrator/Documents/Qoder/2026-10-27/975cfd2c/Bluebird/server/agents/contract.js#L1-L8)。
- 唯一读者是 fail-open 的 `actionScope.planVersion` 比对：[failopen-policy.js](file:///C:/Users/Administrator/Documents/Qoder/2026-10-27/975cfd2c/Bluebird/server/agents/failopen-policy.js#L393-L394)，而该判定尚未接执行器。

**为什么没人写**：不存在「计划」这个实体——`classifyIntent` + `planForIntent` 是确定性映射，同一 goal 永远得到同一模板；任务创建链路（[router.js](file:///C:/Users/Administrator/Documents/Qoder/2026-10-27/975cfd2c/Bluebird/server/agents/router.js#L482-L506)）只有 route/budget，没有 plan 概念。字段是 S8 预留，不是遗漏。

**接上之后的语义边界**：

| 字段 | 语义 | 谁能写 | 何时写 |
| --- | --- | --- | --- |
| `planId` | `plan_<uuid>`，一条计划血缘的稳定 id；跨版本不变 | 仅 `workflow-store` 在创建血缘时分配，`router.createTask` 把它写进任务 | 任务创建那一次（`stateVersion` 同一笔写入） |
| `planVersion` | 正整数，该血缘中**被任务冻结**的版本号；单调递增，不复用，不回退 | 仅 `workflow-store.appendVersion` 分配；任务侧只复制，不能自增 | 同上；未来重规划时由服务端再次分配并写入新指针 |

- 任务侧**永不**从 `headVersion` 现场取值；只认 `(planId, planVersion)` 这一对。
- `planVersion` 不参与 CAS、不参与幂等键、不参与 checkpoint 序号；详见 11.7。
- fail-open 的 `actionScope.planVersion` 必须与 `task.planVersion` 同源；本段**不接执行器**，只把这条约定写下来。

### 11.4 计划与 checkpoint 的关系

| 维度 | checkpoint | plan |
| --- | --- | --- |
| 归属 | 任务记录内字段（[tasks.js](file:///C:/Users/Administrator/Documents/Qoder/2026-10-27/975cfd2c/Bluebird/server/agents/tasks.js#L660)、L664-L666） | 独立 Store（新文件） |
| 可变性 | 每轮覆盖，`checkpointVersion` +1（L1134-L1141） | 不可变，只追加新版本 |
| 生命周期 | 随重试推进/重置 | 跨重试、跨重启不变（任务冻结） |
| 用途 | 进度遥测（round/toolCalls/phase/at） | 意图、预算、步骤、允许工具快照 |
| 幂等 | 不参与（P2 已明确否掉位置量，[op-ledger.js](file:///C:/Users/Administrator/Documents/Qoder/2026-10-27/975cfd2c/Bluebird/server/agents/op-ledger.js#L177-L178)） | 不参与（opKey 仍是内容寻址） |
| 恢复时怎么用 | 只读作遥测；缺失不影响正确性 | 必须先解析成功，否则任务不进调度 |

**不打架的三条硬规则**：

1. 两个 `version` 各自只有一个写者：`checkpointVersion` 只由 `recordCheckpoint` 写（L775-L780 已强制），`planVersion` 只由 `workflow-store` 写。任何交叉写入视为缺陷。
2. 两者都不出现在 `expectedVersion`（CAS）里；CAS 只有 `stateVersion`（见 11.7）。
3. 恢复判定只依赖 plan 的存在性与内容 digest，不依赖 checkpoint 的数值；checkpoint 与 plan 不一致时**不改任务状态**，只记事件（推断：当前没有这种一致性校验，新增也只做观测）。

### 11.5 存哪：三个选项与取舍

| 维度 | A. 复用 `agent-tasks.json` | B. 独立单文件 `agent-workflows.json` | C. 一计划一文件 |
| --- | --- | --- | --- |
| 写放大 | 任务每次状态写入都会重写整份任务文件（现状如此），计划会被顺带重写约 15–25 次/任务（推断：按现有状态迁移与 checkpoint 次数估算） | 只在创建/重规划时写，约 1–2 次/任务 | 每版本一次小写，最优 |
| 原子性 | 与任务同一次原子写，看似更强 | 单文件内多版本+引用一次原子写；跨文件靠写序（计划先于任务） | 跨文件多方写入，无事务，最弱 |
| 恢复速度 | 启动只读 1 个文件 | 启动多读 1 个小文件（上限 8 MB） | 需目录扫描 + 逐文件读，最慢 |
| 容量治理 | 受 `TASK_MAX=500`（[tasks.js](file:///C:/Users/Administrator/Documents/Qoder/2026-10-27/975cfd2c/Bluebird/server/agents/tasks.js#L35)）与终态裁剪影响：**任务被裁掉，计划跟着消失** | 可独立 pin/裁剪，任务存活期不受任务上限影响 | 可独立裁剪 |
| 回滚 | 改任务 schema，回滚需还原 | 删新文件即回到现状 | 删目录即回到现状 |
| 结论 | 不选 | **选** | 不选 |

**为什么选 B**：计划的写入频率远低于任务状态（前者 1–2 次/任务，后者每次迁移与每轮 checkpoint 一次），独立文件能把写放大从「随任务写入次数」降到「随计划变更次数」；同时避开 `TASK_MAX` 裁剪误删仍在运行任务的计划。C 选项虽然写放大最小，但恢复要目录扫描、且跨版本/引用没有单文件原子性，对「恢复速度优先」不利。

### 11.6 Store 形状

```json
{
  "schemaVersion": 1,
  "plans": {
    "plan_xxx": {
      "planId": "plan_xxx",
      "headVersion": 2,
      "createdAt": "…",
      "updatedAt": "…",
      "versions": {
        "1": { "version": 1, "digest": "sha256:…", "createdAt": "…", "plan": { "…": "…" } },
        "2": { "version": 2, "digest": "sha256:…", "createdAt": "…", "plan": { "…": "…" } }
      }
    }
  },
  "refs": { "task_yyy": { "planId": "plan_xxx", "planVersion": 2, "pinnedAt": "…" } }
}
```

- `plan` 内部字段：`{ intent, enabled, layers, budgets, noAnswerThreshold, reasons, steps[], allowedTools[], budget, goalDigest }`。
- `steps[]` 元素：`{ stepKey, toolName, argsDigest, label }`；`stepKey` 与 P2 的内容寻址同源（`sha256([toolName, canonicalArgs, override||''])`），**不带 ordinal**——位置量不参与身份，避免重排或重试后漂移。
- `refs` 是反向引用：既用于 pin（防裁剪），也用于孤儿计划识别。任务终态 + 投递完成后解除引用。

### 11.7 版本语义

- **+1 时机**：`appendVersion` 每次写入新内容（创建、重规划、以及「回退」）→ `headVersion+1`，同时写一条不可变版本。
- **唯一写者**：只有 `workflow-store` 模块能写这个文件；`router` 只调用它，不直接改文件。启动恢复是只读。
- **能否回退**：不支持原地回退。回退 = 追加一个「内容等于旧版」的**新版本**（版本号仍 +1），任务指针改到新版本，历史版本不动。这样磁盘上永远没有「同一个版本号对应两份内容」。
- **与 `stateVersion` 的关系**：`stateVersion` 是任务记录的 CAS 并发令牌（每次任务写入 +1，只有存储层分配，调用方用 `expectedVersion` 声明基版，见 [tasks.js](file:///C:/Users/Administrator/Documents/Qoder/2026-10-27/975cfd2c/Bluebird/server/agents/tasks.js#L667-L669)）；`planVersion` 是**内容版本**，不参与乐观锁、不参与冲突重试。铁律：**同一时刻只有一个并发口径**——任务写入用 `stateVersion`；计划侧冲突一律按「版本不存在」处理（→ `recovery`），不覆盖、不重试。
- **不允许两个口径交叉**：计划解析绝不比对 `headVersion` 来判断「是否最新」；任务 CAS 绝不看 `planVersion`。会出现「两套并发口径互相打架」的唯一写法，就是拿 `planVersion` 当 expectedVersion（明确禁止）。

### 11.8 任务如何引用、改计划后怎么办

- 任务持 `planId + planVersion` 在创建时一次性冻结，与 `stateVersion` 同一笔写入，**不拆成两次**。
- 计划被改（追加新版本）后：**旧任务继续按旧版本跑**，不 fail-closed。理由：计划的不可变性就是为了让「老任务 + 新策略」不产生悄然改变的行为；fail-closed 只有在冻结版本**读不出来**时使用（11.9）。
- 重规划入口：本段**不新增 HTTP 路由**，因此重规划只能内部触发（且仅允许 `queued`/`retrying` 状态；`running`/`waiting_approval` 拒绝，因为审批决定基于旧计划）。本段只实现「创建时冻结」，「重规划」列为后续段（未实现）。

### 11.9 恢复路径

启动顺序在现有第六步之前插一步（不改变既有顺序）：加载 plan store → 对每个 `planId != null` 的任务解析 `(planId, planVersion)` → 失败即收敛，**在进入调度之前**完成。

| 情况 | 判定 | 落点（现有词表，不新增状态） | 是否重试 |
| --- | --- | --- | --- |
| 计划缺失（`plans[planId]` 不存在） | `plan_missing` | 任务 `recovery` + `errorCode = plan_missing` | 否，等人工 |
| 版本不符（`versions[planVersion]` 不存在或 > head） | `plan_version_mismatch` | 任务 `recovery` + `plan_version_mismatch` | 否 |
| 内容损坏（schema 校验失败 / digest 不匹配） | `plan_corrupt` | 任务 `recovery` + `plan_corrupt` | 否 |
| 任务 `planId = null`（存量任务） | 无计划 | 维持 P1–P5 现状，不新增行为 | 现状既有规则 |
| Store 文件整体不可解析 | `plan_store_corrupted` | 所有引用任务 → `recovery`；**服务继续启动** | 否 |

- 与任务 Store 的策略差异：任务文件损坏现状是直接退出（`agent_tasks_corrupted`），计划文件损坏只影响引用它的任务，因此**不重建、不退出**——因为计划不是副作用的真值来源，退出会把无关任务一起拖死。
- 任务保留 `planId/planVersion` 原值，供人工追溯；不清空指针（清空等于丢失现场）。

### 11.10 裁剪与上限（A/B 两类）

定义：**A 类 = 硬上限**，超过即拒绝落盘、任务不创建（fail-closed）；**B 类 = 软上限**，超过先裁剪未引用条目，仍超再拒绝。

| 类别 | 项 | 数值 | 超限处理 |
| --- | --- | --- | --- |
| A | 单份计划快照（序列化 UTF-8） | ≤ 8 KB | 拒绝，`plan_too_large`；任务不创建 |
| A | `steps` 条数 | ≤ 32 | 拒绝，`plan_step_limit` |
| A | 单个 step（`toolName`+`argsDigest`+`label`） | ≤ 1 KB；`toolName` ≤ 64 字符、`label` ≤ 200 字符 | 拒绝 |
| A | `planId` 长度 / `planVersion` 取值 | ≤ 80 字符 / 正整数 | 拒绝 |
| A | 必填字段与 `digest` | 必须齐全且一致 | 拒绝 |
| B | 每条计划保留版本数 | ≤ 10（最旧且未被引用的先淘汰） | 裁剪 + 审计一行 |
| B | 计划总数 | ≤ 2000 | 淘汰「全部版本未被引用且超 7 天」 |
| B | Store 文件体积 | ≤ 8 MB | 先做 B 类裁剪；仍超则拒绝新计划（`plan_store_full`，A 类兜底） |
| B | 孤儿计划（无任务引用） | TTL 24h | 启动扫描清理 |
| B | 解除引用后的版本 | TTL 7 天（与 op-ledger / orphan 同口径；A 类待校准） | 启动扫描清理 |

- **Pin 规则**：被非终态任务引用的版本**永不裁剪**；裁剪顺序只从「未被引用 + 最旧」开始。
- **不选外部引用**（把大计划放 artifact store 再挂 id）：计划必须在恢复路径上零依赖读取，而 artifact store 有 5000 条上限与 168h TTL，会在任务还活着时把计划删掉。若未来确实需要 >8 KB，再走「artifact 引用 + digest」（推断：届时需重新评估读取依赖，本段不做）。

### 11.11 两个半截状态与注入点

**写序不变量**：计划必须**先** durably 落盘（`writeFileAtomicSync` 返回），再调用 `createTask` 写指针。任何时刻不允许「任务已引用尚未落盘的计划」。

| 半截状态 | 怎么产生 | 后果 | 收敛 |
| --- | --- | --- | --- |
| S1 计划已落盘、任务未创建 | 真崩溃在两写之间 | 无任务在跑；磁盘多一份无主计划 | 无害；启动扫描记 `orphan`，24h 后清理（不删除刚创建的，避免和「正在创建」竞争） |
| S2 任务已引用、计划不存在 | 正常写序**产生不了**；只可能来自外部改文件、裁剪越界、磁盘损坏 | 任务不能执行 | 启动解析 → `recovery` + `plan_missing`，不调度、不重试 |
| S3 新版本已落盘、任务指针未更新（重规划窗口，后续段） | 崩溃 | 任务仍指旧版本，旧版本有效 | 无需处理，安全 |
| S4 指针已更新、目标版本缺失 | 仅当裁剪与写入竞争（单实例下不应发生） | 任务不可执行 | 同 S2 |

注入方式：

- S1 用真 SIGKILL：新增钩子点 `plan.after-save`（在 `appendVersion` 落盘后、`createTask` 前），沿用 P5 的 marker + `Atomics.wait` 机制，父进程见 marker 后 `SIGKILL`。重启断言：任务不存在、计划存在、扫描记 `orphan`。
- S2 **不能用 SIGKILL 制造**（写序保证不会出现），只能「构造态」：手工写一个 `planId` 指向不存在血缘的任务文件，再跑启动恢复，断言 `recovery/plan_missing`。报告里必须如实标注这条是构造态，不是真崩溃。

### 11.12 实施计划（3 个可独立回滚的提交）

| 提交 | 内容 | 做完能验证什么 | 回滚方式 |
| --- | --- | --- | --- |
| C1 `feat(agents): add the workflow store` | 新增 `server/agents/workflow-store.js` + `tests/agent-workflow-store.test.js`（约 12 例：schema/digest/不可变/版本 +1/回退=新版本/A 类拒绝/B 类裁剪/pin/损坏读取） | Store 自身不变量成立；**不接线**，对现有行为零影响 | 删模块与测试 |
| C2 `feat(agents): bind tasks to frozen plan versions` | `router.createTask` 前 `appendVersion`，任务写 `planId/planVersion`；`initializeTaskQueue` 增加解析步骤与三种异常收敛 + `tests/agent-workflow-binding.test.js`（约 6 例） | 新任务带冻结指针；缺失/错版/损坏三类都落 `recovery` + 既有 errorCode | 去掉接线，任务回到 null（存量兼容） |
| C3 `test(agents): crash-inject the workflow half-states` | S1 真 SIGKILL 1 例 + S2 构造态 1 例；计数同步；文档补「实跑结果」小节 | 半截状态收敛有原始输出 | 删测试与新钩子点 |

每步都跑全量回归 + 五门禁 + 计数同步。估算（推断）：Store ~210 行、接线 ~70 行、测试 ~260 行、文档 ~110 行，合计约 650 行。

### 11.13 边界与风险

**明确不做**

- 不做 Worker Pool、Blackboard、`sourceAuthority`/`trustLevel`、动态组队、图检测上限。
- 不改任务状态词表与 `state-machine.js` 迁移表；不改 `routes.js`、`sessions.js`。
- 不新增 HTTP 路由；因此**重规划入口本段不做**（只做创建时冻结）。
- 不接 fail-open 执行器（`actionScope.planVersion` 仍是死代码）。
- 不改 P1–P5 已有语义；存量 `planId=null` 任务行为完全不变。

**风险**

1. **双口径**（最高）：任何把 `planVersion` 拿去做 CAS/expectedVersion 的写法都会制造两套并发语义。约束见 11.7，评审时以此为准。
2. **裁剪误删 → recovery 风暴**：若 pin 失效，批量任务会同时进 `recovery`。缓解：只按 `refs` 判定 pin，裁剪前二次核对引用；上限触顶时先拒绝新计划而不是删旧引用。
3. **计划与代码演化**：模板字段将来变了，旧计划仍要能读。缓解：`schemaVersion` 固定、digest 只校验不改写、旧版本按自身字段解释，不做跨版本迁移（推断：确需迁移时另开一节）。
4. **单实例假设**：`BLUEBIRD_ALLOW_MULTI=1` 绕过锁后，plan store 变成多写者，head 可能被覆盖。本段沿用既有假设，不解决，继续标「未验证」。

**本段交付**：仅设计文档这一节，无代码改动。

### 11.14 C1–C3 实施与实跑结果（2026-11-04）

三个提交全部落地：

| 提交 | 内容 | 用例 |
| --- | --- | --- |
| C1 | `server/agents/workflow-store.js`（约 800 行）、`tests/agent-workflow-store.test.js` | 13 |
| C2 | `router.js` 写序 + `tasks.js` 计划指针/`forcePlanRecovery` + `runtime.js` 启动解析、`tests/agent-workflow-binding.test.js` | 8 |
| C3 | `plan.after-save` 钩子、`tests/helpers/crash-child.js` 两个场景、`tests/agent-workflow-crash.test.js` | 2 |

计数从 78 文件 / 2111 项变为 **81 文件 / 2134 项**（`backendTotal` 2134、`runnerTotal` 1912，`nodeTestSuiteTotal` 与 `frontend` 不变）。五门禁全部 EXIT 0。

#### 六条硬要求 ↔ 证据

1. **写序**：`tests/agent-workflow-binding.test.js` 用例 1 在 `createTask` 里先 `getVersion`，读不到计划就直接失败；用例 3 让 `createTask` 抛 `agent_task_limit`，断言只剩孤儿计划、没有反向悬空引用。
2. **硬上限**：单计划 >8 KB、steps >32、单 step >1 KB 在写盘前抛 `plan_too_large` / `plan_step_limit` / `plan_step_too_large`；用例 2 断言拒绝后任务数为 0、计划文件不存在、Store 字节不变。
3. **Store 损坏 fail-closed**：用例 4 把 `agent-workflows.json` 写成非 JSON，绑定任务（queued）与引用不存在血缘的任务全部 `recovery/plan_store_corrupted`，未绑定的存量任务仍 `queued`。已终态任务不反转（状态机终态无出边），计 `skippedTerminal` 且仍占 pin。
4. **裁剪三重校验**：用例 8/9/10 覆盖版本上限只淘汰未引用最旧版、已终态任务的 pin 不裁、`liveRefs`（任务文件现场扫描）同样防裁；用例 11 用 `auditOnly` 演示「审计已提交、删除未执行」，证明审计先写后删。
5. **两套版本互不污染**：用例 6 断言追加计划版本不改任务 `stateVersion`、状态迁移不改 `planVersion`/`headVersion`，且拿 `planVersion` 当 `expectedVersion` 必冲突。
6. **存量兼容**：用例 7 断言 `planId=null` 任务 `checked=0`、状态与 `stateVersion` 一字不动；用例 8 断言单边指针被 `createTask` 拒绝。

#### S1 真 SIGKILL（`plan.after-save`）三次实跑

注入方式与 P5 一致：`BLUEBIRD_TEST_CRASH_HOOK=plan.after-save`，钩子先同步写 marker 再 `Atomics.wait`；父进程只在 marker 出现后发 SIGKILL。计划文件此时已由 `writeFileAtomicSync` fsync 落盘，任务尚未创建。

```
[c3-c5] atKill task=none plans=1 versions=1 refs=0 | after tasks=0 plans=1 refs=0 checked=0 storeCorrupted=false
[c3-c6] constructed=true dangling=recovery/plan_missing control=queued refs=1
ℹ pass 2  ℹ fail 0
```

三次运行输出逐字一致（pass 2 / fail 0 / EXIT 0）。结论：崩溃点只留下**一份可读的孤儿计划**与**零个任务指针**；重启后没有任何任务引用了不存在的计划，孤儿计划按 24h TTL 清理。

#### 这条能证明什么、不能证明什么

- 能证明：进程内状态丢失后，已 fsync 的计划不会丢、任务不会带悬空指针；构造态下的悬空引用会被 fail-closed。
- 不能证明（照旧「未验证」）：断电级磁盘一致性（只测进程被杀，没测掉电/写缓存丢失）；多进程并发写（`BLUEBIRD_ALLOW_MULTI=1` 下 Store 仍是单写者 read-modify-write）；8 MB Store 体积上限的拒绝路径（需要 2000 条计划，未做单测）。
- **偏离说明**：要求原文是「所有引用它的任务一律 recovery」。已终态任务（`completed`/`failed`/`cancelled`/`timed_out`/`recovery`）在现有状态机里没有出边，改回 `recovery` 既非法也会改写历史结论，因此实现为「非终态一律 recovery，终态保持原状并继续占 pin（不裁）」。这一点在用例 4 中显式断言。

### 11.15 收口补全 A/B/C 实施结果（2026-11-04）

三个独立提交，各自跑过全量回归 + 五门禁：

| 提交 | 内容 | 新增用例 |
| --- | --- | --- |
| `1984e7e` `feat(agents): make artifact content replayable` | 产物正文落盘 + 复读校验 + 版本链 + 256 KB 上限 | `tests/agent-artifact-content.test.js` 5 |
| `71f1de5` `feat(agents): schedule orphan cleanup` | 孤儿清理挂启动 + 6h 周期 + 防重入 + 失败容忍 | `tests/agent-orphan-scheduler.test.js` 6 |
| `4f681c7` `feat(agents): enforce the fail-open policy in the tool path` | fail-open 判定接入 `executeToolCall` + 任务冻结作用域 | `tests/agent-failopen-enforcement.test.js` 6 |

计数：81 文件 / 2134 项 → **84 文件 / 2151 项**（`backendTotal` 2151、`runnerTotal` 1929、`runnerFiles` 77；`nodeTestSuiteTotal` 222 与 `frontend` 188 不变）。

```
84/84 个测试文件全部通过（npm test，EXIT 0）
EXIT_tsc=0  EXIT_lint=0  EXIT_cov=0  EXIT_sync=0  EXIT_api=0
backend=2151/2151  nodeSuite=222/222  runner=1929/1929  frontend=188/188
```

#### A. 产物内容与版本链

**实施前盘点**（本段最重要的结论：内容原本**没有**落盘）：

- `persist()` 只把 `content` 归一化后算 `sha256`，随后丢弃正文，[artifact-store.js](file:///C:/Users/Administrator/Documents/Qoder/2026-10-27/975cfd2c/Bluebird/server/agents/artifact-store.js#L280-L300) 只落 `{id,kind,version,contentHash,…}` 元数据。
- 正文当时唯一的存在形式是**任务结果 JSON 里的引用**（`result.artifacts[] = {kind,id,version}`），也就是「正文留在产出方」——产出方进程退出后不可复读。
- 大小上限：当时**没有任何正文体积限制**；只有条数上限 `ARTIFACT_MAX = 5000` 与审计 `AUDIT_MAX = 500`。

**实施后**：

1. 正文一产物一文件：`data/agents/artifact-contents/<id>.json`，`writeContent()` 在写索引**之前**落盘（[artifact-store.js](file:///C:/Users/Administrator/Documents/Qoder/2026-10-27/975cfd2c/Bluebird/server/agents/artifact-store.js#L165-L186)）。先正文后索引：最坏只留一个无人引用的正文文件；反过来会得到「索引指向读不回来的正文」。
2. 复读：`readContent(id,{version})` 校验 `id`/`version`/结构/`contentHash`，任一不符抛 `artifact_content_corrupted`；文件缺失抛 `artifact_content_missing`（[artifact-store.js](file:///C:/Users/Administrator/Documents/Qoder/2026-10-27/975cfd2c/Bluebird/server/agents/artifact-store.js#L188-L250)）。**从不返回空内容**。
3. 提交门禁也校验可读：`assertRefsCommitReady()` 除状态/版本外还调用 `readContent`（[artifact-store.js](file:///C:/Users/Administrator/Documents/Qoder/2026-10-27/975cfd2c/Bluebird/server/agents/artifact-store.js#L404-L430)）——「索引对但正文读不回来」不允许提交为完成。
4. 版本链：`version+1`、旧版 `superseded` + `supersededBy` 且保留；引用冻结（id 由 `(taskId,kind,contentHash)` 派生，新版本是新 id，老引用不漂移）。`versionsOf()` 返回全链（[artifact-store.js](file:///C:/Users/Administrator/Documents/Qoder/2026-10-27/975cfd2c/Bluebird/server/agents/artifact-store.js#L252-L262)）。
5. 上限：`CONTENT_MAX_BYTES = 256 KB`，**A 类**（安全默认值，待实测校准）。超限在写盘前抛 `artifact_content_too_large`，不截断、不留记录、不写正文文件（[artifact-store.js](file:///C:/Users/Administrator/Documents/Qoder/2026-10-27/975cfd2c/Bluebird/server/agents/artifact-store.js#L280-L292)）。**B 类**（如需 >256 KB 的大产物）当前**只支持显式拒绝**，外部引用未实现。

用例 [agent-artifact-content.test.js](file:///C:/Users/Administrator/Documents/Qoder/2026-10-27/975cfd2c/Bluebird/tests/agent-artifact-content.test.js) 5 例：复读 + hash（含丢模块实例后重读）、损坏 fail-closed（读取与提交门禁双拒）、版本链保留旧版且老引用冻结、已终态任务引用的版本不被清理、超限拒绝（含正好 256 KB 可落盘）。

```
✔ 正文超过 256 KB 显式拒绝：不留记录、不写正文文件
ℹ tests 5  ℹ pass 5  ℹ fail 0
```

#### B. 孤儿清理挂生产调度

- `server/agents/orphan-scheduler.js`：启动跑一次 + 周期跑，**默认 6 小时（A 类）**，`BLUEBIRD_AGENT_ARTIFACT_CLEANUP_INTERVAL_MS` 可覆盖（0 = 只跑启动清理）。
- 单实例防重入：`inFlight` 标记，上一轮没结束就跳过本轮，计入 `skipped`（[orphan-scheduler.js](file:///C:/Users/Administrator/Documents/Qoder/2026-10-27/975cfd2c/Bluebird/server/agents/orphan-scheduler.js#L53-L90)）。
- 失败容忍：捕获 → `failures+1` / `lastError` → `logger.warn` → 下一轮照常；不向启动流程或定时器冒泡。
- 挂载点：`runtime.initializeTaskQueue()` 在 `scanPendingCommits()` 之后，进程内单例、`start()` 幂等（[runtime.js](file:///C:/Users/Administrator/Documents/Qoder/2026-10-27/975cfd2c/Bluebird/server/agents/runtime.js#L1060-L1120)）。
- 清理逻辑本身未改：三重校验（重扫引用、终态任务 pin、审计先写后删）仍是 `artifactCommit.cleanupOrphans` 原实现。
- **明确不声称**：① 进程崩溃/停机期间漏掉的周期**不补跑**，重启只多跑一次启动清理；② 定时器基于 `setTimeout`，机器休眠/长任务会让实际间隔大于配置值，**不承诺准时**；③ 多进程部署下每个进程各跑一份（单实例假设不变）。

用例 [agent-orphan-scheduler.test.js](file:///C:/Users/Administrator/Documents/Qoder/2026-10-27/975cfd2c/Bluebird/tests/agent-orphan-scheduler.test.js) 6 例：默认 6h、启动 + 周期（假定时器，不真等）、重入保护、失败不崩且下一轮照常、不补跑、TTL 差 1ms 不删 / 正好到期才删。

```
✔ TTL 边界：差一毫秒不删，正好到期才删
ℹ tests 6  ℹ pass 6  ℹ fail 0
```

#### C. fail-open 接真实执行器

- 判定接在 `executeToolCall` 内、**handler 调用之前**（[agent-runtime.js](file:///C:/Users/Administrator/Documents/Qoder/2026-10-27/975cfd2c/Bluebird/server/agent-runtime.js#L541-L567)）：未命中 → 返回 `failopen_denied`、`executed:false`，handler 调用计数不变；命中 → 继续执行，`evaluate()` 已写审计（含 `policyVersion`）。
- 作用域来自**任务记录冻结的 `planId/planVersion`**（[runtime.js](file:///C:/Users/Administrator/Documents/Qoder/2026-10-27/975cfd2c/Bluebird/server/agents/runtime.js#L797-L809)）；`actionMatches` 的 `planVersion` 分支（[failopen-policy.js](file:///C:/Users/Administrator/Documents/Qoder/2026-10-27/975cfd2c/Bluebird/server/agents/failopen-policy.js#L391-L397)）因此**不再是死代码**：计划版本不符就不命中。
- 老记录缺 `planId/planVersion` → `failopen_scope_incomplete` 拒绝（fail-closed），不当作「无计划继续跑」。
- R2/R3：风险等级由服务端工具定义推导（`read→R0`、`reversible_write→R1`、`high_risk→R3`），`evaluate` 在匹配前直接 `risk_not_allowed`；入口再映射为 `approval_required`——**命中 allowlist 也不执行、不绕过审批**。
- 登记方式：工具需显式 `failOpenEligible: true`（[agent-runtime.js](file:///C:/Users/Administrator/Documents/Qoder/2026-10-27/975cfd2c/Bluebird/server/agent-runtime.js#L169-L180)），默认 false。**当前没有任何内置工具登记**：现有工具本来就不等人工审批，若全局接管，「没有策略」会变成「全部拒绝」，那是改 P1–P5 语义的产品决策。机制在真实路径上可执行、有调用计数断言，但**没有生产工具在用**——这条必须如实标出。

用例 [agent-failopen-enforcement.test.js](file:///C:/Users/Administrator/Documents/Qoder/2026-10-27/975cfd2c/Bluebird/tests/agent-failopen-enforcement.test.js) 6 例：命中放行且 handler 真被调用、未命中拒绝且计数 0、撤销后拒绝、老记录缺字段拒绝、R3 命中白名单仍 `approval_required`、未登记工具行为不变。

```
✔ 未登记 failOpenEligible 的工具行为完全不变
ℹ tests 6  ℹ pass 6  ℹ fail 0
```

#### 本段的偏离、推断与未验证

**偏离**

1. A 的提交门禁新增「正文可读」校验（要求只写了「复读要校验」）。后果：升级前落盘的历史产物（没有正文文件）再次提交/解析会被判 `artifact_content_missing`。这是 fail-closed 的必然结果，但**没有写迁移脚本**；生产升级需一次性补正文，或接受这批产物不可提交。
2. C 的接管范围做成「按工具显式登记」而非「所有有副作用工具一律判定」。理由同上：全局接管会把现有写入工具在「无策略」状态下全部变成拒绝，属于改 P1–P5 语义。**推断**：需求原意是「预授权动作」而不是「所有写入」，故按登记制落地。

**推断**

1. 6 小时清理周期与 256 KB 正文上限均为 A 类默认值，未做容量实测（真实产物分布未知）。
2. `environment = BLUEBIRD_ENV || 'dev'`、`resource = bot:<botId>`、`subject = 任务投影 userId` 是「最小可用作用域」，策略配置必须与这三个维度对齐。

**未验证**

1. 断电级磁盘一致性：正文/索引沿用 `writeFileAtomicSync`，但没做掉电测试（与 P5 同一条边界）。
2. 多进程：调度器、正文目录、策略判定都假设单写者；`BLUEBIRD_ALLOW_MULTI=1` 下会出现多进程各清一份、策略 `uses` 计数竞争。
3. superseded 正文的无限增长：本段只保证「不删」，没有保留期/归档策略（产品决策）。
4. 真实模型环境下的 fail-open 命中率与误拒率：单测用构造策略，未接真实策略库与真实流量。

