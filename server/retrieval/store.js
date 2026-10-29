/* global Buffer */
/**
 * 云岫 Bluebird — 检索索引存储（retrieval/store.js）
 *
 * 第一版嵌入式存储：单个 index.json 原子替换 + 内存倒排索引。
 * 选择理由（见 docs/unified-retrieval.md）：无新依赖、Windows/Linux 均可运行、
 * 持久化与备份方式与现有 data/*.json 一致；规模上限显式（chunk/source/字节）。
 *
 * 可靠性：
 * - 先算好下一份完整索引，原子写盘成功后才替换内存状态，绝不“内存已改、磁盘没改”；
 * - 损坏索引隔离重命名（保留现场），不以空索引覆盖原文件；
 * - 向量是派生数据，模型/版本/维度不一致时整批作废，绝不混用不同语义空间。
 */
const fs = require('fs');
const path = require('path');
const { writeFileAtomicSync } = require('../atomic-write');
const { logDataEvent } = require('../data-events');
const { createLexicalIndex } = require('./lexical');
const {
  SOURCE_TYPE_SET,
  validateChunk,
  sanitizeMetadata,
} = require('./contract');

const STORE_SCHEMA_VERSION = 1;

function nowIso() {
  return new Date().toISOString();
}

function readJsonFile(file) {
  const raw = fs.readFileSync(file, 'utf8');
  return JSON.parse(raw);
}

function cleanString(value, max) {
  return typeof value === 'string' && value.length <= max ? value : '';
}

function normalizeSource(raw) {
  if (!raw || typeof raw !== 'object') return null;
  const id = cleanString(raw.id, 160);
  if (!id || !SOURCE_TYPE_SET.has(raw.type)) return null;
  return {
    id,
    type: raw.type,
    title: cleanString(raw.title, 200),
    uri: cleanString(raw.uri, 500),
    state: ['pending', 'indexed', 'failed'].includes(raw.state)
      ? raw.state
      : 'indexed',
    sourceVersion: cleanString(raw.sourceVersion, 200) || null,
    contentHash: cleanString(raw.contentHash, 64) || null,
    chunkCount:
      Number.isInteger(raw.chunkCount) && raw.chunkCount >= 0 ? raw.chunkCount : 0,
    createdAt: cleanString(raw.createdAt, 40) || nowIso(),
    updatedAt: cleanString(raw.updatedAt, 40) || nowIso(),
    indexedAt: cleanString(raw.indexedAt, 40) || nowIso(),
    metadata: sanitizeMetadata(raw.metadata),
  };
}

function normalizeVectorState(raw, limits) {
  const empty = { model: null, version: null, dimension: 0, vectors: new Map() };
  if (!raw || typeof raw !== 'object') return empty;
  const model = cleanString(raw.model, 120);
  const version = cleanString(raw.version, 80);
  const dimension =
    Number.isInteger(raw.dimension) && raw.dimension > 0 && raw.dimension <= 4096
      ? raw.dimension
      : 0;
  const map = raw.vectors && typeof raw.vectors === 'object' ? raw.vectors : {};
  if (!model || !version || !dimension) return empty;
  const vectors = new Map();
  for (const [chunkId, vector] of Object.entries(map)) {
    if (vectors.size >= limits.maxVectorChunks) break;
    if (
      !Array.isArray(vector) ||
      vector.length !== dimension ||
      !vector.every(value => typeof value === 'number' && Number.isFinite(value))
    ) {
      continue;
    }
    vectors.set(chunkId, vector);
  }
  return { model, version, dimension, vectors };
}

function serializeVectorState(state) {
  if (!state || !state.model || !state.vectors.size) {
    return { model: null, version: null, dimension: 0, vectors: {} };
  }
  const vectors = {};
  for (const [chunkId, vector] of state.vectors) {
    vectors[chunkId] = vector.map(value => Math.round(value * 1e6) / 1e6);
  }
  return {
    model: state.model,
    version: state.version,
    dimension: state.dimension,
    vectors,
  };
}

function createStore(config) {
  const limits = config.limits;
  const indexFile = path.join(config.dataDir, 'index.json');
  const snapshotsDir = config.snapshotsDir;
  const lexical = createLexicalIndex();

  const state = {
    loaded: false,
    generation: 0,
    updatedAt: null,
    chunks: new Map(),
    sources: new Map(),
    vectorState: { model: null, version: null, dimension: 0, vectors: new Map() },
    loadInfo: {
      status: 'uninitialized',
      quarantined: false,
      quarantinedPath: null,
      skippedChunks: 0,
      skippedSources: 0,
      reason: null,
      isolationFailed: false,
    },
  };

  function ensureDirectory() {
    fs.mkdirSync(config.dataDir, { recursive: true });
    fs.mkdirSync(snapshotsDir, { recursive: true });
  }

  function quarantine(reason) {
    const target = `${indexFile}.corrupt-${new Date().toISOString().replace(/[:.]/g, '-')}`;
    try {
      fs.renameSync(indexFile, target);
      state.loadInfo.quarantined = true;
      state.loadInfo.quarantinedPath = target;
      logDataEvent({
        module: 'retrieval',
        file: indexFile,
        reason,
        action: 'isolated_file',
        isolatedPath: target,
        extra: { index: 'retrieval' },
      });
      return true;
    } catch (error) {
      logDataEvent({
        module: 'retrieval',
        file: indexFile,
        reason,
        error,
        action: 'isolation_failed',
        extra: { index: 'retrieval' },
      });
      return false;
    }
  }

  function load() {
    if (state.loaded) return state;
    ensureDirectory();

    if (!fs.existsSync(indexFile)) {
      state.loaded = true;
      state.loadInfo.status = 'empty';
      lexical.rebuild([]);
      return state;
    }

    try {
      const stat = fs.statSync(indexFile);
      if (stat.size > limits.maxIndexBytes) {
        const isolated = quarantine('index_too_large');
        state.loaded = true;
        state.loadInfo.status = 'quarantined';
        state.loadInfo.reason = 'index_too_large';
        state.loadInfo.isolationFailed = !isolated;
        lexical.rebuild([]);
        return state;
      }

      const raw = readJsonFile(indexFile);
      if (!raw || raw.schemaVersion !== STORE_SCHEMA_VERSION) {
        throw new Error('schema_version');
      }

      const chunks = new Map();
      const sources = new Map();
      let skippedChunks = 0;
      let skippedSources = 0;

      for (const sourceRaw of Array.isArray(raw.sources) ? raw.sources : []) {
        const source = normalizeSource(sourceRaw);
        if (!source) {
          skippedSources += 1;
          continue;
        }
        sources.set(source.id, source);
      }

      for (const chunkRaw of Array.isArray(raw.chunks) ? raw.chunks : []) {
        if (validateChunk(chunkRaw)) {
          skippedChunks += 1;
          continue;
        }
        if (chunks.size >= limits.maxChunks) {
          skippedChunks += 1;
          continue;
        }
        chunks.set(chunkRaw.chunkId, chunkRaw);
      }

      state.chunks = chunks;
      state.sources = sources;
      state.vectorState = normalizeVectorState(raw.vectors, limits);
      state.generation = Number.isInteger(raw.generation) ? raw.generation : 0;
      state.updatedAt = cleanString(raw.updatedAt, 40) || null;
      state.loadInfo = {
        status:
          skippedChunks || skippedSources ? 'degraded' : 'ready',
        quarantined: false,
        quarantinedPath: null,
        skippedChunks,
        skippedSources,
        reason:
          skippedChunks || skippedSources ? 'invalid_entries_skipped' : null,
        isolationFailed: false,
      };
      state.loaded = true;
      lexical.rebuild(chunks.values());
      return state;
    } catch (error) {
      const reason =
        error && error.name === 'SyntaxError'
          ? 'json_parse_error'
          : error && error.message === 'schema_version'
            ? 'schema_version'
            : 'load_error';
      const isolated = quarantine(reason);
      state.loaded = true;
      state.chunks = new Map();
      state.sources = new Map();
      state.vectorState = { model: null, version: null, dimension: 0, vectors: new Map() };
      state.loadInfo = {
        status: 'quarantined',
        quarantined: true,
        quarantinedPath: state.loadInfo.quarantinedPath,
        skippedChunks: 0,
        skippedSources: 0,
        reason,
        isolationFailed: !isolated,
      };
      lexical.rebuild([]);
      return state;
    }
  }

  function commit({ chunks, sources, vectorState, reason }) {
    if (state.loadInfo.isolationFailed) {
      const error = new Error('index_isolation_failed');
      error.code = 'index_isolation_failed';
      throw error;
    }
    const nextChunks = chunks || state.chunks;
    const nextSources = sources || state.sources;
    const nextVectors = vectorState || state.vectorState;

    const serialized = {
      schemaVersion: STORE_SCHEMA_VERSION,
      generation: state.generation + 1,
      updatedAt: nowIso(),
      reason: cleanString(reason, 80) || 'update',
      chunks: [...nextChunks.values()].sort((a, b) =>
        a.chunkId < b.chunkId ? -1 : a.chunkId > b.chunkId ? 1 : 0
      ),
      sources: [...nextSources.values()].sort((a, b) =>
        a.id < b.id ? -1 : a.id > b.id ? 1 : 0
      ),
      vectors: serializeVectorState(nextVectors),
    };

    const text = JSON.stringify(serialized);
    if (Buffer.byteLength(text, 'utf8') > limits.maxIndexBytes) {
      const error = new Error('index_size_limit_exceeded');
      error.code = 'index_size_limit_exceeded';
      throw error;
    }

    ensureDirectory();
    writeFileAtomicSync(indexFile, text);

    state.chunks = nextChunks;
    state.sources = nextSources;
    state.vectorState = nextVectors;
    state.generation = serialized.generation;
    state.updatedAt = serialized.updatedAt;
    // 新索引已原子落盘并可正常读写；原损坏文件已单独保留，不再阻塞检索。
    state.loadInfo = {
      ...state.loadInfo,
      status: state.loadInfo.status === 'degraded' ? 'degraded' : 'ready',
      quarantined: false,
      reason: state.loadInfo.status === 'degraded' ? state.loadInfo.reason : null,
    };
    lexical.rebuild(nextChunks.values());
    return {
      generation: state.generation,
      chunks: nextChunks.size,
      sources: nextSources.size,
    };
  }

  function normalizeUpsertItem(item) {
    const normalized = normalizeSource(item && item.source);
    if (!normalized) {
      const error = new Error('invalid_source');
      error.code = 'invalid_source';
      throw error;
    }
    const chunks = item && item.chunks;
    if (!Array.isArray(chunks) || !chunks.length) {
      const error = new Error('empty_source_chunks');
      error.code = 'empty_source_chunks';
      throw error;
    }

    const incoming = [];
    const seen = new Set();
    for (const chunk of chunks) {
      const invalid = validateChunk(chunk);
      if (invalid) {
        const error = new Error(`invalid_chunk:${invalid}`);
        error.code = 'invalid_chunk';
        throw error;
      }
      if (chunk.sourceId !== normalized.id) {
        const error = new Error('chunk_source_mismatch');
        error.code = 'chunk_source_mismatch';
        throw error;
      }
      if (!seen.has(chunk.chunkId)) {
        seen.add(chunk.chunkId);
        incoming.push(chunk);
      }
    }

    return { normalized, incoming };
  }

  function upsertSources(items, { reason = 'sources_upsert' } = {}) {
    load();
    if (!Array.isArray(items) || !items.length) {
      const error = new Error('empty_sources');
      error.code = 'empty_sources';
      throw error;
    }

    const prepared = items.map(normalizeUpsertItem);
    const nextChunks = new Map(state.chunks);
    const nextSources = new Map(state.sources);
    const nextVectors = {
      ...state.vectorState,
      vectors: new Map(state.vectorState.vectors),
    };
    const results = [];
    let anyChanged = false;

    for (const { normalized, incoming } of prepared) {
      const previousIds = new Set();
      for (const [chunkId, chunk] of state.chunks) {
        if (chunk.sourceId === normalized.id) previousIds.add(chunkId);
      }

      let added = 0;
      let removed = 0;
      let unchanged = 0;
      const incomingIds = new Set();

      for (const chunk of incoming) {
        incomingIds.add(chunk.chunkId);
        if (previousIds.has(chunk.chunkId)) {
          unchanged += 1;
          continue;
        }
        nextChunks.set(chunk.chunkId, chunk);
        added += 1;
      }

      for (const chunkId of previousIds) {
        if (incomingIds.has(chunkId)) continue;
        nextChunks.delete(chunkId);
        nextVectors.vectors.delete(chunkId);
        removed += 1;
      }

      const previousSource = state.sources.get(normalized.id);
      const contentChanged =
        !previousSource ||
        previousSource.sourceVersion !== normalized.sourceVersion ||
        previousSource.contentHash !== normalized.contentHash ||
        added > 0 ||
        removed > 0;

      if (contentChanged) {
        anyChanged = true;
        nextSources.set(normalized.id, {
          ...normalized,
          chunkCount: incoming.length,
          updatedAt: normalized.updatedAt || nowIso(),
          indexedAt: nowIso(),
          state: 'indexed',
        });
      }

      results.push({
        sourceId: normalized.id,
        changed: contentChanged,
        added,
        removed,
        unchanged,
        source: contentChanged ? nextSources.get(normalized.id) : previousSource,
      });
    }

    if (!anyChanged) {
      return { changed: false, items: results };
    }

    if (nextChunks.size > limits.maxChunks) {
      const error = new Error('chunk_limit_exceeded');
      error.code = 'chunk_limit_exceeded';
      throw error;
    }
    if (nextSources.size > limits.maxSources) {
      const error = new Error('source_limit_exceeded');
      error.code = 'source_limit_exceeded';
      throw error;
    }

    const committed = commit({
      chunks: nextChunks,
      sources: nextSources,
      vectorState: nextVectors,
      reason,
    });

    return { changed: true, items: results, ...committed };
  }

  function upsertSource({ source, chunks, reason = 'source_upsert' }) {
    const result = upsertSources([{ source, chunks }], { reason });
    const item = result.items[0];
    return {
      changed: result.changed && item.changed,
      added: item.added,
      removed: item.removed,
      unchanged: item.unchanged,
      source: item.source,
      ...(result.changed ? result : {}),
    };
  }

  function deleteSource(sourceId) {
    load();
    const id = cleanString(sourceId, 160);
    if (!id || !state.sources.has(id)) {
      return { removed: false, chunks: 0 };
    }

    const nextChunks = new Map(state.chunks);
    const nextVectors = {
      ...state.vectorState,
      vectors: new Map(state.vectorState.vectors),
    };
    let removedChunks = 0;
    for (const [chunkId, chunk] of state.chunks) {
      if (chunk.sourceId === id) {
        nextChunks.delete(chunkId);
        nextVectors.vectors.delete(chunkId);
        removedChunks += 1;
      }
    }
    const nextSources = new Map(state.sources);
    nextSources.delete(id);

    if (nextChunks.size === state.chunks.size && nextSources.size === state.sources.size) {
      return { removed: false, chunks: 0 };
    }

    commit({
      chunks: nextChunks,
      sources: nextSources,
      vectorState: nextVectors,
      reason: 'source_delete',
    });
    return { removed: true, chunks: removedChunks };
  }

  function getSource(sourceId) {
    load();
    return state.sources.get(sourceId) || null;
  }

  function listSources() {
    load();
    return [...state.sources.values()].map(source => ({ ...source }));
  }

  function allChunks() {
    load();
    return [...state.chunks.values()];
  }

  function getChunk(chunkId) {
    load();
    return state.chunks.get(chunkId) || null;
  }

  function getVector(chunkId) {
    load();
    return state.vectorState.vectors.get(chunkId) || null;
  }

  function vectorMeta() {
    load();
    return {
      model: state.vectorState.model,
      version: state.vectorState.version,
      dimension: state.vectorState.dimension,
      count: state.vectorState.vectors.size,
    };
  }

  function replaceVectors({ model, version, dimension, entries }) {
    load();
    if (
      typeof model !== 'string' ||
      !model ||
      typeof version !== 'string' ||
      !version ||
      !Number.isInteger(dimension) ||
      dimension <= 0 ||
      dimension > 4096
    ) {
      const error = new Error('invalid_vector_meta');
      error.code = 'invalid_vector_meta';
      throw error;
    }

    const vectors = new Map();
    for (const entry of Array.isArray(entries) ? entries : []) {
      if (vectors.size >= limits.maxVectorChunks) break;
      const chunk = state.chunks.get(entry && entry.chunkId);
      if (!chunk) continue;
      const vector = entry.vector;
      if (
        !Array.isArray(vector) ||
        vector.length !== dimension ||
        !vector.every(value => typeof value === 'number' && Number.isFinite(value))
      ) {
        continue;
      }
      vectors.set(chunk.chunkId, vector);
    }

    const next = { model, version, dimension, vectors };
    commit({
      chunks: state.chunks,
      sources: state.sources,
      vectorState: next,
      reason: 'vectors_replace',
    });
    return { count: vectors.size, model, version, dimension };
  }

  function clearVectors() {
    load();
    if (!state.vectorState.vectors.size && !state.vectorState.model) {
      return { cleared: false };
    }
    commit({
      chunks: state.chunks,
      sources: state.sources,
      vectorState: { model: null, version: null, dimension: 0, vectors: new Map() },
      reason: 'vectors_clear',
    });
    return { cleared: true };
  }

  function pruneMissingSources(existingSourceIds) {
    load();
    const keep = existingSourceIds instanceof Set ? existingSourceIds : new Set(existingSourceIds);
    const nextChunks = new Map();
    const nextVectors = {
      ...state.vectorState,
      vectors: new Map(state.vectorState.vectors),
    };
    const nextSources = new Map();
    let removedSources = 0;
    let removedChunks = 0;

    for (const [id, source] of state.sources) {
      if (keep.has(id)) nextSources.set(id, source);
      else removedSources += 1;
    }
    for (const [chunkId, chunk] of state.chunks) {
      if (nextSources.has(chunk.sourceId)) nextChunks.set(chunkId, chunk);
      else {
        removedChunks += 1;
        nextVectors.vectors.delete(chunkId);
      }
    }

    if (!removedSources && !removedChunks) {
      return { removedSources: 0, removedChunks: 0 };
    }
    commit({
      chunks: nextChunks,
      sources: nextSources,
      vectorState: nextVectors,
      reason: 'prune_missing_sources',
    });
    return { removedSources, removedChunks };
  }

  function consistency() {
    load();
    const issues = [];
    let orphanChunks = 0;
    let missingVectors = 0;
    for (const chunk of state.chunks.values()) {
      if (!state.sources.has(chunk.sourceId)) orphanChunks += 1;
      if (state.vectorState.model && !state.vectorState.vectors.has(chunk.chunkId)) {
        missingVectors += 1;
      }
    }
    for (const source of state.sources.values()) {
      const actual = [...state.chunks.values()].filter(
        chunk => chunk.sourceId === source.id
      ).length;
      if (actual !== source.chunkCount) {
        issues.push({
          type: 'chunk_count_mismatch',
          sourceId: source.id,
          expected: source.chunkCount,
          actual,
        });
      }
    }
    if (orphanChunks) issues.push({ type: 'orphan_chunks', count: orphanChunks });
    if (missingVectors) issues.push({ type: 'missing_vectors', count: missingVectors });
    if (state.loadInfo.status === 'quarantined') {
      issues.push({ type: 'index_quarantined', reason: state.loadInfo.reason });
    }
    if (state.loadInfo.status === 'degraded') {
      issues.push({ type: 'invalid_entries_skipped' });
    }
    return {
      ok: issues.length === 0,
      issues,
      generation: state.generation,
    };
  }

  function stats() {
    load();
    const byType = {};
    for (const source of state.sources.values()) {
      byType[source.type] = (byType[source.type] || 0) + 1;
    }
    let bytes = 0;
    try {
      bytes = fs.statSync(indexFile).size;
    } catch (_) {
      bytes = 0;
    }
    return {
      status: state.loadInfo.status,
      generation: state.generation,
      updatedAt: state.updatedAt,
      chunks: state.chunks.size,
      sources: state.sources.size,
      sourcesByType: byType,
      vectors: state.vectorState.vectors.size,
      vectorMeta: {
        model: state.vectorState.model,
        version: state.vectorState.version,
        dimension: state.vectorState.dimension,
      },
      bytes,
      loadInfo: { ...state.loadInfo },
      lexical: lexical.stats(),
    };
  }

  return {
    indexFile,
    snapshotsDir,
    load,
    commit,
    upsertSource,
    upsertSources,
    deleteSource,
    getSource,
    listSources,
    allChunks,
    getChunk,
    getVector,
    vectorMeta,
    replaceVectors,
    clearVectors,
    pruneMissingSources,
    consistency,
    stats,
    lexical,
    isLoaded() {
      return state.loaded;
    },
  };
}

module.exports = {
  STORE_SCHEMA_VERSION,
  createStore,
  normalizeSource,
};
