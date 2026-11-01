/* global module */
/**
 * 统一 Worker 结果 schema（阶段 2）。
 *
 * completed / failed / cancelled / timed_out 都写成同一形状：
 * status、summary、artifacts、evidence、toolSteps、changes、
 * requiresConfirmation / requiresApproval、errorCode、rounds、
 * stopReason、model、runId、finishedAt。
 * 这里只做规范化与截断，不判断业务含义。
 */

const TERMINAL_STATUSES = Object.freeze([
  'completed',
  'failed',
  'cancelled',
  'timed_out',
]);
const SUMMARY_MAX = 8000;

function refs(value, limit = 40) {
  if (!Array.isArray(value)) return [];
  return value
    .filter(item => item && typeof item === 'object')
    .slice(0, limit)
    .map(item => ({
      kind: String(item.kind || '').slice(0, 40),
      id: String(item.id || '').slice(0, 120),
    }));
}

function toolSteps(value) {
  if (!Array.isArray(value)) return [];
  return value.slice(0, 20).map(step => ({
    name: String(step && step.name ? step.name : '').slice(0, 60),
    ok: Boolean(step && step.ok === true),
    summary: String(step && step.summary ? step.summary : '').slice(0, 160),
    durationMs:
      Number.isFinite(step && step.durationMs) && step.durationMs >= 0
        ? Math.floor(step.durationMs)
        : 0,
  }));
}

function changes(value) {
  if (!Array.isArray(value)) return [];
  return value
    .filter(item => item && typeof item === 'object')
    .slice(0, 20)
    .map(item => ({
      kind: String(item.kind || '').slice(0, 40),
      id: String(item.id || '').slice(0, 120),
      decision: String(item.decision || '').slice(0, 40),
    }));
}

function normalizeWorkerResult({
  status,
  summary = '',
  artifacts = [],
  evidence = [],
  toolSteps: steps = [],
  changes: changeList = [],
  requiresConfirmation = false,
  errorCode = null,
  rounds = 0,
  stopReason = null,
  model = null,
  runId = null,
  finishedAt = null,
} = {}) {
  if (!TERMINAL_STATUSES.includes(status)) {
    throw new TypeError(`Worker 结果状态无效：${status}`);
  }
  const requiresApproval = requiresConfirmation === true;
  return {
    status,
    summary: typeof summary === 'string' ? summary.slice(0, SUMMARY_MAX) : '',
    artifacts: refs(artifacts),
    evidence: refs(evidence),
    toolSteps: toolSteps(steps),
    changes: changes(changeList),
    requiresConfirmation: requiresApproval,
    requiresApproval,
    errorCode: typeof errorCode === 'string' ? errorCode.slice(0, 60) : null,
    rounds: Number.isInteger(rounds) && rounds >= 0 ? rounds : 0,
    stopReason: typeof stopReason === 'string' ? stopReason.slice(0, 60) : null,
    model:
      model && typeof model === 'object'
        ? {
            providerId: String(model.providerId || '').slice(0, 120),
            modelId: String(model.modelId || '').slice(0, 120),
          }
        : null,
    runId: typeof runId === 'string' ? runId.slice(0, 80) : null,
    finishedAt: typeof finishedAt === 'string' ? finishedAt : null,
  };
}

module.exports = {
  TERMINAL_STATUSES,
  normalizeWorkerResult,
};
