/* global __dirname */
/**
 * 主控 → Memory Bot 派发与结果回传测试。
 * 使用真实 HTTP stub Provider；验证任务创建、Bot Runtime、任务结果、
 * 主控会话投递与事件 outbox，不依赖外部模型。
 */
const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');
const test = require('node:test');
const assert = require('node:assert');

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'bluebird-agent-dispatch-'));
process.env.BLUEBIRD_DATA_DIR = TMP;
process.env.DEEPSEEK_API_KEY = '';
process.env.BLUEBIRD_AGENT_TOOLS = '';
process.env.BLUEBIRD_MONITORING = '0';
process.env.BLUEBIRD_ALLOW_PRIVATE_BASE_URL = '1';

let providerServer;
let apiConfigs;
let config;
let credentials;
let registry;
let tasks;
let botSessions;
let mainSessions;
let tool;
let runtime;
let agentRuntime;
let apiServer;
let apiBase;
let providerId;
let providerBase;
let providerPort;

function json(res, status, payload) {
  res.writeHead(status, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify(payload));
}

test.before(async () => {
  providerServer = http.createServer((req, res) => {
    if (req.method === 'GET' && req.url === '/v1/models') {
      if (req.headers.authorization !== 'Bearer dispatch-bot-key') {
        json(res, 401, { error: 'unauthorized' });
        return;
      }
      json(res, 200, { data: [{ id: 'dispatch-test-model' }] });
      return;
    }
    if (req.method !== 'POST' || req.url !== '/v1/chat/completions') {
      json(res, 404, { error: 'not_found' });
      return;
    }
    if (req.headers.authorization !== 'Bearer dispatch-bot-key') {
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
      const hasToolResult = messages.some(message => message.role === 'tool');
      const lastText = String(messages.at(-1)?.content || '');
      if (lastText.includes('FAIL_TASK')) {
        json(res, 500, { error: 'provider_failed' });
        return;
      }
      if (
        Array.isArray(parsed.tools) &&
        parsed.tools.some(item => item.function?.name === 'delegate_to_bot') &&
        !hasToolResult &&
        lastText.includes('DELEGATE')
      ) {
        json(res, 200, {
          id: 'chatcmpl-dispatch-tool',
          object: 'chat.completion',
          created: Math.floor(Date.now() / 1000),
          model: 'dispatch-test-model',
          choices: [
            {
              index: 0,
              message: {
                role: 'assistant',
                content: null,
                tool_calls: [
                  {
                    id: 'call_dispatch',
                    type: 'function',
                    function: {
                      name: 'delegate_to_bot',
                      arguments: JSON.stringify({
                        botId: 'memory',
                        taskType: 'memory.search',
                        goal: '主 Agent 派发测试',
                        allowedTools: ['memory_search'],
                      }),
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
      const answer = `已处理：${messages.at(-1)?.content || ''}`;
      json(res, 200, {
        id: 'chatcmpl-dispatch',
        object: 'chat.completion',
        created: Math.floor(Date.now() / 1000),
        model: 'dispatch-test-model',
        choices: [
          {
            index: 0,
            message: { role: 'assistant', content: answer },
            finish_reason: 'stop',
          },
        ],
        usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
      });
    });
  });
  await new Promise(resolve => providerServer.listen(0, '127.0.0.1', resolve));
  providerPort = providerServer.address().port;
  providerBase = `http://127.0.0.1:${providerPort}/v1`;

  const express = require('express');
  const { createAgentRouter } = require('../server/agents/routes');
  const app = express();
  app.use(express.json());
  app.use(createAgentRouter({ requireAuth: (req, res, next) => next() }));
  apiServer = http.createServer(app);
  await new Promise(resolve => apiServer.listen(0, '127.0.0.1', resolve));
  apiBase = `http://127.0.0.1:${apiServer.address().port}`;

  apiConfigs = require('../server/api-configs');
  config = require('../server/agents/config');
  credentials = require('../server/agents/credentials');
  registry = require('../server/agents/registry');
  tasks = require('../server/agents/tasks');
  botSessions = require('../server/agents/sessions');
  mainSessions = require('../server/sessions');
  tool = require('../server/tool-dispatch-bot').definition;
  runtime = require('../server/agents/runtime');
  agentRuntime = require('../server/agent-runtime');

  const added = apiConfigs.addModelProvider({
    name: 'Dispatch Test Provider',
    baseUrl: providerBase,
    apiKey: 'global-not-used',
    models: [
      {
        id: 'dispatch-test-model',
        name: 'Dispatch Test Model',
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
      modelId: 'dispatch-test-model',
      temperature: 0.2,
      maxTokens: 256,
      timeoutMs: 20000,
    },
  });
  const credential = credentials.putCredential({
    botId: 'memory',
    providerId,
    apiKey: 'dispatch-bot-key',
  });
  config.setCredentialId('memory', credential.credentialId);
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

async function waitForTask(taskId, timeoutMs = 5000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const task = tasks.getTask(taskId);
    if (task && tasks.isTerminalStatus(task.status)) return task;
    await new Promise(resolve => setTimeout(resolve, 25));
  }
  return tasks.getTask(taskId);
}

test('派发工具：校验 Bot/任务类型/边界，且不暴露给 Bot 自身工具清单', () => {
  assert.equal(tool.name, 'delegate_to_bot');
  assert.equal(
    tool.validate({ botId: 'other', taskType: 'memory.search', goal: 'x' }).ok,
    false
  );
  assert.equal(
    tool.validate({ botId: 'memory', taskType: 'shell.exec', goal: 'x' }).ok,
    false
  );
  assert.equal(tool.validate({ botId: 'memory', taskType: 'memory.search' }).ok, false);
  assert.equal(
    tool.validate({
      botId: 'memory',
      taskType: 'memory.search',
      goal: 'x',
      allowedTools: ['shell_exec'],
    }).ok,
    false
  );
  assert.equal(
    tool.validate({ botId: 'memory', taskType: 'memory.search', goal: '查一下' }).ok,
    true
  );
  assert.equal(
    require('../server/agents/manifest').MEMORY_BOT_MANIFEST.toolAllowlist.includes(
      'delegate_to_bot'
    ),
    false
  );
});

test('主控派发：创建带 parentSessionId 的任务，Bot Runtime 完成后结果写回主控会话', async () => {
  const main = mainSessions.createSession({ title: '主控派发测试' });
  const result = await tool.handler(
    {
      botId: 'memory',
      taskType: 'memory.search',
      goal: '整理我的咖啡偏好',
      context: '只返回与咖啡相关的记忆。',
      allowedTools: ['memory_search'],
    },
    {
      sessionId: main.id,
      userText: '请让 Memory Bot 整理我的咖啡偏好',
      userMessageId: 'main-user-1',
    }
  );

  assert.equal(result.ok, true);
  assert.ok(result.taskId.startsWith('task_'));
  assert.equal(result.status, 'queued');
  assert.equal(result.parentSessionId, main.id);
  assert.ok(result.sessionId.startsWith('bs_'));

  const finished = await waitForTask(result.taskId);
  assert.equal(finished.status, 'completed');
  assert.equal(finished.parentSessionId, main.id);
  assert.equal(finished.result.summary.startsWith('已处理：'), true);
  assert.equal(finished.deliveryErrorCode, null);
  assert.ok(finished.deliveredToParentAt);

  const history = mainSessions.getMessages(main.id);
  assert.ok(history.some(message => message.content.includes('【Memory Bot 任务完成】')));
  assert.ok(history.some(message => message.content.includes(result.taskId)));

  const events = tasks.listEvents('memory', { limit: 100 });
  assert.ok(
    events.some(
      event => event.taskId === result.taskId && event.eventType === 'task.completed'
    )
  );

  const countBeforeRepeat = mainSessions.getMessages(main.id).length;
  const resultDelivery = require('../server/agents/result-delivery');
  resultDelivery.deliverTaskOutcome(finished, {
    status: 'completed',
    result: finished.result,
  });
  assert.equal(mainSessions.getMessages(main.id).length, countBeforeRepeat);

  const filtered = tasks.listTasks('memory', { parentSessionId: main.id });
  assert.equal(filtered.length, 1);
  assert.equal(filtered[0].taskId, result.taskId);
  assert.equal(tasks.listTasks('memory', { parentSessionId: 'other' }).length, 0);
});

test('主 Agent 工具循环：模型可调用 delegate_to_bot 并把任务交给 Bot Runtime', async () => {
  const main = mainSessions.createSession({ title: '主 Agent 工具派发' });
  const outcome = await agentRuntime.runAgentTurn({
    providerId,
    modelId: 'dispatch-test-model',
    sessionId: main.id,
    userText: 'DELEGATE 请整理一条记忆',
    messages: [
      { role: 'system', content: '你可以调用 delegate_to_bot。' },
      { role: 'user', content: 'DELEGATE 请整理一条记忆' },
    ],
    policy: {
      schemaVersion: 1,
      mode: 'bounded_autonomy',
      tools: { allowedTools: ['delegate_to_bot'], maxToolCalls: 2, maxReadOnlyRetries: 0 },
      budgets: { maxRounds: 2, maxTotalMs: 10000 },
    },
    credentialKey: 'dispatch-bot-key',
    timeout: 10000,
  });
  assert.equal(outcome.rawReply.includes('已处理'), true);
  assert.equal(outcome.toolSteps.length, 1);
  assert.equal(outcome.toolSteps[0].name, 'delegate_to_bot');
  const task = tasks.listTasks('memory', { parentSessionId: main.id })[0];
  assert.ok(task);
  const finished = await waitForTask(task.taskId);
  assert.equal(finished.status, 'completed');
  assert.ok(mainSessions.getMessages(main.id).some(message =>
    message.content.includes('【Memory Bot 任务完成】')
  ));
});

async function readSseUntil(url, predicate, timeoutMs = 6000) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch(url, { signal: controller.signal });
    assert.equal(response.status, 200);
    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let buffer = '';
    while (true) {
      const { done, value } = await reader.read();
      if (done) throw new Error('sse_closed_before_event');
      buffer += decoder.decode(value, { stream: true });
      let sep = buffer.indexOf('\n\n');
      while (sep >= 0) {
        const frame = buffer.slice(0, sep);
        buffer = buffer.slice(sep + 2);
        const line = frame.split('\n').find(item => item.startsWith('data:'));
        if (line) {
          const event = JSON.parse(line.slice(5).trim());
          if (predicate(event)) return event;
        }
        sep = buffer.indexOf('\n\n');
      }
    }
  } finally {
    clearTimeout(timer);
    controller.abort();
  }
}

test('主控结果 SSE：snapshot 重连可见，实时结果无需轮询', async () => {
  const main = mainSessions.createSession({ title: 'SSE 结果测试' });
  const first = await tool.handler(
    {
      botId: 'memory',
      taskType: 'memory.search',
      goal: '生成一条 SSE 结果',
      allowedTools: ['memory_search'],
    },
    { sessionId: main.id, userText: '生成结果', userMessageId: 'sse-user-1' }
  );
  await waitForTask(first.taskId);

  const snapshot = await readSseUntil(
    `${apiBase}/agent-results/stream?sessionId=${encodeURIComponent(main.id)}`,
    event =>
      event.type === 'snapshot' &&
      Array.isArray(event.results) &&
      event.results.some(item => item.taskId === first.taskId && item.message)
  );
  assert.equal(snapshot.type, 'snapshot');
  const snapshotItem = snapshot.results.find(item => item.taskId === first.taskId);
  assert.ok(snapshotItem.message.id.startsWith('bot-result-'));
  assert.ok(snapshotItem.message.content.includes('【Memory Bot 任务完成】'));

  const live = mainSessions.createSession({ title: 'SSE 实时结果测试' });
  const eventPromise = readSseUntil(
    `${apiBase}/agent-results/stream?sessionId=${encodeURIComponent(live.id)}`,
    event => event.type === 'result' && event.sessionId === live.id
  );
  const second = await tool.handler(
    {
      botId: 'memory',
      taskType: 'memory.search',
      goal: '实时 SSE 结果',
      allowedTools: ['memory_search'],
    },
    { sessionId: live.id, userText: '实时结果', userMessageId: 'sse-user-2' }
  );
  const liveEvent = await eventPromise;
  assert.equal(liveEvent.taskId, second.taskId);
  assert.ok(liveEvent.message.id.startsWith('bot-result-'));
});

test('失败回传：Bot 执行失败时主控会话收到失败原因，不伪造完成', async () => {
  const main = mainSessions.createSession({ title: '失败回传测试' });
  const result = await tool.handler(
    {
      botId: 'memory',
      taskType: 'memory.search',
      goal: 'FAIL_TASK 触发失败',
      allowedTools: ['memory_search'],
    },
    { sessionId: main.id, userText: '触发失败', userMessageId: 'sse-user-fail' }
  );
  const finished = await waitForTask(result.taskId);
  assert.equal(finished.status, 'failed');
  assert.ok(finished.errorCode);
  assert.equal(finished.deliveryStatus, 'delivered');
  const history = mainSessions.getMessages(main.id);
  assert.ok(history.some(message => message.content.includes('【Memory Bot 任务未完成】')));
  assert.ok(history.some(message => message.content.includes('错误码：')));
});

test('事件 outbox：主事件文件写入失败时保留事件，恢复后可补写并读取', async () => {
  const event = {
    eventId: 'evt_outbox_test',
    taskId: 'task_outbox',
    runId: null,
    botId: 'memory',
    sessionId: null,
    timestamp: new Date().toISOString(),
    eventType: 'task.completed',
    payload: { status: 'completed' },
    correlationId: 'task_outbox',
  };
  fs.writeFileSync(
    tasks.OUTBOX_FILE,
    JSON.stringify({ version: 1, events: [event] }, null, 2)
  );
  tasks.reloadForTests();
  const flushed = tasks.flushEventOutbox();
  assert.equal(flushed.flushed, 1);
  const events = tasks.listEvents('memory', { limit: 100 });
  assert.ok(events.some(item => item.eventId === event.eventId));
  const outbox = JSON.parse(fs.readFileSync(tasks.OUTBOX_FILE, 'utf8'));
  assert.deepEqual(outbox.events, []);
});

test('结果投递失败不伪造完成：主控会话被删除时记录 deliveryErrorCode', async () => {
  const main = mainSessions.createSession({ title: '将删除的主控会话' });
  const result = await tool.handler(
    {
      botId: 'memory',
      taskType: 'memory.explain',
      goal: '解释一条记忆',
      allowedTools: ['memory_search'],
    },
    { sessionId: main.id, userText: '解释一下', userMessageId: 'main-user-2' }
  );
  assert.equal(result.ok, true);
  mainSessions.deleteSession(main.id);

  const finished = await waitForTask(result.taskId);
  assert.equal(finished.status, 'completed');
  assert.ok(finished.deliveredToParentAt === null);
  assert.ok(finished.deliveryErrorCode);
  assert.equal(finished.result.summary.startsWith('已处理：'), true);
});
