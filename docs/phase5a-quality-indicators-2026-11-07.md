# Phase 5-A 第 2 轮：§7 八项质量指标

> 依据：Notion Agent Runtime v1.0 **§7**（评测必须覆盖的八项质量指标）与台账行 **A-07** 的指标部分。
> 上游：`docs/phase5-charter-2026-11-06.md`（P5-A 交付包与轮次验收规则）、`docs/phase5a-eval-tiers-and-comparators.md`（第 1 轮：分层与比较对象）。
> 本轮所有数字都是**离线重放**或**本地 stub 模型的端到端跑**实测，不是真实供应商延迟；区分见 §5。

## 1. 八项指标 → 代码落点

模块：`server/agents/eval-indicators.js`（口径版本 `p7-indicators-v1`），入口 `node scripts/eval-offline.js --indicators=true`。

三条硬约束决定了整个模块的形状，违反任何一条就等于造了第二套口径：

1. **只读既有事实来源**，不新建存储、不新增状态：任务与 run 历史（`tasks.allTasks()`）、事件（`tasks.listEvents`）、幂等账本（`op-ledger.read()`）、审批记录（`approvals.listApprovals`）、产物与来源链（`artifact-store`）、对照快照（第 1 轮的 `eval-baseline` 快照）。
2. **算不出来就是 unknown，绝不回落成 0**：分母为 0 或缺依赖时 `known:false` 且 `value:null`，并写明缺什么。把"没采到"报成 0% 会把观测缺口伪装成质量达标——这与 `eval-metrics` 的未知桶是同一条纪律。
3. **每行自带定义与数据来源**：报告里能直接回答"这个数怎么来的、缺什么才能算"，不留一排无出处的数字。

| §7 指标 | 分子 / 分母 | 数据来源 | 测试 |
|---|---|---|---|
| 过度拆解率 | 成果未引用任何子任务产物的根任务 / 子任务数 ≥2 的根任务 | `tasks.allTasks().parentTaskId` + 任务与产物的 `provenanceRefs` + `artifact-store.get(id).taskId` | a、b、i |
| 并行耗时收益 | (单执行体平均延迟 − 组队平均延迟) / 单执行体平均延迟 | 第 1 轮两类比较对象快照的 `metrics.latency.avgMs`，允许负数 | a、c |
| 失败恢复率 | 有失败 attempt 且终态 completed 的任务 / 有失败 attempt 的任务 | `tasks.allTasks().runs[].status` 与终态 | a、d |
| 重复副作用率 | `executions > 1` 的账本条目 / 带 `executions` 字段的条目 | `op-ledger`，新增计数器（§2） | a、e |
| 证据完整率 | 证据集非空、无残缺引用且全部读回无问题的 completed 任务 / completed 任务 | `artifact-store.verifyRefsReadable()` + 任务与产物的 `provenanceRefs` | a、f、i |
| 来源独立性 | 产生任务 ≠ 消费任务的引用 / 可追溯产生方的引用 | `artifact-store.get(id).taskId` 对照消费任务 | a、f、i |
| Reviewer 检出率 | TP / (TP+FN)，真值取机械校验 | `verification.verdict` **与** `verification.conflict` 事件的 `deterministicOk`/`verdict` | a、g、i |
| 审批命中率 | 阻断性决定中机械校验不过或确有冲突 / 拿到裁决事实的阻断性决定（rejected/expired/escalated） | `approvals.listApprovals()` 状态 + 上述裁决事件 | a、g |
| 审批误拦截率 | 与命中率同分母的补集（两率相加恒等于 1） | 同上 | a、g |

## 2. 为使「重复副作用率」可算而新增的唯一埋点

此前账本只有 `status`，一次动作被真实执行过几次读不出来（`begin` 会短路重复执行，但短路成功与"重复执行被拦下"在账本里长一个样）。新增：

- `opLedger.begin()` 新记录带 `executions: 0`；
- `opLedger.finish(opKey, {status:'succeeded'})` 才 `executions += 1` 并写 `lastExecutedAt`；
- **旧条目不回填**：读取端把没有该字段的条目单独计 `unknown`，既不进分子也不进分母，否则"埋点上线之前的全部账本"会把指标稀释成假的 0。

这是本轮唯一的写入侧改动，其余全部是读侧。

## 3. 实测两份语料

### 语料 A：离线对照重放（`--comparator=candidate`，dev+val 共 10 例，Node v24.19.0）

```
[EVIDENCE] eval-indicators {"policyVersion":"p7-indicators-v1",
  "indicators":[
    {"name":"over_decomposition","known":false,"value":null,"numerator":0,"denominator":0,
     "caveat":"本轮没有多子任务的根任务样本，无法判定拆解是否过度"},
    {"name":"parallel_time_gain","known":true,"numerator":-40,"denominator":590,"value":-0.0678,
     "singleAvgMs":590,"teamAvgMs":630},
    {"name":"failure_recovery","known":true,"numerator":2,"denominator":2,"value":1},
    {"name":"duplicate_side_effect","known":false,"unknown":0,
     "caveat":"幂等账本里没有条目：这批样本没有产生带副作用的工具调用"},
    {"name":"evidence_completeness","known":true,"numerator":0,"denominator":10,"value":0},
    {"name":"source_independence","known":false,"numerator":0,"denominator":0,"unknown":0,
     "caveat":"样本里还没有可追溯产生方的产物引用"},
    {"name":"reviewer_detection","known":false,"numerator":0,"denominator":0,
     "confusion":{"total":3,"classifiable":3,"unclassified":0,"problems":0,"caught":0,"falseAlarms":0}},
    {"name":"approval_precision","known":false,"caveat":"本轮没有阻断性审批决定"},
    {"name":"approval_false_block","known":false,"caveat":"本轮没有阻断性审批决定"}],
  "summary":{"total":9,"known":3,"unknown":6,
    "unknownNames":["over_decomposition","duplicate_side_effect","source_independence",
                    "reviewer_detection","approval_precision","approval_false_block"]}}
```

四条读法：

1. **并行收益是负的**（−6.8%）：组队比单执行体慢，这是真实结论而不是显示问题，指标刻意允许负数。离线 stub 里组队多一轮编排开销、并行度并未真正体现。
2. **证据完整率 0/10 是真的 0**：离线用例的 completed 任务一条证据引用都没写。这不是"没采到"——字段存在、内容为空，所以进分母并进分子判定。它度量的是离线语料的形态，不是生产形态（生产形态见语料 B）。
3. **unknown 的原因分两类写**：`duplicate_side_effect` 的 unknown 是**这批样本压根没有副作用调用**（账本 0 条），不是"埋点没上线"；`source_independence` 的 unknown 是没有产物。两种缺口的补救动作不同，混写就会掩盖真实原因。
4. 3 条裁决事件的 `deterministicOk` 全为 true → problems 为 0 → 检出率不可算。这是第 1 轮 §5 已记录的同一件事：离线 stub 的审校没有真判决。

### 语料 B：§20 端到端 worked example（真实链路、本地 stub 模型，`--data-dir` 保留）

```
node scripts/run-worked-example.js --data-dir <dir>
BLUEBIRD_DATA_DIR=<dir> node scripts/eval-offline.js --indicators=true
→ evidence_completeness 3/3 = 1.0000
→ source_independence  2/4 = 0.5000
→ 其余 7 项 unknown（无失败 attempt、无副作用账本条目、无阻断性审批、无多子任务根任务）
```

这份语料是修好读路径之后才有的数：**同一份数据在修复前是 `evidence_completeness 0/3` 与 `source_independence unknown`**。

## 4. 本轮实测发现并修掉的四处假数

都是"fixture 形状与真实存储不一致"这一类，靠单元测试的自造对象发现不了，最后由 `--indicators` 直接读真实数据目录暴露：

1. **证据链读漏一半**（假阴性，最严重）。§16 的交付证据钉在**产物**的 `provenanceRefs` 上（`server/agents/artifact-commit.js:174`，`publishSharedConclusion` 落 conclusion 产物时写入），任务级 `provenanceRefs` 只是创建继承/验证改写的通道（`server/agents/tasks.js:1034`）。只读任务字段时，真实端到端的三个 completed 任务全被判"零证据"，来源独立性则整列 unknown。修法：证据集取任务级与其产物级引用的并集，按 `(id, version)` 去重，缺 `id` 的残缺引用单独计 `malformed`（不算完整、不静默丢弃）；产物视图未注入时整项退回 unknown。
2. **冲突裁决看不见**。同一份验证载荷会落两个事件类型（`server/agents/verification-loop.js:1067`）：正常裁决 → `verification.verdict`，冲突 → `verification.conflict`。只认前者会把冲突样本整条排除，审批命中率就把"确实存在冲突"的阻断决定报成误拦截。修法：矩阵同时吃两类事件，`conflict` 事实由事件类型或 `payload.conflict`/`decision==='conflict'` 给出；缺真值或缺 `verdict` 的行进 `unclassified` 并在行上 `unknown` 计数报出，不当成"没问题"。
3. **行构造器吞字段**。`row()` 原先按固定白名单组装，`singleAvgMs`/`teamAvgMs`/`confusion` 传进去就消失了——CLI 报告只剩比率，读者无法核对分子分母从哪来。修法：白名单之外的口径原样带出，用例 c 断言两个原始平均值可见。
4. **unknown 归因写错**。空账本的 caveat 曾写成"该字段随本轮上线，旧条目不回填"，而真实原因是"这批样本没有带副作用的工具调用"。补救动作不同（前者要等埋点，后者要换语料），所以拆成两条表述并各有一条断言（用例 e）。

## 5. 已知限制（不得当成已完成）

1. **没有一份语料能同时把八项算出数**。语料 A 出 3 项、语料 B 出 2 项，合起来 5 项有真实数字；`over_decomposition`、`duplicate_side_effect`、`reviewer_detection`、审批两率的真实分布仍需要：≥2 子任务的拆解用例、走真实工具网关的副作用链、Reviewer 的真判决、以及被驳回/过期的审批。这些都要真实模型轮次（LongCat 额度）才能同时具备。
2. **并行收益目前只有离线口径**：延迟来自 stub 的 `simulatedMs`，负号说明的是编排开销，不能据此断言"组队在生产里更慢"。
3. **审批两率的"真值"仍弱**：以 `deterministicOk` 为真值只能覆盖机械校验可判定的那部分；需要人工复核才暴露的问题不在这条分母里，因此两率是下界而非全量质量。
4. **指标未接入看板与门禁**：`--require-indicators` 只在显式调用时拦截；默认不因 unknown 失败（空仓库里 unknown 是事实，不是缺陷）。要让 CI 卡住缺数，得先有一份能稳定出数的语料，属于 §5.1 的后续。
5. **来源独立性只看到"已定稿"的引用**：running 任务的引用尚未定稿，刻意排除在分母外；因此该指标衡量的是交付结果的独立性，不含中间态。

## 6. 台账 A-07 的指标部分

本轮补齐 §7 的八项定义、口径与可执行入口，A-07 的两处遗留（真实模型证据、指标入门禁）仍留在 §5 的 1/2/4。与第 1 轮合并计为 **A-07：`0 → 0.5`**，行内证据写本文 §1、§3、§4，缺口写本文 §5 的 1/2/4。回填已于 2026-11-07 在 `docs/ledger-a07-b07-backfill-2026-11-07` 这一轮按行级重算脚本 `scripts/scan-notion-ledger.js` 执行（与 B-07 同轮，汇总 `1`=16 / `0.5`=9 / `0`=0）；原时机说明见 `docs/phase5-charter-2026-11-06.md` 的 P5-A 遗留段（PR #59 已合并，不再受同文件冲突限制）。

## 7. 复现命令

```bash
# 语料 A：离线对照重放 + 指标（两份成对快照才能算并行收益）
BLUEBIRD_DATA_DIR=<dirA> BLUEBIRD_AGENT_TASK_MAX_ATTEMPTS=3 \
  node scripts/eval-offline.js --comparator=candidate --tiered --splits=dev,val --out=<dirA>/candidate.json
BLUEBIRD_DATA_DIR=<dirS> BLUEBIRD_AGENT_TASK_MAX_ATTEMPTS=3 \
  node scripts/eval-offline.js --comparator=single_agent_fast_path --tiered --splits=dev,val --out=<dirS>/single.json
BLUEBIRD_DATA_DIR=<dirA> node scripts/eval-offline.js --indicators=true \
  --parallel-single=<dirS>/single.json --parallel-team=<dirA>/candidate.json

# 语料 B：端到端 worked example 后原地读回（--data-dir 会保留存储）
node scripts/run-worked-example.js --data-dir <dirB>
BLUEBIRD_DATA_DIR=<dirB> node scripts/eval-offline.js --indicators=true

# 显式要求某几项必须有数（真实评测轮用；缺数退出码 1）
BLUEBIRD_DATA_DIR=<dirB> node scripts/eval-offline.js --indicators=true --require-indicators=evidence_completeness,source_independence

# 本轮测试
node tests/agent-eval-indicators.test.js    # 10 项
```
