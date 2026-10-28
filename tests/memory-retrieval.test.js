/* global __dirname */
/**
 * 记忆检索引擎专项验收（memory-retrieval.test.js）
 *
 * 覆盖本轮新增能力：
 *   A. 会话 / 来源 / 状态 / 时间范围四维过滤与组合过滤
 *   B. 关键词 + 词面二元组相关度、类型权重、时间衰减、状态权重
 *   C. 条数 / 单条长度 / 字符 / token 四类预算与截断元数据
 *   D. 命中理由、分项评分、来源、ID、未返回原因等可解释结果
 *   E. 小记忆库不得绕过相关性过滤
 *
 * 说明：字符二元组是词面分；概念语义分来自 memory-semantic.js 的本地词典
 * （同义/上下位/中英跨语言），标记为 semanticKind='concept_lexicon_v1'，
 * 不是神经 embedding；开放域语义仍见 docs/memory-semantic.md 的阻塞说明。
 *
 * 运行：node tests/memory-retrieval.test.js
 */
const fs = require('fs');
const os = require('os');
const path = require('path');

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'bluebird-memory-retrieval-'));
process.env.BLUEBIRD_DATA_DIR = TMP;
process.env.MEMORY_ENABLED = 'true';

const memory = require(path.join(__dirname, '..', 'server', 'memory.js'));
const memoryTool = require(path.join(
  __dirname,
  '..',
  'server',
  'tool-memory-search.js'
));
const { textLength, estimateTokens } = require(path.join(
  __dirname,
  '..',
  'server',
  'text-utils.js'
));

const SESSION_A = 's-a';
const SESSION_B = 's-b';
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
    lastDecision,
  } = options;
  const created =
    createdAt !== undefined ? createdAt : validFrom !== undefined ? validFrom : iso(100);
  const entry = {
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
    ...(lastDecision ? { lastDecision } : {}),
  };

  return entry;
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
      id: 'a-user-coffee',
      content: '用户喜欢喝美式咖啡',
      type: 'preference',
      keywords: ['咖啡'],
      sessionId: SESSION_A,
      sourceType: 'user',
      validFrom: iso(100),
      updatedAt: iso(7),
    }),
    mem({
      id: 'a-agent-coffee',
      content: '用户偏好早晨喝咖啡',
      type: 'preference',
      keywords: ['咖啡'],
      sessionId: SESSION_A,
      sourceType: 'agent',
      validFrom: iso(99),
      updatedAt: iso(6),
    }),
    mem({
      id: 'a-legacy-coffee',
      content: '用户常喝咖啡',
      type: 'fact',
      keywords: ['咖啡'],
      sessionId: SESSION_A,
      sourceType: null,
      validFrom: iso(98),
      updatedAt: iso(5),
    }),
    mem({
      id: 'b-user-coffee',
      content: '用户喝咖啡只喝拿铁',
      type: 'preference',
      keywords: ['咖啡', '拿铁'],
      sessionId: SESSION_B,
      sourceType: 'user',
      validFrom: iso(97),
      updatedAt: iso(4),
    }),
    mem({
      id: 'a-superseded-coffee',
      content: '用户以前喝速溶咖啡',
      type: 'fact',
      keywords: ['咖啡'],
      status: 'superseded',
      sessionId: SESSION_A,
      sourceType: 'user',
      validFrom: iso(300),
      validTo: iso(50),
      updatedAt: iso(50),
    }),
    mem({
      id: 'a-archived-coffee',
      content: '用户曾在咖啡店工作',
      type: 'fact',
      keywords: ['咖啡'],
      status: 'archived',
      sessionId: SESSION_A,
      sourceType: 'user',
      validFrom: iso(400),
      validTo: iso(350),
      updatedAt: iso(350),
    }),
    mem({
      id: 'a-future-coffee',
      content: '用户将去咖啡庄园',
      type: 'fact',
      keywords: ['咖啡'],
      sessionId: SESSION_A,
      sourceType: 'agent',
      validFrom: futureIso(3650),
      updatedAt: iso(3),
    }),
    mem({
      id: 'a-old-origin',
      content: '用户喜欢喝咖啡豆产地是云南',
      type: 'fact',
      keywords: ['咖啡豆'],
      sessionId: SESSION_A,
      sourceType: 'user',
      validFrom: iso(250),
      updatedAt: iso(250),
    }),
    mem({
      id: 'a-new-origin',
      content: '用户喜欢喝咖啡豆产地是云南保山',
      type: 'fact',
      keywords: ['咖啡豆'],
      sessionId: SESSION_A,
      sourceType: 'user',
      validFrom: iso(20),
      updatedAt: iso(7),
    }),
    mem({
      id: 'a-identity',
      content: '用户叫宋泽',
      type: 'identity',
      keywords: ['名字'],
      sessionId: SESSION_A,
      sourceType: 'user',
      validFrom: iso(100),
      updatedAt: iso(7),
    }),
    mem({
      id: 'a-cat',
      content: '用户养了一只猫',
      type: 'fact',
      keywords: ['猫'],
      sessionId: SESSION_A,
      sourceType: 'user',
      validFrom: iso(100),
      updatedAt: iso(7),
    }),
    mem({
      id: 'a-missing-time',
      content: '用户咖啡时间未知',
      type: 'fact',
      keywords: ['咖啡'],
      sessionId: SESSION_A,
      sourceType: 'user',
      validFrom: null,
      createdAt: null,
      updatedAt: null,
    }),
    mem({
      id: 'legacy-nickname',
      content: '用户常用昵称是小蓝',
      type: 'identity',
      keywords: ['昵称'],
      sessionId: null,
      sourceType: 'user',
      validFrom: iso(100),
      updatedAt: iso(7),
    }),
  ];
}

function rankStore() {
  return [
    mem({
      id: 'rank-keyword',
      content: '用户喜欢喝美式咖啡',
      type: 'preference',
      keywords: ['咖啡'],
      updatedAt: iso(7),
      validFrom: iso(100),
    }),
    mem({
      id: 'rank-content',
      content: '用户常喝咖啡',
      type: 'fact',
      keywords: [],
      updatedAt: iso(7),
      validFrom: iso(100),
    }),
    mem({
      id: 'rank-cat-pref',
      content: '用户喜欢猫',
      type: 'preference',
      keywords: ['猫'],
      updatedAt: iso(7),
      validFrom: iso(100),
    }),
    mem({
      id: 'rank-cat-fact',
      content: '用户喜欢猫',
      type: 'fact',
      keywords: ['猫'],
      updatedAt: iso(7),
      validFrom: iso(100),
    }),
    mem({
      id: 'rank-old-fact',
      content: '用户喝咖啡豆产地云南',
      type: 'fact',
      keywords: ['咖啡豆'],
      updatedAt: iso(250),
      validFrom: iso(250),
    }),
    mem({
      id: 'rank-new-fact',
      content: '用户喝咖啡豆产地云南',
      type: 'fact',
      keywords: ['咖啡豆'],
      updatedAt: iso(7),
      validFrom: iso(250),
    }),
    mem({
      id: 'rank-stable-pref',
      content: '用户喜欢喝美式咖啡',
      type: 'preference',
      keywords: ['咖啡'],
      updatedAt: iso(400),
      validFrom: iso(400),
    }),
    mem({
      id: 'rank-superseded',
      content: '用户喝咖啡只喝速溶',
      type: 'fact',
      keywords: ['咖啡'],
      status: 'superseded',
      validFrom: iso(300),
      validTo: iso(50),
      updatedAt: iso(50),
    }),
    mem({
      id: 'rank-replacement',
      content: '用户喝咖啡只喝美式',
      type: 'fact',
      keywords: ['咖啡'],
      validFrom: iso(100),
      updatedAt: iso(7),
    }),
    mem({
      id: 'rank-identity',
      content: '用户叫宋泽',
      type: 'identity',
      keywords: ['名字'],
      updatedAt: iso(7),
      validFrom: iso(100),
    }),
    mem({
      id: 'rank-cat-unrelated',
      content: '用户养了一只猫',
      type: 'fact',
      keywords: ['猫'],
      updatedAt: iso(7),
      validFrom: iso(100),
    }),
  ];
}

function budgetStore() {
  return Array.from({ length: 10 }, (_, index) =>
    mem({
      id: `budget-${index}`,
      content: `预算记忆${index}：` + '咖啡'.repeat(40),
      type: 'fact',
      keywords: ['咖啡'],
      updatedAt: iso(7),
      validFrom: iso(100),
    })
  );
}

// ================= A. 四维过滤 =================
console.log('\nA. 多维过滤（会话/来源/状态/时间）');
seed(baseStore());

{
  const result = memory.searchMemories({
    query: '咖啡',
    sessionId: SESSION_A,
    limits: { maxItems: 10, perItemMax: 300, totalMax: 2000 },
  });
  const list = contents(result);
  check(
    '当前会话：返回本会话有效条目',
    list.includes('用户喜欢喝美式咖啡') &&
      list.includes('用户偏好早晨喝咖啡') &&
      list.includes('用户常喝咖啡'),
    JSON.stringify(list)
  );
  check(
    '当前会话：不含其他会话的拿铁',
    !list.some(content => content.includes('拿铁')),
    JSON.stringify(list)
  );
  check(
    '当前会话：superseded/archived/未来生效条目被排除',
    !list.some(
      content =>
        content.includes('速溶') ||
        content.includes('咖啡店工作') ||
        content.includes('咖啡庄园')
    ),
    JSON.stringify(list)
  );
  check(
    '诊断：会话作用域与可见性排除计数 > 0',
    result.diagnostics.excluded.session_scope > 0 &&
      result.diagnostics.excluded.visibility > 0,
    JSON.stringify(result.diagnostics.excluded)
  );

  const agentOnly = memory.searchMemories({
    query: '咖啡',
    sessionId: SESSION_A,
    filters: { sources: ['agent'] },
  });
  check(
    '来源过滤：只返回 agent 来源',
    contents(agentOnly).length === 1 &&
      contents(agentOnly)[0] === '用户偏好早晨喝咖啡',
    JSON.stringify(contents(agentOnly))
  );

  const userOnly = memory.searchMemories({
    query: '咖啡',
    sessionId: SESSION_A,
    filters: { sources: ['user'] },
  });
  check(
    '来源过滤：没有 sourceType 的旧贡献不算匹配',
    !contents(userOnly).includes('用户常喝咖啡') &&
      !contents(userOnly).includes('用户偏好早晨喝咖啡'),
    JSON.stringify(contents(userOnly))
  );

  const activeOnly = memory.searchMemories({
    query: '咖啡',
    sessionId: SESSION_A,
    filters: { statuses: ['active'] },
  });
  check(
    '状态过滤：current 下 active 过滤不改变有效集',
    contents(activeOnly).includes('用户喜欢喝美式咖啡') &&
      !contents(activeOnly).some(content => content.includes('速溶')),
    JSON.stringify(contents(activeOnly))
  );

  const historySuperseded = memory.searchMemories({
    query: '咖啡',
    sessionId: SESSION_A,
    mode: 'history',
    asOf: iso(75),
    filters: { statuses: ['superseded'] },
  });
  check(
    '状态过滤：history + superseded 能读回旧事实',
    contents(historySuperseded).includes('用户以前喝速溶咖啡') &&
      !contents(historySuperseded).includes('用户喜欢喝美式咖啡'),
    JSON.stringify(contents(historySuperseded))
  );

  const recentUpdated = memory.searchMemories({
    query: '咖啡',
    sessionId: SESSION_A,
    filters: {
      timeFrom: iso(30),
      timeTo: iso(1),
      timeField: 'updated',
    },
  });
  check(
    '时间过滤（updated）：只保留窗口内更新的条目',
    contents(recentUpdated).includes('用户喜欢喝美式咖啡') &&
      !contents(recentUpdated).includes('用户喜欢喝咖啡豆产地是云南'),
    JSON.stringify(contents(recentUpdated))
  );
  check(
    '时间过滤：缺失 updatedAt 的条目不算匹配',
    !contents(recentUpdated).includes('用户咖啡时间未知')
  );

  const validWindow = memory.searchMemories({
    query: '咖啡',
    sessionId: SESSION_A,
    filters: {
      timeFrom: iso(90),
      timeTo: iso(10),
      timeField: 'valid',
    },
  });
  check(
    '时间过滤（valid）：有效期与窗口相交才匹配',
    contents(validWindow).includes('用户喜欢喝美式咖啡') &&
      !contents(validWindow).includes('用户将去咖啡庄园')
  );

  const combined = memory.searchMemories({
    query: '咖啡',
    sessionId: SESSION_A,
    filters: {
      sources: ['agent'],
      statuses: ['active'],
      timeFrom: iso(30),
      timeTo: iso(1),
      timeField: 'updated',
    },
  });
  check(
    '组合过滤：四维 AND 只留 agent + active + 时间窗',
    contents(combined).length === 1 &&
      contents(combined)[0] === '用户偏好早晨喝咖啡',
    JSON.stringify(contents(combined))
  );

  const sessionB = memory.searchMemories({
    query: '拿铁',
    sessionId: SESSION_B,
  });
  check(
    '会话过滤：B 会话只返回自己的拿铁',
    contents(sessionB).length === 1 &&
      contents(sessionB)[0] === '用户喝咖啡只喝拿铁',
    JSON.stringify(contents(sessionB))
  );

  const noSession = memory.searchMemories({ query: '昵称', sessionId: null });
  check(
    '无会话身份：只回退无归属旧数据',
    contents(noSession).length === 1 &&
      contents(noSession)[0] === '用户常用昵称是小蓝',
    JSON.stringify(contents(noSession))
  );

  const invalidSource = memory.searchMemories({
    query: '咖啡',
    filters: { sources: ['no-such-source'] },
  });
  check(
    '非法来源过滤：返回 invalid_filters',
    invalidSource.reason === 'invalid_filters'
  );

  const invalidRange = memory.searchMemories({
    query: '咖啡',
    filters: { timeFrom: iso(1), timeTo: iso(30) },
  });
  check(
    '非法时间范围：from > to 返回 invalid_filters',
    invalidRange.reason === 'invalid_filters'
  );
}

// ================= B. 排序与有效性 =================
console.log('\nB. 混合相关度与有效性评分');
seed(rankStore());

{
  const ranked = memory.searchMemories({ query: '咖啡', sessionId: SESSION_A });
  const ids = ranked.results.map(item => item.id);
  check(
    '关键词命中优先于仅内容二元组重合',
    ids.indexOf('rank-keyword') >= 0 &&
      ids.indexOf('rank-content') >= 0 &&
      ids.indexOf('rank-keyword') < ids.indexOf('rank-content'),
    JSON.stringify(ids)
  );
  check(
    '命中理由可区分 keyword+content / content',
    byId(ranked, 'rank-keyword').match.reason === 'keyword+content' &&
      byId(ranked, 'rank-content').match.reason === 'content',
    JSON.stringify(ranked.results.map(item => item.match))
  );

  const cats = memory.searchMemories({ query: '猫', sessionId: SESSION_A });
  const prefIndex = cats.results.findIndex(item => item.id === 'rank-cat-pref');
  const factIndex = cats.results.findIndex(item => item.id === 'rank-cat-fact');
  check(
    '类型权重：同等相关度下 preference 排在 fact 前',
    prefIndex >= 0 && factIndex >= 0 && prefIndex < factIndex,
    JSON.stringify(cats.results.map(item => [item.id, item.score]))
  );

  const origin = memory.searchMemories({
    query: '咖啡豆产地',
    sessionId: SESSION_A,
  });
  const oldIndex = origin.results.findIndex(item => item.id === 'rank-old-fact');
  const newIndex = origin.results.findIndex(item => item.id === 'rank-new-fact');
  check(
    '时间衰减：同内容新事实排在旧事实前',
    oldIndex >= 0 && newIndex >= 0 && newIndex < oldIndex,
    JSON.stringify(origin.results.map(item => [item.id, item.score]))
  );

  const stable = byId(
    memory.searchMemories({ query: '咖啡', sessionId: SESSION_A }),
    'rank-stable-pref'
  );
  check(
    '稳定事实（preference）不因时间衰减被排除，衰减权重为 1',
    Boolean(stable) && stable.components.timeDecay === 1,
    JSON.stringify(stable && stable.components)
  );

  const history = memory.searchMemories({
    query: '咖啡',
    sessionId: SESSION_A,
    mode: 'history',
    asOf: iso(75),
  });
  const oldSuperseded = byId(history, 'rank-superseded');
  const replacement = byId(history, 'rank-replacement');
  check(
    '历史视图：superseded 旧事实与新事实同时可见',
    Boolean(oldSuperseded) && Boolean(replacement)
  );
  check(
    '状态权重：superseded 分数低于 active 替代事实',
    oldSuperseded &&
      replacement &&
      oldSuperseded.components.statusWeight === 0.45 &&
      replacement.components.statusWeight === 1 &&
      oldSuperseded.score < replacement.score,
    JSON.stringify(
      oldSuperseded &&
        replacement && [oldSuperseded.score, replacement.score]
    )
  );
  const current = memory.searchMemories({ query: '咖啡', sessionId: SESSION_A });
  check(
    '当前视图：superseded 旧事实不返回',
    !contents(current).includes('用户喝咖啡只喝速溶')
  );

  const lowRelevance = memory.searchMemories({
    query: '咖啡',
    sessionId: SESSION_A,
  });
  check(
    '低相关候选被排除，identity 仍保底',
    !contents(lowRelevance).includes('用户养了一只猫') &&
      contents(lowRelevance).includes('用户叫宋泽'),
    JSON.stringify(contents(lowRelevance))
  );
  const identity = byId(lowRelevance, 'rank-identity');
  check(
    'identity 结果带保底命中理由与分项评分',
    identity &&
      identity.match.reason === 'identity_priority' &&
      typeof identity.components.typeWeight === 'number' &&
      typeof identity.components.statusWeight === 'number'
  );
  check(
    '结果带来源类型、作用域与语义标注',
    identity &&
      Array.isArray(identity.sourceTypes) &&
      identity.sourceTypes.includes('user') &&
      identity.scope === 'primary' &&
      identity.components.semanticKind === 'concept_lexicon_v1'
  );
  check(
    '诊断明确标注 token 估算器版本',
    lowRelevance.diagnostics.tokenEstimator === 'heuristic-cjk-ascii-v1'
  );
}

// ================= C. 预算与截断 =================
console.log('\nC. 条数/长度/字符/token 预算');
seed(budgetStore());

{
  const maxItems = memory.searchMemories({
    query: '咖啡',
    sessionId: SESSION_A,
    limits: { maxItems: 3, perItemMax: 300, totalMax: 5000, maxTokens: 4000 },
  });
  check(
    '条数硬上限：最多 3 条并标记 limitTruncated',
    maxItems.results.length === 3 &&
      maxItems.diagnostics.limitTruncated === true &&
      maxItems.truncated === true,
    JSON.stringify({
      n: maxItems.results.length,
      diagnostics: maxItems.diagnostics,
    })
  );
  check(
    '条数截断：notReturned.limit > 0',
    maxItems.diagnostics.notReturned.limit > 0,
    JSON.stringify(maxItems.diagnostics.notReturned)
  );

  const perItem = memory.searchMemories({
    query: '咖啡',
    sessionId: SESSION_A,
    limits: { maxItems: 3, perItemMax: 20, totalMax: 5000, maxTokens: 4000 },
  });
  check(
    '单条长度上限：每条 ≤ 20 码点并标记 contentTruncated',
    perItem.results.length > 0 &&
      perItem.results.every(item => textLength(item.content) <= 20) &&
      perItem.results.every(item => item.contentTruncated === true) &&
      perItem.truncatedItems > 0,
    JSON.stringify(perItem.results.map(item => textLength(item.content)))
  );

  const charBudget = memory.searchMemories({
    query: '咖啡',
    sessionId: SESSION_A,
    limits: { maxItems: 10, perItemMax: 300, totalMax: 100, maxTokens: 4000 },
  });
  check(
    '字符总预算：total ≤ 100 并标记 budgetTruncated',
    charBudget.total <= 100 &&
      charBudget.diagnostics.budgetTruncated === true &&
      charBudget.truncated === true,
    JSON.stringify({
      total: charBudget.total,
      diagnostics: charBudget.diagnostics,
    })
  );

  const tokenBudget = memory.searchMemories({
    query: '咖啡',
    sessionId: SESSION_A,
    limits: { maxItems: 10, perItemMax: 300, totalMax: 5000, maxTokens: 30 },
  });
  check(
    'token 总预算：estimatedTokens ≤ 30',
    tokenBudget.estimatedTokens <= 30,
    JSON.stringify({
      estimatedTokens: tokenBudget.estimatedTokens,
      contents: tokenBudget.results.map(item => item.content),
    })
  );
  check(
    'token 截断：budgetTruncated 且结果带省略号',
    tokenBudget.diagnostics.budgetTruncated === true &&
      tokenBudget.truncated === true &&
      tokenBudget.results.some(item => item.content.endsWith('…')),
    JSON.stringify(tokenBudget.results.map(item => item.content))
  );
  check(
    'token 截断：notReturned.token_budget > 0',
    tokenBudget.diagnostics.notReturned.token_budget > 0,
    JSON.stringify(tokenBudget.diagnostics.notReturned)
  );
  check(
    'token 估算结果与结果内容一致（>0）',
    tokenBudget.estimatedTokens ===
      tokenBudget.results.reduce(
        (sum, item) => sum + estimateTokens(item.content),
        0
      ),
    JSON.stringify(tokenBudget.results.map(item => estimateTokens(item.content)))
  );

  const explain = tokenBudget.results[0];
  check(
    '返回结果含命中理由、ID、分数与分项评分',
    explain &&
      typeof explain.id === 'string' &&
      typeof explain.score === 'number' &&
      typeof explain.relevance === 'number' &&
      typeof explain.match.reason === 'string' &&
      typeof explain.components.typeWeight === 'number' &&
      typeof explain.components.timeDecay === 'number' &&
      typeof explain.components.statusWeight === 'number'
  );
  check(
    '诊断含排除计数与未返回原因',
    typeof tokenBudget.diagnostics.excluded.irrelevant === 'number' &&
      typeof tokenBudget.diagnostics.notReturned === 'object'
  );
}

// ================= D. 小库不过滤旁路 =================
console.log('\nD. 小记忆库不得绕过相关性过滤');
seed([
  mem({
    id: 'small-identity',
    content: '用户叫宋泽',
    type: 'identity',
    keywords: ['名字'],
    updatedAt: iso(7),
    validFrom: iso(100),
  }),
  mem({
    id: 'small-unrelated',
    content: '用户喜欢喝美式咖啡',
    type: 'preference',
    keywords: ['咖啡'],
    updatedAt: iso(7),
    validFrom: iso(100),
  }),
]);

{
  const context = memory.buildMemoryContext('今天天气怎么样', SESSION_A);
  check(
    '小库：identity 仍注入',
    context.includes('用户叫宋泽'),
    context
  );
  check(
    '小库：不相关条目不再无条件全量注入',
    !context.includes('用户喜欢喝美式咖啡'),
    context
  );

  const matched = memory.buildMemoryContext('我喜欢喝什么咖啡', SESSION_A);
  check(
    '小库：查询相关时仍能注入对应事实',
    matched.includes('用户喜欢喝美式咖啡'),
    matched
  );
}

function finish() {
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
}

// ================= E. 工具层参数与输出 =================
console.log('\nE. memory_search 工具层');
seed(baseStore());

{
  const validate = memoryTool.definition.validate;

  check(
    '工具校验：合法 sources/statuses/time 组合通过',
    validate({
      query: '咖啡',
      sources: ['agent'],
      statuses: ['active'],
      timeFrom: iso(30),
      timeTo: iso(1),
      timeField: 'updated',
    }).ok === true
  );
  check(
    '工具校验：非法来源拒绝',
    validate({ query: '咖啡', sources: ['bad'] }).ok === false
  );
  check(
    '工具校验：pending 不可作为检索状态',
    validate({ query: '咖啡', statuses: ['pending'] }).ok === false
  );
  check(
    '工具校验：timeField 不能脱离时间范围单独使用',
    validate({ query: '咖啡', timeField: 'updated' }).ok === false
  );
  check(
    '工具校验：timeFrom > timeTo 拒绝',
    validate({
      query: '咖啡',
      timeFrom: iso(1),
      timeTo: iso(30),
    }).ok === false
  );

  const toolInput = validate({
    query: '咖啡',
    sources: ['agent'],
    limit: 5,
  });

  memoryTool.definition
    .handler(toolInput.args, { sessionId: SESSION_A })
    .then(output => {
      check(
        '工具处理：来源过滤生效且返回可解释字段',
        output.ok === true &&
          output.results.length === 1 &&
          output.results[0].sourceTypes.includes('agent') &&
          output.results[0].match.reason &&
          typeof output.results[0].score === 'number' &&
          output.excluded &&
          output.notReturned &&
          output.semantic.provider === 'local-concept-lexicon' &&
          output.results[0].match.semantic.matched === true &&
          output.budget.estimator === 'heuristic-cjk-ascii-v1',
        JSON.stringify(output)
      );
      finish();
    })
    .catch(error => {
      check('工具处理：handler 不抛异常', false, String(error));
      finish();
    });
}

// ================= 汇总（由 finish() 输出） =================
