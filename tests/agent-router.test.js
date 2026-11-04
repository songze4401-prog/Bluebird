/* global require, process, __dirname */
/**
 * 一期 Router / Task Contract 回归。
 *
 * 覆盖：契约校验、Fast/Slow 分类、候选选择与拒绝码、降级、确定性、
 * 事件隐私、Task Contract 落库与旧任务迁移、幂等、优先级队列、
 * dispatch 副作用顺序，以及 delegate_to_bot 兼容层。
 */
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'bluebird-agent-router-'));
process.env.BLUEBIRD_DATA_DIR = DATA_DIR;
process.env.DEEPSEEK_API_KEY = '';
process.env.BLUEBIRD_AGENT_TOOLS = '';
process.env.BLUEBIRD_MONITORING = '0';

const routerModule = require('../server/agents/router');
const routingModule = require('../server/agents/routing-config');
const manifest = require('../server/agents/manifest');
const tasks = require('../server/agents/tasks');
const botSessions = require('../server/agents/sessions');
const mainSessions = require('../server/sessions');
const dispatchTool = require('../server/tool-dispatch-bot');
const { AgentError } = require('../server/agents/errors');
const { getInstanceUserId } = require('../server/user-scope');

function routing(overrides = {}) {
  const base = JSON.parse(JSON.stringify(routingModule.DEFAULT_ROUTING));
  const next = { ...base, ...overrides };
  if (overrides.fast) next.fast = { ...base.fast, ...overrides.fast };
  if (overrides.profiles) {
    next.profiles = {
      fast: { ...base.profiles.fast, ...(overrides.profiles.fast || {}) },
      slow: { ...base.profiles.slow, ...(overrides.profiles.slow || {}) },
    };
  }
  if (overrides.limits) next.limits = { ...base.limits, ...overrides.limits };
  return next;
}

function testAgent(overrides = {}) {
  const m = manifest.MEMORY_BOT_MANIFEST;
  return {
    botId: m.botId,
    status: 'enabled',
    statusReason: null,
    capabilities: [...m.capabilities],
    acceptedTaskTypes: [...m.acceptedTaskTypes],
    taskContracts: JSON.parse(JSON.stringify(m.taskContracts)),
    toolAllowlist: [...m.toolAllowlist],
    concurrencyLimit: m.concurrencyLimit,
    routingPriority: m.routingPriority,
    defaultTimeoutMs: m.defaultTimeoutMs,
    ...overrides,
  };
}

function decide(input, options = {}) {
  return routerModule.decide(input, {
    agents: options.agents || [testAgent()],
    routingConfig: options.routingConfig || routing(),
    load: options.load || { queuedTotal: 0, runningByAgent: {} },
    policyDigest: options.policyDigest || 'policy-digest-test',
    now: options.now || (() => 1700000000000),
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

function resetAgentStore() {
  fs.rmSync(path.join(DATA_DIR, 'agents'), { recursive: true, force: true });
  tasks.reloadForTests();
  botSessions.reloadForTests();
  routingModule.reloadForTests();
}

function createTask(overrides = {}) {
  return tasks.createTask({
    agentId: 'memory',
    workerSessionId: 'bs_router_test',
    taskType: 'memory.search',
    goal: '测试目标',
    ...overrides,
  });
}

// ---- A. Task Contract 输入校验 ----

test('契约校验：合法输入被选中并带上默认值', () => {
  const decision = decide(validInput());
  assert.equal(decision.ok, true);
  assert.equal(decision.selectedAgentId, 'memory');
  assert.equal(decision.capability, 'memory.search');
  assert.equal(decision.contractVersion, 1);
  assert.deepEqual(decision.budget, {
    maxRounds: 3,
    maxToolCalls: 6,
    maxReadOnlyRetries: 1,
    generatePlan: false,
  });
  assert.equal(decision.degraded, false);
});

test('契约校验：未知任务类型明确拒绝', () => {
  const decision = decide(validInput({ taskType: 'memory.unknown' }));
  assert.equal(decision.ok, false);
  assert.equal(decision.code, 'capability_not_found');
  assert.equal(decision.status, 400);
});

test('契约校验：未知 Agent 返回 agent_not_found', () => {
  const decision = decide(validInput({ agentId: 'ghost' }));
  assert.equal(decision.ok, false);
  assert.equal(decision.code, 'agent_not_found');
  assert.equal(decision.status, 404);
});

test('契约校验：缺少 goal 被拒绝', () => {
  const decision = decide(validInput({ goal: '   ' }));
  assert.equal(decision.code, 'invalid_task');
  assert.equal(decision.field, 'goal');
});

test('契约校验：goal 超过上限被拒绝', () => {
  const decision = decide(validInput({ goal: 'x'.repeat(2001) }));
  assert.equal(decision.code, 'invalid_task');
  assert.equal(decision.field, 'goal');
});

test('契约校验：context 超过上限被拒绝', () => {
  const decision = decide(validInput({ context: 'x'.repeat(8001) }));
  assert.equal(decision.code, 'invalid_task');
  assert.equal(decision.field, 'context');
});

test('契约校验：contextRef 超过上限被拒绝', () => {
  const decision = decide(validInput({ contextRef: 'x'.repeat(201) }));
  assert.equal(decision.code, 'invalid_task');
  assert.equal(decision.field, 'contextRef');
});

test('契约校验：allowedTools 类型错误被拒绝', () => {
  const decision = decide(validInput({ allowedTools: 'memory_search' }));
  assert.equal(decision.code, 'invalid_task');
  assert.equal(decision.field, 'allowedTools');
});

test('契约校验：越权工具返回 tool_not_allowed', () => {
  const decision = decide(validInput({ allowedTools: ['memory_search', 'shell_exec'] }));
  assert.equal(decision.code, 'tool_not_allowed');
  assert.equal(decision.status, 403);
});

test('契约校验：allowedTools 重复项被去重后通过', () => {
  const decision = decide(validInput({ allowedTools: ['memory_search', 'memory_search'] }));
  assert.equal(decision.ok, true);
});

test('契约校验：deadlineMs 越界被拒绝', () => {
  const decision = decide(validInput({ deadlineMs: 1000 }));
  assert.equal(decision.code, 'invalid_task');
  assert.equal(decision.field, 'deadlineMs');
});

test('契约校验：非法 priority 被拒绝', () => {
  const decision = decide(validInput({ priority: 'urgent' }));
  assert.equal(decision.code, 'invalid_task');
  assert.equal(decision.field, 'priority');
});

test('契约校验：idempotencyKey 超长被拒绝', () => {
  const decision = decide(validInput({ idempotencyKey: 'k'.repeat(121) }));
  assert.equal(decision.code, 'invalid_task');
  assert.equal(decision.field, 'idempotencyKey');
});

// ---- B. 可用性、预算与降级 ----

test('可用性：停用的 Agent 明确拒绝', () => {
  const decision = decide(validInput(), {
    agents: [testAgent({ status: 'disabled', statusReason: 'disabled' })],
  });
  assert.equal(decision.code, 'agent_not_available');
  assert.equal(decision.status, 409);
  assert.match(decision.message, /disabled/);
});

test('可用性：未就绪的 Agent 明确拒绝并带原因', () => {
  const decision = decide(validInput(), {
    agents: [testAgent({ status: 'degraded', statusReason: 'model_not_configured' })],
  });
  assert.equal(decision.code, 'agent_not_available');
  assert.match(decision.message, /model_not_configured/);
});

test('可用性：队列满时明确拒绝，不静默入队', () => {
  const decision = decide(validInput(), {
    routingConfig: routing({ limits: { maxQueueDepth: 2 } }),
    load: { queuedTotal: 2, runningByAgent: {} },
  });
  assert.equal(decision.code, 'agent_queue_full');
  assert.equal(decision.status, 409);
});

test('可用性：并发饱和时降级入队而不是拒绝', () => {
  const decision = decide(validInput(), {
    load: { queuedTotal: 1, runningByAgent: { memory: 2 } },
  });
  assert.equal(decision.ok, true);
  assert.equal(decision.degraded, true);
  assert.equal(decision.degradedReason, 'agent_concurrency_full');
});

test('可用性：仍有并发余量时不降级', () => {
  const decision = decide(validInput(), {
    load: { queuedTotal: 1, runningByAgent: { memory: 1 } },
  });
  assert.equal(decision.ok, true);
  assert.equal(decision.degraded, false);
});

test('选择：多个候选取 routingPriority 更小的 Agent', () => {
  const decision = decide(validInput({ agentId: null }), {
    agents: [
      testAgent({ botId: 'memory', routingPriority: 100 }),
      testAgent({ botId: 'memory2', routingPriority: 50 }),
    ],
  });
  assert.equal(decision.selectedAgentId, 'memory2');
});

test('选择：同优先级按 botId 字典序，结果确定', () => {
  const decision = decide(validInput({ agentId: null }), {
    agents: [
      testAgent({ botId: 'memory2' }),
      testAgent({ botId: 'memory' }),
    ],
  });
  assert.equal(decision.selectedAgentId, 'memory');
});

test('选择：显式 agentId 只考虑该 Agent', () => {
  const decision = decide(validInput({ agentId: 'memory2' }), {
    agents: [
      testAgent({ botId: 'memory' }),
      testAgent({ botId: 'memory2', routingPriority: 1 }),
    ],
  });
  assert.equal(decision.selectedAgentId, 'memory2');
});

// ---- C. Fast / Slow 分流 ----

test('分流：短目标走 Fast 路径', () => {
  const decision = decide(validInput());
  assert.equal(decision.path, 'fast');
  assert.equal(decision.pathReason, 'within_fast_limits');
});

test('分流：目标超阈值走 Slow 路径并使用更大预算', () => {
  const decision = decide(validInput({ goal: 'x'.repeat(801) }));
  assert.equal(decision.path, 'slow');
  assert.equal(decision.pathReason, 'goal_exceeds_fast_limit');
  assert.equal(decision.budget.maxRounds, 4);
  assert.equal(decision.budget.generatePlan, true);
});

test('分流：上下文超阈值走 Slow 路径', () => {
  const decision = decide(validInput({ context: 'x'.repeat(2001) }));
  assert.equal(decision.path, 'slow');
  assert.equal(decision.pathReason, 'context_exceeds_fast_limit');
});

test('分流：慢任务类型强制 Slow 路径', () => {
  const decision = decide(validInput(), {
    routingConfig: routing({ slowTaskTypes: ['memory.search'] }),
  });
  assert.equal(decision.path, 'slow');
  assert.equal(decision.pathReason, 'task_type_requires_planning');
});

test('分流：阈值可配置，同一输入随配置改变路径', () => {
  const goal = 'x'.repeat(11);
  const fast = decide(validInput({ goal }));
  const slow = decide(validInput({ goal }), {
    routingConfig: routing({ fast: { maxGoalChars: 10 } }),
  });
  assert.equal(fast.path, 'fast');
  assert.equal(slow.path, 'slow');
});

// ---- D. 确定性与隐私 ----

test('确定性：相同输入与策略得到相同决策（除 routeId）', () => {
  const a = decide(validInput());
  const b = decide(validInput());
  assert.deepEqual(
    { ...a, routeId: 'fixed' },
    { ...b, routeId: 'fixed' }
  );
  assert.notEqual(a.routeId, b.routeId);
  assert.equal(a.policyDigest, b.policyDigest);
});

test('隐私：决策只含短码，不包含 goal 或 context 正文', () => {
  const decision = decide(
    validInput({ goal: '机密目标-咖啡', context: '机密上下文-偏好' })
  );
  const serialized = JSON.stringify(decision);
  assert.ok(!serialized.includes('机密目标'));
  assert.ok(!serialized.includes('机密上下文'));
  assert.ok(serialized.includes('routeId'));
});

test('隐私：拒绝决策列出候选与拒绝短码', () => {
  const decision = decide(validInput({ taskType: 'memory.unknown' }));
  assert.equal(decision.rejected.length, 1);
  assert.equal(decision.rejected[0].agentId, 'memory');
  assert.equal(decision.rejected[0].code, 'capability_not_found');
});

// ---- E. Task Contract 落库、迁移、幂等与队列 ----

test('任务契约：createTask 同时写入规范字段与兼容别名', () => {
  resetAgentStore();
  const task = createTask({ workerSessionId: 'bs_contract_1' });
  assert.equal(task.contractVersion, 1);
  assert.equal(task.agentId, 'memory');
  assert.equal(task.workerSessionId, 'bs_contract_1');
  assert.equal(task.botId, task.agentId);
  assert.equal(task.sessionId, task.workerSessionId);
  assert.equal(task.priority, 'normal');
  assert.equal(task.contextRef, null);
  assert.equal(task.idempotencyKey, null);
  assert.equal(task.route, null);
  assert.equal(task.budget, null);
});

test('任务契约：route 与 budget 快照随任务落库', () => {
  resetAgentStore();
  const task = createTask({
    priority: 'high',
    contextRef: 'session:s1#message:m1',
    route: {
      routeId: 'route_test_1',
      path: 'slow',
      capability: 'memory.search',
      policyDigest: 'abcd1234',
      decidedAt: '2026-11-01T00:00:00.000Z',
    },
    budget: { maxRounds: 4, maxToolCalls: 6, maxReadOnlyRetries: 1, generatePlan: true },
  });
  assert.equal(task.priority, 'high');
  assert.equal(task.contextRef, 'session:s1#message:m1');
  assert.equal(task.route.routeId, 'route_test_1');
  assert.equal(task.route.path, 'slow');
  assert.equal(task.budget.maxRounds, 4);
});

test('任务契约：非法 budget 被拒绝', () => {
  resetAgentStore();
  assert.throws(
    () => createTask({ budget: { maxRounds: 9, maxToolCalls: 6, maxReadOnlyRetries: 0, generatePlan: false } }),
    error => error instanceof AgentError && error.code === 'invalid_task'
  );
});

test('任务迁移：旧任务读取后补齐规范字段', () => {
  resetAgentStore();
  const dir = path.join(DATA_DIR, 'agents');
  fs.mkdirSync(dir, { recursive: true });
  const legacy = {
    version: 1,
    tasks: {
      task_legacy: {
        taskId: 'task_legacy',
        botId: 'memory',
        taskType: 'memory.search',
        goal: '旧任务',
        context: '',
        sessionId: 'bs_legacy',
        parentSessionId: null,
        parentMessageId: null,
        parentUserText: '',
        deliveredToParentAt: null,
        deliveryMessageId: null,
        deliveryStatus: 'not_applicable',
        deliveryErrorCode: null,
        allowedTools: ['memory_search'],
        deadlineMs: 60000,
        status: 'queued',
        cancelRequested: false,
        attempts: 0,
        maxAttempts: 1,
        recoveredAt: null,
        createdAt: '2026-10-01T00:00:00.000Z',
        updatedAt: '2026-10-01T00:00:00.000Z',
        startedAt: null,
        completedAt: null,
        errorCode: null,
        result: null,
      },
    },
  };
  fs.writeFileSync(path.join(dir, 'agent-tasks.json'), JSON.stringify(legacy, null, 2));
  tasks.reloadForTests();
  const raw = tasks.getRawTask('task_legacy');
  assert.equal(raw.agentId, 'memory');
  assert.equal(raw.workerSessionId, 'bs_legacy');
  assert.equal(raw.contractVersion, 1);
  assert.equal(raw.priority, 'normal');
  assert.equal(raw.contextRef, null);
});

test('幂等：相同 idempotencyKey 返回既有任务，不重复创建', () => {
  resetAgentStore();
  const first = createTask({ idempotencyKey: 'idem-1' });
  const second = createTask({ idempotencyKey: 'idem-1' });
  assert.equal(second.taskId, first.taskId);
  assert.equal(second.idempotent, true);
  assert.equal(tasks.allTasks().length, 1);
});

test('队列：按 high → normal → low 出队，同级按创建时间', () => {
  resetAgentStore();
  const normal = createTask({ priority: 'normal', goal: '普通' });
  const low = createTask({ priority: 'low', goal: '低' });
  const high = createTask({ priority: 'high', goal: '高' });
  assert.equal(tasks.nextQueuedTask().taskId, high.taskId);
  tasks.transitionTask(high.taskId, { to: 'accepted' });
  assert.equal(tasks.nextQueuedTask().taskId, normal.taskId);
  tasks.transitionTask(normal.taskId, { to: 'accepted' });
  assert.equal(tasks.nextQueuedTask().taskId, low.taskId);
});

// ---- F. dispatch 副作用顺序与事件 ----

function fakeDispatchEnv(overrides = {}) {
  const events = [];
  const created = [];
  const started = [];
  const sessionsCreated = [];
  const env = {
    events,
    created,
    started,
    sessionsCreated,
    router: routerModule.createRouter({
      getAgents: () => overrides.agents || [testAgent()],
      getConfig: () => ({ config: overrides.routingConfig || routing(), digest: 'digest-1' }),
      tasks: {
        findByIdempotencyKey: overrides.findByIdempotencyKey || (() => null),
        createTask: input => {
          created.push(input);
          return {
            taskId: `task_fake_${created.length}`,
            botId: input.agentId,
            sessionId: input.workerSessionId,
            taskType: input.taskType,
            status: 'queued',
            route: input.route,
          };
        },
        allTasks: () => [],
        getTask: () => null,
        appendEvent: () => {},
      },
      sessions: {
        createSession: (agentId, options) => {
          sessionsCreated.push({ agentId, title: options.title });
          return { id: 'bs_fake_1' };
        },
      },
      appendEvent: args => events.push(args),
      startTask: taskId => started.push(taskId),
      load: () => overrides.load || { queuedTotal: 0, runningByAgent: {} },
      now: () => 1700000000000,
    }),
  };
  return env;
}

test('dispatch：创建 Worker 会话 → 任务 → 事件 → 入队', () => {
  const env = fakeDispatchEnv();
  const result = env.router.dispatch(
    {
      agentId: 'memory',
      taskType: 'memory.search',
      goal: '查咖啡偏好',
      parentSessionId: 's_main',
      priority: 'high',
    },
    { source: 'api' }
  );
  assert.equal(env.sessionsCreated.length, 1);
  assert.equal(env.sessionsCreated[0].title, '查咖啡偏好');
  assert.equal(env.created.length, 1);
  assert.equal(env.created[0].workerSessionId, 'bs_fake_1');
  assert.equal(env.created[0].parentSessionId, 's_main');
  assert.equal(
    env.created[0].parentUserId,
    getInstanceUserId(),
    '调用方没给身份时，记忆归属落回服务端实例用户'
  );
  assert.equal(env.started.length, 1);
  assert.equal(result.idempotent, false);
  const decided = env.events.filter(event => event.eventType === 'route.decided');
  assert.equal(decided.length, 1);
  assert.equal(decided[0].payload.decision, 'selected');
  assert.equal(decided[0].payload.path, 'fast');
  assert.equal(decided[0].payload.pathReason, 'within_fast_limits');
  assert.equal(decided[0].payload.candidates, 'memory');
  assert.match(decided[0].payload.routeId, /^route_/);
});

test('dispatch：调用方传入的 parentUserId 原样落库（Worker 按它读用户级记忆）', () => {
  const env = fakeDispatchEnv();
  env.router.dispatch(
    {
      agentId: 'memory',
      taskType: 'memory.search',
      goal: '查咖啡偏好',
      parentSessionId: 's_main',
      parentUserId: 'trusted-user-42',
    },
    { source: 'delegate_to_bot' }
  );
  assert.equal(env.created.length, 1);
  assert.equal(env.created[0].parentUserId, 'trusted-user-42');
});

test('dispatch：被拒绝时不建会话、不建任务，并写 route.rejected', () => {
  const env = fakeDispatchEnv({
    agents: [testAgent({ status: 'degraded', statusReason: 'model_not_configured' })],
  });
  assert.throws(
    () => env.router.dispatch({ agentId: 'memory', taskType: 'memory.search', goal: '查咖啡' }),
    error => error instanceof AgentError && error.code === 'agent_not_available'
  );
  assert.equal(env.sessionsCreated.length, 0);
  assert.equal(env.created.length, 0);
  assert.equal(env.started.length, 0);
  const rejected = env.events.filter(event => event.eventType === 'route.rejected');
  assert.equal(rejected.length, 1);
  assert.equal(rejected[0].payload.decision, 'rejected');
});

test('dispatch：幂等命中时不新建会话/任务，也不重复入队', () => {
  const existing = { taskId: 'task_existing', botId: 'memory', sessionId: 'bs_old', status: 'completed' };
  const env = fakeDispatchEnv({ findByIdempotencyKey: () => existing });
  const result = env.router.dispatch({
    agentId: 'memory',
    taskType: 'memory.search',
    goal: '查咖啡',
    idempotencyKey: 'same-key',
  });
  assert.equal(result.idempotent, true);
  assert.equal(result.task.taskId, 'task_existing');
  assert.equal(env.sessionsCreated.length, 0);
  assert.equal(env.created.length, 0);
  assert.equal(env.started.length, 0);
  const decided = env.events.filter(event => event.eventType === 'route.decided');
  assert.equal(decided.length, 1);
  assert.equal(decided[0].payload.idempotent, true);
});

test('dispatch：真实任务存储落库 route/budget，并可按幂等键复用', () => {
  resetAgentStore();
  const started = [];
  const router = routerModule.createRouter({
    getAgents: () => [testAgent()],
    getConfig: () => ({ config: routing(), digest: 'digest-real' }),
    sessions: { createSession: () => ({ id: 'bs_real_1' }) },
    appendEvent: args => tasks.appendEvent(args),
    startTask: taskId => started.push(taskId),
    load: () => ({ queuedTotal: 0, runningByAgent: {} }),
    now: () => Date.now(),
  });
  const first = router.dispatch({
    agentId: 'memory',
    taskType: 'memory.search',
    goal: '查咖啡偏好',
    idempotencyKey: 'real-idem',
  });
  assert.equal(started.length, 1);
  const stored = tasks.getTask(first.task.taskId);
  assert.match(stored.route.routeId, /^route_/);
  assert.equal(stored.route.policyDigest, 'digest-real');
  assert.equal(stored.budget.maxRounds, 3);
  const second = router.dispatch({
    agentId: 'memory',
    taskType: 'memory.search',
    goal: '查咖啡偏好',
    idempotencyKey: 'real-idem',
  });
  assert.equal(second.task.taskId, first.task.taskId);
  assert.equal(started.length, 1);
  assert.equal(tasks.allTasks().length, 1);
  const routeEvents = tasks
    .listEvents('memory')
    .filter(event => event.eventType === 'route.decided');
  assert.ok(
    routeEvents.some(
      event =>
        event.payload.routeId === stored.route.routeId &&
        event.payload.idempotent === false &&
        event.taskId === first.task.taskId
    )
  );
  assert.equal(
    routeEvents.filter(event => event.payload.idempotent === true).length,
    1
  );
});

test('dispatch：路由事件不记录任务正文', () => {
  resetAgentStore();
  const router = routerModule.createRouter({
    getAgents: () => [testAgent()],
    getConfig: () => ({ config: routing(), digest: 'digest-privacy' }),
    sessions: { createSession: () => ({ id: 'bs_privacy_1' }) },
    appendEvent: args => tasks.appendEvent(args),
    startTask: () => {},
    load: () => ({ queuedTotal: 0, runningByAgent: {} }),
    now: () => Date.now(),
  });
  router.dispatch({
    agentId: 'memory',
    taskType: 'memory.search',
    goal: '机密目标-咖啡豆',
    context: '机密上下文-浅烘',
  });
  const events = tasks.listEvents('memory');
  const serialized = JSON.stringify(events);
  assert.ok(!serialized.includes('机密目标'));
  assert.ok(!serialized.includes('机密上下文'));
});

test('负载统计：排队与运行中的任务计入队列深度与并发', () => {
  resetAgentStore();
  const a = createTask({ goal: '任务A' });
  const b = createTask({ goal: '任务B' });
  const c = createTask({ goal: '任务C' });
  tasks.transitionTask(a.taskId, { to: 'accepted' });
  tasks.transitionTask(b.taskId, { to: 'accepted' });
  tasks.transitionTask(b.taskId, { to: 'running' });
  const load = routerModule.computeLoad(tasks);
  assert.equal(load.queuedTotal, 3);
  assert.equal(load.runningByAgent.memory, 2);
  assert.equal(c.status, 'queued');
});

// ---- G. 配置校验 ----

test('配置：默认路由配置合法', () => {
  assert.equal(routingModule.validateRoutingConfig(routingModule.DEFAULT_ROUTING), null);
});

test('配置：未知字段被拒绝', () => {
  const config = routing({ unexpected: true });
  assert.match(routingModule.validateRoutingConfig(config), /未知字段/);
});

test('配置：未知慢任务类型被拒绝', () => {
  const config = routing({ slowTaskTypes: ['memory.nope'] });
  assert.match(routingModule.validateRoutingConfig(config), /未知任务类型/);
});

test('配置：预算越界被拒绝', () => {
  const config = routing({ profiles: { fast: { maxRounds: 9 } } });
  assert.match(routingModule.validateRoutingConfig(config), /maxRounds/);
});

// ---- H. delegate_to_bot 兼容层 ----

test('兼容层：delegate_to_bot 工具名与必填参数保持不变', () => {
  assert.equal(dispatchTool.definition.name, 'delegate_to_bot');
  assert.deepEqual([...dispatchTool.definition.parameters.required], ['botId', 'taskType', 'goal']);
  assert.deepEqual([...dispatchTool.definition.parameters.properties.botId.enum], ['memory']);
});

test('兼容层：没有主控会话时仍返回 session_required', async () => {
  const result = await dispatchTool.definition.handler(
    { botId: 'memory', taskType: 'memory.search', goal: '查咖啡' },
    {}
  );
  assert.equal(result.ok, false);
  assert.equal(result.code, 'session_required');
});

test('兼容层：Agent 未就绪时返回既有 bot_not_ready 短码', async () => {
  const main = mainSessions.createSession({ title: 'Router 兼容层测试' });
  const result = await dispatchTool.definition.handler(
    { botId: 'memory', taskType: 'memory.search', goal: '查咖啡' },
    { sessionId: main.id, userText: '查咖啡' }
  );
  assert.equal(result.ok, false);
  assert.equal(result.code, 'bot_not_ready');
});
