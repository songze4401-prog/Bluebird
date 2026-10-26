// 统一错误约定（阶段 4）。
//
// 重构前有两套互不相干的做法：
//   - App.tsx 自己造 `ServerError = Error & { fromServer?: true }`，只为区分
//     "服务端明确错误"与"网络错误"
//   - 组件各自 `throw new Error(data.error || '读取失败')`，丢掉 HTTP 状态与 code
// 结果是服务端明明返回了 code（auth / rate_limit / not_configured / capability…），
// 前端却无法据此给出下一步指引。
//
// 现在统一成 ApiError：带 status / code / detail / requireConfirm，
// 并提供 code → 可执行提示的映射（只覆盖动作明确的几个，不编造文案）。

import type { ApiErrorPayload } from './types';

// 服务端模型调用类错误（server/model-adapter.js 的 ERROR_STATUS / ERROR_MESSAGE）
export type ModelCallErrorCode =
  | 'auth' // 服务商拒绝密钥
  | 'rate_limit' // 被限流
  | 'timeout' // 服务商超时
  | 'connection' // 连不上服务商
  | 'server' // 服务商 5xx
  | 'model' // 模型侧业务错误
  | 'bad_request' // 请求格式被拒
  | 'not_configured' // 没有可用密钥/服务商
  | 'capability'; // 模型未声明支持该能力

// 其余出现在响应体里的 code（连接测试的 endpoint_missing、配置损坏等）
export type ApiErrorCode =
  | ModelCallErrorCode
  | 'endpoint_missing'
  | 'config_corrupted'
  | 'not_found'
  | 'invalid_request'
  // 允许未来新增 code，同时保留上面这些的补全
  | (string & {});

export type ApiErrorInit = {
  // 0 表示没有拿到 HTTP 响应（网络层/取消/超时）
  status?: number;
  code?: ApiErrorCode | null;
  detail?: string | null;
  requireConfirm?: boolean;
};

export class ApiError extends Error {
  readonly status: number;
  readonly code: ApiErrorCode | null;
  readonly detail: string | null;
  readonly requireConfirm: boolean;

  constructor(message: string, init: ApiErrorInit = {}) {
    super(message);

    this.name = 'ApiError';
    this.status = init.status ?? 0;
    this.code = init.code ?? null;
    this.detail = init.detail ?? null;
    this.requireConfirm = init.requireConfirm === true;
  }

  // 给了明确下一步的 code 才有提示，避免为了"展示 code"硬凑文案
  get actionHint(): string | null {
    return this.code ? ACTION_HINTS[this.code] ?? null : null;
  }
}

// 只收录"用户能立刻做什么"的 code；其余保持沉默
const ACTION_HINTS: Partial<Record<string, string>> = {
  auth: '请到「模型与 API」检查该服务商的 API Key 是否有效。',
  not_configured: '请到「模型与 API」配置可用的服务商与密钥。',
  capability: '当前模型不支持这项能力，可在「模型与 API」切换模型后再试。',
  rate_limit: '服务商侧限流了，稍等片刻再试。',
  endpoint_missing: '该地址没有 /models 端点，请确认 Base URL 是否正确。',
};

export function isApiError(error: unknown): error is ApiError {
  return error instanceof ApiError;
}

// apiFetch 自身超时与外部取消都表现为 AbortError。
// 聊天路径没有外部取消，因此对聊天请求而言 AbortError 等价于"超时"。
export function isAbortError(error: unknown): boolean {
  return error instanceof Error && error.name === 'AbortError';
}

// 服务端错误体 → ApiError。error 字段优先（服务端已脱敏），缺失时用 fallback。
// 入参刻意收 unknown：调用方通常已经把它断言成某个成功响应类型，
// 这里再收窄一次，避免为了传参把成功类型改成"成功或错误"的联合体。
export function apiErrorFromPayload(
  payload: unknown,
  status: number,
  fallback: string
): ApiError {
  const body =
    payload && typeof payload === 'object'
      ? (payload as ApiErrorPayload)
      : ({} as ApiErrorPayload);

  const message =
    typeof body.error === 'string' && body.error ? body.error : fallback;

  return new ApiError(message, {
    status,
    code: typeof body.code === 'string' ? body.code : null,
    detail: typeof body.detail === 'string' ? body.detail : null,
    requireConfirm: body.requireConfirm === true,
  });
}

// 给用户看的最终文案：服务端原文 + （有明确动作时）下一步提示
export function errorMessageWithHint(error: ApiError): string {
  const hint = error.actionHint;

  if (!hint) return error.message;

  // 服务端原文已经包含同样信息时不重复拼接
  return error.message.includes(hint) ? error.message : `${error.message}\n\n${hint}`;
}
