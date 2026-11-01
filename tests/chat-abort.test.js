/**
 * 云岫 Bluebird — 客户端断开后非流式 /chat 的上游取消契约
 *
 * 独立脚本（非 node:test）：与 tests/chat-persist.test.js 同款极简 runner。
 * 隔离保证：
 *   - 全部落盘指向系统临时目录（BLUEBIRD_DATA_DIR）；
 *   - 注入 openai / memory.js / emotion.js 桩模块，不真正请求模型。
 *
 * 覆盖：非流式 /chat 必须把 abort 信号交给模型调用；客户端断开后上游调用
 *       真的被取消；断开不落盘任何消息（无幽灵消息）；断开后服务仍然健康，
 *       不会因为往已关闭的连接写响应而崩溃。
 *
 * 运行：node tests/chat-abort.test.js
 */
const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');

// 测试在进程内 require server/index.js，会真的起一个 HTTP 服务。
// 退出前必须关掉它（含 keep-alive 连接），否则 Windows 上 process.exit
// 会撞上 libuv 的 UV_HANDLE_CLOSING 断言，导致非零退出码。
const originalListen = http.Server.prototype.listen;
let httpServer = null;

http.Server.prototype.listen = function (...args) {
  httpServer = this;
  return originalListen.apply(this, args);
};

async function closeHttpServer() {
  if (!httpServer) return;

  const server = httpServer;
  httpServer = null;

  try {
    if (typeof server.closeAllConnections === 'function') {
      server.closeAllConnections();
    }
  } catch (_) {
    /* ignore */
  }

  await new Promise(resolve => server.close(() => resolve()));
}

const SERVER = path.join(__dirname, '..', 'server');
const TMP_ROOT = fs.mkdtempSync(path.join(os.tmpdir(), 'bluebird-chat-abort-'));
const DATA_DIR = path.join(TMP_ROOT, 'data');
fs.mkdirSync(DATA_DIR, { recursive: true });

const STORE_FILE = path.join(DATA_DIR, 'sessions.json');

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

function readStore() {
  if (!fs.existsSync(STORE_FILE)) return { messages: {} };
  return JSON.parse(fs.readFileSync(STORE_FILE, 'utf8'));
}

function stubModule(file, exportsObj) {
  const target = require.resolve(path.join(SERVER, file));
  require.cache[target] = {
    id: target,
    filename: target,
    loaded: true,
    exports: exportsObj,
  };
}

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

async function waitFor(predicate, timeoutMs = 10000) {
  const started = Date.now();

  while (Date.now() - started < timeoutMs) {
    if (predicate()) return true;
    await sleep(20);
  }

  return false;
}

async function main() {
  // ---- 桩模块：模型（可挂起等待 abort）/ 记忆 / 情绪 ----
  const openaiTarget = require.resolve('openai', { paths: [SERVER] });

  // 每次模型调用记录 (body, options)，并观察 options.signal 是否被中止
  const calls = [];
  let hang = false;
  let abortObserved = false;

  require.cache[openaiTarget] = {
    id: openaiTarget,
    filename: openaiTarget,
    loaded: true,
    exports: class StubOpenAI {
      constructor() {
        this.chat = {
          completions: {
            create: (body, options) => {
              const signal = options && options.signal;

              calls.push({ body, signal });

              if (!hang) {
                return Promise.resolve({
                  model: 'stub-model',
                  choices: [{ message: { content: '[calm] 正常回复。' } }],
                });
              }

              // 挂起直到客户端断开导致 signal 被中止
              return new Promise((resolve, reject) => {
                if (!signal) {
                  reject(new Error('模型调用没有收到 abort 信号'));
                  return;
                }

                if (signal.aborted) {
                  abortObserved = true;
                  reject(abortError());
                  return;
                }

                signal.addEventListener('abort', () => {
                  abortObserved = true;
                  reject(abortError());
                });
              });
            },
          },
        };
      }
    },
  };

  function abortError() {
    const error = new Error('The operation was aborted');
    error.name = 'AbortError';
    return error;
  }

  stubModule('memory.js', {
    buildMemoryContext: () => '',
    processMemory: async () => null,
    clearMemories: () => {},
    recallMemoryBySourceQuote: async () => ({}),

    clearSessionMemories: async () => ({ removedEntries: 0, removedContributions: 0, remaining: 0, reason: "no-match" }),

    verifyStoreConsistency: () => ({ consistent: true, entries: 0, reason: "ok" }),

    getWriteOutcomes: () => [],
    getMemories: () => [],
    deleteMemory: () => false,
  });

  stubModule('emotion.js', {
    EMOTIONS: ['calm'],
    getEmotion: () => ({ emotion: 'calm', intensity: 0 }),
    buildEmotionContext: () => '',
    applyTimeDecay: state => state,
    applyObservation: () => ({ emotion: 'calm', intensity: 0 }),
  });

  process.env.BLUEBIRD_DATA_DIR = DATA_DIR;
  process.env.PORT = '0';
  process.env.BLUEBIRD_API_TOKEN = 'test-token-abort';
  process.env.DEEPSEEK_API_KEY = 'stub-key';

  const { server } = require(path.join(SERVER, 'index.js'));

  if (!server.listening) {
    await new Promise(resolve => server.once('listening', resolve));
  }
  const BASE = `http://127.0.0.1:${server.address().port}`;
  const TOKEN = 'test-token-abort';

  let ready = false;

  for (let i = 0; i < 100 && !ready; i++) {
    try {
      ready = (await fetch(BASE + '/')).ok;
    } catch (_) {
      await sleep(50);
    }
  }

  if (!ready) {
    check('服务启动', false, '5 秒内未就绪');
    return;
  }

  async function req(p, { method = 'GET', body, signal } = {}) {
    const res = await fetch(BASE + p, {
      method,
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${TOKEN}`,
      },
      body: body ? JSON.stringify(body) : undefined,
      ...(signal ? { signal } : {}),
    });

    let json = null;
    try {
      json = await res.json();
    } catch (_) {
      /* 非 JSON */
    }

    return { status: res.status, json };
  }

  const created = await req('/sessions', { method: 'POST', body: { title: 'abort' } });
  const sessionId = created.json.session.id;

  hang = true;
  const controller = new AbortController();
  const chatPromise = req('/chat', {
    method: 'POST',
    body: { message: '这条会被客户端掐断', sessionId },
    signal: controller.signal,
  }).catch(error => ({ aborted: true, error }));

  const dispatched = await waitFor(() => calls.length > 0);

  check('非流式 /chat 发起了模型调用', dispatched, `calls=${calls.length}`);

  controller.abort();

  const aborted = await waitFor(() => abortObserved);
  const outcome = await chatPromise;

  check(
    '模型调用收到了 abort 信号',
    Boolean(calls[0] && calls[0].signal),
    JSON.stringify({ hasSignal: Boolean(calls[0] && calls[0].signal) })
  );
  check(
    '客户端断开后上游调用被取消',
    aborted && Boolean(calls[0] && calls[0].signal && calls[0].signal.aborted),
    `abortObserved=${abortObserved} signalAborted=${Boolean(calls[0] && calls[0].signal && calls[0].signal.aborted)}`
  );
  check(
    '客户端侧的请求以中断结束',
    Boolean(outcome && outcome.aborted),
    JSON.stringify(outcome && outcome.error ? outcome.error.name : outcome)
  );

  await sleep(200);

  const store = readStore();
  const messages = (store.messages && store.messages[sessionId]) || [];

  check(
    '断开后没有落盘任何消息（无幽灵消息）',
    messages.length === 0,
    JSON.stringify(messages)
  );

  const health = await req('/');

  check('断开后服务仍然健康', health.status === 200, `status=${health.status}`);

  hang = false;
  const follow = await req('/chat', {
    method: 'POST',
    body: { message: '断开之后的正常请求', sessionId },
  });

  check(
    '断开后的新请求仍能正常返回（没有写已关闭连接而崩溃）',
    follow.status === 200 && follow.json && follow.json.persisted === true,
    `status=${follow.status}`
  );
  check(
    '断开过程没有产生未捕获异常',
    !errorLines.some(line => /uncaught|ERR_STREAM_WRITE_AFTER_END|Cannot set headers/i.test(line)),
    errorLines.filter(line => /uncaught|ERR_STREAM_WRITE_AFTER_END|Cannot set headers/i.test(line)).join(' | ').slice(-300)
  );
  check(
    '断开不算作模型错误（不写 AI API Error 日志）',
    !errorLines.some(line => line.includes('AI API Error')),
    errorLines.filter(line => line.includes('AI API Error')).join(' | ').slice(-300)
  );
}

(async () => {
  try {
    await main();
  } finally {
    await closeHttpServer();
  }

  ORIG_LOG(`\n通过 ${passed} 项，失败 ${failed} 项`);

  if (failures.length) {
    ORIG_LOG('失败明细：');
    failures.forEach(item => ORIG_LOG(`  - ${item}`));
    process.exit(1);
  }

  process.exit(0);
})().catch(error => {
  ORIG_ERR('测试运行异常：', error && error.stack ? error.stack : error);
  process.exit(1);
});
