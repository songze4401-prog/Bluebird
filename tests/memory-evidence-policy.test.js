/**
 * P1 证据驱动写入策略验收
 *
 * 重点验证：
 * - strict 下单次偏好只成为候选，不直接晋升；
 * - 显式持久意图可以写入（即使模型 confidence 较低）；
 * - 模型推断保留 provenance，不以 user_asserted 落盘；
 * - 模糊表述进入行为模式待确认；
 * - 稳定事实、明确更正仍可直接生效；
 * - 第二次独立表达把候选晋升为 active；
 * - 同一 messageId 的重复抽取被幂等拒绝；
 * - compat 默认保持既有单次偏好行为。
 *
 * 运行：node tests/memory-evidence-policy.test.js
 */
const { test, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'bluebird-evidence-policy-'));
process.env.BLUEBIRD_DATA_DIR = TMP;
process.env.BLUEBIRD_USER_ID = 'local-owner';
process.env.BLUEBIRD_MEMORY_EVIDENCE_POLICY = 'strict';
process.env.DEEPSEEK_API_KEY = '';

const MEMORY_FILE = path.join(TMP, 'memory.json');
const memory = require(path.join(__dirname, '..', 'server', 'memory.js'));

function seed(items) {
  fs.writeFileSync(MEMORY_FILE, JSON.stringify(items, null, 2), 'utf8');
  memory.loadMemories();
}

function candidate(overrides = {}) {
  return {
    content: '用户喜欢喝美式咖啡',
    type: 'preference',
    keywords: ['咖啡', '美式'],
    confidence: 0.95,
    sourceQuote: '我喜欢喝美式咖啡',
    ...overrides,
  };
}

function options(sessionId, userText, extra = {}) {
  return {
    sessionId,
    userId: 'local-owner',
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
    includeSuperseded: true,
    includeArchived: true,
  });
}

beforeEach(() => seed([]));

test('strict：单次偏好进入候选，不直接晋升 active', async () => {
  const result = await memory.applyCandidate(
    candidate(),
    options('s-a', '我喜欢喝美式咖啡', { messageId: 'm-p1-single' })
  );

  assert.equal(result.decision, 'needs_confirmation');
  assert.equal(result.status, 'pending');
  assert.equal(result.reason, 'single_preference_candidate');

  const saved = allMemories()[0];
  assert.equal(saved.status, 'pending');
  assert.equal(saved.category, 'long_term_preference');
  assert.equal(saved.provenance, 'user_asserted');
  assert.equal(saved.pendingReason, 'single_preference_candidate');
  assert.equal(saved.evidence.persistentIntent, false);
  assert.equal(saved.policyVersion, 'p1.0');
});

test('strict：显式持久意图可直接写入，低模型置信度也可', async () => {
  const result = await memory.applyCandidate(
    candidate({
      confidence: 0.7,
      sourceQuote: '以后我都喜欢喝美式咖啡',
    }),
    options('s-a', '记住，以后我都喜欢喝美式咖啡', {
      messageId: 'm-p1-explicit',
    })
  );

  assert.equal(result.written, true);
  assert.equal(result.status, 'active');
  assert.equal(result.decision, 'create');

  const saved = allMemories()[0];
  assert.equal(saved.status, 'active');
  assert.equal(saved.evidence.persistentIntent, true);
  assert.equal(saved.evidence.modelConfidence, 0.7);
});

test('strict：自动抽取的显式持久意图在 0.7 置信度下仍可写入', async () => {
  const fakeClient = {
    chat: {
      completions: {
        create: async () => ({
          choices: [
            {
              message: {
                content: JSON.stringify({
                  content: '用户喜欢喝美式咖啡',
                  type: 'preference',
                  keywords: ['咖啡', '美式'],
                  confidence: 0.7,
                  inferred: false,
                  sourceQuote: '以后我都喜欢喝美式咖啡',
                }),
              },
            },
          ],
        }),
      },
    },
  };

  const outcome = await memory.processMemory(
    fakeClient,
    '记住，以后我都喜欢喝美式咖啡',
    's-a',
    { messageId: 'm-p1-auto-explicit' }
  );

  assert.equal(outcome.written, true);
  assert.equal(outcome.status, 'active');

  const saved = allMemories()[0];
  assert.equal(saved.status, 'active');
  assert.equal(saved.evidence.persistentIntent, true);
  assert.equal(saved.evidence.modelConfidence, 0.7);
});

test('strict：模型推断保留 provenance，不得伪装成用户直述', async () => {
  const result = await memory.applyCandidate(
    candidate({
      content: '用户可能喜欢低维护成本方案',
      keywords: ['方案', '维护'],
      sourceQuote: '用户可能喜欢低维护成本方案',
      provenance: 'model_inferred',
    }),
    {
      ...options('s-a', '用户可能喜欢低维护成本方案', {
        messageId: 'm-p1-inferred',
      }),
      sourceType: 'model',
    }
  );

  assert.equal(result.written, false);
  assert.equal(result.status, 'pending');
  assert.equal(result.reason, 'model_inference_requires_confirmation');

  const saved = allMemories()[0];
  assert.equal(saved.provenance, 'model_inferred');
  assert.equal(saved.category, 'model_inference');
  assert.equal(saved.status, 'pending');
  assert.notEqual(saved.provenance, 'user_asserted');
});

test('strict：带“方案”字样的偏好仍按长期偏好处理', async () => {
  const result = await memory.applyCandidate(
    candidate({
      content: '用户喜欢低维护成本方案',
      keywords: ['方案', '维护'],
      sourceQuote: '我喜欢低维护成本方案',
    }),
    options('s-a', '我喜欢低维护成本方案', {
      messageId: 'm-p1-plan-preference',
    })
  );

  assert.equal(result.written, false);
  assert.equal(result.reason, 'single_preference_candidate');

  const saved = allMemories()[0];
  assert.equal(saved.category, 'long_term_preference');
  assert.equal(saved.status, 'pending');
});

test('strict：模糊表述进入行为模式待确认', async () => {
  const result = await memory.applyCandidate(
    candidate({
      content: '用户可能喜欢低维护成本方案',
      keywords: ['方案', '维护'],
      sourceQuote: '我可能喜欢低维护成本方案',
    }),
    options('s-a', '我可能喜欢低维护成本方案', { messageId: 'm-p1-hedge' })
  );

  assert.equal(result.written, false);
  assert.equal(result.status, 'pending');
  assert.equal(result.reason, 'behavior_pattern_requires_confirmation');

  const saved = allMemories()[0];
  assert.equal(saved.category, 'behavior_pattern');
  assert.equal(saved.provenance, 'user_asserted');
});

test('strict：稳定事实仍可直接写入', async () => {
  const result = await memory.applyCandidate(
    {
      content: '用户叫宋泽',
      type: 'identity',
      keywords: ['名字', '宋泽'],
      confidence: 0.95,
      sourceQuote: '我叫宋泽',
    },
    options('s-a', '我叫宋泽', { messageId: 'm-p1-identity' })
  );

  assert.equal(result.written, true);
  assert.equal(result.status, 'active');
  assert.equal(allMemories()[0].category, 'stable_fact');
});

test('strict：明确更正已有偏好仍直接生效', async () => {
  const createdAt = '2026-10-20T08:00:00.000Z';

  seed([
    {
      id: 'mem-p1-old',
      content: '用户喜欢喝美式咖啡',
      type: 'preference',
      keywords: ['咖啡', '美式'],
      confidence: 0.95,
      status: 'active',
      userId: 'local-owner',
      contributions: [
        {
          sessionId: 's-a',
          sourceQuote: '我喜欢喝美式咖啡',
          createdAt,
        },
      ],
      createdAt,
      updatedAt: createdAt,
    },
  ]);

  const result = await memory.applyCandidate(
    candidate({
      content: '用户改喝拿铁',
      keywords: ['咖啡', '拿铁'],
      sourceQuote: '我改喝拿铁了',
      targetId: 'mem-p1-old',
    }),
    options('s-a', '我改喝拿铁了', { messageId: 'm-p1-correction' })
  );

  assert.equal(result.written, true);
  assert.equal(result.status, 'active');
  assert.equal(result.decision, 'update');
  assert.equal(allMemories()[0].content, '用户改喝拿铁');
});

test('strict：第二次独立表达把候选晋升为 active', async () => {
  const first = await memory.applyCandidate(
    candidate(),
    options('s-a', '我喜欢喝美式咖啡', { messageId: 'm-p1-rep-1' })
  );
  const second = await memory.applyCandidate(
    candidate({ sourceQuote: '我也喜欢喝美式咖啡' }),
    options('s-b', '我也喜欢喝美式咖啡', { messageId: 'm-p1-rep-2' })
  );

  assert.equal(first.status, 'pending');
  assert.equal(second.written, true);
  assert.equal(second.status, 'active');
  assert.equal(second.action, 'reinforced');

  const saved = allMemories();
  assert.equal(saved.length, 1);
  assert.equal(saved[0].status, 'active');
  assert.equal(saved[0].evidence.independentSessions, 2);
  assert.deepEqual(
    saved[0].contributions.map(item => item.sessionId).sort(),
    ['s-a', 's-b']
  );
});

test('strict：同一 messageId 的重复抽取被幂等拒绝', async () => {
  const first = await memory.applyCandidate(
    candidate(),
    options('s-a', '我喜欢喝美式咖啡', { messageId: 'm-p1-dup' })
  );
  const second = await memory.applyCandidate(
    candidate(),
    options('s-a', '我喜欢喝美式咖啡', { messageId: 'm-p1-dup' })
  );

  assert.equal(first.status, 'pending');
  assert.equal(second.written, false);
  assert.equal(second.reason, 'duplicate_source');
  assert.equal(allMemories().length, 1);
});

test('strict：临时状态偏好仍被拒绝', async () => {
  const result = await memory.applyCandidate(
    candidate({
      content: '用户今天有点累',
      keywords: ['状态'],
      sourceQuote: '我今天有点累',
    }),
    options('s-a', '我今天有点累', { messageId: 'm-p1-temp' })
  );

  assert.equal(result.written, false);
  assert.equal(result.reason, 'temporary_state');
  assert.equal(allMemories().length, 0);
});

test('strict：无显式意图的低置信偏好不写入', async () => {
  const result = await memory.applyCandidate(
    candidate({ confidence: 0.7 }),
    options('s-a', '我喜欢喝美式咖啡', { messageId: 'm-p1-low' })
  );

  assert.equal(result.written, false);
  assert.equal(result.reason, 'low_confidence');
  assert.equal(allMemories().length, 0);
});

test('compat：默认保持单次偏好直接 active', async () => {
  process.env.BLUEBIRD_MEMORY_EVIDENCE_POLICY = 'compat';

  try {
    const result = await memory.applyCandidate(
      candidate(),
      options('s-a', '我喜欢喝美式咖啡', { messageId: 'm-p1-compat' })
    );

    assert.equal(result.written, true);
    assert.equal(result.status, 'active');
    assert.equal(allMemories()[0].evidence.policyMode, 'compat');
  } finally {
    process.env.BLUEBIRD_MEMORY_EVIDENCE_POLICY = 'strict';
  }
});

test('证据向量是分量，且决策记录带策略版本', async () => {
  const result = await memory.applyCandidate(
    {
      content: '用户叫宋泽',
      type: 'identity',
      keywords: ['名字', '宋泽'],
      confidence: 0.95,
      sourceQuote: '我叫宋泽',
    },
    options('s-a', '我叫宋泽', { messageId: 'm-p1-evidence' })
  );

  const saved = allMemories().find(item => item.id === result.id);

  assert.ok(saved.evidence);
  for (const key of [
    'directness',
    'sourceReliability',
    'repetition',
    'independentSessions',
    'consistency',
    'recency',
    'specificity',
    'utility',
    'sensitivity',
    'modelConfidence',
    'persistentIntent',
    'policyMode',
  ]) {
    assert.ok(key in saved.evidence, `缺少证据分量 ${key}`);
  }
  assert.equal('score' in saved.evidence, false);
  assert.equal(saved.policyVersion, 'p1.0');
  assert.equal(saved.decisionVersion, 'p1.0');
  assert.ok(saved.observedAt);
  assert.equal(saved.lastDecision.policyVersion, 'p1.0');
  assert.ok(saved.lastDecision.evidence);
});
