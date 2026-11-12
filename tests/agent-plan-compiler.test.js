/**
 * 轮 2（Orchestrator 立项书）：计划编译器（plan-compiler-v1）回归。
 *
 * 口径：
 *  a) 合法跨 Agent DAG 编译：执行者由路由解析（memory.search → memory、
 *     summary.synthesize → researcher），definitions 带 workflowPlan 与 agentId；
 *  b) 同内容取出语义（created:false，不追加版本）；
 *  c) 上限与 schema：节点 >8、空 nodes、mode 非法、key 重复、dependsOn 未知、环；
 *  d) 执行者不可解析（未知 taskType）→ capability_not_found；
 *  e) 模型声明的 agent 名一律丢弃：只进审计计数（declaredAgentCount），不参与判定；
 *  f) goal/context 截断与 stepKey 内容寻址；
 *  g) 风险分级入诊断（high_risk 任务类型 → R3，只读任务类型 → R1）；
 *  h) HTTP：POST 编译 + GET 读回端到端；未带令牌 401。
 */
const fs = require('fs');
const os = require('os');
const path = require('path');
const test = require('node:test');
const assert = require('node:assert');

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'bluebird-plan-compiler-'));
process.env.BLUEBIRD_DATA_DIR = TMP;
process.env.DEEPSEEK_API_KEY = '';
process.env.BLUEBIRD_AGENT_TOOLS = '';
process.env.BLUEBIRD_MONITORING = '0';

const tasks = require('../server/agents/tasks');
const workflowStore = require('../server/agents/workflow-store');
const planCompiler = require('../server/agents/plan-compiler');
const express = require('express');
const http = require('http');
const { createAgentRouter } = require('../server/agents/routes');

const AGENTS_DIR = path.join(TMP, 'agents');

function resetAll() {
  fs.rmSync(AGENTS_DIR, { recursive: true, force: true });
  tasks.reloadForTests();
}

function eventsOf(type) {
  return tasks.listEvents('memory', { limit: 200 }).filter(event => event.eventType === type);
}

const NODE_SEARCH = { key: 'find', taskType: 'memory.search', goal: '检索发票抬头' };
const NODE_SUM = { key: 'sum', taskType: 'summary.synthesize', goal: '汇总检索结果' };

test('a. 合法跨 Agent 两节点 DAG：执行者由路由解析，definitions 带解析结果', () => {
  resetAll();
  const compiled = planCompiler.compilePlan({
    goal: '检索并汇总发票抬头',
    mode: 'dag',
    nodes: [NODE_SEARCH, { ...NODE_SUM, dependsOn: ['find'] }],
  });
  assert.equal(compiled.created, true);
  assert.equal(compiled.mode, 'dag');
  assert.ok(compiled.planId.startsWith('plan_pc_'));
  assert.equal(compiled.planVersion, 1);
  assert.equal(compiled.nodes.length, 2);
  const byKey = new Map(compiled.nodes.map(node => [node.key, node]));
  assert.equal(byKey.get('find').agentId, 'memory');
  assert.equal(byKey.get('sum').agentId, 'researcher', 'summary.synthesize 必须解析到 researcher');
  assert.equal(byKey.get('sum').dependsOn[0], 'find');
  // definitions：workflowPlan 冻结、dependsOn 解析为批内 stepKey、agentId 透传。
  assert.equal(compiled.definitions.length, 2);
  const defSum = compiled.definitions.find(def => def.key === byKey.get('sum').stepKey);
  assert.equal(defSum.agentId, 'researcher');
  assert.deepEqual(defSum.workflowPlan, { planId: compiled.planId, planVersion: 1 });
  assert.deepEqual(defSum.dependsOn, [byKey.get('find').stepKey]);
  // stepKey 内容寻址（sha256 十六进制），workflow-store 真实落盘。
  for (const node of compiled.nodes) {
    assert.match(node.stepKey, /^[0-9a-f]{64}$/);
  }
  const readBack = workflowStore.getVersion(compiled.planId, 1);
  assert.equal(readBack.plan.steps.length, 2);
  assert.equal(readBack.plan.steps[1].agentId, 'researcher');
  const compiledEvent = eventsOf('plan.compiled');
  assert.equal(compiledEvent.length, 1);
  assert.equal(compiledEvent[0].payload.nodeCount, 2);
});

test('b. 同内容重编译：取出语义（created:false，同 planId 同版本不追加）', () => {
  resetAll();
  const first = planCompiler.compilePlan({ mode: 'single', nodes: [NODE_SEARCH] });
  assert.equal(first.created, true);
  const second = planCompiler.compilePlan({ mode: 'single', nodes: [{ ...NODE_SEARCH }] });
  assert.equal(second.created, false, '同内容重编译必须走取出语义');
  assert.equal(second.planId, first.planId);
  assert.equal(second.planVersion, first.planVersion);
  const state = workflowStore.read();
  assert.equal(state.plans[first.planId].headVersion, 1, '不得追加版本');
});

test('c. 节点 >8 拒绝并落 plan.rejected', () => {
  resetAll();
  const nodes = Array.from({ length: 9 }, (_, index) => ({
    key: `n${index}`,
    taskType: 'memory.search',
    goal: `节点 ${index}`,
  }));
  assert.throws(
    () => planCompiler.compilePlan({ mode: 'dag', nodes }),
    error => error.code === 'plan_node_limit'
  );
  assert.ok(eventsOf('plan.rejected').some(event => event.payload.skipReason === 'plan_node_limit'));
});

test('d. 未知 taskType → capability_not_found（执行者不可解析）', () => {
  resetAll();
  assert.throws(
    () => planCompiler.compilePlan({ mode: 'dag', nodes: [{ key: 'x', taskType: 'nope.missing', goal: 'g' }] }),
    error => error.code === 'capability_not_found'
  );
});

test('e. 模型声明的 agent 名一律丢弃：只进审计计数，不参与判定', () => {
  resetAll();
  const compiled = planCompiler.compilePlan({
    mode: 'single',
    nodes: [NODE_SEARCH],
    declaredAgents: ['super-agent', 'memory', ''],
  });
  assert.equal(compiled.diagnostics.declaredAgentsIgnored, true);
  assert.equal(compiled.diagnostics.declaredAgentCount, 2);
  assert.equal(compiled.nodes[0].agentId, 'memory', '执行者仍由路由解析');
  const proposed = eventsOf('plan.proposed');
  assert.equal(proposed.length, 1);
  assert.equal(proposed[0].payload.declaredAgentCount, 2);
  assert.ok(!JSON.stringify(proposed[0].payload).includes('super-agent'), '被丢弃的声明不落审计正文');
});

test('f. dependsOn 未知 key / 环 / 重复 key / 空 nodes / 非法 mode 全部拒绝', () => {
  resetAll();
  assert.throws(
    () =>
      planCompiler.compilePlan({
        mode: 'dag',
        nodes: [{ ...NODE_SUM, dependsOn: ['ghost'] }],
      }),
    error => error.code === 'plan_dep_unknown'
  );
  assert.throws(
    () =>
      planCompiler.compilePlan({
        mode: 'dag',
        nodes: [
          { key: 'a', taskType: 'memory.search', goal: 'a', dependsOn: ['b'] },
          { key: 'b', taskType: 'summary.synthesize', goal: 'b', dependsOn: ['a'] },
        ],
      }),
    error => error.code === 'dependency_cycle'
  );
  assert.throws(
    () =>
      planCompiler.compilePlan({
        mode: 'dag',
        nodes: [NODE_SEARCH, { ...NODE_SEARCH }],
      }),
    error => error.code === 'plan_node_key_dup'
  );
  assert.throws(
    () => planCompiler.compilePlan({ mode: 'dag', nodes: [] }),
    error => error.code === 'plan_nodes_missing'
  );
  assert.throws(
    () => planCompiler.compilePlan({ mode: 'chat', nodes: [NODE_SEARCH] }),
    error => error.code === 'plan_mode_invalid'
  );
});

test('g. goal/context 截断；stepKey 内容寻址（不同 goal 不同 key）', () => {
  resetAll();
  const longGoal = '检'.repeat(500);
  const compiled = planCompiler.compilePlan({
    mode: 'single',
    nodes: [{ key: 'n', taskType: 'memory.search', goal: longGoal, context: 'c'.repeat(3000) }],
  });
  assert.equal(compiled.nodes[0].goal.length, 200, 'goal 截断到 STEP_GOAL_MAX');
  assert.equal(compiled.nodes[0].context.length, 2000, 'context 截断到 NODE_CONTEXT_MAX');
  const other = planCompiler.compilePlan({
    mode: 'single',
    nodes: [{ key: 'n', taskType: 'memory.search', goal: '另一个目标' }],
  });
  assert.notEqual(compiled.nodes[0].stepKey, other.nodes[0].stepKey);
});

test('h. 风险分级入诊断：high_risk 任务类型 R3、只读任务类型 R1', () => {
  resetAll();
  const compiled = planCompiler.compilePlan({
    mode: 'dag',
    nodes: [
      { key: 'act', taskType: 'action.execute', goal: '执行变更' },
      { key: 'find', taskType: 'memory.search', goal: '只读检索' },
    ],
  });
  const byKey = new Map(compiled.nodes.map(node => [node.key, node]));
  assert.equal(byKey.get('act').riskLevel, 'R3', 'action.execute 在 HIGH_RISK_TASK_TYPES → R3');
  assert.equal(byKey.get('act').riskPolicyVersion, 'risk-policy-v1');
  assert.equal(byKey.get('find').riskLevel, 'R1');
});

test('i. HTTP 端到端：POST 编译 + GET 读回；未带令牌 401', async () => {
  resetAll();
  const app = express();
  app.use(express.json());
  app.use(
    createAgentRouter({
      requireAuth: (req, res, next) => {
        if (req.headers.authorization === 'Bearer test-token') return next();
        return res.status(401).json({ error: 'unauthorized' });
      },
      auditAction: () => {},
    })
  );
  const server = http.createServer(app);
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const base = `http://127.0.0.1:${server.address().port}`;
  try {
    const denied = await fetch(`${base}/agent-plans`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ mode: 'single', nodes: [NODE_SEARCH] }),
    });
    assert.equal(denied.status, 401, '未带令牌必须 401');

    const response = await fetch(`${base}/agent-plans`, {
      method: 'POST',
      headers: { authorization: 'Bearer test-token', 'content-type': 'application/json' },
      body: JSON.stringify({ goal: 'HTTP 编译', mode: 'dag', nodes: [NODE_SEARCH, { ...NODE_SUM, dependsOn: ['find'] }] }),
    });
    assert.equal(response.status, 201);
    const body = await response.json();
    assert.equal(body.plan.nodes[0].agentId, 'memory');
    assert.equal(body.plan.definitions.length, 2);

    const readBack = await fetch(`${base}/agent-plans/${body.plan.planId}`, {
      headers: { authorization: 'Bearer test-token' },
    });
    assert.equal(readBack.status, 200);
    const readBody = await readBack.json();
    assert.equal(readBody.plan.planId, body.plan.planId);
    assert.equal(readBody.plan.plan.steps.length, 2);

    const missing = await fetch(`${base}/agent-plans/plan_pc_nonexistent`, {
      headers: { authorization: 'Bearer test-token' },
    });
    assert.equal(missing.status, 404);
  } finally {
    server.close();
  }
});

test('j. HTTP 编译失败按错误契约返回（未知 taskType → 400 capability_not_found）', async () => {
  resetAll();
  const app = express();
  app.use(express.json());
  app.use(
    createAgentRouter({
      requireAuth: (req, res, next) => next(),
      auditAction: () => {},
    })
  );
  const server = http.createServer(app);
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  try {
    const response = await fetch(`${base64x(server)}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ mode: 'single', nodes: [{ key: 'x', taskType: 'nope.missing', goal: 'g' }] }),
    });
    assert.equal(response.status, 400);
    const body = await response.json();
    assert.equal(body.code, 'capability_not_found');
    assert.ok(eventsOf('plan.rejected').length >= 1, '编译失败必须落 plan.rejected');
  } finally {
    server.close();
  }
});

function base64x(server) {
  return `http://127.0.0.1:${server.address().port}/agent-plans`;
}
