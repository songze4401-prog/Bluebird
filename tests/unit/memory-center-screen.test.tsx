/// <reference types="jest" />
// Memory Center 的接口契约与关键交互：
// - 只读取真实 scope=all 视图与写入尝试；
// - 确认/归档/删除命中真实接口；
// - 未接入的编辑/撤回/调用溯源明确显示，不伪造；
// - 图谱/生命周期来自真实字段推导。

import React from 'react';
import { Alert } from 'react-native';
import {
  fireEvent,
  render,
  screen,
  waitFor,
} from '@testing-library/react-native';

import { MemoryCenterScreen } from '../../components/MemoryCenterScreen';
import { apiFetch } from '../../lib/api/client';
import { API_PATHS } from '../../lib/api/endpoints';
import type {
  MemoryItem,
  MemoryWriteAttempt,
} from '../../lib/api/types';
import { getTheme } from '../../theme';

jest.mock('../../lib/api/client', () => ({
  apiFetch: jest.fn(),
}));

const mockedFetch = apiFetch as unknown as jest.Mock;
const theme = getTheme('light', 'blue');
const noop = () => {};

function jsonResponse(payload: unknown, status = 200): Response {
  return {
    ok: status >= 200 && status < 300,
    status,
    headers: { get: () => 'application/json' },
    json: async () => payload,
  } as unknown as Response;
}

type AlertButtonLike = { text?: string; onPress?: () => void };

const now = Date.now();
const iso = (daysAgo: number, hoursAgo = 0) =>
  new Date(now - daysAgo * 86400000 - hoursAgo * 3600000).toISOString();

function makeMemories(): MemoryItem[] {
  return [
    {
      id: 'a1',
      content: '用户叫宋泽',
      type: 'identity',
      keywords: ['名字', '宋泽'],
      confidence: 0.98,
      status: 'active',
      validFrom: iso(5),
      validTo: null,
      createdAt: iso(5),
      updatedAt: iso(5),
      contributions: [
        {
          sessionId: 's1',
          sourceQuote: '我叫宋泽',
          createdAt: iso(5),
          sourceType: 'user',
        },
      ],
    },
    {
      id: 'a2',
      content: '用户喜欢喝美式咖啡',
      type: 'preference',
      keywords: ['咖啡', '美式'],
      confidence: 0.92,
      status: 'active',
      validFrom: iso(4),
      validTo: null,
      createdAt: iso(4),
      updatedAt: iso(1),
      lastDecision: {
        action: 'update',
        reason: 'explicit_target_update',
        at: iso(1),
        actor: 'system',
      },
      contributions: [
        {
          sessionId: 's1',
          sourceQuote: '我喜欢喝美式咖啡',
          createdAt: iso(4),
          sourceType: 'user',
        },
      ],
    },
    {
      id: 'a3',
      content: '用户不喜欢喝美式咖啡',
      type: 'preference',
      keywords: ['咖啡', '美式'],
      confidence: 0.88,
      status: 'active',
      validFrom: iso(3),
      validTo: null,
      createdAt: iso(3),
      updatedAt: iso(3),
      contributions: [
        {
          sessionId: 's2',
          sourceQuote: '我不喜欢喝美式咖啡',
          createdAt: iso(3),
          sourceType: 'user',
        },
      ],
    },
    {
      id: 'a4',
      content: '用户住在杭州',
      type: 'fact',
      keywords: ['城市', '杭州'],
      confidence: 0.9,
      status: 'active',
      validFrom: iso(2),
      validTo: null,
      supersedes: 'old1',
      createdAt: iso(2),
      updatedAt: iso(2),
      contributions: [
        {
          sessionId: 's2',
          sourceQuote: '我住在杭州',
          createdAt: iso(2),
          sourceType: 'user',
        },
      ],
    },
    {
      id: 'old1',
      content: '用户住在上海',
      type: 'fact',
      keywords: ['城市', '上海'],
      confidence: 0.9,
      status: 'superseded',
      validFrom: iso(6),
      validTo: iso(2),
      supersededBy: 'a4',
      createdAt: iso(6),
      updatedAt: iso(2),
      lastDecision: {
        action: 'supersede',
        reason: 'conflict',
        at: iso(2),
      },
      contributions: [
        {
          sessionId: 's1',
          sourceQuote: '我住在上海',
          createdAt: iso(6),
          sourceType: 'user',
        },
      ],
    },
    {
      id: 'p1',
      content: '用户计划下个月去杭州',
      type: 'goal',
      keywords: ['杭州', '旅行'],
      confidence: 0.7,
      status: 'pending',
      pendingReason: 'low_confidence',
      pendingAt: iso(0, 2),
      validFrom: iso(0, 2),
      validTo: null,
      createdAt: iso(0, 2),
      updatedAt: iso(0, 2),
      contributions: [
        {
          sessionId: 's2',
          sourceQuote: '我下个月想去杭州',
          createdAt: iso(0, 2),
          sourceType: 'agent',
        },
      ],
    },
    {
      id: 'arch1',
      content: '用户以前用 Vim',
      type: 'preference',
      keywords: ['编辑器', 'Vim'],
      confidence: 0.9,
      status: 'archived',
      validFrom: iso(8),
      validTo: iso(0, 4),
      createdAt: iso(8),
      updatedAt: iso(0, 4),
      lastDecision: {
        action: 'archive',
        reason: 'user_archived',
        at: iso(0, 4),
        actor: 'user',
      },
      contributions: [
        {
          sessionId: 's1',
          sourceQuote: '我以前用 Vim',
          createdAt: iso(8),
          sourceType: 'user',
        },
      ],
    },
    {
      id: 'dup1',
      content: '用户喜欢喝美式咖啡。',
      type: 'preference',
      keywords: ['咖啡', '美式'],
      confidence: 0.91,
      status: 'active',
      validFrom: iso(1, 3),
      validTo: null,
      createdAt: iso(1, 3),
      updatedAt: iso(1, 3),
      contributions: [
        {
          sessionId: 's3',
          sourceQuote: '我喜欢美式咖啡',
          createdAt: iso(1, 3),
          sourceType: 'user',
        },
      ],
    },
  ];
}

function makeAttempts(): MemoryWriteAttempt[] {
  return [
    {
      at: iso(0, 3),
      written: false,
      action: 'none',
      reason: 'low_confidence',
      id: 'not-written',
    },
    {
      at: iso(0, 4),
      written: true,
      action: 'merged',
      id: 'a2',
      reason: null,
    },
  ];
}

let memories: MemoryItem[];

function installApi() {
  memories = makeMemories();
  const attempts = makeAttempts();

  mockedFetch.mockImplementation(async (path: string, init?: RequestInit) => {
    if (path === API_PATHS.memoryAll) {
      return jsonResponse({ memories, scope: 'all' });
    }

    if (path === API_PATHS.memoryWriteAttempts) {
      return jsonResponse({ attempts });
    }

    if (path === API_PATHS.memoryConfirm) {
      const body = JSON.parse(String(init?.body || '{}'));
      memories = memories.map(item =>
        item.id === body.id
          ? {
              ...item,
              status: 'active',
              pendingReason: undefined,
              pendingAt: null,
              lastDecision: {
                action: 'confirm',
                reason: 'user_confirmed',
                at: new Date().toISOString(),
                actor: 'user',
              },
            }
          : item
      );
      return jsonResponse({ ok: true, id: body.id, status: 'active' });
    }

    if (path === API_PATHS.memoryArchive) {
      const body = JSON.parse(String(init?.body || '{}'));
      memories = memories.map(item =>
        item.id === body.id ? { ...item, status: 'archived' } : item
      );
      return jsonResponse({ ok: true, id: body.id, status: 'archived' });
    }

    if (path === API_PATHS.memoryDelete) {
      const body = JSON.parse(String(init?.body || '{}'));
      memories = memories.filter(item => item.id !== body.id);
      return jsonResponse({ ok: true, removed: true });
    }

    if (path === API_PATHS.memoryReject) {
      const body = JSON.parse(String(init?.body || '{}'));
      memories = memories.filter(item => item.id !== body.id);
      return jsonResponse({ ok: true, id: body.id });
    }

    if (path === API_PATHS.memoryClear) {
      memories = [];
      return jsonResponse({ ok: true, message: 'cleared' });
    }

    return jsonResponse({ error: 'not found' }, 404);
  });
}

async function openManage() {
  await waitFor(() => {
    expect(screen.getByText('Memory Center')).toBeTruthy();
  });
  await fireEvent.press(screen.getByLabelText('记忆中心 管理'));
}

describe('Memory Center 屏幕', () => {
  let alertSpy: jest.SpyInstance;

  beforeEach(() => {
    mockedFetch.mockReset();
    installApi();
    alertSpy = jest.spyOn(Alert, 'alert').mockImplementation(() => {});
  });

  afterEach(() => {
    alertSpy.mockRestore();
  });

  it('概览展示真实计数、7 天趋势和待确认预览', async () => {
    await render(<MemoryCenterScreen visible onClose={noop} theme={theme} />);

    await waitFor(() => {
      expect(screen.getByText('记忆总量')).toBeTruthy();
    });

    expect(screen.getByText('含 1 条历史版本')).toBeTruthy();
    expect(screen.getByText('近 7 天新增')).toBeTruthy();
    expect(screen.getByText('需要你确认')).toBeTruthy();
    expect(screen.getByText('用户计划下个月去杭州')).toBeTruthy();
    expect(screen.getByText('回答调用溯源 · 未接入')).toBeTruthy();
    expect(screen.getByText('记忆检查')).toBeTruthy();
  });

  it('管理页支持搜索、类型筛选，并在详情展示真实来源与未接入操作', async () => {
    await render(<MemoryCenterScreen visible onClose={noop} theme={theme} />);
    await openManage();

    await waitFor(() => {
      expect(screen.getByText('用户叫宋泽')).toBeTruthy();
    });

    await fireEvent.changeText(screen.getByLabelText('搜索记忆'), '宋泽');
    await waitFor(() => {
      expect(screen.getByText('用户叫宋泽')).toBeTruthy();
      expect(screen.queryByText('用户住在杭州')).toBeNull();
    });

    await fireEvent.changeText(screen.getByLabelText('搜索记忆'), '');
    await fireEvent.press(screen.getByLabelText('类型筛选 身份'));
    await waitFor(() => {
      expect(screen.getByText('用户叫宋泽')).toBeTruthy();
      expect(screen.queryByText('用户喜欢喝美式咖啡')).toBeNull();
    });

    await fireEvent.press(screen.getByLabelText('类型筛选 全部类型'));
    await fireEvent.press(screen.getByLabelText('打开记忆 用户叫宋泽'));

    await waitFor(() => {
      expect(screen.getByText('记忆详情')).toBeTruthy();
    });

    expect(screen.getAllByText('身份').length).toBeGreaterThan(0);
    expect(screen.getByText(/我叫宋泽/)).toBeTruthy();
    expect(screen.getByText('未接入操作')).toBeTruthy();
    expect(screen.getByText('编辑')).toBeTruthy();
    expect(screen.getByText('撤回')).toBeTruthy();
    expect(screen.getByText(/单条撤回/)).toBeTruthy();

    await fireEvent.press(screen.getByLabelText('返回记忆列表'));
    await waitFor(() => {
      expect(screen.queryByText('记忆详情')).toBeNull();
    });
  });

  it('确认待确认记忆会调用真实 /memory/confirm 并关闭详情', async () => {
    await render(<MemoryCenterScreen visible onClose={noop} theme={theme} />);
    await openManage();

    await fireEvent.press(
      screen.getByLabelText('打开记忆 用户计划下个月去杭州')
    );

    await waitFor(() => {
      expect(screen.getByText('记忆详情')).toBeTruthy();
    });

    await fireEvent.press(screen.getByLabelText('确认这条记忆'));

    await waitFor(() => {
      expect(mockedFetch).toHaveBeenCalledWith(
        API_PATHS.memoryConfirm,
        expect.objectContaining({
          method: 'POST',
          body: JSON.stringify({ id: 'p1' }),
        })
      );
    });

    await waitFor(() => {
      expect(screen.queryByText('记忆详情')).toBeNull();
    });

    await fireEvent.press(screen.getByLabelText('记忆中心 生命周期'));
    await waitFor(() => {
      expect(screen.getByText('生命周期时间线')).toBeTruthy();
    });
    expect(screen.getAllByText('确认')).toHaveLength(1);
  });

  it('删除记忆必须先确认，然后调用真实 /memory/delete', async () => {
    alertSpy.mockImplementation((title, _message, buttons) => {
      if (title === '删除这条记忆？') {
        const confirm = (buttons || []).find((item: AlertButtonLike) => item.text === '删除');
        confirm?.onPress?.();
      }
    });

    await render(<MemoryCenterScreen visible onClose={noop} theme={theme} />);
    await openManage();

    await fireEvent.press(screen.getByLabelText('打开记忆 用户住在杭州'));
    await waitFor(() => {
      expect(screen.getByText('记忆详情')).toBeTruthy();
    });

    await fireEvent.press(screen.getByLabelText('删除这条记忆'));

    await waitFor(() => {
      expect(mockedFetch).toHaveBeenCalledWith(
        API_PATHS.memoryDelete,
        expect.objectContaining({
          method: 'POST',
          body: JSON.stringify({ id: 'a4' }),
        })
      );
    });
  });

  it('归档与拒绝待确认记忆各自调用真实接口', async () => {
    alertSpy.mockImplementation((title, _message, buttons) => {
      if (title === '归档这条记忆？' || title === '拒绝这条候选？') {
        const label = title === '归档这条记忆？' ? '归档' : '拒绝';
        const confirm = (buttons || []).find((item: AlertButtonLike) => item.text === label);
        confirm?.onPress?.();
      }
    });

    await render(<MemoryCenterScreen visible onClose={noop} theme={theme} />);
    await openManage();

    await fireEvent.press(screen.getByLabelText('打开记忆 用户住在杭州'));
    await waitFor(() => {
      expect(screen.getByText('记忆详情')).toBeTruthy();
    });
    await fireEvent.press(screen.getByLabelText('归档这条记忆'));

    await waitFor(() => {
      expect(mockedFetch).toHaveBeenCalledWith(
        API_PATHS.memoryArchive,
        expect.objectContaining({
          method: 'POST',
          body: JSON.stringify({ id: 'a4' }),
        })
      );
    });

    await waitFor(() => {
      expect(screen.queryByText('记忆详情')).toBeNull();
    });

    await fireEvent.press(
      screen.getByLabelText('打开记忆 用户计划下个月去杭州')
    );
    await waitFor(() => {
      expect(screen.getByText('记忆详情')).toBeTruthy();
    });
    await fireEvent.press(screen.getByLabelText('拒绝待确认记忆'));

    await waitFor(() => {
      expect(mockedFetch).toHaveBeenCalledWith(
        API_PATHS.memoryReject,
        expect.objectContaining({
          method: 'POST',
          body: JSON.stringify({ id: 'p1' }),
        })
      );
    });
  });

  it('记忆检查展示本地重复与冲突结果，并可打开条目', async () => {
    await render(<MemoryCenterScreen visible onClose={noop} theme={theme} />);
    await openManage();

    await fireEvent.press(
      screen.getByLabelText('打开记忆重复与冲突检查')
    );

    await waitFor(() => {
      expect(screen.getByText('重复与冲突 · 本地推导')).toBeTruthy();
    });

    expect(screen.getByText('只提示，不自动改动记忆')).toBeTruthy();
    expect(screen.getAllByText('疑似重复').length).toBeGreaterThan(0);
    expect(screen.getAllByText('潜在冲突').length).toBeGreaterThan(0);
    expect(
      screen.getAllByText('用户喜欢喝美式咖啡').length
    ).toBeGreaterThan(0);
  });

  it('图谱节点可打开详情，生命周期展示事件与写入尝试', async () => {
    await render(<MemoryCenterScreen visible onClose={noop} theme={theme} />);

    await waitFor(() => {
      expect(screen.getByText('Memory Center')).toBeTruthy();
    });

    await fireEvent.press(screen.getByLabelText('记忆中心 图谱'));
    await waitFor(() => {
      expect(screen.getByText('神经图谱')).toBeTruthy();
    });

    await fireEvent.press(screen.getByLabelText('打开记忆 用户住在杭州'));
    await waitFor(() => {
      expect(screen.getByText('记忆详情')).toBeTruthy();
    });
    await fireEvent.press(screen.getByLabelText('返回记忆列表'));

    await fireEvent.press(screen.getByLabelText('记忆中心 生命周期'));
    await waitFor(() => {
      expect(screen.getByText('生命周期时间线')).toBeTruthy();
    });

    expect(screen.getByText('回答调用记忆 · 未接入')).toBeTruthy();
    await fireEvent.press(screen.getByLabelText('展开写入尝试记录'));

    await waitFor(() => {
      expect(screen.getAllByText('置信度不足').length).toBeGreaterThan(0);
    });
  });

  it('清空全部记忆必须确认并调用真实 /memory/clear', async () => {
    alertSpy.mockImplementation((title, _message, buttons) => {
      if (title === '清空全部记忆') {
        const confirm = (buttons || []).find((item: AlertButtonLike) => item.text === '清空');
        confirm?.onPress?.();
      }
    });

    await render(<MemoryCenterScreen visible onClose={noop} theme={theme} />);
    await openManage();

    await fireEvent.press(screen.getByLabelText('清空全部记忆'));

    await waitFor(() => {
      expect(mockedFetch).toHaveBeenCalledWith(
        API_PATHS.memoryClear,
        expect.objectContaining({
          method: 'POST',
          body: JSON.stringify({ confirm: true }),
        })
      );
    });
  });
});
