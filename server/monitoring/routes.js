/**
 * 云岫 Bluebird — 只读监控 API（monitoring/routes.js）
 *
 * - 所有接口只读：不存在清理、改配置、执行工具或删除数据的入口；
 * - 时间范围、分页、指标名、枚举过滤全部有硬边界，非法参数返回 400；
 * - 复用现有 requireAuth（Bearer token），不新增默认公开接口；
 * - 响应带 generated_at / range / coverage / data_status，空数据必须有语义，
 *   不能返回看似正常的 0。
 */
const express = require('express');
const monitoring = require('./index');
const { STATUSES, LEVELS } = require('./schema');
const { SEVERITIES } = require('./alerts');
const { ID_RE } = require('./schema');

const QUERY_STATS = {
  calls: 0,
  errors: 0,
  by_route: {},
  last_query_at: null,
};

function normalizedRoute(route) {
  return String(route || 'unknown')
    .replace(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/gi, ':id')
    .replace(/\/\d+/g, '/:id')
    .slice(0, 80);
}

function track(route, durationMs, failed) {
  QUERY_STATS.calls += 1;
  if (failed) QUERY_STATS.errors += 1;
  const key = normalizedRoute(route);
  // 查询层自身健康也要防高基数：路由键最多保留 20 个。
  if (!QUERY_STATS.by_route[key] && Object.keys(QUERY_STATS.by_route).length >= 20) {
    QUERY_STATS.by_route.other = QUERY_STATS.by_route.other || {
      calls: 0,
      errors: 0,
      last_duration_ms: null,
    };
    const other = QUERY_STATS.by_route.other;
    other.calls += 1;
    if (failed) other.errors += 1;
    other.last_duration_ms = durationMs;
  } else {
    const entry = QUERY_STATS.by_route[key] || {
      calls: 0,
      errors: 0,
      last_duration_ms: null,
    };
    entry.calls += 1;
    if (failed) entry.errors += 1;
    entry.last_duration_ms = durationMs;
    QUERY_STATS.by_route[key] = entry;
  }
  QUERY_STATS.last_query_at = new Date().toISOString();
}

function getQueryHealth() {
  return {
    source: 'monitoring_query_layer',
    ...QUERY_STATS,
    readonly: true,
  };
}

function badRequest(res, code, message) {
  return res.status(400).json({ error: message, code });
}

function parseRange(req, config) {
  const now = Date.now();
  const defaultHours = 1;
  const rawTo = req.query.to;
  const rawFrom = req.query.from;

  const to = rawTo === undefined ? now : Date.parse(String(rawTo));
  const from =
    rawFrom === undefined ? to - defaultHours * 60 * 60 * 1000 : Date.parse(String(rawFrom));

  if (!Number.isFinite(to) || !Number.isFinite(from)) {
    return { error: ['invalid_range', 'from/to 必须是 ISO 时间或毫秒时间戳'] };
  }
  if (from > to) {
    return { error: ['invalid_range', 'from 不能晚于 to'] };
  }

  const maxMs = config.maxQueryRangeHours * 60 * 60 * 1000;
  if (to - from > maxMs) {
    return {
      error: [
        'range_too_large',
        `查询范围不能超过 ${config.maxQueryRangeHours} 小时（当前 ${Math.round((to - from) / 3600000)} 小时）`,
      ],
    };
  }

  return { from, to };
}

function parseLimit(req, config) {
  if (req.query.limit === undefined) return { limit: config.defaultQueryLimit };
  const value = Number(req.query.limit);
  if (!Number.isInteger(value) || value < 1) {
    return { error: ['invalid_limit', 'limit 必须是正整数'] };
  }
  return { limit: Math.min(value, config.maxQueryLimit) };
}

function parseCursor(req) {
  if (req.query.cursor === undefined) return { cursor: null };
  const value = String(req.query.cursor);
  if (!value || value.length > 120) {
    return { error: ['invalid_cursor', 'cursor 非法'] };
  }
  return { cursor: value };
}

function parseEnum(req, name, allowed) {
  if (req.query[name] === undefined) return { value: null };
  const value = String(req.query[name]);
  if (!allowed.includes(value)) {
    return { error: [`invalid_${name}`, `${name} 取值非法`] };
  }
  return { value };
}

function parseTextFilter(req, name) {
  if (req.query[name] === undefined) return { value: null };
  const value = String(req.query[name]);
  if (!/^[a-zA-Z0-9_.:/\-]{1,80}$/.test(value)) {
    return { error: [`invalid_${name}`, `${name} 取值非法`] };
  }
  return { value };
}

function createMonitoringRouter({ requireAuth } = {}) {
  const router = express.Router();

  if (typeof requireAuth === 'function') {
    router.use(requireAuth);
  }

  router.use((req, res, next) => {
    res.set('Cache-Control', 'no-store');
    next();
  });

  const wrap = handler => (req, res) => {
    const started = Date.now();
    let failed = false;
    try {
      const result = handler(req, res);
      if (res.statusCode >= 400) failed = true;
      return result;
    } catch (error) {
      failed = true;
      console.error('[monitoring] query failed:', error && error.message);
      return res.status(500).json({ error: '监控查询失败', code: 'monitoring_query_failed' });
    } finally {
      track(req.route && req.route.path ? req.route.path : req.path, Date.now() - started, failed);
    }
  };

  router.get(
    '/meta',
    wrap((req, res) => {
      res.json({ ...monitoring.getMeta(), query_layer: getQueryHealth() });
    })
  );

  router.get(
    '/overview',
    wrap((req, res) => {
      const config = monitoring.getConfig();
      if (!config) return res.json(monitoring.buildOverview({ from: 0, to: 0 }));

      const range = parseRange(req, config);
      if (range.error) return badRequest(res, range.error[0], range.error[1]);
      return res.json(monitoring.buildOverview(range));
    })
  );

  router.get(
    '/metrics',
    wrap((req, res) => {
      const config = monitoring.getConfig();
      if (!config) return res.json(monitoring.queryMetrics({ from: 0, to: 0 }));

      const range = parseRange(req, config);
      if (range.error) return badRequest(res, range.error[0], range.error[1]);

      let names = null;
      if (req.query.names !== undefined) {
        names = String(req.query.names)
          .split(',')
          .map(item => item.trim())
          .filter(Boolean);
        if (names.length > 12) {
          return badRequest(res, 'invalid_names', 'names 一次最多 12 个');
        }
        if (names.some(name => !/^[a-z][a-z0-9_]{0,63}$/.test(name))) {
          return badRequest(res, 'invalid_names', 'names 含非法指标名');
        }
      }

      const durationHours = (range.to - range.from) / 3600000;
      const intervalMinutes =
        durationHours <= 1 ? 1 : durationHours <= 6 ? 5 : durationHours <= 24 ? 15 : 60;

      const result = monitoring.queryMetrics({
        names,
        from: range.from,
        to: range.to,
        intervalMinutes,
      });

      if (!result.ok && result.reason === 'unknown_metric') {
        return badRequest(res, 'unknown_metric', `未知指标：${result.unknown.join(', ')}`);
      }

      return res.json(result);
    })
  );

  router.get(
    '/traces',
    wrap((req, res) => {
      const config = monitoring.getConfig();
      if (!config) return res.json(monitoring.getTraces({}));

      const range = parseRange(req, config);
      if (range.error) return badRequest(res, range.error[0], range.error[1]);
      const limit = parseLimit(req, config);
      if (limit.error) return badRequest(res, limit.error[0], limit.error[1]);
      const cursor = parseCursor(req);
      if (cursor.error) return badRequest(res, cursor.error[0], cursor.error[1]);
      const status = parseEnum(req, 'status', STATUSES);
      if (status.error) return badRequest(res, status.error[0], status.error[1]);
      const errorCategory = parseTextFilter(req, 'error_category');
      if (errorCategory.error) return badRequest(res, errorCategory.error[0], errorCategory.error[1]);
      const modelId = parseTextFilter(req, 'model_id');
      if (modelId.error) return badRequest(res, modelId.error[0], modelId.error[1]);
      const toolName = parseTextFilter(req, 'tool');
      if (toolName.error) return badRequest(res, toolName.error[0], toolName.error[1]);
      const sessionRef = parseTextFilter(req, 'session_ref');
      if (sessionRef.error) return badRequest(res, sessionRef.error[0], sessionRef.error[1]);

      return res.json(
        monitoring.getTraces({
          from: range.from,
          to: range.to,
          limit: limit.limit,
          cursor: cursor.cursor,
          status: status.value,
          errorCategory: errorCategory.value,
          modelId: modelId.value,
          toolName: toolName.value,
          sessionRef: sessionRef.value,
        })
      );
    })
  );

  router.get(
    '/traces/:traceId',
    wrap((req, res) => {
      if (!ID_RE.test(req.params.traceId)) {
        return badRequest(res, 'invalid_trace_id', 'traceId 格式非法');
      }
      const result = monitoring.getTraceDetail(req.params.traceId);
      if (!result.ok && result.reason === 'not_found') {
        return res.status(404).json({ error: 'Trace 不存在或已超出保留期', code: 'not_found' });
      }
      return res.json(result);
    })
  );

  router.get(
    '/events',
    wrap((req, res) => {
      const config = monitoring.getConfig();
      if (!config) return res.json(monitoring.getEvents({}));

      const range = parseRange(req, config);
      if (range.error) return badRequest(res, range.error[0], range.error[1]);
      const limit = parseLimit(req, config);
      if (limit.error) return badRequest(res, limit.error[0], limit.error[1]);
      const cursor = parseCursor(req);
      if (cursor.error) return badRequest(res, cursor.error[0], cursor.error[1]);
      const status = parseEnum(req, 'status', STATUSES);
      if (status.error) return badRequest(res, status.error[0], status.error[1]);
      const level = parseEnum(req, 'level', LEVELS);
      if (level.error) return badRequest(res, level.error[0], level.error[1]);
      const component = parseTextFilter(req, 'component');
      if (component.error) return badRequest(res, component.error[0], component.error[1]);
      const eventName = parseTextFilter(req, 'event_name');
      if (eventName.error) return badRequest(res, eventName.error[0], eventName.error[1]);
      const errorCode = parseTextFilter(req, 'error_code');
      if (errorCode.error) return badRequest(res, errorCode.error[0], errorCode.error[1]);
      const traceId = parseTextFilter(req, 'trace_id');
      if (traceId.error) return badRequest(res, traceId.error[0], traceId.error[1]);
      const sessionRef = parseTextFilter(req, 'session_ref');
      if (sessionRef.error) return badRequest(res, sessionRef.error[0], sessionRef.error[1]);

      return res.json(
        monitoring.getEvents({
          from: range.from,
          to: range.to,
          limit: limit.limit,
          cursor: cursor.cursor,
          status: status.value,
          level: level.value,
          component: component.value,
          eventName: eventName.value,
          errorCode: errorCode.value,
          traceId: traceId.value,
          sessionRef: sessionRef.value,
        })
      );
    })
  );

  router.get(
    '/audit',
    wrap((req, res) => {
      const config = monitoring.getConfig();
      if (!config) return res.json(monitoring.getAuditEvents({}));

      const range = parseRange(req, config);
      if (range.error) return badRequest(res, range.error[0], range.error[1]);
      const limit = parseLimit(req, config);
      if (limit.error) return badRequest(res, limit.error[0], limit.error[1]);
      const cursor = parseCursor(req);
      if (cursor.error) return badRequest(res, cursor.error[0], cursor.error[1]);

      return res.json(
        monitoring.getAuditEvents({
          from: range.from,
          to: range.to,
          limit: limit.limit,
          cursor: cursor.cursor,
        })
      );
    })
  );

  router.get(
    '/tools',
    wrap((req, res) => {
      const config = monitoring.getConfig();
      if (!config) return res.json(monitoring.getToolsSummary({ from: 0, to: 0 }));
      const range = parseRange(req, config);
      if (range.error) return badRequest(res, range.error[0], range.error[1]);
      return res.json(monitoring.getToolsSummary(range));
    })
  );

  router.get(
    '/models',
    wrap((req, res) => {
      const config = monitoring.getConfig();
      if (!config) return res.json(monitoring.getModelsSummary({ from: 0, to: 0 }));
      const range = parseRange(req, config);
      if (range.error) return badRequest(res, range.error[0], range.error[1]);
      return res.json(monitoring.getModelsSummary(range));
    })
  );

  router.get(
    '/alerts',
    wrap((req, res) => {
      const config = monitoring.getConfig();
      if (!config) return res.json(monitoring.getAlertsSummary({}));
      const limit = parseLimit(req, config);
      if (limit.error) return badRequest(res, limit.error[0], limit.error[1]);
      const status = parseEnum(req, 'status', ['firing', 'resolved']);
      if (status.error) return badRequest(res, status.error[0], status.error[1]);
      const severity = parseEnum(req, 'severity', SEVERITIES);
      if (severity.error) return badRequest(res, severity.error[0], severity.error[1]);
      return res.json(
        monitoring.getAlertsSummary({
          status: status.value,
          severity: severity.value,
          limit: limit.limit,
        })
      );
    })
  );

  router.get(
    '/health',
    wrap((req, res) => {
      const health = monitoring.getHealth();
      res.json({ ...health, query_layer: getQueryHealth() });
    })
  );

  // 只读 API：显式拒绝任何写方法，避免未来误加副作用接口。
  router.use((req, res) => {
    if (req.method !== 'GET' && req.method !== 'HEAD') {
      return res.status(405).json({ error: '监控接口只读', code: 'method_not_allowed' });
    }
    return res.status(404).json({ error: '监控接口不存在', code: 'not_found' });
  });

  return router;
}

module.exports = { createMonitoringRouter, getQueryHealth, QUERY_STATS };
