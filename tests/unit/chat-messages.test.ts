/// <reference types="jest" />
// 消息变换规则（lib/chat-messages）：从 App.tsx 抽出时必须逐条等价。
//
// 这些规则同时被流式路径与非流式路径使用，一旦漂移就会出现
// 「流式分条与 done 分条不一致 → 气泡先并后分」这类难查的 UI 抖动。

import {
  applyStreamingText,
  applyToolEvent,
  buildModelNote,
  buildReplyBubbles,
  buildWelcomeMessages,
  ensureSegments,
  ensureSegmentsAll,
  mapHistoryItem,
  normalizeSegments,
  reconcileStreamDone,
  removeStreamBubble,
  toToolStepViews,
} from '../../lib/chat-messages';
import type { LiveToolStep } from '../../lib/chat-messages';
import type { Message } from '../../lib/types';

const CREATED_AT = '2026-01-01T00:00:00.000Z';

describe('normalizeSegments', () => {
  it('优先使用服务端 replies[]', () => {
    const segments = normalizeSegments({
      replies: [
        { id: 'a', content: '第一段' },
        { id: 'b', content: '第二段' },
      ],
      reply: '整体',
    });

    expect(segments).toHaveLength(2);
    expect(segments[1].content).toBe('第二段');
  });

  it('replies 里的空内容被过滤', () => {
    const segments = normalizeSegments({
      replies: [
        { id: 'a', content: '' },
        { id: 'b', content: '有效' },
      ],
    });

    expect(segments).toHaveLength(1);
    expect(segments[0].content).toBe('有效');
  });

  it('replies 全空时回退到单条 reply，id 取 assistantMessageId', () => {
    const segments = normalizeSegments({
      replies: [{ id: 'a', content: '' }],
      reply: '单段',
      assistantMessageId: 'srv-1',
    });

    expect(segments).toHaveLength(1);
    expect(segments[0]).toMatchObject({ id: 'srv-1', content: '单段' });
  });

  it('全空返回空数组（不造空气泡）', () => {
    expect(normalizeSegments({})).toEqual([]);
    expect(normalizeSegments({ reply: '' })).toEqual([]);
  });
});

describe('buildModelNote', () => {
  it('auto=false 不提示（避免误导性切换提示）', () => {
    expect(
      buildModelNote({
        auto: false,
        actual: { providerName: 'X', modelId: 'y' },
      } as never)
    ).toBeUndefined();
  });

  it('auto=true 且带 requested 时说明「所选模型不支持图片」', () => {
    const note = buildModelNote({
      auto: true,
      requested: { providerName: 'DeepSeek', modelId: 'chat' },
      actual: { providerName: 'Qwen', modelId: 'vl-max' },
    } as never);

    expect(note).toContain('所选模型 DeepSeek · chat');
    expect(note).toContain('Qwen · vl-max');
  });

  it('缺少 actual 时不提示', () => {
    expect(buildModelNote({ auto: true } as never)).toBeUndefined();
    expect(buildModelNote(undefined)).toBeUndefined();
  });
});

describe('buildReplyBubbles', () => {
  it('mood 透传，modelNote 只挂最后一格', () => {
    const { bubbles, replyMood } = buildReplyBubbles(
      {
        mood: 'happy',
        modelRoute: {
          auto: true,
          actual: { providerName: 'Qwen', modelId: 'vl' },
        },
      } as never,
      [
        { id: 'x1', content: '一' },
        { id: 'x2', content: '二' },
      ]
    );

    expect(replyMood).toBe('happy');
    expect(bubbles).toHaveLength(2);
    expect(bubbles[0].modelNote).toBeUndefined();
    expect(bubbles[1].modelNote).toBeTruthy();
    expect(bubbles.every(bubble => bubble.mood === 'happy')).toBe(true);
  });

  it('mood 缺失时兜底 calm', () => {
    const { replyMood } = buildReplyBubbles({}, [{ id: 'a', content: 'x' }]);

    expect(replyMood).toBe('calm');
  });

  it('agentNotice 只挂最后一格', () => {
    const { bubbles } = buildReplyBubbles(
      { agentNotice: '本次带图，已切换到视觉模型，工具暂不可用' } as never,
      [
        { id: 'n1', content: '一' },
        { id: 'n2', content: '二' },
      ]
    );

    expect(bubbles[0].agentNotice).toBeUndefined();
    expect(bubbles[1].agentNotice).toContain('工具暂不可用');
  });

  it('附件挂在对应分段上', () => {
    const { bubbles } = buildReplyBubbles({}, [
      {
        id: 'a',
        content: '带图',
        attachments: [{ id: 'img-1', kind: 'image', mime: 'image/png' }],
      },
    ]);

    expect(bubbles[0].attachments).toHaveLength(1);
  });
});

describe('ensureSegments / ensureSegmentsAll', () => {
  it('assistant 消息切出 segments，user 消息不切', () => {
    const assistant = ensureSegments({
      id: '1',
      role: 'assistant',
      content: '你好[sticker:abc]',
    });
    const user = ensureSegments({
      id: '2',
      role: 'user',
      content: '你好[sticker:abc]',
    });

    expect(Array.isArray(assistant.segments)).toBe(true);
    expect(assistant.segments?.length).toBeGreaterThan(0);
    expect(user.segments).toBeUndefined();
  });

  it('已有 segments 的对象原样返回（流式每个 delta 不重建历史）', () => {
    const withSegments: Message = {
      id: '3',
      role: 'assistant',
      content: 'x',
      segments: [{ type: 'text', text: 'x' }],
    };

    expect(ensureSegments(withSegments)).toBe(withSegments);
  });

  it('批量版本只处理 assistant', () => {
    const all = ensureSegmentsAll([
      { id: '1', role: 'assistant', content: 'a' },
      { id: '2', role: 'user', content: 'b' },
    ]);

    expect(Array.isArray(all[0].segments)).toBe(true);
    expect(all[1].segments).toBeUndefined();
  });
});

describe('buildWelcomeMessages', () => {
  it('单条固定欢迎语（不落盘、不进上下文）', () => {
    const welcome = buildWelcomeMessages();

    expect(welcome).toHaveLength(1);
    expect(welcome[0]).toMatchObject({ id: 'welcome-1', content: '我在' });
  });
});

describe('mapHistoryItem', () => {
  it('无 id 时用 history-<index> 兜底', () => {
    expect(mapHistoryItem({ role: 'user', content: 'hi' }, 3).id).toBe(
      'history-3'
    );
  });

  it('空附件数组不挂字段（避免渲染空行）', () => {
    expect(
      mapHistoryItem({ role: 'user', content: 'hi', attachments: [] }, 0)
        .attachments
    ).toBeUndefined();
  });

  it('附件透传', () => {
    const message = mapHistoryItem(
      {
        id: 'srv',
        role: 'user',
        content: 'hi',
        attachments: [{ id: 'a', kind: 'image', mime: 'image/png' }],
      },
      0
    );

    expect(message.attachments).toHaveLength(1);
  });
});

describe('流式块：增量替换 / 权威替换 / 整块移除', () => {
  it('同一 tempId 的多次 delta 只保留一个块，不叠加', () => {
    let messages: Message[] = [];

    messages = applyStreamingText(messages, 'stream-1', '第一段。', 'auto', CREATED_AT);
    const afterFirst = messages.filter(m => m.id.startsWith('stream-1')).length;

    messages = applyStreamingText(
      messages,
      'stream-1',
      '第一段。第二段。',
      'auto',
      CREATED_AT
    );
    const afterSecond = messages.filter(m => m.id.startsWith('stream-1')).length;

    expect(afterFirst).toBeGreaterThan(0);
    // 块内气泡数可以随分段变化，但不会出现"两个块"
    expect(new Set(messages.map(m => m.id.split('#')[0])).size).toBe(1);
    expect(afterSecond).toBeGreaterThan(0);
  });

  it('reconcileStreamDone 用服务端权威 id 整体替换临时块', () => {
    const streaming = applyStreamingText(
      [],
      'stream-1',
      '第一段。第二段。',
      'auto',
      CREATED_AT
    );

    const done = reconcileStreamDone(streaming, 'stream-1', [
      { id: 'srv-a', role: 'assistant', content: '第一段。' },
      { id: 'srv-b', role: 'assistant', content: '第二段。' },
    ]);

    expect(done.map(m => m.id)).toEqual(['srv-a', 'srv-b']);
    expect(done.some(m => m.id.startsWith('stream-1'))).toBe(false);
  });

  it('removeStreamBubble 按块根移除整块（含 #N 后缀）', () => {
    const streaming = applyStreamingText(
      [],
      'stream-1',
      '第一段。第二段。',
      'auto',
      CREATED_AT
    );

    // 前置一条普通消息，确认不被误删
    const withOther: Message[] = [
      { id: 'keep-me', role: 'user', content: 'hi' },
      ...streaming,
    ];

    const removed = removeStreamBubble(withOther, 'stream-1');

    expect(removed.map(m => m.id)).toEqual(['keep-me']);
  });

  it('removeStreamBubble 对不存在的块是空操作', () => {
    const list: Message[] = [{ id: 'a', role: 'user', content: 'x' }];

    expect(removeStreamBubble(list, 'stream-404')).toEqual(list);
  });

  it('块不存在时 reconcileStreamDone 追加而非吞掉内容', () => {
    const done = reconcileStreamDone(
      [{ id: 'a', role: 'user', content: 'x' }],
      'stream-404',
      [{ id: 'srv', role: 'assistant', content: 'y' }]
    );

    expect(done.map(m => m.id)).toEqual(['a', 'srv']);
  });
});

// Agent 工具调用：pill 显示的是服务端真实执行记录，不是占位内容。
// 三条链路都要覆盖——历史（/history 的 toolSteps）、done 权威摘要（顶层与分条）、
// 流式期进度（tool_start / tool_end）。
describe('toToolStepViews', () => {
  it('空与非数组都返回 undefined（渲染层据此不占高度）', () => {
    expect(toToolStepViews(undefined)).toBeUndefined();
    expect(toToolStepViews([])).toBeUndefined();
    expect(toToolStepViews(undefined as never)).toBeUndefined();
  });

  it('缺字段时归一：ok 只认真 true，summary 缺省空串，running 恒为 false', () => {
    const views = toToolStepViews([
      { name: 'memory_search' },
      { name: 'x', ok: 1 as never, summary: 2 as never },
    ] as never);

    expect(views).toEqual([
      { name: 'memory_search', ok: false, summary: '', running: false },
      { name: 'x', ok: false, summary: '', running: false },
    ]);
  });

  it('保留 summary 供详情展示', () => {
    const views = toToolStepViews([
      { name: 'memory_search', ok: true, summary: '命中 3 条', durationMs: 12 },
    ] as never);

    expect(views?.[0]).toMatchObject({ ok: true, summary: '命中 3 条' });
  });
});

describe('applyToolEvent', () => {
  const START = { type: 'tool_start', name: 'memory_search', callId: 'c1' } as const;

  it('tool_start 立一条 running 记录', () => {
    const next = applyToolEvent([], START);

    expect(next).toEqual([
      { callId: 'c1', name: 'memory_search', ok: false, summary: '', running: true },
    ]);
  });

  it('重复的同一 callId 不叠加（事件重发只有一条 pill）', () => {
    const once = applyToolEvent([], START);
    const twice = applyToolEvent(once, START);

    expect(twice).toHaveLength(1);
    expect(twice).toBe(once);
  });

  it('tool_end 按 callId 配回自己的 start', () => {
    const running = applyToolEvent([], START);
    const done = applyToolEvent(running, {
      type: 'tool_end',
      name: 'memory_search',
      callId: 'c1',
      ok: true,
      summary: '命中 2 条',
    });

    expect(done).toHaveLength(1);
    expect(done[0]).toMatchObject({ ok: true, summary: '命中 2 条', running: false });
  });

  it('同名并行调用不串位：各自配对自己的 callId', () => {
    let steps: LiveToolStep[] = applyToolEvent(applyToolEvent([], START), {
      ...START,
      callId: 'c2',
    });

    steps = applyToolEvent(steps, {
      type: 'tool_end',
      name: 'memory_search',
      callId: 'c2',
      ok: true,
      summary: 'second',
    });

    expect(steps[0].running).toBe(true);
    expect(steps[0].callId).toBe('c1');
    expect(steps[1]).toMatchObject({ callId: 'c2', ok: true, running: false });
  });

  it('丢帧（只有 tool_end）时补一条已完成记录，不静默吞掉真实执行', () => {
    const next = applyToolEvent([], {
      type: 'tool_end',
      name: 'memory_search',
      callId: 'c9',
      ok: false,
    });

    expect(next).toHaveLength(1);
    expect(next[0]).toMatchObject({ callId: 'c9', ok: false, running: false });
  });

  it('end 缺 summary 时保留 start 已有的文案', () => {
    const running = applyToolEvent([], START);
    const done = applyToolEvent(
      running.map(step => ({ ...step, summary: '进行中' })),
      { type: 'tool_end', name: 'memory_search', callId: 'c1', ok: true }
    );

    expect(done[0].summary).toBe('进行中');
  });
});

describe('工具摘要挂载位置', () => {
  it('buildReplyBubbles 只给最后一格挂 toolSteps', () => {
    const { bubbles } = buildReplyBubbles(
      { toolSteps: [{ name: 'memory_search', ok: true, summary: 'x' }] } as never,
      [
        { id: 'x1', content: '一' },
        { id: 'x2', content: '二' },
      ]
    );

    expect(bubbles[0].toolSteps).toBeUndefined();
    expect(bubbles[1].toolSteps).toHaveLength(1);
    expect(bubbles[1].toolSteps?.[0]).toMatchObject({ running: false });
  });

  it('分条响应里 seg.toolSteps 优先于顶层（服务端把摘要放在最后一格）', () => {
    const { bubbles } = buildReplyBubbles(
      { toolSteps: [{ name: 'stale_top', ok: true }] } as never,
      [
        { id: 'x1', content: '一' },
        { id: 'x2', content: '二', toolSteps: [{ name: 'real_seg', ok: true }] },
      ] as never
    );

    expect(bubbles[1].toolSteps?.[0].name).toBe('real_seg');
  });

  it('无工具调用的响应不新增字段（旧消息渲染零变化）', () => {
    const { bubbles } = buildReplyBubbles({}, [{ id: 'x1', content: '一' }]);

    expect('toolSteps' in bubbles[0]).toBe(false);
  });

  it('mapHistoryItem 透传历史里的真实执行记录', () => {
    const message = mapHistoryItem(
      {
        role: 'assistant',
        content: '查过了',
        toolSteps: [{ name: 'memory_search', ok: true, summary: '命中 1 条' }],
      } as never,
      0
    );

    expect(message.toolSteps).toHaveLength(1);
    expect(message.toolSteps?.[0]).toMatchObject({
      name: 'memory_search',
      ok: true,
      running: false,
    });
  });

  it('历史条目没有 toolSteps 时不挂字段', () => {
    expect(
      mapHistoryItem({ role: 'assistant', content: 'x' }, 0).toolSteps
    ).toBeUndefined();
  });
});
