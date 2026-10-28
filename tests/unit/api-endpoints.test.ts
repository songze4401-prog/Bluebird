/// <reference types="jest" />
// 端点路径：集中化之后必须与重构前的字面量逐字一致。
//
// 这条测试的价值在于"防悄悄改 URL"：把散落的模板字符串搬进 API_PATHS 时，
// 少一个斜杠、漏一次 encodeURIComponent，功能测试不一定抓得到，
// 但会把请求打到错误的路由上。

import { API_PATHS } from '../../lib/api/endpoints';

const ID = 'abc-123';

describe('参数化路径与重构前字面量一致', () => {
  it('history：sessionId 编码 + limit 默认 200', () => {
    expect(API_PATHS.history(ID)).toBe(
      `/history?sessionId=${encodeURIComponent(ID)}&limit=200`
    );
  });

  it('history：limit 可覆盖', () => {
    expect(API_PATHS.history(ID, 50)).toBe(
      `/history?sessionId=${encodeURIComponent(ID)}&limit=50`
    );
  });

  it('history：before 游标编码并附加在 limit 之后', () => {
    expect(API_PATHS.history(ID, 50, 'message/id')).toBe(
      `/history?sessionId=${encodeURIComponent(ID)}&limit=50&before=${encodeURIComponent('message/id')}`
    );
  });

  it('session / modelProvider / modelProviderTest / modelProviderEnabled', () => {
    expect(API_PATHS.session(ID)).toBe(`/sessions/${encodeURIComponent(ID)}`);
    expect(API_PATHS.modelProvider(ID)).toBe(
      `/model-providers/${encodeURIComponent(ID)}`
    );
    expect(API_PATHS.modelProviderTest(ID)).toBe(
      `/model-providers/${encodeURIComponent(ID)}/test`
    );
    expect(API_PATHS.modelProviderEnabled(ID)).toBe(
      `/model-providers/${encodeURIComponent(ID)}/enabled`
    );
  });

  it('上传与表情包图片地址', () => {
    expect(API_PATHS.uploadImage(ID)).toBe(
      `/uploads/image/${encodeURIComponent(ID)}`
    );
    expect(API_PATHS.sticker(ID)).toBe(
      `/sticker-repo/${encodeURIComponent(ID)}`
    );
    expect(API_PATHS.stickerImage(ID)).toBe(
      `/sticker-repo/${encodeURIComponent(ID)}/image`
    );
  });

  it('presence 快照带 sessionId', () => {
    expect(API_PATHS.presence(ID)).toBe(
      `/presence?sessionId=${encodeURIComponent(ID)}`
    );
  });
});

describe('固定路径', () => {
  it('逐条等于服务端注册的路由', () => {
    const expected: Record<string, string> = {
      sessions: '/sessions',
      historyClear: '/history/clear',
      historyRecall: '/history/recall',
      emotion: '/emotion',
      persona: '/persona',
      memory: '/memory',
      memoryDelete: '/memory/delete',
      memoryClear: '/memory/clear',
      uploads: '/uploads/image',
      stickerRepo: '/sticker-repo',
      chat: '/chat',
      chatStream: '/chat/stream',
      modelProviders: '/model-providers',
      modelDefaults: '/model-providers/default',
      presenceReport: '/presence/report',
    };

    for (const [key, path] of Object.entries(expected)) {
      expect(API_PATHS[key as keyof typeof API_PATHS]).toBe(path);
    }
  });
});

describe('特殊字符编码', () => {
  it('空格 / 中文 / 斜杠 / # 都被 encodeURIComponent 处理', () => {
    const weird = 'a b/中文#1';

    expect(API_PATHS.session(weird)).toBe(
      `/sessions/${encodeURIComponent(weird)}`
    );
    expect(API_PATHS.session(weird)).not.toContain('/中文');
    expect(API_PATHS.history(weird)).toContain(encodeURIComponent(weird));
  });
});
