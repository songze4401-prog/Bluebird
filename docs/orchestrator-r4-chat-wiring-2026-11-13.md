# Orchestrator 轮 4：主聊天接线（2026-11-13）

> 依据：`docs/orchestrator-charter-2026-11-13.md` 轮 4。代码基准：`main` = PR #78 合并后。

## 1. 实现

### 1.1 `server/orchestration-chat.js`（orchestration-chat-v1）

主聊天编排接线的全部逻辑集中在一个模块（纯函数优先，执行委托给 plan-compiler / orchestration-engine）：

- **`extractPlanBlock(reply)`**：提取 ```bluebird-plan 围栏块（首条）并剥离出正文；JSON 解析失败返回 `parsed:null`（调用方降级）。
- **`buildPromptAppendix(capabilities)`**：开关开启时追加给模型的协议说明；能力清单由调用方传入（Manifest 动态生成，不硬编码），含块格式示例、≤8 节点、dependsOn 语义与「简单任务不要输出此块」。
- **`wireOrchestration({policy, reply, userText, userId, sessionId})`**：
  - **开关关闭 → 原文返回**（`reason:'disabled'`，不触达任何解析——直答路径零行为差异）；
  - 开启 + 合法计划块 → 剥块 → `planCompiler.compilePlan`（模型 agent 名丢弃并审计）→ `orchestrationEngine.orchestrateDAG`（**父会话 = 当前聊天会话**，编排结果经 deliverPlanOutcome 回写到会话）→ 用户可见回复 = 剥块正文 + 派发回执（`[已编排] 已按计划派发 N 个任务（planId…），完成后自动回传`）；
  - 任何失败（bad JSON / 编译失败 / 编排失败）→ **降级为剥块后的普通回复**（`reason` 保留错误码 + console.warn），用户请求绝不失败（立项书不变量 16）。

### 1.2 `agent-policy.js`：`orchestration` 开关块

`DEFAULTS.orchestration = { enabled: false, maxNodes: 8 }`（默认关闭 = D7 姿态）；`TOP_KEYS` 增 `orchestration`，校验块为**可选**（缺省 = 默认关闭，旧客户端 PUT 旧四键形状不受影响）；`enabled` 必须布尔、`maxNodes` 钳 1..8。既有 `GET/PUT /agent-policy` 自动获得读写面。

### 1.3 `index.js` 接线点

- **/chat agent 路径**：`runAgentTurn` 返回后调 `wireOrchestration`，`rawReply` 替换为剥块+回执文本后走既有 `auditChatReply`/`completeChatTurn` 落盘；响应 JSON 增 **additive** 字段 `orchestration: {planId, planVersion, nodeCount, status}`（未派发时该键不出现）。
- **/chat/stream agent 路径**：同一接线（emit delta 前剥块），`done` 事件带同一 `orchestration` 回执字段。不新增 SSE 事件类型。
- **协议注入**：`agentOn && enabled` 时把 appendix 并入首条 system 消息（`withOrchestrationAppendix` 返回新数组，不改入参）；能力清单 = `listManifests()` 各主体 `capabilities ∩ acceptedTaskTypes` 的并集（动态）。开关关闭不注入（模型侧零变化）。

## 2. 验收（`tests/agent-chat-orchestration.test.js`，7 例全过）

| 组 | 覆盖 |
|---|---|
| a | extractPlanBlock 提取/剥离/bad JSON |
| b | wireOrchestration 关闭 → 原文返回（零行为差异单测） |
| c1 | GET /agent-policy 默认 `{enabled:false, maxNodes:8}` |
| c2 | 开启后 /chat：计划块 → 剥块 + `[已编排]` 回执 + 响应 `orchestration` 回执（nodeCount=2、planId 前缀 plan_pc_）+ 编排真实落库（节点 agent = memory/researcher）+ 编译产物落盘 + **协议注入断言**（stub 捕获 system 消息含协议） |
| c3 | 未知 taskType → 降级直答（剥块、无编排键、plan.rejected 事件落审计） |
| d | /chat/stream：done 事件带 orchestration 回执 |
| e | 关闭开关：计划块按普通文本渲染、无编排键、**stub 捕获确认关闭轮次不注入协议** |

测试基建：openai 模块桩（进程内拦截，不真正请求模型）+ `PORT=0` 进程内启动服务器 + 四 bot 显式启用与凭据（注册表状态机要求每 bot 有凭据条目，否则 degraded——实现中真实踩到并修正）。

## 3. 边界与如实标注

1. **计划块不进持久消息**：剥块在落盘前完成，会话历史不含原始 JSON 块。
2. **回执是纯文本追加**：不改变消息契约；编排结果按既有 `bot-result-<planId>` 通道回写父会话（轮 3 交付面）。
3. **多轮编排没有去重锁**：同一用户连发多条计划块消息会各自派发（幂等键含 planId，不同计划不同血缘）；风暴防护沿用编译器 ≤8 节点与任务级预算。
4. `maxNodes` 目前是声明位（编译器硬上限 8 不变）；chat 侧未把 policy.maxNodes 传给编译器收紧（后续如需按会话收紧再接线）。
6. 直答路径（无块/开关关）在响应与落盘上逐字节不变（c2/e 的 stub 捕获断言锁定）。

## 4. 计数与门禁

- 新增 `tests/agent-chat-orchestration.test.js`（7 例）；基线 backend 2465 → 2472、runner 2235 → 2242、文件 124 → 125；`sync-doc-counts.js` 同步。
- 相邻回归：agent-policy / workflow-store / plan-compiler 26 例全过。
