/// <reference types="jest" />
// Markdown 代码块必须能复制；渲染只使用 RN 文本/视图，不引入 WebView。
import React from 'react';
import { Alert, Clipboard } from 'react-native';
import { fireEvent, render, screen } from '@testing-library/react-native';

import { MarkdownMessage } from '../../components/MarkdownMessage';
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
});
