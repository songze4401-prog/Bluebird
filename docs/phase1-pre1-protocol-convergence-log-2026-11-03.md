# 一期（Pre-1）协议收敛实施记录（2026-11-03）

分支：`phase1/protocol-convergence-2026-11-03`（未合并、未开 PR）。
方案与决策见 `docs/protocol-convergence-plan-2026-11-03.md`；本文件只记结果，不重复方案正文。

## 提交与结论

| 步 | 提交 | 一句话结论 | 用例计数 |
| --- | --- | --- | --- |
| S1 | `6b03183` | 权威声明归位：`tasks.js` / `state-machine.js` / `task-store.js` 注释统一为"单一来源"。 | 2056 不变 |
| S2 | `4dab3e3` | 十态词表只在 `status-vocabulary.js` 导出，`uncertain → recovery` 仅作读边界别名。 | 2056 不变 |
| S3 | `8da8a89` | 任务状态写入收口到 `transitionTask`，`updateTask` 不再接受 `status`。 | 2056 不变 |
| S4 | `d94e09d` | Session 生命周期由任务状态投影派生，`closeSession` 不再接受任意值。 | 2056 不变 |
| S5 | `30d5ce7` | `recovery` 取代 `uncertain` 成为正式终态，旧数据读取时映射。 | 2056 不变 |
| S6 | `ae26a87` | 审批只能从 `running` 进入 `waiting_approval`，批准后先回 `running` 再执行。 | 2056 不变 |
| S6b | `339d5f7` | 审批等待期 Task deadline 生效；到期按副作用是否已知收敛，审批记录保持 `pending`。 | 2056 不变 |
| S7 | `8f08807` | `retrying` 正式化：删除 `running → queued`，退避到期由调度器直接回 `running`。 | **2056 → 2058**（+2） |
| S8 | `946c5af` | Task 新增可空 `planId` / `planVersion`；未接 Workflow Store 时恒为 `null`。 | 2058 不变 |
| S9 | `bbca1b2` | 每个版本字段单一来源：`contractVersion`（`contract.js`）、`checkpointVersion`（仅 `recordCheckpoint`）、`decisionVersion`（`memory-evidence` 常量）。 | 2058 不变 |

门禁基数：backend `2058`、nodeTestSuite `222`、runner `1836`、frontend `188`（22 suites）；S7 之前为 `2056 / 222 / 1834`。

## 本件未做的事

- CAS / `stateVersion` 并发控制：属 ② 范围，未实现；`checkpointVersion` 只是 checkpoint 序号，不是 CAS 版本。
- Artifact / 计划持久化（Workflow Store）：属 ③ 范围；`planId` / `planVersion` 只是可空指针。
- 审批 SLA 驱动任务终态：属 ④ 范围；审批等待期只受 Task `deadlineMs` 约束，审批记录本身不能触发 `timed_out` / `recovery`。
- Token / Run 总预算：当前不存在；本阶段只做 `timed_out` / `recovery` 迁移边合法化。
- 多进程 Worker / 分布式队列：仍为单写者原子文件；启用前需事务型 Store 或文件锁。
