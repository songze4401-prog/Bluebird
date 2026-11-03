# Context Runtime v3 — 唯一有效规则清单

> 版本：`v3.0`（`server/context/config.json` 的 `schemaVersion` 必须一致）。
> 本文件是上下文链路的唯一裁决依据；代码、测试与文档冲突时以本文件为准。
> v2.3 的软目标 / 按类型单条配额 / 固定保底预算已删除，不再作为实现依据。

## 1. 目标与原则

- 一条真实调用链：会话历史 → 近期原文 → 长程召回 → 抽取式摘要 → 记忆检索与裁决
  → 安全渲染 → 输入保护 → 真实模型请求 → 工具循环 → 回答 → 写入 trace。
- 能力优先于架构形式：没有真实消费者的检索源、开关、预算字段一律不保留。
- 调度优先于全量：每轮先判断意图与所需层，再决定检索量、预算与无答案阈值；
  无法判断时退回 general 全量计划。
- 证据优先于声称：trace 必须区分候选、选中、接受、注入、发送；未验证项显式标注。
- 数据安全与可靠性优先：不静默截断当前任务、工具结构、消息角色或多模态数据。

## 2. 单一链路（无兼容双路径）

`server/index.js` 的 `/chat` 与 `/chat/stream` 都调用
`runContextRuntime()`（`server/context/engine.js`）。不再存在
`BLUEBIRD_CONTEXT_ENGINE` 开关，也不再存在“开关关闭时只取最近 20 条”的另一套策略。
外部仍设置该环境变量时，代码不读取它。

Agent 工具循环在上下文组装之后运行：工具调用与工具结果由
`server/agent-runtime.js` 在**本次请求内**追加到真实消息数组，下一轮模型调用可见；
它们不伪装成检索条目，也不写入 sessions.json。

### 2.1 P3 调度计划

`server/context/orchestrator.js` 在历史/记忆/知识检索前生成只读计划：

- 意图：`chitchat` / `memory_query` / `fact_query` / `project_work` /
  `planning` / `execution` / `review` / `general`；
- 层开关：`history` / `summary` / `memory` / `knowledge`；
- 记忆类型过滤、知识来源、每层预算与 `noAnswerThreshold`；
- 计划写入 `trace.orchestration`，只含意图、层、预算与短码，不含任务正文。

`BLUEBIRD_CONTEXT_ORCHESTRATOR=0` 时退回 general 全量计划（回滚开关），
不是第二套上下文链路。chitchat 关闭记忆/知识与摘要；memory_query 关闭知识；
project/execution 选择 fact/goal/identity/preference 与 document/code；
review 使用 episodic only；fact_query 使用 document/web 且无答案阈值 0.08。

## 3. 消息与数据契约（projection v3）

`server/context/projection.js` 是存储消息 → 上下文消息的唯一投影：

```text
{
  projectionVersion: 3,
  index, id, sessionId, role, content, createdAt,
  attachments: [{ id, kind, mime?, name? }],
  hasImage,
  toolSteps: [{ name, ok, code?, summary?, durationMs? }],
  contentKind: 'text' | 'attachment_only' | 'empty',
  unsupported: string[]
}
```

- 只接受 `user` / `assistant`；其他角色丢弃。
- `content` 不是字符串时保留空串并标记 `unsupported: ['content_not_string']`，
  不静默当成正常空消息。存储层不应出现该形态。
- 附件只保留元数据；无 `id` 的附件无法读取文件，显式丢弃并标记
  `attachment_without_id`。
- `toolSteps` 是落盘展示字段，不是模型 `tool_calls` 协议；它随投影保留，
  **不进入提示词**。请求内的工具协议由 agent-runtime 维护。
- 模型消息由 `toModelMessages()` 从投影生成：用户图片转 `text + image_url`，
  助手图片/表情包降级为文本占位，`includeImages=false` 时用户图片也降级；
  读取失败退化为纯文本，不让整轮请求崩掉。
- 模型消息用 `Symbol` 附带上下文 ID，`JSON.stringify` 不会把它发给提供方；
  `sent` trace 因此能对应真实发出的消息。

## 4. 历史选择（不再固定 20 条）

`server/context/history.js`：

- **近期原文**：从最新消息向前装，直到 `history.recentBudgetTokens`；
  至少保留 `history.minRecentMessages` 条完整消息。选择单位是完整模型消息，
  不静默截断单条消息。短消息可以超过 20 条。
- **长程召回**：近期窗口之外的旧消息按当前任务做词面/实体匹配，
  回指词（之前/刚才/上次/我说过/继续…）给旧消息补偿；命中者以原文摘录
  进入独立上下文块。助手消息被召回时，配对召回其前一条用户消息。
- **摘要输入**：近期与召回之外的旧消息交给摘要模块。
- 含图片的旧消息被召回时只保留文字，并在摘录中明确标注
  “原消息含图片；摘录只保留文字，不重放图片”；近期消息仍走完整模型消息契约。
- 空模型消息（无正文、无附件）显式 `omitted`，不占预算。

## 5. 历史摘要（抽取式）

`server/context/summary.js`：

- 只引用原始消息中的原话片段，不生成、不改写、不推断；摘要失败不会删除原始历史。
- 覆盖六类：用户偏好与约束、重要决策、未完成任务、时间敏感信息、
  待确认假设、已确认陈述。
- 每节只取最新 `history.summaryMaxItemsPerSection` 条；总预算
  `history.summaryBudgetTokens`。
- 每条摘要带 `S1…Sn` 引用；trace 的 `history.summary.sources` 记录
  `ref → messageId / role / section / createdAt`，不记录正文。
- 同一主题出现不同数值/否定时保留所有记录并标记 `conflicts`，
  渲染提示“保留原始时间，不静默覆盖”。

## 6. 记忆检索、覆盖去重与冲突

`server/context/retriever.js` 的唯一真实源是 `searchMemories()`
（会话隔离、预算由配置传入）。旧 `user/doc/web/tool` 检索源已删除：
user 历史走第 4 节；doc/web 没有真实读取器；工具结果由 Agent 循环直接回传。

P3 计划可进一步传入 `filters.types` / `filters.categories` / `episodicOnly`
与 `noAnswerThreshold`。记忆层关闭时返回 `skipped`（`memoryState=empty`）；
记忆源本身被禁用时优先返回 `source_unavailable`，不把“禁用”伪装成“意图不需要”。
低于阈值的候选保留在检索 trace 的 `returned`，但不进入 `accepted`/注入。

`server/context/coverage.js` + `builder.js`：

- 检索条目与近期原文、召回原文、摘要做词面覆盖比较。
- 覆盖达到 `retrieval.coverageSkipThreshold` → 跳过并记录
  `covered_by_context`（附带 `against` 标识）。
- 覆盖在 `coveragePartialThreshold` 与跳过阈值之间 → 保留，标记
  `partial_supplement`，不因部分重复而清空。
- 未覆盖 → 正常进入。
- 同一来源高度重复的条目按 `pairwiseDedupeThreshold` 只保留高分项。
- 旧记忆与更新的用户陈述冲突（同主题不同数值/否定）时，
  以更新的用户历史为准，记忆跳过并记录 `conflict_newer_user_history`；
  trace 同时记录冲突原因与 `against` 消息标识。
- 禁止使用 `fromHistory` 这类单一标记一刀切过滤检索结果。

## 7. TTL 与时效

| 状态 | 行为 |
| --- | --- |
| `fresh` | 正常进入 |
| `unknown`（无 TTL/无时间戳） | 进入并标注“时效未知”，与 stale 分开统计 |
| `stale` | 进入并标注“可能过时” |
| `expired` 实时数据 | 排除，记录 `expired_realtime_refetch` |

按类型配置（`ttl`）：`realtime_data` 30s / refetch / TTL 必填；
`user_preference` 30d / revalidate；`project_fact` 7d / revalidate。两者过期都保留注入并标记待验证，与 `memory_search` 仍可检索到一致，不静默丢弃。
禁止 `on_expire: ignore`。

## 8. 输入保护（唯一的“预算”层）

`server/context/input-guard.js` 是最终请求预算的唯一裁决层，只保证请求适配
模型输入能力，不按来源类别配额决定信息价值。P3 调度器在此之前设置每层
**上限**（记忆条数/总量、知识条数/token、历史/summary 预算），
最终仍由 input-guard 统一裁剪。

- 窗口来源：模型声明 `contextWindow` 时用声明值（`windowSource=declared`，
  `verified=true`）；未声明时使用 `inputGuard.unknownWindowGuardTokens`
  作为**本地保守护栏**（`windowSource=unknown_guard`，`verified=false`），
  不声称它是模型真实窗口。
- Token 计量：统一 `heuristic-cjk-ascii-v1`（CJK 1 / ASCII 0.25 / 其他 Unicode 0.5），
  按 `inputGuard.estimatorSafetyFactor` 保守放大；误差范围写入 trace。
  图片按 `perImageTokens` 计，绝不按 dataURL 字符数计。
- 预留：输出 `outputReserveTokens` + 工具循环预留 + `safetyMarginTokens`；
  Agent 工具预留 = 工具 schema 实测 + 每轮结果上界 × 额外轮数。
- 超限降级顺序（每一步写入 `trace.build.dropped`）：
  1) 低优先级上下文块（记忆 → 召回 → 摘要 → 表情/情绪/人格等非关键系统块）；
  2) 较早历史消息（保留最近 `minHistoryMessages` 条完整消息）；
  3) 仍超限 → 显式 `context_too_large`（HTTP 413），绝不静默截断当前任务或核心规则。
- 核心系统块（`critical: true`）永不裁剪。

## 9. Trace：阶段、标识与隐私

`server/context/trace.js`：

- 阶段：`candidate → selected → accepted → injected → sent`；
  `consumed` 固定为 `null` 并注明“HTTP 成功不等于模型已消费”，不伪造消费证据。
- `trace.orchestration` 记录 P3 意图、层开关、类型/来源过滤、预算、无答案阈值
  与短码；不记录任务正文。层关闭时 retrieval 状态为 `skipped`；
  低于阈值的候选计入 `returned` 但不计入 `accepted`。
- 历史决策记录 `messageId / index / stage / reason / score`；
  摘要只记录 `ref / messageId / role / section / createdAt`；
  记忆只记录 `id / source / stage / reason / against / score`。
- `recordSent()` 必须在真正调用提供方之前，用**同一条消息数组**调用；
  记录 `round / roles / messageIds / contextIds / systemLength / 模型标识`。
  Agent 每一轮都记录；工具消息用 `tool:<callId>` 标识。
- `recordProviderUsage()` 只记录 Provider 返回的真实 usage；`usageSource`
  区分 `provider` / `stub` / `missing`，`calibration` 仅对真实 Provider 为 true。
  流式 usage 依赖供应商末帧，缺失时记 `missing`，不猜数字。
- 隐私红线：不记录用户任务原文、历史正文、记忆正文、摘要正文、
  工具参数或工具结果正文；策略理由也会做敏感词兜底打码。
- 验证检查（`verifyContext`）：无过期实时数据进入、近期/召回不重复、
  注入上下文 ID 属于构建块、摘要来源可追溯、注入标识数等于真实请求消息数。

## 10. 失败、重试与熔断

| 类型 | 含义 | 处理 |
| --- | --- | --- |
| `no_result` | 检索成功但无内容 | 正常空，不视为错误 |
| `retrieval_error` | 检索本身失败 | 记录错误，聊天继续（仅缺记忆） |
| `source_unavailable` | 记忆源未启用 | 记录状态，不伪装成无结果 |
| `skipped` | 当前意图不需要该层 | `memoryState=empty`，不伪造检索失败 |
| `context_too_large` | 当前任务/核心规则本身超限 | 显式 413，不静默截断 |

- 自动重试仅限只读/幂等源，最多一次（`retry.maxRetries=1`）。
- 熔断按 `data_source` 粒度：记忆源连续 `failureThreshold` 次失败后
  熔断 `windowMs`，只影响记忆，不影响聊天。
- 摘要失败非致命：保留近期/召回原文，trace 记录 warning；
  检索失败非致命：历史/摘要仍可用。

## 11. 配置（`config.json` / `config.js`）

严格模式：未知字段拒绝、类型/范围校验、冷加载、深冻结。

| 节 | 关键字段 |
| --- | --- |
| `schemaVersion` | 必须 `v3.0` |
| `ttl` | 三个类型的 TTL 与 on_expire |
| `history` | `recentBudgetTokens` / `minRecentMessages` / 长程召回预算与阈值 / 摘要预算 |
| `retrieval` | 记忆条数/单条/总量、覆盖阈值、来源内去重阈值 |
| `inputGuard` | 输出预留、安全边界、估算放大、未知窗口护栏、图片 token、工具轮预留 |
| `retry` | `maxRetries` ≤ 1 |
| `circuitBreaker` | 失败阈值与窗口 |

P3 调度器的层预算由 `server/context/orchestrator.js` 生成，配置值仍是上限；
`BLUEBIRD_CONTEXT_ORCHESTRATOR=1` 默认开启，`0` 回滚到 general 全量计划。
修改 `.env` 后需重启后端。

删除的旧字段：`budget.softTarget / hardCap / guaranteedSystem / guaranteedTask /
perTypeMax`、`routing`、`metrics`、`verificationOrder`、`sourceOrder`。
它们没有真实消费者，保留只会制造“看起来有策略”的假象。

## 12. 模块边界

- `projection.js` — 存储消息 → 上下文消息 / 模型消息契约。
- `history.js` — 近期原文、长程召回、摘要输入选择。
- `summary.js` — 抽取式摘要与来源引用、冲突保留。
- `retriever.js` — 记忆检索、TTL、失败分类、按源熔断。
- `coverage.js` — 覆盖判定、来源内去重、记忆 vs 用户历史冲突。
- `builder.js` — TTL 策略、记忆裁决、安全渲染、上下文块优先级。
- `input-guard.js` — 最终请求计量、窗口来源、确定性降级。
- `trace.js` — 阶段化结构化 trace 与隐私过滤。
- `engine.js` — 单一编排入口 `runContextRuntime()`。
- `orchestrator.js` — P3 意图分类、层/预算/阈值计划与配置覆盖（纯函数）。
- `config.js` / `config.json` — 唯一配置加载器与策略值。

## 13. 已知限制 / 待验证项（不得淡化）

1. **模型真实窗口部分未声明**：内置 `deepseek-flash` 的 `contextWindow=1048576` 来自 provider `GET /models` 的真实元数据；`deepseek-chat` 不在该列表，未声明；
   `unknown_guard` 是本地护栏，不是模型能力声明。真实窗口/Tokenizer
   仍是未验证项；获取提供方计量后再替换护栏。
2. **Tokenizer 未校准**：`heuristic-cjk-ascii-v1` 是保守估算，不是分词器；
   trace 明确记录估算方法与放大系数。
3. **摘要是抽取式**：不生成语义摘要，不覆盖未被抽取到的原文；
   但它不虚构、可追溯、失败不删除原文。生成式摘要需要模型调用，
   属于后续独立能力，不在本版伪装实现。
4. **doc / web 外部资料未实现**：没有真实读取器/凭据，相关检索源已删除；
   不得用空壳模块声称支持外部资料。
5. **真实视觉能力有模型波动**：最终评测使用 256×256 纯红 PNG，连续两次 9/9 通过；
   `deepseek-flash` 的 provider 元数据声明 `input_modalities=[text,image]`。
   更早的 64×64 小图曾出现一次“白色”误答。链路抓包证明发往提供方的图片字节与上传文件完全一致，
   因此上下文侧无丢失；模型侧仍有非确定性，结论记录全部运行而不是只保留通过的一次。
6. **存储保留上限为 1000 条/会话**：长程召回在已存储历史内有效；
   超过 1000 条的更早消息不可找回。`/history` 单页最多 200 条，客户端用
   `before` 游标向前翻页；达到上限裁剪旧消息时会回收无引用的上传文件。
7. **默认会话的客户端历史回退最多 20 条**（前端 `HISTORY_CONTEXT_LIMIT`）：
   仅在服务端默认会话为空时生效，此时无法做 20 条以外的长程召回。
8. **真实模型窗口未声明时，输入保护是保守上界**：不会因超限静默截断，
   但可能比模型实际能力更早触发降级/413。
9. **P3 意图分类是规则匹配，不是学习模型**：`chitchat`/`memory_query` 等
   由关键词与问题形态判定；计划预算是静态上限，不随流量自适应。
   `tests/context-orchestrator-p3.test.js` 的 Recall/Precision 对比是固定小样本，
   不是生产流量或统计显著性的证明。
10. **P4 真实端到端已用真实 DeepSeek 验证（2026-11-03）**：
    `scripts/p4-real-e2e.js` 经真实 HTTP 入口 `/chat` 与 `/chat/stream`、
    真实 Context Runtime、真实内置 DeepSeek 完成调用，不使用 openai 桩或本地假
    Provider。真实模型发起 `memory_search`，工具结果按 `tool_call_id` 回传下一轮；
    trace 每轮 `contentHash` 与实际交给适配层的 messages 一致（2/2），
    真实 usage 写入 `sent.usage`（`prompt_tokens=3310`；同日 4 次运行均 30/30）。
    该脚本不在 CI；缺 `BLUEBIRD_P4_REAL=1` 或真实 key 时退出 2 并输出
    `NOT VERIFIED`。不证明模型在语义上消费了记忆，也不保证流式末帧 usage。
11. **真实 usage 与本地估算不是同一口径**：工具轮
    `prompt_tokens=3310` 对 trace `estimatedTokens≈2169`（比值 1.526），
    但该轮请求包含工具 schema，输入保护用 `toolsReserveTokens` 单独预留，
    不能把比值直接当成 tokenizer 误差；非工具轮的 P3 实测比值为 0.5152。
    Tokenizer 仍未按目标模型校准，单样本不足以修改全局估算系数。
