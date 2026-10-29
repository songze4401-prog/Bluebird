/* global __dirname */
/**
 * 云岫 Bluebird — 统一检索配置（retrieval/config.js）
 *
 * 所有上限与开关都从显式环境变量读取（不用动态 process.env[name]），
 * 非法值回退默认并打 warning。配置在加载时冻结，业务模块只读。
 *
 * 默认策略：
 * - 检索服务开启，但外部知识上下文注入只在索引里有文档/网页/代码时生效；
 * - 未配置 Embedding Provider 时向量通道显式 unavailable，词法/精确照常工作；
 * - 文件摄取默认关闭，必须显式配置允许根目录，避免任意路径读取。
 */
const path = require('path');

function readInt(raw, fallback, min, max, name) {
  if (raw === undefined || raw === '') return fallback;
  const value = Number(raw);
  if (!Number.isInteger(value) || value < min || value > max) {
    console.warn(`[retrieval] ${name} 非法（${raw}），回退 ${fallback}（允许 ${min}-${max}）`);
    return fallback;
  }
  return value;
}

function readBool(raw, fallback, name) {
  if (raw === undefined || raw === '') return fallback;
  if (raw === '1' || raw === 'true') return true;
  if (raw === '0' || raw === 'false') return false;
  console.warn(`[retrieval] ${name} 非法（${raw}），回退 ${fallback ? '开' : '关'}`);
  return fallback;
}

function readString(raw, fallback) {
  return typeof raw === 'string' && raw.trim() ? raw.trim() : fallback;
}

const DATA_ROOT = process.env.BLUEBIRD_DATA_DIR
  ? path.resolve(process.env.BLUEBIRD_DATA_DIR)
  : path.join(__dirname, '..', 'data');

const DATA_DIR = process.env.BLUEBIRD_RETRIEVAL_DIR
  ? path.resolve(process.env.BLUEBIRD_RETRIEVAL_DIR)
  : path.join(DATA_ROOT, 'retrieval');

const ALLOWED_ROOTS = (() => {
  const raw = process.env.BLUEBIRD_RETRIEVAL_ROOTS;
  if (!raw) return [];
  return raw
    .split(path.delimiter)
    .map(item => item.trim())
    .filter(Boolean)
    .map(item => path.resolve(item));
})();

const CONTEXT_SOURCES = (() => {
  const raw = readString(
    process.env.BLUEBIRD_RETRIEVAL_CONTEXT_SOURCES,
    'document,web,code'
  );
  const allowed = new Set(['document', 'web', 'code']);
  const list = raw
    .split(',')
    .map(item => item.trim())
    .filter(item => allowed.has(item));
  return list.length ? [...new Set(list)] : ['document', 'web', 'code'];
})();

const embeddingProvider = readString(
  process.env.BLUEBIRD_RETRIEVAL_EMBEDDING_PROVIDER,
  ''
);
const embeddingBaseUrl = readString(
  process.env.BLUEBIRD_RETRIEVAL_EMBEDDING_BASE_URL,
  ''
);
const embeddingModel = readString(
  process.env.BLUEBIRD_RETRIEVAL_EMBEDDING_MODEL,
  ''
);
const embeddingDimension = readInt(
  process.env.BLUEBIRD_RETRIEVAL_EMBEDDING_DIMENSION,
  0,
  0,
  4096,
  'BLUEBIRD_RETRIEVAL_EMBEDDING_DIMENSION'
);

const config = {
  enabled: readBool(process.env.BLUEBIRD_RETRIEVAL, true, 'BLUEBIRD_RETRIEVAL'),
  contextEnabled: readBool(
    process.env.BLUEBIRD_RETRIEVAL_CONTEXT,
    true,
    'BLUEBIRD_RETRIEVAL_CONTEXT'
  ),
  contextSources: Object.freeze(CONTEXT_SOURCES),
  dataDir: DATA_DIR,
  snapshotsDir: path.join(DATA_DIR, 'snapshots'),
  allowedRoots: Object.freeze(ALLOWED_ROOTS),
  allowPrivateUrls: readBool(
    process.env.BLUEBIRD_RETRIEVAL_ALLOW_PRIVATE_URL,
    false,
    'BLUEBIRD_RETRIEVAL_ALLOW_PRIVATE_URL'
  ),

  limits: Object.freeze({
    maxChunks: readInt(
      process.env.BLUEBIRD_RETRIEVAL_MAX_CHUNKS,
      8000,
      100,
      50000,
      'BLUEBIRD_RETRIEVAL_MAX_CHUNKS'
    ),
    maxSources: readInt(
      process.env.BLUEBIRD_RETRIEVAL_MAX_SOURCES,
      500,
      10,
      5000,
      'BLUEBIRD_RETRIEVAL_MAX_SOURCES'
    ),
    maxIndexBytes: readInt(
      process.env.BLUEBIRD_RETRIEVAL_MAX_INDEX_BYTES,
      64 * 1024 * 1024,
      1024 * 1024,
      256 * 1024 * 1024,
      'BLUEBIRD_RETRIEVAL_MAX_INDEX_BYTES'
    ),
    maxChunkChars: readInt(
      process.env.BLUEBIRD_RETRIEVAL_MAX_CHUNK_CHARS,
      1800,
      200,
      6000,
      'BLUEBIRD_RETRIEVAL_MAX_CHUNK_CHARS'
    ),
    maxFileBytes: readInt(
      process.env.BLUEBIRD_RETRIEVAL_MAX_FILE_BYTES,
      1024 * 1024,
      4096,
      16 * 1024 * 1024,
      'BLUEBIRD_RETRIEVAL_MAX_FILE_BYTES'
    ),
    maxWebBytes: readInt(
      process.env.BLUEBIRD_RETRIEVAL_MAX_WEB_BYTES,
      2 * 1024 * 1024,
      4096,
      16 * 1024 * 1024,
      'BLUEBIRD_RETRIEVAL_MAX_WEB_BYTES'
    ),
    maxSnapshotBytes: readInt(
      process.env.BLUEBIRD_RETRIEVAL_MAX_SNAPSHOT_BYTES,
      64 * 1024 * 1024,
      1024 * 1024,
      512 * 1024 * 1024,
      'BLUEBIRD_RETRIEVAL_MAX_SNAPSHOT_BYTES'
    ),
    maxQueryChars: readInt(
      process.env.BLUEBIRD_RETRIEVAL_MAX_QUERY_CHARS,
      500,
      1,
      2000,
      'BLUEBIRD_RETRIEVAL_MAX_QUERY_CHARS'
    ),
    maxEvidence: readInt(
      process.env.BLUEBIRD_RETRIEVAL_MAX_EVIDENCE,
      12,
      1,
      30,
      'BLUEBIRD_RETRIEVAL_MAX_EVIDENCE'
    ),
    tokenBudget: readInt(
      process.env.BLUEBIRD_RETRIEVAL_TOKEN_BUDGET,
      1600,
      100,
      12000,
      'BLUEBIRD_RETRIEVAL_TOKEN_BUDGET'
    ),
    candidates: readInt(
      process.env.BLUEBIRD_RETRIEVAL_CANDIDATES,
      30,
      5,
      200,
      'BLUEBIRD_RETRIEVAL_CANDIDATES'
    ),
    timeoutMs: readInt(
      process.env.BLUEBIRD_RETRIEVAL_TIMEOUT_MS,
      1500,
      100,
      15000,
      'BLUEBIRD_RETRIEVAL_TIMEOUT_MS'
    ),
    contextMaxItems: readInt(
      process.env.BLUEBIRD_RETRIEVAL_CONTEXT_MAX_ITEMS,
      4,
      1,
      10,
      'BLUEBIRD_RETRIEVAL_CONTEXT_MAX_ITEMS'
    ),
    contextTokenBudget: readInt(
      process.env.BLUEBIRD_RETRIEVAL_CONTEXT_TOKEN_BUDGET,
      900,
      100,
      4000,
      'BLUEBIRD_RETRIEVAL_CONTEXT_TOKEN_BUDGET'
    ),
    contextTimeoutMs: readInt(
      process.env.BLUEBIRD_RETRIEVAL_CONTEXT_TIMEOUT_MS,
      900,
      100,
      8000,
      'BLUEBIRD_RETRIEVAL_CONTEXT_TIMEOUT_MS'
    ),
    codeMaxFiles: readInt(
      process.env.BLUEBIRD_RETRIEVAL_CODE_MAX_FILES,
      400,
      1,
      2000,
      'BLUEBIRD_RETRIEVAL_CODE_MAX_FILES'
    ),
    codeMaxTotalBytes: readInt(
      process.env.BLUEBIRD_RETRIEVAL_CODE_MAX_TOTAL_BYTES,
      8 * 1024 * 1024,
      64 * 1024,
      64 * 1024 * 1024,
      'BLUEBIRD_RETRIEVAL_CODE_MAX_TOTAL_BYTES'
    ),
    maxVectorChunks: readInt(
      process.env.BLUEBIRD_RETRIEVAL_MAX_VECTOR_CHUNKS,
      2000,
      0,
      8000,
      'BLUEBIRD_RETRIEVAL_MAX_VECTOR_CHUNKS'
    ),
  }),

  fusion: Object.freeze({
    rrfK: readInt(
      process.env.BLUEBIRD_RETRIEVAL_RRF_K,
      60,
      1,
      1000,
      'BLUEBIRD_RETRIEVAL_RRF_K'
    ),
    weights: Object.freeze({ lexical: 1, exact: 1.2, vector: 1 }),
    maxPerSource: readInt(
      process.env.BLUEBIRD_RETRIEVAL_MAX_PER_SOURCE,
      6,
      1,
      30,
      'BLUEBIRD_RETRIEVAL_MAX_PER_SOURCE'
    ),
    maxPerFile: readInt(
      process.env.BLUEBIRD_RETRIEVAL_MAX_PER_FILE,
      3,
      1,
      20,
      'BLUEBIRD_RETRIEVAL_MAX_PER_FILE'
    ),
    dedupeThreshold: 0.9,
  }),

  embedding: Object.freeze({
    provider: embeddingProvider,
    baseUrl: embeddingBaseUrl,
    model: embeddingModel,
    apiKey: readString(process.env.BLUEBIRD_RETRIEVAL_EMBEDDING_API_KEY, ''),
    version: readString(process.env.BLUEBIRD_RETRIEVAL_EMBEDDING_VERSION, 'v1'),
    dimension: embeddingDimension,
    batchSize: readInt(
      process.env.BLUEBIRD_RETRIEVAL_EMBEDDING_BATCH,
      16,
      1,
      64,
      'BLUEBIRD_RETRIEVAL_EMBEDDING_BATCH'
    ),
    timeoutMs: readInt(
      process.env.BLUEBIRD_RETRIEVAL_EMBEDDING_TIMEOUT_MS,
      8000,
      500,
      60000,
      'BLUEBIRD_RETRIEVAL_EMBEDDING_TIMEOUT_MS'
    ),
    cacheMax: readInt(
      process.env.BLUEBIRD_RETRIEVAL_EMBEDDING_CACHE_MAX,
      2000,
      0,
      20000,
      'BLUEBIRD_RETRIEVAL_EMBEDDING_CACHE_MAX'
    ),
  }),
};

Object.freeze(config.limits);
Object.freeze(config.fusion);
Object.freeze(config.embedding);
Object.freeze(config);

module.exports = { config };
