# Orchestrator 提案现状映射（2026-11-13）

> 输入：Notion《Bluebird Agent Worker Orchestrator & Workers》（2026-11-13 版）。
> 本文只做一件事：把提案的每条主张对照仓库事实（`main` = `a0082b0`），标出「成立 / 有出入 / 缺口」，供立项书（`docs/orchestrator-charter-2026-11-13.md`）拆轮次使用。
> 取证方式：三路只读调研（聊天入口 / 编排底座 / 测试与验收面）+ 直接运行 `scripts/scan-notion-ledger.js --check`。行号以 `a0082b0` 为准，会漂移，动手前重新 grep。

## 1. 提案主张 × 仓库事实

| # | 提案主张 | 仓库事实 | 判定 |
| --- | --- | --- | --- |
| 1 | 「当前不是缺 Worker 底座，而是主聊天没有接上它」 | 主聊天 `/chat`（index.js:3274）与 `/chat/stream`（index.js:3578）走 `runAgentTurn` 单轮工具循环（注册表仅 4 工具，agent-runtime.js:223-227）；与 agent runtime 的唯一接缝是 `delegate_to_bot`，且只允许 `botId === 'memory'`（tool-dispatch-bot.js:33-35）；Worker 侧的审批/账本/作用域注入（`toolAuthorizer`/`failOpen`/`sideEffect`）主聊天全部不传（index.js:3375-3393） | **成立** |
| 2 | 「跨 Agent 任务图有硬限制」 | 见 §2 L1–L3、L6–L8 | **成立** |
| 3 | 「通用结果回传仍有硬限制」 | 父任务拿不到子任务结构化结果（runtime.js / result-delivery.js 无 parentTaskId 钩子，grep 零命中）；唯一自动回传 = `formatDelivery` 拼的中文文本进父会话（result-delivery.js:24-57、159-172）；上游产物不自动进入下游上下文（planner.js:189 只传 `input.context` 原文） | **成立** |
| 4 | 「应该复用现有 Runtime，绝不推倒重建」 | 执行内核（租约/fencing/预算/父子授权交集/两段提交/确定性验证/trustLevel）全部可原样复用；需要动的结构位集中在三处（§4 C1–C3），全部可版本位化 | **成立** |
| 5 | 「已有 agent-planner / agent-orchestrator / agent-workflow-\* / agent-worker / agent-recovery / agent-event-delivery 专项测试 + 九步 worked example」 | 测试文件全部在（合计 137 例）；一处名称出入：仓库没有 `server/agents/event-delivery.js`，等价物是 `result-delivery.js`（SSE `/agent-results/stream` + 事件 outbox 查询 `GET /agents/:botId/events`）；`tests/agent-event-delivery.test.js` 存在（4 例，outbox 幂等键与崩溃补投） | **成立（一处命名出入）** |
| 6 | 「九步 worked example 默认本地 Stub，证明链路不证明真实模型质量」 | 属实：in-process OpenAI 兼容 HTTP 桩（127.0.0.1 随机端口，`BLUEBIRD_ALLOW_PRIVATE_BASE_URL=1`）；真实模式走 LongCat、凭据从 `server/.env` 读（run-worked-example.js:29-42） | **成立** |
| 7 | 「必要时交独立 Reviewer 验证」 | 机制已存在：审校子任务是当前唯一服务端自动跨 Agent 建任务的点（verification-loop.js:433-510，`orchestrator.orchestrate({agentId:'reviewer'})` + 显式 `artifactStore.share`） | **成立（复用即可）** |
| 8 | 「主 Agent 是唯一发言者，Worker 不抢答」 | 与现状一致：Worker 结果只进父会话 `bot-result-<taskId>` 消息，`delegate_to_bot` 回执 `resultPending:true`（tool-dispatch-bot.js:151-164） | **成立** |

## 2. 硬限制清单（L1–L8）

- **L1 多 Agent DAG 入口拒绝**：`createTaskGraph` 要求全图同 Agent（orchestrator.js:232-238「依赖图节点必须属于同一 Agent」400）；`dependsOn` 两端必须同 agentId（tasks.js:1263-1269）。
- **L2 计划节点无执行者字段**：workflow-store `STEP_KEYS` 白名单 13 字段（`stepKey, toolName, argsDigest, label, goal, capability, taskType, dependsOn, schemaVersion, permissionScope, acceptanceDigest, maxAgeMs, dependsOnVersions`），无 agent/risk 字段，未知字段直接拒绝（workflow-store.js:86-101、266-270）。上限 MAX_STEPS=32、单 step 1024 字节、dependsOn≤8。
- **L3 规划器只会确定性模板**：planner.js 仅 2 个模板（`search_then_summarize` / `memory_search`），只产 `memory.search`/`memory.explain` 节点，不接模型；researcher/executor/reviewer 的能力没有任何规划路径会产出对应节点（planner.js:59-97、orchestrator.js:41-46）。
- **L4 主聊天无审批闸**：主聊天调 `runAgentTurn` 不传 `toolAuthorizer`/`failOpen`/`sideEffect`（index.js:3375-3393）；`high_risk` 工具一律 `confirmation_required`，注释明示「当前没有已授权的确认流程」（agent-runtime.js:500-512）。
- **L5 结果回传只有文本通道**：结构化 result（含 artifacts≤40 / evidence / changes）只存在子任务记录与内存 SSE `notify()`；落父会话的是格式化文本（result-delivery.js:24-57、159-172）；父任务侧无 parentTaskId 读取钩子。
- **L6 无 DAG 级调度**：调度器是全局并发拉取队列（`TASK_CONCURRENCY` 默认 2，夹 1..4，runtime.js:76-79、357-405）；不懂「同一父计划的一组子任务」波次概念；节点失败下游立即判死（`dependency_failed`，`neverStarted=true`，不进 running，tasks.js:2524-2623），无重派、无 fallback、无部分结果聚合。
- **L7 跨任务产物授权是手工单点**：产物默认只属生产任务；跨任务读需显式 `artifactStore.share(withTaskIds)` + scope token + 版本钉住（artifact-store.js:474-488、worker-scope.js:441-537，≤10 refs 默认拒绝）；自动共享只有审校链（verification-loop.js:491-495）与 `publishSharedConclusion`（artifact-commit.js:151-181）两处；**没有「DAG 下游自动继承上游产物读权」的原语**。
- **L8 Worker 不能再委派**：深度 ≤2（agent-limits.js:25）+ Worker 工具白名单无建任务工具（manifest.js:25-29）+ 委派环拒绝。提案「不是无限递归 Agent」与此一致，**保持不动**。

## 3. 可复用资产（原样不动）

| 资产 | 复用点 |
| --- | --- |
| `runtime.runTask` 执行内核 | 租约（60s TTL）、fencing 代次令牌、预算全额预留、两段提交、确定性验证、trustLevel 升档 |
| `router.decideInternal` 双匹配 | `acceptedTaskTypes ∩ capabilities` + routingPriority + atCapacity——PlanCompiler 用它解析执行者，**不信任模型给的 agent 名** |
| `approvals.createApproval` / `execute` | 任务迁 `waiting_approval` + fail-closed policy 四字段 + `approval-deadline` 超时收敛——发布节点直接复用 |
| `worker-scope` 令牌与投影 | `wst_` 令牌、≤10 refs、版本钉住、默认拒绝——Worker 上下文最小化已达标 |
| `result-delivery.deliverTaskOutcome` | 幂等（`bot-result-<taskId>` 去重 + 崩溃补投 + SSE `/agent-results/stream`）——根任务最终结果的唯一回传通道，不新造 |
| `risk-policy.assessRisk` 七因子 | 节点风险分级直接用（risk-policy-v1）；工具级 R3 抬审校语义已有 |
| `verification-loop.openReview` | 根任务 Reviewer 门复用（审校链已可跨 Agent 建任务） |
| `strategy-version` + `autonomy-policy` | 「默认关闭 + 版本位激活 + 灰度分桶」的姿态参照（p4-default / improvement:\*） |
| `scripts/run-worked-example.js` | in-process OpenAI 兼容桩 + 九步断言 + 运行记录落盘——十三步与真实模型轮的地基 |
| `eval-runner.runSuite` / `eval-metrics.computeMetrics` | 离线回归口径（成功率/返工/Token/延迟 + 安全计数） |

## 4. 与既有纪律的冲突点与处置

| # | 冲突 | 处置 |
| --- | --- | --- |
| C1 | `STEP_KEYS` 白名单 vs 节点需要执行者字段 | 扩 schema：加可选 `agentId` 字段，缺省=当前行为，旧计划零影响；版本位 `plan-schema-v2`；workflow-store 测试补「新字段接受 + 超限拒绝」边界 |
| C2 | `dependsOn` 同 Agent 约束 vs 跨 Agent DAG | 放宽为「带编排计划头的图允许跨 Agent 边」，仍保留环检测/委派深度/预算上界/父子授权交集全部不变；版本位 `dag-v1`；`agent-workflow-binding` 补跨 Agent 用例 |
| C3 | 主聊天直答路径 vs 编排接管 | 开关默认关（`agent-policy.orchestration.enabled=false`，复用既有 `GET/PUT /agent-policy` 面）；关闭时 `/chat` 行为零改动（同一代码路径直答）；开启时模型可携带计划块，服务端剥块→编译→派活，编译失败降级为直答并审计 `plan.rejected` |
| C4 | 台账口径 | 本提案不属于《自动记忆系统》台账的 A/B 行 → 新增 C 系列（见立项书 §5）；动手前先确认 `scan-notion-ledger.js` 对分节结构的假设 |

## 5. 结论

1. 复用方案可行，**执行内核零改动**；结构改动集中在 L1/L2 对应的 C1/C2 两处版本位，其余全部走复用与新增模块。
2. 提案「必要时交独立 Reviewer」= risk-policy 节点分级 + `openReview` 审校链，无新机制。
3. 「写完以后就不用动」的落法：所有新行为挂在默认关闭的开关与版本位后面；直答路径、memory 委派路径、九步 example 在开关关闭时逐字节不变。
4. 主聊天接线走「计划块协议 + 现有投递通道」：`prepareChatRequest` / `completeChatTurn` 两个边界保持，最终结果经 `deliverTaskOutcome` 幂等回写父会话——与现有 memory bot 的 UX 契约完全一致，前端零改动。
