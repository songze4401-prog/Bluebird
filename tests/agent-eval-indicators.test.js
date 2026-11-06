/* global require, process, __dirname */
/**
 * P5-A 第 2 轮：§7 八项质量指标（过度拆解率 / 并行耗时收益 / 失败恢复率 /
 * 重复副作用率 / 证据完整率 / 来源独立性 / Reviewer 检出率 / 审批命中率与误拦截率）。
 *
 * 这一轮的核心纪律是**"没采到就是 unknown，不许报 0"**：
 * 把观测缺口报成 0% 质量指标，比没有指标更危险。所以每个用例都同时验证
 * 有数据时的数值口径与没数据时的 unknown 形态（含 caveat 说明缺什么）。
 *
 * 隔离纪律：BLUEBIRD_DATA_DIR 在 require server/ 之前指向临时目录。
 */
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const test = require('node:test');
const { spawnSync } = require('child_process');

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'bluebird-p7-ind-'));
process.env.BLUEBIRD_DATA_DIR = path.join(TMP, 'store');
process.env.DEEPSEEK_API_KEY = '';
process.env.BLUEBIRD_MONITORING = '0';

const REPO_ROOT = path.resolve(__dirname, '..');
const CLI = path.join(REPO_ROOT, 'scripts', 'eval-offline.js');
const indicators = require('../server/agents/eval-indicators');
const opLedger = require('../server/agents/op-ledger');

const N = Date.UTC(2026, 10, 7, 3, 0, 0);

/** 产物归属表：artifactId → 产生它的任务。 */
function lookupWith(map) {
  return id => (Object.prototype.hasOwnProperty.call(map, id) ? { id, taskId: map[id] } : null);
}

test('a. 八项齐全且缺数据时一律 unknown，绝不回落成 0', () => {
  const empty = indicators.computeAll({});
  assert.equal(empty.policyVersion, 'p7-indicators-v1');
  assert.equal(empty.indicators.length, 9, '八项里审批占两行（命中率 + 误拦截率）');
  const names = empty.indicators.map(item => item.name);
  for (const required of ['over_decomposition', 'parallel_time_gain', 'failure_recovery', 'duplicate_side_effect', 'evidence_completeness', 'source_independence', 'reviewer_detection', 'approval_precision']) {
    assert.ok(names.includes(required), `缺少指标 ${required}`);
  }
  for (const item of empty.indicators) {
    assert.equal(item.known, false, `${item.name} 无数据时必须 unknown`);
    assert.equal(item.value, null, `${item.name} 不许把未知报成 0`);
    assert.equal(item.denominator, 0);
    assert.ok(typeof item.definition === 'string' && item.definition.length > 8);
    assert.ok(typeof item.source === 'string' && item.source.length > 4, `${item.name} 必须写清数据来源`);
  }
  assert.equal(empty.summary.total, 9);
  assert.equal(empty.summary.known, 0);
  assert.equal(empty.summary.unknownNames.length, 9);
  // 每项都要说清"缺什么才能算"，否则报告只会留下一排 unknown。
  assert.ok(empty.indicators.every(item => item.known || (item.caveat && item.caveat.length > 4)));
});

test('b. 过度拆解率：只算真正没引用子任务产物的根任务', () => {
  const tasks = [
    { taskId: 'root-a', parentTaskId: null, provenanceRefs: [{ kind: 'artifact', id: 'art-child-1' }] },
    { taskId: 'child-a1', parentTaskId: 'root-a', provenanceRefs: [] },
    { taskId: 'child-a2', parentTaskId: 'root-a', provenanceRefs: [] },
    { taskId: 'root-b', parentTaskId: null, provenanceRefs: [{ kind: 'artifact', id: 'art-other' }] },
    { taskId: 'child-b1', parentTaskId: 'root-b', provenanceRefs: [] },
    { taskId: 'child-b2', parentTaskId: 'root-b', provenanceRefs: [] },
    // 单子任务不算"拆解"，不进分母。
    { taskId: 'root-c', parentTaskId: null, provenanceRefs: [] },
    { taskId: 'child-c1', parentTaskId: 'root-c', provenanceRefs: [] },
  ];
  const lookup = lookupWith({ 'art-child-1': 'child-a1', 'art-other': 'root-elsewhere' });
  const result = indicators.overDecomposition({ tasks, artifactLookup: lookup, artifactsOfTask: () => [] });
  assert.equal(result.denominator, 2, '只有 ≥2 个子任务的根任务进分母');
  assert.equal(result.numerator, 1, 'root-b 的产物来自外部任务，仍算过度拆解');
  assert.equal(result.value, 0.5);

  // 根任务自己的 provenanceRefs 是空的，但它发布的结论产物引用了子任务产物：
  // 这一条必须算"引用了子任务成果"，否则 §16 的真实链路（证据钉在产物上）会被判成过度拆解。
  const viaArtifact = indicators.overDecomposition({
    tasks: [
      { taskId: 'root-d', parentTaskId: null, provenanceRefs: [] },
      { taskId: 'child-d1', parentTaskId: 'root-d', provenanceRefs: [] },
      { taskId: 'child-d2', parentTaskId: 'root-d', provenanceRefs: [] },
    ],
    artifactLookup: lookupWith({ 'art-child-d': 'child-d1' }),
    artifactsOfTask: taskId => (taskId === 'root-d' ? [{ id: 'conclusion-d', provenanceRefs: [{ kind: 'source', id: 'art-child-d', version: 1 }] }] : []),
  });
  assert.equal(viaArtifact.numerator, 0, '证据在产物上也算引用了子任务');
  assert.equal(viaArtifact.denominator, 1);

  // 缺任一注入（归属查询 / 产物视图）都判不了来源，必须是 unknown，
  // 而不是把每个根任务都判成过度拆解（假阳性）或都判正常（假阴性）。
  for (const blind of [
    indicators.overDecomposition({ tasks }),
    indicators.overDecomposition({ tasks, artifactLookup: lookup }),
    indicators.overDecomposition({ tasks, artifactsOfTask: () => [] }),
  ]) {
    assert.equal(blind.known, false);
    assert.equal(blind.denominator, 0);
    assert.match(blind.caveat, /artifactLookup \/ artifactsOfTask/);
  }
  assert.equal(indicators.overDecomposition({ tasks }).unknown, 2, '判不了的根任务样本数进 unknown 计数');
});

test('c. 并行耗时收益：允许负数，缺成对快照时 unknown', () => {
  const snapshot = (avgMs, kind) => ({
    comparator: { id: kind, kind },
    metrics: { latency: { avgMs, totalMs: avgMs * 10, maxMs: avgMs * 2, unknownCases: 0, complete: true } },
  });
  const faster = indicators.parallelTimeGain({ single: snapshot(1000, 'single_agent_fast_path'), team: snapshot(600, 'candidate') });
  assert.equal(faster.value, 0.4, '组队快 40% 时收益是 +0.4');
  assert.equal(faster.known, true);
  // 两侧原始平均延迟必须一起带出：只有比率的报告无法自证分子分母是哪来的。
  assert.equal(faster.singleAvgMs, 1000);
  assert.equal(faster.teamAvgMs, 600);

  const slower = indicators.parallelTimeGain({ single: snapshot(600, 'single_agent_fast_path'), team: snapshot(1000, 'candidate') });
  assert.equal(slower.value, -0.6666666666666666, '组队更慢必须如实报负数，不能夹成 0');

  const missing = indicators.parallelTimeGain({ single: null, team: snapshot(600, 'candidate') });
  assert.equal(missing.known, false);
  assert.equal(missing.value, null);
  assert.match(missing.caveat, /成对的单跑\/组队快照/);

  const zeroBase = indicators.parallelTimeGain({ single: snapshot(0, 'single_agent_fast_path'), team: snapshot(600, 'candidate') });
  assert.equal(zeroBase.known, false, '分母为 0 时不能报无穷大收益');
});

test('d. 失败恢复率：以 run 历史里的失败 attempt 为分母', () => {
  const tasks = [
    { taskId: 't1', status: 'completed', runs: [{ status: 'failed' }, { status: 'completed' }] },
    { taskId: 't2', status: 'failed', runs: [{ status: 'failed' }, { status: 'failed' }] },
    { taskId: 't3', status: 'completed', runs: [{ status: 'completed' }] },
    { taskId: 't4', status: 'recovery', runs: [{ status: 'failed' }, { status: 'recovery' }] },
  ];
  const result = indicators.failureRecovery({ tasks });
  assert.equal(result.denominator, 3, '只有一次成功 attempt 的 t3 不进分母');
  assert.equal(result.numerator, 1);
  assert.equal(result.value, 1 / 3);

  const noFailures = indicators.failureRecovery({ tasks: [{ taskId: 'x', status: 'completed', runs: [{ status: 'completed' }] }] });
  assert.equal(noFailures.known, false);
  assert.match(noFailures.caveat, /没有失败过/);
});

test('e. 重复副作用率：executions 缺失的旧账本条目计 unknown，不稀释分母', () => {
  const args = { agentId: 'executor', taskId: 'task-dup', stepId: 'step-1', toolName: 'memory_remember', args: { text: '同一段' } };
  const first = opLedger.begin({ ...args, now: N });
  assert.equal(first.entry.executions, 0, '新记录 executions 从 0 起算');
  opLedger.finish(first.opKey, { status: 'succeeded', result: { ok: true, id: 'm1' }, now: N + 10 });
  const afterFirst = opLedger.get(first.opKey);
  assert.equal(afterFirst.executions, 1);
  // 真实场景是超时被判 unknown 后重试又成功：同一 opKey 第二次记 succeeded，
  // 说明副作用确实做了两次。账本不拦（拦是 begin 的职责），但要看得见。
  opLedger.finish(first.opKey, { status: 'succeeded', result: { ok: true, id: 'm1' }, now: N + 20 });
  assert.equal(opLedger.get(first.opKey).executions, 2, '同一 opKey 被记两次成功 = 重复副作用');

  const other = opLedger.begin({ ...args, taskId: 'task-clean', stepId: 'step-2', now: N + 30 });
  opLedger.finish(other.opKey, { status: 'succeeded', result: { ok: true, id: 'm2' }, now: N + 40 });
  const failed = opLedger.begin({ ...args, taskId: 'task-fail', stepId: 'step-3', now: N + 50 });
  opLedger.finish(failed.opKey, { status: 'failed', errorCode: 'tool_error', now: N + 60 });
  assert.equal(opLedger.get(failed.opKey).executions, 0, '失败不算一次真实副作用执行');

  const ops = Object.values(opLedger.read().ops);
  const withField = indicators.duplicateSideEffect({ ops });
  assert.equal(withField.denominator, 3);
  assert.equal(withField.numerator, 1);
  assert.equal(withField.value, 1 / 3);
  assert.equal(withField.unknown, 0);

  const legacy = indicators.duplicateSideEffect({ ops: [{ opKey: 'old', status: 'succeeded' }, ...ops] });
  assert.equal(legacy.unknown, 1, '没有 executions 字段的旧条目单独计 unknown');
  assert.equal(legacy.denominator, 3, '旧条目不进分母，否则指标会被稀释成 0');

  // 空账本的说明必须说"这批样本没有副作用调用"，不能推给"字段还没上线"——
  // 两种 unknown 的原因不同，报告要指出缺的是数据还是埋点。
  const noRows = indicators.duplicateSideEffect({ ops: [] });
  assert.equal(noRows.known, false);
  assert.equal(noRows.unknown, 0);
  assert.match(noRows.caveat, /账本里没有条目/);
  assert.doesNotMatch(noRows.caveat, /随本轮上线/);
});

test('f. 证据完整率与来源独立性：读回失败与来源不明都不算通过', () => {
  const tasks = [
    { taskId: 't-full', status: 'completed', provenanceRefs: [{ kind: 'artifact', id: 'a1' }, { kind: 'artifact', id: 'a2' }] },
    { taskId: 't-broken', status: 'completed', provenanceRefs: [{ kind: 'artifact', id: 'a3' }] },
    { taskId: 't-empty', status: 'completed', provenanceRefs: [] },
    { taskId: 't-running', status: 'running', provenanceRefs: [{ kind: 'artifact', id: 'a1' }] },
  ];
  const artifacts = { a1: { taskId: 'other-1' }, a2: { taskId: 'other-2' }, a3: { taskId: 't-broken' } };
  // a3 故意模拟"产物在但正文/哈希读不回"：verifyRefsReadable 会给出 reason。
  const verify = refs => refs.filter(ref => ref.id === 'a3').map(ref => ({ artifactId: ref.id, reason: 'content_unreadable' }));
  const completeness = indicators.evidenceCompleteness({ tasks, verifyRefs: verify, artifactsOfTask: () => [] });
  assert.equal(completeness.denominator, 3, '只有 completed 且带 provenanceRefs 字段的任务进分母');
  assert.equal(completeness.numerator, 1, '引用为空或有读回问题都不算完整');

  // 缺读回校验、缺产物视图，两种情况都不许报数：
  // 没有产物视图时看不到钉在产物上的证据，报出来的 0% 是假的。
  for (const blind of [
    indicators.evidenceCompleteness({ tasks }),
    indicators.evidenceCompleteness({ tasks, verifyRefs: verify }),
    indicators.evidenceCompleteness({ tasks, artifactsOfTask: () => [] }),
  ]) {
    assert.equal(blind.known, false, '没有读回校验与产物视图时不许报 0%');
    assert.equal(blind.unknown, 3);
  }

  const independence = indicators.sourceIndependence({
    tasks,
    artifactLookup: id => (artifacts[id] ? { id, taskId: artifacts[id].taskId } : null),
    artifactsOfTask: () => [],
  });
  assert.equal(independence.denominator, 3, '来源查不到的引用不进分母');
  assert.equal(independence.numerator, 2, 'a1/a2 来自别的任务，a3 是自证');
  assert.equal(independence.value, 2 / 3);
  assert.equal(independence.unknown, 0);

  // §16 真实链路：交付证据钉在**产物**的 provenanceRefs 上，任务字段是空的。
  // 只看任务字段会把这条判成"零证据"，两个指标都必须看见产物级引用。
  const artifactCarried = [{ taskId: 't-own', status: 'completed', provenanceRefs: [] }];
  const carriedLookups = {
    artifactLookup: id => (id === 'a1' ? { id, taskId: 'other-1' } : id === 'a-self' ? { id, taskId: 't-own' } : null),
    artifactsOfTask: taskId => (taskId === 't-own'
      ? [{ id: 'conclusion-1', provenanceRefs: [{ kind: 'source', id: 'a1', version: 1 }, { kind: 'source', id: 'a-self', version: 1 }] }]
      : []),
  };
  const carriedCompleteness = indicators.evidenceCompleteness({
    tasks: artifactCarried,
    verifyRefs: () => [],
    artifactsOfTask: carriedLookups.artifactsOfTask,
  });
  assert.equal(carriedCompleteness.numerator, 1, '证据在产物上也算完整，不得报 0');
  const carriedIndependence = indicators.sourceIndependence({
    tasks: artifactCarried,
    artifactLookup: carriedLookups.artifactLookup,
    artifactsOfTask: carriedLookups.artifactsOfTask,
  });
  assert.equal(carriedIndependence.denominator, 2, '产物级引用进分母');
  assert.equal(carriedIndependence.numerator, 1, '一条来自别的任务、一条是自证');

  // 同一引用在任务级和产物级各出现一次时只算一次，否则分母会被重复引用灌水。
  const deduped = indicators.sourceIndependence({
    tasks: [{ taskId: 't-dup', status: 'completed', provenanceRefs: [{ kind: 'source', id: 'a1', version: 1 }] }],
    artifactLookup: id => (id === 'a1' ? { id, taskId: 'other-1' } : null),
    artifactsOfTask: () => [{ id: 'concl', provenanceRefs: [{ kind: 'source', id: 'a1', version: 1 }] }],
  });
  assert.equal(deduped.denominator, 1, '同一 (id, version) 去重');

  // 缺 id 的残缺引用：不许悄悄丢掉，也不许当成"完整"。
  const malformed = indicators.evidenceCompleteness({
    tasks: [{ taskId: 't-bad', status: 'completed', provenanceRefs: [{ kind: 'source' }] }],
    verifyRefs: () => [],
    artifactsOfTask: () => [],
  });
  assert.equal(malformed.numerator, 0, '残缺引用不算完整');
  assert.equal(malformed.denominator, 1);

  const noRefs = indicators.sourceIndependence({
    tasks: [{ taskId: 'x', status: 'completed', provenanceRefs: [] }],
    artifactLookup: () => null,
    artifactsOfTask: () => [],
  });
  assert.equal(noRefs.known, false);
  const untraceable = indicators.sourceIndependence({
    tasks: [{ taskId: 'y', status: 'completed', provenanceRefs: [{ kind: 'artifact', id: 'ghost' }] }],
    artifactLookup: () => null,
    artifactsOfTask: () => [],
  });
  assert.equal(untraceable.known, false);
  assert.equal(untraceable.unknown, 1, '产物查不到产生方时按 unknown 计，不当成"不独立"');
});

test('g. Reviewer 检出率与审批两率：混淆矩阵口径，命中率+误拦截率=1', () => {
  const events = [
    { taskId: 'p1', eventType: 'verification.verdict', payload: { deterministicOk: false, verdict: 'reject' } },
    { taskId: 'p2', eventType: 'verification.verdict', payload: { deterministicOk: false, verdict: 'needs_human' } },
    { taskId: 'p3', eventType: 'verification.verdict', payload: { deterministicOk: false, verdict: 'pass' } },
    { taskId: 'c1', eventType: 'verification.verdict', payload: { deterministicOk: true, verdict: 'pass' } },
    { taskId: 'c2', eventType: 'verification.verdict', payload: { deterministicOk: true, verdict: 'reject' } },
    { taskId: 'ignored', eventType: 'verification.review_opened', payload: { deterministicOk: false } },
  ];
  const detection = indicators.reviewerDetection({ events });
  assert.equal(detection.confusion.total, 5, '只有裁决类事件进矩阵，review_opened 不算');
  assert.equal(detection.confusion.problems, 3);
  assert.equal(detection.confusion.caught, 2, 'TP=2（reject / needs_human 都算未放行）');
  assert.equal(detection.confusion.falseAlarms, 1, 'FP=1（机械校验通过却被拒）');
  assert.equal(detection.detection.value, 2 / 3);

  const approvals = [
    { taskId: 'p1', status: 'rejected' },
    { taskId: 'p3', status: 'expired' },
    { taskId: 'c2', status: 'escalated' },
    { taskId: 'unknown-task', status: 'rejected' },
    { taskId: 'c1', status: 'approved' },
  ];
  const verdictsByTask = new Map([
    ['p1', { deterministicOk: false, conflict: false }],
    ['p3', { deterministicOk: false, conflict: false }],
    ['c2', { deterministicOk: true, conflict: false }],
    ['c1', { deterministicOk: true, conflict: false }],
  ]);
  const quality = indicators.approvalQuality({ approvals, verdictsByTask });
  assert.equal(quality.hitRate.denominator, 3, '分母只含拿到裁决事实的阻断性决定');
  assert.equal(quality.hitRate.numerator, 2);
  assert.equal(quality.hitRate.unknown, 1, '裁决事实缺失的审批记录单独计 unknown，不稀释分母');
  assert.equal(quality.falseBlockRate.numerator, 1);
  assert.equal(quality.hitRate.value, 2 / 3);
  assert.equal(quality.hitRate.value + quality.falseBlockRate.value, 1, '同分母，两率互补');
  assert.equal(quality.approvedCleanCount, 1);

  // 只有阻断性决定、全部拿不到裁决事实时：两率都是 unknown，而不是"0% 命中"。
  const allBlind = indicators.approvalQuality({ approvals: [{ taskId: 'x', status: 'rejected' }], verdictsByTask: new Map() });
  assert.equal(allBlind.hitRate.known, false);
  assert.equal(allBlind.hitRate.value, null);
  assert.match(allBlind.hitRate.caveat, /拿不到对应裁决事实/);

  // 冲突裁决落在 verification.conflict 上（auditResolution 同一份载荷换了事件类型）。
  // 只认 verdict 事件会看不见冲突样本，审批命中率就把"确实有冲突"的阻断决定报成误拦截。
  const conflictRun = indicators.computeAll({
    tasks: [],
    events: [
      { taskId: 'k1', eventType: 'verification.conflict', payload: { deterministicOk: true, verdict: 'needs_human', conflict: true } },
      { taskId: 'k2', eventType: 'verification.conflict', payload: { status: 'conflict', decision: 'unresolved' } },
    ],
    approvals: [
      { taskId: 'k1', status: 'rejected' },
      { taskId: 'k2', status: 'escalated' },
      { taskId: 'k3', status: 'rejected' },
    ],
    now: N,
  });
  const conflictHit = conflictRun.indicators.find(item => item.name === 'approval_precision');
  assert.equal(conflictHit.denominator, 2, 'k1/k2 都拿得到冲突事实，k3 没有任何裁决事件');
  assert.equal(conflictHit.numerator, 2, '两条阻断决定对应的任务确有冲突，都是命中');
  assert.equal(conflictHit.unknown, 1, '没有任何裁决事实的审批记录计 unknown');
  assert.equal(conflictHit.value, 1);
  assert.equal(conflictRun.indicators.find(item => item.name === 'approval_false_block').numerator, 0);

  const conflictDetection = conflictRun.indicators.find(item => item.name === 'reviewer_detection');
  assert.equal(conflictDetection.confusion.total, 2, '两类裁决事件都进矩阵');
  assert.equal(conflictDetection.confusion.classifiable, 1, 'k2 既无 deterministicOk 也无 verdict，无法归类');
  assert.equal(conflictDetection.unknown, 1, '归不了类的行数单独报出来，不静默丢弃');
  assert.equal(conflictDetection.known, false, '只剩一条可归类且机械校验通过 → 分母 0，按 unknown');
});

test('h. 聚合与只读保证：指标不改传入数据，汇总如实标出 unknown', () => {
  const tasks = [
    { taskId: 'r1', status: 'completed', provenanceRefs: [{ kind: 'artifact', id: 'a1' }], runs: [{ status: 'failed' }, { status: 'completed' }] },
    { taskId: 'c1', parentTaskId: 'r1', provenanceRefs: [], status: 'completed', runs: [{ status: 'completed' }] },
    { taskId: 'c2', parentTaskId: 'r1', provenanceRefs: [], status: 'completed', runs: [{ status: 'completed' }] },
  ];
  const snapshot = JSON.stringify({ tasks, events: [], approvals: [] });
  const result = indicators.computeAll({
    tasks,
    events: [{ taskId: 'r1', eventType: 'verification.verdict', payload: { deterministicOk: true, verdict: 'pass' } }],
    ops: [{ opKey: 'k1', status: 'succeeded', executions: 1 }],
    approvals: [],
    singleSnapshot: { metrics: { latency: { avgMs: 900 } } },
    teamSnapshot: { metrics: { latency: { avgMs: 500 } } },
    verifyRefs: () => [],
    artifactLookup: lookupWith({ a1: 'c1' }),
    artifactsOfTask: () => [],
    now: N,
  });
  assert.equal(JSON.stringify({ tasks, events: [], approvals: [] }), snapshot, 'computeAll 必须只读');
  assert.equal(result.at, new Date(N).toISOString());
  // 这份样本能算出 6 项；Reviewer 检出率（没有机械校验不通过的样本）与审批两率（没有审批记录）
  // 必须是 unknown——这正是"不拿 0 冒充结论"的落点。
  assert.equal(result.summary.known, 6);
  assert.equal(result.summary.unknown, 3);
  assert.deepEqual(
    result.indicators.filter(item => item.known).map(item => item.name).sort(),
    [
      'duplicate_side_effect',
      'evidence_completeness',
      'failure_recovery',
      'over_decomposition',
      'parallel_time_gain',
      'source_independence',
    ].sort()
  );
  assert.deepEqual(
    result.indicators.filter(item => !item.known).map(item => item.name).sort(),
    ['approval_false_block', 'approval_precision', 'reviewer_detection'].sort()
  );
  assert.equal(result.indicators.find(item => item.name === 'parallel_time_gain').value, 400 / 900);
  assert.equal(result.indicators.find(item => item.name === 'failure_recovery').value, 1);
  assert.equal(result.indicators.find(item => item.name === 'over_decomposition').value, 0);
  assert.equal(result.indicators.find(item => item.name === 'source_independence').value, 1);
  assert.equal(result.indicators.find(item => item.name === 'duplicate_side_effect').value, 0);
  assert.equal(result.indicators.find(item => item.name === 'reviewer_detection').denominator, 0);
});

test('i. 真实存储形状：证据钉在产物、冲突走 verification.conflict 时仍能算出数', () => {
  // 前面每个用例都用自造对象。本轮两个缺陷（§16 证据挂在产物上、冲突裁决换事件类型）
  // 恰好都是"fixture 形状与真实存储不一致"造成的假数，所以这一条坚持用真实存储写入、
  // 再按 CLI 的同一套注入读回，并核对 CLI 自己的输出。
  const taskStore = require('../server/agents/tasks');
  const artifactStore = require('../server/agents/artifact-store');
  const approvalStore = require('../server/agents/approvals');

  const finish = task => {
    taskStore.transitionTask(task.taskId, { to: 'accepted' });
    taskStore.transitionTask(task.taskId, { to: 'running' });
    taskStore.transitionTask(task.taskId, { to: 'completed', result: { status: 'completed', summary: '完成' } });
    return taskStore.getTask(task.taskId);
  };
  const make = (agentId, goal, extra) => taskStore.createTask({
    agentId,
    taskType: 'memory.recall',
    goal,
    allowedTools: ['memory_search'],
    deadlineMs: 30000,
    ...extra,
  });

  const root = make('researcher', '汇总两个来源');
  const childA = make('researcher', '来源 A', { parentTaskId: root.taskId });
  const childB = make('researcher', '来源 B', { parentTaskId: root.taskId });

  // §16 的真实链路：子任务产 source，根任务的 conclusion 把证据钉在**产物**的 provenanceRefs 上，
  // 任务自身的 provenanceRefs 是空的。
  const sourceA = artifactStore.persist({
    kind: 'source',
    content: { text: '来源 A 原文' },
    taskId: childA.taskId,
    sourceLabels: ['web:vendor-a.example'],
  });
  artifactStore.persist({
    kind: 'source',
    content: { text: '来源 B 原文' },
    taskId: childB.taskId,
    sourceLabels: ['web:vendor-b.example'],
  });
  const conclusion = artifactStore.persist({
    kind: 'conclusion',
    content: { subject: 'A 与 B 的汇总结论', evidence: [{ kind: 'source', id: sourceA.id, version: sourceA.version }] },
    taskId: root.taskId,
    provenanceRefs: [{ kind: 'source', id: sourceA.id, version: sourceA.version }],
    sourceLabels: ['agent:derived'],
  });
  finish(root);
  finish(childA);
  finish(childB);

  taskStore.appendEvent({
    botId: 'researcher',
    taskId: root.taskId,
    eventType: 'verification.verdict',
    payload: { deterministicOk: false, verdict: 'needs_human', checkCode: 'citation_missing' },
  });
  taskStore.appendEvent({
    botId: 'researcher',
    taskId: childA.taskId,
    eventType: 'verification.conflict',
    payload: { deterministicOk: true, verdict: 'reject', conflict: true },
  });

  const approval = approvalStore.createApproval({
    botId: 'researcher',
    operation: 'review.conflict',
    payload: { producerTaskId: root.taskId, artifactId: conclusion.id, version: conclusion.version, verdict: 'needs_human', conflict: true },
    taskId: root.taskId,
  });
  approvalStore.reject(approval.approvalId, { actor: 'user:owner', reason: '来源不足，驳回' });

  const byProducer = new Map();
  for (const artifact of artifactStore.all()) {
    const key = String(artifact.taskId || '');
    if (!key) continue;
    const list = byProducer.get(key) || [];
    list.push(artifact);
    byProducer.set(key, list);
  }
  const injections = {
    tasks: taskStore.allTasks(),
    events: taskStore.listEvents('researcher', { limit: 200 }),
    ops: Object.values(opLedger.read().ops || {}),
    approvals: approvalStore.listApprovals('researcher', { limit: 200 }),
    verifyRefs: refs => artifactStore.verifyRefsReadable(refs),
    artifactLookup: id => artifactStore.get(id),
    artifactsOfTask: taskId => byProducer.get(String(taskId)) || [],
  };
  const view = indicators.computeAll(injections);
  const named = name => view.indicators.find(item => item.name === name);

  // 过度拆解率：根任务有两个子任务，且结论引用了子任务的产物 → 不是过度拆解。
  // （只看任务字段的老读法会把这条判成过度拆解——就是本轮修掉的假阳性。）
  const over = named('over_decomposition');
  assert.equal(over.denominator, 1, '两个子任务的根任务进分母');
  assert.equal(over.numerator, 0, '证据在产物上也算引用了子任务成果');
  assert.equal(over.value, 0);

  // 证据完整率：根任务引用可回读 → 完整；两个子任务没有交付证据 → 不完整。
  const evidence = named('evidence_completeness');
  assert.equal(evidence.denominator, 3);
  assert.equal(evidence.numerator, 1);

  // 来源独立性：结论引用的 source 由 childA 产生，不是根任务自证。
  const independence = named('source_independence');
  assert.equal(independence.denominator, 1);
  assert.equal(independence.numerator, 1);

  // Reviewer 检出率：冲突事件与裁决事件都要进矩阵，否则漏掉一半样本。
  const detection = named('reviewer_detection');
  assert.equal(detection.confusion.total, 2, 'verdict + conflict 两类事件都进矩阵');
  assert.equal(detection.confusion.problems, 1);
  assert.equal(detection.value, 1, 'needs_human 属于未放行 → TP');

  // 审批命中率：驳回的这条确实有机械校验不过的事实。
  const precision = named('approval_precision');
  assert.equal(precision.denominator, 1);
  assert.equal(precision.numerator, 1);
  assert.equal(precision.value, 1);

  // 同一份注入必须等于 CLI 的输出：CLI 少注入一个依赖就会得到不同的数。
  const cli = spawnSync(process.execPath, [CLI, '--indicators=true'], {
    cwd: REPO_ROOT,
    encoding: 'utf8',
    env: { ...process.env, BLUEBIRD_DATA_DIR: process.env.BLUEBIRD_DATA_DIR },
    maxBuffer: 64 * 1024 * 1024,
  });
  assert.equal(cli.status, 0, cli.stderr);
  const cliLine = String(cli.stdout).split('\n').find(line => line.includes('] eval-indicators '));
  const cliView = JSON.parse(cliLine.slice(cliLine.indexOf('{')));
  assert.deepEqual(
    cliView.indicators.map(item => [item.name, item.numerator, item.denominator]),
    view.indicators.map(item => [item.name, item.numerator, item.denominator]),
    'CLI 与模块注入必须给同一组数字'
  );
});

test('j. CLI：--indicators 出九行指标与 unknown 清单，--require-indicators 缺数拦', () => {
  const run = (dir, extraArgs) => spawnSync(process.execPath, [CLI, ...extraArgs], {
    cwd: REPO_ROOT,
    encoding: 'utf8',
    env: { ...process.env, BLUEBIRD_DATA_DIR: dir },
    maxBuffer: 64 * 1024 * 1024,
  });
  const parse = res => {
    const row = String(res.stdout).split('\n').find(line => line.includes('] eval-indicators '));
    assert.ok(row, 'CLI 缺少 eval-indicators 证据行');
    return JSON.parse(row.slice(row.indexOf('{')));
  };
  const dir = path.join(TMP, 'cli-ind');
  const defaultRun = run(dir, ['--indicators=true']);
  assert.equal(defaultRun.status, 0, defaultRun.stderr);
  const view = parse(defaultRun);
  assert.equal(view.indicators.length, 9);
  assert.equal(view.policyVersion, 'p7-indicators-v1');
  assert.ok(view.summary.unknownNames.length >= 5, '空仓库里大部分指标应当是 unknown');
  for (const item of view.indicators) {
    if (!item.known) assert.equal(item.value, null, `${item.name} 的未知值必须是 null`);
    assert.ok(item.source.includes('task') || item.source.includes('事件') || item.source.includes('账本') || item.source.includes('快照') || item.source.includes('artifact'), `${item.name} 要写清来源`);
  }

  const strict = run(dir, ['--indicators=true', '--require-indicators=over_decomposition,parallel_time_gain']);
  assert.equal(strict.status, 1, '显式要求有数时缺数必须非零退出');
  assert.match(String(strict.stderr), /eval-indicators-required-missing/);
});

test.after(() => {
  fs.rmSync(TMP, { recursive: true, force: true });
});
