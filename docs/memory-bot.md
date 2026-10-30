# 云岫 Bluebird — Memory Bot 首期：基线审计与实现

日期：2026-10-31
目标来源：Notion《Bluebird Memory Bot｜首只专业 Agent 技术架构》
状态：首期骨架、独立凭证、双入口 Runtime、任务/事件与工作台已落地；完整记忆维护工具集与多用户 ACL 仍未实现，见第 7 节。

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
server/agents/
  manifest.js      # 仅 Memory Bot 的稳定 Manifest
  registry.js      # 注册、状态计算、可运行性检查
  config.js        # 独立模型/Prompt/工具配置（无 Key）
  credentials.js   # AES-256-GCM 凭证库、脱敏、验证
  sessions.js      # Bot 独立会话
  tasks.js         # 任务状态机 + 安全事件
  runtime.js       # 直接对话与委派共用执行循环
  routes.js        # /agents、/agent-tasks API
  errors.js        # 受控错误码
components/
  AgentTeamScreen.tsx
  MemoryBotScreen.tsx
```

数据文件（`BLUEBIRD_DATA_DIR/agents/`）：

| 文件 | 内容 | 安全 |
|---|---|---|
| `agents.json` | enabled、模型引用、参数、Prompt、工具白名单 | 无 Key；原子写；损坏时明确报错，不覆盖 |
| `agent-credentials.json` | `credentialId/providerId/keyHint/iv/tag/ciphertext` | AES-256-GCM；密文落盘 |
| `agent-vault.key` | 本地主密钥（未配置 env 时生成） | 尽力 chmod 0600；不提交 |
| `agent-sessions.json` | botId + sessionId + messages | 与主控会话分离 |
| `agent-tasks.json` | 任务状态、目标、结构化结果 | 不进事件；API 仅鉴权后可读 |
| `agent-events.json` | 安全事件 | 只允许状态/工具/耗时/错误码等白名单字段 |

主密钥优先取 `BLUEBIRD_AGENT_VAULT_KEY`（64 位十六进制）；未配置时生成 `agents/agent-vault.key`。Vault 解密同时校验 `botId + credentialId + providerId` 的 AAD，跨 Bot 读取直接拒绝。

## 3. 双入口 Runtime

```text
用户直接对话 ─┐
              ├─> MemoryBot Runtime ─> agent-runtime.runAgentTurn ─> Memory tools ─> memory.js
主控委派任务 ─┘                         │
                                        ├─ Bot 独立模型 + 加密 Key
                                        ├─ botId + sessionId 隔离
                                        └─ 任务状态/安全事件
```

- 直接对话：创建/恢复 Bot 会话，追加用户消息；调用同一 Runtime；保存用户与助手消息、工具摘要。
- 委派任务：`POST /agent-tasks` 创建 queued 任务；后台执行 accepted → running → completed/failed/cancelled/timed_out；结果包含摘要、工具摘要、记忆/知识 ID、变更与 `requiresConfirmation`。
- 取消：`POST /agent-tasks/:taskId/cancel` 标记取消并中止模型/工具调用；终态任务不可回写。
- 流式入口：`POST /agents/:botId/chat/stream` 返回 SSE；`meta`/`tool_start`/`tool_end`/`delta`/`done`/`error`。当前文本 delta 在完整回复后发送（final-only），不是逐 token 流；不把它描述成 token 级流式。

## 4. API

| 方法 | 路径 | 说明 |
|---|---|---|
| GET | `/agents` | 列出真实注册的 Bot 与状态 |
| GET | `/agents/:botId` | Bot 详情、模型、脱敏凭证 |
| GET/PUT | `/agents/:botId/config` | 读/写独立配置；`credentialId` 只能走凭证接口 |
| POST | `/agents/:botId/credentials` | 加密保存/替换 Key，返回 keyHint |
| POST | `/agents/:botId/credentials/verify` | 真实 `/models` 探测；不记录 Key |
| DELETE | `/agents/:botId/credentials/:credentialId` | 删除 Key，并清空引用 |
| POST/GET | `/agents/:botId/sessions` | 创建/列出 Bot 会话 |
| GET/DELETE | `/agents/:botId/sessions/:sessionId` | 读取/删除 Bot 会话 |
| POST | `/agents/:botId/chat` | 非流式直接对话 |
| POST | `/agents/:botId/chat/stream` | SSE（final-only 文本 + 工具事件） |
| GET | `/agents/:botId/events` | 安全事件 |
| POST | `/agent-tasks` | 主控提交任务（202 + queued） |
| GET | `/agent-tasks?botId=memory` | 任务列表 |
| GET | `/agent-tasks/:taskId` | 任务状态/结果 |
| POST | `/agent-tasks/:taskId/cancel` | 取消任务 |

所有接口复用 Bearer 鉴权与全局限流。凭证创建/验证/删除、配置更新、任务创建/取消写监控审计；审计不包含 Key、Prompt 或记忆正文。

## 5. 安全边界

- Key 只通过 HTTPS/本地回环服务端接口提交；Vault 只存密文；读取接口只返回 `keyHint`。
- 模型调用时服务端按 `credentialId` 解密并注入 Provider 客户端；不进入 Prompt、工具参数、事件或普通日志。
- 主控默认 Key 不会被 Bot 借用：测试 stub 拒绝全局 Key，Bot 调用必须使用自己的 Key。
- 跨 Bot 凭证读取被拒绝；首期一个 Bot 只保留一个活动凭证，替换时删除旧密文。
- Bot 会话与主控会话物理分离，Bot 会话不会出现在 `/sessions` / `/history`。
- 事件字段白名单；任务结果中的记忆/知识只保留 ID，不把正文写入事件。
- 任务目标/上下文会存于任务文件供用户查看，但不进入事件；不把 Key 或内部推理写进任务。
- `agents.json` / Vault / sessions / tasks / events 损坏时显式报错并拒绝覆盖，不静默重建。

## 6. 测试

- `node tests/memory-bot.test.js`：6 项，覆盖 Registry 状态、AES-256-GCM 密文/重启解密、脱敏、真实 `/models` 验证、Bot 会话、独立 Key 的真实工具循环、任务完成/取消、HTTP API 与 SSE。
- `npx jest tests/unit/memory-bot-screen.test.tsx`：2 项，覆盖团队页真实状态/预留位、工作台会话/回复/脱敏凭证。
- 既有后端 46 个测试文件（1547 项）+ 前端 18 套（164 项）保持通过（全量结果见交付报告）。
- Expo Web export 成功；浏览器 DOM 核对：左侧抽屉出现“Agent 团队”，团队页显示真实 Memory Bot 的“待配置/未绑定模型/未配置凭证”，工作台“独立对话 / 模型与 Key / 任务与事件”三页签可切换，配置页展示真实服务商列表、脱敏 Key 状态与加密保存入口。该次浏览器核对使用未配置模型的临时 API，因此没有把对话成功当作已验证；Bot 对话由真实 HTTP stub provider 的后端测试覆盖。

## 7. 尚未实现 / 边界

1. **记忆维护工具不完整**：Bot 当前只暴露 `memory_search`、`memory_remember`、`knowledge_search`；`get/list/explainRetrieval`、`merge/update/supersede/archive/withdraw/delete` 需要现有记忆引擎补齐稳定服务函数与审批协议，首期未伪造这些工具。
2. **人工审批协议**：没有 `approval.requested/resolved` 的执行闭环；危险/不可逆操作不注册为 Bot 工具。
3. **任务执行器**：单进程 `setImmediate` 执行，无持久队列、重启恢复或并发配额；进程重启后停留在 running 的任务不会自动续跑。
4. **多用户 ACL**：当前是单用户本地部署；`botId + sessionId` 已隔离，但没有多用户身份与文档 ACL。
5. **流式文本**：SSE 的文本 delta 是 full-text final-only；工具/状态事件是真实事件，不能宣称 token 级流式。
6. **UI 范围**：工作台提供独立对话、模型/Key 配置、任务与事件；Prompt 编辑、工具白名单编辑、任务创建表单未放入 UI，仍可通过 API 完成。
7. **其他 Bot**：只注册 Memory Bot；Research/Coding/Browser 等保持“预留 · 未注册”，不显示假在线。

## 8. 关键决策

- 不修改主控默认模型、主控会话或既有记忆生命周期；新增模块做增量接入。
- 不复用 `api-keys.json` 明文存储 Bot Key；独立 Vault 加密是安全边界，不是可选优化。
- 不在没有稳定服务函数时包装不存在的记忆维护能力；UI/文档明确显示缺口。
- 首期不引入微服务、分布式队列或多租户；模块化单体与现有 Express 部署一致。
