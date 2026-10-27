/**
 * 云岫 Bluebird — 记忆条目稳定身份与时效字段（P0-1，server/memory.js）
 *
 * 硬性要求 1 的可执行版本，四条一起验：
 *   1. 迁移不能破坏旧数据：旧字段（正文/类型/关键词/置信度/时间）逐字保留，
 *      新字段只由已有字段推导；
 *   2. 重复执行不能生成重复条目：读盘迁移是纯函数，重跑 N 次结果逐字节相同；
 *   3. 更正与删除优先改用稳定 id，同时旧的 createdAt + content 定位方式不废；
 *   4. confidence 真正参与排序（只调次序，不推翻相关性）。
 *
 * 隔离：全程临时 BLUEBIRD_DATA_DIR，绝不读写 server/data 的真实记忆文件。
 * 运行：node tests/memory-id-migration.test.js（也在 npm test 自动发现范围内）
 */
const { test, describe, before } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const origLog = console.log;
const origErr = console.error;
console.log = () => {};
console.error = () => {};

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'bluebird-mem-id-'));
process.env.BLUEBIRD_DATA_DIR = TMP;

const MEMORY_FILE = path.join(TMP, 'memory.json');
const memory = require(path.join(__dirname, '..', 'server', 'memory.js'));

const MINUTE = 60 * 1000;

// 秒级对齐的固定基准：同一个偏移量在整个文件里必须是同一个时间戳，
// 否则「逐字保留旧字段」这类断言会被毫秒差自己打脸。
const BASE = Math.floor(Date.now() / 1000) * 1000;

function at(minutesAgo) {
  return new Date(BASE - minutesAgo * MINUTE).toISOString();
}

function seed(items) {
  fs.writeFileSync(MEMORY_FILE, JSON.stringify(items, null, 2), 'utf8');
  memory.loadMemories();
}

function readDisk() {
  return JSON.parse(fs.readFileSync(MEMORY_FILE, 'utf8'));
}

/** 引入 id / 贡献列表之前的旧数据形态：归属与锚点平铺在条目上 */
function legacy(overrides = {}) {
  return {
    content: '用户叫宋泽',
    type: 'identity',
    keywords: ['名字', '宋泽'],
    confidence: 0.95,
    sourceQuote: '我叫宋泽',
    sessionId: 's-legacy',
    createdAt: at(-60),
    ...overrides,
  };
}

function fakeClient(reply) {
  return {
    chat: {
      completions: {
        create: async () => ({
          choices: [{ message: { content: typeof reply === 'string' ? reply : JSON.stringify(reply) } }],
        }),
      },
    },
  };
}

function fingerprint(list) {
  return JSON.stringify(
    list.map(item => [item.id, item.status, item.validFrom, item.validTo, item.supersededBy])
  );
}

describe('旧数据迁移：补齐身份与时效字段，不改写任何已有内容', { concurrency: 1 }, () => {
  before(() => seed([legacy()]));

  test('正文/类型/关键词/置信度/时间与旧数据逐字一致', () => {
    const stored = readDisk();

    assert.equal(stored.length, 1, '读盘迁移绝不写文件');

    const [item] = memory.getMemories();

    assert.equal(item.content, '用户叫宋泽');
    assert.equal(item.type, 'identity');
    assert.deepEqual(item.keywords, ['名字', '宋泽']);
    assert.equal(item.confidence, 0.95);
    assert.equal(item.createdAt, at(-60));
    assert.equal(item.sourceQuote, '我叫宋泽', '展示用 sourceQuote 由最早贡献补出，旧客户端仍能用');
  });

  test('新字段全部由已有字段推导（id 稳定、status=active、validFrom=createdAt）', () => {
    const [item] = memory.getMemories();

    assert.ok(item.id.startsWith('legacy-'), `id 前缀应为 legacy-，实际 ${item.id}`);
    assert.equal(item.status, 'active');
    assert.equal(item.validFrom, item.createdAt);
    assert.equal(item.validTo, null);
    assert.equal(item.supersededBy, null);

    // 平铺的归属与锚点升级成一条贡献，归属信息不丢
    assert.deepEqual(item.contributions, [
      { sessionId: 's-legacy', sourceQuote: '我叫宋泽', createdAt: at(-60) },
    ]);
  });

  test('同一份旧数据反复推导得到同一个 id（迁移规则确定）', () => {
    const first = fingerprint(memory.getMemories());

    memory.loadMemories();
    memory.loadMemories();
    memory.loadMemories();

    assert.equal(fingerprint(memory.getMemories()), first);
    assert.equal(memory.getMemories().length, 1, '重复执行不能生成重复条目');
  });

  test('已经迁移过的库再读一次是恒等操作（升级后落盘也不改名）', async () => {
    const hydrated = memory.getMemories();
    const idBefore = hydrated[0].id;

    // 模拟一次真实写入把升级后的形态落盘
    await memory.processMemory(
      fakeClient({
        content: '用户叫宋泽',
        type: 'identity',
        keywords: ['名字'],
        confidence: 0.95,
        sourceQuote: '我叫宋泽',
      }),
      '记住，我叫宋泽',
      's-legacy'
    );

    memory.loadMemories();

    const stored = memory.getMemories();

    assert.equal(stored.length, 1, '同一条事实的重述只应就地更新，不能新增条目');
    assert.equal(stored[0].id, idBefore, '已有 id 原样保留，不被重新推导');
    assert.equal(readDisk()[0].id, idBefore, '磁盘上的 id 也必须保持');
  });

  test('正文与时间都相同的重复旧条目按出现次序加 #2 后缀，后缀稳定且 id 全局唯一', () => {
    const same = legacy();

    seed([same, { ...same }, { ...same }]);

    const list = memory.getMemories();
    const ids = list.map(item => item.id);

    assert.equal(list.length, 3, '重复条目保留，不静默丢弃');
    assert.equal(new Set(ids).size, 3, 'id 必须全局唯一');
    assert.ok(ids[1].startsWith(ids[0]) && ids[1].endsWith('#2'), `第二条应带 #2，实际 ${ids[1]}`);
    assert.ok(ids[2].endsWith('#3'), `第三条应带 #3，实际 ${ids[2]}`);

    memory.loadMemories();

    assert.deepEqual(
      memory.getMemories().map(item => item.id),
      ids,
      '后缀由出现次序决定，重跑必须一致'
    );
  });

  test('缺正文的脏数据仍被过滤，不参与 id 推导', () => {
    seed([legacy(), { content: '   ', type: 'fact' }, null]);

    assert.equal(memory.getMemories().length, 1);
  });
});

describe('状态与时效：更正走 supersede，旧条目退出生效集', { concurrency: 1 }, () => {
  before(() =>
    seed([
      legacy({
        content: '用户喝咖啡只喝拿铁',
        type: 'preference',
        keywords: ['咖啡', '拿铁'],
        sourceQuote: '我喝咖啡只喝拿铁',
        sessionId: 's-a',
        createdAt: at(-90),
      }),
    ])
  );

  test('未知状态一律按不生效处理（fail-closed），旧条目不会因迁移被删', async () => {
    seed([
      legacy({ content: '用户喝咖啡只喝拿铁', type: 'preference', keywords: ['咖啡'], sourceQuote: '我喝咖啡只喝拿铁', sessionId: 's-a' }),
      legacy({ content: '用户养了一只猫', type: 'fact', keywords: ['猫'], sourceQuote: '我养了一只猫', sessionId: 's-a', status: 'deleted-by-mistake' }),
    ]);

    const all = memory.getMemories({ includeSuperseded: true });

    assert.equal(all.length, 2, '迁移不删条目，未知状态也留在库里供审计');
    assert.deepEqual(
      memory.getMemories().map(item => item.content),
      ['用户喝咖啡只喝拿铁'],
      'status 不认识 → 当作不生效（宁可少给，不可多给）'
    );
  });

  test('更正后旧条目 status=superseded、validTo 落地、supersededBy 指向新 id', async () => {
    seed([
      legacy({
        content: '用户喝咖啡只喝拿铁',
        type: 'preference',
        keywords: ['咖啡', '拿铁'],
        sourceQuote: '我喝咖啡只喝拿铁',
        sessionId: 's-a',
        createdAt: at(-90),
      }),
    ]);

    const oldId = memory.getMemories()[0].id;

    const outcome = await memory.processMemory(
      fakeClient({
        content: '用户喝咖啡只喝美式',
        type: 'preference',
        keywords: ['咖啡', '美式'],
        confidence: 0.92,
        sourceQuote: '我喝咖啡只喝美式',
      }),
      '记住，我喝咖啡只喝美式',
      's-a'
    );

    assert.equal(outcome.written, true);
    assert.equal(outcome.action, 'superseded', '同话题不同说法应判为更正');
    assert.equal(outcome.supersededId, oldId, '结果要带回被更正条目的稳定 id');
    assert.ok(outcome.id.startsWith('mem-'), '新条目用新签发的 id');

    const active = memory.getMemories();

    assert.deepEqual(active.map(item => item.content), ['用户喝咖啡只喝美式']);

    const archived = memory
      .getMemories({ includeSuperseded: true })
      .find(item => item.id === oldId);

    assert.equal(archived.status, 'superseded');
    assert.ok(archived.validTo, '被更正的条目必须写明失效时间');
    assert.equal(archived.supersededBy, outcome.id);
    assert.equal(archived.content, '用户喝咖啡只喝拿铁', '只动元数据，正文保持原样');
    assert.deepEqual(
      readDisk().find(item => item.id === oldId).status,
      'superseded',
      '状态变更必须落盘'
    );
  });

  test('两条读路径都看不到被更正的旧条目（不再有「新旧同时注入」）', async () => {
    const scoped = memory.searchMemories({
      query: '我喝咖啡选什么',
      sessionId: 's-a',
      limits: { maxItems: 10, perItemMax: 300, totalMax: 2000 },
    });
    const injected = memory.buildMemoryContext('我喝咖啡选什么', 's-a');

    assert.deepEqual(scoped.results.map(item => item.content), ['用户喝咖啡只喝美式']);
    assert.ok(!injected.includes('拿铁'), injected);
    assert.ok(injected.includes('美式'), injected);
  });

  test('重述同一事实只追加贡献，id 与 validFrom 不变', async () => {
    const before = memory.getMemories();
    const target = before.find(item => item.content === '用户喝咖啡只喝美式');

    const outcome = await memory.processMemory(
      fakeClient({
        content: '用户喝咖啡只喝美式',
        type: 'preference',
        keywords: ['咖啡', '美式'],
        confidence: 0.95,
        sourceQuote: '咖啡我只喝美式',
      }),
      '记住，咖啡我只喝美式',
      's-b'
    );

    assert.equal(outcome.action, 'merged');
    assert.equal(outcome.id, target.id, '重述必须落在同一条 id 上');

    const after = memory.getMemories().find(item => item.id === target.id);

    assert.equal(after.validFrom, target.validFrom, '重述不改变事实的生效时间');
    assert.equal(after.status, 'active', '重述把被更正的条目重新激活');
    assert.equal(after.contributions.length, 2, '本会话的贡献追加为新的一条');
    assert.deepEqual(
      after.contributions.map(item => item.sessionId).sort(),
      ['s-a', 's-b']
    );
  });
});

describe('删除定位：优先稳定 id，旧的 createdAt + content 不废', { concurrency: 1 }, () => {
  before(() =>
    seed([
      legacy({ content: '用户喜欢踢足球', type: 'preference', keywords: ['足球'], sourceQuote: '我喜欢踢足球', sessionId: 's-a', createdAt: at(-50) }),
      legacy({ content: '用户车牌是京A12345', type: 'fact', keywords: ['车牌'], sourceQuote: '我的车牌是京A12345', sessionId: 's-a', createdAt: at(-40) }),
    ])
  );

  test('按 id 删除：命中 1 条并回传该 id', async () => {
    const [first] = memory.getMemories();

    const result = await memory.deleteMemory({ id: first.id });

    assert.deepEqual(
      { removed: result.removed, reason: result.reason, id: result.id },
      { removed: 1, reason: 'ok', id: first.id }
    );
    assert.equal(memory.getMemories().length, 1);
    assert.equal(readDisk().length, 1);
    assert.equal(await memory.verifyStoreConsistency().consistent, true);
  });

  test('按旧定位键（createdAt + content）删除：老客户端不受影响', async () => {
    const [remaining] = memory.getMemories();

    const result = await memory.deleteMemory({
      createdAt: remaining.createdAt,
      content: remaining.content,
    });

    assert.equal(result.removed, 1);
    assert.equal(result.id, remaining.id, '旧键命中后也要回传稳定 id');
    assert.equal(memory.getMemories().length, 0);
  });

  test('两种定位方式都没给 → reason=invalid，不碰库', async () => {
    seed([legacy()]);

    const result = await memory.deleteMemory({});

    assert.deepEqual(result, { removed: 0, reason: 'invalid' });
    assert.equal(memory.getMemories().length, 1);
  });

  test('给了 id 但库里没有 → reason=not-found', async () => {
    const result = await memory.deleteMemory({ id: 'mem-不存在' });

    assert.deepEqual(result, { removed: 0, reason: 'not-found' });
    assert.equal(memory.getMemories().length, 1);
  });

  test('落盘的库不需要重新推导就能按 id 找回（重启后 id 仍可定位）', async () => {
    seed([legacy()]);

    const idBefore = memory.getMemories()[0].id;

    memory.loadMemories();

    assert.equal(memory.getMemories()[0].id, idBefore);
    assert.equal((await memory.deleteMemory({ id: idBefore })).removed, 1);
  });
});

describe('confidence 参与排序：只调次序，不推翻相关性', { concurrency: 1 }, () => {
  // 两条构造成正好同相关度的记忆：关键词集合相同、二元组数量与命中数相同，
  // 因此 relevance 相等，次序只能由置信度决定。
  const pair = () => [
    legacy({
      content: '用户喜欢在周三开会',
      type: 'fact',
      keywords: ['开会'],
      confidence: 0.87,
      sourceQuote: '我喜欢在周三开会',
      sessionId: null,
      createdAt: at(-30),
    }),
    legacy({
      content: '用户喜欢在周五开会',
      type: 'fact',
      keywords: ['开会'],
      confidence: 0.98,
      sourceQuote: '我喜欢在周五开会',
      sessionId: null,
      createdAt: at(-20),
    }),
  ];

  const query = '在周三开会还是在周五开会呢';

  test('同相关度下高置信度排在前，且结果里能看出 relevance 相同、score 不同', () => {
    seed(pair());

    const result = memory.searchMemories({
      query,
      sessionId: null,
      limits: { maxItems: 10, perItemMax: 300, totalMax: 2000 },
    });

    assert.equal(result.results.length, 2);
    assert.equal(result.results[0].content, '用户喜欢在周五开会');
    assert.equal(result.results[0].relevance, result.results[1].relevance, '先确认两条相关性完全相同');
    assert.ok(result.results[0].score > result.results[1].score, '相关性相同时由置信度决胜');
    assert.ok(result.results[0].id && result.results[0].validFrom, '检索结果带稳定 id 与时效，供上层按 id 定位');
  });

  test('把置信度调换，次序跟着调换（证明置信度真的进了算分，不是摆设）', () => {
    const swapped = pair().map(item => ({
      ...item,
      confidence: item.confidence === 0.87 ? 0.98 : 0.87,
    }));

    seed(swapped);

    assert.equal(
      memory.searchMemories({ query, sessionId: null, limits: { maxItems: 10 } }).results[0].content,
      '用户喜欢在周三开会'
    );
  });

  test('置信度不能把强相关的低置信记忆挤成第一（只做温和调节）', () => {
    seed([
      legacy({
        content: '用户喜欢踢足球',
        type: 'preference',
        keywords: ['足球'],
        confidence: 0.86,
        sourceQuote: '我喜欢踢足球',
        sessionId: null,
      }),
      legacy({
        content: '用户喜欢踢足球和打篮球',
        type: 'preference',
        keywords: ['足球', '篮球', '踢球'],
        confidence: 0.99,
        sourceQuote: '我喜欢踢足球',
        sessionId: null,
      }),
    ]);

    const top = memory
      .searchMemories({ query: '足球', sessionId: null, limits: { maxItems: 10 } })
      .results.map(item => item.content);

    assert.ok(top.includes('用户喜欢踢足球'), '低置信但完全命中关键词的记忆仍应被召回');
  });

  test('注入路径同样按置信度决胜，且与工具检索给出同一个赢家', () => {
    // 小库走「全量注入、跳过相关性过滤」，次序不代表算分；
    // 要验排序一致，必须把候选池撑到 SMALL_MEMORY_LIMIT(15) 以上。
    const fillers = [];

    for (let index = 0; index < 15; index += 1) {
      fillers.push(
        legacy({
          content: `无关条目第${index}号`,
          type: 'fact',
          keywords: [`无关${index}`],
          confidence: 0.9,
          sourceQuote: `无关第${index}号`,
          sessionId: null,
          createdAt: at(-(index + 5)),
        })
      );
    }

    seed([...pair(), ...fillers]);

    const injected = memory.buildMemoryContext(query, null);
    const scoped = memory.searchMemories({ query, sessionId: null, limits: { maxItems: 10 } });

    const bullets = injected
      .split('\n')
      .filter(line => line.startsWith('- '))
      .map(line => line.slice(2).trim());

    assert.deepEqual(bullets, ['用户喜欢在周五开会', '用户喜欢在周三开会'], `注入内容：\n${injected}`);
    assert.equal(scoped.results[0].content, '用户喜欢在周五开会', '三条读路径必须同一个赢家');
  });
});

describe('identity 配额：把「永不被淘汰」改成显式规则', { concurrency: 1 }, () => {
  test('全部是 identity 且超配额时，按最旧淘汰到 IDENTITY_QUOTA，非 identity 先出局', async () => {
    const many = [];

    for (let index = 0; index < 101; index += 1) {
      many.push(
        legacy({
          content: `用户身份第${index}条`,
          type: 'identity',
          keywords: [`身份${index}`],
          sourceQuote: `我的身份${index}`,
          sessionId: null,
          createdAt: at(-(index + 200)),
          updatedAt: at(-(index + 200)),
        })
      );
    }

    seed(many);

    assert.equal(memory.getMemories().length, 101);

    const outcome = await memory.processMemory(
      fakeClient({
        content: '用户下周要去出差',
        type: 'goal',
        keywords: ['出差'],
        confidence: 0.9,
        sourceQuote: '我下周要去出差',
      }),
      '记住，我下周要去出差',
      's-quota'
    );

    assert.equal(outcome.written, true);

    const survivors = memory.getMemories({ includeSuperseded: true });
    const identities = survivors.filter(item => item.type === 'identity');

    assert.ok(identities.length <= 20, `identity 应收敛到配额内，实际 ${identities.length}`);
    assert.equal(survivors.length, 20, '非 identity 条目应先于任何 identity 被淘汰');
    assert.deepEqual(
      identities.map(item => item.content).sort(),
      many
        .slice(many.length - 20)
        .map(item => item.content)
        .sort(),
      '保留的是最新的 20 条 identity，不是数组开头的 20 条'
    );
  });
});

origLog('memory-id-migration：见上方 node:test 汇总');
