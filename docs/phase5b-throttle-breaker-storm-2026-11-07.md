# Phase 5-B 第 1–3 轮：四维限流、三态熔断、重规划风暴抑制与闸门开销基准

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
7. **状态是持久的，因此每次判定/记账都是一次原子写**：熔断与限流刻意不缓存在内存里（重启清零的 breaker 等于没有，与 `agent-limits` 同一取向），代价是**每个放行的模型调用 3 次 `writeFileAtomicSync` + 4 次同步读**（逐处源码核对见 §5.4 第 2 条），每个真执行的工具调用另多 1 次 `record` 写。量级与既有每次工具调用的账本/任务落盘相同，但**不是零成本**；第 3 轮已补上闸门开/关的本地基准（见 §5），结论是成本几乎全在同步落盘、并随并发放大，串行档的绝对值在本机不稳定。

## 5. 第 3 轮第 1 项：闸门开/关开销基准（本地桩，零外部依赖）

> 脚本：`scripts/bench-gate-overhead.js`；口径守卫：`tests/agent-gate-overhead-bench.test.js`（7 项）。
> 这一项**不需要供应商额度**：上游是本机 `127.0.0.1` 的 HTTP stub，延迟由 `--delay` 固定。
> 它回答 §4 第 7 条留下的问题——闸门自身值多少钱；它**不**回答 §26 的阈值该定多少（那要真实压测，见 §4 第 4、6 条）。

### 5.1 三态定义与可比性规则

三态全部在**基准进程内**替换模块入口，生产代码里没有任何"关闭闸门"的开关或环境变量：

| 态 | 含义 | 用途 |
|---|---|---|
| A `gateOn` | 生产路径原样：`circuitBreaker.load()` → `guard()` → `admitProvider()`（放行落盘）→ `record()` + `release()`（重读重写） | 真实成本 |
| B `decideNoPersist` | 熔断读与判定、限流判定都跑真逻辑，只摘掉三处落盘（`record`、admit 的 `persist`、release 的重写） | A−B = **同步写状态文件**的成本 |
| C `gateOff` | 四个入口全换成本地常量放行 | B−C = **判定与读盘**的成本 |

可比性是一条硬规则（`comparability()`，有单测）：**任一态出现拒绝或样本数不足，三项增量一律为 `null` 并给出理由**。
原因是超过并发上限时 A 会秒拒一批，而 B 因为不落盘攒不出租约、结构上根本不会拒——两者相减得到的是"语义差"而不是"开销差"。
被拒调用也不进延迟样本：把"本地秒拒"混进去会统计成"上游很快"。

### 5.2 主运行实测（上游固定 20ms）

环境：Windows x64、Node `v24.19.0`、监控关（`BLUEBIRD_MONITORING=0`）、临时数据目录、组件分解每项 2000 轮。
命令：`node scripts/bench-gate-overhead.js --component-rounds=2000`。
当时生效的 Provider 阈值：并发 8（租约 120s）、速率 1200 次/60s（突发 300）、队列深度 16（`waitMs=0`）。

| 并发 | 样本 | A 均值/p95 ms | A 墙钟 ms / 吞吐 rps | B 均值 / 吞吐 | C 均值 / 吞吐 | 写盘增量 A−B | 判定增量 B−C | 闸门总增量 A−C（占上游 20ms） |
|---|---|---|---|---|---|---|---|---|
| 1 | 60 | 32.257 / 34.624 | 1936 / 30.99 | 31.152 / 32.09 | 31.196 / 32.05 | +1.105 ms | −0.044 ms | +1.061 ms（5.30%） |
| 4 | 64 | 50.181 / 62.146 | 814 / 78.62 | 31.324 / 127.49 | 31.115 / 128.51 | +18.857 ms | +0.209 ms | +19.066 ms（95.33%） |
| 8 | 64 | 79.646 / 94.794 | 658 / 97.26 | 31.426 / 253.97 | 31.234 / 254.98 | +48.220 ms | +0.192 ms | +48.412 ms（242.06%） |
| 16 | 64 | 69.226 / 76.528（**仅 8 次放行**） | 93 / 86.02 | 42.557 / 369.94（64 次全放行） | 30.478 / 520.33（64 次全放行） | `null` | `null` | `null` |

并发 16 那行的拒绝明细：`concurrency×56`（上限 8）。脚本给出的不可比理由原文：
> 样本集不一致：gateOn 放行 8/64、拒绝 56（concurrency×56）。被拒调用是闸门语义而非开销；去掉落盘的态攒不出租约，结构上不会触发并发上限，两者相减得不到开销。

组件分解（微秒，中位 / p95，每项 2000 轮，每轮跑前清空两个状态文件并记录实际走的分支）：

| 组件 | 中位 µs | p95 µs | 分支计数 |
|---|---|---|---|
| `circuitBreaker.load()`（读状态文件） | 10.4 | 13.0 | `loaded×2000` |
| `guard(load())`（熔断判定，含读） | 11.8 | 15.5 | `allowed×2000` |
| `guard(内存态)`（纯判定，无读盘） | 1.5 | 2.1 | `allowed×2000` |
| `admitProvider()` 放行 + `release()`（两次写） | 3414.8 | 13205.5 | `admitted×2000` |
| `admitProvider({persist:false})` + `release()`（一次写） | 1790.5 | 2905.7 | `admitted(no persist)×2000` |
| `throttlePolicy.save()`（单次同步原子写） | 1717.7 | 2722.3 | `written×2000` |
| `circuitBreaker.save()`（单次同步原子写） | 1696.1 | 2713.7 | `written×2000` |
| `circuitBreaker.record(ok)`（记账，含写） | 1457.3 | 2185.7 | `recorded×2000` |
| `enterProviderGate()` + `release()`（整条闸门） | 4936.0 | 14653.8 | `gate-passed×2000` |

分支计数全部落在预期路径上（没有一次 `denied:*`），所以这些数字确实是"放行路径"的成本，不是被拒路径的。
两次写 3414.8µs ≈ 一次写 1790.5µs 的两倍，也印证成本按写次数线性叠加。

### 5.3 慢上游对照（上游固定 200ms，样本量与主运行一致）

命令：`node scripts/bench-gate-overhead.js --delay=200 --sequential=60 --calls=64 --concurrency=1,4,8 --component-rounds=200`。

| 并发 | A 均值 ms | A 吞吐 rps | C 吞吐 rps | 吞吐变化 | 写盘增量 A−B | 闸门总增量 A−C（占上游 200ms） |
|---|---|---|---|---|---|---|
| 1 | 220.172 | 4.54 | 4.87 | −6.8% | +14.566 ms | +14.990 ms（7.50%） |
| 4 | 236.375 | 16.86 | 19.16 | −12.0% | +21.547 ms | +27.599 ms（13.80%） |
| 8 | 264.466 | 29.88 | 36.74 | −18.7% | +45.308 ms | +46.964 ms（23.48%） |

对照说明两件事：**上游越慢，同一闸门的相对成本越低**（并发 8 的占比从 242% 降到 23.5%）；
但**绝对增量并没有随之消失**（并发 8 仍是 45–48ms），所以"真实供应商慢，闸门就免费"是不成立的。

### 5.4 归因结论

1. **判定与读盘几乎免费**：纯判定中位 1.5µs、含一次读盘 11.8µs；B−C 在主运行三个可比档位都 ≤0.21ms（≤1.05% 上游延迟）。
2. **成本全在同步原子写**：单次 `save()` 中位 1.70–1.72ms（`writeFileAtomicSync`，含 fsync）；每次放行的模型调用要写 3 次（admit 1 次 + record 1 次 + release 重写 1 次）并同步读 4 次（`circuitBreaker.load`、`admitProvider` 内的 `load`、`record` 内的 `load`、`release` 内的 `load`，逐处对源码核对：`server/model-adapter.js:581-641`、`server/agents/throttle-policy.js:306,360,374,377`、`server/agents/circuit-breaker.js:389,401`）。这是**闭合态**的计数；半开态 `guard(..., { reserveProbe: true, filePath })` 还会多写一次探测名额（`circuit-breaker.js:329`），本基准全程闭合态，不含这一次。同步写会**阻塞事件循环**，因此并发越高越被串行化：并发 4 吞吐从 C 的 128.5 掉到 A 的 78.6 rps（−38.8%），并发 8 从 C 的 255.0 掉到 A 的 97.3 rps（−61.9%）；两个百分比都是 **A 相对 C**（闸门总增量），若只比 A 与 B（写盘增量）则是 −38.3% 与 −61.7%。
3. **并发 16 的 56 次拒绝是 §26 的语义，不是开销**：上限就是 8，拒绝应当发生；该行不给增量，避免把语义差伪装成成本。
4. **串行档的绝对值在本机不稳定，必须按量级看**：同一脚本多次运行，并发 1 的写盘增量测到过 0.548 / 0.741 / 1.105 ms（上游 20ms）与 14.566 / 17.315 ms（上游 200ms）。组件级单次写中位 1.7ms 是在"每轮新建状态文件"的条件下测的，而负载运行里文件已存在、走的是覆盖 rename，两者条件不同；本机 fsync 延迟本身抖动很大（`throttlePolicy.save()` 的 p95 在不同运行里出现过 2.7ms 与 11.7ms）。**因此本报告不把串行档的某一个数当精确值**，稳定成立的是"成本随并发放大"和"占比随上游变慢下降"这两条趋势。

### 5.5 这决定了什么、不决定什么

- **不决定阈值**：吞吐/延迟成本与供应商配额是两件事。§26 要求的"按基线测量后设定阈值"仍需真实压测数据（外部依赖，本轮未做，见 §4 第 4、6 条）。
- **决定一个明确的待办取舍**：把 `release()` / `record()` 的落盘改成异步或合并写，可以回收并发 4/8 档的大部分增量；代价是**崩溃时在途租约丢失**，重启后短时间内上游并发可能超过硬上限 8。这是安全性与吞吐的取舍，本轮**不擅自改**，留作单独一轮并需显式决策。
- **现状可接受性**：串行聊天路径增量在毫秒量级。Agent 并行的任务队列并发**默认是 2**（`BLUEBIRD_AGENT_TASK_CONCURRENCY` 夹到 1..4，见 `server/agents/throttle-policy.js:76-79`），不是 4；这一档已单独补测（§5.7）：闸门总增量 +14.680ms（快上游 20ms，占 73.40%，吞吐 −31.3%）到 +16.726ms（慢上游 200ms，占 8.36%，吞吐 −7.6%）。绝对增量稳定在 15ms 量级、可测量但不致命；真实上游延迟普遍大于 20ms 桩，相对成本会更接近慢上游那一行。把并发调到 4 时成本上升到 +19.066ms / +27.599ms（§5.2、§5.3），调参前应按这两张表权衡。

### 5.6 已知限制（基准自身）

1. **机器相关**：全部数字来自一台 Windows x64 开发机的本地磁盘；fsync 成本在 Linux/CI 上会显著不同，不能直接搬去定阈值。
2. **监控关闭**：`BLUEBIRD_MONITORING=0`，所以数字不含监控自身的埋点成本；生产默认开启监控时总成本更高。
3. **无真实供应商**：上游是固定延迟的本地 stub，没有真实 429 分布、没有网络抖动，因此只能归因闸门自身，不能校准开闸时机。
4. **态顺序固定 A→B→C**：三态前有一次预热调用，但没有做顺序轮换；若存在残留冷启动成本，它会落在 A 上（即高估闸门成本）。这是保守方向，已在串行档的抖动里一并披露。
5. **工具维度未单独基准**：本轮只测 Provider 闸门（`createChatCompletion`）。工具网关每次真执行多一次 `record` 写，量级可由组件表推出，但没有独立的工具侧负载运行。

### 5.7 默认任务并发 2 的补测（两次独立运行）

§5.5 指出 Agent 并行的任务队列并发默认是 **2**，而 §5.2/§5.3 的档位是 1/4/8/16，没有 2。
为了不让"默认配置的成本"停留在两档之间的推测，另跑两次独立运行补上这一档（样本量与主运行一致：并发档 64 次调用，组件分解每项 200 轮）：

```bash
node scripts/bench-gate-overhead.js --concurrency=2 --component-rounds=200
node scripts/bench-gate-overhead.js --delay=200 --sequential=60 --calls=64 --concurrency=2 --component-rounds=200
```

| 上游 | 样本 | A 均值/p95 ms | A 吞吐 rps | B 均值 / 吞吐 | C 均值 / 吞吐 | 写盘增量 A−B | 判定增量 B−C | 闸门总增量 A−C（占上游） | 吞吐变化 A 相对 C |
|---|---|---|---|---|---|---|---|---|---|
| 20ms | 64（三态均 0 拒绝） | 46.974 / 51.147 | 42.50 | 31.221 / 64.06 | 32.294 / 61.90 | +15.753 ms（78.76%） | −1.073 ms | +14.680 ms（73.40%） | −31.3% |
| 200ms | 64（三态均 0 拒绝） | 221.773 / 225.329 | 9.01 | 206.859 / 9.67 | 205.047 / 9.75 | +14.914 ms（7.46%） | +1.812 ms | +16.726 ms（8.36%） | −7.6% |

两点必须如实说明：

1. **20ms 档的判定增量是负数（−1.073ms），这不是"闸门判定让调用变快"**。该档 C 态出现一次 59.091ms 的离群值（C 均值 32.294 反而高于 B 的 31.221），噪声量级已经大于判定成本本身（组件表里纯判定中位 1.5µs）。所以这一档只能读作"判定成本低于本机噪声"，不能读作负成本；写盘增量 +15.753ms 与总增量 +14.680ms 仍远大于噪声，结论方向不变。
2. **默认并发 2 的绝对增量（14.7–16.7ms）与并发 1 的串行档不在同一量级**，且两次运行的写盘增量几乎相同（15.753 / 14.914ms），说明这一档主要由"每次放行 3 次同步写"的固定成本决定，而不是由排队放大决定；并发 4/8 档才出现明显的串行化放大（18.9 / 48.2ms）。

## 6. 台账 B-07 拟改判（`0 → 0.5`）

- 已满足：四维阈值版本化且保守默认、信号量/令牌桶/有界队列与可识别限流错误、Provider/工具/Worker **三个域**的三态熔断都已在真实调用路径阻断（滑动窗口 + 半开探测名额 + 确定性错误不计故障率）、风暴五条细则成文并接线到唯一重试裁决点且拒绝真的落审计、A-11 的"相同 `errorFingerprint` 等价计划拒绝"判据落地。
- 未满足（保留 0.5 的理由）：第 4 节的 1、4——收益声明在生产无接入点（等 P5-G）、阈值未经压测标定；另加 §26 要求的"风暴场景测试"目前是按判据逐条构造的用例，不是真实重规划风暴的观测数据。
- 回填时机：原先的同文件冲突限制（PR #59 正在改写汇总块）已随 #59/#60/#61/#62/#63 合并解除；**2026-11-07 已执行**——B-07 行与 A-07 一起在 `docs/ledger-a07-b07-backfill-2026-11-07` 这一轮改判 `0 → 0.5`，汇总由 `scripts/scan-notion-ledger.js --check` 重扫为 `1`=16 / `0.5`=9 / `0`=0（旧值与历次勘误全部保留）。本轮（第 3 轮第 1 项）不改台账文件。

## 7. 复现命令

```bash
node tests/agent-throttle-breaker-storm.test.js    # 8 项（第 1 轮：阈值 / 熔断判定 / 风暴判定 / Provider 接入）
node tests/agent-circuit-enforcement.test.js       # 6 项（第 2 轮：工具与路由侧阻断 / 审计落账 / 观测出口）
node tests/agent-gate-overhead-bench.test.js       # 7 项（第 3 轮：基准口径守卫 + CLI 实跑）
node tests/model-providers.test.js                 # 闸门未改写错误码、零上游请求断言仍成立
node tests/model-routing.test.js
node tests/agent-tools.test.js                     # 132 项：工具网关既有行为未受熔断影响
node tests/agent-router.test.js                    # 49 项：路由既有决策链未受熔断影响
node tests/agent-worker.test.js tests/agent-recovery.test.js tests/memory-bot.test.js
node scripts/verify-test-coverage.js               # 全量回归 + 前端

# 第 3 轮基准（本机即可跑，不需要供应商额度；数字随机器与磁盘状态变化）
node scripts/bench-gate-overhead.js --component-rounds=2000
node scripts/bench-gate-overhead.js --delay=200 --sequential=60 --calls=64 --concurrency=1,4,8 --component-rounds=200
node scripts/bench-gate-overhead.js --concurrency=2 --component-rounds=200                                        # 默认任务并发档（§5.7）
node scripts/bench-gate-overhead.js --delay=200 --sequential=60 --calls=64 --concurrency=2 --component-rounds=200   # 同档慢上游（§5.7）
```
