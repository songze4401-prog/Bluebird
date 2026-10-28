/* global __dirname */
/**
 * 记忆概念语义召回专项测试（memory-semantic.test.js）
 *
 * 覆盖：
 *   A. 本地概念词典：同义、上下位、跨语言、大小写/边界、空命中
 *   B. 语义与关键词混合排序、低相关排除、事实更新/冲突
 *   C. 语义检索与会话/来源/状态/时间过滤组合
 *   D. 条数/长度/token 预算与可解释元数据
 *   E. 词面重合但无语义概念时不得虚报 semantic 命中
 *
 * 说明：概念语义不是神经 embedding；测试验证的是词典覆盖范围内的
 * 同义/跨语言召回，不把未覆盖表达宣称为向量语义。
 *
 * 运行：node tests/memory-semantic.test.js
 */
const fs = require('fs');
const os = require('os');
const path = require('path');

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'bluebird-memory-semantic-'));
process.env.BLUEBIRD_DATA_DIR = TMP;
process.env.MEMORY_ENABLED = 'true';

const memory = require(path.join(__dirname, '..', 'server', 'memory.js'));
const semantic = require(path.join(
  __dirname,
  '..',
  'server',
  'memory-semantic.js'
));
const { textLength, estimateTokens } = require(path.join(
  __dirname,
  '..',
  'server',
  'text-utils.js'
));

const SESSION_A = 's-semantic-a';
const SESSION_B = 's-semantic-b';
const DAY = 24 * 60 * 60 * 1000;
const NOW = Date.now();
const iso = daysAgo => new Date(NOW - daysAgo * DAY).toISOString();
const futureIso = daysAhead => new Date(NOW + daysAhead * DAY).toISOString();

let passed = 0;
let failed = 0;
const failures = [];

function check(name, cond, extra = '') {
  if (cond) {
    passed++;
    console.log(`  ✔ ${name}`);
  } else {
    failed++;
    failures.push(name + (extra ? ` — ${extra}` : ''));
    console.log(`  ✖ ${name}${extra ? ` — ${extra}` : ''}`);
  }
}

function mem(options) {
  const {
    content,
    type = 'fact',
    keywords = [],
    confidence = 0.9,
    status = 'active',
    sessionId = SESSION_A,
    sourceType = 'user',
    validFrom,
    validTo = null,
    createdAt,
    updatedAt,
    id,
  } = options;
  const created =
    createdAt !== undefined ? createdAt : validFrom !== undefined ? validFrom : iso(100);

  return {
    content,
    type,
    keywords,
    confidence,
    status,
    validFrom: validFrom !== undefined ? validFrom : created,
    validTo,
    createdAt: created,
    updatedAt: updatedAt !== undefined ? updatedAt : created,
    contributions: [
      {
        sessionId,
        sourceQuote: content,
        createdAt: created,
        ...(sourceType ? { sourceType } : {}),
      },
    ],
    ...(id ? { id } : {}),
  };
}

function seed(items) {
  fs.writeFileSync(
    path.join(TMP, 'memory.json'),
    JSON.stringify(items, null, 2),
    'utf8'
  );
  memory.loadMemories();
}

function contents(result) {
  return result.results.map(item => item.content);
}

function byId(result, id) {
  return result.results.find(item => item.id === id);
}

function baseStore() {
  return [
    mem({
      id: 'sem-coffee-cn',
      content: '用户喜欢喝美式咖啡',
      type: 'preference',
      keywords: [],
      sessionId: SESSION_A,
      sourceType: 'user',
      validFrom: iso(100),
      updatedAt: iso(7),
    }),
    mem({
      id: 'sem-coffee-en',
      content: 'coffee',
      type: 'preference',
      keywords: [],
      sessionId: SESSION_A,
      sourceType: 'user',
      validFrom: iso(99),
      updatedAt: iso(6),
    }),
    mem({
      id: 'sem-coffee-keyword',
      content: '用户喜欢喝咖啡',
      type: 'preference',
      keywords: ['coffee'],
      sessionId: SESSION_A,
      sourceType: 'user',
      validFrom: iso(98),
      updatedAt: iso(5),
    }),
    mem({
      id: 'sem-coffee-agent',
      content: '用户偏好早晨喝咖啡',
      type: 'preference',
      keywords: [],
      sessionId: SESSION_A,
      sourceType: 'agent',
      validFrom: iso(97),
      updatedAt: iso(4),
    }),
    mem({
      id: 'sem-cat',
      content: '用户养了一只叫年糕的猫',
      type: 'fact',
      keywords: [],
      sessionId: SESSION_A,
      sourceType: 'user',
      validFrom: iso(96),
      updatedAt: iso(7),
    }),
    mem({
      id: 'sem-editor',
      content: '用户常用编辑器是 Vim',
      type: 'fact',
      keywords: [],
      sessionId: SESSION_A,
      sourceType: 'user',
      validFrom: iso(95),
      updatedAt: iso(7),
    }),
    mem({
      id: 'sem-city-a',
      content: '用户住在杭州',
      type: 'fact',
      keywords: [],
      sessionId: SESSION_A,
      sourceType: 'user',
      validFrom: iso(94),
      updatedAt: iso(7),
    }),
    mem({
      id: 'sem-city-b',
      content: '用户住在上海',
      type: 'fact',
      keywords: [],
      sessionId: SESSION_B,
      sourceType: 'user',
      validFrom: iso(93),
      updatedAt: iso(7),
    }),
    mem({
      id: 'sem-superseded',
      content: '用户以前喝速溶咖啡',
      type: 'fact',
      keywords: [],
      status: 'superseded',
      sessionId: SESSION_A,
      sourceType: 'user',
      validFrom: iso(300),
      validTo: iso(50),
      updatedAt: iso(50),
    }),
    mem({
      id: 'sem-future',
      content: '用户将在明年喝咖啡',
      type: 'fact',
      keywords: [],
      sessionId: SESSION_A,
      sourceType: 'user',
      validFrom: futureIso(3650),
      updatedAt: iso(3),
    }),
    mem({
      id: 'sem-pending',
      content: '用户可能喜欢咖啡',
      type: 'preference',
      keywords: [],
      status: 'pending',
      sessionId: SESSION_A,
      sourceType: 'agent',
      validFrom: iso(92),
      updatedAt: iso(3),
    }),
    mem({
      id: 'sem-unrelated',
      content: '用户喜欢看电影',
      type: 'fact',
      keywords: [],
      sessionId: SESSION_A,
      sourceType: 'user',
      validFrom: iso(91),
      updatedAt: iso(7),
    }),
    mem({
      id: 'sem-missing-time',
      content: '用户咖啡时间未知',
      type: 'fact',
      keywords: [],
      sessionId: SESSION_A,
      sourceType: 'user',
      validFrom: null,
      createdAt: null,
      updatedAt: null,
    }),
    mem({
      id: 'sem-legacy-coffee',
      content: '用户常喝咖啡',
      type: 'fact',
      keywords: [],
      sessionId: null,
      sourceType: null,
      validFrom: iso(100),
      updatedAt: iso(7),
    }),
  ];
}

// ================= A. 概念词典与语义相似度 =================
console.log('\nA. 本地概念语义');
{
  const capability = semantic.semanticCapability();
  check(
    '能力元数据明确非神经、有限覆盖',
    capability.neural === false &&
      capability.limited === true &&
      capability.kind === 'concept_lexicon_v1' &&
      capability.blocked === 'neural_embedding_not_available' &&
      capability.conceptCount > 0,
    JSON.stringify(capability)
  );

  check(
    '同义：latte 与 美式咖啡 命中同一 coffee concept',
    semantic.semanticSimilarity('latte', '用户喜欢喝美式咖啡').score === 1
  );
  check(
    '跨语言：coffee 与 美式咖啡 命中同一 coffee concept',
    semantic.semanticSimilarity('coffee', '用户喜欢喝美式咖啡').score === 1
  );
  check(
    '跨语言：where do I live 与 住在杭州 命中 city concept',
    semantic.semanticSimilarity('where do I live', '用户住在杭州').score === 1
  );
  check(
    '英文边界：catalog 不应误命中 cat',
    semantic.semanticProfile('catalog').concepts.length === 0
  );
  check(
    '无关文本语义分为 0',
    semantic.semanticSimilarity('hello', '用户住在杭州').score === 0
  );
  check(
    '纯字符重合不会得到语义分（zz / zzzz）',
    semantic.semanticSimilarity('zz', 'zzzz').score === 0
  );
  check(
    '语义证据包含 concept 与双方命中的词典词',
    (() => {
      const result = semantic.semanticSimilarity(
        'coffee',
        '用户喜欢喝美式咖啡'
      );
      return (
        result.concepts.includes('coffee') &&
        result.evidence.some(
          item =>
            item.concept === 'coffee' &&
            item.queryTerms.includes('coffee') &&
            item.memoryTerms.some(term => term === '咖啡' || term === '美式')
        )
      );
    })()
  );

  check(
    '词典已扩展到至少 16 个可解释概念',
    capability.conceptCount >= 16 &&
      [
        'allergy',
        'theme',
        'project',
        'birthday',
        'exam',
        'computer',
        'spicy_food',
        'travel',
        'license_plate',
        'dietary_restriction',
      ].every(concept => capability.concepts.includes(concept)),
    JSON.stringify(capability.concepts)
  );
  check(
    '过敏：allergy 与中文“花粉/过敏”命中',
    semantic.semanticSimilarity('what am I allergic to', '用户对花粉过敏')
      .score === 1
  );
  check(
    '主题：theme 与中文“深色主题”命中',
    semantic.semanticSimilarity('what theme do I like', '用户偏好深色主题')
      .score === 1
  );
  check(
    '项目：project 与“项目/云岫/Bluebird”命中',
    semantic.semanticSimilarity('what project am I working on', '用户在开发云岫 Bluebird 项目')
      .score === 1
  );
  check(
    '生日：birthday 与中文“生日”命中',
    semantic.semanticSimilarity('when is my birthday', '用户的生日是3月14日')
      .score === 1
  );
  check(
    '考试：exam 与中文“研究生入学考试”命中',
    semantic.semanticSimilarity('what exam am I preparing for', '用户正在准备研究生入学考试')
      .score === 1
  );
  check(
    '电脑：computer 与“Windows/电脑”命中',
    semantic.semanticSimilarity('what computer do I use', '用户用 Windows 11 电脑做开发')
      .score === 1
  );
  check(
    '口味：spicy food 与“辣/湖南口味”命中',
    semantic.semanticSimilarity('do I like spicy food', '用户爱吃辣，偏好湖南口味')
      .score === 1
  );
  check(
    '出行：travel 与“出差”命中',
    semantic.semanticSimilarity('where did I travel', '用户上周去青岛出差')
      .score === 1
  );
  check(
    '车牌：license plate 与“车牌号”命中',
    semantic.semanticSimilarity('what is my license plate', '用户的车牌号是沪A12345')
      .score === 1
  );
  check(
    '饮食限制：avoid 与“不吃香菜”命中',
    semantic.semanticSimilarity('what food do I avoid', '用户不吃香菜')
      .score === 1
  );
  check(
    '职业：engineer 与“软件工程师”命中',
    semantic.semanticSimilarity('what is my job', '用户是软件工程师').score === 1
  );
  check(
    '昵称：nickname 与“小名”命中',
    semantic.semanticSimilarity('what is my nickname', '用户的小名是小蓝').score === 1
  );
  check(
    '反例：projector 不应被映射为 project',
    semantic.semanticProfile('projector').concepts.length === 0
  );
  check(
    '反例：正式姓名查询不应误召回昵称',
    semantic.semanticSimilarity('what is my name', '用户的小名是小蓝').score === 0
  );
  check(
    '反例：workstation 不应被映射为 job',
    semantic.semanticProfile('workstation').concepts.length === 0
  );
  check(
    '反例：tea 不应被映射为 coffee',
    !semantic.semanticProfile('tea').concepts.includes('coffee')
  );
}

// ================= B. 混合排序、低相关与事实更新 =================
console.log('\nB. 混合排序与事实有效性');
seed(baseStore());

{
  const coffee = memory.searchMemories({
    query: 'coffee',
    sessionId: SESSION_A,
    limits: { maxItems: 10, perItemMax: 300, totalMax: 4000 },
  });
  const coffeeIds = coffee.results.map(item => item.id);
  check(
    '跨语言查询召回中文咖啡记忆',
    contents(coffee).includes('用户喜欢喝美式咖啡') &&
      byId(coffee, 'sem-coffee-cn').components.semanticScore === 1,
    JSON.stringify(coffee.results.map(item => [item.id, item.components]))
  );
  check(
    '混合排序：英文词面+语义 > 关键词+语义 > 纯语义',
    coffeeIds.indexOf('sem-coffee-en') <
      coffeeIds.indexOf('sem-coffee-keyword') &&
      coffeeIds.indexOf('sem-coffee-keyword') <
        coffeeIds.indexOf('sem-coffee-cn'),
    JSON.stringify(coffeeIds)
  );
  check(
    '语义召回结果带命中理由、concept 与来源',
    byId(coffee, 'sem-coffee-cn').match.reason === 'concept' &&
      byId(coffee, 'sem-coffee-cn').match.semantic.matched === true &&
      byId(coffee, 'sem-coffee-cn')
        .match.semantic.concepts.includes('coffee') &&
      byId(coffee, 'sem-coffee-cn').sourceTypes.includes('user')
  );
  check(
    '语义分进入 components，供调试与验收',
    byId(coffee, 'sem-coffee-cn').components.semanticScore > 0 &&
      byId(coffee, 'sem-coffee-cn').components.hybridRelevance > 0 &&
      byId(coffee, 'sem-coffee-cn').components.semanticNeural === false &&
      byId(coffee, 'sem-coffee-cn').components.semanticLimited === true &&
      byId(coffee, 'sem-coffee-cn').components.semanticBlocked ===
        'neural_embedding_not_available'
  );
  check(
    '低相关候选被排除（猫/编辑器/城市/电影）',
    !coffeeIds.includes('sem-cat') &&
      !coffeeIds.includes('sem-editor') &&
      !coffeeIds.includes('sem-city-a') &&
      !coffeeIds.includes('sem-unrelated')
  );
  check(
    'pending、future、superseded 不进入当前语义检索',
    !coffeeIds.includes('sem-pending') &&
      !coffeeIds.includes('sem-future') &&
      !coffeeIds.includes('sem-superseded')
  );

  const latte = memory.searchMemories({
    query: 'latte',
    sessionId: SESSION_A,
    limits: { maxItems: 10 },
  });
  check(
    '同义查询 latte 召回英文与中文咖啡事实',
    contents(latte).includes('coffee') &&
      contents(latte).includes('用户喜欢喝美式咖啡') &&
      latte.results.every(item => item.match.semantic.matched === true)
  );

  const city = memory.searchMemories({
    query: 'where do I live',
    sessionId: SESSION_A,
    limits: { maxItems: 10 },
  });
  check(
    '跨语言城市查询只召回本会话城市事实',
    contents(city).includes('用户住在杭州') &&
      !contents(city).includes('用户住在上海') &&
      byId(city, 'sem-city-a').match.reason === 'concept'
  );

  const editor = memory.searchMemories({
    query: 'editor',
    sessionId: SESSION_A,
  });
  check(
    'editor 与 Vim 通过 editor concept 召回',
    contents(editor).includes('用户常用编辑器是 Vim')
  );

  const cat = memory.searchMemories({
    query: 'cat',
    sessionId: SESSION_A,
  });
  check(
    'cat 查询通过概念召回猫事实且不返回咖啡',
    contents(cat).includes('用户养了一只叫年糕的猫') &&
      !contents(cat).includes('用户喜欢喝美式咖啡')
  );

  const chineseCat = memory.searchMemories({
    query: '我的猫叫什么',
    sessionId: SESSION_A,
  });
  check(
    '中文猫/名字查询通过概念召回同一事实',
    contents(chineseCat).includes('用户养了一只叫年糕的猫') &&
      byId(chineseCat, 'sem-cat').match.semantic.concepts.includes('cat')
  );

  const bSession = memory.searchMemories({
    query: 'coffee',
    sessionId: SESSION_B,
  });
  check(
    '跨会话隔离：B 的 coffee 查询看不到 A 的咖啡',
    !contents(bSession).includes('用户喜欢喝美式咖啡') &&
      !contents(bSession).includes('coffee')
  );

  const nullSession = memory.searchMemories({
    query: 'coffee',
    sessionId: null,
  });
  check(
    '无会话身份只回退无归属旧数据',
    contents(nullSession).includes('用户常喝咖啡') &&
      !contents(nullSession).includes('用户喜欢喝美式咖啡')
  );

  const history = memory.searchMemories({
    query: 'coffee',
    sessionId: SESSION_A,
    mode: 'history',
    asOf: iso(75),
  });
  const old = byId(history, 'sem-superseded');
  const current = byId(history, 'sem-coffee-cn');
  check(
    '历史语义查询可读回被取代事实',
    Boolean(old) &&
      old.components.statusWeight === 0.45 &&
      old.match.semantic.matched === true
  );
  check(
    '旧事实不覆盖新事实：active 替代事实分数更高',
    old && current && current.score > old.score,
    JSON.stringify(old && current && [old.score, current.score])
  );
}

// ================= C. 语义 + 多维过滤组合 =================
console.log('\nC. 语义与过滤组合');
seed(baseStore());

{
  const agent = memory.searchMemories({
    query: 'coffee',
    sessionId: SESSION_A,
    filters: { sources: ['agent'] },
  });
  check(
    '语义查询 + 来源过滤只留 agent 来源',
    contents(agent).length === 1 &&
      contents(agent)[0] === '用户偏好早晨喝咖啡',
    JSON.stringify(contents(agent))
  );

  const legacySource = memory.searchMemories({
    query: 'coffee',
    sessionId: SESSION_A,
    filters: { sources: ['user'] },
  });
  check(
    '来源过滤：无 sourceType 的旧贡献不算匹配',
    !contents(legacySource).includes('用户常喝咖啡')
  );

  const recent = memory.searchMemories({
    query: 'coffee',
    sessionId: SESSION_A,
    filters: {
      timeFrom: iso(30),
      timeTo: iso(1),
      timeField: 'updated',
    },
  });
  check(
    '语义查询 + updated 时间窗',
    contents(recent).includes('用户喜欢喝美式咖啡') &&
      !contents(recent).includes('用户以前喝速溶咖啡')
  );
  check(
    '时间过滤：缺失 updatedAt 的语义候选不匹配',
    !contents(recent).includes('用户咖啡时间未知')
  );

  const supersededOnly = memory.searchMemories({
    query: 'coffee',
    sessionId: SESSION_A,
    mode: 'history',
    asOf: iso(75),
    filters: { statuses: ['superseded'] },
  });
  check(
    '语义查询 + history + superseded 过滤',
    contents(supersededOnly).includes('用户以前喝速溶咖啡') &&
      !contents(supersededOnly).includes('用户喜欢喝美式咖啡')
  );

  const combined = memory.searchMemories({
    query: 'coffee',
    sessionId: SESSION_A,
    filters: {
      sources: ['user'],
      statuses: ['active'],
      timeFrom: iso(30),
      timeTo: iso(1),
      timeField: 'updated',
    },
  });
  check(
    '语义 + 四维组合过滤结果只落在同一会话有效池',
    contents(combined).every(
      content =>
        content === '用户喜欢喝美式咖啡' ||
        content === 'coffee' ||
        content === '用户喜欢喝咖啡'
    ) &&
      !contents(combined).includes('用户偏好早晨喝咖啡') &&
      !contents(combined).includes('用户常喝咖啡'),
    JSON.stringify(contents(combined))
  );
}

// ================= D. 预算与可解释结果 =================
console.log('\nD. 语义检索预算与元数据');
seed(
  Array.from({ length: 10 }, (_, index) =>
    mem({
      id: `sem-budget-${index}`,
      content: `语义预算${index}：` + 'coffee '.repeat(40),
      type: 'fact',
      keywords: [],
      updatedAt: iso(7),
      validFrom: iso(100),
    })
  )
);

{
  const capped = memory.searchMemories({
    query: 'coffee',
    sessionId: SESSION_A,
    limits: { maxItems: 3, perItemMax: 300, totalMax: 5000, maxTokens: 4000 },
  });
  check(
    '语义结果受条数预算限制并标记 limitTruncated',
    capped.results.length === 3 &&
      capped.diagnostics.limitTruncated === true &&
      capped.diagnostics.notReturned.limit > 0
  );

  const tokenCapped = memory.searchMemories({
    query: 'coffee',
    sessionId: SESSION_A,
    limits: { maxItems: 10, perItemMax: 300, totalMax: 5000, maxTokens: 30 },
  });
  check(
    '语义结果受 token 预算限制',
    tokenCapped.estimatedTokens <= 30 &&
      tokenCapped.diagnostics.budgetTruncated === true &&
      tokenCapped.results.some(item => item.content.endsWith('…'))
  );
  check(
    '预算元数据明确 estimator 与语义 provider',
    tokenCapped.diagnostics.tokenEstimator === 'heuristic-cjk-ascii-v1' &&
      tokenCapped.diagnostics.semantic.provider === 'local-concept-lexicon' &&
      tokenCapped.diagnostics.semantic.neural === false &&
      tokenCapped.diagnostics.semantic.limited === true
  );
  check(
    '结果仍带 ID、语义命中理由与分项分数',
    tokenCapped.results.every(
      item =>
        typeof item.id === 'string' &&
        item.match.semantic.matched === true &&
        item.components.semanticScore > 0 &&
        typeof item.components.hybridRelevance === 'number'
    )
  );
  check(
    '单条字符预算仍生效',
    memory.searchMemories({
      query: 'coffee',
      sessionId: SESSION_A,
      limits: { maxItems: 3, perItemMax: 12, totalMax: 5000, maxTokens: 4000 },
    }).results.every(item => textLength(item.content) <= 12)
  );
  check(
    '结果估算 token 与内容一致',
    tokenCapped.estimatedTokens ===
      tokenCapped.results.reduce(
        (sum, item) => sum + estimateTokens(item.content),
        0
      )
  );
}

// ================= E. 词面重合不得虚报语义 =================
console.log('\nE. 词面重合 ≠ 语义');
seed([
  mem({
    id: 'sem-lexical-only',
    content: 'zzzz',
    type: 'fact',
    keywords: [],
    updatedAt: iso(7),
    validFrom: iso(100),
  }),
]);

{
  const result = memory.searchMemories({
    query: 'zz',
    sessionId: SESSION_A,
  });
  const item = byId(result, 'sem-lexical-only');
  check(
    'char bigram 命中仍可返回，但 semantic 必须为 0',
    Boolean(item) &&
      item.components.bigramScore > 0 &&
      item.components.semanticScore === 0 &&
      item.match.semantic.matched === false &&
      item.match.reason !== 'concept',
    JSON.stringify(item && item.components)
  );

  seed([
    mem({
      id: 'sem-low-noise',
      content: '用户用 Windows 11 电脑做开发',
      type: 'fact',
      keywords: [],
      updatedAt: iso(7),
      validFrom: iso(100),
    }),
  ]);

  const noise = memory.searchMemories({
    query: 'what do I use',
    sessionId: SESSION_A,
  });
  check(
    '低相关英文二元组噪声被 MIN_RELEVANCE 拒绝',
    noise.results.length === 0,
    JSON.stringify(noise.results.map(item => [item.id, item.relevance]))
  );
}

// ================= 汇总 =================
try {
  fs.rmSync(TMP, { recursive: true, force: true });
} catch (_) {
  /* Windows 占用：忽略 */
}

console.log(`\n通过 ${passed} 项，失败 ${failed} 项`);
if (failures.length) {
  console.log('失败项：');
  for (const failure of failures) console.log(`  - ${failure}`);
}
process.exit(failed === 0 ? 0 : 1);
