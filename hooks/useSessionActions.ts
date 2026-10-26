// 会话生命周期操作（阶段 2）。
//
// 新建 / 选择 / 删除会话需要同时动三处状态：服务端会话表、当前会话 id、
// 消息列表。重构前三者都散在 App 里并用 6 个闭包拼起来；现在集中在这里，
// App 只负责把两个 hook 传进来，并在进入聊天页时切屏。
//
// 这里刻意不拥有 currentSessionId：它属于 App 的组合状态（聊天 hook 也要用），
// 由调用方传入 setter，避免 hooks 之间循环依赖。

import { useState } from 'react';
import { Alert } from 'react-native';

import { apiFetch } from '../lib/api/client';
import { readJsonResponse } from '../lib/utils';
import { DEFAULT_SESSION_ID } from '../lib/constants';
import type { ChatSessionApi } from './useChatSession';
import type { SessionListApi } from './useSessionList';

export type SessionActionsApi = {
  // 任一聊天/会话请求进行中：用于禁用入口，防连点与并发串会话
  busy: boolean;
  creatingSession: boolean;
  createNewChat: () => Promise<void>;
  // 选中会话并加载历史；失败时提示且不切会话
  selectSession: (sessionId: string) => Promise<void>;
  // 删除会话：删的是当前会话时退回默认会话；成功后重拉列表
  deleteSession: (sessionId: string) => Promise<boolean>;
};

export function useSessionActions({
  chat,
  sessionList,
  currentSessionId,
  setCurrentSessionId,
  onEnterChat,
}: {
  chat: ChatSessionApi;
  sessionList: SessionListApi;
  currentSessionId: string;
  setCurrentSessionId: (sessionId: string) => void;
  onEnterChat: () => void;
}): SessionActionsApi {
  // 新建会话请求进行中（防连点）
  const [creatingSession, setCreatingSession] = useState(false);

  const busy =
    creatingSession || chat.sending || chat.continuing || chat.loadingHistory;

  // 新建聊天：点击即创建独立会话（POST /sessions），进入空的聊天页
  const createNewChat = async () => {
    if (busy) return;

    setCreatingSession(true);

    try {
      const response = await apiFetch('/sessions', {
        method: 'POST',
        body: JSON.stringify({}),
      });

      const data = await readJsonResponse(response);

      if (!response.ok || !data.session?.id) {
        throw new Error(data.error || '新建会话失败');
      }

      setCurrentSessionId(data.session.id);
      chat.resetMessages();
      onEnterChat();
    } catch (error) {
      console.error('Create session error:', error);
      Alert.alert(
        '新建聊天失败',
        error instanceof Error && error.message.includes('新建会话失败')
          ? error.message
          : '暂时无法连接会话服务，请稍后再试。'
      );
    } finally {
      setCreatingSession(false);
    }
  };

  // 从历史列表选择一个会话：加载它的消息并进入聊天页
  const selectSession = async (sessionId: string) => {
    if (chat.sending || chat.continuing || chat.loadingHistory) return;

    const result = await chat.loadHistory(sessionId);

    // 已被更新的选择取代：本次结果作废，不改会话也不弹错（由最新那次收场）
    if (result.stale) return;

    if (!result.ok) {
      Alert.alert(
        '打开会话失败',
        result.status === 404
          ? '会话不存在，可能已被清理。'
          : '读取会话记录失败，请稍后再试。'
      );
      return;
    }

    setCurrentSessionId(sessionId);
    onEnterChat();
  };

  // 删除会话：DELETE /sessions/:id。删除的是当前会话时切回默认会话，
  // 服务端保证 default 被删后会立即重建为空会话，不会留下悬空 id
  const deleteSession = async (sessionId: string): Promise<boolean> => {
    try {
      const response = await apiFetch(
        `/sessions/${encodeURIComponent(sessionId)}`,
        { method: 'DELETE' }
      );

      const data = await readJsonResponse(response);

      if (!response.ok) {
        throw new Error(data.error || '删除失败');
      }

      if (sessionId === currentSessionId) {
        setCurrentSessionId(DEFAULT_SESSION_ID);
        chat.resetMessages();
      }

      // 删除后重拉列表，保证列表与服务端一致
      await sessionList.refresh();

      return true;
    } catch (error) {
      console.error('Delete session error:', error);
      Alert.alert('失败', '删除会话失败，请稍后再试。');
      return false;
    }
  };

  return { busy, creatingSession, createNewChat, selectSession, deleteSession };
}
