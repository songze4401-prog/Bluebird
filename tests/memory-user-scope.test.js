/**
 * 云岫 Bluebird — 用户级记忆作用域（P1）
 *
 * 验证「长期记忆读边界从会话上提到用户」这件事本身：
 *   1. 同一用户的另一个会话能召回前一个会话沉淀的记忆（跨会话召回）
 *   2. 不同用户之间严格拒绝，泄漏数为 0（跨用户隔离）
 *   3. 没有可信 userId 时退回会话级隔离，绝不放开成全库可见（fail-closed）
 *   4. 三条读路径（注入渲染 / 工具检索 / 派生索引）作用域结论一致
 *   5. 写侧与读侧同一作用域：同一用户可跨会话更正，跨用户与无身份仍被拒绝，
 *      且更正后不会同时留下两条矛盾记忆
 *
 * 隔离保证：BLUEBIRD_DATA_DIR 指向系统临时目录，不读写 server/data 的真实记忆文件。
 *
 * 运行：node tests/memory-user-scope.test.js
 */
const fs = require('fs');
const os = require('os');
const path = require('path');
const assert = require('node:assert/strict');
const { test } = require('node:test');

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'bluebird-user-scope-'));
process.env.BLUEBIRD_DATA_DIR = TMP;

const memory = require(path.join(__dirname, '..', 'server', 'memory.js'));
const engine = require(path.join(__dirname, '..', 'server', 'retrieval', 'engine.js'));
const {
  collectMemoryChunks,
} = require(path.join(__dirname, '..', 'server', 'retrieval', 'connectors', 'memory.js'));
const { getInstanceUserId } = require(path.join(__dirname, '..', 'server', 'user-scope.js'));

const MEMORY_FILE = path.join(TMP, 'memory.json');
const INSTANCE_USER = getInstanceUserId();
const OTHER_USER = 'user-other-0001';

const SESSION_A = 'sess_A_咖啡';
const SESSION_B = 'sess_B_全新会话';
const QUERY = '我喜欢喝什么咖啡';

function entry({
  content,
  keywords,
  sessionId = null,
  userId = null,
  type = 'preference',
}) {
  const now = new Date().toISOString();

  return {
    content,
    type,
    keywords,
    confidence: 0.9,
    sourceQuote: content,
    ...(sessionId ? { sessionId } : {}),
    ...(userId ? { userId } : {}),
    createdAt: now,
    updatedAt: now,
  };
}

function seed(items) {
  fs.writeFileSync(MEMORY_FILE, JSON.stringify(items, null, 2), 'utf8');
  memory.loadMemories();
}

test('读盘迁移：旧条目没有 userId 时补成实例用户，且不改正文', () => {
  seed([entry({ content: '用户喝咖啡只喝美式', keywords: ['咖啡', '美式'], sessionId: SESSION_A })]);

  const [item] = memory.getMemories();

  assert.equal(item.userId, INSTANCE_USER, '缺失 userId 的旧条目应归到实例用户');
  assert.equal(item.content, '用户喝咖啡只喝美式');
});

test('跨会话召回：同一用户的另一个会话能检索到前一个会话沉淀的记忆', () => {
  seed([entry({ content: '用户喝咖啡只喝美式', keywords: ['咖啡', '美式'], sessionId: SESSION_A })]);

  const found = memory.searchMemories({
    query: QUERY,
    sessionId: SESSION_B,
    userId: INSTANCE_USER,
    limits: { maxItems: 10 },
  });

  assert.equal(found.diagnostics.scopeMode, 'user');
  assert.deepEqual(found.results.map(item => item.content), ['用户喝咖啡只喝美式']);
  assert.equal(found.diagnostics.excluded.session_scope, 0, '用户级作用域下不应有会话级排除');
});

test('跨用户隔离：另一个用户检索同一问题命中 0 条，泄漏数为 0', () => {
  seed([entry({ content: '用户喝咖啡只喝美式', keywords: ['咖啡', '美式'], sessionId: SESSION_A })]);

  const found = memory.searchMemories({
    query: QUERY,
    sessionId: SESSION_B,
    userId: OTHER_USER,
    limits: { maxItems: 10 },
  });

  assert.equal(found.results.length, 0, '不同用户不得读到彼此的记忆');
  assert.equal(found.diagnostics.excluded.session_scope, 1);
  assert.equal(found.reason, 'empty_store');
});

test('fail-closed：没有可信 userId 时退回会话级隔离，不放开全库', () => {
  seed([entry({ content: '用户喝咖啡只喝美式', keywords: ['咖啡', '美式'], sessionId: SESSION_A })]);

  const found = memory.searchMemories({
    query: QUERY,
    sessionId: SESSION_B,
    limits: { maxItems: 10 },
  });

  assert.equal(found.diagnostics.scopeMode, 'session');
  assert.equal(found.results.length, 0, '无身份时不得跨会话串读');
  assert.equal(found.diagnostics.excluded.session_scope, 1);
});

test('用户级作用域下无归属旧数据也可见（同属一个用户）', () => {
  seed([entry({ content: '用户所在城市是杭州', keywords: ['城市', '杭州'] })]);

  const found = memory.searchMemories({
    query: '我在哪个城市',
    userId: INSTANCE_USER,
    limits: { maxItems: 10 },
  });

  assert.deepEqual(found.results.map(item => item.content), ['用户所在城市是杭州']);
});

test('注入渲染路径与检索路径结论一致（同一作用域）', () => {
  seed([entry({ content: '用户喝咖啡只喝美式', keywords: ['咖啡', '美式'], sessionId: SESSION_A })]);

  const injectedSelf = memory.buildMemoryContext(QUERY, {
    mode: 'user',
    userId: INSTANCE_USER,
  });
  const injectedOther = memory.buildMemoryContext(QUERY, {
    mode: 'user',
    userId: OTHER_USER,
  });

  assert.ok(injectedSelf.includes('用户喝咖啡只喝美式'), '同用户应注入自己的记忆');
  assert.equal(injectedOther, '', '不同用户不得注入');
});

test('派生索引：记忆 chunk 的作用域是 visibility=user + 归属用户', () => {
  seed([entry({ content: '用户喝咖啡只喝美式', keywords: ['咖啡', '美式'], sessionId: SESSION_A })]);

  const collected = collectMemoryChunks({ maxChunkChars: 200 });

  assert.equal(collected.sources.length, 1);
  const [chunk] = collected.sources[0].chunks;

  assert.deepEqual(chunk.scope, { visibility: 'user', userId: INSTANCE_USER });
});

test('检索引擎 scopeAllows：用户级 chunk 只对同一 userId 放行', () => {
  const chunk = {
    scope: { visibility: 'user', userId: INSTANCE_USER },
    validFrom: null,
    validTo: null,
  };

  assert.equal(engine.scopeAllows(chunk, { userId: INSTANCE_USER }), true);
  assert.equal(engine.scopeAllows(chunk, { userId: OTHER_USER }), false);
  assert.equal(engine.scopeAllows(chunk, { userId: null }), false, '无身份必须拒绝');
});

test('会话级 chunk 仍按会话隔离（消息历史边界不变）', () => {
  const chunk = {
    scope: { visibility: 'session', sessions: [SESSION_A] },
    validFrom: null,
    validTo: null,
  };

  assert.equal(engine.scopeAllows(chunk, { sessionId: SESSION_A }), true);
  assert.equal(engine.scopeAllows(chunk, { sessionId: SESSION_B }), false);
  assert.equal(
    engine.scopeAllows(chunk, { sessionId: SESSION_B, userId: INSTANCE_USER }),
    false,
    '用户身份不得放大会话边界'
  );
});

test('写侧用户级：新会话里的改口能覆盖同一用户的旧记忆，不留矛盾条目', async () => {
  seed([entry({ content: '用户喝咖啡只喝美式', keywords: ['咖啡', '美式'], sessionId: SESSION_A })]);
  const original = memory.getMemories()[0];

  const result = await memory.applyCandidate(
    {
      content: '用户改喝拿铁',
      type: 'preference',
      keywords: ['咖啡', '拿铁'],
      confidence: 0.95,
      sourceQuote: '我改喝拿铁了',
      targetId: original.id,
    },
    {
      sessionId: SESSION_B,
      userId: INSTANCE_USER,
      userText: '我改喝拿铁了',
      requireUserGrounding: true,
    }
  );

  assert.equal(result.written, true, `更正应落盘：${result.reason}`);
  assert.ok(
    ['updated', 'merged', 'superseded'].includes(result.action),
    `应是更正类动作，实际 ${result.action}`
  );

  const found = memory.searchMemories({
    query: QUERY,
    sessionId: SESSION_B,
    userId: INSTANCE_USER,
    limits: { maxItems: 10 },
  });

  assert.equal(
    found.results.some(item => item.content.includes('只喝美式')),
    false,
    '旧口径不得再被注入（否则同时注入两条矛盾事实）'
  );
  assert.ok(
    found.results.some(item => item.content.includes('拿铁')),
    '新口径应可被召回'
  );
});

test('写侧跨用户拒绝：另一用户不能更正他人记忆', async () => {
  seed([entry({ content: '用户喝咖啡只喝美式', keywords: ['咖啡', '美式'], sessionId: SESSION_A })]);
  const original = memory.getMemories()[0];

  const result = await memory.applyCandidate(
    {
      content: '用户改喝拿铁',
      type: 'preference',
      keywords: ['咖啡'],
      confidence: 0.95,
      sourceQuote: '我改喝拿铁了',
      targetId: original.id,
    },
    {
      sessionId: SESSION_B,
      userId: OTHER_USER,
      userText: '我改喝拿铁了',
      requireUserGrounding: true,
    }
  );

  assert.equal(result.written, false);
  assert.equal(result.reason, 'unauthorized_target');
  assert.equal(memory.getMemories()[0].content, '用户喝咖啡只喝美式', '拒绝时数据不变');
});

test('写侧无身份时保持会话级拒绝（旧行为回归）', async () => {
  seed([entry({ content: '用户喝咖啡只喝美式', keywords: ['咖啡', '美式'], sessionId: SESSION_A })]);
  const original = memory.getMemories()[0];

  const result = await memory.applyCandidate(
    {
      content: '用户改喝拿铁',
      type: 'preference',
      keywords: ['咖啡'],
      confidence: 0.95,
      sourceQuote: '我改喝拿铁了',
      targetId: original.id,
    },
    {
      sessionId: SESSION_B,
      userText: '我改喝拿铁了',
      requireUserGrounding: true,
    }
  );

  assert.equal(result.written, false);
  assert.equal(result.reason, 'unauthorized_target', '没有可信身份时不得跨会话改写');
});

test('写侧跨用户相似内容：不得 merge 到他人条目', async () => {
  seed([
    entry({
      content: '用户喝咖啡只喝美式',
      keywords: ['咖啡', '美式'],
      sessionId: SESSION_A,
      userId: OTHER_USER,
    }),
  ]);
  const [before] = memory.getMemories();

  const result = await memory.applyCandidate(
    {
      content: '用户喝咖啡只喝美式',
      type: 'preference',
      keywords: ['咖啡', '美式'],
      confidence: 0.95,
      sourceQuote: '我喝咖啡只喝美式',
    },
    {
      sessionId: SESSION_B,
      userId: INSTANCE_USER,
      messageId: 'm-cross-user-similar',
      userText: '我喝咖啡只喝美式',
      requireUserGrounding: true,
    }
  );

  assert.equal(result.written, true);
  assert.equal(result.action, 'inserted');
  assert.notEqual(result.id, before.id);

  const items = memory.getMemories();
  const foreign = items.find(item => item.userId === OTHER_USER);
  const own = items.find(item => item.userId === INSTANCE_USER);

  assert.equal(foreign.content, '用户喝咖啡只喝美式', '他人条目不得被改写');
  assert.equal(foreign.contributions.length, 1, '他人条目不得被追加贡献');
  assert.equal(foreign.contributions[0].sessionId, SESSION_A);
  assert.ok(own, '当前用户应得到自己的独立条目');
  assert.equal(own.content, '用户喝咖啡只喝美式');
});

test('写入路径仍按会话登记贡献（更正/撤回语义未改）', () => {
  seed([]);

  return memory
    .processMemory(
      {
        chat: {
          completions: {
            create: async () => ({
              choices: [
                {
                  message: {
                    content: JSON.stringify({
                      content: '用户喝咖啡只喝美式',
                      type: 'preference',
                      keywords: ['咖啡', '美式'],
                      confidence: 0.95,
                      sourceQuote: '我只喝美式',
                    }),
                  },
                },
              ],
            }),
          },
        },
      },
      '记住，我只喝美式',
      SESSION_A
    )
    .then(outcome => {
      assert.equal(outcome.written, true);

      const [item] = memory.getMemories();

      assert.equal(item.userId, INSTANCE_USER, '新写入的条目归属实例用户');
      assert.deepEqual(
        item.contributions.map(c => c.sessionId),
        [SESSION_A],
        '贡献仍登记在发起会话名下'
      );
    });
});
