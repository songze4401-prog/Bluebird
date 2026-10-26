// 在线状态感知（Presence V1）前端上报。
//
// 只做两件事：
//   1. 监听 React Native AppState，前台/后台切换立即上报；
//   2. 前台期间每 30 秒发一次心跳，用户发消息时补一次互动上报。
//
// 所有请求都走现有 Authorization: Bearer token，不引入新的密钥或依赖。
// 上报失败时静默降级：后端心跳过期后会把状态判为 unknown（不会误判为离线），
// 下一次心跳或互动成功后状态自动恢复一致。

import { useCallback, useEffect, useRef, useState } from 'react';
import { AppState, type AppStateStatus } from 'react-native';

import { apiFetch, TIMEOUTS } from './api/client';
import { API_PATHS } from './api/endpoints';
import { readJsonResponse } from './utils';

// 与后端 HEARTBEAT_TTL_MS（90 秒）配合：每 30 秒一次，允许丢一次心跳。
export const PRESENCE_HEARTBEAT_MS = 30 * 1000;

export type PresenceStatus = 'active' | 'away' | 'unknown';

export type PresenceSnapshot = {
  serverTime: string;
  sessionId: string | null;
  lastBlueMessageAt: string | null;
  user: {
    status: PresenceStatus;
    reason: string;
    lastSeenAt: string | null;
    lastInteractionAt: string | null;
    statusUpdatedAt: string | null;
    appState: 'foreground' | 'background' | 'unknown';
    appStateUpdatedAt: string | null;
    lastHeartbeatAt: string | null;
    heartbeatExpired: boolean;
    activeWindowSeconds: number;
    heartbeatTtlSeconds: number;
  };
  wait: {
    waiting: boolean;
    sessionId: string | null;
    lastUserMessageAt: string | null;
    lastBlueMessageAt: string | null;
    waitingSince: string | null;
    waitedSeconds: number;
  };
};

type PresenceReport = {
  appState?: 'foreground' | 'background';
  heartbeat?: boolean;
  interaction?: boolean;
  sessionId?: string;
};

// 单次应用运行内的客户端标识：服务端按 eventId 去重，重复启动/重试不会重复计数。
const CLIENT_ID = `${Date.now().toString(36)}-${Math.random()
  .toString(36)
  .slice(2, 10)}`;
let eventSeq = 0;

function nextEventId(): string {
  eventSeq += 1;
  return `${CLIENT_ID}-${eventSeq}`;
}

async function postPresence(
  report: PresenceReport
): Promise<PresenceSnapshot | null> {
  try {
    const response = await apiFetch(API_PATHS.presenceReport, {
      method: 'POST',
      // 心跳超时预算比默认短：宁可丢弃也拖住后续心跳
      timeoutMs: TIMEOUTS.presence,
      body: JSON.stringify({
        ...report,
        eventId: nextEventId(),
        occurredAt: new Date().toISOString(),
      }),
    });

    const data = await readJsonResponse(response);

    if (!response.ok || !data || typeof data.presence !== 'object') {
      return null;
    }

    return data.presence as PresenceSnapshot;
  } catch {
    // 网络断开 / 后端不可用：保持静默，交给后续心跳重试
    return null;
  }
}

export function usePresence(sessionId: string) {
  const [presence, setPresence] = useState<PresenceSnapshot | null>(null);

  const sessionRef = useRef(sessionId);
  const appStateRef = useRef<'foreground' | 'background'>(
    AppState.currentState === 'active' ? 'foreground' : 'background'
  );
  const lastReportedRef = useRef<'foreground' | 'background' | null>(null);
  const heartbeatRef = useRef<ReturnType<typeof setInterval> | null>(null);

  useEffect(() => {
    sessionRef.current = sessionId;
  }, [sessionId]);

  useEffect(() => {
    let alive = true;

    const apply = (snapshot: PresenceSnapshot | null) => {
      if (alive) setPresence(snapshot);
    };

    const send = async (report: PresenceReport) => {
      const snapshot = await postPresence({
        ...report,
        sessionId: sessionRef.current,
      });

      apply(snapshot);
    };

    const startHeartbeat = () => {
      if (heartbeatRef.current !== null) clearInterval(heartbeatRef.current);

      heartbeatRef.current = setInterval(() => {
        void send({ appState: 'foreground', heartbeat: true });
      }, PRESENCE_HEARTBEAT_MS);
    };

    const stopHeartbeat = () => {
      if (heartbeatRef.current !== null) {
        clearInterval(heartbeatRef.current);
        heartbeatRef.current = null;
      }
    };

    // 前后台切换是独立状态（不靠计时推断）：一进入后台就上报 background。
    // 重新回到前台时同时算一次互动，立即恢复 active。
    const applyAppState = (next: 'foreground' | 'background') => {
      if (lastReportedRef.current === next) return;

      lastReportedRef.current = next;
      appStateRef.current = next;

      if (next === 'foreground') {
        startHeartbeat();
        void send({ appState: 'foreground', interaction: true });
      } else {
        stopHeartbeat();
        void send({ appState: 'background' });
      }
    };

    const handleAppStateChange = (next: AppStateStatus) => {
      applyAppState(next === 'active' ? 'foreground' : 'background');
    };

    // 冷启动：AppState.currentState 为 active 时立即上报前台 + 互动
    applyAppState(appStateRef.current);

    const subscription = AppState.addEventListener(
      'change',
      handleAppStateChange
    );

    return () => {
      alive = false;
      subscription.remove();
      stopHeartbeat();
    };
  }, []);

  // 用户产生有效互动（发消息 / 继续说）时立即刷新活跃时间。
  const reportInteraction = useCallback((targetSessionId?: string) => {
    if (appStateRef.current !== 'foreground') return;

    void postPresence({
      appState: 'foreground',
      interaction: true,
      sessionId: targetSessionId ?? sessionRef.current,
    }).then(setPresence);
  }, []);

  return {
    presence,
    // 接口不可用时本地同样视为 unknown，不把失败当成离线
    status: presence?.user.status ?? ('unknown' as PresenceStatus),
    reportInteraction,
  };
}
