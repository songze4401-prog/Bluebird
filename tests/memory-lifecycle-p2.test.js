/**
 * P2 生命周期治理验收
 *
 * 覆盖：contested、reinforcement、supersede/withdraw、墓碑字段、
 * 并发写入、撤回、删除后重启、异步竞态、非法迁移、未知状态与过期。
 *
 * 运行：node tests/memory-lifecycle-p2.test.js
 */
const { test, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'bluebird-p2-lifecycle-'));
process.env.BLUEBIRD_DATA_DIR = TMP;
process.env.BLUEBIRD_USER_ID = 'local-owner';
process.env.BLUEBIRD_MEMORY_EVIDENCE_POLICY = 'compat';
process.env.DEEPSEEK_API_KEY = '';

const MEMORY_FILE = path.join(TMP, 'memory.json');
const TOMBSTONE_FILE = path.join(TMP, 'memory-tombstones.json');
const memory = require(path.join(__dirname, '..', 'server', 'memory.js'));
const retrieval = require(path.join(__dirname, '..', 'server', 'retrieval'));
const {
  STATUS_ACTIVE,
  STATUS_PENDING,
  STATUS_CONTESTED,
  STATUS_ARCHIVED,
  canTransition,
  classifyIneffective,
} = require(path.join(__dirname, '..', 'server', 'memory-lifecycle'));

const OWNER = 'local-owner';
const OLD = '2026-10-20T08:00:00.000Z';

function seed(items) {
  fs.writeFileSync(MEMORY_FILE, JSON.stringify(items, null, 2), 'utf8');
  memory.loadMemories();
}

function entry(overrides = {}) {
  return {
    type: 'fact',
    keywords: ['测试'],
    confidence: 0.95,
    status: STATUS_ACTIVE,
    userId: OWNER,
    createdAt: OLD,
    updatedAt: OLD,
    ...overrides,
  };
}

function options(sessionId, userText, extra = {}) {
  return {
    sessionId,
    userId: OWNER,
    sourceType: 'user',
    actor: 'test',
    userText,
    requireUserGrounding: false,
    ...extra,
  };
}

function allMemories() {
  return memory.getMemories({
    includePending: true,
    includeArchived: true,
    includeSuperseded: true,
    includeContested: true,
  });
}

function search(query, sessionId = 's-search') {
  return memory.searchMemories({
    query,
    sessionId,
    userId: OWNER,
    limits: { maxItems: 10 },
  });
}

beforeEach(() => seed([]));

test('contested：多冲突条目转 contested，候选进 pending', async () => {
  seed([
    entry({
      id: 'mem-a',
      content: '用户喜欢在周末游泳',
      type: 'preference',
      keywords: ['周末', '游泳'],
      contributions: [
        { sessionId: 's-a', sourceQuote: '我喜欢在周末游泳', createdAt: OLD },
      ],
    }),
    entry({
      id: 'mem-b',
      content: '用户喜欢在周末骑车',
      type: 'preference',
      keywords: ['周末', '骑车'],
      contributions: [
        { sessionId: 's-b', sourceQuote: '我喜欢在周末骑车', createdAt: OLD },
      ],
    }),
  ]);

  const result = await memory.applyCandidate(
    {
      content: '用户喜欢在周末跑步',
      type: 'preference',
      keywords: ['周末', '跑步'],
      confidence: 0.95,
      sourceQuote: '我喜欢在周末跑步',
    },
    options('s-x', '我喜欢在周末跑步', { messageId: 'm-p2-conflict' })
  );

  assert.equal(result.decision, 'needs_confirmation');
  assert.equal(result.reason, 'ambiguous_conflict');
  assert.equal(result.status, STATUS_PENDING);
  assert.equal(memory.getMemories().length, 0);

  const items = allMemories();
  for (const id of ['mem-a', 'mem-b']) {
    const item = items.find(candidate => candidate.id === id);
    assert.equal(item.status, STATUS_CONTESTED);
    assert.ok(item.contestedAt);
    assert.equal(item.lastDecision.action, 'contest');
  }
  assert.equal(search('用户喜欢在周末跑步').results.length, 0);
  assert.equal(canTransition(STATUS_CONTESTED, STATUS_ARCHIVED), true);
  assert.equal(canTransition(STATUS_ARCHIVED, STATUS_ACTIVE), false);
});

test('contested：确认冲突候选后归档旧 contested 条目', async () => {
  seed([
    entry({
      id: 'mem-a',
      content: '用户喜欢在周末游泳',
      type: 'preference',
      keywords: ['周末', '游泳'],
      contributions: [
        { sessionId: 's-a', sourceQuote: '我喜欢在周末游泳', createdAt: OLD },
      ],
    }),
    entry({
      id: 'mem-b',
      content: '用户喜欢在周末骑车',
      type: 'preference',
      keywords: ['周末', '骑车'],
      contributions: [
        { sessionId: 's-b', sourceQuote: '我喜欢在周末骑车', createdAt: OLD },
      ],
    }),
  ]);

  const pending = await memory.applyCandidate(
    {
      content: '用户喜欢在周末跑步',
      type: 'preference',
      keywords: ['周末', '跑步'],
      confidence: 0.95,
      sourceQuote: '我喜欢在周末跑步',
    },
    options('s-x', '我喜欢在周末跑步', { messageId: 'm-p2-confirm' })
  );

  const confirmed = await memory.confirmPending(pending.id, OWNER);
  assert.equal(confirmed.updated, 1);

  const items = allMemories();
  const active = items.find(item => item.status === STATUS_ACTIVE);
  assert.equal(active.content, '用户喜欢在周末跑步');

  for (const id of ['mem-a', 'mem-b']) {
    const item = items.find(candidate => candidate.id === id);
    assert.equal(item.status, STATUS_ARCHIVED);
    assert.equal(item.archivedReason, 'contested_replaced_by_confirmation');
  }

  assert.ok(search('用户喜欢在周末跑步').results.length >= 1);
});

test('reinforce：独立会话追加证据', async () => {
  await memory.applyCandidate(
    {
      content: '用户养了一只猫',
      type: 'fact',
      keywords: ['猫'],
      confidence: 0.95,
      sourceQuote: '我养了一只猫',
    },
    options('s-a', '我养了一只猫', { messageId: 'm-p2-r1' })
  );
  const second = await memory.applyCandidate(
    {
      content: '用户养了一只猫',
      type: 'fact',
      keywords: ['猫'],
      confidence: 0.95,
      sourceQuote: '我也养了一只猫',
    },
    options('s-b', '我也养了一只猫', { messageId: 'm-p2-r2' })
  );

  assert.equal(second.written, true);
  const saved = memory.getMemories()[0];
  assert.equal(saved.evidence.independentSessions, 2);
  assert.equal(saved.evidence.promotion, 'independent_support');
  assert.equal(saved.lastDecision.action, 'reinforce');
  assert.deepEqual(
    saved.contributions.map(item => item.sessionId).sort(),
    ['s-a', 's-b']
  );
});

test('withdraw：部分/全部撤回、墓碑与重新写入', async () => {
  await memory.applyCandidate(
    {
      content: '用户喜欢晨跑',
      type: 'fact',
      keywords: ['晨跑'],
      confidence: 0.95,
      sourceQuote: '我喜欢晨跑',
    },
    options('s-a', '我喜欢晨跑', { messageId: 'm-p2-w1' })
  );
  await memory.applyCandidate(
    {
      content: '用户喜欢晨跑',
      type: 'fact',
      keywords: ['晨跑'],
      confidence: 0.95,
      sourceQuote: '我也喜欢晨跑',
    },
    options('s-b', '我也喜欢晨跑', { messageId: 'm-p2-w2' })
  );

  const id = memory.getMemories()[0].id;
  const partial = await memory.withdrawMemory({ id, sessionId: 's-a' });
  assert.equal(partial.status, STATUS_ACTIVE);

  let saved = allMemories().find(item => item.id === id);
  assert.equal(saved.status, STATUS_ACTIVE);
  assert.equal(saved.contributions.length, 1);
  assert.ok(saved.lastWithdrawalAt);

  const full = await memory.withdrawMemory({ id, sessionId: 's-b' });
  assert.equal(full.status, STATUS_ARCHIVED);
  assert.equal(full.archived, true);

  saved = allMemories().find(item => item.id === id);
  assert.equal(saved.status, STATUS_ARCHIVED);
  assert.equal(saved.contributions.length, 0);
  assert.ok(saved.withdrawnAt);
  assert.equal(classifyIneffective(saved), 'withdrawn');

  const retry = await memory.applyCandidate(
    {
      content: '用户喜欢晨跑',
      type: 'fact',
      keywords: ['晨跑'],
      confidence: 0.95,
      sourceQuote: '我也喜欢晨跑',
    },
    options('s-b', '我也喜欢晨跑', { messageId: 'm-p2-w2' })
  );
  assert.equal(retry.written, false);
  assert.equal(retry.reason, 'deleted_source');

  const reAdded = await memory.applyCandidate(
    {
      content: '用户喜欢晨跑',
      type: 'fact',
      keywords: ['晨跑'],
      confidence: 0.95,
      sourceQuote: '我最近又开始晨跑了',
    },
    options('s-c', '我最近又开始晨跑了', { messageId: 'm-p2-w3' })
  );
  assert.equal(reAdded.written, true);

  const tombstones = JSON.parse(fs.readFileSync(TOMBSTONE_FILE, 'utf8'));
  const tombstone = tombstones.find(item =>
    item.sources.some(source => source.messageId === 'm-p2-w2')
  );
  assert.ok(tombstone);
  assert.equal(tombstone.tombstoneVersion, 1);
  assert.equal(tombstone.scope.userId, OWNER);
  assert.ok(tombstone.idempotencyKey);
});

test('delete restart：墓碑加载后仍阻止同源复活', async () => {
  const created = await memory.applyCandidate(
    {
      content: '用户删除后不得复活',
      type: 'fact',
      keywords: ['删除', '墓碑'],
      confidence: 0.95,
      sourceQuote: '删除后不得复活',
    },
    options('s-del', '删除后不得复活', { messageId: 'm-p2-delete' })
  );

  const deleted = await memory.deleteMemory({ id: created.id, userId: OWNER });
  assert.equal(deleted.removed, 1);

  memory.loadMemories();

  const retry = await memory.applyCandidate(
    {
      content: '用户删除后不得复活',
      type: 'fact',
      keywords: ['删除', '墓碑'],
      confidence: 0.95,
      sourceQuote: '删除后不得复活',
    },
    options('s-del', '删除后不得复活', { messageId: 'm-p2-delete' })
  );

  assert.equal(retry.written, false);
  assert.equal(retry.reason, 'deleted_source');
  assert.equal(memory.getMemories().length, 0);
});

test('异步竞态：删除先于抽取 / 抽取先于删除', async () => {
  const created = await memory.applyCandidate(
    {
      content: '用户竞态事实',
      type: 'fact',
      keywords: ['竞态'],
      confidence: 0.95,
      sourceQuote: '我记住了竞态事实',
    },
    options('s-race', '我记住了竞态事实', { messageId: 'm-p2-race-a' })
  );

  const [, lateExtraction] = await Promise.all([
    memory.deleteMemory({ id: created.id, userId: OWNER }),
    memory.applyCandidate(
      {
        content: '用户竞态事实',
        type: 'fact',
        keywords: ['竞态'],
        confidence: 0.95,
        sourceQuote: '我记住了竞态事实',
      },
      options('s-race', '我记住了竞态事实', { messageId: 'm-p2-race-a' })
    ),
  ]);

  assert.equal(lateExtraction.written, false);
  assert.equal(lateExtraction.reason, 'deleted_source');
  assert.equal(memory.getMemories().length, 0);

  const second = await memory.applyCandidate(
    {
      content: '用户第二个竞态事实',
      type: 'fact',
      keywords: ['竞态'],
      confidence: 0.95,
      sourceQuote: '我记住了第二个竞态事实',
    },
    options('s-race', '我记住了第二个竞态事实', { messageId: 'm-p2-race-b' })
  );

  const [merged] = await Promise.all([
    memory.applyCandidate(
      {
        content: '用户第二个竞态事实',
        type: 'fact',
        keywords: ['竞态'],
        confidence: 0.95,
        sourceQuote: '我也记住了第二个竞态事实',
      },
      options('s-race-2', '我也记住了第二个竞态事实', {
        messageId: 'm-p2-race-b2',
      })
    ),
    memory.deleteMemory({ id: second.id, userId: OWNER }),
  ]);

  assert.equal(merged.written, true);
  assert.equal(memory.getMemories().length, 0);
});

test('并发写入：独立事实不丢失', async () => {
  const results = await Promise.all(
    Array.from({ length: 8 }, (_, index) =>
      memory.applyCandidate(
        {
          content: `用户并发事实 ${index}`,
          type: 'fact',
          keywords: [`并发${index}`],
          confidence: 0.95,
          sourceQuote: `我并发事实 ${index}`,
        },
        options(`s-c${index}`, `我并发事实 ${index}`, {
          messageId: `m-p2-c${index}`,
        })
      )
    )
  );

  assert.equal(results.every(result => result.written === true), true);
  assert.equal(memory.getMemories().length, 8);
});

test('并发写入：同一事实的独立贡献不丢失', async () => {
  const results = await Promise.all(
    Array.from({ length: 5 }, (_, index) =>
      memory.applyCandidate(
        {
          content: '用户喜欢周末跑步',
          type: 'fact',
          keywords: ['周末', '跑步'],
          confidence: 0.95,
          sourceQuote: '我喜欢周末跑步',
        },
        options(`s-same${index}`, '我喜欢周末跑步', {
          messageId: `m-p2-same${index}`,
        })
      )
    )
  );

  assert.equal(results.filter(result => result.written === true).length >= 1, true);

  const items = memory.getMemories();
  assert.equal(items.length, 1);
  assert.equal(items[0].contributions.length, 5);
  assert.equal(items[0].evidence.independentSessions, 5);
  assert.equal(items[0].lastDecision.action, 'reinforce');
});

test('非法迁移：archived 不能再 archive/withdraw/supersede', async () => {
  seed([
    entry({
      id: 'mem-archived',
      content: '用户已归档记忆',
      keywords: ['归档'],
      status: STATUS_ARCHIVED,
      contributions: [
        { sessionId: 's-a', sourceQuote: '已归档记忆', createdAt: OLD },
      ],
    }),
  ]);

  assert.equal(
    (await memory.archiveMemory('mem-archived', OWNER)).reason,
    'invalid-state'
  );
  assert.equal(
    (await memory.withdrawMemory({ id: 'mem-archived', sessionId: 's-a' }))
      .reason,
    'invalid-state'
  );
  assert.equal(
    (await memory.supersedeMemory({
      id: 'mem-archived',
      replacement: { content: '用户新记忆', type: 'fact' },
    })).reason,
    'invalid-state'
  );

  assert.equal(allMemories()[0].status, STATUS_ARCHIVED);
  assert.equal(canTransition(STATUS_ARCHIVED, STATUS_ACTIVE), false);
});

test('未知状态：不当作 active，也不静默删除', async () => {
  seed([
    entry({
      id: 'mem-mystery',
      content: '用户未知状态记忆',
      keywords: ['未知'],
      status: 'mystery',
      contributions: [
        { sessionId: 's-a', sourceQuote: '未知状态记忆', createdAt: OLD },
      ],
    }),
  ]);

  assert.equal(memory.getMemories().length, 0);
  assert.equal(search('用户未知状态记忆').results.length, 0);

  memory.loadMemories();
  const items = allMemories();
  assert.equal(items.length, 1);
  assert.equal(items[0].status, 'mystery');

  const removed = await memory.deleteMemory({
    id: 'mem-mystery',
    userId: OWNER,
  });
  assert.equal(removed.removed, 1);
});

test('过期：validTo 过期不注入', async () => {
  seed([
    entry({
      id: 'mem-expired',
      content: '用户已经过期的计划',
      keywords: ['过期'],
      validTo: '2020-01-01T00:00:00.000Z',
      contributions: [
        { sessionId: 's-a', sourceQuote: '过期计划', createdAt: OLD },
      ],
    }),
  ]);

  assert.equal(memory.getMemories().length, 0);
  assert.equal(search('用户已经过期的计划').results.length, 0);

  const saved = allMemories().find(item => item.id === 'mem-expired');
  assert.equal(classifyIneffective(saved), 'expired');
});

test('墓碑字段：version/scope/idempotencyKey 且不含正文', async () => {
  const created = await memory.applyCandidate(
    {
      content: '用户墓碑字段事实',
      type: 'fact',
      keywords: ['墓碑'],
      confidence: 0.95,
      sourceQuote: '墓碑字段事实',
    },
    options('s-tomb', '墓碑字段事实', { messageId: 'm-p2-tomb' })
  );

  await memory.deleteMemory({ id: created.id, userId: OWNER });

  const tombstones = JSON.parse(fs.readFileSync(TOMBSTONE_FILE, 'utf8'));
  const tombstone = tombstones.find(item => item.entryId === created.id);

  assert.ok(tombstone);
  assert.equal(tombstone.tombstoneVersion, 1);
  assert.equal(tombstone.scope.userId, OWNER);
  assert.deepEqual(tombstone.scope.sessionIds, ['s-tomb']);
  assert.equal(typeof tombstone.idempotencyKey, 'string');
  assert.ok(tombstone.deletedAt);
  assert.equal(tombstone.sources[0].messageId, 'm-p2-tomb');

  const text = JSON.stringify(tombstone);
  assert.equal(text.includes('用户墓碑字段事实'), false);
  assert.equal(text.includes('墓碑字段事实'), false);
});

test('删除后派生索引不再返回旧事实', async () => {
  const created = await memory.applyCandidate(
    {
      content: '用户删除索引事实',
      type: 'fact',
      keywords: ['索引', '删除'],
      confidence: 0.95,
      sourceQuote: '删除索引事实',
    },
    options('s-index', '删除索引事实', { messageId: 'm-p2-index' })
  );

  await retrieval.search({
    query: '用户删除索引事实',
    sessionId: 's-index',
    sources: ['memory'],
  });
  assert.ok(retrieval.getSource(`memory:${created.id}`));

  await memory.deleteMemory({ id: created.id, userId: OWNER });
  memory.loadMemories();

  assert.equal(retrieval.getSource(`memory:${created.id}`), null);

  const after = await retrieval.search({
    query: '用户删除索引事实',
    sessionId: 's-index',
    sources: ['memory'],
  });
  assert.equal(
    after.evidence.some(item => String(item.content).includes('用户删除索引事实')),
    false
  );
});
