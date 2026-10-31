# 云岫 Bluebird — Memory Bot 首期：基线审计与实现

日期：2026-10-31
目标来源：Notion《Bluebird Memory Bot｜首只专业 Agent 技术架构》
状态：首期骨架、独立凭证、双入口 Runtime、持久任务队列、Token 级流式、记忆维护服务、人工审批、权限扩展点与工作台已落地；多用户 ACL 与分布式队列仍未实现，见第 9 节。

## 1. Step 0 基线审计

| 目标能力 | 现有代码 | 结论 | 处理 |
|---|---|---|---|
| 统一 Agent 执行循环 | `server/agent-runtime.js` `runAgentTurn`：工具白名单、轮数/时间预算、取消信号、工具事件 | 可复用 | Bot Runtime 直接调用，不复制循环 |
| 模型调用与错误归一化 | `server/model-adapter.js`：Provider 解析、OpenAI-compatible 调用、成本/错误分类 | 可复用但只读全局 Key | 增加可选 `credentialKey`/`signal`，默认行为不变 |
| 模型 Provider 注册 | `server/api-configs.js`：多 Provider、模型能力、脱敏 Key | 可复用 | Bot 配置引用 providerId/modelId；Key 走独立 Vault |
| API Key 存储 | `api-keys.json`，明文 + chmod 0600 | 不满足 Bot 隔离/加密目标 | 新建 AES-256-GCM Vault，不复用全局 Key |
| 会话 | `server/sessions.js`，主控会话全局列表 | 主控与 Bot 混用会泄漏 | 新建独立 `agent-sessions.json`，botId + sessionId 双键 |
| 记忆服务 | `server/memory.js` + `tools/memory-search.js` + `tools/memory-remember.js` | 可复用 | Bot 仅通过工具调用，写候选走 `applyCandidate` 生命周期 |
| 知识检索 | `server/retrieval/*` + `tools/knowledge-search.js` | 可复用 | 纳入 Bot 工具白名单 |
| 任务/事件 | 监控有部分运行记录，无任务 API | 缺口 | 新建任务状态机与安全事件存储 |
| 委派/Dispatcher | 无 | 缺口 | 新建 `/agent-tasks`，与直接对话共用 Runtime |
| UI | 聊天/记忆中心/模型/Agent 工具页 | 无 Bot 团队与工作台 | 新增 Agent 团队页、Memory Bot 工作台 |
| 鉴权/限流/审计 | `requireAuth`、全局限流、`auditAction` | 可复用 | Agent 路由全部复用；凭证操作写审计 |
| 原子写 | `server/atomic-write.js` | 可复用 | Config/Vault/Sessions/Tasks/Events 全部使用 |

关键冲突与取舍：

1. `model-adapter` 原先只接受全局 Provider Key。为满足“每个 Bot 独立 Key”，增加可选 `credentialKey` 覆盖；未传时逐字节保持原路径，主控配置不受影响。
2. 现有 `sessions.json` 没有 bot 维度。为避免迁移主控数据，新建独立 Bot 会话库；主控 `/sessions` 与 Bot 会话互不出现。
3. 现有记忆引擎没有 `merge` / `supersede` / `withdraw` 的独立服务函数。首期只把已有 `memory_search`、`memory_remember`、`knowledge_search` 纳入 Bot 工具；维护操作仍通过 Memory Center 与既有 API 执行，不伪造工具能力。
4. 现有 Agent 没有人工审批协议。首期不注册需要确认的危险工具；写入候选由既有生命周期返回 pending 并在任务结果里标记 `requiresConfirmation`。

## 2. 模块与数据

```text
server/memory.js              # 既有记忆引擎；新增显式维护方法，不改自动决策/提取
server/memory-service.js      # 维护服务门面：参数白名单、执行、结果摘要
server/agents/
  manifest.js                 # 仅 Memory Bot 的稳定 Manifest
  registry.js                 # 注册、状态计算、可运行性检查
  config.js                   # 独立模型/Prompt/工具配置（无 Key）
  credentials.js              # AES-256-GCM 凭证库、脱敏、验证
  sessions.js                 # Bot 独立会话
  tasks.js                    # 任务状态机、队列查询、安全事件
  runtime.js                  # 双入口 Runtime + 持久任务队列调度
  approvals.js                # 申请/待审批/批准/拒绝/执行/失败恢复
  result-delivery.js          # 统一结果投递：消息、去重、失败状态、SSE snapshot
  permissions.js              # 单用户权限检查 + 未来 ACL 扩展点
  routes.js                   # /agents、/agent-tasks、/agent-approvals API
  errors.js                   # 受控错误码
components/
  AgentTeamScreen.tsx
  MemoryBotScreen.tsx
lib/agent-stream.ts           # XHR SSE 客户端（token delta / 工具事件）
lib/agent-results-stream.ts   # 主控结果 XHR SSE（实时 + snapshot）
```

数据文件（`BLUEBIRD_DATA_DIR/agents/`）：

| 文件 | 内容 | 安全 |
|---|---|---|
| `agents.json` | enabled、模型引用、参数、Prompt、工具白名单 | 无 Key；原子写；损坏时明确报错，不覆盖 |
| `agent-credentials.json` | `credentialId/providerId/keyHint/iv/tag/ciphertext` | AES-256-GCM；密文落盘 |
| `agent-vault.key` | 本地主密钥（未配置 env 时生成） | 尽力 chmod 0600；不提交 |
| `agent-sessions.json` | botId + sessionId + messages | 与主控会话分离 |
| `agent-tasks.json` | 状态、目标、结构化结果、attempts、recoveredAt | 队列事实来源；事件不含正文 |
| `agent-events.json` | 安全事件 | 只允许状态/工具/耗时/错误码等白名单字段 |
| `agent-event-outbox.json` | 事件投递 outbox | 先持久化再写主事件文件；写失败时下次启动/读取补写 |
| `agent-approvals.json` | 审批 operation/payload/status/decision/result | chmod 0600；不写事件正文 |

主密钥优先取 `BLUEBIRD_AGENT_VAULT_KEY`（64 位十六进制）；未配置时生成 `agents/agent-vault.key`。Vault 解密同时校验 `botId + credentialId + providerId` 的 AAD，跨 Bot 读取直接拒绝。

## 3. 双入口 Runtime、队列与流式

```text
用户直接对话 ─┐
              ├─> MemoryBot Runtime ─> agent-runtime.runAgentTurn ─> Memory tools ─> memory.js
主控委派任务 ─┘                         │
                                        ├─ Bot 独立模型 + 加密 Key
                                        ├─ botId + sessionId 隔离
                                        └─ 持久任务队列 / 安全事件
```

- 直接对话：创建/恢复 Bot 会话，追加用户消息；调用同一 Runtime；保存用户与助手消息、工具摘要。
- 委派任务：`POST /agent-tasks` 创建 queued 任务；持久化队列按 `BLUEBIRD_AGENT_TASK_CONCURRENCY`（默认 2，1–4）并发执行；状态为 accepted → running → completed/failed/cancelled/timed_out。
- 队列恢复：服务启动时把 crash 时停在 accepted/running 的任务重新入队并记录 `task.recovered`；`waiting_approval` 不自动执行。队列是单进程持久化调度，不引入分布式队列。
- 失败处理：模型/工具/审批失败写入 `errorCode` 与终态，队列继续下一个任务；`BLUEBIRD_AGENT_TASK_MAX_ATTEMPTS` >1 时只对只读任务（未启用 `memory_remember`）的瞬时模型错误尝试重试，写入任务不自动重试，避免重复操作。
- 取消：`POST /agent-tasks/:taskId/cancel` 标记取消并中止模型/工具调用；终态任务不可回写。
- 流式：`POST /agents/:botId/chat/stream` 使用真实 Token 级 delta（来自 Provider 流式响应），保留 `tool_start`/`tool_end` 状态事件；工具轮不把参数或内部推理下发。UI 通过 XHR SSE 逐字渲染，并保留工具摘要。
- 主控派发：主 Agent 工具表新增 `delegate_to_bot`（仅主控可用，Bot 自身 allowlist 不包含它）；它校验 Bot 就绪、任务类型与工具边界，调用现有 `tasks.createTask` + `runtime.startTask`，任务带 `parentSessionId` / `parentMessageId`。主控任务页读取 `GET /agent-tasks?parentSessionId=...`，不是静态占位。
- 结果回传：任务完成/失败统一走 `result-delivery`：写入 Task Store 后，以固定消息 id `bot-result-<taskId>` 追加到父主控会话；记录 `deliveredToParentAt`、`deliveryMessageId`、`deliveryStatus` 或 `deliveryErrorCode`。主控前端通过 `GET /agent-results/stream?sessionId=...` 接收实时 `result`/`delivery_failed`，snapshot 覆盖断线重连；前端按消息 id 去重，因此重复投递不会生成第二条。任务页继续作为审计/状态入口。
- 事件可靠性：`appendEvent` 先写持久 outbox，再写主事件文件；主文件写失败时事件仍在 outbox，启动/读取时重试，不再被 `safeEvent` 静默丢弃。

## 4. 人工审批与权限

```text
维护申请 pending → approved / rejected
                         ↓
                    execute（仅 approved）
                         ↓
              memory-service → memory.js → completed / failed
```

- 所有维护操作（update/merge/supersede/archive/withdraw/delete）默认要求审批；`permissions.checkOperation` 在未批准时返回 `approval_required`。
- 审批记录保存 operation、payload、风险级别、请求人、决定人、时间、执行人、结果/错误码；完整事件为 `approval.requested` / `approval.resolved`。
- `approved` 只是批准决定，**不能**直接执行；必须调用 `execute`。执行器再次做权限检查，并只调用 `memory-service`。
- 执行失败、记忆目标不存在、生命周期不允许等都会落为 `failed` 并保留受控 `errorCode`；不伪造 completed。
- 当前是单用户模式：`permissions.js` 固定 `local-owner`，但保留 `extensionPoint`（多用户关闭、ACL 解析入口名称）；未来替换为真实用户/角色解析时不改 Runtime/审批执行器。
- 高风险维护操作没有注册为模型工具；模型只能检索/候选写入，维护申请由已鉴权 API/UI 发起，避免模型自主触发不可逆操作。
- 既有 Memory Center 的用户主动操作（例如用户在记忆详情里点归档/删除并确认）保留原有直接语义；本审批闭环约束的是 Memory Bot/自动维护路径，不把用户自己的操作再套一层审批。两者都不绕开 `memory.js` 的生命周期与落盘规则。

## 5. 记忆维护稳定接口

`server/memory-service.js` 是唯一维护门面；`server/memory.js` 内新增方法复用既有内存状态、写队列、状态/有效期与原子落盘：

| 操作 | 行为 | 状态/审计 |
|---|---|---|
| update | 更新现有 active 条目内容/类型/关键词/置信度/有效期/条件 | 保留 id 与 contributions，`lastDecision.action=update` |
| merge | 把一个或多个同类型 active 来源合并到目标；贡献取并集，关键词/置信度合并 | 来源标为 superseded、记录 supersededBy；目标是 active |
| supersede | 创建替换条目，旧条目标为 superseded | 新条目继承旧条目贡献；保留历史 |
| archive | 归档 active 条目 | `status=archived`，validTo 写入 |
| withdraw | 按会话摘除贡献；仍有其他贡献则保留条目，否则归档；不是物理删除 | `lastDecision.action=withdraw` |
| delete | 物理删除条目 | 仅通过审批执行器调用 |

参数只接受白名单字段；未知字段、非法类型/时间/置信度、跨类型 merge、来源不存在等返回明确错误，不静默降级。

## 6. API

| 方法 | 路径 | 说明 |
|---|---|---|
| GET | `/agents` | 列出真实注册的 Bot 与状态、工具白名单、权限模式 |
| GET | `/agents/:botId` | Bot 详情、模型、脱敏凭证 |
| GET/PUT | `/agents/:botId/config` | 读/写独立模型、Prompt、工具白名单；`credentialId` 只能走凭证接口 |
| POST | `/agents/:botId/credentials` | 加密保存/替换 Key，返回 keyHint |
| POST | `/agents/:botId/credentials/verify` | 真实 `/models` 探测；不记录 Key |
| DELETE | `/agents/:botId/credentials/:credentialId` | 删除 Key，并清空引用 |
| POST/GET | `/agents/:botId/sessions` | 创建/列出 Bot 会话 |
| GET/DELETE | `/agents/:botId/sessions/:sessionId` | 读取/删除 Bot 会话 |
| POST | `/agents/:botId/chat` | 非流式直接对话 |
| POST | `/agents/:botId/chat/stream` | SSE；真实 token delta + 工具/状态事件 |
| GET | `/agent-results/stream?sessionId=...` | 主控结果 SSE；snapshot + 实时结果/投递失败事件 |
| GET | `/agents/:botId/events` | 安全事件 |
| GET | `/agents/:botId/permissions` | 单用户权限配置与扩展点 |
| POST/GET | `/agents/:botId/approvals` | 创建/列出审批申请 |
| GET | `/agent-approvals/:approvalId` | 审批详情 |
| POST | `/agent-approvals/:approvalId/approve` | 批准（不等于执行） |
| POST | `/agent-approvals/:approvalId/reject` | 拒绝 |
| POST | `/agent-approvals/:approvalId/execute` | 仅 approved 可执行 |
| POST | `/agent-tasks` | 主控提交任务（202 + queued） |
| GET | `/agent-tasks?botId=memory` | 任务列表 |
| GET | `/agent-tasks/:taskId` | 任务状态/结果 |
| POST | `/agent-tasks/:taskId/cancel` | 取消任务 |

所有接口复用 Bearer 鉴权与全局限流。凭证、配置、审批、任务写监控审计；审计/事件不包含 Key、Prompt、记忆正文或模型推理。

## 7. 安全边界

- Key 只通过 HTTPS/本地回环服务端接口提交；Vault 只存密文；读取接口只返回 `keyHint`。
- 模型调用时服务端按 `credentialId` 解密并注入 Provider 客户端；不进入 Prompt、工具参数、事件或普通日志。
- 主控默认 Key 不会被 Bot 借用：测试 stub 拒绝全局 Key，Bot 调用必须使用自己的 Key。
- 跨 Bot 凭证读取被拒绝；首期一个 Bot 只保留一个活动凭证，替换时删除旧密文。
- Bot 会话与主控会话物理分离，Bot 会话不会出现在 `/sessions` / `/history`。
- 维护操作未批准不能执行；执行器只调用 `memory-service`，不能直接改写记忆文件。
- 事件字段白名单；任务结果中的记忆/知识只保留 ID，不把正文写入事件；审批 payload 存于审批文件，不写事件。
- `agents.json` / Vault / sessions / tasks / events / approvals 损坏时显式报错并拒绝覆盖，不静默重建。
- 单用户权限检查显式保留扩展点；没有多用户 ACL 时不宣称支持多租户。

## 8. 测试

- `node tests/memory-bot.test.js`：7 项，覆盖 Registry、AES-256-GCM 密文/重启解密、真实 `/models` 验证、Bot 会话、独立 Key 工具循环、任务/审批 API、token SSE/工具事件、并发队列/恢复/失败隔离。
- `node tests/memory-maintenance.test.js`：5 项，覆盖 update/merge/supersede/archive/withdraw/delete、维护门面白名单、审批闭环、事件不含正文、权限拒绝。
- `node tests/agent-dispatch.test.js`：7 项，覆盖主控工具派发、结果 SSE/snapshot、失败回传、重复投递防护、主 Agent 工具循环与事件 outbox 恢复。
- `npx jest tests/unit/memory-bot-screen.test.tsx`：3 项，覆盖团队页、工作台/流式回退、Prompt/工具白名单、任务表单、审批操作。
- 全量：`npm test` 48 个后端文件 / 1560 项；Jest 18 套 / 166 项；覆盖率校验 backend 1560/1560、runner 1339/1339、frontend 166/166；tsc/lint 通过（以最终交付命令输出为准）。
- Expo Web export 成功；浏览器 DOM 核对：Agent 团队入口、真实 Memory Bot 状态、工作台三页签、配置页真实服务商/脱敏 Key、维护申请表单与审批列表可渲染；浏览器实际提交一条 update 维护申请后，服务端返回 pending 并在审批列表显示。

### 8.1 Stub 与真实模型测试区分

- **CI/单元测试（Stub）**：`tests/memory-bot.test.js` 使用真实 HTTP OpenAI-compatible stub，确定性验证 key 隔离、工具循环、SSE 多段 delta、工具事件、审批 API 与任务队列。它不代表真实模型质量。
- **真实模型 E2E（2026-10-31）**：本机真实 `Qwen2.5-0.5B-Instruct` ONNX int8 权重，经本地 OpenAI-compatible HTTP 服务提供 `/v1/chat/completions`（stream=true）。Bluebird 后端配置该 Provider 与 Bot 独立加密 Key（本地服务只接受该 Bot Key；全局 Provider Key 为拒绝值）。`POST /agents/memory/chat/stream` 实测返回 24 个 token delta、最终 `done` 与 Bot session，无 error，耗时约 4.7s；工作台浏览器也通过同一端点收到并显示了流式助手文本，`model-adapter` 日志记录完成。证明真实模型 HTTP SSE、UI 流式渲染与 Bot 凭证链路可用。
- **真实模型质量边界**：0.5B int8 模型在 CPU 上生成内容质量有限，本轮只验证协议、流式、会话与凭证隔离，不把回答质量当作产品验收；模型文件和临时服务不在仓库内。
- **结果回传 UI E2E（2026-10-31，Stub）**：Expo Web + 本地 OpenAI-compatible stub（非真实模型质量）+ Memory Bot 独立 Key。主控实际发送后经 `delegate_to_bot` 派发 3 个任务（2 完成、1 失败），成功与失败消息均在 `/agent-results/stream` 连接上即时显示、无需刷新；重启后端后 SSE 自动重连，snapshot 返回 3 条唯一结果，前端仍为 3 条、无重复；任务页显示同一批 3 条任务及“已回传主控”。该验证证明事件驱动展示、失败回传、重连快照与幂等去重，不代表真实模型回答质量。

## 9. 尚未实现 / 边界

1. **多用户 ACL**：仍是单用户本地部署；`botId + sessionId` 已隔离，`permissions.js` 保留扩展点，但无用户身份/文档 ACL。
2. **分布式任务队列**：持久化队列是单进程；没有跨进程 worker、分布式锁或重启后保留 in-flight 模型连接。
3. **自动重试**：默认 `maxAttempts=1`；只有显式提高 `BLUEBIRD_AGENT_TASK_MAX_ATTEMPTS` 且任务未启用 `memory_remember` 时，才对瞬时模型错误重试。有副作用的维护/写入任务不自动重试；失败会显式落库并继续队列。
4. **审批发起 UI**：工作台已提供维护申请表单（update/merge/supersede/archive/withdraw/delete），申请仍必须经批准与独立执行；未提供批量申请或审批模板。
5. **其他 Bot**：只注册 Memory Bot；Research/Coding/Browser 等保持“预留 · 未注册”。
6. **记忆维护模型工具**：维护操作只通过已鉴权审批接口执行，没有注册为模型可自行调用的工具；这是防止模型自主触发不可逆操作的安全边界。

## 10. 关键决策

- 不修改主控默认模型、主控会话或既有记忆自动决策；维护方法复用同一份状态/落盘规则。
- 不在没有审批的情况下执行高风险维护；不把 pending/approved 当作 completed。
- 不复用 `api-keys.json` 明文存储 Bot Key；独立 Vault 加密是安全边界。
- 首期不引入微服务、分布式队列或多租户；模块化单体、持久化 JSON 与现有 Express 部署一致。
- 流式输出只在 Provider 真正返回流时发送 token delta；工具调用参数与内部推理不下发。

## 11. 本轮推进顺序（P0 → P1 → P2）

| 阶段 | 实际实现 | 验收证据 |
|---|---|---|
| P0 主控派发 + 结果回传 + 事件 outbox | 主 Agent `delegate_to_bot` 工具、`parentSessionId`、Result Delivery SSE、任务页真实读取、事件 outbox | `tests/agent-dispatch.test.js` 7 项 |
| P0 记忆维护 + 人工审批 | `memory.updateMemory/mergeMemories/supersedeMemory/withdrawMemory` + `archive/delete` 复用；`memory-service` 白名单；`approvals` 状态机与 API | `tests/memory-maintenance.test.js` 5 项；审批 API 前后状态测试 |
| P1 任务队列 + 流式 + UI | 持久化队列并发/恢复/失败隔离；Provider token delta；Prompt/工具白名单/任务表单/审批操作 UI | `tests/memory-bot.test.js` 7 项；SSE/tool event 测试；Jest 3 项 UI 测试 |
| P2 权限扩展点 + 回归 | `permissions.js` 单用户检查 + extensionPoint；维护申请表单；文档/CI/覆盖率基线 | `npx tsc --noEmit`、`npm run lint`、全量覆盖率校验、真实模型 HTTP SSE E2E |

“P2 回归”中的全量结果以 `scripts/verify-test-coverage.js` 输出为准：backend 1560/1560、nodeSuite 221/221、runner 1339/1339、frontend 166/166、CI 48/48。
