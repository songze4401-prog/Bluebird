/* global __dirname */
/**
 * 记忆语义检索固定评测（memory-semantic-eval.js）
 *
 * 数据来源：tests/memory-eval/fixtures.js 的 22 条脱敏种子（不含真实用户数据），
 * 另加 4 条固定评测条目：新旧咖啡事实、未来生效事实、agent 来源咖啡偏好。
 * 每个查询明确写出 expect / forbid / session / mode，可重复运行并输出：
 *   Recall@5、Recall@10、MRR（非 identity 额外项不计入排序）、forbidden hits、
 *   无答案泄漏、排序失败，以及实际入口（memory_search 工具 / buildMemoryContext）
 *   和预算/小库旁路的端到端检查。
 *
 * 运行：
 *   node tests/memory-semantic-eval.js --json-out=/tmp/semantic.json
 *   node tests/memory-semantic-eval.js --assert
 *
 * --assert 只用于扩展词典后的质量闸门；基线（旧词典）可先不带 --assert 跑，
 * 保存报告用于前后对比。报告不包含真实数据。
 */
const fs = require('fs');
const os = require('os');
const path = require('path');

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'bluebird-semantic-eval-'));
process.env.BLUEBIRD_DATA_DIR = TMP;
process.env.MEMORY_ENABLED = 'true';

const {
  SESSIONS,
  registry,
  seed: fixtureSeed,
} = require('./memory-eval/fixtures');

const MAIN = SESSIONS.main;
const WORK = SESSIONS.work;
const PET = SESSIONS.pet;

const EXTRA_SEEDS = [
  {
    id: 'M23',
    content: '用户以前只喝速溶咖啡',
    type: 'preference',
    keywords: ['咖啡', '速溶'],
    confidence: 0.9,
    status: 'superseded',
    validFrom: '2026-09-01T00:00:00.000Z',
    validTo: '2026-10-01T00:00:00.000Z',
    createdAt: '2026-09-01T00:00:00.000Z',
    updatedAt: '2026-10-01T00:00:00.000Z',
    supersededBy: 'M24',
    contributions: [
      {
        sessionId: MAIN,
        sourceQuote: '我以前只喝速溶咖啡',
        createdAt: '2026-09-01T00:00:00.000Z',
        sourceType: 'user',
      },
    ],
  },
  {
    id: 'M24',
    content: '用户现在只喝美式咖啡',
    type: 'preference',
    keywords: ['咖啡', '美式'],
    confidence: 0.95,
    status: 'active',
    validFrom: '2026-10-02T00:00:00.000Z',
    createdAt: '2026-10-02T00:00:00.000Z',
    updatedAt: '2026-10-20T00:00:00.000Z',
    contributions: [
      {
        sessionId: MAIN,
        sourceQuote: '我现在只喝美式咖啡',
        createdAt: '2026-10-02T00:00:00.000Z',
        sourceType: 'user',
      },
    ],
  },
  {
    id: 'M25',
    content: '用户计划明年喝咖啡',
    type: 'goal',
    keywords: ['咖啡'],
    confidence: 0.9,
    status: 'active',
    validFrom: '2027-01-01T00:00:00.000Z',
    createdAt: '2026-10-20T00:00:00.000Z',
    updatedAt: '2026-10-20T00:00:00.000Z',
    contributions: [
      {
        sessionId: MAIN,
        sourceQuote: '我计划明年喝咖啡',
        createdAt: '2026-10-20T00:00:00.000Z',
        sourceType: 'user',
      },
    ],
  },
  {
    id: 'M26',
    content: '用户偏好手冲咖啡',
    type: 'preference',
    keywords: ['咖啡', '手冲'],
    confidence: 0.95,
    status: 'active',
    validFrom: '2026-10-20T00:00:00.000Z',
    createdAt: '2026-10-20T00:00:00.000Z',
    updatedAt: '2026-10-20T00:00:00.000Z',
    contributions: [
      {
        sessionId: MAIN,
        sourceQuote: '我偏好手冲咖啡',
        createdAt: '2026-10-20T00:00:00.000Z',
        sourceType: 'agent',
      },
    ],
  },
];

const contentToId = registry();
for (const item of EXTRA_SEEDS) contentToId.set(item.content, item.id);

const store = [...fixtureSeed(), ...EXTRA_SEEDS.map(({ id, ...rest }) => rest)];
fs.writeFileSync(
  path.join(TMP, 'memory.json'),
  JSON.stringify(store, null, 2),
  'utf8'
);

const memory = require('../server/memory');
const memoryTool = require('../server/tool-memory-search');

const IDENTITY_IDS = new Set(['M03', 'M18']);

// expect / forbid 都用评测侧稳定 id；session 决定可见池；mode/asOf 只用于历史题。
const QUESTIONS = [
  {
    id: 'Q01',
    cat: '同义/跨语言咖啡',
    session: MAIN,
    query: 'coffee',
    expect: ['M01', 'M17', 'M24', 'M26'],
    forbid: ['M23', 'M25', 'M04', 'M09'],
  },
  {
    id: 'Q02',
    cat: '同义 latte',
    session: MAIN,
    query: 'latte',
    expect: ['M01', 'M17', 'M24', 'M26'],
    forbid: ['M23', 'M25'],
  },
  {
    id: 'Q03',
    cat: '上下位/工具',
    session: MAIN,
    query: 'what editor do I use',
    expect: ['M21'],
    forbid: ['M04', 'M09'],
    first: 'M21',
  },
  {
    id: 'Q04',
    cat: '跨语言城市',
    session: WORK,
    query: 'where do I live',
    expect: ['M05'],
    forbid: ['M01', 'M09'],
    first: 'M05',
  },
  {
    id: 'Q05',
    cat: '跨语言宠物',
    session: PET,
    query: 'what is my cat called',
    expect: ['M09'],
    forbid: ['M01', 'M05'],
    first: 'M09',
  },
  {
    id: 'Q06',
    cat: '跨语言过敏',
    session: MAIN,
    query: 'what am I allergic to',
    expect: ['M10'],
    forbid: ['M02', 'M09'],
    first: 'M10',
  },
  {
    id: 'Q07',
    cat: '跨语言主题',
    session: MAIN,
    query: 'what theme do I like',
    expect: ['M08'],
    forbid: ['M02', 'M09'],
    first: 'M08',
  },
  {
    id: 'Q08',
    cat: '跨语言项目',
    session: MAIN,
    query: 'what project am I working on',
    expect: ['M06'],
    forbid: ['M22', 'M04'],
    first: 'M06',
  },
  {
    id: 'Q09',
    cat: '跨语言生日',
    session: MAIN,
    query: 'when is my birthday',
    expect: ['M19'],
    forbid: ['M02', 'M09'],
    first: 'M19',
  },
  {
    id: 'Q10',
    cat: '跨语言考试',
    session: PET,
    query: 'what exam am I preparing for',
    expect: ['M20'],
    forbid: ['M01', 'M05'],
    first: 'M20',
  },
  {
    id: 'Q11',
    cat: '跨语言电脑',
    session: MAIN,
    query: 'what computer do I use',
    expect: ['M16'],
    forbid: ['M02', 'M09'],
    first: 'M16',
  },
  {
    id: 'Q12',
    cat: '跨语言口味',
    session: MAIN,
    query: 'do I like spicy food',
    expect: ['M15'],
    forbid: ['M02', 'M09'],
    first: 'M15',
  },
  {
    id: 'Q13',
    cat: '跨语言出行',
    session: MAIN,
    query: 'where did I travel',
    expect: ['M13'],
    forbid: ['M05', 'M09'],
    first: 'M13',
  },
  {
    id: 'Q14',
    cat: '跨语言车牌',
    session: WORK,
    query: 'what is my license plate',
    expect: ['M04'],
    forbid: ['M01', 'M05'],
    first: 'M04',
  },
  {
    id: 'Q15',
    cat: '跨语言饮食限制',
    session: MAIN,
    query: 'what food do I avoid',
    expect: ['M02'],
    forbid: ['M01', 'M09'],
    first: 'M02',
  },
  {
    id: 'Q16',
    cat: '名字',
    session: MAIN,
    query: 'what is my name',
    expect: ['M03'],
    forbid: [],
    first: 'M03',
  },
  {
    id: 'Q17',
    cat: '职业',
    session: MAIN,
    query: 'what do I do for work',
    expect: ['M18'],
    forbid: ['M01', 'M09'],
    first: 'M18',
  },
  {
    id: 'Q18',
    cat: '历史/旧事实',
    session: MAIN,
    query: 'coffee',
    mode: 'history',
    asOf: '2026-09-15T00:00:00.000Z',
    expect: ['M23'],
    forbid: ['M24', 'M01', 'M17', 'M26'],
    first: 'M23',
  },
  {
    id: 'Q19',
    cat: '无关查询',
    session: WORK,
    query: 'unrelated quantum banana',
    expect: [],
    forbid: ['M04', 'M05', 'M22'],
  },
  {
    id: 'Q20',
    cat: '跨会话城市隔离',
    session: MAIN,
    query: 'where do I live',
    expect: [],
    forbid: ['M05'],
    allow: ['M03', 'M18'],
  },
  {
    id: 'Q21',
    cat: '跨会话宠物隔离',
    session: MAIN,
    query: 'what is my cat called',
    expect: [],
    forbid: ['M09'],
    allow: ['M03', 'M18'],
  },
  {
    id: 'Q22',
    cat: '跨会话车牌隔离',
    session: MAIN,
    query: 'what is my license plate',
    expect: [],
    forbid: ['M04'],
    allow: ['M03', 'M18'],
  },
];

function idOf(content) {
  return contentToId.get(content) || null;
}

function idsOf(result) {
  return result.results.map(item => idOf(item.content)).filter(Boolean);
}

function rankedIds(ids, expected) {
  return ids.filter(id => !IDENTITY_IDS.has(id) || expected.includes(id));
}

function runQuestion(question) {
  const result = memory.searchMemories({
    query: question.query,
    sessionId: question.session,
    mode: question.mode || 'current',
    asOf: question.asOf || null,
    limits: {
      maxItems: 10,
      perItemMax: 300,
      totalMax: 2000,
      maxTokens: 1200,
    },
  });
  const ids = idsOf(result);
  const top5 = ids.slice(0, 5);
  const top10 = ids.slice(0, 10);
  const hits5 = question.expect.filter(id => top5.includes(id));
  const hits10 = question.expect.filter(id => top10.includes(id));
  const expected = question.expect;
  const ranked = rankedIds(ids, expected);
  const firstRank = expected.length
    ? Math.min(
        ...expected
          .map(id => ranked.indexOf(id))
          .filter(index => index >= 0)
      )
    : -1;
  const mrr = expected.length
    ? Number.isFinite(firstRank) && firstRank >= 0
      ? 1 / (firstRank + 1)
      : 0
    : null;
  const forbiddenHits = ids.filter(id => question.forbid.includes(id));
  const unexpected = expected.length
    ? []
    : ids.filter(id => !(question.allow || []).includes(id));
  const orderingFailure = question.first
    ? ranked[0] !== question.first
    : false;

  return {
    id: question.id,
    cat: question.cat,
    session: question.session,
    query: question.query,
    mode: question.mode || 'current',
    expected,
    retrieved: ids,
    recall5: expected.length ? hits5.length / expected.length : null,
    recall10: expected.length ? hits10.length / expected.length : null,
    mrr,
    forbiddenHits,
    unexpectedNoAnswer: unexpected,
    orderingFailure,
    semantic: result.diagnostics.semantic,
    truncated: result.truncated,
    resultCount: ids.length,
  };
}

function mean(values) {
  return values.length
    ? Number(
        (
          values.reduce((sum, value) => sum + value, 0) / values.length
        ).toFixed(6)
      )
    : 0;
}

function evaluate() {
  const perQuestion = QUESTIONS.map(runQuestion);
  const answerable = perQuestion.filter(item => item.expected.length);
  const noAnswer = perQuestion.filter(item => !item.expected.length);
  const metrics = {
    queryCount: QUESTIONS.length,
    answerableCount: answerable.length,
    noAnswerCount: noAnswer.length,
    recallAt5: mean(answerable.map(item => item.recall5)),
    recallAt10: mean(answerable.map(item => item.recall10)),
    mrr: mean(answerable.map(item => item.mrr)),
    forbiddenHitCount: perQuestion.reduce(
      (sum, item) => sum + item.forbiddenHits.length,
      0
    ),
    noAnswerLeakCount: noAnswer.reduce(
      (sum, item) => sum + item.unexpectedNoAnswer.length,
      0
    ),
    orderingFailureCount: perQuestion.filter(item => item.orderingFailure)
      .length,
    unmappedResultCount: perQuestion.reduce(
      (sum, item) => sum + item.retrieved.filter(id => !id).length,
      0
    ),
  };

  return { perQuestion, metrics };
}

async function e2eChecks() {
  const checks = {};

  const themeQuery = QUESTIONS.find(item => item.id === 'Q07');
  const themeInput = memoryTool.definition.validate({
    query: themeQuery.query,
    limit: 5,
  });
  const themeTool = await memoryTool.definition.handler(themeInput.args, {
    sessionId: themeQuery.session,
  });
  const themeToolIds = themeTool.results.map(item => idOf(item.content));
  checks.toolReturnsExpected =
    themeToolIds.includes('M08') &&
    themeTool.results.some(
      item => item.match && item.match.semantic && item.match.semantic.matched
    );

  const context = memory.buildMemoryContext(
    themeQuery.query,
    themeQuery.session
  );
  checks.contextContainsExpected = context.includes('深色主题');
  checks.contextHasNoCrossSession =
    !context.includes('车牌号') && !context.includes('小雪');

  const source = memory.searchMemories({
    query: 'coffee',
    sessionId: MAIN,
    filters: { sources: ['agent'] },
    limits: { maxItems: 10 },
  });
  checks.sourceFilterReturnsAgentOnly =
    idsOf(source).length === 1 && idsOf(source)[0] === 'M26';

  const budget = memory.searchMemories({
    query: 'coffee',
    sessionId: MAIN,
    filters: { sources: ['agent'] },
    limits: { maxItems: 2, perItemMax: 20, totalMax: 100, maxTokens: 5 },
  });
  checks.budgetLimited =
    budget.results.length <= 2 &&
    budget.estimatedTokens <= 20 &&
    budget.diagnostics.budgetTruncated === true;
  checks.budgetMetadata =
    budget.diagnostics.tokenEstimator === 'heuristic-cjk-ascii-v1' &&
    budget.diagnostics.semantic.provider === 'local-concept-lexicon';

  const explainable = memory.searchMemories({
    query: themeQuery.query,
    sessionId: themeQuery.session,
  });
  const explainableItem = explainable.results.find(
    item => idOf(item.content) === 'M08'
  );
  checks.explainability =
    Boolean(explainableItem) &&
    explainableItem.id &&
    explainableItem.match.semantic.matched === true &&
    explainableItem.components.semanticScore > 0 &&
    Array.isArray(explainableItem.match.semantic.concepts);

  // 小库旁路：只留 identity + 一条无关偏好，问无关问题时不得把它全量注入。
  const smallStore = [
    {
      content: '用户叫宋泽',
      type: 'identity',
      keywords: ['名字'],
      confidence: 0.95,
      validFrom: '2026-10-01T00:00:00.000Z',
      createdAt: '2026-10-01T00:00:00.000Z',
      updatedAt: '2026-10-01T00:00:00.000Z',
      contributions: [
        {
          sessionId: MAIN,
          sourceQuote: '我叫宋泽',
          createdAt: '2026-10-01T00:00:00.000Z',
        },
      ],
    },
    {
      content: '用户喜欢深夜看球',
      type: 'preference',
      keywords: ['球赛'],
      confidence: 0.9,
      validFrom: '2026-10-01T00:00:00.000Z',
      createdAt: '2026-10-01T00:00:00.000Z',
      updatedAt: '2026-10-01T00:00:00.000Z',
      contributions: [
        {
          sessionId: MAIN,
          sourceQuote: '我喜欢深夜看球',
          createdAt: '2026-10-01T00:00:00.000Z',
        },
      ],
    },
  ];
  fs.writeFileSync(
    path.join(TMP, 'memory.json'),
    JSON.stringify(smallStore, null, 2),
    'utf8'
  );
  memory.loadMemories();
  const small = memory.searchMemories({
    query: 'quantum banana',
    sessionId: MAIN,
  });
  checks.smallStoreNoFullInjection =
    !small.results.some(item => item.content === '用户喜欢深夜看球') &&
    small.results.every(item => item.type === 'identity');

  // 恢复固定数据集，避免后续运行/诊断受小库影响。
  fs.writeFileSync(
    path.join(TMP, 'memory.json'),
    JSON.stringify(store, null, 2),
    'utf8'
  );
  memory.loadMemories();

  return checks;
}

async function main() {
  const jsonArg = process.argv.find(arg => arg.startsWith('--json-out='));
  const jsonOut = jsonArg ? jsonArg.slice('--json-out='.length) : null;
  const assertMode = process.argv.includes('--assert');

  const evaluation = evaluate();
  const checks = await e2eChecks();
  const semantic = memory.searchMemories({
    query: 'coffee',
    sessionId: MAIN,
  }).diagnostics.semantic;

  const report = {
    meta: {
      date: '2026-10-28',
      fixedStoreSize: store.length,
      queryCount: QUESTIONS.length,
      semanticProvider: semantic.provider,
      semanticKind: semantic.kind,
      neural: semantic.neural,
      limited: semantic.limited,
      blocked: semantic.blocked,
      identityPolicy: 'identity 条目按产品规则保底；MRR 只对非 identity 额外项计序',
    },
    metrics: evaluation.metrics,
    checks,
    perQuestion: evaluation.perQuestion,
  };

  if (jsonOut) {
    fs.writeFileSync(jsonOut, JSON.stringify(report, null, 2), 'utf8');
  }

  console.log(`固定数据集：${store.length} 条，查询：${QUESTIONS.length}`);
  for (const item of evaluation.perQuestion) {
    console.log(
      `${item.id} ${item.cat}: recall@5=${item.recall5 == null ? '-' : item.recall5.toFixed(3)}` +
        ` recall@10=${item.recall10 == null ? '-' : item.recall10.toFixed(3)}` +
        ` mrr=${item.mrr == null ? '-' : item.mrr.toFixed(3)}` +
        ` forbidden=${JSON.stringify(item.forbiddenHits)}` +
        `${item.orderingFailure ? ' ORDER-FAIL' : ''}`
    );
  }
  console.log(
    `汇总：Recall@5=${evaluation.metrics.recallAt5} Recall@10=${evaluation.metrics.recallAt10} ` +
      `MRR=${evaluation.metrics.mrr} forbidden=${evaluation.metrics.forbiddenHitCount} ` +
      `noAnswerLeaks=${evaluation.metrics.noAnswerLeakCount} orderingFailures=${evaluation.metrics.orderingFailureCount}`
  );
  console.log('端到端检查：', JSON.stringify(checks));

  try {
    fs.rmSync(TMP, { recursive: true, force: true });
  } catch (_) {
    /* Windows 占用：忽略 */
  }

  if (!assertMode) process.exit(0);

  const failures = [];
  if (evaluation.metrics.recallAt5 < 0.9) {
    failures.push(`Recall@5 ${evaluation.metrics.recallAt5} < 0.9`);
  }
  if (evaluation.metrics.recallAt10 < 0.95) {
    failures.push(`Recall@10 ${evaluation.metrics.recallAt10} < 0.95`);
  }
  if (evaluation.metrics.mrr < 0.85) {
    failures.push(`MRR ${evaluation.metrics.mrr} < 0.85`);
  }
  if (evaluation.metrics.forbiddenHitCount !== 0) {
    failures.push(
      `forbidden hits ${evaluation.metrics.forbiddenHitCount} !== 0`
    );
  }
  if (evaluation.metrics.noAnswerLeakCount !== 0) {
    failures.push(
      `no-answer leaks ${evaluation.metrics.noAnswerLeakCount} !== 0`
    );
  }
  if (evaluation.metrics.orderingFailureCount !== 0) {
    failures.push(
      `ordering failures ${evaluation.metrics.orderingFailureCount} !== 0`
    );
  }
  for (const [name, ok] of Object.entries(checks)) {
    if (ok !== true) failures.push(`e2e check failed: ${name}`);
  }

  if (failures.length) {
    console.error(`✖ 语义检索评测失败（${failures.length} 项）`);
    for (const failure of failures) console.error(`  - ${failure}`);
    process.exit(1);
  }

  console.log('✔ 语义检索评测通过');
  process.exit(0);
}

main().catch(error => {
  console.error('语义评测运行异常：', error && error.stack ? error.stack : error);
  process.exit(1);
});
