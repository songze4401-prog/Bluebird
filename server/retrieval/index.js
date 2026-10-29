/**
 * 云岫 Bluebird — 统一检索服务门面（retrieval/index.js）
 *
 * 对外只暴露：
 *   search / searchForContext / ingest / removeSource / rebuild / getStatus
 *
 * canonical source 仍是 memory / sessions / 文件 / 网页 / Git；
 * index.json 与向量都是可重建的派生数据。任何检索失败都返回明确错误码，
 * 不把“索引不可用”伪装成“没有结果”。
 */
const fs = require('fs');
const path = require('path');
const sessions = require('../sessions');
const { config } = require('./config');
const { createStore } = require('./store');
const { createEmbeddingProvider } = require('./embedding');
const engine = require('./engine');
const { collectMemoryChunks, sourceIdsForMemory } = require('./connectors/memory');
const { collectConversationChunks } = require('./connectors/conversation');
const { ingestDocument } = require('./connectors/document');
const { ingestWeb } = require('./connectors/web');
const { ingestCode } = require('./connectors/code');
const { sha256 } = require('./contract');
const { isInside } = require('./security');

const store = createStore(config);
const embedding = createEmbeddingProvider(config.embedding);

const syncState = {
  memory: { signature: null, status: 'never', lastAt: null, errorCode: null },
  conversations: new Map(),
  lastRebuildAt: null,
};

let initialized = false;
let initError = null;
let mutationTail = Promise.resolve();

// 异步摄取/重建共享同一写入队列：连接器读取/抓取可以并发，但落盘提交严格串行，
// 避免“重建向量期间新增来源”造成向量覆盖或 generation 倒退。
function enqueueMutation(task) {
  const run = mutationTail.then(task, task);
  mutationTail = run.then(
    () => undefined,
    () => undefined
  );
  return run;
}

const ERROR_MESSAGES = Object.freeze({
  query_required: '检索内容不能为空',
  query_too_long: `检索内容超过 ${config.limits.maxQueryChars} 字上限`,
  sources_empty: '没有可检索的来源',
  invalid_source: '来源类型非法',
  session_required: '检索记忆或历史对话时必须提供 sessionId',
  invalid_as_of: 'asOf 不是合法时间',
  retrieval_disabled: '统一检索未启用',
  index_unavailable: '检索索引不可用，请先重建',
  index_isolation_failed: '索引损坏且无法安全隔离，请人工处理索引文件后重启',
  retrieval_failed: '检索执行失败',
  roots_not_configured: '未配置允许的文档/代码根目录',
  path_required: '缺少文件或仓库路径',
  path_outside_allowed_roots: '路径不在允许的根目录内',
  invalid_url: 'URL 非法',
  unsupported_protocol: '只允许 http/https 链接',
  credentials_in_url: 'URL 不能包含账号密码',
  private_address: '禁止访问环回/私网/链路本地地址',
  blocked_host: '禁止访问该主机',
  dns_lookup_failed: '域名解析失败',
  dns_no_address: '域名没有可用地址',
  response_too_large: '网页内容超过读取上限',
  fetch_timeout: '网页抓取超时',
  fetch_failed: '网页抓取失败',
  http_error: '网页返回非成功状态',
  too_many_redirects: '重定向次数过多',
  redirect_without_location: '重定向缺少目标地址',
  invalid_redirect: '重定向地址非法',
  response_decode_failed: '网页压缩内容解码失败',
  unsupported_content_encoding: '不支持的网页压缩编码',
  unsupported_content_type: '不支持的网页内容类型',
  binary_content: '网页内容不是文本',
  snapshot_storage_limit: '网页快照存储达到上限',
  unsupported_format: '暂不支持该文档格式（PDF/DOCX 需要额外解析运行时）',
  empty_document: '文档没有可索引的正文',
  empty_content: '内容为空',
  ingest_failed: '知识源索引失败',
  source_not_found: '索引来源不存在',
  not_a_file: '路径不是文件',
  file_too_large: '文件超过单文件大小上限',
  binary_file: '文件不是文本',
  path_not_found: '路径不存在',
  not_a_directory: '路径不是目录',
  no_indexable_files: '没有可索引的代码文件',
  chunk_limit_exceeded: '索引 chunk 数达到上限',
  source_limit_exceeded: '索引来源数达到上限',
  index_size_limit_exceeded: '索引文件达到大小上限',
  managed_source: '该来源由记忆/会话生命周期管理，请在原入口删除',
  source_root_missing: '来源对应的允许根目录已不存在，无法刷新',
  source_type_not_refreshable: '该来源类型不支持外部刷新',
  refresh_url_required: '刷新网页来源必须重新提供 url（索引不保存原始查询参数）',
  url_mismatch: '提供的 url 与来源身份不匹配',
  source_missing: '外部文件已删除，派生索引已移除',
});

function describeError(code) {
  return ERROR_MESSAGES[code] || '检索操作失败';
}

function failure(code, extra = {}) {
  return {
    ok: false,
    errorCode: code,
    error: describeError(code),
    ...extra,
  };
}

function initialize() {
  if (!config.enabled || initialized) return getStatus();
  initialized = true;
  try {
    store.load();
    initError = null;
  } catch (error) {
    initError = {
      code: error && error.code ? error.code : 'index_init_failed',
      message: describeError('index_unavailable'),
    };
  }
  return getStatus();
}

function syncMemory({ force = false } = {}) {
  if (!config.enabled) return { status: 'disabled' };
  const collected = collectMemoryChunks({
    maxChunkChars: config.limits.maxChunkChars,
  });

  if (collected.reason === 'memory_disabled') {
    // 记忆被关闭后，旧派生 chunk 必须立即从可检索面移除，不能继续被搜到。
    const keep = new Set();
    for (const source of store.listSources()) {
      if (source.type !== 'memory') keep.add(source.id);
    }
    store.pruneMissingSources(keep);
    syncState.memory = {
      signature: 'memory_disabled',
      status: 'disabled',
      lastAt: new Date().toISOString(),
      errorCode: null,
    };
    return { status: 'disabled', count: 0 };
  }

  const signature = sha256(
    collected.sources
      .map(
        item =>
          `${item.source.id}:${item.source.sourceVersion}:${item.source.contentHash}:${item.chunks.length}`
      )
      .sort()
      .join('|')
  ).slice(0, 32);

  if (!force && signature === syncState.memory.signature) {
    return {
      status: syncState.memory.status === 'disabled' ? 'disabled' : 'unchanged',
      count: collected.sources.length,
    };
  }

  try {
    if (collected.sources.length) {
      store.upsertSources(collected.sources, { reason: 'memory_sync' });
    }

    const keep = new Set();
    for (const source of store.listSources()) {
      if (source.type !== 'memory') keep.add(source.id);
    }
    for (const id of sourceIdsForMemory()) keep.add(id);
    store.pruneMissingSources(keep);

    syncState.memory = {
      signature,
      status: 'ok',
      lastAt: new Date().toISOString(),
      errorCode: null,
    };
    return {
      status: 'ok',
      count: collected.sources.length,
      skippedLegacy: collected.skipped || 0,
    };
  } catch (error) {
    syncState.memory = {
      signature: syncState.memory.signature,
      status: 'failed',
      lastAt: new Date().toISOString(),
      errorCode: (error && error.code) || 'memory_sync_failed',
    };
    return {
      status: 'failed',
      errorCode: syncState.memory.errorCode,
      error: describeError(syncState.memory.errorCode),
    };
  }
}

function syncConversation(sessionId, { force = false } = {}) {
  if (!config.enabled) return { status: 'disabled' };
  const id = typeof sessionId === 'string' ? sessionId.trim() : '';
  if (!id) return { status: 'skipped', reason: 'session_required' };

  const collected = collectConversationChunks(id, {
    maxChunkChars: config.limits.maxChunkChars,
  });

  if (!collected.exists) {
    // 会话已删除：派生对话索引必须立即消失，不能凭旧 sessionId 继续检索。
    const staleSourceId = `conversation:${id}`;
    if (store.getSource(staleSourceId)) store.deleteSource(staleSourceId);
    return { status: 'skipped', reason: 'session_missing' };
  }

  if (collected.empty) {
    const sourceId = `conversation:${id}`;
    if (store.getSource(sourceId)) store.deleteSource(sourceId);
    syncState.conversations.set(id, {
      signature: 'empty',
      status: 'ok',
      lastAt: new Date().toISOString(),
      errorCode: null,
    });
    return { status: 'ok', count: 0 };
  }

  const signature = `${collected.source.sourceVersion}:${collected.chunks.length}`;
  const previous = syncState.conversations.get(id);
  if (!force && previous && previous.signature === signature) {
    return { status: 'unchanged', count: collected.chunks.length };
  }

  try {
    store.upsertSource({
      source: collected.source,
      chunks: collected.chunks,
      reason: 'conversation_sync',
    });
    syncState.conversations.set(id, {
      signature,
      status: 'ok',
      lastAt: new Date().toISOString(),
      errorCode: null,
    });
    return { status: 'ok', count: collected.chunks.length };
  } catch (error) {
    const code = (error && error.code) || 'conversation_sync_failed';
    syncState.conversations.set(id, {
      signature,
      status: 'failed',
      lastAt: new Date().toISOString(),
      errorCode: code,
    });
    return { status: 'failed', errorCode: code, error: describeError(code) };
  }
}

function syncAllConversations({ force = false } = {}) {
  const list = sessions.listSessions();
  let synced = 0;
  let failed = 0;
  for (const meta of list) {
    const result = syncConversation(meta.id, { force });
    if (result.status === 'failed') failed += 1;
    else if (result.status === 'ok') synced += 1;
  }

  const existing = new Set(list.map(meta => meta.id));
  const keep = new Set();
  for (const source of store.listSources()) {
    if (source.type !== 'conversation') {
      keep.add(source.id);
      continue;
    }
    const sessionId = source.id.slice('conversation:'.length);
    if (existing.has(sessionId)) keep.add(source.id);
  }
  const pruned = store.pruneMissingSources(keep);
  return { scanned: list.length, synced, failed, pruned };
}

async function search(options = {}) {
  if (!config.enabled) {
    return failure('retrieval_disabled', { status: 'disabled', evidence: [], citations: [], trace: null });
  }
  initialize();
  if (initError) {
    return failure('index_unavailable', { status: 'failed', evidence: [], citations: [], trace: null });
  }

  const sessionId =
    typeof options.sessionId === 'string' && options.sessionId.trim()
      ? options.sessionId.trim()
      : null;
  const sources = engine.normalizeSources(options.sources, { sessionId });
  if (sources && sources.error) {
    return failure(sources.error, { status: 'failed', evidence: [], citations: [], trace: null });
  }

  const plan = engine.createPlan({
    query: options.query,
    sessionId,
    sources,
    limit: options.limit || 5,
    tokenBudget: options.tokenBudget || config.limits.tokenBudget,
    asOf: options.asOf || null,
    now: options.now || Date.now(),
    timeoutMs: options.timeoutMs || config.limits.timeoutMs,
    maxQueryChars: config.limits.maxQueryChars,
    maxEvidence: config.limits.maxEvidence,
  });
  if (plan.error) {
    return failure(plan.error, { status: 'failed', evidence: [], citations: [], trace: null });
  }

  const sync = {};
  if (sources.includes('memory')) {
    sync.memory = syncMemory();
  }
  if (sources.includes('conversation') && sessionId) {
    sync.conversation = syncConversation(sessionId);
  }

  let result;
  try {
    result = await engine.executeSearch({ store, embedding, config, plan });
  } catch (error) {
    return failure((error && error.code) || 'retrieval_failed', {
      status: 'failed',
      evidence: [],
      citations: [],
      trace: null,
    });
  }
  if (result.ok && result.trace) {
    result.trace.sync = sync;
    for (const [name, outcome] of Object.entries(sync)) {
      if (outcome.status === 'failed') {
        result.trace.degraded.push(`${name}_sync_failed`);
      } else if (outcome.status === 'disabled') {
        result.trace.degraded.push(`${name}_disabled`);
      }
    }
    result.trace.degraded = [...new Set(result.trace.degraded)];
  }
  return result;
}

async function ingestInternal({ type, inputPath, url, title } = {}) {
  if (!config.enabled) return failure('retrieval_disabled');
  initialize();
  if (initError) return failure('index_unavailable');

  let outcome;
  if (type === 'document') {
    if (!config.allowedRoots.length) return failure('roots_not_configured');
    outcome = await ingestDocument({
      inputPath,
      title,
      roots: config.allowedRoots,
      maxFileBytes: config.limits.maxFileBytes,
      maxChunkChars: config.limits.maxChunkChars,
    });
  } else if (type === 'web') {
    outcome = await ingestWeb({
      url,
      title,
      snapshotsDir: store.snapshotsDir,
      maxBytes: config.limits.maxWebBytes,
      maxSnapshotBytes: config.limits.maxSnapshotBytes,
      maxChunkChars: config.limits.maxChunkChars,
      timeoutMs: 10000,
      allowPrivate: config.allowPrivateUrls,
    });
  } else if (type === 'code') {
    if (!config.allowedRoots.length) return failure('roots_not_configured');
    outcome = await ingestCode({
      inputPath,
      roots: config.allowedRoots,
      maxFileBytes: config.limits.maxFileBytes,
      maxTotalBytes: config.limits.codeMaxTotalBytes,
      maxFiles: config.limits.codeMaxFiles,
      maxChunkChars: config.limits.maxChunkChars,
    });
  } else {
    return failure('invalid_source');
  }

  if (!outcome.ok) {
    return failure(outcome.error || 'ingest_failed', {
      ...(outcome.format ? { format: outcome.format } : {}),
      ...(outcome.status ? { upstreamStatus: outcome.status } : {}),
    });
  }

  try {
    const result = store.upsertSource({
      source: outcome.source,
      chunks: outcome.chunks,
      reason: `${type}_ingest`,
    });
    return {
      ok: true,
      source: result.source || outcome.source,
      changed: result.changed,
      added: result.added,
      removed: result.removed,
      chunks: outcome.chunks.length,
      ...(outcome.stats ? { stats: outcome.stats } : {}),
      ...(outcome.truncated !== undefined ? { truncated: outcome.truncated } : {}),
    };
  } catch (error) {
    return failure((error && error.code) || 'ingest_failed');
  }
}

function ingest(options) {
  return enqueueMutation(() => ingestInternal(options));
}

function removeSourceInternal(sourceId) {
  if (!config.enabled) return failure('retrieval_disabled');
  initialize();
  if (initError) return failure('index_unavailable');

  const id = typeof sourceId === 'string' ? sourceId.trim() : '';
  const source = store.getSource(id);
  if (!source) return failure('source_not_found');
  if (source.type === 'memory' || source.type === 'conversation') {
    return failure('managed_source');
  }

  const result = store.deleteSource(id);
  if (source.type === 'web' && source.metadata && source.metadata.snapshotFile) {
    const file = path.join(
      store.snapshotsDir,
      path.basename(String(source.metadata.snapshotFile))
    );
    try {
      fs.unlinkSync(file);
    } catch (_) {
      // 快照可能已不存在；索引删除成功不因派生文件清理失败而回滚
    }
  }
  return { ok: true, removed: result.removed, chunks: result.chunks, sourceId: id };
}

function removeSource(sourceId) {
  return enqueueMutation(() => removeSourceInternal(sourceId));
}

function findRootByHash(rootHash) {
  if (!rootHash) return null;
  for (const root of config.allowedRoots) {
    try {
      if (sha256(fs.realpathSync(root)).slice(0, 16) === rootHash) return root;
    } catch (_) {
      // root may have been removed; try next
    }
  }
  return null;
}

async function refreshSourceInternal(sourceId, { url } = {}) {
  if (!config.enabled) return failure('retrieval_disabled');
  initialize();
  if (initError) return failure('index_unavailable');

  const id = typeof sourceId === 'string' ? sourceId.trim() : '';
  const source = store.getSource(id);
  if (!source) return failure('source_not_found');
  if (source.type === 'memory' || source.type === 'conversation') {
    return failure('managed_source');
  }

  if (source.type === 'web') {
    if (typeof url !== 'string' || !url.trim()) {
      return failure('refresh_url_required');
    }
    const outcome = await ingestWeb({
      url,
      title: source.title,
      snapshotsDir: store.snapshotsDir,
      maxBytes: config.limits.maxWebBytes,
      maxSnapshotBytes: config.limits.maxSnapshotBytes,
      maxChunkChars: config.limits.maxChunkChars,
      timeoutMs: 10000,
      allowPrivate: config.allowPrivateUrls,
    });
    if (!outcome.ok) {
      return failure(outcome.error || 'ingest_failed', {
        ...(outcome.status ? { upstreamStatus: outcome.status } : {}),
      });
    }
    if (outcome.source.id !== id) return failure('url_mismatch');
    const result = store.upsertSource({
      source: outcome.source,
      chunks: outcome.chunks,
      reason: 'web_refresh',
    });
    return {
      ok: true,
      action: 'updated',
      sourceId: id,
      source: result.source || outcome.source,
      chunks: outcome.chunks.length,
      changed: result.changed,
    };
  }

  if (source.type !== 'document' && source.type !== 'code') {
    return failure('source_type_not_refreshable');
  }

  const metadata = source.metadata || {};
  const root = findRootByHash(metadata.rootHash);
  if (!root) return failure('source_root_missing');

  if (source.type === 'document') {
    if (typeof metadata.relativePath !== 'string' || !metadata.relativePath) {
      return failure('source_root_missing');
    }
    let realRoot;
    try {
      realRoot = fs.realpathSync(root);
    } catch (_) {
      return failure('source_root_missing');
    }
    const full = path.resolve(realRoot, metadata.relativePath);
    if (!isInside(realRoot, full)) return failure('path_outside_allowed_roots');
    if (!fs.existsSync(full)) {
      const removed = store.deleteSource(id);
      return {
        ok: true,
        action: 'deleted',
        reason: 'source_missing',
        sourceId: id,
        removed: removed.removed,
        chunks: removed.chunks,
      };
    }
    const outcome = await ingestDocument({
      inputPath: full,
      title: source.title,
      roots: [root],
      maxFileBytes: config.limits.maxFileBytes,
      maxChunkChars: config.limits.maxChunkChars,
    });
    if (!outcome.ok) {
      if (outcome.error === 'path_not_found') {
        const removed = store.deleteSource(id);
        return {
          ok: true,
          action: 'deleted',
          reason: 'source_missing',
          sourceId: id,
          removed: removed.removed,
          chunks: removed.chunks,
        };
      }
      return failure(outcome.error || 'ingest_failed', {
        ...(outcome.format ? { format: outcome.format } : {}),
      });
    }
    const result = store.upsertSource({
      source: outcome.source,
      chunks: outcome.chunks,
      reason: 'document_refresh',
    });
    return {
      ok: true,
      action: 'updated',
      sourceId: id,
      source: result.source || outcome.source,
      chunks: outcome.chunks.length,
      changed: result.changed,
    };
  }

  if (!fs.existsSync(root)) {
    const removed = store.deleteSource(id);
    return {
      ok: true,
      action: 'deleted',
      reason: 'source_missing',
      sourceId: id,
      removed: removed.removed,
      chunks: removed.chunks,
    };
  }
  const outcome = await ingestCode({
    inputPath: root,
    roots: [root],
    maxFileBytes: config.limits.maxFileBytes,
    maxTotalBytes: config.limits.codeMaxTotalBytes,
    maxFiles: config.limits.codeMaxFiles,
    maxChunkChars: config.limits.maxChunkChars,
  });
  if (!outcome.ok) {
    if (outcome.error === 'path_not_found') {
      const removed = store.deleteSource(id);
      return {
        ok: true,
        action: 'deleted',
        reason: 'source_missing',
        sourceId: id,
        removed: removed.removed,
        chunks: removed.chunks,
      };
    }
    return failure(outcome.error || 'ingest_failed');
  }
  const result = store.upsertSource({
    source: outcome.source,
    chunks: outcome.chunks,
    reason: 'code_refresh',
  });
  return {
    ok: true,
    action: 'updated',
    sourceId: id,
    source: result.source || outcome.source,
    chunks: outcome.chunks.length,
    changed: result.changed,
  };
}

async function refreshAllExternalInternal() {
  if (!config.enabled) return failure('retrieval_disabled');
  initialize();
  if (initError) return failure('index_unavailable');

  const sources = store.listSources().filter(source =>
    ['document', 'web', 'code'].includes(source.type)
  );
  const results = [];
  let refreshed = 0;
  let deleted = 0;
  let skipped = 0;
  let failed = 0;

  for (const source of sources) {
    if (source.type === 'web') {
      skipped += 1;
      results.push({
        sourceId: source.id,
        type: source.type,
        status: 'skipped',
        reason: 'refresh_url_required',
      });
      continue;
    }
    const outcome = await refreshSourceInternal(source.id);
    if (outcome.ok) {
      if (outcome.action === 'deleted') deleted += 1;
      else refreshed += 1;
      results.push({
        sourceId: source.id,
        type: source.type,
        status: outcome.action,
      });
    } else {
      failed += 1;
      results.push({
        sourceId: source.id,
        type: source.type,
        status: 'failed',
        errorCode: outcome.errorCode,
      });
    }
  }

  return {
    ok: true,
    status: failed ? 'partial_success' : 'success',
    scanned: sources.length,
    refreshed,
    deleted,
    skipped,
    failed,
    results,
  };
}

function refreshSource(sourceId, options) {
  return enqueueMutation(() => refreshSourceInternal(sourceId, options));
}

function refreshAllExternal() {
  return enqueueMutation(() => refreshAllExternalInternal());
}

async function rebuildVectors() {
  const stats = embedding.stats();
  if (!stats.available) {
    return {
      status: 'unavailable',
      reason: stats.reason || 'embedding_unavailable',
      count: 0,
    };
  }

  const all = store.allChunks();
  if (!all.length) {
    return { status: 'no_result', count: 0 };
  }

  const target = all.slice(0, config.limits.maxVectorChunks);
  const embedded = await embedding.embedDocuments(target.map(chunk => chunk.content));
  if (!embedded.ok) {
    return {
      status: 'failed',
      errorCode: embedded.errorCode || 'embedding_failed',
      count: 0,
    };
  }

  store.replaceVectors({
    model: stats.model,
    version: stats.version,
    dimension: stats.dimension,
    entries: target.map((chunk, index) => ({
      chunkId: chunk.chunkId,
      vector: embedded.vectors[index],
    })),
  });

  return {
    status: 'ok',
    count: target.length,
    truncated: target.length < all.length,
    model: stats.model,
    version: stats.version,
    dimension: stats.dimension,
  };
}

async function rebuildInternal({ syncSources = true, vectors = true } = {}) {
  if (!config.enabled) return failure('retrieval_disabled');
  initialize();

  const sync = {};
  if (syncSources) {
    sync.memory = syncMemory({ force: true });
    sync.conversations = syncAllConversations({ force: true });
  }

  let vector = { status: 'skipped' };
  if (vectors) {
    try {
      vector = await rebuildVectors();
    } catch (error) {
      vector = {
        status: 'failed',
        errorCode: (error && error.code) || 'vector_rebuild_failed',
        count: 0,
      };
    }
  }
  syncState.lastRebuildAt = new Date().toISOString();

  return {
    ok: true,
    sync,
    vector,
    status: vector.status === 'failed' ? 'partial_success' : 'success',
  };
}

function rebuild(options) {
  return enqueueMutation(() => rebuildInternal(options));
}

function getStatus() {
  if (!config.enabled) {
    return {
      ok: true,
      enabled: false,
      state: 'disabled',
      embedding: embedding.stats(),
      limits: publicLimits(),
      capabilities: publicCapabilities(),
    };
  }
  if (!initialized) initialize();

  let stats;
  try {
    stats = store.stats();
  } catch (error) {
    return {
      ok: false,
      enabled: true,
      state: 'degraded',
      errorCode: (error && error.code) || 'index_unavailable',
      error: describeError('index_unavailable'),
      embedding: embedding.stats(),
      limits: publicLimits(),
      capabilities: publicCapabilities(),
    };
  }

  return {
    ok: true,
    enabled: true,
    state: stats.status === 'quarantined' ? 'degraded' : 'ready',
    counts: {
      chunks: stats.chunks,
      sources: stats.sources,
      vectors: stats.vectors,
      sourcesByType: stats.sourcesByType,
    },
    storage: {
      fileBytes: stats.bytes,
      generation: stats.generation,
      updatedAt: stats.updatedAt,
      loadStatus: stats.status,
      quarantined: stats.loadInfo.quarantined,
      skippedChunks: stats.loadInfo.skippedChunks,
      skippedSources: stats.loadInfo.skippedSources,
      reason: stats.loadInfo.reason,
    },
    lexical: stats.lexical,
    vector: stats.vectorMeta,
    embedding: embedding.stats(),
    sync: {
      memory: syncState.memory,
      conversations: syncState.conversations.size,
      lastRebuildAt: syncState.lastRebuildAt,
    },
    consistency: store.consistency(),
    limits: publicLimits(),
    capabilities: publicCapabilities(),
  };
}

function getSources() {
  if (!config.enabled) return { ok: true, enabled: false, sources: [] };
  initialize();
  return {
    ok: true,
    enabled: true,
    sources: store.listSources().map(source => ({
      id: source.id,
      type: source.type,
      title: source.title,
      uri: source.uri,
      state: source.state,
      sourceVersion: source.sourceVersion,
      chunkCount: source.chunkCount,
      createdAt: source.createdAt,
      updatedAt: source.updatedAt,
      indexedAt: source.indexedAt,
      metadata: source.metadata,
    })),
  };
}

function getSource(sourceId) {
  if (!config.enabled) return null;
  initialize();
  return store.getSource(sourceId);
}

function checkConsistency() {
  if (!config.enabled) return { ok: true, enabled: false, issues: [] };
  initialize();
  return { ok: true, enabled: true, ...store.consistency() };
}

function publicLimits() {
  return {
    maxChunks: config.limits.maxChunks,
    maxSources: config.limits.maxSources,
    maxChunkChars: config.limits.maxChunkChars,
    maxFileBytes: config.limits.maxFileBytes,
    maxWebBytes: config.limits.maxWebBytes,
    maxQueryChars: config.limits.maxQueryChars,
    maxEvidence: config.limits.maxEvidence,
    tokenBudget: config.limits.tokenBudget,
    maxVectorChunks: config.limits.maxVectorChunks,
  };
}

function publicCapabilities() {
  const embeddingStats = embedding.stats();
  return {
    lexical: true,
    exact: true,
    vector: embeddingStats.available,
    vectorReason: embeddingStats.reason,
    reranker: false,
    queryRewrite: false,
    asOfValidityFilter: true,
    historicalMemory: false,
    scope: {
      mode: 'single_user',
      globalSources: ['document', 'web', 'code'],
      sessionScoped: ['memory', 'conversation'],
      note: '单用户部署下外部知识全局可检索；多用户部署必须新增真实 ACL',
    },
    formats: {
      document: ['.md', '.markdown', '.txt', '.text'],
      documentUnsupported: ['.pdf', '.doc', '.docx', '.rtf', '.odt'],
      web: ['text/html', 'text/plain', 'text/markdown', 'application/json'],
      code: 'heuristic_symbols',
    },
    notes: [
      'PDF/DOCX 未接入解析运行时，明确不支持而不是伪装成功',
      '代码符号为轻量启发式解析，不是完整 AST',
      '未配置 Embedding Provider 时向量通道不可用，词法/精确照常工作',
      '网页抓取存在 DNS 解析与连接之间的 TOCTOU 风险（已知限制）',
    ],
  };
}

async function searchForContext({ query, sessionId, now = Date.now() } = {}) {
  if (!config.enabled || !config.contextEnabled) {
    return { status: 'disabled', count: 0, items: [], trace: null };
  }
  initialize();
  if (initError) {
    return {
      status: 'error',
      count: 0,
      items: [],
      trace: null,
      errorCode: 'index_unavailable',
      error: describeError('index_unavailable'),
    };
  }

  const current = store.stats();
  if (current.status === 'quarantined') {
    return {
      status: 'error',
      count: 0,
      items: [],
      trace: null,
      errorCode: 'index_unavailable',
      error: describeError('index_unavailable'),
    };
  }
  const hasContextSource = config.contextSources.some(
    type => (current.sourcesByType[type] || 0) > 0
  );
  if (!hasContextSource) {
    return { status: 'no_result', count: 0, items: [], trace: null, degraded: [] };
  }

  const result = await search({
    query,
    sessionId,
    sources: config.contextSources,
    limit: config.limits.contextMaxItems,
    tokenBudget: config.limits.contextTokenBudget,
    timeoutMs: config.limits.contextTimeoutMs,
    now,
  });

  if (!result.ok) {
    return {
      status: 'error',
      count: 0,
      items: [],
      trace: result.trace || null,
      errorCode: result.errorCode,
      error: result.error,
    };
  }

  const items = result.evidence.map(evidence => ({
    id: evidence.chunkId,
    source: 'knowledge',
    type: 'knowledge',
    content: evidence.content,
    title: evidence.title,
    uri: evidence.uri,
    locator: evidence.locator,
    citation: `[${evidence.citation.label}] ${evidence.title}（${evidence.locator}）`,
    sourceType: evidence.sourceType,
    authority: evidence.signals.authority,
    confidence: evidence.signals.confidence,
    version: evidence.signals.sourceVersion,
    commit: evidence.signals.commit,
    freshness: {
      status: evidence.signals.freshness.status,
      fetched_at: evidence.signals.freshness.at,
      label:
        evidence.signals.freshness.status === 'stale'
          ? '可能过时'
          : evidence.signals.freshness.status === 'unknown'
            ? '时效未知'
            : 'fresh',
    },
    relevance: evidence.scores.retrieval,
  }));

  return {
    status: items.length ? 'ok' : 'no_result',
    count: items.length,
    items,
    trace: result.trace,
    degraded: result.degraded,
  };
}

module.exports = {
  config,
  initialize,
  search,
  searchForContext,
  ingest,
  removeSource,
  refreshSource,
  refreshAllExternal,
  rebuild,
  getStatus,
  getSources,
  getSource,
  checkConsistency,
  describeError,
  store,
  embedding,
};
