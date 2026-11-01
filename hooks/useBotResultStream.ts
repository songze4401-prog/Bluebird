import { useEffect, useRef } from 'react';

import {
  subscribeAgentResults,
  type AgentResultPush,
} from '../lib/agent-results-stream';

/**
 * 主控结果流：当前会话保持一条 SSE；断线后指数退避重连。
 * 服务端 snapshot 会重发最近结果，调用方必须按消息 id 去重。
 */
export function useBotResultStream({
  sessionId,
  onResult,
  onDeliveryFailed,
  onError,
}: {
  sessionId: string;
  onResult: (result: AgentResultPush) => void;
  onDeliveryFailed?: (taskId: string, errorCode?: string) => void;
  onError?: (message: string) => void;
}) {
  const resultRef = useRef(onResult);
  const failedRef = useRef(onDeliveryFailed);
  const errorRef = useRef(onError);
  resultRef.current = onResult;
  failedRef.current = onDeliveryFailed;
  errorRef.current = onError;

  useEffect(() => {
    if (!sessionId) return;
    let disposed = false;
    let controller: AbortController | null = null;
    let retryTimer: ReturnType<typeof setTimeout> | null = null;
    let retryDelay = 1000;

    const connect = () => {
      if (disposed) return;
      controller = new AbortController();
      void subscribeAgentResults(sessionId, {
        signal: controller.signal,
        onOpen: () => {
          retryDelay = 1000;
        },
        onResult: result => {
          resultRef.current(result);
        },
        onDeliveryFailed: event => {
          failedRef.current?.(event.taskId, event.errorCode);
        },
      }).then(outcome => {
        controller = null;
        if (disposed) return;
        if (outcome.kind === 'error') {
          if (outcome.retryable === false) {
            errorRef.current?.(outcome.message);
            return;
          }
          retryTimer = setTimeout(connect, retryDelay);
          retryDelay = Math.min(15000, retryDelay * 2);
        }
      });
    };

    connect();
    return () => {
      disposed = true;
      controller?.abort();
      if (retryTimer) clearTimeout(retryTimer);
    };
  }, [sessionId]);
}
