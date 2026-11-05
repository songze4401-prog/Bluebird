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
  const task = tasks.createTask({
    botId: item.agentId,
    taskType: item.taskType,
    goal: item.goal,
    budget: budgetOf(item.budgetTokenCap),
  });
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
  const finalStatus = last.outcome === 'failed' ? 'failed' : 'completed';
  tasks.transitionTask(task.taskId, {
    to: finalStatus,
    errorCode: last.outcome === 'failed' ? last.errorCode : null,
  });

  if (item.expectReview) {
    const reviewTaskId = `review_${task.taskId}`;
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
    agentId: item.agentId,
    taskType: item.taskType,
    runIds,
    attempts: steps.length,
    rework,
    startedAt,
    finishedAt,
    latencyMs: Date.parse(finishedAt) - Date.parse(startedAt),
    reviewTriggered: item.expectReview,
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
