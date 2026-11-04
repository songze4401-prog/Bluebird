/**
 * Phase 1 / P1：幂等账本（op-ledger）存储层回归。
 *
 * 本文件是本步最高优先级的证据：幂等键算错的后果不是多花钱，而是
 * 「有副作用工具被重复执行、系统却以为只跑了一次」。
 *
 * 覆盖：
 *  a) 规范化：键序不同的等价对象、嵌套结构、数组顺序、缺省字段、显式 null；
 *  b) 数字字符串 vs 数字、1 vs 1.0；
 *  c) 含中文/空格的字符串保真；
 *  d) 拼接歧义（字段自身含分隔符）不撞键；
 *  e) 非法参数（NaN/Infinity/循环引用/非纯对象）fail-closed 抛错；
 *  f) 账本读写：begin 幂等、finish、未 begin 补终态报错、损坏数据拒绝加载；
 *  g) 清理：7 天保留只删「终态 + 任务终态」，started/unknown 永不自动删；
 *  h) 上限 5000：按时间淘汰最老的可删条目，无可删条目时报告 overCap。
 *
 * 隔离纪律：BLUEBIRD_DATA_DIR 在 require server/ 之前指向临时目录。
 */
const fs = require('fs');
const os = require('os');
const path = require('path');
const test = require('node:test');
const assert = require('node:assert');

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'bluebird-op-ledger-'));
process.env.BLUEBIRD_DATA_DIR = TMP;
process.env.DEEPSEEK_API_KEY = '';
process.env.BLUEBIRD_AGENT_TOOLS = '';
process.env.BLUEBIRD_MONITORING = '0';

const ledger = require('../server/agents/op-ledger');

const BASE_KEY = {
  agentId: 'memory',
  taskId: 'task_p1',
  stepId: 'cp0:r1:t0',
  toolName: 'memory_update',
};

function keyFor(overrides = {}, args) {
  return ledger.buildOpKey({ ...BASE_KEY, args: { a: 1 }, ...overrides });
}

function resetLedger() {
  try {
    fs.rmSync(ledger.LEDGER_FILE, { force: true });
  } catch (_) {
    // ignore
  }
}

function assertCode(fn, code) {
  assert.throws(fn, error => {
    assert.strictEqual(error.code, code);
    return true;
  });
}

test.after(() => {
  try {
    fs.rmSync(TMP, { recursive: true, force: true });
  } catch (_) {
    // ignore
  }
});

test('a1. 键序不同的等价对象得到同一个键', () => {
  const first = ledger.canonicalizeArgs({ a: 1, b: 2, c: 3 });
  const second = ledger.canonicalizeArgs({ c: 3, b: 2, a: 1 });

  assert.strictEqual(first, second);
  assert.strictEqual(
    ledger.buildOpKey({ ...BASE_KEY, args: { a: 1, b: 2 } }),
    ledger.buildOpKey({ ...BASE_KEY, args: { b: 2, a: 1 } })
  );
});

test('a2. 嵌套对象的键序不同仍等价，数组顺序敏感', () => {
  const nestedA = { outer: { z: 1, a: { m: 2, b: 3 } }, list: [1, 2] };
  const nestedB = { list: [1, 2], outer: { a: { b: 3, m: 2 }, z: 1 } };

  assert.strictEqual(ledger.canonicalizeArgs(nestedA), ledger.canonicalizeArgs(nestedB));

  assert.notStrictEqual(
    keyFor({ args: { list: [1, 2] } }),
    keyFor({ args: { list: [2, 1] } })
  );
});

test('a3. 可选字段缺省（undefined）与缺省等价，显式 null 不等价', () => {
  assert.strictEqual(
    ledger.canonicalizeArgs({ a: 1 }),
    ledger.canonicalizeArgs({ a: 1, b: undefined })
  );
  assert.strictEqual(keyFor({ args: { a: 1 } }), keyFor({ args: { a: 1, b: undefined } }));

  assert.notStrictEqual(
    ledger.canonicalizeArgs({ a: 1 }),
    ledger.canonicalizeArgs({ a: 1, b: null })
  );
  assert.notStrictEqual(
    keyFor({ args: { a: 1 } }),
    keyFor({ args: { a: 1, b: null } })
  );
});

test('a4. 无参数（undefined/null）与空对象等价，顶层数组/原始值被拒绝', () => {
  assert.strictEqual(ledger.canonicalizeArgs(undefined), '{}');
  assert.strictEqual(ledger.canonicalizeArgs(null), '{}');
  assert.strictEqual(keyFor({ args: undefined }), keyFor({ args: {} }));

  assertCode(() => ledger.canonicalizeArgs([1, 2]), 'agent_op_args_invalid');
  assertCode(() => ledger.canonicalizeArgs('text'), 'agent_op_args_invalid');
});

test('b1. 数字字符串 "1" 与数字 1 必须不同键（不做隐式类型转换）', () => {
  assert.notStrictEqual(
    ledger.canonicalizeArgs({ n: '1' }),
    ledger.canonicalizeArgs({ n: 1 })
  );
  assert.notStrictEqual(keyFor({ args: { n: '1' } }), keyFor({ args: { n: 1 } }));
  // "01" 若被强转就会与 1 撞键，从而误判为重复、跳过真实副作用。
  assert.notStrictEqual(keyFor({ args: { n: '01' } }), keyFor({ args: { n: 1 } }));
});

test('b2. 1 与 1.0 是同一个 JSON 数字，同键', () => {
  assert.strictEqual(ledger.canonicalizeArgs({ n: 1 }), ledger.canonicalizeArgs({ n: 1.0 }));
  assert.strictEqual(keyFor({ args: { n: 1 } }), keyFor({ args: { n: 1.0 } }));
});

test('c1. 含中文与空格的字符串保真：不同空格不同键，同一字符串稳定', () => {
  const chinese = '记忆：把「张三 的偏好」设为「喜欢 冰美式」';
  const chineseNoSpace = '记忆：把「张三的偏好」设为「喜欢冰美式」';

  assert.strictEqual(ledger.canonicalizeArgs({ text: chinese }), JSON.stringify({ text: chinese }));
  assert.strictEqual(keyFor({ args: { text: chinese } }), keyFor({ args: { text: chinese } }));
  assert.notStrictEqual(keyFor({ args: { text: chinese } }), keyFor({ args: { text: chineseNoSpace } }));
});

test('d1. 字段自身含分隔符时不会撞键（用 JSON 数组而非 | 拼接）', () => {
  assert.notStrictEqual(
    ledger.buildOpKey({ agentId: 'a|b', taskId: 'c', stepId: 's', toolName: 't', args: {} }),
    ledger.buildOpKey({ agentId: 'a', taskId: 'b|c', stepId: 's', toolName: 't', args: {} })
  );
});

test('d2. 幂等键字段缺失或为空直接抛错（不生成可用键）', () => {
  assertCode(
    () => ledger.buildOpKey({ agentId: 'memory', taskId: '', stepId: 's', toolName: 't' }),
    'agent_op_key_invalid'
  );
  assertCode(
    () => ledger.buildOpKey({ agentId: 'memory', taskId: 't', toolName: 't' }),
    'agent_op_key_invalid'
  );
});

test('e1. NaN/Infinity 被拒绝（JSON 会把它静默变成 null 撞键）', () => {
  assertCode(() => ledger.canonicalizeArgs({ n: NaN }), 'agent_op_args_invalid');
  assertCode(() => ledger.canonicalizeArgs({ n: Infinity }), 'agent_op_args_invalid');
});

test('e2. 循环引用、Date、数组里的 undefined 被拒绝', () => {
  const cyclic = { a: 1 };
  cyclic.self = cyclic;

  assertCode(() => ledger.canonicalizeArgs(cyclic), 'agent_op_args_invalid');
  assertCode(() => ledger.canonicalizeArgs({ when: new Date() }), 'agent_op_args_invalid');
  assertCode(() => ledger.canonicalizeArgs({ list: [1, undefined] }), 'agent_op_args_invalid');
});

test('f1. begin 落盘 started；同键重复 begin 返回原条目且不新增行', () => {
  resetLedger();
  const step = { ...BASE_KEY, stepId: 'cp0:r1:t1', args: { memoryId: 'm_1', text: '新内容' } };

  const first = ledger.begin(step);
  assert.strictEqual(first.reused, false);
  assert.strictEqual(first.entry.status, 'started');
  assert.ok(/^[0-9a-f]{64}$/.test(first.opKey));

  const stored = ledger.read();
  assert.strictEqual(stored.version, 1);
  assert.strictEqual(Object.keys(stored.ops).length, 1);
  assert.strictEqual(stored.ops[first.opKey].taskId, step.taskId);
  assert.deepStrictEqual(ledger.get(first.opKey), first.entry);

  const second = ledger.begin(step);
  assert.strictEqual(second.reused, true);
  assert.deepStrictEqual(second.entry, first.entry);
  assert.strictEqual(Object.keys(ledger.read().ops).length, 1);
});

test('f2. finish 补 succeeded 与 resultDigest，保留 startedAt/attempt', () => {
  resetLedger();
  const step = { ...BASE_KEY, stepId: 'cp0:r1:t2', args: { memoryId: 'm_2' } };
  const { opKey } = ledger.begin({ ...step, attempt: 2, now: 1000 });

  const entry = ledger.finish(opKey, {
    status: 'succeeded',
    resultDigest: 'sha256:ok',
    now: 2000,
  });

  assert.strictEqual(entry.status, 'succeeded');
  assert.strictEqual(entry.attempt, 2);
  assert.strictEqual(entry.startedAt, new Date(1000).toISOString());
  assert.strictEqual(entry.finishedAt, new Date(2000).toISOString());
  assert.strictEqual(entry.resultDigest, 'sha256:ok');
  assert.strictEqual(ledger.get(opKey).status, 'succeeded');
});

test('f3. 未 begin 就补终态、或 opKey 形状非法 → 抛错（不静默丢记账）', () => {
  resetLedger();
  assertCode(
    () => ledger.finish('a'.repeat(64), { status: 'succeeded' }),
    'agent_op_not_found'
  );
  assertCode(() => ledger.finish('not-a-hash', { status: 'succeeded' }), 'agent_op_key_invalid');
  assertCode(() => ledger.markUnknown('b'.repeat(64)), 'agent_op_not_found');
});

test('f4. 损坏或结构无效的账本拒绝加载（fail-closed，不重建）', () => {
  resetLedger();
  fs.mkdirSync(path.dirname(ledger.LEDGER_FILE), { recursive: true });
  fs.writeFileSync(ledger.LEDGER_FILE, '{ not json', 'utf8');
  assertCode(() => ledger.read(), 'agent_op_ledger_corrupted');

  fs.writeFileSync(
    ledger.LEDGER_FILE,
    JSON.stringify({
      version: 1,
      ops: { k: { opKey: 'other', taskId: 't', toolName: 'x', status: 'started', startedAt: 'x' } },
    }),
    'utf8'
  );
  assertCode(() => ledger.read(), 'agent_op_ledger_corrupted');
});

test('f5. markUnknown 只改状态，不删除、不改 startedAt', () => {
  resetLedger();
  const step = { ...BASE_KEY, stepId: 'cp0:r1:t3', args: { memoryId: 'm_3' } };
  const { opKey } = ledger.begin({ ...step, now: 1000 });

  const entry = ledger.markUnknown(opKey, { errorCode: 'process_killed', now: 5000 });
  assert.strictEqual(entry.status, 'unknown');
  assert.strictEqual(entry.errorCode, 'process_killed');
  assert.strictEqual(entry.startedAt, new Date(1000).toISOString());
  assert.strictEqual(Object.keys(ledger.read().ops).length, 1);
});

function makeEntry(opKey, { taskId, status, startedAt, finishedAt }) {
  return {
    opKey,
    taskId,
    toolName: 'memory_update',
    status,
    attempt: 1,
    startedAt,
    finishedAt,
    resultDigest: null,
    errorCode: null,
  };
}

function seedStore(entries) {
  const ops = {};
  for (const entry of entries) ops[entry.opKey] = entry;
  ledger.write({ version: 1, ops });
}

test('g1. 清理：超 7 天的终态条目且任务终态才删；started 与非终态任务保留', () => {
  resetLedger();
  const now = Date.now();
  const old = new Date(now - ledger.RETENTION_MS - 60 * 1000).toISOString();
  const fresh = new Date(now - 1000).toISOString();

  const entries = [
    makeEntry('1'.repeat(64), { taskId: 'task_done', status: 'succeeded', startedAt: old, finishedAt: old }),
    makeEntry('2'.repeat(64), { taskId: 'task_live', status: 'succeeded', startedAt: old, finishedAt: old }),
    makeEntry('3'.repeat(64), { taskId: 'task_done', status: 'started', startedAt: old, finishedAt: null }),
    makeEntry('4'.repeat(64), { taskId: 'task_done', status: 'unknown', startedAt: old, finishedAt: old }),
    makeEntry('5'.repeat(64), { taskId: 'task_done', status: 'failed', startedAt: fresh, finishedAt: fresh }),
  ];
  seedStore(entries);

  const result = ledger.cleanup({ terminalTaskIds: ['task_done'], now });

  assert.strictEqual(result.removedByAge, 1);
  assert.strictEqual(result.remaining, 4);
  assert.strictEqual(ledger.get('1'.repeat(64)), null);
  // 任务仍存活：即便超期也不删。
  assert.ok(ledger.get('2'.repeat(64)));
  // started / unknown 永不自动删。
  assert.ok(ledger.get('3'.repeat(64)));
  assert.ok(ledger.get('4'.repeat(64)));
  // 未超期。
  assert.ok(ledger.get('5'.repeat(64)));
});

test('g2. 上限 5000：淘汰最老的可删条目，started 不受影响', () => {
  resetLedger();
  const base = Date.now();
  const entries = [];
  const total = ledger.MAX_ENTRIES + 2;

  // 最老的 3 条：2 条可删、1 条 started（不可删）。
  entries.push(
    makeEntry('a'.repeat(64), {
      taskId: 'task_done',
      status: 'succeeded',
      startedAt: new Date(base - 3000).toISOString(),
      finishedAt: new Date(base - 3000).toISOString(),
    })
  );
  entries.push(
    makeEntry('b'.repeat(64), {
      taskId: 'task_done',
      status: 'started',
      startedAt: new Date(base - 3000).toISOString(),
      finishedAt: null,
    })
  );
  entries.push(
    makeEntry('c'.repeat(64), {
      taskId: 'task_done',
      status: 'failed',
      startedAt: new Date(base - 2500).toISOString(),
      finishedAt: new Date(base - 2500).toISOString(),
    })
  );

  for (let i = 3; i < total; i += 1) {
    const key = i.toString(16).padStart(64, '0');
    entries.push(
      makeEntry(key, {
        taskId: 'task_done',
        status: 'succeeded',
        startedAt: new Date(base - 2000 + i).toISOString(),
        finishedAt: new Date(base - 2000 + i).toISOString(),
      })
    );
  }
  seedStore(entries);

  const result = ledger.cleanup({ terminalTaskIds: ['task_done'], now: base });

  assert.strictEqual(result.removedByCap, 2);
  assert.strictEqual(result.overCap, 0);
  assert.strictEqual(result.remaining, ledger.MAX_ENTRIES);
  assert.strictEqual(ledger.get('a'.repeat(64)), null);
  assert.strictEqual(ledger.get('c'.repeat(64)), null);
  assert.ok(ledger.get('b'.repeat(64)));
});

test('g3. 全是不可删条目时超出上限只报告 overCap，不误删 started', () => {
  resetLedger();
  const base = Date.now();
  const entries = [];

  for (let i = 0; i < ledger.MAX_ENTRIES + 2; i += 1) {
    const key = i.toString(16).padStart(64, '0');
    entries.push(
      makeEntry(key, {
        taskId: 'task_done',
        status: 'started',
        startedAt: new Date(base - 1000 + i).toISOString(),
        finishedAt: null,
      })
    );
  }
  seedStore(entries);

  const result = ledger.cleanup({ terminalTaskIds: ['task_done'], now: base });

  assert.strictEqual(result.removedByCap, 0);
  assert.strictEqual(result.overCap, 2);
  assert.strictEqual(result.remaining, ledger.MAX_ENTRIES + 2);
  assert.ok(ledger.get('0'.repeat(64)));
});
