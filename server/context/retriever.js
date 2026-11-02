/**
 * 云岫 Bluebird — Context Runtime v3 记忆检索（retriever.js）
 *
 * 唯一真实检索源：长期记忆（复用 memory.js 的 searchMemories，会话隔离）。
 * 旧 v2.3 的 user/doc/web/tool 检索源在生产链路没有真实注入方：
 * - user 历史改为独立的历史选择通道，不再伪装成检索条目；
 * - doc/web 没有真实文档/网页读取器；
 * - tool 结果由 Agent 工具循环直接回传给模型，不经过上下文检索。
 * 因此这些空壳源已删除；外部资料接入是明确的未实现项，不用假模块占位。
 */
const { config: defaultConfig } = require('./config');
const { searchMemories } = require('../memory');
const monitoring = require('../monitoring');

const MEMORY_TYPE_MAP = {
  preference: 'user_preference',
  identity: 'project_fact',
  fact: 'project_fact',
  goal: 'project_fact',
  relationship: 'project_fact',
};

// 熔断状态（进程级，按源粒度）：记忆检索连续失败时暂时跳过，不影响聊天主链路。
const breakerState = new Map();

function isTripped(source, config, now = Date.now()) {
  const state = breakerState.get(source);
  if (!state) return false;
  if (state.until && state.until > now) return true;
  if (state.until && state.until <= now) breakerState.delete(source);
  return false;
}

function recordRetrievalFailure(source, config, now = Date.now()) {
  const threshold = config.circuitBreaker.failureThreshold;
  const windowMs = config.circuitBreaker.windowMs;
  const state = breakerState.get(source) || { failures: 0, until: 0 };
  state.failures += 1;
  if (state.failures >= threshold) {
    state.until = now + windowMs;
    state.failures = 0;
  }
  breakerState.set(source, state);
}

function resetBreaker(source) {
  breakerState.delete(source);
}

function computeFreshness({ type, ttl, fetchedAt, config, now = Date.now() }) {
  const nowMs = typeof now === 'number' ? now : new Date(now).getTime();
  const fetchedMs = fetchedAt ? new Date(fetchedAt).getTime() : null;

  if (!fetchedMs || Number.isNaN(fetchedMs)) {
    return { fetched_at: fetchedAt || null, ttl, status: 'unknown', label: '时效未知' };
  }

  const ttlConfig = (config && config.ttl && config.ttl[type]) || null;

  if (!ttlConfig || typeof ttlConfig.ttlMs !== 'number') {
    return { fetched_at: fetchedAt, ttl, status: 'unknown', label: '时效未知' };
  }

  const ttlMs = Number.isFinite(ttl) && ttl > 0 ? ttl : ttlConfig.ttlMs;
  const age = nowMs - fetchedMs;

  if (age <= ttlMs) {
    return { fetched_at: fetchedAt, ttl: ttlMs, status: 'fresh', label: 'fresh' };
  }

  if (type === 'realtime_data') {
    return { fetched_at: fetchedAt, ttl: ttlMs, status: 'expired', label: '已过期，必须重新获取' };
  }

  return { fetched_at: fetchedAt, ttl: ttlMs, status: 'stale', label: '可能过时' };
}

let entrySeq = 0;

function makeItem({ id, content, type, freshness, relevance = null }) {
  entrySeq += 1;
  return {
    id: typeof id === 'string' && id ? id : `mem-${entrySeq}`,
    source: 'memory',
    content,
    type,
    verification: {
      status: 'schema_valid',
      checked_items: ['extracted', 'source_verified', 'sensitive_filtered'],
    },
    freshness,
    relevance,
  };
}

function mapMemoryResult(result, config) {
  const type = MEMORY_TYPE_MAP[result.type] || 'project_fact';
  const ttlConfig = config.ttl[type];
  const fetchedAt = result.validFrom || result.updatedAt || null;

  return makeItem({
    id: result.id,
    content: result.content,
    type,
    freshness: computeFreshness({
      type,
      ttl: ttlConfig && ttlConfig.ttlMs,
      fetchedAt,
      config,
    }),
    relevance: Number.isFinite(result.relevance) ? result.relevance : null,
  });
}

// 记忆检索超时的统一结果：时间预算耗尽时不冒充空结果，也不阻断主控。
function memoryTimeoutOutcome(timeoutMs, { partialItems = [], elapsedMs = null } = {}) {
  return {
    status: 'retrieval_error',
    count: partialItems.length,
    items: partialItems,
    error:
      elapsedMs !== null
        ? `记忆检索超出时间预算（${elapsedMs}ms > ${timeoutMs}ms），已降级`
        : `记忆检索超时（超出 ${timeoutMs}ms 时间预算），已降级`,
    timeout: true,
    retried: false,
  };
}

async function fetchMemory({
  task,
  sessionId,
  userId,
  config,
  injected,
  attempt = 1,
  deadline = null,
}) {
  const timeoutMs = config.retrieval.memoryTimeoutMs;
  const monitor = monitoring.beginMemorySearch({ source: 'memory', attempt });

  // 同步检索无法被抢占：入口先查一次剩余预算，预算耗尽就不再开始新的扫描。
  if (deadline && Date.now() >= deadline) {
    monitor.complete({ status: 'timeout', count: 0, errorCode: 'retrieval_timeout' });
    return memoryTimeoutOutcome(timeoutMs);
  }
  const injectedEntries = Array.isArray(injected.memory) ? injected.memory : [];
  if (injectedEntries.length) {
    const items = injectedEntries
      .map((entry, index) => {
        const type = MEMORY_TYPE_MAP[entry.type] || 'project_fact';
        const ttlConfig = config.ttl[type];
        return makeItem({
          id: entry.id || `mem-injected-${index + 1}`,
          content: typeof entry.content === 'string' ? entry.content : '',
          type,
          freshness: computeFreshness({
            type,
            ttl: entry.ttl || (ttlConfig && ttlConfig.ttlMs),
            fetchedAt: entry.fetchedAt || null,
            config,
          }),
          relevance: Number.isFinite(entry.relevance) ? entry.relevance : null,
        });
      })
      .filter(item => item.content);

    monitor.complete({
      status: items.length ? 'success' : 'no_result',
      count: items.length,
    });

    return {
      status: items.length ? 'ok' : 'no_result',
      count: items.length,
      items,
    };
  }

  const startedAt = Date.now();
  try {
    const found = searchMemories({
      query: task,
      sessionId,
      userId,
      limits: {
        maxItems: config.retrieval.memoryMaxItems,
        perItemMax: config.retrieval.memoryPerItemMax,
        totalMax: config.retrieval.memoryTotalMax,
      },
    });

    if (found.reason === 'memory_disabled') {
      monitor.complete({ status: 'disabled', count: 0, errorCode: 'memory_disabled' });
      return {
        status: 'source_unavailable',
        count: 0,
        items: [],
        error: '长期记忆未启用',
        reason: 'memory_disabled',
        diagnostics: found.diagnostics || null,
      };
    }
    if (found.reason === 'empty_query' || found.reason === 'empty_store') {
      monitor.complete({ status: 'no_result', count: 0 });
      return {
        status: 'no_result',
        count: 0,
        items: [],
        reason: found.reason,
        diagnostics: found.diagnostics || null,
      };
    }

    const items = found.results.map(result => mapMemoryResult(result, config));

    // 同步扫描不可抢占：完成后按真实耗时判断是否已超预算。
    // 已拿到的结果照常注入，但必须显式标记超时，让 memoryState 降为 degraded，
    // 而不是把一次超预算的检索伪装成健康。
    const elapsedMs = Date.now() - startedAt;
    const expired = deadline !== null && Date.now() > deadline;

    monitor.complete({
      status: expired ? 'timeout' : items.length ? 'success' : 'no_result',
      count: items.length,
      ...(expired ? { errorCode: 'retrieval_timeout' } : {}),
    });

    if (expired) {
      return memoryTimeoutOutcome(timeoutMs, { partialItems: items, elapsedMs });
    }

    return {
      status: items.length ? 'ok' : 'no_result',
      count: items.length,
      items,
      diagnostics: found.diagnostics || null,
    };
  } catch (error) {
    monitor.complete({
      status: 'failed',
      count: 0,
      errorCode: 'memory_search_error',
    });
    throw error;
  }
}

async function retrieveMemory({
  task,
  sessionId = null,
  userId = null,
  injected = {},
  config = defaultConfig,
  now = Date.now(),
} = {}) {
  if (isTripped('memory', config, now)) {
    const skipped = monitoring.beginMemorySearch({ source: 'memory' });
    skipped.complete({ status: 'skipped', count: 0, errorCode: 'breaker_open' });
    return {
      status: 'retrieval_error',
      count: 0,
      items: [],
      error: '记忆检索已熔断（暂时不可用）',
      breaker: true,
    };
  }

  // 时间预算只覆盖本轮检索（含重试）；超时不再重试，避免把一次慢查询放大成多次。
  const timeoutMs = config.retrieval.memoryTimeoutMs;
  const deadline =
    Number.isFinite(timeoutMs) && timeoutMs > 0 ? now + timeoutMs : null;

  let lastError = null;
  for (let attempt = 0; attempt <= config.retry.maxRetries; attempt += 1) {
    if (deadline !== null && Date.now() >= deadline) {
      lastError = memoryTimeoutOutcome(timeoutMs);
      break;
    }
    try {
      const outcome = await fetchMemory({
        task,
        sessionId,
        userId,
        config,
        injected,
        attempt: attempt + 1,
        deadline,
      });
      if (outcome.timeout) {
        recordRetrievalFailure('memory', config, now);
        return outcome;
      }
      if (outcome.status === 'retrieval_error') {
        lastError = outcome;
        continue;
      }
      resetBreaker('memory');
      return outcome;
    } catch (error) {
      lastError = {
        status: 'retrieval_error',
        count: 0,
        items: [],
        error: error && error.message ? error.message : '检索失败',
        retried: attempt < config.retry.maxRetries,
      };
    }
  }

  recordRetrievalFailure('memory', config, now);
  return lastError || {
    status: 'retrieval_error',
    count: 0,
    items: [],
    error: '检索失败（查询失败，非无结果）',
  };
}

module.exports = {
  retrieveMemory,
  computeFreshness,
  resetBreaker,
  MEMORY_TYPE_MAP,
};
