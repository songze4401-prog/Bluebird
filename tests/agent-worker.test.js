/* global require, process, __dirname */
/**
 * 阶段 2 Worker Runtime 回归。
 *
 * 覆盖：上下文按需投影、统一结果 schema、工具权限网关与审计、Worker 会话
 * 归属/作用域/生命周期、runId/心跳/checkpoint、取消/超时/模型失败终态、
 * 并发隔离与单 Worker 异常隔离。使用真实 HTTP stub Provider，不依赖外部模型。
 */
const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');
const test = require('node:test');
const assert = require('node:assert');

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'bluebird-agent-worker-'));
process.env.BLUEBIRD_DATA_DIR = TMP;
process.env.DEEPSEEK_API_KEY = '';
process.env.BLUEBIRD_AGENT_TOOLS = '';
process.env.BLUEBIRD_MONITORING = '0';
process.env.BLUEBIRD_ALLOW_PRIVATE_BASE_URL = '1';
process.env.BLUEBIRD_AGENT_HEARTBEAT_MS = '40';

const { projectWorkerContext } = require('../server/agents/context-projection');
const { normalizeWorkerResult } = require('../server/agents/worker-result');
const { createToolAuthorizer } = require('../server/agents/tool-gateway');
const sessions = require('../server/agents/sessions');
const tasks = require('../server/agents/tasks');
const runtime = require('../server/agents/runtime');

let providerServer;
let providerBase;
let providerId;
let pendingTimers = [];

function json(res, status, payload) {
  res.writeHead(status, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify(payload));
}

function lastUserText(messages) {
  return String((messages.at(-1) || {}).content || '');
}

function taskGoal(messages) {
  const match = lastUserText(messages).match(/目标：(.+)/);
  return match ? match[1].trim() : '';
}

function delayedReply(res, delayMs, payload) {
  const timer = setTimeout(() => {
    if (!res.writableEnded) json(res, 200, payload);
  }, delayMs);
  pendingTimers.push(timer);
}

function completion(content) {
  return {
    id: `chatcmpl-${Date.now()}`,
    object: 'chat.completion',
    created: Math.floor(Date.now() / 1000),
    model: 'worker-test-model',
    choices: [
      {
        index: 0,
        message: { role: 'assistant', content },
        finish_reason: 'stop',
      },
    ],
    usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
  };
}

test.before(async () => {
  providerServer = http.createServer((req, res) => {
    if (req.method === 'GET' && req.url === '/v1/models') {
      if (req.headers.authorization !== 'Bearer worker-bot-key') {
        json(res, 401, { error: 'unauthorized' });
        return;
      }
      json(res, 200, { data: [{ id: 'worker-test-model' }] });
      return;
    }
    if (req.method !== 'POST' || req.url !== '/v1/chat/completions') {
      json(res, 404, { error: 'not_found' });
      return;
    }
    if (req.headers.authorization !== 'Bearer worker-bot-key') {
      json(res, 401, { error: 'unauthorized' });
      return;
    }
    let body = '';
    req.on('data', chunk => {
      body += chunk;
    });
    req.on('end', () => {
      const parsed = JSON.parse(body);
      const messages = parsed.messages || [];
      const text = lastUserText(messages);
      const hasToolResult = messages.some(message => message.role === 'tool');
      if (text.includes('FAIL_TASK')) {
        json(res, 500, { error: 'provider_failed' });
        return;
      }
      if (text.includes('TOOL_DENY') && !hasToolResult) {
        json(res, 200, {
          id: 'chatcmpl-denied-tool',
          object: 'chat.completion',
          created: Math.floor(Date.now() / 1000),
          model: 'worker-test-model',
          choices: [
            {
              index: 0,
              message: {
                role: 'assistant',
                content: null,
                tool_calls: [
                  {
                    id: 'call_knowledge_search',
                    type: 'function',
                    function: {
                      name: 'knowledge_search',
                      arguments: JSON.stringify({ query: '咖啡' }),
                    },
                  },
                ],
              },
              finish_reason: 'tool_calls',
            },
          ],
          usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
        });
        return;
      }
      const payload = completion(`已处理：${taskGoal(messages)}`);
      if (text.includes('ULTRA_SLOW')) {
        delayedReply(res, 6000, payload);
        return;
      }
      if (text.includes('SLOW_TASK')) {
        delayedReply(res, 400, payload);
        return;
      }
      json(res, 200, payload);
    });
  });
  await new Promise(resolve => providerServer.listen(0, '127.0.0.1', resolve));
  providerBase = `http://127.0.0.1:${providerServer.address().port}/v1`;

  const apiConfigs = require('../server/api-configs');
  const config = require('../server/agents/config');
  const credentials = require('../server/agents/credentials');
  const added = apiConfigs.addModelProvider({
    name: 'Worker Test Provider',
    baseUrl: providerBase,
    apiKey: 'global-not-used',
    models: [
      {
        id: 'worker-test-model',
        name: 'Worker Test Model',
        capabilities: { tools: true, vision: false },
      },
    ],
  });
  assert.ok(added.provider, JSON.stringify(added));
  providerId = added.provider.id;
  config.updateConfig('memory', {
    enabled: true,
    modelProfile: {
      providerId,
      modelId: 'worker-test-model',
      temperature: 0.2,
      maxTokens: 256,
      timeoutMs: 20000,
    },
  });
  const credential = credentials.putCredential({
    botId: 'memory',
    providerId,
    apiKey: 'worker-bot-key',
  });
  config.setCredentialId('memory', credential.credentialId);
});

test.after(async () => {
  for (const timer of pendingTimers) clearTimeout(timer);
  pendingTimers = [];
  if (providerServer) {
    if (typeof providerServer.closeAllConnections === 'function') {
      providerServer.closeAllConnections();
    }
    await new Promise(resolve => providerServer.close(resolve));
  }
  try {
    fs.rmSync(TMP, { recursive: true, force: true });
  } catch (_) {
    // ignore
  }
});

async function waitForTask(taskId, timeoutMs = 15000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const task = tasks.getTask(taskId);
    if (task && tasks.isTerminalStatus(task.status)) return task;
    await new Promise(resolve => setTimeout(resolve, 25));
  }
  return tasks.getTask(taskId);
}

function makeTask(overrides = {}) {
  return tasks.createTask({
    botId: 'memory',
    taskType: 'memory.search',
    goal: '普通检索任务',
    allowedTools: ['memory_search'],
    deadlineMs: 20000,
    ...overrides,
  });
}

// ---- A. 上下文按需投影 ----

test('投影：只给 system + 一条任务指令，不复制主控历史', () => {
  const projection = projectWorkerContext({
    task: {
      taskId: 'task_projection',
      contractVersion: 1,
      taskType: 'memory.search',
      goal: '查咖啡偏好',
      context: '只返回与咖啡相关的记忆',
      contextRef: 'session:s1#message:m1',
      allowedTools: ['memory_search'],
      parentSessionId: 's_main',
      workerSessionId: 'bs_worker',
      parentUserText: '',
      route: { path: 'fast' },
      budget: { maxRounds: 3, maxToolCalls: 6, maxReadOnlyRetries: 1 },
    },
    systemPrompt: '你是 Memory Bot',
  });
  assert.equal(projection.messages.length, 2);
  assert.equal(projection.messages[0].role, 'system');
  assert.equal(projection.messages[1].role, 'user');
  assert.match(projection.messages[1].content, /查咖啡偏好/);
  assert.match(projection.messages[1].content, /只返回与咖啡相关的记忆/);
  assert.match(projection.messages[1].content, /上下文引用：session:s1#message:m1/);
  assert.equal(projection.memoryScopeSessionId, 's_main');
  assert.deepEqual(projection.authorization.allowedTools, ['memory_search']);
  assert.equal(projection.authorization.path, 'fast');
});

test('投影：写入接地优先使用主控用户原话', () => {
  const base = {
    taskId: 'task_grounding',
    taskType: 'memory.search',
    goal: '整理偏好',
    allowedTools: [],
    parentUserText: '我喜欢浅烘咖啡',
    workerSessionId: 'bs_worker',
    parentSessionId: null,
  };
  const withUserText = projectWorkerContext({ task: base, systemPrompt: 's' });
  assert.equal(withUserText.userText, '我喜欢浅烘咖啡');
  const withoutUserText = projectWorkerContext({
    task: { ...base, parentUserText: '' },
    systemPrompt: 's',
  });
  assert.equal(withoutUserText.userText, '整理偏好');
});

test('投影：任务没有父会话时记忆 scope 回落到 Worker 会话', () => {
  const projection = projectWorkerContext({
    task: {
      taskId: 'task_scope',
      taskType: 'memory.search',
      goal: 'x',
      allowedTools: [],
      parentSessionId: null,
      workerSessionId: 'bs_scope',
    },
    systemPrompt: 's',
  });
  assert.equal(projection.memoryScopeSessionId, 'bs_scope');
});

// ---- B. 统一结果 schema ----

test('结果 schema：completed 含全部稳定字段', () => {
  const result = normalizeWorkerResult({
    status: 'completed',
    summary: '完成',
    toolSteps: [{ name: 'memory_search', ok: true, summary: 'ok', durationMs: 3 }],
    evidence: [{ kind: 'memory', id: 'm1' }],
    requiresConfirmation: true,
    rounds: 2,
    stopReason: 'final',
    model: { providerId: 'p', modelId: 'm' },
    runId: 'run_1',
    finishedAt: '2026-11-01T00:00:00.000Z',
  });
  assert.equal(result.status, 'completed');
  assert.equal(result.summary, '完成');
  assert.equal(result.requiresApproval, true);
  assert.equal(result.requiresConfirmation, true);
  assert.equal(result.runId, 'run_1');
  assert.equal(result.finishedAt, '2026-11-01T00:00:00.000Z');
  assert.equal(result.toolSteps[0].ok, true);
  assert.equal(result.evidence[0].kind, 'memory');
});

test('结果 schema：failed / cancelled / timed_out 保留状态与错误码', () => {
  for (const status of ['failed', 'cancelled', 'timed_out']) {
    const result = normalizeWorkerResult({ status, errorCode: 'some_code', runId: 'run_x' });
    assert.equal(result.status, status);
    assert.equal(result.errorCode, 'some_code');
    assert.equal(result.summary, '');
    assert.equal(result.requiresApproval, false);
  }
});

test('结果 schema：非法状态直接拒绝', () => {
  assert.throws(() => normalizeWorkerResult({ status: 'running' }), TypeError);
});

// ---- C. 工具权限网关 ----

test('网关：任务白名单之外的工具有明确短码', () => {
  const authorize = createToolAuthorizer({ allowedTools: ['memory_search'] });
  assert.deepEqual(authorize('knowledge_search'), {
    ok: false,
    code: 'task_tool_denied',
  });
});

test('网关：策略 answer_only 拒绝所有工具', () => {
  const authorize = createToolAuthorizer({
    allowedTools: ['memory_search'],
    policy: { mode: 'answer_only', tools: { allowedTools: null } },
  });
  assert.equal(authorize('memory_search').code, 'policy_tool_denied');
});

test('网关：策略白名单进一步收窄', () => {
  const authorize = createToolAuthorizer({
    allowedTools: ['memory_search', 'knowledge_search'],
    policy: { mode: 'bounded_autonomy', tools: { allowedTools: ['memory_search'] } },
  });
  assert.equal(authorize('knowledge_search').code, 'policy_tool_denied');
  assert.equal(authorize('memory_search').ok, true);
});

// ---- D. Worker 会话：owner / 作用域 / 生命周期 ----

test('会话：新建 Worker 会话带作用域与初始生命周期', () => {
  const session = sessions.createSession('memory', { title: 'worker', scope: 'worker' });
  assert.equal(session.scope, 'worker');
  assert.equal(session.owner, null);
  assert.equal(session.lifecycle.status, 'active');
  assert.equal(session.lifecycle.closedAt, null);
});

test('会话：绑定 owner 后可按任务校验，其他任务被拒绝', () => {
  const session = sessions.createSession('memory', { title: 'owner', scope: 'worker' });
  sessions.attachOwner('memory', session.id, { agentId: 'memory', taskId: 'task_a' });
  const bound = sessions.getSession('memory', session.id);
  assert.equal(bound.owner.taskId, 'task_a');
  assert.equal(bound.scope, 'worker');
  assert.throws(
    () => sessions.assertWorkerSession('memory', session.id, 'task_b'),
    error => error && error.code === 'worker_session_owner_mismatch'
  );
  assert.equal(
    sessions.assertWorkerSession('memory', session.id, 'task_a').id,
    session.id
  );
});

test('会话：允许显式接管（调用方已确认原任务终态）', () => {
  const session = sessions.createSession('memory', { title: 'takeover', scope: 'worker' });
  sessions.attachOwner('memory', session.id, { agentId: 'memory', taskId: 'task_a' });
  sessions.attachOwner('memory', session.id, {
    agentId: 'memory',
    taskId: 'task_b',
    allowTakeover: true,
  });
  assert.equal(sessions.getSession('memory', session.id).owner.taskId, 'task_b');
});

test('会话：缺失的 Worker 会话有明确错误', () => {
  assert.throws(
    () => sessions.assertWorkerSession('memory', 'bs_missing', 'task_x'),
    error => error && error.code === 'worker_session_missing'
  );
});

test('会话：markRunning / closeSession 写生命周期时间点', () => {
  const session = sessions.createSession('memory', { title: 'life', scope: 'worker' });
  const running = sessions.markRunning('memory', session.id, 'run_1');
  assert.equal(running.lifecycle.status, 'running');
  assert.ok(running.lifecycle.startedAt);
  const closed = sessions.closeSession('memory', session.id, {
    status: 'completed',
    reason: null,
  });
  assert.equal(closed.lifecycle.status, 'completed');
  assert.ok(closed.lifecycle.closedAt);
});

test('会话：旧会话读取时补齐 scope/owner/lifecycle', () => {
  const file = path.join(TMP, 'agents', 'agent-sessions.json');
  const store = JSON.parse(fs.readFileSync(file, 'utf8'));
  store.sessions.push({
    id: 'bs_legacy',
    botId: 'memory',
    title: '旧会话',
    createdAt: '2026-10-01T00:00:00.000Z',
    updatedAt: '2026-10-01T00:00:00.000Z',
  });
  store.messages.bs_legacy = [];
  fs.writeFileSync(file, JSON.stringify(store, null, 2));
  sessions.reloadForTests();
  const legacy = sessions.getSession('memory', 'bs_legacy');
  assert.equal(legacy.scope, 'direct');
  assert.equal(legacy.owner, null);
  assert.equal(legacy.lifecycle.status, 'active');
});

// ---- E. 任务运行期元数据与结果落库 ----

test('任务：运行期字段初始为空，checkpoint 可按结构落库', () => {
  const task = makeTask({ goal: '运行期字段' });
  assert.equal(task.runId, null);
  assert.equal(task.runStartedAt, null);
  assert.equal(task.heartbeatAt, null);
  assert.equal(task.checkpoint, null);
  const updated = tasks.updateTask(task.taskId, {
    checkpoint: { round: 2, toolCalls: 1, phase: 'tool_result', at: '2026-11-01T00:00:00.000Z' },
    heartbeatAt: '2026-11-01T00:00:01.000Z',
  });
  assert.equal(updated.checkpoint.round, 2);
  assert.equal(updated.checkpoint.phase, 'tool_result');
  assert.equal(updated.heartbeatAt, '2026-11-01T00:00:01.000Z');
});

test('任务：结果落库包含统一 schema 字段', () => {
  const task = makeTask({ goal: '结果落库' });
  const result = normalizeWorkerResult({
    status: 'failed',
    errorCode: 'model_server',
    runId: 'run_store',
    finishedAt: '2026-11-01T00:00:02.000Z',
  });
  const updated = tasks.transitionTask(task.taskId, {
    to: 'accepted',
  });
  tasks.transitionTask(task.taskId, {
    to: 'failed',
    errorCode: 'model_server',
    result,
  });
  const failedTask = tasks.getTask(task.taskId);
  assert.equal(failedTask.result.status, 'failed');
  assert.equal(failedTask.result.errorCode, 'model_server');
  assert.equal(failedTask.result.runId, 'run_store');
  assert.equal(failedTask.result.finishedAt, '2026-11-01T00:00:02.000Z');
  assert.equal(failedTask.result.requiresApproval, false);
  assert.equal(updated.checkpoint, null);
});

test('任务：运行开始可为旧任务补建 Worker 会话且不改写已有会话', () => {
  const task = makeTask({ goal: '补会话' });
  tasks.updateTask(task.taskId, { workerSessionId: 'bs_filled', sessionId: 'bs_filled' });
  assert.equal(tasks.getTask(task.taskId).sessionId, 'bs_filled');
  tasks.updateTask(task.taskId, { workerSessionId: 'bs_other', sessionId: 'bs_other' });
  assert.equal(tasks.getTask(task.taskId).sessionId, 'bs_filled');
});

// ---- F. 真实执行：生命周期、终态、审计与并发隔离 ----

test('执行：完成态写入 runId、checkpoint、心跳与统一结果，并收口会话', async () => {
  const task = makeTask({ goal: 'SLOW_TASK 完成态任务' });
  runtime.startTask(task.taskId);
  const finished = await waitForTask(task.taskId);
  assert.equal(finished.status, 'completed');
  assert.match(finished.runId, /^run_/);
  assert.ok(finished.runStartedAt);
  assert.ok(finished.heartbeatAt);
  assert.ok(finished.checkpoint);
  assert.equal(finished.lease, null);
  assert.ok(finished.checkpointVersion >= 1);
  assert.equal(finished.runs.length, 1);
  assert.equal(finished.runs[0].runId, finished.runId);
  assert.equal(finished.runs[0].status, 'completed');
  assert.equal(finished.result.status, 'completed');
  assert.equal(finished.result.runId, finished.runId);
  assert.ok(finished.result.finishedAt);
  assert.equal(finished.result.requiresApproval, false);
  assert.equal(finished.result.summary, '已处理：SLOW_TASK 完成态任务');

  const session = sessions.getSession('memory', finished.sessionId);
  assert.equal(session.owner.taskId, task.taskId);
  assert.equal(session.lifecycle.status, 'completed');
  assert.ok(session.lifecycle.closedAt);

  const events = tasks.listEvents('memory', { limit: 200 });
  assert.ok(
    events.some(
      event => event.taskId === task.taskId && event.eventType === 'worker.checkpoint'
    )
  );
  assert.ok(
    events.some(
      event => event.taskId === task.taskId && event.eventType === 'worker.heartbeat'
    )
  );
});

test('执行：模型失败收敛为 failed，并落地失败结果', async () => {
  const task = makeTask({ goal: 'FAIL_TASK 模型失败' });
  runtime.startTask(task.taskId);
  const finished = await waitForTask(task.taskId);
  assert.equal(finished.status, 'failed');
  assert.ok(finished.errorCode);
  assert.equal(finished.result.status, 'failed');
  assert.equal(finished.result.errorCode, finished.errorCode);
  const session = sessions.getSession('memory', finished.sessionId);
  assert.equal(session.lifecycle.status, 'failed');
});

test('执行：取消传播到运行中的 Worker，收敛为 cancelled', async () => {
  const task = makeTask({ goal: 'SLOW_TASK 取消任务' });
  runtime.startTask(task.taskId);
  await new Promise(resolve => setTimeout(resolve, 60));
  const cancelled = runtime.cancelTask(task.taskId);
  assert.equal(cancelled.status, 'cancelled');
  assert.equal(cancelled.result.status, 'cancelled');
  assert.equal(cancelled.result.errorCode, 'cancelled');
  const session = sessions.getSession('memory', cancelled.sessionId);
  assert.equal(session.lifecycle.status, 'cancelled');
});

test('执行：超过 deadlineMs 收敛为 timed_out', async () => {
  const task = makeTask({ goal: 'ULTRA_SLOW 超时任务', deadlineMs: 5000 });
  const startedAt = Date.now();
  runtime.startTask(task.taskId);
  const finished = await waitForTask(task.taskId, 20000);
  const elapsed = Date.now() - startedAt;
  assert.equal(finished.status, 'timed_out');
  assert.equal(finished.errorCode, 'deadline_exceeded');
  assert.equal(finished.result.status, 'timed_out');
  assert.equal(finished.result.errorCode, 'deadline_exceeded');
  assert.ok(elapsed >= 4500, `不应早于 deadline 结束，实际 ${elapsed}ms`);
});

test('执行：未授权工具被网关拒绝并写 tool.denied 审计事件', async () => {
  const task = makeTask({
    goal: 'TOOL_DENY 未授权工具',
    allowedTools: ['memory_search'],
  });
  runtime.startTask(task.taskId);
  const finished = await waitForTask(task.taskId);
  assert.equal(finished.status, 'completed');
  assert.ok(finished.result.toolSteps.length >= 1);
  assert.equal(finished.result.toolSteps[0].name, 'knowledge_search');
  assert.equal(finished.result.toolSteps[0].ok, false);
  const events = tasks.listEvents('memory', { limit: 300 });
  const denied = events.filter(
    event => event.taskId === task.taskId && event.eventType === 'tool.denied'
  );
  assert.equal(denied.length, 1);
  assert.equal(denied[0].payload.tool, 'knowledge_search');
  assert.equal(denied[0].payload.errorCode, 'task_tool_denied');
  assert.ok(!JSON.stringify(denied).includes('咖啡'));
});

test('执行：两个 Worker 并发时 runId、会话与结果不串线', async () => {
  const first = makeTask({ goal: 'SLOW_TASK 并发任务甲' });
  const second = makeTask({ goal: 'SLOW_TASK 并发任务乙' });
  runtime.startTask(first.taskId);
  runtime.startTask(second.taskId);
  const [a, b] = await Promise.all([
    waitForTask(first.taskId),
    waitForTask(second.taskId),
  ]);
  assert.equal(a.status, 'completed');
  assert.equal(b.status, 'completed');
  assert.notEqual(a.runId, b.runId);
  assert.notEqual(a.sessionId, b.sessionId);
  assert.equal(a.result.summary, '已处理：SLOW_TASK 并发任务甲');
  assert.equal(b.result.summary, '已处理：SLOW_TASK 并发任务乙');
  const sessionA = sessions.getSession('memory', a.sessionId);
  const sessionB = sessions.getSession('memory', b.sessionId);
  assert.equal(sessionA.owner.taskId, first.taskId);
  assert.equal(sessionB.owner.taskId, second.taskId);
});

test('执行：单个 Worker 失败不破坏并发中的另一个 Worker', async () => {
  const failing = makeTask({ goal: 'FAIL_TASK 失败任务' });
  const healthy = makeTask({ goal: 'SLOW_TASK 健康任务' });
  runtime.startTask(failing.taskId);
  runtime.startTask(healthy.taskId);
  const [bad, good] = await Promise.all([
    waitForTask(failing.taskId),
    waitForTask(healthy.taskId),
  ]);
  assert.equal(bad.status, 'failed');
  assert.equal(good.status, 'completed');
  assert.equal(good.result.summary, '已处理：SLOW_TASK 健康任务');
  assert.equal(tasks.getTask(healthy.taskId).errorCode, null);
});

test('执行：会话被运行中的其他任务占用时明确失败，不写入对方会话', async () => {
  const session = sessions.createSession('memory', { title: '占用中', scope: 'worker' });
  const owner = makeTask({ goal: 'SLOW_TASK 占用任务', sessionId: session.id });
  tasks.transitionTask(owner.taskId, { to: 'accepted' });
  tasks.transitionTask(owner.taskId, { to: 'running' });
  sessions.attachOwner('memory', session.id, {
    agentId: 'memory',
    taskId: owner.taskId,
    runId: 'run_owner',
  });
  const before = sessions.getMessages('memory', session.id);

  const intruder = makeTask({ goal: '抢占会话', sessionId: session.id });
  runtime.startTask(intruder.taskId);
  const finished = await waitForTask(intruder.taskId);
  assert.equal(finished.status, 'failed');
  assert.equal(finished.errorCode, 'worker_session_owner_mismatch');
  assert.equal(finished.result.status, 'failed');
  assert.deepEqual(sessions.getMessages('memory', session.id), before);
  assert.equal(sessions.getSession('memory', session.id).owner.taskId, owner.taskId);
});
