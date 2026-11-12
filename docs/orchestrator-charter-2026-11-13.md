# Orchestrator 大工程立项书（2026-11-13）

> 依据：Notion《Bluebird Agent Worker Orchestrator & Workers》+ 现状映射（`docs/orchestrator-proposal-mapping-2026-11-13.md`）。
> 授权记录：Owner 2026-11-13 明确「开搂，除非重大决策，其余自行裁决，按推荐方案执行」；本文即推荐方案的固化。轮次执行期间 Owner 不逐轮审批，只在**重大决策**（真实模型钥匙用途指向、台账口径变更、偏离本文范围）时上报。
> 基线：`main` = `a0082b0`；backend 2437 / nodeSuite 230 / runner 2207 / frontend 190 / 120 文件；台账 1=20 / 0.5=5（A-07、A-11、A-12、A-13、B-07）。

## 0. 已批准决策（D1–D8）

| # | 决策 | 落法 |
| --- | --- | --- |
| D1 | 方向批准：复用 Runtime，主聊天接编排 | 本立项书 |
| D2 | 先收 P5-C2 再开新工程 | 轮 1 |
| D3 | 模式判定：模型自标计划块，服务端只认编译通过的块，不猜 | 轮 4 |
| D4 | 低风险直接干、高风险走现有审批；事后给流水 | 轮 3/4（复用 approvals + risk-policy） |
| D5 | 上限：单图节点 ≤8、并行 ≤3、沿用任务级预算上界 | 轮 2/3 |
| D6 | Worker 只读最小上下文 + 授权产物（worker-scope 现状即达标） | 不新增机制，轮 3 接产物继承 |
| D7 | 默认关闭，Owner 手动开启（开关面 = `agent-policy.orchestration`） | 轮 4 |
| D8 | 前几轮全桩，最后一轮接真实模型（钥匙已由 Owner 提供，仅环境变量注入，不落盘不回显） | 轮 5 |

## 1. 目标 / 非目标

**目标**：主聊天对复杂请求能出结构化计划 → 服务端编译校验 → 多 Agent DAG 并行执行 → 结果归约 → （高风险时）独立 Reviewer → 幂等回写父会话一条最终结果；简单请求走原直答路径，逐字节不变。

**非目标**：微服务化；无限递归 Agent（保持 L8 深度≤2）；完整聊天历史复制给 Worker（保持 worker-scope 裁剪）；信任模型给出的 Agent 名称/工具权限/「已完成」声明（全部服务端解析与验证）；前端 UI 改版（复用 `bot-result-` 消息与 `/agent-results/stream` 现有契约）；新 SSE 事件类型。

## 2. 轮次拆分

### 轮 0：映射 + 立项书（本文档，随映射文档同 PR）

### 轮 1：P5-C2 修订闭环 + 发布节点（Phase 5 收尾，出口 A-13）

- **范围**：①验证失败 → 缺证节点集合 → `workflow-store.appendVersion` 出 v2 → `migratePlanVersion`（自动换代次，fencing 旧令牌失效）→ 只重跑缺证节点、复用仍可用产物（`contextRef` + 显式 `share`）；②发布节点复用 `waiting_approval`（不新造状态）：交付前若计划声明发布门 → `approvals.createApproval` → 超时 fail-closed（不交付）→ 获批后 `deliverTaskOutcome` 幂等执行 + 审计；③`run-worked-example.js` 九步 → 十三步（+注入验证失败/缺证节点识别/v2 修订重跑/发布批准与 fail-closed 四步），运行记录落盘。
- **新模块**：`server/agents/plan-revision.js`（`plan-revision-v1`）。修订上限沿用 replan 风暴守卫（≤2 次，`replan.storm_denied`）。
- **禁区**：不把 `needs_revision` 做成新任务状态（十态不动）；不绕过 verification-loop 的 trustLevel 规则。
- **出口判据**：新测试文件 ≥1（修订闭环 + 发布节点两块）；worked example 13 步断言通过并留 JSON 运行记录；七门禁全绿；A-13 具备复判证据（台账 1=21/0.5=4）。

### 轮 2：plan-compiler-v1 计划编译器

- **范围**：①`STEP_KEYS` 扩可选 `agentId`（`plan-schema-v2`，缺省=旧行为，旧计划零影响）；②新模块 `server/agents/plan-compiler.js`（`plan-compiler-v1`）：输入 = 模型产计划 JSON（nodes[{key, taskType, goal, dependsOn[], context?}]），编译动作 = schema 校验 → DAG 无环（复用 cycle 检测）→ 节点数 ≤8 → taskType 必须命中某 Agent 的 `acceptedTaskTypes ∩ capabilities`（**执行者由 router 解析，模型给的 agent 名一律丢弃并审计**）→ 每节点 risk-policy 分级 → 输出 = workflow-store 计划（v2 节点带 agentId）+ 任务定义数组；③HTTP `/agent-plans`（POST 编译校验、GET 详情，鉴权前缀 + auditAction，能力登记）；④事件 `plan.proposed` / `plan.compiled` / `plan.rejected`（入 EVENT_TYPES，payload 走 SAFE_PAYLOAD_KEYS 扁平标量）。
- **禁区**：编译器不执行任何任务（纯服务端校验与落盘）；不接模型调用（输入是字符串）。
- **出口判据**：新测试 ≥12 例（合法 DAG/环/超 8 节点/未知 taskType/伪造 agent 名丢弃/跨 Agent 边/旧 schema 兼容/预算上界）；七门禁全绿；HTTP 编译一条真实请求走通（桩）。

### 轮 3：DAG 执行 + 产物继承 + 结果归约 + 审校门

- **范围**：①`orchestrator.orchestrateDAG(planId)`：按编译产物建任务（跨 Agent `dependsOn` 放宽，`dag-v1`：仅带编排计划头的图允许，环检测/深度/预算/父子授权交集不变）；②波次调度：复用现有拉取队列 + `dependencies.isReady`（独立节点即刻并行，全局并发上限由 `BLUEBIRD_AGENT_TASK_CONCURRENCY` 提到 3）；③**产物自动继承**：子任务创建时对全部上游产物执行 `artifactStore.share` + `contextRef` 注入（缺省拒绝语义不变，此处是编排侧的显式授权动作，审计 `orchestration.artifact_shared`）；④**结果归约**：`server/agents/orchestrator-reducer.js`（`orchestrator-reducer-v1`）——同计划全部节点终态后归约 summaries + artifacts → 根结果（承载方案：伪根任务 `taskType:'orchestration.root'`，仅作记录/审批/投递载体，不注册为可路由能力、不占 Worker 并发；轮内实现时若与状态机冲突则降级为计划级聚合，裁决留档）；⑤部分失败：子节点 failed → 下游照旧判死 → 根结果按 `collectPartialOutcome` 语义输出部分归约（明确标注缺失节点）；⑥审校门：任一节点 risk-policy ≥R2 或工具级 R3 → 根结果交付前走 `openReview` 独立审校，未过不交付；⑦发布门：计划声明 publish 门 → 复用轮 1 的 waiting_approval 通道。
- **出口判据**：新测试 ≥15 例（并行重叠断言/依赖等待/跨 Agent 边/产物继承可见性/归约幂等/部分失败降级/审校拦截/发布门批准与超时）；DAG 端到端走 in-process 桩全绿；HTTP `/agent-orchestrations` 一条创建入口；七门禁全绿。
- **失败语义**：编排不自动重派到其他 Agent（v1 保持），重试沿用任务级 attempts。

### 轮 4：主聊天接线

- **范围**：①`agent-policy.json` 加 `orchestration: {enabled:false, maxNodes:8, concurrency:3}`（LIMITS 钳制 + `GET/PUT /agent-policy` 自动获得读写）；②共享流程接缝：`runAgentTurn` 返回后扫描回复中的 ```bluebird-plan 围栏块（协议：`{mode:'direct'|'single'|'dag', goal, nodes[...]}`）——无块=直答（零改动）；有块=剥块→plan-compiler 编译→orchestrateDAG→用户可见回复 = 剥块后正文 + 编排回执（taskId/planId、节点数、幂等键），编译失败=降级直答 + `plan.rejected` 审计；③开启时 system prompt 追加计划块协议说明（提示词模板常量入 agent-policy，不硬编码进对话历史）；④`/chat` 与 `/chat/stream` 同路径生效；stream 的 `done` 事件携带编排回执字段；⑤端到端测试：/chat 与 /chat/stream 各一条复杂请求（桩模型返回计划块）→ 断言任务图建立、直答请求零编排痕迹、开关关闭时计划块按普通文本处理。
- **禁区**：`prepareChatRequest` / `completeChatTurn` 契约不动；不新增 SSE 事件类型；开关关闭时对请求的处理路径与 a0082b0 逐字节一致。
- **出口判据**：新测试 ≥10 例；七门禁全绿；`agent-policy` 默认导出 enabled=false（默认关闭姿态断言入测试）。

### 轮 5：真实模型验收轮

- **范围**：①Owner 提供的钥匙仅以环境变量注入（不写入任何文件、不回显、不进测试）；provider 指向以钥匙实际归属为准——**若无法从仓库配置确证 endpoint，此处停下来问 Owner（重大决策）**；②真实模型跑：一条主聊天复杂请求全链路（计划块→编译→DAG→归约→回写）+ worked example 真实模式 + 若干直答对照；③采集 usage/latency/安全计数留档 JSON；④粗验收口径：计划块产出率、编译通过率、端到端成功率、Token 成本——只留档不设门槛（门槛属 A-07 类外部判据，Owner 定）。
- **出口判据**：运行记录落盘 `docs/e2e-*-run-*.json`；七门禁全绿（本轮零代码改动时只跑受影响面）。

### 轮 6：收尾

台账复判（A-13 → 1.0；C 系列新行按 §4 登记）→ `handover-v3`（覆盖 orchestrator 交接）→ 记忆文件更新。

## 3. 不变量（全轮适用）

沿用交接文档 v2 §3 的 14 条；新增：

15. **模型计划不可信**：执行者由 router 按 taskType 解析，模型声明一律丢弃并审计；工具集由 manifest 白名单给，不由计划声明给。
16. **编译失败降级直答**：主聊天路径上任何编译/编排异常都不能让用户请求失败——降级为普通回复 + `plan.rejected` 审计。
17. **编排开关关闭 = 零行为差异**：关闭时新代码路径不得触达请求处理（计划块按普通文本渲染）。
18. **跨 Agent 边只在编排计划头下放行**：散装任务的 `dependsOn` 同 Agent 约束原样保留。
19. **产物继承是显式授权动作**：由编排侧集中 `share` 并审计，不放宽 worker-scope 的默认拒绝语义。

## 4. 台账对接

新增 C 系列（编排工程）：C-01 计划编译器（轮 2）、C-02 DAG 执行与产物继承（轮 3）、C-03 结果归约与审校门（轮 3）、C-04 主聊天接线（轮 4）、C-05 真实模型验收（轮 5）。判分沿用三值制；**动手前先确认 `scan-notion-ledger.js` 对分节/新系列的解析假设，不兼容则先升脚本再进台账**。A-13 随轮 1 复判。

## 5. 风险与回退

| 风险 | 缓解 |
| --- | --- |
| 跨 Agent 边放宽破坏既有图不变量 | 版本位 `dag-v1` + 限制在编排计划头内 + 全量既有 workflow 测试不改一行 |
| 归约/审校链拖长端到端延迟 | 节点级并发 3 + 审校仅对 R2/R3 根触发；延迟数字轮 5 采集后再议门槛 |
| 模型计划块质量差（真实模型） | 编译失败降级直答，最坏情况 = 回到现状；轮 5 用数字说话 |
| 台账脚本不认新系列 | 轮 6 动台账前先验脚本，不兼容先升脚本 |
| 钥匙归属不明 | 轮 5 开工前确证 endpoint，不确证不动钥匙（上报 Owner） |

## 6. 每轮固定动作

分支（`feat/…`）→ 用例 → 基线同步（`scripts/test-coverage-baseline.json` + `sync-doc-counts.js`）→ 七门禁 → push → PR（`--merge` 不 squash）→ main 重跑七门禁 → 台账判据只认 main 证据 → 合并记录进轮次小结。测试不触真实数据目录；禁 LLM 用例以 `process.env.DEEPSEEK_API_KEY = ''` 置空（不 delete）。
