# Phase 5-B 第 1 轮：四维限流、三态熔断与重规划风暴抑制

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
2. **`server/agents/runtime.js`**：`TASK_CONCURRENCY` 改读阈值表（取值不变）；重试分支在 `decideFailureDisposition` 之后加 `admitRetryAttempt()` 风暴判定，命中即走**既有终态收口**，并写一条 `replan.storm_denied` 事件（任务的 `errorCode` 保留根因，风暴由事件表达）。这同时补上了 §25 每 Run 重规划上限在生产里**没有调用方**的缺口。
3. **观测出口**：`runtime.limitsSnapshot()` 一次给出四维阈值、槽位/桶/队列占用、三态熔断快照与风暴记账；`getQueueStats({limits:true})` 可附带。默认不带是因为调度轮询每 25ms 调一次，不该为此读三个状态文件。

## 4. 已知限制（不得当成已完成）

1. **工具与 Worker 维度只有判定，没有阻断**：三态与名额逻辑对 `provider/tool/worker` 通用并有测试，但生产阻断只接在 Provider 上。工具侧的正确插入点是 `failopen-policy` + `agent-runtime` 的工具网关，与审批门/白门交织，需要单独一轮；届时才能声称"工具熔断生效"。
2. **收益声明细则在生产路径未生效**：重跑沿用同一份冻结计划，仓库里没有"改计划再跑"的入口，因此 `requiresClaim` 在生产调用点是 `false`。细则本身有纯函数与测试，接入点在提案/自改进链（P5-G）。拿一个当前不可能满足的条件去拦正常退避是错的，所以显式不拦并在此记录。
3. **Agent 维度不在本模块阻断**：并发余量仍由 `router.decideInternal.atCapacity` 决定（`agent_queue_full` / `agent_concurrency_full` 语义保持原样），本模块只登记阈值来源，避免两处各数一遍在飞任务。
4. **半开探测名额挂死的兜底是"一个 openMs 后重新武装"**，不是永久拒绝；如果上游长期 hang，会周期性放 2 次探测过去，这是有意的取舍。
5. **阈值全部未经压测**：`minSamples=10`、失败率 0.5、开闸 30 秒是保守工程默认值；Provider 速率 1200/60s 是"被实测证明不会误伤现有合法流量"的上界，而不是供应商配额（真实供应商常见配额远低于它）。二者都要按 §26「按基线测量后设定」用压测数据复定；届时换 `policyVersion` 才能让旧状态自动失效——状态文件带版本，换版即重算窗口，旧令牌桶不会带着新限额继续放行。
6. **本轮无 HTTP 新路由**：闸门状态经 `limitsSnapshot()` 暴露给测试与运维脚本，未新增 `/api` 端点，因此 API 能力登记不变（新增端点属下一轮，需同时更新能力登记脚本）。

## 5. 台账 B-07 拟改判（`0 → 0.5`）

- 已满足：四维阈值版本化且保守默认、信号量/令牌桶/有界队列与可识别限流错误、Provider 侧三态熔断（滑动窗口 + 半开探测 + 确定性错误不计故障率）已在真实调用路径阻断、风暴五条细则成文并接线到唯一重试裁决点、A-11 的"相同 `errorFingerprint` 等价计划拒绝"判据落地。
- 未满足（保留 0.5 的理由）：上面第 4 节的 1、2、3、5——工具/Worker 未阻断、收益声明未在生产生效、Agent 维度不重复阻断、阈值未经压测。
- 回填时机与 P5-A 的 A-07 同理：`docs/notion-delivery-ledger-2026-11-04.md` 汇总块正被 PR #59 同文件改写，两处并发改写会丢一方的勘误行；B-07 行与汇总在 #59 合并后与 A-07 一起按行级重算脚本回填。

## 6. 复现命令

```bash
node tests/agent-throttle-breaker-storm.test.js     # 8 项
node tests/model-providers.test.js                  # 闸门未改写错误码、零上游请求断言仍成立
node tests/model-routing.test.js
node tests/agent-worker.test.js tests/agent-recovery.test.js tests/memory-bot.test.js
node scripts/verify-test-coverage.js                # 全量回归 + 前端
```
