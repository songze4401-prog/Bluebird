/// <reference types="jest" />
// 错误契约：ApiError 的字段、code → 可执行提示的映射、以及"不编造文案"的边界。
//
// 这些断言对应阶段 4 的验收点：服务端返回的 code 不再被前端丢掉，
// 但也不能为了"展示 code"给未知 code 硬凑文案。

import {
  ApiError,
  apiErrorFromPayload,
  errorMessageWithHint,
  isAbortError,
  isApiError,
} from '../../lib/api/errors';

describe('ApiError 基础形状', () => {
  it('默认 status=0、code=null，且是 Error 实例（可被 throw/catch）', () => {
    const error = new ApiError('boom');

    expect(error).toBeInstanceOf(Error);
    expect(error.name).toBe('ApiError');
    expect(error.status).toBe(0);
    expect(error.code).toBeNull();
    expect(error.detail).toBeNull();
    expect(error.requireConfirm).toBe(false);
    expect(isApiError(error)).toBe(true);
    expect(isApiError(new Error('x'))).toBe(false);
    expect(isApiError(null)).toBe(false);
  });
});

describe('apiErrorFromPayload', () => {
  it('优先使用服务端 error 原文，并保留 status / code', () => {
    const error = apiErrorFromPayload(
      { error: '未配置可用的模型服务商', code: 'not_configured' },
      500,
      '请求失败'
    );

    expect(error.message).toBe('未配置可用的模型服务商');
    expect(error.code).toBe('not_configured');
    expect(error.status).toBe(500);
  });

  it('error 缺失时回退到 fallback，code 仍可为 null', () => {
    expect(apiErrorFromPayload({}, 502, '请求失败').message).toBe('请求失败');
    expect(apiErrorFromPayload(undefined, 502, '请求失败').message).toBe(
      '请求失败'
    );
    expect(apiErrorFromPayload(null, 502, '请求失败').code).toBeNull();
  });

  it('保留 requireConfirm 与 detail（清理类接口的 403、development 下的细节）', () => {
    const guard = apiErrorFromPayload(
      { error: '需要二次确认', requireConfirm: true },
      403,
      'x'
    );

    expect(guard.requireConfirm).toBe(true);

    const detailed = apiErrorFromPayload(
      { error: 'e', detail: 'dev only detail' },
      500,
      'x'
    );

    expect(detailed.detail).toBe('dev only detail');
  });

  it('非对象载荷不抛错（字符串 / 数字 / 数组）', () => {
    expect(() => apiErrorFromPayload('oops', 500, 'f')).not.toThrow();
    expect(apiErrorFromPayload('oops', 500, 'f').message).toBe('f');
    expect(apiErrorFromPayload(42, 500, 'f').code).toBeNull();
  });
});

describe('code → 可执行提示', () => {
  it('auth：提示检查 API Key', () => {
    const error = apiErrorFromPayload(
      { error: '模型服务商拒绝了 API Key', code: 'auth' },
      502,
      'x'
    );

    expect(error.actionHint).toContain('API Key');
    expect(errorMessageWithHint(error)).toContain('API Key');
  });

  it('not_configured：提示去「模型与 API」配置', () => {
    const error = apiErrorFromPayload(
      { error: '未配置可用的模型服务商', code: 'not_configured' },
      500,
      'x'
    );

    expect(errorMessageWithHint(error)).toContain('「模型与 API」');
  });

  it('capability / rate_limit / endpoint_missing 都有明确提示', () => {
    for (const code of ['capability', 'rate_limit', 'endpoint_missing']) {
      const error = apiErrorFromPayload({ error: 'e', code }, 400, 'x');

      expect(error.actionHint).toBeTruthy();
    }
  });

  it('未知 code 不编造提示（保持服务端原文）', () => {
    const error = apiErrorFromPayload(
      { error: '某个未来才有的错误', code: 'brand_new_code' },
      400,
      'x'
    );

    expect(error.actionHint).toBeNull();
    expect(errorMessageWithHint(error)).toBe('某个未来才有的错误');
  });

  it('原文已包含提示时不重复拼接', () => {
    const text = '服务商侧限流了，稍等片刻再试。';
    const error = apiErrorFromPayload(
      { error: text, code: 'rate_limit' },
      429,
      'x'
    );

    expect(errorMessageWithHint(error)).toBe(text);
  });

  it('没有 code 时不追加任何提示', () => {
    const error = apiErrorFromPayload({ error: '读取失败' }, 500, 'x');

    expect(error.actionHint).toBeNull();
    expect(errorMessageWithHint(error)).toBe('读取失败');
  });
});

describe('isAbortError', () => {
  it('识别 AbortError（apiFetch 的超时与外部取消都以此表现）', () => {
    const error = new Error('aborted');
    error.name = 'AbortError';

    expect(isAbortError(error)).toBe(true);
  });

  it('不误判普通 Error 与非 Error', () => {
    expect(isAbortError(new Error('x'))).toBe(false);
    expect(isAbortError('AbortError')).toBe(false);
    expect(isAbortError(undefined)).toBe(false);
  });
});
