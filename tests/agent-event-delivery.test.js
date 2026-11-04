/* global __dirname, process */
/**
 * Phase 3 第 2 项：事件投递的幂等与崩溃恢复。
 *
 * 补的是 P1–P5 没覆盖的两块：
 *  1) 事件层没有幂等键——同一逻辑事件重复投递会生成两行不同 eventId 的事件；
 *  2) 事件投递的崩溃窗口（outbox 已落盘、主事件文件未写）没有真实 SIGKILL 证据。
 *
 * 实现只复用既有 events/outbox 两个文件：幂等键由确定性 eventId 承担，
 * 去重在原记录上累加 dedupeCount（审计可见），崩溃后由 flushEventOutbox 按 eventId 补写。
 */
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn, spawnSync } = require('child_process');
const test = require('node:test');
const assert = require('node:assert');

const CHILD = path.join(__dirname, 'helpers', 'crash-child.js');
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'bluebird-agent-event-delivery-'));
process.env.BLUEBIRD_DATA_DIR = TMP;
process.env.DEEPSEEK_API_KEY = '';
process.env.BLUEBIRD_AGENT_TOOLS = '';
process.env.BLUEBIRD_MONITORING = '0';

const tasks = require('../server/agents/tasks');
const sessions = require('../server/agents/sessions');
const resultDelivery = require('../server/agents/result-delivery');
const mainSessions = require('../server/sessions');

const AGENTS_DIR = path.join(TMP, 'agents');
const EVENTS_NAME = path.basename(tasks.EVENTS_FILE);
const OUTBOX_NAME = path.basename(tasks.OUTBOX_FILE);
const KILL_TIMEOUT_MS = 25000;
const CHILD_TIMEOUT_MS = 45000;

function resetStore() {
  fs.rmSync(AGENTS_DIR, { recursive: true, force: true });
  tasks.reloadForTests();
  sessions.reloadForTests();
}

function makeCompletedTask(parentSessionId) {
  const task = tasks.createTask({
    botId: 'memory',
    taskType: 'memory.search',
    goal: '事件投递测试任务',
    allowedTools: ['memory_search'],
    deadlineMs: 20000,
    parentSessionId,
  });
  tasks.transitionTask(task.taskId, { to: 'accepted' });
  tasks.transitionTask(task.taskId, { to: 'running' });
  tasks.transitionTask(task.taskId, {
    to: 'completed',
    result: { status: 'completed', summary: '完成' },
  });
  return tasks.getTask(task.taskId);
}

function deliveryEvents(taskId) {
  return tasks
    .listEvents('memory', { limit: 200 })
    .filter(event => event.eventType === 'task.delivery' && event.taskId === taskId);
}

function sleepSync(ms) {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

function readDisk(file) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch (_) {
    return null;
  }
}

function childEnv(dataDir, markerDir, scenario, hookName) {
  return {
    ...process.env,
    BLUEBIRD_DATA_DIR: dataDir,
    BLUEBIRD_CRASH_SCENARIO: scenario,
    BLUEBIRD_TEST_CRASH_HOOK: hookName,
    BLUEBIRD_TEST_CRASH_MARKER_DIR: markerDir,
    BLUEBIRD_TEST_CRASH_HOLD_MS: String(KILL_TIMEOUT_MS - 5000),
    DEEPSEEK_API_KEY: '',
    MEMORY_ENABLED: 'true',
    BLUEBIRD_AGENT_TOOLS: '',
    BLUEBIRD_MONITORING: '0',
  };
}

function waitForMarker(markerDir, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const files = fs.existsSync(markerDir) ? fs.readdirSync(markerDir) : [];
    if (files.length > 0) return path.join(markerDir, files[0]);
    sleepSync(50);
  }
  return null;
}

async function crashAtEventWindow() {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'bluebird-event-crash-'));
  const markerDir = path.join(dataDir, 'markers');
  fs.mkdirSync(markerDir);
  const child = spawn(process.execPath, [CHILD], {
    env: childEnv(dataDir, markerDir, 'event-after-outbox-save', 'event.after-outbox-save'),
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let stdout = '';
  let stderr = '';
  child.stdout.on('data', chunk => {
    stdout += chunk;
  });
  child.stderr.on('data', chunk => {
    stderr += chunk;
  });
  const exited = new Promise(resolve =>
    child.once('exit', (code, signal) => resolve({ code, signal }))
  );
  const marker = waitForMarker(markerDir, KILL_TIMEOUT_MS);
  if (!marker) {
    child.kill('SIGKILL');
    await exited;
    throw new Error(`注入点未命中：stdout=${stdout} stderr=${stderr}`);
  }
  const atKill = {
    events: (readDisk(path.join(dataDir, 'agents', EVENTS_NAME)) || { events: [] }).events.length,
    outbox: (readDisk(path.join(dataDir, 'agents', OUTBOX_NAME)) || { events: [] }).events.length,
  };
  child.kill('SIGKILL');
  const exit = await exited;
  assert.ok(
    exit.signal === 'SIGKILL' || exit.code !== 0,
    `子进程必须被信号杀掉，实际 ${JSON.stringify(exit)}`
  );
  return { dataDir, atKill, stdout, stderr };
}

function restartAtEventWindow(dataDir) {
  const result = spawnSync(process.execPath, [CHILD], {
    env: childEnv(dataDir, path.join(dataDir, 'markers-2'), 'event-after-outbox-save-restart', ''),
    encoding: 'utf8',
    timeout: CHILD_TIMEOUT_MS,
  });
  const line = (result.stdout || '')
    .split(/\r?\n/)
    .reverse()
    .find(item => item.startsWith('CRASH_CHILD_JSON '));
  if (!line) {
    throw new Error(`重启进程没有输出观察 JSON：stdout=${result.stdout} stderr=${result.stderr}`);
  }
  return JSON.parse(line.slice('CRASH_CHILD_JSON '.length));
}

// ---- A. 重复事件投递：副作用一次、状态不乱、审计可见 ----

test('a. 同一事件投递两次：父会话消息 1 条、task.delivery 1 行、dedupeCount=1', () => {
  resetStore();
  const parent = mainSessions.createSession({ title: '事件重复投递' });
  const task = makeCompletedTask(parent.id);

  const first = resultDelivery.deliverTaskOutcome(task, {
    status: 'completed',
    result: task.result,
  });
  const second = resultDelivery.deliverTaskOutcome(task, {
    status: 'completed',
    result: task.result,
  });

  const messages = mainSessions
    .getMessages(parent.id)
    .filter(message => message.id === resultDelivery.messageIdFor(task.taskId));
  const rows = deliveryEvents(task.taskId);
  const stored = readDisk(path.join(AGENTS_DIR, EVENTS_NAME)).events.filter(
    event => event.taskId === task.taskId && event.eventType === 'task.delivery'
  );

  assert.equal(first.delivered, true);
  assert.equal(second.alreadyDelivered, true);
  assert.equal(messages.length, 1, '副作用（父会话消息）只能发生一次');
  assert.equal(rows.length, 1, '同一投递结局只能有一行 task.delivery');
  assert.equal(rows[0].dedupeCount, 1, '被去重次数必须落盘可见');
  assert.equal(stored.length, 1);
  assert.equal(tasks.getTask(task.taskId).deliveryStatus, 'delivered');
  assert.equal(tasks.getTask(task.taskId).status, 'completed', '重复投递不能改任务状态');

  console.log(
    `[EVIDENCE] duplicate-delivery ${JSON.stringify({
      taskId: task.taskId,
      messages: messages.length,
      eventRows: rows.length,
      eventId: rows[0].eventId,
      dedupeCount: rows[0].dedupeCount,
      secondAlreadyDelivered: second.alreadyDelivered === true,
      taskStatus: tasks.getTask(task.taskId).status,
    })}`
  );
});

test('b. 幂等键只合并同一逻辑事件：不同键、无键的事件仍各自一行', () => {
  resetStore();
  const base = {
    botId: 'memory',
    eventType: 'task.delivery',
    payload: { status: 'pending', mode: 'dedupe_probe' },
  };
  const once = tasks.appendEvent({ ...base, dedupeKey: 'probe|same' });
  const twice = tasks.appendEvent({ ...base, dedupeKey: 'probe|same' });
  const other = tasks.appendEvent({ ...base, dedupeKey: 'probe|other' });
  const noKeyA = tasks.appendEvent({ ...base });
  const noKeyB = tasks.appendEvent({ ...base });

  const rows = tasks
    .listEvents('memory', { limit: 200 })
    .filter(event => event.payload.mode === 'dedupe_probe');

  assert.equal(twice.deduped, true);
  assert.equal(twice.eventId, once.eventId, '同键必须命中同一个 eventId 槽位');
  assert.equal(twice.dedupeCount, 1);
  assert.equal(other.deduped, undefined, '不同键不能被误判为重复');
  assert.equal(noKeyA.eventId === noKeyB.eventId, false, '未传幂等键的事件保持既有语义');
  assert.equal(rows.length, 4, '同键 2 次 + 不同键 1 + 无键 2 → 4 行');

  console.log(
    `[EVIDENCE] dedupe-scope ${JSON.stringify({
      sameKeyRows: rows.filter(row => row.dedupeKey === 'probe|same').length,
      otherKeyRows: rows.filter(row => row.dedupeKey === 'probe|other').length,
      noKeyRows: rows.filter(row => !row.dedupeKey).length,
      dedupeCount: twice.dedupeCount,
    })}`
  );
});

test('c. 幂等键非法：空串/超长/非字符串直接拒绝，不写入', () => {
  resetStore();
  const base = { botId: 'memory', eventType: 'task.delivery', payload: {} };
  for (const bad of ['', '   ', 'x'.repeat(121), 42]) {
    assert.throws(
      () => tasks.appendEvent({ ...base, dedupeKey: bad }),
      error => error && error.code === 'invalid_event_dedupe_key'
    );
  }
  const rows = tasks
    .listEvents('memory', { limit: 200 })
    .filter(event => event.payload.mode === 'dedupe_probe');
  assert.equal(rows.length, 0);
});

// ---- B. 投递中断：崩溃窗口 + 重启恰好一次 ----

test('d. 事件已进 outbox、主事件文件未写 → SIGKILL → 重启后恰好一次生效', { timeout: 90000 }, async () => {
  const shot = await crashAtEventWindow();
  assert.equal(shot.atKill.events, 0, '被杀时主事件文件里不应有该事件');
  assert.equal(shot.atKill.outbox, 1, '被杀时事件必须已持久在 outbox 里');

  const first = restartAtEventWindow(shot.dataDir);
  assert.equal(first.rows, 1, '重启补写后该事件只能有一行');
  assert.equal(first.outboxRows, 0, '补写成功后 outbox 必须清空');
  assert.equal(first.replayDeduped, true, '重启后同键重投必须命中既有槽位');
  assert.equal(first.dedupeCount, 1);

  const second = restartAtEventWindow(shot.dataDir);
  assert.equal(second.rows, 1, '再重启一次仍然只有一行，不得重复补写');
  assert.equal(second.eventId, first.eventId, 'eventId 必须是确定性的');
  assert.equal(second.dedupeCount, 2, '第二次重投只累加去重计数，不新增事件行');

  console.log(
    `[EVIDENCE] crash-recovery ${JSON.stringify({
      atKill: shot.atKill,
      afterRestart1: {
        rows: first.rows,
        outboxRows: first.outboxRows,
        dedupeCount: first.dedupeCount,
        replayDeduped: first.replayDeduped,
      },
      afterRestart2: {
        rows: second.rows,
        outboxRows: second.outboxRows,
        dedupeCount: second.dedupeCount,
      },
      eventId: first.eventId,
    })}`
  );
});
