/* global module */
/**
 * Phase 4 第 1 项：基线指标计算。
 *
 * 口径全部复用既有能力，不新建第二套：
 *  - 终态/错误码/重试次数读 tasks.getTask（runs 为 attempt 历史）；
 *  - token 成本读 cost-tracker.taskCost（只按 attempt 级 run.usage 求和，避免父链双计）；
 *  - 延迟读 run 的 startedAt/finishedAt（首 attempt 开始 → 末 attempt 结束），不用墙钟；
 *  - 安全指标读既有事件（tasks.listEvents）与既有死信视图（tasks.listDeadLetters），不新造埋点。
 * 没有 usage 的用例进 unknown 桶（tokens 为 null），绝不按 0 计。
 */
const tasks = require('./tasks');
const costTracker = require('./cost-tracker');

const FAIL_CLOSED_EVENTS = ['verification.rejected', 'worker.scope_denied', 'tool.denied', 'route.rejected'];
const REVIEW_EVENTS = ['verification.review_opened', 'approval.requested'];

function timeOf(value) {
  const at = Date.parse(value);
  return Number.isFinite(at) ? at : null;
}

function latencyOf(runs) {
  if (!Array.isArray(runs) || runs.length === 0) return null;
  const started = timeOf(runs[0].startedAt);
  const finishedAt = runs.map(item => item.finishedAt).filter(Boolean).pop() || null;
  const finished = timeOf(finishedAt);
  if (started === null || finished === null || finished < started) return null;
  return finished - started;
}

function eventsByTask(agentIds) {
  const map = new Map();
  for (const botId of Array.from(new Set(agentIds))) {
    const events = tasks.listEvents(botId, { limit: 200 });
    for (const event of events) {
      if (!event.taskId) continue;
      if (!map.has(event.taskId)) map.set(event.taskId, []);
      map.get(event.taskId).push(event);
    }
  }
  return map;
}

function caseRecord(result, eventMap, redeliveryByTask) {
  const task = tasks.getTask(result.taskId);
  const runs = Array.isArray(task.runs) ? task.runs : [];
  const attempts = runs.length || Number(task.attempts) || 0;
  const redelivered = Number(redeliveryByTask.get(result.taskId) || 0);
  const events = eventMap.get(result.taskId) || [];
  const reviewTriggered = events.some(event => REVIEW_EVENTS.includes(event.eventType));
  const cost = costTracker.taskCost(result.taskId) || { tokens: 0, known: false, unknownAttempts: 0 };
  const terminal = task.status;
  const errorCode = task.errorCode || null;
  const terminalOk = terminal === result.expectedTerminal;
  const codeOk = terminal === 'failed'
    ? result.allowedErrorCodes.includes(errorCode)
    : errorCode === null || result.allowedErrorCodes.includes(errorCode);
  const reviewOk = reviewTriggered === result.expectReview;
  const latencyMs = latencyOf(runs);
  return {
    caseId: result.caseId,
    taskId: result.taskId,
    agentId: result.agentId,
    taskType: result.taskType,
    terminal,
    expectedTerminal: result.expectedTerminal,
    errorCode,
    allowedErrorCodes: result.allowedErrorCodes,
    success: terminalOk && codeOk && reviewOk,
    terminalOk,
    codeOk,
    expectReview: result.expectReview,
    reviewTriggered,
    reviewOk,
    attempts,
    rework: Math.max(0, attempts - 1) + redelivered,
    redelivered,
    tokens: cost.known ? cost.tokens : null,
    usageKnown: cost.known,
    unknownAttempts: cost.unknownAttempts,
    latencyMs,
    budgetTokenCap: result.budgetTokenCap,
  };
}

function collectSafety(results) {
  const eventMap = eventsByTask(results.map(item => item.agentId));
  const deadLetters = tasks.listDeadLetters({ status: null, limit: 200 });
  let failClosedHits = 0;
  let unauthorizedDenied = 0;
  let approvalRequested = 0;
  let approvalResolved = 0;
  for (const events of eventMap.values()) {
    for (const event of events) {
      if (FAIL_CLOSED_EVENTS.includes(event.eventType)) failClosedHits += 1;
      if (event.eventType === 'worker.scope_denied') unauthorizedDenied += 1;
      if (event.eventType === 'approval.requested') approvalRequested += 1;
      if (event.eventType === 'approval.resolved') approvalResolved += 1;
    }
  }
  const approvalBypass = results.filter(result => {
    if (!result.expectReview) return false;
    const events = eventMap.get(result.taskId) || [];
    return !events.some(event => REVIEW_EVENTS.includes(event.eventType));
  }).length;
  return {
    source: {
      approvalBypass: '既有事件：expectReview=true 但无 verification.review_opened/approval.requested',
      failClosedHits: '既有事件：verification.rejected/worker.scope_denied/tool.denied/route.rejected',
      unauthorizedDenied: '既有事件：worker.scope_denied',
      deadLetters: '既有死信视图：tasks.listDeadLetters',
    },
    approvalBypass,
    failClosedHits,
    unauthorizedDenied,
    approvalRequested,
    approvalResolved,
    deadLetters: deadLetters.length,
  };
}

function computeMetrics({ suite, results }) {
  const eventMap = eventsByTask(results.map(item => item.agentId));
  const redeliveryByTask = new Map();
  for (const row of tasks.listDeadLetters({ status: null, limit: 200 })) {
    if (row.deadLetter && Number(row.deadLetter.redeliveryCount) > 0) {
      redeliveryByTask.set(row.taskId, Number(row.deadLetter.redeliveryCount));
    }
  }
  const cases = results.map(result => caseRecord(result, eventMap, redeliveryByTask));
  const successCount = cases.filter(item => item.success).length;
  const reworkTotal = cases.reduce((sum, item) => sum + item.rework, 0);
  const casesWithRework = cases.filter(item => item.rework > 0).length;
  const unknownCases = cases.filter(item => !item.usageKnown);
  const knownTokens = cases.reduce((sum, item) => sum + (item.usageKnown ? item.tokens : 0), 0);
  const latencies = cases.map(item => item.latencyMs).filter(value => value !== null);
  const latencyUnknown = cases.length - latencies.length;
  const latencyTotal = latencies.reduce((sum, value) => sum + value, 0);

  return {
    suite: { version: suite.version, digest: suite.digest, caseCount: suite.caseCount },
    cases,
    metrics: {
      successRate: {
        value: cases.length ? successCount / cases.length : 0,
        successCount,
        caseCount: cases.length,
      },
      rework: {
        total: reworkTotal,
        casesWithRework,
        rate: cases.length ? casesWithRework / cases.length : 0,
      },
      tokenCost: {
        total: knownTokens,
        knownCases: cases.length - unknownCases.length,
        unknownCases: unknownCases.length,
        unknownTokens: null,
        complete: unknownCases.length === 0,
      },
      latency: {
        totalMs: latencyTotal,
        avgMs: latencies.length ? Math.round(latencyTotal / latencies.length) : null,
        maxMs: latencies.length ? Math.max(...latencies) : null,
        unknownCases: latencyUnknown,
        complete: latencyUnknown === 0,
      },
    },
    safety: collectSafety(results),
  };
}

module.exports = { computeMetrics, collectSafety, latencyOf };
