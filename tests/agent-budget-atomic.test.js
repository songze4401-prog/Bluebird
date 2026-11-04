/* global require, process, __dirname */
/**
 * B-06（Notion §25 预算规则 / Phase 1 退出判据「预算硬限制有效」）回归。
 *
 * 覆盖：Task Token 上限强制、原子 reserve、结算差额回冲、release、
 * 父子覆盖（父余额是子上限硬上界、子消耗计入父）、Run 级总闸门、
 * budget_exceeded 的 retryable=false 与「重试不重置额度」。
 *
 * 能证明什么：同一进程内（单写者 + stateVersion）的所有闸门在同一次同步
 * 「校验 → 改内存 → 落盘」中完成，没有 check 与 write 之间的 await 缝隙，
 * 因此并发调用不会超发；余额、父账、Run 账在 reserve/settle/release 后一致。
 *
 * 不能证明什么：跨进程 / 多实例并发（本文件不覆盖，需要真实多进程压测）；
 * 供应商真实 usage 的准确性（这里用显式金额模拟，真实计量依赖模型返回 usage）。
 */
const fs = require('fs');
const os = require('os');
const path = require('path');
const test = require('node:test');
const assert = require('node:assert');

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'bluebird-agent-budget-'));
process.env.BLUEBIRD_DATA_DIR = TMP;
process.env.DEEPSEEK_API_KEY = '';
process.env.BLUEBIRD_AGENT_TOOLS = '';
process.env.BLUEBIRD_MONITORING = '0';

const tasks = require('../server/agents/tasks');
const sessions = require('../server/agents/sessions');

function resetStore() {
  fs.rmSync(path.join(TMP, 'agents'), { recursive: true, force: true });
  tasks.reloadForTests();
  sessions.reloadForTests();
}

function budgetOf(tokenBudget) {
  return {
    maxRounds: 3,
    maxToolCalls: 6,
    maxReadOnlyRetries: 0,
    generatePlan: false,
    tokenBudget,
  };
}

function makeTask(overrides = {}) {
  return tasks.createTask({
    botId: 'memory',
    taskType: 'memory.search',
    goal: 'B-06 预算原子计量用例',
    allowedTools: ['memory_search'],
    deadlineMs: 20000,
    ...overrides,
  });
}

function assertBudgetExceeded(error, expectedScope) {
  assert.equal(error.code, 'budget_exceeded');
  assert.equal(error.details && error.details.retryable, false);
  if (expectedScope) assert.equal(error.details.scope, expectedScope);
}

test('B-06a 真并发：两个写者同时抢同一父余额，只有一个成功', async () => {
  resetStore();
  const parent = makeTask({ budget: budgetOf(1000) });
  const childA = makeTask({ parentTaskId: parent.taskId, budget: budgetOf(600) });
  const childB = makeTask({ parentTaskId: parent.taskId, budget: budgetOf(600) });

  // 两个 async 写者先各自让出一次 microtask，再同时进入 reserve；
  // 不是「串行 await 完成第一个再跑第二个」的假并发。
  const attempts = await Promise.allSettled([
    (async () => {
      await Promise.resolve();
      return tasks.reserveTaskBudget(childA.taskId, { amount: 600 });
    })(),
    (async () => {
      await Promise.resolve();
      return tasks.reserveTaskBudget(childB.taskId, { amount: 600 });
    })(),
  ]);

  const fulfilled = attempts.filter(item => item.status === 'fulfilled');
  const rejected = attempts.filter(item => item.status === 'rejected');
  assert.equal(fulfilled.length, 1, '同一父余额只允许一个写者预留成功');
  assert.equal(rejected.length, 1);
  assertBudgetExceeded(rejected[0].reason, `parent:${parent.taskId}`);

  const parentSnapshot = tasks.getTaskBudgetSnapshot(parent.taskId);
  assert.equal(parentSnapshot.reserved, 600);
  assert.equal(parentSnapshot.used, 0);
  assert.equal(parentSnapshot.remaining, 400);
});

test('B-06b 超限后重试不重置额度', async () => {
  resetStore();
  const parent = makeTask({ budget: budgetOf(1000) });
  const childA = makeTask({ parentTaskId: parent.taskId, budget: budgetOf(600) });
  const childB = makeTask({ parentTaskId: parent.taskId, budget: budgetOf(600) });

  tasks.reserveTaskBudget(childA.taskId, { amount: 600 });
  const before = tasks.getTaskBudgetSnapshot(parent.taskId);

  // 第一次超限。
  assert.throws(
    () => tasks.reserveTaskBudget(childB.taskId, { amount: 600 }),
    error => {
      assertBudgetExceeded(error, `parent:${parent.taskId}`);
      return true;
    }
  );
  // 「重试」同一调用：额度保持被占用，不因重试而复位。
  assert.throws(
    () => tasks.reserveTaskBudget(childB.taskId, { amount: 600 }),
    error => {
      assertBudgetExceeded(error, `parent:${parent.taskId}`);
      return true;
    }
  );
  const after = tasks.getTaskBudgetSnapshot(parent.taskId);
  assert.deepEqual(after, before, '重试前后父账（used/reserved/remaining）不得变化');
});

test('B-06c 父子覆盖：父不足则子创建即拒；子消耗计入父', () => {
  resetStore();
  const parent = makeTask({ budget: budgetOf(1000) });

  // 子上限 1200 > 父余额 1000：创建即拒，错误带父作用域且不可重试。
  assert.throws(
    () => makeTask({ parentTaskId: parent.taskId, budget: budgetOf(1200) }),
    error => {
      assertBudgetExceeded(error, `parent:${parent.taskId}`);
      assert.equal(error.details.remaining, 1000);
      return true;
    }
  );

  // 子上限 600 合法；子预留后按真实用量结算，消耗计入父。
  const child = makeTask({ parentTaskId: parent.taskId, budget: budgetOf(600) });
  tasks.reserveTaskBudget(child.taskId, { amount: 600 });
  tasks.settleTaskBudget(child.taskId, { reserved: 600, actual: 450 });

  const childSnapshot = tasks.getTaskBudgetSnapshot(child.taskId);
  const parentSnapshot = tasks.getTaskBudgetSnapshot(parent.taskId);
  assert.equal(childSnapshot.used, 450);
  assert.equal(childSnapshot.remaining, 150);
  assert.equal(parentSnapshot.used, 450, '子任务消耗必须计入父任务账');
  assert.equal(parentSnapshot.reserved, 0);
  assert.equal(parentSnapshot.remaining, 550);
});

test('B-06d 结算差额：预留多、实际少，余额回冲正确', () => {
  resetStore();
  const task = makeTask({ budget: budgetOf(1000) });
  tasks.reserveTaskBudget(task.taskId, { amount: 1000 });
  assert.equal(tasks.getTaskBudgetSnapshot(task.taskId).remaining, 0);

  tasks.settleTaskBudget(task.taskId, { reserved: 1000, actual: 300 });
  const snapshot = tasks.getTaskBudgetSnapshot(task.taskId);
  assert.equal(snapshot.used, 300);
  assert.equal(snapshot.reserved, 0);
  assert.equal(snapshot.remaining, 700, '预留 1000 / 实际 300 → 回冲 700');
});

test('B-06e release：失败/取消后余额恢复', () => {
  resetStore();
  const task = makeTask({ budget: budgetOf(1000) });
  tasks.reserveTaskBudget(task.taskId, { amount: 1000 });
  assert.equal(tasks.getTaskBudgetSnapshot(task.taskId).remaining, 0);

  tasks.releaseTaskBudget(task.taskId, { amount: 1000 });
  const snapshot = tasks.getTaskBudgetSnapshot(task.taskId);
  assert.equal(snapshot.used, 0, 'release 不产生消耗');
  assert.equal(snapshot.reserved, 0);
  assert.equal(snapshot.remaining, 1000);
});

test('B-06f Run 总闸门：同一 Run 下累计不得超预算', () => {
  resetStore();
  const first = makeTask({
    budget: budgetOf(600),
    runId: 'run-b06-shared',
    runBudget: 1000,
  });
  const second = makeTask({ budget: budgetOf(600), runId: 'run-b06-shared' });

  tasks.reserveTaskBudget(first.taskId, { amount: 600 });
  assert.throws(
    () => tasks.reserveTaskBudget(second.taskId, { amount: 600 }),
    error => {
      assertBudgetExceeded(error, 'run:run-b06-shared');
      assert.equal(error.details.remaining, 400);
      return true;
    }
  );

  // 首个任务结算 300 后，Run 账已用 300、预留 0，剩余 700，第二个任务可继续。
  tasks.settleTaskBudget(first.taskId, { reserved: 600, actual: 300 });
  assert.doesNotThrow(() => tasks.reserveTaskBudget(second.taskId, { amount: 600 }));
});

test('B-06g 创建约束：显式 budget 缺 tokenBudget 即拒；未给 budget 落默认硬上限', () => {
  resetStore();
  assert.throws(
    () =>
      makeTask({
        budget: {
          maxRounds: 3,
          maxToolCalls: 6,
          maxReadOnlyRetries: 0,
          generatePlan: false,
        },
      }),
    error => {
      assert.equal(error.code, 'validation_failed');
      return true;
    }
  );

  const task = makeTask();
  assert.equal(task.budget && task.budget.tokenBudget, tasks.DEFAULT_TASK_TOKEN_BUDGET);
  assert.equal(task.tokenUsage.reserved, 0);
  assert.equal(task.tokenUsage.used, 0);
});
