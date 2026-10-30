/// <reference types="jest" />
// Memory Center 纯规则：概览、趋势、检测、生命周期与图谱推导。
// 所有输入都模拟真实 /memory?scope=all 字段，不依赖网络或随机数。

import type { MemoryItem, MemoryWriteAttempt } from '../../lib/api/types';
import {
  buildGrowthSeries,
  buildMemoryOverview,
  buildMemorySummary,
  collectEntryLifecycleEvents,
  collectLocalLifecycleEvents,
  collectWriteAttemptEvents,
  detectConflicts,
  detectDuplicates,
  isEffectiveMemory,
  memoryConfidencePercent,
  memoryDisplayStatusLabel,
  memorySimilarity,
  mergeLifecycleEvents,
  sourceQuotes,
} from '../../lib/memory-center';
import { buildMemoryGraph } from '../../lib/memory-graph';

const base = '2026-10-30T10:00:00.000Z';

function memory(overrides: Partial<MemoryItem> = {}): MemoryItem {
  return {
    id: 'mem-test',
    content: '用户喜欢喝美式咖啡',
    type: 'preference',
    keywords: ['咖啡', '美式'],
    confidence: 0.92,
    status: 'active',
    validFrom: base,
    validTo: null,
    createdAt: base,
    updatedAt: base,
    ...overrides,
  };
}

describe('Memory Center 概览与趋势', () => {
  it('按状态和有效期计算活跃、待确认、归档与历史版本', () => {
    const now = Date.parse('2026-10-30T12:00:00.000Z');
    const items = [
      memory({ id: 'a' }),
      memory({
        id: 'expired',
        validTo: '2026-10-30T09:00:00.000Z',
      }),
      memory({ id: 'p', status: 'pending', createdAt: '2026-10-30T09:00:00.000Z' }),
      memory({ id: 'arch', status: 'archived' }),
      memory({ id: 'hist', status: 'superseded' }),
    ];

    expect(isEffectiveMemory(items[0], now)).toBe(true);
    expect(isEffectiveMemory(items[1], now)).toBe(false);
    expect(memoryDisplayStatusLabel(items[0])).toBe('活跃');
    expect(memoryDisplayStatusLabel(items[1])).toBe('已过期');

    expect(buildMemoryOverview(items, now)).toEqual({
      total: 5,
      active: 1,
      pending: 1,
      archived: 1,
      history: 1,
      expired: 1,
    });
  });

  it('近 7 天趋势按 createdAt 切桶，并排除历史版本', () => {
    const now = new Date();
    now.setHours(12, 0, 0, 0);
    const createdToday = new Date(now.getTime()).toISOString();
    const createdYesterday = new Date(now.getTime() - 86400000).toISOString();

    const points = buildGrowthSeries(
      [
        memory({ id: 'today-1', createdAt: createdToday }),
        memory({ id: 'today-2', createdAt: createdToday }),
        memory({ id: 'yesterday', createdAt: createdYesterday }),
        memory({
          id: 'history',
          status: 'superseded',
          createdAt: createdYesterday,
        }),
      ],
      now.getTime()
    );

    expect(points).toHaveLength(7);
    expect(points[6].count).toBe(2);
    expect(points[5].count).toBe(1);
    expect(points.reduce((sum, point) => sum + point.count, 0)).toBe(3);
  });

  it('摘要只使用当前有效记忆，且不改动输入顺序', () => {
    const items = [
      memory({ id: 'p', type: 'preference', content: '用户喜欢喝美式咖啡' }),
      memory({ id: 'i', type: 'identity', content: '用户叫宋泽' }),
    ];
    const before = items.map(item => item.id).join(',');

    expect(buildMemorySummary(items)).toBe('用户叫宋泽，用户喜欢喝美式咖啡。');
    expect(items.map(item => item.id).join(',')).toBe(before);
  });
});

describe('重复与冲突检测', () => {
  it('相似度对完全相同文本为 1，对无关文本接近 0', () => {
    expect(
      memorySimilarity('用户喜欢喝美式咖啡', '用户喜欢喝美式咖啡。')
    ).toBe(1);
    expect(
      memorySimilarity('用户喜欢喝美式咖啡', '用户住在杭州')
    ).toBeLessThan(0.2);
  });

  it('重复检测只提示高相似活跃记忆', () => {
    const pairs = detectDuplicates([
      memory({ id: 'a', content: '用户喜欢喝美式咖啡' }),
      memory({ id: 'b', content: '用户喜欢喝美式咖啡。' }),
      memory({ id: 'c', content: '用户住在杭州' }),
    ]);

    expect(pairs).toHaveLength(1);
    expect(pairs[0].a.id).toBe('a');
    expect(pairs[0].b.id).toBe('b');
    expect(pairs[0].similarity).toBe(1);
  });

  it('冲突检测要求同类型、共享关键词且正负表述不同', () => {
    const conflicts = detectConflicts([
      memory({ id: 'like', content: '用户喜欢喝咖啡', keywords: ['咖啡', '饮品'] }),
      memory({
        id: 'dislike',
        content: '用户不喜欢喝咖啡',
        keywords: ['咖啡', '饮品'],
      }),
      memory({
        id: 'other-type',
        content: '用户喜欢喝咖啡',
        type: 'fact',
        keywords: ['咖啡', '饮品'],
      }),
    ]);

    expect(conflicts).toHaveLength(1);
    expect(conflicts[0].a.id).toBe('like');
    expect(conflicts[0].b.id).toBe('dislike');
    expect(conflicts[0].sharedKeywords).toEqual(['咖啡', '饮品']);
  });
});

describe('生命周期事件', () => {
  it('从条目字段推导创建、更新、待确认、归档与取代，不补造缺失时间', () => {
    const items = [
      memory({
        id: 'created',
        createdAt: '2026-10-30T08:00:00.000Z',
        lastDecision: {
          action: 'create',
          reason: 'auto_extracted',
          at: '2026-10-30T08:00:00.000Z',
        },
      }),
      memory({
        id: 'updated',
        createdAt: '2026-10-29T08:00:00.000Z',
        updatedAt: '2026-10-30T09:00:00.000Z',
        lastDecision: {
          action: 'update',
          reason: 'explicit_target_update',
          at: '2026-10-30T09:00:00.000Z',
        },
      }),
      memory({
        id: 'pending',
        status: 'pending',
        pendingAt: '2026-10-30T09:30:00.000Z',
        pendingReason: 'low_confidence',
        createdAt: '2026-10-30T09:30:00.000Z',
        lastDecision: {
          action: 'needs_confirmation',
          reason: 'low_confidence',
          at: '2026-10-30T09:30:00.000Z',
        },
      }),
      memory({
        id: 'archived',
        status: 'archived',
        updatedAt: '2026-10-30T09:45:00.000Z',
        lastDecision: {
          action: 'archive',
          reason: 'user_archived',
          at: '2026-10-30T09:45:00.000Z',
        },
      }),
      memory({
        id: 'old',
        status: 'superseded',
        supersededBy: 'new',
        updatedAt: '2026-10-30T09:50:00.000Z',
        createdAt: '2026-10-28T08:00:00.000Z',
        lastDecision: {
          action: 'supersede',
          reason: 'conflict',
          at: '2026-10-30T09:50:00.000Z',
        },
      }),
      memory({ id: 'no-time', createdAt: undefined, validFrom: undefined }),
    ];

    const events = collectEntryLifecycleEvents(items);
    const types = events.map(event => event.type);

    expect(types).toContain('create');
    expect(types).toContain('update');
    expect(types).toContain('pending');
    expect(types).toContain('archive');
    expect(types).toContain('supersede');
    expect(events.every(event => Number.isFinite(Date.parse(event.at)))).toBe(
      true
    );
    expect(events.filter(event => event.type === 'create')).toHaveLength(5);
    expect(events.some(event => event.memoryId === 'no-time')).toBe(false);
    // lastDecision 已经表达的状态迁移不重复生成第二条事件
    expect(
      events.filter(event => event.memoryId === 'pending' && event.type === 'pending')
    ).toHaveLength(1);
    expect(
      events.filter(event => event.memoryId === 'old' && event.type === 'supersede')
    ).toHaveLength(1);
  });

  it('本次会话操作按真实时间进入生命周期并参与排序', () => {
    const local = collectLocalLifecycleEvents([
      {
        at: '2026-10-30T11:00:00.000Z',
        type: 'confirm',
        memoryId: 'p',
        content: '待确认内容',
      },
      {
        at: '2026-10-30T11:05:00.000Z',
        type: 'delete',
        memoryId: 'a',
        content: '删除内容',
      },
    ]);

    expect(local.map(event => event.type)).toEqual(['delete', 'confirm']);
    expect(local.every(event => event.source === 'local')).toBe(true);

    const merged = mergeLifecycleEvents(
      [
        {
          key: 'entry:1',
          at: '2026-10-30T10:00:00.000Z',
          type: 'create',
          title: '创建',
          source: 'entry',
        },
      ],
      local
    );

    expect(merged.map(event => event.type)).toEqual([
      'delete',
      'confirm',
      'create',
    ]);
  });

  it('写入尝试映射为真实事件，并关联仍在库中的条目正文', () => {
    const attempts: MemoryWriteAttempt[] = [
      {
        at: '2026-10-30T10:00:00.000Z',
        written: true,
        action: 'inserted',
        id: 'a',
        reason: null,
      },
      {
        at: '2026-10-30T10:01:00.000Z',
        written: true,
        action: 'merged',
        id: 'a',
        reason: null,
      },
      {
        at: '2026-10-30T10:02:00.000Z',
        written: true,
        action: 'superseded',
        id: 'new',
        supersededId: 'old',
        reason: null,
      },
      {
        at: '2026-10-30T10:03:00.000Z',
        written: true,
        action: 'pending',
        id: 'p',
        reason: 'low_confidence',
      },
      {
        at: '2026-10-30T10:04:00.000Z',
        written: false,
        action: 'none',
        reason: 'no_content',
      },
    ];
    const events = collectWriteAttemptEvents(attempts, [
      memory({ id: 'a', content: '已存在的记忆' }),
      memory({ id: 'new', content: '新版本', supersedes: 'old' }),
      memory({ id: 'p', content: '待确认内容', status: 'pending' }),
    ]);

    expect(events.map(event => event.type)).toEqual([
      'reject',
      'pending',
      'supersede',
      'merge',
      'create',
    ]);
    expect(events.every(event => event.technical === true)).toBe(true);
    expect(events.find(event => event.type === 'create')?.content).toBe(
      '已存在的记忆'
    );
    expect(events.find(event => event.type === 'supersede')?.targetId).toBe(
      'old'
    );
  });
});

describe('图谱推导', () => {
  it('关键词共现与显式取代关系形成边，布局在规定范围内且有确定性', () => {
    const items = [
      memory({ id: 'a', keywords: ['咖啡', '美式'], content: '用户喜欢美式' }),
      memory({ id: 'b', keywords: ['咖啡', '美式'], content: '用户常喝美式' }),
      memory({
        id: 'old',
        status: 'superseded',
        supersededBy: 'a',
        keywords: ['咖啡'],
        content: '旧偏好',
      }),
      memory({ id: 'solo', keywords: ['跑步'], content: '用户跑步' }),
    ];

    const first = buildMemoryGraph(items);
    const second = buildMemoryGraph(items);

    expect(first.nodes).toHaveLength(4);
    expect(
      first.edges.some(edge => edge.kind === 'keyword' && edge.a === 'a')
    ).toBe(true);
    expect(
      first.edges.some(edge => edge.kind === 'supersede' && edge.a === 'old')
    ).toBe(true);
    expect(
      first.nodes.every(
        node =>
          Number.isFinite(node.x) &&
          Number.isFinite(node.y) &&
          node.x >= 0.08 &&
          node.x <= 0.92 &&
          node.y >= 0.08 &&
          node.y <= 0.92
      )
    ).toBe(true);
    expect(second.nodes.map(node => `${node.id}:${node.x}:${node.y}`)).toEqual(
      first.nodes.map(node => `${node.id}:${node.x}:${node.y}`)
    );
  });

  it('节点超过上限时按关联度截断，但保留真实总数', () => {
    const items = Array.from({ length: 40 }, (_, index) =>
      memory({
        id: `m-${index}`,
        content: `记忆 ${index}`,
        keywords: index < 2 ? ['共享', '关键词'] : [`独立${index}`],
      })
    );

    const graph = buildMemoryGraph(items, { maxNodes: 5, maxEdges: 4 });

    expect(graph.nodes).toHaveLength(5);
    expect(graph.truncated).toBe(true);
    expect(graph.totalNodes).toBe(40);
    expect(graph.edges.length).toBeLessThanOrEqual(4);
  });
});

describe('展示字段', () => {
  it('置信度与来源原话只做真实映射', () => {
    expect(memoryConfidencePercent(memory({ confidence: 0.873 }))).toBe('87%');
    expect(memoryConfidencePercent(memory({ confidence: undefined }))).toBe('—');
    expect(
      sourceQuotes(
        memory({
          sourceQuote: '旧字段',
          contributions: [
            { sourceQuote: '原话一', sessionId: 's1' },
            { sourceQuote: '原话一', sessionId: 's2' },
            { sourceQuote: '原话二', sessionId: 's2' },
          ],
        })
      )
    ).toEqual(['原话一', '原话二']);
  });
});
