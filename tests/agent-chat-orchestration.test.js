/**
 * 轮 4（Orchestrator 立项书）：主聊天编排接线（orchestration-chat-v1）回归。
 *
 * 口径：
 *  a) 计划块提取与剥离；bad JSON → 降级直答（剥块后正文保留）；
 *  b) 开关默认关闭：直答路径零行为差异——计划块按普通文本渲染、响应无
 *     orchestration 键、不建任务、不落计划；
 *  c) 开关开启：/chat 回复带合法计划块 → 剥块 + 编译 + 编排派发（父会话 =
 *     当前聊天会话）+ 响应带 orchestration 回执 + 模型协议注入（appendix 进
 *     system 消息）；未知 taskType → 降级直答并留 plan.rejected；
 *  d) /chat/stream：done 事件带 orchestration 回执；
 *  e) 开关关闭时模型不收到协议说明（appendix 缺省）。
 *
 * 隔离：全部落盘指向临时目录；openai 模块桩（不真正请求模型）；服务器进程内
 * 启动并在退出前关闭（Windows 下 process.exit 前必须关干净）。
 */
const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');
const test = require('node:test');
const assert = require('node:assert');

const TMP_ROOT = fs.mkdtempSync(path.join(os.tmpdir(), 'bluebird-chat-orch-'));
const DATA_DIR = path.join(TMP_ROOT, 'data');
fs.mkdirSync(DATA_DIR, { recursive: true });
process.env.BLUEBIRD_DATA_DIR = DATA_DIR;
process.env.BLUEBIRD_API_TOKEN = 'test-token-chat-orch';
process.env.PORT = '0';
process.env.DEEPSEEK_API_KEY = 'stub-key-not-real';
process.env.BLUEBIRD_AGENT_TOOLS = '1';
process.env.BLUEBIRD_AGENT_TASK_CONCURRENCY = '3';
process.env.BLUEBIRD_MONITORING = '0';

const PLAN_BLOCK = [
  '```bluebird-plan',
  '{"mode":"dag","goal":"三步编排","nodes":[{"key":"n1","taskType":"memory.search","goal":"检索材料"},{"key":"n2","taskType":"summary.synthesize","goal":"汇总材料","dependsOn":["n1"]}]}',
  '```',
].join('\n');

// openai 模块桩：聊天轮（用户消息带 orch- 标记）返回计划块回复；worker 轮返回
// 纯文本。stubCalls 记录每次调用的协议注入状态与用户标记，供注入断言复核。
const stubCalls = [];
const openaiTarget = require.resolve('openai', { paths: [path.join(__dirname, '..', 'server')] });
require.cache[openaiTarget] = {
  id: openaiTarget,
  filename: openaiTarget,
  loaded: true,
  exports: class StubOpenAI {
    constructor() {
      this.chat = {
        completions: {
          create: async body => {
            const messages = Array.isArray(body.messages) ? body.messages : [];
            const systemText = String((messages[0] && messages[0].content) || '');
            const userText = String((messages.at(-1) && messages.at(-1).content) || '');
            stubCalls.push({
              appendix: systemText.includes('【复杂任务编排协议'),
              userText,
            });
            // 聊天轮（用户消息带 orch- 测试标记）返回计划块——无论开关状态；
            // 关闭开关的场景靠服务端不接线来验证「块按普通文本渲染」。
            // worker 轮（委派任务指令）返回纯文本结果。
            const isChat = userText.startsWith('orch-');
            let content = '已完成：stub 一致结果。';
            if (isChat) {
              // 用户消息带 bad-plan 标记 → 返回未知 taskType 的坏计划（测降级）。
              const plan = userText.includes('orch-bad-')
                ? '{"mode":"dag","goal":"坏计划","nodes":[{"key":"n1","taskType":"nope.missing","goal":"g"}]}'
                : '{"mode":"dag","goal":"三步编排","nodes":[{"key":"n1","taskType":"memory.search","goal":"检索材料"},{"key":"n2","taskType":"summary.synthesize","goal":"汇总材料","dependsOn":["n1"]}]}';
              content = `好的，这个任务可以拆开并行处理。\n\`\`\`bluebird-plan\n${plan}\n\`\`\``;
            }
            return {
              model: 'stub-model',
              choices: [{ message: { role: 'assistant', content } }],
            };
          },
        },
      };
    }
  },
};

// 进程内启动服务器（PORT=0 → 系统分配空闲端口；退出前必须关干净，
// 否则 Windows 上 process 退出会撞 UV 句柄断言）。
const orchestrationChat = require('../server/orchestration-chat');
const tasks = require('../server/agents/tasks');
const planCompiler = require('../server/agents/plan-compiler');
const orchestrationEngine = require('../server/agents/orchestration-engine');
const { server: chatServer } = require('../server/index.js');
let BASE = null;

test.before(async () => {
  if (!chatServer.listening) {
    await new Promise(resolve => chatServer.once('listening', resolve));
  }
  BASE = `http://127.0.0.1:${chatServer.address().port}`;
  // 干净数据目录里非 memory 的 bot 未启用：编排会派发到 researcher/executor，
  // 显式启用并指向 stub（模型客户端已被 openai 模块桩拦截，不真正请求）。
  const agentConfig = require('../server/agents/config');
  const credentials = require('../server/agents/credentials');
  for (const botId of ['memory', 'researcher', 'executor', 'reviewer']) {
    agentConfig.updateConfig(botId, {
      enabled: true,
      modelProfile: {
        providerId: 'deepseek',
        modelId: 'deepseek-chat',
        temperature: 0.2,
        maxTokens: 600,
        timeoutMs: 20000,
      },
    });
    // 注册表状态机要求每个 bot 都有凭据条目（builtin 也一样），否则 degraded。
    const credential = credentials.putCredential({
      botId,
      providerId: 'deepseek',
      apiKey: process.env.DEEPSEEK_API_KEY || 'stub-key-not-real',
    });
    agentConfig.setCredentialId(botId, credential.credentialId);
  }
});

test.after(async () => {
  try {
    if (typeof chatServer.closeAllConnections === 'function') {
      chatServer.closeAllConnections();
    }
  } catch (_) {
    // ignore
  }
  await new Promise(resolve => chatServer.close(() => resolve()));
  try {
    fs.rmSync(TMP_ROOT, { recursive: true, force: true });
  } catch (_) {
    // ignore
  }
});

function authHeader() {
  return { authorization: 'Bearer test-token-chat-orch', 'content-type': 'application/json' };
}

async function post(path, body) {
  const response = await fetch(`${BASE}${path}`, {
    method: 'POST',
    headers: authHeader(),
    body: JSON.stringify(body),
  });
  return { status: response.status, json: await response.json().catch(() => null) };
}

async function put(path, body) {
  const response = await fetch(`${BASE}${path}`, {
    method: 'PUT',
    headers: authHeader(),
    // PUT /agent-policy 的契约是 {policy: <策略对象>}（或 {reset:true}）。
    body: JSON.stringify({ policy: body }),
  });
  return { status: response.status, json: await response.json().catch(() => null) };
}

function fullPolicy(orchestration) {
  return {
    schemaVersion: 1,
    mode: 'bounded_autonomy',
    planning: { generatePlan: false, stagedExecution: false, resultSummary: false },
    tools: { allowedTools: null, maxToolCalls: 12, maxReadOnlyRetries: 0 },
    budgets: { maxRounds: 3, maxTotalMs: 90000 },
    orchestration,
  };
}

test('a. extractPlanBlock：提取/剥离/bad JSON', () => {
  const reply = `前面的话。\n${PLAN_BLOCK}\n后面的话。`;
  const extracted = orchestrationChat.extractPlanBlock(reply);
  assert.ok(extracted);
  assert.equal(extracted.parsed.mode, 'dag');
  assert.equal(extracted.parsed.nodes.length, 2);
  assert.ok(extracted.rest.startsWith('前面的话。'));
  assert.ok(extracted.rest.endsWith('后面的话。'));
  assert.ok(!extracted.rest.includes('bluebird-plan'));
  const bad = orchestrationChat.extractPlanBlock('```bluebird-plan\n{not-json}\n```');
  assert.ok(bad && bad.parsed === null);
  assert.equal(orchestrationChat.extractPlanBlock('普通回复'), null);
});

test('b. 开关默认关闭：wireOrchestration 原文返回（零行为差异）', () => {
  const reply = `直接回答。\n${PLAN_BLOCK}`;
  const wired = orchestrationChat.wireOrchestration({
    policy: { orchestration: { enabled: false, maxNodes: 8 } },
    reply,
    userText: 'x',
  });
  assert.equal(wired.reply, reply, '关闭时原文返回，计划块按普通文本渲染');
  assert.equal(wired.orchestration, null);
  assert.equal(wired.reason, 'disabled');
});

test('c1. 默认策略：GET /agent-policy 的 orchestration 缺省关闭', async () => {
  const response = await fetch(`${BASE}/agent-policy`, { headers: authHeader() });
  assert.equal(response.status, 200);
  const body = await response.json();
  assert.deepEqual(body.policy ? body.policy.orchestration : body.orchestration, {
    enabled: false,
    maxNodes: 8,
  });
});

test('c2. 开关开启：/chat 计划块 → 派发 + 回执 + 剥块', { timeout: 90000 }, async () => {
  const enabledPut = await put('/agent-policy', fullPolicy({ enabled: true, maxNodes: 8 }));
  assert.equal(enabledPut.status, 200, `PUT /agent-policy 失败：${JSON.stringify(enabledPut.json)}`);
  const chat = await post('/chat', { message: 'orch-me-1234 请把三件事一起办' });
  assert.equal(chat.status, 200, JSON.stringify(chat.json));
  assert.ok(chat.json.orchestration, '响应必须带编排回执');
  assert.equal(chat.json.orchestration.nodeCount, 2);
  assert.ok(chat.json.orchestration.planId.startsWith('plan_pc_'));
  assert.ok(!chat.json.reply.includes('bluebird-plan'), '计划块必须从用户可见回复剥离');
  assert.ok(chat.json.reply.includes('[已编排]'), '回复必须带派发回执');
  assert.ok(chat.json.reply.includes('直接回答') || chat.json.reply.length > 0);
  // 编排真实落库：两节点分别落在解析出的执行者上。
  const record = orchestrationEngine.getOrchestration(chat.json.orchestration.planId);
  assert.ok(record);
  const nodeAgents = Object.values(record.nodes).map(node => node.agentId).sort();
  assert.deepEqual(nodeAgents, ['memory', 'researcher']);
  const compiled = planCompiler.getCompiledPlan(chat.json.orchestration.planId);
  assert.ok(compiled, '编译产物真实落盘');
  // 协议注入：开启轮次的 system 消息必须带编排协议（能力清单由 Manifest 动态生成）。
  assert.ok(stubCalls.some(call => call.appendix && call.userText.startsWith('orch-me-')), '开启轮次必须注入协议说明');
  void tasks;
});

test('c3. 未知 taskType：降级直答（剥块 + 无编排键 + plan.rejected）', { timeout: 60000 }, async () => {
  const before = tasks
    .listEvents('memory', { limit: 300 })
    .filter(event => event.eventType === 'plan.rejected').length;
  const chat = await post('/chat', { message: 'orch-bad-5678 请处理' });
  assert.equal(chat.status, 200);
  assert.equal(chat.json.orchestration, undefined, '降级时不得带编排键');
  assert.ok(!chat.json.reply.includes('bluebird-plan'), '坏计划块必须剥离');
  const after = tasks
    .listEvents('memory', { limit: 300 })
    .filter(event => event.eventType === 'plan.rejected').length;
  assert.ok(after > before, '编译失败必须落 plan.rejected');
});

test('d. /chat/stream：done 事件带 orchestration 回执', { timeout: 90000 }, async () => {
  const response = await fetch(`${BASE}/chat/stream`, {
    method: 'POST',
    headers: authHeader(),
    body: JSON.stringify({ message: 'orch-stream-9012 请把三件事一起办' }),
  });
  assert.equal(response.status, 200);
  const raw = await response.text();
  const events = raw
    .split('\n')
    .filter(line => line.startsWith('data: '))
    .map(line => {
      try {
        return JSON.parse(line.slice(6));
      } catch (_) {
        return null;
      }
    })
    .filter(Boolean);
  const done = events.find(event => event.type === 'done');
  assert.ok(done, 'SSE 必须以 done 收尾');
  assert.ok(done.orchestration, 'done 必须带编排回执');
  assert.equal(done.orchestration.nodeCount, 2);
});

test('e. 关闭开关：计划块按普通文本返回（零行为差异）', { timeout: 60000 }, async () => {
  const disabledPut = await put('/agent-policy', fullPolicy({ enabled: false, maxNodes: 8 }));
  assert.equal(disabledPut.status, 200);
  const chat = await post('/chat', { message: 'orch-off-3456 请处理' });
  assert.equal(chat.status, 200);
  assert.equal(chat.json.orchestration, undefined);
  assert.ok(chat.json.reply.includes('bluebird-plan'), '关闭时计划块按普通文本渲染');
  // 关闭轮次不得注入协议说明（模型侧零变化）。
  const offCall = stubCalls.find(call => call.userText.startsWith('orch-off-'));
  assert.ok(offCall, '关闭轮次必须有模型调用记录');
  assert.equal(offCall.appendix, false, '关闭时不得注入协议说明');
});
