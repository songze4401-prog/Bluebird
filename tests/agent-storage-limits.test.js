/**
 * 审计 P3-12：Agent 事件 outbox 的增长硬上限。
 *
 * 背景：主事件文件写不进去时，事件会先堆在持久 outbox 里。没有上限时
 * 磁盘可能被写满；修复后超出上限只保留最近 OUTBOX_MAX 条，并记录被丢弃的条数。
 *
 * 隔离保证：落盘全部指向系统临时目录；不请求任何外部服务。
 * 运行：node --test tests/agent-storage-limits.test.js
 */
const fs = require('fs');
const os = require('os');
const path = require('path');
const test = require('node:test');
const assert = require('node:assert');

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'bluebird-agent-limits-'));
const SERVER = path.join(__dirname, '..', 'server');

process.env.BLUEBIRD_DATA_DIR = TMP;
process.env.BLUEBIRD_MONITORING = '0';

const AGENTS_DIR = path.join(TMP, 'agents');
const EVENTS_FILE = path.join(AGENTS_DIR, 'agent-events.json');
const OUTBOX_FILE = path.join(AGENTS_DIR, 'agent-event-outbox.json');

const tasks = require(path.join(SERVER, 'agents', 'tasks.js'));

test('P3-12：主事件文件不可写时，outbox 不超过上限并记录被丢弃的条数', () => {
  const cap = tasks.OUTBOX_MAX;
  const overflow = 5;

  // 让主事件文件的 rename 必然失败：事件于是留在 outbox 里等待重试。
  const realRenameSync = fs.renameSync;
  const renameDesc = Object.getOwnPropertyDescriptor(fs, 'renameSync');
  const errorLines = [];
  const realError = console.error;
  console.error = (...args) => {
    errorLines.push(args.map(item => String(item)).join(' '));
  };

  Object.defineProperty(fs, 'renameSync', {
    configurable: true,
    writable: true,
    value: (from, to) => {
      if (String(to) === EVENTS_FILE) {
        const error = new Error('forced event store failure');
        error.code = 'EACCES';
        throw error;
      }
      return realRenameSync.call(fs, from, to);
    },
  });

  const appended = [];
  try {
    for (let i = 0; i < cap + overflow; i += 1) {
      const result = tasks.appendEvent({
        botId: 'memory',
        eventType: 'task.created',
        payload: { status: 'queued' },
      });
      appended.push(result);
    }
  } finally {
    if (renameDesc) Object.defineProperty(fs, 'renameSync', renameDesc);
    console.error = realError;
  }

  assert.ok(appended.length === cap + overflow);
  assert.ok(
    appended.every(event => event.queued === true),
    '主事件文件不可写时，事件应标记为 queued 而不是被静默丢弃'
  );

  const outbox = JSON.parse(fs.readFileSync(OUTBOX_FILE, 'utf8'));
  assert.equal(
    outbox.events.length,
    cap,
    `outbox 应被截断到 ${cap} 条，实际 ${outbox.events.length}`
  );

  const kept = new Set(outbox.events.map(event => event.eventId));
  assert.equal(
    kept.has(appended[0].eventId),
    false,
    '最旧的事件应被丢弃'
  );
  assert.equal(
    kept.has(appended[appended.length - 1].eventId),
    true,
    '最新的事件必须保留'
  );

  // 实现按“每次追加超出即丢一条”上报：overflow 次追加 → overflow 条溢出日志，
  // 每条 dropped=1，总丢弃数由所有溢出日志累加得到。
  const overflowLines = errorLines.filter(line => line.includes('agent_event_outbox_overflow'));
  assert.ok(
    overflowLines.length === overflow,
    `应记录 ${overflow} 条溢出日志，实际 ${overflowLines.length}`
  );
  let droppedTotal = 0;
  for (const line of overflowLines) {
    const parsed = JSON.parse(line);
    assert.equal(parsed.cap, cap);
    assert.equal(parsed.action, 'drop_oldest');
    assert.equal(parsed.reason, 'outbox_overflow');
    droppedTotal += parsed.dropped;
  }
  assert.equal(
    droppedTotal,
    overflow,
    `被丢弃的事件总数应为 ${overflow}，实际 ${droppedTotal}`
  );
});

test('P3-12：主事件文件恢复可写后，outbox 里的事件被补写回主文件', () => {
  const before = JSON.parse(fs.readFileSync(OUTBOX_FILE, 'utf8'));
  assert.ok(before.events.length > 0, '前置用例应留下待补写的事件');

  // 事件文件此前不存在（写入一直失败），listEvents 会触发 outbox 补写。
  const events = tasks.listEvents('memory', { limit: 200 });
  assert.ok(events.length > 0, '补写后应能读到事件');

  const outboxAfter = JSON.parse(fs.readFileSync(OUTBOX_FILE, 'utf8'));
  assert.equal(
    outboxAfter.events.length,
    0,
    '补写成功后 outbox 应清空'
  );

  const main = JSON.parse(fs.readFileSync(EVENTS_FILE, 'utf8'));
  assert.ok(
    main.events.length >= before.events.length,
    '主事件文件应包含补写的事件'
  );
});

test.after(() => {
  try {
    fs.rmSync(TMP, { recursive: true, force: true });
  } catch (_) {
    /* ignore */
  }
});
