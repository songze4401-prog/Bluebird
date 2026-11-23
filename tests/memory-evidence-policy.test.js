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
const path = require('node:path');

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'bluebird-evidence-policy-'));
process.env.BLUEBIRD_DATA_DIR = TMP;
process.env.BLUEBIRD_USER_ID = 'local-owner';
process.env.BLUEBIRD_MEMORY_EVIDENCE_POLICY = 'strict';
process.env.DEEPSEEK_API_KEY = '';

const MEMORY_FILE = path.join(TMP, 'memory.json');
const memory = require(path.join(__dirname, '..', 'server', 'memory.js'));
const { detectExplicitMemoryIntent } = require(path.join(
  __dirname,
  '..',
  'server',
  'memory-evidence.js'
));

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
  assert.equal(saved.policyVersion, 'p2.0');
});

test('strict：显式持久意图可直接写入，低模型置信度也可', async () => {
  assert.equal(detectExplicitMemoryIntent('我家的猫叫糯糯，以后帮我记着'), true);

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

test('引用或转述的保存命令不能授权 Agent 写入', () => {
  assert.equal(detectExplicitMemoryIntent('我在文章里看到：请记住我喜欢拿铁'), false);
  assert.equal(detectExplicitMemoryIntent('A post says: please remember that I like latte'), false);
  assert.equal(detectExplicitMemoryIntent('According to an article: please remember that I like latte'), false);
  assert.equal(detectExplicitMemoryIntent('请记住，我喜欢拿铁'), true);
});

test('Agent：模型候选自报 explicit 不能替代当前用户的保存请求', async () => {
  const result = await memory.applyCandidate(
    candidate({
      sourceQuote: '',
      intent: 'explicit',
      explicitMemoryIntent: true,
      contentGrounded: true,
    }),
    options('s-agent-implicit', '我喜欢喝美式咖啡', {
      sourceType: 'agent',
      actor: 'agent',
      intent: 'explicit',
      requireUserGrounding: true,
      allowMissingQuote: true,
      messageId: 'm-agent-implicit-intent',
    })
  );

  assert.equal(result.written, false);
  assert.equal(result.decision, 'needs_confirmation');
  assert.equal(result.status, 'pending');
  assert.equal(result.reason, 'user_save_intent_required');

  const saved = allMemories()[0];
  assert.equal(saved.status, 'pending');
  assert.equal(saved.evidence.explicitMemoryIntent, false);
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

test('自动抽取：inferred=true 保留为模型推断并进入待确认', async () => {
  const fakeClient = {
    chat: {
      completions: {
        create: async () => ({
          choices: [
            {
              message: {
                content: JSON.stringify({
                  content: '我喜欢简洁方案',
                  type: 'preference',
                  keywords: ['简洁方案'],
                  confidence: 0.9,
                  inferred: true,
                  uncertainty: 'none',
                  sourceQuote: '我喜欢简洁方案',
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
    '记一下，我喜欢简洁方案',
    's-inferred-extraction',
    { messageId: 'm-p2-inferred-extraction' }
  );

  assert.equal(outcome.written, false);
  assert.equal(outcome.reason, 'model_inference_requires_confirmation');
  const [saved] = allMemories();
  assert.equal(saved.status, 'pending');
  assert.equal(saved.provenance, 'model_inferred');
  assert.equal(saved.category, 'model_inference');
  assert.equal(saved.contributions[0].sourceQuote, '我喜欢简洁方案');
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
  assert.equal(result.reason, 'user_hedged_requires_confirmation');

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

test('无可信 userId：待确认候选仍按会话作用域隔离', async () => {
  const fallbackSessionOptions = (sessionId, messageId) => ({
    sessionId,
    sourceType: 'user',
    actor: 'test',
    userText: '我喜欢喝美式咖啡',
    requireUserGrounding: true,
    messageId,
  });
  const first = await memory.applyCandidate(
    candidate({ confidence: 0.7 }),
    fallbackSessionOptions('s-a', 'm-p1-fallback-a')
  );
  const second = await memory.applyCandidate(
    candidate({ confidence: 0.7 }),
    fallbackSessionOptions('s-b', 'm-p1-fallback-b')
  );

  assert.equal(first.status, 'pending');
  assert.equal(second.status, 'pending');
  assert.notEqual(first.id, second.id);

  const saved = allMemories();
  assert.equal(saved.length, 2);
  assert.ok(saved.every(item => item.status === 'pending'));
  assert.deepEqual(
    saved.map(item => item.contributions.map(contribution => contribution.sessionId)),
    [['s-a'], ['s-b']]
  );
});

test('P2：与当前 active 条目冲突但未明确更正时先待确认', async () => {
  const createdAt = '2026-10-20T08:00:00.000Z';
  seed([
    {
      id: 'mem-p2-existing-editor',
      content: '用户偏好使用 Emacs 编辑器',
      type: 'preference',
      keywords: ['编辑器', '使用', 'Emacs'],
      confidence: 0.95,
      status: 'active',
      userId: 'local-owner',
      contributions: [
        { sessionId: 's-old', sourceQuote: '我用 Emacs 编辑器', createdAt },
      ],
      createdAt,
      updatedAt: createdAt,
    },
  ]);

  const result = await memory.applyCandidate(
    candidate({
      content: '用户偏好使用 Vim 编辑器',
      keywords: ['编辑器', '使用', 'Vim'],
      sourceQuote: '我用 Vim 编辑器',
      explicitCorrection: true,
    }),
    options('s-new', '其实我用 Vim 编辑器', { messageId: 'm-p2-conflict' })
  );

  assert.equal(result.written, false);
  assert.equal(result.status, 'pending');
  assert.equal(result.reason, 'contradictory_evidence_requires_confirmation');
  const saved = allMemories();
  assert.equal(saved.find(item => item.id === 'mem-p2-existing-editor').status, 'active');
  const pending = saved.find(item => item.id === result.id);
  assert.equal(pending.evidence.counterEvidence, 1);
  assert.equal(pending.evidence.consistency, 0.5);
  assert.equal(pending.evidence.explicitCorrection, false);
});

test('P2：过期来源证据不因高模型置信度直接写入', async () => {
  const result = await memory.applyCandidate(
    {
      content: '用户住在台北',
      type: 'identity',
      keywords: ['住址', '台北'],
      confidence: 0.98,
      sourceQuote: '我住在台北',
      observedAt: '2010-01-01T00:00:00.000Z',
    },
    options('s-stale', '我住在台北', { messageId: 'm-p2-stale' })
  );

  assert.equal(result.written, false);
  assert.equal(result.reason, 'stale_evidence');
  assert.deepEqual(allMemories(), []);
});

test('自动抽取：原话有不确定语气时保留可能标记、原话和待确认状态', async () => {
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
                  confidence: 0.75,
                  inferred: false,
                  sourceQuote: '我可能喜欢喝美式咖啡',
                }),
              },
            },
          ],
        }),
      },
    },
  };
  const message = '记一下，我可能喜欢喝美式咖啡';

  // 生产路径（server/index.js:3157-3162）会把可信 userId 一路带到
  // applyCandidate；测试同样显式传入，否则写侧按会话级 fail-closed，
  // 跨会话合并根本不参与判定（那道隔离由 :360 的测试单独钉住）。
  const first = await memory.processMemory(fakeClient, message, 's-a', {
    messageId: 'm-p1-hedged-a',
    userId: 'local-owner',
  });
  const second = await memory.processMemory(fakeClient, message, 's-b', {
    messageId: 'm-p1-hedged-b',
    userId: 'local-owner',
  });

  assert.equal(first.written, false);
  assert.equal(second.written, false);
  assert.equal(first.reason, 'user_hedged_requires_confirmation');
  assert.equal(second.reason, 'user_hedged_requires_confirmation');
  // 跨会话的同一 hedged 候选合并成一条 pending：贡献累积两个会话，
  // 但状态保持待确认（hedged 重复不改判；2026-11-19 Owner 拍板翻转）。
  // 此前实现被「可能：」前缀卡死配对、两条各自成单——见 findPendingCandidateForPromotion。
  const saved = allMemories();
  assert.equal(saved.length, 1);
  const merged = saved[0];
  assert.equal(merged.status, 'pending');
  assert.equal(merged.pendingReason, 'user_hedged_requires_confirmation');
  assert.equal(merged.uncertainty, 'source_hedged');
  assert.match(merged.content, /可能/);
  assert.equal(merged.provenance, 'user_asserted');
  assert.equal(merged.evidence.hedged, true);
  assert.deepEqual(
    merged.contributions.map(item => item.sessionId).sort(),
    ['s-a', 's-b']
  );
  assert.equal(merged.evidence.independentSessions, 2);

  // 后续自信直述（无犹豫语气）触发晋升：hedged 期攒的证据兑现为 active，
  // 正文剥掉「可能：」前缀——active 事实不再带犹豫标记。
  const confidentClient = {
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
                  confidence: 0.95,
                  inferred: false,
                  sourceQuote: '我喜欢喝美式咖啡',
                }),
              },
            },
          ],
        }),
      },
    },
  };
  const third = await memory.processMemory(confidentClient, '记一下，我喜欢喝美式咖啡', 's-c', {
    messageId: 'm-p1-hedged-c',
    userId: 'local-owner',
  });
  assert.equal(third.written, true);
  assert.equal(third.action, 'reinforced');
  assert.equal(third.status, 'active');

  const promoted = allMemories();
  assert.equal(promoted.length, 1);
  assert.equal(promoted[0].status, 'active');
  assert.equal(promoted[0].content, '用户喜欢喝美式咖啡');
  assert.equal(
    promoted[0].contributions.length,
    3,
    '晋升后三个会话的贡献都要留在证据链上'
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

test('strict：无显式意图的低置信偏好作为待确认候选保留', async () => {
  const result = await memory.applyCandidate(
    candidate({ confidence: 0.7 }),
    options('s-a', '我喜欢喝美式咖啡', { messageId: 'm-p1-low' })
  );

  assert.equal(result.written, false);
  assert.equal(result.reason, 'single_preference_candidate');
  assert.equal(result.status, 'pending');
  assert.equal(allMemories().length, 1);
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
    'counterEvidence',
    'quoteGrounded',
    'hedged',
    'explicitCorrection',
    'policyMode',
  ]) {
    assert.ok(key in saved.evidence, `缺少证据分量 ${key}`);
  }
  assert.equal('score' in saved.evidence, false);
  assert.equal(saved.policyVersion, 'p2.0');
  assert.equal(saved.decisionVersion, 'p2.0');
  assert.ok(saved.observedAt);
  assert.equal(saved.lastDecision.policyVersion, 'p2.0');
  assert.ok(saved.lastDecision.evidence);
});
