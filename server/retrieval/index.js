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
const { createRerankerProvider } = require('./reranker');
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
const reranker = createRerankerProvider(config.reranker);

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

function withDeadline(promise, deadline, errorCode) {
  const remaining = deadline - Date.now();
  if (remaining <= 0) {
    const error = new Error(errorCode);
    error.code = errorCode;
    return Promise.reject(error);
  }
  let timer = null;
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(() => {
      const error = new Error(errorCode);
      error.code = errorCode;
      reject(error);
    }, remaining);
  });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}

const ERROR_MESSAGES = Object.freeze({
  query_required: '检索内容不能为空',
  query_too_long: `检索内容超过 ${config.limits.maxQueryChars} 字上限`,
  sources_empty: '没有可检索的来源',
  invalid_source: '来源类型非法',
  invalid_purpose: 'purpose 非法（chat_context/agent_tool/api_search）',
  invalid_category: 'categories 非法（memory/conversation/knowledge/document/web/code）',
  invalid_token_budget: 'tokenBudget 必须是正数',
  invalid_limit: 'limit 必须是正整数',
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

  // 可信用户身份：长期记忆 chunk 的 scope 是 visibility='user'，必须用 userId 匹配。
  const userId =
    typeof options.userId === 'string' && options.userId.trim()
      ? options.userId.trim()
      : null;

  // purpose / categories / tokenBudget 是查询契约的显式字段：
  // purpose 进入 plan 与 trace；categories 映射到 sourceType 并与 sources 取交集；
  // tokenBudget 由 createPlan 做正数/上限归一，非法值不静默吞掉。
  const purpose = engine.normalizePurpose(options.purpose);
  if (typeof purpose !== 'string') {
    return failure(purpose.error, { status: 'failed', evidence: [], citations: [], trace: null });
  }
  const categoryPlan = engine.normalizeCategories(options.categories);
  if (categoryPlan && categoryPlan.error) {
    return failure(categoryPlan.error, { status: 'failed', evidence: [], citations: [], trace: null });
  }

  let sources = engine.normalizeSources(options.sources, { sessionId });
  if (sources && sources.error) {
    return failure(sources.error, { status: 'failed', evidence: [], citations: [], trace: null });
  }
  if (categoryPlan) {
    const allowed = new Set(categoryPlan.sources);
    sources = sources.filter(source => allowed.has(source));
    if (!sources.length) {
      return failure('sources_empty', { status: 'failed', evidence: [], citations: [], trace: null });
    }
  }

  const plan = engine.createPlan({
    query: options.query,
    sessionId,
    userId,
    sources,
    limit: options.limit || 5,
    tokenBudget: options.tokenBudget || config.limits.tokenBudget,
    asOf: options.asOf || null,
    now: options.now || Date.now(),
    timeoutMs: options.timeoutMs || config.limits.timeoutMs,
    maxQueryChars: config.limits.maxQueryChars,
    maxEvidence: config.limits.maxEvidence,
    purpose,
    categories: categoryPlan ? categoryPlan.names : [],
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

  // 向量补齐必须服从本次检索 deadline：它是派生数据的增量维护，
  // 不能因为一次 embedding 往返把聊天/工具调用拖过预算。
  let vectorSync = null;
  if (plan.deadline - Date.now() <= 20) {
    vectorSync = {
      status: 'timeout',
      reason: 'retrieval_deadline',
      errorCode: 'deadline',
      count: 0,
    };
  } else {
    try {
      vectorSync = await withDeadline(
        ensureVectorCoverage({ reason: 'search' }),
        plan.deadline,
        'vector_sync_deadline'
      );
    } catch (error) {
      const code =
        (error && error.code) || error && error.name || 'vector_sync_failed';
      vectorSync = {
        status: code === 'vector_sync_deadline' ? 'timeout' : 'failed',
        errorCode: code === 'vector_sync_deadline' ? 'deadline' : code,
        count: 0,
      };
    }
  }

  // 时间预算由 engine 内部逐通道执行（vector 补齐、embedding、rerank 都
  // 以 plan.deadline 为上限，各自超时后标记降级并继续返回部分结果）。
  // 这里不再套整体 Promise.race：词法/精确是同步扫描无法被抢占，
  // 而竞速在 deadline 到达时会丢掉已完成的降级结果，把 partial_success
  // 误报成整体失败。外层 try/catch 仍保留：引擎出现未预期抛出时统一归一为
  // retrieval_failed，而不是让异常逃逸到路由或对话主链路。
  let result;
  try {
    result = await engine.executeSearch({
      store,
      embedding,
      reranker,
      config,
      plan,
    });
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
    result.trace.vectorSync = vectorSync;
    for (const [name, outcome] of Object.entries(sync)) {
      if (outcome.status === 'failed') {
        result.trace.degraded.push(`${name}_sync_failed`);
      } else if (outcome.status === 'disabled') {
        result.trace.degraded.push(`${name}_disabled`);
      }
    }
    if (vectorSync && vectorSync.status === 'failed') {
      result.trace.degraded.push(
        `vector_sync_${vectorSync.errorCode || 'failed'}`
      );
    } else if (vectorSync && vectorSync.status === 'timeout') {
      result.trace.degraded.push(
        `vector_sync_${vectorSync.errorCode || 'timeout'}`
      );
    } else if (vectorSync && vectorSync.truncated) {
      result.trace.degraded.push('vector_sync_truncated');
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
      vector: await safeEnsureVectorCoverage(`${type}_ingest`),
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
      vector: await safeEnsureVectorCoverage('web_refresh'),
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
      vector: await safeEnsureVectorCoverage('document_refresh'),
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
    vector: await safeEnsureVectorCoverage('code_refresh'),
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
    vector: await safeEnsureVectorCoverage('external_refresh'),
  };
}

function refreshSource(sourceId, options) {
  return enqueueMutation(() => refreshSourceInternal(sourceId, options));
}

function refreshAllExternal() {
  return enqueueMutation(() => refreshAllExternalInternal());
}

async function ensureVectorCoverage({ reason = 'incremental' } = {}) {
  const stats = embedding.stats();

  if (!stats.available) {
    return {
      status: 'unavailable',
      reason: stats.reason || 'embedding_unavailable',
      count: 0,
    };
  }

  const maxVectors = Number(config.limits.maxVectorChunks) || 0;
  if (maxVectors <= 0) {
    return { status: 'disabled', reason: 'vector_limit_zero', count: 0 };
  }

  const all = store.allChunks();
  if (!all.length) {
    return { status: 'no_result', count: 0, total: 0 };
  }

  const meta = store.vectorMeta();
  const metaMatches =
    meta.model === stats.model &&
    meta.version === stats.version &&
    meta.dimension === stats.dimension;
  const missing = all.filter(
    chunk => !metaMatches || !store.getVector(chunk.chunkId)
  );

  if (!missing.length) {
    return {
      status: 'unchanged',
      count: 0,
      total: all.length,
      embedded: metaMatches ? meta.count : 0,
      model: stats.model,
      version: stats.version,
      dimension: stats.dimension,
    };
  }

  // 元数据失配时旧向量会在 mergeVectors 中整体作废，容量从 0 重新计算；
  // 元数据一致时只补剩余容量，避免把“容量已满”误报成覆盖完整。
  const capacity = metaMatches
    ? Math.max(0, maxVectors - meta.count)
    : maxVectors;
  const target = missing.slice(0, capacity);

  if (!target.length) {
    return {
      status: 'ok',
      reason,
      count: 0,
      total: all.length,
      embedded: metaMatches ? meta.count : 0,
      missing: missing.length,
      truncated: true,
      reset: false,
      model: stats.model,
      version: stats.version,
      dimension: stats.dimension,
    };
  }

  let embedded;

  try {
    embedded = await embedding.embedDocuments(target.map(chunk => chunk.content));
  } catch (error) {
    return {
      status: 'failed',
      errorCode:
        (error && error.code) || error && error.name || 'embedding_failed',
      count: 0,
      total: all.length,
      missing: missing.length,
    };
  }

  if (!embedded.ok) {
    return {
      status: 'failed',
      errorCode: embedded.errorCode || 'embedding_failed',
      count: 0,
      total: all.length,
      missing: missing.length,
    };
  }

  try {
    const merged = store.mergeVectors({
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
      reason,
      count: target.length,
      total: all.length,
      embedded: merged.count,
      missing: Math.max(0, missing.length - target.length),
      truncated: target.length < missing.length,
      reset: merged.reset,
      model: stats.model,
      version: stats.version,
      dimension: stats.dimension,
    };
  } catch (error) {
    return {
      status: 'failed',
      errorCode:
        (error && error.code) || error && error.name || 'vector_store_failed',
      count: 0,
      total: all.length,
      missing: missing.length,
    };
  }
}

async function safeEnsureVectorCoverage(reason) {
  try {
    return await ensureVectorCoverage({ reason });
  } catch (error) {
    return {
      status: 'failed',
      errorCode:
        (error && error.code) || error && error.name || 'vector_sync_failed',
      count: 0,
    };
  }
}

function backfillVectors() {
  return enqueueMutation(() => ensureVectorCoverage({ reason: 'backfill' }));
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

  const embeddingStats = embedding.stats();
  const vectorCurrent =
    embeddingStats.available === true &&
    stats.vectorMeta.model === embeddingStats.model &&
    stats.vectorMeta.version === embeddingStats.version &&
    stats.vectorMeta.dimension === embeddingStats.dimension;
  const vectorCoverage = {
    total: stats.chunks,
    embedded: vectorCurrent ? stats.vectors : 0,
    missing: vectorCurrent
      ? Math.max(0, stats.chunks - stats.vectors)
      : stats.chunks,
    current: vectorCurrent,
  };

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
    vectorCoverage,
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
    reranker: reranker.stats(),
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
    reranker: reranker.available,
    signalRerank: config.rerank.enabled,
    queryRewrite: false,
    asOfValidityFilter: true,
    historicalMemory: false,
    scope: {
      mode: 'single_user',
      globalSources: ['document', 'web', 'code'],
      // 长期记忆是用户级（P1）：同一用户的任意会话都可检索，按服务端可信 userId 过滤。
      userScoped: ['memory'],
      // 原始对话消息仍按会话隔离，不随用户级读放开。
      sessionScoped: ['conversation'],
      note: '记忆按可信 userId 跨会话共享，对话消息仍按会话隔离；多用户部署必须新增真实 ACL',
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
      '网页抓取在 DNS 解析后校验全部地址并把已校验地址固定给本次连接（每跳重定向重新解析、重新校验、重新固定），DNS 重绑定窗口已消除；仅取首个通过校验的地址，未实现多地址故障切换',
    ],
  };
}

async function searchForContext({
  query,
  sessionId,
  userId = null,
  now = Date.now(),
  sources = null,
  limit = null,
  tokenBudget = null,
  timeoutMs = null,
} = {}) {
  if (!config.enabled || !config.contextEnabled) {
    return { status: 'disabled', count: 0, items: [], trace: null };
  }

  const contextSources = Array.isArray(sources)
    ? sources.filter(source =>
        ['document', 'web', 'code'].includes(source)
      )
    : config.contextSources;

  if (!contextSources.length) {
    return { status: 'no_result', count: 0, items: [], trace: null };
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
  const hasContextSource = contextSources.some(
    type => (current.sourcesByType[type] || 0) > 0
  );
  if (!hasContextSource) {
    return { status: 'no_result', count: 0, items: [], trace: null, degraded: [] };
  }

  const result = await search({
    query,
    sessionId,
    userId,
    sources: contextSources,
    purpose: 'chat_context',
    categories: ['knowledge'],
    limit: Number.isFinite(limit)
      ? Math.min(Math.max(Math.floor(limit), 1), 10)
      : config.limits.contextMaxItems,
    tokenBudget: Number.isFinite(tokenBudget)
      ? Math.min(Math.max(Math.floor(tokenBudget), 100), 4000)
      : config.limits.contextTokenBudget,
    timeoutMs: Number.isFinite(timeoutMs)
      ? Math.min(Math.max(Math.floor(timeoutMs), 100), 8000)
      : config.limits.contextTimeoutMs,
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

// 会话已删除时立即移除派生索引；不等下一次 search/rebuild 才发现来源缺失。
// 失败只返回结构化错误，不抛异常——会话数据已经删除，派生索引可重建。
function cleanupConversationIndex(sessionId) {
  if (!config.enabled) {
    return { ok: true, status: 'disabled', removed: false, chunks: 0 };
  }
  const id = typeof sessionId === 'string' ? sessionId.trim() : '';
  if (!id) return { ok: false, status: 'invalid', errorCode: 'session_required' };

  initialize();
  if (initError) {
    return { ok: false, status: 'failed', errorCode: 'index_unavailable' };
  }

  const sourceId = `conversation:${id}`;
  const result = store.deleteSource(sourceId);
  syncState.conversations.delete(id);
  return {
    ok: true,
    status: result.removed ? 'ok' : 'unchanged',
    sourceId,
    removed: result.removed,
    chunks: result.chunks,
  };
}

// 记忆删除/归档/撤回后重建记忆派生来源：removed entries 的来源和向量被清掉，
// 仍存在但贡献变化的条目会刷新 scope，避免已删会话继续检索到旧记忆。
function cleanupMemoryIndex() {
  if (!config.enabled) {
    return { ok: true, status: 'disabled', count: 0 };
  }
  initialize();
  if (initError) {
    return { ok: false, status: 'failed', errorCode: 'index_unavailable' };
  }
  const result = syncMemory({ force: true });
  return { ok: result.status !== 'failed', ...result };
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
  backfillVectors,
  getStatus,
  getSources,
  getSource,
  cleanupConversationIndex,
  cleanupMemoryIndex,
  checkConsistency,
  describeError,
  store,
  embedding,
  reranker,
};
