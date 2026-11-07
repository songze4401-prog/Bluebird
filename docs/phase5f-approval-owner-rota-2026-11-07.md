# P5-F：审批责任队列（2026-11-07）

> 覆盖原文：Notion §15「轮值与责任人分配、审批吞吐/积压」+ §29「责任队列、待处理量与超时统计」（台账 A-08 / B-11 残余缺口；A-11 的审批等待分位）。
> 代码基准：`main` = `7d94a32`（PR #67 合并后）。本文件记录本轮实现、接线点、验收与边界，不替台账改判状态；A-08/B-11 复判在合并后用 main 证据做。

## 1. 实现：责任人轮值（`approval-assignee-v1`，全部在 `approvals.js`）

- **轮值池**：默认 `[local-owner]`——单用户实例的合法池就是一个人，但机制必须真实存在：`setAssigneeRotaForTests` 可注入多主人池（生产如需扩池走同一函数面），空池显式拒绝。
- **创建即分配**：`createApproval` 按持久化轮值游标（`state.assigneeCursor`，随审批存储落盘）取下一位写 `record.assignee` + `assigneePolicyVersion`；重启后游标从上次位置继续，绝不重置。旧记录缺字段读作 null。
- **升级即重派**：`escalateApproval` 首次升级时把记录重派给轮值下一位（`assigneeReassignedFrom` 留原责任人；池里只有他一人时保持并如实记录，不伪造轮换）；幂等性沿用既有 `request === 'escalated'` 早退——重派只发生一次。
- **事件**：`approval.requested` / `approval.escalated` payload 增加 `assignee`（已入 `SAFE_PAYLOAD_KEYS`；只记 id，不含正文）。

## 2. 指标 v2（`approval-workload-v2`，替换 `requires_load_test` 空位）

`approvalQueueDistribution` 原先的 `p50WaitMs/p95WaitMs/slaComplianceRate/throughputPerHour` 全是 null + 「需压测」。本轮改为**从记录实算**（口径为本仓库裁决，改动升版本）：

- **样本**：有 `decidedAt` 的裁决记录（approved/rejected/expired/escalated；`cancelled` 不是对事项的裁决，不入分母）；
- **等待分位**：`decidedAt - requestedAt` 排序取位（近似分位：直接取排位样本点，不插值）；样本 <5 条时 caveat 如实标注「波动大」；
- **SLA 达成率**：只对有 SLA 的等级（R2，`sla.slaMs`）计算 `decidedAt ≤ requestedAt + slaMs` 的占比；R3 无 SLA，计入 `slaNotApplicable` 单独呈现——把「没有期限」算成「达成」会虚高；
- **吞吐**：最近 24h 裁决数 / 24；
- **无样本**：一律 `known` 空位 null + caveat（沿用 P5-A「不拿 0 冒充结论」纪律）；
- **待处理量按责任人**：新增 `byAssignee`（pending 记录按 assignee 计数；旧记录没有 assignee，如实进 `unassigned` 桶）。既有 `totalPending/byRiskLevel/byOperation/waitingBuckets/oldestWaitMs` 不变。

## 3. 验收（`tests/agent-approval-owner-rota.test.js`，5 项全过）

| 项 | 覆盖 |
|---|---|
| a 轮值分配 | 双人池 a→b→a 循环；游标持久化（清缓存重读后继续）；恢复单人池 |
| b 升级重派 | escalate 换下一位 + `assigneeReassignedFrom` 留痕；二次 escalate 幂等不再换；单人池保持原责任人 |
| c 待处理量 | `byAssignee` 按人计数；裁决移出 pending；`unassigned` 桶接住无 assignee 记录 |
| d 指标 v2 | 实算 p50/p95（数值型断言，不假设恰为 0）；SLA 分母只含 R2（`slaSampleCount`）、R3 进 `slaNotApplicable`；即时裁决达成率 1；空存储 null + caveat |
| e 不回退 | 批量裁决（`batchDecide` applied/failed）、decidedBy/decidedAt 读取面、assignee 与裁决互不干扰 |

既有四个审批用例文件（request/policy/batch-appeal/recovery）29 项全过；其中「审批负载」一条按 v2 口径同轮更新（v1 的「留位不填数值」断言改为「null 或实算数值，null 必带 caveat」）。

## 4. 计数与门禁（本分支实测）

- 新增 `tests/agent-approval-owner-rota.test.js`（5 项）；基线 backend `2398 → 2403`、runner `2176 → 2181`、文件 `117 → 118`；`sync-doc-counts.js` 已同步。
- 门禁：run-tests 118 文件全过；verify-test-coverage `backend=2403/2403 runner=2181/2181 nodeSuite=222/222 frontend=188/188`；其余门禁退出码 0。

## 5. 已知限制与后续

1. **A-08/B-11 复判在合并后**：本分支不改状态列；合并后在 main 重跑门禁再复判（轮值分配 + 待处理量/超时统计补齐后，两行具备 1.0 条件；吞吐/P95 的**真实压测数值**仍属外部依赖）。
2. **A-11 只收口「审批等待分位」一项**：`p50WaitMs/p95WaitMs` 已实算；最小预期收益门槛、规划耗时占比不在 P5-F 范围，A-11 维持 0.5。
3. 轮值池默认单人：扩到多责任人需要 Owner 决策（多用户 ACL 本就属长期缺口 §9.4）；机制面（游标/重派/分布）已就绪。
4. 指标口径（分位取位方式、SLA 分母只含 R2、吞吐 24h 窗口）是本仓库裁决，`approval-workload-v2` 版本位锁定，改动必须升版本。
