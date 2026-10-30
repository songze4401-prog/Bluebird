# Bluebird Agent UI — 工程落地记录

分支：`qoder/ui-finalization`
基线：`bfaea5e`（main）
范围：前端 UI 定型 + 必要的只读 Agent 状态字段；无后端重构、无数据迁移。

## 1. 设计稿到实现

| 设计稿 | 实现 |
|---|---|
| 01 空白对话 | `components/ChatWelcome.tsx` 合并进聊天首屏，不再有独立主页路由 |
| 02 正常对话 / 流式 / Agent 执行 | `ChatBubble`、`MarkdownMessage`、`AgentRunBlock`、`ChatInput` |
| 03 Agent 执行详情 | `AgentRunBlock` 内底部 Sheet，展示真实 `toolSteps` 摘要 |
| 04 历史 | `HistoryScreen` 分组、搜索、长按/更多操作 |
| 05 设置 | `SettingsScreen` 分区与只读状态 |
| 06 Agent 工具边界 | `AgentToolsScreen` 读取 `/agent-policy` 的 runtime + availableTools |
| 07 数据与隐私 | `SettingsScreen` 的“数据与隐私”分区 |
| 08 导航抽屉 | `SettingsDrawer` 卡片面板：个人空间、2×2 功能卡、Agent 主色横幅、真实最近对话、外观、底栏搜索/设置/新建 |

## 2. 本轮工程缺口

- **停止生成**：`lib/stream.ts` 新增 AbortSignal 与 `aborted` outcome；`useChatSession.stopGeneration` 中止当前请求并保留部分回复；`ChatInput` 生成中显示停止按钮。
- **Markdown**：新增无依赖的 `lib/markdown.ts` 与 `components/MarkdownMessage.tsx`；支持标题、列表、引用、fenced code、行内 code、粗体/斜体；代码块可复制。
- **消息操作**：`MessageActionSheet` 统一长按菜单，复制使用 RN Clipboard，分享使用系统 Share，收藏持久化到 AsyncStorage（本机），用户消息删除走既有 `/history/recall`，AI 消息仅本机隐藏并明确提示服务端删除未开放。
- **Agent 状态**：`GET /agent-policy` 增加只读 `runtime`（switchOn / maxRounds / timeout / 图片请求策略）；`AgentToolsScreen` 只展示，不提供可写开关。
- **导航**：聊天页移除底部标签栏；任务、记忆、模型、Agent 工具、设置、监控均保留在抽屉/设置页。
- **入口与首屏（2026-10-30 调整）**：删除独立主页路由，启动即新对话；原主页排版合并进 `ChatWelcome`。启动时优先复用最近一个空白会话，没有才 `POST /sessions`，已在空白对话时再点“新建”不再新增空会话。抽屉改为卡片面板，最近对话直接消费 `/sessions`，底栏搜索只过滤该列表。

## 3. 验证

- `npm test`：44 个后端文件 / 1524 项通过
- `npm run test:unit -- --ci`：15 suites / 141 tests 通过
- `npx tsc --noEmit`：通过
- `npm run lint`：通过
- `node scripts/verify-test-coverage.js`：backend 1524/1524、nodeSuite 221/221、runner 1303/1303、frontend 141/141、CI 覆盖 44/44
- Expo Web export 成功；浏览器 DOM / 计算样式核对：新对话首屏、卡片抽屉、搜索过滤、深浅色切换、真实会话切换、空白会话复用。

## 4. 未接通 / 限制

- AI 消息的服务端删除未开放：目前只做本机隐藏，刷新后可能恢复。
- 上下文预算、备份/导出、历史重命名的后端入口未接入：点击显示“暂未开放/暂未接入”。
- Agent 工具页是只读状态；全局开关仍由服务端 `BLUEBIRD_AGENT_TOOLS` 控制。
- 天气工具未注册：页面明确显示“未接入/未提供”，不伪造可用能力。
- 收藏只在当前设备本地保存，不跨设备同步。
- Markdown 为展示子集，不支持完整 CommonMark/HTML；不引入 WebView 或第三方渲染器。
- 停止生成后的部分回复只保留在本机，不写入服务端历史；再次发送前不会进入模型上下文。
