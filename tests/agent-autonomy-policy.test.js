/* global process */
/**
 * Phase 4 第 2 项：动态组队 / 重规划 / 验证强度选择。
 * 覆盖：默认关闭、开关开启后的组队判据与依赖、重规划受既有 maxAttempts 与预算约束、
 * 验证强度复用既有 requiresReview 口径、以及评测执行器把决策写进既有 task.route 轨迹。
 */
const fs = require('fs');
const os = require('os');
const path = require('path');
const test = require('node:test');
const assert = require('node:assert');

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'bluebird-autonomy-'));
process.env.BLUEBIRD_DATA_DIR = TMP;
// 重规划复用既有 maxAttempts；两轮对比用同一配置，避免把配置差异当成策略效果。
process.env.BLUEBIRD_AGENT_TASK_MAX_ATTEMPTS = '3';

const tasks = require('../server/agents/tasks');
const policy = require('../server/agents/autonomy-policy');
const strategyVersion = require('../server/agents/strategy-version');
const runner = require('../server/agents/eval-runner');
const metrics = require('../server/agents/eval-metrics');

const AGENTS_DIR = path.join(TMP, 'agents');

function resetStore() {
  fs.rmSync(AGENTS_DIR, { recursive: true, force: true });
  tasks.reloadForTests();
}

function runRound() {
  const suite = runner.runSuite();
  return {
    suite,
    computed: metrics.computeMetrics({ suite: suite.suite, results: suite.results }),
  };
}

test('a. 默认关闭：p4-default 不组队、不写 orchestration 轨迹', () => {
  resetStore();
  assert.equal(strategyVersion.get().version, 'p4-default');
  const plan = policy.plan({ goal: '执行高危写入', taskType: 'action.execute' });
  assert.equal(plan.enabled, false);
  assert.equal(plan.decision, 'single');
  assert.ok(plan.rationale.includes('policy_disabled'));

  const result = runner.runSuite().results[0];
  assert.equal(tasks.getTask(result.taskId).route, null);
  assert.equal(result.teamTaskIds.length, 0);
  assert.equal(result.policy, null);
});

test('b. 开启后动态组队：高危任务按能力覆盖组队并给出依赖，低风险单 Agent', () => {
  resetStore();
  strategyVersion.apply({ version: policy.ACTIVE_VERSION });
  const high = policy.plan({ goal: '执行高危写入', taskType: 'action.execute' });
  assert.equal(high.enabled, true);
  assert.equal(high.decision, 'team');
  assert.deepEqual(high.members, ['executor', 'reviewer']);
  assert.equal(high.dependencies.length, 1);
  assert.ok(high.rationale.includes('high_risk_requires_review'));

  const low = policy.plan({ goal: '检索记忆', taskType: 'memory.recall' });
  assert.equal(low.decision, 'single');
  assert.deepEqual(low.members, ['researcher']);
  assert.ok(!low.rationale.some(item => item.startsWith('capability_gap:')));

  const lowByHistory = policy.plan({
    goal: '检索记忆',
    taskType: 'memory.recall',
    historicalSuccessRate: 0.4,
  });
  assert.equal(lowByHistory.decision, 'team');
  assert.ok(lowByHistory.rationale.includes('historical_success_below_0.6'));
});

test('c. 重规划只受既有 maxAttempts/预算约束，且不把硬失败重规划成假成功', () => {
  resetStore();
  const disabled = policy.decideReplan({
    task: { attempts: 1, maxAttempts: 3 },
    errorCode: 'review_rejected',
    tokenBudget: 600,
    tokenUsed: 100,
  });
  assert.equal(disabled.replan, false);
  assert.equal(disabled.reason, 'policy_disabled');

  strategyVersion.apply({ version: policy.ACTIVE_VERSION });
  const allowed = policy.decideReplan({
    task: { attempts: 1, maxAttempts: 3, agentId: 'executor' },
    errorCode: 'review_rejected',
    tokenBudget: 600,
    tokenUsed: 100,
  });
  assert.equal(allowed.replan, true);
  assert.equal(allowed.reason, 'replan_allowed');
  assert.equal(allowed.nextAgentId, 'reviewer');

  const capped = policy.decideReplan({
    task: { attempts: 3, maxAttempts: 3 },
    errorCode: 'review_rejected',
    tokenBudget: 600,
    tokenUsed: 100,
  });
  assert.equal(capped.replan, false);
  assert.equal(capped.reason, 'max_attempts_reached');

  const noBudget = policy.decideReplan({
    task: { attempts: 1, maxAttempts: 3 },
    errorCode: 'review_rejected',
    tokenBudget: 600,
    tokenUsed: 600,
  });
  assert.equal(noBudget.replan, false);
  assert.equal(noBudget.reason, 'budget_exhausted');

  const hard = policy.decideReplan({
    task: { attempts: 1, maxAttempts: 3 },
    errorCode: 'model_timeout',
    tokenBudget: 600,
    tokenUsed: 100,
  });
  assert.equal(hard.replan, false);
  assert.equal(hard.reason, 'non_recoverable_error');
});

test('d. 验证强度复用既有 requiresReview：高风险审校、证据弱再审批', () => {
  resetStore();
  strategyVersion.apply({ version: policy.ACTIVE_VERSION });
  const high = policy.verificationStrength({ taskType: 'action.execute' });
  assert.equal(high.requiresReview, true);
  assert.equal(high.requiresApproval, false);

  const weak = policy.verificationStrength({ taskType: 'action.execute', evidenceStrength: 'weak' });
  assert.equal(weak.requiresApproval, true);

  const low = policy.verificationStrength({ taskType: 'memory.recall' });
  assert.equal(low.requiresReview, false);
});

test('e. 评测两轮可对比：开启后高危用例产生团队子任务与 route 轨迹，默认轮没有', () => {
  resetStore();
  const baseline = runRound();
  const baseTeam = baseline.computed.cases.filter(item => item.teamTaskIds.length > 0);
  const baseReplan = baseline.computed.cases.filter(item => item.replan === 'replan_allowed');
  assert.equal(baseTeam.length, 0);
  assert.equal(baseReplan.length, 0);

  resetStore();
  strategyVersion.apply({ version: policy.ACTIVE_VERSION });
  const active = runRound();
  const activeTeam = active.computed.cases.filter(item => item.teamTaskIds.length > 0);
  const activeReplan = active.computed.cases.filter(item => item.replan === 'replan_allowed');
  assert.ok(activeTeam.length >= 3);
  assert.equal(activeReplan.length, 1);
  const replayCase = active.computed.cases.find(item => item.caseId === 'exec-recover-after-failure');
  assert.equal(replayCase.success, true);
  const baseReplay = baseline.computed.cases.find(item => item.caseId === 'exec-recover-after-failure');
  assert.equal(baseReplay.success, false);

  const routed = active.suite.results.find(item => item.caseId === 'exec-execute-slow');
  const orchestration = tasks.getTask(routed.taskId).route.orchestration;
  assert.equal(orchestration.entry, 'autonomy-policy.plan');
  assert.equal(orchestration.matchingRule, 'capability_coverage');
  assert.deepEqual(orchestration.matchedAgentIds, ['executor', 'reviewer']);

  // 团队子任务的 token 计入用例成本，不会漏计。
  assert.ok(replayCase.tokens > 0);
  assert.ok(replayCase.usageKnown);
});
