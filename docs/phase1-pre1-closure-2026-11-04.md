# Phase 1 前置收官记录（2026-11-04）

分支：`phase1/protocol-convergence-2026-11-03`（未合并、未开 PR、未触碰 `main`）。
范围：只记录 Phase 1 四个前置（① 协议收敛、② CAS 与冲突、③ 产物与完成提交、④ 审批时限与 fail-open）的完成度、证据与缺口；**不含 Phase 1 本体实现**。
结论先行：四个前置的实现与回归均已落地；`docs/v1.3-decisions-and-verification-checklist-2026-11-03.md` §42 的 **25 项验收仍为 0/25 勾选**，本文件只登记证据缺口，不为凑数打勾。

## 实测快照（2026-11-04）

| 项 | 结果 | 来源 |
| --- | --- | --- |
| 全量回归 | **74 个测试文件全部通过，0 失败，EXIT 0** | `node scripts/run-tests.js`（与 CI 同一套 `tests/*.test.js`，逐文件独立子进程、临时数据目录、`DEEPSEEK_API_KEY=''`） |
| 用例总数 | **2075**（node:test 222 + 自建 runner 1853） | 同批文件的运行期计数，与 `verify-test-coverage` 的 `backend 2075/2075`、`nodeSuite 222/222`、`runner 1853/1853` 一致 |
| 前端单测 | 188/188（22 suites） | `verify-test-coverage` 输出 |
| 五门禁终态 | 5/5 EXIT 0 | 见下表 |

五门禁终态快照（顺序执行）：

| 门禁 | EXIT | 关键输出 |
| --- | --- | --- |
| `npx tsc --noEmit` | 0 | 无输出（无类型错误） |
| `npx expo lint` | 0 | 无输出（无告警） |
| `node scripts/verify-test-coverage.js` | 0 | `backend=2075/2075 nodeSuite=222/222 runner=1853/1853`；`frontend=188/188 suites=22/22 failed=0`；`✔ 测试覆盖验证通过` |
| `node scripts/sync-doc-counts.js --check` | 0 | `✔ 文档计数与基线一致：backend 2075、nodeSuite 222、runner 1853、frontend 188、文件 74` |
| `node scripts/verify-api-capabilities.js` | 0 | `✔ API 能力登记一致：后端路由 95 条、路由族 20 个、仅 API 的能力 9 个` |

## 一、四个前置对照表

| 前置 | 提交 | 核心改动（一句话） | 证据位置 | 明确未完成部分 |
| --- | --- | --- | --- | --- |
| **① 协议收敛** | `6b03183`、`4dab3e3`、`8da8a89`、`d94e09d`、`30d5ce7`、`ae26a87`、`339d5f7`、`8f08807`、`946c5af`、`bbca1b2`、`7c28a2b` | 十态词表单点导出、状态写入收口到 `transitionTask`、`retrying`/`recovery` 转正、Session 生命周期由任务状态投影、版本字段单一来源、预留可空计划指针 | `tests/agent-recovery.test.js`：`状态机：recovery 是终态，只能由中间态进入`、`重试：retrying 为正式状态，退避到期后由队列直接取走`、`恢复：可能产生副作用的任务标记 recovery 等待人工处理`；`tests/agent-approval-policy.test.js` 的 `b`、`c`（S6b 资源期限）；`tests/agent-router.test.js`：`契约校验：deadlineMs 越界被拒绝`；实施记录见 [pre1 log](phase1-pre1-protocol-convergence-log-2026-11-03.md) S1–S9 | Workflow Store 未实现：`planId` / `planVersion` 恒 `null`，没有 plan→task 映射与迁移表；Token / Run 总预算不存在；① 本身未做 CAS（已由 ② 补） |
| **② CAS 与冲突** | `288730a`、`381ca88` | 任务存储引入 `stateVersion` + `expectedVersion` 乐观并发，冲突返回明确契约且不覆盖前者数据 | `tests/agent-recovery.test.js`：`CAS：同一 expectedVersion 的两个写者，后者 conflict 且前者数据保留`、`CAS：冲突后重读并用最新版本重试成功，版本单调递增`、`CAS：不传 expectedVersion 的既有调用保持可写`；说明见 [AGENTS.md](../AGENTS.md)（`381ca88`） | 只覆盖任务存储；Blackboard / 产物存储无 CAS；`ConflictRecord` 未持久化；仍为单写者原子文件，多进程并发不安全 |
| **③ 产物与完成提交** | `6204f06`、`35b6a09` | 产物先落盘，引用随终态同次写入；`pending-commit` → 扫描标记 `orphan`，超 TTL 物理清理；引用提交幂等（`refCount` 不重复累加） | `tests/agent-artifact-commit.test.js`：`a`（正常完成 + `stateVersion` 递增）、`b`（写失败不进 `completed`）、`c`（pending-commit → orphan → 幂等重关联）、`d`（幂等）、`f`（既有完成路径不变）、`g`（已提交产物不删）；契约变化见 [pre1 log](phase1-pre1-protocol-convergence-log-2026-11-03.md) C1 | 只有引用 `{kind, id, version}`，**没有产物内容与版本链**（A-03/A-13 的证据仍缺）；`cleanupOrphans` 只是模块能力，未挂生产调度；提交意图（Outbox）未实现，跨 Store 恢复仍缺 |
| **④ 审批时限与 fail-open** | `c8283ca` | 审批记录扩 `riskLevel`/`expiresAt`/`escalationAt`/`policyVersion`，老记录 `execute` fail-closed；R2 到期只标 `overdue` 并留事件、状态仍 `pending`；R3 无自动批准超时；资源期限独立计时；fail-open 七字段策略表 + 版本冻结 + 撤销 + 审计 | `tests/agent-approval-policy.test.js` 的 `a`–`g`；本会话独立临时目录探针 8 项全 PASS（老记录缺字段 → `approval_policy_missing`、任务仍 `waiting_approval`；R2 到期 → `pending` + `overdue`、`execute` 以 `approval_not_approved` 拒绝）；策略与数值表见 [pre1 log](phase1-pre1-protocol-convergence-log-2026-11-03.md) C2 | fail-open 判定**未接任何工具执行器**（命中白名单不会改变实际执行路径）；R2 升级**未接通知渠道**；审批状态枚举仍是 `pending/approved/rejected/executing/completed/failed`，v1.3 §29 的 `expired/escalated/cancelled` 未采用；批量与申诉未实现 |

## 二、未打勾清单（25 项验收，勾选 0 项）

勾选口径：按 v1.3 §42 的要求「实现 + 用例/评测证据」双满足才可勾。四个前置只覆盖了其中一部分条款，且多为止于「有实现、缺全量验证」或「只有文档」。以下全部保持**未勾选**，逐条写明缺口。

| 编号 | 条款要点 | 为什么未勾（证据缺口） |
| --- | --- | --- |
| A-01 | 计划版本迁移覆盖 plan/task 映射、运行中节点、产物复用、副作用补偿 | 只有文档与可空指针；Workflow Store、迁移表、fencing token 均未实现，无迁移用例 |
| A-02 | Blackboard CAS、版本裁决与冲突处理 | ② 只做了任务存储 CAS；Blackboard 不存在，`ConflictRecord` 未持久化 |
| A-03 | 两个 Store 的事实权威与跨 Store 恢复 | ③ 有 orphan 扫描，但无提交意图 / Outbox，也无「产物写成功、状态提交失败」的双 Store 注入测试 |
| A-04 | 冲突裁决权、证据顺序、升级路径 | 未编码冲突等级与裁决顺序，无五类冲突用例 |
| A-05 | `trustLevel` 仅由验证层写入 | 字段与单写者 API 均未实现（④ 边界明确排除） |
| A-06 | 风险分级验证、成本与质量指标 | ④ 有 `riskLevel` 记录字段，但没有 R0–R3 路由规则，也没有漏检率/误拦截率指标 |
| A-07 | Benchmark 基线可复现、holdout 与轮换 | 无基线配置 schema、无评测集版本管理 |
| A-08 | 审批超时、批量、升级、申诉 | ④ 只做了单条审批的 SLA 与 overdue 标记；批量、申诉、改判均无 |
| A-09 | provenance / taint 贯穿 Task、Artifact、Gateway | 三处字段与 Gateway 校验均未实现 |
| A-10 | 失败模式清单与 Artifact 环检测 | 无 9 类失败模式监控、无图环检测 |
| A-11 | 规划/审批/验证延迟纳入 SLO，有停止重规划判据 | 无 SLO 埋点、无停止判据 |
| A-12 | 组件预算、stub 边界、Owner 角色 | §41 责任人未签署，属管理评审，无记录 |
| A-13 | 端到端 worked example | 无可执行示例与全流程 trace |
| A-14 | Phase 0 降级分支与退出条件 | 分支开关与退出判据未实现，无 B/C/E 演练记录 |
| B-01 | 六类错误码及 `retryable` 进入统一 Result / Error Contract | 有统一结果 schema 用例（`tests/agent-worker.test.js`：`结果 schema：completed 含全部稳定字段`、`failed / cancelled / timed_out 保留状态与错误码`），但六类枚举与可选 `causeRef` 未逐条覆盖，契约测试不完整 |
| B-02 | Gateway 不负责重试决策 | 未做静态检查，也无「Gateway 重试尝试被拒」用例；④ 未触碰该路径 |
| B-03 | `retrying`/`recovery` 为正式状态，且仅 Engine 可写 | 两态与迁移用例已有（`tests/agent-recovery.test.js:85`、`:237`），但「仅 Engine 可写」的写权限校验未实现 |
| B-04 | 迁移表、前置条件、`expectedStateVersion`、非法迁移审计可测 | 有迁移表与 CAS 用例，但未做到「全迁移边覆盖」，非法迁移审计事件未验证 |
| B-05 | 委派深度 2、单 Task 重规划 2 次、单 Run 重试 3 次有服务端硬限制 | 委派深度有 `tests/agent-dispatch.test.js` 覆盖；重规划/重试硬限未逐条覆盖，且重试默认值见数值台账（默认 1、上限 3） |
| B-06 | Task Token hard budget 原子计量，Run 总预算为额外闸门 | 预算体系不存在；只有 `deadlineMs` 单一期限 |
| B-07 | 限流、熔断、重规划风暴抑制有配置、状态与测试 | 有 watchdog 熔断策略（`server/agents/watchdog-policy.js`），但无四维限流与风暴压测报告 |
| B-08 | `trustLevel` 四档枚举与唯一写入者落到服务端 | 同 A-05，未实现 |
| B-09 | `ConflictRecord` 可序列化、持久化、可审计 | 未实现；② 的冲突只返回错误，不落冲突记录 |
| B-10 | R2 30 分钟转人工 fail-closed；R3 只接受显式批准 | ④ 已实现并有 `a`/`b`/`g` 用例，但 fail-open 未接执行器、R2 无通知渠道；「转人工」目前只到事件层，未闭环到人工处理路径 |
| B-11 | 审批请求有持久化 SLA、提醒、升级、取消，不会静默永久挂起 | 六态未采用；提醒/升级任务/取消路径均未实现，R3 长期 `pending` 属设计允许但无提醒机制 |

统计：**0/25 勾选**；其中 5 项（B-01、B-03、B-04、B-05、B-10）具备部分实现与用例证据，但仍因上表缺口不勾。

## 三、遗留冲突与待办

1. **§37/§38 编号错位**：orphan / `pending-commit` TTL 的正文在 v1.3 **§38**，不是 §37；实际取值 **168 小时（7 天）**，属 **A 类**。代码落点为 `server/agents/artifact-commit.js` 顶部注释与 `DEFAULT_ORPHAN_TTL_MS`。本次只在记录中标注，未改原文。
2. **`artifacts` 契约变化**：`task.result.artifacts` 由恒为 `[]` 变为至少一条 `{kind: 'message', version: 1}`。已作为 **C1** 记录在 [pre1 log](phase1-pre1-protocol-convergence-log-2026-11-03.md)；消费者侧 `lib/api/types.ts` 已补可选字段，`components/TasksPanel.tsx` 不读取该字段。未改 v1.3 正文与 ADR。
3. **fail-open 只有判定，没有执行**：`server/agents/failopen-policy.js` 的 `evaluate()` 只在 `approvals.js` 用于取 `currentPolicyVersion`；**未接任何工具执行器**。命中白名单当前不会改变实际执行路径，因此「放行」仍只是判定结果。
4. **R2 转人工未接通知渠道**：到期只写 `overdue` 标记与 `approval.escalated` / `approval.overdue` 事件；没有站内通知、邮件或工单。R3 长期 `pending` 同样没有提醒。
5. **`server/index.js` 启动日志多一个字段**：`approvalsOverdue` 计数（`c8283ca` 引入，`server/index.js` 约 4025 行）。属日志可观测性，不是新事件类型、不是新路由。
6. **审批状态枚举未收敛**：`approvals.js` 的 `STATUSES` 仍是 `pending/approved/rejected/executing/completed/failed`；v1.3 §29 目标的 `expired/escalated/cancelled` 未落地，④ 用 `overdue` 布尔标记替代。
7. **存储仍为单写者原子文件**：多进程 Worker / 分布式部署前，需要事务型 Store 或文件锁；当前 CAS 只在单进程内有效。
8. **R2 计时器是进程内的**：`deadlineTimers` 为内存 `setTimeout`，持久语义依赖记录里的 `expiresAt` 与到期扫描；重启补标记路径本轮未单独验证（标「未验证」）。

## 四、数值参数台账

分类口径：**A 类**＝先给安全默认值、待实测校准；**B 类**＝必须压测后才能定生产值。表内任何未压测数字**都不作为生产标准**。

| 参数 | 当前值 | 类别 | 来源 / 落点 | 是否留痕 |
| --- | --- | --- | --- | --- |
| R2 审批 SLA | 30 分钟 | **A** | v1.3 §36.2 + 用户 2026-11-03 裁决；`approvals.js` 的 `R2_SLA_MS` | 是：代码注释 + pre1 log 数值表 |
| R2 升级点 `escalationAt` | SLA 的 50%（15 分钟） | **A** | §32.3「由 deadline 派生」建议；`approvals.js` 的 `R2_ESCALATION_RATIO` | 是：代码注释 + pre1 log；**待实测校准** |
| fail-open 策略有效期上限 | 90 天（单次按 `validity` 更短者） | **A** | §36.2 已采纳安全默认；`failopen-policy.js` 的 `MAX_VALIDITY_MS` | 是：代码注释标 A |
| fail-open 审计保留条数 | 500 条 | **B** | 容量防膨胀上限，**未压测**；`failopen-policy.js` 的 `AUDIT_MAX` | 是：pre1 log 标 B |
| orphan / `pending-commit` TTL | 168 小时（7 天） | **A** | §38（编号错位见三-1）；`artifact-commit.js` 的 `DEFAULT_ORPHAN_TTL_MS` | 是：代码注释 |
| 审批记录容量 | 总 500 条 / `pending` 100 条 | **B** | 代码防御性上限，不在 v1.3 数值表内，**未压测**；`approvals.js` 的 `APPROVAL_MAX` / `PENDING_MAX` | 是：本表 |
| 单任务重试次数 `maxAttempts` | 默认 1，环境上限 3 | **A** | v1.3 §36.2 写「单 Run 重试 3 次（A）」；代码默认 1、上限 3，`tasks.js` | 部分：代码只有默认值，无注释；**口径需对齐**，未压测 |
| Task 期限 `deadlineMs` | 默认 60000 ms，允许 5000–120000 ms | **B** | v1.3 只规定全局硬上限（B，未定值）；`tasks.js` / `routing-config.js` 为局部默认 | 部分：局部常量，无数值表条目；未压测 |
| 循环轮次 `maxRounds` | fast 3 / slow 4，允许 2–5 | **A**（待校准） | `routing-config.js` 默认 profiles；`tasks.js` 校验 | 部分：代码默认值；与「单 Task 重规划 2 次」不是同一口径 |
| 工具调用上限 | `maxToolCalls` 6 / `maxReadOnlyRetries` 1 | **B** | `routing-config.js` 默认 profiles，**未压测** | 否：无 v1.3 条目、无注释说明 |
| Watchdog 健康阈值 | 心跳 30 s、租约 45 s、队列 50、最老排队 10 min、磁盘 200 MB | **B** | `watchdog-policy.js` 的 `DEFAULT_POLICY.thresholds`，**未压测** | 否：仅代码默认值 |
| Watchdog 熔断 | 窗口 10 min、尝试 3 次、冷却 60 s | **B** | `watchdog-policy.js` 的 `breaker`，**未压测** | 否：仅代码默认值 |

## 五、下一步入口（Phase 1 本体，只列入口，不动手）

起点应接在 ③ 的「提交意图 / 跨 Store 恢复」缺口上，顺序建议：

1. **持久化 Workflow Store**：定义 plan / task / artifact 引用的持久 schema 与 plan 版本迁移表（A-01），把当前恒为 `null` 的 `planId` / `planVersion` 接上真实来源。
2. **崩溃恢复**：以 `server/agents/artifact-commit.js` 的 `pending-commit → orphan` 扫描为雏形，补提交意图（Outbox）与双 Store 故障注入（A-03），明确恢复的所有权与幂等边界。
3. **幂等**：复用 `tasks.js` 的 `idempotencyKey` 与 `artifact-commit` 的引用幂等，扩到 Run / Tool 调用粒度；再引入 Task Token / Run 预算的原子计量（B-06）。

入口文件：`server/agents/runtime.js`、`server/agents/tasks.js`、`server/agents/task-store.js`、`server/agents/artifact-commit.js`；条款依据：v1.3 §11（五步完成提交）、§38（orphan 生命周期）、§42 A-01/A-03/B-06。

本轮**未开始**上述任何实现，也未合并、未开 PR、未触碰 `main`。
