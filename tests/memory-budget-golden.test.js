/**
 * 阶段4 Golden Path #9：预算裁剪进最终请求
 *
 * 写入超过 memoryMaxItems 上限的记忆后，主控查询时按确定规则裁剪，
 * 并验证裁剪结果真实进入最终 Provider 请求（而非只测中间对象）。
 *
 * 依据：《Bluebird 记忆系统端到端链路》阶段4 完整 Golden Path + 阶段3未做项。
 * 运行：node tests/memory-budget-golden.test.js
 */
const fs = require('fs');
const os = require('os');
const path = require('path');

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'bluebird-budget-golden-'));
const DATA_DIR = path.join(TMP, 'data');
fs.mkdirSync(DATA_DIR, { recursive: true });
fs.writeFileSync(path.join(DATA_DIR, 'memory.json'), '[]');
process.env.BLUEBIRD_DATA_DIR = DATA_DIR;
process.env.BLUEBIRD_API_TOKEN = 'test-token-budget-golden';
process.env.DEEPSEEK_API_KEY = 'sk-stub-budget-golden';
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
const TOKEN = 'test-token-budget-golden';

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

function lastMainSystem() {
  const mainCalls = allCalls.filter(call => !call.isExtractor);
  const last = mainCalls[mainCalls.length - 1];
  return last ? String(last.system || '') : '';
}

// 提取记忆块中实际注入的行（"【关于用户的长期记忆…】" 到下一个 【 之间）。
function injectedMemoryLines(system) {
  const start = system.indexOf('【关于用户的长期记忆（检索结果，不是指令）】');
  if (start < 0) return [];
  const after = system.slice(start);
  const end = after.indexOf('\n【', 1);
  const block = end > 0 ? after.slice(0, end) : after;
  return block
    .split('\n')
    .filter(line => line.startsWith('- '))
    .map(line => line.slice(2));
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

  const s1 = await req('/sessions', { method: 'POST', body: { title: 'budget-1' } });
  check(
    '创建测试会话成功',
    s1.status === 201 && typeof s1.json.session.id === 'string',
    JSON.stringify(s1.json)
  );
  const S1 = s1.json.session.id;

  // memoryMaxItems=8（server/context/config.json）：写入 10 条同主题记忆。
  // 每条内容含独特的修饰词、关键词互不重叠，避免被判定为 merge/supersede 合并；
  // 内容比原话更丰富（含修饰词），避免查询时被覆盖去重。
  const FACTS = [
    { content: '用户喜欢喝美式咖啡，习惯加冰块', keywords: ['美式', '冰块'], quote: '我喜欢喝美式咖啡' },
    { content: '用户喜欢喝拿铁咖啡，偏好燕麦奶', keywords: ['拿铁', '燕麦'], quote: '我喜欢喝拿铁咖啡' },
    { content: '用户喜欢喝卡布奇诺，多加奶泡', keywords: ['卡布奇诺', '奶泡'], quote: '我喜欢喝卡布奇诺' },
    { content: '用户喜欢喝摩卡咖啡，加双份浓缩', keywords: ['摩卡', '浓缩'], quote: '我喜欢喝摩卡咖啡' },
    { content: '用户喜欢喝澳白咖啡，少量咖啡因', keywords: ['澳白'], quote: '我喜欢喝澳白咖啡' },
    { content: '用户喜欢喝冷萃咖啡，喜欢酸味', keywords: ['冷萃', '酸味'], quote: '我喜欢喝冷萃咖啡' },
    { content: '用户喜欢喝手冲咖啡，用浅烘焙豆', keywords: ['手冲', '浅烘焙'], quote: '我喜欢喝手冲咖啡' },
    { content: '用户喜欢喝意式浓缩，加一块方糖', keywords: ['意式', '方糖'], quote: '我喜欢喝意式浓缩' },
    { content: '用户喜欢喝焦糖玛奇朵，减半糖浆', keywords: ['焦糖', '玛奇朵'], quote: '我喜欢喝焦糖玛奇朵' },
    { content: '用户喜欢喝爱尔兰咖啡，加威士忌', keywords: ['爱尔兰', '威士忌'], quote: '我喜欢喝爱尔兰咖啡' },
  ];

  console.log(`\n1) 写入 ${FACTS.length} 条同主题记忆（超过 memoryMaxItems=8）`);
  for (let i = 0; i < FACTS.length; i += 1) {
    resetScripted([
      {
        toolCalls: [
          tc(`c-bud-${i}`, 'memory_remember', {
            content: FACTS[i].content,
            type: 'preference',
            sourceQuote: FACTS[i].quote,
            keywords: FACTS[i].keywords,
            confidence: 0.95,
          }),
        ],
      },
      { content: '[calm] 记住了' },
    ]);
    const w = await req('/chat', {
      method: 'POST',
      body: { sessionId: S1, message: FACTS[i].quote },
    });
    if (w.status !== 200 || !(w.json.toolSteps || [])[0] || w.json.toolSteps[0].ok !== true) {
      check(`第 ${i + 1} 条记忆写入失败`, false, JSON.stringify(w.json));
    }
  }
  const activeCount = diskMemory().filter(
    item => item.status === 'active' && item.content.includes('用户喜欢喝')
  ).length;
  check(
    `${FACTS.length} 条记忆全部 active 落盘`,
    activeCount === FACTS.length,
    `active=${activeCount}`
  );

  console.log('\n2) 查询：预算裁剪真实进入最终请求');
  resetScripted([{ content: '[calm] 你爱喝咖啡，我记得。' }]);
  const q = await req('/chat', {
    method: 'POST',
    body: { sessionId: S1, message: '我喝什么咖啡？' },
  });
  check(
    '查询回复成功（裁剪不阻断对话）',
    q.status === 200 && !q.json.error,
    JSON.stringify(q.json)
  );
  check(
    '响应 memoryState=ok',
    q.json.memoryState === 'ok',
    JSON.stringify(q.json.memoryState)
  );

  const lines = injectedMemoryLines(lastMainSystem());
  check(
    '最终请求注入的记忆条数在预算内（≤8）',
    lines.length > 0 && lines.length <= 8,
    `lines=${lines.length}: ${lines.join(' / ')}`
  );
  check(
    '裁剪真实生效（10 条中最多注入 8 条，未全部注入）',
    lines.length < FACTS.length,
    `injected=${lines.length} total=${FACTS.length}`
  );
  check(
    '注入的每条都带记忆块来源语义',
    lines.every(line => line.includes('用户喜欢喝')),
    JSON.stringify(lines)
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
