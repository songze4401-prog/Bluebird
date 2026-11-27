# W6 可观测性与交付体验验收基线

- 日期：2026-11-27
- 基线：W5 `f544926` + W6 工作树
- 命令：`scripts/audit-ui-e2e.js --run`（真实 UI E2E）、`npm test`、`npm run lint`
- 结果：**UI E2E 10/10**；真实 A–F 38/38 语义不变；前端 Jest 149/149。

## W6 生效证据

- W6-1：`server/monitoring/audit-capture.js` 默认关闭；`BLUEBIRD_AUDIT_MODE=1` 后用 AES-256-GCM 加密保存 24 小时内的截断 Prompt、工具回执摘要与回复 hash。`GET /monitoring/audit/:requestId` 复用 Bearer 鉴权，只按 requestId 返回，没有列表/删除接口。
- W6-2：`claim.mismatch` 事件新增 `reply_hash`、`receipt_hash`、`match_rule`、`final_disposition`、`receipt_count`；失配对象自身带规则短码。定位 F2 类误判不再回读正文。
- W6-3：聊天消息带 `receiptStatus`，UI 显示“本轮没有工具回执 · 完成声明未核实”等确定文案；任务详情页展示 W5 的部分结果、副作用状态、已尝试写入与下一步。
- W6-4：记忆写入工具返回 `deliveryState`，服务端/前端据此显示“已生效 / 待确认 / 未被接受”；待确认时明确提示旧值可能仍被检索，确认入口沿用记忆中心。
- W6-5：`scripts/audit-ui-e2e.js --run` 启动真实后端 + Expo Web，跑通“创建 → 确认 → 读回 → 刷新历史”，并校验 Web bundle 包含回执状态与部分结果展示。结果：**10/10**。

## 真实 UI E2E 证据

- `write pending created`：写请求停在待确认，不假成功。
- `pending write confirmed`：确认端点 HTTP 200，文件真正落盘。
- `read receipt executed` + `content matches`：`workspace_read ok=true`，回复内容 UI-E2E。
- `history keeps receipts` / `history keeps receiptStatus`：历史里有 2 条带回执的 assistant 消息，状态为 `pending,executed`。
- `audit replay by requestId`：开启审计后按 requestId 拿到 2 条加密记录。
- `expo web serves app` + `web bundle shows receipt status`：真实 Expo Web 返回应用，bundle 包含回执状态与副作用状态展示代码。

## 回滚

- `BLUEBIRD_AUDIT_MODE=0`（默认）：不落审计记录，查询接口 404。
- `BLUEBIRD_TASK_LEDGER=0` / `BLUEBIRD_RECOVERY_EVIDENCE=0`：保留 W4/W5 回滚路径。
- 前端字段都是可选：旧消息无 `receiptStatus` / `memoryDelivery` 时不显示额外提示。

## 边界

UI E2E 是手动脚本，不在默认 CI gate；它验证真实服务、真实 API、真实 Expo Web bundle 与历史一致性，但不做浏览器点击回放。
