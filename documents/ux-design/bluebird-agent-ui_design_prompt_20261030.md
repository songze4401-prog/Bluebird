# Bluebird Agent UI — Implementation Prompt

Use this prompt after the design direction is approved. It is intentionally scoped to the mobile frontend and does not authorize backend, model-routing or persistence changes.

---

## Role

You are implementing the approved **Quiet Instrument** design for Bluebird, an Expo + React Native + TypeScript mobile AI agent. Preserve all existing business behavior and API contracts. Do not add dependencies, custom fonts, external UI kits, gradients, glow effects, avatars or bubble chat styling.

Read first:

- `documents/designs/bluebird-agent-ui_design_system.md`
- `documents/ux-design/bluebird-agent-ui_prd.md`
- `theme.ts`, `lib/design.ts`, `App.tsx`, `components/MessageList.tsx`, `components/ChatBubble.tsx`, `components/ChatInput.tsx`, `components/ToolCallPill.tsx`, `components/HistoryScreen.tsx`, `components/SettingsDrawer.tsx`

## Design tokens

Implement a dark-first token extension in `theme.ts` while preserving the existing `ThemeMode`, `ThemeId`, `MODE_PALETTES` and `THEMES` API used by current components.

```ts
// add to the theme surface; names are illustrative, keep current keys intact
canvas: '#08090B'
canvasRaised: '#0D0F13'
surface: '#12151A'
surfaceHover: '#171B21'
line: 'rgba(255,255,255,0.065)'
lineStrong: 'rgba(255,255,255,0.12)'
textPrimary: '#F2F3F5'
textSecondary: '#A3A8B2'
textTertiary: '#6C727D'
textQuiet: '#4A505A'
accent: '#7E9BFF'
accentPressed: '#6B87E8'
accentSoft: 'rgba(126,155,255,0.12)'
success: '#6FCF97'
warning: '#D6B77A'
danger: '#E07A7A'
codeBg: '#0A0C10'
scrim: 'rgba(0,0,0,0.62)'
```

Default the dark direction to the `blue` accent. Preserve all seven accent options; the other accents should derive the same semantic roles. Do not modify the backend theme API.

Type scale:

```ts
display: 30, displayLine: 36
title: 22, titleLine: 28
body: 16, bodyLine: 26
bodyCompact: 15, bodyCompactLine: 24
label: 13, labelLine: 18
meta: 11, metaLine: 16
micro: 10.5, microLine: 14
code: 13, codeLine: 20
```

Use the system font stack only. No font files.

## Tasks

### 1. Top bar and navigation

Create/replace `ChatTopBar`:

- 52 px content height, 20 px horizontal gutter.
- left menu button 44×44 with an 18 px three-line mark;
- center/left `Bluebird` wordmark, optional 13 px session title;
- right 44×44 new-chat and more/history buttons;
- no avatar, presence dot or decorative border.

Move tasks/memory access into the drawer instead of the chat bottom tab bar. Keep `TasksPanel` and `MemoryScreen` reachable. If product rejects removing tabs, retain a 44 px text-only hairline bar; do not restore raised tab cards.

### 2. Empty state

Replace `HomeScreen` visual content with:

- `PRIVATE AGENT` micro label;
- two-line 30 px “今天，想一起 / 完成什么？”;
- one 15 px explanation: “Blue 会带着你的上下文，检索、思考，并把事情做完。”;
- three hairline-separated prompt rows (52 px, icon/label/arrow);
- a compact “最近” section with at most two sessions;
- composer at the bottom.

Do not add a large logo, illustration, glow or gradient.

### 3. Composer

Refactor `ChatInput` into a controlled `Composer` with existing props:

- model line above the capsule (11 px, tertiary) + chevron;
- capsule 52 px min height, radius 28, `surface`;
- `＋` attach, multiline `TextInput` (max 6 lines), mic, send;
- attachment previews 52×52 with remove;
- while `sending`, show a stop control instead of send; the stop control must invoke a real abort path (add `AbortController` handling to `lib/stream.ts`/`hooks/useChatSession.ts` if absent; no backend change);
- input remains editable while generating but send is blocked;
- `KeyboardAvoidingView` + safe-area bottom inset; no shadow.

### 4. Transcript and Markdown

Replace bubble UI with `MessageBlock`:

- user right-aligned, max 82%, meta above, body 16/26;
- assistant full-width, who-line `BLUE · hh:mm` (11 px), body 16/26;
- no bubble background, border or tail;
- turn gap 48 px; same-speaker gap 20 px;
- markdown support: headings, paragraphs, bullets, quote, inline code, fenced code blocks with horizontal scroll and a copy action;
- keep image/sticker attachments and inline sticker handling; preserve expired states;
- use `onLongPress` for a native-feeling action sheet: copy, retry (assistant), recall (where existing semantics allow), delete local display;
- reserve space before streaming; do not use animated height that shifts content.

Do not invent a Markdown dependency. If a local lightweight renderer is needed, implement only the subset used by Bluebird and add tests for nested code/list content.

### 5. Agent run

Add `AgentRunBlock` using existing `toolSteps` and live `liveToolSteps` data:

- surface `surface`, radius 18, 1 px `line`, 14–16 px padding;
- header `AGENT RUN` micro, status, elapsed;
- collapsed summary and 3 step rows; actual tool names, durations, counts;
- statuses `running | completed | failed | skipped | needs_confirmation`;
- completed run collapses after 2s but reserves height;
- “展开详情” opens `AgentDetailSheet`;
- no empty block when no tools ran.

`AgentDetailSheet`:

- bottom sheet radius 28, scrim, handle;
- timeline: 思考 / 检索记忆 / 读取上下文 / 受控写入;
- expandable code blocks for arguments/results;
- write tools show “等待确认” or “未写入”; no false success;
- failed step remains visible; stop only while running;
- Android back and focus return.

### 6. History

Restyle `HistoryScreen`:

- large 30 px “对话” title, 44 px search field;
- groups 今天 / 昨天 / 更早; 64 px rows with title, preview, time, more;
- no card backgrounds;
- swipe-left delete, long-press rename/delete, destructive confirmation;
- explicit empty/search-empty states;
- preserve `useSessionList` / `useSessionActions`; do not fetch a second session list.

### 7. Settings

Create `SettingsScreen` (can reuse existing modal shell) with sections:

`模型与上下文`, `Agent`, `记忆`, `人格`, `数据与隐私`.

- 56 px rows, hairline separators, value right-aligned;
- toggles only for real existing capabilities; otherwise read-only status;
- Agent tools page lists actual registered tools, read/write boundary, max rounds, timeout, image-request behavior; never show a weather tool as available;
- destructive actions use red text + confirmation sheet;
- preserve current `ModelScreen`, `ControlPanelScreen`, `MemoryScreen` API calls and data hooks; link to them rather than reimplementing their fetch logic.

### 8. Motion

- press 120 ms ease-out;
- status fade 160–180 ms;
- sheet 240 ms `cubic-bezier(.22,1,.36,1)`;
- streaming caret 1 s linear;
- auto-scroll only within 80 px of bottom; otherwise show “回到最新”;
- respect `AccessibilityInfo.isReduceMotionEnabled`.

## Engineering constraints

- Expo SDK 57, React Native, TypeScript; no new dependencies, fonts or icon packages.
- Use `SafeAreaView`/`useSafeAreaInsets`, `KeyboardAvoidingView`, `FlatList`, `Pressable`, `Animated` already available.
- Keep `MessageList` scroll-follow state machine; adapt it, don't regress user reading position.
- Keep `lib/api` endpoints and server contracts untouched.
- Keep all existing features accessible: history, tasks, memory, model providers, persona, theme, attachments, stickers, streaming, continuity, recall.
- Add tests for new pure rendering logic (Markdown subset, tool status labels, stop state), and run `npm test`, `npm run test:unit -- --ci`, `npx tsc --noEmit`, `npm run lint`.
- Do not modify `server/` or `server/data/`.
- Do not add telemetry, analytics or external network calls.

## Definition of done

1. The six high-fidelity screens can be produced from real components (empty, conversation/streaming, Agent detail, history, settings, Agent tools).
2. No bubbles, avatars, gradients or decorative glows remain in the redesigned surfaces.
3. Streaming and stop behave without layout jumps; keyboard/safe area verified on small and large phones.
4. Agent statuses are truthful and tool details are inspectable.
5. Existing APIs and all existing feature entries remain reachable.
6. Tests, tsc and lint pass; report actual commands and output.
