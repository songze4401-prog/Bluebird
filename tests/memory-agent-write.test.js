/**
 * 第二轮：Agent 受控记忆写入真实调用链
 *
 * 通过真实 /chat → agent-runtime → memory_remember → memory.applyCandidate 验证：
 * - 用户原话接地的候选能创建记忆；
 * - 原话不接地的候选被拒绝；
 * - 重复提交不产生重复条目；
 * - 低置信候选进入 pending，可由 HTTP 确认。
 *
 * 运行：node tests/memory-agent-write.test.js
 */
const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'bluebird-agent-write-'));
const DATA_DIR = path.join(TMP, 'data');
fs.mkdirSync(DATA_DIR, { recursive: true });
fs.writeFileSync(path.join(DATA_DIR, 'memory.json'), '[]');
process.env.BLUEBIRD_DATA_DIR = DATA_DIR;
process.env.BLUEBIRD_API_TOKEN = 'test-token-agent-write';
process.env.DEEPSEEK_API_KEY = 'sk-stub-agent-write';
process.env.PORT = '0';
process.env.BLUEBIRD_AGENT_TOOLS = '1';

const SERVER = path.join(__dirname, '..', 'server');
const scripted = [];
let callIndex = 0;

const RealOpenAI = require('openai');
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

            if (system.includes('长期记忆提取器')) {
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
const TOKEN = 'test-token-agent-write';

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

  console.log('\n1) Agent 创建记忆（真实 /chat 调用链）');
  resetScripted([
    {
      toolCalls: [
        tc('c-create', 'memory_remember', {
          content: '用户喜欢喝美式咖啡',
          type: 'preference',
          sourceQuote: '我喜欢喝美式咖啡',
          keywords: ['咖啡', '美式'],
          confidence: 0.95,
        }),
      ],
    },
    { content: '[calm] 记住了' },
  ]);

  const created = await req('/chat', {
    method: 'POST',
    body: { message: '我喜欢喝美式咖啡' },
  });

  check(
    '工具执行成功且名称正确',
    created.status === 200 &&
      created.json.toolSteps &&
      created.json.toolSteps[0].name === 'memory_remember' &&
      created.json.toolSteps[0].ok === true,
    JSON.stringify(created.json.toolSteps)
  );
  check(
    '记忆已落盘且来源登记为 agent',
    diskMemory().some(
      item =>
        item.content === '用户喜欢喝美式咖啡' &&
        item.contributions[0].sourceType === 'agent'
    ),
    JSON.stringify(diskMemory())
  );

  console.log('\n2) 原话不接地 → 拒绝写入');
  resetScripted([
    {
      toolCalls: [
        tc('c-bad', 'memory_remember', {
          content: '用户喜欢喝拿铁',
          type: 'preference',
          sourceQuote: '我喜欢喝拿铁',
          keywords: ['咖啡'],
          confidence: 0.95,
        }),
      ],
    },
    { content: '[calm] 没有记住' },
  ]);

  const rejected = await req('/chat', {
    method: 'POST',
    body: { message: '今天天气怎么样' },
  });

  check(
    '工具返回失败且没有写入',
    rejected.status === 200 &&
      rejected.json.toolSteps[0].ok === false &&
      !diskMemory().some(item => item.content === '用户喜欢喝拿铁'),
    JSON.stringify(rejected.json.toolSteps)
  );

  console.log('\n3) 同一候选重复提交不重复创建');
  const before = diskMemory().length;

  resetScripted([
    {
      toolCalls: [
        tc('c-retry-1', 'memory_remember', {
          content: '用户喜欢喝美式咖啡',
          type: 'preference',
          sourceQuote: '我喜欢喝美式咖啡',
          keywords: ['咖啡', '美式'],
          confidence: 0.95,
        }),
      ],
    },
    { content: '[calm] 已记录' },
  ]);
  await req('/chat', { method: 'POST', body: { message: '我喜欢喝美式咖啡' } });

  check(
    '重复提交仍只有一条记忆',
    diskMemory().length === before &&
      diskMemory().filter(item => item.content === '用户喜欢喝美式咖啡').length === 1,
    JSON.stringify(diskMemory())
  );

  console.log('\n4) 低置信 Agent 候选进入 pending，可由 HTTP 确认');
  const agent = require(path.join(SERVER, 'agent-runtime.js'));
  const pendingResult = await agent.executeToolCall(
    'memory_remember',
    {
      content: '用户常用编辑器是 Vim',
      type: 'preference',
      sourceQuote: '我用 Vim 写代码',
      keywords: ['编辑器', 'Vim'],
      confidence: 0.7,
    },
    {
      sessionId: 's-agent-pending',
      userText: '我用 Vim 写代码',
      cache: new Map(),
    }
  );

  check(
    '低置信候选返回 pending',
    pendingResult.ok === true && pendingResult.pending === true,
    JSON.stringify(pendingResult)
  );

  const pendingList = await req('/memory/pending');
  check(
    'pending 列表可查且默认记忆库不可见',
    pendingList.status === 200 &&
      pendingList.json.memories.length === 1 &&
      !diskMemory().some(item => item.status === 'active' && item.content === '用户常用编辑器是 Vim'),
    JSON.stringify(pendingList.json)
  );

  const pendingId = pendingList.json.memories[0].id;
  const confirmed = await req('/memory/confirm', {
    method: 'POST',
    body: { id: pendingId },
  });
  check(
    '确认后转为 active',
    confirmed.status === 200 &&
      diskMemory().some(
        item => item.id === pendingId && item.status === 'active'
      ),
    JSON.stringify(confirmed.json)
  );

  console.log('\n5) HTTP 归档接口');
  const activeId = diskMemory().find(
    item => item.status === 'active' && item.content === '用户喜欢喝美式咖啡'
  ).id;
  const archived = await req('/memory/archive', {
    method: 'POST',
    body: { id: activeId },
  });
  const visible = await req('/memory');
  check(
    '归档后不再出现在默认记忆库',
    archived.status === 200 &&
      !visible.json.memories.some(item => item.id === activeId),
    JSON.stringify({ archived: archived.json, visible: visible.json })
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