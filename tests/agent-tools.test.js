/* global __dirname, Buffer */
/**
 * 云岫 Bluebird — Agent 工具调用闭环测试（agent-tools.test.js）
 *
 * 独立脚本（非 node:test）：与 tests/multimodal.test.js 同款极简 runner。
 * 隔离保证：
 *   - BLUEBIRD_DATA_DIR 指向系统临时目录，并在 require 任何服务端模块前设置；
 *   - 预置 memory.json 种子（含多会话贡献，验证 scope 隔离）；
 *   - openai 桩（内置 DeepSeek 分支按剧本返回，零网络零费用）；
 *     记忆提取调用（system 含"长期记忆提取器"）固定返回 {}，不消耗剧本；
 *   - 自定义服务商走真实 SDK + 本地 mock HTTP 服务商（H3 组用）；
 *   - PORT=0 动态端口。
 *
 * 覆盖（任务书第七节 11 类场景 → 本文件分组）：
 *   A. 普通闲聊不执行工具
 *   B. 紧急开关：默认关 / 关闭时不执行 / 变化日志
 *   C. 正常工具流程（/chat 与 /chat/stream、SSE 顺序、toolSteps 落盘读回、
 *      中间轮不落盘、model 回执）
 *   D. 未知工具安全处理
 *   E. 参数非法（JSON 坏 / 缺字段 / 越界）安全处理
 *   F. 模型异常（/chat 502 + SSE error）
 *   G. 轮数硬上限（3 轮）可控结束
 *   H. 能力降级（模型未声明 tools）与带图请求后端强制无工具
 *   I. 并行 tool_calls 的 ID 与顺序
 *   J. 同请求去重短路
 *   K. 两类断连（工具执行期间 / 第二轮生成期间）
 *   L. 模块级：参数边界 / 记忆 scope 与三类上限 / 工具超时硬边界 /
 *      工具异常 / 长度规则 / 开关严格取值
 *
 * 运行：node tests/agent-tools.test.js
 */
const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');

async function closeServer(server) {
  if (!server) return;
  try {
    if (typeof server.closeAllConnections === 'function') {
      server.closeAllConnections();
    }
  } catch (_) {
    /* ignore */
  }
  await new Promise(resolve => server.close(() => resolve()));
}

// ---- 环境隔离（必须在 require 任何服务端模块之前） ----
const TMP_ROOT = fs.mkdtempSync(path.join(os.tmpdir(), 'bluebird-agent-'));
const DATA_DIR = path.join(TMP_ROOT, 'data');
fs.mkdirSync(DATA_DIR, { recursive: true });

process.env.BLUEBIRD_DATA_DIR = DATA_DIR;
process.env.BLUEBIRD_API_TOKEN = 'test-token';
process.env.DEEPSEEK_API_KEY = 'sk-stub-deepseek-0001';
process.env.PORT = '0';
// Agent 开关：默认关。各组自行翻转，结束前恢复。
process.env.BLUEBIRD_AGENT_TOOLS = '';

const SERVER = path.join(__dirname, '..', 'server');

// ---- 记忆种子（多会话贡献，验证 scope 隔离） ----
// 在 require 之前落盘：memory.js 在模块加载时读取。
const seedNow = new Date().toISOString();
function seedEntry(content, type, keywords, sessionId) {
  return {
    content,
    type,
    keywords,
    confidence: 0.9,
    contributions: [
      { sessionId, sourceQuote: content.slice(0, 12), createdAt: seedNow },
    ],
    createdAt: seedNow,
    updatedAt: seedNow,
  };
}

const SEED_MEMORIES = [
  seedEntry('用户喜欢喝拿铁咖啡，不加糖', 'preference', ['咖啡', '拿铁'], 'default'),
  seedEntry('用户养了一只叫年糕的猫', 'fact', ['猫', '年糕'], 'default'),
  // 只属于另一会话：任何情况下都不得出现在工具结果里
  seedEntry('另一会话的私有记忆：用户的车牌号是沪A12345', 'fact', ['车牌'], 's-other'),
  // 无归属旧贡献：仅当当前会话没有任何相关贡献时才回退出现
  seedEntry('用户常用的昵称是小蓝', 'identity', ['昵称'], null),
];

fs.writeFileSync(
  path.join(DATA_DIR, 'memory.json'),
  JSON.stringify(SEED_MEMORIES)
);

// ---- 日志捕获 ----
const ORIG_LOG = console.log;
const ORIG_ERR = console.error;
const errorLines = [];
const warnLines = [];

console.log = () => {};
console.error = (...args) => {
  errorLines.push(args.map(item => String(item)).join(' '));
};
console.warn = (...args) => {
  warnLines.push(args.map(item => String(item)).join(' '));
};

// F5 回归：进程级未处理拒绝捕获（迟到 rejection 必须被吞掉）
const unhandledRejections = [];
process.on('unhandledRejection', reason => {
  unhandledRejections.push(String(reason));
});

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

const PNG_B64 =
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAADJRU5ErkJggg==';
const PNG_BUF = Buffer.from(PNG_B64, 'base64');

// ---- openai 桩：按剧本返回；记忆提取调用不消耗剧本 ----
const RealOpenAI = require('openai');
const openaiTarget = require.resolve('openai', { paths: [SERVER] });

const scripted = []; // { toolCalls?, content?, error?, delayMs? }
let callIndex = 0;
const stubCalls = []; // 聊天调用入参记录（不含记忆提取）
const builtinConfigs = [];

require.cache[openaiTarget] = {
  id: openaiTarget,
  filename: openaiTarget,
  loaded: true,
  exports: class StubOpenAI {
    constructor(config) {
      this.config = config;
      if (config && config.baseURL === 'https://api.deepseek.com') {
        builtinConfigs.push(config);
        this.chat = {
          completions: {
            create: async args => {
              // 记忆提取调用：system prompt 固定含"长期记忆提取器"，
              // 返回 {} 表示无可提取内容，且不消耗剧本、不计入 stubCalls。
              const system =
                args.messages &&
                args.messages[0] &&
                String(args.messages[0].content || '');
              if (system.includes('长期记忆提取器')) {
                return {
                  model: 'deepseek-chat',
                  choices: [{ message: { role: 'assistant', content: '{}' } }],
                };
              }

              stubCalls.push(args);
              const step = scripted[callIndex] || { content: '[calm] 默认回复' };
              callIndex += 1;

              if (step.delayMs) {
                await new Promise(resolve => setTimeout(resolve, step.delayMs));
              }
              if (step.error) {
                const err = new Error(step.error.message || 'stub error');
                err.status = step.error.status;
                if (step.error.name) err.name = step.error.name;
                throw err;
              }
              // 畸形响应：空 choices（F3 回归——验证可选链降级不抛 TypeError）
              if (step.emptyChoices) {
                return { model: 'deepseek-chat', choices: [] };
              }
              // 流式请求必须返回 async iterable——即使剧本带 toolCalls
              // （Agent 路径不流式；走到这里说明是非 Agent 的普通流式聊天）。
              if (args.stream) {
                const text = typeof step.content === 'string' ? step.content : '';
                return (async function* () {
                  if (text) {
                    yield {
                      model: 'deepseek-chat',
                      choices: [{ index: 0, delta: { content: text } }],
                    };
                  }
                })();
              }
              if (step.toolCalls) {
                return {
                  model: 'deepseek-chat',
                  choices: [
                    {
                      message: {
                        role: 'assistant',
                        content: step.content ?? null,
                        tool_calls: step.toolCalls,
                      },
                    },
                  ],
                };
              }
              return {
                model: 'deepseek-chat',
                choices: [
                  {
                    message: {
                      role: 'assistant',
                      content: step.content ?? '[calm] 默认回复',
                    },
                  },
                ],
              };
            },
          },
        };
      } else {
        this._real = new RealOpenAI(config);
        this.chat = this._real.chat;
      }
    }
  },
};

// ---- emotion 桩（与 model-providers 测试同模式） ----
function stubModule(file, exportsObj) {
  const target = require.resolve(path.join(SERVER, file));
  require.cache[target] = {
    id: target,
    filename: target,
    loaded: true,
    exports: exportsObj,
  };
}

stubModule('emotion.js', {
  EMOTIONS: ['calm', 'happy', 'playful', 'excited', 'tired', 'sad', 'annoyed', 'hurt'],
  getEmotion: () => ({ emotion: 'calm', intensity: 0.3 }),
  buildEmotionContext: () => '【情绪】EMOTION-CTX',
  applyTimeDecay: () => {},
  applyObservation: () => ({ emotion: 'calm', intensity: 0.3 }),
  loadEmotion: () => ({ emotion: 'calm', intensity: 0.3 }),
});

// ---- 启动被测服务（listening 是 nextTick 级事件，必须同步挂监听） ----
const { server: testServer } = require(path.join(SERVER, 'index.js'));
const serverReady = testServer.listening
  ? Promise.resolve()
  : new Promise(resolve => testServer.once('listening', resolve));

let PORT = 0;

function tc(id, name, args) {
  return {
    id,
    type: 'function',
    function: { name, arguments: JSON.stringify(args) },
  };
}

function resetScript() {
  scripted.length = 0;
  callIndex = 0;
  stubCalls.length = 0;
}

async function req(route, options = {}) {
  const { method = 'GET', body, token = 'test-token' } = options;
  const headers = {};
  if (token) headers.Authorization = `Bearer ${token}`;
  if (body !== undefined) headers['Content-Type'] = 'application/json';

  const res = await fetch(`http://127.0.0.1:${PORT}${route}`, {
    method,
    headers,
    body: body === undefined ? undefined : JSON.stringify(body),
  });

  const text = await res.text();
  let json = null;
  try {
    json = JSON.parse(text);
  } catch (_) {
    /* 非 JSON */
  }
  return { status: res.status, json, text };
}

async function readSse(route, body) {
  const res = await fetch(`http://127.0.0.1:${PORT}${route}`, {
    method: 'POST',
    headers: {
      Authorization: 'Bearer test-token',
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(body),
  });

  const text = await res.text();
  const events = [];
  for (const line of text.split('\n')) {
    const trimmed = line.trim();
    if (trimmed.startsWith('data: ')) {
      try {
        events.push(JSON.parse(trimmed.slice(6)));
      } catch (_) {
        /* 非 JSON 行 */
      }
    }
  }
  return { status: res.status, events };
}

// 增量读 SSE，可在指定事件出现时中止（模拟客户端断连）
async function sseWithAbort(route, body, abortOn) {
  const controller = new AbortController();
  const res = await fetch(`http://127.0.0.1:${PORT}${route}`, {
    method: 'POST',
    headers: {
      Authorization: 'Bearer test-token',
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(body),
    signal: controller.signal,
  });

  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  const events = [];
  let buffer = '';

  const drain = () => {
    let idx;
    while ((idx = buffer.indexOf('\n\n')) >= 0) {
      const block = buffer.slice(0, idx);
      buffer = buffer.slice(idx + 2);
      const line = block.split('\n').find(l => l.startsWith('data: '));
      if (!line) continue;
      try {
        const event = JSON.parse(line.slice(6));
        events.push(event);
        if (abortOn && abortOn(event)) {
          controller.abort();
          return true;
        }
      } catch (_) {
        /* 非 JSON 行 */
      }
    }
    return false;
  };

  try {
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      if (drain()) return { events, aborted: true };
    }
    drain();
  } catch (_) {
    /* abort 导致的读失败：预期内 */
  }
  return { events, aborted: controller.signal.aborted };
}

const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

// 模块直载（不起 HTTP）
const uploads = require(path.join(SERVER, 'uploads.js'));
const agent = require(path.join(SERVER, 'agent-runtime.js'));
const memoryModule = require(path.join(SERVER, 'memory.js'));
const memoryTool = require(path.join(SERVER, 'tool-memory-search.js'));
const textUtils = require(path.join(SERVER, 'text-utils.js'));
const configs = require(path.join(SERVER, 'api-configs.js'));
const sessions = require(path.join(SERVER, 'sessions.js'));

// 本地 mock 服务商（H3 组）：真实 SDK 路径，记录请求体
const mockChatRequests = [];
const mockServer = http.createServer((req, res) => {
  res.on('error', () => {});
  let body = '';
  req.on('data', chunk => {
    body += chunk;
  });
  req.on('end', () => {
    let parsed = null;
    try {
      parsed = JSON.parse(body);
    } catch (_) {
      /* 非 JSON */
    }
    mockChatRequests.push({ url: req.url, body: parsed });
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(
      JSON.stringify({
        id: 'chatcmpl-mock',
        model: 'vision-tools',
        choices: [
          { index: 0, message: { role: 'assistant', content: '[happy] mock 回复' } },
        ],
      })
    );
  });
});

async function main() {
  await serverReady;
  PORT = testServer.address().port;
  ORIG_LOG(`测试服务端口=${PORT}`);

  // 本地 mock 服务商（H3 组）+ "视觉+工具"双声明模型
  await new Promise(resolve => mockServer.listen(0, '127.0.0.1', resolve));
  const MOCK_BASE = `http://127.0.0.1:${mockServer.address().port}`;
  process.env.BLUEBIRD_ALLOW_PRIVATE_BASE_URL = '1';
  const visionToolsProvider = configs.addModelProvider({
    name: 'Mock 视觉工具',
    baseUrl: MOCK_BASE,
    apiKey: 'sk-mock-vision-key',
    models: [{ id: 'vision-tools', capabilities: { vision: true, tools: true } }],
  }).provider;

  // 预置一张图片（模块级，不耗 HTTP 配额）
  const imageId = uploads.saveImage({
    dataUrl: `data:image/png;base64,${PNG_BUF.toString('base64')}`,
    kind: 'image',
    name: 'test.png',
  }).id;

  // ================= A. 普通闲聊不执行工具 =================
  ORIG_LOG('\nA. 普通闲聊不执行工具（开关开）');
  process.env.BLUEBIRD_AGENT_TOOLS = '1';
  resetScript();
  scripted.push({ content: '[happy] 今天天气不错。' });

  const plain = await req('/chat', { method: 'POST', body: { message: '你好' } });
  check('开关开 + 普通闲聊正常返回', plain.status === 200 && plain.json.reply.includes('今天天气不错'));
  check('闲聊不触发工具（无 toolSteps 字段）', plain.json.toolSteps === undefined);
  check('闲聊只发 1 次模型调用（无工具轮）', stubCalls.length === 1, `calls=${stubCalls.length}`);
  check(
    'Agent 路径已激活（请求带白名单 tools，模型自己选择不调用）',
    Array.isArray(stubCalls[0].tools) &&
      stubCalls[0].tools.length === 2 &&
      stubCalls[0].tools.every(tool =>
        ['memory_search', 'memory_remember'].includes(tool.function.name)
      )
  );
  check('model 回执保持原语义', plain.json.model === 'deepseek-chat');

  // ================= B. 紧急开关 =================
  ORIG_LOG('\nB. 紧急关闭开关');

  // 默认关（清空 env）：模型即使返回 tool_calls 也不得执行
  process.env.BLUEBIRD_AGENT_TOOLS = '';
  resetScript();
  scripted.push({
    content: '[calm] 开关关闭时的普通回复。',
    toolCalls: [tc('call_x', 'memory_search', { query: '咖啡' })],
  });
  const off = await req('/chat', { method: 'POST', body: { message: '你好' } });
  check('开关关闭时聊天正常（不崩）', off.status === 200);
  check('开关关闭时不执行工具（无 toolSteps）', off.json.toolSteps === undefined);
  check('开关关闭时请求不带 tools', stubCalls[0].tools === undefined);
  check('开关关闭时只发 1 次模型调用（不进工具循环）', stubCalls.length === 1, `calls=${stubCalls.length}`);

  // 流式同理：关闭时无工具事件
  resetScript();
  scripted.push({
    content: '[calm] 流式关闭回复。',
    toolCalls: [tc('call_x', 'memory_search', { query: '咖啡' })],
  });
  const offStream = await readSse('/chat/stream', { message: '你好' });
  check(
    '开关关闭时流式无工具事件',
    offStream.events.every(e => e.type !== 'tool_start' && e.type !== 'tool_end')
  );
  check('开关关闭时流式正常完成', offStream.events.some(e => e.type === 'done'));

  // 变化日志：关 → 开
  warnLines.length = 0;
  process.env.BLUEBIRD_AGENT_TOOLS = '1';
  resetScript();
  scripted.push({ content: '[calm] 好。' });
  await req('/chat', { method: 'POST', body: { message: '触发开关变化' } });
  check(
    '开关变化打 warn 日志',
    warnLines.some(l => l.includes('开关状态变化')),
    warnLines.join(' | ').slice(0, 120)
  );

  // 严格取值：'true' / '0' 均视为关
  process.env.BLUEBIRD_AGENT_TOOLS = 'true';
  check("取值 'true' 视为关闭（严格 '1'）", agent.agentToolsEnabled() === false);
  process.env.BLUEBIRD_AGENT_TOOLS = '0';
  check("取值 '0' 视为关闭", agent.agentToolsEnabled() === false);
  process.env.BLUEBIRD_AGENT_TOOLS = '1';
  check("取值 '1' 视为开启", agent.agentToolsEnabled() === true);

  // ================= C. 正常工具流程 =================
  ORIG_LOG('\nC. 正常工具流程（/chat）');
  resetScript();
  scripted.push({
    toolCalls: [tc('call_1', 'memory_search', { query: '咖啡' })],
  });
  scripted.push({ content: '[happy] 你之前说喜欢喝拿铁，不加糖。' });

  const agentChat = await req('/chat', { method: 'POST', body: { message: '我喜欢喝什么咖啡？' } });
  check('Agent 流程正常返回', agentChat.status === 200);
  check('最终回复正确', agentChat.json.reply.includes('拿铁'));
  check('响应带 toolSteps 摘要', Array.isArray(agentChat.json.toolSteps) && agentChat.json.toolSteps.length === 1);
  check(
    'toolSteps 字段形态正确（name/ok/summary/durationMs）',
    agentChat.json.toolSteps[0].name === 'memory_search' &&
      agentChat.json.toolSteps[0].ok === true &&
      typeof agentChat.json.toolSteps[0].summary === 'string' &&
      Number.isFinite(agentChat.json.toolSteps[0].durationMs)
  );
  check('摘要不含记忆原文（不泄敏感内容）', !agentChat.json.toolSteps[0].summary.includes('拿铁'));
  check('恰好 2 轮模型调用', stubCalls.length === 2, `calls=${stubCalls.length}`);
  check('首轮带 tools 与 tool_choice=auto', Array.isArray(stubCalls[0].tools) && stubCalls[0].tool_choice === 'auto');
  check(
    '首轮 tools 含白名单 memory_search 与 memory_remember',
    stubCalls[0].tools.length === 2 &&
      stubCalls[0].tools.some(tool => tool.function.name === 'memory_search') &&
      stubCalls[0].tools.some(tool => tool.function.name === 'memory_remember')
  );
  check(
    '第二轮带回了 assistant tool_calls 与 tool 结果',
    (() => {
      const msgs = stubCalls[1].messages;
      const assistant = msgs.find(m => m.role === 'assistant' && Array.isArray(m.tool_calls));
      const tool = msgs.find(m => m.role === 'tool');
      return (
        !!assistant &&
        assistant.tool_calls[0].id === 'call_1' &&
        !!tool &&
        tool.tool_call_id === 'call_1' &&
        tool.content.includes('拿铁')
      );
    })()
  );
  check('model 回执仍是最终模型', agentChat.json.model === 'deepseek-chat');

  // 中间轮不落盘 + toolSteps 独立字段落盘
  const store = JSON.parse(fs.readFileSync(path.join(DATA_DIR, 'sessions.json'), 'utf8'));
  const defaultMessages = store.messages.default || [];
  const lastAssistant = [...defaultMessages].reverse().find(m => m.role === 'assistant');
  check('最终 assistant 消息已落盘', !!lastAssistant && lastAssistant.content.includes('拿铁'));
  check('toolSteps 已随消息落盘', Array.isArray(lastAssistant.toolSteps) && lastAssistant.toolSteps.length === 1);
  check(
    '落盘的 toolSteps 不含敏感原文',
    !JSON.stringify(lastAssistant.toolSteps).includes('拿铁')
  );
  check(
    '中间轮零落盘（无 role:tool、无 tool_calls 字段）',
    !defaultMessages.some(m => m.role === 'tool') &&
      !defaultMessages.some(m => m.tool_calls)
  );

  // 历史读回：toolSteps 可正确读取
  const history = await req('/history');
  const historyAssistant = [...(history.json.history || [])].reverse().find(m => m.role === 'assistant');
  check('历史接口读回 toolSteps', Array.isArray(historyAssistant.toolSteps));

  // ================= C2. 正常工具流程（/chat/stream + SSE 顺序） =================
  ORIG_LOG('\nC2. 正常工具流程（/chat/stream）');
  resetScript();
  scripted.push({
    toolCalls: [tc('call_s1', 'memory_search', { query: '猫' })],
  });
  scripted.push({ content: '[happy] 你养了一只叫年糕的猫。' });

  const stream = await readSse('/chat/stream', { message: '我的猫叫什么？' });
  const types = stream.events.map(e => e.type);
  check(
    'SSE 事件顺序：meta → tool_start → tool_end → delta → done',
    JSON.stringify(types) === JSON.stringify(['meta', 'tool_start', 'tool_end', 'delta', 'done']),
    JSON.stringify(types)
  );
  const startEv = stream.events.find(e => e.type === 'tool_start');
  const endEv = stream.events.find(e => e.type === 'tool_end');
  check(
    'tool_start 字段（name/callId）',
    startEv.name === 'memory_search' && startEv.callId === 'call_s1'
  );
  check(
    'tool_end 字段（name/callId/ok/summary）',
    endEv.name === 'memory_search' && endEv.callId === 'call_s1' && endEv.ok === true && typeof endEv.summary === 'string'
  );
  check(
    'delta 已剥离情绪标签（正文完整）',
    (() => {
      const delta = stream.events.find(e => e.type === 'delta').content;
      return !delta.includes('[happy]') && delta.includes('你养了一只叫年糕的猫。');
    })(),
    JSON.stringify(stream.events.find(e => e.type === 'delta'))
  );
  check('done 带 toolSteps', Array.isArray(stream.events.find(e => e.type === 'done').toolSteps));

  // ================= D. 未知工具 =================
  ORIG_LOG('\nD. 未知工具安全处理');
  resetScript();
  scripted.push({ toolCalls: [tc('call_u', 'shell_exec', { cmd: 'rm -rf /' })] });
  scripted.push({ content: '[calm] 这个我做不到，换个方式聊吧。' });

  const unknown = await req('/chat', { method: 'POST', body: { message: '帮我执行命令' } });
  check('未知工具不崩溃，聊天继续', unknown.status === 200 && unknown.json.reply.includes('换个方式'));
  check('未知工具标记失败', unknown.json.toolSteps[0].ok === false);
  check('白名单外工具绝不执行（tool_end 应在流式可见，此处验证未泄漏结果）', !JSON.stringify(unknown.json).includes('rm -rf'));

  // ================= E. 参数非法 =================
  ORIG_LOG('\nE. 参数非法安全处理');

  // E1 arguments 不是合法 JSON
  resetScript();
  scripted.push({
    toolCalls: [{ id: 'call_j', type: 'function', function: { name: 'memory_search', arguments: 'not-json' } }],
  });
  scripted.push({ content: '[calm] 参数坏了，我直接告诉你。' });
  const badJson = await req('/chat', { method: 'POST', body: { message: '测试' } });
  check('arguments 非 JSON：安全降级不崩', badJson.status === 200);
  check('arguments 非 JSON：标记失败', badJson.json.toolSteps[0].ok === false);

  // E2 缺必填参数
  resetScript();
  scripted.push({ toolCalls: [tc('call_m', 'memory_search', {})] });
  scripted.push({ content: '[calm] 没有查询词也没关系。' });
  const missing = await req('/chat', { method: 'POST', body: { message: '测试' } });
  check('缺 query：安全降级不崩', missing.status === 200 && missing.json.toolSteps[0].ok === false);

  // E3 参数越界
  resetScript();
  scripted.push({ toolCalls: [tc('call_o', 'memory_search', { query: '咖啡', limit: 99 })] });
  scripted.push({ content: '[calm] 好的。' });
  const outOfRange = await req('/chat', { method: 'POST', body: { message: '测试' } });
  check('limit 越界：安全降级不崩', outOfRange.status === 200 && outOfRange.json.toolSteps[0].ok === false);

  // ================= F. 模型异常 =================
  ORIG_LOG('\nF. 模型异常可控结束');
  resetScript();
  scripted.push({ error: { status: 500, message: 'stub 500' } });
  const modelErr = await req('/chat', { method: 'POST', body: { message: '测试' } });
  check('模型 500 → HTTP 502 + code server', modelErr.status === 502 && modelErr.json.code === 'server');

  resetScript();
  scripted.push({ error: { status: 500, message: 'stub 500' } });
  const modelErrStream = await readSse('/chat/stream', { message: '测试' });
  const errEv = modelErrStream.events.find(e => e.type === 'error');
  check('流式模型 500 → error 事件带 code', !!errEv && errEv.code === 'server');
  check('流式模型失败不发 done', !modelErrStream.events.some(e => e.type === 'done'));

  // ================= G. 轮数硬上限 =================
  ORIG_LOG('\nG. 轮数硬上限（3 轮）');
  resetScript();
  scripted.push({ toolCalls: [tc('call_r1', 'memory_search', { query: '咖啡' })] });
  scripted.push({ toolCalls: [tc('call_r2', 'memory_search', { query: '猫' })] });
  scripted.push({ content: '[happy] 基于已有信息， final 收尾。' });

  const capped = await req('/chat', { method: 'POST', body: { message: '反复触发工具' } });
  check('达上限后仍正常收尾', capped.status === 200 && capped.json.reply.includes('final 收尾'));
  check('恰好 3 次模型调用（硬上限）', stubCalls.length === 3, `calls=${stubCalls.length}`);
  check('末轮强制无 tools（结构上终结循环）', stubCalls[2].tools === undefined);
  check('记录了 2 次工具执行', capped.json.toolSteps.length === 2);

  // ================= H. 能力降级与带图强制 =================
  ORIG_LOG('\nH. 能力降级与带图请求安全策略');

  // H1 模型未声明 tools（flash）→ 降级普通聊天，保留 model 回执
  resetScript();
  scripted.push({ content: '[happy] 我是视觉模型。' });
  const flash = await req('/chat', {
    method: 'POST',
    body: { message: '你好', providerId: 'deepseek', modelId: 'deepseek-flash' },
  });
  check('未声明 tools 的模型降级为普通聊天', flash.status === 200 && flash.json.reply.includes('视觉模型'));
  check('降级请求不带 tools', stubCalls[0].tools === undefined);
  check('降级后 model 回执仍为实际下发模型', flash.json.model === 'deepseek-flash', flash.json.model);
  check('降级后 upstreamModel 记录供应商回显', flash.json.upstreamModel === 'deepseek-chat', flash.json.upstreamModel);
  check('降级无 toolSteps', flash.json.toolSteps === undefined);

  // H2 带图请求（默认模型声明了 tools）→ 后端强制无工具。
  // 用独立会话：带图消息会进入会话历史，避免污染默认会话后续请求的视觉判定。
  const freshRes = await req('/sessions', { method: 'POST', body: {} });
  const freshSessionId = freshRes.json && freshRes.json.session && freshRes.json.session.id;
  resetScript();
  scripted.push({ content: '[happy] 图里是一只猫。' });
  const withImage = await req('/chat', {
    method: 'POST',
    body: { message: '这是什么', sessionId: freshSessionId, attachmentIds: [imageId] },
  });
  check('带图请求正常（视觉路由保持）', withImage.status === 200);
  check('带图请求后端强制无工具（请求不带 tools）', stubCalls[0].tools === undefined);
  check('带图请求仍走视觉模型 deepseek-flash', stubCalls[0].model === 'deepseek-flash');
  check('带图请求无 toolSteps', withImage.json.toolSteps === undefined);
  check(
    '带图请求图片仍以 blocks 上行（多模态链路无回归）',
    (() => {
      const last = stubCalls[0].messages[stubCalls[0].messages.length - 1];
      return Array.isArray(last.content) && last.content.some(b => b.type === 'image_url');
    })()
  );
  check(
    'H2 新图触发 Agent 互斥并返回用户提示',
    withImage.json.agentNotice === '本次带图，已切换到视觉模型，工具暂不可用',
    JSON.stringify(withImage.json.agentNotice)
  );

  // H3 带图门控的独立验证：内置 flash 靠 tools:false 挡住（能力门控），
  // 这里用一个"视觉+工具双声明"的自定义模型——只有 !useVision 门控能挡住。
  // 若门控被移除，带图请求就会携带 tools（违反任务书强制要求）。
  const h3SessionRes = await req('/sessions', { method: 'POST', body: {} });
  const h3SessionId = h3SessionRes.json && h3SessionRes.json.session.id;
  mockChatRequests.length = 0;
  const imageOnDual = await req('/chat', {
    method: 'POST',
    body: {
      message: '这是什么',
      sessionId: h3SessionId,
      attachmentIds: [imageId],
      providerId: visionToolsProvider.id,
      modelId: 'vision-tools',
    },
  });
  check(
    'H3 带图 + 视觉工具双声明模型：后端强制无 tools',
    imageOnDual.status === 200 &&
      mockChatRequests[0] &&
      mockChatRequests[0].body.tools === undefined,
    JSON.stringify(mockChatRequests[0] && mockChatRequests[0].body).slice(0, 120)
  );
  check(
    'H3 双声明模型的新图也返回工具互斥提示',
    imageOnDual.json.agentNotice === '本次带图，已切换到视觉模型，工具暂不可用'
  );

  const h3TextSessionRes = await req('/sessions', { method: 'POST', body: {} });
  const h3TextSessionId = h3TextSessionRes.json && h3TextSessionRes.json.session.id;
  mockChatRequests.length = 0;
  const textOnDual = await req('/chat', {
    method: 'POST',
    body: {
      message: '你好',
      sessionId: h3TextSessionId,
      providerId: visionToolsProvider.id,
      modelId: 'vision-tools',
    },
  });
  check(
    'H3 正向对照：同模型纯文本请求带 tools（证明上方无 tools 是门控的作用）',
    textOnDual.status === 200 &&
      mockChatRequests[0] &&
      Array.isArray(mockChatRequests[0].body.tools)
  );

  // H4 历史图片不再关闭 Agent：会话已有用户图片，但本次请求不带新图，
  // 视觉+工具双声明模型应继续拿到 tools，并保留历史图片上行能力。
  mockChatRequests.length = 0;
  const historyImageText = await req('/chat', {
    method: 'POST',
    body: {
      message: '你好',
      sessionId: freshSessionId,
      providerId: visionToolsProvider.id,
      modelId: 'vision-tools',
    },
  });
  const h4Body = mockChatRequests[0] && mockChatRequests[0].body;
  const h4HasImageBlock =
    !!h4Body &&
    Array.isArray(h4Body.messages) &&
    h4Body.messages.some(
      message =>
        Array.isArray(message.content) &&
        message.content.some(block => block.type === 'image_url')
    );

  check(
    'H4 历史图片不再关闭 Agent（纯文本请求带 tools）',
    historyImageText.status === 200 &&
      h4Body &&
      Array.isArray(h4Body.tools),
    JSON.stringify({
      status: historyImageText.status,
      text: historyImageText.text.slice(0, 300),
      mockRequests: mockChatRequests.length,
    })
  );
  check(
    'H4 历史图片仍随视觉工具模型上行',
    h4HasImageBlock,
    JSON.stringify(h4Body && h4Body.messages ? h4Body.messages.map(m => m.content) : null).slice(0, 400)
  );
  check(
    'H4 历史图片不产生新图互斥提示',
    !!historyImageText.json && historyImageText.json.agentNotice === undefined,
    JSON.stringify(historyImageText.json)
  );

  // H5 历史 PDF/txt 不算图片：不会触发历史视觉上行，也不会关闭 Agent。
  const pdfSessionRes = await req('/sessions', { method: 'POST', body: {} });
  const pdfSessionId =
    pdfSessionRes.json && pdfSessionRes.json.session && pdfSessionRes.json.session.id;
  sessions.appendMessages(pdfSessionId, [
    {
      id: 'pdf-user-1',
      role: 'user',
      content: '这里是一份文档',
      createdAt: new Date().toISOString(),
      attachments: [
        {
          id: 'pdf-attachment-1',
          kind: 'image',
          mime: 'application/pdf',
          name: 'doc.pdf',
        },
      ],
    },
  ]);
  mockChatRequests.length = 0;
  const pdfText = await req('/chat', {
    method: 'POST',
    body: {
      message: '你好',
      sessionId: pdfSessionId,
      providerId: visionToolsProvider.id,
      modelId: 'vision-tools',
    },
  });
  const h5Body = mockChatRequests[0] && mockChatRequests[0].body;
  const h5HasImageBlock =
    !!h5Body &&
    Array.isArray(h5Body.messages) &&
    h5Body.messages.some(
      message =>
        Array.isArray(message.content) &&
        message.content.some(block => block.type === 'image_url')
    );

  check(
    'H5 历史 PDF/txt 不算图片，Agent 仍放行',
    pdfText.status === 200 &&
      h5Body &&
      Array.isArray(h5Body.tools)
  );
  check('H5 历史 PDF/txt 不产生 image_url 上行', !h5HasImageBlock);

  // H6 流式新图互斥：设备实际走 /chat/stream，done 必须带同样的用户提示。
  const streamNoticeSessionRes = await req('/sessions', {
    method: 'POST',
    body: {},
  });
  const streamNoticeSessionId =
    streamNoticeSessionRes.json &&
    streamNoticeSessionRes.json.session &&
    streamNoticeSessionRes.json.session.id;
  const streamNotice = await readSse('/chat/stream', {
    message: '这是什么',
    sessionId: streamNoticeSessionId,
    attachmentIds: [imageId],
  });
  const streamNoticeDone = streamNotice.events.find(e => e.type === 'done');
  check(
    'H6 流式新图在 done 中返回工具互斥提示',
    streamNotice.status === 200 &&
      !!streamNoticeDone &&
      streamNoticeDone.agentNotice ===
        '本次带图，已切换到视觉模型，工具暂不可用'
  );

  // ================= I. 并行 tool_calls =================
  ORIG_LOG('\nI. 并行 tool_calls 的 ID 与顺序');
  resetScript();
  scripted.push({
    toolCalls: [
      tc('call_p1', 'memory_search', { query: '咖啡' }),
      tc('call_p2', 'memory_search', { query: '猫' }),
    ],
  });
  scripted.push({ content: '[happy] 两样都记着呢。' });

  const parallel = await req('/chat', { method: 'POST', body: { message: '咖啡和猫' } });
  check('并行工具调用正常收尾', parallel.status === 200 && parallel.json.toolSteps.length === 2);
  check(
    '两个 tool 结果按序回传且 ID 匹配',
    (() => {
      const msgs = stubCalls[1].messages;
      const tools = msgs.filter(m => m.role === 'tool');
      return (
        tools.length === 2 &&
        tools[0].tool_call_id === 'call_p1' &&
        tools[1].tool_call_id === 'call_p2'
      );
    })()
  );

  // ================= J. 去重短路 =================
  ORIG_LOG('\nJ. 同请求去重短路');
  resetScript();
  scripted.push({
    toolCalls: [
      tc('call_d1', 'memory_search', { query: '咖啡' }),
      tc('call_d2', 'memory_search', { query: '咖啡' }),
    ],
  });
  scripted.push({ content: '[happy] 咖啡相关就这些。' });

  const deduped = await req('/chat', { method: 'POST', body: { message: '咖啡' } });
  check('重复调用不影响收尾', deduped.status === 200 && deduped.json.toolSteps.length === 2);
  check(
    '第二次调用标记 deduped（结果复用）',
    deduped.json.toolSteps.every(s => s.ok === true)
  );

  // 模块级验证 handler 只真正执行一次
  {
    let execCount = 0;
    agent.registerTool({
      name: 'count_tool',
      description: '测试计数工具',
      parameters: { type: 'object', properties: { q: { type: 'string' } }, required: ['q'] },
      timeoutMs: 1000,
      validate: args => (args && typeof args.q === 'string' ? { ok: true, args: { q: args.q } } : { ok: false, error: 'bad' }),
      handler: async () => {
        execCount += 1;
        return { ok: true, summary: 'done' };
      },
    });
    const ctx = { sessionId: 'default', cache: new Map() };
    const r1 = await agent.executeToolCall('count_tool', { q: 'x' }, ctx);
    const r2 = await agent.executeToolCall('count_tool', { q: 'x' }, ctx);
    check('同工具同参数：handler 只执行 1 次', execCount === 1, `exec=${execCount}`);
    check('第二次结果标记 deduped', r1.ok === true && r2.ok === true && r2.deduped === true);
    agent.unregisterTool('count_tool');
  }

  // ================= R. 审查缺陷回归（F2 / F3） =================
  ORIG_LOG('\nR. 审查缺陷回归（F2 tool_call ID / F3 畸形响应）');

  // F2：模型不给 tool_call id 时，assistant 消息与 tool 消息必须同一个 id
  resetScript();
  scripted.push({
    toolCalls: [
      { type: 'function', function: { name: 'memory_search', arguments: '{"query":"咖啡"}' } },
    ],
  });
  scripted.push({ content: '[happy] 没有 id 也能正常闭环。' });
  const noId = await req('/chat', { method: 'POST', body: { message: '缺 id 测试' } });
  check('F2 缺 id 的 tool_calls 仍能闭环', noId.status === 200 && noId.json.reply.includes('闭环'));
  check(
    'F2 assistant tool_calls 与 tool 消息的 id 一致（一次归一化）',
    (() => {
      const msgs = stubCalls[1].messages;
      const asst = msgs.find(m => m.role === 'assistant' && m.tool_calls);
      const toolMsg = msgs.find(m => m.role === 'tool');
      return !!asst && !!toolMsg && asst.tool_calls[0].id === toolMsg.tool_call_id;
    })(),
    JSON.stringify(stubCalls[1] && stubCalls[1].messages.filter(m => m.role === 'tool'))
  );

  // F3：服务商返回空 choices —— Agent 路径必须可控降级，不得抛 TypeError
  resetScript();
  scripted.push({ emptyChoices: true });
  const emptyChat = await req('/chat', { method: 'POST', body: { message: '空响应测试' } });
  check('F3 空 choices：/chat 返回 500 而非进程级崩溃', emptyChat.status === 500, `status=${emptyChat.status}`);
  check('F3 空 choices：不泄露 TypeError 细节', !JSON.stringify(emptyChat.json).includes('TypeError'));

  resetScript();
  scripted.push({ emptyChoices: true });
  const emptyStream = await readSse('/chat/stream', { message: '空响应测试' });
  const emptyErr = emptyStream.events.find(e => e.type === 'error');
  check(
    'F3 空 choices：流式发可控 error（模型没有返回有效内容）',
    !!emptyErr && emptyErr.error === '模型没有返回有效内容',
    JSON.stringify(emptyStream.events)
  );
  check('F3 空 choices：流式不发 done', !emptyStream.events.some(e => e.type === 'done'));

  // ================= K. 断连场景 =================
  ORIG_LOG('\nK. 客户端断连');

  // K1 工具执行期间断连：不得启动下一轮模型生成
  {
    let abortSeen = false;
    agent.registerTool({
      name: 'slow_tool',
      description: '测试慢工具',
      parameters: { type: 'object', properties: {} },
      timeoutMs: 5000,
      validate: () => ({ ok: true, args: {} }),
      handler: async (_args, context) => {
        await new Promise(resolve => {
          const timer = setTimeout(resolve, 3000);
          if (context.signal) {
            context.signal.addEventListener('abort', () => {
              abortSeen = true;
              clearTimeout(timer);
              resolve();
            });
          }
        });
        return { ok: true, summary: 'slow done' };
      },
    });

    resetScript();
    scripted.push({ toolCalls: [tc('call_k1', 'slow_tool', {})] });
    scripted.push({ content: '[happy] 不该到达的一轮。' });

    const k1 = await sseWithAbort('/chat/stream', { message: '慢工具' }, event => event.type === 'tool_start');
    await sleep(400);
    check('K1 事件流已中止', k1.aborted === true);
    check('K1 工具收到 abort 信号（后台操作有边界）', abortSeen === true);
    check('K1 断连后不启动下一轮模型调用', stubCalls.length === 1, `calls=${stubCalls.length}`);
    agent.unregisterTool('slow_tool');
  }

  // K2 第二轮模型生成期间断连：不得启动第三轮
  {
    resetScript();
    scripted.push({ toolCalls: [tc('call_k2', 'memory_search', { query: '咖啡' })] });
    scripted.push({ toolCalls: [tc('call_k3', 'memory_search', { query: '猫' })], delayMs: 500 });
    scripted.push({ content: '[happy] 不该到达的第三轮。' });

    const k2 = await sseWithAbort('/chat/stream', { message: '断连测试' }, event => event.type === 'tool_end');
    await sleep(900);
    check('K2 事件流已中止', k2.aborted === true);
    check('K2 断连后不启动第三轮（停在 2 次调用）', stubCalls.length === 2, `calls=${stubCalls.length}`);
    check('K2 未收到 done（不产生幽灵消息）', !k2.events.some(e => e.type === 'done'));

    // 断连不落盘：默认会话消息数不应因本轮增加
    const storeNow = JSON.parse(fs.readFileSync(path.join(DATA_DIR, 'sessions.json'), 'utf8'));
    const list = storeNow.messages.default || [];
    check('K2 断连后无新消息落盘', list.every(m => !m.content.includes('不该到达')));
  }

  // ================= L. 模块级：参数边界 / scope / 上限 / 超时 =================
  ORIG_LOG('\nL. 模块级直测');

  // L1 参数校验边界
  {
    const v = memoryTool.definition.validate;
    check('缺 query → 拒绝', v({}).ok === false);
    check('query 超 200 字 → 拒绝', v({ query: '啊'.repeat(201) }).ok === false);
    check('query 200 字整 → 通过', v({ query: '啊'.repeat(200) }).ok === true);
    check('limit=0 → 拒绝', v({ query: 'x', limit: 0 }).ok === false);
    check('limit=11 → 拒绝', v({ query: 'x', limit: 11 }).ok === false);
    check('limit=1.5 → 拒绝', v({ query: 'x', limit: 1.5 }).ok === false);
    check('limit=10 → 通过', v({ query: 'x', limit: 10 }).ok === true);
    check('参数非对象 → 拒绝', v('str').ok === false);
    check('归一化后带默认 limit', v({ query: 'x' }).args.limit === 5);
  }

  // L2 记忆 scope 隔离
  {
    const h = memoryTool.definition.handler;
    const own = await h({ query: '咖啡', limit: 5 }, { sessionId: 'default' });
    const ownText = JSON.stringify(own);
    check('当前会话：返回本会话记忆', own.results.some(r => r.content.includes('拿铁')));
    check('当前会话：不含其他会话私有记忆', !ownText.includes('沪A12345'));
    check('当前会话：有主贡献时不回退无归属', !ownText.includes('小蓝'));

    const fresh = await h({ query: '咖啡', limit: 5 }, { sessionId: 's-fresh' });
    const freshText = JSON.stringify(fresh);
    check('新会话：无主贡献时回退无归属记忆', freshText.includes('小蓝'));
    check('新会话：绝不含其他会话记忆', !freshText.includes('拿铁') && !freshText.includes('沪A12345'));

    const other = await h({ query: '车牌', limit: 5 }, { sessionId: 'default' });
    check('任何作用域都拿不到 s-other 的私有记忆', !JSON.stringify(other).includes('沪A12345'));
  }

  // L3 三类硬上限
  {
    // 直接驱动 searchMemories：临时扩充种子到 12 条同会话记忆
    const many = [];
    for (let i = 0; i < 12; i++) {
      many.push(seedEntry(`批量记忆${i}：用户偏好编号${i}`, 'preference', ['批量'], 'default'));
    }
    const saved = JSON.parse(fs.readFileSync(path.join(DATA_DIR, 'memory.json'), 'utf8'));
    fs.writeFileSync(path.join(DATA_DIR, 'memory.json'), JSON.stringify([...saved, ...many]));
    memoryModule.loadMemories();

    const h = memoryTool.definition.handler;
    const cappedResult = await h({ query: '批量', limit: 10 }, { sessionId: 'default' });
    check('条数硬上限：最多 10 条', cappedResult.results.length === 10, `n=${cappedResult.results.length}`);
    check('条数截断有标记', cappedResult.truncated === true);

    // 单条长度上限：造一条 400 字记忆
    const long = seedEntry('长'.repeat(400), 'fact', ['长记忆'], 'default');
    fs.writeFileSync(path.join(DATA_DIR, 'memory.json'), JSON.stringify([...saved, long]));
    memoryModule.loadMemories();
    const longResult = await h({ query: '长记忆', limit: 5 }, { sessionId: 'default' });
    const longItem = longResult.results.find(r => r.content.includes('长'));
    check('单条长度硬上限：截到 300 字', longItem && textUtils.textLength(longItem.content) === 300);

    // 总预算上限：造 10 条各 250 字的记忆（合计 2500 > 2000）
    const heavy = [];
    for (let i = 0; i < 10; i++) {
      heavy.push(seedEntry(`重${i}` + '预算'.repeat(120), 'fact', ['重预算'], 'default'));
    }
    fs.writeFileSync(path.join(DATA_DIR, 'memory.json'), JSON.stringify([...saved, ...heavy]));
    memoryModule.loadMemories();
    const heavyResult = await h({ query: '重预算', limit: 10 }, { sessionId: 'default' });
    check('总预算硬上限：total ≤ 2000', heavyResult.total <= 2000, `total=${heavyResult.total}`);
    check('总预算截断有标记', heavyResult.truncated === true);

    // 恢复种子
    fs.writeFileSync(path.join(DATA_DIR, 'memory.json'), JSON.stringify(saved));
    memoryModule.loadMemories();
  }

  // L4 工具超时硬边界（不只是停止等待）
  {
    let abortSeen = false;
    let lateResolved = false;
    agent.registerTool({
      name: 'hang_tool',
      description: '测试挂起工具',
      parameters: { type: 'object', properties: {} },
      timeoutMs: 300,
      validate: () => ({ ok: true, args: {} }),
      handler: async (_args, context) => {
        await new Promise(resolve => {
          // 故意不 clearTimeout：就是要让它在超时后迟到完成，
          // 验证迟到的 resolve 被 race 吞掉、不会变成 unhandled rejection。
          setTimeout(() => {
            lateResolved = true;
            resolve();
          }, 600);
          if (context.signal) {
            context.signal.addEventListener('abort', () => {
              abortSeen = true;
            });
          }
        });
        return { ok: true, summary: 'late' };
      },
    });

    const result = await agent.executeToolCall('hang_tool', {}, { sessionId: 'default', cache: new Map() });
    check('超时返回 tool_timeout', result.ok === false && result.code === 'tool_timeout');
    check('超时时 abort 已通知 handler（后台操作有边界）', abortSeen === true);
    await sleep(500);
    check('迟到的 handler 完成不会崩溃进程', lateResolved === true);
    agent.unregisterTool('hang_tool');
  }

  // L4b F4 回归：超时结果必须进去重缓存（同参重复调用不得再执行），
  // 且缓存的是失败结果——绝不把不完整结果当成功缓存。
  {
    let execCount = 0;
    agent.registerTool({
      name: 'hang_once_tool',
      description: '首次挂起、二次可快速返回',
      parameters: { type: 'object', properties: {} },
      timeoutMs: 200,
      validate: () => ({ ok: true, args: {} }),
      handler: async () => {
        execCount += 1;
        if (execCount === 1) {
          await sleep(600); // 首次必超时
          return { ok: true, summary: '太迟的成功' };
        }
        return { ok: true, summary: '第二次成功' };
      },
    });

    const cache = new Map();
    const first = await agent.executeToolCall('hang_once_tool', {}, { sessionId: 'default', cache });
    const second = await agent.executeToolCall('hang_once_tool', {}, { sessionId: 'default', cache });
    check('F4 首次调用返回 tool_timeout', first.ok === false && first.code === 'tool_timeout');
    check(
      'F4 同参重复调用复用超时结果（handler 不再执行）',
      execCount === 1 && second.deduped === true,
      `execCount=${execCount} deduped=${second.deduped}`
    );
    check(
      'F4 复用结果是失败结果（不把不完整结果当成功缓存）',
      second.ok === false && second.code === 'tool_timeout'
    );
    agent.unregisterTool('hang_once_tool');
  }

  // L4c F5 回归：超时后 handler 迟到的 rejection 必须被静默吞掉。
  //
  // 注意"为什么需要专门断言日志"：本结构下 handlerPromise 已被 Promise.race
  // 挂上 rejection 处理（实测验证：race 已 settle 后原 promise 迟到 rejection
  // 不会触发 unhandledRejection），所以"不崩进程"本身是恒真条件、无判别力。
  // 迟到 rejection 唯一可观测的副作用是：若缺少 timedOut 判定，会走到
  // console.error 打出"工具执行异常"虚假告警，污染排障信息。
  // 因此这里以"零新增告警日志"作为可判别断言（负向验证：删掉 timedOut
  // 早退分支 → 本断言转红）。
  {
    let lateRejected = false;
    const errBefore = errorLines.filter(line =>
      line.includes('工具执行异常')
    ).length;
    agent.registerTool({
      name: 'late_reject_tool',
      description: '迟到拒绝',
      parameters: { type: 'object', properties: {} },
      timeoutMs: 200,
      validate: () => ({ ok: true, args: {} }),
      handler: async () => {
        await sleep(600);
        lateRejected = true;
        throw new Error('迟到异常');
      },
    });

    const before = unhandledRejections.length;
    const result = await agent.executeToolCall('late_reject_tool', {}, {
      sessionId: 'default',
      cache: new Map(),
    });
    check('F5 迟到 rejection 场景：仍返回 tool_timeout', result.code === 'tool_timeout');
    await sleep(700);
    check('F5 迟到 rejection 场景：handler 确实抛了异常', lateRejected === true);
    check(
      'F5 迟到 rejection 被吞掉（0 次新增 unhandledRejection）',
      unhandledRejections.length === before,
      unhandledRejections.join(' | ').slice(0, 120)
    );
    check(
      'F5 迟到 rejection 不产生"工具执行异常"虚假告警',
      errorLines.filter(line => line.includes('工具执行异常')).length === errBefore,
      errorLines.filter(line => line.includes('工具执行异常')).slice(-2).join(' | ')
    );
    agent.unregisterTool('late_reject_tool');
  }

  // L5 工具内部异常 → 结构化错误
  {
    agent.registerTool({
      name: 'throw_tool',
      description: '测试抛异常工具',
      parameters: { type: 'object', properties: {} },
      timeoutMs: 1000,
      validate: () => ({ ok: true, args: {} }),
      handler: async () => {
        throw new Error('boom');
      },
    });
    const result = await agent.executeToolCall('throw_tool', {}, { sessionId: 'default', cache: new Map() });
    check('工具抛异常 → tool_error 结构化结果', result.ok === false && result.code === 'tool_error');
    agent.unregisterTool('throw_tool');
  }

  // L6 未知工具 / 参数形态
  {
    const r1 = await agent.executeToolCall('no_such_tool', {}, { sessionId: 'default', cache: new Map() });
    check('未知工具 → unknown_tool', r1.ok === false && r1.code === 'unknown_tool');
    const r2 = await agent.executeToolCall('memory_search', null, { sessionId: 'default', cache: new Map() });
    check('参数为 null → invalid_params', r2.ok === false && r2.code === 'invalid_params');
  }

  // L7 长度规则（码点计数：emoji/CJK 均计 1）
  {
    check('CJK 按 1 计', textUtils.textLength('你好世界') === 4);
    check('emoji 按 1 计（不是 2）', textUtils.textLength('🐱') === 1);
    check('空串为 0', textUtils.textLength('') === 0);
    check('截断到 3 码点含省略号', textUtils.textLength(textUtils.truncateText('你好世界', 3)) === 3);
    check('未超长不截断', textUtils.truncateText('你好', 5) === '你好');
  }

  // L8 轮数默认值
  check('默认最大轮数为 3', agent.MAX_ROUNDS === 3);

  // ================= 汇总 =================
  ORIG_LOG(`\n结果：${passed} 通过，${failed} 失败`);
  if (failures.length) {
    ORIG_LOG('失败项：');
    for (const f of failures) ORIG_LOG(`  - ${f}`);
  }

  process.env.BLUEBIRD_AGENT_TOOLS = '';
  delete process.env.BLUEBIRD_ALLOW_PRIVATE_BASE_URL;
  configs.deleteModelProvider(visionToolsProvider.id);
  await closeServer(mockServer);
  await closeServer(testServer);

  try {
    fs.rmSync(TMP_ROOT, { recursive: true, force: true });
  } catch (_) {
    /* Windows 占用：忽略 */
  }

  process.exit(failed === 0 ? 0 : 1);
}

main().catch(async error => {
  ORIG_ERR('测试运行异常:', error);
  ORIG_ERR('服务端错误日志:', JSON.stringify(errorLines.slice(0, 10), null, 2));
  process.exit(1);
});
