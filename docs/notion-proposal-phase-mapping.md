# Notion 提案《Bluebird 自动记忆系统》× 仓库现状映射（2026-11-10）

依据：Notion 页面 `Bluebird-413a957523c281cfb44be2eaed1a3b34`（目标架构提案，§0-§13），
对照 main `29fcc9b` + 本地分支栈（见 DELIVERY-NOTE-OVERNIGHT.md）。本文件只做结构梳理，
不重写已有决策；每条映射标注「已实现 / 部分 / 缺口」与证据位置。

## 0. 总览

| 提案阶段 | 状态（2026-11-10） | 本地交付 |
|---|---|---|
| Phase 0 现状审计（只读） | **已完成** | `PHASE0-AUDIT-2026-11-09.md`（七条链路逐项核验 + 八个断点） |
| Phase 1 自动观察闭环 | **能力已落地（开关交付）** | `BLUEBIRD_MEMORY_OBSERVER=every_turn`（2843b51）；前置观测修补（0a9d2c7/d00015b） |
| Phase 2 渐进式生命周期 | **最小闭环已落地** | 观察台账（hash-only，0006）；缺：observed 正式态、异步深整、晋升语义评审 |
| Phase 3 召回与上下文调度 | **大半已存在** | Context Runtime v3 + P3 orchestrator；缺：used 态、阈值评测校准 |
| Phase 4 用户控制与删除一致性 | **大半已存在** | Memory Center（P6）+ Profile（P5）+ delete-semantics 55 项回归 |
| Phase 5 深度整理与派生 | **未启动（按提案纪律暂缓）** | 提案自己要求「基线评测证明收益后再引入向量库/图库」 |

## 1. 提案核心原则 × 现状（§0 八条）

| 提案原则 | 现状 | 证据 |
|---|---|---|
| 1 自动发现，不等口令 | **开关已交付**：`every_turn` 每轮尝试提取；默认仍 trigger | `server/memory.js` getObserverMode；`.env.example` |
| 2 证据先于画像 | 已实现：provenance 五类 + sourceQuote 接地双路径 + inferred 必须显式标注 | `server/memory-evidence.js:16-93`；`memory.js:1285-1306` |
| 3 价值与置信度分离 | **本轮补上观察层**：低置信拒写不再无痕丢弃，hash-only 台账累计独立会话 | `server/memory-observation-ledger.js`；`memory.js` low_confidence 分支 |
| 4 渐进式晋升 | 部分：independent_support 已有（merge 场景）；低置信观察 → 候选的晋升语义**未实现**（刻意留待评审） | `AGENTS.md:73-74` |
| 5 记忆与人格隔离 | 已实现：persona customPrompt 经 neutralizeContextText 注入、不可获得工具 | `AGENTS.md:75`；`tests/persona.test.js` |
| 6 存储与使用分离 | 部分：trace 六段 candidate/selected/accepted/injected/sent/consumed；`used` 无法直接观测（提案自己也承认只能评测估计） | `server/context/trace.js:146-147` |
| 7 可纠正、可撤回、可删除 | 已实现：update/merge/supersede/archive/withdraw/delete + 墓碑防复活 + P5 feedback | `docs/memory-bot.md` §5；`server/memory-tombstones.js` |
| 8 端到端可证明 | 部分：P4 真实链路脚本就绪（需真 key）；`memory.write.completed` 事件本轮起带 channel/decision/observer_mode | `docs/p4-real-e2e.md`；`server/monitoring/index.js` |

## 2. Phase 2 差距清单（观察台账之后还差什么）

1. **observed 正式态**：提案 §4.4 九态中的 `observed`（观察到、尚未形成候选）。现实现为
   台账（非记忆库状态）——避免了状态机与数据迁移风险，但提案语义上的「低权重可检索」
   尚未提供。引入前需：状态机边、searchMemories 可见性规则、Memory Center 展示、迁移脚本。
2. **异步深整通道**（§4.1）：跨轮合并、重复识别、证据累计。台账已提供数据底座，
   深整调度器未实现。
3. **晋升语义评审**：独立会话 ≥2 时把观察转为 `needs_confirmation` 候选——涉及
   `decide()` 决策语义，按 §11 纪律需要单独设计 + 评测，不夜间偷跑。
4. **类目覆盖**：提案 Phase 1 要求覆盖「稳定事实/长期偏好/项目决策/临时状态」四类。
   现状：前三类由 extractMemory 类型白名单覆盖（identity/preference/fact/goal/relationship）；
   临时状态由 `temporary_state` 拒写码覆盖（memory-decision.js:56-58 + memory-evidence.js:104）。

## 3. Phase 3 差距清单

提案 §5 要求 vs 现状：
- 意图路由/按 scope 检索：**已实现**（`server/context/orchestrator.js` 八类意图 + 预算 + 阈值）。
- 有效性过滤（排除 deleted/withdrawn/superseded/expired）：**已实现**（`memory-observability`
  测试的 visibilityReasons 分解：superseded/expired/pending/archived 单独计数）。
- 无答案不注入：**已实现**（orchestrator no-answer 阈值；memory-observability「低相关性单独计数」）。
- 安全组装/围栏：**已实现**（neutralizeContextText + 边界标记 + 【…】中和）。
- 记录 trace：**已实现**（trace.js 六段 + sent 哈希 + provider/stub usage 对账）。
- **缺口 a**：`used` 态（模型实际消费）——提案承认只能评测估计；当前 `consumed` 恒 null 是诚实口径。
- **缺口 b**：阈值由固定评测集校准——`eval:semantic`/`eval:retrieval` 已有固定集；orchestrator
  的 0.08 fact_query 阈值等参数尚未与之闭环（标注 TBD）。
- **缺口 c**：Ranker 的效用（utility）维度——检索排序用类型权重/时间衰减/状态权重
  （AGENTS.md:54），utility 字段已写入条目但未参与排序。

## 4. Phase 4 差距清单

- Memory Console 展示状态/来源/有效时间/决策理由：**已实现**（P6：画像/时间线/图/审计；
  P5：来源贡献 + feedbackHistory）。
- 纠正/撤回/删除与墓碑：**已实现**（P5 confirm/deny/correct + delete-semantics 55 项）。
- 缓存、索引、异步任务不复活：**已实现**（deleted_source/duplicate_source 幂等 + 墓碑）。
- **缺口**：本轮新增的观察台账尚无 UI 入口（数据可见性：`getObservations()` 导出，
  无 HTTP 路由——刻意不加路由面，避免能力登记面扩大；评审后随晋升语义一起接 UI）。

## 5. Phase 5 纪律

提案明确：只有在基线评测证明收益后才引入向量数据库、图数据库或独立服务。
现状吻合：memory-semantic 是概念词典（`semanticKind: 'concept_lexicon_v1'`，非神经向量，
AGENTS.md:54 明示）；统一检索的向量通道已接但生产端点未验证。维持暂缓。

## 6. 本夜批处理对提案的直接贡献

| 提案条目 | 夜间交付 |
|---|---|
| §4.1 双通道观察的「每轮快速通道」 | `every_turn` 观察器（Phase 1） |
| §4.2 证据模型可观测 | 写入事件带 channel/decision/anchor_score/keyword_hits/keyword_total/confidence/observer_mode |
| §4.4 观察层（原则 3） | 观察台账（hash-only，500 上限，损坏隔离，processMemory 集成） |
| §9 写入质量指标的数据基础 | 拒因分布首次可跨重启对账（此前只有 stderr + 20 条内存环） |
| §12 七条待核验项 | Phase 0 报告逐项回答；B2/B8 断点已闭合观测面 |
| 链路稳定性 | retrying 退避活性缺陷修复（生产级）+ 11 个测试桩连接竞态系统性消除 |

## 7. 验收命令链（审核 agent 在合并后执行）

```bash
node scripts/sync-doc-counts.js --check
node scripts/verify-api-capabilities.js
node scripts/scan-notion-ledger.js --check
npx tsc --noEmit
npm run lint
node scripts/verify-test-coverage.js   # backend 2437 / nodeSuite 230 / runner 2207 / frontend 190 / CI 120
```

计数说明：本轮新增 tests/memory-observation-ledger.test.js（5 项）后，全仓 120 个
后端测试文件 / 2437 项；runner 2207。基线（scripts/test-coverage-baseline.json）
与文档计数同轮更新，单一来源不变。
