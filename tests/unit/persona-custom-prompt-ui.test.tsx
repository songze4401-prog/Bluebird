/// <reference types="jest" />
// 自定义人格提示词编辑区（控制面板内）的组件级校验。
//
// 断言的三件事都是「前端不能骗人」的部分：
//   1. 打开面板显示的是服务端已保存的文本，字数上限也来自服务端（不写死常量）；
//   2. 保存提交的是整份 config，自定义文本原样带上；
//   3. 服务端拒绝（400）时把原因显示出来，且编辑框内容不被覆盖——
//      用户不会因为一次失败就丢掉刚写的字。
//
// RNTL 14 的 render / fireEvent 都是异步的，必须 await。

import React from 'react';
import { fireEvent, render, screen } from '@testing-library/react-native';

import { ControlPanelScreen } from '../../components/ControlPanelScreen';
import { getTheme } from '../../theme';
import type { PersonaConfig } from '../../lib/types';

const mockApiFetch = jest.fn();

jest.mock('../../lib/api/client', () => ({
  apiFetch: (...args: unknown[]) => mockApiFetch(...args),
  TIMEOUTS: {
    default: 15000,
    chat: 60000,
    stream: 60000,
    presence: 10000,
    upload: 60000,
  },
}));

const theme = getTheme('light', 'blue');

const BASE_CONFIG: PersonaConfig = {
  colloquial: 70,
  warmth: 70,
  initiative: 50,
  length: 50,
  messageMode: 'auto',
  customPrompt: '别叫我主人，说话直接一点。',
};

function jsonResponse(body: object, status = 200) {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: async () => body,
  } as Response;
}

// PUT 的返回由用例提供：可能是错误状态码，也可能是抛异常（网络层失败）
type SaveHandler = (body: string) => Promise<Response>;

function mockResponses(save: SaveHandler) {
  mockApiFetch.mockImplementation(
    async (path: string, init?: { method?: string; body?: string }) => {
      if (path === '/persona' && (!init || init.body === undefined)) {
        return jsonResponse({
          config: BASE_CONFIG,
          defaults: { ...BASE_CONFIG, customPrompt: '' },
          limits: { customPromptMaxChars: 4000 },
        });
      }

      return save(init!.body as string);
    }
  );
}

async function openPanel() {
  await render(
    <ControlPanelScreen
      theme={theme}
      visible
      onClose={() => {}}
      streamingEnabled={false}
      onToggleStreaming={() => {}}
    />
  );

  return screen.findByTestId('custom-prompt-input');
}

beforeEach(() => {
  mockApiFetch.mockReset();
});

it('从服务端读取已保存的自定义提示词，并用服务端下发的上限显示字数', async () => {
  mockResponses(async () => jsonResponse({ config: BASE_CONFIG }));

  const input = await openPanel();

  expect(input.props.value).toBe('别叫我主人，说话直接一点。');
  expect(input.props.multiline).toBe(true);
  expect(
    screen.getByText(`${Array.from(BASE_CONFIG.customPrompt).length} / 4000 字`)
  ).toBeTruthy();

  // 说明文字必须是整句：JSX 里换行书写会把中文断成带空格的碎片（浏览器实测出现过）
  const hintText = screen.getByTestId('custom-prompt-hint').props.children;

  expect(typeof hintText).toBe('string');
  expect(hintText).not.toMatch(/\S \S/);
  expect(hintText).toContain('不会因此获得任何工具权限或绕过确认');
});

it('编辑后保存：整份 config 带上自定义文本，成功后提示生效', async () => {
  mockResponses(
    async () => jsonResponse({ config: { ...BASE_CONFIG, customPrompt: '少用感叹号' } })
  );

  const input = await openPanel();

  await fireEvent.changeText(input, '少用感叹号');
  expect(screen.getByText('5 / 4000 字')).toBeTruthy();

  await fireEvent.press(screen.getByText('保存'));

  const putCall = mockApiFetch.mock.calls.find(
    ([path, init]) => path === '/persona' && init?.method === 'PUT'
  );
  const body = JSON.parse(putCall![1].body as string);

  expect(body.config.customPrompt).toBe('少用感叹号');
  expect(body.config.messageMode).toBe('auto');
  expect(screen.getByText('已保存，下一轮聊天生效')).toBeTruthy();
  expect(screen.getByTestId('persona-notice').props.style).toEqual(
    expect.objectContaining({ color: theme.textSecondary })
  );
});

it('服务端 400 拒绝时回显原因，并保留用户刚写的文字', async () => {
  const typed = 'x'.repeat(4001);

  mockResponses(
    async () =>
      jsonResponse(
        {
          error:
            '人格配置校验失败：customPrompt 超过 4000 字上限（当前 4001 字）',
          code: 'invalid_config',
        },
        400
      )
  );

  const input = await openPanel();

  await fireEvent.changeText(input, typed);
  await fireEvent.press(screen.getByText('保存'));

  expect(screen.getByTestId('persona-notice').props.children).toContain(
    'customPrompt 超过 4000 字上限'
  );
  // 失败必须看起来像失败：错误色，不能和成功提示同色
  expect(screen.getByTestId('persona-notice').props.style).toEqual(
    expect.objectContaining({ color: theme.danger })
  );
  expect(screen.getByTestId('custom-prompt-input').props.value).toBe(typed);
});

it('网络异常同样保留编辑内容，不误报成保存成功', async () => {
  mockResponses(async () => {
    throw new Error('network down');
  });

  const input = await openPanel();

  await fireEvent.changeText(input, '断网了也要留着');
  await fireEvent.press(screen.getByText('保存'));

  expect(screen.getByTestId('persona-notice').props.children).toBe(
    '保存失败，请检查后端连接'
  );
  expect(screen.getByTestId('custom-prompt-input').props.value).toBe('断网了也要留着');
});

it('恢复默认提交 reset，并以服务端返回值清空编辑框', async () => {
  mockResponses(
    async () =>
      jsonResponse({ config: { ...BASE_CONFIG, customPrompt: '', colloquial: 70 } })
  );

  const input = await openPanel();

  await fireEvent.press(screen.getByText('恢复默认'));

  const resetCall = mockApiFetch.mock.calls.find(
    ([path, init]) => path === '/persona' && init?.method === 'PUT'
  );

  expect(JSON.parse(resetCall![1].body as string)).toEqual({ reset: true });
  expect(screen.getByTestId('custom-prompt-input').props.value).toBe('');
  expect(screen.getByText('已恢复默认')).toBeTruthy();
  // 摘要卡片是多段子节点拼成一个 Text，用正则做子串匹配
  expect(screen.getByText(/自定义提示词：未填写/)).toBeTruthy();
});
