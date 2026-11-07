/**
 * A-10 / §17：九类失败模式清单回归。
 *
 * 口径：
 *  a) 九类失败模式必须都存在、都有唯一处置动作（retry/recovery/terminal/escalate），
 *     且带版本位，不允许只写表不接线；
 *  b) 每条用例都从真实子系统注入失败（依赖图校验、真实 Store 互等依赖、
 *     真实事件重复投递、真实租约过期、真实产物断链、真实半写、真实预算闸门、
 *     真实审批 SLA），再断言「识别为哪一类 + 走哪个处置」；
 *  c) 不新增状态：处置复用既有 failed/recovery/completed/waiting_approval 语义。
 */
const fs = require('fs');
const os = require('os');
const path = require('path');
const test = require('node:test');
const assert = require('node:assert');

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'bluebird-agent-failure-modes-'));
process.env.BLUEBIRD_DATA_DIR = TMP;
process.env.DEEPSEEK_API_KEY = '';
process.env.BLUEBIRD_AGENT_TOOLS = '';
process.env.BLUEBIRD_MONITORING = '0';

const tasks = require('../server/agents/tasks');
const artifactStore = require('../server/agents/artifact-store');
const artifactCommit = require('../server/agents/artifact-commit');
const approvals = require('../server/agents/approvals');
const dependencies = require('../server/agents/dependencies');
const runtime = require('../server/agents/runtime');
const errors = require('../server/agents/errors');
const { normalizeWorkerResult } = require('../server/agents/worker-result');

const AGENTS_DIR = path.join(TMP, 'agents');
let seq = 0;

function resetStore() {
  fs.rmSync(AGENTS_DIR, { recursive: true, force: true });
  tasks.reloadForTests();
  if (typeof artifactStore.reloadForTests === 'function') artifactStore.reloadForTests();
  if (typeof approvals.reloadForTests === 'function') approvals.reloadForTests();
}

function makeTask(goal = '失败模式测试') {
  seq += 1;
  return tasks.createTask({
    botId: 'memory',
    taskType: 'memory.search',
    goal: `${goal} ${seq}`,
    allowedTools: ['memory_search'],
    deadlineMs: 20000,
  });
}

function toRunning(task, ownerId = 'owner-test') {
  tasks.transitionTask(task.taskId, { to: 'accepted' });
  tasks.transitionTask(task.taskId, { to: 'running' });
  tasks.acquireLease(task.taskId, { ownerId });
  return tasks.getTask(task.taskId);
}

function assertModeAndAction(errorCode, expectedMode, expectedAction) {
  const mode = errors.classifyFailureMode({ errorCode });
  assert.strictEqual(mode, expectedMode, `${errorCode} 应识别为 ${expectedMode}`);
  const disposition = errors.failureModeDisposition(mode);
  assert.strictEqual(disposition.action, expectedAction);
  assert.strictEqual(disposition.policyVersion, errors.FAILURE_MODE_POLICY_VERSION);
  return disposition;
}

test('A-10 清单：失败模式齐全、处置动作合法（P5-C 起为原九类 + FM-4 plan_version_race）', () => {
  const modes = Object.values(errors.FAILURE_MODES);
  assert.strictEqual(modes.length, 10);
  for (const mode of modes) {
    const disposition = errors.failureModeDisposition(mode);
    assert.ok(disposition, `${mode} 必须有处置`);
    assert.ok(
      ['retry', 'recovery', 'terminal', 'escalate'].includes(disposition.action),
      `${mode} 处置动作必须是既有四类`
    );
    assert.ok(errors.FAILURE_MODE_LABELS[mode], `${mode} 必须有中文清单项`);
  }
  // 各类的默认处置（本仓库裁决口径）。
  assert.strictEqual(errors.failureModeDisposition('dependency_cycle').action, 'terminal');
  assert.strictEqual(errors.failureModeDisposition('dependency_deadlock').action, 'terminal');
  assert.strictEqual(errors.failureModeDisposition('event_out_of_order').action, 'recovery');
  assert.strictEqual(errors.failureModeDisposition('duplicate_execution').action, 'terminal');
  assert.strictEqual(errors.failureModeDisposition('stale_lease').action, 'terminal');
  assert.strictEqual(errors.failureModeDisposition('artifact_chain_broken').action, 'recovery');
  assert.strictEqual(errors.failureModeDisposition('partial_commit').action, 'recovery');
  assert.strictEqual(errors.failureModeDisposition('budget_exhausted').action, 'terminal');
  assert.strictEqual(errors.failureModeDisposition('approval_stall').action, 'escalate');
  // FM-4：旧代次仍尝试写 → 确定性拒绝，终态 failed，且不可重试。
  assert.strictEqual(
    errors.classifyFailureMode({ errorCode: 'stale_generation' }),
    'plan_version_race'
  );
  assert.strictEqual(errors.failureModeDisposition('plan_version_race').action, 'terminal');
  assert.strictEqual(errors.failureModeDisposition('plan_version_race').retryable, false);
  // 存储不可用不是版本竞争，不归入 FM-4（由恢复流程处理）。
  assert.strictEqual(errors.classifyFailureMode({ errorCode: 'fencing_unavailable' }), null);
});

test('A-10 dependency_cycle：真实依赖图校验拒绝环 → 终态', () => {
  resetStore();
  const a = makeTask('环 A');
  const b = makeTask('环 B');
  assert.throws(
    () =>
      dependencies.validateGraph({
        nodes: [
          { key: a.taskId, dependsOn: [b.taskId] },
          { key: b.taskId, dependsOn: [a.taskId] },
        ],
        tasksById: tasks.rawTasksById(),
      }),
    error => {
      assert.strictEqual(error.code, 'dependency_cycle');
      const disposition = assertModeAndAction(error.code, 'dependency_cycle', 'terminal');
      assert.strictEqual(disposition.retryable, false);
      assert.strictEqual(disposition.status, 'failed');
      return true;
    }
  );
});

test('A-10 dependency_deadlock：真实互等任务被收口为 failed 且事件可追', () => {
  resetStore();
  const a = makeTask('死锁 A');
  const b = makeTask('死锁 B');
  // 直接向真实 Store 注入互等边（createTask 入口本不允许成环，这里模拟历史脏数据）。
  const raw = tasks.rawTasksById();
  raw[a.taskId].dependsOn = [b.taskId];
  raw[b.taskId].dependsOn = [a.taskId];

  const settled = tasks.settleDependencies();
  const byTask = new Map(settled.map(item => [item.taskId, item]));
  assert.strictEqual(byTask.has(a.taskId), true);
  assert.strictEqual(byTask.has(b.taskId), true);
  for (const taskId of [a.taskId, b.taskId]) {
    const task = tasks.getTask(taskId);
    assert.strictEqual(task.status, 'failed');
    assert.strictEqual(task.errorCode, 'dependency_deadlock');
  }
  const event = tasks
    .listEvents('memory', { limit: 100 })
    .find(
      item =>
        item.taskId === a.taskId &&
        item.eventType === 'task.dependency_failed' &&
        item.payload.failureMode === 'dependency_deadlock'
    );
  assert.ok(event, '死锁收口必须留 task.dependency_failed 事件');
  const disposition = assertModeAndAction('dependency_deadlock', 'dependency_deadlock', 'terminal');
  assert.strictEqual(disposition.errorCode, 'dependency_deadlock');
});

test('A-10 event_out_of_order：真实重复投递后重启 → recovery 并留痕', () => {
  resetStore();
  const task = toRunning(makeTask('事件乱序'));
  const first = tasks.appendEvent({
    botId: 'memory',
    taskId: task.taskId,
    eventType: 'task.started',
    dedupeKey: 'failure-mode-event-order-key',
    payload: { status: 'running' },
  });
  const duplicate = tasks.appendEvent({
    botId: 'memory',
    taskId: task.taskId,
    eventType: 'task.started',
    dedupeKey: 'failure-mode-event-order-key',
    payload: { status: 'running' },
  });
  assert.strictEqual(duplicate.eventId, first.eventId);
  assert.strictEqual(duplicate.dedupeCount, 1);

  const violations = tasks.detectEventOrderViolations({ botId: 'memory' });
  assert.strictEqual(violations[0].taskId, task.taskId);
  assert.strictEqual(violations[0].reason, 'duplicate_delivery');

  const recovered = tasks.recoverInterrupted({ ownerId: null });
  assert.strictEqual(recovered.recovery, 1);
  const after = tasks.getTask(task.taskId);
  assert.strictEqual(after.status, 'recovery');
  assert.strictEqual(after.errorCode, 'recovery_event_order_violation');
  const event = tasks
    .listEvents('memory', { limit: 100 })
    .find(
      item =>
        item.taskId === task.taskId &&
        item.eventType === 'task.recovered' &&
        item.payload.errorCode === 'recovery_event_order_violation'
    );
  assert.ok(event);
  assert.strictEqual(event.payload.mode, 'event_order_reconcile');
  assert.strictEqual(event.payload.failureMode, 'event_out_of_order');
  assertModeAndAction('recovery_event_order_violation', 'event_out_of_order', 'recovery');
});

test('A-10 duplicate_execution：真实幂等键重复建任务只保留一条 → 终态丢弃', () => {
  resetStore();
  const params = {
    botId: 'memory',
    taskType: 'memory.search',
    goal: '幂等重复执行',
    allowedTools: ['memory_search'],
    idempotencyKey: 'failure-mode-idempotent-key',
  };
  const first = tasks.createTask(params);
  const second = tasks.createTask({ ...params, goal: '幂等重复执行（第二次）' });
  assert.strictEqual(second.taskId, first.taskId);
  assert.strictEqual(second.idempotent, true);
  assert.strictEqual(tasks.listTasks('memory', { limit: 50 }).length, 1);
  const disposition = assertModeAndAction('idempotent_drop', 'duplicate_execution', 'terminal');
  assert.strictEqual(disposition.status, 'completed');
});

test('A-10 stale_lease：真实租约过期后仍续租 → 终态 failed', () => {
  resetStore();
  const task = toRunning(makeTask('租约过期'), 'owner-a');
  const acquiredAt = Date.parse(tasks.getTask(task.taskId).lease.expiresAt);
  assert.throws(
    () =>
      tasks.renewLease(task.taskId, {
        ownerId: 'owner-a',
        now: acquiredAt + 1000,
      }),
    error => {
      assert.strictEqual(error.code, 'task_lease_lost');
      const disposition = assertModeAndAction(error.code, 'stale_lease', 'terminal');
      assert.strictEqual(disposition.status, 'failed');
      return true;
    }
  );
  // runtime 失败分支同口径：任务租约丢失 → terminal failed，事件带 failureMode。
  const runtimeDisposition = runtime.decideFailureDisposition({
    phase: 'run',
    errorCode: 'task_lease_lost',
    attempts: 1,
    maxAttempts: 3,
  });
  assert.strictEqual(runtimeDisposition.action, 'terminal');
  assert.strictEqual(runtimeDisposition.status, 'failed');
  assert.strictEqual(runtimeDisposition.failureMode, 'stale_lease');
});

test('A-10 artifact_chain_broken：真实产物记录被删后重启 → recovery 并留痕', () => {
  resetStore();
  const task = toRunning(makeTask('产物断链'));
  const artifact = artifactStore.persist({
    kind: 'message',
    content: { text: '断链测试产物' },
    taskId: task.taskId,
  });
  tasks.updateTask(task.taskId, {
    result: normalizeWorkerResult({
      status: 'completed',
      summary: '引用产物',
      artifacts: [{ kind: 'message', id: artifact.id, version: artifact.version }],
    }),
  });
  const indexFile = path.join(AGENTS_DIR, 'agent-artifacts.json');
  const index = JSON.parse(fs.readFileSync(indexFile, 'utf8'));
  delete index.artifacts[artifact.id];
  fs.writeFileSync(indexFile, JSON.stringify(index));
  tasks.reloadForTests();

  const result = tasks.recoverInterrupted({ ownerId: null });
  assert.strictEqual(result.recovery, 1);
  const after = tasks.getTask(task.taskId);
  assert.strictEqual(after.status, 'recovery');
  assert.strictEqual(after.errorCode, 'recovery_artifact_reference_broken');
  const event = tasks
    .listEvents('memory', { limit: 100 })
    .find(
      item =>
        item.taskId === task.taskId &&
        item.eventType === 'task.recovered' &&
        item.payload.errorCode === 'recovery_artifact_reference_broken'
    );
  assert.ok(event);
  assert.strictEqual(event.payload.failureMode, 'artifact_chain_broken');
  assertModeAndAction('recovery_artifact_reference_broken', 'artifact_chain_broken', 'recovery');
});

test('A-10 partial_commit：真实半写产物扫描 → recovery 口径', () => {
  resetStore();
  const task = toRunning(makeTask('提交中断'));
  const original = tasks.transitionTask;
  let refs = [];
  tasks.transitionTask = () => {
    throw new errors.AgentError('injected_transition_failure', '注入的状态提交失败', 500);
  };
  try {
    refs = artifactCommit.persistTaskArtifacts({
      taskId: task.taskId,
      runId: 'run_failure_partial',
      artifacts: [{ kind: 'message', content: { text: '半写产物' } }],
    });
    const result = normalizeWorkerResult({
      status: 'completed',
      summary: '提交失败',
      artifacts: refs,
      runId: 'run_failure_partial',
    });
    assert.throws(() =>
      artifactCommit.completeTask(task.taskId, {
        completedAt: new Date().toISOString(),
        result,
      })
    );
  } finally {
    tasks.transitionTask = original;
  }
  const pending = artifactStore.get(refs[0] ? refs[0].id : '');
  assert.strictEqual(pending.commit, 'pending-commit');
  const scan = artifactCommit.scanPendingCommits({ ttlMs: 0 });
  assert.strictEqual(scan.orphaned.length >= 1, true);
  const disposition = assertModeAndAction('pending_commit', 'partial_commit', 'recovery');
  assert.strictEqual(disposition.errorCode, 'recovery_partial_commit');
});

test('A-10 budget_exhausted：真实父任务预算闸门拒绝子任务 → 终态', () => {
  resetStore();
  const parent = tasks.createTask({
    botId: 'memory',
    taskType: 'memory.search',
    goal: '预算父任务',
    allowedTools: ['memory_search'],
    runId: 'run_failure_budget',
    runBudget: 1000,
    budget: { maxRounds: 3, maxToolCalls: 6, maxReadOnlyRetries: 1, tokenBudget: 1000 },
  });
  assert.throws(
    () =>
      tasks.createTask({
        botId: 'memory',
        taskType: 'memory.search',
        goal: '预算子任务',
        allowedTools: ['memory_search'],
        parentTaskId: parent.taskId,
        runId: 'run_failure_budget',
        budget: { maxRounds: 3, maxToolCalls: 6, maxReadOnlyRetries: 1, tokenBudget: 5000 },
      }),
    error => {
      assert.strictEqual(error.code, 'budget_exceeded');
      const disposition = assertModeAndAction(error.code, 'budget_exhausted', 'terminal');
      assert.strictEqual(disposition.retryable, false);
      return true;
    }
  );
});

test('A-10 approval_stall：真实 SLA 到期 → 升级审批并留痕', () => {
  resetStore();
  const approval = approvals.createApproval({
    botId: 'memory',
    operation: 'merge',
    payload: { targetId: 'mem_failure_target', sourceIds: ['mem_failure_source'] },
  });
  const overdue = approvals.markOverdue(approval.approvalId, {
    now: Date.parse(approval.expiresAt) + 60 * 1000,
  });
  assert.strictEqual(overdue.requestStatus, 'expired');
  const event = tasks
    .listEvents('memory', { limit: 100 })
    .find(
      item =>
        item.eventType === 'approval.overdue' &&
        item.payload &&
        item.payload.failureMode === 'approval_stall'
    );
  assert.ok(event, '审批悬挂必须留 approval.overdue 事件并带 failureMode');
  const disposition = assertModeAndAction('approval_expired', 'approval_stall', 'escalate');
  assert.strictEqual(disposition.escalationOperation, 'review.escalate');
});
