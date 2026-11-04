/* global require, process, __dirname, console */
/**
 * Phase 1 交付物第 1 项（统一 Planner / Orchestrator 入口）与第 2 项（容量感知择一分配）回归。
 *
 * 能证明什么：
 * - 唯一入口能按已注册主体的能力/任务类型筛出候选并创建任务；
 * - 匹配不到时显式失败（capability_not_found），且不创建任务；
 * - 迁移后的创建路径与旧 Router 路径行为一致（主体、任务类型、路径、预算）；
 * - 编排轨迹（候选集、匹配依据、最终选择）落在既有 task.route 与既有事件里；
 * - 多候选时按 Router 既有优先级（routingPriority → botId）择一，容量余量取自
 *   `decideInternal` 的 atCapacity；一个满容量时选未满的，全部满容量时显式进入既有队列。
 *
 * 不能证明什么：
 * - “动态分配效果好”不可证：用例里的多主体是**测试构造**（注入假 Agent 注册项），
 *   真实环境当前只有 1 个已注册主体（memory），多 Agent 并未实际运行；
 * - Worker Pool、并行执行、依赖管理、多会话隔离不在本轮范围，未实现；
 * - 真实模型环境下的委派效果未验证。
 */
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'bluebird-agent-orchestrator-'));
process.env.BLUEBIRD_DATA_DIR = DATA_DIR;
process.env.DEEPSEEK_API_KEY = '';
process.env.BLUEBIRD_AGENT_TOOLS = '';
process.env.BLUEBIRD_MONITORING = '0';

const routerModule = require('../server/agents/router');
const routingModule = require('../server/agents/routing-config');
const manifest = require('../server/agents/manifest');
const tasks = require('../server/agents/tasks');
const botSessions = require('../server/agents/sessions');
const orchestratorModule = require('../server/agents/orchestrator');

// 多主体**测试构造**：真实注册表只有 memory。这里把假 Manifest 注入注册表，
// 使 Task Store / Registry 的既有校验与落盘路径保持真实（不是另一套内存替身）。
manifest.setTestManifests({
  'agent-a': { ...manifest.MEMORY_BOT_MANIFEST, botId: 'agent-a' },
  'agent-b': { ...manifest.MEMORY_BOT_MANIFEST, botId: 'agent-b' },
  'agent-c': { ...manifest.MEMORY_BOT_MANIFEST, botId: 'agent-c' },
});

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

function routing() {
  return JSON.parse(JSON.stringify(routingModule.DEFAULT_ROUTING));
}

function resetAgentStore() {
  fs.rmSync(path.join(DATA_DIR, 'agents'), { recursive: true, force: true });
  tasks.reloadForTests();
  botSessions.reloadForTests();
  routingModule.reloadForTests();
}

// 真实 Task/Event Store（落盘可核）+ 假 Worker 会话（本交付物不验证隔离）。
// 多主体用例通过注入 agents / runningByAgent 构造，容量口径仍走 Router 的 decideInternal。
function makeOrchestrator(agentOverrides = {}, runningByAgent = {}) {
  const agents = Array.isArray(agentOverrides) ? agentOverrides : [testAgent(agentOverrides)];
  const fakeSessions = {
    createSession: () => ({ id: 'bs_orchestrator_1' }),
    getSession: () => null,
    attachOwner: () => {},
  };
  const router = routerModule.createRouter({
    getAgents: () => agents,
    getConfig: () => ({ config: routing(), digest: 'policy-digest-orchestrator' }),
    sessions: fakeSessions,
    startTask: () => {},
    load: () => ({ queuedTotal: 0, runningByAgent }),
    now: () => 1700000000000,
  });
  return orchestratorModule.createOrchestrator({ router, getAgents: () => agents });
}

test('交付物1a 唯一入口按能力选出主体并创建任务', () => {
  resetAgentStore();
  const orchestrator = makeOrchestrator();
  const result = orchestrator.orchestrate({
    intent: '帮我回忆一下上次说的咖啡偏好',
    parentSessionId: 's_main',
  });

  assert.equal(result.task.agentId, 'memory');
  assert.equal(result.task.taskType, 'memory.search');
  assert.match(result.task.taskId, /^task_/);
  assert.equal(result.orchestration.basis, 'intent_keywords');
  assert.deepEqual(result.orchestration.matchedAgentIds, ['memory']);
  assert.equal(result.decision.selectedAgentId, 'memory');
});

test('交付物1b 匹配不到 → 显式失败且不创建任务', () => {
  resetAgentStore();
  const orchestrator = makeOrchestrator();
  const before = tasks.allTasks().length;

  // ① 意图无法解析出能力。
  assert.throws(
    () => orchestrator.orchestrate({ intent: '今天天气不错' }),
    error => {
      assert.equal(error.code, 'capability_not_found');
      return true;
    }
  );
  // ② 能力存在，但没有任何注册主体把它列入受理任务类型（不静默回落默认 Bot）。
  assert.throws(
    () =>
      orchestrator.orchestrate({
        intent: '审计记忆',
        capability: 'memory.audit.read',
        taskType: 'memory.audit.read',
      }),
    error => {
      assert.equal(error.code, 'capability_not_found');
      return true;
    }
  );
  assert.equal(tasks.allTasks().length, before, '失败路径不得创建任务');
});

test('交付物1c 迁移路径与旧 Router 路径行为不变', () => {
  resetAgentStore();
  const orchestrator = makeOrchestrator();
  const viaOrchestrator = orchestrator.orchestrate({
    agentId: 'memory',
    taskType: 'memory.search',
    goal: '查咖啡偏好',
    priority: 'high',
    parentSessionId: 's_main',
  });

  const routerOnly = routerModule.createRouter({
    getAgents: () => [testAgent()],
    getConfig: () => ({ config: routing(), digest: 'policy-digest-orchestrator' }),
    sessions: {
      createSession: () => ({ id: 'bs_orchestrator_1' }),
      getSession: () => null,
      attachOwner: () => {},
    },
    startTask: () => {},
    load: () => ({ queuedTotal: 0, runningByAgent: {} }),
    now: () => 1700000000000,
  });
  const legacy = routerOnly.dispatch({
    agentId: 'memory',
    taskType: 'memory.search',
    goal: '查咖啡偏好（兼容路径）',
    priority: 'high',
    parentSessionId: 's_main',
  });

  // 主体 / 任务类型 / 路径 / 预算逐项对齐；任务 id 必然不同（两次独立创建）。
  assert.equal(viaOrchestrator.task.agentId, legacy.task.agentId);
  assert.equal(viaOrchestrator.task.taskType, legacy.task.taskType);
  assert.equal(viaOrchestrator.task.status, legacy.task.status);
  assert.equal(viaOrchestrator.task.route.path, legacy.task.route.path);
  assert.deepEqual(viaOrchestrator.task.budget, legacy.task.budget);
  // 旧路径不受影响：没有编排轨迹字段。
  assert.equal(tasks.getRawTask(legacy.task.taskId).route.orchestration, null);
});

test('交付物1d 轨迹落盘：候选集、匹配依据、最终选择', () => {
  resetAgentStore();
  const orchestrator = makeOrchestrator();
  const result = orchestrator.orchestrate({
    intent: '帮我回忆一下上次说的咖啡偏好',
    parentSessionId: 's_main',
  });

  const raw = tasks.getRawTask(result.task.taskId);
  assert.deepEqual(raw.route.orchestration, {
    entry: 'orchestrator',
    version: 2,
    intentDigest: raw.route.orchestration.intentDigest,
    capability: 'memory.search',
    taskType: 'memory.search',
    basis: 'intent_keywords',
    matchingRule: 'capabilities ∩ acceptedTaskTypes',
    registeredAgents: 1,
    matchedAgentIds: ['memory'],
    requestedAgentId: null,
    capacityRule: 'decideInternal.atCapacity (running >= concurrencyLimit)',
    priorityRule: 'routingPriority asc → botId asc',
    candidateOrder: ['memory'],
    saturatedAgentIds: [],
    allocation: 'selected_with_capacity',
    selectedAgentId: 'memory',
    excludedReasons: '',
  });
  assert.match(raw.route.orchestration.intentDigest, /^sha256:[0-9a-f]{64}$/);
  assert.equal(raw.agentId, 'memory');

  const allEvents = tasks.listEvents('memory', { limit: 50 });
  const decided = allEvents.find(
    event => event.eventType === 'route.decided' && event.taskId === result.task.taskId
  );
  assert.ok(decided, 'route.decided 事件必须存在');
  assert.equal(decided.payload.selected, 'memory');
  assert.equal(decided.payload.candidates, 'memory');
  assert.equal(decided.payload.capability, 'memory.search');
  // 事件 payload 只接受标量白名单，轨迹以扁平字段落盘，与 task.route.orchestration 同源。
  assert.equal(decided.payload.orchestrationEntry, 'orchestrator');
  assert.equal(decided.payload.orchestrationBasis, 'intent_keywords');
  assert.equal(decided.payload.orchestrationCapability, 'memory.search');
  assert.equal(decided.payload.orchestrationTaskType, 'memory.search');
  assert.equal(decided.payload.orchestrationMatchingRule, 'capabilities ∩ acceptedTaskTypes');
  assert.equal(decided.payload.orchestrationMatchedAgents, 'memory');
  assert.equal(decided.payload.orchestrationRegisteredAgents, 1);
  assert.equal(
    decided.payload.orchestrationIntentDigest,
    raw.route.orchestration.intentDigest
  );
  assert.equal(
    decided.payload.orchestrationCapacityRule,
    'decideInternal.atCapacity (running >= concurrencyLimit)'
  );
  assert.equal(decided.payload.orchestrationCandidateOrder, 'memory');
  assert.equal(decided.payload.orchestrationSaturated, '');
  assert.equal(decided.payload.orchestrationAllocation, 'selected_with_capacity');
  assert.equal(decided.payload.orchestrationSelected, 'memory');
  assert.equal(decided.payload.orchestrationExcluded, '');

  console.log('[交付物1d 落盘轨迹]', JSON.stringify({
    taskRoute: raw.route.orchestration,
    eventPayload: {
      candidates: decided.payload.candidates,
      selected: decided.payload.selected,
      capability: decided.payload.capability,
      orchestrationEntry: decided.payload.orchestrationEntry,
      orchestrationBasis: decided.payload.orchestrationBasis,
      orchestrationIntentDigest: decided.payload.orchestrationIntentDigest,
      orchestrationMatchingRule: decided.payload.orchestrationMatchingRule,
      orchestrationMatchedAgents: decided.payload.orchestrationMatchedAgents,
      orchestrationRegisteredAgents: decided.payload.orchestrationRegisteredAgents,
      orchestrationCapacityRule: decided.payload.orchestrationCapacityRule,
      orchestrationCandidateOrder: decided.payload.orchestrationCandidateOrder,
      orchestrationAllocation: decided.payload.orchestrationAllocation,
      orchestrationSelected: decided.payload.orchestrationSelected,
      orchestrationExcluded: decided.payload.orchestrationExcluded,
    },
  }));
});

// ============================================================================
// 交付物 2：容量感知的择一分配
// 注意：以下多主体全部是**测试构造**（注入假 Agent 描述），真实注册表只有 memory 一个主体。
// ============================================================================

function multiAgent(botId, overrides = {}) {
  return testAgent({ botId, ...overrides });
}

function eventOf(taskId, agentId) {
  return tasks
    .listEvents(agentId, { limit: 50 })
    .find(event => event.eventType === 'route.decided' && event.taskId === taskId);
}

test('交付物2a 两候选、一个满容量 → 选未满的那个（轨迹可查）', () => {
  resetAgentStore();
  const agents = [
    multiAgent('agent-a', { routingPriority: 100, concurrencyLimit: 2 }),
    multiAgent('agent-b', { routingPriority: 120, concurrencyLimit: 2 }),
  ];
  // agent-a 的 running=2 已达到 concurrencyLimit=2；agent-b 空闲。
  const orchestrator = makeOrchestrator(agents, { 'agent-a': 2 });
  const result = orchestrator.orchestrate({
    intent: '帮我回忆一下上次说的咖啡偏好',
    parentSessionId: 's_main',
  });

  assert.equal(result.task.agentId, 'agent-b');
  assert.equal(result.task.status, 'queued');
  assert.equal(result.orchestration.selectedAgentId, 'agent-b');
  assert.equal(result.orchestration.allocation, 'selected_with_capacity');
  assert.deepEqual(result.orchestration.candidateOrder, ['agent-a', 'agent-b']);
  assert.deepEqual(result.orchestration.saturatedAgentIds, ['agent-a']);
  assert.equal(result.orchestration.excludedReasons, 'agent-a:at_capacity');
  assert.equal(
    result.orchestration.capacityRule,
    'decideInternal.atCapacity (running >= concurrencyLimit)'
  );

  const raw = tasks.getRawTask(result.task.taskId);
  assert.equal(raw.agentId, 'agent-b');
  assert.equal(raw.route.orchestration.selectedAgentId, 'agent-b');
  assert.equal(raw.route.orchestration.excludedReasons, 'agent-a:at_capacity');

  const decided = eventOf(result.task.taskId, 'agent-b');
  assert.ok(decided, '选中主体必须留下 route.decided 事件');
  console.log('[交付物2a 轨迹]', JSON.stringify({
    taskAgentId: raw.agentId,
    routeOrchestration: raw.route.orchestration,
    event: {
      candidates: decided.payload.candidates,
      selected: decided.payload.selected,
      degraded: decided.payload.degraded,
      orchestrationCandidateOrder: decided.payload.orchestrationCandidateOrder,
      orchestrationSaturated: decided.payload.orchestrationSaturated,
      orchestrationAllocation: decided.payload.orchestrationAllocation,
      orchestrationExcluded: decided.payload.orchestrationExcluded,
    },
  }));
});

test('交付物2b 多候选均可用 → 按既定优先级择一，跑两次同结果', () => {
  resetAgentStore();
  const agents = [
    multiAgent('agent-a', { routingPriority: 100 }),
    multiAgent('agent-b', { routingPriority: 120 }),
    // 与 agent-b 同优先级，用 botId 升序打破平局（仍然是 agent-b 胜出）。
    multiAgent('agent-c', { routingPriority: 120 }),
  ];
  const orchestrator = makeOrchestrator(agents);

  const first = orchestrator.orchestrate({ intent: '帮我回忆一下上次说的咖啡偏好' });
  const second = orchestrator.orchestrate({ intent: '帮我检索一下之前的咖啡偏好记录' });

  for (const result of [first, second]) {
    assert.equal(result.task.agentId, 'agent-a', 'routingPriority 最小的主体胜出');
    assert.equal(result.orchestration.selectedAgentId, 'agent-a');
    assert.equal(result.orchestration.allocation, 'selected_with_capacity');
    assert.deepEqual(result.orchestration.candidateOrder, ['agent-a', 'agent-b', 'agent-c']);
    assert.deepEqual(result.orchestration.saturatedAgentIds, []);
    assert.equal(
      result.orchestration.excludedReasons,
      'agent-b:lower_priority;agent-c:lower_priority'
    );
  }

  // 同一输入（同一候选集/负载/优先级）两次运行结果一致，选择规则确定可复现。
  assert.deepEqual(
    {
      selected: first.orchestration.selectedAgentId,
      order: first.orchestration.candidateOrder,
      allocation: first.orchestration.allocation,
      excluded: first.orchestration.excludedReasons,
    },
    {
      selected: second.orchestration.selectedAgentId,
      order: second.orchestration.candidateOrder,
      allocation: second.orchestration.allocation,
      excluded: second.orchestration.excludedReasons,
    }
  );

  console.log('[交付物2b 轨迹（两次一致）]', JSON.stringify({
    candidateOrder: first.orchestration.candidateOrder,
    selected: first.orchestration.selectedAgentId,
    allocation: first.orchestration.allocation,
    excludedReasons: first.orchestration.excludedReasons,
    secondSelected: second.orchestration.selectedAgentId,
  }));
});

test('交付物2c 全部候选满容量 → 显式排队（高优先级主体 + degraded），不建错任务', () => {
  resetAgentStore();
  const agents = [
    multiAgent('agent-a', { routingPriority: 100, concurrencyLimit: 2 }),
    multiAgent('agent-b', { routingPriority: 120, concurrencyLimit: 2 }),
  ];
  const orchestrator = makeOrchestrator(agents, { 'agent-a': 2, 'agent-b': 2 });
  const result = orchestrator.orchestrate({
    intent: '帮我回忆一下上次说的咖啡偏好',
    parentSessionId: 's_main',
  });

  // 显式选择「排队」而不是静默失败/改投别的通道：任务落到既有队列，标记 degraded。
  assert.equal(result.decision.degraded, true);
  assert.equal(result.orchestration.allocation, 'queued_all_at_capacity');
  assert.equal(result.task.agentId, 'agent-a', '全满时仍按既有优先级选排序第一的主体排队');
  assert.equal(result.task.status, 'queued');
  assert.deepEqual(result.orchestration.saturatedAgentIds, ['agent-a', 'agent-b']);
  assert.equal(result.orchestration.excludedReasons, 'agent-b:at_capacity');

  // 不创建错任务：只创建 1 个任务，且没有落到别的候选主体。
  const all = tasks.allTasks();
  assert.equal(all.length, 1);
  assert.equal(all.filter(task => task.agentId === 'agent-b').length, 0);

  const decided = eventOf(result.task.taskId, 'agent-a');
  assert.equal(decided.payload.degraded, true);
  assert.equal(decided.payload.orchestrationAllocation, 'queued_all_at_capacity');

  console.log('[交付物2c 轨迹]', JSON.stringify({
    taskAgentId: result.task.agentId,
    taskStatus: result.task.status,
    degraded: result.decision.degraded,
    routeOrchestration: tasks.getRawTask(result.task.taskId).route.orchestration,
    event: {
      selected: decided.payload.selected,
      degraded: decided.payload.degraded,
      orchestrationAllocation: decided.payload.orchestrationAllocation,
      orchestrationSaturated: decided.payload.orchestrationSaturated,
      orchestrationExcluded: decided.payload.orchestrationExcluded,
    },
  }));
});

test('交付物2d 单主体路径行为不变：与 Router 纯决策对齐，新增轨迹不改任务核心字段', () => {
  resetAgentStore();
  const agents = [testAgent()];
  const orchestrator = makeOrchestrator(agents);
  const input = {
    agentId: 'memory',
    taskType: 'memory.search',
    goal: '查咖啡偏好',
    priority: 'high',
    parentSessionId: 's_main',
  };
  const viaOrchestrator = orchestrator.orchestrate(input);

  // 对照旧路径：同一负载下 Router 的纯决策（不经过编排层）。
  const legacyRouter = routerModule.createRouter({
    getAgents: () => agents,
    getConfig: () => ({ config: routing(), digest: 'policy-digest-orchestrator' }),
    sessions: {
      createSession: () => ({ id: 'bs_orchestrator_1' }),
      getSession: () => null,
      attachOwner: () => {},
    },
    startTask: () => {},
    load: () => ({ queuedTotal: 0, runningByAgent: {} }),
    now: () => 1700000000000,
  });
  const legacyDecision = legacyRouter.decide({
    agentId: 'memory',
    taskType: 'memory.search',
    goal: '查咖啡偏好',
    priority: 'high',
  });

  // 主体选择与 degraded 与旧 Router 一致；任务核心字段不变。
  assert.equal(viaOrchestrator.task.agentId, legacyDecision.selectedAgentId);
  assert.equal(viaOrchestrator.task.agentId, 'memory');
  assert.equal(viaOrchestrator.decision.degraded, legacyDecision.degraded);
  assert.equal(viaOrchestrator.decision.path, legacyDecision.path);
  assert.deepEqual(viaOrchestrator.task.budget, legacyDecision.budget);
  // 新增的只是轨迹字段，不改状态：任务仍按既有路径创建并入队。
  assert.equal(viaOrchestrator.task.status, 'queued');
  assert.equal(viaOrchestrator.orchestration.selectedAgentId, 'memory');
  assert.equal(viaOrchestrator.orchestration.allocation, 'selected_with_capacity');
  assert.deepEqual(viaOrchestrator.orchestration.candidateOrder, ['memory']);
  assert.deepEqual(viaOrchestrator.orchestration.saturatedAgentIds, []);

  console.log('[交付物2d 与 Router 决策对齐]', JSON.stringify({
    taskAgentId: viaOrchestrator.task.agentId,
    legacySelected: legacyDecision.selectedAgentId,
    path: viaOrchestrator.decision.path,
    budget: viaOrchestrator.task.budget,
    orchestration: {
      selected: viaOrchestrator.orchestration.selectedAgentId,
      allocation: viaOrchestrator.orchestration.allocation,
      candidateOrder: viaOrchestrator.orchestration.candidateOrder,
    },
  }));
});

