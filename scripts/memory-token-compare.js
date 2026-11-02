/**
 * 云岫 Bluebird — 跨会话记忆改造前后的 Token 消耗对比（P2-4）
 *
 * 目的：在**同一份夹具、同一批查询**下，对比两种作用域的检索注入量：
 *   before = 会话级作用域（P0 时的行为：新会话只看得到本会话 + 无归属旧数据）
 *   after  = 用户级作用域（P1 后的行为：同一用户的记忆跨会话可见）
 *
 * 口径说明（重要）：
 * - 本脚本**不调用任何模型 Provider**，因此输出里 provider_kind='none'；
 * - Token 一律来自 text-utils 的 heuristic-cjk-ascii-v1 估算器，
 *   标 token_source='estimate'，不是供应商 prompt_tokens；
 * - 字符数/条数只作为辅助列，绝不当作 Token 汇报。
 *
 * 运行：node scripts/memory-token-compare.js
 * 输出：stdout 表格 + 可选 --json 打印完整 JSON
 */
const fs = require('fs');
const os = require('os');
const path = require('path');

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'bluebird-token-compare-'));
process.env.BLUEBIRD_DATA_DIR = TMP;

const origLog = console.log;
const origErr = console.error;
// 屏蔽记忆模块的常规日志，保持输出可读
console.log = () => {};
console.error = () => {};

const memory = require(path.join(__dirname, '..', 'server', 'memory.js'));
const { retrieveMemory } = require(path.join(__dirname, '..', 'server', 'context', 'retriever.js'));
const { buildContext } = require(path.join(__dirname, '..', 'server', 'context', 'builder.js'));
const { config } = require(path.join(__dirname, '..', 'server', 'context', 'config.js'));
const { estimateTokens, textLength } = require(path.join(__dirname, '..', 'server', 'text-utils.js'));
const { getInstanceUserId } = require(path.join(__dirname, '..', 'server', 'user-scope.js'));

const MEMORY_FILE = path.join(TMP, 'memory.json');
const NEW_SESSION = 'sess_new_after_p1';
const USER = getInstanceUserId();

function iso(offsetMinutes) {
  return new Date(Date.now() - offsetMinutes * 60 * 1000).toISOString();
}

function entry({
  content,
  type = 'preference',
  keywords,
  sessionId = null,
  status = 'active',
  validFrom = null,
  validTo = null,
  minutesAgo = 60,
}) {
  return {
    content,
    type,
    keywords,
    confidence: 0.9,
    status,
    sourceQuote: content,
    ...(sessionId ? { sessionId } : {}),
    validFrom: validFrom || iso(minutesAgo),
    validTo: validTo || null,
    createdAt: iso(minutesAgo),
    updatedAt: iso(minutesAgo),
  };
}

// 夹具：4 个历史会话沉淀的长期记忆 + 各类应被排除的条目。
const FIXTURE = [
  // 其他会话沉淀的有效记忆（P1 后应当可见）
  entry({
    content: '用户喝咖啡只喝美式，不加糖不加奶',
    keywords: ['咖啡', '美式', '偏好'],
    sessionId: 'sess_old_1',
    minutesAgo: 600,
  }),
  entry({
    content: '用户常用编辑器是 Vim，习惯用相对行号',
    keywords: ['编辑器', 'Vim'],
    sessionId: 'sess_old_1',
    minutesAgo: 900,
  }),
  entry({
    content: '用户所在城市是杭州，通勤靠地铁',
    keywords: ['城市', '杭州', '通勤'],
    sessionId: 'sess_old_2',
    minutesAgo: 1200,
  }),
  entry({
    content: '用户的猫叫豆豆，是一只橘猫',
    keywords: ['猫', '豆豆'],
    sessionId: 'sess_old_2',
    minutesAgo: 1500,
  }),
  entry({
    content: '用户对花生过敏，点餐需要避开',
    keywords: ['过敏', '花生'],
    sessionId: 'sess_old_3',
    minutesAgo: 1800,
  }),
  entry({
    content: '用户每周三晚上打羽毛球',
    keywords: ['羽毛球', '运动'],
    sessionId: 'sess_old_3',
    minutesAgo: 2100,
  }),
  // 无归属旧数据（两种作用域都可见）
  entry({
    content: '用户喜欢喝冰美式，夏天更明显',
    keywords: ['咖啡', '冰美式'],
    sessionId: null,
    minutesAgo: 3000,
  }),
  // 应被排除：已被替代
  entry({
    content: '用户喝咖啡只喝拿铁',
    keywords: ['咖啡', '拿铁'],
    sessionId: 'sess_old_1',
    status: 'superseded',
    minutesAgo: 4000,
  }),
  // 应被排除：已过期
  entry({
    content: '用户这周在出差，住城西酒店',
    keywords: ['出差', '酒店'],
    sessionId: 'sess_old_2',
    validFrom: iso(5000),
    validTo: iso(10),
    minutesAgo: 5000,
  }),
  // 应被排除：待确认
  entry({
    content: '用户可能想换工作到上海',
    keywords: ['工作', '上海'],
    sessionId: 'sess_old_3',
    status: 'pending',
    minutesAgo: 6000,
  }),
  // 应被排除：归档
  entry({
    content: '用户曾用 Windows 作为主力系统',
    keywords: ['系统', 'Windows'],
    sessionId: 'sess_old_1',
    status: 'archived',
    minutesAgo: 7000,
  }),
];

const QUERIES = [
  '我喝咖啡有什么习惯',
  '我平时用什么编辑器',
  '我住在哪个城市',
  '我的猫叫什么',
  '我有什么过敏',
  '我平时做什么运动',
  '我最近在忙什么',
];

function seed() {
  fs.writeFileSync(MEMORY_FILE, JSON.stringify(FIXTURE, null, 2), 'utf8');
  memory.loadMemories();
}

async function measure(mode, query) {
  const scopeArgs =
    mode === 'user'
      ? { sessionId: NEW_SESSION, userId: USER }
      : { sessionId: NEW_SESSION };

  const retrieval = await retrieveMemory({ task: query, ...scopeArgs, config });

  const built = buildContext({
    recent: [],
    recalled: [],
    summary: null,
    memoryItems: retrieval.items || [],
    knowledgeItems: [],
    config,
  });

  const memoryBlock = (built.blocks || []).find(block => block.kind === 'memory');
  const text = memoryBlock ? String(memoryBlock.text) : '';
  const diagnostics = retrieval.diagnostics || {};

  return {
    mode,
    status: retrieval.status,
    candidates: diagnostics.funnel ? diagnostics.funnel.candidates : null,
    returned: (retrieval.items || []).length,
    accepted: built.memory.accepted.length,
    skipped: built.memory.skipped.length,
    excluded: diagnostics.excluded || null,
    visibilityReasons: diagnostics.visibilityReasons || null,
    memoryBlockChars: textLength(text),
    memoryBlockTokens: estimateTokens(text),
    acceptedContents: built.memory.accepted.map(item => item.content),
  };
}

async function main() {
  seed();

  const rows = [];
  for (const query of QUERIES) {
    const before = await measure('session', query);
    const after = await measure('user', query);
    rows.push({ query, before, after });
  }

  const totals = rows.reduce(
    (acc, row) => {
      acc.beforeTokens += row.before.memoryBlockTokens;
      acc.afterTokens += row.after.memoryBlockTokens;
      acc.beforeItems += row.before.accepted;
      acc.afterItems += row.after.accepted;
      return acc;
    },
    { beforeTokens: 0, afterTokens: 0, beforeItems: 0, afterItems: 0 }
  );

  const summary = {
    generatedAt: new Date().toISOString(),
    provider_kind: 'none',
    note: '未调用任何模型 Provider；Token 为 heuristic-cjk-ascii-v1 估算值，不是供应商 prompt_tokens',
    token_source: 'estimate',
    estimator: 'heuristic-cjk-ascii-v1',
    scope: { before: 'session', after: 'user' },
    fixture: {
      entries: FIXTURE.length,
      sessions: [...new Set(FIXTURE.map(item => item.sessionId).filter(Boolean))],
      newSession: NEW_SESSION,
    },
    totals,
    delta: {
      tokens: totals.afterTokens - totals.beforeTokens,
      tokensPercent:
        totals.beforeTokens > 0
          ? +(((totals.afterTokens - totals.beforeTokens) / totals.beforeTokens) * 100).toFixed(1)
          : null,
      items: totals.afterItems - totals.beforeItems,
    },
    rows,
  };

  if (process.argv.includes('--json')) {
    origLog(JSON.stringify(summary, null, 2));
  } else {
    origLog('跨会话记忆改造前后 · 注入量对比（估算 Token，非 Provider 计数）');
    origLog('='.repeat(96));
    origLog(
      'query'.padEnd(24) +
        'cand(b/a)'.padEnd(12) +
        'items(b/a)'.padEnd(13) +
        'tokens(b/a)'.padEnd(15) +
        'Δtokens'
    );
    origLog('-'.repeat(96));
    for (const row of rows) {
      const cand = `${row.before.candidates}/${row.after.candidates}`;
      const items = `${row.before.accepted}/${row.after.accepted}`;
      const tokens = `${row.before.memoryBlockTokens}/${row.after.memoryBlockTokens}`;
      const delta = row.after.memoryBlockTokens - row.before.memoryBlockTokens;
      origLog(
        row.query.padEnd(24) +
          cand.padEnd(12) +
          items.padEnd(13) +
          tokens.padEnd(15) +
          (delta >= 0 ? `+${delta}` : String(delta))
      );
    }
    origLog('-'.repeat(96));
    origLog(
      '合计'.padEnd(24) +
        ''.padEnd(12) +
        `${totals.beforeItems}/${totals.afterItems}`.padEnd(13) +
        `${totals.beforeTokens}/${totals.afterTokens}`.padEnd(15) +
        (summary.delta.tokens >= 0 ? `+${summary.delta.tokens}` : String(summary.delta.tokens)) +
        `  (${summary.delta.tokensPercent}%)`
    );
    origLog('');
    origLog('排除原因（after，按查询累计）：');
    const reasonTotals = {};
    for (const row of rows) {
      const reasons = row.after.visibilityReasons || {};
      for (const [key, value] of Object.entries(reasons)) {
        if (value > 0) reasonTotals[key] = (reasonTotals[key] || 0) + value;
      }
      const excluded = row.after.excluded || {};
      for (const key of ['session_scope', 'status', 'source', 'time', 'irrelevant', 'invalid']) {
        if (excluded[key] > 0) {
          reasonTotals[key] = (reasonTotals[key] || 0) + excluded[key];
        }
      }
    }
    origLog('  ' + (Object.keys(reasonTotals).length ? JSON.stringify(reasonTotals) : '（无）'));
    origLog('');
    origLog('提示：本脚本不调用模型，provider_kind=none；Token 为估算值，不能当作真实用量。');
  }

  fs.rmSync(TMP, { recursive: true, force: true });
}

main().catch(error => {
  origErr('对比脚本失败：', error && error.message ? error.message : error);
  process.exit(1);
});
