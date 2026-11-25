/* global __dirname */
const fs = require('fs');
const http = require('http');
const os = require('os');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const SERVER = path.join(ROOT, 'server');
const BASELINE = require('./real-model-regression-baseline.json');
const TMP_ROOT = fs.mkdtempSync(path.join(os.tmpdir(), 'bluebird-real-regression-'));
const DATA_DIR = path.join(TMP_ROOT, 'data');
const TOKEN = 'real-regression-test-token';
const USER_ID = 'local-owner';
const MODEL_ID = 'regression-model';
const MODEL_ID_NO_REASONING = 'regression-model-no-reasoning';

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
process.env.BLUEBIRD_API_TOKEN = TOKEN;
process.env.BLUEBIRD_USER_ID = USER_ID;
process.env.DEEPSEEK_API_KEY = '';
process.env.PORT = '0';
process.env.NODE_ENV = 'test';
process.env.BLUEBIRD_ALLOW_PRIVATE_BASE_URL = '1';
process.env.BLUEBIRD_PROVIDER_KIND = 'stub';
process.env.BLUEBIRD_AGENT_TOOLS = '1';
process.env.BLUEBIRD_CLAIM_GUARD = '0';
process.env.BLUEBIRD_MEMORY_OBSERVER = 'trigger';
process.env.BLUEBIRD_CORE_MEMORY = '0';
process.env.BLUEBIRD_MONITORING = '0';
process.env.BLUEBIRD_WORKSPACE_TOOLS = '';
process.env.BLUEBIRD_WORKSPACE_AUTO_CONFIRM = '0';
process.env.BLUEBIRD_SKILLS = '';

const ORIG_LOG = console.log;
const ORIG_ERR = console.error;
const serverErrors = [];
console.log = () => {};
console.error = (...args) => serverErrors.push(args.map(String).join(' '));

const state = {
  mode: 'normal',
  calls: [],
  extractionModels: [],
  agentCalls: 0,
  slowStreamClosed: false,
};

function json(res, status, body) {
  res.writeHead(status, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify(body));
}

function sse(res, chunks) {
  res.writeHead(200, {
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache',
    Connection: 'keep-alive',
  });
  for (const chunk of chunks) {
    res.write(`data: ${JSON.stringify(chunk)}\n\n`);
  }
  res.end('data: [DONE]\n\n');
}

const mockServer = http.createServer((req, res) => {
  res.on('error', () => {});
  let raw = '';
  req.on('data', chunk => {
    raw += chunk;
  });
  req.on('end', () => {
    let body = null;
    try {
      body = JSON.parse(raw || '{}');
    } catch (_) {
      body = {};
    }

    if (req.url === '/models' || req.url === '/models/' || req.url === '/v1/models' || req.url === '/v1/models/') {
      json(res, 200, {
        object: 'list',
        data: [{ id: MODEL_ID, object: 'model', owned_by: 'regression-stub' }],
      });
      return;
    }

    if (req.url !== '/chat/completions' && req.url !== '/v1/chat/completions') {
      json(res, 404, { error: 'not_found' });
      return;
    }

    state.calls.push({
      model: body.model,
      stream: body.stream === true,
      hasTools: Array.isArray(body.tools) && body.tools.length > 0,
      messages: body.messages,
    });

    const systemText = (body.messages || [])
      .filter(item => item && item.role === 'system')
      .map(item => String(item.content || ''))
      .join('\n');

    if (systemText.includes('长期记忆提取器')) {
      state.extractionModels.push(body.model);
      if (body.model !== MODEL_ID) {
        json(res, 400, { error: { message: `Unsupported model (model=${body.model})` } });
        return;
      }
      json(res, 200, {
        model: body.model,
        choices: [
          {
            message: {
              role: 'assistant',
              content: JSON.stringify({
                content: '用户喜欢喝燕麦拿铁',
                type: 'preference',
                keywords: ['咖啡', '燕麦拿铁'],
                confidence: 0.95,
                inferred: false,
                uncertainty: 'none',
                sourceQuote: '我喜欢喝燕麦拿铁',
              }),
            },
          },
        ],
      });
      return;
    }

    if (state.mode === 'reasoning_nonstream') {
      json(res, 200, {
        model: body.model,
        choices: [
          {
            message: {
              role: 'assistant',
              content: '',
              reasoning_content: '这是推理模型答案。',
            },
          },
        ],
      });
      return;
    }

    if (state.mode === 'reasoning_stream') {
      sse(res, [
        {
          model: body.model,
          choices: [
            { index: 0, delta: { reasoning_content: '这是推理模型答案。' }, finish_reason: null },
          ],
        },
        { model: body.model, choices: [{ index: 0, delta: {}, finish_reason: 'stop' }] },
      ]);
      return;
    }

    if (state.mode === 'reasoning_then_content_stream') {
      sse(res, [
        {
          model: body.model,
          choices: [
            { index: 0, delta: { reasoning_content: '内部推理，不应发送。' }, finish_reason: null },
          ],
        },
        {
          model: body.model,
          choices: [
            { index: 0, delta: { content: '[calm] 正式答案。' }, finish_reason: null },
          ],
        },
        { model: body.model, choices: [{ index: 0, delta: {}, finish_reason: 'stop' }] },
      ]);
      return;
    }

    if (state.mode === 'whitespace_nonstream') {
      json(res, 200, {
        model: body.model,
        choices: [{ message: { role: 'assistant', content: '   \n  ' } }],
      });
      return;
    }

    if (state.mode === 'slow_stream') {
      state.slowStreamClosed = false;
      res.on('close', () => {
        if (!res.writableEnded) state.slowStreamClosed = true;
      });
      res.writeHead(200, {
        'Content-Type': 'text/event-stream',
        'Cache-Control': 'no-cache',
        Connection: 'keep-alive',
      });
      res.write(
        `data: ${JSON.stringify({
          model: body.model,
          choices: [{ index: 0, delta: { content: '[calm] 首段。' }, finish_reason: null }],
        })}\n\n`
      );
      const timer = setTimeout(() => {
        res.write(
          `data: ${JSON.stringify({
            model: body.model,
            choices: [{ index: 0, delta: {}, finish_reason: 'stop' }],
          })}\n\n`
        );
        res.end('data: [DONE]\n\n');
      }, 5000);
      res.on('close', () => clearTimeout(timer));
      return;
    }

    if (state.mode === 'empty_nonstream') {
      json(res, 200, {
        model: body.model,
        choices: [{ message: { role: 'assistant', content: '' } }],
      });
      return;
    }

    if (state.mode === 'empty_stream') {
      sse(res, [
        { model: body.model, choices: [{ index: 0, delta: {}, finish_reason: 'stop' }] },
      ]);
      return;
    }

    if (state.mode === 'agent_stream') {
      state.agentCalls += 1;
      if (body.tools && body.tools.length) {
        json(res, 200, {
          model: body.model,
          choices: [
            {
              message: {
                role: 'assistant',
                content: null,
                tool_calls: [
                  {
                    id: 'call_regression_memory_search',
                    type: 'function',
                    function: {
                      name: 'memory_search',
                      arguments: JSON.stringify({ query: '咖啡', limit: 3 }),
                    },
                  },
                ],
              },
              finish_reason: 'tool_calls',
            },
          ],
        });
        return;
      }
      json(res, 200, {
        model: body.model,
        choices: [
          {
            message: { role: 'assistant', content: '[calm] Agent 最终回复。' },
            finish_reason: 'stop',
          },
        ],
      });
      return;
    }

    if (body.stream) {
      sse(res, [
        {
          model: body.model,
          choices: [{ index: 0, delta: { content: '[calm] 正常回复。' }, finish_reason: null }],
        },
        { model: body.model, choices: [{ index: 0, delta: {}, finish_reason: 'stop' }] },
      ]);
      return;
    }

    json(res, 200, {
      model: body.model,
      choices: [{ message: { role: 'assistant', content: '[calm] 正常回复。' } }],
    });
  });
});

function parseSse(text) {
  const events = [];
  for (const block of String(text || '').split('\n\n')) {
    for (const line of block.split('\n')) {
      if (!line.startsWith('data:')) continue;
      const raw = line.slice(5).trim();
      if (!raw || raw === '[DONE]') continue;
      try {
        events.push(JSON.parse(raw));
      } catch (_) {
        // 非 JSON 帧不属于本脚本的验收范围。
      }
      break;
    }
  }
  return events;
}

let baseUrl = '';
let server = null;
let providerId = '';
let sessionId = '';
let passed = 0;
let failed = 0;
const observedResults = {};

async function req(urlPath, { method = 'GET', body, auth = true } = {}) {
  const res = await fetch(baseUrl + urlPath, {
    method,
    headers: {
      ...(auth ? { Authorization: `Bearer ${TOKEN}` } : {}),
      ...(body ? { 'Content-Type': 'application/json' } : {}),
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
  let jsonBody = null;
  try {
    jsonBody = JSON.parse(text);
  } catch (_) {
    jsonBody = null;
  }
  return { status: res.status, text, json: jsonBody };
}

async function abortStreamAfterFirstDelta(body) {
  const controller = new AbortController();
  const res = await fetch(baseUrl + '/chat/stream', {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${TOKEN}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(body),
    signal: controller.signal,
  });
  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  const events = [];
  let buffer = '';
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      let boundary = buffer.indexOf('\n\n');
      while (boundary >= 0) {
        const block = buffer.slice(0, boundary);
        buffer = buffer.slice(boundary + 2);
        const parsed = parseSse(block);
        events.push(...parsed);
        if (parsed.some(event => event.type === 'delta')) {
          controller.abort();
        }
        boundary = buffer.indexOf('\n\n');
      }
    }
  } catch (error) {
    if (!(error && error.name === 'AbortError')) throw error;
  }
  try {
    await reader.cancel();
  } catch (_) {
    // 客户端中止后 reader 可能已经关闭。
  }
  return events;
}

function checkCase(id, observed, detail = '') {
  observedResults[id] = observed;
  const expected = BASELINE.cases[id];
  if (observed === expected) {
    passed += 1;
    ORIG_LOG(`  ✔ ${id}: ${observed}`);
  } else {
    failed += 1;
    ORIG_LOG(`  ✖ ${id}: expected=${expected} actual=${observed}${detail ? ` — ${detail}` : ''}`);
  }
}

async function waitFor(check, timeoutMs = 2000, intervalMs = 25) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await check()) return true;
    await new Promise(resolve => setTimeout(resolve, intervalMs));
  }
  return false;
}

async function closeHttp(target) {
  if (!target) return;
  try {
    if (typeof target.closeAllConnections === 'function') target.closeAllConnections();
  } catch (_) {
    // 关停失败不改变测试结论。
  }
  await new Promise(resolve => target.close(() => resolve()));
}

async function main() {
  await new Promise(resolve => mockServer.listen(0, '127.0.0.1', resolve));
  const mockPort = mockServer.address().port;
  const mockBase = `http://127.0.0.1:${mockPort}/v1`;

  const loaded = require(path.join(SERVER, 'index.js'));
  server = loaded.server;
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  baseUrl = `http://127.0.0.1:${server.address().port}`;

  const created = await req('/model-providers', {
    method: 'POST',
    body: {
      name: 'Regression Stub',
      baseUrl: mockBase,
      apiKey: 'regression-stub-key',
      models: [
        {
          id: MODEL_ID,
          name: 'Regression Model',
          capabilities: { tools: true, vision: false, reasoning: true },
        },
        {
          id: MODEL_ID_NO_REASONING,
          name: 'Regression Model Without Reasoning',
          capabilities: { tools: true, vision: false, reasoning: false },
        },
      ],
    },
  });
  if (created.status !== 201 || !created.json.provider.id) {
    throw new Error(`provider setup failed: ${created.status} ${created.text.slice(0, 300)}`);
  }
  providerId = created.json.provider.id;

  const defaultSet = await req('/model-providers/default', {
    method: 'PUT',
    body: { providerId, modelId: MODEL_ID },
  });
  if (defaultSet.status !== 200) {
    throw new Error(`default setup failed: ${defaultSet.status} ${defaultSet.text.slice(0, 300)}`);
  }

  const session = await req('/sessions', { method: 'POST', body: {} });
  if (session.status !== 201 || !session.json.session.id) {
    throw new Error(`session setup failed: ${session.status} ${session.text.slice(0, 300)}`);
  }
  sessionId = session.json.session.id;

  state.mode = 'reasoning_nonstream';
  const reasoning = await req('/chat', {
    method: 'POST',
    body: { message: '你好', sessionId, providerId, modelId: MODEL_ID },
  });
  checkCase(
    'reasoning_only_nonstream',
    reasoning.status === 200 &&
      reasoning.json.reply &&
      reasoning.json.reply.includes('这是推理模型答案')
      ? 'http_200_reasoning_fallback'
      : `http_${reasoning.status}`,
    reasoning.text.slice(0, 160)
  );

  state.mode = 'reasoning_stream';
  process.env.BLUEBIRD_AGENT_TOOLS = '0';
  const reasoningStream = await req('/chat/stream', {
    method: 'POST',
    body: { message: '你好', sessionId, providerId, modelId: MODEL_ID },
  });
  const reasoningEvents = parseSse(reasoningStream.text);
  const reasoningError = reasoningEvents.find(event => event.type === 'error');
  const reasoningDelta = reasoningEvents
    .filter(event => event.type === 'delta')
    .map(event => event.content)
    .join('');
  checkCase(
    'reasoning_only_stream',
    !reasoningError && reasoningDelta.includes('这是推理模型答案')
      ? 'sse_reasoning_fallback'
      : reasoningError
        ? `sse_error_${reasoningError.code || 'without_code'}`
        : 'no_reasoning_delta',
    reasoningStream.text.slice(0, 200)
  );

  state.mode = 'reasoning_then_content_stream';
  const mixedReasoning = await req('/chat/stream', {
    method: 'POST',
    body: { message: '你好', sessionId, providerId, modelId: MODEL_ID },
  });
  const mixedEvents = parseSse(mixedReasoning.text);
  const mixedDelta = mixedEvents
    .filter(event => event.type === 'delta')
    .map(event => event.content)
    .join('');
  checkCase(
    'reasoning_then_content_stream',
    mixedDelta.includes('正式答案') && !mixedDelta.includes('内部推理')
      ? 'formal_content_only'
      : 'reasoning_leaked',
    mixedDelta
  );

  state.mode = 'reasoning_nonstream';
  const reasoningDisabled = await req('/chat', {
    method: 'POST',
    body: { message: '你好', sessionId, providerId, modelId: MODEL_ID_NO_REASONING },
  });
  checkCase(
    'reasoning_capability_disabled',
    reasoningDisabled.status === 502 && reasoningDisabled.json.code === 'empty_response'
      ? 'http_502_empty_response'
      : `http_${reasoningDisabled.status}_${reasoningDisabled.json.code || 'no_code'}`,
    reasoningDisabled.text.slice(0, 160)
  );

  state.mode = 'whitespace_nonstream';
  const whitespace = await req('/chat', {
    method: 'POST',
    body: { message: '你好', sessionId, providerId, modelId: MODEL_ID },
  });
  checkCase(
    'whitespace_response_nonstream',
    whitespace.status === 502 && whitespace.json.code === 'empty_response'
      ? 'http_502_empty_response'
      : `http_${whitespace.status}_${whitespace.json.code || 'no_code'}`,
    whitespace.text.slice(0, 160)
  );

  state.mode = 'empty_nonstream';
  const emptyResponse = await req('/chat', {
    method: 'POST',
    body: { message: '你好', sessionId, providerId, modelId: MODEL_ID },
  });
  checkCase(
    'empty_response_nonstream',
    emptyResponse.status === 502 && emptyResponse.json.code === 'empty_response'
      ? 'http_502_empty_response'
      : `http_${emptyResponse.status}_${emptyResponse.json.code || 'no_code'}`,
    emptyResponse.text.slice(0, 160)
  );

  state.mode = 'empty_stream';
  const emptyStream = await req('/chat/stream', {
    method: 'POST',
    body: { message: '你好', sessionId, providerId, modelId: MODEL_ID },
  });
  const emptyStreamError = parseSse(emptyStream.text).find(event => event.type === 'error');
  checkCase(
    'empty_response_stream',
    emptyStreamError && emptyStreamError.code === 'empty_response'
      ? 'sse_error_empty_response'
      : emptyStreamError
        ? `sse_error_${emptyStreamError.code || 'without_code'}`
        : 'no_sse_error',
    emptyStream.text.slice(0, 200)
  );
  process.env.BLUEBIRD_AGENT_TOOLS = '1';

  state.mode = 'normal';
  const unknown = await req('/chat', {
    method: 'POST',
    body: { message: '你好', sessionId, providerId, modelId: 'no-such-model' },
  });
  checkCase(
    'unknown_model',
    unknown.status === 400 && unknown.json.code === 'model_not_found'
      ? 'http_400_model_not_found'
      : `http_${unknown.status}_${unknown.json.code || 'no_code'}`,
    unknown.text.slice(0, 160)
  );

  const empty = await req('/chat', {
    method: 'POST',
    body: { message: '', sessionId, providerId, modelId: MODEL_ID },
  });
  checkCase(
    'empty_message',
    empty.status === 400 && empty.json.error === '消息不能为空' && empty.json.code === 'invalid_message'
      ? 'http_400_invalid_message'
      : `http_${empty.status}_${empty.json.code || 'no_code'}`,
    empty.text.slice(0, 160)
  );

  process.env.BLUEBIRD_MEMORY_OBSERVER = 'every_turn';
  state.mode = 'normal';
  await req('/chat', {
    method: 'POST',
    body: { message: '我喜欢喝燕麦拿铁。', sessionId, providerId, modelId: MODEL_ID },
  });
  await waitFor(() => state.extractionModels.length > 0);
  process.env.BLUEBIRD_MEMORY_OBSERVER = 'trigger';
  checkCase(
    'memory_extraction_custom_provider',
    state.extractionModels.includes('deepseek-chat')
      ? 'hardcoded_deepseek_chat'
      : state.extractionModels.includes(MODEL_ID)
        ? 'configured_model'
        : 'no_extraction',
    state.extractionModels.join(',')
  );

  const memory = require(path.join(SERVER, 'memory.js'));
  const memoryOptions = {
    sessionId,
    userId: USER_ID,
    sourceType: 'user',
    userText: '我喜欢喝冰美式。',
  };
  await memory.applyCandidate(
    {
      content: '用户喜欢喝冰美式',
      type: 'preference',
      keywords: ['咖啡', '美式'],
      confidence: 0.95,
      sourceQuote: '我喜欢喝冰美式',
    },
    memoryOptions
  );
  const correction = await memory.applyCandidate(
    {
      content: '用户现在改喝燕麦拿铁，不再喝冰美式',
      type: 'preference',
      keywords: ['咖啡', '燕麦拿铁'],
      confidence: 0.95,
      sourceQuote: '我现在改喝燕麦拿铁了，不再喝冰美式',
    },
    {
      ...memoryOptions,
      userText: '更正一下：我现在改喝燕麦拿铁了，不再喝冰美式。',
    }
  );
  checkCase(
    'explicit_correction_temporary_marker',
    correction.decision === 'reject' && correction.reason === 'temporary_state'
      ? 'reject_temporary_state'
      : `${correction.decision}_${correction.reason}`
  );

  const temporary = await memory.applyCandidate(
    {
      content: '用户今天想喝燕麦拿铁',
      type: 'preference',
      keywords: ['咖啡', '燕麦拿铁'],
      confidence: 0.95,
      sourceQuote: '今天想喝燕麦拿铁',
    },
    {
      ...memoryOptions,
      userText: '今天想喝燕麦拿铁。',
    }
  );
  checkCase(
    'temporary_preference_guard',
    temporary.decision === 'reject' && temporary.reason === 'temporary_state'
      ? 'reject_temporary_state'
      : `${temporary.decision}_${temporary.reason}`
  );

  const { detectClaimMismatch } = require(path.join(SERVER, 'claim-guard.js'));
  const mismatch = detectClaimMismatch('扫描完成，共 0 项，没有文件。', [
    { name: 'workspace_list', ok: true, summary: '执行成功', durationMs: 1 },
  ]);
  checkCase(
    'claim_guard_zero_result',
    mismatch && mismatch.aType === 'failure_claim' && mismatch.bType === 'tool_success'
      ? 'false_failure_claim'
      : mismatch
        ? `${mismatch.aType}_${mismatch.bType}`
        : 'no_mismatch'
  );

  const { stripToolProtocolText } = require(path.join(SERVER, 'textual-tool-calls.js'));
  const leaked = stripToolProtocolText(
    '[memory_remember 候选] 林舟喜欢 Python。<tool_call 未闭合'
  );
  checkCase(
    'protocol_marker_leak',
    leaked.includes('[memory_remember 候选]') && leaked.includes('<tool_call')
      ? 'marker_retained'
      : 'marker_stripped',
    leaked
  );

  state.mode = 'agent_stream';
  state.agentCalls = 0;
  process.env.BLUEBIRD_AGENT_TOOLS = '1';
  const agentStream = await req('/chat/stream', {
    method: 'POST',
    body: { message: '查一下我的咖啡记忆', sessionId, providerId, modelId: MODEL_ID },
  });
  const agentEvents = parseSse(agentStream.text);
  const deltaCount = agentEvents.filter(event => event.type === 'delta').length;
  const agentDone = agentEvents.find(event => event.type === 'done');
  const agentToolSteps = agentDone && Array.isArray(agentDone.toolSteps) ? agentDone.toolSteps : [];
  const validSingleDelta =
    deltaCount === 1 &&
    state.agentCalls >= 2 &&
    agentDone &&
    typeof agentDone.reply === 'string' &&
    agentDone.reply.includes('Agent 最终回复') &&
    agentToolSteps.some(step => step.name === 'memory_search');
  checkCase(
    'agent_stream',
    validSingleDelta ? 'single_delta' : `invalid_delta_${deltaCount}`,
    `${agentEvents.map(event => event.type).join(',')} | calls=${state.agentCalls} | ${serverErrors
      .filter(line => /AI |agent-|model-adapter/.test(line))
      .slice(-8)
      .join(' | ')}`
  );
  await new Promise(resolve => setTimeout(resolve, 350));

  state.mode = 'slow_stream';
  process.env.BLUEBIRD_AGENT_TOOLS = '0';
  const cancelledEvents = await abortStreamAfterFirstDelta({
    message: '取消测试',
    sessionId,
    providerId,
    modelId: MODEL_ID,
  });
  await waitFor(() => state.slowStreamClosed, 2000, 25);
  process.env.BLUEBIRD_AGENT_TOOLS = '1';
  checkCase(
    'ordinary_stream_disconnect_signal',
    !cancelledEvents.some(event => event.type === 'done') && state.slowStreamClosed
      ? 'runtime_cancelled'
      : 'cancel_not_observed',
    cancelledEvents.map(event => event.type).join(',')
  );

  const deliverySource = fs.readFileSync(
    path.join(SERVER, 'agents', 'result-delivery.js'),
    'utf8'
  );
  checkCase(
    'non_memory_snapshot',
    deliverySource.includes("tasks.listTasks('memory'")
      ? 'memory_only_query'
      : 'all_agents_query'
  );

  const contextConfig = require(path.join(SERVER, 'context', 'config.json'));
  const apiConfigSource = fs.readFileSync(path.join(SERVER, 'api-configs.js'), 'utf8');
  const textModelStart = apiConfigSource.indexOf('id: BUILTIN_TEXT_MODEL');
  const textModelEnd = apiConfigSource.indexOf('id: BUILTIN_VISION_MODEL', textModelStart);
  const textModelBlock =
    textModelStart >= 0 && textModelEnd > textModelStart
      ? apiConfigSource.slice(textModelStart, textModelEnd)
      : '';
  checkCase(
    'context_window',
    !textModelBlock
      ? 'anchor_missing'
      : !textModelBlock.includes('contextWindow') &&
          contextConfig.inputGuard.unknownWindowGuardTokens === 24000
        ? 'unknown_guard_24000'
        : 'declared_or_changed'
  );

  ORIG_LOG(`\n通过 ${passed} 项，失败 ${failed} 项`);
  if (failed) {
    ORIG_LOG('基线已变化：请确认是产品修复还是回归，再更新 tests/real-model-regression-baseline.json。');
    if (serverErrors.length) ORIG_ERR(serverErrors.slice(-20).join('\n'));
  }
}

main()
  .catch(error => {
    failed += 1;
    ORIG_ERR(`real-model regression baseline failed: ${error && error.stack ? error.stack : error}`);
    if (serverErrors.length) ORIG_ERR(serverErrors.slice(-10).join('\n'));
  })
  .finally(async () => {
    console.log = ORIG_LOG;
    console.error = ORIG_ERR;
    await closeHttp(server);
    await closeHttp(mockServer);
    try {
      fs.rmSync(TMP_ROOT, { recursive: true, force: true });
    } catch (_) {
      // 临时目录清理失败不改变结论。
    }
    process.exitCode = failed ? 1 : 0;
  });
