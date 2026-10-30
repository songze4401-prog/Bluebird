/**
 * 云岫 Bluebird — Agent 工作策略专项测试（agent-policy.test.js）
 *
 * 覆盖：
 *   A. 严格 schema：默认值、枚举、范围、未知字段、payload 上限
 *   B. 持久化：保存/重置/revision、重启读取、写失败不覆盖、损坏隔离
 *   C. API：鉴权、读取、保存、重置、非法 payload
 *   D. 运行时：answer_only 不暴露工具、白名单只暴露允许工具、工具调用预算、
 *      高风险工具后端确认门、策略 trace 不含正文
 *
 * 隔离：BLUEBIRD_DATA_DIR 在 require 服务端模块前指向临时目录。
 */
const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');
const { execFileSync } = require('child_process');

const TMP_ROOT = fs.mkdtempSync(path.join(os.tmpdir(), 'bluebird-agent-policy-'));
const DATA_DIR = path.join(TMP_ROOT, 'data');
fs.mkdirSync(DATA_DIR, { recursive: true });

process.env.BLUEBIRD_DATA_DIR = DATA_DIR;
process.env.BLUEBIRD_API_TOKEN = 'test-token-policy';
process.env.DEEPSEEK_API_KEY = 'sk-stub-policy';
process.env.MEMORY_ENABLED = 'false';
process.env.BLUEBIRD_AGENT_TOOLS = '1';
process.env.PORT = '0';

const SERVER = path.join(__dirname, '..', 'server');
const ORIG_LOG = console.log;
const ORIG_ERR = console.error;

let passed = 0;
let failed = 0;
const failures = [];

function check(name, cond, extra = '') {
  if (cond) {
    passed++;
    ORIG_LOG(`  ✔ ${name}`);
  } else {
    failed++;
    failures.push(name + (extra ? ` — ${extra}` : ''));
    ORIG_LOG(`  ✖ ${name}${extra ? ` — ${extra}` : ''}`);
  }
}

let httpServer = null;
const originalListen = http.Server.prototype.listen;
http.Server.prototype.listen = function (...args) {
  httpServer = this;
  return originalListen.apply(this, args);
};

async function closeHttpServer() {
  if (!httpServer) return;
  const server = httpServer;
  httpServer = null;
  try {
    if (typeof server.closeAllConnections === 'function') server.closeAllConnections();
  } catch (_) {
    /* ignore */
  }
  await new Promise(resolve => server.close(() => resolve()));
}

// ---- 模型桩：捕获真实请求，按剧本返回 ----
const captured = [];
let scripted = [];
const openaiTarget = require.resolve('openai', { paths: [SERVER] });
require.cache[openaiTarget] = {
  id: openaiTarget,
  filename: openaiTarget,
  loaded: true,
  exports: class StubOpenAI {
    constructor() {
      this.chat = {
        completions: {
          create: async params => {
            captured.push(params);
            const next = scripted.shift() || { content: '策略测试回复' };
            if (params.stream) {
              return (async function* streamChunks() {
                yield { choices: [{ delta: { content: next.content || '策略测试回复' } }] };
              })();
            }
            if (Array.isArray(next.toolCalls)) {
              return {
                model: 'stub-model',
                choices: [
                  {
                    message: {
                      content: next.content || null,
                      tool_calls: next.toolCalls,
                    },
                    finish_reason: 'tool_calls',
                  },
                ],
              };
            }
            return {
              model: 'stub-model',
              choices: [
                {
                  message: { content: next.content || '策略测试回复' },
                  finish_reason: 'stop',
                },
              ],
            };
          },
        },
      };
    }
  },
};

function resetScript(items = []) {
  captured.length = 0;
  scripted = items.slice();
}

function tc(id, name, args) {
  return {
    id,
    type: 'function',
    function: { name, arguments: JSON.stringify(args || {}) },
  };
}

// ---- 运行时注册合成工具：只读 echo + 高风险 ----
const agentRuntime = require(path.join(SERVER, 'agent-runtime.js'));
let echoCalls = 0;
let highRiskCalls = 0;
agentRuntime.registerTool({
  name: 'echo_test',
  description: '测试用只读回声工具',
  parameters: { type: 'object', properties: {}, additionalProperties: false },
  readOnly: true,
  timeoutMs: 1000,
  validate(args) {
    return {
      ok: true,
      args: { value: args && typeof args.value === 'string' ? args.value : '' },
    };
  },
  async handler(args) {
    echoCalls += 1;
    return { ok: true, summary: 'echo-ok', value: args.value };
  },
});
agentRuntime.registerTool({
  name: 'high_risk_test',
  description: '测试用高风险工具',
  parameters: { type: 'object', properties: {}, additionalProperties: false },
  readOnly: false,
  risk: 'high_risk',
  timeoutMs: 1000,
  validate() {
    return { ok: true, args: {} };
  },
  async handler() {
    highRiskCalls += 1;
    return { ok: true, summary: 'should-not-run' };
  },
});

const agentPolicy = require(path.join(SERVER, 'agent-policy.js'));
const { server } = require(path.join(SERVER, 'index.js'));

const TOKEN = 'test-token-policy';
let BASE = '';
const AUTH = { Authorization: `Bearer ${TOKEN}`, 'Content-Type': 'application/json' };

async function waitReady() {
  for (let i = 0; i < 100; i += 1) {
    if (server.listening) {
      BASE = `http://127.0.0.1:${server.address().port}`;
      return;
    }
    await new Promise(resolve => setTimeout(resolve, 20));
  }
  throw new Error('server_not_ready');
}

function defaultPolicy(overrides = {}) {
  const base = {
    schemaVersion: 1,
    mode: 'bounded_autonomy',
    planning: { generatePlan: false, stagedExecution: false, resultSummary: false },
    tools: { allowedTools: null, maxToolCalls: 12, maxReadOnlyRetries: 0 },
    budgets: { maxRounds: 3, maxTotalMs: 90000 },
  };
  return {
    ...base,
    ...overrides,
    planning: { ...base.planning, ...(overrides.planning || {}) },
    tools: { ...base.tools, ...(overrides.tools || {}) },
    budgets: { ...base.budgets, ...(overrides.budgets || {}) },
  };
}

async function putPolicy(policy) {
  const response = await fetch(`${BASE}/agent-policy`, {
    method: 'PUT',
    headers: AUTH,
    body: JSON.stringify({ policy }),
  });
  return { status: response.status, json: await response.json() };
}

async function chat(message) {
  const response = await fetch(`${BASE}/chat`, {
    method: 'POST',
    headers: AUTH,
    body: JSON.stringify({ message }),
  });
  return { status: response.status, json: await response.json() };
}

async function chatStream(message) {
  const response = await fetch(`${BASE}/chat/stream`, {
    method: 'POST',
    headers: AUTH,
    body: JSON.stringify({ message }),
  });
  return { status: response.status, text: await response.text() };
}

function childPolicy(dir, expr) {
  const script = `
    process.env.BLUEBIRD_DATA_DIR = ${JSON.stringify(dir)};
    const p = require(${JSON.stringify(path.join(SERVER, 'agent-policy.js'))});
    ${expr}
  `;
  const out = execFileSync(process.execPath, ['-e', script], {
    encoding: 'utf8',
    env: { ...process.env, BLUEBIRD_DATA_DIR: dir },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  return JSON.parse(out.trim());
}

async function main() {
  console.log = () => {};
  console.error = () => {};

  await waitReady();

  ORIG_LOG('\nA. schema 与默认值');
  check('默认策略通过严格校验', agentPolicy.validatePolicy(agentPolicy.DEFAULTS).ok === true);
  check('未知顶层字段被拒绝', agentPolicy.validatePolicy({ ...defaultPolicy(), extra: 1 }).ok === false);
  check('非法 mode 被拒绝', agentPolicy.validatePolicy(defaultPolicy({ mode: 'yolo' })).ok === false);
  check('maxRounds 越界被拒绝', agentPolicy.validatePolicy(defaultPolicy({ budgets: { maxRounds: 1 } })).ok === false);
  check('maxToolCalls 越界被拒绝', agentPolicy.validatePolicy(defaultPolicy({ tools: { maxToolCalls: 0 } })).ok === false);
  check('allowedTools 非法名被拒绝', agentPolicy.validatePolicy(defaultPolicy({ tools: { allowedTools: ['Bad Tool'] } })).ok === false);
  check('布尔字段类型被拒绝', agentPolicy.validatePolicy(defaultPolicy({ planning: { generatePlan: 'yes' } })).ok === false);
  check('默认策略不注入提示词', agentPolicy.buildPolicyInstruction(defaultPolicy()) === '');
  check('计划模式生成非空提示词', agentPolicy.buildPolicyInstruction(defaultPolicy({ mode: 'plan_then_act', planning: { generatePlan: true } })).includes('Agent 工作策略'));

  ORIG_LOG('\nB. API 鉴权、保存与重置');
  const unauthGet = await fetch(`${BASE}/agent-policy`);
  check('未授权 GET 返回 401', unauthGet.status === 401);
  const unauthPut = await fetch(`${BASE}/agent-policy`, { method: 'PUT', body: '{}' });
  check('未授权 PUT 返回 401', unauthPut.status === 401);

  const initial = await (await fetch(`${BASE}/agent-policy`, { headers: AUTH })).json();
  check('默认读取为 bounded_autonomy', initial.policy.mode === 'bounded_autonomy');
  check('默认 revision 为 0', initial.meta.revision === 0);
  check('读取返回已注册工具元数据', initial.availableTools.some(tool => tool.name === 'echo_test'));
  check(
    '读取返回只读运行时开关，前端不能据此改写服务端配置',
    initial.runtime &&
      initial.runtime.switchOn === true &&
      initial.runtime.maxRounds === 3 &&
      initial.runtime.toolTimeoutDefaultMs > 0 &&
      initial.runtime.imageRequestsDisableTools === true
  );
  check('高风险工具在元数据中可见', initial.availableTools.some(tool => tool.risk === 'high_risk'));

  const saved = await putPolicy(defaultPolicy({ mode: 'plan_then_act', planning: { generatePlan: true } }));
  check('合法策略保存成功', saved.status === 200 && saved.json.policy.mode === 'plan_then_act');
  check('保存后 revision 递增', saved.json.meta.revision === 1);
  check('保存文件可被独立进程读回', childPolicy(DATA_DIR, 'process.stdout.write(JSON.stringify(p.getPolicy()))').mode === 'plan_then_act');

  const invalid = await putPolicy({ ...defaultPolicy(), unknown: true });
  check('未知字段 PUT 返回 400', invalid.status === 400 && invalid.json.code === 'invalid_policy');
  const invalidRange = await putPolicy(defaultPolicy({ budgets: { maxRounds: 6 } }));
  check('越界 PUT 返回 400', invalidRange.status === 400);

  const reset = await fetch(`${BASE}/agent-policy`, {
    method: 'PUT',
    headers: AUTH,
    body: JSON.stringify({ reset: true }),
  });
  const resetJson = await reset.json();
  check('reset 恢复默认模式', reset.status === 200 && resetJson.policy.mode === 'bounded_autonomy');
  check('reset 后 revision 继续递增', resetJson.meta.revision > saved.json.meta.revision);

  ORIG_LOG('\nC. answer_only 与工具白名单');
  const answerOnly = await putPolicy(defaultPolicy({ mode: 'answer_only' }));
  check('answer_only 保存成功', answerOnly.status === 200);
  resetScript([{ content: '只回答，不调用工具' }]);
  const answerChat = await chat('策略测试：只回答');
  check('answer_only 请求成功', answerChat.status === 200);
  check('answer_only 不向模型暴露 tools', captured.length === 1 && captured[0].tools === undefined);
  check('answer_only 无 toolSteps', answerChat.json.toolSteps === undefined);

  resetScript([{ content: '流式策略回复' }]);
  const answerStream = await chatStream('策略测试：流式只回答');
  check('answer_only 流式请求成功', answerStream.status === 200);
  check('answer_only 流式不暴露 tools', captured.length === 1 && captured[0].tools === undefined);
  check(
    'answer_only 流式不产生 tool_start',
    answerStream.text.includes('流式策略回复') && !answerStream.text.includes('"tool_start"')
  );

  const allowed = await putPolicy(
    defaultPolicy({
      mode: 'plan_then_act',
      planning: { generatePlan: true },
      tools: { allowedTools: ['echo_test'] },
    })
  );
  check('白名单策略保存成功', allowed.status === 200);
  resetScript([
    { toolCalls: [tc('call_echo', 'echo_test', { value: 'A' })] },
    { content: '工具执行完成' },
  ]);
  const allowedChat = await chat('策略测试：调用允许的工具');
  check('白名单请求成功', allowedChat.status === 200);
  check(
    '模型只看到白名单工具',
    captured[0].tools &&
      captured[0].tools.length === 1 &&
      captured[0].tools[0].function.name === 'echo_test'
  );
  check('白名单工具实际执行', echoCalls === 1);
  check(
    '工具执行摘要进入响应',
    Array.isArray(allowedChat.json.toolSteps) &&
      allowedChat.json.toolSteps[0].name === 'echo_test'
  );
  check(
    '策略提示词进入 Agent 请求',
    captured[0].messages.some(
      message =>
        message.role === 'system' &&
        typeof message.content === 'string' &&
        message.content.includes('Agent 工作策略')
    )
  );

  ORIG_LOG('\nD. 工具调用预算与 trace');
  await putPolicy(
    defaultPolicy({
      tools: { allowedTools: ['echo_test'], maxToolCalls: 1 },
    })
  );
  resetScript([
    {
      toolCalls: [
        tc('call_b1', 'echo_test', { value: 'one' }),
        tc('call_b2', 'echo_test', { value: 'two' }),
      ],
    },
  ]);
  const beforeBudget = echoCalls;
  const traceLines = [];
  const originalError = console.error;
  console.error = (...args) => {
    const line = args.map(String).join(' ');
    if (line.startsWith('[context-trace]')) traceLines.push(line);
  };
  let budgetChat;
  try {
    budgetChat = await chat('策略测试：工具调用预算 sentinel-policy-body');
  } finally {
    console.error = originalError;
  }
  check('预算耗尽仍返回受控回复', budgetChat.status === 200 && budgetChat.json.reply.includes('预算'));
  check('预算耗尽后不再执行第二个工具', echoCalls - beforeBudget === 1);
  const trace = traceLines.length
    ? JSON.parse(traceLines[traceLines.length - 1].replace('[context-trace] ', ''))
    : null;
  check('trace 记录策略摘要', Boolean(trace && trace.policy && trace.policy.mode === 'bounded_autonomy'));
  check('trace 记录停止原因', Boolean(trace && trace.agent && trace.agent.stopReason === 'tool_call_budget'));
  check('trace 不含用户正文', !JSON.stringify(trace || {}).includes('sentinel-policy-body'));

  ORIG_LOG('\nE. 高风险工具后端确认门');
  const highRisk = await agentRuntime.executeToolCall(
    'high_risk_test',
    {},
    {
      sessionId: 'policy-session',
      userText: '测试',
      cache: new Map(),
      policy: defaultPolicy(),
    }
  );
  check('高风险工具返回 confirmation_required', highRisk.ok === false && highRisk.code === 'confirmation_required');
  check('高风险工具 handler 未执行', highRiskCalls === 0);

  ORIG_LOG('\nF. 写失败与损坏隔离');
  const file = path.join(DATA_DIR, 'agent-policy.json');
  const beforeWrite = fs.readFileSync(file, 'utf8');
  const originalRename = fs.renameSync;
  Object.defineProperty(fs, 'renameSync', {
    configurable: true,
    value: () => {
      throw new Error('rename-failure-for-policy-test');
    },
  });
  let writeFailure;
  try {
    writeFailure = agentPolicy.savePolicy(defaultPolicy({ mode: 'answer_only' }));
  } finally {
    Object.defineProperty(fs, 'renameSync', {
      configurable: true,
      value: originalRename,
    });
  }
  check('写失败返回明确错误', writeFailure.ok === false && writeFailure.code === 'policy_write_failed');
  check('写失败不覆盖旧策略文件', fs.readFileSync(file, 'utf8') === beforeWrite);

  const corruptDir = path.join(TMP_ROOT, 'corrupt-data');
  fs.mkdirSync(corruptDir, { recursive: true });
  fs.writeFileSync(path.join(corruptDir, 'agent-policy.json'), '{ broken json', 'utf8');
  const corruptResult = childPolicy(
    corruptDir,
    'process.stdout.write(JSON.stringify({policy:p.getPolicy(),meta:p.getMeta()}))'
  );
  check('损坏文件回退安全默认值', corruptResult.policy.mode === 'bounded_autonomy');
  check('损坏文件标记 corrupted', corruptResult.meta.corrupted === true);
  check(
    '损坏文件被隔离保留',
    fs.readdirSync(corruptDir).some(name => name.startsWith('agent-policy.json.corrupt-'))
  );

  ORIG_LOG('\nG. 恢复默认 API');
  const finalReset = await fetch(`${BASE}/agent-policy`, {
    method: 'PUT',
    headers: AUTH,
    body: JSON.stringify({ reset: true }),
  });
  const finalResetJson = await finalReset.json();
  check('最终恢复默认成功', finalReset.status === 200 && finalResetJson.policy.mode === 'bounded_autonomy');

  console.log = ORIG_LOG;
  console.error = ORIG_ERR;
  await closeHttpServer();

  ORIG_LOG(`\n结果：${passed} 通过，${failed} 失败`);
  if (failures.length) {
    ORIG_LOG('失败明细：');
    for (const failure of failures) ORIG_LOG(`  - ${failure}`);
  }
  process.exit(failed === 0 ? 0 : 1);
}

main().catch(error => {
  console.log = ORIG_LOG;
  console.error = ORIG_ERR;
  ORIG_ERR('agent-policy test crashed:', error && error.message ? error.message : error);
  process.exit(1);
});
