/**
 * 云岫 Bluebird — E2/E3 端到端验证（撤回跨会话隔离 + 情绪衰减全局化）
 *
 * 独立脚本（非 node:test）：与 tests/chat-persist.test.js 同款极简 runner。
 * 隔离保证：
 *   - 会话 / 记忆 / 情绪数据全部落在系统临时目录（BLUEBIRD_DATA_DIR）；
 *   - 注入 openai 桩模块：聊天回复固定带 [sad] 标签，记忆提取按用户原文生成，
 *     既不请求真实模型，也不触碰 server/data 下任何真实文件。
 *
 * 覆盖：
 *   E2-1 /chat 提取的长期记忆带会话归属；
 *   E2-2 本会话撤回会删掉本会话产生的记忆；
 *   E2-3 同内容记忆被另一会话去重认领后，本会话撤回不得误删（旧实现的漏洞）；
 *   E2-4 无归属旧记忆：本会话无匹配时按旧行为回退撤回；
 *   E3   切到五天没聊的旧会话，不得按旧会话 gap 额外衰减全局情绪。
 *
 * 运行：node tests/session-scope-e2e.test.js
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
const DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'bluebird-scope-'));

const origLog = console.log;
const origErr = console.error;
console.log = () => {};
console.error = () => {};

let passed = 0;
let failed = 0;
const failures = [];

function check(name, cond, extra = '') {
  if (cond) {
    passed++;
    origLog(`  ✔ ${name}`);
  } else {
    failed++;
    failures.push(name + (extra ? ` — ${extra}` : ''));
    origLog(`  ✖ ${name}${extra ? ` — ${extra}` : ''}`);
  }
}

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

const PORT = '3996';
const TOKEN = 'test-token-scope';
const BASE = `http://127.0.0.1:${PORT}`;

async function req(p, { method = 'GET', body } = {}) {
  const res = await fetch(BASE + p, {
    method,
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${TOKEN}`,
    },
    body: body ? JSON.stringify(body) : undefined,
  });

  let json = null;
  try {
    json = await res.json();
  } catch (_) {
    /* 非 JSON 响应 */
  }

  return { status: res.status, json };
}

/** 轮询 /memory 直到满足条件 */
async function waitMemories(predicate, timeout = 3000) {
  const start = Date.now();

  while (Date.now() - start < timeout) {
    const { json } = await req('/memory');

    if (json && Array.isArray(json.memories) && predicate(json.memories)) {
      return json.memories;
    }

    await sleep(80);
  }

  return null;
}

const isSameQuote = m => m && m.sourceQuote === '我叫宋泽';

async function main() {
  const quotes = {
    name: '我叫宋泽',
    food: '我最爱吃辣',
  };

  // ---- 预置数据：五天前聊过的旧会话（E3）+ 无归属旧记忆（E2-4） ----
  const oldIso = new Date(
    Date.now() - 5 * 24 * 60 * 60 * 1000
  ).toISOString();
  const seedIso = new Date().toISOString();

  fs.writeFileSync(
    path.join(DATA_DIR, 'sessions.json'),
    JSON.stringify(
      {
        version: 1,
        sessions: [
          { id: 'old', title: '旧会话', createdAt: oldIso, updatedAt: oldIso },
        ],
        messages: {
          old: [
            {
              id: 'old-m1',
              role: 'user',
              content: '五天前的消息',
              createdAt: oldIso,
            },
            {
              id: 'old-m2',
              role: 'assistant',
              content: '嗯。',
              createdAt: oldIso,
            },
          ],
        },
      },
      null,
      2
    ),
    'utf8'
  );

  fs.writeFileSync(
    path.join(DATA_DIR, 'memory.json'),
    JSON.stringify(
      [
        {
          content: '用户喜欢吃辣',
          type: 'preference',
          keywords: ['吃辣'],
          confidence: 0.95,
          sourceQuote: quotes.food,
          createdAt: seedIso,
          updatedAt: seedIso,
        },
      ],
      null,
      2
    ),
    'utf8'
  );

  // ---- 桩：openai（聊天 + 记忆提取共用同一个 client） ----
  const openaiTarget = require.resolve('openai', { paths: [SERVER] });

  require.cache[openaiTarget] = {
    id: openaiTarget,
    filename: openaiTarget,
    loaded: true,
    exports: class StubOpenAI {
      constructor() {
        this.chat = {
          completions: {
            create: async args => {
              const sys = String(args?.messages?.[0]?.content || '');
              const userText = String(args?.messages?.[1]?.content || '');

              // 记忆提取请求：按用户原文生成一条能过校验的记忆
              if (sys.includes('长期记忆提取器')) {
                const quote = userText.slice(0, 24);
                const reply = JSON.stringify({
                  content: `用户说过：${quote}`,
                  type: 'fact',
                  keywords: ['测试'],
                  confidence: 0.95,
                  sourceQuote: quote,
                });

                return {
                  model: 'stub-model',
                  choices: [{ message: { content: reply } }],
                };
              }

              // 聊天请求：固定 [sad] 观察信号，正文不含标签
              return {
                model: 'stub-model',
                choices: [{ message: { content: '[sad] 我在呢。' } }],
              };
            },
          },
        };
      }
    },
  };

  process.env.BLUEBIRD_DATA_DIR = DATA_DIR;
  process.env.PORT = PORT;
  process.env.BLUEBIRD_API_TOKEN = TOKEN;
  process.env.DEEPSEEK_API_KEY = 'stub-key';

  const sessionsTarget = require.resolve(path.join(SERVER, 'sessions.js'));
  const indexTarget = require.resolve(path.join(SERVER, 'index.js'));
  delete require.cache[sessionsTarget];
  delete require.cache[indexTarget];

  const memoryModule = require(path.join(SERVER, 'memory.js'));
  const emotionModule = require(path.join(SERVER, 'emotion.js'));

  require(indexTarget);

  // 等 HTTP 服务就绪
  let ready = false;

  for (let i = 0; i < 100 && !ready; i++) {
    try {
      ready = (await fetch(BASE + '/')).ok;
    } catch (_) {
      await sleep(50);
    }
  }

  if (!ready) throw new Error('后端服务未在预期时间内就绪');

  // 会话 A / B：E2 用；会话 C：E3 的"新鲜会话"
  const createdA = await req('/sessions', { method: 'POST', body: {} });
  const sessionA = createdA.json?.session?.id;
  const createdB = await req('/sessions', { method: 'POST', body: {} });
  const sessionB = createdB.json?.session?.id;
  const createdC = await req('/sessions', { method: 'POST', body: {} });
  const sessionC = createdC.json?.session?.id;

  check(
    '创建会话 A/B/C 成功',
    !!sessionA && !!sessionB && !!sessionC,
    JSON.stringify([sessionA, sessionB, sessionC])
  );

  // ---- E2-1：/chat 提取的记忆带会话归属 ----
  const chatA1 = await req('/chat', {
    method: 'POST',
    body: { sessionId: sessionA, message: quotes.name },
  });
  check('A 会话聊天成功且已落盘', chatA1.json?.persisted === true);

  let memories = await waitMemories(list =>
    list.some(m => m.sessionId === sessionA && isSameQuote(m))
  );
  check(
    'E2-1 提取的记忆带 A 会话归属',
    !!memories,
    JSON.stringify(memories)
  );
  check(
    'E2-1 无归属旧记忆（吃辣）不受影响',
    !!memories && memories.some(m => m.sourceQuote === quotes.food && !m.sessionId)
  );

  // ---- E2-2：本会话撤回删除本会话的记忆 ----
  const recallA1 = await req('/history/recall', {
    method: 'POST',
    body: { sessionId: sessionA, messageId: chatA1.json?.userMessageId },
  });
  check(
    'E2-2 撤回消息成功（用户消息 + 配对回复）',
    recallA1.json?.ok === true && recallA1.json?.removedCount === 2,
    JSON.stringify(recallA1.json)
  );

  memories = await waitMemories(
    list => !list.some(m => m.sessionId === sessionA)
  );
  check(
    'E2-2 本会话记忆被同步撤回',
    !!memories && memories.length === 1,
    JSON.stringify(memories)
  );

  // ---- E2-3：同内容记忆被 B 会话去重认领后，A 撤回不得误删 ----
  const chatA2 = await req('/chat', {
    method: 'POST',
    body: { sessionId: sessionA, message: quotes.name },
  });
  memories = await waitMemories(list =>
    list.some(m => m.sessionId === sessionA && isSameQuote(m))
  );
  check('E2-3 前置：A 会话重新产生记忆', !!memories);

  const chatB1 = await req('/chat', {
    method: 'POST',
    body: { sessionId: sessionB, message: quotes.name },
  });
  check('B 会话聊天成功', chatB1.json?.persisted === true);

  memories = await waitMemories(list =>
    list.some(m => m.sessionId === sessionB && isSameQuote(m)) &&
    !list.some(m => m.sessionId === sessionA)
  );
  check(
    'E2-3 前置：同内容记忆被去重合并到 B 会话归属',
    !!memories,
    JSON.stringify(memories)
  );

  const recallA2 = await req('/history/recall', {
    method: 'POST',
    body: { sessionId: sessionA, messageId: chatA2.json?.userMessageId },
  });
  check(
    'E2-3 A 撤回消息本身成功',
    recallA2.json?.ok === true && recallA2.json?.removedCount === 2,
    JSON.stringify(recallA2.json)
  );

  await sleep(500); // 等异步记忆撤回执行完（若误删，这里就会生效）
  const afterRecallA2 = await req('/memory');
  check(
    'E2-3 A 撤回未误删 B 会话的同内容记忆',
    !!afterRecallA2.json?.memories?.some(m => m.sessionId === sessionB && isSameQuote(m)),
    JSON.stringify(afterRecallA2.json?.memories)
  );

  // ---- E2-4：无归属旧记忆：本会话无匹配时回退撤回 ----
  // 把旧条目 createdAt 刷成当前，保证落在撤回的 5 秒 ~ 2 小时时间窗内
  const memoryFile = path.join(DATA_DIR, 'memory.json');
  const current = JSON.parse(fs.readFileSync(memoryFile, 'utf8'));
  const refreshed = new Date().toISOString();
  fs.writeFileSync(
    memoryFile,
    JSON.stringify(
      current.map(m =>
        !m.sessionId && m.sourceQuote === quotes.food
          ? { ...m, createdAt: refreshed, updatedAt: refreshed }
          : m
      ),
      null,
      2
    ),
    'utf8'
  );
  memoryModule.loadMemories();

  const chatA3 = await req('/chat', {
    method: 'POST',
    body: { sessionId: sessionA, message: quotes.food },
  });
  check('吃辣消息无记忆触发词、聊天成功', chatA3.json?.persisted === true);

  const recallA3 = await req('/history/recall', {
    method: 'POST',
    body: { sessionId: sessionA, messageId: chatA3.json?.userMessageId },
  });
  check(
    'E2-4 撤回消息成功',
    recallA3.json?.ok === true && recallA3.json?.removedCount === 2,
    JSON.stringify(recallA3.json)
  );

  memories = await waitMemories(
    list => !list.some(m => m.sourceQuote === quotes.food)
  );
  check(
    'E2-4 无归属旧记忆被回退撤回',
    !!memories,
    JSON.stringify(memories)
  );
  check(
    'E2-4 其他会话的记忆仍然保留',
    !!memories && memories.some(m => m.sessionId === sessionB && isSameQuote(m))
  );

  // ---- E3：切到五天没聊的旧会话，不额外衰减全局情绪 ----
  // 情绪停在 sad 60，上一次衰减检查在 2 分钟前（10 分钟档内 -> 不衰减）
  fs.writeFileSync(
    path.join(DATA_DIR, 'emotion-state.json'),
    JSON.stringify(
      {
        emotion: 'sad',
        intensity: 60,
        updatedAt: new Date(Date.now() - 2 * 60 * 1000).toISOString(),
        lastObservedAt: new Date(Date.now() - 2 * 60 * 1000).toISOString(),
        lastDecayAt: new Date(Date.now() - 2 * 60 * 1000).toISOString(),
      },
      null,
      2
    ),
    'utf8'
  );
  emotionModule.loadEmotion();

  // 新鲜会话：不衰减（基线 2 分钟）→ sad 60 + [sad] 强化 8 = 68
  const chatC1 = await req('/chat', {
    method: 'POST',
    body: { sessionId: sessionC, message: '我回来了' },
  });
  check(
    'E3 前置：新会话不触发衰减，60 -> 68',
    chatC1.json?.mood === 'sad' && chatC1.json?.intensity === 68,
    JSON.stringify({ mood: chatC1.json?.mood, intensity: chatC1.json?.intensity })
  );

  // 切到五天没聊的旧会话：按全局基线（上一条消息几秒前）不应衰减 -> 68 + 8 = 76
  const chatOld = await req('/chat', {
    method: 'POST',
    body: { sessionId: 'old', message: '还在吗' },
  });
  check(
    'E3 切旧会话不按旧 gap 衰减全局情绪（68 -> 76 而非回归 calm）',
    chatOld.json?.mood === 'sad' && chatOld.json?.intensity === 76,
    JSON.stringify({ mood: chatOld.json?.mood, intensity: chatOld.json?.intensity })
  );

  // 再切一次旧会话：基线已推进，仍不衰减 -> 76 + 8 = 84
  const chatOld2 = await req('/chat', {
    method: 'POST',
    body: { sessionId: 'old', message: '在的' },
  });
  check(
    'E3 反复切旧会话不重复衰减（76 -> 84）',
    chatOld2.json?.mood === 'sad' && chatOld2.json?.intensity === 84,
    JSON.stringify({ mood: chatOld2.json?.mood, intensity: chatOld2.json?.intensity })
  );
}

main()
  .catch(error => {
    failed++;
    failures.push(`未捕获异常：${(error && error.stack) || error}`);
  })
  .then(async () => {
    await closeHttpServer();

    origLog(`\n结果：${passed} 通过，${failed} 失败`);
    if (failures.length) {
      origLog('失败项：');
      for (const item of failures) origLog(`  - ${item}`);
    }
    process.exitCode = failed ? 1 : 0;
  });