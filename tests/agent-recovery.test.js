/* global require, process, __dirname */
/**
 * 阶段 3 恢复与故障注入回归。
 *
 * 覆盖：状态机合法迁移、Store schema v1→v2 迁移、租约获取/续约/过期、
 * 重试退避、checkpoint 版本、运行历史、启动恢复（重排队/uncertain/保持运行）、
 * 强制终止进程后的恢复、结果投递幂等与崩溃补投、存储损坏/写入失败的显式路径。
 */
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');
const test = require('node:test');
const assert = require('node:assert');

const ROOT = path.join(__dirname, '..');
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'bluebird-agent-recovery-'));
process.env.BLUEBIRD_DATA_DIR = TMP;
process.env.DEEPSEEK_API_KEY = '';
process.env.BLUEBIRD_AGENT_TOOLS = '';
process.env.BLUEBIRD_MONITORING = '0';

const stateMachine = require('../server/agents/state-machine');
const taskStore = require('../server/agents/task-store');
const tasks = require('../server/agents/tasks');
const sessions = require('../server/agents/sessions');
const resultDelivery = require('../server/agents/result-delivery');
const mainSessions = require('../server/sessions');

const AGENTS_DIR = path.join(TMP, 'agents');

function resetStore() {
  fs.rmSync(AGENTS_DIR, { recursive: true, force: true });
  tasks.reloadForTests();
  sessions.reloadForTests();
}

function makeTask(overrides = {}) {
  return tasks.createTask({
    botId: 'memory',
    taskType: 'memory.search',
    goal: '恢复测试任务',
    allowedTools: ['memory_search'],
    deadlineMs: 20000,
    ...overrides,
  });
}

function toRunning(task, ownerId = 'dead-owner') {
  tasks.updateTask(task.taskId, { status: 'accepted' });
  tasks.updateTask(task.taskId, { status: 'running' });
  tasks.acquireLease(task.taskId, { ownerId });
  return tasks.getTask(task.taskId);
}

// ---- A. 状态机 ----

test('状态机：主链路合法迁移', () => {
  const chain = ['queued', 'accepted', 'running', 'waiting_approval', 'completed'];
  for (let i = 0; i < chain.length - 1; i += 1) {
    assert.equal(stateMachine.canTransition(chain[i], chain[i + 1]), true);
    stateMachine.assertTransition(chain[i], chain[i + 1]);
  }
});

test('状态机：跳步与回退被拒绝', () => {
  assert.equal(stateMachine.canTransition('queued', 'completed'), false);
  assert.throws(
    () => stateMachine.assertTransition('queued', 'completed'),
    error => error && error.code === 'invalid_transition'
  );
  assert.throws(
    () => stateMachine.assertTransition('completed', 'running'),
    error => error && error.code === 'invalid_transition'
  );
});

test('状态机：uncertain 是终态，只能由中间态进入', () => {
  assert.equal(stateMachine.isTerminal('uncertain'), true);
  assert.equal(stateMachine.canTransition('running', 'uncertain'), true);
  assert.equal(stateMachine.canTransition('uncertain', 'queued'), false);
});

test('状态机：只有 accepted/running 需要恢复', () => {
  assert.equal(stateMachine.isRecoverable('accepted'), true);
  assert.equal(stateMachine.isRecoverable('running'), true);
  assert.equal(stateMachine.isRecoverable('queued'), false);
  assert.equal(stateMachine.isRecoverable('waiting_approval'), false);
  assert.equal(stateMachine.isRecoverable('completed'), false);
});

// ---- B. Store schema 迁移 ----

test('Store：v1 任务文件迁移到 v2 并补齐阶段 3 字段', () => {
  resetStore();
  fs.mkdirSync(AGENTS_DIR, { recursive: true });
  fs.writeFileSync(
    path.join(AGENTS_DIR, 'agent-tasks.json'),
    JSON.stringify({
      version: 1,
      tasks: {
        task_legacy: {
          taskId: 'task_legacy',
          botId: 'memory',
          sessionId: 'bs_legacy',
          taskType: 'memory.search',
          goal: '旧任务',
          allowedTools: ['memory_search'],
          deadlineMs: 20000,
          status: 'queued',
          attempts: 0,
          createdAt: '2026-10-01T00:00:00.000Z',
          updatedAt: '2026-10-01T00:00:00.000Z',
        },
      },
    })
  );
  const result = taskStore.read();
  assert.equal(result.migrated, true);
  assert.equal(result.fromVersion, 1);
  assert.equal(result.store.version, 2);
  const task = result.store.tasks.task_legacy;
  assert.equal(task.agentId, 'memory');
  assert.equal(task.workerSessionId, 'bs_legacy');
  assert.equal(task.lease, null);
  assert.equal(task.retryAt, null);
  assert.equal(task.lastErrorCode, null);
  assert.equal(task.checkpointVersion, 0);
  assert.deepEqual(task.runs, []);
});

test('Store：迁移幂等，二次读取不再改写', () => {
  resetStore();
  const first = taskStore.read();
  taskStore.write(first.store);
  const second = taskStore.read();
  assert.equal(second.migrated, false);
  assert.equal(second.store.version, 2);
});

test('Store：未知版本与损坏 JSON 都明确报错', () => {
  resetStore();
  fs.mkdirSync(AGENTS_DIR, { recursive: true });
  const file = path.join(AGENTS_DIR, 'agent-tasks.json');
  fs.writeFileSync(file, JSON.stringify({ version: 99, tasks: {} }));
  assert.throws(
    () => taskStore.read(),
    error => error && error.code === 'agent_tasks_corrupted'
  );
  fs.writeFileSync(file, '{not-json');
  assert.throws(
    () => taskStore.read(),
    error => error && error.code === 'agent_tasks_corrupted'
  );
});

// ---- C. 租约 ----

test('租约：获取后写入 owner 与过期时间', () => {
  resetStore();
  const task = makeTask();
  const leased = tasks.acquireLease(task.taskId, { ownerId: 'worker-a', ttlMs: 30000 });
  assert.equal(leased.lease.ownerId, 'worker-a');
  assert.ok(leased.lease.expiresAt);
  assert.ok(leased.lease.heartbeatAt);
});

test('租约：其他 owner 在租约有效期内被拒绝', () => {
  resetStore();
  const task = makeTask();
  tasks.acquireLease(task.taskId, { ownerId: 'worker-a', ttlMs: 30000 });
  assert.throws(
    () => tasks.acquireLease(task.taskId, { ownerId: 'worker-b', ttlMs: 30000 }),
    error => error && error.code === 'task_lease_held'
  );
});

test('租约：过期后可被新 owner 接管', () => {
  resetStore();
  const task = makeTask();
  const now = Date.now();
  tasks.acquireLease(task.taskId, { ownerId: 'worker-a', ttlMs: 1000, now });
  const later = now + 5000;
  const taken = tasks.acquireLease(task.taskId, {
    ownerId: 'worker-b',
    ttlMs: 30000,
    now: later,
  });
  assert.equal(taken.lease.ownerId, 'worker-b');
});

test('租约：续约刷新心跳，owner 不匹配报 task_lease_lost', () => {
  resetStore();
  const task = makeTask();
  tasks.acquireLease(task.taskId, { ownerId: 'worker-a', ttlMs: 30000 });
  const renewed = tasks.renewLease(task.taskId, { ownerId: 'worker-a', ttlMs: 30000 });
  assert.ok(renewed.lease.heartbeatAt);
  assert.throws(
    () => tasks.renewLease(task.taskId, { ownerId: 'worker-b', ttlMs: 30000 }),
    error => error && error.code === 'task_lease_lost'
  );
});

test('租约：释放后清空，终态任务不能再获取', () => {
  resetStore();
  const task = makeTask();
  tasks.acquireLease(task.taskId, { ownerId: 'worker-a' });
  assert.equal(tasks.releaseLease(task.taskId).lease, null);
  const done = makeTask();
  tasks.updateTask(done.taskId, { status: 'accepted' });
  tasks.updateTask(done.taskId, { status: 'failed' });
  assert.throws(
    () => tasks.acquireLease(done.taskId, { ownerId: 'worker-a' }),
    error => error && error.code === 'task_lease_terminal'
  );
});

// ---- D. checkpoint / 重试 / 运行历史 ----

test('checkpoint：每次写入递增 checkpointVersion', () => {
  resetStore();
  const task = makeTask();
  const first = tasks.recordCheckpoint(task.taskId, { round: 1, toolCalls: 0, phase: 'model_requested' });
  const second = tasks.recordCheckpoint(task.taskId, { round: 1, toolCalls: 1, phase: 'tool_result' });
  assert.equal(first.checkpointVersion, 1);
  assert.equal(second.checkpointVersion, 2);
  assert.equal(second.checkpoint.toolCalls, 1);
});

test('重试：写 retryAt/lastErrorCode，队列在到期前跳过', () => {
  resetStore();
  const task = toRunning(makeTask());
  const retried = tasks.setRetry(task.taskId, { errorCode: 'model_timeout' });
  assert.equal(retried.status, 'queued');
  assert.equal(retried.lastErrorCode, 'model_timeout');
  assert.ok(retried.retryAt);
  assert.equal(tasks.nextQueuedTask(), null);
  assert.equal(
    tasks.nextQueuedTask(Date.parse(retried.retryAt) + 1).taskId,
    task.taskId
  );
});

test('运行历史：记录 run 起止，且只保留最近 5 条', () => {
  resetStore();
  const task = makeTask();
  for (let i = 1; i <= 7; i += 1) {
    tasks.recordRunStart(task.taskId, {
      runId: `run_${i}`,
      attempt: i,
      startedAt: new Date(1700000000000 + i * 1000).toISOString(),
    });
  }
  let current = tasks.getTask(task.taskId);
  assert.equal(current.runs.length, 5);
  assert.equal(current.runs.at(-1).runId, 'run_7');
  tasks.recordRunFinish(task.taskId, {
    runId: 'run_7',
    status: 'failed',
    errorCode: 'model_server',
  });
  current = tasks.getTask(task.taskId);
  const last = current.runs.find(item => item.runId === 'run_7');
  assert.ok(last.finishedAt);
  assert.equal(last.status, 'failed');
  assert.equal(last.errorCode, 'model_server');
});

// ---- E. 启动恢复 ----

test('恢复：只读任务重排队，绝不直接报告成功', () => {
  resetStore();
  const task = toRunning(makeTask());
  tasks.reloadForTests();
  const result = tasks.recoverInterrupted({ ownerId: null });
  assert.equal(result.recovered, 1);
  assert.equal(result.uncertain, 0);
  const recovered = tasks.getTask(task.taskId);
  assert.equal(recovered.status, 'queued');
  assert.equal(recovered.lastErrorCode, 'recovered_after_restart');
  assert.ok(recovered.recoveredAt);
  assert.notEqual(recovered.status, 'completed');
});

test('恢复：可能产生副作用的任务标记 uncertain 等待人工处理', () => {
  resetStore();
  const task = toRunning(makeTask({ allowedTools: ['memory_remember'] }));
  tasks.reloadForTests();
  const result = tasks.recoverInterrupted({ ownerId: null });
  assert.equal(result.uncertain, 1);
  const recovered = tasks.getTask(task.taskId);
  assert.equal(recovered.status, 'uncertain');
  assert.equal(recovered.requiresReview, true);
  assert.equal(recovered.errorCode, 'recovery_uncertain_side_effects');
  assert.equal(recovered.result.status, 'uncertain');
  assert.notEqual(recovered.status, 'completed');
});

test('恢复：waiting_approval 保持暂停，不被自动执行', () => {
  resetStore();
  const task = makeTask();
  tasks.updateTask(task.taskId, { status: 'waiting_approval' });
  tasks.reloadForTests();
  const result = tasks.recoverInterrupted({ ownerId: null });
  assert.equal(result.recovered, 0);
  assert.equal(result.uncertain, 0);
  assert.equal(tasks.getTask(task.taskId).status, 'waiting_approval');
});

test('恢复：租约由其他存活 owner 持有时保持 running', () => {
  resetStore();
  const task = toRunning(makeTask(), 'worker-live');
  tasks.reloadForTests();
  const result = tasks.recoverInterrupted({
    ownerId: 'worker-other',
    now: Date.now(),
  });
  assert.equal(result.leftRunning, 1);
  assert.equal(result.recovered, 0);
  assert.equal(tasks.getTask(task.taskId).status, 'running');
});

test('恢复：uncertain 结果按 taskId 幂等投递到父会话', () => {
  resetStore();
  const parent = mainSessions.createSession({ title: '恢复投递' });
  const task = toRunning(
    makeTask({ allowedTools: ['memory_remember'], parentSessionId: parent.id })
  );
  tasks.reloadForTests();
  tasks.recoverInterrupted({ ownerId: null });
  const before = mainSessions.getMessages(parent.id).length;
  resultDelivery.recoverPending();
  const after = mainSessions.getMessages(parent.id);
  assert.equal(after.length, before + 1);
  assert.ok(after.at(-1).content.includes('【Memory Bot 任务未完成】'));
  assert.ok(after.at(-1).content.includes('uncertain'));
  resultDelivery.recoverPending();
  assert.equal(mainSessions.getMessages(parent.id).length, before + 1);
});

test('健康快照：只含计数与时间点', () => {
  resetStore();
  makeTask({ goal: '排队' });
  const running = toRunning(makeTask({ goal: '运行中' }));
  const done = makeTask({ goal: '完成' });
  tasks.updateTask(done.taskId, { status: 'accepted' });
  tasks.updateTask(done.taskId, { status: 'running' });
  tasks.updateTask(done.taskId, { status: 'completed' });
  const health = tasks.healthSnapshot(Date.now() + 120000);
  assert.equal(health.schemaVersion, 2);
  assert.equal(health.counts.queued, 1);
  assert.equal(health.counts.running, 1);
  assert.equal(health.counts.terminal, 1);
  assert.equal(health.counts.uncertain, 0);
  assert.equal(health.expiredLeases, 1);
  assert.equal(health.checkedAt.includes('T'), true);
  assert.ok(!JSON.stringify(health).includes('运行中'));
  assert.equal(tasks.getTask(running.taskId).status, 'running');
});

// ---- F. 强制终止进程后的恢复 ----

test('崩溃注入：子进程 SIGKILL 后恢复只读任务并标记写任务 uncertain', () => {
  resetStore();
  const script = `
process.env.BLUEBIRD_DATA_DIR = ${JSON.stringify(TMP)};
const tasks = require('./server/agents/tasks');
const readOnly = tasks.createTask({ botId: 'memory', taskType: 'memory.search', goal: '崩溃只读', allowedTools: ['memory_search'], deadlineMs: 20000 });
tasks.updateTask(readOnly.taskId, { status: 'accepted' });
tasks.updateTask(readOnly.taskId, { status: 'running' });
tasks.acquireLease(readOnly.taskId, { ownerId: 'dead-child' });
const writeTask = tasks.createTask({ botId: 'memory', taskType: 'memory.search', goal: '崩溃写入', allowedTools: ['memory_remember'], deadlineMs: 20000 });
tasks.updateTask(writeTask.taskId, { status: 'accepted' });
tasks.updateTask(writeTask.taskId, { status: 'running' });
tasks.acquireLease(writeTask.taskId, { ownerId: 'dead-child' });
console.log('CHILD_READY');
process.kill(process.pid, 'SIGKILL');
`;
  const child = spawnSync(process.execPath, ['-e', script], {
    cwd: ROOT,
    env: { ...process.env, BLUEBIRD_DATA_DIR: TMP },
    encoding: 'utf8',
    timeout: 30000,
  });
  assert.match(String(child.stdout), /CHILD_READY/);
  assert.notEqual(child.status, 0);
  tasks.reloadForTests();
  const result = tasks.recoverInterrupted({ ownerId: null });
  assert.equal(result.recovered, 1);
  assert.equal(result.uncertain, 1);
  const all = tasks.allTasks();
  assert.equal(all.filter(task => task.status === 'completed').length, 0);
  assert.equal(all.filter(task => task.status === 'queued').length, 1);
  assert.equal(all.filter(task => task.status === 'uncertain').length, 1);
});

// ---- G. 投递幂等与崩溃补投 ----

test('投递：重复调用只生成一条父会话消息', () => {
  resetStore();
  const parent = mainSessions.createSession({ title: '投递幂等' });
  const task = makeTask({ parentSessionId: parent.id });
  tasks.updateTask(task.taskId, { status: 'accepted' });
  tasks.updateTask(task.taskId, {
    status: 'completed',
    result: { status: 'completed', summary: '完成' },
  });
  const finished = tasks.getTask(task.taskId);
  resultDelivery.deliverTaskOutcome(finished, {
    status: 'completed',
    result: finished.result,
  });
  resultDelivery.deliverTaskOutcome(finished, {
    status: 'completed',
    result: finished.result,
  });
  const delivered = mainSessions
    .getMessages(parent.id)
    .filter(message => message.id === `bot-result-${task.taskId}`);
  assert.equal(delivered.length, 1);
});

test('投递：终态但未投递的任务在恢复时补投一次', () => {
  resetStore();
  const parent = mainSessions.createSession({ title: '崩溃补投' });
  const task = makeTask({ parentSessionId: parent.id });
  tasks.updateTask(task.taskId, { status: 'accepted' });
  tasks.updateTask(task.taskId, {
    status: 'completed',
    result: { status: 'completed', summary: '完成' },
  });
  assert.equal(tasks.getTask(task.taskId).deliveryStatus, 'pending');
  resultDelivery.recoverPending();
  assert.equal(tasks.getTask(task.taskId).deliveryStatus, 'delivered');
  resultDelivery.recoverPending();
  const delivered = mainSessions
    .getMessages(parent.id)
    .filter(message => message.id === `bot-result-${task.taskId}`);
  assert.equal(delivered.length, 1);
});

// ---- H. 存储故障 ----

test('存储：写入失败向调用方抛出受控错误，不伪装成功', () => {
  resetStore();
  const task = makeTask();
  const original = taskStore.write;
  taskStore.write = () => {
    const error = new Error('disk full');
    error.code = 'EACCES';
    throw error;
  };
  try {
    assert.throws(
      () => tasks.updateTask(task.taskId, { status: 'accepted' }),
      error => error && error.code === 'EACCES'
    );
  } finally {
    taskStore.write = original;
  }
});

test('存储：损坏的任务文件在读取时明确报错', () => {
  resetStore();
  fs.mkdirSync(AGENTS_DIR, { recursive: true });
  fs.writeFileSync(path.join(AGENTS_DIR, 'agent-tasks.json'), '{broken');
  tasks.reloadForTests();
  assert.throws(
    () => tasks.getTask('task_any'),
    error => error && error.code === 'agent_tasks_corrupted'
  );
});
