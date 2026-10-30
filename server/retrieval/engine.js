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

// 时效性硬过滤：只对配置里列出的时效敏感源（默认 web）生效，
// 超过 maxAgeDays 的内容直接判 stale_source；0 = 关闭。
// 长期记忆/文档不受影响——它们的价值不随时间线性消失，只由重排做软衰减。
function ageAllows(chunk, plan, config) {
  const rerank = (config && config.rerank) || {};
  const maxAgeDays = Number(rerank.maxAgeDays) || 0;
  if (!maxAgeDays) return true;
  const sources = Array.isArray(rerank.recencyFilterSources)
    ? rerank.recencyFilterSources
    : [];
  if (!sources.includes(chunk.sourceType)) return true;
  const stamp = Date.parse(chunk.updatedAt || chunk.observedAt || chunk.createdAt || '');
  if (!Number.isFinite(stamp)) return true;
  return plan.now - stamp <= maxAgeDays * 86400000;
}

function policyCheck(chunk, plan, config) {
  if (!plan.sourceSet.has(chunk.sourceType)) return 'source_filtered';
  if (!scopeAllows(chunk, plan)) return 'scope_denied';
  if (!statusAllows(chunk)) return 'status_not_active';
  if (!validityAllows(chunk, plan)) return 'outside_validity';
  if (!ageAllows(chunk, plan, config)) return 'stale_source';
  if (!traceable(chunk)) return 'missing_source_locator';
  const risk = injectionRisk(chunk.content);
  if (risk.high) return 'prompt_injection_risk';
  return null;
}

// 时间衰减分：半衰期越短掉得越快，但有下限，避免老记忆直接沉底。
function recencyScore(chunk, now, halfLifeDays, floor) {
  const stamp = Date.parse(chunk.updatedAt || chunk.createdAt || chunk.observedAt || '');
  if (!Number.isFinite(stamp)) return floor;
  const ageDays = Math.max(0, (now - stamp) / 86400000);
  const decayed = Math.pow(0.5, ageDays / Math.max(1, halfLifeDays));
  return Math.max(floor, Math.min(1, decayed));
}

// 记忆图谱分：候选之间共享足够多的关键词视为一条边，度数越高说明它处在
// 同一话题簇里，适度加权。只用已有的 metadata.keywords，不引入新存储。
function graphScores(entries, minOverlap) {
  const sets = entries.map(entry => {
    const meta = entry.chunk.metadata || {};
    const list = Array.isArray(meta.keywords) ? meta.keywords : [];
    return new Set(
      list
        .map(keyword => String(keyword || '').toLowerCase().trim())
        .filter(Boolean)
    );
  });

  const peers = entries.map(() => 0);
  for (let i = 0; i < entries.length; i += 1) {
    if (!sets[i].size) continue;
    for (let j = 0; j < entries.length; j += 1) {
      if (i === j || !sets[j].size) continue;
      let shared = 0;
      for (const keyword of sets[i]) {
        if (sets[j].has(keyword)) shared += 1;
        if (shared >= minOverlap) break;
      }
      if (shared >= minOverlap) peers[i] += 1;
    }
  }

  const maxPeers = peers.reduce((max, value) => Math.max(max, value), 0);
  return peers.map(value => (maxPeers ? value / maxPeers : 0));
}

// 候选重排序：把 RRF、词法分、向量余弦、时间衰减、图谱度数各自归一后加权。
// 向量通道不可用时自动把它的权重剔除并重新归一，不把「没有向量」当 0 分打压。
function rerankEntries({ entries, config, now }) {
  const rerank = (config && config.rerank) || {};
  if (!rerank.enabled || entries.length < 2) {
    return { entries, applied: false, weights: null };
  }

  const weights = rerank.weights || {};
  const maxRrf = entries.reduce((max, entry) => Math.max(max, entry.rrf), 0) || 1;
  const maxLexical =
    entries.reduce(
      (max, entry) => Math.max(max, Number(entry.channelScores.lexical) || 0),
      0
    ) || 1;
  const vectorAvailable = entries.some(
    entry => typeof entry.channelScores.vector === 'number'
  );
  const maxVector = vectorAvailable
    ? entries.reduce(
        (max, entry) => Math.max(max, Number(entry.channelScores.vector) || 0),
        0
      ) || 1
    : 1;

  const effective = {
    rrf: Number(weights.rrf) || 0,
    lexical: Number(weights.lexical) || 0,
    vector: vectorAvailable ? Number(weights.vector) || 0 : 0,
    recency: Number(weights.recency) || 0,
    graph: Number(weights.graph) || 0,
  };
  const total =
    effective.rrf + effective.lexical + effective.vector + effective.recency + effective.graph ||
    1;

  const graph = graphScores(entries, Number(rerank.graphMinKeywordOverlap) || 2);

  const scored = entries.map((entry, index) => {
    const signals = {
      rrf: entry.rrf / maxRrf,
      lexical: (Number(entry.channelScores.lexical) || 0) / maxLexical,
      vector: vectorAvailable ? (Number(entry.channelScores.vector) || 0) / maxVector : 0,
      recency: recencyScore(
        entry.chunk,
        now,
        Number(rerank.recencyHalfLifeDays) || 30,
        Number.isFinite(rerank.recencyFloor) ? rerank.recencyFloor : 0.15
      ),
      graph: graph[index],
    };
    const combined =
      (signals.rrf * effective.rrf +
        signals.lexical * effective.lexical +
        signals.vector * effective.vector +
        signals.recency * effective.recency +
        signals.graph * effective.graph) /
      total;
    entry.rerank = { score: Number(combined.toFixed(6)), signals };
    return entry;
  });

  scored.sort((a, b) => {
    if (b.rerank.score !== a.rerank.score) return b.rerank.score - a.rerank.score;
    return a.chunk.chunkId < b.chunk.chunkId ? -1 : 1;
  });

  return { entries: scored, applied: true, weights: effective, vectorAvailable };
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
    const reason = policyCheck(entry.chunk, plan, config);
    if (reason) {
      rejected.push({ chunkId: entry.chunk.chunkId, reason });
      continue;
    }
    accepted.push(entry);
  }

  const reranked = rerankEntries({ entries: accepted, config, now: plan.now });

  const diversity = [];
  const perSource = new Map();
  const perFile = new Map();
  const selected = [];

  for (const entry of reranked.entries) {
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
    rerank: {
      applied: reranked.applied,
      weights: reranked.weights,
      vectorAvailable: Boolean(reranked.vectorAvailable),
    },
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

async function executeSearch({ store, embedding, reranker, config, plan }) {
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

  const neuralRerankerAvailable = Boolean(reranker && reranker.available);
  const poolLimit = neuralRerankerAvailable
    ? Math.max(plan.limit, Number(reranker.topN) || 20)
    : plan.limit;
  const fusionPlan =
    poolLimit === plan.limit ? plan : { ...plan, limit: poolLimit };

  const fusion = fuseResults({
    lexical: channels.lexicalResults,
    exact: channels.exactResults,
    vector: channels.vectorResults,
    config,
    plan: fusionPlan,
  });

  let finalSelected = fusion.selected.slice(0, plan.limit);
  let neuralRerank = {
    applied: false,
    reason: neuralRerankerAvailable
      ? 'not_attempted'
      : (reranker && reranker.reason) || 'not_configured',
  };

  if (neuralRerankerAvailable && fusion.selected.length > 1) {
    const candidates = fusion.selected.slice(0, poolLimit);

    try {
      const outcome = await reranker.rerank({
        query: plan.query,
        documents: candidates.map(entry => entry.chunk.content),
      });

      if (outcome.ok && Array.isArray(outcome.scores) && outcome.scores.length) {
        const byIndex = new Map(
          outcome.scores.map(item => [item.index, item.score])
        );
        const ordered = candidates
          .map((entry, index) => ({
            entry,
            index,
            score: byIndex.has(index) ? byIndex.get(index) : null,
          }))
          .sort((a, b) => {
            const left = a.score === null ? -Infinity : a.score;
            const right = b.score === null ? -Infinity : b.score;
            if (left !== right) return right - left;
            return a.index - b.index;
          });
        const scored = ordered.filter(item => item.score !== null);
        const unscored = ordered.filter(item => item.score === null);

        finalSelected = [...scored, ...unscored]
          .map(item => item.entry)
          .slice(0, plan.limit);

        neuralRerank = {
          applied: true,
          provider: reranker.stats().provider,
          model: outcome.model || reranker.model,
          version: outcome.version || reranker.version,
          candidates: candidates.length,
          scored: outcome.scores.length,
          latencyMs: outcome.latencyMs || null,
          usage: outcome.usage || null,
        };
      } else {
        neuralRerank = {
          applied: false,
          attempted: true,
          errorCode: outcome.errorCode || 'reranker_failed',
        };
        trace.degraded.push('reranker_failed');
      }
    } catch (error) {
      neuralRerank = {
        applied: false,
        attempted: true,
        errorCode:
          (error && error.code) || error && error.name || 'reranker_failed',
      };
      trace.degraded.push('reranker_failed');
    }
  }

  trace.fusion = {
    candidates: fusion.ranked.length,
    deduped: fusion.deduped.length,
    duplicates: fusion.duplicates.length,
    policyAccepted: fusion.accepted.length,
    policyRejected: fusion.rejected.length,
    diversityDropped: fusion.diversity.length,
    ranked: finalSelected.length,
    rerank: fusion.rerank,
  };
  trace.neuralRerank = neuralRerank;
  trace.policy = {
    accepted: fusion.accepted.length,
    rejected: fusion.rejected.length,
    reasons: countReasons(fusion.rejected),
  };

  const packed = packEvidence(finalSelected, plan);
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
  ageAllows,
  policyCheck,
  fuseResults,
  packEvidence,
  cosine,
  recencyScore,
  graphScores,
  rerankEntries,
  SOURCE_TYPES,
};
