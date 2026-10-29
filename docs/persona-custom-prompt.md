# 自定义人格提示词（persona customPrompt）

控制面板里用户自己写的一段人格描述。它扩展现有 `persona.json`，不是第二套人格系统：
滑块、消息模式、`server/persona.js`、`GET/PUT /persona`、原子写入与损坏保护全部沿用原样。

## 字段

`PersonaConfig.customPrompt: string`，上限 `server/persona.js` 的 `CUSTOM_PROMPT_MAX_CHARS = 4000`（按码点计）。
`GET /persona` 同时下发 `limits.customPromptMaxChars`，前端字数提示直接用服务端的值，不写死数字。

## 优先级（后端强制执行，不依赖模型自觉）

1. 系统安全规则、工具门控、授权与运行时限制 —— 最高，自定义文本无法改变。
   工具集只由 `BLUEBIRD_AGENT_TOOLS` 开关和 `server/agent-runtime.js` 的注册表决定，
   读取路径完全不碰 persona；`tests/persona.test.js` 断言：开关关闭时下发给模型的请求不带
   `tools`，开关打开时工具集合恰为注册表内容，与自定义文本写的是什么无关。
2. 自定义人格提示词 —— 人格、语气、互动偏好。
3. 滑块与消息模式 —— 结构化参数。与自定义文本冲突时，注入块里明确写「以这段设定为准」；
   但回复拆成几条消息始终由后端 `splitReplyIntoSegments` 按 `messageMode` 决定，写进边界声明里。
4. 单轮任务指令与上下文照常处理，persona 不特殊化。

## 不可信数据处理

- 存原文（面板要能看到自己写的字），渲染时才中和：`neutralizeContextText` 会把
  `【…】` 转成 `「…」`、`<<<…>>>` 换成占位文本、`system:` 这类行首角色标记改成全角冒号，
  所以自定义文本无法伪造区块边界或角色行。
- 落盘前只做可读性归一：`\r\n` → `\n`、剔除 C0 控制字符（保留 `\t` `\n`）、按码点截断到上限。
- 空字符串（含只有空白）时整块不注入，最终 system prompt 与改造前逐字一致，不留空白占位。

## 校验与错误码

读盘宽松、写盘严格：

- `normalizeConfig`（读 `persona.json`）：字段缺失或类型不符 → 回退默认值；超长 → 截断。
  旧版本写下的、没有 `customPrompt` 的文件因此平滑迁移成空串，其余值一个不动。
- `validateConfig`（`PUT /persona`）：`customPrompt` 非字符串或超长、滑块非数字、
  `messageMode` 非法值 → 整份拒绝，`400 invalid_config`，`error` 里带中文原因；
  被拒绝时 `persona.json` 逐字节不变，用户刚写的文字也不会丢。
- `409`：`persona.json` 已损坏，原地只读保护（与 `sessions.json` 同一策略），拒绝覆盖。
- `500`：落盘失败（`persona_write_failed`，日志只记 `name`/`code`，不记内容）。
- `PUT /persona` 是整份替换语义：提交对象里没出现的键回默认值。面板始终提交完整 config。

## 生效路径

`/chat` 与 `/chat/stream` 共用 `prepareChatRequest` → `getPersonaConfig()` 每轮重读，
所以保存后下一次请求就用新配置；自定义块挂在 persona 系统块内（`priority 25`、`critical: false`），
输入保护阶段若需裁剪，它和情绪/表情包块一样按优先级让位，决策记在 `trace.build.dropped`。

## 测试

- `node tests/persona.test.js`（68 项）：默认值与上限下发、旧配置迁移、换行归一、
  类型/长度/请求体三重校验且旧配置逐字节不动、恢复默认一并清空、未授权拒绝、
  `/chat` 与 `/chat/stream` 最终请求（捕获真正下发给模型的 `params`）含自定义原文、
  改完下一轮即生效、空值不注入、恶意文本被中和、工具门控不受影响、损坏期拒绝写入。
- `tests/unit/persona-custom-prompt-ui.test.tsx`（5 项）：编辑区读取服务端值与上限、
  保存提交完整 config、`400` 回显原因并保留草稿、网络失败不误报成功、恢复默认后编辑框清空。

## 已知边界

- 上限 4000 码点是长度约束，不是语义审查：写得再长也只是占用上下文预算，
  超预算时该块会被裁剪（可在 trace 里看到）。
- 提示词里的边界声明是「让模型不把它当提权指令」的表述层；真正的强制力在第 1 条的代码层门控。
- 本模块不引入新依赖、不做嵌入或向量化，自定义文本只作为 system prompt 的一部分下发。
