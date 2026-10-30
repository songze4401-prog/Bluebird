// Memory Bot 的 XHR SSE 客户端：React Native fetch 不能读取流式响应体，
// 与 lib/stream.ts 同思路，但事件契约走 /agents/:botId/chat/stream 的
// token delta（delta 字段）与结构化任务/工具事件。
import { API_BASE } from './api/client';
import { API_TOKEN } from './constants';
import type { AgentChatResponse, AgentChatMessage } from './api/types';

export type AgentStreamEvent =
  | { type: 'meta'; botId?: string; sessionId?: string | null; stream?: string }
  | { type: 'delta'; delta: string }
  | {
      type: 'tool_start' | 'tool_end';
      name: string;
      callId: string;
      ok?: boolean;
      summary?: string;
      code?: string;
    }
  | ({ type: 'done' } & AgentChatResponse)
  | { type: 'error'; error?: string; code?: string };

export type AgentStreamOutcome =
  | { kind: 'done'; data: AgentChatResponse }
  | { kind: 'fallback' }
  | { kind: 'aborted' }
  | { kind: 'error'; message: string };

function parseFrame(frame: string): AgentStreamEvent | null {
  for (const line of frame.split('\n')) {
    const trimmed = line.trimEnd();
    if (!trimmed.startsWith('data:')) continue;
    const payload = trimmed.slice(5).trim();
    if (!payload) continue;
    try {
      return JSON.parse(payload) as AgentStreamEvent;
    } catch {
      return null;
    }
  }
  return null;
}

export function sendAgentChatStream(
  botId: string,
  payload: { sessionId?: string | null; message: string },
  handlers: {
    onDelta?: (delta: string) => void;
    onToolEvent?: (event: Extract<AgentStreamEvent, { type: 'tool_start' | 'tool_end' }>) => void;
    signal?: AbortSignal;
  } = {}
): Promise<AgentStreamOutcome> {
  return new Promise(resolve => {
    let receivedDelta = false;
    let finished = false;
    let processed = 0;
    let buffer = '';
    const externalSignal = handlers.signal;

    const finish = (outcome: AgentStreamOutcome) => {
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
      finish({ kind: 'aborted' });
    };

    const parse = (text: string) => {
      buffer += text;
      let sep = buffer.indexOf('\n\n');
      while (sep >= 0) {
        const frame = buffer.slice(0, sep);
        buffer = buffer.slice(sep + 2);
        const event = parseFrame(frame);
        if (event) {
          if (event.type === 'delta' && typeof event.delta === 'string') {
            if (event.delta) {
              receivedDelta = true;
              handlers.onDelta?.(event.delta);
            }
          } else if (event.type === 'done') {
            finish({ kind: 'done', data: event as AgentChatResponse });
            return;
          } else if (event.type === 'tool_start' || event.type === 'tool_end') {
            handlers.onToolEvent?.(event);
          } else if (event.type === 'error') {
            finish({
              kind: 'error',
              message:
                typeof event.error === 'string' && event.error
                  ? event.error
                  : 'Memory Bot 流式请求失败',
            });
            return;
          }
        }
        sep = buffer.indexOf('\n\n');
      }
    };

    const xhr = new XMLHttpRequest();
    xhr.open('POST', `${API_BASE}/agents/${encodeURIComponent(botId)}/chat/stream`);
    xhr.setRequestHeader('Content-Type', 'application/json');
    xhr.setRequestHeader('Authorization', `Bearer ${API_TOKEN}`);
    xhr.timeout = 60_000;

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
      if (finished) return;
      if (xhr.status === 404 || xhr.status === 0) {
        finish({ kind: 'fallback' });
      } else if (!receivedDelta) {
        finish({ kind: 'fallback' });
      } else {
        finish({ kind: 'error', message: 'Memory Bot 流式响应提前结束' });
      }
    };
    xhr.onerror = () => finish({ kind: 'error', message: 'Memory Bot 连接失败' });
    xhr.ontimeout = () => finish({ kind: 'error', message: 'Memory Bot 流式请求超时' });

    if (externalSignal) {
      if (externalSignal.aborted) {
        onAbort();
        return;
      }
      externalSignal.addEventListener('abort', onAbort, { once: true });
    }

    xhr.send(JSON.stringify(payload));
  });
}

export function emptyAgentMessage(id: string): AgentChatMessage {
  return {
    id,
    role: 'assistant',
    content: '',
    createdAt: new Date().toISOString(),
    toolSteps: [],
  };
}
