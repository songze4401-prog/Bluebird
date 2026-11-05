/* global process */
/**
 * Phase 3 第 3 项：死信。
 * 达上限入死信 / 可列且字段完整 / 重投恰好一次不双写 / 重投后原记录状态正确且不占队列。
 */
const fs = require('fs');
const os = require('os');
const path = require('path');
const test = require('node:test');
const assert = require('node:assert');

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'bluebird-agent-dead-letter-'));
process.env.BLUEBIRD_DATA_DIR = TMP;
process.env.BLUEBIRD_AGENT_TASK_MAX_ATTEMPTS = '3';

const tasks = require('../server/agents/tasks');
const deadLetter = require('../server/agents/dead-letter');

const AGENTS_DIR = path.join(TMP, 'agents');

function resetStore() {
  fs.rmSync(AGENTS_DIR, { recursive: true, force: true });
  tasks.reloadForTests();
}

function createFailedTask(attempts, maxAttempts = 3) {
  const task = tasks.createTask({
    botId: 'memory',
    taskType: 'memory.search',
    goal: '死信用例任务',
    allowedTools: ['memory_search'],
    deadlineMs: 20000,
  });
  tasks.transitionTask(task.taskId, { to: 'accepted' });
  tasks.transitionTask(task.taskId, { to: 'running' });
  tasks.updateTask(task.taskId, { attempts });
  tasks.transitionTask(task.taskId, {
    to: 'failed',
    errorCode: 'model_timeout',
    result: { status: 'failed', summary: '', errorCode: 'model_timeout' },
  });
  if (maxAttempts !== 3) tasks.updateTask(task.taskId, { deadLetter: null });
  return tasks.getRawTask(task.taskId);
}

test('a. 连续失败达 maxAttempts → 进入死信，未达上限不入', () => {
  resetStore();
  const below = createFailedTask(2);
  assert.equal(deadLetter.mark(below.taskId, { errorCode: 'model_timeout', attempts: 2, maxAttempts: 3 }), null);

  const task = createFailedTask(3);
  const record = deadLetter.mark(task.taskId, {
    errorCode: 'model_timeout',
    attempts: 3,
    maxAttempts: 3,
    now: '2026-11-05T10:00:00.000Z',
  });

  const stored = tasks.getRawTask(task.taskId);
  assert.equal(stored.status, 'failed', '死信不改终态');
  assert.equal(stored.deadLetter.status, 'open');
  assert.equal(record.attempts, 3);
  assert.equal(stored.deadLetter.maxAttempts, 3);
  const events = tasks
    .listEvents('memory', { limit: 200 })
    .filter(event => event.taskId === task.taskId && event.eventType === 'task.dead_letter');

  console.log(
    `[EVIDENCE] dead-letter-threshold ${JSON.stringify({
      belowLimit: { taskId: below.taskId, marked: false },
      atLimit: {
        taskId: task.taskId,
        taskStatus: stored.status,
        deadLetterStatus: stored.deadLetter.status,
        attempts: stored.deadLetter.attempts,
        maxAttempts: stored.deadLetter.maxAttempts,
        lastErrorCode: stored.deadLetter.lastErrorCode,
        events: events.length,
      },
    })}`
  );
});

test('b. 死信可列：任务/原因/最后一次错误码/产物引用字段完整', () => {
  resetStore();
  const task = createFailedTask(3);
  deadLetter.mark(task.taskId, { errorCode: 'model_timeout', attempts: 3, maxAttempts: 3 });

  const rows = deadLetter.list();
  assert.equal(rows.length, 1);
  const row = rows[0];
  for (const field of ['taskId', 'botId', 'taskType', 'goal', 'status', 'errorCode', 'attempts', 'deadLetter', 'artifacts']) {
    assert.ok(Object.prototype.hasOwnProperty.call(row, field), `缺少字段 ${field}`);
  }
  assert.equal(row.taskId, task.taskId);
  assert.equal(row.deadLetter.status, 'open');
  assert.equal(row.deadLetter.lastErrorCode, 'model_timeout');
  assert.ok(Array.isArray(row.artifacts));
  assert.equal(deadLetter.describe(task.taskId).deadLetter.maxAttempts, 3);

  console.log(
    `[EVIDENCE] dead-letter-query ${JSON.stringify({
      rows: rows.length,
      taskId: row.taskId,
      taskStatus: row.status,
      errorCode: row.errorCode,
      lastErrorCode: row.deadLetter.lastErrorCode,
      attempts: row.attempts,
      artifactsField: Array.isArray(row.artifacts),
    })}`
  );
});

test('c. 人工重投：只创建一个新任务，重复调用不双写', () => {
  resetStore();
  const task = createFailedTask(3);
  deadLetter.mark(task.taskId, { errorCode: 'model_timeout', attempts: 3, maxAttempts: 3 });

  const first = deadLetter.redeliver(task.taskId, { now: '2026-11-05T10:05:00.000Z', start: false });
  const second = deadLetter.redeliver(task.taskId, { start: false });

  assert.equal(first.redelivered, true);
  assert.equal(second.reason, 'already_redelivered');
  assert.equal(first.redeliveredTaskId, second.redeliveredTaskId);

  const clones = tasks
    .listAllTasks()
    .filter(item => item.idempotencyKey === `${task.taskId}:redeliver`);
  assert.equal(clones.length, 1, '同一死信只能产生一个重投任务');

  // 重投任务能正常跑到完成（用同一任务记录，不复制存储）
  const clone = tasks.getRawTask(first.redeliveredTaskId);
  tasks.transitionTask(clone.taskId, { to: 'accepted' });
  tasks.transitionTask(clone.taskId, { to: 'running' });
  tasks.transitionTask(clone.taskId, {
    to: 'completed',
    result: { status: 'completed', summary: '重投后成功' },
  });

  console.log(
    `[EVIDENCE] dead-letter-redeliver ${JSON.stringify({
      originalTaskId: task.taskId,
      redeliveredTaskId: first.redeliveredTaskId,
      clones: clones.length,
      secondCall: second.reason,
      cloneStatus: tasks.getTask(first.redeliveredTaskId).status,
    })}`
  );
});

test('d. 重投后原死信记录变为 redelivered，且不占正常队列', () => {
  resetStore();
  const task = createFailedTask(3);
  deadLetter.mark(task.taskId, { errorCode: 'model_timeout', attempts: 3, maxAttempts: 3 });
  const result = deadLetter.redeliver(task.taskId, { now: '2026-11-05T10:06:00.000Z', start: false });

  const stored = tasks.getRawTask(task.taskId);
  const open = deadLetter.list({ status: 'open' });
  const queued = tasks.listAllTasks().filter(item => item.status === 'queued');

  assert.equal(stored.deadLetter.status, 'redelivered');
  assert.equal(stored.deadLetter.redeliveredTaskId, result.redeliveredTaskId);
  assert.equal(stored.deadLetter.redeliveryCount, 1);
  assert.equal(open.length, 0, '不得残留未处理死信');
  assert.ok(!queued.some(item => item.taskId === task.taskId), '死信任务不得出现在队列');
  assert.equal(queued.length, 1, '队列只应有重投任务');

  console.log(
    `[EVIDENCE] dead-letter-state ${JSON.stringify({
      originalTaskId: task.taskId,
      deadLetterStatus: stored.deadLetter.status,
      redeliveredTaskId: stored.deadLetter.redeliveredTaskId,
      redeliveryCount: stored.deadLetter.redeliveryCount,
      openDeadLetters: open.length,
      queuedTasks: queued.length,
      deadLetterInQueue: queued.some(item => item.taskId === task.taskId),
      finalTaskStatus: stored.status,
    })}`
  );
});
