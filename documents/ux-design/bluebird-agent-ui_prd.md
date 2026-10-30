# Bluebird Agent UI — MVP PRD

**Status:** Design-ready; frontend implementation in `qoder/ui-finalization`
**Platform:** Expo SDK 58 / React Native / TypeScript
**Baseline:** `bfaea5e` (main)
**Design system:** `documents/designs/bluebird-agent-ui_design_system.md`

---

## 1. Product frame

Bluebird is a private, persistent AI agent. Unlike a generic chat app, it combines:

- a memory library with explicit provenance and lifecycle;
- Agent tool execution (`memory_search`, `memory_remember`);
- multi-session history;
- selectable model providers and a default model;
- persona controls;
- streaming output, attachments, stickers, tasks, presence and backup.

The redesign must make the agent feel **calm, capable and trustworthy**, not like a dressed-up messaging app.

### Non-goals for this design pass

- No backend or API changes.
- No model routing changes.
- No new dependency, font, animation library or icon package.
- No removal of tasks, memory, persona, model, theme, attachments or history features.
- No fake capability: stop generation, Markdown rendering, long-press actions and live Agent-tool toggles are frontend implementation tasks unless already supported.

---

## 2. Target users and jobs

**Primary user:** a single technical founder/builder using Bluebird daily on a phone for research, planning, memory recall and small agent tasks.

Jobs:

1. “Ask one question and read a long, well-formatted answer without visual clutter.”
2. “See what the Agent is doing without losing the answer.”
3. “Find an older conversation in seconds.”
4. “Know what Bluebird remembers, which model is active, and what tools are allowed.”
5. “Stop an answer or a tool run without losing control of the session.”

---

## 3. Experience principles

1. **Answer first** — the assistant answer owns the reading column; execution is secondary.
2. **Truthful state** — running, completed, failed, skipped and waiting-for-confirmation are distinct.
3. **Low-chrome navigation** — menu, history, settings and Agent controls live behind one predictable drawer/page structure.
4. **Stable streaming** — no layout jumps, no bubble resizing, no scroll hijack.
5. **Mobile-native** — safe area, keyboard, long press, sheet gestures and 44 px targets are first-class.

---

## 4. Screen specifications

### 4.1 Empty chat / home

**Goal:** start a meaningful task in one tap.

- Top bar: menu, Bluebird wordmark, new-chat plus.
- Hero: `PRIVATE AGENT` micro label, 30 px two-line question, one sentence of explanation.
- Three prompt rows (hairline separated): e.g. “把今天的任务理一遍”, “继续评估 Bluebird”, “生成本周简报”.
- Recent conversations: one or two rows, not a full history block.
- Composer: model line, multiline input, attach, mic, send.
- No avatars, no glow, no large illustration.

**States:** default, empty recent list, model not yet loaded (omit model line), upload in progress (attachment placeholder).

### 4.2 Conversation / streaming

**Goal:** read a long answer while understanding the Agent’s work.

- Top bar with session title and more.
- Transcript without bubbles:
  - user: right-aligned meta + body, max 82%;
  - assistant: full-width who-line + Markdown body.
- Agent run block above the answer:
  - running status, elapsed, three steps;
  - completed steps show duration/count;
  - failed step remains visible;
  - collapsed after completion; details in a sheet.
- Streaming: caret, fixed line box, stop button; auto-scroll only when near bottom.
- Code blocks have copy action; long text remains readable at 360 px width.

**States:** normal, streaming, stopped, error bubble, retry available, no-tools, tool failure, needs-confirmation.

### 4.3 Agent detail sheet

**Goal:** inspect execution without leaving the conversation.

- Bottom sheet with title/elapsed and a timeline.
- Each step shows actual tool id, status, duration and result count.
- Arguments and results are collapsed code blocks; write attempts show “等待确认” or “未写入”.
- Stop is available only while running; failed steps cannot be dismissed silently.
- Closing returns focus to the original message; sheet gesture and Android back work.

### 4.4 History

**Goal:** find, resume and manage sessions.

- Large “对话” title, search field, grouped rows (今天/昨天/更早).
- Rows show title, preview, updated time and a more action.
- Search filters title/preview; no result state is explicit.
- Swipe-left delete; long-press rename/delete; destructive confirmation.
- New chat from top-right; no card backgrounds.

### 4.5 Settings

**Goal:** make model, Agent, memory, persona and privacy understandable without hidden magic.

Sections and rows:

| Section | Rows |
|---|---|
| 模型与上下文 | 默认模型, 上下文预算, 流式输出 |
| Agent | 工具调用状态, Agent 工具, 最大轮数 |
| 记忆 | 长期记忆, 待确认记忆, 管理记忆 |
| 人格 | 控制面板 (口语化/温暖/主动/长度/连续消息) |
| 数据与隐私 | 备份状态, 导出, 清除当前会话 |

- Values are right-aligned tertiary text.
- Toggles only where a real frontend/server capability exists; otherwise show read-only status and an explanatory hint.
- Agent tools page lists actual registered tools, read/write boundaries, image-request behavior, timeout and max rounds. No fake weather tool.

### 4.6 Navigation

- Top-left menu opens a full-height drawer: 历史对话, 任务, 记忆, 模型, Agent 工具, 设置, 返回主页.
- Existing `TasksPanel` and `MemoryScreen` remain reachable; bottom tabs may be removed from chat to protect the composer.
- If bottom tabs are retained, use a 44 px text-only bar with hairline; no elevated panel.

---

## 5. Functional map and implementation gaps

| Requirement | Current code | Design status |
|---|---|---|
| Send / stream | `hooks/useChatSession`, `lib/stream.ts` | style and state redesign only |
| Stop generation | no user abort control found in current hook/stream | **frontend gap**; add abort controller and stop UI |
| Agent tool steps | `ToolCallPill`, `toolSteps`, SSE `tool_start/tool_end` | map to `AgentRunBlock` |
| Markdown/code blocks | current body is plain text | **frontend gap**; add lightweight renderer, no backend change |
| Long-press message actions | not present in current bubble API | **frontend gap**; add `onLongPress` + action sheet |
| History search/delete | history list and delete exist; search not verified | design includes both; add search if missing |
| Model management | `ModelScreen` `/model-providers` | restyle only |
| Memory management | `MemoryScreen` `/memory` | restyle only |
| Persona | `ControlPanelScreen` `/persona` | restyle only |
| Agent tools config | env switch + server capability; no live UI API verified | read-only page recommended; do not fake toggle |
| Attachments/stickers | `useAttachments`, upload routes | keep previews and existing routes |
| Themes | `theme.ts` 7 accents | dark-first token extension; preserve light mapping |

No API contract is changed by this design.

---

## 6. Acceptance criteria

**Visual**

- [ ] Chat page uses no bubbles, no avatars, no gradient/glow.
- [ ] Only composer and Agent run use elevated surfaces; all other separation is hairline/spacing.
- [ ] Text hierarchy matches the type scale; body never below 15 px.
- [ ] Status is icon + label + color, never color alone.
- [ ] Dark and light token mappings are both defined.

**Interaction**

- [ ] Send, stop, retry, copy, long-press, sheet, search and back all have visible feedback.
- [ ] Keyboard never covers composer; safe areas respected on iOS and Android.
- [ ] Streaming does not jump; manual scroll is not hijacked.
- [ ] Agent detail opens/closes without losing scroll position.
- [ ] Destructive actions require confirmation.

**Engineering**

- [ ] No new dependency for the visual pass.
- [ ] Existing `/chat`, `/chat/stream`, `/sessions`, `/memory`, `/model-providers`, `/persona` contracts unchanged.
- [ ] `MessageList`, `ChatBubble`, `ChatInput`, `ToolCallPill` remain the integration points or are replaced with equivalent props.
- [ ] Tests for message transforms, streaming and tool state remain green.
- [ ] TypeScript and lint pass.

---

## 7. Success signals (post-implementation)

- Time to first sent prompt on empty state.
- Scroll jank during streaming (manual QA / frame timing).
- Agent detail open rate vs answer abandonment.
- Search success rate in history.
- User can explain what tools ran after closing a conversation.
- No increase in accidental destructive actions.

These are UX signals, not backend metrics; no telemetry is added by this design.
