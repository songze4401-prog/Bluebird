/* global __dirname, Buffer */
/**
 * 云岫 Bluebird — 有界事件 / Trace / 审计存储（monitoring/store.js）
 *
 * 可靠性边界：
 * - 内存环形上限 + JSONL 文件滚动 + 保留期清理，容量永远有界；
 * - 追加写使用「一行一个 JSON」：崩溃最多留下半行，启动加载逐行容错跳过，
 *   不会因为一条坏记录拒绝整个监控文件；
 * - 写盘失败不会回灌业务，也不会无限重试：失败计数进入健康信号，前端显示
 *   degraded，而不是假健康；
 * - Trace/审计与普通事件分开建模、分开限容，互不挤占；
 * - 本模块只记录元数据，事件规范化在 schema.js 完成，存储层不再接触正文。
 */
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const { normalizeEvent, maskSensitive } = require('./schema');

const STATE = {
  config: null,
  dataDir: null,
  events: [],
  eventIds: new Set(),
  traces: new Map(),
  audit: [],
  alerts: [],
  queue: [],
  pendingWrites: [],
  timers: { flush: null, retention: null },
  flushing: false,
  closed: false,
  files: { events: null, traces: null, audit: null, alerts: null },
  traceQueue: [],
  auditQueue: [],
  alertQueue: [],
  stats: {
    acceptedEvents: 0,
    invalidEvents: 0,
    duplicateEvents: 0,
    evictedEvents: 0,
    queueDropped: 0,
    writeFailures: 0,
    traceWriteFailures: 0,
    auditWriteFailures: 0,
    alertWriteFailures: 0,
    alertEvicted: 0,
    traceEvicted: 0,
    auditEvicted: 0,
    auditDropped: 0,
    rotations: 0,
    loadedEvents: 0,
    loadedTraces: 0,
    loadSkipped: 0,
    lastWriteAt: null,
    lastError: null,
    currentEventBytes: 0,
    currentTraceBytes: 0,
    currentAuditBytes: 0,
    currentAlertBytes: 0,
    startedAt: null,
  },
};

const MAX_LOAD_BYTES = 8 * 1024 * 1024;
const MAX_LOAD_LINES = 50000;

function nowIso() {
  return new Date().toISOString();
}

function resolveDataDir(config) {
  const base = process.env.BLUEBIRD_DATA_DIR
    ? path.resolve(process.env.BLUEBIRD_DATA_DIR)
    : path.join(__dirname, '..', 'data');
  return path.join(base, config.dataSubdir);
}

function fileStamp() {
  return new Date().toISOString().replace(/[:.]/g, '-');
}

function ensureDir(dir) {
  fs.mkdirSync(dir, { recursive: true });
}

function fileSize(file) {
  try {
    return fs.statSync(file).size;
  } catch (_) {
    return 0;
  }
}

// 读取文件尾部（最多 maxBytes），用于重启后恢复最近的监控视图。
function readTail(file, maxBytes) {
  try {
    const stat = fs.statSync(file);
    if (!stat.isFile()) return '';
    const start = Math.max(0, stat.size - maxBytes);
    const length = stat.size - start;
    const buffer = Buffer.alloc(length);
    const fd = fs.openSync(file, 'r');
    try {
      fs.readSync(fd, buffer, 0, length, start);
    } finally {
      fs.closeSync(fd);
    }
    let text = buffer.toString('utf8');
    // 从中间开始读时首行可能不完整，丢弃首个换行之前的内容。
    if (start > 0) {
      const index = text.indexOf('\n');
      text = index >= 0 ? text.slice(index + 1) : '';
    }
    return text;
  } catch (_) {
    return '';
  }
}

function parseLines(text, onRecord) {
  const lines = text.split('\n');
  let skipped = 0;
  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    try {
      const record = JSON.parse(trimmed);
      if (!onRecord(record)) skipped += 1;
    } catch (_) {
      skipped += 1;
    }
  }
  return skipped;
}

function rotate(file, prefix, bytesKey) {
  try {
    if (!fs.existsSync(file)) return;
    const rotated = path.join(
      path.dirname(file),
      `${prefix}-${fileStamp()}.jsonl`
    );
    fs.renameSync(file, rotated);
    STATE.stats[bytesKey] = 0;
    STATE.stats.rotations += 1;
  } catch (error) {
    STATE.stats.writeFailures += 1;
    STATE.stats.lastError = error && error.code ? error.code : 'rotate_failed';
  }
}

function queueFileAppend(file, records, bytesKey, failureKey) {
  if (!records.length) return;
  const text = `${records.map(record => JSON.stringify(record)).join('\n')}\n`;
  const bytes = Buffer.byteLength(text);

  if (STATE.stats[bytesKey] + bytes > STATE.config.maxFileBytes) {
    const prefix = file === STATE.files.events
      ? 'events'
      : file === STATE.files.traces
        ? 'traces'
        : 'audit';
    rotate(file, prefix, bytesKey);
  }

  // appendFile 是追加语义；单行 JSONL 的原子性由「一行一条」保证。
  const write = fs.promises
    .appendFile(file, text, 'utf8')
    .then(() => {
      STATE.stats[bytesKey] += bytes;
      STATE.stats.lastWriteAt = nowIso();
    })
    .catch(error => {
      STATE.stats[failureKey] += 1;
      STATE.stats.lastError = error && error.code ? error.code : 'append_failed';
    })
    .finally(() => {
      const index = STATE.pendingWrites.indexOf(write);
      if (index >= 0) STATE.pendingWrites.splice(index, 1);
    });

  STATE.pendingWrites.push(write);
}

function flushQueue() {
  if (STATE.flushing) return;
  if (!STATE.queue.length && !STATE.traceQueue.length && !STATE.auditQueue.length) {
    return;
  }
  STATE.flushing = true;

  const events = STATE.queue.splice(0, STATE.config.flushBatchSize);
  const traces = STATE.traceQueue.splice(0, STATE.config.flushBatchSize);
  const audits = STATE.auditQueue.splice(0, STATE.config.flushBatchSize);
  const alerts = STATE.alertQueue.splice(0, STATE.config.flushBatchSize);

  try {
    queueFileAppend(STATE.files.events, events, 'currentEventBytes', 'writeFailures');
    queueFileAppend(STATE.files.traces, traces, 'currentTraceBytes', 'traceWriteFailures');
    queueFileAppend(STATE.files.audit, audits, 'currentAuditBytes', 'auditWriteFailures');
    queueFileAppend(STATE.files.alerts, alerts, 'currentAlertBytes', 'alertWriteFailures');
  } catch (error) {
    STATE.stats.writeFailures += 1;
    STATE.stats.lastError = error && error.code ? error.code : 'flush_failed';
  } finally {
    STATE.flushing = false;
  }
}

function scheduleFlush() {
  if (STATE.timers.flush || STATE.closed || !STATE.config) return;
  STATE.timers.flush = setTimeout(() => {
    STATE.timers.flush = null;
    flushQueue();
    if (STATE.queue.length || STATE.traceQueue.length || STATE.auditQueue.length) {
      scheduleFlush();
    }
  }, STATE.config.flushIntervalMs);
  if (typeof STATE.timers.flush.unref === 'function') STATE.timers.flush.unref();
}

function cleanupRetention() {
  if (!STATE.config || !STATE.dataDir) return;
  const cutoff = Date.now() - STATE.config.retentionDays * 24 * 60 * 60 * 1000;
  const active = new Set(
    [STATE.files.events, STATE.files.traces, STATE.files.audit, STATE.files.alerts]
      .filter(Boolean)
      .map(file => path.basename(file))
  );

  try {
    const entries = [];
    let totalBytes = 0;

    for (const name of fs.readdirSync(STATE.dataDir)) {
      if (!name.endsWith('.jsonl')) continue;
      const file = path.join(STATE.dataDir, name);
      try {
        const stat = fs.statSync(file);
        entries.push({ name, file, mtimeMs: stat.mtimeMs, size: stat.size });
        totalBytes += stat.size;
      } catch (_) {
        /* 单个文件不可读时跳过 */
      }
    }

    // 先按保留期清理滚动文件，再按总容量上限删最旧的滚动文件；
    // 当前活动文件永不自动删除（否则会破坏正在写入的 JSONL）。
    const removable = entries
      .filter(entry => !active.has(entry.name))
      .sort((a, b) => a.mtimeMs - b.mtimeMs);

    const remove = entry => {
      try {
        fs.unlinkSync(entry.file);
        totalBytes -= entry.size;
      } catch (_) {
        /* 清理失败不影响采集 */
      }
    };

    for (const entry of removable) {
      if (entry.mtimeMs < cutoff) remove(entry);
    }

    for (const entry of removable) {
      if (totalBytes <= STATE.config.maxStorageBytes) break;
      if (!fs.existsSync(entry.file)) continue;
      remove(entry);
    }
  } catch (_) {
    /* 目录不可读时保持现状，健康接口会显示写盘状态 */
  }
}

function loadRecent() {
  if (!STATE.config || !STATE.dataDir) return;

  const eventText = readTail(STATE.files.events, MAX_LOAD_BYTES);
  const eventLines = [];
  const skippedEvents = parseLines(eventText, record => {
    if (
      !record ||
      typeof record !== 'object' ||
      typeof record.event_id !== 'string' ||
      typeof record.event_name !== 'string' ||
      typeof record.occurred_at !== 'string'
    ) {
      return false;
    }
    eventLines.push(record);
    return true;
  });

  const kept = eventLines.slice(-STATE.config.maxEvents);
  STATE.events = kept;
  STATE.eventIds = new Set(kept.map(event => event.event_id).filter(Boolean));
  STATE.stats.loadedEvents = kept.length;
  STATE.stats.loadSkipped += skippedEvents;

  const traceText = readTail(STATE.files.traces, MAX_LOAD_BYTES);
  let traceCount = 0;
  const skippedTraces = parseLines(traceText, record => {
    if (!record || typeof record !== 'object' || typeof record.trace_id !== 'string') {
      return false;
    }
    STATE.traces.set(record.trace_id, record);
    traceCount += 1;
    return true;
  });
  while (STATE.traces.size > STATE.config.maxTraces) {
    const oldest = STATE.traces.keys().next().value;
    STATE.traces.delete(oldest);
  }
  STATE.stats.loadedTraces = traceCount;
  STATE.stats.loadSkipped += skippedTraces;

  // 审计记录恢复只用于展示；数量按上限裁剪。
  const auditText = readTail(STATE.files.audit, MAX_LOAD_BYTES);
  const auditLines = [];
  const skippedAudit = parseLines(auditText, record => {
    if (!record || typeof record !== 'object' || typeof record.audit_id !== 'string') {
      return false;
    }
    auditLines.push(record);
    return true;
  });
  STATE.audit = auditLines.slice(-STATE.config.maxAuditEvents);
  STATE.stats.loadSkipped += skippedAudit;

  const alertText = readTail(STATE.files.alerts, MAX_LOAD_BYTES);
  const alertLines = [];
  const skippedAlerts = parseLines(alertText, record => {
    if (!record || typeof record !== 'object' || typeof record.alert_id !== 'string') {
      return false;
    }
    alertLines.push(record);
    return true;
  });
  STATE.alerts = alertLines.slice(-STATE.config.maxAlerts);
  STATE.stats.loadSkipped += skippedAlerts;
}

function initStore({ config, dataDir } = {}) {
  if (!config) throw new TypeError('[monitoring] initStore 需要 config');
  if (STATE.config) return { ok: true, already: true };

  STATE.config = config;
  STATE.dataDir = dataDir || resolveDataDir(config);
  ensureDir(STATE.dataDir);

  STATE.files.events = path.join(STATE.dataDir, 'events.jsonl');
  STATE.files.traces = path.join(STATE.dataDir, 'traces.jsonl');
  STATE.files.audit = path.join(STATE.dataDir, 'audit.jsonl');
  STATE.files.alerts = path.join(STATE.dataDir, 'alerts.jsonl');

  STATE.stats.currentEventBytes = fileSize(STATE.files.events);
  STATE.stats.currentTraceBytes = fileSize(STATE.files.traces);
  STATE.stats.currentAuditBytes = fileSize(STATE.files.audit);
  STATE.stats.currentAlertBytes = fileSize(STATE.files.alerts);
  STATE.stats.startedAt = nowIso();

  loadRecent();
  cleanupRetention();

  STATE.timers.retention = setInterval(cleanupRetention, 60 * 60 * 1000);
  if (typeof STATE.timers.retention.unref === 'function') {
    STATE.timers.retention.unref();
  }

  return {
    ok: true,
    dataDir: STATE.dataDir,
    loadedEvents: STATE.stats.loadedEvents,
    loadedTraces: STATE.stats.loadedTraces,
    loadSkipped: STATE.stats.loadSkipped,
  };
}

function isInitialized() {
  return Boolean(STATE.config);
}

function appendEvent(input, options = {}) {
  if (!STATE.config) return { ok: false, reason: 'not_initialized' };

  let normalized;
  try {
    normalized = normalizeEvent(input, options);
  } catch (_) {
    STATE.stats.invalidEvents += 1;
    return { ok: false, reason: 'normalize_failed' };
  }

  if (!normalized.ok) {
    STATE.stats.invalidEvents += 1;
    return { ok: false, reason: normalized.errors.join(',') };
  }

  const event = normalized.event;

  if (STATE.eventIds.has(event.event_id)) {
    STATE.stats.duplicateEvents += 1;
    return { ok: false, reason: 'duplicate_event' };
  }

  STATE.events.push(event);
  STATE.eventIds.add(event.event_id);
  STATE.stats.acceptedEvents += 1;

  while (STATE.events.length > STATE.config.maxEvents) {
    const removed = STATE.events.shift();
    if (removed && removed.event_id) STATE.eventIds.delete(removed.event_id);
    STATE.stats.evictedEvents += 1;
  }

  // 关联 Trace：只增加计数，不把事件正文复制进 Trace。
  if (event.trace_id && STATE.traces.has(event.trace_id)) {
    const trace = STATE.traces.get(event.trace_id);
    trace.event_count = (Number(trace.event_count) || 0) + 1;
  }

  // 写盘队列同样是硬上限：宁可丢弃最旧事件并计数，也不让内存无限增长。
  STATE.queue.push(event);
  const queueLimit = STATE.config.maxEvents;
  if (STATE.queue.length > queueLimit) {
    STATE.queue.splice(0, STATE.queue.length - queueLimit);
    STATE.stats.queueDropped += 1;
  }

  scheduleFlush();
  return { ok: true, event };
}

function startTrace({
  name = 'request',
  traceId,
  sessionRef = null,
  attributes = {},
  startedAt = nowIso(),
} = {}) {
  if (!STATE.config) return null;
  const id = typeof traceId === 'string' ? traceId : `tr_${crypto.randomUUID()}`;
  const trace = {
    trace_id: id,
    name: typeof name === 'string' ? name.slice(0, 80) : 'request',
    started_at: startedAt,
    ended_at: null,
    duration_ms: null,
    status: 'unknown',
    error_code: null,
    error_category: null,
    session_ref: sessionRef,
    attributes: attributes && typeof attributes === 'object' ? attributes : {},
    spans: [],
    spans_dropped: 0,
    stages: { candidate: null, selected: null, accepted: null, injected: null, sent: null, consumed: null },
    event_count: 0,
    model: {
      rounds: 0,
      calls: 0,
      input_tokens: null,
      output_tokens: null,
      total_tokens: null,
      usage_source: 'missing',
      provider_ids: [],
      model_ids: [],
    },
    tools: { requested: 0, executed: 0, succeeded: 0, failed: 0, deduped: 0, duration_ms: 0 },
    task: { status: 'unknown', termination: null },
    context: null,
    counts: {},
  };

  STATE.traces.set(id, trace);
  while (STATE.traces.size > STATE.config.maxTraces) {
    const oldest = STATE.traces.keys().next().value;
    STATE.traces.delete(oldest);
    STATE.stats.traceEvicted += 1;
  }
  return trace;
}

function addSpan(traceId, span) {
  if (!STATE.config || !traceId) return null;
  const trace = STATE.traces.get(traceId);
  if (!trace) return null;
  if (trace.spans.length >= STATE.config.maxSpansPerTrace) {
    trace.spans_dropped += 1;
    return null;
  }
  const normalized = {
    span_id: span.span_id,
    parent_span_id: span.parent_span_id || null,
    name: typeof span.name === 'string' ? span.name.slice(0, 80) : 'span',
    started_at: span.started_at || nowIso(),
    ended_at: null,
    duration_ms: null,
    status: 'unknown',
    error_code: null,
    attributes: span.attributes && typeof span.attributes === 'object' ? span.attributes : {},
  };
  trace.spans.push(normalized);
  return normalized;
}

function endSpan(traceId, spanId, { status = 'unknown', errorCode = null } = {}) {
  if (!STATE.config || !traceId || !spanId) return null;
  const trace = STATE.traces.get(traceId);
  if (!trace) return null;
  const span = trace.spans.find(item => item.span_id === spanId);
  if (!span || span.ended_at) return span || null;
  span.ended_at = nowIso();
  span.duration_ms = Math.max(0, Date.parse(span.ended_at) - Date.parse(span.started_at));
  span.status = status;
  span.error_code = errorCode;
  return span;
}

function recordStages(traceId, stages) {
  if (!STATE.config || !traceId) return;
  const trace = STATE.traces.get(traceId);
  if (!trace) return;
  for (const key of ['candidate', 'selected', 'accepted', 'injected', 'sent', 'consumed']) {
    if (Number.isFinite(stages[key])) trace.stages[key] = stages[key];
  }
}

function recordTraceCounts(traceId, counts) {
  if (!STATE.config || !traceId) return;
  const trace = STATE.traces.get(traceId);
  if (!trace) return;
  Object.assign(trace.counts, counts);
}

function updateTrace(traceId, mutator) {
  if (!STATE.config || !traceId) return null;
  const trace = STATE.traces.get(traceId);
  if (!trace) return null;
  try {
    mutator(trace);
  } catch (_) {
    /* 监控字段更新失败不影响主业务 */
  }
  return trace;
}

function endTrace(traceId, { status = 'unknown', errorCode = null, errorCategory = null } = {}) {
  if (!STATE.config || !traceId) return null;
  const trace = STATE.traces.get(traceId);
  if (!trace) return null;
  if (trace.ended_at) return trace;
  trace.ended_at = nowIso();
  trace.duration_ms = Math.max(0, Date.parse(trace.ended_at) - Date.parse(trace.started_at));
  trace.status = status;
  trace.error_code = errorCode;
  trace.error_category = errorCategory;
  STATE.traceQueue.push(JSON.parse(JSON.stringify(trace)));
  if (STATE.traceQueue.length > STATE.config.maxTraces) {
    STATE.traceQueue.splice(0, STATE.traceQueue.length - STATE.config.maxTraces);
  }
  scheduleFlush();
  return trace;
}

function getTrace(traceId) {
  if (!STATE.config) return null;
  const trace = STATE.traces.get(String(traceId || ''));
  if (!trace) return null;
  return JSON.parse(JSON.stringify(trace));
}

function listTraces({
  from = 0,
  to = Date.now(),
  status = null,
  errorCategory = null,
  modelId = null,
  toolName = null,
  sessionRef = null,
  cursor = null,
  limit = 50,
} = {}) {
  if (!STATE.config) return { items: [], nextCursor: null, hasMore: false, total: 0 };

  const fromMs = Number.isFinite(from) ? from : 0;
  const toMs = Number.isFinite(to) ? to : Date.now();

  const all = [...STATE.traces.values()]
    .filter(trace => {
      const started = Date.parse(trace.started_at);
      if (!Number.isFinite(started) || started < fromMs || started > toMs) return false;
      if (status && trace.status !== status) return false;
      if (errorCategory && trace.error_category !== errorCategory) return false;
      if (sessionRef && trace.session_ref !== sessionRef) return false;
      if (modelId && !(trace.model.model_ids || []).includes(modelId)) return false;
      if (toolName && !(trace.spans || []).some(span => span.name === `tool.${toolName}`)) {
        return false;
      }
      return true;
    })
    .sort((a, b) => Date.parse(b.started_at) - Date.parse(a.started_at));

  let start = 0;
  if (cursor) {
    const index = all.findIndex(trace => trace.trace_id === cursor);
    if (index < 0) {
      return { items: [], nextCursor: null, hasMore: false, total: all.length, invalidCursor: true };
    }
    start = index + 1;
  }

  const pageSize = Math.max(1, Math.min(200, limit));
  const page = all.slice(start, start + pageSize).map(trace => ({
    trace_id: trace.trace_id,
    name: trace.name,
    started_at: trace.started_at,
    duration_ms: trace.duration_ms,
    status: trace.status,
    error_code: trace.error_code,
    error_category: trace.error_category,
    session_ref: trace.session_ref,
    task: trace.task,
    stages: trace.stages,
    model: {
      rounds: trace.model.rounds,
      calls: trace.model.calls,
      total_tokens: trace.model.total_tokens,
      usage_source: trace.model.usage_source,
      model_ids: trace.model.model_ids,
    },
    tools: trace.tools,
    span_count: trace.spans.length,
    event_count: trace.event_count,
  }));

  const hasMore = start + page.length < all.length;
  return {
    items: page,
    nextCursor: hasMore && page.length ? page[page.length - 1].trace_id : null,
    hasMore,
    total: all.length,
  };
}

function listEvents({
  from = 0,
  to = Date.now(),
  level = null,
  component = null,
  eventName = null,
  status = null,
  errorCode = null,
  traceId = null,
  sessionRef = null,
  cursor = null,
  limit = 50,
} = {}) {
  if (!STATE.config) return { items: [], nextCursor: null, hasMore: false, total: 0 };

  const fromMs = Number.isFinite(from) ? from : 0;
  const toMs = Number.isFinite(to) ? to : Date.now();
  const filtered = STATE.events
    .filter(event => {
      const ts = Date.parse(event.occurred_at);
      if (!Number.isFinite(ts) || ts < fromMs || ts > toMs) return false;
      if (level && event.level !== level) return false;
      if (component && event.component !== component) return false;
      if (eventName && event.event_name !== eventName) return false;
      if (status && event.status !== status) return false;
      if (errorCode && event.error_code !== errorCode) return false;
      if (traceId && event.trace_id !== traceId) return false;
      if (sessionRef && event.session_ref !== sessionRef) return false;
      return true;
    })
    .sort((a, b) => {
      const delta = Date.parse(b.occurred_at) - Date.parse(a.occurred_at);
      if (delta !== 0) return delta;
      return String(b.event_id).localeCompare(String(a.event_id));
    });

  let start = 0;
  if (cursor) {
    const index = filtered.findIndex(event => event.event_id === cursor);
    if (index < 0) {
      return { items: [], nextCursor: null, hasMore: false, total: filtered.length, invalidCursor: true };
    }
    start = index + 1;
  }

  const pageSize = Math.max(1, Math.min(200, limit));
  const page = filtered.slice(start, start + pageSize);
  const hasMore = start + page.length < filtered.length;

  return {
    items: page,
    nextCursor: hasMore && page.length ? page[page.length - 1].event_id : null,
    hasMore,
    total: filtered.length,
  };
}

function recordAudit({
  action,
  target = null,
  result = 'success',
  actorRef = null,
  reason = null,
  sessionRef = null,
} = {}) {
  if (!STATE.config) return null;
  const record = {
    audit_id: `au_${crypto.randomUUID()}`,
    occurred_at: nowIso(),
    action: typeof action === 'string' && /^[a-z][a-z0-9_.]{2,63}$/.test(action)
      ? action
      : 'unknown',
    target: typeof target === 'string' ? maskSensitive(target.slice(0, 80)) : null,
    result: ['success', 'failed', 'denied', 'partial_success'].includes(result)
      ? result
      : 'unknown',
    actor_ref: typeof actorRef === 'string' ? actorRef.slice(0, 40) : null,
    session_ref: typeof sessionRef === 'string' ? sessionRef.slice(0, 40) : null,
    reason: typeof reason === 'string' ? maskSensitive(reason.slice(0, 120)) : null,
  };

  STATE.audit.push(record);
  if (STATE.audit.length > STATE.config.maxAuditEvents) {
    STATE.audit.shift();
    STATE.stats.auditEvicted += 1;
  }
  STATE.auditQueue.push(record);
  if (STATE.auditQueue.length > STATE.config.maxAuditEvents) {
    STATE.auditQueue.shift();
    STATE.stats.auditDropped += 1;
  }
  scheduleFlush();
  return record;
}

function recordAlert(record) {
  if (!STATE.config || !record || typeof record !== 'object') return null;
  const normalized = JSON.parse(JSON.stringify(record));
  STATE.alerts.push(normalized);
  while (STATE.alerts.length > STATE.config.maxAlerts) {
    STATE.alerts.shift();
    STATE.stats.alertEvicted += 1;
  }
  STATE.alertQueue.push(normalized);
  if (STATE.alertQueue.length > STATE.config.maxAlerts) {
    STATE.alertQueue.shift();
    STATE.stats.alertWriteFailures += 1;
  }
  scheduleFlush();
  return normalized;
}

function listAlertRecords({ status = null, severity = null, limit = 50 } = {}) {
  if (!STATE.config) return { items: [], total: 0 };
  const filtered = STATE.alerts
    .filter(record => {
      if (status && record.status !== status) return false;
      if (severity && record.severity !== severity) return false;
      return true;
    })
    .sort((a, b) => Date.parse(b.triggered_at) - Date.parse(a.triggered_at));
  return {
    items: filtered.slice(0, Math.max(1, Math.min(200, limit))),
    total: filtered.length,
  };
}

function listAudit({ from = 0, to = Date.now(), cursor = null, limit = 50 } = {}) {
  if (!STATE.config) return { items: [], nextCursor: null, hasMore: false, total: 0 };
  const filtered = STATE.audit
    .filter(record => {
      const ts = Date.parse(record.occurred_at);
      return Number.isFinite(ts) && ts >= from && ts <= to;
    })
    .sort((a, b) => Date.parse(b.occurred_at) - Date.parse(a.occurred_at));

  let start = 0;
  if (cursor) {
    const index = filtered.findIndex(record => record.audit_id === cursor);
    if (index < 0) {
      return { items: [], nextCursor: null, hasMore: false, total: filtered.length, invalidCursor: true };
    }
    start = index + 1;
  }
  const pageSize = Math.max(1, Math.min(200, limit));
  const page = filtered.slice(start, start + pageSize);
  return {
    items: page,
    nextCursor: start + page.length < filtered.length ? page[page.length - 1].audit_id : null,
    hasMore: start + page.length < filtered.length,
    total: filtered.length,
  };
}

function getStats() {
  if (!STATE.config) {
    return {
      initialized: false,
      events: 0,
      traces: 0,
      audit: 0,
      alerts: 0,
      queue: 0,
      config: null,
    };
  }
  return {
    initialized: true,
    events: STATE.events.length,
    traces: STATE.traces.size,
    audit: STATE.audit.length,
    alerts: STATE.alerts.length,
    queue:
      STATE.queue.length +
      STATE.traceQueue.length +
      STATE.auditQueue.length +
      STATE.alertQueue.length,
    config: {
      max_events: STATE.config.maxEvents,
      max_traces: STATE.config.maxTraces,
      max_spans_per_trace: STATE.config.maxSpansPerTrace,
      max_audit_events: STATE.config.maxAuditEvents,
      max_file_bytes: STATE.config.maxFileBytes,
      max_storage_bytes: STATE.config.maxStorageBytes,
      retention_days: STATE.config.retentionDays,
      alert_window_minutes: STATE.config.alertWindowMinutes,
      alert_min_samples: STATE.config.alertMinSamples,
    },
    stats: { ...STATE.stats, data_dir: STATE.dataDir ? path.basename(STATE.dataDir) : null },
  };
}

function flushNow() {
  flushQueue();
  return Promise.allSettled(STATE.pendingWrites.slice()).then(() => undefined);
}

async function closeStore() {
  STATE.closed = true;
  if (STATE.timers.flush) {
    clearTimeout(STATE.timers.flush);
    STATE.timers.flush = null;
  }
  if (STATE.timers.retention) {
    clearInterval(STATE.timers.retention);
    STATE.timers.retention = null;
  }
  flushQueue();
  await Promise.allSettled(STATE.pendingWrites.slice());
}

function resetStoreForTests() {
  STATE.config = null;
  STATE.dataDir = null;
  STATE.events = [];
  STATE.eventIds = new Set();
  STATE.traces = new Map();
  STATE.audit = [];
  STATE.queue = [];
  STATE.traceQueue = [];
  STATE.auditQueue = [];
  STATE.alertQueue = [];
  STATE.alerts = [];
  STATE.pendingWrites = [];
  STATE.flushing = false;
  STATE.closed = false;
  STATE.files = { events: null, traces: null, audit: null, alerts: null };
  STATE.stats = {
    acceptedEvents: 0,
    invalidEvents: 0,
    duplicateEvents: 0,
    evictedEvents: 0,
    queueDropped: 0,
    writeFailures: 0,
    traceWriteFailures: 0,
    auditWriteFailures: 0,
    alertWriteFailures: 0,
    alertEvicted: 0,
    traceEvicted: 0,
    auditEvicted: 0,
    auditDropped: 0,
    rotations: 0,
    loadedEvents: 0,
    loadedTraces: 0,
    loadSkipped: 0,
    lastWriteAt: null,
    lastError: null,
    currentEventBytes: 0,
    currentTraceBytes: 0,
    currentAuditBytes: 0,
    currentAlertBytes: 0,
    startedAt: null,
  };
  if (STATE.timers.flush) clearTimeout(STATE.timers.flush);
  if (STATE.timers.retention) clearInterval(STATE.timers.retention);
  STATE.timers = { flush: null, retention: null };
}

module.exports = {
  initStore,
  isInitialized,
  appendEvent,
  startTrace,
  addSpan,
  endSpan,
  recordStages,
  recordTraceCounts,
  updateTrace,
  endTrace,
  getTrace,
  listTraces,
  listEvents,
  recordAudit,
  listAudit,
  recordAlert,
  listAlertRecords,
  getStats,
  flushNow,
  closeStore,
  resetStoreForTests,
  resolveDataDir,
  MAX_LOAD_BYTES,
  MAX_LOAD_LINES,
};
