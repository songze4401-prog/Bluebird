/// <reference types="jest" />
// Markdown 代码块必须能复制；渲染只使用 RN 文本/视图，不引入 WebView。
import React from 'react';
import { Alert, Clipboard } from 'react-native';
import { fireEvent, render, screen, userEvent, waitFor } from '@testing-library/react-native';

import { MarkdownMessage, prepareCodeBlock } from '../../components/MarkdownMessage';
import { getTheme } from '../../theme';

const theme = getTheme('dark', 'blue');

describe('MarkdownMessage', () => {
  beforeEach(() => {
    jest.spyOn(Alert, 'alert').mockImplementation(() => {});
    jest.spyOn(Clipboard, 'setString').mockImplementation(() => {});
  });

  afterEach(() => {
    jest.restoreAllMocks();
  });

  it('渲染标题、列表、引用与代码块，并提供代码复制', async () => {
    await render(
      <MarkdownMessage
        theme={theme}
        content={'# 结论\n\n- 第一点\n\n> 引用\n\n```ts\nconst x = 1;\n```'}
      />
    );

    expect(screen.getByText('结论')).toBeTruthy();
    expect(screen.getByText('第一点')).toBeTruthy();
    expect(screen.getByText('引用')).toBeTruthy();
    expect(screen.getByText('const x = 1;')).toBeTruthy();

    fireEvent.press(screen.getByLabelText('复制代码'));
    expect(Clipboard.setString).toHaveBeenCalledWith('const x = 1;');
  });

  // 回归：代码块曾用横向 ScrollView 包长文本——嵌套滚动会吞掉外层 FlatList 的
  // 纵向手势（Android 上表现为「划不下去了」），且没有高度上限，长代码块会把
  // 聊天视口占满。现在改为文本换行 + 超过 16 行折叠。
  it('长代码块折叠为 16 行并可展开/收起，尾部空白行不计入行数', async () => {
    expect(prepareCodeBlock('a\nb\n\n\n')).toEqual({
      text: 'a\nb',
      lineCount: 2,
      collapsible: false,
    });

    const lines = Array.from({ length: 20 }, (_, index) => `line-${index + 1}`);
    await render(
      <MarkdownMessage
        theme={theme}
        content={`\`\`\`json\n${lines.join('\n')}\n\n\n\`\`\``}
      />
    );

    expect(screen.queryByText(/line-20/)).toBeNull();
    expect(screen.getByText('展开全部（20 行）')).toBeTruthy();

    const user = userEvent.setup();

    await user.press(screen.getByLabelText('展开代码'));
    expect(await screen.findByText(/line-20/)).toBeTruthy();

    await user.press(screen.getByLabelText('收起代码'));
    await waitFor(() => expect(screen.queryByText(/line-20/)).toBeNull());
  });

  // 回归：列表末行换行后曾与紧随的段落重叠。根容器在 alignItems:'flex-start'
  // 的父级里若 shrink-to-fit，行内 flex:1 文本按不定宽测量会少算行高。这里锁定
  // 根容器占满宽（alignSelf:'stretch'），并确认「列表 + 无空行紧随段落」各自成块。
  it('列表与紧随段落各自成块，根容器占满宽以避免末行重叠', async () => {
    await render(
      <MarkdownMessage
        theme={theme}
        content={
          '能看到的东西大概就这些：\n\n' +
          '- 咱俩的聊天记录\n' +
          '- 检索你有没有说过什么、查文档或者代码的工具\n' +
          '再往下具体的东西就不展开讲了。'
        }
      />
    );

    expect(screen.getByText('检索你有没有说过什么、查文档或者代码的工具')).toBeTruthy();
    expect(screen.getByText('再往下具体的东西就不展开讲了。')).toBeTruthy();

    const root = screen.getByTestId('markdown-root');
    expect(root.props.style.alignSelf).toBe('stretch');
  });
});
