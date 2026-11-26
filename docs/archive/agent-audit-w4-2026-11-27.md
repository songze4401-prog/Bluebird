# W4 长任务状态机验收基线

- 日期：2026-11-27
- 基线：W3 `4b23cc2` + W4 工作树
- 命令：`npm run audit:agent -- --run --out audit-agent-e2e.json`
- 模型：`deepseek/deepseek-chat`（真实调用）
- 结果：**38/38 checks passed，0 failed（exit 0）**

## W4 生效证据

- 新增 `server/agent-ledger.js`：只对明确的“第N步 / 步骤N / N.”编号建账；没有编号的 A/C/D/E 不建账，行为不变。
- B：步骤1/2/3 在重启前后均被登记并绑定回执；服务重启后账本文件仍在，最终回复逐项列出三个文件状态。B 5/5。
- F：15 步全部登记；工具回执按“步骤编号 + 工具动作语义”绑定（同路径的读/写不会互抢）；第 8 步读取失败保留 `workspace_not_found`，第 9 步恢复创建成功。
- 最终汇总轮若仍有 pending 执行步骤，服务端强制对应工具补齐；F5 曾只列目录而漏掉第 13 步，W4 后强制 `workspace_write` 完成 `+M`，15 步文件全部符合预期。
- 最终回复若退化成“已读取 4 字节 / 工作区 . 共 12 项”，由服务端替换为 `【长任务交付清单】`：完成/未完成/失败、逐步证据、下一步。
- 连续两轮无新回执触发 `stalled` 标记；注入块明确“存在未完成步骤时禁止声称全部完成”。
- 单测：`agent-ledger` 8 项全通过（解析、绑定、注入、停滞、交付清单、强制补齐、开关）。

## 回滚

`BLUEBIRD_TASK_LEDGER=0` 关闭：不建账、不注入账本块、不生成交付清单；A–F 回到 W3 行为（B/F 汇总会再次退化）。账本独立存 `server/data/agent-ledgers.json`，不改写 `sessions.json` 契约。
