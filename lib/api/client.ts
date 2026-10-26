// 统一 JSON 请求客户端。
//
// 收口四件事：
//   1. baseUrl + Authorization 头（不再每个调用点各写一遍）
//   2. 超时（默认 15s，可调用点覆盖）
//   3. 取消（外部 AbortSignal 与内部超时合并）
//   4. 错误归一（非 JSON / 非 2xx / 超时 / 取消 → ApiError）
//
// 流式 /chat/stream 仍由 lib/stream.ts（XHR）负责，不在本客户端范围内。
// 本文件的单测留到阶段 6（引入 TS 测试工具后再补），当前以 tsc + expo lint + 试点行为核对为准。

import { API_TOKEN } from '../constants';
import { ApiError, isAbortError } from './errors';
import { TIMEOUTS } from './endpoints';

const API_BASE = process.env.EXPO_PUBLIC_API_URL;

export type RequestOptions = {
  /** 外部取消信号；与内部超时合并。 */
  signal?: AbortSignal;
  /** 超时毫秒数，默认 TIMEOUTS.default。 */
  timeoutMs?: number;
  /** 额外请求头，覆盖默认头。 */
  headers?: Record<string, string>;
};

type HttpMethod = 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE';

function authHeaders(): Record<string, string> {
  return { Authorization: `Bearer ${API_TOKEN}` };
}

async function request<T>(
  method: HttpMethod,
  path: string,
  body: unknown,
  options: RequestOptions
): Promise<T> {
  const timeoutMs = options.timeoutMs ?? TIMEOUTS.default;
  const controller = new AbortController();

  // 合并外部 signal：外部取消时同步取消内部请求
  const onExternalAbort = () => controller.abort();
  if (options.signal) {
    if (options.signal.aborted) {
      controller.abort();
    } else {
      options.signal.addEventListener('abort', onExternalAbort);
    }
  }

  let timedOut = false;
  const timer = setTimeout(() => {
    timedOut = true;
    controller.abort();
  }, timeoutMs);

  try {
    const response = await fetch(`${API_BASE}${path}`, {
      method,
      headers: {
        ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}),
        ...authHeaders(),
        ...(options.headers ?? {}),
      },
      ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
      signal: controller.signal,
    });

    // 与改造前 readJsonResponse 等价：非 JSON 一律视为连接失败
    const contentType = response.headers.get('content-type') || '';
    if (!contentType.toLowerCase().includes('application/json')) {
      throw new ApiError('服务器连接失败', { status: response.status });
    }

    const data = await response.json();

    if (!response.ok) {
      const message =
        data && typeof data.error === 'string' && data.error
          ? data.error
          : `请求失败（HTTP ${response.status}）`;
      const code =
        data && typeof data.code === 'string' ? data.code : null;
      throw new ApiError(message, { status: response.status, code });
    }

    return data as T;
  } catch (error) {
    if (error instanceof ApiError) throw error;

    if (isAbortError(error)) {
      throw timedOut
        ? new ApiError('请求超时，请稍后再试。', { isTimeout: true })
        : new ApiError('请求已取消。', { isAborted: true });
    }

    // 网络断开 / DNS / 连接被拒等
    throw new ApiError('服务器连接失败');
  } finally {
    clearTimeout(timer);
    if (options.signal) {
      options.signal.removeEventListener('abort', onExternalAbort);
    }
  }
}

export const api = {
  get<T>(path: string, options: RequestOptions = {}): Promise<T> {
    return request<T>('GET', path, undefined, options);
  },

  post<T>(
    path: string,
    body?: unknown,
    options: RequestOptions = {}
  ): Promise<T> {
    return request<T>('POST', path, body, options);
  },

  put<T>(
    path: string,
    body?: unknown,
    options: RequestOptions = {}
  ): Promise<T> {
    return request<T>('PUT', path, body, options);
  },

  patch<T>(
    path: string,
    body?: unknown,
    options: RequestOptions = {}
  ): Promise<T> {
    return request<T>('PATCH', path, body, options);
  },

  del<T>(path: string, options: RequestOptions = {}): Promise<T> {
    return request<T>('DELETE', path, undefined, options);
  },
};
