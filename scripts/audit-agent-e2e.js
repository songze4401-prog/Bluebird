#!/usr/bin/env node
/* global __dirname */
/**
 * W0 真实端到端回归基线（A–F）。
 *
 * 目的：把审计中暴露的跨轮状态、假成功、委派写入、长任务问题变成可复跑的非零退出。
 * 约束：
 *  - 必须显式 --run，避免误触发真实模型费用；
 *  - 使用临时 BLUEBIRD_DATA_DIR / workspace，不读写 server/data；
 *  - 不打印密钥；日志只写临时目录或 --log 指定文件；
 *  - 任何 required check 失败 → exit 1；缺凭证/未显式运行 → exit 2。
 *
 * 用法：
 *   npm run audit:agent -- --run --out audit-agent-e2e.json
 *   npm run audit:agent -- --run --only A,B --keep-data
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

function arg(name, fallback = null) {
  const index = args.indexOf(name);
  return index >= 0 && args[index + 1] ? args[index + 1] : fallback;
}
function usage() {
  console.log(
    'Usage: npm run audit:agent -- --run [--model deepseek-chat] [--env-file server/.env]\n' +
      '       [--out FILE] [--log FILE] [--only A,B,C,D,E,F] [--keep-data]\n' +
      'Credentials: DEEPSEEK_API_KEY or --env-file with DEEPSEEK_API_KEY.\n' +
      'Exit codes: 0=all checks pass, 1=executed with failures, 2=not verified.'
  );
}
function notVerified(reason) {
  console.error(`NOT VERIFIED — ${reason}`);
  usage();
  process.exit(2);
}
function loadEnv(file) {
  const out = {};
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
function getFreePort() {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const port = server.address().port;
      server.close(() => resolve(port));
    });
  });
}

if (!args.includes('--run') && process.env.BLUEBIRD_AUDIT_REAL !== '1') {
  notVerified('真实调用会产生费用，必须显式传入 --run 或设置 BLUEBIRD_AUDIT_REAL=1。');
}
const envFileArg = arg('--env-file', path.join(ROOT, 'server', '.env'));
let fileEnv = {};
if (envFileArg && fs.existsSync(envFileArg)) {
  try { fileEnv = loadEnv(envFileArg); } catch (_) { fileEnv = {}; }
}
const providerId = 'deepseek';
const modelId = arg('--model', process.env.BLUEBIRD_AUDIT_MODEL || 'deepseek-chat');
const apiKey =
  process.env.DEEPSEEK_API_KEY ||
  fileEnv.DEEPSEEK_API_KEY ||
  process.env.BLUEBIRD_REAL_API_KEY ||
  '';
if (!apiKey) notVerified('缺少 DEEPSEEK_API_KEY；可用 --env-file 指向包含该键的 server/.env。');
if (process.env.BLUEBIRD_PROVIDER_KIND === 'stub') notVerified('BLUEBIRD_PROVIDER_KIND=stub 与真实 E2E 冲突。');

const apiToken = process.env.BLUEBIRD_API_TOKEN || `audit-${crypto.randomBytes(12).toString('hex')}`;
const only = new Set(
  String(arg('--only', 'A,B,C,D,E,F'))
    .split(',')
    .map(item => item.trim().toUpperCase())
    .filter(Boolean)
);
const keepData = args.includes('--keep-data');
const outFile = arg('--out', '');
const logFileArg = arg('--log', '');

const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'bluebird-audit-e2e-'));
const dataDir = path.join(tmpRoot, 'data');
const workspaceDir = path.join(tmpRoot, 'workspace');
const logFile = logFileArg || path.join(tmpRoot, 'server.log');
fs.mkdirSync(dataDir, { recursive: true });
fs.mkdirSync(workspaceDir, { recursive: true });

let server = null;
let base = null;
let serverLog = null;
const evidence = {
  startedAt: new Date().toISOString(),
  model: `${providerId}/${modelId}`,
  tempRoot: tmpRoot,
  checks: [],
  calls: [],
  tests: {},
  serverRestarts: 0,
};

function log(line) {
  process.stdout.write(`${line}\n`);
}
function recordCheck(testId, name, ok, detail = null) {
  evidence.checks.push({ testId, name, ok: Boolean(ok), detail });
  log(`${ok ? 'PASS' : 'FAIL'} ${testId}/${name}${detail ? ` — ${detail}` : ''}`);
}

async function startServer(label) {
  const port = await getFreePort();
  base = `http://127.0.0.1:${port}`;
  serverLog = fs.createWriteStream(logFile, { flags: 'a' });
  server = spawn(process.execPath, [SERVER], {
    cwd: ROOT,
    env: {
      ...process.env,
      PORT: String(port),
      BLUEBIRD_DATA_DIR: dataDir,
      BLUEBIRD_WORKSPACE_DIR: workspaceDir,
      BLUEBIRD_WORKSPACE_TOOLS: '1',
      BLUEBIRD_WORKSPACE_AUTO_CONFIRM: '1',
      BLUEBIRD_AGENT_TOOLS: '1',
      BLUEBIRD_AGENT_MAX_ROUNDS: '3',
      BLUEBIRD_CLAIM_GUARD: '1',
      BLUEBIRD_CORE_MEMORY: '0',
      BLUEBIRD_MONITORING: '1',
      BLUEBIRD_RETRIEVAL_ROOTS: '',
      BLUEBIRD_SKILLS: '',
      BLUEBIRD_MEMORY_OBSERVER: '',
      BLUEBIRD_TURN_RECEIPTS: '1',
      MEMORY_ENABLED: 'true',
      BLUEBIRD_API_TOKEN: apiToken,
      DEEPSEEK_API_KEY: apiKey,
      BLUEBIRD_RATE_LIMIT_PER_WINDOW: '100000',
      NODE_ENV: 'test',
    },
  });
  server.stdout.pipe(serverLog, { end: false });
  server.stderr.pipe(serverLog, { end: false });
  server.on('exit', code => log(`[server:${label}] exited code=${code}`));

  const deadline = Date.now() + 30000;
  while (Date.now() < deadline) {
    try {
      const res = await fetch(`${base}/`, { signal: AbortSignal.timeout(2000) });
      if (res.ok) {
        log(`[server:${label}] ready pid=${server.pid} port=${port}`);
        return;
      }
    } catch (_) {
      /* not ready */
    }
    await new Promise(resolve => setTimeout(resolve, 400));
  }
  throw new Error(`server ${label} did not become ready`);
}

async function stopServer(label) {
  if (!server) return;
  const proc = server;
  server = null;
  proc.kill('SIGTERM');
  await new Promise(resolve => {
    const timer = setTimeout(() => {
      try { proc.kill('SIGKILL'); } catch (_) {}
      resolve();
    }, 5000);
    proc.on('exit', () => { clearTimeout(timer); resolve(); });
  });
  log(`[server:${label}] stopped`);
}

async function api(pathname, { method = 'GET', body, timeout = 180000 } = {}) {
  const started = Date.now();
  const res = await fetch(`${base}${pathname}`, {
    method,
    headers: {
      Authorization: `Bearer ${apiToken}`,
      ...(body ? { 'Content-Type': 'application/json' } : {}),
    },
    ...(body ? { body: JSON.stringify(body) } : {}),
    signal: AbortSignal.timeout(timeout),
  });
  const text = await res.text();
  let json = null;
  try { json = text ? JSON.parse(text) : null; } catch (_) { json = { raw: text.slice(0, 2000) }; }
  return { status: res.status, json, ms: Date.now() - started };
}

async function createSession(title) {
  const res = await api('/sessions', { method: 'POST', body: { title } });
  if (res.status !== 201 || !res.json || !res.json.session) {
    throw new Error(`create session failed HTTP ${res.status}: ${JSON.stringify(res.json).slice(0, 500)}`);
  }
  return res.json.session.id;
}

async function chat(testId, step, sessionId, message, { timeout = 180000 } = {}) {
  const res = await api('/chat', { method: 'POST', body: { message, sessionId }, timeout });
  const record = {
    testId,
    step,
    httpStatus: res.status,
    ms: res.ms,
    reply: res.json && typeof res.json.reply === 'string' ? res.json.reply : null,
    toolSteps: res.json && Array.isArray(res.json.toolSteps) ? res.json.toolSteps : [],
    persisted: res.json ? res.json.persisted : null,
    model: res.json ? res.json.model : null,
    memoryState: res.json ? res.json.memoryState : null,
    code: res.json ? res.json.code || null : null,
    error: res.status >= 400 ? (res.json && (res.json.error || res.json.detail)) || null : null,
  };
  evidence.calls.push(record);
  log(
    `[${testId}/${step}] HTTP ${record.httpStatus} ${record.ms}ms ` +
      `tools=${record.toolSteps.map(item => `${item.name}:${item.ok}`).join(',') || 'none'} ` +
      `reply=${(record.reply || '').slice(0, 160).replace(/\n/g, ' ')}`
  );
  return record;
}

async function history(sessionId) {
  const res = await api(`/history?sessionId=${encodeURIComponent(sessionId)}&limit=50`);
  return res.json && Array.isArray(res.json.history) ? res.json.history : [];
}
function readWorkspace(rel) {
  try {
    return { exists: true, content: fs.readFileSync(path.join(workspaceDir, rel), 'utf8') };
  } catch (_) {
    return { exists: false, content: null };
  }
}
function writeWorkspace(rel, content) {
  const abs = path.join(workspaceDir, rel);
  fs.mkdirSync(path.dirname(abs), { recursive: true });
  fs.writeFileSync(abs, content, 'utf8');
}
function removeWorkspace(rel) {
  try { fs.unlinkSync(path.join(workspaceDir, rel)); } catch (_) {}
}
function toolNames(step) {
  return (step.toolSteps || []).map(item => `${item.name}:${item.ok}`);
}

async function testA(sessionId) {
  const t = {};
  t.a1 = await chat('A', 'create', sessionId,
    '请使用 workspace_write 工具在工作区创建文件 audit-a.txt，mode=create，内容精确为：v1。完成后用一句话确认。');
  t.a2 = await chat('A', 'read-v1', sessionId,
    '请使用 workspace_read 读取 audit-a.txt，并原样告诉我内容。不要猜测。');
  t.a3 = await chat('A', 'overwrite-v2', sessionId,
    '请使用 workspace_write 把 audit-a.txt 覆盖为内容 v2（mode=overwrite）。完成后用一句话确认。');
  t.a4 = await chat('A', 'no-tool-recall', sessionId,
    '现在不要调用任何工具，只凭你当前掌握的信息回答：audit-a.txt 是否存在？内容是什么？如果你不确定，就明确说不确定。');
  t.a5 = await chat('A', 'read-v2', sessionId,
    '请再次使用 workspace_read 读取 audit-a.txt，核对真实内容，并明确说明和我上次要求的是否一致。');
  t.file = readWorkspace('audit-a.txt');
  t.history = await history(sessionId);
  evidence.tests.A = t;

  recordCheck('A', 'file exists', t.file.exists);
  recordCheck('A', 'final content v2', String(t.file.content || '').trim() === 'v2', JSON.stringify(t.file.content));
  recordCheck('A', 'create write receipt', toolNames(t.a1).includes('workspace_write:true'));
  recordCheck('A', 'read receipt', toolNames(t.a2).includes('workspace_read:true'));
  recordCheck('A', 'overwrite receipt', toolNames(t.a3).includes('workspace_write:true'));
  const assistantWithReceipts = (t.history || []).find(
    item => item.role === 'assistant' && Array.isArray(item.toolSteps) && item.toolSteps.length
  );
  recordCheck(
    'A',
    'history persists receiptStatus',
    Boolean(assistantWithReceipts && assistantWithReceipts.receiptStatus),
    assistantWithReceipts ? assistantWithReceipts.receiptStatus : 'no assistant receipt'
  );
  recordCheck(
    'A',
    'success confirmation not replaced by readback guard',
    !/本轮未调用读取\/核对工具/.test(t.a1.reply || ''),
    (t.a1.reply || '').slice(0, 120)
  );
  recordCheck('A', 'explicit read-back receipt', toolNames(t.a5).includes('workspace_read:true'));
}

async function testB(sessionId) {
  const t = {};
  t.b1 = await chat('B', 'step1', sessionId,
    '接下来是一个三步文件任务。步骤1：创建 b-step1.txt，内容 one。步骤2：创建 b-step2.txt，内容 two。步骤3：创建 b-step3.txt，内容 three。现在只执行步骤1，完成后停止，并报告当前进度和下一步。');
  t.b2 = await chat('B', 'step2', sessionId,
    '继续执行步骤2，然后停止，报告当前进度和剩余步骤。');
  t.afterB2 = { step1: readWorkspace('b-step1.txt'), step2: readWorkspace('b-step2.txt'), step3: readWorkspace('b-step3.txt') };
  evidence.tests.B = t;
}

async function testBResume(sessionId) {
  const t = evidence.tests.B;
  t.historyAfterRestart = await history(sessionId);
  t.b3 = await chat('B', 'step3-after-restart', sessionId,
    '服务刚刚重启过。请先根据会话历史确认当前任务做到哪一步，然后继续完成剩余步骤，最后汇总三个文件的状态。');
  t.final = { step1: readWorkspace('b-step1.txt'), step2: readWorkspace('b-step2.txt'), step3: readWorkspace('b-step3.txt') };
  evidence.tests.B = t;

  recordCheck('B', 'step1 exists', t.final.step1.exists);
  recordCheck('B', 'step2 exists', t.final.step2.exists);
  recordCheck('B', 'step3 exists', t.final.step3.exists);
  recordCheck('B', 'history survives restart', Array.isArray(t.historyAfterRestart) && t.historyAfterRestart.length > 0, `${(t.historyAfterRestart || []).length} messages`);
  const bReply = t.b3.reply || '';
  recordCheck(
    'B',
    'resume reports 3/3 or explicit pending',
    /3\s*\/\s*3|全部|完成|未完成|缺/.test(bReply) ||
      (/b-step1\.txt/.test(bReply) && /b-step2\.txt/.test(bReply) && /b-step3\.txt/.test(bReply)),
    bReply.slice(0, 120)
  );
}

async function testC(sessionId) {
  const t = {};
  t.c1 = await chat('C', 'missing', sessionId,
    '请使用 workspace_read 读取工作区文件 missing-c.txt，并告诉我它的内容。');
  writeWorkspace('c-real.txt', 'recovered-content');
  t.c2 = await chat('C', 'correct-path', sessionId,
    '文件其实叫 c-real.txt。请读取它并告诉我真实内容。');
  t.file = readWorkspace('c-real.txt');
  evidence.tests.C = t;
  recordCheck('C', 'missing read failed', toolNames(t.c1).includes('workspace_read:false'));
  recordCheck('C', 'error explained', /不存在|没有|无法|失败|missing/i.test(t.c1.reply || ''));
  recordCheck('C', 'recovered read', toolNames(t.c2).includes('workspace_read:true'));
  recordCheck('C', 'content matched', /recovered-content/.test(t.c2.reply || ''));
}

async function testD(sessionId) {
  const t = {};
  t.d1 = await chat('D', 'create', sessionId,
    '请使用 workspace_write 创建 d-env.txt，内容 original。完成后确认。');
  t.baseline = readWorkspace('d-env.txt');
  writeWorkspace('d-env.txt', 'externally-changed');
  t.d2 = await chat('D', 'detect-change', sessionId,
    '请使用 workspace_read 读取 d-env.txt，告诉我现在的内容；如果和我最初要求的不一样，明确指出变化。');
  removeWorkspace('d-env.txt');
  t.d3 = await chat('D', 'detect-delete', sessionId,
    '请再次确认 d-env.txt 是否还存在，并说明你依据的是实时环境还是之前的记忆。');
  evidence.tests.D = t;
  recordCheck('D', 'created original', t.baseline.exists && String(t.baseline.content).trim() === 'original');
  recordCheck('D', 'external change detected', /externally-changed/.test(t.d2.reply || ''));
  recordCheck('D', 'change read receipt', toolNames(t.d2).includes('workspace_read:true'));
  recordCheck('D', 'deletion detected', /不在了|不存在|没有/.test(t.d3.reply || '') && t.d3.toolSteps.some(item => item.name === 'workspace_list' || item.name === 'workspace_read'));
}

async function configureExecutor() {
  const config = await api('/agents/executor/config', {
    method: 'PUT',
    body: {
      modelProfile: {
        providerId,
        modelId,
        temperature: 0.2,
        maxTokens: 1200,
        timeoutMs: 60000,
      },
    },
  });
  const credential = await api('/agents/executor/credentials', {
    method: 'POST',
    body: { providerId, apiKey },
  });
  recordCheck('E', 'executor configured', config.status === 200, `HTTP ${config.status}`);
  recordCheck('E', 'executor credential created', credential.status === 201, `HTTP ${credential.status}`);
}

async function waitForTask(sessionId, botId, timeoutMs = 90000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const res = await api(`/agent-tasks?botId=${encodeURIComponent(botId)}&parentSessionId=${encodeURIComponent(sessionId)}&limit=20`);
    if (res.status === 200 && Array.isArray(res.json.tasks) && res.json.tasks.length) {
      const task = res.json.tasks[0];
      if (['completed', 'failed', 'cancelled', 'timed_out', 'recovery'].includes(task.status)) return task;
    }
    await new Promise(resolve => setTimeout(resolve, 1000));
  }
  return null;
}

async function testE(sessionId) {
  const t = {};
  await configureExecutor();
  t.e1 = await chat('E', 'delegate', sessionId,
    '请把任务明确委派给 executor：在工作区创建 e-agent.txt，内容 delegated，并让执行 Agent 完成后汇报。必须使用 delegate_to_bot，然后告诉我任务 ID 和状态。');
  t.task = await waitForTask(sessionId, 'executor');
  t.file = readWorkspace('e-agent.txt');
  t.history = await history(sessionId);
  t.deliveryMessage = (t.history || []).find(item => typeof item.id === 'string' && item.id.startsWith('bot-result-')) || null;
  evidence.tests.E = t;
  recordCheck('E', 'delegated', toolNames(t.e1).includes('delegate_to_bot:true'));
  recordCheck('E', 'task completed', Boolean(t.task && t.task.status === 'completed'), t.task ? `${t.task.status}/${t.task.errorCode || 'no-error'}` : 'no task');
  recordCheck('E', 'file created', t.file.exists && /delegated/.test(t.file.content || ''));
  recordCheck('E', 'delivered to parent', Boolean(t.deliveryMessage));
}

const F_STEPS = [
  '第1步：创建 f01.txt，内容 A。第2步：创建 f02.txt，内容 B。第3步：创建 f03.txt，内容 C。现在执行这三步，完成后停止并报告。',
  '继续第4步：读取 f01.txt 并原样报告内容。第5步：向 f01.txt 追加一行 +D（mode=append）。第6步：列出工作区根目录。完成后停止并报告。',
  '继续第7步：创建 f07.txt，内容 G。第8步：读取 f08.txt（这个文件现在故意不存在，允许失败）。第9步：读取失败后，创建 f08.txt，内容 H，作为恢复。完成后报告第8步的错误和恢复结果。',
  '继续第10步：把 f02.txt 覆盖为内容 B2。第11步：读取 f02.txt 核对。第12步：创建 f12.txt，内容 L。完成后停止并报告。',
  '继续第13步：向 f12.txt 追加 +M。第14步：列出工作区根目录，确认文件。第15步：汇总整个 15 步任务中哪些步骤成功、哪些失败、当前所有文件的实际状态。不要调用不存在的工具。',
];

async function testF(sessionId) {
  const t = { steps: [] };
  for (let index = 0; index < F_STEPS.length; index += 1) {
    t.steps.push(await chat('F', `batch${index + 1}`, sessionId, F_STEPS[index], { timeout: 240000 }));
  }
  t.files = {
    f01: readWorkspace('f01.txt'),
    f02: readWorkspace('f02.txt'),
    f03: readWorkspace('f03.txt'),
    f07: readWorkspace('f07.txt'),
    f08: readWorkspace('f08.txt'),
    f12: readWorkspace('f12.txt'),
  };
  t.history = await history(sessionId);
  evidence.tests.F = t;
  recordCheck('F', 'f01 A+D', String(t.files.f01.content || '').includes('A') && String(t.files.f01.content || '').includes('+D'));
  recordCheck('F', 'f02 B2', String(t.files.f02.content || '').trim() === 'B2');
  recordCheck('F', 'f03 C', String(t.files.f03.content || '').trim() === 'C');
  recordCheck('F', 'f07 G', String(t.files.f07.content || '').trim() === 'G');
  recordCheck('F', 'f08 H', String(t.files.f08.content || '').trim() === 'H');
  recordCheck('F', 'f12 L+M', String(t.files.f12.content || '').includes('L') && String(t.files.f12.content || '').includes('+M'));
  recordCheck('F', 'final summary covers 15 steps', /15|十五|完成|未完成|步骤/.test(t.steps[4].reply || '') && (t.steps[4].reply || '').length >= 80, (t.steps[4].reply || '').slice(0, 160));
}

async function main() {
  log(`=== audit-agent-e2e start (${providerId}/${modelId}) ===`);
  await startServer('initial');

  if (only.has('A')) {
    const sessionA = await createSession('audit-A-file-continuity');
    await testA(sessionA);
  }
  if (only.has('B')) {
    const sessionB = await createSession('audit-B-cross-message');
    await testB(sessionB);
    await stopServer('before-restart');
    evidence.serverRestarts += 1;
    await startServer('after-restart');
    await testBResume(sessionB);
  }
  if (only.has('C')) {
    const sessionC = await createSession('audit-C-failure-recovery');
    await testC(sessionC);
  }
  if (only.has('D')) {
    const sessionD = await createSession('audit-D-env-change');
    await testD(sessionD);
  }
  if (only.has('E')) {
    const sessionE = await createSession('audit-E-multi-agent');
    await testE(sessionE);
  }
  if (only.has('F')) {
    const sessionF = await createSession('audit-F-long-task');
    await testF(sessionF);
  }

  evidence.finishedAt = new Date().toISOString();
  const failed = evidence.checks.filter(item => !item.ok);
  evidence.summary = {
    total: evidence.checks.length,
    passed: evidence.checks.length - failed.length,
    failed: failed.length,
    failedChecks: failed.map(item => `${item.testId}/${item.name}`),
  };
  if (outFile) {
    const target = path.isAbsolute(outFile) ? outFile : path.join(process.cwd(), outFile);
    fs.writeFileSync(target, `${JSON.stringify(evidence, null, 2)}\n`);
    log(`evidence: ${target}`);
  }
  log(`=== ${evidence.summary.passed}/${evidence.summary.total} checks passed, ${failed.length} failed ===`);
  if (failed.length) {
    log(`failed: ${evidence.summary.failedChecks.join(', ')}`);
  }
  log(`server log: ${logFile}`);
  await stopServer('final');

  if (!keepData) {
    try { fs.rmSync(tmpRoot, { recursive: true, force: true }); } catch (_) {}
  } else {
    log(`temp data kept: ${tmpRoot}`);
  }
  process.exitCode = failed.length ? 1 : 0;
}

main().catch(async error => {
  log(`FATAL ${error && error.stack ? error.stack : error}`);
  try { await stopServer('fatal'); } catch (_) {}
  process.exitCode = 1;
});
