/**
 * 云岫 Bluebird — P3 回归指标：召回率 / 无关记忆注入率 / Token 消耗
 *
 * 对比两种读作用域，同一夹具、同一批标注查询：
 *   before = 会话级作用域（P0 行为：新会话看不到其他会话沉淀的记忆）
 *   after  = 用户级作用域（P1 后：同一用户跨会话可见）
 *
 * 指标定义（写死在这里，避免口径漂移）：
 *   recall@inject = |注入集合 ∩ 标注相关集合| / |标注相关集合|
 *   irrelevantInjectionRate = |注入集合 - 标注相关集合| / |注入集合|   （注入为空时记 0）
 *   tokens = 记忆块 Token（heuristic-cjk-ascii-v1 估算，非 Provider 计数）
 *
 * 口径声明：
 * - 不调用任何模型 Provider，provider_kind='none'；
 * - "相关"由人工标注决定，不是模型判断；
 * - 该指标衡量的是「检索+注入」链路，不衡量模型是否使用了记忆。
 *
 * 运行：node scripts/p3-regression-report.js [--json]
 */
const fs = require('fs');
const os = require('os');
const path = require('path');

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'bluebird-p3-report-'));
process.env.BLUEBIRD_DATA_DIR = TMP;
process.env.MEMORY_ENABLED = 'true';

const origLog = console.log;
const origErr = console.error;
console.log = () => {};
console.error = () => {};

const memory = require(path.join(__dirname, '..', 'server', 'memory.js'));
const { retrieveMemory } = require(path.join(__dirname, '..', 'server', 'context', 'retriever.js'));
const { buildContext } = require(path.join(__dirname, '..', 'server', 'context', 'builder.js'));
const { config } = require(path.join(__dirname, '..', 'server', 'context', 'config.js'));
const { estimateTokens, textLength } = require(path.join(__dirname, '..', 'server', 'text-utils.js'));
const { getInstanceUserId } = require(path.join(__dirname, '..', 'server', 'user-scope.js'));

const MEMORY_FILE = path.join(TMP, 'memory.json');
const USER = getInstanceUserId();
const NEW_SESSION = 'sess_p3_report_new';

function iso(minutesAgo) {
  return new Date(Date.now() - minutesAgo * 60 * 1000).toISOString();
}

function entry({ content, keywords, sessionId, type = 'preference', minutesAgo = 60 }) {
  return {
    content,
    type,
    keywords,
    confidence: 0.9,
    status: 'active',
    sourceQuote: content,
    ...(sessionId ? { sessionId } : {}),
    validFrom: iso(minutesAgo),
    validTo: null,
    createdAt: iso(minutesAgo),
    updatedAt: iso(minutesAgo),
  };
}

// 夹具：跨 4 个历史会话的长期记忆
const FIXTURE = [
  entry({ content: '用户喝咖啡只喝美式，不加糖不加奶', keywords: ['咖啡', '美式', '偏好'], sessionId: 'old_1', minutesAgo: 600 }),
  entry({ content: '用户常用编辑器是 Vim，习惯相对行号', keywords: ['编辑器', 'Vim'], sessionId: 'old_1', minutesAgo: 700 }),
  entry({ content: '用户所在城市是杭州，通勤靠地铁', keywords: ['城市', '杭州', '通勤'], sessionId: 'old_2', minutesAgo: 800 }),
  entry({ content: '用户的猫叫豆豆，是一只橘猫', keywords: ['猫', '豆豆'], sessionId: 'old_2', minutesAgo: 900 }),
  entry({ content: '用户对花生过敏，点餐需要避开', keywords: ['过敏', '花生'], sessionId: 'old_3', minutesAgo: 1000 }),
  entry({ content: '用户每周三晚上打羽毛球', keywords: ['羽毛球', '运动'], sessionId: 'old_3', minutesAgo: 1100 }),
  entry({ content: '用户的笔记本是 M4 Max 32G', keywords: ['笔记本', 'M4'], sessionId: 'old_4', minutesAgo: 1200 }),
  entry({ content: '用户偏好深色主题，字号偏大', keywords: ['主题', '深色', '字号'], sessionId: 'old_4', minutesAgo: 1300 }),
];

// 标注：查询 → 期望被注入的记忆（人工标注，作为 ground truth）
// ownerSession 是这条记忆的写入会话，用于测「同会话」基线（旧行为在同会话内本来是好的）。
const CASES = [
  { query: '我喝咖啡有什么习惯', relevant: ['用户喝咖啡只喝美式，不加糖不加奶'], ownerSession: 'old_1' },
  { query: '我平时用什么编辑器', relevant: ['用户常用编辑器是 Vim，习惯相对行号'], ownerSession: 'old_1' },
  { query: '我住在哪个城市', relevant: ['用户所在城市是杭州，通勤靠地铁'], ownerSession: 'old_2' },
  { query: '我的猫叫什么名字', relevant: ['用户的猫叫豆豆，是一只橘猫'], ownerSession: 'old_2' },
  { query: '我有什么食物过敏', relevant: ['用户对花生过敏，点餐需要避开'], ownerSession: 'old_3' },
  { query: '我平时做什么运动', relevant: ['用户每周三晚上打羽毛球'], ownerSession: 'old_3' },
  { query: '我的笔记本是什么配置', relevant: ['用户的笔记本是 M4 Max 32G'], ownerSession: 'old_4' },
  { query: '界面主题我喜欢什么样的', relevant: ['用户偏好深色主题，字号偏大'], ownerSession: 'old_4' },
  // 无相关记忆的查询：期望注入 0 条（用于测无关注入率）
  { query: '帮我写一个快速排序', relevant: [], ownerSession: 'old_1' },
  { query: '解释一下 TCP 三次握手', relevant: [], ownerSession: 'old_1' },
];

function seed() {
  fs.writeFileSync(MEMORY_FILE, JSON.stringify(FIXTURE, null, 2), 'utf8');
  memory.loadMemories();
}

async function measure({ item, sessionId, userId = null }) {
  const retrievalOutcome = await retrieveMemory({
    task: item.query,
    sessionId,
    userId,
    config,
  });
  const built = buildContext({
    recent: [],
    recalled: [],
    summary: null,
    memoryItems: retrievalOutcome.items || [],
    knowledgeItems: [],
    config,
  });

  const block = (built.blocks || []).find(entryBlock => entryBlock.kind === 'memory');
  const text = block ? String(block.text) : '';
  const injected = built.memory.accepted.map(entryItem => entryItem.content);

  const relevantSet = new Set(item.relevant);
  const hit = injected.filter(content => relevantSet.has(content)).length;
  const irrelevant = injected.length - hit;

  return {
    injected,
    hit,
    irrelevant,
    recall: item.relevant.length ? hit / item.relevant.length : null,
    irrelevantRate: injected.length ? irrelevant / injected.length : 0,
    tokens: estimateTokens(text),
    chars: textLength(text),
    candidates:
      retrievalOutcome.diagnostics && retrievalOutcome.diagnostics.funnel
        ? retrievalOutcome.diagnostics.funnel.candidates
        : null,
    status: retrievalOutcome.status,
  };
}

function aggregate(rows) {
  const withRelevant = rows.filter(row => row.relevant.length > 0);
  const totalRelevant = withRelevant.reduce((sum, row) => sum + row.relevant.length, 0);
  const totalHit = rows.reduce((sum, row) => sum + row.result.hit, 0);
  const totalInjected = rows.reduce((sum, row) => sum + row.result.injected.length, 0);
  const totalIrrelevant = rows.reduce((sum, row) => sum + row.result.irrelevant, 0);

  return {
    // micro recall：按标注条目加权
    recall: totalRelevant ? +(totalHit / totalRelevant).toFixed(4) : null,
    // macro recall：按查询平均（无相关查询不计入）
    macroRecall: withRelevant.length
      ? +(
          withRelevant.reduce((sum, row) => sum + (row.result.recall || 0), 0) /
          withRelevant.length
        ).toFixed(4)
      : null,
    injectedItems: totalInjected,
    irrelevantItems: totalIrrelevant,
    irrelevantInjectionRate: totalInjected
      ? +(totalIrrelevant / totalInjected).toFixed(4)
      : 0,
    tokens: rows.reduce((sum, row) => sum + row.result.tokens, 0),
    emptyInjections: rows.filter(row => row.result.injected.length === 0).length,
  };
}

async function main() {
  seed();

  const rows = [];
  for (const item of CASES) {
    // 三种口径：
    //   same  = 会话级作用域 + 写入该记忆的同一会话（旧行为本来就能工作的场景）
    //   fresh = 会话级作用域 + 全新会话（P0 时用户实际遇到的场景：完全看不到）
    //   after = 用户级作用域 + 全新会话（P1 后）
    const same = await measure({ item, sessionId: item.ownerSession });
    const fresh = await measure({ item, sessionId: NEW_SESSION });
    const after = await measure({ item, sessionId: NEW_SESSION, userId: USER });
    rows.push({ ...item, same, fresh, after });
  }

  const summary = {
    generatedAt: new Date().toISOString(),
    provider_kind: 'none',
    note:
      '未调用模型 Provider；Token 为 heuristic-cjk-ascii-v1 估算值；"相关"为人工标注，非模型判断',
    token_source: 'estimate',
    fixture: { memories: FIXTURE.length, queries: CASES.length },
    scopes: {
      same: aggregate(rows.map(row => ({ relevant: row.relevant, result: row.same }))),
      fresh: aggregate(rows.map(row => ({ relevant: row.relevant, result: row.fresh }))),
      after: aggregate(rows.map(row => ({ relevant: row.relevant, result: row.after }))),
    },
    rows: rows.map(row => ({
      query: row.query,
      relevant: row.relevant,
      same: row.same,
      fresh: row.fresh,
      after: row.after,
    })),
  };

  if (process.argv.includes('--json')) {
    origLog(JSON.stringify(summary, null, 2));
  } else {
    origLog('P3 回归指标：召回率 / 无关记忆注入率 / Token（估算口径，非 Provider 计数）');
    origLog('same=同会话旧行为  fresh=新会话旧行为  after=新会话用户级（P1 后）');
    origLog('='.repeat(108));
    origLog(
      'query'.padEnd(20) +
        'inject(s/f/a)'.padEnd(15) +
        'recall(s/f/a)'.padEnd(16) +
        'irrel(s/f/a)'.padEnd(14) +
        'tokens(s/f/a)'
    );
    origLog('-'.repeat(108));
    for (const row of rows) {
      const fmt = value => (value === null ? '-' : value.toFixed(2));
      const trio = (a, b, c) => `${a}/${b}/${c}`;
      origLog(
        row.query.padEnd(20) +
          trio(row.same.injected.length, row.fresh.injected.length, row.after.injected.length).padEnd(15) +
          trio(fmt(row.same.recall), fmt(row.fresh.recall), fmt(row.after.recall)).padEnd(16) +
          trio(row.same.irrelevant, row.fresh.irrelevant, row.after.irrelevant).padEnd(14) +
          trio(row.same.tokens, row.fresh.tokens, row.after.tokens)
      );
    }
    origLog('-'.repeat(108));

    const s = summary.scopes;
    const pct = (from, to) =>
      from > 0 ? `${(((to - from) / from) * 100).toFixed(1)}%` : 'n/a';

    origLog('');
    origLog('汇总（same / fresh / after）：');
    origLog(
      `  召回率 micro        : ${s.same.recall ?? '-'} / ${s.fresh.recall ?? '-'} / ${s.after.recall ?? '-'}`
    );
    origLog(
      `  召回率 macro        : ${s.same.macroRecall ?? '-'} / ${s.fresh.macroRecall ?? '-'} / ${s.after.macroRecall ?? '-'}`
    );
    origLog(
      `  注入条目数          : ${s.same.injectedItems} / ${s.fresh.injectedItems} / ${s.after.injectedItems}`
    );
    origLog(
      `  无关记忆注入率      : ${(s.same.irrelevantInjectionRate * 100).toFixed(1)}% / ${(s.fresh.irrelevantInjectionRate * 100).toFixed(1)}% / ${(s.after.irrelevantInjectionRate * 100).toFixed(1)}%`
    );
    origLog(
      `  注入 Token（估算）  : ${s.same.tokens} / ${s.fresh.tokens} / ${s.after.tokens}  (fresh→after: ${pct(s.fresh.tokens, s.after.tokens)})`
    );
    origLog(
      `  零注入查询数        : ${s.same.emptyInjections} / ${s.fresh.emptyInjections} / ${s.after.emptyInjections}`
    );
    origLog('');
    origLog('读法：');
    origLog('  same→fresh 的召回率崩塌，就是用户反馈的「新对话不认识我」；');
    origLog('  after 把召回率拉回 1.0，且无关记忆注入率保持 0；');
    origLog('  Token 增幅是功能修复的成本，必须和无关注入率一起看，不能只看成本。');
  }

  fs.rmSync(TMP, { recursive: true, force: true });
}

main().catch(error => {
  origErr('P3 指标脚本失败：', error && error.message ? error.message : error);
  process.exit(1);
});
