# P5-C2：计划修订闭环 + 对外发布门（2026-11-13）

> 覆盖原文：Notion §20 第 345/346/349 步后半（planVersion v2 修订闭环、发布节点 waiting_approval、Gateway 幂等执行）。
> 代码基准：`main` = `e2c6a81`（PR #75 合并后）。本文件记录实现、接线点、验收与边界；A-13 复判随合并后在 main 证据上完成。
> 上游文档：`docs/orchestrator-charter-2026-11-13.md`（立项书，轮 1 = 本轮）。

## 1. 实现

### 1.1 修订闭环（`server/agents/plan-revision.js`，`plan-revision-v1`）

**触发**：runtime 终态收口处（`runtime.js` catch 块终态写入之后）：`status === 'failed'` + 任务带 `planId` + errorCode ∈ 验证拒绝码集（确定性验证八码 + review_rejected + verification_conflict）。fail-safe：修订失败只记 `plan.revision_skipped` 事件，不改变任务终态。

**修订语义**：
1. 守卫（先于一切落盘）：修订上限 2 次/计划（`plan.revision_storm_denied`）；开放修订不重复（`revision_in_flight`）；图未收敛不修订（`plan_not_settled`）；只修订 head 版本（`plan_head_mismatch`）；失败任务缺 stepKey 不修订（`step_key_missing`）。
2. `workflowStore.migratePlanVersion`：同一内容追加 v2（唯一版本分配器），completed+可复用产物 → reused、failed 终态 → unchanged（保留追溯）、fencing 同步换代次（旧 Worker 令牌失效，§10）。
3. 只重跑缺证节点：重跑集 = 当前 head 版本上的 failed 任务（旧版本的失败已被上一轮重跑取代，圈进来会造成同 stepKey 双代重跑——实现中真实踩到并修正）。
4. 重跑任务以**真实 taskId** 依赖已完成上游（dependencies.validateGraph 原生支持 key|taskId 双引用），上游产物显式 `artifactStore.share`（编排侧授权动作，可审计，不放宽 worker-scope 默认拒绝）。
5. 修订记录落 `<DATA_DIR>/agents/agent-plan-revisions.json`（原子写）。
6. 事件：`plan.revision_created` / `plan.revision_storm_denied` / `plan.revision_skipped`（已入 EVENT_TYPES；payload 只含 planId/fromVersion/toVersion/rerunCount/revisionId/skipReason 扁平标量，已入 SAFE_PAYLOAD_KEYS）。

### 1.2 发布门（`server/agents/publish-gate.js`，`publish-gate-v1`）

**声明位**：计划级可选字段 `publishGate: {required: boolean, taskType?: string}`（PLAN_KEYS 扩展，**digest 中性**：缺省不出现在归一化输出，旧计划复读 digest 不变，有单测锁定）。
**命中**：任务绑定该计划且（声明了 taskType 时）taskType 匹配；未声明 taskType = 计划内全部任务命中。
**门语义**：命中的任务在验证通过后不直接 completed——
1. 待交付结果落一份 kind='delivery' 产物（pending-commit；正文进产物，审批记录只带引用标量）；
2. `approvals.createApproval({operation:'plan.publish', taskId})` → 任务经既有 moveTaskToApproval 停 `waiting_approval`（不新造状态）；
3. 批准 → approvals.execute 的 plan.publish 分支 → `deliverOnApproval`：读回 delivery 产物正文 → `artifactCommit.completeTask`（产物提交 + 任务 completed，stopReason=publish_gate）→ result-delivery 幸存幂等通道回写父会话（bot-result-<taskId> 去重）；
4. 拒绝/超时 → 既有 decide()/convergeExpiredWaitingApproval 收口，交付永不发生（fail-closed）；产物按既有 TTL 收敛为 orphan。
**R2/30min SLA**：plan.publish 定义为门禁操作（GATE_OPERATIONS 扩展），risk=medium → R2 + 30 分钟 SLA，到期只标 overdue、绝不自动通过。

### 1.3 stepKey 落库（任务 ↔ 计划节点映射）

`tasks.createTask` 增可选 `stepKey`（≤200 字，缺省 null）；`orchestrator.createTaskGraph` 把 definition 的 key 以 `stepKey` 透传，`router.dispatch` 落库。散装任务为 null，行为不变。修订闭环靠它把失败任务映射回计划节点。

## 2. 审计

新事件 4 个：`plan.revision_created` / `plan.revision_storm_denied` / `plan.revision_skipped` / `plan.publish_requested`（EVENT_TYPES + SAFE_PAYLOAD_KEYS 双闸；扁平标量）。交付审计沿用既有 `task.delivery`（dedupeKey 幂等）。审批流事件沿用 approval.*。

## 3. 验收

| 文件 | 用例数 | 覆盖 |
|---|---|---|
| tests/agent-plan-revision.test.js | 5 | a schema digest 中性；b stepKey 透传；c 修订主链（真实上游完成+stub 重跑、v2、只重跑缺证节点、依赖解析为真实 taskId、产物共享、记录+事件）；d 四类守卫（no_plan/plan_not_settled/step_key_missing/plan_head_mismatch）；e 修订上限+链式触发（v2 重跑任务发起第二轮修订，toVersion=3）+ in-flight 守卫 |
| tests/agent-publish-gate.test.js | 4 | a gateForTask 命中面；b+c 主链（真实 worker 运行→waiting_approval→R2 审批→批准交付→delivery committed→重复执行拒绝）；d 拒绝 fail-closed（cancelled+产物 pending-commit+无 completed 事件）；e 零行为变化（无门任务直接 completed） |
| tests/agent-worked-example-e2e.test.js | 1（更新） | 十三步真跑：九步原有断言全保留 + 修订 v2/只重跑缺证节点/发布门 waiting_approval/R2/批准交付 committed/重复执行拒绝/拒绝 fail-closed |

worked example 运行记录：`docs/e2e-worked-example-run-2026-11-13-p5c2.json`（stepCount=13，parallel=true，全部断言在脚本内抛错式校验）。

## 4. 边界与如实标注

1. **验证拒绝的注入边界**：stub 模型产出无法真实触发确定性验证失败（message 产物恒可解析；机械通过+审校 fail 只会判 conflict→人工审批——resolveConflict 决策表决定）。步骤 10 的 `review_rejected` 以 runtime 验证拒绝后的**同一落盘形态**在任务终态注入（与单测同一注入边界）；修订入口与 runtime 钩子调用同一 `createRevision`。真实模型的验证拒绝路径属外部依赖轮次（A-07 类）。
2. **修订重跑的去重**：重跑任务无幂等键，修订守卫（in-flight + storm cap + head 一致）保证不重复起草；重跑任务本身按既有 attempts 重试。
3. **发布门的交付面**：deliverOnApproval 的父会话回写复用 result-delivery 幂等通道；无父会话的任务（直接创建、无 parentSessionId）只做产物提交与任务收口，回写自然跳过。
4. **publishGate.taskType 缺省 = 计划内全部任务命中**（最保守），显式声明可只门终节点。
5. 审批 payload 只收引用标量（正文进产物）；审批记录不含待交付正文。

## 5. 计数与门禁（本分支实测）

- 新增 tests/agent-plan-revision.test.js（5）+ tests/agent-publish-gate.test.js（4）；更新 worked-example-e2e（断言更新，用例数不变）。
- 基线：backend 2437 → 2446；nodeSuite 230 → 239；runner 2207 → 2216；文件 120 → 122；frontend 不变（190）。`sync-doc-counts.js` 已同步。
- 门禁：run-tests 122 文件全过；verify-test-coverage 对账一致；其余门禁退出码 0（见 PR 描述）。
