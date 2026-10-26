// 会话列表的唯一数据源（阶段 2）。
//
// 重构前 App 与 HistoryScreen 各自 GET /sessions，导致两份列表、两套 loading、
// 删除后其中一份不刷新。现在列表只在这里维护：
//   - App 启动时用 refresh() 拿「最近更新的会话」做恢复目标
//   - HistoryScreen 用 props 接收同一份列表（受控），删除/打开时调 App 的 refresh
//
// 阶段 3 增补：并发刷新只认最后一次（请求令牌 + 取消上一个），
// 避免「打开历史 → 立刻删除 → 打开历史」这类连点导致列表回退到旧快照。

import { useCallback, useEffect, useState } from 'react';

import { apiFetch } from '../lib/api/client';
import { API_PATHS } from '../lib/api/endpoints';
import { apiErrorFromPayload } from '../lib/api/errors';
import { createRequestGate } from '../lib/api/latest-request';
import { readJsonResponse } from '../lib/utils';
import type { SessionsResponse } from '../lib/api/types';
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

  // 并发刷新只认最后一次（规则见 lib/api/latest-request）。
  // 用 useState 惰性持有稳定实例：不参与渲染，也不会在每次渲染重建。
  const [gate] = useState(createRequestGate);

  // 卸载时中止在途请求，避免卸载后写 state
  useEffect(() => () => gate.abort(), [gate]);

  const refresh = useCallback(async (): Promise<SessionMeta[] | null> => {
    const ticket = gate.begin();

    setLoading(true);
    setError('');

    try {
      const response = await apiFetch(API_PATHS.sessions, {
        signal: ticket.signal,
      });

      const data = (await readJsonResponse(response)) as SessionsResponse;

      // 已被更新的刷新取代：不覆盖列表、不改 loading
      if (!gate.isCurrent(ticket.id)) return null;

      if (!response.ok || !Array.isArray(data.sessions)) {
        throw apiErrorFromPayload(data, response.status, '读取失败');
      }

      const list = data.sessions as SessionMeta[];

      setSessions(list);

      return list;
    } catch (err) {
      // 被更新的刷新取消：不是错误，交给最新那次收场
      if (!gate.isCurrent(ticket.id)) return null;

      // 单历史模式兜底：列表拿不到不阻塞聊天，调用方用默认会话继续
      console.error('Load sessions error:', err);
      setError(SESSIONS_ERROR_TEXT);
      return null;
    } finally {
      if (gate.isCurrent(ticket.id)) setLoading(false);
    }
  }, [gate]);

  return { sessions, loading, error, refresh };
}
