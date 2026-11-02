# P2：记忆系统 Token 计量与可观测性

> 对应架构决策：`Bluebird 跨会话记忆与上下文隔离架构`（Notion）第 3 节 + 第 6 节 P2
> 前置：`docs/p0-cross-session-memory-rootcause.md`、`docs/p1-user-scoped-memory.md`

- 实施日期：2026-11-02
- 范围：增量补计量与 Trace，不改用户级/会话级/任务级作用域模型，不做 Project 实体。

---

## 1. 交付项与验收对照

| 要求 | 实现 | 证据 |
|---|---|---|
| 1. 候选数 / 命中数 / 最终注入数 | `diagnostics.funnel` + `trace.retrieval.funnel` + `trace.stages` | `memory-observability.test.js` 用例 1 |
| 2. 注入 Token 数（非字符数） | `measureRequest.blocks[]` / `memoryTokens`，标 `tokenSource='estimate'`；真实值取 Provider `usage.prompt_tokens` | 用例 5、`context-trace-verify.test.js` |
| 3. 过滤原因记录 | `visibilityReasons`（过期/被替代/归档/待确认/未生效）+ `excluded`（作用域/状态/来源/时间/低相关） | 用例 2、3 |
| 4. 改造前后 Token 对比 | `scripts/memory-token-compare.js`（同夹具双作用域） | 见 §4 |
| 5. Trace 可核对最终内容与 Token | `trace.sent.rounds[].contentHash` + `trace.sent.usage[]` | `context-trace-verify.test.js`（端到端） |
| 6. Mock / 真实 Provider 严格区分 | `providerKind()` + `usage_source` 三态（provider / stub / missing）+ 独立指标与总览卡 | 用例 7-10 |

---

## 2. 数据契约（新增字段）

### 2.1 检索漏斗

`searchMemories().diagnostics` 新增：

```js
funnel: {
  store_total,   // 记忆库总条数
  eligible,      // 通过状态/时间窗口的条数
  candidates,    // 通过作用域过滤后的候选池（进入排序之前）
  returned,      // 实际返回条数（受条数/字符/token 预算截断后）
}
visibilityReasons: {
  pending, superseded, archived, not_yet_valid, expired, unknown_status
}
```

`trace.retrieval` 同步携带 `candidates`（=候选池）、`returned`、`funnel`、`excluded`、`visibilityReasons`、`scopeMode`。

> **语义修正**：改动前 `trace.retrieval.candidates` 实际是「返回条数」，与「候选数」混用。P2 起 `candidates` 明确为候选池大小，返回条数走 `returned`，两者不得互相冒充。

### 2.2 Token 归属

`measureRequest()` 新增：

```js
tokenSource: 'estimate',
blocks: [{ id, kind, tokens, length }],
blockTokensByKind: { memory, knowledge, summary, recalled, ... },
memoryTokens,
knowledgeTokens
```

`trace.build.blockTokens` / `memoryTokens` 同步落库。

### 2.3 发送证据与 Provider 对账

```js
trace.sent.rounds[] = {
  round, messageCount, roles, messageIds, contextIds,
  providerId, modelId, providerKind,
  systemLength,
  contentHash,        // sha256(role+content[+tool_calls])，可复算
  estimatedTokens,    // 估算器口径
  tokenSource: 'estimate'
}

trace.sent.usage[] = {
  round, providerKind, usageSource,      // provider | stub | missing
  promptTokens, completionTokens, totalTokens,
  estimatedInputTokens, estimateRatio,   // 真实/估算
  calibration,                            // 只有 provider 才 true
  withinTolerance                         // 容差 0.35
}
```

---

## 3. Mock 与真实 Provider 的严格区分

`providerKind()`（`server/monitoring/index.js`）判定优先级：

1. `BLUEBIRD_PROVIDER_KIND=stub|configured`（显式声明，最高优先）
2. `BLUEBIRD_ALLOW_PRIVATE_BASE_URL=1`（model-adapter 的本地 mock 旁路）→ `stub`
3. 缺省 → `configured`

`usage_source` 三态：

| 取值 | 含义 | 是否参与校准 |
|---|---|---|
| `provider` | 供应商返回的真实 usage，且端点非桩 | 是 |
| `stub` | 桩返回的 usage | **否**（`calibration=false`，`withinTolerance=null`） |
| `missing` | 供应商没给 usage | 否（`estimateRatio=null`，不猜） |

落地位置：

- 指标 `model_tokens_total` / `model_requests_total` 增加 `provider_kind` 标签；
- 总览模型卡拆成「输入/输出 Token（供应商）」与「输入/输出 Token（桩，不计入真实）」；
- `tests/../scripts/run-tests.js` 统一设置 `BLUEBIRD_PROVIDER_KIND=stub`，保证测试进程不会把桩算成真实。

> **为什么不按域名猜**：本地也可能跑真实模型服务（见 `AGENTS.md` 的 ONNX 验证）。靠猜测标注会造假，因此要求显式声明。

---

## 4. 改造前后 Token 消耗对比

`node scripts/memory-token-compare.js`（同一夹具、同一批查询，仅切换作用域；**不调用任何 Provider**）：

```
query                   cand(b/a)   items(b/a)   tokens(b/a)    Δtokens
我喝咖啡有什么习惯               1/7         1/2          79/96          +17
我平时用什么编辑器               1/7         0/1          0/82          +82
我住在哪个城市                 1/7         0/1          0/80          +80
我的猫叫什么                  1/7         0/1          0/78          +78
我有什么过敏                  1/7         0/1          0/79          +79
我平时做什么运动                1/7         0/1          0/76          +76
我最近在忙什么                 1/7         0/0          0/0            +0
合计                                  1/7          79/491         +412  (521.5%)
排除原因（after）：{"pending":7,"superseded":7,"archived":7,"expired":7,"irrelevant":42}
```

解读：

- **before** 只有无归属旧数据可见（候选 1 条/查询），跨会话记忆实际是「不可见」而不是「省 Token」；
- **after** 候选池 7 条，但每个查询最终只注入 0-2 条——相关性排序把无关记忆挡在注入之前；
- Token 增幅集中在「原本完全不可见」的查询上，属于功能修复的必然成本，不是注入失控；
- 排除原因稳定：过期/被替代/归档/待确认各 7 次（每条查询各命中一次），低相关性 42 次。

> 口径：上表 Token 为 `heuristic-cjk-ascii-v1` 估算值，**不是**供应商 `prompt_tokens`。真实值需在部署环境按 `trace.sent.usage[].usageSource='provider'` 采集。

---

## 5. Trace 如何核对「真的发了什么」

`context-trace-verify.test.js` 用真实 `/chat` 入口 + 模块级桩 Provider 验证：

1. 桩捕获它收到的 `messages`；
2. 测试用同一算法（`sha256(JSON.stringify(role+content[+tool_calls]))`）复算哈希；
3. 断言 `trace.sent.rounds[].contentHash === 复算值`；
4. 断言 `trace.sent.usage[].usageSource === 'stub'`、`calibration === false`、`promptTokens === 321`（桩返回值）。

即：**Trace 记录的是实际发送内容，不是「打算发送」的内容**，且不需要把正文写进 Trace（隐私）。

---

## 6. 关于「撤回」的计量边界（重要）

撤回（`withdrawMemory`）与删除是**物理删除**：贡献被摘空的条目直接从 `memory.json` 移除，不保留 tombstone 或 `withdrawn` 状态（见 `server/memory-lifecycle.js` 文件头注释）。

因此：

- 检索漏斗**不存在** `withdrawn` 计数——条目已经不在库里，检索层看不到；
- 要「证明撤回后不会被注入」，靠的是行为测试而不是计数：`memory-lifecycle-golden.test.js` 的 D5、`memory-observability.test.js` 用例 4；
- 若要给撤回建立可聚合的计数，需要引入 tombstone 状态，那会改变存储与生命周期语义，属于 P3 之后的产品决策，本轮不做。

---

## 7. 已知限制

1. **估算器未校准目标模型 tokenizer。** `heuristic-cjk-ascii-v1` 按 CJK≈1/字、ASCII≈0.25/字符估算，再乘 1.25 安全系数。与真实 `prompt_tokens` 的偏差用 `estimateRatio` 观测，容差 0.35；是否收敛需在部署环境按真实 Provider 数据验证，本轮**未**做校准结论。
2. **Agent 多轮只记录末轮 usage 到 Trace。** 中间轮的 usage 由监控聚合（`trace.model.input_tokens` 累加）覆盖，但 `trace.sent.usage[]` 只有最后一轮。原因：`runAgentTurn` 未按轮回传 usage，改动它会侵入 Agent 循环，超出 P2 范围。
3. **流式 usage 依赖供应商末帧。** 拿不到就记 `missing`，不估算成真实值。
4. **`irrelevant` 是「池内未进结果」的聚合**，不区分具体打分原因（词面/语义/类型权重）。
5. **对比脚本只覆盖记忆注入段**，不含系统提示词与历史消息的 Token。

---

## 8. 遗留风险 / P0 阻断项

### ✅ 已处理：记忆管理接口的全库语义

**原问题**：`GET /memory` 与全部记忆管理接口是「全库」语义，没有按 `userId` 过滤。

**处理结果**（详见 `docs/p0-blocker-memory-ownership.md`）：

- `GET /memory`、`/memory/pending` 改为按可信 `userId` 过滤，无身份返回空（fail-closed）；
- delete / archive / confirm / reject 对他人 id 返回 **403** 且数据不变；
- `clear` 只清本人，`clear-session` 不越界摘他人贡献；
- Memory Bot 审批执行器（`memory-service.execute`）增加归属预检；
- 新增 `tests/memory-ownership.test.js`（29 项）覆盖上述行为。

**仍未解决的多用户前置条件**（不属于本阻断项，但上线前必须做）：

1. `resolveUserId` 需返回真实用户（当前恒为 `local-owner`，归属检查运行时恒真）；
2. 会话补 `userId` 维度——`GET /history?sessionId=X` 仍是「知道 id 就能读」；
3. 审批记录需携带请求者 `userId`；
4. `GET /memory/write-attempts` 是进程级诊断流（不含正文），未按用户过滤。

### 其他

| 风险 | 说明 | 缓解 |
|---|---|---|
| 用户级可见导致候选池变大 | 相关性排序与预算裁剪压力上升 | 漏斗字段 + `memory_retrieval_excluded_total` 已可观测 |
| 估算偏差未校准 | 见 §7.1 | `context_token_estimate_ratio` 直方图 + 对账事件 |
| 桩数据混入真实统计 | 已由 `provider_kind` + `usage_source` 隔离 | 测试进程强制 `BLUEBIRD_PROVIDER_KIND=stub` |

---

## 9. 修改文件

### 服务端

| 文件 | 改动 |
|---|---|
| `server/memory-lifecycle.js` | 新增 `classifyIneffective` / `INEFFECTIVE_REASONS`（不可见原因分类） |
| `server/memory.js` | `selectSearchCandidates` 增加原因分解与 `storeTotal/eligible`；`searchMemories` 增加 `funnel` / `visibilityReasons` |
| `server/context/input-guard.js` | `measureRequest` 增加逐块 Token、`memoryTokens`、`tokenSource` |
| `server/context/trace.js` | `recordRetrieval` 接收 diagnostics；`recordBuild` 增加块 Token；`recordSent` 增加 `contentHash`/`estimatedTokens`/`providerKind`；新增 `recordProviderUsage` |
| `server/context/retriever.js` | 把 `searchMemories().diagnostics` 透传到 outcome |
| `server/context/engine.js` | `recordRetrieval` 传入 diagnostics |
| `server/monitoring/schema.js` | 新增事件 `context.tokens.reconciled` |
| `server/monitoring/metrics.js` | `model_*` 增加 `provider_kind` 标签；新增 `memory_retrieval_excluded_total`、`memory_injected_tokens_total`、`context_token_estimate_ratio` |
| `server/monitoring/index.js` | `providerKind()`；`beginModelCall` 支持桩标注；`recordContextBuild` 落漏斗与块 Token；新增 `recordTokenReconciliation`；总览模型卡拆分供应商/桩 Token |
| `server/index.js` | `recordSentForContext` 带 `providerKind`；新增 `recordUsageForContext` 并在 Agent/普通/流式三条路径调用 |

### 测试与脚本

| 文件 | 改动 |
|---|---|
| `tests/memory-observability.test.js` | 新增（10 项） |
| `tests/context-trace-verify.test.js` | 新增（端到端 Trace 指纹 + 桩标注） |
| `tests/monitoring-api.test.js` | 断言改为「桩 usage 标 stub、不算真实」；总览卡区分供应商/桩 |
| `scripts/run-tests.js` | 统一 `BLUEBIRD_PROVIDER_KIND=stub` |
| `scripts/memory-token-compare.js` | 新增（改造前后对比） |
| `scripts/test-coverage-baseline.json` | 登记 3 个新测试文件（memory-observability 10 项、context-trace-verify 9 项、补登 P1 的 memory-user-scope 10 项） |
| `scripts/sync-doc-counts.js` | 新增三个测试文件的说明，文档计数由基线统一生成 |

---

## 10. 测试结果

```
node scripts/run-tests.js
→ 当次 63 个测试文件全部通过（当前总数以 scripts/test-coverage-baseline.json 为准）

node scripts/verify-test-coverage.js
→ 当次 CI runner 覆盖：63/63 个测试文件
→ 当次 backend=1851/1851 nodeSuite=221/221 runner=1630/1630
→ frontend=181/181 suites=22/22 failed=0
→ ✔ 测试覆盖验证通过

node scripts/sync-doc-counts.js --check
→ ✔ 文档计数与基线一致
```

```
node tests/memory-semantic-eval.js --assert
→ ✔ 语义检索评测通过（Recall@5=0.9722, forbidden=0, crossSessionLeaks=0）

node tests/retrieval-eval.js --assert
→ recallAt5=1, mrr=0.9583；向量通道 unavailable（未配置，不冒充通过）

node scripts/memory-token-compare.js
→ 见 §4
```

**未验证项（如实声明）**：

- 真实 Provider 的 `prompt_tokens` 与估算值的收敛情况——需要部署环境真实调用，本轮只有桩与单元级验证；
- 多轮 Agent 的逐轮 usage——见 §7.2；
- 流式 usage 的真实可用性——取决于供应商是否在末帧返回。
