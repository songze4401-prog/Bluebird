/* global module */
/**
 * P5-A 第 2 轮（Notion §7）八项质量指标 + P5-E（§13）补漏检率独立成行。
 *
 * 原文要求 Runtime 的评测必须覆盖：过度拆解率、并行耗时收益、失败恢复率、
 * 重复副作用率、证据完整率、来源独立性、Reviewer 检出率、审批命中率与误拦截率；
 * §13 另点名「漏检率」，P5-E 起与检出率互为补数、独立成行（reviewer_miss_rate）。
 *
 * 三条硬约束（与 Phase 0 / §2.4 一致，违反就等于造了第二套口径）：
 *  1. **只读既有事实来源**：任务与 run 历史（tasks）、事件（tasks.listEvents）、
 *     幂等账本（op-ledger）、审批记录（approvals）、产物与污点（artifact-store）、
 *     对照快照（eval-baseline / eval-comparators）。本模块不写任何存储，不新增状态。
 *  2. **算不出来就是 unknown，绝不回落到 0**：与 `eval-metrics` 的未知桶同一纪律——
 *     分母为 0 或字段缺失时 `known:false`，值必须是 null。把"没采到"报成 0% 会把
 *     观测缺口伪装成质量达标。
 *  3. **每个指标自带定义与数据来源**：报告里能直接回答"这个数怎么来的、缺什么才能算"。
 *
 * 并行耗时收益刻意允许负数：组队比单跑更慢是真实结论，不是要修的显示问题。
 */

// v2（P5-E / §13）：漏检率（reviewer_miss_rate）独立成行，与检出率互补；
// 指标名单变了就升版本，不让同一版本号指向两份名单。
const INDICATOR_POLICY_VERSION = 'p7-indicators-v2';

const INDICATOR_NAMES = Object.freeze([
  'over_decomposition',
  'parallel_time_gain',
  'failure_recovery',
  'duplicate_side_effect',
  'evidence_completeness',
  'source_independence',
  'reviewer_detection',
  'reviewer_miss_rate',
  'approval_precision',
]);

function row({ name, label, definition, source, numerator, denominator, unknown = 0, caveat = null, ...extra }) {
  const known = denominator > 0;
  return {
    name,
    label,
    definition,
    source,
    known,
    value: known ? numerator / denominator : null,
    numerator,
    denominator,
    unknown,
    // 指标自带的补充口径（混淆矩阵、两侧平均延迟）原样带出：报告要能自证数字怎么来的。
    ...extra,
    ...(caveat ? { caveat } : {}),
  };
}

function ratio(list, predicate) {
  const hit = list.filter(predicate).length;
  return { numerator: hit, denominator: list.length };
}

/**
 * 交付证据集的读法（§16）：`task.provenanceRefs` 只是链路的一半。
 * 共享结论与交付物把证据钉在**产物的 `provenanceRefs`** 上
 * （`artifact-commit.publishSharedConclusion`），只读任务字段会把真实 e2e 判成
 * "零证据"（假阴性）。这里取两处并集并按 `(id, version)` 去重；
 * 缺 id 的引用单独计 malformed，不能当作"不存在"悄悄丢掉。
 */
function collectEvidenceRefs(task, artifactsOfTask) {
  const raw = [];
  if (Array.isArray(task.provenanceRefs)) raw.push(...task.provenanceRefs);
  const artifacts = typeof artifactsOfTask === 'function' ? artifactsOfTask(task.taskId) || [] : [];
  for (const artifact of artifacts) {
    if (artifact && Array.isArray(artifact.provenanceRefs)) raw.push(...artifact.provenanceRefs);
  }
  const seen = new Set();
  const refs = [];
  let malformed = 0;
  for (const ref of raw) {
    if (!ref || !ref.id) {
      malformed += 1;
      continue;
    }
    const key = `${ref.id}@${ref.version === undefined ? 0 : ref.version}`;
    if (seen.has(key)) continue;
    seen.add(key);
    refs.push(ref);
  }
  return { refs, malformed, artifactCount: artifacts.length, hasTaskField: Array.isArray(task.provenanceRefs) };
}

/** 证据视图缺依赖时的统一 unknown 行：说清缺哪一个，不猜数。 */
function blindRow(name, label, definition, source, sampleCount, missing) {
  return row({
    name,
    label,
    definition,
    source,
    numerator: 0,
    denominator: 0,
    unknown: sampleCount,
    caveat: `未注入 ${missing}，样本无法判定，按 unknown 计`,
  });
}

/** 1) 过度拆解率：拆出 ≥2 个子任务但成果没有任何一条来自子任务的根任务占比。 */
function overDecomposition({ tasks = [], artifactLookup = null, artifactsOfTask = null } = {}) {
  const byParent = new Map();
  for (const task of tasks) {
    if (!task || !task.parentTaskId) continue;
    const list = byParent.get(task.parentTaskId) || [];
    list.push(task);
    byParent.set(task.parentTaskId, list);
  }
  const roots = [];
  for (const task of tasks) {
    if (!task || task.parentTaskId) continue;
    const children = byParent.get(task.taskId) || [];
    if (children.length < 2) continue;
    roots.push({ task, children });
  }
  // 没有产物归属/产物视图就判不了"引用是否来自子任务"。此时按不可算处理：
  // 把 denominator 留 0 而不是让每个根任务都被判成过度拆解（假阳性）或都判正常（假阴性）。
  if (typeof artifactLookup !== 'function' || typeof artifactsOfTask !== 'function') {
    return blindRow(
      'over_decomposition',
      '过度拆解率',
      '子任务数 ≥2 的根任务中，最终成果未引用任何子任务产物的占比',
      'tasks.allTasks() 的 parentTaskId + 任务与产物的 provenanceRefs + artifact-store 的产生任务归属',
      roots.length,
      '产物归属或产物视图（artifactLookup / artifactsOfTask）'
    );
  }
  const { numerator, denominator } = ratio(roots, item => {
    const childIds = new Set(item.children.map(child => child.taskId));
    const { refs } = collectEvidenceRefs(item.task, artifactsOfTask);
    return !refs.some(ref => {
      const artifact = artifactLookup(ref.id);
      return artifact && childIds.has(artifact.taskId);
    });
  });
  return row({
    name: 'over_decomposition',
    label: '过度拆解率',
    definition: '子任务数 ≥2 的根任务中，最终成果未引用任何子任务产物的占比',
    source: 'tasks.allTasks() 的 parentTaskId + 任务与产物的 provenanceRefs + artifact-store 的产生任务归属',
    numerator,
    denominator,
    caveat: denominator === 0 ? '本轮没有多子任务的根任务样本，无法判定拆解是否过度' : null,
  });
}

/** 2) 并行耗时收益：单执行体与组队的平均延迟相对改善（正数=组队更快，负数=组队更慢）。 */
function parallelTimeGain({ single = null, team = null } = {}) {
  const singleMs = single && single.metrics && single.metrics.latency ? single.metrics.latency.avgMs : null;
  const teamMs = team && team.metrics && team.metrics.latency ? team.metrics.latency.avgMs : null;
  const usable = Number.isFinite(singleMs) && Number.isFinite(teamMs) && singleMs > 0;
  return row({
    name: 'parallel_time_gain',
    label: '并行耗时收益',
    definition: '(单执行体平均延迟 − 组队平均延迟) / 单执行体平均延迟，来自同一数据集的两类比较对象快照',
    source: 'eval-baseline 快照的 metrics.latency.avgMs（comparator=single_agent_fast_path 与 runtime_with_capability/candidate）',
    numerator: usable ? singleMs - teamMs : 0,
    denominator: usable ? singleMs : 0,
    singleAvgMs: singleMs,
    teamAvgMs: teamMs,
    caveat: usable ? null : '缺少成对的单跑/组队快照，或单跑延迟为 0，收益比例不可算',
  });
}

/** 3) 失败恢复率：有过失败 attempt 的任务中最终 completed 的占比。 */
function failureRecovery({ tasks = [] } = {}) {
  const failed = tasks.filter(task => {
    if (!task) return false;
    const runs = Array.isArray(task.runs) ? task.runs : [];
    return runs.some(run => run && run.status === 'failed');
  });
  const { numerator, denominator } = ratio(failed, task => task.status === 'completed');
  return row({
    name: 'failure_recovery',
    label: '失败恢复率',
    definition: '至少有一次失败 attempt 的任务中，终态为 completed 的占比',
    source: 'tasks.allTasks() 的 runs[].status 与终态 status',
    numerator,
    denominator,
    caveat: denominator === 0 ? '本轮样本里没有失败过的任务' : null,
  });
}

/** 4) 重复副作用率：同一逻辑动作被记到多次真实执行的占比（账本 executions 字段）。 */
function duplicateSideEffect({ ops = [] } = {}) {
  // 旧记录没有 executions 字段：它们既不算分子也不算分母，单独计 unknown，
  // 否则"加了字段之前的所有账本"会把指标稀释成 0。
  const known = ops.filter(op => Number.isFinite(Number(op && op.executions)));
  const { numerator, denominator } = ratio(known, op => Number(op.executions) > 1);
  return row({
    name: 'duplicate_side_effect',
    label: '重复副作用率',
    definition: '幂等账本中 executions > 1 的条目占所有带 executions 字段条目的比例',
    source: '幂等账本 op-ledger.read().ops（executions 由 finish 在记 succeeded 时累加）',
    numerator,
    denominator,
    unknown: ops.length - known.length,
    caveat: known.length === 0
      ? (ops.length === 0
          ? '幂等账本里没有条目：这批样本没有产生带副作用的工具调用'
          : '账本条目还没有 executions 字段（该字段随本轮上线，旧条目不回填）')
      : null,
  });
}

/** 5) 证据完整率：completed 任务里"证据引用非空且全部可回读"的占比。 */
function evidenceCompleteness({ tasks = [], verifyRefs = null, artifactsOfTask = null } = {}) {
  const completed = tasks.filter(task => task && task.status === 'completed' && Array.isArray(task.provenanceRefs));
  if (typeof verifyRefs !== 'function' || typeof artifactsOfTask !== 'function') {
    // 同上：没有读回校验与产物视图就不要报"0% 完整"，那会把观测缺口说成质量问题。
    return blindRow(
      'evidence_completeness',
      '证据完整率',
      '终态 completed 的任务中，交付证据集（任务级 + 其产物的 provenanceRefs）非空、无残缺引用且全部可读回无问题的占比',
      'tasks.allTasks() + artifact-store.verifyRefsReadable() + 该任务产生的产物的 provenanceRefs',
      completed.length,
      'verifyRefs 读回校验或产物视图（artifactsOfTask）'
    );
  }
  const { numerator, denominator } = ratio(completed, task => {
    const { refs, malformed } = collectEvidenceRefs(task, artifactsOfTask);
    if (refs.length === 0 || malformed > 0) return false;
    return verifyRefs(refs).length === 0;
  });
  return row({
    name: 'evidence_completeness',
    label: '证据完整率',
    definition: '终态 completed 的任务中，交付证据集（任务级 + 其产物的 provenanceRefs）非空、无残缺引用且全部可读回无问题的占比',
    source: 'tasks.allTasks() + artifact-store.verifyRefsReadable() + 该任务产生的产物的 provenanceRefs',
    numerator,
    denominator,
  });
}

/** 6) 来源独立性：被采纳的证据里来自别的任务（而非自证）的占比。 */
function sourceIndependence({ tasks = [], artifactLookup = null, artifactsOfTask = null } = {}) {
  const samples = tasks.filter(
    task => task && task.status === 'completed' && Array.isArray(task.provenanceRefs)
  );
  if (typeof artifactLookup !== 'function' || typeof artifactsOfTask !== 'function') {
    return blindRow(
      'source_independence',
      '来源独立性',
      'completed 任务交付证据集里"产生任务 ≠ 消费任务"的占比；来源查不到的引用单独计 unknown',
      'tasks.allTasks() + artifact-store.get(id).taskId（任务级与产物级 provenanceRefs 并集）',
      samples.length,
      '产物归属或产物视图（artifactLookup / artifactsOfTask）'
    );
  }
  let numerator = 0;
  let denominator = 0;
  let unknown = 0;
  for (const task of samples) {
    // 只算"已采纳"的证据：还在 running 的任务引用尚未定稿，计进来会把独立性虚推高。
    const { refs, malformed } = collectEvidenceRefs(task, artifactsOfTask);
    unknown += malformed;
    for (const ref of refs) {
      const artifact = artifactLookup(ref.id);
      if (!artifact || artifact.taskId === undefined) {
        // 查不到产生方的引用不计入分母：把"来源不明"当成"不独立"会虚报独立性缺口。
        unknown += 1;
        continue;
      }
      denominator += 1;
      if (String(artifact.taskId) !== String(task.taskId)) numerator += 1;
    }
  }
  return row({
    name: 'source_independence',
    label: '来源独立性',
    definition: 'completed 任务交付证据集里"产生任务 ≠ 消费任务"的占比；来源查不到的引用单独计 unknown',
    source: 'tasks.allTasks() + artifact-store.get(id).taskId（任务级与产物级 provenanceRefs 并集）',
    numerator,
    denominator,
    unknown,
    caveat: denominator === 0 ? '样本里还没有可追溯产生方的产物引用' : null,
  });
}

/**
 * 7) Reviewer 检出率 + 8) 审批命中率/误拦截率的共同原料：
 *    以既有验证闭环审计事件为混淆矩阵来源——
 *    机械校验结果（deterministicOk）是可复核的"真值"，Reviewer 裁决（verdict）是被测的分类。
 *
 *    同一条审计会落在**两个**事件类型上（`verification-loop.auditResolution`）：
 *    正常裁决 → `verification.verdict`，冲突 → `verification.conflict`。
 *    只认前者会把冲突样本整体看不见，审批侧就会把真实冲突误判成"误拦截"（假阴性）。
 */
const VERDICT_EVENT_TYPES = Object.freeze(['verification.verdict', 'verification.conflict']);

function verdictRows({ events = [] } = {}) {
  return events.filter(event => event && VERDICT_EVENT_TYPES.includes(event.eventType));
}

/** 一行审计能否进混淆矩阵：既要有真值（deterministicOk），也要有被测分类（verdict）。 */
function classifiableRow(event) {
  const payload = (event && event.payload) || {};
  return (payload.deterministicOk === true || payload.deterministicOk === false)
    && typeof payload.verdict === 'string'
    && payload.verdict.length > 0;
}

function conflictFactOf(event) {
  const payload = (event && event.payload) || {};
  if (event && event.eventType === 'verification.conflict') return true;
  return payload.conflict === true || payload.decision === 'conflict';
}

function reviewerDetection({ events = [] } = {}) {
  const rows = verdictRows({ events });
  const classifiable = rows.filter(classifiableRow);
  const unclassified = rows.length - classifiable.length;
  const problems = classifiable.filter(event => event.payload.deterministicOk === false);
  const caught = problems.filter(event => event.payload.verdict !== 'pass');
  const clean = classifiable.filter(event => event.payload.deterministicOk === true);
  const falseAlarm = clean.filter(event => event.payload.verdict !== 'pass');
  const confusion = {
    total: rows.length,
    classifiable: classifiable.length,
    unclassified,
    problems: problems.length,
    caught: caught.length,
    falseAlarms: falseAlarm.length,
  };
  return {
    detection: row({
      name: 'reviewer_detection',
      label: 'Reviewer 检出率',
      definition: '机械校验判定为有问题的样本中，Reviewer 未给出 pass 的占比（TP / (TP+FN)）；缺真值或缺 verdict 的事件单独计 unclassified，不进分母',
      source: 'verification.verdict 与 verification.conflict 事件的 deterministicOk 与 verdict 字段',
      numerator: caught.length,
      denominator: problems.length,
      unknown: unclassified,
      confusion,
      caveat: problems.length === 0
        ? (rows.length === 0
            ? '样本里没有验证裁决事件'
            : '样本里没有机械校验不通过的用例，或有不带 deterministicOk/verdict 的裁决事件')
        : null,
    }),
    // P5-E / §13：漏检率单独成行（FN / (TP+FN)），与检出率互为补数——原文点名
    // 「漏检率与误拦截率」，此前只有检出率，误拦截率在审批侧 falseBlockRate。
    missRate: row({
      name: 'reviewer_miss_rate',
      label: 'Reviewer 漏检率',
      definition: '机械校验判定为有问题的样本中，Reviewer 给出 pass（漏检）的占比（FN / (TP+FN)）；与 reviewer_detection 互为补数，独立成行满足 §13 指标名',
      source: 'verification.verdict 与 verification.conflict 事件的 deterministicOk 与 verdict 字段',
      numerator: problems.length - caught.length,
      denominator: problems.length,
      unknown: unclassified,
      confusion,
      caveat: problems.length === 0
        ? (rows.length === 0
            ? '样本里没有验证裁决事件'
            : '样本里没有机械校验不通过的用例，或有不带 deterministicOk/verdict 的裁决事件')
        : null,
    }),
    confusion,
  };
}

/**
 * 审批侧两个指标共用一次遍历：
 *  - 命中率：审批拦下来的确实是有问题的（机械校验不过或冲突）；
 *  - 误拦截率：审批拦下来但其实没问题（机械校验通过且非冲突）。
 * 分母都是"审批产生过阻断性决定"的记录数，缺 riskLevel/裁决事实的记录单独计 unknown。
 */
function approvalQuality({ approvals = [], verdictsByTask = new Map() } = {}) {
  const blockingAll = approvals.filter(record => record && (record.status === 'rejected' || record.status === 'expired' || record.status === 'escalated'));
  // 分母只取"有裁决事实可比对"的阻断性决定：裁决缺失的记录单独计 unknown，
  // 留在分母里会把命中率稀释成假的低值（也会被误读成"审批在漏放"）。
  const blocking = blockingAll.filter(record => verdictsByTask.has(String(record.taskId || '')));
  const unknown = blockingAll.length - blocking.length;
  const confirmed = blocking.filter(record => {
    const verdict = verdictsByTask.get(String(record.taskId || ''));
    return verdict.deterministicOk === false || verdict.conflict === true;
  });
  const approvedAndClean = approvals.filter(record => {
    if (!record || record.status !== 'approved') return false;
    const verdict = verdictsByTask.get(String(record.taskId || ''));
    return verdict && verdict.deterministicOk === true;
  });
  return {
    hitRate: row({
      name: 'approval_precision',
      label: '审批命中率',
      definition: '阻断性审批决定（rejected/expired/escalated）中，机械校验确实不通过或存在冲突的占比；分母只含拿到裁决事实的记录',
      source: 'approvals.listApprovals() 的状态 + verification.verdict / verification.conflict 事件',
      numerator: confirmed.length,
      denominator: blocking.length,
      unknown,
      caveat: blocking.length === 0 ? (blockingAll.length ? '有阻断性审批决定但都拿不到对应裁决事实' : '本轮没有阻断性审批决定') : null,
    }),
    // 误拦截率与命中率同分母、互补：阻断性决定里机械校验其实通过且无冲突的部分。
    falseBlockRate: row({
      name: 'approval_false_block',
      label: '审批误拦截率',
      definition: '阻断性审批决定中，机械校验通过且无冲突的占比（与命中率同分母，两者相加为 1）',
      source: 'approvals.listApprovals() 的状态 + verification.verdict / verification.conflict 事件（与命中率同分母）',
      numerator: blocking.length - confirmed.length,
      denominator: blocking.length,
      unknown,
      caveat: blocking.length === 0 ? (blockingAll.length ? '有阻断性审批决定但都拿不到对应裁决事实' : '本轮没有阻断性审批决定') : null,
    }),
    approvedCleanCount: approvedAndClean.length,
  };
}

/** 聚合：一次算全八项，返回逐条行 + 汇总（已知数、未知数）。 */
function computeAll({
  tasks = [],
  events = [],
  ops = [],
  approvals = [],
  singleSnapshot = null,
  teamSnapshot = null,
  verifyRefs = null,
  artifactLookup = null,
  artifactsOfTask = null,
  now = Date.now(),
} = {}) {
  const detection = reviewerDetection({ events });
  const verdictsByTask = new Map();
  for (const event of verdictRows({ events })) {
    if (!event || !event.taskId) continue;
    const payload = event.payload || {};
    const previous = verdictsByTask.get(String(event.taskId)) || { deterministicOk: null, conflict: false, verdict: null };
    verdictsByTask.set(String(event.taskId), {
      deterministicOk: payload.deterministicOk === undefined ? previous.deterministicOk : payload.deterministicOk,
      conflict: previous.conflict || conflictFactOf(event),
      verdict: typeof payload.verdict === 'string' && payload.verdict.length > 0 ? payload.verdict : previous.verdict,
    });
  }
  const approvalsView = approvalQuality({ approvals, verdictsByTask });
  const independence = sourceIndependence({ tasks, artifactLookup, artifactsOfTask });
  const evidence = evidenceCompleteness({ tasks, verifyRefs, artifactsOfTask });
  const overDecomp = overDecomposition({ tasks, artifactLookup, artifactsOfTask });
  const recovery = failureRecovery({ tasks });
  const duplicate = duplicateSideEffect({ ops });
  const parallel = parallelTimeGain({ single: singleSnapshot, team: teamSnapshot });

  const indicators = [
    overDecomp,
    parallel,
    recovery,
    duplicate,
    evidence,
    independence,
    detection.detection,
    detection.missRate,
    approvalsView.hitRate,
    approvalsView.falseBlockRate,
  ];
  const known = indicators.filter(item => item.known);
  return {
    policyVersion: INDICATOR_POLICY_VERSION,
    at: new Date(now).toISOString(),
    requiredIndicators: INDICATOR_NAMES.slice(),
    indicators,
    summary: {
      total: indicators.length,
      known: known.length,
      unknown: indicators.length - known.length,
      unknownNames: indicators.filter(item => !item.known).map(item => item.name),
    },
    reviewerConfusion: detection.confusion,
    approvedCleanCount: approvalsView.approvedCleanCount,
  };
}

module.exports = {
  INDICATOR_NAMES,
  INDICATOR_POLICY_VERSION,
  approvalQuality,
  collectEvidenceRefs,
  computeAll,
  duplicateSideEffect,
  evidenceCompleteness,
  failureRecovery,
  overDecomposition,
  parallelTimeGain,
  reviewerDetection,
  sourceIndependence,
  verdictRows,
};
