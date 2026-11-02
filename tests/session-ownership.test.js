/**
 * 云岫 Bluebird — 会话归属校验（多用户上线前的 P0 阻断项）
 *
 * 背景：会话本身没有归属维度时，`GET /history?sessionId=X` 等于「知道 id 就能读」。
 * 本测试用「种一个属于别的 userId 的会话」来证明：
 *   - 会话列表只列本人的；
 *   - 别人的会话 id 在单会话读取、历史、清空、撤回、presence、聊天、检索入口
 *     一律 404（不存在与无权同形，不泄露会话是否存在）；
 *   - 本人操作不受影响。
 *
 * 不需要多用户认证：`resolveUserId(req)` 在单实例下恒为 local-owner，
 * 只要种一条 userId=其他值的会话，就构造出「他人会话」。
 *
 * 运行：node tests/session-ownership.test.js
 */
const fs = require('fs');
const os = require('os');
const path = require('path');

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'bluebird-sess-own-'));
const DATA_DIR = path.join(TMP, 'data');
fs.mkdirSync(DATA_DIR, { recursive: true });

process.env.BLUEBIRD_DATA_DIR = DATA_DIR;
process.env.BLUEBIRD_API_TOKEN = 'test-token-sess-own';
process.env.DEEPSEEK_API_KEY = '';
process.env.PORT = '0';
process.env.BLUEBIRD_AGENT_TOOLS = '';
process.env.BLUEBIRD_MONITORING = '0';
process.env.BLUEBIRD_PROVIDER_KIND = 'stub';
process.env.BLUEBIRD_RETRIEVAL = '0';

const STORE_FILE = path.join(DATA_DIR, 'sessions.json');
const OTHER_USER = 'user-other-session';

const OWN_SESSION = 'sess-own-0001';
const FOREIGN_SESSION = 'sess-foreign-0001';
const OWN_SECRET = '本人会话内容：我在写周报';
const FOREIGN_SECRET = '他人会话内容：并购方案细节';

function iso(minutesAgo) {
  return new Date(Date.now() - minutesAgo * 60 * 1000).toISOString();
}

function message(id, role, content, minutesAgo) {
  return {
    id,
    role,
    content,
    createdAt: iso(minutesAgo),
  };
}

function seed() {
  const store = {
    version: 1,
    sessions: [
      // 本人会话：不写 userId → 读盘时补成实例用户（同时验证迁移）
      {
        id: OWN_SESSION,
        title: '本人会话',
        createdAt: iso(30),
        updatedAt: iso(10),
      },
      // 他人会话：显式 userId
      {
        id: FOREIGN_SESSION,
        title: '他人会话',
        userId: OTHER_USER,
        createdAt: iso(40),
        updatedAt: iso(20),
      },
    ],
    messages: {
      [OWN_SESSION]: [
        message('m-own-1', 'user', OWN_SECRET, 30),
        message('m-own-2', 'assistant', '收到', 29),
      ],
      [FOREIGN_SESSION]: [
        message('m-foreign-1', 'user', FOREIGN_SECRET, 40),
        message('m-foreign-2', 'assistant', '收到', 39),
      ],
    },
  };

  fs.writeFileSync(STORE_FILE, JSON.stringify(store, null, 2), 'utf8');
}

const origLog = console.log;
const origErr = console.error;

let passed = 0;
let failed = 0;
const failures = [];

function check(name, cond, extra = '') {
  if (cond) {
    passed += 1;
    origLog(`  ✔ ${name}`);
  } else {
    failed += 1;
    failures.push(name + (extra ? ` — ${extra}` : ''));
    origLog(`  ✖ ${name}${extra ? ` — ${extra}` : ''}`);
  }
}

function diskStore() {
  return JSON.parse(fs.readFileSync(STORE_FILE, 'utf8'));
}

let BASE = '';
const TOKEN = 'test-token-sess-own';

async function req(urlPath, { method = 'GET', body } = {}) {
  const res = await fetch(BASE + urlPath, {
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
    /* ignore */
  }

  return { status: res.status, json };
}

async function waitReady() {
  for (let i = 0; i < 100; i += 1) {
    try {
      const res = await fetch(BASE + '/');
      if (res.ok) return true;
    } catch (_) {
      /* 还没起来 */
    }
    await new Promise(resolve => setTimeout(resolve, 50));
  }
  return false;
}

async function main() {
  seed();

  console.log = () => {};
  console.error = () => {};

  const { server } = require(path.join(__dirname, '..', 'server', 'index.js'));

  if (!server.listening) {
    await new Promise(resolve => server.once('listening', resolve));
  }

  BASE = `http://127.0.0.1:${server.address().port}`;

  if (!(await waitReady())) {
    origErr('服务未能在 5 秒内启动');
    process.exit(1);
  }

  const sessions = require(path.join(__dirname, '..', 'server', 'sessions.js'));
  const { getInstanceUserId } = require(path.join(__dirname, '..', 'server', 'user-scope.js'));

  const INSTANCE = getInstanceUserId();

  origLog('\nA) 读接口：只返回本人会话');

  {
    const list = await req('/sessions');
    const items = (list.json && list.json.sessions) || [];
    const ids = items.map(item => item.id);

    check(
      'GET /sessions 只列本人会话',
      list.status === 200 && ids.includes(OWN_SESSION) && !ids.includes(FOREIGN_SESSION),
      JSON.stringify(ids)
    );
    check('GET /sessions 不泄露他人会话标题', !items.some(item => item.title === '他人会话'));
  }

  {
    const own = await req(`/sessions/${OWN_SESSION}`);
    const foreign = await req(`/sessions/${FOREIGN_SESSION}`);

    check('GET /sessions/:id 本人 → 200', own.status === 200 && own.json.session.id === OWN_SESSION);
    check(
      'GET /sessions/:id 他人 → 404（不泄露存在性）',
      foreign.status === 404,
      JSON.stringify(foreign.json)
    );
  }

  {
    const own = await req(`/history?sessionId=${OWN_SESSION}`);
    const foreign = await req(`/history?sessionId=${FOREIGN_SESSION}`);

    check('GET /history 本人 → 200 且含本人内容', own.status === 200);
    check(
      'GET /history 他人 → 404',
      foreign.status === 404,
      JSON.stringify(foreign.json)
    );
    check(
      '他人会话内容不出现在任何响应里',
      !JSON.stringify(own.json).includes(FOREIGN_SECRET)
    );
  }

  {
    const own = await req(`/presence?sessionId=${OWN_SESSION}`);
    const foreign = await req(`/presence?sessionId=${FOREIGN_SESSION}`);

    check('GET /presence 本人 → 200', own.status === 200);
    check('GET /presence 他人 → 404', foreign.status === 404);
  }

  origLog('\nB) 写接口：他人会话一律拒绝且数据不变');

  {
    const res = await req('/history/clear', {
      method: 'POST',
      body: { sessionId: FOREIGN_SESSION, confirm: true },
    });

    check(
      'POST /history/clear 他人会话 → 404',
      res.status === 404,
      JSON.stringify(res.json)
    );
    check(
      '他人会话消息未被清空',
      (diskStore().messages[FOREIGN_SESSION] || []).length === 2
    );
  }

  {
    const res = await req('/history/recall', {
      method: 'POST',
      body: { sessionId: FOREIGN_SESSION, messageId: 'm-foreign-1' },
    });

    check(
      'POST /history/recall 他人会话 → 404',
      res.status === 404,
      JSON.stringify(res.json)
    );
    check(
      '他人会话消息未被撤回',
      (diskStore().messages[FOREIGN_SESSION] || []).length === 2
    );
  }

  {
    const res = await req('/chat', {
      method: 'POST',
      body: { sessionId: FOREIGN_SESSION, message: 'hi' },
    });

    check(
      'POST /chat 他人会话 → 404',
      res.status === 404,
      JSON.stringify(res.json)
    );
  }

  {
    const res = await req('/chat/stream', {
      method: 'POST',
      body: { sessionId: FOREIGN_SESSION, message: 'hi' },
    });

    check('POST /chat/stream 他人会话 → 404', res.status === 404);
  }

  {
    const res = await req('/retrieval/search', {
      method: 'POST',
      body: { query: '并购', sessionId: FOREIGN_SESSION, sources: ['conversation'] },
    });

    check(
      'POST /retrieval/search 他人会话 → 404 session_missing',
      res.status === 404 && res.json && res.json.code === 'session_missing',
      JSON.stringify(res.json)
    );
  }

  {
    const before = diskStore().sessions.length;
    const res = await req(`/sessions/${FOREIGN_SESSION}`, { method: 'DELETE' });

    check(
      'DELETE /sessions/:id 他人会话 → 404',
      res.status === 404,
      JSON.stringify(res.json)
    );
    check(
      '他人会话未被删除',
      diskStore().sessions.length === before &&
        diskStore().sessions.some(item => item.id === FOREIGN_SESSION)
    );
  }

  origLog('\nC) 本人操作仍然正常（没有把功能锁死）');

  {
    const cleared = await req('/history/clear', {
      method: 'POST',
      body: { sessionId: OWN_SESSION, confirm: true },
    });

    check(
      'POST /history/clear 本人会话 → 200 且清空',
      cleared.status === 200 && (diskStore().messages[OWN_SESSION] || []).length === 0,
      JSON.stringify(cleared.json)
    );
  }

  {
    const created = await req('/sessions', {
      method: 'POST',
      body: { title: '新建会话' },
    });
    const createdId = created.json && created.json.session && created.json.session.id;

    check('POST /sessions 成功且返回 id', Boolean(createdId));

    const meta = diskStore().sessions.find(item => item.id === createdId);
    check(
      '新建会话带上归属用户',
      Boolean(meta) && meta.userId === INSTANCE,
      JSON.stringify(meta && meta.userId)
    );

    const removed = await req(`/sessions/${createdId}`, { method: 'DELETE' });
    check('DELETE 本人会话 → 200', removed.status === 200, JSON.stringify(removed.json));
  }

  origLog('\nD) 模块级契约');

  {
    check(
      'listSessions(本人) 只返回本人会话',
      !sessions.listSessions(INSTANCE).some(item => item.id === FOREIGN_SESSION)
    );
    check(
      'listSessions() 不传身份时保持旧行为（内部索引用）',
      sessions.listSessions().some(item => item.id === FOREIGN_SESSION)
    );
    check(
      'checkSessionOwnership 他人会话 → forbidden',
      sessions.checkSessionOwnership(FOREIGN_SESSION, INSTANCE).reason === 'forbidden'
    );
    check(
      'checkSessionOwnership 不存在 → not-found',
      sessions.checkSessionOwnership('sess-nope', INSTANCE).reason === 'not-found'
    );
    check(
      'checkSessionOwnership 本人会话 → ok',
      sessions.checkSessionOwnership(OWN_SESSION, INSTANCE).ok === true
    );
    check(
      '旧数据没有 userId 的会话迁移为实例用户',
      sessions.checkSessionOwnership(OWN_SESSION, INSTANCE).ok === true
    );
  }

  origLog(`\n通过 ${passed} 项，失败 ${failed} 项`);

  if (failures.length) {
    origLog('失败明细：');
    for (const item of failures) origLog(`  - ${item}`);
  }

  await new Promise(resolve => server.close(resolve));

  try {
    fs.rmSync(TMP, { recursive: true, force: true });
  } catch (_) {
    /* ignore */
  }

  process.exit(failed ? 1 : 0);
}

main().catch(error => {
  origErr('会话归属测试异常：', error && error.message ? error.message : error);
  try {
    fs.rmSync(TMP, { recursive: true, force: true });
  } catch (_) {
    /* ignore */
  }
  process.exit(1);
});
