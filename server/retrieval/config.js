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

// 前缀中的空白有语义（E5 的 "query: " / "passage: "），不能 trim。
function readRawString(raw, fallback) {
  return typeof raw === 'string' ? raw : fallback;
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

// Embedding 供应商预设：配置只写 provider + apiKey 即可，其余取预设；
// 显式设置的 BASE_URL / MODEL / DIMENSION 永远优先，方便换自建/代理端点。
// 选择依据：中文语料表现稳定、按量计费、可随时替换 provider。
const EMBEDDING_PRESETS = Object.freeze({
  // 阿里云百炼 text-embedding-v3：中文强、1024 维、按 token 计费，国内直连
  dashscope: Object.freeze({
    baseUrl: 'https://dashscope.aliyuncs.com/compatible-mode/v1',
    model: 'text-embedding-v3',
    dimension: 1024,
    pricePerMillionTokens: 0.07,
  }),
  // 硅基流动 BAAI/bge-m3：多语言/中文好、1024 维、价格更低
  siliconflow: Object.freeze({
    baseUrl: 'https://api.siliconflow.cn/v1',
    model: 'BAAI/bge-m3',
    dimension: 1024,
    pricePerMillionTokens: 0.01,
  }),
  // OpenAI text-embedding-3-small：通用基线，1536 维
  openai: Object.freeze({
    baseUrl: 'https://api.openai.com/v1',
    model: 'text-embedding-3-small',
    dimension: 1536,
    pricePerMillionTokens: 0.02,
  }),
});

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

const embeddingPreset =
  EMBEDDING_PRESETS[embeddingProvider.toLowerCase()] || null;
const resolvedBaseUrl = embeddingBaseUrl || (embeddingPreset ? embeddingPreset.baseUrl : '');
const resolvedModel = embeddingModel || (embeddingPreset ? embeddingPreset.model : '');
const resolvedDimension =
  embeddingDimension > 0
    ? embeddingDimension
    : embeddingPreset
      ? embeddingPreset.dimension
      : 0;
const resolvedPrice = readInt(
  process.env.BLUEBIRD_RETRIEVAL_EMBEDDING_PRICE_PER_MILLION,
  embeddingPreset ? Math.round(embeddingPreset.pricePerMillionTokens * 1000) : 0,
  0,
  1000000,
  'BLUEBIRD_RETRIEVAL_EMBEDDING_PRICE_PER_MILLION'
);

const rerankerProvider = readString(
  process.env.BLUEBIRD_RETRIEVAL_RERANKER_PROVIDER,
  ''
);
const rerankerBaseUrl = readString(
  process.env.BLUEBIRD_RETRIEVAL_RERANKER_BASE_URL,
  ''
);
const rerankerModel = readString(
  process.env.BLUEBIRD_RETRIEVAL_RERANKER_MODEL,
  ''
);
const rerankerVersion = readString(
  process.env.BLUEBIRD_RETRIEVAL_RERANKER_VERSION,
  'v1'
);
const rerankerTimeoutMs = readInt(
  process.env.BLUEBIRD_RETRIEVAL_RERANKER_TIMEOUT_MS,
  8000,
  500,
  60000,
  'BLUEBIRD_RETRIEVAL_RERANKER_TIMEOUT_MS'
);
const rerankerTopN = readInt(
  process.env.BLUEBIRD_RETRIEVAL_RERANKER_TOP_N,
  20,
  2,
  50,
  'BLUEBIRD_RETRIEVAL_RERANKER_TOP_N'
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

  // 候选重排序 + 时效性：RRF/词法/向量三路原始分归一后加权，再叠加
  // 时间衰减与记忆图谱（共享关键词）加成。纯本地确定性计算，不调用外部服务。
  rerank: Object.freeze({
    enabled: readBool(
      process.env.BLUEBIRD_RETRIEVAL_RERANK,
      true,
      'BLUEBIRD_RETRIEVAL_RERANK'
    ),
    weights: Object.freeze({
      rrf: 0.5,
      lexical: 0.15,
      vector: 0.2,
      recency: 0.1,
      graph: 0.05,
    }),
    // 时间衰减半衰期：越旧权重越低，但保留下限，不让老记忆直接消失
    recencyHalfLifeDays: readInt(
      process.env.BLUEBIRD_RETRIEVAL_RECENCY_HALF_LIFE_DAYS,
      30,
      1,
      3650,
      'BLUEBIRD_RETRIEVAL_RECENCY_HALF_LIFE_DAYS'
    ),
    recencyFloor: 0.15,
    // 记忆图谱：两条候选共享至少 N 个关键词视为一条边
    graphMinKeywordOverlap: readInt(
      process.env.BLUEBIRD_RETRIEVAL_GRAPH_MIN_OVERLAP,
      2,
      1,
      20,
      'BLUEBIRD_RETRIEVAL_GRAPH_MIN_OVERLAP'
    ),
    // 时效性硬过滤：只对下面这些时效敏感的源生效，0 = 关闭
    maxAgeDays: readInt(
      process.env.BLUEBIRD_RETRIEVAL_MAX_AGE_DAYS,
      0,
      0,
      36500,
      'BLUEBIRD_RETRIEVAL_MAX_AGE_DAYS'
    ),
    recencyFilterSources: Object.freeze(['web']),
  }),

  embedding: Object.freeze({
    provider: embeddingProvider,
    baseUrl: resolvedBaseUrl,
    model: resolvedModel,
    apiKey: readString(process.env.BLUEBIRD_RETRIEVAL_EMBEDDING_API_KEY, ''),
    version: readString(process.env.BLUEBIRD_RETRIEVAL_EMBEDDING_VERSION, 'v1'),
    // 检索型模型（如 multilingual-e5）要求 query/passage 前缀，原样保留空白。
    queryPrefix: readRawString(
      process.env.BLUEBIRD_RETRIEVAL_EMBEDDING_QUERY_PREFIX,
      ''
    ),
    documentPrefix: readRawString(
      process.env.BLUEBIRD_RETRIEVAL_EMBEDDING_DOCUMENT_PREFIX,
      ''
    ),
    dimension: resolvedDimension,
    // 每百万 token 的美元单价（整数缩放了 1000 倍存储，避免浮点 env 解析）；
    // 只用于成本估算展示，不参与检索逻辑。
    pricePerMillionTokens: resolvedPrice / 1000,
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

  // 可选 cross-encoder reranker：Cohere/Jina 兼容 POST /rerank。
  // provider 为空时保持现有确定性 reranker，不假装神经重排已启用。
  reranker: Object.freeze({
    provider: rerankerProvider,
    baseUrl: rerankerBaseUrl,
    model: rerankerModel,
    version: rerankerVersion,
    apiKey: readString(process.env.BLUEBIRD_RETRIEVAL_RERANKER_API_KEY, ''),
    timeoutMs: rerankerTimeoutMs,
    topN: rerankerTopN,
  }),
};

Object.freeze(config.limits);
Object.freeze(config.fusion);
Object.freeze(config.rerank.weights);
Object.freeze(config.rerank);
Object.freeze(config.embedding);
Object.freeze(config.reranker);
Object.freeze(config);

module.exports = { config };
