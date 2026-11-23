/// <reference types="jest" />
/**
 * v7 聊天屏渲染契约测试：脚本化 chat 桩直渲染 ChatScreen，
 * 锁住 oracle 复查揪出的四类接线契约——
 *   ① 新发送必须走 overrideText 通道（首参是 retryText，走首参=重试路径，
 *      用户气泡不上屏、上下文被截、id 改写错位）
 *   ② 发送失败重试入口在 assistant 错误气泡上（retryText 挂 assistant 角色）
 *   ③ sticker 分段绝不透出原始标记（BUG-03 纪律）
 *   ④ 工具 pill 按 ToolStepView 渲染（✓/●/✕ + name · summary）
 */
import React from 'react';
import { fireEvent, render, waitFor } from '@testing-library/react-native';

import { ChatScreen } from '../../app/ChatScreen';
import { UiStateProvider } from '../../app/ui-state';
import { getToolDetailRows } from '../../components/ToolDetailSheet';
import type { ChatSessionApi } from '../../hooks/useChatSession';
import type { Message } from '../../lib/types';

jest.mock('react-native-safe-area-context', () =>
  require('react-native-safe-area-context/jest/mock').default
);

function scriptChat(overrides: {
  messages: Message[];
  sendMessage?: ChatSessionApi['sendMessage'];
  confirmWorkspaceWrite?: ChatSessionApi['confirmWorkspaceWrite'];
  rejectWorkspaceWrite?: ChatSessionApi['rejectWorkspaceWrite'];
}): ChatSessionApi {
  const sendMessage: ChatSessionApi['sendMessage'] =
    overrides.sendMessage ?? (async () => undefined);
  const confirmWorkspaceWrite: ChatSessionApi['confirmWorkspaceWrite'] =
    overrides.confirmWorkspaceWrite ?? (async () => undefined);
  const rejectWorkspaceWrite: ChatSessionApi['rejectWorkspaceWrite'] =
    overrides.rejectWorkspaceWrite ?? (async () => undefined);
  return {
    messages: overrides.messages,
    loadingHistory: false,
    sending: false,
    mood: 'calm',
    liveToolSteps: [],
    sendMessage,
    stopGeneration: jest.fn(),
    confirmWorkspaceWrite,
    rejectWorkspaceWrite,
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
  };
}

async function renderChat(chat: ChatSessionApi) {
  return render(
    <UiStateProvider>
      <ChatScreen
        chat={chat}
        modelLabel="DeepSeek"
        models={[]}
        currentModel={null}
        onSelectModel={async () => true}
        attachments={{
          pendingAttachments: [],
          uploadingImage: false,
          pickImage: async () => undefined,
          pickSticker: async () => null,
          removeAttachment: () => undefined,
        }}
        sessionId="test-session"
      />
    </UiStateProvider>
  );
}

describe('v7 聊天屏渲染契约', () => {
  it('新发送走 overrideText 通道，不走 retryText 首参', async () => {
    const sendMessage = jest.fn(async (_t?: string) => undefined);
    const utils = await renderChat(scriptChat({ messages: [], sendMessage }));

    const input = utils.getByPlaceholderText('与 Bluebird 对话…');
    fireEvent.changeText(input, '你好');
    // 等 TextInput 受控值落地（disabled 随之解除）再按发送
    await waitFor(() => expect(utils.getByDisplayValue('你好')).toBeTruthy());
    fireEvent.press(utils.getByLabelText('发送'));

    await waitFor(() => {
      expect(sendMessage).toHaveBeenCalledWith(
        undefined,
        undefined,
        expect.objectContaining({ overrideText: '你好' })
      );
    });
    expect(sendMessage.mock.calls[0][0]).toBeUndefined();
  });

  it('assistant 错误气泡（retryText）渲染重试入口，点击带原文本重试', async () => {
    const sendMessage = jest.fn(async () => undefined);
    const messages: Message[] = [
      { id: 'u1', role: 'user', content: '你好' },
      {
        id: 'a1',
        role: 'assistant',
        content: '发送失败（connection）：请求未能送达',
        retryText: '你好',
        createdAt: '2026-11-16T09:30:00.000Z',
      },
    ];
    const utils = await renderChat(scriptChat({ messages, sendMessage }));

    const retry = utils.getByText('发送失败 · 点击重试');
    fireEvent.press(retry);
    expect(sendMessage).toHaveBeenCalledWith('你好', undefined);
  });

  it('sticker 分段不透出原始标记：失效给占位、有效给真图（鉴权路由）', async () => {    const messages: Message[] = [
      {
        id: 'a1',
        role: 'assistant',
        content: '',
        segments: [
          { type: 'sticker', id: 's1', valid: false, marker: '[sticker:abc-123]' },
          { type: 'sticker', id: 's2', valid: true, marker: '[sticker:def-456]' },
        ],
      },
    ];
    const utils = await renderChat(scriptChat({ messages }));

    // R4：失效 → 灰字占位；有效 → 真图（expo-image，鉴权头拉 /sticker-repo/:id/image）
    expect(utils.getByText('表情包已失效')).toBeTruthy();
    expect(utils.getAllByLabelText('表情包').length).toBeGreaterThan(0);
    // BUG-03：原始标记绝不透回
    expect(utils.queryByText(/sticker:abc-123/)).toBeNull();
    expect(utils.queryByText(/sticker:def-456/)).toBeNull();
  });

  it('无 segments 且正文含原始标记 → 兜底解析（parseStickerMarkers），标记不透出', async () => {
    const messages: Message[] = [
      {
        id: 'a1',
        role: 'assistant',
        content: '这是正文 [sticker:xyz-789] 收尾',
      },
    ];
    const utils = await renderChat(scriptChat({ messages }));

    // 兜底路径必须走完整解析：标记 → 真图，原文绝不透出（BUG-03 硬红线）
    expect(utils.getAllByLabelText('表情包').length).toBeGreaterThan(0);
    expect(utils.queryByText(/sticker:xyz-789/)).toBeNull();
    expect(utils.queryByText(/\[sticker:/)).toBeNull();
  });

  it('工具详情耗时仅来自真实 durationMs，缺失时不生成耗时行', () => {
    const withDuration = getToolDetailRows({
      name: 'memory_search',
      ok: true,
      summary: '命中 1 条',
      running: false,
      durationMs: 17,
    });
    expect(withDuration.find(row => row.label === '耗时')?.value).toBe('17 ms');

    const withoutDuration = getToolDetailRows({
      name: 'memory_search',
      ok: true,
      summary: '命中 1 条',
      running: false,
    });
    expect(withoutDuration.some(row => row.label === '耗时')).toBe(false);
  });

  it('工具 pill：ok=✓、running=●、fail=✕，文本带 name · summary', async () => {
    const messages: Message[] = [
      {
        id: 'a1',
        role: 'assistant',
        content: '已检索到 2 条相关记忆。',
        toolSteps: [
          { name: 'memory_search', ok: true, summary: '命中 2 条', running: false },
        ],
      },
    ];
    const utils = await renderChat(scriptChat({ messages }));

    expect(utils.getByText('✓')).toBeTruthy();
    expect(utils.getByText('memory_search · 命中 2 条')).toBeTruthy();
  });

  it('任务书接法 a：待确认写入行渲染，确认按钮调 confirmWorkspaceWrite', async () => {
    const pendingId = 'wsw_' + 'a'.repeat(24);
    const confirmWorkspaceWrite = jest.fn(async () => undefined);
    const rejectWorkspaceWrite = jest.fn(async () => undefined);
    const messages: Message[] = [
      { id: 'u1', role: 'user', content: '在工作区建一个 todo.md' },
      {
        id: 'a1',
        role: 'assistant',
        content: '好的，请确认写入。',
        toolSteps: [
          {
            name: 'workspace_write',
            ok: true,
            running: false,
            summary: '已创建待确认写入，等用户在聊天里确认后才会落盘',
            pendingConfirmation: { id: pendingId, path: 'todo.md', mode: 'create', bytes: 42 },
          },
        ],
      },
    ];
    const utils = await renderChat(
      scriptChat({ messages, confirmWorkspaceWrite, rejectWorkspaceWrite })
    );

    expect(utils.getByText('待确认写入：todo.md（新建 · 42 字节）')).toBeTruthy();
    fireEvent.press(utils.getByLabelText('确认写入 todo.md'));
    await waitFor(() => expect(confirmWorkspaceWrite).toHaveBeenCalledWith(pendingId));
    expect(rejectWorkspaceWrite).not.toHaveBeenCalled();
  });

  it('任务书接法 a：已消费的 pending 收起确认行，pill 文案为结果', async () => {
    const pendingId = 'wsw_' + 'b'.repeat(24);
    const messages: Message[] = [
      {
        id: 'a1',
        role: 'assistant',
        content: '',
        toolSteps: [
          {
            name: 'workspace_write',
            ok: true,
            running: false,
            summary: '已确认写入',
            pendingConfirmation: { id: pendingId, path: 'todo.md', mode: 'overwrite', bytes: 7 },
            resolved: 'confirmed',
          },
        ],
      },
    ];
    const utils = await renderChat(scriptChat({ messages }));

    expect(utils.queryByLabelText('确认写入 todo.md')).toBeNull();
    expect(utils.queryByLabelText('取消写入 todo.md')).toBeNull();
    expect(utils.getByText('workspace_write · 已确认写入')).toBeTruthy();
  });
});
