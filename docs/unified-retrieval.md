# 云岫 Bluebird — 统一语义检索与知识索引 v1

日期：2026-10-31

基线：`main` @ `ff0c575`（PR #43 合并后）
分支：`qoder/neural-embedding-acceptance-2026-10-31`

## 1. 能力状态（先给结论）

| 能力 | 状态 | 证据 / 边界 |
|---|---|---|
| 统一 chunk 契约、稳定 ID、scope | 已实现、已验证 | `server/retrieval/contract.js`；`tests/retrieval.test.js` 契约/存储用例 |
| 五类知识源连接器（memory / conversation / document / web / code） | 已实现、已验证 | 各连接器测试；文档/代码/网页走真实文件、真实 HTTP、真实临时仓库 |
| 词法 BM25 + 精确检索（符号/路径/错误码） | 已实现、已验证 | `lexical.js`、`text.js`；评测 12 条固定查询 Recall@5 1.0 / MRR 0.9167 |
| 真实神经向量检索 | 已实现、已真实调用验收 | 本地真实 `multilingual-e5-base` HTTP 服务（768 维）；21 条中英文开放域查询真实向量召回，overall Recall@5 1.0、cross-lingual Recall@5 1.0；见 §7.1 / §11.1 |
| 持久化向量 + 批量回填 + 增量更新 | 已实现、已验证 | 向量写入 `index.json`；`POST /retrieval/vectors/backfill` 全量补齐；ingest/search/refresh 只嵌入缺失 chunk；`tests/retrieval-embeddings.test.js` |
| 模型/版本/维度隔离 | 已实现、已验证 | 元数据失配时旧向量整批作废并重建，绝不混用；`mergeVectors` + 覆盖测试 |
| RRF 融合、去重、来源/文件多样性 | 已实现、已验证 | `engine.js` + 核心测试 |
| 神经 Reranker | 已实现、已真实调用验收 | 本地真实 `bge-reranker-base` cross-encoder HTTP 服务；候选池扩大后按真实分数重排；失败时回退本地确定性重排并写入 `trace.neuralRerank` / `trace.degraded` |
| 权限/会话/时效/版本/可追溯/注入风险门控 | 已实现、已验证 | 过期、superseded、session scope、缺少 locator、高置信注入内容均被拒绝并写入 trace 原因 |
| 证据包 + 引用 + 独立信号 | 已实现、已验证 | `evidence[].scores` 与 `signals.authority/confidence/freshness/sourceVersion` 分开 |
| 索引生命周期（幂等 upsert / 删除 / 重建 / 一致性 / 损坏隔离） | 已实现、已验证 | 单文件原子索引；损坏文件重命名保留；重启加载用例 |
| Context Engine 外部知识块 | 已实现、已验证 | 记忆/历史原链路不变；仅 document/web/code 进入独立 `knowledge` 块；trace 不含正文 |
| Agent `knowledge_search` | 已实现、已验证 | 只读工具；sessionId 只由运行层注入；工具参数有边界校验 |
| DNS rebinding / SSRF | 已修复、已验证 | 解析后固定 IP 连接；本地重定向/压缩测试 + `example.com` 真实 HTTPS 抓取通过；多地址故障切换未实现 |
| 外部文件删除 / 网页更新 | 已实现、已验证 | `POST /retrieval/sync`；document/code 按 rootHash+relativePath，web 重新提供 URL；删除文件移除派生来源 |
| 索引并发 / 写失败恢复 | 已实现、已验证 | 异步 ingest/sync/rebuild 进程内串行队列；原子写失败不改内存状态、可重试；损坏隔离失败拒绝覆盖 |
| 单用户全局 scope | 已实现、已声明 | `/retrieval/status` 返回 `scope.mode=single_user`；document/web/code 全局，memory/conversation 会话隔离 |
| 只读/受控 HTTP API | 已实现、已验证 | 查询不修改业务源数据（会幂等刷新派生索引）；摄取/删除/重建/回填写索引，全部 Bearer 鉴权 + 全局限流 |
| 固定语料评测 | 已实现、已运行 | `npm run eval:retrieval`：12 查询 Recall@3 1.0、Recall@5 1.0、MRR 0.9167 |
| 真实开放域评测 | 已实现、已运行 | `npm run eval:embedding`：真实 Embedding + 混合召回 + 神经重排；中文/英文/跨语言分组指标见 §11.1 |
| PDF / DOCX 解析 | **未实现（显式拒绝）** | 需要额外解析运行时；接口返回 `unsupported_format`，不伪造成功 |
| Query Rewrite | 未实现（可选能力） | 设计允许后续接入；当前不做成本更高的查询改写 |
| 生产多用户 ACL | 未实现（当前单用户本地部署） | `scope` 字段已建模；document/web/code 为全局来源，memory/conversation 严格按会话 |

> 本版最准确的描述是：**统一检索基础设施、五类来源、真实神经 Embedding、持久化/增量向量、混合召回、真实 cross-encoder Reranker 与可追溯证据包均已落地并在本地真实模型服务上验收；默认部署仍不携带模型服务，未配置时显式降级到词法/精确。**

## 2. 目标与边界

目标：让长期记忆、历史对话、项目文档、网页资料和代码仓库共用同一条检索流水线，并安全接入现有 Context Engine 与 Agent；原始来源仍是 canonical source，索引是可重建的派生数据。

明确不做：
- 不重写 Context Runtime v3、记忆生命周期或 Agent runtime；
- 不把向量库当记忆本体；
- 不把全部内容无差别塞进提示词；
- 不在没有 Provider 时伪造向量结果；
- 不引入外部向量数据库或新运行时依赖（v1 使用嵌入式 JSON + 内存倒排索引）。

## 3. 模块结构

```text
server/retrieval/
  config.js               # 显式 env 配置、上限、冻结
  contract.js             # chunk 契约、稳定 ID、scope、metadata 白名单
  text.js                 # 归一化、CJK/ASCII 分词、精确词、HTML→文本、注入风险
  security.js             # SSRF、DNS/私网校验、允许根目录、限字节读取
  embedding.js            # EmbeddingProvider（OpenAI-compatible，支持 query/document 前缀）
  reranker.js             # 可选神经 Reranker（Cohere/Jina-compatible /rerank）
  lexical.js              # BM25 倒排 + 精确索引（内存派生）
  store.js                # index.json 原子存储、生命周期、向量元数据
  engine.js               # Query Plan → 并行召回 → RRF → 门控 → 证据包 → trace
  index.js                # 门面：同步/摄取/删除/重建/状态/上下文入口
  routes.js               # /retrieval API（读 + 受控写）
  connectors/
    memory.js              # 长期记忆（会话归属）
    conversation.js        # 当前会话历史
    document.js            # Markdown / TXT
    web.js                 # HTTP(S) 抓取 + 正文快照
    code.js                # 只读仓库扫描 + 轻量符号索引
server/context/knowledge.js  # Context Engine 外部知识入口
server/tool-knowledge-search.js # Agent 只读工具
```

## 4. 五类来源

| 来源 | 切片与定位 | 关键元数据 | 可见域 | 当前边界 |
|---|---|---|---|---|
| memory | 单条记忆/段落；`memory/<id>#pN` | memoryId、type、confidence、keywords、validFrom/To | 仅带明确 `contributions[].sessionId` 的会话 | 无会话归属的旧记忆不进入统一索引，仍走原 `memory_search` |
| conversation | 单条消息/长消息分段；`message/<id>#pN` | messageId、role、createdAt、hasImage | 当前会话 | 只索引被检索到的会话，不做全局对话索引 |
| document | 标题层级 + 段落；`相对路径#Lx-Ly` | relativePath、heading、lineStart/End、rootLabel | 全局（本地单用户） | 仅 `.md/.markdown/.txt/.text`；PDF/DOCX 显式拒绝 |
| web | 去标签正文按段落；快照文件 | canonicalUrl、fetchedAt、contentHash、snapshotFile | 全局 | 只抓文本类 content-type；连接使用已校验 IP（DNS rebinding 已消除）；多地址故障切换未实现 |
| code | 文件内按行分块；`相对路径#Lx-Ly` | filePath、language、symbols、commit、branch、dirty | 全局 | 符号为启发式解析，不是完整 AST；跳过二进制/超大/忽略目录 |

网页不是永久事实：证据包单独标注 `freshness` 与抓取时间。代码以 commit/branch 为版本；无 git 的工作区标记为 worktree 版本哈希。

## 5. 数据契约

每个 chunk 至少包含：

- `chunkId`：`chk_` + sha256(`sourceType | sourceId | ruleVersion | contentHash | locator`) 前 32 位；
- `sourceType` / `sourceId` / `content` / `contentHash`；
- `title` / `uri` / `locator`；
- `createdAt` / `updatedAt` / `indexedAt` / `validFrom` / `validTo` / `status`；
- `scope.visibility`（`global` / `session`）与 `scope.sessions`；
- `language` / `mimeType` / `tokenCount` / `sourceVersion`；
- `metadata`：仅允许浅层字符串/数字/布尔/字符串数组，最多 24 个键。

约束：
- 内容变化会产生新 `chunkId`，旧 chunk 由增量 upsert 清理；
- `session` scope 不允许空 sessions；
- 缺少 `uri` 或 `locator` 的条目在 policy 阶段被拒绝（不可追溯）；
- 原始内容仍保存在 memory/sessions/文件/快照/Git，索引可重建。

## 6. 检索流水线

```text
Query Plan（规范化、语言、意图、精确词、来源/时间过滤）
  → Parallel Recall（BM25 / exact / optional vector；检索前按需补齐缺失向量）
  → RRF 融合（k=60，权重 lexical 1 / exact 1.2 / vector 1）
  → 去重（contentHash + 跨来源近重复）
  → Policy Gate（scope / status / validity / locator / injection risk）
  → 本地确定性重排（rrf / lexical / vector / recency / graph）
  → 可选神经 Reranker（Cohere/Jina 兼容 /rerank，作用于扩大后的候选池）
  → Diversity（每来源 6 条、每文件 3 条，可配置）
  → Context Packing（条数 + 近似 token 预算）
  → Evidence Pack + Citations + Trace
```

- 相似度只代表检索相关性；`authority`、`confidence`、`freshness`、`retrievalScore` 分开返回。
- 证据包默认最多 12 条、1600 近似 tokens；Context 注入使用独立上限（4 条 / 900 tokens / 900ms）。
- trace 只记录 query hash、长度、来源、通道状态/耗时、融合/门控/打包计数、索引 generation、embedding 状态与 `neuralRerank` 结果；**不记录 query 原文、chunk 正文、绝对路径**。
- 索引损坏/隔离时返回 `index_unavailable`，不伪装成 `no_result`；向量 Provider 不可用时返回 `vector_unavailable` 降级，不拖垮词法/精确通道。`trace.vectorSync` 记录本次检索前的向量补齐结果，`trace.neuralRerank` 记录神经重排是否真实执行。

## 7. Embedding Provider

接口：`embedQuery(text)`、`embedDocuments(texts)`，返回模型、版本、维度、用量/耗时。

配置（`server/.env`）：

```bash
BLUEBIRD_RETRIEVAL_EMBEDDING_PROVIDER=openai-compatible
BLUEBIRD_RETRIEVAL_EMBEDDING_BASE_URL=https://your-embedding-host/v1
BLUEBIRD_RETRIEVAL_EMBEDDING_MODEL=your-embedding-model
BLUEBIRD_RETRIEVAL_EMBEDDING_DIMENSION=1536
BLUEBIRD_RETRIEVAL_EMBEDDING_API_KEY=...
BLUEBIRD_RETRIEVAL_EMBEDDING_VERSION=v1
```

规则：
- 远端必须 HTTPS；本地 `localhost/127.0.0.1/::1` 允许 HTTP（显式配置）；
- 密钥只从配置读取，不写日志、trace 或索引；
- 查询与文档必须使用兼容的模型/版本/维度；不一致时向量通道 `unavailable`，**绝不混用**不同语义空间；
- 检索型模型（E5 等）的 `query: ` / `passage: ` 前缀由 `BLUEBIRD_RETRIEVAL_EMBEDDING_QUERY_PREFIX` / `..._DOCUMENT_PREFIX` 原样添加，空白有语义；
- 超时、批处理、有限重试、内存缓存（带模型/版本/维度键）；
- 向量持久化在索引文件 `vectors` 中；`POST /retrieval/vectors/backfill` 批量补齐，ingest/search/refresh 自动只嵌入缺失 chunk；
- 模型/版本/维度变化时旧向量整批作废并重建（`mergeVectors` 的 `reset=true`），不静默混用；
- Provider 不可用时自动降级到词法/精确，不使聊天失败。

## 7.1 神经检索（2026-10-31 真实调用验收）

### 模型与端点

本轮验收使用本机真实模型 HTTP 服务，不使用 Mock 向量：

| 角色 | 真实模型 | 维度 | 协议 |
| --- | --- | --- | --- |
| Embedding | `Xenova/multilingual-e5-base`（ONNX） | 768 | OpenAI-compatible `POST /v1/embeddings` |
| Reranker | `BAAI/bge-reranker-base`（ONNX cross-encoder） | — | Cohere/Jina-compatible `POST /v1/rerank` |

模型服务与 `pylibs20`（`onnxruntime==1.20.1`）位于仓库外的临时目录，不提交、不进入运行依赖；仓库只包含客户端、持久化与评测代码。没有使用任何商业 API 密钥；也没有把本地模型文件或密钥写入索引/日志。

### 真实 API 与向量证据

- 回填：16 个 chunk → 16 条向量；维度 768；首条向量 L2 范数 1.0000；
- Embedding 真实调用：38 次请求 / 53 个文本 / 1511 tokens；`model=multilingual-e5-base`；缓存关闭，回填确实发出了新的批量请求；
- Reranker 真实调用：21 次请求 / 336 个候选文档；`model=bge-reranker-base`，最后一次延迟 1627ms；
- 向量通道：21/21 查询成功；`trace.vectorSync` 全部 current；索引元数据 model/version/dimension 与 Provider 一致；
- 增量：新增 1 篇文档后向量 16 → 17，新文档在对应查询 rank 1；第二次回填 `unchanged`，不重复请求；
- 词法兜底对照（`--lexical-only`）：中文/英文 Recall@5 1.0，跨语言 0，overall 0.5714；向量与 reranker 均为 `unavailable`，证明未配置时仍可降级而不是伪造向量结果。

### 开放域召回指标（21 条查询：中文 6 / 英文 6 / 跨语言 9）

| 分组 | Recall@1 | Recall@3 | Recall@5 | MRR |
| --- | --- | --- | --- | --- |
| 中文（6） | 1.0000 | 1.0000 | 1.0000 | 1.0000 |
| 英文（6） | 1.0000 | 1.0000 | 1.0000 | 1.0000 |
| 跨语言（9） | 0.8889 | 1.0000 | 1.0000 | 0.9444 |
| 总体（21） | 0.9524 | 1.0000 | 1.0000 | 0.9762 |

验收门槛：overall Recall@5 ≥ 0.8、cross-lingual Recall@5 ≥ 0.7、向量通道 21/21、神经重排 21/21、真实请求数 > 0、向量元数据 current；本轮全部通过，输出 `EMBEDDING ACCEPTANCE PASSED`。

### 混合检索与重排

流水线：BM25 词法 + 精确符号/路径 + 真实向量召回 → RRF 融合 → 去重 → 策略门 → 本地确定性重排 → 可选神经 Reranker → 多样性与预算打包。

本地确定性重排保留为神经重排不可用/失败时的兜底：

```
score = Σ w_i × signal_i / Σ w_i        （向量不可用时 w_vector 自动剔除并重新归一）
signals: rrf（相对最高分归一）/ lexical / vector 余弦 / recency / graph
默认权重: rrf 0.5, lexical 0.15, vector 0.2, recency 0.1, graph 0.05
```

- **神经 Reranker**：配置后先以 `max(limit, topN)` 扩大候选池，再把候选正文发给 `/rerank`；按真实 `relevance_score` 排序，未返回分数的候选排在已评分候选之后；`trace.neuralRerank` 记录 provider/model/version/candidates/scored/latency/usage；失败时保留确定性顺序并标记 `reranker_failed`，不把失败伪装成成功。
- **时效性**：`recency` 按 `updatedAt` 做半衰期衰减（默认 30 天，下限 0.15，老记忆不直接沉底）；另有硬过滤 `BLUEBIRD_RETRIEVAL_MAX_AGE_DAYS`，只对 `web` 生效。
- **记忆图谱**：候选之间共享 ≥ `GRAPH_MIN_OVERLAP`（默认 2）个 `metadata.keywords` 视为一条边，度数归一后作为 `graph` 信号。

## 8. 存储与生命周期

- 嵌入式单文件 `retrieval/index.json`（`BLUEBIRD_DATA_DIR/retrieval/`），通过 `atomic-write` 原子替换；内存倒排索引从 chunks 重建。
- 默认上限：8000 chunks、500 sources、64 位内容哈希（chunk ID 取其中 32 位十六进制）、64MB 索引文件、2000 条向量、单文件 1MB、网页 2MB、快照总量 64MB。
- 向量存于同一索引文件的 `vectors`（模型/版本/维度元数据 + 圆整到 6 位小数）；属于派生数据，可清空/重建。
- 向量补齐：`mergeVectors` 在同模型/版本/维度下只合并新增/更新向量；元数据不一致时从空向量表开始，旧语义空间整体作废；删除 chunk/source 时同步删除对应向量。
- 生命周期：
  - `upsertSource(s)`：按 chunkId 幂等 diff，只新增/删除变化项；
  - `deleteSource`：先从可检索面移除并原子落盘，再清理网页快照；
  - `rebuild`：重新同步 memory/会话，重建词法索引；配置 Provider 时重建向量；
  - `POST /retrieval/vectors/backfill`：只补齐缺失/失效向量，不重建来源索引，不改变词法索引；返回 `status=ok/unchanged/no_result` 或 `unavailable/disabled/failed`；
  - `POST /retrieval/sync`：刷新外部来源。document/code 按 source metadata 中的 `rootHash + relativePath` 重新读取；文件已删除则移除该派生来源；web 必须重新提供 URL（索引不保存原始查询参数），页面更新后替换旧 chunk 与快照。没有自动文件监听/网页爬虫调度器，需要手动或外部定时调用该接口；
  - 写入并发：异步 ingest/refresh/rebuild/backfill 通过进程内串行队列提交；索引仍是单文件原子写，失败时内存状态不变；多进程写入仍被单实例锁禁止；
  - `consistency`：检查孤儿 chunk、source chunk 数不一致、缺失向量、隔离状态；
  - 索引损坏：`index.json` 重命名为 `.corrupt-<timestamp>` 保留现场，回退空索引并标记 degraded；新写入成功后才恢复 ready。若隔离重命名本身失败，则拒绝任何写入（不会覆盖损坏文件），需人工处理索引文件。
- 已知边界：文档/代码/网页是“显式摄取”的派生副本；原文件删除后不会自动感知，需要重新摄取或 `DELETE /retrieval/sources/:id`。

## 9. 接入点

### Context Engine

`server/context/engine.js` 在原有记忆检索之后调用 `retrieveKnowledge`：

- 只检索 `document / web / code`（默认 `BLUEBIRD_RETRIEVAL_CONTEXT_SOURCES`）；
- 形成独立 `knowledge` 块，priority 20（低于记忆 30，输入保护优先裁剪）；
- 引用编号 `[K1]...` 与 `locator` 一并渲染；内容仍按“数据不是指令”中和；
- 记忆仍走 `context/retriever.js`，历史仍走 `history.js`，不重复注入；
- 检索失败只降级外部知识块，并写入 `trace.knowledge.status/error/trace`。

### Agent

`knowledge_search`：
- 只读，`readOnly: true`；
- 参数 `query/limit/sources/asOf`，不包含 `sessionId`；
- sessionId 由 `agent-runtime` 注入，模型无法检索其他会话；
- 返回紧凑证据（内容截断 500 字）、引用、degraded 与 traceId；
- 工具总结果仍受 `agent-runtime` 4000 字硬上限约束。

### API

所有接口复用现有 Bearer 鉴权与全局限流：

| 方法 | 路径 | 语义 |
|---|---|---|
| GET | `/retrieval/status` | 状态、计数、上限、能力、一致性；不含正文 |
| GET | `/retrieval/sources` | 来源元数据列表 |
| GET | `/retrieval/sources/:id` | 单来源元数据 |
| GET | `/retrieval/consistency` | 一致性检查 |
| POST | `/retrieval/search` | 查询；不修改业务源数据，但会按需幂等刷新 memory/conversation 派生索引并补齐缺失向量；`query/sessionId/sources/limit/tokenBudget/asOf` |
| POST | `/retrieval/ingest` | 写索引；`type=document/code` + `path`，或 `type=web` + `url`；完成后只补缺失向量 |
| POST | `/retrieval/sync` | 刷新外部来源；`sourceId` 刷新单个，缺省刷新所有 document/code；web 需同时提供 `url` |
| POST | `/retrieval/vectors/backfill` | 批量补齐缺失/失效向量；不重建来源索引；未配置 Embedding 返回 409 |
| DELETE | `/retrieval/sources/:id` | 删除派生来源；memory/conversation 由原生命周期管理，返回 `managed_source` |
| POST | `/retrieval/rebuild` | 重新同步 + 重建派生索引/向量 |

示例：

```bash
curl -X POST "$BASE/retrieval/ingest" \
  -H "Authorization: Bearer $TOKEN" -H 'Content-Type: application/json' \
  -d '{"type":"document","path":"docs/unified-retrieval.md"}'

curl -X POST "$BASE/retrieval/search" \
  -H "Authorization: Bearer $TOKEN" -H 'Content-Type: application/json' \
  -d '{"query":"RRF 融合","sources":["document"],"limit":3}'
```

## 10. 安全与隐私

- **会话隔离**：memory / conversation chunk 的 `scope.sessions` 精确匹配 `sessionId`；未知 session 的记忆检索直接 400；已删除会话的派生对话索引在同步时清理。
- **单用户全局 scope**：document/web/code 的 chunk 为 `global`，任何持有 Bearer token 的客户端都可检索；这是当前单用户本地部署的明确边界，不是多用户 ACL。多用户部署必须先增加用户/文档 ACL 与鉴权模型。
- **DNS rebinding**：`resolveTarget` 先解析并校验全部地址，再把地址固定给 `http(s).request` 的 lookup；连接阶段不重新解析，重定向逐跳重新校验。仍只使用首个已校验地址，多地址故障切换/HTTP 代理未实现。
- **文件边界**：仅允许 `BLUEBIRD_RETRIEVAL_ROOTS` 内的真实路径；拒绝符号链接逃逸、路径穿越、非文本文件。
- **网页 SSRF**：拒绝环回/私网/链路本地/云元数据地址、带账号密码 URL、非 http(s)；每次重定向重新校验；读取字节上限。`BLUEBIRD_RETRIEVAL_ALLOW_PRIVATE_URL=1` 只用于本地 fixture。
- **注入内容**：检索时检测“忽略之前指令/系统提示/角色覆盖”等模式，高置信内容不进入证据包，trace 记录 `prompt_injection_risk`。
- **日志/trace**：不记录 query 原文、chunk 正文、记忆内容、网页正文、工具参数；摄取错误只回受控短码。
- **at-rest**：索引包含规范化正文副本（词法检索需要），位于数据目录；它不能替代 canonical source，删除来源会删除派生 chunk 与网页快照。
- **本地单用户限制**：document/web/code 无多用户 ACL；若未来多用户部署，必须增加真实 ACL 并重新评估。

## 11. 测试与评测证据

| 命令 | 实际结果 |
|---|---|
| `node tests/retrieval.test.js` | 30/30 |
| `node tests/retrieval-api.test.js` | 11/11（含向量回填 401/409） |
| `node tests/retrieval-embeddings.test.js` | 8/8（元数据隔离、批量回填、增量、reranker 契约/回退、引擎顺序） |
| `node tests/embedding-open-domain-eval.js`（真实服务） | 21 查询；overall Recall@5 1.0、跨语言 Recall@5 1.0；`EMBEDDING ACCEPTANCE PASSED` |
| `npm test` | 45 个后端测试文件 / 1540 项全部通过 |
| `node scripts/verify-test-coverage.js` | backend 1540/1540；nodeSuite 221/221；runner 1319/1319；frontend 162/162；CI 45/45 |
| `npx tsc --noEmit` | 通过（0 错误） |
| `npm run lint` | 通过（0 错误） |

固定语料评测只证明该集合上的词法/精确排序契约；真实开放域结论以上表中 `embedding-open-domain-eval` 的真实模型调用为准，且该评测依赖部署方提供真实 Embedding / Reranker 服务，不在 CI 中伪造运行。

## 11.1 本轮针对性验收实测（2026-10-31）

| 项目 | 实测结果 | 边界 |
|---|---|---|
| 真实 Embedding | 本地 `multilingual-e5-base` ONNX HTTP 服务，768 维；38 次请求 / 53 个文本 / 1511 tokens | 真实模型、真实 HTTP、真实向量；未使用商业 API，也未提交模型文件 |
| 真实 Reranker | 本地 `bge-reranker-base` cross-encoder HTTP 服务；21 次请求 / 336 文档；末次延迟 1627ms | 真实 cross-encoder 重排；失败自动回退确定性重排 |
| 持久化向量 + 回填 | 16 chunks → 16 向量；维度 768；L2 范数 1.0000；`backfill` 一次补齐，第二次 `unchanged` 且不重复请求 | 向量存于 `index.json`，可清空/重建；上限 2000 条 |
| 增量更新 | 新增 1 篇文档后 16 → 17 条向量；只嵌入 1 个缺失 chunk；新文档对应查询 rank 1 | 不重复嵌入旧 chunk；删除来源同步删向量 |
| 模型/版本/维度隔离 | 元数据失配时 `mergeVectors` 返回 `reset=true`，旧向量整批作废；`vectorCoverage.current=false`；回填后恢复 current | 不混用不同语义空间；旧向量不参与余弦检索 |
| 开放域召回 | 中文 R@1/3/5 1.0；英文 1.0；跨语言 R@1 0.8889、R@3/5 1.0；总体 R@1 0.9524、R@5 1.0、MRR 0.9762 | 21 条固定查询，非真实用户语料；结论限定于该评测集 |
| 词法兜底 | `--lexical-only`：中文/英文 R@5 1.0；跨语言 0；overall 0.5714；向量/reranker 均 `unavailable` | 证明未配置时显式降级，不伪造向量能力 |
| 全量回归 | `npm test` 45 文件 / 1540 项；coverage backend 1540/1540、runner 1319/1319、frontend 162/162；tsc 0；lint 0 | 新增 8 项向量/重排测试与 1 项 API 回填测试 |

## 12. 已知限制与后续

1. **生产外部 Embedding 未验收**：本轮用本地真实模型 HTTP 服务完成真实调用与开放域评测；商业供应商的账号、网络、限流、价格与生产语料仍需部署方自行配置并验收。默认部署不携带模型服务，未配置时显式 `unavailable`。
2. **PDF/DOCX 未支持**：需要新增解析运行时（依赖/授权/资源评估），当前显式拒绝。
3. **Query Rewrite 未启用**：先建立基准评测，再决定是否引入成本更高的模型；Reranker 已作为可选能力接入并有真实调用证据。
4. **代码解析为启发式**：符号覆盖 JS/TS/Python/Go/Rust/Java 等常见模式，不是完整语言服务器。
5. **来源感知有限**：外部文件删除/网页更新不会自动监听；已提供显式 `POST /retrieval/sync`（document/code 按 rootHash+relativePath，web 需重新提供 URL），自动 watcher/爬虫未实现。
6. **SSRF 多地址/代理边界**：DNS rebinding 已通过固定 IP 连接消除；但只取首个已校验地址，连接失败不会自动切换其他地址，也不支持 HTTP 代理。
7. **无外部向量数据库**：嵌入式 JSON 适合当前单用户规模；多实例/大规模需要存储适配器升级（接口已按 `upsert/delete/search/filter/status/rebuild` 分层）。
8. **索引 at-rest 正文副本**：未来可考虑加密或只存引用 + 受控读取，以降低数据面暴露。
9. **外部同步不是自动监听**：文件删除/网页更新依赖显式 `POST /retrieval/sync` 或外部调度；没有文件系统 watcher 或网页爬虫。
10. **多用户 ACL 未实现**：当前 document/web/code 全局可检索；多用户部署前必须补 ACL。

## 12.1 能力分类（按必要性，不把全部当上线阻塞）

| 能力 | 分类 | 理由 / 当前行为 |
|---|---|---|
| PDF/DOCX 解析 | 格式覆盖缺口，非通用上线阻塞 | 当前 Markdown/TXT/代码/网页已可用；PDF/DOCX 显式 `unsupported_format`。只有用户必须导入这些格式时才成为阻塞。 |
| Reranker | 已实现，可选质量优化 | 真实 cross-encoder 已接入；未配置/失败时回退确定性重排，不影响词法/精确可用性。 |
| Query Rewrite | 质量优化，非阻塞 | 查询改写会增加模型调用与不确定性；当前不做。 |
| 完整 AST/语言服务器 | 代码检索质量优化，非阻塞 | 当前文件/行号/符号/路径精确索引可用；完整 AST 提升符号精度，不影响索引生命周期或安全。 |
| 真实神经 Embedding / 开放域语义 | 已实现并用本地真实模型验收；生产外部服务仍需部署方验收 | 本地真实模型上开放域与跨语言 Recall@5 均 1.0；默认无 Provider 时仍显式降级，商业供应商/生产语料不在本轮证据内。 |
| 自动文件/网页同步 | 运维便利性，非阻塞 | 已提供显式 sync API；自动 watcher/爬虫是后续增强。 |
| 多用户 ACL | 多用户部署阻塞项 | 当前单用户本地部署可上线；多用户前必须实现。 |

## 13. 交付边界

- 独立分支与 PR 交付；未经授权不合并。
- 所有“已实现/已验证/未验证/阻塞”均以上表为准；真实神经语义只引用本轮本地真实模型评测，未把商业生产端点或 PDF/DOCX 解析写成已完成。
