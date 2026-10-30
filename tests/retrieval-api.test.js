/* global __dirname */
/**
 * 云岫 Bluebird — 统一检索 API 端到端测试（retrieval-api.test.js）
 *
 * 起真实 Express 服务（PORT=0，临时数据目录），验证：
 *   - Bearer 鉴权、405、参数错误；
 *   - 文档/代码/网页摄取 -> 查询 -> 删除；
 *   - 会话隔离与 trace 隐私；
 *   - 重建/一致性/状态接口。
 */
const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');
const test = require('node:test');
const assert = require('node:assert');

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'bluebird-retrieval-api-'));
const FIXTURE_ROOT = path.join(TMP, 'fixtures');
const REPO_ROOT = path.join(__dirname, '..');
fs.mkdirSync(path.join(FIXTURE_ROOT, 'docs'), { recursive: true });
fs.mkdirSync(path.join(FIXTURE_ROOT, 'code', 'src'), { recursive: true });
fs.writeFileSync(
  path.join(FIXTURE_ROOT, 'docs', 'handbook.md'),
  '# 部署手册\n\n生产部署前必须运行健康检查 HEALTH-CHECK-API-9911。\n',
  'utf8'
);
fs.writeFileSync(
  path.join(FIXTURE_ROOT, 'code', 'src', 'auth.ts'),
  'export function authenticateApiUser(token: string) {\n  return token === "E_API_401";\n}\n',
  'utf8'
);

process.env.BLUEBIRD_DATA_DIR = TMP;
process.env.BLUEBIRD_API_TOKEN = 'test-token-retrieval';
process.env.DEEPSEEK_API_KEY = '';
process.env.PORT = '0';
process.env.BLUEBIRD_AGENT_TOOLS = '';
process.env.BLUEBIRD_RETRIEVAL_ALLOW_PRIVATE_URL = '1';
process.env.BLUEBIRD_RETRIEVAL_ROOTS = [REPO_ROOT, FIXTURE_ROOT].join(path.delimiter);

const retrieval = require('../server/retrieval');
const { server } = require('../server/index');

let BASE = '';
const TOKEN = 'test-token-retrieval';
const webServer = http.createServer((req, res) => {
  res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
  res.end(
    '<html><head><title>API Web Guide</title></head><body>' +
      '<h1>网页知识</h1><p>网页部署检查项 WEB-CHECK-3322。</p></body></html>'
  );
});

async function waitReady() {
  for (let i = 0; i < 100; i += 1) {
    if (server.listening) {
      BASE = `http://127.0.0.1:${server.address().port}`;
      return;
    }
    await new Promise(resolve => setTimeout(resolve, 20));
  }
  throw new Error('server_not_ready');
}

async function req(pathname, { method = 'GET', token = TOKEN, body } = {}) {
  const response = await fetch(BASE + pathname, {
    method,
    headers: {
      'Content-Type': 'application/json',
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  let json = null;
  try {
    json = await response.json();
  } catch (_) {
    // non-JSON
  }
  return { status: response.status, json };
}

test.before(async () => {
  await new Promise(resolve => webServer.listen(0, '127.0.0.1', resolve));
  await waitReady();
});

test.after(async () => {
  await new Promise(resolve => server.close(resolve));
  await new Promise(resolve => webServer.close(resolve));
  try {
    fs.rmSync(TMP, { recursive: true, force: true });
  } catch (_) {
    // ignore
  }
});

test('鉴权与只读入口：无 token 401，状态接口可用', async () => {
  const unauth = await req('/retrieval/status', { token: '' });
  assert.equal(unauth.status, 401);

  const status = await req('/retrieval/status');
  assert.equal(status.status, 200);
  assert.equal(status.json.enabled, true);
  assert.ok(status.json.counts);
  assert.equal(status.json.counts.chunks, 0);
  assert.ok(status.json.capabilities);
  assert.equal(status.json.capabilities.scope.mode, 'single_user');
  assert.equal(status.json.capabilities.reranker, false);
  assert.equal(status.json.capabilities.signalRerank, true);
  assert.equal(status.json.vectorCoverage.current, false);
  assert.equal(status.json.vectorCoverage.total, 0);
  assert.equal(status.json.reranker.available, false);
  assert.equal(status.json.reranker.reason, 'not_configured');
});

test('查询参数错误：空 query、缺少 session、未知 session、非法来源', async () => {
  const empty = await req('/retrieval/search', {
    method: 'POST',
    body: { query: '', sources: ['document'] },
  });
  assert.equal(empty.status, 400);
  assert.equal(empty.json.code, 'query_required');

  const noSession = await req('/retrieval/search', {
    method: 'POST',
    body: { query: '咖啡', sources: ['memory'] },
  });
  assert.equal(noSession.status, 400);
  assert.equal(noSession.json.code, 'session_required');

  const unknown = await req('/retrieval/search', {
    method: 'POST',
    body: { query: '咖啡', sessionId: 'not-exist', sources: ['memory'] },
  });
  assert.equal(unknown.status, 404);

  const invalid = await req('/retrieval/search', {
    method: 'POST',
    body: { query: 'x', sources: ['bogus'] },
  });
  assert.equal(invalid.status, 400);
  assert.equal(invalid.json.code, 'invalid_source');
});

test('文档摄取 -> 查询 -> 来源列表/详情 -> 删除', async () => {
  const ingest = await req('/retrieval/ingest', {
    method: 'POST',
    body: { type: 'document', path: 'docs/handbook.md' },
  });
  assert.equal(ingest.status, 200);
  assert.equal(ingest.json.ok, true);
  assert.ok(ingest.json.chunks > 0);
  assert.equal(ingest.json.source.type, 'document');
  assert.ok(!JSON.stringify(ingest.json).includes('HEALTH-CHECK-API-9911'));

  const search = await req('/retrieval/search', {
    method: 'POST',
    body: {
      query: '生产部署健康检查 HEALTH-CHECK-API-9911',
      sources: ['document'],
      limit: 3,
    },
  });
  assert.equal(search.status, 200);
  assert.equal(search.json.status, 'success');
  assert.ok(search.json.evidence.length >= 1);
  assert.ok(search.json.citations.length >= 1);
  assert.ok(!JSON.stringify(search.json.trace).includes('HEALTH-CHECK-API-9911'));
  assert.ok(!JSON.stringify(search.json.trace).includes('生产部署健康检查'));

  const sources = await req('/retrieval/sources');
  assert.equal(sources.status, 200);
  assert.ok(sources.json.sources.some(source => source.type === 'document'));

  const sourceId = ingest.json.source.id;
  const detail = await req(`/retrieval/sources/${encodeURIComponent(sourceId)}`);
  assert.equal(detail.status, 200);
  assert.equal(detail.json.source.id, sourceId);
  assert.equal(detail.json.source.content, undefined);

  const removed = await req(`/retrieval/sources/${encodeURIComponent(sourceId)}`, {
    method: 'DELETE',
  });
  assert.equal(removed.status, 200);
  assert.equal(removed.json.ok, true);

  const after = await req('/retrieval/search', {
    method: 'POST',
    body: { query: 'HEALTH-CHECK-API-9911', sources: ['document'] },
  });
  assert.equal(after.status, 200);
  assert.equal(after.json.status, 'no_result');

  const again = await req(`/retrieval/sources/${encodeURIComponent(sourceId)}`, {
    method: 'DELETE',
  });
  assert.equal(again.status, 404);
});

test('摄取边界：PDF 明确不支持，路径越界拒绝', async () => {
  fs.writeFileSync(path.join(FIXTURE_ROOT, 'docs', 'bad.pdf'), '%PDF-1.4', 'utf8');
  const pdf = await req('/retrieval/ingest', {
    method: 'POST',
    body: { type: 'document', path: 'docs/bad.pdf' },
  });
  assert.equal(pdf.status, 400);
  assert.equal(pdf.json.code, 'unsupported_format');

  const outside = await req('/retrieval/ingest', {
    method: 'POST',
    body: { type: 'document', path: path.join(os.tmpdir(), 'outside-retrieval.txt') },
  });
  assert.equal(outside.status, 400);
  assert.equal(outside.json.code, 'path_outside_allowed_roots');
});

test('代码摄取：符号/路径可检索，且不返回源码正文', async () => {
  const ingest = await req('/retrieval/ingest', {
    method: 'POST',
    body: { type: 'code', path: 'code' },
  });
  assert.equal(ingest.status, 200);
  assert.equal(ingest.json.source.type, 'code');
  assert.ok(ingest.json.chunks >= 1);
  assert.ok(!JSON.stringify(ingest.json).includes('export function authenticateApiUser'));

  const search = await req('/retrieval/search', {
    method: 'POST',
    body: { query: 'authenticateApiUser E_API_401', sources: ['code'], limit: 3 },
  });
  assert.equal(search.status, 200);
  assert.equal(search.json.status, 'success');
  assert.equal(search.json.evidence[0].sourceType, 'code');
  assert.ok(search.json.evidence[0].locator.includes('src/auth.ts#L'));
});

test('网页摄取：快照/引用/删除清理，URL 敏感参数不回显', async () => {
  const port = webServer.address().port;
  const ingest = await req('/retrieval/ingest', {
    method: 'POST',
    body: { type: 'web', url: `http://127.0.0.1:${port}/guide?token=WEB-SECRET` },
  });
  assert.equal(ingest.status, 200);
  assert.equal(ingest.json.source.type, 'web');
  assert.ok(!JSON.stringify(ingest.json).includes('WEB-SECRET'));
  const snapshot = path.join(
    retrieval.store.snapshotsDir,
    ingest.json.source.metadata.snapshotFile
  );
  assert.ok(fs.existsSync(snapshot));

  const search = await req('/retrieval/search', {
    method: 'POST',
    body: { query: 'WEB-CHECK-3322', sources: ['web'], limit: 3 },
  });
  assert.equal(search.status, 200);
  assert.equal(search.json.status, 'success');
  assert.equal(search.json.evidence[0].sourceType, 'web');

  const removed = await req(`/retrieval/sources/${encodeURIComponent(ingest.json.source.id)}`, {
    method: 'DELETE',
  });
  assert.equal(removed.status, 200);
  assert.equal(fs.existsSync(snapshot), false);
});

test('会话隔离：记忆检索只返回本会话，未知来源组合不绕门控', async () => {
  const created = await req('/sessions', {
    method: 'POST',
    body: { title: '检索 API 会话' },
  });
  assert.ok(created.status === 200 || created.status === 201);
  const sessionId = created.json.id || (created.json.session && created.json.session.id);
  assert.ok(sessionId);

  const search = await req('/retrieval/search', {
    method: 'POST',
    body: { query: '咖啡', sessionId, sources: ['memory', 'conversation'] },
  });
  assert.equal(search.status, 200);
  assert.equal(search.json.status, 'no_result');
  assert.equal(search.json.evidence.length, 0);
});

test('外部同步 API：文件删除后移除派生来源，网页刷新必须重新提供 URL', async () => {
  const file = path.join(FIXTURE_ROOT, 'docs', 'refresh-api.md');
  fs.writeFileSync(file, '# 同步\n\nSYNC-API-111 旧内容\n', 'utf8');
  const ingest = await req('/retrieval/ingest', {
    method: 'POST',
    body: { type: 'document', path: 'docs/refresh-api.md' },
  });
  assert.equal(ingest.status, 200);
  fs.unlinkSync(file);
  const synced = await req('/retrieval/sync', {
    method: 'POST',
    body: { sourceId: ingest.json.source.id },
  });
  assert.equal(synced.status, 200);
  assert.equal(synced.json.ok, true);
  assert.equal(synced.json.action, 'deleted');
  const after = await req('/retrieval/search', {
    method: 'POST',
    body: { query: 'SYNC-API-111', sources: ['document'] },
  });
  assert.equal(after.status, 200);
  assert.equal(after.json.status, 'no_result');

  const webIngest = await req('/retrieval/ingest', {
    method: 'POST',
    body: { type: 'web', url: `http://127.0.0.1:${webServer.address().port}/sync` },
  });
  assert.equal(webIngest.status, 200);
  const noUrl = await req('/retrieval/sync', {
    method: 'POST',
    body: { sourceId: webIngest.json.source.id },
  });
  assert.equal(noUrl.status, 400);
  assert.equal(noUrl.json.code, 'refresh_url_required');
  await req(`/retrieval/sources/${encodeURIComponent(webIngest.json.source.id)}`, {
    method: 'DELETE',
  });
});

test('重建与一致性：重建不改变索引语义，一致性接口可用', async () => {
  const rebuild = await req('/retrieval/rebuild', {
    method: 'POST',
    body: { syncSources: true, vectors: false },
  });
  assert.equal(rebuild.status, 200);
  assert.equal(rebuild.json.ok, true);
  assert.equal(rebuild.json.status, 'success');

  const consistency = await req('/retrieval/consistency');
  assert.equal(consistency.status, 200);
  assert.equal(consistency.json.ok, true);
  assert.ok(Array.isArray(consistency.json.issues));
});

test('向量回填入口：未鉴权 401，未配置 Embedding 时明确 409', async () => {
  const unauth = await req('/retrieval/vectors/backfill', {
    method: 'POST',
    token: '',
  });
  assert.equal(unauth.status, 401);

  const unavailable = await req('/retrieval/vectors/backfill', { method: 'POST' });
  assert.equal(unavailable.status, 409);
  assert.equal(unavailable.json.ok, false);
  assert.equal(unavailable.json.status, 'unavailable');
  assert.equal(unavailable.json.reason, 'not_configured');
});

test('方法约束：POST /retrieval/status 返回 405', async () => {
  const response = await req('/retrieval/status', { method: 'POST', body: {} });
  assert.equal(response.status, 405);
});
