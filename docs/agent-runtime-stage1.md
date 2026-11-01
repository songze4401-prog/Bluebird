# Agent Runtime 一期：Router 路由与控制面

状态：已实现（2026-11-01），分支 `qoder/agent-runtime-stage1-2026-11-01`（未合并）。
范围：Notion《Bluebird 下一代 Agent Runtime》「阶段 1：Router 路由与控制面」。
配套代码：`server/agents/router.js`、`server/agents/routing-config.js`、`server/agents/tasks.js`、`server/agents/manifest.js`、`server/agents/registry.js`、`server/tool-dispatch-bot.js`、`server/agents/routes.js`。

## 1. 目标与非目标

**目标**：把分散的 Bot 选择与委派逻辑收敛为唯一调度入口。所有委派（主 Agent 的 `delegate_to_bot` 工具、`POST /agent-tasks`）都经过同一条决策链：

```
任务分类 → 能力匹配 → Policy 校验 → 选择 Agent → 创建任务 → 投递队列
```

**本期不做**（与路线图「明确不做的事」一致）：

- 不引入 Redis / Kafka / Kubernetes / 微服务；
- 不启动多进程共同写同一批状态文件；
- 不把主控完整上下文复制给 Worker（`contextRef` 目前只是引用标识，不负责取上下文）；
- 不实现 Worker 生命周期、上下文投影、租约与进程外 Watchdog（阶段 2–4）。

## 2. 架构决策记录（ADR）

### ADR-01：所有委派必须经过 Router

- **决策**：`delegate_to_bot` 保留原工具 schema 与成功返回形状，但内部改为调用 `router.dispatch()`；`POST /agent-tasks` 同样改为调用 Router。两条入口共享分类、能力匹配、Policy 校验、选择、建任务与入队逻辑。
- **理由**：此前两条入口各自做部分校验（工具层查 registry 状态，API 层直接 `createTask`），拒绝语义与可观测性不一致。集中后「相同输入 + 相同策略 → 相同结果」可以只在一处证明。
- **后果**：
  - Router 的错误码（`agent_not_available` 等）在工具层被翻译回既有短码（如 `bot_not_ready`），模型侧行为不变；
  - 直接建任务的 API 在 Agent 未就绪/队列满时由「先建任务、执行时再失败」改为**入队前明确拒绝**；
  - Router 只做控制面，不执行模型调用；执行仍由 `server/agents/runtime.js` 完成。

### ADR-02：Task Contract v1 冻结字段

任务规范字段（`contractVersion = 1`）：

| 字段 | 说明 |
| --- | --- |
| `taskId` | 稳定任务 ID |
| `agentId` | 规范字段；`botId` 保留为同值兼容别名 |
| `workerSessionId` | 执行会话；`sessionId` 保留为同值兼容别名 |
| `parentSessionId` | 父主控会话（也是委派任务的记忆 scope） |
| `taskType` | 必须在目标 Agent 的 `acceptedTaskTypes` 中 |
| `priority` | `high` / `normal` / `low`，决定出队顺序 |
| `deadlineMs` | 5000–120000，运行时强制执行 |
| `allowedTools` | 只能是目标 Agent 有效工具白名单的子集 |
| `contextRef` | 可选的上下文引用标识（≤200 字），本期不负责解析 |
| `idempotencyKey` | 同一 Agent 内唯一；重复提交返回既有任务 |
| `status` | 既有任务状态机，不改语义 |
| `route` | 路由快照：`routeId` / `path` / `capability` / `policyDigest` / `decidedAt` |
| `budget` | 路由冻结的执行预算：`maxRounds` / `maxToolCalls` / `maxReadOnlyRetries` / `generatePlan` |

- 旧任务只有 `botId` / `sessionId`；`loadTasks()` 读取时补齐 `agentId` / `workerSessionId` / `contractVersion` / `priority` / `contextRef` / `idempotencyKey` / `route` / `budget`，值与原字段一致，并尽力回写一次。
- 阶段出口要求后续阶段复用这组字段，不得另造一套任务字段。

### ADR-03：Fast / Slow 是确定性分类 + 预算快照

分流规则按固定顺序判定，结果带 `pathReason`：

1. `taskType` 在 `slowTaskTypes` 中 → `slow`（`task_type_requires_planning`）；
2. `goal` 长度 > `fast.maxGoalChars` → `slow`（`goal_exceeds_fast_limit`）；
3. `context` 长度 > `fast.maxContextChars` → `slow`（`context_exceeds_fast_limit`）；
4. 否则 → `fast`（`within_fast_limits`）。

默认预算（`agents/agent-routing.json`）：

| 路径 | maxRounds | maxToolCalls | maxReadOnlyRetries | generatePlan |
| --- | --- | --- | --- | --- |
| fast | 3 | 6 | 1 | false |
| slow | 4 | 6 | 1 | true |

Fast 预算与改动前 Memory Bot 的行为一致（无回归）；Slow 多一轮、并注入「先给简短行动摘要」的服务端策略提示。**预算在创建任务时快照进 `task.budget`**，执行时不再读当前配置——配置变更不会改变已入队任务的语义。

## 3. 接口变更

- `POST /agent-tasks` 新增可选字段：`agentId`（与 `botId` 等价）、`contextRef`、`priority`、`idempotencyKey`、`parentUserText`、`workerSessionId`（与 `sessionId` 等价）。响应仍为 `202 { task }`，任务对象新增上述规范字段与 `route` / `budget`。
- `delegate_to_bot`：工具名、参数 schema、成功返回字段（`taskId` / `botId` / `taskType` / `status` / `sessionId` / `parentSessionId` / `resultPending` / `summary`）保持不变，新增只读字段 `routeId` / `path` / `idempotent`。
- 新增事件类型：
  - `route.decided`：命中能力、路径与分类原因、候选 Agent、候选数、被拒候选短码、最终选择、耗时、`policyDigest`、是否幂等命中；
  - `route.rejected`：拒绝原因短码、候选、耗时。
- 事件 payload 只允许标量安全字段，**不含 goal / context / Prompt / 记忆正文**（`tests/agent-router.test.js` 有专门断言）。

## 4. 决策链与错误语义

| 情况 | 结果 | 错误码 / HTTP |
| --- | --- | --- |
| 显式 `agentId` 不存在 | 拒绝 | `agent_not_found` / 404 |
| 没有 Agent 接受该任务类型 | 拒绝 | `capability_not_found` / 400 |
| 输入不符合任务契约（缺 goal、超长、deadline 越界等） | 拒绝 | `invalid_task` / 400 |
| `allowedTools` 超出该 Agent 有效白名单 | 拒绝 | `tool_not_allowed` / 403 |
| Agent 停用或未就绪 | 拒绝 | `agent_not_available` / 409 |
| 全局待执行深度达到 `maxQueueDepth`（默认 100） | 拒绝 | `agent_queue_full` / 409 |
| 选中 Agent 达到 `concurrencyLimit` | **降级入队** | `degraded=true`，`degradedReason=agent_concurrency_full` |

选择顺序：`routingPriority` 升序 → `botId` 字典序；优先选择仍有并发余量的候选，全部饱和时选排序第一并标记降级。

确定性：`decide()` 是纯函数，只依赖输入、Agent 描述、路由配置与负载快照；相同条件下决策除 `routeId` / `decidedAt` / `durationMs` 外完全一致，`policyDigest` 相同。

## 5. Trace 追溯

- 任务详情（`GET /agent-tasks/:taskId`）带 `route.routeId` 与 `route.policyDigest`；
- `GET /agents/:botId/events` 中 `route.decided` / `route.rejected` 事件带同一个 `routeId`、路径、候选数、拒绝短码与耗时；
- 因此可以从「一个任务」追到「为什么选它 / 为什么被拒 / 用了哪条预算」，且不暴露正文。

## 6. 迁移与回滚

- **任务数据**：新增字段全部可缺省；旧任务读取时补齐，不需要停机迁移。`botId` / `sessionId` 始终与规范字段同值，旧代码与旧客户端继续可用。
- **路由配置**：文件为 `<BLUEBIRD_DATA_DIR>/agents/agent-routing.json`；缺失时写入默认值；解析失败或 schema 非法时报 `agent_routing_corrupted`（500），不静默回退。
- **回滚**：直接回退本期提交即可。旧代码读取新任务时会忽略新增字段；`delegate_to_bot` 与 `POST /agent-tasks` 的既有字段/返回形状未变。删除 `agent-routing.json` 即回到默认路由。

## 7. 测试证据

| 命令 | 结果 |
| --- | --- |
| `node tests/agent-router.test.js` | 48 项通过（契约校验 / 分流 / 选择 / 拒绝与降级 / 确定性 / 隐私 / 迁移 / 幂等 / 优先级 / dispatch / 配置 / 兼容层） |
| `node tests/agent-dispatch.test.js` | 10 项通过（旧委派链路回归） |
| `node tests/memory-bot.test.js` | 9 项通过（含 `POST /agent-tasks` 真实接口） |
| `node tests/agent-tools.test.js` | 127 项通过 |
| `node tests/agent-policy.test.js` | 51 项通过 |
| `node tests/agent-runtime-guards.test.js` | 4 项通过 |

全量门禁（2026-11-01 实跑）：

| 命令 | 结果 |
| --- | --- |
| `npm test` | 52 个测试文件，全部通过 |
| `node scripts/verify-test-coverage.js` | `backend=1670/1670 nodeSuite=221/221 runner=1449/1449`；`frontend=179/179 suites=22/22 failed=0`；`CI runner 覆盖 52/52` |
| `node scripts/sync-doc-counts.js --check` | 文档计数与基线一致（52 文件 / 1670 项） |
| `node scripts/verify-api-capabilities.js` | 93 条路由、19 个路由族、9 个仅 API 能力，登记一致 |
| `npx tsc --noEmit` | 通过 |
| `npm run lint` | 通过 |

测试与门禁均使用临时 `BLUEBIRD_DATA_DIR`，运行后仓库内未生成 `server/data`。

## 8. 未做与下一阶段接口依赖

- `contextRef` 只是标识符：阶段 2 才定义「按需投影」的取用协议；
- Worker 生命周期（`runId`、checkpoint、取消传播）、统一结果 schema 的强制校验属于阶段 2；
- 任务租约/恢复/outbox 的幂等语义增强属于阶段 3；本期只落实创建幂等与优先级队列；
- 权限网关与审批仍沿用现有 `permissions.js` / `approvals.js`，本期不扩大权限模型；
- 路由配置目前只有服务端文件（无 HTTP 配置接口）；后续若需要在线调整，应在配置 API 落地时保持同样的严格校验与 digest 机制。
