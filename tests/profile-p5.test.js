/* global __dirname, Buffer */
/**
 * 云岫 Bluebird — P5 可追溯画像与反馈验收
 *
 * 覆盖：
 * - 画像按身份/偏好/目标/关系/事实分节，带来源贡献与证据；
 * - 画像从 memory.json 派生，重启后 digest 不变（可重建）；
 * - confirm：pending 晋升、active/contested 增加确认证据、冲突裁决；
 * - deny：归档 + 墓碑，画像/检索排除，异步抽取不能复活；
 * - correct：新 active 取代旧条目，旧历史保留，更正原话进入来源；
 * - feedbackId 幂等、用户隔离、输入校验、反馈历史不含正文；
 * - GET /profile 与 POST /profile/feedback 的真实 HTTP 行为。
 *
 * 隔离：BLUEBIRD_DATA_DIR 指向系统临时目录，不读写 server/data。
 *
 * 运行：node tests/profile-p5.test.js
 */
const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'bluebird-p5-profile-'));
process.env.BLUEBIRD_DATA_DIR = TMP;
process.env.BLUEBIRD_USER_ID = 'local-owner';
process.env.BLUEBIRD_MEMORY_EVIDENCE_POLICY = 'compat';
process.env.BLUEBIRD_API_TOKEN = 'p5-profile-test-token';
process.env.BLUEBIRD_MONITORING = '0';
process.env.BLUEBIRD_RETRIEVAL = '0';
process.env.NODE_ENV = 'test';
process.env.PORT = '0';
// 空串而非 delete：避免主副本恰好存在 .env 时被 dotenv 回填成真实 key。
process.env.DEEPSEEK_API_KEY = '';

const MEMORY_FILE = path.join(TMP, 'memory.json');
const TOMBSTONE_FILE = path.join(TMP, 'memory-tombstones.json');

const memory = require(path.join(__dirname, '..', 'server', 'memory.js'));
const profile = require(path.join(__dirname, '..', 'server', 'profile.js'));
const {
  STATUS_ACTIVE,
  STATUS_PENDING,
  STATUS_CONTESTED,
  STATUS_SUPERSEDED,
  STATUS_ARCHIVED,
} = require(path.join(__dirname, '..', 'server', 'memory-lifecycle.js'));

const OWNER = 'local-owner';
const OTHER = 'user-other-p5';
const NOW = new Date().toISOString();
let seq = 0;

const origLog = console.log;
const origErr = console.error;
console.log = () => {};
console.error = () => {};

let passed = 0;
let failed = 0;
const failures = [];

function check(name, cond, extra = '') {
  if (cond) {
    passed += 1;
    origLog(`  ✔ ${name}`);
  } else {
    failed += 1;
    failures.push(name + (extra ? ` — ${extra}` : ''));
    origLog(`  ✖ ${name}${extra ? ` — ${extra}` : ''}`);
  }
}

function entry(overrides = {}) {
  seq += 1;
  const id = overrides.id || `mem-p5-${seq}`;
  const content = overrides.content || '用户喜欢美式咖啡';
  return {
    id,
    content,
    type: 'preference',
    keywords: ['咖啡', '美式'],
    confidence: 0.9,
    status: STATUS_ACTIVE,
    userId: OWNER,
    contributions: [
      {
        sessionId: 's1',
        messageId: `msg-${id}`,
        sourceQuote: content,
        createdAt: NOW,
        sourceType: 'user',
      },
    ],
    validFrom: NOW,
    validTo: null,
    createdAt: NOW,
    updatedAt: NOW,
    ...overrides,
  };
}

function seed(items) {
  try {
    fs.rmSync(TOMBSTONE_FILE, { force: true });
  } catch (_) {
    /* ignore */
  }
  fs.writeFileSync(MEMORY_FILE, JSON.stringify(items, null, 2), 'utf8');
  memory.loadMemories();
}

function allMemories() {
  return memory.getMemories({
    includePending: true,
    includeContested: true,
    includeSuperseded: true,
    includeArchived: true,
  });
}

function buildProfile(includeInactive = false) {
  return profile.buildProfile({ userId: OWNER, includeInactive });
}

function findItem(items, id) {
  return items.find(item => item.id === id) || null;
}

function search(query) {
  return memory.searchMemories({
    query,
    sessionId: 's-p5-search',
    userId: OWNER,
    limits: { maxItems: 10 },
  });
}

async function feedback(input) {
  return profile.applyProfileFeedback({ ...input, userId: OWNER });
}

async function main() {
  origLog('P5 可追溯画像与反馈');

  // ---- 1. 画像分节、来源、可重建 ----
  origLog('\n1. 画像派生与来源追溯');
  seed([
    entry({ id: 'id-1', content: '用户叫小林', type: 'identity', keywords: ['名字'] }),
    entry({ id: 'pref-1', content: '用户喜欢美式咖啡', type: 'preference' }),
    entry({ id: 'goal-1', content: '用户目标是在六月跑半马', type: 'goal', keywords: ['半马'] }),
    entry({ id: 'rel-1', content: '用户和母亲住在一起', type: 'relationship' }),
    entry({ id: 'fact-1', content: '用户住在杭州', type: 'fact', keywords: ['杭州'] }),
    entry({
      id: 'pending-1',
      content: '用户喜欢在周末跑步',
      status: STATUS_PENDING,
      pendingReason: 'single_preference_candidate',
      pendingAt: NOW,
    }),
    entry({
      id: 'contested-1',
      content: '用户喜欢在周末游泳',
      status: STATUS_CONTESTED,
      contestedAt: NOW,
      contestedReason: 'ambiguous_conflict',
      contestedBy: 'pending-1',
    }),
    entry({
      id: 'sup-1',
      content: '用户以前住在上海',
      status: STATUS_SUPERSEDED,
      supersededBy: 'fact-1',
    }),
    entry({ id: 'arch-1', content: '用户旧目标', status: STATUS_ARCHIVED }),
    entry({
      id: 'expired-1',
      content: '用户去年在学吉他',
      validTo: '2020-01-01T00:00:00.000Z',
    }),
  ]);

  const first = buildProfile(true);
  check(
    '画像元数据与派生来源',
    first.profileVersion === 'p5.0' &&
      first.userId === OWNER &&
      first.sourceOfTruth === 'memory' &&
      first.rebuildable === true &&
      /^[a-f0-9]{64}$/.test(first.digest)
  );
  check(
    '五类长期记忆各自分节',
    first.sections.identity.length === 1 &&
      first.sections.preferences.length === 1 &&
      first.sections.goals.length === 1 &&
      first.sections.relationships.length === 1 &&
      first.sections.facts.length === 1
  );
  const pref = first.sections.preferences[0];
  check(
    '条目带来源贡献（会话/消息/原话/时间）与证据字段',
    pref.memoryId === 'pref-1' &&
      pref.sources.length === 1 &&
      pref.sources[0].sessionId === 's1' &&
      pref.sources[0].messageId === 'msg-pref-1' &&
      pref.sources[0].sourceQuote === '用户喜欢美式咖啡' &&
      pref.sourceCount === 1 &&
      'evidence' in pref
  );
  check(
    'pending/contested/expired/superseded/archived 计数分离',
    first.pending.length === 1 &&
      first.contested.length === 1 &&
      first.counts.active === 5 &&
      first.counts.pending === 1 &&
      first.counts.contested === 1 &&
      first.counts.expired === 1 &&
      first.counts.superseded === 1 &&
      first.counts.archived === 1
  );
  check(
    'includeInactive 暴露历史条目与原因',
    first.inactive.some(
      item => item.memoryId === 'sup-1' && item.inactiveReason === 'superseded'
    ) &&
      first.inactive.some(
        item => item.memoryId === 'arch-1' && item.inactiveReason === 'archived'
      ) &&
      first.inactive.some(
        item => item.memoryId === 'expired-1' && item.inactiveReason === 'expired'
      )
  );
  const rebuilt = buildProfile(true);
  memory.loadMemories();
  const afterReload = buildProfile(true);
  check(
    '画像可重建：重复构建与重启后 digest 一致',
    first.digest === rebuilt.digest && first.digest === afterReload.digest
  );
  check(
    '默认视图不暴露 inactive',
    buildProfile(false).inactive.length === 0
  );

  // ---- 2. pending / contested ----
  origLog('\n2. pending / contested 不进入当前画像');
  seed([
    entry({
      id: 'p-pending',
      content: '用户可能喜欢跑步',
      status: STATUS_PENDING,
      pendingReason: 'single_preference_candidate',
      pendingAt: NOW,
    }),
    entry({
      id: 'p-contested',
      content: '用户喜欢周末游泳',
      status: STATUS_CONTESTED,
      contestedAt: NOW,
      contestedReason: 'ambiguous_conflict',
      contestedBy: 'p-pending',
    }),
  ]);
  const scoped = buildProfile(false);
  check(
    'pending 与 contested 分列，原因/挑战者保留',
    scoped.pending[0].pendingReason === 'single_preference_candidate' &&
      scoped.contested[0].contestedReason === 'ambiguous_conflict' &&
      scoped.contested[0].contestedBy === 'p-pending'
  );
  check(
    '当前分节为空，计数仍可见',
    scoped.sections.preferences.length === 0 &&
      scoped.counts.pending === 1 &&
      scoped.counts.contested === 1
  );

  // ---- 3. confirm pending ----
  origLog('\n3. 确认 pending');
  seed([
    entry({
      id: 'p-goal',
      content: '用户目标是在六月跑半马',
      type: 'goal',
      keywords: ['半马'],
      status: STATUS_PENDING,
      pendingReason: 'single_preference_candidate',
      pendingAt: NOW,
    }),
  ]);
  const confirmed = await feedback({
    action: 'confirm',
    id: 'p-goal',
    feedbackId: 'fb-confirm-pending',
  });
  check(
    'pending 晋升 active 并进入画像',
    confirmed.ok &&
      confirmed.result.status === STATUS_ACTIVE &&
      confirmed.profile.sections.goals.length === 1 &&
      confirmed.profile.pending.length === 0
  );
  const confirmedItem = buildProfile(false).sections.goals[0];
  check(
    '确认记录 confirmationCount 与 feedbackId',
    confirmedItem.feedback.confirmationCount === 1 &&
      confirmedItem.feedback.lastDecision.feedbackId === 'fb-confirm-pending'
  );
  const confirmAgain = await feedback({
    action: 'confirm',
    id: 'p-goal',
    feedbackId: 'fb-confirm-pending',
  });
  check(
    '同一 feedbackId 重复确认幂等',
    confirmAgain.ok &&
      confirmAgain.result.duplicate === true &&
      confirmAgain.profile.sections.goals[0].feedback.confirmationCount === 1
  );

  // ---- 4. confirm active ----
  origLog('\n4. 确认 active');
  seed([entry({ id: 'a-pref', content: '用户喜欢美式咖啡' })]);
  const activeConfirm1 = await feedback({
    action: 'confirm',
    id: 'a-pref',
    feedbackId: 'fb-active-1',
  });
  const activeConfirmDup = await feedback({
    action: 'confirm',
    id: 'a-pref',
    feedbackId: 'fb-active-1',
  });
  const activeConfirm2 = await feedback({
    action: 'confirm',
    id: 'a-pref',
    feedbackId: 'fb-active-2',
  });
  check(
    'active 确认增加证据且不新建条目',
    activeConfirm1.ok &&
      activeConfirmDup.result.duplicate === true &&
      activeConfirm2.ok &&
      activeConfirm2.profile.sections.preferences[0].feedback.confirmationCount === 2 &&
      allMemories().length === 1
  );
  check(
    '反馈历史记录两次独立确认',
    activeConfirm2.profile.feedback.counts.confirm === 2 &&
      activeConfirm2.profile.feedback.recent.filter(event => event.action === 'confirm').length === 2
  );

  // ---- 5. confirm contested ----
  origLog('\n5. 确认 contested');
  seed([
    entry({
      id: 'c-swim',
      content: '用户喜欢周末游泳',
      status: STATUS_CONTESTED,
      contestedAt: NOW,
      contestedReason: 'ambiguous_conflict',
      contestedBy: 'c-pending',
    }),
    entry({
      id: 'c-bike',
      content: '用户喜欢周末骑车',
      status: STATUS_CONTESTED,
      contestedAt: NOW,
      contestedReason: 'ambiguous_conflict',
      contestedBy: 'c-pending',
    }),
    entry({
      id: 'c-pending',
      content: '用户喜欢周末跑步',
      status: STATUS_PENDING,
      pendingReason: 'ambiguous_conflict',
      pendingAt: NOW,
      contestedIds: ['c-swim', 'c-bike'],
    }),
  ]);
  const contestedConfirm = await feedback({
    action: 'confirm',
    id: 'c-swim',
    feedbackId: 'fb-contested',
  });
  const afterContest = allMemories();
  check(
    '确认 contested 一方为 active',
    contestedConfirm.ok &&
      findItem(afterContest, 'c-swim').status === STATUS_ACTIVE &&
      contestedConfirm.profile.contested.length === 0 &&
      contestedConfirm.profile.sections.preferences.some(
        item => item.memoryId === 'c-swim'
      )
  );
  check(
    '挑战候选与同组 contested 被归档',
    findItem(afterContest, 'c-pending').status === STATUS_ARCHIVED &&
      findItem(afterContest, 'c-bike').status === STATUS_ARCHIVED &&
      contestedConfirm.result.archivedContested === 1
  );

  // ---- 6. deny active + tombstone ----
  origLog('\n6. 否认 active');
  seed([
    entry({
      id: 'd-active',
      content: '用户喜欢美式咖啡',
      contributions: [
        {
          sessionId: 's-deny',
          messageId: 'msg-deny',
          sourceQuote: '我喜欢美式咖啡',
          createdAt: NOW,
          sourceType: 'user',
        },
      ],
    }),
  ]);
  const denied = await feedback({
    action: 'deny',
    id: 'd-active',
    feedbackId: 'fb-deny-1',
    reason: 'user_denied_wrong_fact',
  });
  check(
    '否认后归档并记录撤回原因',
    denied.ok &&
      denied.result.status === STATUS_ARCHIVED &&
      findItem(allMemories(), 'd-active').withdrawnAt &&
      findItem(allMemories(), 'd-active').withdrawnReason === 'user_denied_wrong_fact'
  );
  check(
    '否认后画像当前分节与检索均排除',
    denied.profile.sections.preferences.length === 0 &&
      denied.profile.counts.denied === 1 &&
      search('美式咖啡').results.length === 0
  );
  check(
    'includeInactive 可以看到被否认条目',
    buildProfile(true).inactive.some(
      item => item.memoryId === 'd-active' && item.inactiveReason === 'denied'
    )
  );
  const denyAgain = await feedback({
    action: 'deny',
    id: 'd-active',
    feedbackId: 'fb-deny-1',
    reason: 'user_denied_wrong_fact',
  });
  check(
    '同一 feedbackId 重复否认幂等',
    denyAgain.ok &&
      denyAgain.result.duplicate === true &&
      denyAgain.profile.counts.denied === 1
  );
  memory.loadMemories();
  check('重启后仍被排除', search('美式咖啡').results.length === 0);
  const resurrect = await memory.applyCandidate(
    {
      content: '用户喜欢美式咖啡',
      type: 'preference',
      keywords: ['咖啡', '美式'],
      confidence: 0.95,
      sourceQuote: '我喜欢美式咖啡',
    },
    {
      sessionId: 's-deny',
      userId: OWNER,
      sourceType: 'user',
      userText: '我喜欢美式咖啡',
      requireUserGrounding: false,
      messageId: 'msg-deny',
    }
  );
  check('墓碑阻止同源异步抽取复活', resurrect.reason === 'deleted_source');
  const tombstoneText = fs.readFileSync(TOMBSTONE_FILE, 'utf8');
  check(
    '墓碑只含哈希，不含正文/原话',
    tombstoneText.includes('msg-deny') &&
      !tombstoneText.includes('用户喜欢美式咖啡')
  );

  // ---- 7. deny pending ----
  origLog('\n7. 否认 pending');
  seed([
    entry({
      id: 'd-pending',
      content: '用户可能喜欢跑步',
      status: STATUS_PENDING,
      pendingReason: 'single_preference_candidate',
      pendingAt: NOW,
    }),
  ]);
  const deniedPending = await feedback({
    action: 'deny',
    id: 'd-pending',
    feedbackId: 'fb-deny-pending',
  });
  check(
    '否认 pending 后待确认列表清空',
    deniedPending.ok &&
      deniedPending.profile.pending.length === 0 &&
      deniedPending.profile.counts.denied === 1
  );
  check(
    '否认 pending 可在审计视图追溯',
    buildProfile(true).inactive.some(
      item => item.memoryId === 'd-pending' && item.inactiveReason === 'denied'
    ) && deniedPending.profile.feedback.recent.some(event => event.action === 'deny')
  );

  // ---- 8. correct active ----
  origLog('\n8. 纠正 active');
  seed([
    entry({
      id: 'x-active',
      content: '用户喜欢美式咖啡',
      contributions: [
        {
          sessionId: 's-correct',
          messageId: 'msg-correct-old',
          sourceQuote: '我喜欢美式咖啡',
          createdAt: NOW,
          sourceType: 'user',
        },
      ],
    }),
  ]);
  const digestBefore = buildProfile(true).digest;
  const corrected = await feedback({
    action: 'correct',
    id: 'x-active',
    feedbackId: 'fb-correct-1',
    content: '用户喜欢拿铁咖啡',
    keywords: ['咖啡', '拿铁'],
  });
  const afterCorrect = allMemories();
  const oldEntry = findItem(afterCorrect, 'x-active');
  const newEntry = corrected.result ? findItem(afterCorrect, corrected.result.id) : null;
  check(
    '纠正生成新 active，旧条目 superseded',
    corrected.ok &&
      oldEntry.status === STATUS_SUPERSEDED &&
      oldEntry.supersededBy === corrected.result.id &&
      newEntry.status === STATUS_ACTIVE &&
      newEntry.content === '用户喜欢拿铁咖啡' &&
      newEntry.supersedes === 'x-active'
  );
  check(
    '来源保留旧原话并追加更正原话',
    newEntry.contributions.length === 2 &&
      newEntry.contributions.some(item => item.messageId === 'msg-correct-old') &&
      newEntry.contributions.some(item => item.messageId === 'feedback:fb-correct-1')
  );
  check(
    '画像当前分节只显示新内容',
    corrected.profile.sections.preferences.length === 1 &&
      corrected.profile.sections.preferences[0].content === '用户喜欢拿铁咖啡'
  );
  check(
    '检索只返回新内容',
    search('拿铁咖啡').results.some(item => item.content === '用户喜欢拿铁咖啡') &&
      !search('美式咖啡').results.some(item => item.content === '用户喜欢美式咖啡')
  );
  check(
    '纠正后 digest 改变，反馈历史可追溯',
    corrected.profile.digest !== digestBefore &&
      corrected.profile.feedback.recent.some(
        event =>
          event.action === 'correct' &&
          event.feedbackId === 'fb-correct-1' &&
          event.supersededId === 'x-active'
      )
  );
  const correctedAgain = await feedback({
    action: 'correct',
    id: 'x-active',
    feedbackId: 'fb-correct-1',
    content: '用户喜欢拿铁咖啡',
    keywords: ['咖啡', '拿铁'],
  });
  check(
    '同一 feedbackId 重复纠正幂等',
    correctedAgain.ok &&
      correctedAgain.result.duplicate === true &&
      correctedAgain.result.id === corrected.result.id &&
      allMemories().length === 2
  );
  const resurrectOld = await memory.applyCandidate(
    {
      content: '用户喜欢美式咖啡',
      type: 'preference',
      keywords: ['咖啡', '美式'],
      confidence: 0.95,
      sourceQuote: '我喜欢美式咖啡',
    },
    {
      sessionId: 's-correct',
      userId: OWNER,
      sourceType: 'user',
      userText: '我喜欢美式咖啡',
      requireUserGrounding: false,
      messageId: 'msg-correct-old',
    }
  );
  check('纠正后旧来源异步抽取不能复活', resurrectOld.reason === 'deleted_source');

  // ---- 9. correct pending ----
  origLog('\n9. 纠正 pending');
  seed([
    entry({
      id: 'x-pending',
      content: '用户可能喜欢跑步',
      type: 'goal',
      keywords: ['跑步'],
      status: STATUS_PENDING,
      pendingReason: 'single_preference_candidate',
      pendingAt: NOW,
    }),
  ]);
  const correctedPending = await feedback({
    action: 'correct',
    id: 'x-pending',
    feedbackId: 'fb-correct-pending',
    content: '用户目标是在六月跑半马',
    keywords: ['半马'],
  });
  const pendingOld = findItem(allMemories(), 'x-pending');
  check(
    '纠正 pending 后旧候选归档，新 active 生效',
    correctedPending.ok &&
      pendingOld.status === STATUS_ARCHIVED &&
      pendingOld.archivedReason === 'corrected_by_profile_feedback' &&
      correctedPending.profile.pending.length === 0 &&
      correctedPending.profile.sections.goals.some(
        item => item.content === '用户目标是在六月跑半马'
      )
  );

  // ---- 10. 输入校验 ----
  origLog('\n10. 反馈输入校验');
  seed([entry({ id: 'v-active', content: '用户喜欢美式咖啡' })]);
  const invalidCases = [
    [{ action: 'nope', id: 'v-active' }, 'invalid_action'],
    [{ action: 'confirm', id: '' }, 'missing_id'],
    [{ action: 'confirm', id: 'v-active', feedbackId: 'bad id!' }, 'invalid_feedback_id'],
    [{ action: 'deny', id: 'v-active', reason: 123 }, 'invalid_reason'],
    [{ action: 'deny', id: 'v-active', reason: 'x'.repeat(81) }, 'reason_too_long'],
    [{ action: 'correct', id: 'v-active', content: '' }, 'no_content'],
    [{ action: 'correct', id: 'v-active', content: '字'.repeat(101) }, 'content_too_long'],
    [{ action: 'correct', id: 'v-active', content: '我的密码是 abc12345' }, 'sensitive_content'],
    [{ action: 'correct', id: 'v-active', content: '用户喜欢拿铁', type: 'unknown' }, 'type_not_allowed'],
    [{ action: 'correct', id: 'v-active', content: '用户喜欢拿铁', confidence: 2 }, 'invalid_confidence'],
    [{ action: 'correct', id: 'v-active', content: '用户喜欢美式咖啡' }, 'no_change'],
  ];
  const invalidResults = [];
  for (const [input, expected] of invalidCases) {
    const result = await feedback(input);
    invalidResults.push({ expected, reason: result.reason, status: result.status });
  }
  check(
    '非法输入返回稳定短码与 4xx/409',
    invalidResults.every(
      item =>
        item.reason === item.expected &&
        [400, 409].includes(item.status)
    ) &&
      allMemories().length === 1 &&
      allMemories()[0].content === '用户喜欢美式咖啡'
  );

  seed([
    entry({ id: 'cf-1', content: '用户喜欢美式咖啡' }),
    entry({ id: 'cf-2', content: '用户住在杭州', type: 'fact', keywords: ['杭州'] }),
  ]);
  const conflictFirst = await feedback({
    action: 'correct',
    id: 'cf-1',
    feedbackId: 'fb-cross-target',
    content: '用户喜欢拿铁咖啡',
  });
  const conflictSecond = await feedback({
    action: 'correct',
    id: 'cf-2',
    feedbackId: 'fb-cross-target',
    content: '用户住在上海',
  });
  check(
    'feedbackId 不能跨条目复用',
    conflictFirst.ok &&
      conflictSecond.ok === false &&
      conflictSecond.reason === 'feedback_id_conflict' &&
      conflictSecond.status === 409
  );

  // ---- 11. 用户隔离 ----
  origLog('\n11. 用户隔离');
  seed([
    entry({ id: 'own-1', content: '用户喜欢美式咖啡' }),
    entry({
      id: 'other-1',
      content: '另一个用户喜欢拿铁',
      userId: OTHER,
      contributions: [
        {
          sessionId: 's-other',
          messageId: 'msg-other',
          sourceQuote: '我喜欢拿铁',
          createdAt: NOW,
          sourceType: 'user',
        },
      ],
    }),
  ]);
  const ownProfile = buildProfile(false);
  const otherProfile = profile.buildProfile({ userId: OTHER });
  const foreignDeny = await feedback({
    action: 'deny',
    id: 'other-1',
    feedbackId: 'fb-foreign',
  });
  check(
    '画像只包含本人记忆',
    ownProfile.sections.preferences.some(item => item.memoryId === 'own-1') &&
      !ownProfile.sections.preferences.some(item => item.memoryId === 'other-1') &&
      otherProfile.sections.preferences.some(item => item.memoryId === 'other-1')
  );
  check(
    '跨用户反馈被拒绝且数据不变',
    foreignDeny.ok === false &&
      foreignDeny.reason === 'forbidden' &&
      foreignDeny.status === 403 &&
      findItem(allMemories(), 'other-1').status === STATUS_ACTIVE
  );

  // ---- 12. 反馈历史隐私 ----
  origLog('\n12. 反馈历史不含正文');
  seed([
    entry({ id: 'h-1', content: '用户喜欢美式咖啡' }),
    entry({ id: 'h-2', content: '用户住在杭州', type: 'fact', keywords: ['杭州'] }),
  ]);
  await feedback({ action: 'confirm', id: 'h-1', feedbackId: 'fb-h-confirm' });
  await feedback({ action: 'deny', id: 'h-2', feedbackId: 'fb-h-deny' });
  const historyProfile = buildProfile(true);
  check(
    '反馈历史包含 confirm/deny 且不含正文',
    historyProfile.feedback.recent.some(event => event.action === 'confirm') &&
      historyProfile.feedback.recent.some(event => event.action === 'deny') &&
      historyProfile.feedback.recent.every(
        event =>
          !Object.prototype.hasOwnProperty.call(event, 'content') &&
          !Object.prototype.hasOwnProperty.call(event, 'sourceQuote')
      )
  );

  // ---- 13. HTTP ----
  origLog('\n13. HTTP 接口');
  seed([
    entry({
      id: 'http-1',
      content: '用户喜欢美式咖啡',
      contributions: [
        {
          sessionId: 's-http',
          messageId: 'msg-http',
          sourceQuote: '我喜欢美式咖啡',
          createdAt: NOW,
          sourceType: 'user',
        },
      ],
    }),
    entry({
      id: 'http-other',
      content: '另一个用户喜欢拿铁',
      userId: OTHER,
      contributions: [
        {
          sessionId: 's-http-other',
          messageId: 'msg-http-other',
          sourceQuote: '我喜欢拿铁',
          createdAt: NOW,
          sourceType: 'user',
        },
      ],
    }),
  ]);

  const { server } = require(path.join(__dirname, '..', 'server', 'index.js'));
  if (!server.listening) {
    await new Promise(resolve => server.once('listening', resolve));
  }
  const base = `http://127.0.0.1:${server.address().port}`;
  const token = 'p5-profile-test-token';

  async function req(urlPath, { method = 'GET', auth = true, body } = {}) {
    const res = await fetch(base + urlPath, {
      method,
      headers: {
        'Content-Type': 'application/json',
        // 避免 undici 保活连接在进程退出时与 libuv 关闭句柄竞态。
        Connection: 'close',
        ...(auth ? { Authorization: `Bearer ${token}` } : {}),
      },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    let json = null;
    try {
      json = await res.json();
    } catch (_) {
      /* ignore */
    }
    return { status: res.status, json };
  }

  const getProfile = await req('/profile');
  check(
    'GET /profile 返回画像',
    getProfile.status === 200 &&
      getProfile.json.profile.userId === OWNER &&
      getProfile.json.profile.sections.preferences.some(
        item => item.memoryId === 'http-1'
      )
  );
  const getNoAuth = await req('/profile', { auth: false });
  check('GET /profile 需要鉴权', getNoAuth.status === 401);
  const badQuery = await req('/profile?includeInactive=maybe');
  check('includeInactive 非法值返回 400', badQuery.status === 400);
  const httpCorrect = await req('/profile/feedback', {
    method: 'POST',
    body: {
      action: 'correct',
      id: 'http-1',
      content: '用户喜欢拿铁咖啡',
      feedbackId: 'fb-http-1',
    },
  });
  check(
    'POST /profile/feedback 纠正生效',
    httpCorrect.status === 200 &&
      httpCorrect.json.ok === true &&
      httpCorrect.json.profile.sections.preferences.some(
        item => item.content === '用户喜欢拿铁咖啡'
      )
  );
  const httpInvalid = await req('/profile/feedback', {
    method: 'POST',
    body: { action: 'nope', id: 'http-1' },
  });
  check(
    '非法 action 返回 400 短码',
    httpInvalid.status === 400 && httpInvalid.json.code === 'invalid_action'
  );
  const httpForeign = await req('/profile/feedback', {
    method: 'POST',
    body: { action: 'deny', id: 'http-other', feedbackId: 'fb-http-foreign' },
  });
  check(
    '跨用户反馈返回 403',
    httpForeign.status === 403 && httpForeign.json.code === 'forbidden'
  );

  if (typeof server.closeAllConnections === 'function') server.closeAllConnections();
  await new Promise(resolve => server.close(resolve));
  await new Promise(resolve => setTimeout(resolve, 150));

  try {
    fs.rmSync(TMP, { recursive: true, force: true });
  } catch (_) {
    /* Windows 上可能仍有句柄，不影响结论 */
  }

  console.log = origLog;
  console.error = origErr;
  origLog(`\nP5 profile: ${passed} passed, ${failed} failed`);
  if (failed) {
    origLog('Failures:');
    for (const item of failures) origLog(`  - ${item}`);
    process.exit(1);
  }
  process.exit(0);
}

main().catch(error => {
  console.log = origLog;
  console.error = origErr;
  origErr('P5 profile test error:', error);
  try {
    fs.rmSync(TMP, { recursive: true, force: true });
  } catch (_) {
    /* ignore */
  }
  process.exit(1);
});
