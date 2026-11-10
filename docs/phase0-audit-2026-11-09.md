# Bluebird 自动记忆系统 — Phase 0 只读审计报告

日期：2026-11-09　性质：只读审计（未改代码、未改配置、未跑测试）
依据：《Bluebird 自动记忆系统》Notion 提案 §10 Phase 0 / §12 待核验项

## 0. 基线与方法

| 项 | 实测值 |
|---|---|
| 开发仓库 | `C:\Users\Administrator\Documents\Qoder\2026-10-27\975cfd2c\Bluebird`，main = `29fcc9b`（2026-11-09 20:57 +0800，PR #73 合并提交），工作树干净 |
| 运行实例 | `C:\Users\Administrator\Documents\trae_projects\Bluebird`，git = `29fcc9b`（已快进） |
| 后端进程 | **未运行**。`server/data/.bluebird.lock` 记录 pid 18128 / port 3000 / startedAt `2026-11-07T17:08:01Z`，但 PowerShell `Get-Process -Id 18128` 返回 NOT RUNNING —— 陈旧锁 |
| 运行 env（非密钥） | `PORT=3000`、`MEMORY_ENABLED=true`、`BLUEBIRD_AGENT_TOOLS=1`；**未设置** `BLUEBIRD_MEMORY_EVIDENCE_POLICY`（代码默认 `compat`，`server/memory-evidence.js:53-59`） |
| 数据快照 | `memory.json` 修改于 2026-11-07 23:06；`monitoring/events.jsonl` / `traces.jsonl` 最后写入 2026-11-08 01:33（以上均为本地时间） |

方法：静态读代码（带行号）+ 只读聚合运行数据（只取计数/短码，不输出记忆正文）。

## 1. 写入链路（静态）

```
/chat 或 /chat/stream
  → scheduleMemoryExtraction()            server/index.js:3134-3207（调用点 3501 / 4007）
      setImmediate 异步；isContinue 跳过；无 memoryClient 跳过
  → processMemory()                       server/memory.js:2073-2101
  → attemptMemoryWrite()                  server/memory.js:1949-2033
      ├─ 触发门控 shouldProcessMemory()   server/memory.js:308-316（正则 :92-93，>500 字跳过）
      ├─ extractMemory()                  server/memory.js:1135-1306
      │    prompt :1168-1197；model=deepseek-chat :1162；timeout 15000ms :1206；单次调用，无重试
      │    {} / 非 JSON → model_empty :1230-1232
      │    校验：content≤100、quote≥2、type 白名单、置信度（显式意图 0.6 / 默认 0.85）:1259-1272
      │    接地：anchor≥0.15 或 fallback≥0.05 且关键词覆盖≥50% :1285-1306
  → applyCandidate()                      server/memory.js:1503-1591
      ├─ decide()                         server/memory-decision.js:51-134（纯函数）
      └─ getPolicyMode()                  server/memory-evidence.js:53-59（compat / strict）
  → 原子写 + 墓碑                          server/memory.js:1040-1108
  → 结果观测
      monitoring memory.write.completed   server/index.js:3166-3171；schema.js:76
      stderr memory_write_rejected        server/memory.js:360-380（只进 stderr，不进 monitoring）
      内存环 20 条 + GET /memory/write-attempts  server/memory.js:2040-2059；index.js:2092
```

## 2. 读取链路（静态）

`/chat` → Context Runtime（`server/context/engine.js`）→ `retriever.js:12` 复用 `searchMemories`，`:200-203` 传服务端可信 `userId` → 用户级作用域（`server/memory.js:2244-2260` 注释、`:2312` scopeOf）→ `coverage.js` / `input-guard.js` → 组装 → Provider。

trace 六段：`candidate → selected → accepted → injected → sent；consumed`（`server/context/trace.js:5`）。
注意 `candidate` 是**本轮历史消息总数**（trace.js:229），`injected` 是注入消息计数，不是“记忆条数”；`consumed` 恒为 `null`（trace.js:146-147，明确注释“HTTP 成功不等于模型已消费”）。

## 3. 运行时证据（只读聚合）

### 3.1 memory.json

- 条目 8 条，全部 `active`。
- provenance：`imported` 7、`user_asserted` 1；category：`legacy` 7、`stable_fact` 1。
- `lastDecision.action`：`create` 3、无 5；**贡献数 ≥2 的条目 0 条**。
- 无 `memory-tombstones.json`。
- 解读：当前库主要是迁移/历史数据，自动写入留下的有效样本很少（与 §4 一致）。

### 3.2 monitoring/events.jsonl（10678 行）

| 事件 | 条数 |
|---|---|
| `memory.search.started` / `.completed` | 337 / 337 |
| `memory.write.completed` | 23 |

`memory.write.completed` 分布（attributes: action/written/reason，时间 2026-10-29T16:44Z ~ 2026-11-07T16:40Z）：

| status | reason | written | 条数 |
|---|---|---|---|
| skipped | `no_content` | false | **18** |
| skipped | `low_confidence` | false | 2 |
| success | — | true | 3 |

`memory_write_rejected`（stderr 通道）不在 events.jsonl 中。

### 3.3 monitoring/traces.jsonl（2484 条，chat 345 条）

- chat trace 345；`injected>0` 的 336 条（按 trace 六段计数）。
- span：`tool.memory_search` 11、`tool.delegate_to_bot` 6、`tool.knowledge_search` 3、**`tool.memory_remember` 0**。

### 3.4 agents

- 任务 6 条：4 completed / 2 failed（4× `memory.search`、2× `memory.explain`），全部有 parentSessionId。
- 事件 217 条：`worker.checkpoint` 30、`model.requested` 25、`worker.scope_denied` 22、`tool.started`/`tool.completed` 各 21、`memory.read` 19、`model.failed` 3 等。

## 4. §12 七条逐项回答

| # | 待核验项 | 结论 | 证据 |
|---|---|---|---|
| 1 | 正常用户消息是否每轮触发记忆观察 | **否**。仅当消息命中触发词正则且 ≤500 字；显式“记住”等意图把置信度门槛降到 0.6 | `server/memory.js:92-93, 308-316, 1267-1268` |
| 2 | Extractor 提示词 / schema / 空结果 / 失败重试 | prompt 与 strict JSON schema 固定；`{}` 或解析失败 → `model_empty`；**单次调用、无重试**，15s 超时 | `server/memory.js:1162-1206, 1110-1133, 1230-1232` |
| 3 | 自动抽取是否进入 decision / memory service | **是**。`attemptMemoryWrite → applyCandidate → decide + evidence`，结果以 `memory.write.completed` 落 monitoring | `server/memory.js:1980-2033, 1503-1591`；`server/index.js:3166` |
| 4 | Agent 是否实际调用 memory_remember、失败是否被吞 | **运行轨迹中 0 次调用**（`tool.memory_remember` span = 0，memory_search=11）。工具 handler 对失败返回结构化 `ok:false`/短码，runtime 把它记进 toolSteps；但没有独立的持久失败日志（交接遗留 task_b4ae6fb0 的 2 条候选未追溯） | `traces.jsonl` span 聚合；`server/tool-memory-remember.js:225-244`；`server/agent-runtime.js` toolSteps |
| 5 | 运行环境 `BLUEBIRD_MEMORY_EVIDENCE_POLICY` 实际值 | **未设置 → 默认 `compat`** | `server/.env` 无该键；`server/memory-evidence.js:53-59` |
| 6 | 低风险稳定事实为何被拒、拒绝码分布 | 有样本：23 次写入尝试中 **18 次 `no_content`（78%）**、2 次 `low_confidence`、3 次成功。**主因是抽取器没产出内容，不是 0.85 阈值**。分布仅来自 monitoring 的 write.completed；stderr 的 `memory_write_rejected` 与内存环（重启即失）不构成持久分布 | `events.jsonl` 聚合；`server/memory.js:360-380, 2040-2059` |
| 7 | 写入后能否跨会话检索并注入最终请求 | 代码路径具备（用户级 scope + retriever 传 userId + trace sent/injected）；单测/集成测试存在；**真实端到端未验证**（后端未运行、开发仓库无 .env key、P4 脚本需 `BLUEBIRD_P4_REAL=1` + 真 key，本轮未跑）。运行库 8 条中 7 条为 legacy/imported，自动写入样本仅 1 条 | `server/context/retriever.js:12,200-203`；`trace.js:146-147`；`docs/p4-real-e2e.md` |

## 5. 五类状态表（提案组件 vs 仓库）

| 提案组件 | 状态 | 依据 |
|---|---|---|
| Observer（每轮轻量观察） | **未实现**（触发词门控代替） | `memory.js:92-93, 308-316` |
| Extractor | 已实现（单次、无重试） | `memory.js:1135-1306` |
| Evidence Builder | 已实现（provenance/category/utility/模式） | `memory-evidence.js:16-115` |
| Policy Engine | 部分实现（敏感、归属、墓碑、审批在；无独立组件，规则散落 memory.js） | `memory.js:1218,1274`；`agents/approvals.js` |
| Decision Engine | 已实现（create/merge/update/supersede/reject/needs_confirmation） | `memory-decision.js:51-134` |
| Lifecycle Manager | 部分实现：active/superseded/archived/pending/contested/withdrawn/deleted 有；**observed/expired 无正式态** | `AGENTS.md:73-74`；`memory-decision.js` |
| Canonical Store | 已实现（原子写 + 墓碑 + 写队列） | `memory.js:1040-1108` |
| Indexes | 已实现（关键词/向量，可重建；无实体关系索引） | `server/retrieval/*` |
| Memory Service 唯一入口 | **部分实现**：`memory-service.js` 只覆盖维护；tool 与 index 直接调 `memory.applyCandidate` | `tool-memory-remember.js:11,195`；`index.js:257-269` |
| Retriever / Ranker / Budgeter / Builder | 已实现 | `server/context/*` |
| Usage Feedback（命中/采纳/纠错/无关） | 部分实现（P5 profile feedback 有 confirm/deny/correct；`consumed` 恒 null） | `trace.js:146-147`；`docs/p5-profile-feedback.md` |
| Memory Console | 已实现（Memory Center P6） | `docs/p6-ops-visualization.md` |
| Evaluator / Observability | 部分实现（有读写计数与检索漏斗；写质量指标缺数据基础） | `monitoring/*`；§3 |

## 6. 断点清单（按影响排序）

1. **B1 没有“每轮观察”**：写入机会由触发词正则决定；提案 §4.1 的快速通道不存在。这是 Phase 1 的核心缺口。
2. **B2 写入失败以 `no_content` 为主（18/23，78%）**：抽取器经常返回空/解析失败，其次是 2 条 `low_confidence`。**不能归因于 0.85 阈值**，与提案 §12 的告诫一致。
3. **B3 抽取单次调用、无重试**：模型抖动或空返回直接丢弃，无降级二次抽取。
4. **B4 Agent 从未调用 `memory_remember`**：运行轨迹 0 次；Agent 侧写入实际未发生（主控抽取是另一条路）。
5. **B5 Memory Service 不是唯一入口**：工具与 index.js 直接调用 `memory.applyCandidate`，与提案 §2 的架构约束不符。
6. **B6 生命周期与提案九态有差距**：缺 observed/expired 正式状态。
7. **B7 `used` 不可测**：`consumed` 恒 null，只能证明到 injected；提案 §5.3 的四态里最后一态未落地。
8. **B8 写入观测通道不完整**：stderr 的 `memory_write_rejected` 不进 monitoring；`/memory/write-attempts` 是 20 条内存环，重启即失。

## 7. 本轮未验证 / 边界

- 后端未运行，**未做真实端到端**（P4 需真实 key，本轮未跑；本轮也未跑任何测试/门禁，按只读审计口径）。
- `traces.stages.injected` 是消息计数（含历史），**未细分 memory vs history**；不能据此宣称“记忆注入率”。
- 运行数据是 2026-11-08 01:33 前的历史快照，不代表当前配置下的新行为。
- 未读取任何记忆正文/用户原话；聚合只用了计数与短码。
