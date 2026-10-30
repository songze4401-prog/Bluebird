/// <reference types="jest" />
// 流式请求的主动停止契约：必须返回 aborted，不能回退成第二条 /chat。
import { streamChatRequest } from '../../lib/stream';

class FakeXHR {
  static last: FakeXHR | null = null;
  onprogress: (() => void) | null = null;
  onload: (() => void) | null = null;
  onerror: (() => void) | null = null;
  ontimeout: (() => void) | null = null;
  responseText = '';
  status = 0;
  timeout = 0;
  aborted = false;
  sent = false;

  constructor() {
    FakeXHR.last = this;
  }

  open() {}
  setRequestHeader() {}
  send() {
    this.sent = true;
  }
  abort() {
    this.aborted = true;
  }
}

describe('streamChatRequest abort', () => {
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

  it('signal 中止时返回 aborted，且不回退 /chat', async () => {
    const controller = new AbortController();
    const promise = streamChatRequest(
      { message: 'hi' },
      { onDelta: () => {}, signal: controller.signal }
    );

    controller.abort();

    await expect(promise).resolves.toEqual({ kind: 'aborted' });
    expect(FakeXHR.last?.aborted).toBe(true);
    expect(FakeXHR.last?.sent).toBe(true);
  });
});
