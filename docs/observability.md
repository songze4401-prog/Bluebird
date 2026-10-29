# Bluebird 可观测性系统（v1）

> 目标：让 Bluebird 的关键行为都有真实执行证据，失败可定位，优化可用数据验证。
> 本文同时承担「阶段 0 基线映射 + 事件/指标契约 + 阶段 1/2 交付说明 + 未完成项」。

## 1. 状态总览

| 能力 | 状态 | 证据 / 边界 |
| --- | --- | --- |
| 真实调用链埋点 | 已实现、已接入、已验证 | `tests/monitoring-api.test.js` 用真实 HTTP + 上下文运行时 + Agent 工具循环 + 落盘，模型 SDK 为桩 |
| 统一事件契约 / 状态枚举 / 脱敏 | 已实现、已验证 | `tests/monitoring.test.js` 契约、敏感字段、哈希引用用例 |
| 有界事件 / Trace / 审计 / 告警存储 | 已实现、已验证 | JSONL 滚动 + 保留期 + 环形上限；重启恢复与坏行跳过用例 |
| Trace Explorer（阶段、span、事件） | 已实现、已接入、已验证 | `/monitoring/traces/:traceId` + 前端 Trace 页 |
| 总览 / 上下文记忆 / 工具 / 模型 / 错误审计 / 健康告警 | 已实现、已接入、已验证 | 前端系统监控工作区 + 37 项 API/链路测试 |
| 指标定义、聚合与延迟分位数 | 已实现、已验证（分位数为桶近似） | 指标只接受预定义名称/标签，系列上限 2000 |
| 站内告警规则引擎 | 已实现、已验证（最小样本/触发/恢复） | 外部通知未配置 |
| 备份健康 | 只读接入现有状态文件 | 定时任务是否配置：未知；恢复演练：未知 |
| 真实生产环境验收 | 待验证 | 需在部署环境执行 |
| 外部通知（短信/邮件/Webhook） | 未实现 | 未配置，不假设已连接 |
| 成本金额 | 未配置 | 无费率/账单来源，API 返回 `not_configured`，不编造金额 |
| 模型实际消费（consumed） | 未采集 | Trace 固定 `null`；HTTP 成功不等于模型使用了每条内容 |

## 2. 当前真实调用链映射（阶段 0）

| 边界 | 真实代码位置 | 记录内容 |
| --- | --- | --- |
| HTTP 入口/出口 | `server/index.js` 的 `monitoringMiddleware()`；`server/monitoring/index.js` | 方法、规范化路由、状态码类、耗时、请求终态 |
| 会话加载 | `server/index.js` `prepareChatRequest()` → `monitoring.recordSessionLoaded()` | 消息条数（不记录正文/原始会话 ID） |
| 上下文构建 | `server/index.js` → `server/context/engine.js` `runContextRuntime()` → `monitoring.recordContextBuild()` | 候选/选中/接受/注入/发送数量、摘要数量、记忆候选/接受、裁剪数、窗口来源、Token 估算 |
| 记忆检索 | `server/context/retriever.js` `fetchMemory()` → `monitoring.beginMemorySearch()` | 成功/无结果/失败/跳过、耗时、结果条数、错误码 |
| 模型调用 | `server/model-adapter.js` `createChatCompletion()` → `monitoring.beginModelCall()` | 服务商/模型、轮次、输入/输出 Token（供应商 usage 优先）、耗时、错误分类 |
| 工具调用 | `server/agent-runtime.js` `executeToolCall()` / `runAgentTurn()` | 请求 → 执行 → 成功/失败/超时/拒绝、去重、耗时、结果是否回传 |
| 流式输出（SSE） | `server/index.js` `/chat/stream` → `recordSseStarted/Completed` | 建连/完成/中止/失败/拒绝、首 token、增量事件数、耗时 |
| 会话落盘 | `server/index.js` `completeChatTurn()` → `monitoring.recordPersistence()`；`server/sessions.js` `appendMessagesDetailed()` | 写入成功/失败/跳过、消息数、裁剪数、耗时 |
| 长期记忆写入 | `server/index.js` `scheduleMemoryExtraction()` → `monitoring.recordMemoryWrite()` | 动作、写入/跳过/失败、原因短码（不记录记忆正文） |
| 数据清除/删除/配置变更 | `server/index.js` 各路由 `auditAction()` | 动作、对象类别、结果、操作者/会话哈希引用、原因 |
| 备份状态 | `server/backup.js` `checkStatus()`（只读） | 最近成功时间、连续失败、同卷、灾难恢复等级；不触发备份 |
| 前端控制台 | `components/MonitoringScreen.tsx`；入口 `components/SettingsDrawer.tsx` → `App.tsx` | 只读 API；独立工作区 |

监控模块本身位于 `server/monitoring/`：

- `config.js`：上限、保留期、查询边界、告警窗口；环境变量逐项显式读取。
- `schema.js`：事件字段白名单、状态枚举、属性脱敏。
- `context.js`：`AsyncLocalStorage` 关联 trace/span；会话/操作者哈希引用。
- `store.js`：事件/Trace/审计/告警的有界内存 + JSONL 追加与滚动。
- `metrics.js`：预定义指标、分钟桶、桶近似分位数、系列上限。
- `alerts.js`：规则版本、最小样本、抑制、恢复。
- `health.js`：监控自健康 + 持久化窗口 + 备份只读状态。
- `index.js`：门面与领域埋点。
- `routes.js`：只读 HTTP API。

## 3. 事件契约

通用字段（`server/monitoring/schema.js`）：

| 字段 | 含义 |
| --- | --- |
| `schema_version` | 事件 schema 版本（当前 1） |
| `event_id` | 唯一 ID，防重复写入 |
| `event_name` | 稳定事件名，如 `model.request.completed` |
| `occurred_at` / `collected_at` | 发生时间 / 采集时间（UTC ISO） |
| `service` / `component` | 固定服务名与模块 |
| `environment` / `release` / `git_sha` | 环境与版本；未知时为 `null` / `unknown` |
| `trace_id` / `span_id` / `parent_span_id` | 全链路关联 |
| `session_ref` | 会话哈希引用（`s_` + 16 位），不存原始 sessionId |
| `level` | debug / info / warn / error / critical |
| `status` | 标准状态枚举（见下） |
| `duration_ms` | 可测量耗时 |
| `error_code` / `error_category` | 稳定错误码与分类 |
| `attributes` | 白名单属性；只允许计量/标识/原因，敏感键直接丢弃 |

状态枚举：`success`、`partial_success`、`failed`、`timeout`、`cancelled`、`skipped`、`disabled`、`no_result`、`denied`、`unknown`。不同失败语义不混用；无样本不得写成成功。

已声明事件：

- `request.received/completed`
- `session.loaded`
- `context.build.started/completed/rejected`、`context.sent`
- `memory.search.started/completed`、`memory.write.completed`
- `model.route`（请求模型 → 实际模型、是否视觉自动路由及原因）
- `model.request.started/completed`
- `tool.call.requested/completed`、`tool.result.returned`
- `agent.gate`（工具门控：开关/能力/新图/视觉互斥/原因/是否放行）
- `agent.round.completed`、`agent.run.completed`
- `response.stream.started/completed`
- `persistence.write.started/completed`
- `task.completed`
- `data.event`（数据损坏/落盘异常桥接，只带受控短码）
- `monitoring.started/stopped`

## 4. Trace 生命周期与阶段

一次真实请求至少串起：

`request.received → session.loaded → context.build.started → memory.search.started/completed → context.build.completed → model.request.started/completed → tool.call.requested/completed（0..n）→ context.sent → response.stream.*（如适用）→ persistence.write.* → task.completed → request.completed`

上下文/记忆五阶段：

- `candidate`：历史/检索得到的候选；
- `selected`：策略选择；
- `accepted`：通过来源、权限、时效与契约检查；
- `injected`：真实进入最终模型请求对象；
- `sent`：真实发往提供方（每次模型调用前用实际 messages 记录）；
- `consumed`：固定 `null`，并带说明「未采集模型实际消费证据」。

Trace 里每个 span 只保留标识、名称、状态、耗时、错误码与安全属性；单 Trace span 上限 200，超出计数写入 `spans_dropped`。

「为什么没有调用工具」由 `agent.gate` 事件直接回答（开关、模型工具能力、本次新图、视觉互斥、原因、是否放行）；模型选择结果与视觉自动路由原因由 `model.route` 事件回答。「为什么没有注入记忆」由上下文事件的 `memory_skipped_reasons` 与 Trace 的 `context.memory_skipped` 回答；上下文裁剪原因由 `dropped_reasons` / `context.dropped` 回答（只记录短码，不记录正文）。

## 5. 指标定义（口径 / 单位 / 空值语义）

| 指标 | 类型 | 标签 | 说明 | 空值语义 |
| --- | --- | --- | --- | --- |
| `http_requests_total` | counter | method, route, status_class | HTTP 请求数 | 0 表示窗口内无请求样本，不表示成功率 100% |
| `http_request_duration_ms` | histogram | route | HTTP 端到端耗时 | 无样本时 P50/P95/P99 为 `null` |
| `tasks_total` | counter | status, termination | 聊天任务终态；分母只含已进入执行的任务 | 无样本时成功率 `null` |
| `task_duration_ms` | histogram | status | 任务从请求到收尾耗时 | 同上 |
| `model_requests_total` | counter | provider_id, model_id, status, kind | 真实模型请求 | status 区分 success/failed/timeout/denied/cancelled |
| `model_request_duration_ms` | histogram | provider_id, model_id | 模型请求耗时（不含工具执行） | 无样本为 `null` |
| `model_tokens_total` | counter | provider_id, model_id, token_kind, usage_source | 供应商 usage 或 `missing` | 缺失不估算，不伪装精确值 |
| `model_cached_tokens_total` | counter | provider_id, model_id | 供应商返回的缓存命中 Token | 未返回时无样本 |
| `tool_calls_total` | counter | tool_name, status | 工具请求/执行结果；未注册工具归入 `unknown_tool` | 无样本不显示 0% 成功率 |
| `tool_deduped_total` | counter | tool_name | 同请求内同参数去重的调用 | 无样本为 0 |
| `agent_rounds` | histogram | status | 一次 Agent 回合实际模型轮数 | 无样本为 `null` |
| `model_auto_routed_total` | counter | reason | 视觉能力触发的模型自动路由 | 未发生为 0 |
| `tool_call_duration_ms` | histogram | tool_name | 工具执行耗时 | 无样本为 `null` |
| `memory_searches_total` | counter | status | 记忆检索；`no_result` 不等于失败 | 无样本不显示命中率 |
| `memory_injected_items_total` | counter | memory_type | 最终注入的记忆条目 | 0 表示窗口内没有注入 |
| `context_builds_total` | counter | status, error_code | 上下文构建终态 | `context_too_large` 单独告警 |
| `context_stage_items_total` | counter | stage | 五阶段条目累计 | 每请求按实际阶段计数 |
| `context_tokens_total` | counter | kind, source | 输入估算、窗口、工具预留 | source 区分 declared / unknown_guard / heuristic |
| `sse_connections_total` | counter | status | SSE 终态 | rejected 表示未切流即失败 |
| `persistence_writes_total` | counter | status | 会话落盘 | failed 可单独告警 |
| `memory_writes_total` | counter | action, status | 长期记忆写入 | 与检索分开 |
| `monitoring_events_total` | counter | outcome | 监控自身接收结果 | invalid/error 进入健康信号 |
| `alerts_total` | counter | rule_id, severity | 告警触发次数 | 0 表示未触发，不表示无风险 |

口径说明：

- 延迟分位数使用固定桶近似（5ms–300s），API 明确返回 `approximate: true`，不声称精确。
- 指标标签只接受预定义名称与值；系列总数上限 2000，超限丢弃并累加健康计数。
- 会话 ID / trace ID / 错误详情永不进入指标标签。
- 时间统一 UTC 存储，前端按本地时区展示。

## 6. 告警规则（站内）

| 规则 | 级别 | 窗口 / 最小样本 | 条件 |
| --- | --- | --- | --- |
| `core_request_failure_rate` | P1 | 5 分钟 / 20 | 5xx 比例 > 20% |
| `model_failure_rate` | P1 | 5 分钟 / 5 | 失败+超时比例 > 30% |
| `tool_failure_rate` | P2 | 5 分钟 / 5 | 失败+超时+拒绝比例 > 30% |
| `memory_search_failure_rate` | P1 | 5 分钟 / 3 | 检索失败比例 > 50%（空结果不算失败） |
| `memory_injection_zero` | P2 | 30 分钟 / 10 | 成功检索 ≥10 次但注入 0 条 |
| `context_build_failure_rate` | P1 | 5 分钟 / 3 | 构建失败比例 > 20% |
| `context_input_rejected` | P1 | 5 分钟 / 1 | 出现 `context_too_large` |
| `persistence_write_failure` | P1 | 5 分钟 / 1 | 任意一次会话落盘失败 |
| `backup_stale_or_failed` | P2 | 5 分钟 / 1 | 备份状态陈旧或最近失败；无状态文件时不触发 |
| `data_event_failure` | P1 | 5 分钟 / 1 | 数据文件损坏/落盘异常事件 |
| `security_denied_operation` | P0 | 5 分钟 / 1 | 出现 denied 事件或审计拒绝 |
| `task_max_rounds` | P2 | 10 分钟 / 1 | 任务因达到最大轮数结束 |
| `monitoring_self_degraded` | P2 | 5 分钟 / 1 | 写盘/队列/指标/告警评估异常新增 |
| `single_task_token_spike` | 停用 | — | 需真实生产基线；当前不编造阈值 |
| `cost_spike` | 停用 | — | 未配置费率与账单；成本只能显示未配置 |

告警行为：

- 低流量返回 `insufficient_data`，不因一次失败误报；
- 触发后同一规则只保留一条活动告警并累计抑制次数；
- 连续静默超过恢复窗口后自动 `resolved`；
- 站内展示，短信/邮件/Webhook 未配置；API 明确返回 `configured:false`；
- 不自动执行修复、删除、改权限或部署动作。

## 7. 只读 API

全部复用现有 `requireAuth`（Bearer token），无写接口；非 GET 返回 405。

| 接口 | 说明 |
| --- | --- |
| `GET /monitoring/overview?from&to` | 总览卡片、成本状态、备份、监控健康 |
| `GET /monitoring/metrics?names&from&to` | 预定义指标时间序列 |
| `GET /monitoring/traces?from&to&status&model_id&tool&cursor` | Trace 列表 |
| `GET /monitoring/traces/:traceId` | Trace 详情 + span + 关联事件 |
| `GET /monitoring/events?level&component&event_name&status&cursor` | 事件查询 |
| `GET /monitoring/audit?from&to&cursor` | 敏感操作审计 |
| `GET /monitoring/tools?from&to` | 工具注册/健康摘要 |
| `GET /monitoring/models?from&to` | 模型请求/Token/延迟 |
| `GET /monitoring/alerts` | 告警记录、规则、状态、通知配置 |
| `GET /monitoring/health` | 监控自身、存储、持久化、备份、查询层健康 |
| `GET /monitoring/meta` | schema、状态枚举、指标定义、规则级别 |

边界：范围 ≤ 7 天；limit ≤ 500（默认 50）；非法时间/游标/枚举/指标名返回 400；游标失效不猜测。响应带 `generated_at`、`range`、`coverage`、`data_status`。

## 8. 存储、容量与可靠性

- 目录：`<BLUEBIRD_DATA_DIR>/monitoring/`，与聊天/记忆/附件/备份数据分离。
- 文件：`events.jsonl`、`traces.jsonl`、`audit.jsonl`、`alerts.jsonl`；按大小滚动，按保留期清理滚动文件。
- 上限（默认，可用 `BLUEBIRD_MONITORING_*` 调整）：
  - 内存事件 20,000；Trace 2,000；单 Trace span 200；审计 5,000；告警 200；
  - 单文件 32MB；监控目录总容量上限 256MB（超出时删最旧的滚动文件）；保留期 7 天；写盘批次 200 / 1s。
- 追加语义：一行一个 JSON；崩溃最多留下半行，启动逐行容错跳过；滚动使用 rename。
- 写盘失败不会回灌业务，不回无限重试；失败/丢弃/非法计数进入健康状态，前端显示 `degraded`。
- 监控关闭（`BLUEBIRD_MONITORING=0`）时：业务照常运行；API 返回 `disabled`；前端显示「监控已关闭」，不显示健康。
- 单进程设计：指标按进程内存聚合，重启后从持久化事件/Trace 恢复最近视图；多实例不聚合（本项目本身强制单实例）。

## 9. 隐私与权限

- 不记录：用户消息正文、Prompt、记忆正文、工具参数/结果、附件内容、API Key、Authorization、完整敏感参数。
- 会话 ID 与会话引用分离：监控只存 `s_<sha256 前缀>`；操作者只存 `a_<sha256 前缀>`。
- 事件属性白名单 + 敏感模式打码；未知字段丢弃；高基数字段禁止进入指标标签。
- Trace/事件/审计只读；没有「强行读取正文」入口。
- 清除/删除/配置变更走既有权限与二次确认；审计只记录动作与结果，不复制数据。

## 10. 前端控制台

入口：设置抽屉 →「系统监控」，独立全屏工作区，不在聊天页堆卡片。

页面：总览 / Trace / 上下文·记忆 / 工具 / 模型·成本 / 错误·事件 / 安全·可靠性 / 健康·告警。

- 支持 1 小时 / 24 小时 / 7 天范围与手动刷新；
- 空数据显示「暂无数据 / 尚未接入」，不显示看似正常的 0；
- Trace 下钻显示阶段数量、span 时间线、关联事件、`consumed=null` 说明；
- 上下文页展示候选→选中→接受→注入→发送、最终发送计数、窗口来源与排除/跳过原因；
- 模型页明确「费率未配置」，Token 来自供应商 usage 或缺失；
- 健康页展示监控状态、写盘/丢弃、备份状态、告警规则（含停用原因）。

## 11. 测试与验收证据

| 命令 | 结果 |
| --- | --- |
| `node --test --test-concurrency=1 tests/monitoring.test.js` | 25 passed / 0 failed |
| `node tests/monitoring-api.test.js` | 38 passed / 0 failed |
| `npx jest tests/unit/monitoring-screen.test.tsx --ci` | 6 passed / 0 failed |
| `npx tsc --noEmit` | 0 errors |
| `npm run lint` | 0 errors |

`monitoring-api` 使用真实 HTTP 服务、真实上下文运行时、真实 Agent 工具循环、真实落盘与 SSE；模型 SDK 为桩（非生产模型调用），因此：
- 「真实链路埋点」= 已验证；
- 「真实模型/供应商行为」= 由既有 `eval:context` 覆盖，本套件不冒充；
- 生产环境验收 = 待验证。

## 12. 已知缺口与阻塞

1. **外部通知未配置**：仅站内告警；短信/邮件/Webhook 需要独立授权与配置。
2. **成本未配置**：无费率与供应商账单；只显示 Token，不估算金额。
3. **模型消费证据缺失**：`consumed` 固定 `null`；需要供应商侧可靠证据才能升级。
4. **备份调度未知**：只读 `last-status.json`；仓库存在 CLI 不等于已配置 cron/Task Scheduler。
5. **恢复演练未在本轮执行**：`restore_drill: unknown`；需在部署环境单独演练。
6. **生产验证待做**：本地真实链路已通过；生产容量、真实流量基线、阈值需在生产环境校准。
7. **查询只覆盖内存保留窗口**：滚动文件用于离线排查，不通过 API 查询历史归档。
8. **监控本身是单进程内存聚合**：与应用单实例约束一致；多实例场景需外部聚合，不在 v1 范围。
9. **监控数据会进入备份目录**：备份递归采集 `server/data`，监控元数据随之备份；不含正文/密钥，容量受上限与保留期约束。
10. **辅助模型调用未纳入模型指标**：长期记忆提取与表情包语义描述走各自固定客户端，不经过 `model-adapter.createChatCompletion`，因此不计入模型请求/Token 指标；它们仍会出现在既有运行日志中。将辅助调用纳入统一适配层需要单独改造，未在本轮扩大范围。
