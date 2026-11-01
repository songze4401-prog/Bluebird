# Bluebird 全系统工程审计报告

> 审计日期：2026-10-31  
> 审计基线：`a3569e340945baa9d9aa5e50357b1f8f08e098b7`（代码树与 `origin/main` `6af05fe51bd97899e6d6768dae4aaf5747c29512` 一致）  
> 性质：只读审计，未修改业务代码、未改用户数据、未执行重构。  
> 结论口径：**已验证实现 ≠ 文档声称**；所有问题均以代码/测试/运行证据为准。  
> **修复状态**：本报告正文描述的是审计当时（基线 `a3569e3`）的缺陷状态，**不代表当前代码**。审计后的修复已落在 `qoder/audit-p0-memory-scope-2026-10-31` 分支，逐条证据与「在本仓库修不了的条目」见 [REPAIR_ROADMAP.md](./REPAIR_ROADMAP.md) §6。

## 1. 执行摘要

本次审计覆盖 77 个后端模块、62 个前端模块、48 个后端测试文件与 18 个前端测试套件。当前 CI 运行 `41188671741` 为 success；本地同一代码树的后端 48 文件 / 1563 项、Jest 18 套 / 166 项、tsc 与 lint 均通过。

**最重要的结论不是“测试是否绿”，而是“核心链路是否存在被测试掩盖的缺陷”。** 本轮确认 1 个 P0、12 个 P1、21 个 P2、12 个 P3：

- **P0-01**：委派 Memory Bot 使用全新的 `bs_*` 会话作为工具 sessionId，而记忆引擎按主控 session 隔离。结果是 Bot 读不到父主控会话的 session-scoped 记忆，写入也归属 Bot 会话，主控看不到。该问题未被现有测试覆盖，且直接解释“库里有记忆但 Bot 查不到/写不进主控”的现象。
- **P1 集中区**：Bot 凭证未绑定 provider、委派写入以模型 goal 作为接地、自动 UPDATE/MERGE 与文档“必须确认/审批”冲突、审批完成不触发实时结果投递、备份包含 Bot Vault 主密钥与密文、编辑 provider 丢 capabilities、切会话发送竞态、`persisted:false` 被忽略、偏好 TTL 双路径不一致、Bot 会话 200 上限、结果 SSE 静默停止、`memory.maintain/audit` 任务类型无执行器。
- **P2/P3**：任务裁剪、审批等待态、deadline 未执行、监控 maxRounds 失真、abort 监听器累积、knowledge tool 原文注入面、派生索引删除不清理、检索可能超 Context 预算、会话删除不释放附件、HTTP 边界硬化、调用期 DNS 未复验、单实例失败忽略、非流式断连不中止、UI 表单语义冲突、CI 双跑/超时、前端测试与文档漂移。

## 2. 审计基线与方法

1. 只读检查 Git HEAD、`origin/main`、模块清单、路由清单和测试清单；`git diff --stat origin/main HEAD` 为空。
2. 静态解析后端 `require` 与前端 `import`，生成依赖图（77 后端文件 / 226 边；62 前端文件 / 195 边）并检测强连通分量。
3. 逐条追踪主控聊天、Agent 工具、委派任务、审批、结果投递、记忆检索、Context Engine、统一检索、会话持久化、模型配置、监控与前端调用。
4. 对 P0 做了隔离数据副本验证：把真实 `memory.json` 复制到临时目录，分别以主控 session 与全新 `bs_*` session 调用 `searchMemories`，确认作用域差异；未读写生产数据。
5. 以当前 CI / 本地测试结果作为“回归证据”，但把“测试通过”和“真实能力成立”分开判断；不对真实模型质量、真实外部 embedding/reranker 做超出证据的宣称。

**证据等级**：已复现：P0-01（主控/新 Bot session 的隔离数据副本查询）、P2-01（隔离内存写入）、P2-21（legacy/primary 隔离查询）；运行证据：main CI 41188671741、PR CI 41182037360；其余缺陷为源码路径检查/测试对照，未做端到端复现，报告中以“代码证据”表述。

## 3. 系统架构与边界

完整架构树、模块职责、信任边界见 [ARCHITECTURE.md](./ARCHITECTURE.md)；依赖与调用方向见 [DEPENDENCY_MAP.md](./DEPENDENCY_MAP.md)。可视化控制台见 [HEALTH_DASHBOARD.html](./HEALTH_DASHBOARD.html)。

### 3.1 模块健康度摘要

| 模块 | 真实性 | 实现 | 测试 | 接口 | 安全 | 可靠性 | 风险 | 问题数 |
|---|---|---|---|---|---|---|---|---|
| 主控聊天与 Context Engine | 已验证实现 | 5/5 | 4/5 | 5/5 | 4/5 | 3/5 | medium | 4 |
| Agent Runtime / 工具注册 | 已验证实现 | 5/5 | 4/5 | 5/5 | 4/5 | 4/5 | medium | 4 |
| Memory Bot Runtime / 队列 | 部分实现 / 存在缺陷 | 4/5 | 3/5 | 4/5 | 3/5 | 2/5 | critical | 9 |
| 记忆引擎与生命周期 | 已验证实现 / 设计取舍 | 5/5 | 4/5 | 4/5 | 3/5 | 3/5 | high | 5 |
| 统一检索（backend） | 已验证实现 / 部分能力未验证 | 4/5 | 4/5 | 4/5 | 3/5 | 3/5 | high | 3 |
| 会话、任务与持久化 | 已验证实现 / 有保留策略缺口 | 4/5 | 4/5 | 4/5 | 3/5 | 3/5 | high | 6 |
| 模型服务商 / Adapter | 已验证实现 / 有配置风险 | 4/5 | 4/5 | 4/5 | 3/5 | 3/5 | high | 4 |
| 审批与维护 | 已验证实现 / 边界不一致 | 4/5 | 3/5 | 4/5 | 3/5 | 3/5 | high | 4 |
| Result Delivery / 主控 SSE | 已验证实现 / 有客户端缺口 | 4/5 | 3/5 | 4/5 | 4/5 | 3/5 | high | 2 |
| 前端聊天壳 | 部分实现 / 竞态风险 | 4/5 | 2/5 | 3/5 | 3/5 | 2/5 | high | 4 |
| Memory Bot / Memory Center UI | 部分实现 / 表单与流式边界 | 4/5 | 2/5 | 3/5 | 2/5 | 2/5 | high | 5 |
| 监控与可观测性 | 已验证实现 | 4/5 | 4/5 | 4/5 | 4/5 | 4/5 | low | 1 |
| CI / 测试 / 文档 | 通过但存在漂移 | 3/5 | 4/5 | 3/5 | 3/5 | 3/5 | medium | 4 |
| 统一检索 UI | 未实现 | — | — | — | — | — | not_implemented | 0 |

> 评分说明：5=强且证据充分；4=真实可用但有边界；3=部分/需修复；2=风险较高；1=仅有接口或不可用；—=没有可验证实现，不伪造评分。

### 3.2 核心调用链（摘要）

- **主控聊天**：HTTP → `prepareChatRequest` → `runContextRuntime` → 历史/摘要/记忆/外部知识 → 模型 →（可选）`runAgentTurn` → `completeChatTurn` → 会话落盘 → 记忆抽取。
- **委派**：主控工具 `delegate_to_bot` → 新 Bot 会话 + 任务 → 持久队列 → Bot Runtime → 记忆/知识工具 → Result Delivery → 父会话消息 → `/agent-results/stream` → 前端去重注入。
- **维护**：审批 API → `permissions.checkOperation` → `memory-service` → `memory.js` 生命周期 → 原子写；当前审批完成没有触发实时 Result Delivery。
- **检索**：ingest/sync → chunk 契约 → store/index → BM25/精确/可选向量 → RRF/门控 → evidence；Context 只注入 document/web/code，memory/conversation 走独立记忆通道。

## 4. 功能实现真实性清单

| 能力 | 状态 | 实际证据 | 边界 |
|---|---|---|---|
| 主控聊天 / SSE | 已验证实现 | /chat、/chat/stream 共用 prepareChatRequest；chat-stream 与真实 HTTP 测试 | 非流式断连不 abort |
| Context Engine 记忆注入 | 已验证实现 | runContextRuntime → retriever searchMemories；context-engine 48 项 | 偏好 TTL 与 legacy 取舍 |
| 主控 memory_search | 已验证实现 | tool-memory-search + memory.searchMemories；sessionId 由运行层注入 | 只返回当前会话/legacy |
| 主控 memory_remember | 已验证实现（受控） | 真实 /chat → applyCandidate；memory-agent-write 12 项 | 高置信可自动 CREATE/UPDATE/MERGE |
| knowledge_search | 部分实现 | 统一检索证据 + citations；retrieval 测试 | 原文未 neutralize；向量/重排未在 CI 真实跑 |
| delegate_to_bot | 已实现但存在 P0 | agent-dispatch 7 项；真实 UI E2E | Bot 记忆 scope 与父会话不一致 |
| 持久任务队列 | 已验证实现 | tasks/runtime queue + restart tests | 单进程；500 条无差别裁剪 |
| Result Delivery + SSE | 部分实现 | deterministic bot-result id、snapshot、UI E2E | 审批完成不实时投递；客户端干净关闭不重连 |
| 人工审批 | 已验证实现 | pending→approved→executing→completed/failed + API tests | 等待态与任务状态可脱节 |
| 记忆维护六操作 | 已验证实现 | memory-service + memory-maintenance 5 项 | memory_remember 绕过部分维护语义 |
| 统一检索 backend | 已验证实现 | 五类来源、BM25/精确/RRF/门控；retrieval 30 / retrieval-api 12 | 无 UI；真实外部 embedding/reranker 未在 CI |
| PDF/DOCX 解析 | 未实现 | document connector 显式 unsupported_format | 安全拒绝，不伪造成功 |
| 多用户 ACL | 未实现 | permissions.js single_user；所有 Bearer 可读所有 sessionId | 单用户本地部署假设 |
| 分布式 Worker | 未实现 | 单进程 JSON queue + in-process EventEmitter | 无跨进程锁/投递 |
| 真实模型质量 | 未验证 | CI 全部 stub；真实本地模型仅协议/SSE 手工证据 | 不代表生产模型质量 |
| 前端 App 级 E2E | 未实现 | 18 Jest 套件全部 mock apiFetch；无 Playwright/Detox | 真实 UI 行为靠手工 |
| 备份 / 恢复 | 已验证实现 / 安全缺口 | backup.js 递归、SHA-256、恢复演练；api-keys 排除 | agent vault key 与密文仍入备份 |
| 监控 | 已验证实现 | monitoring 27 + monitoring-api 38；只读 API | maxRounds 指标失真 |

**关键边界**：统一检索有 backend API，但**没有前端 UI**；`memory.maintain`/`memory.audit` 是 accepted task type，但**没有对应工具**；真实 embedding/reranker 只在手工/本地服务上验证，CI 使用 stub；多用户 ACL、分布式 Worker、PDF/DOCX、查询改写、真实模型质量均未实现或未验证。

## 5. 主控与记忆管理 Agent 权限矩阵

| 维度 | 主控 Agent | Memory Bot 直接对话 | Memory Bot 委派任务 |
|---|---|---|---|
| 模型/凭证 | 全局 provider key 或请求级 provider | 独立 modelProfile + AES-256-GCM Bot Key | 同直接对话 |
| 工具 | `memory_search`、`memory_remember`、`knowledge_search`、`delegate_to_bot`；受 policy allowlist/budget 限制 | 仅 manifest allowlist 的三个记忆/知识工具；再受 config/task 收窄 | 同直接对话，另受 task.allowedTools |
| 会话 | `sessions.json` 主控会话 | `agent-sessions.json` 的 `bs_*` 会话 | 新建 `bs_*` 会话；任务带 parentSessionId |
| 记忆读 scope | 当前主控 session（+ legacy 规则） | **当前 Bot session（+ legacy）→ P0-01** | **当前 Bot session，与父会话脱节 → P0-01** |
| 记忆写 scope | 当前主控 session | 当前 Bot session → 主控不可见 | 当前 Bot session → 主控不可见 |
| 维护操作 | 无直接维护工具；审批 API 执行 | 无维护工具；可由审批 API 执行 | 无维护工具；可由审批 API 执行 |
| 审批 | 单用户 Bearer；维护需 pending→approved→executing | 同左 | 同左；审批完成后投递缺口 P1-04 |
| 高风险工具 | deny-only `confirmation_required`；当前无高风险注册工具 | 同左 | 同左 |
| 会话边界 | 单用户 Bearer 可访问任意 sessionId | 单用户 Bearer 可访问任意 Bot session | 同左 |

## 6. 数据持久化、并发与恢复

| 存储 | 写入方式 | 恢复/隔离 | 审计结论 |
|---|---|---|---|
| `sessions.json` | 全量内存重写 + pid 临时文件 + fsync + rename | 只读保护，不覆盖损坏文件 | 主链路可靠；临时文件非独占、缺父目录 fsync（P3-08）；会话数无上限（P3-09） |
| `memory.json` / `emotion-state.json` / `presence.json` | `atomic-write` + 写队列 | memory/emotion 重命名隔离；presence 同策略 | 原子性有测试；TTL/legacy 语义见 P1-09/P2-21 |
| `api-configs.json` / `api-keys.json` | 原子写 | 配置损坏只读保护；密钥损坏备份 | 全局 Key 明文（P2-20） |
| `agents/*.json` | 原子写；Vault AES-GCM | 损坏显式报错，拒绝覆盖 | 任务/审批/会话有保留上限；Bot 会话 200 上限（P1-10），任务裁剪（P2-02） |
| `retrieval/index.json` | 单文件原子写，写操作串行 | 损坏隔离；隔离失败拒绝写 | 派生数据；删除内容不会立即清理（P2-08） |
| `monitoring/*.jsonl` | 追加 + 轮转 | 保留期/容量上限 | 只读监控；bounded |
| 单实例锁 | `wx` 锁文件 | 陈旧锁仅 ESRCH 接管 | 获取失败返回值被忽略（P2-13） |

## 7. 安全风险清单

### 7.1 已确认的防线

- 除 `GET /` 外所有业务路由均要求 Bearer；retrieval、agent、monitoring 路由有测试覆盖。
- 统一检索的 SSRF 防护包含私网/元数据地址拒绝、解析后固定 IP、重定向逐跳校验、文件 realpath 限制（`server/retrieval/security.js`）。
- 上传/表情包文件名使用 UUID + 魔数校验，未发现路径遍历面。
- Bot Key 使用 AES-256-GCM，AAD 绑定 `credentialId+botId+providerId`；响应仅返回 keyHint。
- trace/log 不记录 query 正文/记忆正文/工具参数；数据损坏日志不含 `error.message`。
- 维护审批有 pending→approved→executing→completed/failed 状态与权限二次检查。

### 7.2 风险与缺口

- **P0-01**：Bot 记忆作用域与父会话不一致，属于数据隔离/可用性双重缺陷。
- **P1-05**：备份包含 Vault 主密钥与密文，静态加密在备份路径失效。
- **P1-01**：Bot Key 未绑定当前 provider，配置切换可能把旧 Key 发往新 Base URL。
- **P1-02/P1-03**：委派写入接地于模型 goal；自动 UPDATE/MERGE/SUPERSEDE 未走确认/审批，和文档冲突。
- **P2-07**：`knowledge_search` 直接返回第三方原文，未 neutralize。
- **P2-11**：CORS 全开、8MB body 在鉴权/限流前解析、限流可被旋转 Authorization 绕过、无 JSON error handler、token 非恒定时间比较。
- **P2-12**：provider DNS 只在保存/测试时校验，聊天调用不复验固定。
- **P2-20**：全局模型 Key 明文、前端 Bundle 内嵌 token、HTTP/0.0.0.0 监听；单用户本地部署边界，不能直接用于多用户/公网。
- 多用户 ACL 未实现：任何 Bearer 持有者可访问任意 sessionId；公网/多用户部署前必须补真实 ACL。

## 8. 测试与可靠性评估

### 8.1 已有证据

- 当前 HEAD 树 = origin/main 合并树；main CI run 41188671741 success
- npm test：48 个后端文件 / 1563 项全部通过（本地本轮前一次运行，同一代码树）
- verify-test-coverage：backend 1563/1563、nodeSuite 221/221、runner 1342/1342、frontend 166/166、CI 48/48
- npx tsc --noEmit：0 错误；npm run lint：0 错误
- Jest：18 套 / 166 项通过

### 8.2 测试强项

- 真实 HTTP/SSE e2e：agent-tools、agent-policy、memory-agent-write、chat-stream、retrieval-api、monitoring-api、agent-dispatch
- 原子写/损坏隔离/崩溃恢复/单实例锁/数据隔离均有测试
- 工具预算截断后无工具收尾轮已有新回归；结果投递有成功/失败/去重/快照测试
- CI 有静态+运行时数据隔离 tripwire，测试不得在仓库留下 server/data

### 8.3 覆盖缺口

- 没有 P0-01 的主控会话记忆→委派 Bot 回归测试；memory-bot 测试把记忆贡献 seed 到 Bot session
- 没有审批完成→父会话实时投递测试
- 没有 provider 编辑保能力、Bot 凭证换 provider、session switch send、persisted:false、TTL 双路径、Bot session 上限、任务裁剪测试
- 没有 App 级/真实浏览器 E2E；18 Jest 套件全部 mock apiFetch；useBotResultStream/useSessionActions 等无测试
- api-endpoints 只断言约 18/60 常量，仍是字面量对字面量
- 真实 embedding/reranker/真实模型质量不在 CI；现有真实调用是手工/本地证据

### 8.4 可靠性判断

- 单进程、单文件、进程内队列/EventEmitter 的恢复路径有测试；但跨进程/多实例没有真实能力，不能把“重启恢复”当成分布式可靠性。
- 任务队列恢复会重新入队 accepted/running；若崩溃前已经执行过有副作用工具，没有幂等键，可能重复执行（侧写工具默认不自动重试，这是一个边界而非完全保证）。
- 任务 500 条裁剪与 Bot 会话 200 上限是真实可用性上限；未在 UI 中预警。
- 结果流正常完成/失败/重连已做 UI E2E；审批完成路径和客户端 401/干净关闭重连没有自动化覆盖。
- 真实模型质量、真实外部 embedding/reranker 不在 CI；本轮不把 stub 结果当作生产语义验收。

## 9. 文档与实际代码一致性

| 文档声明 | 实际代码 | 结论 |
|---|---|---|
| AGENTS.md:16 TasksPanel 是空状态，后端没有任务 API | TasksPanel 读取真实 `/agent-tasks` | 过期 |
| AGENTS.md:226 15 suites / 138 cases | 18 / 166 | 过期 |
| docs/unified-retrieval.md:285-286 45 files / 1540、frontend 162、CI 45 | 48 / 1563、166、48 | 过期 |
| docs/agent-policy.md:114 backend 1392 / nodeSuite 193 / runner 1199 / frontend 113 / CI 40 | 当前基线 1563 / 221 / 1342 / 166 / 48 | 过期 |
| docs/memory-bot.md:180 重启后 SSE 自动重连 | 客户端只在 `error` 重连，干净关闭/401/404 不重连 | 部分不成立 |
| 文档称维护操作默认审批 | memory_remember 可自动 UPDATE/MERGE/SUPERSEDE | 语义冲突 |
| 文档称统一检索有 UI/完整真实 embedding 验收 | 无前端 /retrieval；CI 只跑 stub | 需按证据限定 |

## 10. 问题分级清单

### P0（阻断）

| ID | 模块 | 状态 | 问题 | 证据（首条） |
|---|---|---|---|---|
| P0-01 | Memory Bot / 记忆引擎 | 存在缺陷 | 委派 Memory Bot 使用独立 Bot 会话，读不到父主控会话的记忆，写入也落在错误作用域 | server/tool-dispatch-bot.js:131-148：创建 Bot session 并作为 task.sessionId 派发 |

### P1（高）

| ID | 模块 | 状态 | 问题 | 证据（首条） |
|---|---|---|---|---|
| P1-01 | Memory Bot / 模型服务商 | 存在缺陷 | Bot 凭证没有在运行时绑定到当前 provider，切换模型后可能把旧 Key 发给新服务商 | server/agents/config.js:165-211：provider/model 可变更，credentialId 保留 |
| P1-02 | Memory Bot / 记忆引擎 | 存在缺陷 | 委派任务的写入接地使用主控模型生成的 goal，而不是用户原话 | server/agents/runtime.js:470-479：userText: task.goal |
| P1-03 | 记忆引擎 / 审批 / UI | 部分实现 / 文档不一致 | memory_remember 可自动 UPDATE/MERGE/SUPERSEDE，但文档和 UI 声称写入必须确认、维护必须审批 | server/memory-decision.js:77-118：UPDATE/MERGE/SUPERSEDE 决策 |
| P1-04 | 审批 / Result Delivery | 存在缺陷 | 审批驱动的任务完成绕过实时 Result Delivery，父会话要等到重启或 SSE 重连才看到结果 | server/agents/approvals.js:362-398：直接 updateTask completed/failed |
| P1-05 | 持久化 / 安全 | 存在缺陷 | 备份包含 Bot Vault 主密钥与加密凭证，AES-256-GCM 的静态加密被备份抵消 | server/backup.js:80-85：isSecretFile 只匹配 api-keys.json |
| P1-06 | 前端模型管理 / Provider | 存在缺陷 | 编辑模型服务商会静默清空模型名称与 tools/vision 能力声明 | components/ModelScreen.tsx:224-229：models.map(id => ({ id })) |
| P1-07 | 前端会话 | 存在缺陷 | 切换会话期间仍可发送，消息进入旧会话并从新会话视图消失 | hooks/useSessionActions.ts:108-127：先加载后切 id |
| P1-08 | 前端聊天 / 持久化 | 存在缺陷 | 服务端 persisted:false 被前端忽略，落盘失败仍显示为正常回复 | server/index.js:2767-2800：persisted 标志与失败日志 |
| P1-09 | Context Engine / 记忆引擎 | 部分实现 / 路径不一致 | 超过 30 天的用户偏好从聊天上下文消失，但 memory_search 仍返回同一条 | server/context/config.json:5：user_preference ttlMs=2592000000, demote_to_pending |
| P1-10 | Memory Bot / 会话 | 存在缺陷 | 每次委派创建一个 Bot 会话，硬上限 200，且没有自动清理 | server/tool-dispatch-bot.js:131-148：每次派发新建 Bot session |
| P1-11 | Result Delivery / 前端 | 部分实现 / 文档不一致 | 主控结果 SSE 在干净关闭或 401/404 时静默停止，客户端不会重连 | lib/agent-results-stream.ts:106-127：xhr.onload → closed，不检查 status |
| P1-12 | Memory Bot / Manifest | 仅有接口 | memory.maintain / memory.audit 被列为可受理任务类型，但没有对应维护/审计工具 | server/agents/manifest.js:32-43：acceptedTaskTypes 与 toolAllowlist |

### P2（中）

| ID | 模块 | 状态 | 问题 | 证据（首条） |
|---|---|---|---|---|
| P2-01 | 记忆引擎 | 设计风险 | 跨会话 MERGE 会改写其它会话的条目标题/类型，虽然文档把全局去重当既定行为 | server/memory-decision.js:85-87：duplicates 未检查 visible |
| P2-02 | 任务系统 | 存在缺陷 | 任务达到 500 上限时按 createdAt 直接删除最旧 50 条，可能删掉未完成或未投递任务 | server/agents/tasks.js:394-400：按 createdAt 删 50 条 |
| P2-03 | 审批 / 任务 | 部分实现 | waiting_approval 任务会被后续 runTask 覆盖为 completed，审批结果与任务状态脱节 | server/agents/approvals.js:233-242：任务置 waiting_approval |
| P2-04 | 任务系统 | 仅有接口 | deadlineMs 被存储与校验，但运行时不执行 | server/agents/tasks.js:343、369-377、417：deadlineMs 存储 |
| P2-05 | Agent Runtime / 监控 | 存在缺陷 | reachedMaxRounds/监控使用全局 MAX_ROUNDS，而不是本次 policy 的 maxRounds | server/agent-runtime.js:592-596：per-policy maxRounds |
| P2-06 | Agent Runtime | 存在缺陷 | 每次工具调用向同一个外部 AbortSignal 添加 abort 监听器，可能累积到 MaxListenersExceededWarning | server/agent-runtime.js:422-431：addEventListener('abort') |
| P2-07 | Retrieval / Agent Tool | 安全风险 | knowledge_search 把第三方文档/网页原文直接作为 tool 结果返回，未经过 Context 的 neutralize 渲染 | server/tool-knowledge-search.js:137-148：item.content 直接映射 |
| P2-08 | Retrieval / 会话 | 存在缺陷 | 删除会话/记忆/撤回不会同步清理派生检索索引；删除内容可继续留在 index.json | server/retrieval/index.js:271-292：syncAllConversations 的 prune 逻辑 |
| P2-09 | Retrieval / Context | 需要实测 | 检索向量/重排可能超出 900ms 的 Context 预算，阻塞聊天请求 | server/retrieval/index.js:337-347：await ensureVectorCoverage |
| P2-10 | Sessions / Uploads | 存在缺陷 | 删除会话不释放其未被其它会话引用的上传图片 | server/index.js:941-985：删除会话路径 |
| P2-11 | HTTP 边界 / 安全 | 存在缺陷 | CORS 全开放、鉴权前解析大 body、无限流失败锁定、无 JSON 错误处理，边界硬化不足 | server/index.js:26：cors() 无参数 |
| P2-12 | 模型 Adapter / 安全 | 存在缺陷 | 自定义 provider 的 DNS/SSRF 只在保存/测试时校验，聊天调用不复验和固定 IP | server/index.js:1585、1617：写入时 SSRF 校验 |
| P2-13 | 持久化 / 启动 | 存在缺陷 | single-instance 获取失败返回值被忽略，数据目录不可用时服务仍会 listen | server/single-instance.js:183-191：mkdir 失败返回 acquired:false |
| P2-14 | HTTP / 模型调用 | 存在缺陷 | 非流式 /chat 在客户端断开后不中止上游模型调用 | server/index.js:3141-3149：非流式调用无 signal |
| P2-15 | 前端维护表单 / 审批 | 存在缺陷 | 维护表单的 withdraw 会话参数与后端 scope 语义冲突，update 会无条件改写 type | components/MemoryBotScreen.tsx:505-541：payload/上下文参数 |
| P2-16 | Memory Bot UI | 存在缺陷 | Bot 对话流式期间切换会话没有 abort/请求快照，且没有停止按钮 | components/MemoryBotScreen.tsx:113-119：loadSession 替换消息 |
| P2-17 | CI / 测试 | 可靠性风险 | push 与 PR 双触发同一套 CI，且覆盖率门禁会把全量测试再跑一遍，20 分钟超时余量不足 | .github/workflows/ci.yml:12-23：push + PR 触发、20m 超时 |
| P2-18 | 前端测试 | 测试缺口 | 前端缺少 App 级/真实 HTTP E2E；关键 hooks 与结果流没有自动化测试 | tests/unit/：18 个套件（166 项） |
| P2-19 | 前端任务表单 | UI 不一致 | Memory Bot 工作台任务表单声称『由主控提交』，但创建任务没有 parentSessionId | components/MemoryBotScreen.tsx:443-451：请求体 |
| P2-20 | 安全 / 配置 | 已知限制 | 全局模型 Key 明文存储、前端 Bundle 内嵌 API Token、HTTP/0.0.0.0 暴露面 | server/api-configs.js:14-22：明文静态存储已知限制 |
| P2-21 | 记忆引擎 | 设计假设 | 有主会话贡献时，无归属 legacy 记忆对当前会话不可见；用户可能认为『库里有但查不到』 | server/memory.js:1652-1673：scopeOf 的 primary/legacy/excluded |

### P3（低/优化）

| ID | 模块 | 状态 | 问题 | 证据（首条） |
|---|---|---|---|---|
| P3-01 | 文档 | 文档漂移 | AGENTS/检索/策略文档与实际测试计数、TasksPanel、重连能力多处不一致 | AGENTS.md:16、226 |
| P3-02 | HTTP / 文档 | 文档漂移 | GET / 返回 version 0.3.0，与 package.json 0.4.1 不一致 | server/index.js:884-890：version '0.3.0' |
| P3-03 | 前端 API 层 | 工程债 | 路径构造分散在 endpoints.ts 之外，且 image/XHR 使用未回退的 EXPO_PUBLIC_API_URL | lib/stream.ts:242 |
| P3-04 | 前端 / API | 仅有接口 | 部分后端能力没有 UI 消费者；任务取消、权限查看、provider 启停、retrieval 全部仅 API | lib/api/endpoints.ts:45、62-65、98、108-116 |
| P3-05 | Agent / 文档 | 文档漂移 | parentMessageId 实际始终为 null，文档却宣称任务带 parentMessageId | server/tool-dispatch-bot.js:141 |
| P3-06 | 记忆 / 评测 | 工程债 | buildMemoryContext 在生产路径已无调用，但评测/文档仍把它当线上注入路径 | server/memory.js:1701 buildMemoryContext |
| P3-07 | Agent / Retrieval | 工程债 | 存在未使用导出/过期能力说明（supportsTool、TOCTOU note） | server/agent-runtime.js:158-160、945 |
| P3-08 | Sessions / 持久化 | 工程债 | sessions.saveStore 的临时文件不是独占打开，且缺少父目录 fsync，但注释声称与 atomic-write 对等 | server/sessions.js:403-454 |
| P3-09 | Sessions / Context | 性能风险 | 主会话数量无上限，每条聊天同步重写整个 sessions.json 并克隆最多 1000 条消息 | server/sessions.js:491-516：无 session cap |
| P3-10 | HTTP / 错误语义 | 工程债 | 部分路由状态码/错误格式不统一，缺少 JSON 404 与统一错误处理 | server/index.js:941-985：read-only → 500 |
| P3-11 | CI / 依赖 | 工程债 | 覆盖率门禁是精确用例数、无代码行覆盖阈值；Node 版本没有 engines/.nvmrc；actions Node20 弃用告警 | scripts/verify-test-coverage.js |
| P3-12 | 数据安全 / 运维 | 工程债 | 临时数据目录会关闭破坏性操作确认；outbox/event 异常时的增长没有硬上限 | server/index.js:1046-1059：temp data dir confirm bypass |

## 11. P0/P1 详细证据

### P0-01 委派 Memory Bot 使用独立 Bot 会话，读不到父主控会话的记忆，写入也落在错误作用域

- **分级/模块**：P0 阻断 · Memory Bot / 记忆引擎
- **状态**：存在缺陷
- **摘要**：delegate_to_bot 为每个任务新建 bs_ 会话，runtime 把该会话作为工具 sessionId；memory scope 只允许本会话贡献或 legacy，导致主控会话的 session-scoped 记忆对 Bot 不可见。Bot 的 memory_remember 也把贡献写到 bs_ 会话，主控之后看不到。
- **证据**：
  - server/tool-dispatch-bot.js:131-148：创建 Bot session 并作为 task.sessionId 派发
  - server/agents/runtime.js:470-479：execute 使用 task.sessionId 与 task.goal
  - server/memory.js:1652-1673：scopeOf 对其它会话贡献返回 excluded
  - server/memory.js:2109-2115：候选池为 primary || legacy
  - 隔离副本验证：同一个『宋泽』查询在主控会话返回主控贡献条目；在全新 bs_ 会话只返回无归属 legacy 条目，主控贡献条目不可见
- **影响**：委派记忆检索/解释漏掉主控会话的大多数长期记忆；委派写入不可被主控注入，形成静默数据孤岛与任务结果不完整。
- **修复方向**：将 Bot 对话会话（conversation）与记忆作用域（memoryScopeSessionId）拆开；委派任务把 parentSessionId 作为记忆 scope 传入工具，写入也归属父会话；补充主控贡献记忆的真实回归用例。

### P1-01 Bot 凭证没有在运行时绑定到当前 provider，切换模型后可能把旧 Key 发给新服务商

- **分级/模块**：P1 高 · Memory Bot / 模型服务商
- **状态**：存在缺陷
- **摘要**：config.updateConfig 可改 providerId/modelId 而保留 credentialId；getCredentialKey 只校验 botId，不校验 record.providerId；registry 只检查存在凭证；调用时 keyOverride 直接用于新 provider。
- **证据**：
  - server/agents/config.js:165-211：provider/model 可变更，credentialId 保留
  - server/agents/credentials.js:224-231：getCredentialKey 未比较 providerId
  - server/agents/registry.js:23-38：只检查 credential 存在
  - server/model-adapter.js:275：keyOverride 直接用于解析后的 provider
- **影响**：配置切换后旧 Bot Key 可能被发送到新 Base URL；verifyCredential 仍验证旧 provider，形成错误的就绪状态与凭证暴露面。
- **修复方向**：getCredentialKey/registry 校验 credential.providerId === config.modelProfile.providerId；provider 变更时要求重新录入凭证或明确迁移；验证接口按当前 provider 重新检查。

### P1-02 委派任务的写入接地使用主控模型生成的 goal，而不是用户原话

- **分级/模块**：P1 高 · Memory Bot / 记忆引擎
- **状态**：存在缺陷
- **摘要**：runTask 把 task.goal 作为 userText 传给 memory_remember 的 grounding 检查；goal 是主控模型改写后的文本，不是用户消息，因此『sourceQuote 必须在用户原话中』的信任锚点被降级为模型自述。
- **证据**：
  - server/agents/runtime.js:470-479：userText: task.goal
  - server/tool-memory-remember.js:183-215：以 context.userText 做接地
  - server/memory.js:593-599：requireUserGrounding 只检查 userText.includes(quote)
  - server/index.js:3091-3104：主控 runAgentTurn 未传 userMessageId
- **影响**：模型改写可把未经用户明确表达的内容写成长期记忆；写入来源、撤回锚点和审计可信度下降。
- **修复方向**：任务携带原始用户消息 ID/文本（parentMessageId 或受控 quote）并作为 grounding 来源；无法取得原始来源时拒绝写入而不是信任 goal。

### P1-03 memory_remember 可自动 UPDATE/MERGE/SUPERSEDE，但文档和 UI 声称写入必须确认、维护必须审批

- **分级/模块**：P1 高 · 记忆引擎 / 审批 / UI
- **状态**：部分实现 / 文档不一致
- **摘要**：decide() 对高置信、接地候选返回 UPDATE/MERGE/SUPERSEDE 并直接改写已有条目；审批只覆盖 memory-service 的六种维护操作；AgentToolsScreen 却写『写入必须经过你的确认』，文档写维护操作默认审批。
- **证据**：
  - server/memory-decision.js:77-118：UPDATE/MERGE/SUPERSEDE 决策
  - server/memory.js:1240-1320：直接替换已有条目
  - components/AgentToolsScreen.tsx:84：『写入必须经过你的确认』
  - docs/memory-bot.md:102-107、189：维护操作默认审批
  - tests/memory-agent-write.test.js:166-187：真实 /chat 写入可直接创建
- **影响**：用户以为写入需要确认，实际可能自动改写已有长期记忆；审批边界与产品声明不一致。
- **修复方向**：明确区分候选自动接受与维护改写：对 UPDATE/MERGE/SUPERSEDE 引入审批或显式确认；同步修正 UI/文档，列出自动规则。

### P1-04 审批驱动的任务完成绕过实时 Result Delivery，父会话要等到重启或 SSE 重连才看到结果

- **分级/模块**：P1 高 · 审批 / Result Delivery
- **状态**：存在缺陷
- **摘要**：approvals.execute 直接把关联 task 置为 completed/failed 并写结果，但没有调用 resultDelivery.deliverTaskOutcome；投递只在启动恢复或 SSE snapshot 时发生。
- **证据**：
  - server/agents/approvals.js:362-398：直接 updateTask completed/failed
  - server/agents/result-delivery.js:206-230：recoverPending 仅在启动/快照调用
  - server/agents/runtime.js:516-525：普通任务完成才调用 deliverTaskOutcome
- **影响**：审批完成后主控会话不会实时收到结果；若前端一直保持连接且不重连，结果可能长期不出现，只留在任务页。
- **修复方向**：审批完成/失败时调用统一 resultDelivery；为审批→任务→父会话补真实测试；与 result-delivery 的幂等消息 ID 对齐。

### P1-05 备份包含 Bot Vault 主密钥与加密凭证，AES-256-GCM 的静态加密被备份抵消

- **分级/模块**：P1 高 · 持久化 / 安全
- **状态**：存在缺陷
- **摘要**：backup 只排除 api-keys.json；agent-vault.key 与 agent-credentials.json 会一起进入快照。拿到备份的人可同时获得主密钥和密文。损坏的 api-keys.json.corrupt-* 也不匹配排除名。
- **证据**：
  - server/backup.js:80-85：isSecretFile 只匹配 api-keys.json
  - server/agents/credentials.js:25、42-86、119-127：vault key 与密文文件
  - server/backup.js:254-258：按文件名排除
  - server/backup.js:281：api-keys.json 作为可备份文件
- **影响**：备份泄露即 Bot Key 泄露；加密只保护在线磁盘，不保护被复制/同步的备份。
- **修复方向**：默认排除 agent-vault.key、agent-credentials.json 与任何 .corrupt 密钥副本；或对整个备份加密并在恢复时分离密钥。

### P1-06 编辑模型服务商会静默清空模型名称与 tools/vision 能力声明

- **分级/模块**：P1 高 · 前端模型管理 / Provider
- **状态**：存在缺陷
- **摘要**：ModelScreen 保存时把每个模型重建为 {id}；PATCH 整体替换 models；normalizeModel 将缺失能力默认为 false。一次改名字/模型列表的编辑就可能把 tools/vision 关闭，导致 Agent 工具和视觉路由失效。
- **证据**：
  - components/ModelScreen.tsx:224-229：models.map(id => ({ id }))
  - server/api-configs.js:455-469：PATCH 整体替换 models
  - server/api-configs.js:274-286：能力缺省 false
  - server/agents/registry.js:23-38：tools 能力影响 Agent 可用性
- **影响**：无提示的能力回退；用户以为只是编辑模型，实际改变聊天/Agent 路由。
- **修复方向**：编辑时保留原模型的 name/capabilities；或在 UI 显式提供能力开关并在 PATCH 时合并；增加回归测试。

### P1-07 切换会话期间仍可发送，消息进入旧会话并从新会话视图消失

- **分级/模块**：P1 高 · 前端会话
- **状态**：存在缺陷
- **摘要**：selectSession 先 await loadHistory 再 setCurrentSessionId；loadHistory 未把 loadingHistory 置 true；发送守卫只看 sending/continuing/loadingHistory。加载 B 历史期间发送会写入 A，随后 B 历史覆盖视图。
- **证据**：
  - hooks/useSessionActions.ts:108-127：先加载后切 id
  - hooks/useChatSession.ts:229-275：loadHistory 未设置 loadingHistory
  - hooks/useChatSession.ts:580-587：发送守卫只检查 sending/continuing/loadingHistory
- **影响**：消息写入错误会话、UI 看起来丢失；用户可能重复发送或误以为数据损坏。
- **修复方向**：选择会话开始时设置 pending/loading 状态并禁用发送；或先切换 sessionId 再加载，并用 RequestGate 丢弃旧响应。

### P1-08 服务端 persisted:false 被前端忽略，落盘失败仍显示为正常回复

- **分级/模块**：P1 高 · 前端聊天 / 持久化
- **状态**：存在缺陷
- **摘要**：/chat 在写盘失败时返回 persisted:false；客户端 never reads 该字段，流式 done 与非流式路径都直接展示消息。
- **证据**：
  - server/index.js:2767-2800：persisted 标志与失败日志
  - lib/api/types.ts:273：persisted?: boolean
  - hooks/useChatSession.ts:520-544：done / 非流式路径未检查 persisted
- **影响**：回复刷新后消失，用户无法知道持久化失败；监控有日志但 UI 无告警。
- **修复方向**：done/非流式响应检查 persisted，失败时显示明确错误/重试；补前端测试。

### P1-09 超过 30 天的用户偏好从聊天上下文消失，但 memory_search 仍返回同一条

- **分级/模块**：P1 高 · Context Engine / 记忆引擎
- **状态**：部分实现 / 路径不一致
- **摘要**：user_preference TTL 30 天、on_expire=demote_to_pending；builder 对 demoted 返回 keep:false；searchMemories 没有同等年龄门槛。注入路径和工具路径对同一记忆给出不同结论。
- **证据**：
  - server/context/config.json:5：user_preference ttlMs=2592000000, demote_to_pending
  - server/context/retriever.js:99：fetchedAt 取 validFrom/updatedAt
  - server/context/builder.js:32-41：demote_to_pending → keep:false
  - server/memory.js:2152：searchMemories 不做该 TTL 过滤
- **影响**：长期偏好静默从主控上下文消失，但工具仍能查到；用户看到的行为取决于入口。
- **修复方向**：明确 TTL 生命周期（重验证/降级/删除）并让注入与工具共用同一规则；补跨路径回归测试。

### P1-10 每次委派创建一个 Bot 会话，硬上限 200，且没有自动清理

- **分级/模块**：P1 高 · Memory Bot / 会话
- **状态**：存在缺陷
- **摘要**：delegate_to_bot 每次 createSession；agent/sessions.js 在 200 个 Bot 会话时抛 agent_session_limit；任务终止不删除对应会话。到上限后所有委派都会被工具层报错，仅表现为 tool_error。
- **证据**：
  - server/tool-dispatch-bot.js:131-148：每次派发新建 Bot session
  - server/agents/sessions.js:130-133：200 上限
  - server/agents/sessions.js:221-246：只有显式 deleteSession
  - server/agent-runtime.js:451-456：工具错误归一化
- **影响**：长期使用后委派能力静默失效；会话元数据持续增长。
- **修复方向**：为委派任务复用/清理 Bot 会话，或把会话与任务解耦；在接近上限时给出明确可操作错误并自动归档旧会话。

### P1-11 主控结果 SSE 在干净关闭或 401/404 时静默停止，客户端不会重连

- **分级/模块**：P1 高 · Result Delivery / 前端
- **状态**：部分实现 / 文档不一致
- **摘要**：subscribeAgentResults 忽略 HTTP 状态，只要 onload 就返回 closed；useBotResultStream 仅在 kind=error 时重连。服务端正常关闭、鉴权失效或会话不存在都会让结果流永久停止。
- **证据**：
  - lib/agent-results-stream.ts:106-127：xhr.onload → closed，不检查 status
  - hooks/useBotResultStream.ts:45-52：只有 error 才重试
  - docs/memory-bot.md:180：声称重启后自动重连
- **影响**：任务结果可能已经落盘/写入父会话，但 UI 不再实时显示，直到用户切换会话或刷新。
- **修复方向**：对非 200、异常关闭、鉴权失败分类处理并触发有上限的退避重连；401 时显示明确状态；补 hook 测试。

### P1-12 memory.maintain / memory.audit 被列为可受理任务类型，但没有对应维护/审计工具

- **分级/模块**：P1 高 · Memory Bot / Manifest
- **状态**：仅有接口
- **摘要**：manifest acceptedTaskTypes 包含 memory.maintain 和 memory.audit，UI 任务表单按 acceptedTaskTypes 渲染；Bot 工具 allowlist 只有 memory_search/memory_remember/knowledge_search，维护必须走审批 API，任务本身无法执行这些类型。
- **证据**：
  - server/agents/manifest.js:32-43：acceptedTaskTypes 与 toolAllowlist
  - components/MemoryBotScreen.tsx:981：按 acceptedTaskTypes 渲染任务类型
  - server/agents/runtime.js:85-112：任务只能使用 allowlist 工具
  - server/memory-service.js:247-264：维护只能经审批执行
- **影响**：用户可提交 memory.maintain/audit 任务，但 Bot 只能给文本说明或误用检索工具，无法完成承诺的操作。
- **修复方向**：为任务类型绑定真实执行器（提交审批/只读审计报告），或从 acceptedTaskTypes/UI 移除并明确不可用。


## 12. 修复优先级与依赖

修复顺序与依赖见 [REPAIR_ROADMAP.md](./REPAIR_ROADMAP.md)。总体原则：

1. 先做 **R-01（P0-01 记忆作用域）**，因为委派 Bot 的所有记忆读写都依赖它；任何后续委派质量评估在此之前都没有意义。
2. 再闭合 **凭证/写入信任边界（R-02）**、**审批结果投递（R-03）**、**备份与前端状态（R-04）**、**TTL/Bot 会话/结果流（R-05）**、**任务类型真实性（R-06）**。
3. P2 先做安全硬化、数据清理、检索延迟与前端自动化；P3 最后处理文档和工程债。

## 13. 已知问题、待验证问题与设计假设

### 已知问题（有证据）

- P0-01、全部 P1、P2/P3 表中带“已验证/代码检查/隔离复现”的条目。
- 单用户 Bearer 可访问任意 sessionId；多用户 ACL 不存在。
- 真实外部 embedding/reranker、真实模型质量不在 CI。

### 待验证（有风险但尚未实测量化）

- P2-09 检索向量/重排超出 900ms 预算的实际 worst-case（需要大索引/故障注入压测）。
- 结果流在移动端 React Native XHR 上的增量行为与断线重连（需要真机）。
- 备份泄露场景的实际爆炸半径（取决于备份目录权限/同步范围）。
- 任务裁剪在并发长任务下的实际丢失概率（需要 500 条容量的并发测试）。

### 设计假设

- 部署为单用户本地应用；Bearer token 是唯一用户边界。
- 主控会话与 Bot 会话物理分离；Bot 通过任务回传结果，而不是共享会话历史。
- 记忆按会话贡献隔离；无归属 legacy 作为回退，不表示全局共享。
- 任务队列为单进程持久化队列；不承诺多实例/分布式一致性。
- 结果投递以“消息写入父会话”作为可追溯事实；SSE 只是实时通知，不是唯一事实源。

## 14. 交付边界

- 本次只审计和生成报告，不修改业务代码、不执行重构、不覆盖用户数据。
- 所有评分为证据驱动；无法验证的模块/能力使用“未实现”“仅有接口”“未验证”或“—”，没有用视觉图掩盖缺陷。
- 发现项需要在后续单独立项修复；修复前不应把报告中的“已验证”理解为“全链路生产验收通过”。
