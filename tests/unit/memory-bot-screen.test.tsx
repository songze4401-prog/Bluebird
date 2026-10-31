/// <reference types="jest" />
import React from 'react';
import { fireEvent, render, screen, waitFor } from '@testing-library/react-native';

import { AgentTeamScreen } from '../../components/AgentTeamScreen';
import { MemoryBotScreen } from '../../components/MemoryBotScreen';
import { apiFetch } from '../../lib/api/client';
import { getTheme } from '../../theme';

jest.mock('../../lib/api/client', () => ({
  apiFetch: jest.fn(),
}));

jest.mock('../../lib/agent-stream', () => ({
  sendAgentChatStream: jest.fn(async () => ({ kind: 'fallback' })),
  emptyAgentMessage: (id: string) => ({
    id,
    role: 'assistant',
    content: '',
    createdAt: '2026-10-30T00:00:00.000Z',
    toolSteps: [],
  }),
}));

const mockedFetch = apiFetch as unknown as jest.Mock;
const theme = getTheme('light', 'blue');

function jsonResponse(payload: unknown, status = 200): Response {
  return {
    ok: status >= 200 && status < 300,
    status,
    headers: { get: () => 'application/json' },
    json: async () => payload,
  } as unknown as Response;
}

const agent = {
  botId: 'memory',
  displayName: 'Memory Bot',
  version: '1.0.0',
  description: '专注长期记忆检索与维护。',
  capabilities: ['memory.search'],
  acceptedTaskTypes: ['memory.search'],
  entrypoints: ['direct_chat', 'delegated_task'],
  permissionProfileId: 'memory-bot-default',
  toolAllowlist: ['memory_search'],
  availableTools: ['memory_search', 'memory_remember', 'knowledge_search'],
  permission: {
    profileId: 'memory-bot-default',
    mode: 'single_user',
    actorId: 'local-owner',
    allowedOperations: ['update', 'merge', 'supersede', 'archive', 'withdraw', 'delete'],
    approvalRequired: ['update', 'merge', 'supersede', 'archive', 'withdraw', 'delete'],
    extensionPoint: { multiUser: false, aclResolver: 'permissions.checkOperation' },
  },
  status: 'enabled',
  statusReason: null,
  enabled: true,
  model: {
    providerId: 'p1',
    modelId: 'bot-test-model',
    temperature: 0.4,
    maxTokens: 1200,
    timeoutMs: 60000,
  },
  credential: {
    credentialId: 'cred_1',
    botId: 'memory',
    providerId: 'p1',
    keyHint: 'sk-***abcd',
    createdAt: '2026-10-30T00:00:00.000Z',
    updatedAt: '2026-10-30T00:00:00.000Z',
    lastVerifiedAt: '2026-10-30T00:00:00.000Z',
    lastVerifyOk: true,
  },
  sessionsCount: 1,
  lastActivityAt: '2026-10-30T00:00:00.000Z',
  updatedAt: '2026-10-30T00:00:00.000Z',
};

const config = {
  botId: 'memory',
  enabled: true,
  modelProfile: {
    providerId: 'p1',
    modelId: 'bot-test-model',
    credentialId: 'cred_1',
    temperature: 0.4,
    maxTokens: 1200,
    timeoutMs: 60000,
  },
  prompt: { systemPrompt: '你是 Memory Bot。', version: 'v1' },
  toolAllowlist: ['memory_search'],
  permissionProfileId: 'memory-bot-default',
  updatedAt: '2026-10-30T00:00:00.000Z',
};

const session = {
  id: 's1',
  botId: 'memory',
  title: '咖啡记忆',
  createdAt: '2026-10-30T00:00:00.000Z',
  updatedAt: '2026-10-30T00:00:00.000Z',
  messageCount: 1,
};

describe('Memory Bot UI', () => {
  beforeEach(() => {
    mockedFetch.mockReset();
  });

  it('团队页只展示真实 Memory Bot，并把未注册 Bot 标为预留', async () => {
    mockedFetch.mockResolvedValue(jsonResponse({ agents: [agent] }));
    const onOpenBot = jest.fn();

    await render(
      <AgentTeamScreen visible onClose={() => {}} theme={theme} onOpenBot={onOpenBot} />
    );

    await waitFor(() => {
      expect(screen.getByText('Memory Bot')).toBeTruthy();
      expect(screen.getByText('已启用')).toBeTruthy();
      expect(screen.getByText('bot-test-model')).toBeTruthy();
      expect(screen.getByText('sk-***abcd')).toBeTruthy();
      expect(screen.getByText('更多 Agent')).toBeTruthy();
      expect(screen.getByText('预留 · 未注册')).toBeTruthy();
    });

    await fireEvent.press(screen.getByLabelText('打开 Memory Bot 工作台'));
    expect(onOpenBot).toHaveBeenCalledWith(agent);
  });

  it('工作台显示会话、真实回复和脱敏凭证，不出现完整 Key', async () => {
    mockedFetch.mockImplementation(async (path: string, init?: RequestInit) => {
      if (path === '/agents/memory') return jsonResponse({ agent });
      if (path === '/agents/memory/config') return jsonResponse({ config, agent });
      if (path === '/agents/memory/sessions' && (!init || init.method !== 'POST')) {
        return jsonResponse({ sessions: [session] });
      }
      if (path === '/agent-tasks?botId=memory&limit=20') return jsonResponse({ tasks: [] });
      if (path === '/agents/memory/events?limit=30') return jsonResponse({ events: [] });
      if (path === '/agents/memory/approvals?limit=50') {
        return jsonResponse({
          approvals: [
            {
              approvalId: 'appr_1',
              botId: 'memory',
              taskId: null,
              sessionId: null,
              operation: 'update',
              payload: { id: 'mem-a' },
              risk: 'medium',
              status: 'approved',
              requestedBy: 'agent',
              requestedAt: '2026-10-30T00:00:00.000Z',
              decidedBy: 'local-owner',
              decidedAt: '2026-10-30T00:00:00.000Z',
              executedBy: null,
              executedAt: null,
              reason: null,
              errorCode: null,
              result: null,
            },
          ],
        });
      }
      if (path === '/model-providers') {
        return jsonResponse({
          providers: [
            {
              id: 'p1',
              name: 'Test Provider',
              type: 'openai-compatible',
              baseUrl: 'https://example.test',
              builtin: false,
              enabled: true,
              keyConfigured: true,
              keyHint: 'sk-***abcd',
              models: [{ id: 'bot-test-model', name: 'Bot', enabled: true, capabilities: { tools: true, vision: false } }],
            },
          ],
        });
      }
      if (path === '/agents/memory/sessions/s1') {
        return jsonResponse({
          session,
          messages: [
            {
              id: 'm1',
              role: 'user',
              content: '我喜欢拿铁',
              createdAt: '2026-10-30T00:00:00.000Z',
            },
          ],
        });
      }
      if (path === '/agents/memory/chat') {
        return jsonResponse({
          ok: true,
          botId: 'memory',
          sessionId: 's1',
          session,
          message: {
            id: 'm2',
            role: 'assistant',
            content: '你偏好拿铁咖啡。',
            createdAt: '2026-10-30T00:00:00.000Z',
            toolSteps: [{ name: 'memory_search', ok: true, summary: '找到 1 条', durationMs: 3 }],
          },
          toolSteps: [{ name: 'memory_search', ok: true, summary: '找到 1 条', durationMs: 3 }],
          toolsEnabled: true,
          model: { providerId: 'p1', modelId: 'bot-test-model' },
          stopReason: null,
          messageCount: 2,
        });
      }
      return jsonResponse({ error: 'not_found' }, 404);
    });

    await render(<MemoryBotScreen visible onClose={() => {}} theme={theme} />);

    await waitFor(() => {
      expect(screen.getByText('咖啡记忆')).toBeTruthy();
      expect(screen.getByText('我喜欢拿铁')).toBeTruthy();
      expect(screen.getByText('sk-***abcd')).toBeTruthy();
    });

    await fireEvent.changeText(
      screen.getByPlaceholderText('问问你的记忆，或让我整理一条候选…'),
      '再说一次我的咖啡偏好'
    );
    await fireEvent.press(screen.getByLabelText('发送给 Memory Bot'));

    await waitFor(() => {
      expect(screen.getByText('你偏好拿铁咖啡。')).toBeTruthy();
    });
    expect(screen.queryByText('sk-***abcd')).toBeTruthy();
  });

  it('配置页可编辑 Prompt/工具白名单，任务页展示真实任务与审批操作', async () => {
    mockedFetch.mockImplementation(async (path: string, init?: RequestInit) => {
      if (path === '/agents/memory/approvals' && init?.method === 'POST') {
        return jsonResponse(
          {
            approval: {
              approvalId: 'appr_new',
              botId: 'memory',
              taskId: null,
              sessionId: null,
              operation: 'update',
              payload: { id: 'mem-a', content: '新的记忆内容' },
              risk: 'medium',
              status: 'pending',
              requestedBy: 'user',
              requestedAt: '2026-10-30T00:00:00.000Z',
              decidedBy: null,
              decidedAt: null,
              executedBy: null,
              executedAt: null,
              reason: null,
              errorCode: null,
              result: null,
            },
          },
          201
        );
      }
      if (path === '/agents/memory') return jsonResponse({ agent });
      if (path === '/agents/memory/config') return jsonResponse({ config, agent });
      if (path === '/agents/memory/sessions' && (!init || init.method !== 'POST')) {
        return jsonResponse({ sessions: [session] });
      }
      if (path === '/agent-tasks?botId=memory&limit=20') return jsonResponse({ tasks: [] });
      if (path === '/agents/memory/events?limit=30') return jsonResponse({ events: [] });
      if (path === '/agents/memory/approvals?limit=50') {
        return jsonResponse({
          approvals: [
            {
              approvalId: 'appr_1',
              botId: 'memory',
              taskId: null,
              sessionId: null,
              operation: 'update',
              payload: { id: 'mem-a' },
              risk: 'medium',
              status: 'approved',
              requestedBy: 'agent',
              requestedAt: '2026-10-30T00:00:00.000Z',
              decidedBy: 'local-owner',
              decidedAt: '2026-10-30T00:00:00.000Z',
              executedBy: null,
              executedAt: null,
              reason: null,
              errorCode: null,
              result: null,
            },
          ],
        });
      }
      if (path === '/model-providers') {
        return jsonResponse({
          providers: [
            {
              id: 'p1',
              name: 'Test Provider',
              type: 'openai-compatible',
              baseUrl: 'https://example.test',
              builtin: false,
              enabled: true,
              keyConfigured: true,
              keyHint: 'sk-***abcd',
              models: [{ id: 'bot-test-model', name: 'Bot', enabled: true, capabilities: { tools: true, vision: false } }],
            },
          ],
        });
      }
      if (path === '/agents/memory/sessions/s1') {
        return jsonResponse({ session, messages: [] });
      }
      return jsonResponse({ error: 'not_found' }, 404);
    });

    await render(<MemoryBotScreen visible onClose={() => {}} theme={theme} />);
    await waitFor(() => expect(screen.getByText('咖啡记忆')).toBeTruthy());

    await fireEvent.press(screen.getByLabelText('模型与 Key页签'));
    await waitFor(() => {
      expect(screen.getByPlaceholderText('Memory Bot 的系统 Prompt')).toBeTruthy();
      expect(screen.getByText(/memory_search/)).toBeTruthy();
      expect(screen.getByText('memory_remember')).toBeTruthy();
    });

    await fireEvent.press(screen.getByLabelText('任务与事件页签'));
    await waitFor(() => {
      expect(
        screen.getByPlaceholderText('任务目标，例如：整理我关于咖啡的长期记忆')
      ).toBeTruthy();
      expect(screen.getByText('update · medium')).toBeTruthy();
      expect(screen.getByText('目标：mem-a')).toBeTruthy();
      expect(screen.getByText('执行')).toBeTruthy();
    });

    await fireEvent.changeText(screen.getByPlaceholderText('记忆 ID'), 'mem-a');
    await fireEvent.changeText(
      screen.getByPlaceholderText('更新后的内容（可选）'),
      '新的记忆内容'
    );
    await fireEvent.press(screen.getByText('提交维护申请'));

    await waitFor(() => {
      const call = mockedFetch.mock.calls.find(
        ([path, init]) =>
          path === '/agents/memory/approvals' &&
          (init as RequestInit | undefined)?.method === 'POST'
      );
      expect(call).toBeTruthy();
      const body = JSON.parse(String((call?.[1] as RequestInit).body));
      expect(body.operation).toBe('update');
      expect(body.payload.id).toBe('mem-a');
      expect(body.requestedBy).toBe('user');
    });
  });
});
