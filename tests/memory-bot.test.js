/* global __dirname */
/**
 * Memory Bot 首期后端测试。
 *
 * 使用真实 HTTP 的本地 OpenAI-compatible stub provider，验证：
 * - 独立 Bot 凭证被用于模型调用，主控全局 Key 不会被借用；
 * - 凭证密文落盘、脱敏读取、验证与删除；
 * - Bot 会话与主控会话隔离；
 * - 直接对话与主控委派共用同一 Runtime，且工具调用走真实 Agent 循环；
 * - 任务状态、取消与安全事件。
 */
const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');
const test = require('node:test');
const assert = require('node:assert');

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'bluebird-memory-bot-'));
const BOT_KEY = 'bot-secret-key-1234567890';
const GLOBAL_KEY = 'global-key-must-not-be-used';

process.env.BLUEBIRD_DATA_DIR = TMP;
process.env.MEMORY_ENABLED = 'true';
process.env.DEEPSEEK_API_KEY = '';
process.env.BLUEBIRD_AGENT_TOOLS = '';
process.env.BLUEBIRD_MONITORING = '0';
process.env.BLUEBIRD_ALLOW_PRIVATE_BASE_URL = '1';

const seenAuth = [];
let providerMode = 'text';
let responseDelayMs = 0;
let providerPort = 0;

function jsonResponse(res, status, payload) {
  res.writeHead(status, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify(payload));
}

function completion(content, toolCalls) {
  return {
    id: `chatcmpl-${Date.now()}`,
    object: 'chat.completion',
    created: Math.floor(Date.now() / 1000),
    model: 'bot-test-model',
    choices: [
      {
        index: 0,
        finish_reason: toolCalls ? 'tool_calls' : 'stop',
        message: {
          role: 'assistant',
          content: toolCalls ? null : content,
          ...(toolCalls ? { tool_calls: toolCalls } : {}),
        },
      },
    ],
    usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 },
  };
}

function toolCall(name, args) {
  return [
    {
      id: `call_${Date.now()}`,
      type: 'function',
      function: { name, arguments: JSON.stringify(args) },
    },
  ];
}

const providerServer = http.createServer((req, res) => {
  const auth = req.headers.authorization || '';
  if (req.method === 'GET' && req.url === '/v1/models') {
    seenAuth.push(auth);
    if (auth !== `Bearer ${BOT_KEY}` && auth !== 'Bearer bot-replacement-key') {
      jsonResponse(res, 401, { error: 'unauthorized' });
      return;
    }
    jsonResponse(res, 200, { data: [{ id: 'bot-test-model' }] });
    return;
  }

  if (req.method !== 'POST' || req.url !== '/v1/chat/completions') {
    jsonResponse(res, 404, { error: 'not_found' });
    return;
  }

  let body = '';
  req.on('data', chunk => {
    body += chunk;
  });
  req.on('end', () => {
    let parsed;
    try {
      parsed = JSON.parse(body);
    } catch (_) {
      jsonResponse(res, 400, { error: 'bad_json' });
      return;
    }
    seenAuth.push(auth);
    if (auth !== `Bearer ${BOT_KEY}` && auth !== 'Bearer bot-replacement-key') {
      jsonResponse(res, 401, { error: 'unauthorized' });
      return;
    }

    const messages = Array.isArray(parsed.messages) ? parsed.messages : [];
    const hasToolResult = messages.some(message => message.role === 'tool');

    const sse = payload => res.write(`data: ${JSON.stringify(payload)}

`);
    const sendStreamText = () => {
      res.writeHead(200, {
        'Content-Type': 'text/event-stream; charset=utf-8',
        'Cache-Control': 'no-cache',
      });
      for (const text of ['这是 ', '流式 ', '回复。']) {
        sse({ choices: [{ index: 0, delta: { content: text }, finish_reason: null }] });
      }
      sse({ choices: [{ index: 0, delta: {}, finish_reason: 'stop' }] });
      res.end('data: [DONE]\n\n');
    };
    const sendStreamTool = () => {
      res.writeHead(200, {
        'Content-Type': 'text/event-stream; charset=utf-8',
        'Cache-Control': 'no-cache',
      });
      sse({
        choices: [{
          index: 0,
          delta: {
            tool_calls: [{
              index: 0,
              id: 'call_stream',
              type: 'function',
              function: { name: 'memory_search', arguments: '' },
            }],
          },
          finish_reason: null,
        }],
      });
      sse({
        choices: [{
          index: 0,
          delta: {
            tool_calls: [{
              index: 0,
              function: { arguments: '{"query":"咖啡","limit":3}' },
            }],
          },
          finish_reason: null,
        }],
      });
      sse({ choices: [{ index: 0, delta: {}, finish_reason: 'tool_calls' }] });
      res.end('data: [DONE]\n\n');
    };

    if (parsed.stream) {
      if (providerMode === 'stream-tool' && !hasToolResult) sendStreamTool();
      else sendStreamText();
      return;
    }

    const respond = () => {
      if (providerMode === 'fail') {
        jsonResponse(res, 500, { error: 'provider_failed' });
        return;
      }
      if (providerMode === 'tool-first' && !hasToolResult) {
        jsonResponse(
          res,
          200,
          completion(null, toolCall('memory_search', { query: '咖啡', limit: 3 }))
        );
        return;
      }
      jsonResponse(res, 200, completion('这是 Memory Bot 的真实回复。'));
    };

    if (responseDelayMs > 0) {
      setTimeout(respond, responseDelayMs);
    } else {
      respond();
    }
  });
});

let apiConfigs;
let config;
let credentials;
let sessions;
let tasks;
let runtime;
let registry;
let memory;
let express;
let createAgentRouter;
let apiServer;
let apiBase;

test.before(async () => {
  await new Promise(resolve => providerServer.listen(0, '127.0.0.1', resolve));
  providerPort = providerServer.address().port;

  apiConfigs = require('../server/api-configs');
  config = require('../server/agents/config');
  credentials = require('../server/agents/credentials');
  sessions = require('../server/agents/sessions');
  tasks = require('../server/agents/tasks');
  runtime = require('../server/agents/runtime');
  registry = require('../server/agents/registry');
  memory = require('../server/memory');
  express = require('express');
  createAgentRouter = require('../server/agents/routes').createAgentRouter;

  const added = apiConfigs.addModelProvider({
    name: 'Bot Test Provider',
    baseUrl: `http://127.0.0.1:${providerPort}/v1`,
    apiKey: GLOBAL_KEY,
    models: [
      {
        id: 'bot-test-model',
        name: 'Bot Test Model',
        capabilities: { tools: true, vision: false },
      },
    ],
  });
  assert.ok(added.provider, `provider setup failed: ${JSON.stringify(added)}`);

  config.updateConfig('memory', {
    enabled: true,
    modelProfile: {
      providerId: added.provider.id,
      modelId: 'bot-test-model',
      temperature: 0.2,
      maxTokens: 512,
      timeoutMs: 20000,
    },
  });

  const credential = credentials.putCredential({
    botId: 'memory',
    providerId: added.provider.id,
    apiKey: BOT_KEY,
  });
  config.setCredentialId('memory', credential.credentialId);

  const app = express();
  app.use(express.json());
  app.use(
    createAgentRouter({
      requireAuth: (req, res, next) => next(),
    })
  );
  apiServer = http.createServer(app);
  await new Promise(resolve => apiServer.listen(0, '127.0.0.1', resolve));
  apiBase = `http://127.0.0.1:${apiServer.address().port}`;
});

test.after(async () => {
  if (apiServer) await new Promise(resolve => apiServer.close(resolve));
  await new Promise(resolve => providerServer.close(resolve));
  try {
    fs.rmSync(TMP, { recursive: true, force: true });
  } catch (_) {
    // ignore
  }
});

async function api(pathname, { method = 'GET', body } = {}) {
  const response = await fetch(apiBase + pathname, {
    method,
    headers: { 'Content-Type': 'application/json' },
    body: body ? JSON.stringify(body) : undefined,
  });
  let json = null;
  try {
    json = await response.json();
  } catch (_) {
    // ignore
  }
  return { status: response.status, json };
}

async function waitForTask(taskId, timeoutMs = 5000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const task = tasks.getTask(taskId);
    if (task && tasks.isTerminalStatus(task.status)) return task;
    await new Promise(resolve => setTimeout(resolve, 30));
  }
  return tasks.getTask(taskId);
}

test('Registry：只注册 Memory Bot，状态由真实配置与凭证计算', async () => {
  const agents = registry.listAgents();
  assert.equal(agents.length, 1);
  assert.equal(agents[0].botId, 'memory');
  assert.equal(agents[0].status, 'enabled');
  assert.equal(agents[0].entrypoints.includes('direct_chat'), true);
  assert.equal(agents[0].entrypoints.includes('delegated_task'), true);
  assert.ok(!JSON.stringify(agents).includes(BOT_KEY));

  const current = config.getRuntimeConfig('memory');
  config.setCredentialId('memory', null);
  assert.equal(registry.getAgent('memory').status, 'degraded');
  assert.equal(registry.getAgent('memory').statusReason, 'credential_not_configured');
  config.setCredentialId('memory', current.modelProfile.credentialId);

  assert.throws(
    () => config.updateConfig('memory', { toolAllowlist: ['shell_exec'] }),
    error => error && error.code === 'invalid_config'
  );
  assert.throws(
    () => config.updateConfig('memory', { enabled: 'yes' }),
    error => error && error.code === 'invalid_config'
  );
});

test('凭证库：AES-256-GCM 密文落盘、脱敏读取、真实验证且可重启解密', async () => {
  const raw = fs.readFileSync(credentials.VAULT_FILE, 'utf8');
  assert.ok(!raw.includes(BOT_KEY));
  assert.ok(raw.includes('ciphertext'));
  assert.ok(fs.existsSync(credentials.KEY_FILE));
  assert.ok(!fs.readFileSync(credentials.KEY_FILE, 'utf8').includes(BOT_KEY));

  const list = credentials.listCredentials('memory');
  assert.equal(list.length, 1);
  assert.ok(list[0].keyHint.includes('***') || list[0].keyHint !== BOT_KEY);
  assert.ok(!JSON.stringify(list).includes(BOT_KEY));

  assert.equal(credentials.getCredentialKey(list[0].credentialId, 'memory'), BOT_KEY);
  assert.throws(
    () => credentials.getCredentialKey(list[0].credentialId, 'unknown'),
    error => error && error.code === 'agent_not_found'
  );

  const verified = await credentials.verifyCredential(list[0].credentialId, 'memory');
  assert.equal(verified.ok, true);
  assert.equal(verified.credential.lastVerifyOk, true);
  assert.ok(!JSON.stringify(verified).includes(BOT_KEY));

  credentials.reloadForTests();
  assert.equal(credentials.getCredentialKey(list[0].credentialId, 'memory'), BOT_KEY);
});

test('Bot 会话：创建、读取、追加与跨 Bot/不存在会话拒绝', () => {
  const created = sessions.createSession('memory', { title: '咖啡对话' });
  assert.ok(created.id.startsWith('bs_'));
  assert.equal(created.botId, 'memory');
  const appended = sessions.appendMessages('memory', created.id, [
    { role: 'user', content: '我喜欢拿铁' },
    { role: 'assistant', content: '记下了你的偏好。', toolSteps: [] },
  ]);
  assert.equal(appended.messageCount, 2);
  assert.equal(sessions.getMessages('memory', created.id).length, 2);
  assert.equal(sessions.getSession('memory', 'missing'), null);
  assert.throws(
    () =>
      sessions.appendMessages('memory', 'missing', [
        { role: 'user', content: 'x' },
      ]),
    error => error && error.code === 'agent_session_not_found'
  );
  assert.equal(sessions.listSessions('memory').some(item => item.id === created.id), true);
});

test('直接对话：使用 Bot 独立 Key，真实工具循环与事件可追溯', async () => {
  const session = sessions.createSession('memory', { title: '工具检索' });
  const now = new Date().toISOString();
  fs.writeFileSync(
    path.join(TMP, 'memory.json'),
    JSON.stringify(
      [
        {
          id: 'm-memory-bot-test',
          content: '用户喜欢拿铁咖啡',
          type: 'preference',
          keywords: ['咖啡', '拿铁'],
          confidence: 0.95,
          status: 'active',
          validFrom: now,
          validTo: null,
          createdAt: now,
          updatedAt: now,
          contributions: [
            {
              sessionId: session.id,
              sourceQuote: '我喜欢拿铁咖啡',
              createdAt: now,
              sourceType: 'user',
            },
          ],
        },
      ],
      null,
      2
    )
  );
  memory.loadMemories();
  providerMode = 'tool-first';
  seenAuth.length = 0;

  const result = await runtime.chat('memory', {
    sessionId: session.id,
    message: '请检索我关于咖啡的长期记忆。',
  });

  assert.equal(result.ok, true);
  assert.equal(result.sessionId, session.id);
  assert.equal(result.message.role, 'assistant');
  assert.ok(result.toolSteps.some(step => step.name === 'memory_search'));
  assert.ok(result.evidence.some(item => item.id === 'm-memory-bot-test'));
  assert.ok(seenAuth.length >= 2);
  assert.ok(seenAuth.every(auth => auth === `Bearer ${BOT_KEY}`));
  assert.ok(!JSON.stringify(result).includes(BOT_KEY));

  const history = sessions.getMessages('memory', session.id);
  assert.equal(history.length, 2);
  assert.equal(history[0].role, 'user');
  assert.equal(history[1].role, 'assistant');

  const events = tasks.listEvents('memory', { limit: 20 });
  assert.ok(events.some(event => event.eventType === 'tool.completed'));
  assert.ok(events.some(event => event.eventType === 'model.completed'));
  assert.ok(!JSON.stringify(events).includes(BOT_KEY));
});

test('主控委派：任务状态、结构化结果与取消', async () => {
  providerMode = 'text';
  const task = tasks.createTask({
    botId: 'memory',
    taskType: 'memory.search',
    goal: '整理我的咖啡偏好',
    context: '只返回与咖啡相关的记忆。',
    allowedTools: ['memory_search'],
    deadlineMs: 20000,
  });
  runtime.startTask(task.taskId);
  const finished = await waitForTask(task.taskId);
  assert.equal(finished.status, 'completed');
  assert.equal(finished.result.summary, '这是 Memory Bot 的真实回复。');
  assert.ok(Array.isArray(finished.result.evidence));
  assert.equal(finished.errorCode, null);

  const queued = tasks.createTask({
    botId: 'memory',
    taskType: 'memory.explain',
    goal: '解释一条记忆',
    allowedTools: ['memory_search'],
    deadlineMs: 20000,
  });
  const cancelled = runtime.cancelTask(queued.taskId);
  assert.equal(cancelled.status, 'cancelled');

  assert.throws(
    () =>
      tasks.createTask({
        botId: 'memory',
        taskType: 'shell.exec',
        goal: 'x',
      }),
    error => error && error.code === 'invalid_task_type'
  );
});

test('持久任务队列：并发限制、失败隔离与重启恢复', async () => {
  providerMode = 'text';
  responseDelayMs = 180;
  assert.equal(runtime.getQueueStats().concurrency, 2);

  const goals = ['队列任务 A', '队列任务 B', '队列任务 C'];
  const created = goals.map(goal =>
    tasks.createTask({
      botId: 'memory',
      taskType: 'memory.search',
      goal,
      allowedTools: ['memory_search'],
      deadlineMs: 20000,
    })
  );
  created.forEach(task => runtime.startTask(task.taskId));

  let maxActive = 0;
  const deadline = Date.now() + 8000;
  while (Date.now() < deadline) {
    const stats = runtime.getQueueStats();
    maxActive = Math.max(maxActive, stats.active);
    const finished = created.map(task => tasks.getTask(task.taskId));
    if (finished.every(task => task && tasks.isTerminalStatus(task.status))) break;
    await new Promise(resolve => setTimeout(resolve, 25));
  }
  const finished = created.map(task => tasks.getTask(task.taskId));
  assert.ok(finished.every(task => task.status === 'completed'));
  assert.ok(maxActive <= 2);
  assert.ok(maxActive >= 1);
  assert.equal(runtime.getQueueStats().active, 0);

  const interrupted = tasks.createTask({
    botId: 'memory',
    taskType: 'memory.search',
    goal: '重启恢复任务',
    allowedTools: ['memory_search'],
    deadlineMs: 20000,
  });
  tasks.updateTask(interrupted.taskId, { status: 'running' });
  responseDelayMs = 0;
  // 模拟进程重启：清空内存缓存，从 agent-tasks.json 重新加载 interrupted 状态。
  tasks.reloadForTests();
  const recovered = runtime.initializeTaskQueue();
  assert.ok(recovered.recovered >= 1);
  const recoveredTask = await waitForTask(interrupted.taskId);
  assert.equal(recoveredTask.status, 'completed');
  assert.ok(recoveredTask.attempts >= 1);

  providerMode = 'fail';
  const failing = tasks.createTask({
    botId: 'memory',
    taskType: 'memory.search',
    goal: '失败任务',
    allowedTools: ['memory_search'],
    deadlineMs: 20000,
  });
  runtime.startTask(failing.taskId);
  const failedTask = await waitForTask(failing.taskId);
  assert.equal(failedTask.status, 'failed');
  assert.ok(String(failedTask.errorCode).startsWith('model_'));

  providerMode = 'text';
  const afterFailure = tasks.createTask({
    botId: 'memory',
    taskType: 'memory.search',
    goal: '失败后的队列任务',
    allowedTools: ['memory_search'],
    deadlineMs: 20000,
  });
  runtime.startTask(afterFailure.taskId);
  assert.equal((await waitForTask(afterFailure.taskId)).status, 'completed');
  providerMode = 'text';
});

test('HTTP API：鉴权由外层注入，配置/凭证/会话/任务均走真实接口', async () => {
  const agents = await api('/agents');
  assert.equal(agents.status, 200);
  assert.equal(agents.json.agents.length, 1);
  assert.equal(agents.json.agents[0].botId, 'memory');

  const configResponse = await api('/agents/memory/config');
  assert.equal(configResponse.status, 200);
  assert.equal(configResponse.json.config.botId, 'memory');
  assert.ok(!JSON.stringify(configResponse.json).includes(BOT_KEY));

  const updated = await api('/agents/memory/config', {
    method: 'PUT',
    body: { modelProfile: { temperature: 0.3 } },
  });
  assert.equal(updated.status, 200);
  assert.equal(updated.json.config.modelProfile.temperature, 0.3);

  const credential = await api('/agents/memory/credentials', {
    method: 'POST',
    body: {
      providerId: agents.json.agents[0].model.providerId,
      apiKey: 'bot-replacement-key',
    },
  });
  assert.equal(credential.status, 201);
  assert.ok(!JSON.stringify(credential.json).includes('bot-replacement-key'));

  const verified = await api('/agents/memory/credentials/verify', {
    method: 'POST',
    body: { credentialId: credential.json.credential.credentialId },
  });
  assert.equal(verified.status, 200);
  assert.equal(verified.json.ok, true);

  const session = await api('/agents/memory/sessions', {
    method: 'POST',
    body: { title: 'API 会话' },
  });
  assert.equal(session.status, 201);
  const sessionId = session.json.session.id;

  providerMode = 'text';
  const chat = await api('/agents/memory/chat', {
    method: 'POST',
    body: { sessionId, message: '你好' },
  });
  assert.equal(chat.status, 200);
  assert.equal(chat.json.ok, true);
  assert.ok(!JSON.stringify(chat.json).includes('bot-replacement-key'));

  providerMode = 'stream-text';
  const streamResponse = await fetch(apiBase + '/agents/memory/chat/stream', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ sessionId, message: '再说一次' }),
  });
  assert.equal(streamResponse.status, 200);
  const streamText = await streamResponse.text();
  assert.ok(streamText.includes('"type":"meta"'));
  assert.ok(streamText.includes('"type":"delta"'));
  assert.ok(streamText.includes('这是 '));
  assert.ok(streamText.includes('流式 '));
  assert.ok(streamText.includes('"type":"done"'));
  assert.ok(!streamText.includes('bot-replacement-key'));

  providerMode = 'stream-tool';
  const toolStream = await fetch(apiBase + '/agents/memory/chat/stream', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ sessionId, message: '检索咖啡记忆' }),
  });
  const toolStreamText = await toolStream.text();
  assert.ok(toolStreamText.includes('"type":"tool_start"'));
  assert.ok(toolStreamText.includes('"type":"tool_end"'));
  assert.ok(toolStreamText.includes('"type":"delta"'));
  assert.ok(toolStreamText.includes('"type":"done"'));

  providerMode = 'text';
  const task = await api('/agent-tasks', {
    method: 'POST',
    body: {
      botId: 'memory',
      taskType: 'memory.search',
      goal: '查一下我的咖啡偏好',
      allowedTools: ['memory_search'],
      deadlineMs: 20000,
    },
  });
  assert.equal(task.status, 202);
  const finished = await waitForTask(task.json.task.taskId);
  assert.equal(finished.status, 'completed');

  const approval = await api('/agents/memory/approvals', {
    method: 'POST',
    body: {
      operation: 'update',
      payload: { id: 'm-memory-bot-test', content: '用户喜欢冷萃咖啡' },
    },
  });
  assert.equal(approval.status, 201);
  assert.equal(approval.json.approval.status, 'pending');
  const approvalId = approval.json.approval.approvalId;

  const beforeApprove = await api(`/agent-approvals/${approvalId}/execute`, {
    method: 'POST',
    body: {},
  });
  assert.equal(beforeApprove.status, 409);

  const approved = await api(`/agent-approvals/${approvalId}/approve`, {
    method: 'POST',
    body: {},
  });
  assert.equal(approved.status, 200);
  assert.equal(approved.json.approval.status, 'approved');

  const executed = await api(`/agent-approvals/${approvalId}/execute`, {
    method: 'POST',
    body: {},
  });
  assert.equal(executed.status, 200);
  assert.equal(executed.json.approval.status, 'completed');
  assert.equal(executed.json.approval.result.ok, true);
  assert.ok(!JSON.stringify(executed.json).includes('bot-replacement-key'));

  const events = await api('/agents/memory/events?limit=20');
  assert.equal(events.status, 200);
  assert.ok(Array.isArray(events.json.events));
  assert.ok(!JSON.stringify(events.json).includes('bot-replacement-key'));
});
