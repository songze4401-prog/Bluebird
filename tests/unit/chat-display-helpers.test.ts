/// <reference types="jest" />
// 聊天页的两个纯展示助手：工具名中文标签、消息时间（可选秒）。
//
// 它们决定了聊天页「读起来像不像设计图」：pill 上写的是「检索记忆」而不是
// memory_search，时间戳带秒。规则一旦改错不会报错，只会静默变丑，所以要有断言。

import { APP_VERSION, toolLabel } from '../../lib/constants';
import { formatMessageTime } from '../../lib/utils';

describe('toolLabel', () => {
  it('已登记的工具给中文标签', () => {
    expect(toolLabel('memory_search')).toBe('检索记忆');
  });

  it('未登记的工具原样显示名字（后端新增工具时不会出现空白 pill）', () => {
    expect(toolLabel('weather_lookup')).toBe('weather_lookup');
  });

  it('空串不被吞掉：仍返回可预期的原值', () => {
    expect(toolLabel('')).toBe('');
  });
});

describe('formatMessageTime 秒位开关', () => {
  // 用「今天/昨天的本地时刻」构造，避免断言依赖运行环境的时区与 DST
  const at = (dayOffset: number) => {
    const base = new Date();
    return new Date(
      base.getFullYear(),
      base.getMonth(),
      base.getDate() - dayOffset,
      9,
      8,
      7
    ).toISOString();
  };

  it('默认只显示到分（历史列表沿用旧格式）', () => {
    expect(formatMessageTime(at(0))).toBe('09:08');
  });

  it('withSeconds 时补上秒（聊天页设计图为 23:38:07 形态）', () => {
    expect(formatMessageTime(at(0), true)).toBe('09:08:07');
  });

  it('两种开关都带日期前缀', () => {
    expect(formatMessageTime(at(1))).toBe('昨天 09:08');
    expect(formatMessageTime(at(1), true)).toBe('昨天 09:08:07');
  });

  it('非法时间返回空串，不打印 Invalid Date', () => {
    expect(formatMessageTime('not-a-date', true)).toBe('');
  });
});

describe('APP_VERSION', () => {
  it('与 package.json / app.json 的 version 保持一致', () => {
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const pkg = require('../../package.json');
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const app = require('../../app.json');

    expect(pkg.version).toBe(APP_VERSION);
    expect(app.expo.version).toBe(APP_VERSION);
  });
});
