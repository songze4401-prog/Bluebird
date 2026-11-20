# P5-C 第 1 轮：fencing / generation token（2026-11-07）

> 覆盖原文：Notion `Bluebird Agent Runtime｜混合式多 Agent 目标架构 v1.0` §10 计划版本迁移与 §20 第 349 步「旧 Worker 仍运行时用 fencing token 阻止过期副作用」。
> 缺口编号：FM-4（计划版本竞争与 fencing token），台账第 46 行 A-01 的「限定」项、第 49 行 A-10 的 FM-4 缺口。
> 代码基准：`main` = `77ddc8f`。本文件记录本轮实现、接线点、验收与边界，不替台账改判状态。

## 1. 为什么需要（租约挡不住的两个真实窗口）

现有两套机制都不回答"**你现在还有没有资格写**"：

1. **租约（lease）挡不住同进程的第二次运行。** `runtime.js` 的 `WORKER_OWNER_ID = pid:uuid` 在整个进程内是同一个值，`tasks.acquireLease` 只在 `task.lease.ownerId !== ownerId` 时拒绝。同一任务被 `retry`/`recoverInterrupted` 再次调度时，新的运行会**顺利拿到同一个 owner 的租约**，而旧运行的心跳续租也照样成功——`leaseLost` 永远不会置位。§20 第 349 步说的正是这个场景：旧 Worker 没死、工具还能调、产物还能写。
2. **幂等账本（op-ledger）只回答"做过没做过"。** 它按 `(agentId, taskId, stepId, toolName, args)` 复用或拒绝重跑，但一个"从未执行过"的新调用在旧代次下会正常落账并执行。

本轮补的就是写入资格判定：代次（generation）随时任务重新签发而单调上升，旧运行手里是旧代次，**每次副作用与每次产物/结果提交前各判一次**，过期即拒绝。

顺带修掉两个被这个场景暴露出来的既有缺陷（见 §3.5）：旧运行退出时会把新运行的 `activeRuns` 控制器删掉、并把新运行的租约一并释放。

## 2. 实现：`server/agents/fencing.js`

### 2.1 存储与口径

- 文件 `data/agents/agent-fencing.json`，`chmod 600`，`writeFileAtomicSync` 落盘（与 op-ledger 同口径）；结构 `{version:1, counter, tasks:{taskId: record}}`。
- 记录：`{taskId, planId, planVersion, generation, tokenId, runId, issuedAt, revokedAt, revokeReason}`，只含 id、版本号与时间戳，不含任何正文。
- **代次单调**：`issue()` 一律 `counter + 1`，落盘成功后才返回令牌；重启 `recover()` 读回同一份计数器，**绝不重建**。
- **败验证**：`counter` 小于任一已签发代次、字段类型不对、文件无法解析，一律抛 `fencing_unavailable`（verify 侧返回同码的拒绝），不"修复"成 0——重建计数器等于把旧令牌重新变成有效。
- **资格按任务判定，不按平面计划版本判定**：§10 规定 running / waiting_approval / recovery 的任务保持原 planVersion（`continued`），它们不该因为计划出了新版本就被拦；只有该任务被重新签发（`migrated` / 新一轮运行）或显式撤销时才失效。

### 2.2 五个拒绝码

| 短码 | 含义 | 触发 |
|---|---|---|
| `stale_generation` | 代次已过期 | 令牌代次 < 记录代次（同任务重新签发后，旧 Worker 仍是旧代次） |
| `fencing_revoked` | 资格已收回 | 任务终态、§10 `cancelled` / `revalidated` |
| `fencing_token_invalid` | 令牌不可信 | `tokenId` 对不上、代次不是整数或大于当前代次（伪造/未来代次） |
| `fencing_token_missing` | 无资格记录 | 从未签发，或记录已被清理 |
| `fencing_unavailable` | 存储不可用 | 文件损坏/计数器回退；fail-closed，绝不降级放行 |

判定顺序刻意是「先代次、后 tokenId」：同一任务重新签发后旧令牌的 tokenId 必然对不上，但它的真实含义是**过期**而不是伪造，报错码要能区分这两件事。

### 2.3 其余接口

- `revoke({taskId, reason})`：幂等，返回记录副本附 `changed`，调用方据此决定是否重复记审计。
- `applyMigration({planId, toVersion, migrations})`：按 §10 映射处置——`migrated` 换发（旧代次立即过期）、`cancelled` / `revalidated` 收回、`continued` / `reused` / `unchanged` 不动。
- `snapshot()`：`counter / records / active / revoked / overCap / targets[]`，供 `runtime.limitsSnapshot().fencing` 观测。
- `cleanup({terminalTaskIds})`：只删"已撤销 + 任务终态"的记录；上限 5000，只淘汰已撤销的终态记录，活跃记录永不自动删除。删记录不会让旧令牌复活——无记录一律 `fencing_token_missing`。

## 3. 接线点（全部是生产路径）

### 3.1 运行开始签发（`runtime.js` `runTask`）

拿到租约后立刻 `fencing.issue({taskId, planId, planVersion, runId})`，令牌**只留在本次运行的内存里**，同时落一条 `plan.fencing_issued` 事件（带 generation / planId / planVersion）。刻意不让 Worker 从盘上"再读一次当前令牌"——那等于让旧 Worker 自己给自己续资格，fencing 就失效了。

签发失败（存储坏）直接抛 `fencing_unavailable`：`decideFailureDisposition` 判定为 `recovery`（不是终态 failed），与 `plan_store_corrupted` 同一口径。

### 3.2 副作用闸门（`side-effect-guard.js`）

`createSideEffectGuard({agentId, taskId, fencingToken})`，`before()` 在 **`ledger.begin` 之前**校验：

- 过期代次**不写账本意图行**。否则一次被拦的调用会在账本里留下 `started`，下次同键调用会被误判成"可能已执行"而转 recovery——把一次确定性拒绝污染成一次不确定副作用。
- 拒绝时 `guard.denial` 暴露 `{code, heldGeneration, currentGeneration, policyVersion}`，`runtime.execute` 据此落 `plan.fencing_denied` 事件（含 `phase:'side_effect'`）并抛确定性错误（不是 `side_effect_*` 前缀，因此不会进 recovery 分支）。
- `agent-runtime.executeToolCall` 的 blocked 文案区分三种语义：可能已执行 / 资格失效 / 账本不可用。

### 3.3 产物与结果提交（`runtime.js`）

模型执行期间可能已经换代（计划迁移、或租约易主后的新运行开始），因此在两个位置各判一次：

- `artifact_persist`：`persistTaskArtifacts` 之前，过期则一个产物都不落；
- `result_commit`：`artifactCommit.completeTask` 之前（独立审校可能等了数十秒，期间同样可能换代）。此时被拒会留下 pending-commit 产物，由既有 `scanPendingCommits` 收敛，不新增恢复路径。

### 3.4 终态撤销与启动对账

- `runTask` 的 `finally`：任务已终态即 `fencing.revoke(reason='task_terminal:<status>')` 并落 `plan.fencing_revoked`——取消/完成后仍在跑的旧 Worker 不能再落副作用。
- `runtime.convergeFencingTokens()`（新增，启动时在计划解析之后、中断恢复之前跑）：
  - 读得回来：计数器原样保留，给终态任务补撤一次（上次可能死在终态写入与撤销之间），计数 `sealed`；
  - 读不回来 / 代次回退：所有非终态任务一律 `recovery` + `fencing_unavailable`，落 `task.uncertain`，与 `plan_store_corrupted` 同一口径。
- `limitsSnapshot()` 新增 `fencing` 段（`counter / records / active / revoked / overCap`）。

### 3.5 资格丢失后的运行收口（含两处既有缺陷修复）

新增 `FENCING_AUTHORITY_CODES`（四个"本实例已无资格"的码）分支：旧运行只退出，**不改写任务状态**——与 `task_lease_held` 同口径。理由是同一个任务此时可能已由持有新代次的运行接管，旧运行的失败不能把新运行改成 failed。

同时修掉两个因此变成可达路径的既有缺陷：

1. `activeRuns.delete(taskId)` 改为只在控制器是自己时才删（否则旧运行退出会摘掉新运行的取消入口）；
2. 资格已丢失时**不释放租约**（同进程 ownerId 相同，贸然 `releaseLease` 会把新运行的租约一并清掉）。

### 3.6 §10 迁移桥（`workflow-store.migratePlanVersion`）

迁移分配出新版本后调用 `fencing.applyMigration`，返回里新增 `fencing: {issued, revoked, kept}`。`continued` 的任务保持原令牌——这是 §10「运行中节点保持原版本」的直接落地，也避免了"计划一出新版本就把正在跑的节点拦死"的错误收紧。

### 3.7 失败模式命名（`errors.js`）

- `FAILURE_MODES` 增加 `plan_version_race`（FM-4），中文标签「计划版本竞争：旧代次仍尝试写副作用」；处置 `terminal / retryable:false / status:failed / errorCode:stale_generation`。
- `classifyFailureMode` 把 `stale_generation`、`fencing_revoked`、`fencing_token_invalid`、`fencing_token_missing` 归为 FM-4；`fencing_unavailable` **不**归入（存储不可用需对账，不是版本竞争，与 `plan_store_corrupted` 同为未归类）。
- 处置表内容变了，`FAILURE_MODE_POLICY_VERSION` 由 `failure-modes-v1` 升到 `failure-modes-v2`，不让同一版本号指向两份不同的表。
- 审计白名单：`EVENT_TYPES` 新增 `plan.fencing_issued` / `plan.fencing_denied` / `plan.fencing_revoked`；`SAFE_PAYLOAD_KEYS` 新增 `planId` / `planVersion` / `generation` / `heldGeneration` / `currentGeneration`（P5-B 的教训：不加进白名单的事件会被 `safePayload` 静默丢掉，只剩空壳）。

## 4. 验收：`tests/agent-fencing.test.js`（8 项）

| 用例 | 证明什么 |
|---|---|
| a | 代次单调（1→2）、tokenId 换新、落盘可读回；计数器被改小或文件非 JSON 时 `recover()` 抛错、`verify()` 返回 `fencing_unavailable`，**不重置成 0** |
| b | 五类拒绝码各自独立：缺失/伪造 tokenId/未来代次/撤销/过期；重复撤销 `changed:false`；四类归 FM-4、`fencing_unavailable` 不归类 |
| c | **真实工具路径** `agentRuntime.executeToolCall`：旧代次的调用 handler 零执行、账本零行；新代次正常执行且账本一行 `succeeded`；撤销后同一令牌被 `fencing_revoked` 拒绝 |
| d | **真实 `runTask`**（本地 stub provider + 一次真实工具调用）：运行开始签发、副作用放行、任务 completed、终态撤销 `task_terminal:completed`、`plan.fencing_issued` / `plan.fencing_revoked` 事件落账、复读旧令牌被拒 |
| e | **§10 迁移桥**：`migrated` 换发（旧令牌 `stale_generation`，新令牌 planVersion=2）、`continued` 保持（running 节点令牌仍有效、planVersion 仍为 1）、`cancelled` / `revalidated` 收回 |
| f | 启动对账：代次文件损坏 → 非终态任务 `recovery` + `fencing_unavailable` + 事件；文件正常 → 计数器原样保留、非终态令牌不动、终态令牌补撤 |
| g | 审计字段真的落进事件：`heldGeneration` / `currentGeneration` / `generation` / `planId` / `planVersion` / `phase` 不被 `safePayload` 丢掉 |
| h | 清理只删"已撤销 + 任务终态"；活跃记录与未终态任务的记录保留；被删记录的旧令牌返回 `fencing_token_missing`（仍拒绝） |

## 5. 本轮实测（2026-11-07，`main` = `77ddc8f` + 本轮改动）

- `node scripts/run-tests.js`：**115 个测试文件全部通过**，失败 0（14:01:30 结束）。
- `node scripts/verify-test-coverage.js`：`backend=2380/2380`、`nodeSuite=222/222`、`runner=2158/2158`、`CI runner 覆盖 115/115`、`frontend=188/188 suites=22/22 failed=0`、`PASS agent-fencing 8`。
- `sync-doc-counts.js --check`、`scan-notion-ledger.js --check`、`verify-api-capabilities.js`、`tsc --noEmit`、`expo lint` 退出码均为 0。

## 6. 边界与残余缺口（如实记录）

1. **迁移入口仍无生产触发点。** `migratePlanVersion` 目前只有测试调用；`runtime.decideFailureDisposition` 上方原注释也写明"生产路径重跑沿用同一份冻结计划，没有'改计划再跑'的入口"。因此本轮 fencing 在生产中真正生效的换代来源是**同一任务的第二次运行**（retry / 租约过期后的重新调度 / 重启恢复），而"迁移把 running 任务留在 v1、把 queued 任务换到 v2"这条链要等第 2 轮的 `needs_revision → v1 → v2` 修订闭环接上后才变成生产路径。迁移桥本身已按 §10 语义测稳（用例 e），不是死代码，但**不能说 §10 的 v2 修订闭环已经完成**。
2. **单进程假设。** 与 op-ledger / `agent-tasks.json` 相同：read-modify-write，由进程单实例锁兜底；多 Worker 跨进程部署下代次文件没有分布式协调。令牌也不通过 HTTP 下发（运行层内存持有），因此外部 Worker 不在覆盖范围。
3. **代次文件物理丢失等于资格重置。** 删掉 `agent-fencing.json` 后计数器从 0 起算；单进程部署下重启后不存在仍存活的旧 Worker，因此不构成实际放行，但这是**文件级**假设，不是代次机制自身的保证（已在此披露，未用"不会发生"糊过去）。
4. **旧运行不再改写任务状态。** 资格丢失后旧运行直接退出；若此时**没有**任何新代次持有者（例如记录被清理、任务停在 running），任务要靠既有 watchdog/重启恢复收敛，本轮不新增第三条收口路径。
5. **审计只证明"拒绝发生了"。** `plan.fencing_denied` 里是 `heldGeneration` 与 `currentGeneration` 两个数字加短码；本轮没有把"旧 Worker 尝试了几次、被拦后是否继续尝试"做成指标（本轮不接 §7 指标）。
6. **`fencing_unavailable` 的可观测性**：运行开始签发失败会走 recovery；启动对账会批量收敛并落 `task.uncertain`。但损坏文件的修复动作仍需人工，本轮没做自动重建（刻意如此，重建与 fail-closed 冲突）。

## 7. 与原文的对应

| 原文位置 | 原文要求 | 本轮对应 | 状态 |
|---|---|---|---|
| §20 第 349 步 | 旧 Worker 仍运行时用 fencing token 阻止过期副作用 | 副作用前置校验 + 产物/结果提交前校验 + 终态撤销 + 启动对账 | 已交付（用例 c/d/f） |
| §10 迁移表 | queued/accepted/retrying 迁新版；running/waiting_approval/recovery 保持；终态不动 | `applyMigration` 只在 `migrated` 时换发、`cancelled`/`revalidated` 收回、`continued` 保持 | 已交付（用例 e）；**生产触发点待第 2 轮** |
| §17 计划版本竞争 | fencing token 拒绝过期代次 | `plan_version_race`（FM-4）命名 + 处置路由 + 审计事件 | 已交付 |
| §20 第 349 步后半 | 对外发布进入 `waiting_approval`、超时 fail-closed、获批后由 Gateway 幂等执行 | 未在本轮 | **待第 2 轮** |
| §10 修订闭环 | `needs_revision → F1 → v2`、只替换缺证节点、A1 兼容复用 | 未在本轮 | **待第 2 轮** |
