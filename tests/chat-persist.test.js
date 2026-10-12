/**
 * 云岫 Bluebird — 第 2 批加固验证（A1 落盘时序 + C2 fsync 落盘）
 *
 * 独立脚本（非 node:test）：与 tests/sessions.test.js 同款极简 runner，测完显式退出。
 * 隔离保证：
 *   - 会话数据全部落在系统临时目录（BLUEBIRD_DATA_DIR）；
 *   - 注入 openai / memory.js / emotion.js 桩模块，既不真正请求模型，
 *     也不会加载或写入 server/data 下的真实记忆与情绪文件。
 *
 * 覆盖：/chat 返回前已落盘（persisted:true）、落盘内容正确且无标签残留、
 *       按会话写入严格隔离、未知会话 404、写盘失败时 persisted:false 且不落盘、
 *       故障解除后恢复。
 *
 * 运行：node tests/chat-persist.test.js
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
const TMP_ROOT = fs.mkdtempSync(path.join(os.tmpdir(), 'bluebird-chat-'));
const DATA_DIR = path.join(TMP_ROOT, 'data');
fs.mkdirSync(DATA_DIR, { recursive: true });

const STORE_FILE = path.join(DATA_DIR, 'sessions.json');
// 落盘用的临时文件名带 pid（多实例不再抢同一路径），这里必须同步带上
const TMP_FILE = `${STORE_FILE}.tmp.${process.pid}`;

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

async function main() {
  // 预置一条旧历史，确认默认会话可读
  fs.writeFileSync(
    path.join(DATA_DIR, 'chat-history.json'),
    JSON.stringify([{ role: 'user', content: '旧消息' }], null, 2),
    'utf8'
  );

  // ---- 桩模块：模型 / 记忆 / 情绪 ----
  const openaiTarget = require.resolve('openai', { paths: [SERVER] });

  // 记录每次模型调用的入参，用于断言"哪些历史真正进了上下文"（B1）
  const modelCalls = [];

  require.cache[openaiTarget] = {
    id: openaiTarget,
    filename: openaiTarget,
    loaded: true,
    exports: class StubOpenAI {
      constructor() {
        this.chat = {
          completions: {
            create: async args => {
              modelCalls.push(args);

              return {
                model: 'stub-model',
                // 故意带上情绪标签，验证 A1 落盘用的是清洗后的正文
                choices: [{ message: { content: '[calm] 这是回复正文。' } }],
              };
            },
          },
        };
      }
    },
  };

  stubModule('memory.js', {
    buildMemoryContext: () => '',
    processMemory: async () => null,
    clearMemories: () => {},
    recallMemoryBySourceQuote: async () => {},
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

  // index.js 用 client 的存在与否决定是否调用模型：必须在 require 之前置好 key
  process.env.BLUEBIRD_DATA_DIR = DATA_DIR;
  process.env.PORT = '3995';
  process.env.BLUEBIRD_API_TOKEN = 'test-token-chat';
  process.env.DEEPSEEK_API_KEY = 'stub-key';

  const sessionsTarget = require.resolve(path.join(SERVER, 'sessions.js'));
  const indexTarget = require.resolve(path.join(SERVER, 'index.js'));
  delete require.cache[sessionsTarget];
  delete require.cache[indexTarget];

  const sessions = require(sessionsTarget);
  require(indexTarget);

  const BASE = 'http://127.0.0.1:3995';
  const TOKEN = 'test-token-chat';

  let ready = false;

  for (let i = 0; i < 100 && !ready; i++) {
    try {
      ready = (await fetch(BASE + '/')).ok;
    } catch (_) {
      await new Promise(resolve => setTimeout(resolve, 50));
    }
  }

  if (!ready) {
    check('服务启动', false, '5 秒内未就绪');
  } else {
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
        /* 非 JSON */
      }

      return { status: res.status, json };
    }

    ORIG_LOG('\nA1. /chat 返回前已落盘');
    const created = await req('/sessions', { method: 'POST', body: { title: 'A' } });
    const sessionA = created.json.session.id;

    const chat = await req('/chat', {
      method: 'POST',
      body: { message: '你好', sessionId: sessionA },
    });

    check('POST /chat 返回 200', chat.status === 200, `实际 ${chat.status}`);
    check(
      '响应带 persisted: true（此前无此字段）',
      chat.json.persisted === true,
      JSON.stringify(chat.json)
    );
    check('响应回显 sessionId', chat.json.sessionId === sessionA);

    // 落盘必须发生在 res.json 之前：拿到响应时磁盘上就该有这两条
    const diskAfterChat = readStore();
    check(
      '响应返回时磁盘已含该会话的 2 条消息',
      diskAfterChat.messages[sessionA] &&
        diskAfterChat.messages[sessionA].length === 2,
      JSON.stringify(diskAfterChat.messages[sessionA])
    );
    check(
      '落盘正文已剥离 [mood] 标签',
      !diskAfterChat.messages[sessionA].some(item =>
        item.content.includes('[calm]')
      )
    );
    check(
      '落盘正文为清洗后的回复',
      diskAfterChat.messages[sessionA][1].content === '这是回复正文。',
      diskAfterChat.messages[sessionA][1].content
    );
    check(
      '未污染默认会话',
      (diskAfterChat.messages[sessions.DEFAULT_SESSION_ID] || []).length === 1
    );

    const chatDefault = await req('/chat', {
      method: 'POST',
      body: { message: '默认会话消息' },
    });
    check(
      '不带 sessionId 时落到默认会话',
      chatDefault.json.sessionId === sessions.DEFAULT_SESSION_ID &&
        chatDefault.json.persisted === true,
      JSON.stringify(chatDefault.json)
    );

    const unknown = await req('/chat', {
      method: 'POST',
      body: { message: 'hi', sessionId: 'no-such' },
    });
    check('未知会话返回 404', unknown.status === 404, `实际 ${unknown.status}`);

    ORIG_LOG('\nC2 + A4. 落盘失败时 persisted:false 且不落盘');
    const beforeFail = readStore().messages[sessionA].length;

    // 把临时文件路径占成目录，openSync('w') 必然失败
    fs.mkdirSync(TMP_FILE);

    const failedChat = await req('/chat', {
      method: 'POST',
      body: { message: '写不进去的消息', sessionId: sessionA },
    });

    check(
      '写盘失败仍返回模型回复（不吞掉内容）',
      failedChat.status === 200 && failedChat.json.reply === '这是回复正文。',
      JSON.stringify(failedChat.json)
    );
    check(
      '响应明确 persisted: false',
      failedChat.json.persisted === false,
      JSON.stringify(failedChat.json)
    );
    check(
      '失败时磁盘消息数未增加',
      readStore().messages[sessionA].length === beforeFail,
      String(readStore().messages[sessionA].length)
    );
    check(
      '失败时内存已回滚（与服务端模块读回一致）',
      sessions.getMessages(sessionA).length === beforeFail,
      String(sessions.getMessages(sessionA).length)
    );
    check(
      '日志报出 persist FAILED（不再静默）',
      errorLines.some(line => line.includes('persist FAILED'))
    );
    check(
      '失败后未残留半写的临时文件',
      !fs.existsSync(TMP_FILE) || fs.statSync(TMP_FILE).isDirectory()
    );

    fs.rmdirSync(TMP_FILE);

    const recoveredChat = await req('/chat', {
      method: 'POST',
      body: { message: '恢复了', sessionId: sessionA },
    });

    check(
      '故障解除后 persisted 恢复 true',
      recoveredChat.json.persisted === true,
      JSON.stringify(recoveredChat.json)
    );
    check(
      '故障解除后磁盘消息数正确增加',
      readStore().messages[sessionA].length === beforeFail + 2,
      String(readStore().messages[sessionA].length)
    );
    check(
      'fsync 落盘路径可用（临时文件已清理）',
      !fs.existsSync(TMP_FILE)
    );

    ORIG_LOG('\nB1. 客户端历史回退只对默认会话开放');
    const createdB1 = await req('/sessions', {
      method: 'POST',
      body: { title: 'B1' },
    });
    const sessionB1 = createdB1.json.session.id;

    modelCalls.length = 0;

    const b1Chat = await req('/chat', {
      method: 'POST',
      body: {
        message: 'B1 首问',
        sessionId: sessionB1,
        history: [
          { role: 'user', content: '别的会话的秘密问题' },
          { role: 'assistant', content: '别的会话的秘密回答' },
        ],
      },
    });

    check(
      'B1 非默认空会话请求成功',
      b1Chat.status === 200 && b1Chat.json.persisted === true,
      JSON.stringify(b1Chat.json)
    );

    const b1Messages = (modelCalls[0] && modelCalls[0].messages) || [];

    check(
      'B1 客户端历史未被注入模型上下文',
      !b1Messages.some(item =>
        String(item.content).includes('别的会话的秘密')
      ),
      JSON.stringify(b1Messages)
    );
    check(
      'B1 模型上下文含本次用户消息',
      b1Messages.some(
        item => item.role === 'user' && item.content === 'B1 首问'
      ),
      JSON.stringify(b1Messages)
    );
    check(
      'B1 新会话只落自己的消息（2 条）',
      readStore().messages[sessionB1].length === 2,
      String(readStore().messages[sessionB1].length)
    );

    // 反向确认：默认会话有存储时同样以存储为准，客户端历史不能覆盖它
    modelCalls.length = 0;

    await req('/chat', {
      method: 'POST',
      body: {
        message: '默认会话续聊',
        history: [{ role: 'user', content: '注入标记X' }],
      },
    });

    const defMessages = (modelCalls[0] && modelCalls[0].messages) || [];

    check(
      'B1 默认会话有存储时仍以存储为准（忽略客户端历史）',
      !defMessages.some(item => String(item.content).includes('注入标记X')),
      JSON.stringify(defMessages)
    );
  }

  ORIG_LOG(`\n通过 ${passed} 项，失败 ${failed} 项`);
  if (failures.length) {
    ORIG_LOG('\n失败明细：');
    failures.forEach(item => ORIG_LOG('  - ' + item));
  }

  console.log = ORIG_LOG;
  console.error = ORIG_ERR;

  await closeHttpServer();

  try {
    fs.rmSync(TMP_ROOT, { recursive: true, force: true });
  } catch (_) {
    /* 清理失败不影响结果 */
  }

  process.exit(failed === 0 ? 0 : 1);
}

main().catch(error => {
  console.log = ORIG_LOG;
  console.error = ORIG_ERR;
  ORIG_LOG('测试执行异常：' + error.message);

  try {
    if (httpServer) {
      if (typeof httpServer.closeAllConnections === 'function') {
        httpServer.closeAllConnections();
      }
      httpServer.close();
    }
  } catch (_) {
    /* ignore */
  }

  try {
    fs.rmSync(TMP_ROOT, { recursive: true, force: true });
  } catch (_) {
    /* ignore */
  }

  process.exit(1);
});