/* global require, process */
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'bluebird-limits-'));
process.env.BLUEBIRD_DATA_DIR = dataDir;

const tasks = require('../server/agents/tasks');
const limits = require('../server/agents/agent-limits');

function makeTask(extra = {}) {
  const parentTaskId = extra.parentTaskId || null;
  return tasks.createTask({
    botId: 'executor',
    taskType: 'action.execute',
    goal: `§25 硬限用例 ${Math.random().toString(16).slice(2)}`,
    budget: { maxRounds: 3, maxToolCalls: 6, maxReadOnlyRetries: 0, tokenBudget: 3000 },
    runBudget: parentTaskId ? null : 10000,
    ...extra,
  });
}

test('§25 委派深度第 3 层被拒（拒绝码 not_authorized）', () => {
  const root = makeTask({ runId: 'run_depth' });
  const worker = makeTask({ parentTaskId: root.taskId, runId: 'run_depth' });
  const subWorker = makeTask({ parentTaskId: worker.taskId, runId: 'run_depth' });
  const map = {};
  for (const id of [root.taskId, worker.taskId, subWorker.taskId]) {
    map[id] = tasks.getRawTask(id);
  }
  assert.equal(limits.delegationDepth(subWorker.taskId, map), 2);
  assert.throws(
    () => makeTask({ parentTaskId: subWorker.taskId, runId: 'run_depth' }),
    error => {
      assert.equal(error.code, 'not_authorized');
      assert.equal(error.status, 403);
      assert.equal(error.details.causeRef, 'delegation_depth_exceeded');
      assert.equal(error.details.retryable, false);
      assert.ok(error.details.errorFingerprint);
      assert.ok(error.details.failedAt);
      return true;
    }
  );
});

test('§25 重规划第 3 次被拒，Task 维度只记录不绕过', () => {
  limits.recordReplan({ runId: 'run_replan', taskId: 'task_replan' });
  limits.recordReplan({ runId: 'run_replan', taskId: 'task_replan' });
  assert.deepEqual(limits.readRun('run_replan'), {
    runId: 'run_replan',
    replans: 2,
    retries: 0,
  });
  assert.throws(
    () => limits.recordReplan({ runId: 'run_replan', taskId: 'task_replan_2' }),
    error => {
      assert.equal(error.code, 'validation_failed');
      assert.equal(error.details.causeRef, 'replan_limit_exceeded');
      assert.equal(error.details.retryable, false);
      return true;
    }
  );
});

test('§25 第 4 次 Run 重试被拒', () => {
  limits.recordRunRetry({ runId: 'run_retry', taskId: 'task_retry' });
  limits.recordRunRetry({ runId: 'run_retry', taskId: 'task_retry' });
  limits.recordRunRetry({ runId: 'run_retry', taskId: 'task_retry' });
  assert.equal(limits.readRun('run_retry').retries, 3);
  assert.throws(
    () => limits.recordRunRetry({ runId: 'run_retry', taskId: 'task_retry' }),
    error => {
      assert.equal(error.details.causeRef, 'run_retry_limit_exceeded');
      return true;
    }
  );
});

test('§25 计数持久化：模块重载后不归零', () => {
  limits.recordReplan({ runId: 'run_persist', taskId: 'task_persist' });
  limits.recordRunRetry({ runId: 'run_persist', taskId: 'task_persist' });
  const resolved = require.resolve('../server/agents/agent-limits');
  delete require.cache[resolved];
  const reloaded = require('../server/agents/agent-limits');
  assert.deepEqual(reloaded.readRun('run_persist'), {
    runId: 'run_persist',
    replans: 1,
    retries: 1,
  });
  assert.equal(fs.existsSync(reloaded.LIMITS_FILE), true);
});

test.after(() => {
  fs.rmSync(dataDir, { recursive: true, force: true });
});
