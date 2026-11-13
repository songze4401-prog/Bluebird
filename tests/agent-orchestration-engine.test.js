/**
 * 轮 3（Orchestrator 立项书）：编排执行引擎（orchestration-engine-v1）回归。
 *
 * 口径：
 *  a) orchestrateDAG：跨 Agent DAG（memory.search → summary.synthesize）按编译产物
 *     建任务——各节点落在解析出的执行者上、依赖解析为上游真实 taskId、编排记录
 *     running + orchestration.created；幂等键防重复建任务（重入 idempotent:true）；
 *  b) dag-v1 放行面：跨 Agent 依赖仅 plan_pc_ 图可用，散装任务同 Agent 约束不变；
 *  c) 产物继承：上游完成 → 产物显式 share 给直接下游 + 下游 context 注入引用行
 *     + orchestration.artifact_shared（runtime 终态钩子驱动）；
 *  d) 根归约与交付：全节点终态 → completed/partial（失败节点列缺口）→
 *     deliverPlanOutcome 幂等回写父会话（bot-result-<planId>）；
 *  e) 审校门：任一节点 R2+ → 聚合结论落 conclusion 产物 → openReview 独立审校
 *     → pass 才交付；fail → blocked_review 不交付；
 *  f) 发布门：计划声明 publishGate → awaiting_publish → 全部命中节点批准后根交付
 *    （审批执行回查归约）；
 *  g) HTTP：POST 编排 + GET 读回 + 未带令牌 401。
 */
const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');
const test = require('node:test');
const assert = require('node:assert');

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'bluebird-orch-engine-'));
process.env.BLUEBIRD_DATA_DIR = TMP;
process.env.DEEPSEEK_API_KEY = '';
process.env.BLUEBIRD_AGENT_TOOLS = '';
process.env.BLUEBIRD_MONITORING = '0';
process.env.BLUEBIRD_ALLOW_PRIVATE_BASE_URL = '1';

const tasks = require('../server/agents/tasks');
const runtime = require('../server/agents/runtime');
const sessions = require('../server/sessions');
const workflowStore = require('../server/agents/workflow-store');
const planCompiler = require('../server/agents/plan-compiler');
const orchestrationEngine = require('../server/agents/orchestration-engine');
const artifactStore = require('../server/agents/artifact-store');
const approvalsModule = require('../server/agents/approvals');
const runApproved = approvalsModule.execute;
const apiConfigs = require('../server/api-configs');
const agentConfig = require('../server/agents/config');
const credentials = require('../server/agents/credentials');
const express = require('express');
const { createAgentRouter } = require('../server/agents/routes');

const AGENTS_DIR = path.join(TMP, 'agents');
// 本地 stub 的占位密钥：运行期生成，不落任何字面量（安全扫描口径）。
const STUB_KEY = `stub-${process.pid}-${Date.now()}`;

function resetAll() {
  fs.rmSync(AGENTS_DIR, { recursive: true, force: true });
  tasks.reloadForTests();
  planRevisionReload();
  orchestrationEngine.reloadForTests();
}

function planRevisionReload() {
  try {
    require('../server/agents/plan-revision').reloadForTests();
  } catch (_) {
    // ignore
  }
}

function eventsOf(botId, type) {
  return tasks
    .listEvents(botId, { limit: 300 })
    .filter(event => event.eventType === type);
}

function waitFor(condition, timeoutMs = 30000, intervalMs = 30) {
  return new Promise(resolve => {
    const deadline = Date.now() + timeoutMs;
    const tick = async () => {
      const value = await condition();
      if (value) return resolve(value);
      if (Date.now() > deadline) return resolve(null);
      setTimeout(tick, intervalMs);
    };
    tick();
  });
}

function makeNodes({ failFirst = false, reviewFailMarker = false } = {}) {
  const first = {
    key: 'find',
    taskType: 'memory.search',
    goal: failFirst ? 'FAILSCENARIO 检索场景' : '检索发票抬头',
  };
  const second = {
    key: 'sum',
    taskType: 'summary.synthesize',
    goal: reviewFailMarker ? '审校fail场景 汇总' : '汇总检索结果',
    dependsOn: ['find'],
  };
  return [first, second];
}

async function waitForOrchestration(planId, status, timeoutMs = 30000) {
  return waitFor(() => {
    const record = orchestrationEngine.getOrchestration(planId);
    return record && record.status === status ? record : null;
  }, timeoutMs);
}

let stubServer;
test.before(async () => {
  stubServer = http.createServer((req, res) => {
    if (req.method === 'GET' && req.url === '/v1/models') {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ data: [{ id: 'orch-stub' }] }));
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
      const text = String(JSON.parse(body).messages.at(-1).content || '');
      setTimeout(() => {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        // 失败场景：空回复 → empty_reply 终态失败。
        if (text.includes('FAILSCENARIO')) {
          res.end(
            JSON.stringify({
              id: `chatcmpl-${Date.now()}`,
              object: 'chat.completion',
              created: Math.floor(Date.now() / 1000),
              model: 'orch-stub',
              choices: [{ index: 0, message: { role: 'assistant', content: '' }, finish_reason: 'stop' }],
              usage: { prompt_tokens: 8, completion_tokens: 0, total_tokens: 8 },
            })
          );
          return;
        }
        // 审校请求：聚合结论带 fail 标记 → fail（带被审产物证据）；否则 pass。
        const artMatch = text.match(/id=(art_[A-Za-z0-9_-]+)/);
        const verMatch = text.match(/version=(\d+)/);
        if (text.includes('独立审校任务') && artMatch) {
          const decision = text.includes('审校fail场景')
            ? 'fail'
            : text.includes('审校human场景')
              ? 'needs_human'
              : 'pass';
          res.end(
            JSON.stringify({
              id: `chatcmpl-${Date.now()}`,
              object: 'chat.completion',
              created: Math.floor(Date.now() / 1000),
              model: 'orch-stub',
              choices: [
                {
                  index: 0,
                  message: {
                    role: 'assistant',
                    content: JSON.stringify({
                      decision,
                      candidateRef: artMatch[1],
                      evidence: [{ id: artMatch[1], version: verMatch ? Number(verMatch[1]) : 1 }],
                      reasons: ['stub_verdict'],
                    }),
                  },
                  finish_reason: 'stop',
                },
              ],
              usage: { prompt_tokens: 48, completion_tokens: 24, total_tokens: 72 },
            })
          );
          return;
        }
        // 普通 worker：回复回显场景标记，让聚合结论携带给审校的判定输入。
        const reply = text.includes('审校fail场景')
          ? '审校fail场景：汇总结论存疑，证据不足。'
          : text.includes('审校human场景')
            ? '审校human场景：已执行完成，结论无法自证，需外部核对。'
            : '已完成：示例结论与来源一致（stub 一致回复）。';
        res.end(
          JSON.stringify({
            id: `chatcmpl-${Date.now()}`,
            object: 'chat.completion',
            created: Math.floor(Date.now() / 1000),
            model: 'orch-stub',
            choices: [{ index: 0, message: { role: 'assistant', content: reply }, finish_reason: 'stop' }],
            usage: { prompt_tokens: 16, completion_tokens: 16, total_tokens: 32 },
          })
        );
      }, 20);
    });
  });
  await new Promise(resolve => stubServer.listen(0, '127.0.0.1', resolve));
  const base = `http://127.0.0.1:${stubServer.address().port}/v1`;
  const added = apiConfigs.addModelProvider({
    name: 'Orch Engine Stub',
    baseUrl: base,
    apiKey: STUB_KEY,
    models: [{ id: 'orch-stub', capabilities: { tools: false, vision: false } }],
  });
  const providerId = added.provider.id;
  for (const botId of ['memory', 'researcher', 'executor', 'reviewer']) {
    agentConfig.updateConfig(botId, {
      enabled: true,
      modelProfile: { providerId, modelId: 'orch-stub', temperature: 0.1, maxTokens: 300, timeoutMs: 10000 },
    });
    const credential = credentials.putCredential({ botId, providerId, apiKey: STUB_KEY });
    agentConfig.setCredentialId(botId, credential.credentialId);
  }
});

test.after(() => {
  if (stubServer) stubServer.close();
  try {
    fs.rmSync(TMP, { recursive: true, force: true });
  } catch (_) {
    // ignore
  }
});

function newParentSession() {
  return sessions.createSession('memory', { title: 'orch-engine-test', scope: 'main' }).id;
}

test('a+b. orchestrateDAG：跨 Agent DAG 建任务 + 幂等重入；散装跨 Agent 依赖仍拒绝', async () => {
  resetAll();
  const compiled = planCompiler.compilePlan({ mode: 'dag', nodes: makeNodes() });
  const parentSessionId = newParentSession();
  const first = orchestrationEngine.orchestrateDAG({
    planId: compiled.planId,
    parentSessionId,
    parentUserText: '帮我检索并汇总',
  });
  assert.equal(first.idempotent, false);
  assert.equal(first.orchestration.status, 'running');
  const nodes = first.orchestration.nodes;
  assert.equal(Object.keys(nodes).length, 2);
  const findNode = Object.values(nodes).find(node => node.taskType === 'memory.search');
  const sumNode = Object.values(nodes).find(node => node.taskType === 'summary.synthesize');
  assert.ok(findNode && sumNode, '两个节点都按编译产物落位');
  assert.equal(findNode.agentId, 'memory');
  assert.equal(sumNode.agentId, 'researcher', '跨 Agent 执行者按编译产物落位');
  // 依赖解析为上游真实 taskId。
  const rawSum = tasks.getRawTask(sumNode.taskId);
  assert.deepEqual(rawSum.dependsOn, [findNode.taskId]);
  // dag-v1：跨 Agent 边只对 plan_pc_ 图放行——同参数散装任务必须拒绝。
  assert.throws(
    () =>
      tasks.createTask({
        botId: 'researcher',
        taskType: 'summary.synthesize',
        goal: '散装跨 Agent 依赖',
        dependsOn: [findNode.taskId],
        deadlineMs: 30000,
      }),
    error => error.code === 'dependency_not_found'
  );
  // orchestration.created 事件。
  assert.ok(eventsOf('memory', 'orchestration.created').some(e => e.payload.planId === compiled.planId));

  // 幂等重入。
  const second = orchestrationEngine.orchestrateDAG({ planId: compiled.planId, parentSessionId });
  assert.equal(second.idempotent, true);
  assert.equal(Object.values(second.orchestration.nodes).find(node => node.taskType === 'summary.synthesize').taskId, sumNode.taskId, '重入不得新建任务');
});

test('c+d. 产物继承 + 根归约交付：跨 Agent DAG 全绿 → completed + 幂等回写父会话', async () => {
  resetAll();
  const compiled = planCompiler.compilePlan({ mode: 'dag', nodes: makeNodes() });
  const parentSessionId = newParentSession();
  const { orchestration } = orchestrationEngine.orchestrateDAG({ planId: compiled.planId, parentSessionId });
  const findNodeId = Object.values(orchestration.nodes).find(node => node.taskType === 'memory.search').taskId;
  const sumNodeId = Object.values(orchestration.nodes).find(node => node.taskType === 'summary.synthesize').taskId;

  // c：上游完成后产物显式共享给下游 + context 注入引用行 + 事件。
  const shared = await waitFor(() => {
    const events = eventsOf('memory', 'orchestration.artifact_shared').filter(
      event => event.payload.planId === compiled.planId
    );
    return events.length >= 1 ? events : null;
  });
  assert.ok(shared, 'orchestration.artifact_shared 必须落审计');
  const downstream = tasks.getRawTask(sumNodeId);
  assert.ok(
    String(downstream.context || '').includes('上游产物引用'),
    '下游 context 必须注入上游产物引用行'
  );
  const findTask = await waitFor(() => {
    const task = tasks.getRawTask(findNodeId);
    return task && task.status === 'completed' ? task : null;
  });
  assert.ok(findTask, '上游必须完成');
  for (const ref of findTask.result.artifacts) {
    const artifact = artifactStore.get(ref.id);
    assert.ok(
      artifact.share && Array.isArray(artifact.share.taskIds) && artifact.share.taskIds.includes(sumNodeId),
      `产物 ${ref.id} 必须共享给下游`
    );
  }

  // d：全部完成 → completed + 幂等回写父会话。
  const done = await waitForOrchestration(compiled.planId, 'completed');
  assert.ok(done, `编排必须收口 completed`);
  assert.ok(done.deliveryMessageId && done.deliveryMessageId.startsWith('bot-result-'));
  const messages = sessions.getMessages(parentSessionId);
  const rootMessage = messages.find(message => message.id === done.deliveryMessageId);
  assert.ok(rootMessage, '根结果必须写入父会话');
  assert.ok(rootMessage.content.includes('编排任务完成'));
  const partialEvents = eventsOf('memory', 'orchestration.partial').filter(
    event => event.payload.planId === compiled.planId
  );
  assert.equal(partialEvents.length, 0);
  const completedEvents = eventsOf('memory', 'orchestration.completed').filter(
    event => event.payload.planId === compiled.planId
  );
  assert.equal(completedEvents.length, 1);
});

test('e. 失败 → partial：失败节点列缺口，neverStarted 下游如实标注', async () => {
  resetAll();
  const compiled = planCompiler.compilePlan({
    mode: 'dag',
    nodes: makeNodes({ failFirst: true }),
  });
  const parentSessionId = newParentSession();
  orchestrationEngine.orchestrateDAG({ planId: compiled.planId, parentSessionId });
  const done = await waitForOrchestration(compiled.planId, 'partial');
  assert.ok(done, '编排必须收口 partial');
  const messages = sessions.getMessages(parentSessionId);
  const rootMessage = messages.find(message => message.id === done.deliveryMessageId);
  assert.ok(rootMessage && rootMessage.content.includes('编排任务部分完成'));
  const partialEvents = eventsOf('memory', 'orchestration.partial').filter(
    event => event.payload.planId === compiled.planId
  );
  assert.equal(partialEvents.length, 1);
  assert.equal(partialEvents[0].payload.failedCount >= 1, true);
  // 下游被依赖判死：neverStarted 如实入档。
  const sumTask = tasks.getRawTask(Object.values(done.nodes).find(node => node.taskType === 'summary.synthesize').taskId);
  assert.equal(sumTask.status, 'failed');
  assert.equal(sumTask.errorCode, 'dependency_failed');
  assert.equal(sumTask.result && sumTask.result.neverStarted, true);
});

test('f1. 审校门：R3 节点 → 独立审校 pass → 才交付', async () => {
  resetAll();
  const compiled = planCompiler.compilePlan({
    mode: 'single',
    nodes: [{ key: 'act', taskType: 'action.execute', goal: '执行变更（审校通过场景）' }],
  });
  const compiledNode = compiled.nodes[0];
  assert.equal(compiledNode.riskLevel, 'R3');
  const parentSessionId = newParentSession();
  orchestrationEngine.orchestrateDAG({ planId: compiled.planId, parentSessionId });
  const done = await waitForOrchestration(compiled.planId, 'completed');
  assert.ok(done, '审校通过后必须交付');
  const record = orchestrationEngine.getOrchestration(compiled.planId);
  assert.ok(Object.values(record.nodes).every(node => node.taskId), 'R3 节点记录在案');
});

test('f2. 审校门：独立审校 fail → blocked_review，不交付', async () => {
  resetAll();
  const compiled = planCompiler.compilePlan({
    mode: 'single',
    nodes: [{ key: 'act', taskType: 'action.execute', goal: '审校fail场景 执行变更' }],
  });
  const parentSessionId = newParentSession();
  orchestrationEngine.orchestrateDAG({ planId: compiled.planId, parentSessionId });
  const blocked = await waitForOrchestration(compiled.planId, 'blocked_review');
  assert.ok(blocked, '审校 fail 必须停 blocked_review');
  assert.ok(blocked.pendingReason && blocked.pendingReason.startsWith('review_'));
  const messages = sessions.getMessages(parentSessionId);
  assert.equal(
    messages.some(message => message.id.startsWith('bot-result-') && message.content.includes('编排任务完成')),
    false,
    '审校未过不得根交付'
  );
});

test('f3. 审校门 v2 处置：needs_human → 标注交付（completed + 未经独立审校警示）', async () => {
  resetAll();
  const compiled = planCompiler.compilePlan({
    mode: 'single',
    nodes: [{ key: 'act', taskType: 'action.execute', goal: '审校human场景 执行变更' }],
  });
  const parentSessionId = newParentSession();
  orchestrationEngine.orchestrateDAG({ planId: compiled.planId, parentSessionId });
  const done = await waitForOrchestration(compiled.planId, 'completed');
  assert.ok(done, 'needs_human 必须标注交付而非阻断');
  assert.equal(done.reviewOutcome, 'review_needs_human');
  const messages = sessions.getMessages(parentSessionId);
  const rootMessage = messages.find(message => message.id === done.deliveryMessageId);
  assert.ok(rootMessage, '标注交付必须真实回写父会话');
  assert.ok(
    rootMessage.content.includes('未经独立验证') && rootMessage.content.includes('review_needs_human'),
    '交付内容必须带披露警示与审校引用'
  );
});

test('g. 发布门：awaiting_publish → 全部命中节点批准后根交付', async () => {
  resetAll();
  const compiled = planCompiler.compilePlan({
    mode: 'single',
    nodes: [{ key: 'find', taskType: 'memory.search', goal: '发布门编排场景' }],
  });
  // 给同一血缘追加带发布门的 v2（同步骤内容）。
  const head = workflowStore.getVersion(compiled.planId, compiled.planVersion);
  workflowStore.appendVersion({
    planId: compiled.planId,
    plan: { ...head.plan, publishGate: { required: true, taskType: 'memory.search' } },
  });
  const parentSessionId = newParentSession();
  orchestrationEngine.orchestrateDAG({ planId: compiled.planId, parentSessionId });
  // 命中节点停在发布门（waiting_approval，非终态）→ 编排不可归约、无根交付。
  //（awaiting_publish 是「全节点终态但审批未齐」的防御性不变量；门语义下命中
  // 节点只能停在 waiting_approval，终态即代表审批已收口。）
  const parked = await waitFor(() => {
    const record = orchestrationEngine.getOrchestration(compiled.planId);
    if (!record || record.status !== 'running') return null;
    const node = Object.values(record.nodes)[0];
    const task = tasks.getRawTask(node.taskId);
    return task && task.status === 'waiting_approval' ? task : null;
  });
  assert.ok(parked, '命中节点必须停在发布门 waiting_approval');
  // 无根交付。
  assert.equal(
    sessions.getMessages(parentSessionId).some(message => message.content.includes('编排任务完成')),
    false
  );
  // 批准命中节点的 plan.publish → 审批执行回查归约 → 根交付。
  const pending = approvalsModule
    .listApprovals('memory', { status: 'pending', limit: 100 })
    .find(item => item.operation === 'plan.publish' && item.payload.planId === compiled.planId);
  assert.ok(pending, '命中节点的 plan.publish 审批必须存在');
  approvalsModule.approve(pending.approvalId, { actor: 'local-owner' });
  await runApproved(pending.approvalId, { actor: 'local-owner' });
  const done = await waitForOrchestration(compiled.planId, 'completed');
  assert.ok(done, '批准后必须根交付');
  assert.ok(
    sessions.getMessages(parentSessionId).some(message => message.id === done.deliveryMessageId)
  );
});

test('h. 边界：非编译器 planId 400、未知 planId 404、definitions 数量不符 400', async () => {
  resetAll();
  assert.throws(
    () => orchestrationEngine.orchestrateDAG({ planId: 'plan_pg_abc' }),
    error => error.code === 'orchestration_plan_invalid'
  );
  assert.throws(
    () => orchestrationEngine.orchestrateDAG({ planId: 'plan_pc_missing' }),
    error => error.code === 'plan_missing'
  );
  const compiled = planCompiler.compilePlan({ mode: 'single', nodes: [{ key: 'n', taskType: 'memory.search', goal: 'g' }] });
  assert.throws(
    () =>
      orchestrationEngine.orchestrateDAG({
        planId: compiled.planId,
        definitions: [{ stepKey: 'a' }, { stepKey: 'b' }],
      }),
    error => error.code === 'orchestration_plan_invalid'
  );
  assert.equal(orchestrationEngine.getOrchestration('plan_pc_unknown'), null);
});

test('i. deliverPlanOutcome 幂等：重复调用不重复追加消息', async () => {
  resetAll();
  const resultDelivery = require('../server/agents/result-delivery');
  const parentSessionId = newParentSession();
  const first = resultDelivery.deliverPlanOutcome({
    planId: 'plan_pc_manual',
    botId: 'memory',
    parentSessionId,
    status: 'completed',
    result: { summary: '手工归约结果' },
  });
  assert.equal(first.delivered, true);
  const second = resultDelivery.deliverPlanOutcome({
    planId: 'plan_pc_manual',
    botId: 'memory',
    parentSessionId,
    status: 'completed',
    result: { summary: '手工归约结果' },
  });
  assert.equal(second.alreadyDelivered, true);
  const messages = sessions.getMessages(parentSessionId);
  assert.equal(messages.filter(message => message.id === 'bot-result-plan_pc_manual').length, 1);
});

test('j. HTTP：POST 编排 + GET 读回 + 未带令牌 401', async () => {
  resetAll();
  const compiled = planCompiler.compilePlan({ mode: 'single', nodes: [{ key: 'n', taskType: 'memory.search', goal: 'HTTP 编排场景' }] });
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
    const denied = await fetch(`${base}/agent-orchestrations`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ planId: compiled.planId }),
    });
    assert.equal(denied.status, 401);

    const created = await fetch(`${base}/agent-orchestrations`, {
      method: 'POST',
      headers: { authorization: 'Bearer test-token', 'content-type': 'application/json' },
      body: JSON.stringify({ planId: compiled.planId }),
    });
    assert.equal(created.status, 201);
    const createdBody = await created.json();
    assert.equal(createdBody.orchestration.status, 'running');

    const again = await fetch(`${base}/agent-orchestrations`, {
      method: 'POST',
      headers: { authorization: 'Bearer test-token', 'content-type': 'application/json' },
      body: JSON.stringify({ planId: compiled.planId }),
    });
    assert.equal(again.status, 200);
    const againBody = await again.json();
    assert.equal(againBody.idempotent, true);

    const readBack = await fetch(`${base}/agent-orchestrations/${compiled.planId}`, {
      headers: { authorization: 'Bearer test-token' },
    });
    assert.equal(readBack.status, 200);
    const missing = await fetch(`${base}/agent-orchestrations/plan_pc_none`, {
      headers: { authorization: 'Bearer test-token' },
    });
    assert.equal(missing.status, 404);
  } finally {
    server.close();
  }
});
