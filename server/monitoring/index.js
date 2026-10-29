/**
 * 云岫 Bluebird — 监控门面（monitoring/index.js）
 *
 * 对外只暴露「记录 / 查询」两类能力：
 * - 记录接口全部 try/catch 包裹，监控异常绝不影响聊天、Agent、记忆或工具；
 * - 查询接口只读，不提供清理、改配置、执行工具等副作用操作；
 * - 未初始化/关闭时记录接口是 no-op，查询明确返回 disabled，而不是假数据。
 */
const { loadConfig } = require('./config');
const context = require('./context');
const schema = require('./schema');
const metrics = require('./metrics');
const store = require('./store');
const alerts = require('./alerts');
const health = require('./health');

const { EVENTS } = schema;

let ACTIVE = false;
let CONFIG = null;
let INIT_ERROR = null;
let STARTED_AT = null;
let INTERNAL_ERRORS = 0;

function nowIso() {
  return new Date().toISOString();
}

function initMonitoring({ dataDir = null, config = null } = {}) {
  if (ACTIVE) return { enabled: true, already: true, data_dir: store.getStats().stats.data_dir };
  if (INIT_ERROR) return { enabled: false, error: INIT_ERROR };

  CONFIG = config || loadConfig();

  if (!CONFIG.enabled) {
    return { enabled: false, reason: 'BLUEBIRD_MONITORING=0' };
  }

  try {
    const result = store.initStore({ config: CONFIG, dataDir });
    metrics.setRetentionMinutes(CONFIG.metricRetentionMinutes);
    alerts.initAlerts(CONFIG);
    ACTIVE = true;
    STARTED_AT = nowIso();
    recordEvent({
      event_name: EVENTS.MONITORING_STARTED,
      component: 'monitoring',
      status: 'success',
      attributes: {
        loaded_events: result.loadedEvents,
        loaded_traces: result.loadedTraces,
        load_skipped: result.loadSkipped,
      },
    });
    return { enabled: true, ...result };
  } catch (error) {
    INIT_ERROR = error && error.code ? error.code : 'init_failed';
    ACTIVE = false;
    console.error(`[monitoring] 初始化失败：${INIT_ERROR}（主业务继续运行）`);
    return { enabled: false, error: INIT_ERROR };
  }
}

function isActive() {
  return ACTIVE;
}

function getConfig() {
  return CONFIG;
}

async function shutdownMonitoring() {
  if (!ACTIVE) return;
  try {
    recordEvent({
      event_name: EVENTS.MONITORING_STOPPED,
      component: 'monitoring',
      status: 'success',
    });
    alerts.stopAlerts();
    await store.closeStore();
  } catch (_) {
    /* 关闭失败不影响进程退出 */
  } finally {
    ACTIVE = false;
  }
}

function recordEvent(input) {
  if (!ACTIVE) return false;
  try {
    const traceId = context.currentTraceId();
    const spanId = context.currentSpanId();
    const als = context.currentStore();
    const result = store.appendEvent({
      ...input,
      trace_id: input && input.trace_id ? input.trace_id : traceId,
      span_id: input && input.span_id ? input.span_id : spanId,
      session_ref:
        input && input.session_ref
          ? input.session_ref
          : als && als.sessionRef
            ? als.sessionRef
            : null,
    });

    metrics.increment('monitoring_events_total', {
      outcome: result.ok ? 'accepted' : 'invalid',
    });

    return result.ok;
  } catch (_) {
    INTERNAL_ERRORS += 1;
    try {
      metrics.increment('monitoring_events_total', { outcome: 'error' });
    } catch (_ignored) {
      /* 指标失败也不能外抛 */
    }
    return false;
  }
}

function recordAudit(input) {
  if (!ACTIVE) return null;
  try {
    return store.recordAudit(input);
  } catch (_) {
    INTERNAL_ERRORS += 1;
    return null;
  }
}

function startSpan(name, attributes = {}) {
  if (!ACTIVE) {
    return {
      active: false,
      spanId: null,
      traceId: null,
      end() {
        /* no-op */
      },
    };
  }

  try {
    const traceId = context.currentTraceId();
    if (!traceId) {
      return { active: false, spanId: null, traceId: null, end() {} };
    }
    const spanId = context.newSpanId();
    const span = store.addSpan(traceId, {
      span_id: spanId,
      parent_span_id: context.currentSpanId(),
      name,
      started_at: nowIso(),
      attributes: schema.sanitizeAttributes(attributes),
    });

    if (!span) {
      return { active: false, spanId: null, traceId, end() {} };
    }

    context.pushSpan(spanId);

    return {
      active: true,
      spanId,
      traceId,
      end({ status = 'success', errorCode = null } = {}) {
        try {
          store.endSpan(traceId, spanId, { status, errorCode });
          context.popSpan(spanId);
        } catch (_) {
          INTERNAL_ERRORS += 1;
        }
      },
    };
  } catch (_) {
    INTERNAL_ERRORS += 1;
    return { active: false, spanId: null, traceId: null, end() {} };
  }
}

function runRouteName(req) {
  // 未命中任何路由时固定为 unmatched：不让任意 404 路径进入指标标签。
  const path = req.route && req.route.path ? req.route.path : null;
  const base = req.baseUrl || '';
  const raw = path ? `${base}${path}` : 'unmatched';
  return raw
    .replace(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/gi, ':id')
    .replace(/\/\d+/g, '/:id')
    .slice(0, 80);
}

function statusForHttp(statusCode) {
  if (statusCode === 401 || statusCode === 403) return 'denied';
  if (statusCode >= 500) return 'failed';
  if (statusCode >= 400) return 'failed';
  return 'success';
}

function statusClass(statusCode) {
  if (statusCode >= 100 && statusCode < 200) return '1xx';
  if (statusCode < 300) return '2xx';
  if (statusCode < 400) return '3xx';
  if (statusCode < 500) return '4xx';
  return '5xx';
}

function httpErrorCategory(statusCode) {
  if (statusCode === 401 || statusCode === 403) return 'permission';
  if (statusCode >= 500) return 'internal';
  if (statusCode >= 400) return 'schema';
  return null;
}

/**
 * Express 中间件：为每个请求建立 trace/root span，记录入站与终态。
 * /monitoring 自身不进入事件/HTTP 指标，避免自查询噪声；其健康在 /monitoring/health。
 */
function monitoringMiddleware() {
  return function monitor(req, res, next) {
    if (!ACTIVE) return next();
    if (req.method === 'OPTIONS' || (req.path || '').startsWith('/monitoring')) {
      return next();
    }

    try {
      const startedAtMs = Date.now();
      const sessionRef = context.sessionRefFor(
        (req.body && req.body.sessionId) ||
          (req.query && req.query.sessionId) ||
          null
      );
      const route = runRouteName(req);
      const trace = store.startTrace({
        name: 'http.request',
        sessionRef,
        attributes: { method: req.method, route },
      });

      if (!trace) return next();

      const rootSpanId = context.newSpanId();
      store.addSpan(trace.trace_id, {
        span_id: rootSpanId,
        parent_span_id: null,
        name: 'request',
        started_at: nowIso(),
        attributes: { method: req.method, route },
      });

      const alsStore = {
        traceId: trace.trace_id,
        spanStack: [rootSpanId],
        sessionRef,
        startedAt: startedAtMs,
      };

      recordEvent({
        event_name: EVENTS.REQUEST_RECEIVED,
        component: 'http',
        status: 'success',
        trace_id: trace.trace_id,
        span_id: rootSpanId,
        attributes: { method: req.method, route },
      });

      let finalized = false;

      const finalize = kind => {
        if (finalized) return;
        finalized = true;

        try {
          const durationMs = Date.now() - startedAtMs;
          const statusCode = res.statusCode || 0;
          const httpStatus =
            kind === 'close' ? 'cancelled' : statusForHttp(statusCode);
          const cls = statusClass(statusCode);
          const finalRoute = runRouteName(req);

          const current = store.getTrace(trace.trace_id);
          const taskStatus =
            current && current.task && current.task.status !== 'unknown'
              ? current.task.status
              : httpStatus;

          metrics.increment('http_requests_total', {
            method: req.method,
            route: finalRoute,
            status_class: cls,
          });
          metrics.observe('http_request_duration_ms', { route: finalRoute }, durationMs);

          recordEvent({
            event_name: EVENTS.REQUEST_COMPLETED,
            component: 'http',
            status: httpStatus,
            duration_ms: durationMs,
            trace_id: trace.trace_id,
            span_id: rootSpanId,
            error_code: statusCode >= 400 ? `http_${statusCode}` : null,
            error_category: httpErrorCategory(statusCode),
            attributes: {
              method: req.method,
              route: finalRoute,
              status_class: cls,
              status_code: statusCode,
            },
          });

          store.endSpan(trace.trace_id, rootSpanId, {
            status: httpStatus,
            errorCode: statusCode >= 400 ? `http_${statusCode}` : null,
          });
          store.endTrace(trace.trace_id, {
            status: taskStatus,
            errorCode:
              statusCode >= 400
                ? `http_${statusCode}`
                : current && current.task
                  ? current.task.error_code
                  : null,
            errorCategory: httpErrorCategory(statusCode),
          });
        } catch (_) {
          INTERNAL_ERRORS += 1;
        }
      };

      res.on('finish', () => finalize('finish'));
      res.on('close', () => {
        if (!res.writableEnded) finalize('close');
      });

      context.runWithTrace(alsStore, () => {
        try {
          next();
        } catch (error) {
          finalize('close');
          throw error;
        }
      });
    } catch (_) {
      INTERNAL_ERRORS += 1;
      next();
    }
  };
}

// ---- 领域埋点 ----

function beginModelCall({ providerId, modelId, kind = 'chat', round = 1, toolsCount = 0, stream = false }) {
  if (!ACTIVE) return { active: false, complete() {}, fail() {} };

  const span = startSpan('model.request', {
    provider_id: providerId,
    model_id: modelId,
    kind,
    round,
    tools_count: toolsCount,
    stream,
  });

  recordEvent({
    event_name: EVENTS.MODEL_REQUEST_STARTED,
    component: 'model',
    status: 'unknown',
    attributes: {
      provider_id: providerId,
      model_id: modelId,
      kind,
      round,
      tools_count: toolsCount,
      stream,
    },
  });

  let settled = false;

  const finish = ({ status, durationMs, usage = null, errorCode = null, errorCategory = null }) => {
    if (settled) return;
    settled = true;

    const usageSource =
      usage &&
      (Number.isFinite(usage.prompt_tokens) ||
        Number.isFinite(usage.completion_tokens) ||
        Number.isFinite(usage.total_tokens))
        ? 'provider'
        : 'missing';

    const promptTokens = Number.isFinite(usage && usage.prompt_tokens)
      ? usage.prompt_tokens
      : null;
    const completionTokens = Number.isFinite(usage && usage.completion_tokens)
      ? usage.completion_tokens
      : null;
    const totalTokens = Number.isFinite(usage && usage.total_tokens)
      ? usage.total_tokens
      : Number.isFinite(promptTokens) && Number.isFinite(completionTokens)
        ? promptTokens + completionTokens
        : null;
    const cachedTokens = Number.isFinite(usage && usage.prompt_cache_hit_tokens)
      ? usage.prompt_cache_hit_tokens
      : Number.isFinite(
            usage &&
              usage.prompt_tokens_details &&
              usage.prompt_tokens_details.cached_tokens
          )
        ? usage.prompt_tokens_details.cached_tokens
        : null;

    try {
      metrics.increment('model_requests_total', {
        provider_id: providerId,
        model_id: modelId,
        status,
        kind,
      });
      metrics.observe(
        'model_request_duration_ms',
        { provider_id: providerId, model_id: modelId },
        durationMs
      );
      if (promptTokens !== null) {
        metrics.increment(
          'model_tokens_total',
          {
            provider_id: providerId,
            model_id: modelId,
            token_kind: 'input',
            usage_source: usageSource,
          },
          promptTokens
        );
      }
      if (completionTokens !== null) {
        metrics.increment(
          'model_tokens_total',
          {
            provider_id: providerId,
            model_id: modelId,
            token_kind: 'output',
            usage_source: usageSource,
          },
          completionTokens
        );
      }
      if (promptTokens === null && completionTokens === null) {
        metrics.increment(
          'model_tokens_total',
          {
            provider_id: providerId,
            model_id: modelId,
            token_kind: 'unknown',
            usage_source: usageSource,
          },
          1
        );
      }
      if (cachedTokens !== null) {
        metrics.increment('model_cached_tokens_total', {
          provider_id: providerId,
          model_id: modelId,
        }, cachedTokens);
      }

      const traceId = context.currentTraceId();
      if (traceId) {
        store.updateTrace(traceId, trace => {
          trace.model.calls += 1;
          trace.model.rounds = Math.max(trace.model.rounds, round);
          if (!trace.model.provider_ids.includes(providerId)) {
            trace.model.provider_ids.push(providerId);
          }
          if (!trace.model.model_ids.includes(modelId)) {
            trace.model.model_ids.push(modelId);
          }
          if (totalTokens !== null) {
            trace.model.input_tokens = (trace.model.input_tokens || 0) + (promptTokens || 0);
            trace.model.output_tokens =
              (trace.model.output_tokens || 0) + (completionTokens || 0);
            trace.model.total_tokens = (trace.model.total_tokens || 0) + totalTokens;
            trace.model.usage_source = 'provider';
          }
          if (cachedTokens !== null) {
            trace.model.cached_tokens =
              (trace.model.cached_tokens || 0) + cachedTokens;
          }
        });
      }

      recordEvent({
        event_name: EVENTS.MODEL_REQUEST_COMPLETED,
        component: 'model',
        status,
        duration_ms: durationMs,
        error_code: errorCode,
        error_category: errorCategory,
        attributes: {
          provider_id: providerId,
          model_id: modelId,
          kind,
          round,
          input_tokens: promptTokens,
          output_tokens: completionTokens,
          total_tokens: totalTokens,
          cached_tokens: cachedTokens,
          usage_source: usageSource,
        },
      });

      span.end({ status, errorCode });
    } catch (_) {
      INTERNAL_ERRORS += 1;
    }
  };

  return {
    active: true,
    span,
    complete({ status = 'success', durationMs = 0, usage = null } = {}) {
      finish({ status, durationMs, usage });
    },
    fail({ status = 'failed', durationMs = 0, errorCode = null, errorCategory = 'provider' } = {}) {
      finish({ status, durationMs, errorCode, errorCategory });
    },
  };
}

function beginToolCall({ toolName, round = 1, readOnly = null, registered = true }) {
  if (!ACTIVE) return { active: false, complete() {} };

  // 指标标签只允许已注册工具名；模型编造的名字归入 unknown_tool，
  // 防止高基数标签无限扩张（trace 里仍保留真实 span 名，受 trace 上限约束）。
  const metricToolName = registered ? toolName : 'unknown_tool';
  const span = startSpan(`tool.${toolName}`, { tool_name: toolName, round, read_only: readOnly });

  recordEvent({
    event_name: EVENTS.TOOL_CALL_REQUESTED,
    component: 'tool',
    status: 'unknown',
    attributes: { tool_name: toolName, round, read_only: readOnly },
  });

  let settled = false;

  return {
    active: true,
    complete({
      ok = false,
      code = null,
      durationMs = 0,
      deduped = false,
      executed = true,
      resultBytes = null,
      truncated = false,
    } = {}) {
      if (settled) return;
      settled = true;

      const status =
        ok === true
          ? 'success'
          : code === 'tool_timeout'
            ? 'timeout'
            : code === 'unauthorized_write'
              ? 'denied'
              : 'failed';
      const errorCategory = ok ? null : 'tool';

      try {
        metrics.increment('tool_calls_total', { tool_name: metricToolName, status });
        metrics.observe('tool_call_duration_ms', { tool_name: metricToolName }, durationMs);
        if (deduped) {
          metrics.increment('tool_deduped_total', { tool_name: metricToolName });
        }

        const traceId = context.currentTraceId();
        if (traceId) {
          store.updateTrace(traceId, trace => {
            trace.tools.requested += 1;
            if (executed) trace.tools.executed += 1;
            if (deduped) trace.tools.deduped += 1;
            if (ok) trace.tools.succeeded += 1;
            else trace.tools.failed += 1;
            trace.tools.duration_ms += Math.max(0, Number(durationMs) || 0);
          });
        }

        recordEvent({
          event_name: EVENTS.TOOL_CALL_COMPLETED,
          component: 'tool',
          status,
          duration_ms: durationMs,
          error_code: code || null,
          error_category: errorCategory,
          attributes: {
            tool_name: toolName,
            round,
            ok: ok === true,
            deduped: deduped === true,
            executed: executed === true,
            result_bytes: resultBytes,
            result_truncated: truncated === true,
          },
        });

        span.end({ status, errorCode: code || null });
      } catch (_) {
        INTERNAL_ERRORS += 1;
      }
    },
  };
}

function recordModelRoute({ requested = {}, actual = {}, auto = false, reason = null } = {}) {
  if (!ACTIVE) return;
  try {
    if (auto) {
      metrics.increment('model_auto_routed_total', {
        reason: reason || 'unknown',
      });
    }

    const traceId = context.currentTraceId();
    if (traceId) {
      store.updateTrace(traceId, trace => {
        trace.model.route = {
          requested_provider_id: requested.providerId || null,
          requested_model_id: requested.modelId || null,
          actual_provider_id: actual.providerId || null,
          actual_model_id: actual.modelId || null,
          auto: auto === true,
          reason: reason || null,
        };
      });
    }

    recordEvent({
      event_name: EVENTS.MODEL_ROUTE,
      component: 'model',
      status: 'success',
      attributes: {
        requested_provider_id: requested.providerId,
        requested_model_id: requested.modelId,
        actual_provider_id: actual.providerId,
        actual_model_id: actual.modelId,
        auto: auto === true,
        reason: reason || 'none',
      },
    });
  } catch (_) {
    INTERNAL_ERRORS += 1;
  }
}

function recordToolResultReturned({ toolName, round = 1, forwarded = true }) {
  if (!ACTIVE) return;
  try {
    recordEvent({
      event_name: EVENTS.TOOL_RESULT_RETURNED,
      component: 'tool',
      status: forwarded ? 'success' : 'skipped',
      attributes: { tool_name: toolName, round, forwarded: forwarded === true },
    });
  } catch (_) {
    INTERNAL_ERRORS += 1;
  }
}

function beginMemorySearch({ source = 'memory', attempt = 1 } = {}) {
  if (!ACTIVE) return { active: false, complete() {} };

  const span = startSpan('memory.search', { source, attempt });
  const startedAt = Date.now();

  recordEvent({
    event_name: EVENTS.MEMORY_SEARCH_STARTED,
    component: 'memory',
    status: 'unknown',
    attributes: { source, attempt },
  });

  let settled = false;

  return {
    active: true,
    complete({ status = 'success', count = 0, errorCode = null, errorCategory = 'memory' } = {}) {
      if (settled) return;
      settled = true;
      const durationMs = Date.now() - startedAt;

      try {
        metrics.increment('memory_searches_total', { status });
        recordEvent({
          event_name: EVENTS.MEMORY_SEARCH_COMPLETED,
          component: 'memory',
          status,
          duration_ms: durationMs,
          error_code: errorCode,
          error_category: status === 'failed' ? errorCategory : null,
          attributes: { source, attempt, result_count: count },
        });
        span.end({ status, errorCode });
      } catch (_) {
        INTERNAL_ERRORS += 1;
      }
    },
  };
}

function recordContextBuild({ runtime, durationMs = 0 } = {}) {
  if (!ACTIVE || !runtime) return;
  try {
    const traceData = runtime.trace || {};
    const stages = traceData.stages || {};
    const measurement = runtime.measurement || {};
    const status = runtime.ok ? 'success' : 'failed';
    const errorCode = runtime.errorCode || null;

    const traceId = context.currentTraceId();
    if (traceId) {
      store.recordStages(traceId, {
        candidate: stages.candidate,
        selected: stages.selected,
        accepted: stages.accepted,
        injected: stages.injected,
        sent: stages.sent,
        consumed: null,
      });
      store.updateTrace(traceId, trace => {
        trace.context = {
          ok: runtime.ok === true,
          error_code: errorCode,
          history_total: traceData.history ? traceData.history.totalMessages : null,
          recent: traceData.history ? traceData.history.recent : null,
          recalled: traceData.history ? traceData.history.recalled : null,
          summarized: traceData.history ? traceData.history.summarized : null,
          memory_candidates: traceData.retrieval ? traceData.retrieval.candidates : null,
          memory_accepted: runtime.memory ? runtime.memory.accepted.length : null,
          summary_count: runtime.summary ? runtime.summary.count : null,
          dropped_count: Array.isArray(runtime.dropped) ? runtime.dropped.length : 0,
          dropped: Array.isArray(runtime.dropped)
            ? runtime.dropped.slice(0, 50).map(item => ({
                id: item && item.id ? item.id : null,
                kind: item && item.kind ? item.kind : null,
                stage: item && item.stage ? item.stage : null,
                reason: item && item.reason ? item.reason : null,
              }))
            : [],
          memory_skipped:
            traceData.retrieval && Array.isArray(traceData.retrieval.skipped)
              ? traceData.retrieval.skipped.slice(0, 50).map(item => ({
                  id: item && item.id ? item.id : null,
                  stage: item && item.stage ? item.stage : null,
                  reason: item && item.reason ? item.reason : null,
                }))
              : [],
          window: measurement.window || null,
          estimated_input_tokens: measurement.estimatedInputTokens ?? null,
          system_tokens: measurement.systemTokens ?? null,
          history_tokens: measurement.historyTokens ?? null,
          current_tokens: measurement.currentTokens ?? null,
          tools_reserve_tokens: measurement.toolsReserveTokens ?? null,
        };
      });
    }

    metrics.increment('context_builds_total', {
      status,
      error_code: errorCode || 'none',
    });

    const stageCounts = {
      candidate: stages.candidate,
      selected: stages.selected,
      accepted: stages.accepted,
      injected: stages.injected,
      sent: stages.sent,
    };
    for (const [stage, value] of Object.entries(stageCounts)) {
      if (Number.isFinite(value)) {
        metrics.increment('context_stage_items_total', { stage }, value);
      }
    }

    if (Number.isFinite(measurement.estimatedInputTokens)) {
      metrics.increment(
        'context_tokens_total',
        { kind: 'input_estimate', source: measurement.estimator || 'unknown' },
        measurement.estimatedInputTokens
      );
    }
    if (measurement.window && Number.isFinite(measurement.window.tokens)) {
      metrics.increment(
        'context_tokens_total',
        { kind: 'window', source: measurement.window.source || 'unknown' },
        measurement.window.tokens
      );
    }
    if (Number.isFinite(measurement.toolsReserveTokens) && measurement.toolsReserveTokens > 0) {
      metrics.increment(
        'context_tokens_total',
        { kind: 'tools_reserve', source: 'configured' },
        measurement.toolsReserveTokens
      );
    }

    if (runtime.memory && Array.isArray(runtime.memory.accepted)) {
      for (const item of runtime.memory.accepted) {
        metrics.increment(
          'memory_injected_items_total',
          { memory_type: (item && item.type) || 'unknown' },
          1
        );
      }
    }

    const eventName = runtime.ok
      ? EVENTS.CONTEXT_BUILD_COMPLETED
      : EVENTS.CONTEXT_BUILD_REJECTED;

    recordEvent({
      event_name: eventName,
      component: 'context',
      status,
      duration_ms: durationMs,
      error_code: errorCode,
      error_category: runtime.ok ? null : 'context',
      attributes: {
        stage_candidate: stages.candidate,
        stage_selected: stages.selected,
        stage_accepted: stages.accepted,
        stage_injected: stages.injected,
        stage_sent: stages.sent,
        history_total: traceData.history ? traceData.history.totalMessages : null,
        recent_count: traceData.history ? traceData.history.recent : null,
        recalled_count: traceData.history ? traceData.history.recalled : null,
        summary_count: runtime.summary ? runtime.summary.count : null,
        memory_candidates: traceData.retrieval ? traceData.retrieval.candidates : null,
        memory_accepted: runtime.memory ? runtime.memory.accepted.length : null,
        dropped_count: Array.isArray(runtime.dropped) ? runtime.dropped.length : 0,
        dropped_reasons: Array.isArray(runtime.dropped)
          ? runtime.dropped
              .slice(0, 10)
              .map(item => `${(item && item.kind) || 'block'}:${(item && item.reason) || 'dropped'}`)
          : [],
        memory_skipped_count:
          traceData.retrieval && Array.isArray(traceData.retrieval.skipped)
            ? traceData.retrieval.skipped.length
            : 0,
        memory_skipped_reasons:
          traceData.retrieval && Array.isArray(traceData.retrieval.skipped)
            ? traceData.retrieval.skipped
                .slice(0, 10)
                .map(item => `${(item && item.stage) || 'skipped'}:${(item && item.reason) || 'unknown'}`)
            : [],
        estimated_input_tokens: measurement.estimatedInputTokens ?? null,
        window_tokens: measurement.window ? measurement.window.tokens : null,
        window_source: measurement.window ? measurement.window.source : null,
        window_verified: measurement.window ? measurement.window.verified === true : false,
      },
    });
  } catch (_) {
    INTERNAL_ERRORS += 1;
  }
}

function recordSent({ count = 0, round = 1, toolsCount = 0, contextCount = 0, messageCount = 0 } = {}) {
  if (!ACTIVE) return;
  try {
    const traceId = context.currentTraceId();
    if (traceId) {
      const current = store.getTrace(traceId);
      const previous = current && current.stages ? current.stages.sent : null;
      const nextSent = Math.max(Number(previous) || 0, Number(count) || 0);
      const delta = Math.max(0, nextSent - (Number(previous) || 0));

      store.recordStages(traceId, { sent: nextSent });
      store.updateTrace(traceId, trace => {
        trace.counts.sent_rounds = (trace.counts.sent_rounds || 0) + 1;
        trace.counts.sent_messages = (trace.counts.sent_messages || 0) + messageCount;
      });

      if (delta > 0) {
        metrics.increment('context_stage_items_total', { stage: 'sent' }, delta);
      }
    }

    recordEvent({
      event_name: EVENTS.CONTEXT_SENT,
      component: 'context',
      status: 'success',
      attributes: {
        round,
        sent_count: count,
        context_count: contextCount,
        message_count: messageCount,
        tools_count: toolsCount,
      },
    });
  } catch (_) {
    INTERNAL_ERRORS += 1;
  }
}

function recordPersistence({ status = 'success', messageCount = 0, trimmedCount = 0, durationMs = 0 } = {}) {
  if (!ACTIVE) return;
  try {
    metrics.increment('persistence_writes_total', { status });
    recordEvent({
      event_name: EVENTS.PERSISTENCE_WRITE_COMPLETED,
      component: 'persistence',
      status,
      duration_ms: durationMs,
      error_code: status === 'failed' ? 'write_failed' : null,
      error_category: status === 'failed' ? 'persistence' : null,
      attributes: {
        message_count: messageCount,
        trimmed_count: trimmedCount,
      },
    });
  } catch (_) {
    INTERNAL_ERRORS += 1;
  }
}

function recordSessionLoaded({ messageCount = 0, status = 'success' } = {}) {
  if (!ACTIVE) return;
  try {
    recordEvent({
      event_name: EVENTS.SESSION_LOADED,
      component: 'session',
      status,
      attributes: { message_count: messageCount },
    });
  } catch (_) {
    INTERNAL_ERRORS += 1;
  }
}

function recordSseStarted({ sessionRef = null } = {}) {
  if (!ACTIVE) return;
  try {
    recordEvent({
      event_name: EVENTS.RESPONSE_STREAM_STARTED,
      component: 'sse',
      status: 'success',
      attributes: { session_ref: sessionRef },
    });
  } catch (_) {
    INTERNAL_ERRORS += 1;
  }
}

function recordSseCompleted({
  status = 'completed',
  durationMs = 0,
  firstTokenMs = null,
  deltaEvents = 0,
  errorCode = null,
} = {}) {
  if (!ACTIVE) return;
  try {
    metrics.increment('sse_connections_total', { status });
    recordEvent({
      event_name: EVENTS.RESPONSE_STREAM_COMPLETED,
      component: 'sse',
      status:
        status === 'completed'
          ? 'success'
          : status === 'aborted'
            ? 'cancelled'
            : status === 'rejected'
              ? 'denied'
              : 'failed',
      duration_ms: durationMs,
      error_code: errorCode,
      error_category: status === 'failed' ? 'sse' : null,
      attributes: {
        first_token_ms: firstTokenMs,
        delta_events: deltaEvents,
        termination: status,
      },
    });
  } catch (_) {
    INTERNAL_ERRORS += 1;
  }
}

function recordAgentGate({
  path = 'chat',
  switchOn = false,
  toolsSupported = false,
  hasNewImage = false,
  includeHistoryImages = false,
  useVision = false,
  reason = null,
  allowed = false,
} = {}) {
  if (!ACTIVE) return;
  try {
    recordEvent({
      event_name: EVENTS.AGENT_GATE,
      component: 'agent',
      status: allowed ? 'success' : 'skipped',
      attributes: {
        path,
        switch_on: switchOn === true,
        tools_supported: toolsSupported === true,
        has_new_image: hasNewImage === true,
        include_history_images: includeHistoryImages === true,
        use_vision: useVision === true,
        reason: reason || 'unknown',
        allowed: allowed === true,
      },
    });
  } catch (_) {
    INTERNAL_ERRORS += 1;
  }
}

function recordAgentRound({ round = 1, finishReason = null, toolCalls = 0 } = {}) {
  if (!ACTIVE) return;
  try {
    recordEvent({
      event_name: EVENTS.AGENT_ROUND_COMPLETED,
      component: 'agent',
      status: 'success',
      attributes: { round, finish_reason: finishReason, tool_calls: toolCalls },
    });
  } catch (_) {
    INTERNAL_ERRORS += 1;
  }
}

function recordAgentRun({
  status = 'success',
  rounds = 0,
  toolCount = 0,
  maxRounds = 0,
  reachedMaxRounds = false,
  clientGone = false,
} = {}) {
  if (!ACTIVE) return;
  try {
    metrics.observe('agent_rounds', { status }, rounds);
    recordEvent({
      event_name: EVENTS.AGENT_RUN_COMPLETED,
      component: 'agent',
      status,
      attributes: {
        rounds,
        tool_count: toolCount,
        max_rounds: maxRounds,
        reached_max_rounds: reachedMaxRounds === true,
        client_gone: clientGone === true,
      },
    });
  } catch (_) {
    INTERNAL_ERRORS += 1;
  }
}

function recordTask({
  status = 'unknown',
  termination = null,
  durationMs = 0,
  rounds = 0,
  toolCount = 0,
  totalTokens = undefined,
  usageSource = null,
  errorCode = null,
} = {}) {
  if (!ACTIVE) return;
  try {
    const traceId = context.currentTraceId();
    let effectiveTokens = totalTokens;
    let effectiveUsageSource = usageSource || 'missing';

    if (traceId) {
      const current = store.getTrace(traceId);
      if (current && current.model) {
        if (effectiveTokens === undefined || effectiveTokens === null) {
          effectiveTokens = current.model.total_tokens;
        }
        if (!usageSource) {
          effectiveUsageSource = current.model.usage_source || 'missing';
        }
      }
    }

    if (traceId) {
      store.updateTrace(traceId, trace => {
        trace.name = 'chat.task';
        trace.task = {
          status,
          termination,
          duration_ms: durationMs,
          error_code: errorCode,
        };
      });
    }

    metrics.increment('tasks_total', {
      status,
      termination: termination || 'unknown',
    });
    metrics.observe('task_duration_ms', { status }, durationMs);

    recordEvent({
      event_name: EVENTS.TASK_COMPLETED,
      component: 'task',
      status,
      duration_ms: durationMs,
      error_code: errorCode,
      error_category: status === 'failed' ? 'internal' : null,
      attributes: {
        termination: termination || 'unknown',
        rounds,
        tool_count: toolCount,
        total_tokens: effectiveTokens,
        usage_source: effectiveUsageSource,
      },
    });
  } catch (_) {
    INTERNAL_ERRORS += 1;
  }
}

function recordMemoryWrite({ action = 'none', status = 'success', written = false, reason = null } = {}) {
  if (!ACTIVE) return;
  try {
    metrics.increment('memory_writes_total', {
      action: action || 'none',
      status,
    });
    recordEvent({
      event_name: EVENTS.MEMORY_WRITE_COMPLETED,
      component: 'memory',
      status,
      error_code: status === 'failed' ? 'memory_write_failed' : null,
      error_category: status === 'failed' ? 'memory' : null,
      attributes: {
        action,
        written: written === true,
        reason: reason || null,
      },
    });
  } catch (_) {
    INTERNAL_ERRORS += 1;
  }
}

// ---- 查询 ----

function emptyQuery(reason) {
  return {
    ok: false,
    reason,
    data_status: reason === 'disabled' ? 'disabled' : 'unknown',
  };
}

function rangeStatus(from, to) {
  return {
    from: new Date(from).toISOString(),
    to: new Date(to).toISOString(),
    duration_minutes: Math.round((to - from) / 60000),
  };
}

function rate(numerator, denominator) {
  if (!denominator) return null;
  return Math.round((numerator / denominator) * 10000) / 10000;
}

function pct(value) {
  return value === null ? null : Math.round(value * 10000) / 10000;
}

function buildOverview({ from, to, now = Date.now() }) {
  if (!ACTIVE) return emptyQuery('disabled');

  const m = (name, filter) => metrics.aggregate(name, { from, to }, filter) || { count: 0 };
  const rows = name => (metrics.collect(name, { from, to }) || { rows: [] }).rows;

  const tasks = rows('tasks_total').map(row => ({
    status: row.labels.status,
    termination: row.labels.termination,
    count: row.count,
  }));
  const taskTotal = tasks.reduce((sum, row) => sum + row.count, 0);
  const taskBy = status => tasks.filter(row => row.status === status).reduce((sum, row) => sum + row.count, 0);
  const taskDurations = m('task_duration_ms');

  const modelRows = rows('model_requests_total');
  const modelTotal = modelRows.reduce((sum, row) => sum + row.count, 0);
  const modelFailed = modelRows
    .filter(row => row.labels.status === 'failed' || row.labels.status === 'timeout')
    .reduce((sum, row) => sum + row.count, 0);
  const modelDurations = m('model_request_duration_ms');

  const tokenRows = rows('model_tokens_total');
  const tokensBy = (kind, source) =>
    tokenRows
      .filter(row => row.labels.token_kind === kind && (!source || row.labels.usage_source === source))
      .reduce((sum, row) => sum + row.count, 0);
  const providerInput = tokensBy('input', 'provider');
  const providerOutput = tokensBy('output', 'provider');
  const missingUsage = tokenRows
    .filter(row => row.labels.usage_source === 'missing' && row.labels.token_kind === 'unknown')
    .reduce((sum, row) => sum + row.count, 0);

  const memoryRows = rows('memory_searches_total');
  const memoryTotal = memoryRows.reduce((sum, row) => sum + row.count, 0);
  const memoryBy = status =>
    memoryRows.filter(row => row.labels.status === status).reduce((sum, row) => sum + row.count, 0);
  const injectedRows = rows('memory_injected_items_total');
  const injectedTotal = injectedRows.reduce((sum, row) => sum + row.count, 0);

  const contextRows = rows('context_builds_total');
  const contextTotal = contextRows.reduce((sum, row) => sum + row.count, 0);
  const contextFailed = contextRows
    .filter(row => row.labels.status === 'failed')
    .reduce((sum, row) => sum + row.count, 0);
  const contextRejected = contextRows
    .filter(row => row.labels.error_code === 'context_too_large')
    .reduce((sum, row) => sum + row.count, 0);
  const stageRows = rows('context_stage_items_total');
  const stages = Object.fromEntries(stageRows.map(row => [row.labels.stage, row.count]));
  const tokenRowsContext = rows('context_tokens_total');
  const contextInputEstimates = tokenRowsContext
    .filter(row => row.labels.kind === 'input_estimate')
    .reduce((sum, row) => sum + row.count, 0);
  const contextWindowUnknown = tokenRowsContext
    .filter(row => row.labels.kind === 'window' && row.labels.source === 'unknown_guard')
    .reduce((sum, row) => sum + row.count, 0);

  const toolRows = rows('tool_calls_total');
  const toolTotal = toolRows.reduce((sum, row) => sum + row.count, 0);
  const toolBy = status =>
    toolRows.filter(row => row.labels.status === status).reduce((sum, row) => sum + row.count, 0);
  const toolDurations = m('tool_call_duration_ms');

  const httpRows = rows('http_requests_total');
  const httpTotal = httpRows.reduce((sum, row) => sum + row.count, 0);
  const http5xx = httpRows
    .filter(row => row.labels.status_class === '5xx')
    .reduce((sum, row) => sum + row.count, 0);
  const httpDurations = m('http_request_duration_ms');

  const sseRows = rows('sse_connections_total');
  const sseBy = status =>
    sseRows.filter(row => row.labels.status === status).reduce((sum, row) => sum + row.count, 0);

  const persistenceRows = rows('persistence_writes_total');
  const persistenceTotal = persistenceRows.reduce((sum, row) => sum + row.count, 0);
  const persistenceFailed = persistenceRows
    .filter(row => row.labels.status === 'failed')
    .reduce((sum, row) => sum + row.count, 0);

  const alertList = alerts.listAlerts({ status: 'firing', limit: 200 });
  const alertBySeverity = alertList.items.reduce((acc, alert) => {
    acc[alert.severity] = (acc[alert.severity] || 0) + 1;
    return acc;
  }, {});

  const healthData = health.getHealth({ now });
  const taskSuccessDenominator = taskTotal;
  const taskSuccessRate = rate(taskBy('success'), taskSuccessDenominator);
  const modelSuccessRate = rate(modelTotal - modelFailed, modelTotal);
  const memorySuccessRate = rate(memoryBy('success'), memoryTotal);
  const contextSuccessRate = rate(contextTotal - contextFailed, contextTotal);
  const toolSuccessRate = rate(toolBy('success'), toolTotal);
  const httpSuccessRate = rate(httpTotal - http5xx, httpTotal);

  const cards = [
    {
      key: 'agent',
      title: 'Agent 任务',
      data_status: taskTotal ? 'ok' : 'no_data',
      primary: { label: '任务数', value: taskTotal, unit: 'tasks' },
      metrics: [
        { label: '成功率', value: pct(taskSuccessRate), unit: 'ratio', definition: 'tasks_total: success / 全部终态' },
        { label: '失败', value: taskBy('failed'), unit: 'tasks' },
        { label: '部分成功', value: taskBy('partial_success'), unit: 'tasks' },
        { label: '取消', value: taskBy('cancelled'), unit: 'tasks' },
        { label: 'P95 耗时', value: taskDurations.p95 ? taskDurations.p95.value : null, unit: 'ms', approximate: true },
      ],
    },
    {
      key: 'model',
      title: '模型调用 / Token',
      data_status: modelTotal ? 'ok' : 'no_data',
      primary: { label: '模型请求', value: modelTotal, unit: 'requests' },
      metrics: [
        { label: '成功率', value: pct(modelSuccessRate), unit: 'ratio' },
        { label: '失败/超时', value: modelFailed, unit: 'requests' },
        { label: '输入 Token（供应商）', value: providerInput || null, unit: 'tokens' },
        { label: '输出 Token（供应商）', value: providerOutput || null, unit: 'tokens' },
        { label: '用量缺失请求', value: missingUsage, unit: 'requests' },
        { label: 'P95 耗时', value: modelDurations.p95 ? modelDurations.p95.value : null, unit: 'ms', approximate: true },
        {
          label: '费用',
          value: null,
          unit: 'currency',
          note: '未配置费率与供应商账单，按未知处理',
        },
      ],
    },
    {
      key: 'memory',
      title: '长期记忆',
      data_status: memoryTotal ? 'ok' : 'no_data',
      primary: { label: '检索调用', value: memoryTotal, unit: 'searches' },
      metrics: [
        { label: '成功', value: memoryBy('success'), unit: 'searches' },
        { label: '无结果', value: memoryBy('no_result'), unit: 'searches' },
        { label: '失败', value: memoryBy('failed'), unit: 'searches' },
        { label: '注入条目', value: injectedTotal, unit: 'items' },
        { label: '注入/检索成功', value: rate(injectedTotal, memoryBy('success')), unit: 'items_per_search' },
        { label: '检索成功率', value: pct(memorySuccessRate), unit: 'ratio' },
      ],
    },
    {
      key: 'context',
      title: '上下文与历史',
      data_status: contextTotal ? 'ok' : 'no_data',
      primary: { label: '构建次数', value: contextTotal, unit: 'builds' },
      metrics: [
        { label: '成功率', value: pct(contextSuccessRate), unit: 'ratio' },
        { label: '失败', value: contextFailed, unit: 'builds' },
        { label: '超限拒绝', value: contextRejected, unit: 'builds' },
        { label: '候选/选中/接受/注入/发送', value: ['candidate', 'selected', 'accepted', 'injected', 'sent'].map(stage => stages[stage] || 0), unit: 'items' },
        { label: '输入 Token（估算累计）', value: contextInputEstimates, unit: 'tokens' },
        { label: '窗口未知（unknown_guard）', value: contextWindowUnknown, unit: 'builds' },
      ],
    },
    {
      key: 'tools',
      title: '工具调用',
      data_status: toolTotal ? 'ok' : 'no_data',
      primary: { label: '调用数', value: toolTotal, unit: 'calls' },
      metrics: [
        { label: '成功率', value: pct(toolSuccessRate), unit: 'ratio' },
        { label: '失败/超时/拒绝', value: toolBy('failed') + toolBy('timeout') + toolBy('denied'), unit: 'calls' },
        { label: 'P95 耗时', value: toolDurations.p95 ? toolDurations.p95.value : null, unit: 'ms', approximate: true },
      ],
    },
    {
      key: 'http',
      title: 'API / 流式',
      data_status: httpTotal ? 'ok' : 'no_data',
      primary: { label: 'HTTP 请求', value: httpTotal, unit: 'requests' },
      metrics: [
        { label: '成功率', value: pct(httpSuccessRate), unit: 'ratio' },
        { label: '5xx', value: http5xx, unit: 'requests' },
        { label: 'P95 耗时', value: httpDurations.p95 ? httpDurations.p95.value : null, unit: 'ms', approximate: true },
        { label: 'SSE 完成', value: sseBy('completed'), unit: 'connections' },
        { label: 'SSE 中止', value: sseBy('aborted'), unit: 'connections' },
        { label: 'SSE 失败', value: sseBy('failed'), unit: 'connections' },
        { label: 'SSE 拒绝', value: sseBy('rejected'), unit: 'connections' },
      ],
    },
    {
      key: 'persistence',
      title: '持久化与备份',
      data_status: persistenceTotal || healthData.backup.exists ? 'ok' : 'no_data',
      primary: { label: '会话写入', value: persistenceTotal, unit: 'writes' },
      metrics: [
        { label: '写入失败', value: persistenceFailed, unit: 'writes' },
        { label: '备份状态', value: healthData.backup.exists ? (healthData.backup.ok ? '正常' : '异常') : '未配置', unit: 'state' },
        { label: '最近备份成功', value: healthData.backup.last_success_at, unit: 'timestamp' },
        { label: '恢复演练', value: healthData.backup.restore_drill, unit: 'state' },
      ],
    },
    {
      key: 'monitoring',
      title: '监控自身',
      data_status: healthData.status === 'no_data' ? 'no_data' : 'ok',
      primary: { label: '状态', value: healthData.status, unit: 'state' },
      metrics: [
        { label: '已接收事件', value: healthData.counters.accepted_events, unit: 'events' },
        { label: '写盘失败', value: healthData.counters.write_failures, unit: 'writes' },
        { label: '队列丢弃', value: healthData.counters.queue_dropped, unit: 'events' },
        { label: '活跃告警', value: alertList.items.length, unit: 'alerts' },
        { label: 'P0/P1', value: `${alertBySeverity.P0 || 0}/${alertBySeverity.P1 || 0}`, unit: 'counts' },
      ],
    },
  ];

  return {
    ok: true,
    generated_at: new Date(now).toISOString(),
    range: rangeStatus(from, to),
    data_status:
      taskTotal || modelTotal || contextTotal || httpTotal || memoryTotal ? 'ok' : 'no_data',
    cards,
    alerts: {
      firing: alertList.items.length,
      by_severity: alertBySeverity,
      notifications: healthData.alerting.notifications,
    },
    monitoring_health: {
      status: healthData.status,
      reasons: healthData.reasons,
      data_freshness_seconds: healthData.data_freshness_seconds,
    },
    backup: healthData.backup,
    cost: {
      status: 'not_configured',
      value: null,
      currency: null,
      note: '未配置模型费率与供应商账单；Token 用量为供应商 usage 或明确缺失',
    },
    definitions: {
      tasks_total: metrics.METRIC_DEFINITIONS.tasks_total,
      model_requests_total: metrics.METRIC_DEFINITIONS.model_requests_total,
      model_tokens_total: metrics.METRIC_DEFINITIONS.model_tokens_total,
      memory_searches_total: metrics.METRIC_DEFINITIONS.memory_searches_total,
      context_builds_total: metrics.METRIC_DEFINITIONS.context_builds_total,
      tool_calls_total: metrics.METRIC_DEFINITIONS.tool_calls_total,
      http_requests_total: metrics.METRIC_DEFINITIONS.http_requests_total,
    },
    coverage: {
      retained_events: healthData.storage.retained_events,
      retained_traces: healthData.storage.retained_traces,
      retention_days: healthData.storage.limits ? healthData.storage.limits.retention_days : null,
      approximate_percentiles: true,
    },
  };
}

function queryMetrics({ names = null, from, to, intervalMinutes }) {
  if (!ACTIVE) return emptyQuery('disabled');
  const requested = names && names.length ? names : [
    'http_requests_total',
    'model_requests_total',
    'tasks_total',
    'memory_searches_total',
    'context_builds_total',
    'tool_calls_total',
  ];
  const unknown = requested.filter(name => !metrics.METRIC_DEFINITIONS[name]);
  if (unknown.length) {
    return { ok: false, reason: 'unknown_metric', unknown, data_status: 'invalid' };
  }
  return {
    ok: true,
    generated_at: new Date().toISOString(),
    range: rangeStatus(from, to),
    approximate_percentiles: true,
    series: requested.map(name => metrics.query(name, { from, to, intervalMinutes })),
  };
}

function getTraces(options) {
  if (!ACTIVE) return emptyQuery('disabled');
  const result = store.listTraces(options);
  return {
    ok: true,
    generated_at: new Date().toISOString(),
    ...result,
    coverage: { retained_traces: store.getStats().traces },
  };
}

function getTraceDetail(traceId) {
  if (!ACTIVE) return emptyQuery('disabled');
  const trace = store.getTrace(traceId);
  if (!trace) return { ok: false, reason: 'not_found', data_status: 'missing' };
  const events = store.listEvents({ from: 0, to: Date.now(), traceId, limit: 200 });
  return {
    ok: true,
    generated_at: new Date().toISOString(),
    trace,
    events: events.items,
    events_total: events.total,
    events_truncated: events.total > events.items.length,
  };
}

function getEvents(options) {
  if (!ACTIVE) return emptyQuery('disabled');
  const result = store.listEvents(options);
  return {
    ok: true,
    generated_at: new Date().toISOString(),
    ...result,
    coverage: { retained_events: store.getStats().events },
  };
}

function getAuditEvents(options) {
  if (!ACTIVE) return emptyQuery('disabled');
  const result = store.listAudit(options);
  return {
    ok: true,
    generated_at: new Date().toISOString(),
    ...result,
    coverage: { retained_audit: store.getStats().audit },
  };
}

function getModelsSummary({ from, to }) {
  if (!ACTIVE) return emptyQuery('disabled');
  const requestRows = (metrics.collect('model_requests_total', { from, to }) || { rows: [] }).rows;
  const tokenRows = (metrics.collect('model_tokens_total', { from, to }) || { rows: [] }).rows;
  const durationRows =
    (metrics.collect('model_request_duration_ms', { from, to }) || { rows: [] }).rows;

  const models = new Map();

  const ensure = (providerId, modelId) => {
    const key = `${providerId}|${modelId}`;
    if (!models.has(key)) {
      models.set(key, {
        provider_id: providerId,
        model_id: modelId,
        requests: 0,
        success: 0,
        failed: 0,
        timeout: 0,
        denied: 0,
        cancelled: 0,
        input_tokens: null,
        output_tokens: null,
        cached_tokens: null,
        usage_missing: 0,
        duration: { avg: null, p95: null, p50: null, p99: null },
      });
    }
    return models.get(key);
  };

  for (const row of requestRows) {
    const item = ensure(row.labels.provider_id || 'unknown', row.labels.model_id || 'unknown');
    item.requests += row.count;
    if (row.labels.status === 'success') item.success += row.count;
    else if (row.labels.status === 'timeout') item.timeout += row.count;
    else if (row.labels.status === 'denied') item.denied += row.count;
    else if (row.labels.status === 'cancelled') item.cancelled += row.count;
    else item.failed += row.count;
  }

  for (const row of tokenRows) {
    const item = ensure(row.labels.provider_id || 'unknown', row.labels.model_id || 'unknown');
    if (row.labels.usage_source === 'missing') {
      item.usage_missing += row.count;
    } else if (row.labels.token_kind === 'input') {
      item.input_tokens = (item.input_tokens || 0) + row.count;
    } else if (row.labels.token_kind === 'output') {
      item.output_tokens = (item.output_tokens || 0) + row.count;
    }
  }

  const cachedRows =
    (metrics.collect('model_cached_tokens_total', { from, to }) || { rows: [] }).rows;
  for (const row of cachedRows) {
    const item = ensure(row.labels.provider_id || 'unknown', row.labels.model_id || 'unknown');
    item.cached_tokens = (item.cached_tokens || 0) + row.count;
  }

  for (const row of durationRows) {
    const item = ensure(row.labels.provider_id || 'unknown', row.labels.model_id || 'unknown');
    item.duration = {
      avg: row.avg,
      p50: row.p50 ? row.p50.value : null,
      p95: row.p95 ? row.p95.value : null,
      p99: row.p99 ? row.p99.value : null,
    };
  }

  return {
    ok: true,
    generated_at: new Date().toISOString(),
    range: rangeStatus(from, to),
    models: [...models.values()].sort((a, b) =>
      `${a.provider_id}/${a.model_id}`.localeCompare(`${b.provider_id}/${b.model_id}`)
    ),
    cost: {
      status: 'not_configured',
      note: '未配置费率与供应商账单；Token 仅展示供应商 usage，缺失时不估算',
    },
    approximate_percentiles: true,
  };
}

function getToolsSummary({ from, to }) {
  if (!ACTIVE) return emptyQuery('disabled');

  let registry = [];
  let switchOn = false;
  try {
    // 延迟 require：避免监控模块在 Agent 模块加载期间形成循环依赖。
    const agent = require('../agent-runtime');
    registry = typeof agent.listToolRegistry === 'function' ? agent.listToolRegistry() : [];
    switchOn = agent.agentToolsEnabled();
  } catch (_) {
    registry = [];
  }

  const rows = (metrics.collect('tool_calls_total', { from, to }) || { rows: [] }).rows;
  const durationRows = (metrics.collect('tool_call_duration_ms', { from, to }) || { rows: [] }).rows;
  const byTool = new Map();

  const ensure = name => {
    if (!byTool.has(name)) {
      byTool.set(name, {
        tool_name: name,
        calls: 0,
        success: 0,
        failed: 0,
        timeout: 0,
        denied: 0,
        p95: null,
      });
    }
    return byTool.get(name);
  };

  for (const row of rows) {
    const item = ensure(row.labels.tool_name || 'unknown');
    item.calls += row.count;
    if (row.labels.status === 'success') item.success += row.count;
    else if (row.labels.status === 'timeout') item.timeout += row.count;
    else if (row.labels.status === 'denied') item.denied += row.count;
    else item.failed += row.count;
  }

  for (const row of durationRows) {
    const item = ensure(row.labels.tool_name || 'unknown');
    item.p95 = row.p95 ? row.p95.value : null;
  }

  const registryNames = new Set(registry.map(tool => tool.name));
  const tools = registry.map(tool => ({
    ...tool,
    calls: byTool.get(tool.name) ? byTool.get(tool.name).calls : 0,
    success: byTool.get(tool.name) ? byTool.get(tool.name).success : 0,
    failed: byTool.get(tool.name) ? byTool.get(tool.name).failed : 0,
    timeout: byTool.get(tool.name) ? byTool.get(tool.name).timeout : 0,
    denied: byTool.get(tool.name) ? byTool.get(tool.name).denied : 0,
    p95: byTool.get(tool.name) ? byTool.get(tool.name).p95 : null,
  }));

  for (const item of byTool.values()) {
    if (!registryNames.has(item.tool_name)) tools.push({ ...item, registered: false });
  }

  return {
    ok: true,
    generated_at: new Date().toISOString(),
    range: rangeStatus(from, to),
    agent_switch_on: switchOn,
    agent_switch_note: switchOn
      ? '工具调用开关已开启'
      : 'BLUEBIRD_AGENT_TOOLS 未设为 1，模型即使请求工具也不会执行',
    tools,
    missing_capabilities: registry.length ? [] : ['未读取到任何已注册工具'],
    data_status: rows.length ? 'ok' : 'no_data',
    approximate_percentiles: true,
  };
}

function getAlertsSummary({ status = null, severity = null, limit = 50 } = {}) {
  if (!ACTIVE) return emptyQuery('disabled');
  const list = alerts.listAlerts({ status, severity, limit });
  return {
    ok: true,
    generated_at: new Date().toISOString(),
    ...list,
    rules: alerts.getRules(),
    states: alerts.getStates(),
    health: alerts.getAlertingHealth(),
  };
}

function getHealthData() {
  if (!ACTIVE) {
    return {
      ok: false,
      reason: 'disabled',
      data_status: 'disabled',
      status: 'disabled',
      enabled: false,
      reasons: ['monitoring_disabled'],
      counters: {},
      storage: null,
      backup: null,
      alerting: null,
      persistence: null,
      metrics: null,
      memory: null,
      query_layer: null,
      generated_at: new Date().toISOString(),
      capabilities: {
        real_chain_instrumentation: false,
        external_notifications: false,
        cost_estimation: false,
      },
      note: 'BLUEBIRD_MONITORING=0 或初始化失败；前端不得显示为健康',
      init_error: INIT_ERROR,
    };
  }
  const data = health.getHealth();
  return {
    ...data,
    ok: data.status === 'ok' || data.status === 'no_data',
    data_status: data.status,
  };
}

function getMeta() {
  return {
    ok: true,
    schema_version: schema.SCHEMA_VERSION,
    statuses: schema.STATUSES,
    levels: schema.LEVELS,
    error_categories: schema.ERROR_CATEGORIES,
    events: Object.values(EVENTS),
    components: [
      'http',
      'session',
      'context',
      'memory',
      'model',
      'tool',
      'agent',
      'sse',
      'persistence',
      'task',
      'monitoring',
    ],
    metric_definitions: metrics.METRIC_DEFINITIONS,
    alert_severities: alerts.SEVERITIES,
    active: ACTIVE,
    started_at: STARTED_AT,
    internal_errors: INTERNAL_ERRORS,
  };
}

function resetMonitoringForTests() {
  try {
    alerts.resetAlertsForTests();
  } catch (_) {
    /* ignore */
  }
  store.resetStoreForTests();
  metrics.resetMetricsForTests();
  ACTIVE = false;
  CONFIG = null;
  INIT_ERROR = null;
  STARTED_AT = null;
  INTERNAL_ERRORS = 0;
}

module.exports = {
  initMonitoring,
  shutdownMonitoring,
  isActive,
  getConfig,
  monitoringMiddleware,
  recordEvent,
  recordAudit,
  startSpan,
  beginModelCall,
  beginToolCall,
  recordToolResultReturned,
  recordModelRoute,
  beginMemorySearch,
  recordContextBuild,
  recordSent,
  recordPersistence,
  recordSessionLoaded,
  recordSseStarted,
  recordSseCompleted,
  recordAgentGate,
  recordAgentRound,
  recordAgentRun,
  recordTask,
  recordMemoryWrite,
  buildOverview,
  queryMetrics,
  getTraces,
  getTraceDetail,
  getEvents,
  getAuditEvents,
  getModelsSummary,
  getToolsSummary,
  getAlertsSummary,
  getHealth: getHealthData,
  getMeta,
  evaluateAlerts: alerts.evaluateAlerts,
  resetMonitoringForTests,
  sessionRefFor: context.sessionRefFor,
  actorRefFor: context.actorRefFor,
  EVENTS,
  STATUSES: schema.STATUSES,
  METRIC_DEFINITIONS: metrics.METRIC_DEFINITIONS,
};
