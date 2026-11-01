/// <reference types="jest" />
/**
 * 主控结果流 Hook 的重连策略：
 * 永久错误（如 401）只提示一次，不进入重连；可重试错误按退避重连，
 * 收到 snapshot（onOpen）后把延迟重置回 1s。
 */
import { act, renderHook } from '@testing-library/react-native';

import { useBotResultStream } from '../../hooks/useBotResultStream';
import { subscribeAgentResults } from '../../lib/agent-results-stream';
import type { AgentResultStreamOutcome } from '../../lib/agent-results-stream';

jest.mock('../../lib/agent-results-stream', () => ({
  subscribeAgentResults: jest.fn(),
}));

const subscribe = subscribeAgentResults as jest.MockedFunction<
  typeof subscribeAgentResults
>;

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>(res => {
    resolve = res;
  });
  return { promise, resolve };
}

describe('主控结果流重连策略', () => {
  beforeEach(() => {
    subscribe.mockReset();
  });

  afterEach(() => {
    jest.useRealTimers();
  });

  it('永久错误只提示一次，不进入重连', async () => {
    const closed = deferred<AgentResultStreamOutcome>();
    subscribe.mockReturnValue(closed.promise);
    const onError = jest.fn();

    const { unmount } = await renderHook(() =>
      useBotResultStream({ sessionId: 'sess-A', onResult: jest.fn(), onError })
    );

    await act(async () => {
      closed.resolve({
        kind: 'error',
        message: '未授权',
        status: 401,
        retryable: false,
      });
      await closed.promise;
    });

    expect(onError).toHaveBeenCalledTimes(1);
    expect(onError).toHaveBeenCalledWith('未授权');
    await act(async () => {
      await new Promise(resolve => setTimeout(resolve, 1100));
    });
    expect(subscribe).toHaveBeenCalledTimes(1);
    unmount();
  });

  it('可重试错误按 1s 退避重连，snapshot 打开后重置延迟', async () => {
    jest.useFakeTimers();
    const first = deferred<AgentResultStreamOutcome>();
    const second = deferred<AgentResultStreamOutcome>();
    const third = deferred<AgentResultStreamOutcome>();
    subscribe
      .mockReturnValueOnce(first.promise)
      .mockReturnValueOnce(second.promise)
      .mockReturnValue(third.promise);

    const { unmount } = await renderHook(() =>
      useBotResultStream({ sessionId: 'sess-A', onResult: jest.fn() })
    );

    await act(async () => {
      first.resolve({ kind: 'error', message: '连接失败', retryable: true });
      await first.promise;
    });
    expect(subscribe).toHaveBeenCalledTimes(1);

    await act(async () => {
      jest.advanceTimersByTime(999);
    });
    expect(subscribe).toHaveBeenCalledTimes(1);
    await act(async () => {
      jest.advanceTimersByTime(1);
    });
    expect(subscribe).toHaveBeenCalledTimes(2);

    await act(async () => {
      subscribe.mock.calls[1][1]?.onOpen?.();
    });
    await act(async () => {
      second.resolve({ kind: 'error', message: '连接失败', retryable: true });
      await second.promise;
    });

    // 若 onOpen 未重置，第二次等待应为 2s；重置后仍是 1s。
    await act(async () => {
      jest.advanceTimersByTime(1000);
    });
    expect(subscribe).toHaveBeenCalledTimes(3);
    unmount();
    jest.useRealTimers();
  });
});
