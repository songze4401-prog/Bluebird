/**
 * 云岫 Bluebird — 记忆相关 HTTP 接口的完成语义（P1-2 / P1-3 / P2-2 + 硬性要求 3）
 *
 * 硬性要求 3 的原话是：「撤回接口不能在实际修改失败时仍让调用方误以为成功；
 * 同时要验证内存、磁盘和返回结果一致，不能只检查 HTTP 状态码。」
 * 因此本文件把每一条记忆写接口都当成一次三方对账：
 *   返回体 ↔ GET /memory 的内存视图 ↔ server 数据目录里的 memory.json
 * 并且专门构造一次「磁盘写不进去」的故障，验证响应是 503 + partial，
 * 而不是 ok:true。
 *
 * 服务用 PORT=0 起在系统分配的空闲端口上（固定端口被占用时，等待就绪会连上
 * 别人的实例，断言就打在真实数据上）。数据目录同样必须已重定向到临时目录，
 * 否则 /memory/clear 这类破坏性断言会清掉真实的记忆库。
 *
 * 运行：node tests/memory-api-recall.test.js（也在 npm test 范围内）
 */
const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');

const TMP_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'bluebird-mem-api-'));
process.env.BLUEBIRD_DATA_DIR = TMP_DATA_DIR;
process.env.PORT = '0';
process.env.BLUEBIRD_API_TOKEN = 'test-token-mem-api';
// 空串而非 delete：dotenv 只回填"不存在"的变量，delete 会让 .env 里的真 key 生效。
process.env.DEEPSEEK_API_KEY = '';

const MEMORY_FILE = path.join(TMP_DATA_DIR, 'memory.json');
const SESSION_A = 's-api-a';
const SESSION_B = 's-api-b';

const MINUTE = 60 * 1000;
const BASE_TIME = Math.floor(Date.now() / MINUTE) * MINUTE;

function iso(minutesAgo) {
  return new Date(BASE_TIME - minutesAgo * MINUTE).toISOString();
}

const origLog = console.log;
const origErr = console.error;
console.log = () => {};
console.error = () => {};

let passed = 0;
let failed = 0;
const failures = [];

function check(name, cond, extra = '') {
  if (cond) {
    passed += 1;
    origLog(`  ✔ ${name}`);
  } else {
    failed += 1;
    failures.push(name + (extra ? ` — ${extra}` : ''));
    origLog(`  ✖ ${name}${extra ? ` — ${extra}` : ''}`);
  }
}

let BASE = '';
const TOKEN = 'test-token-mem-api';

async function req(urlPath, { method = 'GET', token = TOKEN, body } = {}) {
  const res = await fetch(BASE + urlPath, {
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

/** 守卫 1：数据目录必须已离开真实 server/data，否则拒绝跑破坏性断言 */
function isolationError() {
  const real = path.join(__dirname, '..', 'server', 'data');

  let realPath;
  try {
    realPath = fs.realpathSync(real);
  } catch (_) {
    return null; // 真实目录不存在，无从污染
  }

  const envDir = process.env.BLUEBIRD_DATA_DIR;
  if (!envDir) return 'BLUEBIRD_DATA_DIR 未设置';

  let active;
  try {
    active = fs.realpathSync(envDir);
  } catch (_) {
    return `生效的数据目录不存在：${envDir}`;
  }

  if (active === realPath || active.startsWith(realPath + path.sep)) {
    return `生效数据目录 ${active} 落在真实数据目录 ${realPath} 内`;
  }

  return null;
}

/** 跑之前给真实数据目录拍快照，跑完比对，兜住任何意外写入 */
function snapshotRealData() {
  const snap = {};
  const real = path.join(__dirname, '..', 'server', 'data');

  try {
    for (const name of fs.readdirSync(real)) {
      const file = path.join(real, name);
      if (!fs.statSync(file).isFile()) continue;
      snap[name] = crypto
        .createHash('md5')
        .update(fs.readFileSync(file))
        .digest('hex');
    }
  } catch (_) {
    /* 目录不存在 */
  }

  return snap;
}

function diffSnapshot(before, after) {
  const changed = [];
  const names = new Set([...Object.keys(before), ...Object.keys(after)]);

  for (const name of names) {
    if (before[name] !== after[name]) {
      changed.push(before[name] ? `${name}(内容变化)` : `${name}(新增)`);
    }
  }

  return changed;
}

function seedMemory(items) {
  fs.writeFileSync(MEMORY_FILE, JSON.stringify(items, null, 2), 'utf8');
}

function diskMemory() {
  return JSON.parse(fs.readFileSync(MEMORY_FILE, 'utf8'));
}

function contributionSessions(item) {
  return (item.contributions || []).map(entry => entry.sessionId);
}

async function waitReady() {
  for (let attempt = 0; attempt < 100; attempt += 1) {
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

(async () => {
  const isoErr = isolationError();

  if (isoErr) {
    origLog(`✖ 数据隔离守卫失败：${isoErr}`);
    origLog('  已中止，未执行任何记忆接口断言。');
    process.exit(1);
  }

  const snapshotBefore = snapshotRealData();

  // 服务 require 之前先把记忆库写好：loadMemories() 在模块加载时执行一次。
  seedMemory([
    {
      content: '用户喝咖啡只喝美式',
      type: 'preference',
      keywords: ['咖啡', '美式'],
      confidence: 0.95,
      contributions: [
        { sessionId: SESSION_A, sourceQuote: '我喝咖啡只喝美式', createdAt: iso(40) },
      ],
      createdAt: iso(40),
      updatedAt: iso(40),
    },
    {
      content: '用户喝咖啡只喝拿铁',
      type: 'preference',
      keywords: ['咖啡', '拿铁'],
      confidence: 0.95,
      contributions: [
        { sessionId: SESSION_B, sourceQuote: '我喝咖啡只喝拿铁', createdAt: iso(30) },
      ],
      createdAt: iso(30),
      updatedAt: iso(30),
    },
    {
      content: '用户住在杭州',
      type: 'fact',
      keywords: ['城市', '杭州'],
      confidence: 0.9,
      sourceQuote: '我住在杭州',
      createdAt: iso(20),
      updatedAt: iso(20),
    },
  ]);

  const { server } = require(path.join(__dirname, '..', 'server', 'index.js'));

  if (!server.listening) {
    await new Promise(resolve => server.once('listening', resolve));
  }

  BASE = `http://127.0.0.1:${server.address().port}`;

  if (!(await waitReady())) {
    origLog('服务未能在 5 秒内启动');
    process.exit(1);
  }

  const memory = require(path.join(__dirname, '..', 'server', 'memory.js'));
  const sessions = require(path.join(__dirname, '..', 'server', 'sessions.js'));

  origLog('\n鉴权与参数校验');
  {
    const noToken = await req('/memory/clear-session', {
      method: 'POST',
      token: null,
      body: { sessionId: SESSION_A },
    });
    check('POST /memory/clear-session 无 token 返回 401', noToken.status === 401, `实际 ${noToken.status}`);

    const missing = await req('/memory/clear-session', { method: 'POST', body: {} });
    check('缺 sessionId 返回 400（空 sessionId 不允许等于全库清空）', missing.status === 400, `实际 ${missing.status}`);

    const blank = await req('/memory/clear-session', { method: 'POST', body: { sessionId: '   ' } });
    check('空白 sessionId 返回 400', blank.status === 400, `实际 ${blank.status}`);

    const noBody = await req('/memory/delete', { method: 'POST', body: {} });
    check('POST /memory/delete 两种定位键都不给 → 400', noBody.status === 400, `实际 ${noBody.status}`);

    const attemptsNoToken = await req('/memory/write-attempts', { token: null });
    check('GET /memory/write-attempts 无 token 返回 401', attemptsNoToken.status === 401);
  }

  origLog('\nGET /memory：返回稳定身份与时效字段');
  {
    const list = await req('/memory');
    const items = list.json.memories || [];

    check('GET /memory 返回 3 条', items.length === 3, `实际 ${items.length}`);
    check(
      '每条都带 id / status / validFrom',
      items.every(item => item.id && item.status === 'active' && item.validFrom),
      JSON.stringify(items.map(item => [item.id, item.status, item.validFrom]))
    );
    check(
      '旧平铺字段 sourceQuote 仍保留（老客户端不用改）',
      items.some(item => item.sourceQuote === '我住在杭州')
    );
  }

  origLog('\nPOST /memory/delete：优先按 id，旧定位键不废');
  {
    const items = (await req('/memory')).json.memories;
    const target = items.find(item => item.content === '用户喝咖啡只喝美式');

    const byId = await req('/memory/delete', { method: 'POST', body: { id: target.id } });
    check(
      '按 id 删除返回 ok + removed + id',
      byId.status === 200 && byId.json.ok === true && byId.json.removed === 1 && byId.json.id === target.id,
      JSON.stringify(byId.json)
    );
    check(
      '返回体 / 内存视图 / 磁盘三方一致',
      (await req('/memory')).json.memories.length === 2 &&
        diskMemory().length === 2 &&
        !diskMemory().some(item => item.id === target.id)
    );

    const legacyTarget = (await req('/memory')).json.memories.find(
      item => item.content === '用户住在杭州'
    );
    const byLegacy = await req('/memory/delete', {
      method: 'POST',
      body: { createdAt: legacyTarget.createdAt, content: legacyTarget.content },
    });
    check(
      '按旧的 createdAt + content 删除仍然生效（兼容老客户端）',
      byLegacy.status === 200 && byLegacy.json.removed === 1 && byLegacy.json.id === legacyTarget.id,
      JSON.stringify(byLegacy.json)
    );

    const notFound = await req('/memory/delete', { method: 'POST', body: { id: 'mem-不存在' } });
    check('按不存在的 id 删除返回 404，不是 200', notFound.status === 404, `实际 ${notFound.status}`);
  }

  origLog('\nPOST /history/recall：撤回的记忆侧结果必须可验证');
  {
    // 直接经会话模块写入历史，避免把断言绑在模型调用上（本进程 DEEPSEEK_API_KEY 为空）。
    const session = sessions.createSession({ title: '撤回对账' });
    const sessionId = session.id;
    const message = {
      id: 'm-coffee-1',
      role: 'user',
      content: '我喝咖啡只喝拿铁',
      createdAt: iso(30),
    };

    sessions.appendMessages(sessionId, [message]);

    seedMemory([
      {
        content: '用户喝咖啡只喝拿铁',
        type: 'preference',
        keywords: ['咖啡', '拿铁'],
        confidence: 0.95,
        contributions: [
          { sessionId, sourceQuote: '我喝咖啡只喝拿铁', createdAt: iso(30) },
        ],
        createdAt: iso(30),
        updatedAt: iso(30),
      },
      {
        content: '用户喝咖啡只喝美式',
        type: 'preference',
        keywords: ['咖啡', '美式'],
        confidence: 0.95,
        contributions: [
          { sessionId: SESSION_A, sourceQuote: '我喝咖啡只喝美式', createdAt: iso(40) },
        ],
        createdAt: iso(40),
        updatedAt: iso(40),
      },
    ]);
    memory.loadMemories();

    const recalled = await req('/history/recall', {
      method: 'POST',
      body: { messageId: message.id, sessionId },
    });

    check('撤回接口返回 200', recalled.status === 200, `实际 ${recalled.status}`);
    check(
      '响应里带记忆侧的两个计数（摘掉的贡献数 + 删除条目数）',
      recalled.json.memory &&
        recalled.json.memory.removedContributions === 1 &&
        recalled.json.memory.removedEntries === 1,
      JSON.stringify(recalled.json.memory)
    );
    check(
      '响应里带落盘自检结论（consistent=true），不是只看 HTTP 状态码',
      recalled.json.memory && recalled.json.memory.consistent === true,
      JSON.stringify(recalled.json.memory)
    );
    check(
      '消息确实从聊天里消失（返回的 removedIds 与真实存储一致）',
      !sessions.getMessages(sessionId).some(item => item.id === message.id) &&
        JSON.stringify(recalled.json.removedIds) === JSON.stringify([message.id])
    );
    check(
      '记忆确实从磁盘消失，且别的会话的记忆没被连带删除',
      !diskMemory().some(item => item.content === '用户喝咖啡只喝拿铁') &&
        diskMemory().some(item => item.content === '用户喝咖啡只喝美式')
    );
    check(
      '返回条数 = 内存视图条数 = 磁盘条数',
      (await req('/memory')).json.memories.length === diskMemory().length &&
        diskMemory().length === 1,
      `内存=${(await req('/memory')).json.memories.length} 磁盘=${diskMemory().length}`
    );
  }

  origLog('\n撤回遇到磁盘写不进去：响应必须是 503 + partial，不能报成功');
  {
    const session = sessions.createSession({ title: '半完成' });
    const sessionId = session.id;
    const message = {
      id: 'm-half-1',
      role: 'user',
      content: '我的车牌是京A12345',
      createdAt: iso(10),
    };

    sessions.appendMessages(sessionId, [message]);

    seedMemory([
      {
        content: '用户车牌是京A12345',
        type: 'fact',
        keywords: ['车牌'],
        confidence: 0.95,
        contributions: [
          { sessionId, sourceQuote: '我的车牌是京A12345', createdAt: iso(10) },
        ],
        createdAt: iso(10),
        updatedAt: iso(10),
      },
    ]);
    memory.loadMemories();

    // 把记忆文件换成同名目录：原子写的 rename 必然失败 → 落盘异常。
    fs.rmSync(MEMORY_FILE, { force: true });
    fs.mkdirSync(MEMORY_FILE, { recursive: true });

    const partial = await req('/history/recall', {
      method: 'POST',
      body: { messageId: message.id, sessionId },
    });

    check(
      '记忆落盘失败时返回 503，而不是 ok:true',
      partial.status === 503,
      `实际 ${partial.status} / ${JSON.stringify(partial.json)}`
    );
    check(
      '响应如实标出半完成状态（消息已撤、记忆未撤）',
      partial.json &&
        partial.json.partial === true &&
        partial.json.messagesRecalled === true &&
        partial.json.memory &&
        partial.json.memory.status === 'failed',
      JSON.stringify(partial.json)
    );
    check(
      '仍回传 removedIds，让客户端能收敛本地列表',
      Array.isArray(partial.json.removedIds) &&
        partial.json.removedIds.includes(message.id)
    );
    check(
      '内存数组未被"假成功"污染：写失败后内存与磁盘仍是同一份旧库',
      memory.getMemories().length === 1 &&
        memory.getMemories()[0].content === '用户车牌是京A12345'
    );

    // 恢复可写：同名目录换回文件，重试应真正落盘
    fs.rmSync(MEMORY_FILE, { recursive: true, force: true });
    seedMemory([
      {
        content: '用户车牌是京A12345',
        type: 'fact',
        keywords: ['车牌'],
        confidence: 0.95,
        contributions: [
          { sessionId, sourceQuote: '我的车牌是京A12345', createdAt: iso(10) },
        ],
        createdAt: iso(10),
        updatedAt: iso(10),
      },
    ]);
    memory.loadMemories();

    const retry = await req('/history/clear', {
      method: 'POST',
      body: { sessionId },
    });
    check('聊天记录清掉后接口仍正常（不受上一次失败影响）', retry.status === 200, `实际 ${retry.status}`);

    const retryRecall = await req('/memory/delete', {
      method: 'POST',
      body: { id: memory.getMemories()[0].id },
    });
    check(
      '库恢复可写后，删除立刻成功并落盘（前一次的失败没留下半写状态）',
      retryRecall.status === 200 && diskMemory().length === 0
    );
  }

  origLog('\nPOST /memory/clear-session：按会话清理，不误伤他人');
  {
    seedMemory([
      {
        content: '用户喝咖啡只喝美式',
        type: 'preference',
        keywords: ['咖啡', '美式'],
        confidence: 0.95,
        contributions: [{ sessionId: SESSION_A, sourceQuote: '我喝咖啡只喝美式', createdAt: iso(40) }],
        createdAt: iso(40),
        updatedAt: iso(40),
      },
      {
        content: '用户常用编辑器是 Vim',
        type: 'preference',
        keywords: ['编辑器', 'Vim'],
        confidence: 0.95,
        contributions: [{ sessionId: SESSION_A, sourceQuote: '我用 Vim 写代码', createdAt: iso(35) }],
        createdAt: iso(35),
        updatedAt: iso(35),
      },
      {
        content: '用户喝咖啡只喝拿铁',
        type: 'preference',
        keywords: ['咖啡', '拿铁'],
        confidence: 0.95,
        contributions: [
          { sessionId: SESSION_A, sourceQuote: '我喝咖啡只喝拿铁', createdAt: iso(30) },
          { sessionId: SESSION_B, sourceQuote: '咖啡我只喝拿铁', createdAt: iso(25) },
        ],
        createdAt: iso(30),
        updatedAt: iso(30),
      },
      {
        content: '用户住在杭州',
        type: 'fact',
        keywords: ['城市', '杭州'],
        confidence: 0.9,
        sourceQuote: '我住在杭州',
        createdAt: iso(20),
        updatedAt: iso(20),
      },
    ]);
    memory.loadMemories();

    const noop = await req('/memory/clear-session', {
      method: 'POST',
      body: { sessionId: 's-从没说过话' },
    });
    check(
      '没有匹配贡献 → 200 + 全 0 计数 + 明确说明',
      noop.status === 200 &&
        noop.json.removedEntries === 0 &&
        noop.json.removedContributions === 0 &&
        typeof noop.json.message === 'string',
      JSON.stringify(noop.json)
    );

    const cleared = await req('/memory/clear-session', {
      method: 'POST',
      body: { sessionId: SESSION_A },
    });

    check(
      '返回两个计数：删除条目数 + 摘掉的贡献数',
      cleared.status === 200 &&
        cleared.json.ok === true &&
        cleared.json.removedEntries === 2 &&
        cleared.json.removedContributions === 3,
      JSON.stringify(cleared.json)
    );
    check(
      'remaining 与内存视图、磁盘三者一致',
      cleared.json.remaining === memory.getMemories({ includeSuperseded: true }).length &&
        cleared.json.remaining === diskMemory().length &&
        cleared.json.remaining === 2,
      `响应=${cleared.json.remaining} 内存=${memory.getMemories({ includeSuperseded: true }).length} 磁盘=${diskMemory().length}`
    );
    check(
      '库里不再有 A 名下的任何贡献',
      diskMemory().every(item => !contributionSessions(item).includes(SESSION_A)),
      JSON.stringify(diskMemory().map(item => contributionSessions(item)))
    );
    check(
      'B 的共享事实仍在，且仍只挂在 B 名下',
      diskMemory().some(
        item =>
          item.content === '用户喝咖啡只喝拿铁' &&
          JSON.stringify(contributionSessions(item)) === JSON.stringify([SESSION_B])
      )
    );
    check(
      '清理结果对读路径立刻生效：B 仍看不到 A 的任何记忆',
      !memory.buildMemoryContext('我喝咖啡选什么', SESSION_B).includes('美式')
    );
  }

  origLog('\nGET /memory/write-attempts：拒写原因可观测且不含正文');
  {
    memory.clearMemories();

    const rejected = await memory.processMemory(
      {
        chat: {
          completions: {
            create: async () => ({
              choices: [
                {
                  message: {
                    content: JSON.stringify({
                      content: '用户最爱吃芒果',
                      type: 'preference',
                      keywords: ['芒果'],
                      confidence: 0.4,
                      sourceQuote: '我最爱吃芒果',
                    }),
                  },
                },
              ],
            }),
          },
        },
      },
      '记住，我最爱吃芒果',
      SESSION_A
    );

    check('置信度不足被拒，短码回传给调用方', rejected.written === false && rejected.reason === 'low_confidence', JSON.stringify(rejected));

    const attempts = await req('/memory/write-attempts');

    check('接口返回 attempts 数组', attempts.status === 200 && Array.isArray(attempts.json.attempts), JSON.stringify(attempts.json));

    const latest = attempts.json.attempts[0] || {};
    check(
      '最近一次记录含会话 id、动作与拒写短码',
      latest.sessionId === SESSION_A &&
        latest.written === false &&
        latest.reason === 'low_confidence' &&
        latest.action === 'none',
      JSON.stringify(latest)
    );
    check(
      '记录里没有任何记忆正文或用户原话（否则会变成第二份用户数据）',
      !JSON.stringify(attempts.json.attempts).includes('芒果')
    );
    check(
      '普通闲聊（未触发提取）不进记录，不会冲掉真正的拒写线索',
      attempts.json.attempts.every(item => item.reason !== 'not_triggered')
    );
  }

  origLog('\n服务侧注入路径带上 sessionId（P0 泄漏口子）');
  {
    seedMemory([
      {
        content: '用户喝咖啡只喝美式',
        type: 'preference',
        keywords: ['咖啡', '美式'],
        confidence: 0.95,
        contributions: [{ sessionId: SESSION_A, sourceQuote: '我喝咖啡只喝美式', createdAt: iso(40) }],
        createdAt: iso(40),
        updatedAt: iso(40),
      },
    ]);
    memory.loadMemories();

    const noSession = memory.buildMemoryContext('我喝咖啡选什么');
    const withSession = memory.buildMemoryContext('我喝咖啡选什么', SESSION_A);
    const foreign = memory.buildMemoryContext('我喝咖啡选什么', SESSION_B);

    check('不传 sessionId 时不再注入具名会话的记忆', !noSession.includes('美式'), noSession);
    check('本会话注入自己的记忆', withSession.includes('用户喝咖啡只喝美式'));
    check('别的会话注入不到', !foreign.includes('美式'), foreign);
  }

  const snapshotAfter = snapshotRealData();
  const touched = diffSnapshot(snapshotBefore, snapshotAfter);

  origLog('\n收尾');
  check('真实 server/data 未被本次测试改动', touched.length === 0, `变化：${JSON.stringify(touched)}`);

  try {
    fs.rmSync(TMP_DATA_DIR, { recursive: true, force: true });
  } catch (_) {
    /* Windows 上占用中的目录可能删不掉，不影响结论 */
  }

  server.close();

  console.log = origLog;
  console.error = origErr;

  origLog(`\n通过 ${passed} 项，失败 ${failed} 项`);
  if (failed) {
    origLog(`失败明细：\n  ${failures.join('\n  ')}`);
    process.exit(1);
  }
  process.exit(0);
})().catch(error => {
  console.log = origLog;
  console.error = origErr;
  origLog('测试脚本异常：', error && error.stack ? error.stack : error);
  process.exit(1);
});
