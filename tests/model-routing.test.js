/**
 * 云岫 Bluebird — 请求级模型选择与图片视觉路由测试（model-routing.test.js）
 *
 * 独立脚本（与 tests/model-providers.test.js 同款极简 runner）。
 * 单独成文件的原因：限流桶按 ip+token 计数（60 次/分钟），本组用例需要
 * 额外十几次真实 HTTP 请求，并入大套件会挤爆限流桶产生 429 误报；
 * 独立进程 = 独立限流桶，且不碰 server/data。
 *
 * 覆盖：
 *   A. 请求级模型选择（携带 providerId/modelId）：A→A、B→B、缺省回退全局默认、
 *      请求级选择不写回全局默认、无效模型明确报错且零上游请求。
 *   B. 图片视觉路由：视觉模型直接处理；非视觉模型自动路由并回报实际模型与原因；
 *      服务商无视觉模型时明确报错。
 *   C. 流式：done 事件的路由信息与实际路由一致（含自动路由场景）。
 *
 * 说明：全部为本地桩 + 本地 mock 服务商，不是真实供应商端到端测试。
 *
 * 运行：node tests/model-routing.test.js
 */
const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');

// ---- 关停捕获：退出前必须关掉测试服务与 mock 服务商 ----
const originalListen = http.Server.prototype.listen;
let httpServer = null;

http.Server.prototype.listen = function (...args) {
  httpServer = this;
  return originalListen.apply(this, args);
};

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
const TMP_ROOT = fs.mkdtempSync(path.join(os.tmpdir(), 'bluebird-mr-'));
const DATA_DIR = path.join(TMP_ROOT, 'data');
fs.mkdirSync(DATA_DIR, { recursive: true });

process.env.BLUEBIRD_DATA_DIR = DATA_DIR;
process.env.BLUEBIRD_API_TOKEN = 'test-token';
process.env.DEEPSEEK_API_KEY = 'sk-stub-deepseek-0001';
process.env.PORT = '0';
// 测试旁路：允许自定义 Base URL 指向本地 mock 服务商（生产禁止）
process.env.BLUEBIRD_ALLOW_PRIVATE_BASE_URL = '1';

const SERVER = path.join(__dirname, '..', 'server');

const ORIG_LOG = console.log;
const ORIG_ERR = console.error;
const errorLines = [];

console.log = () => {};
console.error = (...args) => {
  errorLines.push(args.map(item => String(item)).join(' '));
};

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

const CUSTOM_KEY = 'sk-custom-secret-9876';

// ---- 测试图片素材（1x1 PNG） ----
const PNG_B64 =
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAADJRU5ErkJggg==';
const PNG_BUF = Buffer.from(PNG_B64, 'base64');

// ---- openai 桩：内置 DeepSeek 零网络；自定义服务商走真实 SDK 打本地 mock ----
const RealOpenAI = require('openai');
const openaiTarget = require.resolve('openai', { paths: [SERVER] });

const builtinCalls = [];

require.cache[openaiTarget] = {
  id: openaiTarget,
  filename: openaiTarget,
  loaded: true,
  exports: class StubOpenAI {
    constructor(config) {
      this.config = config;
      if (config && config.baseURL === 'https://api.deepseek.com') {
        this.chat = {
          completions: {
            create: async args => {
              builtinCalls.push(args);
              if (args && args.stream) {
                return (async function* () {
                  yield {
                    model: args.model,
                    choices: [{ index: 0, delta: { content: '[calm] 流式回复。' } }],
                  };
                })();
              }
              return {
                model: args.model,
                choices: [
                  { index: 0, message: { role: 'assistant', content: '[calm] 回复正文。' } },
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

// ---- memory / emotion 桩（与其它测试同模式） ----
function stubModule(file, exportsObj) {
  const target = require.resolve(path.join(SERVER, file));
  require.cache[target] = {
    id: target,
    filename: target,
    loaded: true,
    exports: exportsObj,
  };
}

stubModule('memory.js', {
  buildMemoryContext: () => '',
  processMemory: async () => null,
  clearMemories: () => {},
  recallMemoryBySourceQuote: async () => {},
  getMemories: () => [],
  deleteMemory: () => false,
});

stubModule('emotion.js', {
  EMOTIONS: ['calm', 'happy', 'playful', 'excited', 'tired', 'sad', 'annoyed', 'hurt'],
  getEmotion: () => ({ emotion: 'calm', intensity: 0.3 }),
  buildEmotionContext: () => '',
  applyTimeDecay: () => {},
  applyObservation: () => ({ emotion: 'calm', intensity: 0.3 }),
  loadEmotion: () => ({ emotion: 'calm', intensity: 0.3 }),
});

// ---- 本地 mock 服务商（OpenAI Chat Completions 兼容） ----
const mockState = { requests: [] };

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
      /* 非 JSON 也记录 */
    }
    mockState.requests.push({ url: req.url, body: parsed });

    if (req.url.startsWith('/chat/completions')) {
      if (parsed && parsed.stream) {
        res.writeHead(200, { 'Content-Type': 'text/event-stream; charset=utf-8' });
        res.write(
          `data: ${JSON.stringify({
            id: 'chatcmpl-mock',
            object: 'chat.completion.chunk',
            model: parsed.model || 'mock-model',
            choices: [{ index: 0, delta: { role: 'assistant', content: '[calm] ' } }],
          })}\n\n`
        );
        res.write(
          `data: ${JSON.stringify({
            id: 'chatcmpl-mock',
            object: 'chat.completion.chunk',
            model: parsed.model || 'mock-model',
            choices: [{ index: 0, delta: { content: 'mock 流式回复' } }],
          })}\n\n`
        );
        res.write('data: [DONE]\n\n');
        res.end();
        return;
      }
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(
        JSON.stringify({
          id: 'chatcmpl-mock',
          object: 'chat.completion',
          model: parsed.model || 'mock-model',
          choices: [
            { index: 0, message: { role: 'assistant', content: '[calm] mock 回复' } },
          ],
        })
      );
      return;
    }

    res.writeHead(404, { 'Content-Type': 'application/json' });
    res.end('{}');
  });
});

// ---- 启动被测服务 ----
const { server: testServer } = require(path.join(SERVER, 'index.js'));
const serverReady = testServer.listening
  ? Promise.resolve()
  : new Promise(resolve => testServer.once('listening', resolve));

async function req(route, { method = 'GET', body, token = 'test-token' } = {}) {
  const res = await fetch(`http://127.0.0.1:${PORT}${route}`, {
    method,
    headers: {
      Authorization: `Bearer ${token}`,
      ...(body ? { 'Content-Type': 'application/json' } : {}),
    },
    ...(body ? { body: JSON.stringify(body) } : {}),
  });

  let json = null;
  try {
    json = await res.json();
  } catch (_) {
    /* 空响应 */
  }

  return { status: res.status, json };
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

function loadModule(name) {
  return require(path.join(SERVER, name));
}

let PORT = 0;

async function main() {
  await new Promise(resolve => mockServer.listen(0, '127.0.0.1', resolve));
  const MOCK_PORT = mockServer.address().port;
  const MOCK_BASE = `http://127.0.0.1:${MOCK_PORT}`;

  await serverReady;
  PORT = testServer.address().port;
  ORIG_LOG(`测试服务端口=${PORT} mock 服务商端口=${MOCK_PORT}`);

  const uploads = loadModule('uploads.js');
  const configs = loadModule('api-configs.js');

  // 预置一张图片（模块级，不耗 HTTP 配额）
  const imageId = uploads.saveImage({
    dataUrl: `data:image/png;base64,${PNG_BUF.toString('base64')}`,
    kind: 'image',
    name: 'test.png',
  }).id;

  // 自定义服务商：mock-text（无视觉）+ mock-vision（声明视觉）
  const chatProvider = configs.addModelProvider({
    name: '测试服务商',
    baseUrl: MOCK_BASE,
    apiKey: CUSTOM_KEY,
    models: [{ id: 'mock-text' }, { id: 'mock-vision', capabilities: { vision: true } }],
  }).provider;

  // 另一家只有文本模型的服务商：验证「视觉模型不可用」的明确报错
  const textOnlyProvider = configs.addModelProvider({
    name: '纯文本服务商',
    baseUrl: MOCK_BASE,
    apiKey: CUSTOM_KEY,
    models: [{ id: 'text-only' }],
  }).provider;

  // 全局默认设为 deepseek-flash（模块级落盘，不耗 HTTP），
  // 这样「请求级选 deepseek-chat」才能真正证明请求级选择覆盖了全局默认。
  configs.setDefaultModel({ providerId: 'deepseek', modelId: 'deepseek-flash' });

  const sessionId = (await req('/sessions', { method: 'POST', body: {} })).json
    .session.id;

  const upstreamChats = () => mockState.requests.filter(r => r.url.startsWith('/chat/completions'));

  // ================= A. 请求级模型选择 =================
  ORIG_LOG('\nA. 请求级模型选择（请求体携带 providerId/modelId）');

  builtinCalls.length = 0;
  const pickA = await req('/chat', {
    method: 'POST',
    body: {
      message: '选 A',
      sessionId,
      providerId: 'deepseek',
      modelId: 'deepseek-chat',
    },
  });
  const callA = builtinCalls[builtinCalls.length - 1];
  check(
    '请求级 A：全局默认是 flash，请求仍实际下发 deepseek-chat',
    pickA.status === 200 && callA && callA.model === 'deepseek-chat',
    `status=${pickA.status} model=${callA && callA.model}`
  );
  check(
    '请求级 A：响应 model/providerId 与请求一致',
    pickA.json &&
      pickA.json.model === 'deepseek-chat' &&
      pickA.json.providerId === 'deepseek',
    JSON.stringify({ model: pickA.json && pickA.json.model, providerId: pickA.json && pickA.json.providerId })
  );
  check(
    '请求级 A：modelRoute 标记 source=request，未自动路由',
    pickA.json &&
      pickA.json.modelRoute &&
      pickA.json.modelRoute.requested.source === 'request' &&
      pickA.json.modelRoute.requested.modelId === 'deepseek-chat' &&
      pickA.json.modelRoute.actual.modelId === 'deepseek-chat' &&
      pickA.json.modelRoute.auto === false &&
      pickA.json.modelRoute.reason === null,
    JSON.stringify(pickA.json && pickA.json.modelRoute)
  );

  builtinCalls.length = 0;
  const pickB = await req('/chat', {
    method: 'POST',
    body: {
      message: '选 B',
      sessionId,
      providerId: 'deepseek',
      modelId: 'deepseek-flash',
    },
  });
  const callB = builtinCalls[builtinCalls.length - 1];
  check(
    '请求级切到 B：新请求实际下发 deepseek-flash',
    pickB.status === 200 && callB && callB.model === 'deepseek-flash',
    `model=${callB && callB.model}`
  );

  // 不带 ids：回退全局默认（旧客户端兼容）
  builtinCalls.length = 0;
  const noIds = await req('/chat', {
    method: 'POST',
    body: { message: '旧客户端', sessionId },
  });
  const callDefault = builtinCalls[builtinCalls.length - 1];
  check(
    '未提供请求级模型：使用全局默认 deepseek-flash',
    noIds.status === 200 && callDefault && callDefault.model === 'deepseek-flash',
    `model=${callDefault && callDefault.model}`
  );
  check(
    '未提供请求级模型：modelRoute.requested.source=default',
    noIds.json &&
      noIds.json.modelRoute &&
      noIds.json.modelRoute.requested.source === 'default' &&
      noIds.json.modelRoute.requested.modelId === 'deepseek-flash',
    JSON.stringify(noIds.json && noIds.json.modelRoute)
  );

  // 请求级选择不写回全局默认（内存 + 落盘）
  const defaultsNow = (await req('/model-providers')).json.defaults;
  check(
    '请求级选择不改变全局默认（GET /model-providers）',
    defaultsNow.providerId === 'deepseek' && defaultsNow.modelId === 'deepseek-flash',
    JSON.stringify(defaultsNow)
  );
  const defaultsOnDisk = JSON.parse(fs.readFileSync(configs.CONFIG_FILE, 'utf8')).defaults;
  check(
    '请求级选择不改变全局默认（api-configs.json）',
    defaultsOnDisk.providerId === 'deepseek' && defaultsOnDisk.modelId === 'deepseek-flash',
    JSON.stringify(defaultsOnDisk)
  );

  // 无效模型：明确报错 + 零上游请求（不静默回退）
  builtinCalls.length = 0;
  mockState.requests.length = 0;
  const badModel = await req('/chat', {
    method: 'POST',
    body: {
      message: '无效模型',
      sessionId,
      providerId: 'deepseek',
      modelId: 'no-such-model',
    },
  });
  check(
    '请求级无效模型 → 500 not_configured',
    badModel.status === 500 && badModel.json && badModel.json.code === 'not_configured',
    JSON.stringify(badModel.json)
  );
  check(
    '请求级无效模型：零上游请求（不回退默认模型）',
    builtinCalls.length === 0 && mockState.requests.length === 0
  );

  // ================= B. 图片与视觉路由 =================
  ORIG_LOG('\nB. 图片与视觉路由');

  // 非视觉模型 + 图片 → 自动路由到同服务商视觉模型
  mockState.requests.length = 0;
  const autoRouted = await req('/chat', {
    method: 'POST',
    body: {
      message: '看图',
      sessionId,
      attachmentIds: [imageId],
      providerId: chatProvider.id,
      modelId: 'mock-text',
    },
  });
  const autoReq = upstreamChats().pop();
  const autoUserMsg = autoReq && autoReq.body.messages[autoReq.body.messages.length - 1];
  check(
    '带图 + 非视觉模型：自动路由到同服务商视觉模型 mock-vision',
    autoRouted.status === 200 && autoReq && autoReq.body.model === 'mock-vision',
    `status=${autoRouted.status} model=${autoReq && autoReq.body.model}`
  );
  check(
    '自动路由：图片以 image_url block 真实上行',
    autoUserMsg &&
      Array.isArray(autoUserMsg.content) &&
      autoUserMsg.content.some(b => b.type === 'image_url')
  );
  check(
    '自动路由：modelRoute.auto=true / reason=vision_unsupported / requested 保留所选模型',
    autoRouted.json &&
      autoRouted.json.modelRoute &&
      autoRouted.json.modelRoute.auto === true &&
      autoRouted.json.modelRoute.reason === 'vision_unsupported' &&
      autoRouted.json.modelRoute.requested.modelId === 'mock-text' &&
      autoRouted.json.modelRoute.actual.modelId === 'mock-vision',
    JSON.stringify(autoRouted.json && autoRouted.json.modelRoute)
  );
  check(
    '自动路由：actual 带 providerName（前端提示的数据来源）',
    autoRouted.json &&
      typeof autoRouted.json.modelRoute.actual.providerName === 'string' &&
      autoRouted.json.modelRoute.actual.providerName.length > 0,
    JSON.stringify(autoRouted.json && autoRouted.json.modelRoute.actual)
  );

  // 视觉模型 + 图片 → 直接使用，不标 auto
  mockState.requests.length = 0;
  const visionDirect = await req('/chat', {
    method: 'POST',
    body: {
      message: '看图',
      sessionId,
      attachmentIds: [imageId],
      providerId: chatProvider.id,
      modelId: 'mock-vision',
    },
  });
  check(
    '带图 + 视觉模型：直接使用所选模型，auto=false',
    visionDirect.status === 200 &&
      visionDirect.json &&
      visionDirect.json.modelRoute &&
      visionDirect.json.modelRoute.auto === false &&
      visionDirect.json.modelRoute.actual.modelId === 'mock-vision',
    JSON.stringify(visionDirect.json && visionDirect.json.modelRoute)
  );

  // 服务商无视觉模型 + 图片 → 明确报错，零上游请求
  mockState.requests.length = 0;
  builtinCalls.length = 0;
  const noVision = await req('/chat', {
    method: 'POST',
    body: {
      message: '看图',
      sessionId,
      attachmentIds: [imageId],
      providerId: textOnlyProvider.id,
      modelId: 'text-only',
    },
  });
  check(
    '视觉模型不可用：带图请求 → 400 capability（不伪装成功）',
    noVision.status === 400 && noVision.json && noVision.json.code === 'capability',
    JSON.stringify(noVision.json)
  );
  check(
    '视觉模型不可用：零上游请求',
    mockState.requests.length === 0 && builtinCalls.length === 0
  );

  // ================= C. 流式请求的路由信息 =================
  ORIG_LOG('\nC. 流式请求级选择与路由回报');

  builtinCalls.length = 0;
  const streamA = await readSse('/chat/stream', {
    message: '流式选 A',
    sessionId,
    providerId: 'deepseek',
    modelId: 'deepseek-chat',
  });
  const streamCallA = builtinCalls[builtinCalls.length - 1];
  const streamDoneA = streamA.events.find(e => e.type === 'done');
  check(
    '流式请求级选择：上游实际下发 deepseek-chat（覆盖全局默认 flash）',
    streamA.status === 200 && streamCallA && streamCallA.stream === true && streamCallA.model === 'deepseek-chat',
    `model=${streamCallA && streamCallA.model}`
  );
  check(
    '流式：先收到 delta，再收到 done',
    streamA.events.some(e => e.type === 'delta') &&
      !!streamDoneA &&
      streamA.events.indexOf(streamDoneA) === streamA.events.length - 1 &&
      !streamA.events.some(e => e.type === 'error'),
    JSON.stringify(streamA.events.map(e => e.type))
  );
  check(
    '流式 done：model/upstreamModel/modelRoute 指向同一实际模型',
    streamDoneA &&
      streamDoneA.model === 'deepseek-chat' &&
      streamDoneA.upstreamModel === 'deepseek-chat' &&
      streamDoneA.modelRoute &&
      streamDoneA.modelRoute.actual.modelId === 'deepseek-chat' &&
      streamDoneA.modelRoute.auto === false,
    JSON.stringify(streamDoneA && {
      model: streamDoneA.model,
      upstreamModel: streamDoneA.upstreamModel,
      route: streamDoneA.modelRoute,
    })
  );

  // 流式 + 带图 + 非视觉模型 → done 同样可追踪自动路由
  mockState.requests.length = 0;
  const streamAuto = await readSse('/chat/stream', {
    message: '流式看图',
    sessionId,
    attachmentIds: [imageId],
    providerId: chatProvider.id,
    modelId: 'mock-text',
  });
  const streamAutoReq = upstreamChats().pop();
  const streamAutoDone = streamAuto.events.find(e => e.type === 'done');
  check(
    '流式带图 + 非视觉：上游收到 mock-vision，done 标记 auto 与原因',
    streamAuto.status === 200 &&
      streamAutoReq &&
      streamAutoReq.body.model === 'mock-vision' &&
      streamAutoDone &&
      streamAutoDone.modelRoute &&
      streamAutoDone.modelRoute.auto === true &&
      streamAutoDone.modelRoute.reason === 'vision_unsupported',
    JSON.stringify({
      upstream: streamAutoReq && streamAutoReq.body.model,
      route: streamAutoDone && streamAutoDone.modelRoute,
    })
  );

  // ================= 收尾 =================
  ORIG_LOG(resultSummary());
  ORIG_LOG(`\n结果：${passed} 通过，${failed} 失败`);
  if (failed) {
    ORIG_LOG(`\n失败项：\n${failures.map(f => ` - ${f}`).join('\n')}`);
  }

  await closeServer(testServer);
  await closeServer(mockServer);
  fs.rmSync(TMP_ROOT, { recursive: true, force: true });

  process.exit(failed ? 1 : 0);
}

function resultSummary() {
  return failed ? '\n存在失败用例' : '\n全部用例通过';
}

main().catch(async error => {
  ORIG_ERR(error);
  await closeServer(testServer);
  await closeServer(mockServer);
  process.exit(1);
});
