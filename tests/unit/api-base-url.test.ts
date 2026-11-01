/// <reference types="jest" />
// P3-03：所有拼 URL 的地方都必须经过 API_BASE + API_PATHS。
//
// 旧缺陷：stream.ts / uploads.ts 直接读 process.env.EXPO_PUBLIC_API_URL，
// 未配置该变量时拼出 "undefined/uploads/image/xxx" 或 "undefined/chat/stream"，
// 请求必然 404——而且只在真机上暴露，jest 之前完全测不到。
//
// 这里不只断言常量，而是真的把 XHR 换掉，捕获四个模块实际 open 的 URL：
// 任何一处绕过 API_BASE（回到裸 env 读取或手写路径）都会在这里失败。

import { API_BASE } from '../../lib/api/client';
import { API_PATHS } from '../../lib/api/endpoints';
import { imageUrl, stickerImageUrl } from '../../lib/uploads';
import { streamChatRequest } from '../../lib/stream';
import { sendAgentChatStream } from '../../lib/agent-stream';
import { subscribeAgentResults } from '../../lib/agent-results-stream';

class FakeXHR {
  static last: FakeXHR | null = null;
  openedMethod = '';
  openedUrl = '';
  onprogress: (() => void) | null = null;
  onload: (() => void) | null = null;
  onerror: (() => void) | null = null;
  ontimeout: (() => void) | null = null;
  responseText = '';
  status = 0;
  timeout = 0;

  constructor() {
    FakeXHR.last = this;
  }

  open(method: string, url: string) {
    this.openedMethod = method;
    this.openedUrl = url;
  }

  setRequestHeader() {}
  send() {}
  abort() {}
}

const ID = 'abc-123';

describe('API_BASE 兜底（EXPO_PUBLIC_API_URL 未配置）', () => {
  it('API_BASE 为空字符串而不是 undefined', () => {
    expect(API_BASE).not.toBeUndefined();
    expect(typeof API_BASE).toBe('string');
  });

  it('图片地址与表情包地址不带 undefined 前缀', () => {
    expect(imageUrl(ID)).not.toContain('undefined');
    expect(stickerImageUrl(ID)).not.toContain('undefined');
    expect(imageUrl(ID)).toBe(`${API_BASE}${API_PATHS.uploadImage(ID)}`);
    expect(stickerImageUrl(ID)).toBe(`${API_BASE}${API_PATHS.stickerImage(ID)}`);
  });
});

describe('XHR 打开的 URL 全部来自 API_BASE + API_PATHS', () => {
  const original = global.XMLHttpRequest;

  beforeEach(() => {
    FakeXHR.last = null;
    (global as unknown as { XMLHttpRequest: typeof FakeXHR }).XMLHttpRequest =
      FakeXHR;
  });

  afterAll(() => {
    (global as unknown as { XMLHttpRequest: typeof original }).XMLHttpRequest =
      original;
  });

  it('stream.ts：/chat/stream', async () => {
    const controller = new AbortController();
    const promise = streamChatRequest(
      { message: 'hi' },
      { onDelta: () => {}, signal: controller.signal }
    );

    expect(FakeXHR.last?.openedMethod).toBe('POST');
    expect(FakeXHR.last?.openedUrl).toBe(`${API_BASE}${API_PATHS.chatStream}`);

    controller.abort();
    await expect(promise).resolves.toEqual({ kind: 'aborted' });
  });

  it('agent-stream.ts：/agents/:id/chat/stream（botId 编码）', async () => {
    const controller = new AbortController();
    const promise = sendAgentChatStream(
      'memory',
      { message: 'hi' },
      { signal: controller.signal }
    );

    expect(FakeXHR.last?.openedMethod).toBe('POST');
    expect(FakeXHR.last?.openedUrl).toBe(
      `${API_BASE}${API_PATHS.agentChatStream('memory')}`
    );
    expect(FakeXHR.last?.openedUrl).toContain('/agents/memory/chat/stream');

    controller.abort();
    await promise;
  });

  it('agent-results-stream.ts：/agent-results/stream（sessionId 编码）', async () => {
    const controller = new AbortController();
    const promise = subscribeAgentResults(ID, { signal: controller.signal });

    expect(FakeXHR.last?.openedMethod).toBe('GET');
    expect(FakeXHR.last?.openedUrl).toBe(
      `${API_BASE}${API_PATHS.agentResultsStream(ID)}`
    );
    expect(FakeXHR.last?.openedUrl).toContain(
      `sessionId=${encodeURIComponent(ID)}`
    );

    controller.abort();
    await promise;
  });
});

describe('路径常量与重构前字面量一致', () => {
  it('agentChatStream 与 agentResultsStream 逐字匹配旧的内联拼接', () => {
    expect(API_PATHS.agentChatStream('memory')).toBe(
      `/agents/${encodeURIComponent('memory')}/chat/stream`
    );
    expect(API_PATHS.agentResultsStream(ID)).toBe(
      `/agent-results/stream?sessionId=${encodeURIComponent(ID)}`
    );
  });
});
