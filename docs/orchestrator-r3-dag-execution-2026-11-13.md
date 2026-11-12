# Orchestrator 轮 3：编排执行引擎（2026-11-13）

> 依据：`docs/orchestrator-charter-2026-11-13.md` 轮 3。代码基准：`main` = PR #77 合并后。

## 1. 实现

### 1.1 `server/agents/orchestration-engine.js`（orchestration-engine-v1）

控制面引擎，实际执行全部复用既有 Runtime（租约/fencing/预算/审批不变）：

- **`orchestrateDAG({planId, definitions?, parentSessionId?, parentUserText?, parentUserId?})`**：只接受编译器产物图（`plan_pc_` 前缀，其余 400）。读 head 版本 → `dependencies.validateGraph` 拓扑序 → 逐节点 `router.dispatch`：`agentId` 用计划里服务端解析出的执行者、`dependsOn` 解析为上游**真实 taskId**、节点**冻结到编译版本**（`workflowPlan`，并带 `stepKey` 供节点映射——不传则 dispatch 会另建单步计划、编排钩子与 dag-v1 放行都会失效，实现中真实踩到并修正）；幂等键 `orch:<planId>:v<version>:<stepKey>`，重入返回既有任务（HTTP 200/201 区分）。编排记录落 `agent-orchestrations.json`（原子写），事件 `orchestration.created`。
- **`onPlanTaskSettled`**：runtime 三个终态收口点的 fail-safe 钩子（成功收口、失败收口、依赖判死收口——**成功路径一开始漏接，编排永远无法归约，实现中真实踩到并修正**；依赖判死在 `tasks.settleDependencies` 内 lazy-require 引擎，异步 fire-and-forget）。completed 节点：产物显式 `artifactStore.share` 给直接下游 + 下游 context 追加引用行（≤8000）+ `orchestration.artifact_shared`；任何节点终态后尝试归约。
- **`maybeReducePlan`**：全部节点终态才结算（单飞防重入）。
  - **审校门**：编排记录里 max riskLevel ≥ R2（`action.execute` → R3）且确有产物 → 聚合结论落 `conclusion` 产物（evidence = 节点产物引用，挂最后终态节点）→ `verification-loop.openReview` 独立审校 → pass 才交付；fail/needs_human/超时 → `blocked_review` 不交付（事件留痕）。无可送审产物（全失败）→ 跳过审校门并在 `pendingReason` 说明，不静默放行。
  - **发布门**：计划声明 `publishGate.required` → 每个命中节点必须有一条 `status=completed` 的 `plan.publish` 审批（节点停 `waiting_approval` 即代表审批未收口，故 `awaiting_publish` 是「全节点终态但审批未齐」的防御性不变量，门语义下正常流不可达）；审批执行（`approvals.execute` plan.publish 分支）收口后回查归约，最后一条批准触发根交付。
  - **交付**：`resultDelivery.deliverPlanOutcome`（新函数，幂等 `bot-result-<planId>`，命中既有消息不重复追加只通知）→ `orchestration.completed` / `orchestration.partial`（`failedCount` 入事件）。
- **状态机**（编排记录级，非任务状态机）：`running → completed | partial | awaiting_publish | blocked_review`。

### 1.2 dag-v1：跨 Agent 依赖边（tasks.js）

`createTask` 的同 Agent 依赖校验放宽为：**仅 `planId` 前缀 `plan_pc_` 的图允许跨 Agent 边**；散装任务的同 Agent 约束原样保留（单测锁定）。环检测/委派深度/预算/父子授权交集全部不变。`dependencies.isReady`/`settleDependencies` 与 agent 无关，跨 Agent 波次天然成立（全局并发上限不变，`BLUEBIRD_AGENT_TASK_CONCURRENCY` 建议 3）。

### 1.3 事件与 HTTP

- 事件 5 个：`orchestration.created` / `orchestration.artifact_shared` / `orchestration.awaiting_publish` / `orchestration.completed` / `orchestration.partial`（EVENT_TYPES + SAFE 双闸；新增 SAFE 键 `toTaskId`/`failedCount`/`pendingReason`/`riskLevel`）。
- HTTP：`POST /agent-orchestrations`（编排，幂等重入 200 / 新建 201）+ `GET /agent-orchestrations/:planId`（读回）。鉴权前缀 + `auditAction('agent.orchestration.create')`；能力登记 `agent-orchestrations` 族（路由 108 / 族 23 / 仅 API 能力 16）。
- 循环依赖隔离：orchestration-engine 对 `router`/`verification-loop`/`dependencies` 的 require 全部函数内 lazy（runtime → 引擎 → router → runtime 的环必须在引擎侧打断）。

## 2. 验收（`tests/agent-orchestration-engine.test.js`，9 例全过）

| 组 | 覆盖 |
|---|---|
| a+b | 跨 Agent DAG 建任务（执行者落位/依赖=真实 taskId/`orchestration.created`）；散装跨 Agent 依赖仍拒绝；幂等重入不新建任务 |
| c+d | 产物显式共享 + 下游 context 注入 + `orchestration.artifact_shared`；全绿 → `completed` + 根结果幂等写入父会话（`bot-result-<planId>`） |
| e | 失败 → `partial`（failedCount 入事件）；被依赖判死下游 `neverStarted` 如实入档 |
| f1/f2 | 审校门：R3 节点 → 独立审校 pass 才交付；fail → `blocked_review` 不交付 |
| g | 发布门：命中节点停 `waiting_approval`、无根交付；批准后（审批执行回查归约）根交付 |
| h/i/j | 边界（非编译器 planId/未知 planId/definitions 数量不符）；deliverPlanOutcome 幂等；HTTP 端到端 + 401 |

既有回归：plan-revision/publish-gate/plan-compiler/worked-example-e2e 20 例、worker/recovery/router 132 例全过。

## 3. 边界与如实标注

1. **编排不自动重派**：节点失败 → 下游照旧判死 → 根结果 partial 列缺口；重试沿用任务级 attempts（v1 保持，不改失败语义）。
2. **审校门超时**（REVIEW_WAIT_MS 默认 30s）→ `blocked_review`（pendingReason=review_timeout）；审校任务是真实 reviewer 任务，其结论可通过既有审校流复核。
3. **发布门防御性不变量**：`awaiting_publish` 在正常门流不可达（命中节点终态即代表审批收口），保留为「全终态但审批未齐」异常的守卫。
4. **根聚合摘要**：逐节点一行（任务类型 + 摘要 ≤600 或失败码），总长 ≤8000；产物引用去重并入根结果（≤40 由 worker-result 归一保证）。
5. 归约的 conclusion 产物挂在最后终态节点的 taskId 下（聚合内容需要产物归属；该节点通过验证，产物链有效）。
6. 编排记录的 `pendingReason`/`reviewRef` 是唯一调试面；不改任务状态机十态。

## 4. 计数与门禁

- 新增 `tests/agent-orchestration-engine.test.js`（9 例）；基线 backend 2456 → 2465、runner 2226 → 2235、文件 123 → 124；`sync-doc-counts.js` 已同步；`verify-api-capabilities --write` 刷新 AGENTS.md（108/23/16）。
