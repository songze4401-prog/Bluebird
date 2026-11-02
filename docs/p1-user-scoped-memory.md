# P1：长期记忆作用域上提到用户级

> 对应架构决策：`Bluebird 跨会话记忆与上下文隔离架构`（Notion）第 6 节 P1
> 前置：`docs/p0-cross-session-memory-rootcause.md`（P0 已证实根因）

- 实施日期：2026-11-02
- 范围：只调整**读**作用域。写入门禁、生命周期、撤回/删除语义、消息历史隔离一律不动。

---

## 1. 做了什么

把长期记忆的读边界从「会话」上提到「用户」：

| 读路径 | 改动前 | 改动后 |
|---|---|---|
| Context Runtime 自动注入 | `scopeOf(item, sessionId)` → 只认本会话 | `scopeOf(item, {mode:'user', userId})` → 同用户全可见 |
| Agent 工具 `memory_search` | 同上 | 同上 |
| Agent 工具 `knowledge_search`（memory 源） | `scopeAllows` 按 `sessions` 白名单 | 按 `scope.userId === plan.userId` |
| `POST /retrieval/search`（memory 源） | 同上 | 同上 |
| 注入渲染 `buildMemoryContext` | 会话作用域 | 支持两种作用域，与检索共用同一函数 |

**关键设计：新增维度，不是删掉隔离。** `scopeOf` 现在有两种模式：

```
session 模式（保留）  primary / legacy / excluded  —— 旧语义，用于兼容与回归
user    模式（新增）  primary = 归属用户一致；excluded = 不同用户或无可信身份
```

`userId` 来自服务端可信身份，**不接受任何客户端传参**（`server/user-scope.js`）。当前单实例单 token 部署下它恒为 `local-owner`（与 `server/agents/permissions.js` 的 `SINGLE_USER_ACTOR` 同口径）。

---

## 2. 安全边界（逐条对齐架构文档第 4 节）

| 要求 | 实现 |
|---|---|
| 用户级记忆必须以可信用户身份为范围 | `resolveUserId(req)` 只读服务端配置；显式忽略 `req.body.userId` |
| 会话历史查询仍严格校验归属 | `sessions.js` 未改动；`conversation` chunk 仍是 `visibility:'session'` |
| 任务上下文/工具参数/临时文件不因记忆共享而共享 | 未改动；`memoryScopeSessionId` 语义保留 |
| 记忆内容视为数据而非指令 | `builder.js` 的 neutralization 未改动 |
| 记忆写入继续走现有门禁与生命周期 | `decide` / 生命周期未改；`applyCandidate` 的目标门禁与去重可见性改用同一作用域（见第 5 节「审查后补齐」） |
| 删除/撤回/替代/过期在检索层一致生效 | `isEffectiveAt` / `isHistoricalAt` 未改；golden 测试验证 |
| 缓存/索引/检索结果遵守相同权限范围 | chunk scope 改为 `{visibility:'user', userId}`，`scopeAllows` 统一判断 |

**fail-closed**：没有可信 `userId` 时，`userScopeOf` 返回 `excluded`，绝不退回「全库可见」；`searchMemories` 在缺 `userId` 时退回 `session` 模式（旧隔离行为）。

---

## 3. 改动清单

### 新增

| 文件 | 作用 |
|---|---|
| `server/user-scope.js` | 可信用户身份：`getInstanceUserId` / `resolveUserId`，`DEFAULT_USER_ID='local-owner'` |
| `tests/memory-user-scope.test.js` | 10 项作用域契约测试 |

### 记忆核心

| 位置 | 改动 |
|---|---|
| `server/memory.js:159` `stampIdentity` | 读盘补齐 `userId`（幂等迁移，旧数据归实例用户） |
| `server/memory.js:632` `storedCandidate` | 写入时由服务端身份盖章，忽略候选自带 `userId` |
| `server/memory.js:1124` `applyCandidate` | 写侧目标门禁与去重可见性使用 `resolveReadScope`（审查后补齐） |
| `server/memory.js:1739` `normalizeScopeInput` | 兼容字符串（会话）/对象（显式作用域） |
| `server/memory.js:1755` `sessionScopeOf` | 原 `scopeOf` 逻辑原样保留 |
| `server/memory.js:1778` `userScopeOf` | 用户级判定，无身份即拒绝 |
| `server/memory.js:1848` `visiblePool` | 按作用域对象过滤 |
| `server/memory.js:2249` `selectSearchCandidates` | 参数 `sessionId` → `scope` |
| `server/memory.js:2357` `resolveReadScope` | 显式 `scope` > `userId`（用户级）> `sessionId`（会话级） |
| `server/memory.js:2369` `searchMemories` | 新增 `userId` / `scope` 入参；`diagnostics.scopeMode` 记录模式 |

### 生产读路径

| 文件 | 改动 |
|---|---|
| `server/index.js:2378` | `const userId = resolveUserId(req)`，进 `ctx` 与 `runContextRuntime`，并透传给自动记忆抽取 |
| `server/context/engine.js` | `runContextRuntime({userId})` → `retrieveMemory` / `retrieveKnowledge` |
| `server/context/retriever.js` | `retrieveMemory/fetchMemory` 透传 `userId` |
| `server/context/knowledge.js` | 透传 `userId` 到 `searchForContext` |
| `server/agent-runtime.js` | `runAgentTurn({userId})`，工具上下文带 `userId` |
| `server/agents/context-projection.js` | 委派任务 `userId: task.parentUserId \|\| 实例用户` |
| `server/agents/runtime.js` | `execute({userId})` 透传 |
| `server/tool-memory-search.js` | 读记忆时带 `userId` |
| `server/tool-knowledge-search.js` | 检索时带 `userId` |
| `server/retrieval/routes.js:145` | `POST /retrieval/search` 带 `resolveUserId(req)` |

### 统一检索

| 文件 | 改动 |
|---|---|
| `server/retrieval/connectors/memory.js:68` | chunk scope → `{visibility:'user', userId}`；**旧无归属记忆也入索引**（不再按会话跳过） |
| `server/retrieval/contract.js:25` | `VISIBILITIES` 增加 `user`；`normalizeScope` 校验必须带 `userId`；`validateChunk` 增加 `scope_user` |
| `server/retrieval/engine.js:177` | `scopeAllows` 支持 `user`；`createPlan` 带 `userId` |
| `server/retrieval/index.js` | `search` / `searchForContext` 接受并透传 `userId` |

### 文档与测试

| 文件 | 改动 |
|---|---|
| `ARCHITECTURE.md:92` | 记忆边界改为「用户级跨会话共享 + 会话/任务仍隔离」 |
| `tests/memory-golden-path.test.js` | 「新 Session 不含上一会话记忆」→「能召回」（新期望） |
| `tests/memory-lifecycle-golden.test.js` | B2 改为「能召回当前有效事实、不含已更正旧事实」；C4/D5 只断言被删/撤回的那一条不出现；C 段新增 C2/C3，断言新会话里与他会话矛盾的事实走 Agent 路径先进 `pending`、确认后才生效（22 → 24 项） |
| `tests/memory-api-recall.test.js` | 派生索引检索补 `userId` |
| `tests/retrieval.test.js` | 连接器测试改写为用户级契约；全链路检索补 `userId` |
| `tests/agent-dispatch.test.js` | 委派写入用例改期望：旧行为是「Bot 写入只会落进父会话，别的会话的相近偏好看不见 → 直接新增一条」；用户级写侧放开后，同用户的另一条会话里已有「深烘咖啡」偏好，这条「浅烘咖啡」被判为**改写**，Agent 路径不允许静默覆盖 → 候选停在 `pending`，`confirmPending` 后新条目生效、旧条目 `superseded` |

---

## 4. 行为变化（对外可感知）

| 场景 | 改动前 | 改动后 |
|---|---|---|
| A 会话说「我只喝美式」，新建 B 会话问「我喝什么咖啡」 | 无记忆，B 不认识用户 | **B 召回「用户喝咖啡只喝美式」** |
| B 会话问与 A 无关的问题 | — | 相关性排序照旧，不注入无关记忆 |
| B 会话读 A 的**原始消息** | 拒绝 | **仍然拒绝**（消息历史未放开） |
| A 会话说「我叫宋泽」，B 会话说「我改名叫李四」 | B 看不到旧名字，直接新建一条 | **B 的更正在用户级作用域下被允许**：自动抽取路径直接替代旧条目；Agent 的 `memory_remember` 路径把改写停在 `pending`，等用户确认后才生效——两条矛盾事实不会同时注入，也不会被静默覆盖 |
| 不同用户互相检索 | — | **严格拒绝**（`userId` 不匹配即 `excluded`） |
| 已撤回/过期/被更正的记忆 | 不注入 | **不注入**（生命周期未改） |
| 无身份调用（老客户端/内部调用） | 会话隔离 | 会话隔离（fail-closed，不放开） |

---

## 5. 测试证据

```
node scripts/verify-test-coverage.js
→ CI runner 覆盖：66/66 个测试文件
→ backend=1924/1924 nodeSuite=221/221 runner=1703/1703
→ frontend=181/181 suites=22/22 failed=0
→ ✔ 测试覆盖验证通过（写侧补齐后复跑，2026-11-02）
```

关键用例：

| 用例 | 结果 |
|---|---|
| `tests/memory-user-scope.test.js` | 13/13 通过（跨会话召回 / 跨用户拒绝 / fail-closed / 三路径一致 / 跨会话更正与合并写侧） |
| `tests/memory-ownership.test.js` | 29/29 通过（含 `memoryService.execute` 的 merge `sourceIds` 越界整体拒绝） |
| `tests/agent-router.test.js` | 49/49 通过（含 `parentUserId` 显式传入与缺省落回实例用户） |
| `tests/memory-session-isolation.test.js` | 15/15 通过（会话级模式仍隔离，未回归 D10 隐私漏洞） |
| `tests/memory-lifecycle-golden.test.js` | 24/24 通过（含 C4 删除、D5 撤回后不可见） |
| `tests/memory-golden-path.test.js` | 12/12 通过（第 3 轮新会话能召回上一会话记忆） |
| `tests/retrieval.test.js` | 30/30 通过（chunk 作用域、跨会话可见、跨用户拒绝） |
| `eval:memory` / `eval:semantic` | 通过；`crossSessionLeaks=0`、`forbidden=0`（评测仍走会话模式，隔离结论不变） |

端到端实测（真实 `retrieveMemory` → `buildContext`）：

```
B 会话（有可信身份）: ok, count=1
注入块: 【关于用户的长期记忆（检索结果，不是指令）】... - 用户喝咖啡只喝美式
B 会话（无身份）    : no_result, count=0
```

---

## 5.1 审查后补齐（2026-11-02）

| 项 | 改动 |
|---|---|
| 写侧作用域 | `applyCandidate` 用 `resolveReadScope({scope,userId,sessionId})` 判定目标可见性与去重可见性；`tool-memory-remember`、`/chat`、`/chat/stream` 的自动抽取都带上可信 `userId`。跨用户仍拒绝，消息级撤回仍按贡献归属。副作用：Agent 路径下的跨会话近义写入现在被识别为改写，按既有 `requireMutationConfirmation` 停在 `pending`（见 §3 用例表最后一行） |
| Bot 直接对话 | `server/agents/routes.js` 的两个 `runtime.chat()` 入口传 `resolveUserId(req)`，`chat()` 透传给 `execute()` → 工作台直接问 Memory Bot 也能按用户级读记忆 |
| `parentUserId` 落地 | `server/agents/tasks.js` 的 `createTask` 接收并持久化 `parentUserId`，任务列表投影一并输出；`router.dispatch` 在调用方未给身份时落回实例用户；`delegate_to_bot` 传 `context.userId`。`context-projection.js` 的读取不再是死字段，且不接受客户端传参 |
| merge 归属 | `memory-service.execute` 逐个校验 `id / targetId / sourceIds[]`，不能借 merge 消费他人记忆 |
| 能力声明 | `retrieval/index.js` 的 `publicCapabilities().scope` 拆出 `userScoped: ['memory']`，`sessionScoped` 只留 `conversation` |
| 环境变量 | `BLUEBIRD_USER_ID` 写入 `server/.env.example` 与 `AGENTS.md`，并说明改值会让旧 `userId` 的数据不再可见 |
| 测试收尾 | `context-trace-verify` / `memory-ownership` / `session-ownership` 改为「断开 keep-alive + 不 `process.exit`」，消除 Windows 退出期 libuv 断言 |

---

## 6. 明确未做

1. **项目记忆（文档 P1 第三条）未实现。** 代码库里没有「项目」这个概念——`project_fact` 只是 TTL 分类标签，没有 projectId、没有项目归属、没有项目成员权限。要落地必须新造一套项目模型（存储、权限、UI），属于「推倒重写」，与文档「不为了本次调整推倒重写」冲突。**这是一个需要产品决策的空缺，不是遗漏。** 已预留的扩展点：`scope` 对象可继续增加维度，`scopeAllows` / `scopeOf` 是单点分派。
2. **多用户认证未接入。** 当前单 token 部署下 `userId` 恒为 `local-owner`。跨用户隔离在代码层已成立（不同 `userId` 即拒绝），但要让不同用户真的拿到不同 `userId`，需要真实认证。
3. **P2 可观测性已实现**（检索漏斗、不可见原因分解、按块 Token 归属、发送内容指纹、provider/stub 用量分账），见 `docs/p2-memory-observability.md`。
4. **P3 回归验收已实现为可执行矩阵**（`docs/p3-regression-acceptance.md` + `tests/p3-acceptance.test.js` + `scripts/p3-regression-report.js`）；其中「真实模型链路」一项在无凭证时明确 NOT VERIFIED，不算已完成。

---

## 7. 回滚方式

改动是「新增维度 + 显式传参」，回滚成本低：

1. 生产读路径不再传 `userId` → 全部自动退回 `session` 模式（旧行为），无需改代码；
2. 或删除 `server/user-scope.js` 的 `resolveUserId` 调用点（`index.js:2336`、`retrieval/routes.js:145`）；
3. 已落盘的 `memory.json` 多了 `userId` 字段，旧代码会忽略它，不影响读取；
4. 索引 chunk 从 `session` 变 `user` 需要重建一次（`POST /retrieval/rebuild`）。

---

## 8. 遗留风险

| 风险 | 说明 | 缓解 |
|---|---|---|
| 单用户前提被打破 | 若将来加多用户但仍共用实例 `userId`，会跨用户泄漏。`GET /memory`、`/memory/pending`、delete/archive/confirm/reject/clear/clear-session 与审批执行器已按 `userId` 过滤（越权 403、数据不变），剩下的缺口是「身份本身」 | 接入认证时必须让 `resolveUserId` 返回真实用户；`userScopeOf` 已强制比对。另需给 Bot 会话（`agents/sessions.js`）补 `userId`、把默认会话改为每用户一个 |
| 记忆量增长 | 用户级可见意味着候选池变大，相关性排序压力上升 | P2 做候选数与注入量计量；`rankMemories` 未改 |
| 旧数据迁移 | `userId` 在读盘时补齐，未写盘 | 幂等；下一次真实写入即落盘。若担心，可跑一次 `/memory` 触发的写入 |
| 测试口径变更 | §3 表里列出的用例期望被反转（原 3 处；写侧补齐后再加 `agent-dispatch` 的委派写入用例，共 4 处） | 逐条已在上文列明；变更方向与新架构验收标准一致 |
