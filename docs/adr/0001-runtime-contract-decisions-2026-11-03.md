# ADR-0001：运行契约三项裁决（版本优先级 / R3 资源约束 / R0-R1 fail-open 白名单）

> 状态：**Accepted**
> 日期：**2026-11-03**（初稿）；**2026-11-03** 修订（v1.3 封版后）
> 决策者：用户（最终裁决）
> 记录者：AI 编码助手（只做结构化记录，不改写裁决语义）
> 适用范围：Bluebird Agent Runtime 运行契约
> 本文件性质：决策记录。只修订本文件，不修改源码、测试、配置、数据，不 commit / push，不动 git 历史。

## 相关文档（链位置）

- 上游：[v1.3 裁决与待验证清单](../v1.3-decisions-and-verification-checklist-2026-11-03.md)（§31.1/§31.2/§32/§33/§36/§41/§42）、[Phase 0 基线审计](../phase0-baseline-audit-2026-11-03.md)（§3.6/§4）、Notion 架构页 v1.2/v1.1/v1.0（`verification: unverified`）。
- 下游：[文档链总索引](../doc-chain-index-2026-11-03.md)；[协议收敛方案](../protocol-convergence-plan-2026-11-03.md)（Phase 1 前置 ① 的实施落点）。
- 本文件位置：三条裁决的**决策记录**；D1 以 §2.1.2 为准，§2.1.1 初稿已 `Superseded`，只作追溯。

## 修订记录

| 修订 | 日期 | 版本优先级 | 状态 | 依据 |
| --- | --- | --- | --- | --- |
| 初稿 | 2026-11-03 | `v1.2 > v1.1 > v1.0` | **Superseded by 2026-11-03 后续裁决** | 当时用户裁决的上限 |
| 本次修订 | 2026-11-03 | **`v1.3 > v1.2 > v1.1 > v1.0`** | **Accepted** | 用户 2026-11-03 后续裁决 + v1.3 清单封版（§31.1） |

> **旧值保留**：初稿的 `v1.2 > v1.1 > v1.0` 不删除，保留在 2.1.1 与上表，供追溯；本次修订以 `v1.3 > v1.2 > v1.1 > v1.0` 为准。

---

## 0. 编号、来源与阅读约定

### 0.1 为什么新建 `docs/adr/0001`

仓库此前没有 `docs/adr/` 目录，但已有两类既有决策记录：

| 位置 | 既有编号 | 性质 |
| --- | --- | --- |
| `docs/agent-runtime-stage1.md` §2 | ADR-01 ~ ADR-03 | 阶段 1 局部决策 |
| `docs/agent-runtime-stage2.md` §2 | ADR-01 ~ ADR-04 | 阶段 2 局部决策 |
| `docs/agent-runtime-stage3.md` §2 | ADR-01 ~ ADR-05 | 阶段 3 局部决策 |
| `docs/agent-runtime-stage4.md` §2 | ADR-01 ~ ADR-05 | 阶段 4 局部决策 |
| `docs/v1.3-decisions-and-verification-checklist-2026-11-03.md` | 无 ADR 编号；§31–§42 | 跨阶段裁决与待验证清单；**2026-11-03 已封版** |

阶段 ADR 采用“每份阶段文档从 01 重新编号”的局部格式，没有全局编号，也没有统一目录。`docs/v1.3-decisions-and-verification-checklist-2026-11-03.md` 已经包含与本次三项裁决高度重叠的内容（§31 版本优先级、§32 R3 资源约束、§33 fail-open 策略表），但它不是 ADR 目录，也没有使用 ADR 编号；**该文已于 2026-11-03 封版，并在 §31.1 明确 `v1.3 > v1.2 > v1.1 > v1.0`**。

因此按任务指定路径新建全局编号 `ADR-0001`，把本次三条裁决作为**独立、可引用的 ADR 记录**；不追加到阶段文档，也不修改既有 v1.3 封版文件。两者的关系见 0.2。

**与既有阶段 ADR 的关系（记录者分析）**：
- 既有阶段 ADR 不被本 ADR 整体废止；它们仍然描述当前实现来源。
- 若既有阶段 ADR 与 v1.3 条款冲突，按本 ADR 第 2.6 节的版本优先级处理：**`v1.3 > v1.2 > v1.1 > v1.0`**，冲突处不得以局部 ADR 覆盖高版本条款。
- 本 ADR 不重新裁决阶段 ADR 中与本次三项裁决无关的内容。

### 0.2 与 v1.3 封版清单的关系

【记录者分析】
- `docs/v1.3-decisions-and-verification-checklist-2026-11-03.md` 是已封版（2026-11-03）的决策文档，覆盖范围比本 ADR 更广（还包括 §34–§42 的验收矩阵、数值分类、来源裁决、Owner 等）。
- 该文 §31.1 明确：版本优先级为 `v1.3 > v1.2 > v1.1 > v1.0`；高版本明确修订的，低版本对应表述失效但原文保留。
- 用户 2026-11-03 后续裁决确认了该优先级；本 ADR 初稿的 `v1.2 > v1.1 > v1.0` 是当时的上限，现被高版本覆盖，状态为 **Superseded by** 本次修订；旧值保留在 2.1.1 供追溯。
- 本 ADR 采纳 v1.3 的以下条款作为修订依据：§31.1（版本优先级）、§31.2（阈值治理与留痕）、§32（R3 审批与资源期限）、§33（fail-open 七字段与 fail-closed）、§36（A/B 类数值）、§37（来源优先级）、§38（orphan TTL）、§41（Owner）、§42（验收证据矩阵）。
- 本 ADR 不复制 v1.3 的完整验收矩阵；实施证据与未勾选项以 v1.3 §42 为准。

### 0.3 文档来源状态

| 项 | 值 |
| --- | --- |
| 架构文档 | Notion page `40da9575-23c2-8135-9607-e23f6a3c784f` |
| 页面标题 | 仍为「Bluebird Agent Runtime｜混合式多 Agent 目标架构 **v1.0**」 |
| 实际内容 | §0–§9（v1.0）、§10–§22（v1.1）、§23–§30（v1.2 运行契约补充） |
| v1.3 依据 | `docs/v1.3-decisions-and-verification-checklist-2026-11-03.md`，2026-11-03 已封版；§31–§42 |
| 读取时间 | 2026-11-03（本次任务执行时） |
| 页面元数据 | `verification.state = unverified` |

> **【未验证】** Notion 页面标题仍是 v1.0，且页面元数据为 `unverified`；v1.3 的生效依据是仓库内已封版的 v1.3 清单，不是 Notion 页面标题。本 ADR 以 v1.3 清单的条款正文为准。

### 0.4 标注约定

| 标注 | 含义 |
| --- | --- |
| 【用户裁决】 | 用户给出的正式裁决，语义不得改写 |
| 【v1.3 封版依据】 | `docs/v1.3-decisions-and-verification-checklist-2026-11-03.md` 中标注为“条款正文（v1.3 生效）”的内容 |
| 【文档依据】 | 架构文档 v1.2 / v1.1 / v1.0 的条款原文或直接推论 |
| 【记录者分析】 | 记录者为解释背景、影响和落点所做的分析，不是用户裁决 |
| 【推断】 | 记录者对实现位置、校验点等的推断，未经验证 |
| 【待定】 | 仍需要用户或 Phase 1 实施决定的事项，本 ADR 不替用户决定 |

---

## 1. 裁决总览

| 编号 | 主题 | 状态 | 一句话 |
| --- | --- | --- | --- |
| ADR-0001-D1 | 版本优先级与初始硬阈值 | **Accepted**（本次修订；初稿被取代） | **`v1.3 > v1.2 > v1.1 > v1.0`**；2/2/3/30min 是初始默认硬阈值，可基于 Phase 0 实测调整，但必须留版本记录。初稿的 `v1.2 > v1.1 > v1.0` 已被 2026-11-03 后续裁决与 v1.3 封版取代 |
| ADR-0001-D2 | R3 审批与环境约束 | **Accepted** | R3 不设自动批准超时；deadline、Task Token 预算、Run 总预算仍然有效；任一硬约束耗尽即停止执行并进入终止或 recovery，绝不自动放行（v1.3 §32 已固化） |
| ADR-0001-D3 | R0/R1 fail-open 白名单 | **Accepted** | 必须建立显式策略表（至少 7 字段）；未命中白名单一律 fail-closed（v1.3 §33 已固化） |

---

## 2. 决策记录：ADR-0001-D1（版本优先级）

### 2.1 Decision

#### 2.1.1 初稿 Decision（**Superseded by 2026-11-03 后续裁决**）

> 原文保留，不再生效，仅供追溯：

> **版本优先级**：明确 `v1.2 > v1.1 > v1.0`。v1.2 的 2/2/3/30min 属**初始默认硬阈值**，Phase 0 可基于实测调整；**调整必须留版本记录，不能静默修改**。

#### 2.1.2 本次修订 Decision（**Accepted**）

> **版本优先级**：**`v1.3 > v1.2 > v1.1 > v1.0`**。v1.3 高于 v1.2；2/2/3/30min 仍属**初始默认硬阈值**，Phase 0 可基于实测调整；**调整必须留版本记录，不能静默修改**。

【v1.3 封版依据】依据 `docs/v1.3-decisions-and-verification-checklist-2026-11-03.md` §31.1（2026-11-03 封版）与用户 2026-11-03 后续裁决：`v1.3 > v1.2 > v1.1 > v1.0`；高版本明确修订的，低版本对应表述失效但原文保留。

> **旧值保留**：初稿 `v1.2 > v1.1 > v1.0` 不删除，保留在 2.1.1 与顶部修订记录表，用 **Superseded by** 标注；本次修订起以 `v1.3 > v1.2 > v1.1 > v1.0` 为准。

### 2.2 Status / Date

| 字段 | 值 |
| --- | --- |
| Status | **Accepted**（本次修订；初稿为 Superseded） |
| Date | 2026-11-03（初稿）；2026-11-03（本次修订，v1.3 封版后） |
| Supersedes | 初稿版本优先级 `v1.2 > v1.1 > v1.0` |
| Superseded-by | 无；本次修订为当前生效版本 |
| 依据 | 用户 2026-11-03 后续裁决；v1.3 §31.1、§31.2、§36 |

### 2.3 Context（为什么需要这条）

【记录者分析】
- 目标架构已经形成 v1.0（§0–§9）、v1.1（§10–§22）、v1.2（§23–§30）三层叠加。同一运行契约字段在不同版本中可能同时存在“原则性表述”和“可编码默认值”。
- Phase 0 基线审计已经指出协议面重复（P1–P5）：事件、状态机、任务文件对“唯一事实来源”有不同声明；计划协议、状态词表、版本号、预算模型都存在多套口径（见 `docs/phase0-baseline-audit-2026-11-03.md` §3.6、§4）。
- 若不冻结版本优先级，评审时会出现“按最新编辑时间”“按代码默认值”“按旧版原则”三种解释；阈值也会散落在 `routing-config.js`、`tasks.js`、`runtime.js`、`approvals.js` 中且无变更记录。
- v1.2 的 2/2/3/30min 是当前唯一一组可编码的默认硬阈值，但 Phase 0 尚未完成实测，不能把它们冒充为最终最优值。
- v1.3 已于 2026-11-03 封版（§31–§42），§31.1 明确 `v1.3 > v1.2 > v1.1 > v1.0`，并规定“高版本明确修订的低版本表述失效但原文保留”“同章内后小节优先”“三条不可覆盖不变量”。初稿只记录到 v1.2 上限，属当时口径；后续用户裁决已确认 v1.3 优先，若不适配会出现“已封版的 v1.3 条款被 v1.2 旧口径压回”的倒挂。

### 2.4 Rationale

【记录者分析】
- 高版本是对低版本的收敛和补充，而不是平行替代；明确 `v1.3 > v1.2 > v1.1 > v1.0` 可以让“原则”与“默认值”有确定的优先顺序。
- v1.3 对 §24.2 的 `waiting_approval` 迁移、§25/§29 的阈值口径、§33 的 fail-open 策略表都做了明确修订或补充，属于高版本明确修订；低版本对应表述失效但原文保留，符合 §31.1 的裁决。
- 把 2/2/3/30min 定为**初始默认硬阈值**，可以给 Phase 1 一个可测试的基线，同时保留 Phase 0 基于实测调整的空间；v1.3 §36 进一步把它们归为 A 类（可先定、待实测校准）。
- 要求留版本记录，是为了避免“阈值被改但无人知道旧值”的可复现性问题；旧值保留也是回滚和审计的前提。
- 禁止 Agent 在任务运行中自行修改阈值，符合 v1.2 前言与 §26 的版本化配置、评测和审批要求。

### 2.5 Consequences

【用户裁决 + 文档依据】
1. 所有条款引用必须带版本号；不带版本号的运行契约引用视为无效。
2. 同一事项发生冲突时，按 `v1.3 > v1.2 > v1.1 > v1.0` 取最高版本；v1.3 未规定时，才依次回退到 v1.2、v1.1、v1.0。
3. 低版本不得覆盖高版本，即使低版本文档编辑时间更晚；v1.3 明确修订的低版本表述失效，但原文保留供追溯。
4. 2/2/3/30min 是**初始默认硬阈值**，不是不可调整的最终值；调整必须产生版本记录，记录必须包含 v1.3 §31.2 的七项：旧值、新值、依据（实测数据与评测结果）、批准人、生效时间、配置版本号、回滚点。
5. 阈值调整不得由 Agent 在任务运行中自行完成；不得静默修改配置文件或代码默认值；调整只针对阈值与配置，不得改变权限边界、终态语义、`trustLevel` 写入权与审批不变量（v1.3 §31.2）。
6. 旧值必须保留并可查询；历史记录 append-only，不覆盖、不删除。
7. 本条不改变 Agent Manifest 的 `version: '1.1.0'` 语义，也不改变 `agent-routing.json` 的 `SCHEMA_VERSION = 1` 语义；这些是代码对象版本，不是架构契约版本。【推断/口径说明】
8. 同一章内按小节编号靠后者优先（例如 §32 与 §24.2 冲突时以 §32 为准）；任何版本都不得覆盖三条不变量：终态不可被普通事件覆盖（§24.2）、`trustLevel` 只能由 Verification Engine 写入（§27）、审批超时不能被解释为批准（§29、§30）。【v1.3 §31.1】

### 2.6 版本优先级条款

#### 2.6.1 优先级规则

| 规则 | 内容 |
| --- | --- |
| R1 | `v1.3 > v1.2 > v1.1 > v1.0`，顺序固定，不按文档编辑时间排序。 |
| R2 | 同一字段或同一运行契约在多个版本出现时，取最高版本的明确规定；v1.3 明确修订的，低版本对应表述失效（原文保留）。 |
| R3 | 最高版本未规定时，依次回退到次高版本；回退必须显式写明“v1.3 未规定，按 v1.2”，再往下同理。 |
| R4 | 低版本条款不得覆盖、稀释或解释性放宽高版本条款。 |
| R5 | 任何“代码现状”“局部 ADR”“历史实现”都不能作为覆盖高版本契约的理由；只能作为差距证据。 |
| R6 | 条款引用格式统一为 `§<章节>（<版本>）`，例如 `§25（v1.2）`、`§32（v1.3）`。 |
| R7 | 本 ADR 的生效优先级为 `v1.3 > v1.2 > v1.1 > v1.0`。**初稿 R7 中“v1.3 尚未经用户确认”的表述已被 2026-11-03 后续裁决与 v1.3 封版取代**（Superseded by 本次修订）；旧表述不再生效，保留于本 ADR 的修订记录。 |
| R8 | 同一章内按小节编号靠后者优先（例如 §32 与 §24.2 冲突时以 §32 为准）。【v1.3 §31.1】 |
| R9 | 任何版本都不得覆盖三条不变量：终态不可被普通事件覆盖（§24.2）；`trustLevel` 只能由 Verification Engine 写入（§27）；审批超时不能被解释为批准（§29、§30）。【v1.3 §31.1】 |

> 版本口径说明：本条优先级指**架构/运行契约文档版本**，不是 Agent Manifest 的 `version`，也不是 `agent-routing.json` 的 `SCHEMA_VERSION`。代码对象版本与契约版本必须分别引用，不能互相替代。【记录者分析】

#### 2.6.2 2/2/3/30min 的对应关系

| 参数 | v1.3 默认值（沿用 v1.2） | 条款 | 类别 | 当前代码现状（只读审计） | 说明 |
| --- | --- | --- | --- | --- | --- |
| 委派深度 | **2 层**（Root → Worker → Sub-worker，不得再向下） | §25（v1.2）/ §36（v1.3） | A | `server/tool-dispatch-bot.js` 只有 memory 一跳；`server/agents/tasks.js#createTask` 无 `parentTaskId`，无深度计数器 | 初始默认硬阈值；当前是结构性一跳，不是显式策略 |
| 单 Run 重规划 | **2 次**（不含初始计划）；**Run 级统一计数，Task 级只记录、不设独立上限** | §36（v1.3） | A | `server/agents/tasks.js` / `server/agents/runtime.js` 无 `replanCount`；`routing-config.js` 只有 `generatePlan` 布尔位 | 初始默认硬阈值；计数口径已由 v1.3 §36 固定 |
| 单 Run 重试 | **3 次**（不含首次执行） | §25（v1.2）/ §36（v1.3） | A | `server/agents/tasks.js:642` `maxAttempts` 默认 1，环境变量最多 3；`setRetry` 只做重排队 | 初始默认硬阈值；默认值与契约不一致 |
| R2 审批 SLA | **30 分钟** | §29（v1.2）/ §36（v1.3） | A | `server/agents/approvals.js` 无 `expiresAt` / SLA 字段；`watchdog-policy.js` 不处理 `waiting_approval` | 初始默认硬阈值；R2 超时 fail-closed，转人工队列 |

> 说明：2/2/3/30min 是任务原话中的简写。按 v1.2 正文与 v1.3 §36，它对应 §25 的委派深度 2、单 Run 重规划 2（Run 级统一计数）、单 Run 重试 3，以及 §29 的 R2 30 分钟 SLA。该对应关系是【文档依据】。
>
> Task Token hard budget 与 Run 总预算是另外两条硬约束（§25），不在 2/2/3/30min 简写内，但同属 D2 的资源约束；其机制已定、具体数值按 v1.3 §36 归 B 类待压测。

**A 类数值：已采纳，作安全默认，待实测校准（v1.3 §36）**

| 参数 | 已采纳值 | 说明 |
| --- | --- | --- |
| `orphan` 默认 TTL | 168 小时（7 天） | §38；可配置，到期只进清理候选 |
| 图节点数上限 | 5000 / 每类图（单 Run 汇总） | §39 |
| 图边数上限 | 20000 / 每类图 | §39 |
| 图最大深度 | 10 | §39；与委派深度 2 独立 |
| holdout 容量 | ≥ 评测池 20%，且 ≥ 50 个任务 | §40 |
| 挑战集轮换周期 | 90 天，或每 2 个阶段 | §40 |
| fail-open 策略有效期上限 | ≤ 90 天 / 单次，二者取短 | §36 |
| 默认并发（无配置回退） | 1（保守单并发） | §36；仅作兜底，不作容量标准 |

> A 类可先作为安全默认进入运行，但**不得作为容量、性能或成本承诺**；未实测校准前必须标注“待校准”（v1.3 §36.1）。

**B 类数值：机制已定、值待压测（v1.3 §36）**

| 参数 | 当前取值 | 说明 |
| --- | --- | --- |
| Task Token / 费用预算 | 未定；按任务风险与类型分档 | 机制：原子预留/扣减、父覆盖子；值待基线测量 |
| `deadline` 全局硬上限 | 未定 | 允许 Task 类型配置更严格的局部上限 |
| `toolCalls` 全局硬上限 | 未定 | 允许 Task 类型配置更严格的局部上限 |
| 四维限流（Run/Task/Agent/Provider） | 未定，分别配置 | 待压测 |
| 熔断阈值（窗口/错误率/冷却） | 未定；closed/open/half-open 状态机已定 | 待压测 |
| 图检测时间上限 | 200 ms | 待剖析 + 压测 |
| `orphan` 清理扫描周期 | 未定 | 待压测/运维基线 |

> B 类**未压测前不得作为生产标准**，不得写入对外 SLA、容量规划或成本承诺；由 B 升为生产标准必须同时具备压测报告、基线配置记录、批准人、版本号、回滚点（v1.3 §36.1）。

#### 2.6.3 留痕形式（谁改、何时、依据哪份实测报告、旧值保留）

【用户裁决】调整必须留版本记录，不能静默修改。最小留痕字段如下：

| 留痕字段 | 必填 | 取值约束 / 含义 |
| --- | --- | --- |
| `changeId` | 是 | 全局唯一；建议 `thr-<yyyyMMdd>-<seq>`。【推断】 |
| `contractVersion` | 是 | 变更后的运行契约版本标识，例如 `runtime-contract@1.3.0`；不得复用旧版本号。【推断】 |
| `configVersion` | 是 | 配置版本号（v1.3 §31.2 要求）；记录本次生效配置的唯一版本标识，审计与回滚都绑定该值。【v1.3 封版依据】 |
| `field` | 是 | 被调整的阈值字段名，必须与代码/配置中的规范名一致。 |
| `scope` | 是 | 作用域：global / env / agentId / taskType；不得用空值表示“所有”。 |
| `oldValue` | 是 | **旧值原文**，必须保留，不得被新值覆盖。 |
| `newValue` | 是 | 新值及其单位。 |
| `changedBy` | 是 | 修改人身份 + 角色；Agent 不得作为唯一修改人。 |
| `approvedBy` | 是 | 硬阈值变更的批准人身份 + 角色；与 `changedBy` 分离。 |
| `changedAt` | 是 | ISO 8601 时间戳；服务端时钟。 |
| `basisReportRef` | 是 | 依据的实测报告：仓库内路径 + commit + 测量窗口 + 样本量 + P50/P95/P99 等指标；不得只写“根据测试”。 |
| `reason` | 是 | 变更原因；不得写“优化一下”这类不可审计表述。 |
| `rollbackPlan` | 是 | 回滚到 `oldValue` 的条件和操作。 |
| `effectiveFrom` | 是 | 生效时间；不得回溯生效。 |
| `auditEventId` | 是 | 对应审计事件 ID，确保能从审计反查。 |
| `status` | 是 | `effective` / `rolled_back` / `superseded`；不得删除历史记录。 |

留痕规则：

1. 记录必须 append-only；旧记录和 `oldValue` 永久保留。
2. 一次变更可以影响多个字段，但每个字段必须单独一行，不得用“批量调整”掩盖具体旧值。
3. Phase 0 可以基于实测调整；调整依据必须是可复现的实测报告，而不是主观判断。
4. Phase 0 之后的调整沿用 v1.3 §31.2 与 v1.2 前言的版本化配置、评测和审批要求。【v1.3 封版依据】
5. 若配置文件中的当前阈值与最近一条有效记录不一致，且没有新的变更记录，服务端应以 fail-closed 方式拒绝加载该配置，而不是接受静默修改。【记录者分析/推断；实现位置待定】
6. 留痕字段与七项必填内容由 v1.3 §31.2 定义（旧值、新值、依据、批准人、生效时间、配置版本号、回滚点）；记录模板见附录 B。记录实际存放介质（本 ADR 附录、独立 changelog 或配置内嵌）【仍未定，见 6.2】。

### 2.7 受影响条款

| 条款 | 内容摘要 | 受影响方式 |
| --- | --- | --- |
| §31.1（v1.3） | 版本优先级 `v1.3 > v1.2 > v1.1 > v1.0`；高版本修订的低版本表述失效但原文保留；同章后小节优先；三条不变量 | 本条直接采纳，替代初稿只到 v1.2 的上限 |
| §31.2（v1.3） | 2/2/3/30min 为初始默认硬阈值；调整须留：旧值、新值、依据、批准人、生效时间、配置版本号、回滚点 | 留痕字段与规则按此对齐 |
| §36（v1.3） | A/B 类数值；A 类已采纳，B 类待压测 | 2/2/3/30min 与 orphan/图上限等归 A 类；Token/费用、deadline/toolCalls 上限、限流/熔断等归 B 类 |
| §25（v1.2） | 第一版硬阈值：委派深度 2、单 Run 重规划 2、单 Run 重试 3、Task Token hard budget、Run 总预算 | 2/2/3 被定为初始默认硬阈值；重规划口径由 v1.3 §36 细化为 Run 级统一计数 |
| §29（v1.2） | R2 30 分钟 fail-closed；R3 不设自动批准超时 | 30min 被定为初始默认硬阈值；调整须留痕 |
| §15（v1.1） | 审批超时默认 fail-closed；仅低风险、可逆、预先授权可按策略 fail-open | 审批 SLA 的默认值受本条版本优先级约束 |
| §18（v1.1） | deadline、重规划次数、剩余预算阈值、最小预期收益门槛 | 阈值调整和停止重规划判据必须引用同一版本口径；§18 约束“依据”，不否定默认值（v1.3 §31.2） |
| §30（v1.2） | v1.2 编码验收门槛（硬限制、预算、审批 SLA 等） | 验收必须按 v1.3 §42 的证据矩阵执行，不得用代码旧默认值替代 |
| §6（v1.0） | 安全与可靠性硬约束 | 硬阈值属于不可由 Agent 自行放宽的约束 |
| §22（v1.1） | v1.1 修订验收清单（审批超时、批量、升级、申诉等） | 与 v1.3 §32/§42 叠加适用；冲突时以 v1.3 为准 |

---

## 3. 决策记录：ADR-0001-D2（R3 审批与环境约束）

### 3.1 Decision（用户裁决原文）

> **R3 审批与环境约束**：R3 不设审批自动批准超时，**但 Task 的 deadline、Token 和 Run 预算仍然有效**。任一硬约束耗尽，停止执行并进入相应终止或 recovery 流程，**绝不自动放行**。
>
> 用户原话：**“审批可以无限期等待，但不能让任务无限期占用资源。”**

### 3.2 Status / Date

| 字段 | 值 |
| --- | --- |
| Status | **Accepted** |
| Date | 2026-11-03 |
| 依据 | 用户原话；v1.3 §32.1–§32.4（2026-11-03 封版） |

### 3.3 Context（为什么需要这条）

【记录者分析】
- v1.2 §29 规定：R3 不设自动批准超时，未批准期间保持 `waiting_approval`，允许人工取消/驳回，不允许超时放行；长期未处理标记 `overdue` 并升级。
- 但“审批可以无限期等待”不等于“任务可以无限期占用资源”。如果 R3 任务在 `waiting_approval` 中不执行 deadline、Task Token 预算和 Run 总预算，就会出现“审批不放手、资源也不释放”的双重悬挂。
- 当前代码现实：`server/agents/approvals.js` 没有 `expiresAt` / SLA；`server/agents/watchdog-policy.js` 只处理 `queued` / `accepted` / `running` 的租约和心跳，不处理 `waiting_approval`；`server/agents/runtime.js` 的 deadline 计时只在任务真正执行时启动。审计已把“审批无 TTL / 无 fail-closed 超时”列为 P2 阻断项。
- 因此必须把“审批等待”和“资源约束”拆开：审批可以等，资源不能无限等。
- v1.3 §32 已把这条落成两套独立约束，并明确：无未核清副作用 → `timed_out`；副作用未知或未核清 → 先 `recovery`（§32.1）；`timed_out` 不改变 Approval Request 的 `pending` 状态（§32.2）；`overdue` 是 Approval Request 标记、不是 Task 状态（§32.3）。本 ADR 初稿的对应矩阵与之一致，本次修订补齐条款引用。

### 3.4 Rationale

【记录者分析】
- R3 不设自动批准超时，保护的是“不能因为没人审批就自动放行”；deadline/budget 仍然有效，保护的是“不能因为审批没人处理就无限占用资源”。两者不是矛盾，而是不同风险的控制。
- 任一硬约束耗尽后，正确的动作是停止执行并进入终止或 recovery，而不是“顺手批准”或“超时默认同意”。
- 外部副作用结果未知时，必须先 recovery 对账；不能把未知副作用包装成普通超时，也不能直接重试。
- 把 `overdue` 定义为监控/升级标记，而不是审批结果，可以避免把“等太久”误解为“已同意”；v1.3 §32.3 进一步固定了升级链路：escalation 事件 → 有明确责任人的审批队列 → 通知责任人 → 按轮值继续升级 → 保持 `overdue` 直至处理。
- v1.3 §32.4 明确等待审批不产生模型 Token，但占用 Task 执行槽位并消耗 Run deadline；资源判定用服务端原子计量，批准后预算不足不得超预算（`budget_exceeded` 或人工追加）。

### 3.5 Consequences

【用户裁决 + 文档依据】
1. R3 的 Approval Request 可以长期保持 `pending`；Task 可以长期保持 `waiting_approval`，但必须受 deadline 和预算约束。
2. `waiting_approval` 不是资源豁免状态；Task deadline、Task Token hard budget、Run 总预算在等待审批期间仍然有效并受闸门约束。等待审批本身不产生模型调用 Token，但已耗尽的 Token 预算不得因等待或批准而豁免，批准后剩余预算不足时不得超预算执行；等待墙钟时间计入 Run deadline / 时间预算。
3. 任一硬约束耗尽，Workflow Engine 必须停止执行并写入相应终态或 `recovery`；不得写入 `approved`，不得执行待审批动作。
4. 外部副作用结果未知时，先进入 `recovery` 对账；对账确认前不得重试、不得批准、不得用 `timed_out` 掩盖。
5. R3 长期未处理只把 Approval Request 标记 `overdue` 并升级提醒；`overdue` 不等于 `approved`，也不等于 `expired`，且不是 Task 状态（v1.3 §32.3）。
6. 审批人只提交 decision；Task 状态只能由 Workflow Engine 写入。审批通过后是否执行，仍要重新检查 deadline、预算、权限和版本有效性。
7. 所有终止、恢复、超期、升级动作必须写审计事件；审计不得包含敏感内容。
8. R2 的 30 分钟 fail-closed 仍按 v1.2 §29 / v1.3 §32 执行；本条不改变 R2 规则。
9. 硬约束耗尽且无未核清副作用时落 `timed_out`；副作用结果未知或未核清时先 `recovery`，用 `errorCode` 区分原因（`deadline_exceeded` / `budget_exceeded` / `uncertain_side_effect`）。【v1.3 §32.1】

### 3.6 R3 约束矩阵（`waiting_approval` × 四类硬约束）

> 结果列只使用用户给定的三类出口：`timed_out` / `recovery` / 保持等待但标 `overdue`。
>
> **任何一格都不得落到自动批准。**

| # | 硬约束 | 触发条件（`waiting_approval` 期间） | 结果（三选一） | 状态 / errorCode | 自动批准？ | 备注 |
| --- | --- | --- | --- | --- | --- | --- |
| 1 | Task deadline | `now >= task.deadlineAt`，且无未核清的外部副作用 | **`timed_out`** | `timed_out` / `deadline_exceeded` | **否，永不** | Engine 写入终态；Approval Request 不得转 `approved`；可保留 `pending` / `overdue` 供人工处置与审计；写审计 |
| 2 | Task Token budget | `taskTokenUsage >= taskTokenBudget` | **`timed_out`**（终止执行） | `timed_out` / `budget_exceeded` | **否，永不** | 不得因审批批准而补预算或重置预算；Approval Request 不得转 `approved`，保持 `pending` / `overdue`（v1.3 §32.2） |
| 3 | Run 总预算 | `runTokenUsage >= runTokenBudget`（Token / 费用 / 时间任一维度） | **`timed_out`**（终止执行） | `timed_out` / `budget_exceeded`（Run 级） | **否，永不** | Run 内所有 `waiting_approval` 任务同样受闸门约束；不得用新 run 规避；不得转 `approved` |
| 4 | 外部副作用结果未知 | 审批执行已开始，但外部副作用结果无法确认（`sideEffectState = unknown`） | **`recovery`** | `recovery` / `uncertain_side_effect` | **否，永不** | 先对账，不重试、不批准；对账后按 §24.2 收口；需再次执行时创建新审批请求 |
| 5 | （补充）无硬约束触发，仅审批等待超过提醒阈值 | 审批等待时间超过 `overdue` 提醒阈值 | **保持 `waiting_approval`；`overdue` 标在 Approval Request 上** | Approval Request `overdue` / `approval_overdue` | **否，永不** | R3 无自动批准超时；只提醒/升级，不改成 `approved`；`overdue` 不是 Task 状态 |

判定与收口规则：

1. **优先级（记录者推断）**：若同时触发“外部副作用结果未知”和其他硬约束，先 `recovery`；对账完成前不做终态收口。其余终止条件同时触发时，任一成立即可终止，但不得自动批准。
2. `timed_out` 与 `budget_exceeded` 的组合：**已定**——硬约束耗尽且无未核清副作用时统一落 `timed_out`，用 `errorCode` 区分 deadline 与预算；有未核清副作用时先 `recovery`（v1.3 §32.1）。不再保留“落 `timed_out` 还是 `failed`”的待定项。
3. `recovery` 不是成功态，也不是批准；`recovery` 期间不得对外产生新的副作用。
4. Task 终止或恢复时，Approval Request 不得转为 `approved`；**已定**：`timed_out` 不改变 Approval Request 的 `pending` 状态，可保留 `pending` / `overdue` 供人工处置与审计（v1.3 §32.2、§32.3）。`expired` / `cancelled` 的具体枚举映射不再作为本 ADR 待定项；如需引入，属于后续状态机协议收敛。
5. `overdue` 只用于监控、提醒和升级，标在 Approval Request 上，不是 Task 状态；不得作为审批决定，也不得触发执行。
6. **Token 与时间口径**：等待审批本身不产生模型调用 Token；Task Token 预算的有效性表现为“不得因等待或批准而豁免已耗尽预算、不得在批准后超预算执行”。等待墙钟时间计入 Run deadline / 时间预算（v1.3 §32.4）。【v1.3 封版依据】

### 3.7 “绝不自动放行”的硬不变量

1. 超时、预算耗尽、恢复、过期、`overdue`、通知失败，任何一项都不得被解释为批准。
2. 只有显式的人工 `approve` decision 才能把 Approval Request 置为 `approved`。
3. 只有 Workflow Engine 能写 Task 状态，包括 `retrying` / `recovery`；审批人、Worker、Gateway、Reviewer 都只能提交结果/决策事件。【v1.3 §24 + §42 B-03】
4. 审批批准后，执行前仍必须重新校验 deadline、Task Token 预算、Run 总预算、权限、动作参数摘要、artifact/plan 版本和有效期。
5. 旧批准在参数、目标或版本变化后失效；不得复用旧批准执行新动作。
6. 任何硬约束终止都必须写审计；审计事件必须能从 Task 反查到 Approval Request。
7. R3 的 `overdue` 升级路径不得改变审批状态，只能改变提醒对象和优先级。

### 3.8 受影响条款

| 条款 | 内容摘要 | 受影响方式 |
| --- | --- | --- |
| §29（v1.2） | R3 不设自动批准超时；长期未处理标记 `overdue` 并升级，不得静默遗忘 | 本条确认 R3 可无限期等待审批，但补上资源约束 |
| §24.1/§24.2（v1.2；**v1.3 §32.2 已修订**） | 合法迁移表：`waiting_approval` → `running` / `cancelled` / `failed` / `timed_out` / `recovery` | v1.3 §32.2 修订后已覆盖本条所需出口；当前代码迁移表仍未覆盖 |
| §32.1（v1.3） | 审批期限与资源期限两套独立约束；无未核清副作用 → `timed_out`，有则先 `recovery` | 本条的直接条款依据 |
| §32.3（v1.3） | `overdue` 是 Approval Request 标记；升级链路；审批系统故障 fail-closed | `overdue` 语义与升级路径以此为准 |
| §32.4（v1.3） | 等待不产生模型 Token，但占用 Task 槽位并消耗 Run deadline；原子计量；批准后不得超预算 | 预算与时间口径以此为准 |
| §42 B-03 / B-10 / B-11（v1.3） | `retrying` / `recovery` 仅 Engine 可写；R2 fail-closed、R3 只接受显式批准；审批 SLA/提醒/升级/取消 | 验收证据绑定这三项 |
| §25（v1.2） | Task Token hard budget、Run 总预算、预算原子预留/扣减 | 本条明确两类预算在 `waiting_approval` 期间仍然有效 |
| §15（v1.1） | 审批超时默认 fail-closed；只有低风险可逆动作可按策略 fail-open | R3 永不 fail-open；R3 资源耗尽也不得 fail-open |
| §18（v1.1） | 每个任务设置 deadline、最大重规划次数、剩余预算阈值 | deadline 在审批等待期间仍然计入端到端预算 |
| §23（v1.2） | `budget_exceeded` 不可重试；不得通过重试重置预算 | 预算耗尽时终止，不自动批准、不自动重试 |
| §30（v1.2） | R2 30 分钟转人工 fail-closed；R3 只接受显式批准 | 验收时必须覆盖 `waiting_approval` 下的资源约束 |

---

## 4. 决策记录：ADR-0001-D3（R0/R1 fail-open 白名单）

### 4.1 Decision（用户裁决原文）

> **R0/R1 fail-open 白名单**：必须建立**显式策略表**，至少包含：动作范围、预授权主体、风险等级、有效期、适用环境、审计记录、撤销机制。**未命中白名单一律 fail-closed**。

### 4.2 Status / Date

| 字段 | 值 |
| --- | --- |
| Status | **Accepted** |
| Date | 2026-11-03 |
| 依据 | 用户裁决；v1.3 §33.1–§33.4（2026-11-03 封版） |

### 4.3 Context（为什么需要这条）

【记录者分析】
- v1.1 §15 允许 fail-open，但限定为“仅低风险、可逆且预先授权的动作可按明确策略 fail-open”；v1.2 §15 延续该原则。
- 当前代码只有工具 allowlist（`server/agents/tool-gateway.js#createToolAuthorizer`）和单用户权限（`server/agents/permissions.js#checkOperation`），没有 R0–R3 映射，没有“预授权主体 / 有效期 / 适用环境 / 撤销机制”等字段。
- 如果“fail-open”停留在原则层，实现时很容易变成“超时后默认允许”或“白名单外也放行”。审计已把“无 R0–R3 映射、无审批 TTL、无 fail-closed 超时”列为 P2 问题。
- 因此必须把 fail-open 限定为一张可枚举、可审计、可撤销的策略表；没有命中就按默认拒绝处理。
- v1.3 §33 已把这条固化：§33.1 未命中即 fail-closed、仅 R0/R1、全字段匹配；§33.2 定义 7 个必需字段；§33.3 规定策略表只能人工版本化变更、审计绑定 `policyVersion`、撤销权独立。本 ADR 的七字段骨架与之一致。

### 4.4 Rationale

【记录者分析】
- fail-open 是例外，不是默认值；例外必须可枚举、可验证、可撤销。
- 七个字段把“谁在什么环境、什么时间、对什么动作、以什么风险等级、留下什么审计、如何撤销”说清楚，避免用一句“低风险可自动通过”掩盖具体授权。
- “未命中一律 fail-closed”把策略空白、字段缺失、环境不匹配、过期、已撤销、审计不可用等所有未知情况统一导向拒绝，避免“没配置=允许”的默认开放。
- fail-open 只应省略人工审批等待，不应省略工具白名单、任务授权、污点检查、预算、deadline 和审计。
- **审计先行、失败即拒绝**不再是记录者推断：v1.3 §33.1 第 5 条要求审批系统故障/策略不可读 fail-closed，§33 建议项明确“审计记录写入失败同样 fail-closed，不得先执行后补审计”，用户本次已确认按 fail-closed 采纳。

### 4.5 Consequences

【用户裁决 + 文档依据】
1. 只有 R0/R1 动作有资格进入 fail-open 白名单；R2/R3 永不 fail-open。
2. 白名单条目必须同时满足七个必需字段和动作参数匹配；任一字段缺失、非法或不匹配，一律 fail-closed。
3. 未命中白名单、策略表不可读、策略版本不支持、环境不匹配、已过期、已撤销，一律 fail-closed。
4. fail-open 只免除“等待人工审批”这一步；不得绕过工具 allowlist、任务授权、污点/来源检查、预算、deadline、幂等和审计。
5. 策略表变更必须版本化、经人工批准；Agent 不得自行新增、修改或撤销白名单条目。
6. 策略表条目必须可撤销；撤销在下次调用前生效；撤销动作本身必须写审计。
7. 每次 fail-open 命中都必须写审计；**审计写入失败时不得执行**（fail-closed）。【v1.3 §33.1 第 5 条 + §33 建议项，用户已确认采纳】
8. 任何 fail-open 命中都不得扩大 `allowedTools`，不得提升风险等级，不得解锁 R2/R3。

### 4.6 七个必需字段（取值约束与校验点）

> “校验点”列中的现有模块名来自代码现状；新增模块名/文件路径为【推断】，实现时以协议收敛结果为准。

| # | 字段 | 取值约束 | 校验点 | 缺失 / 非法时 |
| --- | --- | --- | --- | --- |
| 1 | 动作范围 | 精确到工具名 + 操作名 + 参数白名单 + 目标资源范围；一条记录只描述一个动作；禁止通配符、正则、前缀匹配、隐式继承 | `server/agents/tool-gateway.js#createToolAuthorizer` 的每次调用校验；新增策略表加载器【推断】 | fail-closed |
| 2 | 预授权主体 | 必须是服务端可信主体/角色，可从 `server/user-scope.js` 的实例身份或 `server/agents/permissions.js` 解析；禁止客户端或 Agent 自报主体；Agent、Orchestrator、Gateway 不得作为预授权主体；必须精确匹配 | `server/agents/permissions.js#checkOperation` + 策略表主体匹配；不得只信请求体【推断】 | fail-closed |
| 3 | 风险等级 | 只允许 `R0` / `R1`；`R2` / `R3` 在加载时直接拒绝；未知等级拒绝；风险等级不得由 Agent 自行降级 | 策略表 schema 校验 + `server/agent-runtime.js#TOOL_RISKS` 映射；缺信息按更高一级处理【文档依据 §13】 | fail-closed |
| 4 | 有效期 | 绝对 `notBefore` / `expiresAt`、次数上限、单次/长期类型；必须有上限 TTL；使用服务端时钟；过期或用尽立即失效，不自动续期；时间格式非法即拒绝 | 每次调用前的时间与次数校验；策略表加载时校验 TTL 上限【推断】 | fail-closed |
| 5 | 适用环境 | 精确环境标识（如 dev/staging/prod）与资源标识；禁止通配符；只能匹配环境加载和命中；禁止跨环境继承；环境缺失或未知即拒绝 | 启动时环境解析 + 每次调用环境匹配；新增环境解析点【推断】 | fail-closed |
| 6 | 审计记录 | 必须声明事件类型和必填字段：`policyId`、`policyVersion`、`matchedRule`、主体、动作、参数摘要、目标、风险、环境、`taskId`、`runId`、`traceId`、决定、时间、预授权人引用、结果（覆盖 v1.3 §33.2 的必填项）；不得写密钥、正文或敏感参数原文 | `server/monitoring/store.js` 审计链路 + 新增 fail-open 命中事件；审计先行 | fail-closed（审计不可用则不执行）【v1.3 §33.1 第 5 条 + §33 建议项，已采纳】 |
| 7 | 撤销机制 | 必须支持按 `policyId` / `policyVersion` 撤销；记录撤销主体、`revokedAt` / `revokedBy` / `reason`、生效时机与传播方式；撤销在下次调用前生效；撤销后未完成请求不得继续；必须有全局 kill switch；缓存不得超过约定 TTL | 策略表加载器 + 每次调用查表/缓存失效；撤销事件写审计【推断】 | fail-closed |

> 附加元数据（不属于 7 个必需字段，但为可审计性必需）：`policyId`、`policyVersion`、`status`（`draft` / `active` / `revoked` / `expired`）、`createdBy`、`createdAt`、`approvedBy`、`approvedAt`。【记录者分析】

### 4.7 策略表骨架（表体待填写）

> 下表只给结构，不替用户决定任何具体动作。所有 `<待填写>` 必须由用户/授权人批准后填写。

| policyId | policyVersion | 动作范围 | 预授权主体 | 风险等级 | 有效期 | 适用环境 | 审计记录 | 撤销机制 | 状态 |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| `POLICY-____` | `v__` | `<动作范围：工具+操作+参数+目标>` | `<服务端可信主体/角色>` | `<R0 或 R1>` | `<notBefore / expiresAt>` | `<精确环境标识>` | `<事件类型 + 必填字段>` | `<撤销方式 + kill switch>` | `draft` |
| `POLICY-____` | `v__` | `<待填写>` | `<待填写>` | `<待填写>` | `<待填写>` | `<待填写>` | `<待填写>` | `<待填写>` | `draft` |

### 4.8 候选示例（最多 2 条，待用户批准，不生效）

> 以下仅为“字段如何填写”的格式示例，**不是授权决定，不得用于实现，不得视为白名单命中**。

| 示例 | 动作范围（占位） | 预授权主体（占位） | 风险等级 | 有效期 | 适用环境 | 审计记录 | 撤销机制 | 状态 |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| `EXAMPLE-A` | `<R0 只读、无外部副作用、可重复执行的动作>` | `<服务端可信 local-owner 或指定角色>` | `R0` | `<绝对时间，待定>` | `<精确环境，待定>` | `<必填审计字段，待定>` | `<按 policyId 撤销 + kill switch>` | **候选示例 / 未批准 / 不得实现** |
| `EXAMPLE-B` | `<R1 可逆、可补偿、幂等、无外部副作用的内部写动作>` | `<服务端可信主体/角色>` | `R1` | `<绝对时间，待定>` | `<精确环境，待定>` | `<必填审计字段，待定>` | `<按 policyId 撤销 + kill switch>` | **候选示例 / 未批准 / 不得实现** |

### 4.9 匹配与校验规则

1. **全字段 AND 匹配**：七个字段全部匹配才算命中；此外还必须匹配动作参数摘要、计划/产物版本、目标资源；不得“风险等级匹配就放行”。计划/产物版本匹配条件来自 v1.3 §33.1，不属于七个字段本身，但属于命中条件。
2. **精确匹配**：动作名、操作名、参数、目标、主体、环境、计划/产物版本均为精确匹配；禁止通配符、正则、前缀、隐式继承。
3. **默认拒绝**：未命中、字段缺失、类型错误、未知枚举、策略表不可读、策略版本不支持、审批系统故障，一律 fail-closed。
4. **只豁免审批等待**：fail-open 不等于授权绕过；工具 allowlist、任务授权、确定性验证、证据校验、`trustLevel` 规则、污点检查、预算、deadline、幂等、审计仍然生效。
5. **审计先行**：先写审计再执行；审计写入失败则不执行。【v1.3 §33.1 第 5 条 + §33 建议项，已采纳；不再是推断】
6. **撤销即时生效**：撤销后的下一次调用必须拒绝；缓存必须有上限并支持主动失效。
7. **人工治理**：策略表新增/修改/撤销必须由人工批准并留版本记录；Agent 不得自授权。
8. **R2/R3 排除**：R2/R3 永不出现在 fail-open 表中；即使误配置，加载时也必须拒绝。

### 4.10 受影响条款

| 条款 | 内容摘要 | 受影响方式 |
| --- | --- | --- |
| §15（v1.1 / v1.2） | 审批超时默认 fail-closed；仅低风险、可逆、预先授权的动作可按明确策略 fail-open | “明确策略”由 v1.3 §33.2 的七字段定义；原句保留但不再单独作为放行依据 |
| §33.1（v1.3） | 未命中即 fail-closed；仅 R0/R1；全字段匹配；策略不可读/审批故障 fail-closed | 本条的直接条款依据 |
| §33.2（v1.3） | 7 个必需字段的定义与约束 | 本 ADR 4.6 的字段取值约束按此对齐；落库键名仍为建议待确认 |
| §33.3（v1.3） | 策略表只能人工版本化变更；审计绑定 `policyVersion`；撤销权独立 | 本 ADR 4.5 第 5、6 条与 4.9 第 7 条按此执行 |
| §42 B-11（v1.3） | 审批请求有持久化 SLA、提醒、升级和取消路径 | fail-open 与审批链路共用同一套证据要求 |
| §6（v1.0） | 安全与可靠性硬约束 | fail-open 不得放宽硬约束；未命中一律 fail-closed |
| §16（v1.1） | 数据来源污点与工具权限；污染内容不得解锁特权工具或扩大 allowedTools | fail-open 命中不得绕过污点检查或扩大工具权限 |
| §13（v1.1） | 风险分级验证路由（R0–R3）；缺信息按更高一级处理 | 只有 R0/R1 可进入白名单；未知风险按更高等级拒绝 |
| §30（v1.2） | v1.2 编码验收门槛 | 验收时必须覆盖“未命中 fail-closed”和“R2/R3 永不 fail-open” |
| §22（v1.1） | 审批超时、批量、升级和申诉规则明确 | fail-open 策略表与审批升级规则叠加适用 |

---

## 5. 代码落点清单（只列后续实现位置，本步不实现）

> 本清单只做只读定位；本 ADR 不修改任何源码、测试、配置。
>
> 验收证据以 v1.3 §42 为准：A1 对应 B-03/B-04，A2 对应 B-05/B-06，D1 对应 B-10/B-11，A7/A8 对应 §33.1/§42 相关项；本清单只说明“要改哪里”，不代表已完成或已通过验收。
>
> 前置四件缩写：
> - **A 协议收敛**：冻结唯一权威、契约、错误码、状态迁移、阈值与版本口径
> - **B CAS**：`expectedVersion` / `expectedStateVersion` + 冲突错误 + fencing
> - **C 最小 Artifact 与完成提交**：Artifact Store + 完成前引用校验
> - **D 审批 TTL**：审批 SLA、`waiting_approval` 纳管、超时/恢复收口

### 5.1 A｜协议收敛

| # | 文件 | 函数 / 位置 | 现状（只读审计） | 关联裁决 | 前置四件 | 本步动作 |
| --- | --- | --- | --- | --- | --- | --- |
| A1 | `server/agents/state-machine.js` | `STATUSES`、`TRANSITIONS`、`assertTransition`（L11-58） | 9 个状态；无 `retrying` / `recovery`；`waiting_approval` 只能到 `completed` / `failed` / `cancelled` / `uncertain`，不能到 `running` / `timed_out`；与 §24.2 未对齐 | D1、D2 | A + D | 只记录，不修改 |
| A2 | `server/agents/tasks.js` | `createTask`（L484-650）、`normalizeBudget`（L429-454）、`updateTask`（L695-780）、`setRetry`（L1013-1034） | 预算只有 `maxRounds` / `maxToolCalls` / `maxReadOnlyRetries`；deadline 默认 60s、范围 5–120s；`maxAttempts` 默认 1、环境变量最多 3；无 token/费用预算、无 `parentTaskId`、无委派深度、无 `replanCount` | D1、D2 | A + B | 只记录，不修改 |
| A3 | `server/agents/routing-config.js` | `DEFAULT_ROUTING`（L25-48）、`validateRoutingConfig`（L96-171）、`load`（L185-213） | `SCHEMA_VERSION = 1` 精确校验；只有 fast/slow 的 rounds/toolCalls/readOnlyRetries 和 deadline 范围；无 2/2/3/30min 字段、无阈值变更记录、无 `runtime-contract` 版本 | D1 | A | 只记录，不修改 |
| A4 | `server/agents/runtime.js` | `buildPolicy`（L119-147）、deadline 计时（L645-657）、终态收口（L809-824） | 只有 rounds/toolCalls/readOnlyRetries 预算；deadline 只在真正执行时计时；无 token/费用统计、无 `usage`、无重规划计数；`waiting_approval` 不受 deadline 约束 | D1、D2 | A | 只记录，不修改 |
| A5 | `server/tool-dispatch-bot.js` | `validate` / 派发路径（L28-60、L117、L143-146） | 只允许派发给 memory Bot；无 `parentTaskId`、无委派深度计数器；当前是结构性一跳，不是显式 2 层策略 | D1 | A | 只记录，不修改 |
| A6 | `server/agents/permissions.js` | `getPermissionProfile`（L14-28）、`checkOperation`（L30-40） | 硬编码 `single_user`；只有 `allowedOperations` + `approvalRequired`；无 R0–R3、无预授权主体、无环境/有效期/撤销字段 | D3 | A | 只记录，不修改 |
| A7 | `server/agents/tool-gateway.js` | `createToolAuthorizer`（L12-…） | 已按 allowedTools + policy mode 做事前拒绝（未命中即拒绝）；无 R0/R1 白名单七字段、无 per-call 主体/风险/环境/有效期/撤销校验 | D3 | A | 只记录，不修改 |
| A8 | `server/agent-runtime.js` | `TOOL_RISKS`（L86）、风险校验（L162-167）、高风险闸门（L383-392） | 只有 `read` / `reversible_write` / `high_risk` 三级；`high_risk` 返回 `confirmation_required`；无 R0–R3 映射、无 fail-open | D3 | A | 只记录，不修改 |
| A9 | `server/agents/errors.js` + `tasks.js` / `approvals.js` / `runtime.js` 散落短码 | `AgentError`、`describeAgentError` | 错误码分散；无 v1.2 §23 六类错误分类、无 `retryable` / `errorFingerprint` / `failedAt` 统一字段 | D1、D2 | A | 只记录，不修改 |

### 5.2 B｜CAS

| # | 文件 | 函数 / 位置 | 现状（只读审计） | 关联裁决 | 前置四件 | 本步动作 |
| --- | --- | --- | --- | --- | --- | --- |
| B1 | `server/agents/tasks.js` | `updateTask`（L695-780）、`recordCheckpoint`（L994-1011） | `checkpointVersion` 只是自增计数器；`updateTask` 接受任意非负 `checkpointVersion`；无 `expectedVersion` / `expectedStateVersion`；无 `version_conflict` | D1、D2 | B | 只记录，不修改 |
| B2 | `server/agents/task-store.js` | `load` / `save`（L96-113） | 单实例原子文件；`writeFileAtomicSync` 只保证落盘原子性，不保证并发读改写不丢失；无 CAS 校验 | D1、D2 | B | 只记录，不修改 |

### 5.3 C｜最小 Artifact 与完成提交

| # | 文件 | 函数 / 位置 | 现状（只读审计） | 关联裁决 | 前置四件 | 本步动作 |
| --- | --- | --- | --- | --- | --- | --- |
| C1 | `server/agents/runtime.js` | 结果收口（L700-730） | `artifacts: []` 硬编码在 L713；Worker 结果没有可引用的产物；没有“产物先持久化再提交 completed”的协议 | D1、D2 | C | 只记录，不修改 |
| C2 | `server/agents/worker-result.js` | `normalizeWorkerResult`（L57-85） | `artifacts` 只是字符串 ref 数组，无 `artifactId` / `version` / `trustLevel`；无 `usage`；`requiresApproval` 由 `requiresConfirmation` 派生 | D2、D3 | C + A | 只记录，不修改 |
| C3 | 新增最小 Artifact Store（缺失） | 无对应文件/函数；建议路径 `server/agents/artifact-store.js`【推断】 | 全仓无 artifact store / artifact registry；审计 `docs/phase0-baseline-audit-2026-11-03.md` §3.4 判定 0/10 字段 | D1、D2 | C | 只记录，不修改 |

### 5.4 D｜审批 TTL

| # | 文件 | 函数 / 位置 | 现状（只读审计） | 关联裁决 | 前置四件 | 本步动作 |
| --- | --- | --- | --- | --- | --- | --- |
| D1 | `server/agents/approvals.js` | `STATUSES`（L31-38）、`createApproval`（L176-267）、`decide`（L269-342）、`execute`（L352-…） | 状态只有 `pending` / `approved` / `rejected` / `executing` / `completed` / `failed`；无 `expiresAt` / SLA / escalation / overdue；无 `expired` / `escalated` / `cancelled`；无 R2/R3 分级 | D2、D3 | D | 只记录，不修改 |
| D2 | `server/agents/watchdog-policy.js` | `DEFAULT_POLICY`（L10-26）、`evaluate`（L45-112）、`planActions`（L132-191） | 只处理 `queued` / `accepted` / `running` 的 backlog、租约和心跳；`waiting_approval` 完全不在纳管范围；无审批超期 finding / `overdue` 升级 | D2 | D | 只记录，不修改 |
| D3 | `server/agents/tasks.js` | `createTask` / `updateTask` 的 `waiting_approval` 迁移 | `waiting_approval` 迁移表缺少 `running` / `timed_out`；deadline 只在 `runtime.js` 真正执行时计时；审批等待期间没有 deadline/budget 收口 | D2 | A + D | 只记录，不修改 |
| D4 | `server/agents/routes.js` | 审批路由（L353-435） | 只有 create/list/get/approve/reject/execute；无 cancel / expire / escalate / overdue 字段或端点 | D2、D3 | D | 只记录，不修改 |
| D5 | `server/monitoring/store.js` | 审计链路（L704-801） | 已有 trace/audit，但无“审批 SLA / overdue / fail-open 白名单命中”专用事件 schema；审计字段未覆盖七字段白名单 | D3 | D + A | 只记录，不修改 |

---

## 6. 已定 / 待定分离清单

### 6.1 已定（用户裁决，已落入本 ADR）

| # | 已定事项 | 出处 |
| --- | --- | --- |
| 1 | 版本优先级 **`v1.3 > v1.2 > v1.1 > v1.0`**；初稿 `v1.2 > v1.1 > v1.0` 已被取代并保留原文 | D1 / 2.1.2、2.6.1；v1.3 §31.1 |
| 2 | 2/2/3/30min 是初始默认硬阈值（A 类），Phase 0 可基于实测调整 | D1 / 2.6.2；v1.3 §31.2、§36 |
| 3 | 单 Run 重规划 2 次为 Run 级统一计数，Task 级只记录、不设独立上限 | D1 / 2.6.2；v1.3 §36 |
| 4 | 调整必须留版本记录：旧值、新值、依据、批准人、生效时间、配置版本号、回滚点 | D1 / 2.6.3；v1.3 §31.2 |
| 5 | R3 不设审批自动批准超时 | D2 / 3.1；v1.3 §32.1 |
| 6 | R3 的 Task deadline、Task Token 预算、Run 总预算仍然有效；等待墙钟计入 Run 时间预算 | D2 / 3.1、3.6；v1.3 §32.1、§32.4 |
| 7 | 任一硬约束耗尽即停止执行；无未核清副作用 → `timed_out`，有则先 `recovery`，用 `errorCode` 区分 | D2 / 3.5、3.6；v1.3 §32.1 |
| 8 | 外部副作用结果未知必须先 `recovery`，不得重试/批准/掩盖 | D2 / 3.6 |
| 9 | `waiting_approval` 合法迁移到 `running` / `cancelled` / `failed` / `timed_out` / `recovery`；`timed_out` 不改变 Approval Request 的 `pending` | D2 / 3.6；v1.3 §32.2 |
| 10 | `overdue` 是 Approval Request 标记、不是 Task 状态；升级链路为 escalation 事件 → 明确责任人 → 通知 → 轮值升级 | D2 / 3.6；v1.3 §32.3 |
| 11 | `retrying` / `recovery` 是正式状态，仅 Engine 可写 | D2 / 3.7；v1.3 §24 + §42 B-03 |
| 12 | R0/R1 必须建立显式 fail-open 策略表，至少 7 字段 | D3 / 4.1、4.6；v1.3 §33.2 |
| 13 | 未命中白名单一律 fail-closed | D3 / 4.1、4.9；v1.3 §33.1 |
| 14 | 审计写入失败同样 fail-closed，不得先执行后补审计 | D3 / 4.5、4.6、4.9；v1.3 §33.1 第 5 条 + §33 建议项（用户确认采纳） |
| 15 | R2/R3 永不 fail-open | D3 / 4.5；v1.3 §33.1 |
| 16 | A 类数值已采纳：168 小时、5000、20000、10、20%/50、90 天、fail-open ≤90 天/单次取短、默认并发 1 | v1.3 §36 |
| 17 | B 类机制已定、值待压测：Task Token/费用、deadline/toolCalls 全局上限、四维限流、熔断、图检测 200 ms、orphan 扫描周期 | v1.3 §36 |
| 18 | Owner 已指定：`TRAE 宝（No.001 · TRAE Bot）`；执行方 `AI 执行会话` | v1.3 §41 |

> 说明：上述第 1 项为本次修订新增/变更；第 3、9、10、11、14、16、17、18 项由 v1.3 封版条款直接定掉，此前在初稿中列为待定的对应项已删除。

### 6.2 待定（真待定；每条一句话说明不定会怎样）

| # | 待定项 | 不定会怎样 | 建议决策点 |
| --- | --- | --- | --- |
| 1 | fail-open 策略表的具体动作、主体、环境、有效期（§33.2 字段定义已定，**条目内容**未定） | 白名单为空，所有动作只能 fail-closed，R0/R1 的 fail-open 能力实际不可用 | 用户/授权人逐条批准后填写 |
| 2 | B 类数值：Task Token/费用预算、`deadline`/`toolCalls` 全局上限、四维限流、熔断阈值、图检测 200 ms、`orphan` 扫描周期 | 未压测前不得作为生产标准，无法给出对外 SLA、容量规划或成本承诺 | 压测/基线测量后按 §36.1 升级 |
| 3 | fail-open 策略表落库形态与键名（独立配置 vs 代码常量；§33.2 的 `actionScope` 等键名仅为建议） | 难以实现版本化、即时撤销与审计绑定 `policyVersion` | 与审批 TTL（前置四件 D）一起设计 |
| 4 | 阈值变更记录的存放介质（本 ADR 附录 / 独立 changelog / 配置内嵌；字段格式已由 §31.2 定） | 审计反查与回滚缺少唯一入口，容易出现多份记录不一致 | 协议收敛时与 `configVersion` 一起冻结 |

### 6.3 初稿待定项逐项对齐（已被 v1.3 定掉 / 仍未定）

| 初稿 # | 初稿待定项 | 现状 | 依据 |
| --- | --- | --- | --- |
| 1 | fail-open 具体动作、主体、环境、有效期 | **仍未定**（见 6.2 #1） | §33.2 只定义了字段，条目内容需用户批准 |
| 2 | Task Token / Run 预算具体数值 | **已定机制，值待压测**（B 类） | v1.3 §36 |
| 3 | 预算耗尽落 `timed_out` 还是 `failed` | **已被 v1.3 定掉**：无未核清副作用 → `timed_out`，有则先 `recovery`，用 `errorCode` 区分 | v1.3 §32.1 |
| 4 | R3 `overdue` 提醒阈值与升级节奏 | **已被 v1.3 定掉**（载体是 Approval Request，不是 Task 状态；升级链路已定） | v1.3 §32.3 |
| 5 | Task 终止时审批请求用 `expired` 还是 `cancelled` | **已被 v1.3 定掉**：`timed_out` 不改变 Approval Request 的 `pending`，可保留 `pending` / `overdue` | v1.3 §32.2、§32.3 |
| 6 | 是否引入 `retrying` / `recovery` | **已被 v1.3 定掉**：正式状态，仅 Engine 可写 | v1.3 §24 + §42 B-03 |
| 7 | 阈值变更记录的存放位置与格式 | **格式已定、介质未定**：七项留痕字段已列；存放介质见 6.2 #4 | v1.3 §31.2 |
| 8 | fail-open 策略表是独立配置还是代码常量 | **仍未定**（见 6.2 #3） | §33.2 键名仅为建议 |
| 9 | 审计写失败是否一律拒绝执行 | **已被 v1.3 定掉**：fail-closed，不得先执行后补审计 | v1.3 §33.1 第 5 条 + §33 建议项（用户确认采纳） |
| 10 | 既有阶段 ADR 与本 ADR 的逐条映射 | **不属本 ADR 范围**：0.1 已定“阶段 ADR 不被整体废止、冲突按版本优先级处理”，逐条映射留待协议收敛 | 本 ADR 0.1 |
| 11 | v1.3 的 `v1.3 > v1.2 > v1.1 > v1.0` 是否生效 | **已被 v1.3 定掉**：2026-11-03 封版 + 用户后续裁决 | v1.3 §31.1 |

**原【推断】项的转正情况**：

| 原推断 | 现状 | 依据 |
| --- | --- | --- |
| 审计先行、写入失败即拒绝 | **已转正**（不再是推断） | v1.3 §33.1 第 5 条 + §33 建议项（用户确认采纳） |
| `overdue` 只作标记、不作审批结果 | **已转正** | v1.3 §32.3 |
| `timed_out` 不改变 Approval Request 的 `pending` | **已转正** | v1.3 §32.2 |
| A 类数值可作安全默认 | **已转正（数值已采纳，校准未完成）** | v1.3 §36 |
| Owner 需具体到人 | **已转正** | v1.3 §41 |
| 配置漂移时 fail-closed 拒绝加载 | **仍为推断**：未实现、未测试 | 本 ADR 2.6.3 第 5 条 |
| 各字段校验点与新增模块路径 | **仍为推断**：以协议收敛结果为准 | 本 ADR 4.6、第 5 节 |

---

## 7. 证据状态与未验证项

### 7.1 已完成（本步实际做了）

| 项 | 结果 |
| --- | --- |
| 检查 ADR 目录 | 仓库无 `docs/adr/`；发现 `docs/agent-runtime-stage1.md` ~ `stage4.md` 内有阶段局部 ADR，另有 `docs/v1.3-decisions-and-verification-checklist-2026-11-03.md`（2026-11-03 已封版的跨阶段决策清单） |
| 新建目录 | `docs/adr/` 已创建 |
| 新建本 ADR | `docs/adr/0001-runtime-contract-decisions-2026-11-03.md` |
| 裁决落盘 | 三条裁决均按用户原话记录，Status 均为 `Accepted`，Date 为 2026-11-03 |
| 版本优先级条款 | 本次修订已写清 **`v1.3 > v1.2 > v1.1 > v1.0`**、2/2/3/30min 映射、A/B 类数值、留痕字段；初稿 `v1.2 > v1.1 > v1.0` 保留并标 Superseded by |
| v1.3 对齐 | 已完整阅读 v1.3 封版清单（§31.1、§31.2、§32、§33、§36、§37、§38、§41、§42），并按条款修订 D1/D2/D3 |
| 待定清单对齐 | 初稿 11 条待定已逐项标注（6.3）：6 条完全转已定、2 条部分已定（机制/格式已定、数值/介质未定）、2 条仍未定、1 条不属本 ADR 范围；真待定合并为 4 条 |
| R3 约束矩阵 | 已覆盖 `waiting_approval` × 四类硬约束，并写明“任何一格不得自动批准” |
| fail-open 策略表骨架 | 已给 7 字段、取值约束、校验点、空表体、2 条候选示例（标注未批准） |
| 代码落点清单 | 已按 A/B/C/D 四件分组，列出文件、函数、现状；未改代码 |

### 7.2 未验证（不得当作已通过）

| 项 | 说明 |
| --- | --- |
| 未运行测试 | 本步只写文档；未执行 `npm test`、`node scripts/verify-test-coverage.js` 等 |
| 未做运行时验证 | 未实测 `waiting_approval` 下的 deadline/预算行为；结论来自静态阅读 |
| 未验证 Notion 页面 | 页面元数据 `verification: unverified`；标题仍为 v1.0，正文含 v1.2；v1.3 依据是仓库内封版清单，不是 Notion 页面 |
| 未验证 A 类数值校准 | A 类数值已由 v1.3 §36 采纳，但未实测校准；不得对外承诺 |
| 未验证 B 类数值 | B 类（Token/费用、deadline/toolCalls 上限、限流、熔断、图检测 200 ms、orphan 扫描周期）未压测，不得作为生产标准 |
| 行号可能漂移 | 代码行号来自当前工作区只读审计；后续改动后需重新定位 |
| 未实现配置漂移检测 | 2.6.3 第 5 条是记录者推断，未实现、未测试 |
| 未实现审计 fail-closed | 结论已由 v1.3 §33 定为 fail-closed，但运行时尚未实现、未测试 |
| 未验证候选示例 | 两条示例仅为格式占位，未经用户批准，不构成授权 |
| 未验证 v1.3 §42 | 25 项验收一律未勾选；本 ADR 不声称任何一项已通过 |

---

## 附录 A：既有阶段 ADR 索引（只读）

| 文档 | ADR 编号 | 标题 |
| --- | --- | --- |
| `docs/agent-runtime-stage1.md` | ADR-01 | 所有委派必须经过 Router |
| `docs/agent-runtime-stage1.md` | ADR-02 | Task Contract v1 冻结字段 |
| `docs/agent-runtime-stage1.md` | ADR-03 | Fast / Slow 是确定性分类 + 预算快照 |
| `docs/agent-runtime-stage2.md` | ADR-01 | 单次执行 = 一个 runId + 一条可验证的生命周期 |
| `docs/agent-runtime-stage2.md` | ADR-02 | Worker Session 有 owner、作用域和生命周期 |
| `docs/agent-runtime-stage2.md` | ADR-03 | 上下文按需投影 |
| `docs/agent-runtime-stage2.md` | ADR-04 | 工具权限网关先于执行 |
| `docs/agent-runtime-stage3.md` | ADR-01 | 状态机是唯一事实来源，新增 `uncertain` |
| `docs/agent-runtime-stage3.md` | ADR-02 | Store 接口与 schema v2 |
| `docs/agent-runtime-stage3.md` | ADR-03 | 租约、心跳、运行历史与 checkpoint 版本 |
| `docs/agent-runtime-stage3.md` | ADR-04 | 启动恢复按幂等性分流 |
| `docs/agent-runtime-stage3.md` | ADR-05 | 幂等语义与多进程边界 |
| `docs/agent-runtime-stage4.md` | ADR-01 | Watchdog 与 Supervisor 都是进程外组件 |
| `docs/agent-runtime-stage4.md` | ADR-02 | 监控项与判定 |
| `docs/agent-runtime-stage4.md` | ADR-03 | 确定性动作、白名单、冷却与熔断 |
| `docs/agent-runtime-stage4.md` | ADR-04 | 暂停接单是写入数据目录的信号 |
| `docs/agent-runtime-stage4.md` | ADR-05 | 离线恢复只在服务确认停机时执行 |

> 这些编号是阶段局部编号，不与本 ADR 的 `ADR-0001` 形成同一序列；引用时必须写全“文档路径 + ADR 编号”。

---

## 附录 B：阈值变更记录模板（待填写）

> 每次调整必须追加一行；`oldValue` 永久保留。模板字段含义见 2.6.3。

| changeId | contractVersion | configVersion | field | scope | oldValue | newValue | changedBy | approvedBy | changedAt | basisReportRef | reason | rollbackPlan | effectiveFrom | auditEventId | status |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| `<待填写>` | `<待填写>` | `<配置版本号>` | `<待填写>` | `<global/env/agentId/taskType>` | `<旧值原文>` | `<新值>` | `<人+角色>` | `<人+角色>` | `<ISO8601>` | `<报告路径 + commit + 指标>` | `<原因>` | `<回滚条件>` | `<生效时间>` | `<审计事件 ID>` | `<effective/rolled_back/superseded>` |

---

## 附录 C：引用清单

| 文档 | 用途 |
| --- | --- |
| `docs/phase0-baseline-audit-2026-11-03.md` | Phase 0 基线审计、组件盘点、契约缺口、P1–P5 协议重复 |
| `docs/handover-2026-11-03.md` | 仓库基线、硬约束、模块地图、测试纪律 |
| `docs/v1.3-decisions-and-verification-checklist-2026-11-03.md` | **2026-11-03 已封版**；§31–§42，本 ADR 的修订依据（§31.1 版本优先级、§31.2 留痕、§32 R3、§33 fail-open、§36 A/B 类、§37 来源、§38 orphan、§41 Owner、§42 验收矩阵） |
| Notion `40da9575-23c2-8135-9607-e23f6a3c784f` | 架构 v1.0/v1.1/v1.2 条款：§13、§15、§16、§18、§22、§23、§24.2、§25、§29、§30；页面元数据 `unverified`，v1.3 以仓库封版清单为准 |
| `server/agents/state-machine.js` | 状态集合与合法迁移现状 |
| `server/agents/tasks.js` | Task 创建、预算、deadline、updateTask、setRetry |
| `server/agents/runtime.js` | Worker 执行、deadline、预算、结果收口 |
| `server/agents/approvals.js` | 审批创建/决定/执行现状 |
| `server/agents/watchdog-policy.js` | Watchdog 纳管范围现状 |
| `server/agents/permissions.js` | 单用户权限模型现状 |
| `server/agents/tool-gateway.js` | 工具 allowlist 与 fail-closed 现状 |
| `server/agent-runtime.js` | 工具三级风险与高风险闸门现状 |
| `server/agents/task-store.js` | 单实例持久化与无 CAS 现状 |
| `server/agents/worker-result.js` | 结果 schema 与空产物限制现状 |
| `server/tool-dispatch-bot.js` | 委派一跳现状 |
