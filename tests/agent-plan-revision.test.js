/**
 * P5-C2 / A-13：计划修订闭环（plan-revision-v1）回归。
 *
 * 口径：
 *  a) 触发面：验证拒绝码（review_rejected 等）的终态失败 + 计划血缘才修订；
 *     散装任务 / 非验证失败不修订；
 *  b) 守卫：每计划最多 2 次修订（storm）、开放修订不重复、图未收敛不修订、
 *     head 版本不匹配不修订、缺 stepKey 不修订——全部先于任何落盘；
 *  c) 修订语义：migratePlanVersion 追加 v2（fencing 换代次），只重跑缺证节点，
 *     重跑任务绑定 v2、以真实 taskId 依赖已完成上游、上游产物显式 share；
 *  d) schema：PLAN_KEYS 扩展对旧计划 digest 零影响；
 *  e) stepKey 透传：planner → createTaskGraph → task 训录可映射回计划节点。
 */
const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');
const test = require('node:test');
const assert = require('node:assert');

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'bluebird-plan-revision-'));
process.env.BLUEBIRD_DATA_DIR = TMP;
process.env.DEEPSEEK_API_KEY = '';
process.env.BLUEBIRD_AGENT_TOOLS = '';
process.env.BLUEBIRD_MONITORING = '0';
process.env.BLUEBIRD_ALLOW_PRIVATE_BASE_URL = '1';

const tasks = require('../server/agents/tasks');
const runtime = require('../server/agents/runtime');
const workflowStore = require('../server/agents/workflow-store');
const planRevision = require('../server/agents/plan-revision');
const planner = require('../server/agents/planner');
const artifactStore = require('../server/agents/artifact-store');
const apiConfigs = require('../server/api-configs');
const agentConfig = require('../server/agents/config');
const credentials = require('../server/agents/credentials');
const { normalizeWorkerResult } = require('../server/agents/worker-result');

const AGENTS_DIR = path.join(TMP, 'agents');
// 本地 stub 的占位密钥：运行期生成，不落任何字面量（安全扫描口径）。
const STUB_KEY = `stub-${process.pid}-${Date.now()}`;

function resetAll() {
  fs.rmSync(AGENTS_DIR, { recursive: true, force: true });
  tasks.reloadForTests();
  planRevision.reloadForTests();
}

function isoAt(offsetMs = 0) {
  return new Date(Date.now() + offsetMs).toISOString();
}

function makeStep({ toolName, args, label, goal, capability, taskType, dependsOn = [] }) {
  return {
    stepKey: workflowStore.stepKeyFor({ toolName, args }),
    toolName,
    argsDigest: workflowStore.digestArgs(args),
    label,
    goal,
    capability,
    taskType,
    dependsOn,
  };
}

function makePlan(steps) {
  return {
    intent: 'agent_task_graph',
    enabled: true,
    layers: { history: false, retrieval: true, knowledge: false },
    budgets: {},
    noAnswerThreshold: 0,
    reasons: ['plan-revision-test'],
    steps,
    allowedTools: [],
    budget: null,
    goalDigest: null,
  };
}

function settleFailed(taskId, errorCode) {
  tasks.transitionTask(taskId, { to: 'accepted' });
  tasks.transitionTask(taskId, { to: 'running', startedAt: isoAt() });
  tasks.transitionTask(taskId, {
    to: 'failed',
    completedAt: isoAt(),
    errorCode,
    result: normalizeWorkerResult({
      status: 'failed',
      summary: '',
      errorCode,
      finishedAt: isoAt(),
    }),
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

let stubServer;
test.before(async () => {
  stubServer = http.createServer((req, res) => {
    if (req.method === 'GET' && req.url === '/v1/models') {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ data: [{ id: 'plan-revision-stub' }] }));
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
            model: 'plan-revision-stub',
            choices: [
              {
                index: 0,
                message: {
                  role: 'assistant',
                  content: '检索结论：示例条目已按目标核对（stub 一致回复）。',
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
    name: 'Plan Revision Stub',
    baseUrl: base,
    apiKey: STUB_KEY,
    models: [{ id: 'plan-revision-stub', capabilities: { tools: false, vision: false } }],
  });
  const providerId = added.provider.id;
  agentConfig.updateConfig('memory', {
    enabled: true,
    modelProfile: {
      providerId,
      modelId: 'plan-revision-stub',
      temperature: 0.1,
      maxTokens: 256,
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

test('a. plan schema 扩展 digest 中性：旧计划复读不损坏，publishGate 只在显式声明时参与 digest', () => {
  resetAll();
  const step = makeStep({
    toolName: 'memory.search',
    args: { goal: '旧计划一步', capability: 'memory.search', role: '检索' },
    label: '检索',
    goal: '旧计划一步',
    capability: 'memory.search',
    taskType: 'memory.search',
  });
  const base = makePlan([step]);
  const normalized = workflowStore.validatePlan(base);
  assert.ok(!('publishGate' in normalized), '未声明 publishGate 不得进入归一化输出');
  const saved = workflowStore.appendVersion({ plan: base });
  const readBack = workflowStore.getVersion(saved.planId, 1);
  assert.equal(readBack.digest, saved.digest, '旧版本复读 digest 必须一致');
  const withGate = workflowStore.validatePlan({
    ...base,
    publishGate: { required: true, taskType: 'memory.search' },
  });
  assert.equal(withGate.publishGate.required, true);
  assert.notEqual(workflowStore.digestPlan(normalized), workflowStore.digestPlan(withGate));
  assert.throws(
    () => workflowStore.validatePlan({ ...base, publishGate: { taskType: 'memory.search' } }),
    error => error.code === 'plan_invalid'
  );
  assert.throws(
    () => workflowStore.validatePlan({ ...base, publishGate: 'yes' }),
    error => error.code === 'plan_invalid'
  );
});

test('b. planner stepKey 透传：planAndCreate 的任务可映射回计划节点', () => {
  resetAll();
  const created = planner.planAndCreate({ goal: '检索一下之前保存的发票抬头' });
  const first = Object.values(created.tasks)[0];
  const raw = tasks.getRawTask(first.taskId);
  assert.equal(raw.stepKey, created.steps[0].stepKey);
  assert.equal(raw.planId, created.planId);
  assert.equal(raw.planVersion, created.planVersion);
});

test('c. 修订主链：验证拒绝终态 → v2 + 只重跑缺证节点 + 上游产物显式共享', async () => {
  resetAll();
  const step1 = makeStep({
    toolName: 'memory.search',
    args: { goal: '检索发票抬头', capability: 'memory.search', role: '检索' },
    label: '检索',
    goal: '检索发票抬头',
    capability: 'memory.search',
    taskType: 'memory.search',
  });
  const step2 = makeStep({
    toolName: 'memory.explain',
    args: { goal: '解释发票抬头', capability: 'memory.explain', role: '总结' },
    label: '总结',
    goal: '解释发票抬头',
    capability: 'memory.explain',
    taskType: 'memory.explain',
    dependsOn: [step1.stepKey],
  });
  const saved = workflowStore.appendVersion({ plan: makePlan([step1, step2]) });
  const T1 = tasks.createTask({
    botId: 'memory',
    taskType: 'memory.search',
    goal: '检索发票抬头',
    allowedTools: [],
    planId: saved.planId,
    planVersion: saved.planVersion,
    stepKey: step1.stepKey,
    deadlineMs: 30000,
  });
  runtime.startTask(T1.taskId);
  const doneT1 = await waitForStatus(T1.taskId, 'completed');
  assert.equal(doneT1.status, 'completed', `上游必须真实完成：${doneT1.errorCode}`);
  const T2 = tasks.createTask({
    botId: 'memory',
    taskType: 'memory.explain',
    goal: '解释发票抬头',
    allowedTools: [],
    planId: saved.planId,
    planVersion: saved.planVersion,
    stepKey: step2.stepKey,
    dependsOn: [T1.taskId],
    deadlineMs: 30000,
  });
  settleFailed(T2.taskId, 'review_rejected');

  const revision = planRevision.createRevision({
    failedTaskId: T2.taskId,
    reason: 'review_rejected',
  });
  assert.equal(revision.created, true);
  assert.equal(revision.fromVersion, 1);
  assert.equal(revision.toVersion, 2, '修订必须追加 v2');

  assert.equal(revision.rerunTaskIds.length, 1, '只重跑缺证节点');
  const rerun = tasks.getRawTask(revision.rerunTaskIds[0]);
  assert.ok(rerun, '重跑任务必须已创建');
  assert.equal(rerun.planVersion, 2, '重跑任务绑定 v2');
  assert.equal(rerun.stepKey, step2.stepKey, '重跑节点 = 失败节点');
  assert.deepEqual(rerun.dependsOn, [T1.taskId], '依赖解析为已完成上游的真实 taskId');

  const upstreamRefs = (doneT1.result && doneT1.result.artifacts) || [];
  assert.ok(upstreamRefs.length >= 1, '上游必须持有产物引用');
  for (const ref of upstreamRefs) {
    const artifact = artifactStore.get(ref.id);
    assert.ok(
      artifact.share &&
        Array.isArray(artifact.share.taskIds) &&
        artifact.share.taskIds.includes(rerun.taskId),
      `产物 ${ref.id} 必须共享给重跑任务`
    );
  }

  const record = planRevision.getRevision(revision.revisionId);
  assert.equal(record.status, 'created');
  assert.equal(record.policyVersion, 'plan-revision-v1');
  assert.deepEqual(record.failedTaskIds, [T2.taskId]);
  const events = tasks.listEvents('memory', { limit: 200 });
  const createdEvent = events.find(event => event.eventType === 'plan.revision_created');
  assert.ok(createdEvent, 'plan.revision_created 事件必须落审计');
  assert.equal(createdEvent.payload.planId, saved.planId);
  assert.equal(createdEvent.payload.toVersion, 2);
  assert.equal(createdEvent.payload.rerunCount, 1);
});

test('d. 守卫：散装任务/图未收敛/缺 stepKey/head 不匹配不修订', async () => {
  resetAll();
  const loose = tasks.createTask({
    botId: 'memory',
    taskType: 'memory.search',
    goal: '散装任务',
    deadlineMs: 30000,
  });
  assert.equal(planRevision.createRevision({ failedTaskId: loose.taskId }).reason, 'no_plan');

  const step = makeStep({
    toolName: 'memory.search',
    args: { goal: '守卫场景', capability: 'memory.search', role: '检索' },
    label: '检索',
    goal: '守卫场景',
    capability: 'memory.search',
    taskType: 'memory.search',
  });
  const saved = workflowStore.appendVersion({ plan: makePlan([step]) });

  const queuedTask = tasks.createTask({
    botId: 'memory',
    taskType: 'memory.search',
    goal: '守卫场景',
    allowedTools: [],
    planId: saved.planId,
    planVersion: saved.planVersion,
    stepKey: step.stepKey,
    deadlineMs: 30000,
  });
  const failedQueued = tasks.createTask({
    botId: 'memory',
    taskType: 'memory.search',
    goal: '守卫场景-失败',
    allowedTools: [],
    planId: saved.planId,
    planVersion: saved.planVersion,
    stepKey: step.stepKey,
    deadlineMs: 30000,
  });
  settleFailed(failedQueued.taskId, 'review_rejected');
  assert.equal(
    planRevision.createRevision({ failedTaskId: failedQueued.taskId }).reason,
    'plan_not_settled'
  );

  tasks.transitionTask(queuedTask.taskId, { to: 'accepted' });
  tasks.transitionTask(queuedTask.taskId, { to: 'cancelled', completedAt: isoAt() });
  const noStepKey = tasks.createTask({
    botId: 'memory',
    taskType: 'memory.search',
    goal: '守卫场景-无映射',
    allowedTools: [],
    planId: saved.planId,
    planVersion: saved.planVersion,
    deadlineMs: 30000,
  });
  settleFailed(noStepKey.taskId, 'review_rejected');
  assert.equal(
    planRevision.createRevision({ failedTaskId: noStepKey.taskId }).reason,
    'step_key_missing'
  );

  const mapped = tasks.createTask({
    botId: 'memory',
    taskType: 'memory.search',
    goal: '守卫场景-头版本',
    allowedTools: [],
    planId: saved.planId,
    planVersion: saved.planVersion,
    stepKey: step.stepKey,
    deadlineMs: 30000,
  });
  settleFailed(mapped.taskId, 'review_rejected');
  workflowStore.appendVersion({ plan: makePlan([step]), planId: saved.planId });
  assert.equal(
    planRevision.createRevision({ failedTaskId: mapped.taskId }).reason,
    'plan_head_mismatch'
  );
});

test('e. 守卫：修订上限 2 次 + 开放修订不重复（storm 守卫先于一切落盘）', async () => {
  resetAll();
  const step = makeStep({
    toolName: 'memory.search',
    args: { goal: '风暴守卫', capability: 'memory.search', role: '检索' },
    label: '检索',
    goal: '风暴守卫',
    capability: 'memory.search',
    taskType: 'memory.search',
  });
  const saved = workflowStore.appendVersion({ plan: makePlan([step]) });

  const makeFailed = goal =>
    tasks.createTask({
      botId: 'memory',
      taskType: 'memory.search',
      goal,
      allowedTools: [],
      planId: saved.planId,
      planVersion: saved.planVersion,
      stepKey: step.stepKey,
      deadlineMs: 30000,
    });

  const first = makeFailed('风暴守卫-1');
  settleFailed(first.taskId, 'review_rejected');
  const rev1 = planRevision.createRevision({ failedTaskId: first.taskId });
  assert.equal(rev1.created, true);
  assert.equal(
    planRevision.createRevision({ failedTaskId: first.taskId }).reason,
    'revision_in_flight'
  );

  const rerun1 = tasks.getRawTask(rev1.rerunTaskIds[0]);
  settleFailed(rerun1.taskId, 'review_rejected');
  // 修订链式触发：第二次修订从 v2 重跑任务发起（它才绑定当前 head v2）。
  const rev2 = planRevision.createRevision({ failedTaskId: rerun1.taskId });
  assert.equal(rev2.created, true);
  assert.equal(rev2.toVersion, 3);
  const rerun2 = tasks.getRawTask(rev2.rerunTaskIds[0]);
  settleFailed(rerun2.taskId, 'review_rejected');

  const denied = planRevision.createRevision({ failedTaskId: rerun2.taskId });
  assert.equal(denied.created, false);
  assert.equal(denied.reason, 'revision_limit');
  const stormEvent = tasks
    .listEvents('memory', { limit: 200 })
    .find(event => event.eventType === 'plan.revision_storm_denied');
  assert.ok(stormEvent, 'storm 守卫必须留事件');
  assert.equal(planRevision.listRevisions({ planId: saved.planId }).length, 2);
});
