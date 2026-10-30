#!/usr/bin/env node
/**
 * 真实神经 Embedding + 混合召回 + Reranker 的中英文开放域评测。
 *
 * 这不是固定代码语料评测，也不使用 Mock 向量：
 *   - 必须通过 BLUEBIRD_RETRIEVAL_EMBEDDING_* 配置一个真实 embedding 服务；
 *   - 每个向量都由该 HTTP 服务返回，向量维度/模型版本必须与索引元数据一致；
 *   - 语料为中英文开放域短文，查询覆盖中文、英文和中英跨语言；
 *   - 任何 failure 都会非零退出，不会把“没有向量”算成通过。
 *
 * 用法（Embedding 与 Reranker 都必须指向真实服务）：
 *   BLUEBIRD_RETRIEVAL_EMBEDDING_PROVIDER=openai-compatible \
 *   BLUEBIRD_RETRIEVAL_EMBEDDING_BASE_URL=http://127.0.0.1:8766/v1 \
 *   BLUEBIRD_RETRIEVAL_EMBEDDING_MODEL=multilingual-e5-base \
 *   BLUEBIRD_RETRIEVAL_EMBEDDING_DIMENSION=768 \
 *   BLUEBIRD_RETRIEVAL_EMBEDDING_QUERY_PREFIX="query: " \
 *   BLUEBIRD_RETRIEVAL_EMBEDDING_DOCUMENT_PREFIX="passage: " \
 *   BLUEBIRD_RETRIEVAL_RERANKER_PROVIDER=http \
 *   BLUEBIRD_RETRIEVAL_RERANKER_BASE_URL=http://127.0.0.1:8767/v1 \
 *   BLUEBIRD_RETRIEVAL_RERANKER_MODEL=bge-reranker-base \
 *   node tests/embedding-open-domain-eval.js
 *
 * 词法兜底对照（不作为验收）：
 *   node tests/embedding-open-domain-eval.js --lexical-only
 */
const fs = require('fs');
const os = require('os');
const path = require('path');

const lexicalOnly = process.argv.includes('--lexical-only');
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'bluebird-embedding-eval-'));
const CORPUS = path.join(TMP, 'corpus');
const DOCS = path.join(CORPUS, 'docs');
fs.mkdirSync(DOCS, { recursive: true });

process.env.BLUEBIRD_DATA_DIR = TMP;
process.env.BLUEBIRD_RETRIEVAL_ROOTS = CORPUS;
process.env.BLUEBIRD_RETRIEVAL = '1';
process.env.BLUEBIRD_RETRIEVAL_CONTEXT = '0';
process.env.BLUEBIRD_AGENT_TOOLS = '';
process.env.DEEPSEEK_API_KEY = '';
process.env.MEMORY_ENABLED = 'false';
// 评测需要观察真实 HTTP 请求，禁用内存缓存，避免回填复用旧响应当作“批量调用”。
process.env.BLUEBIRD_RETRIEVAL_EMBEDDING_CACHE_MAX = '0';

if (lexicalOnly) {
  // 只用于对照词典/词法兜底，不代表验收通过。
  process.env.BLUEBIRD_RETRIEVAL_EMBEDDING_PROVIDER = '';
  process.env.BLUEBIRD_RETRIEVAL_EMBEDDING_BASE_URL = '';
  process.env.BLUEBIRD_RETRIEVAL_EMBEDDING_MODEL = '';
  process.env.BLUEBIRD_RETRIEVAL_EMBEDDING_DIMENSION = '';
  process.env.BLUEBIRD_RETRIEVAL_EMBEDDING_API_KEY = '';
  process.env.BLUEBIRD_RETRIEVAL_EMBEDDING_VERSION = '';
  process.env.BLUEBIRD_RETRIEVAL_RERANKER_PROVIDER = '';
  process.env.BLUEBIRD_RETRIEVAL_RERANKER_BASE_URL = '';
  process.env.BLUEBIRD_RETRIEVAL_RERANKER_MODEL = '';
  process.env.BLUEBIRD_RETRIEVAL_RERANKER_API_KEY = '';
} else {
  const required = [
    'BLUEBIRD_RETRIEVAL_EMBEDDING_PROVIDER',
    'BLUEBIRD_RETRIEVAL_EMBEDDING_BASE_URL',
    'BLUEBIRD_RETRIEVAL_EMBEDDING_MODEL',
    'BLUEBIRD_RETRIEVAL_EMBEDDING_DIMENSION',
    'BLUEBIRD_RETRIEVAL_RERANKER_PROVIDER',
    'BLUEBIRD_RETRIEVAL_RERANKER_BASE_URL',
    'BLUEBIRD_RETRIEVAL_RERANKER_MODEL',
  ];
  const missing = required.filter(key => !process.env[key]);

  if (missing.length) {
    console.error(
      `真实 embedding 未配置：缺少 ${missing.join(', ')}。` +
        '本评测不会使用 Mock 向量，也不会把词法兜底算作向量验收。'
    );
    process.exit(2);
  }
}

const CORPUS_DOCS = [
  {
    file: 'zh-kyoto.md',
    lang: 'zh',
    text: [
      '# 京都',
      '',
      '日本京都以樱花、古寺和传统庭园闻名。每年春天，游客沿着哲学之道散步赏樱，也会参观清水寺和伏见稻荷大社。',
    ].join('\n'),
  },
  {
    file: 'zh-einstein.md',
    lang: 'zh',
    text: [
      '# 相对论',
      '',
      '阿尔伯特·爱因斯坦提出相对论，改变了人们对时间与空间的理解。狭义相对论指出光速不变，广义相对论把引力解释为时空弯曲。',
    ].join('\n'),
  },
  {
    file: 'zh-reef.md',
    lang: 'zh',
    text: [
      '# 大堡礁',
      '',
      '澳大利亚东北海岸的大堡礁是世界上最大的珊瑚礁系统，由数千个珊瑚礁和岛屿组成，是潜水与海洋生态研究的重要地点。',
    ].join('\n'),
  },
  {
    file: 'zh-piano.md',
    lang: 'zh',
    text: [
      '# 钢琴',
      '',
      '现代钢琴通常有八十八个琴键，其中五十二个白键、三十六个黑键。演奏者通过踏板控制延音和音色。',
    ].join('\n'),
  },
  {
    file: 'zh-marquez.md',
    lang: 'zh',
    text: [
      '# 百年孤独',
      '',
      '加夫列尔·加西亚·马尔克斯写了《百年孤独》。这部魔幻现实主义小说讲述了布恩迪亚家族七代人的故事。',
    ].join('\n'),
  },
  {
    file: 'zh-skin.md',
    lang: 'zh',
    text: [
      '# 人体皮肤',
      '',
      '皮肤是人体最大的器官，成年人的皮肤面积约一点五到两平方米。它负责保护身体、调节体温和感知触觉。',
    ].join('\n'),
  },
  {
    file: 'zh-everest.md',
    lang: 'zh',
    text: [
      '# 珠穆朗玛峰',
      '',
      '珠穆朗玛峰位于喜马拉雅山脉，是地球海拔最高的山峰。登山者需要适应高海拔和稀薄空气。',
    ].join('\n'),
  },
  {
    file: 'zh-honeybee.md',
    lang: 'zh',
    text: [
      '# 蜜蜂',
      '',
      '蜜蜂通过舞蹈向同伴传递花蜜的位置。它们在采集花蜜的同时完成授粉，对农作物和野生植物很重要。',
    ].join('\n'),
  },
  {
    file: 'en-mars.md',
    lang: 'en',
    text: [
      '# Mars',
      '',
      'Mars is called the Red Planet because iron oxide on its surface gives it a reddish appearance. It has a thin atmosphere and two small moons.',
    ].join('\n'),
  },
  {
    file: 'en-austen.md',
    lang: 'en',
    text: [
      '# Jane Austen',
      '',
      'Jane Austen wrote Pride and Prejudice. The novel follows Elizabeth Bennet and comments on marriage, class and social expectation in England.',
    ].join('\n'),
  },
  {
    file: 'en-pacific.md',
    lang: 'en',
    text: [
      '# Pacific Ocean',
      '',
      'The Pacific is the largest and deepest ocean on Earth. It covers about one third of the planet and contains the Mariana Trench.',
    ].join('\n'),
  },
  {
    file: 'en-photosynthesis.md',
    lang: 'en',
    text: [
      '# Photosynthesis',
      '',
      'Plants take in carbon dioxide and water, then use sunlight to produce glucose and release oxygen during photosynthesis.',
    ].join('\n'),
  },
  {
    file: 'en-ottawa.md',
    lang: 'en',
    text: [
      '# Ottawa',
      '',
      'Ottawa is the capital of Canada. It sits on the Ottawa River in Ontario and is home to Parliament Hill and many national museums.',
    ].join('\n'),
  },
  {
    file: 'en-mona-lisa.md',
    lang: 'en',
    text: [
      '# Mona Lisa',
      '',
      'The Mona Lisa was painted by Leonardo da Vinci. It hangs in the Louvre in Paris and is famous for the subject’s enigmatic expression.',
    ].join('\n'),
  },
  {
    file: 'en-amazon.md',
    lang: 'en',
    text: [
      '# Amazon rainforest',
      '',
      'The Amazon is the largest tropical rainforest on Earth. It supports immense biodiversity and plays a major role in the global carbon cycle.',
    ].join('\n'),
  },
  {
    file: 'en-moon.md',
    lang: 'en',
    text: [
      '# The Moon',
      '',
      'The Moon orbits Earth and its gravity causes ocean tides. It is about one quarter the width of Earth and has no substantial atmosphere.',
    ].join('\n'),
  },
];

const QUERIES = [
  { id: 'zh-1', lang: 'zh', query: '哪座日本城市以樱花和古寺闻名？', expect: 'zh-kyoto.md' },
  { id: 'zh-2', lang: 'zh', query: '谁提出了相对论？', expect: 'zh-einstein.md' },
  { id: 'zh-3', lang: 'zh', query: '世界上最大的珊瑚礁在哪里？', expect: 'zh-reef.md' },
  { id: 'zh-4', lang: 'zh', query: '哪种乐器通常有八十八个琴键？', expect: 'zh-piano.md' },
  { id: 'zh-5', lang: 'zh', query: '《百年孤独》的作者是谁？', expect: 'zh-marquez.md' },
  { id: 'zh-6', lang: 'zh', query: '人体面积最大的器官是什么？', expect: 'zh-skin.md' },
  { id: 'en-1', lang: 'en', query: 'Which planet is called the Red Planet?', expect: 'en-mars.md' },
  { id: 'en-2', lang: 'en', query: 'Who wrote Pride and Prejudice?', expect: 'en-austen.md' },
  { id: 'en-3', lang: 'en', query: 'What is the largest and deepest ocean on Earth?', expect: 'en-pacific.md' },
  { id: 'en-4', lang: 'en', query: 'Which gas do plants take in for photosynthesis?', expect: 'en-photosynthesis.md' },
  { id: 'en-5', lang: 'en', query: 'What is the capital of Canada?', expect: 'en-ottawa.md' },
  { id: 'en-6', lang: 'en', query: 'Who painted the Mona Lisa?', expect: 'en-mona-lisa.md' },
  { id: 'cross-zh-1', lang: 'cross_zh_en', query: '哪颗行星因为氧化铁而呈红色？', expect: 'en-mars.md' },
  { id: 'cross-zh-2', lang: 'cross_zh_en', query: '谁写了《傲慢与偏见》？', expect: 'en-austen.md' },
  { id: 'cross-zh-3', lang: 'cross_zh_en', query: '地球上最大、最深的海洋是哪个？', expect: 'en-pacific.md' },
  { id: 'cross-zh-4', lang: 'cross_zh_en', query: '植物进行光合作用时吸收哪种气体？', expect: 'en-photosynthesis.md' },
  { id: 'cross-en-1', lang: 'cross_en_zh', query: 'Which city in Japan is known for cherry blossoms and ancient temples?', expect: 'zh-kyoto.md' },
  { id: 'cross-en-2', lang: 'cross_en_zh', query: 'Who proposed the theory of relativity?', expect: 'zh-einstein.md' },
  { id: 'cross-en-3', lang: 'cross_en_zh', query: 'What is the largest organ of the human body?', expect: 'zh-skin.md' },
  { id: 'cross-en-4', lang: 'cross_en_zh', query: 'Which animal spreads pollen while collecting nectar?', expect: 'zh-honeybee.md' },
  { id: 'cross-en-5', lang: 'cross_en_zh', query: 'What is the highest mountain above sea level?', expect: 'zh-everest.md' },
];

function writeCorpus() {
  for (const doc of CORPUS_DOCS) {
    fs.writeFileSync(path.join(DOCS, doc.file), doc.text, 'utf8');
  }
}

function rankOf(evidence, expected) {
  return evidence.findIndex(item => (item.locator || '').includes(expected)) + 1;
}

function pct(value) {
  return `${(value * 100).toFixed(1)}%`;
}

function summarize(rows) {
  const total = rows.length;
  const at1 = rows.filter(row => row.rank === 1).length;
  const at3 = rows.filter(row => row.rank > 0 && row.rank <= 3).length;
  const at5 = rows.filter(row => row.rank > 0 && row.rank <= 5).length;
  const rr = rows.reduce((sum, row) => sum + (row.rank > 0 ? 1 / row.rank : 0), 0);

  return {
    queries: total,
    recallAt1: total ? Number((at1 / total).toFixed(4)) : 0,
    recallAt3: total ? Number((at3 / total).toFixed(4)) : 0,
    recallAt5: total ? Number((at5 / total).toFixed(4)) : 0,
    mrr: total ? Number((rr / total).toFixed(4)) : 0,
  };
}

async function main() {
  writeCorpus();
  const retrieval = require('../server/retrieval');

  const ingestResults = [];
  for (const doc of CORPUS_DOCS) {
    const result = await retrieval.ingest({
      type: 'document',
      inputPath: `docs/${doc.file}`,
    });
    if (!result.ok) {
      throw new Error(`ingest failed for ${doc.file}: ${result.errorCode}`);
    }
    ingestResults.push({ file: doc.file, sourceId: result.source.id });
  }

  const embeddingStats = retrieval.embedding.stats();
  if (!lexicalOnly && !embeddingStats.available) {
    console.error(
      `embedding provider 不可用：${embeddingStats.reason || 'unknown'}；` +
        '不把词法兜底算作向量验收。'
    );
    process.exitCode = 2;
    return;
  }

  // 显式验证批量回填：清空已由 ingest 自动写入的向量，再走 backfill。
  if (!lexicalOnly) {
    retrieval.store.clearVectors();
    const backfill = await retrieval.backfillVectors();
    console.log(`vector backfill: ${JSON.stringify(backfill)}`);
    if (backfill.status !== 'ok' && backfill.status !== 'unchanged') {
      throw new Error(`vector backfill failed: ${backfill.status}`);
    }
    const repeatBackfill = await retrieval.backfillVectors();
    console.log(`vector backfill repeat: ${JSON.stringify(repeatBackfill)}`);
    if (repeatBackfill.status !== 'unchanged') {
      throw new Error(`vector backfill is not idempotent: ${repeatBackfill.status}`);
    }
    const afterBackfill = retrieval.store.vectorMeta();
    if (
      afterBackfill.count === 0 ||
      afterBackfill.dimension !== embeddingStats.dimension ||
      afterBackfill.model !== embeddingStats.model
    ) {
      throw new Error(
        `vector store metadata mismatch: ${JSON.stringify(afterBackfill)}`
      );
    }
    const firstChunk = retrieval.store.allChunks()[0];
    const vector = firstChunk ? retrieval.store.getVector(firstChunk.chunkId) : null;
    if (!vector || vector.length !== embeddingStats.dimension) {
      throw new Error('stored vector missing or dimension mismatch');
    }
    const norm = Math.sqrt(vector.reduce((sum, value) => sum + value * value, 0));
    console.log(
      `stored vector: dim=${vector.length} norm=${norm.toFixed(4)} ` +
        `chunks=${retrieval.store.vectorMeta().count}`
    );
  }

  const rows = [];
  const vectorObservations = [];

  for (const query of QUERIES) {
    const result = await retrieval.search({
      query: query.query,
      sources: ['document'],
      limit: 5,
    });
    if (!result.ok) {
      rows.push({ ...query, rank: 0, error: result.errorCode });
      continue;
    }
    const evidence = result.evidence || [];
    const rank = rankOf(evidence, query.expect);
    const vectorChannel = (result.trace.channels || []).find(
      channel => channel.name === 'vector'
    );
    vectorObservations.push({
      id: query.id,
      status: vectorChannel ? vectorChannel.status : 'missing',
      reason: vectorChannel ? vectorChannel.errorCode || null : null,
      rerank:
        result.trace.fusion && result.trace.fusion.rerank
          ? result.trace.fusion.rerank
          : null,
      neuralRerank: result.trace.neuralRerank || null,
      embedding: result.trace.embedding || null,
    });
    rows.push({ ...query, rank });
  }

  const groups = {
    zh: summarize(rows.filter(row => row.lang === 'zh')),
    en: summarize(rows.filter(row => row.lang === 'en')),
    cross: summarize(
      rows.filter(
        row => row.lang === 'cross_zh_en' || row.lang === 'cross_en_zh'
      )
    ),
    overall: summarize(rows),
  };
  const vectorSuccess = vectorObservations.filter(
    item => item.status === 'success'
  ).length;
  const rerankApplied = vectorObservations.filter(
    item => item.rerank && item.rerank.applied === true
  ).length;
  const neuralRerankApplied = vectorObservations.filter(
    item => item.neuralRerank && item.neuralRerank.applied === true
  ).length;
  const rerankerStats = retrieval.reranker.stats();
  const realRequests = Math.max(
    ...vectorObservations.map(item =>
      item.embedding && Number.isInteger(item.embedding.requests)
        ? item.embedding.requests
        : 0
    ),
    0
  );
  const realTexts = Math.max(
    ...vectorObservations.map(item =>
      item.embedding && Number.isInteger(item.embedding.texts)
        ? item.embedding.texts
        : 0
    ),
    0
  );
  const finalEmbedding = retrieval.embedding.stats();
  const status = retrieval.getStatus();

  console.log('\nOpen-domain recall rows:');
  for (const row of rows) {
    console.log(
      `rank=${row.rank || '-'} lang=${row.lang} id=${row.id} expect=${row.expect}`
    );
  }
  console.log(`\nOpen-domain recall: ${JSON.stringify(groups, null, 2)}`);
  console.log(
    `vector channel: success=${vectorSuccess}/${QUERIES.length} ` +
      `signalRerankApplied=${rerankApplied}/${QUERIES.length} ` +
      `neuralRerankApplied=${neuralRerankApplied}/${QUERIES.length}`
  );
  console.log(
    `neural reranker: ${JSON.stringify({
      provider: rerankerStats.provider,
      model: rerankerStats.model,
      version: rerankerStats.version,
      available: rerankerStats.available,
      requests: rerankerStats.requests,
      documents: rerankerStats.documents,
      lastLatencyMs: rerankerStats.lastLatencyMs,
    })}`
  );
  console.log(
    `embedding: ${JSON.stringify({
      provider: finalEmbedding.provider,
      model: finalEmbedding.model,
      version: finalEmbedding.version,
      dimension: finalEmbedding.dimension,
      requests: finalEmbedding.requests,
      texts: finalEmbedding.texts,
      tokensReported: finalEmbedding.tokensReported,
      estimatedTokens: finalEmbedding.estimatedTokens,
    })}`
  );
  console.log(
    `index vector coverage: ${JSON.stringify(status.vectorCoverage)} ` +
      `meta=${JSON.stringify(status.vector)}`
  );

  let incrementalOk = lexicalOnly;
  let incrementalDetail = null;

  if (!lexicalOnly) {
    const incrementalFile = 'en-gulf-stream.md';
    fs.writeFileSync(
      path.join(DOCS, incrementalFile),
      [
        '# Gulf Stream',
        '',
        'The Gulf Stream is a warm ocean current that carries heat from the Gulf of Mexico toward the North Atlantic and helps keep Western Europe milder than other regions at the same latitude.',
      ].join('\n'),
      'utf8'
    );
    const beforeVectors = retrieval.store.vectorMeta().count;
    const incrementalIngest = await retrieval.ingest({
      type: 'document',
      inputPath: `docs/${incrementalFile}`,
    });
    const afterVectors = retrieval.store.vectorMeta().count;
    const incrementalSearch = await retrieval.search({
      query: 'Which ocean current helps keep Western Europe mild?',
      sources: ['document'],
      limit: 5,
    });
    const incrementalRank = incrementalSearch.ok
      ? rankOf(incrementalSearch.evidence || [], incrementalFile)
      : 0;
    incrementalOk =
      incrementalIngest.ok &&
      incrementalIngest.vector &&
      (incrementalIngest.vector.status === 'ok' ||
        incrementalIngest.vector.status === 'unchanged') &&
      afterVectors > beforeVectors &&
      incrementalRank > 0;
    incrementalDetail = {
      ingestVector: incrementalIngest.vector || null,
      beforeVectors,
      afterVectors,
      rank: incrementalRank,
    };
    console.log(`incremental update: ${JSON.stringify(incrementalDetail)}`);
  }

  if (lexicalOnly) {
    console.log(
      'lexical-only baseline: vector channel is expected to be unavailable; this run is not acceptance.'
    );
    if (groups.overall.recallAt5 < 0.3) {
      console.error('lexical fallback recall@5 below 0.3');
      process.exitCode = 1;
    }
    return;
  }

  const failures = [];
  if (vectorSuccess !== QUERIES.length) {
    failures.push(`vector channel success ${vectorSuccess}/${QUERIES.length}`);
  }
  if (rerankApplied === 0) failures.push('signal reranker never applied');
  if (!rerankerStats.available) failures.push('neural reranker not configured');
  if (neuralRerankApplied !== QUERIES.length) {
    failures.push(
      `neural reranker applied ${neuralRerankApplied}/${QUERIES.length}`
    );
  }
  if (rerankerStats.requests <= 0) {
    failures.push('no real neural reranker requests observed');
  }
  if (realRequests <= 0) failures.push('no real embedding requests observed');
  if (realTexts <= 0) failures.push('no real embedding texts observed');
  if (!status.vectorCoverage || status.vectorCoverage.current !== true) {
    failures.push('vector metadata is not current (model/version/dimension mismatch)');
  }
  if (!incrementalOk) {
    failures.push(
      `incremental vector update failed: ${JSON.stringify(incrementalDetail)}`
    );
  }
  if (groups.overall.recallAt5 < 0.8) {
    failures.push(`overall recall@5 ${pct(groups.overall.recallAt5)} < 80%`);
  }
  if (groups.cross.recallAt5 < 0.7) {
    failures.push(`cross-lingual recall@5 ${pct(groups.cross.recallAt5)} < 70%`);
  }
  if (groups.overall.recallAt5 > 0 && realRequests <= 0) {
    failures.push('recall exists but no real API call evidence');
  }

  if (failures.length) {
    console.error(`\nEMBEDDING ACCEPTANCE FAILED:\n- ${failures.join('\n- ')}`);
    process.exitCode = 1;
  } else {
    console.log(
      `\nEMBEDDING ACCEPTANCE PASSED: real vectors, ${groups.overall.recallAt5 * 100}% ` +
        `overall recall@5, ${groups.cross.recallAt5 * 100}% cross-lingual recall@5.`
    );
  }
}

main().catch(error => {
  console.error(error && error.stack ? error.stack : error);
  process.exitCode = 1;
});
