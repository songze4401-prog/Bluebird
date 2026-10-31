/// <reference types="jest" />
// useChatSession 的竞态与互斥行为（阶段 2/3 的核心修复）。
//
// 这里不渲染任何组件，只驱动 hook 本身：
//   1. A→B 快速切换会话时，若 A 的响应后到，必须被丢弃（不能覆盖 B 的消息）
//   2. 上一个历史请求必须被 abort（不只是丢弃结果）
//   3. 首次加载未完成时不允许发送（loadingHistory 守卫）
//
// 网络层被整体替换为可控的 mock，因此这里验证的是编排逻辑，不是 HTTP 细节。
//
// 注意：RNTL 14 的 renderHook 返回 Promise，必须 await。

import { act, renderHook } from '@testing-library/react-native';

import { useChatSession } from '../../hooks/useChatSession';

const mockApiFetch = jest.fn();

jest.mock('../../lib/api/client', () => ({
  apiFetch: (...args: unknown[]) => mockApiFetch(...args),
  TIMEOUTS: {
    default: 15000,
    chat: 60000,
    stream: 60000,
    presence: 10000,
    upload: 60000,
  },
}));

type LoadResult = { ok: boolean; status: number; stale?: boolean };

function jsonResponse(payload: unknown, status = 200): Response {
  return {
    ok: status >= 200 && status < 300,
    status,
    headers: { get: () => 'application/json' },
    json: async () => payload,
  } as unknown as Response;
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason?: unknown) => void;

  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });

  return { promise, resolve, reject };
}

async function setup(options: { sessionId?: string; draft?: string } = {}) {
  const { sessionId = 'sess-A', draft = '你好' } = options;

  return await renderHook(() =>
    useChatSession({
      sessionId,
      streamingEnabled: false,
      selectedModel: null,
      reportInteraction: jest.fn(),
      draft,
      pendingAttachments: [],
      onDraftConsumed: jest.fn(),
      onAttachmentsConsumed: jest.fn(),
      onMenuCloseRequest: jest.fn(),
    })
  );
}

beforeEach(() => {
  mockApiFetch.mockReset();
});

describe('历史加载的竞态防护', () => {
  it('A→B 快速切换：B 先回、A 后到时，A 被标记 stale 且不覆盖消息', async () => {
    const a = deferred<Response>();
    const b = deferred<Response>();

    mockApiFetch
      .mockImplementationOnce(() => a.promise)
      .mockImplementationOnce(() => b.promise);

    const hook = await setup();

    const promiseA: Promise<LoadResult> = hook.result.current.loadHistory('A');
    const promiseB: Promise<LoadResult> = hook.result.current.loadHistory('B');

    // 第一个请求应被第二次 begin() 中止（不只丢弃结果）
    const firstSignal = mockApiFetch.mock.calls[0][1].signal as AbortSignal;

    expect(firstSignal.aborted).toBe(true);

    // B 先返回
    await act(async () => {
      b.resolve(
        jsonResponse({
          sessionId: 'B',
          history: [{ id: 'b1', role: 'user', content: 'B 的消息' }],
        })
      );
      await promiseB;
    });

    expect(hook.result.current.messages.map(m => m.content)).toEqual([
      'B 的消息',
    ]);

    // A 后返回：结果必须作废
    let resultA: LoadResult | null = null;

    await act(async () => {
      a.resolve(
        jsonResponse({
          sessionId: 'A',
          history: [{ id: 'a1', role: 'user', content: 'A 的消息' }],
        })
      );
      resultA = await promiseA;
    });

    expect(resultA).toMatchObject({ stale: true });
    // 消息仍是 B 的，没有被 A 覆盖
    expect(hook.result.current.messages.map(m => m.content)).toEqual([
      'B 的消息',
    ]);
  });

  it('被取消的请求抛 AbortError 时不算错误（stale 而非失败）', async () => {
    const a = deferred<Response>();

    mockApiFetch.mockImplementationOnce(() => a.promise);

    const hook = await setup();

    const promiseA: Promise<LoadResult> = hook.result.current.loadHistory('A');

    mockApiFetch.mockImplementationOnce(() =>
      Promise.resolve(
        jsonResponse({
          sessionId: 'B',
          history: [{ id: 'b1', role: 'user', content: 'B' }],
        })
      )
    );

    await act(async () => {
      await hook.result.current.loadHistory('B');
    });

    const abortError = new Error('aborted');
    abortError.name = 'AbortError';

    let resultA: LoadResult | null = null;

    await act(async () => {
      a.reject(abortError);
      resultA = await promiseA;
    });

    expect(resultA).toMatchObject({ stale: true });
    expect(hook.result.current.messages.map(m => m.content)).toEqual(['B']);
  });

  it('单个请求正常成功时 stale 不为真', async () => {
    mockApiFetch.mockImplementationOnce(() =>
      Promise.resolve(
        jsonResponse({
          sessionId: 'solo',
          history: [{ id: 'h1', role: 'assistant', content: '只有这一条' }],
        })
      )
    );

    const hook = await setup();

    // 用可变容器承接 act 内的赋值：TS 的控制流分析看不到回调里的写入
    const box: { value?: LoadResult } = {};

    await act(async () => {
      box.value = await hook.result.current.loadHistory('solo');
    });

    expect(box.value).toMatchObject({ ok: true, status: 200 });
    expect(box.value?.stale).toBeUndefined();
    // assistant 消息进入 state 时已切好 segments
    expect(hook.result.current.messages[0].segments).toBeTruthy();
  });

  it('向上翻页：用 before 游标请求旧页并前置，不重复已有消息', async () => {
    mockApiFetch
      .mockImplementationOnce(() =>
        Promise.resolve(
          jsonResponse({
            sessionId: 'sess-A',
            history: [{ id: 'newer', role: 'user', content: '新消息' }],
            hasMore: true,
            nextCursor: 'newer',
          })
        )
      )
      .mockImplementationOnce(() =>
        Promise.resolve(
          jsonResponse({
            sessionId: 'sess-A',
            history: [{ id: 'older', role: 'user', content: '旧消息' }],
            hasMore: false,
            nextCursor: null,
          })
        )
      );

    const hook = await setup();

    await act(async () => {
      await hook.result.current.loadHistory('sess-A');
    });

    expect(hook.result.current.hasMoreHistory).toBe(true);

    await act(async () => {
      hook.result.current.markHistoryLoaded();
    });

    await act(async () => {
      await hook.result.current.loadOlderHistory();
    });

    expect(mockApiFetch.mock.calls[1][0]).toBe(
      '/history?sessionId=sess-A&limit=50&before=newer'
    );
    expect(hook.result.current.messages.map(m => m.content)).toEqual([
      '旧消息',
      '新消息',
    ]);
    expect(hook.result.current.hasMoreHistory).toBe(false);
  });

  it('空会话渲染欢迎语（不是空气泡列表）', async () => {
    mockApiFetch.mockImplementationOnce(() =>
      Promise.resolve(jsonResponse({ sessionId: 'empty', history: [] }))
    );

    const hook = await setup();

    await act(async () => {
      await hook.result.current.loadHistory('empty');
    });

    expect(hook.result.current.messages).toHaveLength(1);
    expect(hook.result.current.messages[0].id).toBe('welcome-1');
  });
});

describe('启动情绪读取', () => {
  it('读取服务端情绪并写入 mood', async () => {
    mockApiFetch.mockImplementationOnce(() =>
      Promise.resolve(jsonResponse({ emotion: 'happy', intensity: 0.6 }))
    );

    const hook = await setup();

    await act(async () => {
      await hook.result.current.loadEmotion();
    });

    expect(mockApiFetch.mock.calls[0][0]).toBe('/emotion');
    expect(hook.result.current.mood).toBe('happy');
  });

  it('非 2xx 或缺少 emotion 字段时保持默认情绪', async () => {
    mockApiFetch.mockImplementationOnce(() =>
      Promise.resolve(jsonResponse({}, 500))
    );

    const hook = await setup();

    await act(async () => {
      await hook.result.current.loadEmotion();
    });

    expect(hook.result.current.mood).toBe('calm');
  });
});

describe('发送守卫', () => {
  it('首次加载未完成（loadingHistory）时不发请求', async () => {
    const hook = await setup();

    expect(hook.result.current.loadingHistory).toBe(true);

    await act(async () => {
      await hook.result.current.sendMessage();
    });

    expect(mockApiFetch).not.toHaveBeenCalled();
    expect(hook.result.current.sending).toBe(false);
  });

  it('既无文字也无附件时不发请求', async () => {
    const hook = await setup({ draft: '   ' });

    await act(async () => {
      hook.result.current.markHistoryLoaded();
    });

    await act(async () => {
      await hook.result.current.sendMessage();
    });

    expect(mockApiFetch).not.toHaveBeenCalled();
  });

  it('stopGeneration 中止在途请求、清空 sending，且不追加错误气泡', async () => {
    let rejectRequest: ((reason?: unknown) => void) | null = null;

    mockApiFetch.mockImplementationOnce(
      (_path: string, init: { signal?: AbortSignal }) =>
        new Promise<Response>((_resolve, reject) => {
          rejectRequest = reject;
          const abort = () => {
            const error = new Error('aborted');
            error.name = 'AbortError';
            reject(error);
          };
          if (init.signal?.aborted) abort();
          else init.signal?.addEventListener('abort', abort, { once: true });
        })
    );

    const hook = await setup();

    await act(async () => {
      hook.result.current.markHistoryLoaded();
    });

    let sendingPromise: Promise<void> | null = null;

    await act(async () => {
      sendingPromise = hook.result.current.sendMessage();
    });

    expect(hook.result.current.sending).toBe(true);

    await act(async () => {
      hook.result.current.stopGeneration();
      await sendingPromise;
    });

    expect(hook.result.current.sending).toBe(false);
    expect(
      hook.result.current.messages.some(
        message => message.role === 'assistant' && message.retryText
      )
    ).toBe(false);
    expect(rejectRequest).not.toBeNull();
  });

  it('有文字时发出 /chat，并用服务端 id 替换本地临时 id', async () => {
    mockApiFetch.mockImplementationOnce(() =>
      Promise.resolve(
        jsonResponse({
          reply: '收到',
          mood: 'happy',
          sessionId: 'sess-A',
          userMessageId: 'srv-user-1',
        })
      )
    );

    const hook = await setup();

    await act(async () => {
      hook.result.current.markHistoryLoaded();
    });

    await act(async () => {
      await hook.result.current.sendMessage();
    });

    const [path, init] = mockApiFetch.mock.calls[0] as [string, RequestInit];

    expect(path).toContain('/chat');
    expect(init.method).toBe('POST');

    const payload = JSON.parse(String(init.body));

    expect(payload.message).toBe('你好');
    expect(payload.sessionId).toBe('sess-A');

    const contents = hook.result.current.messages.map(m => m.content);

    expect(contents).toEqual(['你好', '收到']);
    // 用户气泡 id 已被服务端稳定 id 替换（撤回依赖它）
    expect(hook.result.current.messages[0].id).toBe('srv-user-1');
    expect(hook.result.current.mood).toBe('happy');
  });
});

describe('主控结果消息注入', () => {
  it('只接收当前会话，按消息 id 去重', async () => {
    const hook = await setup({ sessionId: 'sess-A' });
    const incoming = {
      id: 'bot-result-task_1',
      role: 'assistant' as const,
      content: '【Memory Bot 任务完成】真实结果',
      createdAt: '2026-10-31T00:00:00.000Z',
      toolSteps: [{ name: 'memory_search', ok: true, summary: '找到 1 条', durationMs: 3 }],
    };

    await act(async () => {
      hook.result.current.receiveExternalMessage('sess-A', incoming);
    });
    expect(hook.result.current.messages).toHaveLength(1);
    expect(hook.result.current.messages[0].id).toBe(incoming.id);
    expect(hook.result.current.messages[0].toolSteps?.[0].running).toBe(false);

    await act(async () => {
      hook.result.current.receiveExternalMessage('sess-A', incoming);
    });
    expect(hook.result.current.messages).toHaveLength(1);

    await act(async () => {
      hook.result.current.receiveExternalMessage('sess-B', {
        ...incoming,
        id: 'bot-result-task_2',
      });
    });
    expect(hook.result.current.messages).toHaveLength(1);
  });
});
