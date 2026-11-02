/**
 * 云岫 Bluebird — Context Trace 可核对性（P2-5 / P2-6）
 *
 * 用真实 /chat 入口 + 模块级桩 Provider，验证两件事：
 *   1. trace.sent.rounds[].contentHash 能由「Provider 实际收到的 messages」复算出来
 *      —— 也就是说 Trace 记录的不是「打算发什么」，而是「真的发了什么」；
 *   2. 桩返回的 usage 被标成 usage_source='stub'，不会冒充供应商真实统计。
 *
 * 桩方式与 memory-golden-path 一致：替换 require.cache 里的 openai 模块。
 * 运行：node tests/context-trace-verify.test.js
 */
const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const assert = require('node:assert/strict');

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'bluebird-trace-verify-'));
const DATA_DIR = path.join(TMP, 'data');
fs.mkdirSync(DATA_DIR, { recursive: true });
fs.writeFileSync(path.join(DATA_DIR, 'memory.json'), '[]');

process.env.BLUEBIRD_DATA_DIR = DATA_DIR;
process.env.BLUEBIRD_API_TOKEN = 'test-token-trace-verify';
process.env.DEEPSEEK_API_KEY = 'sk-stub-trace-verify';
process.env.PORT = '0';
process.env.BLUEBIRD_AGENT_TOOLS = '';
process.env.BLUEBIRD_MONITORING = '0';
// 测试进程里的模型调用一律是桩：显式声明，监控与 trace 都按 stub 记账。
process.env.BLUEBIRD_PROVIDER_KIND = 'stub';

const SERVER = path.join(__dirname, '..', 'server');
const openaiTarget = require.resolve('openai', { paths: [SERVER] });

// 桩 Provider 捕获到的真实请求（只保留判断需要的字段）
const providerCalls = [];

require.cache[openaiTarget] = {
  id: openaiTarget,
  filename: openaiTarget,
  loaded: true,
  exports: class StubOpenAI {
    constructor() {
      this.chat = {
        completions: {
          create: async args => {
            const system =
              args.messages && args.messages[0]
                ? String(args.messages[0].content || '')
                : '';
            const isExtractor = system.includes('长期记忆提取器');

            if (!isExtractor) {
              providerCalls.push({ messages: args.messages });
            }

            return {
              model: 'stub-model',
              choices: [
                {
                  message: {
                    role: 'assistant',
                    content: isExtractor ? '{}' : '[calm] 我记下了。',
                  },
                },
              ],
              // 桩也返回 usage：用来验证它会被标成 stub 而不是 provider
              usage: { prompt_tokens: 321, completion_tokens: 12, total_tokens: 333 },
            };
          },
        },
      };
    }
  },
};

// 捕获 context trace 输出（server 通过 console.error 打印一行 JSON）
const traceLines = [];
const originalError = console.error;
console.error = (...args) => {
  const first = args[0];
  if (typeof first === 'string' && first.startsWith('[context-trace] ')) {
    try {
      traceLines.push(JSON.parse(first.slice('[context-trace] '.length)));
    } catch (_) {
      /* 解析失败不影响主流程 */
    }
    return;
  }
  originalError(...args);
};

const { server } = require(path.join(SERVER, 'index.js'));

const TOKEN = 'test-token-trace-verify';
let BASE = '';

// 与其它自定义 runner 测试保持同一输出格式，便于 scripts/verify-test-coverage.js 统计。
let passed = 0;
let failed = 0;
const failures = [];

function check(name, fn) {
  try {
    fn();
    passed += 1;
    originalError(`  ✔ ${name}`);
  } catch (error) {
    failed += 1;
    failures.push(`${name} — ${error && error.message ? error.message : error}`);
    originalError(`  ✖ ${name} — ${error && error.message ? error.message : error}`);
  }
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

async function waitReady() {
  for (let i = 0; i < 100; i += 1) {
    try {
      const res = await fetch(`${BASE}/`);
      if (res.ok) return true;
    } catch (_) {
      /* 还没起来 */
    }
    await new Promise(resolve => setTimeout(resolve, 50));
  }
  return false;
}

async function postJson(urlPath, body) {
  const res = await fetch(`${BASE}${urlPath}`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${TOKEN}`,
    },
    body: JSON.stringify(body),
  });
  let json = null;
  try {
    json = await res.json();
  } catch (_) {
    /* ignore */
  }
  return { status: res.status, json };
}

async function postChat(body) {
  return postJson('/chat', body);
}

async function main() {
  if (!server.listening) {
    await new Promise(resolve => server.once('listening', resolve));
  }
  BASE = `http://127.0.0.1:${server.address().port}`;

  const ready = await waitReady();
  assert.ok(ready, '服务未能就绪');

  const created = await postJson('/sessions', { title: 'trace-verify' });
  assert.ok(
    created.status === 200 || created.status === 201,
    `建会话失败：${JSON.stringify(created.json)}`
  );
  const sessionId =
    (created.json && created.json.session && created.json.session.id) ||
    (created.json && created.json.id);

  const sent = await postChat({
    sessionId,
    message: '我喝咖啡有什么习惯？',
  });

  check('聊天接口成功返回', () => {
    assert.equal(sent.status, 200, `聊天接口应成功：${JSON.stringify(sent.json)}`);
  });

  check('桩 Provider 确实收到请求', () => {
    assert.ok(providerCalls.length >= 1, '桩 Provider 应当收到至少一次调用');
  });

  const actual = providerCalls[providerCalls.length - 1] || { messages: [] };
  const actualHash = hashMessages(actual.messages);

  check('context trace 已输出且包含 sent 证据', () => {
    assert.ok(traceLines.length >= 1, '应当输出至少一条 context trace');
    const latest = traceLines[traceLines.length - 1];
    assert.ok(Array.isArray(latest.sent.rounds) && latest.sent.rounds.length >= 1);
  });

  const trace = traceLines[traceLines.length - 1];
  const round = trace.sent.rounds[trace.sent.rounds.length - 1];
  const usage = trace.sent.usage[trace.sent.usage.length - 1];

  check('Trace 内容指纹等于 Provider 实际收到的内容', () => {
    assert.equal(
      round.contentHash,
      actualHash,
      'Trace 的内容指纹必须等于 Provider 实际收到的内容'
    );
  });

  check('发送轮次带估算 Token 并标注来源', () => {
    assert.ok(round.messageCount >= 1);
    assert.ok(round.estimatedTokens > 0, '必须给出本轮估算输入 Token');
    assert.equal(round.tokenSource, 'estimate', '估算值必须标注来源');
  });

  check('桩 usage 标记为 stub，不冒充真实统计', () => {
    assert.equal(usage.usageSource, 'stub', '桩返回的 usage 必须标 stub');
    assert.equal(usage.calibration, false, '桩数据不参与估算校准');
    assert.equal(usage.withinTolerance, null);
    assert.equal(usage.providerKind, 'stub');
    assert.equal(usage.promptTokens, 321);
  });

  check('估算与真实计数同时保留，可对比', () => {
    assert.ok(Number.isFinite(usage.estimateRatio), '应当给出 真实/估算 比值');
    assert.ok(usage.estimatedInputTokens > 0);
  });

  check('上下文计量带块级 Token 与记忆 Token 归属', () => {
    assert.ok(trace.build && Array.isArray(trace.build.blockTokens));
    assert.equal(trace.build.tokenSource, 'estimate');
    assert.ok(
      Number.isFinite(trace.build.memoryTokens),
      'memoryTokens 必须是数字（无记忆时为 0）'
    );
  });

  check('检索漏斗字段存在，可回答「为什么没注入」', () => {
    assert.ok(trace.retrieval, 'trace 必须包含检索段');
    assert.ok(trace.retrieval.funnel, 'trace 必须包含检索漏斗');
    assert.ok(
      Number.isFinite(trace.retrieval.funnel.store_total),
      '漏斗必须给出库总量'
    );
  });

  // 收尾：先断开 keep-alive 连接再等事件循环排空。强退（process.exit）会在
  // Windows 上触发 libuv 断言（src/win/async.c），断言全绿也以非零码退出。
  if (typeof server.closeAllConnections === 'function') {
    server.closeAllConnections();
  }
  await new Promise(resolve => server.close(resolve));
}

main()
  .then(() => {
    console.error = originalError;
    fs.rmSync(TMP, { recursive: true, force: true });
    originalError(`\n通过 ${passed} 项，失败 ${failed} 项`);
    if (failed > 0) {
      for (const item of failures) originalError(`  失败明细：${item}`);
    }
    // 不调用 process.exit：等句柄自然排空，避免 Windows 上 libuv 断言
    process.exitCode = failed > 0 ? 1 : 0;
  })
  .catch(error => {
    console.error = originalError;
    originalError(
      `\n通过 ${passed} 项，失败 ${failed + 1} 项`
    );
    originalError('context trace 校验异常：', error && error.message ? error.message : error);
    try {
      fs.rmSync(TMP, { recursive: true, force: true });
    } catch (_) {
      /* ignore */
    }
    process.exitCode = 1;
  });
