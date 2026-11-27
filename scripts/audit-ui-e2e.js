#!/usr/bin/env node
/* global __dirname */
/**
 * W6-5 真实 UI 一致性 E2E（手动）。
 *
 * 覆盖：创建 → 确认 → 读回 → 刷新历史，并校验 Expo Web 产物确实包含
 * “无回执”提示与回执状态展示。默认不跑；必须显式 --run。
 *
 * 用法：
 *   node scripts/audit-ui-e2e.js --run --out ../audit/evidence/ui-e2e.json
 *   npm run audit:ui -- --run
 */
const fs = require('fs');
const os = require('os');
const path = require('path');
const net = require('net');
const crypto = require('crypto');
const { spawn } = require('child_process');

const ROOT = path.join(__dirname, '..');
const SERVER = path.join(ROOT, 'server', 'index.js');
const args = process.argv.slice(2);
const hasRun = args.includes('--run');
const envFile = args.includes('--env-file') ? args[args.indexOf('--env-file') + 1] : path.join(ROOT, 'server', '.env');
const outFile = args.includes('--out') ? args[args.indexOf('--out') + 1] : null;

function argValue(name, fallback = '') {
  const index = args.indexOf(name);
  return index >= 0 && args[index + 1] ? args[index + 1] : fallback;
}

function loadEnv(file) {
  const out = {};
  if (!file || !fs.existsSync(file)) return out;
  for (const line of fs.readFileSync(file, 'utf8').split(/\r?\n/)) {
    const match = line.match(/^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)\s*$/);
    if (!match) continue;
    let value = match[2].trim();
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
      value = value.slice(1, -1);
    }
    out[match[1]] = value;
  }
  return out;
}

function freePort() {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const port = server.address().port;
      server.close(() => resolve(port));
    });
  });
}

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

if (!hasRun) {
  console.error('NOT VERIFIED — 真实 UI E2E 必须显式 --run。');
  process.exit(2);
}

const fileEnv = loadEnv(envFile);
const apiKey = process.env.DEEPSEEK_API_KEY || fileEnv.DEEPSEEK_API_KEY;
if (!apiKey) {
  console.error('NOT VERIFIED — 缺少 DEEPSEEK_API_KEY。');
  process.exit(2);
}

const apiToken = process.env.BLUEBIRD_API_TOKEN || `ui-e2e-${crypto.randomBytes(8).toString('hex')}`;
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'bluebird-ui-e2e-'));
const dataDir = path.join(tmp, 'data');
const workspaceDir = path.join(tmp, 'workspace');
fs.mkdirSync(dataDir, { recursive: true });
fs.mkdirSync(workspaceDir, { recursive: true });

const evidence = { startedAt: new Date().toISOString(), checks: [], calls: [] };
function check(name, ok, detail = null) {
  evidence.checks.push({ name, ok: Boolean(ok), detail });
  console.log(`${ok ? 'PASS' : 'FAIL'} UI/${name}${detail ? ` — ${detail}` : ''}`);
}

let apiBase = '';
let webBase = '';
const children = [];

async function waitFor(url, timeoutMs = 60000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const response = await fetch(url, { signal: AbortSignal.timeout(2000) });
      if (response.ok || response.status < 500) return response;
    } catch (_) {
      /* not ready */
    }
    await sleep(500);
  }
  throw new Error(`wait timeout: ${url}`);
}

async function api(method, endpoint, body = null) {
  const started = Date.now();
  const response = await fetch(`${apiBase}${endpoint}`, {
    method,
    headers: {
      Authorization: `Bearer ${apiToken}`,
      'Content-Type': 'application/json',
    },
    ...(body ? { body: JSON.stringify(body) } : {}),
  });
  let json = null;
  try {
    json = await response.json();
  } catch (_) {
    /* empty response */
  }
  evidence.calls.push({ method, endpoint, status: response.status, ms: Date.now() - started });
  return { status: response.status, json };
}

async function chat(sessionId, text) {
  return api('POST', '/chat', {
    sessionId,
    message: text,
    attachments: [],
  });
}

(async () => {
  const port = await freePort();
  apiBase = `http://127.0.0.1:${port}`;
  const webPort = await freePort();
  webBase = `http://127.0.0.1:${webPort}`;

  const backend = spawn(process.execPath, [SERVER], {
    cwd: ROOT,
    env: {
      ...process.env,
      ...fileEnv,
      DEEPSEEK_API_KEY: apiKey,
      PORT: String(port),
      BLUEBIRD_DATA_DIR: dataDir,
      BLUEBIRD_WORKSPACE_DIR: workspaceDir,
      BLUEBIRD_WORKSPACE_TOOLS: '1',
      BLUEBIRD_WORKSPACE_AUTO_CONFIRM: '0',
      BLUEBIRD_AGENT_TOOLS: '1',
      BLUEBIRD_API_TOKEN: apiToken,
      BLUEBIRD_MONITORING: '1',
      BLUEBIRD_AUDIT_MODE: '1',
      BLUEBIRD_CORE_MEMORY: '0',
      BLUEBIRD_RETRIEVAL_ROOTS: '',
      BLUEBIRD_SKILLS: '',
      BLUEBIRD_MEMORY_OBSERVER: '',
      BLUEBIRD_TURN_RECEIPTS: '1',
      BLUEBIRD_TASK_LEDGER: '0',
      BLUEBIRD_RECOVERY_EVIDENCE: '1',
    },
    stdio: 'ignore',
  });
  children.push(backend);
  await waitFor(`${apiBase}/monitoring/health`);

  const session = await api('POST', '/sessions', { title: 'W6 UI E2E' });
  const sessionId = session.json?.session?.id || session.json?.id;
  check('session created', Boolean(sessionId), String(sessionId || 'no-id'));

  const create = await chat(sessionId, '请使用 workspace_write 创建 ui-e2e.txt，内容 UI-E2E。完成后停止。');
  const createSteps = create.json?.toolSteps || [];
  const pendingStep = createSteps.find(step => step.pendingConfirmation?.id);
  check('write pending created', Boolean(pendingStep), create.json?.reply?.slice(0, 80) || `HTTP ${create.status}`);

  if (pendingStep) {
    const confirm = await api(
      'POST',
      `/workspace/pending/${encodeURIComponent(pendingStep.pendingConfirmation.id)}/confirm`,
      { sessionId }
    );
    check('pending write confirmed', confirm.status === 200, `HTTP ${confirm.status}`);
  }

  const read = await chat(sessionId, '请读取 ui-e2e.txt 并原样报告内容。');
  const readSteps = read.json?.toolSteps || [];
  check(
    'read receipt executed',
    readSteps.some(step => step.name === 'workspace_read' && step.ok === true),
    `${read.status}/${readSteps.map(step => `${step.name}:${step.ok}`).join(',')}`
  );
  check('content matches', /UI-E2E/.test(read.json?.reply || ''), (read.json?.reply || '').slice(0, 80));

  const history = await api('GET', `/history?sessionId=${encodeURIComponent(sessionId)}&limit=50`);
  const assistant = (history.json?.history || []).filter(item => item.role === 'assistant' && item.toolSteps?.length);
  check('history keeps receipts', assistant.length >= 2, `${assistant.length} assistant receipt messages`);
  check(
    'history keeps receiptStatus',
    assistant.every(item => typeof item.receiptStatus === 'string'),
    assistant.map(item => item.receiptStatus).join(',')
  );

  if (read.json?.requestId) {
    const replay = await api('GET', `/monitoring/audit/${encodeURIComponent(read.json.requestId)}`);
    check(
      'audit replay by requestId',
      replay.status === 200 && Array.isArray(replay.json?.audit?.records) && replay.json.audit.records.length > 0,
      `HTTP ${replay.status} records=${replay.json?.audit?.records?.length || 0}`
    );
  }

  const web = spawn(
    process.execPath,
    [path.join(ROOT, 'node_modules', 'expo', 'bin', 'cli'), 'start', '--web', '--port', String(webPort), '--non-interactive'],
    { cwd: ROOT, env: { ...process.env, EXPO_NO_TELEMETRY: '1', CI: '1' }, stdio: 'ignore' }
  );
  children.push(web);
  const webResponse = await waitFor(webBase, 120000);
  const html = await webResponse.text();
  check('expo web serves app', /<div[^>]+id="root"/.test(html), `HTTP ${webResponse.status}`);
  evidence.webHtmlSnippet = html.slice(0, 1200);
  const assetUrls = [...html.matchAll(/(?:src|href)="([^"]+)"/g)]
    .map(match => match[1])
    .filter(url => /\.js|bundle|entry/i.test(url))
    .slice(0, 8);
  let bundleText = html;
  for (const asset of assetUrls) {
    const assetUrl = asset.startsWith('http') ? asset : `${webBase}${asset}`;
    try {
      bundleText += await (await fetch(assetUrl)).text();
    } catch (_) {
      /* asset fetch best effort */
    }
  }
  check(
    'web bundle shows receipt status',
    (bundleText.includes('本轮没有工具回执') || bundleText.includes('receiptStatusLabel')) &&
      (bundleText.includes('副作用状态') || bundleText.includes('sideEffectState')),
    `html=${html.length} assets=${assetUrls.length} bundle=${bundleText.length}`
  );

  const failed = evidence.checks.filter(item => !item.ok);
  evidence.finishedAt = new Date().toISOString();
  if (outFile) fs.writeFileSync(outFile, `${JSON.stringify(evidence, null, 2)}\n`);
  console.log(`${evidence.checks.length - failed.length}/${evidence.checks.length} UI checks passed`);
  process.exitCode = failed.length ? 1 : 0;
})().catch(error => {
  console.error('UI E2E failed:', error && error.message);
  evidence.error = String(error && error.stack || error).slice(0, 4000);
  if (outFile) fs.writeFileSync(outFile, `${JSON.stringify(evidence, null, 2)}\n`);
  process.exitCode = 1;
}).finally(() => {
  for (const child of children) {
    try {
      child.kill('SIGTERM');
    } catch (_) {
      /* already exited */
    }
  }
  try {
    fs.rmSync(tmp, { recursive: true, force: true });
  } catch (_) {
    /* cleanup best effort */
  }
});
