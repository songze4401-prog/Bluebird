# 云岫 Bluebird — Agent 工作策略系统 v1

日期：2026-10-29

基线：`main` @ `492a33d`（Context Runtime v3 + Agent Runtime V1）
分支：`qoder/agent-policy-2026-10-29`

## 1. 目标与边界

Agent Policy 与 Persona 是两套独立概念：

| 概念 | 负责 | 存储/入口 |
|---|---|---|
| Persona | 怎么表达、说话风格、连续消息模式 | `persona.json` / 现有控制面板 |
| Agent Policy | 怎么规划、检索、使用工具、处理失败、何时停止/确认 | `agent-policy.json` / 控制面板“Agent 工作方式” |
| Enforcement | 权限、预算、工具白名单、高风险确认门 | 后端 `agent-runtime.js` 强制执行 |

本版**没有**重写 Context Engine、Persona、记忆或工具实现；只在现有 Agent Runtime 上增加策略层。用户可编辑的 Policy 是非可信数据，不能注册新工具、任意 URL、shell 或代码执行能力。

## 2. 策略 schema 与默认值

文件：`BLUEBIRD_DATA_DIR/agent-policy.json`（默认为 `server/data/agent-policy.json`），单一事实来源。

```json
{
  "schemaVersion": 1,
  "mode": "bounded_autonomy",
  "planning": {
    "generatePlan": false,
    "stagedExecution": false,
    "resultSummary": false
  },
  "tools": {
    "allowedTools": null,
    "maxToolCalls": 12,
    "maxReadOnlyRetries": 0
  },
  "budgets": {
    "maxRounds": 3,
    "maxTotalMs": 90000
  }
}
```

| 字段 | 允许值 | 说明 |
|---|---|---|
| `mode` | `answer_only` / `plan_then_act` / `bounded_autonomy` | 只回答 / 先计划再执行 / 有界自主 |
| `planning.*` | boolean | 只影响提示词行为摘要；权限/预算仍由后端执行 |
| `tools.allowedTools` | `null` 或已注册工具名数组 | `null` 表示服务端已注册的全部工具；数组只能缩小集合 |
| `tools.maxToolCalls` | 1–12 | 单次 Agent 请求的工具调用总数上限 |
| `tools.maxReadOnlyRetries` | 0–1 | 只对只读工具的超时/内部错误自动重试一次 |
| `budgets.maxRounds` | 2–5 | 实际生效值还会被 `BLUEBIRD_AGENT_MAX_ROUNDS`（默认 3）截断 |
| `budgets.maxTotalMs` | 5000–120000 | 从请求开始计时；超时停止并报告 |

严格校验：未知字段、非法枚举、越界数值、错误类型、非法工具名、超过 16KB payload 全部拒绝。文件损坏时隔离保留原文件并使用安全默认值；隔离失败时拒绝写入，绝不放宽权限。

## 3. API 与 UI

| 方法 | 路径 | 语义 |
|---|---|---|
| GET | `/agent-policy` | 返回 `policy`、`defaults`、`meta`（revision/digest/corrupted）、`limits`、`runtimeLimits`、`availableTools` |
| PUT | `/agent-policy` | 整体保存 `{ policy }`；`{ reset: true }` 恢复服务端默认 |

两个接口都需要现有 Bearer 鉴权；UI 位于现有左上角设置 → 控制面板，不新增平行入口：

- “Agent 工作方式（服务端策略）”分区，和“本机设置/人格”明确分开；
- 自主程度、规划选项、工具白名单、高级预算/重试、保存/恢复默认；
- 显示策略版本、更新时间、损坏状态；保存失败保留当前编辑内容；
- 保存后明确提示“下一次 Agent 请求生效”。

## 4. Runtime 强制执行

请求链路：每次 `/chat` 或 `/chat/stream` 读取一次策略 → 门控 → `runAgentTurn` 使用规范化策略。

门控优先级（均在后端）：

1. `BLUEBIRD_AGENT_TOOLS !== '1'`：`switchOff`
2. 策略 `answer_only`：`policyAnswerOnly`（不暴露 tools）
3. 本次新图：`newImage`（保留既有视觉模型互斥）
4. 模型未声明 tools：`noToolsCapability`
5. 策略白名单没有可用工具：`policyNoTools`
6. 放行：`allowed`

运行时硬边界：

- `maxRounds`：与既有 `MAX_ROUNDS` 取小；末轮强制无 tools；
- `maxToolCalls`：达到后不再执行新工具调用；同批超出的调用被截断，并保留一次不带 tools 的收尾轮，由模型基于已取回结果生成正文；
- `maxTotalMs`：模型调用与工具调用前检查；单模型调用 timeout 也按剩余预算截断；
- 连续两次工具失败：`repeated_tool_failure` 停止；
- `maxReadOnlyRetries`：只读工具遇到 `tool_timeout`/`tool_error` 时最多重试一次；写入工具不自动重试；
- 高风险工具：`risk: high_risk` 的工具在后端一律返回 `confirmation_required`，当前没有已授权确认流程时**不执行**；本轮工具注册表没有高风险工具，因此默认行为不变；
- 工具白名单只能过滤已注册工具；未知工具仍 `unknown_tool`，越权写入仍 `unauthorized_write`。

停止原因：`tool_call_budget`、`total_time_budget`、`repeated_tool_failure`、`client_gone`。工具预算停止时会先尝试一次无工具收尾轮；最终仍没有模型正文时，路由返回受控的停止说明，不伪造工具成功。Bot 任务在同样情况下返回 `tool_call_budget` 而不是 `empty_reply`。

## 5. 可观测性

Context Trace 新增（不记录正文）：

- `policy`: schemaVersion、revision、digest、mode、allowedToolCount、maxRounds、maxToolCalls、maxTotalMs、gateReason、gateAllowed、corrupted；
- `agent`: rounds、toolCalls、readOnlyRetries、stopReason；
- 既有 `tools` 仍只记录工具名、ok、耗时、短码。

不记录用户提示、人格全文、工具参数、工具结果正文、检索正文、密钥或策略文件全文。

## 6. 测试证据

| 命令 | 实际结果 |
|---|---|
| `node tests/agent-policy.test.js` | **48/48**：schema/边界、API 鉴权/保存/重置、重启读取、写失败不覆盖、损坏隔离、answer_only（/chat + /chat/stream）、工具白名单、预算、确认门、trace 隐私 |
| `node tests/agent-tools.test.js` | 127/127（默认策略不改变既有 Agent 行为） |
| `npx jest tests/unit/agent-policy-ui.test.tsx --runInBand` | 2/2：服务端读取、保存 body、reset 请求 |
| Expo Web 实际运行（临时 API/临时数据） | 控制面板显示 Agent 分区；切换 `answer_only` 并保存后服务端 revision 2；恢复默认后 revision 3；未使用真实 `server/data` |
| `node scripts/verify-test-coverage.js` | backend **1392/1392**；nodeSuite **193/193**；runner **1199/1199**；frontend **113/113**；CI **40/40** |
| `npx tsc --noEmit` | 0 错误 |
| `npm run lint` | 0 errors |

## 7. 未验证 / 边界

1. **真实手机验收未执行**：当前环境没有移动设备；已做 Expo Web 实际运行、前端组件测试、TypeScript 与 lint，未声称真机通过。
2. **高风险确认流程**：已有后端 deny/`confirmation_required` 最小安全门，但没有“用户批准后执行”的完整交互；当前注册表中没有高风险工具，故不影响现有功能。未来加入高风险工具前必须补审批协议。
3. **并行工具**：运行时仍串行执行；策略没有暴露并行开关，避免虚报能力。
4. **规划/摘要**：`planning.*` 通过系统提示词约束模型输出，不保证模型一定展示计划/摘要；权限、预算、工具门控是硬执行。
5. **多用户**：策略是单用户共享配置；多用户部署前必须绑定用户身份、配置归属和 ACL。
6. **`maxRounds` 上限**：运行时仍受 `BLUEBIRD_AGENT_MAX_ROUNDS`（默认 3）限制；UI 会显示运行时实际上限。
7. **可逆写入**：`memory_remember` 归类为 `reversible_write`，用户可通过工具白名单禁用；当前没有逐次确认弹窗。
8. **Context 检索**：Context Engine 的 memory/knowledge 检索仍沿用既有链路；本策略控制 Agent 工具，不改变非 Agent 上下文行为。
9. **并行工具**：当前 Runtime 串行执行，策略不暴露并行开关。
