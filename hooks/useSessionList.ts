// 会话列表的唯一数据源（阶段 2）。
//
// 重构前 App 与 HistoryScreen 各自 GET /sessions，导致两份列表、两套 loading、
// 删除后其中一份不刷新。现在列表只在这里维护：
//   - App 启动时用 refresh() 拿「最近更新的会话」做恢复目标
//   - HistoryScreen 用 props 接收同一份列表（受控），删除/打开时调 App 的 refresh

import { useCallback, useState } from 'react';

import { apiFetch } from '../lib/api/client';
import { readJsonResponse } from '../lib/utils';
import type { SessionMeta } from '../lib/types';

export const SESSIONS_ERROR_TEXT = '读取会话列表失败，请稍后再试。';

export type SessionListApi = {
  sessions: SessionMeta[];
  loading: boolean;
  error: string;
  // 拉取失败返回 null（调用方据此判断是否需要退回默认会话）
  refresh: () => Promise<SessionMeta[] | null>;
};

export function useSessionList(): SessionListApi {
  const [sessions, setSessions] = useState<SessionMeta[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');

  const refresh = useCallback(async (): Promise<SessionMeta[] | null> => {
    setLoading(true);
    setError('');

    try {
      const response = await apiFetch('/sessions');

      const data = await readJsonResponse(response);

      if (!response.ok || !Array.isArray(data.sessions)) {
        throw new Error(data.error || '读取失败');
      }

      const list = data.sessions as SessionMeta[];

      setSessions(list);

      return list;
    } catch (err) {
      // 单历史模式兜底：列表拿不到不阻塞聊天，调用方用默认会话继续
      console.error('Load sessions error:', err);
      setError(SESSIONS_ERROR_TEXT);
      return null;
    } finally {
      setLoading(false);
    }
  }, []);

  return { sessions, loading, error, refresh };
}
