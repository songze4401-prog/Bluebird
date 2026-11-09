/**
 * 云岫 Bluebird — 记忆观察台账（Phase 2 最小闭环）
 *
 * 覆盖验收点：
 *   1. observe/weigh：尝试次数与独立会话数正确累计（同会话不去重、跨会话去重）
 *   2. 隐私边界：台账文件只含内容哈希，绝不出现正文/原话
 *   3. 上限：500 条封顶，超出按 lastSeenAt 淘汰最旧
 *   4. 损坏隔离：坏 JSON → 隔离为 .corrupt-<ts> + 回退空台账（与 memory 同策略）
 *   5. 集成：memory.processMemory 的 low_confidence 拒写自动入台账，跨会话累计
 *
 * 隔离：BLUEBIRD_DATA_DIR 指向临时目录，不读写 server/data 的真实数据。
 *
 * 运行：node tests/memory-observation-ledger.test.js
 */
const fs = require('fs');
const os = require('os');
const path = require('path');
const assert = require('node:assert/strict');
const { test, before, after } = require('node:test');

const origLog = console.log;
console.log = () => {};

const TMP_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'bluebird-obs-ledger-'));
process.env.BLUEBIRD_DATA_DIR = TMP_DIR;
process.env.MEMORY_ENABLED = 'true';

const ledger = require(path.join(__dirname, '..', 'server', 'memory-observation-ledger.js'));
const memory = require(path.join(__dirname, '..', 'server', 'memory.js'));
const { getInstanceUserId } = require(path.join(__dirname, '..', 'server', 'user-scope.js'));

const MEMORY_FILE = path.join(TMP_DIR, 'memory.json');
const USER = getInstanceUserId();

function seed(items) {
  fs.mkdirSync(TMP_DIR, { recursive: true });
  fs.writeFileSync(MEMORY_FILE, JSON.stringify(items, null, 2), 'utf8');
  memory.loadMemories();
}

/** 造一个可控的假 client，按给定内容返回补全 */
function fakeClient(replyContent) {
  return {
    chat: {
      completions: {
        create: async () => ({
          choices: [{ message: { content: replyContent } }],
        }),
      },
    },
  };
}

function validReply(overrides = {}) {
  return JSON.stringify({
    content: '用户叫宋泽',
    type: 'identity',
    keywords: ['名字', '宋泽'],
    confidence: 0.95,
    sourceQuote: '我叫宋泽',
    ...overrides,
  });
}

before(() => {
  seed([]);
});

after(() => {
  fs.rmSync(TMP_DIR, { recursive: true, force: true });
  console.log = origLog;
});

// ------------------------------------------------ 1 & 2

test('observe/weigh：尝试次数累计，独立会话数按会话去重', () => {
  const first = ledger.observe({ content: '用户喝咖啡只喝美式', sessionId: 'sess_a', reason: 'low_confidence', confidence: 0.5 });
  assert.equal(first.attempts, 1);
  assert.equal(first.independentSessions, 1);

  const second = ledger.observe({ content: '用户喝咖啡只喝美式', sessionId: 'sess_a', reason: 'low_confidence', confidence: 0.55 });
  assert.equal(second.attempts, 2, '同会话重复观察累计 attempts');
  assert.equal(second.independentSessions, 1, '同会话不增加独立会话数');

  const third = ledger.observe({ content: '用户喝咖啡只喝美式', sessionId: 'sess_b', reason: 'low_confidence', confidence: 0.6 });
  assert.equal(third.attempts, 3);
  assert.equal(third.independentSessions, 2, '跨会话观察增加独立会话数');
});

test('隐私边界：台账文件只含内容哈希，绝不出现正文', async () => {
  const secret = '用户喝咖啡只喝美式';
  await ledger.flushForTests();
  const fileText = fs.readFileSync(ledger.LEDGER_FILE, 'utf8');

  assert.ok(fileText.includes('"observations"'), '台账文件应存在');
  assert.equal(
    fileText.includes(secret),
    false,
    '正文绝不能出现在台账文件里——只允许内容哈希'
  );
  assert.match(fileText, /"attempts": 3/, '观测计数应已落盘');
});

// ------------------------------------------------ 3

test('上限：500 条封顶，超出按 lastSeenAt 淘汰最旧', () => {
  const oldestKey = ledger.observationKey('上限淘汰占位 000');
  ledger.observe({ content: '上限淘汰占位 000', sessionId: 'cap_old', reason: 'low_confidence', confidence: 0.5 });

  for (let i = 1; i <= ledger.LEDGER_MAX_ENTRIES; i++) {
    ledger.observe({
      content: `上限淘汰占位 ${String(i).padStart(4, '0')}`,
      sessionId: `cap_${i}`,
      reason: 'low_confidence',
      confidence: 0.5,
    });
  }

  assert.equal(ledger.observationCount(), ledger.LEDGER_MAX_ENTRIES, '封顶 500 条');
  assert.equal(ledger.weigh(oldestKey).attempts, 0, '最旧的观测被淘汰');
});

// ------------------------------------------------ 4

test('损坏隔离：坏 JSON 隔离为 .corrupt-<ts> 并回退空台账', async () => {
  // 先触发一次加载/落盘，再人为写坏文件并清缓存——下一次读取走 corruption 契约
  ledger.observe({ content: '损坏隔离探针', sessionId: 'corrupt_probe', reason: 'low_confidence', confidence: 0.5 });
  await ledger.flushForTests();
  fs.writeFileSync(ledger.LEDGER_FILE, '{ 这不是 JSON', 'utf8');
  ledger.reloadForTests();

  const rows = ledger.getObservations();
  assert.deepEqual(rows, [], '损坏后台账回退为空');

  const corrupted = fs
    .readdirSync(TMP_DIR)
    .find(name => name.startsWith('memory-observation-ledger.json.corrupt-'));
  assert.ok(corrupted, `损坏文件应被隔离改名，实际目录：${fs.readdirSync(TMP_DIR).join(',')}`);

  // 隔离后台账可继续工作（下一次 observe 重写合法文件）
  const again = ledger.observe({ content: '损坏隔离探针', sessionId: 'corrupt_probe', reason: 'low_confidence', confidence: 0.5 });
  assert.equal(again.attempts, 1, '隔离后从空台账重新计数');
  assert.equal(ledger.observationCount(), 1);
  await ledger.flushForTests();
});

// ------------------------------------------------ 5

test('集成：processMemory 的 low_confidence 拒写自动入台账并跨会话累计', async () => {
  seed([]);
  // 0.5 低于默认门槛 0.85，也低于显式意图门槛 0.6——必走 low_confidence 拒写
  const reply = validReply({ confidence: 0.5 });
  const key = ledger.observationKey('用户叫宋泽');

  assert.equal(ledger.weigh(key).attempts, 0, '集成前台账应为空');

  const first = await memory.processMemory(fakeClient(reply), '我叫宋泽', 'integ_sess_a');
  assert.equal(first.written, false, '低置信候选不直接写入');
  assert.equal(first.reason, 'low_confidence');
  assert.equal(ledger.weigh(key).attempts, 1, '拒写自动记入台账');
  assert.equal(ledger.weigh(key).independentSessions, 1);

  await memory.processMemory(fakeClient(reply), '我叫宋泽', 'integ_sess_a');
  assert.equal(ledger.weigh(key).attempts, 2, '同会话累计 attempts');

  const third = await memory.processMemory(fakeClient(reply), '我叫宋泽', 'integ_sess_b');
  assert.equal(third.written, false, '台账本身不改变决策语义（晋升留待评审）');
  assert.equal(ledger.weigh(key).independentSessions, 2, '跨会话独立支持被累计');
  assert.deepEqual(memory.getMemories(), [], '全程不产生正式记忆');
});
