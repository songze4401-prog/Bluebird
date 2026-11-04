# Notion 交付台账（2026-11-04）

> **结论**：按 Notion 原文口径，**Phase 0 未完成（0.5，其中“权限边界”已由 Owner 裁决暂缓）**，**Phase 1 交付物 2.0/3（第 1 项“统一 Planner / Orchestrator 接口”1.0；第 2 项“能力匹配、动态分配、并行和依赖管理”1.0；第 3 项 0；按 §5 原句逐句拆为 3 项，Planner 与 Orchestrator 合算 1 项）**；4 条验收要求均部分满足（预算硬限制 → B-06=0.5；任务路由可追踪 → 交付物 1 轨迹；Worker Session 隔离与并发结果不串线 → 同进程用例，跨进程未验证）。仓库提交基本都落在「Phase 0 尾巴 / 前置工程」，尚无一条完全满足 Notion Phase 1 的交付与验收。
>
> 唯一依据：《Bluebird Agent Runtime｜混合式多 Agent 目标架构 v1.0》
> https://app.notion.com/p/Bluebird-Agent-Runtime-Agent-v1-0-40da957523c281359607e23f6a3c784f
> 页面 id `40da957523c281359607e23f6a3c784f`，fetch 时间 2026-11-03T11:44:06Z，`verification: unverified`。
> 原文正文含 v1.0 / v1.1 / v1.2 三段，**止于 v1.2**；不含 v1.3。

## 判定标准

- `1` 已完成：该条**原文要求**被满足，且有**可复跑证据**（用例名可复现 / 探针输出 / 压测或演练报告）。
- `0.5` 部分完成：有可复跑实现，但原文要求的组成项仍缺。
- `0` 未完成：只有文档、设计、字段占位、桩模型，或完全没有。
- 文档写完、设计做完、单测桩模型，**一律不计 1**。
- 阶段归属：原文未写归属的，一律标**「待确认」**，旁边只写可判断依据，不给归属结论。

---

## 表 1 · 阶段交付台账（5 行）

| 编号与名称（原文 §5） | 原文目标 / 交付物（引句） | 退出判据（原文“验收”句） | 状态 | 证据 | 未完成原因 + 下一步 |
|---|---|---|---|---|---|
| Phase 0：基线与契约收敛 | “对照当前 HEAD 和已合并实现，确认 Registry、任务队列、Session、Memory、事件、审计和通知链路的真实状态”“统一 Agent Manifest、Task Contract、Result Contract、状态机和权限模型”“输出 ADR” | “没有第二套平行任务协议；关键状态和权限边界可测试” | 0.5 | `docs/phase0-baseline-audit-2026-11-03.md`（判定整体不通过）；ADR 入库 `31a7a9b`；协议收敛 `e08b168`、`7c28a2b`；状态机用例 `tests/agent-recovery.test.js:58`、`:85` | 「权限边界可测试」**Owner 已裁决暂缓（2026-11-04）**：当前按单用户 `local-owner` 口径记录为已知限定，不计入未完成缺口、不安排下一步动作。“没有第二套平行协议”仅完成收敛声明，仍是缺口。 |
| Phase 1：单主控 + 动态 Worker Pool | “在现有 Runtime 内建立统一 Planner / Orchestrator 接口”“支持少量 Agent 的能力匹配、动态分配、并行和依赖管理”“保留单 Agent 快速路径；先选 2—3 个真实专业 Agent 验证” | “任务路由可追踪、Worker Session 隔离、并发结果不串线、预算硬限制有效” | 0.5 | `server/agents/orchestrator.js` + `tests/agent-orchestrator.test.js` 11 条（交付物 1 的 4 条：唯一入口/显式失败/兼容路径/落盘轨迹，`93c5b51`；交付物 2 的 7 条：2a–2d 容量感知择一 `6a3cc84`，2e–2g 依赖图/环/悬空依赖；本轮 `agent-orchestrator` 8→11）；`server/agents/planner.js` + `tests/agent-planner.test.js` 4 条（Planner 侧 a–d，计划只落 workflow-store）；`server/agents/dependencies.js`（唯一 `isReady` + `validateGraph`）+ `server/agents/tasks.js`（`dependsOn`/`settleDependencies`）+ `server/agents/runtime.js`（取队前 settle + runTask 前置校验）+ `tests/agent-worker.test.js` 42 条（其中依赖 5 条 + 并发上限 1 条，`agent-worker` 37→42）；`server/agents/worker-scope.js` + Worker Session 隔离 9 条（内部 a–d + HTTP a–d + 同进程真并发 1 条，上一轮）；B-06 `tests/agent-budget-atomic.test.js` 7 条（`27b99ec`） | 交付物 1 = **1.0**（Orchestrator 唯一入口 + Planner 规则拆解 + 计划只落既有 workflow-store + 批量多步任务共用同一 planId/planVersion；证据见“交付物 1 Planner 侧验收证据”），交付物 2 = **1.0**（四项逐条证据见“交付物 2 四项验收证据”），交付物 3 = 0（合计 2.0/3，按 §5 原句逐句拆分；Planner 与 Orchestrator 合算 1 项）；4 条验收要求均部分满足（预算硬限制、路由可追踪、Worker Session 隔离、并发结果不串线）；尚缺跨进程/真实模型并发与多 Agent 端到端追踪。下一步＝交付物 3（2–3 个真实专业 Agent 验证，需真实模型环境）。 |
| Phase 2：Blackboard + Context Broker | “建立任务级共享产物、证据引用、版本和访问控制”“Worker 私有上下文与共享工作区分离”“支持按需上下文投影和来源追踪” | “跨 Agent 可协作但不能越权读取私有 Session；每个共享结论可追溯来源” | 0 | 全 `server/` grep `blackboard` 仅 1 处注释（`server/agents/artifact-store.js:8`，明确“不承担 Blackboard 的…”）；无 Context Broker 模块 | 未开始。仓库只做了 `artifact-store.js` 的产物版本/正文复读，不等于 Blackboard。下一步＝待拍板 Phase 2 是否按原文整体立项。 |
| Phase 3：验证闭环 + 事件化工作流 | “引入确定性验证、独立 Reviewer、冲突处理和人工审批节点”“事件、状态、结果投递采用幂等与可恢复设计”“建立失败重试、取消、Checkpoint、死信和成本追踪” | “失败注入、重复事件、Reviewer 检出率和结果投递恢复均有测试证据” | 0 | 已有局部：审批节点 `server/agents/approvals.js`、幂等账本 `server/agents/op-ledger.js`（`a6d3455`）、崩溃注入 `tests/agent-crash-injection.test.js` | 缺确定性验证器、独立 Reviewer、冲突处理、死信与成本追踪；Reviewer 检出率无任何测试。下一步＝待拍板是否单独立项。 |
| Phase 4：受控自治与自我改进 | “根据真实运行数据动态组队、重规划和选择验证强度”“建立离线评测集、策略版本、灰度发布和回滚”“在权限、预算和审批边界不变的前提下，逐步开放低风险自动化” | “相对基线在成功率、返工率、成本或延迟上有可重复改善，且安全指标不退化” | 0 | 全仓 `.js` grep `benchmark\|holdout` 零命中；无评测集、无灰度/回滚机制 | 未开始；且验收句要求“相对基线可重复改善”，**必须先有真实模型环境与压测数据**。 |

---

## 表 2 · 25 项验收归属台账（25 行）

> A 组原句出自 §22（v1.1 验收清单），B 组原句出自 §30（v1.2 编码验收门槛）。
> 两节在原文中均为**无编号 checkbox，且未挂到任何阶段**；编号 A-01…B-11 是仓库 v1.3 自加的。
> 链接统一为同一页面：`https://app.notion.com/p/40da957523c281359607e23f6a3c784f`（下表只标 § 小节）。

| 编号 | 验收项原文（引句 · §） | 归属阶段 | 对应交付物 / 退出判据（原文依据） | 状态 | 证据 | 未完成原因 + 下一步 |
|---|---|---|---|---|---|---|
| A-01 | “计划版本迁移覆盖 plan/task 映射、运行中节点、产物复用和副作用补偿”· §22；规则见 §10 | 待确认（依据：§10 讲 planVersion v1→v2，未写阶段） | §10 迁移表（6 种映射：reused/continued/replaced/cancelled/superseded/revalidated）+ §10 “Task-level 规则”；退出判据未单写 | 0.5 | `server/agents/workflow-store.js`（版本不可变、单调 +1，`f279b37`）；任务绑定冻结计划 `6f83ecc`；`tests/agent-workflow-store.test.js` a–m、`tests/agent-workflow-binding.test.js` 1–8 | 缺 v1→v2 节点映射、运行中节点处置、产物复用检查、副作用补偿、generation/fencing token（`grep migration\|reused\|fencing` 零命中）。下一步＝先拍板归属，再按 §10 Task-level 规则补映射与 fencing。 |
| A-02 | “Blackboard CAS、版本裁决和冲突处理明确”· §22；规则见 §11 | 待确认（依据：§11 是 Blackboard 并发写，Phase 2 才引入 Blackboard，但原文未写） | §11 `expectedVersion` CAS + conflict 返回 + 不可合并转裁决 | 0 | 任务级 CAS：`server/agents/tasks.js:986-1005`、`errors.js:30-44`（`288730a`）、`tests/agent-recovery.test.js:492`；**Blackboard 不存在**（`artifact-store.js:8` 注释） | 本条要求的是 Blackboard CAS，任务级 CAS 不能替代。下一步＝随 Blackboard 立项（Phase 2 与否待拍板）。 |
| A-03 | “State Store / Blackboard 各自事实权威及跨 Store 恢复明确”· §22；规则见 §11 | 待确认（依据：§11 完成提交协议，仓库归在 Phase 1 前置 ③，原文未写） | §11 五步完成提交 + “提交意图 / Outbox、幂等关联和恢复扫描” | 0.5 | `server/agents/artifact-commit.js:106-149`（`scanPendingCommits`、orphan TTL）；`artifact-store.js` `COMMIT_STATES`；`6204f06`；`tests/agent-crash-injection.test.js:166` c1 | 缺 Outbox/事件化提交意图；Blackboard 侧权威未建立。下一步＝补 Outbox（若同意归 Phase 1 前置）。 |
| A-04 | “冲突裁决权、证据顺序和升级路径明确”· §22；规则见 §12 | 待确认（依据：§12 冲突裁决 + §28 ConflictRecord，原文未写阶段） | §12 裁决顺序（确定性→Reviewer→人工）+ §28 五类冲突枚举 | 0 | 全 `server/` grep `ConflictRecord\|conflictId\|resolutionStatus` 零命中 | 未开始。下一步＝先拍板归属（倾向与 A-02/Phase 2–3 合并，但仅依据，不作归属）。 |
| A-05 | “trustLevel 仅由验证层写入”· §22；硬约束见 §12 | 待确认（原文未写） | §12 硬约束 + §27 写入条件 | 0 | 全 `server/` grep `trustLevel` 零命中 | 字段与写入者均不存在。 |
| A-06 | “风险分级验证、验证成本和质量指标明确”· §22；规则见 §13 | 待确认（原文未写） | §13 R0–R3 表（最低验证/审批）+ 漏检率/误拦截率/验证开销统计 | 0.5 | 工具风险映射：`server/agent-runtime.js` `FAIL_OPEN_RISK`、`server/agents/failopen-policy.js`（`c8283ca`）；审批风险 `medium→R2 / high→R3`：`approvals.js:52-54` | 只有“风险等级映射”，没有按等级分派验证强度，也没有成本/漏检/误拦截指标。**需真实模型环境样本集**才能产出评测报告。 |
| A-07 | “Benchmark 基线可选且记录完整配置；评测集有 holdout 和轮换”· §22；规则见 §14 | 待确认（原文未写） | §14 五类可比较基线 + 配置记录字段 + holdout/轮换规则 | 0 | 全仓 `.js` grep `benchmark\|holdout` 零命中 | 未开始；**必须真实模型环境与可重复评测数据**。 |
| A-08 | “审批超时、批量、升级和申诉规则明确”· §22；规则见 §15 | 待确认（依据：§15 审批吞吐，原文未写） | §15 动作/参数摘要/影响/风险/证据/有效期；批量规则；超时升级；申诉复核 | 0.5 | `approvals.js:49` `R2_SLA_MS=30min`、`escalationAt`（50%）、`overdue/escalatedAt`；`tests/agent-approval-policy.test.js` a、b、c | 缺批量审批、申诉改判、审批负载分配与指标。 |
| A-09 | “provenance / taint 贯穿 Task、Artifact 和 Tool Gateway”· §22；规则见 §16 | 待确认（原文未写） | §16 Task Contract 增 `provenanceRefs/taintLabels/taintPolicyVersion`，Gateway 每次校验 | 0 | `provenance` 命中全在 `server/memory.js`、`server/profile.js`（记忆域），与 Task/Artifact/Gateway 无关；`taint` 零命中 | 未开始。 |
| A-10 | “失败模式清单和 Artifact 环检测明确”· §22；规则见 §17 | 待确认（原文未写） | §17 九类失败模式表 + 三类图环检测（委派/依赖/产物 lineage） | 0.5 | 依赖环检测已落地（2026-11-04）：`server/agents/dependencies.js` `validateGraph`（Kahn 拓扑余集判定）+ `tests/agent-orchestrator.test.js` 交付物2f（A↔B → 409 `dependency_cycle`、`taskCountBefore=0/taskCountAfter=0`）、交付物2g（悬空引用 400 零落盘） | 三类环检测只完成**依赖环**；委派环、产物 lineage 环、九类失败模式清单仍未实现。下一步＝按 §17 补委派/lineage 环检测与失败模式表。 |
| A-11 | “规划 / 审批 / 验证延迟纳入 SLO，有停止重规划判据”· §22；规则见 §18 | 待确认（原文未写） | §18 P50/P95/P99 采集 + deadline/剩余预算/最小收益门槛 | 0 | `runtime.js` 仅 `tool_call_budget` 截断（`:462`），非 SLO；无重规划停止判据 | 未开始；SLO 阈值需真实运行数据。 |
| A-12 | “组件预算、stub 边界和 Owner 角色明确”· §22；规则见 §19 | 待确认（依据：§19 说“Phase 0 必须明确到人”，原文未写阶段归属） | §19 6 个交付模块表 + Owner 角色 + 可 stub 清单 | 0.5 | v1.3 §41 责任人已指定（`e950997` 文档记录） | 条目判据要求“管理评审记录（非代码测试）”，无记录；按硬规矩不计 1。 |
| A-13 | “有端到端 worked example”· §22；示例见 §20 | 待确认（原文未写） | §20 十三步流程（含 planVersion v2、fencing、waiting_approval） | 0 | 仅 §20 文档文本；全仓未找到可执行示例脚本或 trace 产物 | 缺可跑脚本与 trace。 |
| A-14 | “Phase 0 有降级分支和退出条件”· §22；规则见 §21 | 待确认（依据：§21 标题即 Phase 0，原文未写归属阶段） | §21 A–E 五分支 + “出现…时暂停或降级”退出条件 | 0.5 | `docs/phase0-baseline-audit-2026-11-03.md` §8（判定 B）、§8.2（退出判据＝§11 三条 + §15 fail-closed） | 缺分支开关实现与 B/C/E 降级演练记录。 |
| B-01 | “六类错误码及 `retryable` 进入统一 Result / Error Contract”· §30；规则见 §23 | 待确认（原文未写） | §23 六类枚举表 + 七字段（errorCode/retryable/errorFingerprint/failedAt/taskId/runId/可选 causeRef） | 0.5 | `server/agents/errors.js:30-44` 只实现 `conflict` 一类七字段（`288730a`） | 其余五类（validation_failed/not_authorized/budget_exceeded/dependency_failed/internal_error）未实现为统一契约。 |
| B-02 | “Gateway 不负责重试决策；Workflow Engine 独占”· §30；规则见 §23 | 待确认（原文未写） | §23 职责边界（Gateway 只报类别与建议） | 0.5 | `server/agent-runtime.js` `executeToolCall` 无重试分支；`runtime.js:962` 的 `maxAttempts` 属模型/任务重试 | 缺“Gateway 无重试”的静态检查或用例；重试决策归属未在代码中界定。 |
| B-03 | “`retrying` / `recovery` 是正式状态，且仅 Engine 可写”· §30；规则见 §24.1 | 待确认（原文未写） | §24.1 状态集合 + 两态语义 + “只有 Workflow Engine 可写 Task 状态” | 0.5 | `server/agents/state-machine.js:18-48`；`tasks.js` `transitionTask` 唯一入口（`8da8a89`、`8f08807`、`30d5ce7`）；`tests/agent-recovery.test.js:58`、`:85`、`:237`、`:280`、`:296` | 两态迁移有用例；**无“越权写入被拒”用例**，故不计 1。 |
| B-04 | “状态迁移表、前置条件、`expectedStateVersion` 和非法迁移审计可测试”· §30；规则见 §24.2–24.3 | 待确认（原文未写） | §24.2 合法迁移表 + §24.3 五项校验依据 | 0.5 | `tasks.js:986-1005`（expectedVersion）、`task-store.js:65-68`（stateVersion）、`state-machine.js`；`tests/agent-recovery.test.js:492`（CAS 冲突）、`:568` | 主要迁移与 CAS 有用例；**未找到“非法迁移被拒 + 审计”用例**。 |
| B-05 | “委派深度 2、单 Task 重规划 2 次、单 Run 重试 3 次有服务端硬限制”· §30；规则见 §25 | 待确认（原文未写） | §25 三条硬上限（depth 2 / replan 2 / run retry 3） | 0 | `grep delegation\|maxDepth` 零命中；重试上限是 `tasks.js:705` `BLUEBIRD_AGENT_TASK_MAX_ATTEMPTS`（0–3，任务 attempt），不等于 Run 重试；无重规划计数 | 无委派、无重规划，三项均无法执行。 |
| B-06 | “Task Token hard budget 原子计量，Run 总预算作为额外闸门”· §30；规则见 §25 预算规则 | 待确认（依据：§5 Phase 1 验收句含“预算硬限制有效”，但未写条目归属） | §25 预算规则：Task 硬上限必填、父子覆盖、服务端原子预留/扣减、重试不重置、Run 总闸门 | 0.5 | `27b99ec`；用例 `tests/agent-budget-atomic.test.js` B-06a（真并发仅一成功）、b（重试不重置）、c（父子覆盖）、d（结算差额）、e（release）、f（Run 闸门）、g（缺上限拒绝）；实现 `server/agents/tasks.js:631`（reserve）/`:696`（settle）/`:730`（release）/`:908`（父覆盖）/`:942`（Run 建档）、`errors.js:52`（budget_exceeded retryable=false）、`runtime.js:822`（执行前 reserve）；探针：五门禁 EXIT=0，全量 85 文件全通过，覆盖 2158/222/1936 | **仍差两项才可计 1**：①真实供应商 token usage 未在真实模型环境验证（stub 无 usage 时按 0 结算）；②跨进程/多实例并发不在用例保证范围。下一步＝真实模型环境下用真实 usage 复跑 + 多进程并发压测。 |
| B-07 | “限流、熔断、重规划风暴抑制有配置、状态和测试”· §30；规则见 §26 | 待确认（原文未写） | §26 Run/Task/Agent/Provider 四维限流 + closed/open/half-open + 风暴抑制 | 0 | `watchdog-policy.js:115-152` 的 breaker 只针对 watchdog 动作（alert/pause_intake/restart），非 Provider/工具/Worker；无四维限流、无重规划风暴抑制 | 需压测报告与风暴场景测试；现有 breaker 不可计为本条。 |
| B-08 | “`trustLevel` 四档枚举及唯一写入者约束落到服务端”· §30；规则见 §27 | 待确认（原文未写） | §27 untrusted < declared < evidence_checked < independently_verified | 0 | `trustLevel` 零命中 | 未开始。 |
| B-09 | “`ConflictRecord` 可序列化、可持久化、可审计”· §30；规则见 §28 | 待确认（原文未写） | §28 十二字段表 + 裁决顺序 | 0 | `ConflictRecord\|conflictId` 零命中 | 未开始。 |
| B-10 | “R2 30 分钟转人工 fail-closed；R3 只接受显式批准”· §30；规则见 §29 | 待确认（原文未写） | §29 风险级别 SLA 表 | 1 | `approvals.js:49`（30 min）、`:52-54`（R2/R3 映射）；`tests/agent-approval-policy.test.js` a（R2 到期仍 pending、任务未放行）、b（R3 长期 pending）、g（老记录缺字段 fail-closed） | 核心满足；备注：原文“转人工队列”在代码中体现为 pending 列表（`pendingCount()`），无独立队列实体。 |
| B-11 | “审批请求有持久化 SLA、提醒、升级和取消路径，不会静默永久挂起”· §30；规则见 §29 | 待确认（原文未写） | §29 持久化 deadline/escalationAt、通知重试记录、责任队列；六态 pending/approved/rejected/expired/escalated/cancelled | 0.5 | `approvals.js:36-43` 状态为 pending/approved/rejected/executing/completed/failed；持久化 `riskLevel/expiresAt/escalationAt/policyVersion`；`:496-507` 到期只标记 | 六态中的 expired/escalated/cancelled 未落地；无通知重试记录与提醒任务。 |

**汇总**：`1` = 1 项（B-10）；`0.5` = 13 项（A-01、A-03、A-06、A-08、A-10、A-12、A-14、B-01、B-02、B-03、B-04、B-06、B-11）；`0` = 11 项（A-02、A-04、A-05、A-07、A-09、A-11、A-13、B-05、B-07、B-08、B-09）。

**阶段归属**：25 条全部「待确认」——原文 §22/§30 均未把条目挂到阶段，本台账**不做归属推断**，只在“依据”列写出原文哪一节在讲它。

---

## 表 3 · 阶段归属与冲突（供所有者拍板）

| # | 冲突点 | 原文怎么说 | 仓库怎么做 | 谁拍板 |
|---|---|---|---|---|
| 1 | 编号撞车 | Notion Phase 1 =「单主控 + 动态 Worker Pool」，验收含“动态分配、并行、并发结果不串线” | v1.3 Phase 1 = 前置四件事 + 本体三步，且明文“四项完成前不得开启动态组队与多 Producer 并发写” | 所有者（定义 Phase 1 的验收口径） |
| 2 | Context Broker 消失 | Phase 2 =「Blackboard + Context Broker」，验收要求“按需上下文投影和来源追踪” | Phase 2 只剩一句入口“单写者 + append-only Artifact”；无 Context Broker 模块 | 所有者 |
| 3 | Phase 3 / 4 无对应 | 原文有完整目标与验收句 | 仓库无阶段定义；仅零散条目（审批、幂等账本） | 所有者 |
| 4 | 条目未挂阶段 | §22（14 条）、§30（11 条）为无编号 checkbox，未绑定阶段 | v1.3 重编为 A/B 编号，但仍未给归属 | 所有者 |
| 5 | 版本优先级 | 原文止于 v1.2 | 仓库有 v1.3 封版（2026-11-03），自称“封版后不再追加架构章节” | 所有者（v1.3 能否改写 Notion 验收） |
| 6 | 需真实环境/压测的 4 项 | A-06（样本集评测报告）、A-07（benchmark/holdout）、B-07（压测报告）、A-13（跑通留 trace） | 均无对应数据/脚本 | 先由所有者决定是否投入真实模型环境 |
| 7 | 预算原子计量 | §25 要求“服务端原子预留 / 扣减”“Run 总预算是额外闸门” | 已核查并已实现（B-06=0.5，`27b99ec`）：Task token 上限强制、原子 reserve/settle/release、父子覆盖、Run 闸门、retryable=false；缺真实 usage 与跨进程并发验证 | 无争议；剩余验证依赖真实模型环境/多进程压测 |

---

## 新增错误码清单（Phase 1 交付物 2：依赖管理）

> 放行结论：以下 4 个码**全部落在既有六类语义内**，没有自成一套新族；`errors.js` 未新增类，`AgentError` 仍以 `{code, status}` 表达。
> 六类基线：`validation_failed` / `not_authorized` / `conflict` / `budget_exceeded` / `dependency_failed` / `internal_error`。

| 错误码 | 触发条件 | HTTP 状态 | 归属既有六类 | 与其他码的关系 |
|---|---|---|---|---|
| `dependency_cycle` | 批量编排 `validateGraph` 的 Kahn 拓扑排序后仍有未出队节点（含自依赖、A↔B 等环）；落盘前抛出 | **409** | `conflict`（同 409 语义：图与既有不变量冲突，重试无效） | 新码字面量，但沿用 `conflict` 类的状态与语义；`details.cycle` 给出环上 key，`retryable=false` |
| `dependency_not_found` | ① `dependsOn` 非数组/含空值/重复/超过 8 个；② 依赖 taskId 不存在；③ 依赖任务不属于同一 `agentId`；④ 批量节点 key 为空/重复/悬空引用/跨 Agent | **400** | `validation_failed`（入参在服务端可判定为非法） | 创建与批量入口共用同一校验；**不**用于运行时依赖记录被裁剪（该情形归 `dependency_failed`） |
| `dependency_failed` | 任务结果码（非抛错）：`queued` 任务的全部依赖已终态但未成功（`failed` / `timed_out` / `recovery`，或依赖记录缺失） | 读取任务 **200**，`task.status=failed` | **复用既有 `dependency_failed` 类**：同一 code 字面量、同一语义“上游未成功导致本任务无法执行”。此前该类只有清单、无落地（B-01 已登记），本轮首次在任务 Result 中实现 | 与 `dependency_cancelled` 是“类与子因”关系；任务 `result.neverStarted=true` + `blockedBy` 数组 |
| `dependency_cancelled` | 任务结果码：上游依赖终态为 `cancelled`，且不存在其他非取消的失败依赖 | 读取任务 **200**，`task.status=failed` | `dependency_failed` 类的**子因**（detail），不单列族 | 仅为让审计区分“上游被取消”与“上游执行失败”；状态机与 HTTP 语义与 `dependency_failed` 相同 |

补充约束（与实现一致）：
- 任务结果码不改变 HTTP 成功语义：任务已按状态机收敛为 `failed`，读取接口仍是 200。
- `queued → failed` **不是**合法边（`state-machine.js`：`queued` 仅到 `accepted`/`cancelled`/`timed_out`），依赖失败收敛走 `queued → accepted → failed` 两步；`result.neverStarted=true` 与事件 `task.dependency_failed.payload.neverStarted=true` 明确“该任务从未进入 `running`”，并有“无 `task.started` 事件、`runStartedAt=null`”的用例断言。

---

## 交付物 2 四项验收证据（§5“能力匹配、动态分配、并行和依赖管理”）

> 判定口径：四项**各自都有可复跑用例与实际输出**才记 1；本轮四项齐全 → **1.0**（不是一句话概括）。
> 证据边界：多 Agent 是测试构造（`manifest.setTestManifests`）；并发为同一进程 + 确定性 stub Provider，不代表跨进程/真实模型。

| 项 | 对应用例（可复跑） | 实际输出 / 断言 |
|---|---|---|
| ① 能力匹配 | `tests/agent-orchestrator.test.js` 交付物1a、2a–2c | 入口按 `capabilities ∩ acceptedTaskTypes` 匹配；`[交付物2b 轨迹] {"candidateOrder":["agent-a","agent-b","agent-c"],"selected":"agent-a","allocation":"selected_with_capacity","excludedReasons":"agent-b:lower_priority;agent-c:lower_priority","secondSelected":"agent-a"}`；1b 匹配不到时显式失败且不建任务 |
| ② 动态分配 | `tests/agent-orchestrator.test.js` 交付物2a、2c | 2a：`agent-a` 满容量 → `selectedAgentId=agent-b`，轨迹 `saturatedAgentIds:["agent-a"]`、`excludedReasons:"agent-a:at_capacity"`；2c：两候选全满 → `allocation:"queued_all_at_capacity"`、`degraded:true`、任务仍 `queued`；容量口径复用 Router `decideInternal.atCapacity` |
| ③ 并行 | `tests/agent-worker.test.js`「并发：3 条任务受全局 TASK_CONCURRENCY=2 限制，峰值并行=2 且第 3 条延后」 | `[并发-全局上限] {"concurrency":"(default=2)","peakActive":2,...}`：t1 `runStartedAt=12:42:57.176Z`、t2 `12:42:57.240Z`，区间重叠 ≈ 573ms；t3 `runStartedAt=12:42:57.775Z`，前两条最早 `completedAt=12:42:57.749Z`，断言 `t3.runStartedAt >= min(前两条 completedAt)`；3 条全部 `completed` |
| ④ 依赖管理 | `tests/agent-orchestrator.test.js` 交付物2e–2g；`tests/agent-worker.test.js` 依赖 5 条 | 2e：`order:["upstream","downstream"]`、下游 `dependsOn` 落成真实 taskId、状态 `queued`、`runStartedAt:null`；2f 环：`code=dependency_cycle,status=409,taskCountBefore=0,taskCountAfter=0`；2g 悬空：`dependency_not_found,400` 且零落盘；worker：`[依赖-放行时序]` 上游 `completedAt=12:42:56.583Z` → 下游 `runStartedAt=12:42:56.609Z`（阻断期 `blockedStatus:"queued"`）；`[依赖-失败级联]` 下游 `errorCode=dependency_failed,neverStarted=true,runStartedAt=null,startedEvents=0`；`[依赖-多级级联]` middle/leaf 两级均 `dependency_failed` 且 `blockedBy` 指向上一跳；`[依赖-取消级联]` 下游 `dependency_cancelled,neverStarted=true` |

**同源证据（`isReady` 只有一个实现）**：
- 唯一纯函数：`server/agents/dependencies.js:34` `function isReady(task, tasksById)`
- 调用点 1（取队入口）：`server/agents/tasks.js:1953` `.filter(task => dependencies.isReady(task, current.tasks))`
- 调用点 2（`runTask` 前置校验）：`server/agents/runtime.js:597` `if (!dependencies.isReady(task, tasks.rawTasksById())) return;`
- 依赖失败收敛入口：`server/agents/runtime.js:66` `tasks.settleDependencies()`（`tasks.js` 内 `blockers` 与 `transitionTask` 两步收敛）

---

## 交付物 1 Planner 侧验收证据（§5“在现有 Runtime 内建立统一 Planner / Orchestrator 接口”）

> 判定口径：Planner 侧要求“输入高层目标 → 输出可执行计划（有序步骤 + 每步能力要求）→ 落到既有 workflow-store 并返回 `planId/planVersion`”，且不得另造第二套计划。本轮＝规则拆解 + 只复用既有计划存储 + 复用批量入口驱动多步任务 → **1.0**。
> **证据限定（必须保留）**：**真实模型下的拆解质量未验证**。本轮只用确定性规则/模板（`search_then_summarize` / `memory_search`），不接真实模型；步骤合理性、目标覆盖率、拆解失败率均无真实模型评测数据。

**复用证明（不造第二套计划）**：

| 复用项 | file:line | 说明 |
|---|---|---|
| 计划版本存储 / 追加 | `server/agents/workflow-store.js:664` `appendVersion` | Planner 写计划**只**调此函数；新增 `allowCreate` 仅用于“确定性 planId 首次建血缘”，默认行为不变 |
| 版本读取（冻结） | `server/agents/workflow-store.js:759` `getVersion` | 任务创建时按 `planId/planVersion` 取冻结版本；取不到即失败 |
| 计划校验 | `server/agents/workflow-store.js:289` `validatePlan` | 与任务路径同一 schema，仅新增 step 可选字段（goal/capability/taskType/dependsOn） |
| stepKey / digest | `server/agents/workflow-store.js:197` `stepKeyFor`、`:184` `digestPlan` | 步骤身份与计划摘要沿用既有口径，未另立哈希规则 |
| 计划复用（Router） | `server/agents/router.js:577-591` | 传入 `input.workflowPlan` 时只 `getVersion` 校验并复用，**不再 append**；未传时旧行为（每任务各一份单步计划）不变 |
| 批量任务入口 | `server/agents/orchestrator.js:220` `createTaskGraph` | Planner 的多步转任务**只**走此入口，未新增创建路径 |
| 唯一 Planner 实现 | `server/agents/planner.js:119` `plan`、`:174` `planAndCreate` | 拆解与落盘集中一处，无第二份计划副本 |

**四条用例（`tests/agent-planner.test.js`，复跑 `node tests/agent-planner.test.js` → `tests 4 / pass 4 / fail 0`）**：

| 用例 | 实际输出（复跑实测） | 结论 |
|---|---|---|
| a. 目标 → 计划落盘 | `[Planner-a 计划落盘] {"planId":"plan_pg_3b4f3cf5d97fab13ae6b90575144f12b","planVersion":1,"digest":"sha256:33099df0…b9e40","created":true,"steps":[{"stepKey":"29c15760…62faad7","label":"检索","goal":"围绕目标检索记忆：检索我上次说的偏好，并总结一下","capability":"memory.search","taskType":"memory.search","dependsOn":[]},{"stepKey":"da9f0ea6…7f1bc79c","label":"总结","goal":"基于检索结果总结与解释：检索我上次说的偏好，并总结一下","capability":"memory.explain","taskType":"memory.explain","dependsOn":["29c15760…62faad7"]}]}` | 2 步有序、各步带 `capability`，第 2 步 `dependsOn` 指向第 1 步 `stepKey`；计划落 workflow-store 并返回 `planId/planVersion` |
| b. 计划 → 批量任务且依赖正确 | `[Planner-b 批量任务] {"planId":"plan_pg_2161ecacdf92e9121f80bfda9ee5179a","planVersion":1,"order":["f84f7abb…4daab2f81","ba7b95e8…a23b5514"],"tasks":[{"taskId":"task_63d64b57-7c5d-4a1d-965b-cfc933416e1a","dependsOn":[],"planId":"plan_pg_2161ecacdf92e9121f80bfda9ee5179a","planVersion":1,"status":"queued"},{"taskId":"task_4f7ff15f-352b-4f1b-b080-eec600f2a141","dependsOn":["task_63d64b57-7c5d-4a1d-965b-cfc933416e1a"],"planId":"plan_pg_2161ecacdf92e9121f80bfda9ee5179a","planVersion":1,"status":"queued"}]}` | 两个任务共用同一 `planId/planVersion`（计划血缘只 +1）；下游 `dependsOn` 已由 key 解析为真实 taskId，均 `queued` |
| c. 拆不出来 → 显式失败 | `[Planner-c 显式失败] {"code":"capability_not_found","status":400,"plansBefore":2,"plansAfter":2,"tasksBefore":2,"tasksAfter":2}` | 失败发生在 `selectTemplate`（任何 store 写入之前），因此**零计划、零任务**；不产生孤儿计划，也不依赖 TTL 兜底 |
| d. 同一目标两次调用 | `[Planner-d 版本语义] {"planId":"plan_pg_d82af357585152946e95f202a6fc9bfa","firstCall":{"created":true,"planVersion":1,"digest":"sha256:3ce7be62…f718c1"},"secondCall":{"created":false,"planVersion":1,"digest":"sha256:3ce7be62…f718c1"},"appended":{"created":true,"planVersion":2,"digest":"sha256:cae8f1ec…c47e1"},"v1Digest":"sha256:3ce7be62…f718c1","v2Digest":"sha256:cae8f1ec…c47e1"}` | 同目标再调＝head digest 相同 → `created:false` 取出原版本（不追加、不产生同号异内容）；显式 planId 且内容变化 → 追加 v2，v1 digest 保持不可变 |

**孤儿计划语义（说明口径，不在用例 c 范围）**：`planAndCreate` 先 fsync 计划、再调 `createTaskGraph`；若建任务失败，计划成为孤儿，按 `workflow-store.js:65 ORPHAN_TTL_MS`（24h）+ `prune():826` 既有裁剪规则处理（被 Store refs/liveRefs 引用的版本不动）。这是既有 TTL 语义，本轮未新增清理机制。

---

## 34 个提交的历史成果核对

范围：`192be27` 之后、`72d5b5f`（PR #55 合并）之前的 34 个提交（含 `4408f78`）。

1. **真正满足 Notion 验收要求的**：仅 1 条——`ae26a87`、`339d5f7`（配合 `tests/agent-approval-policy.test.js` a/b/g）对应 **B-10** 的 R2 30 分钟不放行 / R3 仅显式批准。
2. **只是基础设施或前置工程**：`f279b37`、`6f83ecc`、`b33a27b`、`c4ed899`、`0125382`（Workflow Store 与崩溃注入）；`6204f06`、`1984e7e`、`71f1de5`、`4f681c7`（产物提交 / 正文 / 清理 / fail-open 执行）；`a6d3455`、`56452c2`、`a1827a7`、`7010116`、`e651c3b`（幂等账本）；`946c5af`、`35b6a09`、`31a7a9b`、`e08b168`、`7c28a2b`（计划指针与协议收敛文档）。
3. **只有代码变更、没有验收证据（也不对应任何 Notion 条目）**：`4dab3e3`、`6b03183`、`bbca1b2`、`d94e09d`（状态词表/注释/会话派生）；`a1827a7`（去重成本修复，属内部修正）；`936a3de`（eval 退出码）；`4039dd6`（交接快照）；`4408f78`（测试稳定性修正）。
4. **可复用、避免重复开发**：`workflow-store.js`（计划版本不可变 + 引用防裁剪）、`artifact-commit.js` + `orphan-scheduler.js`（pending-commit / orphan / TTL）、`op-ledger.js`（幂等账本）、`state-machine.js` + `transitionTask`（单写入口）、`approvals.js`（SLA/升级字段）。这些是 Notion Phase 2/3 与 Phase 1 前置的底座，可在新阶段直接复用。

---

## Phase 1 交付清单与状态（Notion §5 Phase 1）

对应原文 **3 句交付 + 1 句验收**（验收句内含 4 条要求）：

**拆分口径（判据）**：交付物按 §5 Phase 1 的**原句逐句**拆分，共 3 句、即 3 项；验收句按顿号拆成 4 条要求。**Planner 与 Orchestrator 不拆算**——原句是“建立**统一** Planner / Orchestrator **接口**”，两者同属一个“统一……接口”的宾语，原文没有把它们写成两个交付物；若强行拆成两项会得到 4 项，但那属于自行增补验收要求，故台账统一采用 **3 项交付物 / 4 条验收要求**。

1. **统一 Planner / Orchestrator 接口** —— **1.0**（2026-11-04）：Orchestrator 侧仍只有 `server/agents/orchestrator.js`（`orchestrate()`/`createTaskGraph()`）一个入口，`server/tool-dispatch-bot.js` 的真实创建路径已迁移；Planner 侧新增 `server/agents/planner.js`（`plan():119` 规则拆解、`planAndCreate():174` 驱动多步任务），产出**只落既有 `workflow-store`**（`appendVersion:664`、`getVersion:759`、`validatePlan:289`、`stepKeyFor:197`），未另存计划、未引入第三套版本口径；多步任务复用 `orchestrator.js:220 createTaskGraph` 批量入口，`router.js:577-591` 对 `workflowPlan` 只校验复用不 append。用例 `tests/agent-planner.test.js` a–d 四条（目标→计划落盘、计划→批量任务且 dependsOn 正确、拆不出来显式失败且零计划零任务、同目标两次调用取出/追加语义一致），证据见「交付物 1 Planner 侧验收证据」。**限定**：真实模型下的拆解质量未验证——本轮只用确定性规则/模板，不接真实模型；当前仅 1 个注册主体，“统一”只覆盖一条真实路径。
2. **少量 Agent 的能力匹配、动态分配、并行和依赖管理** —— **1.0**（2026-11-04）：四项**逐条证据**见上一节「交付物 2 四项验收证据」，摘录：①能力匹配＝`orchestrator.js` 按 `capabilities ∩ acceptedTaskTypes` 匹配（1a/2a–2c）；②动态分配＝按并发余量 + `routingPriority` 择一，满容量写 `saturatedAgentIds`/`excludedReasons`（2a 选闲、2c 全满排队）；③并行＝`TASK_CONCURRENCY` 全局闸门，3 条 SLOW_TASK 峰值 `peakActive=2`、区间重叠 ≈573ms、第 3 条在前两条完成前不启动；④依赖管理＝`dependsOn` 字段（≤8、同 botId）+ 唯一 `isReady` 纯函数 + `queued` 不出队 + 上游完成自动放行、失败/取消级联（含下游的下游）+ 批量图环检测 409 且零落盘。用例：`tests/agent-orchestrator.test.js` 2a–2g（11 条）、`tests/agent-worker.test.js` 依赖 5 条 + 并发上限 1 条（42 条）。**证据限定**：多主体是**测试构造**（`manifest.setTestManifests`），真实注册表仍只有 memory；并发是同一进程 + 确定性 stub Provider；“动态分配”仍是容量感知择一，不是 Worker Pool 弹性伸缩；重规划未实现（不在 §5 该句四项内）。
3. **保留单 Agent 快速路径；先选 2–3 个真实专业 Agent 验证** —— 未开始；**需要真实模型环境**才能产出验证证据。
4. **验收“任务路由可追踪”** —— 部分满足：`route.decided` 事件含 candidates/selected/capability，`task.route.orchestration` 含意图摘要、匹配依据、候选集与规则（用例 `tests/agent-orchestrator.test.js` 1d，`93c5b51`）；交付物 2 又补了候选优先级顺序、满容量主体与排除原因（2a–2d）；尚缺跨任务/多 Agent 的端到端追踪。
5. **验收“Worker Session 隔离”** —— **部分满足（读边界对内/对外均生效，2026-11-04）**：`server/agents/worker-scope.js` 是唯一读边界——自己的会话历史与产物可读，跨 Worker 默认拒绝，显式 `{grantedBy, reason}` 授权才放行；拒绝沿用既有 `worker_session_owner_mismatch`，审计复用 `tasks.appendEvent`（`worker.scope_denied` / `worker.scope_read`），未新建错误码族或审计存储；runtime 的 worker 会话归属统一走该边界（`sessions.js` 零改动）；HTTP `GET /agents/:botId/sessions/:sessionId` 已接入 `authorizeSessionRead`（本轮），拒绝返回 409 + 既有码，direct 会话与缺失会话响应保持原样。用例 `tests/agent-worker.test.js` 9 条（内部 a–d 4 条 + HTTP a–d 4 条 + 真并发 1 条，`agent-worker` 28→37）：互读 409、自身 200、授权 200 且留痕、零回归。**证据限定**：两个 Worker 是**测试构造**（同一 memory 主体的两个任务/会话）；`requesterTaskId` 是调用方自报值（生产仍是单用户 local-owner，无可验证调用者身份），挡住误读而非抗恶意伪造；跨进程隔离未验证。
6. **验收“并发结果不串线”** —— **部分满足（同一进程内并发证据，2026-11-04）**：`Promise.allSettled` 同时启动两条 SLOW_TASK 任务，执行区间重叠 **492ms**（串行执行不会出现区间重叠）；A 摘要只含 `CONCURRENT_ALPHA`、B 只含 `CONCURRENT_BETA`，任务 id、runId、sessionId、产物 id 均无交集，产物 `taskId` 各归各，`stateVersion` 各自推进。用例 `tests/agent-worker.test.js`「并发：两条任务同时跑，结果、产物引用与会话各归各且不串线」。**证据限定**：同一进程、确定性 stub provider；跨进程与真实模型并发未验证。
7. **验收“预算硬限制有效”** —— 部分满足（B-06 = 0.5）：原子 reserve/settle/release、父子覆盖、Run 闸门有 7 条可复跑用例（`27b99ec`）；尚缺真实供应商 usage 验证与跨进程并发证明。

---

## 准入模板（今后每轮开工必填）

```
对应 Notion：Phase X / §Y / 交付物「…」/ 退出判据「…」
本条工作让哪条状态从 X 变成 Y：
证据形式（可复跑用例名 / 探针输出 / 压测报告）：
```

配套约束：
- 填不出第一行 → 不开工。
- 交付物必须是 Notion 原文里的句子，不得自拟。
- 状态变更只能依据可复跑证据；文档与设计不改变 0/0.5/1。

---

## 台账维护边界

- 本台账只记录与核对，不重构代码、不新增协议、不扩建基础设施、不为完善文档扩范围。
- 不给每条验收项指定负责人；负责人由所有者裁决。
- 归属与冲突一律「待确认」，由所有者拍板。
