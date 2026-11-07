# P5-G：受控自我改进闭环（2026-11-07）

> 覆盖原文：Notion §2.6「失败模式评估 → 改进提案 → 沙箱/离线评测 → 人工批准 → 版本发布 → 回归与回滚联动」+ §5 Phase 4 第 3 项「灰度发布（分桶比例 + 自动回滚阈值）」。
> 代码基准：`main` = `4210a1a`（PR #68 合并后）。本文件记录本轮实现、接线点、验收与边界，不替台账改判状态（A-06/A-08/B-11 的复判因 P5-E/F 已合并、main 证据具备，随本轮一并完成，见台账第九次勘误）。

## 1. 实现：`server/agents/improvement-loop.js`（`improvement-loop-v1`）

提案存储 `<DATA_DIR>/agents/agent-improvements.json`（原子写），记录 `{proposalId, category, target, reason, evidenceRefs, proposedChange, status, evaluation, approvedBy, release, rollback}`。状态机：`draft → evaluated → approved → released → rolled_back`，任意态可转 `rejected`（仅 local-owner），非法迁移 409。

### 1.1 六类提案与禁止自改清单

- 六类：提示词模板 / 路由阈值 / 拆解策略 / Agent 选择 / 评测集 / 工作流配置。
- **禁止自改清单是服务端校验**（`FORBIDDEN_TARGETS`）：权限策略、密钥、预算硬上限（agent-limits）、审批规则（approvals）、审计机制、生产发布权限（release-authority）——`createProposal` 与 `releaseProposal`（纵深防御）两侧都查，命中 403 `improvement_forbidden_target`。

### 1.2 失败模式评估 → 自动起草

`draftFromFailureModes({ events })` 只聚合真实事件里的 `failureMode` 标签（P5-D 起失败事件自带分类），同一模式 ≥2 次（`DRAFT_MIN_COUNT`）且在映射表内才按最高频起草（role_drift→提示词模板、handoff_context_lost→工作流配置、approval_stall/budget_exhausted→路由阈值、dependency 死锁/成环→拆解策略；映射为本仓库裁决）；无显著信号返回 null，**不为「有提案」而凭空起草**。证据引用真实事件 id。

### 1.3 离线评测

`evaluateProposal` 用既有评测链双跑：`eval-runner.runSuite`（comparator `production` vs `candidate`）+ `eval-metrics.computeMetrics` 统一口径，delta（成功率/返工率/Token/延迟）与安全计数（approvalBypass/failClosedHits/unauthorizedDenied/deadLetters）全部入档；本步骤不改任何运行时状态。

### 1.4 人工批准 → 版本发布 → 灰度

- `approveProposal`/`rejectProposal`：actor 必须是 `local-owner`，**Agent 没有自批入口**（403）。
- `releaseProposal({grayRatio})`：发布侧再查禁止清单；`strategy-version.apply({version: 'improvement:<proposalId>'})` + `setGray({ratio})`——版本激活位语义扩展为「`p4-autonomy-v1` 或 `improvement:*`」，`p4-default` 保持 Phase 4 默认关闭姿态；换版本即清灰度。
- **灰度分桶是确定性的**：`isInBucket(entityId, ratio)` 用 sha256 定点采样，同一实体同一比例永远同桶（灰度不是随机抽样，否则归因被污染）。`strategy-version.isEnabledFor(entityId)` + `autonomy-policy.isEnabledFor(entityId)` 按桶判定；无灰度配置 = 全量语义。

### 1.5 回归与自动回滚联动（`auto-rollback-v1`）

`checkAutoRollback({proposalId, report?})`：已发布提案的当前评测（生产路径与 evaluateProposal 同一套）对照发布前基线——**任一安全计数上升**或**成功率 delta < 0** 即 `strategyVersion.rollback()` + 提案转 `rolled_back`（原因入档 + `improvement.rolled_back` 事件）。无回归则明确返回 `rolledBack:false`。

## 2. 审计

新事件 `improvement.proposed/evaluated/approved/released/rolled_back`（已入 `EVENT_TYPES`），payload 只含 `proposalId`/`target`（module:configKey）/`taskType`（类别）/`status`/`mode` 扁平标量（`proposalId`/`target` 已入 `SAFE_PAYLOAD_KEYS`），不记提案正文。

## 3. 验收（`tests/agent-improvement-loop.test.js`，7 项全过）

| 项 | 覆盖 |
|---|---|
| a 禁止自改清单 | 六个禁止目标逐个 403；六类合法目标可提案；类外类别/缺 target 拒绝 |
| b 失败模式起草 | 真实事件聚合（role_drift×2 → prompt_template，证据为真实事件 id）；阈值不足/空事件 → null |
| c 评测 | production/candidate 双跑同 caseCount；delta 与安全回归入档；draft 直发 409 |
| d 人工门槛 | agent 批准 403；local-owner 批准后才能发布；`release.strategyVersion` 正确；已发布不可再发 |
| e 灰度 | 分桶确定性（同 id 同桶）；ratio=1/0 边界；发布后 strategy.gray 落盘；`isEnabledFor` 按桶；换版本清灰度；p4-default 对实体关闭（Phase 4 默认姿态）；非法 ratio 400 |
| f 自动回滚 | 无回归不回滚；安全计数退化 → 回滚 + rolled_back + 原因入档；成功率跌破基线同触发；策略版本确实回滚 |
| g 读取面 | listProposals 状态过滤、get 未知 id null |

既有相关用例（eval-baseline/autonomy-policy/eval-runner）不受灰度改动影响，随全量门禁验证。

## 4. 计数与门禁（本分支实测）

- 新增 `tests/agent-improvement-loop.test.js`（7 项）；基线 backend `2403 → 2410`、runner `2181 → 2188`、文件 `118 → 119`；`sync-doc-counts.js` 已同步。
- 门禁：run-tests 119 文件全过；verify-test-coverage `backend=2410/2410 runner=2188/2188 nodeSuite=222/222 frontend=188/188`；其余门禁退出码 0。

## 5. 边界修正（2026-11-07 评审后同轮修复，均已验证）

评审发现三处缺陷，全部修复并补用例（`tests/agent-improvement-loop.test.js` 7 → 11 项）：

1. **闭环没有生产入口**（原实现只有测试调用）：已接三处入口——
   - HTTP：`/agent-improvements` 路由族（列表/详情/创建/评测/批准/否决/发布/回归检查/从失败起草，Bearer 鉴权，能力登记 `agent-improvements`，路由 104/族 21）；
   - 周期调度器：`createImprovementScheduler`（镜像 orphan-scheduler 模式：启动跑一次 + 每小时周期、单飞防重入、失败只记账、timer unref；`BLUEBIRD_IMPROVEMENT_LOOP_INTERVAL_MS=0` 停用），挂进 `runtime.initializeTaskQueue` 启动链；起草带开放提案去重守卫（不制造提案垃圾），released 提案自动进回归检查；
   - 调度器只做两件安全方向的事：起草（永远等人工批准）与回滚（fail-safe 方向）；批准/发布永远等人工。
2. **checkAutoRollback 缺省路径拿发布数字自比**：改为缺省**重跑评测**——`evaluateProposal` 把评测输入（suitePaths/baseTime）随提案落档，回滚检查缺省用同一输入重跑 candidate 一侧对照发布前基线（`reportSource: 'fresh_evaluation'`），发布之后才出现的退化也能被发现；调用方显式传 report 时用调用方数字。
3. **禁止自改清单精确匹配可绕过**：改为**逐段归一 + 词边界前缀 + 别名**——路径任一段（`server/agents/permissions.js` 的 `permissions`）、单复数/别名（`permission`/`secret`/`budget`）、版本后缀（`permissions.v2`/`credentials-v2`）都命中；判定顺序为先对原始输入判禁、再叶段归一（顺序反了会把 `audit/X` 归一成 `x` 漏判——修复过程中真实踩到并修正）；合法模块（`autonomy-policy`/`eval-suite`/`auditor-notes`）不误伤。

## 6. 已知限制与后续

1. **「真实数据驱动」的 Phase 4 退出判据仍未满足**：闭环的评测数字来自离线 stub 评测集；「相对基线可重复改善」需要真实模型轮次（外部依赖 §9.2）。P5-G 交付的是闭环机制与安全边界，不是退出判据。
2. 六类提案中提示词模板/评测集/工作流配置的**应用面**尚未接到具体运行时消费点（提案→评测→批准→灰度链路真实，release 后对 autonomy 机制的实际生效通过 strategy 版本位表达）；把提示词模板变成可热更的消费点属后续轮次。
3. 灰度比例与放量节奏是 Owner 决策；机制面（确定性分桶/自动回滚阈值/审计）已就绪。
4. 自动回滚阈值为本仓库裁决（`auto-rollback-v1`：任一安全计数上升或成功率 delta<0），改动必须升版本。
