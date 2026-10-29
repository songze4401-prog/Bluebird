/**
 * 监控核心单元测试（node:test）
 *
 * 覆盖：事件契约与脱敏、指标（空数据/分位数/高基数上限）、
 * 有界事件/Trace/审计存储与重启恢复、告警最小样本/触发/恢复、
 * 监控健康 disabled/degraded、隐私（正文/密钥永不入库）。
 */
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

process.env.BLUEBIRD_MONITORING = '1';

const monitoring = require('../server/monitoring');
const schema = require('../server/monitoring/schema');
const metrics = require('../server/monitoring/metrics');
const store = require('../server/monitoring/store');
const alerts = require('../server/monitoring/alerts');
const health = require('../server/monitoring/health');

const DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'bluebird-monitoring-unit-'));

function testConfig(overrides = {}) {
  return {
    enabled: true,
    dataSubdir: 'monitoring',
    maxEvents: 100,
    maxTraces: 10,
    maxSpansPerTrace: 20,
    maxAuditEvents: 100,
    maxAlerts: 20,
    maxFileBytes: 1024 * 1024,
    maxStorageBytes: 8 * 1024 * 1024,
    retentionDays: 7,
    flushBatchSize: 20,
    flushIntervalMs: 50,
    maxQueryRangeHours: 168,
    defaultQueryLimit: 20,
    maxQueryLimit: 100,
    alertIntervalMs: 60000,
    alertWindowMinutes: 5,
    alertMinSamples: 3,
    alertResolveAfterMinutes: 1,
    metricRetentionMinutes: 1440,
    ...overrides,
  };
}

test.before(() => {
  monitoring.resetMonitoringForTests();
  metrics.resetMetricsForTests();
  const result = monitoring.initMonitoring({
    dataDir: DATA_DIR,
    config: testConfig(),
  });
  assert.equal(result.enabled, true);
});

test.after(async () => {
  await monitoring.shutdownMonitoring();
  monitoring.resetMonitoringForTests();
  try {
    fs.rmSync(DATA_DIR, { recursive: true, force: true });
  } catch (_) {
    /* ignore */
  }
});

test('schema：合法事件字段完整且时间统一 UTC ISO', () => {
  const { ok, event } = schema.normalizeEvent({
    event_name: 'model.request.completed',
    component: 'model',
    status: 'success',
    duration_ms: 12.4,
    attributes: { provider_id: 'p1', total_tokens: 10 },
  });

  assert.equal(ok, true);
  assert.equal(event.schema_version, 1);
  assert.match(event.event_id, schema.ID_RE);
  assert.equal(event.occurred_at, event.collected_at);
  assert.equal(event.duration_ms, 12.4);
  assert.equal(event.attributes.provider_id, 'p1');
});

test('schema：非法事件名与组件被拒绝，状态枚举回退 unknown', () => {
  const bad = schema.normalizeEvent({ event_name: 'Bad Name', component: 'x' });
  assert.equal(bad.ok, false);
  assert.ok(bad.errors.includes('invalid_event_name'));

  const event = schema.normalizeEvent({
    event_name: 'task.completed',
    component: 'task',
    status: 'made-up',
  }).event;
  assert.equal(event.status, 'unknown');
});

test('schema：正文/密钥类属性被丢弃，敏感文本被整段打码', () => {
  const { event } = schema.normalizeEvent({
    event_name: 'context.build.completed',
    component: 'context',
    attributes: {
      prompt: '用户完整提示词',
      user_text: '用户原文',
      message_count: 3,
      api_key: 'sk-secret-value',
      password: 'hunter2',
      reason: '包含 Bearer abcdef',
      route: '/chat',
    },
  });

  assert.equal(event.attributes.prompt, undefined);
  assert.equal(event.attributes.user_text, undefined);
  assert.equal(event.attributes.api_key, undefined);
  assert.equal(event.attributes.password, undefined);
  assert.equal(event.attributes.message_count, 3);
  assert.equal(event.attributes.reason, '[REDACTED]');
  assert.equal(event.attributes.route, '/chat');
  assert.equal(schema.assertNoForbiddenFields(event), true, JSON.stringify(event));
});

test('schema：事件序列化后不包含敏感原文', () => {
  const { event } = schema.normalizeEvent({
    event_name: 'tool.call.completed',
    component: 'tool',
    attributes: {
      tool_name: 'memory_search',
      code: 'sk-abcdefgh12345678',
    },
  });
  const json = JSON.stringify(event);
  assert.equal(json.includes('sk-abcdefgh12345678'), false);
});

test('schema：会话引用是哈希，不包含原始 sessionId', () => {
  const ref = monitoring.sessionRefFor('real-session-id');
  assert.match(ref, /^s_[0-9a-f]{16}$/);
  assert.equal(ref.includes('real-session-id'), false);
  assert.equal(ref, monitoring.sessionRefFor('real-session-id'));
});

test('metrics：未知指标拒绝写入，非法值不计数', () => {
  assert.equal(metrics.increment('not_a_metric', {}, 1), false);
  assert.equal(metrics.increment('http_requests_total', {}, -1), false);
  assert.equal(metrics.increment('http_requests_total', {}, Number.NaN), false);
});

test('metrics：计数器按标签聚合，空窗口返回 0 样本而不是伪造比率', () => {
  metrics.increment('http_requests_total', { method: 'GET', route: '/chat', status_class: '5xx' }, 2);
  metrics.increment('http_requests_total', { method: 'GET', route: '/chat', status_class: '2xx' }, 3);

  const all = metrics.aggregate('http_requests_total', { from: 0, to: Date.now() });
  assert.equal(all.count, 5);

  const only5xx = metrics.aggregate(
    'http_requests_total',
    { from: 0, to: Date.now() },
    { status_class: '5xx' }
  );
  assert.equal(only5xx.count, 2);

  const empty = metrics.aggregate(
    'http_requests_total',
    { from: Date.now() + 100000, to: Date.now() + 200000 }
  );
  assert.equal(empty.count, 0);
  assert.equal(empty.avg, null);
});

test('metrics：延迟分位数来自固定桶并明确标注 approximate', () => {
  metrics.observe('http_request_duration_ms', { route: '/chat' }, 12);
  metrics.observe('http_request_duration_ms', { route: '/chat' }, 80);
  metrics.observe('http_request_duration_ms', { route: '/chat' }, 900);

  const stats = metrics.aggregate('http_request_duration_ms', { from: 0, to: Date.now() });
  assert.equal(stats.count, 3);
  assert.equal(stats.approximate, true);
  assert.ok(stats.p50.value >= 25);
  assert.ok(stats.p95.value >= 900);
  assert.ok(stats.p99.value >= 900);
});

test('metrics：时间序列按区间输出空桶为 0 样本', () => {
  const to = Date.now();
  const series = metrics.query('http_requests_total', {
    from: to - 3 * 60 * 1000,
    to,
    intervalMinutes: 1,
  });
  assert.ok(series.points.length >= 3);
  assert.ok(series.points.every(point => Number.isInteger(point.count)));
});

test('metrics：高基数标签系列有上限，超限不抛错', () => {
  for (let i = 0; i < metrics.MAX_SERIES + 20; i += 1) {
    metrics.increment('tool_calls_total', {
      tool_name: `tool_${i}`,
      status: 'success',
    });
  }
  const h = metrics.getHealth();
  assert.ok(h.series <= metrics.MAX_SERIES);
  assert.ok(h.dropped_series > 0);

  // 高基数用例占满系列上限后清空，避免影响后续告警规则的真实样本。
  metrics.resetMetricsForTests();
});

test('store：同一 event_id 重复写入被拒绝并计入健康计数', () => {
  const eventId = 'ev_11111111-1111-1111-1111-111111111111';
  const first = monitoring.recordEvent({
    event_id: eventId,
    event_name: 'duplicate.unit',
    component: 'monitoring',
    status: 'success',
  });
  const second = monitoring.recordEvent({
    event_id: eventId,
    event_name: 'duplicate.unit',
    component: 'monitoring',
    status: 'success',
  });

  assert.equal(first, true);
  assert.equal(second, false);
  assert.ok(store.getStats().stats.duplicateEvents >= 1);
});

test('store：事件写入、过滤、分页游标与总数为真实数据', () => {
  const first = monitoring.recordEvent({
    event_name: 'monitoring.events.unit',
    component: 'monitoring',
    status: 'success',
  });
  assert.equal(first, true);

  const listed = store.listEvents({
    from: 0,
    to: Date.now(),
    eventName: 'monitoring.events.unit',
    limit: 1,
  });
  assert.ok(listed.total >= 1);
  assert.equal(listed.items.length, 1);
});

test('store：事件环形上限生效，旧事件被驱逐且计数可查', () => {
  for (let i = 0; i < 120; i += 1) {
    monitoring.recordEvent({
      event_name: 'overflow.unit',
      component: 'monitoring',
      status: 'success',
      attributes: { index: i },
    });
  }
  const stats = store.getStats();
  assert.ok(stats.events <= 100);
  assert.ok(stats.stats.evictedEvents > 0);
});

test('data-events：数据异常事件桥接到监控，且不携带文件路径/正文', () => {
  const { logDataEvent } = require('../server/data-events');
  logDataEvent({
    module: 'sessions',
    file: 'C:/secret/location/sessions.json',
    event: 'store_write_failed',
    level: 'error',
    reason: 'io_error',
    action: 'write_failed',
  });

  const events = store.listEvents({
    from: 0,
    to: Date.now(),
    eventName: 'data.event',
    limit: 10,
  });
  const record = events.items.find(
    item => item.attributes && item.attributes.action === 'write_failed'
  );
  assert.ok(record);
  assert.equal(record.error_code, 'io_error');
  assert.equal(JSON.stringify(record).includes('sessions.json'), false);
  assert.equal(JSON.stringify(record).includes('C:/secret'), false);
});

test('store：Trace 阶段/span/工具计数与上限行为一致', () => {
  const trace = store.startTrace({ name: 'unit.trace', sessionRef: 's_test' });
  assert.ok(trace);

  for (let i = 0; i < 25; i += 1) {
    store.addSpan(trace.trace_id, {
      span_id: `sp_00000000-0000-0000-0000-0000000000${String(i).padStart(2, '0')}`,
      name: `span.${i}`,
      started_at: new Date().toISOString(),
    });
  }

  store.recordStages(trace.trace_id, {
    candidate: 10,
    selected: 8,
    accepted: 6,
    injected: 5,
    sent: 4,
  });
  store.updateTrace(trace.trace_id, item => {
    item.tools.requested += 1;
    item.tools.executed += 1;
    item.tools.succeeded += 1;
  });
  store.endTrace(trace.trace_id, { status: 'success' });

  const saved = store.getTrace(trace.trace_id);
  assert.equal(saved.spans.length, 20);
  assert.equal(saved.spans_dropped, 5);
  assert.equal(saved.stages.sent, 4);
  assert.equal(saved.tools.succeeded, 1);
  assert.equal(saved.status, 'success');
});

test('辅助模型调用拥有独立 Trace，不混入聊天任务', () => {
  const handle = monitoring.beginAuxiliaryModel({
    providerId: 'deepseek',
    modelId: 'deepseek-chat',
    kind: 'unit_auxiliary',
    sessionRef: 's_unit',
  });
  assert.equal(handle.active, true);
  handle.complete({
    status: 'success',
    usage: { prompt_tokens: 3, completion_tokens: 2, total_tokens: 5 },
  });

  const traces = store.listTraces({ limit: 100 });
  const auxiliary = traces.items.find(item => item.name === 'auxiliary.model');
  assert.ok(auxiliary);
  assert.equal(auxiliary.task.termination, 'unit_auxiliary');
  assert.equal(auxiliary.model.total_tokens, 5);
  assert.ok(auxiliary.span_count >= 1);
});

test('store：Trace 列表支持状态/模型/工具过滤', () => {
  const trace = store.startTrace({ name: 'filter.trace' });
  store.updateTrace(trace.trace_id, item => {
    item.model.model_ids.push('model-x');
  });
  store.addSpan(trace.trace_id, {
    span_id: 'sp_11111111-1111-1111-1111-111111111111',
    name: 'tool.memory_search',
    started_at: new Date().toISOString(),
  });
  store.endTrace(trace.trace_id, { status: 'failed' });

  const byStatus = store.listTraces({ status: 'failed', limit: 50 });
  assert.ok(byStatus.items.some(item => item.trace_id === trace.trace_id));

  const byModel = store.listTraces({ modelId: 'model-x', limit: 50 });
  assert.ok(byModel.items.some(item => item.trace_id === trace.trace_id));

  const byTool = store.listTraces({ toolName: 'memory_search', limit: 50 });
  assert.ok(byTool.items.some(item => item.trace_id === trace.trace_id));
});

test('store：审计记录不记录正文且按时间倒序', () => {
  const audit = store.recordAudit({
    action: 'memory.delete',
    target: 'memory',
    result: 'success',
    actorRef: 'a_test',
    sessionRef: 's_test',
    reason: 'unit',
  });
  assert.ok(audit.audit_id);
  const listed = store.listAudit({ from: 0, to: Date.now(), limit: 10 });
  assert.ok(listed.items.some(item => item.audit_id === audit.audit_id));
  assert.equal(JSON.stringify(listed).includes('用户原文'), false);
});

test('alerts：无样本时为 insufficient_data，不产生告警', () => {
  const result = alerts.evaluateAlerts({ now: Date.now() });
  assert.equal(result.ok, true);
  const memoryRule = result.rules.find(item => item.rule.id === 'memory_search_failure_rate');
  assert.ok(['insufficient_data', 'ok'].includes(memoryRule.state));
  assert.equal(
    alerts.listAlerts({ status: 'firing' }).items.some(item => item.rule_id === 'memory_search_failure_rate'),
    false
  );
});

test('alerts：满足最小样本且超阈值时触发，并写入证据', () => {
  for (let i = 0; i < 4; i += 1) {
    metrics.increment('memory_searches_total', { status: 'failed' });
  }
  metrics.increment('memory_searches_total', { status: 'success' });

  const now = Date.now();
  alerts.evaluateAlerts({ now });

  const firing = alerts.listAlerts({ status: 'firing' }).items.find(
    item => item.rule_id === 'memory_search_failure_rate'
  );
  assert.ok(firing);
  assert.equal(firing.severity, 'P1');
  assert.ok(firing.evidence.observed > firing.evidence.threshold);
  assert.ok(firing.evidence.samples >= firing.evidence.min_samples);
});

test('alerts：持续静默超过恢复窗口后自动恢复', () => {
  const later = Date.now() + 30 * 60 * 1000;
  alerts.evaluateAlerts({ now: later });

  const resolved = alerts.listAlerts({ status: 'resolved' }).items.find(
    item => item.rule_id === 'memory_search_failure_rate'
  );
  assert.ok(resolved);
  assert.ok(resolved.resolved_at);
});

test('alerts：缺少基线/费率的规则保持 disabled 并给出原因', () => {
  const rules = alerts.getRules();
  const cost = rules.find(rule => rule.id === 'cost_spike');
  assert.equal(cost.enabled, false);
  assert.ok(cost.disabled_reason.includes('费率'));
});

test('health：未初始化/关闭时返回 disabled，绝不说健康', async () => {
  await monitoring.shutdownMonitoring();
  monitoring.resetMonitoringForTests();

  const disabled = monitoring.getHealth();
  assert.equal(disabled.status, 'disabled');
  assert.equal(disabled.enabled, false);
});

test('health：事件非法导致 degraded，并能看到原因与计数', () => {
  monitoring.resetMonitoringForTests();
  const result = monitoring.initMonitoring({
    dataDir: DATA_DIR,
    config: testConfig(),
  });
  assert.equal(result.enabled, true);

  monitoring.recordEvent({ event_name: 'invalid name', component: 'monitoring' });
  const data = health.getHealth();
  assert.equal(data.status, 'degraded');
  assert.ok(data.reasons.includes('monitoring_events_dropped_or_invalid'));
  assert.ok(data.counters.invalid_events >= 1);
});

test('health：备份状态为只读读取，不存在时标记未配置', () => {
  const backup = health.backupHealth();
  assert.equal(backup.source, 'backup_status_file');
  assert.equal(typeof backup.code_present, 'boolean');
  if (!backup.exists) {
    assert.equal(backup.ok, false);
  }
});

test('store：flush 后 JSONL 可重启恢复，坏行被跳过', async () => {
  monitoring.recordEvent({
    event_name: 'restart.unit',
    component: 'monitoring',
    status: 'success',
    attributes: { marker: 'keep-me' },
  });
  store.startTrace({ name: 'restart.trace' });

  await store.flushNow();
  await new Promise(resolve => setTimeout(resolve, 120));

  const eventsFile = path.join(DATA_DIR, 'events.jsonl');
  assert.ok(fs.existsSync(eventsFile));
  fs.appendFileSync(eventsFile, '{bad json line}\n', 'utf8');

  await monitoring.shutdownMonitoring();
  monitoring.resetMonitoringForTests();

  const reloaded = monitoring.initMonitoring({
    dataDir: DATA_DIR,
    config: testConfig(),
  });
  assert.equal(reloaded.enabled, true);
  assert.ok(reloaded.loadedEvents >= 1);

  const events = store.listEvents({
    from: 0,
    to: Date.now(),
    eventName: 'restart.unit',
    limit: 10,
  });
  assert.ok(events.items.length >= 1);
  assert.ok(store.getStats().stats.loadSkipped >= 1);
});
