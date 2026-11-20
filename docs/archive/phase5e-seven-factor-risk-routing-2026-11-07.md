# P5-E：七因子风险路由（2026-11-07）

> 覆盖原文：Notion §13「Policy Engine 按风险、可逆性、影响范围、数据敏感度、来源污点、外部副作用、失败代价七因子取最高适用等级，缺信息升一级且 Agent 不得自行降级；等级 → 最低验证组合矩阵；R2/R3 门槛不可被成本或延迟降级」。
> 代码基准：`main` = `d39c887`（PR #66 合并后）。本文件记录本轮实现、接线点、验收与边界，不替台账改判状态；A-06 复判在合并后用 main 证据做。

## 1. 实现：`server/agents/risk-policy.js`（纯函数引擎，`risk-policy-v1`）

- **七因子 → 等级映射**：原文只给因子名与三条规则（取最高 / 缺信息升一级 / 不得自行降级），各因子到 R0–R3 的映射为**本仓库裁决**，改动必须升版本。要点：
  - `inherent_risk`：任务类型在 `HIGH_RISK_TASK_TYPES` 或任一工具标签 `high_risk` → R3；`reversible_write` → 1；`read` → 0；不认识的工具标签 → missing（不猜成只读）；
  - `reversibility`：irreversible 3 / hard_to_reverse 2 / reversible 1 / read_only 0；
  - `blast_radius`：global 3 / user 2 / task 1；
  - `data_sensitivity`：secret 3 / sensitive 2 / public 0；
  - `source_taint`：只有全部 `verified` 才算「已知干净」（0 档）；混入任何未验证标签或没有标签都按 missing 处理、走升一级——部分验证过的来源不能按干净计；
  - `external_side_effects`：true 3 / false 0；
  - `failure_cost`：high 2 / medium 1 / low 0（映射本身不产生 R3）。
- **三条规则**：
  1. 取最高适用等级；有任何因子 missing → 整体 +1（缺信息升一级，封顶 R3）；「全未知」只指连任务类型都没有的调用 → R3 收口；有任务类型但因子全缺失（如工具标签不认识）按低风险基线 + 升一级（R1），不误判 R3。
  2. `claimedLevel`（Agent 自称等级）只记录、只对比、永不参与计算；低于计算值时 `claimedLevelRejected: true`——「Agent 不得自行降级」的执行点。
  3. `minimumVerification(level)` 矩阵固定：R0 确定性校验；R1 +证据可解析（evidence_checked）；R2 +独立审校（independentReview）；R3 +审批位（approvalOnWeakEvidence，证据不足才触发，与既有 review.escalate 语义一致）。
- **`enforceVerificationFloor`**：R2/R3 请求去掉独立审校 → 拒绝，且 `costPressure`/`latencyPressure` 只作为理由记录、不改变判定（拒绝理由 `r2_r3_floor_not_downgradable_by_cost_or_latency`）；确定性校验是任何等级的绝对下限（`deterministic_floor_mandatory`）。

## 2. 接线点

### 2.1 `autonomy-policy.verificationStrength` 升级为七因子路由

验证强度从「风险标签二值判断」升级为「七因子等级 → 最低验证矩阵」：输出保持既有契约字段（`requiresReview`/`requiresApproval`/`enabled`/`reason`），新增 `level`/`assessment`/`verification`。既有行为逐点保持（测试断言）：`action.execute` → R3 审校、证据弱才审批；`memory.recall` → R1 不审校。证据不足按「失败代价高」进入七因子——这是既有 `high && weak → approval` 语义的因子化表达，不是新口径。该函数的消费方是 `eval-runner`（P5-A 评测链），生产执行路径本就在 Phase 4 受控自治开关之后（默认关闭），本轮不改变其开闭状态。

### 2.2 `runtime.js`：`risk.assessed` 审计 + 工具级 R3 只升不降

每次运行在投影前做一次七因子评估（工具风险标签来自 `listToolMetadata`、污点来自任务实时 taint、任务类型对照 `HIGH_RISK_TASK_TYPES`），结果落 `risk.assessed` 事件（只记等级、是否升级、策略版本、缺失因子名与审校抬升标记，白名单已入 `SAFE_PAYLOAD_KEYS`）。**runtime 只对工具级 R3**——任务声明的工具里出现显式 `high_risk` 风险标签——才把 `requiresReview` 置真（只升不降：已是 true 不改动）。

行为安全边界（如实标注，且经过一轮真实修正）：

1. 任务类型驱动的 R3（如 `action.execute` ∈ `HIGH_RISK_TASK_TYPES`）**不在 runtime 抬审校**——那属于验证强度分发的生产行为，接入点是 autonomy-policy（Phase 4 受控开关，默认关闭）。首轮实现曾按任务类型无条件抬升，`agent-worker.test.js` 的 executor 端到端立刻被改道转人工（waiting_approval）——这正是「验证强度分发默认关闭」存在的理由，已收窄为工具级信号。
2. 默认工具集里没有 `high_risk` 标签的工具（memory/knowledge 是 read，memory_remember/delegate 是 reversible_write），因此该抬升在现网默认任务上不可达——已用注册 `high_risk` 测试工具的自定义 bot 做真实链路验证（见 §3）。
3. **R2 的强制审校同样没有接入生产执行路径**：按本仓库标定（未验证污点走 missing、只读任务 R1），常规任务不会到 R2；若未来把「未验证污点」直接映射为 R2，全量任务将进入审校，模型成本翻倍——这是 Owner 决策，不在本轮偷偷改变生产行为。

### 2.3 `eval-indicators.js`：漏检率独立成行（`p7-indicators-v2`）

§13 点名「漏检率与误拦截率」。误拦截率已有（审批侧 `falseBlockRate`）；漏检率此前只有检出率（`reviewer_detection`，TP/(TP+FN)）隐含。本轮补 `reviewer_miss_rate`（FN/(TP+FN)）独立成行，与检出率同混淆矩阵、互为补数；无分母一律 `known:false` + 值 null + caveat，沿用 P5-A 纪律。指标名单变了，版本 `p7-indicators-v1` → `v2`。

## 3. 验收（`tests/agent-risk-policy.test.js`，8 项全过）

| 项 | 覆盖 |
|---|---|
| 七因子映射 | 各因子单独顶档；取最高；缺信息升一级；全未知 R3；未知工具标签 missing 不猜只读（有任务类型 → R1 非 R3） |
| 来源污点 | 全 verified 才算干净；混入 unverified → missing 升级 |
| 不得自行降级 | 自称 R0 不改变 R3 计算，`claimedLevelRejected` 置位；虚报更高等级不惩罚也不采纳 |
| 矩阵与下限 | R0–R3 组合固定；R2/R3 拒绝降级且成本/延迟压力无效；deterministic 绝对下限 |
| autonomy 契约 | 既有三点逐位保持 + level/assessment/verification 输出；未验证污点 + 可逆写 → R2 审校 |
| 真实链路（低风险） | memory_search 任务 → `risk.assessed` level R1、不抬审校、正常完成、恰好一条评估事件 |
| 真实链路（R3） | 注册 `high_risk` 工具的自定义 bot 任务 → level R3、`requiresReviewRaised: true`、独立审校不可用 → 转人工 `waiting_approval` + 审批记录，绝不静默通过 |
| 漏检率 | 与检出率互为补数（和为 1）；无分母 null + caveat；名单 v2 |

## 4. 计数与门禁（本分支实测）

- 新增 `tests/agent-risk-policy.test.js`（8 项）；`tests/agent-eval-indicators.test.js` 名单/计数断言同轮更新（9 → 10 行、v1 → v2、unknown 名单补 `reviewer_miss_rate`）。
- 基线：backend `2390 → 2398`、runner `2168 → 2176`、文件 `116 → 117`；`sync-doc-counts.js` 已同步。
- 门禁：run-tests 117 文件全过；verify-test-coverage `backend=2398/2398 runner=2176/2176 nodeSuite=222/222 frontend=188/188`；其余四门禁退出码 0。

## 5. 已知限制与后续

1. **A-06 复判在合并后**：本分支不改 A-06 状态列；合并后在 main 重跑门禁再复判（七因子引擎、矩阵、不可降级闸门、漏检/误拦截计数器齐备后，A-06 具备 1.0 条件；漏检/误拦截的**真实分布**仍需外部模型额度，按 §9.2 归外部依赖）。
2. **A-10 复判随本轮带入**：P5-D 已合并（PR #66），main 证据具备，台账 A-10 由 0.5 改判 1.0（旧值保留）。
3. R2 强制审校的生产接入（模型成本翻倍）与「未验证污点」的等级映射口径，留给 Owner 决策；当前 `risk.assessed` 事件已把每个任务的等级与缺失因子落审计，接入前先有观测。
4. 因子映射表是本仓库裁决：`risk.assessed` 事件带 `risk-policy-v1` 版本号，改映射必须升版本并对齐既有用例。
