# 一期（Pre-1）协议收敛实施记录（2026-11-03）

分支：`phase1/protocol-convergence-2026-11-03`（未合并、未开 PR）。
方案与决策见 `docs/protocol-convergence-plan-2026-11-03.md`；本文件只记结果，不重复方案正文。

## 提交与结论

| 步 | 提交 | 一句话结论 | 用例计数 |
| --- | --- | --- | --- |
| S1 | `6b03183` | 权威声明归位：`tasks.js` / `state-machine.js` / `task-store.js` 注释统一为"单一来源"。 | 2056 不变 |
| S2 | `4dab3e3` | 十态词表只在 `status-vocabulary.js` 导出，`uncertain → recovery` 仅作读边界别名。 | 2056 不变 |
| S3 | `8da8a89` | 任务状态写入收口到 `transitionTask`，`updateTask` 不再接受 `status`。 | 2056 不变 |
| S4 | `d94e09d` | Session 生命周期由任务状态投影派生，`closeSession` 不再接受任意值。 | 2056 不变 |
| S5 | `30d5ce7` | `recovery` 取代 `uncertain` 成为正式终态，旧数据读取时映射。 | 2056 不变 |
| S6 | `ae26a87` | 审批只能从 `running` 进入 `waiting_approval`，批准后先回 `running` 再执行。 | 2056 不变 |
| S6b | `339d5f7` | 审批等待期 Task deadline 生效；到期按副作用是否已知收敛，审批记录保持 `pending`。 | 2056 不变 |
| S7 | `8f08807` | `retrying` 正式化：删除 `running → queued`，退避到期由调度器直接回 `running`。 | **2056 → 2058**（+2） |
| S8 | `946c5af` | Task 新增可空 `planId` / `planVersion`；未接 Workflow Store 时恒为 `null`。 | 2058 不变 |
| S9 | `bbca1b2` | 每个版本字段单一来源：`contractVersion`（`contract.js`）、`checkpointVersion`（仅 `recordCheckpoint`）、`decisionVersion`（`memory-evidence` 常量）。 | 2058 不变 |

门禁基数：backend `2058`、nodeTestSuite `222`、runner `1836`、frontend `188`（22 suites）；S7 之前为 `2056 / 222 / 1834`。

## 本件未做的事

- CAS / `stateVersion` 并发控制：属 ② 范围，未实现；`checkpointVersion` 只是 checkpoint 序号，不是 CAS 版本。
- Artifact / 计划持久化（Workflow Store）：属 ③ 范围；`planId` / `planVersion` 只是可空指针。
- 审批 SLA 驱动任务终态：属 ④ 范围；审批等待期只受 Task `deadlineMs` 约束，审批记录本身不能触发 `timed_out` / `recovery`。
- Token / Run 总预算：当前不存在；本阶段只做 `timed_out` / `recovery` 迁移边合法化。
- 多进程 Worker / 分布式队列：仍为单写者原子文件；启用前需事务型 Store 或文件锁。

## 已知契约变化（2026-11-04）

### C1. 任务完成结果新增产物引用（③，提交 `6204f06`）

- 字段：`task.result.artifacts[]`，元素为 `{kind, id, version}`；`version` 是本次新增的可选键，旧记录没有该键。
- 旧值 → 新值：`artifacts` 恒为 `[]` → 每次 `completed` 至少一条 `{kind: 'message', version: 1}`；任务若经 `memory_remember` 产出，另有 `{kind: 'memory', ...}`。
- 影响面：任务 JSON、`GET /agent-tasks/:taskId` 与任务 SSE 出口、`lib/api/types.ts` 的 `AgentTask.result`（已补可选 `artifacts`）。`components/TasksPanel.tsx` 不读取该字段，无渲染变化；`server/agents/routes.js` 为 `publicTask` 透传，无字段裁剪。
- 回归用例：`tests/agent-artifact-commit.test.js` 的 `a`（正常完成多一条引用）与 `f`（无产物引用路径行为不变）。
- 回滚方式：`git revert 6204f06`；已落盘的 `agents/agent-artifacts.json` 不影响任务读取，无需迁移任务数据。回滚会使 §11 第 1 步重新失去可验证证据，故未采用。

## Phase 1 前置 ④（2026-11-04）：审批 TTL/SLA 与 fail-open 策略表

提交：`feat(agents): add approval risk policy and fail-open allowlist`（独立提交，不合并、不开 PR）。

### C2. 审批记录新增风险与时限字段（④）

- 字段：`riskLevel`（`R0`–`R3`）、`expiresAt`（ISO 时间或 `null`）、`escalationAt`（ISO 时间或 `null`）、`policyVersion`（非负整数；策略表不可读时为 `null`）。
- 旧值 → 新值：升级前记录没有这四个键；新建记录一律带全量键。`medium` → `R2`（30 分钟 SLA + 50% 升级点），`high` → `R3`（`expiresAt` / `escalationAt` 为 `null`，不设自动批准超时）。
- 影响面：审批 JSON（`GET /agent-approvals`、审批决定接口的返回体）为透传新增字段，旧消费者忽略未知键即可；**老记录在 `execute` 时按 fail-closed 拒绝**（`approval_policy_missing`），不执行、不推进任务、不放行。`approvals.js` 之外的 Task 状态词表与 `state-machine.js` 迁移表未改。
- 不变量：R2 到期只把记录标记为 `overdue` 并写 `approval.overdue` 事件，状态保持 `pending`，**绝不解释为批准**；R3 可长期 `pending`。审批等待期资源期限独立生效（S6b 行为回归确认，见用例 `b`、`c`）。
- 回归用例：`tests/agent-approval-policy.test.js` 的 `a`（R2 到期未放行）、`b`（R3 长期 pending + 资源期限）、`c`（资源耗尽双分支 + 审批仍 pending）、`g`（老记录缺字段 fail-closed）。
- 回滚方式：`git revert` 对应 ④ 提交；已落盘审批记录新增键不影响旧代码读取（旧代码忽略未知键），但回滚后老/新记录都退回“无 SLA”行为。

### 数值参数与变更留痕（A/B 类）

| 参数 | 类别 | 取值 | 依据与状态 |
| --- | --- | --- | --- |
| R2 审批 SLA | **A 类** | 30 分钟（旧值：无 SLA） | v1.3 §36.2 初始默认硬阈值，用户 2026-11-03 裁决采纳；待实测校准，调整须按 §31.2 留版本记录，不得静默调参 |
| R2 升级点 `escalationAt` | **A 类** | SLA 的 50%（15 分钟） | §32.3 建议由 deadline 派生，待实测校准 |
| fail-open 策略有效期上限 | **A 类** | 90 天（单次按 `validity` 更短者） | §36.2 已采纳安全默认值，待实测校准 |
| fail-open 审计保留条数 | **B 类** | 500 条 | 容量上限，未压测，仅作防膨胀安全上限 |
| R2 审批次数/资源期限 | **B 类** | 不在本段新增 | 沿用 S6b 的 `deadlineMs`，需压测后定生产值 |

### fail-open 七字段策略表（仅 R0/R1）

存储：`agents/agent-failopen-policies.json`（原子写）；审计：`agents/agent-failopen-audit.json`。每次判定重新读文件，撤销立即生效。

| 字段 | 落库要求 |
| --- | --- |
| `actionScope` | `tool` / `operation` / `paramsDigest` / `targetScope` 精确匹配，禁止通配符；可选 `planVersion` 精确匹配 |
| `preAuthorizedSubjects` | 非空、≤20，禁止 `agent` / `orchestrator` / `gateway` |
| `riskLevel` | 仅 `R0` / `R1`；`R2` / `R3` 在判定入口直接拒绝 |
| `validity` | 起止时间 + `maxUses` + `single` / `long-lived`；单次必须 `maxUses = 1`；窗口 ≤90 天 |
| `environmentScope` | `dev` / `staging` / `prod` + 资源白名单，精确匹配 |
| `auditRecord` | 必含 12 个字段（`policyId`、`policyVersion`、`matchedRule`、`action`、`paramsDigest`、`subject`、`taskId`、`runId`、`decision`、`at`、`traceId`、`preAuthorizedBy`） |
| `revocation` | 撤销主体列表 + 立即生效 + 下一请求传播；撤销后判定返回 `revoked` |

判定默认 fail-closed：未命中、字段缺失、动作/参数/主体/环境不匹配、过期、次数用尽、已撤销、策略表不可读、审计写入失败，全部返回 `allowed: false`；命中先写审计再返回 `allowed: true`，审计写失败即拒绝。

### 接口与错误码边界

- 未新增 HTTP 路由；策略表增删改查只作为内部模块能力（`server/agents/failopen-policy.js`），不对外暴露。
- 新增错误码 `approval_policy_missing`（HTTP 409）：用于区分“老审批记录缺四字段导致 fail-closed”与“审批尚未批准”。理由：两者处置完全不同（前者需数据迁移/重新申请，后者只需等待人工决定），且 fail-closed 原因必须可审计定位；不新增其他错误码。
- 新增事件类型 `approval.escalated` / `approval.overdue`（仅用于 R2 到期转人工留痕，不改变 Task 状态词表）。
