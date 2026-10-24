/**
 * 云岫 Bluebird — 聊天时间间隔感知测试
 *
 * 独立脚本（非 node:test）：与 tests/presence.test.js 同款极简 runner，测完显式退出。
 * 隔离保证：所有数据都落在系统临时目录（BLUEBIRD_DATA_DIR），
 * 不读取、修改或清空真实 server/data。
 *
 * 覆盖：
 *   - gapSemanticLabel 边界：刚刚 / 几分钟 / 分钟 / 小时 / 一天 / 多天（天数精确）；
 *   - buildTimeGapContext：分钟级、小时级、跨天间隔的数值与 prompt 文本；
 *   - 两种间隔分离：距上一条用户消息 vs 距 Blue 上一条回复（续写分叉场景）；
 *   - 会话隔离：不同会话的时间互不相同、互不串用；
 *   - 时间数据缺失/不可解析：明确"无法确定"，不编造间隔；
 *   - 空历史：第一次聊天；
 *   - /chat 端到端：systemPrompt 中确实注入两种间隔与回答指令。
 *
 * 运行：node tests/time-gap.test.js
 */
const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');

// 测试在进程内 require server/index.js，会真的起一个 HTTP 服务。
// 退出前必须关掉它（含 keep-alive 连接），否则 Windows 上 process.exit
// 会撞上 libuv 的 UV_HANDLE_CLOSING 断言，导致非零退出码。
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
const TMP_ROOT = fs.mkdtempSync(path.join(os.tmpdir(), 'bluebird-timegap-'));
const DATA_DIR = path.join(TMP_ROOT, 'data');
fs.mkdirSync(DATA_DIR, { recursive: true });

const ORIG_LOG = console.log;
const ORIG_ERR = console.error;

// 屏蔽常规日志，保留错误输出
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

function isoAgo(ms) {
  return new Date(Date.now() - ms).toISOString();
}

const MIN = 60 * 1000;
const HOUR = 60 * MIN;
const DAY = 24 * HOUR;

// ---- 桩模块：模型（捕获 systemPrompt）/ 记忆（不写真实记忆） ----
const capturedPrompts = [];
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
              choices: [{ message: { content: '[mood:calm] 在' } }],
            };
          },
        },
      };
    }
  },
};

function stubModule(file, exportsObj) {
  const target = require.resolve(path.join(SERVER, file));
  require.cache[target] = {
    id: target,
    filename: target,
    loaded: true,
    exports: exportsObj,
  };
}

stubModule('memory.js', {
  buildMemoryContext: () => '',
  processMemory: async () => null,
  clearMemories: () => {},
  recallMemoryBySourceQuote: async () => {},
  getMemories: () => [],
  deleteMemory: () => false,
});

process.env.BLUEBIRD_DATA_DIR = DATA_DIR;
process.env.PORT = '0';
process.env.BLUEBIRD_API_TOKEN = 'test-token-timegap';
process.env.DEEPSEEK_API_KEY = 'stub-key';

const sessions = require(path.join(SERVER, 'sessions.js'));
const {
  buildTimeGapContext,
  gapSemanticLabel,
  server,
} = require(path.join(SERVER, 'index.js'));

process.on('exit', () => {
  try {
    fs.rmSync(TMP_ROOT, { recursive: true, force: true });
  } catch (_) {
    /* 清理失败不影响测试结果 */
  }
});

// 数值断言允许 2 秒执行误差
function closeTo(actual, expected, tolerance = 2) {
  return typeof actual === 'number' && Math.abs(actual - expected) <= tolerance;
}

async function main() {
  ORIG_LOG('\nA. gapSemanticLabel 边界');

  check('0 分钟 -> 刚刚', gapSemanticLabel(0, 0, 0) === '刚刚');
  check('5 分钟 -> 几分钟前', gapSemanticLabel(5, 0, 0) === '几分钟前');
  check(
    '45 分钟 -> 约45分钟前',
    gapSemanticLabel(45, 0, 0) === '约45分钟前'
  );
  check('3 小时 -> 约3小时前', gapSemanticLabel(180, 3, 0) === '约3小时前');
  check(
    '10 小时 -> 约10小时前',
    gapSemanticLabel(600, 10, 0) === '约10小时前'
  );
  check(
    '26 小时 -> 一天左右',
    gapSemanticLabel(1560, 26, 1) === '距离上次已经一天左右'
  );
  check(
    '3 天 -> 已经3天了（天数精确）',
    gapSemanticLabel(4320, 72, 3) === '已经3天了'
  );

  ORIG_LOG('\nB. 分钟级 / 小时级 / 跨天间隔');

  const sB = sessions.createSession('分钟级').id;
  sessions.appendMessages(sB, [
    { role: 'user', content: '在吗', createdAt: isoAgo(20 * MIN) },
    { role: 'assistant', content: '在', createdAt: isoAgo(20 * MIN - 5000) },
  ]);

  const gapB = buildTimeGapContext('Asia/Shanghai', sB);
  check(
    '20 分钟前：gapSeconds ≈ 1200',
    closeTo(gapB.gapSeconds, 1200)
  );
  check(
    '20 分钟前：语义标签约20分钟前',
    gapB.timeContext === '约20分钟前'
  );
  check(
    '20 分钟前：prompt 含可读间隔与用户消息时间',
    gapB.promptText.includes('距离上一条用户消息：20分钟') &&
      gapB.promptText.includes('用户上一条消息时间：') &&
      gapB.previousUserMessageTime !== null
  );

  const sC = sessions.createSession('小时级').id;
  sessions.appendMessages(sC, [
    { role: 'user', content: '早', createdAt: isoAgo(5 * HOUR) },
    { role: 'assistant', content: '早', createdAt: isoAgo(5 * HOUR - 8000) },
  ]);

  const gapC = buildTimeGapContext('Asia/Shanghai', sC);
  check(
    '5 小时前：gapHours=5 且标签约5小时前',
    gapC.gapHours === 5 && gapC.timeContext === '约5小时前'
  );
  check(
    '5 小时前：可读间隔为 5小时',
    gapC.promptText.includes('距离上一条用户消息：5小时')
  );

  const sD = sessions.createSession('跨天').id;
  sessions.appendMessages(sD, [
    { role: 'user', content: '上次聊', createdAt: isoAgo(2 * DAY + 12 * HOUR) },
    {
      role: 'assistant',
      content: '嗯',
      createdAt: isoAgo(2 * DAY + 12 * HOUR - 10000),
    },
  ]);

  const gapD = buildTimeGapContext('Asia/Shanghai', sD);
  check(
    '2天12小时前：gapDays=2 且标签带精确天数',
    gapD.gapDays === 2 && gapD.timeContext === '已经2天了'
  );
  check(
    '2天12小时前：可读间隔为 2天12小时',
    gapD.promptText.includes('距离上一条用户消息：2天12小时')
  );

  ORIG_LOG('\nC. 两种间隔分离（续写导致分叉）');

  // 用户消息在 26 小时前，Blue 最近一次回复（续写）在 1 小时前
  const sE = sessions.createSession('分叉').id;
  sessions.appendMessages(sE, [
    { role: 'user', content: '昨天的消息', createdAt: isoAgo(26 * HOUR) },
    {
      role: 'assistant',
      content: '当时的回复',
      createdAt: isoAgo(26 * HOUR - 5000),
    },
    { role: 'assistant', content: '续写内容', createdAt: isoAgo(1 * HOUR) },
  ]);

  const gapE = buildTimeGapContext('Asia/Shanghai', sE);
  check(
    '用户消息间隔 ≈ 26 小时',
    closeTo(gapE.gapSeconds, 26 * 3600, 5)
  );
  check(
    'Blue 回复间隔 ≈ 1 小时',
    closeTo(gapE.blueGapSeconds, 3600, 5)
  );
  check(
    'prompt 同时给出两种间隔且分开标注',
    gapE.promptText.includes('距离上一条用户消息：1天2小时') &&
      gapE.promptText.includes('距离 Blue 上一条回复：1小时')
  );
  check(
    'prompt 含回答指令与区分提示',
    gapE.promptText.includes('必须依据上面的实际时间数据') &&
      gapE.promptText.includes('注意区分两种间隔')
  );

  ORIG_LOG('\nD. 会话隔离');

  const sF1 = sessions.createSession('三天前').id;
  sessions.appendMessages(sF1, [
    { role: 'user', content: 'A 会话', createdAt: isoAgo(3 * DAY) },
    { role: 'assistant', content: '好', createdAt: isoAgo(3 * DAY - 5000) },
  ]);

  const sF2 = sessions.createSession('十分钟前').id;
  sessions.appendMessages(sF2, [
    { role: 'user', content: 'B 会话', createdAt: isoAgo(10 * MIN) },
    { role: 'assistant', content: '在', createdAt: isoAgo(10 * MIN - 5000) },
  ]);

  const gapF1 = buildTimeGapContext('Asia/Shanghai', sF1);
  const gapF2 = buildTimeGapContext('Asia/Shanghai', sF2);

  check(
    '会话 A 间隔 3 天，不受会话 B 影响',
    gapF1.gapDays === 3 && gapF1.timeContext === '已经3天了'
  );
  check(
    '会话 B 间隔 10 分钟，不受会话 A 影响',
    gapF2.gapDays === 0 && gapF2.timeContext === '约10分钟前'
  );
  check(
    '默认会话为空时为第一次聊天，不借用其他会话历史',
    buildTimeGapContext('Asia/Shanghai', 'default').timeContext ===
      '第一次聊天'
  );

  ORIG_LOG('\nE. 时间数据缺失 / 空历史');

  const sG = sessions.createSession('坏时间').id;
  sessions.appendMessages(sG, [
    { role: 'user', content: '时间坏了', createdAt: 'not-a-date' },
  ]);

  const gapG = buildTimeGapContext('Asia/Shanghai', sG);
  check(
    '不可解析时间 -> 时间数据缺失',
    gapG.timeContext === '时间数据缺失'
  );
  check(
    '不可解析时间 -> 间隔字段为 null 且不编造',
    gapG.gapSeconds === null &&
      gapG.gapDays === null &&
      gapG.promptText.includes('无法确定') &&
      gapG.promptText.includes('不要编造')
  );

  const sH = sessions.createSession('空会话').id;
  const gapH = buildTimeGapContext('Asia/Shanghai', sH);
  check(
    '空历史 -> 第一次聊天且间隔为 null',
    gapH.timeContext === '第一次聊天' && gapH.gapSeconds === null
  );
  check(
    '空历史 -> prompt 不含编造的间隔',
    !gapH.promptText.includes('分钟前') && !gapH.promptText.includes('天')
  );

  ORIG_LOG('\nF. /chat 端到端：systemPrompt 注入两种间隔');

  if (!server.listening) {
    await new Promise(resolve => server.once('listening', resolve));
  }

  const BASE = `http://127.0.0.1:${server.address().port}`;
  const TOKEN = 'test-token-timegap';

  let ready = false;

  for (let i = 0; i < 100 && !ready; i++) {
    try {
      ready = (await fetch(BASE + '/')).ok;
    } catch (_) {
      await new Promise(resolve => setTimeout(resolve, 50));
    }
  }

  check('服务启动', ready);

  if (ready) {
    const sChat = sessions.createSession('端到端').id;

    // 第一轮：先落一对消息（stub 模型回复）
    await fetch(BASE + '/chat', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${TOKEN}`,
      },
      body: JSON.stringify({ message: '第一句', sessionId: sChat }),
    });

    // 第二轮：捕获这一轮的 systemPrompt
    capturedPrompts.length = 0;

    const res = await fetch(BASE + '/chat', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${TOKEN}`,
      },
      body: JSON.stringify({ message: '我们隔了多久没聊', sessionId: sChat }),
    });

    check('/chat 正常返回', res.status === 200, `status=${res.status}`);

    const prompt = capturedPrompts[0] || '';

    check(
      'systemPrompt 注入【对话间隔】与两种间隔',
      prompt.includes('【对话间隔】') &&
        prompt.includes('距离上一条用户消息：') &&
        prompt.includes('距离 Blue 上一条回复：')
    );
    check(
      'systemPrompt 含明确回答指令',
      prompt.includes('必须依据上面的实际时间数据') &&
        prompt.includes('注意区分两种间隔')
    );
  }

  await closeHttpServer();

  ORIG_LOG('');
  ORIG_LOG(`通过 ${passed} 项，失败 ${failed} 项`);

  if (failed > 0) {
    ORIG_LOG('\n失败项：');
    for (const item of failures) ORIG_LOG(`  - ${item}`);
  }

  console.log = ORIG_LOG;
  console.error = ORIG_ERR;

  // 不调用 process.exit：等句柄自然排空（与 session-scope-e2e 同款收尾），
  // 避免 Windows 上撞上 libuv UV_HANDLE_CLOSING 断言
  process.exitCode = failed > 0 ? 1 : 0;
}

main().catch(error => {
  ORIG_ERR('time-gap test crashed:', error);
  process.exitCode = 1;
});
