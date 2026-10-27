/**
 * 删除语义交叉验证（只验证，不改生产代码）
 *
 * 分别验证四条删除路径对四类数据的影响：
 *   会话元信息 / 消息 / 长期记忆 / 上传附件
 *
 * 覆盖：
 * - DELETE /sessions/:id
 * - POST /history/clear
 * - POST /memory/delete
 * - POST /memory/clear-session
 *
 * 运行：node tests/delete-semantics.test.js
 */
const fs = require('fs');
const os = require('os');
const path = require('path');

const TMP_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'bluebird-delete-semantics-'));
process.env.BLUEBIRD_DATA_DIR = TMP_DATA_DIR;
process.env.PORT = '0';
process.env.BLUEBIRD_API_TOKEN = 'test-token-delete-semantics';
process.env.DEEPSEEK_API_KEY = '';

const MEMORY_FILE = path.join(TMP_DATA_DIR, 'memory.json');
const PNG_B64 =
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==';
const PNG_BUF = Buffer.from(PNG_B64, 'base64');

const origLog = console.log;
const origErr = console.error;
console.log = () => {};
console.error = () => {};

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

let BASE = '';
const TOKEN = 'test-token-delete-semantics';

async function req(urlPath, { method = 'GET', token = TOKEN, body } = {}) {
  const res = await fetch(BASE + urlPath, {
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

function dataUrl() {
  return `data:image/png;base64,${PNG_B64}`;
}

function seedMemory(items) {
  fs.writeFileSync(MEMORY_FILE, JSON.stringify(items, null, 2), 'utf8');
}

function diskMemory() {
  return JSON.parse(fs.readFileSync(MEMORY_FILE, 'utf8'));
}

function contributionsOf(item) {
  return (item.contributions || []).map(entry => entry.sessionId);
}

function findMemory(content) {
  return diskMemory().find(item => item.content === content) || null;
}

async function waitReady() {
  for (let attempt = 0; attempt < 100; attempt += 1) {
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

(async () => {
  // 先建立空记忆库，服务 require 时会加载它。
  seedMemory([]);

  const { server } = require(path.join(__dirname, '..', 'server', 'index.js'));

  if (!server.listening) {
    await new Promise(resolve => server.once('listening', resolve));
  }

  BASE = `http://127.0.0.1:${server.address().port}`;

  if (!(await waitReady())) {
    throw new Error('服务未能在 5 秒内启动');
  }

  const sessions = require(path.join(__dirname, '..', 'server', 'sessions.js'));
  const memory = require(path.join(__dirname, '..', 'server', 'memory.js'));

  const a1 = sessions.createSession({ title: '删除会话 A1' }).id;
  const b1 = sessions.createSession({ title: '删除会话 B1' }).id;
  const a2 = sessions.createSession({ title: '清空历史 A2' }).id;
  const b2 = sessions.createSession({ title: '清空历史 B2' }).id;
  const a3 = sessions.createSession({ title: '删除记忆 A3' }).id;
  const a4 = sessions.createSession({ title: '清空会话记忆 A4' }).id;
  const b4 = sessions.createSession({ title: '清空会话记忆 B4' }).id;

  const uploads = {};

  async function upload(name) {
    const res = await req('/uploads/image', {
      method: 'POST',
      body: { image: dataUrl(), kind: 'image', name },
    });

    check(`上传 ${name} 成功`, res.status === 200 && res.json && res.json.id);
    return res.json.id;
  }

  uploads.sessionOnly = await upload('session-only.png');
  uploads.clearShared = await upload('clear-shared.png');
  uploads.clearOnly = await upload('clear-only.png');
  uploads.memoryOnly = await upload('memory-only.png');
  uploads.clearSession = await upload('clear-session.png');

  function appendWithImage(sessionId, messageId, text, imageId) {
    return sessions.appendMessages(sessionId, [
      {
        id: messageId,
        role: 'user',
        content: text,
        createdAt: '2026-10-20T08:00:00.000Z',
        attachments: [{ id: imageId, kind: 'image', mime: 'image/png' }],
      },
    ]);
  }

  appendWithImage(a1, 'm-a1', 'A1 的消息', uploads.sessionOnly);
  appendWithImage(a2, 'm-a2', 'A2 的消息', uploads.clearShared);
  appendWithImage(a2, 'm-a2b', 'A2 的第二条消息', uploads.clearOnly);
  appendWithImage(b2, 'm-b2', 'B2 的消息', uploads.clearShared);
  appendWithImage(a3, 'm-a3', 'A3 的消息', uploads.memoryOnly);
  appendWithImage(a4, 'm-a4', 'A4 的消息', uploads.clearSession);

  const now = '2026-10-20T08:00:00.000Z';

  seedMemory([
    {
      content: 'A1 会话删除前的记忆',
      type: 'fact',
      keywords: ['A1'],
      confidence: 0.95,
      contributions: [{ sessionId: a1, sourceQuote: 'A1 会话删除前的记忆', createdAt: now }],
      createdAt: now,
      updatedAt: now,
    },
    {
      content: 'A1/B1 共享记忆',
      type: 'fact',
      keywords: ['共享'],
      confidence: 0.95,
      contributions: [
        { sessionId: a1, sourceQuote: 'A1/B1 共享记忆', createdAt: now },
        { sessionId: b1, sourceQuote: 'A1/B1 共享记忆', createdAt: now },
      ],
      createdAt: now,
      updatedAt: now,
    },
    {
      content: 'A2 清空历史前的记忆',
      type: 'fact',
      keywords: ['A2'],
      confidence: 0.95,
      contributions: [{ sessionId: a2, sourceQuote: 'A2 清空历史前的记忆', createdAt: now }],
      createdAt: now,
      updatedAt: now,
    },
    {
      content: 'B2 清空历史前的记忆',
      type: 'fact',
      keywords: ['B2'],
      confidence: 0.95,
      contributions: [{ sessionId: b2, sourceQuote: 'B2 清空历史前的记忆', createdAt: now }],
      createdAt: now,
      updatedAt: now,
    },
    {
      content: 'A3 待删除记忆',
      type: 'fact',
      keywords: ['A3'],
      confidence: 0.95,
      contributions: [{ sessionId: a3, sourceQuote: 'A3 待删除记忆', createdAt: now }],
      createdAt: now,
      updatedAt: now,
    },
    {
      content: 'A4 清空会话记忆',
      type: 'fact',
      keywords: ['A4'],
      confidence: 0.95,
      contributions: [{ sessionId: a4, sourceQuote: 'A4 清空会话记忆', createdAt: now }],
      createdAt: now,
      updatedAt: now,
    },
    {
      content: 'A4/B4 共享记忆',
      type: 'fact',
      keywords: ['共享'],
      confidence: 0.95,
      contributions: [
        { sessionId: a4, sourceQuote: 'A4/B4 共享记忆', createdAt: now },
        { sessionId: b4, sourceQuote: 'A4/B4 共享记忆', createdAt: now },
      ],
      createdAt: now,
      updatedAt: now,
    },
    {
      content: 'B4 独有记忆',
      type: 'fact',
      keywords: ['B4'],
      confidence: 0.95,
      contributions: [{ sessionId: b4, sourceQuote: 'B4 独有记忆', createdAt: now }],
      createdAt: now,
      updatedAt: now,
    },
  ]);
  memory.loadMemories();

  origLog('\n0) 基线');
  {
    const before = diskMemory();
    check('基线：8 条记忆', before.length === 8, `实际 ${before.length}`);
    check('基线：A1 消息存在', (await req(`/history?sessionId=${a1}`)).json.history.length === 1);
    check('基线：附件存在', (await req(`/uploads/image/${uploads.sessionOnly}`)).status === 200);
  }

  origLog('\n1) DELETE /sessions/:id');
  {
    const res = await req(`/sessions/${a1}`, { method: 'DELETE' });

    check('返回 200 ok', res.status === 200 && res.json.ok === true, JSON.stringify(res.json));
    check('会话元信息已删除', (await req(`/sessions/${a1}`)).status === 404);
    check('会话消息已删除', (await req(`/history?sessionId=${a1}`)).status === 404);

    const after = diskMemory();
    const own = after.find(item => item.content === 'A1 会话删除前的记忆');
    const shared = after.find(item => item.content === 'A1/B1 共享记忆');

    check(
      '记忆不级联：A1 的条目仍在，贡献仍挂 a1',
      own && contributionsOf(own).includes(a1),
      JSON.stringify(own)
    );
    check(
      '记忆不级联：共享条目仍保留双方贡献',
      shared && contributionsOf(shared).includes(a1) && contributionsOf(shared).includes(b1),
      JSON.stringify(shared && contributionsOf(shared))
    );
    check(
      '附件不回收：仅被已删会话引用的图片仍存在',
      (await req(`/uploads/image/${uploads.sessionOnly}`)).status === 200
    );
    check('其他会话元信息仍在', (await req(`/sessions/${b1}`)).status === 200);
  }

  origLog('\n2) POST /history/clear');
  {
    const res = await req('/history/clear', {
      method: 'POST',
      body: { sessionId: a2 },
    });

    check('返回 200 ok', res.status === 200 && res.json.ok === true, JSON.stringify(res.json));
    check('会话元信息保留', (await req(`/sessions/${a2}`)).status === 200);
    check('目标会话消息清空', (await req(`/history?sessionId=${a2}`)).json.history.length === 0);
    check('其他会话消息不受影响', (await req(`/history?sessionId=${b2}`)).json.history.length === 1);

    const after = diskMemory();
    check(
      '记忆不级联：A2 条目仍在',
      after.some(item => item.content === 'A2 清空历史前的记忆' && contributionsOf(item).includes(a2))
    );
    check(
      '共享附件保留（B2 仍引用）',
      (await req(`/uploads/image/${uploads.clearShared}`)).status === 200
    );
    check(
      '仅被 A2 引用的附件被回收',
      (await req(`/uploads/image/${uploads.clearOnly}`)).status === 404
    );
  }

  origLog('\n3) POST /memory/delete');
  {
    const list = (await req('/memory')).json.memories;
    const target = list.find(item => item.content === 'A3 待删除记忆');
    const res = await req('/memory/delete', {
      method: 'POST',
      body: { id: target.id },
    });

    check('返回 200 且 removed=1', res.status === 200 && res.json.removed === 1, JSON.stringify(res.json));
    check('记忆已从磁盘移除', !findMemory('A3 待删除记忆'));
    check('会话元信息保留', (await req(`/sessions/${a3}`)).status === 200);
    check('消息保留', (await req(`/history?sessionId=${a3}`)).json.history.length === 1);
    check(
      '附件保留',
      (await req(`/uploads/image/${uploads.memoryOnly}`)).status === 200
    );
  }

  origLog('\n4) POST /memory/clear-session');
  {
    const res = await req('/memory/clear-session', {
      method: 'POST',
      body: { sessionId: a4 },
    });

    check(
      '返回 200，删除 1 条、摘掉 2 条贡献',
      res.status === 200 &&
        res.json.removedEntries === 1 &&
        res.json.removedContributions === 2,
      JSON.stringify(res.json)
    );

    const after = diskMemory();
    const own = after.find(item => item.content === 'A4 清空会话记忆');
    const shared = after.find(item => item.content === 'A4/B4 共享记忆');
    const other = after.find(item => item.content === 'B4 独有记忆');

    check('A4 独有条目已删除', !own);
    check(
      '共享条目保留，仅剩 B4 贡献',
      shared &&
        JSON.stringify(contributionsOf(shared)) === JSON.stringify([b4]),
      JSON.stringify(shared && contributionsOf(shared))
    );
    check('B4 独有条目仍在', Boolean(other));
    check('会话元信息保留', (await req(`/sessions/${a4}`)).status === 200);
    check('消息保留', (await req(`/history?sessionId=${a4}`)).json.history.length === 1);
    check(
      '附件保留（记忆清理不回收图片）',
      (await req(`/uploads/image/${uploads.clearSession}`)).status === 200
    );
  }

  origLog(`\n通过 ${passed} 项，失败 ${failed} 项`);

  try {
    fs.rmSync(TMP_DATA_DIR, { recursive: true, force: true });
  } catch (_) {
    /* ignore */
  }

  server.close();
  console.log = origLog;
  console.error = origErr;

  if (failures.length) {
    origLog(`失败明细：\n  ${failures.join('\n  ')}`);
    process.exit(1);
  }

  process.exit(0);
})().catch(error => {
  console.log = origLog;
  console.error = origErr;
  origLog('测试运行异常：', error && error.stack ? error.stack : error);
  process.exit(1);
});
