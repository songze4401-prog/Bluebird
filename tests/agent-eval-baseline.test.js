/* global process */
/**
 * Phase 4 第 1 项：离线评测集 + 基线度量。
 * 覆盖：评测集版本化、离线重放可复现、单任务聚合、多任务汇总不双计与未知桶、
 * 基线快照与 diff（含安全指标退化）、策略版本开关与回滚、安全指标读既有事件。
 */
const fs = require('fs');
const os = require('os');
const path = require('path');
const test = require('node:test');
const assert = require('node:assert');

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'bluebird-agent-eval-'));
process.env.BLUEBIRD_DATA_DIR = TMP;

const tasks = require('../server/agents/tasks');
const suiteLoader = require('../server/agents/eval-suite');
const runner = require('../server/agents/eval-runner');
const metrics = require('../server/agents/eval-metrics');
const baseline = require('../server/agents/eval-baseline');
const strategyVersion = require('../server/agents/strategy-version');

const AGENTS_DIR = path.join(TMP, 'agents');

function resetStore() {
  fs.rmSync(AGENTS_DIR, { recursive: true, force: true });
  tasks.reloadForTests();
}

function runEvaluation() {
  const suite = runner.runSuite();
  return { suite, computed: metrics.computeMetrics({ suite: suite.suite, results: suite.results }) };
}

function caseOf(computed, caseId) {
  return computed.cases.find(item => item.caseId === caseId);
}

test('a. 评测集固定可版本化：字段校验通过、digest 稳定、非法用例被拒绝', () => {
  const first = suiteLoader.loadSuite();
  const second = suiteLoader.loadSuite();
  assert.equal(first.version, 'p4-eval-v1');
  assert.equal(first.caseCount, 13);
  assert.equal(first.digest, second.digest);
  assert.equal(first.digest.length, 64);
  for (const item of first.cases) {
    assert.ok(item.goal && item.agentId && item.taskType);
    assert.ok(Array.isArray(item.allowedErrorCodes));
    assert.equal(typeof item.expectReview, 'boolean');
    assert.ok(item.budgetTokenCap > 0);
  }
  const bad = path.join(TMP, 'bad-suite.json');
  fs.writeFileSync(
    bad,
    JSON.stringify({ version: 'bad', cases: [{ id: 'x', goal: 'g', agentId: 'researcher', taskType: 'memory.recall' }] })
  );
  assert.throws(() => suiteLoader.loadSuite(bad), /expectedTerminal|allowedErrorCodes|expectReview/);
});

test('b. 离线重放可复现：同一评测集两次跑出的逐用例结果一致', () => {
  resetStore();
  const first = runner.runSuite().results;
  resetStore();
  const second = runner.runSuite().results;
  const pick = rows => rows.map(row => ({
    caseId: row.caseId,
    attempts: row.attempts,
    rework: row.rework,
    latencyMs: row.latencyMs,
    startedAt: row.startedAt,
    finishedAt: row.finishedAt,
  }));
  assert.deepEqual(pick(first), pick(second));
});

test('c. 单任务聚合：重试用例 attempts=2、rework=1、token=180、latency=900ms', () => {
  resetStore();
  const { computed } = runEvaluation();
  const retry = caseOf(computed, 'retry-then-success');
  assert.equal(retry.terminal, 'completed');
  assert.equal(retry.attempts, 2);
  assert.equal(retry.rework, 1);
  assert.equal(retry.tokens, 180);
  assert.equal(retry.usageKnown, true);
  assert.equal(retry.latencyMs, 900);
  assert.equal(retry.success, true);
});

test('d. 多任务汇总不双计；无 usage 进未知桶且 token 不为 0', () => {
  resetStore();
  const { computed } = runEvaluation();
  const known = computed.cases.filter(item => item.usageKnown);
  const sum = known.reduce((total, item) => total + item.tokens, 0);
  assert.equal(computed.metrics.tokenCost.total, sum);
  assert.equal(computed.metrics.tokenCost.total, 1620);
  assert.equal(computed.metrics.tokenCost.knownCases, 11);
  assert.equal(computed.metrics.tokenCost.unknownCases, 2);
  assert.equal(computed.metrics.tokenCost.unknownTokens, null);
  assert.equal(computed.metrics.tokenCost.complete, false);
  const unknown = caseOf(computed, 'unknown-usage-success');
  assert.equal(unknown.tokens, null);
  assert.equal(unknown.usageKnown, false);
  assert.equal(unknown.unknownAttempts, 1);
  // 未知用例仍然计入成功率，但绝不被当成 0 token 的已知成本。
  assert.equal(unknown.success, true);
});

test('e. 基线快照含集版本/提交/逐例结果；diff 识别改善与安全退化', () => {
  resetStore();
  const { computed } = runEvaluation();
  const snapshot = baseline.createSnapshot({ metrics: computed, codeCommit: 'e90fbd1', strategy: strategyVersion.get() });
  assert.equal(snapshot.suite.digest, computed.suite.digest);
  assert.equal(snapshot.codeCommit, 'e90fbd1');
  assert.equal(snapshot.cases.length, computed.cases.length);

  const file = path.join(TMP, 'baseline-a.json');
  baseline.writeSnapshot(snapshot, file);
  const reloaded = baseline.readSnapshot(file);
  assert.equal(reloaded.schemaVersion, baseline.SCHEMA_VERSION);
  assert.deepEqual(reloaded.metrics, snapshot.metrics);

  const degraded = JSON.parse(JSON.stringify(snapshot));
  degraded.codeCommit = 'working-tree';
  degraded.metrics.successRate.value = 0.6;
  degraded.metrics.rework.rate = 0.4;
  degraded.metrics.tokenCost.total = 2000;
  degraded.metrics.latency.avgMs = 2000;
  degraded.safety.approvalBypass = 1;
  degraded.safety.deadLetters = 2;

  const worse = baseline.diff(snapshot, degraded);
  assert.equal(worse.metrics.successRate.change, 'degraded');
  assert.equal(worse.metrics.reworkRate.change, 'degraded');
  assert.equal(worse.metrics.tokenCostTotal.change, 'degraded');
  assert.equal(worse.metrics.latencyAvgMs.change, 'degraded');
  assert.equal(worse.safetyDegraded, true);
  assert.deepEqual(worse.safetyRegressions.sort(), ['approvalBypass', 'deadLetters']);

  const better = baseline.diff(degraded, snapshot);
  assert.equal(better.metrics.successRate.change, 'improved');
  assert.equal(better.safetyDegraded, false);

  const caseChange = JSON.parse(JSON.stringify(snapshot));
  caseChange.cases[2].tokens = 190;
  const perCase = baseline.diff(snapshot, caseChange);
  assert.equal(perCase.caseDiffs.length, 1);
  assert.equal(perCase.caseDiffs[0].changes.tokens.before, 180);
  assert.equal(perCase.caseDiffs[0].changes.tokens.after, 190);
});

test('f. 策略版本：版本标识 + 开关 + 回滚闭环', () => {
  resetStore();
  assert.equal(strategyVersion.get().version, 'p4-default');
  const applied = strategyVersion.apply({ version: 'p4-canary-v2' });
  assert.equal(applied.version, 'p4-canary-v2');
  assert.equal(applied.previousVersion, 'p4-default');
  assert.equal(applied.enabled, true);
  const off = strategyVersion.setEnabled(false);
  assert.equal(off.enabled, false);
  assert.equal(off.version, 'p4-canary-v2');
  const rolled = strategyVersion.rollback();
  assert.equal(rolled.version, 'p4-default');
  assert.equal(rolled.enabled, true);
});

test('g. 安全指标从既有事件读取：越权拒绝计入 fail-closed 与 unauthorizedDenied', () => {
  resetStore();
  const { suite, computed } = runEvaluation();
  assert.equal(computed.safety.unauthorizedDenied, 0);
  const target = suite.results[0];
  tasks.appendEvent({
    botId: target.agentId,
    taskId: target.taskId,
    eventType: 'worker.scope_denied',
    payload: { targetType: 'task', targetId: 'other-task', access: 'denied', reason: 'scope_mismatch' },
  });
  const after = metrics.computeMetrics({ suite: suite.suite, results: suite.results });
  assert.equal(after.safety.unauthorizedDenied, 1);
  assert.equal(after.safety.failClosedHits, 1);
  assert.equal(after.safety.approvalBypass, 0);

  // 应审校但没有任何审校事件 → 计为审批/审校绕过（同一份既有事件口径）。
  const bypassTask = tasks.createTask({
    botId: 'executor',
    taskType: 'action.execute',
    goal: '未审校的执行任务',
  });
  tasks.transitionTask(bypassTask.taskId, { to: 'accepted' });
  tasks.transitionTask(bypassTask.taskId, { to: 'running' });
  tasks.transitionTask(bypassTask.taskId, { to: 'completed' });
  const withBypass = metrics.computeMetrics({
    suite: suite.suite,
    results: suite.results.concat([{
      caseId: 'synthetic-bypass',
      taskId: bypassTask.taskId,
      agentId: 'executor',
      taskType: 'action.execute',
      expectedTerminal: 'completed',
      allowedErrorCodes: [],
      expectReview: true,
      budgetTokenCap: 600,
    }]),
  });
  assert.equal(withBypass.safety.approvalBypass, 1);
});
