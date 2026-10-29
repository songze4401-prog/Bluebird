/// <reference types="jest" />
// Agent 工作方式分区的 UI 契约：
// - 打开控制面板时读取 /agent-policy，而不是使用前端本地副本；
// - 修改自主模式后保存，PUT body 是完整策略；
// - 恢复默认由服务端执行，发送 { reset: true }。
//
// 只断言标题、服务和请求契约，不依赖像素或具体主题色。

import React from 'react';
import { fireEvent, render, screen, waitFor } from '@testing-library/react-native';

import { ControlPanelScreen } from '../../components/ControlPanelScreen';
import { getTheme } from '../../theme';

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

const theme = getTheme('dark', 'blue');

const persona = {
  colloquial: 70,
  warmth: 70,
  initiative: 50,
  length: 50,
  messageMode: 'auto' as const,
};

const defaultPolicy = {
  schemaVersion: 1 as const,
  mode: 'bounded_autonomy' as const,
  planning: { generatePlan: false, stagedExecution: false, resultSummary: false },
  tools: { allowedTools: null, maxToolCalls: 12, maxReadOnlyRetries: 0 },
  budgets: { maxRounds: 3, maxTotalMs: 90000 },
};

const meta = {
  schemaVersion: 1,
  revision: 3,
  updatedAt: '2026-10-29T10:00:00.000Z',
  digest: 'abc123',
  corrupted: false,
  writeBlocked: false,
};

const limits = {
  maxRounds: { min: 2, max: 5 },
  maxToolCalls: { min: 1, max: 12 },
  maxTotalMs: { min: 5000, max: 120000 },
  maxReadOnlyRetries: { min: 0, max: 1 },
  maxAllowedTools: 12,
};

function jsonResponse(payload: unknown, status = 200): Response {
  return {
    ok: status >= 200 && status < 300,
    status,
    headers: { get: () => 'application/json' },
    json: async () => payload,
  } as unknown as Response;
}

function setupMock() {
  mockApiFetch.mockImplementation((pathname: string, init?: { method?: string; body?: string }) => {
    if (pathname === '/persona') {
      return Promise.resolve(jsonResponse({ config: persona, defaults: persona }));
    }
    if (pathname === '/agent-policy' && (!init || init.method === undefined)) {
      return Promise.resolve(
        jsonResponse({
          policy: defaultPolicy,
          defaults: defaultPolicy,
          meta,
          limits,
          runtimeLimits: { maxRounds: 3 },
          availableTools: [
            {
              name: 'memory_search',
              description: '只读记忆检索',
              readOnly: true,
              risk: 'read',
              timeoutMs: 5000,
            },
            {
              name: 'memory_remember',
              description: '候选记忆写入',
              readOnly: false,
              risk: 'reversible_write',
              timeoutMs: 5000,
            },
          ],
        })
      );
    }
    if (pathname === '/agent-policy' && init && init.method === 'PUT') {
      const body = JSON.parse(init.body || '{}');
      const nextPolicy = body.reset === true ? defaultPolicy : body.policy;
      return Promise.resolve(
        jsonResponse({ policy: nextPolicy, meta: { ...meta, revision: meta.revision + 1 } })
      );
    }
    return Promise.resolve(jsonResponse({}, 404));
  });
}

async function renderPanel() {
  return render(
    <ControlPanelScreen
      theme={theme}
      visible
      onClose={() => {}}
      streamingEnabled={false}
      onToggleStreaming={() => {}}
    />
  );
}

beforeEach(() => {
  mockApiFetch.mockReset();
  setupMock();
});

describe('Agent 工作方式分区', () => {
  it('从服务端读取策略、显示工具风险并保存修改', async () => {
    await renderPanel();

    expect(await screen.findByText('Agent 工作方式')).toBeTruthy();
    expect(await screen.findByText('只回答')).toBeTruthy();
    expect(screen.getByText('memory_search')).toBeTruthy();
    expect(screen.getByText('只读')).toBeTruthy();
    expect(screen.getByText('可逆写入')).toBeTruthy();

    await fireEvent.press(screen.getByText('只回答'));
    await fireEvent.press(screen.getByText('保存 Agent 策略'));

    await waitFor(() => {
      const call = mockApiFetch.mock.calls.find(
        ([pathname, init]) =>
          pathname === '/agent-policy' && init && init.method === 'PUT'
      );
      expect(call).toBeTruthy();
    });

    const putCall = mockApiFetch.mock.calls.find(
      ([pathname, init]) =>
        pathname === '/agent-policy' && init && init.method === 'PUT'
    );
    const body = JSON.parse(putCall[1].body);
    expect(body.policy.mode).toBe('answer_only');
    expect(body.policy.schemaVersion).toBe(1);
    expect(await screen.findByText('已保存，下一次 Agent 请求生效')).toBeTruthy();
  });

  it('恢复默认使用服务端 reset，不在前端假装重置', async () => {
    await renderPanel();
    await screen.findByText('只回答');

    const resetButtons = screen.getAllByText('恢复默认');
    await fireEvent.press(resetButtons[resetButtons.length - 1]);

    await waitFor(() => {
      const call = mockApiFetch.mock.calls.find(
        ([pathname, init]) =>
          pathname === '/agent-policy' && init && init.method === 'PUT'
      );
      expect(call).toBeTruthy();
      expect(JSON.parse(call[1].body)).toEqual({ reset: true });
    });
    expect(await screen.findByText('已恢复服务端默认策略')).toBeTruthy();
  });
});
