/* global module */
/**
 * Phase 4 第 1 项：基线快照落盘与两份快照的对比报告。
 *
 * 快照钉住"哪份评测集 + 哪个代码提交 + 什么策略版本 + 指标值 + 逐用例结果"，
 * 后续 run 可直接 diff。安全指标单列一栏，只从既有事件/死信读。
 */
const fs = require('fs');
const path = require('path');

const SCHEMA_VERSION = 'p4-eval-baseline-v1';

function createSnapshot({
  metrics,
  codeCommit = null,
  strategy = null,
  comparator = null,
  config = null,
  generatedAt = new Date().toISOString(),
} = {}) {
  if (!metrics || !metrics.suite || !metrics.metrics) {
    throw new Error('createSnapshot 需要 computeMetrics 的输出');
  }
  if (config && config.codeCommit !== (codeCommit || null)) {
    // 快照的 commit 必须与配置记录里的 commit 一致，否则"同一份代码"这句话没有依据。
    throw new Error('快照 codeCommit 与基线配置记录不一致');
  }
  return {
    schemaVersion: SCHEMA_VERSION,
    generatedAt,
    codeCommit: codeCommit || null,
    strategy: strategy ? { version: strategy.version, enabled: strategy.enabled } : null,
    // P5-A：比较对象与配置记录随快照一起存，报告才能区分「同一基线复现」与「换配置对照」。
    comparator: comparator ? { id: comparator.id, kind: comparator.kind, mechanisms: comparator.enabled, ablating: comparator.ablating } : null,
    config: config || null,
    suite: { ...metrics.suite },
    metrics: metrics.metrics,
    cases: metrics.cases,
    safety: metrics.safety,
  };
}

function writeSnapshot(snapshot, filePath) {
  const target = String(filePath || '');
  if (!target) throw new Error('writeSnapshot 需要目标路径');
  fs.mkdirSync(path.dirname(target), { recursive: true });
  const temp = `${target}.tmp-${process.pid}`;
  fs.writeFileSync(temp, `${JSON.stringify(snapshot, null, 2)}\n`, 'utf8');
  fs.renameSync(temp, target);
  return target;
}

function readSnapshot(filePath) {
  const snapshot = JSON.parse(fs.readFileSync(String(filePath), 'utf8'));
  if (snapshot.schemaVersion !== SCHEMA_VERSION) {
    throw new Error(`基线快照版本不匹配：${snapshot.schemaVersion}`);
  }
  return snapshot;
}

function metricDiff(before, after, { lowerIsBetter = false, comparable = true } = {}) {
  if (before === null || before === undefined || after === null || after === undefined) {
    return { before: before === undefined ? null : before, after: after === undefined ? null : after, delta: null, change: 'unknown', comparable };
  }
  const delta = after - before;
  let change = 'flat';
  if (delta !== 0) {
    change = (lowerIsBetter ? delta < 0 : delta > 0) ? 'improved' : 'degraded';
  }
  return { before, after, delta, change, comparable };
}

function diffCase(before, after) {
  if (!before || !after) return null;
  const fields = ['terminal', 'errorCode', 'success', 'attempts', 'rework', 'tokens', 'latencyMs', 'reviewTriggered'];
  const changes = {};
  for (const field of fields) {
    const left = before[field] === undefined ? null : before[field];
    const right = after[field] === undefined ? null : after[field];
    if (JSON.stringify(left) !== JSON.stringify(right)) {
      changes[field] = { before: left, after: right };
    }
  }
  return Object.keys(changes).length ? { caseId: after.caseId, changes } : null;
}

const SAFETY_STRICT = new Set(['approvalBypass', 'deadLetters']);

function diff(before, after) {
  if (!before || !after) throw new Error('diff 需要两份基线快照');
  const suiteChanged = before.suite.version !== after.suite.version || before.suite.digest !== after.suite.digest;
  const tokenComparable =
    Boolean(before.metrics.tokenCost.complete) && Boolean(after.metrics.tokenCost.complete);

  const metrics = {
    successRate: metricDiff(before.metrics.successRate.value, after.metrics.successRate.value),
    reworkRate: metricDiff(before.metrics.rework.rate, after.metrics.rework.rate, { lowerIsBetter: true }),
    reworkTotal: metricDiff(before.metrics.rework.total, after.metrics.rework.total, { lowerIsBetter: true }),
    tokenCostTotal: metricDiff(
      before.metrics.tokenCost.total,
      after.metrics.tokenCost.total,
      { lowerIsBetter: true, comparable: tokenComparable }
    ),
    latencyAvgMs: metricDiff(before.metrics.latency.avgMs, after.metrics.latency.avgMs, { lowerIsBetter: true }),
  };

  const beforeCases = new Map((before.cases || []).map(item => [item.caseId, item]));
  const afterCases = new Map((after.cases || []).map(item => [item.caseId, item]));
  const caseDiffs = [];
  for (const [caseId, current] of afterCases) {
    const previous = beforeCases.get(caseId);
    if (!previous) {
      caseDiffs.push({ caseId, changes: { added: { before: null, after: true } } });
      continue;
    }
    const item = diffCase(previous, current);
    if (item) caseDiffs.push(item);
  }
  for (const caseId of beforeCases.keys()) {
    if (!afterCases.has(caseId)) {
      caseDiffs.push({ caseId, changes: { removed: { before: true, after: null } } });
    }
  }

  const safetyFields = ['approvalBypass', 'failClosedHits', 'unauthorizedDenied', 'deadLetters'];
  const safety = {};
  const safetyRegressions = [];
  for (const field of safetyFields) {
    const left = Number(before.safety[field]) || 0;
    const right = Number(after.safety[field]) || 0;
    const delta = right - left;
    safety[field] = {
      before: left,
      after: right,
      delta,
      direction: SAFETY_STRICT.has(field) ? (delta > 0 ? 'degraded' : delta < 0 ? 'improved' : 'flat') : 'monitor',
    };
    if (SAFETY_STRICT.has(field) && delta > 0) safetyRegressions.push(field);
  }

  return {
    suiteChanged,
    codeCommit: { before: before.codeCommit || null, after: after.codeCommit || null },
    strategy: { before: before.strategy || null, after: after.strategy || null },
    metrics,
    tokenComparable,
    caseDiffs,
    safety,
    safetyRegressions,
    safetyDegraded: safetyRegressions.length > 0,
  };
}

module.exports = { SCHEMA_VERSION, createSnapshot, writeSnapshot, readSnapshot, diff };
