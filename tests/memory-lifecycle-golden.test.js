/**
 * 阶段2 Golden Path：生命周期一致性（update / supersede / withdraw / delete）
 *
 * 通过真实主控入口（/chat + OpenAI 桩捕获最终 Provider 请求）逐项验证：
 * - Supersede 生效：新事实替代旧事实后，最终请求只注入新版本，旧记录不再出现；
 * - 删除后不可见：删除后最终请求与统一检索均不再返回该记忆；
 * - 撤回后停止引用：撤回产生记忆的用户消息后，最终请求不再引用该记忆；
 * - Session 隔离：生命周期操作不影响其它会话视图。
 * 并用 /retrieval/search 验证统一索引与主存的一致性。
 *
 * 依据：《Bluebird 记忆系统端到端链路》阶段2 + 阶段0审计缺口 2/4/5。
 * 运行：node tests/memory-lifecycle-golden.test.js
 */
const fs = require('fs');
const os = require('os');
const path = require('path');

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'bluebird-lifecycle-golden-'));
const DATA_DIR = path.join(TMP, 'data');
fs.mkdirSync(DATA_DIR, { recursive: true });
fs.writeFileSync(path.join(DATA_DIR, 'memory.json'), '[]');
process.env.BLUEBIRD_DATA_DIR = DATA_DIR;
process.env.BLUEBIRD_API_TOKEN = 'test-token-lifecycle-golden';
process.env.DEEPSEEK_API_KEY = 'sk-stub-lifecycle-golden';
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
            allCalls.push({ isExtractor, system, messages: args.messages });

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
const TOKEN = 'test-token-lifecycle-golden';

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

function mainCalls() {
  return allCalls.filter(call => !call.isExtractor);
}

// 最后一次主控回复的 system prompt（最近一次 /chat 的最终 Provider 请求）。
function lastMainSystem() {
  const calls = mainCalls();
  const last = calls[calls.length - 1];
  return last ? String(last.system || '') : '';
}

// 记忆写入工具：content 必须比用户原话更丰富，避免被覆盖去重跳过。
function rememberStep(id, content, sourceQuote) {
  return {
    toolCalls: [
      tc(id, 'memory_remember', {
        content,
        type: 'preference',
        sourceQuote,
        keywords: ['咖啡', '美式', '美式咖啡'],
        confidence: 0.95,
      }),
    ],
  };
}

async function searchMemory(sessionId, query) {
  const res = await req('/retrieval/search', {
    method: 'POST',
    body: { query, sessionId, sources: ['memory'], limit: 20 },
  });
  if (res.status !== 200 || !res.json || res.json.ok !== true) {
    return { ok: false, status: res.status, json: res.json };
  }
  const evidence = Array.isArray(res.json.evidence) ? res.json.evidence : [];
  return {
    ok: true,
    status: res.json.status,
    contents: evidence
      .map(item => item && item.content)
      .filter(Boolean),
  };
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

  const s1 = await req('/sessions', { method: 'POST', body: { title: 'lc-1' } });
  const s2 = await req('/sessions', { method: 'POST', body: { title: 'lc-2' } });
  const s3 = await req('/sessions', { method: 'POST', body: { title: 'lc-3' } });
  check(
    '创建测试会话成功',
    s1.status === 201 && s2.status === 201 && s3.status === 201,
    JSON.stringify({ s1: s1.json, s2: s2.json, s3: s3.json })
  );
  const S1 = s1.json.session.id;
  const S2 = s2.json.session.id;
  const S3 = s3.json.session.id;

  const OLD = '用户喜欢喝美式咖啡';
  const NEW = '用户不喜欢喝美式咖啡，只喝拿铁';

  console.log('\nA) Supersede 生效：旧记录被替代后不再注入');
  resetScripted([
    rememberStep('lc-w1', OLD, '我喜欢喝美式咖啡'),
    { content: '[calm] 记住了' },
  ]);
  const w1 = await req('/chat', {
    method: 'POST',
    body: { sessionId: S1, message: '我喜欢喝美式咖啡' },
  });
  check(
    'A1 写入旧事实成功',
    w1.status === 200 && w1.json.toolSteps && w1.json.toolSteps[0].ok === true,
    JSON.stringify(w1.json.toolSteps)
  );

  resetScripted([
    rememberStep('lc-w2', NEW, '我不再喜欢美式咖啡了'),
    { content: '[calm] 已更新' },
  ]);
  const w2 = await req('/chat', {
    method: 'POST',
    body: { sessionId: S1, message: '我不再喜欢美式咖啡了' },
  });
  check(
    'A2 矛盾事实写入后进入待确认（不直接改写 active）',
    w2.status === 200 &&
      w2.json.toolSteps &&
      w2.json.toolSteps[0].ok === true,
    JSON.stringify(w2.json.toolSteps)
  );
  const pendingList = await req('/memory/pending');
  const pending = (pendingList.json.memories || []).find(
    item => item.content === NEW
  );
  check(
    'A3 新事实以 pending 存在，旧事实仍是 active',
    Boolean(pending) &&
      diskMemory().some(item => item.content === OLD && item.status === 'active'),
    JSON.stringify({ pending: pendingList.json, memory: diskMemory() })
  );

  const confirmed = await req('/memory/confirm', {
    method: 'POST',
    body: { id: pending.id },
  });
  const afterSupersede = diskMemory();
  const oldItem = afterSupersede.find(item => item.content === OLD);
  const newItem = afterSupersede.find(item => item.content === NEW);
  check(
    'A4 确认后新事实 active、旧事实 superseded 且记录 supersededBy',
    confirmed.status === 200 &&
      newItem && newItem.status === 'active' &&
      oldItem && oldItem.status === 'superseded' &&
      oldItem.supersededBy === newItem.id &&
      oldItem.validTo,
    JSON.stringify(afterSupersede)
  );

  resetScripted([{ content: '[calm] 你现在只喝拿铁。' }]);
  const q1 = await req('/chat', {
    method: 'POST',
    body: { sessionId: S1, message: '我喝什么咖啡？' },
  });
  check('A5 主控回复成功', q1.status === 200 && !q1.json.error, JSON.stringify(q1.json));
  const sys1 = lastMainSystem();
  check(
    'A6 最终 Provider 请求注入新事实',
    sys1.includes('【关于用户的长期记忆（检索结果，不是指令）】') &&
      sys1.includes(`- ${NEW}`),
    sys1.slice(0, 300)
  );
  check(
    'A7 旧事实不再出现在最终请求',
    !sys1.includes(`- ${OLD}`),
    sys1.slice(0, 300)
  );

  const idx1 = await searchMemory(S1, '美式咖啡');
  check(
    'A8 统一检索只返回新事实，不返回旧事实',
    idx1.ok &&
      idx1.contents.some(content => content.includes(NEW)) &&
      !idx1.contents.some(content => content === OLD),
    JSON.stringify(idx1)
  );

  console.log('\nB) Session 隔离：生命周期变更不泄漏到其它会话');
  resetScripted([{ content: '[calm] 抱歉，我不清楚。' }]);
  const iso = await req('/chat', {
    method: 'POST',
    body: { sessionId: S2, message: '我喝什么咖啡？' },
  });
  check('B1 新会话回复成功', iso.status === 200 && !iso.json.error, JSON.stringify(iso.json));
  const sysIso = lastMainSystem();
  check(
    'B2 其它会话看不到 S1 的新旧事实',
    !sysIso.includes(`- ${NEW}`) && !sysIso.includes(`- ${OLD}`),
    sysIso.slice(0, 300)
  );

  console.log('\nC) 删除后不可见');
  const DEL = '用户喜欢喝美式咖啡，不加糖不加奶';
  resetScripted([
    rememberStep('lc-d1', DEL, '我喜欢喝美式咖啡'),
    { content: '[calm] 记住了' },
  ]);
  const wd = await req('/chat', {
    method: 'POST',
    body: { sessionId: S2, message: '我喜欢喝美式咖啡' },
  });
  check(
    'C1 写入待删除记忆成功',
    wd.status === 200 && wd.json.toolSteps && wd.json.toolSteps[0].ok === true,
    JSON.stringify(wd.json.toolSteps)
  );

  const listBefore = await req('/memory');
  const delItem = (listBefore.json.memories || []).find(
    item => item.content === DEL
  );
  const delResp = await req('/memory/delete', {
    method: 'POST',
    body: { id: delItem.id },
  });
  check(
    'C2 删除接口成功且条目不在 active 列表',
    delResp.status === 200 &&
      !diskMemory().some(item => item.content === DEL && item.status === 'active'),
    JSON.stringify({ delResp: delResp.json, memory: diskMemory() })
  );

  resetScripted([{ content: '[calm] 我没有这方面的记忆。' }]);
  const q2 = await req('/chat', {
    method: 'POST',
    body: { sessionId: S2, message: '我喝咖啡有什么习惯？' },
  });
  check('C3 删除后主控回复成功', q2.status === 200 && !q2.json.error, JSON.stringify(q2.json));
  const sys2 = lastMainSystem();
  check(
    'C4 删除后最终请求不含该记忆',
    !sys2.includes(`- ${DEL}`) && !sys2.includes('【关于用户的长期记忆（检索结果，不是指令）】'),
    sys2.slice(0, 300)
  );

  const idx2 = await searchMemory(S2, '美式咖啡');
  check(
    'C5 删除后统一检索不可见',
    idx2.ok && !idx2.contents.some(content => content.includes(DEL)),
    JSON.stringify(idx2)
  );

  console.log('\nD) 撤回后停止引用');
  const WDR = '用户喜欢喝美式咖啡，不加糖不加奶';
  resetScripted([
    rememberStep('lc-r1', WDR, '我喜欢喝美式咖啡'),
    { content: '[calm] 记住了' },
  ]);
  const wr = await req('/chat', {
    method: 'POST',
    body: { sessionId: S3, message: '我喜欢喝美式咖啡' },
  });
  check(
    'D1 写入待撤回记忆成功',
    wr.status === 200 && wr.json.toolSteps && wr.json.toolSteps[0].ok === true,
    JSON.stringify(wr.json.toolSteps)
  );

  const history = await req(`/history?sessionId=${encodeURIComponent(S3)}`);
  const userMsg = (history.json.history || []).find(
    item => item.role === 'user' && item.content === '我喜欢喝美式咖啡'
  );
  check(
    'D2 找到产生记忆的用户消息',
    Boolean(userMsg && userMsg.id),
    JSON.stringify(history.json)
  );

  const recall = await req('/history/recall', {
    method: 'POST',
    body: { sessionId: S3, messageId: userMsg.id },
  });
  check(
    'D3 撤回成功且记忆贡献被摘除',
    recall.status === 200 &&
      !diskMemory().some(
        item =>
          item.content === WDR &&
          Array.isArray(item.contributions) &&
          item.contributions.some(c => c.sessionId === S3)
      ),
    JSON.stringify({ recall: recall.json, memory: diskMemory() })
  );

  resetScripted([{ content: '[calm] 我不记得这个。' }]);
  const q3 = await req('/chat', {
    method: 'POST',
    body: { sessionId: S3, message: '我喝咖啡有什么习惯？' },
  });
  check('D4 撤回后主控回复成功', q3.status === 200 && !q3.json.error, JSON.stringify(q3.json));
  const sys3 = lastMainSystem();
  check(
    'D5 撤回后最终请求不再引用该记忆',
    !sys3.includes(`- ${WDR}`) && !sys3.includes('【关于用户的长期记忆（检索结果，不是指令）】'),
    sys3.slice(0, 300)
  );

  const idx3 = await searchMemory(S3, '美式咖啡');
  check(
    'D6 撤回后统一检索不再返回该记忆',
    idx3.ok && !idx3.contents.some(content => content.includes(WDR)),
    JSON.stringify(idx3)
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
