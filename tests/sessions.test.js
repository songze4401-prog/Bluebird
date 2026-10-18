/**
 * 云岫 Bluebird — 多会话后端（server/sessions.js + server/index.js）行为测试
 *
 * 独立脚本（非 node:test）：与 tests/api.test.js 同款极简 runner，测完显式退出。
 * 关键隔离点：全程使用临时数据目录（BLUEBIRD_DATA_DIR），
 * 不读写 server/data 下任何真实聊天/记忆/情绪文件。
 *
 * 覆盖：旧历史安全迁移与兼容、会话列表/新建、按会话读写与清空、
 *       不同会话严格隔离、重启（重新加载模块）后的持久化。
 *
 * 运行：node tests/sessions.test.js
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

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'bluebird-sessions-'));

process.env.BLUEBIRD_DATA_DIR = TMP;
// 端口交给操作系统分配：固定端口被占用时 waitReady 会连上占用者的服务，
// 把本套件的读写打到别人实例上。
process.env.PORT = '0';
process.env.BLUEBIRD_API_TOKEN = 'test-token-sessions';
delete process.env.DEEPSEEK_API_KEY; // 不配 key，验证降级路径不触碰落盘逻辑

// BASE 在服务 listening 后回填（见下方 IIFE 开头）
let BASE = '';
const TOKEN = 'test-token-sessions';

// ---- 预置「旧版」数据：单份 chat-history.json，且故意混合缺 id / createdAt 的条目 ----
const LEGACY = [
  { role: 'user', content: '旧消息一' }, // 缺 id、缺 createdAt
  {
    id: 'legacy-a2',
    role: 'assistant',
    content: '旧回复一',
    createdAt: '2026-01-01T00:00:00.000Z',
  },
  { role: 'user', content: '旧消息二' }, // 缺 id、缺 createdAt
];
const LEGACY_FILE = path.join(TMP, 'chat-history.json');
fs.writeFileSync(LEGACY_FILE, JSON.stringify(LEGACY, null, 2), 'utf8');
const legacyRawBefore = fs.readFileSync(LEGACY_FILE, 'utf8');

const origLog = console.log;
const origErr = console.error;
console.log = () => {};
console.error = () => {};

const sessions = require(path.join(__dirname, '..', 'server', 'sessions.js'));
const { server } = require(path.join(__dirname, '..', 'server', 'index.js'));

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

async function req(p, { method = 'GET', token = TOKEN, body } = {}) {
  const res = await fetch(BASE + p, {
    method,
    headers: {
      'Content-Type': 'application/json',
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
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

async function waitReady() {
  for (let i = 0; i < 100; i++) {
    try {
      const res = await fetch(BASE + '/');
      if (res.ok) return true;
    } catch (_) {
      /* 还没起来 */
    }
    await new Promise(r => setTimeout(r, 50));
  }
  return false;
}

(async () => {
  // 等 listening 后从实例读取真实端口：固定端口被占用时，waitReady 的
  // 轮询会连上占用者的服务，把本套件的读写打到别人实例上。
  if (!server.listening) {
    await new Promise(resolve => server.once('listening', resolve));
  }
  BASE = `http://127.0.0.1:${server.address().port}`;

  const ready = await waitReady();
  if (!ready) {
    origLog('服务未能在 5 秒内启动');
    process.exit(1);
  }

  let sessionAId = null;
  let sessionBId = null;

  origLog('\n旧数据迁移与兼容');
  {
    const list = sessions.listSessions();
    check('首次加载将旧历史迁入唯一会话', list.length === 1, `实际 ${list.length}`);
    check(
      '迁移后的会话 id 为 default',
      list[0] && list[0].id === sessions.DEFAULT_SESSION_ID,
      JSON.stringify(list[0])
    );
    check(
      '旧消息条数完整保留（3 条）',
      list[0] && list[0].messageCount === 3,
      JSON.stringify(list[0])
    );

    const msgs = sessions.getMessages(sessions.DEFAULT_SESSION_ID);
    check('按会话可读到旧消息', Array.isArray(msgs) && msgs.length === 3);
    check(
      '迁移补齐了缺失的 id 与 createdAt',
      msgs.every(m => typeof m.id === 'string' && m.id && typeof m.createdAt === 'string' && m.createdAt)
    );
    check(
      '已存在的 id 未被改写',
      msgs.some(m => m.id === 'legacy-a2')
    );

    const legacyRawAfter = fs.readFileSync(LEGACY_FILE, 'utf8');
    check('旧 chat-history.json 原地保留、内容未被改写', legacyRawAfter === legacyRawBefore);
    check('迁移前自动生成了备份文件', fs.existsSync(`${LEGACY_FILE}.pre-multisession.bak`));
  }

  origLog('\n新建会话与读写隔离');
  {
    const a = sessions.createSession({ title: '会话A' });
    sessionAId = a.id;
    check('新建会话返回独立 id 与标题', !!a.id && a.title === '会话A' && a.id !== sessions.DEFAULT_SESSION_ID);
    check('新建会话初始为空', a.messageCount === 0);

    sessions.appendMessages(sessions.DEFAULT_SESSION_ID, [
      { role: 'user', content: '默认会话新消息' },
    ]);
    sessions.appendMessages(sessionAId, [{ role: 'user', content: 'A 的消息' }]);

    const defMsgs = sessions.getMessages(sessions.DEFAULT_SESSION_ID);
    const aMsgs = sessions.getMessages(sessionAId);

    check('默认会话追加成功', defMsgs.length === 4, `实际 ${defMsgs.length}`);
    check('A 会话追加成功', aMsgs.length === 1, `实际 ${aMsgs.length}`);
    check(
      '严格隔离：默认会话不含 A 的消息',
      !defMsgs.some(m => m.content === 'A 的消息')
    );
    check(
      '严格隔离：A 会话不含默认会话消息',
      !aMsgs.some(m => m.content === '默认会话新消息')
    );
    check('读取不存在的会话返回 null', sessions.getMessages('no-such-session') === null);
  }

  origLog('\nHTTP 接口（会话列表 / 新建 / 按会话读取）');
  {
    const noAuth = await req('/sessions', { token: null });
    check('GET /sessions 无 token 返回 401', noAuth.status === 401, `实际 ${noAuth.status}`);

    const list = await req('/sessions');
    check(
      'GET /sessions 返回会话列表',
      list.status === 200 && Array.isArray(list.json.sessions) && list.json.sessions.length === 2,
      JSON.stringify(list.json)
    );

    const created = await req('/sessions', { method: 'POST', body: { title: '会话B' } });
    sessionBId = created.json && created.json.session && created.json.session.id;
    check('POST /sessions 返回 201 且含 id', created.status === 201 && !!sessionBId, JSON.stringify(created.json));

    const one = await req(`/sessions/${sessionBId}`);
    check('GET /sessions/:id 返回会话元数据', one.status === 200 && one.json.session.title === '会话B');

    const missing = await req('/sessions/unknown-id');
    check('GET /sessions/:id 未知 id 返回 404', missing.status === 404, `实际 ${missing.status}`);

    const defHistory = await req('/history');
    check(
      'GET /history 默认落到 default 会话',
      defHistory.status === 200 &&
        defHistory.json.sessionId === sessions.DEFAULT_SESSION_ID &&
        defHistory.json.history.length === 4,
      JSON.stringify(defHistory.json)
    );

    const aHistory = await req(`/history?sessionId=${sessionAId}`);
    check(
      'GET /history?sessionId 按会话读取',
      aHistory.status === 200 &&
        aHistory.json.sessionId === sessionAId &&
        aHistory.json.history.length === 1 &&
        aHistory.json.history[0].content === 'A 的消息',
      JSON.stringify(aHistory.json)
    );

    const unknownHistory = await req('/history?sessionId=unknown-id');
    check('GET /history 未知会话返回 404', unknownHistory.status === 404, `实际 ${unknownHistory.status}`);

    const cleared = await req('/history/clear', { method: 'POST', body: { sessionId: sessionAId } });
    check('POST /history/clear 指定会话返回 200', cleared.status === 200, `实际 ${cleared.status}`);

    const aAfter = sessions.getMessages(sessionAId);
    const defAfter = sessions.getMessages(sessions.DEFAULT_SESSION_ID);
    check('清空只作用于目标会话', aAfter.length === 0 && defAfter.length === 4, `A=${aAfter.length}, default=${defAfter.length}`);
  }

  origLog('\n重启持久化（重新加载模块，等价重启进程）');
  {
    const sessionsPath = require.resolve(path.join(__dirname, '..', 'server', 'sessions.js'));
    delete require.cache[sessionsPath];
    const fresh = require(sessionsPath);

    const list = fresh.listSessions();
    check('重启后会话列表仍在（3 个）', list.length === 3, `实际 ${list.length}`);

    const defMsgs = fresh.getMessages(fresh.DEFAULT_SESSION_ID);
    check(
      '重启后默认会话消息持久化且未被重复导入',
      defMsgs.length === 4,
      `实际 ${defMsgs.length}`
    );

    const b = fresh.getSession(sessionBId);
    check('重启后 B 会话元数据仍在', !!b && b.title === '会话B');

    const backups = fs
      .readdirSync(TMP)
      .filter(name => name.startsWith('chat-history.json.pre-multisession.bak'));
    check('迁移只执行一次（备份文件仅 1 份）', backups.length === 1, backups.join(', '));

    check(
      '旧 chat-history.json 始终未被改写',
      fs.readFileSync(LEGACY_FILE, 'utf8') === legacyRawBefore
    );
  }

  origLog(`\n通过 ${passed} 项，失败 ${failed} 项`);
  if (failures.length) {
    origLog('\n失败明细：');
    failures.forEach(f => origLog('  - ' + f));
  }

  console.log = origLog;
  console.error = origErr;

  await closeHttpServer();

  try {
    fs.rmSync(TMP, { recursive: true, force: true });
  } catch (_) {
    /* 清理失败不影响结果 */
  }

  process.exit(failed === 0 ? 0 : 1);
})().catch(error => {
  console.log = origLog;
  console.error = origErr;
  origLog('测试执行异常：' + error.message);

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
    fs.rmSync(TMP, { recursive: true, force: true });
  } catch (_) {
    /* ignore */
  }

  process.exit(1);
});
