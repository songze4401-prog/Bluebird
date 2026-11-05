/* global require, process */
/**
 * §24 写权限与迁移校验回归（两条用例）。
 *
 * 断言口径（对齐原文）：
 *  a) 越权写入被拒：绕过 transitionTask 写 status、或直接写存储层拥有的
 *     stateVersion，都必须显式失败且不留副作用；
 *  b) 非法迁移审计：非法迁移不仅拒绝，还要在事件审计里留下 from/to 与原因。
 *
 * 隔离纪律：BLUEBIRD_DATA_DIR 在 require server/ 之前指向临时目录。
 */
const fs = require('fs');
const os = require('os');
const path = require('path');
const test = require('node:test');
const assert = require('node:assert');

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'bluebird-transition-guard-'));
process.env.BLUEBIRD_DATA_DIR = TMP;

const tasks = require('../server/agents/tasks');

let seq = 0;

function makeTask() {
  seq += 1;
  return tasks.createTask({
    botId: 'memory',
    taskType: 'memory.search',
    goal: `§24 迁移校验 ${seq}`,
    allowedTools: ['memory_search'],
  });
}

test('§24 越权写入被拒：绕过 transitionTask 写 status / 直接写 stateVersion 必须失败', () => {
  const task = makeTask();
  const before = tasks.getRawTask(task.taskId);

  // Worker/Gateway 只能提交结果/决策事件，不能直接改状态。
  assert.throws(
    () => tasks.updateTask(task.taskId, { status: 'completed' }),
    error => {
      assert.strictEqual(error.code, 'task_status_requires_transition');
      assert.strictEqual(error.status, 400);
      return true;
    }
  );

  // stateVersion 由存储层分配，调用方只读（§24.3 CAS 依据）。
  assert.throws(
    () => tasks.updateTask(task.taskId, { stateVersion: 999 }),
    error => {
      assert.strictEqual(error.code, 'task_state_version_read_only');
      assert.strictEqual(error.status, 400);
      return true;
    }
  );

  // 拒绝后任务状态与版本均保持原样。
  const after = tasks.getRawTask(task.taskId);
  assert.strictEqual(after.status, before.status);
  assert.strictEqual(after.stateVersion, before.stateVersion);
});

test('§24 非法迁移审计：拒绝并留 from/to 与原因，状态不变', () => {
  const task = makeTask();
  const before = tasks.getRawTask(task.taskId);
  assert.strictEqual(before.status, 'queued');

  assert.throws(
    () => tasks.transitionTask(task.taskId, { to: 'running' }),
    error => {
      assert.strictEqual(error.code, 'invalid_transition');
      assert.strictEqual(error.status, 409);
      return true;
    }
  );

  const after = tasks.getRawTask(task.taskId);
  assert.strictEqual(after.status, 'queued');
  assert.strictEqual(after.stateVersion, before.stateVersion);

  const rejected = tasks
    .listEvents('memory', { limit: 100 })
    .filter(event => event.eventType === 'task.transition_rejected' && event.taskId === task.taskId);
  assert.strictEqual(rejected.length, 1);
  assert.deepStrictEqual(rejected[0].payload, {
    fromStatus: 'queued',
    toStatus: 'running',
    reason: 'invalid_transition',
  });
});
