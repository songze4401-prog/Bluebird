/// <reference types="jest" />
/**
 * 蓝鸟 v7 新壳冒烟：mock 状态直接渲染（不依赖任何后端）——
 * 默认落在聊天页（原型 openRecent 进入即回最近对话）、底部导航三键、
 * 主页区块齐全、设置弹层主要行可见。
 */
import React from 'react';
import { fireEvent, render, waitFor } from '@testing-library/react-native';

import { BluebirdApp } from '../../app/BluebirdApp';

jest.mock('react-native-safe-area-context', () =>
  require('react-native-safe-area-context/jest/mock').default
);

describe('蓝鸟 v7 新壳', () => {
  it('聊天首屏 + 底部导航 + 主页区块 + 设置弹层（mock 数据）', async () => {
    const utils = await render(<BluebirdApp />);

    // 默认落在聊天页：身份胶囊 + 占位输入条
    await waitFor(() => {
      expect(utils.getByPlaceholderText('与 Bluebird 对话…')).toBeTruthy();
    });
    expect(utils.getAllByText('Bluebird').length).toBeGreaterThan(0);

    // 底部导航三键
    expect(utils.getByText('主页')).toBeTruthy();
    expect(utils.getByText('聊天')).toBeTruthy();
    expect(utils.getByText('设置')).toBeTruthy();

    // 切主页：入口卡 / 双卡 / 四个分区头都在
    fireEvent.press(utils.getByText('主页'));
    await waitFor(() => {
      expect(utils.getByText('创建面板')).toBeTruthy();
      expect(utils.getByText('任务 · 定时')).toBeTruthy();
      expect(utils.getByText('进行中的任务')).toBeTruthy();
      expect(utils.getByText('已完成任务')).toBeTruthy();
      expect(utils.getByText('对话记录')).toBeTruthy();
    });

    // 设置弹层：主要行可见（命名纪律：无「主控」、无「Bot」后缀）
    fireEvent.press(utils.getByText('设置'));
    await waitFor(() => {
      expect(utils.getByText('切换账号')).toBeTruthy();
      expect(utils.getByText('系统监控')).toBeTruthy();
      expect(utils.getByText('退出登录')).toBeTruthy();
    });
  });
});
