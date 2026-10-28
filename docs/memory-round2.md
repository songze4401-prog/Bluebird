# Bluebird 第二轮：记忆写入决策引擎与生命周期管理

基线：`0511e13`（第一轮启动竞态修复已提交并推送）。本文件记录阶段 A 的架构映射、阶段 B–D 的实现契约，以及阶段 E 的验收证据与剩余风险。
本轮补充（2026-10-28）：在 `e78006e` 基线上追加记忆检索过滤/评分/预算能力、Agent 开关文档与 CI 覆盖守卫；以下第 4、6、7 节同步更新，历史基线保留用于追溯。

## 1. 模块边界

| 模块 | 职责 |
|---|---|
| `server/memory-decision.js` | 纯决策规则：临时状态、置信度、重复/冲突、显式目标、待确认 |
| `server/memory-lifecycle.js` | 状态常量、允许转换、有效时间窗口、历史可见性 |
| `server/memory.js` | 唯一候选写入服务：归一化、授权/来源校验、决策执行、原子落盘、生命周期操作 |
| `server/tool-memory-remember.js` | Agent 候选提交工具；只调用 `applyCandidate`，不直接写文件 |
| `server/tool-memory-search.js` | 只读检索；支持 `current` 与显式 `history/asOf` |
| `server/agent-runtime.js` | 工具注册、参数校验、超时/去重/错误隔离；传递用户原话与来源上下文 |
| `server/index.js` | HTTP 契约与真实 Agent 调用接线；不承载决策规则 |

## 2. 决策表

候选统一入口：`memory.applyCandidate(raw, options)`。自动提取 `processMemory` 也只调用该入口。

| 决策 | 触发条件 | 执行结果 |
|---|---|---|
| `create` | 没有同事实重复或同会话可裁决冲突 | 新 `active` 条目，来源贡献带 `sourceType`/`messageId` |
| `merge` | 相似度 ≥ 0.8，且事件时间/条件不冲突 | 保留 id/createdAt/validFrom，追加贡献 |
| `update` | 显式 `targetId`，目标对当前会话可见且有效 | 保留 id，更新内容/类型/关键词/置信度，追加贡献 |
| `supersede` | 相似度 [0.3, 0.8)、同类型、共享关键词，且有且仅有一个对当前会话可见的冲突 | 旧条目 `superseded` + `validTo` + `supersededBy`；新条目 `active` |
| `reject` | 无内容/超长/类型非法/敏感/置信度不足/临时状态/来源不接地/目标非法 | 不写库，返回稳定原因短码 |
| `needs_confirmation` | Agent 低置信（0.6–0.85）、多个可见重复或冲突、显式待确认 | `pending` 条目；默认检索/注入不可见，需确认或拒绝 |

补充规则：

- 临时状态：心情/情绪词，或 `identity/preference/relationship` 带今天/明天/临时/短期等标记 → `temporary_state` 拒绝；显式 `validTo` 的事件不按此拒绝。
- 事件时间/适用条件：候选与旧条目都有 `eventAt` 且不同，或都有 `condition` 且不同 → 不合并、不取代，创建独立事实。
- 来源：自动提取 `sourceType=user`；Agent 候选 `sourceType=agent` 且 `sourceQuote` 必须逐字出现在当前用户消息；`model/tool` 来源不得直接写入。
- 会话：冲突只能在当前会话可见的条目中裁决；跨会话私有目标拒绝 `unauthorized_target`。

## 3. 生命周期

| 状态 | 持久化 | 默认检索/注入 | 进入方式 | 离开方式 |
|---|---|---|---|---|
| `active` | 是 | 是（且 `validFrom ≤ now < validTo`） | create/merge/update/confirm | supersede/archive/delete |
| `pending` | 是 | 否 | needs_confirmation | confirm → active；reject → 物理删除 |
| `superseded` | 是 | 否；历史 `asOf` 可读 | supersede | archive/delete |
| `archived` | 是 | 否；历史 `asOf` 可读 | archive | delete |
| `retracted` | 否 | — | 来源贡献撤回；贡献为空时条目物理删除 | 操作结果 |
| `deleted` | 否 | — | `/memory/delete`、拒绝 pending、清空 | 物理删除 |

允许转换由 `memory-lifecycle.js` 的 `TRANSITIONS`/`canTransition` 定义；`pending → active/deleted`、`active → superseded/archived/deleted`、`superseded → archived/deleted`、`archived → deleted`。

## 4. 接口契约

### Agent 工具 `memory_remember`

输入：`content`、`type`、`sourceQuote`、`keywords`、`confidence`、可选 `targetId`/`validFrom`/`validTo`/`eventAt`/`condition`。
返回：`ok`、`decision`、`entryId`/`targetId`/`supersededId`、`status`、`durable`、`pending`（待确认时）、稳定 `reason`（拒绝时）。不返回记忆正文。

### HTTP 新增（不改既有契约）

- `GET /memory/pending`
- `POST /memory/confirm { id }`
- `POST /memory/reject { id }`
- `POST /memory/archive { id }`

既有 `/memory/delete`、`/memory/clear-session`、会话删除、`/history/recall` 的既有请求/响应语义保持不变；`/history/recall` 额外把消息 id 传给记忆服务，贡献带 `messageId` 时按来源消息精确撤回。

### 检索

`searchMemories({ query, sessionId, mode: 'current' | 'history', asOf, filters, limits })`；历史模式必须提供合法 `asOf`。当前模式只返回有效 `active` 条目；历史模式可返回当时有效的 `active/superseded/archived`，永不返回 `pending`。

- `filters.sources`：`user`/`agent`/`tool`/`model`/`import`；条目贡献里没有 `sourceType` 时不算匹配。
- `filters.statuses`：`active`/`superseded`/`archived`；`pending` 不是可检索事实。
- `filters.timeFrom`/`timeTo`/`timeField`：`valid`（默认，按有效期区间相交）/`created`/`updated`；缺失该字段的条目不匹配。
- 维度之间 AND，维度内 OR；过滤与排序先于条数/长度/字符/token 截断。
- `limits`：`maxItems`、`perItemMax`（码点）、`totalMax`（码点）、`maxTokens`（近似 token）。
- 返回 `results` 与 `diagnostics`：命中理由、分项评分、来源类型、ID、`contentTruncated`、排除计数、`limitTruncated`/`budgetTruncated`、`notReturned` 原因。
- `bigramScore` 是字符二元组重合的词面分；概念语义分来自 `server/memory-semantic.js` 的本地词典（同义/上下位/中英跨语言），按词面 0.7 + 语义 0.3 混合。标记为 `semanticKind: 'concept_lexicon_v1'`、`neural:false`、`limited:true`；仓库没有本地 embedding 模型，不宣称向量语义检索。开放域语义仍是阻塞项，见 `docs/memory-semantic.md`。
- 小记忆库不再全量注入；`identity` 由类型保底规则保留，其余条目仍须命中查询。

## 5. 数据兼容与迁移

- 新字段均为可选：`sourceType`/`messageId`（贡献）、`eventAt`/`condition`/`pendingReason`/`pendingTargetId`/`lastDecision`。
- `active/superseded` 旧数据无需改写；pending/archived 由新操作产生。
- 未新增 schemaVersion，也未在模块导入时执行写操作型迁移；仍由 `loadMemories()` 纯 hydrate 读取旧数据，首次真实写入时才落盘。
- 旧贡献对象形状保持 `{sessionId, sourceQuote, createdAt}`；只有新贡献附加可选字段，避免改写历史对象。

## 6. 验收测试

| 命令 | 结果 |
|---|---|
| `node tests/memory-lifecycle-decisions.test.js` | 16/16 |
| `node tests/memory-agent-write.test.js` | 8/8 |
| `node tests/memory-retrieval.test.js` | 47/47（过滤、排序、预算、可解释元数据、工具校验） |
| `node tests/memory-semantic.test.js` | 54/54（同义/跨语言/混合排序/语义预算） |
| `node tests/memory-semantic-eval.js --assert` | 22 查询固定集：Recall@5 0.9722 / Recall@10 1.0 / MRR 1.0 |
| `node tests/agent-tools.test.js` | 119/119（原有检索链路+新工具白名单） |
| `npm test` | 39 个测试文件全部通过 |
| `npm run test:unit` | 106/106 |
| `npx tsc --noEmit -p tsconfig.json` | 通过 |
| `npm run lint` | 通过 |

覆盖：六类决策、临时状态、不同事件时间不合并、pending 确认/拒绝、归档、过期、历史查询、messageId 精确撤回、跨会话目标拒绝、Agent 真实 `/chat` 调用、来源不接地拒绝、重复提交不重复创建、HTTP 生命周期接口、既有记忆/会话/上下文回归。

## 7. 已知风险与未验证项

- 置信度是模型自报，不是事实真值；低置信只控制写入/待确认，不替代来源证据。
- 自动提取没有事件发生时间/适用条件字段，只有 Agent 候选可显式提供；自动路径的“不同时间/条件”判断能力弱于受控接口。
- 跨会话同内容重述仍按“同一事实多来源”合并贡献（保留既有共享语义）；跨会话冲突/更正不会跨私有权重裁。
- 检索的“语义”部分是本地概念词典（`concept_lexicon_v1`），覆盖词典内的同义/上下位/中英跨语言；它不是神经 embedding，词典未覆盖的同义、开放域语义与上下文消歧仍未完成。
- token 预算是启发式估算（CJK≈1、ASCII≈0.25、其他≈0.5），不是模型分词器精确计数；预算只约束记忆正文/摘要，不包含固定提示词框架。
- 当前模式的 `statuses` 过滤只能选 `active`；查看 `superseded`/`archived` 必须显式使用 `mode=history` 与 `asOf`。来源/时间过滤时，缺失对应字段的旧条目不匹配。
- 备份脚本存在不等于已调度或已做恢复演练；本轮只运行了备份单元测试，生产调度与恢复演练仍未验证。
- `archived` 当前作为持久状态保存，但尚无独立批量归档 UI；历史读取需显式 `mode=history`。
- 初始化排他创建依赖同一目录内 `link()`；不支持硬链接的文件系统会让初始化进入既有损坏兜底。该平台兼容性未验证。
- 自然并发下锁前窗口的触发频率未测；启动竞态修复已由故障注入回归覆盖。
- 评测夹具 Q21 的旧事实 M09 属 `s-private`，`s-main` 的更正不得跨会话修改它；Q21 不再把 M09 记作 `s-main` 的更正残留，只用 `forbid` 验证它不可被 `s-main` 读取。相关测试里的负时间偏移也修正为真正的“过去”。