// 主控结果 SSE 客户端：任务完成后由服务端 push 到当前主控会话。
// 与任务页轮询解耦；snapshot 用于断线重连，客户端按消息 id 去重。
import { API_BASE } from './api/client';
import { API_TOKEN } from './constants';
import type { AgentChatMessage } from './api/types';

export type AgentResultEvent =
  | {
      type: 'snapshot';
      sessionId: string;
      results: AgentResultPush[];
    }
  | AgentResultPush
  | {
      type: 'delivery_failed';
      taskId: string;
      sessionId: string;
      errorCode?: string;
    };

export type AgentResultPush = {
  type: 'result';
  taskId: string;
  sessionId: string;
  status: string;
  result?: Record<string, unknown> | null;
  errorCode?: string | null;
  message?: AgentChatMessage;
};

export type AgentResultStreamOutcome =
  | { kind: 'closed' }
  | { kind: 'error'; message: string };

function parseFrame(frame: string): AgentResultEvent | null {
  for (const line of frame.split('\n')) {
    const trimmed = line.trimEnd();
    if (!trimmed.startsWith('data:')) continue;
    const payload = trimmed.slice(5).trim();
    if (!payload) continue;
    try {
      return JSON.parse(payload) as AgentResultEvent;
    } catch {
      return null;
    }
  }
  return null;
}

export function subscribeAgentResults(
  sessionId: string,
  handlers: {
    onResult?: (result: AgentResultPush) => void;
    onDeliveryFailed?: (event: Extract<AgentResultEvent, { type: 'delivery_failed' }>) => void;
    signal?: AbortSignal;
  } = {}
): Promise<AgentResultStreamOutcome> {
  return new Promise(resolve => {
    let finished = false;
    let processed = 0;
    let buffer = '';
    const externalSignal = handlers.signal;

    const finish = (outcome: AgentResultStreamOutcome) => {
      if (finished) return;
      finished = true;
      if (externalSignal) externalSignal.removeEventListener('abort', onAbort);
      resolve(outcome);
    };
    const onAbort = () => {
      if (finished) return;
      try {
        xhr.abort();
      } catch {
        // XHR may not be open yet.
      }
      finish({ kind: 'closed' });
    };

    const handle = (event: AgentResultEvent | null) => {
      if (!event) return;
      if (event.type === 'snapshot') {
        for (const result of event.results || []) handlers.onResult?.(result);
        return;
      }
      if (event.type === 'result') {
        handlers.onResult?.(event);
        return;
      }
      if (event.type === 'delivery_failed') {
        handlers.onDeliveryFailed?.(event);
      }
    };

    const parse = (text: string) => {
      buffer += text;
      let sep = buffer.indexOf('\n\n');
      while (sep >= 0) {
        const frame = buffer.slice(0, sep);
        buffer = buffer.slice(sep + 2);
        handle(parseFrame(frame));
        sep = buffer.indexOf('\n\n');
      }
    };

    const xhr = new XMLHttpRequest();
    xhr.open(
      'GET',
      `${API_BASE}/agent-results/stream?sessionId=${encodeURIComponent(sessionId)}`
    );
    xhr.setRequestHeader('Authorization', `Bearer ${API_TOKEN}`);
    xhr.setRequestHeader('Accept', 'text/event-stream');
    xhr.onprogress = () => {
      const text = xhr.responseText || '';
      if (text.length > processed) {
        parse(text.slice(processed));
        processed = text.length;
      }
    };
    xhr.onload = () => {
      if (finished) return;
      const text = xhr.responseText || '';
      if (text.length > processed) parse(text.slice(processed));
      finish({ kind: 'closed' });
    };
    xhr.onerror = () => finish({ kind: 'error', message: '结果事件流连接失败' });
    xhr.onabort = () => finish({ kind: 'closed' });

    if (externalSignal) {
      if (externalSignal.aborted) {
        onAbort();
        return;
      }
      externalSignal.addEventListener('abort', onAbort, { once: true });
    }
    xhr.send();
  });
}
