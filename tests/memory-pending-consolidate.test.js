/**
 * 存量重复 pending 收敛验收（2026-11-21 收尾条 2）。
 *
 * 验证：
 * - 同一 hedged 候选按会话各存一条（「可能：」前缀 + 会话级写入时代的旧库形态）
 *   能被识别成一组；
 * - dry-run 不写盘，分组可复跑且结果稳定（keeper 取最早一条）；
 * - --apply 语义：贡献并进 keeper、重复条目退场、状态仍是 pending、留审计链；
 * - 不同候选 / 已 active / 不同 pendingReason 不被误并；
 * - 收敛幂等：第二次跑不再有分组。
 *
 * 运行：node tests/memory-pending-consolidate.test.js
 */
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'bluebird-pending-consolidate-'));
process.env.BLUEBIRD_DATA_DIR = TMP;
process.env.DEEPSEEK_API_KEY = '';

const MEMORY_FILE = path.join(TMP, 'memory.json');
const memory = require(path.join(__dirname, '..', 'server', 'memory.js'));

function seed(items) {
  fs.writeFileSync(MEMORY_FILE, JSON.stringify(items, null, 2), 'utf8');
  memory.loadMemories();
}

function disk() {
  return JSON.parse(fs.readFileSync(MEMORY_FILE, 'utf8'));
}

function hedgedEntry(id, sessionId, createdAt, overrides = {}) {
  return {
    id,
    status: 'pending',
    content: '可能：用户喜欢喝气泡水',
    type: 'preference',
    keywords: ['气泡水'],
    confidence: 0.95,
    contributions: [
      { sessionId, sourceQuote: '我好像挺喜欢喝气泡水的', createdAt },
    ],
    createdAt,
    updatedAt: createdAt,
    provenance: 'user_asserted',
    category: 'behavior_pattern',
    uncertainty: 'source_hedged',
    // 生产条目落盘时一定带 evidence（stampIdentity 不会补，但写入路径会写）。
    evidence: { repetition: 1, independentSessions: 1, hedged: true },
    userId: 'local-owner',
    pendingReason: 'user_hedged_requires_confirmation',
    pendingAt: createdAt,
    pendingTargetId: null,
    pendingMutation: null,
    ...overrides,
  };
}

test('旧库形态：两个会话各一条 hedged pending 被识别为一组，dry-run 不写盘', async () => {
  const old = [
    hedgedEntry('mem-old-a', 's-main', '2026-11-18T10:00:00.000Z'),
    hedgedEntry('mem-old-b', 's-work', '2026-11-18T11:00:00.000Z'),
  ];

  seed(old);

  const before = fs.readFileSync(MEMORY_FILE, 'utf8');
  const result = await memory.consolidatePendingDuplicates({});

  assert.equal(result.groups.length, 1, '两条同一候选的旧 pending 没被识别成一组');
  assert.equal(result.groups[0].keeperId, 'mem-old-a', 'keeper 不是最早落库的那条');
  assert.deepEqual(result.groups[0].duplicateIds, ['mem-old-b']);
  assert.deepEqual(result.groups[0].sessions, ['s-main', 's-work']);
  assert.equal(result.mergedEntries, 0, 'dry-run 报告了合并数');
  assert.equal(
    fs.readFileSync(MEMORY_FILE, 'utf8'),
    before,
    'dry-run 动了盘：必须默认只读'
  );
});

test('apply：贡献并条、重复条目退场、状态仍是 pending、留审计链', async () => {
  seed([
    hedgedEntry('mem-old-a', 's-main', '2026-11-18T10:00:00.000Z'),
    hedgedEntry('mem-old-b', 's-work', '2026-11-18T11:00:00.000Z'),
  ]);

  const result = await memory.consolidatePendingDuplicates({ apply: true });

  assert.equal(result.mergedEntries, 1);
  assert.equal(result.removedEntries, 1);
  assert.equal(result.remaining, 1, '收敛后没有只留一条');

  const items = disk();

  assert.equal(items.length, 1);
  assert.equal(items[0].id, 'mem-old-a');
  assert.equal(items[0].status, 'pending', '收敛把 hedged 候选改成了别的状态：重复证据不得撬开晋升');
  assert.equal(items[0].pendingReason, 'user_hedged_requires_confirmation');
  assert.deepEqual(
    items[0].contributions.map(item => item.sessionId).sort(),
    ['s-main', 's-work'],
    '两个会话的贡献没有并进 keeper'
  );
  assert.deepEqual(items[0].consolidatedFrom, ['mem-old-b'], '缺 consolidatedFrom 审计链');
  assert.equal(
    items[0].evidence && items[0].evidence.independentSessions,
    2,
    'independentSessions 没跟着并条更新'
  );
  assert.equal(
    memory.getPendingMemories().length,
    1,
    '内存态没跟着落盘结果刷新（pending 视图仍是旧的两条）'
  );
});

test('收敛幂等：第二次跑既没有分组也没有写盘', async () => {
  seed([
    hedgedEntry('mem-old-a', 's-main', '2026-11-18T10:00:00.000Z'),
    hedgedEntry('mem-old-b', 's-work', '2026-11-18T11:00:00.000Z'),
  ]);

  await memory.consolidatePendingDuplicates({ apply: true });

  const afterFirst = fs.readFileSync(MEMORY_FILE, 'utf8');
  const second = await memory.consolidatePendingDuplicates({ apply: true });

  assert.equal(second.groups.length, 0, '收敛不幂等：第二次还识别出重复');
  assert.equal(fs.readFileSync(MEMORY_FILE, 'utf8'), afterFirst);
});

test('不误并：不同候选、已 active、不同 pendingReason 都留在原处', async () => {
  seed([
    hedgedEntry('mem-a', 's-main', '2026-11-18T10:00:00.000Z'),
    hedgedEntry('mem-b', 's-work', '2026-11-18T11:00:00.000Z'),
    hedgedEntry('mem-active', 's-main', '2026-11-18T09:00:00.000Z', {
      status: 'active',
      content: '用户喜欢喝气泡水',
    }),
    hedgedEntry('mem-other', 's-main', '2026-11-18T12:00:00.000Z', {
      content: '可能：用户喜欢喝冷萃咖啡',
      keywords: ['冷萃'],
      contributions: [
        {
          sessionId: 's-main',
          sourceQuote: '我好像挺喜欢喝冷萃咖啡',
          createdAt: '2026-11-18T12:00:00.000Z',
        },
      ],
    }),
    hedgedEntry('mem-inferred', 's-work', '2026-11-18T13:00:00.000Z', {
      pendingReason: 'model_inference_requires_confirmation',
      provenance: 'model_inferred',
      content: '可能：用户喜欢喝气泡水',
    }),
  ]);

  const result = await memory.consolidatePendingDuplicates({ apply: true });
  const ids = disk()
    .map(item => item.id)
    .sort();

  assert.equal(result.groups.length, 1, '分组越界：不该并的条目被并了');
  assert.deepEqual(ids, ['mem-a', 'mem-active', 'mem-inferred', 'mem-other']);
});

test('userId 过滤：只收敛指定用户的条目', async () => {
  seed([
    hedgedEntry('mem-a', 's-main', '2026-11-18T10:00:00.000Z'),
    hedgedEntry('mem-b', 's-work', '2026-11-18T11:00:00.000Z'),
    hedgedEntry('mem-x', 's-main', '2026-11-18T10:30:00.000Z', {
      userId: 'other-user',
      content: '可能：用户喜欢喝气泡水',
      contributions: [
        {
          sessionId: 's-other',
          sourceQuote: '我好像挺喜欢喝气泡水的',
          createdAt: '2026-11-18T10:30:00.000Z',
        },
      ],
    }),
  ]);

  const result = await memory.consolidatePendingDuplicates({
    apply: true,
    userId: 'local-owner',
  });

  assert.equal(result.groups.length, 1);
  assert.deepEqual(
    result.groups[0].duplicateIds,
    ['mem-b'],
    'userId 过滤失效：把别的用户的条目并了进来'
  );
  assert.ok(
    disk().some(item => item.id === 'mem-x'),
    '别的用户的条目被删了'
  );
});
