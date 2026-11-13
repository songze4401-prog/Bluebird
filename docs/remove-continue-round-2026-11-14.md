# 轮 R：删除「继续说」续写机制，让模型把话说完整（2026-11-14）

> Owner 指令：「后端那个继续说机制删了，让模型能把话说完整」。

## 1. 删除了什么

**续写机制的三段链路全部移除**（`server/index.js`，`isContinue` / `CONTINUE_INSTRUCTION` / `mode:'continue'` 在服务端零残留）：

1. **续写指令**：`CONTINUE_INSTRUCTION` 常量（「接着你自己上一条回复自然往下说…」的 systemPrompt 注入）删除；system 消息回归纯人格提示词。
2. **续写请求特判**：`mode === 'continue'` 不再被识别——`ctx.isContinue` 字段与全部 17 处分支删除，包括：附件/空消息校验分支、`userText`/`userMessageId`/`memoryQuery`/`userContent` 的三元回退、落盘「只落 assistant」分支、presence 守卫、长期记忆跳过、编排协议注入守卫、委派派发跳过、trace 收尾守卫——全部回归普通消息路径（无条件执行）。
3. **`scheduleMemoryExtraction` 签名**：删 `isContinue` 参数（续写守卫随之删除）。

## 2. 「让模型能把话说完整」的两个配套放大

1. **`maxTokens` 1200 → 8192**（主聊天与流式 4 处调用点）：1200 token 是回复说不完的根因——模型想说的被输出上限硬切，才需要「继续说」。8192 为 deepseek-chat 输出上限。
2. **`REPLY_MAX_CHARS` 默认 400 → 4000**（约 8k token 的汉字上限附近）：400 字触发消息分段的概率大幅下降；`BLUEBIRD_REPLY_MAX_CHARS` 环境变量仍可覆盖；`splitReplyIntoSegments` 的语义边界分片机制保留（只在上限时兜底）。

## 3. 行为变化

- `mode:'continue'` 请求不再被特判：无正文的该类请求按普通校验拒绝（400「消息不能为空」），有正文则当普通消息处理。
- 长回答一次性完整输出；超过 4000 字才会按语义边界分成多条消息（显示层行为，不是截断）。
- **前端配合项（另一对话的领域）**：「继续说」按钮与续写请求体（`mode:'continue'`）需从 UI 移除——后端已不识别该 mode。

## 4. 验收

- `tests/chat-stream.test.js`：续写用例替换为「机制已删除」断言（mode=continue 无正文 → 400；不产生落盘），**37/37 全过**（原 36 + 1）。
- 回归：chat-persist 23、chat-abort 9、time-gap 29 全过。
- 门禁：backend=2486/2486 runner=2256/2256 nodeSuite=230/230 frontend=190/190；其余五项全绿。
