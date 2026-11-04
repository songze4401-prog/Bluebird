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
const express = require('express');

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
const artifactStore = require('../server/agents/artifact-store');
const workerScope = require('../server/agents/worker-scope');
const { createAgentRouter } = require('../server/agents/routes');
const runtime = require('../server/agents/runtime');

let providerServer;
let providerBase;
let providerId;
let agentApiServer;
let agentApiBase;
let pendingTimers = [];
// S7：同一 goal 首次请求返回 429，用于验证 retrying 退避与重试上限。
const rateLimitedGoals = new Set();

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
      if (text.includes('RATE_LIMIT_TASK')) {
        const goal = taskGoal(messages);
        if (!rateLimitedGoals.has(goal)) {
          rateLimitedGoals.add(goal);
          json(res, 429, { error: 'rate_limited' });
          return;
        }
      }
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
  // 并发混合角色用例需要三个真实注册角色也处于 enabled；只配模型档案与凭证，
  // 不发起网络调用（路由/并发证据不依赖外部模型）。
  for (const botId of ['researcher', 'executor', 'reviewer']) {
    config.updateConfig(botId, {
      enabled: true,
      modelProfile: {
        providerId,
        modelId: 'worker-test-model',
        temperature: 0.2,
        maxTokens: 256,
        timeoutMs: 20000,
      },
    });
    const roleCredential = credentials.putCredential({
      botId,
      providerId,
      apiKey: 'worker-bot-key',
    });
    config.setCredentialId(botId, roleCredential.credentialId);
  }

  // HTTP 层隔离回归：直接挂载 createAgentRouter，requireAuth 放行（不改生产认证模型）。
  const app = express();
  app.use(express.json());
  app.use(createAgentRouter({ requireAuth: (req, res, next) => next() }));
  agentApiServer = await new Promise(resolve => {
    const server = app.listen(0, '127.0.0.1', () => resolve(server));
  });
  agentApiBase = `http://127.0.0.1:${agentApiServer.address().port}`;
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
  if (agentApiServer) {
    if (typeof agentApiServer.closeAllConnections === 'function') {
      agentApiServer.closeAllConnections();
    }
    await new Promise(resolve => agentApiServer.close(resolve));
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

async function waitForStatus(taskId, status, timeoutMs = 5000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const task = tasks.getTask(taskId);
    if (task && (task.status === status || tasks.isTerminalStatus(task.status))) return task;
    await new Promise(resolve => setTimeout(resolve, 25));
  }
  return tasks.getTask(taskId);
}

// maxAttempts 在 createTask 时从环境变量读取；这里按需临时覆盖。
function makeRetryTask(goal, maxAttempts) {
  const previous = process.env.BLUEBIRD_AGENT_TASK_MAX_ATTEMPTS;
  process.env.BLUEBIRD_AGENT_TASK_MAX_ATTEMPTS = String(maxAttempts);
  try {
    return makeTask({ goal });
  } finally {
    if (previous === undefined) delete process.env.BLUEBIRD_AGENT_TASK_MAX_ATTEMPTS;
    else process.env.BLUEBIRD_AGENT_TASK_MAX_ATTEMPTS = previous;
  }
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

test('执行：可重试错误进入 retrying，退避到期后直接 running 完成', async () => {
  const task = makeRetryTask('RATE_LIMIT_TASK 限流一次', 2);
  runtime.startTask(task.taskId);

  const retrying = await waitForStatus(task.taskId, 'retrying');
  assert.equal(retrying.status, 'retrying');
  assert.equal(retrying.attempts, 1);
  assert.ok(retrying.retryAt);
  // 退避未到期：调度器不会取走该任务。
  assert.equal(tasks.nextQueuedTask(), null);

  const waitMs = Math.max(0, Date.parse(retrying.retryAt) - Date.now()) + 20;
  await new Promise(resolve => setTimeout(resolve, waitMs));
  assert.equal(tasks.getTask(task.taskId).status, 'retrying');

  // 到期后由队列 tick 直接启动下一次 attempt（retrying → running，不经 queued）。
  runtime.startTask(task.taskId);
  const finished = await waitForTask(task.taskId);
  assert.equal(finished.status, 'completed');
  assert.equal(finished.attempts, 2);

  const events = tasks
    .listEvents('memory', { limit: 200 })
    .filter(event => event.taskId === task.taskId);
  assert.equal(events.filter(event => event.eventType === 'task.accepted').length, 1);
  assert.equal(events.filter(event => event.eventType === 'task.started').length, 2);
});

test('执行：重试次数达到 maxAttempts 后收敛为 failed，不再重试', async () => {
  const task = makeRetryTask('RATE_LIMIT_TASK 重试上限', 1);
  runtime.startTask(task.taskId);
  const finished = await waitForTask(task.taskId);
  assert.equal(finished.status, 'failed');
  assert.equal(finished.errorCode, 'model_rate_limit');
  assert.equal(finished.attempts, 1);
  const events = tasks
    .listEvents('memory', { limit: 200 })
    .filter(event => event.taskId === task.taskId);
  assert.ok(!events.some(event => event.eventType === 'task.recovered' && event.payload.mode === 'retry'));
  assert.equal(tasks.getTask(task.taskId).status, 'failed');
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

// ---- F. Worker Session 隔离（验收句前半：隔离，不是共享） ----
// 说明：这里是同一主体下的两个任务与两个 worker 会话，用来验证作用域边界；
// runtime 的 worker 会话归属已统一走 worker-scope。多角色真实路由证据见
// agent-orchestrator.test.js 的「真实注册表」用例，本文件不承担那条证据。

function captureError(fn) {
  try {
    fn();
    return null;
  } catch (error) {
    return error;
  }
}

function persistScopeArtifact(taskId, text) {
  return artifactStore.persist({ kind: 'message', content: { text }, taskId });
}

function openScope(taskId, sessionId, runId) {
  return workerScope.openWorkerScope({
    botId: 'memory',
    taskId,
    sessionId,
    runId,
  });
}

test('隔离：两个 Worker 各写结果，互相读不到对方会话与产物', () => {
  const taskA = makeTask({ goal: '隔离任务甲' });
  const taskB = makeTask({ goal: '隔离任务乙' });
  const sessionA = sessions.createSession('memory', { title: '隔离甲', scope: 'worker' });
  const sessionB = sessions.createSession('memory', { title: '隔离乙', scope: 'worker' });
  sessions.appendMessages('memory', sessionA.id, [{ role: 'user', content: '甲的工作记录' }]);
  sessions.appendMessages('memory', sessionB.id, [{ role: 'user', content: '乙的工作记录' }]);
  const artifactA = persistScopeArtifact(taskA.taskId, '甲的产物正文');
  const artifactB = persistScopeArtifact(taskB.taskId, '乙的产物正文');
  const scopeA = openScope(taskA.taskId, sessionA.id, 'run_a');
  const scopeB = openScope(taskB.taskId, sessionB.id, 'run_b');

  assert.deepEqual(
    scopeA.readOwnMessages().map(item => item.content),
    ['甲的工作记录']
  );
  assert.deepEqual(
    scopeB.readOwnMessages().map(item => item.content),
    ['乙的工作记录']
  );
  assert.deepEqual(scopeA.listOwnArtifacts().map(item => item.id), [artifactA.id]);
  assert.deepEqual(scopeB.listOwnArtifacts().map(item => item.id), [artifactB.id]);

  const sessionDenied = captureError(() => scopeA.readOtherMessages(sessionB.id));
  assert.equal(sessionDenied && sessionDenied.code, 'worker_scope_token_invalid');
  assert.equal(sessionDenied.status, 401);
  assert.ok(!String(sessionDenied.message).includes('乙的工作记录'));
  const artifactDenied = captureError(() => scopeA.readOwnArtifact(artifactB.id));
  assert.equal(artifactDenied && artifactDenied.code, 'worker_scope_token_invalid');
  assert.equal(artifactDenied.status, 401);
  assert.ok(!JSON.stringify(artifactDenied).includes('乙的产物正文'));

  const denied = tasks
    .listEvents('memory', { limit: 200 })
    .filter(event => event.eventType === 'worker.scope_denied' && event.taskId === taskA.taskId);
  assert.ok(denied.length >= 2);
  assert.deepEqual(denied.map(event => event.payload.targetType).sort(), ['artifact', 'session']);
  assert.ok(denied.every(event => event.payload.reason === 'token_missing'));
});

test('隔离：同一 Worker 多次运行仍能读到自己的历史与产物', () => {
  const task = makeTask({ goal: '多轮隔离任务' });
  const session = sessions.createSession('memory', { title: '多轮', scope: 'worker' });
  const first = openScope(task.taskId, session.id, 'run_1');
  sessions.appendMessages('memory', session.id, [{ role: 'user', content: '第一轮记录' }]);
  const artifact = persistScopeArtifact(task.taskId, '第一轮产物');
  assert.equal(first.readOwnMessages().length, 1);

  const second = openScope(task.taskId, session.id, 'run_2');
  assert.deepEqual(
    second.readOwnMessages().map(item => item.content),
    ['第一轮记录']
  );
  assert.equal(second.readOwnArtifact(artifact.id).content.text, '第一轮产物');
  assert.equal(sessions.getSession('memory', session.id).owner.runId, 'run_2');
});

test('隔离：无令牌越权读取被拒并留痕，服务端签发令牌才放行', () => {
  const taskA = makeTask({ goal: '越权读取甲' });
  const taskB = makeTask({ goal: '越权读取乙' });
  const sessionA = sessions.createSession('memory', { title: '越权甲', scope: 'worker' });
  const sessionB = sessions.createSession('memory', { title: '越权乙', scope: 'worker' });
  sessions.appendMessages('memory', sessionB.id, [{ role: 'user', content: '乙的敏感记录' }]);
  const artifactB = persistScopeArtifact(taskB.taskId, '乙的敏感产物');
  const scopeA = openScope(taskA.taskId, sessionA.id, 'run_cross');
  openScope(taskB.taskId, sessionB.id, 'run_owner');

  const denied = captureError(() => scopeA.readOtherMessages(sessionB.id));
  assert.equal(denied && denied.code, 'worker_scope_token_invalid');
  assert.equal(denied.status, 401);
  assert.ok(!String(denied.message).includes('乙的敏感记录'));

  const forged = captureError(() =>
    scopeA.readOtherMessages(sessionB.id, { token: `wst_${'x'.repeat(32)}` })
  );
  assert.equal(forged && forged.code, 'worker_scope_token_invalid');

  // 服务端签发、显式允许 target 的令牌才放行；授权人与理由来自令牌映射，
  // 不由调用方自报。
  const grant = workerScope.issueScopeToken({
    botId: 'memory',
    taskId: taskA.taskId,
    sessionId: sessionA.id,
    allowedTaskIds: [taskB.taskId],
    allowedSessionIds: [sessionB.id],
    grantedBy: 'owner',
    reason: '事故复盘',
  });
  const granted = scopeA.readOtherMessages(sessionB.id, { token: grant });
  assert.deepEqual(granted.map(item => item.content), ['乙的敏感记录']);
  const artifactGranted = scopeA.readOtherArtifact(artifactB.id, { token: grant });
  assert.equal(artifactGranted.content.text, '乙的敏感产物');

  const events = tasks
    .listEvents('memory', { limit: 200 })
    .filter(
      event =>
        event.taskId === taskA.taskId &&
        ['worker.scope_denied', 'worker.scope_read'].includes(event.eventType)
    );
  const deniedEvents = events.filter(event => event.eventType === 'worker.scope_denied');
  assert.ok(deniedEvents.length >= 2);
  assert.deepEqual(
    deniedEvents.map(event => event.payload.reason).sort(),
    ['token_forged', 'token_missing']
  );
  for (const event of deniedEvents) {
    assert.equal(event.payload.requesterTaskId, taskA.taskId);
    assert.equal(event.payload.access, 'denied');
    assert.equal(event.payload.errorCode, 'worker_scope_token_invalid');
  }
  const readEvents = events.filter(event => event.eventType === 'worker.scope_read');
  assert.equal(readEvents.length, 2);
  for (const event of readEvents) {
    assert.equal(event.payload.access, 'granted');
    assert.equal(event.payload.grantedBy, 'owner');
    assert.equal(event.payload.reason, '事故复盘');
  }
  // 审计只落授权元数据，不落令牌原文。
  assert.ok(!JSON.stringify(events).includes(grant));
});

test('回归：隔离接入后既有会话投影/关闭语义与投影字段不变', () => {
  const task = makeTask({ goal: '投影回归' });
  const session = sessions.createSession('memory', { title: '投影回归', scope: 'worker' });
  openScope(task.taskId, session.id, 'run_proj');
  const meta = sessions.getSession('memory', session.id);
  assert.deepEqual(Object.keys(meta).sort(), [
    'botId',
    'createdAt',
    'id',
    'lifecycle',
    'messageCount',
    'owner',
    'scope',
    'title',
    'updatedAt',
  ]);
  const projection = {
    queued: 'running',
    accepted: 'running',
    running: 'running',
    waiting_approval: 'running',
    retrying: 'running',
    completed: 'completed',
    failed: 'failed',
    cancelled: 'cancelled',
    timed_out: 'timed_out',
    recovery: 'failed',
    uncertain: 'failed',
  };
  for (const [input, expected] of Object.entries(projection)) {
    assert.equal(sessions.deriveLifecycleStatus(input), expected);
  }
  assert.equal(sessions.deriveLifecycleStatus('unknown_status'), 'closed');
  const projected = sessions.closeSession('memory', session.id, {
    status: 'running',
    reason: null,
  });
  assert.equal(projected.lifecycle.status, 'running');
  const rejected = captureError(() =>
    sessions.closeSession('memory', session.id, { status: 'active' })
  );
  assert.equal(rejected && rejected.code, 'invalid_lifecycle_status');
});

// ---- G. HTTP 读端点：Worker 作用域令牌对外生效 ----
// 通过 createAgentRouter 直接挂载（requireAuth 放行），验证真实路由处理器；
// worker 会话读只认 x-worker-scope-token，不接受调用方自报的 requesterTaskId/grantedBy。

async function getSessionHttp(sessionId, token = null) {
  const headers = token ? { 'x-worker-scope-token': token } : {};
  const response = await fetch(
    `${agentApiBase}/agents/memory/sessions/${encodeURIComponent(sessionId)}`,
    { headers }
  );
  const json = await response.json();
  return { status: response.status, json };
}

function httpScopeFixture() {
  const taskA = makeTask({ goal: 'HTTP 隔离甲' });
  const taskB = makeTask({ goal: 'HTTP 隔离乙' });
  const sessionA = sessions.createSession('memory', { title: 'HTTP 甲', scope: 'worker' });
  const sessionB = sessions.createSession('memory', { title: 'HTTP 乙', scope: 'worker' });
  sessions.appendMessages('memory', sessionA.id, [{ role: 'user', content: '甲的 HTTP 正文' }]);
  sessions.appendMessages('memory', sessionB.id, [{ role: 'user', content: '乙的 HTTP 正文' }]);
  const scopeA = openScope(taskA.taskId, sessionA.id, 'run_http_a');
  const scopeB = openScope(taskB.taskId, sessionB.id, 'run_http_b');
  return {
    taskA,
    taskB,
    sessionA,
    sessionB,
    tokenA: scopeA.token,
    tokenB: scopeB.token,
  };
}

test('HTTP 隔离：有效令牌跨作用域 409，无令牌 401，均留痕且不回显内容', async () => {
  const { taskA, sessionB, tokenA } = httpScopeFixture();
  const denied = await getSessionHttp(sessionB.id, tokenA);
  assert.equal(denied.status, 409);
  assert.equal(denied.json.code, 'worker_session_owner_mismatch');
  assert.ok(!JSON.stringify(denied.json).includes('乙的 HTTP 正文'));

  const anonymous = await getSessionHttp(sessionB.id);
  assert.equal(anonymous.status, 401);
  assert.equal(anonymous.json.code, 'worker_scope_token_invalid');
  assert.ok(!JSON.stringify(anonymous.json).includes('乙的 HTTP 正文'));

  const events = tasks
    .listEvents('memory', { limit: 200 })
    .filter(
      event =>
        event.eventType === 'worker.scope_denied' && event.payload.targetId === sessionB.id
    );
  assert.ok(events.length >= 2);
  assert.ok(events.every(event => event.payload.access === 'denied'));
  assert.ok(events.some(event => event.payload.requesterTaskId === taskA.taskId));
  assert.ok(events.some(event => event.payload.requesterTaskId === null));
});

test('HTTP 隔离：本 Worker 令牌读自己的会话 → 200 且只返回自己消息', async () => {
  const { taskA, sessionA, tokenA } = httpScopeFixture();
  const own = await getSessionHttp(sessionA.id, tokenA);
  assert.equal(own.status, 200);
  assert.deepEqual(
    own.json.messages.map(item => item.content),
    ['甲的 HTTP 正文']
  );
  assert.equal(own.json.session.owner.taskId, taskA.taskId);
});

test('HTTP 隔离：服务端签发授权令牌读他人 Worker 会话 → 200 且写 worker.scope_read', async () => {
  const { taskA, taskB, sessionA, sessionB } = httpScopeFixture();
  const grant = workerScope.issueScopeToken({
    botId: 'memory',
    taskId: taskA.taskId,
    sessionId: sessionA.id,
    allowedTaskIds: [taskB.taskId],
    allowedSessionIds: [sessionB.id],
    grantedBy: 'owner',
    reason: '事故复盘',
  });
  const granted = await getSessionHttp(sessionB.id, grant);
  assert.equal(granted.status, 200);
  assert.deepEqual(
    granted.json.messages.map(item => item.content),
    ['乙的 HTTP 正文']
  );
  const events = tasks
    .listEvents('memory', { limit: 200 })
    .filter(
      event =>
        event.eventType === 'worker.scope_read' && event.payload.targetId === sessionB.id
    );
  assert.ok(events.length >= 1);
  assert.equal(events[0].payload.grantedBy, 'owner');
  assert.equal(events[0].payload.reason, '事故复盘');
  assert.equal(events[0].payload.access, 'granted');
});

test('HTTP 令牌：伪造、过期、吊销均 401，审计留痕且不回显内容', async () => {
  const { taskA, sessionA } = httpScopeFixture();
  const forged = `wst_${'f'.repeat(43)}`;
  const deniedForged = await getSessionHttp(sessionA.id, forged);
  assert.equal(deniedForged.status, 401);
  assert.equal(deniedForged.json.code, 'worker_scope_token_invalid');
  assert.ok(!JSON.stringify(deniedForged.json).includes('甲的 HTTP 正文'));

  const expiredTask = makeTask({ goal: '令牌过期任务' });
  const expiredSession = sessions.createSession('memory', { title: '令牌过期', scope: 'worker' });
  sessions.appendMessages('memory', expiredSession.id, [
    { role: 'user', content: '到期会话正文' },
  ]);
  const expiredScope = workerScope.openWorkerScope({
    botId: 'memory',
    taskId: expiredTask.taskId,
    sessionId: expiredSession.id,
    runId: 'run_expired',
    tokenTtlMs: 5,
  });
  await new Promise(resolve => setTimeout(resolve, 20));
  const deniedExpired = await getSessionHttp(expiredSession.id, expiredScope.token);
  assert.equal(deniedExpired.status, 401);
  assert.equal(deniedExpired.json.code, 'worker_scope_token_invalid');
  assert.ok(!JSON.stringify(deniedExpired.json).includes('到期会话正文'));

  const revokedScope = openScope(taskA.taskId, sessionA.id, 'run_revoked');
  assert.equal(workerScope.revokeScopeToken(revokedScope.token), true);
  const deniedRevoked = await getSessionHttp(sessionA.id, revokedScope.token);
  assert.equal(deniedRevoked.status, 401);
  assert.equal(deniedRevoked.json.code, 'worker_scope_token_invalid');

  const events = tasks
    .listEvents('memory', { limit: 200 })
    .filter(
      event =>
        event.eventType === 'worker.scope_denied' &&
        [sessionA.id, expiredSession.id].includes(event.payload.targetId)
    );
  const reasons = new Set(events.map(event => event.payload.reason));
  assert.ok(reasons.has('token_forged'));
  assert.ok(reasons.has('token_expired'));
  assert.ok(reasons.has('token_revoked'));
  // 审计只落授权元数据，不落令牌原文。
  const serialized = JSON.stringify(events);
  assert.ok(!serialized.includes(forged));
  assert.ok(!serialized.includes(expiredScope.token));
  assert.ok(!serialized.includes(revokedScope.token));
});

test('HTTP 回归：direct 会话与缺失会话的既有行为不变', async () => {
  const direct = sessions.createSession('memory', { title: '普通会话' });
  sessions.appendMessages('memory', direct.id, [{ role: 'user', content: 'direct 正文' }]);
  const read = await getSessionHttp(direct.id);
  assert.equal(read.status, 200);
  assert.deepEqual(read.json.messages.map(item => item.content), ['direct 正文']);
  assert.equal(read.json.session.owner, null);

  const missing = await getSessionHttp('bs_missing_http');
  assert.equal(missing.status, 404);
  assert.deepEqual(Object.keys(missing.json).sort(), ['code', 'error']);
  assert.equal(missing.json.code, 'agent_session_not_found');
  assert.equal(missing.json.error, 'Bot 会话不存在');

  const list = await fetch(`${agentApiBase}/agents/memory/sessions`);
  assert.equal(list.status, 200);
  const listJson = await list.json();
  assert.ok(Array.isArray(listJson.sessions));
});

// ---- H2. 共享产物访问控制（Phase 2 第 1 项） ----
// 证据边界：同一进程 + 库级调用（未新增 HTTP 路由），令牌为服务端签发。

test('共享产物：未登记共享时，令牌允许任务也拒绝读取，留痕且不回显正文', () => {
  const taskA = makeTask({ goal: '共享未登记甲' });
  const taskB = makeTask({ goal: '共享未登记乙' });
  const sessionA = sessions.createSession('memory', { title: '共享甲', scope: 'worker' });
  const sessionB = sessions.createSession('memory', { title: '共享乙', scope: 'worker' });
  const scopeA = openScope(taskA.taskId, sessionA.id, 'run_share_deny');
  openScope(taskB.taskId, sessionB.id, 'run_share_owner');
  const artifactB = persistScopeArtifact(taskB.taskId, '乙的私有共享候选正文');
  const grant = workerScope.issueScopeToken({
    botId: 'memory',
    taskId: taskA.taskId,
    sessionId: sessionA.id,
    allowedTaskIds: [taskB.taskId],
    grantedBy: 'owner',
    reason: '尝试共享读取',
  });

  const denied = captureError(() => scopeA.readSharedArtifact(artifactB.id, { token: grant }));
  assert.equal(denied && denied.code, 'artifact_not_shared');
  assert.equal(denied.status, 409);
  assert.ok(!String(denied.message).includes('乙的私有共享候选正文'));
  assert.ok(!JSON.stringify(denied).includes('乙的私有共享候选正文'));

  const deniedEvents = taskEvents(taskA.taskId).filter(
    event => event.eventType === 'worker.scope_denied' && event.payload.targetId === artifactB.id
  );
  assert.equal(deniedEvents.length, 1);
  assert.equal(deniedEvents[0].payload.reason, 'not_shared');
  assert.equal(deniedEvents[0].payload.errorCode, 'artifact_not_shared');
  assert.equal(deniedEvents[0].payload.access, 'denied');
  console.log(
    '[共享-未登记]',
    JSON.stringify({
      artifactId: artifactB.id,
      code: denied.code,
      reason: deniedEvents[0].payload.reason,
      errorCode: deniedEvents[0].payload.errorCode,
      bodyEchoed: JSON.stringify(denied).includes('乙的私有共享候选正文'),
    })
  );
});

test('共享产物：登记共享后持有效令牌按登记版本可读；无令牌或版本不符被拒', () => {
  const taskC = makeTask({ goal: '共享接收丙' });
  const taskD = makeTask({ goal: '共享来源丁' });
  const sessionC = sessions.createSession('memory', { title: '共享丙', scope: 'worker' });
  const sessionD = sessions.createSession('memory', { title: '共享丁', scope: 'worker' });
  const scopeC = openScope(taskC.taskId, sessionC.id, 'run_share_read');
  openScope(taskD.taskId, sessionD.id, 'run_share_owner_d');
  const artifactD = persistScopeArtifact(taskD.taskId, '丁的共享正文');
  const grant = workerScope.issueScopeToken({
    botId: 'memory',
    taskId: taskC.taskId,
    sessionId: sessionC.id,
    allowedTaskIds: [taskD.taskId],
    grantedBy: 'owner',
    reason: '同批次协作',
  });

  // 登记之前：令牌合法也不放行。
  const beforeShare = captureError(() =>
    scopeC.readSharedArtifact(artifactD.id, { token: grant })
  );
  assert.equal(beforeShare && beforeShare.code, 'artifact_not_shared');

  // 拥有者登记共享给丙（版本在登记时钉住）。
  artifactStore.share(artifactD.id, { withTaskIds: [taskC.taskId], byTaskId: taskD.taskId });

  // 无令牌 → 401，且不回显正文。
  const noToken = captureError(() => scopeC.readSharedArtifact(artifactD.id, {}));
  assert.equal(noToken && noToken.code, 'worker_scope_token_invalid');
  assert.equal(noToken.status, 401);
  assert.ok(!JSON.stringify(noToken).includes('丁的共享正文'));

  const read = scopeC.readSharedArtifact(artifactD.id, {
    token: grant,
    version: artifactD.version,
  });
  assert.equal(read.content.text, '丁的共享正文');
  assert.equal(read.version, artifactD.version);

  const wrongVersion = captureError(() =>
    scopeC.readSharedArtifact(artifactD.id, {
      token: grant,
      version: artifactD.version + 1,
    })
  );
  assert.equal(wrongVersion && wrongVersion.code, 'artifact_version_mismatch');

  const deniedEvents = taskEvents(taskC.taskId).filter(
    event => event.eventType === 'worker.scope_denied' && event.payload.targetId === artifactD.id
  );
  assert.deepEqual(
    deniedEvents.map(event => event.payload.reason).sort(),
    ['not_shared', 'token_missing', 'version_mismatch']
  );
  const readEvents = taskEvents(taskC.taskId).filter(
    event => event.eventType === 'worker.scope_read' && event.payload.targetId === artifactD.id
  );
  assert.ok(readEvents.some(event => event.payload.reason === 'shared_artifact'));
  console.log(
    '[共享-登记读取]',
    JSON.stringify({
      artifactId: artifactD.id,
      sharedVersion: artifactStore.get(artifactD.id).share.version,
      sharedTargets: artifactStore.get(artifactD.id).share.taskIds.length,
      readVersion: read.version,
      noTokenCode: noToken.code,
      wrongVersionCode: wrongVersion.code,
      denyReasons: deniedEvents.map(event => event.payload.reason),
      grantedAudit: readEvents.some(event => event.payload.reason === 'shared_artifact'),
    })
  );
});

// ---- I. 依赖管理：阻塞/放行、失败级联、取消级联、全局并发上限 ----
// 证据边界：同一进程 + 真实 HTTP stub Provider；不含跨进程与真实模型并发。

async function drainPendingTasks() {
  for (const task of tasks.allTasks()) {
    if (!tasks.isTerminalStatus(task.status) && task.status !== 'waiting_approval') {
      try {
        runtime.cancelTask(task.taskId);
      } catch (_) {
        // 已终态/正在收敛的忽略
      }
    }
  }
  await new Promise(resolve => setTimeout(resolve, 60));
}

function taskEvents(taskId, limit = 300) {
  return tasks
    .listEvents('memory', { limit })
    .filter(event => event.taskId === taskId);
}

test('依赖：上游未完成时下游保持 queued，上游完成后自动执行', async () => {
  await drainPendingTasks();
  const upstream = makeTask({ goal: 'SLOW_TASK DEP_BLOCK 上游依赖' });
  const downstream = makeTask({
    goal: 'DEP_RELEASE 下游任务',
    dependsOn: [upstream.taskId],
  });
  runtime.startTask(upstream.taskId);
  runtime.startTask(downstream.taskId);

  const runningUpstream = await waitForStatus(upstream.taskId, 'running', 3000);
  assert.equal(runningUpstream.status, 'running');
  const blocked = tasks.getTask(downstream.taskId);
  assert.equal(blocked.status, 'queued', '上游未完成时下游不得出队');
  assert.equal(blocked.runStartedAt, null);
  assert.equal(
    taskEvents(downstream.taskId).filter(event => event.eventType === 'task.started').length,
    0
  );

  const finishedUpstream = await waitForTask(upstream.taskId);
  assert.equal(finishedUpstream.status, 'completed');
  const finishedDownstream = await waitForTask(downstream.taskId);
  assert.equal(finishedDownstream.status, 'completed');

  const rawDown = tasks.getRawTask(downstream.taskId);
  const downStarted = taskEvents(downstream.taskId).find(
    event => event.eventType === 'task.started'
  );
  assert.ok(
    Date.parse(rawDown.runStartedAt) >= Date.parse(finishedUpstream.completedAt),
    '下游只能在依赖完成后启动'
  );
  assert.ok(downStarted && Date.parse(downStarted.timestamp) >= Date.parse(finishedUpstream.completedAt));

  console.log('[依赖-放行时序]', JSON.stringify({
    upstream: {
      taskId: upstream.taskId,
      status: finishedUpstream.status,
      completedAt: finishedUpstream.completedAt,
    },
    downstream: {
      taskId: downstream.taskId,
      blockedStatus: blocked.status,
      runStartedAt: rawDown.runStartedAt,
      status: rawDown.status,
      startedEventAt: downStarted.timestamp,
    },
  }));
});

test('依赖：上游 failed → 下游 dependency_failed 且 neverStarted=true（从未 running）', async () => {
  await drainPendingTasks();
  const upstream = makeTask({ goal: 'FAIL_TASK DEP_FAIL 上游必败' });
  const downstream = makeTask({
    goal: 'DEP_FAIL_DOWNSTREAM 下游',
    dependsOn: [upstream.taskId],
  });
  runtime.startTask(upstream.taskId);
  runtime.startTask(downstream.taskId);

  const finishedUpstream = await waitForTask(upstream.taskId);
  assert.equal(finishedUpstream.status, 'failed');
  const finishedDownstream = await waitForTask(downstream.taskId);

  assert.equal(finishedDownstream.status, 'failed');
  assert.equal(finishedDownstream.errorCode, 'dependency_failed');
  assert.equal(finishedDownstream.result.neverStarted, true);
  assert.deepEqual(finishedDownstream.result.blockedBy, [upstream.taskId]);
  // 两步收敛的证据：有 accepted 事件，但绝无 started 事件、无 runStartedAt。
  const events = taskEvents(downstream.taskId);
  assert.equal(events.filter(event => event.eventType === 'task.started').length, 0);
  assert.equal(tasks.getRawTask(downstream.taskId).runStartedAt, null);
  const settleEvent = events.find(event => event.eventType === 'task.dependency_failed');
  assert.ok(settleEvent);
  assert.equal(settleEvent.payload.neverStarted, true);
  assert.equal(settleEvent.payload.blockedBy, upstream.taskId);

  console.log('[依赖-失败级联]', JSON.stringify({
    upstream: { status: finishedUpstream.status, errorCode: finishedUpstream.errorCode },
    downstream: {
      status: finishedDownstream.status,
      errorCode: finishedDownstream.errorCode,
      neverStarted: finishedDownstream.result.neverStarted,
      blockedBy: finishedDownstream.result.blockedBy,
      runStartedAt: tasks.getRawTask(downstream.taskId).runStartedAt,
      startedEvents: events.filter(event => event.eventType === 'task.started').length,
      event: {
        eventType: settleEvent.eventType,
        neverStarted: settleEvent.payload.neverStarted,
        blockedBy: settleEvent.payload.blockedBy,
      },
    },
  }));
});

test('依赖：失败级联到下游的下游（一次取队内收敛整条链）', async () => {
  await drainPendingTasks();
  const root = makeTask({ goal: 'FAIL_TASK DEP_CHAIN_ROOT 根任务必败' });
  const middle = makeTask({
    goal: 'DEP_CHAIN_MIDDLE 中间任务',
    dependsOn: [root.taskId],
  });
  const leaf = makeTask({
    goal: 'DEP_CHAIN_LEAF 末端任务',
    dependsOn: [middle.taskId],
  });
  runtime.startTask(root.taskId);
  runtime.startTask(middle.taskId);
  runtime.startTask(leaf.taskId);

  const finishedRoot = await waitForTask(root.taskId);
  assert.equal(finishedRoot.status, 'failed');
  const [finishedMiddle, finishedLeaf] = await Promise.all([
    waitForTask(middle.taskId),
    waitForTask(leaf.taskId),
  ]);
  for (const item of [finishedMiddle, finishedLeaf]) {
    assert.equal(item.status, 'failed');
    assert.equal(item.errorCode, 'dependency_failed');
    assert.equal(item.result.neverStarted, true);
    assert.equal(tasks.getRawTask(item.taskId).runStartedAt, null);
  }
  assert.deepEqual(finishedMiddle.result.blockedBy, [root.taskId]);
  assert.deepEqual(finishedLeaf.result.blockedBy, [middle.taskId]);

  console.log('[依赖-多级级联]', JSON.stringify({
    root: { status: finishedRoot.status },
    middle: {
      status: finishedMiddle.status,
      errorCode: finishedMiddle.errorCode,
      blockedBy: finishedMiddle.result.blockedBy,
    },
    leaf: {
      status: finishedLeaf.status,
      errorCode: finishedLeaf.errorCode,
      blockedBy: finishedLeaf.result.blockedBy,
    },
  }));
});

test('依赖：上游 cancelled → 下游 dependency_cancelled 且 neverStarted=true', async () => {
  await drainPendingTasks();
  const upstream = makeTask({ goal: 'DEP_CANCEL_UPSTREAM 上游取消' });
  const downstream = makeTask({
    goal: 'DEP_CANCEL_DOWNSTREAM 下游',
    dependsOn: [upstream.taskId],
  });
  runtime.cancelTask(upstream.taskId);
  const cancelledUpstream = tasks.getTask(upstream.taskId);
  assert.equal(cancelledUpstream.status, 'cancelled');

  runtime.startTask(downstream.taskId);
  const finishedDownstream = await waitForTask(downstream.taskId);
  assert.equal(finishedDownstream.status, 'failed');
  assert.equal(finishedDownstream.errorCode, 'dependency_cancelled');
  assert.equal(finishedDownstream.result.neverStarted, true);
  assert.equal(tasks.getRawTask(downstream.taskId).runStartedAt, null);

  console.log('[依赖-取消级联]', JSON.stringify({
    upstream: { status: cancelledUpstream.status },
    downstream: {
      status: finishedDownstream.status,
      errorCode: finishedDownstream.errorCode,
      neverStarted: finishedDownstream.result.neverStarted,
      runStartedAt: tasks.getRawTask(downstream.taskId).runStartedAt,
    },
  }));
});

test('并发：3 条任务受全局 TASK_CONCURRENCY=2 限制，峰值并行=2 且第 3 条延后', async () => {
  await drainPendingTasks();
  const t1 = makeTask({ goal: 'SLOW_TASK CONC3_ALPHA 并发三甲' });
  const t2 = makeTask({ goal: 'SLOW_TASK CONC3_BETA 并发三乙' });
  const t3 = makeTask({ goal: 'SLOW_TASK CONC3_GAMMA 并发三丙' });
  runtime.startTask(t1.taskId);
  runtime.startTask(t2.taskId);
  runtime.startTask(t3.taskId);

  let peak = 0;
  const deadline = Date.now() + 20000;
  while (Date.now() < deadline) {
    peak = Math.max(peak, runtime.getQueueStats().active);
    const all = [t1, t2, t3].map(item => tasks.getTask(item.taskId));
    if (all.every(item => tasks.isTerminalStatus(item.status))) break;
    await new Promise(resolve => setTimeout(resolve, 10));
  }
  const [a, b, c] = await Promise.all([
    waitForTask(t1.taskId),
    waitForTask(t2.taskId),
    waitForTask(t3.taskId),
  ]);
  assert.equal(peak, 2, `峰值并行应为 2（实际 ${peak}）`);
  assert.ok([a, b, c].every(item => item.status === 'completed'));
  // 第 3 条必须等前两条之一完成才启动：证明并行闸门是全局 TASK_CONCURRENCY。
  const third = [a, b, c].sort(
    (x, y) => Date.parse(x.runStartedAt) - Date.parse(y.runStartedAt)
  )[2];
  const firstTwoCompleted = [a, b, c]
    .filter(item => item.taskId !== third.taskId)
    .map(item => Date.parse(item.completedAt));
  assert.ok(Date.parse(third.runStartedAt) >= Math.min(...firstTwoCompleted));

  console.log('[并发-全局上限]', JSON.stringify({
    concurrency: process.env.BLUEBIRD_AGENT_TASK_CONCURRENCY || '(default=2)',
    peakActive: peak,
    tasks: [a, b, c].map(item => ({
      taskId: item.taskId,
      runStartedAt: item.runStartedAt,
      completedAt: item.completedAt,
      status: item.status,
    })),
    thirdStartedAt: third.runStartedAt,
    firstTwoCompletedAt: firstTwoCompleted,
  }));
});

// 能证明：同一进程内 Promise 级并发下，结果/产物/会话归属互不混入。
// 不能证明：跨进程隔离、真实模型并发（stub provider 仍是确定性回显）。

test('并发：两条任务同时跑，结果、产物引用与会话各归各且不串线', async () => {
  const taskA = makeTask({ goal: 'SLOW_TASK CONCURRENT_ALPHA 并发甲' });
  const taskB = makeTask({ goal: 'SLOW_TASK CONCURRENT_BETA 并发乙' });
  const [settledA, settledB] = await Promise.allSettled([
    (async () => {
      runtime.startTask(taskA.taskId);
      return waitForTask(taskA.taskId);
    })(),
    (async () => {
      runtime.startTask(taskB.taskId);
      return waitForTask(taskB.taskId);
    })(),
  ]);
  assert.equal(settledA.status, 'fulfilled');
  assert.equal(settledB.status, 'fulfilled');
  const a = settledA.value;
  const b = settledB.value;
  assert.equal(a.status, 'completed');
  assert.equal(b.status, 'completed');

  // 时序重叠即真有并发：串行执行时后一条的 runStartedAt 不会早于前一条的 completedAt。
  const overlap =
    Math.min(Date.parse(a.completedAt), Date.parse(b.completedAt)) -
    Math.max(Date.parse(a.runStartedAt), Date.parse(b.runStartedAt));
  assert.ok(overlap > 200, `两条任务执行区间重叠 ${overlap}ms（应远大于 0）`);

  assert.notEqual(a.runId, b.runId);
  assert.notEqual(a.sessionId, b.sessionId);
  assert.ok(a.result.summary.includes('CONCURRENT_ALPHA'));
  assert.ok(!JSON.stringify(a).includes('CONCURRENT_BETA'));
  assert.ok(!JSON.stringify(a).includes(taskB.taskId));
  assert.ok(!JSON.stringify(a).includes(b.sessionId));
  assert.ok(b.result.summary.includes('CONCURRENT_BETA'));
  assert.ok(!JSON.stringify(b).includes('CONCURRENT_ALPHA'));
  assert.ok(!JSON.stringify(b).includes(taskA.taskId));
  assert.ok(!JSON.stringify(b).includes(a.sessionId));

  const idsA = a.result.artifacts.map(ref => ref.id);
  const idsB = b.result.artifacts.map(ref => ref.id);
  assert.ok(idsA.length > 0 && idsB.length > 0);
  assert.deepEqual(idsA.filter(id => idsB.includes(id)), []);
  for (const id of idsA) assert.equal(artifactStore.get(id).taskId, taskA.taskId);
  for (const id of idsB) assert.equal(artifactStore.get(id).taskId, taskB.taskId);

  const rawA = tasks.getRawTask(taskA.taskId);
  const rawB = tasks.getRawTask(taskB.taskId);
  assert.ok(rawA.stateVersion > 0 && rawB.stateVersion > 0);
  assert.equal(rawA.status, 'completed');
  assert.equal(rawB.status, 'completed');
  assert.equal(sessions.getSession('memory', a.sessionId).owner.taskId, taskA.taskId);
  assert.equal(sessions.getSession('memory', b.sessionId).owner.taskId, taskB.taskId);
});

// 能证明：同一进程内，5 条混合角色在 TASK_CONCURRENCY=2 下的结果/产物/预算互不串线，
// 且超发被预算闸门拒绝。不能证明：跨进程隔离（超出 Notion Phase 1 范围，需跨进程锁）。
test('并发：5 条混合角色受 TASK_CONCURRENCY=2 约束，结果/产物/预算互不串线且超发被拒', async () => {
  await drainPendingTasks();
  const TOKEN_BUDGET = 12000;
  const specs = [
    {
      agentId: 'researcher',
      taskType: 'memory.recall',
      allowedTools: ['memory_search'],
      marker: 'MIX_RESEARCH_ALPHA',
    },
    {
      agentId: 'executor',
      taskType: 'memory.write',
      allowedTools: ['memory_remember'],
      marker: 'MIX_EXECUTOR_BETA',
    },
    {
      agentId: 'reviewer',
      taskType: 'review.verify',
      allowedTools: ['knowledge_search'],
      marker: 'MIX_REVIEW_GAMMA',
    },
    {
      agentId: 'memory',
      taskType: 'memory.search',
      allowedTools: ['memory_search'],
      marker: 'MIX_MEMORY_DELTA',
    },
    {
      agentId: 'researcher',
      taskType: 'memory.recall',
      allowedTools: ['knowledge_search'],
      marker: 'MIX_RESEARCH_EPSILON',
    },
  ];
  const created = specs.map(spec =>
    tasks.createTask({
      agentId: spec.agentId,
      taskType: spec.taskType,
      goal: `SLOW_TASK ${spec.marker} 混合并发`,
      allowedTools: spec.allowedTools,
      deadlineMs: 20000,
      budget: {
        maxRounds: 3,
        maxToolCalls: 6,
        maxReadOnlyRetries: 1,
        tokenBudget: TOKEN_BUDGET,
      },
    })
  );
  for (const task of created) runtime.startTask(task.taskId);

  let peak = 0;
  let maxQueued = 0;
  const deadline = Date.now() + 30000;
  while (Date.now() < deadline) {
    const stats = runtime.getQueueStats();
    peak = Math.max(peak, stats.active);
    maxQueued = Math.max(maxQueued, stats.queued);
    const current = created.map(task => tasks.getTask(task.taskId));
    if (current.every(item => tasks.isTerminalStatus(item.status))) break;
    await new Promise(resolve => setTimeout(resolve, 5));
  }
  const finished = await Promise.all(created.map(task => waitForTask(task.taskId)));

  assert.equal(peak, 2, `峰值并行应为 2（实际 ${peak}）`);
  assert.ok(finished.every(item => item.status === 'completed'), '每条任务都应完成');

  // 结果互不可见：每条只含自己的标记，不含其他任务的标记 / taskId / sessionId。
  for (let index = 0; index < finished.length; index += 1) {
    const own = finished[index];
    const otherMarkers = specs.filter((_, i) => i !== index).map(spec => spec.marker);
    const otherTaskIds = created.filter((_, i) => i !== index).map(task => task.taskId);
    const otherSessionIds = finished.filter((_, i) => i !== index).map(item => item.sessionId);
    assert.ok(own.result.summary.includes(specs[index].marker));
    for (const marker of otherMarkers) {
      assert.ok(!JSON.stringify(own).includes(marker), `结果串入其他标记：${marker}`);
    }
    for (const id of otherTaskIds) assert.ok(!JSON.stringify(own).includes(id));
    for (const id of otherSessionIds) assert.ok(!JSON.stringify(own).includes(id));
    assert.equal(own.agentId, specs[index].agentId);
  }

  // 产物各归各：产物 taskId 是自己的，跨任务无共享 id。
  const artifactIds = finished.map(item => item.result.artifacts.map(ref => ref.id));
  for (let index = 0; index < finished.length; index += 1) {
    assert.ok(artifactIds[index].length > 0);
    for (const id of artifactIds[index]) {
      assert.equal(artifactStore.get(id).taskId, finished[index].taskId);
    }
    for (let other = 0; other < artifactIds.length; other += 1) {
      if (other === index) continue;
      assert.deepEqual(
        artifactIds[index].filter(id => artifactIds[other].includes(id)),
        []
      );
    }
    assert.equal(
      sessions.getSession(finished[index].agentId, finished[index].sessionId).owner.taskId,
      finished[index].taskId
    );
  }

  // 预算各归各：每条只用自己的 tokenBudget，remaining = 上限 - 自己已用。
  const usages = finished.map(item => {
    const snapshot = tasks.getTaskBudgetSnapshot(item.taskId);
    assert.equal(snapshot.limit, TOKEN_BUDGET);
    assert.equal(snapshot.remaining, TOKEN_BUDGET - snapshot.used);
    return snapshot;
  });
  assert.ok(usages.every(item => item.used === 2), `每条应只记自己的 2 tokens（实际 ${usages.map(item => item.used).join(',')}）`);
  assert.equal(
    usages.reduce((sum, item) => sum + item.used, 0),
    2 * finished.length,
    '总用量应等于各任务自身用量之和，不存在共享账本串线'
  );

  // 超发被拒：在已用基础上再申请 1 token 以上必须 budget_exceeded，且不改账本。
  const target = finished[0].taskId;
  const beforeReserve = tasks.getTaskBudgetSnapshot(target);
  assert.throws(
    () =>
      tasks.reserveTaskBudget(target, {
        amount: beforeReserve.remaining + 1,
      }),
    error => error.code === 'budget_exceeded'
  );
  const afterReserve = tasks.getTaskBudgetSnapshot(target);
  assert.deepEqual(afterReserve, beforeReserve, '拒绝超发不得修改预算账本');

  const timeline = finished
    .map(item => ({
      taskId: item.taskId,
      agentId: item.agentId,
      taskType: item.taskType,
      runStartedAt: item.runStartedAt,
      completedAt: item.completedAt,
      durationMs: Date.parse(item.completedAt) - Date.parse(item.runStartedAt),
      used: tasks.getTaskBudgetSnapshot(item.taskId).used,
    }))
    .sort((a, b) => Date.parse(a.runStartedAt) - Date.parse(b.runStartedAt));
  console.log('[并发-5条混合角色]', JSON.stringify({
    concurrency: runtime.getQueueStats().concurrency,
    peakActive: peak,
    maxQueued: maxQueued,
    timeline,
    overIssue: {
      taskId: target,
      attempted: beforeReserve.remaining + 1,
      remaining: beforeReserve.remaining,
    },
  }));
});
