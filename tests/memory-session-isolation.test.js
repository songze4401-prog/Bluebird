/**
 * 云岫 Bluebird — 记忆会话隔离覆盖全部入口（硬性要求 2）
 *
 * 验收口径按用户原话执行：「用两个会话保存相似但不同的事实，
 * 验证任何一条路径都不能串读」，并且「不只修 inject，还要检查搜索、
 * 回退逻辑、贡献归属、撤回和清理」。
 *
 * 三条读路径都走生产代码，一条都不绕过：
 *   1. 注入        buildMemoryContext(query, sessionId)      —— /chat 线上路径
 *   2. 工具搜索    searchMemories({query, sessionId, limits}) —— Agent 工具
 *   3. 引擎检索    retriever.retrieveMemory({task, sessionId})  —— Context Runtime
 * 写入侧另验三件事：贡献归属登记、撤回只摘本会话、按会话清理不误伤他人。
 *
 * 运行：node tests/memory-session-isolation.test.js（也在 npm test 范围内）
 */
const { test, describe, before } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

console.log = () => {};
console.error = () => {};

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'bluebird-mem-isolation-'));
process.env.BLUEBIRD_DATA_DIR = TMP;

const MEMORY_FILE = path.join(TMP, 'memory.json');
const memory = require(path.join(__dirname, '..', 'server', 'memory.js'));
const { retrieveMemory } = require(path.join(__dirname, '..', 'server', 'context', 'retriever.js'));

const SESSION_A = 's-coffee-a';
const SESSION_B = 's-coffee-b';
const SESSION_OTHER = 's-brand-new';

const MINUTE = 60 * 1000;
const BASE = Math.floor(Date.now() / 1000) * 1000;

function at(minutesAgo) {
  // 负偏移表示过去；历史用例传 at(-N) 是有意的“N 分钟前”。
  return new Date(BASE + minutesAgo * MINUTE).toISOString();
}

function seed(items) {
  fs.writeFileSync(MEMORY_FILE, JSON.stringify(items, null, 2), 'utf8');
  memory.loadMemories();
}

function readDisk() {
  return JSON.parse(fs.readFileSync(MEMORY_FILE, 'utf8'));
}

/** 一条「具名会话说过」的记忆（贡献带 sessionId） */
function owned(content, sessionId, sourceQuote, minutesAgo = 30, extra = {}) {
  return {
    content,
    type: 'preference',
    keywords: extra.keywords || [content.slice(-2)],
    confidence: 0.95,
    contributions: [{ sessionId, sourceQuote, createdAt: at(-minutesAgo) }],
    createdAt: at(-minutesAgo),
    updatedAt: at(-minutesAgo),
    ...extra,
  };
}

/** 一条引入会话归属之前的旧数据（无归属，允许回退可见） */
function unattributed(content, sourceQuote, extra = {}) {
  return {
    content,
    type: 'fact',
    keywords: extra.keywords || [content.slice(-2)],
    confidence: 0.9,
    sourceQuote,
    createdAt: at(-60),
    updatedAt: at(-60),
    ...extra,
  };
}

function fakeClient(entry) {
  return {
    chat: {
      completions: {
        create: async () => ({
          choices: [{ message: { content: JSON.stringify(entry) } }],
        }),
      },
    },
  };
}

const COFFEE_QUERY = '我喝咖啡选什么';
const EDITOR_QUERY = '我平时用什么编辑器';
const CITY_QUERY = '我住在哪个城市';

/** 两个会话各自说过「相似但不同」的事实，外加一条无归属旧数据 */
function twoSessionsStore() {
  return [
    owned('用户喝咖啡只喝美式', SESSION_A, '我喝咖啡只喝美式', 40, { keywords: ['咖啡', '美式'] }),
    owned('用户喝咖啡只喝拿铁', SESSION_B, '我喝咖啡只喝拿铁', 35, { keywords: ['咖啡', '拿铁'] }),
    owned('用户常用编辑器是 Vim', SESSION_A, '我用 Vim 写代码', 25, { keywords: ['编辑器', 'Vim'] }),
    owned('用户常用编辑器是 VS Code', SESSION_B, '我用 VS Code 写代码', 20, { keywords: ['编辑器', 'VS Code'] }),
    unattributed('用户住在杭州', '我住在杭州', { keywords: ['城市', '杭州'] }),
  ];
}

function extractContents(text) {
  return text
    .split('\n')
    .filter(line => line.startsWith('- '))
    .map(line => line.slice(2).trim());
}

async function allThreePaths(query, sessionId) {
  const injected = extractContents(memory.buildMemoryContext(query, sessionId));
  const scoped = memory
    .searchMemories({
      query,
      sessionId,
      limits: { maxItems: 10, perItemMax: 300, totalMax: 2000 },
    })
    .results.map(item => item.content);
  const engineResult = await retrieveMemory({ task: query, sessionId });
  const engine = engineResult.items
    .filter(item => item.source === 'memory')
    .map(item => item.content);

  return { injected, scoped, engine };
}

// 会话 A / B 各自独有的事实；无归属旧数据单独列，便于逐条断言"谁能看见什么"。
const A_ONLY = ['用户喝咖啡只喝美式', '用户常用编辑器是 Vim'];
const B_ONLY = ['用户喝咖啡只喝拿铁', '用户常用编辑器是 VS Code'];
const LEGACY_ONLY = ['用户住在杭州'];

/** 每个入口都必须既拿不到 B 的、也拿不到 A 的（按调用方给定的归属） */
function assertNoCrossRead(paths, owner, other, sessionId, query) {
  const ownFacts = owner === SESSION_A ? A_ONLY : B_ONLY;
  const foreignFacts = other === SESSION_A ? A_ONLY : B_ONLY;

  for (const [name, list] of Object.entries(paths)) {
    const leaked = list.filter(content => foreignFacts.includes(content));

    assert.deepEqual(
      leaked,
      [],
      `串读：会话 ${sessionId} 经 ${name} 路径（query=${query}）读到了 ${other} 的记忆 ${JSON.stringify(leaked)}`
    );

    // 本会话名下的事实只能来自 ownFacts（注入路径会带上本会话全部记忆）
    for (const content of list) {
      assert.ok(
        ownFacts.includes(content) || LEGACY_ONLY.includes(content),
        `会话 ${sessionId} 经 ${name} 读到了不属于它的条目：${content}`
      );
    }
  }
}

describe('三条读路径都不串读（两个会话保存相似但不同的事实）', { concurrency: 1 }, () => {
  before(() => seed(twoSessionsStore()));

  test('会话 A：检索/引擎精确命中「美式」，注入含自己的记忆且绝不含「拿铁」', async () => {
    const paths = await allThreePaths(COFFEE_QUERY, SESSION_A);

    // 注入路径也按相关性过滤；隔离看的是"不含别人的"，不是条数。
    assert.deepEqual(paths.scoped, ['用户喝咖啡只喝美式']);
    assert.deepEqual(paths.engine, ['用户喝咖啡只喝美式']);
    assert.ok(paths.injected.includes('用户喝咖啡只喝美式'), paths.injected.join('\n'));
    assertNoCrossRead(paths, SESSION_A, SESSION_B, SESSION_A, COFFEE_QUERY);
  });

  test('会话 B：对称成立，拿不到 A 的「美式」', async () => {
    const paths = await allThreePaths(COFFEE_QUERY, SESSION_B);

    assert.deepEqual(paths.scoped, ['用户喝咖啡只喝拿铁']);
    assert.deepEqual(paths.engine, ['用户喝咖啡只喝拿铁']);
    assert.ok(paths.injected.includes('用户喝咖啡只喝拿铁'), paths.injected.join('\n'));
    assertNoCrossRead(paths, SESSION_B, SESSION_A, SESSION_B, COFFEE_QUERY);
  });

  test('换个话题（编辑器）仍然各回各家，隔离不是靠查询词碰巧', async () => {
    const a = await allThreePaths(EDITOR_QUERY, SESSION_A);
    const b = await allThreePaths(EDITOR_QUERY, SESSION_B);

    assert.deepEqual(a.scoped, ['用户常用编辑器是 Vim']);
    assert.deepEqual(a.engine, ['用户常用编辑器是 Vim']);
    assert.deepEqual(b.scoped, ['用户常用编辑器是 VS Code']);
    assert.deepEqual(b.engine, ['用户常用编辑器是 VS Code']);
    assertNoCrossRead(a, SESSION_A, SESSION_B, SESSION_A, EDITOR_QUERY);
    assertNoCrossRead(b, SESSION_B, SESSION_A, SESSION_B, EDITOR_QUERY);
  });

  test('不带 sessionId 的兼容入口：只给无归属旧数据，绝不回退成全库可见', async () => {
    for (const missing of [null, undefined, '', '   ']) {
      const injected = extractContents(memory.buildMemoryContext(COFFEE_QUERY, missing));

      // 相关性过滤后咖啡查询可能一条都不注入；隔离的判据是"绝不出现具名会话的条目"。
      assert.ok(
        injected.every(content => LEGACY_ONLY.includes(content)),
        `P0 泄漏口子：sessionId=${JSON.stringify(missing)} 时咖啡类具名记忆一条都不许出现：${JSON.stringify(injected)}`
      );

      const cityInjected = extractContents(
        memory.buildMemoryContext(CITY_QUERY, missing)
      );

      assert.deepEqual(
        cityInjected,
        LEGACY_ONLY,
        `无归属旧数据在城市查询下应可见，sessionId=${JSON.stringify(missing)}`
      );

      const cityQuery = memory.searchMemories({
        query: CITY_QUERY,
        sessionId: missing,
        limits: { maxItems: 10 },
      });

      assert.deepEqual(cityQuery.results.map(item => item.content), LEGACY_ONLY);

      for (const query of [COFFEE_QUERY, EDITOR_QUERY, CITY_QUERY]) {
        const contents = memory
          .searchMemories({ query, sessionId: missing, limits: { maxItems: 10 } })
          .results.map(item => item.content);

        assert.ok(
          contents.every(content => LEGACY_ONLY.includes(content)),
          `sessionId=${JSON.stringify(missing)} query=${query} 读到了具名会话的记忆：${JSON.stringify(contents)}`
        );
      }
    }
  });

  test('回退逻辑：全新会话没有自己的记忆，也只回退到无归属旧数据', async () => {
    const city = await allThreePaths(CITY_QUERY, SESSION_OTHER);
    const coffee = await allThreePaths(COFFEE_QUERY, SESSION_OTHER);

    assert.deepEqual(city.scoped, LEGACY_ONLY);
    assert.deepEqual(city.engine, LEGACY_ONLY);
    assert.deepEqual(city.injected, LEGACY_ONLY);

    // 问咖啡时它一条都拿不到：既不是"A 的答案"也不是"B 的答案"，而是诚实的空
    assert.deepEqual(coffee.scoped, []);
    assert.deepEqual(coffee.engine, []);
    assertNoCrossRead(coffee, SESSION_A, SESSION_B, SESSION_OTHER, COFFEE_QUERY);
  });

  test('三条路径对「这条记忆当前会话能不能看」结论必须一致（同一候选池）', async () => {
    const sessions = [SESSION_A, SESSION_B, SESSION_OTHER, null];

    for (const sessionId of sessions) {
      for (const query of [COFFEE_QUERY, EDITOR_QUERY, CITY_QUERY]) {
        const paths = await allThreePaths(query, sessionId);
        const asSet = list => [...new Set(list)].sort().join('|');

        // 工具与引擎共用 searchMemories，结论必须逐字相同；
        // 注入路径可以更少（独立的条数/token 预算），但只能落在同一个可见池内。
        assert.equal(
          asSet(paths.scoped),
          asSet(paths.engine),
          `工具与引擎结论不一致 session=${sessionId} query=${query}`
        );

        const poolContents = new Set(
          extractContents(memory.buildMemoryContext(query, sessionId))
        );

        for (const content of paths.scoped) {
          assert.ok(poolContents.has(content), `检索给了注入没给的一条：session=${sessionId} query=${query}`);
        }

        for (const content of [...paths.injected, ...paths.scoped, ...paths.engine]) {
          assert.ok(
            !content.includes('拿铁') || sessionId === SESSION_B,
            `会话 ${sessionId} 读到了别人的「拿铁」：${content}`
          );
          assert.ok(
            !content.includes('美式') || sessionId === SESSION_A,
            `会话 ${sessionId} 读到了别人的「美式」：${content}`
          );
        }
      }
    }
  });
});

describe('写入侧：贡献归属登记 + 更正不越会话', { concurrency: 1 }, () => {
  before(() => seed(twoSessionsStore()));

  test('新写入的记忆把贡献登记在发起会话名下', async () => {
    const outcome = await memory.processMemory(
      fakeClient({
        content: '用户养了一只叫糯糯的猫',
        type: 'fact',
        keywords: ['猫', '糯糯'],
        confidence: 0.93,
        sourceQuote: '我养了一只叫糯糯的猫',
      }),
      '记住，我养了一只叫糯糯的猫',
      SESSION_A
    );

    assert.equal(outcome.written, true);

    const stored = memory.getMemories({ includeSuperseded: true });
    const created = stored.find(item => item.id === outcome.id);

    assert.equal(created.contributions.length, 1, '贡献必须只登记发起会话');
    assert.equal(created.contributions[0].sessionId, SESSION_A);
    assert.equal(created.contributions[0].sourceQuote, '我养了一只叫糯糯的猫');
    assert.ok(Number.isFinite(Date.parse(created.contributions[0].createdAt)));
    assert.equal(readDisk().find(item => item.id === outcome.id).contributions[0].sessionId, SESSION_A);

    // 另一会话无论走哪条路径都看不到这条
    for (const content of [...(await allThreePaths('我养的猫叫什么', SESSION_B)).engine]) {
      assert.ok(!content.includes('糯糯'), `会话 B 读到了会话 A 的猫：${content}`);
    }
  });

  test('同一事实被第二个会话重述：追加贡献，两个会话都合法可见', async () => {
    const target = memory
      .getMemories()
      .find(item => item.content === '用户喝咖啡只喝美式');

    const outcome = await memory.processMemory(
      fakeClient({
        content: '用户喝咖啡只喝美式',
        type: 'preference',
        keywords: ['咖啡', '美式'],
        confidence: 0.94,
        sourceQuote: '咖啡我只要美式',
      }),
      '记住，咖啡我只要美式',
      SESSION_B
    );

    assert.equal(outcome.action, 'merged', '同一事实的重述应就地合并而不是新增');
    assert.equal(outcome.id, target.id);

    const merged = memory.getMemories().find(item => item.id === target.id);

    assert.deepEqual(
      merged.contributions.map(item => item.sessionId).sort(),
      [SESSION_A, SESSION_B]
    );

    // 共享事实：两个会话都能读到同一条 —— 这是归属正确的证据，不是串读
    const a = await allThreePaths(COFFEE_QUERY, SESSION_A);
    const b = await allThreePaths(COFFEE_QUERY, SESSION_B);

    assert.ok(a.scoped.includes('用户喝咖啡只喝美式'));
    assert.ok(b.scoped.includes('用户喝咖啡只喝美式'));
    // 会话 B 自己的「拿铁」还在，合并不能把它抹掉
    assert.ok(b.scoped.includes('用户喝咖啡只喝拿铁'), `会话 B 丢了自有记忆：${JSON.stringify(b.scoped)}`);
    // 会话 A 依然看不到会话 B 独有的「拿铁」
    assert.ok(!a.scoped.includes('用户喝咖啡只喝拿铁'));
  });

  test('会话 A 里的更正不会把新事实泄漏给会话 B（只会让旧事实退出 B 的视图）', async () => {
    const correction = await memory.processMemory(
      fakeClient({
        content: '用户常用编辑器是 Sublime',
        type: 'preference',
        keywords: ['编辑器', 'Sublime'],
        confidence: 0.91,
        sourceQuote: '编辑器我用 Sublime',
      }),
      '记住，编辑器我用 Sublime',
      SESSION_A
    );

    assert.equal(correction.action, 'superseded', '同话题不同说法应判为更正');

    const bView = await allThreePaths(EDITOR_QUERY, SESSION_B);

    for (const list of [bView.injected, bView.scoped, bView.engine]) {
      assert.ok(
        !list.some(content => content.includes('Sublime')),
        `会话 B 读到了会话 A 刚写下的更正：${JSON.stringify(list)}`
      );
    }

    const aView = await allThreePaths(EDITOR_QUERY, SESSION_A);

    assert.deepEqual(aView.scoped, ['用户常用编辑器是 Sublime']);
  });
});

describe('撤回与清理：只摘本会话的贡献，不误伤他人', { concurrency: 1 }, () => {
  before(() => seed(twoSessionsStore()));

  test('撤回会话 A 的消息：只摘掉 A 的贡献，B 的事实与可见性不变', async () => {
    const result = await memory.recallMemoryBySourceQuote(
      '我喝咖啡只喝美式',
      at(-40),
      SESSION_A
    );

    assert.deepEqual(result, { removedEntries: 1, removedContributions: 1 }, '两个计数都要回传');

    const bView = await allThreePaths(COFFEE_QUERY, SESSION_B);

    assert.deepEqual(bView.scoped, ['用户喝咖啡只喝拿铁']);

    const disk = readDisk();

    assert.equal(disk.some(item => item.content === '用户喝咖啡只喝拿铁'), true);
    assert.equal(disk.some(item => item.content === '用户喝咖啡只喝美式'), false);
    assert.equal(memory.verifyStoreConsistency().consistent, true);
  });

  test('撤回共享事实里属于 A 的那条贡献：整条记忆必须活着，B 仍能读到', async () => {
    seed([
      {
        ...owned('用户喝咖啡只喝美式', SESSION_A, '我喝咖啡只喝美式', 40, { keywords: ['咖啡', '美式'] }),
        contributions: [
          { sessionId: SESSION_A, sourceQuote: '我喝咖啡只喝美式', createdAt: at(-40) },
          { sessionId: SESSION_B, sourceQuote: '咖啡我只喝美式', createdAt: at(-15) },
        ],
      },
      owned('用户喝咖啡只喝拿铁', SESSION_B, '我喝咖啡只喝拿铁', 35, { keywords: ['咖啡', '拿铁'] }),
    ]);

    const result = await memory.recallMemoryBySourceQuote(
      '我喝咖啡只喝美式',
      at(-40),
      SESSION_A
    );

    assert.deepEqual(result, { removedEntries: 0, removedContributions: 1 }, '摘贡献不等于删条目');

    const survivor = memory.getMemories().find(item => item.content === '用户喝咖啡只喝美式');

    assert.ok(survivor, '还有 B 的贡献撑着，整条不能删');
    assert.deepEqual(survivor.contributions.map(item => item.sessionId), [SESSION_B]);

    const bView = await allThreePaths(COFFEE_QUERY, SESSION_B);

    assert.deepEqual(bView.scoped.sort(), ['用户喝咖啡只喝拿铁', '用户喝咖啡只喝美式'].sort());
    // A 把自己那条贡献摘空后，这条对 A 只剩「别人的记忆」：
    // 既不能继续显示，也不能因此回退去看 B 专属的拿铁。
    assert.deepEqual((await allThreePaths(COFFEE_QUERY, SESSION_A)).scoped, []);
  });

  test('按会话清理：A 的贡献全部消失，B 独有的条目一条不少', async () => {
    seed(twoSessionsStore());

    const result = await memory.clearSessionMemories(SESSION_A);

    assert.equal(result.reason, 'ok');
    assert.equal(result.removedEntries, 2, 'A 独有的两条（美式 + Vim）整条删除');
    assert.equal(result.removedContributions, 2);
    assert.equal(result.remaining, 3, 'B 的两条 + 一条无归属旧数据必须留下');

    const disk = readDisk();

    assert.equal(disk.some(item => item.content === '用户喝咖啡只喝美式'), false);
    assert.equal(disk.some(item => item.content === '用户常用编辑器是 Vim'), false);

    for (const item of disk) {
      for (const contribution of item.contributions || []) {
        assert.notEqual(contribution.sessionId, SESSION_A, '库里不能再有 A 名下的贡献');
      }
    }

    const bView = await allThreePaths(COFFEE_QUERY, SESSION_B);

    assert.deepEqual(bView.scoped, ['用户喝咖啡只喝拿铁'], 'B 的记忆不能因为清理 A 而丢失');
    assert.equal(memory.verifyStoreConsistency().consistent, true);

    // 清理后 A 变成"没有自己记忆"的会话 → 只回退到无归属旧数据
    const after = await allThreePaths(CITY_QUERY, SESSION_A);

    assert.deepEqual(after.injected, ['用户住在杭州']);
    assert.deepEqual(after.scoped, ['用户住在杭州']);
    assert.deepEqual(after.engine, ['用户住在杭州']);
    assert.deepEqual((await allThreePaths(COFFEE_QUERY, SESSION_A)).scoped, [], '回退也不该把 B 的咖啡记忆补给 A');
  });

  test('清理不存在的会话 → no-match，库一个字节都不动', async () => {
    seed(twoSessionsStore());

    const diskBefore = fs.readFileSync(MEMORY_FILE, 'utf8');
    const result = await memory.clearSessionMemories('s-没有这个会话');

    assert.equal(result.reason, 'no-match');
    assert.deepEqual(
      { removedEntries: result.removedEntries, removedContributions: result.removedContributions, remaining: result.remaining },
      { removedEntries: 0, removedContributions: 0, remaining: 5 }
    );
    assert.equal(fs.readFileSync(MEMORY_FILE, 'utf8'), diskBefore);
  });

  test('空 sessionId 的清理一律拒绝（否则等于全库清空）', async () => {
    seed(twoSessionsStore());

    for (const bad of [null, undefined, '', '   ']) {
      const result = await memory.clearSessionMemories(bad);

      assert.equal(result.reason, 'invalid', `bad=${JSON.stringify(bad)}`);
    }

    assert.equal(memory.getMemories({ includeSuperseded: true }).length, 5, '拒绝后库必须原样保留');
  });

  test('清空整库是全库动作，removedEntries 给真实条数（回 0 会骗调用方）', async () => {
    seed(twoSessionsStore());

    const result = await memory.clearMemories();

    assert.deepEqual(result, { removedEntries: 5, cleared: true });
    assert.deepEqual(readDisk(), []);
    assert.equal(memory.verifyStoreConsistency().consistent, true);
  });
});
