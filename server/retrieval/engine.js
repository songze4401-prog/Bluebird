/**
 * 云岫 Bluebird — 统一检索执行器（retrieval/engine.js）
 *
 * 链路：Query Plan → 词法/精确/向量并行召回 → RRF 融合 → 去重/多样性 →
 * 权限/时效/可追溯/注入风险门控 → 证据包（含引用与独立信号）→ 阶段 trace。
 *
 * 相似度只代表检索相关性；authority / confidence / freshness 与检索分分开
 * 返回，避免把“排序高”误读为“事实为真”。
 */
const crypto = require('crypto');
const {
  SOURCE_TYPES,
  SOURCE_TYPE_SET,
} = require('./contract');
const {
  tokenize,
  exactTerms,
  codeIntent,
  detectLanguage,
  jaccard,
  injectionRisk,
  freshnessOf,
  authorityForSource,
  truncateText,
} = require('./text');
const { estimateTokens, truncateToTokenBudget } = require('../text-utils');

const DEFAULT_SOURCES = ['memory', 'conversation', 'document', 'web', 'code'];
const MAX_LIMIT = 20;

function fail(errorCode, error, status = 'failed') {
  return {
    ok: false,
    status,
    errorCode,
    error,
    evidence: [],
    citations: [],
    trace: null,
  };
}

function normalizeSources(raw, { sessionId = null, allowed = null } = {}) {
  if (raw === undefined || raw === null || raw === '') {
    if (sessionId) return [...DEFAULT_SOURCES];
    return ['document', 'web', 'code'];
  }
  const list = Array.isArray(raw) ? raw : [raw];
  if (!list.length) return { error: 'sources_empty' };
  const result = [];
  for (const item of list) {
    if (typeof item !== 'string' || !SOURCE_TYPE_SET.has(item)) {
      return { error: 'invalid_source' };
    }
    if (allowed && !allowed.includes(item)) continue;
    if ((item === 'memory' || item === 'conversation') && !sessionId) {
      return { error: 'session_required' };
    }
    if (!result.includes(item)) result.push(item);
  }
  return result.length ? result : { error: 'sources_empty' };
}

function createPlan({
  query,
  sessionId = null,
  sources,
  limit,
  tokenBudget,
  asOf = null,
  now = Date.now(),
  timeoutMs,
  maxQueryChars,
  maxEvidence,
}) {
  const text = typeof query === 'string' ? query.trim() : '';
  if (!text) return { error: 'query_required' };
  if (text.length > maxQueryChars) return { error: 'query_too_long' };

  const normalizedLimit =
    Number.isFinite(limit) && limit > 0
      ? Math.min(Math.floor(limit), Math.min(MAX_LIMIT, maxEvidence))
      : Math.min(5, maxEvidence);
  const normalizedBudget =
    Number.isFinite(tokenBudget) && tokenBudget > 0
      ? Math.min(Math.floor(tokenBudget), 12000)
      : 1600;

  let asOfMs = null;
  if (asOf !== null && asOf !== undefined && asOf !== '') {
    const parsed = Date.parse(asOf);
    if (!Number.isFinite(parsed)) return { error: 'invalid_as_of' };
    asOfMs = parsed;
  }

  return {
    query: text,
    queryHash: crypto.createHash('sha256').update(text).digest('hex').slice(0, 20),
    queryChars: text.length,
    sessionId:
      typeof sessionId === 'string' && sessionId.trim() ? sessionId.trim() : null,
    sources,
    sourceSet: new Set(sources),
    limit: normalizedLimit,
    tokenBudget: normalizedBudget,
    asOfMs,
    now,
    deadline: now + Math.max(100, timeoutMs),
    language: detectLanguage(text),
    intent: codeIntent(text) ? 'code' : 'natural_language',
    exactTokens: exactTerms(text, 24),
    queryTerms: [...new Set(tokenize(text, 64))],
  };
}

function scopeAllows(chunk, plan) {
  const scope = chunk && chunk.scope;
  if (!scope) return false;
  if (scope.visibility === 'global') return true;
  if (scope.visibility === 'session') {
    return Boolean(
      plan.sessionId &&
        Array.isArray(scope.sessions) &&
        scope.sessions.includes(plan.sessionId)
    );
  }
  return false;
}

function validityAllows(chunk, plan) {
  const start = chunk.validFrom ? Date.parse(chunk.validFrom) : null;
  const end = chunk.validTo ? Date.parse(chunk.validTo) : null;
  const target = plan.asOfMs === null ? plan.now : plan.asOfMs;
  if (Number.isFinite(start) && start > target) return false;
  if (Number.isFinite(end) && end < target) return false;
  return true;
}

function statusAllows(chunk) {
  return chunk.status === 'active' || chunk.status === undefined;
}

function traceable(chunk) {
  return (
    typeof chunk.uri === 'string' &&
    chunk.uri.length > 0 &&
    typeof chunk.locator === 'string' &&
    chunk.locator.length > 0
  );
}

function prefilter(chunk, plan) {
  // ACL/来源过滤必须在打分前完成；状态/有效期放在 policy 阶段，
  // 这样 trace 能记录“为什么被排除”而不是静默消失。
  return plan.sourceSet.has(chunk.sourceType) && scopeAllows(chunk, plan);
}

function policyCheck(chunk, plan) {
  if (!plan.sourceSet.has(chunk.sourceType)) return 'source_filtered';
  if (!scopeAllows(chunk, plan)) return 'scope_denied';
  if (!statusAllows(chunk)) return 'status_not_active';
  if (!validityAllows(chunk, plan)) return 'outside_validity';
  if (!traceable(chunk)) return 'missing_source_locator';
  const risk = injectionRisk(chunk.content);
  if (risk.high) return 'prompt_injection_risk';
  return null;
}

function withTimeout(promise, ms, errorCode) {
  let timer = null;
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(() => {
      const error = new Error(errorCode);
      error.code = errorCode;
      reject(error);
    }, Math.max(10, ms));
  });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}

function cosine(a, b) {
  if (!Array.isArray(a) || !Array.isArray(b) || a.length !== b.length) return -1;
  let dot = 0;
  let normA = 0;
  let normB = 0;
  for (let i = 0; i < a.length; i += 1) {
    dot += a[i] * b[i];
    normA += a[i] * a[i];
    normB += b[i] * b[i];
  }
  if (!normA || !normB) return -1;
  return dot / (Math.sqrt(normA) * Math.sqrt(normB));
}

async function runChannels({ store, embedding, config, plan }) {
  const channels = [];
  const lexicalStart = Date.now();
  let lexicalResults = [];
  try {
    lexicalResults = store.lexical.search(plan.query, {
      topK: config.limits.candidates,
      allow: chunk => prefilter(chunk, plan),
    });
    channels.push({
      name: 'lexical',
      status: lexicalResults.length ? 'success' : 'no_result',
      count: lexicalResults.length,
      durationMs: Date.now() - lexicalStart,
    });
  } catch (_) {
    channels.push({
      name: 'lexical',
      status: 'failed',
      count: 0,
      durationMs: Date.now() - lexicalStart,
      errorCode: 'lexical_failed',
    });
  }

  const exactStart = Date.now();
  let exactResults = [];
  try {
    exactResults = store.lexical.searchExact(plan.query, {
      topK: config.limits.candidates,
      allow: chunk => prefilter(chunk, plan),
    });
    channels.push({
      name: 'exact',
      status: exactResults.length ? 'success' : 'no_result',
      count: exactResults.length,
      durationMs: Date.now() - exactStart,
    });
  } catch (_) {
    channels.push({
      name: 'exact',
      status: 'failed',
      count: 0,
      durationMs: Date.now() - exactStart,
      errorCode: 'exact_failed',
    });
  }

  const vectorStart = Date.now();
  let vectorResults = [];
  const vectorMeta = store.vectorMeta();
  const embeddingStats = embedding.stats();

  if (!embedding.available) {
    channels.push({
      name: 'vector',
      status: 'unavailable',
      count: 0,
      durationMs: 0,
      errorCode: embedding.reason || 'embedding_unavailable',
    });
  } else if (!vectorMeta.count) {
    channels.push({
      name: 'vector',
      status: 'unavailable',
      count: 0,
      durationMs: 0,
      errorCode: 'vector_index_empty',
    });
  } else if (
    vectorMeta.model !== embeddingStats.model ||
    vectorMeta.version !== embeddingStats.version ||
    vectorMeta.dimension !== embeddingStats.dimension
  ) {
    channels.push({
      name: 'vector',
      status: 'unavailable',
      count: 0,
      durationMs: 0,
      errorCode: 'vector_model_mismatch',
    });
  } else {
    try {
      const remaining = plan.deadline - Date.now();
      if (remaining <= 20) {
        channels.push({
          name: 'vector',
          status: 'timeout',
          count: 0,
          durationMs: Date.now() - vectorStart,
          errorCode: 'retrieval_deadline',
        });
      } else {
        const embedded = await withTimeout(
          embedding.embedQuery(plan.query),
          remaining,
          'embedding_timeout'
        );
        if (!embedded.ok) {
          channels.push({
            name: 'vector',
            status: 'failed',
            count: 0,
            durationMs: Date.now() - vectorStart,
            errorCode: embedded.errorCode || 'embedding_failed',
          });
        } else {
          const queryVector = embedded.vector;
          vectorResults = store
            .allChunks()
            .filter(chunk => prefilter(chunk, plan) && store.getVector(chunk.chunkId))
            .map(chunk => ({
              chunkId: chunk.chunkId,
              chunk,
              score: cosine(queryVector, store.getVector(chunk.chunkId)),
              matchedTerms: [],
            }))
            .filter(item => item.score > 0)
            .sort((a, b) => b.score - a.score)
            .slice(0, config.limits.candidates);
          channels.push({
            name: 'vector',
            status: vectorResults.length ? 'success' : 'no_result',
            count: vectorResults.length,
            durationMs: Date.now() - vectorStart,
          });
        }
      }
    } catch (error) {
      channels.push({
        name: 'vector',
        status: 'failed',
        count: 0,
        durationMs: Date.now() - vectorStart,
        errorCode: (error && error.code) || 'embedding_failed',
      });
    }
  }

  return { channels, lexicalResults, exactResults, vectorResults };
}

function fuseResults({ lexical, exact, vector, config, plan }) {
  const weights = config.fusion.weights;
  const k = config.fusion.rrfK;
  const merged = new Map();

  const add = (name, results) => {
    results.forEach((item, index) => {
      let entry = merged.get(item.chunkId);
      if (!entry) {
        entry = {
          chunk: item.chunk,
          rrf: 0,
          channelScores: {},
          matchedTerms: [],
        };
        merged.set(item.chunkId, entry);
      }
      entry.rrf += (weights[name] || 1) / (k + index + 1);
      entry.channelScores[name] = item.score;
      for (const term of item.matchedTerms || []) {
        if (entry.matchedTerms.length < 8 && !entry.matchedTerms.includes(term)) {
          entry.matchedTerms.push(term);
        }
      }
    });
  };

  add('lexical', lexical);
  add('exact', exact);
  add('vector', vector);

  const ranked = [...merged.values()].sort((a, b) => {
    if (b.rrf !== a.rrf) return b.rrf - a.rrf;
    return a.chunk.chunkId < b.chunk.chunkId ? -1 : 1;
  });

  const deduped = [];
  const duplicates = [];
  const seenHashes = new Map();

  for (const entry of ranked) {
    const chunk = entry.chunk;
    const previous = seenHashes.get(chunk.contentHash);
    if (previous) {
      duplicates.push({
        chunkId: chunk.chunkId,
        against: previous.chunk.chunkId,
        reason: 'duplicate_content',
      });
      continue;
    }

    const near = deduped.find(
      item =>
        item.chunk.sourceType !== chunk.sourceType &&
        jaccard(item.chunk.content, chunk.content) >= config.fusion.dedupeThreshold
    );
    if (near) {
      duplicates.push({
        chunkId: chunk.chunkId,
        against: near.chunk.chunkId,
        reason: 'near_duplicate',
      });
      continue;
    }

    seenHashes.set(chunk.contentHash, entry);
    deduped.push(entry);
  }

  const accepted = [];
  const rejected = [];
  for (const entry of deduped) {
    const reason = policyCheck(entry.chunk, plan);
    if (reason) {
      rejected.push({ chunkId: entry.chunk.chunkId, reason });
      continue;
    }
    accepted.push(entry);
  }

  const diversity = [];
  const perSource = new Map();
  const perFile = new Map();
  const selected = [];

  for (const entry of accepted) {
    const chunk = entry.chunk;
    const fileKey =
      (chunk.metadata && (chunk.metadata.filePath || chunk.metadata.relativePath)) ||
      chunk.sourceId;
    const sourceCount = perSource.get(chunk.sourceId) || 0;
    const fileCount = perFile.get(fileKey) || 0;

    if (sourceCount >= config.fusion.maxPerSource || fileCount >= config.fusion.maxPerFile) {
      diversity.push({
        chunkId: chunk.chunkId,
        reason:
          sourceCount >= config.fusion.maxPerSource ? 'source_diversity' : 'file_diversity',
      });
      continue;
    }

    perSource.set(chunk.sourceId, sourceCount + 1);
    perFile.set(fileKey, fileCount + 1);
    selected.push(entry);
    if (selected.length >= plan.limit) break;
  }

  return {
    ranked,
    deduped,
    duplicates,
    accepted,
    rejected,
    diversity,
    selected,
  };
}

function buildEvidence(entry, index, plan) {
  const chunk = entry.chunk;
  const staleAfter =
    chunk.sourceType === 'web'
      ? 30
      : chunk.sourceType === 'document'
        ? 180
        : chunk.sourceType === 'code'
          ? 365
          : 3650;
  const freshness = freshnessOf(chunk.updatedAt || chunk.validFrom, {
    staleAfterDays: staleAfter,
    now: plan.now,
  });
  const content = chunk.content;
  return {
    evidenceId: `ev_${chunk.chunkId.slice(4, 12)}_${index + 1}`,
    chunkId: chunk.chunkId,
    sourceType: chunk.sourceType,
    sourceId: chunk.sourceId,
    title: chunk.title,
    uri: chunk.uri,
    locator: chunk.locator,
    content,
    snippet: truncateText(content, 280),
    scores: {
      retrieval: Math.round(entry.rrf * 1e6) / 1e6,
      lexical: Number.isFinite(entry.channelScores.lexical)
        ? Math.round(entry.channelScores.lexical * 1e6) / 1e6
        : null,
      exact: Number.isFinite(entry.channelScores.exact)
        ? Math.round(entry.channelScores.exact * 1e6) / 1e6
        : null,
      vector: Number.isFinite(entry.channelScores.vector)
        ? Math.round(entry.channelScores.vector * 1e6) / 1e6
        : null,
    },
    signals: {
      authority: authorityForSource(chunk.sourceType),
      confidence:
        Number.isFinite(chunk.metadata && chunk.metadata.confidence)
          ? chunk.metadata.confidence
          : null,
      freshness,
      sourceVersion: chunk.sourceVersion || null,
      commit: (chunk.metadata && chunk.metadata.commit) || null,
      language: chunk.language || null,
    },
    matchedTerms: entry.matchedTerms,
    citation: {
      label: `K${index + 1}`,
      title: chunk.title,
      uri: chunk.uri,
      locator: chunk.locator,
      sourceType: chunk.sourceType,
      sourceVersion: chunk.sourceVersion || null,
      updatedAt: chunk.updatedAt,
    },
    flags: {
      stale: freshness.status === 'stale',
      truncated: false,
    },
  };
}

function packEvidence(entries, plan) {
  const evidence = [];
  const dropped = [];
  let usedTokens = 0;

  for (let index = 0; index < entries.length; index += 1) {
    const item = buildEvidence(entries[index], evidence.length, plan);
    const tokens = estimateTokens(item.content);
    const remaining = plan.tokenBudget - usedTokens;

    if (tokens > remaining && evidence.length > 0) {
      dropped.push({ chunkId: item.chunkId, reason: 'token_budget' });
      continue;
    }

    if (tokens > remaining) {
      const truncated = truncateToTokenBudget(item.content, remaining);
      if (!truncated) {
        dropped.push({ chunkId: item.chunkId, reason: 'token_budget' });
        continue;
      }
      item.content = truncated;
      item.snippet = truncateText(truncated, 280);
      item.flags.truncated = true;
    }

    usedTokens += estimateTokens(item.content);
    evidence.push(item);
    if (evidence.length >= plan.limit) break;
  }

  return { evidence, dropped, usedTokens };
}

function emptyTrace(plan) {
  return {
    traceId: `rt_${crypto.randomUUID()}`,
    queryHash: plan.queryHash,
    queryChars: plan.queryChars,
    language: plan.language,
    intent: plan.intent,
    sources: plan.sources,
    sessionScoped: Boolean(plan.sessionId),
    limits: { limit: plan.limit, tokenBudget: plan.tokenBudget },
    channels: [],
    fusion: null,
    policy: null,
    packing: null,
    embedding: null,
    degraded: [],
  };
}

async function executeSearch({ store, embedding, config, plan }) {
  if (!config.enabled) {
    return fail('retrieval_disabled', '统一检索未启用', 'disabled');
  }

  const loadInfo = store.stats().loadInfo;
  if (loadInfo.status === 'quarantined') {
    return fail(
      'index_unavailable',
      `索引不可用（${loadInfo.reason || 'quarantined'}），请先重建索引`
    );
  }

  const trace = emptyTrace(plan);
  if (loadInfo.status === 'degraded') {
    trace.degraded.push('invalid_index_entries_skipped');
  }

  const channels = await runChannels({ store, embedding, config, plan });
  trace.channels = channels.channels;
  trace.embedding = embedding.stats();

  const fusion = fuseResults({
    lexical: channels.lexicalResults,
    exact: channels.exactResults,
    vector: channels.vectorResults,
    config,
    plan,
  });
  trace.fusion = {
    candidates: fusion.ranked.length,
    deduped: fusion.deduped.length,
    duplicates: fusion.duplicates.length,
    policyAccepted: fusion.accepted.length,
    policyRejected: fusion.rejected.length,
    diversityDropped: fusion.diversity.length,
    ranked: fusion.selected.length,
  };
  trace.policy = {
    accepted: fusion.accepted.length,
    rejected: fusion.rejected.length,
    reasons: countReasons(fusion.rejected),
  };

  const packed = packEvidence(fusion.selected, plan);
  trace.packing = {
    selected: packed.evidence.length,
    dropped: packed.dropped.length,
    reasons: countReasons(packed.dropped),
    tokens: packed.usedTokens,
    tokenBudget: plan.tokenBudget,
  };

  const failedChannels = trace.channels.filter(
    channel => channel.status === 'failed' || channel.status === 'timeout'
  );
  for (const channel of failedChannels) {
    trace.degraded.push(`${channel.name}_${channel.errorCode || channel.status}`);
  }
  if (trace.embedding && !trace.embedding.available) {
    trace.degraded.push(`vector_${trace.embedding.reason || 'unavailable'}`);
  }
  trace.degraded = [...new Set(trace.degraded)];

  const status =
    packed.evidence.length > 0
      ? failedChannels.length
        ? 'partial_success'
        : 'success'
      : failedChannels.length
        ? 'partial_success'
        : 'no_result';

  return {
    ok: true,
    status,
    evidence: packed.evidence,
    citations: packed.evidence.map(item => item.citation),
    trace,
    degraded: trace.degraded,
  };
}

function countReasons(items) {
  const counts = {};
  for (const item of items) {
    const reason = item.reason || 'unknown';
    counts[reason] = (counts[reason] || 0) + 1;
  }
  return counts;
}

module.exports = {
  DEFAULT_SOURCES,
  normalizeSources,
  createPlan,
  executeSearch,
  scopeAllows,
  validityAllows,
  policyCheck,
  fuseResults,
  packEvidence,
  cosine,
  SOURCE_TYPES,
};
