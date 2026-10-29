/* global __dirname, Buffer */
/**
 * 云岫 Bluebird — Context Runtime v3 真实 HTTP 集成测试
 *
 * 起真实 Express 服务（openai 桩零网络），验证：
 *   A. 单一链路：BLUEBIRD_CONTEXT_ENGINE 不再决定是否启用上下文运行时；
 *   B. 长历史：最近 20 条以外的关键事实通过召回/摘要进入真实请求；
 *   C. 近期原文不重复注入 systemPrompt；
 *   D. /chat/stream 与 /chat 使用同一运行时；
 *   E. Agent 工具结果回传、sent 多轮 trace、工具元数据；
 *   F. 输入保护：超限显式 413，windowSource 如实标注；
 *   G. 会话隔离与 trace 隐私（无正文）。
 */
const fs = require('fs');
const os = require('os');
const path = require('path');

const TMP_ROOT = fs.mkdtempSync(path.join(os.tmpdir(), 'bluebird-ctx-v3-e2e-'));
const DATA_DIR = path.join(TMP_ROOT, 'data');
fs.mkdirSync(DATA_DIR, { recursive: true });

process.env.BLUEBIRD_DATA_DIR = DATA_DIR;
process.env.BLUEBIRD_API_TOKEN = 'test-token';
process.env.DEEPSEEK_API_KEY = 'sk-stub-deepseek-0001';
process.env.PORT = '0';
delete process.env.BLUEBIRD_CONTEXT_ENGINE;

const SERVER = path.join(__dirname, '..', 'server');

// ---- 种子会话：必须在 require index 前写入，index 启动时读取同一存储 ----
const sessions = require(path.join(SERVER, 'sessions'));

sessions.createSession({ title: 'ctx-long-history' });
const longSessionId = sessions.listSessions()[0].id;

const FACT = '项目代号是 ORBIT-7742';
const SECRET = 'E2E-SECRET-SENTINEL-LEAK-CHECK-4f2a';
const longItems = [];
for (let i = 0; i < 80; i += 1) {
  let content =
    i === 2
      ? `我的${FACT}，只有这个代号有效。${SECRET}`
      : i === 10
        ? '我决定预算上限改成 8000 元，之前说的 5000 不再有效。'
        : `第 ${i} 条历史消息：${'这是普通对话内容，用于占满近期预算。'.repeat(4)}`;
  longItems.push({
    id: `seed-${i}`,
    role: i % 2 === 0 ? 'user' : 'assistant',
    content,
    createdAt: new Date(Date.UTC(2026, 0, 1, 0, i)).toISOString(),
  });
}
sessions.appendMessages(longSessionId, longItems);

// ---- openai 桩 ----
const openaiTarget = require.resolve('openai', { paths: [SERVER] });
const scripted = [];
let callIndex = 0;
const stubCalls = [];

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
            if (system.includes('长期记忆提取器')) {
              return {
                model: 'deepseek-chat',
                choices: [{ message: { role: 'assistant', content: '{}' } }],
              };
            }

            stubCalls.push(args);
            const step = scripted[callIndex] || { content: '[calm] 默认回复' };
            callIndex += 1;

            if (step.error) {
              const error = new Error(step.error.message || 'stub error');
              error.status = step.error.status;
              throw error;
            }
            if (args.stream) {
              const text = typeof step.content === 'string' ? step.content : '';
              return (async function* () {
                if (text) {
                  yield {
                    model: 'deepseek-chat',
                    choices: [{ index: 0, delta: { content: text } }],
                  };
                }
              })();
            }
            if (step.toolCalls) {
              return {
                model: 'deepseek-chat',
                choices: [
                  {
                    message: {
                      role: 'assistant',
                      content: step.content ?? null,
                      tool_calls: step.toolCalls,
                    },
                  },
                ],
              };
            }
            return {
              model: 'deepseek-chat',
              choices: [
                {
                  message: {
                    role: 'assistant',
                    content: step.content ?? '[calm] 默认回复',
                  },
                },
              ],
            };
          },
        },
      };
    }
  },
};

// ---- 日志捕获 ----
const ORIG_LOG = console.log;
const ORIG_ERR = console.error;
const logLines = [];
const errorLines = [];
console.log = (...args) => {
  logLines.push(args.map(String).join(' '));
};
console.error = (...args) => {
  errorLines.push(args.map(String).join(' '));
};

let passed = 0;
let failed = 0;
const failures = [];

function check(name, cond, extra = '') {
  if (cond) {
    passed += 1;
    ORIG_LOG(`  ✔ ${name}`);
  } else {
    failed += 1;
    failures.push(name + (extra ? ` — ${extra}` : ''));
    ORIG_LOG(`  ✖ ${name}${extra ? ` — ${extra}` : ''}`);
  }
}

function resetGroups() {
  logLines.length = 0;
  errorLines.length = 0;
  scripted.length = 0;
  callIndex = 0;
  stubCalls.length = 0;
}

function traces() {
  return errorLines
    .filter(line => line.includes('[context-trace]'))
    .map(line => {
      try {
        return JSON.parse(line.replace('[context-trace] ', ''));
      } catch (_) {
        return null;
      }
    })
    .filter(Boolean);
}

async function main() {
  const { app } = require(path.join(SERVER, 'index.js'));
  const server = await new Promise(resolve => {
    const instance = app.listen(0, () => resolve(instance));
  });
  const base = `http://127.0.0.1:${server.address().port}`;

  async function post(url, body) {
    const res = await fetch(base + url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: 'Bearer test-token',
      },
      body: JSON.stringify(body),
    });
    const text = await res.text();
    let json = null;
    try {
      json = JSON.parse(text);
    } catch (_) {
      /* SSE */
    }
    return { status: res.status, json, text };
  }

  async function newSession(title) {
    const res = await post('/sessions', { title: title || 'ctx-e2e' });
    return res.json && res.json.session ? res.json.session.id : null;
  }

  // ============ A. 单一链路：开关不再决定启用 ============
  ORIG_LOG('\n[E2E-A] BLUEBIRD_CONTEXT_ENGINE=0 仍走 v3 运行时');
  resetGroups();
  process.env.BLUEBIRD_CONTEXT_ENGINE = '0';
  scripted.push({ content: '[calm] 单一链路回复' });
  const sessionA = await newSession('ctx-a');
  const resA = await post('/chat', { message: '你好', sessionId: sessionA });
  check('A1: /chat 返回 200', resA.status === 200, `status=${resA.status}`);
  check('A2: 响应结构兼容', !!resA.json && typeof resA.json.reply === 'string');
  const traceA = traces().pop();
  check('A3: 开关为 0 仍输出结构化 trace', !!traceA);
  check(
    'A4: trace 含历史/构建/验证/sent 证据',
    !!traceA &&
      traceA.history &&
      traceA.build &&
      traceA.verification &&
      Array.isArray(traceA.sent.rounds) &&
      traceA.sent.rounds.length === 1
  );
  check(
    'A5: 模型窗口未声明时如实标注 unknown_guard',
    !!traceA &&
      traceA.build.measurement.window.source === 'unknown_guard' &&
      traceA.build.measurement.window.verified === false
  );
  const callA = stubCalls[stubCalls.length - 1];
  check(
    'A6: 实际请求=system+历史+当前消息',
    !!callA &&
      Array.isArray(callA.messages) &&
      callA.messages[0].role === 'system' &&
      callA.messages[callA.messages.length - 1].content === '你好'
  );
  delete process.env.BLUEBIRD_CONTEXT_ENGINE;

  // ============ B. 长历史：20 条以外的事实进入真实请求 ============
  ORIG_LOG('\n[E2E-B] 长历史召回与摘要进入真实请求');
  resetGroups();
  scripted.push({ content: '[calm] 代号是 ORBIT-7742' });
  const resB = await post('/chat', {
    message: '我的项目代号是什么？',
    sessionId: longSessionId,
  });
  check('B1: /chat 返回 200', resB.status === 200, `status=${resB.status}`);
  const traceB = traces().pop();
  check('B2: trace 最近原文超过 20 条', !!traceB && traceB.history.recent > 20, traceB ? `recent=${traceB.history.recent}` : '');
  check('B3: trace 记录长程召回', !!traceB && traceB.history.recalled >= 1);
  check('B4: trace 记录摘要来源', !!traceB && traceB.history.summary.count >= 1);
  check(
    'B5: trace 注入/发送上下文 ID 一致',
    !!traceB &&
      JSON.stringify([...traceB.build.contextIds].sort()) ===
        JSON.stringify([...traceB.sent.rounds[0].contextIds].sort())
  );
  check(
    'B6: sent 消息包含当前任务与近期历史标识，召回项在上下文 ID 中',
    !!traceB &&
      traceB.sent.rounds[0].messageIds.includes('current-user') &&
      traceB.sent.rounds[0].messageIds.some(id => id && id.startsWith('seed-')) &&
      traceB.build.contextIds.includes('recalled:seed-2')
  );
  const callB = stubCalls[stubCalls.length - 1];
  const sysB = callB ? String(callB.messages[0].content || '') : '';
  const msgContentsB = callB
    ? callB.messages.map(message => String(message.content || ''))
    : [];
  check('B7: systemPrompt 含 20 条以外的事实', sysB.includes(FACT));
  check('B8: systemPrompt 含摘要中的决策', sysB.includes('8000'));
  check(
    'B9: 真实请求的历史消息超过 20 条',
    !!callB && callB.messages.length > 22,
    callB ? `messages=${callB.messages.length}` : ''
  );
  check(
    'B10: 近期用户原句不重复进入 systemPrompt',
    !!callB &&
      !sysB.includes('第 78 条历史消息') &&
      msgContentsB.some(content => content.includes('第 78 条历史消息'))
  );

  // ============ C. 流式路径使用同一运行时 ============
  ORIG_LOG('\n[E2E-C] /chat/stream 使用同一运行时');
  resetGroups();
  scripted.push({ content: '[calm] 流式回复' });
  const resC = await post('/chat/stream', {
    message: '我的项目代号是什么？',
    sessionId: longSessionId,
  });
  check('C1: 流式返回 200', resC.status === 200, `status=${resC.status}`);
  check('C2: 流式返回 delta/done', resC.text.includes('"type":"delta"') && resC.text.includes('"type":"done"'));
  const traceC = traces().pop();
  check('C3: 流式输出 trace', !!traceC);
  const callC = stubCalls[stubCalls.length - 1];
  const sysC = callC ? String(callC.messages[0].content || '') : '';
  check('C4: 流式 systemPrompt 含长程事实', sysC.includes(FACT));
  check(
    'C5: 流式 sent 记录上下文 ID',
    !!traceC && traceC.sent.rounds.length === 1 && traceC.sent.rounds[0].contextIds.length > 0
  );

  // ============ D. Agent 工具路径 ============
  ORIG_LOG('\n[E2E-D] Agent 工具结果回传与多轮 sent trace');
  resetGroups();
  process.env.BLUEBIRD_AGENT_TOOLS = '1';
  scripted.push({
    content: null,
    toolCalls: [
      {
        id: 'call-1',
        type: 'function',
        function: {
          name: 'memory_search',
          arguments: JSON.stringify({ query: '咖啡', limit: 3 }),
        },
      },
    ],
  });
  scripted.push({ content: '[calm] 工具已执行，最终回复' });
  const sessionD = await newSession('ctx-agent');
  const resD = await post('/chat', { message: '帮我查一下咖啡记忆', sessionId: sessionD });
  check('D1: Agent 路径返回 200', resD.status === 200, `status=${resD.status}`);
  const traceD = traces().pop();
  check('D2: trace 记录工具元数据', !!traceD && traceD.tools.length === 1 && traceD.tools[0].name === 'memory_search');
  check('D3: trace 记录多轮 sent', !!traceD && traceD.sent.rounds.length >= 2, traceD ? `rounds=${traceD.sent.rounds.length}` : '');
  const secondCall = stubCalls[stubCalls.length - 1];
  check(
    'D4: 工具结果确实进入下一轮模型请求',
    !!secondCall &&
      Array.isArray(secondCall.messages) &&
      secondCall.messages.some(message => message.role === 'tool' && message.tool_call_id === 'call-1')
  );
  check(
    'D5: Agent 输入预算包含工具预留',
    !!traceD && traceD.build.measurement.toolsReserveTokens > 0,
    traceD ? `reserve=${traceD.build.measurement.toolsReserveTokens}` : ''
  );
  delete process.env.BLUEBIRD_AGENT_TOOLS;

  // ============ E. 会话隔离 ============
  ORIG_LOG('\n[E2E-E] 会话隔离');
  resetGroups();
  scripted.push({ content: '[calm] A 回复' });
  scripted.push({ content: '[calm] B 回复' });
  const sessionE1 = await newSession('ctx-e1');
  const sessionE2 = await newSession('ctx-e2');
  const factE1 = '会话E1的专属事实是喜欢蓝色';
  const factE2 = '会话E2的专属事实是喜欢绿色';
  await post('/chat', { message: factE1, sessionId: sessionE1 });
  await post('/chat', { message: factE2, sessionId: sessionE2 });
  const callE2 = stubCalls[stubCalls.length - 1];
  const allE2 = callE2
    ? callE2.messages.map(message => JSON.stringify(message.content)).join('\n')
    : '';
  check('E1: 第二个会话请求不包含第一个会话事实', !allE2.includes(factE1));
  check('E2: 第二个会话包含自己的事实', allE2.includes(factE2));

  // ============ F. 输入保护：超限显式失败 ============
  ORIG_LOG('\n[E2E-F] 输入保护超限显式 413');
  resetGroups();
  const sessionF = await newSession('ctx-big');
  const resF = await post('/chat', {
    message: '字'.repeat(25000),
    sessionId: sessionF,
  });
  check('F1: 超限返回 413', resF.status === 413, `status=${resF.status}`);
  check(
    'F2: 错误码为 context_too_large',
    !!resF.json && resF.json.code === 'context_too_large'
  );
  const traceF = traces().pop();
  check('F3: 超限也输出 trace 证据', !!traceF && traceF.build.ok === false);
  check(
    'F4: 超限 trace 标注 windowSource',
    !!traceF &&
      traceF.build.measurement &&
      traceF.build.measurement.window &&
      traceF.build.measurement.window.source === 'unknown_guard'
  );

  // ============ H. 模型失败也保留 trace 证据 ============
  ORIG_LOG('\n[E2E-H] 模型失败路径 trace');
  resetGroups();
  scripted.push({ error: { message: 'stub model failure', status: 500 } });
  const sessionH = await newSession('ctx-model-error');
  const resH = await post('/chat', { message: '触发模型失败', sessionId: sessionH });
  check('H1: 模型失败返回结构化错误', resH.status === 502, `status=${resH.status}`);
  const traceH = traces().pop();
  check('H2: 模型失败仍输出 trace', !!traceH);
  check(
    'H3: trace 记录已发送请求与上下文构建成功',
    !!traceH &&
      traceH.build.ok === true &&
      traceH.sent.rounds.length === 1 &&
      traceH.sent.rounds[0].messageIds.includes('current-user')
  );

  // ============ G. trace 隐私 ============
  ORIG_LOG('\n[E2E-G] trace 隐私');
  resetGroups();
  scripted.push({ content: '[calm] 隐私检查回复' });
  await post('/chat', { message: '我的项目代号是什么？', sessionId: longSessionId });
  const traceG = traces().pop();
  const traceText = JSON.stringify(traceG);
  check('G1: trace 不含历史正文哨兵', !traceText.includes(SECRET));
  check('G2: trace 不含历史正文关键事实', !traceText.includes(FACT));
  check(
    'G3: consumed 未伪造——固定为 null 并有说明',
    !!traceG && traceG.sent.consumed === null && /HTTP 成功不等于/.test(traceG.sent.consumedNote)
  );

  ORIG_LOG(`\ncontext-engine-e2e: ${passed} passed, ${failed} failed`);
  if (failed) {
    ORIG_LOG('Failures:');
    for (const item of failures) ORIG_LOG('  - ' + item);
  }

  await new Promise(resolve => server.close(resolve));
  try {
    fs.rmSync(TMP_ROOT, { recursive: true, force: true });
  } catch (_) {
    /* ignore */
  }
  process.exit(failed ? 1 : 0);
}

main().catch(error => {
  ORIG_ERR('e2e runner error:', error);
  process.exit(1);
});
