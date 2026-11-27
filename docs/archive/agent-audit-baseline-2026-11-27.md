# W0 Agent 审计回归基线

> W1 执行账本落地后的复测见 [`agent-audit-w1-2026-11-27.md`](agent-audit-w1-2026-11-27.md)：30/34。

- 日期：2026-11-27
- 基线：`main @ 9c5a370`
- 模型：`deepseek/deepseek-chat`（真实调用）
- 命令：

```bash
npm run audit:agent -- --run --out audit-agent-e2e.json
```

- 数据：临时 `BLUEBIRD_DATA_DIR` / workspace；不读写 `server/data`
- 结果：**26/33 checks passed，7 failed（exit 1）**
- 失败项：

1. `A/success confirmation not replaced by readback guard` — 写入成功，但回复仍被替换为“本轮未调用读取/核对工具”。
2. `B/resume reports 3/3 or explicit pending` — 重启后最终回复只有“已创建 b-step3.txt”，没有 3/3 或待办说明。
3. `E/task completed` — executor 写入任务进入 `recovery/recovery_uncertain_side_effects`。
4. `E/file created` — `e-agent.txt` 不存在。
5. `F/f07 G` — 第 7 步未创建。
6. `F/f08 H` — 第 9 步未创建。
7. `F/final summary covers 15 steps` — 最终回复只有“已读取 4 字节”。

## 说明

- 该脚本是**红基线**：预期失败，直到 W1/W2/W3/W4 完成对应修复。不要为了让 CI 变绿而放宽检查。
- 真实模型有随机性：本轮 B2 实际调用了 `workspace_write` 并创建了文件，因此 B 的文件检查通过；B2 的“零工具假成功”由 `tests/agent-continuity-audit.test.js` 的 todo 用例做确定性追踪。
- `tests/agent-continuity-audit.test.js` 中的三个 todo 是 W2 的验收目标；转绿时把 todo 改成真实断言。
- 缺 `DEEPSEEK_API_KEY` 时脚本 exit 2，不伪造通过；普通 CI 不跑该脚本。
