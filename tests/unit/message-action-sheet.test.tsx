/// <reference types="jest" />
// 消息操作面板：复制/分享使用真实系统能力，收藏/删除只上抛给父级。
import React from 'react';
import { Alert, Clipboard, Share } from 'react-native';
import { cleanup, fireEvent, render, screen } from '@testing-library/react-native';

import { MessageActionSheet } from '../../components/MessageActionSheet';
import { getTheme } from '../../theme';
import type { Message } from '../../lib/types';

const theme = getTheme('dark', 'blue');
const message: Message = {
  id: 'm1',
  role: 'assistant',
  content: '一条可以复制的回复',
  createdAt: '2026-10-30T10:00:00.000Z',
};

describe('MessageActionSheet', () => {
  beforeEach(() => {
    jest.spyOn(Alert, 'alert').mockImplementation(() => {});
    jest.spyOn(Clipboard, 'setString').mockImplementation(() => {});
    jest.spyOn(Share, 'share').mockResolvedValue({ action: 'sharedAction', activityType: undefined });
  });

  afterEach(async () => {
    await cleanup();
    jest.restoreAllMocks();
  });

  it('复制使用剪贴板并反馈', async () => {
    const onClose = jest.fn();
    await render(
      <MessageActionSheet
        visible
        message={message}
        theme={theme}
        isFavorite={false}
        onClose={onClose}
        onToggleFavorite={() => {}}
        onDelete={() => {}}
      />
    );

    fireEvent.press(screen.getByLabelText('复制'));
    expect(Clipboard.setString).toHaveBeenCalledWith(message.content);
    expect(onClose).toHaveBeenCalled();
  });

  it('收藏、分享与删除走父级/系统能力，不伪造服务端成功', async () => {
    const onToggleFavorite = jest.fn();
    const onDelete = jest.fn();
    const onClose = jest.fn();
    await render(
      <MessageActionSheet
        visible
        message={message}
        theme={theme}
        isFavorite
        onClose={onClose}
        onToggleFavorite={onToggleFavorite}
        onDelete={onDelete}
      />
    );

    expect(screen.getByLabelText('取消收藏')).toBeTruthy();
    fireEvent.press(screen.getByLabelText('取消收藏'));
    expect(onToggleFavorite).toHaveBeenCalledWith(message);

    onClose.mockClear();
    fireEvent.press(screen.getByLabelText('分享'));
    expect(Share.share).toHaveBeenCalledWith({ message: message.content });

    fireEvent.press(screen.getByLabelText('从本机隐藏'));
    expect(onDelete).toHaveBeenCalledWith(message);
  });

});
