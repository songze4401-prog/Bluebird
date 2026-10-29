/* global __dirname */
/**
 * 云岫 Bluebird — Context Runtime v3 单元测试
 *
 * 覆盖：消息投影契约、历史选择（>20 条 / 长程召回 / 摘要）、覆盖去重、
 * TTL 与冲突、输入保护、trace 阶段一致性与隐私、配置严格校验。
 */
const fs = require('fs');
const os = require('os');
const path = require('path');
const test = require('node:test');
const assert = require('node:assert');

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'bluebird-ctx-v3-'));
process.env.BLUEBIRD_DATA_DIR = TMP;
process.env.DEEPSEEK_API_KEY = '';

const { config, validateConfig } = require('../server/context/config');
const {
  projectStoredMessages,
  toModelMessages,
  modelMessageId,
  PROJECTION_VERSION,
} = require('../server/context/projection');
const {
  selectHistory,
  hasBackReference,
} = require('../server/context/history');
const { buildHistorySummary, classify } = require('../server/context/summary');
const {
  buildCoverageContexts,
  dedupeRetrievalItems,
  evaluateCoverage,
  findHistoryConflict,
} = require('../server/context/coverage');
const {
  adjudicateMemory,
  applyTtlPolicy,
} = require('../server/context/builder');
const {
  fitRequest,
  measureRequest,
} = require('../server/context/input-guard');
const { runContextRuntime } = require('../server/context/engine');
const {
  computeFreshness,
  resetBreaker,
} = require('../server/context/retriever');
const { createTrace } = require('../server/context/trace');
const { estimateTokens } = require('../server/text-utils');

const iso = offset => new Date(Date.UTC(2026, 0, 1, 0, offset)).toISOString();

function message(id, role, content, offset, extra = {}) {
  return {
    id,
    role,
    content,
    createdAt: iso(offset),
    ...extra,
  };
}

function project(items) {
  return projectStoredMessages(items, { sessionId: 's1' });
}

function render(item, { includeImages = false } = {}) {
  return (
    toModelMessages([item], {
      includeImages,
      readAttachment: () => 'data:image/png;base64,AAAA',
    })[0] || null
  );
}

function coreBlocks(text = '核心系统规则') {
  return [{ id: 'core', kind: 'core', priority: 100, critical: true, text }];
}

async function runRuntime({
  items = [],
  query = '当前问题',
  injected = {},
  model = {},
  toolsReserveTokens = 0,
  systemBlocks = coreBlocks(),
  currentContent = '当前问题',
  currentMessage,
  configOverride = config,
} = {}) {
  const projected = project(items);
  const current = currentMessage || { role: 'user', content: currentContent };
  return runContextRuntime({
    task: query,
    sessionId: 's1',
    projectedMessages: projected,
    renderMessage: item => render(item),
    systemBlocks,
    currentMessage: current,
    model,
    toolsReserveTokens,
    injected,
    config: configOverride,
  });
}

function longFiller(count, length = 20) {
  const items = [];
  for (let i = 0; i < count; i += 1) {
    items.push(
      message(
        `m${i}`,
        i % 2 === 0 ? 'user' : 'assistant',
        `第 ${i} 条日常对话：${'普通讨论内容。'.repeat(length)}`,
        i
      )
    );
  }
  return items;
}

test.beforeEach(() => {
  resetBreaker('memory');
});

// ============ A. 投影契约 ============

test('A1: 投影保留 id/role/content/createdAt/附件/toolSteps 与版本号', () => {
  const items = [
    message('m1', 'user', '你好', 1, {
      attachments: [{ id: 'img1', kind: 'image', mime: 'image/png', name: 'a.png' }],
      toolSteps: [{ name: 'memory_search', ok: true, code: 'ok', summary: '找到 1 条', durationMs: 12 }],
    }),
    message('m2', 'assistant', '在的', 2),
  ];
  const projected = project(items);
  assert.strictEqual(projected.length, 2);
  assert.strictEqual(projected[0].projectionVersion, PROJECTION_VERSION);
  assert.strictEqual(projected[0].id, 'm1');
  assert.strictEqual(projected[0].role, 'user');
  assert.strictEqual(projected[0].content, '你好');
  assert.strictEqual(projected[0].createdAt, iso(1));
  assert.strictEqual(projected[0].attachments.length, 1);
  assert.strictEqual(projected[0].hasImage, true);
  assert.strictEqual(projected[0].toolSteps.length, 1);
  assert.deepStrictEqual(projected[0].unsupported, []);
});

test('A2: 非字符串 content 显式标记 unsupported，不静默当空串', () => {
  const projected = project([
    message('m1', 'user', null, 1),
  ]);
  // content null -> 空字符串 + unsupported
  const [item] = projectStoredMessages([{ id: 'm1', role: 'user', content: [{ type: 'text', text: 'x' }] }], { sessionId: 's1' });
  assert.strictEqual(item.content, '');
  assert.ok(item.unsupported.includes('content_not_string'));
  assert.strictEqual(projected[0].content, '');
});

test('A3: 无 id 的附件被丢弃并显式标记', () => {
  const [item] = projectStoredMessages(
    [message('m1', 'user', '图', 1, { attachments: [{ mime: 'image/png' }, { id: 'ok', mime: 'image/png' }] })],
    { sessionId: 's1' }
  );
  assert.strictEqual(item.attachments.length, 1);
  assert.ok(item.unsupported.includes('attachment_without_id'));
});

test('A4: 用户图片转 image_url；助手图片降级文本占位；includeImages=false 时用户图片也降级', () => {
  const user = projectStoredMessages(
    [message('m1', 'user', '看图', 1, { attachments: [{ id: 'img1', kind: 'image', mime: 'image/png' }] })],
    { sessionId: 's1' }
  )[0];
  const assistant = projectStoredMessages(
    [message('m2', 'assistant', '给你', 2, { attachments: [{ id: 'st1', kind: 'sticker', mime: 'image/png' }] })],
    { sessionId: 's1' }
  )[0];

  const userMsg = render(user, { includeImages: true });
  assert.ok(Array.isArray(userMsg.content));
  assert.strictEqual(userMsg.content[1].type, 'image_url');

  const assistantMsg = render(assistant, { includeImages: true });
  assert.strictEqual(typeof assistantMsg.content, 'string');
  assert.match(assistantMsg.content, /\[sticker:st1\]/);

  const degraded = render(user, { includeImages: false });
  assert.strictEqual(degraded.content, '看图');
});

test('A5: 模型消息携带可追溯 symbol 标识，JSON 序列化不泄露', () => {
  const [item] = projectStoredMessages([message('m1', 'user', '你好', 1)], { sessionId: 's1' });
  const modelMessage = render(item);
  assert.strictEqual(modelMessageId(modelMessage), 'm1');
  assert.strictEqual(JSON.stringify(modelMessage).includes('m1'), false);
});

// ============ B. 历史选择 ============

test('B1: 近期原文不再固定 20 条——短消息可超过 20 条', () => {
  const items = longFiller(60, 1);
  const projected = project(items);
  const selection = selectHistory({
    messages: projected,
    query: '今天的安排',
    render,
    config,
  });
  assert.ok(selection.recent.length > 20, `recent=${selection.recent.length}`);
  assert.strictEqual(selection.summaryInput.length, 0);
  assert.strictEqual(selection.recalled.length, 0);
});

test('B2: 长消息按 token 预算选择，保留最近至少 minRecentMessages 条', () => {
  const items = longFiller(80, 8);
  const selection = selectHistory({
    messages: project(items),
    query: '随便聊聊',
    render,
    config,
  });
  assert.ok(selection.recent.length >= config.history.minRecentMessages);
  assert.ok(selection.recent.length < 80);
  assert.ok(selection.tokens.recent <= config.history.recentBudgetTokens + 400);
});

test('B3: 最近 20 条以外的关键事实被长程召回', () => {
  const items = longFiller(80, 8);
  items[2] = message('fact', 'user', '我的项目代号是 ORBIT-7742，只有这个代号有效。', 2);
  const selection = selectHistory({
    messages: project(items),
    query: '我的项目代号是什么？',
    render,
    config,
  });
  assert.ok(selection.recent.length < 80);
  assert.ok(selection.recalled.some(entry => entry.message.id === 'fact'));
  const decision = selection.decisions.find(item => item.messageId === 'fact');
  assert.strictEqual(decision.stage, 'recalled');
  assert.ok(decision.reason.includes('长程召回'));
});

test('B4: 回指词提升旧消息召回，助手回复带出上一句用户提问', () => {
  const items = longFiller(100, 10);
  items[5] = message('u-old', 'user', '出差安排：周五去杭州。', 5);
  items[6] = message('a-old', 'assistant', '好的，出差安排已记录。', 6);
  const selection = selectHistory({
    messages: project(items),
    query: '之前那个出差安排继续',
    render,
    config,
  });
  assert.strictEqual(hasBackReference('之前那个出差安排继续'), true);
  assert.ok(selection.recalled.some(entry => entry.message.id === 'a-old'));
  assert.ok(selection.recalled.some(entry => entry.message.id === 'u-old'));
});

test('B4b: 配对召回的用户消息必须带评分，不得触发 toFixed 崩溃', () => {
  const items = longFiller(100, 10);
  items[5] = message('u-pair', 'user', '记忆检索方案讨论', 5);
  items[6] = message('a-pair', 'assistant', '建议使用 memory_search 做记忆检索', 6);
  // 收紧 recentBudgetTokens，让第 5/6 条落入 older 区，复现 2026-10-30 线上故障条件。
  const tightConfig = {
    ...config,
    history: { ...config.history, recentBudgetTokens: 40, minRecentMessages: 2 },
  };
  const selection = selectHistory({
    messages: project(items),
    query: 'memory_search 记忆检索',
    render,
    config: tightConfig,
  });
  const paired = selection.recalled.find(entry => entry.message.id === 'u-pair');
  assert.ok(paired, '配对召回的用户消息应被纳入 recalled');
  assert.strictEqual(typeof paired.score, 'number', '配对条目的 score 必须是数字');
  assert.strictEqual(typeof paired.lexical, 'number');
  assert.strictEqual(typeof paired.entity, 'number');
  const decision = selection.decisions.find(item => item.messageId === 'u-pair');
  assert.ok(decision, '配对召回条目应有决策记录');
  assert.strictEqual(decision.stage, 'recalled');
  assert.match(decision.reason, /相关度 \d\.\d{3}/);
});

test('B5: 含图片的旧消息被召回时只保留文字，并明确标注图片未重放', () => {
  const items = longFiller(100, 10);
  items[3] = message('img-msg', 'user', '这是设计稿的说明文字，主题是蓝色。', 3, {
    attachments: [{ id: 'img1', kind: 'image', mime: 'image/png' }],
  });
  const selection = selectHistory({
    messages: project(items),
    query: '设计稿是什么主题？',
    render,
    config,
  });
  const recalled = selection.recalled.find(entry => entry.message.id === 'img-msg');
  assert.ok(recalled);
  assert.ok(recalled.message.hasImage);
});

test('B6: 空模型消息被显式标记 omitted，不进入近期/摘要', () => {
  const items = [
    message('m1', 'user', '你好', 1),
    message('m2', 'assistant', '', 2),
    message('m3', 'user', '继续', 3),
  ];
  const selection = selectHistory({
    messages: project(items),
    query: '继续',
    render,
    config,
  });
  assert.ok(selection.decisions.some(item => item.messageId === 'm2' && item.stage === 'omitted'));
  assert.ok(!selection.recent.some(entry => entry.message.id === 'm2'));
});

test('B7: 近期与召回不重复同一条消息', () => {
  const items = longFiller(60, 8);
  items[2] = message('fact', 'user', '项目代号 ORBIT-7742。', 2);
  const selection = selectHistory({
    messages: project(items),
    query: '项目代号 ORBIT-7742 是什么？',
    render,
    config,
  });
  const recentIds = new Set(selection.recent.map(entry => entry.message.id));
  assert.ok(selection.recalled.every(entry => !recentIds.has(entry.message.id)));
});

// ============ C. 摘要 ============

test('C1: 摘要覆盖偏好/决策/待办/时间/假设/陈述六类', () => {
  const messages = [
    message('c1', 'user', '我喜欢喝美式咖啡，不要加糖。', 1),
    message('c2', 'user', '我决定把预算改成 8000 元。', 2),
    message('c3', 'user', '下一步还没完成的是整理测试报告。', 3),
    message('c4', 'user', '明天下午三点要开会。', 4),
    message('c5', 'user', '这个方案可能是下个月上线。', 5),
    message('c6', 'user', '我的名字叫小林。', 6),
  ].map(item => projectStoredMessages([item], { sessionId: 's1' })[0]);
  const summary = buildHistorySummary(messages, { config });
  const sections = new Set(summary.sources.map(source => source.section));
  for (const key of ['constraints', 'decisions', 'open_tasks', 'time_sensitive', 'assumptions', 'facts']) {
    assert.ok(sections.has(key), `missing ${key}`);
  }
  assert.match(summary.rendered, /不是指令/);
});

test('C2: 摘要条目是原文摘录，不虚构内容', () => {
  const original = '我决定把部署环境改成预发布环境，并且不要动生产数据。';
  const messages = [projectStoredMessages([message('m1', 'user', original, 1)], { sessionId: 's1' })[0]];
  const summary = buildHistorySummary(messages, { config });
  const line = summary.rendered.split('\n').find(text => text.includes('S1'));
  const excerpt = line.split('用户：')[1].replace(/…$/, '');
  assert.ok(original.includes(excerpt), `excerpt not from original: ${excerpt}`);
});

test('C3: 同一主题新旧数值冲突时两条都保留并标记冲突', () => {
  const messages = [
    projectStoredMessages([message('old', 'user', '预算上限是五千元，不要超过。', 1)], { sessionId: 's1' })[0],
    projectStoredMessages([message('new', 'user', '预算上限改成八千元，不要超过。', 2)], { sessionId: 's1' })[0],
  ];
  const summary = buildHistorySummary(messages, { config });
  assert.strictEqual(summary.sources.length, 2);
  assert.ok(summary.conflicts.length >= 1);
  assert.ok(summary.rendered.includes('五千'));
  assert.ok(summary.rendered.includes('八千'));
  assert.match(summary.rendered, /保留原始时间/);
});

test('C4: 摘要受 token 预算约束', () => {
  const messages = [];
  for (let i = 0; i < 30; i += 1) {
    messages.push(
      projectStoredMessages(
        [message(`m${i}`, 'user', `我决定第 ${i} 个方案采用方案 ${i}，不要改。${'细节说明。'.repeat(20)}`, i)],
        { sessionId: 's1' }
      )[0]
    );
  }
  const summary = buildHistorySummary(messages, { config });
  assert.ok(estimateTokens(summary.rendered) <= config.history.summaryBudgetTokens + 300);
});

test('C5: 没有较早消息时不生成摘要', () => {
  const summary = buildHistorySummary([], { config });
  assert.strictEqual(summary.count, 0);
  assert.strictEqual(summary.rendered, '');
});

test('C6: 摘要来源 messageId 可追溯到原消息', () => {
  const messages = [
    projectStoredMessages([message('m1', 'user', '我决定改成蓝色主题。', 1)], { sessionId: 's1' })[0],
  ];
  const summary = buildHistorySummary(messages, { config });
  assert.strictEqual(summary.sources[0].messageId, 'm1');
  assert.strictEqual(classify(messages[0]), 'decisions');
});

// ============ D. 覆盖去重与冲突 ============

test('D1: 与近期原文充分重复的记忆被跳过并记录理由', () => {
  const contexts = buildCoverageContexts({
    recent: [{ message: { id: 'm1', content: '我的项目代号是 ORBIT-7742。' } }],
  });
  const result = dedupeRetrievalItems(
    [{ id: 'mem1', source: 'memory', content: '我的项目代号是 ORBIT-7742。', relevance: 0.9 }],
    contexts,
    config
  );
  assert.strictEqual(result.accepted.length, 0);
  assert.strictEqual(result.skipped[0].reason, 'covered_by_context');
  assert.strictEqual(result.skipped[0].against, 'm1');
});

test('D2: 部分覆盖的记忆保留为补充信息，不被一刀切清空', () => {
  const contexts = buildCoverageContexts({
    recent: [{ message: { id: 'm1', content: '项目代号是 ORBIT-7742。' } }],
  });
  const result = dedupeRetrievalItems(
    [{ id: 'mem1', source: 'memory', content: '项目代号是 ORBIT-7742，负责人是小林。', relevance: 0.8 }],
    contexts,
    config
  );
  assert.strictEqual(result.accepted.length, 1);
  assert.strictEqual(result.accepted[0].coverage.status, 'partial_supplement');
});

test('D3: 无关记忆正常进入，不因存在历史而被过滤', () => {
  const contexts = buildCoverageContexts({
    recent: [{ message: { id: 'm1', content: '今天天气不错。' } }],
  });
  const result = dedupeRetrievalItems(
    [{ id: 'mem1', source: 'memory', content: '用户对花生过敏。', relevance: 0.7 }],
    contexts,
    config
  );
  assert.strictEqual(result.accepted.length, 1);
  assert.strictEqual(result.accepted[0].coverage.status, 'novel');
});

test('D4: 检索条目之间的高重复只保留高分项', () => {
  const result = dedupeRetrievalItems(
    [
      { id: 'a', source: 'memory', content: '用户喜欢喝美式咖啡。', relevance: 0.9 },
      { id: 'b', source: 'memory', content: '用户喜欢喝美式咖啡。', relevance: 0.5 },
    ],
    [],
    config
  );
  assert.strictEqual(result.accepted.length, 1);
  assert.strictEqual(result.accepted[0].id, 'a');
  assert.strictEqual(result.skipped[0].reason, 'duplicate_retrieval_item');
});

test('D5: 旧记忆与更新用户陈述冲突时，以用户历史为准并记录冲突', () => {
  const item = {
    id: 'mem1',
    source: 'memory',
    content: '预算上限是 5000 元，不要超过。',
    type: 'project_fact',
    freshness: { status: 'fresh', fetched_at: iso(1) },
    verification: { status: 'schema_valid' },
  };
  const recent = [
    {
      message: {
        id: 'm-new',
        role: 'user',
        content: '预算上限改成 8000 元，不要超过。',
        createdAt: iso(10),
      },
    },
  ];
  const conflict = findHistoryConflict(item, recent.map(entry => entry.message));
  assert.strictEqual(conflict.resolution, 'newer_user_history_wins');
  assert.strictEqual(conflict.messageId, 'm-new');

  const adjudication = adjudicateMemory({
    items: [item],
    recent,
    recalled: [],
    summary: null,
    config,
  });
  assert.strictEqual(adjudication.accepted.length, 0);
  assert.ok(adjudication.skipped.some(skip => skip.reason === 'conflict_newer_user_history'));
  assert.strictEqual(adjudication.conflicts.length, 1);
});

test('D6: TTL——fresh 进入；过期的用户偏好降级待确认；过期项目事实标记待验证；实时过期排除', () => {
  const now = Date.parse(iso(10));
  const base = {
    source: 'memory',
    id: 'x',
    content: '一条记忆内容',
    verification: { status: 'schema_valid' },
  };
  assert.strictEqual(
    applyTtlPolicy({ ...base, type: 'user_preference', freshness: { status: 'fresh' } }, config).keep,
    true
  );
  const demoted = applyTtlPolicy(
    { ...base, type: 'user_preference', freshness: { status: 'stale' } },
    config
  );
  assert.strictEqual(demoted.keep, false);
  assert.strictEqual(demoted.reason, 'demoted_to_pending');
  const revalidate = applyTtlPolicy(
    { ...base, type: 'project_fact', freshness: { status: 'stale' } },
    config
  );
  assert.strictEqual(revalidate.keep, true);
  assert.strictEqual(revalidate.pendingValidation, true);
  const expired = applyTtlPolicy(
    { ...base, type: 'realtime_data', freshness: { status: 'expired' } },
    config
  );
  assert.strictEqual(expired.keep, false);
  assert.strictEqual(expired.reason, 'expired_realtime_refetch');

  // computeFreshness：无时间戳 -> unknown；实时超过 30s -> expired
  const unknown = computeFreshness({ type: 'project_fact', fetchedAt: null, config });
  assert.strictEqual(unknown.status, 'unknown');
  const realtime = computeFreshness({
    type: 'realtime_data',
    fetchedAt: new Date(now - 31000).toISOString(),
    config,
    now,
  });
  assert.strictEqual(realtime.status, 'expired');
});

// ============ E. 输入保护 ============

test('E1: 模型声明窗口时使用 declared 并给出计量', () => {
  const fit = fitRequest({
    systemBlocks: coreBlocks(),
    historyMessages: [{ role: 'user', content: '你好' }],
    currentMessage: { role: 'user', content: '在吗' },
    model: { contextWindow: 8000 },
    config,
  });
  assert.strictEqual(fit.ok, true);
  assert.strictEqual(fit.measurement.window.source, 'declared');
  assert.strictEqual(fit.measurement.window.verified, true);
  assert.ok(fit.measurement.estimatedInputTokens > 0);
  assert.ok(fit.measurement.totalRequiredTokens > fit.measurement.estimatedInputTokens);
});

test('E2: 模型未声明窗口时使用 unknown_guard，并明确未验证', () => {
  const fit = fitRequest({
    systemBlocks: coreBlocks(),
    currentMessage: { role: 'user', content: '你好' },
    model: {},
    config,
  });
  assert.strictEqual(fit.ok, true);
  assert.strictEqual(fit.measurement.window.source, 'unknown_guard');
  assert.strictEqual(fit.measurement.window.verified, false);
  assert.strictEqual(fit.measurement.window.tokens, config.inputGuard.unknownWindowGuardTokens);
});

test('E3: 超限先删低优先级上下文块（记忆→召回→摘要），核心系统块保留', () => {
  const contextBlocks = [
    { id: 'summary', kind: 'summary', priority: 50, text: '摘要'.repeat(100), itemIds: ['summary'] },
    { id: 'recalled-history', kind: 'recalled', priority: 40, text: '召回'.repeat(100), itemIds: ['recalled:r1'] },
    { id: 'memory', kind: 'memory', priority: 30, text: '记忆'.repeat(100), itemIds: ['memory:mem1'] },
  ];
  const fit = fitRequest({
    systemBlocks: coreBlocks('核心规则'.repeat(40)),
    contextBlocks,
    currentMessage: { role: 'user', content: '问题' },
    model: { contextWindow: 2400 },
    config,
  });
  assert.strictEqual(fit.ok, true);
  assert.ok(fit.dropped.length > 0);
  assert.strictEqual(fit.dropped[0].kind, 'memory');
  assert.ok(fit.systemPrompt.includes('核心规则'));
  assert.ok(fit.keptBaseBlockIds.includes('core'));
});

test('E4: 裁剪历史时保留最近 minHistoryMessages 条完整消息', () => {
  const historyMessages = Array.from({ length: 10 }, (_, i) => ({
    role: i % 2 === 0 ? 'user' : 'assistant',
    content: `第${i}条`.repeat(100),
  }));
  const fit = fitRequest({
    systemBlocks: coreBlocks('核心'),
    historyMessages,
    currentMessage: { role: 'user', content: '当前问题' },
    model: { contextWindow: 3000 },
    config,
  });
  assert.strictEqual(fit.ok, true);
  assert.ok(fit.historyMessages.length >= config.inputGuard.minHistoryMessages);
  assert.ok(fit.historyMessages.length < 10);
  assert.ok(fit.dropped.some(item => item.kind === 'history'));
  assert.strictEqual(fit.messages[fit.messages.length - 1].content, '当前问题');
});

test('E5: 当前任务 + 核心规则本身超限时显式失败，不静默截断', () => {
  const fit = fitRequest({
    systemBlocks: coreBlocks('核心规则'.repeat(500)),
    currentMessage: { role: 'user', content: '当前任务'.repeat(500) },
    model: { contextWindow: 500 },
    config,
  });
  assert.strictEqual(fit.ok, false);
  assert.strictEqual(fit.errorCode, 'context_too_large');
  assert.match(fit.error, /输入超过安全上限/);
});

test('E6: 图片按 perImageTokens 计，不按 dataURL 字符数计', () => {
  const measurement = measureRequest({
    systemBlocks: coreBlocks(),
    currentMessage: {
      role: 'user',
      content: [
        { type: 'text', text: '看图' },
        { type: 'image_url', image_url: { url: 'data:image/png;base64,' + 'A'.repeat(100000) } },
      ],
    },
    config,
  });
  assert.strictEqual(measurement.current.imageCount, 1);
  assert.ok(measurement.currentTokens < 2000);
});

test('E7: Agent 工具预留计入 totalRequired', () => {
  const base = fitRequest({
    systemBlocks: coreBlocks(),
    currentMessage: { role: 'user', content: '问题' },
    model: { contextWindow: 8000 },
    config,
  });
  const withTools = fitRequest({
    systemBlocks: coreBlocks(),
    currentMessage: { role: 'user', content: '问题' },
    toolsReserveTokens: 2000,
    model: { contextWindow: 8000 },
    config,
  });
  assert.strictEqual(withTools.measurement.toolsReserveTokens, 2000);
  assert.strictEqual(
    withTools.measurement.totalRequiredTokens - base.measurement.totalRequiredTokens,
    2000
  );
});

// ============ F. Runtime 与 trace ============

test('F1: 运行时同时注入近期历史、长程召回、摘要、记忆，并全部通过验证', async () => {
  const items = longFiller(70, 8);
  items[2] = message('fact', 'user', '我的项目代号是 ORBIT-7742。', 2);
  items[10] = message('decision', 'user', '我决定预算上限改成 8000 元，不要超过。', 10);
  const out = await runRuntime({
    items,
    query: '我的项目代号是什么？',
    injected: { memory: [{ id: 'mem1', content: '用户对花生过敏。', type: 'fact', fetchedAt: iso(1) }] },
  });
  assert.strictEqual(out.ok, true);
  assert.ok(out.trace.history.recent > 20);
  assert.ok(out.trace.history.recalled >= 1);
  assert.ok(out.summary.count >= 1);
  assert.ok(out.memory.accepted.some(item => item.id === 'mem1'));
  assert.strictEqual(out.verification.ok, true);
  assert.ok(out.systemPrompt.includes('ORBIT-7742'));
  assert.ok(out.systemPrompt.includes('花生过敏'));
  assert.ok(out.systemPrompt.includes('较早对话摘要'));
});

test('F2: trace 的 injected 与真实 sent 消息/上下文 ID 完全一致', async () => {
  const items = longFiller(70, 8);
  items[2] = message('fact', 'user', '我的项目代号是 ORBIT-7742。', 2);
  const out = await runRuntime({
    items,
    query: '我的项目代号是什么？',
    injected: { memory: [{ id: 'mem1', content: '用户对花生过敏。', type: 'fact', fetchedAt: iso(1) }] },
  });
  const trace = out.traceApi;
  trace.recordSent({
    round: 1,
    messages: out.messages,
    contextIds: out.contextIds,
    model: { providerId: 'p', modelId: 'm' },
  });
  const json = trace.toJSON();
  assert.strictEqual(json.sent.consumed, null);
  assert.match(json.sent.consumedNote, /HTTP 成功不等于/);

  const sentContext = new Set(json.sent.rounds[0].contextIds);
  const injectedContext = new Set(json.build.contextIds);
  assert.deepStrictEqual([...sentContext].sort(), [...injectedContext].sort());

  const sentMessageIds = new Set(json.sent.rounds[0].messageIds.filter(Boolean));
  assert.ok(sentMessageIds.has('current-user'));
  for (const entry of out.historyMessages) {
    assert.ok(sentMessageIds.has(modelMessageId(entry)));
  }
  assert.strictEqual(json.stages.injected, out.contextIds.length + out.historyMessages.length + 1);
});

test('F3: trace 不包含历史/记忆/摘要正文（隐私）', async () => {
  const secretHistory = 'HISTORY-SECRET-7f3a';
  const secretMemory = 'MEMORY-SECRET-9c2d';
  const items = longFiller(70, 8);
  items[2] = message('fact', 'user', `项目代号 ${secretHistory}。`, 2);
  const out = await runRuntime({
    items,
    query: `项目代号 ${secretHistory} 是什么？`,
    injected: { memory: [{ id: 'mem1', content: secretMemory, type: 'fact', fetchedAt: iso(1) }] },
  });
  out.traceApi.recordSent({ messages: out.messages, contextIds: out.contextIds });
  const json = JSON.stringify(out.traceApi.toJSON());
  assert.strictEqual(json.includes(secretHistory), false);
  assert.strictEqual(json.includes(secretMemory), false);
});

test('F4: 近期消息不重复进入 systemPrompt；召回消息不进入对话消息数组', async () => {
  const items = longFiller(70, 8);
  items[2] = message('fact', 'user', '项目代号 ORBIT-7742。', 2);
  const out = await runRuntime({
    items,
    query: '项目代号 ORBIT-7742 是什么？',
  });
  const recentContents = out.historyMessages
    .filter(message => message.role === 'user')
    .map(message => message.content);
  for (const content of recentContents) {
    assert.strictEqual(out.systemPrompt.includes(content), false);
  }
  assert.ok(out.systemPrompt.includes('ORBIT-7742'));
  const messageContents = out.messages
    .filter(message => message.role !== 'system')
    .map(message => String(message.content));
  assert.ok(!messageContents.some(content => content.includes('较早对话原文摘录')));
});

test('F5: 会话隔离——运行时只消费传入的投影消息', async () => {
  const out = await runRuntime({
    items: [
      message('a1', 'user', '会话 A 的事实：喜欢蓝色。', 1),
      message('a2', 'assistant', '记住了。', 2),
    ],
    query: '会话 A 的事实是什么？',
  });
  assert.ok(
    out.messages.some(message => String(message.content).includes('喜欢蓝色'))
  );
  assert.strictEqual(out.trace.sessionId, 's1');
});

test('F6: 无历史时仍可正常组装（当前任务 + 记忆）', async () => {
  const out = await runRuntime({
    items: [],
    query: '你好',
    currentContent: '你好',
    injected: { memory: [{ id: 'mem1', content: '用户对花生过敏。', type: 'fact', fetchedAt: iso(1) }] },
  });
  assert.strictEqual(out.ok, true);
  assert.strictEqual(out.historyMessages.length, 0);
  assert.ok(out.messages.some(message => message.role === 'user' && message.content === '你好'));
});

test('F7: 输入保护裁剪发生在运行时，并记录 dropped 与注入 ID 变化', async () => {
  const items = longFiller(30, 10);
  const out = await runRuntime({
    items,
    query: '普通问题',
    injected: { memory: [{ id: 'mem1', content: '用户对花生过敏。', type: 'fact', fetchedAt: iso(1) }] },
    model: { contextWindow: 2600 },
  });
  assert.strictEqual(out.ok, true);
  assert.ok(out.dropped.length > 0);
  assert.ok(out.trace.build.dropped.length > 0);
  assert.ok(out.historyMessages.length < 30);
  assert.ok(!out.contextIds.includes('memory:mem1'));
});

// ============ G. Trace 阶段 ============

test('F8: 1000 条历史仍能召回近期窗口之外的关键事实', async () => {
  const items = longFiller(1000, 4);
  items[5] = message('fact-1000', 'user', '我的保单号是 POL-1000-KEEP。', 5);
  const out = await runRuntime({
    items,
    query: '我的保单号是什么？',
  });
  assert.strictEqual(out.ok, true);
  assert.strictEqual(out.trace.history.totalMessages, 1000);
  assert.ok(out.trace.history.recent > 20);
  assert.ok(out.trace.history.recalled >= 1);
  assert.ok(out.systemPrompt.includes('POL-1000-KEEP'));
});

test('G1: 新 trace 具备 candidate/selected/accepted/injected/sent 阶段与 consumed=null', async () => {
  const out = await runRuntime({ items: longFiller(10, 2) });
  const json = out.traceApi.toJSON();
  assert.ok(json.stages.candidate >= 10);
  assert.ok(json.stages.selected >= 0);
  assert.ok(json.stages.accepted >= 0);
  assert.ok(json.stages.injected >= 0);
  assert.strictEqual(json.stages.sent, 0);
  assert.strictEqual(json.sent.consumed, null);
});

test('G2: 工具 trace 只记录元数据，不记录结果正文', () => {
  const trace = createTrace({ task: 'x', sessionId: 's' });
  trace.recordTool({
    name: 'memory_search',
    ok: true,
    code: 'tool_ok',
    summary: 'TOOL-RESULT-SECRET',
    durationMs: 12,
  });
  const json = trace.toJSON();
  assert.strictEqual(json.tools[0].name, 'memory_search');
  assert.strictEqual(json.tools[0].ok, true);
  assert.strictEqual(JSON.stringify(json).includes('TOOL-RESULT-SECRET'), false);
});

// ============ H. 配置 ============

test('H1: schemaVersion 必须为 v3.0', () => {
  const bad = JSON.parse(JSON.stringify(config));
  bad.schemaVersion = 'v2.3';
  const result = validateConfig(bad);
  assert.strictEqual(result.ok, false);
  assert.ok(result.errors.some(error => error.includes('schemaVersion')));
});

test('H2: 严格模式拒绝未知字段', () => {
  const bad = JSON.parse(JSON.stringify(config));
  bad.budget = { softTarget: 6000 };
  const result = validateConfig(bad);
  assert.strictEqual(result.ok, false);
  assert.ok(result.errors.some(error => error.includes('未知字段')));
});

test('H3: 旧预算字段已从配置中删除', () => {
  assert.strictEqual(config.budget, undefined);
  const json = fs.readFileSync(path.join(__dirname, '..', 'server', 'context', 'config.json'), 'utf8');
  assert.strictEqual(json.includes('softTarget'), false);
  assert.strictEqual(json.includes('perTypeMax'), false);
  assert.strictEqual(json.includes('guaranteedSystem'), false);
});

test('H4: 实时 TTL 必填，禁止 ignore', () => {
  const missing = JSON.parse(JSON.stringify(config));
  delete missing.ttl.realtime_data.ttlRequired;
  assert.strictEqual(validateConfig(missing).ok, false);

  const ignore = JSON.parse(JSON.stringify(config));
  ignore.ttl.user_preference.on_expire = 'ignore';
  assert.strictEqual(validateConfig(ignore).ok, false);
});

test('H5: retry.maxRetries 最大为 1，配置深冻结', () => {
  const bad = JSON.parse(JSON.stringify(config));
  bad.retry.maxRetries = 3;
  assert.strictEqual(validateConfig(bad).ok, false);
  assert.strictEqual(Object.isFrozen(config), true);
  assert.strictEqual(Object.isFrozen(config.history), true);
});

test('H6: 输入保护拒绝不安全的估算放大系数', () => {
  const bad = JSON.parse(JSON.stringify(config));
  bad.inputGuard.estimatorSafetyFactor = 0.5;
  assert.strictEqual(validateConfig(bad).ok, false);
});

test.after(() => {
  try {
    fs.rmSync(TMP, { recursive: true, force: true });
  } catch (_) {
    /* ignore */
  }
});
