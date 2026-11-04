/* global require, process, __dirname */
/**
 * Phase 1 / P2：runtime 接入幂等账本回归。
 *
 * 覆盖用户明确要求的五类语义：
 *  a) 同任务同工具重复调用 → 命中 succeeded 复用结果，底层 handler 只执行 1 次；
 *  b) begin 后未补终态（崩溃残留）→ 任务收口为 recovery，handler 不再执行；
 *  c) 不同任务 / 不同 stepId 同参调用 → 各自独立执行；
 *  d) 工具抛错 → 账本 failed，重试原地 attempt+1，同键仍只有 1 行；
 *  e) 无副作用工具路径 → 不产生任何账本行，行为不变。
 * 额外：f) 证明 begin 的落盘发生在 handler 真正执行之前。
 *
 * 隔离纪律：BLUEBIRD_DATA_DIR 在 require server/ 之前指向临时目录。
 */
const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');
const test = require('node:test');
const assert = require('node:assert');

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'bluebird-side-effect-'));
process.env.BLUEBIRD_DATA_DIR = TMP;
process.env.DEEPSEEK_API_KEY = '';
process.env.BLUEBIRD_AGENT_TOOLS = '';
process.env.BLUEBIRD_MONITORING = '0';
process.env.BLUEBIRD_ALLOW_PRIVATE_BASE_URL = '1';
process.env.BLUEBIRD_AGENT_HEARTBEAT_MS = '80';

const agent = require('../server/agent-runtime');
const ledger = require('../server/agents/op-ledger');
const { createSideEffectGuard } = require('../server/agents/side-effect-guard');
const tasks = require('../server/agents/tasks');
const runtime = require('../server/agents/runtime');

const AGENTS_DIR = path.join(TMP, 'agents');

function resetAll() {
  fs.rmSync(AGENTS_DIR, { recursive: true, force: true });
  tasks.reloadForTests();
}

function register(name, handler) {
  agent.registerTool({
    name,
    description: `P2 测试工具 ${name}`,
    parameters: {
      type: 'object',
      properties: { x: { type: 'number' }, text: { type: 'string' } },
      required: ['x'],
    },
    readOnly: false,
    timeoutMs: 2000,
    validate: args =>
      args && typeof args === 'object'
        ? { ok: true, args }
        : { ok: false, error: 'bad_args' },
    handler,
  });
}

function contextFor(guard) {
  // 写入工具要求运行层拿到会话与用户原话（unauthorized_write 门禁）。
  return {
    sessionId: 'bs_p2',
    userText: 'P2 测试用户原话',
    cache: new Map(),
    sideEffect: guard,
  };
}

function rowsFor(taskId) {
  return Object.values(ledger.read().ops).filter(entry => entry.taskId === taskId);
}

test.after(() => {
  for (const name of ['p2_write', 'p2_probe', 'p2_flaky', 'p2_read']) agent.unregisterTool(name);
  try {
    fs.rmSync(TMP, { recursive: true, force: true });
  } catch (_) {
    // ignore
  }
});

// ---- a) 重复调用复用，handler 只执行一次 ----

test('a. 同任务同工具同参数：第二次命中 succeeded 复用结果，handler 只执行 1 次', async () => {
  resetAll();
  let calls = 0;
  register('p2_write', async args => {
    calls += 1;
    return { ok: true, summary: '已写入', entryId: `m_${args.x}` };
  });

  const guard = createSideEffectGuard({ agentId: 'memory', taskId: 'task_p2_a' });
  const r1 = await agent.executeToolCall('p2_write', { x: 1, text: '喜欢冰美式' }, contextFor(guard));
  const r2 = await agent.executeToolCall('p2_write', { x: 1, text: '喜欢冰美式' }, contextFor(guard));

  assert.strictEqual(r1.ok, true);
  assert.strictEqual(r1.reused, undefined);
  assert.strictEqual(r2.ok, true);
  assert.strictEqual(r2.reused, true);

  console.log(`[p2-a] handlerCalls=${calls} reused=${r2.reused === true} opKey=${r2.opKey}`);
  assert.strictEqual(calls, 1, '底层副作用工具必须只执行 1 次');
  assert.strictEqual(r2.entryId, 'm_1', '复用的是第一次的真实结果体');

  const rows = rowsFor('task_p2_a');
  assert.strictEqual(rows.length, 1, '同一 opKey 只有 1 行');
  assert.strictEqual(rows[0].status, 'succeeded');
  assert.strictEqual(rows[0].attempt, 1);
  assert.ok(/^sha256:[0-9a-f]{64}$/.test(rows[0].resultDigest));
  assert.strictEqual(r2.resultDigest, rows[0].resultDigest, '复用方必须能回答复用的是哪次结果');
});

// ---- f) begin 先于执行 ----

test('f. begin 的落盘发生在 handler 执行之前', async () => {
  resetAll();
  let seen = null;
  register('p2_probe', async args => {
    // handler 一开始就同步读账本：此时应已存在 started 行
    const rows = rowsFor('task_p2_f');
    seen = rows.length ? { status: rows[0].status, opKey: rows[0].opKey } : null;
    return { ok: true, summary: 'probe', x: args.x };
  });

  const guard = createSideEffectGuard({ agentId: 'memory', taskId: 'task_p2_f' });
  const result = await agent.executeToolCall('p2_probe', { x: 7 }, contextFor(guard));

  assert.strictEqual(result.ok, true);
  assert.ok(seen, 'handler 执行时账本里必须已有记录');
  assert.strictEqual(seen.status, 'started', '执行前写的是 started 意图');
  assert.strictEqual(rowsFor('task_p2_f').length, 1);
});

// ---- c) 不同任务 / 不同 stepId 不互相命中 ----

test('c. 不同任务或不同参数（stepId）同参调用各自独立执行', async () => {
  resetAll();
  let calls = 0;
  register('p2_write', async () => {
    calls += 1;
    return { ok: true, summary: 'done' };
  });

  const taskA = createSideEffectGuard({ agentId: 'memory', taskId: 'task_p2_c1' });
  const taskB = createSideEffectGuard({ agentId: 'memory', taskId: 'task_p2_c2' });

  await agent.executeToolCall('p2_write', { x: 1 }, contextFor(taskA));
  const otherTask = await agent.executeToolCall('p2_write', { x: 1 }, contextFor(taskB));
  const otherStep = await agent.executeToolCall('p2_write', { x: 2 }, contextFor(taskA));

  assert.strictEqual(otherTask.reused, undefined, '不同任务必须重新执行');
  assert.strictEqual(otherStep.reused, undefined, '不同参数=不同 stepId，必须重新执行');
  assert.strictEqual(calls, 3);
  assert.strictEqual(rowsFor('task_p2_c1').length, 2);
  assert.strictEqual(rowsFor('task_p2_c2').length, 1);
});

// ---- d) 失败 → failed，重试原地 attempt+1 ----

test('d. 工具抛错写 failed；重试按既有策略，同键仍只有 1 行', async () => {
  resetAll();
  let calls = 0;
  register('p2_flaky', async () => {
    calls += 1;
    if (calls === 1) throw new Error('boom');
    return { ok: true, summary: 'recovered' };
  });

  const guard = createSideEffectGuard({ agentId: 'memory', taskId: 'task_p2_d' });
  const first = await agent.executeToolCall('p2_flaky', { x: 3 }, contextFor(guard));

  const rowsAfterFail = rowsFor('task_p2_d');
  assert.strictEqual(first.ok, false);
  assert.strictEqual(first.code, 'tool_error');
  assert.strictEqual(rowsAfterFail.length, 1);
  assert.strictEqual(rowsAfterFail[0].status, 'failed');
  assert.strictEqual(rowsAfterFail[0].errorCode, 'tool_error');

  const second = await agent.executeToolCall('p2_flaky', { x: 3 }, contextFor(guard));

  const rowsAfterRetry = rowsFor('task_p2_d');
  assert.strictEqual(second.ok, true);
  assert.strictEqual(second.reused, undefined, 'failed 不是复用，是原地重试');
  assert.strictEqual(calls, 2, '重试确实重新执行了一次');
  assert.strictEqual(rowsAfterRetry.length, 1, '同 opKey 绝不产生第二行');
  assert.strictEqual(rowsAfterRetry[0].attempt, 2);
  assert.strictEqual(rowsAfterRetry[0].status, 'succeeded');
});

// ---- e) 无副作用工具不记账 ----

test('e. 无副作用工具（readOnly）路径：零账本行，行为不变', async () => {
  resetAll();
  let calls = 0;
  agent.registerTool({
    name: 'p2_read',
    description: 'P2 只读工具',
    parameters: { type: 'object', properties: { q: { type: 'string' } }, required: ['q'] },
    readOnly: true,
    timeoutMs: 1000,
    validate: args => ({ ok: true, args }),
    handler: async () => {
      calls += 1;
      return { ok: true, summary: 'read' };
    },
  });

  const guard = createSideEffectGuard({ agentId: 'memory', taskId: 'task_p2_e' });
  const ctx = contextFor(guard);
  const r1 = await agent.executeToolCall('p2_read', { q: '咖啡' }, ctx);
  const r2 = await agent.executeToolCall('p2_read', { q: '咖啡' }, ctx);

  assert.strictEqual(r1.ok, true);
  assert.strictEqual(r2.deduped, true);
  assert.strictEqual(calls, 1);
  assert.deepStrictEqual(ledger.read().ops, {}, '只读工具不得产生账本行');
});

// ---- b) 崩溃残留 → recovery（真实 runtime 跑一遍） ----

let providerServer;
let providerBase;

async function setupProvider() {
  providerServer = http.createServer((req, res) => {
    if (req.method === 'GET' && req.url === '/v1/models') {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ data: [{ id: 'p2-test-model' }] }));
      return;
    }
    if (req.method !== 'POST' || req.url !== '/v1/chat/completions') {
      res.writeHead(404);
      res.end('{}');
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
      const reply = (payload, status = 200) => {
        res.writeHead(status, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify(payload));
      };
      const completion = content => ({
        id: 'chatcmpl-p2',
        object: 'chat.completion',
        created: Math.floor(Date.now() / 1000),
        model: 'p2-test-model',
        choices: [
          {
            index: 0,
            message: { role: 'assistant', content },
            finish_reason: 'stop',
          },
        ],
        usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
      });

      if (!hasToolResult) {
        reply({
          id: 'chatcmpl-p2-tool',
          object: 'chat.completion',
          created: Math.floor(Date.now() / 1000),
          model: 'p2-test-model',
          choices: [
            {
              index: 0,
              message: {
                role: 'assistant',
                content: null,
                tool_calls: [
                  {
                    id: 'call_p2_write',
                    type: 'function',
                    function: { name: 'memory_remember', arguments: JSON.stringify({ x: 2 }) },
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
      reply(completion('已处理 P2_UNKNOWN 任务'));
    });
  });
  await new Promise(resolve => providerServer.listen(0, '127.0.0.1', resolve));
  providerBase = `http://127.0.0.1:${providerServer.address().port}/v1`;

  const apiConfigs = require('../server/api-configs');
  const config = require('../server/agents/config');
  const credentials = require('../server/agents/credentials');
  const added = apiConfigs.addModelProvider({
    name: 'P2 Test Provider',
    baseUrl: providerBase,
    apiKey: 'global-not-used',
    models: [{ id: 'p2-test-model', name: 'P2 Test Model', capabilities: { tools: true } }],
  });
  assert.ok(added.provider, JSON.stringify(added));
  config.updateConfig('memory', {
    enabled: true,
    modelProfile: {
      providerId: added.provider.id,
      modelId: 'p2-test-model',
      temperature: 0.2,
      maxTokens: 256,
      timeoutMs: 20000,
    },
  });
  const credential = credentials.putCredential({
    botId: 'memory',
    providerId: added.provider.id,
    apiKey: 'p2-bot-key',
  });
  config.setCredentialId('memory', credential.credentialId);
}

async function waitForTask(taskId, timeoutMs = 15000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const task = tasks.getTask(taskId);
    if (task && tasks.isTerminalStatus(task.status)) return task;
    await new Promise(resolve => setTimeout(resolve, 25));
  }
  return tasks.getTask(taskId);
}

test('b. begin 后未补终态（崩溃残留）→ 任务 recovery，工具不再次执行', async () => {
  resetAll();
  await setupProvider();

  let calls = 0;
  // 覆盖同名工具，仅为计数；readOnly:false 与真身一致。
  register('memory_remember', async () => {
    calls += 1;
    return { ok: true, summary: 'written' };
  });

  try {
    const task = tasks.createTask({
      botId: 'memory',
      taskType: 'memory.search',
      goal: 'P2_UNKNOWN 任务',
      allowedTools: ['memory_remember'],
      deadlineMs: 20000,
    });

    // 模拟「上次进程写 started 后被杀」：账本留 started 行，副作用按已发生计 1 次。
    ledger.begin({
      agentId: 'memory',
      taskId: task.taskId,
      stepId: ledger.deriveStepId({ toolName: 'memory_remember', args: { x: 2 } }),
      toolName: 'memory_remember',
      args: { x: 2 },
    });
    calls = 1;

    runtime.startTask(task.taskId);
    const finished = await waitForTask(task.taskId);

    console.log(
      `[p2-b] status=${finished && finished.status} handlerCalls=${calls}` +
        ` ledgerStatus=${rowsFor(task.taskId)[0] && rowsFor(task.taskId)[0].status}`
    );
    assert.strictEqual(finished && finished.status, 'recovery');
    assert.strictEqual(calls, 1, '命中 started 绝不自动重试');
    const rows = rowsFor(task.taskId);
    assert.strictEqual(rows.length, 1);
    assert.strictEqual(rows[0].status, 'unknown', 'started 必须收敛为 unknown 等人工核对');
    assert.strictEqual(finished.errorCode, 'side_effect_unknown');
  } finally {
    if (providerServer) {
      if (typeof providerServer.closeAllConnections === 'function') {
        providerServer.closeAllConnections();
      }
      await new Promise(resolve => providerServer.close(resolve));
      providerServer = null;
    }
  }
});
