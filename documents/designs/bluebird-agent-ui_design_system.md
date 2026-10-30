# Bluebird Agent UI — Design System 01

**Direction:** Quiet Instrument / 安静的仪器
**Mode:** Dark-first, mobile-first
**Date:** 2026-10-30
**Product:** Bluebird — private memory + Agent tools + multi-provider chat
**Status:** Design direction and high-fidelity board; implementation landed in the `qoder/ui-finalization` frontend pass

---

## 1. Design intent

Bluebird should feel like a precise instrument, not a chat toy.

The interface is quiet before, during, and after an Agent run. The conversation remains the primary surface; execution details are available but never compete with the answer. The user should feel that Bluebird remembers, reasons, and acts with restraint.

**Three principles**

1. **Content over chrome** — remove gradients, glows, avatar furniture, bubble edges, and ornamental cards. One accent color, used only for state and action.
2. **One continuous surface** — transcript, Agent run, composer, and navigation share the same black field. Separation comes from spacing and hairlines, not stacked containers.
3. **Show work, not theatre** — Agent status is factual: running, completed, failed, skipped, waiting for confirmation. No fake progress or decorative animation.

**What we deliberately keep from the references**

- oversized whitespace and editorial typography
- thin-line, monochrome icon language
- floating, pill-shaped composer
- full-screen drawers and focused settings pages
- absence of traditional chat avatars and bubble tails

**What we do not copy**

- ChatGPT/Grok brand marks, copy, exact layouts, or light surfaces
- blue “AI gradient” clichés
- noisy glass/blur effects that are expensive or unreliable in React Native

---

## 2. Color

### 2.1 Dark palette (default)

| Token | Value | Usage |
|---|---|---|
| `canvas` | `#08090B` | app background, transcript field |
| `canvasRaised` | `#0D0F13` | navigation underlay, sheet base |
| `surface` | `#12151A` | composer, Agent run block, search field |
| `surfaceHover` | `#171B21` | pressed / selected row |
| `line` | `rgba(255,255,255,0.065)` | hairlines, separators |
| `lineStrong` | `rgba(255,255,255,0.12)` | focused input, sheet handle |
| `textPrimary` | `#F2F3F5` | headings, assistant body |
| `textSecondary` | `#A3A8B2` | secondary copy, values |
| `textTertiary` | `#6C727D` | meta, placeholders |
| `textQuiet` | `#4A505A` | disabled, timestamps |
| `accent` | `#7E9BFF` | active state, links, running status |
| `accentPressed` | `#6B87E8` | pressed accent |
| `accentSoft` | `rgba(126,155,255,0.12)` | subtle active fill |
| `success` | `#6FCF97` | completed tool step |
| `warning` | `#D6B77A` | waiting / needs confirmation |
| `danger` | `#E07A7A` | destructive text, failure |
| `codeBg` | `#0A0C10` | code block background |
| `scrim` | `rgba(0,0,0,0.62)` | sheets and drawers |

**Rules**

- Accent is never a background for large areas. It appears as text, a 2–6 px marker, a switch, or a single send/stop control.
- Status is never communicated by color alone; pair it with a label and an icon/shape.
- No more than one elevated surface per viewport region. The composer and an active Agent run are the only surfaces that may sit above the canvas.
- Hairlines are 1 physical pixel (`StyleSheet.hairlineWidth` in RN), not 2–3 px borders.
- No gradients, glow blobs, neon shadows, or glass blur. If a future platform has a native material, it must not introduce a second visual language.

### 2.2 Light mode mapping

The current product supports light/dark plus seven accent colors. The new dark direction does not remove that capability.

| Dark token | Light equivalent |
|---|---|
| `canvas` | `#F7F7F5` |
| `canvasRaised` | `#FFFFFF` |
| `surface` | `#FFFFFF` |
| `surfaceHover` | `#F0F1F3` |
| `line` | `rgba(16,18,22,0.08)` |
| `textPrimary` | `#16181C` |
| `textSecondary` | `#656B75` |
| `textTertiary` | `#8C929C` |
| `accent` | `#2856C9` |
| `accentSoft` | `rgba(40,86,201,0.08)` |

Light mode is a derivation, not a separate design. The chat page remains bubble-free and uses the same spacing.

---

## 3. Typography

Use the platform system font; do not add a custom font dependency in this phase.

```css
font-family: -apple-system, BlinkMacSystemFont, "SF Pro Text",
             "PingFang SC", "Roboto", "Noto Sans CJK SC", sans-serif;
```

| Style | Size / line | Weight | Usage |
|---|---|---|---|
| Display | 30 / 36, `-0.6` tracking | 600 | home prompt, page titles |
| Title | 22 / 28 | 600 | conversation title, sheet title |
| Body | 16 / 26 | 400 | assistant messages |
| Body compact | 15 / 24 | 400 | settings descriptions, user messages |
| Label | 13 / 18 | 500 | row labels, tool names |
| Meta | 11 / 16, `0.02em` | 500 | timestamps, section labels |
| Micro | 10.5 / 14, `0.08em` | 600 | AGENT RUN / technical eyebrow |
| Code | 13 / 20 | 400 | code blocks, tool arguments |

**Rules**

- Chinese body line height must be at least 1.55×. Never set Chinese body below 14 px.
- Numeric metadata uses tabular figures where available.
- Section labels are small and quiet; they are not headings competing with content.
- Avoid all-caps English brand labels except one micro eyebrow; the product should read as Chinese-first.

---

## 4. Layout and spacing

Base unit: **4 px**.

| Token | Value | Usage |
|---|---|---|
| `gutter` | 20 px | screen horizontal padding |
| `gutterWide` | 24 px | home hero and settings |
| `statusBar` | safe area | system inset |
| `topBar` | 52 px | navigation bar |
| `composerMin` | 52 px | single-line composer |
| `row` | 56 px | settings/history row |
| `turnGap` | 48 px | next speaker turn |
| `blockGap` | 24 px | message to Agent run |
| `sectionGap` | 32 px | settings sections |
| `bottomSafe` | safe area + 12 px | home indicator clearance |

Radii: `pill=999`, `composer=28`, `runBlock=18`, `sheet=28`, `small=12`. Cards are not a default container. If a surface is needed, it must have a semantic reason (composer, Agent run, sheet).

---

## 5. Components

### 5.1 Top bar

- 52 px content height, 20 px horizontal gutter.
- Left: 44×44 menu hit target, 18 px three-line mark.
- Center/left brand: `Bluebird` at 16–17 px semibold; optional session title at 13 px below only in chat.
- Right: 44×44 new-chat icon; 44×44 more/history icon.
- No avatar, no online dot in the bar. Presence and shared time live in the drawer/settings.
- Background transparent; optional 1 px hairline only when content is scrolled underneath.

### 5.2 Home / empty state

- `PRIVATE AGENT` micro label, then a 30 px two-line question:
  “今天，想一起 / 完成什么？”
- One 15 px secondary sentence: “Blue 会带着你的上下文，检索、思考，并把事情做完。”
- Three prompt rows, not cards: 52 px height, hairline top/bottom, icon left, label, arrow right. Examples: “把今天的任务理一遍”, “继续评估 Bluebird”, “生成本周简报”.
- “最近” section with one or two conversation rows; no large history block on the empty screen.
- Composer at bottom. Model selection is a quiet pill above the composer, not a toolbar.

### 5.3 Composer

- Outer surface `surface`, radius 28, min height 52, max 6 lines before internal scroll.
- Structure: `＋` (44) · multiline input · mic (44) · send/stop (40).
- Model line above: `Bluebird · DeepSeek V3` + chevron; text 11 px, tertiary.
- Attachment previews: 52×52 thumbnails with 12 radius; remove button 20 px.
- **Generating:** send becomes a stop control (square inside a 40 px circle), label “停止” for screen readers; the input remains editable but sending is blocked.
- **Keyboard:** use `KeyboardAvoidingView` behavior `padding` on iOS and `height`/`resize` strategy on Android; composer follows safe area. Never cover the last line.
- No shadow. A single `lineStrong` hairline appears only on focus, if needed.

### 5.4 Transcript

- No bubbles. User messages are right-aligned, max 82% width, meta above, body 16/26.
- Assistant messages are full-width editorial blocks, who-line (`BLUE · 18:23`) at 11 px, body 16/26.
- Turn gap 48 px; same speaker continuation 20 px.
- Markdown: headings 20/28, bullets 16/26, blockquote with a 1 px accent line, code block `codeBg` with 12 radius and copy action.
- Code block: horizontal scroll, no syntax-color noise in v1; monospace `#DDE1E8`.
- Long press message: action sheet with 复制 / 重试 / 撤回 (where valid) / 删除本地显示. No hover-only affordances.
- Images: 12 radius, max 240 px wide; stickers inline; expired image shows quiet placeholder.

### 5.5 Agent run block

A single, quiet execution surface. It appears above the assistant answer when tools are active.

```
AGENT RUN      运行中 · 00:08        ⌄
正在综合记忆与项目上下文…
✓ 理解问题                 0.8s
◌ 检索记忆 · memory_search  3 条
· 组织回答                 等待中
2 个工具 · 展开详情
```

- Surface `surface` at 60% or `canvasRaised`; 1 px `line`; radius 18; padding 14–16.
- Header: 10.5 px micro label, status, elapsed; no large icon.
- Default collapsed height ~112–132 px. Completed runs collapse to one summary line after 2 seconds; the answer must not shift because the block reserves its final height.
- Status: `running` accent pulse (opacity only), `completed` success, `failed` danger, `needs_confirmation` warning, `skipped` tertiary.
- Tool steps: 32 px rows, name + actual tool id + count/duration. No fake percentage.
- Details are a bottom sheet, not inline expansion on the chat page; this keeps reading width stable.
- If no tools ran, render nothing. Never show an empty “Agent” block.

### 5.6 Agent detail sheet

- Bottom sheet, radius 28 top, scrim `0.62`, handle 36×4.
- Title “Agent 执行”, elapsed, close.
- Timeline rows: 思考, 检索记忆, 读取上下文, 受控写入. Each row has a stable status and, when expanded, a code block for arguments/results.
- Write tools show “等待你的确认” or “未写入” explicitly; never claim success before persistence.
- Footer: 停止执行 (only while running) / 关闭; no fake share/export.
- A failed step stays visible; it is not collapsed into a generic “something went wrong”.

### 5.7 History

- Full-screen page; large 30 px title “对话”.
- 44 px search field, `surface`, radius 22; leading search icon.
- Group labels: 今天 / 昨天 / 更早. Rows 64 px, title 15/20, preview 12/18, time right; trailing `…`.
- No card backgrounds, no thumbnails. Hairline separators only.
- Swipe left reveals 删除; long press also exposes 重命名 / 删除 / 取消. Confirmation for destructive actions.
- Empty state: one sentence + “开始新对话” text action; no illustration.

### 5.8 Settings

- Full-screen page, large title, back/close.
- `profile` row: name + “个人空间 · 本机” + chevron; no avatar image, optional 32 px monogram.
- Sections: 模型与上下文, Agent, 记忆, 人格, 数据与隐私.
- Rows: 56 px, label 14–15, value 13 tertiary, chevron; separators inset 20 px.
- Toggles are 44×26 with 22 px knob, accent when on. No green “success” switches.
- Destructive action is red text, not a filled red block; it requires an explicit confirmation sheet.
- Agent tools page is informational first: current enablement, registered tools, read/write boundaries, max rounds, timeout, image-request behavior. Do not show a toggle that the server cannot honor.

### 5.9 Navigation

- The current bottom tab bar is removed from the chat surface.
- The top-left menu opens a full-height navigation drawer:
  - 历史对话
  - 任务
  - 记忆
  - 模型
  - Agent 工具
  - 设置
  - 返回主页
- All existing features remain reachable; only the visual priority changes. If product decides to retain bottom tabs, keep a 44 px hairline bar with text-only labels and no raised background.
- Drawer uses the same canvas, no card stack, 20 px gutter, 52 px rows.

---

## 6. Motion

| Interaction | Duration | Easing |
|---|---|---|
| Press opacity | 120 ms | ease-out |
| Row selection | 160 ms | ease-out |
| Agent status fade | 180 ms | ease-out |
| Sheet present/dismiss | 240 ms | cubic-bezier(.22,1,.36,1) |
| Streaming cursor | 1 s blink | linear |
| Sending → stop | 160 ms | ease-out |

- Streaming text appends without changing the line box; reserve the caret width.
- Auto-scroll only when the user is within 80 px of the bottom. If the user scrolled up, show a “回到最新” pill instead of yanking them down.
- Agent status pulse changes opacity only, never scale or glow.
- Respect `prefers-reduced-motion` / RN `AccessibilityInfo.isReduceMotionEnabled`; disable pulse and sheet spring.

---

## 7. Accessibility and mobile constraints

- Minimum touch target 44×44; row hit areas include the full row.
- Body text contrast target ≥ 7:1 on `canvas`; secondary ≥ 4.5:1.
- Status uses icon + text + color; no color-only meaning.
- Dynamic type: allow 1.2×; use `numberOfLines` only for metadata, never for assistant body.
- Screen reader labels for menu, new chat, history, send/stop, copy, expand Agent run, tool status.
- Safe areas: top status bar and bottom home indicator; Android navigation bar contrast.
- Keyboard: composer stays above keyboard; transcript scroll insets adjust. Test small phones (360×640), standard (393×852), large (430×932).
- No web-only hover, glass, or right-click interactions.
- No new dependency is required for this visual direction. Use RN `View`/`Text`/`Pressable`/`Animated` and the existing `expo-image` for images.
- Markdown rendering and stop-generation are implementation tasks, not assumed existing behavior. Current chat content is plain text; a lightweight renderer and stream abort path must be added in the frontend phase without changing the API contract.

---

## 8. Mapping to the current codebase

| Current | New design |
|---|---|
| `components/HomeScreen.tsx` | `HomeScreen` becomes the quiet hero + prompt rows |
| `components/ChatHeader.tsx` | `ChatTopBar` with menu, session title, new chat/more |
| `components/MessageList.tsx` + `ChatBubble.tsx` | `Transcript` / `MessageBlock` (no bubbles, Markdown) |
| `components/ToolCallPill.tsx` | `AgentRunBlock` + `ToolStepRow` + `AgentDetailSheet` |
| `components/ChatInput.tsx` | `Composer` with model line, attachments, stop state |
| `components/HistoryScreen.tsx` | grouped history list with search and actions |
| `components/SettingsDrawer.tsx` | navigation drawer + `SettingsScreen` |
| `components/ControlPanelScreen.tsx` | settings section “人格” with same API |
| `components/MemoryScreen.tsx` | settings section “记忆” / full-screen memory list |
| `components/ModelScreen.tsx` | settings section “模型与上下文” |
| `components/BottomTabBar.tsx` | remove from chat; tasks/memory remain in drawer |

The design does not change `/chat`, `/chat/stream`, `/sessions`, `/memory`, `/model-providers`, `/persona`, `/presence` contracts. No backend or business logic change is part of this design pass.

---

## 9. Do / Don't

**Do**

- let one sentence carry a screen
- use a single accent and one semantic status color at a time
- keep Agent details one tap away
- reserve space before streaming starts
- use real tool names/statuses and honest write states

**Don't**

- put avatars or large brand marks on every message
- use bubble tails, thick cards, drop shadows, neon glows
- add a gradient because a screen feels empty
- animate a spinner around every word
- show a toggle for a server capability that does not exist
- hide a failed tool step behind a generic success summary


---

## 10. Deliverables in this pass

- Design system: `documents/designs/bluebird-agent-ui_design_system.md`
- PRD: `documents/ux-design/bluebird-agent-ui_prd.md`
- Implementation prompt: `documents/ux-design/bluebird-agent-ui_design_prompt_20261030.md`
- Interactive board: `documents/ux-design/bluebird-agent-ui_board.html`
- Screen exports: `documents/ux-design/screens/01-home.png` … `08-navigation.png`

No application source, backend API, database or server data was modified in this design pass.
