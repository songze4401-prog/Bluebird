/* global __dirname, Buffer */
/**
 * 云岫 Bluebird — P4 真实端到端验证
 *
 * 覆盖链路：真实 HTTP 入口（/chat 与 /chat/stream）→ Context Runtime v3
 * → 真实 DeepSeek Provider → 真实模型 tool_calls → Agent 工具执行
 * → 工具结果回传下一轮请求 → 最终回复与 Context trace。
 *
 * 与 tests/context-engine-e2e.test.js 的分工：
 * - 那个测试用 openai 桩验证 HTTP/上下文/工具循环的结构行为，可在 CI 跑；
 * - 本脚本不替换 openai、不启动本地假 Provider，只对真实 DeepSeek 调用，
 *   因此能证明“真实模型确实发起了工具调用、真实 Provider 确实返回了 usage”。
 *
 * 严格声明（不夸大）：
 * - 脚本验证请求装配、真实网络调用、真实工具调用与工具结果回传；
 *   不验证模型是否在语义上“理解”了记忆内容（HTTP 成功 ≠ 模型消费了每条内容）。
 * - 没有真实凭证时什么都不验证，输出 NOT VERIFIED 并以退出码 2 结束，
 *   绝不打印 PASS。
 * - 本脚本不在 CI 中运行；CI 的真实模型验证仍是未验证项。
 *
 * 启用方式：
 *   BLUEBIRD_P4_REAL=1 DEEPSEEK_API_KEY=<真实 key> node scripts/p4-real-e2e.js
 * 可选：
 *   BLUEBIRD_P4_MODEL=deepseek-chat（默认；必须是内置声明 tools 的模型）
 *
 * 退出码：0 = 真实链路全部通过；1 = 已真实执行但验收失败；2 = 未验证
 */
const crypto = require('crypto');
const fs = require('fs');
const os = require('os');
const path = require('path');

const SERVER = path.join(__dirname, '..', 'server');
const ENABLED = process.env.BLUEBIRD_P4_REAL === '1';
const API_KEY = (process.env.DEEPSEEK_API_KEY || '').trim();
const MODEL_ID = process.env.BLUEBIRD_P4_MODEL || 'deepseek-chat';
const API_TOKEN = 'p4-real-e2e-token';
const USER_ID = 'local-owner';

// 默认输出到真实终端；main 截获 stdout/stderr 后改为直写原始流，
// 保证脚本自身的通过/失败结论不会被日志捕获吞掉。
let ORIG_LOG = (...args) => console.log(...args);
let ORIG_ERR = (...args) => console.error(...args);

function notVerified(reason) {
  console.log('');
  console.log('NOT VERIFIED — P4 真实端到端未验证');
  console.log(`原因：${reason}`);
  console.log('');
  console.log('这不算通过。P4 要求真实模型与真实 Provider，不接受 Stub 代替。');
  console.log(
    '启用方式：BLUEBIRD_P4_REAL=1 DEEPSEEK_API_KEY=<真实 key> node scripts/p4-real-e2e.js'
  );
  process.exit(2);
}

if (!ENABLED) {
  notVerified('未设置 BLUEBIRD_P4_REAL=1（真实调用会产生费用，必须显式开启）');
}
if (!API_KEY) {
  notVerified('缺少 DEEPSEEK_API_KEY（真实 Provider 凭证）');
}
if (process.env.BLUEBIRD_ALLOW_PRIVATE_BASE_URL === '1') {
  notVerified(
    'BLUEBIRD_ALLOW_PRIVATE_BASE_URL=1 已开启——这是本地桩 Provider 的测试旁路，不能用于 P4'
  );
}
if (process.env.BLUEBIRD_PROVIDER_KIND === 'stub') {
  notVerified('BLUEBIRD_PROVIDER_KIND=stub 显式声明了桩 Provider，不能用于 P4');
}

// 真实模式必须清掉桩声明；否则 trace 会把它标成 stub，证据自相矛盾。
delete process.env.BLUEBIRD_PROVIDER_KIND;
delete process.env.BLUEBIRD_ALLOW_PRIVATE_BASE_URL;

const TMP_ROOT = fs.mkdtempSync(path.join(os.tmpdir(), 'bluebird-p4-real-'));
const DATA_DIR = path.join(TMP_ROOT, 'data');
fs.mkdirSync(DATA_DIR, { recursive: true });

process.env.BLUEBIRD_DATA_DIR = DATA_DIR;
process.env.BLUEBIRD_API_TOKEN = API_TOKEN;
process.env.BLUEBIRD_USER_ID = USER_ID;
process.env.MEMORY_ENABLED = 'true';
process.env.BLUEBIRD_AGENT_TOOLS = '1';
process.env.BLUEBIRD_AGENT_MAX_ROUNDS = '3';
process.env.BLUEBIRD_MONITORING = '0';
process.env.NODE_ENV = 'test';
process.env.PORT = '0';

const SENTINEL = `P4-SENTINEL-${crypto.randomBytes(6).toString('hex')}`;
const FACT = `用户喝咖啡只喝美式，不加糖不加奶。${SENTINEL}`;
const SEARCH_PROMPT =
  `帮我查一下我的咖啡记忆。你必须先调用 memory_search 工具（query 填“咖啡”，limit 填 3），` +
  '拿到工具结果后再回答我喝咖啡的习惯；不要直接回答。';
const RETRY_PROMPT =
  '这是工具调用测试：请只做一件事——调用 memory_search 工具，参数 {"query":"咖啡","limit":3}。' +
  '收到工具结果后，再用一句中文说明结果。不要在没有调用工具时回答。';

function seedMemory() {
  const now = new Date().toISOString();
  const entries = [
    {
      id: 'mem_p4_coffee',
      content: FACT,
      type: 'preference',
      keywords: ['咖啡', '美式', '不加糖', '不加奶'],
      confidence: 0.95,
      status: 'active',
      sourceQuote: FACT,
      sessionId: 'sess_p4_seed',
      userId: USER_ID,
      validFrom: now,
      validTo: null,
      createdAt: now,
      updatedAt: now,
      provenance: 'user_asserted',
      category: 'long_term_preference',
      observedAt: now,
      policyVersion: 'p1.0',
      decisionVersion: 'p1.0',
      evidence: null,
    },
  ];
  fs.writeFileSync(
    path.join(DATA_DIR, 'memory.json'),
    JSON.stringify(entries, null, 2),
    'utf8'
  );
}

// ---- 真实请求捕获：只包一层观察器，网络调用仍走原函数 ----
// 捕获的是 createChatCompletion 实际收到的 messages/tools/stream；
// 不替换实现、不返回伪造 completion，因此不构成 Stub。
function installProviderTap() {
  const adapterPath = require.resolve(path.join(SERVER, 'model-adapter.js'));
  const adapter = require(adapterPath);
  const original = adapter.createChatCompletion;
  const calls = [];

  function cloneMessages(messages) {
    return JSON.parse(JSON.stringify(Array.isArray(messages) ? messages : []));
  }

  adapter.createChatCompletion = async function tappedCreateChatCompletion(args) {
    const record = {
      index: calls.length + 1,
      providerId: args && args.providerId ? args.providerId : null,
      modelId: args && args.modelId ? args.modelId : null,
      stream: Boolean(args && args.stream),
      messages: cloneMessages(args && args.messages),
      toolNames:
        args && Array.isArray(args.tools)
          ? args.tools
              .map(tool => tool && tool.function && tool.function.name)
              .filter(Boolean)
          : [],
    };
    calls.push(record);

    let result;
    try {
      result = await original(args);
    } catch (error) {
      record.error = {
        kind: (error && error.kind) || (error && error.name) || 'error',
        message: String((error && error.message) || '').slice(0, 200),
      };
      throw error;
    }

    if (!record.stream && result) {
      const message =
        result.choices && result.choices[0] ? result.choices[0].message : null;
      record.response = {
        id: typeof result.id === 'string' ? result.id : null,
        model: typeof result.model === 'string' ? result.model : null,
        usage: result.usage
          ? {
              prompt_tokens: result.usage.prompt_tokens,
              completion_tokens: result.usage.completion_tokens,
              total_tokens: result.usage.total_tokens,
            }
          : null,
        toolCalls: Array.isArray(message && message.tool_calls)
          ? message.tool_calls.map(call => ({
              id: call && call.id ? call.id : null,
              name:
                call && call.function && call.function.name
                  ? call.function.name
                  : null,
            }))
          : [],
        contentLength:
          message && typeof message.content === 'string'
            ? message.content.length
            : 0,
      };
    }

    return result;
  };

  return { adapter, calls };
}

function hashMessages(list) {
  const canonical = list.map(message => ({
    role: (message && message.role) || null,
    content:
      message && typeof message.content === 'string' ? message.content : null,
    ...(message && message.tool_calls ? { tool_calls: message.tool_calls } : {}),
  }));
  return crypto
    .createHash('sha256')
    .update(JSON.stringify(canonical))
    .digest('hex');
}

function parseSse(text) {
  const events = [];
  for (const block of String(text || '').split('\n\n')) {
    for (const line of block.split('\n')) {
      if (!line.startsWith('data:')) continue;
      const raw = line.slice(5).trim();
      if (!raw) continue;
      try {
        events.push(JSON.parse(raw));
      } catch (_) {
        /* 非 JSON 事件忽略 */
      }
      break;
    }
  }
  return events;
}

async function main() {
  seedMemory();

  const tap = installProviderTap();

  // ---- 日志捕获：直接截获 stdout/stderr，避免任何模块替换 console 后漏记 ----
  // trace 走 stderr；同时用完整日志做密钥/正文泄露检查。
  const ORIG_STDOUT_WRITE = process.stdout.write.bind(process.stdout);
  const ORIG_STDERR_WRITE = process.stderr.write.bind(process.stderr);
  ORIG_LOG = (...args) =>
    ORIG_STDOUT_WRITE(args.map(String).join(' ') + '\n');
  ORIG_ERR = (...args) =>
    ORIG_STDERR_WRITE(args.map(String).join(' ') + '\n');
  const logLines = [];
  const errorLines = [];
  const captureWrite = targetLines => (chunk, encoding, callback) => {
    try {
      targetLines.push(
        typeof chunk === 'string' ? chunk : Buffer.from(chunk).toString('utf8')
      );
    } catch (_) {
      /* 捕获失败不能影响主流程 */
    }
    if (typeof encoding === 'function') encoding();
    else if (typeof callback === 'function') callback();
    return true;
  };
  process.stdout.write = captureWrite(logLines);
  process.stderr.write = captureWrite(errorLines);

  const { app } = require(path.join(SERVER, 'index.js'));

  const target = tap.adapter.resolveTarget({
    providerId: 'deepseek',
    modelId: MODEL_ID,
  });

  const server = await new Promise(resolve => {
    const instance = app.listen(0, '127.0.0.1', () => resolve(instance));
  });
  const base = `http://127.0.0.1:${server.address().port}`;

  async function postJson(url, body) {
    const res = await fetch(base + url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${API_TOKEN}`,
      },
      body: JSON.stringify(body),
    });
    const text = await res.text();
    let json = null;
    try {
      json = JSON.parse(text);
    } catch (_) {
      /* 非 JSON 响应保留原文供断言 */
    }
    return { status: res.status, json, text };
  }

  async function postSse(url, body) {
    const res = await fetch(base + url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${API_TOKEN}`,
      },
      body: JSON.stringify(body),
    });
    const text = await res.text();
    return { status: res.status, text };
  }

  async function newSession(title) {
    const res = await postJson('/sessions', { title });
    return res.json && res.json.session ? res.json.session.id : null;
  }

  function traces() {
    const marker = '[context-trace] ';
    return errorLines
      .join('')
      .split(/\r?\n/)
      .filter(line => line.includes(marker))
      .map(line => {
        try {
          return JSON.parse(line.slice(line.indexOf(marker) + marker.length));
        } catch (_) {
          return null;
        }
      })
      .filter(Boolean);
  }

  function traceFor(requestId) {
    const all = traces();
    if (requestId) {
      const matched = all.filter(item => item.requestId === requestId);
      if (matched.length) return matched[matched.length - 1];
    }
    return all.length ? all[all.length - 1] : null;
  }

  function resetEvidence() {
    // 只清请求捕获；日志保留到末尾做密钥/正文泄露检查。
    tap.calls.length = 0;
  }

  let passed = 0;
  let failed = 0;
  const failures = [];

  function check(group, name, cond, detail = '') {
    if (cond) {
      passed += 1;
      ORIG_LOG(`  ✔ ${name}${detail ? ` — ${detail}` : ''}`);
    } else {
      failed += 1;
      failures.push(`${group}: ${name}${detail ? ` — ${detail}` : ''}`);
      ORIG_LOG(`  ✖ ${name}${detail ? ` — ${detail}` : ''}`);
    }
  }

  // ---- 0. Provider 目标不是桩 ----
  ORIG_LOG('');
  ORIG_LOG('P4 真实端到端验证');
  ORIG_LOG('='.repeat(72));
  ORIG_LOG('0. Provider 目标');
  check(
    '0',
    'Provider 为内置真实 DeepSeek',
    target.providerId === 'deepseek' &&
      target.provider.builtin === true &&
      target.provider.baseUrl === 'https://api.deepseek.com',
    `${target.providerId} / ${target.provider.baseUrl}`
  );
  check(
    '0',
    '模型为声明 tools 能力的真实模型',
    target.modelId === MODEL_ID && target.model.capabilities.tools === true,
    `${target.modelId} tools=${target.model.capabilities.tools}`
  );

  // ---- 1. /chat：真实模型工具调用 ----
  ORIG_LOG('');
  ORIG_LOG('1. /chat 真实入口 → 真实 Provider → 真实工具调用');
  let chatAttempt = null;
  const chatAttempts = [];
  for (const prompt of [SEARCH_PROMPT, RETRY_PROMPT]) {
    resetEvidence();
    const sessionId = await newSession('p4-real-chat');
    const res = await postJson('/chat', { message: prompt, sessionId });
    const trace = traceFor(res.json && res.json.requestId);
    const firstResponse =
      tap.calls[0] && tap.calls[0].response ? tap.calls[0].response : null;
    const firstMemoryToolCalls = firstResponse
      ? firstResponse.toolCalls.filter(item => item.name === 'memory_search').length
      : 0;
    chatAttempts.push({
      status: res.status,
      replyLength:
        res.json && typeof res.json.reply === 'string' ? res.json.reply.length : 0,
      rounds: tap.calls.length,
      firstMemoryToolCalls,
    });
    chatAttempt = { res, trace, calls: tap.calls.slice(), sessionId };
    if (
      res.status === 200 &&
      res.json &&
      typeof res.json.reply === 'string' &&
      res.json.reply.trim() &&
      firstMemoryToolCalls >= 1
    ) {
      break;
    }
  }
  if (chatAttempts.length > 1) {
    ORIG_LOG(
      `  注意：首次尝试未触发 memory_search，使用强化提示重试后通过（尝试=${chatAttempts.length}）`
    );
    ORIG_LOG(`  各次尝试：${JSON.stringify(chatAttempts)}`);
  }

  const chat = chatAttempt;
  const chatOk = Boolean(
    chat &&
      chat.res.status === 200 &&
      chat.res.json &&
      typeof chat.res.json.reply === 'string' &&
      chat.res.json.reply.trim()
  );
  check(
    '1',
    'HTTP 200 且返回非空回复',
    chatOk,
    chat && chat.res && chat.res.json
      ? `status=${chat.res.status} replyLen=${String(chat.res.json.reply || '').length}`
      : `status=${chat && chat.res ? chat.res.status : 'n/a'}`
  );

  const chatCalls = chat ? chat.calls : [];
  const firstCall = chatCalls[0] || null;
  const lastCall = chatCalls.length ? chatCalls[chatCalls.length - 1] : null;
  check(
    '1',
    '真实模型调用了 memory_search',
    Boolean(
      firstCall &&
        firstCall.toolNames.includes('memory_search') &&
        firstCall.response &&
        firstCall.response.toolCalls.some(call => call.name === 'memory_search')
    ),
    firstCall && firstCall.response
      ? `tools=${firstCall.response.toolCalls.map(call => call.name).join(',')}`
      : '未观察到 tool_calls'
  );

  const toolCall =
    firstCall && firstCall.response
      ? firstCall.response.toolCalls.find(call => call.name === 'memory_search')
      : null;
  const nextCall = toolCall ? chatCalls[1] || null : null;
  const assistantCallMessage =
    nextCall && toolCall
      ? nextCall.messages.find(
          message =>
            message.role === 'assistant' &&
            Array.isArray(message.tool_calls) &&
            message.tool_calls.some(call => call.id === toolCall.id)
        )
      : null;
  const toolMessage =
    nextCall && toolCall
      ? nextCall.messages.find(
          message =>
            message.role === 'tool' && message.tool_call_id === toolCall.id
        )
      : null;
  let toolPayload = null;
  if (toolMessage) {
    try {
      toolPayload = JSON.parse(toolMessage.content);
    } catch (_) {
      toolPayload = null;
    }
  }

  check(
    '1',
    '工具调用与结果按 tool_call_id 配对回传下一轮',
    Boolean(assistantCallMessage && toolMessage),
    toolCall ? `callId=${toolCall.id}` : '无工具调用'
  );
  check(
    '1',
    'memory_search 实际执行成功且命中种子记忆',
    Boolean(
      toolPayload &&
        toolPayload.ok === true &&
        Array.isArray(toolPayload.results) &&
        toolPayload.results.some(item =>
          String(item && item.content ? item.content : '').includes('美式')
        )
    ),
    toolPayload
      ? `ok=${toolPayload.ok} results=${Array.isArray(toolPayload.results) ? toolPayload.results.length : 0}`
      : '工具结果不可解析'
  );

  const chatTrace = chat ? chat.trace : null;
  check('1', '输出结构化 Context trace', Boolean(chatTrace));
  check(
    '1',
    '上下文记忆块进入真实 Provider 请求',
    Boolean(
      firstCall &&
        String(firstCall.messages[0] && firstCall.messages[0].content).includes(
          '美式'
        ) &&
        chatTrace &&
        chatTrace.build &&
        Array.isArray(chatTrace.build.blocks) &&
        chatTrace.build.blocks.some(block => block.kind === 'memory') &&
        chatTrace.retrieval &&
        chatTrace.retrieval.accepted >= 1
    ),
    chatTrace && chatTrace.retrieval
      ? `accepted=${chatTrace.retrieval.accepted}`
      : '无检索证据'
  );
  check(
    '1',
    '首次请求携带工具 schema，工具结果进入后续轮次',
    Boolean(
      firstCall &&
        firstCall.toolNames.includes('memory_search') &&
        chatCalls.length >= 2 &&
        chatCalls
          .slice(1)
          .some(call => call.messages.some(message => message.role === 'tool')) &&
        chatTrace &&
        chatTrace.sent.rounds[0] &&
        chatTrace.sent.rounds[0].toolsCount > 0
    ),
    `calls=${chatCalls.length}`
  );
  check(
    '1',
    'trace 标识当前用户消息与工具结果消息',
    Boolean(
      chatTrace &&
        chatTrace.sent.rounds[0] &&
        chatTrace.sent.rounds[0].messageIds.includes('current-user') &&
        toolCall &&
        chatTrace.sent.rounds.some(
          round => round.messageIds && round.messageIds.includes(`tool:${toolCall.id}`)
        )
    ),
    toolCall ? `callId=${toolCall.id}` : '无工具调用'
  );
  check(
    '1',
    'trace 轮数等于真实 Provider 调用数',
    Boolean(
      chatCalls.length > 0 &&
        chatTrace &&
        chatTrace.sent.rounds.length === chatCalls.length
    ),
    chatTrace ? `traceRounds=${chatTrace.sent.rounds.length} calls=${chatCalls.length}` : ''
  );
  const hashMatches =
    chatTrace &&
    chatCalls.length > 0 &&
    chatCalls.every(
      (call, index) =>
        chatTrace.sent.rounds[index] &&
        chatTrace.sent.rounds[index].contentHash === hashMessages(call.messages)
    );
  check(
    '1',
    'trace 每轮 contentHash 与真实请求逐轮一致',
    Boolean(hashMatches),
    `${chatCalls.length}/${chatCalls.length}`
  );
  check(
    '1',
    'trace 记录真实 Provider/模型/非桩来源',
    Boolean(
      chatTrace &&
        chatTrace.sent.rounds.length > 0 &&
        chatTrace.sent.rounds.every(
          round =>
            round.providerId === 'deepseek' &&
            round.modelId === MODEL_ID &&
            round.providerKind === 'configured'
        )
    ),
    chatTrace && chatTrace.sent.rounds[0]
      ? `${chatTrace.sent.rounds[0].providerId}/${chatTrace.sent.rounds[0].modelId}/${chatTrace.sent.rounds[0].providerKind}`
      : ''
  );
  const realUsage =
    chatTrace && Array.isArray(chatTrace.sent.usage)
      ? chatTrace.sent.usage.find(
          item =>
            item.usageSource === 'provider' &&
            Number.isFinite(item.promptTokens) &&
            item.promptTokens > 0 &&
            item.calibration === true
        )
      : null;
  check(
    '1',
    'trace 记录 Provider 真实 usage 并可用于校准',
    Boolean(realUsage),
    realUsage
      ? `prompt=${realUsage.promptTokens} completion=${realUsage.completionTokens} ratio=${realUsage.estimateRatio}`
      : '未记录 provider usage'
  );
  check(
    '1',
    'trace 记录工具与 Agent 轮数',
    Boolean(
      chatTrace &&
        chatTrace.tools.some(tool => tool.name === 'memory_search' && tool.ok === true) &&
        chatTrace.agent &&
        chatTrace.agent.rounds >= 2 &&
        chatTrace.agent.toolCalls >= 1
    ),
    chatTrace && chatTrace.agent
      ? `rounds=${chatTrace.agent.rounds} toolCalls=${chatTrace.agent.toolCalls}`
      : ''
  );
  check(
    '1',
    '上下文验证通过',
    Boolean(chatTrace && chatTrace.verification && chatTrace.verification.ok === true),
    chatTrace && chatTrace.verification ? chatTrace.verification.reason || 'ok' : ''
  );
  check(
    '1',
    'trace 未伪造模型消费证据',
    Boolean(
      chatTrace &&
        chatTrace.sent.consumed === null &&
        /HTTP 成功不等于/.test(chatTrace.sent.consumedNote || '')
    )
  );

  const traceText = chatTrace ? JSON.stringify(chatTrace) : '';
  check(
    '1',
    'trace 不含用户记忆正文或密钥',
    Boolean(
      chatTrace &&
        !traceText.includes(SENTINEL) &&
        !traceText.includes(API_KEY)
    )
  );

  // ---- 2. /chat/stream：真实 UI 入口的工具调用 ----
  ORIG_LOG('');
  ORIG_LOG('2. /chat/stream 真实入口 → 真实 Provider → 真实工具调用');
  resetEvidence();
  const streamSessionId = await newSession('p4-real-stream');
  const streamRes = await postSse('/chat/stream', {
    message: SEARCH_PROMPT,
    sessionId: streamSessionId,
  });
  const streamEvents = parseSse(streamRes.text);
  const done = streamEvents.filter(event => event.type === 'done').pop() || null;
  const streamTrace = traceFor(done && done.requestId ? done.requestId : null);
  const streamCalls = tap.calls.slice();
  const streamFirst = streamCalls[0] || null;
  const toolStart = streamEvents.find(
    event => event.type === 'tool_start' && event.name === 'memory_search'
  );
  const toolEnd = streamEvents.find(
    event => event.type === 'tool_end' && event.name === 'memory_search'
  );
  const deltas = streamEvents.filter(
    event => event.type === 'delta' && typeof event.content === 'string'
  );

  check(
    '2',
    'SSE 返回 200，包含 tool_start / tool_end / delta / done',
    streamRes.status === 200 &&
      Boolean(toolStart) &&
      Boolean(toolEnd) &&
      deltas.length > 0 &&
      Boolean(done),
    `events=${streamEvents.length} deltas=${deltas.length}`
  );
  check(
    '2',
    'done 返回非空回复',
    Boolean(done && typeof done.reply === 'string' && done.reply.trim()),
    done ? `replyLen=${String(done.reply || '').length}` : '无 done'
  );
  check(
    '2',
    '真实模型在流式入口调用了 memory_search',
    Boolean(
      streamFirst &&
        streamFirst.toolNames.includes('memory_search') &&
        toolStart &&
        toolEnd &&
        toolEnd.ok === true
    ),
    `calls=${streamCalls.length}`
  );
  const streamToolMessage =
    streamCalls[1] &&
    streamCalls[1].messages.find(
      message => message.role === 'tool' && typeof message.tool_call_id === 'string'
    );
  check(
    '2',
    '流式路径工具结果回传下一轮',
    Boolean(
      streamToolMessage &&
        streamCalls[1].messages.some(
          message =>
            message.role === 'assistant' &&
            Array.isArray(message.tool_calls) &&
            message.tool_calls.some(call => call.id === streamToolMessage.tool_call_id)
        )
    ),
    streamToolMessage ? `callId=${streamToolMessage.tool_call_id}` : '未观察到工具消息'
  );
  check(
    '2',
    '流式首次请求携带工具 schema',
    Boolean(
      streamFirst &&
        streamFirst.toolNames.includes('memory_search') &&
        streamTrace &&
        streamTrace.sent.rounds[0] &&
        streamTrace.sent.rounds[0].toolsCount > 0
    ),
    streamFirst ? `tools=${streamFirst.toolNames.join(',')}` : ''
  );
  check(
    '2',
    '流式 trace 轮数与真实请求一致',
    Boolean(
      streamCalls.length > 0 &&
        streamTrace &&
        streamTrace.sent.rounds.length === streamCalls.length
    ),
    streamTrace ? `traceRounds=${streamTrace.sent.rounds.length} calls=${streamCalls.length}` : ''
  );
  check(
    '2',
    '流式 trace 每轮 contentHash 与真实请求一致',
    Boolean(
      streamTrace &&
        streamCalls.length > 0 &&
        streamCalls.every(
          (call, index) =>
            streamTrace.sent.rounds[index] &&
            streamTrace.sent.rounds[index].contentHash === hashMessages(call.messages)
        )
    ),
    `${streamCalls.length}/${streamCalls.length}`
  );
  check(
    '2',
    '流式 trace 记录真实 Provider/模型/非桩来源',
    Boolean(
      streamTrace &&
        streamTrace.sent.rounds.length > 0 &&
        streamTrace.sent.rounds.every(
          round =>
            round.providerId === 'deepseek' &&
            round.modelId === MODEL_ID &&
            round.providerKind === 'configured'
        )
    ),
    streamTrace && streamTrace.sent.rounds[0]
      ? `${streamTrace.sent.rounds[0].providerId}/${streamTrace.sent.rounds[0].modelId}/${streamTrace.sent.rounds[0].providerKind}`
      : ''
  );
  check(
    '2',
    '流式 trace 记录工具与上下文验证',
    Boolean(
      streamTrace &&
        streamTrace.tools.some(tool => tool.name === 'memory_search' && tool.ok === true) &&
        streamTrace.verification &&
        streamTrace.verification.ok === true
    ),
    streamTrace && streamTrace.agent
      ? `rounds=${streamTrace.agent.rounds} toolCalls=${streamTrace.agent.toolCalls}`
      : ''
  );
  check(
    '2',
    '流式 trace 未泄露记忆正文或密钥',
    Boolean(
      streamTrace &&
        !JSON.stringify(streamTrace).includes(SENTINEL) &&
        !JSON.stringify(streamTrace).includes(API_KEY)
    )
  );

  // ---- 3. 日志与密钥边界 ----
  ORIG_LOG('');
  ORIG_LOG('3. 日志与密钥边界');
  const allLogText = [...logLines, ...errorLines].join('');
  check('3', '进程日志不含 API Key', !allLogText.includes(API_KEY));
  check('3', '进程日志不记录 provider 请求正文', !allLogText.includes(SENTINEL));

  // ---- 汇总 ----
  ORIG_LOG('');
  ORIG_LOG('='.repeat(72));
  ORIG_LOG(`检查项：${passed + failed}，通过：${passed}，失败：${failed}`);
  if (failures.length) {
    ORIG_LOG('失败项：');
    for (const item of failures) ORIG_LOG(`  - ${item}`);
  }
  if (chat && chat.res && chat.res.json) {
    ORIG_LOG('');
    ORIG_LOG('证据摘要：');
    ORIG_LOG(`  /chat requestId=${chat.res.json.requestId || 'n/a'}`);
    ORIG_LOG(`  /chat 尝试次数=${chatAttempts.length}`);
    ORIG_LOG(`  /chat provider=${chat.res.json.providerId || 'n/a'} model=${chat.res.json.model || 'n/a'} upstream=${chat.res.json.upstreamModel || 'n/a'}`);
    const firstResponse = firstCall && firstCall.response ? firstCall.response : null;
    ORIG_LOG(
      `  /chat 真实调用轮数=${chatCalls.length} 首轮tool_calls=${firstResponse ? firstResponse.toolCalls.map(call => call.name).join(',') || 'none' : 'n/a'}`
    );
    const lastResponse = lastCall && lastCall.response ? lastCall.response : null;
    ORIG_LOG(
      `  /chat Provider completionId=${lastResponse && lastResponse.id ? lastResponse.id : 'n/a'} usage.prompt_tokens=${lastResponse && lastResponse.usage ? lastResponse.usage.prompt_tokens : 'n/a'}`
    );
    ORIG_LOG(
      `  回复（截断）：${String(chat.res.json.reply || '').replace(/\s+/g, ' ').slice(0, 120)}`
    );
    ORIG_LOG(`  流式 requestId=${done && done.requestId ? done.requestId : 'n/a'} 轮数=${streamCalls.length}`);
  }

  await new Promise(resolve => server.close(resolve));
  try {
    fs.rmSync(TMP_ROOT, { recursive: true, force: true });
  } catch (_) {
    /* ignore */
  }

  if (failed) {
    ORIG_LOG('');
    ORIG_LOG('FAILED — P4 真实链路已执行，但验收项未全部通过（见上）');
    process.exit(1);
  }
  ORIG_LOG('');
  ORIG_LOG(
    'VERIFIED — 真实 HTTP 入口 + Context Runtime + 真实 DeepSeek Provider + 真实工具调用通过'
  );
  process.exit(0);
}

main().catch(error => {
  ORIG_ERR('');
  ORIG_ERR(
    'P4 真实链路验证异常：',
    error && error.message ? error.message : error
  );
  try {
    fs.rmSync(TMP_ROOT, { recursive: true, force: true });
  } catch (_) {
    /* ignore */
  }
  process.exit(1);
});
