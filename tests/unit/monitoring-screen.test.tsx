/// <reference types="jest" />
// 系统监控控制台：只读展示、空数据语义、Trace 下钻、健康/告警状态。
// 所有网络都 mock；不请求真实服务，也不接触真实数据目录。
import React from 'react';
import { fireEvent, render, screen, waitFor } from '@testing-library/react-native';

import { MonitoringScreen } from '../../components/MonitoringScreen';
import { SettingsDrawer } from '../../components/SettingsDrawer';
import { apiFetch } from '../../lib/api/client';
import { getTheme } from '../../theme';

jest.mock('../../lib/api/client', () => ({
  apiFetch: jest.fn(),
}));

const mockedFetch = apiFetch as unknown as jest.Mock;
const theme = getTheme('light', 'blue');
const noop = () => {};

function jsonResponse(data: unknown, status = 200) {
  return {
    ok: status < 400,
    status,
    headers: { get: () => 'application/json' },
    json: async () => data,
  } as unknown as Response;
}

const overviewData = {
  ok: true,
  data_status: 'ok',
  generated_at: new Date().toISOString(),
  range: { from: new Date().toISOString(), to: new Date().toISOString(), duration_minutes: 60 },
  monitoring_health: { status: 'ok', reasons: [], data_freshness_seconds: 3 },
  coverage: { retained_events: 10, retained_traces: 2, approximate_percentiles: true },
  cost: { status: 'not_configured', value: null, currency: null, note: '未配置费率' },
  cards: [
    {
      key: 'agent',
      title: 'Agent 任务',
      data_status: 'no_data',
      primary: { label: '任务数', value: 0, unit: 'tasks' },
      metrics: [],
    },
    {
      key: 'model',
      title: '模型调用 / Token',
      data_status: 'ok',
      primary: { label: '模型请求', value: 2, unit: 'requests' },
      metrics: [
        { label: '输入 Token（供应商）', value: 32, unit: 'tokens' },
        { label: '费用', value: null, unit: 'currency', note: '未配置费率' },
      ],
    },
  ],
  alerts: {
    firing: 0,
    by_severity: {},
    notifications: { configured: false, reason: '未配置外部通知' },
  },
};

const traceId = 'tr_11111111-1111-1111-1111-111111111111';

const traceListData = {
  ok: true,
  total: 1,
  items: [
    {
      trace_id: traceId,
      name: 'chat.task',
      started_at: new Date().toISOString(),
      duration_ms: 1200,
      status: 'success',
      error_code: null,
      error_category: null,
      session_ref: 's_abc',
      task: { status: 'success', termination: 'model_end' },
      stages: {
        candidate: 10,
        selected: 8,
        accepted: 6,
        injected: 6,
        sent: 6,
        consumed: null,
      },
      model: {
        rounds: 2,
        calls: 2,
        total_tokens: 44,
        usage_source: 'provider',
        model_ids: ['deepseek-chat'],
      },
      tools: {
        requested: 1,
        executed: 1,
        succeeded: 1,
        failed: 0,
        deduped: 0,
        duration_ms: 2,
      },
      span_count: 6,
      event_count: 12,
    },
  ],
};

const traceDetailData = {
  ok: true,
  trace: {
    ...traceListData.items[0],
    ended_at: new Date().toISOString(),
    spans: [
      {
        span_id: 'sp_1',
        parent_span_id: null,
        name: 'context.build',
        started_at: new Date().toISOString(),
        ended_at: new Date().toISOString(),
        duration_ms: 8,
        status: 'success',
        error_code: null,
        attributes: { history_total: 10 },
      },
    ],
    spans_dropped: 0,
    model: {
      ...traceListData.items[0].model,
      input_tokens: 32,
      output_tokens: 12,
      provider_ids: ['deepseek'],
    },
    task: { status: 'success', termination: 'model_end', duration_ms: 1200 },
    context: {
      dropped: [{ kind: 'memory', stage: 'trimmed', reason: '预算裁剪' }],
      memory_skipped: [{ stage: 'coverage_skip', reason: '已被覆盖' }],
    },
    counts: {},
  },
  events: [
    {
      schema_version: 1,
      event_id: 'ev_1',
      event_name: 'context.build.completed',
      occurred_at: new Date().toISOString(),
      collected_at: new Date().toISOString(),
      component: 'context',
      level: 'info',
      status: 'success',
      duration_ms: 8,
      trace_id: traceId,
      span_id: 'sp_1',
      session_ref: 's_abc',
      error_code: null,
      error_category: null,
      attributes: { stage_candidate: 10, stage_selected: 8 },
    },
  ],
  events_total: 1,
};

const healthData = {
  ok: true,
  status: 'ok',
  enabled: true,
  reasons: [],
  generated_at: new Date().toISOString(),
  data_freshness_seconds: 3,
  counters: {
    write_failures: 0,
    queue_dropped: 0,
    invalid_events: 0,
    accepted_events: 10,
  },
  storage: {
    retained_events: 10,
    retained_traces: 2,
    retained_audit: 1,
    retained_alerts: 0,
    queue_depth: 0,
    bytes: null,
    limits: null,
  },
  query_layer: { calls: 3, errors: 0, last_query_at: null },
  persistence: { source: 'monitoring_events', writes: 1, failed: 0, ok: true, note: '' },
  backup: {
    source: 'backup_status_file',
    exists: false,
    ok: false,
    scheduled_task_configured: 'unknown',
    restore_drill: 'unknown',
    disaster_recovery_grade: false,
  },
  alerting: {
    initialized: true,
    rule_count: 2,
    enabled_rules: 1,
    evaluations: 1,
    evaluation_errors: 0,
    last_evaluated_at: new Date().toISOString(),
    active_alerts: 0,
    notifications: { configured: false, reason: '未配置外部通知' },
  },
};

const alertsData = {
  ok: true,
  items: [],
  total: 0,
  rules: [
    {
      id: 'memory_search_failure_rate',
      name: '记忆检索失败率',
      severity: 'P1',
      version: 1,
      description: '阈值',
      window_minutes: 5,
      min_samples: 3,
      enabled: true,
    },
    {
      id: 'cost_spike',
      name: '成本异常突增',
      severity: 'P2',
      version: 1,
      description: '阈值',
      window_minutes: 5,
      min_samples: 1,
      enabled: false,
      disabled_reason: '未配置费率',
    },
  ],
  states: [],
  health: {
    initialized: true,
    rule_count: 2,
    enabled_rules: 1,
    evaluations: 1,
    evaluation_errors: 0,
    last_evaluated_at: new Date().toISOString(),
    active_alerts: 0,
    notifications: { configured: false, reason: '未配置外部通知' },
  },
};

type OverviewFixture = typeof overviewData | { ok: false; reason: string };

function installRoutes({ overview = overviewData }: { overview?: OverviewFixture } = {}) {
  mockedFetch.mockImplementation(async (url: string) => {
    if (url.includes('/monitoring/overview')) return jsonResponse(overview);
    if (url.includes('/monitoring/traces/')) return jsonResponse(traceDetailData);
    if (url.includes('/monitoring/traces')) return jsonResponse(traceListData);
    if (url.includes('/monitoring/health')) return jsonResponse(healthData);
    if (url.includes('/monitoring/alerts')) return jsonResponse(alertsData);
    if (url.includes('/monitoring/events')) return jsonResponse({ ok: true, items: [], total: 0 });
    if (url.includes('/monitoring/audit')) return jsonResponse({ ok: true, items: [], total: 0 });
    if (url.includes('/monitoring/tools')) return jsonResponse({ ok: true, tools: [] });
    if (url.includes('/monitoring/models')) return jsonResponse({ ok: true, models: [] });
    return jsonResponse({ ok: true });
  });
}

beforeEach(() => {
  mockedFetch.mockReset();
});

test('总览渲染真实卡片，空数据显示暂无数据而不是 0', async () => {
  installRoutes();
  await render(<MonitoringScreen visible onClose={noop} theme={theme} />);

  await waitFor(() => expect(screen.getByText('Agent 任务')).toBeTruthy());

  expect(screen.getByText('模型调用 / Token')).toBeTruthy();
  expect(
    screen.getByText('暂无数据 / 尚未接入，不能用 0 代表正常')
  ).toBeTruthy();
  expect(screen.getAllByText('未配置费率').length).toBeGreaterThan(0);
});

test('监控关闭时显示 disabled，不显示健康成功', async () => {
  installRoutes({ overview: { ok: false, reason: 'disabled' } });
  await render(<MonitoringScreen visible onClose={noop} theme={theme} />);

  await waitFor(() => expect(screen.getByText(/监控已关闭/)).toBeTruthy());
});

test('Trace 下钻显示阶段、span 与未采集的 consumed', async () => {
  installRoutes();
  await render(<MonitoringScreen visible onClose={noop} theme={theme} />);

  await waitFor(() => expect(screen.getByText('Agent 任务')).toBeTruthy());
  await fireEvent.press(screen.getByText('Trace'));

  await waitFor(() =>
    expect(screen.getByLabelText(`查看 Trace ${traceId}`)).toBeTruthy()
  );
  await fireEvent.press(screen.getByLabelText(`查看 Trace ${traceId}`));

  await waitFor(() => expect(screen.getByText('候选 candidate')).toBeTruthy());
  expect(screen.getByText('context.build')).toBeTruthy();
  expect(
    screen.getByText(/模型实际消费（consumed）：未采集/)
  ).toBeTruthy();
  expect(screen.getByText('排除原因')).toBeTruthy();
  expect(screen.getByText('· memory / trimmed：预算裁剪')).toBeTruthy();
});

test('健康页展示备份未配置与停用规则原因', async () => {
  installRoutes();
  await render(<MonitoringScreen visible onClose={noop} theme={theme} />);

  await waitFor(() => expect(screen.getByText('Agent 任务')).toBeTruthy());
  await fireEvent.press(screen.getByText('健康·告警'));

  await waitFor(() => expect(screen.getByText('备份与恢复')).toBeTruthy());
  expect(screen.getByText(/未配置 \/ 无状态文件/)).toBeTruthy();
  expect(screen.getByText('外部通知：未配置（未配置外部通知）')).toBeTruthy();
  expect(screen.getByText('停用原因：未配置费率')).toBeTruthy();
});

test('安全·可靠性页展示审计与备份只读状态', async () => {
  installRoutes();
  await render(<MonitoringScreen visible onClose={noop} theme={theme} />);

  await waitFor(() => expect(screen.getByText('Agent 任务')).toBeTruthy());
  await fireEvent.press(screen.getByText('安全·可靠性'));

  await waitFor(() => expect(screen.getByText('敏感操作审计')).toBeTruthy());
  expect(screen.getByText('数据持久化与备份')).toBeTruthy();
  expect(screen.getByText(/控制台只读/)).toBeTruthy();
  expect(screen.getByText(/暂无审计记录/)).toBeTruthy();
});

test('设置抽屉提供系统监控入口', async () => {
  const onOpenMonitoring = jest.fn();
  await render(
    <SettingsDrawer
      visible
      onClose={noop}
      theme={theme}
      mood="calm"
      sessions={[]}
      currentSessionId="s1"
      onSelectSession={noop}
      onOpenHistory={noop}
      onNewChat={noop}
      onOpenMemory={noop}
      onOpenControlPanel={noop}
      onOpenMonitoring={onOpenMonitoring}
      onOpenModels={noop}
      onOpenThemePicker={noop}
      onSelectMode={noop}
      onClearHistory={noop}
    />
  );

  await fireEvent.press(screen.getByText('系统监控'));
  expect(onOpenMonitoring).toHaveBeenCalledTimes(1);
});
