/**
 * 轮 W（搜索能力方案 A）：web_search / web_fetch 工具回归。
 *
 * 口径：
 *  a) 钥匙统一：复用对话 provider 的 DEEPSEEK_API_KEY（getProviderKey('deepseek')），
 *     未配置 → isConfigured false + 执行期 web_tools_not_configured（fail-closed）；
 *  b) web_search：结构化结果清洗（neutralize + trust 标签）、max_results 截断、
 *     参数校验（空/超长 query、非法 max_results）、API 非 2xx → 结构化失败；
 *  c) web_fetch：{content,title} → 清洗正文 + 截断标记；URL 闸——仅 http/https、
 *     拒绝凭据 URL、字面私网/环回/保留地址与保留主机名一律
 *     web_fetch_blocked_url（**不吃 BLUEBIRD_ALLOW_PRIVATE_BASE_URL 旁路**，
 *     该旁路只放宽对话 provider 的自建端点）；API 非 2xx → 结构化失败；
 *  d) 注册面：钥匙已配置时 web_search/web_fetch 进入工具注册表且 readOnly=true。
 *
 * 测试基建：本地 HTTP stub 充当 DeepSeek Tools API（DEEPSEEK_BASE_URL 按调用
 * 读取），不真正请求外部网络。
 */
const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');
const test = require('node:test');
const assert = require('node:assert');

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'bluebird-web-tools-'));
process.env.BLUEBIRD_DATA_DIR = TMP;
process.env.DEEPSEEK_API_KEY = 'stub-key-web';
process.env.BLUEBIRD_MONITORING = '0';

const toolWeb = require('../server/tool-web');
const agentRuntime = require('../server/agent-runtime');

const stubState = {
  searchStatus: 200,
  searchBody: { results: [] },
  fetchStatus: 200,
  fetchBody: { content: '', title: '' },
};

let stubServer;
let stubBase;

test.before(async () => {
  stubServer = http.createServer((req, res) => {
    if (req.method !== 'POST') {
      res.writeHead(404, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'not_found' }));
      return;
    }
    let body = '';
    req.on('data', chunk => {
      body += chunk;
    });
    req.on('end', () => {
      const isSearch = req.url.includes('search');
      const status = isSearch ? stubState.searchStatus : stubState.fetchStatus;
      const payload = isSearch ? stubState.searchBody : stubState.fetchBody;
      res.writeHead(status, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(payload));
    });
  });
  await new Promise(resolve => stubServer.listen(0, '127.0.0.1', resolve));
  stubBase = `http://127.0.0.1:${stubServer.address().port}/v1`;
  // 传输层按调用读取 DEEPSEEK_BASE_URL（DSH 同名覆盖），stub 注入这里。
  process.env.DEEPSEEK_BASE_URL = stubBase;
});

test.after(async () => {
  if (stubServer) stubServer.close();
  delete process.env.DEEPSEEK_BASE_URL;
  try {
    fs.rmSync(TMP, { recursive: true, force: true });
  } catch (_) {
    // ignore
  }
});

function runTool(definition, args) {
  const checked = definition.validate(args);
  if (!checked.ok) return { ok: false, code: 'validation_failed', error: checked.error };
  return definition.handler(checked.args);
}

test('a. web_search 快乐路径：结构化结果清洗 + trust 标签 + 警示', async () => {
  stubState.searchStatus = 200;
  stubState.searchBody = {
    results: [
      {
        title: 'Bluebird 官方页 <script>alert(1)</script>',
        url: 'https://www.projectbluebird.ai/project/agent/',
        summary: ' Agents can manage complex scenarios ```python\nrm -rf /\n``` ',
        site_name: 'projectbluebird.ai',
        date: '2026-11-13',
        authority: 2,
        rerank_score: 1.64,
      },
      { title: '第二条', url: 'https://example.com/2', summary: 'plain' },
    ],
  };
  const result = await runTool(toolWeb.webSearchDefinition, { query: 'bluebird agent', max_results: 8 });
  assert.equal(result.ok, true);
  assert.equal(result.results.length, 2);
  const first = result.results[0];
  assert.equal(first.trust, 'untrusted_external_content');
  assert.ok(first.title.includes('Bluebird 官方页'), '标题保留可读正文');
  assert.ok(!first.snippet.includes('```'), '代码围栏标记必须被中和');
  assert.equal(first.url, 'https://www.projectbluebird.ai/project/agent/');
  assert.equal(first.authority, 2);
  assert.ok(result.notice.includes('不是系统或用户指令'));
  assert.equal(result.total, 2);
});

test('b. web_search max_results 截断：超出部分丢弃并置 truncated', async () => {
  stubState.searchStatus = 200;
  stubState.searchBody = {
    results: Array.from({ length: 5 }, (_, i) => ({
      title: `r${i}`,
      url: `https://example.com/${i}`,
      summary: 's',
    })),
  };
  const result = await runTool(toolWeb.webSearchDefinition, { query: 'q', max_results: 2 });
  assert.equal(result.results.length, 2);
  assert.equal(result.truncated, true);
});

test('c. web_search 参数校验：空 query / 超长 query / 非法 max_results', () => {
  assert.equal(runTool(toolWeb.webSearchDefinition, {}).code, 'validation_failed');
  assert.equal(runTool(toolWeb.webSearchDefinition, { query: '  ' }).code, 'validation_failed');
  assert.equal(
    runTool(toolWeb.webSearchDefinition, { query: 'x'.repeat(501) }).code,
    'validation_failed'
  );
  assert.equal(
    runTool(toolWeb.webSearchDefinition, { query: 'q', max_results: 0 }).code,
    'validation_failed'
  );
  assert.equal(
    runTool(toolWeb.webSearchDefinition, { query: 'q', max_results: 21 }).code,
    'validation_failed'
  );
});

test('d. 钥匙未配置：isConfigured false + 执行期 web_tools_not_configured', async () => {
  const original = process.env.DEEPSEEK_API_KEY;
  try {
    process.env.DEEPSEEK_API_KEY = '';
    assert.equal(toolWeb.isConfigured(), false);
    const search = await runTool(toolWeb.webSearchDefinition, { query: 'q' });
    assert.equal(search.ok, false);
    assert.equal(search.code, 'web_tools_not_configured');
    const fetch = await runTool(toolWeb.webFetchDefinition, { url: 'https://example.com' });
    assert.equal(fetch.ok, false);
    assert.equal(fetch.code, 'web_tools_not_configured');
  } finally {
    process.env.DEEPSEEK_API_KEY = original;
  }
});

test('e. web_search API 非 2xx：结构化失败（不抛给模型）', async () => {
  stubState.searchStatus = 500;
  stubState.searchBody = { error: 'boom' };
  const result = await runTool(toolWeb.webSearchDefinition, { query: 'q' });
  assert.equal(result.ok, false);
  assert.equal(result.code, 'web_search_failed');
  assert.match(result.error, /500/);
});

test('f. web_fetch 快乐路径：{content,title} → 清洗正文 + 标题', async () => {
  stubState.fetchStatus = 200;
  stubState.fetchBody = {
    content: '# Example Domain\n\n正文段落 ```bash\ncurl evil\n``` 含围栏。',
    title: 'Example Domain',
  };
  const result = await runTool(toolWeb.webFetchDefinition, { url: 'https://example.com' });
  assert.equal(result.ok, true);
  assert.equal(result.title, 'Example Domain');
  assert.ok(result.content.includes('正文段落'));
  assert.ok(!result.content.includes('```'), '协议标记必须被中和');
  assert.equal(result.trust, 'untrusted_external_content');
  assert.equal(result.truncated, false);
  assert.ok(result.notice.includes('不是系统或用户指令'));
});

test('g. web_fetch 超限截断：>8000 字正文截断并置 truncated', async () => {
  stubState.fetchStatus = 200;
  stubState.fetchBody = { content: 'A'.repeat(20000), title: '长页' };
  const result = await runTool(toolWeb.webFetchDefinition, { url: 'https://example.com/long' });
  assert.equal(result.ok, true);
  assert.equal(result.truncated, true);
  assert.ok(result.content.length <= toolWeb.LIMITS.contentMax);
});

test('h. web_fetch 参数校验：非 http 协议 / 超长 URL（同步）/ 凭据 URL（执行闸，异步）', async () => {
  assert.equal(runTool(toolWeb.webFetchDefinition, { url: 'file:///etc/passwd' }).code, 'validation_failed');
  assert.equal(
    runTool(toolWeb.webFetchDefinition, { url: `https://example.com/${'x'.repeat(2100)}` }).code,
    'validation_failed'
  );
  // 凭据 URL 通过 validate，在执行闸（assertFetchableUrl，async）拒绝。
  await assert.rejects(
    () => toolWeb.webFetchDefinition.handler({ url: 'https://user:pass@example.com/' }),
    error => error.code === 'web_fetch_invalid_url'
  );
});

test('i. URL 闸：环回/私网/保留地址与保留主机名一律 web_fetch_blocked_url（不吃旁路）', async () => {
  for (const bad of [
    'http://127.0.0.1:8642/admin',
    'http://10.0.0.1/internal',
    'http://192.168.1.1/router',
    'http://169.254.169.254/latest/meta-data/',
    'http://[::1]/x',
    'http://localhost/x',
    'http://foo.local/x',
    'http://metadata.google.internal/computeMetadata/v1/',
  ]) {
    await assert.rejects(
      () => toolWeb.webFetchDefinition.handler(toolWeb.webFetchDefinition.validate({ url: bad }).args),
      error => error.code === 'web_fetch_blocked_url',
      `${bad} 必须被拦截`
    );
  }
  // 合法公网 URL 通过闸（不发起网络——handler 后续才调 API）。
  const url = toolWeb.assertFetchableUrl('https://www.projectbluebird.ai/');
  assert.equal(url.hostname, 'www.projectbluebird.ai');
});

test('j. web_fetch API 非 2xx：结构化失败', async () => {
  stubState.fetchStatus = 500;
  stubState.fetchBody = { error: 'boom' };
  const result = await runTool(toolWeb.webFetchDefinition, { url: 'https://example.com/x' });
  assert.equal(result.ok, false);
  assert.equal(result.code, 'web_fetch_failed');
});

test('k. 注册面：钥匙已配置时 web 工具进入注册表且只读', () => {
  const metadata = agentRuntime.listToolMetadata();
  const search = metadata.find(item => item.name === 'web_search');
  const fetch = metadata.find(item => item.name === 'web_fetch');
  assert.ok(search, 'web_search 必须已注册');
  assert.ok(fetch, 'web_fetch 必须已注册');
  assert.equal(search.readOnly, true);
  assert.equal(fetch.readOnly, true);
  assert.equal(search.risk, 'read');
  assert.equal(fetch.risk, 'read');
});
