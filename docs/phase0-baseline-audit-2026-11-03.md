# Bluebird Agent Runtime｜Phase 0 基线审计（2026-11-03）

> 审计对象：目标架构《🏛️ Bluebird Agent Runtime｜混合式多 Agent 目标架构 v1.0》§0–§9（v1.0）与 §10–§22（v1.1 修订）。按文档约定，**v1.1 与 v1.0 有歧义时以 v1.1 为准**。
> 审计方式：代码事实优先的只读审计。未修改任何源码、测试、配置、`.env` 或 `server/data/`；未 commit / push / 开 PR。

## 相关文档（链位置）

- 上游：[交接文档](handover-2026-11-03.md)（仓库基线与硬约束）、Notion 架构页 v1.0 §0–§9 / v1.1 §10–§22（审计对象，`verification: unverified`）。
- 下游：[v1.3 裁决与待验证清单](v1.3-decisions-and-verification-checklist-2026-11-03.md)（缺口收口）、[ADR-0001](adr/0001-runtime-contract-decisions-2026-11-03.md)（§3.6/§4）、[产物与完成提交链审计](artifact-commit-chain-audit-2026-11-03.md)（转引 §4.4 五步口径）、[协议收敛方案](protocol-convergence-plan-2026-11-03.md)、[文档链总索引](doc-chain-index-2026-11-03.md)。
- 本文件位置：Phase 0 的**前置调研 / 差距证据**，按 v1.0/v1.1 口径得出，不覆盖 v1.2/v1.3；文末有「勘误（后续查证 2026-11-03）」追加段，引用相关位置时请同时引该段。

---

## 0. 审计元信息

| 项目 | 值 | 证据 |
| --- | --- | --- |
| 仓库根目录 | `C:/Users/Administrator/Documents/Qoder/2026-10-27/975cfd2c/Bluebird` | — |
| 分支 | `chore/eval-context-exit-code-2026-11-03` | `git branch --show-current` |
| HEAD | `936a3de`（含 `192be27`） | `git log --oneline -6` |
| 工作区 | 仅 `package-lock.json` 状态位；`git diff --numstat` 输出为空 → 内容与 HEAD 一致，属假阳性 | `git diff --numstat -- package-lock.json` |
| 架构文档 | Notion page `40da9575-23c2-8135-9607-e23f6a3c784f`，标题、§0–§22 均成功读取 | `notion-fetch` 返回完整正文 |
| 文档元数据 | Notion 返回 `verification.state = "unverified"` | `notion-fetch` metadata |
| 只读脚本 | `node scripts/verify-api-capabilities.js` → `后端路由 95 条、路由族 20 个、仅 API 能力 9 个` | 命令输出 |
| 明确未做 | 未跑全量测试、未调用真实 DeepSeek API、未打开前端、未复现并发冲突 | 见 §10 |

**审计完成度（静态）**：目标 §1 组件 18/18、§2 契约 5/5、§3 硬规则 6/6、§4 权限 4/4 均已逐项核对；**动态验证完成度 0**，所有运行时行为结论均标注为"代码可证"，不是"实测通过"。

---

## 1. 结论先行

### 1.1 三句话结论

1. **Phase 0 不能通过。** 两条验收中"关键状态可测试"基本成立，"没有第二套平行任务协议"不成立。
2. **应落 §21 的 B 分支。** 不是 C（Blackboard 尚不存在，谈不上一致性不足），不是 D（没有验证成本数据），也不是 E（未发现跨 Session 泄漏/越权/审计阻断缺陷）。B 的直接理由是：Task 状态协议存在多套权威声明、缺 CAS/期望版本、缺完成提交协议，无法安全承载 Phase 1 的并行 Worker。
3. **Phase 1 前必须先做"协议收敛 + CAS + 最小确定性验收"，不能直接加 Worker Pool。**

### 1.2 关键数字

| 指标 | 现状 |
| --- | --- |
| 已注册 Agent | 1 个（`memory`） |
| 逻辑组件已存在 | 1（Entry） |
| 部分存在 | 10（Registry、Policy、Worker Runtime、Tool Gateway、Context Broker、State Store、Event/Outbox、Observability、Approval、Evaluation，见 §2） |
| 缺失 | 7（Orchestrator、Planner、Blackboard、Artifact Registry、Workflow Engine、Verification、Improvement Pipeline） |
| Task Contract 文档字段覆盖率 | 约 12/17（不含 §16 污点 3 字段；`inputRefs` 仅部分覆盖） |
| Result Contract 文档字段覆盖率 | 约 7/10（其中 `artifactRefs`、`evidenceRefs`、`requiresApproval` 为部分覆盖） |
| Blackboard Artifact 字段覆盖率 | 0/10 |
| Workflow Event 字段覆盖率 | 约 4/8 |

> 计数口径见 §2、§3；"部分存在"不等于"可用"，每行均给出缺口。

---

## 2. 组件盘点（§1.1 四平面 + §19 六模块）

判定口径：
- **已存在**：有实现且覆盖该组件核心职责。
- **部分存在**：有实现但只覆盖子集，或关键语义缺失。
- **缺失**：仓库无对应实现（`grep` 无命中或只有文档声称）。
- **仅假设**：只在文档/注释中声称，代码无落地。
- **待验证**：静态审计无法确认。

| # | 逻辑组件 | 平面 | 结论 | 代码证据 | 缺口 / 说明 |
| --- | --- | --- | --- | --- | --- |
| 1 | Entry | 控制 | **已存在** | `server/index.js:136-140` 挂载 retrieval/agents/monitoring；`server/agents/routes.js:119-519` 暴露 agents/sessions/tasks/approvals；`server/index.js:203-229` Bearer 认证 + 恒定时间比较 + 失败限流 | 单共享 token，无用户/角色身份；入口不理解目标，只做鉴权与转发 |
| 2 | Orchestrator | 控制 | **缺失** | 全仓 `grep "Orchestrator\|orchestrat"` 无任务编排实现；`server/agents/router.js:174-336` 仅做单任务路由选择 | `server/context/orchestrator.js` 是**上下文预算编排**，不是 Task/Workflow Orchestrator；无跨任务调度、无动态组队、无结果汇总 |
| 3 | Planner | 控制 | **缺失** | 无 Planner 模块；`generatePlan` 只是一个布尔预算位（`server/agents/routing-config.js:34,40`；`server/agents/runtime.js:143`） | 无计划数据结构、无 planVersion、无重规划、无依赖图；`context/orchestrator.js:71-205` 的 `planForIntent` 只规划上下文层，不规划任务 |
| 4 | Agent Registry | 控制 | **部分存在** | `server/agents/registry.js:47-115`；清单 `server/agents/manifest.js:58-90`；健康态由凭证配置推导 `registry.js:23-40,80-91` | 静态硬编码 1 个 Agent；无动态注册/发现/能力匹配；Router 的 `candidates` 恒为空（`router.js:211-213`）；健康态只看凭证，未纳入心跳/队列 |
| 5 | Policy | 控制 | **部分存在** | `server/agents/permissions.js:12-40` 单用户权限；`server/agent-policy.js:29-57` 三种模式与预算；`server/agent-runtime.js:86,383-392` 工具三级风险 + 高风险确认 | 无 R0–R3；无数据范围/敏感度；无污点；无按调用参数校验；Policy 与 Manifest 未合并 |
| 6 | Worker Runtime / Agent Pool | 执行 | **部分存在** | `server/agents/runtime.js:41-43` 并发 2；`:55` 队列循环；`:120-144` 预算落地；`:967` 健康输出 | 进程内单 Agent 队列，无 Pool/动态分配；`BLUEBIRD_AGENT_TASK_CONCURRENCY` 默认 2；无跨 Agent 负载均衡 |
| 7 | Tool & Policy Gateway | 执行 | **部分存在** | `server/agents/tool-gateway.js` 白名单校验；`runtime.js` 在派发前拒绝非 allowlist；`agent-runtime.js:383-392` 高风险 `confirmation_required` | 无 per-call 参数策略、无 taint/provenance、无审批要求动态提升；`high_risk` 在本仓无实际注册工具（当前 `TOOL_RISKS` 仅 3 个枚举） |
| 8 | Blackboard | 协作 | **缺失** | 全仓 `grep "blackboard\|artifactId\|provenanceRefs\|taintLabel"` **零命中** | — |
| 9 | Artifact Registry | 协作 | **缺失** | Worker 结果产物固定为空：`server/agents/runtime.js:713` `artifacts: []`；无 artifact store、无版本、无 `contentRef` | `worker-result.js` 只接受字符串 ref 数组，未落任何产物 |
| 10 | Context Broker | 协作 | **部分存在** | `server/agents/context-projection.js:14-51` 拼装单条 worker 指令 + 父会话用户原话；`runtime.js:674` 注入 userId | 只做"私有上下文投影"，无跨 Agent 共享、无按需引用解析、无访问控制；可作为 §19 允许的 stub 起点 |
| 11 | Workflow Engine | 协作 | **缺失** | `grep "DAG\|dependsOn\|'workflow'"` 无实现；现有是 `tasks.js` 状态机 + `runtime.js` 队列 | 无 DAG、无节点依赖、无 fan-out/fan-in、无重规划；状态机只服务单任务生命周期 |
| 12 | State Store | 协作 | **部分存在** | `server/agents/task-store.js:96-113` 单机原子文件 `agent-tasks.json`；`:10-11` 单实例单写者；`:25-26` schema v1/v2 迁移 | 无 `expectedVersion` / CAS；`writeFileAtomicSync`（`server/atomic-write.js:6-18`）只保证落盘原子性，不保证并发更新不丢失 |
| 13 | Event Bus / Outbox | 协作 | **部分存在** | `server/agents/tasks.js:255-279` 事件双写；`:280-299` outbox；`:302-310` 主文件成功后移除 outbox；溢出 `drop_oldest` `:282-298` | 无 aggregateId/schemaVersion/payloadRef/idempotencyKey；无 Worker 消费端；事件只供 API/SSE；溢出主动丢事件，**不满足 §11 至少一次** |
| 14 | Verification | 质量 | **缺失** | `grep "Verification Engine\|verifier\|verifyArtifact"` 无实现；仅有记忆侧 evidence policy，与任务产物验证无关 | 无确定性验证、无独立 Reviewer、无 `trustLevel` 写入方 |
| 15 | Observability | 质量 | **部分存在** | `server/monitoring/store.js:436-574` trace/span；`:704-801` audit/stats；`monitoring/schema.js:83` `agent.gate` 等；`routes.js:68` 结果 SSE、`:336-341` 事件查询 | 有 trace/audit/SSE，但无任务级 token/费用/延迟归集；`worker-result` 无 `usage` 字段，成本不可核算 |
| 16 | Evaluation | 质量 | **部分存在（仅记忆/上下文）** | `package.json:44-48` 只有 `eval:memory / eval:semantic / eval:context / eval:retrieval / eval:embedding` | 无 Agent Runtime 评测集（任务完成率、返工率、并行收益、恢复率、重复副作用率、审批命中率），不满足 §7/§14 |
| 17 | Approval | 质量 | **部分存在** | `server/agents/approvals.js:176-229` 创建；`:269-344` 批准/拒绝；`:352-438` 执行；执行前二次权限校验 `:360-367`、任务态校验 `:369-378`；`permissions.js:36-38` | 无有效期/超时、无 fail-closed 落盘策略、无批量/升级/申诉；`waiting_approval` 不在 Watchdog 纳管范围（`watchdog-policy.js` 仅处理 queued/accepted/running 的租约） |
| 18 | Improvement Pipeline | 质量 | **缺失** | 无实现 | 与 §19 允许"先 stub"一致，但需明确不据此宣称自治 |

### 2.1 §19 六模块映射现状

| §19 模块 | 现有可复用 | 现状判定 |
| --- | --- | --- |
| Runtime Core（Entry/Orchestrator/Planner） | Entry + Router | **1/3**；Orchestrator/Planner 缺失 |
| Agent Catalog & Policy（Registry/Manifest/授权） | manifest/registry/permissions | **部分**；单 Agent、权限单用户 |
| Worker Executor（Worker/Pool） | runtime.js | **部分**；进程内、并发 2 |
| Workflow & Event（Workflow/State/Outbox） | tasks 状态机 + task-store + outbox | **部分**；无 DAG、无 CAS、outbox 会丢事件 |
| Collaboration Store（Blackboard/Artifact/Context Broker） | context-projection 最小投影 | **1/3**；Blackboard/Artifact 缺失 |
| Quality & Governance（Verification/Approval/Observability/Evaluation/Improvement） | approvals + monitoring | **2/5**；Verification/Improvement 缺失，Evaluation 仅记忆域 |

---

## 3. 契约盘点（§3 与 §16）

### 3.1 Agent Manifest

**结论：部分存在。** 实现 `server/agents/manifest.js:58-86`，对外视图 `registry.js:66-91`。

| §3 字段 | 现状 | 代码位置 / 差异 |
| --- | --- | --- |
| 身份 | 已实现 | `botId`、`displayName`（`manifest.js:59-60`） |
| 能力 | 已实现 | `capabilities`、`acceptedTaskTypes`、`taskContracts`（`:63-77`） |
| 版本 | 已实现 | `version`（`:61`） |
| 模型配置 | **不在 Manifest** | 在 `server/agents/config.js`，Manifest 只存 `permissionProfileId`；模型/凭证按 Bot 配置解析 |
| 工具权限 | 已实现 | `toolAllowlist`（`:79`） |
| 数据范围 | **缺失** | 无 `dataScope`/租户/用户范围字段；实际由 `userId` 由服务端实例身份兜底（`user-scope.js:29-45`） |
| 预算 | **缺失** | 只有 `concurrencyLimit`、`defaultTimeoutMs/min/maxTimeoutMs`（`:81-84`）；无 token/费用预算 |
| 并发 | 已实现 | `concurrencyLimit`（`:81`） |
| 健康状态 | **派生，不落 Manifest** | `registry.js:23-40` 由 provider/model/credential 推导 `enabled/degraded/disabled` |

### 3.2 Task Contract

**结论：部分存在，且是 §3 中缺口最集中的契约。** 创建字段 `tasks.js:484-650`，对外字段 `tasks.js:350-403`。

| §3 字段 | 现状 | 代码位置 / 差异 |
| --- | --- | --- |
| `taskId` | 已实现 | `tasks.js:604` |
| `parentTaskId` | **缺失** | 只有 `parentSessionId/parentMessageId`（`:629-630`）；委派关系无法从任务图恢复 |
| `planVersion` | **缺失** | 无字段；`route` 有 `routeId/contractVersion`（`router.js:202-219`），但不是计划版本 |
| `runId` | 已实现 | 单当前值 `runId`，历史在 `runs[]`（`:619,627`） |
| `sessionId` | 已实现 | `workerSessionId` + 兼容别名 `sessionId/botId`（`:607-610`） |
| `agentId` | 已实现 | `:606`；`botId` 为同值别名 |
| `taskType` | 已实现 | `:611` |
| `dependencies` | **缺失** | 无 `dependsOn`、无 fan-in 关系 |
| `inputRefs` | **部分（单个字符串）** | 仅 `contextRef`（`:615`），不是引用数组 |
| `acceptanceCriteria` | **缺失** | 无字段；完成判定只看 worker status |
| `allowedTools` | 已实现 | `:637`，且必须 ⊆ Manifest allowlist（`:550-562`） |
| `budget` | **部分** | 仅 `maxRounds/maxToolCalls/maxReadOnlyRetries/generatePlan`（`:429-453`）；无 token、费用、委派数预算 |
| `deadline` | 已实现（命名差异） | `deadlineMs`（`:638`），校验 5–120s（`:541-548`） |
| `idempotencyKey` | 已实现 | `:616`；同 Agent 同键复用（`:586-587`） |
| `status` | 已实现 | `:639` |
| `attempt` | 已实现（命名差异） | `attempts`（`:641`），`maxAttempts`（`:642`） |
| `traceId` | **缺失** | 任务不存 traceId；监控 trace 是另一套 id（`monitoring/store.js:444`），二者未关联 |
| §16 `provenanceRefs` | **缺失** | `grep` 零命中 |
| §16 `taintLabels` | **缺失** | `grep` 零命中 |
| §16 `taintPolicyVersion` | **缺失** | `grep` 零命中 |

补充：`goal`、`context`、`priority`、`route`、`requiresReview`、`delivery*`、`lease`、`checkpointVersion` 是文档外字段；其中 `checkpointVersion` 是"有版本号但无 CAS"的关键证据（见 §4.3）。

### 3.3 Result Contract

**结论：部分存在。** 唯一归一化入口 `server/agents/worker-result.js:58-85`；任务结果落库 `tasks.js:649` / `updateTask`。

| §3 字段 | 现状 | 代码位置 / 差异 |
| --- | --- | --- |
| `status` | 已实现 | `worker-result.js:58,72`；仅允许终态集合 `:12-17` |
| `summary` | 已实现 | `:59,78`，上限 8000 `:19` |
| `artifactRefs` | **部分（命名差异）** | `artifacts` 数组，元素是字符串 ref（`:60,79`）；无 artifactId/version |
| `evidenceRefs` | **部分（命名差异）** | `evidence`（`:61,80`） |
| `toolSteps` | 已实现 | `:62,81`，摘要上限 160（`:37`） |
| `assumptions` | **缺失** | 无字段 |
| `unresolvedItems` | **缺失** | 无字段 |
| `errorCode` | 已实现 | `:65,85` |
| `requiresApproval` | **部分** | 由 `requiresConfirmation` 派生（`:75,83-84`），但无审批策略/等级 |
| `usage` | **缺失** | 无 token/费用/时长；`runtime.js:713` 结果也不带 usage |

补充字段：`changes`、`rounds`、`stopReason`、`model`、`runId`、`finishedAt` 存在（`worker-result.js:63-85`）。

### 3.4 Blackboard Artifact

**结论：完全缺失。**

| §3 字段 | 现状 |
| --- | --- |
| `artifactId` / `taskId` / `producerAgentId` / `type` / `contentRef` / `sourceRefs` / `version` / `createdAt` / `trustLevel` / `accessPolicy` | **0/10**；全仓无 Blackboard 模块、无 artifact store、无对应 API |

最强反证：`runtime.js:713` 对每个成功任务都写 `artifacts: []`，说明当前结果合同只允许"空产物"通过。

### 3.5 Workflow Event

**结论：部分存在。** `server/agents/tasks.js:255-279`。

| §3 字段 | 现状 | 代码位置 / 差异 |
| --- | --- | --- |
| `eventId` | 已实现 | `:270`，`evt_<uuid>` |
| `aggregateId` | **缺失** | 只有 `taskId/runId`；无聚合根与版本 |
| `eventType` | 已实现 | `:276`，受 `EVENT_TYPES` 白名单约束 `:50,265` |
| `schemaVersion` | **缺失** | 事件级无版本；只有任务文件 schema v2（`task-store.js:25`） |
| `occurredAt` | **部分（命名差异）** | `timestamp`（`:275`） |
| `correlationId` | 已实现 | `:278`，缺省回退 taskId/runId |
| `payloadRef` | **缺失** | `payload` 内联（`:277`），仅做字段裁剪，无外部引用 |
| `idempotencyKey` | **缺失** | 仅靠 `eventId` 去重（`:302`） |

补充：`outbox` 在同一函数内双写（`:280-310`），但溢出策略 `drop_oldest`（`:282-298`）会主动丢事件。

### 3.6 关键问题：仓库是否已有"第二套平行任务协议"？

**结论：是，但不是"第二套任务队列"，而是"第二套协议面"。** 只有一个任务存储与队列（`agent-tasks.json` + `runtime.js`），但围绕同一批任务存在多套互不对齐的权威/计划/状态/版本/预算协议：

| # | 平行协议 | 证据 | 与文档冲突点 |
| --- | --- | --- | --- |
| P1 | **事实权威冲突**：事件 vs 状态机 vs 任务文件 | `tasks.js:7`「事件是 UI 状态的唯一事实来源」；`state-machine.js:5`「合法迁移是唯一事实来源」；`task-store.js:10-11`「单机原子文件 + 单实例写者」 | §11 要求 **State Store 是 Task/Workflow 状态唯一权威，Event Bus 只通知**。三句"唯一"并存，且事件无 aggregate version，无法证明不漂移 |
| P2 | **计划协议分离**：上下文 plan 不是任务 plan | `context/orchestrator.js:71-205` 产出 `intent/layers/budgets`；`context/trace.js:126-190` 独立记录 `orchestration`；Task Contract 无 `planVersion` | §10 要求 planVersion v1→v2 迁移、旧计划 fencing；当前"计划"与任务无 id 关联，无法迁移或 fencing |
| P3 | **状态词表重复**：Session 生命周期复刻 Task 状态 | `sessions.js:26-34` `active/running/completed/failed/cancelled/timed_out/closed`；Task 状态 `state-machine.js:11-21` | 两套 `running/completed/failed/cancelled/timed_out` 由不同模块独立写入；Session `completed` 不由 Task 终态推导，§11 唯一权威无法成立 |
| P4 | **多套版本号、无 CAS** | `checkpointVersion`（`tasks.js:626,769-770,1005-1006`）；`decisionVersion`（`memory.js:209,610,698,1524,1559`）；任务文件 `version`（`task-store.js:25`） | §11 要求"更新携带 expectedVersion，存储层单调分配"；现有版本号只是计数器/策略版本，均可被任意 patch 覆盖，未做比较交换 |
| P5 | **三套预算模型** | 上下文预算 `orchestrator.js:83-158`；路由/任务预算 `router.js:196-201` + `routing-config.js:29-42`；直接对话策略预算 `agent-policy.js:48-50,217-219` | §18 要求统一截止时间/重规划次数/剩余预算阈值；当前三种预算字段无统一换算与总账，任务级无 token/费用 |

**判断**：P1–P5 均属于"协议未收敛"，可修复；但按 §5 Phase 0 验收原文，**"没有第二套平行任务协议"当前不成立**。修法不是"再写一套"，而是保留现有单队列，冻结唯一权威与唯一契约。

---

## 4. 硬规则的可测试性

### 4.1 总表

| 硬规则 | 结论 | 代码证据 | 测试证据 | 差距 |
| --- | --- | --- | --- | --- |
| State Store / Event Bus 权威分离；至少一次 + 幂等 | **部分** | 状态落 `agent-tasks.json`（`task-store.js:96-113`）；事件落 `agent-events.json` + outbox（`tasks.js:280-310`） | outbox 补写：`tests/agent-dispatch.test.js:977`、`tests/agent-storage-limits.test.js:28,116`；幂等：`tests/agent-router.test.js:426,559` | 权威声明冲突（§3.6 P1）；事件无消费者、无 aggregate version；溢出丢事件（`tasks.js:282-298`）→ **不满足至少一次** |
| 完成提交协议（产物先持久化再提交状态） | **缺失** | 无 artifact store；结果与状态一次性写任务文件（`tasks.js:695` 起 `updateTask`）；`runtime.js:713` `artifacts: []` | 无对应测试 | 无 `pending-commit/orphan`、无"引用可读再 completed"；§11 完成协议 1–5 均未实现 |
| CAS + 显式版本 | **缺失** | `checkpointVersion` 只是计数器（`tasks.js:1005-1006`），`updateTask` 接受任意非负值（`:769-770`）；无 `expectedVersion`；`atomic-write.js:6-18` 仅保证单次落盘原子 | 无 CAS 冲突测试；租约测试只覆盖 owner/过期（`tests/agent-recovery.test.js:159-204`） | 并发 Worker 会丢失 checkpoint；无 fencing token（§17） |
| `trustLevel` 只能由验证层写入 | **缺失** | 全仓无 `trustLevel`、无 Verification Engine | 无 | Producer 甚至没有 `confidence` 字段；验证层不存在 |
| R0–R3 风险分级 + 审批 fail-closed | **部分** | 工具三级风险 `agent-runtime.js:86,383-392`；记忆操作 risk `memory-service.js:17-23` + `approvals.js:229`；审批必须显式批准 `permissions.js:36-38`；执行前二次校验 `approvals.js:360-367` | 审批闭环：`tests/memory-maintenance.test.js:172-221`；未授权工具拒绝：`tests/agent-worker.test.js:556` | 无 R0–R3 映射；无审批 TTL；`waiting_approval` 不被 Watchdog 纳管；无批量/升级/申诉；未验证审批超时行为（因为根本没有超时） |
| 委派深度/预算/超时/循环检测 | **部分** | 预算落地 `runtime.js:120-144`；deadline 5–120s（`tasks.js:541-548`）；委派只允许 memory（`tool-dispatch-bot.js:13,32-34`）；委派工具 `risk: reversible_write`（`:117`） | deadline：`tests/agent-runtime-guards.test.js:276`、`tests/agent-worker.test.js:543`；预算：`tests/agent-router.test.js:680`；恢复：`tests/agent-recovery.test.js` | 无委派深度计数器、无 `parentTaskId`、无子任务数预算、无权限交集；无循环检测（无 DAG/Artifact 图可检）；无 token/费用预算。深度目前只靠"Memory Bot 没有 delegate 工具"结构性封顶为 1 跳，不是显式策略 |

### 4.2 对"至少一次 + 幂等"的精确判断

- **生产者侧**：主文件写失败时事件保留在 outbox，恢复后补写（`tasks.js:301-310`），有测试（`agent-dispatch.test.js:977`）。这部分成立。
- **不成立的部分**：
  1. outbox 溢出时 `drop_oldest`（`tasks.js:282-286`），直接丢事件；主事件文件超过 `EVENT_MAX` 时同样截断旧事件（`tasks.js:304-305`）；
  2. 没有消费者/投递确认，事件只被 API/SSE 读取（`routes.js:68,336-341`）；
  3. 事件无 `aggregateId/schemaVersion`，无法做版本校验与乱序判定。
- 结论：**不能声称满足 §11 的 at-least-once**。可写"生产者侧 outbox 有最小保证；系统级投递语义未实现"。

### 4.3 对"CAS + 显式版本"的精确判断

- `writeFileAtomicSync` 的 fsync+rename（`atomic-write.js:6-18`）解决的是**崩溃时的文件完整性**，不是**并发读改写丢失**。
- `checkpointVersion` 每次 checkpoint 自增（`tasks.js:1005-1006`），但更新入口 `updateTask` 对 `patch.checkpointVersion >= 0` 无条件接受（`:769-770`）。
- `lease` 有 owner + `expiresAt` 校验（`tasks.js:877-924`；`watchdog-policy.js:60`），这是"租约互斥"，不是"版本 CAS"；租约过期后新 owner 接管不会校验旧 owner 的写入代次。
- 结论：**现有实现不足以支撑 Phase 1 并行 Worker**；需增加 `expectedVersion` + 冲突返回 + fencing token。

### 4.4 对"完成提交协议"的精确判断

§11 要求五步：产物持久化 → 提交引用 → 校验引用/schema/必需产物 → 才 completed → 失败进 retry/recovery。当前：

1. Worker 结果中的 `artifacts` 恒为空（`runtime.js:713`）；
2. 结果与状态在同一次 `updateTask` 写盘（`tasks.js:695` 起）；
3. 没有"引用可读性/schema/必需产物"校验器；
4. `uncertain` 只覆盖"副作用是否发生"（`state-machine.js:5-7`；`tests/agent-watchdog.test.js:285`），不覆盖"产物已写但状态提交失败"。

结论：**完成提交协议整体缺失**，这是 B 分支的直接触发项之一。

---

## 5. 权限与隔离现状

### 5.1 服务端可信 `userId` 归属

**已验证成立（单用户口径）。**

- 身份只从服务端配置读取：`user-scope.js:29-30`（`BLUEBIRD_USER_ID` 或 `local-owner`），`resolveUserId(_req)` 刻意忽略请求（`:43-45`），注释明确"绝不接受客户端传入的 userId"（`:7-9`）；任务默认归属 `getInstanceUserId()`（`router.js:505`）；审批执行按服务端身份（`approvals.js:388-391`）。
- 委派路径把 `context.userId`（运行时注入）写入 `parentUserId`（`tool-dispatch-bot.js:143-144`），不是模型可伪造的字段。

**限制**：所有通过共享 Bearer token 的调用者都等于同一个 `local-owner`；这不是身份认证体系，只是单实例部署契约。

### 5.2 ACL 现状

| 项 | 现状 | 证据 |
| --- | --- | --- |
| ACL 模式 | 硬编码 `single_user` | `permissions.js:14-27` |
| 唯一主体 | `local-owner` | `permissions.js:12`；`user-scope.js:18` |
| 权限查询 | 静态 profile，无按调用方差异 | `GET /agents/:botId/permissions`（`routes.js:345-350`） |
| 前端可见性 | 不展示 | `scripts/api-capability-registry.json:247-251`（`ui:false`，注"单用户 local-owner"） |
| 每 Agent 授权 | 只有工具 allowlist + 每操作审批 | `manifest.js:79`；`permissions.js:30-40` |
| Agent 会话归属 | **无 owner/用户校验**，仅 `botId + sessionId` | `sessions.js:5,132-166`；`routes.js:228-269` 不传 userId |

**关键判断**：在"单实例 + 单共享 token"部署下，Agent 会话无 owner 不是实际越权；但它使"权限边界可测试"只能停留在单用户模型，无法为多用户/多租户提供证据。

### 5.3 凭证与密钥

**已验证（明文静态存储，已知限制）。**

- `api-keys.json` 明文落盘，`chmod 0600` 为 best-effort，Windows 权限模型有限；注释明确"未做静态加密""不用明文冒充安全实现"：`server/api-configs.js:16-19`。
- 路由响应只回脱敏 `keyHint`（同文件 `:13`）。
- 本报告不包含任何真实密钥；审计未读取 `.env`。

### 5.4 Phase 1 前置阻断项（按严重度）

| 级别 | 阻断项 | 证据 | 为什么阻断 Phase 1 |
| --- | --- | --- | --- |
| P1 | 无 CAS/expectedVersion + 无完成提交协议 | §4.3、§4.4 | 多 Worker 并发更新同一任务/产物会静默覆盖；无法证明"completed 前产物已持久化" |
| P1 | 协议权威未收敛（P1–P5） | §3.6 | Phase 1 一旦加 Planner/Orchestrator，会直接长出"第三套协议" |
| P1 | 无 Artifact/Blackboard（哪怕最小版） | §3.4；`runtime.js:713` | 并行 Worker 的结果无法引用、版本化、校验；§19 明确"Artifact 版本不可 stub" |
| P2 | 无 per-call 污点/参数策略，委派无深度/子任务预算 | §4.1 第 6 行 | 动态组队会放大委派链与权限放大风险（§16/§17） |
| P2 | 审批无 TTL / 无 fail-closed 超时 | `approvals.js` 无 `expiresAt`；`watchdog-policy.js` 不处理 `waiting_approval` | `waiting_approval` 可永久悬挂；§15 要求超时 fail-closed |
| P2 | Agent 会话无归属、凭证全局明文 | §5.2、§5.3 | 多 Agent 场景下无法隔离"谁的会话/谁的凭证" |
| P3 | 无任务级 token/费用 `usage` | `worker-result.js` 无 `usage`；`evaluation` 无成本指标 | 无法执行 §18 预算与 §7 成本指标 |

---

## 6. Phase 0 待决策清单（必须由人决定）

> 标注说明：**【文档规定】**＝文档明确要求但未给值；**【代码推导】**＝从现有代码默认值/校验范围推导，**不是文档规定**；**【建议】**＝审计建议的最小默认值，仍需人批准。

| # | 决策项 | 不定的后果（卡住哪一步） | 最小默认值建议 | 来源标注 |
| --- | --- | --- | --- | --- |
| 1 | `errorCode` 统一枚举与可重试分类 | Result Contract 无法冻结；重试/幂等/UI 映射各自解释；Phase 1 Worker 失败无法统一处置 | 建单一 `error-codes.js`：`{code, retryable, terminal, category}`；先收编现有散落码（`agent_not_found/invalid_task/invalid_task_type/agent_task_limit/task_not_found/task_lease_lost/task_lease_held/task_not_waiting_approval/approval_not_found/approval_not_approved/operation_not_allowed/approval_required/policy_tool_denied/confirmation_required/budget_exceeded/deadline_exceeded/worker_result_invalid/agent_tasks_corrupted` 等），**只读不变更语义** | 【文档规定】需统一；【代码推导】码已存在但分散（`errors.js`、`tasks.js`、`approvals.js`、`runtime.js`） |
| 2 | `retrying` / `recovery` 中间态语义 | 状态机无法冻结；Watchdog 恢复动作与 UI 展示口径不一致；§11/§17 的 retry/recovery 分支无法测试 | 保持现有 9 态不扩张：`retrying` 定义为派生视图 `{status:'queued', retryAt, attempts>0}`；`recovery` 定义为 `uncertain`（可能有副作用）或 `queued`（只读可重放）；不新增持久化状态 | 【文档规定】需定义；【代码推导】`retryAt/lastErrorCode/attempts/uncertain` 已存在（`tasks.js:624-625,641,643`；`state-machine.js:20`） |
| 3 | `trustLevel` 取值与序关系 | Artifact/Result 无法标注可信度；Verification 无写入契约；冲突裁决无优先级 | 四值：`unverified < producer_claimed < verified < human_approved`；`producer_claimed` **禁止**用于授权/提权/跳过验证；仅 `verified/human_approved` 可解锁 R2/R3 | 【文档规定】只规定"仅验证层写入"，未给值；【建议】序关系由审计提出 |
| 4 | 预算/超时/委派深度阈值 | Phase 1 验收"预算硬限制有效"无法判定；动态组队可能失控 | 沿用代码默认并冻结：任务 deadline 默认 60s、范围 5–120s（`tasks.js:493,541-548`）；`maxRounds` 2–5（fast 3 / slow 4）、`maxToolCalls` 1–12（默认 6）、`maxReadOnlyRetries` 0–1（`routing-config.js:29-42`；`tasks.js:437-448`）；并发 2（`runtime.js:41-43`）；委派深度 **1**、单任务子任务数 **2**（新值）；token/费用预算**先测量后定**，不凭空设数 | 【文档规定】数值须 Phase 0 测量；【代码推导】除委派深度/子任务数外均有现值 |
| 5 | 审批超时与 fail-open 策略 | §15 无法验收；`waiting_approval` 永久悬挂；Watchdog 无法闭环 | 默认 **15 分钟 fail-closed**（超时→`failed`/`cancelled`，写审计，不解锁）；仅 R0/R1 且白名单动作可显式 fail-open；R2/R3 永不 fail-open | 【文档规定】需明确；【代码推导】当前无任何超时字段（`approvals.js` 无 `expiresAt`） |
| 6 | Owner 落名（§19 六模块） | §19 Phase 0 明确"必须明确到人"；无 Owner 无法评审/回滚 | 六模块各 1 名主 Owner + 1 名 Backup；最小可行：Runtime Core / Agent Catalog & Policy / Worker Executor / Workflow & Event / Collaboration Store / Quality & Governance | 【文档规定】必须到人；【建议】角色划分沿用 §19 表 |
| 7 | Artifact 引用格式、版本与完成提交边界 | §11 完成协议、§19"Artifact 版本不可 stub"无法落地；Phase 1 结果只能空产物 | 最小 Artifact Store：`artifactId + taskId + producerAgentId + type + contentRef(file) + version(单调整数) + createdAt + trustLevel + accessPolicy`；完成前校验 `ref` 可读 + schema；失败进 `retry/uncertain` | 【文档规定】字段已列；【代码推导】`artifacts: []` 是当前硬限制（`runtime.js:713`） |
| 8 | Event schema 与投递语义 | §11 至少一次、§17 乱序/重放无法实现；UI 与状态权威继续含糊 | 冻结 `eventId + aggregateId(taskId) + aggregateVersion + schemaVersion + eventType + occurredAt + correlationId + payloadRef(或受限内联) + idempotencyKey`；取消 `drop_oldest`，改"暂停接单 + 告警"；事件只做通知，状态以 Task Store 为准 | 【文档规定】字段已列；【代码推导】现有事件缺 4 字段且会丢事件（`tasks.js:282-298`） |
| 9 | planVersion 迁移与冲突裁决权 | §10/§21 要求运行中重规划不重复副作用；§22 要求 plan/task 映射、节点、产物复用、补偿；当前计划与任务无关联 | `plan { planVersion, taskMap, nodeIds }`；fencing token 递增；计划冲突由 Orchestrator 裁决，Artifact 冲突由 Verification 裁决，R2/R3 冲突必须人工 | 【文档规定】§22 必答；【代码推导】无 planVersion 字段（§3.2） |
| 10 | provenance / taint 贯穿规则 | §16 要求贯穿 Task、Artifact、Tool Gateway；当前三者全缺，Gateway 只查工具名 | 最小三标签：`source`（user/web/tool/model）、`sensitivity`（public/private/secret）、`transform`（raw/derived/summary）；`taintPolicyVersion=1`；含 secret 或未脱敏 `derived` 禁止对外发布，必须审批 | 【文档规定】§22 必答；【代码推导】`grep provenanceRefs/taintLabels` 零命中 |

> 待决策项超过 5 项是刻意的：§22 验收清单里"计划版本迁移、CAS、权威边界、trustLevel、审批超时、provenance、Owner"是多个独立决策，合并会再次产生含糊协议。

---

## 7. Phase 0 验收判定

### 7.1 判据一：没有第二套平行任务协议

**结论：不通过。**

判据与证据：

1. **权威声明三选一未定**：`tasks.js:7`（事件是 UI 状态唯一事实来源）、`state-machine.js:5`（合法迁移是唯一事实来源）、`task-store.js:10-11`（单文件单写者）三者并存；§11 要求 State Store 唯一权威、Event 只通知。→ 不满足。
2. **计划协议未并入 Task Contract**：`context/orchestrator.js:71-205` + `context/trace.js:126-190` 的 `plan` 与任务无 `planVersion`/id 关联。→ 不满足。
3. **状态词表重复**：`sessions.js:26-34` 与 `state-machine.js:11-21` 有 5 个同名状态，分别独立写入。→ 不满足。
4. **版本号多套且无 CAS**：`checkpointVersion` / `decisionVersion` / 任务文件 `version`。→ 不满足。
5. **预算模型三套**：context / route-task / agent-policy。→ 不满足。

**可以给出的正面事实**：只有**一个**任务队列与任务存储，没有第二套 `agent-tasks` 文件或第二套 Worker 执行器；`tool-dispatch-bot.js:1-7` 也明确声明"不是第二套执行器"。所以问题是"协议面重复"，不是"执行器重复"。这决定了修复方式：收敛，而不是重写。

### 7.2 判据二：关键状态和权限边界可测试

**结论：部分通过（状态通过；权限仅单用户口径通过）。**

| 子项 | 结论 | 证据 |
| --- | --- | --- |
| 任务状态迁移可测试 | **通过** | `state-machine.js` 白名单迁移；`tests/agent-recovery.test.js:78`（`uncertain` 终态）、`:159-204`（租约）、`:299-310`（`waiting_approval` 不自动执行）、`:363`（SIGKILL 崩溃注入） |
| 超时/预算可测试 | **通过** | `tests/agent-runtime-guards.test.js:276`、`tests/agent-worker.test.js:543`（deadline）；`tests/agent-router.test.js:680`（预算越界） |
| 幂等可测试 | **通过（任务创建/投递）** | `tests/agent-router.test.js:426,559`；`tests/agent-recovery.test.js:323`（uncertain 按 taskId 幂等投递） |
| outbox 可测试 | **通过（生产者侧）** | `tests/agent-dispatch.test.js:977`；`tests/agent-storage-limits.test.js:28,116` |
| 未授权工具可测试 | **通过** | `tests/agent-worker.test.js:556`（`tool.denied` 审计） |
| 审批/权限可测试 | **通过（单用户模型）** | `tests/memory-maintenance.test.js:172-221`（未批准不能执行、批准后可执行、未知操作/跨 Bot 拒绝） |
| 多 Agent / 多用户 ACL | **不通过（无实现）** | `permissions.js:14-27` 静态 `single_user`；无路由级会话归属校验（`routes.js:228-269`） |
| 并发 CAS | **不通过（无实现）** | §4.3 |

**合并判定**：Phase 0 验收整体 **不通过**（判据一失败；判据二部分失败）。

---

## 8. §21 降级分支判定

### 8.1 逐条排除

| 分支 | 是否适用 | 理由与证据 |
| --- | --- | --- |
| A：现有基础满足最小硬边界，进入单主控 + 少量 Worker | **不适用** | 最小硬边界含 §11 CAS + 完成提交；当前缺失（§4.3/§4.4）。且 Phase 0 判据一失败，不满足"进入 Phase 1"的条件 |
| **B：Task 状态、Session 隔离或幂等不足，暂停动态组队，先修复单 Agent + 持久化 Workflow** | **适用** | Task 状态：有状态机/租约/恢复，但缺 CAS、缺完成提交、缺事件版本；Session：单用户下隔离成立，但无 agent 会话归属；幂等：任务创建成立，系统级事件投递不成立（`tasks.js:282-298`）。这正是"不足"而非"完全缺失"，与 B 的"先修复"语义吻合 |
| C：Blackboard 一致性不足 | 不适用 | Blackboard 尚未存在（`grep` 零命中），不构成"一致性不足"；C 的补救（单写者 + append-only Artifact）应先作为 Phase 2 入口，而不是当前降级理由 |
| D：验证成本或延迟超预算 | 不适用 | 无 Verification、无成本指标，没有可用于判断"超预算"的度量 |
| E：隔离、权限或审计存在阻断缺陷，退回单 Agent + 最小 Workflow | **不触发（保留为守门条件）** | 未发现跨 Session 泄漏/越权证据；服务端权限校验与审批闭环有测试；审计链路存在（`monitoring/store.js:704-801`）。但 `api-keys.json` 明文与无会话归属需在 Phase 1 前处理 |

### 8.2 最终判定：B

**B 的具体含义（按 §21 原文）：**
- 暂停"动态组队/多 Agent 并发"；
- 先修"单 Agent + 持久化 Workflow"；
- 修复完成的判据是 §11 三条硬规则（权威分离、完成提交、CAS）+ §15 审批超时 fail-closed；
- 同时保留 E 的守门条件：委派默认关闭（当前 `BLUEBIRD_AGENT_TOOLS` 默认未开启的既有设计需保持）、不开放外部副作用工具。

**为什么不选 A**：A 不是"降级"，它要求 Phase 0 已收敛。当前判据一失败、CAS/完成提交缺失，选 A 等于带着已知并行协议进入并发阶段，风险不可接受。

---

## 9. 下一步最小可行动作（Phase 1 前置）

按依赖顺序，**每一步都可独立评审/回滚**：

| 步骤 | 动作 | 完成判据 | 涉及文件（只读审计给出的定位） |
| --- | --- | --- | --- |
| P0-1 | 冻结 ADR：唯一权威 = Task Store；Event = 通知；Session 状态由 Task 终态派生 | ADR 评审通过；删除/改写三处"唯一事实来源"冲突表述 | `tasks.js:7`、`state-machine.js:5`、`task-store.js:10-11` |
| P0-2 | 冻结 Task/Result/Event JSON Schema（含 §16 三字段占位，允许 null） | schema 文件 + 单测：文档字段 100% 有定义（可空但不可缺失） | `tasks.js:350-403,484-650`；`worker-result.js:58-85`；`tasks.js:255-279` |
| P0-3 | 增加 `expectedVersion` + 冲突错误码 + checkpoint 冲突测试 | 并发两次更新，第二次返回 `version_conflict`，数据不丢 | `tasks.js:695-780,1005-1006`；`task-store.js:96-113` |
| P0-4 | 最小 Artifact Store + 完成提交协议 | 产物先写、引用可读、schema/必需产物校验通过才 `completed`；失败进 `retry/uncertain` | `runtime.js:700-730`；新增 artifact store |
| P0-5 | 事件契约补齐：`aggregateId/aggregateVersion/schemaVersion/payloadRef/idempotencyKey`；去掉 `drop_oldest` | 溢出时暂停接单而非丢事件；乱序/重复事件可被拒绝 | `tasks.js:255-310` |
| P0-6 | 审批 TTL + fail-closed + Watchdog 纳管 `waiting_approval` | 超时审批自动失败并审计；R2/R3 永不 fail-open | `approvals.js:176-438`；`watchdog-policy.js` |
| P0-7 | 权限矩阵测试：Agent 会话归属、每 Agent allowlist、审批二次校验 | 新增路由级/会话级越权测试全绿 | `sessions.js:132-166`；`routes.js:228-269,345-350`；`permissions.js:30-40` |
| P0-8 | 最小确定性验收：结果 schema + 必需字段 + evidence 引用存在性 | 验收失败不得 `completed`；有正反例测试 | `worker-result.js:58-85`；`runtime.js:700-730` |

### 9.1 必须 stub / 绝对不能 stub

| 类别 | 项 | 依据 |
| --- | --- | --- |
| **可以 stub** | 外部 Event Bus、远程 Worker、复杂动态协商、自动审批路由、完整 Improvement Pipeline、分布式 Blackboard、Context Broker 初期 | §19 原文允许 |
| **绝对不能 stub** | 任务状态持久化、Artifact 版本、服务端权限校验、幂等副作用、审计、确定性验收 | §19 原文"不可 stub" |
| 附加建议 | 委派深度/子任务预算、审批 TTL 不得以"先跑起来"为由省略 | §6 硬约束 + §15；当前均缺失 |

---

## 10. 未验证项（明确声明）

以下内容**未验证**，不得在评审中当作已通过：

1. **未跑全量测试**：只静态阅读了测试文件并引用其用例名/行号；未执行 `npm test`，因此"有测试"= 存在用例，不等于当前全绿。
2. **未复现并发丢失更新**：CAS 缺失是代码事实（`tasks.js:769-770` 无 `expectedVersion`），但未构造并发用例实测。
3. **未调用真实模型**：未使用 DeepSeek/Memory Bot 真实 API，Worker 实际行为、`empty_reply`、工具循环只在代码层核对。
4. **未验证前端消费**：未打开 App/前端，SSE 事件与任务页展示是否一致未实测。
5. **未验证 Notion 页面状态**：页面元数据为 `verification: unverified`，本报告按任务要求将其作为输入基线，但其内容本身未经第二次人工确认。
6. **未做费用/Token 核算**：当前无 `usage` 字段，无法给出任何成本数字。
7. **未验证 Windows 文件权限实际效果**：`chmod 0600` 在 Windows 为 best-effort，未实测 ACL。

---

## 11. 证据索引（按文件）

| 文件 | 关键行 | 用途 |
| --- | --- | --- |
| `server/index.js` | 136-140, 203-229 | Entry 挂载、Bearer 认证 |
| `server/agents/routes.js` | 68, 119-519 | 26 个 Agent 路由（agents/sessions/tasks/approvals/events） |
| `server/agents/manifest.js` | 58-90 | 唯一 Agent Manifest |
| `server/agents/registry.js` | 23-40, 47-115 | 健康态与 Agent 视图 |
| `server/agents/router.js` | 174-336, 196-219, 505 | 路由决策、预算、parentUserId 默认 |
| `server/agents/routing-config.js` | 25-42 | Fast/Slow 预算默认值 |
| `server/agents/tasks.js` | 7, 50, 255-310, 350-403, 429-453, 484-650, 695-780, 1005-1006, 1046 | 事件、契约、预算、创建、更新、checkpoint、恢复 |
| `server/agents/state-machine.js` | 5-34 | 状态与迁移 |
| `server/agents/task-store.js` | 10-11, 25-26, 96-113 | 状态存储与迁移 |
| `server/agents/runtime.js` | 41-55, 120-144, 674, 713, 967 | 并发、预算、userId 注入、空产物 |
| `server/agents/worker-result.js` | 6-17, 58-85 | Result 归一化 |
| `server/agents/context-projection.js` | 14-51 | 最小上下文投影 |
| `server/agents/sessions.js` | 5, 26-34, 132-166, 259-311 | 会话隔离与生命周期 |
| `server/agents/approvals.js` | 176-229, 269-344, 352-438 | 审批创建/决定/执行 |
| `server/agents/permissions.js` | 12-40 | 单用户权限模型 |
| `server/agents/watchdog-policy.js` | 10-37, 60 | Watchdog 白名单与租约检测 |
| `server/agents/intake-control.js` | 19-31 | 接单暂停 |
| `server/context/orchestrator.js` | 71-205 | 上下文 plan（非任务 plan） |
| `server/context/trace.js` | 126-190, 323-325 | orchestration 记录 |
| `server/agent-policy.js` | 29-57, 217-219 | 直接对话模式与预算 |
| `server/agent-runtime.js` | 86, 162-167, 383-392 | 工具三级风险与高风险确认 |
| `server/memory-service.js` | 17-23 | 记忆操作风险枚举 |
| `server/user-scope.js` | 7-9, 29-45 | 可信用户身份 |
| `server/api-configs.js` | 16-19 | `api-keys.json` 明文限制 |
| `server/atomic-write.js` | 6-18 | fsync+rename，仅原子落盘 |
| `server/monitoring/store.js` | 436-574, 704-801 | trace/audit/stats |
| `server/tool-dispatch-bot.js` | 1-7, 13, 32-34, 117, 143-146 | 委派工具（1 跳、无深度预算） |
| `scripts/api-capability-registry.json` | 247-251 | 权限接口仅 API、单用户说明 |
| `package.json` | 42-48 | 仅记忆/上下文评测脚本 |

---

## 12. 一页结论（供评审会使用）

- **Phase 0 状态**：未通过。状态机、租约、恢复、幂等、审计是强项；协议权威、CAS、完成提交、Artifact、Verification 是缺口。
- **平行协议**：存在，属"协议面重复"而非"第二套执行器"；修复方式是收敛，不是重写。
- **降级分支**：**B**。暂停动态组队，先修单 Agent + 持久化 Workflow；保留 E 的守门条件。
- **Phase 1 最小前置**：P0-1 权威 ADR → P0-2 schema 冻结 → P0-3 CAS → P0-4 最小 Artifact/完成提交 → P0-5 事件契约 → P0-6 审批 TTL → P0-7 权限矩阵 → P0-8 确定性验收。
- **绝对不可 stub**：任务状态持久化、Artifact 版本、服务端权限校验、幂等副作用、审计、确定性验收。
- **最大风险**：在没有 CAS 和产物提交协议的情况下引入并行 Worker，会把"状态不一致"从文档风险变成线上事实。

---

## 勘误（后续查证 2026-11-03）

> 本节为**追加段**，不重写 §0–§12 原文，不修改原结论的文字与日期。来源：`docs/artifact-commit-chain-audit-2026-11-03.md`（下称「产物链审计」）的只读查证 + 本次对 `server/agents/worker-result.js`、`server/agents/runtime.js`、`server/agents/tasks.js` 的定点复核。
> **勘误 #6 及「勘误的勘误」另据一手原文核对（2026-11-03，来源 Notion 页面 `40da9575-23c2-8135-9607-e23f6a3c784f`，v1.1 §11）。**
> 除下表明确标注「字面失效」的表述外，原文其余判断保持不变。

### 勘误条目

| # | 原文位置 | 原文表述（摘要） | 后续查证（2026-11-03，来源：`artifact-commit-chain-audit-2026-11-03.md`） | 对原判断的影响 |
| --- | --- | --- | --- | --- |
| 1 | §3.3 `artifactRefs` 行、§3.4「最强反证」、§4.1 完成提交行、§5.4 P1 行、§9 P0-4（简写为 `runtime.js:713` / `runtime.js:700-730`） | `runtime.js:713` 硬编码 `artifacts: []` | 实际文件是 **`server/agents/runtime.js:713`**；同目录另有 **`server/agent-runtime.js`**（`runAgentTurn`，返回对象在 `:1059-1070`），两者不是同一模块，不可混用简写。原文 §2 组件盘点 #9 与 §11 证据索引已写全路径 | **结论仍成立**：`:713` 确为无变量参与的字面量空数组。仅路径简写产生歧义，引用时应统一写 `server/agents/runtime.js` |
| 2 | §2 组件盘点 #9；§3.3 `artifactRefs` 行 | 「`worker-result.js` 只接受字符串 ref 数组」；「元素是字符串 ref」 | 元素实际是**对象** `{ kind, id }`：`refs()` 先 `filter(item => item && typeof item === 'object')`，再把 `kind`/`id` 经 `String()` 截断输出（`server/agents/worker-result.js:21-30`）；`tasks.js:797-805` 再做一次同样裁剪 | **类型描述字面失效**（是对象数组，不是字符串数组）；但「无 `artifactId`/`version`/`contentRef`、会被静默裁剪」的结论**仍成立** |
| 3 | §4.1「完成提交协议」行；§4.4 第 1–4 点；§5.4 P1 行 | 「§11 完成协议 1–5 **均未实现**」；「完成提交协议**整体缺失**」 | 第 **1–3** 步缺失（无产物生产、无带版本引用、无提交前引用/schema 校验）；第 **4** 步**部分实现**：`runTask` 确有写 `completed` 的路径（`runtime.js:725-729`），但没有产物门禁；第 **5** 步**部分实现**：仅对 `model_connection`/`model_rate_limit`/`model_timeout` 且 `attempts < maxAttempts` 重试（`runtime.js:818-847`），无产物失败分支，状态集也无 `retrying`/`recovery` | 「1–5 均未实现」**字面失效**；若作为协议结论——「缺产物持久化 + 缺提交前校验 + 缺产物失败分支」——**仍成立**。B 分支的触发项（无 CAS、无完成提交协议、无 Artifact）不变 |
| 4 | §4.1 完成提交行（「结果与状态一次性写任务文件」）；§4.3 | 只说明结果与状态在同一次 `updateTask` 写盘 | 原文**未覆盖**的关键事实：`updateTask()` **先改内存、后落盘**——状态赋值 `tasks.js:700-703`、`result` 重建 `:784-852`、真正落盘 `:853-854`。`saveTasks()` 抛错时，进程内 `taskCache` 已是终态而磁盘仍是旧状态（`atomic-write.js` 只保证单文件「旧或新」，不保证业务回滚）。`runTask` 的 catch（`runtime.js:751-755`）读到内存终态后直接 `return`，把失败吞掉；若在下次整文件写回前重启，`initializeTaskQueue()` → `recoverInterrupted()` 会把任务重新 `queued` 并**重跑**（`runtime.js:934-944`、`tasks.js:1046-1106`） | **不改变**任何既有结论；**强化** §4.1/§4.3 的「无 CAS、无完成提交协议」判断，并新增一条原文未记录的「内存/磁盘分裂」风险。其中「重启后重跑」的端到端行为为**代码推断，未注入磁盘故障运行验证** |
| 5 | §3.4「最强反证」；§4.1 第 2 行；§11 证据索引 | 「无 `pending-commit`/`orphan`」（未限定作用域） | Agent 域确认无 `pending-commit`/`orphan`；仓库其他域存在同名但不相关的概念：`server/sessions.js:134-149` 的 orphan messages、`server/retrieval/store.js:698-719` 的 orphan chunks | 结论在 **Agent Runtime 域**仍成立；表述需限定作用域，避免被误读为「全仓无此概念」 |
| 6 | 勘误 #3 的 §11 步数与映射（本条是对勘误 #3 的更正，不覆盖 #3 原文） | 旧转引为「产物持久化 → 提交引用 → 校验引用/schema/必需产物 → 才 completed → 失败进 retry/recovery」 | **一手原文核对（2026-11-03，来源 Notion 页面 `40da9575-23c2-8135-9607-e23f6a3c784f`，v1.1 §11）**：原文实为 **5 条并列步骤**。旧转引把第 3 步末句「才允许 task completed」拆成独立项，导致第 3–5 项**整体右移一格**，并把原文**第 5 步整条丢失**（第 5 步：Artifact 已写但 task 状态提交失败→产物标记 `pending-commit`/`orphan`→幂等重试关联→确认无引用后才可清理） | **步数没错（5 步），错在内容错位一级 + 原缺第 5 步**。更正后的口径：**1–3 缺失；第 4 步部分实现**（仅 `model_connection`/`model_rate_limit`/`model_timeout` 进 retry；无 `recovery` 状态、无产物失败分支）；**第 5 步完全缺失**。协议级结论与 B 分支不变 |

### 为什么原判断仍然成立 / 已失效

- **勘误 1（路径）**：结论建立在「`:713` 是字面量空数组」上，行号与内容已复核一致，因此**仍成立**；失效的只是简写形式。`server/agent-runtime.js` 是模型工具循环（`runAgentTurn`），不负责任务结果收口，混用会指向错误模块。
- **勘误 2（ref 形状）**：失效的是「字符串」这一类型描述。`refs()` 明确只保留对象且只输出 `kind`/`id` 两个字符串字段，所以「没有 artifactId/version/contentRef」的实质结论比原文更确切，**仍成立**。`artifacts` 默认值仍为 `[]`（`worker-result.js:60`）。
- **勘误 3（§11 五步）**：失效的是「均未实现」这一全称表述。第 4 步有真实写入路径但无门禁，第 5 步有真实重试路径但只覆盖模型类错误，因此准确说法是「1–3 缺失，4–5 部分实现」。本次勘误**不改变** §7.1/§7.2 的验收判定与 §8.2 的 B 分支，也不改变 §12 一页结论——这些判断依赖的是「没有产物持久化、没有提交前校验、没有 CAS」，而不是「五步中每一步都无代码」。原文「完成提交协议整体缺失」若理解为「协议级门禁整体缺失」，**仍成立**。
- **勘误 4（内存先行）**：这是原文**遗漏**而非错误，不推翻任何结论；它把「状态与结果同一次写」的风险补全为「写盘失败时内存与磁盘可分裂」，与 §4.3「现有实现不足以支撑 Phase 1 并行 Worker」的方向一致，**强化**该判断。重启重跑一段标注为代码推断，不升级为实测事实。
- **勘误 5（作用域）**：结论限定在 Agent Runtime 域后**仍成立**；原文未限定作用域，容易与 Session/Retrieval 的同名概念混淆。
- **勘误 6（§11 错位）**：一手原文确认 §11 是 **5 条**，旧转引在第 3 步末句处多切了一刀，导致后续整体右移并丢掉第 5 步。步数判断没错，错的是**映射**；更正见下方「勘误的勘误」。这同样**不改变** §7.1/§7.2、§8.2 B 分支与 §12 一页结论。

### 勘误的勘误（对 #3，2026-11-03 一手原文核对）

> #3 的原文保留不动（见上表第 3 行及其说明）；本段只更正其**步号与判定**，不改写 #3 的文字。

| 旧 #3 表述 | 对应一手原文（v1.1 §11） | 更正后判定 |
| --- | --- | --- |
| 「第 **4** 步部分实现：`runTask` 有写 `completed` 的路径，但无产物门禁」 | 原文**第 3 步**：「校验引用可读、schema 合格、必需产物齐全后，才允许 task completed」 | 第 **3** 步**缺失**——有 `completed` 写入动作，不等于有「校验后才允许」的门禁 |
| 「第 **5** 步部分实现：仅对 `model_connection`/`model_rate_limit`/`model_timeout` 重试」 | 原文**第 4 步**：「Artifact 写失败则 task 不得 completed，进入 retry / recovery」 | 第 **4** 步**部分实现**——仅三类模型错误进 retry；无 `recovery` 状态、无产物失败分支 |
| （旧转引无此条） | 原文**第 5 步**：「Artifact 已写但 task 状态提交失败，产物标记 pending-commit / orphan，通过幂等重试关联；确认无引用后才可清理」 | 第 **5** 步**完全缺失**——`pending-commit` 在 `server/` 零命中、`orphan` 在 Agent 域零命中（见产物链审计 §4.2） |

**更正后的唯一口径**：`1–3 缺失；第 4 步部分实现；第 5 步完全缺失`。旧口径「1–3 缺失，4–5 部分实现」作废，但 #3 原文字保留以追溯。

### 勘误后的引用口径

1. 引用 `runtime.js` 时写全路径 `server/agents/runtime.js`；`server/agent-runtime.js` 只用于 `runAgentTurn` 相关证据。
2. 引用 `result.artifacts` 时写「对象数组，元素形状 `{ kind, id }`」。
3. 引用 §11 五步时写「1–3 缺失；第 4 步部分实现；第 5 步完全缺失」（旧「4–5 部分实现」已由「勘误的勘误」更正），不再用「均未实现」。
4. 讨论一致性风险时必须同时提「先内存后落盘 + catch 吞错 + 重启重跑」，并保留「重跑未实测」标注。
5. 本勘误未修改原文任何一行；如需追溯，以本段与 `docs/artifact-commit-chain-audit-2026-11-03.md` 为准。
6. 引用 §11 时必须注明「一手原文：v1.1 §11，5 条并列」；不得再用旧转引的四段式映射。
