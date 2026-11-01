# Agent Runtime 二期：Worker Runtime 与 Session 隔离

状态：已实现（2026-11-01），分支 `qoder/agent-runtime-stage2-2026-11-01`（基于一期，未合并）。
范围：Notion《Bluebird 下一代 Agent Runtime》「阶段 2：Worker Runtime 与 Session 隔离」。
配套代码：`server/agents/runtime.js`、`server/agents/context-projection.js`、`server/agents/worker-result.js`、`server/agents/tool-gateway.js`、`server/agents/sessions.js`、`server/agents/tasks.js`、`server/agent-runtime.js`。

## 1. 目标与非目标

**目标**：把 Worker 从「被调用的 Bot 逻辑」升级为遵循统一协议的执行单元——固定生命周期、独立 `runId`、明确的会话归属、按需上下文投影、统一工具权限网关、可观测的心跳与 checkpoint、统一结果 schema。

**本期不做**：进程隔离 / 远程 Worker（执行器仍是同进程内的 `execute()` 边界）；checkpoint 不用于恢复被中断的模型回合（恢复属于阶段 3）；不引入分布式队列、租约或进程外 Watchdog（阶段 3/4）。

## 2. 架构决策记录（ADR）

### ADR-01：单次执行 = 一个 runId + 一条可验证的生命周期

- **决策**：每次 `runTask` 生成 `run_<uuid>`，写入任务并由执行器复用；生命周期固定为
  `accepted → running →（checkpoint / heartbeat）* → completed | failed | cancelled | timed_out`。
  `waiting_approval` 是暂停态，由审批执行器收尾。
- **checkpoint**：在每个模型轮开始与每次工具结果后写入 `task.checkpoint`（round / toolCalls / phase / at），并发 `worker.checkpoint` 事件。它是**协作式进度标记**，不是可恢复快照。
- **心跳**：运行期间每 `BLUEBIRD_AGENT_HEARTBEAT_MS`（默认 5000，下限 20）刷新 `task.heartbeatAt` 并写 `worker.heartbeat` 事件；只证明执行器存活，不携带内容。
- **理由**：阶段 3 需要可靠的恢复/租约接口，先把「活着 / 跑到哪一步 / 为什么结束」变成持久事实。

### ADR-02：Worker Session 有 owner、作用域和生命周期

- **决策**：Bot 会话新增 `scope`（`direct` / `worker`）、`owner`（`agentId` / `taskId` / `runId` / `attachedAt`）、`lifecycle`（`active` / `running` / 终态 / `closed` / 时间点 / 关闭原因）。
  - 路由创建的任务会话标记 `scope=worker`，任务创建后绑定 owner；
  - Worker 启动时再次校验：已归属**其他未终态任务**的会话直接失败（`worker_session_owner_mismatch`），不读取、不写入；
  - 原任务已终态时允许顺序复用（显式 `allowTakeover`），避免 API 调用方传回旧会话后永久不可用；
  - 任务终态后会话标记同一状态并写 `closedAt`，记录保留供审计。
- **隔离保证**：Worker 只通过 `projectWorkerContext()` 拿到自己的任务数据；没有会话读取 API、没有会话存储句柄，也不复制其他 Worker 或主控的历史。旧会话读取时补齐为 `scope=direct` / `owner=null` / `lifecycle=active`。

### ADR-03：上下文按需投影

- **决策**：Worker 输入固定为 `[system prompt, 一条任务指令]` 两条消息；指令只含任务类型、目标、必要上下文、`contextRef`、允许工具与输出要求。
- `memoryScopeSessionId` 仍指向父主控会话（记忆读写 scope），`userText` 优先取 `parentUserText`（主控用户原话）用于写入接地。
- **明确不做**：不复制主会话历史、不预取记忆、不把工具结果串成跨任务缓存。投影函数是纯函数，便于单测与审计。

### ADR-04：工具权限网关先于执行

- **决策**：每次工具调用先过 `createToolAuthorizer({ allowedTools })`：
  - 工具不在任务 `allowedTools` → `task_tool_denied`；
  - Agent Policy 为 `answer_only` 或策略白名单不含该工具 → `policy_tool_denied`。
- 拒绝发生在参数校验与 handler 之前；Worker 写 `tool.denied` 审计事件（只含工具名与短码）。
- 既有策略检查与高风险确认仍保留；网关只收窄，不放大权限。

## 3. 统一结果 schema

终态（`completed` / `failed` / `cancelled` / `timed_out`）统一落库为：

| 字段 | 说明 |
| --- | --- |
| `status` | 终态之一 |
| `summary` | 结果摘要；失败/取消/超时为空串 |
| `artifacts` | 产物引用列表 `{kind,id}`（本期为空，阶段 2 预留） |
| `evidence` | 证据引用 `{kind,id}` |
| `toolSteps` | 工具步骤 `{name,ok,summary,durationMs}` |
| `changes` | 变更 `{kind,id,decision}` |
| `requiresConfirmation` / `requiresApproval` | 同值；需要人工确认 |
| `errorCode` | 受控错误码 |
| `rounds` / `stopReason` | 模型轮次与停止原因 |
| `model` | 实际使用的 provider/model |
| `runId` / `finishedAt` | 本次运行与结束时间 |

审批执行器也使用同一 schema，不再出现 `result: null` 的终态。

## 4. 任务与事件变更

- 任务新增运行期字段（非 Task Contract 字段）：`runId`、`runStartedAt`、`heartbeatAt`、`checkpoint`；旧任务读取时补 `null`，运行开始时若缺少 Worker 会话则创建并回填。
- 新事件类型：`worker.checkpoint`、`worker.heartbeat`、`tool.denied`；payload 仅安全标量（轮次、工具数、阶段、工具名、短码）。
- `cancelTask` 现在写入统一的 `cancelled` 结果再投递，不再投递 `result: null`。

## 5. 预算与硬上限

| 维度 | 上限来源 |
| --- | --- |
| 轮数 | 任务 `budget.maxRounds`（fast=3 / slow=4，路由时快照） |
| 工具调用次数 | 任务 `budget.maxToolCalls`（默认 6） |
| Token | 每次模型调用 `maxTokens`（Bot 配置，128–4000），总上限 ≤ 轮数 × 单次上限 |
| 超时 | 任务 `deadlineMs`（5000–120000）+ Provider `timeoutMs` |
| 并发 | 全局 `BLUEBIRD_AGENT_TASK_CONCURRENCY`（1–4）+ Manifest `concurrencyLimit`（路由降级标记） |

## 6. 迁移与回滚

- **会话数据**：旧会话读取时补齐 `scope/owner/lifecycle`，不影响既有消息与列表查询。
- **任务数据**：运行期字段可缺省；没有 Worker 会话的旧任务在第一次运行时自动补建。
- **回滚**：回退本期提交即可；新增字段为追加式，旧代码忽略它们。已写下的结果 schema 旧代码仍能读取 `summary/toolSteps/evidence/changes`。

## 7. 测试证据（2026-11-01 实跑）

| 命令 | 结果 |
| --- | --- |
| `node tests/agent-worker.test.js` | 26 项通过（投影 / 结果 schema / 网关 / 会话归属 / runId·心跳·checkpoint / 取消·超时·模型失败终态 / 并发隔离 / 异常隔离） |
| `node tests/agent-dispatch.test.js` | 10 项通过 |
| `node tests/agent-router.test.js` | 48 项通过 |
| `node tests/memory-bot.test.js` | 9 项通过（含审批闭环与任务取消） |
| `node tests/memory-maintenance.test.js` | 5 项通过 |
| `node tests/agent-tools.test.js` | 127 项通过 |
| `node tests/agent-runtime-guards.test.js` | 4 项通过 |

全量门禁（2026-11-01 实跑）：

| 命令 | 结果 |
| --- | --- |
| `npm test` | 53 个测试文件，全部通过 |
| `node scripts/verify-test-coverage.js` | `backend=1696/1696 nodeSuite=221/221 runner=1475/1475`；`frontend=179/179 suites=22/22 failed=0`；`CI runner 覆盖 53/53` |
| `node scripts/sync-doc-counts.js --check` | 文档计数与基线一致（53 文件 / 1696 项） |
| `node scripts/verify-api-capabilities.js` | 93 条路由、19 个路由族、9 个仅 API 能力，登记一致 |
| `npx tsc --noEmit` | 通过 |
| `npm run lint` | 通过 |

一次已知偶发：全量首轮 `memory-bot` 的「直接对话」用例出现一次 `model_failed`，日志只有 `[agent-request]` 没有 `[agent-response]`；该文件单独连跑 3 次、全量复跑均通过。这与 `REPAIR_ROADMAP.md` §6.7 记录的既有偶发形态一致，**根因仍未定位**，不宣称已修复。测试与门禁均使用临时 `BLUEBIRD_DATA_DIR`，运行后仓库内未生成 `server/data`。

## 8. 未做与下一阶段依赖

- checkpoint 只记录进度，不恢复模型回合上下文；恢复策略、租约与 outbox 幂等增强属于阶段 3；
- 执行器仍是同进程逻辑隔离，`execute()` 是未来替换为子进程/远程 Worker 的边界；
- 心跳目前由运行中的进程自己写；进程外监控与自愈属于阶段 4；
- `artifacts` 字段已预留但本期不产生产物；
- 审批暂停期间 Worker 会话标记为 `closed`，审批完成后由审批执行器写回终态。
