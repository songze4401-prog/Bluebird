/* global process */
/**
 * Phase 3 第 3 项：成本追踪。
 * 单任务聚合 / 多任务与 Run 汇总不双计（含祖先链） / 无 usage 进未知桶。
 * 全部数据来自 recordRunFinish 写入的真实供应商 usage，不按字符数估算。
 */
const fs = require('fs');
const os = require('os');
const path = require('path');
const test = require('node:test');
const assert = require('node:assert');

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'bluebird-agent-cost-'));
process.env.BLUEBIRD_DATA_DIR = TMP;

const tasks = require('../server/agents/tasks');
const costTracker = require('../server/agents/cost-tracker');

const AGENTS_DIR = path.join(TMP, 'agents');

function resetStore() {
  fs.rmSync(AGENTS_DIR, { recursive: true, force: true });
  tasks.reloadForTests();
}

function budgetOf(tokenBudget) {
  return { maxRounds: 3, maxToolCalls: 6, maxReadOnlyRetries: 1, generatePlan: false, tokenBudget };
}

function newTask(extra = {}) {
  const task = tasks.createTask({
    botId: 'memory',
    taskType: 'memory.search',
    goal: '成本用例任务',
    allowedTools: ['memory_search'],
    ...extra,
  });
  tasks.transitionTask(task.taskId, { to: 'accepted' });
  tasks.transitionTask(task.taskId, { to: 'running' });
  return task;
}

function attempt(taskId, { runId, tokens, finishedAt, usage = true }) {
  tasks.recordRunStart(taskId, { runId, startedAt: finishedAt });
  tasks.recordRunFinish(taskId, {
    runId,
    status: 'completed',
    finishedAt,
    usage: usage ? { prompt_tokens: tokens, completion_tokens: 0, total_tokens: tokens } : null,
  });
  if (usage) tasks.settleTaskBudget(taskId, { reserved: 0, actual: tokens });
}

test('a. 单任务聚合：两次 attempt 的真实 usage 之和 = 任务成本 = Run 已结算', () => {
  resetStore();
  const task = newTask({
    budget: budgetOf(500),
    runId: 'run_cost_single',
    runBudget: 500,
  });
  attempt(task.taskId, { runId: 'run_attempt_a', tokens: 120, finishedAt: '2026-11-05T09:00:00.000Z' });
  attempt(task.taskId, { runId: 'run_attempt_b', tokens: 80, finishedAt: '2026-11-05T09:05:00.000Z' });

  const single = costTracker.taskCost(task.taskId);
  const run = costTracker.runCost('run_cost_single');
  const stored = tasks.getRawTask(task.taskId);

  assert.equal(single.tokens, 200);
  assert.equal(single.attempts, 2);
  assert.equal(single.known, true);
  assert.equal(stored.tokenUsage.used, 200, '预算账同样记 200，未被双计');
  assert.equal(run.tokens, 200);
  assert.equal(run.budgetUsed, 200);
  assert.equal(run.consistentWithBudget, true);

  console.log(
    `[EVIDENCE] cost-single-task ${JSON.stringify({
      taskId: task.taskId,
      costTokens: single.tokens,
      attempts: single.attempts,
      budgetUsed: stored.tokenUsage.used,
      runTokens: run.tokens,
      runBudgetUsed: run.budgetUsed,
      consistent: run.consistentWithBudget,
    })}`
  );
});

test('b. 多任务 + Run 汇总不双计（父任务 used 含子任务，但成本按自身 attempt 计）', () => {
  resetStore();
  const parent = newTask({ budget: budgetOf(400), runId: 'run_cost_multi', runBudget: 400 });
  const child = newTask({ parentTaskId: parent.taskId, budget: budgetOf(200) });

  attempt(parent.taskId, {
    runId: 'run_parent_a',
    tokens: 50,
    finishedAt: '2026-11-05T09:10:00.000Z',
  });
  attempt(child.taskId, {
    runId: 'run_child_a',
    tokens: 100,
    finishedAt: '2026-11-05T09:20:00.000Z',
  });

  const byTask = costTracker.aggregate({ groupBy: 'task' });
  const byRun = costTracker.aggregate({ groupBy: 'run' });
  const run = costTracker.runCost('run_cost_multi');
  const parentStored = tasks.getRawTask(parent.taskId);
  const childStored = tasks.getRawTask(child.taskId);
  const windowed = costTracker.aggregate({
    groupBy: 'task',
    from: '2026-11-05T09:15:00.000Z',
    to: '2026-11-05T09:25:00.000Z',
  });

  assert.equal(parentStored.tokenUsage.used, 150, '父链预算包含子任务用量');
  assert.equal(childStored.tokenUsage.used, 100);
  assert.equal(byTask.totalTokens, 150, '逐任务成本只按自身 usage 求和，不重复计入父链');
  assert.equal(byRun.totalTokens, 150);
  assert.equal(run.tokens, 150);
  assert.equal(run.budgetUsed, 150);
  assert.equal(run.consistentWithBudget, true);
  assert.equal(windowed.totalTokens, 100, '时间窗口只命中子任务那次 attempt');
  assert.equal(windowed.groups.length, 1);

  console.log(
    `[EVIDENCE] cost-run-no-double-count ${JSON.stringify({
      parentTaskId: parent.taskId,
      parentBudgetUsed: parentStored.tokenUsage.used,
      parentCostTokens: byTask.groups.find(group => group.key === parent.taskId).tokens,
      childCostTokens: byTask.groups.find(group => group.key === child.taskId).tokens,
      byTaskTotal: byTask.totalTokens,
      byRunTotal: byRun.totalTokens,
      runBudgetUsed: run.budgetUsed,
      consistent: run.consistentWithBudget,
      windowTokens: windowed.totalTokens,
    })}`
  );
});

test('c. 无 usage 的 attempt 进未知桶（tokens=null），不按 0 成本记账', () => {
  resetStore();
  const task = newTask({ budget: budgetOf(300), runId: 'run_cost_unknown', runBudget: 300 });
  attempt(task.taskId, { runId: 'run_unknown_a', tokens: 0, finishedAt: '2026-11-05T09:30:00.000Z', usage: false });

  const scoped = costTracker.aggregate({ groupBy: 'task' });
  const single = costTracker.taskCost(task.taskId);
  const run = costTracker.runCost('run_cost_unknown');

  assert.equal(scoped.totalTokens, 0);
  assert.equal(scoped.unknownAttempts, 1);
  assert.equal(scoped.unknown.tokens, null, '未知桶必须是 null，不能是 0');
  assert.deepEqual(scoped.unknown.tasks, [task.taskId]);
  assert.equal(scoped.complete, false);
  assert.equal(single.known, false);
  assert.equal(single.unknownAttempts, 1);
  assert.equal(run.consistentWithBudget, null, '有未知 attempt 时不得声称与预算对得上');

  console.log(
    `[EVIDENCE] cost-unknown-bucket ${JSON.stringify({
      taskId: task.taskId,
      totalTokens: scoped.totalTokens,
      unknownAttempts: scoped.unknownAttempts,
      unknownTokens: scoped.unknown.tokens,
      unknownTasks: scoped.unknown.tasks.length,
      complete: scoped.complete,
      taskKnown: single.known,
      runConsistent: run.consistentWithBudget,
    })}`
  );
});
