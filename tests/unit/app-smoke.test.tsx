/// <reference types="jest" />
/**
 * App 组合根冒烟测试：验证聊天首屏、设置抽屉与 Agent 团队入口在真实
 * 组件树里接线，不依赖任何后端请求（页面级 hook 在本文件内替换为桩）。
 */
import React from 'react';
import { fireEvent, render, screen, waitFor } from '@testing-library/react-native';

import App from '../../App';

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
    sending: false,
    continuing: false,
    loadingHistory: false,
    loadingOlder: false,
    hasMoreHistory: false,
    liveToolSteps: [],
    mood: 'calm',
    sendMessage: jest.fn(),
    sendContinuation: jest.fn(),
    stopGeneration: jest.fn(),
    recallMessage: jest.fn(),
    receiveExternalMessage: jest.fn(),
    resetMessages: jest.fn(),
    markHistoryLoaded: jest.fn(),
    loadEmotion: jest.fn(),
    clearHistory: jest.fn(),
    loadOlderHistory: jest.fn(),
  }),
}));

jest.mock('../../hooks/useSessionList', () => ({
  useSessionList: () => ({
    sessions: [
      {
        id: 's0',
        title: '新对话',
        createdAt: '2026-10-30T00:00:00.000Z',
        updatedAt: '2026-10-30T00:00:00.000Z',
        messageCount: 0,
      },
    ],
    loading: false,
    error: null,
    refresh: jest.fn(async () => [
      {
        id: 's0',
        title: '新对话',
        createdAt: '2026-10-30T00:00:00.000Z',
        updatedAt: '2026-10-30T00:00:00.000Z',
        messageCount: 0,
      },
    ]),
  }),
}));

jest.mock('../../hooks/useSessionActions', () => ({
  useSessionActions: () => ({
    busy: false,
    creatingSession: false,
    createNewChat: jest.fn(async () => ({ id: 's0' })),
    selectSession: jest.fn(),
    deleteSession: jest.fn(),
  }),
}));

jest.mock('../../hooks/useModelSelection', () => ({
  useModelSelection: () => ({
    selectedModel: null,
    selectedModelLabel: '',
    refreshModelSelection: jest.fn(),
  }),
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

jest.mock('../../hooks/useBotResultStream', () => ({
  useBotResultStream: jest.fn(),
}));

describe('App 组合根', () => {
  it('渲染聊天首屏，并从设置抽屉暴露 Agent 团队入口', async () => {
    await render(<App />);

    await waitFor(() => {
      expect(
        screen.getByPlaceholderText('与 Blue 对话…')
      ).toBeTruthy();
    });

    await fireEvent.press(screen.getByLabelText('打开设置'));
    await waitFor(() => {
      expect(screen.getByText('Agent 团队')).toBeTruthy();
      expect(screen.getByText('Memory Bot 工作台')).toBeTruthy();
    });
  });
});
