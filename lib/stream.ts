// 流式聊天客户端：POST /chat/stream 的 SSE 读取。
// React Native 的 fetch 不支持读取流式响应体，也没有原生 EventSource；
// 这里用 XMLHttpRequest 的 onprogress 增量读 responseText（RN 全版本含
// Expo Go 均支持，不新增依赖），按 SSE 的 \n\n 分帧、解析 data: 行 JSON。

import { API_TOKEN } from './constants';
import { ReplySegment } from './types';

// done 事件的载荷：字段与 POST /chat 的响应完全一致
export type StreamDonePayload = {
  reply?: string;
  replies?: ReplySegment[];
  model?: string;
  sessionId?: string;
  persisted?: boolean;
  mood?: string;
  intensity?: number;
  userMessageId?: string | null;
  assistantMessageId?: string;
  createdAt?: string;
};

export type StreamOutcome =
  | { kind: 'done'; data: StreamDonePayload }
  // 一个 delta 都没收到就失败：服务端未开始生成或不支持流式（旧版本 404），
  // 可安全回退到非流式 /chat，不会产生两条不同回复
  | { kind: 'fallback' }
  | { kind: 'error'; message: string };

export type StreamEvent = {
  type?: string;
  content?: string;
  error?: string;
};

// SSE 增量解析器：分帧逻辑独立为纯函数，便于测试与复用。
// 用法：网络层每拿到一段新文本就 push()，解析出完整事件时回调 onEvent。
export function createSSEParser(onEvent: (event: StreamEvent) => void) {
  let buffer = '';

  return {
    push(text: string) {
      buffer += text;

      let sep = buffer.indexOf('\n\n');

      while (sep >= 0) {
        const rawEvent = buffer.slice(0, sep);
        buffer = buffer.slice(sep + 2);

        for (const line of rawEvent.split('\n')) {
          const trimmed = line.trimEnd();
          if (!trimmed.startsWith('data:')) continue;

          const payload = trimmed.slice(5).trim();
          if (!payload) continue;

          try {
            onEvent(JSON.parse(payload) as StreamEvent);
          } catch {
            // 无法解析的行直接忽略，等下一帧
          }
        }

        sep = buffer.indexOf('\n\n');
      }
    },
  };
}

// 发起流式聊天请求并消费到结束。
// 超时沿用现有 /chat 的 60s 预算；onDelta 回调只做渲染，不参与成败判定。
export function streamChatRequest(
  payload: Record<string, unknown>,
  handlers: { onDelta: (content: string) => void }
): Promise<StreamOutcome> {
  return new Promise(resolve => {
    let receivedDelta = false;
    let finished = false;

    const finish = (outcome: StreamOutcome) => {
      if (finished) return;
      finished = true;
      resolve(outcome);
    };

    const parser = createSSEParser(event => {
      if (event.type === 'delta' && typeof event.content === 'string') {
        if (event.content) {
          receivedDelta = true;
          handlers.onDelta(event.content);
        }
        return;
      }

      if (event.type === 'done') {
        finish({ kind: 'done', data: event as StreamDonePayload });
        return;
      }

      if (event.type === 'error') {
        finish({
          kind: 'error',
          message:
            typeof event.error === 'string' && event.error
              ? event.error
              : '连接Bluebird失败了，再试一次。',
        });
      }
    });

    const xhr = new XMLHttpRequest();
    let processed = 0;

    const consume = () => {
      const text = xhr.responseText || '';
      if (text.length > processed) {
        parser.push(text.slice(processed));
        processed = text.length;
      }
    };

    xhr.onprogress = () => consume();

    xhr.onload = () => {
      consume(); // 收尾：解析最后到达的字节

      if (finished) return; // 已收到 done / error 事件

      if (xhr.status !== 200) {
        // 旧服务端没有 /chat/stream（404）或连接根本没建立（status 0）：
        // 此时不会有任何 delta，回退非流式是安全的
        if (!receivedDelta && (xhr.status === 404 || xhr.status === 0)) {
          finish({ kind: 'fallback' });
          return;
        }

        // 校验类错误（400/401/429/500）对非流式同样成立，回退只会重现
        // 同样的错误，直接报出来更符合预期
        let message = '连接Bluebird失败了，再试一次。';

        try {
          const data = JSON.parse(xhr.responseText || '');
          if (typeof data.error === 'string' && data.error) {
            message = data.error;
          }
        } catch {
          /* 非 JSON 错误体，用默认文案 */
        }

        finish({ kind: 'error', message });
        return;
      }

      // 200 但连接中断（没收到 done）：已收到过 delta 说明生成已开始，
      // 回退会生成另一条不同回复，只能报错；没收到过则可安全回退
      finish(
        receivedDelta
          ? { kind: 'error', message: '连接Bluebird中断了，再试一次。' }
          : { kind: 'fallback' }
      );
    };

    xhr.onerror = () => {
      finish(
        receivedDelta
          ? { kind: 'error', message: '连接Bluebird失败了，再试一次。' }
          : { kind: 'fallback' }
      );
    };

    xhr.ontimeout = () => {
      finish({ kind: 'error', message: '连接Bluebird超时了，再试一次。' });
    };

    try {
      xhr.open('POST', `${process.env.EXPO_PUBLIC_API_URL}/chat/stream`);
      xhr.setRequestHeader('Content-Type', 'application/json');
      xhr.setRequestHeader('Authorization', `Bearer ${API_TOKEN}`);
      xhr.timeout = 60000;
      xhr.send(JSON.stringify(payload));
    } catch {
      finish({ kind: 'fallback' });
    }
  });
}
