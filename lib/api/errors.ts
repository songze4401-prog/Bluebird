// 网络层统一错误类型。
//
// 目的：把「超时 / 取消 / 非 JSON / 非 2xx」归一成一个 ApiError，
// 调用方只需要看 message（可直接展示给用户）与 code（可选，用于分支处理），
// 不必再自己判断 response.ok / content-type / AbortError。

export type ApiErrorOptions = {
  /** HTTP 状态码；0 表示网络错误或本地取消。 */
  status?: number;
  /** 服务端返回的机器可读错误码（若有）。 */
  code?: string | null;
  /** 是否由超时触发。 */
  isTimeout?: boolean;
  /** 是否由调用方主动取消触发。 */
  isAborted?: boolean;
};

export class ApiError extends Error {
  readonly status: number;
  readonly code: string | null;
  readonly isTimeout: boolean;
  readonly isAborted: boolean;

  constructor(message: string, options: ApiErrorOptions = {}) {
    super(message);
    this.name = 'ApiError';
    this.status = options.status ?? 0;
    this.code = options.code ?? null;
    this.isTimeout = options.isTimeout ?? false;
    this.isAborted = options.isAborted ?? false;
  }
}

/** 判断是否为 AbortController 取消导致的错误。 */
export function isAbortError(error: unknown): boolean {
  return (
    typeof error === 'object' &&
    error !== null &&
    'name' in error &&
    (error as { name?: unknown }).name === 'AbortError'
  );
}

/** 把任意异常归一为 ApiError，保证调用方拿到的类型稳定。 */
export function toApiError(error: unknown): ApiError {
  if (error instanceof ApiError) return error;
  if (isAbortError(error)) {
    return new ApiError('请求已取消。', { isAborted: true });
  }
  if (error instanceof Error) {
    return new ApiError(error.message || '请求失败');
  }
  return new ApiError('请求失败');
}
