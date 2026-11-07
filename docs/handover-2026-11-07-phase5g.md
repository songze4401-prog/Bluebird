# Bluebird 交接文档 v2（2026-11-07 收口：Phase 5 C–G 完成）

> 用途：接替上一份 `docs/handover-2026-11-07.md`（基线 `77ddc8f`，已过期）。读完这一份即可独立开工、独立验收。
> 口径：只写有**命令或文件证据**的事实；「未验证」显式标注。本文取证于 2026-11-07，`main` = `0afcf08`（PR #69 合并提交）。

## 0. 当前基线（一分钟看懂）

| 项 | 值 | 取证方式 |
| --- | --- | --- |
| 仓库 | `github.com:songze4401-prog/Bluebird`（SSH） | `git remote -v` |
| `main` | `0afcf08`（PR #69 合并提交） | `git log --oneline -1` |
| 本日已合并 PR | #65（P5-C1 fencing）、#66（P5-D 失败模式命名化）、#67（P5-E 七因子风险路由）、#68（P5-F 审批责任队列）、#69（P5-G 自我改进闭环） | `gh pr list --state merged` |
| 开启中的 PR | **无** | `gh pr list --state open` |
| 后端测试 | **119 文件 / backend 2414 / nodeSuite 222 / runner 2192**（`node --test` 七套 222 + 直接运行器 2192，两口径重叠，按基线文件读） | `scripts/test-coverage-baseline.json` |
| 前端测试 | 22 套 / 188 例（未变） | 同上 `frontend` |
| Agent Runtime 模块 | `server/agents/` 59 个 `.js`（较上一份交接 +3：`fencing`、`risk-policy`、`improvement-loop`） | `ls server/agents/*.js | wc -l` |
| 台账 | **1 = 20 / 0.5 = 5 / 0 = 0**（第九次勘误；0.5 = A-07、A-11、A-12、A-13、B-07） | `node scripts/scan-notion-ledger.js --check` |
| Phase 5 | **A/B/C1/D/E/F/G 全部完成并合并**；未做：P5-C 第 2 轮（A-13 出口） | `docs/phase5-charter-2026-11-06.md` |
| CI | 最近 main 推送门禁见 `gh run list --branch main`（本轮以本地七门禁取证，CI 未逐次核对——**未验证**） | `gh run list` |

**一句话现状**：M1 早已达成；M2（七包清零）只差 P5-C 第 2 轮；剩余 0.5 全部挂在「真实模型额度 / 压测数据 / Owner 产物」三类外部条件上，没有一个是「写代码能解决」的。

## 0.1 接手四步（不要跳步）

1. `git log --oneline -1` 确认 main ≥ `0afcf08`；`gh pr list --state open` 应为空。
2. 按 §1 跑七项检查；数字对不上先查原因（常见：`.env` 打开了 `BLUEBIRD_AGENT_TOOLS`、依赖没装、基线被手改）。
3. 读三份：本文 §2–§5 → `docs/notion-delivery-ledger-2026-11-04.md`（§17 缺口表与九次勘误）→ `docs/phase5-charter-2026-11-06.md`。
4. 从 §6 的下一步开始；**不要重做已合并的 P5-A…P5-G**。

**权限边界**（沿用不变）：推送 / 开 PR / 合并 / 删分支都要明确指令；合并必须 `--merge` 不 squash；合并后在 main 重跑门禁再做台账判据；台账数字只能由 `scripts/scan-notion-ledger.js` 产出；交付前过交付闸门（本环境若无该技能，以「已验证/未验证 + 命令级证据」如实替代并说明）。

## 1. 七项检查（本机 2026-11-07 实测期望值）

```bash
node scripts/run-tests.js                    # 119 个测试文件，全部通过
node scripts/verify-test-coverage.js         # backend=2414/2414 runner=2192/2192 nodeSuite=222/222 frontend=188/188，CI runner 119/119
node scripts/sync-doc-counts.js --check      # backend 2414、nodeSuite 222、runner 2192、frontend 188、文件 119
node scripts/verify-api-capabilities.js      # 路由 104 条、路由族 21 个、仅 API 能力 12 个
npx tsc --noEmit                             # 前端 strict
npx expo lint                                # ESLint
node scripts/scan-notion-ledger.js --check   # 1=20 / 0.5=5 / 0=0，行状态与汇总一致
```

## 2. 本轮（2026-11-07 下午）新增机制速查

| 机制 | 入口 | 版本位 | 不要绕开的点 |
| --- | --- | --- | --- |
| 失败模式命名化（P5-D） | `errors.js` `FAILURE_MODES`（**十四类**，`failure-modes-v3`）+ `verification-loop.js` `role_scope` 检查 + `context-projection.js` `validateHandoff` + `tasks.js` 父子授权交集 + `runtime.js` 终态收口 `collectPartialOutcome` | v3 | 处置动作仍只有 retry/recovery/terminal/escalate；判 1.0 行不许写缺口 |
| 七因子风险路由（P5-E） | `risk-policy.js`（`risk-policy-v1`）+ `autonomy-policy.verificationStrength` + `runtime.js` `risk.assessed` 事件 | v1 | 等级只由服务端信号算，`claimedLevel` 只记录；R2/R3 不接受成本/延迟降级；runtime 只对**工具级 R3** 抬审校（任务类型驱动的分发留在 autonomy 开关后——首轮曾全局抬升，executor 端到端被改道转人工，已收窄） |
| 审批责任队列（P5-F） | `approvals.js` `approval-assignee-v1`（轮值游标/升级重派）+ `approval-workload-v2`（p50/p95 等待、SLA 达成率只对 R2 计、24h 吞吐、`byAssignee`） | v1/v2 | 批量/申诉/取消/提醒语义零回退 |
| 自我改进闭环（P5-G） | `improvement-loop.js`（`improvement-loop-v1`/`auto-rollback-v1`）+ HTTP `/agent-improvements`（8 条路由，能力登记 `agent-improvements`）+ runtime 启动链周期调度器 | v1 | 六类提案之外不可创建；禁止自改清单**逐段归一+词边界前缀+别名**（`permission`/`permissions.v2`/`server/…/permissions.js` 全命中）；批准仅 local-owner；回滚缺省**重跑评测**对照发布前基线（`reportSource: fresh_evaluation`）；灰度分桶确定性哈希 |

评审修正记录（P5-G，同轮）：无生产入口 / 回归检查缺省自比 / 清单精确匹配三缺陷已修，见 `docs/phase5g-improvement-loop-2026-11-07.md` §5。

## 3. 关键不变量（在上一份 §4.2 基础上新增）

10. **改进提案永不自动批准**：调度器只做起草（有开放提案去重）与回滚（fail-safe 方向）；批准/发布/否决只有 local-owner 入口（HTTP 或模块调用均校验 actor）。
11. **禁止自改清单在服务端两侧校验**（创建 + 发布），目标模块按归一化逐段判定——不要「简化」回精确匹配。
12. **灰度分桶是确定性哈希**（同实体同比例永远同桶）；换策略版本即清灰度，新版本比例由发布方重新声明。
13. **`improvement:<proposalId>` 是合法策略激活位**（与 `p4-autonomy-v1` 同级）；`p4-default` 保持默认关闭——不要把「无灰度配置」误当成「全量开启」。
14. **runtime 只对工具级 R3（显式 `high_risk` 工具标签）抬 `requiresReview`**；任务类型驱动的验证强度分发在 autonomy-policy（默认关闭）。

## 4. 运行期状态文件（新增）

`<DATA_DIR>/agents/` 新增：`agent-improvements.json`（提案存储，P5-G）。`strategy-version.json` 结构新增 `gray: {ratio, updatedAt}`（null = 非灰度态）与游标字段（approvals 存储内 `assigneeCursor`）。全部 gitignore。

## 5. 剩余收口清单（按 §11 口径）

1. **P5-C 第 2 轮**（唯一剩余代码包）：`needs_revision → v2 修订闭环` + 发布节点审批 + worked example 十三步；出口 A-13 复判。落点核实仍以 `docs/handover-2026-11-07.md` §11 第 2 条为准（该核实基于 main `77ddc8f`，行号已因本轮改动漂移，动手前重新 grep）。
2. **外部依赖**（写代码不能解决）：A-07 真实模型数字、A-06/A-11 漏检误拦截与收益门槛真实分布、B-07 压测标定、Phase 4 退出判据「可重复改善」需要真实模型轮次；`--leak-scan` 入 CI 门禁。
3. **Owner 决策**：A-12 管理评审记录签发；灰度放量节奏与多责任人轮值池（机制已就绪，池默认 `[local-owner]`）；R2 强制审校是否全量接入生产（成本翻倍）；`status`/`requestStatus` 是否合一。
4. **提示词模板等提案的应用面**：P5-G 的 release 通过 strategy 版本位生效于 autonomy 机制；提示词模板/评测集/工作流配置三类还没有热更消费点，接入属后续轮次。

## 6. 建议推进顺序

1. P5-C 第 2 轮（最后一个代码包；依赖的 fencing/审批流已全部就位）。
2. 外部条件到位后：真实模型轮次（含作废轮/Token/延迟留痕）→ A-07、A-11、B-07 复判 → Phase 4 退出判据判定。
3. Owner 产物：A-12；灰度放量决策。

## 7. 自验证本文档

```bash
git rev-parse --short main                              # 期望 0afcf08
node scripts/scan-notion-ledger.js --check              # 1=20 / 0.5=5 / 0=0
node -e "const b=require('./scripts/test-coverage-baseline.json');console.log(b.backendTotal,b.nodeTestSuiteTotal,b.runnerTotal,Object.keys(b.files).length)"  # 2414 222 2192 119
ls server/agents/*.js | wc -l                           # 59
gh pr list --state open                                 # 期望为空
```

任何一项不符：先以命令输出为准，再更新本文。
