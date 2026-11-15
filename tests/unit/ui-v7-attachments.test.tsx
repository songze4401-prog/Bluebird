/// <reference types="jest" />
/**
 * v7 附件入口接真（R2）：
 *   ① 加号面板「图片」走真实相册入口 attachments.pickImage('album')
 *   ② 待发送图片显示缩略图、可移除；只有图片（无文字）也能发送，且仍走 overrideText 通道
 *   ③ 上传中禁用发送，不发半成品请求（走 TextInput 提交路径，直接验证 doSend 守卫）
 *
 * RNTL 14 的 fireEvent 返回 Promise：每次 fireEvent 都必须 await，
 * 否则异步 act 会跨用例泄漏，导致后续 render 的查询看不到新树。
 */
import React from 'react';
import { fireEvent, render, waitFor } from '@testing-library/react-native';

import { ChatScreen } from '../../app/ChatScreen';
import { UiStateProvider } from '../../app/ui-state';
import type { ChatSessionApi } from '../../hooks/useChatSession';
import type { AttachmentsApi } from '../../hooks/useAttachments';

jest.mock('react-native-safe-area-context', () =>
  require('react-native-safe-area-context/jest/mock').default
);

function makeChat(sendMessage: jest.Mock = jest.fn(async () => undefined)): ChatSessionApi {
  return {
    messages: [],
    loadingHistory: false,
    sending: false,
    mood: 'calm',
    liveToolSteps: [],
    sendMessage,
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
  };
}

function makeAttachments(overrides: Partial<AttachmentsApi> = {}): AttachmentsApi {
  return {
    pendingAttachments: [],
    uploadingImage: false,
    pickImage: async () => undefined,
    pickSticker: async () => null,
    removeAttachment: () => undefined,
    clearAttachments: () => undefined,
    ...overrides,
  };
}

async function renderAttachments(attachments: AttachmentsApi, sendMessage?: jest.Mock) {
  return render(
    <UiStateProvider>
      <ChatScreen
        chat={makeChat(sendMessage)}
        modelLabel="DeepSeek"
        models={[]}
        currentModel={null}
        onSelectModel={async () => true}
        attachments={attachments}
      />
    </UiStateProvider>
  );
}

describe('v7 附件入口（真实上传通道）', () => {
  it('加号面板「图片」调用 pickImage(album)', async () => {
    const pickImage = jest.fn(async () => undefined);
    const utils = await renderAttachments(makeAttachments({ pickImage }));

    await fireEvent.press(utils.getByLabelText('更多选项'));
    // 面板状态在 act 之后才落地：等指针事件放行再点「图片」
    await waitFor(() => expect(utils.getByLabelText('关闭加号面板')).toBeTruthy());
    await fireEvent.press(utils.getByLabelText('图片'));

    await waitFor(() => expect(pickImage).toHaveBeenCalledWith('album'));
  });

  it('待发送图片可移除，且只有图片也能发送（overrideText 空串）', async () => {
    const sendMessage = jest.fn(async () => undefined);
    const removeAttachment = jest.fn();
    const utils = await renderAttachments(
      makeAttachments({
        removeAttachment,
        pendingAttachments: [
          {
            attachment: { id: 'up-1', kind: 'image', mime: 'image/png', name: 'p.png' },
            previewUri: 'file:///tmp/p.png',
          },
        ],
      }),
      sendMessage
    );

    await fireEvent.press(utils.getByLabelText('移除图片'));
    expect(removeAttachment).toHaveBeenCalledWith('up-1');

    await fireEvent.press(utils.getByLabelText('发送'));
    await waitFor(() => {
      expect(sendMessage).toHaveBeenCalledWith(undefined, undefined, {
        overrideText: '',
      });
    });
  });

  it('上传中禁用发送，不发半成品请求', async () => {
    const sendMessage = jest.fn(async () => undefined);
    const utils = await renderAttachments(
      makeAttachments({ uploadingImage: true }),
      sendMessage
    );

    await waitFor(() => expect(utils.getByText('…')).toBeTruthy());

    // 走键盘提交路径（不受发送钮 disabled 影响），直接验证 doSend 的上传守卫
    const input = utils.getByPlaceholderText('与 Bluebird 对话…');
    await fireEvent.changeText(input, '你好');
    await waitFor(() => expect(utils.getByDisplayValue('你好')).toBeTruthy());
    await fireEvent(input, 'submitEditing');

    expect(sendMessage).not.toHaveBeenCalled();
  });
});
