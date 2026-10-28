/**
 * 云岫 Bluebird — 第 1 批加固验证（C1 只读保护 + A4 写入失败可见）
 *
 * 独立脚本（非 node:test）：与 tests/sessions.test.js 同款极简 runner，测完显式退出。
 * 隔离保证：
 *   - 会话数据全部落在系统临时目录（BLUEBIRD_DATA_DIR）；
 *   - HTTP 段把 server/memory.js、server/emotion.js 注入为桩模块，
 *     确保 require server/index.js 不会加载/写 server/data 下的真实记忆与情绪文件。
 *
 * 覆盖：损坏文件只读保护（不覆盖、不搬迁、可读回退）、重启后仍受保护、
 *       合法 JSON 但结构不对同样保护、写入失败回滚与可见、故障解除后恢复、
 *       以及损坏状态下路由层的 500 失败语义。
 *
 * 运行：node tests/sessions-recovery.test.js
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
const TMP_ROOT = fs.mkdtempSync(path.join(os.tmpdir(), 'bluebird-recovery-'));

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

function newDir(name) {
  const dir = path.join(TMP_ROOT, name);
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

function readRaw(file) {
  return fs.readFileSync(file, 'utf8');
}

function backupCount(dir) {
  return fs
    .readdirSync(dir)
    .filter(name => name.includes('.pre-multisession.bak')).length;
}

function freshSessions(dataDir) {
  const target = require.resolve(path.join(SERVER, 'sessions.js'));
  delete require.cache[target];
  process.env.BLUEBIRD_DATA_DIR = dataDir;
  return require(target);
}

const LEGACY = [
  { role: 'user', content: '旧消息一' },
  {
    role: 'assistant',
    content: '旧回复一',
    createdAt: '2026-01-01T00:00:00.000Z',
  },
];

function writeLegacy(dir) {
  fs.writeFileSync(
    path.join(dir, 'chat-history.json'),
    JSON.stringify(LEGACY, null, 2),
    'utf8'
  );
}

async function main() {
  // ---- A. 损坏文件：只读保护，原始文件绝不被覆盖 ----
  ORIG_LOG('\nA. 损坏文件进入只读保护');
  const dirA = newDir('a');
  const corruptRaw = '{"version":1,"sessions":[{"id":"x","title":"会';
  fs.writeFileSync(path.join(dirA, 'sessions.json'), corruptRaw, 'utf8');
  writeLegacy(dirA);

  const a = freshSessions(dirA);
  const listA = a.listSessions();

  check(
    'A 损坏时仍能读到回退视图（1 个默认会话）',
    listA.length === 1 && listA[0].id === a.DEFAULT_SESSION_ID,
    JSON.stringify(listA)
  );
  check(
    'A 回退视图含旧历史 2 条',
    listA[0] && listA[0].messageCount === 2,
    JSON.stringify(listA[0])
  );
  check('A 新建会话被拒绝', a.createSession({ title: 'x' }) === null);
  check(
    'A 追加消息被拒绝',
    a.appendMessages(a.DEFAULT_SESSION_ID, [{ role: 'user', content: '新' }]) ===
      null
  );
  check('A 清空被拒绝', a.replaceMessages(a.DEFAULT_SESSION_ID, []) === false);
  check(
    'A 内存视图未被污染（仍 2 条）',
    a.getMessages(a.DEFAULT_SESSION_ID).length === 2,
    String(a.getMessages(a.DEFAULT_SESSION_ID).length)
  );
  check(
    'A 原始损坏文件字节级未被改动',
    readRaw(path.join(dirA, 'sessions.json')) === corruptRaw
  );
  check(
    'A 未产生 .corrupt 旁挂文件（改为原地保护）',
    !fs.readdirSync(dirA).some(name => name.includes('.corrupt-'))
  );
  check(
    'A 日志明确给出只读保护提示',
    errorLines.some(line => line.includes('只读保护'))
  );
  check('A 旧历史备份生成且仅 1 份', backupCount(dirA) === 1, String(backupCount(dirA)));

  // ---- B. 仍在损坏状态下重启：保护继续生效 ----
  ORIG_LOG('\nB. 损坏未处理时重启');
  const b = freshSessions(dirA);

  check('B 重启后写入仍被拒绝', b.createSession({ title: 'y' }) === null);
  check(
    'B 重启后原始文件仍字节级未改动',
    readRaw(path.join(dirA, 'sessions.json')) === corruptRaw
  );
  check('B 重启未重复生成旧历史备份', backupCount(dirA) === 1, String(backupCount(dirA)));
  check(
    'B 重启后回退视图仍可读（2 条）',
    b.getMessages(b.DEFAULT_SESSION_ID).length === 2
  );

  // ---- C. 合法 JSON 但不是会话库结构 ----
  ORIG_LOG('\nC. 合法 JSON 但结构不对');
  const dirC = newDir('c');
  fs.writeFileSync(path.join(dirC, 'sessions.json'), '[]', 'utf8');

  const c = freshSessions(dirC);

  check('C 结构不对同样进入只读保护', c.createSession({ title: 'z' }) === null);
  check('C 文件未被空库覆盖', readRaw(path.join(dirC, 'sessions.json')) === '[]');

  // ---- D. A4：落盘失败可见 + 内存回滚 + 故障解除后恢复 ----
  ORIG_LOG('\nD. 落盘失败不再静默');
  const dirD = newDir('d');
  const d = freshSessions(dirD);

  const created = d.createSession({ title: '可写' });
  check('D 正常状态下可新建会话', !!created && !!created.id);

  // 注入失败：把临时文件路径占成目录，openSync('w') 必然失败。
  // 临时文件名带 pid（与 sessions.js 一致），占位路径必须同步带上。
  const TMP_OCCUPIER = path.join(dirD, `sessions.json.tmp.${process.pid}`);
  fs.mkdirSync(TMP_OCCUPIER);

  const before = d.listSessions().length;
  check('D 落盘失败时新建会话返回失败', d.createSession({ title: '失败' }) === null);
  check(
    'D 失败后内存已回滚（会话数不变）',
    d.listSessions().length === before,
    String(d.listSessions().length)
  );
  check(
    'D 落盘失败时追加消息返回失败',
    d.appendMessages(created.id, [{ role: 'user', content: 'x' }]) === null
  );
  check(
    'D 失败后消息数未变（仍 0）',
    d.getMessages(created.id).length === 0,
    String(d.getMessages(created.id).length)
  );
  check('D 落盘失败时清空返回失败', d.replaceMessages(created.id, []) === false);
  check(
    'D 磁盘上的会话数与内存一致',
    JSON.parse(readRaw(path.join(dirD, 'sessions.json'))).sessions.length ===
      before
  );
  check(
    'D 日志报出 save FAILED（不再静默）',
    errorLines.some(line => line.includes('save FAILED'))
  );

  fs.rmdirSync(TMP_OCCUPIER);

  const recovered = d.createSession({ title: '恢复' });
  check(
    'D 故障解除后写入恢复正常',
    !!recovered && d.listSessions().length === before + 1,
    String(d.listSessions().length)
  );

  // ---- E. 损坏状态下路由层语义（HTTP，memory/emotion 走桩，不碰真实数据）----
  ORIG_LOG('\nE. 损坏状态下的接口语义');
  const dirE = newDir('e');
  const corruptE = '{"sessions":[{"id":"broken"';
  fs.writeFileSync(path.join(dirE, 'sessions.json'), corruptE, 'utf8');
  writeLegacy(dirE);

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
    applyObservation: async state => state,
  });

  const sessionsTarget = require.resolve(path.join(SERVER, 'sessions.js'));
  const indexTarget = require.resolve(path.join(SERVER, 'index.js'));
  delete require.cache[sessionsTarget];
  delete require.cache[indexTarget];

  process.env.BLUEBIRD_DATA_DIR = dirE;
  // 端口交给操作系统分配：固定端口被占用时轮询会连上占用者的服务，
  // 把本套件的读写打到别人实例上。
  process.env.PORT = '0';
  process.env.BLUEBIRD_API_TOKEN = 'test-token-recovery';

  const { server } = require(indexTarget);

  // 等 listening 后从实例读取真实端口，与端口占用者完全不相干
  if (!server.listening) {
    await new Promise(resolve => server.once('listening', resolve));
  }
  const BASE = `http://127.0.0.1:${server.address().port}`;
  const TOKEN = 'test-token-recovery';

  let ready = false;

  for (let i = 0; i < 100 && !ready; i++) {
    try {
      ready = (await fetch(BASE + '/', {
        headers: { Connection: 'close' },
      })).ok;
    } catch (_) {
      await new Promise(resolve => setTimeout(resolve, 50));
    }
  }

  if (!ready) {
    check('E 服务启动', false, '5 秒内未就绪');
  } else {
    async function req(p, { method = 'GET', body } = {}) {
      const res = await fetch(BASE + p, {
        method,
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${TOKEN}`,
          // 测试进程退出前必须让客户端连接关闭；全局 fetch（undici）默认
          // keep-alive，残留的客户端 Socket 会在 Windows/Node 24 上
          // 与 process.exit 竞争，触发 libuv UV_HANDLE_CLOSING 断言。
          Connection: 'close',
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

    const sess = await req('/sessions');
    check(
      'E GET /sessions 只读可读（回退视图 1 个默认会话）',
      sess.status === 200 &&
        sess.json.sessions.length === 1 &&
        sess.json.sessions[0].messageCount === 2,
      JSON.stringify(sess.json)
    );

    const hist = await req('/history');
    check(
      'E GET /history 只读可读（2 条旧消息）',
      hist.status === 200 && hist.json.history.length === 2,
      JSON.stringify(hist.json)
    );

    const create = await req('/sessions', {
      method: 'POST',
      body: { title: '新' },
    });
    check(
      'E POST /sessions 返回 500（不再假装成功）',
      create.status === 500,
      `实际 ${create.status}`
    );

    const clear = await req('/history/clear', { method: 'POST', body: {} });
    check(
      'E POST /history/clear 返回 500',
      clear.status === 500,
      `实际 ${clear.status}`
    );

    const userId = hist.json.history.find(item => item.role === 'user').id;
    const recall = await req('/history/recall', {
      method: 'POST',
      body: { messageId: userId },
    });
    check(
      'E POST /history/recall 返回 500（消息未删除）',
      recall.status === 500,
      `实际 ${recall.status}`
    );

    const stillThere = await req('/history');
    check(
      'E 撤回失败后消息仍完整（2 条）',
      stillThere.json.history.length === 2,
      String(stillThere.json.history.length)
    );

    check(
      'E 全程原始文件字节级未被改动',
      readRaw(path.join(dirE, 'sessions.json')) === corruptE
    );
  }

  // ---- F. C5：孤儿 messages key 必须告警，不能静默丢弃 ----
  ORIG_LOG('\nF. 孤儿 messages key 告警');
  const dirF = newDir('f');
  fs.writeFileSync(
    path.join(dirF, 'sessions.json'),
    JSON.stringify(
      {
        version: 1,
        sessions: [
          {
            id: 'alive',
            title: '存活',
            createdAt: '2026-01-01T00:00:00.000Z',
            updatedAt: '2026-01-01T00:00:00.000Z',
          },
        ],
        messages: {
          alive: [{ id: 'm1', role: 'user', content: '正常', createdAt: '2026-01-01T00:00:00.000Z' }],
          ghost: [{ id: 'g1', role: 'user', content: '孤儿', createdAt: '2026-01-01T00:00:00.000Z' }],
        },
      },
      null,
      2
    ),
    'utf8'
  );

  const beforeF = errorLines.length;
  const f = freshSessions(dirF);
  const fList = f.listSessions();

  check(
    'F 存活会话仍可读（1 条）',
    !!fList.find(item => item.id === 'alive' && item.messageCount === 1),
    JSON.stringify(fList)
  );
  check(
    'F 孤儿 key 不会被并入任何会话',
    !fList.some(item => item.id === 'ghost'),
    JSON.stringify(fList)
  );
  check(
    'F 加载时打印了孤儿告警',
    errorLines.slice(beforeF).some(line => line.includes('orphan messages')),
    errorLines.slice(beforeF).join(' | ')
  );
  check(
    'F 告警包含孤儿 key 名',
    errorLines.slice(beforeF).some(line => line.includes('ghost'))
  );

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

  // 不要用 process.exit 强制终止：Windows/Node 24 上服务端句柄仍在
  // closing 状态时，process.exit 会触发 libuv UV_HANDLE_CLOSING 断言。
  // 让事件循环自然收尾，并把结果写进退出码。
  process.exitCode = failed === 0 ? 0 : 1;
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

  process.exitCode = 1;
});