# P3：回归验收

> 对应架构决策：`Bluebird 跨会话记忆与上下文隔离架构`（Notion）第 7 节「验收标准」+ 第 6 节 P3
> 前置：`docs/p0-cross-session-memory-rootcause.md`、`docs/p1-user-scoped-memory.md`、`docs/p2-memory-observability.md`

- 实施日期：2026-11-02
- 范围：验收与度量，不改作用域模型、不新增功能。

---

## 1. 结论摘要

| 项 | 结论 |
|---|---|
| 跨会话召回 | ✅ 通过（R1） |
| 无关记忆不注入 | ✅ 通过（R2，无关注入率 0%） |
| 会话历史隔离 | ✅ 通过（R3，存储 + 检索两条路） |
| 跨用户拒绝 | ✅ 通过（R4，泄漏 0） |
| 项目范围过滤 | ⏸ **不适用**（代码库无 Project 实体，未实现） |
| Agent 任务隔离 | ✅ 通过（R6） |
| 撤回/过期/被替代不注入 | ✅ 通过（R7） |
| 失败与无结果可区分 | ✅ 通过（R8，reason 码稳定） |
| 大规模记忆库 | ✅ 通过（R9，条数与 Token 双受限） |
| Trace 与实际发送一致 | ✅ 通过（R10 + `context-trace-verify.test.js` 端到端） |
| 真实模型链路 | ⚠️ **未验证**（无真实凭证；见 §4） |

**一句话**：验收矩阵里 9 条通过、1 条不适用、1 条（真实模型链路）如实标记为未验证。

---

## 2. 验收矩阵（10 行逐条映射）

| # | 架构文档场景 | 断言位置 | 结果 |
|---|---|---|---|
| 1 | A 会话写入有效长期记忆，B 会话查询相关问题 → B 能检索并使用 | `p3-acceptance` R1 | ✅ |
| 2 | B 会话查询与 A 无关的问题 → 不注入 A 的无关记忆 | `p3-acceptance` R2 | ✅ |
| 3 | B 会话请求读取 A 的原始消息历史 → 默认拒绝 | `p3-acceptance` R3（`getMessages` + conversation 检索源） | ✅ |
| 4 | 用户甲查询用户乙的记忆 → 严格拒绝，泄漏数 0 | `p3-acceptance` R4 | ✅ |
| 5 | 同一用户不同项目 → 按项目范围过滤 | `p3-acceptance` R5 | ⏸ skip |
| 6 | Agent 子任务读取主会话临时状态 → 需明确授权 | `p3-acceptance` R6（投影不含主控历史 + owner 校验） | ✅ |
| 7 | 记忆已撤回/过期/被替代 → 不作为有效记忆注入 | `p3-acceptance` R7 | ✅ |
| 8 | 检索失败或无结果 → 可区分状态，不伪装成功 | `p3-acceptance` R8；`memory-degradation-golden` | ✅ |
| 9 | 大规模记忆库 → 只注入少量相关结果，Token 可控 | `p3-acceptance` R9 | ✅ |
| 10 | Trace 与实际 Provider 请求 → 注入记录与真实发送一致 | `p3-acceptance` R10；`context-trace-verify`（端到端复算） | ✅ |

### 关于 R5（项目范围）

`test()` 用 `{ skip: '...' }` 显式跳过，理由写在 skip 文案里，CI 输出会显示 `# SKIP`。**这不是通过**。

代码库现状：没有 `projectId`、没有项目归属、没有项目成员权限。`project_fact` 只是 TTL 分类标签（`server/context/retriever.js` 的 `MEMORY_TYPE_MAP`）。要实现项目级过滤必须新造一套项目模型（存储 + 权限 + UI），与「不推倒重写」约束冲突，属于产品决策。

替代性质由 R2 保证：同一用户的跨会话记忆只按相关性注入，不做无条件混合。

---

## 3. 回归指标：召回率 / 无关注入率 / Token

`node scripts/p3-regression-report.js`

三种口径（同一夹具、10 条标注查询）：

- `same` = 会话级作用域 + **写入该记忆的同一会话**（旧行为本来就能工作的场景）
- `fresh` = 会话级作用域 + **全新会话**（P0 时用户实际遇到的场景）
- `after` = 用户级作用域 + 全新会话（P1 后）

```
query               inject(s/f/a)  recall(s/f/a)   irrel(s/f/a)  tokens(s/f/a)
我喝咖啡有什么习惯           1/0/1          1.00/0.00/1.00  0/0/0         81/0/81
我平时用什么编辑器           1/0/1          1.00/0.00/1.00  0/0/0         81/0/81
我住在哪个城市             1/0/1          1.00/0.00/1.00  0/0/0         80/0/80
我的猫叫什么名字            1/0/1          1.00/0.00/1.00  0/0/0         78/0/78
我有什么食物过敏            1/0/1          1.00/0.00/1.00  0/0/0         79/0/79
我平时做什么运动            1/0/1          1.00/0.00/1.00  0/0/0         76/0/76
我的笔记本是什么配置          1/0/1          1.00/0.00/1.00  0/0/0         75/0/75
界面主题我喜欢什么样的         1/0/1          1.00/0.00/1.00  0/0/0         78/0/78
帮我写一个快速排序           0/0/0          -/-/-           0/0/0         0/0/0
解释一下 TCP 三次握手       0/0/0          -/-/-           0/0/0         0/0/0

汇总（same / fresh / after）：
  召回率 micro        : 1 / 0 / 1
  召回率 macro        : 1 / 0 / 1
  注入条目数          : 8 / 0 / 8
  无关记忆注入率      : 0.0% / 0.0% / 0.0%
  注入 Token（估算）  : 628 / 0 / 628
  零注入查询数        : 2 / 10 / 2
```

**读法**：

1. `same → fresh` 的召回率从 1.0 崩到 0，就是用户反馈的「新对话不认识我」——不是检索算法变差，而是跨会话记忆在旧作用域下根本不可见。
2. `after` 把召回率拉回 1.0，且**注入 Token 与 same 完全一致（628）**：新会话恢复到与同会话相同的体验，没有额外成本。
3. 无关记忆注入率三档都是 0%——召回提升没有用「多塞内容」换。
4. 两个无相关记忆的查询在三档下都注入 0 条，说明不会因为库里有东西就硬塞。

> 口径：Token 为 `heuristic-cjk-ascii-v1` 估算值，**不是** Provider `prompt_tokens`；「相关」为人工标注，不是模型判断。本脚本不调用任何 Provider（`provider_kind=none`）。

---

## 4. 真实模型链路验证

`node scripts/p3-real-model-check.js`

### 4.1 当前状态：⚠️ 未验证

```
NOT VERIFIED — 真实模型链路未验证
原因：未设置 BLUEBIRD_P3_REAL=1（真实调用会产生费用，必须显式开启）
```

退出码 **2**（区别于 0=通过、1=失败）。本环境没有真实 Provider 凭证，因此：

- **没有**执行过真实 Provider 调用；
- **没有**得出「估算 Token 与真实 prompt_tokens 收敛」的结论；
- 文档与报告里任何地方都**不**声称真实链路已通过。

### 4.2 启用方式

```bash
BLUEBIRD_P3_REAL=1 DEEPSEEK_API_KEY=<真实 key> node scripts/p3-real-model-check.js
```

启用后会验证 6 项：记忆块进入 system prompt、检索状态 ok、记忆块 Token 有归属、Trace 指纹等于实际发送内容、真实调用成功、Provider 返回真实 `prompt_tokens`。并打印 `真实/估算` 比值（仅观测，不作通过条件）。

### 4.3 脚本自检（桩，不构成真实验证）

```bash
node scripts/p3-real-model-check.js --selftest
```

```
⚠ SELF-TEST（本地桩 Provider）— 只验证脚本管道，不构成真实验证
  ✔ 记忆块进入最终 system prompt
  ✔ 检索状态为 ok — memoryStatus=ok
  ✔ 记忆块 Token 有归属（估算） — memoryTokens=81
  ✔ Trace 指纹等于实际发送内容
  ✔ Provider 调用成功（桩） — 27ms
  ✔ 桩返回 usage（仅验证读取链路） — prompt_tokens=240
检查项：6，失败：0
SELF-TEST PASSED（仅管道自检）— 真实模型链路仍未验证
```

退出码 **3**，输出刻意不含 `VERIFIED` 字样。

### 4.4 这个脚本验证什么、不验证什么

| 验证 | 不验证 |
|---|---|
| 请求装配正确（记忆块确实在 messages 里） | 模型是否在语义上使用了这条记忆 |
| 真实调用能成功并返回 usage | 模型回复质量 |
| 本地估算与真实 prompt_tokens 的比值可测 | 估算器是否已校准到目标 tokenizer |
| Trace 指纹等于实际发送内容 | 多轮 Agent 的逐轮 usage |

---

## 5. 未验证 / 不适用清单（如实声明）

| 项 | 状态 | 原因 |
|---|---|---|
| 真实 Provider 链路 | 未验证 | 无真实凭证；脚本已就绪，需部署环境执行 |
| 估算器校准 | 未验证 | 需真实 `prompt_tokens` 样本；P2 只提供观测口径 |
| 项目范围过滤 | 不适用 | 代码库无 Project 实体 |
| 多用户认证 | 未实现 | 本轮明确不扩展 |
| 语义召回（同义/跨语言） | 未在 P3 度量 | 已由 `memory-semantic-eval` 覆盖，P3 只度量跨会话召回 |

---

## 6. 修改文件

| 文件 | 改动 |
|---|---|
| `tests/p3-acceptance.test.js` | 新增：10 行验收矩阵（9 通过 + 1 skip） |
| `scripts/p3-regression-report.js` | 新增：召回率 / 无关注入率 / Token 三口径对比 |
| `scripts/p3-real-model-check.js` | 新增：真实链路验证（含 `--selftest` 管道自检） |
| `scripts/test-coverage-baseline.json` | 登记 `p3-acceptance`（10 项） |
| `scripts/sync-doc-counts.js` | 新增该测试文件的说明 |

> 未改动任何 `server/` 生产代码。P3 是验收阶段。

---

## 7. 测试结果

```
node scripts/verify-test-coverage.js
→ 当次 CI runner 覆盖：64/64 个测试文件
→ 当次 backend=1861/1861 nodeSuite=221/221 runner=1640/1640
→ frontend=181/181 suites=22/22 failed=0
→ ✔ 测试覆盖验证通过（当前总数以 scripts/test-coverage-baseline.json 为准）

node scripts/sync-doc-counts.js --check
→ ✔ 文档计数与基线一致

node tests/p3-acceptance.test.js
→ tests 10 / pass 9 / fail 0 / skipped 1

node scripts/p3-regression-report.js
→ 见 §3

node scripts/p3-real-model-check.js
→ NOT VERIFIED（exit 2）

node scripts/p3-real-model-check.js --selftest
→ SELF-TEST PASSED（exit 3，不构成真实验证）
```

---

## 8. 遗留风险

| 风险 | 说明 |
|---|---|
| 🔴 多用户上线前 P0 阻断项 | `GET /memory` 与管理接口仍全库语义，未按 `userId` 过滤。详见 `docs/p2-memory-observability.md` §8。P3 未改变这一点。 |
| 真实链路未验收 | 部署环境必须跑一次 `p3-real-model-check.js`，否则「真实模型能正常使用跨会话记忆」始终只是桩级结论 |
| 项目维度缺失 | 若产品需要项目级隔离，必须单独立项，不能靠现有 scope 硬套 |
| 指标夹具规模小 | 10 条标注查询只能说明方向，不能代替线上 A/B |
