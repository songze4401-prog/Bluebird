/**
 * 云岫 Bluebird — 指标聚合（monitoring/metrics.js）
 *
 * 设计约束（页面第 1/4/7 节）：
 * - 指标只接受预定义名称与预定义标签，标签值有长度上限、系列总数有硬上限；
 *   会话 ID / trace ID / 错误详情等高基数字段永远不能进指标；
 * - 延迟分位数用固定桶近似（明确标注 approximate），不伪称精确；
 * - 没有样本时返回 null / insufficient_data，绝不显示看似正常的 0；
 * - 所有写入都是内存操作，异常被吞掉并累加内部健康计数，不影响主业务。
 */

const MINUTE_MS = 60 * 1000;

const LATENCY_BUCKETS = Object.freeze([
  5, 10, 25, 50, 100, 250, 500, 1000, 2500, 5000, 10000, 30000, 60000, 120000,
  300000,
]);

const METRIC_DEFINITIONS = Object.freeze({
  http_requests_total: {
    type: 'counter',
    unit: 'requests',
    description: '进入后端的 HTTP 请求数（按规范化路由与状态类）',
    labels: ['method', 'route', 'status_class'],
  },
  http_request_duration_ms: {
    type: 'histogram',
    unit: 'ms',
    description: 'HTTP 请求端到端耗时（不含未完成请求）',
    labels: ['route'],
    buckets: LATENCY_BUCKETS,
  },
  tasks_total: {
    type: 'counter',
    unit: 'tasks',
    description: '聊天任务终态数（成功/部分成功/失败/取消），分母只含已进入执行的任务',
    labels: ['status', 'termination'],
  },
  task_duration_ms: {
    type: 'histogram',
    unit: 'ms',
    description: '聊天任务从请求到收尾的总耗时',
    labels: ['status'],
    buckets: LATENCY_BUCKETS,
  },
  model_requests_total: {
    type: 'counter',
    unit: 'requests',
    description: '真实发往模型服务商的请求数（按服务商/模型/结果）',
    labels: ['provider_id', 'model_id', 'status', 'kind'],
  },
  model_request_duration_ms: {
    type: 'histogram',
    unit: 'ms',
    description: '模型请求耗时（不含 Agent 工具执行）',
    labels: ['provider_id', 'model_id'],
    buckets: LATENCY_BUCKETS,
  },
  model_tokens_total: {
    type: 'counter',
    unit: 'tokens',
    description: '模型 Token 用量；usage_source=provider 为供应商真实用量，missing 为未提供',
    labels: ['provider_id', 'model_id', 'token_kind', 'usage_source'],
  },
  model_cached_tokens_total: {
    type: 'counter',
    unit: 'tokens',
    description: '供应商返回的缓存命中 Token（未返回时无样本，不估算）',
    labels: ['provider_id', 'model_id'],
  },
  tool_deduped_total: {
    type: 'counter',
    unit: 'calls',
    description: '同一请求内同工具同参数被去重的调用数',
    labels: ['tool_name'],
  },
  tool_calls_total: {
    type: 'counter',
    unit: 'calls',
    description: '模型请求的工具调用与实际执行结果（按工具与状态）',
    labels: ['tool_name', 'status'],
  },
  tool_call_duration_ms: {
    type: 'histogram',
    unit: 'ms',
    description: '工具实际执行耗时（超时按 timeout 记录）',
    labels: ['tool_name'],
    buckets: LATENCY_BUCKETS,
  },
  agent_rounds: {
    type: 'histogram',
    unit: 'rounds',
    description: '一次 Agent 回合实际模型调用轮数（按终态）',
    labels: ['status'],
    buckets: [1, 2, 3, 4, 5, 10],
  },
  model_auto_routed_total: {
    type: 'counter',
    unit: 'requests',
    description: '视觉能力触发的模型自动路由次数（按原因）',
    labels: ['reason'],
  },
  memory_searches_total: {
    type: 'counter',
    unit: 'searches',
    description: '记忆检索调用数（成功/空结果/检索错误/会话隔离跳过）',
    labels: ['status'],
  },
  memory_injected_items_total: {
    type: 'counter',
    unit: 'items',
    description: '最终进入模型请求议程的记忆条目数',
    labels: ['memory_type'],
  },
  context_builds_total: {
    type: 'counter',
    unit: 'builds',
    description: '上下文构建终态（成功/超限拒绝/验证失败）',
    labels: ['status', 'error_code'],
  },
  context_stage_items_total: {
    type: 'counter',
    unit: 'items',
    description: '上下文各阶段条目数累计：candidate/selected/accepted/injected/sent',
    labels: ['stage'],
  },
  context_tokens_total: {
    type: 'counter',
    unit: 'tokens',
    description: '上下文 Token 计量：输入估算、模型窗口、输出预留',
    labels: ['kind', 'source'],
  },
  sse_connections_total: {
    type: 'counter',
    unit: 'connections',
    description: 'SSE 建连终态（completed/aborted/failed/rejected）',
    labels: ['status'],
  },
  persistence_writes_total: {
    type: 'counter',
    unit: 'writes',
    description: '会话落盘结果（success/failed/skipped）',
    labels: ['status'],
  },
  memory_writes_total: {
    type: 'counter',
    unit: 'writes',
    description: '长期记忆提取/写入结果',
    labels: ['action', 'status'],
  },
  monitoring_events_total: {
    type: 'counter',
    unit: 'events',
    description: '监控事件接收结果（accepted/dropped/invalid）',
    labels: ['outcome'],
  },
  alerts_total: {
    type: 'counter',
    unit: 'alerts',
    description: '告警触发次数（按规则与严重级别）',
    labels: ['rule_id', 'severity'],
  },
});

const MAX_SERIES = 2000;
const LABEL_VALUE_MAX = 64;

const series = new Map(); // key -> { name, labels, minutes: Map(minute, {count,sum,buckets}) }
let droppedSeries = 0;
let lastPruneMinute = 0;
let retentionMinutes = 24 * 60;

const health = {
  writes: 0,
  writeErrors: 0,
  droppedSeries: 0,
  lastWriteAt: null,
  lastError: null,
};

function setRetentionMinutes(minutes) {
  if (Number.isInteger(minutes) && minutes >= 60) retentionMinutes = minutes;
}

function labelValue(value) {
  if (typeof value === 'number' && Number.isFinite(value)) return String(value);
  if (typeof value === 'boolean') return String(value);
  if (typeof value !== 'string') return 'unknown';
  return value.length <= LABEL_VALUE_MAX ? value : value.slice(0, LABEL_VALUE_MAX);
}

function normalizeLabels(def, labels) {
  const out = {};
  const source = labels && typeof labels === 'object' ? labels : {};
  for (const key of def.labels) {
    const value = source[key];
    if (value === undefined || value === null || value === '') continue;
    out[key] = labelValue(value);
  }
  return out;
}

function seriesKey(name, labels) {
  return `${name}|${Object.entries(labels)
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([key, value]) => `${key}=${value}`)
    .join(',')}`;
}

function minuteOf(ts) {
  return Math.floor(ts / MINUTE_MS);
}

function getSeries(name, labels) {
  const def = METRIC_DEFINITIONS[name];
  if (!def) {
    health.writeErrors += 1;
    health.lastError = 'undefined_metric';
    return null;
  }

  const normalized = normalizeLabels(def, labels);
  const key = seriesKey(name, normalized);
  let entry = series.get(key);

  if (!entry) {
    if (series.size >= MAX_SERIES) {
      droppedSeries += 1;
      health.droppedSeries = droppedSeries;
      health.lastError = 'series_limit';
      return null;
    }
    entry = { name, labels: normalized, minutes: new Map() };
    series.set(key, entry);
  }

  return entry;
}

function pruneIfNeeded(now) {
  const minute = minuteOf(now);
  if (minute === lastPruneMinute) return;
  lastPruneMinute = minute;

  const cutoff = minute - retentionMinutes;

  for (const [key, entry] of series) {
    for (const bucketMinute of entry.minutes.keys()) {
      if (bucketMinute < cutoff) entry.minutes.delete(bucketMinute);
    }
    if (!entry.minutes.size) series.delete(key);
  }
}

function increment(name, labels = {}, value = 1, now = Date.now()) {
  try {
    const amount = Number(value);
    if (!Number.isFinite(amount) || amount < 0) return false;
    const def = METRIC_DEFINITIONS[name];
    if (!def || def.type !== 'counter') return false;
    const entry = getSeries(name, labels);
    if (!entry) return false;
    const minute = minuteOf(now);
    const bucket = entry.minutes.get(minute) || { count: 0, sum: 0, buckets: null };
    bucket.count += amount;
    bucket.sum += amount;
    entry.minutes.set(minute, bucket);
    health.writes += 1;
    health.lastWriteAt = new Date(now).toISOString();
    pruneIfNeeded(now);
    return true;
  } catch (_error) {
    health.writeErrors += 1;
    health.lastError = 'write_exception';
    return false;
  }
}

function observe(name, labels = {}, value, now = Date.now()) {
  try {
    const amount = Number(value);
    if (!Number.isFinite(amount) || amount < 0) return false;
    const def = METRIC_DEFINITIONS[name];
    if (!def || def.type !== 'histogram') return false;
    const entry = getSeries(name, labels);
    if (!entry) return false;
    const minute = minuteOf(now);
    const bucket = entry.minutes.get(minute) || {
      count: 0,
      sum: 0,
      buckets: new Array(def.buckets.length + 1).fill(0),
    };
    let index = def.buckets.findIndex(bound => amount <= bound);
    if (index < 0) index = def.buckets.length;
    bucket.buckets[index] += 1;
    bucket.count += 1;
    bucket.sum += amount;
    entry.minutes.set(minute, bucket);
    health.writes += 1;
    health.lastWriteAt = new Date(now).toISOString();
    pruneIfNeeded(now);
    return true;
  } catch (_error) {
    health.writeErrors += 1;
    health.lastError = 'write_exception';
    return false;
  }
}

// 分位数：固定桶上界近似；返回 { value, approximate:true, bucketIndex }。
function percentileFromBuckets(def, buckets, total, percentile) {
  if (!total) return null;
  const target = (percentile / 100) * total;
  let seen = 0;
  for (let i = 0; i < buckets.length; i += 1) {
    seen += buckets[i];
    if (seen >= target) {
      const upper = i < def.buckets.length ? def.buckets[i] : def.buckets[def.buckets.length - 1];
      return { value: upper, approximate: true, bucket_index: i };
    }
  }
  return {
    value: def.buckets[def.buckets.length - 1],
    approximate: true,
    bucket_index: def.buckets.length,
  };
}

function collect(name, { from, to } = {}, labelFilter = null) {
  const def = METRIC_DEFINITIONS[name];
  if (!def) return null;
  const fromMinute = minuteOf(from);
  const toMinute = minuteOf(to);
  const rows = [];

  for (const entry of series.values()) {
    if (entry.name !== name) continue;
    if (labelFilter && !Object.entries(labelFilter).every(([key, value]) => entry.labels[key] === value)) {
      continue;
    }
    let count = 0;
    let sum = 0;
    let buckets = def.type === 'histogram' ? new Array(def.buckets.length + 1).fill(0) : null;
    for (const [minute, bucket] of entry.minutes) {
      if (minute < fromMinute || minute > toMinute) continue;
      count += bucket.count;
      sum += bucket.sum;
      if (buckets && bucket.buckets) {
        for (let i = 0; i < bucket.buckets.length; i += 1) buckets[i] += bucket.buckets[i];
      }
    }
    if (!count) continue;
    const row = {
      labels: entry.labels,
      count,
      sum: Math.round(sum * 1000) / 1000,
      avg: count ? Math.round((sum / count) * 1000) / 1000 : null,
    };
    if (def.type === 'histogram') {
      row.p50 = percentileFromBuckets(def, buckets, count, 50);
      row.p95 = percentileFromBuckets(def, buckets, count, 95);
      row.p99 = percentileFromBuckets(def, buckets, count, 99);
      row.approximate = true;
    }
    rows.push(row);
  }

  rows.sort((a, b) => {
    const la = JSON.stringify(a.labels);
    const lb = JSON.stringify(b.labels);
    return la.localeCompare(lb);
  });

  return { name, definition: def, rows };
}

function aggregate(name, options = {}, labelFilter = null) {
  const data = collect(name, options, labelFilter);
  if (!data) return null;
  const rows = data.rows;
  const count = rows.reduce((acc, row) => acc + row.count, 0);
  const sum = rows.reduce((acc, row) => acc + row.sum, 0);

  const merged = {
    count,
    sum: Math.round(sum * 1000) / 1000,
    avg: count ? Math.round((sum / count) * 1000) / 1000 : null,
  };

  if (data.definition.type === 'histogram') {
    // 合并各标签系列的分桶后再算分位数。
    const buckets = new Array(data.definition.buckets.length + 1).fill(0);
    for (const entry of series.values()) {
      if (entry.name !== name) continue;
      if (labelFilter && !Object.entries(labelFilter).every(([key, value]) => entry.labels[key] === value)) continue;
      for (const [minute, bucket] of entry.minutes) {
        if (minute < minuteOf(options.from) || minute > minuteOf(options.to)) continue;
        if (!bucket.buckets) continue;
        for (let i = 0; i < bucket.buckets.length; i += 1) buckets[i] += bucket.buckets[i];
      }
    }
    merged.p50 = percentileFromBuckets(data.definition, buckets, count, 50);
    merged.p95 = percentileFromBuckets(data.definition, buckets, count, 95);
    merged.p99 = percentileFromBuckets(data.definition, buckets, count, 99);
    merged.approximate = true;
  }

  return { name, definition: data.definition, ...merged, labels: data.rows.map(row => row.labels) };
}

// 时间序列：按调用方区间聚合（分钟粒度），用于总览趋势。
function query(name, { from, to, intervalMinutes = 5 } = {}) {
  const def = METRIC_DEFINITIONS[name];
  if (!def) return null;
  const step = Math.max(1, Math.min(1440, Math.round(intervalMinutes)));
  const fromMs = Math.floor(from / MINUTE_MS) * MINUTE_MS;
  const toMs = Math.floor(to / MINUTE_MS) * MINUTE_MS;
  const points = [];

  for (let start = fromMs; start <= toMs; start += step * MINUTE_MS) {
    const end = start + step * MINUTE_MS - 1;
    const data = aggregate(name, { from: start, to: end });
    points.push({
      ts: new Date(start).toISOString(),
      count: data.count,
      sum: data.sum,
      avg: data.avg,
      ...(def.type === 'histogram' ? { p50: data.p50, p95: data.p95, p99: data.p99 } : {}),
      approximate: def.type === 'histogram',
      samples: data.count,
    });
  }

  return {
    name,
    definition: def,
    interval_minutes: step,
    points,
  };
}

function snapshot({ from, to }) {
  const out = {};
  for (const name of Object.keys(METRIC_DEFINITIONS)) {
    const data = aggregate(name, { from, to });
    out[name] = data;
  }
  return out;
}

function getHealth() {
  return {
    series: series.size,
    max_series: MAX_SERIES,
    dropped_series: droppedSeries,
    writes: health.writes,
    write_errors: health.writeErrors,
    last_write_at: health.lastWriteAt,
    last_error: health.lastError,
    retention_minutes: retentionMinutes,
    approximate_percentiles: true,
  };
}

function resetMetricsForTests() {
  series.clear();
  droppedSeries = 0;
  lastPruneMinute = 0;
  health.writes = 0;
  health.writeErrors = 0;
  health.droppedSeries = 0;
  health.lastWriteAt = null;
  health.lastError = null;
}

module.exports = {
  METRIC_DEFINITIONS,
  LATENCY_BUCKETS,
  MAX_SERIES,
  increment,
  observe,
  collect,
  aggregate,
  query,
  snapshot,
  getHealth,
  setRetentionMinutes,
  resetMetricsForTests,
  MINUTE_MS,
};
