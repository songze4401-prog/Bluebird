# Phase 5-B 第 1–2 轮：四维限流、三态熔断与重规划风暴抑制

> 依据：Notion Agent Runtime v1.0 **§26**（限流、熔断、重规划风暴抑制）与台账行 **B-07**、**A-11**（风暴判据部分）。
> 上游：`docs/phase5-charter-2026-11-06.md` P5-B 交付包；基线依赖 `docs/phase5a-eval-tiers-and-comparators.md`（阈值要能对照基线才谈得上调）。
> 本文数字全部是**离线/桩实测**，阈值本身是 B 类（需压测校准），未测得前不调高。

## 1. §26 原文要求 → 本轮落点

| 原文要求 | 代码落点 | 测试 |
|---|---|---|
| Run / Task / Agent / Provider 四个维度各有并发与速率上限 | `server/agents/throttle-policy.js` `DIMENSIONS` + `DEFAULT_THRESHOLDS`（阈值版本 `p5b-throttle-v1`） | `tests/agent-throttle-breaker-storm.test.js` a |
| 令牌桶或信号量 | `takeTokens()`（离散步长回填的令牌桶）+ `acquireSlot()/releaseSlot()`（带租约的信号量） | b、c |
| 有界队列 | `admitQueue()/leaveQueue()`：深度到顶即拒，不把调用方挂住 | c |
| 可识别的限流错误 | 单一码 `throttle_limited` + `dimension`/`mechanism`/`reason`/`limit`/`used`/`retryAfterMs`/`errorFingerprint`/`policyVersion`，形态与 §23 七字段同构（`retryable=true`） | c |
| 阈值版本化并保守默认 | `LIMIT_POLICY_VERSION` 随状态落盘；状态文件换版即重算窗口，旧桶不带新限额继续放行 | a、c |
| Provider / 工具 / Worker 三态 `closed/open/half-open` | `server/agents/circuit-breaker.js`（`p5b-breaker-v1`），状态落 `agents/circuit-breaker.json` | d |
| 滑动窗口 + 半开探测 | `healthOf()` 窗口裁剪 + `minSamples` 下限 + `guard(..., {reserveProbe:true})` 探测名额 | d |
| 确定性错误不计故障率 | `TRANSIENT_KINDS` / `DETERMINISTIC_KINDS` 分流；`bad_request`/`auth`/`cancelled` 等不进分母，100% 确定性错误也保持 closed | d、e |
| 风暴抑制：收益声明 | `checkImprovementClaim()`：`benefit` + `baselineDigest`（digest 形态校验）+ `comparatorId` 必须属 §14 五类 | f |
| 风暴抑制：相同 `errorFingerprint` 的等价计划拒绝 | `evaluate()`：`planDigest`（与 `workflow-store.digestPlan` 同源）+ `errorFingerprint`（与 §23 同源）同时相等即拒 | f、h |
| 风暴抑制：冷却窗口 | `COOLDOWN_RULES` 才武装冷却；契约类拒绝（缺声明）不武装，改正后可立即再来 | f |
| 风暴抑制：计划 diff 判据 | `stepKeysOf()` 用 `workflowStore.stepKeyFor`，仅顺序变化算无实质差异 | f |
| 风暴抑制：禁止新建 Run 规避 | 记账键固定为 `task:<taskId>`，不含 runId；`new_run_evade` 专项识别同计划同错误换新 runId | f |

第 2 轮把表里"Provider / 工具 / Worker 三态"与"风暴五条"的**阻断面**从 Provider 扩到工具网关与路由（见 §3 第 4–6 条），
对应测试落在 `tests/agent-circuit-enforcement.test.js`（6 项）：三域错误码分类与默认方向、工具开闸后 handler 零执行、
半开两次探测合闸、路由以 `agent_circuit_open`/503 剔除 Agent、`limitsSnapshot` 跨重启可见、风暴拒绝事件真的落账。

## 2. 阈值表（B 类数值，压测后收紧）

| 维度 | 机制 | 默认 | 依据 |
|---|---|---|---|
| Provider | 并发（信号量，租约 120s） | 8 | 必须**大于**任务队列自身并发上限 4，否则内部任务会被自己的闸门饿死；同时给聊天流量封顶 |
| Provider | 速率 | 1200 次 / 60 秒，突发 300 | **本轮实测校正过的值**：第一版取 120/60s + 突发 20，全量回归里 `tests/agent-tools.test.js`（132 项）与 `tests/memory-budget-golden.test.js`（7 项）的正常流量被本地闸门挡成 `rate_limit`——前者模型调用数从 3 被截到 1。真实流量与测试回放都会超过那个量，因此先取"不误伤合法流量的上界"，收紧必须有基线数据支撑 |
| Provider | 队列深度 | 16 | 超出即拒并如实报深度，不阻塞调用方 |
| Task | 并发 | 2（env 夹到 1–4） | 与运行时既有 `TASK_CONCURRENCY` 完全一致，本轮只把来源收进版本化阈值表 |
| Run | 重规划 2 / 重试 3 / 委派深度 2 | 引用 §25 `agent-limits` 常量 | 不另建计数；风暴侧的每 Task 上限被 `effectivePolicy` 强制不得高于 §25 |
| Agent | 并发 | 2（执行归属留在 `router.decideInternal.atCapacity`） | 编排层已有"不得重复统计在飞任务"的规则，这里只登记来源 |

env 覆盖：`BLUEBIRD_PROVIDER_MAX_CONCURRENCY` / `_RPS_WINDOW_REQUESTS` / `_RPS_WINDOW_MS` / `_QUEUE_DEPTH` / `_BURST`、`BLUEBIRD_BREAKER_WINDOW_MS` / `_MIN_SAMPLES` / `_OPEN_MS` / `_PROBE_CALLS` / `_FAILURE_RATIO`、`BLUEBIRD_STORM_WINDOW_MS` / `_COOLDOWN_MS` / `_MAX_REPLANS`。
熔断默认：窗口 60 秒、最少 10 个样本、失败率 ≥0.5 开闸、开闸 30 秒、半开探测 2 次且需 2 次成功才合闸。

## 3. 真实接入（不是平行实现）

1. **`server/model-adapter.js:createChatCompletion`**：`enterProviderGate()` 在**发上游请求之前**依次过熔断 → 有界队列 → 令牌桶 → 并发槽位。
   - 拒绝**不改写错误码**：熔断打开回上游最近一次的瞬态类别（`timeout`/`connection`/`server`/`rate_limit`），限流复用既有 `rate_limit`(429)，明细挂在新字段 `error.throttle` 上。既有逐码断言（`tests/model-providers.test.js`）与「零上游请求」断言因此仍然成立。
   - 记账收口唯一：非流式在返回/抛错处，流式在 `wrapMonitoredStream` 的 `finish()`；`onSettle` 为新增可选参数，不改既有调用形态。
   - `client_closed` / `cancelled` 归确定性，不计入服务商故障。
2. **`server/agents/runtime.js`**：`TASK_CONCURRENCY` 改读阈值表（取值不变）；重试分支在 `decideFailureDisposition` 之后加 `admitRetryAttempt()` 风暴判定，命中即走**既有终态收口**，并由 `recordStormDenial()` 写一条 `replan.storm_denied` 事件（任务的 `errorCode` 保留根因，风暴由事件表达）。这同时补上了 §25 每 Run 重规划上限在生产里**没有调用方**的缺口。
3. **观测出口**：`runtime.limitsSnapshot()` 一次给出四维阈值、槽位/桶/队列占用、三态熔断快照与风暴记账；`getQueueStats({limits:true})` 可附带。默认不带是因为调度轮询每 25ms 调一次，不该为此读三个状态文件。

### 第 2 轮追加的接入点

4. **`server/agent-runtime.js:executeToolCall`（工具维度）**：闸门落在"本轮去重复用与幂等账本短路之后、超时与副作用 begin 之前"，所以复用已有结果不受影响，而一旦熔断，**handler 一次都不再执行**。
   - 拒绝结果返回既有形态 `{ok:false, code:'tool_circuit_open', retryAfterMs}`，并且**刻意不写进本轮去重缓存**：缓存它会让同一请求里后续尝试连"恢复了没有"都不再问，把一次熔断放大成整轮不可用。
   - 记账只覆盖"真的执行过"的结局；参数校验失败与权限拒绝根本不进故障率。
5. **`server/agents/router.js`（Worker 维度）**：`computeLoad()` 读熔断状态（只列"当前不健康"的 Agent），`decideInternal()` 据此把该 Agent 从候选池里剔除，用**独立码** `agent_circuit_open`（status 503）而不是复用"队列满/并发满"。
   - `decide()` 的纯函数契约保持不变：判定只看传入的负载快照，文件读取留在 `computeLoad` 这一边界上。
   - 保守方向刻意与 Provider 侧相反：码空间开放（工具与任务各自报错），未归类错误码按**确定性**处理——把健康的工具/Agent 误踢出可用集，比少算一次故障更严重；`model-adapter` 的封闭码表则相反，未归类按瞬态处理，否则漏判就让熔断形同虚设。
   - 熔断状态文件坏掉时按"无熔断"处理，路由继续放行；但写入侧仍显式抛错，坏状态只被吞在观测侧，不吞在记账侧。
6. **`server/agents/tasks.js`（审计口径）**：新增事件类型 `replan.storm_denied` 进 `EVENT_TYPES`，并把 `rule`/`rulesHit`/`replanCount`/`retryAfterMs`/`planDigest` 加进 `SAFE_PAYLOAD_KEYS`。
   - 第 1 轮的两处静默缺陷由这一轮实测暴露：事件类型不在白名单时 `appendEvent` 抛 `invalid_event` 而被 `safeEvent` 吞成一条 `console.warn`，"写了审计"实际一条都没落；`safePayload` 只收 null/boolean/string/number，数组字段被丢弃，所以 `rulesHit` 必须拼成逗号字符串（与路由事件 `orchestration*` 同一口径）。

## 4. 已知限制（不得当成已完成）

1. **收益声明细则在生产路径未生效**：重跑沿用同一份冻结计划，仓库里没有"改计划再跑"的入口，因此 `requiresClaim` 在生产调用点是 `false`。细则本身有纯函数与测试，接入点在提案/自改进链（P5-G）。拿一个当前不可能满足的条件去拦正常退避是错的，所以显式不拦并在此记录。
2. **Agent 维度的并发不在本模块阻断**：并发余量仍由 `router.decideInternal.atCapacity` 决定（`agent_queue_full` / `agent_concurrency_full` 语义保持原样），本模块只登记阈值来源并新增熔断剔除，避免两处各数一遍在飞任务。
3. **半开探测名额挂死的兜底是"一个 openMs 后重新武装"**，不是永久拒绝；如果上游长期 hang，会周期性放 2 次探测过去，这是有意的取舍。
4. **阈值全部未经压测**：`minSamples=10`、失败率 0.5、开闸 30 秒是保守工程默认值；Provider 速率 1200/60s 是"被实测证明不会误伤现有合法流量"的上界，而不是供应商配额（真实供应商常见配额远低于它）。二者都要按 §26「按基线测量后设定」用压测数据复定；届时换 `policyVersion` 才能让旧状态自动失效——状态文件带版本，换版即重算窗口，旧令牌桶不会带着新限额继续放行。
5. **本轮无 HTTP 新路由**：闸门状态经 `limitsSnapshot()` 暴露给测试与运维脚本，未新增 `/api` 端点，因此 API 能力登记不变（新增端点需同时更新能力登记脚本，属下一轮）。
6. **Provider 侧限流在真实供应商配额下尚未验证**：桩路径只能证明"闸门在发请求之前、错误码不改写、槽位会释放"，不能证明真实 429 分布下的开闸时机合适。
7. **状态是持久的，因此每次判定/记账都是一次原子写**：熔断与限流刻意不缓存在内存里（重启清零的 breaker 等于没有，与 `agent-limits` 同一取向），代价是每个模型调用与每个真执行的工具调用各多一次 `writeFileAtomicSync`。量级与既有每次工具调用的账本/任务落盘相同，但**不是零成本，本轮没有做基准测试**；压测轮要一并给出闸门开/关状态下的吞吐与延迟对照，才能声称成本可接受。

## 5. 台账 B-07 拟改判（`0 → 0.5`）

- 已满足：四维阈值版本化且保守默认、信号量/令牌桶/有界队列与可识别限流错误、Provider/工具/Worker **三个域**的三态熔断都已在真实调用路径阻断（滑动窗口 + 半开探测名额 + 确定性错误不计故障率）、风暴五条细则成文并接线到唯一重试裁决点且拒绝真的落审计、A-11 的"相同 `errorFingerprint` 等价计划拒绝"判据落地。
- 未满足（保留 0.5 的理由）：第 4 节的 1、4——收益声明在生产无接入点（等 P5-G）、阈值未经压测标定；另加 §26 要求的"风暴场景测试"目前是按判据逐条构造的用例，不是真实重规划风暴的观测数据。
- 回填时机与 P5-A 的 A-07 同理：`docs/notion-delivery-ledger-2026-11-04.md` 汇总块正被 PR #59 同文件改写，两处并发改写会丢一方的勘误行；B-07 行与汇总在 #59 合并后与 A-07 一起按行级重算脚本回填。

## 6. 复现命令

```bash
node tests/agent-throttle-breaker-storm.test.js    # 8 项（第 1 轮：阈值 / 熔断判定 / 风暴判定 / Provider 接入）
node tests/agent-circuit-enforcement.test.js       # 6 项（第 2 轮：工具与路由侧阻断 / 审计落账 / 观测出口）
node tests/model-providers.test.js                 # 闸门未改写错误码、零上游请求断言仍成立
node tests/model-routing.test.js
node tests/agent-tools.test.js                     # 132 项：工具网关既有行为未受熔断影响
node tests/agent-router.test.js                    # 49 项：路由既有决策链未受熔断影响
node tests/agent-worker.test.js tests/agent-recovery.test.js tests/memory-bot.test.js
node scripts/verify-test-coverage.js               # 全量回归 + 前端
```
