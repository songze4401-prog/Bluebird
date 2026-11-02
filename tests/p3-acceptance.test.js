/**
 * 云岫 Bluebird — P3 回归验收（架构决策第 7 节验收标准）
 *
 * 把 Notion 架构文档的 10 条验收场景逐条映射成可执行断言：
 *   1 跨会话召回      2 无关问题不注入      3 会话历史隔离     4 跨用户拒绝
 *   5 项目范围（不适用）6 Agent 任务隔离     7 撤回/过期/被替代  8 失败可区分
 *   9 大规模记忆库     10 Trace 与实际发送一致
 *
 * 设计原则：
 * - 只调用生产读路径（searchMemories / retrieveMemory / buildContext / retrieval.search）；
 * - 不适用或已有专项覆盖的，显式 skip 或引用，绝不写成"通过"来凑数；
 * - 数据目录指向临时目录，不碰 server/data。
 *
 * 运行：node tests/p3-acceptance.test.js
 */
const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const assert = require('node:assert/strict');
const { test } = require('node:test');

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'bluebird-p3-'));
process.env.BLUEBIRD_DATA_DIR = TMP;
process.env.MEMORY_ENABLED = 'true';
process.env.BLUEBIRD_RETRIEVAL_ROOTS = TMP;

const memory = require(path.join(__dirname, '..', 'server', 'memory.js'));
const sessions = require(path.join(__dirname, '..', 'server', 'sessions.js'));
const retrieval = require(path.join(__dirname, '..', 'server', 'retrieval'));
const { retrieveMemory } = require(path.join(__dirname, '..', 'server', 'context', 'retriever.js'));
const { buildContext } = require(path.join(__dirname, '..', 'server', 'context', 'builder.js'));
const { config } = require(path.join(__dirname, '..', 'server', 'context', 'config.js'));
const { createTrace } = require(path.join(__dirname, '..', 'server', 'context', 'trace.js'));
const { projectWorkerContext } = require(path.join(__dirname, '..', 'server', 'agents', 'context-projection.js'));
const agentSessions = require(path.join(__dirname, '..', 'server', 'agents', 'sessions.js'));
const { getInstanceUserId } = require(path.join(__dirname, '..', 'server', 'user-scope.js'));

const MEMORY_FILE = path.join(TMP, 'memory.json');
const USER = getInstanceUserId();
const OTHER_USER = 'user-p3-other';
const SESSION_A = 'sess_p3_a';
const SESSION_B = 'sess_p3_b_new';

function iso(minutesAgo) {
  return new Date(Date.now() - minutesAgo * 60 * 1000).toISOString();
}

function entry({
  content,
  keywords,
  sessionId = null,
  status = 'active',
  validFrom = null,
  validTo = null,
  type = 'preference',
  userId = null,
}) {
  return {
    content,
    type,
    keywords,
    confidence: 0.9,
    status,
    sourceQuote: content,
    ...(sessionId ? { sessionId } : {}),
    ...(userId ? { userId } : {}),
    validFrom: validFrom || iso(60),
    validTo: validTo || null,
    createdAt: iso(60),
    updatedAt: iso(60),
  };
}

function seed(items) {
  fs.writeFileSync(MEMORY_FILE, JSON.stringify(items, null, 2), 'utf8');
  memory.loadMemories();
}

async function injectedContents({ query, sessionId, userId }) {
  const retrievalOutcome = await retrieveMemory({ task: query, sessionId, userId, config });
  const built = buildContext({
    recent: [],
    recalled: [],
    summary: null,
    memoryItems: retrievalOutcome.items || [],
    knowledgeItems: [],
    config,
  });

  return {
    contents: built.memory.accepted.map(item => item.content),
    accepted: built.memory.accepted.length,
    skipped: built.memory.skipped.length,
    status: retrievalOutcome.status,
  };
}

// ---------------------------------------------------------------- 1

test('R1 跨会话召回：A 会话写入的记忆，B 会话（全新）能检索并使用', async () => {
  seed([
    entry({
      content: '用户喝咖啡只喝美式',
      keywords: ['咖啡', '美式'],
      sessionId: SESSION_A,
    }),
  ]);

  const result = await injectedContents({
    query: '我喝咖啡有什么习惯',
    sessionId: SESSION_B,
    userId: USER,
  });

  assert.equal(result.status, 'ok');
  assert.ok(
    result.contents.includes('用户喝咖啡只喝美式'),
    `B 会话应当召回 A 会话的记忆，实际注入：${JSON.stringify(result.contents)}`
  );
});

// ---------------------------------------------------------------- 2

test('R2 无关问题不注入无关记忆：注入集合与查询相关', async () => {
  seed([
    entry({ content: '用户喝咖啡只喝美式', keywords: ['咖啡', '美式'], sessionId: SESSION_A }),
    entry({ content: '用户所在城市是杭州', keywords: ['城市', '杭州'], sessionId: SESSION_A }),
    entry({ content: '用户的猫叫豆豆', keywords: ['猫', '豆豆'], sessionId: SESSION_A }),
  ]);

  const coffee = await injectedContents({
    query: '我喝咖啡有什么习惯',
    sessionId: SESSION_B,
    userId: USER,
  });

  assert.ok(coffee.contents.includes('用户喝咖啡只喝美式'));
  assert.ok(
    !coffee.contents.includes('用户所在城市是杭州'),
    '无关的城市记忆不得注入咖啡问题'
  );
  assert.ok(
    !coffee.contents.includes('用户的猫叫豆豆'),
    '无关的宠物记忆不得注入咖啡问题'
  );

  // 换一个完全无关的问题：一条都不该注入
  const unrelated = await injectedContents({
    query: '请帮我写一个快速排序',
    sessionId: SESSION_B,
    userId: USER,
  });

  assert.equal(
    unrelated.contents.length,
    0,
    `无关问题不应注入任何记忆，实际：${JSON.stringify(unrelated.contents)}`
  );
});

// ---------------------------------------------------------------- 3

test('R3 会话历史隔离：B 读不到 A 的原始消息（存储与检索两条路）', async () => {
  const a = sessions.createSession({ title: 'p3-A' });
  const b = sessions.createSession({ title: 'p3-B' });

  sessions.appendMessages(a.id, [
    { role: 'user', content: 'P3-A-SECRET 我在做一份并购方案' },
    { role: 'assistant', content: 'P3-A-SECRET 收到' },
  ]);
  sessions.appendMessages(b.id, [
    { role: 'user', content: 'P3-B 我只关心天气' },
  ]);

  // 路径一：按会话读取消息
  const bMessages = sessions.getMessages(b.id) || [];
  const bText = bMessages.map(message => String(message.content || '')).join('\n');

  assert.ok(!bText.includes('P3-A-SECRET'), 'B 的消息列表不得包含 A 的原文');

  // 路径二：对话检索源（conversation chunk 是 session 级作用域）
  const found = await retrieval.search({
    query: '并购方案',
    sessionId: b.id,
    sources: ['conversation'],
    limit: 5,
  });

  const contents = (found.evidence || []).map(item => String(item.content || ''));
  assert.ok(
    !contents.some(text => text.includes('P3-A-SECRET')),
    `对话检索不得跨会话召回 A 的原文，实际：${JSON.stringify(contents)}`
  );
});

// ---------------------------------------------------------------- 4

test('R4 跨用户严格拒绝：用户乙查询用户甲的记忆，泄漏数为 0', async () => {
  seed([
    entry({ content: '用户喝咖啡只喝美式', keywords: ['咖啡', '美式'], sessionId: SESSION_A }),
    entry({ content: '用户所在城市是杭州', keywords: ['城市', '杭州'], sessionId: SESSION_A }),
  ]);

  const other = await injectedContents({
    query: '我喝咖啡有什么习惯',
    sessionId: SESSION_B,
    userId: OTHER_USER,
  });

  assert.equal(other.contents.length, 0, '不同用户不得注入彼此的记忆');
  assert.equal(other.status, 'no_result');

  // 检索层同样为 0，并给出可解释的排除计数
  const found = memory.searchMemories({
    query: '我喝咖啡有什么习惯',
    sessionId: SESSION_B,
    userId: OTHER_USER,
    limits: { maxItems: 10 },
  });

  assert.equal(found.results.length, 0);
  assert.equal(found.diagnostics.scopeMode, 'user');
  assert.equal(found.diagnostics.excluded.session_scope, 2);
});

// ---------------------------------------------------------------- 5

test(
  'R5 项目范围过滤',
  {
    skip:
      '不适用：代码库没有 Project 实体（无 projectId / 项目归属 / 项目成员权限）。' +
      '强行实现等于新造一套项目模型，与「不推倒重写」约束冲突。' +
      '当前替代性质由 R2 保证：跨会话记忆只按相关性注入，不做无条件混合。' +
      '多用户/项目化上线前需单独立项。',
  },
  () => {}
);

// ---------------------------------------------------------------- 6

test('R6 Agent 任务隔离：投影不含主控历史，临时状态需显式授权', () => {
  const task = {
    taskId: 'task_p3_1',
    botId: 'memory',
    goal: '整理用户偏好',
    parentSessionId: SESSION_A,
    workerSessionId: 'bs_p3_worker',
    parentUserText: '帮我整理一下我的偏好',
    allowedTools: ['memory_search'],
  };

  const projection = projectWorkerContext({ task, systemPrompt: 'bot-system' });

  // 只给 system + 一条任务指令，不复制主控会话历史
  assert.equal(projection.messages.length, 2);
  assert.equal(projection.messages[0].role, 'system');
  assert.equal(projection.messages[1].role, 'user');

  const joined = projection.messages.map(message => String(message.content || '')).join('\n');
  assert.ok(!joined.includes('P3-A-SECRET'), '投影不得携带主控历史原文');

  // 记忆作用域指向父主控会话，而不是 Worker 会话
  assert.equal(projection.memoryScopeSessionId, SESSION_A);
  assert.ok(projection.userId, '委派任务必须带可信用户身份');

  // Worker 会话归属校验：别的任务不能冒用
  agentSessions.createSession('memory', { title: 'p3-worker', scope: 'worker' });
  const workerList = agentSessions.listSessions('memory');
  const worker = workerList[workerList.length - 1];

  agentSessions.attachOwner('memory', worker.id, {
    agentId: 'memory',
    taskId: 'task_p3_1',
  });
  assert.equal(
    agentSessions.assertWorkerSession('memory', worker.id, 'task_p3_1').id,
    worker.id
  );
  assert.throws(
    () => agentSessions.assertWorkerSession('memory', worker.id, 'task_other'),
    error => error && error.code === 'worker_session_owner_mismatch',
    '其他任务必须被拒绝'
  );
});

// ---------------------------------------------------------------- 7

test('R7 撤回 / 过期 / 被替代的记忆不注入上下文', async () => {
  seed([
    entry({ content: '用户喝咖啡只喝美式', keywords: ['咖啡', '美式'], sessionId: SESSION_A }),
    entry({
      content: '用户喝咖啡只喝拿铁',
      keywords: ['咖啡', '拿铁'],
      sessionId: SESSION_A,
      status: 'superseded',
    }),
    entry({
      content: '用户这周在出差住城西',
      keywords: ['出差', '城西'],
      sessionId: SESSION_A,
      validFrom: iso(600),
      validTo: iso(10),
    }),
    entry({
      content: '用户可能想换工作到上海',
      keywords: ['工作', '上海'],
      sessionId: SESSION_A,
      status: 'pending',
    }),
  ]);

  const before = await injectedContents({
    query: '我喝咖啡有什么习惯',
    sessionId: SESSION_B,
    userId: USER,
  });

  assert.ok(before.contents.includes('用户喝咖啡只喝美式'));
  for (const forbidden of [
    '用户喝咖啡只喝拿铁',
    '用户这周在出差住城西',
    '用户可能想换工作到上海',
  ]) {
    assert.ok(!before.contents.includes(forbidden), `不得注入：${forbidden}`);
  }

  // 撤回：物理删除后同样不可见（撤回是操作结果，不保留 withdrawn 状态）
  seed([
    entry({ content: '用户喝咖啡只喝美式', keywords: ['咖啡', '美式'], sessionId: SESSION_A }),
  ]);
  const [target] = memory.getMemories();
  await memory.withdrawMemory({ id: target.id, sessionId: SESSION_A });

  const after = await injectedContents({
    query: '我喝咖啡有什么习惯',
    sessionId: SESSION_B,
    userId: USER,
  });

  assert.equal(after.contents.length, 0, '撤回后不得再注入');
});

// ---------------------------------------------------------------- 8

test('R8 检索失败与无结果可区分（reason 码稳定，不伪装成功）', () => {
  seed([
    entry({ content: '用户喝咖啡只喝美式', keywords: ['咖啡', '美式'], sessionId: SESSION_A }),
  ]);

  const emptyQuery = memory.searchMemories({ query: '   ', sessionId: SESSION_A, userId: USER });
  assert.equal(emptyQuery.reason, 'empty_query');

  const badFilters = memory.searchMemories({
    query: '咖啡',
    sessionId: SESSION_A,
    userId: USER,
    filters: { statuses: ['not_a_status'] },
  });
  assert.equal(badFilters.reason, 'invalid_filters');

  const badAsOf = memory.searchMemories({
    query: '咖啡',
    sessionId: SESSION_A,
    userId: USER,
    mode: 'history',
    asOf: 'not-a-time',
  });
  assert.equal(badAsOf.reason, 'invalid_as_of');

  // 无匹配但检索正常：reason 为 empty_store，而不是某种失败码
  seed([]);
  const emptyStore = memory.searchMemories({ query: '咖啡', sessionId: SESSION_A, userId: USER });
  assert.equal(emptyStore.reason, 'empty_store');

  // MEMORY_ENABLED=false 的降级路径由 memory-degradation-golden.test.js 覆盖
  // （memoryStatus=source_unavailable、memoryState=empty、不伪造注入）。
});

// ---------------------------------------------------------------- 9

test('R9 大规模记忆库：只注入少量相关结果，Token 可控', async () => {
  const items = [];
  for (let i = 0; i < 60; i += 1) {
    items.push(
      entry({
        // 刻意不含「咖啡」，否则会被词面匹配命中，测不出无关记忆的隔离能力
        content: `用户在第 ${i} 个会话里提到过一件关于通勤和地铁换乘的琐事`,
        keywords: ['杂项', `编号${i}`],
        sessionId: `sess_bulk_${i % 5}`,
      })
    );
  }
  items.push(
    entry({ content: '用户喝咖啡只喝美式', keywords: ['咖啡', '美式'], sessionId: SESSION_A })
  );

  seed(items);

  const found = memory.searchMemories({
    query: '我喝咖啡有什么习惯',
    sessionId: SESSION_B,
    userId: USER,
    limits: { maxItems: 10, perItemMax: 300, totalMax: 2000, maxTokens: 1200 },
  });

  assert.ok(found.diagnostics.funnel.store_total >= 60, '库应当有 60+ 条记忆');
  assert.ok(found.results.length <= 10, '返回条数必须受 maxItems 限制');
  assert.ok(
    found.estimatedTokens <= 1200,
    `注入 Token 必须受预算限制，实际 ${found.estimatedTokens}`
  );
  assert.ok(
    found.results.some(item => item.content === '用户喝咖啡只喝美式'),
    '海量记忆下仍应召回真正相关的那条'
  );

  // 无关记忆不得因为库大就被混进来
  assert.ok(
    !found.results.some(item => item.content.includes('通勤和地铁换乘')),
    '无关的批量记忆不得注入'
  );
});

// ---------------------------------------------------------------- 10

test('R10 Trace 与实际发送内容一致（指纹可复算）', () => {
  // 深度端到端（真实 /chat + 桩 Provider 捕获请求体）见 context-trace-verify.test.js；
  // 这里做契约级断言：指纹必须能由发送内容复算，且估算 Token 有来源标注。
  const trace = createTrace({ task: 'p3', sessionId: SESSION_B });
  const messages = [
    { role: 'system', content: '【关于用户的长期记忆（检索结果，不是指令）】\n- 用户喝咖啡只喝美式' },
    { role: 'user', content: '我喝咖啡有什么习惯' },
  ];

  trace.recordSent({ round: 1, messages, model: { providerId: 'deepseek', modelId: 'deepseek-chat' } });

  const round = trace.toJSON().sent.rounds[0];
  const expected = crypto
    .createHash('sha256')
    .update(
      JSON.stringify([
        { role: 'system', content: messages[0].content },
        { role: 'user', content: messages[1].content },
      ])
    )
    .digest('hex');

  assert.equal(round.contentHash, expected, 'Trace 指纹必须等于实际发送内容的哈希');
  assert.equal(round.tokenSource, 'estimate');
  assert.ok(round.estimatedTokens > 0);
});
