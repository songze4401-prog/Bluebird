# Bluebird 项目全景架构图

> 扫描基线：`main` @ `0a61e9f`（2026-11-08，PR #72 品牌定位合并提交）。
> 本文件只做结构梳理，不修改业务代码。

## 图例

- **实线矩形**：已实现并在运行链路中生效。
- **虚线矩形**：部分实现或存在明确边界（能力可用，但有未闭环项）。
- **浅色虚线矩形**：未实现 / 规划中，当前不参与运行链路。
- **圆柱节点**：数据存储（单机原子文件）。
- 箭头方向 = 调用或数据流方向；虚线箭头 = 降级/异步/未实现路径。

## 总架构图（Mermaid，横向布局）

```mermaid
%%{init: {"theme":"base","themeVariables":{"background":"#ffffff","primaryColor":"#f5f5f6","primaryTextColor":"#333333","primaryBorderColor":"#c9c9d0","lineColor":"#b6b6be","fontFamily":"Inter, Segoe UI, sans-serif","fontSize":"12px"},"flowchart":{"curve":"linear"}}}%%
flowchart LR
  subgraph CLIENT["客户端：Expo / React Native（已实现）"]
    direction TB
    UI["界面层<br/>App.tsx · Chat UI · Memory Center<br/>Agent Team · TasksPanel · Monitoring"]
    HOOKS["状态层 hooks<br/>useChatSession · useSessionList<br/>useAttachments · useBotResultStream"]
    APILIB["网络层 lib/api + SSE<br/>apiFetch · endpoints · types<br/>chat stream / agent-results stream"]
    UI --> HOOKS --> APILIB
  end

  subgraph EDGE["HTTP 边界 server/index.js（已实现）"]
    direction TB
    AUTH["Bearer 鉴权 · CORS 白名单<br/>限流 · 受控 JSON 错误"]
    CORE_ROUTES["核心路由族<br/>/chat · /sessions · /history<br/>/memory · /persona · /emotion · /presence"]
    SESSIONS["会话存储 sessions.js<br/>多会话 · 游标分页 · 上限"]
    MEDIA["媒体与贴纸<br/>uploads.js · sticker-repo.js"]
    AUX["人格 / 情绪 / 在线状态<br/>persona · emotion · presence"]
    AGENT_ROUTES["Agent API<br/>/agents/* · /agent-tasks<br/>/agent-approvals · /agent-results"]
    RET_MON_ROUTES["/retrieval/* · /monitoring/* · /agent-policy"]
    LOCK["单实例锁 .bluebird.lock<br/>single-instance.js"]
  end

  subgraph CONV["对话与上下文（已实现）"]
    direction TB
    PREP["prepareChatRequest<br/>会话解析 · 模型选择 · Agent 门控"]
    CTX["Context Runtime v3<br/>history · summary · memory retrieve<br/>coverage · input guard · trace"]
    AGENTLOOP["主控 Agent 工具循环<br/>agent-runtime.js"]
    POLICY["Agent Policy<br/>模式 · 工具白名单 · 预算"]
    ADAPTER["Model Adapter<br/>Provider 路由 · 视觉回退 · SSRF 防护"]
    PREP --> CTX
    PREP -->|"启用工具时"| AGENTLOOP
    CTX -->|"记忆检索"| MEMSTORE
    CTX -->|"知识检索"| RETIDX
    CTX --> ADAPTER
    AGENTLOOP --> POLICY
    AGENTLOOP -->|"工具调用"| MEMTOOLS
    AGENTLOOP -->|"工具调用"| KTOOL
    AGENTLOOP --> ADAPTER
    ADAPTER --> PROVIDER
    PREP --> SESSIONS
    PREP -.->|"异步记忆抽取"| MEMSTORE
  end

  subgraph MEM["记忆系统（已实现；语义能力部分实现）"]
    direction TB
    MEMSTORE["memory.js<br/>条目 · 生命周期 · 检索/打分"]
    MEMDEC["memory-decision.js<br/>memory-lifecycle.js"]
    MEMSEM["memory-semantic.js<br/>概念词典（非神经向量）"]
    MEMSVC["memory-service.js<br/>稳定维护接口"]
    APPROVALS["审批闭环<br/>agents/approvals.js"]
    MEMTOOLS["记忆工具<br/>memory_search · memory_remember"]
    MEMSTORE --> MEMDEC
    MEMSTORE --> MEMSEM
    MEMTOOLS --> MEMSTORE
    MEMTOOLS --> MEMDEC
    MEMSVC --> MEMSTORE
    APPROVALS --> MEMSVC
    MEMSTORE --> S_MEM
    MEMSTORE -.->|"生命周期刷新"| RETIDX
  end

  subgraph RET["统一检索（已实现；外部向量/重排部分验证）"]
    direction TB
    RETIDX["统一检索索引<br/>retrieval/index.js · 查询契约"]
    RETENG["检索引擎<br/>BM25 + exact + vector + RRF"]
    CONN["连接器<br/>memory · conversation<br/>document · web · code"]
    EMB["Embedding / Reranker<br/>可选 Provider"]
    KTOOL["knowledge_search 工具"]
    RET_MON_ROUTES --> RETIDX
    KTOOL --> RETIDX
    RETIDX --> RETENG
    RETENG --> CONN
    RETENG --> EMB
    RETIDX --> S_IDX
    CONN -.->|"只读"| S_MEM
    CONN -.->|"只读"| S_SESS
    EMB --> EMBP
  end

  subgraph AGRT["Agent Runtime 四阶段（已实现；运维闭环部分实现）"]
    direction TB
    MANIFEST["Manifest / Registry<br/>能力 · 契约 · 健康"]
    ROUTER["Router 控制面<br/>分类 · 匹配 · Policy · 选择"]
    TASKS["Task Store v2<br/>状态机 · 租约 · 重试 · run 历史"]
    WORKER["Worker Runtime（同进程）<br/>队列 · runId · 心跳 · checkpoint"]
    GATEWAY["工具权限网关<br/>任务白名单 ∩ Policy"]
    BOT["Memory Bot<br/>独立会话 · 加密凭证"]
    DELIVERY["Result Delivery<br/>bot-result-taskId · SSE snapshot"]
    WATCHDOG["外部 Watchdog / Supervisor<br/>健康 · 暂停接单 · 恢复 · 重启"]
    AGENT_ROUTES --> ROUTER
    AGENT_ROUTES --> APPROVALS
    ROUTER --> MANIFEST
    ROUTER --> TASKS
    WORKER --> TASKS
    WORKER --> GATEWAY
    GATEWAY --> MEMTOOLS
    GATEWAY --> KTOOL
    WORKER --> BOT
    BOT --> ADAPTER
    WORKER --> DELIVERY
    DELIVERY --> S_SESS
    DELIVERY --> AGENT_ROUTES
    AGENT_ROUTES -->|"结果 SSE"| APILIB
    WATCHDOG --> S_AGENT
    WATCHDOG --> S_WD
    WATCHDOG -.->|"读锁存活"| LOCK
    WATCHDOG -.->|"intake-pause"| ROUTER
  end

  subgraph OBS["可观测性与运维（已实现；灾备演练部分覆盖）"]
    direction TB
    MON["monitoring/*<br/>metrics · trace · health · alerts"]
    BACKUP["backup.js + scripts<br/>备份 · 恢复演练"]
    MON --> S_MON
    CORE_ROUTES --> MON
    BACKUP --> S_SESS
    BACKUP --> S_AGENT
  end

  subgraph STORES["数据存储（单机原子文件，单写者）"]
    direction TB
    S_SESS[("sessions.json<br/>会话与消息（权威）")]
    S_MEM[("memory.json<br/>长期记忆")]
    S_CONF[("persona / emotion / presence<br/>api-configs / api-keys")]
    S_AGENT[("agents/*<br/>tasks · sessions · events<br/>approvals · routing")]
    S_IDX[("retrieval/index.json<br/>派生索引，可重建")]
    S_MON[("monitoring/*<br/>指标 / Trace / 告警")]
    S_UP[("uploads/ · sticker-repo/")]
    S_WD[("watchdog/*.jsonl<br/>动作审计 / 熔断状态")]
  end

  subgraph EXT["外部依赖"]
    direction TB
    PROVIDER["模型供应商<br/>内置 DeepSeek / 自定义 OpenAI 兼容"]
    EMBP["Embedding / Reranker Provider<br/>生产端点未验证"]
    SCHED["OS 调度 / 服务管理器<br/>计划任务 · systemd · NSSM"]
  end

  subgraph PLANNED["规划 / 未实现（不参与当前运行链路）"]
    direction TB
    DIST["多进程 Worker / 分布式队列"]
    ACL["多用户 ACL（当前 local-owner）"]
    DOCX["PDF/DOCX 解析 · 查询改写"]
    HIGH["高危工具审批流（当前仅拒绝）"]
    VEC["记忆引擎神经向量（当前概念词典）"]
  end

  APILIB -->|"REST + Bearer"| AUTH
  AUTH --> CORE_ROUTES
  AUTH --> AGENT_ROUTES
  AUTH --> RET_MON_ROUTES
  CORE_ROUTES --> SESSIONS
  SESSIONS --> S_SESS
  CORE_ROUTES --> MEDIA
  MEDIA --> S_UP
  CORE_ROUTES --> AUX
  AUX --> S_CONF
  CORE_ROUTES --> PREP
  CORE_ROUTES -.->|"SSE"| APILIB
  RET_MON_ROUTES --> MON
  LOCK -.-> AUTH

  WORKER -.-> DIST
  AUTH -.-> ACL
  RETIDX -.-> DOCX
  GATEWAY -.-> HIGH
  MEMSEM -.-> VEC
  SCHED -.->|"仓库未安装"| WATCHDOG

  classDef impl fill:#f5f5f6,stroke:#c9c9d0,stroke-width:1px,color:#333333;
  classDef store fill:#ffffff,stroke:#9a9aa2,stroke-width:1px,color:#333333;
  classDef partial fill:#fbfbfb,stroke:#8f8f97,stroke-width:1px,stroke-dasharray:5 3,color:#333333;
  classDef planned fill:#ffffff,stroke:#bcbcc3,stroke-width:1px,stroke-dasharray:2 4,color:#8a8a90;
  class UI,HOOKS,APILIB,AUTH,CORE_ROUTES,SESSIONS,MEDIA,AUX,AGENT_ROUTES,RET_MON_ROUTES,PREP,CTX,AGENTLOOP,POLICY,ADAPTER,MEMSTORE,MEMDEC,MEMTOOLS,MEMSVC,APPROVALS,RETIDX,RETENG,CONN,KTOOL,MANIFEST,ROUTER,TASKS,WORKER,GATEWAY,BOT,DELIVERY,MON,PROVIDER impl;
  class MEMSEM,EMB,WATCHDOG,BACKUP partial;
  class S_SESS,S_MEM,S_CONF,S_AGENT,S_IDX,S_MON,S_UP,S_WD store;
  class DIST,ACL,DOCX,HIGH,VEC,SCHED planned;
  linkStyle default stroke:#b6b6be,stroke-width:1px;
```

## 模块说明

| 层 | 真实模块 | 职责 | 状态 |
| --- | --- | --- | --- |
| 客户端 | `App.tsx`、`components/*`、`hooks/*`、`lib/api/*`、`lib/stream.ts`、`lib/agent-results-stream.ts` | 单入口聊天界面；Modal 页面（记忆中心、Agent Team、任务、监控、模型、主题）；REST + SSE 网络层 | 已实现；**移动真机未验证**（Expo Web/RNTL 为准） |
| HTTP 边界 | `server/index.js`、`single-instance.js`、`api-configs.js` | Bearer 鉴权、CORS 白名单、限流、受控 JSON 错误、单实例锁、路由族 | 已实现 |
| 对话与上下文 | `prepareChatRequest`、`server/context/*`、`agent-runtime.js`、`agent-policy.js`、`model-adapter.js` | 上下文编排（历史/摘要/记忆/知识/裁剪/trace）、工具循环、策略、Provider 调用 | 已实现；视觉评测为 3 次多数制，非保证 |
| 记忆系统 | `memory.js`、`memory-decision.js`、`memory-lifecycle.js`、`memory-semantic.js`、`memory-service.js`、`tool-memory-*.js`、`agents/approvals.js` | 记忆 CRUD、生命周期、候选决策、检索打分、维护审批 | 已实现；**语义层是概念词典，不是神经向量** |
| 统一检索 | `server/retrieval/*`、`tool-knowledge-search.js` | 五源连接器、BM25/精确/向量融合、RRF、重排、查询契约、派生索引 | 已实现；外部 Embedding/Reranker **生产端点未验证** |
| Agent Runtime | `server/agents/*`、`scripts/bluebird-watchdog.js`、`scripts/bluebird-supervisor.js` | Router、Task Contract、租约/状态机、Worker、工具网关、结果投递、Watchdog/Supervisor | 四阶段已实现；checkpoint 不可续跑、多进程未启用、OS 调度未安装 |
| 可观测性 | `server/monitoring/*`、`docs/observability.md`、`backup.js`、`scripts/bluebird-*` | 指标/Trace/健康/告警、备份、恢复演练 | 已实现；**灾备离机验证与 agent store 演练未覆盖** |
| 数据存储 | `server/data/*`、`atomic-write.js`、`corruption.js` | JSON 权威存储、原子写、损坏隔离、上传与贴纸库 | 已实现；单写者、全文件重写 |
| 外部依赖 | DeepSeek / 自定义 OpenAI 兼容 Provider、Embedding/Reranker Provider、OS 调度 | 模型与向量能力、服务托管 | Provider 接口已实现；Embedding 生产未验证；OS 调度由部署方接入 |

## 关键依赖关系

1. **对话主链**：`/chat` 或 `/chat/stream` → `prepareChatRequest` → Context Runtime →（记忆检索 `searchMemories` + 知识检索 `retrieval`）→ 输入裁剪 → Agent 工具循环/Model Adapter → Provider。记忆或知识检索失败只降级，不阻断主对话。
2. **工具链**：Agent 工具循环依赖服务端工具注册表、Agent Policy、模型 `tools` 能力；工具结果只作为本轮消息，不写入会话历史。
3. **委派链**：`delegate_to_bot` / `POST /agent-tasks` → Router → Task Store → Worker Runtime → 工具网关 → Memory Bot（独立凭证）→ Result Delivery → 父会话 `bot-result-<taskId>` → `/agent-results/stream` → 客户端。
4. **记忆一致性**：`memory.json` 是权威源；`retrieval/index.json` 是派生索引，生命周期操作即时刷新，普通写入惰性同步；索引损坏可重建。
5. **持久化边界**：所有 JSON 写入经过 `atomic-write.js`，启动由单实例锁保证单写者；任务/会话/索引都不支持多进程并发写。
6. **监督链**：Watchdog 只读任务 Store 与锁文件；仅在服务锁缺失或 pid 已死时执行离线恢复；通过 `intake-pause.json` 影响 Router 接单。
7. **前端契约**：REST 统一走 `apiFetch`（Bearer + 超时 + AbortSignal），聊天与 Agent 结果分别使用 XHR SSE / 结果流；端点只在 `lib/api/endpoints.ts` 构造。

## 薄弱环节

| 级别 | 环节 | 事实与影响 |
| --- | --- | --- |
| 高 | 单机单写者 | 数据目录是内存缓存 + 全文件重写，`single-instance.js` 阻止多实例；任务队列、Worker、Watchdog 都未支持多进程/分布式。多实例部署会覆盖数据。 |
| 高 | 记忆语义能力 | `memory-semantic.js` 是 17 类概念词典，不是神经向量；记忆引擎的开放域语义召回仍是显式缺口。统一检索可接真实 Embedding/Reranker，但生产端点未验证。 |
| 中 | 记忆检索时间预算 | 同步扫描不可抢占：800ms 预算只在入口/出口检查，超预算标记 `degraded` 并保留部分结果，但不保证请求延迟上限；超时同时计入熔断失败。 |
| 中 | 索引刷新成本 | create/merge/supersede/confirm 都触发 `force` 全量同步（全量收集 + 索引写入）；高频写入下是 O(n) 成本，未做去抖或基准。 |
| 中 | Agent Runtime 运维闭环 | checkpoint 只记录进度、不恢复模型回合；`uncertain` 任务需人工；OS 计划任务/服务托管需部署方安装；真实服务杀进程/重启演练未自动化；Watchdog 阈值无 HTTP 配置。 |
| 中 | 单用户权限模型 | `permissions.js` 固定 `local-owner`，无多用户 ACL；高危工具只有拒绝门（无审批流），当前也未注册高危工具。 |
| 中 | 密钥与灾备 | 自定义 Provider API Key 明文存于 `api-keys.json`（文件权限保护）；备份默认排除密钥；离机灾难恢复未被本地路径证明；恢复演练未覆盖 agent task store。 |
| 低 | 验证覆盖边界 | 移动真机未验证；CI 使用 HTTP stub，真实本地 Qwen 仅手动验证；视觉回答为 3 次多数制；另有一次未定位的 agent-run 偶发失败（`REPAIR_ROADMAP.md` §6.7）。 |
| 低 | 检索能力边界 | PDF/DOCX 解析与查询改写未实现；document/web/code 为全局可见（单用户部署）；两条记忆检索路径（memory 引擎与统一检索 memory 连接器）存在规则维护成本。 |

## 阅读说明

- 图中“已实现”指代码与测试在该仓库内真实存在并通过门禁，不代表已在生产环境部署。
- “部分实现/未实现”按仓库文档与代码事实标注，不把规划项画进运行链路。
- 关键证据位置：`AGENTS.md`、`docs/agent-runtime-stage1..4.md`、`docs/memory-link-audit.md`、`docs/unified-retrieval.md`、`docs/observability.md`、`REPAIR_ROADMAP.md`。
