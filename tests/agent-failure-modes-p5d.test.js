/**
 * P5-D / A-10 / §17：失败模式命名化（FM-1/2/3/5 + FM-6 收尾）回归。
 *
 * 口径：
 *  a) errors.js 清单升 v3：原文点名、此前未命名的四类必须入表，且处置动作
 *     仍只在 retry/recovery/terminal/escalate 四类里，不新增状态；
 *  b) 每条用例都从真实子系统注入（真实 runTask、真实确定性校验、真实
 *     createTask 委派链、真实 openReview 独立性闸门），再断言
 *     「识别为哪一类 + 走哪个处置 + 留了什么审计」；
 *  c) FM-4 已由 P5-C（failure-modes-v2）交付，本文件不重复实现；
 *  d) FM-6 只补「部分结果交付/请求决策」：失败终态的 result 必须带已完成
 *     部分的产物引用与缺口披露，而不是空 summary。
 */
const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');
const test = require('node:test');
const assert = require('node:assert');

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'bluebird-agent-failure-modes-p5d-'));
process.env.BLUEBIRD_DATA_DIR = TMP;
process.env.DEEPSEEK_API_KEY = '';
process.env.BLUEBIRD_AGENT_TOOLS = '';
process.env.BLUEBIRD_MONITORING = '0';
process.env.BLUEBIRD_ALLOW_PRIVATE_BASE_URL = '1';
process.env.BLUEBIRD_AGENT_HEARTBEAT_MS = '80';

const errors = require('../server/agents/errors');
const tasks = require('../server/agents/tasks');
const runtime = require('../server/agents/runtime');
const runtimeModule = require('../server/agents/runtime');
const verificationLoop = require('../server/agents/verification-loop');
const contextProjection = require('../server/agents/context-projection');
const manifestRegistry = require('../server/agents/manifest');
const artifactStore = require('../server/agents/artifact-store');

const AGENTS_DIR = path.join(TMP, 'agents');
let seq = 0;

function resetAll() {
  fs.rmSync(AGENTS_DIR, { recursive: true, force: true });
  tasks.reloadForTests();
  verificationLoop.setFaultInjection(null);
}

function makeTask(goal = 'P5-D 失败模式', extra = {}) {
  seq += 1;
  return tasks.createTask({
    botId: 'memory',
    taskType: 'memory.search',
    goal: `${goal} ${seq}`,
    allowedTools: ['memory_search'],
    deadlineMs: 20000,
    ...extra,
  });
}

function assertModeAndAction(errorCode, expectedMode, expectedAction) {
  const mode = errors.classifyFailureMode({ errorCode });
  assert.strictEqual(mode, expectedMode, `${errorCode} 应识别为 ${expectedMode}`);
  const disposition = errors.failureModeDisposition(mode);
  assert.strictEqual(disposition.action, expectedAction);
  assert.strictEqual(disposition.policyVersion, errors.FAILURE_MODE_POLICY_VERSION);
  return disposition;
}

function eventsOf(taskId, type) {
  const file = path.join(AGENTS_DIR, 'agent-events.json');
  if (!fs.existsSync(file)) return [];
  const parsed = JSON.parse(fs.readFileSync(file, 'utf8'));
  const list = Array.isArray(parsed.events) ? parsed.events : [];
  return list.filter(event => event.taskId === taskId && (!type || event.eventType === type));
}

const NON_TERMINAL = new Set(['queued', 'accepted', 'running', 'retrying', 'waiting_approval']);
async function waitForStatus(taskId, statuses, timeoutMs = 15000) {
  const deadline = Date.now() + timeoutMs;
  let task = null;
  while (Date.now() < deadline) {
    task = tasks.getTask(taskId);
    if (task && (statuses.includes(task.status) || tasks.isTerminalStatus(task.status))) {
      return task;
    }
    await new Promise(resolve => setTimeout(resolve, 25));
  }
  return task;
}

// ---- 真实模型桩：与 agent-fencing.test.js 同一套本地 Provider 模式 ----

let providerServer = null;
let providerCallSeq = 0;

async function setupProvider(mode = 'text') {
  if (providerServer) providerServer.close();
  providerCallSeq = 0;
  providerServer = http.createServer((req, res) => {
    let body = '';
    req.on('data', chunk => {
      body += chunk;
    });
    req.on('end', () => {
      const usage = { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 };
      const reply = (status, payload) => {
        res.writeHead(status, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify(payload));
      };
      // mode=rate_limit：恒 429，模拟模型调用层失败（无任何产物落盘）。
      if (mode === 'rate_limit') {
        reply(429, { error: { message: 'rate limited', type: 'rate_limit' } });
        return;
      }
      // 每次调用返回不同正文：产物 lineage 按 (taskId, kind, contentHash) 派生，
      // 相同正文会在「上一轮被 invalidate 后」撞同一个 id，轮次间必须可区分。
      providerCallSeq += 1;
      reply(200, {
        id: `chatcmpl-p5d-${providerCallSeq}`,
        object: 'chat.completion',
        created: Math.floor(Date.now() / 1000),
        model: 'p5d-test-model',
        choices: [
          {
            index: 0,
            message: { role: 'assistant', content: `P5-D 任务回复正文 #${providerCallSeq}` },
            finish_reason: 'stop',
          },
        ],
        usage,
      });
    });
  });
  await new Promise(resolve => providerServer.listen(0, '127.0.0.1', resolve));
  const base = `http://127.0.0.1:${providerServer.address().port}/v1`;

  const apiConfigs = require('../server/api-configs');
  const config = require('../server/agents/config');
  const credentials = require('../server/agents/credentials');
  const added = apiConfigs.addModelProvider({
    name: `P5D Test Provider ${Date.now()}`,
    baseUrl: base,
    apiKey: 'global-not-used',
    models: [{ id: 'p5d-test-model', name: 'P5D Test Model', capabilities: { tools: true } }],
  });
  assert.ok(added.provider, JSON.stringify(added));
  config.updateConfig('memory', {
    enabled: true,
    modelProfile: {
      providerId: added.provider.id,
      modelId: 'p5d-test-model',
      temperature: 0.2,
      maxTokens: 256,
      timeoutMs: 20000,
    },
  });
  const credential = credentials.putCredential({
    botId: 'memory',
    providerId: added.provider.id,
    apiKey: 'p5d-bot-key',
  });
  config.setCredentialId('memory', credential.credentialId);
}

test.after(() => {
  manifestRegistry.setTestManifests({});
  if (providerServer) providerServer.close();
  try {
    fs.rmSync(TMP, { recursive: true, force: true });
  } catch (_) {
    // ignore
  }
});

// ---- a. 清单 v3：四个新键、分类与处置 ----

test('P5-D 清单：FM-1/2/3/5 四类入表（v3），处置动作仍是既有四类', () => {
  const modes = Object.values(errors.FAILURE_MODES);
  assert.strictEqual(modes.length, 14);
  for (const key of ['role_drift', 'handoff_context_lost', 'delegation_privilege_escalation', 'verification_source_bias']) {
    assert.ok(modes.includes(key), `${key} 必须在清单里`);
    assert.ok(errors.FAILURE_MODE_LABELS[key], `${key} 必须有中文清单项`);
  }
  // FM-1 角色漂移：拒绝越界输出后缩小上下文重路由（retry，受 attempts 上限约束）。
  const drift = assertModeAndAction('verification_role_drift', 'role_drift', 'retry');
  assert.strictEqual(drift.retryable, true);
  assert.strictEqual(drift.errorCode, 'role_drift_reroute');
  // FM-2 交接上下文丢失：阻断执行 → recovery，不盲目重跑。
  const handoff = assertModeAndAction('handoff_context_missing', 'handoff_context_lost', 'recovery');
  assert.strictEqual(handoff.retryable, false);
  assert.strictEqual(handoff.status, 'recovery');
  // FM-3 委派链权限逐跳放大：创建期 fail-closed 拒绝，分类 terminal 供监控聚合。
  const escalation = assertModeAndAction(
    'delegation_permission_escalation',
    'delegation_privilege_escalation',
    'terminal'
  );
  assert.strictEqual(escalation.retryable, false);
  // FM-5 验证器同源偏差：同源 Reviewer 不采信、转人工（waiting_approval + review.escalate）。
  const bias = assertModeAndAction(
    'verification_review_not_independent',
    'verification_source_bias',
    'escalate'
  );
  assert.strictEqual(bias.retryable, false);
  assert.strictEqual(bias.status, 'waiting_approval');
  assert.strictEqual(bias.escalationOperation, 'review.escalate');
  // 裁决主体越权同样属于「共享错误来源」族。
  assert.strictEqual(
    errors.classifyFailureMode({ errorCode: 'arbiter_not_independent' }),
    'verification_source_bias'
  );
});

// ---- b. FM-1：role_scope 确定性检测 ----

test('P5-D FM-1 检测：任务缺失 / Manifest 撤除 / taskType 越界 / 结果字段越出 schema 都被 role_scope 拒绝', () => {
  resetAll();
  // 1) taskId 指向不存在的任务：无法核对职责边界，fail-closed。
  const missing = verificationLoop.verifyDeterministic({
    taskId: 'task_missing_p5d',
    result: { status: 'completed', summary: 'x', artifacts: [] },
  });
  assert.strictEqual(missing.ok, false);
  const missingCheck = missing.checks.find(item => item.name === 'role_scope');
  assert.strictEqual(missingCheck.ok, false);
  assert.strictEqual(missingCheck.code, 'verification_role_drift');

  // 2) Manifest 在创建后被撤除/变更：输出越出当前声明的职责。
  manifestRegistry.setTestManifests({
    drift_bot: {
      botId: 'drift_bot',
      acceptedTaskTypes: ['type.a'],
      toolAllowlist: ['tool_a'],
      taskContracts: {},
    },
  });
  const driftTask = tasks.createTask({
    botId: 'drift_bot',
    taskType: 'type.a',
    goal: '漂移检测任务',
    allowedTools: ['tool_a'],
  });
  const baseResult = { status: 'completed', summary: 'x', artifacts: [] };
  const before = verificationLoop.verifyDeterministic({
    taskId: driftTask.taskId,
    result: baseResult,
  });
  assert.strictEqual(before.ok, true, '职责边界内不得误报');
  manifestRegistry.setTestManifests({
    drift_bot: {
      botId: 'drift_bot',
      acceptedTaskTypes: ['type.b'],
      toolAllowlist: ['tool_a'],
      taskContracts: {},
    },
  });
  const after = verificationLoop.verifyDeterministic({
    taskId: driftTask.taskId,
    result: baseResult,
  });
  assert.strictEqual(after.ok, false);
  assert.strictEqual(
    after.failures.some(item => item.name === 'role_scope' && /taskType/.test(item.detail)),
    true,
    'taskType 越出 Manifest 受理范围必须被识别'
  );

  // 3) 结果字段越出统一 schema。
  manifestRegistry.setTestManifests({});
  const schemaTask = makeTask('schema 越界');
  const overflow = verificationLoop.verifyDeterministic({
    taskId: schemaTask.taskId,
    result: { status: 'completed', summary: 'x', artifacts: [], rogue_field: 1 },
  });
  assert.strictEqual(overflow.ok, false);
  assert.strictEqual(
    overflow.failures.some(item => item.name === 'role_scope' && /rogue_field/.test(item.detail)),
    true
  );
  // 白名单内字段不得误报。
  const clean = verificationLoop.verifyDeterministic({
    taskId: schemaTask.taskId,
    result: { status: 'completed', summary: 'x', artifacts: [], runId: 'run_x', finishedAt: 'now' },
  });
  const cleanRole = clean.checks.find(item => item.name === 'role_scope');
  assert.strictEqual(cleanRole.ok, true);
});

// ---- c. FM-3：委派链权限逐跳放大 ----

test('P5-D FM-3：父窄子宽拒绝且零落盘；省略声明继承收窄；交集内放行', () => {
  resetAll();
  const before = Object.keys(tasks.rawTasksById()).length;
  const parent = makeTask('父任务（窄授权）');
  assert.strictEqual(parent.allowedTools.join(','), 'memory_search');

  // 子任务显式声明父任务没有的工具 → fail-closed 拒绝。
  assert.throws(
    () =>
      tasks.createTask({
        botId: 'memory',
        taskType: 'memory.explain',
        goal: '子任务越权',
        allowedTools: ['memory_search', 'memory_remember'],
        parentTaskId: parent.taskId,
      }),
    error => {
      assert.strictEqual(error.code, 'delegation_permission_escalation');
      assert.strictEqual(error.status, 403);
      const disposition = assertModeAndAction(
        error.code,
        'delegation_privilege_escalation',
        'terminal'
      );
      assert.strictEqual(disposition.status, 'failed');
      return true;
    }
  );
  assert.strictEqual(
    Object.keys(tasks.rawTasksById()).length,
    before + 1,
    '拒绝后只多出父任务本身，零落盘'
  );

  // 子任务省略 allowedTools → 默认授权必须落在父任务授权交集内（不能靠不声明放大）。
  const implicit = tasks.createTask({
    botId: 'memory',
    taskType: 'memory.explain',
    goal: '子任务省略声明',
    parentTaskId: parent.taskId,
  });
  assert.strictEqual(implicit.allowedTools.join(','), 'memory_search');

  // 交集内的显式声明放行。
  const inside = tasks.createTask({
    botId: 'memory',
    taskType: 'memory.explain',
    goal: '子任务在交集内',
    allowedTools: ['memory_search'],
    parentTaskId: parent.taskId,
  });
  assert.strictEqual(inside.parentTaskId, parent.taskId);

  // 父任务未显式收窄（全量白名单）时维持既有行为。
  const openParent = tasks.createTask({
    botId: 'memory',
    taskType: 'memory.search',
    goal: '父任务（全量授权）',
  });
  const openChild = tasks.createTask({
    botId: 'memory',
    taskType: 'memory.explain',
    goal: '全量父任务下的子任务',
    allowedTools: ['memory_remember'],
    parentTaskId: openParent.taskId,
  });
  assert.strictEqual(openChild.allowedTools.join(','), 'memory_remember');
});

// ---- d. FM-2：validateHandoff 纯函数（缺失阻断 / 引用重建 / 纯文本 fail-closed） ----

test('P5-D FM-2 纯函数：必需约束缺失阻断、可从已验证引用重建、纯文本 context 不算数', () => {
  resetAll();
  // 无声明 → 直接放行（既有任务不受影响）。
  const plain = { taskId: 'task_x', goal: 'g', context: '随便什么文本' };
  assert.strictEqual(contextProjection.validateHandoff({ task: plain }).ok, true);

  // 声明了必需约束、context 是纯文本 → 无法承载具名约束，判缺失。
  const declared = { ...plain, requiredContextKeys: ['decision'] };
  const blocked = contextProjection.validateHandoff({ task: declared });
  assert.strictEqual(blocked.ok, false);
  assert.deepStrictEqual(blocked.missing, ['decision']);
  assert.strictEqual(blocked.errorCode, 'handoff_context_missing');

  // context 是 JSON 对象字符串且带键 → 放行。
  const carried = {
    ...declared,
    context: JSON.stringify({ decision: '使用已验证的 A1 结论' }),
  };
  const okCarried = contextProjection.validateHandoff({ task: carried });
  assert.strictEqual(okCarried.ok, true);
  assert.strictEqual(okCarried.rebuilt, false);

  // context 缺键但 contextRef 已验证产物可解析 → 重建放行并标注来源。
  const rebuilt = contextProjection.validateHandoff({
    task: { ...declared, contextRef: 'art_ctx_1' },
    resolveContextRef: () => ({ content: { decision: '来自产物' } }),
  });
  assert.strictEqual(rebuilt.ok, true);
  assert.strictEqual(rebuilt.rebuilt, true);
  assert.strictEqual(rebuilt.rebuiltFrom, 'art_ctx_1');
  assert.deepStrictEqual(rebuilt.rebuiltObject, { decision: '来自产物' });

  // contextRef 不可读 → 重建失败，保持缺失（fail-closed）。
  const brokenRef = contextProjection.validateHandoff({
    task: { ...declared, contextRef: 'art_missing' },
    resolveContextRef: () => {
      throw new Error('read failed');
    },
  });
  assert.strictEqual(brokenRef.ok, false);
  assert.strictEqual(brokenRef.rebuilt, false);

  // 部分重建：引用只补上一半 → 仍判缺失。
  const half = contextProjection.validateHandoff({
    task: { ...declared, requiredContextKeys: ['decision', 'owner'], contextRef: 'art_ctx_2' },
    resolveContextRef: () => ({ content: { decision: '来自产物' } }),
  });
  assert.strictEqual(half.ok, false);
  assert.deepStrictEqual(half.missing, ['owner']);
});

// ---- e. FM-2：真实 runTask（缺失 → recovery + 零模型调用；重建 → 审计后完成） ----

test('P5-D FM-2 真实链路：缺必需约束的任务不启动（recovery、零模型调用、留审计）', async () => {
  resetAll();
  const task = makeTask('必需约束缺失', {
    context: '这段是纯文本，承载不了具名约束',
    requiredContextKeys: ['decision'],
  });
  runtime.startTask(task.taskId);
  const finished = await waitForStatus(task.taskId, ['recovery']);
  assert.ok(finished, '任务应收敛');
  assert.strictEqual(finished.status, 'recovery');
  assert.strictEqual(finished.errorCode, 'handoff_context_missing');
  assert.strictEqual(eventsOf(task.taskId, 'model.requested').length, 0, '模型零调用');
  const failedEvent = eventsOf(task.taskId, 'task.failed').find(
    item => item.payload && item.payload.failureMode === 'handoff_context_lost'
  );
  assert.ok(failedEvent, '失败事件必须带 handoff_context_lost 分类');
});

test('P5-D FM-2 真实链路：缺失键从已验证引用重建后放行并留 handoff.context_rebuilt', async () => {
  resetAll();
  await setupProvider('text');
  const ctx = artifactStore.persist({
    kind: 'context',
    content: { decision: '使用已验证的 A1 结论' },
    taskId: 'task_ctx_source',
  });
  const task = makeTask('必需约束可重建', {
    context: '',
    contextRef: ctx.id,
    requiredContextKeys: ['decision'],
  });
  runtime.startTask(task.taskId);
  const finished = await waitForStatus(task.taskId, ['completed']);
  assert.ok(finished, JSON.stringify(finished && finished.errorCode));
  assert.strictEqual(finished.status, 'completed');
  const rebuiltEvent = eventsOf(task.taskId, 'handoff.context_rebuilt').find(
    item => item.payload && item.payload.rebuilt === true
  );
  assert.ok(rebuiltEvent, '重建必须留 handoff.context_rebuilt 审计');
  assert.strictEqual(rebuiltEvent.payload.rebuiltFrom, ctx.id);
});

// ---- f. FM-5：同源偏差命名化与转人工 ----

test('P5-D FM-5：同源 Producer 不得自查自批（409）、分类为 escalate、planGate 转人工不静默通过', () => {
  resetAll();
  const producer = tasks.createTask({
    botId: 'reviewer',
    taskType: 'review.verify',
    goal: '同源自审任务',
    allowedTools: ['memory_search'],
  });
  assert.throws(
    () =>
      verificationLoop.openReview({
        producerTaskId: producer.taskId,
        artifactRef: { id: 'art_any', kind: 'message', version: 1 },
      }),
    error => {
      assert.strictEqual(error.code, 'verification_review_not_independent');
      assert.strictEqual(error.status, 409);
      return true;
    }
  );
  // 审校不可用保留真实短码后，resolveConflict → planGate 必须转人工而不是通过。
  const resolution = verificationLoop.planGate({
    deterministic: { ok: true, errorCode: null },
    review: {
      decision: 'needs_human',
      valid: false,
      code: 'verification_review_not_independent',
      evidence: [],
    },
    task: { allowedTools: ['memory_search'] },
  });
  assert.strictEqual(resolution.action, 'approval', '同源偏差必须落在人工审批节点');
  assert.strictEqual(resolution.errorCode, 'verification_review_not_independent');
});

// ---- g. FM-1 真实链路：越界输出被拒 → 缩小上下文重路由，不产出成功结果 ----

test('P5-D FM-1 真实链路：确定性校验拒绝越界输出 → 缩上下文重路由 → 终态不产出成功结果', async () => {
  resetAll();
  await setupProvider('text');
  verificationLoop.setFaultInjection({ deterministic: 'verification_role_drift' });
  // attempts 在运行开始时即计入当次，maxAttempts=1 永不重试；给 2 才有重路由。
  process.env.BLUEBIRD_AGENT_TASK_MAX_ATTEMPTS = '2';
  try {
    const task = makeTask('角色漂移重路由', { context: '越界输出所依据的上下文' });
    runtime.startTask(task.taskId);
    const retried = await waitForStatus(task.taskId, ['retrying']);
    assert.ok(retried, '第一次失败后应进入重试');
    // 缩小上下文：重路由前把自由文本 context 置空，只保留 goal 与已验证引用。
    // （publicTask 不投影 context，读 raw 记录核对。）
    assert.strictEqual(
      tasks.getRawTask(task.taskId).context,
      '',
      '重路由必须缩小上下文'
    );
    const recovered = eventsOf(task.taskId, 'task.recovered').filter(
      item =>
        item.payload &&
        item.payload.errorCode === 'verification_role_drift' &&
        item.payload.failureMode === 'role_drift'
    );
    assert.ok(recovered.length >= 1, '重路由必须留 task.recovered 审计');
    // 手动触发重路由后的第二次运行（retryAt 有 1s 退避，过期后再直派）。
    await new Promise(resolve => setTimeout(resolve, 1200));
    runtime.startTask(task.taskId);
    const finished = await waitForStatus(task.taskId, ['failed']);
    assert.ok(finished, JSON.stringify(finished && finished.errorCode));
    assert.strictEqual(finished.status, 'failed', '越界输出不得收敛为 completed');
    assert.strictEqual(finished.errorCode, 'verification_role_drift');
    // 不产出成功结果：没有 task.completed 事件。
    assert.strictEqual(eventsOf(task.taskId, 'task.completed').length, 0);
  } finally {
    verificationLoop.setFaultInjection(null);
    process.env.BLUEBIRD_AGENT_TASK_MAX_ATTEMPTS = '1';
  }
});

// ---- h. FM-6 真实链路：达上限交付部分结果并披露缺口；无可交付时请求决策 ----

test('P5-D FM-6 真实链路：两段提交中断 → 收口的 result 带已完成部分结果与缺口披露，而不是空 summary', async () => {
  resetAll();
  await setupProvider('text');
  // 注入点选在两段提交的第二段：persistTaskArtifacts 已把产物落成
  // pending-commit，completeTask 失败 → catch 收口时这些产物既没被 invalidate
  // （验证是过的）也没被提交——正是「已完成部分」的唯一真实来源。
  // 验证失败路径的产物会被 invalidateArtifactRefs 拒掉，不该出现在部分结果里。
  const artifactCommit = require('../server/agents/artifact-commit');
  const originalComplete = artifactCommit.completeTask;
  artifactCommit.completeTask = () => {
    throw new errors.AgentError('artifact_commit_failed', '注入的状态提交失败', 500);
  };
  try {
    const task = makeTask('部分结果交付');
    runtime.startTask(task.taskId);
    const finished = await waitForStatus(task.taskId, ['recovery', 'failed']);
    assert.ok(finished, JSON.stringify(finished && finished.errorCode));
    assert.strictEqual(finished.errorCode, 'artifact_commit_failed');
    assert.ok(finished.result, '失败收口也要落结果对象');
    assert.ok(finished.result.summary.includes('部分结果'), 'summary 必须披露部分结果');
    assert.ok(
      finished.result.summary.includes('未完成'),
      'summary 必须披露缺口而不是伪装完成'
    );
    assert.ok(finished.result.artifacts.length >= 1, '必须引用已完成的产物');
    assert.strictEqual(
      artifactStore.get(finished.result.artifacts[0].id).commit,
      'pending-commit',
      '部分结果就是留在 pending-commit 的已完成产物'
    );
    const failedEvent = eventsOf(task.taskId, 'task.failed').find(
      item => item.payload && item.payload.partialCount >= 1
    );
    assert.ok(failedEvent, '失败事件必须带 partialCount');
  } finally {
    artifactCommit.completeTask = originalComplete;
    verificationLoop.setFaultInjection(null);
  }
});

test('P5-D FM-6 真实链路：无可交付部分结果且重试被拦 → 落 task.decision_requested', async () => {
  resetAll();
  await setupProvider('rate_limit');
  const task = makeTask('请求决策');
  runtime.startTask(task.taskId);
  const finished = await waitForStatus(task.taskId, ['failed']);
  assert.ok(finished, JSON.stringify(finished && finished.errorCode));
  assert.strictEqual(finished.status, 'failed');
  assert.strictEqual(finished.result.artifacts.length, 0, '模型层失败没有任何产物');
  const requested = eventsOf(task.taskId, 'task.decision_requested').filter(
    item => item.payload && item.payload.decisionRequested === true
  );
  assert.ok(requested.length >= 1, '重试被拦且无可交付时必须请求决策');
});

// runtimeModule 引用保持与既有测试文件一致的加载顺序（无实际断言消费）。
void runtimeModule;
