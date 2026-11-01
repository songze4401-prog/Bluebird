# Bluebird 记忆链路阶段0审计报告（只读链路审计）

> 依据：《Bluebird 记忆系统端到端链路：集成与可靠性治理方案》阶段0（一次性链路审计，只读，不改代码）。
> 审计范围：HEAD 6cb0842，主控 Agent 记忆读取链路 + 写入/生命周期链路。
> 结论性质：本报告标记每个节点的实现程度与首个断点，供阶段1（打通最小闭环）使用。

## 1. 固定状态

| 项 | 值 |
| --- | --- |
| 分支 | `qoder/memory-link-reliability-2026-11-01` |
| HEAD | `6cb0842`（审计基线；实现提交 `62d0536`） |
| 工作区 | 干净（`git status --short` 无输出） |
| 备注 | 阶段0 只读审计；阶段1-4 实现与本文档随分支提交并推送 |

## 2. 读取链路节点追踪（主控入口 → Provider 请求）

| 节点 | 位置 | 职责 | 调用关系 | 异常/降级 |
| --- | --- | --- | --- | --- |
| N1 对话端点 | `server/index.js` `/chat`(:3100)、`/chat/stream`(:3387) | HTTP 入口、Agent 门控、错误映射 | → N2 | Provider 错误归一化 |
| N2 prepareChatRequest | `index.js:2327` | 模型解析、历史投影、组装 baseSystemBlocks(:2587) | → N3 | — |
| N3 runContextRuntime | `server/context/engine.js:81` | 唯一上下文编排：selectHistory→summary→retrieveMemory(:137)→retrieveKnowledge→buildContext→fitRequest→verifyContext | → N4/N5/N6 | 检索失败捕获(:138-145) |
| N4 retrieveMemory | `server/context/retriever.js:191`(→fetchMemory:115) | 熔断(:24-48)+重试(:211-229)+时效(:50) | → N5 | 熔断/重试 |
| N5 searchMemories | `server/memory.js:2213` | 检索核心：会话隔离 scopeOf(:1707)、打分、预算截断 | memory 存储 | MEMORY_ENABLED 开关(:52) |
| N6 buildContext | `server/context/builder.js:197` | TTL/冲突/去重裁决，渲染记忆块(priority 30) | → N7 | — |
| N7 fitRequest | `server/context/input-guard.js:105` | 超限确定性裁剪(:154-168)，产出 messages(:220) | → N8 | 超限→413 context_too_large |
| N8 Provider 请求 | `server/model-adapter.js:567` createChatCompletion；Agent 路径 `server/agent-runtime.js:587` runAgentTurn | 最终请求；工具结果以 role:'tool' 进下一轮(:893) | Provider | 超时/断连 abort(:446-457) |
| N9 工具 | `server/tool-memory-search.js:238`、`server/tool-knowledge-search.js:115`、`server/tool-dispatch-bot.js:119` | 记忆/知识检索、委派 | → N5/agents | tool_timeout |
| N10 收尾 | `index.js:2811` completeChatTurn、:2998 scheduleMemoryExtraction | 落盘+异步写记忆（失败仅日志:3058） | 存储 | 静默 |

注入形式：记忆块并入 systemPrompt 文本（`builder.js:51-69`，"【关于用户的长期记忆…】"）。可验证性：`trace.sent.rounds` 记录实际发送 messages 快照（`index.js:3071`、`agent-runtime.js:681`），可做消息级校验；`context-engine-e2e.test.js:693` 已有 sent 断言。

## 3. 写入/生命周期链路节点追踪

| 生命周期操作 | 实现位置 | 状态 |
| --- | --- | --- |
| 决策 create/merge/update/supersede/reject | `server/memory-decision.js` decide(:51-130) | 已实现（纯函数） |
| 执行 | `server/memory.js` applyCandidate(:1116-1404) | 已实现（Agent 路径强制转 pending :1218-1255） |
| 确认/拒绝/归档/删除/撤回 | confirmPending(:2822)/rejectPending(:2962)/archiveMemory(:2987)/deleteMemory(:2758)/withdrawMemory(:3364) | 已实现 |
| 维护入口 | `server/memory-service.js` execute(:247-268)，仅由 `agents/approvals.js` 审批执行器调用 | 已实现（独立边界） |

- 写入成功定义：主存原子落盘（saveMemories）成功即 durable:true；**检索索引为惰性同步**（下次含 memory 源的检索时 syncMemory `retrieval/index.js:348-350` 才入索引），存在最终一致性窗口，无持久重试队列。
- 删除/撤回/归档即时失效：refreshDerivedMemoryIndex → cleanupMemoryIndex + pruneMissingSources（`retrieval/index.js:1279-1289`）。
- **缺口**：update/supersede 不触发 refreshDerivedMemoryIndex（`memory.js:2515/2582`），旧 chunk 留存至下次 sync；`connectors/memory.js:62` 硬编码 status:'active'，索引无法表达生命周期；引擎不消费 supersededBy 字段。

## 4. 实现程度分类

| 程度 | 节点/模块 |
| --- | --- |
| 真实链路验证通过 | context v3 全链（`engine.js`→builder→fit→adapter）、Agent 工具链、撤回/删除索引清理（`memory-api-recall.test.js` 全链 HTTP、`memory-agent-write.test.js` /chat→agent-runtime→memory_remember） |
| 已实现 | 全部生命周期函数、会话隔离 scopeOf、预算截断、熔断重试 |
| 仅单测覆盖 | 更新后旧版本/ supersede（`retrieval.test.js:691/1166`、`memory-lifecycle-decisions.test.js`）、删除不可见（`delete-semantics.test.js`）、撤回（`memory.test.js:244`）、empty vs failed（`retrieval.test.js:1019/1029`）、预算裁剪（`memory.test.js:456`） |
| 未接线（与主控记忆链路无关） | `server/retrieval/*`（engine/store/reranker/security/contract）只服务知识子链路与 API 路由；`retriever.js:117` injected.memory 生产死路径（`index.js:2656` 未传）；`memory.js:1762` buildMemoryContext 为评测路径 |
| 占位/缺口 | 统一 Orchestrator（编排在 `context/engine.js`，但主控在其外直拼门控/收尾，非全链路 orchestrator）；全局 requestId（无，仅每轮工具 call id）；response 体不含 memory 状态 |

## 5. 首个断点（已用代码证据确认）

**记忆子系统健康状态不向上冒泡——故障与"真无相关记忆"在主控层不可区分、不可观测。**

证据链：
1. `server/context/engine.js:138-145`：检索异常被捕获为 `retrieval = { status:'retrieval_error', count:0, items:[] }`，空 items。
2. `engine.js:251`：整体 `ok` 仅由 6 条验证规则（过期实时、重复召回、注入 id 子集、摘要可溯、消息匹配、无失败项）决定，空 items 全部通过 → `contextRuntime.ok=true`。
3. `server/index.js:2718`：主控只检查 `contextRuntime.ok`，不检查 `memory.status`，照常进入对话。
4. `server/index.js:2752`：日志仅记 `memory=0/x`（计数），无状态、无 requestId 串联；响应体与前端完全不可见。

后果：Search 故障、MEMORY_ENABLED 熔断、真无相关记忆三种情况表现完全一致；无法区分 empty 与 degraded/failed，违反文档"status 必须区分确实没有相关记忆 vs 检索失败"约束。修复属于阶段1/阶段3（统一状态码与追踪字段），阶段0 只定位不修改。

## 6. Golden Path 测试覆盖缺口（端到端缺失）

以下 6 条 Golden Path 缺"写库→query→断言最终 stubCalls.messages"的真链路用例（现有桩体系 `context-engine-e2e.test.js` 具备扩展能力）：
1. 写入后召回进最终 Provider 请求
2. supersede 端到端
3. 超时降级端到端
4. empty vs failed 端到端
5. 预算裁剪进最终请求
6. 删除/撤回后最终请求不可见

测试规模基线：后端 1748 用例、前端 179 用例（`scripts/test-coverage-baseline.json`）；`scripts/verify-api-capabilities.js`、`scripts/sync-doc-counts.js` 均为静态/计数校验，非链路级。

## 7. 剩余风险与后续建议

- 阶段1 最小闭环建议：先打通"写入一条记忆 → 主控下一轮实际使用"Golden Path（第 6 节缺口 1），复用 `trace.sent` 与 openai 桩断言最终 messages；随后补统一编排入口与 requestId 贯穿。
- 生命周期一致性（update/supersede 索引延迟同步、connector 硬编码 active、supersededBy 未消费）属阶段2 范围，本阶段不改。
- 本报告随分支提交并推送；后续如合入请按仓库既有审计文档风格处理。

## 附：验证方式说明

- 本审计基于 HEAD 6cb0842 只读追踪（Explore 代理 + 关键代码点复核）；未对运行中服务注入对话请求。
- 运行时日志（API PID 5312，重启后）仅确认服务启动与鉴权，不含记忆链路样本；链路证据以上述代码点与既有 e2e 测试为准。

---

## 阶段1完成记录（2026-11-01，Golden Path 最小闭环）

> 变更说明：阶段1为打通最小闭环，改动最小且可回滚；已随分支提交。

### 交付1：Golden Path 端到端测试（新增 `tests/memory-golden-path.test.js`）

真实主控入口（/chat + OpenAI 桩捕获每次 create 的完整 messages）验证三条链路：

1. **写入**：第1轮经 `memory_remember` 工具写入 → 落盘 active、来源 agent、会话归属正确；
2. **写入后召回并实际注入**：第2轮主控提问 → `retrieval.status=ok candidates=1 accepted=1`，记忆块（`memory:mem-…`）进入最终 Provider 请求 system prompt（桩断言含 `【关于用户的长期记忆…】` 与记忆内容）；
3. **Session 隔离**：第3轮换会话提问 → `no_result`，最终请求不含上一会话记忆。

结果：**9 项断言全通过**。覆盖了阶段0审计缺口1（写入后召回进最终 Provider 请求）与缺口6（Session 隔离端到端）。

测试设计要点：记忆内容需比原话更丰富（含"不加糖不加奶"），否则会被覆盖去重（containment≥0.75 → covered_by_context）正确跳过——这是"过滤"环节的预期行为，不是断点。

### 交付2：记忆编排契约字段上浮（`server/context/engine.js` + `server/index.js`）

- `runContextRuntime` 返回值新增稳定契约字段 `memoryStatus`（`ok / no_result / source_unavailable / retrieval_error`）与 `memoryError`（两条返回路径均覆盖），对应文档契约的 ok / empty / degraded / failed 语义（内部词汇保持不变，避免破坏现有测试断言）。
- 主控 `[context]` 日志行新增 `memStatus=…`、`memError=…`，故障/熔断/真无记忆不再不可区分（阶段0首个断点的可观测性半闭合；requestId 贯穿与响应体状态属阶段3）。

### 回归验证

- 关键子集 7 项（memory-agent-write、context-engine-e2e、context-engine、memory-api-recall、delete-semantics、session-scope-e2e、memory）全部通过；
- 全量 `npm test` 基线见下方状态（`scripts/run-tests.js` 自动发现新测试文件，`memory-golden-path.test.js` 已纳入 CI）。

### 未做（属后续阶段）

- 阶段3：统一状态码/超时/错误分类、requestId 贯穿、响应体暴露 memory 状态、超时降级与 empty vs failed 端到端用例。

---

## 阶段2完成记录（2026-11-01，生命周期一致性）

> 变更说明：阶段2为生命周期一致性，改动聚焦索引与主存一致性；已随分支提交。

### 交付1：统一检索索引生命周期一致性（`server/retrieval/connectors/memory.js` + `server/memory.js`）

- **连接器只索引当前有效记忆**：`collectMemoryChunks` 用 `isEffectiveAt`（active 且在 validFrom/validTo 窗口内）过滤，pending / superseded / archived 条目不再入索引；`sourceIdsForMemory` 同口径，旧源在 `pruneMissingSources` 时被移除。引擎既有 `statusAllows`/`validityAllows`/`scopeAllows` 过滤随之生效，索引不再可能把已失效内容当现行事实返回。
- **写路径即时刷新**：`applyCandidate` 的 create / merge_update / supersede 分支与 `confirmPending` 的 confirm / confirm_update / confirm_supersede 分支在落盘成功后调用 `refreshDerivedMemoryIndex(reason)`，与既有 delete / archive / withdraw / clear 行为一致，消除"更新/取代后索引仍留旧 chunk"的窗口。最终一致性边界：统一索引在内存源检索时按签名惰性同步，写主存路径（searchMemories）本就即时一致。

### 交付2：生命周期 Golden Path 端到端测试（新增 `tests/memory-lifecycle-golden.test.js`）

真实主控入口 + OpenAI 桩 + `/retrieval/search` 索引断言，**22 项全通过**：

1. **Supersede 生效**：矛盾事实 → pending → 确认后旧事实 superseded（`supersededBy`+`validTo`）、新事实 active；主控最终请求只注入新事实；统一检索只返回新事实。
2. **删除后不可见**：删除后主控最终请求与统一检索均不可见。
3. **撤回后停止引用**：`/history/recall` 摘除记忆贡献后，主控最终请求与统一检索均不再返回。
4. **Session 隔离**：S1 的生命周期变更不泄漏到 S2 视图。

覆盖阶段0审计缺口 2/4/5 + 统一检索与主存一致性（A8/C5/D6）。

### 回归验证

- 阶段2相关子集 12 项（含 memory / retrieval / retrieval-api / memory-retrieval / delete-semantics / session-scope-e2e / 两 Golden Path 测试）全部通过；
- 全量 `npm test` 基线见状态（`memory-lifecycle-golden.test.js` 已纳入 CI 自动发现）。
- 备注：全量偶发用例（memory-bot 直接对话、data-events K 项）在负载下出现过时序失败，独立复跑均通过，与本次改动无关。

---

## 阶段3完成记录（2026-11-01，降级与可观测性）

> 变更说明：阶段3为降级与可观测性；改动为 additive 状态字段，不改变主链路行为；已随分支提交。

### 交付1：统一记忆状态码与追踪字段

- **标准化状态映射**（`server/context/engine.js` `normalizeMemoryState`）：内部检索状态 → 契约状态 `ok / empty / degraded / failed`：
  - `ok`→ok；`no_result`（空查询/空库）→empty；`source_unavailable`（记忆未启用）→empty；
  - `retrieval_error` + breaker → degraded（熔断可恢复）；其他 `retrieval_error` → failed（故障但不断言为无记忆）。
- **`runContextRuntime` 返回值新增 `memoryState`**（标准化）+ 既有 `memoryStatus`/`memoryError`，两条返回路径一致；关闭了阶段0首个断点（故障/熔断/真无记忆不可区分）。
- **主控响应暴露**（`server/index.js`）：ctx 携带 `contextMemoryState`/`contextMemoryStatus`，`/chat` 响应与 `/chat/stream` 的 `done` 事件新增 `memoryState`/`memoryStatus`（additive，前端不受影响）；`[context]` 日志行新增 `memState=`。

### 交付2：降级与状态 e2e / 单元测试（新增 2 文件 + 扩展 1 文件）

1. **`tests/memory-state-units.test.js`**（stub retriever，17 项）：`normalizeMemoryState` 映射规则；检索抛异常 → `memoryState=failed` 且 `contextRuntime.ok=true`（记忆故障不阻断主控）；熔断 → degraded；无匹配 → empty（与 failed 明确区分）；成功 → ok。
2. **`tests/memory-degradation-golden.test.js`**（MEMORY_ENABLED=false 真实 server，6 项）：记忆关闭时主控仍完成普通对话；响应暴露 `memoryState=empty` / `memoryStatus=source_unavailable`（不误报故障）；最终 Provider 请求不注入记忆块（降级不伪造注入）；连续对话保持稳定降级。
3. **`tests/memory-golden-path.test.js` 扩展**：HTTP 响应级断言 `memoryState` 从 empty（写入前）→ ok（写入后召回），验证 empty/ok 端到端区分。

### 回归验证

- 阶段3相关子集 15 项：除 `chat-stream` 外全部通过（engine/context/e2e/persona/chat-persist/memory 系列/retrieval-api/session-scope）。
- **`chat-stream` 失败确认为既有环境性 flaky**：在 stash 全部阶段1-3改动后的干净 HEAD 上独立运行同样失败（相同 7 项，均为流式 delta 聚合相关）；早前三次全量运行均通过。已与本次改动解耦，不归因于阶段3。
- 全量 `npm test` 基线见状态（三个新测试文件已纳入 CI 自动发现）。

### 未做（属后续）

- Golden Path #9 预算裁剪进最终请求的端到端断言（已在阶段4补齐）；requestId 贯穿调用链（已在补充阶段完成）；响应体记忆状态的前端消费（app 端展示，仍属后续）。

---

## 阶段4完成记录（2026-11-01，回归与稳定化）

> 变更说明：阶段4为回归与稳定化；新增预算裁剪 Golden Path 测试，无源码改动；已随分支提交。

### 交付1：完整 Golden Path 执行（10 项全覆盖）

| # | Golden Path | 验证方式 | 结果 |
| --- | --- | --- | --- |
| 1 | 写入后召回进最终 Provider 请求 | `memory-golden-path`（stub 捕获 messages） | ✓ |
| 2 | 更新后旧版本不再注入 | `memory-lifecycle-golden` A（supersede 确认路径覆盖更新语义；工具路径无显式 update 目标，如实记录） | ✓（语义等价） |
| 3 | Supersede 生效 | `memory-lifecycle-golden` A（supersededBy+validTo，主控与索引均只认新事实） | ✓ |
| 4 | 删除后不可见 | `memory-lifecycle-golden` C（主控最终请求 + `/retrieval/search`） | ✓ |
| 5 | 撤回后停止引用 | `memory-lifecycle-golden` D（`/history/recall` 摘贡献） | ✓ |
| 6 | Session 隔离 | `memory-golden-path` round3 + `memory-lifecycle-golden` B + `memory-session-isolation` | ✓ |
| 7 | 超时降级（不阻断） | `memory-state-units`（检索异常/熔断/时间预算超时→failed/degraded 且 ok=true）+ `memory-degradation-golden`（记忆关闭→empty） | ✓（记忆检索已有 `memoryTimeoutMs` 时间预算，见「剩余差异修补完成记录」） |
| 8 | 空结果区分 empty vs failed | `memory-state-units` + `memory-degradation-golden` + `memory-golden-path` 响应级断言 | ✓ |
| 9 | 预算裁剪进最终请求 | **新增** `tests/memory-budget-golden.test.js`（7 项）：10 条记忆→memoryMaxItems=8→最终请求注入 ≤8 条且 <10 | ✓ |
| 10 | 端到端注入检查（最终 messages） | 上述全部通过 stub 捕获的实际 `create()` 参数断言 | ✓ |

### 交付2：最终状态汇总

- **已验证结果**：阶段1-4 全部交付落地；5 个新 Golden Path 测试文件（memory-golden-path 12 项、memory-lifecycle-golden 22 项、memory-state-units 20 项、memory-degradation-golden 6 项、memory-budget-golden 7 项）+ 源码改动（engine/index/memory/connectors/trace，共 +40 行）。
- **未解决问题**：
  1. `chat-stream.test.js` 独立运行偶发失败（流式 delta 聚合），干净 HEAD 复现、全量下通过——既有环境性 flaky，非本次改动引入；
  2. 显式 update 目标路径仅 `applyCandidate(target)` 调用方可达，工具/HTTP 路径不可达；
  3. 统一索引的最终一致性窗口：写主存即时一致；索引在确认/删除/撤回/归档等生命周期操作即时刷新，普通写入按"下次记忆源检索"惰性同步。
- **回滚方式**：改动全部在 5 个源码文件（`server/context/trace.js`、`server/context/engine.js`、`server/index.js`、`server/memory.js`、`server/retrieval/connectors/memory.js`），`git checkout -- <file>` 即可回滚；新增测试文件删除即移除；审计文档不参与运行。
- **后续风险**：记忆链路状态已可观测且前端已消费响应字段（见「剩余差异修补完成记录」）；统一索引生命周期已与主存一致，但无持久重试队列（索引同步失败仅记录）；预算裁剪只覆盖 memoryMaxItems，tokenBudget 级裁剪仍依赖输入保护层兜底。

---

## 补充完成记录（2026-11-01，核对差异收敛）

> 背景：阶段4后逐节核对 Notion 方案，发现唯一结构性差异为 requestId 未贯穿调用链；本阶段仅补齐该项，已随分支提交。

### 交付：requestId 全链路贯穿

| 节点 | 落点 | 行为 |
| --- | --- | --- |
| 生成 | `server/index.js` `prepareChatRequest` | 每次请求生成 `req_<uuid>`，不复用、不伪造 |
| 编排 | `server/index.js` → `runContextRuntime({ requestId })` | requestId 传入唯一编排入口 |
| 上下文 | `server/context/engine.js` | 两条返回路径（正常 / 输入超限）均返回 `requestId` |
| 证据 | `server/context/trace.js` | trace 根节点记录 `requestId`（经 `sanitizeId`，超长即 null） |
| 日志 | `[context]` 运行日志 | 新增 `req=<requestId>`，可与 trace/响应逐条对齐 |
| 响应 | `POST /chat` 与 `/chat/stream` done 事件 | 均携带 `requestId`，前端/排障可关联同一次请求 |
| 写入事件 | `scheduleMemoryExtraction` | 写入成功/跳过/提取失败的 data event 均带 `requestId` |

### 验证结果

- `tests/memory-state-units.test.js` 扩至 **20 项**（新增：引擎返回值携带 requestId、trace 根节点携带 requestId、未传入时为 null 不伪造）；
- `tests/memory-golden-path.test.js` 扩至 **12 项**（新增：第1轮响应 requestId 以 `req_` 开头）；
- 回归子集全绿：`memory-lifecycle-golden` 22 项、`memory-degradation-golden` 6 项、`memory-golden-path` 12 项、`memory-budget-golden` 7 项、`context-engine` 48 项、`memory-state-units` 20 项；
- 全量 `npm test`：**60 个测试文件全部通过**（exit 0）。

## 剩余差异修补完成记录（2026-11-01）

> 背景：上节列出的 3 项非结构性差异已按方案补齐；已随分支提交。

### 交付1：检索契约显式建模（purpose / categories / tokenBudget）

| 位置 | 行为 |
| --- | --- |
| `server/retrieval/engine.js` | 新增 `PURPOSES`（`chat_context/agent_tool/api_search`）与 `CATEGORY_SOURCES` 映射；`normalizePurpose`/`normalizeCategories` 归一；`createPlan` 记录 `purpose/categories/timeoutMs`，`emptyTrace.limits` 记录 `limit/tokenBudget/timeoutMs` |
| `server/retrieval/index.js` | `search()` 校验 `purpose/categories`；`categories` 映射为 sourceType 并与 `sources` 取交集，无交集返回 `sources_empty`；非法值返回 `invalid_purpose/invalid_category` |
| `server/retrieval/routes.js` | `limit`/`tokenBudget` 显式校验（`invalid_limit`/`invalid_token_budget` → 400） |
| 调用方 | `searchForContext` → `purpose: 'chat_context', categories: ['knowledge']`；`knowledge_search` 工具 → `purpose: 'agent_tool'` |

### 交付2：真实时间预算与降级

- `server/context/config.json`/`config.js`：`retrieval.memoryTimeoutMs=800`（schema + `requirePositiveNumbers`）。
- `server/context/retriever.js`：`retrieveMemory` 计算 deadline；`fetchMemory` 入口/出口检查预算；超时不重试，返回 `retrieval_error` + `timeout: true`，已取回的部分结果照常返回。
- `server/context/engine.js`：`normalizeMemoryState` 优先把 `timeout` 映射为 `degraded`（已拿到的结果仍注入，不阻断主控）。
- 统一检索：保留逐通道真实超时（向量补齐 `vector_sync_deadline`、embedding/reranker 各自 `withTimeout(remaining)`），超时只标记 `trace.degraded` 并返回 `partial_success`；**不叠加整体 Promise.race**——同步词法扫描无法被抢占，竞速会把已完成的降级结果误报为整体失败（`retrieval-embeddings` 两项 deadline 用例据此回归通过）。

### 交付3：前端消费 memoryState

- `lib/types.ts`：新增 `MemoryState` 与 `Message.memoryState/memoryNote`；`lib/api/types.ts` 的 `ChatResponse` 新增 `requestId/memoryState/memoryStatus`。
- `lib/chat-messages.ts`：新增 `buildMemoryNote`；`buildReplyBubbles` 只给最后一格挂 `memoryState/memoryNote`。
- `components/ChatBubble.tsx`：渲染 `memoryNote`；`ok/empty` 不提示，`degraded/failed` 明确「本轮未引用记忆、对话不受影响」。

### 验证结果

- `tests/memory-state-units.test.js` **26 项**（新增时间预算超时 6 项）；
- `tests/retrieval-api.test.js` **14 项**（新增查询契约用例：非法 purpose/category/budget/limit → 400，无交集 `sources_empty`，合法值进入 trace）；
- `tests/unit/chat-messages.test.ts` **39 项**（新增 memoryState 透传与提示 2 项）；
- `tests/retrieval-embeddings.test.js` 10 项（2 项 deadline 用例保持通过）；
- 回归：`memory-golden-path` 12 项、`context-engine` 48 项、`retrieval` 30 项；
- `npx tsc --noEmit` exit 0；
- 全量 `npm test`：**60 个测试文件全部通过**（exit 0）。
- 文档：`docs/unified-retrieval.md` 的 `/retrieval/search` 参数表补充 `purpose/categories` 与超时降级语义。

### 已知代价（审查补充）

- `create` 路径触发的 `refreshDerivedMemoryIndex` 为 `force` 全量同步（全量收集 + 索引写入），大数据量下需基准测试；本轮未做去抖。
- `/retrieval/search` 的 `limit`/`tokenBudget` 非法值改为 400（不再静默归一），已在 `docs/unified-retrieval.md` 标注。
- 记忆时间预算只做入口/出口检查，同步扫描无法被抢占：超预算会标记 `degraded` 并保留已取回的部分结果，但不保证请求延迟上限。
- 降级提示文案按“可能仅引用部分记忆”表述，避免与部分结果注入行为矛盾。
