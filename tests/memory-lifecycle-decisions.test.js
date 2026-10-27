/**
 * 第二轮：写入决策与生命周期（直接调用 memory 服务，不启动 HTTP）
 *
 * 覆盖六类决策、pending/archived/有效时间、历史查询、messageId 精确撤回。
 * 运行：node tests/memory-lifecycle-decisions.test.js
 */
const { test, describe, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'bluebird-lifecycle-'));
process.env.BLUEBIRD_DATA_DIR = TMP;

const MEMORY_FILE = path.join(TMP, 'memory.json');
const memory = require(path.join(__dirname, '..', 'server', 'memory.js'));

const OLD = '2026-10-20T08:00:00.000Z';
const MID = '2026-10-21T08:00:00.000Z';

function seed(items) {
  fs.writeFileSync(MEMORY_FILE, JSON.stringify(items, null, 2), 'utf8');
  memory.loadMemories();
}

function base(overrides = {}) {
  return {
    content: '用户喜欢喝美式咖啡',
    type: 'preference',
    keywords: ['咖啡', '美式'],
    confidence: 0.95,
    sourceQuote: '我喜欢喝美式咖啡',
    sessionId: 's-decision',
    createdAt: OLD,
    updatedAt: OLD,
    ...overrides,
  };
}

const USER = {
  sessionId: 's-decision',
  sourceType: 'user',
  actor: 'test',
  requireUserGrounding: false,
};

beforeEach(() => seed([]));

describe('写入决策六类', { concurrency: 1 }, () => {
  test('create：新事实创建 active，并记录决策信息', async () => {
    const result = await memory.applyCandidate(
      {
        content: '用户养了一只猫',
        type: 'fact',
        keywords: ['猫'],
        confidence: 0.95,
        sourceQuote: '我养了一只猫',
      },
      USER
    );

    assert.equal(result.decision, 'create');
    assert.equal(result.written, true);
    assert.equal(result.status, 'active');
    const saved = memory.getMemories().find(item => item.id === result.id);
    assert.ok(saved);
    assert.equal(saved.lastDecision.action, 'create');
    assert.equal(saved.contributions[0].sourceType, 'user');
  });

  test('merge：同一事实重复提交不新增，贡献合并', async () => {
    const first = await memory.applyCandidate(
      base(),
      USER
    );
    const second = await memory.applyCandidate(
      {
        content: '用户喜欢喝美式咖啡',
        type: 'preference',
        keywords: ['咖啡', '美式'],
        confidence: 0.93,
        sourceQuote: '我喝美式',
        sessionId: 's-second',
      },
      {
        sessionId: 's-second',
        sourceType: 'user',
        actor: 'test',
        requireUserGrounding: false,
      }
    );

    assert.equal(second.decision, 'merge');
    assert.equal(second.id, first.id);
    assert.equal(memory.getMemories().length, 1);

    const saved = memory.getMemories()[0];
    assert.deepEqual(
      saved.contributions.map(item => item.sessionId).sort(),
      ['s-decision', 's-second']
    );
  });

  test('不同事件时间或条件不合并', async () => {
    await memory.applyCandidate(
      {
        content: '用户在周三开会',
        type: 'fact',
        keywords: ['开会'],
        confidence: 0.95,
        sourceQuote: '我周三开会',
        eventAt: '2026-10-20T09:00:00.000Z',
      },
      USER
    );

    const otherTime = await memory.applyCandidate(
      {
        content: '用户在周三开会',
        type: 'fact',
        keywords: ['开会'],
        confidence: 0.95,
        sourceQuote: '我周三开会',
        eventAt: '2026-10-21T09:00:00.000Z',
      },
      USER
    );

    assert.equal(otherTime.decision, 'create');
    assert.equal(memory.getMemories().length, 2);
  });

  test('update：显式 targetId 更新内容但保留身份', async () => {
    const created = await memory.applyCandidate(
      base(),
      USER
    );
    const updated = await memory.applyCandidate(
      {
        content: '用户喜欢喝美式咖啡，不加糖',
        type: 'preference',
        keywords: ['咖啡', '美式', '不加糖'],
        confidence: 0.96,
        sourceQuote: '我喜欢喝美式不加糖',
        targetId: created.id,
      },
      { ...USER, intent: 'correction' }
    );

    assert.equal(updated.decision, 'update');
    assert.equal(updated.id, created.id);
    const saved = memory.getMemories().find(item => item.id === created.id);
    assert.equal(saved.content, '用户喜欢喝美式咖啡，不加糖');
    assert.equal(saved.contributions.length, 2);
  });

  test('supersede：冲突事实保留旧记录并建立关联', async () => {
    const old = await memory.applyCandidate(
      base(),
      USER
    );
    const next = await memory.applyCandidate(
      {
        content: '用户喜欢喝拿铁咖啡',
        type: 'preference',
        keywords: ['咖啡', '拿铁'],
        confidence: 0.95,
        sourceQuote: '我喜欢喝拿铁咖啡',
      },
      USER
    );

    assert.equal(next.decision, 'supersede');
    assert.equal(next.supersededId, old.id);
    const all = memory.getMemories({ includeSuperseded: true });
    const archived = all.find(item => item.id === old.id);
    assert.equal(archived.status, 'superseded');
    assert.equal(archived.supersededBy, next.id);
    assert.ok(archived.validTo);
    assert.equal(memory.getMemories().some(item => item.id === old.id), false);
  });

  test('reject：临时状态不会写入长期偏好', async () => {
    const result = await memory.applyCandidate(
      {
        content: '用户今天心情不好',
        type: 'preference',
        keywords: ['心情'],
        confidence: 0.95,
        sourceQuote: '我今天心情不好',
      },
      USER
    );

    assert.equal(result.decision, 'reject');
    assert.equal(result.reason, 'temporary_state');
    assert.equal(memory.getMemories().length, 0);
  });

  test('needs_confirmation：agent 低置信候选进入 pending，确认后才生效', async () => {
    const result = await memory.applyCandidate(
      {
        content: '用户常用编辑器是 Vim',
        type: 'preference',
        keywords: ['编辑器', 'Vim'],
        confidence: 0.7,
        sourceQuote: '我用 Vim 写代码',
      },
      {
        sessionId: 's-decision',
        sourceType: 'agent',
        actor: 'test',
        requireUserGrounding: true,
        userText: '我用 Vim 写代码',
      }
    );

    assert.equal(result.decision, 'needs_confirmation');
    assert.equal(result.status, 'pending');
    assert.equal(memory.getMemories().length, 0);
    assert.equal(memory.getPendingMemories().length, 1);
    assert.equal(memory.searchMemories({ query: 'Vim', sessionId: 's-decision' }).results.length, 0);

    const confirmed = await memory.confirmPending(result.id);
    assert.equal(confirmed.updated, 1);
    assert.equal(memory.getMemories().length, 1);
    assert.equal(memory.searchMemories({ query: 'Vim', sessionId: 's-decision' }).results.length, 1);
  });

  test('reject pending：拒绝后不留条目', async () => {
    const result = await memory.applyCandidate(
      {
        content: '用户常用编辑器是 Emacs',
        type: 'preference',
        keywords: ['编辑器', 'Emacs'],
        confidence: 0.7,
        sourceQuote: '我用 Emacs',
      },
      {
        sessionId: 's-decision',
        sourceType: 'agent',
        actor: 'test',
        requireUserGrounding: true,
        userText: '我用 Emacs',
      }
    );

    const rejected = await memory.rejectPending(result.id);
    assert.equal(rejected.removed, 1);
    assert.equal(memory.getPendingMemories().length, 0);
    assert.equal(memory.getMemories().length, 0);
  });

  test('待确认的更新在确认后落到原目标，不新增重复条目', async () => {
    const target = await memory.applyCandidate(
      base(),
      USER
    );
    const pending = await memory.applyCandidate(
      {
        content: '用户喜欢喝美式咖啡，只喝热的',
        type: 'preference',
        keywords: ['咖啡', '美式'],
        confidence: 0.7,
        sourceQuote: '我只喝热美式',
        targetId: target.id,
      },
      {
        sessionId: 's-decision',
        sourceType: 'agent',
        actor: 'test',
        requireUserGrounding: true,
        userText: '我只喝热美式',
      }
    );

    assert.equal(pending.decision, 'needs_confirmation');
    assert.equal(memory.getMemories().length, 1);

    const confirmed = await memory.confirmPending(pending.id);
    assert.equal(confirmed.updated, 1);
    assert.equal(confirmed.id, target.id);
    assert.equal(memory.getMemories().length, 1);
    assert.equal(
      memory.getMemories()[0].content,
      '用户喜欢喝美式咖啡，只喝热的'
    );
  });
});

describe('生命周期与历史查询', { concurrency: 1 }, () => {
  test('有效时间：过期条目不进入当前视图，历史查询仍可读取', () => {
    seed([
      base({
        content: '用户住在杭州',
        type: 'fact',
        keywords: ['杭州'],
        sourceQuote: '我住在杭州',
        createdAt: OLD,
        validFrom: OLD,
        validTo: MID,
      }),
    ]);

    assert.equal(memory.getMemories().length, 0);
    assert.equal(memory.searchMemories({ query: '杭州', sessionId: 's-decision' }).results.length, 0);
    const history = memory.searchMemories({
      query: '杭州',
      sessionId: 's-decision',
      mode: 'history',
      asOf: '2026-10-21T00:00:00.000Z',
    });
    assert.equal(history.results.length, 1);
    assert.equal(history.results[0].content, '用户住在杭州');
  });

  test('工具 history 模式要求显式 asOf', async () => {
    const { definition } = require(path.join(
      __dirname,
      '..',
      'server',
      'tool-memory-search.js'
    ));

    assert.equal(
      definition.validate({ query: '杭州', mode: 'history' }).ok,
      false
    );

    seed([
      base({
        content: '用户住在杭州',
        type: 'fact',
        keywords: ['杭州'],
        sourceQuote: '我住在杭州',
        createdAt: OLD,
        validFrom: OLD,
        validTo: MID,
      }),
    ]);

    const result = await definition.handler(
      {
        query: '杭州',
        limit: 5,
        mode: 'history',
        asOf: '2026-10-21T00:00:00.000Z',
      },
      { sessionId: 's-decision' }
    );

    assert.equal(result.mode, 'history');
    assert.equal(result.results.length, 1);
  });

  test('进程重启后 pending/archived 状态保持不变', () => {
    seed([
      base({
        id: 'mem-pending-restart',
        content: '待确认的候选',
        status: 'pending',
        pendingReason: 'ambiguous',
        sourceQuote: '待确认的候选',
      }),
      base({
        id: 'mem-archived-restart',
        content: '已归档的事实',
        status: 'archived',
        validTo: MID,
        sourceQuote: '已归档的事实',
      }),
    ]);

    const pending = memory.getPendingMemories();
    assert.equal(pending.length, 1);
    assert.equal(pending[0].id, 'mem-pending-restart');
    assert.equal(memory.getMemories().length, 0);
    assert.equal(
      memory
        .getMemories({ includeSuperseded: true })
        .find(item => item.id === 'mem-archived-restart').status,
      'archived'
    );
  });

  test('archive：归档后默认不可见，历史语境可读取', async () => {
    seed([
      base({
        content: '用户喜欢吃辣',
        type: 'preference',
        keywords: ['吃辣'],
        sourceQuote: '我喜欢吃辣',
        createdAt: OLD,
        validFrom: OLD,
      }),
    ]);

    const id = memory.getMemories()[0].id;
    const archived = await memory.archiveMemory(id);

    assert.equal(archived.updated, 1);
    assert.equal(memory.getMemories().length, 0);
    assert.equal(memory.getMemories({ includeSuperseded: true })[0].status, 'archived');

    const history = memory.searchMemories({
      query: '吃辣',
      sessionId: 's-decision',
      mode: 'history',
      asOf: '2026-10-21T00:00:00.000Z',
    });
    assert.equal(history.results.length, 1);
  });

  test('来源撤回：messageId 精确摘除，同文不同消息保留', async () => {
    seed([
      base({
        contributions: [
          {
            sessionId: 's-decision',
            sourceQuote: '我喜欢喝美式咖啡',
            messageId: 'm-1',
            createdAt: OLD,
          },
          {
            sessionId: 's-decision',
            sourceQuote: '我喜欢喝美式咖啡',
            messageId: 'm-2',
            createdAt: OLD,
          },
        ],
      }),
    ]);

    const result = await memory.recallMemoryBySourceQuote(
      '我喜欢喝美式咖啡',
      OLD,
      's-decision',
      'm-1'
    );

    assert.equal(result.removedContributions, 1);
    assert.equal(result.removedEntries, 0);
    const saved = memory.getMemories()[0];
    assert.deepEqual(saved.contributions.map(item => item.messageId), ['m-2']);
  });

  test('自动提取把来源 messageId 写入贡献', async () => {
    const client = {
      chat: {
        completions: {
          create: async () => ({
            choices: [
              {
                message: {
                  content: JSON.stringify({
                    content: '用户的车牌号是京A12345',
                    type: 'fact',
                    keywords: ['车牌'],
                    confidence: 0.95,
                    sourceQuote: '我的车牌是京A12345',
                  }),
                },
              },
            ],
          }),
        },
      },
    };

    const result = await memory.processMemory(
      client,
      '记住：我的车牌是京A12345',
      's-decision',
      { messageId: 'm-auto' }
    );

    assert.equal(result.written, true);
    const saved = memory.getMemories().find(item => item.id === result.id);
    assert.equal(saved.contributions[0].messageId, 'm-auto');
  });

  test('跨会话目标更新被拒绝', async () => {
    seed([
      base({
        content: '另一会话的私有事实',
        sourceQuote: '另一会话的私有事实',
        sessionId: 's-other',
      }),
    ]);
    const target = memory.getMemories()[0];

    const result = await memory.applyCandidate(
      {
        content: '试图跨会话更新',
        type: 'preference',
        keywords: ['更新'],
        confidence: 0.95,
        sourceQuote: '试图跨会话更新',
        targetId: target.id,
      },
      { sessionId: 's-decision', sourceType: 'user', actor: 'test', requireUserGrounding: false }
    );

    assert.equal(result.decision, 'reject');
    assert.equal(result.reason, 'unauthorized_target');
  });
});