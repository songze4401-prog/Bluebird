# 记忆语义检索固定评测（2026-10-28）

## 1. 数据与方法

- 数据来源：`tests/memory-eval/fixtures.js` 的 22 条脱敏种子（来源为项目既有测试语料，不含真实用户数据）。
- 固定补充 4 条：`M23` 旧咖啡事实（superseded）、`M24` 新咖啡事实、`M25` 未来生效事实、`M26` agent 来源咖啡偏好。
- 固定 22 个查询，覆盖同义改写、上下位、中英检索、无关查询、旧/新事实、跨会话隔离、历史 asOf。
- 每个查询显式列出 `expect`、`forbid`、`session`、`mode`；身份条目按产品规则保底，MRR 排序时仅保留查询明确期望的 identity 项。
- 指标：Recall@5、Recall@10、MRR、forbidden 命中、无答案泄漏、排序失败。
- 端到端检查：`memory_search` 工具、`buildMemoryContext`、来源过滤、token/条数预算、解释元数据、小库不绕过滤。
- 评分数据来自 `tests/memory-semantic-eval.js` 的真实 `searchMemories` 调用，不是静态清单。

## 2. 基线 → 修改后

| 版本 | Recall@5 | Recall@10 | MRR | forbidden | 无答案泄漏 | 排序失败 |
|---|---:|---:|---:|---:|---:|---:|
| main `bcaa676`，6 概念，无相关度门槛 | 0.472222 | 0.500000 | 0.472222 | 1 | 1 | 10 |
| 扩展前 + 最低相关度门槛（实测 0.05，最终 0.04） | 0.416667 | 0.444444 | 0.444444 | 0 | 0 | 10 |
| 扩展后（17 概念）+ 最低相关度 0.04 | **0.972222** | **1.000000** | **1.000000** | **0** | **0** | **0** |

说明：

- 扩展前门槛把英文常用二元组造成的噪声命中（例如把 “what computer” 里的 `do` 误配到 Windows，相关度约 0.019）压掉；实测门槛为 0.05，最终保留 0.04 以容纳合法的“一个二元组/六个内容二元组”低分命中，22 个固定查询结果不变。因此扩展前的 Recall@5 略有下降，但 forbidden/无答案泄漏归零。扩展后新概念召回使 Recall 和 MRR 明显上升。
- 初始 6 概念的 forbidden=1 来自 `M18` 这条 identity 在“what is my name”中的策略性保底，不是跨会话泄漏；`crossSessionLeaks` 仍为 0。
- 固定评测的 Q01/Q02 的 Recall@5 为 0.75，是因为两条 identity 按产品策略占据 top5 名额，Recall@10 为 1.0；未通过隐藏 identity 或改 K 的方式美化指标。

## 3. 端到端结果（扩展后）

`node tests/memory-semantic-eval.js --assert`：

```text
summary: Recall@5=0.972222 Recall@10=1 MRR=1
forbidden=0 noAnswerLeaks=0 orderingFailures=0
toolReturnsExpected=true
contextContainsExpected=true
contextHasNoCrossSession=true
sourceFilterReturnsAgentOnly=true
budgetLimited=true
budgetMetadata=true
explainability=true
smallStoreNoFullInjection=true
```

固定数据集的 `memory_search` 工具、`buildMemoryContext`、来源过滤、预算截断、语义解释字段均连通；小库查询只保留 identity 保底，不把无关偏好全量注入。

## 4. 复现

```bash
# 扩展后固定评测（会失败于阈值不达标）
npm run eval:semantic

# 仅输出报告，不设阈值
node tests/memory-semantic-eval.js --json-out=/tmp/semantic-after.json

# 既有语义/检索测试
node tests/memory-semantic.test.js
node tests/memory-retrieval.test.js
```

注意：`--json-out` 在 Windows Node 下是 Node 解析的路径；Git Bash 的 `/tmp` 与 Node 的 `/tmp` 可能不是同一目录，建议使用绝对 Windows 路径或 `node -e` 读取。

## 5. 限制

- 这是概念词典评测，不是神经/向量语义评测；词典未覆盖的同义表达无法保证。
- 固定 22 条种子和 22 个查询只能证明本评测集上的排序/召回契约，不能证明真实用户语料上的整体质量提升；需要后续带标注的真实/脱敏语料再评估。
- 评测的 identity 保底策略会占用 topK 名额；报告同时给出 Recall@10 与 MRR，避免只展示单一指标。
- 补充的 4 条固定数据是为覆盖新旧事实/未来事实/来源过滤而构造的合成条目，不是真实用户数据。
