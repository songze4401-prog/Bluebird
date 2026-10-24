/**
 * 云岫 Bluebird — 在线状态感知 V1 测试
 *
 * 独立脚本（非 node:test）：与 tests/api.test.js 同款极简 runner，测完显式退出。
 * 隔离保证：所有数据都落在系统临时目录（BLUEBIRD_DATA_DIR），
 * 不读取、修改或清空真实 server/data。
 *
 * 覆盖：
 *   - HTTP：未授权被拒、参数校验、前后台切换、心跳、重复请求去重、
 *           乱序旧事件不回滚、/chat 联动等待计时、撤回/删除会话后的等待状态、
 *           多会话等待状态互不影响；
 *   - 模块：无数据 -> unknown（不当离线）、前台 + 5 分钟内有互动 -> active、
 *           超过 5 分钟无互动且心跳正常 -> away、心跳过期 -> unknown、
 *           后台状态优先且单独记录、恢复前台立即 active、
 *           Blue 等待计时按会话隔离、新消息重置计时、重启后状态保持一致、
 *           presence.json 损坏隔离且不泄露文件内容。
 *
 * 运行：node tests/presence.test.js
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
const TMP_ROOT = fs.mkdtempSync(path.join(os.tmpdir(), 'bluebird-presence-'));

const ORIG_LOG = console.log;
const ORIG_ERR = console.error;
const errorLines = [];

// 屏蔽常规日志，只收集 stderr（损坏事件与隔离提示走这里）
console.log = () => {};
console.error = (...args) => {
  errorLines.push(args.map(item => String(item)).join(' '));
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

function newDir(name) {
  const dir = path.join(TMP_ROOT, name);
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

function iso(ms) {
  return new Date(ms).toISOString();
}

const T = Date.parse('2026-10-23T10:00:00.000Z');
const MIN = 60 * 1000;
const DAY = 24 * 60 * MIN;

/** 清 require 缓存 + 指向临时数据目录，拿到干净的 presence 模块实例 */
function freshModule(name, dataDir) {
  const target = require.resolve(path.join(SERVER, name));
  delete require.cache[target];
  process.env.BLUEBIRD_DATA_DIR = dataDir;
  return require(target);
}

function stubModule(file, exportsObj) {
  const target = require.resolve(path.join(SERVER, file));
  require.cache[target] = {
    id: target,
    filename: target,
    loaded: true,
    exports: exportsObj,
  };
}

process.on('exit', () => {
  try {
    fs.rmSync(TMP_ROOT, { recursive: true, force: true });
  } catch (_) {
    /* 清理失败不影响测试结果 */
  }
});

async function runHttpSection() {
  const DATA_DIR = newDir('http');

  // ---- 桩模块：模型 / 记忆（不真正请求模型，不写真实记忆） ----
  const openaiTarget = require.resolve('openai', { paths: [SERVER] });

  require.cache[openaiTarget] = {
    id: openaiTarget,
    filename: openaiTarget,
    loaded: true,
    exports: class StubOpenAI {
      constructor() {
        this.chat = {
          completions: {
            create: async () => ({
              model: 'stub-model',
              choices: [{ message: { content: '[mood:calm] 在' } }],
            }),
          },
        };
      }
    },
  };

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
  process.env.BLUEBIRD_API_TOKEN = 'test-token-presence';
  // 必须赋非空值，否则 client 为 null、/chat 走降级路径；openai 已被桩替换。
  process.env.DEEPSEEK_API_KEY = 'stub-key';

  const indexTarget = require.resolve(path.join(SERVER, 'index.js'));
  delete require.cache[indexTarget];

  const { server } = require(indexTarget);

  if (!server.listening) {
    await new Promise(resolve => server.once('listening', resolve));
  }

  const BASE = `http://127.0.0.1:${server.address().port}`;
  const TOKEN = 'test-token-presence';

  let ready = false;

  for (let i = 0; i < 100 && !ready; i++) {
    try {
      ready = (await fetch(BASE + '/')).ok;
    } catch (_) {
      await new Promise(resolve => setTimeout(resolve, 50));
    }
  }

  if (!ready) {
    check('服务启动', false, '5 秒内未就绪');
    return;
  }

  async function req(p, { method = 'GET', body, token = TOKEN } = {}) {
    const res = await fetch(BASE + p, {
      method,
      headers: {
        'Content-Type': 'application/json',
        ...(token ? { Authorization: `Bearer ${token}` } : {}),
      },
      body: body ? JSON.stringify(body) : undefined,
    });

    let json = null;
    try {
      json = await res.json();
    } catch (_) {
      /* 非 JSON 响应 */
    }

    return { status: res.status, json };
  }

  ORIG_LOG('\nA. HTTP：鉴权与参数校验');

  const noAuthGet = await req('/presence?sessionId=default', { token: '' });
  check('未授权 GET /presence 被拒绝', noAuthGet.status === 401);

  const noAuthReport = await req('/presence/report', {
    method: 'POST',
    token: '',
    body: { appState: 'foreground' },
  });
  check('未授权 POST /presence/report 被拒绝', noAuthReport.status === 401);

  const badState = await req('/presence/report', {
    method: 'POST',
    body: { appState: 'sleeping' },
  });
  check('非法 appState 返回 400', badState.status === 400);

  const emptyReport = await req('/presence/report', {
    method: 'POST',
    body: {},
  });
  check('空上报返回 400', emptyReport.status === 400);

  ORIG_LOG('\nB. HTTP：前后台切换、心跳与去重');

  const now = Date.now();

  const foreground = await req('/presence/report', {
    method: 'POST',
    body: {
      appState: 'foreground',
      interaction: true,
      sessionId: 'default',
      eventId: 'http-e1',
      occurredAt: iso(now),
    },
  });

  check(
    '前台 + 互动 -> active',
    foreground.status === 200 &&
      foreground.json.presence.user.status === 'active',
    JSON.stringify(foreground.json)
  );
  check(
    '记录 lastSeen / lastInteraction / appState / statusUpdatedAt',
    foreground.json.presence.user.lastSeenAt !== null &&
      foreground.json.presence.user.lastInteractionAt !== null &&
      foreground.json.presence.user.appState === 'foreground' &&
      foreground.json.presence.user.statusUpdatedAt !== null
  );

  const readBack = await req('/presence?sessionId=default');
  check(
    'GET /presence 返回同一状态',
    readBack.status === 200 &&
      readBack.json.presence.user.status === 'active' &&
      readBack.json.presence.sessionId === 'default'
  );

  const missingSession = await req('/presence?sessionId=no-such-session');
  check('未知会话读取状态返回 404', missingSession.status === 404);

  const duplicate = await req('/presence/report', {
    method: 'POST',
    body: {
      appState: 'foreground',
      interaction: true,
      sessionId: 'default',
      eventId: 'http-e1',
      occurredAt: iso(now),
    },
  });
  check(
    '重复 eventId 被识别且不改写状态',
    duplicate.status === 200 &&
      duplicate.json.duplicate === true &&
      duplicate.json.presence.user.lastSeenAt ===
        foreground.json.presence.user.lastSeenAt
  );

  // 乱序：更早的 background 事件不应把已记录的前台状态回滚
  const staleBackground = await req('/presence/report', {
    method: 'POST',
    body: {
      appState: 'background',
      sessionId: 'default',
      eventId: 'http-e0-old',
      occurredAt: iso(now - 60 * 1000),
    },
  });
  check(
    '乱序旧事件不回滚 appState',
    staleBackground.status === 200 &&
      staleBackground.json.presence.user.appState === 'foreground'
  );

  const background = await req('/presence/report', {
    method: 'POST',
    body: {
      appState: 'background',
      sessionId: 'default',
      eventId: 'http-e2',
      occurredAt: iso(now + 1000),
    },
  });
  check(
    '切入后台 -> away（app_background）',
    background.status === 200 &&
      background.json.presence.user.status === 'away' &&
      background.json.presence.user.reason === 'app_background' &&
      background.json.presence.user.appState === 'background'
  );

  const resumed = await req('/presence/report', {
    method: 'POST',
    body: {
      appState: 'foreground',
      interaction: true,
      sessionId: 'default',
      eventId: 'http-e3',
      occurredAt: iso(now + 2000),
    },
  });
  check(
    '重新进入前台并互动 -> 立即恢复 active',
    resumed.status === 200 &&
      resumed.json.presence.user.status === 'active'
  );

  ORIG_LOG('\nC. HTTP：/chat 联动 Blue 等待计时');

  const chat = await req('/chat', {
    method: 'POST',
    body: { message: '在线状态测试', sessionId: 'default' },
  });

  check(
    '/chat 正常返回',
    chat.status === 200 && typeof chat.json.reply === 'string',
    JSON.stringify(chat.json)
  );

  const afterChat = await req('/presence?sessionId=default');
  const wait = afterChat.json.presence.wait;

  check(
    'Blue 发出消息后等待用户回复',
    wait.waiting === true && wait.lastBlueMessageAt !== null
  );
  check(
    '等待计时从 Blue 最后一条消息开始',
    wait.waitingSince === wait.lastBlueMessageAt &&
      wait.waitedSeconds >= 0
  );
  check(
    '用户消息时间不晚于 Blue 消息时间',
    wait.lastUserMessageAt !== null &&
      Date.parse(wait.lastUserMessageAt) <= Date.parse(wait.lastBlueMessageAt)
  );

  // 多会话隔离：新会话的等待状态不影响默认会话
  const created = await req('/sessions', {
    method: 'POST',
    body: { title: 'Presence B' },
  });
  const sessionB = created.json.session.id;

  await req('/chat', {
    method: 'POST',
    body: { message: '另一个会话', sessionId: sessionB },
  });

  const waitB = (await req(`/presence?sessionId=${sessionB}`)).json.presence
    .wait;
  const waitDefault = (await req('/presence?sessionId=default')).json.presence
    .wait;

  check(
    '多会话等待状态各自独立',
    waitB.waiting === true && waitDefault.waiting === true
  );

  // 跨会话撤回必须被拒绝：用默认会话的 messageId 去撤回会话 B
  const recalled = await req('/history/recall', {
    method: 'POST',
    body: { sessionId: sessionB, messageId: chat.json.userMessageId },
  });
  check('跨会话撤回被拒绝', recalled.status === 404);

  const recalledDefault = await req('/history/recall', {
    method: 'POST',
    body: { sessionId: 'default', messageId: chat.json.userMessageId },
  });
  check(
    '撤回默认会话消息成功',
    recalledDefault.status === 200 && recalledDefault.json.ok === true
  );

  const afterRecall = (await req('/presence?sessionId=default')).json.presence
    .wait;
  check(
    '撤回后等待计时归零',
    afterRecall.waiting === false && afterRecall.waitedSeconds === 0
  );

  // 删除会话后，其等待状态不应残留在 presence.json
  const deleted = await req(`/sessions/${sessionB}`, { method: 'DELETE' });
  check('删除会话成功', deleted.status === 200 && deleted.json.ok === true);

  const presenceFile = path.join(DATA_DIR, 'presence.json');
  check('presence.json 已持久化', fs.existsSync(presenceFile));

  let stored = null;
  try {
    stored = JSON.parse(fs.readFileSync(presenceFile, 'utf8'));
  } catch (_) {
    stored = null;
  }

  check(
    '删除会话后不残留等待条目',
    !!stored && !stored.sessions[sessionB]
  );

  await closeHttpServer();
}

function runModuleSection() {
  ORIG_LOG('\nD. 模块：活跃 / 可能离开 / 未知（时间推进）');

  const dirA = newDir('a');
  const presence = freshModule('presence', dirA);

  const initial = presence.getPresence('s1', T);
  check(
    '无任何上报 -> unknown（不当离线）',
    initial.user.status === 'unknown' && initial.user.reason === 'no_data'
  );

  const first = presence.recordReport(
    {
      appState: 'foreground',
      interaction: true,
      sessionId: 's1',
      eventId: 'e1',
      occurredAt: iso(T),
    },
    T
  );

  check(
    '前台 + 最近互动 -> active',
    first.presence.user.status === 'active' &&
      first.presence.user.reason === 'foreground_recent_interaction'
  );
  check(
    'lastSeen / lastInteraction / statusUpdatedAt 均写入',
    first.presence.user.lastSeenAt === iso(T) &&
      first.presence.user.lastInteractionAt === iso(T) &&
      first.presence.user.statusUpdatedAt === iso(T)
  );

  const duplicate = presence.recordReport(
    {
      appState: 'foreground',
      interaction: true,
      sessionId: 's1',
      eventId: 'e1',
      occurredAt: iso(T),
    },
    T + 1000
  );

  check(
    '同一 eventId 重复上报被忽略',
    duplicate.duplicate === true &&
      duplicate.presence.user.lastSeenAt === iso(T)
  );

  presence.recordReport(
    {
      appState: 'foreground',
      heartbeat: true,
      sessionId: 's1',
      eventId: 'e2',
      occurredAt: iso(T + 30000),
    },
    T + 30000
  );

  presence.recordReport(
    {
      appState: 'foreground',
      heartbeat: true,
      sessionId: 's1',
      eventId: 'e3',
      occurredAt: iso(T + 5 * MIN),
    },
    T + 5 * MIN
  );

  const exactlyFive = presence.getPresence('s1', T + 5 * MIN);
  check(
    '恰好 5 分钟仍算 active（含边界）',
    exactlyFive.user.status === 'active'
  );

  const oneMsLate = presence.getPresence('s1', T + 5 * MIN + 1);
  check(
    '超过 5 分钟无互动 + 心跳正常 -> away',
    oneMsLate.user.status === 'away' &&
      oneMsLate.user.reason === 'interaction_stale'
  );
  check(
    '状态变化推进 statusUpdatedAt',
    oneMsLate.user.statusUpdatedAt === iso(T + 5 * MIN + 1)
  );

  const expired = presence.getPresence(
    's1',
    T + 5 * MIN + presence.HEARTBEAT_TTL_MS + 1
  );
  check(
    '心跳过期且无法确认客户端 -> unknown',
    expired.user.status === 'unknown' &&
      expired.user.reason === 'heartbeat_expired' &&
      expired.user.heartbeatExpired === true
  );

  const background = presence.recordReport(
    {
      appState: 'background',
      sessionId: 's1',
      eventId: 'e4',
      occurredAt: iso(T + 20 * MIN),
    },
    T + 20 * MIN
  );
  check(
    '后台状态单独记录 -> away',
    background.presence.user.appState === 'background' &&
      background.presence.user.status === 'away'
  );

  const longAway = presence.getPresence('s1', T + DAY);
  check(
    '明确的 background 不因心跳过期变成 unknown',
    longAway.user.status === 'away' &&
      longAway.user.reason === 'app_background'
  );

  const staleForeground = presence.recordReport(
    {
      appState: 'foreground',
      sessionId: 's1',
      eventId: 'e-old',
      occurredAt: iso(T + 10 * MIN),
    },
    T + DAY
  );
  check(
    '乱序到达的旧前台事件不会覆盖较新的后台状态',
    staleForeground.presence.user.appState === 'background'
  );

  const resume = presence.recordReport(
    {
      appState: 'foreground',
      interaction: true,
      sessionId: 's1',
      eventId: 'e5',
      occurredAt: iso(T + DAY + 1000),
    },
    T + DAY + 1000
  );
  check(
    '重新回前台并互动 -> 立即 active',
    resume.presence.user.status === 'active' &&
      resume.presence.user.lastInteractionAt === iso(T + DAY + 1000)
  );

  const resumeExpired = presence.getPresence(
    's1',
    T + DAY + 1000 + presence.HEARTBEAT_TTL_MS + 1
  );
  check(
    '恢复后若心跳再次过期 -> unknown（不无限在线）',
    resumeExpired.user.status === 'unknown' &&
      resumeExpired.user.reason === 'heartbeat_expired'
  );

  ORIG_LOG('\nE. 模块：Blue 等待用户回复（按会话）');

  const dirB = newDir('b');
  const waitPresence = freshModule('presence', dirB);

  const userMsg = waitPresence.recordUserMessage('session-a', T, T);
  check(
    '只有用户消息时不在等待',
    userMsg.wait.waiting === false && userMsg.wait.waitedSeconds === 0
  );

  waitPresence.recordBlueMessage('session-a', T + 1000);

  const waiting = waitPresence.getPresence('session-a', T + 61000).wait;
  check(
    'Blue 最后一条消息开始计时',
    waiting.waiting === true &&
      waiting.waitingSince === iso(T + 1000) &&
      waiting.waitedSeconds === 60
  );
  check(
    '等待状态里保留双方最后消息时间',
    waiting.lastUserMessageAt === iso(T) &&
      waiting.lastBlueMessageAt === iso(T + 1000)
  );

  waitPresence.recordUserMessage('session-b', T + 2000, T + 2000);
  const sessionB = waitPresence.getPresence('session-b', T + 61000).wait;
  check('另一会话未被上一会话的等待污染', sessionB.waiting === false);

  const stillWaiting = waitPresence.getPresence('session-a', T + 61000).wait;
  check('会话 A 的等待状态不受会话 B 影响', stillWaiting.waiting === true);

  const replied = waitPresence.recordUserMessage(
    'session-a',
    T + 70000,
    T + 70000
  );
  check(
    '用户新消息重置等待计时',
    replied.wait.waiting === false && replied.wait.waitedSeconds === 0
  );

  waitPresence.recordBlueMessage('session-a', T + 80000);
  const waitingAgain = waitPresence.getPresence('session-a', T + 90000).wait;
  check(
    'Blue 再次发消息后重新计时',
    waitingAgain.waiting === true &&
      waitingAgain.waitingSince === iso(T + 80000) &&
      waitingAgain.waitedSeconds === 10
  );

  waitPresence.resetSessionWait('session-a');
  const reset = waitPresence.getPresence('session-a', T + 90000).wait;
  check(
    '清空/撤回后等待计时归零',
    reset.waiting === false && reset.lastUserMessageAt === null
  );

  waitPresence.recordBlueMessage('session-a', T + 100000);
  waitPresence.forgetSession('session-a');
  const forgotten = waitPresence.getPresence('session-a', T + 110000);
  check(
    '删除会话后对应等待条目被移除',
    forgotten.wait.waiting === false && forgotten.wait.sessionId === 'session-a'
  );
  check(
    '全局最后一条 Blue 消息时间仍保留',
    forgotten.lastBlueMessageAt === iso(T + 100000)
  );

  ORIG_LOG('\nF. 模块：重启后状态保持一致');

  const dirC = newDir('c');
  const firstRun = freshModule('presence', dirC);

  firstRun.recordReport(
    {
      appState: 'foreground',
      interaction: true,
      sessionId: 's',
      eventId: 'persist-1',
      occurredAt: iso(T),
    },
    T
  );
  firstRun.recordUserMessage('s', T + 1000, T + 1000);
  firstRun.recordBlueMessage('s', T + 2000);

  const secondRun = freshModule('presence', dirC);
  const reloaded = secondRun.getPresence('s', T + 62000);

  check(
    '重启后等待计时保持一致',
    reloaded.wait.waiting === true && reloaded.wait.waitedSeconds === 60
  );
  check(
    '重启后前后台状态与 lastSeen 保持一致',
    reloaded.user.appState === 'foreground' &&
      reloaded.user.lastSeenAt === iso(T + 1000) &&
      reloaded.user.status === 'active'
  );
  check(
    '重启后 eventId 仍能去重',
    secondRun.recordReport(
      {
        appState: 'foreground',
        interaction: true,
        sessionId: 's',
        eventId: 'persist-1',
        occurredAt: iso(T),
      },
      T + 62000
    ).duplicate === true
  );

  ORIG_LOG('\nG. 模块：presence.json 损坏');

  const dirD = newDir('d');
  const SENTINEL = 'SENSITIVE_PRESENCE_MARKER_7c1d';

  fs.writeFileSync(
    path.join(dirD, 'presence.json'),
    `{ "broken": "${SENTINEL}"`,
    'utf8'
  );

  const corrupted = freshModule('presence', dirD);
  const afterCorruption = corrupted.getPresence('s', T);

  check(
    '损坏文件回退为空状态（unknown/no_data）',
    afterCorruption.user.status === 'unknown' &&
      afterCorruption.user.reason === 'no_data'
  );

  const files = fs.readdirSync(dirD);
  check(
    '损坏文件被隔离重命名',
    files.some(name => name.startsWith('presence.json.corrupt-'))
  );
  check(
    '日志不泄露文件内容',
    !errorLines.some(line => line.includes(SENTINEL))
  );
}

async function main() {
  await runHttpSection();
  runModuleSection();

  ORIG_LOG('');
  ORIG_LOG(`通过 ${passed} 项，失败 ${failed} 项`);

  if (failed > 0) {
    ORIG_LOG('\n失败项：');
    for (const item of failures) ORIG_LOG(`  - ${item}`);
  }

  process.exit(failed > 0 ? 1 : 0);
}

main().catch(error => {
  ORIG_ERR('presence test crashed:', error);
  process.exit(1);
});
