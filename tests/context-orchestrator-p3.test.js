/**
 * P3 调度与召回验收
 *
 * 覆盖：意图分类、层选择、预算、无答案阈值、端到端 trace，
 * 以及固定小样本上的 Recall/Precision 对比。
 *
 * 运行：node tests/context-orchestrator-p3.test.js
 */
const { test, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'bluebird-p3-orchestrator-'));
process.env.BLUEBIRD_DATA_DIR = TMP;
process.env.BLUEBIRD_USER_ID = 'local-owner';
process.env.BLUEBIRD_MEMORY_EVIDENCE_POLICY = 'compat';
process.env.DEEPSEEK_API_KEY = '';

const MEMORY_FILE = path.join(TMP, 'memory.json');
const memory = require(path.join(__dirname, '..', 'server', 'memory.js'));
const { runContextRuntime } = require(path.join(
  __dirname,
  '..',
  'server',
  'context',
  'engine.js'
));
const { config } = require(path.join(
  __dirname,
  '..',
  'server',
  'context',
  'config.js'
));
const {
  INTENTS,
  classifyIntent,
  planContext,
  planForIntent,
  applyPlanToConfig,
} = require(path.join(__dirname, '..', 'server', 'context', 'orchestrator.js'));
const { retrieveKnowledge } = require(path.join(
  __dirname,
  '..',
  'server',
  'context',
  'knowledge.js'
));

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
    status: 'active',
    userId: OWNER,
    createdAt: OLD,
    updatedAt: OLD,
    ...overrides,
  };
}

function render(message) {
  return { role: message.role, content: message.content || '' };
}

function runRuntime({ task, plan = null, sessionId = 's-p3' } = {}) {
  return runContextRuntime({
    task,
    sessionId,
    userId: OWNER,
    projectedMessages: [],
    renderMessage: render,
    renderFinalMessage: render,
    systemBlocks: [
      { id: 'core', kind: 'core', text: '你是 Bluebird 测试助手。', priority: 100 },
    ],
    currentMessage: { role: 'user', content: task },
    model: { providerId: 'test', modelId: 'test-model', contextWindow: 32000 },
    config,
    ...(plan ? { plan } : {}),
  });
}

beforeEach(() => seed([]));

test('意图分类：问候/记忆查询/事实/项目/计划/执行/复盘/通用', () => {
  assert.equal(classifyIntent('你好'), INTENTS.CHITCHAT);
  assert.equal(classifyIntent('谢谢'), INTENTS.CHITCHAT);
  assert.equal(classifyIntent('我喜欢喝什么咖啡'), INTENTS.MEMORY_QUERY);
  assert.equal(classifyIntent('我的项目代号是什么'), INTENTS.FACT_QUERY);
  assert.equal(classifyIntent('这个项目架构怎么改'), INTENTS.PROJECT_WORK);
  assert.equal(classifyIntent('帮我规划下一步'), INTENTS.PLANNING);
  assert.equal(classifyIntent('修复这个 bug'), INTENTS.EXECUTION);
  assert.equal(classifyIntent('复盘这次上线'), INTENTS.REVIEW);
  assert.equal(classifyIntent('什么是事件驱动'), INTENTS.FACT_QUERY);
  assert.equal(classifyIntent('今天天气不错'), INTENTS.GENERAL);
});

test('调度计划：chitchat 关闭记忆/知识，memory_query 关闭知识', () => {
  const chitchat = planForIntent(INTENTS.CHITCHAT);
  assert.equal(chitchat.layers.memory, false);
  assert.equal(chitchat.layers.knowledge, false);
  assert.equal(chitchat.layers.summary, false);
  assert.equal(chitchat.budgets.history.recentBudgetTokens, 2400);

  const recall = planForIntent(INTENTS.MEMORY_QUERY);
  assert.equal(recall.layers.memory, true);
  assert.equal(recall.layers.knowledge, false);
  assert.equal(recall.noAnswerThreshold, 0.04);

  const fact = planForIntent(INTENTS.FACT_QUERY);
  assert.deepEqual(fact.layers.knowledgeSources, ['document', 'web']);
  assert.equal(fact.noAnswerThreshold, 0.08);

  const execution = planForIntent(INTENTS.EXECUTION);
  assert.deepEqual(execution.layers.knowledgeSources, ['document', 'code']);
  assert.deepEqual(execution.layers.memoryTypes, [
    'fact',
    'goal',
    'identity',
    'preference',
  ]);

  const review = planForIntent(INTENTS.REVIEW);
  assert.equal(review.layers.episodicOnly, true);

  const general = planForIntent(INTENTS.GENERAL);
  assert.equal(general.layers.memory, true);
  assert.equal(general.layers.knowledge, true);
  assert.equal(general.noAnswerThreshold, 0.04);
});

test('调度计划：开关关闭时退回 general 全量行为', () => {
  const off = planContext({
    task: '你好',
    env: { BLUEBIRD_CONTEXT_ORCHESTRATOR: '0' },
  });
  assert.equal(off.enabled, false);
  assert.equal(off.intent, INTENTS.GENERAL);
  assert.equal(off.layers.memory, true);
  assert.equal(off.layers.knowledge, true);

  const on = planContext({
    task: '你好',
    env: { BLUEBIRD_CONTEXT_ORCHESTRATOR: '1' },
  });
  assert.equal(on.enabled, true);
  assert.equal(on.intent, INTENTS.CHITCHAT);
});

test('applyPlanToConfig 只覆盖预算字段，不丢其他配置', () => {
  const plan = planForIntent(INTENTS.CHITCHAT);
  const effective = applyPlanToConfig(config, plan);

  assert.equal(effective.history.recentBudgetTokens, 2400);
  assert.equal(effective.history.longRangeMaxItems, 0);
  assert.equal(effective.retrieval.memoryMaxItems, config.retrieval.memoryMaxItems);
  assert.equal(effective.inputGuard, config.inputGuard);
  assert.equal(effective.ttl, config.ttl);
});

test('端到端 chitchat：记忆/知识层跳过，trace 记录调度', async () => {
  seed([
    entry({
      id: 'mem-chat',
      content: '用户喜欢喝美式咖啡',
      keywords: ['咖啡', '美式'],
      contributions: [
        { sessionId: 's-p3', sourceQuote: '我喜欢喝美式咖啡', createdAt: OLD },
      ],
    }),
  ]);

  const result = await runRuntime({ task: '你好' });

  assert.equal(result.ok, true);
  assert.equal(result.memoryStatus, 'skipped');
  assert.equal(result.memoryState, 'empty');
  assert.equal(result.memory.accepted.length, 0);
  assert.equal(result.knowledge.status, 'skipped');
  assert.equal(result.trace.orchestration.intent, INTENTS.CHITCHAT);
  assert.equal(result.trace.orchestration.layers.memory, false);
  assert.equal(result.trace.orchestration.layers.knowledge, false);
  assert.equal(
    result.messages.some(message =>
      String(message.content || '').includes('用户喜欢喝美式咖啡')
    ),
    false
  );
});

test('端到端 memory_query：注入记忆、跳过知识层', async () => {
  seed([
    entry({
      id: 'mem-pref',
      content: '用户喜欢喝美式咖啡',
      type: 'preference',
      keywords: ['咖啡', '美式', '偏好'],
      contributions: [
        { sessionId: 's-p3', sourceQuote: '我喜欢喝美式咖啡', createdAt: OLD },
      ],
    }),
  ]);

  const result = await runRuntime({ task: '我喜欢喝什么咖啡' });

  assert.equal(result.ok, true);
  assert.equal(result.memoryStatus, 'ok');
  assert.equal(result.memoryState, 'ok');
  assert.ok(result.memory.accepted.length >= 1);
  assert.equal(result.knowledge.status, 'skipped');
  assert.equal(result.trace.orchestration.intent, INTENTS.MEMORY_QUERY);
  assert.equal(result.trace.orchestration.layers.knowledge, false);
  assert.equal(
    result.messages.some(message =>
      String(message.content || '').includes('用户喜欢喝美式咖啡')
    ),
    true
  );
});

test('端到端分层：项目任务排除 relationship 层', async () => {
  seed([
    entry({
      id: 'mem-project',
      content: '项目架构采用事件驱动',
      keywords: ['项目', '架构', '事件驱动'],
      contributions: [
        { sessionId: 's-p3', sourceQuote: '项目架构采用事件驱动', createdAt: OLD },
      ],
    }),
    entry({
      id: 'mem-relationship',
      content: '用户与项目架构师是朋友',
      type: 'relationship',
      keywords: ['项目', '架构', '朋友'],
      contributions: [
        {
          sessionId: 's-p3',
          sourceQuote: '用户与项目架构师是朋友',
          createdAt: OLD,
        },
      ],
    }),
  ]);

  const result = await runRuntime({ task: '修复项目架构的 bug' });

  assert.equal(result.trace.orchestration.intent, INTENTS.EXECUTION);
  assert.equal(
    result.memory.accepted.some(item =>
      String(item.content).includes('项目架构采用事件驱动')
    ),
    true
  );
  assert.equal(
    result.memory.accepted.some(item =>
      String(item.content).includes('项目架构师是朋友')
    ),
    false
  );
});

test('端到端无答案阈值：低于阈值的记忆不注入', async () => {
  seed([
    entry({
      id: 'mem-weak',
      content: '用户喜欢喝美式咖啡',
      type: 'preference',
      keywords: ['咖啡', '美式'],
      contributions: [
        { sessionId: 's-p3', sourceQuote: '我喜欢喝美式咖啡', createdAt: OLD },
      ],
    }),
  ]);

  const task = '我喜欢喝什么咖啡';
  const plan = {
    ...planForIntent(INTENTS.MEMORY_QUERY),
    noAnswerThreshold: 1.01,
  };

  const result = await runRuntime({ task, plan });

  assert.equal(result.ok, true);
  assert.equal(result.memory.accepted.length, 0);
  assert.equal(result.memoryState, 'empty');
  assert.equal(result.trace.retrieval.returned, 1);
  assert.equal(result.trace.retrieval.accepted, 0);
});

test('端到端预算：memoryMaxItems 限制注入条数', async () => {
  seed(
    Array.from({ length: 12 }, (_, index) =>
      entry({
        id: `mem-budget-${index}`,
        content: `用户的偏好项目事实 ${index}`,
        type: 'preference',
        keywords: ['偏好', '项目', `事实${index}`],
        contributions: [
          {
            sessionId: 's-p3',
            sourceQuote: `我的偏好项目事实 ${index}`,
            createdAt: OLD,
          },
        ],
      })
    )
  );

  const result = await runRuntime({ task: '我的偏好是什么' });

  assert.equal(result.ok, true);
  assert.equal(result.trace.orchestration.intent, INTENTS.MEMORY_QUERY);
  assert.equal(result.trace.orchestration.budgets.retrieval.memoryMaxItems, 8);
  assert.ok(result.memory.accepted.length <= 8);
});

test('无答案阈值与层过滤在 searchMemories 上可复现', async () => {
  seed([
    entry({
      id: 'mem-p3-a',
      content: '项目架构采用事件驱动',
      keywords: ['项目', '架构', '事件驱动'],
      contributions: [
        { sessionId: 's-p3', sourceQuote: '项目架构采用事件驱动', createdAt: OLD },
      ],
    }),
    entry({
      id: 'mem-p3-b',
      content: '项目架构拆分为服务层',
      keywords: ['项目', '架构', '服务层'],
      contributions: [
        { sessionId: 's-p3', sourceQuote: '项目架构拆分为服务层', createdAt: OLD },
      ],
    }),
    entry({
      id: 'mem-p3-rel',
      content: '用户与项目架构师是朋友',
      type: 'relationship',
      keywords: ['项目', '架构', '朋友'],
      contributions: [
        {
          sessionId: 's-p3',
          sourceQuote: '用户与项目架构师是朋友',
          createdAt: OLD,
        },
      ],
    }),
  ]);

  const query = '项目架构怎么改';
  const baseline = memory.searchMemories({
    query,
    sessionId: 's-p3',
    userId: OWNER,
    limits: { maxItems: 10 },
  });
  const plan = planForIntent(INTENTS.PROJECT_WORK);
  const layered = memory.searchMemories({
    query,
    sessionId: 's-p3',
    userId: OWNER,
    limits: { maxItems: 10 },
    filters: { types: plan.layers.memoryTypes },
  });

  const relevant = new Set(['mem-p3-a', 'mem-p3-b']);
  const precision = result =>
    result.results.length
      ? result.results.filter(item => relevant.has(item.id)).length /
        result.results.length
      : 0;
  const recall = result =>
    result.results.filter(item => relevant.has(item.id)).length / relevant.size;

  assert.ok(baseline.results.length > layered.results.length);
  assert.ok(precision(layered) > precision(baseline));
  assert.ok(recall(layered) >= recall(baseline));
  assert.equal(recall(layered), 1);
  assert.equal(
    layered.results.every(item => item.id !== 'mem-p3-rel'),
    true
  );
});

test('知识源为空时 retrieveKnowledge 明确跳过', async () => {
  const result = await retrieveKnowledge({
    task: '项目架构怎么改',
    sessionId: 's-p3',
    userId: OWNER,
    sources: [],
  });

  assert.equal(result.status, 'skipped');
  assert.equal(result.reason, 'intent_no_knowledge');
  assert.equal(result.items.length, 0);
});
