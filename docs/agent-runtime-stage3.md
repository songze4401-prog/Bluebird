# Agent Runtime 三期：Task State 持久化与恢复

状态：已实现（2026-11-01），分支 `qoder/agent-runtime-stage3-2026-11-01`（基于二期，未合并）。
范围：Notion《Bluebird 下一代 Agent Runtime》「阶段 3：Session / Task State 持久化与恢复」。
配套代码：`server/agents/state-machine.js`、`server/agents/task-store.js`、`server/agents/tasks.js`、`server/agents/runtime.js`、`server/agents/worker-result.js`、`server/agents/result-delivery.js`。

## 1. 目标与非目标

**目标**：把任务状态从「进程内调度 + JSON 文件」升级为可恢复、可审计的状态机——合法迁移唯一、租约防双执行、失败有退避重试、进程被杀后可判定恢复、恢复结果绝不凭空成功。

**本期不做**：多进程 Worker 执行（仍由启动单实例锁保证单写者）；checkpoint 不恢复模型回合上下文；不做进程外 Watchdog（阶段 4）。

## 2. 架构决策记录（ADR）

### ADR-01：状态机是唯一事实来源，新增 `uncertain`

- **决策**：`server/agents/state-machine.js` 声明全部合法迁移；`tasks.updateTask` 在状态变化前调用 `assertTransition`，非法迁移直接 `invalid_transition`（409）。
- **主链路**：`queued → accepted → running → waiting_approval → completed`；失败/取消/超时从 `queued/accepted/running/waiting_approval` 收口；`completed/failed/cancelled/timed_out/uncertain` 是终态，不能再迁移。
- **`uncertain`（恢复中间态）**：进程中断时无法判断副作用是否已发生的任务进入该状态，`requiresReview=true`，永不自动执行、永不当作成功。
- **重试**：只读任务遇到 `model_connection` / `model_rate_limit` / `model_timeout` 且未超过 `maxAttempts` 时回到 `queued` 并写 `retryAt`（1s × attempt，上限 30s）；写任务不自动重试。

### ADR-02：Store 接口与 schema v2

- **决策**：`server/agents/task-store.js` 是任务持久化的唯一入口：`read()` / `write()` / `migrate()`；业务层不碰文件名与 JSON 结构。
- **当前实现**：单机原子文件（`writeFileAtomicSync`），由启动单实例锁保证单写者；替换 SQLite/PostgreSQL 时保持同一接口。
- **schema 迁移**：v1（基础任务）→ v2（run / checkpoint / lease / 重试元数据），读取时补齐并尽力回写；重复读取幂等；未知版本或损坏结构报 `agent_tasks_corrupted`。
- **备份/恢复演练**：Agent 数据位于 `<DATA_DIR>/agents/`，现有 `scripts/bluebird-backup.js` 递归包含该目录；但 `scripts/bluebird-restore-drill.js` 目前只校验 sessions / memory / emotion / persona，**尚未校验 agent task store**——这是本期已知缺口，恢复演练需手动核对 `agent-tasks.json` 的结构与计数。

### ADR-03：租约、心跳、运行历史与 checkpoint 版本

- **租约**：任务执行前 `acquireLease(ownerId, ttl)`；`ownerId = <pid>:<进程实例 id>`。同一任务的有效租约属于其他 owner 时拒绝执行（`task_lease_held`）；心跳每 `HEARTBEAT_MS` 续约，续约失败（`task_lease_lost`）立即中止并显式失败；终态释放租约。
- **新增字段**：`lease{ownerId,acquiredAt,expiresAt,heartbeatAt}`、`retryAt`、`lastErrorCode`、`checkpointVersion`、`runs[]`（最近 5 次 run 的起止/状态/错误码）；保留 `runId` / `runStartedAt` / `heartbeatAt` / `checkpoint`。
- **checkpoint**：每次写入递增 `checkpointVersion`；只记录进度，不用于恢复模型回合。

### ADR-04：启动恢复按幂等性分流

`tasks.recoverInterrupted({ownerId})`：

| 情形 | 结果 |
| --- | --- |
| `waiting_approval` | 保持暂停，不自动执行 |
| `accepted/running` + 租约由其他未过期 owner 持有（传入 ownerId 时） | 保持 `running`，计入 `leftRunning` |
| `accepted/running` + 只读任务 | 重新 `queued`，写 `recoveredAt` / `lastErrorCode=recovered_after_restart` |
| `accepted/running` + 含写工具（`memory_remember`） | 标记 `uncertain`、`requiresReview=true`、统一结果 `status=uncertain`，并随启动补投递 |

单进程部署启动时调用 `recoverInterrupted({ownerId:null})`：进程内不存在存活的其他 Worker，旧租约一律视为过期。恢复后先 `recoverPending()` 再调度队列，保证"终态但未投递"的结果补齐一次。

### ADR-05：幂等语义与多进程边界

- **结果投递**：消息 id 固定 `bot-result-<taskId>`，重复调用 / 重复恢复只产生一条消息；投递状态持久化在任务上。
- **事件**：沿用持久 outbox（先写 outbox 再写主事件文件）。
- **多进程**：本期不启用多进程 Worker。`server/single-instance.js` 在启动时保证同一数据目录只有一个服务实例；租约在数据层面阻止同一任务被两个执行者同时持有。启用多进程前必须把 Store 换成具备事务能力的实现（SQLite/PostgreSQL）或引入真正的单写者/文件锁——这是阶段 4 的前置条件。

## 3. 健康与恢复接口

- `tasks.healthSnapshot(now)`：`schemaVersion`、按状态计数、`oldestQueuedAt`、`retryScheduled`、`expiredLeases`、`checkedAt`；只含计数与时间点，不含任务正文。
- `runtime.getQueueStats()` 在原有 `concurrency/active/queued` 基础上新增 `health`，供 Watchdog/运维读取。
- 恢复事件：`task.recovered`（重排队）、`task.uncertain`（需人工处理）。

## 4. 迁移与回滚

- **数据迁移**：任务文件 v1→v2 自动完成；旧字段 `botId/sessionId` 继续保留为兼容别名。
- **回滚**：回退本期提交即可。v2 文件对旧代码表现为额外字段（旧代码只读已知字段），不会阻断启动；如需彻底回滚数据，可删除 `lease/retryAt/lastErrorCode/checkpointVersion/runs` 并保留基础任务字段。
- **运维**：`uncertain` 任务需人工核对副作用；重跑前应先确认 `memory_remember` 是否已落库，避免重复写入。

## 5. 测试证据（2026-11-01 实跑）

| 命令 | 结果 |
| --- | --- |
| `node tests/agent-recovery.test.js` | 26 项通过（状态机 / 迁移 / 租约 / 重试 / checkpoint 版本 / 运行历史 / 恢复分流 / SIGKILL 故障注入 / 投递幂等与崩溃补投 / 存储故障） |
| `node tests/agent-worker.test.js` | 26 项通过（含 lease 获取与释放、checkpointVersion、run 历史） |
| `node tests/agent-dispatch.test.js` | 10 项通过 |
| `node tests/agent-router.test.js` | 48 项通过 |
| `node tests/memory-bot.test.js` | 9 项通过（含重启恢复） |

全量门禁（2026-11-01 实跑）：

| 命令 | 结果 |
| --- | --- |
| `npm test` | 54 个测试文件，全部通过 |
| `node scripts/verify-test-coverage.js` | `backend=1722/1722 nodeSuite=221/221 runner=1501/1501`；`frontend=179/179 suites=22/22 failed=0`；`CI runner 覆盖 54/54` |
| `node scripts/sync-doc-counts.js --check` | 文档计数与基线一致（54 文件 / 1722 项） |
| `node scripts/verify-api-capabilities.js` | 93 条路由、19 个路由族、9 个仅 API 能力，登记一致 |
| `npx tsc --noEmit` | 通过 |
| `npm run lint` | 通过 |

测试与门禁均使用临时 `BLUEBIRD_DATA_DIR`，运行后仓库内未生成 `server/data`。

## 6. 未做与下一阶段依赖

- checkpoint 不恢复模型回合；按模型回合续跑仍不可用。
- 多进程 Worker 未启用；Store 仍是单写者原子文件，事务能力与迁移演练的自动化留给阶段 4 前置工作。
- 进程外 Watchdog、受控自愈、故障演练报告属于阶段 4；本期只提供健康快照与恢复接口。
- `uncertain` 任务没有自动复核工具，需人工处理。
- agent task store 的自动恢复演练尚未接入 `bluebird-restore-drill.js`（备份已递归覆盖目录，但演练未校验任务文件）。
