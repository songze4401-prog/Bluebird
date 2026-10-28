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

async function fetchMemory({ task, sessionId, config, injected }) {
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

    return {
      status: items.length ? 'ok' : 'no_result',
      count: items.length,
      items,
    };
  }

  const found = searchMemories({
    query: task,
    sessionId,
    limits: {
      maxItems: config.retrieval.memoryMaxItems,
      perItemMax: config.retrieval.memoryPerItemMax,
      totalMax: config.retrieval.memoryTotalMax,
    },
  });

  if (found.reason === 'memory_disabled') {
    return { status: 'source_unavailable', count: 0, items: [], error: '长期记忆未启用', reason: 'memory_disabled' };
  }
  if (found.reason === 'empty_query' || found.reason === 'empty_store') {
    return { status: 'no_result', count: 0, items: [], reason: found.reason };
  }

  const items = found.results.map(result => mapMemoryResult(result, config));
  return {
    status: items.length ? 'ok' : 'no_result',
    count: items.length,
    items,
  };
}

async function retrieveMemory({
  task,
  sessionId = null,
  injected = {},
  config = defaultConfig,
  now = Date.now(),
} = {}) {
  if (isTripped('memory', config, now)) {
    return {
      status: 'retrieval_error',
      count: 0,
      items: [],
      error: '记忆检索已熔断（暂时不可用）',
      breaker: true,
    };
  }

  let lastError = null;
  for (let attempt = 0; attempt <= config.retry.maxRetries; attempt += 1) {
    try {
      const outcome = await fetchMemory({ task, sessionId, config, injected });
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
