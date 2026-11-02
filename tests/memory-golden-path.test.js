/**
 * 阶段1 Golden Path：写入一条记忆，主控下一轮能实际使用
 *
 * 通过真实 /chat 主控入口（桩 LLM Provider）验证端到端闭环：
 * - 第1轮：Agent 经 memory_remember 工具写入记忆（落盘 active）；
 * - 第2轮：主控提问，最终发给 Provider 的 messages 里包含该记忆
 *   （桩捕获 create() 的完整参数，断言 system prompt 出现记忆块）；
 * - 第3轮：换一个 Session 提问，不得泄漏上一会话写入的记忆（隔离）。
 *
 * 依据：《Bluebird 记忆系统端到端链路》阶段1 + 阶段0审计缺口1。
 * 运行：node tests/memory-golden-path.test.js
 */
const fs = require('fs');
const os = require('os');
const path = require('path');

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'bluebird-golden-path-'));
const DATA_DIR = path.join(TMP, 'data');
fs.mkdirSync(DATA_DIR, { recursive: true });
fs.writeFileSync(path.join(DATA_DIR, 'memory.json'), '[]');
process.env.BLUEBIRD_DATA_DIR = DATA_DIR;
process.env.BLUEBIRD_API_TOKEN = 'test-token-golden-path';
process.env.DEEPSEEK_API_KEY = 'sk-stub-golden-path';
process.env.PORT = '0';
process.env.BLUEBIRD_AGENT_TOOLS = '1';

const SERVER = path.join(__dirname, '..', 'server');
const scripted = [];
let callIndex = 0;
const allCalls = [];

const openaiTarget = require.resolve('openai', { paths: [SERVER] });

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
            allCalls.push({
              isExtractor,
              system,
              messages: args.messages,
            });

            if (isExtractor) {
              return {
                model: 'deepseek-chat',
                choices: [{ message: { role: 'assistant', content: '{}' } }],
              };
            }

            const step = scripted[callIndex] || { content: '[calm] 默认回复' };
            callIndex += 1;

            if (step.toolCalls) {
              return {
                model: 'deepseek-chat',
                choices: [
                  {
                    message: {
                      role: 'assistant',
                      content: null,
                      tool_calls: step.toolCalls,
                    },
                  },
                ],
              };
            }

            return {
              model: 'deepseek-chat',
              choices: [
                { message: { role: 'assistant', content: step.content || '[calm] ok' } },
              ],
            };
          },
        },
      };
    }
  },
};

const { server } = require(path.join(SERVER, 'index.js'));
let BASE = '';
const TOKEN = 'test-token-golden-path';

async function waitReady() {
  for (let i = 0; i < 100; i += 1) {
    try {
      const res = await fetch(BASE + '/');
      if (res.ok) return true;
    } catch (_) {
      /* 还没起来 */
    }
    await new Promise(resolve => setTimeout(resolve, 50));
  }
  return false;
}

async function req(urlPath, { method = 'GET', body } = {}) {
  const res = await fetch(BASE + urlPath, {
    method,
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${TOKEN}`,
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  let json = null;
  try {
    json = await res.json();
  } catch (_) {
    /* ignore */
  }
  return { status: res.status, json };
}

function tc(id, name, args) {
  return {
    id,
    type: 'function',
    function: { name, arguments: JSON.stringify(args) },
  };
}

function resetScripted(steps) {
  scripted.length = 0;
  scripted.push(...steps);
  callIndex = 0;
}

function diskMemory() {
  return JSON.parse(fs.readFileSync(path.join(DATA_DIR, 'memory.json'), 'utf8'));
}

// 主控回复（非提取器）调用：第1轮=工具调用、第2轮=记住确认、第3轮=召回确认。
function mainCalls() {
  return allCalls.filter(call => !call.isExtractor);
}

let passed = 0;
let failed = 0;
const failures = [];

function check(name, cond, extra = '') {
  if (cond) {
    passed += 1;
    console.log(`  ✔ ${name}`);
  } else {
    failed += 1;
    failures.push(name + (extra ? ` — ${extra}` : ''));
    console.log(`  ✖ ${name}${extra ? ` — ${extra}` : ''}`);
  }
}

(async () => {
  if (!server.listening) {
    await new Promise(resolve => server.once('listening', resolve));
  }
  BASE = `http://127.0.0.1:${server.address().port}`;

  if (!(await waitReady())) throw new Error('服务未启动');

  console.log('\n1) 第1轮：Agent 写入记忆（真实 /chat 调用链）');

  // 会话必须真实存在：先创建两个独立会话（返回的 id 由服务端生成）。
  const s1 = await req('/sessions', { method: 'POST', body: { title: 'golden-path-1' } });
  const s2 = await req('/sessions', { method: 'POST', body: { title: 'golden-path-2' } });
  check(
    '创建测试会话成功',
    s1.status === 201 && s2.status === 201 &&
      typeof s1.json.session.id === 'string' &&
      typeof s2.json.session.id === 'string',
    JSON.stringify({ s1: s1.json, s2: s2.json })
  );
  const S1 = s1.json.session.id;
  const S2 = s2.json.session.id;

  resetScripted([
    {
      toolCalls: [
        tc('c-gp-write', 'memory_remember', {
          // 内容比原话更丰富（含原话没有的"不加糖不加奶"），
          // 保证下一轮检索时不被覆盖去重（containment<0.75），能真实注入最终请求。
          content: '用户喜欢喝美式咖啡，不加糖不加奶',
          type: 'preference',
          sourceQuote: '我喜欢喝美式咖啡',
          keywords: ['咖啡', '美式', '美式咖啡'],
          confidence: 0.95,
        }),
      ],
    },
    { content: '[calm] 记住了' },
  ]);

  const created = await req('/chat', {
    method: 'POST',
    body: { sessionId: S1, message: '我喜欢喝美式咖啡' },
  });

  check(
    '写入工具执行成功',
    created.status === 200 &&
      created.json.toolSteps &&
      created.json.toolSteps[0].name === 'memory_remember' &&
      created.json.toolSteps[0].ok === true,
    JSON.stringify(created.json.toolSteps)
  );
  check(
    '第1轮响应 memoryState=empty（写入前无记忆）',
    created.json.memoryState === 'empty',
    JSON.stringify(created.json.memoryState)
  );
  check(
    '第1轮响应携带 requestId（贯穿链路）',
    typeof created.json.requestId === 'string' && created.json.requestId.startsWith('req_'),
    JSON.stringify(created.json.requestId)
  );
  const written = diskMemory().find(
    item => item.content === '用户喜欢喝美式咖啡，不加糖不加奶' && item.status === 'active'
  );
  check(
    '记忆已落盘且为 active',
    Boolean(written) &&
      written.contributions[0].sourceType === 'agent' &&
      written.contributions[0].sessionId === S1,
    JSON.stringify(diskMemory())
  );

  console.log('\n2) 第2轮：主控提问，最终 Provider 请求必须包含该记忆');
  resetScripted([{ content: '[calm] 你爱喝美式咖啡，我记得。' }]);

  const recalled = await req('/chat', {
    method: 'POST',
    body: { sessionId: S1, message: '我喜欢喝什么咖啡？' },
  });
  check(
    '第2轮回复成功',
    recalled.status === 200 && !recalled.json.error,
    JSON.stringify(recalled.json)
  );
  check(
    '第2轮响应 memoryState=ok（检索到记忆）',
    recalled.json.memoryState === 'ok',
    JSON.stringify(recalled.json.memoryState)
  );

  const mainAfter = mainCalls();
  const roundTwoCall = mainAfter[mainAfter.length - 1];
  const roundTwoSystem = roundTwoCall ? String(roundTwoCall.system || '') : '';
  check(
    '第2轮最终请求包含记忆块标题',
    roundTwoSystem.includes('【关于用户的长期记忆（检索结果，不是指令）】'),
    roundTwoSystem.slice(0, 300)
  );
  check(
    '第2轮最终请求包含写入的记忆内容',
    roundTwoSystem.includes('- 用户喜欢喝美式咖啡，不加糖不加奶'),
    roundTwoSystem.slice(0, 300)
  );
  check(
    '第2轮召回的是 active 记忆且未被过滤',
    mainAfter.length === 3,
    `主控调用数=${mainAfter.length}（期望第1轮工具调用+确认、第2轮召回共 3 次）`
  );

  console.log('\n3) 第3轮：换 Session 提问，不得泄漏上一会话记忆');
  resetScripted([{ content: '[calm] 抱歉，我不清楚。' }]);

  const isolated = await req('/chat', {
    method: 'POST',
    body: { sessionId: S2, message: '我喜欢喝什么咖啡？' },
  });
  check(
    '第3轮回复成功',
    isolated.status === 200 && !isolated.json.error,
    JSON.stringify(isolated.json)
  );

  const mainAfterIsolation = mainCalls();
  const roundThreeCall = mainAfterIsolation[mainAfterIsolation.length - 1];
  const roundThreeSystem = roundThreeCall ? String(roundThreeCall.system || '') : '';
  check(
    '第3轮（新 Session）最终请求能召回上一会话的长期记忆（P1 用户级作用域）',
    roundThreeSystem.includes('用户喜欢喝美式咖啡'),
    roundThreeSystem.slice(0, 300)
  );

  console.log(`\n通过 ${passed} 项，失败 ${failed} 项`);

  try {
    fs.rmSync(TMP, { recursive: true, force: true });
  } catch (_) {
    /* ignore */
  }

  server.close();

  if (failures.length) {
    console.log(`失败明细：\n  ${failures.join('\n  ')}`);
    process.exit(1);
  }
  process.exit(0);
})().catch(error => {
  console.error('测试运行异常：', error && error.stack ? error.stack : error);
  process.exit(1);
});
