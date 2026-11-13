# Bluebird 交接文档 v3（2026-11-13：Orchestrator 工程 C 系列落地）

> 用途：替代 `docs/handover-2026-11-07-phase5g.md`（那份的 Phase 5 内容仍然有效，本文只增量覆盖 2026-11-13 的 Orchestrator 工程）。读完两份即可独立开工、独立验收。
> 口径：只写有**命令或文件证据**的事实；「未验证」显式标注。取证于 2026-11-13，基线见 §0。

## 0. 当前基线（一分钟看懂）

| 项 | 值 | 取证方式 |
| --- | --- | --- |
| 仓库 | `github.com:songze4401-prog/Bluebird`（SSH） | `git remote -v` |
| `main` | PR #79 合并提交（轮 4 主聊天接线）；收尾 PR 合并后以 `git log --oneline -1` 为准 | `git log` |
| 本日已合并 PR | #75（映射+立项书）、#76（P5-C2 修订闭环+发布门）、#77（轮 2 计划编译器）、#78（轮 3 编排执行引擎）、#79（轮 4 主聊天接线） | `gh pr list --state merged` |
| 收尾 PR | 轮 6（台账表 4 + 扫描器双表化 + handover v3 + 测试扩口）随本文提交 | `gh pr list` |
| 后端测试 | **backend 2473 / runner 2243 / nodeSuite 230 / frontend 190 / 125 文件**（收尾 PR +1 用例后） | `scripts/test-coverage-baseline.json` |
| Agent 模块 | `server/agents/` 新增：`plan-revision.js`、`publish-gate.js`、`plan-compiler.js`、`orchestration-engine.js`；服务端新增 `orchestration-chat.js` | `ls` |
| 台账 | **表 2（A/B 系列）：1 = 21 / 0.5 = 4 / 0 = 0**（第十次勘误 A-13→1.0）；**表 4（C 系列）：1 = 6 / 0.5 = 0 / 0 = 0**（C-05 真实模型验收已闭环） | `node scripts/scan-notion-ledger.js --check`（双表口径） |
| 编排开关 | **默认关闭**（`agent-policy.orchestration.enabled=false`）；Owner 经 `PUT /agent-policy` 显式开启 | `GET /agent-policy` |
| 钥匙 | Owner 会话中先后提供两把：`ak_` 前缀（归属未确证，未使用未落盘）与 `sk-` 前缀（**确证 DeepSeek**，仅环境变量注入跑通 C-05 验收，未落任何文件）；台账表 4 C-05 已复判 1.0 | 台账表 4 C-05 + `docs/orchestration-acceptance-2026-11-13.json` |

**一句话现状**：Orchestrator 立项书六轮中 1–4 已合并（编译器→DAG 执行→主聊天接线），轮 5（真实模型）挂 Owner 决策，轮 6（收尾）随本交接合并。

## 0.1 接手四步（不要跳步）

1. `git log --oneline -1` 确认 main ≥ 收尾 PR；`gh pr list --state open` 应为空。
2. 跑七项检查（§1）；数字对不上先查原因。
3. 读三份：本文 → `docs/orchestrator-charter-2026-11-13.md`（立项书与 D1–D8 决策）→ `docs/notion-delivery-ledger-2026-11-04.md`（表 2 第十次勘误 + 表 4 首次建档）。
4. 下一步从 §5 开始；**不要重做已合并的轮 1–4**。

**权限边界（沿用）**：推送 / 开 PR / 合并 / 删分支需明确指令（2026-11-13 Owner 已给过一次通宵自治授权，本次收尾即在该授权内）；合并必须 `--merge` 不 squash；合并后在 main 重跑门禁再做台账判据；台账数字只能由 `scripts/scan-notion-ledger.js` 产出（现为双表口径）。

## 1. 七项检查（期望值）

```bash
node scripts/run-tests.js                    # 125 个测试文件，全部通过
node scripts/verify-test-coverage.js         # backend=2473/2473 runner=2243/2243 nodeSuite=230/230 frontend=190/190，CI runner 125/125
node scripts/sync-doc-counts.js --check      # backend 2473、nodeSuite 230、runner 2243、frontend 190、文件 125
node scripts/verify-api-capabilities.js      # 路由 108 条、路由族 23 个、仅 API 能力 16 个
npx tsc --noEmit                             # 前端 strict
npx expo lint                                # ESLint
node scripts/scan-notion-ledger.js --check   # [表2] 1=21/0.5=4/0=0；[表4] 1=5/0.5=0/0=1
```

## 2. 本日新增机制速查

| 机制 | 入口 | 版本位 | 不要绕开的点 |
| --- | --- | --- | --- |
| 修订闭环（P5-C2） | runtime 终态收口 → `plan-revision.js`（plan-revision-v1）；守卫：2 次/计划、in-flight、图收敛、head 一致、stepKey 完备 | plan-revision-v1 | `needs_revision` 不是任务状态；只重跑 head 版本失败节点；上游产物显式 share |
| 发布门（P5-C2） | 计划级 `publishGate:{required,taskType?}` → `publish-gate.js`（publish-gate-v1）→ `approvals` `plan.publish`（R2/30min SLA）→ `deliverOnApproval` | publish-gate-v1 | 命中任务验证通过后停 `waiting_approval`（不新造状态）；拒绝/超时永不交付；正文进 delivery 产物、审批只带引用标量 |
| 计划编译器（轮 2） | `plan-compiler.js`（plan-compiler-v1）+ `POST/GET /agent-plans` | plan-compiler-v1 | 纯编译不执行；执行者由路由解析（**模型 agent 名一律丢弃并审计**）；同内容取出语义；`plan.rejected` 先落事件再抛错 |
| 编排执行引擎（轮 3） | `orchestration-engine.js`（orchestration-engine-v1）+ `POST/GET /agent-orchestrations` | orchestration-engine-v1 | 只接受 `plan_pc_` 图；跨 Agent 边仅此放行（dag-v1）；产物显式 share；R2+ 审校门未过不交付；publishGate 未批准不交付；根交付幂等 |
| 主聊天接线（轮 4） | `orchestration-chat.js`（orchestration-chat-v1）+ `agent-policy.orchestration` 开关 + index.js 两路径 | orchestration-chat-v1 | 开关关闭=直答路径零行为差异（有 stub 捕获断言锁定）；编译失败降级直答；剥块不进持久历史；续写不接线 |

## 3. 关键不变量（承接交接 v2 的 14 条 + 新增）

15. **模型计划不可信**：执行者由 router 按 taskType 解析，模型声明一律丢弃并审计；工具集由 manifest 白名单给。
16. **编译失败降级直答**：主聊天任何编译/编排异常都不能让用户请求失败——降级普通回复 + `plan.rejected` 审计。
17. **编排开关关闭 = 零行为差异**：关闭时计划块按普通文本渲染，响应无 `orchestration` 键。
18. **跨 Agent 边只在 `plan_pc_` 图放行**（dag-v1）：散装任务的 `dependsOn` 同 Agent 约束原样保留。
19. **产物继承是显式授权动作**：编排侧集中 `artifactStore.share` 并审计；worker-scope 默认拒绝语义不放宽。
20. **修订/归约钩子全部 fail-safe**：引擎异常不改变任务终态（`plan.revision_skipped` / 静默）。
21. **登记册凭据门槛**：每个 bot 都要有凭据条目才 `enabled`（builtin 也一样）——测试给四 bot 各自 putCredential 是必须的，不是可省的样板。

## 4. 运行期状态文件（新增）

`<DATA_DIR>/agents/` 新增：`agent-plan-revisions.json`（修订记录）、`agent-orchestrations.json`（编排记录）。全部 gitignore、原子写。`strategy-version.json` 无新增（编排开关走 agent-policy，不走灰度位）。

## 5. 下一步

1. **C-05 已闭环（2026-11-13）**：Owner 确证 DeepSeek 钥匙（sk- 格式，内置 provider）后按 `scripts/run-orchestration-acceptance.js` 补验——计划块产出 2/2（以 compiled 为证）、样本 2 端到端 completed 并回写父会话、样本 1 的 memory.write(R3) 触发审校门、真实 reviewer 判 needs_human → blocked_review（fail-closed 实证）、直答对照干净、Token 26,725。运行记录：`docs/orchestration-acceptance-2026-11-13.json`。**审校门槛值（needs_human 何时放行）属 Owner 决策**。
2. 表 2 剩余 0.5：A-07/A-11/B-07——需要真实模型轮次数据与压测标定（编排验收已提供一部分真实 usage 数据，可作 A-07 复判的补充证据）。
3. Owner 侧产物：A-12 管理评审签发；编排开关的开启时机（机制就绪、默认关）；blocked_review 编排的人工处置流程。
4. 可选后续轮次：编排结果的前端展示打磨（现走既有 bot-result 消息通道，零前端改动可用）；审校门 reviewer 提示词调优（真实模型倾向 needs_human，让 pass/fail 判定更可用属提示词模板类提案）。

## 6. 自验证本文档

```bash
git log --oneline -3                                     # 期望：收尾 PR 合并提交在顶
node scripts/scan-notion-ledger.js --check               # [表2] 1=21/0.5=4；[表4] 1=5/0=1
node scripts/verify-test-coverage.js                     # backend=2473/2473 runner=2243/2243 nodeSuite=230/230 frontend=190/190
ls server/agents/plan-compiler.js server/agents/orchestration-engine.js server/agents/plan-revision.js server/agents/publish-gate.js server/orchestration-chat.js
gh pr list --state open                                  # 期望为空
```

任何一项不符：先以命令输出为准，再更新本文。
