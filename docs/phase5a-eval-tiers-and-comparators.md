# Phase 5-A 第 1 轮：评测集分层与五类可比较基线

> 依据：Notion Agent Runtime v1.0 **§14**（评测集分层 + 基线不锁死 + 配置记录）与台账行 **A-07**。
> 上游：`docs/phase5-charter-2026-11-06.md`（P5-A 交付包与轮次验收规则）。
> 本文所有数字均为**离线 stub 重放**实测，非真实模型延迟/成本；区分见「已知限制」。

## 1. §14 原文要求 → 本轮落点

| 原文要求 | 代码落点 | 测试 |
|---|---|---|
| 评测集分四类：开发集、验证集、保留测试集、轮换挑战集 | `server/agents/eval-tiers.js` `SPLITS`/`VISIBILITY`/`validateSplits`；`server/agents/eval-suite-v1.json` 13 例标注 `split`（dev 6 / val 4 / holdout 3），新文件 `eval-suite-rotation-v1.json` 3 例 `rotation` | `tests/agent-eval-tiers.test.js` a |
| 保留集与轮换集不向被优化 Agent 暴露样例和答案 | `agentVisibleCase()` 按分层裁剪 `goal`/`expectedTerminal`/`allowedErrorCodes`/`script`，并回写 `withheldFields`；`optimizerReport()` 只把 dev 逐例外发，val 只发聚合，holdout/rotation 合并成计数桶 | b、f |
| 泄漏即退役 | `scanLeak()`（子串命中隐藏集样例或期望终态）→ `markLeak()`；`planRotation()` 退役优先级 `leaked > overused > manual_freeze` | c、d |
| 使用过多的 holdout 必须退役、轮换集定期补充 | `recordUse()` 单调计数（重复时间戳幂等、乱序不回拨）；`planRotation()` 出 `replacementsRequired`/`hiddenPoolExhausted`/`rotationDue`/`nextRotationAt`；`markRotationApplied()` 记节奏 | d、e、f |
| 基线不锁死：每轮可比较当前生产/主分支 Runtime、单 Agent 快速路径、当前 Runtime+指定能力、关闭某机制的消融版本、候选架构 | `server/agents/eval-comparators.js` `REGISTRY` 四类 + `ablation` 显式声明；`eval-runner.js` `resolveRun()`/`runSuite({comparator})` 真正按机制开关分派 | `tests/agent-eval-comparators.test.js` a、d |
| 报告记录代码 commit、模型与参数、提示词版本、工具权限、数据集版本、预算、评测时间 | `buildConfig()` 八个必填字段缺任一项直接拒绝；快照 `config` 字段随 `createSnapshot()` 落盘 | b、f |
| 不同配置不得混称同一基线 | `identityOf()` 配置身份哈希（对 `codeCommit`/`evaluatedAt` 不敏感，对模型/提示词/权限/数据集/预算/机制开关敏感）；`compareReports()` 区分 `same_baseline_replay` 与 `config_change`；`compareMatrix()` 的 `upgradeEligible` 要求成功率改善且安全指标不退化 | c、e、f |

## 2. 数值口径（B 类，需实测或 Owner 校准）

| 参数 | 默认值 | 取值理由 | 状态 |
|---|---|---|---|
| `holdoutMaxUses` | 6 | 同一保留用例反复参与选型会把它变成事实上的开发集；6 次是保守上限 | 待压测/Owner 校准 |
| `rotationIntervalMs` | 7 天 | 轮换挑战集最小补充间隔 | 待 Owner 校准 |
| `minNewCasesPerRotation` | 1 | 每次轮换至少补入的新用例数 | 待 Owner 校准 |
| `REQUIRED_CONFIG_FIELDS` | 8 项 | §14 原句逐项 | 原文可直引 |
| 消融允许关闭的机制 | `autonomyPolicy`/`teamReview`/`replan` | 只有 runner 真的听得懂的三个开关；未接线的机制不允许写进 `ablating`，否则"消融"变成空话 | 本轮裁决 |

## 3. 实测证据（`node scripts/eval-offline.js`，Node v24.19.0）

三轮各用独立 `BLUEBIRD_DATA_DIR`（safety 指标读事件聚合，混跑会互相污染），`BLUEBIRD_AGENT_TASK_MAX_ATTEMPTS=3`，分层选 `dev,val` 共 10 例。
同一组数字在提交前工作树（基点 `15090aa`）与提交后干净树（`c5807e1`）各跑一次，两轮结果逐项一致（生产 `identity` 均为 `c030ca6e…c4a31`；配置身份刻意不含 `codeCommit`）：

```
[EVIDENCE] eval-matrix {"reference":{"id":"production","identity":"c030ca6e…c4a31"},
  "rows":[
    {"comparator":{"id":"candidate","mechanisms":{"autonomyPolicy":true,"teamReview":true,"replan":true}},
     "comparisonKind":"config_change",
     "successRate":{"before":0.9,"after":1,"delta":0.1,"change":"improved"},
     "reworkRate":{"before":0.1,"after":0.2,"change":"degraded"},
     "tokenCostTotal":{"before":1370,"after":1570,"delta":200,"comparable":false},
     "latencyAvgMs":{"before":590,"after":630,"change":"degraded"},
     "safetyDegraded":false,"tokenComparable":false,
     "mismatchedFields":["comparatorId","mechanisms"]},
    {"comparator":{"id":"ablation","mechanisms":{"autonomyPolicy":true,"teamReview":false,"replan":true},"ablating":["teamReview"]},
     "comparisonKind":"config_change",
     "successRate":{"before":0.9,"after":1,"change":"improved"},
     "tokenCostTotal":{"before":1370,"after":1450,"delta":80,"comparable":false},
     "mismatchedFields":["comparatorId","mechanisms","ablating"]}],
  "summary":{"candidatesCompared":2,"improved":["candidate","ablation"],
             "degradedSafety":[],"upgradeEligible":["candidate","ablation"]}}
```

读法（三条都是原文验收句要的口径）：

1. **改善归因清楚**：候选相对生产 +0.1 成功率，唯一变化来自 `exec-recover-after-failure`（审校驳回后重规划救回）；代价是返工率翻倍、每例多 40ms、总 token +200。
2. **消融版本的信号是负的**：只关 `teamReview`（保留重规划）与全开候选的成功率同为 1.0，成本反而少 120 token——**离线 stub 里独立复核不产生可测的成功率收益**，复核的价值只能在真实模型轮次（Reviewer 有真实判决）上度量，不得拿本轮数字声称复核有效。
3. **不混称基线**：两轮 `comparisonKind` 都是 `config_change` 并列出 `mismatchedFields`；`tokenComparable=false` 因为 dev/val 里各有一例故意无 usage（未知桶），token 差异只报数不报可比性。

其余实测：

```
[EVIDENCE] eval-rotation-plan {"counts":{"dev":6,"val":4,"holdout":3,"rotation":3},
  "retired":[],"hiddenPool":6,"hiddenPoolExhausted":false,"replacementsRequired":0,
  "rotationDue":true,"policy":{"holdoutMaxUses":6,"rotationIntervalMs":604800000,"minNewCasesPerRotation":1}}

[EVIDENCE] eval-leak-scan {"hiddenSplits":6,"hits":["hard-failure"],"marked":false}   # 退出码 1
```

`--leak-scan` 命中即非零退出：提示词模板里出现保留集样例「在无证据情况下强行给出结论」被识别为 `hard-failure` 泄漏。

## 4. 分层可见性矩阵（`eval-tiers.VISIBILITY`）

| 分层 | 样例可见 | 答案可见 | 逐例结果可见 | 优化方报告形态 |
|---|---|---|---|---|
| dev | 是 | 是 | 是 | 逐例 `caseId/success/terminal` |
| val | 是 | 否 | 否 | 只有 `count/successRate` |
| holdout | 否 | 否 | 否 | 只有数量与聚合 |
| rotation | 否 | 否 | 否 | 只有数量与聚合 |

## 5. 已知限制（不得当成已完成）

1. **全部证据来自离线 stub**：延迟与 token 是脚本里的 `simulatedMs`/`usage` 模拟量，不是供应商真实值；§14 的"每轮可比较"要落到真实模型轮次才算完成验收。
2. **`approvalBypass` 不随比较对象变化**：Phase 4 的 stub 语义是「用例声明 `expectReview` 就写审校事件」，因此生产基线也不会出现绕过计数，安全列在五类对照里目前只有 `deadLetters` 有区分度。要让它有区分度，必须把审校事件改成由 Reviewer 子任务的真实判决驱动（属 P5-B/P5-C 范围）。
3. **轮换补入仍是人工动作**：`planRotation()` 给出 `replacementsRequired` 与到期信号，但新用例要靠人工编辑 `eval-suite-rotation-v1.json`；没有「入库→校验→标记已轮换」的自动闭环。
4. **泄漏扫描未入门禁**：`--leak-scan` 需显式调用，提示词/模板改动不会自动扫描，因此"不向被优化 Agent 暴露"目前是工具能力而非强制闸门。
5. **用量状态跟着数据目录走**：默认 `.eval-data/` 每次跑前清空，轮换节奏要持久保存必须显式设 `BLUEBIRD_DATA_DIR` 或 `--state-path`。
6. **历史快照无 `config` 字段**：`p4-eval-v1` 时代落盘的快照缺配置记录，`compareReports()` 会拒绝判定（"快照缺少基线配置记录"），只保留 `baseline.diff()` 逐例对照；没有迁移脚本，也不得用默认值伪造历史配置。

## 6. 台账 A-07 拟改判（回填时机说明）

本轮满足 §14 的机制与规则部分，未满足真实模型证据与闭环，故 **A-07：`0 → 0.5`**，行内证据写本文 §1、§3，缺口写本文 §5 的 1/3/4。

回填当时不在本分支执行：`docs/notion-delivery-ledger-2026-11-04.md` 正被 PR #59（`fix/ledger-notion-alignment-2026-11-06`）同文件改写（A-08/A-10/A-11/A-13 四行 + 汇总 + §17 对齐表），两处都动汇总块会丢一方的勘误行。**2026-11-07 更新：该限制已解除**（#59/#60/#61/#62/#63 全部合并），A-07 行已在 `docs/ledger-a07-b07-backfill-2026-11-07` 这一轮改判 `0 → 0.5`（旧值与历次勘误全部保留），汇总由行级重算脚本 `scripts/scan-notion-ledger.js` 刷新为 `1`=16 / `0.5`=9 / `0`=0（脚本口径：逐行切第 5 列状态、取最后一个 `→` 之后的值，无法识别即抛错，不按记忆写数字；`--check` 与汇总双向对账，不一致退出码 1，已由 `tests/notion-ledger-scan.test.js` g/h 纳入 CI）。

## 7. 复现命令

```bash
# 五类对照（每个 comparator 独立数据目录）
BLUEBIRD_DATA_DIR=/tmp/p5a-prod BLUEBIRD_AGENT_TASK_MAX_ATTEMPTS=3 \
  node scripts/eval-offline.js --comparator=production --tiered --splits=dev,val --out=/tmp/p5a/prod.json
BLUEBIRD_DATA_DIR=/tmp/p5a-cand BLUEBIRD_AGENT_TASK_MAX_ATTEMPTS=3 \
  node scripts/eval-offline.js --comparator=candidate --tiered --splits=dev,val --out=/tmp/p5a/cand.json --record-usage=true
BLUEBIRD_DATA_DIR=/tmp/p5a-abl BLUEBIRD_AGENT_TASK_MAX_ATTEMPTS=3 \
  node scripts/eval-offline.js --comparator=ablation --ablating=teamReview --tiered --splits=dev,val --out=/tmp/p5a/abl.json
node scripts/eval-offline.js --matrix=/tmp/p5a/prod.json,/tmp/p5a/cand.json,/tmp/p5a/abl.json   # 无可升级候选时退出码 1
node scripts/eval-offline.js --rotation-plan=true
node scripts/eval-offline.js --leak-scan=/tmp/p5a/tpl.txt --mark-leak=true                      # 命中即退出码 1

# 本轮测试
node tests/agent-eval-tiers.test.js          # 6 项
node tests/agent-eval-comparators.test.js    # 6 项
```
