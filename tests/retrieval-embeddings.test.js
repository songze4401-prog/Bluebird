/* global __dirname */
/**
 * 云岫 Bluebird — 神经向量 / 重排确定性测试（retrieval-embeddings.test.js）
 *
 * 使用真实 HTTP 的本地 stub 服务（不是 in-process mock 函数）验证：
 *   - query/document 前缀原样发送；
 *   - 向量元数据（模型/版本/维度）变化时整批重置，绝不混用；
 *   - 批量回填、增量补齐、无变化时不重复请求、索引落盘可重载；
 *   - 神经 reranker 的请求契约、失败回退与引擎重排顺序。
 * 真实模型 API 的验收结论由 tests/embedding-open-domain-eval.js 提供。
 */
const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');
const test = require('node:test');
const assert = require('node:assert');

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'bluebird-retrieval-embeddings-'));
const FIXTURE_ROOT = path.join(TMP, 'fixtures');
fs.mkdirSync(path.join(FIXTURE_ROOT, 'docs'), { recursive: true });
fs.writeFileSync(
  path.join(FIXTURE_ROOT, 'docs', 'alpha.md'),
  '# Alpha\n\nALPHA-UNIQUE 开放域语言模型资料。\n',
  'utf8'
);
fs.writeFileSync(
  path.join(FIXTURE_ROOT, 'docs', 'beta.md'),
  '# Beta\n\nBETA-UNIQUE NEURAL-WIN 跨语言检索资料。\n',
  'utf8'
);

const embeddingLog = [];
const rerankLog = [];

function vectorFor(text) {
  const vector = [0, 0, 0, 0, 0, 0, 0, 0];
  if (text.startsWith('query:')) {
    for (let i = 0; i < vector.length; i += 1) vector[i] = 0.5;
    return vector;
  }
  if (text.includes('NEURAL-WIN')) vector[0] = 1;
  else if (text.includes('ALPHA-UNIQUE')) vector[1] = 1;
  else if (text.includes('BETA-UNIQUE')) vector[2] = 1;
  else if (text.includes('alpha')) vector[3] = 1;
  else if (text.includes('beta')) vector[4] = 1;
  else vector[5] = 1;
  return vector;
}

function jsonResponse(res, status, payload) {
  res.writeHead(status, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify(payload));
}

const embeddingServer = http.createServer((req, res) => {
  let body = '';
  req.on('data', chunk => {
    body += chunk;
  });
  req.on('end', () => {
    if (req.url.startsWith('/broken/')) {
      jsonResponse(res, 500, { error: 'embedding_upstream_failed' });
      return;
    }
    let parsed;
    try {
      parsed = JSON.parse(body);
    } catch (_) {
      jsonResponse(res, 400, { error: 'bad_json' });
      return;
    }
    const inputs = Array.isArray(parsed.input) ? parsed.input : [parsed.input];
    embeddingLog.push(inputs.slice());
    jsonResponse(res, 200, {
      data: inputs.map(text => ({ embedding: vectorFor(String(text)) })),
      usage: { prompt_tokens: inputs.length, total_tokens: inputs.length },
    });
  });
});

const rerankServer = http.createServer((req, res) => {
  let body = '';
  req.on('data', chunk => {
    body += chunk;
  });
  req.on('end', () => {
    let parsed;
    try {
      parsed = JSON.parse(body);
    } catch (_) {
      jsonResponse(res, 400, { error: 'bad_json' });
      return;
    }
    rerankLog.push({ url: req.url, body: parsed });
    if (req.url.startsWith('/fail/')) {
      jsonResponse(res, 500, { error: 'upstream_failed' });
      return;
    }
    const documents = Array.isArray(parsed.documents) ? parsed.documents : [];
    if (req.url.startsWith('/partial/')) {
      jsonResponse(res, 200, {
        results: [{ index: 0, relevance_score: 0.9 }],
        meta: { billed_units: { search_units: 1 } },
      });
      return;
    }
    jsonResponse(res, 200, {
      results: documents.map((document, index) => ({
        index,
        relevance_score: String(document).includes('NEURAL-WIN') ? 0.99 : 0.01,
      })),
      meta: { billed_units: { search_units: 1 } },
    });
  });
});

let retrieval;
let config;
let engine;
let storeModule;
let contract;
let embeddingModule;
let rerankerModule;
let embeddingPort = 0;
let rerankPort = 0;

test.before(async () => {
  await new Promise(resolve => embeddingServer.listen(0, '127.0.0.1', resolve));
  await new Promise(resolve => rerankServer.listen(0, '127.0.0.1', resolve));
  embeddingPort = embeddingServer.address().port;
  rerankPort = rerankServer.address().port;

  process.env.BLUEBIRD_DATA_DIR = TMP;
  process.env.BLUEBIRD_RETRIEVAL = '1';
  process.env.BLUEBIRD_RETRIEVAL_ALLOW_PRIVATE_URL = '1';
  process.env.BLUEBIRD_RETRIEVAL_ROOTS = FIXTURE_ROOT;
  process.env.MEMORY_ENABLED = 'true';
  process.env.DEEPSEEK_API_KEY = '';
  process.env.BLUEBIRD_AGENT_TOOLS = '';

  process.env.BLUEBIRD_RETRIEVAL_EMBEDDING_PROVIDER = 'openai-compatible';
  process.env.BLUEBIRD_RETRIEVAL_EMBEDDING_BASE_URL = `http://127.0.0.1:${embeddingPort}/v1`;
  process.env.BLUEBIRD_RETRIEVAL_EMBEDDING_MODEL = 'stub-embed';
  process.env.BLUEBIRD_RETRIEVAL_EMBEDDING_VERSION = 'v1';
  process.env.BLUEBIRD_RETRIEVAL_EMBEDDING_DIMENSION = '8';
  process.env.BLUEBIRD_RETRIEVAL_EMBEDDING_BATCH = '16';
  process.env.BLUEBIRD_RETRIEVAL_EMBEDDING_TIMEOUT_MS = '2000';
  process.env.BLUEBIRD_RETRIEVAL_EMBEDDING_CACHE_MAX = '0';
  process.env.BLUEBIRD_RETRIEVAL_EMBEDDING_QUERY_PREFIX = 'query: ';
  process.env.BLUEBIRD_RETRIEVAL_EMBEDDING_DOCUMENT_PREFIX = 'passage: ';

  process.env.BLUEBIRD_RETRIEVAL_RERANKER_PROVIDER = 'http';
  process.env.BLUEBIRD_RETRIEVAL_RERANKER_BASE_URL = `http://127.0.0.1:${rerankPort}/v1`;
  process.env.BLUEBIRD_RETRIEVAL_RERANKER_MODEL = 'stub-reranker';
  process.env.BLUEBIRD_RETRIEVAL_RERANKER_VERSION = 'v1';
  process.env.BLUEBIRD_RETRIEVAL_RERANKER_TIMEOUT_MS = '2000';
  process.env.BLUEBIRD_RETRIEVAL_RERANKER_TOP_N = '10';

  retrieval = require('../server/retrieval');
  config = require('../server/retrieval/config').config;
  engine = require('../server/retrieval/engine');
  storeModule = require('../server/retrieval/store');
  contract = require('../server/retrieval/contract');
  embeddingModule = require('../server/retrieval/embedding');
  rerankerModule = require('../server/retrieval/reranker');
  retrieval.initialize();
});

test.after(async () => {
  await new Promise(resolve => embeddingServer.close(resolve));
  await new Promise(resolve => rerankServer.close(resolve));
  try {
    fs.rmSync(TMP, { recursive: true, force: true });
  } catch (_) {
    // 清理失败不影响测试结论
  }
});

test('Embedding 前缀：文档发送 passage，查询发送 query，空白原样保留', async () => {
  assert.equal(retrieval.embedding.available, true);
  assert.equal(retrieval.embedding.model, 'stub-embed');
  assert.equal(retrieval.embedding.dimension, 8);

  const before = embeddingLog.length;
  const documents = await retrieval.embedding.embedDocuments(['PREFIX-DOC']);
  assert.equal(documents.ok, true);
  assert.equal(documents.vectors.length, 1);
  const query = await retrieval.embedding.embedQuery('PREFIX-QUERY');
  assert.equal(query.ok, true);

  const sent = embeddingLog.slice(before).flat();
  assert.ok(sent.includes('passage: PREFIX-DOC'));
  assert.ok(sent.includes('query: PREFIX-QUERY'));
});

test('mergeVectors：同元数据只补缺失，模型/版本/维度变化整批重置', () => {
  const dir = path.join(TMP, 'merge-store');
  const store = storeModule.createStore({
    ...config,
    dataDir: dir,
    snapshotsDir: path.join(dir, 'snapshots'),
  });
  const source = {
    id: 'document:merge',
    type: 'document',
    title: 'merge',
    uri: 'document://merge',
    state: 'indexed',
    sourceVersion: 'v1',
    contentHash: 'merge',
    metadata: {},
  };
  const chunks = ['MERGE-ONE', 'MERGE-TWO'].map((content, index) =>
    contract.createChunk({
      sourceType: 'document',
      sourceId: source.id,
      content,
      uri: 'document://merge',
      locator: `merge.md#${index}`,
      scope: { visibility: 'global' },
    })
  );
  store.upsertSource({ source, chunks });

  const first = store.mergeVectors({
    model: 'model-a',
    version: 'v1',
    dimension: 3,
    entries: [{ chunkId: chunks[0].chunkId, vector: [1, 0, 0] }],
  });
  assert.equal(first.count, 1);
  assert.equal(first.added, 1);
  assert.equal(first.reset, true);

  const second = store.mergeVectors({
    model: 'model-a',
    version: 'v1',
    dimension: 3,
    entries: [{ chunkId: chunks[1].chunkId, vector: [0, 1, 0] }],
  });
  assert.equal(second.count, 2);
  assert.equal(second.added, 1);
  assert.equal(second.reset, false);
  assert.deepEqual(store.getVector(chunks[0].chunkId), [1, 0, 0]);

  const restarted = store.mergeVectors({
    model: 'model-b',
    version: 'v2',
    dimension: 3,
    entries: [{ chunkId: chunks[1].chunkId, vector: [0, 0, 1] }],
  });
  assert.equal(restarted.reset, true);
  assert.equal(restarted.count, 1);
  assert.equal(store.getVector(chunks[0].chunkId), null);
  assert.deepEqual(store.getVector(chunks[1].chunkId), [0, 0, 1]);
  assert.equal(store.vectorMeta().model, 'model-b');
  assert.equal(store.vectorMeta().version, 'v2');

  assert.throws(
    () =>
      store.mergeVectors({
        model: '',
        version: 'v1',
        dimension: 3,
        entries: [],
      }),
    error => error && error.code === 'invalid_vector_meta'
  );

  const rejected = store.mergeVectors({
    model: 'model-b',
    version: 'v2',
    dimension: 3,
    entries: [
      { chunkId: chunks[0].chunkId, vector: [1, 0] },
      { chunkId: chunks[0].chunkId, vector: [Number.NaN, 0, 0] },
      { chunkId: 'chk_missing', vector: [1, 0, 0] },
    ],
  });
  assert.equal(rejected.count, 1);
  assert.equal(rejected.added, 0);
  assert.equal(store.getVector(chunks[0].chunkId), null);
  assert.deepEqual(store.getVector(chunks[1].chunkId), [0, 0, 1]);

  const cappedDir = path.join(TMP, 'capped-store');
  const capped = storeModule.createStore({
    ...config,
    limits: { ...config.limits, maxVectorChunks: 2 },
    dataDir: cappedDir,
    snapshotsDir: path.join(cappedDir, 'snapshots'),
  });
  const cappedSource = {
    ...source,
    id: 'document:capped',
    uri: 'document://capped',
    contentHash: 'capped',
  };
  const cappedChunks = ['CAP-1', 'CAP-2', 'CAP-3'].map((content, index) =>
    contract.createChunk({
      sourceType: 'document',
      sourceId: cappedSource.id,
      content,
      uri: 'document://capped',
      locator: `capped.md#${index}`,
      scope: { visibility: 'global' },
    })
  );
  capped.upsertSource({ source: cappedSource, chunks: cappedChunks });
  const cappedResult = capped.mergeVectors({
    model: 'model-a',
    version: 'v1',
    dimension: 3,
    entries: cappedChunks.map((chunk, index) => ({
      chunkId: chunk.chunkId,
      vector: index === 0 ? [1, 0, 0] : [0, 1, 0],
    })),
  });
  assert.equal(cappedResult.count, 2);
  assert.equal(cappedResult.added, 2);
  assert.equal(capped.vectorMeta().count, 2);
});

test('摄取后增量补向量：只嵌入缺失 chunk，写入索引并可重载', async () => {
  const ingest = await retrieval.ingest({
    type: 'document',
    inputPath: 'docs/alpha.md',
  });
  assert.equal(ingest.ok, true);
  assert.equal(ingest.vector.status, 'ok');
  assert.equal(ingest.vector.model, 'stub-embed');
  assert.equal(ingest.vector.version, 'v1');
  assert.equal(ingest.vector.dimension, 8);

  const total = retrieval.store.allChunks().length;
  assert.ok(total >= 1);
  assert.equal(ingest.vector.embedded, total);
  assert.equal(retrieval.store.vectorMeta().count, total);

  const onDisk = JSON.parse(fs.readFileSync(retrieval.store.indexFile, 'utf8'));
  assert.equal(onDisk.vectors.model, 'stub-embed');
  assert.equal(onDisk.vectors.version, 'v1');
  assert.equal(onDisk.vectors.dimension, 8);
  const stored = Object.values(onDisk.vectors.vectors);
  assert.equal(stored.length, total);
  assert.equal(stored[0].length, 8);
  assert.ok(stored[0].every(value => Number.isFinite(value)));

  const reloaded = storeModule.createStore({
    ...config,
    dataDir: config.dataDir,
    snapshotsDir: config.snapshotsDir,
  });
  assert.equal(reloaded.vectorMeta().model, 'stub-embed');
  assert.equal(reloaded.vectorMeta().count, total);

  const before = embeddingLog.length;
  fs.writeFileSync(
    path.join(FIXTURE_ROOT, 'docs', 'beta.md'),
    '# Beta\n\nBETA-UNIQUE NEURAL-WIN 跨语言检索资料。\n',
    'utf8'
  );
  const incremental = await retrieval.ingest({
    type: 'document',
    inputPath: 'docs/beta.md',
  });
  assert.equal(incremental.ok, true);
  assert.equal(incremental.vector.status, 'ok');
  assert.ok(incremental.vector.count >= 1);
  const afterTotal = retrieval.store.allChunks().length;
  assert.equal(retrieval.store.vectorMeta().count, afterTotal);
  assert.equal(incremental.vector.count, afterTotal - total);
  assert.equal(incremental.vector.embedded, afterTotal);

  const newTexts = embeddingLog.slice(before).flat();
  assert.equal(newTexts.length, incremental.vector.count);
  assert.ok(newTexts.every(text => text.includes('BETA-UNIQUE')));
  assert.ok(!newTexts.some(text => text.includes('ALPHA-UNIQUE')));
});

test('批量回填：清空后一次补齐，第二次无变化且不重复请求', async () => {
  retrieval.store.clearVectors();
  assert.equal(retrieval.store.vectorMeta().count, 0);
  const total = retrieval.store.allChunks().length;
  assert.ok(total >= 2);

  const before = embeddingLog.length;
  const backfill = await retrieval.backfillVectors();
  assert.equal(backfill.status, 'ok');
  assert.equal(backfill.reason, 'backfill');
  assert.equal(backfill.embedded, total);
  assert.equal(backfill.missing, 0);
  assert.equal(backfill.truncated, false);
  assert.equal(retrieval.store.vectorMeta().count, total);
  assert.equal(embeddingLog.length, before + 1);
  assert.equal(embeddingLog[before].length, total);

  const noChange = await retrieval.backfillVectors();
  assert.equal(noChange.status, 'unchanged');
  assert.equal(noChange.count, 0);
  assert.equal(noChange.embedded, total);
  assert.equal(embeddingLog.length, before + 1);

  const status = retrieval.getStatus();
  assert.equal(status.vectorCoverage.current, true);
  assert.equal(status.vectorCoverage.total, total);
  assert.equal(status.vectorCoverage.embedded, total);
  assert.equal(status.vectorCoverage.missing, 0);
  assert.equal(status.embedding.available, true);
  assert.equal(status.reranker.available, true);
  assert.equal(status.reranker.model, 'stub-reranker');
  assert.equal(status.capabilities.reranker, true);
  assert.equal(status.capabilities.signalRerank, true);
});

test('元数据失配：旧向量作废，回填使用当前模型重新生成', async () => {
  const chunks = retrieval.store.allChunks();
  const first = chunks[0];
  const second = chunks[1];
  const mismatched = retrieval.store.mergeVectors({
    model: 'other-embed',
    version: 'v9',
    dimension: 8,
    entries: [{ chunkId: first.chunkId, vector: [1, 0, 0, 0, 0, 0, 0, 0] }],
  });
  assert.equal(mismatched.reset, true);
  assert.equal(retrieval.store.vectorMeta().model, 'other-embed');
  assert.equal(retrieval.store.getVector(second.chunkId), null);

  const before = retrieval.getStatus();
  assert.equal(before.vectorCoverage.current, false);
  assert.equal(before.vectorCoverage.embedded, 0);
  assert.equal(before.vectorCoverage.missing, before.vectorCoverage.total);

  const repaired = await retrieval.backfillVectors();
  assert.equal(repaired.status, 'ok');
  assert.equal(repaired.reset, true);
  assert.equal(repaired.model, 'stub-embed');
  assert.equal(repaired.version, 'v1');
  assert.equal(repaired.dimension, 8);
  assert.equal(repaired.embedded, retrieval.store.allChunks().length);
  assert.equal(retrieval.store.vectorMeta().model, 'stub-embed');
  assert.notDeepEqual(retrieval.store.getVector(first.chunkId), [1, 0, 0, 0, 0, 0, 0, 0]);

  const after = retrieval.getStatus();
  assert.equal(after.vectorCoverage.current, true);
  assert.equal(after.vectorCoverage.missing, 0);
});

test('Reranker Provider：真实 HTTP 契约、子集评分与可用性判定', async () => {
  const beforeRequests = rerankLog.length;
  const provider = rerankerModule.createRerankerProvider({
    provider: 'http',
    baseUrl: `http://127.0.0.1:${rerankPort}/v1`,
    model: 'stub-reranker',
    version: 'v1',
    topN: 10,
    timeoutMs: 2000,
    apiKey: 'test-key-not-logged',
  });
  assert.equal(provider.available, true);
  assert.equal(provider.endpoint, `http://127.0.0.1:${rerankPort}/v1/rerank`);

  const result = await provider.rerank({
    query: 'cross lingual',
    documents: ['plain document', 'NEURAL-WIN document'],
  });
  assert.equal(result.ok, true);
  assert.equal(result.scores.length, 2);
  const winner = result.scores.find(item => item.index === 1);
  const loser = result.scores.find(item => item.index === 0);
  assert.ok(winner.score > loser.score);
  assert.equal(result.usage.billed_units.search_units, 1);
  assert.equal(result.model, 'stub-reranker');
  assert.equal(provider.stats().requests, 1);
  assert.equal(provider.stats().documents, 2);
  assert.ok(provider.stats().lastLatencyMs >= 0);
  assert.ok(!JSON.stringify(provider.stats()).includes('test-key-not-logged'));

  const sent = rerankLog.slice(beforeRequests).at(-1);
  assert.equal(sent.body.model, 'stub-reranker');
  assert.equal(sent.body.query, 'cross lingual');
  assert.equal(sent.body.top_n, 2);
  assert.equal(sent.body.documents.length, 2);

  const skipped = await provider.rerank({ query: 'only one', documents: ['single'] });
  assert.equal(skipped.ok, true);
  assert.equal(skipped.skipped, true);
  assert.equal(provider.stats().requests, 1);

  const partial = rerankerModule.createRerankerProvider({
    provider: 'http',
    baseUrl: `http://127.0.0.1:${rerankPort}/partial`,
    model: 'stub-reranker',
    version: 'v1',
    topN: 10,
    timeoutMs: 2000,
  });
  const partialResult = await partial.rerank({
    query: 'partial',
    documents: ['first', 'second'],
  });
  assert.equal(partialResult.ok, true);
  assert.deepEqual(partialResult.scores, [{ index: 0, score: 0.9 }]);

  const unavailable = rerankerModule.createRerankerProvider({});
  assert.equal(unavailable.available, false);
  assert.equal(unavailable.reason, 'not_configured');
  const unavailableResult = await unavailable.rerank({
    query: 'q',
    documents: ['a', 'b'],
  });
  assert.equal(unavailableResult.ok, false);
  assert.equal(unavailableResult.errorCode, 'not_configured');

  const insecure = rerankerModule.createRerankerProvider({
    provider: 'http',
    baseUrl: 'http://example.com/v1',
    model: 'remote',
  });
  assert.equal(insecure.available, false);
  assert.equal(insecure.reason, 'insecure_base_url');

  const withCredentials = rerankerModule.createRerankerProvider({
    provider: 'http',
    baseUrl: 'https://user:secret@example.com/v1',
    model: 'remote',
  });
  assert.equal(withCredentials.available, false);
  assert.equal(withCredentials.reason, 'credentials_in_url');

  const unknown = rerankerModule.createRerankerProvider({
    provider: 'unknown-provider',
    baseUrl: 'https://example.com/v1',
    model: 'remote',
  });
  assert.equal(unknown.available, false);
  assert.equal(unknown.reason, 'unknown_provider');

  const missingModel = rerankerModule.createRerankerProvider({
    provider: 'http',
    baseUrl: 'https://example.com/v1',
    model: '',
  });
  assert.equal(missingModel.available, false);
  assert.equal(missingModel.reason, 'model_not_configured');
});

test('Engine 神经重排：改变最终顺序；失败时保留确定性顺序并显式降级', async () => {
  const dir = path.join(TMP, 'engine-store');
  const store = storeModule.createStore({
    ...config,
    dataDir: dir,
    snapshotsDir: path.join(dir, 'snapshots'),
  });
  const source = {
    id: 'document:engine',
    type: 'document',
    title: 'engine',
    uri: 'document://engine',
    state: 'indexed',
    sourceVersion: 'v1',
    contentHash: 'engine',
    metadata: {},
  };
  const contents = ['alpha alpha alpha', 'beta beta beta', 'gamma NEURAL-WIN marker'];
  const chunks = contents.map((content, index) =>
    contract.createChunk({
      sourceType: 'document',
      sourceId: source.id,
      content,
      uri: 'document://engine',
      locator: `engine.md#${index}`,
      scope: { visibility: 'global' },
    })
  );
  store.upsertSource({ source, chunks });
  const embedded = await retrieval.embedding.embedDocuments(contents);
  assert.equal(embedded.ok, true);
  store.mergeVectors({
    model: retrieval.embedding.model,
    version: retrieval.embedding.version,
    dimension: retrieval.embedding.dimension,
    entries: chunks.map((chunk, index) => ({
      chunkId: chunk.chunkId,
      vector: embedded.vectors[index],
    })),
  });

  const plan = engine.createPlan({
    query: 'alpha beta',
    sources: ['document'],
    limit: 3,
    tokenBudget: 2000,
    timeoutMs: 5000,
    maxQueryChars: 500,
    maxEvidence: 12,
  });

  const deterministic = await engine.executeSearch({
    store,
    embedding: retrieval.embedding,
    config,
    plan,
  });
  assert.equal(deterministic.ok, true);
  assert.equal(deterministic.trace.neuralRerank.applied, false);
  assert.equal(deterministic.trace.neuralRerank.reason, 'not_configured');
  assert.ok(!deterministic.evidence[0].content.includes('NEURAL-WIN'));

  const neural = rerankerModule.createRerankerProvider({
    provider: 'http',
    baseUrl: `http://127.0.0.1:${rerankPort}/v1`,
    model: 'stub-reranker',
    version: 'v1',
    topN: 10,
    timeoutMs: 2000,
  });
  const reranked = await engine.executeSearch({
    store,
    embedding: retrieval.embedding,
    reranker: neural,
    config,
    plan,
  });
  assert.equal(reranked.ok, true);
  assert.equal(reranked.evidence[0].content.includes('NEURAL-WIN'), true);
  assert.equal(reranked.trace.neuralRerank.applied, true);
  assert.equal(reranked.trace.neuralRerank.provider, 'http');
  assert.equal(reranked.trace.neuralRerank.model, 'stub-reranker');
  assert.ok(reranked.trace.neuralRerank.candidates >= 2);
  assert.equal(
    reranked.trace.neuralRerank.scored,
    reranked.trace.neuralRerank.candidates
  );
  assert.ok(!JSON.stringify(reranked.trace).includes('NEURAL-WIN'));

  const failing = rerankerModule.createRerankerProvider({
    provider: 'http',
    baseUrl: `http://127.0.0.1:${rerankPort}/fail`,
    model: 'stub-reranker',
    version: 'v1',
    topN: 10,
    timeoutMs: 2000,
  });
  const fallback = await engine.executeSearch({
    store,
    embedding: retrieval.embedding,
    reranker: failing,
    config,
    plan,
  });
  assert.equal(fallback.ok, true);
  assert.equal(fallback.trace.neuralRerank.applied, false);
  assert.equal(fallback.trace.neuralRerank.attempted, true);
  assert.equal(fallback.trace.neuralRerank.errorCode, 'reranker_http_error');
  assert.ok(fallback.trace.degraded.includes('reranker_failed'));
  assert.deepEqual(
    fallback.evidence.map(item => item.chunkId),
    deterministic.evidence.map(item => item.chunkId)
  );

  const broken = embeddingModule.createEmbeddingProvider({
    provider: 'openai-compatible',
    baseUrl: `http://127.0.0.1:${embeddingPort}/broken`,
    model: 'stub-embed',
    version: 'v1',
    dimension: 8,
    apiKey: '',
    batchSize: 16,
    timeoutMs: 500,
    cacheMax: 0,
  });
  assert.equal(broken.available, true);
  const offline = await engine.executeSearch({
    store,
    embedding: broken,
    config,
    plan,
  });
  assert.equal(offline.ok, true);
  assert.equal(offline.status, 'partial_success');
  assert.ok(offline.evidence.length >= 1);
  const offlineVector = offline.trace.channels.find(channel => channel.name === 'vector');
  assert.equal(offlineVector.status, 'failed');
  assert.ok(offline.trace.degraded.includes('vector_embedding_http_error'));
});

test('检索门面：混合召回 + 神经重排 + 向量同步状态可追溯', async () => {
  const result = await retrieval.search({
    query: 'BETA-UNIQUE NEURAL-WIN',
    sources: ['document'],
    limit: 3,
  });
  assert.equal(result.ok, true);
  assert.equal(result.status, 'success');
  assert.ok(result.evidence.length >= 1);
  assert.equal(result.evidence[0].content.includes('BETA-UNIQUE'), true);
  assert.equal(result.trace.vectorSync.status, 'unchanged');
  const vectorChannel = result.trace.channels.find(channel => channel.name === 'vector');
  assert.equal(vectorChannel.status, 'success');
  assert.ok(vectorChannel.count >= 1);
  assert.equal(result.trace.neuralRerank.applied, true);
  assert.equal(result.trace.neuralRerank.provider, 'http');
  assert.ok(result.trace.fusion.rerank.applied);
  assert.ok(!JSON.stringify(result.trace).includes('BETA-UNIQUE'));
  assert.ok(result.citations.length >= 1);
});
