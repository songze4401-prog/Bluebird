/**
 * 云岫 Bluebird — 监控与数据可靠性健康（monitoring/health.js）
 *
 * 关键区分（页面第 4/7 节）：
 * - 「系统正常」与「监控没有数据」是两种状态：没数据时返回 no_data，
 *   绝不显示 0% / 健康；
 * - 监控自身降级要能被看见：写盘失败、队列丢弃、指标超限、告警评估异常；
 * - 备份状态只读现有状态文件，不触发备份、不修改任何数据；
 *   无状态文件时返回 not_configured，并明确「不代表已配置定时任务」。
 */
const fs = require('fs');
const path = require('path');
const backup = require('../backup');
const metrics = require('./metrics');
const store = require('./store');
const alerts = require('./alerts');
const { EVENTS } = require('./schema');

function safeFileSize(file) {
  try {
    return fs.statSync(file).size;
  } catch (_) {
    return null;
  }
}

function bytesOf(dir) {
  if (!dir) return null;
  const out = {};
  let total = 0;

  try {
    for (const name of fs.readdirSync(dir)) {
      if (!name.endsWith('.jsonl')) continue;
      const size = safeFileSize(path.join(dir, name));
      out[name] = size;
      if (Number.isFinite(size)) total += size;
    }
  } catch (_) {
    return { files: {}, total_bytes: 0, read_error: true };
  }

  return { files: out, total_bytes: total };
}

function backupHealth() {
  try {
    const status = backup.checkStatus();
    return {
      source: 'backup_status_file',
      code_present: true,
      scheduled_task_configured: 'unknown',
      scheduled_task_note:
        '仓库只有备份 CLI 与检查入口；是否配置 cron/Task Scheduler 无法从代码推断',
      exists: status.exists === true,
      ok: status.ok === true,
      stale: status.stale === true,
      age_hours: status.ageHours,
      reason: status.reason,
      last_success_at: status.status ? status.status.lastSuccessAt : null,
      consecutive_failures: status.status ? status.status.consecutiveFailures : null,
      same_volume_as_source: status.status ? status.status.sameVolumeAsSource : null,
      disaster_recovery_grade: status.status ? status.status.disasterRecoveryGrade : null,
      restore_drill: 'unknown',
      restore_drill_note: '本轮不执行恢复演练；最近演练记录需单独查看',
    };
  } catch (error) {
    return {
      source: 'backup_status_file',
      exists: false,
      ok: false,
      stale: null,
      reason: error && error.code ? error.code : 'status_read_failed',
      last_success_at: null,
      scheduled_task_configured: 'unknown',
      restore_drill: 'unknown',
    };
  }
}

function persistenceHealth({ from, to }) {
  const writes = metrics.aggregate('persistence_writes_total', { from, to });
  const failed = metrics.aggregate(
    'persistence_writes_total',
    { from, to },
    { status: 'failed' }
  );
  return {
    source: 'monitoring_events',
    window_from: new Date(from).toISOString(),
    window_to: new Date(to).toISOString(),
    writes: writes.count,
    failed: failed.count,
    ok: failed.count === 0 && writes.count > 0 ? true : failed.count > 0 ? false : null,
    note:
      writes.count === 0
        ? '窗口内没有落盘样本，不能判定持久化健康'
        : '只覆盖经监控埋点的会话落盘；备份与恢复演练见 backup 字段',
  };
}

function getHealth({ now = Date.now() } = {}) {
  const config = store.isInitialized() ? store.getStats().config : null;
  const stats = store.getStats();
  const metricHealth = metrics.getHealth();
  const alerting = getAlertingHealthSafe();
  const windowFrom = now - 24 * 60 * 60 * 1000;

  const storage = stats.initialized ? bytesOf(store.resolveDataDir({
    dataSubdir: 'monitoring',
  })) : null;

  // 用最近事件判断数据新鲜度（不扫描正文，只取时间）。
  const latest = stats.initialized
    ? store.listEvents({ from: 0, to: now, limit: 1 })
    : { items: [] };
  const latestEvent = latest.items[0] || null;
  const freshnessSeconds = latestEvent
    ? Math.max(0, Math.round((now - Date.parse(latestEvent.occurred_at)) / 1000))
    : null;

  const writeFailures =
    (stats.stats && (stats.stats.writeFailures +
      stats.stats.traceWriteFailures +
      stats.stats.auditWriteFailures +
      stats.stats.alertWriteFailures)) ||
    0;
  const dropped =
    (stats.stats &&
      (stats.stats.queueDropped +
        stats.stats.invalidEvents +
        stats.stats.auditDropped)) ||
    0;
  const metricProblems =
    (metricHealth.write_errors || 0) +
    (metricHealth.dropped_series || 0) +
    (alerting.evaluation_errors || 0);

  const reasons = [];
  if (writeFailures > 0) reasons.push('monitoring_write_failures');
  if (dropped > 0) reasons.push('monitoring_events_dropped_or_invalid');
  if (metricProblems > 0) reasons.push('monitoring_metric_or_alert_errors');

  let status = 'ok';
  if (!store.isInitialized()) {
    status = 'degraded';
    reasons.push('monitoring_not_initialized');
  } else if (writeFailures > 0 || dropped > 0 || metricProblems > 0) {
    status = 'degraded';
  } else if (stats.events === 0 && stats.traces === 0) {
    status = 'no_data';
  }

  const memory = typeof process.memoryUsage === 'function' ? process.memoryUsage() : null;

  return {
    generated_at: new Date(now).toISOString(),
    status,
    reasons,
    enabled: config ? true : false,
    version: 'v1',
    schema_version: 1,
    uptime_seconds: Math.round(process.uptime()),
    environment: process.env.NODE_ENV || 'unknown',
    data_freshness_seconds: freshnessSeconds,
    last_event_at: latestEvent ? latestEvent.occurred_at : null,
    storage: {
      data_subdir: config ? 'monitoring' : null,
      bytes: storage,
      limits: config,
      retained_events: stats.events,
      retained_traces: stats.traces,
      retained_audit: stats.audit,
      retained_alerts: stats.alerts,
      queue_depth: stats.queue,
    },
    counters: {
      accepted_events: (stats.stats && stats.stats.acceptedEvents) || 0,
      invalid_events: (stats.stats && stats.stats.invalidEvents) || 0,
      duplicate_events: (stats.stats && stats.stats.duplicateEvents) || 0,
      evicted_events: (stats.stats && stats.stats.evictedEvents) || 0,
      queue_dropped: (stats.stats && stats.stats.queueDropped) || 0,
      audit_evicted: (stats.stats && stats.stats.auditEvicted) || 0,
      audit_dropped: (stats.stats && stats.stats.auditDropped) || 0,
      alert_evicted: (stats.stats && stats.stats.alertEvicted) || 0,
      write_failures: writeFailures,
      rotations: (stats.stats && stats.stats.rotations) || 0,
      load_skipped: (stats.stats && stats.stats.loadSkipped) || 0,
      last_write_at: (stats.stats && stats.stats.lastWriteAt) || null,
      last_error: (stats.stats && stats.stats.lastError) || null,
    },
    metrics: metricHealth,
    alerting,
    persistence: persistenceHealth({ from: windowFrom, to: now }),
    backup: backupHealth(),
    memory: memory
      ? {
          rss_bytes: memory.rss,
          heap_used_bytes: memory.heapUsed,
          external_bytes: memory.external,
        }
      : null,
    capabilities: {
      real_chain_instrumentation: true,
      trace_explorer: true,
      context_stage_trace: true,
      external_notifications: false,
      external_notifications_note: '未配置短信/邮件/Webhook，不假设已连接',
      cost_estimation: false,
      cost_estimation_note: '未配置费率与供应商账单，成本显示为未配置',
      production_validation: 'pending',
      production_validation_note: '本地真实链路已验证；生产环境验收需在部署环境执行',
    },
  };
}

function getAlertingHealthSafe() {
  try {
    return alerts.getAlertingHealth();
  } catch (_) {
    return {
      initialized: false,
      rule_count: 0,
      enabled_rules: 0,
      evaluations: 0,
      evaluation_errors: 1,
      active_alerts: 0,
      notifications: { configured: false, reason: 'alerting module unavailable' },
    };
  }
}

module.exports = { getHealth, backupHealth, EVENTS };
