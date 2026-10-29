/**
 * 云岫 Bluebird — 监控配置（monitoring/config.js）
 *
 * 所有上限/保留期/查询边界都集中在这里，且有硬边界：
 * - 监控模块缺省启用（BLUEBIRD_MONITORING=0 可关闭），关闭时前端必须显示
 *   disabled/degraded，而不是「健康」；
 * - 任何环境变量非法都回退默认值并留一条警告（绝不因监控配置让主业务起不来）；
 * - 本文件不读文件、不建目录、不启动定时器，纯配置解析，便于测试。
 */

const DEFAULTS = Object.freeze({
  enabled: true,
  dataSubdir: 'monitoring',
  // 内存/文件上限：事件、Trace、审计、告警各自独立，互不挤占。
  maxEvents: 20000,
  maxTraces: 2000,
  maxSpansPerTrace: 200,
  maxAuditEvents: 5000,
  maxAlerts: 200,
  // 单个 JSONL 文件上限；超过即滚动，旧文件按保留期清理。
  maxFileBytes: 32 * 1024 * 1024,
  maxStorageBytes: 256 * 1024 * 1024,
  retentionDays: 7,
  // 写入队列：批量追加，失败不回灌主业务，只累加内部健康信号。
  flushBatchSize: 200,
  flushIntervalMs: 1000,
  // 查询边界：防止监控查询把服务拖垮。
  maxQueryRangeHours: 24 * 7,
  defaultQueryLimit: 50,
  maxQueryLimit: 500,
  // 告警：明确时间窗 + 最小样本量，低流量不误报。
  alertIntervalMs: 60 * 1000,
  alertWindowMinutes: 5,
  alertMinSamples: 20,
  alertResolveAfterMinutes: 10,
  // 指标分桶保留分钟数（与查询上限一致）。
  metricRetentionMinutes: 24 * 60,
});

const INT_BOUNDS = {
  maxEvents: [100, 200000],
  maxTraces: [50, 20000],
  maxSpansPerTrace: [20, 1000],
  maxAuditEvents: [100, 50000],
  maxAlerts: [20, 5000],
  maxFileBytes: [1024 * 1024, 512 * 1024 * 1024],
  maxStorageBytes: [8 * 1024 * 1024, 4 * 1024 * 1024 * 1024],
  retentionDays: [1, 90],
  flushBatchSize: [1, 5000],
  flushIntervalMs: [100, 60000],
  maxQueryRangeHours: [1, 24 * 30],
  defaultQueryLimit: [1, 500],
  maxQueryLimit: [1, 2000],
  alertIntervalMs: [5000, 3600000],
  alertWindowMinutes: [1, 24 * 60],
  alertMinSamples: [1, 100000],
  alertResolveAfterMinutes: [1, 24 * 60],
  metricRetentionMinutes: [60, 24 * 60 * 7],
};

function readEnvInt(raw, fallback, boundsKey, displayName) {
  if (raw === undefined || raw === '') return fallback;

  const value = Number(raw);
  const bounds = INT_BOUNDS[boundsKey];

  if (!Number.isInteger(value)) {
    console.warn(`[monitoring] ${displayName}=${raw} 不是整数，回退默认 ${fallback}`);
    return fallback;
  }

  const [min, max] = bounds || [-Infinity, Infinity];

  if (value < min || value > max) {
    console.warn(
      `[monitoring] ${displayName}=${raw} 超出范围 ${min}-${max}，回退默认 ${fallback}`
    );
    return fallback;
  }

  return value;
}

function loadConfig() {
  const enabled = process.env.BLUEBIRD_MONITORING !== '0';

  const config = {
    enabled,
    dataSubdir: DEFAULTS.dataSubdir,
    // 逐个显式读取环境变量：不做 process.env[name] 动态访问，
    // 既满足 Expo lint 规则，也让每个开关都能被 grep 到。
    maxEvents: readEnvInt(
      process.env.BLUEBIRD_MONITORING_MAX_EVENTS,
      DEFAULTS.maxEvents,
      'maxEvents',
      'BLUEBIRD_MONITORING_MAX_EVENTS'
    ),
    maxTraces: readEnvInt(
      process.env.BLUEBIRD_MONITORING_MAX_TRACES,
      DEFAULTS.maxTraces,
      'maxTraces',
      'BLUEBIRD_MONITORING_MAX_TRACES'
    ),
    maxSpansPerTrace: readEnvInt(
      process.env.BLUEBIRD_MONITORING_MAX_SPANS_PER_TRACE,
      DEFAULTS.maxSpansPerTrace,
      'maxSpansPerTrace',
      'BLUEBIRD_MONITORING_MAX_SPANS_PER_TRACE'
    ),
    maxAuditEvents: readEnvInt(
      process.env.BLUEBIRD_MONITORING_MAX_AUDIT_EVENTS,
      DEFAULTS.maxAuditEvents,
      'maxAuditEvents',
      'BLUEBIRD_MONITORING_MAX_AUDIT_EVENTS'
    ),
    maxAlerts: readEnvInt(
      process.env.BLUEBIRD_MONITORING_MAX_ALERTS,
      DEFAULTS.maxAlerts,
      'maxAlerts',
      'BLUEBIRD_MONITORING_MAX_ALERTS'
    ),
    maxFileBytes: readEnvInt(
      process.env.BLUEBIRD_MONITORING_MAX_FILE_BYTES,
      DEFAULTS.maxFileBytes,
      'maxFileBytes',
      'BLUEBIRD_MONITORING_MAX_FILE_BYTES'
    ),
    maxStorageBytes: readEnvInt(
      process.env.BLUEBIRD_MONITORING_MAX_STORAGE_BYTES,
      DEFAULTS.maxStorageBytes,
      'maxStorageBytes',
      'BLUEBIRD_MONITORING_MAX_STORAGE_BYTES'
    ),
    retentionDays: readEnvInt(
      process.env.BLUEBIRD_MONITORING_RETENTION_DAYS,
      DEFAULTS.retentionDays,
      'retentionDays',
      'BLUEBIRD_MONITORING_RETENTION_DAYS'
    ),
    flushBatchSize: readEnvInt(
      process.env.BLUEBIRD_MONITORING_FLUSH_BATCH_SIZE,
      DEFAULTS.flushBatchSize,
      'flushBatchSize',
      'BLUEBIRD_MONITORING_FLUSH_BATCH_SIZE'
    ),
    flushIntervalMs: readEnvInt(
      process.env.BLUEBIRD_MONITORING_FLUSH_INTERVAL_MS,
      DEFAULTS.flushIntervalMs,
      'flushIntervalMs',
      'BLUEBIRD_MONITORING_FLUSH_INTERVAL_MS'
    ),
    maxQueryRangeHours: readEnvInt(
      process.env.BLUEBIRD_MONITORING_MAX_QUERY_RANGE_HOURS,
      DEFAULTS.maxQueryRangeHours,
      'maxQueryRangeHours',
      'BLUEBIRD_MONITORING_MAX_QUERY_RANGE_HOURS'
    ),
    defaultQueryLimit: readEnvInt(
      process.env.BLUEBIRD_MONITORING_DEFAULT_QUERY_LIMIT,
      DEFAULTS.defaultQueryLimit,
      'defaultQueryLimit',
      'BLUEBIRD_MONITORING_DEFAULT_QUERY_LIMIT'
    ),
    maxQueryLimit: readEnvInt(
      process.env.BLUEBIRD_MONITORING_MAX_QUERY_LIMIT,
      DEFAULTS.maxQueryLimit,
      'maxQueryLimit',
      'BLUEBIRD_MONITORING_MAX_QUERY_LIMIT'
    ),
    alertIntervalMs: readEnvInt(
      process.env.BLUEBIRD_MONITORING_ALERT_INTERVAL_MS,
      DEFAULTS.alertIntervalMs,
      'alertIntervalMs',
      'BLUEBIRD_MONITORING_ALERT_INTERVAL_MS'
    ),
    alertWindowMinutes: readEnvInt(
      process.env.BLUEBIRD_MONITORING_ALERT_WINDOW_MINUTES,
      DEFAULTS.alertWindowMinutes,
      'alertWindowMinutes',
      'BLUEBIRD_MONITORING_ALERT_WINDOW_MINUTES'
    ),
    alertMinSamples: readEnvInt(
      process.env.BLUEBIRD_MONITORING_ALERT_MIN_SAMPLES,
      DEFAULTS.alertMinSamples,
      'alertMinSamples',
      'BLUEBIRD_MONITORING_ALERT_MIN_SAMPLES'
    ),
    alertResolveAfterMinutes: readEnvInt(
      process.env.BLUEBIRD_MONITORING_ALERT_RESOLVE_AFTER_MINUTES,
      DEFAULTS.alertResolveAfterMinutes,
      'alertResolveAfterMinutes',
      'BLUEBIRD_MONITORING_ALERT_RESOLVE_AFTER_MINUTES'
    ),
    metricRetentionMinutes: readEnvInt(
      process.env.BLUEBIRD_MONITORING_METRIC_RETENTION_MINUTES,
      DEFAULTS.metricRetentionMinutes,
      'metricRetentionMinutes',
      'BLUEBIRD_MONITORING_METRIC_RETENTION_MINUTES'
    ),
  };

  // 互相约束：默认 limit 绝不能大于硬上限。
  if (config.defaultQueryLimit > config.maxQueryLimit) {
    config.defaultQueryLimit = config.maxQueryLimit;
  }

  return Object.freeze(config);
}

module.exports = { DEFAULTS, INT_BOUNDS, loadConfig };
