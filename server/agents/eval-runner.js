/* global module */
/**
 * Phase 4 第 1 项：离线重放执行器（确定性 stub，不调用真实模型）。
 *
 * 只走既有任务链路：createTask → transitionTask → recordRunStart/recordRunFinish
 * （usage 与预算结算同生产路径），不新增第二套存储，也不新造状态。
 * 时间用虚拟时钟按用例脚本推进，写进 run 的 startedAt/finishedAt，
 * 使"延迟"来自 run 记录而不是墙钟；这是 stub 模拟量，不是真实供应商延迟。
 */
const tasks = require('./tasks');
const autonomyPolicy = require('./autonomy-policy');
const { loadSuite } = require('./eval-suite');

const DEFAULT_BASE_TIME = '2026-11-05T00:00:00.000Z';
const CASE_GAP_MS = 3600000;
const STEP_GAP_MS = 100;

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

function runCase(item, clockStart) {
  const plan = autonomyPolicy.plan({ goal: item.goal, taskType: item.taskType });
  const strength = autonomyPolicy.verificationStrength({ taskType: item.taskType });
  const task = tasks.createTask({
    botId: item.agentId,
    taskType: item.taskType,
    goal: item.goal,
    route: plan.enabled ? { orchestration: plan.orchestration } : null,
    budget: budgetOf(item.budgetTokenCap),
  });
  if (plan.enabled && strength.requiresReview) {
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

  if (finalStatus === 'failed') {
    const taskNow = tasks.getTask(task.taskId) || {};
    const usedTokens = steps.reduce((sum, step) => sum + (totalTokens(step.usage) || 0), 0);
    const decision = autonomyPolicy.decideReplan({
      task: { agentId: item.agentId, attempts: steps.length, maxAttempts: taskNow.maxAttempts },
      errorCode: last.errorCode,
      tokenBudget: item.budgetTokenCap,
      tokenUsed: usedTokens,
    });
    replan = decision.reason;
    if (decision.replan) {
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
  if (plan.enabled && plan.decision === 'team' && finalStatus === 'completed') {
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
    item.expectReview || (plan.enabled && plan.decision === 'team' && finalStatus === 'completed');
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
    taskId: task.taskId,
    teamTaskIds,
    agentId: item.agentId,
    taskType: item.taskType,
    runIds,
    attempts: steps.length + (replan === 'replan_allowed' ? 1 : 0),
    rework,
    startedAt,
    finishedAt,
    latencyMs: Date.parse(finishedAt) - Date.parse(startedAt),
    reviewTriggered: reviewNeeded,
    replan,
    policy: plan.enabled ? { version: plan.version, decision: plan.decision, rationale: plan.rationale } : null,
    expectedTerminal: item.expectedTerminal,
    allowedErrorCodes: item.allowedErrorCodes,
    expectReview: item.expectReview,
    budgetTokenCap: item.budgetTokenCap,
  };
}

function runSuite({ suitePath = null, baseTime = DEFAULT_BASE_TIME } = {}) {
  const suite = loadSuite(suitePath || undefined);
  const base = Date.parse(baseTime);
  if (!Number.isFinite(base)) throw new Error('baseTime 不是合法时间');
  const results = suite.cases.map((item, index) =>
    runCase(item, base + index * CASE_GAP_MS)
  );
  return {
    suite: { version: suite.version, digest: suite.digest, caseCount: suite.caseCount, file: suite.file },
    baseTime: new Date(base).toISOString(),
    results,
  };
}

module.exports = { DEFAULT_BASE_TIME, budgetOf, runSuite };
