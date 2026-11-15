/// <reference types="jest" />
/**
 * v7「默认模型」抽屉接真数据：
 *   ① 只列启用中的服务商；行文案 = 服务商 · 模型名；当前默认模型标「当前」
 *   ② 点击非当前模型调用 onSelect(providerId, modelId)；成功才关闭抽屉
 *   ③ 停用模型不可点；空列表显示明确文案，不再回落 data/mock 的 MODELS
 */
import React from 'react';
import { fireEvent, render, waitFor, within } from '@testing-library/react-native';

import { ModelPickerSheet } from '../../components/ModelPickerSheet';
import { UiStateProvider } from '../../app/ui-state';
import type { ModelProvider } from '../../lib/types';

jest.mock('react-native-safe-area-context', () =>
  require('react-native-safe-area-context/jest/mock').default
);

const PROVIDERS: ModelProvider[] = [
  {
    id: 'deepseek',
    name: 'DeepSeek',
    type: 'deepseek',
    baseUrl: '',
    builtin: true,
    enabled: true,
    keyConfigured: true,
    keyHint: null,
    models: [
      { id: 'deepseek-flash', name: 'V4.1 Flash', enabled: true, capabilities: { vision: true } },
      { id: 'deepseek-chat', name: 'V4.1 Chat', enabled: true, capabilities: { vision: false } },
      { id: 'legacy', name: 'Legacy', enabled: false, capabilities: { vision: false } },
    ],
  },
  {
    id: 'disabled-provider',
    name: '停用服务商',
    type: 'openai',
    baseUrl: 'https://example.com',
    builtin: false,
    enabled: false,
    keyConfigured: true,
    keyHint: 'sk-***',
    models: [
      { id: 'hidden-model', name: 'Hidden', enabled: true, capabilities: { vision: false } },
    ],
  },
];

async function renderPicker(
  overrides: Partial<React.ComponentProps<typeof ModelPickerSheet>> = {}
) {
  const props: React.ComponentProps<typeof ModelPickerSheet> = {
    visible: true,
    onClose: jest.fn(),
    providers: PROVIDERS,
    current: { providerId: 'deepseek', modelId: 'deepseek-flash' },
    onSelect: jest.fn(async () => true),
    ...overrides,
  };

  const utils = await render(
    <UiStateProvider>
      <ModelPickerSheet {...props} />
    </UiStateProvider>
  );

  return { props, ...utils };
}

describe('v7 默认模型抽屉（真实 /model-providers）', () => {
  it('渲染真实模型、标出当前项，停用服务商的模型不出现', async () => {
    const utils = await renderPicker();

    const currentRow = within(utils.getByLabelText('默认模型：DeepSeek · V4.1 Flash'));
    expect(currentRow.getByText('当前')).toBeTruthy();

    expect(utils.getByLabelText('默认模型：DeepSeek · V4.1 Chat')).toBeTruthy();
    expect(utils.queryByLabelText('默认模型：停用服务商 · Hidden')).toBeNull();
    expect(utils.queryByLabelText('默认模型：DeepSeek · Legacy')).toBeTruthy();
  });

  it('点击其他模型调用 onSelect 并在成功后关闭抽屉', async () => {
    const onSelect = jest.fn(async () => true);
    const utils = await renderPicker({ onSelect });

    await fireEvent.press(utils.getByLabelText('默认模型：DeepSeek · V4.1 Chat'));

    await waitFor(() =>
      expect(onSelect).toHaveBeenCalledWith('deepseek', 'deepseek-chat')
    );
    await waitFor(() => expect(utils.props.onClose).toHaveBeenCalled());
  });

  it('切换失败时不关闭抽屉（不假装成功）', async () => {
    const onSelect = jest.fn(async () => false);
    const utils = await renderPicker({ onSelect });

    await fireEvent.press(utils.getByLabelText('默认模型：DeepSeek · V4.1 Chat'));

    await waitFor(() => expect(onSelect).toHaveBeenCalled());
    expect(utils.props.onClose).not.toHaveBeenCalled();
  });

  it('停用模型不可点；没有可用模型时给出文案', async () => {
    const onSelect = jest.fn(async () => true);
    const disabled = await renderPicker({ onSelect });
    await fireEvent.press(disabled.getByLabelText('默认模型：DeepSeek · Legacy'));
    expect(onSelect).not.toHaveBeenCalled();
    disabled.unmount();

    const empty = await renderPicker({ providers: [] });
    expect(empty.getByText('暂无可用模型')).toBeTruthy();
  });
});
