/**
 * 云岫 Bluebird — 站内告警规则与状态（monitoring/alerts.js）
 *
 * 只实现「站内告警中心 + 可测试规则引擎」：
 * - 每条规则都有明确时间窗、最小样本量与版本；
 * - 低流量返回 insufficient_data，绝不因一次失败误报系统性故障；
 * - 告警只辅助定位，不自动删除数据、改权限或执行外部动作；
 * - 短信/邮件/Webhook 未配置，API 会明确返回 notifications.configured=false；
 * - 阈值来自真实指标与基线；缺少基线/费率的规则保持 disabled，并写明原因。
 */
const crypto = require('crypto');

const metrics = require('./metrics');
const store = require('./store');
const backup = require('../backup');

const SEVERITIES = ['P0', 'P1', 'P2', 'P3'];

const RULE_VERSION = 1;

function ratioEvidence({ metric, numerator, denominator, threshold, minSamples, windowMinutes, from, to }) {
  const num = numerator || { count: 0 };
  const den = denominator || { count: 0 };
  const samples = den.count || 0;
  const ratio = samples ? num.count / samples : null;
  const insufficient = samples < minSamples;
  return {
    observed: ratio === null ? null : Math.round(ratio * 10000) / 10000,
    numerator: num.count || 0,
    denominator: samples,
    threshold,
    min_samples: minSamples,
    samples,
    insufficient_data: insufficient,
    breached: !insufficient && ratio !== null && ratio > threshold,
    window_minutes: windowMinutes,
    from: new Date(from).toISOString(),
    to: new Date(to).toISOString(),
    metric,
  };
}

function buildRules(config) {
  const windowMinutes = config.alertWindowMinutes;
  const minSamples = config.alertMinSamples;

  const range = now => {
    const to = now;
    const from = now - windowMinutes * 60 * 1000;
    return { from, to };
  };

  const aggregateOrZero = (name, options, filter) =>
    metrics.aggregate(name, options, filter) || { count: 0 };

  const rules = [
    {
      id: 'core_request_failure_rate',
      name: '核心 HTTP 请求失败率',
      severity: 'P1',
      version: RULE_VERSION,
      description: '5xx 占全部请求比例超过阈值（有最小样本量）',
      window_minutes: windowMinutes,
      min_samples: minSamples,
      evaluate(now) {
        const { from, to } = range(now);
        const denominator = aggregateOrZero('http_requests_total', { from, to });
        const numerator = aggregateOrZero('http_requests_total', { from, to }, {
          status_class: '5xx',
        });
        return ratioEvidence({
          metric: 'http_requests_total',
          numerator,
          denominator,
          threshold: 0.2,
          minSamples,
          windowMinutes,
          from,
          to,
        });
      },
    },
    {
      id: 'model_failure_rate',
      name: '模型调用失败率',
      severity: 'P1',
      version: RULE_VERSION,
      description: '失败或超时的模型请求占全部模型请求比例超过阈值',
      window_minutes: windowMinutes,
      min_samples: Math.max(5, Math.min(minSamples, 10)),
      evaluate(now) {
        const { from, to } = range(now);
        const denominator = aggregateOrZero('model_requests_total', { from, to });
        const failed = aggregateOrZero('model_requests_total', { from, to }, {
          status: 'failed',
        });
        const timeout = aggregateOrZero('model_requests_total', { from, to }, {
          status: 'timeout',
        });
        return ratioEvidence({
          metric: 'model_requests_total',
          numerator: { count: failed.count + timeout.count },
          denominator,
          threshold: 0.3,
          minSamples: Math.max(5, Math.min(minSamples, 10)),
          windowMinutes,
          from,
          to,
        });
      },
    },
    {
      id: 'tool_failure_rate',
      name: '工具调用失败率',
      severity: 'P2',
      version: RULE_VERSION,
      description: '失败/超时/被拒绝的工具调用占全部工具调用比例超过阈值',
      window_minutes: windowMinutes,
      min_samples: Math.max(5, Math.min(minSamples, 10)),
      evaluate(now) {
        const { from, to } = range(now);
        const denominator = aggregateOrZero('tool_calls_total', { from, to });
        const failed = aggregateOrZero('tool_calls_total', { from, to }, { status: 'failed' });
        const timeout = aggregateOrZero('tool_calls_total', { from, to }, { status: 'timeout' });
        const denied = aggregateOrZero('tool_calls_total', { from, to }, { status: 'denied' });
        return ratioEvidence({
          metric: 'tool_calls_total',
          numerator: { count: failed.count + timeout.count + denied.count },
          denominator,
          threshold: 0.3,
          minSamples: Math.max(5, Math.min(minSamples, 10)),
          windowMinutes,
          from,
          to,
        });
      },
    },
    {
      id: 'memory_search_failure_rate',
      name: '记忆检索失败率',
      severity: 'P1',
      version: RULE_VERSION,
      description: '记忆检索出错占全部检索调用比例超过阈值（空结果不算失败）',
      window_minutes: windowMinutes,
      min_samples: Math.max(3, Math.min(minSamples, 5)),
      evaluate(now) {
        const { from, to } = range(now);
        const denominator = aggregateOrZero('memory_searches_total', { from, to });
        const failed = aggregateOrZero('memory_searches_total', { from, to }, {
          status: 'failed',
        });
        return ratioEvidence({
          metric: 'memory_searches_total',
          numerator: failed,
          denominator,
          threshold: 0.5,
          minSamples: Math.max(3, Math.min(minSamples, 5)),
          windowMinutes,
          from,
          to,
        });
      },
    },
    {
      id: 'memory_injection_zero',
      name: '记忆检索成功但注入持续为 0',
      severity: 'P2',
      version: RULE_VERSION,
      description: '窗口内成功检索达到最小样本量，但没有任何记忆条目进入最终请求',
      window_minutes: Math.max(30, windowMinutes),
      min_samples: 10,
      evaluate(now) {
        const from = now - Math.max(30, windowMinutes) * 60 * 1000;
        const to = now;
        const searched = aggregateOrZero('memory_searches_total', { from, to }, {
          status: 'success',
        });
        const injected = aggregateOrZero('memory_injected_items_total', { from, to });
        const samples = searched.count;
        const insufficient = samples < 10;
        return {
          observed: injected.count,
          numerator: injected.count,
          denominator: samples,
          threshold: 0,
          min_samples: 10,
          samples,
          insufficient_data: insufficient,
          breached: !insufficient && injected.count === 0,
          window_minutes: Math.max(30, windowMinutes),
          from: new Date(from).toISOString(),
          to: new Date(to).toISOString(),
          metric: 'memory_injected_items_total',
          note: '候选存在但全部被覆盖/过期/冲突排除时也会触发，需结合上下文 trace 判断',
        };
      },
    },
    {
      id: 'context_build_failure_rate',
      name: '上下文构建失败率',
      severity: 'P1',
      version: RULE_VERSION,
      description: '上下文构建失败占全部构建比例超过阈值',
      window_minutes: windowMinutes,
      min_samples: Math.max(3, Math.min(minSamples, 5)),
      evaluate(now) {
        const { from, to } = range(now);
        const denominator = aggregateOrZero('context_builds_total', { from, to });
        const failed = aggregateOrZero('context_builds_total', { from, to }, {
          status: 'failed',
        });
        return ratioEvidence({
          metric: 'context_builds_total',
          numerator: failed,
          denominator,
          threshold: 0.2,
          minSamples: Math.max(3, Math.min(minSamples, 5)),
          windowMinutes,
          from,
          to,
        });
      },
    },
    {
      id: 'context_input_rejected',
      name: '上下文超限拒绝',
      severity: 'P1',
      version: RULE_VERSION,
      description: '用户当前任务或核心规则导致上下文无法安全组装（context_too_large）',
      window_minutes: windowMinutes,
      min_samples: 1,
      evaluate(now) {
        const { from, to } = range(now);
        const rejected = aggregateOrZero('context_builds_total', { from, to }, {
          error_code: 'context_too_large',
        });
        return {
          observed: rejected.count,
          numerator: rejected.count,
          denominator: rejected.count,
          threshold: 0,
          min_samples: 1,
          samples: rejected.count,
          insufficient_data: false,
          breached: rejected.count > 0,
          window_minutes: windowMinutes,
          from: new Date(from).toISOString(),
          to: new Date(to).toISOString(),
          metric: 'context_builds_total',
        };
      },
    },
    {
      id: 'persistence_write_failure',
      name: '会话落盘失败',
      severity: 'P1',
      version: RULE_VERSION,
      description: '窗口内出现任何一次会话写入失败',
      window_minutes: windowMinutes,
      min_samples: 1,
      evaluate(now) {
        const { from, to } = range(now);
        const failed = aggregateOrZero('persistence_writes_total', { from, to }, {
          status: 'failed',
        });
        return {
          observed: failed.count,
          numerator: failed.count,
          denominator: failed.count,
          threshold: 0,
          min_samples: 1,
          samples: failed.count,
          insufficient_data: false,
          breached: failed.count > 0,
          window_minutes: windowMinutes,
          from: new Date(from).toISOString(),
          to: new Date(to).toISOString(),
          metric: 'persistence_writes_total',
        };
      },
    },
    {
      id: 'backup_stale_or_failed',
      name: '备份陈旧或最近失败',
      severity: 'P2',
      version: RULE_VERSION,
      description: '最近备份状态陈旧/失败（无状态文件时为 insufficient_data，不误报）',
      window_minutes: windowMinutes,
      min_samples: 1,
      evaluate(now) {
        let status;
        try {
          status = backup.checkStatus();
        } catch (error) {
          return {
            observed: null,
            numerator: 0,
            denominator: 0,
            threshold: 0,
            min_samples: 1,
            samples: 0,
            insufficient_data: true,
            breached: false,
            window_minutes: windowMinutes,
            from: new Date(now - windowMinutes * 60000).toISOString(),
            to: new Date(now).toISOString(),
            metric: 'backup.checkStatus',
            reason: error && error.code ? error.code : 'status_read_failed',
          };
        }

        const exists = status.exists === true;
        const breached = exists && status.ok !== true;
        return {
          observed: exists ? (status.ok === true ? 0 : 1) : null,
          numerator: breached ? 1 : 0,
          denominator: exists ? 1 : 0,
          threshold: 0,
          min_samples: 1,
          samples: exists ? 1 : 0,
          insufficient_data: !exists,
          breached,
          window_minutes: windowMinutes,
          from: new Date(now - windowMinutes * 60000).toISOString(),
          to: new Date(now).toISOString(),
          metric: 'backup.checkStatus',
          reason: status.reason,
          age_hours: status.ageHours,
        };
      },
    },
    {
      id: 'data_event_failure',
      name: '数据文件损坏或落盘异常',
      severity: 'P1',
      version: RULE_VERSION,
      description: '窗口内出现数据损坏/落盘失败事件',
      window_minutes: windowMinutes,
      min_samples: 1,
      evaluate(now) {
        const { from, to } = range(now);
        const events = store.listEvents({
          from,
          to,
          eventName: 'data.event',
          status: 'failed',
          limit: 200,
        });
        return {
          observed: events.total,
          numerator: events.total,
          denominator: events.total,
          threshold: 0,
          min_samples: 1,
          samples: events.total,
          insufficient_data: false,
          breached: events.total > 0,
          window_minutes: windowMinutes,
          from: new Date(from).toISOString(),
          to: new Date(to).toISOString(),
          metric: 'data.event(status=failed)',
        };
      },
    },
    {
      id: 'security_denied_operation',
      name: '权限拒绝 / 安全事件',
      severity: 'P0',
      version: RULE_VERSION,
      description: '窗口内出现被拒绝的工具调用或敏感操作审计拒绝',
      window_minutes: windowMinutes,
      min_samples: 1,
      evaluate(now) {
        const { from, to } = range(now);
        const deniedEvents = store.listEvents({
          from,
          to,
          status: 'denied',
          limit: 200,
        });
        const audits = store.listAudit({ from, to, limit: 200 });
        const deniedAudits = audits.items.filter(item => item.result === 'denied');
        const count = deniedEvents.total + deniedAudits.length;
        return {
          observed: count,
          numerator: count,
          denominator: count,
          threshold: 0,
          min_samples: 1,
          samples: count,
          insufficient_data: false,
          breached: count > 0,
          window_minutes: windowMinutes,
          from: new Date(from).toISOString(),
          to: new Date(to).toISOString(),
          metric: 'events.status=denied',
          note:
            deniedEvents.total > deniedEvents.items.length
              ? '事件窗口超过 200 条，按已读取样本计数'
              : null,
        };
      },
    },
    {
      id: 'task_max_rounds',
      name: 'Agent 达到最大轮数',
      severity: 'P2',
      version: RULE_VERSION,
      description: '窗口内任务因达到 Agent 最大轮数而结束',
      window_minutes: Math.max(10, windowMinutes),
      min_samples: 1,
      evaluate(now) {
        const from = now - Math.max(10, windowMinutes) * 60 * 1000;
        const to = now;
        const events = store.listEvents({
          from,
          to,
          eventName: 'task.completed',
          limit: 200,
        });
        const hit = events.items.filter(
          event => event.attributes && event.attributes.termination === 'max_rounds'
        ).length;
        return {
          observed: hit,
          numerator: hit,
          denominator: events.total,
          threshold: 0,
          min_samples: 1,
          samples: hit,
          insufficient_data: false,
          breached: hit > 0,
          window_minutes: Math.max(10, windowMinutes),
          from: new Date(from).toISOString(),
          to: new Date(to).toISOString(),
          metric: 'task.completed.termination=max_rounds',
        };
      },
    },
    {
      id: 'monitoring_self_degraded',
      name: '监控自身降级',
      severity: 'P2',
      version: RULE_VERSION,
      description: '事件写盘失败、队列丢弃、指标系列超限或查询异常出现新增',
      window_minutes: windowMinutes,
      min_samples: 1,
      evaluate(now, ruleState) {
        const stats = store.getStats();
        const metricHealth = metrics.getHealth();
        const counters = {
          event_write_failures: (stats.stats && stats.stats.writeFailures) || 0,
          trace_write_failures: (stats.stats && stats.stats.traceWriteFailures) || 0,
          audit_write_failures: (stats.stats && stats.stats.auditWriteFailures) || 0,
          alert_write_failures: (stats.stats && stats.stats.alertWriteFailures) || 0,
          queue_dropped: (stats.stats && stats.stats.queueDropped) || 0,
          invalid_events: (stats.stats && stats.stats.invalidEvents) || 0,
          metric_write_errors: metricHealth.write_errors || 0,
          metric_dropped_series: metricHealth.dropped_series || 0,
        };

        const baseline = ruleState.baseline || {};
        const deltas = {};
        let total = 0;
        for (const [key, value] of Object.entries(counters)) {
          const previous = Number(baseline[key]) || 0;
          const delta = Math.max(0, value - previous);
          if (delta > 0) deltas[key] = delta;
          total += delta;
        }

        // 降级持续期间保留基线，恢复后才对齐到当前值，避免每轮重复触发。
        if (total === 0) ruleState.baseline = counters;

        return {
          observed: total,
          numerator: total,
          denominator: total,
          threshold: 0,
          min_samples: 1,
          samples: total,
          insufficient_data: false,
          breached: total > 0,
          window_minutes: windowMinutes,
          from: new Date(now - windowMinutes * 60 * 1000).toISOString(),
          to: new Date(now).toISOString(),
          metric: 'monitoring_internal_counters',
          deltas,
          counters,
        };
      },
    },
    {
      id: 'single_task_token_spike',
      name: '单任务 Token 异常',
      severity: 'P2',
      version: RULE_VERSION,
      enabled: false,
      disabled_reason: '阈值必须来自真实生产基线与模型窗口，当前无基线数据，不编造数字',
      description: '单任务 Token 用量超过基线阈值',
      window_minutes: windowMinutes,
      min_samples: 1,
    },
    {
      id: 'cost_spike',
      name: '成本异常突增',
      severity: 'P2',
      version: RULE_VERSION,
      enabled: false,
      disabled_reason: '未配置任何模型费率与账单数据，成本只能显示「未配置」而非估算值',
      description: '单任务或短期成本超过基线阈值',
      window_minutes: windowMinutes,
      min_samples: 1,
    },
  ];

  return rules;
}

const STATE = {
  config: null,
  rules: [],
  ruleState: new Map(),
  alerts: new Map(),
  timer: null,
  initialTimer: null,
  lastEvaluatedAt: null,
  evaluations: 0,
  evaluationErrors: 0,
  lastError: null,
};

function initAlerts(config) {
  if (STATE.config) return;
  STATE.config = config;
  STATE.rules = buildRules(config);

  // 恢复告警文件时按 alert_id 去重，保留 last_evaluated_at 最新的一条状态。
  const persisted = store.listAlertRecords({ limit: 200 });
  const latestById = new Map();
  for (const record of persisted.items) {
    if (!record || typeof record.alert_id !== 'string') continue;
    const stamp = Date.parse(record.last_evaluated_at || record.triggered_at) || 0;
    const existing = latestById.get(record.alert_id);
    if (!existing || stamp >= existing.stamp) {
      latestById.set(record.alert_id, { record, stamp });
    }
  }

  for (const { record } of latestById.values()) {
    STATE.alerts.set(record.alert_id, record);
    if (record.status !== 'firing') continue;

    // 重启后恢复活动告警，避免第一次评估再生成一条重复告警。
    const rule = STATE.rules.find(item => item.id === record.rule_id);
    if (!rule) continue;

    STATE.ruleState.set(rule.id, {
      status: 'firing',
      activeAlertId: record.alert_id,
      lastEvaluatedAt: record.last_evaluated_at || null,
      lastBreachAt: Date.parse(record.last_evaluated_at || record.triggered_at) || Date.now(),
      baseline: null,
    });
  }

  STATE.timer = setInterval(() => {
    evaluateAlerts();
  }, config.alertIntervalMs);
  if (typeof STATE.timer.unref === 'function') STATE.timer.unref();

  // 启动后先评估一次，让告警中心不是空等一个周期；仍然遵守最小样本量。
  STATE.initialTimer = setTimeout(() => {
    STATE.initialTimer = null;
    evaluateAlerts();
  }, 1000);
  if (typeof STATE.initialTimer.unref === 'function') STATE.initialTimer.unref();
}

function createAlert(rule, evidence, now) {
  const alert = {
    alert_id: `al_${crypto.randomUUID()}`,
    rule_id: rule.id,
    rule_name: rule.name,
    rule_version: rule.version,
    severity: rule.severity,
    status: 'firing',
    triggered_at: new Date(now).toISOString(),
    last_evaluated_at: new Date(now).toISOString(),
    resolved_at: null,
    suppressed_evaluations: 0,
    evidence,
    note: '站内告警；未配置外部通知通道',
  };
  STATE.alerts.set(alert.alert_id, alert);
  store.recordAlert(alert);
  metrics.increment('alerts_total', { rule_id: rule.id, severity: rule.severity }, 1, now);
  return alert;
}

function resolveAlert(alert, now) {
  alert.status = 'resolved';
  alert.resolved_at = new Date(now).toISOString();
  alert.last_evaluated_at = new Date(now).toISOString();
  store.recordAlert(alert);
  return alert;
}

function evaluateRule(rule, now) {
  const ruleState = STATE.ruleState.get(rule.id) || {
    status: 'insufficient_data',
    activeAlertId: null,
    lastEvaluatedAt: null,
    lastBreachAt: null,
    baseline: null,
  };

  let evidence;
  try {
    evidence = rule.evaluate(now, ruleState);
  } catch (_error) {
    STATE.evaluationErrors += 1;
    STATE.lastError = `${rule.id}:evaluate_failed`;
    ruleState.status = 'unknown';
    ruleState.lastEvaluatedAt = new Date(now).toISOString();
    STATE.ruleState.set(rule.id, ruleState);
    return {
      rule,
      state: ruleState.status,
      evidence: { error: 'evaluation_failed' },
    };
  }

  ruleState.lastEvaluatedAt = new Date(now).toISOString();

  if (evidence.insufficient_data) {
    if (ruleState.activeAlertId) {
      // 低流量不等于恢复，但持续超过恢复窗口没有任何违反，也应结束活动告警，
      // 否则一次夜间故障会永远停留在 firing。
      const resolveAfter = STATE.config.alertResolveAfterMinutes * 60 * 1000;
      const quietFor = ruleState.lastBreachAt ? now - ruleState.lastBreachAt : Infinity;
      if (quietFor >= resolveAfter) {
        const alert = STATE.alerts.get(ruleState.activeAlertId);
        if (alert && alert.status === 'firing') resolveAlert(alert, now);
        ruleState.activeAlertId = null;
        ruleState.status = 'resolved';
      }
    } else {
      ruleState.status = 'insufficient_data';
    }
    STATE.ruleState.set(rule.id, ruleState);
    return { rule, state: ruleState.status, evidence };
  }

  if (evidence.breached) {
    ruleState.lastBreachAt = now;

    if (!ruleState.activeAlertId) {
      const alert = createAlert(rule, evidence, now);
      ruleState.activeAlertId = alert.alert_id;
      ruleState.status = 'firing';
    } else {
      const alert = STATE.alerts.get(ruleState.activeAlertId);
      if (alert && alert.status === 'firing') {
        alert.last_evaluated_at = new Date(now).toISOString();
        alert.suppressed_evaluations += 1;
        alert.evidence = evidence;
      }
    }
  } else if (ruleState.activeAlertId) {
    const resolveAfter = STATE.config.alertResolveAfterMinutes * 60 * 1000;
    const quietFor = ruleState.lastBreachAt ? now - ruleState.lastBreachAt : Infinity;

    if (quietFor >= resolveAfter) {
      const alert = STATE.alerts.get(ruleState.activeAlertId);
      if (alert && alert.status === 'firing') resolveAlert(alert, now);
      ruleState.activeAlertId = null;
      ruleState.status = 'resolved';
    } else {
      ruleState.status = 'firing';
    }
  } else {
    ruleState.status = 'ok';
  }

  STATE.ruleState.set(rule.id, ruleState);
  return { rule, state: ruleState.status, evidence };
}

function evaluateAlerts({ now = Date.now() } = {}) {
  if (!STATE.config) return { ok: false, reason: 'not_initialized', rules: [] };
  STATE.evaluations += 1;
  STATE.lastEvaluatedAt = new Date(now).toISOString();

  const results = [];
  for (const rule of STATE.rules) {
    if (rule.enabled === false) {
      results.push({
        rule: publicRule(rule),
        state: 'disabled',
        evidence: { disabled_reason: rule.disabled_reason },
      });
      continue;
    }
    const outcome = evaluateRule(rule, now);
    results.push({
      rule: publicRule(rule),
      state: outcome.state,
      evidence: outcome.evidence,
    });
  }

  return { ok: true, evaluated_at: STATE.lastEvaluatedAt, rules: results };
}

function publicRule(rule) {
  return {
    id: rule.id,
    name: rule.name,
    severity: rule.severity,
    version: rule.version,
    description: rule.description,
    window_minutes: rule.window_minutes,
    min_samples: rule.min_samples,
    enabled: rule.enabled !== false,
    ...(rule.disabled_reason ? { disabled_reason: rule.disabled_reason } : {}),
  };
}

function getRules() {
  return STATE.rules.map(publicRule);
}

function getStates() {
  return STATE.rules.map(rule => {
    const state = STATE.ruleState.get(rule.id);
    return {
      rule: publicRule(rule),
      state: rule.enabled === false ? 'disabled' : (state && state.status) || 'unknown',
      last_evaluated_at: (state && state.lastEvaluatedAt) || null,
      active_alert_id: (state && state.activeAlertId) || null,
    };
  });
}

function listAlerts({ status = null, severity = null, limit = 50 } = {}) {
  const items = [...STATE.alerts.values()]
    .filter(alert => {
      if (status && alert.status !== status) return false;
      if (severity && alert.severity !== severity) return false;
      return true;
    })
    .sort((a, b) => Date.parse(b.triggered_at) - Date.parse(a.triggered_at))
    .slice(0, Math.max(1, Math.min(200, limit)));
  return { items, total: STATE.alerts.size };
}

function getAlertingHealth() {
  return {
    initialized: Boolean(STATE.config),
    rule_count: STATE.rules.length,
    enabled_rules: STATE.rules.filter(rule => rule.enabled !== false).length,
    evaluations: STATE.evaluations,
    evaluation_errors: STATE.evaluationErrors,
    last_error: STATE.lastError,
    last_evaluated_at: STATE.lastEvaluatedAt,
    active_alerts: [...STATE.alerts.values()].filter(alert => alert.status === 'firing').length,
    notifications: {
      configured: false,
      reason: '未配置短信/邮件/Webhook 通道；当前仅站内告警',
    },
  };
}

function stopAlerts() {
  if (STATE.timer) clearInterval(STATE.timer);
  if (STATE.initialTimer) clearTimeout(STATE.initialTimer);
  STATE.timer = null;
  STATE.initialTimer = null;
}

function resetAlertsForTests() {
  if (STATE.timer) clearInterval(STATE.timer);
  STATE.config = null;
  STATE.rules = [];
  STATE.ruleState = new Map();
  STATE.alerts = new Map();
  STATE.timer = null;
  if (STATE.initialTimer) clearTimeout(STATE.initialTimer);
  STATE.initialTimer = null;
  STATE.lastEvaluatedAt = null;
  STATE.evaluations = 0;
  STATE.evaluationErrors = 0;
  STATE.lastError = null;
}

module.exports = {
  SEVERITIES,
  RULE_VERSION,
  initAlerts,
  buildRules,
  evaluateAlerts,
  getRules,
  getStates,
  listAlerts,
  getAlertingHealth,
  stopAlerts,
  resetAlertsForTests,
};
