# Orchestrator 轮 2：计划编译器 plan-compiler-v1（2026-11-13）

> 依据：`docs/orchestrator-charter-2026-11-13.md` 轮 2。代码基准：`main` = `2a22e1a`（PR #76 + 台账第十次勘误后）。

## 1. 实现

### 1.1 `server/agents/plan-compiler.js`（plan-compiler-v1）

纯服务端编译：**不执行任务、不调用模型**（输入是字符串）。链路：

1. **schema 校验**：nodes 数组 1..`MAX_NODES`(8)；key 缺省 `k1..kN`（≤80，唯一）；taskType 必备（1..64）；goal 缺省取 taskType、截断到 `STEP_GOAL_MAX`(200)；context 截断 2000；dependsOn 只能引用已知 key、≤8。
2. **DAG 无环**：`dependencies.validateGraph`（复用，不重写）。
3. **执行者解析**：与 `router.decideInternal` 同口径——taskType 必须同时命中某 Agent 的 `capabilities` 与 `acceptedTaskTypes`（routingPriority 升序 → botId）。**模型声明的 agent 名一律丢弃**：只进 `diagnostics.declaredAgentCount` 与 `plan.proposed` 事件计数，不参与判定、不落正文（单测锁定）。匹配不到 → `capability_not_found`。
4. **steps 构造**：stepKey 内容寻址（`stepKeyFor({toolName: taskType, args:{goal, taskType, role:'plan-compiler'}})`，sha256 十六进制）；step 带 `agentId`（解析结果）；dependsOn 解析为批内 stepKey。
5. **落盘**：`planId = plan_pc_<digest 前 32 位>`（内容寻址血缘）；同内容重编译走**取出语义**（head digest 相同 → `created:false` 不追加版本，单测锁定）；`appendVersion` 唯一版本分配器 + fsync 落盘。
6. **风险分级入诊断**：`riskPolicy.assessRisk({taskType, toolRisks:[], highRiskTaskType: HIGH_RISK_TASK_TYPES.has(taskType)})` → 节点 `riskLevel`（action.execute → R3、memory.search → R1，单测锁定）。只进诊断，不改计划内容，运行期仍由 runtime 现算。
7. **输出**：`definitions`（createTaskGraph 可直接消费的形状：key/stepKey/goal/capability/taskType/dependsOn(stepKey 空间)/agentId/workflowPlan/context），执行接线属轮 3。

### 1.2 schema 扩展

`STEP_KEYS` 增可选 `agentId`（≤80，缺省缺字段 = 旧行为，旧计划零影响；store 测试补「合法值读回 + 类型/超长拒绝」）。这是节点执行者的**落库位**：由服务端解析后写入，不是模型声明位。

### 1.3 HTTP 与事件

- `POST /agent-plans`（编译，201 返回编译产物）+ `GET /agent-plans/:planId`（读回 head 冻结版本；未知 404）。Bearer 鉴权前缀 `/agent-plans`；`auditAction('agent.plan.compile')`。能力登记 `agent-plans` 族（路由 106 / 族 22 / 仅 API 能力 14）。
- 事件 `plan.proposed` / `plan.compiled` / `plan.rejected`（EVENT_TYPES + SAFE_PAYLOAD_KEYS 双闸；payload 只含 mode/nodeCount/declaredAgentCount/planId/planVersion/skipReason 扁平标量）。事件归属 bot：编译产物按解析出的首个执行者落；编译失败挂 `memory`（appendEvent 校验 botId，`system` 不在注册表会被静默丢弃——实现中真实踩到并修正）。
- 失败路径：先记 `plan.rejected`（带原因码）再抛 AgentError，HTTP 按既有错误契约返回（单测：未知 taskType → 400 capability_not_found）。

## 2. 验收（`tests/agent-plan-compiler.test.js`，10 例全过）

| 组 | 覆盖 |
|---|---|
| a | 跨 Agent 两节点 DAG：memory.search→memory、summary.synthesize→researcher；definitions 冻结 (planId, planVersion)；workflow-store 真实落盘 + plan.compiled 事件 |
| b | 同内容重编译取出语义（同 planId 同版本，headVersion 不变） |
| c/d/f | 节点>8、未知 taskType、dependsOn 未知 key、环、重复 key、空 nodes、非法 mode → 全拒绝 + plan.rejected |
| e | declaredAgents 丢弃（计数 2、判定仍 memory、声明正文不落审计） |
| g | goal 500→200、context 3000→2000；不同 goal 不同 stepKey |
| h | 风险分级：action.execute→R3、memory.search→R1（policyVersion risk-policy-v1） |
| i/j | HTTP 端到端：POST 201 / GET 200 / 未知 404 / 无令牌 401 / 失败 400+错误契约 |

既有测试：workflow-store 15 例（含新增 agentId 边界）、planner/binding/orchestrator 24 例全过。

## 3. 边界与如实标注

1. 编译器**不执行**：definitions 是数据；createTaskGraph 的同 Agent 约束仍未放宽（轮 3 以 `dag-v1` 放宽，仅限带编译器产物头的图）。
2. `enabled` 过滤：manifest 无 enabled 字段时视为启用（`agent.enabled !== false`），Bot 级开关仍以 agents.json 为准（路由层既有语义不变）。
3. 事件挂 bot 的裁决（首执行者 / 失败挂 memory）是本仓库事件模型（botId 必须在注册表）下的落点，不改事件语义。
4. 风险分级是**诊断位**：不写计划、不预先抬审校；运行期 risk.assessed 与 requiresReview 语义不变（轮 3/4 不经编译器路径执行的任务完全不受影响）。

## 4. 计数与门禁

- 新增 `tests/agent-plan-compiler.test.js`（10 例）；基线 backend 2446 → 2456、runner 2216 → 2226、文件 122 → 123；`sync-doc-counts.js` 已同步；`verify-api-capabilities --write` 刷新 AGENTS.md 登记块（106/22/14）。
