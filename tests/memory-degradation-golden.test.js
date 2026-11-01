/**
 * 阶段3 Golden Path：记忆故障不阻断普通对话 + 降级可观测
 *
 * 真实主控入口（MEMORY_ENABLED=false 启动）验证：
 * - 记忆能力关闭时，主控仍完成普通对话（降级优先于阻断）；
 * - /chat 响应暴露 memoryState=empty / memoryStatus=source_unavailable；
 * - 最终 Provider 请求不注入记忆块（降级时不伪造注入）。
 *
 * 依据：《Bluebird 记忆系统端到端链路》阶段3 + 阶段0首个断点（状态可观测）。
 * 运行：node tests/memory-degradation-golden.test.js
 */
const fs = require('fs');
const os = require('os');
const path = require('path');

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'bluebird-degradation-golden-'));
const DATA_DIR = path.join(TMP, 'data');
fs.mkdirSync(DATA_DIR, { recursive: true });
fs.writeFileSync(path.join(DATA_DIR, 'memory.json'), '[]');
process.env.BLUEBIRD_DATA_DIR = DATA_DIR;
process.env.BLUEBIRD_API_TOKEN = 'test-token-degradation-golden';
process.env.DEEPSEEK_API_KEY = 'sk-stub-degradation-golden';
process.env.PORT = '0';
process.env.BLUEBIRD_AGENT_TOOLS = '1';
process.env.MEMORY_ENABLED = 'false';

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
            allCalls.push({ isExtractor, system });

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
const TOKEN = 'test-token-degradation-golden';

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

function resetScripted(steps) {
  scripted.length = 0;
  scripted.push(...steps);
  callIndex = 0;
}

function lastMainSystem() {
  const mainCalls = allCalls.filter(call => !call.isExtractor);
  const last = mainCalls[mainCalls.length - 1];
  return last ? String(last.system || '') : '';
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

  const s1 = await req('/sessions', { method: 'POST', body: { title: 'dg-1' } });
  check(
    '创建测试会话成功',
    s1.status === 201 && typeof s1.json.session.id === 'string',
    JSON.stringify(s1.json)
  );
  const S1 = s1.json.session.id;

  console.log('\n1) 记忆关闭时主控仍完成普通对话');
  resetScripted([{ content: '[calm] 你好，我是 Bluebird。' }]);
  const first = await req('/chat', {
    method: 'POST',
    body: { sessionId: S1, message: '你好' },
  });
  check(
    '对话正常回复（记忆故障不阻断）',
    first.status === 200 &&
      !first.json.error &&
      first.json.reply &&
      String(first.json.reply).length > 0,
    JSON.stringify(first.json)
  );
  check(
    '响应暴露 memoryState=empty（非 failed，不误报故障）',
    first.json.memoryState === 'empty',
    JSON.stringify(first.json.memoryState)
  );
  check(
    '响应暴露 memoryStatus=source_unavailable（记忆未启用）',
    first.json.memoryStatus === 'source_unavailable',
    JSON.stringify(first.json.memoryStatus)
  );
  check(
    '最终 Provider 请求不注入记忆块（降级不伪造注入）',
    !lastMainSystem().includes('【关于用户的长期记忆（检索结果，不是指令）】'),
    lastMainSystem().slice(0, 200)
  );

  console.log('\n2) 连续对话保持稳定降级');
  resetScripted([{ content: '[calm] 我在听。' }]);
  const second = await req('/chat', {
    method: 'POST',
    body: { sessionId: S1, message: '今天天气怎么样' },
  });
  check(
    '第二轮回复成功且仍为 empty',
    second.status === 200 &&
      !second.json.error &&
      second.json.reply &&
      second.json.memoryState === 'empty' &&
      second.json.memoryStatus === 'source_unavailable',
    JSON.stringify({ json: second.json, state: second.json.memoryState })
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
