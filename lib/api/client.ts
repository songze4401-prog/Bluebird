// 网络层收口：组件层不再直接调用 fetch，也不自行拼基础地址与鉴权头。
// EXPO_PUBLIC_* 在打包期内联，读取方式与 lib/constants 保持一致。
//
// 阶段 3 增补：
//   - 默认超时（15s）：重构前只有 /chat、上传、presence 各自带超时，
//     其余 20+ 个请求没有超时，网络卡住会永久停在 loading/saving
//   - 外部 AbortSignal 合并：调用方取消（切换会话 / 卸载）时内部请求一起中止

import { API_TOKEN } from '../constants';

export const API_BASE = process.env.EXPO_PUBLIC_API_URL ?? '';

// 各接口的超时预算（毫秒）。默认 15s，聊天/流式/上传保留原有 60s，
// presence 保留原有 10s —— 大模型生成与 base64 上传都需要更长的窗口。
export const TIMEOUTS = {
  default: 15_000,
  chat: 60_000,
  stream: 60_000,
  presence: 10_000,
  upload: 60_000,
} as const;

export type ApiRequestInit = RequestInit & {
  // 不传则用 TIMEOUTS.default
  timeoutMs?: number;
};

// 统一请求入口：自动带上鉴权头；有 body 且调用方未显式指定时补 JSON 类型；
// 统一套上超时，并与调用方传入的 signal 合并。
export async function apiFetch(
  path: string,
  init: ApiRequestInit = {}
): Promise<Response> {
  const {
    timeoutMs = TIMEOUTS.default,
    signal: externalSignal,
    ...rest
  } = init;

  const headers = new Headers(rest.headers);

  headers.set('Authorization', `Bearer ${API_TOKEN}`);

  if (rest.body !== undefined && !headers.has('Content-Type')) {
    headers.set('Content-Type', 'application/json');
  }

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);

  // 外部 signal 与内部超时合并：任一触发都中止底层请求
  const onExternalAbort = () => controller.abort();

  if (externalSignal) {
    if (externalSignal.aborted) controller.abort();
    else externalSignal.addEventListener('abort', onExternalAbort);
  }

  try {
    return await fetch(`${API_BASE}${path}`, {
      ...rest,
      headers,
      signal: controller.signal,
    });
  } finally {
    clearTimeout(timer);

    if (externalSignal) {
      externalSignal.removeEventListener('abort', onExternalAbort);
    }
  }
}
