/**
 * 审计 P2 遗留项的运行时守卫：
 *   - P2-05：轮次上限按本次 policy 的 maxRounds 判定（不是全局 MAX_ROUNDS）；
 *   - P2-06：一次请求里连续调用工具时，外部 AbortSignal 上不留累积监听器；
 *   - P2-04：任务的 deadlineMs 在运行时真的被执行（到期收敛成 timed_out）。
 *
 * 隔离保证：落盘全部指向系统临时目录；模型走注入的桩，不请求外部服务。
 * 运行：node --test tests/agent-runtime-guards.test.js
 */
const fs = require('fs');
const os = require('os');
const path = require('path');
const { getEventListeners } = require('events');
const test = require('node:test');
const assert = require('node:assert');

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'bluebird-runtime-guards-'));
const SERVER = path.join(__dirname, '..', 'server');

process.env.BLUEBIRD_DATA_DIR = TMP;
process.env.MEMORY_ENABLED = 'true';
process.env.DEEPSEEK_API_KEY = 'stub-key-runtime-guards';
process.env.BLUEBIRD_AGENT_TOOLS = '';
process.env.BLUEBIRD_MONITORING = '0';
process.env.BLUEBIRD_ALLOW_PRIVATE_BASE_URL = '1';
// 全局硬上限拉到 5：只有这样，policy 里的 maxRounds=2 才可能被区分出来。
process.env.BLUEBIRD_AGENT_MAX_ROUNDS = '5';

// ---- 模型桩：可返回文本、工具调用，或挂起直到被 abort ----
let modelResponder = null;

function abortError() {
  const error = new Error('The operation was aborted');
  error.name = 'AbortError';
  return error;
}

const openaiTarget = require.resolve('openai', { paths: [SERVER] });
require.cache[openaiTarget] = {
  id: openaiTarget,
  filename: openaiTarget,
  loaded: true,
  exports: class StubOpenAI {
    constructor() {
      this.chat = {
        completions: {
          create: (body, options) => {
            const responder = modelResponder || (() => textCompletion('（无响应）'));
            return Promise.resolve(responder(body, options));
          },
        },
      };
    }
  },
};

function textCompletion(content) {
  return {
    model: 'stub-model',
    choices: [{ index: 0, message: { role: 'assistant', content }, finish_reason: 'stop' }],
  };
}

function toolCallCompletion(name, args) {
  return {
    model: 'stub-model',
    choices: [
      {
        index: 0,
        message: {
          role: 'assistant',
          content: null,
          tool_calls: [
            {
              id: `call_${name}`,
              type: 'function',
              function: { name, arguments: JSON.stringify(args) },
            },
          ],
        },
        finish_reason: 'tool_calls',
      },
    ],
  };
}

// 挂起直到 signal 被中止：用来证明任务 deadline 真的能打断上游模型调用。
function hangingCompletion(options) {
  return new Promise((resolve, reject) => {
    const signal = options && options.signal;

    if (!signal) {
      reject(new Error('模型调用没有收到 abort 信号'));
      return;
    }

    if (signal.aborted) {
      reject(abortError());
      return;
    }

    signal.addEventListener('abort', () => reject(abortError()), { once: true });
  });
}

const agentRuntime = require(path.join(SERVER, 'agent-runtime.js'));
const { parseTextualToolCalls } = require(path.join(SERVER, 'textual-tool-calls.js'));
const { auditTaskClaims } = require(path.join(SERVER, 'task-claim-guard.js'));

// 每次探针调用记录 seq：正文封装解析出的调用必须真的执行到 handler。
const probeSeqs = [];

agentRuntime.registerTool({
  name: 'guard_probe',
  description: '守卫探针：记录一次调用并返回固定结果',
  parameters: {
    type: 'object',
    properties: { seq: { type: 'number' } },
  },
  validate: args => ({ ok: true, args: args && typeof args === 'object' ? args : {} }),
  handler: async args => {
    probeSeqs.push(args && args.seq);
    return {
      ok: true,
      summary: 'probe',
      seq: args && args.seq,
    };
  },
  readOnly: true,
  risk: 'read',
  timeoutMs: 2000,
});

// 与线上观测到的形态一致（全角 ｜）。也用于构造半角变体。
function dsmlEnvelope(calls, bar = '｜｜') {
  const lines = [`<${bar}DSML${bar} calls>`];
  for (const call of calls) {
    lines.push(`<${bar}DSML${bar} invoke name="${call.name}">`);
    for (const [key, value] of Object.entries(call.args || {})) {
      lines.push(
        `<${bar}DSML${bar} parameter name="${key}" string="true">${String(value)}</${bar}DSML${bar} parameter>`
      );
    }
    lines.push(`</${bar}DSML${bar} invoke>`);
  }
  lines.push(`</${bar}DSML${bar} calls>`);
  return lines.join('\n');
}

function policyWith(budgets = {}) {
  return {
    schemaVersion: 1,
    mode: 'bounded_autonomy',
    planning: { generatePlan: false, stagedExecution: false },
    tools: {
      allowedTools: ['guard_probe'],
      maxToolCalls: 8,
      maxReadOnlyRetries: 0,
    },
    budgets: {
      maxRounds: 2,
      maxTotalMs: 30000,
      ...budgets,
    },
  };
}

function abortListenerCount(signal) {
  return getEventListeners(signal, 'abort').length;
}

test('P2-05：轮次上限按 policy 的 maxRounds 判定，不用全局 MAX_ROUNDS', async () => {
  modelResponder = body => {
    const hasToolResult = (body.messages || []).some(m => m.role === 'tool');
    return hasToolResult
      ? textCompletion('已完成。')
      : toolCallCompletion('guard_probe', { seq: 1 });
  };

  const outcome = await agentRuntime.runAgentTurn({
    messages: [{ role: 'user', content: '跑一次探针' }],
    sessionId: 's-guard',
    policy: policyWith({ maxRounds: 2 }),
  });

  assert.equal(outcome.rounds, 2, `实际轮次 ${outcome.rounds}`);
  assert.equal(outcome.maxRounds, 2, `实际上限 ${outcome.maxRounds}`);
  assert.equal(
    outcome.reachedMaxRounds,
    true,
    '按 policy 的 maxRounds=2 跑满两轮，应判定为到达轮次上限'
  );
});

// ---- 正文工具调用封装（DSML）：只认严格结构，解析结果必须真执行 ----

test('正文工具调用封装：严格解析、兼容半角分隔符，残缺封装一律拒绝', () => {
  assert.equal(parseTextualToolCalls('普通模型回复'), null);
  assert.equal(parseTextualToolCalls(''), null);
  assert.equal(parseTextualToolCalls(null), null);

  const fullWidth = parseTextualToolCalls(
    `提交如下：\n\n${dsmlEnvelope([{ name: 'guard_probe', args: { seq: 3 } }])}\n\n以上。`
  );
  assert.ok(fullWidth, '完整封装应被解析');
  assert.equal(fullWidth.text, '提交如下：\n\n\n\n以上。');
  assert.equal(fullWidth.calls.length, 1);
  assert.equal(fullWidth.calls[0].function.name, 'guard_probe');
  assert.deepEqual(JSON.parse(fullWidth.calls[0].function.arguments), { seq: '3' });

  const halfWidth = parseTextualToolCalls(
    dsmlEnvelope([{ name: 'guard_probe', args: { seq: 4 } }], '||')
  );
  assert.ok(halfWidth, '半角分隔符同样应被解析');
  assert.equal(halfWidth.calls.length, 1);

  // 残缺：只有开标签 / 只有外层没有 invoke / 没闭合 —— 一律 null，不改写正文。
  assert.equal(parseTextualToolCalls('<｜｜DSML｜｜ calls>\n<｜｜DSML｜｜ invoke name="x">'), null);
  assert.equal(parseTextualToolCalls('<｜｜DSML｜｜ calls>\n</｜｜DSML｜｜ calls>'), null);
  assert.equal(
    parseTextualToolCalls(
      '<｜｜DSML｜｜ calls>\n<｜｜DSML｜｜ invoke name="guard_probe">\n</｜｜DSML｜｜ calls>'
    ),
    null
  );
});

test('正文工具调用封装：末轮不下发 tools 仍执行解析出的调用，回复不含标记', async () => {
  probeSeqs.length = 0;
  let finalRequest = null;

  modelResponder = body => {
    const hasToolResult = (body.messages || []).some(m => m.role === 'tool');
    if (!hasToolResult) return toolCallCompletion('guard_probe', { seq: 1 });

    finalRequest = body;
    return textCompletion(
      `检索完成，下面提交候选记忆。\n\n${dsmlEnvelope([
        { name: 'guard_probe', args: { seq: 2 } },
      ])}`
    );
  };

  const outcome = await agentRuntime.runAgentTurn({
    messages: [{ role: 'user', content: '先检索再提交' }],
    sessionId: 's-textual-final',
    policy: policyWith({ maxRounds: 2 }),
  });

  assert.equal(outcome.rounds, 2);
  assert.ok(finalRequest, '应捕获到末轮请求');
  assert.equal(finalRequest.tools, undefined, '末轮不得下发 tools');
  assert.deepEqual(probeSeqs, [1, 2], '末轮正文封装里的调用必须真的执行');
  assert.equal(outcome.toolSteps.length, 2, '两次探针都应记入 toolSteps');
  assert.equal(outcome.rawReply, '检索完成，下面提交候选记忆。');
  assert.ok(!outcome.rawReply.includes('DSML'), '交付正文不得残留封装标记');
});

test('正文工具调用封装：普通轮次解析后照常进入下一轮并回传工具结果', async () => {
  probeSeqs.length = 0;
  let secondRequest = null;

  modelResponder = body => {
    const hasToolResult = (body.messages || []).some(m => m.role === 'tool');
    if (!hasToolResult) {
      return textCompletion(`先查一下。\n\n${dsmlEnvelope([
        { name: 'guard_probe', args: { seq: 7 } },
      ])}`);
    }
    secondRequest = body;
    return textCompletion('已写入。');
  };

  const outcome = await agentRuntime.runAgentTurn({
    messages: [{ role: 'user', content: '查完再写' }],
    sessionId: 's-textual-normal',
    policy: policyWith({ maxRounds: 3 }),
  });

  assert.equal(outcome.rounds, 2);
  assert.deepEqual(probeSeqs, [7]);
  assert.equal(outcome.rawReply, '已写入。');
  assert.ok(
    secondRequest && secondRequest.messages.some(m => m.role === 'tool'),
    '下一轮请求应包含 tool 结果消息'
  );
});

// ---- 回复里的任务声明核对：不许把编造的任务 ID / 排队状态当事实交付 ----

test('任务声明核对：未知任务 ID 替换为「不存在」并追加系统校验说明', () => {
  const reply =
    '扔了，返回了任务 ID：`task_4c6f4dbb-18a4-4d8d-9a53-9d5f6b0e2a71`，状态 queued。';
  const out = auditTaskClaims(reply, {
    lookupTask: () => null,
    listSessionTasks: () => [],
    dispatchedThisTurn: false,
  });

  assert.equal(out.violations[0].kind, 'unknown_task_id');
  assert.ok(!out.reply.includes('task_4c6f4dbb'), '未知 ID 不得原样交付');
  assert.ok(out.reply.includes('task_（不存在）'));
  assert.ok(out.reply.includes('系统校验'));
});

test('任务声明核对：已知任务 ID 原样保留；无据排队声明才追加说明', () => {
  const known = 'task_aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee';
  const okReply = `任务 ${known} 已进入队列。`;
  const ok = auditTaskClaims(okReply, {
    lookupTask: id => (id === known ? { status: 'queued' } : null),
    listSessionTasks: () => [],
    dispatchedThisTurn: false,
  });
  assert.deepEqual(ok.violations, []);
  assert.equal(ok.reply, okReply);

  const now = Date.parse('2026-11-07T16:36:00Z');

  // 会话里既无活跃任务、也无 10 分钟内新任务：排队声明无据。
  const stale = auditTaskClaims('队列里是个 queued，没转 completed。', {
    lookupTask: () => null,
    listSessionTasks: () => [],
    dispatchedThisTurn: false,
    now,
  });
  assert.equal(stale.violations[0].kind, 'dispatch_without_task');
  assert.ok(stale.reply.includes('系统校验'));

  // 会话里有正在跑的任务：不误报。
  const benign = auditTaskClaims('队列里是个 queued。', {
    lookupTask: () => null,
    listSessionTasks: () => [{ status: 'running', createdAt: '2026-11-07T16:30:00Z' }],
    dispatchedThisTurn: false,
    now,
  });
  assert.deepEqual(benign.violations, []);

  // 本轮真的派发了：即便任务尚未写入列表，也不追加说明。
  const justDispatched = auditTaskClaims('已派发，状态 queued。', {
    lookupTask: () => null,
    listSessionTasks: () => [],
    dispatchedThisTurn: true,
    now,
  });
  assert.deepEqual(justDispatched.violations, []);
});

test('P2-06：连续工具调用不会在外部 AbortSignal 上累积监听器', async () => {
  const controller = new AbortController();
  const cache = new Map();

  for (let i = 0; i < 15; i += 1) {
    const result = await agentRuntime.executeToolCall(
      'guard_probe',
      { seq: i },
      {
        sessionId: 's-guard',
        userText: '探针',
        cache,
        abortSignal: controller.signal,
      }
    );
    assert.equal(result.ok, true);
  }

  assert.equal(
    abortListenerCount(controller.signal),
    0,
    `外部信号上仍有 ${abortListenerCount(controller.signal)} 个 abort 监听器`
  );
});

test('P2-06：外部信号已中止时，工具调用立即返回而不挂监听器', async () => {
  const controller = new AbortController();
  controller.abort();

  const result = await agentRuntime.executeToolCall(
    'guard_probe',
    { seq: 99 },
    {
      sessionId: 's-guard',
      userText: '探针',
      cache: new Map(),
      abortSignal: controller.signal,
    }
  );

  assert.ok(result, '应返回结构化结果而不是抛异常');
  assert.equal(abortListenerCount(controller.signal), 0);
});

// ---- P2-04：任务 deadlineMs 在运行时被执行 ----

const BOT_KEY = 'guard-bot-key-1234567890';
const GLOBAL_KEY = 'global-key-must-not-be-used';

test.before(async () => {
  const apiConfigs = require(path.join(SERVER, 'api-configs.js'));
  const config = require(path.join(SERVER, 'agents', 'config.js'));
  const credentials = require(path.join(SERVER, 'agents', 'credentials.js'));

  const added = apiConfigs.addModelProvider({
    name: 'Guard Test Provider',
    baseUrl: 'http://127.0.0.1:65535/v1',
    apiKey: GLOBAL_KEY,
    models: [
      {
        id: 'guard-test-model',
        name: 'Guard Test Model',
        capabilities: { tools: true, vision: false },
      },
    ],
  });
  assert.ok(added.provider, `provider setup failed: ${JSON.stringify(added)}`);

  config.updateConfig('memory', {
    enabled: true,
    modelProfile: {
      providerId: added.provider.id,
      modelId: 'guard-test-model',
      temperature: 0.2,
      maxTokens: 512,
      timeoutMs: 60000,
    },
  });

  const credential = credentials.putCredential({
    botId: 'memory',
    providerId: added.provider.id,
    apiKey: BOT_KEY,
  });
  config.setCredentialId('memory', credential.credentialId);
});

test.after(async () => {
  try {
    fs.rmSync(TMP, { recursive: true, force: true });
  } catch (_) {
    /* ignore */
  }
});

async function waitForTask(tasks, taskId, timeoutMs = 20000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const task = tasks.getTask(taskId);
    if (task && tasks.isTerminalStatus(task.status)) return task;
    await new Promise(resolve => setTimeout(resolve, 50));
  }
  return tasks.getTask(taskId);
}

test('P2-04：任务超过 deadlineMs 后收敛为 timed_out', async () => {
  const tasks = require(path.join(SERVER, 'agents', 'tasks.js'));
  const runtime = require(path.join(SERVER, 'agents', 'runtime.js'));

  modelResponder = (body, options) => hangingCompletion(options);

  const task = tasks.createTask({
    botId: 'memory',
    taskType: 'memory.search',
    goal: '检索一条不存在的记忆',
    allowedTools: ['memory_search'],
    deadlineMs: 5000,
  });

  const startedAt = Date.now();
  runtime.startTask(task.taskId);
  const finished = await waitForTask(tasks, task.taskId, 20000);
  const elapsed = Date.now() - startedAt;

  assert.equal(finished.status, 'timed_out', `实际状态 ${finished.status}`);
  assert.equal(
    finished.errorCode,
    'deadline_exceeded',
    `实际错误码 ${finished.errorCode}`
  );
  assert.ok(elapsed >= 4500, `不应早于 deadline 结束，实际 ${elapsed}ms`);
  assert.ok(elapsed < 15000, `应贴着 deadline 结束，实际 ${elapsed}ms`);
});
