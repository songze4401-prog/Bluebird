#!/usr/bin/env node
/**
 * 云岫 Bluebird — 统一检索固定语料评测（tests/retrieval-eval.js）
 *
 * 用途：验证词法/精确通道、来源过滤、路径/符号检索与引用定位在固定语料上的
 * 排序契约。它不是开放域语义评测，也不能替代真实用户语料的端到端评估。
 *
 * 隔离：自建临时数据目录与临时语料，不读取 server/data。
 * 运行：node tests/retrieval-eval.js --assert（npm run eval:retrieval）
 */
const fs = require('fs');
const os = require('os');
const path = require('path');

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'bluebird-retrieval-eval-'));
const CORPUS = path.join(TMP, 'corpus');
fs.mkdirSync(path.join(CORPUS, 'docs'), { recursive: true });
fs.mkdirSync(path.join(CORPUS, 'code', 'src'), { recursive: true });

process.env.BLUEBIRD_DATA_DIR = TMP;
process.env.BLUEBIRD_RETRIEVAL_ROOTS = CORPUS;
process.env.BLUEBIRD_RETRIEVAL = '1';
process.env.BLUEBIRD_RETRIEVAL_CONTEXT = '0';
process.env.BLUEBIRD_AGENT_TOOLS = '';
process.env.DEEPSEEK_API_KEY = '';
process.env.MEMORY_ENABLED = 'false';

fs.writeFileSync(
  path.join(CORPUS, 'docs', 'auth.md'),
  [
    '# 认证设计',
    '',
    '## Bearer Token',
    '',
    'authenticateUser 负责校验 bearer token；缺失或过期时返回 E_AUTH_401。',
    'verifyBearer 只做签名与过期时间检查，不查询用户资料。',
    '',
    '## 会话隔离',
    '',
    '所有认证结果必须绑定 sessionId，禁止跨会话复用记忆或对话。',
  ].join('\n'),
  'utf8'
);
fs.writeFileSync(
  path.join(CORPUS, 'docs', 'deploy.md'),
  [
    '# 部署手册',
    '',
    '## 发布前检查',
    '',
    '生产部署前必须执行 HEALTH-CHECK-EVAL 健康检查。',
    '',
    '## 回滚步骤',
    '',
    '发现错误率升高时先停止流量，再回滚到上一个 commit，并核对快照。',
  ].join('\n'),
  'utf8'
);
fs.writeFileSync(
  path.join(CORPUS, 'docs', 'retrieval.md'),
  [
    '# 统一检索架构',
    '',
    '## 混合召回',
    '',
    '词法 BM25 与向量检索并行召回，使用 RRF 融合，不直接把不同检索器的原始分数相加。',
    '',
    '## 能力边界',
    '',
    '当前没有配置神经 embedding 时，向量通道明确不可用，只能使用词法/精确检索。',
    '',
    '## 数据契约',
    '',
    'chunk_id 由来源、切片规则版本、内容哈希与 locator 共同决定，保证稳定且可复现。',
  ].join('\n'),
  'utf8'
);
fs.writeFileSync(
  path.join(CORPUS, 'code', 'src', 'auth.ts'),
  [
    'export function authenticateUser(token: string) {',
    '  if (!token) throw new Error("E_AUTH_401");',
    '  return verifyBearer(token);',
    '}',
    '',
    'export function verifyBearer(token: string) {',
    '  return token.length > 0;',
    '}',
  ].join('\n'),
  'utf8'
);
fs.writeFileSync(
  path.join(CORPUS, 'code', 'src', 'billing.ts'),
  [
    'export function refundInvoice(invoiceId: string) {',
    '  return { invoiceId, status: "refunded" };',
    '}',
    '',
    'export function calculateTax(amount: number) {',
    '  return amount * 0.06;',
    '}',
  ].join('\n'),
  'utf8'
);

const retrieval = require('../server/retrieval');

const QUERIES = [
  { query: 'authenticateUser bearer token', source: 'code', locator: 'src/auth.ts' },
  { query: 'E_AUTH_401', source: 'code', locator: 'src/auth.ts' },
  { query: 'verifyBearer 签名校验', source: 'code', locator: 'src/auth.ts' },
  { query: 'refundInvoice 退款', source: 'code', locator: 'src/billing.ts' },
  { query: 'calculateTax', source: 'code', locator: 'src/billing.ts' },
  { query: '生产部署前健康检查 HEALTH-CHECK-EVAL', source: 'document', locator: 'docs/deploy.md' },
  { query: '回滚到上一个 commit', source: 'document', locator: 'docs/deploy.md' },
  { query: 'BM25 与向量 RRF 融合', source: 'document', locator: 'docs/retrieval.md' },
  { query: '没有神经 embedding 时向量通道不可用', source: 'document', locator: 'docs/retrieval.md' },
  { query: 'chunk_id 由什么决定', source: 'document', locator: 'docs/retrieval.md' },
  { query: 'sessionId 跨会话隔离', source: 'document', locator: 'docs/auth.md' },
  { query: '发布前检查清单', source: 'document', locator: 'docs/deploy.md' },
];

function isRelevant(item, expected) {
  return item.sourceType === expected.source && item.locator.includes(expected.locator);
}

async function main() {
  await retrieval.ingest({ type: 'document', inputPath: 'docs/auth.md' });
  await retrieval.ingest({ type: 'document', inputPath: 'docs/deploy.md' });
  await retrieval.ingest({ type: 'document', inputPath: 'docs/retrieval.md' });
  await retrieval.ingest({ type: 'code', inputPath: 'code' });

  let hits3 = 0;
  let hits5 = 0;
  let reciprocalRank = 0;
  const rows = [];

  for (const expected of QUERIES) {
    const result = await retrieval.search({
      query: expected.query,
      sources: ['document', 'code'],
      limit: 5,
    });
    const evidence = result.ok ? result.evidence : [];
    const rank = evidence.findIndex(item => isRelevant(item, expected)) + 1;
    if (rank > 0 && rank <= 3) hits3 += 1;
    if (rank > 0 && rank <= 5) hits5 += 1;
    if (rank > 0) reciprocalRank += 1 / rank;
    rows.push({
      query: expected.query,
      rank,
      top: evidence[0]
        ? { type: evidence[0].sourceType, locator: evidence[0].locator }
        : null,
    });
  }

  const total = QUERIES.length;
  const metrics = {
    queries: total,
    recallAt3: Number((hits3 / total).toFixed(4)),
    recallAt5: Number((hits5 / total).toFixed(4)),
    mrr: Number((reciprocalRank / total).toFixed(4)),
  };

  for (const row of rows) {
    console.log(`rank=${row.rank || '-'} query=${row.query} top=${row.top ? `${row.top.type}:${row.top.locator}` : 'none'}`);
  }
  console.log(`fixed-corpus retrieval eval: ${JSON.stringify(metrics)}`);

  if (process.argv.includes('--assert') && (metrics.recallAt5 < 0.9 || metrics.mrr < 0.75)) {
    console.error('retrieval eval below threshold');
    process.exitCode = 1;
  }
}

main().catch(error => {
  console.error('retrieval eval failed:', error && error.message ? error.message : 'unknown');
  process.exitCode = 1;
});
