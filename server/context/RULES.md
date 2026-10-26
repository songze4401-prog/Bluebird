# Context Engine — 唯一有效规则清单（工程实现依据）

> 版本关系：工程实现代号为「Context Engine v2.1 任务书」，规则基线以《Context
> Engine 架构文档（v2.2 综合版）》为准，**所有冲突点一律以文档中明确标注的
> **v2.3 修订**为准**。不得同时保留互相矛盾的旧规则。本文是唯一的裁决依据，
> 代码实现与测试断言全部对齐此清单。

## 0. 冲突消解结论（v2.3 覆盖 v2.2 的条款）

| 主题 | v2.2 表述 | v2.3 修订（采纳） |
| --- | --- | --- |
| 裁决顺序第 3 步 | 同等级下比"来源可靠度"（user_confirmed > cross_checked > schema_valid > delivered） | 同等级下比 `source` 渠道：`user > tool > memory > doc > web` |
| 关键规则 | `user_confirmed` 可压过 `tool` 的 `delivered`，"即使工具更新" | 可压过，**前提是未过期**；实时类 TTL 不因用户确认而豁免 |
| 时效状态 | 无 TTL 时默认为 `stale` | `unknown`（无 TTL）可进入、标注"时效未知"，与 `stale` **分开统计** |
| 实时类型 TTL | 未强制 | schema 中 **必填**，缺失则配置校验失败 |
| 单条预算上限 | 按 `verification` 等级（8K / 4K / 2K） | **按信息类型**设上限，`verification` 只影响**裁剪优先级** |
| 熔断 | 连续 3 次 `retrieval_error` 触发 30 秒熔断（全局） | 按 **`data_source` 粒度**计数，一个源挂不影响其他源 |
| 指标 | 降级触发率（demote 与 conflict 合并）>20% 告警 | 降级率（`demote_to_pending`）与冲突率（`conflict`）**分别**设阈值与告警 |

其余条款 v2.3 未改动，维持 v2.2 综合版原文。

## 1. 核心流程

```
任务 → 快速路由 → 简单任务直接执行 / 复杂任务进入 Planner
     → 并行检索 → 冲突裁决 → 上下文组装 → Agent 执行
     → 结果验证 → 写入 trace
```

- 快速路由必须能跳过不必要的 Planner 调用。
- 简单任务**不能**为了形式完整而强制增加模型调用（V1 的 Planner 采用结构化规则
  规划，不引入额外 LLM 调用）。

## 2. 信息结构：三维分离

不得将来源、验证状态和时效压缩为单一 trust 分数。

| 维度 | 字段 | 取值 |
| --- | --- | --- |
| Source | `source` | `tool` / `user` / `memory` / `doc` / `web`（仅渠道，不代表可信度） |
| Verification | `verification.status` | `delivered` → `schema_valid` → `cross_checked` → `user_confirmed` |
| | `verification.checked_items` | 具体验证了什么（字段完整性 / 时间一致性 / 与权威源比对） |
| Freshness | `fetched_at` | 获取时间戳 |
| | `ttl` | 有效期时长 |
| | `status` | `fresh` / `stale` / `expired` / `unknown` |

## 3. 裁决顺序（v2.3，严格分层）

1. **排除**：`expired` 的实时信息直接排除，不进上下文（对所有验证等级一视同仁）。
2. **验证等级**：高 `verification` 优先。
3. **来源渠道**：同等级下，`user > tool > memory > doc > web`。
4. **时效**：仍相同取最新。
5. **冲突**：仍无法裁决标 `conflict`，不强行选择，交由上层或用户决定。

**关键规则**：`user_confirmed` 可压过 `tool` 返回的 `delivered`，**前提是未过期**。
实时类信息的 TTL 不因用户确认而豁免。

**边界**：验证等级不是对所有事实的绝对权威；用户明确纠正的信息不得仅因工具来源
被覆盖（但实时且过期时按第 1 步排除）。

## 4. 时效状态与 TTL 策略（v2.3）

| 状态 | 行为 |
| --- | --- |
| `fresh` | 正常进入上下文 |
| `stale` | 可进入，必须标注"可能过时" |
| `unknown`（无 TTL） | 可进入，标注"时效未知"，与 `stale` 分开统计 |
| `expired` | 实时信息：排除并触发 `refetch`，禁止进入上下文 |

TTL 按类型配置（统一配置控制，禁止散落硬编码；**禁止 `on_expire: ignore`**）：

| 类型 | TTL | 过期行为 | 说明 |
| --- | --- | --- | --- |
| `realtime_data` | 30s | `refetch` | 必须重新查询，禁止进入上下文（schema 中 TTL 必填） |
| `user_preference` | 30d | `demote_to_pending` | 不删除，降级"待确认"，仅在相关时询问 |
| `project_fact` | 7d | `revalidate` | 触发重新验证流程 |

## 5. Token 预算（v2.3）

- **软目标 + 硬上限**；系统指令与当前任务**保底**。
- **单条上限按信息类型**设（`realtime_data` / `user_preference` / `project_fact` /
  `doc` / `web` / `tool` / `memory` / `user`），`verification` 只影响**裁剪优先级**。
- 超限按**相关度**裁剪，不按来源类型整体删除。
- 相关度两阶段：V1 实现第一阶段（结构化规则：当前任务 > 系统指令 > 最近 N 条 >
  高验证等级）；第二阶段 Embedding 重排序为规划项，**不写入已实现功能**。
- 不得破坏消息协议、工具调用结构或必要系统指令；无法安全组装时**显式返回错误或
  降级状态**。

## 6. 失败分类

| 类型 | 含义 | 处理 |
| --- | --- | --- |
| `no_result` | 检索成功但无内容 | 正常返回空，**不视为错误** |
| `retrieval_error` | 检索本身出错（超时、500） | **禁止**表述为"没有相关信息"；报告"查询失败" |
| `tool_missing` | 工具不存在 | 细分 `not_implemented`（提示即将支持）vs `not_found`（直接报错） |
| `conflict` | 关键事实无法裁决的冲突 | 明确标记，不强行选一个 |

## 7. 重试与熔断（v2.3）

- **自动重试仅限只读/幂等操作，最多重试一次**。
- 副作用操作禁止盲目自动重试，除非有可靠幂等保障或获得用户确认。
- **熔断按 `data_source` 粒度**：单源连续 3 次 `retrieval_error` 触发 30 秒熔断，
  一个源挂不影响其他源。

## 8. 配置管理

- **单一加载器**，全局唯一，负责 schema 校验。
- 严格模式：`additionalProperties: false`，防止字段拼写错误导致配置静默失效。
- 四个业务模块（检索、裁决、组装、trace）**只读**配置，禁止各自修改或重新解释。
- 第一版冷加载（重启生效），避免热更新半状态。

## 9. 安全要求

- 网页、文档及其他外部内容（`doc` / `web`）作为**不可信数据**处理，其指令
  **不得升级为系统指令或授权**；注入型内容按 `reject` 处理。
- 记忆写入必须过滤敏感内容、记录来源（contribution），支持追踪与回滚。
- 上下文检索结果**不得自行赋予工具调用权限**，不得绕过现有权限检查或用户确认。

## 10. 评估指标（六项，v2.3 拆分）

| 指标 | 说明 | 阈值 |
| --- | --- | --- |
| 检索命中率 | 召回相关上下文的比例 | — |
| 过期信息误用率 | 使用了 `expired` 信息的次数 | — |
| 注入拦截率 | 成功拦截恶意/错误注入的比例 | — |
| 冲突裁决准确率 | 冲突场景选择正确来源的比例 | — |
| 工具调用成功率 | 工具调用返回预期结果的比例 | — |
| 降级率 | `demote_to_pending` 的请求比例 | 单独设阈值与告警 |
| 冲突率 | `conflict` 的请求比例 | 单独设阈值与告警 |

## 11. 模块边界

- `server/context/engine.js` — 引擎主流程（路由 / planner / 裁决 / 验证）。
- `server/context/retriever.js` — 多来源并行检索；**ranker 并入本模块**（不拆模块）。
- `server/context/builder.js` — 上下文组装与预算裁剪。
- `server/context/trace.js` — 结构化 trace（可自动化测试验证，遵循隐私规范）。
- 统一策略配置 `server/context/config.json`，由 `config.js` 单一加载器 schema 校验。
- 允许为适配现有代码增加辅助函数/测试文件，但不得借机扩大重构范围。

## 12. Trace 要求

至少还原：任务与路由结果、Planner 是否调用及原因、检索来源/数量/失败分类、
时效检查与裁决理由、组装与预算裁剪摘要、工具调用结果/重试次数/执行状态、
最终验证结果与失败原因。不得记录密钥、认证信息或完整敏感内容；结构化可解析，
支持自动化测试验证。

## 13. 与现有代码的兼容约束（工程实现要求）

- 保持原有工具协议、流式响应、记忆能力和现有 API 兼容；Context Engine 以
  `BLUEBIRD_CONTEXT_ENGINE=1` 开关启用（默认关闭，关闭时行为与改造前逐字节一致）。
- 复用现有能力：记忆检索（`server/memory.js` 的 `searchMemories` / `buildMemoryContext`）、
  敏感过滤与来源追踪（`SENSITIVE_PATTERN` / contributions）、回滚
  （`recallMemoryBySourceQuote`）、文本度量（`text-utils.js`）、Agent 工具循环
  （`server/agent-runtime.js`）。禁止无必要地引入新依赖或重建重复系统。
