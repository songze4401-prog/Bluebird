/**
 * P0 复现脚本：跨会话长期记忆是否可见
 *
 * 不 mock 任何检索逻辑，直接调用生产读路径：
 *   - searchMemories（Agent 工具 memory_search 与 Context Runtime 共用）
 *   - buildMemoryContext（注入渲染器，与 searchMemories 共用 scopeOf）
 *
 * 数据隔离：BLUEBIRD_DATA_DIR 指向系统临时目录，不触碰 server/data。
 *
 * 运行：node scripts/p0-repro-cross-session.js
 */
const fs = require('fs');
const os = require('os');
const path = require('path');

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'bluebird-p0-repro-'));
process.env.BLUEBIRD_DATA_DIR = TMP;

// 静音记忆模块的常规日志，只保留本脚本输出
const origLog = console.log;
const origErr = console.error;
console.log = () => {};
console.error = () => {};

const memory = require(path.join(__dirname, '..', 'server', 'memory.js'));
const MEMORY_FILE = path.join(TMP, 'memory.json');

function seed(items) {
  fs.writeFileSync(MEMORY_FILE, JSON.stringify(items, null, 2), 'utf8');
  memory.loadMemories();
}

function makeEntry({ content, keywords, sessionId, type = 'fact' }) {
  const now = new Date().toISOString();
  return {
    content,
    type,
    keywords,
    confidence: 0.9,
    sourceQuote: content,
    ...(sessionId ? { sessionId } : {}),
    createdAt: now,
    updatedAt: now,
  };
}

function line() {
  origLog('-'.repeat(72));
}

function main() {
  const SESSION_A = 'sess_A_咖啡偏好';
  const SESSION_B = 'sess_B_全新会话';
  const QUERY = '我喜欢喝什么咖啡';

  // 场景 1：A 会话写入的具名记忆
  seed([
    makeEntry({
      content: '用户喝咖啡只喝美式',
      keywords: ['咖啡', '美式', '偏好'],
      sessionId: SESSION_A,
      type: 'preference',
    }),
  ]);

  origLog('场景 1：A 会话写入具名记忆，B 会话（全新）检索同一问题');
  line();

  const fromA = memory.searchMemories({
    query: QUERY,
    sessionId: SESSION_A,
    limits: { maxItems: 5 },
  });
  const fromB = memory.searchMemories({
    query: QUERY,
    sessionId: SESSION_B,
    limits: { maxItems: 5 },
  });

  origLog(`  A 会话检索 → 命中 ${fromA.results.length} 条，reason=${fromA.reason || '(none)'}`);
  origLog(`    diagnostics.excluded.session_scope = ${fromA.diagnostics.excluded.session_scope}`);
  origLog(`    diagnostics.candidates            = ${fromA.diagnostics.candidates}`);
  origLog('');
  origLog(`  B 会话检索 → 命中 ${fromB.results.length} 条，reason=${fromB.reason || '(none)'}`);
  origLog(`    diagnostics.excluded.session_scope = ${fromB.diagnostics.excluded.session_scope}`);
  origLog(`    diagnostics.candidates            = ${fromB.diagnostics.candidates}`);
  origLog('');

  const ctxB = memory.buildMemoryContext(QUERY, SESSION_B);
  origLog(`  B 会话注入渲染 buildMemoryContext → ${ctxB ? `长度 ${ctxB.length}` : '空字符串（无记忆注入）'}`);
  line();

  // 场景 2：无归属 legacy 记忆（引入 sessionId 之前的旧数据）
  seed([
    makeEntry({
      content: '用户所在城市是杭州',
      keywords: ['城市', '杭州'],
      sessionId: null,
      type: 'fact',
    }),
  ]);

  origLog('场景 2：无归属 legacy 记忆，B 会话检索');
  line();
  const legacyB = memory.searchMemories({
    query: '我在哪个城市',
    sessionId: SESSION_B,
    limits: { maxItems: 5 },
  });
  origLog(`  B 会话检索 → 命中 ${legacyB.results.length} 条`);
  origLog(`    session_scope 排除 = ${legacyB.diagnostics.excluded.session_scope}`);
  origLog(`    命中内容 = ${JSON.stringify(legacyB.results.map(r => r.content))}`);
  line();

  // 场景 3：同一用户跨会话，但没有任何 user 维度可挂
  seed([
    makeEntry({
      content: '用户喝咖啡只喝美式',
      keywords: ['咖啡', '美式'],
      sessionId: SESSION_A,
      type: 'preference',
    }),
    makeEntry({
      content: '用户常用编辑器是 Vim',
      keywords: ['编辑器', 'Vim'],
      sessionId: SESSION_A,
      type: 'preference',
    }),
  ]);

  origLog('场景 3：B 会话查询「是否应该给我推荐拿铁」相关话题');
  line();
  const coffeeB = memory.searchMemories({
    query: '给我推荐一杯咖啡',
    sessionId: SESSION_B,
    limits: { maxItems: 5 },
  });
  origLog(`  B 会话检索 → 命中 ${coffeeB.results.length} 条`);
  origLog(`    session_scope 排除 = ${coffeeB.diagnostics.excluded.session_scope}`);
  origLog(`    候选池大小 candidates = ${coffeeB.diagnostics.candidates}`);
  line();

  origLog('');
  origLog('=== 结论 ===');
  const aWorks = fromA.results.length === 1;
  const bBlocked = fromB.results.length === 0 && fromB.diagnostics.excluded.session_scope === 1;
  const legacyVisible = legacyB.results.length === 1;
  const bStillBlocked = coffeeB.results.length === 0;

  origLog(`  A 会话可检索自己的记忆            : ${aWorks ? '是' : '否'}`);
  origLog(`  B 会话被 session_scope 过滤（=0） : ${bBlocked ? '是（阻断点确认）' : '否'}`);
  origLog(`  无归属 legacy 记忆对新会话可见     : ${legacyVisible ? '是（唯一跨会话通道）' : '否'}`);
  origLog(`  B 会话仍拿不到 A 的偏好            : ${bStillBlocked ? '是' : '否'}`);

  const ok = aWorks && bBlocked && legacyVisible && bStillBlocked;
  origLog('');
  origLog(ok ? '  ✅ 复现成功：阻断点 = session_scope 过滤（selectSearchCandidates/scopeOf）' : '  ⚠️ 复现结果与预期不符，需复查');

  fs.rmSync(TMP, { recursive: true, force: true });
  process.exit(ok ? 0 : 1);
}

main();
