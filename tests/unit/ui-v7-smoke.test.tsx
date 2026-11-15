/// <reference types="jest" />
/**
 * 蓝鸟 v7 新壳冒烟：默认落在聊天页（原型 openRecent 进入即回最近对话）、
 * 底部导航三键、主页区块齐全、设置弹层主要行可见、进度 tick 推进。
 * 聊天链路已接真 hooks（#接线 R1 起）—— hooks 全部替换为桩，测试不依赖后端。
 */
import React from 'react';
import { fireEvent, render, waitFor } from '@testing-library/react-native';

import { BluebirdApp } from '../../app/BluebirdApp';

jest.mock('react-native-safe-area-context', () =>
  require('react-native-safe-area-context/jest/mock').default
);

jest.mock('@react-native-async-storage/async-storage', () => ({
  __esModule: true,
  default: {
    getItem: jest.fn(async () => null),
    setItem: jest.fn(async () => undefined),
    removeItem: jest.fn(async () => undefined),
  },
}));

jest.mock('../../lib/presence', () => ({
  usePresence: () => ({ reportInteraction: jest.fn() }),
}));

jest.mock('../../hooks/useChatSession', () => ({
  useChatSession: () => ({
    messages: [],
    loadingHistory: false,
    sending: false,
    mood: 'calm',
    liveToolSteps: [],
    sendMessage: jest.fn(async () => undefined),
    stopGeneration: jest.fn(),
    loadHistory: jest.fn(async () => ({ ok: true, status: 200 })),
    loadOlderHistory: jest.fn(async () => ({ ok: false, status: 200 })),
    hasMoreHistory: false,
    loadingOlder: false,
    markHistoryLoaded: jest.fn(),
    loadEmotion: jest.fn(async () => undefined),
    clearHistory: jest.fn(),
    recallMessage: jest.fn(),
    receiveExternalMessage: jest.fn(),
    resetMessages: jest.fn(),
  }),
}));

jest.mock('../../hooks/useSessionList', () => ({
  useSessionList: () => ({
    sessions: [],
    loading: false,
    error: '',
    refresh: jest.fn(async () => []),
  }),
}));

jest.mock('../../hooks/useSessionActions', () => ({
  useSessionActions: () => ({
    busy: false,
    creatingSession: false,
    createNewChat: jest.fn(async () => null),
    selectSession: jest.fn(),
    deleteSession: jest.fn(),
  }),
}));

jest.mock('../../hooks/useModelSelection', () => ({
  useModelSelection: () => ({
    selectedModel: null,
    selectedModelLabel: '',
    refreshModelSelection: jest.fn(async () => undefined),
  }),
}));

jest.mock('../../hooks/useStreamingPreference', () => ({
  useStreamingPreference: () => ({ streamingEnabled: true, setStreaming: jest.fn() }),
}));

jest.mock('../../hooks/useAttachments', () => ({
  useAttachments: () => ({
    pendingAttachments: [],
    uploadingImage: false,
    clearAttachments: jest.fn(),
    pickImage: jest.fn(),
    pickSticker: jest.fn(),
    removeAttachment: jest.fn(),
  }),
}));

describe('蓝鸟 v7 新壳', () => {
  it('聊天首屏 + 底部导航 + 主页区块 + 设置弹层 + 进度推进（mock 数据）', async () => {
    const utils = await render(<BluebirdApp />);

    // 默认落在聊天页：身份胶囊 + 占位输入条
    await waitFor(() => {
      expect(utils.getByPlaceholderText('与 Bluebird 对话…')).toBeTruthy();
    });
    expect(utils.getAllByText('Bluebird').length).toBeGreaterThan(0);

    // 底部导航三键
    expect(utils.getByText('主页')).toBeTruthy();
    expect(utils.getByText('聊天')).toBeTruthy();
    expect(utils.getByText('设置')).toBeTruthy();

    // 切主页：入口卡 / 双卡 / 四个分区头都在
    fireEvent.press(utils.getByText('主页'));
    await waitFor(() => {
      expect(utils.getByText('创建面板')).toBeTruthy();
      expect(utils.getByText('任务 · 定时')).toBeTruthy();
      expect(utils.getByText('进行中的任务')).toBeTruthy();
      expect(utils.getByText('已完成任务')).toBeTruthy();
      expect(utils.getByText('对话记录')).toBeTruthy();
    });

    // 设置弹层：主要行可见（命名纪律：无「主控」、无「Bot」后缀）
    fireEvent.press(utils.getByText('设置'));
    await waitFor(() => {
      expect(utils.getByText('切换账号')).toBeTruthy();
      expect(utils.getByText('系统监控')).toBeTruthy();
      expect(utils.getByText('退出登录')).toBeTruthy();
    });

    // 进度 tick 回归：进行中任务的百分比应在 ~2s 内推进
    // （防「p 增量被整帧丢弃」死锁复发——2026-11-15 复查发现的阻断级 bug）
    await waitFor(
      () => {
        expect(utils.queryByText('62%')).toBeNull();
      },
      { timeout: 4000 }
    );
  });
});
