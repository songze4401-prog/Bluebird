# W3 委派写入验收基线

- 日期：2026-11-27
- 基线：W2 `07b634e` + W3 工作树
- 命令：`npm run audit:agent -- --run --out audit-agent-e2e.json`
- 模型：`deepseek/deepseek-chat`（真实调用）
- 结果：**E 10/10 通过**；完整 A–F **36/38**（仅 B 汇总、F 最终汇总仍受模型随机性影响）

## W3 生效证据

- `delegate_to_bot` 创建写入型任务后，任务停在 `waiting_approval`，返回 `approvalRequired=true` 与 `approvalId`；模型回复明确“等你批准后才写”。
- `GET /agents/executor/approvals?status=pending` 能看到 `workspace.write` 审批，payload 只含 `producerTaskId/taskType/maxBytes`，不含文件正文。
- `POST /agent-approvals/:id/approve` + `POST /agent-approvals/:id/execute` 后：
  - 任务进入 `running`，`writeApproved=true`，`writeApprovalId` 与 `writeApprovalScope` 落库；
  - 审批状态 `completed`，`decision=write_authorized`；
  - Worker 真实写入 `e-agent.txt`，任务最终 `completed`，结果投递回父会话。
- 未授权时 `workspace_write` 仍被 `confirmation_required` 拒绝；授权后超出 `maxBytes` 返回 `write_scope_exceeded`。
- 任务级审批通过后不再二次抬独立审校（审批本身是人工高风险门），确定性验证仍保留，避免 60s deadline 内再等 reviewer 导致 recovery。
- 单测：`agent-write-approval` 5 项全通过（判定、审批执行、拒绝、未授权拒绝、授权写入/scope）。

## 仍失败/边界

1. B：重启后最终回复仍可能只有“已创建 b-step3.txt”，汇总质量属 W4。
2. F：最终回复仍可能退化为工具摘要；W4 step ledger/交付校验。
3. 审批等待仍受 Task deadline（默认 60s）约束；真实 UI 需要在 deadline 内批准，后续可把写入审批等待窗口独立出来。

## 依赖基线

W3 新增两条惰性 require 边，`scripts/scc-baseline.json` 已用 `--write` 再生：

- `server/agents/approvals.js -> server/agents/runtime.js`：审批执行必须先写 `writeApproved`，再把 Worker 从 waiting_approval 放回 running；不能把 runtime 注入审批存储（会把执行入口带进持久层）。
- `server/agents/router.js -> server/agents/approvals.js`：写入审批必须在 dispatch 创建任务后、startTask 之前创建；把这一步移到外层会绕过其它 dispatch 调用方。

SCC 成员仍为 46，无新增成员；只新增两条惰性边（29→31）。模块/边计数按当前 server 树再生（含 W1 新增的 `server/turn-receipts.js`）。

## 结论

W3 把“executor 写入必然 60s recovery”改成“先建任务级审批，批准后真实执行并完成”。未授权仍是 fail-closed；授权后仍有工作区沙箱、扩展名白名单、字节上限和确定性验证。
