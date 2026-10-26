/* global __dirname, Buffer */
/**
 * 云岫 Bluebird — Context Engine 真实集成路径测试（context-engine-e2e.test.js）
 *
 * 自定义 runner（与 agent-tools.test.js 同款）：起真实 HTTP 服务，
 * 打开 BLUEBIRD_CONTEXT_ENGINE=1，验证：
 *   A. /chat 普通路径：引擎开启时 systemPrompt 注入引擎块（含检索上下文），
 *      响应结构不变（API 兼容）；
 *   B. /chat 与 /chat/stream 的 [context-trace] stderr 结构化输出（可解析 JSON，
 *      字段完整：route/planner/retrieval/adjudication/build/tools/verification）；
 *   C. 开关关闭时行为与改造前一致（不输出 trace、响应结构相同）；
 *   D. 工具调用结果进入 trace（Agent 路径，剧本含 tool_call → 结果回传）；
 *   F. 引擎抛错时回退旧路径（200，不 500，不输出 trace）；
 *   G. 引擎关闭时零加载（不加载 context 模块、不读取 config.json）。
 *
 * 隔离：BLUEBIRD_DATA_DIR 指向临时目录（require 前设置）；openai 桩零网络；
 * 记忆提取调用固定返回 {}（不消耗剧本）；PORT=0 动态端口。
 *
 * 运行：node tests/context-engine-e2e.test.js
 */
const fs = require('fs');
const os = require('os');
const path = require('path');

async function closeServer(server) {
  if (!server) return;
  try {
    if (typeof server.closeAllConnections === 'function') {
      server.closeAllConnections();
    }
  } catch (_) {
    /* ignore */
  }
  await new Promise(resolve => server.close(() => resolve()));
}

// ---- 环境隔离（必须在 require 任何服务端模块之前） ----
const TMP_ROOT = fs.mkdtempSync(path.join(os.tmpdir(), 'bluebird-ctx-e2e-'));
const DATA_DIR = path.join(TMP_ROOT, 'data');
fs.mkdirSync(DATA_DIR, { recursive: true });

process.env.BLUEBIRD_DATA_DIR = DATA_DIR;
process.env.BLUEBIRD_API_TOKEN = 'test-token';
process.env.DEEPSEEK_API_KEY = 'sk-stub-deepseek-0001';
process.env.PORT = '0';
// 引擎开关：各组自行翻转，结束前恢复
process.env.BLUEBIRD_CONTEXT_ENGINE = '1';

const SERVER = path.join(__dirname, '..', 'server');

// ---- openai 桩：按剧本返回；记忆提取调用不消耗剧本 ----
const RealOpenAI = require('openai');
const openaiTarget = require.resolve('openai', { paths: [SERVER] });

const scripted = [];
let callIndex = 0;
const stubCalls = [];

require.cache[openaiTarget] = {
  id: openaiTarget,
  filename: openaiTarget,
  loaded: true,
  exports: class StubOpenAI {
    constructor(config) {
      this.config = config;
      this.chat = {
        completions: {
          create: async args => {
            const system =
              args.messages &&
              args.messages[0] &&
              String(args.messages[0].content || '');
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
              const err = new Error(step.error.message || 'stub error');
              err.status = step.error.status;
              if (step.error.name) err.name = step.error.name;
              throw err;
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
    passed++;
    ORIG_LOG(`  ✔ ${name}`);
  } else {
    failed++;
    failures.push(name + (extra ? ` — ${extra}` : ''));
    ORIG_LOG(`  ✖ ${name}${extra ? ` — ${extra}` : ''}`);
  }
}

async function main() {
  const { app } = require(path.join(SERVER, 'index.js'));

  const server = await new Promise(resolve => {
    const s = app.listen(0, () => resolve(s));
  });
  const port = server.address().port;
  const base = `http://127.0.0.1:${port}`;

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
      /* SSE 流等非 JSON */
    }
    return { status: res.status, json, text };
  }

  async function newSession() {
    const res = await post('/sessions', {});
    const session = res.json && res.json.session;
    return session && session.id ? session.id : null;
  }

  // ============ F. 引擎异常：安全回退旧路径（不 500） ============
  // 必须放在 A 之前：引擎开关为 1 但尚未真正加载引擎模块，
  // 这里向 require.cache 注入一个必定抛错的假引擎，验证集成层回退。
  ORIG_LOG('\n[E2E-F] 引擎异常回退旧路径');
  logLines.length = 0;
  errorLines.length = 0;
  scripted.length = 0;
  callIndex = 0;
  stubCalls.length = 0;
  scripted.push({ content: '[calm] 引擎异常时的回退回复' });

  const engineTarget = require.resolve(path.join(SERVER, 'context', 'engine.js'));
  require.cache[engineTarget] = {
    id: engineTarget,
    filename: engineTarget,
    loaded: true,
    exports: {
      runContextEngine: async () => {
        throw new Error('stub engine boom');
      },
      renderContextBlocks: () => [],
      renderUntrustedContextBlock: () => null,
    },
  };

  const sessionF = await newSession();
  const resF = await post('/chat', { message: '你好', sessionId: sessionF });
  check('F1: 引擎抛错时 /chat 仍返回 200', resF.status === 200, `status=${resF.status}`);
  check('F2: 回退路径仍返回 reply', !!resF.json && typeof resF.json.reply === 'string');
  const traceLinesF = errorLines.filter(l => l.includes('[context-trace]'));
  check('F3: 引擎抛错时不输出 trace', traceLinesF.length === 0, `got ${traceLinesF.length}`);
  check(
    'F4: 显式记录回退原因',
    errorLines.some(l => l.includes('engine 异常，回退'))
  );
  const lastCallF = stubCalls[stubCalls.length - 1];
  const sysPromptF =
    lastCallF && Array.isArray(lastCallF.messages) && lastCallF.messages[0]
      ? String(lastCallF.messages[0].content || '')
      : '';
  check(
    'F5: 回退后 systemPrompt 不含引擎块',
    !!sysPromptF && !sysPromptF.includes('【引擎提供的相关上下文】')
  );

  // 删除假模块，后续组恢复真实引擎
  delete require.cache[engineTarget];

  // ============ A. /chat 普通路径：引擎开启注入引擎块 ============
  ORIG_LOG('\n[E2E-A] /chat 普通路径（引擎开启）');
  logLines.length = 0;
  errorLines.length = 0;
  scripted.length = 0;
  callIndex = 0;
  stubCalls.length = 0;
  scripted.push({ content: '[calm] 你好！这是引擎开启时的回复。' });

  const sessionA = await newSession();
  check('A0: 会话创建成功', !!sessionA);
  const resA = await post('/chat', {
    message: '你好',
    sessionId: sessionA,
  });
  check('A1: /chat 返回 200', resA.status === 200, `status=${resA.status} body=${resA.text.slice(0, 200)}`);
  check('A2: 响应结构兼容（含 reply/sessionId/mood）', !!resA.json && typeof resA.json.reply === 'string' && resA.json.sessionId === sessionA);
  check('A3: 响应 model 回执兼容', resA.json.model && typeof resA.json.model === 'string');

  // 引擎开启：stderr 应有 [context-trace] 结构化输出
  const traceLinesA = errorLines.filter(l => l.includes('[context-trace]'));
  check('A4: 引擎开启时输出 [context-trace] 行', traceLinesA.length === 1, `got ${traceLinesA.length}`);

  let traceA = null;
  if (traceLinesA.length) {
    try {
      traceA = JSON.parse(traceLinesA[0].replace('[context-trace] ', ''));
    } catch (_) {
      /* ignore */
    }
  }
  check('A5: trace 是合法 JSON', !!traceA);
  check('A6: trace 包含完整阶段字段', !!traceA && traceA.route && traceA.planner && traceA.retrieval && traceA.adjudication && traceA.build && traceA.verification && Array.isArray(traceA.tools));
  check('A7: trace 记录来源检索状态', !!traceA && traceA.retrieval.sources.length > 0);
  check(
    'A8: trace 只含元数据（无 task 正文，taskLength 为数字）',
    !!traceA && !('task' in traceA) && typeof traceA.taskLength === 'number'
  );

  // ============ B. /chat/stream 引擎开启 ============
  ORIG_LOG('\n[E2E-B] /chat/stream 普通路径（引擎开启）');
  logLines.length = 0;
  errorLines.length = 0;
  scripted.length = 0;
  callIndex = 0;
  scripted.push({ content: '[calm] 流式回复内容' });

  const sessionB = await newSession();
  const resB = await post('/chat/stream', {
    message: '讲个笑话',
    sessionId: sessionB,
  });
  check('B1: /chat/stream 返回 200', resB.status === 200);
  check('B2: SSE 流包含 done 事件', resB.text.includes('"type":"done"') || resB.text.includes('type: "done"'));
  const traceLinesB = errorLines.filter(l => l.includes('[context-trace]'));
  check('B3: stream 路径输出 trace', traceLinesB.length === 1, `got ${traceLinesB.length}`);

  // ============ C. 开关关闭：行为与改造前一致 ============
  ORIG_LOG('\n[E2E-C] /chat 开关关闭（兼容基线）');
  process.env.BLUEBIRD_CONTEXT_ENGINE = '';
  logLines.length = 0;
  errorLines.length = 0;
  scripted.length = 0;
  callIndex = 0;
  scripted.push({ content: '[calm] 关闭开关时的回复' });

  const sessionC = await newSession();
  const resC = await post('/chat', {
    message: '你好',
    sessionId: sessionC,
  });
  check('C1: /chat 仍返回 200', resC.status === 200);
  check('C2: 响应结构不变', !!resC.json && typeof resC.json.reply === 'string');
  const traceLinesC = errorLines.filter(l => l.includes('[context-trace]'));
  check('C3: 关闭时无 trace 输出（引擎零调用）', traceLinesC.length === 0, `got ${traceLinesC.length}`);
  check('C4: 关闭时无引擎日志', !logLines.some(l => l.includes('[context] engine')));

  // ============ D. Agent 路径：工具调用进入 trace ============
  ORIG_LOG('\n[E2E-D] Agent 工具路径（引擎 + 工具双开）');
  process.env.BLUEBIRD_CONTEXT_ENGINE = '1';
  process.env.BLUEBIRD_AGENT_TOOLS = '1';
  logLines.length = 0;
  errorLines.length = 0;
  scripted.length = 0;
  callIndex = 0;
  // 第一轮：请求调用 memory_search 工具；第二轮：最终文本
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
  scripted.push({ content: '[calm] 我查到了你的偏好。' });

  const sessionD = await newSession();
  const resD = await post('/chat', {
    message: '你喜欢喝什么？',
    sessionId: sessionD,
  });
  check('D1: Agent 路径 /chat 返回 200', resD.status === 200);
  const traceLinesD = errorLines.filter(l => l.includes('[context-trace]'));
  check('D2: Agent 路径输出 trace', traceLinesD.length >= 1, `got ${traceLinesD.length}`);

  let traceD = null;
  if (traceLinesD.length) {
    try {
      traceD = JSON.parse(traceLinesD[traceLinesD.length - 1].replace('[context-trace] ', ''));
    } catch (_) {
      /* ignore */
    }
  }
  check('D3: trace.tools 记录工具调用', !!traceD && Array.isArray(traceD.tools) && traceD.tools.length >= 1);
  check(
    'D4: 工具记录含名称与执行状态',
    !!traceD &&
      traceD.tools[0] &&
      traceD.tools[0].name === 'memory_search' &&
      typeof traceD.tools[0].ok === 'boolean'
  );
  check('D5: trace.verification.ok 存在', !!traceD && typeof traceD.verification.ok === 'boolean');

  // ============ E. Agent 流式路径 ============
  ORIG_LOG('\n[E2E-E] Agent 工具路径（stream）');
  scripted.length = 0;
  callIndex = 0;
  scripted.push({
    content: null,
    toolCalls: [
      {
        id: 'call-2',
        type: 'function',
        function: {
          name: 'memory_search',
          arguments: JSON.stringify({ query: '猫', limit: 3 }),
        },
      },
    ],
  });
  scripted.push({ content: '[calm] 你的猫叫年糕。' });

  const sessionE = await newSession();
  const resE = await post('/chat/stream', {
    message: '我的猫叫什么？',
    sessionId: sessionE,
  });
  check('E1: Agent stream 路径返回 200', resE.status === 200);
  const traceLinesE = errorLines.filter(l => l.includes('[context-trace]'));
  check('E2: stream Agent 路径输出 trace', traceLinesE.length >= 1, `got ${traceLinesE.length}`);

  await closeServer(server);

  // ============ G. 引擎关闭：不加载引擎模块、不读取引擎配置 ============
  // 子进程把 context/config.json 的读取改成抛错，再以关闭状态 require 服务：
  // 旧实现会在启动时加载引擎→读配置→直接启动失败；修复后应正常退出。
  ORIG_LOG('\n[E2E-G] 引擎关闭时零加载（子进程验证）');
  const { spawnSync } = require('child_process');
  const gData = path.join(TMP_ROOT, 'data-g');
  fs.mkdirSync(gData, { recursive: true });

  const childScript = [
    "const fs = require('fs');",
    "const path = require('path');",
    "const original = fs.readFileSync;",
    "fs.readFileSync = function (p, ...args) {",
    "  if (String(p).endsWith(path.join('context', 'config.json'))) {",
    "    throw new Error('CONTEXT_CONFIG_READ_BLOCKED');",
    "  }",
    "  return original.call(this, p, ...args);",
    "};",
    "require(path.join(process.cwd(), 'server', 'index.js'));",
    "const loaded = Object.keys(require.cache).some(k => k.includes(path.join('server', 'context')));",
    "process.stdout.write('CTX_LOADED=' + loaded + '\\n', function () { process.exit(0); });",
  ].join('\n');

  const envG = { ...process.env, BLUEBIRD_DATA_DIR: gData, PORT: '0' };
  delete envG.BLUEBIRD_CONTEXT_ENGINE;

  const child = spawnSync(process.execPath, ['-e', childScript], {
    cwd: path.join(__dirname, '..'),
    env: envG,
    encoding: 'utf8',
    timeout: 30000,
  });

  check(
    'G1: 引擎关闭时不读引擎配置（子进程正常退出）',
    child.status === 0,
    `status=${child.status} stderr=${String(child.stderr || '').slice(0, 200)}`
  );
  check(
    'G2: 引擎关闭时不加载 context 模块',
    String(child.stdout || '').includes('CTX_LOADED=false'),
    `stdout=${String(child.stdout || '').slice(0, 200)}`
  );

  fs.rmSync(gData, { recursive: true, force: true });

  ORIG_LOG(`\ncontext-engine-e2e: ${passed} passed, ${failed} failed`);
  if (failed) {
    ORIG_LOG('Failures:');
    for (const f of failures) ORIG_LOG('  - ' + f);
    process.exit(1);
  }

  // 与其他自定义 runner 一致：显式退出。本进程可能残留定时器/句柄，
  // 不显式 exit 会让 npm test / CI 永远挂在这一步（Windows 已复现）。
  process.exit(0);
}

main().catch(error => {
  ORIG_ERR('e2e runner error:', error);
  process.exit(1);
});
