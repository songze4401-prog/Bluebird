# P4 真实端到端验证（Context Engine → 真实 Provider → 工具调用）

日期：2026-11-03
脚本：`scripts/p4-real-e2e.js`
Provider：内置 DeepSeek（`https://api.deepseek.com`）
模型：`deepseek-chat`（Provider 回显 `deepseek-flash`，按既有约定只作为 `upstreamModel`）

## 1. 这份验证证明什么

链路是真实的，不是模块级拼接：

```text
真实 HTTP 入口 /chat 与 /chat/stream
  → Context Runtime v3（历史/摘要/记忆检索/输入保护/trace）
  → 真实 model-adapter（未替换 openai，未启动本地假 Provider）
  → 真实 DeepSeek HTTPS 请求
  → 真实模型返回 tool_calls（memory_search）
  → Agent 执行工具，把 tool 消息按 tool_call_id 回传
  → 下一轮真实 Provider 请求
  → 最终回复 + Context trace
```

脚本在 `model-adapter.createChatCompletion` 外只包一层观察器：记录实际收到的
`messages/tools/stream`，随后仍调用原函数完成真实网络请求；不替换实现、不返回
伪造 completion。每个 Context trace 轮次的 `contentHash` 都与观察器捕获的同一轮
messages 重新计算一致，因此可以核对“trace 记录的就是实际发出去的”。

## 2. 运行方式

```bash
BLUEBIRD_P4_REAL=1 DEEPSEEK_API_KEY=<真实 key> node scripts/p4-real-e2e.js
```

- 缺少 `BLUEBIRD_P4_REAL=1`、缺少 key、或显式声明了桩 Provider / 内网旁路时，
  脚本输出 `NOT VERIFIED` 并以退出码 2 结束，不会打印 PASS。
- 脚本使用独立临时数据目录，不读写 `server/data`，不改 `.env`，不打印 key。
- 不在 CI 运行；CI 的真实模型覆盖仍是未验证项。

## 3. 2026-11-03 实测结果

四次连续运行均为 **30/30 通过**，且 `/chat` 均在第一次尝试就触发工具调用
（`尝试次数=1`）。最终脚本运行的关键证据：

| 入口 | requestId | 真实调用轮数 | 工具 | 结果 |
| --- | --- | --- | --- | --- |
| `POST /chat` | `req_df8d96d5-4f32-452b-80e5-acd97e54d588` | 2 | `memory_search`（`call_00_XMZSehBPFhbtUPmPhfo47162`） | 200，非空回复 |
| `POST /chat/stream` | `req_3fe03611-3288-461d-b77b-ff14eb2a43e9` | 2 | `memory_search`（`call_00_0pxzUEALyfOaaRi9ktc17622`） | SSE `tool_start/tool_end/delta/done` 完整 |

`/chat` 的逐项证据：

- 真实 Provider 返回 `completionId=84134654-b96e-4515-9b95-572f0b5ee081`，
  `usage.prompt_tokens=3310`（同日多次运行 3306–3310），`completion_tokens=33`。
- 第一轮请求带 `memory_search` schema，真实模型返回 `tool_calls`；
  第二轮请求包含按 `tool_call_id` 配对的 `tool` 消息。
- `memory_search` 实际执行成功（`ok=true`），命中种子记忆 1 条。
- 上下文记忆块进入**真实 Provider 请求**的 system prompt；trace 记录
  `retrieval.accepted=1`、memory 块存在。
- trace `sent.rounds=2` 与真实调用数一致；两轮 `contentHash` 均为 2/2 一致。
- trace 记录 `providerId=deepseek`、`modelId=deepseek-chat`、
  `providerKind=configured`（非桩）。
- trace 记录真实 provider usage，`usageSource=provider`、`calibration=true`。
- trace 记录 `tools=[memory_search ok]`、`agent.rounds=2`、`toolCalls=1`，
  上下文验证 `ok=true`。
- trace 与进程日志均不含记忆正文哨兵、工具结果正文或 API key。
- `sent.consumed` 仍为 `null`，明确注明 HTTP 成功不等于模型已消费。

流式入口同样验证了：真实模型发起 `memory_search`、`tool_start`/`tool_end`
事件、工具结果回传下一轮、trace 轮数与哈希 2/2 一致、非桩 provider 标识、
上下文验证通过、无正文/key 泄露。流式 usage 依赖供应商末帧，本轮未被断言为
必须项；缺失时 trace 记 `usageSource=missing`，不猜数字。

## 4. 不证明什么 / 已知限制

1. **不证明语义消费**：工具被调用、结果被回传、回复非空，不等于模型在语义上
   使用了每条记忆；`consumed` 保持 `null`。
2. **流式 usage 不保证**：DeepSeek 流式响应可能不带末帧 usage；脚本只要求
   非流式 `/chat` 轮次有真实 usage。
3. **单模型/同日样本**：`deepseek-chat` 的工具调用行为可能随供应商版本波动；
   本报告记录同一天的四次完整运行（均 30/30），不把它外推为所有模型/
   所有时间的稳定性证明。
4. **不在 CI**：真实 key 不进 CI；CI 继续跑 `tests/context-engine-e2e.test.js`
   的桩级 HTTP 测试，两者不能互相冒充。
5. **Tokenizer 仍未校准**：工具轮 `prompt_tokens=3310`，trace
   `estimatedTokens≈2169`（比值 1.526）。该轮请求包含工具 schema，
   `inputGuard.toolsReserveTokens` 单独预留，因此这不是纯 tokenizer 误差；
   非工具轮的 P3 实测比值为 0.5152。单样本不足以修改全局估算系数。
6. **模型回显不可用于路由判断**：本次 `deepseek-chat` 请求的 `upstreamModel`
   回显为 `deepseek-flash`；脚本以实际下发的 `model/deepseek-chat` 为准。

## 5. 与既有测试的关系

| 测试 | 层次 | 能证明 | 不能证明 |
| --- | --- | --- | --- |
| `tests/context-engine-e2e.test.js` | 真实 HTTP + openai 桩 | 上下文/工具循环的结构行为，可进 CI | 真实模型、真实 Provider |
| `scripts/p3-real-model-check.js` | 真实 Provider，直接调用 runtime | 记忆块进入请求、真实 usage、哈希一致 | 真实 HTTP 入口、真实模型工具调用 |
| `scripts/p4-real-e2e.js` | 真实 HTTP 入口 + 真实 Provider | 上述两者的组合，含真实 `tool_calls` 与结果回传 | 语义消费、长期稳定性、流式 usage |

## 6. 安全边界

- key 只通过进程环境变量传入；脚本不读取、不修改 `.env`，不打印 key。
- 数据目录是 `os.tmpdir()` 下的独立目录；运行结束删除，不触碰 `server/data`。
- trace/日志隐私断言覆盖记忆正文哨兵与 key；失败只输出结构化原因，不输出请求正文。
