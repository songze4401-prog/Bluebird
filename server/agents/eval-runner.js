/* global module */
/**
 * Phase 4 第 1 项：离线重放执行器（确定性 stub，不调用真实模型）。
 *
 * 只走既有任务链路：createTask → transitionTask → recordRunStart/recordRunFinish
 * （usage 与预算结算同生产路径），不新增第二套存储，也不新造状态。
 * 时间用虚拟时钟按用例脚本推进，写进 run 的 startedAt/finishedAt，
 * 使"延迟"来自 run 记录而不是墙钟；这是 stub 模拟量，不是真实供应商延迟。
 */
const crypto = require('crypto');
const tasks = require('./tasks');
const autonomyPolicy = require('./autonomy-policy');
const { loadSuite } = require('./eval-suite');
const comparators = require('./eval-comparators');

const DEFAULT_BASE_TIME = '2026-11-05T00:00:00.000Z';
const CASE_GAP_MS = 3600000;
const STEP_GAP_MS = 100;

/**
 * P5-A：比较对象决定是否使用某机制。
 * 未传 comparator 时完全沿用既有语义（策略状态自己说了算），
 * 这样 p4-eval-v1 的历史基线数字不会被改动。
 */
function resolveRun({ comparator = null, item, goal }) {
  if (!comparator) {
    const plan = autonomyPolicy.plan({ goal, taskType: item.taskType });
    const strength = autonomyPolicy.verificationStrength({ taskType: item.taskType });
    return {
      plan,
      strength,
      autonomyOn: plan.enabled,
      allowTeam: plan.enabled && plan.decision === 'team',
      forceSingle: false,
    };
  }
  const rawPlan = autonomyPolicy.plan({ goal, taskType: item.taskType, activeOverride: comparator.enabled.autonomyPolicy });
  const autonomyOn = comparator.enabled.autonomyPolicy;
  const plan = autonomyOn
    ? comparator.forceSingle && rawPlan.decision === 'team'
      ? {
          ...rawPlan,
          decision: 'single',
          members: [rawPlan.members[0]],
          dependencies: [],
          rationale: [...rawPlan.rationale, 'comparator_force_single'],
          orchestration: { ...rawPlan.orchestration, matchedAgentIds: [rawPlan.members[0]], selectedAgentId: rawPlan.members[0], excludedReasons: 'comparator_force_single' },
        }
      : rawPlan
    : null;
  return {
    plan,
    strength: autonomyOn ? autonomyPolicy.verificationStrength({ taskType: item.taskType }) : { requiresReview: false },
    autonomyOn,
    allowTeam: comparator.enabled.teamReview && !comparator.forceSingle && rawPlan.decision === 'team',
    forceSingle: comparator.forceSingle === true,
  };
}

function budgetOf(tokenBudget) {
  return {
    maxRounds: 3,
    maxToolCalls: 6,
    maxReadOnlyRetries: 1,
    generatePlan: false,
    tokenBudget,
  };
}

function totalTokens(usage) {
  if (!usage) return null;
  const value = Number(usage.total_tokens);
  return Number.isFinite(value) && value >= 0 ? Math.floor(value) : null;
}

function runCase(item, clockStart, comparator = null) {
  const run = resolveRun({ comparator, item, goal: item.goal });
  const plan = run.plan;
  // 轨迹与 requiresReview 只在策略真的开着时写入：传了比较对象不等于开了自治，
  // production / autonomyPolicy 关闭的消融版本必须保持 route=null 的既有口径。
  const planActive = Boolean(plan && plan.enabled);
  const task = tasks.createTask({
    botId: item.agentId,
    taskType: item.taskType,
    goal: item.goal,
    route: planActive ? { orchestration: plan.orchestration } : null,
    budget: budgetOf(item.budgetTokenCap),
  });
  if (planActive && run.strength.requiresReview) {
    tasks.updateTask(task.taskId, { requiresReview: true });
  }
  tasks.transitionTask(task.taskId, { to: 'accepted' });
  tasks.transitionTask(task.taskId, { to: 'running' });

  let clock = clockStart;
  let rework = 0;
  const runIds = [];
  const steps = item.script.slice();

  for (let index = 0; index < steps.length; index += 1) {
    const step = steps[index];
    if (index > 0) {
      tasks.transitionTask(task.taskId, { to: 'retrying' });
      tasks.transitionTask(task.taskId, { to: 'running' });
    }
    const runId = `eval_${item.id}_${index + 1}`;
    runIds.push(runId);
    const startedAt = new Date(clock).toISOString();
    const finishedAt = new Date(clock + step.simulatedMs).toISOString();
    tasks.recordRunStart(task.taskId, { runId, attempt: index, startedAt });
    tasks.recordRunFinish(task.taskId, {
      runId,
      status: step.outcome,
      errorCode: step.errorCode,
      finishedAt,
      usage: step.usage,
    });
    const tokens = totalTokens(step.usage);
    if (tokens !== null) {
      tasks.settleTaskBudget(task.taskId, { reserved: 0, actual: tokens });
    }
    if (step.outcome === 'failed' && index < steps.length - 1) rework += 1;
    clock += step.simulatedMs + STEP_GAP_MS;
  }

  const last = steps[steps.length - 1];
  let finalStatus = last.outcome === 'failed' ? 'failed' : 'completed';
  let replan = null;
  let replanExecuted = false;

  if (finalStatus === 'failed') {
    const taskNow = tasks.getTask(task.taskId) || {};
    const usedTokens = steps.reduce((sum, step) => sum + (totalTokens(step.usage) || 0), 0);
    // comparator 决定这次跑「策略算不算开着」：关掉重规划的对照必须真的不多跑一次，
    // 开启时仍受既有 maxAttempts/预算/可恢复错误类别约束。
    const decision = autonomyPolicy.decideReplan({
      task: { agentId: item.agentId, attempts: steps.length, maxAttempts: taskNow.maxAttempts },
      errorCode: last.errorCode,
      tokenBudget: item.budgetTokenCap,
      tokenUsed: usedTokens,
      activeOverride: comparator ? comparator.enabled.replan : null,
    });
    replan = comparator && !comparator.enabled.replan ? 'comparator_ablated' : decision.reason;
    replanExecuted = decision.replan;
    if (replanExecuted) {
      tasks.transitionTask(task.taskId, { to: 'retrying' });
      tasks.transitionTask(task.taskId, { to: 'running' });
      const runId = `eval_${item.id}_replan`;
      runIds.push(runId);
      const startedAt = new Date(clock).toISOString();
      const finishedAt = new Date(clock + 300).toISOString();
      const usage = { prompt_tokens: 60, completion_tokens: 20, total_tokens: 80 };
      tasks.recordRunStart(task.taskId, { runId, attempt: steps.length, startedAt });
      tasks.recordRunFinish(task.taskId, { runId, status: 'completed', errorCode: null, finishedAt, usage });
      tasks.settleTaskBudget(task.taskId, { reserved: 0, actual: 80 });
      clock += 300 + STEP_GAP_MS;
      rework += 1;
      finalStatus = 'completed';
    }
  }

  tasks.transitionTask(task.taskId, {
    to: finalStatus,
    errorCode: finalStatus === 'failed' ? last.errorCode : null,
  });

  const teamTaskIds = [];
  let reviewTaskId = `review_${task.taskId}`;
  if (run.allowTeam && finalStatus === 'completed') {
    const reviewerTask = tasks.createTask({
      botId: 'reviewer',
      taskType: 'review.verify',
      goal: `复核：${item.goal}`.slice(0, 120),
      parentTaskId: task.taskId,
      route: { orchestration: plan.orchestration },
      budget: budgetOf(200),
    });
    tasks.transitionTask(reviewerTask.taskId, { to: 'accepted' });
    tasks.transitionTask(reviewerTask.taskId, { to: 'running' });
    const runId = `eval_${item.id}_review`;
    const startedAt = new Date(clock).toISOString();
    const finishedAt = new Date(clock + 250).toISOString();
    const usage = { prompt_tokens: 30, completion_tokens: 10, total_tokens: 40 };
    tasks.recordRunStart(reviewerTask.taskId, { runId, attempt: 0, startedAt });
    tasks.recordRunFinish(reviewerTask.taskId, { runId, status: 'completed', errorCode: null, finishedAt, usage });
    tasks.settleTaskBudget(reviewerTask.taskId, { reserved: 0, actual: 40 });
    clock += 250 + STEP_GAP_MS;
    teamTaskIds.push(reviewerTask.taskId);
    reviewTaskId = reviewerTask.taskId;
  }

  const reviewNeeded =
    item.expectReview || (run.allowTeam && finalStatus === 'completed');
  if (reviewNeeded) {
    tasks.appendEvent({
      botId: item.agentId,
      taskId: task.taskId,
      eventType: 'verification.review_opened',
      payload: { reviewTaskId, producerTaskId: task.taskId, deterministicOk: true },
    });
    tasks.appendEvent({
      botId: item.agentId,
      taskId: task.taskId,
      eventType: 'verification.verdict',
      payload: { reviewTaskId, verdict: 'pass', deterministicOk: true },
    });
  }

  const startedAt = new Date(clockStart).toISOString();
  const finishedAt = new Date(clock).toISOString();
  return {
    caseId: item.id,
    // 分层随结果一起返回：优化方只能看 dev 的逐例结论，val/holdout/rotation 的
    // 可见性裁剪在 eval-tiers.optimizerReport 里做。
    split: item.split || null,
    taskId: task.taskId,
    teamTaskIds,
    agentId: item.agentId,
    taskType: item.taskType,
    runIds,
    attempts: steps.length + (replanExecuted ? 1 : 0),
    rework,
    startedAt,
    finishedAt,
    latencyMs: Date.parse(finishedAt) - Date.parse(startedAt),
    reviewTriggered: reviewNeeded,
    replan,
    policy: planActive ? { version: plan.version, decision: plan.decision, rationale: plan.rationale } : null,
    expectedTerminal: item.expectedTerminal,
    allowedErrorCodes: item.allowedErrorCodes,
    expectReview: item.expectReview,
    budgetTokenCap: item.budgetTokenCap,
  };
}

function runSuite({ suitePath = null, suitePaths = null, baseTime = DEFAULT_BASE_TIME, comparator = null, splits = null } = {}) {
  const resolved = comparator ? comparators.resolveComparator(comparator) : null;
  const paths = suitePaths && suitePaths.length
    ? suitePaths
    : [suitePath || undefined];
  const suites = paths.map(filePath => loadSuite(filePath));
  let allCases = suites.reduce((sum, item) => sum.concat(item.cases), []);
  const ids = new Set();
  for (const item of allCases) {
    // 多文件同跑时 id 撞车会让"哪条用例变好"无法归因，直接拒绝。
    if (ids.has(item.id)) throw new Error(`跨数据集用例 id 重复：${item.id}`);
    ids.add(item.id);
  }
  const wanted = Array.isArray(splits) && splits.length ? Array.from(new Set(splits)) : null;
  if (wanted) {
    const filtered = allCases.filter(item => wanted.includes(item.split));
    const missing = wanted.filter(name => !filtered.some(item => item.split === name));
    if (missing.length) throw new Error(`评测集缺少分层：${missing.join('、')}`);
    allCases = filtered;
  }
  const base = Date.parse(baseTime);
  if (!Number.isFinite(base)) throw new Error('baseTime 不是合法时间');
  const results = allCases.map((item, index) => runCase(item, base + index * CASE_GAP_MS, resolved));
  // 多文件同跑时基线身份必须覆盖每一个文件，否则 holdout 换了内容快照看不出来。
  const identity = suites.length === 1
    ? { version: suites[0].version, digest: suites[0].digest, file: suites[0].file }
    : {
        version: suites.map(item => item.version).join('+'),
        digest: crypto.createHash('sha256').update(suites.map(item => item.digest).join('|')).digest('hex'),
        file: suites.map(item => item.file).join(','),
      };
  return {
    suite: { ...identity, caseCount: allCases.length },
    suites: suites.map(item => ({ version: item.version, datasetVersion: item.datasetVersion, digest: item.digest, caseCount: item.caseCount, file: item.file })),
    splits: wanted,
    comparator: resolved ? { id: resolved.id, kind: resolved.kind, enabled: resolved.enabled, ablating: resolved.ablating, policyVersion: resolved.policyVersion } : null,
    baseTime: new Date(base).toISOString(),
    results,
  };
}

module.exports = { DEFAULT_BASE_TIME, budgetOf, resolveRun, runSuite };
