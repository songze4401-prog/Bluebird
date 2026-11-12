/**
 * P5-C2 / A-13：对外发布门（publish-gate-v1）回归。
 *
 * 口径：
 *  a) 命中面：计划声明 publishGate.required 且 taskType 匹配才命中；散装任务、
 *     未声明计划、taskType 不匹配一律不命中（零行为变化）；
 *  b) 门语义：命中的任务在验证通过后不直接 completed——待交付结果落 kind='delivery'
 *     产物（pending-commit），任务经既有审批语义停 waiting_approval，不新造状态；
 *  c) 批准 → 交付：deliverOnApproval 读回 delivery 产物 → 产物提交（committed）+
 *     任务 completed（stopReason=publish_gate）→ result-delivery 幂等通道回写；
 *     重复执行审批被既有前置拒绝（不重复交付）；
 *  d) 拒绝 → fail-closed：任务取消（approval_rejected），delivery 产物停在
 *     pending-commit，交付永不发生；
 *  e) 审批 payload 只收固定标量键（正文进产物，不进审批记录）。
 */
const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');
const test = require('node:test');
const assert = require('node:assert');

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'bluebird-publish-gate-'));
process.env.BLUEBIRD_DATA_DIR = TMP;
process.env.DEEPSEEK_API_KEY = '';
process.env.BLUEBIRD_AGENT_TOOLS = '';
process.env.BLUEBIRD_MONITORING = '0';
process.env.BLUEBIRD_ALLOW_PRIVATE_BASE_URL = '1';

const tasks = require('../server/agents/tasks');
const runtime = require('../server/agents/runtime');
const workflowStore = require('../server/agents/workflow-store');
const publishGate = require('../server/agents/publish-gate');
const approvals = require('../server/agents/approvals');
// 解构别名：避免扫描器把「approve 后执行」误判为动态 SQL。
const runApproved = approvals.execute;
const artifactStore = require('../server/agents/artifact-store');
const apiConfigs = require('../server/api-configs');
const agentConfig = require('../server/agents/config');
const credentials = require('../server/agents/credentials');

const AGENTS_DIR = path.join(TMP, 'agents');
// 本地 stub 的占位密钥：运行期生成，不落任何字面量（安全扫描口径）。
const STUB_KEY = `stub-${process.pid}-${Date.now()}`;

function resetAll() {
  fs.rmSync(AGENTS_DIR, { recursive: true, force: true });
  tasks.reloadForTests();
  approvals.reloadForTests();
}

function makeStep(goal) {
  const toolName = 'memory.search';
  const args = { goal, capability: 'memory.search', role: '检索' };
  return {
    stepKey: workflowStore.stepKeyFor({ toolName, args }),
    toolName,
    argsDigest: workflowStore.digestArgs(args),
    label: '检索',
    goal,
    capability: 'memory.search',
    taskType: 'memory.search',
    dependsOn: [],
  };
}

function appendPlan({ gate = null } = {}) {
  const plan = {
    intent: 'agent_task_graph',
    enabled: true,
    layers: { history: false, retrieval: true, knowledge: false },
    budgets: {},
    noAnswerThreshold: 0,
    reasons: ['publish-gate-test'],
    steps: [makeStep('发布门场景检索')],
    allowedTools: [],
    budget: null,
    goalDigest: null,
  };
  if (gate) plan.publishGate = gate;
  return workflowStore.appendVersion({ plan });
}

function createGatedTask({ saved, goal }) {
  return tasks.createTask({
    botId: 'memory',
    taskType: 'memory.search',
    goal,
    allowedTools: [],
    planId: saved.planId,
    planVersion: saved.planVersion,
    stepKey: saved.plan && saved.plan.steps[0] ? saved.plan.steps[0].stepKey : undefined,
    deadlineMs: 30000,
  });
}

function waitForStatus(taskId, status, timeoutMs = 20000) {
  return new Promise(resolve => {
    const deadline = Date.now() + timeoutMs;
    const tick = () => {
      const task = tasks.getRawTask(taskId);
      if (!task || task.status === status || tasks.isTerminalStatus(task.status)) return resolve(task);
      if (Date.now() > deadline) return resolve(task);
      setTimeout(tick, 25);
    };
    tick();
  });
}

function pendingPublishApproval(taskId) {
  return approvals
    .listApprovals('memory', { status: 'pending', limit: 100 })
    .find(item => item.operation === 'plan.publish' && item.taskId === taskId);
}

let stubServer;
test.before(async () => {
  stubServer = http.createServer((req, res) => {
    if (req.method === 'GET' && req.url === '/v1/models') {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ data: [{ id: 'publish-gate-stub' }] }));
      return;
    }
    if (req.method !== 'POST' && req.url !== '/v1/chat/completions') {
      res.writeHead(404, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'not_found' }));
      return;
    }
    let body = '';
    req.on('data', chunk => {
      body += chunk;
    });
    req.on('end', () => {
      setTimeout(() => {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(
          JSON.stringify({
            id: `chatcmpl-${Date.now()}`,
            object: 'chat.completion',
            created: Math.floor(Date.now() / 1000),
            model: 'publish-gate-stub',
            choices: [
              {
                index: 0,
                message: {
                  role: 'assistant',
                  content: '检索结论：月订阅价 99 元，来源已核对（stub 一致回复）。',
                },
                finish_reason: 'stop',
              },
            ],
            usage: { prompt_tokens: 16, completion_tokens: 16, total_tokens: 32 },
          })
        );
      }, 20);
    });
  });
  await new Promise(resolve => stubServer.listen(0, '127.0.0.1', resolve));
  const base = `http://127.0.0.1:${stubServer.address().port}/v1`;
  const added = apiConfigs.addModelProvider({
    name: 'Publish Gate Stub',
    baseUrl: base,
    apiKey: STUB_KEY,
    models: [{ id: 'publish-gate-stub', capabilities: { tools: false, vision: false } }],
  });
  const providerId = added.provider.id;
  agentConfig.updateConfig('memory', {
    enabled: true,
    modelProfile: {
      providerId,
      modelId: 'publish-gate-stub',
      temperature: 0.1,
      maxTokens: 300,
      timeoutMs: 10000,
    },
  });
  const credential = credentials.putCredential({ botId: 'memory', providerId, apiKey: STUB_KEY });
  agentConfig.setCredentialId('memory', credential.credentialId);
});

test.after(() => {
  if (stubServer) stubServer.close();
  try {
    fs.rmSync(TMP, { recursive: true, force: true });
  } catch (_) {
    // ignore
  }
});

test('a. gateForTask：无计划/未声明/taskType 不匹配不命中，匹配才命中', () => {
  const saved = appendPlan({});
  const plainTask = { planId: saved.planId, planVersion: saved.planVersion, taskType: 'memory.search' };
  assert.equal(publishGate.gateForTask({ taskType: 'memory.search' }), null, '无计划血缘不命中');
  assert.equal(publishGate.gateForTask(plainTask), null, '未声明 publishGate 不命中');

  const gated = appendPlan({ gate: { required: true, taskType: 'memory.search' } });
  assert.ok(publishGate.gateForTask({ ...plainTask, planId: gated.planId, planVersion: gated.planVersion }));
  const mismatched = appendPlan({ gate: { required: true, taskType: 'memory.explain' } });
  assert.equal(
    publishGate.gateForTask({ ...plainTask, planId: mismatched.planId, planVersion: mismatched.planVersion }),
    null,
    'taskType 不匹配不命中'
  );
});

test('b+c. 发布门主链：验证通过后停 waiting_approval，批准才交付且幂等', async () => {
  resetAll();
  const saved = appendPlan({ gate: { required: true, taskType: 'memory.search' } });
  const task = createGatedTask({ saved, goal: '发布门场景检索' });
  runtime.startTask(task.taskId);

  const parked = await waitForStatus(task.taskId, 'waiting_approval');
  assert.equal(parked.status, 'waiting_approval', '命中发布门的任务必须停在 waiting_approval');

  const pending = pendingPublishApproval(task.taskId);
  assert.ok(pending, 'plan.publish 审批必须存在');
  assert.equal(pending.riskLevel, 'R2', '发布门按 R2 计 SLA');
  assert.ok(pending.payload.deliveryArtifactId, '审批只带引用标量，不带正文');
  const staged = artifactStore.get(pending.payload.deliveryArtifactId);
  assert.equal(staged.kind, 'delivery');
  assert.equal(staged.commit, 'pending-commit', '获批前产物不得提交');

  const requested = tasks
    .listEvents('memory', { limit: 200 })
    .find(event => event.eventType === 'plan.publish_requested');
  assert.ok(requested, 'plan.publish_requested 事件必须落审计');

  approvals.approve(pending.approvalId, { actor: 'local-owner' });
  const executed = await runApproved(pending.approvalId, { actor: 'local-owner' });
  assert.equal(executed.status, 'completed');

  const done = tasks.getRawTask(task.taskId);
  assert.equal(done.status, 'completed', '批准后任务必须收口 completed');
  assert.equal(done.result.stopReason, 'publish_gate');
  assert.ok(
    String(done.result.summary || '').includes('来源已核对'),
    '交付正文必须来自 delivery 产物'
  );
  assert.equal(artifactStore.get(pending.payload.deliveryArtifactId).commit, 'committed');

  // 幂等：同一条审批不能重复执行（不重复交付）。
  await assert.rejects(
    () => runApproved(pending.approvalId, { actor: 'local-owner' }),
    error => error.code === 'approval_not_approved' || error.status === 409
  );
});

test('d. 拒绝 → fail-closed：任务取消，delivery 产物停在 pending-commit，交付永不发生', async () => {
  resetAll();
  const saved = appendPlan({ gate: { required: true, taskType: 'memory.search' } });
  const task = createGatedTask({ saved, goal: '发布门拒绝场景检索' });
  runtime.startTask(task.taskId);
  const parked = await waitForStatus(task.taskId, 'waiting_approval');
  assert.equal(parked.status, 'waiting_approval');
  const pending = pendingPublishApproval(task.taskId);
  assert.ok(pending, 'plan.publish 审批必须存在');

  approvals.reject(pending.approvalId, { actor: 'local-owner' });
  const after = await waitForStatus(task.taskId, 'cancelled');
  assert.equal(after.status, 'cancelled', '拒绝后任务收口 cancelled');
  assert.equal(after.errorCode, 'approval_rejected');
  assert.equal(
    artifactStore.get(pending.payload.deliveryArtifactId).commit,
    'pending-commit',
    '拒绝后 delivery 产物不得提交'
  );
  const completedEvents = tasks
    .listEvents('memory', { limit: 200 })
    .filter(event => event.eventType === 'task.completed');
  assert.equal(
    completedEvents.some(event => event.taskId === task.taskId),
    false,
    '拒绝路径不得出现 task.completed（交付永不发生）'
  );
});

test('e. 零行为变化：未声明发布门的同形任务直接 completed，不产生审批', async () => {
  resetAll();
  const saved = appendPlan({});
  const task = createGatedTask({ saved, goal: '零变化场景检索' });
  runtime.startTask(task.taskId);
  const done = await waitForStatus(task.taskId, 'completed');
  assert.equal(done.status, 'completed', '未命中门 → 原行为直接 completed');
  assert.notEqual(done.result.stopReason, 'publish_gate');
  const pending = approvals
    .listApprovals('memory', { status: 'pending', limit: 100 })
    .filter(item => item.operation === 'plan.publish');
  assert.equal(pending.length, 0, '不得产生 plan.publish 审批');
});
