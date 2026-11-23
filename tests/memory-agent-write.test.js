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
    body: { message: '请记住，我喜欢喝美式咖啡' },
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

  console.log('\n2) 明确要求记住且内容有支持 → 无原话摘要可直接写入');
  resetScripted([
    {
      toolCalls: [
        tc('c-paraphrase', 'memory_remember', {
          content: '用户最近在学习烹饪',
          type: 'goal',
          keywords: ['做饭', '学习'],
          confidence: 0.9,
        }),
      ],
    },
    { content: '[calm] 记下了' },
  ]);

  const paraphrased = await req('/chat', {
    method: 'POST',
    body: { message: '请记住，我最近在学做饭' },
  });

  check(
    '无 sourceQuote 也能写入，正文为概括而非原话',
    paraphrased.status === 200 &&
      paraphrased.json.toolSteps &&
      paraphrased.json.toolSteps[0].ok === true &&
      diskMemory().some(item => item.content === '用户最近在学习烹饪'),
    JSON.stringify(paraphrased.json.toolSteps)
  );

  console.log('\n3) 普通陈述无原话 → 待确认，不得直接激活');
  resetScripted([
    {
      toolCalls: [
        tc('c-statement', 'memory_remember', {
          content: '用户周末喜欢骑自行车',
          type: 'preference',
          keywords: ['周末', '自行车'],
          confidence: 0.95,
        }),
      ],
    },
    { content: '[calm] 好的' },
  ]);
  const ordinaryStatement = await req('/chat', {
    method: 'POST',
    body: { message: '我周末喜欢骑自行车' },
  });
  const statementCandidate = diskMemory().find(
    item => item.content === '用户周末喜欢骑自行车'
  );
  check(
    '普通陈述即使无引文且高置信也只进入 pending',
    ordinaryStatement.status === 200 &&
      ordinaryStatement.json.toolSteps[0].summary.includes('等待用户确认') &&
      statementCandidate &&
      statementCandidate.status === 'pending' &&
      !diskMemory().some(
        item => item.content === '用户周末喜欢骑自行车' && item.status === 'active'
      ),
    JSON.stringify({ toolSteps: ordinaryStatement.json.toolSteps, statementCandidate })
  );

  console.log('\n4) 否定的记忆指令 → 待确认');
  resetScripted([
    {
      toolCalls: [
        tc('c-negated-intent', 'memory_remember', {
          content: '用户喜欢喝拿铁',
          type: 'preference',
          keywords: ['拿铁'],
          confidence: 0.95,
        }),
      ],
    },
    { content: '[calm] 好的' },
  ]);
  const negatedIntent = await req('/chat', {
    method: 'POST',
    body: { message: '不要记住我喜欢喝拿铁' },
  });
  check(
    '“不要记住”不能授权直接激活',
    negatedIntent.status === 200 &&
      negatedIntent.json.toolSteps[0].summary.includes('等待用户确认') &&
      diskMemory().some(
        item => item.content === '用户喜欢喝拿铁' && item.status === 'pending'
      ) &&
      !diskMemory().some(
        item => item.content === '用户喜欢喝拿铁' && item.status === 'active'
      ),
    JSON.stringify(negatedIntent.json.toolSteps)
  );

  console.log('\n5) 假设条件中的“记住” → 待确认');
  resetScripted([
    {
      toolCalls: [
        tc('c-hypothetical-intent', 'memory_remember', {
          content: '用户可能喜欢喝拿铁',
          type: 'preference',
          keywords: ['拿铁'],
          confidence: 0.95,
        }),
      ],
    },
    { content: '[calm] 好的' },
  ]);
  const hypotheticalIntent = await req('/chat', {
    method: 'POST',
    body: { message: '如果我以后喜欢喝拿铁，请记住这件事' },
  });
  check(
    '假设条件不能授权直接激活',
    hypotheticalIntent.status === 200 &&
      hypotheticalIntent.json.toolSteps[0].summary.includes('等待用户确认') &&
      diskMemory().some(
        item => item.content === '用户可能喜欢喝拿铁' && item.status === 'pending'
      ) &&
      !diskMemory().some(
        item => item.content === '用户可能喜欢喝拿铁' && item.status === 'active'
      ),
    JSON.stringify(hypotheticalIntent.json.toolSteps)
  );

  console.log('\n6) 明确要求但无引文摘要不受用户消息支持 → 待确认');
  resetScripted([
    {
      toolCalls: [
        tc('c-unsupported-summary', 'memory_remember', {
          content: '用户常用的代码编辑器是 Vim',
          type: 'preference',
          keywords: ['编辑器', 'Vim'],
          confidence: 0.95,
        }),
      ],
    },
    { content: '[calm] 好的' },
  ]);
  const unsupportedSummary = await req('/chat', {
    method: 'POST',
    body: { message: '请记住我喜欢喝拿铁' },
  });
  check(
    '无引文且内容不受当前消息支持时只进入 pending',
    unsupportedSummary.status === 200 &&
      unsupportedSummary.json.toolSteps[0].summary.includes('等待用户确认') &&
      diskMemory().some(
        item =>
          item.content === '用户常用的代码编辑器是 Vim' && item.status === 'pending'
      ) &&
      !diskMemory().some(
        item =>
          item.content === '用户常用的代码编辑器是 Vim' && item.status === 'active'
      ),
    JSON.stringify(unsupportedSummary.json.toolSteps)
  );

  console.log('\n7) 普通陈述即使有真实原话 → 待确认');
  resetScripted([
    {
      toolCalls: [
        tc('c-quoted-statement', 'memory_remember', {
          content: '用户喜欢喝绿茶',
          type: 'preference',
          sourceQuote: '我喜欢喝绿茶',
          keywords: ['绿茶'],
          confidence: 0.95,
        }),
      ],
    },
    { content: '[calm] 好的' },
  ]);
  const quotedStatement = await req('/chat', {
    method: 'POST',
    body: { message: '我喜欢喝绿茶' },
  });
  check(
    '原话接地只证明内容来源，不代表同意保存',
    quotedStatement.status === 200 &&
      quotedStatement.json.toolSteps[0].summary.includes('等待用户确认') &&
      diskMemory().some(
        item => item.content === '用户喜欢喝绿茶' && item.status === 'pending'
      ) &&
      !diskMemory().some(
        item => item.content === '用户喜欢喝绿茶' && item.status === 'active'
      ),
    JSON.stringify(quotedStatement.json.toolSteps)
  );

  console.log('\n8) 文章引用中的保存命令 → 待确认');
  resetScripted([
    {
      toolCalls: [
        tc('c-reported-intent', 'memory_remember', {
          content: '用户喜欢做陶艺',
          type: 'preference',
          sourceQuote: '我喜欢做陶艺',
          keywords: ['陶艺'],
          confidence: 0.95,
        }),
      ],
    },
    { content: '[calm] 好的' },
  ]);
  const reportedIntent = await req('/chat', {
    method: 'POST',
    body: { message: '我在文章里看到：请记住我喜欢做陶艺' },
  });
  check(
    '引用的保存指令即使带真实原话也只能进入 pending',
    reportedIntent.status === 200 &&
      reportedIntent.json.toolSteps[0].summary.includes('等待用户确认') &&
      diskMemory().some(
        item => item.content === '用户喜欢做陶艺' && item.status === 'pending'
      ) &&
      !diskMemory().some(
        item => item.content === '用户喜欢做陶艺' && item.status === 'active'
      ),
    JSON.stringify(reportedIntent.json.toolSteps)
  );

  console.log('\n9) 编造原话 → 拒绝写入');
  resetScripted([
    {
      toolCalls: [
        tc('c-bad', 'memory_remember', {
          content: '用户喜欢喝摩卡咖啡',
          type: 'preference',
          sourceQuote: '我喜欢喝摩卡咖啡',
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
      !diskMemory().some(item => item.content === '用户喜欢喝摩卡咖啡'),
    JSON.stringify(rejected.json.toolSteps)
  );

  console.log('\n4) 同一候选重复提交进入待确认，不直接改写 active');
  const activeBefore = diskMemory().filter(
    item => item.status === 'active' && item.content === '用户喜欢喝美式咖啡'
  ).length;

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
  await req('/chat', {
    method: 'POST',
    body: { message: '请记住，我喜欢喝美式咖啡' },
  });

  const pendingCoffee = diskMemory().find(
    item => item.status === 'pending' && item.content === '用户喜欢喝美式咖啡'
  );
  check(
    '重复提交不直接改写 active，而是进入 pending',
    pendingCoffee &&
      pendingCoffee.pendingMutation === 'merge' &&
      diskMemory().filter(item => item.status === 'active' && item.content === '用户喜欢喝美式咖啡').length === activeBefore,
    JSON.stringify(diskMemory())
  );

  const mergeConfirmed = await req('/memory/confirm', {
    method: 'POST',
    body: { id: pendingCoffee.id },
  });
  check(
    '确认后 active 仍只有一条咖啡记忆',
    mergeConfirmed.status === 200 &&
      diskMemory().filter(item => item.status === 'active' && item.content === '用户喜欢喝美式咖啡').length === 1 &&
      !diskMemory().some(item => item.status === 'pending' && item.content === '用户喜欢喝美式咖啡'),
    JSON.stringify({ mergeConfirmed: mergeConfirmed.json, memory: diskMemory() })
  );

  console.log('\n5) 低置信 Agent 候选进入 pending，可由 HTTP 确认');
  const agent = require(path.join(SERVER, 'agent-runtime.js'));

  const unauthorizedWrite = await agent.executeToolCall(
    'memory_remember',
    {
      content: '用户常用编辑器是 Vim',
      type: 'preference',
      sourceQuote: '我用 Vim 写代码',
      confidence: 0.9,
    },
    { sessionId: 's-agent-no-text', cache: new Map() }
  );

  check(
    '无当前用户原话 → 运行层拒绝写入工具',
    unauthorizedWrite.ok === false &&
      unauthorizedWrite.code === 'unauthorized_write',
    JSON.stringify(unauthorizedWrite)
  );

  const abortController = new AbortController();
  abortController.abort();
  const abortedWrite = await agent.executeToolCall(
    'memory_remember',
    {
      content: '用户常用编辑器是 Emacs',
      type: 'preference',
      sourceQuote: '我用 Emacs 写代码',
      confidence: 0.9,
    },
    {
      sessionId: 's-agent-aborted',
      userText: '我用 Emacs 写代码',
      cache: new Map(),
      abortSignal: abortController.signal,
    }
  );

  check(
    '已中止的写入请求不落盘',
    abortedWrite.ok === false &&
      !diskMemory().some(item => item.content === '用户常用编辑器是 Emacs'),
    JSON.stringify(abortedWrite)
  );

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
  const pendingCandidate = pendingList.json.memories.find(
    item => item.content === '用户常用编辑器是 Vim' && item.status === 'pending'
  );
  const defaultMemoryList = await req('/memory');
  check(
    'pending 列表可查且默认记忆库不可见',
    pendingList.status === 200 &&
      pendingCandidate &&
      !defaultMemoryList.json.memories.some(item => item.id === pendingCandidate.id) &&
      !diskMemory().some(item => item.status === 'active' && item.content === '用户常用编辑器是 Vim'),
    JSON.stringify({ pending: pendingList.json, default: defaultMemoryList.json })
  );

  const pendingId = pendingCandidate.id;
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

  console.log('\n6) HTTP 归档接口');
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

  const allView = await req('/memory?scope=all');
  check(
    'scope=all 只读视图包含归档条目',
    allView.status === 200 &&
      allView.json.scope === 'all' &&
      allView.json.memories.some(
        item => item.id === activeId && item.status === 'archived'
      ),
    JSON.stringify(allView.json)
  );

  const badScope = await req('/memory?scope=recent');
  check(
    '非法 scope 返回 400，不退化成默认列表',
    badScope.status === 400,
    JSON.stringify({ status: badScope.status, body: badScope.json })
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
