/**
 * 云岫 Bluebird — 记忆检索可观测性（P2）
 *
 * 覆盖本轮验收点：
 *   1. 每次检索的候选数 / 命中数 / 最终注入数可区分
 *   2. 过滤原因可分解（过期 / 被替代 / 归档 / 待确认 / 低相关性 / 作用域）
 *   3. 注入 Token 是 Token 数（估算器口径），不是字符数或条数
 *   4. 最终发送内容的指纹可核对（哈希），并能与 Provider usage 配对
 *   5. Provider 真实 usage 与本地桩 usage 严格区分（stub 不冒充真实统计）
 *   6. 跨会话检索不会把已撤回 / 过期 / 被替代的事实注入上下文
 *
 * 隔离：BLUEBIRD_DATA_DIR 指向临时目录，不读写 server/data 的真实数据。
 *
 * 运行：node tests/memory-observability.test.js
 */
const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const assert = require('node:assert/strict');
const { test, before, after } = require('node:test');

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'bluebird-mem-obs-'));
process.env.BLUEBIRD_DATA_DIR = TMP;
process.env.MEMORY_ENABLED = 'true';
// 本文件专门验证监控对账，必须显式打开监控（npm test 默认是关的）。
process.env.BLUEBIRD_MONITORING = '1';

const memory = require(path.join(__dirname, '..', 'server', 'memory.js'));
const monitoring = require(path.join(__dirname, '..', 'server', 'monitoring'));
const { createTrace } = require(path.join(__dirname, '..', 'server', 'context', 'trace.js'));
const { measureRequest } = require(path.join(__dirname, '..', 'server', 'context', 'input-guard.js'));
const { buildContext } = require(path.join(__dirname, '..', 'server', 'context', 'builder.js'));
const { retrieveMemory } = require(path.join(__dirname, '..', 'server', 'context', 'retriever.js'));
const { config } = require(path.join(__dirname, '..', 'server', 'context', 'config.js'));
const { estimateTokens, textLength } = require(path.join(__dirname, '..', 'server', 'text-utils.js'));
const { getInstanceUserId } = require(path.join(__dirname, '..', 'server', 'user-scope.js'));
const { definition: rememberTool } = require(path.join(
  __dirname,
  '..',
  'server',
  'tool-memory-remember.js'
));

const MEMORY_FILE = path.join(TMP, 'memory.json');
const USER = getInstanceUserId();
const NEW_SESSION = 'sess_obs_new';

const CONTENT = {
  coffee: '用户喝咖啡只喝美式',
  editor: '用户常用编辑器是 Vim',
  city: '用户所在城市是杭州',
  superseded: '用户喝咖啡只喝拿铁',
  expired: '用户这周在出差，住城西酒店',
  pending: '用户可能想换工作到上海',
  archived: '用户曾用 Windows 作为主力系统',
};

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
}) {
  return {
    content,
    type,
    keywords,
    confidence: 0.9,
    status,
    sourceQuote: content,
    ...(sessionId ? { sessionId } : {}),
    validFrom: validFrom || iso(60),
    validTo: validTo || null,
    createdAt: iso(60),
    updatedAt: iso(60),
  };
}

function seedFixture() {
  const items = [
    entry({ content: CONTENT.coffee, keywords: ['咖啡', '美式'], sessionId: 'old_a' }),
    entry({ content: CONTENT.editor, keywords: ['编辑器', 'Vim'], sessionId: 'old_b' }),
    entry({ content: CONTENT.city, keywords: ['城市', '杭州'] }),
    entry({
      content: CONTENT.superseded,
      keywords: ['咖啡', '拿铁'],
      sessionId: 'old_a',
      status: 'superseded',
    }),
    entry({
      content: CONTENT.expired,
      keywords: ['出差', '酒店'],
      sessionId: 'old_b',
      validFrom: iso(600),
      validTo: iso(10),
    }),
    entry({
      content: CONTENT.pending,
      keywords: ['工作', '上海'],
      sessionId: 'old_b',
      status: 'pending',
    }),
    entry({
      content: CONTENT.archived,
      keywords: ['系统', 'Windows'],
      sessionId: 'old_a',
      status: 'archived',
    }),
  ];

  fs.writeFileSync(MEMORY_FILE, JSON.stringify(items, null, 2), 'utf8');
  memory.loadMemories();
}

before(() => {
  monitoring.initMonitoring({ dataDir: path.join(TMP, 'monitoring') });
  assert.equal(
    monitoring.isActive(),
    true,
    '监控必须处于激活状态，否则对账断言会静默跳过'
  );
  seedFixture();
});

after(() => {
  monitoring.shutdownMonitoring();
  monitoring.resetMonitoringForTests();
  fs.rmSync(TMP, { recursive: true, force: true });
});

// ---------------------------------------------------------------- 1 & 2

test('检索漏斗：候选数、命中数、库总量可区分', () => {
  const found = memory.searchMemories({
    query: '咖啡',
    sessionId: NEW_SESSION,
    userId: USER,
    limits: { maxItems: 10 },
  });

  const funnel = found.diagnostics.funnel;

  assert.equal(funnel.store_total, 7, '库总量应是 7 条');
  assert.equal(funnel.eligible, 3, '状态/时间可见的应是 3 条');
  assert.equal(funnel.candidates, 3, '候选池大小应是 3');
  assert.equal(funnel.returned, found.results.length, 'returned 必须等于实际返回条数');
  assert.ok(found.results.some(item => item.content === CONTENT.coffee));
});

test('过滤原因可分解：过期/被替代/归档/待确认分别计数', () => {
  const found = memory.searchMemories({
    query: '咖啡',
    sessionId: NEW_SESSION,
    userId: USER,
    limits: { maxItems: 10 },
  });

  const reasons = found.diagnostics.visibilityReasons;

  assert.equal(reasons.superseded, 1, '被替代的应计 1');
  assert.equal(reasons.expired, 1, '过期的应计 1');
  assert.equal(reasons.pending, 1, '待确认的应计 1');
  assert.equal(reasons.archived, 1, '归档的应计 1');
  assert.equal(found.diagnostics.excluded.visibility, 4, '不可见总数应等于四项之和');
});

test('低相关性单独计数：无关查询命中 0 条但候选池非空', () => {
  const found = memory.searchMemories({
    query: '量子纠缠的退相干时间',
    sessionId: NEW_SESSION,
    userId: USER,
    limits: { maxItems: 10 },
  });

  assert.equal(found.diagnostics.funnel.candidates, 3, '候选池仍然有 3 条');
  assert.equal(found.results.length, 0, '无关查询不应命中');
  assert.ok(
    found.diagnostics.excluded.irrelevant >= 3,
    `低相关性应被单独计数，实际 ${found.diagnostics.excluded.irrelevant}`
  );
});

test('跨会话检索不会把已撤回/过期/被替代的事实注入上下文', async () => {
  const retrieval = await retrieveMemory({
    task: '咖啡',
    sessionId: NEW_SESSION,
    userId: USER,
    config,
  });

  const built = buildContext({
    recent: [],
    recalled: [],
    summary: null,
    memoryItems: retrieval.items || [],
    knowledgeItems: [],
    config,
  });

  const injected = built.memory.accepted.map(item => item.content);

  assert.ok(injected.includes(CONTENT.coffee), '当前有效事实应当注入');
  for (const forbidden of [
    CONTENT.superseded,
    CONTENT.expired,
    CONTENT.pending,
    CONTENT.archived,
  ]) {
    assert.ok(
      !injected.includes(forbidden),
      `不可注入的内容被注入了：${forbidden}`
    );
  }
});

// ---------------------------------------------------------------- 3

test('注入 Token 是 Token 数，不是字符数也不是条数', async () => {
  const retrieval = await retrieveMemory({
    task: '咖啡',
    sessionId: NEW_SESSION,
    userId: USER,
    config,
  });
  const built = buildContext({
    recent: [],
    recalled: [],
    summary: null,
    memoryItems: retrieval.items || [],
    knowledgeItems: [],
    config,
  });
  const memoryBlock = built.blocks.find(block => block.kind === 'memory');

  assert.ok(memoryBlock, '应当存在记忆块');

  const measurement = measureRequest({
    systemBlocks: [memoryBlock],
    historyMessages: [],
    currentMessage: { role: 'user', content: '我喝什么咖啡' },
    model: { contextWindow: 128000 },
    config,
  });

  const expectedTokens = estimateTokens(String(memoryBlock.text));
  const chars = textLength(String(memoryBlock.text));

  assert.equal(measurement.tokenSource, 'estimate', '必须标注是估算器口径');
  assert.equal(measurement.memoryTokens, expectedTokens);
  assert.equal(measurement.blocks[0].kind, 'memory');
  assert.equal(measurement.blocks[0].tokens, expectedTokens);
  assert.ok(measurement.memoryTokens > 0);
  assert.notEqual(
    measurement.memoryTokens,
    chars,
    'Token 数不能等于字符数（否则就是拿字符冒充 Token）'
  );
});

// ---------------------------------------------------------------- 4

test('发送内容指纹：同内容同哈希，改一个字就变', () => {
  const trace = createTrace({ task: 't', sessionId: 's' });
  const messages = [
    { role: 'system', content: '你是助手' },
    { role: 'user', content: '我喝什么咖啡' },
  ];

  trace.recordSent({ round: 1, messages });

  const round = trace.toJSON().sent.rounds[0];
  const expected = crypto
    .createHash('sha256')
    .update(
      JSON.stringify([
        { role: 'system', content: '你是助手' },
        { role: 'user', content: '我喝什么咖啡' },
      ])
    )
    .digest('hex');

  assert.equal(round.contentHash, expected, '指纹必须能由发送内容复算出来');
  assert.equal(round.tokenSource, 'estimate');
  assert.ok(round.estimatedTokens > 0, '必须给出本轮估算输入 Token');

  const other = createTrace({ task: 't', sessionId: 's' });
  other.recordSent({
    round: 1,
    messages: [
      { role: 'system', content: '你是助手' },
      { role: 'user', content: '我喝什么咖啡？' },
    ],
  });

  assert.notEqual(
    other.toJSON().sent.rounds[0].contentHash,
    round.contentHash,
    '内容变化必须反映到指纹'
  );
});

// ---------------------------------------------------------------- 5

test('Provider usage 与本地估算配对：真实计数才参与校准', () => {
  const trace = createTrace({ task: 't', sessionId: 's' });
  trace.recordSent({
    round: 1,
    messages: [{ role: 'user', content: '我喝什么咖啡' }],
  });
  const estimated = trace.toJSON().sent.rounds[0].estimatedTokens;

  const real = trace.recordProviderUsage({
    round: 1,
    usage: { prompt_tokens: estimated + 10, completion_tokens: 20 },
    providerKind: 'configured',
  });

  assert.equal(real.usageSource, 'provider');
  assert.equal(real.calibration, true);
  assert.equal(real.promptTokens, estimated + 10);
  assert.equal(typeof real.withinTolerance, 'boolean');

  const stub = trace.recordProviderUsage({
    round: 1,
    usage: { prompt_tokens: 999, completion_tokens: 1 },
    providerKind: 'stub',
  });

  assert.equal(stub.usageSource, 'stub', '桩返回不能标成 provider');
  assert.equal(stub.calibration, false, '桩数据不参与校准');
  assert.equal(stub.withinTolerance, null);

  const missing = trace.recordProviderUsage({ round: 1, usage: null });
  assert.equal(missing.usageSource, 'missing');
  assert.equal(missing.promptTokens, null);
  assert.equal(missing.estimateRatio, null, '没有真实计数就不猜比值');
});

test('监控对账：真实 Provider 记 provider，桩记 stub，都不冒充', () => {
  const real = monitoring.recordTokenReconciliation({
    estimatedInputTokens: 100,
    promptTokens: 130,
    providerKind: 'configured',
  });

  assert.equal(real.usageSource, 'provider');
  assert.equal(real.ratio, 1.3);
  assert.equal(real.withinTolerance, true, '1.3 在 0.35 容差内');
  assert.equal(real.calibration, true);

  const stub = monitoring.recordTokenReconciliation({
    estimatedInputTokens: 100,
    promptTokens: 500,
    providerKind: 'stub',
  });

  assert.equal(stub.usageSource, 'stub');
  assert.equal(stub.calibration, false);
  assert.equal(stub.withinTolerance, null);

  const missing = monitoring.recordTokenReconciliation({
    estimatedInputTokens: 100,
    promptTokens: null,
    providerKind: 'configured',
  });

  assert.equal(missing.usageSource, 'missing');
  assert.equal(missing.ratio, null);

  const events = monitoring.getEvents({ from: 0, to: Date.now(), limit: 100 });
  const reconciled = events.items.filter(
    item => item.event_name === monitoring.EVENTS.CONTEXT_TOKENS_RECONCILED
  );

  assert.ok(reconciled.length >= 3, '三条对账事件都应落库');

  const stubEvent = reconciled.find(
    item => item.attributes && item.attributes.provider_kind === 'stub'
  );
  assert.ok(stubEvent, '桩事件必须带 provider_kind=stub');
  assert.equal(stubEvent.attributes.usage_source, 'stub');
});

test('providerKind：显式声明优先，其次本地桩旁路，缺省为 configured', () => {
  const prevKind = process.env.BLUEBIRD_PROVIDER_KIND;
  const prevBypass = process.env.BLUEBIRD_ALLOW_PRIVATE_BASE_URL;

  try {
    delete process.env.BLUEBIRD_PROVIDER_KIND;
    delete process.env.BLUEBIRD_ALLOW_PRIVATE_BASE_URL;
    assert.equal(monitoring.providerKind(), 'configured', '两者都没设 → configured');

    process.env.BLUEBIRD_ALLOW_PRIVATE_BASE_URL = '1';
    assert.equal(monitoring.providerKind(), 'stub', '本地桩旁路 → stub');

    process.env.BLUEBIRD_PROVIDER_KIND = 'configured';
    assert.equal(
      monitoring.providerKind(),
      'configured',
      '显式 configured 优先于本地桩旁路'
    );

    process.env.BLUEBIRD_PROVIDER_KIND = 'stub';
    assert.equal(monitoring.providerKind(), 'stub', '显式 stub 最高优先');
  } finally {
    if (prevKind === undefined) delete process.env.BLUEBIRD_PROVIDER_KIND;
    else process.env.BLUEBIRD_PROVIDER_KIND = prevKind;

    if (prevBypass === undefined) delete process.env.BLUEBIRD_ALLOW_PRIVATE_BASE_URL;
    else process.env.BLUEBIRD_ALLOW_PRIVATE_BASE_URL = prevBypass;
  }
});

test('模型调用埋点：桩 usage 记为 stub，不写入 provider 统计', () => {
  const beforeEvents = monitoring.getEvents({ from: 0, to: Date.now(), limit: 200 }).items
    .length;

  const call = monitoring.beginModelCall({
    providerId: 'stub-provider',
    modelId: 'stub-model',
    kind: 'chat',
    round: 1,
    providerKind: 'stub',
  });
  call.complete({
    status: 'success',
    durationMs: 5,
    usage: { prompt_tokens: 1234, completion_tokens: 56 },
  });

  const events = monitoring.getEvents({ from: 0, to: Date.now(), limit: 200 }).items;
  assert.ok(events.length > beforeEvents, '应当新增模型调用事件');

  const completed = events.filter(
    item =>
      item.event_name === monitoring.EVENTS.MODEL_REQUEST_COMPLETED &&
      item.attributes &&
      item.attributes.provider_id === 'stub-provider'
  );

  assert.equal(completed.length, 1);
  assert.equal(completed[0].attributes.usage_source, 'stub');
  assert.equal(completed[0].attributes.provider_kind, 'stub');
});

// ------------------------------------------------ 写入监控富属性（P1 前置）

test('写入监控：channel/decision/数值细节入事件，白名单外键与文本不进', () => {
  monitoring.recordMemoryWrite({
    action: 'create',
    status: 'skipped',
    written: false,
    reason: 'ungrounded_content',
    channel: 'extraction',
    decision: 'reject',
    observerMode: 'every_turn',
    detail: { anchorScore: 0.04, keywordHits: 1, keywordTotal: 3, note: '不该出现' },
  });

  const events = monitoring.getEvents({ from: 0, to: Date.now(), limit: 500 }).items;
  const evt = [...events]
    .reverse()
    .find(
      item =>
        item.event_name === monitoring.EVENTS.MEMORY_WRITE_COMPLETED &&
        item.attributes &&
        item.attributes.channel === 'extraction' &&
        item.attributes.reason === 'ungrounded_content'
    );

  assert.ok(evt, '带富属性的写入事件应落库');
  assert.equal(evt.attributes.decision, 'reject');
  assert.equal(evt.attributes.observer_mode, 'every_turn');
  assert.equal(evt.attributes.anchor_score, 0.04);
  assert.equal(evt.attributes.keyword_hits, 1);
  assert.equal(evt.attributes.keyword_total, 3);
  assert.equal(evt.attributes.note, undefined, '白名单外的键不得进入属性');
  assert.equal(
    JSON.stringify(evt.attributes).includes('不该出现'),
    false,
    '任何文本载荷不得进入写入监控属性'
  );
});

test('写入监控：待确认不算失败（status=skipped，decision 区分语义）', () => {
  monitoring.recordMemoryWrite({
    action: 'create',
    status: 'skipped',
    written: false,
    reason: 'single_preference_candidate',
    channel: 'agent_tool',
    decision: 'needs_confirmation',
  });

  const events = monitoring.getEvents({ from: 0, to: Date.now(), limit: 500 }).items;
  const evt = [...events]
    .reverse()
    .find(
      item =>
        item.event_name === monitoring.EVENTS.MEMORY_WRITE_COMPLETED &&
        item.attributes &&
        item.attributes.channel === 'agent_tool' &&
        item.attributes.decision === 'needs_confirmation'
    );

  assert.ok(evt, '待确认写入事件应落库');
  assert.equal(evt.status, 'skipped', '监控 status 枚举沿用 skipped，不新造值');
  assert.equal(evt.error_code, null, '待确认不是失败，不得标 error_code');
  assert.equal(evt.attributes.reason, 'single_preference_candidate');
});

test('Agent 工具通道写入也进监控：成功与被拒都带 channel=agent_tool', async () => {
  const ctx = {
    sessionId: 'sess_obs_tool',
    userText: '我家的猫叫糯糯，以后帮我记着',
    userId: USER,
  };

  const ok = await rememberTool.handler(
    {
      content: '用户的猫名叫糯糯',
      type: 'fact',
      sourceQuote: '我家的猫叫糯糯',
      keywords: ['猫', '糯糯'],
      confidence: 0.92,
    },
    ctx
  );
  assert.equal(ok.ok, true, '接地充分的新增候选应可直接写入');

  const rejected = await rememberTool.handler(
    {
      content: '用户有点累想睡觉',
      type: 'preference',
      sourceQuote: '有点累想睡觉',
      confidence: 0.95,
    },
    // 临时状态用例必须有它自己的用户原话：接地门先于决策层，
    // 复用上面猫句子的 userText 会被拦成 ungrounded_source 而不是 temporary_state。
    { sessionId: 'sess_obs_tool', userText: '我有点累想睡觉', userId: USER }
  );
  assert.equal(rejected.ok, false, '临时状态必须被决策层拒绝');

  const events = monitoring.getEvents({ from: 0, to: Date.now(), limit: 500 }).items;
  const toolEvents = events.filter(
    item =>
      item.event_name === monitoring.EVENTS.MEMORY_WRITE_COMPLETED &&
      item.attributes &&
      item.attributes.channel === 'agent_tool'
  );

  assert.ok(
    toolEvents.length >= 2,
    `工具通道应至少落两条写入事件，实际 ${toolEvents.length}`
  );

  const written = toolEvents.find(item => item.attributes.written === true);
  const skipped = toolEvents.find(
    item =>
      item.attributes.written === false && item.attributes.reason === 'temporary_state'
  );

  assert.ok(written, '成功写入应带 written=true');
  assert.equal(written.attributes.decision, 'create');
  assert.ok(skipped, '临时状态拒绝应带 reason=temporary_state');
  assert.equal(skipped.attributes.decision, 'reject');
  assert.equal(skipped.status, 'skipped');
});
