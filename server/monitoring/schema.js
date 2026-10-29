/**
 * 云岫 Bluebird — 统一事件契约（monitoring/schema.js）
 *
 * 目标：日志/指标/Trace/告警/前端详情共享同一套字段与状态枚举。
 * 本文件只做「生成与校验」，不写文件、不计数。
 *
 * 隐私边界（硬约束）：
 * - 事件只接受白名单字段与白名单属性名；用户消息、Prompt、记忆正文、
 *   工具参数/结果、附件内容、密钥永远没有入口；
 * - 需要表达规模时只允许 `*_length` / `*_count` / `*_bytes` / `*_tokens` /
 *   `*_ms` / `*_hash` 这类计量字段；
 * - 文本属性统一截断 + 敏感模式打码，即使上游误传也不会整段落盘。
 */
const { newEventId } = require('./context');

const SCHEMA_VERSION = 1;
const SERVICE_NAME = 'bluebird';

// 标准状态枚举：不同失败语义不得混用（页面第 1 节）。
const STATUSES = Object.freeze([
  'success',
  'partial_success',
  'failed',
  'timeout',
  'cancelled',
  'skipped',
  'disabled',
  'no_result',
  'denied',
  'unknown',
]);

const LEVELS = Object.freeze(['debug', 'info', 'warn', 'error', 'critical']);

const ERROR_CATEGORIES = Object.freeze([
  'provider',
  'tool',
  'context',
  'memory',
  'persistence',
  'sse',
  'permission',
  'schema',
  'internal',
  'unknown',
]);

// 事件名集中声明：拼错在调用点就暴露，也便于文档与测试枚举。
const EVENTS = Object.freeze({
  REQUEST_RECEIVED: 'request.received',
  REQUEST_COMPLETED: 'request.completed',
  SESSION_LOADED: 'session.loaded',
  CONTEXT_BUILD_STARTED: 'context.build.started',
  CONTEXT_BUILD_COMPLETED: 'context.build.completed',
  CONTEXT_BUILD_REJECTED: 'context.build.rejected',
  CONTEXT_SENT: 'context.sent',
  MEMORY_SEARCH_STARTED: 'memory.search.started',
  MEMORY_SEARCH_COMPLETED: 'memory.search.completed',
  MEMORY_WRITE_COMPLETED: 'memory.write.completed',
  MODEL_ROUTE: 'model.route',
  MODEL_REQUEST_STARTED: 'model.request.started',
  MODEL_REQUEST_COMPLETED: 'model.request.completed',
  TOOL_CALL_REQUESTED: 'tool.call.requested',
  TOOL_CALL_COMPLETED: 'tool.call.completed',
  TOOL_RESULT_RETURNED: 'tool.result.returned',
  AGENT_GATE: 'agent.gate',
  AGENT_ROUND_COMPLETED: 'agent.round.completed',
  AGENT_RUN_COMPLETED: 'agent.run.completed',
  RESPONSE_STREAM_STARTED: 'response.stream.started',
  RESPONSE_STREAM_COMPLETED: 'response.stream.completed',
  PERSISTENCE_WRITE_STARTED: 'persistence.write.started',
  PERSISTENCE_WRITE_COMPLETED: 'persistence.write.completed',
  TASK_COMPLETED: 'task.completed',
  DATA_EVENT: 'data.event',
  MONITORING_STARTED: 'monitoring.started',
  MONITORING_STOPPED: 'monitoring.stopped',
});

const EVENT_NAME_RE = /^[a-z][a-z0-9_]*(\.[a-z][a-z0-9_]*){1,3}$/;
const COMPONENT_RE = /^[a-z][a-z0-9_-]{0,39}$/;
const ID_RE = /^[a-z]{2}_[0-9a-f-]{8,64}$/;
const ERROR_CODE_RE = /^[a-z][a-z0-9_]{0,63}$/;

const SENSITIVE_PATTERN =
  /(密码|口令|私钥|助记词|验证码|信用卡|银行卡|身份证|手机号|cvv|api[\s_-]?key|authorization|secret|bearer|token\s*[:=]|sk-[a-zA-Z0-9_-]{8,}|(?<![0-9a-f-])(?:\d[\s-]?){11,}(?![0-9a-f-]))/i;

const SAFE_METRIC_SUFFIX = /(_length|_count|_bytes|_tokens|_ms|_hash|_ref|_id|_ids|_source|_version|_reason|_class|_kind|_type|_name|_name_length|_status|_roles|_round|_rounds|_index|_size|_limit|_rate|_ratio|_percent|_p50|_p95|_p99)$/;

const FORBIDDEN_ATTRIBUTE_RE =
  /(^|_)(prompt|content|message|messages|text|body|args|arguments|params|parameter|result|response|answer|reply|quote|transcript|attachment|image|file|password|secret|token|credential|authorization|api_?key)(_|$)/i;

const ALLOWED_TOP_LEVEL = new Set([
  'schema_version',
  'event_id',
  'event_name',
  'occurred_at',
  'collected_at',
  'service',
  'component',
  'environment',
  'release',
  'git_sha',
  'trace_id',
  'span_id',
  'parent_span_id',
  'session_ref',
  'level',
  'status',
  'duration_ms',
  'error_code',
  'error_category',
  'attributes',
]);

function maskSensitive(text) {
  if (typeof text !== 'string' || !text) return text;
  return SENSITIVE_PATTERN.test(text) ? '[REDACTED]' : text;
}

function truncate(value, max) {
  const text = typeof value === 'string' ? value : String(value);
  return text.length <= max ? text : `${text.slice(0, max)}…`;
}

function safeString(value, max = 120) {
  if (typeof value !== 'string' || !value) return null;
  return maskSensitive(truncate(value, max));
}

function safeId(value) {
  if (typeof value !== 'string') return null;
  return ID_RE.test(value) ? value : null;
}

function safeTimestamp(value, fallback) {
  if (typeof value === 'string' && Number.isFinite(Date.parse(value))) {
    return new Date(value).toISOString();
  }
  return fallback;
}

function releaseInfo() {
  // 不读取 git 命令；版本取环境变量（部署时可注入），否则 unknown。
  const release = safeString(process.env.BLUEBIRD_RELEASE, 64);
  const gitSha = safeString(process.env.BLUEBIRD_GIT_SHA, 40);
  return {
    release: release || null,
    git_sha: /^[0-9a-f]{7,40}$/i.test(gitSha || '') ? gitSha : null,
  };
}

function sanitizeAttributes(input) {
  const source = input && typeof input === 'object' && !Array.isArray(input) ? input : {};
  const output = {};
  let dropped = 0;
  let keys = 0;

  for (const [rawKey, rawValue] of Object.entries(source)) {
    keys += 1;
    if (keys > 32) {
      dropped += 1;
      continue;
    }

    const key = String(rawKey);

    if (!/^[a-z][a-z0-9_]{0,39}$/.test(key)) {
      dropped += 1;
      continue;
    }

    const permittedMetric =
      key.includes('_') && SAFE_METRIC_SUFFIX.test(key);

    if (FORBIDDEN_ATTRIBUTE_RE.test(key) && !permittedMetric) {
      dropped += 1;
      continue;
    }

    if (rawValue === null) {
      output[key] = null;
      continue;
    }

    if (typeof rawValue === 'boolean') {
      output[key] = rawValue;
      continue;
    }

    if (typeof rawValue === 'number') {
      output[key] = Number.isFinite(rawValue) ? rawValue : null;
      if (!Number.isFinite(rawValue)) dropped += 1;
      continue;
    }

    if (typeof rawValue === 'string') {
      output[key] = safeString(rawValue, 160);
      continue;
    }

    // 数组只接受短小的标量列表（例如 roles），其余一律丢弃。
    if (Array.isArray(rawValue)) {
      const scalars = rawValue
        .slice(0, 16)
        .filter(
          item =>
            typeof item === 'string' ||
            typeof item === 'number' ||
            typeof item === 'boolean'
        );
      if (scalars.length !== rawValue.length || scalars.length > 16) {
        dropped += 1;
      }
      output[key] = scalars.map(item =>
        typeof item === 'string' ? safeString(item, 60) : item
      );
      continue;
    }

    dropped += 1;
  }

  if (dropped > 0) output.attributes_dropped = dropped;
  return output;
}

/**
 * 生成一条规范事件。任何非法输入都不会抛错：
 * - 缺 event_name / component 返回 { ok:false }（调用方决定是否丢弃并计数）；
 * - 未知字段被丢弃，敏感属性被剔除；
 * - 时间统一 UTC ISO，同时记录 collected_at 以识别延迟上报。
 */
function normalizeEvent(input, { now = Date.now() } = {}) {
  const source = input && typeof input === 'object' ? input : {};
  const collectedAt = new Date(now).toISOString();
  const occurredAt = safeTimestamp(source.occurred_at, collectedAt);
  const eventName = typeof source.event_name === 'string' ? source.event_name : '';
  const component = typeof source.component === 'string' ? source.component : '';

  const errors = [];

  if (!EVENT_NAME_RE.test(eventName)) errors.push('invalid_event_name');
  if (!COMPONENT_RE.test(component)) errors.push('invalid_component');

  const status = STATUSES.includes(source.status) ? source.status : 'unknown';
  const level = LEVELS.includes(source.level)
    ? source.level
    : status === 'failed' || status === 'timeout'
      ? 'error'
      : 'info';

  const errorCategory = ERROR_CATEGORIES.includes(source.error_category)
    ? source.error_category
    : null;

  const duration =
    Number.isFinite(source.duration_ms) && source.duration_ms >= 0
      ? Math.round(source.duration_ms * 1000) / 1000
      : null;

  const errorCode =
    typeof source.error_code === 'string' && ERROR_CODE_RE.test(source.error_code)
      ? source.error_code
      : null;

  const release = releaseInfo();

  const event = {
    schema_version: SCHEMA_VERSION,
    event_id:
      typeof source.event_id === 'string' && ID_RE.test(source.event_id)
        ? source.event_id
        : newEventId(),
    event_name: eventName,
    occurred_at: occurredAt,
    collected_at: collectedAt,
    service: SERVICE_NAME,
    component,
    environment: safeString(process.env.NODE_ENV, 32) || 'unknown',
    release: release.release,
    git_sha: release.git_sha,
    trace_id: safeId(source.trace_id),
    span_id: safeId(source.span_id),
    parent_span_id: safeId(source.parent_span_id),
    session_ref: safeString(source.session_ref, 40),
    level,
    status,
    duration_ms: duration,
    error_code: errorCode,
    error_category: errorCategory,
    attributes: sanitizeAttributes(source.attributes),
  };

  const skewMs = Math.abs(Date.parse(occurredAt) - Date.parse(collectedAt));
  if (Number.isFinite(skewMs) && skewMs > 5000) {
    event.attributes.clock_skew_ms = skewMs;
  }

  if (errors.length) {
    return { ok: false, errors, event };
  }

  return { ok: true, errors: [], event };
}

function assertNoForbiddenFields(event) {
  // 测试辅助：事件序列化后不得包含正文/密钥类字段。
  const json = JSON.stringify(event);
  if (SENSITIVE_PATTERN.test(json)) return false;
  return Object.keys(event).every(key => ALLOWED_TOP_LEVEL.has(key));
}

module.exports = {
  SCHEMA_VERSION,
  SERVICE_NAME,
  STATUSES,
  LEVELS,
  ERROR_CATEGORIES,
  EVENTS,
  normalizeEvent,
  sanitizeAttributes,
  maskSensitive,
  safeString,
  safeId,
  assertNoForbiddenFields,
  ID_RE,
};
