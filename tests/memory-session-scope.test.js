/**
 * 云岫 Bluebird — 记忆会话归属与撤回隔离（E2 + 贡献列表，server/memory.js）
 *
 * 独立脚本（非 node:test）：与 tests/sessions.test.js 同款极简 runner，测完显式退出。
 * 隔离保证：BLUEBIRD_DATA_DIR 指向系统临时目录，不读写 server/data 的真实记忆文件。
 *
 * 覆盖：记忆按"贡献列表"落盘（归属 + 原话锚点合成一条贡献）、旧数据读盘升级、
 *       撤回只摘掉本会话的那条贡献、贡献被摘空才删整条记忆、其他会话的贡献绝不误删、
 *       无归属旧贡献的回退兼容、时间窗仍然生效、同会话去重合并行为不变。
 *
 * 运行：node tests/memory-session-scope.test.js
 */
const fs = require('fs');
const os = require('os');
const path = require('path');

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'bluebird-mem-scope-'));
process.env.BLUEBIRD_DATA_DIR = TMP;

const origLog = console.log;
const origErr = console.error;
console.log = () => {};
console.error = () => {};

const memory = require(path.join(__dirname, '..', 'server', 'memory.js'));
const MEMORY_FILE = path.join(TMP, 'memory.json');

let passed = 0;
let failed = 0;
const failures = [];

function check(name, cond, extra = '') {
  if (cond) {
    passed++;
    origLog(`  ✔ ${name}`);
  } else {
    failed++;
    failures.push(name + (extra ? ` — ${extra}` : ''));
    origLog(`  ✖ ${name}${extra ? ` — ${extra}` : ''}`);
  }
}

function seed(items) {
  fs.writeFileSync(MEMORY_FILE, JSON.stringify(items, null, 2), 'utf8');
  memory.loadMemories();
}

function readFile() {
  return JSON.parse(fs.readFileSync(MEMORY_FILE, 'utf8'));
}

/** 假 client：返回一条能通过全部校验的记忆 JSON */
function fakeClient() {
  const reply = JSON.stringify({
    content: '用户叫宋泽',
    type: 'identity',
    keywords: ['名字', '宋泽'],
    confidence: 0.95,
    sourceQuote: '我叫宋泽',
  });

  return {
    chat: {
      completions: {
        create: async () => ({
          choices: [{ message: { content: reply } }],
        }),
      },
    },
  };
}

const QUOTE = '我叫宋泽';

/** 造一条旧数据形态的记忆条目；sessionId 为 null 时故意省略字段 */
function entry(sessionId, minutesAgo = 0) {
  const createdAt = new Date(
    Date.now() - minutesAgo * 60 * 1000
  ).toISOString();

  return {
    content: '用户叫宋泽',
    type: 'identity',
    keywords: ['名字', '宋泽'],
    confidence: 0.95,
    sourceQuote: QUOTE,
    ...(sessionId ? { sessionId } : {}),
    createdAt,
    updatedAt: createdAt,
  };
}

/** 条目里的贡献列表（一条记忆可能被多个会话各自说过） */
function contributionsOf(item) {
  return item && Array.isArray(item.contributions) ? item.contributions : [];
}

/** 条目包含的会话归属；无归属记为 null */
function scopesOf(item) {
  return contributionsOf(item).map(c => c.sessionId);
}

async function main() {
  const now = new Date().toISOString();

  // 1) 两个会话存在同内容、同时间窗的记忆：A 撤回只删 A 的
  seed([entry('s-a'), entry('s-b')]);
  let removed = await memory.recallMemoryBySourceQuote(QUOTE, now, 's-a');
  let left = memory.getMemories();
  check('同内容双会话：A 撤回只删除 1 条', removed === 1, `removed=${removed}`);
  check(
    'B 会话的记忆完整保留',
    left.length === 1 && scopesOf(left[0]).join('|') === 's-b',
    JSON.stringify(left)
  );

  // 2) 反向：B 撤回只删 B 的
  seed([entry('s-a'), entry('s-b')]);
  removed = await memory.recallMemoryBySourceQuote(QUOTE, now, 's-b');
  left = memory.getMemories();
  check(
    '反向：B 撤回只删除 B 的条目',
    removed === 1 &&
      left.length === 1 &&
      scopesOf(left[0]).join('|') === 's-a'
  );

  // 3) 无归属旧条目：本会话没有匹配时按旧行为回退删除
  seed([entry(null)]);
  removed = await memory.recallMemoryBySourceQuote(QUOTE, now, 's-new');
  check(
    '旧条目（无 sessionId）在本会话无匹配时被回退撤回',
    removed === 1 && memory.getMemories().length === 0
  );

  // 4) 只有别的会话的条目：撤回不得跨会话误删（旧实现的漏洞）
  seed([entry('s-b')]);
  removed = await memory.recallMemoryBySourceQuote(QUOTE, now, 's-a');
  check(
    '绝不删除其他会话的条目（removed=0）',
    removed === 0 && memory.getMemories().length === 1
  );

  // 5) 同会话有匹配时，无归属旧条目保持不动（保守，不做连坐删除）
  seed([entry('s-a'), entry(null)]);
  removed = await memory.recallMemoryBySourceQuote(QUOTE, now, 's-a');
  left = memory.getMemories();
  check(
    '同会话优先：只删本会话条目，旧条目不动',
    removed === 1 &&
      left.length === 1 &&
      scopesOf(left[0]).join('|') === '',
    JSON.stringify(left)
  );

  // 6) 时间窗防护仍然生效：超出窗口的同会话条目不被删
  seed([entry('s-a', 24 * 60)]);
  removed = await memory.recallMemoryBySourceQuote(QUOTE, now, 's-a');
  check(
    '超出时间窗的条目不被撤回',
    removed === 0 && memory.getMemories().length === 1
  );

  // 7) processMemory 写入的条目带会话归属，且落盘不再平铺 sourceQuote
  seed([]);
  await memory.processMemory(fakeClient(), '我叫宋泽', 's-a');
  let saved = readFile();
  check(
    '提取的记忆把归属与原话锚点写成一条贡献',
    saved.length === 1 &&
      contributionsOf(saved[0]).length === 1 &&
      saved[0].contributions[0].sessionId === 's-a' &&
      saved[0].contributions[0].sourceQuote === QUOTE,
    JSON.stringify(saved)
  );
  check(
    '落盘不再出现平铺的 sourceQuote / sessionId',
    saved[0].sourceQuote === undefined && saved[0].sessionId === undefined,
    JSON.stringify(saved)
  );

  // 8) 不带 sessionId 的旧调用：归属为 null，仍可被回退逻辑撤回（兼容旧数据）
  seed([]);
  await memory.processMemory(fakeClient(), '我叫宋泽');
  saved = readFile();
  check(
    '不带 sessionId 的调用写入 null 归属',
    saved.length === 1 && saved[0].contributions[0].sessionId === null,
    JSON.stringify(saved)
  );

  removed = await memory.recallMemoryBySourceQuote(
    QUOTE,
    saved[0].contributions[0].createdAt,
    's-any'
  );
  check(
    'null 归属条目仍可被回退撤回',
    removed === 1 && memory.getMemories().length === 0
  );

  // 9) 同会话重复提取仍走去重合并（内容相似 >= 0.8），且贡献不重复堆积
  seed([]);
  await memory.processMemory(fakeClient(), '我叫宋泽', 's-a');
  await memory.processMemory(fakeClient(), '我叫宋泽', 's-a');
  saved = readFile();
  check(
    '同内容重复提取仍合并为一条',
    saved.length === 1 && saved[0].contributions[0].sessionId === 's-a',
    JSON.stringify(saved)
  );
  check(
    '同会话同原话的贡献只留一条',
    contributionsOf(saved[0]).length === 1,
    JSON.stringify(saved)
  );

  // 10) 边界：空 source / 不带 sessionId 的撤回
  seed([entry('s-a')]);
  check(
    '空 source 直接返回 0',
    (await memory.recallMemoryBySourceQuote('', now, 's-a')) === 0
  );
  removed = await memory.recallMemoryBySourceQuote(QUOTE, now, null);
  check(
    '不带 sessionId 的撤回只匹配无归属条目（此处为 0）',
    removed === 0 && memory.getMemories().length === 1
  );

  // 11) 跨会话重述：合并只追加贡献，不再把归属改判给后说的会话
  seed([]);
  await memory.processMemory(fakeClient(), '我叫宋泽', 's-a');
  await memory.processMemory(fakeClient(), '我叫宋泽', 's-b');
  saved = readFile();
  check(
    '跨会话重述合并为一条，两个会话各留一条贡献',
    saved.length === 1 &&
      scopesOf(saved[0]).join('|') === 's-a|s-b' &&
      saved[0].contributions[0].sourceQuote === QUOTE,
    JSON.stringify(saved)
  );

  // 12) A 撤回自己的那条消息：只摘掉 A 的贡献，事实因 B 说过而保留
  removed = await memory.recallMemoryBySourceQuote(QUOTE, now, 's-a');
  saved = readFile();
  check(
    'A 撤回只摘掉自己的贡献，记忆仍保留给 B',
    removed === 0 &&
      saved.length === 1 &&
      scopesOf(saved[0]).join('|') === 's-b',
    JSON.stringify(saved)
  );

  // 13) 归属漂移已消除：B 先重述也不能夺走 A 的撤回能力
  seed([]);
  await memory.processMemory(fakeClient(), '我叫宋泽', 's-a');
  await memory.processMemory(fakeClient(), '我叫宋泽', 's-b');
  removed = await memory.recallMemoryBySourceQuote(QUOTE, now, 's-a');
  saved = readFile();
  check(
    '后说的会话不会夺走原会话的撤回能力',
    removed === 0 &&
      saved.length === 1 &&
      scopesOf(saved[0]).join('|') === 's-b',
    JSON.stringify(saved)
  );

  // 14) 最后一条贡献也被撤回时，记忆整条删除
  removed = await memory.recallMemoryBySourceQuote(QUOTE, now, 's-b');
  check(
    '贡献被摘空的记忆整条删除',
    removed === 1 && memory.getMemories().length === 0,
    JSON.stringify(readFile())
  );
}

main()
  .catch(error => {
    failed++;
    failures.push(`未捕获异常：${(error && error.stack) || error}`);
  })
  .then(() => {
    origLog(`\n结果：${passed} 通过，${failed} 失败`);
    if (failures.length) {
      origLog('失败项：');
      for (const item of failures) origLog(`  - ${item}`);
    }
    process.exitCode = failed ? 1 : 0;
  });
