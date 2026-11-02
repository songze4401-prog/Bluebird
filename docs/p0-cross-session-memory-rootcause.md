# P0：跨会话记忆阻断点定位报告

> 对应架构决策：`Bluebird 跨会话记忆与上下文隔离架构`（Notion）
> 本文只做定位，不改架构。结论均来自对当前代码与真实调用链的核实，附复现脚本与实测输出。

- 定位日期：2026-11-02
- 代码版本：`songze4401-prog/Bluebird`（本地克隆）
- 复现脚本：`scripts/p0-repro-cross-session.js`（不 mock 检索逻辑，数据目录走临时目录）

---

## 1. 结论摘要（已证实根因）

**根因不是"检索不到"，而是检索入口在候选池阶段就把其他会话的记忆整体判为 `excluded`，且系统里没有"用户"这一维作用域可以用来替代会话作用域。**

三条已证实根因，按对现象的解释力排序：

| # | 根因 | 位置 | 性质 |
|---|---|---|---|
| R1 | `scopeOf()` 把"贡献全部登记在别的会话名下"的记忆判为 `excluded`，`selectSearchCandidates()` 只放行 `primary` / `legacy` | `server/memory.js:1710-1731`、`:2173-2179` | 直接阻断 |
| R2 | 记忆数据模型只有 `contributions[].sessionId`，**没有任何 user / owner 字段**，`scopeOf` 无法表达"同一用户的跨会话记忆" | `server/memory.js:350-400`、`:1710`；全仓 `userId` 命中 0 次 | 结构性缺口 |
| R3 | 该隔离是**前一次 P0 刻意修的隐私漏洞**（inject 路径曾 20 次跨会话泄漏），并被测试钉死为期望行为 | `server/memory.js:1756-1758`；`docs/memory-audit.md:295`（D10）；`tests/memory-session-isolation.test.js:236-247` | 设计意图，不是 bug |

**一句话**：当前系统用"会话"同时承担了"消息隔离"和"长期认知隔离"两件事；新架构要求把后者上提到用户级，但代码里没有用户级这个维度，所以现象表现为"新会话查不到记忆"，实际是"没有可用的跨会话作用域键"。

---

## 2. 复现证据

`node scripts/p0-repro-cross-session.js` 实测输出（节选）：

```
场景 1：A 会话写入具名记忆，B 会话（全新）检索同一问题
  A 会话检索 → 命中 1 条
    diagnostics.excluded.session_scope = 0
    diagnostics.candidates            = 1
  B 会话检索 → 命中 0 条，reason=empty_store
    diagnostics.excluded.session_scope = 1
    diagnostics.candidates            = 0
  B 会话注入渲染 buildMemoryContext → 空字符串（无记忆注入）

场景 2：无归属 legacy 记忆，B 会话检索
  B 会话检索 → 命中 1 条
    命中内容 = ["用户所在城市是杭州"]

场景 3：B 会话查询「给我推荐一杯咖啡」
  B 会话检索 → 命中 0 条
    session_scope 排除 = 2
    候选池大小 candidates = 0
```

关键读数：**`excluded.session_scope` 与 `candidates` 此消彼长**——被排除数正好等于库里的具名记忆数，候选池为 0。这说明记忆在"进入排序之前"就没了，不是相关性打分把它压下去的。

同时 `tests/memory-session-isolation.test.js` 15 项全部通过，其中第 236-247 行明确断言：

> 「回退逻辑：全新会话没有自己的记忆，也只回退到无归属旧数据」

即当前行为是被测试保护的设计，**任何"直接放开 scope"的改动都会让这批测试变红**，需要先改测试口径。

---

## 3. 真实调用链（新会话入口 → 最终查询）

两条生产读路径，共用同一个过滤函数，因此结论一致。

### 3.1 自动注入路径（每轮对话）

```
POST /chat
  server/index.js:2659  runContextRuntime({ task, sessionId, ... })
    server/context/engine.js:153  retrieveMemory({ task, sessionId, ... })
      server/context/retriever.js:181  searchMemories({ query, sessionId, ... })
        server/memory.js:2283   targetSessionId = cleanText(sessionId)
        server/memory.js:2305   selectSearchCandidates({ sessionId: targetSessionId })
          server/memory.js:2173   primary = scopeOf(item, sessionId) === 'primary'
          server/memory.js:2176   legacy  = scopeOf(item, sessionId) === 'legacy'
          server/memory.js:2177   pool    = primary.length ? primary : legacy   ← 阻断点
          server/memory.js:2179   exclusions.session_scope = base.length - pool.length
        server/memory.js:2326   rankMemories(pool, ...)   ← 只有 pool 里的才参与排序
    server/context/builder.js:244  renderMemoryBlock(memory.accepted)   ← 不再二次过滤，照单渲染
```

### 3.2 Agent 工具路径（模型主动调用 `memory_search`）

```
server/agent-runtime.js:472   context.memoryScopeSessionId || context.sessionId
  server/tool-memory-search.js:239-254  searchMemories({ query, sessionId: memorySessionId, ... })
    → 与 3.1 完全相同的 selectSearchCandidates / scopeOf
```

> 委派任务时 `memoryScopeSessionId` 指向父主控会话（`server/agents/context-projection.js:44`），这属于任务级隔离的正确做法，与本问题无关，但**改动 scope 时不能顺手把它一起放大**。

### 3.3 统一检索索引路径（`knowledge_search` 工具 / 检索 API）

```
server/tool-knowledge-search.js:117-134  retrieval.search({ query, sessionId, sources })
  server/retrieval/engine.js:161-172  scopeAllows(chunk, plan)
    visibility === 'session' → 必须 scope.sessions.includes(plan.sessionId)
  server/retrieval/connectors/memory.js:75  scope: { visibility: 'session', sessions }
```

**第二条独立的会话过滤**，但**它不影响聊天自动注入**：

- `searchForContext()`（`retrieval/index.js:1219-1236`）固定使用 `sources: config.contextSources` 与 `categories: ['knowledge']`；
- `CONTEXT_SOURCES` 默认是 `'document,web,code'`（`retrieval/config.js:60-64`），**不含 memory**；
- 因此记忆 chunk 虽被索引，但不会经此路径进入聊天上下文。

它的真实影响面是：Agent 的 `knowledge_search` 工具在显式请求 `sources: ['memory']` 时，以及 `/retrieval/search` API。**修 `scopeOf` 时这条路径仍会按会话拦截，必须同步处理，否则两条路径结论不一致。**

---

## 4. 作用域现状矩阵（逐层核查结果）

| 数据层 | 文档要求 | 代码现状 | 结论 |
|---|---|---|---|
| 用户身份与权限 | 用户级，不可跨用户 | **不存在**。全仓 `userId` 命中 0；认证是单一共享 Bearer token（`server/index.js:190-228`） | ❌ 缺失 |
| 原始消息历史 | 会话级，不允许串读 | 会话级（`sessions.js` 按 sessionId 存取） | ✅ 符合 |
| 短期上下文 | 会话级，不共享 | 会话级（`context/engine.js` 按 sessionId 组装） | ✅ 符合 |
| 长期记忆 | 用户级，跨会话按需检索 | **会话级**（`scopeOf` → primary/legacy） | ❌ 与目标相反 |
| 项目记忆 | 用户+项目级，按权限共享 | **不存在项目维度**。`project_fact` 只是 TTL 类型标签（`context/retriever.js:17-20`），不是项目作用域 | ❌ 缺失 |
| Agent 任务上下文 | 任务级，独立隔离 | 任务级（`memoryScopeSessionId` 指向父会话） | ✅ 符合 |
| 工具调用与执行状态 | 不因记忆共享而串线 | 任务/会话级，未与记忆混用 | ✅ 符合 |
| 记忆检索结果 | 请求级，只注入本次相关 | 请求级（`buildContext` 每次现算） | ✅ 符合 |

---

## 5. 逐项核查（对应文档 P0 清单）

### 5.1 工具参数

- `memory_search` 的参数经服务端白名单校验（`tool-memory-search.js:127-231`），**不接受模型传入 sessionId**，sessionId 来自服务端 context。这一点是安全的。
- 阻断发生在服务端注入 `sessionId` 之后，不在参数层。

### 5.2 检索过滤（**主因**）

`scopeOf` 的三分类语义（`server/memory.js:1704-1731`）：

| 分类 | 判定 | 是否进入候选池 |
|---|---|---|
| `primary` | 至少一条贡献的 `sessionId === 当前会话` | 是（优先） |
| `legacy` | 无贡献，或存在 `sessionId === null` 的贡献 | 是（仅当 primary 为空） |
| `excluded` | 贡献全部登记在**其他会话**名下 | **否** |

新会话 = 新 UUID（`server/sessions.js:518` `crypto.randomUUID()`），因此：
- 该会话没有 primary；
- 历史记忆都有具名归属，不是 legacy；
- 结果全部 `excluded`，候选池为 0。

**这就是"新对话不认识用户"的机械原因。**

### 5.3 数据存储

- 写入路径确实按会话登记贡献：`processMemory(..., sessionId, ...)`（`server/index.js:3033`）、`applyCandidate({...}, { sessionId: memoryScopeSessionId })`（`tool-memory-remember.js:194-207`）。
- 条目结构只有 `contributions[].sessionId`（`server/memory.js:350-400`），**没有 user 字段**。
- 但写入侧的去重是**全库**的：`effective.map(...)` 遍历全部有效记忆，只把 `visible` 标出来（`server/memory.js:1185-1190`），跨会话同事实会 MERGE 成一条、追加贡献（`memory-decision.js:93-103`，`same_fact_other_session`）。

> **重要不对称**：库层其实已经"知道"跨会话的同一事实（合并成一条带多会话贡献的记忆），但读层拒绝把它露出来。这为 P1 提供了现成抓手——不需要重写存储，只需要在读层把"多贡献"当成用户级事实。

### 5.4 上下文注入

- `builder.js` 的 `renderMemoryBlock` 不做二次过滤，只是渲染 retriever 给的结果（`builder.js:244-251`）。
- 因此注入层**没有独立的作用域判断**，不存在"检索给了、注入又拦掉"的不一致。
- 这也意味着：修 `scopeOf` 会同时改变注入行为，**不需要额外改注入层**。

### 5.5 缓存与索引

- 检索链路**无结果缓存**（`retriever.js` / `engine.js` / `store.js` 均无 cache 键）。
- 派生索引由 `refreshDerivedMemoryIndex()` 在写后重建（`memory.js:2486-2501`），索引 chunk 的 scope 是 `{ visibility: 'session', sessions: [...] }`（`connectors/memory.js:75`）。
- **不存在"缓存键漏带作用域"的问题**；但索引的 `visibility` 只有 `global` / `session` 两档（`retrieval/contract.js:81-91`），同样**没有用户级**。

### 5.6 用户身份

- 认证是单一共享 token（`server/index.js:190-228`），服务端从 token 推导不出"哪个用户"。
- 全仓无 `userId` / `ownerId`（`ownerId` 仅用于 Agent 任务租约，`agents/tasks.js:876`，与用户身份无关）。
- **当前部署实质是单用户实例**，"用户级"等价于"实例级"。这对 P1 是简化条件，但也意味着**任何"客户端传 userId"的方案都必须拒绝**（文档明确禁止）。

### 5.7 项目维度

- 不存在。`project_fact` 是 TTL 分类（`context/config.json` → `ttl.project_fact`），不是项目隔离。
- 文档要求的"项目记忆按项目边界过滤"目前**无处落地**。

---

## 6. 作用域不一致点汇总

| 位置 | 作用域口径 | 与目标架构的偏差 |
|---|---|---|
| `memory.js scopeOf` | 会话级（primary/legacy/excluded） | 应上提为用户级 |
| `retrieval/engine.js scopeAllows` | 会话级（sessions 白名单） | 同上 |
| `retrieval/contract.js` visibility | 仅 global / session | 缺 user 档 |
| `memory.js` 写入去重 | 全库（跨会话可见） | 与读层相反，属"读比写更严" |
| `GET /memory` | **全库返回，无会话过滤**（`index.js:1970-1989`） | 数据可读，仅检索不可读 |

> 最后一行是很有力的旁证：记忆中心能列出全部记忆，说明**数据在、权限也没拦**，问题纯在检索读路径。

---

## 7. 尚未证实 / 未知项

按文档要求，这些不能靠猜，需要真实运行数据：

1. **真实库里具名记忆与 legacy 记忆的比例**。仓库未提交 `server/data/`（`.gitignore` 排除），无法统计。这决定"新会话至少还能看到 legacy"这条兜底在真实环境是否有效。
2. **`retrieval.config.contextEnabled` 默认 `true`，但 `contextSources` 默认 `'document,web,code'`（不含 memory）**，所以统一检索不是聊天注入的阻断点（已核实，见 §3.3）。仍需确认生产环境变量 `BLUEBIRD_RETRIEVAL_CONTEXT_SOURCES` 是否被改成包含 memory。
3. **是否有客户端在 `sessionId` 之外还带用户标识**。`resolveSessionId()`（`index.js:499-510`）只认 `sessionId`，未传时回退 `DEFAULT_SESSION_ID`，未见用户字段。
4. **`memory_search` 在真实模型链路里是否被调用**。工具已注册，但需要 Trace 才能确认调用频率与参数。

---

## 8. 对 P1 的硬约束（风险提示，不在 P0 执行）

1. **不能直接删掉 `scopeOf` 的会话判断**。`docs/memory-audit.md:295`（D10）记录过：inject 路径曾完全无隔离，实测 20 次跨会话泄漏。直接放开会**回归这个已修复的隐私漏洞**。
2. **必须新增作用域维度，而不是替换**。目标是"长期记忆上提到用户级，消息/短期上下文/任务状态维持会话级"。当前 `scopeOf` 只有三档，缺"同用户不同会话"这一档。
3. **两条读路径必须同步改**：`memory.js scopeOf` 与 `retrieval/engine.js scopeAllows`（+ `contract.js` visibility）。只改一条会留下"少了一条"而不是"没有"的串读缺口（代码注释 `memory.js:1708-1709` 已经点明这个教训）。
4. **测试口径要一起改**：`tests/memory-session-isolation.test.js:236-247` 与 `memory-session-scope.test.js` 把"新会话只见 legacy"钉成了期望，P1 必须把它们改成"新会话可见同用户具名记忆，但仍不可见其他用户"。
5. **单用户实例是当前唯一可行前提**。在没有 userId 的情况下，"用户级"只能等价于"实例级"；一旦要多用户，必须先把可信身份接进来，不能靠客户端传参。
6. **写入侧的全库去重可以复用**：跨会话 MERGE 已经会追加贡献，P1 可以把它当作"用户级事实"的天然载体，无需重建存储。

---

## 9. P0 交付物

| 文件 | 说明 |
|---|---|
| `scripts/p0-repro-cross-session.js` | 可重复执行的阻断点复现脚本（临时数据目录，不碰真实数据） |
| `docs/p0-cross-session-memory-rootcause.md` | 本报告 |

**P0 未改动任何生产代码。** 下一步 P1 应在确认 §7 的未知项后，按 §8 的约束调整作用域。
