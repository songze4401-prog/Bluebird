/**
 * 云岫 Bluebird — 真进程重启下的记忆身份（P3）
 *
 * 前面的单测都在同一个进程里反复 loadMemories()，那只能证明「函数是幂等的」，
 * 证不了「重启后还是同一库」。本文件每次都 spawn 一个独立的 node 进程，
 * 让它们共用同一个 BLUEBIRD_DATA_DIR，只靠磁盘文件接力，验四件事：
 *
 *   1. 旧数据（无 id / 无 status）第一次被哪个进程读，补齐的 id 都一样，
 *      重启 N 次条目数不涨、id 集合不变（确定性迁移 + 不生成重复条目）；
 *   2. A 进程里看到的 id，B 进程里照样解得开：删除按 id 走，
 *      更正回的 supersededId 就是 A 进程那个 id；
 *   3. 更正与删除的结果跨进程仍然生效：旧事实不会在重启后复活成活跃条目，
 *      磁盘上的 superseded 留档也不会被读盘迁移改回 active；
 *   4. 归属跨进程不丢：平铺 sessionId 升级成 contributions 后，
 *      重启后依然只有原会话读得到，别的会话读不到。
 *
 * 隔离：全程临时目录 + DEEPSEEK_API_KEY=''（假 client），绝不读写 server/data。
 * 运行：node tests/memory-restart.test.js（也在 npm test 自动发现范围内）
 */
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

const REPO_ROOT = path.join(__dirname, '..');
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'bluebird-mem-restart-'));
const MEMORY_FILE = path.join(TMP, 'memory.json');
const RUNNER = path.join(TMP, 'stage-runner.js');

const SESSION_A = 's-restart-a';
const SESSION_B = 's-restart-b';
// 库里一条属于它的记忆都没有：只有这种会话才按设计回落到「无归属旧数据」
const SESSION_FRESH = 's-restart-brand-new';

// 冻结时间：派生 id 取自 createdAt，用相对时间会让「重启后 id 相同」这条断言
// 自己造出差异，测不到它想测的东西。
const SEED_ITEMS = [
  {
    content: '用户的生日是3月14日',
    type: 'fact',
    keywords: ['生日'],
    confidence: 0.95,
    sourceQuote: '我的生日是3月14日',
    sessionId: SESSION_A,
    createdAt: '2026-10-20T01:00:00.000Z',
  },
  {
    content: '用户在开发云岫 Bluebird 这款 AI 聊天应用',
    type: 'goal',
    keywords: ['Bluebird', '项目', '云岫'],
    confidence: 0.9,
    sourceQuote: '我在做Bluebird这个项目',
    sessionId: SESSION_A,
    createdAt: '2026-10-20T02:00:00.000Z',
  },
  {
    content: '用户的车牌号是沪A12345',
    type: 'fact',
    keywords: ['车牌', '车牌号'],
    confidence: 0.95,
    sourceQuote: '我的车牌是沪A12345',
    sessionId: SESSION_B,
    createdAt: '2026-10-20T03:00:00.000Z',
  },
  {
    // 迁移前就有、且从来没写过归属的旧记忆
    content: '用户住在杭州',
    type: 'fact',
    keywords: ['城市', '杭州', '住'],
    confidence: 0.9,
    sourceQuote: '我住在杭州',
    createdAt: '2026-10-20T04:00:00.000Z',
  },
];


/**
 * 子进程里跑的真实代码：只依赖生产模块，父进程通过环境变量下发动作。
 * 输出用 RESULT: 前缀单独成行，避开 memory.js 自身的流水日志。
 */
const RUNNER_SOURCE = `
'use strict';
const fs = require('fs');
const path = require('path');
const memory = require(path.join(process.env.REPO_ROOT, 'server', 'memory.js'));

const MEMORY_FILE = path.join(process.env.BLUEBIRD_DATA_DIR, 'memory.json');
const args = JSON.parse(process.env.STAGE_ARGS || '{}');

// 三个问题各自只能被一条归属明确的记忆答上：
// 用「能命中的问题」测隔离才是真测，用答不上的问题测会得到恒真的断言。
const QUERIES = ['我的生日是哪天', '我的车牌号是多少', '我住在哪个城市'];

function fakeClient(reply) {
  return {
    chat: {
      completions: {
        create: async () => ({
          choices: [{ message: { content: JSON.stringify(reply) } }],
        }),
      },
    },
  };
}

function view() {
  const active = memory.getMemories();

  const searches = { sessionA: {}, sessionB: {}, fresh: {} };
  const injected = { sessionA: {}, sessionB: {}, fresh: {} };

  for (const query of QUERIES) {
    searches.sessionA[query] = memory
      .searchMemories({ query, sessionId: args.sessionA })
      .results.map(item => item.content);
    searches.sessionB[query] = memory
      .searchMemories({ query, sessionId: args.sessionB })
      .results.map(item => item.content);
    // 全新会话：自己一条记忆都没有，按设计才回落到无归属的旧数据
    searches.fresh[query] = memory
      .searchMemories({ query, sessionId: args.sessionFresh })
      .results.map(item => item.content);
    injected.sessionA[query] = memory
      .buildMemoryContext(query, args.sessionA)
      .split('\\n')
      .filter(line => line.startsWith('- '));
    injected.sessionB[query] = memory
      .buildMemoryContext(query, args.sessionB)
      .split('\\n')
      .filter(line => line.startsWith('- '));
    injected.fresh[query] = memory
      .buildMemoryContext(query, args.sessionFresh)
      .split('\\n')
      .filter(line => line.startsWith('- '));
  }

  return {
    pid: process.pid,
    activeCount: active.length,
    active: active.map(item => ({
      id: item.id,
      status: item.status,
      content: item.content,
      type: item.type,
      confidence: item.confidence,
      createdAt: item.createdAt,
      validFrom: item.validFrom,
      validTo: item.validTo,
      supersededBy: item.supersededBy,
      sessions: (item.contributions || []).map(c => c.sessionId || null),
      sourceQuote: item.sourceQuote || null,
    })),
    disk: JSON.parse(fs.readFileSync(MEMORY_FILE, 'utf8')).map(item => ({
      id: item.id,
      status: item.status,
      content: item.content,
      validTo: item.validTo === undefined ? 'ABSENT' : item.validTo,
      supersededBy: item.supersededBy === undefined ? 'ABSENT' : item.supersededBy,
    })),
    consistency: memory.verifyStoreConsistency(),
    searches,
    injected,
  };
}

async function main() {
  memory.loadMemories();

  const stage = process.env.STAGE;
  const result = { stage, before: view() };

  if (stage === 'inspect') {
    result.outcome = null;
  } else if (stage === 'correct') {
    result.outcome = await memory.processMemory(
      fakeClient(args.reply),
      args.userText,
      args.sessionA
    );
  } else if (stage === 'delete') {
    // 只拿别的进程报回来的 id 来定位，绝不在本进程重新派生
    result.outcome = await memory.deleteMemory({ id: args.id });
  } else if (stage === 'deleteLegacyKey') {
    result.outcome = await memory.deleteMemory({
      createdAt: args.createdAt,
      content: args.content,
    });
  } else if (stage === 'recall') {
    result.outcome = await memory.recallMemoryBySourceQuote(
      args.messageText,
      args.messageTime,
      args.sessionA
    );
  } else {
    throw new Error('未知 stage: ' + stage);
  }

  result.after = view();

  process.stdout.write('RESULT:' + JSON.stringify(result) + '\\n');
}

main().catch(error => {
  process.stdout.write('RESULT:' + JSON.stringify({ stage: process.env.STAGE, error: error && error.message }) + '\\n');
  process.exitCode = 1;
});
`;

fs.writeFileSync(RUNNER, RUNNER_SOURCE, 'utf8');

function runStage(stage, extraArgs = {}) {
  const result = spawnSync(process.execPath, [RUNNER], {
    encoding: 'utf8',
    env: {
      ...process.env,
      REPO_ROOT,
      BLUEBIRD_DATA_DIR: TMP,
      DEEPSEEK_API_KEY: '',
      STAGE: stage,
      STAGE_ARGS: JSON.stringify({
        sessionA: SESSION_A,
        sessionB: SESSION_B,
        sessionFresh: SESSION_FRESH,
        ...extraArgs,
      }),
    },
  });

  assert.equal(
    result.status,
    0,
    `子进程（stage=${stage}）异常退出：\n${result.stderr || result.stdout || ''}`
  );

  const line = (result.stdout || '')
    .split('\n')
    .find(item => item.startsWith('RESULT:'));

  assert.ok(line, `子进程（stage=${stage}）没有回报结果：\n${result.stdout || ''}`);

  const payload = JSON.parse(line.slice('RESULT:'.length));

  assert.equal(
    payload.error,
    undefined,
    `子进程（stage=${stage}）抛错：${payload.error}`
  );

  return payload;
}

function idsOf(list) {
  return list.map(item => item.id);
}

function diskIds(list) {
  return list.map(item => item.id);
}

function identityFields(list) {
  return JSON.stringify(
    list.map(item => [item.id, item.status, item.validFrom, item.validTo, item.supersededBy])
  );
}

const BIRTHDAY_OLD = '用户的生日是3月14日';
const BIRTHDAY_NEW = '用户的生日是6月20日';
const PLATE = '用户的车牌号是沪A12345';
const CITY = '用户住在杭州';
const PROJECT = '用户在开发云岫 Bluebird 这款 AI 聊天应用';
const Q_BIRTHDAY = '我的生日是哪天';
const Q_PLATE = '我的车牌号是多少';
const Q_CITY = '我住在哪个城市';
const Q_ALL = [Q_BIRTHDAY, Q_PLATE, Q_CITY];
const CORRECTION = {
  userText: '记住：我的生日其实是6月20日，之前说错了',
  reply: {
    content: BIRTHDAY_NEW,
    type: 'fact',
    keywords: ['生日'],
    confidence: 0.95,
    sourceQuote: '我的生日其实是6月20日',
  },
};

// ---- 依次重启的进程，后一个只看得到前一个落盘的结果 ----
// 先落一份「加 id 之前」的旧格式库，第一个进程读到的就是迁移前的真实数据。
fs.writeFileSync(MEMORY_FILE, JSON.stringify(SEED_ITEMS, null, 2), 'utf8');

const boot1 = runStage('inspect');
const boot2 = runStage('inspect');
const boot3 = runStage('inspect');

test('旧数据在独立进程里被读入：补齐 id/status/validFrom，条目数不变', () => {
  assert.equal(boot1.before.activeCount, SEED_ITEMS.length);
  assert.equal(boot1.before.disk.length, SEED_ITEMS.length, '读盘迁移不得往文件里加条目');

  for (const item of boot1.before.active) {
    assert.ok(item.id, `条目缺 id：${item.content}`);
    assert.equal(item.status, 'active');
    assert.equal(item.validFrom, item.createdAt);
    assert.equal(item.validTo, null);
    assert.equal(item.supersededBy, null);
    assert.ok(item.id.startsWith('legacy-'), `旧数据的派生 id 前缀应为 legacy-：${item.id}`);
  }

  // 平铺 sourceQuote 仍在，旧客户端按老字段读也不该看到空值
  const birthday = boot1.before.active.find(item => item.content === BIRTHDAY_OLD);

  assert.ok(birthday, '生日那条旧记忆不见了');
  assert.equal(birthday.sourceQuote, '我的生日是3月14日');
});

test('连开三次进程：派生 id 与磁盘内容逐字节等价，没多出重复条目', () => {
  assert.equal(boot2.before.activeCount, boot1.before.activeCount);
  assert.equal(boot3.before.activeCount, boot1.before.activeCount);

  assert.deepEqual(idsOf(boot2.before.active), idsOf(boot1.before.active));
  assert.deepEqual(idsOf(boot3.before.active), idsOf(boot1.before.active));
  assert.deepEqual(diskIds(boot3.before.disk), diskIds(boot1.before.disk));

  assert.equal(
    identityFields(boot2.before.active),
    identityFields(boot1.before.active),
    '身份/时效字段在第二个进程里被重算成了另一套值'
  );
  assert.equal(
    identityFields(boot3.before.active),
    identityFields(boot1.before.active),
    '第三个进程又变了一次——迁移不确定的字段会让更正与撤回定位漂移'
  );

  // 三个 stage 必须是三个不同的 pid，否则「重启后 id 不变」是同进程自证
  assert.ok(
    boot1.before.pid !== boot2.before.pid &&
      boot2.before.pid !== boot3.before.pid &&
      boot1.before.pid !== boot3.before.pid,
    `stage 之间没有真的换进程：${[boot1, boot2, boot3].map(item => item.before.pid).join(' / ')}`
  );

  // 磁盘上的原始数组也一个字节都没被读盘改写
  assert.deepEqual(boot3.before.disk, boot1.before.disk);

  for (const boot of [boot1, boot2, boot3]) {
    assert.equal(boot.before.consistency.consistent, true, '内存与磁盘对不上');
  }
});

test('归属跨进程不丢：A 读不到 B 的车牌，B 也读不到 A 的生日', () => {
  assert.deepEqual(
    idsOf(boot1.before.active),
    idsOf(boot3.before.active),
    '后续断言的前提（同一套 id）不成立'
  );

  const { searches, injected } = boot1.before;

  // 每条事实都用「它答得上的问题」去问：换成答不上的问题，断言会恒真。
  assert.deepEqual(searches.sessionA[Q_BIRTHDAY], [BIRTHDAY_OLD]);
  assert.deepEqual(searches.sessionB[Q_PLATE], [PLATE]);
  assert.deepEqual(
    searches.sessionA[Q_PLATE],
    [],
    'A 会话用车牌问题问出了 B 会话的记忆（跨进程后归属隔离失效）'
  );
  assert.deepEqual(
    searches.sessionB[Q_BIRTHDAY],
    [],
    'B 会话检索到了 A 会话的生日'
  );

  // 注入路径同理：A 的上下文里不许出现 B 的事实，B 的里不许出现 A 的
  for (const query of Q_ALL) {
    for (const line of injected.sessionA[query]) {
      assert.ok(
        !line.includes('沪A12345'),
        `A 会话的注入上下文里出现了 B 会话的事实：${query} → ${line}`
      );
    }
    for (const line of injected.sessionB[query]) {
      assert.ok(
        !line.includes('3月14日') && !line.includes('Bluebird'),
        `B 会话的注入上下文里出现了 A 会话的事实：${query} → ${line}`
      );
    }
  }

  // 无归属旧数据的可见规则（docs/memory-audit.md 记明的取舍）：
  // 会话自己有记忆时不再回落到 legacy 池，只有全新会话才读得到它。
  // 这条断言把规则钉住：谁改了这个回落条件，必须重新论证隐私边界。
  assert.deepEqual(searches.sessionA[Q_CITY], []);
  assert.deepEqual(searches.sessionB[Q_CITY], []);
  assert.ok(
    searches.fresh[Q_CITY].includes(CITY),
    `全新会话读不到无归属旧记忆，迁移把它判给了某个会话：${JSON.stringify(searches.fresh[Q_CITY])}`
  );
  assert.ok(
    !searches.fresh[Q_BIRTHDAY].includes(BIRTHDAY_OLD),
    '全新会话读到了具名会话的生日（回落条件写宽了）'
  );
  assert.ok(
    !injected.fresh[Q_CITY].some(line => line.includes('3月14日')),
    '回落只该带无归属数据，注入里混进了具名会话的事实'
  );
  assert.ok(
    injected.fresh[Q_CITY].some(line => line.includes(CITY)),
    `无归属旧记忆没进全新会话的注入上下文：${JSON.stringify(injected.fresh[Q_CITY])}`
  );

  // 归属来自平铺 sessionId 的升级结果，不是重新猜的
  const plate = boot1.before.active.find(item => item.content === PLATE);

  assert.deepEqual(plate.sessions, [SESSION_B]);

  const city = boot1.before.active.find(item => item.content === CITY);

  assert.deepEqual(
    city.sessions,
    [null],
    '无归属旧数据被迁移随意判给了某个会话'
  );
});

test('B 进程里按 A 进程报回的 id 做更正：supersededId 就是那个 id', () => {
  const birthdayId = boot3.before.active.find(
    item => item.content === BIRTHDAY_OLD
  ).id;

  const corrected = runStage('correct', { ...CORRECTION });

  assert.equal(corrected.outcome.written, true, '更正没写进去');
  assert.equal(corrected.outcome.action, 'superseded');
  assert.equal(
    corrected.outcome.supersededId,
    birthdayId,
    '新条目报回的 supersededId 与前一个进程里的 id 不是同一个——跨进程定位失败'
  );
  assert.ok(
    corrected.outcome.id && corrected.outcome.id.startsWith('mem-'),
    `新写入应发新式 id，实际 ${corrected.outcome.id}`
  );

  // 同一进程内旧事实已让位
  assert.ok(
    !corrected.after.searches.sessionA[Q_BIRTHDAY].includes(BIRTHDAY_OLD),
    '更正后旧事实在本进程仍可检索'
  );
  assert.ok(corrected.after.searches.sessionA[Q_BIRTHDAY].includes(BIRTHDAY_NEW));

  // 留档只是不活跃，没被删掉
  const archived = corrected.after.disk.find(item => item.id === birthdayId);

  assert.ok(archived, '旧条目被直接从磁盘抹掉了：审计链断了');
  assert.equal(archived.status, 'superseded');
  assert.equal(corrected.after.activeCount, SEED_ITEMS.length, '活跃条目数应保持不变');
});

test('再重启一个进程：更正结果仍在，旧事实没复活成活跃条目', () => {
  const after = runStage('inspect');

  assert.equal(
    after.before.consistency.consistent,
    true,
    '更正落盘后内存与磁盘不一致'
  );
  assert.ok(
    !idsOf(after.before.active).includes(
      boot3.before.active.find(item => item.content === BIRTHDAY_OLD).id
    ),
    '重启后旧事实又变回活跃条目（superseded 状态被读盘迁移覆盖掉了）'
  );
  assert.ok(after.before.searches.sessionA[Q_BIRTHDAY].includes(BIRTHDAY_NEW));
  assert.ok(!after.before.searches.sessionA[Q_BIRTHDAY].includes(BIRTHDAY_OLD));

  for (const line of after.before.injected.sessionA[Q_BIRTHDAY]) {
    assert.ok(!line.includes('3月14日'), `重启后旧生日又进了注入上下文：${line}`);
  }

  const newId = after.before.active.find(item => item.content === BIRTHDAY_NEW).id;

  assert.ok(
    after.before.disk.some(item => item.id === newId),
    '新条目在内存里有、磁盘上没有：落盘顺序没保证'
  );
});

test('新进程只用上一个进程报回的 id 删除；重启后仍然删干净', () => {
  const beforeDelete = runStage('inspect');

  const targetId = beforeDelete.before.active.find(
    item => item.content === PROJECT
  ).id;

  const deleted = runStage('delete', { id: targetId });

  assert.deepEqual(
    {
      removed: deleted.outcome.removed,
      reason: deleted.outcome.reason,
      id: deleted.outcome.id,
    },
    { removed: 1, reason: 'ok', id: targetId },
    `按跨进程 id 删除失败：${JSON.stringify(deleted.outcome)}`
  );
  assert.ok(!idsOf(deleted.after.active).includes(targetId));
  assert.ok(!deleted.after.disk.some(item => item.id === targetId));

  const afterRestart = runStage('inspect');

  assert.ok(
    !idsOf(afterRestart.before.active).includes(targetId),
    '删除只活在内存里，重启就复活了'
  );
  assert.ok(
    !afterRestart.before.disk.some(item => item.id === targetId),
    '磁盘上还剩那条'
  );
  assert.equal(afterRestart.before.consistency.consistent, true);

  // 其余条目的身份不受影响：删掉的那条没了，被更正取代的旧生日退出活跃集，
  // 活下来的每一条仍是 boot1 那个进程报回的 id，新生日用新发的 mem- id。
  const supersededId = boot1.before.active.find(
    item => item.content === BIRTHDAY_OLD
  ).id;
  const correctedId = afterRestart.before.active.find(
    item => item.content === BIRTHDAY_NEW
  ).id;

  const expected = boot1.before.active
    .map(item => item.id)
    .filter(id => id !== targetId && id !== supersededId)
    .concat(correctedId)
    .sort();

  assert.deepEqual(afterRestart.before.active.map(item => item.id).sort(), expected);
  assert.ok(
    afterRestart.before.disk.some(item => item.id === supersededId),
    '旧生日条目被整条抹掉了：superseded 留档在重启后应当还在磁盘上'
  );
  assert.equal(
    afterRestart.before.disk.find(item => item.id === supersededId).status,
    'superseded',
    '读盘迁移把 superseded 状态改了回去'
  );
});

test('旧的 createdAt + content 定位方式在重启后仍可用（不能一次性废掉）', () => {
  const fresh = runStage('inspect');

  const target = fresh.before.active.find(item => item.content === CITY);

  const deleted = runStage('deleteLegacyKey', {
    createdAt: target.createdAt,
    content: target.content,
  });

  assert.equal(deleted.outcome.removed, 1, '旧定位方式已失效');
  assert.equal(
    deleted.outcome.id,
    target.id,
    '用旧键定位到了条目，却没回传稳定 id：调用方无法确认删的是同一条'
  );
  assert.ok(!idsOf(deleted.after.active).includes(target.id));

  const afterRestart = runStage('inspect');

  assert.ok(!idsOf(afterRestart.before.active).includes(target.id), '重启后又回来了');
  assert.equal(afterRestart.before.consistency.consistent, true);
});

test('撤回按消息时间窗跨进程生效：摘掉本会话贡献，不碰别人的', () => {
  const before = runStage('inspect');

  const birthdayEntry = before.before.active.find(
    item => item.content === BIRTHDAY_NEW
  );
  const plateEntry = before.before.active.find(
    item => item.content === '用户的车牌号是沪A12345'
  );

  assert.ok(birthdayEntry, '前面的更正步骤没留下新生日条目');

  // 更正条目是本测试运行时写进去的，贡献时间取它自己的 validFrom
  const contributedAt = birthdayEntry.validFrom;

  const recalled = runStage('recall', {
    messageText: CORRECTION.userText,
    messageTime: contributedAt,
  });

  assert.equal(
    recalled.outcome.removedEntries >= 1,
    true,
    `撤回没摘掉任何条目：${JSON.stringify(recalled.outcome)}`
  );

  const after = runStage('inspect');

  assert.ok(
    !after.before.active.some(item => item.content === BIRTHDAY_NEW),
    '撤回后新生日仍可检索'
  );
  assert.ok(
    after.before.active.some(item => item.id === plateEntry.id),
    '撤回把 B 会话的车牌一起带走了'
  );
  assert.equal(after.before.consistency.consistent, true);
});
