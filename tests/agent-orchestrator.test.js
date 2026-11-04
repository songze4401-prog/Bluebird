/* global require, process, __dirname, console */
/**
 * Phase 1 交付物第 1 项：统一 Planner / Orchestrator 入口回归。
 *
 * 能证明什么：
 * - 唯一入口能按已注册主体的能力/任务类型筛出候选并创建任务；
 * - 匹配不到时显式失败（capability_not_found），且不创建任务；
 * - 迁移后的创建路径与旧 Router 路径行为一致（主体、任务类型、路径、预算）；
 * - 编排轨迹（候选集、匹配依据、最终选择）落在既有 task.route 与既有事件里。
 *
 * 不能证明什么：
 * - “动态分配效果好”“Worker Pool 并行/依赖管理”不在本交付物范围，未实现；
 * - 真实模型环境下的委派效果未验证（本文件用假 Agent 注册项）。
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
function makeOrchestrator(agentOverrides = {}) {
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
    load: () => ({ queuedTotal: 0, runningByAgent: {} }),
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
    version: 1,
    intentDigest: raw.route.orchestration.intentDigest,
    capability: 'memory.search',
    taskType: 'memory.search',
    basis: 'intent_keywords',
    matchingRule: 'capabilities ∩ acceptedTaskTypes',
    registeredAgents: 1,
    matchedAgentIds: ['memory'],
    requestedAgentId: null,
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
    },
  }));
});
