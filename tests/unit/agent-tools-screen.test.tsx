/// <reference types="jest" />
// Agent 工具页的只读契约：展示服务端运行状态和注册表，不渲染可写开关。
import React from 'react';
import { render, screen, waitFor } from '@testing-library/react-native';

import { AgentToolsScreen } from '../../components/AgentToolsScreen';
import { apiFetch } from '../../lib/api/client';
import { getTheme } from '../../theme';

jest.mock('../../lib/api/client', () => ({
  apiFetch: jest.fn(),
}));

const mockedFetch = apiFetch as unknown as jest.Mock;
const theme = getTheme('dark', 'blue');

function jsonResponse(payload: unknown, status = 200): Response {
  return {
    ok: status >= 200 && status < 300,
    status,
    headers: { get: () => 'application/json' },
    json: async () => payload,
  } as unknown as Response;
}

const policy = {
  policy: {
    schemaVersion: 1,
    mode: 'bounded_autonomy',
    planning: { generatePlan: false, stagedExecution: false, resultSummary: false },
    tools: { allowedTools: null, maxToolCalls: 12, maxReadOnlyRetries: 0 },
    budgets: { maxRounds: 3, maxTotalMs: 90000 },
  },
  defaults: {},
  meta: { schemaVersion: 1, revision: 0, updatedAt: null, digest: 'x', corrupted: false, writeBlocked: false },
  limits: {},
  runtimeLimits: { maxRounds: 3 },
  runtime: {
    switchOn: true,
    maxRounds: 3,
    toolTimeoutDefaultMs: 5000,
    imageRequestsDisableTools: true,
  },
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
};

describe('AgentToolsScreen', () => {
  beforeEach(() => {
    mockedFetch.mockReset();
    mockedFetch.mockResolvedValue(jsonResponse(policy));
  });

  it('展示真实开关状态、注册工具与只读边界', async () => {
    await render(
      <AgentToolsScreen visible onClose={() => {}} theme={theme} />
    );

    await waitFor(() => {
      expect(screen.getByText('工具调用已启用')).toBeTruthy();
      expect(screen.getByText('由服务端环境变量控制 · 本页只读')).toBeTruthy();
      expect(screen.getByText('memory_search')).toBeTruthy();
      expect(screen.getByText('memory_remember')).toBeTruthy();
      expect(screen.getByText('最大模型轮数')).toBeTruthy();
      expect(screen.getByText('不启用工具')).toBeTruthy();
      expect(screen.getByText('weather')).toBeTruthy();
      expect(screen.getByText('未提供')).toBeTruthy();
    });

    // 只读页面不能出现可以伪造服务端开关的按钮
    expect(screen.queryByLabelText('允许工具调用')).toBeNull();
  });

  it('服务端未返回 runtime 时标记状态未读取，不冒充已关闭', async () => {
    mockedFetch.mockResolvedValue(
      jsonResponse({ ...policy, runtime: undefined })
    );

    await render(
      <AgentToolsScreen visible onClose={() => {}} theme={theme} />
    );

    await waitFor(() => {
      expect(screen.getByText('工具调用状态未读取')).toBeTruthy();
      expect(screen.getAllByText('—').length).toBeGreaterThan(0);
    });
  });
});
