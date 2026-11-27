# W5 恢复证据保全验收基线

> W6 可观测性与交付体验见 [`agent-audit-w6-2026-11-27.md`](agent-audit-w6-2026-11-27.md)：UI E2E 10/10。

- 日期：2026-11-27
- 基线：W4 `ec578c7` + W5 工作树
- 命令：`npm run audit:agent -- --run --out audit-agent-e2e.json`
- 模型：`deepseek/deepseek-chat`（真实调用）
- 结果：**38/38 checks passed，0 failed（exit 0）**

## W5 生效证据

- `normalizeWorkerResult` 在失败/超时/recovery 时保留 `toolSteps`（含净化后的 evidence）、`evidence`、`changes`，不再交空壳。
- 新增 `sideEffectState: none/uncertain/applied` 与 `requiresReview`；recovery + 已尝试写入/副作用错误码一律按“不确定”处理，不猜已失败。
- `recovery.attemptedWrites` 只带相对路径、存在性、大小、sha256 与 `.history` 备份名，不带文件正文。
- 父会话投递新增“副作用状态 / 需要人工核对 / 已尝试写入 / 下一步”，失败不再只是错误码。
- 覆盖写备份名进入证据白名单（如 `f02.txt.20261126T...`），可据此判断旧内容是否仍可恢复。
- 单测：`agent-recovery-evidence` 6 项全通过（结果 schema、投递、任务落库、写入 hash 复核、备份白名单、开关回滚）。

## 依赖基线

新增一条惰性边 `server/agents/runtime.js -> server/tool-workspace.js`：恢复时必须用工作区自己的沙箱解析器复核写入路径，不能另写一套路径判断；注入 helper 会让工具层与恢复层实现漂移。`scripts/scc-baseline.json` 已用 `--write` 再生，SCC 成员仍为 46，惰性边 31→32。

## 回滚

`BLUEBIRD_RECOVERY_EVIDENCE=0` 关闭：结果恢复旧形状，不带 evidence/sideEffectState/recovery，投递消息回到旧版。普通回归测试固定关闭；真实 A–F 默认开启。

## 结论

W5 把“超时/恢复交空结果”改成“交已执行工具、已尝试写入路径与 hash、人工核对下一步”。W1/W2/W3/W4 的真实 A–F 38/38 保持全绿。
