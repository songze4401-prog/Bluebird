# P5-D：失败模式命名化（2026-11-07）

> 覆盖原文：Notion §17 九类失败模式表中原文点名、此前未命名未检测的四类（FM-1/2/3/5），以及 FM-6 的收尾项「部分结果交付或请求决策」。
> 代码基准：`main` = `0638358`（PR #65 合并后）。本文件记录本轮实现、接线点、验收与边界，不替台账改判状态；A-10 复判按约定在合并后用 main 上的证据做。

## 1. 范围与不做什么

- **做**：FM-1 角色漂移、FM-2 交接上下文丢失、FM-3 委派链权限逐跳放大、FM-5 验证器同源偏差四处「检测信号 + `FAILURE_MODES` 命名 + 处置路由 + 越界用例」；FM-6 补「交付部分结果并披露缺口 / 请求决策」。
- **不做**：不新增任务状态（复用 failed/recovery/waiting_approval/retrying）；不重做 FM-4（P5-C 第 1 轮已交付，`plan_version_race`，v2）；不动 P5-C 第 2 轮的 v2 修订闭环与发布节点（那是 A-13 的出口）。
- 处置表升版本：`failure-modes-v2` → `failure-modes-v3`（表内容变了就升版本，不让同一版本号指向两份表）。

## 2. `errors.js`：清单 v3（十四类）

新增四键与默认处置（动作仍只在 retry/recovery/terminal/escalate 四类里）：

| 键 | 原文 | 检测信号（errorCode 族） | 处置 |
|---|---|---|---|
| `role_drift` | FM-1 角色漂移 | `verification_role_drift`（verification 的 role_scope 检查） | retry（缩小上下文重路由，受 attempts 上限约束，耗尽即 failed） |
| `handoff_context_lost` | FM-2 交接上下文丢失 | `handoff_context_missing` | recovery（阻断执行，人工补齐或重建后放行，不盲目重跑） |
| `delegation_privilege_escalation` | FM-3 委派链权限逐跳放大 | `delegation_permission_escalation`（创建期拒绝，任务不落盘） | terminal（分类供监控聚合） |
| `verification_source_bias` | FM-5 验证器同源偏差 | `verification_review_not_independent` / `arbiter_not_independent` / `arbiter_scope_exceeded` | escalate（复用 waiting_approval + review.escalate，不自动批准） |

`classifyFailureMode` 补四组正则；正则顺序在既有九类之后，不改变任何既有归类（`stale_generation`、`fencing_unavailable` 等语义不变）。

## 3. 接线点

### 3.1 FM-1：`verification-loop.js` 确定性校验加 `role_scope` 检查

运行期调用恒带 taskId，此时核对四件事，任一不过即 `verification_role_drift`（fail-closed）：

1. `tasks.getRawTask(taskId)` 存在；
2. `getManifest(task.botId)` 在注册表内（Manifest 事后撤除 = 漂移）；
3. `taskType ∈ manifest.acceptedTaskTypes`、`task.allowedTools ⊆ manifest.toolAllowlist`；
4. 结果字段 ⊆ `RESULT_SCHEMA_FIELDS`（`normalizeWorkerResult` 统一 schema 的并集）。

失败后走既有 `planGate` reject → 任务不产出成功结果（trustLevel 保持 declared）；`decideFailureDisposition` 把该码判为 retryable，重试前 `runtime.js` 把自由文本 `context` 置空（只留 goal 与已验证引用），留 `task.recovered` 审计。taskId 缺省（纯函数调用）时跳过本项，既有 115 文件的调用形状不受影响。

`tasks.updateTask` 为此开了一条受控通道：`patch.context` 只收字符串并截断到 `CONTEXT_MAX`，专供重路由收窄使用。

### 3.2 FM-2：`context-projection.js` 加 `validateHandoff`（纯函数）

- 委派方在任务上声明 `requiredContextKeys`（createTask 归一化：去重去空白、单键 ≤60 字、总数 ≤12）；
- 承载位置两处：`task.context`（JSON 对象字符串）与 `task.contextRef`（已验证产物，正文为 JSON 对象）；
- 纯文本 context 无法承载具名约束：声明了必需键而两处都给不出 → **fail-closed 判缺失**，不靠猜；
- 缺失键能从 contextRef 产物补齐 → 重建放行，runtime 落 `handoff.context_rebuilt` 审计（新事件类型，payload 只含键名与引用 id）；**重建出的约束会合并进本次投影用的 context 副本**（`必要上下文` 一行），保证 Worker 真的看到约束值，而不是只拿到一个读不到的引用 id；原任务记录不回写，审计以事件为准；
- runtime 在投影之前调 `validateHandoff`：缺失即抛 `handoff_context_missing`，Worker 不启动、模型零调用，按 recovery 收口。

### 3.3 FM-3：`tasks.js` 创建期父子授权交集（choke point）+ `router.js` 前置拦截

- `tasks.createTask`：父任务存在且显式声明过 `allowedTools` 时——
  - 子任务显式声明的工具 ⊄ 父任务授权 → 抛 `delegation_permission_escalation`（403），任务**零落盘**；
  - 子任务省略声明 → 默认授权收窄到父任务授权交集内（不能靠「不声明」拿到父任务没有的工具）；
  - 父任务未显式收窄（全量白名单）→ 维持既有行为。
- `router.dispatch` 在**计划落盘之前**做同一判定（零孤儿计划），拒绝时写 `route.rejected` 安全事件（payload 只含父任务 id 与越界工具名，`security`/`parentTaskId`/`escalatedTools` 已入 `SAFE_PAYLOAD_KEYS`）。Task Store 的判定保留作纵深防御。
- Gateway 每次调用的既有 `task_tool_denied` 判定不变——创建期交集 + 运行期网关是两层，互不替代。

### 3.4 FM-5：同源偏差纳入统一命名与处置

- `runtime.js` 的 openReview catch 保留真实短码（原来是泛化的 `review_unavailable`），让 `verification_review_not_independent` 经 `resolveConflict → resolution.errorCode` 进入 `classifyFailureMode` → `verification_source_bias`；
- `auditResolution` 的裁决审计事件带 `failureMode` 分类（§17 聚合可直接消费）；
- `planGate` 对同源偏差落 `approval`（转人工），行为与既有保守默认一致，本轮只补命名与审计，不改变裁决语义。

### 3.5 FM-6 收尾：部分结果交付与请求决策（`runtime.js` 终态收口）

- 收口时 `collectPartialOutcome(taskId)` 收集产物存储里**归属本任务、仍可读**（active/pending-commit/committed）的记录；
- 有可交付部分 → 失败结果的 `summary` 带缺口披露（「已交付 N 项部分结果…」）、`artifacts` 带引用，事件带 `partialCount`；**绝不把未完成内容伪装成完成**；
- 无可交付部分且本次失败本可重试（attempt 上限或风暴判据拦下）→ 落 `task.decision_requested` 事件（新事件类型），不留静默终态。
- 边界（如实标注）：验证失败路径的产物会被既有 `invalidateArtifactRefs` 拒掉，**不该**也不出现在部分结果里；当前单步 runtime 下，「已完成部分」的真实来源是两段提交中断（persist 完成、completeTask 失败）留在 pending-commit 的产物——用例按此注入。

## 4. 验收（`tests/agent-failure-modes-p5d.test.js`，10 项全过）

| 项 | 覆盖 |
|---|---|
| 清单 v3 | 十四类齐全、四新键处置正确、分类正则不伤既有归类 |
| FM-1 检测 | 任务缺失 / Manifest 撤除 / taskType 越界 / 结果字段越出 schema 都被 `role_scope` 拒绝；职责边界内不误报 |
| FM-1 真实链路 | 真实 `runTask` + 故障注入：越界输出被拒 → context 缩空 → `task.recovered` 带 `role_drift` → 终态 failed，零 `task.completed` |
| FM-3 | 父窄子宽 403 且零落盘；省略声明继承收窄；交集内放行；全量父任务不收窄 |
| FM-2 纯函数 | 缺失阻断 / JSON 承载放行 / 引用重建 / 引用不可读保持缺失 / 半重建仍判缺失 |
| FM-2 真实链路 | 缺必需约束不启动（recovery、零 `model.requested`、留审计）；从已验证引用重建后放行并留 `handoff.context_rebuilt` |
| FM-5 | 同源 Producer 自查自批 409；分类 escalate（waiting_approval + review.escalate）；`planGate` 转人工不静默通过 |
| FM-6 | 两段提交中断 → 收口 result 带 pending-commit 产物与缺口披露（非空 summary）+ 事件 partialCount；模型层失败无可交付 → `task.decision_requested` |

## 5. 计数与门禁

- 新增 `tests/agent-failure-modes-p5d.test.js`（10 项）；`tests/agent-failure-modes.test.js` 的清单长度断言 10 → 14（P5-D 同轮合法扩展）。
- 基线：backend `2380 → 2390`、runner `2158 → 2168`、文件 `115 → 116`；`sync-doc-counts.js` 已同步五处文档计数。
- 门禁（本分支实测）：run-tests 116 文件全过；verify-test-coverage `backend=2390/2390 runner=2168/2168 nodeSuite=222/222 frontend=188/188`；sync-doc-counts / verify-api-capabilities / scan-notion-ledger / tsc / expo lint 退出码 0。

## 6. 已知限制与后续

1. **A-10 复判在合并后**：本分支不改台账状态列；合并后在 main 重跑五门禁，再按 §3.2 规则复判（6 类原文失败模式全部有命名、处置与越界用例后，A-10 具备 1.0 条件）。
2. FM-1 的 schema 白名单与 `normalizeWorkerResult` 输出形状耦合：未来给结果加新字段时须同步 `RESULT_SCHEMA_FIELDS`（有越界用例兜底）。
3. FM-2 的 `requiredContextKeys` 目前只有 createTask/router 两个入口透传；delegate_to_bot 工具（`tool-dispatch-bot.js`）未暴露该参数——主控委派如需声明必需约束，后续在工具 schema 里加（不阻塞本轮验收）。
4. FM-6 的「请求决策」目前是审计事件，不迁状态；审批节点语义（超时 fail-closed、Gateway 幂等执行）属 P5-C 第 2 轮的发布节点范围。
