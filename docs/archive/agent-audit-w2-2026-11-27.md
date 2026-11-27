# W2 完成校验验收基线

> W3 委派写入后的复测见 [`agent-audit-w3-2026-11-27.md`](agent-audit-w3-2026-11-27.md)：E 10/10，完整 A–F 35/38。

- 日期：2026-11-27
- 基线：W1 `b68fa33` + W2 工作树
- 命令：`npm run audit:agent -- --run --out audit-agent-e2e.json`
- 模型：`deepseek/deepseek-chat`（真实调用）
- 结果：两次真实 A–F 运行分别为 **31/34** 与 **29/34**（exit 1）。核心 W2 检查稳定：A 8/8、F2 触发完成校验、零工具假成功单测通过；F 最终汇总和 D 删除检测受模型随机性影响，B/E 仍未解决。

## W2 生效证据

- **A：8/8 通过**。写入指令不再被读回正则误判；成功写入的回复保留，A5 的显式“核对内容”仍触发读回。
- **F：31/34 那次最终汇总通过**。第 13 步 `+M` 已执行，最终回复逐项列出 1–15 步；另一次运行 F5 仍只回“工作区 . 共 12 项”，说明最终汇总还依赖模型，W4 的 step ledger 才能稳定。
- F2：工具实际成功但回复称“没拿到回执”时，`Claim Guard` 触发 `failure_claim/tool_success` 重写；重写仍不一致时，交付前追加 `【服务端完成校验】`，不再落假声明。
- 零工具假成功：`detectClaimMismatch(reply, [])` 返回 `success_claim/no_receipt`；`reconcileClaim` 无重试时直接返回完成校验，不保留“已创建”假话。
- 混合工具轮：只调了 `memory_search` 却声称文件已创建，也会判 `no_receipt`，不会因为“有 toolSteps”就放过。
- 单测：`agent-continuity-audit` 11 项全通过（3 W1 + 8 W2）；`agent-tools` 199 项全通过。

## 仍失败（下一阶段）

1. `B/resume reports 3/3 or explicit pending` — 重启后最终回复只有“已创建 b-step3.txt”，没有汇总；文件本身齐全。属于 W4 的长任务交付/step ledger。
2. `E/task completed` / `E/file created` — executor 写入仍被 `confirmation_required` 拒绝，任务 recovery；W3。
3. `F/final summary` 与 `D/deletion detected` 在部分真实运行中仍受模型随机性影响：F 可能退回工具摘要，D 可能只拿到“共 N 项”的列表摘要而不敢确认删除。前者归 W4，后者归 W1 回执/工具摘要增强。

## 结论

W2 解决了“有声明就必须有回执”和“零工具不能假成功”，A 的读回误报已消除，F2 不再把成功回执说成失败。B 的汇总质量、E 的委派写入、F/D 的稳定性不是 W2 范围，留给 W3/W4 和 W1 增强。
