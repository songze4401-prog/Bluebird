# W1 执行账本验收基线

- 日期：2026-11-27
- 基线：`main @ 9c5a370` + W1 分支
- 命令：`npm run audit:agent -- --run --out audit-agent-e2e.json`
- 模型：`deepseek/deepseek-chat`（真实调用）
- 结果：**30/34 checks passed，4 failed（exit 1）**

## W1 生效证据

- A：`history persists receiptStatus` 通过；A4 在无工具轮明确引用“覆盖回执 + sha256”，不再把上一轮总结当实时事实。
- B：`5/5` 通过。重启后模型先用 `workspace_list` 核对 b-step1/b-step2，再补 b-step3，并汇总三个文件。
- F：f01/f02/f03/f07/f08/f12 全部存在；第 8 步读取失败被记录，第 9 步恢复创建成功。相比 W0，W1 把“文件缺失”问题消掉了。
- 单测：`agent-continuity-audit` 3 个 W1 用例通过（回执块、no_tool_calls 警示、开关关闭），3 个 W2 todo 保留。

## 仍失败（下一阶段）

1. `A/success confirmation not replaced by readback guard` — 写入成功仍被读回守卫改写；W2 修正则。
2. `E/task completed` / `E/file created` — executor 写入仍被 `confirmation_required` 拒绝，任务 recovery；W3。
3. `F/final summary covers 15 steps` — 最终回复仍是工具摘要“已读取 4 字节”；W4 做交付校验/step ledger。

## 结论

W1 只解决“下一轮能不能看到真实回执”，不解决“没有回执时是否还敢假成功”（W2）、委派写入权限（W3）和长任务交付（W4）。30/34 是预期结果，不是全绿。
