/// <reference types="jest" />
/**
 * 主控结果 SSE 的连接分类：非 200、200 干净关闭、主动 abort。
 * 只有可重试错误才应触发 Hook 的指数退避重连；401/404 不应无限重试。
 */
import { subscribeAgentResults } from '../../lib/agent-results-stream';

class FakeXHR {
  static instances: FakeXHR[] = [];

  status = 200;
  responseText = '';
  onload: (() => void) | null = null;
  onerror: (() => void) | null = null;
  onabort: (() => void) | null = null;
  onprogress: (() => void) | null = null;

  constructor() {
    FakeXHR.instances.push(this);
  }

  open() {}
  setRequestHeader() {}
  send() {}
  abort() {
    this.onabort?.();
  }
}

describe('主控结果 SSE 连接分类', () => {
  const originalXHR = (global as { XMLHttpRequest?: unknown }).XMLHttpRequest;

  beforeEach(() => {
    FakeXHR.instances = [];
    (global as { XMLHttpRequest?: unknown }).XMLHttpRequest = FakeXHR;
  });

  afterAll(() => {
    (global as { XMLHttpRequest?: unknown }).XMLHttpRequest = originalXHR;
  });

  it('401 不重试，5xx 与 200 干净关闭可重试，主动 abort 为 closed', async () => {
    const unauthorized = subscribeAgentResults('sess-A');
    const unauthorizedXhr = FakeXHR.instances[0];
    unauthorizedXhr.status = 401;
    unauthorizedXhr.responseText = JSON.stringify({ error: 'Unauthorized' });
    unauthorizedXhr.onload?.();
    await expect(unauthorized).resolves.toMatchObject({
      kind: 'error',
      status: 401,
      retryable: false,
    });

    const serverError = subscribeAgentResults('sess-A');
    const serverErrorXhr = FakeXHR.instances[1];
    serverErrorXhr.status = 500;
    serverErrorXhr.responseText = JSON.stringify({ error: '结果流暂时不可用' });
    serverErrorXhr.onload?.();
    await expect(serverError).resolves.toMatchObject({
      kind: 'error',
      status: 500,
      retryable: true,
    });

    const cleanClose = subscribeAgentResults('sess-A');
    const cleanCloseXhr = FakeXHR.instances[2];
    cleanCloseXhr.status = 200;
    cleanCloseXhr.responseText = '';
    cleanCloseXhr.onload?.();
    await expect(cleanClose).resolves.toMatchObject({
      kind: 'error',
      retryable: true,
    });

    const controller = new AbortController();
    const aborted = subscribeAgentResults('sess-A', {
      signal: controller.signal,
    });
    controller.abort();
    await expect(aborted).resolves.toEqual({ kind: 'closed' });
  });
});
