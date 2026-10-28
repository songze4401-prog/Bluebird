# Bluebird 记忆检索：概念语义层与能力边界

日期：2026-10-28  
基线：`ce4dfe7`（PR #31 合并后的 main）

## 1. 先评估，再选择

| 方案 | 评估结果 | 是否采用 |
|---|---|---|
| 现有依赖 | `package.json` 只有 Expo/React Native/Express/OpenAI SDK 等；`node_modules` 中没有 Transformers.js、ONNX Runtime、TensorFlow 或 embedding 库 | — |
| 本地模型缓存 | 机器上没有 Hugging Face / Torch / Ollama 缓存；`ollama` 未安装 | — |
| Transformers.js + 小型 ONNX embedding | 需要新增运行时依赖并从外部下载模型（数十 MB 起），属于新增外部模型/下载，需批准 | 否 |
| 本地 Ollama / 本地推理服务 | 当前环境未安装；部署环境也不保证存在，属于新增重型运行时依赖 | 否 |
| 付费 embedding API / 外部向量数据库 | 任务明确禁止未经批准接入；且会引入外部网络与费用 | 否 |
| 纯 JS 概念词典（本实现） | 无新依赖、确定性、可解释、可测试；覆盖同义/上下位/跨语言词表，但不是神经 embedding | 是 |

结论：**仓库当前不具备真正的神经/向量语义召回条件**。本轮实现的是**概念级语义召回**，用于补上“词面完全不重合但概念相同”的缺口；开放域语义仍明确标记为阻塞（能力元数据 `blocked: 'neural_embedding_not_available'`），不把字符二元组或未覆盖词表冒充为向量语义。

评估证据：
- `package.json` 的 dependencies/devDependencies 中没有 embedding/ONNX/TensorFlow/Transformers 包。
- 在 `node_modules` 中按名称查找 `*xenova*` / `*transformers*` / `*onnx*` / `*tensorflow*` / `*sentence*` / `*embedding*`，未找到可用运行时。
- 当前环境不存在 `~/.cache/huggingface`、`~/.cache/torch`、`~/.ollama`，`ollama` 命令不可用。
- 因此本地神经模型需要新增依赖与模型文件/下载，属于需批准的外部资源；本轮未接入。

## 2. 实现

### `server/memory-semantic.js`

- 词典把文本映射到稳定 concept（17 个）：`coffee`、`editor`、`city`、`cat`、`name`、`nickname`、`job`、`allergy`、`theme`、`project`、`birthday`、`exam`、`computer`、`spicy_food`、`travel`、`license_plate`、`dietary_restriction`。
- 支持中文、英文、大小写与词边界；英文按词边界匹配，避免 `cat` 命中 `catalog`。
- `semanticSimilarity(query, memoryText, keywords)` 返回：
  - `score = 0.7 * coverage + 0.3 * precision`
  - `coverage = 共享 concept 数 / query concept 数`
  - `precision = 共享 concept 数 / memory concept 数`
  - `concepts`、`evidence`（双方命中的词典词）、`provider`、`kind`、`neural:false`、`limited:true`；非 identity 候选还需达到最低混合相关度 0.04；没有关键词命中时，内容二元组重合至少 0.10 才入选，过滤英文常用二元组噪声
- 没有命中共有 concept 时严格返回 0；纯字符重合不会产生语义分。

### 混合排序（`server/memory.js`）

```text
词面相关度 = 关键词命中 * 0.7 + 字符二元组重合 * 0.3
混合相关度 = 词面相关度 * 0.7 + 概念语义分 * 0.3
综合分     = 混合相关度 * 类型权重 * 时间衰减 * 状态权重 * 置信度权重
```

查询没有命中任何 concept 时语义分为 0，行为与上一轮词面检索一致；命中时，词面完全不同的同义/跨语言记忆可以被召回，但综合分仍受类型、时效、状态、置信度约束。过滤与预算顺序不变：先过滤、再排序、最后按条数/字符/近似 token 截断。

### 可解释结果

每条结果保留：
- `id`、`sourceTypes`、`scope`
- `match.reason`、`match.keywords`
- `match.semantic.{matched,score,coverage,precision,concepts,evidence,provider,kind,neural,limited,blocked}`
- `components.{lexicalRelevance,bigramScore,semanticScore,hybridRelevance,typeWeight,timeDecay,statusWeight,confidenceWeight,semanticBlocked}`
- `contentTruncated`、`truncatedItems`、`budgetTruncated`、`notReturned`

`searchMemories` 返回完整诊断；`memory_search` 工具只把紧凑字段与语义 provider 元数据交给模型。

## 3. 测试

| 命令 | 结果 |
|---|---|
| `node tests/memory-semantic.test.js` | 54/54 |
| `node tests/memory-semantic-eval.js --assert` | 22 个固定查询；扩展后 Recall@5 0.9722 / Recall@10 1.0 / MRR 1.0；详见 `docs/memory-semantic-eval.md` |
| `node tests/memory-retrieval.test.js` | 47/47 |
| `node tests/memory-eval-baseline.test.js` | 22/22 |
| `node tests/agent-tools.test.js` | 119/119 |
| `node scripts/verify-test-coverage.js` | 运行时计数与 CI 清单对账通过 |

覆盖：同义（`latte`/`美式咖啡`）、上下位（`coffee`/`美式`）、跨语言（`coffee`/中文咖啡、`where do I live`/`住在杭州`）、英文词边界、无概念文本、混合排序、低相关排除、pending/future/superseded、跨会话隔离、来源/状态/时间过滤、条数/字符/token 预算、截断元数据、词面重合但不虚报语义。

## 4. 仍阻塞的能力

1. **神经/向量语义**：没有本地 embedding 模型或推理依赖；开放域同义词、上下文消歧、词典未覆盖语言无法保证召回。需要明确批准新增本地模型文件与推理依赖（或部署本地模型服务）后才能实现。
2. **跨语言范围**：当前只覆盖词典内的中英概念；其他语言、同义表达、比喻/隐含语义不在保证范围。
3. **语义歧义**：一个词映射到多个概念时没有上下文消歧；当前词典刻意只收具体概念，避免泛化误召回。
4. **真实问答效果**：固定数据集验证的是排序与召回契约，不代表真实用户语料的端到端提升；需要后续带标注集的离线评测。

在获得模型/服务批准前，不应把本实现描述为“完整神经语义检索”或“开放域语义召回已完成”。
