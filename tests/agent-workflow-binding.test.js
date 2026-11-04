/**
 * Phase 1 / C2：任务与冻结计划版本的绑定回归。
 *
 * 覆盖六条硬要求里与接线相关的部分：
 *  1) 写序：先落计划（fsync）再建任务；构造「计划拒绝」与「任务创建失败」两种半截，
 *     断言磁盘上不可能出现「任务引用了不存在的计划」；
 *  2) 硬上限拒绝：计划被 A 类拒绝时任务不创建、磁盘不留半截计划；
 *  3) 计划 Store 整体损坏 → 所有绑定任务 fail-closed 到 recovery，未绑定任务不受影响；
 *     已终态任务不反转（状态机终态无出边），只计 skippedTerminal；
 *  4) 逐任务解析：plan_missing / plan_version_mismatch / plan_corrupt 各自落点；
 *  5) 两套版本互不污染：planVersion 变化不动 stateVersion，stateVersion 变化不动
 *     planVersion；expectedVersion 只认 stateVersion；
 *  6) 存量兼容：planId=null 的老任务行为完全不变；单边指针被 createTask 拒绝。
 *
 * 隔离纪律：BLUEBIRD_DATA_DIR 在 require server/ 之前指向临时目录。
 */
const fs = require('fs');
const os = require('os');
const path = require('path');
const test = require('node:test');
const assert = require('node:assert');

const DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'bluebird-workflow-binding-'));
process.env.BLUEBIRD_DATA_DIR = DATA_DIR;
process.env.DEEPSEEK_API_KEY = '';
process.env.BLUEBIRD_AGENT_TOOLS = '';
process.env.BLUEBIRD_MONITORING = '0';

const routerModule = require('../server/agents/router');
const routingModule = require('../server/agents/routing-config');
const manifest = require('../server/agents/manifest');
const tasks = require('../server/agents/tasks');
const workflowStore = require('../server/agents/workflow-store');
const runtime = require('../server/agents/runtime');
const { AgentError } = require('../server/agents/errors');

const agents = [
  {
    botId: manifest.MEMORY_BOT_MANIFEST.botId,
    status: 'enabled',
    statusReason: null,
    capabilities: [...manifest.MEMORY_BOT_MANIFEST.capabilities],
    acceptedTaskTypes: [...manifest.MEMORY_BOT_MANIFEST.acceptedTaskTypes],
    taskContracts: JSON.parse(JSON.stringify(manifest.MEMORY_BOT_MANIFEST.taskContracts)),
    toolAllowlist: [...manifest.MEMORY_BOT_MANIFEST.toolAllowlist],
    concurrencyLimit: manifest.MEMORY_BOT_MANIFEST.concurrencyLimit,
    routingPriority: manifest.MEMORY_BOT_MANIFEST.routingPriority,
    defaultTimeoutMs: manifest.MEMORY_BOT_MANIFEST.defaultTimeoutMs,
  },
];

function routingConfig() {
  return JSON.parse(JSON.stringify(routingModule.DEFAULT_ROUTING));
}

/** 只替换 dispatch 的外部副作用；任务与计划仍用真实存储。 */
function makeRouter(overrides = {}) {
  return routerModule.createRouter({
    getAgents: () => agents,
    getConfig: () => ({ config: routingConfig(), digest: 'digest-binding-test' }),
    sessions: {
      createSession: () => ({ id: `bs_${Math.random().toString(36).slice(2)}` }),
      getSession: () => ({ id: 'bs_fixed' }),
      attachOwner: () => {},
    },
    appendEvent: () => {},
    startTask: () => {},
    load: () => ({ queuedTotal: 0, runningByAgent: {} }),
    now: () => 1800000000000,
    ...overrides,
  });
}

function validInput(overrides = {}) {
  return {
    agentId: 'memory',
    taskType: 'memory.search',
    goal: '查一下我的咖啡偏好',
    ...overrides,
  };
}

function resetAll() {
  for (const file of [
    workflowStore.WORKFLOW_FILE,
    workflowStore.AUDIT_FILE,
    tasks.TASKS_FILE,
    tasks.EVENTS_FILE,
    tasks.OUTBOX_FILE,
  ]) {
    try {
      fs.rmSync(file, { force: true });
    } catch (_) {
      // ignore
    }
  }
  tasks.reloadForTests();
}

function corruptPlanStore() {
  fs.mkdirSync(path.dirname(workflowStore.WORKFLOW_FILE), { recursive: true });
  fs.writeFileSync(workflowStore.WORKFLOW_FILE, '{not json', 'utf8');
}

function rawTask(taskId) {
  return tasks.getRawTask(taskId);
}

test.beforeEach(resetAll);

test.after(() => {
  try {
    fs.rmSync(DATA_DIR, { recursive: true, force: true });
  } catch (_) {
    // ignore
  }
});

test('1. 写序：任务落盘的那一刻，计划已经可读', () => {
  const created = [];
  let planReadAtCreate = null;

  const guardedTaskStore = {
    findByIdempotencyKey: (...args) => tasks.findByIdempotencyKey(...args),
    createTask: input => {
      // 如果实现是「先建任务、后补计划」，这里会读不到计划并直接让用例失败。
      planReadAtCreate = workflowStore.getVersion(input.planId, input.planVersion);
      created.push(input);
      return tasks.createTask(input);
    },
    allTasks: () => tasks.allTasks(),
    getTask: taskId => tasks.getTask(taskId),
  };

  const router = makeRouter({ tasks: guardedTaskStore });
  const result = router.dispatch(validInput({ idempotencyKey: 'order-1' }));

  assert.ok(planReadAtCreate, 'createTask 之前计划必须已经落盘并可读');
  assert.strictEqual(planReadAtCreate.planVersion, 1);
  assert.strictEqual(created[0].planId, planReadAtCreate.planId);
  assert.strictEqual(created[0].planVersion, 1);

  const stored = rawTask(result.task.taskId);
  assert.strictEqual(stored.planId, planReadAtCreate.planId);
  assert.strictEqual(stored.planVersion, 1);
  assert.strictEqual(
    workflowStore.getVersion(stored.planId, stored.planVersion).digest,
    planReadAtCreate.digest
  );
  // 反向引用也已写入（裁剪保护）。
  assert.strictEqual(workflowStore.getRef(result.task.taskId).planVersion, 1);
});

test('2. 计划被 A 类上限拒绝：任务不创建，磁盘不留半截计划', () => {
  const failingStore = {
    ...workflowStore,
    appendVersion: args =>
      workflowStore.appendVersion({
        ...args,
        plan: { ...args.plan, budgets: { note: 'a'.repeat(9000) } },
      }),
  };
  const router = makeRouter({ workflowStore: failingStore });

  assert.throws(
    () => router.dispatch(validInput({ idempotencyKey: 'too-large' })),
    error => error.code === 'plan_too_large'
  );

  assert.strictEqual(tasks.allTasks().length, 0, '拒绝后不得留下任务');
  assert.strictEqual(fs.existsSync(workflowStore.WORKFLOW_FILE), false);
  assert.strictEqual(fs.existsSync(tasks.TASKS_FILE), false);
  assert.strictEqual(workflowStore.listRefs().length, 0);
});

test('3. 任务创建失败：不会留下指向不存在计划的任务（S1 孤儿计划）', () => {
  const failingTaskStore = {
    findByIdempotencyKey: () => null,
    createTask: () => {
      throw new AgentError('agent_task_limit', '任务数量已达上限', 409);
    },
    allTasks: () => tasks.allTasks(),
    getTask: () => null,
  };
  const router = makeRouter({ tasks: failingTaskStore });

  assert.throws(
    () => router.dispatch(validInput({ idempotencyKey: 'task-limit' })),
    error => error.code === 'agent_task_limit'
  );

  // 计划已落盘但没有任何任务引用它：这是 S1 孤儿，24h 后由 Store 清理；
  // 关键点在于反方向（任务引用不存在的计划）不可能出现。
  assert.strictEqual(tasks.allTasks().length, 0);
  assert.strictEqual(workflowStore.listRefs().length, 0);
});

test('4. 计划 Store 整体损坏：绑定任务全部 recovery，未绑定与终态任务不动', () => {
  const plan = workflowStore.createPlan({ plan: samplePlan() });
  const bound = tasks.createTask({
    botId: 'memory',
    taskType: 'memory.search',
    goal: '绑定计划',
    allowedTools: ['memory_search'],
    deadlineMs: 30000,
    planId: plan.planId,
    planVersion: 1,
  });
  const dangling = tasks.createTask({
    botId: 'memory',
    taskType: 'memory.search',
    goal: '引用不存在的计划',
    allowedTools: ['memory_search'],
    deadlineMs: 30000,
    planId: 'plan_ghost',
    planVersion: 1,
  });
  const legacy = tasks.createTask({
    botId: 'memory',
    taskType: 'memory.search',
    goal: '存量任务',
    allowedTools: ['memory_search'],
    deadlineMs: 30000,
  });
  const finished = tasks.createTask({
    botId: 'memory',
    taskType: 'memory.search',
    goal: '已取消任务',
    allowedTools: ['memory_search'],
    deadlineMs: 30000,
    planId: plan.planId,
    planVersion: 1,
  });
  tasks.transitionTask(finished.taskId, { to: 'cancelled' });

  corruptPlanStore();
  const summary = runtime.convergeWorkflowPlans({ now: 1800000000000 });

  assert.strictEqual(summary.storeCorrupted, true);
  assert.strictEqual(summary.skippedUnbound, 1);
  assert.strictEqual(summary.skippedTerminal, 1);

  const boundAfter = rawTask(bound.taskId);
  assert.strictEqual(boundAfter.status, 'recovery');
  assert.strictEqual(boundAfter.errorCode, 'plan_store_corrupted');
  assert.strictEqual(boundAfter.requiresReview, true);

  const danglingAfter = rawTask(dangling.taskId);
  assert.strictEqual(danglingAfter.status, 'recovery');
  assert.strictEqual(danglingAfter.errorCode, 'plan_store_corrupted');

  // 未绑定计划的老任务完全不受影响。
  assert.strictEqual(rawTask(legacy.taskId).status, 'queued');
  assert.strictEqual(rawTask(legacy.taskId).errorCode, null);
  // 已终态任务不反转（状态机终态没有出边）。
  assert.strictEqual(rawTask(finished.taskId).status, 'cancelled');
});

test('5. 逐任务解析：缺失/版本不符/内容损坏各自落 recovery，健康计划照常排队', () => {
  const healthy = workflowStore.createPlan({ plan: samplePlan() });
  const healthyTask = tasks.createTask({
    botId: 'memory',
    taskType: 'memory.search',
    goal: '健康计划',
    allowedTools: ['memory_search'],
    deadlineMs: 30000,
    planId: healthy.planId,
    planVersion: 1,
  });

  const missingTask = tasks.createTask({
    botId: 'memory',
    taskType: 'memory.search',
    goal: '计划缺失',
    allowedTools: ['memory_search'],
    deadlineMs: 30000,
    planId: 'plan_does_not_exist',
    planVersion: 1,
  });

  const mismatchTask = tasks.createTask({
    botId: 'memory',
    taskType: 'memory.search',
    goal: '版本不符',
    allowedTools: ['memory_search'],
    deadlineMs: 30000,
    planId: healthy.planId,
    planVersion: 99,
  });

  const corruptPlan = workflowStore.createPlan({ plan: samplePlan() });
  const store = workflowStore.read();
  store.plans[corruptPlan.planId].versions['1'].plan.reasons = ['tampered'];
  workflowStore.write(store);
  const corruptTask = tasks.createTask({
    botId: 'memory',
    taskType: 'memory.search',
    goal: '内容损坏',
    allowedTools: ['memory_search'],
    deadlineMs: 30000,
    planId: corruptPlan.planId,
    planVersion: 1,
  });

  const summary = runtime.convergeWorkflowPlans({ now: 1800000000000 });
  assert.strictEqual(summary.checked, 4);
  assert.strictEqual(summary.resolved, 1);
  assert.strictEqual(summary.failed, 3);
  assert.deepStrictEqual(summary.errorCodes, {
    plan_corrupt: 1,
    plan_missing: 1,
    plan_version_mismatch: 1,
  });

  assert.strictEqual(rawTask(healthyTask.taskId).status, 'queued');
  assert.strictEqual(workflowStore.getRef(healthyTask.taskId).planId, healthy.planId);

  assert.strictEqual(rawTask(missingTask.taskId).status, 'recovery');
  assert.strictEqual(rawTask(missingTask.taskId).errorCode, 'plan_missing');
  assert.strictEqual(rawTask(mismatchTask.taskId).status, 'recovery');
  assert.strictEqual(rawTask(mismatchTask.taskId).errorCode, 'plan_version_mismatch');
  assert.strictEqual(rawTask(corruptTask.taskId).status, 'recovery');
  assert.strictEqual(rawTask(corruptTask.taskId).errorCode, 'plan_corrupt');
});

test('6. 两套版本互不污染：planVersion 不动 stateVersion，反之亦然', () => {
  const created = workflowStore.createPlan({ plan: samplePlan() });
  const task = tasks.createTask({
    botId: 'memory',
    taskType: 'memory.search',
    goal: '版本隔离',
    allowedTools: ['memory_search'],
    deadlineMs: 30000,
    planId: created.planId,
    planVersion: 1,
  });
  const createdStateVersion = rawTask(task.taskId).stateVersion;

  // 计划追加新版本（重规划）：任务的 stateVersion 与指针都不变。
  const next = workflowStore.appendVersion({ planId: created.planId, plan: samplePlan({ reasons: ['v2'] }) });
  assert.strictEqual(next.planVersion, 2);
  assert.strictEqual(rawTask(task.taskId).stateVersion, createdStateVersion);
  assert.strictEqual(rawTask(task.taskId).planVersion, 1);

  // 启动解析只补 pin，不改任务记录。
  runtime.convergeWorkflowPlans({ now: 1800000000000 });
  assert.strictEqual(rawTask(task.taskId).stateVersion, createdStateVersion);

  // 状态迁移只动 stateVersion，不动 planVersion / 计划头版本。
  tasks.transitionTask(task.taskId, {
    to: 'accepted',
    expectedVersion: createdStateVersion,
  });
  const afterAccept = rawTask(task.taskId);
  assert.strictEqual(afterAccept.stateVersion, createdStateVersion + 1);
  assert.strictEqual(afterAccept.planVersion, 1);
  assert.strictEqual(workflowStore.read().plans[created.planId].headVersion, 2);

  // expectedVersion 只认 stateVersion：拿 planVersion 当并发版本必须冲突。
  assert.throws(
    () =>
      tasks.transitionTask(task.taskId, {
        to: 'running',
        expectedVersion: 2,
      }),
    error => error.code === 'conflict'
  );
  // 用 stateVersion 才能成功。
  tasks.transitionTask(task.taskId, { to: 'running', expectedVersion: afterAccept.stateVersion });
  assert.strictEqual(rawTask(task.taskId).status, 'running');
});

test('7. 存量兼容：planId=null 的老任务不被解析、不被改写', () => {
  const legacy = tasks.createTask({
    botId: 'memory',
    taskType: 'memory.search',
    goal: '老任务',
    allowedTools: ['memory_search'],
    deadlineMs: 30000,
    idempotencyKey: 'legacy-1',
  });
  const before = rawTask(legacy.taskId);

  const summary = runtime.convergeWorkflowPlans({ now: 1800000000000 });
  assert.strictEqual(summary.checked, 0);
  assert.strictEqual(summary.skippedUnbound, 1);

  const after = rawTask(legacy.taskId);
  assert.strictEqual(after.status, 'queued');
  assert.strictEqual(after.planId, null);
  assert.strictEqual(after.planVersion, null);
  assert.strictEqual(after.stateVersion, before.stateVersion);
  assert.strictEqual(after.errorCode, null);
  assert.strictEqual(workflowStore.listRefs().length, 0);
});

test('8. 单边指针被 createTask 拒绝；幂等重放不追加第二份计划', () => {
  assert.throws(
    () =>
      tasks.createTask({
        botId: 'memory',
        taskType: 'memory.search',
        goal: '只有 planId',
        allowedTools: ['memory_search'],
        deadlineMs: 30000,
        planId: 'plan_x',
      }),
    error => error.code === 'invalid_task'
  );

  const router = makeRouter();
  const first = router.dispatch(validInput({ idempotencyKey: 'idem-plan' }));
  const second = router.dispatch(validInput({ idempotencyKey: 'idem-plan' }));
  assert.strictEqual(second.idempotent, true);
  assert.strictEqual(second.task.taskId, first.task.taskId);

  const store = workflowStore.read();
  assert.strictEqual(Object.keys(store.plans).length, 1, '幂等重放不得追加计划');
});

function samplePlan(overrides = {}) {
  const orchestrator = require('../server/context/orchestrator');
  const base = orchestrator.planContext({ task: '查一下我的咖啡偏好' });
  return {
    intent: base.intent,
    enabled: base.enabled,
    layers: base.layers,
    budgets: base.budgets,
    noAnswerThreshold: base.noAnswerThreshold,
    reasons: base.reasons,
    steps: [],
    allowedTools: ['memory_search'],
    budget: { maxRounds: 2, maxToolCalls: 3, maxReadOnlyRetries: 1, generatePlan: false },
    goalDigest: 'sha256:sample',
    ...overrides,
  };
}
