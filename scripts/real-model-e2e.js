#!/usr/bin/env node
/* global __dirname */
const crypto = require('crypto');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');

const ROOT = path.join(__dirname, '..');
const SERVER = path.join(ROOT, 'server');
const args = process.argv.slice(2);

function option(name, fallback = null) {
  const index = args.indexOf(name);
  return index >= 0 && args[index + 1] ? args[index + 1] : fallback;
}

function usage() {
  console.log(
    'Usage: node scripts/real-model-e2e.js --run [--provider deepseek|custom] ' +
      '[--model MODEL] [--base-url URL] [--no-tools] [--reasoning] [--agent] [--out FILE]'
  );
  console.log('Credentials: DEEPSEEK_API_KEY or BLUEBIRD_REAL_API_KEY.');
  console.log('Exit codes: 0=all required checks passed, 1=executed with failures, 2=not verified.');
}

if (args.includes('--help') || args.includes('-h')) {
  usage();
  process.exit(0);
}

const enabled = args.includes('--run') || process.env.BLUEBIRD_REAL_E2E === '1';
const providerKind = option('--provider', process.env.BLUEBIRD_REAL_PROVIDER || 'deepseek');
const modelId =
  option('--model', process.env.BLUEBIRD_REAL_MODEL || '') ||
  (providerKind === 'deepseek' ? 'deepseek-chat' : '');
const baseUrl = option('--base-url', process.env.BLUEBIRD_REAL_BASE_URL || '');
const apiKey =
  (providerKind === 'deepseek'
    ? process.env.DEEPSEEK_API_KEY
    : process.env.BLUEBIRD_REAL_API_KEY || process.env.BLUEBIRD_REAL_PROVIDER_KEY || '') ||
  '';
const outFile = option('--out', process.env.BLUEBIRD_REAL_E2E_OUT || '');
const runAgent = args.includes('--agent') || process.env.BLUEBIRD_REAL_AGENT === '1';
const toolsEnabled =
  !args.includes('--no-tools') && process.env.BLUEBIRD_REAL_TOOLS !== '0';
const reasoningEnabled =
  args.includes('--reasoning') || process.env.BLUEBIRD_REAL_REASONING === '1';

function notVerified(reason) {
  console.error(`NOT VERIFIED — ${reason}`);
  usage();
  process.exit(2);
}

if (!enabled) notVerified('真实调用会产生费用，必须显式传入 --run 或设置 BLUEBIRD_REAL_E2E=1。');
if (!['deepseek', 'custom'].includes(providerKind)) notVerified('provider 必须是 deepseek 或 custom。');
if (!modelId) notVerified('缺少模型 ID。');
if (!apiKey) notVerified('缺少真实 Provider 凭证。');
if (providerKind === 'custom' && !baseUrl) notVerified('custom Provider 缺少 base URL。');
if (providerKind === 'deepseek' && baseUrl) {
  notVerified('deepseek Provider 使用内置地址，不支持 --base-url；自定义地址请使用 --provider custom。');
}
if (providerKind === 'deepseek' && reasoningEnabled) {
  notVerified('内置 deepseek-chat 未声明 reasoning 能力；推理模型请使用 --provider custom --reasoning。');
}
if (process.env.BLUEBIRD_ALLOW_PRIVATE_BASE_URL === '1') {
  notVerified('BLUEBIRD_ALLOW_PRIVATE_BASE_URL=1 只能用于本地桩，不能用于真实 E2E。');
}
if (process.env.BLUEBIRD_PROVIDER_KIND === 'stub') {
  notVerified('BLUEBIRD_PROVIDER_KIND=stub 与真实 Provider 验证冲突。');
}

let parsedBase = null;
if (baseUrl) {
  try {
    parsedBase = new URL(baseUrl);
  } catch (_) {
    notVerified('base URL 不是合法 URL。');
  }
  if (!['http:', 'https:'].includes(parsedBase.protocol)) {
    notVerified('base URL 只支持 http/https。');
  }
}

const TMP_ROOT = fs.mkdtempSync(path.join(os.tmpdir(), 'bluebird-real-e2e-'));
const DATA_DIR = path.join(TMP_ROOT, 'data');
const API_TOKEN = `real-e2e-${crypto.randomBytes(12).toString('hex')}`;
const USER_ID = 'local-owner';
fs.mkdirSync(DATA_DIR, { recursive: true });

process.env.BLUEBIRD_DATA_DIR = DATA_DIR;
process.env.BLUEBIRD_RETRIEVAL_DIR = path.join(DATA_DIR, 'retrieval');
process.env.BLUEBIRD_RETRIEVAL_ROOTS = '';
process.env.BLUEBIRD_RETRIEVAL_EMBEDDING_PROVIDER = '';
process.env.BLUEBIRD_RETRIEVAL_EMBEDDING_BASE_URL = '';
process.env.BLUEBIRD_RETRIEVAL_EMBEDDING_API_KEY = '';
process.env.BLUEBIRD_RETRIEVAL_EMBEDDING_MODEL = '';
process.env.BLUEBIRD_RETRIEVAL_RERANKER_PROVIDER = '';
process.env.BLUEBIRD_RETRIEVAL_RERANKER_BASE_URL = '';
process.env.BLUEBIRD_RETRIEVAL_RERANKER_API_KEY = '';
process.env.BLUEBIRD_RETRIEVAL_RERANKER_MODEL = '';
process.env.BLUEBIRD_WORKSPACE_DIR = path.join(DATA_DIR, 'workspace');
process.env.BLUEBIRD_API_TOKEN = API_TOKEN;
process.env.BLUEBIRD_USER_ID = USER_ID;
process.env.DEEPSEEK_API_KEY = providerKind === 'deepseek' ? apiKey : '';
process.env.PORT = '0';
process.env.NODE_ENV = 'test';
process.env.MEMORY_ENABLED = 'true';
process.env.BLUEBIRD_AGENT_TOOLS = toolsEnabled ? '1' : '0';
process.env.BLUEBIRD_AGENT_MAX_ROUNDS = '3';
process.env.BLUEBIRD_MEMORY_OBSERVER = 'every_turn';
process.env.BLUEBIRD_CLAIM_GUARD = '1';
process.env.BLUEBIRD_MONITORING = '1';
process.env.BLUEBIRD_CORE_MEMORY = '0';
process.env.BLUEBIRD_WORKSPACE_TOOLS = '';
process.env.BLUEBIRD_SKILLS = '';
delete process.env.BLUEBIRD_ALLOW_PRIVATE_BASE_URL;
delete process.env.BLUEBIRD_PROVIDER_KIND;

const results = [];
let base = '';
let server = null;
let providerId = providerKind === 'deepseek' ? 'deepseek' : '';
let sessionId = '';
let chatUsable = false;
let observedEmptyContent = false;

function record(id, status, detail = {}) {
  const row = { id, status, ...detail };
  results.push(row);
  const suffix = status === 'pass' ? 'PASS' : status === 'fail' ? 'FAIL' : 'NOT VERIFIED';
  console.log(`[${suffix}] ${id}${detail.reason ? ` — ${detail.reason}` : ''}`);
}

async function req(urlPath, { method = 'GET', body, timeoutMs = 120000 } = {}) {
  const res = await fetch(base + urlPath, {
    method,
    headers: {
      Authorization: `Bearer ${API_TOKEN}`,
      ...(body ? { 'Content-Type': 'application/json' } : {}),
    },
    body: body ? JSON.stringify(body) : undefined,
    signal: AbortSignal.timeout(timeoutMs),
  });
  const text = await res.text();
  let json = null;
  try {
    json = JSON.parse(text);
  } catch (_) {
    json = null;
  }
  return { status: res.status, text, json };
}

function parseSseText(text) {
  const events = [];
  for (const block of String(text || '').split('\n\n')) {
    for (const line of block.split('\n')) {
      if (!line.startsWith('data:')) continue;
      const raw = line.slice(5).trim();
      if (!raw || raw === '[DONE]') continue;
      try {
        events.push(JSON.parse(raw));
      } catch (_) {
        // 忽略非 JSON 帧。
      }
      break;
    }
  }
  return events;
}

async function readSseTimed(urlPath, body) {
  const started = Date.now();
  const res = await fetch(base + urlPath, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${API_TOKEN}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(120000),
  });
  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  let firstDeltaMs = null;
  const events = [];
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    let boundary = buffer.indexOf('\n\n');
    while (boundary >= 0) {
      const block = buffer.slice(0, boundary);
      buffer = buffer.slice(boundary + 2);
      for (const event of parseSseText(block)) {
        events.push(event);
        if (event.type === 'delta' && firstDeltaMs === null) {
          firstDeltaMs = Date.now() - started;
        }
      }
      boundary = buffer.indexOf('\n\n');
    }
  }
  return {
    status: res.status,
    events,
    firstDeltaMs,
    totalMs: Date.now() - started,
  };
}

async function readSseSnapshot(urlPath) {
  const res = await fetch(base + urlPath, {
    headers: { Authorization: `Bearer ${API_TOKEN}` },
    signal: AbortSignal.timeout(10000),
  });
  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  const events = [];
  while (events.length === 0) {
    const { done, value } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    let boundary = buffer.indexOf('\n\n');
    while (boundary >= 0) {
      const block = buffer.slice(0, boundary);
      buffer = buffer.slice(boundary + 2);
      events.push(...parseSseText(block));
      boundary = buffer.indexOf('\n\n');
    }
  }
  try {
    await reader.cancel();
  } catch (_) {
    // 已取得 snapshot，后续实时帧不属于本用例。
  }
  return { status: res.status, events };
}

async function waitFor(check, timeoutMs = 15000, intervalMs = 500) {
  const deadline = Date.now() + timeoutMs;
  let last = null;
  while (Date.now() < deadline) {
    last = await check();
    if (last) return last;
    await new Promise(resolve => setTimeout(resolve, intervalMs));
  }
  return null;
}

async function memoryRows() {
  const res = await req('/memory?scope=all');
  return res.status === 200 && Array.isArray(res.json.memories) ? res.json.memories : [];
}

async function modelMonitoringRows() {
  const res = await req('/monitoring/models');
  return res.status === 200 && res.json && Array.isArray(res.json.models)
    ? res.json.models
    : [];
}

async function chat(message, { stream = false, tools = true } = {}) {
  if (!tools) process.env.BLUEBIRD_AGENT_TOOLS = '0';
  const payload = {
    message,
    sessionId,
    providerId,
    modelId,
  };
  if (stream) return readSseTimed('/chat/stream', payload);
  return req('/chat', { method: 'POST', body: payload });
}

async function configureAgent() {
  if (!runAgent) {
    record('agent_delegation', 'not_verified', { reason: '未传 --agent，跳过子 Agent 真实链路。' });
    return;
  }
  if (!toolsEnabled) {
    record('agent_delegation', 'not_verified', { reason: '工具能力已关闭，跳过子 Agent 真实链路。' });
    return;
  }
  const botId = 'researcher';
  const config = await req(`/agents/${botId}/config`, {
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
  if (config.status !== 200) {
    record('agent_delegation', 'fail', { reason: `bot config HTTP ${config.status}` });
    return;
  }
  const credential = await req(`/agents/${botId}/credentials`, {
    method: 'POST',
    body: { providerId, apiKey },
  });
  if (credential.status !== 201) {
    record('agent_delegation', 'fail', { reason: `bot credential HTTP ${credential.status}` });
    return;
  }

  const goal = `Real E2E delegation ${crypto.randomBytes(4).toString('hex')}: 用一句话说明你已完成检索任务。`;
  const res = await chat(`请把下面的任务明确委派给 researcher，并等待结果：${goal}`);
  const task = await waitFor(async () => {
    const list = await req(
      `/agent-tasks?botId=${encodeURIComponent(botId)}&parentSessionId=${encodeURIComponent(sessionId)}&limit=20`
    );
    if (list.status !== 200 || !Array.isArray(list.json.tasks)) return null;
    return list.json.tasks.find(item => item.botId === botId) || null;
  });
  if (!task) {
    record('agent_delegation', 'fail', {
      reason: '模型未创建 researcher 任务。',
      reply: res.json && typeof res.json.reply === 'string' ? res.json.reply : null,
    });
    return;
  }
  const terminal = await waitFor(async () => {
    const detail = await req(`/agent-tasks/${task.taskId}`);
    return detail.status === 200 && ['completed', 'failed', 'cancelled', 'timed_out'].includes(detail.json.task.status)
      ? detail.json.task
      : null;
  }, 60000);
  if (!terminal) {
    record('agent_delegation', 'fail', { reason: '任务未在 60s 内进入终态。', taskId: task.taskId });
    return;
  }

  const snapshotRes = await readSseSnapshot(
    `/agent-results/stream?sessionId=${encodeURIComponent(sessionId)}`
  );
  const snapshotEvents = snapshotRes.events;
  const snapshotIds = snapshotEvents.flatMap(event =>
    Array.isArray(event.results) ? event.results.map(item => item.taskId) : []
  );
  const delivered = terminal.deliveryStatus === 'delivered';
  const inSnapshot = snapshotIds.includes(task.taskId);
  record(
    'agent_delegation',
    terminal.status === 'completed' && delivered && inSnapshot ? 'pass' : 'fail',
    {
      taskId: task.taskId,
      taskStatus: terminal.status,
      deliveryStatus: terminal.deliveryStatus,
      reconnectSnapshot: inSnapshot,
    }
  );
}

async function main() {
  const loaded = require(path.join(SERVER, 'index.js'));
  server = loaded.server;
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  base = `http://127.0.0.1:${server.address().port}`;

  if (providerKind === 'custom') {
    const created = await req('/model-providers', {
      method: 'POST',
      body: {
        name: 'Real E2E Provider',
        baseUrl,
        apiKey,
        models: [
          {
            id: modelId,
            name: modelId,
            capabilities: { tools: toolsEnabled, vision: false, reasoning: reasoningEnabled },
          },
        ],
      },
    });
    if (created.status !== 201 || !created.json.provider.id) {
      throw new Error(`custom provider setup failed: HTTP ${created.status}`);
    }
    providerId = created.json.provider.id;
    const defaults = await req('/model-providers/default', {
      method: 'PUT',
      body: { providerId, modelId },
    });
    if (defaults.status !== 200) throw new Error('custom provider default setup failed');
  }

  const session = await req('/sessions', { method: 'POST', body: {} });
  if (session.status !== 201 || !session.json.session.id) {
    throw new Error(`session setup failed: HTTP ${session.status}`);
  }
  sessionId = session.json.session.id;

  const simple = await chat('请只回复“Bluebird real E2E ok”。');
  if (simple.status === 200 && typeof simple.json.reply === 'string' && simple.json.reply.trim()) {
    chatUsable = true;
    record('chat_nonstream', 'pass', { replyLength: simple.json.reply.length });
  } else {
    observedEmptyContent = simple.status === 500 || simple.json.code === 'empty_response';
    record('chat_nonstream', 'fail', { httpStatus: simple.status, code: simple.json.code });
  }

  const stream = await chat('请用两句话介绍你自己。', { stream: true });
  const deltas = stream.events.filter(event => event.type === 'delta');
  const error = stream.events.find(event => event.type === 'error');
  const reply = stream.events.find(event => event.type === 'done');
  const pseudoStream = deltas.length === 1 && stream.firstDeltaMs !== null &&
    stream.totalMs - stream.firstDeltaMs < 250;
  if (!error && deltas.length > 0 && !pseudoStream && reply && reply.reply) {
    record('chat_stream', 'pass', {
      deltaCount: deltas.length,
      firstDeltaMs: stream.firstDeltaMs,
      totalMs: stream.totalMs,
      pseudoStream,
    });
  } else {
    observedEmptyContent = observedEmptyContent || Boolean(error);
    record('chat_stream', 'fail', {
      deltaCount: deltas.length,
      firstDeltaMs: stream.firstDeltaMs,
      totalMs: stream.totalMs,
      error: error ? error.error : null,
    });
  }

  const unknown = await req('/chat', {
    method: 'POST',
    body: { message: '你好', sessionId, providerId, modelId: 'no-such-real-model' },
  });
  record(
    'unknown_model',
    unknown.status === 400 && unknown.json.code ? 'pass' : 'fail',
    { httpStatus: unknown.status, code: unknown.json.code || null }
  );

  const empty = await req('/chat', {
    method: 'POST',
    body: { message: '', sessionId, providerId, modelId },
  });
  record(
    'empty_message',
    empty.status === 400 && empty.json.code ? 'pass' : 'fail',
    { httpStatus: empty.status, code: empty.json.code || null }
  );

  if (!chatUsable) {
    record('memory_create', 'not_verified', { reason: '基础聊天不可用，跳过记忆依赖用例。' });
    record('memory_correction', 'not_verified', { reason: '基础聊天不可用，跳过记忆依赖用例。' });
    record('memory_extraction_provider', 'not_verified', { reason: '基础聊天不可用，跳过记忆依赖用例。' });
  } else {
    const createSentinel = `REAL-E2E-CREATE-${crypto.randomBytes(5).toString('hex')}`;
    await chat(`请记住：${createSentinel} 喜欢喝燕麦拿铁。`);
    const createdMemory = await waitFor(async () => {
      const rows = await memoryRows();
      return rows.find(item => item.status === 'active' && item.content.includes(createSentinel)) || null;
    });
    record(
      'memory_create',
      createdMemory ? 'pass' : 'fail',
      { entryId: createdMemory ? createdMemory.id : null }
    );

    if (!createdMemory) {
      record('memory_correction', 'not_verified', { reason: '未建立旧记忆，跳过更正用例。' });
    } else {
      const correctionSentinel = `REAL-E2E-CORRECT-${crypto.randomBytes(5).toString('hex')}`;
      await chat(
        `更正一下：${correctionSentinel} 我现在改喝抹茶拿铁了，不再喝燕麦拿铁。`
      );
      const corrected = await waitFor(async () => {
        const rows = await memoryRows();
        const replacement = rows.find(
          item => item.status === 'active' && item.content.includes(correctionSentinel)
        );
        const old = rows.find(item => item.id === createdMemory.id);
        return replacement && old && old.status === 'superseded'
          ? { replacement, old }
          : null;
      }, 20000);
      record(
        'memory_correction',
        corrected ? 'pass' : 'fail',
        corrected
          ? { oldId: corrected.old.id, newId: corrected.replacement.id }
          : { oldStatus: (await memoryRows()).find(item => item.id === createdMemory.id)?.status || null }
      );
    }

    const extractionSentinel = `REAL-E2E-EXTRACT-${crypto.randomBytes(5).toString('hex')}`;
    process.env.BLUEBIRD_AGENT_TOOLS = '0';
    process.env.BLUEBIRD_MEMORY_OBSERVER = 'every_turn';
    await chat(`${extractionSentinel} 住在上海。`, { tools: false });
    const extracted = await waitFor(async () => {
      const rows = await memoryRows();
      return rows.find(item => item.content.includes(extractionSentinel)) || null;
    }, 20000);
    process.env.BLUEBIRD_AGENT_TOOLS = toolsEnabled ? '1' : '0';
    const modelRows = await modelMonitoringRows();
    const hardcodedDeepSeek = modelRows.some(
      item => item.provider_id === 'deepseek' && item.model_id === 'deepseek-chat' && item.requests > 0
    );
    const targetSeen = modelRows.some(
      item => item.provider_id === providerId && item.model_id === modelId && item.requests > 0
    );
    const extractionTargetOk =
      providerKind === 'deepseek' || (!hardcodedDeepSeek && targetSeen);
    record(
      'memory_extraction_provider',
      extracted && extractionTargetOk ? 'pass' : 'fail',
      {
        entryId: extracted ? extracted.id : null,
        providerKind,
        targetProviderId: providerId,
        targetModelId: modelId,
        hardcodedDeepSeek,
        targetSeen,
      }
    );
  }

  record('reasoning_empty_content', observedEmptyContent ? 'fail' : 'not_verified', {
    reason: observedEmptyContent ? '本轮观察到空内容错误。' : '本轮未观察到 reasoning-only 空内容。',
  });

  await configureAgent();
}

function currentCommit() {
  try {
    return execFileSync('git', ['rev-parse', 'HEAD'], { cwd: ROOT, encoding: 'utf8' }).trim();
  } catch (_) {
    return null;
  }
}

function report() {
  return {
    schemaVersion: 1,
    capturedAt: new Date().toISOString(),
    commit: currentCommit(),
    provider: {
      kind: providerKind,
      id: providerId,
      modelId,
      reasoning: reasoningEnabled,
      baseUrl: parsedBase ? `${parsedBase.protocol}//${parsedBase.host}` : null,
    },
    summary: {
      pass: results.filter(item => item.status === 'pass').length,
      fail: results.filter(item => item.status === 'fail').length,
      notVerified: results.filter(item => item.status === 'not_verified').length,
    },
    cases: results,
  };
}

main()
  .catch(error => {
    record('runner', 'fail', { reason: String(error && error.message ? error.message : error) });
  })
  .finally(async () => {
    let output = report();
    try {
      await new Promise(resolve => setTimeout(resolve, 500));
      output = report();
      if (outFile) {
        fs.writeFileSync(outFile, JSON.stringify(output, null, 2) + '\n', 'utf8');
        console.log(`Report: ${outFile}`);
      } else {
        console.log(JSON.stringify(output, null, 2));
      }
    } catch (error) {
      record('report', 'fail', { reason: String(error && error.message ? error.message : error) });
      output = report();
      console.error(`Report failed: ${error && error.message ? error.message : error}`);
    } finally {
      try {
        if (server) {
          try {
            if (typeof server.closeAllConnections === 'function') server.closeAllConnections();
          } catch (_) {
            // 关停失败不改变结论。
          }
          await new Promise(resolve => server.close(() => resolve()));
        }
      } finally {
        try {
          fs.rmSync(TMP_ROOT, { recursive: true, force: true });
        } catch (_) {
          // 临时目录清理失败不改变结论。
        }
      }
    }
    process.exitCode = output.summary.fail ? 1 : 0;
  });
