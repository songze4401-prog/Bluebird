/// <reference types="jest" />
// 聊天页还原后的组件级校验（设计图 ui6 白底版）。
//
// 这里刻意断言两类事情：
//   1. 版式事实——正文没有气泡底/描边/圆角，回合间距取自 CHAT_LAYOUT 令牌；
//      改版最容易出的事故是「看着像设计图，其实样式表里还留着旧气泡」。
//   2. 功能没被视觉改动吃掉——长按撤回、重新发送、继续说、模型 pill、
//      加号面板、发送按钮的显隐规则仍然接在同一批回调上。
// 断言只用可访问性标签与文案，不依赖像素值。
//
// RNTL 14 的 render / fireEvent 都是异步的（底层用 createRoot），必须 await，
// 否则 screen 还没绑定，查询一律报「render function has not been called」。

import React from 'react';
import { StyleSheet } from 'react-native';
import { fireEvent, render, screen } from '@testing-library/react-native';

import { ChatBubble } from '../../components/ChatBubble';
import { ChatWelcome } from '../../components/ChatWelcome';
import { MessageList } from '../../components/MessageList';
import { ChatHeader } from '../../components/ChatHeader';
import { ChatInput } from '../../components/ChatInput';
import { SettingsDrawer } from '../../components/SettingsDrawer';
import { BottomTabBar } from '../../components/BottomTabBar';
import { TasksPanel } from '../../components/TasksPanel';
import { ToolCallPillRow } from '../../components/ToolCallPill';
import { CHAT_LAYOUT, CHAT_TYPE } from '../../lib/design';
import type {
  Attachment,
  Message,
  SessionMeta,
  ToolStepView,
} from '../../lib/types';
import { getTheme } from '../../theme';

const theme = getTheme('light', 'blue');

// 「今天 09:08:07」：时间戳只显示到时刻，用今天可以避开日期前缀与时区差异
const createdAt = (() => {
  const date = new Date();
  date.setHours(9, 8, 7, 0);
  return date.toISOString();
})();

const noop = () => {};

const drawerSessions: SessionMeta[] = [
  {
    id: 's-current',
    title: '当前对话',
    createdAt,
    updatedAt: createdAt,
    messageCount: 2,
  },
  {
    id: 's-memory',
    title: '关于记忆',
    createdAt,
    updatedAt: createdAt,
    messageCount: 5,
  },
];

type BubbleExtra = Partial<{
  previous: Message;
  isLast: boolean;
  sending: boolean;
  continuing: boolean;
  onRecall: (message: Message) => void;
  onRetry: (text?: string, attachments?: Attachment[]) => void;
  onContinue: () => void;
  onOpenActions: (message: Message) => void;
  isFavorite: boolean;
}>;

function bubbleProps(item: Message, extra: BubbleExtra = {}) {
  return {
    theme,
    item,
    isLast: true,
    sending: false,
    continuing: false,
    onRecall: noop,
    onRetry: noop,
    onContinue: noop,
    ...extra,
  };
}

const toolStep = (over: Partial<ToolStepView> = {}): ToolStepView => ({
  name: 'memory_search',
  ok: true,
  summary: '命中 2 条',
  running: false,
  ...over,
});

const rowMarginTop = () =>
  StyleSheet.flatten(screen.getByTestId('chat-row').props.style) as {
    marginTop: number;
  };

// RNTL 14 的「公共 Text 节点」（getByText 返回的那个）只有 children，没有 style，
// 真正的样式挂在宿主节点上，所以版式断言要从 testID 根节点往下遍历渲染树。
type RenderNode = {
  type?: unknown;
  props?: { style?: unknown; children?: unknown };
  children?: unknown[];
};

const childNodes = (node: RenderNode): RenderNode[] =>
  (node.children ?? []).filter(
    child => typeof child !== 'string'
  ) as RenderNode[];

// 渲染树里所有宿主 Text 节点（正文、名字、时间戳…）
function textNodes(node: RenderNode, out: RenderNode[] = []): RenderNode[] {
  if (String(node.type) === 'Text') out.push(node);

  childNodes(node).forEach(child => textNodes(child, out));

  return out;
}

const flatten = (node: RenderNode) =>
  (StyleSheet.flatten(node.props?.style as never) ?? {}) as Record<
    string,
    unknown
  >;

describe('ChatBubble 无气泡排版', () => {
  it('助手正文与所在列都不带底色 / 圆角 / 描边（设计图是平铺文字，不是气泡）', async () => {
    await render(
      <ChatBubble
        {...bubbleProps({
          id: 'a1',
          role: 'assistant',
          content: '今天多云转晴。',
          mood: 'calm',
          createdAt,
        })}
      />
    );

    const row = screen.getByTestId('chat-row') as unknown as RenderNode;

    // row 的直接子节点即 assistantColumn：旧版的气泡底/描边就铺在这一层
    const column = flatten(childNodes(row)[0]);

    expect(column.backgroundColor).toBeUndefined();
    expect(column.borderRadius).toBeUndefined();
    expect(column.borderWidth).toBeUndefined();
    expect(column.shadowColor).toBeUndefined();

    const texts = textNodes(row);

    expect(texts.length).toBeGreaterThan(0);

    // 正文取到的是聊天页令牌（theme.chatText + CHAT_TYPE.body），不是旧的白色气泡字
    const body = texts.map(flatten).find(style => style.color === theme.chatText);

    expect(body).toBeTruthy();
    expect(body?.fontSize).toBe(CHAT_TYPE.body);
    expect(body?.lineHeight).toBe(CHAT_TYPE.bodyLine);

    // 这一档排版里，文字节点一律不该自带气泡外壳（附件缩略图是 View，不受影响）
    texts.map(flatten).forEach(style => {
      expect(style.backgroundColor).toBeUndefined();
      expect(style.borderRadius).toBeUndefined();
      expect(style.borderWidth).toBeUndefined();
    });
  });

  it('用户消息列同样没有气泡底（右对齐纯文字）', async () => {
    await render(
      <ChatBubble
        {...bubbleProps({
          id: 'u1',
          role: 'user',
          content: '帮我查下天气',
          createdAt,
        })}
      />
    );

    const row = screen.getByTestId('chat-row') as unknown as RenderNode;

    expect(screen.getByTestId('chat-row').props.style).toContainEqual(
      expect.objectContaining({ justifyContent: 'flex-end' })
    );

    const style = flatten(childNodes(row)[0]);

    expect(style.backgroundColor).toBeUndefined();
    expect(style.borderWidth).toBeUndefined();
  });

  it('who-line 渲染名字与带秒时间戳', async () => {
    await render(
      <ChatBubble
        {...bubbleProps({
          id: 'a1',
          role: 'assistant',
          content: 'x',
          mood: 'calm',
          createdAt,
        })}
      />
    );

    expect(screen.getByText('BLUE')).toBeTruthy();
    expect(screen.getByText('09:08:07')).toBeTruthy();
  });

  it('同一轮的助手续接用较小间距，换轮用 turnGap', async () => {
    const { unmount } = await render(
      <ChatBubble
        {...bubbleProps(
          { id: 'a1', role: 'assistant', content: '新轮', createdAt },
          { previous: { id: 'a0', role: 'assistant', content: '上一段' } }
        )}
      />
    );

    expect(rowMarginTop().marginTop).toBe(CHAT_LAYOUT.sameGap);

    await unmount();

    await render(
      <ChatBubble
        {...bubbleProps({ id: 'a1', role: 'assistant', content: '新轮', createdAt })}
      />
    );

    expect(rowMarginTop().marginTop).toBe(CHAT_LAYOUT.turnGap);
  });

  it('没有工具调用时不渲染 pill，也不占位', async () => {
    await render(
      <ChatBubble
        {...bubbleProps({ id: 'a1', role: 'assistant', content: 'x', createdAt })}
      />
    );

    expect(screen.queryByText(/调用工具/)).toBeNull();
  });
});

describe('工具 pill 显示真实执行结果', () => {
  it('已完成：工具名走中文标签，成功打勾', async () => {
    await render(<ToolCallPillRow theme={theme} steps={[toolStep()]} />);

    expect(screen.getByText('调用工具 · 检索记忆')).toBeTruthy();
    expect(screen.getByLabelText('调用成功')).toBeTruthy();
  });

  it('失败：标 ✕（不把失败结果伪装成成功）', async () => {
    await render(
      <ToolCallPillRow theme={theme} steps={[toolStep({ ok: false })]} />
    );

    expect(screen.getByLabelText('调用失败')).toBeTruthy();
  });

  it('在途：文案切到「调用工具中」，不显示勾', async () => {
    await render(
      <ToolCallPillRow theme={theme} steps={[toolStep({ running: true })]} />
    );

    expect(screen.getByText('调用工具中 · 检索记忆')).toBeTruthy();
    expect(screen.queryByLabelText('调用成功')).toBeNull();
  });

  it('挂在助手消息正文上方（消息里带 toolSteps 就出现）', async () => {
    await render(
      <ChatBubble
        {...bubbleProps({
          id: 'a1',
          role: 'assistant',
          content: '查到了',
          createdAt,
          toolSteps: [toolStep()],
        })}
      />
    );

    expect(screen.getByText('AGENT RUN')).toBeTruthy();
    expect(screen.getByText('检索记忆')).toBeTruthy();
    expect(screen.getByText('已完成')).toBeTruthy();
  });

  it('未登记的工具名原样显示，不留空', async () => {
    await render(
      <ToolCallPillRow
        theme={theme}
        steps={[toolStep({ name: 'weather_lookup' })]}
      />
    );
    expect(screen.getByText('调用工具 · weather_lookup')).toBeTruthy();
  });
});

describe('Agent 新图互斥提示', () => {
  it('在助手消息下方显示工具暂不可用提示', async () => {
    await render(
      <ChatBubble
        {...bubbleProps({
          id: 'a-notice',
          role: 'assistant',
          content: '图片我看到了。',
          createdAt,
          agentNotice: '本次带图，已切换到视觉模型，工具暂不可用',
        })}
      />
    );

    expect(
      screen.getByText('本次带图，已切换到视觉模型，工具暂不可用')
    ).toBeTruthy();
  });
});

describe('原有交互没被改版吃掉', () => {
  it('用户消息长按打开统一操作面板并带上原消息', async () => {
    const onOpenActions = jest.fn();
    const item: Message = { id: 'u1', role: 'user', content: '撤回我', createdAt };

    await render(
      <ChatBubble {...bubbleProps(item, { onOpenActions })} />
    );

    await fireEvent(screen.getByLabelText('长按打开消息操作'), 'longPress');

    expect(onOpenActions).toHaveBeenCalledWith(item);
  });

  it('历史还有更早页时显示「加载更早消息」，点击触发翻页回调', async () => {
    const onLoadOlder = jest.fn().mockResolvedValue({ ok: true, status: 200 });

    await render(
      <MessageList
        theme={theme}
        messages={[
          {
            id: 'm1',
            role: 'user',
            content: '当前页最早一条',
            createdAt,
          },
        ]}
        sessionId="s1"
        loadingHistory={false}
        loadingOlder={false}
        hasMoreHistory
        onLoadOlder={onLoadOlder}
        sending={false}
        continuing={false}
        liveToolSteps={[]}
        onRecall={noop}
        onRetry={noop}
        onContinue={noop}
      />
    );

    await fireEvent.press(screen.getByLabelText('加载更早消息'));

    expect(onLoadOlder).toHaveBeenCalledTimes(1);
  });

  it('最新一条助手回复有「继续说」，非最后一条没有', async () => {
    const onContinue = jest.fn();
    const item: Message = {
      id: 'a1',
      role: 'assistant',
      content: '继续我',
      createdAt,
    };

    const { unmount } = await render(
      <ChatBubble {...bubbleProps(item, { onContinue })} />
    );

    await fireEvent.press(screen.getByLabelText('继续说'));
    expect(onContinue).toHaveBeenCalled();

    await unmount();

    await render(
      <ChatBubble {...bubbleProps(item, { isLast: false })} />
    );

    expect(screen.queryByLabelText('继续说')).toBeNull();
  });

  it('发送失败的消息保留「重新发送」入口', async () => {
    const onRetry = jest.fn();

    await render(
      <ChatBubble
        {...bubbleProps(
          {
            id: 'a1',
            role: 'assistant',
            content: '',
            createdAt,
            retryText: '刚才那句',
          },
          { onRetry }
        )}
      />
    );

    await fireEvent.press(screen.getByText('重新发送'));

    expect(onRetry).toHaveBeenCalledWith('刚才那句', undefined);
  });

  it('模型 pill 显示服务端拼出的名字，点击打开模型管理', async () => {
    const onOpenModels = jest.fn();

    await render(
      <ChatInput
        theme={theme}
        value=""
        onChangeText={noop}
        sending={false}
        onSend={noop}
        modelLabel="DeepSeek V4.1 Flash"
        onOpenModels={onOpenModels}
      />
    );

    await fireEvent.press(
      screen.getByLabelText('当前模型 DeepSeek V4.1 Flash，点击管理')
    );
    expect(onOpenModels).toHaveBeenCalled();
  });

  it('没读到模型选择时不渲染假的模型名', async () => {
    await render(
      <ChatInput
        theme={theme}
        value=""
        onChangeText={noop}
        sending={false}
        onSend={noop}
      />
    );

    expect(screen.queryByLabelText(/当前模型/)).toBeNull();
  });

  it('「＋」打开加号面板；空输入发送禁用，有内容才可发送', async () => {
    const onPlus = jest.fn();
    const onSend = jest.fn();

    const { rerender } = await render(
      <ChatInput
        theme={theme}
        value="   "
        onChangeText={noop}
        sending={false}
        onSend={onSend}
        onPlus={onPlus}
      />
    );

    await fireEvent.press(screen.getByLabelText('更多功能'));
    expect(onPlus).toHaveBeenCalled();
    expect(screen.getByLabelText('发送').props.accessibilityState.disabled).toBe(
      true
    );
    await fireEvent.press(screen.getByLabelText('发送'));
    expect(onSend).not.toHaveBeenCalled();

    await rerender(
      <ChatInput
        theme={theme}
        value="要发出去的话"
        onChangeText={noop}
        sending={false}
        onSend={onSend}
        onPlus={onPlus}
      />
    );

    await fireEvent.press(screen.getByLabelText('发送'));
    expect(onSend).toHaveBeenCalled();
  });

  it('发送进行中显示停止按钮，发送入口不重复提交', async () => {
    const onSend = jest.fn();
    const onStop = jest.fn();

    await render(
      <ChatInput
        theme={theme}
        value="话"
        onChangeText={noop}
        sending
        onSend={onSend}
        onStop={onStop}
      />
    );

    expect(screen.queryByLabelText('发送')).toBeNull();
    await fireEvent.press(screen.getByLabelText('停止生成'));
    expect(onStop).toHaveBeenCalled();
    expect(onSend).not.toHaveBeenCalled();
  });

  it('待发送图片可移除', async () => {
    const onRemoveAttachment = jest.fn();

    await render(
      <ChatInput
        theme={theme}
        value=""
        onChangeText={noop}
        sending={false}
        onSend={noop}
        onRemoveAttachment={onRemoveAttachment}
        pendingAttachments={[
          {
            attachment: { id: 'att-1', kind: 'image', mime: 'image/png' },
            previewUri: 'file:///tmp/x.png',
          },
        ]}
      />
    );

    await fireEvent.press(screen.getByLabelText('移除图片'));
    expect(onRemoveAttachment).toHaveBeenCalledWith('att-1');
  });
});

describe('顶部栏与设置抽屉', () => {
  it('顶栏三个入口各就各位：☰ 开抽屉、＋ 新建、⌕ 历史', async () => {
    const onOpenDrawer = jest.fn();
    const onNewChat = jest.fn();
    const onOpenHistory = jest.fn();

    await render(
      <ChatHeader
        theme={theme}
        onOpenDrawer={onOpenDrawer}
        onNewChat={onNewChat}
        onOpenHistory={onOpenHistory}
      />
    );

    expect(screen.getByText('Bluebird')).toBeTruthy();

    await fireEvent.press(screen.getByLabelText('打开设置'));
    await fireEvent.press(screen.getByLabelText('新建对话'));
    await fireEvent.press(screen.getByLabelText('历史对话'));

    expect(onOpenDrawer).toHaveBeenCalledTimes(1);
    expect(onNewChat).toHaveBeenCalled();
    expect(onOpenHistory).toHaveBeenCalled();
  });

  it('新建会话请求进行中时，顶栏入口禁用（防连点出多个空会话）', async () => {
    const onNewChat = jest.fn();

    await render(
      <ChatHeader
        theme={theme}
        onOpenDrawer={noop}
        onNewChat={onNewChat}
        onOpenHistory={noop}
        creatingChat
      />
    );

    await fireEvent.press(screen.getByLabelText('新建对话'));
    expect(onNewChat).not.toHaveBeenCalled();
  });

  it('抽屉用卡片面板承载真实功能与最近对话', async () => {
    const onOpenMemory = jest.fn();
    const onOpenTasks = jest.fn();
    const onOpenModels = jest.fn();
    const onOpenAgentTools = jest.fn();
    const onSelectSession = jest.fn();
    const onClearHistory = jest.fn();

    await render(
      <SettingsDrawer
        visible
        onClose={noop}
        theme={theme}
        mood="calm"
        sessions={drawerSessions}
        currentSessionId="s-current"
        loadingSessions={false}
        onSelectSession={onSelectSession}
        onOpenHistory={noop}
        onNewChat={noop}
        onOpenMemory={onOpenMemory}
        onOpenControlPanel={noop}
        onOpenAgentTools={onOpenAgentTools}
        onOpenTasks={onOpenTasks}
        onOpenModels={onOpenModels}
        onOpenThemePicker={noop}
        onSelectMode={noop}
        onClearHistory={onClearHistory}
      />
    );

    expect(screen.getByText('个人空间')).toBeTruthy();
    expect(screen.getByText('最近对话')).toBeTruthy();
    expect(screen.getByText('Bluebird Agent')).toBeTruthy();
    expect(screen.getByText('当前对话')).toBeTruthy();
    expect(screen.getByText('关于记忆')).toBeTruthy();

    await fireEvent.press(screen.getByLabelText('记忆库'));
    expect(onOpenMemory).toHaveBeenCalled();

    await fireEvent.press(screen.getByLabelText('任务'));
    expect(onOpenTasks).toHaveBeenCalled();

    await fireEvent.press(screen.getByLabelText('模型'));
    expect(onOpenModels).toHaveBeenCalled();

    await fireEvent.press(screen.getByLabelText('Agent 工具'));
    expect(onOpenAgentTools).toHaveBeenCalled();

    await fireEvent.press(screen.getByLabelText('打开会话 关于记忆'));
    expect(onSelectSession).toHaveBeenCalledWith('s-memory');

    // 当前对话已在屏幕上：只收抽屉，不重复拉历史
    await fireEvent.press(screen.getByLabelText('打开会话 当前对话'));
    expect(onSelectSession).toHaveBeenCalledTimes(1);

    await fireEvent.press(screen.getByLabelText('清理当前会话'));
    expect(onClearHistory).toHaveBeenCalled();
  });

  it('底栏搜索只过滤真实的会话列表', async () => {
    await render(
      <SettingsDrawer
        visible
        onClose={noop}
        theme={theme}
        mood="calm"
        sessions={drawerSessions}
        currentSessionId="s-current"
        loadingSessions={false}
        onSelectSession={noop}
        onOpenHistory={noop}
        onNewChat={noop}
        onOpenMemory={noop}
        onOpenControlPanel={noop}
        onOpenModels={noop}
        onOpenThemePicker={noop}
        onSelectMode={noop}
        onClearHistory={noop}
      />
    );

    await fireEvent.changeText(screen.getByLabelText('搜索对话'), '关于');

    expect(screen.getByText('关于记忆')).toBeTruthy();
    expect(screen.queryByText('当前对话')).toBeNull();

    await fireEvent.changeText(screen.getByLabelText('搜索对话'), '不存在');

    expect(screen.getByText('没有匹配的对话')).toBeTruthy();
  });

  it('visible=false 时不渲染任何抽屉内容（不拦截触摸）', async () => {
    await render(
      <SettingsDrawer
        visible={false}
        onClose={noop}
        theme={theme}
        mood="calm"
        sessions={drawerSessions}
        currentSessionId="s-current"
        onSelectSession={noop}
        onOpenHistory={noop}
        onNewChat={noop}
        onOpenMemory={noop}
        onOpenControlPanel={noop}
        onOpenModels={noop}
        onOpenThemePicker={noop}
        onSelectMode={noop}
        onClearHistory={noop}
      />
    );

    expect(screen.queryByText('记忆库')).toBeNull();
  });

  it('新对话首屏合并主页排版，入口只接真实回调', async () => {
    const onResumeRecent = jest.fn();
    const onOpenHistory = jest.fn();
    const onOpenMemory = jest.fn();

    await render(
      <ChatWelcome
        theme={theme}
        recentTitle="关于记忆"
        onResumeRecent={onResumeRecent}
        onOpenHistory={onOpenHistory}
        onOpenMemory={onOpenMemory}
      />
    );

    expect(screen.getByText(/今天，想一起/)).toBeTruthy();
    expect(screen.getByText('回到「关于记忆」')).toBeTruthy();

    await fireEvent.press(screen.getByLabelText('继续上次对话'));
    expect(onResumeRecent).toHaveBeenCalled();

    await fireEvent.press(screen.getByLabelText('历史聊天'));
    expect(onOpenHistory).toHaveBeenCalled();

    await fireEvent.press(screen.getByLabelText('记忆库'));
    expect(onOpenMemory).toHaveBeenCalled();
  });

  it('没有可继续的会话时禁用首屏继续入口', async () => {
    const onResumeRecent = jest.fn();

    await render(
      <ChatWelcome
        theme={theme}
        onResumeRecent={onResumeRecent}
        onOpenHistory={noop}
        onOpenMemory={noop}
      />
    );

    expect(screen.getByText('还没有可以继续的对话')).toBeTruthy();

    await fireEvent.press(screen.getByLabelText('继续上次对话'));
    expect(onResumeRecent).not.toHaveBeenCalled();
  });
});

describe('底部标签栏与任务页', () => {
  it('三个标签都上抛自己的 id', async () => {
    const onChange = jest.fn();

    await render(<BottomTabBar theme={theme} active="chat" onChange={onChange} />);

    expect(screen.getAllByRole('tab')).toHaveLength(3);

    await fireEvent.press(screen.getByLabelText('任务'));
    expect(onChange).toHaveBeenCalledWith('tasks');

    await fireEvent.press(screen.getByLabelText('记忆'));
    expect(onChange).toHaveBeenCalledWith('memory');
  });

  it('当前标签标记为 selected，其余不是', async () => {
    await render(<BottomTabBar theme={theme} active="tasks" onChange={noop} />);

    const [chat, tasks, memory] = screen.getAllByRole('tab');

    expect(chat.props.accessibilityState).toEqual({ selected: false });
    expect(tasks.props.accessibilityState).toEqual({ selected: true });
    expect(memory.props.accessibilityState).toEqual({ selected: false });
  });

  it('任务页如实说明后端没有任务接口（不画假任务卡）', async () => {
    await render(<TasksPanel theme={theme} />);

    expect(screen.getByText('任务')).toBeTruthy();
    expect(
      screen.getByText(/后端未提供任务的创建、执行与记录接口/)
    ).toBeTruthy();
  });
});
