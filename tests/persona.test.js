/**
 * 云岫 Bluebird — 人格面板 + 连续消息分条测试
 *
 * 独立脚本（非 node:test）：与 tests/time-gap.test.js 同款极简 runner。
 * 隔离保证：所有数据都落在系统临时目录（BLUEBIRD_DATA_DIR），
 * 不读取、修改或清空真实 server/data。
 *
 * 覆盖：
 *   - GET /persona 默认配置 + defaults；PUT 保存、夹取校验、恢复默认；
 *   - 重启持久化（子进程重读同一数据目录）；
 *   - 配置损坏：原地只读保护（子进程：回退默认 + 拒绝写入 + 原文件不动）；
 *   - /chat systemPrompt 确实注入【说话风格调整】规则块（桩模型捕获）；
 *   - 连续消息模式：single 强制单条 / auto 自然分条 / frequent 更积极；
 *   - 分段落盘：每段独立 assistant 消息、历史恢复一致、撤回整轮删除；
 *   - 续写只落 assistant；连续发送顺序与 id 唯一；会话隔离；未授权 401；
 *   - 分条不变量：去空白拼接 === 原文（不丢字、不重复）。
 *
 * 运行：node tests/persona.test.js
 */
const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');
const { execFileSync } = require('child_process');

// 退出前关掉 HTTP 服务（含 keep-alive），避免 Windows 上 libuv 断言
const originalListen = http.Server.prototype.listen;
let httpServer = null;

http.Server.prototype.listen = function (...args) {
  httpServer = this;
  return originalListen.apply(this, args);
};

async function closeHttpServer() {
  if (!httpServer) return;

  const server = httpServer;
  httpServer = null;

  try {
    if (typeof server.closeAllConnections === 'function') {
      server.closeAllConnections();
    }
  } catch (_) {
    /* ignore */
  }

  await new Promise(resolve => server.close(() => resolve()));
}

const SERVER = path.join(__dirname, '..', 'server');
const TMP_ROOT = fs.mkdtempSync(path.join(os.tmpdir(), 'bluebird-persona-'));
const DATA_DIR = path.join(TMP_ROOT, 'data');
fs.mkdirSync(DATA_DIR, { recursive: true });

const ORIG_LOG = console.log;
const ORIG_ERR = console.error;

console.log = () => {};
console.error = () => {};

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

// ---- 桩模块：模型（捕获 systemPrompt + 可换回复内容）/ 记忆 ----
const capturedPrompts = [];
let stubReply = '[mood:calm] 在';

const openaiTarget = require.resolve('openai', { paths: [SERVER] });

require.cache[openaiTarget] = {
  id: openaiTarget,
  filename: openaiTarget,
  loaded: true,
  exports: class StubOpenAI {
    constructor() {
      this.chat = {
        completions: {
          create: async params => {
            capturedPrompts.push(params.messages[0].content);
            return {
              model: 'stub-model',
              choices: [{ message: { content: stubReply } }],
            };
          },
        },
      };
    }
  },
};

{
  const memoryTarget = require.resolve(path.join(SERVER, 'memory.js'));
  require.cache[memoryTarget] = {
    id: memoryTarget,
    filename: memoryTarget,
    loaded: true,
    exports: {
      buildMemoryContext: () => '',
      processMemory: async () => null,
      clearMemories: () => {},
      recallMemoryBySourceQuote: async () => ({}),

      clearSessionMemories: async () => ({ removedEntries: 0, removedContributions: 0, remaining: 0, reason: "no-match" }),

      verifyStoreConsistency: () => ({ consistent: true, entries: 0, reason: "ok" }),

      getWriteOutcomes: () => [],
      getMemories: () => [],
      deleteMemory: () => false,
    },
  };
}

process.env.BLUEBIRD_DATA_DIR = DATA_DIR;
process.env.PORT = '0';
process.env.BLUEBIRD_API_TOKEN = 'test-token-persona';
process.env.DEEPSEEK_API_KEY = 'stub-key';

const sessions = require(path.join(SERVER, 'sessions.js'));
const { splitReplyIntoSegments } = require(path.join(
  SERVER,
  'split-reply.js'
));
const { server } = require(path.join(SERVER, 'index.js'));

process.on('exit', () => {
  try {
    fs.rmSync(TMP_ROOT, { recursive: true, force: true });
  } catch (_) {
    /* 清理失败不影响测试结果 */
  }
});

async function main() {
  ORIG_LOG('\nA. 分条纯函数规则');

  check(
    '短回复单条',
    splitReplyIntoSegments('在的，怎么了？', 'auto').length === 1
  );

  const paragraphs = splitReplyIntoSegments('第一段。\n\n第二段。\n\n第三段。', 'auto');
  check(
    '多段落分 3 条',
    paragraphs.length === 3 && paragraphs[0] === '第一段。'
  );
  check(
    'single 模式强制单条（保留换行原文）',
    splitReplyIntoSegments('第一段。\n\n第二段。', 'single').length === 1
  );

  const longText =
    '今天天气真的特别好，我一早就出门了。路上看到一只猫，趴在墙头晒太阳，尾巴一甩一甩的。它懒洋洋地看了我一眼，又闭上眼睛继续睡。我站在那儿看了好久，突然觉得你肯定也会喜欢这一幕。就掏出手机拍下来想给你看。你猜后来怎么着？它突然跳下来蹭我的裤脚，绕着我转了两圈。我蹲下来摸了摸它的头，它就干脆趴在我鞋上不走了。最后我迟到了十分钟，但是一点都不后悔。';
  const longAuto = splitReplyIntoSegments(longText, 'auto');
  const longFreq = splitReplyIntoSegments(longText, 'frequent');

  check(
    '长文 auto 分 2-4 条',
    longAuto.length >= 2 && longAuto.length <= 4,
    `actual=${longAuto.length}`
  );
  check(
    'frequent 比 auto 更积极',
    longFreq.length >= longAuto.length,
    `auto=${longAuto.length} freq=${longFreq.length}`
  );
  check(
    '分条不丢字不重复（去空白拼接 === 原文）',
    longFreq.join('').replace(/\s+/g, '') === longText.replace(/\s+/g, '')
  );
  check(
    '超过 4 段封顶为 4 条',
    splitReplyIntoSegments('一\n\n二\n\n三\n\n四\n\n五\n\n六', 'auto').length === 4
  );
  check(
    '过短尾巴并入前一条',
    splitReplyIntoSegments('这是一段足够长的话，用来占住第一条的位置。\n\n嗯', 'auto')
      .length === 1
  );
  check(
    '显式换行的短段不被吞并（"1\\n2" -> 两条）',
    JSON.stringify(splitReplyIntoSegments('1\n2', 'auto')) ===
      JSON.stringify(['1', '2'])
  );
  check(
    '带标点的短段同样不被吞并',
    JSON.stringify(splitReplyIntoSegments('1。\n2。', 'auto')) ===
      JSON.stringify(['1。', '2。'])
  );
  check('空文本返回空数组', splitReplyIntoSegments('  ', 'auto').length === 0);

  ORIG_LOG('\nB. /persona 接口');

  if (!server.listening) {
    await new Promise(resolve => server.once('listening', resolve));
  }

  const BASE = `http://127.0.0.1:${server.address().port}`;
  const TOKEN = 'test-token-persona';
  const AUTH = { Authorization: `Bearer ${TOKEN}` };
  const JSON_AUTH = { 'Content-Type': 'application/json', ...AUTH };

  let ready = false;

  for (let i = 0; i < 100 && !ready; i++) {
    try {
      ready = (await fetch(BASE + '/')).ok;
    } catch (_) {
      await new Promise(resolve => setTimeout(resolve, 50));
    }
  }

  check('服务启动', ready);
  if (!ready) return await finish();

  const unauthGet = await fetch(BASE + '/persona');
  const unauthPut = await fetch(BASE + '/persona', {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: '{}',
  });
  check(
    '未授权 GET/PUT 均被拒绝',
    unauthGet.status === 401 && unauthPut.status === 401
  );

  const defaultsRes = await fetch(BASE + '/persona', { headers: AUTH });
  const defaultsBody = await defaultsRes.json();
  check(
    'GET 返回默认配置与 defaults',
    defaultsRes.status === 200 &&
      defaultsBody.config.messageMode === 'auto' &&
      defaultsBody.config.colloquial === 70 &&
      defaultsBody.defaults.messageMode === 'auto'
  );

  const saveRes = await fetch(BASE + '/persona', {
    method: 'PUT',
    headers: JSON_AUTH,
    body: JSON.stringify({
      config: {
        colloquial: 150, // 越界 -> 夹取 100
        warmth: -5, // 越界 -> 夹取 0
        initiative: 80,
        length: 20,
        messageMode: 'frequent',
      },
    }),
  });
  const saveBody = await saveRes.json();
  check(
    'PUT 保存并夹取 0-100',
    saveRes.status === 200 &&
      saveBody.config.colloquial === 100 &&
      saveBody.config.warmth === 0 &&
      saveBody.config.initiative === 80
  );

  const reread = await (await fetch(BASE + '/persona', { headers: AUTH })).json();
  check(
    '保存后 GET 读回一致',
    reread.config.messageMode === 'frequent' && reread.config.length === 20
  );

  // 重启持久化：子进程重读同一数据目录
  const childRead = execFileSync(
    process.execPath,
    [
      '-e',
      `const p=require(${JSON.stringify(path.join(SERVER, 'persona.js'))});process.stdout.write(JSON.stringify(p.getConfig()));`,
    ],
    {
      env: { ...process.env, BLUEBIRD_DATA_DIR: DATA_DIR },
      stdio: ['ignore', 'pipe', 'ignore'],
    }
  ).toString();
  const childConfig = JSON.parse(childRead);
  check(
    '重启（新进程）后配置仍在',
    childConfig.colloquial === 100 &&
      childConfig.initiative === 80 &&
      childConfig.messageMode === 'frequent'
  );

  const resetRes = await fetch(BASE + '/persona', {
    method: 'PUT',
    headers: JSON_AUTH,
    body: JSON.stringify({ reset: true }),
  });
  const resetBody = await resetRes.json();
  check(
    '恢复默认生效',
    resetRes.status === 200 &&
      resetBody.config.colloquial === 70 &&
      resetBody.config.messageMode === 'auto'
  );

  ORIG_LOG('\nC. Prompt 注入与分条行为');

  // single：强制单条，prompt 含风格块
  await fetch(BASE + '/persona', {
    method: 'PUT',
    headers: JSON_AUTH,
    body: JSON.stringify({
      config: { colloquial: 90, warmth: 20, initiative: 10, length: 80, messageMode: 'single' },
    }),
  });

  stubReply = '[mood:calm] 第一段。\n\n第二段。';
  capturedPrompts.length = 0;

  const sChat = sessions.createSession('人格测试').id;
  const chatRes1 = await fetch(BASE + '/chat', {
    method: 'POST',
    headers: JSON_AUTH,
    body: JSON.stringify({ message: '在吗', sessionId: sChat }),
  });
  const chatBody1 = await chatRes1.json();

  check('/chat 正常返回', chatRes1.status === 200, `status=${chatRes1.status}`);

  const prompt1 = capturedPrompts[0] || '';
  check(
    'systemPrompt 注入【说话风格调整】且数值正确',
    prompt1.includes('【说话风格调整】') &&
      prompt1.includes('口语化 90/100') &&
      prompt1.includes('温暖程度 20/100')
  );
  check(
    'single 模式 prompt 含单条约束',
    prompt1.includes('一条完整消息')
  );
  check(
    'single 模式 replies 恰为 1 条且保留原文换行',
    Array.isArray(chatBody1.replies) &&
      chatBody1.replies.length === 1 &&
      chatBody1.replies[0].content === '第一段。\n\n第二段。'
  );
  check(
    'reply 兼容字段保留完整原文',
    chatBody1.reply === '第一段。\n\n第二段。'
  );

  // auto：多段文本分条，逐段落盘
  await fetch(BASE + '/persona', {
    method: 'PUT',
    headers: JSON_AUTH,
    body: JSON.stringify({ config: { messageMode: 'auto' } }),
  });

  stubReply = '[mood:calm] 第一条内容。\n\n第二条内容。\n\n第三条内容。';

  const chatRes2 = await fetch(BASE + '/chat', {
    method: 'POST',
    headers: JSON_AUTH,
    body: JSON.stringify({ message: '多说点', sessionId: sChat }),
  });
  const chatBody2 = await chatRes2.json();

  check(
    'auto 模式分 3 条且内容对应',
    chatBody2.replies.length === 3 &&
      chatBody2.replies[1].content === '第二条内容。'
  );
  check(
    '每条分条有独立 id 与 createdAt',
    chatBody2.replies.every(r => typeof r.id === 'string' && r.id && r.createdAt) &&
      new Set(chatBody2.replies.map(r => r.id)).size === 3
  );

  // 历史恢复：本会话应含 user+1段 + user+3段 = 6 条
  const history1 = await (
    await fetch(BASE + `/history?sessionId=${sChat}`, { headers: AUTH })
  ).json();
  const msgs = history1.history || [];
  const assistantCount = msgs.filter(m => m.role === 'assistant').length;

  check(
    '分条逐条落盘，历史恢复后完整显示',
    msgs.length === 6 && assistantCount === 4,
    `actual=${msgs.length}/${assistantCount}`
  );

  // 撤回：撤掉第二轮用户消息，整轮 3 段一起删除
  const secondUser = msgs.filter(m => m.role === 'user')[1];
  const recallRes = await fetch(BASE + '/history/recall', {
    method: 'POST',
    headers: JSON_AUTH,
    body: JSON.stringify({ sessionId: sChat, messageId: secondUser.id }),
  });

  const history2 = await (
    await fetch(BASE + `/history?sessionId=${sChat}`, { headers: AUTH })
  ).json();

  check(
    '撤回整轮：用户消息与全部 3 段回复一起删除',
    recallRes.status === 200 && (history2.history || []).length === 2,
    `remaining=${(history2.history || []).length}`
  );

  // frequent：阈值更低，且 systemPrompt 给分条倾向
  await fetch(BASE + '/persona', {
    method: 'PUT',
    headers: JSON_AUTH,
    body: JSON.stringify({ config: { messageMode: 'frequent' } }),
  });

  stubReply =
    '[mood:calm] 今天天气真的特别好，我一早就出门了。路上看到一只猫，趴在墙头晒太阳，尾巴一甩一甩的。它懒洋洋地看了我一眼，又闭上眼睛继续睡。我站在那儿看了好久，突然觉得你肯定也会喜欢这一幕。就掏出手机拍下来想给你看。你猜后来怎么着？';
  capturedPrompts.length = 0;

  const chatRes3 = await fetch(BASE + '/chat', {
    method: 'POST',
    headers: JSON_AUTH,
    body: JSON.stringify({ message: '讲讲今天', sessionId: sChat }),
  });
  const chatBody3 = await chatRes3.json();

  check(
    'frequent 模式长回复分多条',
    chatBody3.replies.length >= 2,
    `actual=${chatBody3.replies.length}`
  );
  check(
    'frequent 模式 prompt 鼓励分条',
    (capturedPrompts[0] || '').includes('拆成好几条短消息')
  );

  // 续写：只落 assistant，且也是分条数组
  const beforeContinue = (
    await (
      await fetch(BASE + `/history?sessionId=${sChat}`, { headers: AUTH })
    ).json()
  ).history.length;

  stubReply = '[mood:calm] 续写第一段。\n\n续写第二段。';
  const contRes = await fetch(BASE + '/chat', {
    method: 'POST',
    headers: JSON_AUTH,
    body: JSON.stringify({ mode: 'continue', sessionId: sChat }),
  });
  const contBody = await contRes.json();

  const afterContinue = (
    await (
      await fetch(BASE + `/history?sessionId=${sChat}`, { headers: AUTH })
    ).json()
  ).history;

  check(
    '续写返回分条且只落 assistant 消息',
    contRes.status === 200 &&
      contBody.replies.length === 2 &&
      contBody.userMessageId === null &&
      afterContinue.length === beforeContinue + 2 &&
      afterContinue.slice(-2).every(m => m.role === 'assistant')
  );

  // 短段回归：mergeTinyTail 曾把显式换行的短段压回一条（"1\n2" -> "12"），
  // 这里走端到端：桩模型输出短段 -> replies 两条 -> 逐条落盘
  await fetch(BASE + '/persona', {
    method: 'PUT',
    headers: JSON_AUTH,
    body: JSON.stringify({ config: { messageMode: 'auto' } }),
  });

  stubReply = '[mood:calm] 1\n2';
  capturedPrompts.length = 0;

  const sShort = sessions.createSession('短段回归').id;
  const shortRes = await fetch(BASE + '/chat', {
    method: 'POST',
    headers: JSON_AUTH,
    body: JSON.stringify({
      message: '发两条消息，一条是 1，一条是 2',
      sessionId: sShort,
    }),
  });
  const shortBody = await shortRes.json();

  check(
    '模型输出短段换行时返回两条独立消息',
    shortRes.status === 200 &&
      shortBody.replies.length === 2 &&
      shortBody.replies[0].content === '1' &&
      shortBody.replies[1].content === '2',
    `actual=${JSON.stringify((shortBody.replies || []).map(r => r.content))}`
  );

  const shortHistory = (
    await (
      await fetch(BASE + `/history?sessionId=${sShort}`, { headers: AUTH })
    ).json()
  ).history;

  check(
    '两条短段逐条落盘，历史恢复为两条',
    shortHistory
      .filter(m => m.role === 'assistant')
      .map(m => m.content)
      .join(',') === '1,2'
  );

  check(
    'auto 模式 prompt 含分条协议（换行 = 独立消息）',
    (capturedPrompts[0] || '').includes('每换一行就是一条新消息')
  );

  ORIG_LOG('\nD. 连续发送与会话隔离');

  stubReply = '[mood:calm] 第一段。\n\n第二段。';
  const sA = sessions.createSession('会话A').id;
  const sB = sessions.createSession('会话B').id;

  await fetch(BASE + '/chat', {
    method: 'POST',
    headers: JSON_AUTH,
    body: JSON.stringify({ message: 'A1', sessionId: sA }),
  });
  await fetch(BASE + '/chat', {
    method: 'POST',
    headers: JSON_AUTH,
    body: JSON.stringify({ message: 'A2', sessionId: sA }),
  });

  const msgsA = (
    await (
      await fetch(BASE + `/history?sessionId=${sA}`, { headers: AUTH })
    ).json()
  ).history;
  const rolesA = msgsA.map(m => m.role).join(',');
  const idsA = new Set(msgsA.map(m => m.id));

  check(
    '连续发送两轮：顺序正确且 id 全部唯一',
    rolesA ===
      'user,assistant,assistant,user,assistant,assistant' &&
      idsA.size === msgsA.length,
    rolesA
  );

  const msgsB = (
    await (
      await fetch(BASE + `/history?sessionId=${sB}`, { headers: AUTH })
    ).json()
  ).history;
  check('A 会话的多段回复不串进 B 会话', msgsB.length === 0);

  ORIG_LOG('\nE. 配置损坏：原地只读保护（子进程）');

  fs.writeFileSync(
    path.join(DATA_DIR, 'persona.json'),
    '{ broken json',
    'utf8'
  );

  const childCorrupt = execFileSync(
    process.execPath,
    [
      '-e',
      `const fs=require('fs');const p=require(${JSON.stringify(path.join(SERVER, 'persona.js'))});const before=fs.readFileSync(${JSON.stringify(path.join(DATA_DIR, 'persona.json'))},'utf8');const cfg=p.getConfig();const save=p.saveConfig({colloquial:1});const after=fs.readFileSync(${JSON.stringify(path.join(DATA_DIR, 'persona.json'))},'utf8');process.stdout.write(JSON.stringify({cfg,save,beforeSame:before===after}));`,
    ],
    {
      env: { ...process.env, BLUEBIRD_DATA_DIR: DATA_DIR },
      stdio: ['ignore', 'pipe', 'ignore'],
    }
  ).toString();
  const corruptResult = JSON.parse(childCorrupt);

  check(
    '损坏时回退默认配置',
    corruptResult.cfg.colloquial === 70 &&
      corruptResult.cfg.messageMode === 'auto'
  );
  check(
    '损坏时拒绝写入（返回 null）',
    corruptResult.save === null
  );
  check(
    '损坏文件原地保留，未被覆盖',
    corruptResult.beforeSame === true
  );

  await finish();
}

async function finish() {
  await closeHttpServer();

  ORIG_LOG('');
  ORIG_LOG(`通过 ${passed} 项，失败 ${failed} 项`);

  if (failed > 0) {
    ORIG_LOG('\n失败项：');
    for (const item of failures) ORIG_LOG(`  - ${item}`);
  }

  console.log = ORIG_LOG;
  console.error = ORIG_ERR;

  // 不调用 process.exit：等句柄自然排空，避免 Windows 上 libuv 断言
  process.exitCode = failed > 0 ? 1 : 0;
}

main().catch(error => {
  ORIG_ERR('persona test crashed:', error);
  process.exitCode = 1;
});
