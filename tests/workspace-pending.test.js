/**
 * 工作区写入确认往返（任务书接法 a，2026-11-19）回归。
 *
 * 覆盖四层：
 *  ① workspace-pending 存储生命周期：create/get/consume/cancel、TTL 过期、
 *     会话与用户归属（forbidden 不伪装 404）、单会话 3 条 / 全局 20 条上限、
 *     损坏隔离（.corrupt-*）；
 *  ② executeConfirmedWrite 确认时重查沙箱（../ 逃逸 / 扩展名白名单在确认时
 *     依然拦截——防创建→确认之间目录状态变化）；
 *  ③ 真实 HTTP E2E：/chat 让模型发起 workspace_write → 响应 toolSteps 带
 *     pendingConfirmation、文件不落盘 → POST /workspace/pending/:id/confirm
 *     后文件出现 → 重复确认 404；reject 后文件不存在；跨会话确认 403；
 *     /history 里 pendingConfirmation 可读回（sanitizeToolSteps 白名单放行）；
 *  ④ 监控：pending 创建记 needs_confirmation；确认执行记 success 且
 *     confirmed=true；取消记 cancelled（正文永不进事件）。
 *
 * 测试只用临时目录（BLUEBIRD_DATA_DIR 指向 mkdtemp），不碰真实 server/data。
 */
const fs = require('fs');
const { applyStubKeepAlive } = require('./helpers/stub-keepalive');
const os = require('os');
const path = require('path');
const http = require('http');
const test = require('node:test');
const assert = require('node:assert');

const TMP_ROOT = fs.mkdtempSync(path.join(os.tmpdir(), 'bluebird-ws-pending-'));
const DATA_DIR = path.join(TMP_ROOT, 'data');
fs.mkdirSync(DATA_DIR, { recursive: true });

// ---- 环境隔离（必须在 require 任何服务端模块之前） ----
process.env.BLUEBIRD_DATA_DIR = DATA_DIR;
process.env.BLUEBIRD_API_TOKEN = 'test-ws-pending-token';
process.env.DEEPSEEK_API_KEY = ''; // 空串而非 delete：防 dotenv 回灌真实 key
process.env.PORT = '0';
process.env.BLUEBIRD_AGENT_TOOLS = '1';
process.env.BLUEBIRD_WORKSPACE_TOOLS = '1';
process.env.BLUEBIRD_MONITORING = '1';
process.env.BLUEBIRD_ALLOW_PRIVATE_BASE_URL = '1'; // 测试专用旁路：mock 服务商在 127.0.0.1

const SERVER = path.join(__dirname, '..', 'server');
const TOKEN = 'test-ws-pending-token';

const workspacePending = require('../server/workspace-pending');
const toolWorkspace = require('../server/tool-workspace');
const monitoring = require('../server/monitoring');

const STORE_FILE = path.join(DATA_DIR, 'workspace-pending.json');
const WS_ROOT = path.join(DATA_DIR, 'workspace');

function readStore() {
  return JSON.parse(fs.readFileSync(STORE_FILE, 'utf8')).pending;
}

function writeStore(list) {
  fs.writeFileSync(STORE_FILE, JSON.stringify({ schemaVersion: 1, pending: list }));
}

function readEvents() {
  // 事件落盘是异步队列 flush，测试断言必须走内存读（memory-observability 同款）
  return monitoring
    .getEvents({ from: 0, to: Date.now(), limit: 1000 })
    .items.filter(item => item.event_name === 'workspace.op.completed');
}

// ---- 服务启动 + mock 服务商（tools 能力模型；脚本化 OpenAI 形状响应） ----
const mockScript = [];
let mockIndex = 0;
const mockCalls = [];

const mockServer = http.createServer((req, res) => {
  let body = '';
  req.on('data', chunk => {
    body += chunk;
  });
  req.on('end', () => {
    mockCalls.push(body.slice(0, 400));
    const step = mockScript[mockIndex] || { content: '[calm] 默认回复' };
    mockIndex += 1;
    res.writeHead(200, { 'Content-Type': 'application/json' });
    if (step.toolCalls) {
      res.end(
        JSON.stringify({
          model: 'ws-tools',
          choices: [
            {
              message: {
                role: 'assistant',
                content: step.content ?? null,
                tool_calls: step.toolCalls,
              },
            },
          ],
        })
      );
      return;
    }
    res.end(
      JSON.stringify({
        model: 'ws-tools',
        choices: [{ message: { role: 'assistant', content: step.content ?? '[calm] 默认回复' } }],
      })
    );
  });
});

const { server: testServer } = require(path.join(SERVER, 'index.js'));
const configs = require(path.join(SERVER, 'api-configs.js'));

let PORT = 0;

async function req(route, options = {}) {
  const { method = 'GET', body, token = TOKEN } = options;
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

function tc(id, name, args) {
  return {
    id,
    type: 'function',
    function: { name, arguments: JSON.stringify(args) },
  };
}

test.before(async () => {
  applyStubKeepAlive(mockServer);
  await new Promise(resolve => mockServer.listen(0, '127.0.0.1', resolve));
  const MOCK_BASE = `http://127.0.0.1:${mockServer.address().port}`;
  globalThis.__wsProvider = configs.addModelProvider({
    name: 'Mock 工具服务商',
    baseUrl: MOCK_BASE,
    apiKey: 'mock-key',
    models: [{ id: 'ws-tools', capabilities: { tools: true } }],
  }).provider;
  if (!testServer.listening) {
    await new Promise(resolve => testServer.once('listening', resolve));
  }
  PORT = testServer.address().port;
});

test.after(async () => {
  try {
    if (typeof mockServer.closeAllConnections === 'function') mockServer.closeAllConnections();
  } catch (_) {}
  await new Promise(resolve => mockServer.close(() => resolve()));
  try {
    if (typeof testServer.closeAllConnections === 'function') testServer.closeAllConnections();
  } catch (_) {}
  await new Promise(resolve => testServer.close(() => resolve()));
  try {
    fs.rmSync(TMP_ROOT, { recursive: true, force: true });
  } catch (_) {}
});

// ================= ① 存储生命周期 =================

test('a. createPendingWrite：id 形状 / 归属 / 落盘', () => {
  const rec = workspacePending.createPendingWrite({
    sessionId: 's-unit',
    userId: 'local-owner',
    path: 'unit.md',
    mode: 'create',
    content: 'hello',
  });
  assert.match(rec.id, /^wsw_[0-9a-f]{24}$/);
  assert.equal(rec.sessionId, 's-unit');
  assert.equal(rec.bytes, 5);
  assert.ok(Date.parse(rec.expiresAt) > Date.now());
  assert.equal(fs.existsSync(STORE_FILE), true);
  assert.equal(readStore().some(item => item.id === rec.id), true);
});

test('b. 归属校验：跨会话 / 跨用户 → forbidden；同会话同用户 → ok', () => {
  const rec = workspacePending.createPendingWrite({
    sessionId: 's-owner',
    userId: 'user-1',
    path: 'own.md',
    mode: 'create',
    content: 'x',
  });
  assert.equal(
    workspacePending.getPendingWrite(rec.id, { sessionId: 'other', userId: 'user-1' }).status,
    'forbidden'
  );
  assert.equal(
    workspacePending.getPendingWrite(rec.id, { sessionId: 's-owner', userId: 'user-2' }).status,
    'forbidden'
  );
  assert.equal(
    workspacePending.getPendingWrite(rec.id, { sessionId: 's-owner', userId: 'user-1' }).status,
    'ok'
  );
});

test('c. consume / cancel：取走即删，二次读取 not_found', () => {
  const a = workspacePending.createPendingWrite({
    sessionId: 's-c',
    userId: null,
    path: 'a.md',
    mode: 'create',
    content: 'a',
  });
  assert.equal(workspacePending.consumePendingWrite(a.id, { sessionId: 's-c' }).status, 'ok');
  assert.equal(workspacePending.getPendingWrite(a.id, { sessionId: 's-c' }).status, 'not_found');

  const b = workspacePending.createPendingWrite({
    sessionId: 's-c',
    userId: null,
    path: 'b.md',
    mode: 'create',
    content: 'b',
  });
  assert.equal(workspacePending.cancelPendingWrite(b.id, { sessionId: 's-c' }).status, 'ok');
  assert.equal(workspacePending.getPendingWrite(b.id, { sessionId: 's-c' }).status, 'not_found');
});

test('d. TTL 过期：改写 expiresAt 后读取 → expired 且被清除', () => {
  const rec = workspacePending.createPendingWrite({
    sessionId: 's-exp',
    userId: null,
    path: 'exp.md',
    mode: 'create',
    content: 'e',
  });
  const list = readStore().map(item =>
    item.id === rec.id ? { ...item, expiresAt: new Date(Date.now() - 1000).toISOString() } : item
  );
  writeStore(list);
  assert.equal(workspacePending.getPendingWrite(rec.id, { sessionId: 's-exp' }).status, 'expired');
  assert.equal(readStore().some(item => item.id === rec.id), false, '过期记录必须被清除');
});

test('e. 单会话上限 3：第 4 条顶掉最旧', () => {
  const ids = [];
  for (let i = 0; i < 4; i += 1) {
    ids.push(
      workspacePending.createPendingWrite({
        sessionId: 's-cap',
        userId: null,
        path: `c${i}.md`,
        mode: 'create',
        content: `c${i}`,
      }).id
    );
  }
  const remaining = readStore().filter(item => item.sessionId === 's-cap');
  assert.equal(remaining.length, 3);
  assert.equal(remaining.some(item => item.id === ids[0]), false, '最旧被顶掉');
  assert.equal(remaining.some(item => item.id === ids[3]), true);
});

test('f. 全局上限 20：超限顶掉全局最旧', () => {
  const before = readStore();
  const oldestBeforeId = before.length ? before[0].id : null;
  const need = Math.max(0, 20 - before.length);
  // 每条用独立会话：避开单会话上限 3 的顶掉逻辑，专注验证全局上限
  for (let i = 0; i < need; i += 1) {
    workspacePending.createPendingWrite({
      sessionId: `s-glob-${i}`,
      userId: null,
      path: `g${i}.md`,
      mode: 'create',
      content: 'g',
    });
  }
  const extra = workspacePending.createPendingWrite({
    sessionId: 's-glob-extra',
    userId: null,
    path: 'g-extra.md',
    mode: 'create',
    content: 'g',
  });
  const after = readStore();
  assert.equal(after.length, 20, `全局应为 20 条，实际 ${after.length}`);
  assert.equal(after.some(item => item.id === extra.id), true);
  if (oldestBeforeId) {
    assert.equal(
      after.some(item => item.id === oldestBeforeId),
      false,
      '全局最旧被顶掉'
    );
  }
});

test('g. 损坏隔离：坏文件 → .corrupt-* 留证 + 按空库继续', () => {
  fs.writeFileSync(STORE_FILE, '{ this is not json');
  const rec = workspacePending.createPendingWrite({
    sessionId: 's-corrupt',
    userId: null,
    path: 'after-corrupt.md',
    mode: 'create',
    content: 'ok',
  });
  assert.equal(rec.id.startsWith('wsw_'), true);
  const quarantined = fs.readdirSync(DATA_DIR).some(name => name.startsWith('workspace-pending.json.corrupt-'));
  assert.equal(quarantined, true, '损坏文件必须改名留证');
});

test('h. 参数校验：非法 mode / 空路径 / 超 256KB → workspace_pending_invalid', () => {
  assert.throws(
    () =>
      workspacePending.createPendingWrite({
        sessionId: 's',
        userId: null,
        path: 'x.md',
        mode: 'delete',
        content: 'x',
      }),
    error => error.code === 'workspace_pending_invalid'
  );
  assert.throws(
    () =>
      workspacePending.createPendingWrite({
        sessionId: 's',
        userId: null,
        path: '',
        mode: 'create',
        content: 'x',
      }),
    error => error.code === 'workspace_pending_invalid'
  );
  assert.throws(
    () =>
      workspacePending.createPendingWrite({
        sessionId: 's',
        userId: null,
        path: 'big.md',
        mode: 'create',
        content: 'x'.repeat(256 * 1024 + 1),
      }),
    error => error.code === 'workspace_pending_invalid'
  );
});

// ================= ② 确认时重查沙箱 =================

test('i. 确认时重查：../ 逃逸与扩展名白名单在确认时依然拦截', async () => {
  const evil = workspacePending.createPendingWrite({
    sessionId: 's-recheck',
    userId: null,
    path: '../evil.md',
    mode: 'create',
    content: 'nope',
  });
  // executeWrite 对结构化失败是「返回」而非「抛出」（与工具层契约一致）
  const evilResult = await toolWorkspace.executeConfirmedWrite({
    path: evil.path,
    mode: evil.mode,
    content: evil.content,
  });
  assert.equal(evilResult.ok, false);
  assert.equal(evilResult.code, 'workspace_path_outside');
  assert.equal(fs.existsSync(path.join(DATA_DIR, 'evil.md')), false, '工作区外不得出现文件');

  const envLike = workspacePending.createPendingWrite({
    sessionId: 's-recheck',
    userId: null,
    path: 'secret.env',
    mode: 'create',
    content: 'KEY=1',
  });
  const envResult = await toolWorkspace.executeConfirmedWrite({
    path: envLike.path,
    mode: envLike.mode,
    content: envLike.content,
  });
  assert.equal(envResult.ok, false);
  assert.equal(envResult.code, 'workspace_extension_not_allowed');
});

test('j. 确认执行快乐路径：按原参数落盘 + 监控 confirmed=true', async () => {
  const rec = workspacePending.createPendingWrite({
    sessionId: 's-ok',
    userId: null,
    path: 'confirmed-ok.md',
    mode: 'create',
    content: '落盘内容-MARKER',
  });
  const result = await toolWorkspace.executeConfirmedWrite({
    path: rec.path,
    mode: rec.mode,
    content: rec.content,
  });
  assert.equal(result.ok, true);
  assert.equal(result.bytes, Buffer.byteLength('落盘内容-MARKER', 'utf8'));
  assert.equal(fs.readFileSync(path.join(WS_ROOT, 'confirmed-ok.md'), 'utf8'), '落盘内容-MARKER');

  const ops = readEvents().filter(
    item => item.event_name === 'workspace.op.completed' && item.attributes.tool === 'workspace_write'
  );
  const confirmedOp = ops.find(item => item.attributes.confirmed === true && item.status === 'success');
  assert.ok(confirmedOp, '必须有 confirmed=true 的成功写入事件');
  const serialized = JSON.stringify(ops);
  assert.equal(serialized.includes('落盘内容-MARKER'), false, '文件正文绝不进入监控');
});

// ================= ③ 真实 HTTP E2E =================

test('k. /chat 发起 workspace_write：pending 不落盘，toolSteps 带确认凭据', async () => {
  mockScript.length = 0;
  mockIndex = 0;
  mockScript.push({
    toolCalls: [tc('ws-call-1', 'workspace_write', { path: 'todo.md', content: '明天的事', mode: 'create' })],
  });
  mockScript.push({ content: '[calm] 已发起写入，请在下方确认。' });

  const chat = await req('/chat', {
    method: 'POST',
    body: {
      message: '在工作区建一个 todo.md，写明天要做的事',
      providerId: globalThis.__wsProvider.id,
      modelId: 'ws-tools',
    },
  });
  assert.equal(chat.status, 200, `chat 应 200：${chat.text.slice(0, 200)}`);
  const step = chat.json.toolSteps && chat.json.toolSteps[0];
  assert.ok(step, '响应必须带 toolSteps');
  assert.equal(step.name, 'workspace_write');
  assert.equal(step.pendingConfirmation && step.pendingConfirmation.path, 'todo.md');
  assert.match(step.pendingConfirmation.id, /^wsw_[0-9a-f]{24}$/);
  assert.equal(
    fs.existsSync(path.join(WS_ROOT, 'todo.md')),
    false,
    '确认前文件不得落盘'
  );
  globalThis.__wsPendingId = step.pendingConfirmation.id;
});

test('l. confirm 端点：确认后落盘 + 重复确认 404 + /history 可读回凭据', async () => {
  const id = globalThis.__wsPendingId;
  const confirmed = await req(`/workspace/pending/${id}/confirm`, {
    method: 'POST',
    body: { sessionId: 'default' },
  });
  assert.equal(confirmed.status, 200, `confirm 应 200：${confirmed.text.slice(0, 200)}`);
  assert.equal(confirmed.json.ok, true);
  assert.equal(
    fs.readFileSync(path.join(WS_ROOT, 'todo.md'), 'utf8'),
    '明天的事',
    '确认后必须按原参数落盘'
  );

  const again = await req(`/workspace/pending/${id}/confirm`, {
    method: 'POST',
    body: { sessionId: 'default' },
  });
  assert.equal(again.status, 404);
  assert.equal(again.json.code, 'workspace_pending_not_found');

  // 落盘链路：/history 里 pendingConfirmation 必须读得回（sanitizeToolSteps 放行）
  const history = await req('/history?sessionId=default');
  assert.equal(history.status, 200);
  const assistant = (history.json.history || [])
    .filter(m => m.role === 'assistant' && m.toolSteps && m.toolSteps.length)
    .pop();
  assert.ok(assistant, '历史里必须有带 toolSteps 的 assistant 消息');
  const histStep = assistant.toolSteps.find(
    s => s.pendingConfirmation && s.pendingConfirmation.id === id
  );
  assert.ok(histStep, 'pendingConfirmation 必须存得下、读得回');
  assert.equal(histStep.pendingConfirmation.path, 'todo.md');
});

test('m. reject 端点：取消后文件不存在 + 监控记 cancelled', async () => {
  mockScript.length = 0;
  mockIndex = 0;
  mockScript.push({
    toolCalls: [tc('ws-call-2', 'workspace_write', { path: 'dropped.md', content: '不要了', mode: 'create' })],
  });
  mockScript.push({ content: '[calm] 已取消。' });
  const chat = await req('/chat', {
    method: 'POST',
    body: {
      message: '再建一个 dropped.md',
      providerId: globalThis.__wsProvider.id,
      modelId: 'ws-tools',
    },
  });
  assert.equal(chat.status, 200);
  const id = chat.json.toolSteps[0].pendingConfirmation.id;

  const rejected = await req(`/workspace/pending/${id}/reject`, {
    method: 'POST',
    body: { sessionId: 'default' },
  });
  assert.equal(rejected.status, 200);
  assert.equal(rejected.json.cancelled, true);
  assert.equal(fs.existsSync(path.join(WS_ROOT, 'dropped.md')), false, '取消后不得落盘');

  const rejectedAgain = await req(`/workspace/pending/${id}/reject`, {
    method: 'POST',
    body: { sessionId: 'default' },
  });
  assert.equal(rejectedAgain.status, 404);

  const ops = readEvents().filter(item => item.attributes.tool === 'workspace_write');
  assert.ok(
    ops.some(item => item.status === 'cancelled' && item.attributes.code === 'workspace_write_rejected'),
    '取消必须记 cancelled 事件'
  );
});

test('n. 跨会话确认 → 403（不伪装成不存在）', async () => {
  const rec = workspacePending.createPendingWrite({
    sessionId: 's-other-session',
    userId: null,
    path: 'other.md',
    mode: 'create',
    content: 'x',
  });
  const res = await req(`/workspace/pending/${rec.id}/confirm`, {
    method: 'POST',
    body: { sessionId: 'default' },
  });
  assert.equal(res.status, 403);
  assert.equal(res.json.code, 'workspace_pending_forbidden');
});

test('o. 缺 sessionId → 400 bad_request（统一错误形状）', async () => {
  const res = await req('/workspace/pending/wsw_abcdefabcdefabcdefabcdef/confirm', {
    method: 'POST',
    body: {},
  });
  assert.equal(res.status, 400);
  assert.equal(res.json.code, 'bad_request');
});
