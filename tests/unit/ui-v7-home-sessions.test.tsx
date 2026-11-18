/// <reference types="jest" />
/**
 * v7 主页「对话记录」接真会话的渲染契约：
 *   ① 列表渲染真实 SessionMeta（标题 / 消息数 / 时间），空白会话显示「新对话」
 *   ② 点击行调用 onSelectSession(sessionId)，当前会话带「当前」标记
 *   ③ 空列表 / 读取中 / 读取失败三种状态各有明确文案，不再回落到 mock convs
 */
import React from 'react';
import { fireEvent, render, within } from '@testing-library/react-native';

import { HomeScreen } from '../../app/HomeScreen';
import { UiStateProvider } from '../../app/ui-state';
import { formatMessageTime } from '../../lib/utils';
import type { SessionMeta } from '../../lib/types';

jest.mock('react-native-safe-area-context', () =>
  require('react-native-safe-area-context/jest/mock').default
);

const SESSIONS: SessionMeta[] = [
  {
    id: 'session-a',
    title: '会议纪要整理',
    createdAt: '2026-11-15T01:00:00.000Z',
    updatedAt: '2026-11-15T02:30:00.000Z',
    messageCount: 6,
  },
  {
    id: 'session-b',
    title: '新会话',
    createdAt: '2026-11-15T03:00:00.000Z',
    updatedAt: '2026-11-15T03:10:00.000Z',
    messageCount: 0,
  },
];

type HomeProps = React.ComponentProps<typeof HomeScreen>;

function renderHome(overrides: Partial<HomeProps> = {}) {
  const props: HomeProps = {
    sessions: SESSIONS,
    currentSessionId: 'session-a',
    loadingSessions: false,
    sessionsError: '',
    onSelectSession: jest.fn(),
    onNewChat: jest.fn(),
    ...overrides,
  };

  return render(
    <UiStateProvider>
      <HomeScreen {...props} />
    </UiStateProvider>
  );
}

describe('v7 主页对话记录（真实会话）', () => {
  it('渲染真实会话标题/消息数/时间，空白会话显示新对话', async () => {
    const utils = await renderHome();

    const first = within(utils.getByLabelText('打开对话：会议纪要整理'));
    expect(first.getByText('会议纪要整理')).toBeTruthy();
    expect(first.getByText('Bluebird · 6 条消息')).toBeTruthy();
    expect(first.getByText(formatMessageTime(SESSIONS[0].updatedAt))).toBeTruthy();

    const second = within(utils.getByLabelText('打开对话：新对话'));
    expect(second.getByText('新对话')).toBeTruthy();
    expect(second.getByText('Bluebird · 0 条消息')).toBeTruthy();

    expect(utils.getByText('2 个对话')).toBeTruthy();
  });

  it('当前会话带「当前」标记，点击行用 sessionId 切换会话', async () => {
    const onSelectSession = jest.fn();
    const utils = await renderHome({ onSelectSession });

    expect(utils.getAllByText('当前')).toHaveLength(1);
    expect(
      within(utils.getByLabelText('打开对话：会议纪要整理')).getByText('当前')
    ).toBeTruthy();

    fireEvent.press(utils.getByLabelText('打开对话：新对话'));
    expect(onSelectSession).toHaveBeenCalledWith('session-b');
  });

  it('对话入口卡新开一条空会话，不打开历史会话', async () => {
    const onSelectSession = jest.fn();
    const onNewChat = jest.fn();
    const utils = await renderHome({ onSelectSession, onNewChat });

    fireEvent.press(utils.getByLabelText('新对话'));
    expect(onNewChat).toHaveBeenCalledTimes(1);
    expect(onSelectSession).not.toHaveBeenCalled();
  });

  it('无会话时显示空态文案', async () => {
    const utils = await renderHome({ sessions: [], currentSessionId: '' });
    expect(utils.getByText('还没有对话记录')).toBeTruthy();
  });

  it('读取中显示加载文案', async () => {
    const utils = await renderHome({
      sessions: [],
      currentSessionId: '',
      loadingSessions: true,
    });
    expect(utils.getByText('正在读取对话记录…')).toBeTruthy();
  });

  it('读取失败显示错误文案', async () => {
    const utils = await renderHome({
      sessions: [],
      currentSessionId: '',
      sessionsError: '读取会话列表失败，请稍后再试。',
    });
    expect(utils.getByText('读取会话列表失败，请稍后再试。')).toBeTruthy();
  });
});
