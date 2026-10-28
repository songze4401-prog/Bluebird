/**
 * 云岫 Bluebird — 多服务商 / 多模型管理测试（model-providers.test.js）
 *
 * 独立脚本（非 node:test）：与 tests/multimodal.test.js 同款极简 runner。
 * 隔离保证：
 *   - 数据全部落在系统临时目录（BLUEBIRD_DATA_DIR），不碰 server/data；
 *   - 内置 DeepSeek 走 openai 桩（零网络）；自定义服务商走真实 SDK +
 *     本地 mock HTTP 服务商（127.0.0.1 动态端口，BLUEBIRD_ALLOW_PRIVATE_BASE_URL=1）；
 *   - 测试服务本身 PORT=0 动态端口。
 *
 * 覆盖（任务书 10 项要求 → 本文件分组）：
 *   A. 配置管理（列表/新增/编辑/删除/启停/默认）与密钥脱敏、泄密扫描
 *   B. 连接测试（ok/401/429/500/404/超时/超大响应体，模块级直测）
 *   C. 模型调用（非流式/流式/错误分类/未授权/输入校验）
 *   D. 模型切换与能力校验（vision 拒配/显式切换）
 *   E. 旧 DeepSeek 链路兼容（模型 ID/入参/带图/记忆/表情包候选回归）
 *   F. SSRF 防护（模块级直测 assertPublicUrl 全套）
 *   G. 持久化与重启（文件检查/重载/损坏保护/上限）
 *
 * 运行：node tests/model-providers.test.js
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
const TMP_ROOT = fs.mkdtempSync(path.join(os.tmpdir(), 'bluebird-mp-'));
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

const STUB_KEY = 'sk-stub-deepseek-0001';
const CUSTOM_KEY = 'sk-custom-secret-9876';

// ---- 测试图片素材（1x1 PNG） ----
const PNG_B64 =
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAADJRU5ErkJggg==';
const PNG_BUF = Buffer.from(PNG_B64, 'base64');

// ---- openai 桩：包装真实 SDK ----
// 内置 DeepSeek（baseURL=https://api.deepseek.com）→ 零网络桩回复；
// 其它 baseURL → 转真实 SDK（打本地 mock 服务商）。
const RealOpenAI = require('openai');
const openaiTarget = require.resolve('openai', { paths: [SERVER] });

const builtinCalls = [];
const builtinConfigs = [];
let builtinReply = '[calm] 这是回复正文。';
let builtinError = null; // { status, name, code, message }

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
              builtinCalls.push(args);
              if (builtinError) {
                const err = new Error(builtinError.message);
                err.status = builtinError.status;
                err.name = builtinError.name;
                if (builtinError.code) err.code = builtinError.code;
                throw err;
              }
              if (args && args.stream) {
                return (async function* () {
                  yield {
                    model: args.model,
                    choices: [{ index: 0, delta: { content: builtinReply } }],
                  };
                })();
              }
              return {
                model: args.model,
                choices: [{ index: 0, message: { role: 'assistant', content: builtinReply } }],
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

// ---- memory / emotion 桩（与 multimodal.test.js 同模式） ----
const memoryCalls = [];

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
  buildMemoryContext: () => '【记忆】MEMORY-CTX',
  processMemory: async (client, text, sessionId) => {
    memoryCalls.push({ text, sessionId });
    return null;
  },
  clearMemories: () => {},
  recallMemoryBySourceQuote: async () => ({}),

  clearSessionMemories: async () => ({ removedEntries: 0, removedContributions: 0, remaining: 0, reason: "no-match" }),

  verifyStoreConsistency: () => ({ consistent: true, entries: 0, reason: "ok" }),

  getWriteOutcomes: () => [],
  getMemories: () => [],
  deleteMemory: () => false,
});

stubModule('emotion.js', {
  // stream-strip.js 依赖 EMOTIONS 构造标签正则，桩必须提供（与真实列表一致）
  EMOTIONS: ['calm', 'happy', 'playful', 'excited', 'tired', 'sad', 'annoyed', 'hurt'],
  getEmotion: () => ({ emotion: 'calm', intensity: 0.3 }),
  buildEmotionContext: () => '【情绪】EMOTION-CTX',
  applyTimeDecay: () => {},
  // completeChatTurn 会读 applyObservation 返回值的 emotion/intensity，桩必须返回状态对象
  applyObservation: () => ({ emotion: 'calm', intensity: 0.3 }),
  loadEmotion: () => ({ emotion: 'calm', intensity: 0.3 }),
});

// ---- 本地 mock 服务商（OpenAI Chat Completions 兼容） ----
const mockState = {
  modelsStatus: 200,
  modelsDelayMs: 0,
  modelsExtraBytes: 0,
  chatStatus: 200,
  requests: [],
};

const mockServer = http.createServer((req, res) => {
  // 连接测试会主动 destroy 请求（超时 / 超体），之后的写入必须容错
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
    mockState.requests.push({
      method: req.method,
      url: req.url,
      auth: req.headers.authorization || '',
      body: parsed,
    });

    const respond = () => {
      if (req.url.startsWith('/models')) {
        if (mockState.modelsStatus !== 200) {
          res.writeHead(mockState.modelsStatus, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: { message: 'mock models error' } }));
          return;
        }
        let payload = JSON.stringify({
          object: 'list',
          data: [{ id: 'mock-model', object: 'model' }],
        });
        if (mockState.modelsExtraBytes > 0) {
          payload += 'x'.repeat(mockState.modelsExtraBytes);
        }
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(payload);
        return;
      }

      if (req.url.startsWith('/chat/completions')) {
        if (mockState.chatStatus !== 200) {
          res.writeHead(mockState.chatStatus, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: { message: 'mock chat error' } }));
          return;
        }
        if (parsed && parsed.stream) {
          res.writeHead(200, { 'Content-Type': 'text/event-stream; charset=utf-8' });
          const chunk1 = {
            id: 'chatcmpl-mock',
            object: 'chat.completion.chunk',
            model: parsed.model || 'mock-model',
            choices: [{ index: 0, delta: { role: 'assistant', content: '[happy] ' } }],
          };
          const chunk2 = {
            id: 'chatcmpl-mock',
            object: 'chat.completion.chunk',
            model: parsed.model || 'mock-model',
            choices: [{ index: 0, delta: { content: 'mock 流式回复' } }],
          };
          res.write(`data: ${JSON.stringify(chunk1)}\n\n`);
          res.write(`data: ${JSON.stringify(chunk2)}\n\n`);
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
              { index: 0, message: { role: 'assistant', content: '[happy] mock 回复' } },
            ],
          })
        );
        return;
      }

      res.writeHead(404, { 'Content-Type': 'application/json' });
      res.end('{}');
    };

    if (mockState.modelsDelayMs > 0 && req.url.startsWith('/models')) {
      setTimeout(respond, mockState.modelsDelayMs);
    } else {
      respond();
    }
  });
});

// ---- 启动被测服务 ----
// 注意：listening 是 nextTick 级的异步事件，必须在任何 await 之前
// 同步挂上监听，否则事件先于监听器触发，永远等不到（挂起）。
const { server: testServer } = require(path.join(SERVER, 'index.js'));
const serverReady = testServer.listening
  ? Promise.resolve()
  : new Promise(resolve => testServer.once('listening', resolve));

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

  let json = null;
  const text = await res.text();
  try {
    json = JSON.parse(text);
  } catch (_) {
    /* 非 JSON（SSE 等） */
  }
  return { status: res.status, json, text };
}

// SSE 读取：按 data: 行解析事件
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

let PORT = 0;

// 模块直载（不起 HTTP）：api-configs / model-adapter / uploads
function loadModule(name) {
  return require(path.join(SERVER, name));
}

function reloadConfigModules() {
  for (const name of ['api-configs.js', 'model-adapter.js']) {
    const target = require.resolve(path.join(SERVER, name));
    delete require.cache[target];
  }
  return {
    configs: loadModule('api-configs.js'),
    adapter: loadModule('model-adapter.js'),
  };
}

function containsSecret(text) {
  return (
    String(text).includes(STUB_KEY) ||
    String(text).includes(CUSTOM_KEY)
  );
}

async function main() {
  // mock 服务商与测试服务都监听动态端口
  await new Promise(resolve => mockServer.listen(0, '127.0.0.1', resolve));
  const MOCK_PORT = mockServer.address().port;
  const MOCK_BASE = `http://127.0.0.1:${MOCK_PORT}`;

  await serverReady;
  PORT = testServer.address().port;
  ORIG_LOG(`测试服务端口=${PORT} mock 服务商端口=${MOCK_PORT}`);

  const uploads = loadModule('uploads.js');
  const stickerRepo = loadModule('sticker-repo.js');
  const configs = loadModule('api-configs.js');
  const adapter = loadModule('model-adapter.js');

  // 预置一张图片（模块级，不耗 HTTP 配额），供带图请求使用
  const imageId = uploads.saveImage({
    dataUrl: `data:image/png;base64,${PNG_BUF.toString('base64')}`,
    kind: 'image',
    name: 'test.png',
  }).id;

  // ================= A. 配置管理与脱敏 =================
  ORIG_LOG('\nA. 配置管理（列表 / 新增 / 编辑 / 删除 / 启停 / 默认）');

  const initial = await req('/model-providers');
  check('GET /model-providers 返回 200', initial.status === 200);
  check(
    '初始列表含内置 DeepSeek（builtin/keyConfigured）',
    initial.json &&
      initial.json.providers[0] &&
      initial.json.providers[0].id === 'deepseek' &&
      initial.json.providers[0].builtin === true &&
      initial.json.providers[0].keyConfigured === true
  );
  check(
    '初始默认值 = 内置 DeepSeek + deepseek-chat（升级后零配置）',
    initial.json &&
      initial.json.defaults.providerId === 'deepseek' &&
      initial.json.defaults.modelId === 'deepseek-chat'
  );
  check(
    '初始模型的 vision 能力如实声明（chat 否 / flash 是）',
    initial.json &&
      initial.json.providers[0].models.find(m => m.id === 'deepseek-chat').capabilities.vision === false &&
      initial.json.providers[0].models.find(m => m.id === 'deepseek-flash').capabilities.vision === true
  );
  check(
    '列表响应不含完整 API Key（泄密扫描）',
    !containsSecret(JSON.stringify(initial.json))
  );
  check(
    'keyHint 为脱敏形式',
    initial.json && initial.json.providers[0].keyHint === 'sk-...0001',
    JSON.stringify(initial.json.providers[0].keyHint)
  );

  // 新增成功
  const created = await req('/model-providers', {
    method: 'POST',
    body: {
      name: 'Mock 服务商',
      baseUrl: MOCK_BASE,
      apiKey: CUSTOM_KEY,
      models: [
        { id: 'mock-model', name: 'Mock 文本模型' },
        { id: 'mock-vision', name: 'Mock 视觉模型', capabilities: { vision: true } },
      ],
    },
  });
  check('POST /model-providers 新增成功返回 201', created.status === 201, `status=${created.status}`);
  check(
    '新增响应脱敏（keyConfigured + keyHint，无完整 Key）',
    created.json &&
      created.json.provider.keyConfigured === true &&
      created.json.provider.keyHint === 'sk-...9876' &&
      !containsSecret(JSON.stringify(created.json))
  );
  const customId = created.json && created.json.provider.id;
  check('新增服务商获得 id', typeof customId === 'string' && customId.length > 0);

  // 输入校验
  const noKey = await req('/model-providers', {
    method: 'POST',
    body: { name: 'x', baseUrl: 'https://api.example.com', models: [{ id: 'm' }] },
  });
  check('新增缺 apiKey 返回 400', noKey.status === 400, `status=${noKey.status}`);

  const badModelId = await req('/model-providers', {
    method: 'POST',
    body: {
      name: 'x',
      baseUrl: 'https://api.example.com',
      apiKey: 'k',
      models: [{ id: 'bad model id!' }],
    },
  });
  check('模型 id 含非法字符返回 400', badModelId.status === 400, `status=${badModelId.status}`);

  const dupModel = await req('/model-providers', {
    method: 'POST',
    body: {
      name: 'x',
      baseUrl: 'https://api.example.com',
      apiKey: 'k',
      models: [{ id: 'm' }, { id: 'm' }],
    },
  });
  check('模型 id 重复返回 400', dupModel.status === 400, `status=${dupModel.status}`);

  // SSRF（HTTP 层）：临时关闭测试旁路，验证路由层的真实拦截行为
  // （旁路是运行时读取的，进程内切换即时生效）
  const savedBypass = process.env.BLUEBIRD_ALLOW_PRIVATE_BASE_URL;
  process.env.BLUEBIRD_ALLOW_PRIVATE_BASE_URL = '';
  const ssrf = await req('/model-providers', {
    method: 'POST',
    body: {
      name: 'evil',
      baseUrl: 'http://169.254.169.254/latest/meta-data',
      apiKey: 'k',
      models: [{ id: 'm' }],
    },
  });
  process.env.BLUEBIRD_ALLOW_PRIVATE_BASE_URL = savedBypass;
  check(
    '云元数据地址被 SSRF 拦截（400）',
    ssrf.status === 400 && ssrf.json && ssrf.json.code === 'bad_request',
    JSON.stringify(ssrf.json)
  );

  // 编辑：不传 key 不覆盖
  const beforeEdit = await req(`/model-providers/${customId}`);
  const patched = await req(`/model-providers/${customId}`, {
    method: 'PATCH',
    body: { name: 'Mock 服务商（改）' },
  });
  check(
    'PATCH 改 name 成功且保留原密钥（keyHint 不变）',
    patched.status === 200 &&
      patched.json.provider.name === 'Mock 服务商（改）' &&
      patched.json.provider.keyHint === beforeEdit.json.provider.keyHint &&
      patched.json.provider.keyConfigured === true
  );

  // 编辑：传新 key 才覆盖
  const rekeyed = await req(`/model-providers/${customId}`, {
    method: 'PATCH',
    body: { apiKey: 'sk-custom-rotated-0002' },
  });
  check(
    'PATCH 传新 apiKey 才覆盖（keyHint 变化）',
    rekeyed.status === 200 &&
      rekeyed.json.provider.keyHint === 'sk-...0002' &&
      !containsSecret(JSON.stringify(rekeyed.json))
  );

  // 空串 apiKey = 用户没提交新 Key（表单清空提交的典型场景）：
  // 必须保留原有密钥，绝不被空值覆盖（任务书硬性要求）
  const emptyKey = await req(`/model-providers/${customId}`, {
    method: 'PATCH',
    body: { apiKey: '' },
  });
  check(
    'PATCH 空串 apiKey 不覆盖已有密钥',
    emptyKey.status === 200 &&
      emptyKey.json.provider.keyConfigured === true &&
      emptyKey.json.provider.keyHint === 'sk-...0002',
    JSON.stringify(emptyKey.json.provider)
  );

  const patchBuiltin = await req('/model-providers/deepseek', {
    method: 'PATCH',
    body: { name: 'hack' },
  });
  check('PATCH 内置服务商返回 400', patchBuiltin.status === 400, `status=${patchBuiltin.status}`);

  // 删除：内置拒删
  const delBuiltin = await req('/model-providers/deepseek', { method: 'DELETE' });
  check('DELETE 内置服务商返回 400', delBuiltin.status === 400, `status=${delBuiltin.status}`);

  // 启用 / 禁用
  const disabled = await req(`/model-providers/${customId}/enabled`, {
    method: 'POST',
    body: { enabled: false },
  });
  check('POST enabled=false 成功', disabled.status === 200 && disabled.json.provider.enabled === false);

  const badEnabled = await req(`/model-providers/${customId}/enabled`, {
    method: 'POST',
    body: { enabled: 'yes' },
  });
  check('enabled 非布尔返回 400', badEnabled.status === 400, `status=${badEnabled.status}`);

  const reEnabled = await req(`/model-providers/${customId}/enabled`, {
    method: 'POST',
    body: { enabled: true },
  });
  check('POST enabled=true 恢复', reEnabled.status === 200 && reEnabled.json.provider.enabled === true);

  // 默认模型切换
  const setDefault = await req('/model-providers/default', {
    method: 'PUT',
    body: { providerId: customId, modelId: 'mock-model' },
  });
  check(
    'PUT default 切换到自定义服务商成功',
    setDefault.status === 200 &&
      setDefault.json.defaults.providerId === customId &&
      setDefault.json.defaults.modelId === 'mock-model'
  );

  const badDefault = await req('/model-providers/default', {
    method: 'PUT',
    body: { providerId: customId, modelId: 'not-exist' },
  });
  check('PUT default 不存在的模型返回 400', badDefault.status === 400, `status=${badDefault.status}`);

  const delDefault = await req(`/model-providers/${customId}`, { method: 'DELETE' });
  check('DELETE 当前默认服务商返回 400', delDefault.status === 400, `status=${delDefault.status}`);

  // 恢复默认为内置（不影响后续旧链路断言）
  await req('/model-providers/default', {
    method: 'PUT',
    body: { providerId: 'deepseek', modelId: 'deepseek-chat' },
  });

  // ================= B. 连接测试（模块级直测，零 HTTP 配额） =================
  ORIG_LOG('\nB. 连接测试（本地 mock 服务商）');

  // 先建一个专用连接测试服务商（模块级，不耗配额）
  const testProvider = configs.addModelProvider({
    name: '连接测试',
    baseUrl: MOCK_BASE,
    apiKey: CUSTOM_KEY,
    models: [{ id: 'mock-model' }],
  }).provider;

  mockState.modelsStatus = 200;
  mockState.modelsExtraBytes = 0;
  const okTest = await adapter.testProviderConnection(testProvider.id);
  check('连接测试：200 → ok:true', okTest.ok === true && okTest.code === 'ok', JSON.stringify(okTest));

  mockState.modelsStatus = 401;
  const authTest = await adapter.testProviderConnection(testProvider.id);
  check(
    '连接测试：401 → code auth',
    authTest.ok === false && authTest.code === 'auth' && authTest.httpStatus === 401
  );

  mockState.modelsStatus = 429;
  const rateTest = await adapter.testProviderConnection(testProvider.id);
  check('连接测试：429 → code rate_limit', rateTest.ok === false && rateTest.code === 'rate_limit');

  mockState.modelsStatus = 500;
  const serverTest = await adapter.testProviderConnection(testProvider.id);
  check('连接测试：500 → code server', serverTest.ok === false && serverTest.code === 'server');

  mockState.modelsStatus = 404;
  const missTest = await adapter.testProviderConnection(testProvider.id);
  check(
    '连接测试：404 → code endpoint_missing',
    missTest.ok === false && missTest.code === 'endpoint_missing'
  );

  mockState.modelsStatus = 200;
  mockState.modelsExtraBytes = 128 * 1024;
  const bigTest = await adapter.testProviderConnection(testProvider.id);
  check(
    '连接测试：响应体超 64KB → response_too_large',
    bigTest.ok === false && bigTest.code === 'response_too_large',
    JSON.stringify(bigTest)
  );
  mockState.modelsExtraBytes = 0;

  mockState.modelsDelayMs = 6000;
  const slowTest = await adapter.testProviderConnection(testProvider.id);
  check('连接测试：5s 超时 → code timeout', slowTest.ok === false && slowTest.code === 'timeout');
  mockState.modelsDelayMs = 0;

  const leakTest = JSON.stringify(okTest) + JSON.stringify(authTest);
  check('连接测试响应不含 API Key', !containsSecret(leakTest));

  configs.deleteModelProvider(testProvider.id);

  // ================= C. 模型调用（真实 SDK + mock 服务商） =================
  ORIG_LOG('\nC. 模型调用（非流式 / 流式 / 错误分类 / 鉴权）');

  // 建一个聊天用服务商（模块级）
  const chatProvider = configs.addModelProvider({
    name: 'Mock 聊天',
    baseUrl: MOCK_BASE,
    apiKey: CUSTOM_KEY,
    models: [
      { id: 'mock-model' },
      { id: 'mock-vision', capabilities: { vision: true } },
    ],
  }).provider;

  const needSession = await req('/sessions', { method: 'POST', body: {} });
  const sessionId = needSession.json && needSession.json.session && needSession.json.session.id;

  mockState.requests.length = 0;
  mockState.chatStatus = 200;
  const chatOk = await req('/chat', {
    method: 'POST',
    body: { message: '你好', sessionId, providerId: chatProvider.id, modelId: 'mock-model' },
  });
  check(
    '/chat 走自定义服务商成功',
    chatOk.status === 200 && chatOk.json && chatOk.json.reply.includes('mock 回复'),
    JSON.stringify(chatOk.json).slice(0, 200)
  );
  const lastChatReq = mockState.requests.filter(r => r.url.startsWith('/chat/completions')).pop();
  check(
    '自定义服务商收到正确入参（model/Bearer/温度/上限）',
    lastChatReq &&
      lastChatReq.body.model === 'mock-model' &&
      lastChatReq.auth === `Bearer ${CUSTOM_KEY}` &&
      lastChatReq.body.temperature === 0.8 &&
      lastChatReq.body.max_tokens === 1200,
    JSON.stringify(lastChatReq && lastChatReq.body).slice(0, 200)
  );
  check(
    '/chat 响应不含 API Key（泄密扫描）',
    !containsSecret(JSON.stringify(chatOk.json))
  );

  // 未授权
  const noAuth = await req('/chat', {
    method: 'POST',
    token: null,
    body: { message: 'hi', sessionId },
  });
  check('/chat 无 token 返回 401', noAuth.status === 401, `status=${noAuth.status}`);

  const noAuthList = await req('/model-providers', { token: null });
  check('GET /model-providers 无 token 返回 401', noAuthList.status === 401);

  // 流式
  mockState.requests.length = 0;
  const streamRes = await readSse('/chat/stream', {
    message: '流式测试',
    sessionId,
    providerId: chatProvider.id,
    modelId: 'mock-model',
  });
  const streamReq = mockState.requests.filter(r => r.url.startsWith('/chat/completions')).pop();
  const deltaEvents = streamRes.events.filter(e => e.type === 'delta');
  const doneEvent = streamRes.events.find(e => e.type === 'done');
  check(
    '/chat/stream 收到 delta 与 done 事件',
    deltaEvents.length >= 1 && doneEvent && doneEvent.reply.includes('mock 流式回复'),
    JSON.stringify(streamRes.events).slice(0, 200)
  );
  check(
    '流式请求带 stream:true 且模型正确',
    streamReq && streamReq.body.stream === true && streamReq.body.model === 'mock-model'
  );
  check('情绪标签被流式剥离（[happy] 不出现在 delta）', deltaEvents.every(e => !e.content.includes('[happy]')));

  // 错误分类（mock 返回各状态码 → 适配层归一化）
  const errorCases = [
    { status: 401, expectHttp: 502, expectCode: 'auth' },
    { status: 429, expectHttp: 429, expectCode: 'rate_limit' },
    { status: 400, expectHttp: 400, expectCode: 'bad_request' },
    { status: 500, expectHttp: 502, expectCode: 'server' },
    { status: 404, expectHttp: 502, expectCode: 'model' },
  ];
  for (const c of errorCases) {
    mockState.chatStatus = c.status;
    const errRes = await req('/chat', {
      method: 'POST',
      body: { message: '错误分类', sessionId, providerId: chatProvider.id, modelId: 'mock-model' },
    });
    check(
      `服务商 ${c.status} → HTTP ${c.expectHttp} + code ${c.expectCode}`,
      errRes.status === c.expectHttp && errRes.json && errRes.json.code === c.expectCode,
      JSON.stringify(errRes.json).slice(0, 150)
    );
    check(
      `错误响应不含 API Key（${c.status}）`,
      !containsSecret(JSON.stringify(errRes.json))
    );
  }
  mockState.chatStatus = 200;

  // 流式错误路径
  mockState.chatStatus = 500;
  const streamErr = await readSse('/chat/stream', {
    message: '流式错误',
    sessionId,
    providerId: chatProvider.id,
    modelId: 'mock-model',
  });
  const errEvent = streamErr.events.find(e => e.type === 'error');
  check(
    '流式错误发 error 事件（带 code，无 done）',
    errEvent && errEvent.code === 'server' && !streamErr.events.some(e => e.type === 'done'),
    JSON.stringify(streamErr.events).slice(0, 200)
  );
  mockState.chatStatus = 200;

  // ================= D. 模型切换与能力校验 =================
  ORIG_LOG('\nD. 模型切换与能力校验');

  // 带图 + 非 vision 模型 → 能力路由到同服务商的视觉模型，并如实回报
  mockState.requests.length = 0;
  const visionRoute = await req('/chat', {
    method: 'POST',
    body: {
      message: '看图',
      sessionId,
      attachmentIds: [imageId],
      providerId: chatProvider.id,
      modelId: 'mock-model',
    },
  });
  const visionRouteReq = mockState.requests
    .filter(r => r.url.startsWith('/chat/completions'))
    .pop();
  check(
    '带图请求指定非视觉模型 → 自动路由到同服务商视觉模型',
    visionRoute.status === 200 &&
      visionRouteReq &&
      visionRouteReq.body.model === 'mock-vision',
    `status=${visionRoute.status} model=${visionRouteReq && visionRouteReq.body.model}`
  );
  check(
    '带图请求指定非视觉模型 → 响应如实标注自动路由',
    visionRoute.json &&
      visionRoute.json.modelRoute &&
      visionRoute.json.modelRoute.auto === true &&
      visionRoute.json.modelRoute.reason === 'vision_unsupported' &&
      visionRoute.json.modelRoute.requested.modelId === 'mock-model' &&
      visionRoute.json.modelRoute.actual.modelId === 'mock-vision',
    JSON.stringify(visionRoute.json && visionRoute.json.modelRoute)
  );

  // 带图 + vision 模型 → 成功，且图片以 image_url block 上行
  mockState.requests.length = 0;
  const visionOk = await req('/chat', {
    method: 'POST',
    body: {
      message: '看图',
      sessionId,
      attachmentIds: [imageId],
      providerId: chatProvider.id,
      modelId: 'mock-vision',
    },
  });
  const visionReq = mockState.requests.filter(r => r.url.startsWith('/chat/completions')).pop();
  const userMsg = visionReq && visionReq.body.messages[visionReq.body.messages.length - 1];
  check(
    '带图 + 视觉模型成功，图片以 blocks 上行',
    visionOk.status === 200 &&
      userMsg &&
      Array.isArray(userMsg.content) &&
      userMsg.content.some(b => b.type === 'image_url'),
    JSON.stringify(userMsg).slice(0, 150)
  );

  // 指定不存在服务商 / 模型
  const badProvider = await req('/chat', {
    method: 'POST',
    body: { message: 'x', sessionId, providerId: 'no-such' },
  });
  check(
    '指定不存在服务商 → 结构化错误（code not_configured）',
    badProvider.status === 500 && badProvider.json && badProvider.json.code === 'not_configured',
    JSON.stringify(badProvider.json)
  );

  // 禁用的服务商被指定
  await req(`/model-providers/${chatProvider.id}/enabled`, {
    method: 'POST',
    body: { enabled: false },
  });
  const disabledCall = await req('/chat', {
    method: 'POST',
    body: { message: 'x', sessionId, providerId: chatProvider.id, modelId: 'mock-model' },
  });
  check(
    '指定已禁用服务商 → 结构化错误',
    disabledCall.status === 500 && disabledCall.json && disabledCall.json.code === 'not_configured'
  );
  await req(`/model-providers/${chatProvider.id}/enabled`, {
    method: 'POST',
    body: { enabled: true },
  });

  // ================= D2. 设置里切换默认模型 → 请求实际使用所选模型 =================
  ORIG_LOG('\nD2. 设置里切换默认模型 → 请求实际使用所选模型');

  // 用户视角的完整链路：PUT 默认模型（等同于设置页点击）→ 发消息（不带
  // provider/model）→ 上游实际收到的 model。之前的实现会在会话历史含图片时
  // 悄悄换成视觉模型，这里逐条盯住"实际调用的模型"。
  const switchSessionRes = await req('/sessions', { method: 'POST', body: {} });
  const switchSessionId = switchSessionRes.json.session.id;

  const setCustomDefault = await req('/model-providers/default', {
    method: 'PUT',
    body: { providerId: chatProvider.id, modelId: 'mock-model' },
  });
  check(
    '设置切换：PUT /model-providers/default 保存自定义模型',
    setCustomDefault.status === 200 &&
      setCustomDefault.json.defaults.modelId === 'mock-model',
    JSON.stringify(setCustomDefault.json)
  );

  // 重新打开设置页 = 前端重新 GET /model-providers；默认值应来自落盘配置
  const reopenList = await req('/model-providers');
  check(
    '重新打开设置：默认模型与所选一致',
    reopenList.status === 200 &&
      reopenList.json.defaults.providerId === chatProvider.id &&
      reopenList.json.defaults.modelId === 'mock-model',
    JSON.stringify(reopenList.json.defaults)
  );
  const configOnDisk = JSON.parse(fs.readFileSync(configs.CONFIG_FILE, 'utf8'));
  check(
    '重新打开设置：选择已写入 api-configs.json（重启后仍生效）',
    configOnDisk.defaults &&
      configOnDisk.defaults.providerId === chatProvider.id &&
      configOnDisk.defaults.modelId === 'mock-model',
    JSON.stringify(configOnDisk.defaults)
  );

  mockState.requests.length = 0;
  const chatAfterCustomDefault = await req('/chat', {
    method: 'POST',
    body: { message: '切换后第一条', sessionId: switchSessionId },
  });
  const afterCustomDefaultReq = mockState.requests
    .filter(r => r.url.startsWith('/chat/completions'))
    .pop();
  check(
    '设置切换：聊天请求实际使用所选模型 mock-model',
    chatAfterCustomDefault.status === 200 &&
      afterCustomDefaultReq &&
      afterCustomDefaultReq.body.model === 'mock-model',
    `model=${afterCustomDefaultReq && afterCustomDefaultReq.body.model}`
  );
  check(
    '设置切换：响应里的 model 是供应商实际回显（mock-model）',
    chatAfterCustomDefault.json && chatAfterCustomDefault.json.model === 'mock-model',
    `res.model=${chatAfterCustomDefault.json && chatAfterCustomDefault.json.model}`
  );
  check(
    '设置切换：响应同时区分 model（所选/实发）与 upstreamModel（供应商回显）',
    chatAfterCustomDefault.json &&
      chatAfterCustomDefault.json.model === 'mock-model' &&
      chatAfterCustomDefault.json.upstreamModel === 'mock-model',
    JSON.stringify({
      model: chatAfterCustomDefault.json && chatAfterCustomDefault.json.model,
      upstreamModel: chatAfterCustomDefault.json && chatAfterCustomDefault.json.upstreamModel,
    })
  );

  // 切到同一服务商的另一个模型
  await req('/model-providers/default', {
    method: 'PUT',
    body: { providerId: chatProvider.id, modelId: 'mock-vision' },
  });
  mockState.requests.length = 0;
  await req('/chat', {
    method: 'POST',
    body: { message: '再切一次', sessionId: switchSessionId },
  });
  const afterSecondSwitchReq = mockState.requests
    .filter(r => r.url.startsWith('/chat/completions'))
    .pop();
  check(
    '设置切换：再次切换后实际使用 mock-vision',
    afterSecondSwitchReq && afterSecondSwitchReq.body.model === 'mock-vision',
    `model=${afterSecondSwitchReq && afterSecondSwitchReq.body.model}`
  );

  // 内置 DeepSeek 两个模型互切：用 builtinCalls 记录的真实 SDK 入参验证
  const builtinSessionA = (await req('/sessions', { method: 'POST', body: {} })).json.session.id;
  await req('/model-providers/default', {
    method: 'PUT',
    body: { providerId: 'deepseek', modelId: 'deepseek-chat' },
  });
  builtinCalls.length = 0;
  const chatModelA = await req('/chat', {
    method: 'POST',
    body: { message: 'A', sessionId: builtinSessionA },
  });
  check(
    '设置切换：选 A（deepseek-chat）→ 实际请求 A',
    builtinCalls[builtinCalls.length - 1] &&
      builtinCalls[builtinCalls.length - 1].model === 'deepseek-chat',
    `model=${builtinCalls[builtinCalls.length - 1] && builtinCalls[builtinCalls.length - 1].model}`
  );
  check(
    '设置切换：A 的响应 model 回显 deepseek-chat',
    chatModelA.json && chatModelA.json.model === 'deepseek-chat',
    `res.model=${chatModelA.json && chatModelA.json.model}`
  );

  const builtinSessionB = (await req('/sessions', { method: 'POST', body: {} })).json.session.id;
  await req('/model-providers/default', {
    method: 'PUT',
    body: { providerId: 'deepseek', modelId: 'deepseek-flash' },
  });
  builtinCalls.length = 0;
  await req('/chat', { method: 'POST', body: { message: 'B', sessionId: builtinSessionB } });
  check(
    '设置切换：切到 B（deepseek-flash）→ 实际请求 B',
    builtinCalls[builtinCalls.length - 1] &&
      builtinCalls[builtinCalls.length - 1].model === 'deepseek-flash',
    `model=${builtinCalls[builtinCalls.length - 1] && builtinCalls[builtinCalls.length - 1].model}`
  );

  // 会话历史含图片：纯文本请求仍用所选模型，历史图片降级成文本
  // （旧实现在这里会换成 deepseek-flash，是"切了模型却不生效"的主因）
  await req('/model-providers/default', {
    method: 'PUT',
    body: { providerId: 'deepseek', modelId: 'deepseek-chat' },
  });
  builtinCalls.length = 0;
  await req('/chat', {
    method: 'POST',
    body: { message: '历史里有图的会话', sessionId },
  });
  const historyCall = builtinCalls[builtinCalls.length - 1];
  check(
    '历史含图片时纯文本仍用所选模型 deepseek-chat',
    historyCall && historyCall.model === 'deepseek-chat',
    `model=${historyCall && historyCall.model}`
  );
  check(
    '历史图片降级为文本（不带 image_url block）',
    historyCall &&
      !historyCall.messages.some(
        m => Array.isArray(m.content) && m.content.some(b => b.type === 'image_url')
      )
  );

  // 无效模型 ID：明确报错，且不静默回退到默认模型（上游零请求）
  mockState.requests.length = 0;
  builtinCalls.length = 0;
  const badModel = await req('/chat', {
    method: 'POST',
    body: {
      message: '无效模型',
      sessionId: switchSessionId,
      providerId: 'deepseek',
      modelId: 'no-such-model',
    },
  });
  check(
    '无效模型 ID → 结构化错误（not_configured）',
    badModel.status === 500 &&
      badModel.json &&
      badModel.json.code === 'not_configured',
    JSON.stringify(badModel.json)
  );
  check(
    '无效模型 ID 不静默回退（未发起任何上游请求）',
    mockState.requests.length === 0 && builtinCalls.length === 0
  );

  // 流式路径：同样按所选模型下发，done 里区分 model 与 upstreamModel
  await req('/model-providers/default', {
    method: 'PUT',
    body: { providerId: chatProvider.id, modelId: 'mock-model' },
  });
  mockState.requests.length = 0;
  const switchStream = await readSse('/chat/stream', {
    message: '流式切换',
    sessionId: switchSessionId,
  });
  const switchStreamReq = mockState.requests
    .filter(r => r.url.startsWith('/chat/completions'))
    .pop();
  const switchDone = switchStream.events.find(e => e.type === 'done');
  check(
    '设置切换：流式请求不带 ids 时也使用所选模型 mock-model',
    switchStreamReq && switchStreamReq.body.model === 'mock-model',
    `model=${switchStreamReq && switchStreamReq.body.model}`
  );
  check(
    '设置切换：流式 done 同时给出 model 与 upstreamModel',
    switchDone &&
      switchDone.model === 'mock-model' &&
      switchDone.upstreamModel === 'mock-model',
    JSON.stringify({ model: switchDone && switchDone.model, upstreamModel: switchDone && switchDone.upstreamModel })
  );

  // 恢复默认，避免影响后续分组（E 组按内置 DeepSeek 断言）
  await req('/model-providers/default', {
    method: 'PUT',
    body: { providerId: 'deepseek', modelId: 'deepseek-chat' },
  });

  // ================= E. 旧 DeepSeek 链路兼容 =================
  ORIG_LOG('\nE. 旧 DeepSeek 链路兼容（内置服务商零网络桩）');

  // 用全新会话：D 组会话历史里已有图片，排除干扰更直观
  const legacySessionRes = await req('/sessions', { method: 'POST', body: {} });
  const legacySessionId =
    legacySessionRes.json && legacySessionRes.json.session.id;

  builtinCalls.length = 0;
  const legacyChat = await req('/chat', {
    method: 'POST',
    body: { message: '旧链路测试', sessionId: legacySessionId },
  });
  check('/chat 默认（内置 DeepSeek）成功', legacyChat.status === 200);
  const legacyCall = builtinCalls[builtinCalls.length - 1];
  check(
    '内置调用入参与改造前一致（deepseek-chat / 0.8 / 1200 / 结构）',
    legacyCall &&
      legacyCall.model === 'deepseek-chat' &&
      legacyCall.temperature === 0.8 &&
      legacyCall.max_tokens === 1200 &&
      legacyCall.messages[0].role === 'system' &&
      legacyCall.messages[legacyCall.messages.length - 1].role === 'user',
    JSON.stringify(legacyCall && legacyCall.model)
  );
  check(
    'system prompt 仍含时间/记忆/情绪/人格注入（链路未断）',
    legacyCall &&
      legacyCall.messages[0].content.includes('【当前时间】') &&
      legacyCall.messages[0].content.includes('MEMORY-CTX') &&
      legacyCall.messages[0].content.includes('EMOTION-CTX'),
    legacyCall && legacyCall.messages[0].content.slice(0, 120)
  );
  check(
    '内置 client 的 baseURL 指向 api.deepseek.com',
    builtinConfigs.length > 0 &&
      builtinConfigs[builtinConfigs.length - 1].baseURL === 'https://api.deepseek.com'
  );
  check(
    '内置 client 使用环境变量密钥',
    builtinConfigs.length > 0 &&
      builtinConfigs[builtinConfigs.length - 1].apiKey === STUB_KEY
  );

  // 带图 → deepseek-flash
  builtinCalls.length = 0;
  const legacyVision = await req('/chat', {
    method: 'POST',
    body: { message: '旧链路带图', sessionId: legacySessionId, attachmentIds: [imageId] },
  });
  const legacyVisionCall = builtinCalls[builtinCalls.length - 1];
  const legacyUserMsg =
    legacyVisionCall &&
    legacyVisionCall.messages[legacyVisionCall.messages.length - 1];
  check(
    '带图请求仍走 deepseek-flash 且图片以 blocks 上行',
    legacyVision.status === 200 &&
      legacyVisionCall.model === 'deepseek-flash' &&
      Array.isArray(legacyUserMsg.content) &&
      legacyUserMsg.content.some(b => b.type === 'image_url')
  );

  // 记忆提取仍走内置 client（processMemory 桩收到调用）
  memoryCalls.length = 0;
  await req('/chat', { method: 'POST', body: { message: '记住我喜欢咖啡', sessionId: legacySessionId } });
  await new Promise(r => setTimeout(r, 50));
  check('记忆提取链路仍触发（异步）', memoryCalls.length >= 1);

  // 表情包候选注入回归（仓库非空时 system 含候选列表）
  stickerRepo.addSticker({
    dataUrl: `data:image/png;base64,${PNG_BUF.toString('base64')}`,
    name: '回归表情包',
    source: 'upload',
  });
  builtinCalls.length = 0;
  await req('/chat', { method: 'POST', body: { message: '候选回归', sessionId: legacySessionId } });
  const candidateCall = builtinCalls[builtinCalls.length - 1];
  check(
    '表情包候选列表仍注入 system prompt',
    candidateCall && candidateCall.messages[0].content.includes('【可发送的表情包】')
  );

  // ================= F. SSRF 防护（模块级直测） =================
  ORIG_LOG('\nF. SSRF 防护（assertPublicUrl 全套）');

  const ssrfCases = [
    { url: 'http://127.0.0.1:8080/v1', label: '环回地址' },
    { url: 'http://localhost:3000/v1', label: 'localhost 主机名' },
    { url: 'http://10.0.0.5/v1', label: '10.0.0.0/8 私网' },
    { url: 'http://192.168.1.1/v1', label: '192.168.0.0/16 私网' },
    { url: 'http://172.16.0.1/v1', label: '172.16.0.0/12 私网' },
    { url: 'http://169.254.169.254/latest/meta-data', label: '云元数据地址' },
    { url: 'http://[::1]:8080/v1', label: 'IPv6 环回' },
    { url: 'http://user:pass@api.example.com/v1', label: 'URL 携带凭据' },
    { url: 'ftp://api.example.com/v1', label: '非 http 协议' },
    { url: 'not-a-url', label: '非法 URL' },
    { url: 'http://metadata.google.internal/v1', label: '云元数据主机名' },
    { url: 'http://this-host-does-not-exist.invalid/v1', label: '无法解析的域名' },
  ];
  for (const c of ssrfCases) {
    let blocked = false;
    // 临时关掉测试旁路，验证真实拦截行为（旁路运行时读取，finally 保证恢复）
    const savedAllow = process.env.BLUEBIRD_ALLOW_PRIVATE_BASE_URL;
    process.env.BLUEBIRD_ALLOW_PRIVATE_BASE_URL = '';
    try {
      await adapter.assertPublicUrl(c.url);
    } catch (error) {
      blocked = Boolean(error && error.kind === 'bad_request');
    } finally {
      process.env.BLUEBIRD_ALLOW_PRIVATE_BASE_URL = savedAllow;
    }
    check(`SSRF 拦截：${c.label}`, blocked, c.url);
  }

  const publicOk = await adapter.assertPublicUrl('http://93.184.216.34/v1');
  check('公网 IP 字面量放行', publicOk && publicOk.addresses.includes('93.184.216.34'));

  // ================= G. 持久化与重启 =================
  ORIG_LOG('\nG. 持久化与重启行为');

  // 文件落地与密钥分离
  check('api-configs.json 已落盘', fs.existsSync(configs.CONFIG_FILE));
  check('api-keys.json 已落盘', fs.existsSync(configs.KEYS_FILE));
  const configRaw = fs.readFileSync(configs.CONFIG_FILE, 'utf8');
  check(
    '元数据文件不含任何密钥',
    !containsSecret(configRaw)
  );
  const keysRaw = fs.readFileSync(configs.KEYS_FILE, 'utf8');
  check(
    '密钥单独存于 api-keys.json',
    keysRaw.includes(CUSTOM_KEY) && !configRaw.includes(CUSTOM_KEY)
  );

  // 重启：清模块缓存重载，配置与默认值保持
  const reloaded = reloadConfigModules();
  const afterRestart = reloaded.configs.listModelProviders();
  check(
    '重启后自定义服务商与默认值保持',
    afterRestart.some(p => p.id === chatProvider.id) &&
      reloaded.configs.getDefaults().providerId === 'deepseek' &&
      reloaded.configs.getDefaults().modelId === 'deepseek-chat'
  );
  check(
    '重启后密钥仍在（keyConfigured 保持 true）',
    afterRestart.find(p => p.id === chatProvider.id).keyConfigured === true
  );

  // 配置损坏保护：写坏文件 → 重载 → 只读保护，且不覆盖原文件
  fs.writeFileSync(configs.CONFIG_FILE, '{ this is not json');
  const corrupted = reloadConfigModules().configs;
  check('配置文件损坏后 isConfigCorrupted 为 true', corrupted.isConfigCorrupted() === true);
  const corruptAdd = corrupted.addModelProvider({
    name: 'x',
    baseUrl: 'https://api.example.com',
    apiKey: 'k',
    models: [{ id: 'm' }],
  });
  check(
    '损坏后拒绝写入（config_corrupted）',
    corruptAdd.error === 'config_corrupted'
  );
  check(
    '损坏文件未被覆盖（仍是坏 JSON）',
    fs.readFileSync(corrupted.CONFIG_FILE, 'utf8') === '{ this is not json'
  );
  // 修复：删掉坏文件，重载恢复（注意：配置丢失后服务商清空，需重建）
  fs.unlinkSync(corrupted.CONFIG_FILE);
  const healed = reloadConfigModules().configs;
  check('删除损坏文件后恢复正常（可写）', healed.isConfigCorrupted() === false);

  // 重建服务商，供密钥文件损坏测试
  const keyTestProvider = healed.addModelProvider({
    name: '密钥损坏测试',
    baseUrl: 'https://api.example.com',
    apiKey: CUSTOM_KEY,
    models: [{ id: 'm' }],
  }).provider;

  // 密钥文件损坏：备份后置空（元数据保留，服务商变为未配置密钥）
  fs.writeFileSync(healed.KEYS_FILE, 'not-json-at-all');
  const brokenKeys = reloadConfigModules().configs;
  check(
    '密钥文件损坏后对应服务商 keyConfigured 变 false',
    brokenKeys.listModelProviders().find(p => p.id === keyTestProvider.id).keyConfigured === false
  );
  const backups = fs.readdirSync(DATA_DIR).filter(f => f.startsWith('api-keys.json.corrupt-'));
  check('损坏的密钥文件已备份（.corrupt-*）', backups.length >= 1);

  // 服务商数量上限（模块级直测，21 次不耗配额）
  {
    const cfg = reloadConfigModules().configs;
    let hitLimit = false;
    for (let i = 0; i < 25; i++) {
      const r = cfg.addModelProvider({
        name: `批量${i}`,
        baseUrl: 'https://api.example.com',
        apiKey: `key-${i}`,
        models: [{ id: 'm' }],
      });
      if (r.error) {
        hitLimit = /上限/.test(r.error);
        break;
      }
    }
    check('服务商数量达上限后拒绝新增', hitLimit);
    // 清理批量服务商，恢复干净状态
    for (const p of cfg.listModelProviders()) {
      if (!p.builtin) cfg.deleteModelProvider(p.id);
    }
  }

  // ================= 汇总 =================
  const adapter2 = reloadConfigModules().adapter;
  // 错误分类与脱敏的模块级直测（补充 B/C 的边界）
  {
    const secret = 'sk-super-secret-key';
    const err = new Error(`boom ${secret}`);
    err.status = 401;
    const classified = adapter2.classifyError(err);
    check('classifyError：401 → auth 且脱敏', classified.code === 'auth' && !JSON.stringify(classified).includes(secret));

    const timeoutErr = new Error('timed out');
    timeoutErr.name = 'APIConnectionTimeoutError';
    check('classifyError：SDK 超时类 → timeout', adapter2.classifyError(timeoutErr).code === 'timeout');

    const connErr = new Error('refused');
    connErr.name = 'APIConnectionError';
    check('classifyError：SDK 连接类 → connection', adapter2.classifyError(connErr).code === 'connection');

    const plain = new Error('内部 bug');
    check('classifyError：未知错误 → connection（不冒充模型错误）', adapter2.classifyError(plain).code === 'connection');

    // 能力校验：非视觉模型 + wantVision → capability 拒绝（不发请求）
    let capabilityBlocked = false;
    try {
      adapter2.resolveTarget({ providerId: 'deepseek', modelId: 'deepseek-chat', wantVision: true });
    } catch (e) {
      capabilityBlocked = e && e.kind === 'capability';
    }
    check('resolveTarget：非视觉模型 + wantVision → capability 拒绝', capabilityBlocked);

    // 视觉目标解析：内置 DeepSeek 应解析到 deepseek-flash
    const visionTarget = adapter2.resolveVisionTarget({});
    check(
      'resolveVisionTarget：内置解析到 deepseek-flash',
      visionTarget.providerId === 'deepseek' && visionTarget.modelId === 'deepseek-flash'
    );

    // 带图请求优先沿用用户选中的默认视觉模型，而不是「服务商里第一个视觉模型」。
    // 旧实现忽略 defaults.modelId，导致有多个视觉模型时选了 B 仍调用 A。
    const unit = reloadConfigModules();
    const dual = unit.configs.addModelProvider({
      name: '双视觉',
      baseUrl: MOCK_BASE,
      apiKey: CUSTOM_KEY,
      models: [
        { id: 'vis-a', capabilities: { vision: true } },
        { id: 'vis-b', capabilities: { vision: true } },
      ],
    }).provider;
    unit.configs.setDefaultModel({ providerId: dual.id, modelId: 'vis-b' });
    const preferred = unit.adapter.resolveVisionTarget({});
    check(
      'resolveVisionTarget：默认视觉模型 vis-b 优先于第一个视觉模型 vis-a',
      preferred.providerId === dual.id && preferred.modelId === 'vis-b',
      `actual=${preferred.providerId}/${preferred.modelId}`
    );
    unit.configs.deleteModelProvider(dual.id);
    unit.configs.setDefaultModel({ providerId: 'deepseek', modelId: 'deepseek-chat' });
  }

  ORIG_LOG(`\n结果：${passed} 通过，${failed} 失败`);
  if (failures.length) {
    ORIG_LOG('失败项：');
    for (const f of failures) ORIG_LOG(`  - ${f}`);
  }

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
