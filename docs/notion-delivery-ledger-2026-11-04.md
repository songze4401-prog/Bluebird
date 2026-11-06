# Notion 交付台账（2026-11-04）

> **结论**：按 Notion 原文口径，**Phase 0 未完成（0.5，其中“权限边界”已由 Owner 裁决暂缓）**，**Phase 1 交付物 3.0/3（第 1 项 1.0；第 2 项 1.0；第 3 项 1.0，真实 LongCat 模型一轮验证；按 §5 原句逐句拆为 3 项，Planner 与 Orchestrator 合算 1 项）**；4 条验收要求 **4/4 已满足（2026-11-04）**：预算硬限制（B-06=1，真实供应商 usage 结算）、任务路由可追踪（真实注册的 researcher/executor/reviewer 分派 + 候选集/依据落盘）、Worker Session 隔离（服务端签发令牌，含过期与吊销路径）、并发结果不串线（5 条混合角色 + `TASK_CONCURRENCY=2`）。**跨进程并发超出 Notion Phase 1 范围，未做；需跨进程锁，不计为未闭合缺口。** **Phase 2：第 1 项（共享产物/证据引用/版本/访问控制）= 1.0、第 2 项（私有上下文分离/按需投影/来源追踪）= 1.0（2026-11-05，本地分支 `phase2/blackboard-2026-11-05`，未 push）；第 3 项（验收句端到端）= 1.0（`59b09cb`），**Phase 2 三句合计 3/3**。**Phase 3：第 1/2/3 项均 1.0（`phase3/verification-loop-2026-11-05`；真实模型审校能力未验证）。Phase 4：第 1 项 1.0（仅机制齐备，非退出判据满足）、第 2 项 0.5（未证实）、第 3 项未做/不适用；策略默认关闭，退出判据未满足。**
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
| Phase 1：单主控 + 动态 Worker Pool | “在现有 Runtime 内建立统一 Planner / Orchestrator 接口”“支持少量 Agent 的能力匹配、动态分配、并行和依赖管理”“保留单 Agent 快速路径；先选 2—3 个真实专业 Agent 验证” | “任务路由可追踪、Worker Session 隔离、并发结果不串线、预算硬限制有效” | 1.0 | `server/agents/orchestrator.js` + `tests/agent-orchestrator.test.js` 12 条（交付物 1 的 4 条，`93c5b51`；交付物 2 的 7 条 2a–2g，`6a3cc84`；真实注册表路由 1 条，本轮 `agent-orchestrator` 11→12）；`server/agents/planner.js` + `tests/agent-planner.test.js` 4 条（Planner 侧 a–d，计划只落 workflow-store）；`server/agents/dependencies.js`（唯一 `isReady` + `validateGraph`）+ `server/agents/tasks.js`（`dependsOn`/`settleDependencies`）+ `server/agents/runtime.js`（取队前 settle + runTask 前置校验）+ `tests/agent-worker.test.js` 44 条（依赖 5 条 + 并发上限 1 条 + 令牌/HTTP 5 条 + 5 条混合角色并发 1 条，`agent-worker` 37→44）；`server/agents/worker-scope.js` + 服务端作用域令牌（`issueScopeToken`/`revokeScopeToken`，sha256 映射 + allowlist + TTL；HTTP 读端点只认 `x-worker-scope-token`）；`server/agents/manifest.js` 新增 researcher/executor/reviewer 三个真实 Manifest + 真实 LongCat-2.5 一轮验证（证据见「交付物 3 真实模型验证证据」）；B-06 `tests/agent-budget-atomic.test.js` 7 条（`27b99ec`）+ 真实 usage 结算 | 交付物 1 = **1.0**（Orchestrator 唯一入口 + Planner 规则拆解 + 计划只落既有 workflow-store + 批量多步任务共用同一 planId/planVersion），交付物 2 = **1.0**（四项逐条证据见“交付物 2 四项验收证据”），交付物 3 = **1.0**（三个能力标签可扩展的 Manifest + 真实 LongCat 模型一轮：能力匹配/并行重叠/依赖时序/token usage；见“交付物 3 真实模型验证证据”）；合计 **3.0/3**；4 条验收 **4/4**（路由/隔离/并发/预算，逐条证据见 4–7）。**限定**：三个角色共用同一 LongCat-2.5 模型，只是提示词/能力标签分工，不是异构多模型协作；本轮依赖链下游任务因 `maxTokens=320` 触发 `empty_reply`（依赖时序正确，内容未产出）；**真实模型下的拆解/角色分工质量仍未经评测**；**跨进程并发超出 Notion Phase 1 范围，未做（需跨进程锁），不列为缺口**。下一步＝Phase 2 立项拍板。 |
| Phase 2：Blackboard + Context Broker | “建立任务级共享产物、证据引用、版本和访问控制”“Worker 私有上下文与共享工作区分离”“支持按需上下文投影和来源追踪” | “跨 Agent 可协作但不能越权读取私有 Session；每个共享结论可追溯来源” | 第 1 项 **1.0**；第 2 项 **1.0**；第 3 项 **1.0**（合计 **3/3**） | 第 1 项（2026-11-05，`c60a1bb` + `4573bc6`）：`share()`/`sharedAccess()`/`readSharedArtifact()` + 令牌第二道门 + `publishSharedConclusion()` 证据门禁。第 2 项（2026-11-05，`db4d3cf`）：`worker-scope.projectSharedContext()` 只放行已共享且版本钉住的引用，`artifact-store.resolveProvenance()` 沿 `{kind,id,version}` 链 fail-closed，投影结果仅含产物引用、不带私有 session/messages。第 3 项（2026-11-05，`59b09cb`）：researcher/executor/reviewer 三个真实注册 Agent 的真实任务一次跑通 A→B→复核，executor 自己的 `wst_` 令牌读 reviewer 私有会话在库层与 HTTP 层均 401 且留痕，A 标 invalidated 后 B 的链 `artifact_chain_broken`（reason=invalidated）。用例：`agent-worker` +1（端到端 1 条，含 4+ 证据采集点与事件/审计时间线）；全量 2199/2199 通过。详见「Phase 2 第 1 项验收证据」「Phase 2 第 2 项验收证据」「Phase 2 第 3 项验收证据」 | 三项完成，但**未新增 HTTP 路由**（库级 API + 复用既有会话读端点）；runtime 不自动投影/自动发布；**尚无撤销共享/逐产物吊销入口**；证据均为同进程 + stub Provider，真实模型协作质量未验证。下一步＝Phase 3 立项拍板（待 Owner）。 |
| Phase 3：验证闭环 + 事件化工作流 | “引入确定性验证、独立 Reviewer、冲突处理和人工审批节点”“事件、状态、结果投递采用幂等与可恢复设计”“建立失败重试、取消、Checkpoint、死信和成本追踪” | “失败注入、重复事件、Reviewer 检出率和结果投递恢复均有测试证据” | 第 1/2/3 项均 **1.0**（Phase 3 完成） | 第 1 项（2026-11-05，`phase3/verification-loop-2026-11-05`，`3370441` + `a9e500a`）：`server/agents/verification-loop.js`（确定性校验/独立审校/冲突裁决/审批门）+ `runtime.js` 完成前门禁 + `approvals.js` 门禁操作 + `tests/agent-verification-loop.test.js` 7 条。已有局部复用：审批 `approvals.js`、幂等账本 `op-ledger.js`（`a6d3455`）、崩溃注入 `tests/agent-crash-injection.test.js`。验收证据见「Phase 3 第 1 项验收证据」 | 第 1 项完成：三处失败注入 + 10 条构造样本混淆矩阵（TP 7/FN 0/TN 2/FP 1）+ 超时不通过。第 2 项完成（重复事件去重 + 投递崩溃恢复，真实探针见「Phase 3 第 2 项」）。**未验证**：真实模型审校能力；第 3 项（死信/成本追踪）完成，见「Phase 3 第 3 项」。下一步＝Phase 4 入口。 |
| Phase 4：受控自治与自我改进 | “根据真实运行数据动态组队、重规划和选择验证强度”“建立离线评测集、策略版本、灰度发布和回滚”“在权限、预算和审批边界不变的前提下，逐步开放低风险自动化” | “相对基线在成功率、返工率、成本或延迟上有可重复改善，且安全指标不退化” | 第 1 项 **1.0**（机制齐备，非退出判据满足）；第 2 项 **0.5**（未证实）；第 3 项**未做/不适用** | 第 1 项（2026-11-05，`phase4/eval-baseline-2026-11-05`，`2120311` + `97874c5` + `00336e5`）：`server/agents/eval-suite-v1.json`（5 条固定用例）、`eval-suite.js`/`eval-runner.js`/`eval-metrics.js`/`eval-baseline.js`/`strategy-version.js` + `scripts/eval-offline.js` + `tests/agent-eval-baseline.test.js` 7 条；真实输出与收口门禁见「Phase 4 第 1 项」 | 第 1 项 **1.0 仅指交付物机制齐**（评测集/指标/基线/对比/策略版本最小闭环均可复跑），**不是 Notion 退出判据已满足**：第 2 项后续完成真实 3+3 轮：配对复现 1/3、token +44.0%，判 0.5；第 3 项（灰度发布/逐步开放）未做。最终阶段判定＝退出判据未满足，策略默认关闭，详见「Phase 4 终态收口」。 2026-11-06 核实补充：回滚已落地（strategy-version.js 的 rollback 与 setEnabled），第 3 项缺的是灰度发布而非回滚；第 2 项的 historicalSuccessRate 是调用方入参、不读真实运行统计，故仍未由真实数据驱动。 |

---

## 表 2 · 25 项验收归属台账（25 行）

> A 组原句出自 §22（v1.1 验收清单），B 组原句出自 §30（v1.2 编码验收门槛）。
> 两节在原文中均为**无编号 checkbox，且未挂到任何阶段**；编号 A-01…B-11 是仓库 v1.3 自加的。
> 链接统一为同一页面：`https://app.notion.com/p/40da957523c281359607e23f6a3c784f`（下表只标 § 小节）。

| 编号 | 验收项原文（引句 · §） | 归属阶段 | 对应交付物 / 退出判据（原文依据） | 状态 | 证据 | 未完成原因 + 下一步 |
|---|---|---|---|---|---|---|
| A-01 | “计划版本迁移覆盖 plan/task 映射、运行中节点、产物复用和副作用补偿”· §22；规则见 §10 | 待确认（依据：§10 讲 planVersion v1→v2，未写阶段） | §10 迁移表（6 种映射：reused/continued/replaced/cancelled/superseded/revalidated）+ §10 “Task-level 规则”；退出判据未单写 | 0.5 → 1.0（旧值保留，勘误 2026-11-05） | `8bacccc`；`server/agents/workflow-store.js`（版本不可变、单调 +1，`f279b37`）；任务绑定冻结计划 `6f83ecc`；`tests/agent-workflow-store.test.js` a–m、`tests/agent-workflow-binding.test.js` 1–8；2026-11-05（架构批次 A-01）：`workflow-store.js` 新增 `plan-migration-v1`——`planTaskMigration` 把 queued/accepted/retrying 映射到新版本、running/waiting_approval/recovery 保持原版本、终态不动；`artifactReuseDecision` 按 §13 七项（输入步骤、来源与污点、时效、schema、验收条件、权限范围、依赖产物版本）逐项 fail-closed；不可复用产物经既有 op-ledger override 派生新 opKey 作副作用补偿；`migratePlanVersion` 复用 `appendVersion` 并写 `migrate_plan` 审计。`tests/agent-workflow-store.test.js` 新增 2 条（七项逐项拒绝、映射与 reused 保留 provenance/taint、tainted 走 revalidated + compensation） | 限定：`generation/fencing token` 未见证据段覆盖；迁移（queued/accepted/retrying 迁新版、running/waiting_approval/recovery 保持、终态不动）、七项复用 fail-closed 与 op-ledger 补偿均按证据段落。 2026-11-06 核实补充：fencing（过期代次拦截）是 §17 第 5 行的要求，登记为 FM-4；本行按 §10 迁移规则维持 1.0，不代表 fencing 已完成。 |
| A-02 | “Blackboard CAS、版本裁决和冲突处理明确”· §22；规则见 §11 | 待确认（依据：§11 是 Blackboard 并发写，Phase 2 才引入 Blackboard，但原文未写） | §11 `expectedVersion` CAS + conflict 返回 + 不可合并转裁决 | 0 → 1.0（旧值保留，勘误 2026-11-05） | `f419dd9`；任务级 CAS：`server/agents/tasks.js:986-1005`、`errors.js:30-44`（`288730a`）、`tests/agent-recovery.test.js:492`；**Blackboard 不存在**（`artifact-store.js:8` 注释）；2026-11-05（架构批次 A-02）：`artifact-store.js` 落盘新增 `stateVersion`（单调 +1）与 `expectedVersion` 校验，冲突复用 `conflictError()` 返回 409 七字段并落 `ConflictRecord`（temporal/open，candidateRefs/evidenceRefs 记 expected/current）；同一 `taskId+kind` 内容变化生成新版本并把旧版本置 `superseded`、记 `supersededBy`；`tests/agent-artifact-content.test.js` 新增 2 条（真实两次 persist 一成功一 409、expectedVersion 过期被拒且原记录不变、superseded 链可复读） | 限定：CAS 落在 Artifact Store 的 `stateVersion`；409 复用 `conflictError()` 七字段并落 `ConflictRecord`；旧版本置 `superseded` 并记 `supersededBy`。 |
| A-03 | “State Store / Blackboard 各自事实权威及跨 Store 恢复明确”· §22；规则见 §11 | 待确认（依据：§11 完成提交协议，仓库归在 Phase 1 前置 ③，原文未写） | §11 五步完成提交 + “提交意图 / Outbox、幂等关联和恢复扫描” | 0.5 → 1.0（旧值保留，勘误 2026-11-05） | `f8555ac`；`server/agents/artifact-commit.js:106-149`（`scanPendingCommits`、orphan TTL）；`artifact-store.js` `COMMIT_STATES`；`6204f06`；`tests/agent-crash-injection.test.js:166` c1；2026-11-05（架构批次 A-03）：新增 `artifact-store.verifyRefsReadable`（not_found/kind_mismatch/version_mismatch/invalidated/superseded_chain_broken/正文不可读，只返回不抛）；`tasks.recoverInterrupted` 在租约检查后校验 task 引用产物，断裂即走既有 recoveryPath 进 `recovery`、写 `task.recovered`（mode=cross_store_verify）；权威边界写入 `docs/artifact-commit-chain-audit-2026-11-03.md` 附三；`tests/agent-recovery.test.js` 新增 2 条（删记录重启进 recovery、正常重启不误报） | 限定：`verifyRefsReadable` 只返回不抛；跨 Store 断裂走既有 `recoveryPath` 进 `recovery` 并写 `task.recovered`（mode=cross_store_verify）；权威边界见 `docs/artifact-commit-chain-audit-2026-11-03.md` 附三。 |
| A-04 | “冲突裁决权、证据顺序和升级路径明确”· §22；规则见 §12 | 待确认（依据：§12 冲突裁决 + §28 ConflictRecord，原文未写阶段） | §12 裁决顺序（确定性→Reviewer→人工）+ §28 五类冲突枚举 | 0 → 1.0（旧值保留，勘误 2026-11-05） | `102b596`；全 `server/` grep `ConflictRecord\|conflictId\|resolutionStatus` 零命中；2026-11-05（架构批次 A-04）：`verification-loop.js` 新增 `conflict-arbitration-v1` 纯函数——`orderEvidence`（deterministic 3 > independent-review 2 > human 1 > 非独立 0）、`isIndependentReviewEvidence`（不同 taskId + reviewer bot）、`authorizeArbiter`（Verification Engine/Reviewer/人工，越权 403）、`arbitrateConflict`（证据不足→escalated）；升级只走既有 `review.conflict`/`review.escalate`，`recordArbitration` 落审计；`tests/agent-verification-loop.test.js` 新增 3 条（证据不足升级、证据按序裁决并留痕、越权/政策冲突/未知主体被拒） | 限定：证据不足→escalated；升级只走既有 `review.conflict`/`review.escalate`；越权/政策冲突/未知主体被拒。 |
| A-05 | “trustLevel 仅由验证层写入”· §22；硬约束见 §12 | 待确认（原文未写） | §12 硬约束 + §27 写入条件 | 1.0 | `016320b`：`server/agents/artifact-store.js` `TRUST_LEVELS`/`TRUST_WRITER='verification-engine'`/`setTrustLevel`（非验证器写入 `not_authorized` 403、非法值 400，均不改已存值并写 `artifact.trust_level_write_rejected` 审计）；`verification-loop.js` `applyArtifactTrustLevel` 为 Engine 侧唯一写封装；`runtime.js` 按门禁顺序落档（`declared`→`evidence_checked`→`independently_verified`）；`tasks.js` 对 `updateTask`/`transitionTask` 传 `trustLevel`/`trust` 在字段变更前拒绝并写 `task.trust_level_write_rejected`。用例 `tests/agent-trust-level.test.js` 7 条 + `tests/agent-trust-level-runtime.test.js` 5 条（真跑 runtime + 独立 Reviewer，未 mock 验证器；断言 `not_authorized` 403、4 条 `task.trust_level_write_rejected` 事件与 `artifact.trust_level_write_rejected` 审计） | 限定：`declared` 由 Engine 在落盘后统一写入，不是 Producer 可传字段；`trustLevel` 不参与任何授权判定；旧数据缺字段读 `untrusted`；`TRUST_POLICY_VERSION='trust-rules-v1'`、`trust.reason` 字段名、`scope=independent-review:<taskId>` 形态均为本仓库裁决。 |
| A-06 | “风险分级验证、验证成本和质量指标明确”· §22；规则见 §13 | 待确认（原文未写） | §13 R0–R3 表（最低验证/审批）+ 漏检率/误拦截率/验证开销统计 | 0.5 | 工具风险映射：`server/agent-runtime.js` `FAIL_OPEN_RISK`、`server/agents/failopen-policy.js`（`c8283ca`）；审批风险 `medium→R2 / high→R3`：`approvals.js:52-54` | 只有“风险等级映射”，没有按等级分派验证强度，也没有成本/漏检/误拦截指标。**需真实模型环境样本集**才能产出评测报告。 2026-11-06 原文对齐：§13 要求 Policy Engine 按风险、可逆性、影响范围、数据敏感度、来源污点、外部副作用、失败代价七因子取最高适用等级，缺信息升一级且 Agent 不得自行降级；现状等级只来自 agent-runtime.js 的 FAIL_OPEN_RISK 标签映射与 approvals.js 的 medium→R2 / high→R3，autonomy-policy.verificationStrength 属 risk 驱动的分派而非七因子路由；漏检率与误拦截率计数器仍无。 |
| A-07 | “Benchmark 基线可选且记录完整配置；评测集有 holdout 和轮换”· §22；规则见 §14 | 待确认（原文未写） | §14 五类可比较基线 + 配置记录字段 + holdout/轮换规则 | 0 | 全仓 `.js` grep `benchmark\|holdout` 零命中 | 未开始；**必须真实模型环境与可重复评测数据**。数值需压测/样本，留接口与版本位。 2026-11-06 原文对齐：eval-suite-v1.json 已有 13 条用例与 6 类 taskType，快照含 codeCommit、strategy、suite 字段；仍缺 §14 的五类可比较对象（生产或主分支 Runtime、单 Agent 快速路径、当前 Runtime 加指定能力、关闭某机制的消融版本、候选架构）、配置记录中的提示词版本与工具权限项，以及开发集/验证集/holdout/轮换挑战集分层（用例无 split 字段，holdout 零命中）。判定维持 0。 |
| A-08 | “审批超时、批量、升级和申诉规则明确”· §22；规则见 §15 | 待确认（依据：§15 审批吞吐，原文未写） | §15 动作/参数摘要/影响/风险/证据/有效期；批量规则；超时升级；申诉复核 | 0.5 → 1.0（旧值保留，勘误 2026-11-05） | `approvals.js:49` `R2_SLA_MS=30min`、`escalationAt`（50%）、`overdue/escalatedAt`；`tests/agent-approval-policy.test.js` a、b、c；2026-11-05（`0057221`）：`approvals.js` 新增 `batchDecide`（同风险/同动作逐条 `decide` 落 `approval.resolved` + `batchId`，单条失败记 `approval_batch_mismatch`/`approval_not_found` 且不吞其它条）、`appealApproval`/`resolveAppeal`（被拒后一次申诉，`appeals[]` 追加、`originalDecision` 冻结原裁决、仅 overturn 改判并写回原记录）、`approvalQueueDistribution`（按风险/操作/等待桶分布，`metrics` 全 null + `source:'requires_load_test'`）；`tests/agent-approval-batch-appeal.test.js` 8 条 | 限定：批量上限 10 / 申诉 24h 内仅一次 / 仅 `local-owner` 可申诉 = 本仓库裁决，非 Notion 原文（版本 `approval-batch-v1`、`approval-appeal-v1`、`approval-workload-v1`）；吞吐/SLA/P95 指标未填（需压测）；overturn 不复活已 cancelled 任务、不重置 SLA。 2026-11-06 原文对齐：批量审批（approval-batch-v1，单次上限 10）与申诉（approval-appeal-v1，24 小时且仅一次、只允许 local-owner）已落地；残余缺口是 §15 的轮值与责任人分配、等待时长与积压量指标。 |
| A-09 | “provenance / taint 贯穿 Task、Artifact 和 Tool Gateway”· §22；规则见 §16 | 待确认（原文未写） | §16 Task Contract 增 `provenanceRefs/taintLabels/taintPolicyVersion`，Gateway 每次校验 | 1.0 | 第一轮 `5769609`：`artifact-store.js`（`TAINT_*`/`normalize*`/`setTaintLabels`/`markTaintVerified`）、`tasks.js`（Task 字段 + 写入拒绝）、`tool-gateway.js`（来源链校验）、`artifact-commit.js`（派生产物继承）；`tests/agent-provenance.test.js` a–e。第二轮 `7fe1cd4`：`server/agents/taint-policy.js`（`taint-policy-v1` 版本化策略）、`tasks.js`（`appendProvenanceRefs`/`appendTaintLabels`）、`worker-scope.js`（读路径继承）、`tool-gateway.js`（每次判定 `taint_tool_denied`）、`runtime.js`（实时 `getTaintState` + `tool.policy_decision`）；`tests/agent-taint-policy.test.js` f–j；判定回填 `2cd6251`。第三轮（2026-11-05，真实模型）：`scripts/run-taint-propagation-realmodel.js` 用 LongCat-2.5 真跑「上游带污点产物 → 下游 Worker Scope 读取 → 派生产物」，五项检查全命中（`provenanceRefs` 真实追加 `art_4acda03…@1`、任务/派生物 taint 并集 `agent:derived + unverified + web:vendor-a.example`、Producer 清除 403 `not_authorized` 且审计 `artifact.taint_write_rejected`、真实模型发起 `memory_search` 被 Gateway 以 `taint_provenance_broken` 拒绝）；记录 `docs/e2e-taint-propagation-2026-11-05.md` + `.json`（Token 4,386、延迟 38,201ms、成本 provider 未返回）。 | 缺口①②均以真跑闭合：跨 Agent 读自动追加 `{kind,id,version}` 并继承 taint（f/j）、带污点任务副作用工具被拒且只读放行（g）、高 trustLevel+污点不获额外权限（h）、策略版本与 fail-closed（i）。限定：`authorizeSessionRead` 与 `memory_search` 无 version，只接 taint 不接 ref；HTTP 级用例未单独跑（复用同一库函数）；`taintLabels` 取值、规则映射、`taint-policy-v1` 默认值均为本仓库裁决，非 Notion 原文标准。真实模型补验仍未覆盖：跨进程隔离、`markTaintVerified` 验证路径改写、`version_mismatch/invalidated/stale/cycle` 等其它断链形态、`resolveProvenance` 深度 >3 拒绝分支（均继续按未验证记录）。 |
| A-10 | “失败模式清单和 Artifact 环检测明确”· §22；规则见 §17 | 待确认（原文未写） | §17 九类失败模式表 + 三类图环检测（委派/依赖/产物 lineage） | 1.0 → 0.5（勘误 2026-11-06：按 §17 原文九类逐行核对只命中 4 类，详见「§17 失败模式原文对齐」节；旧值保留不抹历史） | 依赖环检测（2026-11-04）：`server/agents/dependencies.js` `validateGraph`（Kahn 拓扑余集判定）+ `tests/agent-orchestrator.test.js` 交付物2f（A↔B → 409 `dependency_cycle`、`taskCountBefore=0/taskCountAfter=0`）、交付物2g（悬空引用 400 零落盘）；委派环 + 产物 lineage 环（2026-11-05，`c87b61a`）：`server/agents/cycle-detection.js`（节点/耗时/出边上限）+ `tests/agent-cycle-detection.test.js` 6 条（委派环 `t1→t2→t3→t1` 403 带完整路径、lineage 环 `art_A→art_B→art_C→art_A` 400 带路径、真实入口持久化被拒且产物文件条数不变）；2026-11-05（`9762aef`）：`errors.js` 九类枚举 `FAILURE_MODES`（dependency_cycle / dependency_deadlock / event_out_of_order / duplicate_execution / stale_lease / artifact_chain_broken / partial_commit / budget_exhausted / approval_stall）+ `classifyFailureMode` + `failureModeDisposition`（动作仅 retry/recovery/terminal/escalate 四类）；接线：`dependencies.js detectDeadlocks`（非终态连边 DFS 找环）、`tasks.js settleDependencies` 死锁收口（accepted→failed 且 `errorCode=dependency_deadlock`）、`recoverInterrupted` 乱序恢复 + `detectEventOrderViolations`、`approvals.js markOverdue/escalateApproval` 事件带 `approval_stall`；`tests/agent-failure-modes.test.js` 10 条真注入（真实成环/双建/租约过期/删 index/完成提交失败/预算闸门/审批超时） | 限定：§17 原文只给九类名称、未给处置映射，处置按既有语义映射并标“本仓库裁决”；未新增状态（复用 recovery/failed/waiting_approval/completed）；`partial_commit` 走既有 `scanPendingCommits` 恢复、`duplicate_execution` 收敛 completed 而非新状态。 缺口编号：FM-1 角色漂移、FM-2 交接上下文丢失、FM-3 委派链权限逐跳放大、FM-4 计划版本竞争与 fencing token、FM-5 验证器同源偏差（功能已在 verification-loop 的 producer 与 reviewer 同体判定里，但未纳入 FAILURE_MODES 命名与处置路由）、FM-6 重规划风暴判据（熔断、停止重规划、部分结果交付）。三类图环检测（委派、依赖、产物 lineage）已满足原文要求。 |
| A-11 | “规划 / 审批 / 验证延迟纳入 SLO，有停止重规划判据”· §22；规则见 §18 | 待确认（原文未写） | §18 P50/P95/P99 采集 + deadline/剩余预算/最小收益门槛 | 0 → 0.5（勘误 2026-11-06：monitoring 已产出近似 P50/P95/P99） | `runtime.js` 仅 `tool_call_budget` 截断（`:462`），非 SLO；无重规划停止判据 | 未开始；SLO 阈值需真实运行数据。数值需压测/样本，留接口与版本位。 2026-11-06 原文对齐：已具备 monitoring/index.js 的 duration avg/p50/p95/p99 与 approximate_percentiles 标记，以及 task、model、tool、http 四类 P95；runtime 的 deadline、agent-limits 的重规划次数上限、decideReplan 的剩余预算判据对应 §18 四条停止判据中的三条。仍缺最小预期收益门槛、规划耗时占比与审批等待分位（approvals.js 显式返回 p50WaitMs 与 p95WaitMs 为 null）。 |
| A-12 | “组件预算、stub 边界和 Owner 角色明确”· §22；规则见 §19 | 待确认（依据：§19 说“Phase 0 必须明确到人”，原文未写阶段归属） | §19 6 个交付模块表 + Owner 角色 + 可 stub 清单 | 0.5 | v1.3 §41 责任人已指定（`e950997` 文档记录） | 条目判据要求“管理评审记录（非代码测试）”，无记录；按硬规矩不计 1。待触发条件：等 Owner 签 §41 责任人记录。 |
| A-13 | “有端到端 worked example”· §22；示例见 §20 | 待确认（原文未写） | §20 十三步流程（含 planVersion v2、fencing、waiting_approval） | 0 → 1.0（旧值保留，勘误 2026-11-05） | 2026-11-05（`aacff59`）：`scripts/run-worked-example.js` 九步真跑（两个 researcher 任务并行 → A1/B1 带来源/时间/provenance/taint → 验证做 schema/引用/来源检查 → Reviewer 独立裁决冲突 C1 → 交付建议+来源+分歧处理+剩余不确定性 → trace/Token/延迟/成本）；`tests/agent-worked-example-e2e.test.js` 1 条；运行记录 `docs/e2e-worked-example-2026-11-05.md` + `docs/e2e-worked-example-run-2026-11-05.json`（traceId `trace_77086298-25a5-4ec1-82ab-5efdafbc3cbf`、Token 894 来自 provider reported、总耗时 805ms、成本“未采集”）；2026-11-05 真实模型复跑（共 7 轮，最终通过）：`scripts/run-worked-example.js --real-provider` 用 LongCat-2.5 跑九步，traceId `trace_9b0c48ab-f21f-46db-b9f6-b72763691210`，`parallel=true`，Reviewer 独立 `decision=pass` 选中 A1，Token 4,142（A 560 + B 571 + Reviewer 3,011），延迟 A 7,266ms / B 4,293ms / Reviewer 36,237ms，总耗时 43,661ms，成本 provider 未返回；6 次作废轮与可核实 Token 17,870（第 1 轮未采集）见 `docs/e2e-worked-example-2026-11-05-realmodel.md` | 限定：真实模型样本为 1 次通过（共 7 轮，含 6 次作废）；§20 十三步中的 planVersion v2 / fencing / waiting_approval 未纳入 Owner 本轮九步口径；A/B 事实材料由脚本给定，不证明外部检索真实性；成本无 provider 计价字段。 2026-11-06 核实补充：§20 十三步里的 fencing 属 FM-4，本行 1.0 只覆盖九步端到端可复跑与证据留痕。 |
| A-14 | “Phase 0 有降级分支和退出条件”· §22；规则见 §21 | 待确认（依据：§21 标题即 Phase 0，原文未写归属阶段） | §21 A–E 五分支 + “出现…时暂停或降级”退出条件 | 0.5 → 1.0（旧值保留，勘误 2026-11-05） | `docs/phase0-baseline-audit-2026-11-03.md` §8（判定 B）、§8.2（退出判据＝§11 三条 + §15 fail-closed）；2026-11-05（`b36db0c`）：新增 `server/agents/phase0-degradation.js`（`phase0-degradation-v1`）——7 项退出判据 `EXIT_CRITERIA`（authoritySeparated/completionCommit/cas/approvalFailClosed/sessionIsolation/auditChain/delegationHardLimit）、B/C/D/E 四分支 `triggers`+`allowedScope`+`forbiddenScope`、优先级 E>B>C>D、缺失/未知/非 true 一律 fail-closed；`probePhase0Gates()` 用既有导出真探针；`scripts/check-phase0-degradation.js`（`--json`/`--gates`，退出码 0=可退出降级 / 1=仍在降级 / 2=异常）真跑输出 `decision=exit_degraded` EXIT 0；`tests/agent-phase0-degradation.test.js` 9 条 | 限定：C/D 的 optional gate（`blackboardConsistency`/`verificationCostWithinBudget`/`permissionsEnforced`）缺失不算失败、需显式注入才触发；§21 原文未给分支优先级与退出判据项数，7 项与 E>B>C>D 为本仓库裁决。 |
| B-01 | “六类错误码及 `retryable` 进入统一 Result / Error Contract”· §30；规则见 §23 | 待确认（原文未写） | §23 六类枚举表 + 七字段（errorCode/retryable/errorFingerprint/failedAt/taskId/runId/可选 causeRef） | 0.5 → 1.0（旧值保留，勘误 2026-11-05） | `d5dcf77`：`errors.js` 新增 `ERROR_RETRYABLE` 与 `errorContractFingerprint`（sha256(code\|taskId\|runId\|causeRef\|message)），在 `describeAgentError` 序列化边界补齐七字段；`code/error/status` 与既有附加字段不覆盖，HTTP 状态码不变。`tests/agent-error-contract.test.js` 6 条：五类各一条断言七字段齐备、同输入同指纹、`retryable` 为 `false/false/false/true/true`（validation_failed/not_authorized/budget_exceeded/dependency_failed/internal_error），并验证 `budget_exceeded` 既有 `scope/required/remaining` 不丢；无 details 时补 `taskId=''`、`runId=null`、`causeRef=null`。 | 限定：字段在响应序列化时补齐，不是抛出时补齐，进程内调用方拿到的 `AgentError` 仍只有原 details；无 taskId/runId 上下文的错误取空值。 |
| B-02 | “Gateway 不负责重试决策；Workflow Engine 独占”· §30；规则见 §23 | 待确认（原文未写） | §23 职责边界（Gateway 只报类别与建议） | 0.5 → 1.0（旧值保留，勘误 2026-11-05） | `f8caa23`；`server/agent-runtime.js` `executeToolCall` 无重试分支；`runtime.js:962` 的 `maxAttempts` 属模型/任务重试；2026-11-05（架构批次 B-02）：`runtime.js` 新增唯一决策入口 `decideFailureDisposition`（run/dispatch 两阶段：retry/recovery/cancelled/terminal/retry_dispatch），调度与运行失败分支全部收敛到该函数；`tool-gateway.js` 头部注明只返回结果与错误、无重试入口；`tests/agent-verification-loop.test.js` 新增 2 条（Gateway 单次判定无状态漂移且不导出 retry、Engine 七种场景按 retryable 决策、非重试直接终态） | 限定：`tool-gateway.js` 仅头部注明无重试，未加静态检查；决策入口为 `decideFailureDisposition`（run/dispatch 两阶段）。 |
| B-03 | “`retrying` / `recovery` 是正式状态，且仅 Engine 可写”· §30；规则见 §24.1 | 待确认（原文未写） | §24.1 状态集合 + 两态语义 + “只有 Workflow Engine 可写 Task 状态” | 0.5 → 1.0（旧值保留，勘误 2026-11-05） | `8d26d0b`：`updateTask` 已拒绝 `status`（`task_status_requires_transition`）、`checkpointVersion`；本轮补 `stateVersion` 显式只读门禁（`task_state_version_read_only`），并在 `applyTransition` 拒绝非法迁移时写 `task.transition_rejected` 事件（from/to/reason；审计失败不掩盖原拒绝）。既有：`server/agents/state-machine.js:18-48`；`tasks.js` `transitionTask` 唯一入口（`8da8a89`、`8f08807`、`30d5ce7`）；`tests/agent-recovery.test.js:58`、`:85`、`:237`、`:280`、`:296`。`tests/agent-task-transition-guard.test.js` 2 条：绕过 `transitionTask` 写 `status`、直接写 `stateVersion` 均失败且状态/版本原样；`queued→running` 非法迁移返回 `invalid_transition` 409，事件含 `{fromStatus:'queued',toStatus:'running',reason:'invalid_transition'}`，状态不变。 | 限定：审计只覆盖经 `applyTransition` 的路径；直接改写存储文件不在审计范围。 |
| B-04 | “状态迁移表、前置条件、`expectedStateVersion` 和非法迁移审计可测试”· §30；规则见 §24.2–24.3 | 待确认（原文未写） | §24.2 合法迁移表 + §24.3 五项校验依据 | 0.5 → 1.0（旧值保留，勘误 2026-11-05） | `8d26d0b`：`updateTask` 拒绝 `status`（`task_status_requires_transition`）与 `checkpointVersion`；补 `stateVersion` 显式只读门禁（`task_state_version_read_only`）；`applyTransition` 拒绝非法迁移时写 `task.transition_rejected`（from/to/reason；审计失败不掩盖原拒绝）。既有：`tasks.js:986-1005`（expectedVersion）、`task-store.js:65-68`（stateVersion）、`state-machine.js`；`tests/agent-recovery.test.js:492`（CAS 冲突）、`:568`。`tests/agent-task-transition-guard.test.js` 2 条：绕过 `transitionTask` 写 `status`、直接写 `stateVersion` 均失败且状态/版本原样；`queued→running` 非法迁移返回 `invalid_transition` 409，事件含 `{fromStatus:'queued',toStatus:'running',reason:'invalid_transition'}`，状态不变。 | 限定：审计只覆盖经 `applyTransition` 的路径；直接改写存储文件不在审计范围。 |
| B-05 | “委派深度 2、单 Task 重规划 2 次、单 Run 重试 3 次有服务端硬限制”· §30；规则见 §25 | 待确认（原文未写） | §25 三条硬上限（depth 2 / replan 2 / run retry 3） | 0 → 1.0（旧值保留，勘误 2026-11-05） | `12dcdba`：`server/agents/agent-limits.js` 持久化 `agents/agent-run-limits.json`；`tasks.createTask` 父任务入口先校验委派深度；`recordReplan` 以 Run 键统一计数（Task 键只记录、不作为绕过途径）；`recordRunRetry` 同口径；超限按 §23 六类选码（深度＝`not_authorized` 403，重规划/Run 重试＝`validation_failed` 400），七字段齐备。`tests/agent-run-limits.test.js` 4 条：深度 3 被拒（`delegation_depth_exceeded`）；重规划第 3 次被拒（`replan_limit_exceeded`）；第 4 次 Run 重试被拒（`run_retry_limit_exceeded`）；清 require 缓存重载模块（模拟进程重启）后计数仍为 2/3，不归零。 | 限定：计数为单进程原子写，跨进程并发未加锁（不在本轮范围）；`replanCount` 采用 Owner 口径（Run 级统一最多 2），比原文“单 Task 2”更严，原文 §25 与 §26 措辞差异列入待确认。 |
| B-06 | “Task Token hard budget 原子计量，Run 总预算作为额外闸门”· §30；规则见 §25 预算规则 | 待确认（依据：§5 Phase 1 验收句含“预算硬限制有效”，但未写条目归属） | §25 预算规则：Task 硬上限必填、父子覆盖、服务端原子预留/扣减、重试不重置、Run 总闸门 | 1 | `27b99ec`；用例 `tests/agent-budget-atomic.test.js` B-06a（真并发仅一成功）、b（重试不重置）、c（父子覆盖）、d（结算差额）、e（release）、f（Run 闸门）、g（缺上限拒绝）；实现 `server/agents/tasks.js:631`（reserve）/`:696`（settle）/`:730`（release）/`:908`（父覆盖）/`:942`（Run 建档）、`errors.js:52`（budget_exceeded retryable=false）、`runtime.js:822`（执行前 reserve）；**真实 usage 证据（2026-11-04）**：LongCat-2.5 一轮 5 个任务结算 `used` = 2849/4156/4191/4337/1296（供应商 usage，非估算），连通性 29；见「交付物 3 真实模型验证证据」 | 真实供应商 usage 已验证；**跨进程/多实例并发仍不在用例保证范围**（本缺口不改变本条判 1，仅作限定记录）。 |
| B-07 | “限流、熔断、重规划风暴抑制有配置、状态和测试”· §30；规则见 §26 | 待确认（原文未写） | §26 Run/Task/Agent/Provider 四维限流 + closed/open/half-open + 风暴抑制 | 0 | `watchdog-policy.js:115-152` 的 breaker 只针对 watchdog 动作（alert/pause_intake/restart），非 Provider/工具/Worker；无四维限流、无重规划风暴抑制 | 需压测报告与风暴场景测试；现有 breaker 不可计为本条。数值需压测/样本，留接口与版本位。 2026-11-06 原文对齐：已有 agent-limits 的 Run 级重规划与重试硬限、tasks.js 的 retryAt 退避出队；仍缺 §26 的四维令牌桶或信号量与版本化阈值、Provider/工具/Worker 的 closed、open、half-open 三态 breaker（现仅 watchdog 动作级 open 与 cooldownActive）、以及收益声明、相同 errorFingerprint 等价计划拒绝、冷却窗口、计划 diff 判据、禁止新建 run 规避上限。判定维持 0。 |
| B-08 | “`trustLevel` 四档枚举及唯一写入者约束落到服务端”· §30；规则见 §27 | 待确认（原文未写） | §27 untrusted < declared < evidence_checked < independently_verified | 0 → 1.0（旧值保留，勘误 2026-11-05） | `6da3538` + 本轮接线：`artifact-store.js` 新增 `TRUST_LEVELS` 有序枚举、`TRUST_WRITER='verification-engine'`、`trustRank/trustAtLeast`；`setTrustLevel` 非验证器写入一律 `not_authorized` 403、非法值 400，均不改已存值并写 `artifact.trust_level_write_rejected` 审计；每次变更写 `artifact.trust_level_changed`（`前档->后档\|原因`）；新 `persist` 记录默认 `untrusted`；`readTrustLevel` 对缺字段旧记录回退 `untrusted`（fail-closed）。端到端：`verification-loop.js` `TRUST_POLICY_VERSION='trust-rules-v1'` 与 `applyArtifactTrustLevel`；`runtime.js` 按门禁顺序落档 `declared`→`evidence_checked`→`independently_verified`。`tests/agent-trust-level.test.js` 7 条 + `tests/agent-trust-level-runtime.test.js` 5 条。 | 限定：`declared` 目前由 Engine 在落盘后统一写入（= 生产者声明的最低档），不是 Producer 可传入的字段；所有产物（含工具产物）都走同一映射；被 invalidated 的产物保留 `declared` 记录（`status` 另行表达失效）；`trustLevel` 仍不参与任何授权判定，因此没有“高信任免共享”的实现，也无需实现。 |
| B-09 | “`ConflictRecord` 可序列化、可持久化、可审计”· §30；规则见 §28 | 待确认（原文未写） | §28 十二字段表 + 裁决顺序 | 0 → 1.0（旧值保留，勘误 2026-11-05） | `980ece2`：`server/agents/conflict-record.js`（`agents/agent-conflict-records.json`，原子写）；`runtime.js` 冲突审批分支把 `resolution.outcome==='conflict'` 写入现有 `resolveConflict` 流程（不另建裁决），随后照旧 `invalidateArtifactRefs`。`tests/agent-conflict-record.test.js` 4 条：记录落库后可复读（同 id 幂等）；审计可查（`conflict.recorded` / `conflict.resolved`）；裁决结果与记录一致（`selectedCandidateRef` 必须属 `candidateRefs`，非 resolved 禁止携带裁决结果）；文件损坏时读取抛 `internal_error`（fail-closed）。 | 限定：`candidateRefs`/`evidenceRefs` 元素形态、`policyVersion` 取值、状态迁移表原文未定义（见待确认）；冲突记录只覆盖“冲突→审批”这一条入口，其他冲突路径（若有）未接。 |
| B-10 | “R2 30 分钟转人工 fail-closed；R3 只接受显式批准”· §30；规则见 §29 | 待确认（原文未写） | §29 风险级别 SLA 表 | 1 | `approvals.js:49`（30 min）、`:52-54`（R2/R3 映射）；`tests/agent-approval-policy.test.js` a（R2 到期仍 pending、任务未放行）、b（R3 长期 pending）、g（老记录缺字段 fail-closed） | 核心满足；备注：原文“转人工队列”在代码中体现为 pending 列表（`pendingCount()`），无独立队列实体。 |
| B-11 | “审批请求有持久化 SLA、提醒、升级和取消路径，不会静默永久挂起”· §30；规则见 §29 | 待确认（原文未写） | §29 持久化 deadline/escalationAt、通知重试记录、责任队列；六态 pending/approved/rejected/expired/escalated/cancelled | 0.5 | `approvals.js:36-43` 状态为 pending/approved/rejected/executing/completed/failed；持久化 `riskLevel/expiresAt/escalationAt/policyVersion`；`:496-507` 到期只标记；2026-11-05（架构批次 B-11，additive）：新记录把 SLA 冻结进 `record.sla`（`slaPolicyVersion='approval-sla-v1'`/riskLevel/slaMs/escalationRatio/startedAt/escalationAt/expiresAt），旧记录由 `slaViewOf` 只读派生；新增派生 `state`（六态 + executing/completed/failed）供单一读视图；补 `remindApproval`（计数与 `approval.reminded`）、`escalateApproval`（`approval.escalated`/幂等）、`cancelApproval`（`approval.cancelled`、摘除计时器、收口 waiting_approval 任务并关会话、禁止已执行取消、幂等）；已取消请求不占 pendingCount、不参与到期检查且拒绝 execute；`tests/agent-approval-request.test.js` 新增 5 条。**未硬合并 status**：既有用例要求 escalated/cancelled 时 status 仍 pending，最小可行合并方案与影响面见本轮汇报，待 Owner 拍板 | 已做 additive 合并（`state` 只读派生、`record.sla` 冻结版本、提醒/升级/取消全路径 + 5 条用例，`c6e3ba8`），**未做** `status` 单字段硬合并（会破坏既有审批用例与执行门禁）。 2026-11-06 原文对齐：§29 六态已作为持久字段 requestStatus 落地并带迁移表，escalationAt、escalatedAt、escalationSource 与通知重试 nextRetryAt 均已在；残余缺口是责任人与轮值队列分配、待处理量与超时统计。审批请求态与 Task 的 waiting_approval 分开建模符合原文，不需要合并成单一字段。 |

**汇总（勘误 2026-11-05 第四次回填，以行级证据为准）**：
- 旧值（`fe2a0f9`，上一轮）：`1` = 10 项（A-05、A-09、B-01、B-03、B-04、B-05、B-06、B-08、B-09、B-10）；`0.5` = 9 项（A-01、A-03、A-06、A-08、A-10、A-12、A-14、B-02、B-11）；`0` = 6 项（A-02、A-04、A-07、A-11、A-13、B-07）。合计 10+9+6=25。
- 新值（本轮回填）：`1` = 15 项（A-01、A-02、A-03、A-04、A-05、A-09、B-01、B-02、B-03、B-04、B-05、B-06、B-08、B-09、B-10）；`0.5` = 6 项（A-06、A-08、A-10、A-12、A-14、B-11）；`0` = 4 项（A-07、A-11、A-13、B-07）。合计 15+6+4=25。
- 新值（2026-11-05 第四次回填，A-10/A-14/A-08/A-13 改判）：`1` = 19 项（A-01、A-02、A-03、A-04、A-05、A-08、A-09、A-10、A-13、A-14、B-01、B-02、B-03、B-04、B-05、B-06、B-08、B-09、B-10）；`0.5` = 3 项（A-06、A-12、B-11）；`0` = 3 项（A-07、A-11、B-07）。合计 19+3+3=25。
- 新值（2026-11-06 第五次勘误，A-10 由 1.0 改判 0.5、A-11 由 0 改判 0.5，逐行状态由脚本重扫确认）：`1` = 18 项（A-01、A-02、A-03、A-04、A-05、A-08、A-09、A-13、A-14、B-01、B-02、B-03、B-04、B-05、B-06、B-08、B-09、B-10）；`0.5` = 5 项（A-06、A-10、A-11、A-12、B-11）；`0` = 2 项（A-07、B-07）。合计 18+5+2=25。
> 口径说明：以行级证据为准，汇总行按 2026-11-06 最新勘误重算；行状态与汇总由同一次扫描对齐，不一致时以行状态为准。
> 勘误记录（保留旧值，不抹掉历史）：2026-11-04 初版为 `1`=2（B-06、B-10）/`0.5`=12/`0`=11（把 A-09 计为 0，与行内 0.5 矛盾）；`2cd6251` 版为 `1`=3（A-09、B-06、B-10）/`0.5`=12/`0`=10；`6137c5b` 版为 `1`=4（A-05、A-09、B-06、B-10）/`0.5`=12/`0`=9。

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
| 6 | 需真实环境/压测的 3 项 | A-06（样本集评测报告）、A-07（benchmark/holdout）、B-07（压测报告） | 均无对应数据；A-13 已用本地 stub provider 跑通九步，并已在 LongCat-2.5 真实模型下复跑通过（1 次通过 / 共 7 轮） | 先由所有者决定是否投入真实模型环境 |
| 7 | 预算原子计量 | §25 要求“服务端原子预留 / 扣减”“Run 总预算是额外闸门” | 已实现并验证（B-06=1，`27b99ec` + 2026-11-04 真实 usage）：Task token 上限强制、原子 reserve/settle/release、父子覆盖、Run 闸门、retryable=false；真实 LongCat usage 已进入结算 | 无争议；跨进程并发超出 Notion 范围，未做（需跨进程锁） |

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
> 证据边界：容量/多候选边界用例仍注入假 Manifest（仅边界，不作为多 Agent 路由证据）；真实多 Agent 路由证据改用已注册的 researcher/executor/reviewer（文件末「真实注册表」用例）；并发为同一进程 + 确定性 stub Provider；**跨进程超出 Notion 范围，未做；需跨进程锁**。

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

## 交付物 3 真实模型验证证据（§5“先选 2—3 个真实专业 Agent 验证”）

> 验证时间 2026-11-04（Asia/Shanghai），供应商 **LongCat**，OpenAI 兼容端点 `https://api.longcat.chat/openai`，模型 **LongCat-2.5**；密钥仅经本机 `server/.env`（gitignore）注入，验证后已删除该行并删除文件，仓库/提交/脚本/输出中均无密钥。真实调用**不在**单元测试内（测试仍 `DEEPSEEK_API_KEY=''` 且不真调模型），由独立脚本 `longcat-e2e.js`（仓库外本地文件）执行。

**注册方式（可扩展）**：`server/agents/manifest.js` 用同一 `roleManifest()` 工厂追加 3 份 Manifest，能力标签即契约，路由按 `capabilities ∩ acceptedTaskTypes` 匹配，**无角色 if/else**；新增第 4 个 Agent 只需再追加一份 Manifest。三个角色的模型/凭证是 `server/agents/config.js` 的独立配置项（本轮三条均指向同一 LongCat-2.5，仅提示词与工具白名单不同）。

| 角色 | 能力标签（能干什么） | 工具白名单 | 本轮状态 |
|---|---|---|---|
| `researcher`（检索/知识） | `memory.recall`、`knowledge.search`、`summary.synthesize` | `memory_search`、`knowledge_search` | enabled |
| `executor`（执行/写入） | `memory.write`、`action.execute` | `memory_remember` | enabled |
| `reviewer`（审校/验证） | `review.verify`、`evidence.check` | `memory_search`、`knowledge_search` | enabled |

**1）连通性（一次极小真实调用）**：`usage = {prompt_tokens:13, completion_tokens:16, total_tokens:29}`，其中 `reasoning_tokens=15`；返回模型 `LongCat-2.5`。

**2）能力匹配（真实注册表 + 纯决策，零 token）**：

| 请求 taskType | 选中 Agent | 候选 |
|---|---|---|
| `knowledge.search` | `researcher` | `[researcher]` |
| `memory.write` | `executor` | `[executor]` |
| `review.verify` | `reviewer` | `[reviewer]` |

真实执行一条 review 任务时，`orchestration` 记录：`basis=explicit_capability`、`matchedAgentIds=["reviewer"]`、`selectedAgentId=reviewer`、`allocation=selected_with_capacity`；任务实际由 reviewer 执行并产出「未验证——证据不足」的审校结论（两次检索均空结果，未编造证据）。

**3）并行（两个无依赖任务，真实模型并发）**：

| 任务 | agent | runStartedAt | completedAt | 实际 used |
|---|---|---|---|---|
| `task_53ed115d…` | researcher | `13:47:33.556Z` | `13:47:49.411Z` | 4156 |
| `task_7f6f5841…` | researcher | `13:47:33.618Z` | `13:47:45.537Z` | 4191 |

结论：两条执行区间**重叠**（起跑相差 62ms，区间交集约 11.9s），`overlap=true`。

**4）依赖（后者等前者完成才启动）**：

| 任务 | dependsOn | runStartedAt | completedAt | 状态 | used |
|---|---|---|---|---|---|
| 上游 `task_0da82e30…` | `[]` | `13:47:49.583Z` | `13:48:01.453Z` | completed | 4337 |
| 下游 `task_ebdb9ca9…` | `["task_0da82e30…"]` | `13:48:01.480Z` | `13:48:08.108Z` | **failed**（`empty_reply`） | 1296 |

结论：下游在上游完成后 **27ms** 才启动，依赖时序正确。**但下游内容产出失败**：`maxTokens=320` 被 reasoning 耗尽，`finishReason=length` 导致空回复；按一次性额度纪律**未重试**。这是输出长度配置问题，不是依赖语义失败。

**5）token 用量（供应商真实 usage，非估算）**：本轮 5 个任务合计 `16,829`；加连通性 29，单轮验证合计 **`16,858`**；另有一次因脚本内部 API 用法错误在连通性后中止的尝试消耗 29，总计 **`16,887`**。按任务：2849 / 4156 / 4191 / 4337 / 1296。

**6）清理**：临时 LongCat Provider 已删除、3 份 Agent 凭证已删除、`server/.env` 中密钥行已删除（文件为本轮新建，已整体移除）；仓库 `git grep` 无密钥串命中；本地数据目录自查无密钥残留（`secretFoundInDataDir=false`）。密钥由 Owner 在 longcat 后台吊销，代码中**未写死额度/有效期假设**。

**诚实限定（必须保留）**：
- 三个 Agent **共用同一 LongCat-2.5 模型**，差异只在系统提示词、能力标签与工具白名单——这是**角色分工**，**不是异构多模型协作**。
- 依赖链下游任务失败（`empty_reply`），因此“真实模型多步链路完整产出”未验证；能力匹配/并行重叠/依赖时序三条验收成立。
- **真实模型下的角色分工质量（审校检出率、检索命中率）未经评测**；单轮样本，不代表稳定性。
- B-06 升级依据是**真实供应商 usage 已进入任务预算结算**；跨进程/多实例并发超出 Notion Phase 1 范围，未做（需跨进程锁）。

---

## 验收证据补强（2026-11-04 第二轮：令牌 / 真实路由 / 5 条并发）

### 1）Worker 作用域令牌（对应验收“Worker Session 隔离”，升 1 依据）

| 要求 | 实现 | 可复跑证据 |
|---|---|---|
| 不可伪造、服务端保存映射 | `worker-scope.js` `issueScopeToken()`：`wst_` + 24 字节 `crypto.randomBytes`（base64url），服务端 Map 以 **sha256(令牌)** 为键；记录只存授权元数据，不存令牌原文 | `node --test tests/agent-worker.test.js`「隔离：无令牌越权读取被拒并留痕，服务端签发令牌才放行」 |
| 读接口只认令牌 | `routes.js` `GET /agents/:botId/sessions/:sessionId` 只读 `x-worker-scope-token`，已删除 `requesterTaskId/grantedBy/reason` 查询参数路径 | 「HTTP 隔离：本 Worker 令牌读自己的会话 → 200…」 |
| 令牌表达允许的 target | 记录含 `allowedTaskIds` / `allowedSessionIds`；会话按 `sessionId` 或 `owner.taskId` 判定，产物按所属 `taskId` 判定 | 内部越权用例 + HTTP 授权用例 |
| 过期立即失效 | `expiresAt`（`openWorkerScope({ tokenTtlMs })` 可设），校验时 `now >= expiresAt` 即拒 | 「HTTP 令牌：伪造、过期、吊销均 401…」（TTL=5ms，等待 20ms） |
| 吊销立即失效 | `revokeScopeToken(token)` 写 `revokedAt`，下一次校验即拒 | 同上（吊销后同一令牌 401） |
| 拒绝留痕、不回显内容 | 非法令牌 401 `worker_scope_token_invalid`；有效但越界 409 `worker_session_owner_mismatch`；均写 `worker.scope_denied`（payload 含 targetType/targetId/access/reason/errorCode）；错误体与审计均不含对方正文、不含令牌原文 | 三条 HTTP 用例均断言 `!JSON.stringify(...).includes(对方正文/令牌)` |
| 既有行为不变 | direct 会话无令牌仍 200；缺失会话仍 404 `agent_session_not_found`；列表接口不变 | 「HTTP 回归：direct 会话与缺失会话的既有行为不变」 |

实测：`agent-worker` **44/44 通过**，覆盖无令牌/伪造 401、过期 401、吊销 401、跨作用域 409、本作用域 200、授权 200、direct/404 零回归。
**边界**：仅 worker 级授权令牌，不引入用户体系/多用户模型；**跨进程隔离超出 Notion 范围，未做；需跨进程锁**。

### 2）路由可追踪（真实注册的 researcher / executor / reviewer）

用例：`tests/agent-orchestrator.test.js`「路由可追踪（真实注册表）：三个真实 Agent 按目标分派…」。该用例 `manifest.setTestManifests({})` 后直接读 `registry.listAgents()`，不使用假 Manifest。

```
enabled = ["executor","researcher","reviewer"]；registeredAgents = 4
目标“检索浅烘咖啡偏好证据” → taskType=memory.recall  → agentId=researcher
目标“写入用户偏好”         → taskType=memory.write   → agentId=executor
目标“审校结论证据”         → taskType=review.verify  → agentId=reviewer
每条轨迹：basis=explicit_capability、candidates=["对应 Agent"]、matchedAgentIds=["对应 Agent"]、
          selected="对应 Agent"、allocation=selected_with_capacity
```

`task.route.orchestration` 与 `route.decided` 事件均落上述字段；`agent-orchestrator` **12/12 通过**。
**边界**：假 Manifest 仅保留给容量/多候选边界用例；三角色仍共用同一模型（角色分工，非异构模型）；真实模型下的委派质量未评测。

### 3）5 条混合角色并发（同进程证据，对应验收“并发结果不串线”）

用例：`tests/agent-worker.test.js`「并发：5 条混合角色受 TASK_CONCURRENCY=2 约束…」。实测 `concurrency=2`、`peakActive=2`，5 条任务同时排队、按闸门放行。

| 任务（后缀） | Agent | taskType | runStartedAt | completedAt | used |
|---|---|---|---|---|---|
| 5480 | researcher | memory.recall | 02.246Z | 02.982Z | 2 |
| 2c4a | executor | memory.write | 02.446Z | 03.113Z | 2 |
| b0aa | reviewer | review.verify | 03.017Z | 03.688Z | 2 |
| df75 | memory | memory.search | 03.145Z | 03.811Z | 2 |
| 2b9b | researcher | memory.recall | 03.722Z | 04.301Z | 2 |

断言：每条结果只含自己的标记，不含其他任务的标记/taskId/sessionId；产物 `taskId` 各归各且 id 无交集；会话 owner 各指本任务；每条 `used=2`、`remaining=12000-used`、总用量=各任务用量之和；超发 `remaining+1`（11999）被 `budget_exceeded` 拒绝且账本不变。
**边界**：同一进程、确定性 stub Provider；**跨进程并发超出 Notion 范围，未做；需跨进程锁**。

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

1. **统一 Planner / Orchestrator 接口** —— **1.0**（2026-11-04）：Orchestrator 侧仍只有 `server/agents/orchestrator.js`（`orchestrate()`/`createTaskGraph()`）一个入口，`server/tool-dispatch-bot.js` 的真实创建路径已迁移；Planner 侧新增 `server/agents/planner.js`（`plan():119` 规则拆解、`planAndCreate():174` 驱动多步任务），产出**只落既有 `workflow-store`**（`appendVersion:664`、`getVersion:759`、`validatePlan:289`、`stepKeyFor:197`），未另存计划、未引入第三套版本口径；多步任务复用 `orchestrator.js:220 createTaskGraph` 批量入口，`router.js:577-591` 对 `workflowPlan` 只校验复用不 append。用例 `tests/agent-planner.test.js` a–d 四条（目标→计划落盘、计划→批量任务且 dependsOn 正确、拆不出来显式失败且零计划零任务、同目标两次调用取出/追加语义一致），证据见「交付物 1 Planner 侧验收证据」。**限定**：真实模型下的拆解质量未验证——本轮只用确定性规则/模板，不接真实模型；当前注册主体 4 个（memory + researcher/executor/reviewer），统一入口已覆盖真实多角色路径。
2. **少量 Agent 的能力匹配、动态分配、并行和依赖管理** —— **1.0**（2026-11-04）：四项**逐条证据**见上一节「交付物 2 四项验收证据」，摘录：①能力匹配＝`orchestrator.js` 按 `capabilities ∩ acceptedTaskTypes` 匹配（1a/2a–2c）；②动态分配＝按并发余量 + `routingPriority` 择一，满容量写 `saturatedAgentIds`/`excludedReasons`（2a 选闲、2c 全满排队）；③并行＝`TASK_CONCURRENCY` 全局闸门，3 条 SLOW_TASK 峰值 `peakActive=2`、区间重叠 ≈573ms、第 3 条在前两条完成前不启动；④依赖管理＝`dependsOn` 字段（≤8、同 botId）+ 唯一 `isReady` 纯函数 + `queued` 不出队 + 上游完成自动放行、失败/取消级联（含下游的下游）+ 批量图环检测 409 且零落盘。用例：`tests/agent-orchestrator.test.js` 2a–2g（11 条）+ 真实注册表路由 1 条（`agent-orchestrator` 12 条）、`tests/agent-worker.test.js` 依赖 5 条 + 并发上限 1 条 + 混合角色并发 1 条（44 条）。**证据限定**：容量/多候选边界用例仍注入假 Manifest（仅用于边界，不作为多 Agent 路由证据）；真实路由证据改用已注册的 researcher/executor/reviewer（见文件末真实注册表用例）；并发是同一进程 + 确定性 stub Provider；**跨进程并发超出 Notion 范围，未做；需跨进程锁**；“动态分配”仍是容量感知择一，不是 Worker Pool 弹性伸缩；重规划未实现（不在 §5 该句四项内）。
3. **保留单 Agent 快速路径；先选 2–3 个真实专业 Agent 验证** —— **1.0**（2026-11-04）：保留 Memory Bot 单 Agent 快速路径不变；新增 `researcher`/`executor`/`reviewer` 三份 Manifest（`manifest.js` 的 `roleManifest()` 工厂，能力标签 + 独立 Prompt/工具白名单，无角色 if/else，第 4 个只需追加注册项）。真实 LongCat-2.5 一轮验证：能力匹配三选一均正确、两任务并行区间重叠、依赖下游在上游完成后 27ms 启动、5 个任务真实 usage 合计 16,829。证据见「交付物 3 真实模型验证证据」。**限定**：三角色同一模型换提示词＝角色分工，非异构多模型；依赖链下游因 `maxTokens=320` 失败（`empty_reply`）；真实模型下的角色质量未评测。
4. **验收“任务路由可追踪”** —— **已满足（1.0，2026-11-04）**：新增用例 `tests/agent-orchestrator.test.js`「路由可追踪（真实注册表）」，**不再注入假 Manifest**，直接读 `registry.listAgents()`：注册主体 4 个（memory + researcher/executor/reviewer），enabled 3 个；三个目标分别路由到 `researcher`（`memory.recall`）/`executor`（`memory.write`）/`reviewer`（`review.verify`），`task.agentId` 与 `decision.selectedAgentId` 一致。轨迹逐条含候选集与选择依据：`task.route.orchestration` 的 `basis=explicit_capability`、`candidateOrder=["对应 Agent"]`、`matchedAgentIds=["对应 Agent"]`、`selectedAgentId`、`registeredAgents=4`、`allocation=selected_with_capacity`；`route.decided` 事件落 `selected`/`candidates`/`orchestrationBasis`/`orchestrationRegisteredAgents`。用例 12/12 通过，实测输出见汇报。**限定**：三个角色共用同一 LongCat-2.5 模型（提示词/能力标签分工，非异构模型）；真实性验证的是“不同目标落到不同真实注册 Agent”，真实模型下的委派质量未评测；假 Manifest 仅保留给容量/多候选边界用例。
5. **验收“Worker Session 隔离”** —— **已满足（1.0，2026-11-04）**：`server/agents/worker-scope.js` 是唯一读边界；本轮补齐**服务端签发的最小身份令牌**：`issueScopeToken()` 生成 `wst_` + 24 字节随机值，服务端以 sha256 保存映射（不存原文），令牌显式声明 `allowedTaskIds`/`allowedSessionIds`、带 TTL；`revokeScopeToken()` 吊销后立即失效。HTTP `GET /agents/:botId/sessions/:sessionId` **只认 `x-worker-scope-token`**，删除 `requesterTaskId/grantedBy/reason` 自报路径；非法令牌 401 `worker_scope_token_invalid`、有效但越界 409 `worker_session_owner_mismatch`，均写 `worker.scope_denied`，错误体不回显对方正文，审计不落令牌原文。用例 `tests/agent-worker.test.js` 共 44 条，其中隔离/令牌：无令牌与伪造被拒并留痕、服务端授权令牌放行、HTTP 跨作用域 409、无令牌 401、本 Worker 令牌 200、授权令牌 200 且留痕、**伪造/过期/吊销均 401**、direct 会话与缺失会话 404 行为不变。**限定**：这是 **worker 级授权令牌**，不是用户体系/多用户模型（Owner 划定范围）；**跨进程隔离超出 Notion Phase 1 范围，未做；需跨进程锁**。
6. **验收“并发结果不串线”** —— **已满足（1.0，同一进程证据，2026-11-04）**：用例 `tests/agent-worker.test.js`「并发：5 条混合角色受 `TASK_CONCURRENCY=2` 约束…」同时启动 **5 条**任务（researcher ×2、executor、reviewer、memory），实测 `peakActive=2`，5 条均在约 2.1s 内完成，时间线各条独立（`runStartedAt` 02.246/02.446/03.017/03.145/03.722，`completedAt` 02.982/03.113/03.688/03.811/04.301）。断言：每条结果只含自己的标记，不含其他任务的标记/taskId/sessionId；产物 `taskId` 各归各且 id 无交集；会话 owner 各自指向本任务；每条 `tokenUsage.used=2`、`remaining=12000-used`、总用量=各任务自身用量之和，无共享账本；超发申请 `remaining+1` 被 `budget_exceeded` 拒绝且账本不变。**限定**：同一进程、确定性 stub Provider；**跨进程并发超出 Notion Phase 1 范围，未做；需跨进程锁**。
7. **验收“预算硬限制有效”** —— **已满足（B-06 = 1，2026-11-04）**：原子 reserve/settle/release、父子覆盖、Run 闸门有 7 条可复跑用例（`27b99ec`）；本轮真实 LongCat 调用的供应商 `usage` 已进入任务预算结算（5 个任务 `used` 分别 2849/4156/4191/4337/1296，均为真实值而非估算）；并发用例另证每任务预算独立账本、超发被拒。**限定**：跨进程并发超出 Notion Phase 1 范围，未做；需跨进程锁。

---

## Phase 2 第 1 项验收证据（2026-11-05，分支 `phase2/blackboard-2026-11-05`）

> 原文第 1 项：「建立**任务级共享产物、证据引用、版本和访问控制**」。
> 口径：四项要素各自有可复跑用例与探针输出才记 1；本轮**只做第 1 项**，第 2/3 项未开工。
> 证据边界：同一进程 + 库级 API；**未新增 HTTP 路由**（新增路由非验证必需，按 Owner 限定先不加）；无跨进程锁（超出 Notion 范围）。

**开工前盘点（HEAD `46393c2`）**：

| 要素 | 状态 | file:line 证据 |
|---|---|---|
| 任务级产物 | 有 | `server/agents/artifact-store.js` `persist()`（`taskId` 归属、`version` 单调、`contentHash`、`refCount`、`status`）；`server/agents/artifact-commit.js` `persistTaskArtifacts()` |
| 共享给同批次其它任务 | 没有 | 全 `server/` grep `share\|audience\|sharedWith` 零命中；`worker-scope.js` 的 `allowedTaskIds` 只表达令牌授权，产物记录本身无接收方登记 |
| 证据引用 | 半有 | `worker-result.js` 的 `evidence` 仅作为任务结果字段归一化，未与产物版本绑定、无 fail-closed 校验 |
| 版本 | 有（不可变底座） | `artifact-store.js` `versionsOf()`/`readContent({version})`；同 kind 新内容追加新 `artifactId`，旧版 `superseded` |
| 访问控制 | 半有 | `worker-scope.js` `issueScopeToken`/`revokeScopeToken`/`authorizeCross` 已做到令牌级；跨 worker 读产物只校验令牌，无产物级授权，拒绝只记 `worker.scope_denied`（无共享语义） |

**实现（全部复用，无第二套）**：

| 文件 | 变更 | 复用点 |
|---|---|---|
| `server/agents/artifact-store.js` | +约 150 行：`share()` / `sharedAccess()` / `readSharedArtifact()`；产物记录新增**唯一字段** `share` | 复用 `persist`/`readContent`/`get`/审计，沿用 `{kind,id,version}` |
| `server/agents/worker-scope.js` | +约 55 行：`readSharedArtifact()`（令牌 + 共享登记两道门、拒绝审计、不回显） | 复用 `authorizeCross`（`wst_` 令牌/allowlist/TTL/吊销） |
| `server/agents/artifact-commit.js` | +约 70 行：`normalizeEvidence()` / `publishSharedConclusion()` | 复用 `artifactStore.persist` + `share`，引用 schema 不扩字段 |

新增错误码（均落在既有六类语义内，`errors.js` 未改）：`artifact_share_invalid`（400，validation_failed）、`artifact_not_shared`（409，not_authorized/conflict 语义）、`artifact_evidence_missing`（409）、`artifact_evidence_invalid`（400）；复用 `artifact_not_found` / `artifact_version_mismatch` / `artifact_not_active`。

**四条可复跑用例（`node --test` 单文件即可复现）**：

| 用例（文件） | 实测探针 | 能证明 | 不能证明 |
|---|---|---|---|
| `tests/agent-worker.test.js`「共享产物：未登记共享时，令牌允许任务也拒绝读取，留痕且不回显正文」 | `[共享-未登记] {"artifactId":"art_…","code":"artifact_not_shared","reason":"not_shared","errorCode":"artifact_not_shared","bodyEchoed":false}` | 令牌合法但未登记 → 拒绝；`worker.scope_denied` 留痕；错误体不含正文 | 不证明 HTTP 层行为（本轮无新路由） |
| `tests/agent-worker.test.js`「共享产物：登记共享后持有效令牌按登记版本可读；无令牌或版本不符被拒」 | `[共享-登记读取] {"sharedVersion":1,"sharedTargets":1,"readVersion":1,"noTokenCode":"worker_scope_token_invalid","wrongVersionCode":"artifact_version_mismatch","grantedAudit":true}` | 登记后可读且版本钉住；无令牌 401；版本不符 409；授权读取留痕 | 不证明登记撤销（无 unshare 入口） |
| `tests/agent-artifact-commit.test.js` `h.` 共享结论证据门禁 | `[共享结论-证据门禁] {"missing":"artifact_evidence_missing","noVersion":"artifact_evidence_invalid","unreadable":"artifact_not_found","evidencePinned":["art_ad3d0d75@v1"],"foreignCode":"artifact_not_shared","bodyEchoed":false}` | 缺证据/未钉版本/读不回来一律拒绝且零落盘；带证据的结论含 `{kind,id,version}` 引用；未共享任务读不到 | 不证明 runtime 自动发布（需显式调用） |
| `tests/agent-artifact-commit.test.js` `i.` 版本不可变 | `[版本不可变] {"v1":{"version":1,"status":"superseded"},"v2":{"version":2},"hashUnchanged":true,"evidenceStillReadable":true,"staleCommitCode":"artifact_not_active"}` | 追加新版本只 supersede 旧版；旧版 `contentHash`/正文不变；旧版证据引用仍可复读；新提交拒绝 superseded 引用 | 不证明跨进程并发写（未做） |

**计数**：`agent-worker` 44→46、`agent-artifact-commit` 7→9；全量 `node scripts/verify-test-coverage.js` → `backend=2194/2194 nodeSuite=222/222 runner=1972/1972 frontend=188/188 suites=22/22 failed=0`，EXIT=0。

**限定（不得当作 1 之外的完成）**：
- 共享是**显式登记**：runtime 不会自动把任务产物登记为共享，需调用 `artifactStore.share()` 或 `artifactCommit.publishSharedConclusion()`。
- **无撤销共享 / 逐产物吊销入口**（令牌吊销可整体失效，但共享登记只增不减）。
- 未新增 HTTP 路由；`GET /agents/:botId/sessions/:sessionId` 行为不变。
- 第 2 项见下节（已完成，1.0）；第 3 项验收句端到端见「Phase 2 第 3 项验收证据」（已完成，1.0）。

---

## Phase 2 第 2 项验收证据（2026-11-05，分支 `phase2/blackboard-2026-11-05`）

> 原文第 2 项：「**Worker 私有上下文与共享工作区分离**；支持**按需上下文投影和来源追踪**」。
> 证据边界：同一进程 + 库级 API + stub Provider；**未新增 HTTP 路由**；无跨进程锁（超出 Notion 范围）。

**契约（先定后写码）**：

| 契约点 | 定义 | file:line 依据 |
|---|---|---|
| 私有上下文载体 | worker 会话的 messages（非产物）；判定依据是**归属**：会话 `owner.taskId` + `scope='worker'`，不是文件名/路径 | `server/agents/sessions.js:30`（`SCOPES=['direct','worker']`）、`:285`–`:301`（`owner.taskId` 校验与绑定）、`:306`（`assertWorkerSession`）；`server/agents/worker-scope.js:249`（`readOwnMessages` 只读 `boundSessionId`） |
| 任务私有产物 | 产物索引上的 `taskId` 归属 + 版本；私有=未登记 `share` | `server/agents/artifact-store.js:414`（`persist()` 写入 `taskId/version`）、`:297`（`share()` 追加接收方并钉版本） |
| 共享工作区边界 | 只接受已登记共享且版本钉住的 `{kind,id,version}` 引用；不接收私有 messages | `server/agents/artifact-store.js:297`、`:756`（`resolveProvenance`），`server/agents/worker-scope.js` 的 `projectSharedContext` 只调 `readSharedArtifact` |
| 投影输入/输出 | 输入=`refs:[{id,version}]` + 令牌；输出=`{source:'shared_workspace', requesterTaskId, refs:[{kind,id,version,content,provenance}]}`；**默认拒绝、白名单整单校验** | `server/agents/worker-scope.js` `projectSharedContext()` |
| 来源追踪 | 沿正文内 `evidence` 的 `{kind,id,version}` 逐环复读；链上任一环缺失/版本不符/invalidated/superseded 即 `artifact_chain_broken`（409，`details.reason` 区分） | `server/agents/artifact-store.js:756` |

**实现**：`artifact-store.js` +52（`resolveProvenance`/`chainBroken`）；`worker-scope.js` +95（`projectSharedContext`/`denyProjection`）；`tests/agent-worker.test.js` +255（4 条用例）。全部复用第 1 项令牌与共享登记，无第二套鉴权/存储。

**四条可复跑用例（`node --test tests/agent-worker.test.js`）**：

| 用例 | 实测探针 | 能证明 | 不能证明 |
|---|---|---|---|
| 上下文投影：持合法令牌但未登记共享 → 整单拒绝，留痕且不含对方内容 | `[投影-未授权] {"code":"artifact_not_shared","bodyEchoed":false,"deniedAudit":1}` | 令牌合法但未登记 → 拒绝；`worker.scope_denied` 留痕；错误体无正文 | 不证明 HTTP 层行为 |
| 上下文投影：请求 v1 而 head 已是 v2 → 拒绝，不悄悄给最新版 | `[投影-版本钉住] {"staleCode":"context_projection_stale","currentVersion":1,"noVersionCode":"context_projection_invalid","v2Code":"artifact_not_shared","staleAudit":1}` | 旧版 superseded 即拒；缺 version 400；未登记的 v2 不会被自动取用 | 不证明跨进程冲突 |
| 上下文投影：私有 session/messages 不随投影外带 | `[投影-私有隔离] {"sharedMarker":true,"privateMarker":false,"sessionIdLeaked":false,"sessionTitleLeaked":false,"outputKeys":["refs","requesterTaskId","source"]}` | 只出共享产物；私有 marker/会话 id/标题零泄漏；输出字段白名单 | 不证明 runtime 自动投影 |
| 上下文投影：来源链成功回溯；证据被 invalidated/superseded 即链断裂 | `[投影-来源链] {"provenance":["conclusion:art_e569c2@v1","message:art_85930f@v1"],"chainExposesContent":false,"invalidatedCode":"artifact_chain_broken","invalidatedReason":"invalidated","supersededReason":"stale","chainDeniedAudit":2}` | 成功投影带完整引用链且不含证据正文；失效/被替代两分支均 fail-closed | 不证明链的跨进程一致性 |

新增错误码：`context_projection_invalid`（400）、`context_projection_stale`（409）、`artifact_chain_broken`（409）；其余复用第 1 项。

**限定**：
- 投影只做**单跳根引用 + 证据链复读**，不做检索/向量化/排序/裁剪（Owner 限定）。
- runtime 不自动调用 `projectSharedContext`；投影需显式请求。
- 无撤销共享；无 HTTP 路由；无跨进程锁。
- 第 3 项（验收句端到端：跨 Agent 协作且不可越权读私有 Session + 每个共享结论可追溯）已完成 1.0，见下节。

---

## Phase 2 第 3 项验收证据（2026-11-05，分支 `phase2/blackboard-2026-11-05`，`59b09cb`）

> 验收句（**逐句判**）：① 「跨 Agent 可协作但不能越权读取私有 Session」；② 「每个共享结论可追溯来源」。
> 口径：两句都用**真实服务端对象**（真实任务、真实 `wst_` 令牌、真实产物存储）在设计上**一次跑通**，模型为确定性 stub（**无外部 API key、未新建 Provider**），单文件可复跑。
> 证据边界：同一进程；不含跨进程；**真实模型下的协作质量未验证**（见文末）。

**场景用例**：`tests/agent-worker.test.js`「端到端：researcher→executor→reviewer 共享结论可追溯；executor 越权读 reviewer 私有会话被拒」（复跑：`node --test tests/agent-worker.test.js`）。

**事件 / 审计时间线（实测，UTC，取自 `[端到端-协作时间线]` 探针）**：

| 时刻（Z） | 主体 | 事件 | 目标 | 结果 / 说明 |
|---|---|---|---|---|
| 20.884 → 21.012 | researcher | `task.created` → `started` → `completed` | `task_c567…`（`stateVersion=12`） | 真实任务完成，产出私有证据产物 |
| 21.027 → 21.169 | executor | `task.created` → `started` → `completed` | `task_366e…`（`stateVersion=12`） | 真实任务完成（自己的会话） |
| 21.185 → 21.334 | reviewer | `task.created` → `started` → `completed` | `task_f131…`（`stateVersion=14`） | 真实任务完成；私有会话 `bs_9318…` |
| 21.349 → 21.477 | memory（第三方任务） | `task.created` → `started` → `completed` | `task_68ce…` | 另一任务就绪，用于按版本复核 |
| 21.489 | artifact-store | `artifact.persisted` + `artifact.shared`（`share_targets:2`） | A `art_409ee0…` | researcher 登记共享结论 A，钉 v1 |
| 21.504 / .513 / .524 | executor | `worker.scope_read` ×3（artifact → shared_artifact → projection） | A | **executor 通过投影读到 A** |
| 21.533 | artifact-store | `artifact.persisted` + `artifact.shared`（`share_targets:2`） | B `art_cb00ef…` | executor 发布 B，证据引用指向 A@v1 |
| 21.617 / .631 / .642 | reviewer | `worker.scope_read` ×3 | B | **reviewer 复核 B 的来源链** |
| 21.654 / .667 / .689 | memory（第三方） | `worker.scope_read` ×3 | B | **第三方另一任务按 v1 读到 B** |
| 21.700 / .711 | reviewer（目标 bot） | **`worker.scope_denied` ×2** | reviewer 私有会话 `bs_9318…` | 库层 + HTTP 层各 1 条：`denied` / `token_bot_mismatch` / `worker_scope_token_invalid` |
| 21.720 | artifact-store | `artifact.invalidated` | A | Owner 将 A 标失效（`端到端：上游证据失效`） |
| 21.727 / .737 | reviewer | `worker.scope_read` ×2 | B | B 本体仍可读，开始复读证据链 |
| 21.747 | reviewer | **`worker.scope_denied`** | B（投影） | **链断裂**：`chain_broken` / `artifact_chain_broken` |

（同一目标的多条 `scope_read` 依次对应「令牌门 → 共享登记门 → 投影审计」三层，属第 1/2 项既有语义。）

**证据采集点（实测值，≥4）**：

| # | 采集点 | 实测 | 证明什么 |
|---|---|---|---|
| 1 | 任务状态 | 4 条真实任务 `completed`；`stateVersion` = 12/12/14/12；每条会话 `owner.taskId` = 自身任务 | 是真实任务而非构造态 |
| 2 | 投影输出键集合 | 顶层 `["refs","requesterTaskId","source"]`；引用 `["content","id","kind","provenance","version"]`；投影文本不含 researcher 会话 id | 共享工作区口径固定，不夹带私有字段 |
| 3 | 拒绝审计行 | reviewer 审计 2 条 `worker.scope_denied`（`targetType=session`、`access=denied`、`reason=token_bot_mismatch`、`errorCode=worker_scope_token_invalid`、`requesterTaskId=null`） | 越权被拒且留痕；库层 + HTTP 层各一条 |
| 4 | 来源链回溯 | A：`conclusion@v1 → message@v1`；B：`conclusion@v1 → conclusion@v1(A) → message@v1`；第三方按 v1 读到 B（`thirdPartyReadVersion=1`）；A 失效后 `artifact_chain_broken` / 409 / `reason=invalidated` / `artifactId=A` | 每个共享结论可逐环回溯；上游失效 fail-closed |
| 5 | 越权响应体 | 库层 401；HTTP 401；body 键 `["code","error","targetId","targetType"]`；`privateLeak=false`（无 `REVIEWER_PRIVATE_MARKER`、无 `session`/`messages`、无对方 `taskId`） | 「响应体不含对方任何字段」；`targetId` 仅是调用方自带的请求标识回显 |

**逐句判定**：

- ① 前半「跨 Agent 可协作」：**成立**。executor 的真实任务通过投影读到 researcher 的共享结论 A，并据此发布 B（B 的证据引用指向 A@v1）；reviewer 的真实任务投影复核 B；第三方另一任务按 v1 读到 B。
- ① 后半「不能越权读取私有 Session」：**成立**。executor 用自己的 `wst_` 令牌读 reviewer 私有 Worker 会话，**库层 `authorizeSessionRead` 与既有 HTTP `GET /agents/:botId/sessions/:sessionId` 均 401**（未新增路由），两条审计落盘，响应体不含对方内容。
- ② 「每个共享结论可追溯来源」：**成立**。A、B 的 `provenance` 均回指到具体产物与版本；A 标 `invalidated` 后 B 的链判定为断裂（`artifact_chain_broken`，409，`details.reason=invalidated`，`details.artifactId=A`），不降级为「静默取最新版」。
- **结论：Phase 2 第 3 项 = 1.0；Phase 2 三句合计 3/3。**
- **未验证（不计入验收）**：真实模型下的协作质量（本轮模型为确定性 stub，仅验证协议与链路）。

**计数与门禁（实测）**：`agent-worker` 50→51；`verify-test-coverage` → `backend=2199/2199 nodeSuite=222/222 runner=1977/1977 frontend=188/188 suites=22/22 文件 87/87 failed=0`；`tsc --noEmit`、`npm run lint`、`verify-api-capabilities`（95 路由 / 20 族 / 仅 API 9）、`sync-doc-counts --check` 全部 EXIT=0；全量 `node scripts/run-tests.js` → `87 个测试文件，全部通过`，`FULL_EXIT=0`。

**限定**：
- 协作是**显式**的：任务完成后需显式调用 `publishSharedConclusion` / `projectSharedContext`；runtime 不自动发布、不自动投影。
- 越权拒绝的审计落在**目标 bot** 的事件流（`taskId=null`，不含令牌与正文）。
- 无撤销共享、无跨进程锁；不做检索/UI/多用户；`state-machine.js` 与状态词表未改。

---

## Phase 3 第 1 项验收证据（2026-11-05，分支 `phase3/verification-loop-2026-11-05`）

> 原文第 1 项（唯一依据）：「引入**确定性验证**、**独立 Reviewer**、**冲突处理**和**人工审批节点**」。
> 本轮只做第 1 项；第 2 项（投递幂等可恢复）与第 3 项（死信/成本追踪）**未开工**。
> 口径：确定性校验与审校任务都跑在**真实任务 / 真实产物存储 / 真实审批记录**上；模型是本地确定性 stub（无外部 API key）。
> 复跑：`node --test tests/agent-verification-loop.test.js`（7 条）。

**实现（文件 + 行）**：

| 要素 | 落地 | 说明 |
|---|---|---|
| 确定性验证（不依赖模型） | `server/agents/verification-loop.js:78`（`verifyDeterministic`） | 结构、必填字段、引用可解析、版本一致、哈希匹配（复读正文 + `contentHash` 双核对）、结论证据可解析、`conclusion` 来源链；失败返回首个明确错误码，`runtime` 禁止进入 `completed` |
| 独立 Reviewer | `verification-loop.js:311`（`openReview`） | 复用 `orchestrator.orchestrate({agentId:'reviewer', capability:'review.verify', taskType:'review.verify'})`；硬约束：不同 `taskId`、`botId==='reviewer'`、独立 Worker Session；生产者是 reviewer 时抛 `verification_review_not_independent`；被审产物按版本登记共享 |
| 审校结论 | `verification-loop.js:429`（`parseVerdict`） | 只接受 `pass/fail/needs_human`；`pass/fail` 必须带可解析证据，缺证据/证据读不回来/JSON 不可解析一律降级 `needs_human`（fail-closed） |
| 冲突处理 | `verification-loop.js:494`（`resolveConflict`）、`:562`（`planGate`） | 机械通过+审校否、机械失败+审校通过 → `conflict`（保守不通过）；机械失败是机械事实，永远不被审校 `pass` 覆盖；无法结论 → `needs_human`，绝不按通过 |
| 人工审批节点 | `approvals.js:69`（`GATE_OPERATIONS`）、`:844`（门禁分支）、`verification-loop.js:604`（`requestHumanApproval`） | 复用同一条审批记录与 `riskLevel/expiresAt/SLA`：`review.conflict`=R2（30 分钟 SLA，到期只标 `overdue`，保持 `pending`）、`review.escalate`=R3；门禁操作无外部副作用，不进操作账本、不写记忆 |
| Runtime 门禁 | `server/agents/runtime.js:937-1040` | `completed` 前先跑确定性校验；`requiresReview` 任务等待独立审校终态（`:130` `waitForReviewTask`），冲突/高风险/审校不可用 → 停 `waiting_approval`；审批超时永不通过 |
| 审计事件 | `server/agents/tasks.js` 事件白名单 | `verification.review_opened` / `.verdict` / `.rejected` / `.conflict` / `.approval_requested`（只落扁平标量与引用，不落正文；状态词表未改） |

**失败注入（3 处，实测 `[EVIDENCE]` 原始输出）**：

1. 确定性校验失败（注入校验码；真实产物仍可读，注入点为 `verification-loop.js:51` `setFaultInjection`，仅测试用）：
```
[EVIDENCE] inject-a {"taskId":"task_e775e51f-105f-46f2-b597-4aae299a7859","finalStatus":"failed","errorCode":"verification_hash_mismatch","event":{"payload":{"status":"failed","errorCode":"verification_hash_mismatch","checkCode":"verification_hash_mismatch","deterministicOk":false,"mode":"verification"}}}
```
2. Reviewer 判否（构造"结论与证据矛盾"的结论，审校独立任务真实返回 `fail`；机械与审校一致拒绝）：
```
[EVIDENCE] inject-b {"taskId":"task_9a807d88-0d91-44dc-8c57-c36f896a8554","reviewTaskId":"task_9067c6c7-e323-4dbf-b5cf-a40e1557f3e6","reviewerVerdict":"fail","reviewerEvidence":[{"kind":"message","id":"art_bce9b7f6d0a8c3cddc1e86613b064a09","version":1}],"finalStatus":"failed","errorCode":"verification_hash_mismatch","event":{"status":"failed","errorCode":"verification_hash_mismatch","checkCode":"verification_hash_mismatch","deterministicOk":false,"verdict":"fail","mode":"verification"}}
```
3. 两者相反（机械注入失败 vs 审校 `pass`）→ `conflict` → 人工审批；超时只标 `overdue`，任务仍 `waiting_approval`，最终由人工拒绝转 `cancelled`：
```
[EVIDENCE] inject-c {"taskId":"task_da660d2a-e50d-4856-b860-83a9675bb7a8","reviewTaskId":"task_2f0b6fda-250a-43ef-822b-8cabbeced717","reviewerVerdict":"pass","deterministicInjected":"verification_version_mismatch","approval":{"approvalId":"appr_de9abcfa-bd0b-425b-aad4-2f99ac30f532","riskLevel":"R2","statusAfterTimeout":"pending","overdue":true,"expiresAt":"2026-11-04T17:13:55.847Z"},"taskAfterTimeout":"waiting_approval","finalStatus":"cancelled","conflictEvent":{"verdict":"pass","reviewTaskId":"task_2f0b6fda-250a-43ef-822b-8cabbeced717","producerTaskId":"task_da660d2a-e50d-4856-b860-83a9675bb7a8","deterministicOk":false,"conflict":true,"decision":"conflict","checkCode":"verification_version_mismatch"}}
```
人工批准路径（明确覆盖、非静默通过）：
```
[EVIDENCE] approval-approve {"taskId":"task_e7bd52d5-ab15-492c-a410-bfb15927d420","approvalId":"appr_866999dc-bdcb-477f-9f7f-15b100025a27","approvalStatus":"completed","approvalResult":{"reason":"ok","gate":"review.conflict","decision":"human_override","artifactId":"art_270d8f917845de4156f42cd75eb673c2"},"taskStatus":"completed","taskSummary":"已执行审批操作：review.conflict"}
```
裁决纯函数（双向冲突 + 无法结论）：
```
[EVIDENCE] resolve-conflict {"detOk_reviewPass":"pass","detOk_reviewFail":"conflict","detFail_reviewPass":"conflict","detFail_reviewFail":"fail","detOk_reviewUnparseable":"needs_human"}
```

**Reviewer 检出率（10 条构造样本混淆矩阵，实测）**：

| 指标 | 数值 |
|---|---|
| TP / FN | **7 / 0** |
| TN / FP | **2 / 1** |
| 检出率（TP/(TP+FN)） | **100%** |
| 误报率（FP/(FP+TN)） | **33.3%（1/3）** |

| 样本 | 标签 | 是否拦截 | 拦截阶段 / 错误码 |
|---|---|---|---|
| clean_message | 0 | 否 | pass |
| clean_conclusion | 0 | 否 | pass |
| clean_ambiguous | 0 | **是（FP）** | 审校 `needs_human`（claims 存在但 facts 缺失 → 保守转人工） |
| structure_missing_summary | 1 | 是 | 确定性 `verification_field_missing` |
| ref_dangling | 1 | 是 | 确定性 `verification_ref_unresolvable` |
| version_mismatch | 1 | 是 | 确定性 `verification_version_mismatch` |
| hash_mismatch | 1 | 是 | 确定性 `verification_hash_mismatch` |
| evidence_broken | 1 | 是 | 确定性 `verification_evidence_invalid` |
| conclusion_without_evidence | 1 | 是 | 确定性 `verification_evidence_invalid` |
| claim_contradicts_evidence | 1 | 是 | 审校 `fail` + 机械 `pass` → `conflict` |

> **必须声明的边界**：以上是**构造样本，不代表真实缺陷分布**；审校器在本轮是**确定性替身**（按 claims/facts 一致性规则判定，不接收样本标签），**真实模型下的检出能力未验证、不计入验收**。FP=1 来自保守策略（审校无法给出结论即转人工），是有意的 fail-closed 代价。
> 原始行：`[EVIDENCE] confusion-matrix {"note":"构造样本，不代表真实缺陷分布；审校器为确定性替身，真实模型检出能力未验证","TP":7,"FN":0,"TN":2,"FP":1,"detectionRate":1,"falsePositiveRate":0.3333…}`

**判定**：四项要素均有可复跑证据与真实任务终态，**Phase 3 第 1 项 = 1.0**（第 2/3 项未开工，不计入）。

**限定与偏离**：
- 审校是**显式/按需**的：只有 `task.requiresReview === true` 的任务在完成前进入独立审校；其余任务仅做确定性校验。未改 `state-machine.js` 与状态词表，未新增 HTTP 路由。
- 生产者通过轮询等待审校终态（上限 `BLUEBIRD_AGENT_REVIEW_WAIT_MS`，默认 30s；`TASK_CONCURRENCY>=2` 才可并行）；等待超时按"审校不可用"转人工，绝不当通过。跨进程/多实例并发不在本轮范围。
- 人工批准表示"人工确认越过保守裁决"，任务以审批摘要收口；被审产物在冲突时已标 `invalidated` 留痕，**不回填生产者正文**（保守语义，避免把冲突结论洗成正常完成）。
- 未验证：真实模型审校质量、真实缺陷分布下的检出率/误报率、跨进程恢复。

**计数与门禁（实测）**：`agent-verification-loop` 新增 7 条；`verify-test-coverage` → `backend=2206/2206 nodeSuite=222/222 runner=1984/1984 frontend=188/188 suites=22/22 文件 88/88 failed=0`；`tsc --noEmit` EXIT=0、`eslint`（改动文件）0 error、`verify-api-capabilities`（95 路由 / 20 族 / 仅 API 9）EXIT=0、`sync-doc-counts --check` EXIT=0；全量 `node scripts/run-tests.js` → `88 个测试文件，全部通过`，`FULL_EXIT=0`。

---

## Phase 3 第 2 项 · 现状对账与最小补缺（2026-11-05，`479bfd9` + `c133cd4`）

对账（复用 P1–P5 与 Phase 1/2 的既有能力，不重造）：

| 能力 | 已有实现（file:line） | 已有用例 | 结论 |
|---|---|---|---|
| 副作用幂等 | `server/agents/op-ledger.js:275`（`begin` 同键返回原条目）、`side-effect-guard.js:42` | `agent-op-ledger`（a1–f1 等）、`agent-side-effect-ledger` | 已覆盖 |
| 状态写入与 CAS | `tasks.js:1255` `bumpStateVersion`、`:1265` `assertExpectedVersion`、`:1491` `transitionTask` | `agent-recovery` 状态机 / CAS 用例 | 已覆盖 |
| 崩溃恢复 | `tasks.js:1770` `recoverInterrupted`、`runtime.js` 启动恢复、`approvals.js:1018` `reconcileExecuting` | `agent-crash-injection`（c1–c4）、`agent-workflow-crash` | 已覆盖 |
| 产物提交链 | `artifact-commit.js:37/71/96`、artifact-store pending-commit / orphan / TTL | `agent-artifact-commit` 9 条 | 已覆盖 |
| **事件投递本身** | `tasks.js:387` `appendEvent`（主事件文件 + outbox 双写）、`:297` `flushEventOutbox` | `agent-storage-limits` P3-12（主文件写失败后 outbox 补写） | **两个真空缺**：① 无幂等键——同一逻辑事件重复投递会生成两行不同 `eventId`；② outbox 已落盘、主事件文件未写的崩溃窗口没有真实注入证据 |

**结论**：真正缺的是「重复事件去重」+「事件投递中断可恢复」，正对应验收句里的 **重复事件** 与 **结果投递恢复** 两项；Reviewer 检出率已由第 1 项交付。

**补缺实现（复用既有 events/outbox 两个文件，未新建存储）**：

- `tasks.js:355` `eventIdForDedupeKey`：`sha256(botId\0dedupeKey)` 派生确定性 `eventId`；`:342` `assertEventDedupeKey` fail-closed（空/超长/非字符串直接拒绝）；`:374` `markEventDeduped` 在原记录累加 `dedupeCount`/`lastDedupedAt`（审计可见，不新增行）；`:387` `appendEvent` 新增 `dedupeKey`；`:446` `crashHook.hold('event.after-outbox-save')` 暴露崩溃窗口。
- `result-delivery.js:83` `task.delivery` 接入幂等键；`:137` 重复投递不再产生消息，只累加去重计数。
- `crash-child.js:339/351` 两个崩溃场景；`tests/agent-event-delivery.test.js` 4 条。

**真实探针（复跑 `node --test tests/agent-event-delivery.test.js`，tests 4 / fail 0）**：

```
[EVIDENCE] duplicate-delivery {"taskId":"task_7350b419-…","messages":1,"eventRows":1,"eventId":"evt_5471198462ecfb48…","dedupeCount":1,"secondAlreadyDelivered":true,"taskStatus":"completed"}
[EVIDENCE] dedupe-scope {"sameKeyRows":1,"otherKeyRows":1,"noKeyRows":2,"dedupeCount":1}
[EVIDENCE] crash-recovery {"atKill":{"events":0,"outbox":1},"afterRestart1":{"rows":1,"outboxRows":0,"dedupeCount":1,"replayDeduped":true},"afterRestart2":{"rows":1,"outboxRows":0,"dedupeCount":2},"eventId":"evt_878b5256f756effe…"}
```

**判定 1.0**（Owner 改判 2026-11-05）：Notion 原文验收句为「失败注入、重复事件、Reviewer 检出率和**结果投递恢复**均有测试证据」，第 2 项只对这半句负责。重复事件去重（父会话消息 1 条、`task.delivery` 1 行、`dedupeCount=1`、任务状态不变）与结果投递恢复（SIGKILL 时 `events=0/outbox=1`，重启后 1 行、outbox 清空，二次重启仍 1 行）均有真实探针，故按 Notion 口径判 1.0。

**超范围未做清单**（自加标准，不计入 Notion 验收、也不作为成果）：
- 事件面向消费方的重放位点（SSE 断线续传 / last-event-id）未做，断线只靠 snapshot 兜底；
- 其余 `appendEvent` 调用点未逐一接入幂等键（仅 `task.delivery` 与显式传入 `dedupeKey` 的调用生效）。

**限定与未验证**：未新增 HTTP 路由、未改 `state-machine.js`/状态词表、未新建第二套存储；幂等键为调用方显式传入（未做全站强制）；跨进程并发与真实多实例投递未验证。

**计数与门禁（实测）**：`agent-event-delivery` 新增 4 条 → `backend=2210/2210 nodeSuite=222/222 runner=1988/1988 frontend=188/188 suites=22/22 文件 89/89 failed=0`；`tsc --noEmit` EXIT=0；`eslint`（改动文件）0 error；`sync-doc-counts --check` EXIT=0。

---

## Phase 3 第 3 项 · 死信与成本追踪（2026-11-05，`5a39821` + `c5d7e9f`）

对应 Notion 原文：「建立失败重试、取消、Checkpoint、**死信和成本追踪**」。两项均复用既有存储与既有语义，未新增 HTTP 路由、未改 `state-machine.js`/状态词表、未建第二套存储。

**实现（复用既有链路）**

| 要求 | 实现（file:line） | 复用点 |
|---|---|---|
| 连续失败超上限入死信 | `runtime.js:1259` 失败路径 `status==='failed' && attempts>=maxAttempts` → `deadLetter.mark(...)`；`dead-letter.js:14` `mark` | 复用既有 `maxAttempts`/`attempts` 与 `transitionTask`，**未另造计数** |
| 死信可查 | `tasks.js:2086` `listDeadLetters({status,limit})`、`dead-letter.js:53` `list`、`:57` `describe`；返回 `taskId/botId/taskType/goal/status/errorCode/attempts/deadLetter/artifacts` | 读既有 `tasks.json`，按既有 `createdAt` 倒序 |
| 人工重投恰好一次 | `dead-letter.js:67` `redeliver` → `createTask` 带 `idempotencyKey: '<taskId>:redeliver'`；原记录改 `redelivered` + `redeliveredTaskId/redeliveredAt/redeliveryCount` | 复用既有 `createTask` 幂等键，不双写 |
| 不占正常队列容量 | 死信任务仍是既有 `failed` 终态（`deadLetter` 仅是标记字段，`tasks.js:1318`），调度器只取 `queued`/`retrying` | 未新增状态词、未新增队列 |
| 按任务/Run 聚合真实 usage | `tasks.js:1652` `recordRunFinish` + `:1640` `normalizeRunUsage` 落 attempt 级 `run.usage`；`cost-tracker.js:32` `aggregate`、`:100` `taskCost`、`:117` `runCost` | 复用既有 usage 结算路径，**无字符数估算**；缺失即 `null` |
| 与预算结算对得上 | `cost-tracker.js:117` `runCost` 同时读 `tasks.js:2125` `getRunUsage`（`tokenRuns` 账），返回 `budgetUsed` + `consistentWithBudget` | 同一份 `run.usage` 只按 attempt 求和，不读 `tokenUsage.used`（避免父链双计） |
| 时间窗口查询 | `cost-tracker.js:32` `aggregate({from,to,groupBy})`，`GROUP_BY=['task','run']` | 读接口（无 HTTP 路由） |
| 无 usage 标未知 | `aggregate` 返回 `unknown:{attempts,tasks,tokens:null}`、`complete=false`；`taskCost.known=false`；`runCost.consistentWithBudget=null` | 缺 usage 不进 0 成本 |

**真实探针（`node --test tests/agent-dead-letter.test.js tests/agent-cost-tracking.test.js`，tests 7 / fail 0）**

```
[EVIDENCE] dead-letter-threshold {"belowLimit":{"marked":false},"atLimit":{"taskStatus":"failed","deadLetterStatus":"open","attempts":3,"maxAttempts":3,"lastErrorCode":"model_timeout","events":1}}
[EVIDENCE] dead-letter-query {"rows":1,"taskStatus":"failed","errorCode":"model_timeout","lastErrorCode":"model_timeout","attempts":3,"artifactsField":true}
[EVIDENCE] dead-letter-redeliver {"clones":1,"secondCall":"already_redelivered","cloneStatus":"completed"}
[EVIDENCE] dead-letter-state {"deadLetterStatus":"redelivered","redeliveryCount":1,"openDeadLetters":0,"queuedTasks":1,"deadLetterInQueue":false,"finalTaskStatus":"failed"}
[EVIDENCE] cost-single-task {"costTokens":200,"attempts":2,"budgetUsed":200,"runTokens":200,"runBudgetUsed":200,"consistent":true}
[EVIDENCE] cost-run-no-double-count {"parentBudgetUsed":150,"parentCostTokens":50,"childCostTokens":100,"byTaskTotal":150,"byRunTotal":150,"runBudgetUsed":150,"consistent":true,"windowTokens":100}
[EVIDENCE] cost-unknown-bucket {"totalTokens":0,"unknownAttempts":1,"unknownTokens":null,"unknownTasks":1,"complete":false,"taskKnown":false,"runConsistent":null}
```

用例覆盖：死信 4 条（达上限入死信 / 可列且字段完整 / 重投成功一次不双写 / 重投后原记录状态 `redelivered` 且 `open` 计数归零）；成本 3 条（单任务聚合正确 / 多任务与 Run 汇总不双计 / 无 usage 进 `unknown` 桶且 `tokens=null`）。

**判定 1.0**：Notion 原文「死信和成本追踪」要求均有可复跑证据。死信四要素（超上限不无限重试、可查含失败原因与最后错误码及原任务/产物引用、可人工重投且 `clones=1`/`already_redelivered`、不占队列 `deadLetterInQueue=false`）全部成立，未出现判分纪律所指的「能查不能重投」；成本按真实 `run.usage` 聚合且与预算账对齐（`byTaskTotal=byRunTotal=runBudgetUsed`），无字符数估算，缺 usage 走未知桶而非 0 成本。

**限定与未验证**
- 死信打标只在 `status==='failed' && attempts>=maxAttempts` 这一条路径；`task_lease_lost` 等异常退出不打标；
- 成本仅为 **token 计数**，不是货币金额；真实模型下的 usage 分布与 `cached`/reasoning token 细分未验证；
- 重投为同进程调用（`start=true` 时延迟取 `runtime.startTask`），跨进程并发重投未验证（按边界不建跨进程锁）；
- 死信记录复用 `tasks.json` 与任务事件文件，无独立死信表；死信长期堆积的清理策略未做（超出原文要求）。

**门禁与全量（实测）**：`tsc --noEmit` EXIT=0；`eslint`（改动文件）0 error（余为既存 warning）；`verify-test-coverage` → `backend=2217/2217 nodeSuite=222/222 runner=1995/1995 frontend=188/188 suites=22/22 failed=0`、CI runner 91/91；`sync-doc-counts --check` → `backend 2217、nodeSuite 222、runner 1995、frontend 188、文件 91` EXIT=0；`verify-api-capabilities`（95 路由 / 20 族 / 仅 API 9）EXIT=0；全量 `node scripts/run-tests.js` → 首跑出现 1 个 `memory-bot` 偶发失败，该文件隔离复跑通过（exit 0），第二次全量 `91 个测试文件，全部通过`、`FULL_EXIT=0`；收口复核（本轮台账提交后，前台）再次全量 → `91 个测试文件，全部通过`、`FULL_EXIT=0`。

---

## Notion 契约补齐（2026-11-05，分支 `notion-contracts-2026-11-05`）

本轮只补 Notion 原文已写明、仓库缺失的七项机制；每项独立提交。不新增状态词、不改 `main`、不碰 `package-lock.json`、不做多用户/权限模型、不碰 §26 限流熔断参数与灰度发布。原文关键句取自本机原文抽取副本（§17 344-360 行、§23/24/25/28/29 436-609 行）。

### 1. §25 三个硬限（`12dcdba`）——判定 1.0
- 原文关键句：委派深度最多 2 层；重规划单 Task 最多 2 次、每 Run 最多 2 次；Run 最多重试 3 次；计数持久化，重启不重置，重试不重置。
- 实现：`server/agents/agent-limits.js` 持久化 `agents/agent-run-limits.json`；`tasks.createTask` 父任务入口先校验委派深度；`recordReplan` 以 Run 键统一计数（Task 键只记录、不作为绕过途径）；`recordRunRetry` 同口径；超限按 §23 六类选码（深度＝`not_authorized` 403，重规划/Run 重试＝`validation_failed` 400），七字段齐备。
- 证据：`tests/agent-run-limits.test.js` 4 条：深度 3 被拒（`delegation_depth_exceeded`）；重规划第 3 次被拒（`replan_limit_exceeded`）；第 4 次 Run 重试被拒（`run_retry_limit_exceeded`）；清 require 缓存重载模块（模拟进程重启）后计数仍为 2/3，不归零。
- 限定：计数为单进程原子写，跨进程并发未加锁（不在本轮范围）；`replanCount` 采用 Owner 口径（Run 级统一最多 2），比原文"单 Task 2"更严，原文 §25 与 §26 措辞差异列入待确认。

### 2. §28 ConflictRecord（`980ece2`）——判定 1.0
- 原文关键句：冲突必须是可序列化对象并持久化；记录冲突类型、候选、证据、裁决状态；冲突处理与裁决必须可审计。
- 实现：`server/agents/conflict-record.js`（`agents/agent-conflict-records.json`，原子写）；`runtime.js` 冲突审批分支把 `resolution.outcome==='conflict'` 写入现有 `resolveConflict` 流程（不另建裁决），随后照旧 `invalidateArtifactRefs`。
- 证据：`tests/agent-conflict-record.test.js` 4 条：记录落库后可复读（同 id 幂等）；审计可查（`conflict.recorded` / `conflict.resolved`）；裁决结果与记录一致（`selectedCandidateRef` 必须属 `candidateRefs`，非 resolved 禁止携带裁决结果）；文件损坏时读取抛 `internal_error`（fail-closed）。
- 限定：`candidateRefs`/`evidenceRefs` 元素形态、`policyVersion` 取值、状态迁移表原文未定义（见待确认）；冲突记录只覆盖"冲突→审批"这一条入口，其他冲突路径（若有）未接。

### 3. trustLevel 四档（§12/§27，`6da3538` + 本轮接线）——判定 1.0
- 原文关键句：`untrusted < declared < evidence_checked < independently_verified` 有序；唯一写入者是 Verification Engine；只表示证据验证状态，不代表访问权限；内容/来源/版本变化时验证结论失效。
- 实现（写入口，上一轮）：`artifact-store.js` 新增 `TRUST_LEVELS` 有序枚举、`TRUST_WRITER='verification-engine'`、`trustRank/trustAtLeast`；`setTrustLevel(id,{level,writer,...,reason})` 非验证器写入一律 `not_authorized` 403、非法值 400，均不改已存值并写 `artifact.trust_level_write_rejected` 审计；每次变更写 `artifact.trust_level_changed`（`前档->后档|原因`）；新 `persist` 记录默认 `untrusted`；`readTrustLevel` 对缺字段旧记录回退 `untrusted`（fail-closed）。
- 实现（端到端接线，本轮）：`verification-loop.js` 新增 `TRUST_POLICY_VERSION='trust-rules-v1'` 与 Engine 侧唯一写封装 `applyArtifactTrustLevel`（始终以 `TRUST_WRITER` 调用，逐 ref 写入，单条失败只补审计不改验证结论）；`runtime.js` 按门禁顺序落档：产物落盘后全部 `declared`（`producer_declared`）→ 确定性校验全过 `evidence_checked`（`deterministic_passed`）→ 仅 `requiresReview=true` 且独立审校任务通过且 `resolution.action==='complete'` 时 primary `independently_verified`（`independent_review_passed`，`trust.scope=independent-review:<reviewTaskId>`）；确定性失败、审校判否、冲突/审批任一失败路径显式降回 `declared` 并记录原因（`verification_*` 错误码）；`requiresReview=false` 最高只到 `evidence_checked`。越权路径：`updateTask`/`transitionTask`/`artifactCommit.completeTask` 传 `trustLevel`/`trust` 在任何字段变更前拒绝（`not_authorized` 403），并写 `task.trust_level_write_rejected`（mode 区分 updateTask/transitionTask）；`persist` 的未知 trust 字段不生效。
- 证据：`tests/agent-trust-level.test.js` 7 条：非验证器（memory/orchestrator/gateway/null）写入被拒且无副作用；升降级只有验证器可做且审计顺序正确；非法值拒绝且保留已存值；旧数据缺字段读出 `untrusted`（含重载模块后）；有序语义（`trustRank=[0,1,2,3]`、未知值按 untrusted）；正交性（`independently_verified` 产物跨任务读取仍 `artifact_not_shared` 409 / `requester_not_allowed`）；重启后复读档位/verifier/reason 不变。
- 证据（真跑 runtime + 独立 Reviewer，不 mock 验证器）：`tests/agent-trust-level-runtime.test.js` 5 条。
  - a1 确定性通过 → `evidence_checked`，`requiresReview=false` 时无 `independently_verified`（探针 `trust-a1`）。
  - a2 独立 Reviewer（`verification.review_opened.reviewTaskId != producer taskId`）通过 → `independently_verified`，审计链 `untrusted->declared|producer_declared` / `declared->evidence_checked|deterministic_passed` / `evidence_checked->independently_verified|independent_review_passed`（探针 `trust-a2`）。
  - b Reviewer 判否（`verdict=fail`）且机械通过 → 冲突进 `waiting_approval`，产物降回 `declared`、`trust.reason=verification_conflict`、审计 `evidence_checked->declared|verification_conflict`（探针 `trust-b`）。
  - c 越权写入 5 类（`updateTask`×2 / `transitionTask`×2 / `artifactCommit.completeTask`）+ 非验证器 `setTrustLevel` + `persist` 伪造字段 → 全部被拒/不生效，4 条 `task.trust_level_write_rejected` 事件 + `artifact.trust_level_write_rejected` 审计，已存值仍 `declared`、任务状态未被半改（探针 `trust-c`）。
  - d 高 trustLevel 产物对未共享任务仍 `artifact_not_shared` 409（`sharedWith` 只有 Reviewer）（探针 `trust-d`）。
- 限定：`declared` 目前由 Engine 在落盘后统一写入（= 生产者声明的最低档），不是 Producer 可传入的字段；所有产物（含工具产物）都走同一映射；被 invalidated 的产物保留 `declared` 记录（`status` 另行表达失效）；`trustLevel` 仍不参与任何授权判定（符合原文"不代表访问权限"），因此没有"高信任免共享"的实现，也无需实现。
- 待确认（实现自定，登记在清单 1/7）：`TRUST_POLICY_VERSION='trust-rules-v1'`、`trust.reason` 字段名与截断长度、`trust.scope=independent-review:<taskId>` 形态、"生产者声明"是否应由 Producer 显式声明（当前由 Engine 固定落 declared）。

### 4. §24 两条用例（`8d26d0b`）——判定 1.0
- 原文关键句：只有 Workflow Engine 可写 Task 状态；Worker/Gateway/Reviewer/审批人不能直接改状态；拒绝非法迁移并记录原因。
- 现状核对：`updateTask` 已拒绝 `status`（`task_status_requires_transition`）、`checkpointVersion`；本轮补 `stateVersion` 显式只读门禁（`task_state_version_read_only`），并在 `applyTransition` 拒绝非法迁移时写 `task.transition_rejected` 事件（from/to/reason；审计失败不掩盖原拒绝）。
- 证据：`tests/agent-task-transition-guard.test.js` 2 条：绕过 `transitionTask` 写 `status`、直接写 `stateVersion` 均失败且状态/版本原样；`queued→running` 非法迁移返回 `invalid_transition` 409，事件含 `{fromStatus:'queued',toStatus:'running',reason:'invalid_transition'}`，状态不变。
- 限定：审计只覆盖经 `applyTransition` 的路径；直接改写存储文件不在审计范围。

### 5. §23 五类错误码统一契约（`d5dcf77`）——判定 1.0
- 原文关键句：六类错误码统一带 `code/retryable/errorFingerprint/failedAt/taskId/runId`（`causeRef` 可选）；`retryable` 默认值按类固定。
- 实现：`errors.js` 新增 `ERROR_RETRYABLE` 与 `errorContractFingerprint`（sha256(code|taskId|runId|causeRef|message)），在 `describeAgentError` 序列化边界补齐七字段；`code/error/status` 与既有附加字段不覆盖，HTTP 状态码不变。
- 证据：`tests/agent-error-contract.test.js` 6 条：五类各一条断言七字段齐备、同输入同指纹、`retryable` 为 `false/false/false/true/true`（validation_failed/not_authorized/budget_exceeded/dependency_failed/internal_error），并验证 `budget_exceeded` 既有 `scope/required/remaining` 不丢；无 details 时补 `taskId=''`、`runId=null`、`causeRef=null`。
- 限定：字段在响应序列化时补齐，不是抛出时补齐，进程内调用方拿到的 `AgentError` 仍只有原 details；无 taskId/runId 上下文的错误取空值。

### 6. §17 委派环 + lineage 环（`c87b61a`）——判定 1.0
- 原文关键句：循环检测覆盖 Agent 委派图、Task 依赖图、Artifact 引用/lineage 图；新增边前检查成环，间接引用做传递闭包；拒绝并给可读路径；设置图规模与检测时间上限。
- 实现：`server/agents/cycle-detection.js`（纯图检测，节点/耗时/出边上限）；`agent-limits.delegationDepth` 接入委派环检测；`artifact-store.persist` 在写正文/索引前对 `content.evidence` 逐引用做 lineage 闭包检查；Task 依赖环沿用既有 `dependencies.js`（未改）。
- 证据：`tests/agent-cycle-detection.test.js` 6 条：委派环 `t1→t2→t3→t1` 抛 `not_authorized` 403 且报文含完整路径，同一检测器经 `assertDelegationAllowed` 生效；合法链放行（深度 2）；lineage 环 `art_A→art_B→art_C→art_A` 抛 `validation_failed` 400 + 可读路径；合法链放行；真实入口持久化环引用被拒且产物文件条数不变；合法引用正常落盘可复读。
- 限定：上限数值（2000 节点 / 100ms / 每节点 20 出边）原文未定义，属自定保守值；lineage 检查只看 `content.evidence[].id`，其他引用字段不纳入；委派环在正常创建路径不会产生，检测主要防历史/损坏数据。

### 7. §29 通知重试与审批六态（`2172441`）——判定 0.5
- 原文关键句：Approval Request 状态为 `pending/approved/rejected/expired/escalated/cancelled`；审批节点必须有持久化状态、deadline/escalationAt、通知重试记录；R2 超时→`expired` 并转人工队列，不得解释为批准；通知失败不能视为审批完成。
- 实现：`approvals.js` 新增并列 `requestStatus` 六态（既有执行生命周期 `status` 不动，避免静默改语义）、迁移校验 `assertRequestStatusTransition`、`transitionRequestStatus`；`decide`/`markOverdue` 同步六态（escalated→expired）；新增 `notification {attempts,lastError,lastAttemptAt,nextRetryAt,exhausted}` 与 `recordNotificationOutcome`（失败不阻塞、达上限停止排期）。
- 证据：`tests/agent-approval-request.test.js` 4 条：通知两次失败后 `attempts=2/lastError/nextRetryAt` 正确且审批仍可批准；达 3 次置 `exhausted`、`nextRetryAt=null`、重复失败不再累加、审批仍 `pending`；六态取值断言 + `rejected→approved` 被拒 409；R2 超时先 `escalated` 再 `expired`，`approve` 抛 `approval_request_transition_invalid`、`cancelled` 合法。
- 限定（判 0.5 的原因）：六态与既有 `status` **并存而非合并**，属原文与仓库语义冲突的保守处理（见待确认）；仓库没有真实通知发送器，重试记录目前只有记账 API 与用例，未接任何投递渠道；`expired→rejected` 为兼容既有"超时后仍可人工拒绝"行为而保留，并非原文直述。

### 8. §16 provenance / taint（`5769609` + 本轮 feat `7fe1cd4`）——判定 1.0

- 原文关键句（§16，原文抽取副本 338–342 行）：
  - 「Task Contract 增加 provenanceRefs、taintLabels、taintPolicyVersion。外部网页、文件、工具返回和 Agent 派生内容保留来源链；污点标签随摘要、引用和产物传播，不因跨 Agent 或写入 Blackboard 自动洗白。」
  - 「硬约束：污染内容不得解锁特权工具、扩大 allowedTools、修改审批要求或触发更高权限动作。Tool & Policy Gateway 每次调用均校验主体权限、任务授权、工具白名单、参数和污点；不能只在 Planner 建任务时检查。只有可信验证 / 清洗组件可按明确规则改变污点标签，Producer 不得自行移除。」
  - 关联句：§13「来源污点」参与风险分级；§20 第 5 步「各写入 artifact…包含来源、时间、provenance 和 taint」；§22 A-09「provenance / taint 贯穿 Task、Artifact 和 Tool Gateway」。
- 实现：
  - `artifact-store.js`：新增 `TAINT_POLICY_VERSION='taint-policy-v1'`、`normalizeProvenanceRefs`（复用既有 `{kind,id,version}` 引用形态，≤20 条）、`normalizeTaintLabels`（≤20 个、每个 ≤64 字符）、`readProvenanceRefs`、`readTaintLabels`（缺字段/空数组 → `['unknown']`，未知即最保守）、`inheritedTaintOf`（逐引用解析上游并集，不可解析即加 `unknown`）、`setTaintLabels`（仅 `TRUST_WRITER='verification-engine'` 可写；越权/非法/不存在均写 `artifact.taint_write_rejected` 或抛错，不改已存值）、`markTaintVerified`（仅验证器可把 `unverified` 转 `verified`）；`persist` 新增 `provenanceRefs`/`sourceLabels`，落盘 taint = 上游并集 ∪ 自身来源标签 ∪ `unverified`；产物记录新增 `provenanceRefs/taintLabels/taintPolicyVersion/taintChangedAt/taintChangedBy`；`resolveProvenance` 新增 `allowStatuses`（Gateway 传 `active/pending-commit/committed`，避免任务完成后产物已 `committed` 被误判断链）。
  - `tasks.js`：`createTask` 接受 `provenanceRefs/taintLabels/taintPolicyVersion`，taint = 继承并集 ∪ 声明标签，空则 `unknown`；任务记录与 `publicTask` 只读视图暴露三字段；`updateTask`/`transitionTask` 在 `applyTransition`/CAS 前拒绝写这三字段（`not_authorized` 403）并写 `task.taint_write_rejected`（`field/mode/reason`）。
  - `artifact-commit.js`：`persistTaskArtifacts` 把任务级 `provenanceRefs` 传给产物，`sourceLabels` 自动追加 `agent:derived`；共享结论（`publishSharedConclusion`）以 `content.evidence` 作为 `provenanceRefs`，跨 Agent 共享时污点随证据链传播。
  - `runtime.js`：`memory_remember` 等工具产物带 `tool:<name>` 来源标签；产物落盘传任务级 `provenanceRefs`；`createToolAuthorizer` 传入任务来源引用。
  - `tool-gateway.js`：每次 `authorizeTool` 在原有三条检查后逐条解析 `provenanceRefs`（存在/版本/链不破）；构造期非法引用或调用期解析失败均返回 `taint_provenance_broken`（fail-closed），由 `runtime` 的 `onToolDenied` 写 `tool.denied` 留痕。
- 证据（`tests/agent-provenance.test.js`，5 条真跑：真实 `artifact-store` 落盘、真实任务存储、真实 Worker Runtime + Gateway，未 mock 存储与校验）：
  - a 正常任务：上游 `note` 产物 `sourceLabels=['external:web']`；任务带 `provenanceRefs=[上游ref]`；message 产物带同一 ref，`taintLabels=['agent:derived','external:web','unverified']`，`taintPolicyVersion='taint-policy-v1'`；任务视图 `['external:web','unverified']`。探针原文：
    `[EVIDENCE] provenance-a {"taskId":"task_b492c7fa-46b7-40bd-9d20-b7e05f9ea0de","artifact":{"kind":"message","id":"art_4ab6fba39bf668dac454c7f0eb712a9b","version":1},"taskProvenanceRefs":[{"kind":"note","id":"art_42e8f8efc3e4128b1c174e0e729f2cc7","version":1}],"taskTaintLabels":["external:web","unverified"],"artifactProvenanceRefs":[{"kind":"note","id":"art_42e8f8efc3e4128b1c174e0e729f2cc7","version":1}],"artifactTaintLabels":["agent:derived","external:web","unverified"],"policyVersion":"taint-policy-v1"}`
  - b 派生继承：`persistTaskArtifacts` 派生产物 taint 为上游并集 `['agent:derived','external:web','unverified']`；`setTaintLabels(writer='producer')` 清空被拒（`not_authorized` 403）且已存值不变，审计 `artifact.taint_write_rejected`；任务级 `updateTask({taintLabels:[]})` 被拒并写 `task.taint_write_rejected`。探针原文：
    `[EVIDENCE] provenance-b {"artifactId":"art_7c3c29c11115514479f7260bddd77ae0","inheritedUnion":["agent:derived","external:web","unverified"],"unchangedAfterReject":["agent:derived","external:web","unverified"],"artifactRejectionAudit":["not_authorized|writer:producer"],"taskRejection":{"status":"queued","field":"taintLabels","reason":"not_authorized","mode":"updateTask"}}`
  - c 验证器降级：`markTaintVerified(writer='producer')` 被拒（403 + 审计），标签不变；`markTaintVerified(writer='verification-engine')` 后 `['agent:derived','tool:memory_remember','verified']`（移除 `unverified`、保留来源标签），审计 `artifact.taint_changed` 含 `verification_passed`。探针原文：
    `[EVIDENCE] provenance-c {"artifactId":"art_8f41db15d304f69b3af91e674aa1362b","rejectedCode":"not_authorized","rejectionAudits":["not_authorized|writer:producer"],"labelsAfterVerify":["agent:derived","tool:memory_remember","verified"],"changedBy":"verification-engine","changeAudit":"agent:derived,tool:memory_remember,unverified->agent:derived,tool:memory_remember,verified|verification_passed"}`
  - d Gateway 断裂：任务 `provenanceRefs=[{kind:'note',id:'art_does_not_exist',version:1}]`，真实模型（本地 HTTP provider）请求 `memory_search`；Gateway 每次调用解析失败 → 拒绝，任务终态 `completed`（拒绝不崩溃），事件 `tool.denied` 的 `errorCode='taint_provenance_broken'`、`mode='delegated_task'`。探针原文：
    `[EVIDENCE] provenance-d {"taskId":"task_852d9f9a-9f94-4672-94ad-0251346b12e1","brokenRef":{"kind":"note","id":"art_does_not_exist","version":1},"taskTaintLabels":["unknown"],"deniedEvent":{"tool":"memory_search","errorCode":"taint_provenance_broken","mode":"delegated_task"},"status":"completed"}`
  - e 持久化与旧数据：清 `require.cache` 重载 `artifact-store`（模拟进程重启）后复读 `['external:file','unverified']` 不变；手工删除旧记录的 `taintLabels`/`provenanceRefs` 字段后，`readTaintLabels` → `['unknown']`、`readProvenanceRefs` → `[]`。探针原文：
    `[EVIDENCE] provenance-e {"artifactId":"art_aed591bcaa1e1a44b658d26d4b651cc2","labelsBeforeRestart":["external:file","unverified"],"labelsAfterRestart":["external:file","unverified"],"legacyTaintLabels":["unknown"],"legacyProvenanceRefs":[],"reason":"缺字段不得默认成干净：未知即最保守"}`
- 第一轮判 0.5 的两个缺口（本轮已闭合）：① 跨 Agent读取不继承（"随引用传播"只覆盖显式 `content.evidence`/任务级声明）；② 没有"污点→工具"阻断，Gateway 只校验来源链。原文未给的具体取值/阈值，本轮按 Owner 授权取**安全默认值 + 版本记录**，均属**本仓库裁决，不是 Notion 原文标准**。
- 第二轮实现（缺口①：读取即继承，taint propagation on read）：
  - `tasks.js`：新增 `appendProvenanceRefs`/`appendTaintLabels`。只追加不覆盖、按键去重、来源引用上限 20（与产物引用上限一致）；传入引用不可解析/非法即追加 `unknown`；每次变更写 `task.provenance_appended` 审计（`status/mode/added`）并 `saveTasks()`。跨 Agent 只改消费任务记录，不改被读对象。
  - `worker-scope.js`：读路径接线 `readSharedArtifact`、`readOtherArtifact`、`projectSharedContext`（含 `missing`/`version_mismatch`/`stale`）——跨任务读取通过或失败时都把被读对象的 `{kind,id,version}` 追加进消费任务；失败时追加 `unknown`（不静默丢弃）。
  - 接不上的两条（原因）：`authorizeSessionRead` 读的是 Session 而非产物，没有 `{kind,id,version}` 可构造；强造引用会让 Gateway 后续永久 `taint_provenance_broken`，故不接线。`context-projection.js` 是纯投影函数、不读存储，继承接线落在其上游 `projectSharedContext`。
  - `memory_search`：记忆记录没有 `version`，只追加来源标签（`tool:memory_search` 与 `unknown`/`external:import`/`external:tool`/`external:web`/`internal:<source>`），不追加不可解析引用（原因同上）。
- 第二轮实现（缺口②：污点到工具的阻断策略）：
  - 新文件 `server/agents/taint-policy.js`：`taint-policy-v1` 默认规则 `no-taint-allow` / `verified-allow` / `untrusted-read-only-allow` / `untrusted-side-effect-deny`；`evaluate` 为纯函数，未命中任何规则 → `unclassified-fail-closed`（默认拒绝）。
  - 分类：`unknown`/`unverified`/`external:*` → untrusted；`verified`/`agent:*`/`internal:*`/`tool:*` → trusted（`tool:*` 是内部工具身份标签，外部工具内容用 `external:tool`）。**该取值与规则映射为本仓库裁决，非 Notion 原文标准。**
  - `tool-gateway.js`：每次 `authorizeTool` 依次做原有授权（`allowedTools`/策略/`answer_only`）→ 来源链解析 → 污点策略；拒绝返回 `code='taint_tool_denied'` + `ruleId` + `policyVersion`；未知工具元数据按 `readOnly:false`（fail-closed）。策略只做 AND，结构上不能放大 `allowedTools`；`trustLevel` 不参与放行；审批要求未被策略修改（只可能更严）。
  - `runtime.js`：`getTaintState` 每次调用实时读任务（不是 Planner 建任务时的快照）；每次判定写 `tool.policy_decision`（`policyVersion/ruleId/decision`）；拒绝沿用 `tool.denied` 并带 `detail/ruleId/policyVersion`。
  - 版本记录：`createVersion` 复用 `failopen-policy.js` 的原子写 + history 生效/失效风格（旧版本写 `retiredAt`）；产物落盘 `taintPolicyVersion`，旧产物不回写。
- 证据（`tests/agent-taint-policy.test.js` 5 条真跑：真实 `artifact-store`/任务存储/Worker Scope/真实 Runtime + Gateway，未 mock 存储与校验）：
  - f 跨 Agent 读：researcher 任务 A 写带 `external:web` 的共享产物，memory 任务 B 经 `readSharedArtifact` 读取后，`provenanceRefs` 自动出现 `{kind:'note',id,version:1}`，任务 taint 含 `external:web`；B 的派生产物 taint 为 `['agent:derived','external:web','unverified']`；上游产物本身未被修改。探针原文：
    `[EVIDENCE] taint-f {"upstreamTaskId":"task_56299362-4b3b-4d17-a4dc-9ae7b58ef71a","consumerTaskId":"task_a51f8708-3612-4868-9341-782df2a7d79d","sharedRef":{"kind":"note","id":"art_7881bbd9042ac55af9ad05fed642a2e4","version":1},"consumerProvenanceRefs":[{"kind":"note","id":"art_7881bbd9042ac55af9ad05fed642a2e4","version":1}],"consumerTaintLabels":["external:web","unverified"],"appendEvent":{"status":"queued","mode":"worker.readSharedArtifact","added":1},"derivedArtifact":{"id":"art_e8ac8bd21baa0df65e197d96b866c607","taintLabels":["agent:derived","external:web","unverified"]},"upstreamUnchanged":[]}`
  - g 阻断与放行：任务 taint `['external:web']`，真实模型先请求 `memory_remember`（副作用）→ Gateway 拒绝，`errorCode='taint_tool_denied'`、`ruleId='untrusted-side-effect-deny'`、`policyVersion='taint-policy-v1'`；随后请求 `memory_search`（只读）→ 放行并完成；两条判定都写 `tool.policy_decision`。探针原文：
    `[EVIDENCE] taint-g {"taskId":"task_13553a47-c724-476d-9d4a-0eef2aa095fc","taskTaintLabels":["external:web"],"deniedWrite":{"tool":"memory_remember","errorCode":"taint_tool_denied","detail":"untrusted-side-effect-deny","ruleId":"untrusted-side-effect-deny","policyVersion":"taint-policy-v1","mode":"delegated_task"},"allowedRead":{"tool":"memory_search","ok":true,"mode":"delegated_task"},"writeDecision":{"tool":"memory_remember","decision":"deny","ruleId":"untrusted-side-effect-deny","policyVersion":"taint-policy-v1","mode":"delegated_task"},"readDecision":{"tool":"memory_search","decision":"allow","ruleId":"untrusted-read-only-allow","policyVersion":"taint-policy-v1","mode":"delegated_task"},"status":"completed"}`
  - h 收窄不扩张：上游产物 `trustLevel='independently_verified'` 但仍带 `external:web` 污点；h1 任务允许写工具却被污点策略拒绝（`taint_tool_denied`）；h2 任务未授权写工具 → 先被原有授权拒绝（`task_tool_denied`，`policyVersion=null`），证明策略不能放大 `allowedTools`、trustLevel 不放行。探针原文：
    `[EVIDENCE] taint-h {"trustLevel":"independently_verified","upstreamTaintLabels":["external:web","unverified"],"h1":{"taskTaintLabels":["external:web","unverified"],"denied":{"tool":"memory_remember","errorCode":"taint_tool_denied","detail":"untrusted-side-effect-deny","ruleId":"untrusted-side-effect-deny","policyVersion":"taint-policy-v1","mode":"delegated_task"}},"h2":{"allowedTools":["memory_search"],"denied":{"tool":"memory_remember","errorCode":"task_tool_denied","detail":null,"ruleId":null,"policyVersion":null,"mode":"delegated_task"}},"conclusion":"trustLevel 与污点正交；策略只收窄，未授权工具不被放大"}`
  - j 断裂读：`projectSharedContext` 读取不存在的 `{id,version}` → `artifact_not_found`，任务 taint 变 `['unknown']`、引用仍留痕（`kind:null`），`readTaintLabels` 返回 `['unknown']` 而非空集合（不误判干净）。探针原文：
    `[EVIDENCE] taint-j {"taskId":"task_1aba9192-adcd-412c-861e-e92998bfc452","missingId":"art_taint_missing_never_exists","thrownCode":"artifact_not_found","taskTaintLabels":["unknown"],"taskProvenanceRefs":[{"kind":null,"id":"art_taint_missing_never_exists","version":1}],"readTaintLabels":["unknown"],"deniedEvent":{"targetType":"projection","targetId":"art_taint_missing_never_exists","requesterTaskId":"task_1aba9192-adcd-412c-861e-e92998bfc452","access":"denied","reason":"missing","errorCode":"artifact_not_found"}}`
  - i 策略版本：`createVersion` 产生 `taint-policy-v2`，旧版 `taint-policy-v1.retiredAt=2026-11-05T01:00:00.000Z`；旧产物仍 `taint-policy-v1`，新产物落 `taint-policy-v2`；新策略下 untrusted 只读被拒（`ruleId='untrusted-deny-all'`）；未分类标签 `weird:foo` 被 `unclassified-fail-closed` 拒绝。探针原文：
    `[EVIDENCE] taint-i {"legacyArtifactPolicyVersion":"taint-policy-v1","freshArtifactPolicyVersion":"taint-policy-v2","policyFile":"C:\\Users\\Administrator\\AppData\\Local\\Temp\\bluebird-taint-EVbATY\\agent-taint-policies.json","versions":[{"policyVersion":1,"policyLabel":"taint-policy-v1","effectiveFrom":"2026-11-05T00:00:00.000Z","retiredAt":"2026-11-05T01:00:00.000Z","ruleIds":["no-taint-allow","verified-allow","untrusted-read-only-allow","untrusted-side-effect-deny"],"note":"本仓库裁决的默认安全值，非 Notion 原文标准"},{"policyVersion":2,"policyLabel":"taint-policy-v2","effectiveFrom":"2026-11-05T01:00:00.000Z","retiredAt":null,"ruleIds":["empty-allow","trusted-allow","untrusted-deny-all"],"note":"测试用收窄策略：untrusted 连只读也拒绝"}],"untrustedVerdict":{"ruleId":"untrusted-deny-all","policyVersion":"taint-policy-v2"},"unclassified":{"ruleId":"unclassified-fail-closed","reason":"no_rule_matched_fail_closed","gatewayCode":"taint_tool_denied"}}`
- 判定 1.0 的理由：缺口①②均以真跑证据闭合；原文硬约束"污染内容不得扩大 allowedTools / 触发更高权限"由 g/h 证明——h2 未授权工具仍 `task_tool_denied` 且不经过污点策略（`policyVersion=null`），h1 即使上游 `independently_verified` 仍被污点收窄；策略结构上只 AND，无法放行 `allowedTools` 之外的任何工具。
- 限定（不改变 1.0 判定，但必须记录）：
  - `authorizeSessionRead` 与 `memory_search` 无法生成可解析 `{kind,id,version}`，只接 taint/不接 ref（原因见上）；因此"读取即继承"在这两条上只传播标签，不传播引用。
  - `taintLabels` 取值、规则映射、`taint-policy-v1` 默认值、追加上限 20、`BLUEBIRD_TAINT_POLICY_FILE` 位置均为**本仓库裁决**，非 Notion 原文标准。
  - 策略存储是本地 JSON（非分布式一致性），未实现灰度/回滚（原文未要求）；HTTP 读端点复用同一库函数故继承同样生效，但未单独跑 HTTP 级用例。
- 待确认（原文未定义，按安全默认值 + 版本记录）：
  1. 污点枚举与来源前缀（`unknown`/`unverified`/`verified` + `external:*`/`tool:*`/`agent:*`/`internal:*`）；
  2. 规则映射"untrusted 禁副作用、放行只读"及未知工具按副作用处理；
  3. 来源引用追加上限 20（沿用产物上限）；
  4. 新任务无上游时 taint 为空集合（旧数据缺字段仍 `unknown`，不得默认干净）；
  5. `memory_search` 无版本 → 只继承 taint 不追加引用；
  6. `authorizeSessionRead` 不接线（Session 非产物）；
  7. 策略版本文件位置、生效/失效记录形态与回滚/灰度未实现。

### 门禁与全量（实测，2026-11-05）

`node scripts/run-tests.js`（前台一次）→ `101 个测试文件，全部通过`、`FULL_EXIT=0`；`npx tsc --noEmit` EXIT=0；`npx expo lint` EXIT=0；`node scripts/verify-test-coverage.js` → `backend=2265/2265 nodeSuite=222/222 runner=2043/2043 frontend=188/188 suites=22/22 failed=0`、CI runner 101/101、EXIT=0；`node scripts/sync-doc-counts.js --check` → `backend 2265、nodeSuite 222、runner 2043、frontend 188、文件 101` EXIT=0；`node scripts/verify-api-capabilities.js`（95 路由 / 20 族 / 仅 API 9）EXIT=0。
（补充：trustLevel 接线首轮收尾前，`verify-test-coverage` 曾两次在不同文件（`agent-worker` 1/51、`memory-bot` 2/9）出现单次执行失败；两文件单独跑与按 verify 同环境复跑均 EXIT=0，最终门禁一次通过，判为既有偶发 flaky，未改其用例。）

### 待确认清单（原文未定义，按最小必要自定并在此登记）
1. trustLevel 写入者标识：原文只写 "Verification Engine"，代码取固定串 `verification-engine`；`trust` 元数据字段名（`policyVersion/verifier/verifiedAt/evidenceRefs/scope/reason`）、`TRUST_POLICY_VERSION='trust-rules-v1'`、`scope=independent-review:<taskId>` 形态、"生产者声明"是否由 Producer 显式提交（当前 Engine 固定落 `declared`）均为自定。
2. ConflictRecord：`candidateRefs`/`evidenceRefs` 元素形态、`policyVersion` 默认值 `conflict-rules-v1`、状态枚举与迁移表。
3. §23 错误指纹算法（取 sha256 拼接）与 `failedAt` 取值时机（序列化时）。
4. §17 图规模/检测时间/单节点出边上限数值，以及超限拒绝错误码（当前取 `validation_failed` + `cycle_check_limit_exceeded`）。
5. §29 六态迁移表（原文未给）、通知重试上限 `3` 与退避 `60s`、`requestStatus` 与既有 `status` 的最终合并方式。
6. §25 重规划计数口径：原文"单 Task 最多 2"与 §26"每 Run 最多 2"存在措辞差异，本轮按 Owner 口径取 Run 级统一计数。

## Phase 4 第 1 项 · 离线评测集与基线度量框架（2026-11-05，`2120311` + `97874c5` + `00336e5`）

依据 Notion §5 Phase 4：交付物「按真实运行数据动态组队、重规划、选择验证强度；**离线评测集**、策略版本、灰度发布、回滚；权限/预算/审批边界不变前提下逐步开放低风险自动化」；退出判据「相对基线在成功率、返工率、成本或延迟上有**可重复改善**，且**安全指标不退化**」。

本轮只做第 1 项（离线评测集 + 基线度量），未碰动态组队/重规划/验证强度选择。

**实现（全部复用既有链路，不新建第二套度量）**

| 要求 | 实现（file:line） | 复用点 |
|---|---|---|
| 固定可版本化评测集 | `server/agents/eval-suite-v1.json`（5 条用例）、`eval-suite.js:100` `loadSuite`、`:32` `suiteDigest` | 每条含 goal、agentId/taskType、expectedTerminal、allowedErrorCodes、expectReview、budgetTokenCap、确定性 script；digest 钉住版本 |
| 离线重放 | `eval-runner.js:45` `runCase`、`:113` `runSuite` | 只走 `createTask→transitionTask→recordRunStart/recordRunFinish`，usage 与预算同生产路径；虚拟时钟写 `startedAt/finishedAt` |
| 成功率/返工率/token/延迟 | `eval-metrics.js:120` `computeMetrics`、`:60` `latencyOf` | 终态/错误码/attempts 读 `tasks.getTask`；token 读 `cost-tracker.taskCost`（不读 `tokenUsage.used`，避免父链双计）；延迟读 run 的 `startedAt/finishedAt` |
| 未知桶单列 | `eval-metrics.js:157` `tokenCost{unknownCases,unknownTokens:null,complete}`、`:118` 单例 `tokens:null/usageKnown:false` | 缺 usage 不算 0，不计入已知总额 |
| 基线快照 | `eval-baseline.js:20` `createSnapshot`、`:38` `writeSnapshot`、`:47` `readSnapshot` | 快照含 suite.version/digest、codeCommit、strategy、metrics、逐用例结果、safety |
| 对比报告 | `eval-baseline.js:91` `diff`、`:69` `metricDiff`、`:78` `diffCase` | 指标改善/退化方向 + 逐用例变化 + 用例增删 |
| 安全指标单列 | `eval-metrics.js:96` `collectSafety` | 只读既有事件（`tasks.listEvents`：`verification.review_opened`/`approval.requested`/`worker.scope_denied`/`verification.rejected`/`tool.denied`/`route.rejected`）与既有死信视图（`tasks.listDeadLetters`），不新造埋点 |
| 策略版本+开关+回滚 | `strategy-version.js:36` `get`、`:50` `apply`、`:71` `setEnabled`、`:77` `rollback` | 状态与任务库同目录（`tasks.TASKS_FILE` 同级），不建路由、不建灰度系统 |
| CLI | `scripts/eval-offline.js`（`--suite/--out/--compare/--strategy-version`） | 无 HTTP 路由；默认数据目录 `.eval-data/`（已 ignore） |

**真实输出（`node scripts/eval-offline.js` 两次 + `--compare`）**

```
[EVIDENCE] eval-baseline {"suite":{"version":"p4-eval-v1","digest":"8b66dd9afd537269c6812d4e32fd4ab5d23f51181d8668e5f95b82c677c2ae1d","caseCount":5},"codeCommit":"00336e5f03a7e23406c82f5d7b4093293ea79ca7","strategy":{"version":"p4-default","enabled":true},"successRate":{"value":1,"successCount":5,"caseCount":5},"rework":{"total":1,"casesWithRework":1,"rate":0.2},"tokenCost":{"total":610,"knownCases":4,"unknownCases":1,"unknownTokens":null,"complete":false},"latency":{"totalMs":2850,"avgMs":570,"maxMs":900,"unknownCases":0,"complete":true},"safety":{"approvalBypass":0,"failClosedHits":0,"unauthorizedDenied":0,"deadLetters":0}}
[EVIDENCE] eval-case {"caseId":"research-success","terminal":"completed","expectedTerminal":"completed","errorCode":null,"success":true,"expectReview":false,"reviewTriggered":false,"attempts":1,"rework":0,"tokens":160,"usageKnown":true,"latencyMs":400,"budgetTokenCap":500}
[EVIDENCE] eval-case {"caseId":"executor-reviewed-success","terminal":"completed","expectedTerminal":"completed","errorCode":null,"success":true,"expectReview":true,"reviewTriggered":true,"attempts":1,"rework":0,"tokens":250,"usageKnown":true,"latencyMs":900,"budgetTokenCap":600}
[EVIDENCE] eval-case {"caseId":"retry-then-success","terminal":"completed","expectedTerminal":"completed","errorCode":null,"success":true,"expectReview":false,"attempts":2,"rework":1,"tokens":180,"usageKnown":true,"latencyMs":900,"budgetTokenCap":500}
[EVIDENCE] eval-case {"caseId":"hard-failure","terminal":"failed","expectedTerminal":"failed","errorCode":"model_timeout","allowedErrorCodes":["model_timeout"],"success":true,"attempts":1,"rework":0,"tokens":20,"usageKnown":true,"latencyMs":300,"budgetTokenCap":500}
[EVIDENCE] eval-case {"caseId":"unknown-usage-success","terminal":"completed","expectedTerminal":"completed","errorCode":null,"success":true,"expectReview":false,"attempts":1,"rework":0,"tokens":null,"usageKnown":false,"unknownAttempts":1,"latencyMs":350,"budgetTokenCap":400}
[EVIDENCE] eval-diff {"suiteChanged":false,"codeCommit":{"before":"00336e5f...","after":"00336e5f..."},"metrics":{"successRate":{"before":1,"after":1,"delta":0,"change":"flat"},"reworkRate":{"before":0.2,"after":0.2,"change":"flat"},"tokenCostTotal":{"before":610,"after":610,"change":"flat","comparable":false},"latencyAvgMs":{"before":570,"after":570,"change":"flat"}},"tokenComparable":false,"caseDiffs":[],"safety":{"approvalBypass":{"delta":0,"direction":"flat"},"failClosedHits":{"delta":0,"direction":"monitor"},"unauthorizedDenied":{"delta":0,"direction":"monitor"},"deadLetters":{"delta":0,"direction":"flat"}},"safetyRegressions":[],"safetyDegraded":false}
[EVIDENCE] strategy-before {"version":"p4-default","enabled":true,"previousVersion":null}
[EVIDENCE] strategy-apply {"version":"p4-canary-v2","enabled":true,"previousVersion":"p4-default"}
[EVIDENCE] strategy-switch-off {"version":"p4-canary-v2","enabled":false,"previousVersion":"p4-default"}
[EVIDENCE] strategy-rollback {"version":"p4-default","enabled":true,"previousVersion":"p4-canary-v2"}
```

说明：两次基线是同一份代码 + 同一份评测集（digest 相同、逐用例 taskId 不同但结果相同），diff 全部 `flat`、`caseDiffs=[]`，即"重放可复现"；`tokenCostTotal.comparable=false` 是因为 5 条用例中 1 条无 usage（未知桶未补齐），不是 0 成本。

**用例（`tests/agent-eval-baseline.test.js`，7 条，全过）**
a 评测集字段校验+digest 稳定+非法集被拒；b 同一评测集两次重放逐用例结果一致；c 单任务聚合（attempts=2/rework=1/token=180/latency=900ms）；d 多任务汇总不双计（total=610=各例之和）且无 usage 进未知桶（`tokens=null`、`complete=false`）；e 快照落盘/回读 + diff 识别改善/退化/逐用例变化 + 安全退化（`approvalBypass`/`deadLetters` 上升）；f 策略版本标识/开关/回滚闭环；g 安全指标从既有事件读（`worker.scope_denied` 计入 fail-closed 与 unauthorizedDenied；应审校但无审校事件计为 bypass）。

**判定 1.0（仅指第 1 项交付物）**：评测集、指标、基线录制、对比报告、策略版本最小机制五项均有代码与可复跑证据；指标口径复用 `cost-tracker`/`tasks.getTask`/run 时间戳，未知桶独立且不为 0，安全指标只读既有事件与死信。**但这只是"机制齐了"，不是 Notion 退出判据已满足**：本轮没有任何策略变更，所以 diff 必然 flat，无法证明"可重复改善"；安全计数在离线 stub 下为结构性 0，不能证明"安全不退化"。退出判据需要后续第 2/3 项加上真实策略对比（以及一轮真实模型）后才可能成立。

**偏离与未验证**
- 延迟是**虚拟时钟**写进 run 的 `startedAt/finishedAt` 的模拟值（stub 脚本推进），不是真实供应商延迟；真实延迟需真实模型轮；
- 安全计数在离线数据目录里为 0（无真实审批/越权/死信流量），`collectSafety` 只证明读数链路，不证明生产安全水位；
- 策略版本目前只标识/开关/回滚，未接入任务执行路径（原文只要求最小闭环）；
- 评测集未校验 `agentId/taskType` 是否在 manifest 注册表中（写错会在 createTask 时失败）；
- `listEvents` 每 bot 上限 200 条，safety 计数可能截断；
- 未接真实模型；未做动态组队/重规划/验证强度选择；未做灰度发布系统。

**门禁与全量（本项收口一次）**：baseline 更新（`backendTotal 2217→2224`、`runnerTotal 1995→2002`、新增 `agent-eval-baseline` 7 条、`nodeTestSuiteTotal` 222 不变、`frontend` 188/22 不变）；`sync-doc-counts --write` 更新 10 处；`tsc --noEmit` EXIT=0；`npx expo lint` EXIT=0；`verify-test-coverage` → `backend=2224/2224 nodeSuite=222/222 runner=2002/2002 frontend=188/188 suites=22/22 failed=0`、CI runner 覆盖 92/92、EXIT=0；`sync-doc-counts --check` → `backend 2224、nodeSuite 222、runner 2002、frontend 188、文件 92` EXIT=0；`verify-api-capabilities` → 95 路由 / 20 族 / 仅 API 9，EXIT=0；全量前台 `node scripts/run-tests.js` → `92 个测试文件，全部通过`、`FULL_EXIT=0`。

---

## Phase 4 第 2 项：动态组队 / 重规划 / 验证强度选择（2026-11-05）

对应 Notion：Phase 4 / §5 / 交付物「按真实运行数据动态组队、重规划、选择验证强度」/ 退出判据「相对基线在成功率、返工率、成本或延迟上有可重复改善，且安全指标不退化」。

**实现（全部默认关闭，由 `strategy-version` 开关控制：`p4-default` 关、`p4-autonomy-v1` 开）**

| 交付物 | 位置 | 判据 / 复用口径 |
|---|---|---|
| 动态组队 | `server/agents/autonomy-policy.js` `plan` | 高风险任务类型（`action.execute`/`memory.write`）或历史同类型成功率 <0.6 → 组队；否则单 Agent。成员按已注册 manifest 的 `capabilities` 覆盖 `REQUIRED_CAPABILITIES` 选取，依赖边由成员顺序生成 |
| 轨迹写入 | `eval-runner.js` `route:{orchestration}` | 复用 Phase 1 的 `task.route.orchestration` 字段（`entry/basis/intentDigest/capability/matchingRule/matchedAgentIds/registeredAgents/selectedAgentId`），不新造轨迹口径 |
| 重规划 | `autonomy-policy.js` `decideReplan` | 只对可恢复错误（`review_rejected`/`evidence_insufficient`/`capability_mismatch`）重规划；`attempts < task.maxAttempts`（既有字段，取自 `createTask` 写入值）且预算有余量才允许，一次即止；瞬态错误走既有 retry，硬失败不重规划，避免假成功 |
| 验证强度 | `autonomy-policy.js` `verificationStrength` | 高风险 → 审校；高风险 + 证据弱 → 审批；执行器把结果写成既有 `task.requiresReview`，事件仍用 `verification.review_opened`/`verification.verdict` |
| 团队子任务 | `eval-runner.js` | 高危完成用例创建 `reviewer` 的 `review.verify` 子任务（`parentTaskId` 指向父任务，受父级 token 余额硬约束），其 token 经 `cost-tracker.taskCost` 计入用例成本 |
| 评测集扩容 | `server/agents/eval-suite-v1.json` | 5 → 13 条，新增：`exec-execute-slow`、`exec-recover-after-failure`（审校拒绝后可重规划翻盘）、`exec-hard-failure`（`evidence_missing` 硬失败不重规划）、`knowledge-multi-source`、`memory-search-quick`（单 Agent 够用）、`write-high-risk`（需组队审校）、`knowledge-unknown-usage`（未知桶）、`summary-fast` |

**两轮对比（同评测集 / 同配置 `BLUEBIRD_AGENT_TASK_MAX_ATTEMPTS=3`，stub 离线重放，非真实模型）**

```
p4-default      : successRate 12/13=0.9231  rework 1 (rate 0.0769)  tokens 1620 (known 11 / unknown 2)  latency avg 542ms max 1200ms
p4-autonomy-v1  : successRate 13/13=1.0000  rework 2 (rate 0.1538)  tokens 1860 (known 11 / unknown 2)  latency avg 573ms max 1200ms
delta           : successRate +0.0769  reworkRate +0.0769  reworkTotal +1  tokenCostTotal +240  latencyAvgMs +31
caseDiffs       : executor-reviewed-success tokens 250→290；exec-execute-slow 300→340；write-high-risk 150→190；
                  exec-recover-after-failure terminal failed→completed、attempts 1→2、rework 0→1、tokens 100→220、latency 400→800
safety          : approvalBypass 0→0  failClosedHits 0→0  unauthorizedDenied 0→0  deadLetters 0→0（safetyRegressions=[]，safetyDegraded=false）
```

快照文件：`eval-baselines/p4-policy-default.json`、`eval-baselines/p4-policy-autonomy.json`（`tokenComparable=false` 因 2 条无 usage，未知桶未补齐）。

**真实模型两轮（LongCat-2.5；同 13 条集、同 `MAX_ATTEMPTS=3`、脚本层 `scripts/p4-eval-real.js` 串联既有 api-configs/model-adapter 通道）**

| 指标 | `p4-default` | `p4-autonomy-v1` | delta（原始值） |
|---|---|---|---|
| 成功率 | 11/13 = 0.8461538461538461 | 13/13 = 1 | +0.15384615384615385 |
| 返工 | 1 例 / 1 次（rate 0.07692307692307693） | 2 例 / 2 次（rate 0.15384615384615385） | +0.07692307692307693 / +1 |
| token（真实 usage，含失败调用） | 3070 | 3668 | +598 |
| 延迟均值（run 墙钟 `startedAt→finishedAt`） | 6144ms | 8089ms | +1945ms |
| 延迟最大 | 11495ms | 29625ms | +18130ms |
| 安全计数（approvalBypass / failClosedHits / unauthorizedDenied / deadLetters） | 0 / 0 / 0 / 0 | 0 / 0 / 0 / 0 | flat，`safetyRegressions=[]` |

快照：`eval-baselines/p4-real-default.json`、`eval-baselines/p4-real-autonomy.json`；`eval-diff` 输出 `tokenComparable=true`、`suiteChanged=false`。

逐用例归因（避免把随机波动算成策略收益）：
- `exec-recover-after-failure`：failed(`review_rejected`) → completed，attempts 1→2、rework 0→1、tokens 170→673、latency 5517→29625ms —— 这是重规划带来的**结构性** +1；
- `research-success`：failed(`empty_response`，首轮 completion 顶到 400 max_tokens 被截断) → completed(tokens 378) —— 这是**同一配置下的采样波动**，不属于策略收益；
- 其余 11 例终态不变；`p4-autonomy-v1` 的额外 token 来自 4 个 reviewer 子任务与 1 次 replan；其中 3 个 reviewer 调用因 160 max_tokens 被 reasoning 吃掉而返回空内容（`empty_response`），**如实计为失败调用**，其 usage 仍计入 token；
- 失败调用：`p4-default` 1 次、`p4-autonomy-v1` 3 次（均在 reviewer 子任务），未丢弃任何一次。

真实消耗与重跑披露：
- 本轮计费口径的 `billedTokens` = 3070 / 3668；
- 首次 `p4-default` 轮因脚本 bug 只跑了多 attempt 用例的第 1 步（`retry-then-success` 被判 failed），该轮作废并重跑一次（约 2527 token 未计入上表）；
- 首次 `p4-autonomy-v1` 轮在 `exec-recover-after-failure` 处因 `const` 重赋值 bug中断（前 7 例调用已发生但未计入上表）；
- 两次作废轮均为**修 bug**，不是为让 delta 好看而重跑；表内两轮为同一脚本版本、同一配置的完整跑。

密钥纪律：`server/.env` 仅写入一行 `LONGCAT_API_KEY=ak_2Sq…`，`.gitignore:2:.env` 命中、`git status --porcelain=v1 -uall` 从未出现该文件；两轮结束立即删行删文件，`Test-Path server/.env` → `False`，`git grep` 全仓无完整 key，`server/data/` 扫描无残留，临时 Provider 已 `deleteModelProvider`（两轮各输出 `provider-cleanup {"removed":true}`），临时数据目录已删。**已清理，可吊销。**

**用例（`tests/agent-autonomy-policy.test.js`，5 条，全过）**
a 默认关闭（`p4-default` 不组队、`route=null`、无 policy 字段）；b 开启后高危按能力覆盖组队（`members=[executor,reviewer]`、依赖 1 条）、低风险单 Agent、历史成功率 <0.6 触发组队；c 重规划受 `maxAttempts`/预算/可恢复错误三重约束（关闭→`policy_disabled`、达上限→`max_attempts_reached`、预算耗尽→`budget_exhausted`、`model_timeout`→`non_recoverable_error`）；d 验证强度复用 `requiresReview`，证据弱升级审批；e 同一评测集两轮对比：默认轮无团队子任务/无重规划，开启轮 ≥3 例组队、1 例重规划、`task.route.orchestration` 落盘、团队 token 不漏计。

**判定 0.5（本项）**：真实两轮已跑出可复算的 delta，安全计数未退化，重规划带来 1 例结构性翻转；但按退出判据"可重复改善"仍不成立——成功率 +0.15384615384615385 中有 1 例是采样波动（`research-success` 首轮被 max_tokens 截断），策略结构性收益仅 +1 例；返工 +1、token +598、延迟均值 +1945ms 三项均为负向，且单轮无法证明"可重复"。因此判 0.5：机制与真实证据齐了，净收益未达 1.0 门槛。后续 3+3 稳定性复跑见下一节：**1/3 配对复现**，维持 0.5。补齐条件：把 reviewer/主调用的 `max_tokens` 调到能容纳 reasoning 的水平（不改变预算上限）、评估是否只对高风险子集启用组队以压低 +44% 成本，并扩大样本量。

**门禁（收口一次，全部前台实跑）**
- `node scripts/sync-doc-counts.js --write` → `文档计数已是最新，无需修改`；
- `node scripts/verify-test-coverage.js` → `CI runner 覆盖：93/93`、`backend=2229/2229 nodeSuite=222/222 runner=2007/2007`、`frontend=188/188 suites=22/22 failed=0`、`✔ 测试覆盖验证通过`，EXIT=0；
- `node scripts/sync-doc-counts.js --check` → `✔ 文档计数与基线一致：backend 2229、nodeSuite 222、runner 2007、frontend 188、文件 93`，EXIT=0；
- `node scripts/verify-api-capabilities.js` → `✔ API 能力登记一致：后端路由 95 条、路由族 20 个、仅 API 的能力 9 个`，EXIT=0；
- `npx tsc --noEmit` EXIT=0；`npx expo lint` EXIT=0；
- 全量前台 `node scripts/run-tests.js` → `93 个测试文件，全部通过`（末尾 `通过 29 项，失败 0 项`），EXIT=0。

**限定**
- 延迟为两轮各自的墙钟 `startedAt/finishedAt`（真实供应商），但受网络与模型排队影响，单轮均值不能当稳定基线；
- `p4-autonomy-v1` 的 3 次失败调用来自 reviewer 子任务（160 `max_tokens` 被 reasoning 吃掉），属评测串联的额度设置问题，不是策略逻辑失败；
- 历史成功率判据已实现参数入口，但评测执行器未注入历史值（当前恒为 null，仅高风险规则生效）；
- 团队子任务是"审校一例"的最小形态，不是通用 DAG 编排；
- 安全计数在隔离数据目录恒为 0，只证明读数链路，不证明生产安全水位。

---

## Phase 4 第 2 项 稳定性复跑（3 + 3 轮，2026-11-05）

**跑法**：同一 13 条集、LongCat-2.5、`MAX_ATTEMPTS=3`、同一脚本版本；`p4-default` × 3 与 `p4-autonomy-v1` × 3 **顺序执行**（不并行）。结论判定规则在跑前写死：按轮次下标配对（default-rN vs autonomy-rN），`autonomy.successRate > default.successRate` 记为"复现提升"；1.0 要求 3/3 复现 + 6 轮安全计数无退化 + 代价如实量化 + 无未披露作废轮。

**6 轮原始表（逐轮，非均值）**

| 轮次 | 策略 | 成功 | 返工次数 | 真实 token | 延迟均值 | 延迟最大 | 失败调用 | 安全四项 |
|---|---|---|---|---|---|---|---|---|
| r1 | `p4-default` | 12/13 = 0.9230769230769231 | 1 | 2840 | 5922ms | 12844ms | 0 | 0/0/0/0 |
| r2 | `p4-default` | 11/13 = 0.8461538461538461 | 1 | 2849 | 7585ms | 31205ms | 1 | 0/0/0/0 |
| r3 | `p4-default` | 11/13 = 0.8461538461538461 | 1 | 2498 | 4998ms | 9527ms | 1 | 0/0/0/0 |
| r1 | `p4-autonomy-v1` | 12/13 = 0.9230769230769231 | 2 | 4469 | 6730ms | 13741ms | 1 | 0/0/0/0 |
| r2 | `p4-autonomy-v1` | 13/13 = 1 | 2 | 3273 | 4711ms | 10517ms | 4 | 0/0/0/0 |
| r3 | `p4-autonomy-v1` | 11/13 = 0.8461538461538461 | 1 | 3961 | 7139ms | 16727ms | 4 | 0/0/0/0 |

**配对复现（规则：同轮次下标比较成功率）**

| 配对 | default | autonomy | 是否复现提升 |
|---|---|---|---|
| r1 | 0.9230769230769231 | 0.9230769230769231 | 否（flat） |
| r2 | 0.8461538461538461 | 1 | 是（+0.15384615384615385） |
| r3 | 0.8461538461538461 | 0.8461538461538461 | 否（flat） |

结论：**1/3 复现**，未达 3/3，按写死规则**判 0.5**。r1 与 r3 未复现的具体原因：
- r3 `autonomy` 的 `exec-recover-after-failure` 首轮调用返回空内容（`empty_response`，completion 被 400 `max_tokens` 截断），该错误不在可恢复集合，故未触发重规划；同轮 `default` 该例也失败（`review_rejected`），因此打平；
- r1 `autonomy` 的 `memory-search-quick` 触发真实预算闸门（304 > 300 cap → `budget_exceeded`），而 `default` 同轮该例通过，抵消了重规划翻盘的 +1；`default` r1 只失败 `exec-recover-after-failure` 一例。

**代价（6 轮合计）**：token `p4-default` 8127 / `p4-autonomy-v1` 11702（+3575，约 +44.0%）；返工总次数 3 / 5；延迟按 3 轮均值 6168ms / 6027ms（差异在噪声内，不作为改善）；6 轮安全计数全 0，无退化。

**作废轮披露**：本轮 6 次执行无作废。此前两次作废轮（脚本 bug）不计入上表：`p4-default` 作废轮约 2527 token；`p4-autonomy-v1` 中断轮前 7 例调用已发生但计费量未采集（不可知）。连同上一提交的完整两轮 6738 token，本项已知真实消耗合计约 **29,155 token**（另加不可知的中断轮）。

**限定**：单机、单供应商单模型、13 条构造评测集、每策略 3 轮；空内容失败源于 `max_tokens` 与 reasoning 竞争，属评测串联额度设置，不是策略逻辑失败。

快照：`eval-baselines/p4-real-default-r{1,2,3}.json`、`eval-baselines/p4-real-autonomy-r{1,2,3}.json`。

---

## Phase 4 终态收口（2026-11-05）

| 项 | 判定 | 依据 |
|---|---|---|
| 第 1 项 离线评测集与基线度量 | **1.0** | 评测集/指标/基线/对比/策略版本最小闭环均可复跑；仅指机制齐备 |
| 第 2 项 动态组队/重规划/验证强度 | **0.5（未证实）** | 3 对配对复现 1/3；代价 token +44.0%、返工 3→5；安全未退化 |
| 第 3 项 灰度发布 / 逐步开放低风险自动化 | **未做/不适用** | 本阶段未做灰度发布与真实流量开放；原文第三分句未进入实施 |

**阶段结论：Notion Phase 4 退出判据未满足。** 原句「相对基线在成功率、返工率、成本或延迟上有可重复改善，且安全指标不退化」——只满足后半句（6 轮四项安全计数全 0，无退化）；前半句不成立：3 对配对中仅 r2 复现提升（0.8461538461538461→1），r1（0.9230769230769231→0.9230769230769231）与 r3（0.8461538461538461→0.8461538461538461）均持平，复现率 1/3。

**默认关闭（生产不启用）**：`server/agents/strategy-version.js:12` `DEFAULT_STATE = { version: 'p4-default', enabled: true }`；`server/agents/autonomy-policy.js:14` `ACTIVE_VERSION = 'p4-autonomy-v1'`，`autonomy-policy.js:28-30` `isEnabled()` 仅在 `state.version === ACTIVE_VERSION` 时为真 → 未写策略状态文件时 `plan/decideReplan/verificationStrength` 全部走关闭分支。因收益未证实且稳定多耗 token（6 轮 8127 → 11702，+44.0%），保持默认关闭。

**不包装为"平均提升"**：6 轮逐轮数字保留在上节表内（success：`p4-default` 12/11/11，`p4-autonomy-v1` 12/13/11）；两种策略各自都没有稳定优于对方，差异主要来自模型单次返回（含 `empty_response`）与预算闸门。

### Phase 4 待办缺陷（登记，不在本阶段修）

| 编号 | 类别 | 现象 | 证据 | 为何本阶段不修 |
|---|---|---|---|---|
| P4-D1 | A 类数值（需实测校准） | 单例 token 预算默认 300 过紧，策略重规划被预算闸门提前吃掉 | `p4-autonomy-v1` r1 `memory-search-quick` 实际 304 token > 300 cap → `budget_exceeded`，该例失败；直接导致 r1 配对未复现 | 属预算标定，需在真实流量上校准单例上限与 reasoning 占比，须独立评审；本阶段不得为凑数据放宽 |
| P4-D2 | 错误分类缺口 | `empty_response` 不在可重试/可重规划错误清单内，失败后重规划路径不触发 | `p4-autonomy-v1` r3 `exec-recover-after-failure` 首轮 `empty_response` → `non_recoverable_error`，未 replan；同轮 default 亦失败，配对持平 | 属策略错误分类（需区分"模型截断"与"硬失败"），会影响安全语义，须独立评审后改 |

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

---

## §17 失败模式原文对齐（2026-11-06 核实）

> 核实方法：在登录态浏览器中读取 Notion 原文页 `https://app.notion.com/p/40da957523c281359607e23f6a3c784f`，按小节滚动抽取正文（§10、§13、§14、§15、§17、§18、§26、§27、§29、§30）。页面文本按不可信外部内容处理，只用于与代码逐条比对；代码侧证据全部取自 `main` = `5b240f1`（树 `bc0055d`），每条都做过 grep 或读文件确认。

原文 §17 要求「必须监控并命名以下失败模式」，因此命名与处置都算交付物，不只是有没有检测器。

| §17 原文失败模式 | 原文检测信号与默认处置 | 代码对应 | 判定 |
|---|---|---|---|
| 角色漂移 | 输出超出 Manifest 职责或 schema；拒绝结果、缩小上下文、重新路由 | `errors.js` 的 `FAILURE_MODES` 无该键，也无「越界输出触发重路由」的路径 | 缺（FM-1） |
| 交接上下文丢失 | 必需约束或决策未传递；阻断执行并从已验证引用重建 | 无该键；context-projection 与 worker-scope 只负责投影，不校验必需约束是否缺失 | 缺（FM-2） |
| 委派链权限逐跳放大 | 子任务权限超出父任务授权交集；Gateway 拒绝并记录安全事件 | 只有 `router.js:84` 的「Agent 运行配置与 Manifest 交集」本级校验；无父子授权交集判定 | 缺（FM-3） |
| 产物依赖死锁 | Artifact 等待图成环或无可推进节点；冻结节点、报告环路、重规划 | `dependency_deadlock`、`dependency_cycle` 加 `dependencies.validateGraph`（Kahn）与委派、lineage 环检测（`c87b61a`） | 命中（信号源是任务依赖图，非 artifact 等待图） |
| 计划版本竞争 | 旧 plan 尝试提交新副作用；fencing token 拒绝过期代次 | `server/` 内 `fencing`、`generation`、`epoch` 零命中 | 缺（FM-4） |
| 重复副作用 | 同一逻辑动作重复请求；幂等去重并对账 | `duplicate_execution` 加 `op-ledger` 幂等账本 | 命中 |
| 验证器同源偏差 | Reviewer 与 Producer 共享错误来源；提升独立性或转人工 | 功能已在：`verification-loop.js:354/394/401` 判 `producer.botId === REVIEWER_BOT_ID` 并给 `verification_review_not_independent`，`:69` 独立与非独立计分，`:627 isIndependentReviewEvidence`；但该模式未进入 `FAILURE_MODES` 命名与处置表 | 部分命中（FM-5） |
| 事件乱序 / 重放 | 版本倒退、重复终态事件；aggregate version 校验、幂等处理 | `event_out_of_order` 加事件投递幂等键（`479bfd9`）与 `stateVersion` CAS | 命中 |
| 预算耗尽 / 重规划风暴 | 重试或委派持续消耗预算；熔断、停止重规划、交付部分结果或请求决策 | `budget_exhausted` 名义命中；但无熔断、无风暴判据、无「部分结果交付」路径，只有 `agent-limits` 的次数硬限 | 部分命中（FM-6） |

结论：代码九个键里有 5 个（`stale_lease`、`artifact_chain_broken`、`partial_commit`、`approval_stall` 及重复计入的 `dependency_cycle`）是仓库自选补充，而原文点名的 6 类只有 1 类以功能形式存在、其余未命名亦未检测。A-10 由 1.0 改判 0.5。

### 缺口编号与验收判据（可直接派工）

| 编号 | 原文要求 | 建议落点 | 验收判据 |
|---|---|---|---|
| FM-1 角色漂移 | 检测输出是否越出 Manifest 声明的职责与 schema，处置为拒绝结果、缩小上下文、重新路由 | `verification-loop.js` 的确定性校验加 `FAILURE_MODES` 新键与处置路由 | 用例覆盖：越界输出被拒且触发重路由，不产出成功结果 |
| FM-2 交接上下文丢失 | 必需约束或决策未传递时阻断执行，并从已验证引用重建 | `context-projection.js` 加 `FAILURE_MODES` 新键 | 用例覆盖：缺必需约束的任务不启动；重建后恢复且留审计 |
| FM-3 委派链权限逐跳放大 | 子任务权限必须落在父任务授权交集内，越权由 Gateway 拒绝并记安全事件 | `router.js` 与 `tool-gateway.js` 的委派入口加 `worker-scope` 令牌签发 | 用例覆盖：父任务窄、子任务宽时拒绝且零副作用 |
| FM-4 计划版本竞争与 fencing | 旧 plan 提交新副作用必须由 fencing token 拒绝过期代次 | `workflow-store.js` 代次签发加 `op-ledger.js` 写入前置校验 | 用例覆盖：过期代次的副作用写入被拒并记审计；新代次正常 |
| FM-5 验证器同源偏差命名化 | 把已有的独立性判定纳入统一命名与处置（提升独立性或转人工） | `errors.js` 新增键并在 `agent-runtime.js` 处置表落 `escalate` | 用例覆盖：同源 Reviewer 触发转人工而非静默通过 |
| FM-6 重规划风暴判据 | 熔断、停止重规划、交付部分结果或请求决策；配合 §26 的收益声明、等价计划拒绝、冷却窗口、diff 判据、禁止新建 run 规避 | `agent-limits.js` 加冷却窗口与指纹去重，`autonomy-policy.js` 的 `decideReplan` 加收益与 diff 判据 | 用例覆盖：相同 `errorFingerprint` 连续失败不再生成等价计划；达上限交付部分结果并披露 |

本表同时是「未完整模块清单」的落点依据：§13 的七因子路由记 A-06，§14 的五类比较对象与分层记 A-07，§18 的收益门槛与阶段占比记 A-11，§26 的四维限流与三态 breaker 记 B-07，§15 的轮值与责任人记 A-08 与 B-11。
