/**
 * 云岫 Bluebird — 记忆接口归属校验（多用户上线前的 P0 阻断项）
 *
 * 背景：`GET /memory` 与全部记忆管理接口过去是「全库」语义。单用户部署下
 * 全库 == 本人，看不出问题；一旦接入真实多用户，任意已认证用户就能读写
 * 他人的记忆。本测试用「种一条属于别的 userId 的记忆」来证明：
 *   - 读接口不会把别人的记忆列出来；
 *   - 写接口对别人的 id 返回 403 且数据不变；
 *   - 清空只清本人的，不碰别人的。
 *
 * 不需要多用户认证：`resolveUserId(req)` 在单实例下恒为 local-owner，
 * 只要种一条 userId=其他值的条目，就能构造出「他人记忆」。
 *
 * 运行：node tests/memory-ownership.test.js
 */
const fs = require('fs');
const os = require('os');
const path = require('path');

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'bluebird-mem-own-'));
const DATA_DIR = path.join(TMP, 'data');
fs.mkdirSync(DATA_DIR, { recursive: true });

process.env.BLUEBIRD_DATA_DIR = DATA_DIR;
process.env.BLUEBIRD_API_TOKEN = 'test-token-mem-own';
process.env.DEEPSEEK_API_KEY = '';
process.env.PORT = '0';
process.env.BLUEBIRD_AGENT_TOOLS = '';
process.env.BLUEBIRD_MONITORING = '0';
process.env.BLUEBIRD_PROVIDER_KIND = 'stub';

const MEMORY_FILE = path.join(DATA_DIR, 'memory.json');
const OTHER_USER = 'user-other-ownership';
const SESSION_OTHER = 'sess_other_only';
const SESSION_MINE = 'sess_mine';

function iso(minutesAgo) {
  return new Date(Date.now() - minutesAgo * 60 * 1000).toISOString();
}

function entry({ content, keywords, sessionId, userId = null, status = 'active' }) {
  return {
    content,
    type: 'preference',
    keywords,
    confidence: 0.9,
    status,
    sourceQuote: content,
    ...(sessionId ? { sessionId } : {}),
    ...(userId ? { userId } : {}),
    validFrom: iso(60),
    validTo: null,
    createdAt: iso(60),
    updatedAt: iso(60),
  };
}

function seed() {
  const items = [
    // 本人（不写 userId → 读盘时补成实例用户）
    entry({
      content: '用户喝咖啡只喝美式',
      keywords: ['咖啡', '美式'],
      sessionId: SESSION_MINE,
    }),
    // 他人：active
    entry({
      content: '他人记忆：只喝手冲',
      keywords: ['咖啡', '手冲'],
      sessionId: SESSION_OTHER,
      userId: OTHER_USER,
    }),
    // 本人：pending
    entry({
      content: '用户可能想学拉花',
      keywords: ['拉花'],
      sessionId: SESSION_MINE,
      status: 'pending',
    }),
    // 他人：pending
    entry({
      content: '他人记忆：可能想开咖啡店',
      keywords: ['开店'],
      sessionId: SESSION_OTHER,
      userId: OTHER_USER,
      status: 'pending',
    }),
  ];

  fs.writeFileSync(MEMORY_FILE, JSON.stringify(items, null, 2), 'utf8');
}

const origLog = console.log;
const origErr = console.error;

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

function diskMemory() {
  return JSON.parse(fs.readFileSync(MEMORY_FILE, 'utf8'));
}

// 归一化视图：id / status / userId 由读盘时的 stampIdentity 补齐，
// 磁盘上的原始 JSON 没有 id，不能用来定位。
function normalized() {
  return memoryModule().getMemories({
    includeSuperseded: true,
    includeArchived: true,
    includePending: true,
  });
}

function memoryModule() {
  return require(path.join(__dirname, '..', 'server', 'memory.js'));
}

let BASE = '';
const TOKEN = 'test-token-mem-own';

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

async function main() {
  seed();

  // 屏蔽服务端常规日志，只留本测试输出
  console.log = () => {};
  console.error = () => {};

  const { server } = require(path.join(__dirname, '..', 'server', 'index.js'));

  if (!server.listening) {
    await new Promise(resolve => server.once('listening', resolve));
  }

  BASE = `http://127.0.0.1:${server.address().port}`;

  if (!(await waitReady())) {
    origErr('服务未能在 5 秒内启动');
    process.exit(1);
  }

  const memory = require(path.join(__dirname, '..', 'server', 'memory.js'));
  const memoryService = require(path.join(__dirname, '..', 'server', 'memory-service.js'));
  const { getInstanceUserId } = require(path.join(__dirname, '..', 'server', 'user-scope.js'));

  const INSTANCE = getInstanceUserId();

  origLog('\nA) 读接口：只返回本人记忆');

  {
    const list = await req('/memory');
    const items = (list.json && list.json.memories) || [];

    check(
      'GET /memory 只返回本人的 active 记忆',
      list.status === 200 &&
        items.length === 1 &&
        items[0].content === '用户喝咖啡只喝美式',
      JSON.stringify(items.map(item => item.content))
    );
    check(
      'GET /memory 不包含他人记忆',
      !items.some(item => item.content.includes('他人记忆'))
    );
  }

  {
    const all = await req('/memory?scope=all');
    const items = (all.json && all.json.memories) || [];

    check(
      'GET /memory?scope=all 仍只返回本人（active + pending）',
      all.status === 200 &&
        items.length === 2 &&
        !items.some(item => item.content.includes('他人记忆')),
      JSON.stringify(items.map(item => [item.content, item.status]))
    );
  }

  {
    const pending = await req('/memory/pending');
    const items = (pending.json && pending.json.memories) || [];

    check(
      'GET /memory/pending 只返回本人的待确认',
      pending.status === 200 &&
        items.length === 1 &&
        items[0].content === '用户可能想学拉花',
      JSON.stringify(items.map(item => item.content))
    );
  }

  origLog('\nB) 写接口：他人的 id 一律 403 且数据不变');

  const foreignActive = normalized().find(
    item => item.content === '他人记忆：只喝手冲'
  );
  const foreignPending = normalized().find(
    item => item.content === '他人记忆：可能想开咖啡店'
  );
  const ownActive = normalized().find(
    item => item.content === '用户喝咖啡只喝美式'
  );

  {
    const before = diskMemory().length;
    const res = await req('/memory/delete', {
      method: 'POST',
      body: { id: foreignActive.id },
    });

    check(
      'POST /memory/delete 他人记忆 → 403',
      res.status === 403 && res.json && res.json.reason === 'forbidden',
      JSON.stringify(res.json)
    );
    check('删除被拒后磁盘条目数不变', diskMemory().length === before);
  }

  {
    const res = await req('/memory/archive', {
      method: 'POST',
      body: { id: foreignActive.id },
    });

    check(
      'POST /memory/archive 他人记忆 → 403',
      res.status === 403,
      JSON.stringify(res.json)
    );
    check(
      '归档被拒后该条仍是 active',
      normalized().find(item => item.id === foreignActive.id).status === 'active'
    );
  }

  {
    const res = await req('/memory/confirm', {
      method: 'POST',
      body: { id: foreignPending.id },
    });

    check(
      'POST /memory/confirm 他人 pending → 403',
      res.status === 403,
      JSON.stringify(res.json)
    );
    check(
      '确认被拒后该条仍是 pending',
      normalized().find(item => item.id === foreignPending.id).status === 'pending'
    );
  }

  {
    const res = await req('/memory/reject', {
      method: 'POST',
      body: { id: foreignPending.id },
    });

    check(
      'POST /memory/reject 他人 pending → 403',
      res.status === 403,
      JSON.stringify(res.json)
    );
  }

  origLog('\nC) 清空类接口：不越界删他人数据');

  {
    const before = diskMemory().length;
    // 该 session 只被"他人"条目使用：清它不应删掉他人记忆
    const res = await req('/memory/clear-session', {
      method: 'POST',
      body: { sessionId: SESSION_OTHER, confirm: true },
    });

    check(
      'POST /memory/clear-session 他人会话 → 不删除他人记忆',
      res.status === 200 && diskMemory().length === before,
      JSON.stringify({ status: res.status, before, after: diskMemory().length })
    );
    check(
      '他人记忆仍在库里',
      normalized().some(item => item.id === foreignActive.id)
    );
  }

  {
    const res = await req('/memory/clear', {
      method: 'POST',
      body: { confirm: true },
    });

    const left = diskMemory();

    check(
      'POST /memory/clear 只清本人，返回删除条数',
      res.status === 200 && res.json.ok === true && res.json.removedEntries === 2,
      JSON.stringify(res.json)
    );
    check(
      '清空后他人记忆完好保留',
      left.length === 2 && left.every(item => item.userId === OTHER_USER),
      JSON.stringify(left.map(item => item.content))
    );
    check(
      '清空后本人记忆一条不剩',
      !left.some(item => item.content === '用户喝咖啡只喝美式')
    );
  }

  origLog('\nD) 模块级契约（供非 HTTP 调用方使用）');

  {
    memory.loadMemories();

    check(
      'getMemoriesForUser(空身份) 返回空数组（fail-closed）',
      memory.getMemoriesForUser(null).length === 0 &&
        memory.getMemoriesForUser('').length === 0
    );
    check(
      'getMemoriesForUser(本人) 不再包含他人记忆',
      memory.getMemoriesForUser(INSTANCE).length === 0
    );
    check(
      'getPendingMemoriesForUser(空身份) 返回空数组',
      memory.getPendingMemoriesForUser(null).length === 0
    );
    check(
      'checkMemoryOwnership 他人条目 → forbidden',
      memory.checkMemoryOwnership(foreignActive.id, INSTANCE).reason === 'forbidden'
    );
    check(
      'checkMemoryOwnership 不存在的 id → not-found',
      memory.checkMemoryOwnership('mem_does_not_exist', INSTANCE).reason === 'not-found'
    );
    check(
      'checkMemoryOwnership 本人条目 → ok',
      (() => {
        const mine = memory.getMemoriesForUser(OTHER_USER)[0];
        return mine && memory.checkMemoryOwnership(mine.id, OTHER_USER).ok === true;
      })()
    );
  }

  {
    // 审批执行器（Memory Bot 维护）同样不能越界
    const result = await memoryService.execute(
      'delete',
      { id: foreignActive.id },
      { userId: INSTANCE }
    );

    check(
      'memoryService.execute 他人 id → 拒绝且原因明确',
      result && result.ok === false && result.reason === 'forbidden',
      JSON.stringify(result)
    );
    check(
      '审批执行被拒后他人记忆仍在',
      normalized().some(item => item.id === foreignActive.id)
    );

    // merge 会把 sourceIds 吞并进目标条目：源也必须属于本人，
    // 否则可以借"合并我的记忆"消费掉别人的条目。
    const ownSeed = diskMemory();
    ownSeed.push(
      entry({
        content: '用户本人的合并目标记忆',
        keywords: ['合并'],
        sessionId: SESSION_MINE,
      })
    );
    fs.writeFileSync(MEMORY_FILE, JSON.stringify(ownSeed, null, 2), 'utf8');
    memory.loadMemories();
    const ownTarget = normalized().find(
      item => item.content === '用户本人的合并目标记忆'
    );

    const mergeResult = await memoryService.execute(
      'merge',
      {
        targetId: ownTarget.id,
        sourceIds: [foreignActive.id],
        content: '合并后的本人记忆',
      },
      { userId: INSTANCE }
    );

    check(
      'memoryService.execute merge 的 sourceIds 含他人条目 → 整体拒绝',
      mergeResult && mergeResult.ok === false && mergeResult.reason === 'forbidden',
      JSON.stringify(mergeResult)
    );
    check(
      'merge 被拒后他人记忆未被吞并',
      normalized().some(item => item.id === foreignActive.id)
    );
  }

  origLog('\nE) 本人操作仍然正常（没有把功能锁死）');

  {
    // 重新种一条"本人"的记忆，验证归属校验没有误伤正常操作
    const current = diskMemory();
    current.push(
      entry({
        content: '用户新写入的本人记忆',
        keywords: ['本人'],
        sessionId: SESSION_MINE,
      })
    );
    fs.writeFileSync(MEMORY_FILE, JSON.stringify(current, null, 2), 'utf8');
    memory.loadMemories();

    const own = normalized().find(item => item.content === '用户新写入的本人记忆');
    const res = await req('/memory/delete', {
      method: 'POST',
      body: { id: own.id },
    });

    check(
      '本人删除自己的记忆 → 200 且真的删掉',
      res.status === 200 &&
        !normalized().some(item => item.id === own.id),
      JSON.stringify(res.json)
    );
    check(
      'clear 已清掉原有本人记忆',
      !normalized().some(item => item.id === ownActive.id)
    );
    check(
      '他人记忆始终未被误删',
      normalized().some(item => item.id === foreignActive.id)
    );
  }

  origLog(`\n通过 ${passed} 项，失败 ${failed} 项`);

  if (failures.length) {
    origLog('失败明细：');
    for (const item of failures) origLog(`  - ${item}`);
  }

  // 收尾：先断开 keep-alive 连接再等事件循环排空。强退（process.exit）会在
  // Windows 上触发 libuv 断言（src/win/async.c），断言全绿也以非零码退出。
  if (typeof server.closeAllConnections === 'function') {
    server.closeAllConnections();
  }
  await new Promise(resolve => server.close(resolve));

  try {
    fs.rmSync(TMP, { recursive: true, force: true });
  } catch (_) {
    /* ignore */
  }

  process.exitCode = failed ? 1 : 0;
}

main().catch(error => {
  origErr('归属校验测试异常：', error && error.message ? error.message : error);
  try {
    fs.rmSync(TMP, { recursive: true, force: true });
  } catch (_) {
    /* ignore */
  }
  process.exitCode = 1;
});
