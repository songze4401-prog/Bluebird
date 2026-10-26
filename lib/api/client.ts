// 网络层收口（阶段 1）：组件层不再直接调用 fetch，也不自行拼基础地址与鉴权头。
// EXPO_PUBLIC_* 在打包期内联，读取方式与 lib/constants 保持一致。

import { API_TOKEN } from '../constants';

const API_BASE = process.env.EXPO_PUBLIC_API_URL ?? '';

// 统一请求入口：自动带上鉴权头；有 body 且调用方未显式指定时补 JSON 类型。
export async function apiFetch(
  path: string,
  init: RequestInit = {}
): Promise<Response> {
  const headers = new Headers(init.headers);

  headers.set('Authorization', `Bearer ${API_TOKEN}`);

  if (init.body !== undefined && !headers.has('Content-Type')) {
    headers.set('Content-Type', 'application/json');
  }

  return fetch(`${API_BASE}${path}`, { ...init, headers });
}
