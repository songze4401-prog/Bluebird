/* global module */
/**
 * 统一 Worker 结果 schema（阶段 2）。
 *
 * completed / failed / cancelled / timed_out / recovery 都写成同一形状：
 * status、summary、artifacts、evidence、toolSteps、changes、
 * requiresConfirmation / requiresApproval、errorCode、rounds、
 * stopReason、model、runId、finishedAt。
 * 这里只做规范化与截断，不判断业务含义。
 */

const { TERMINAL_STATUSES } = require('./status-vocabulary');
const SUMMARY_MAX = 8000;

function refs(value, limit = 40) {
  if (!Array.isArray(value)) return [];
  return value
    .filter(item => item && typeof item === 'object')
    .slice(0, limit)
    .map(item => ({
      kind: String(item.kind || '').slice(0, 40),
      id: String(item.id || '').slice(0, 120),
      // ③ §11 第 1 步：产物引用要能带回 version；evidence 不带该键，形状不变。
      ...(Number.isInteger(item.version) ? { version: item.version } : {}),
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

// A-13：Token 用量必须按 provider 实际返回值落库，拿不到就不带该字段（不估算）。
function normalizeUsage(value) {
  if (!value || typeof value !== 'object') return null;
  const tokens = {};
  for (const key of ['prompt_tokens', 'completion_tokens', 'total_tokens']) {
    const num = Number(value[key]);
    if (Number.isFinite(num) && num >= 0) tokens[key] = Math.trunc(num);
  }
  return Object.keys(tokens).length ? tokens : null;
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
  neverStarted = false,
  blockedBy = null,
  usage = null,
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
    // 只有 provider 返回真实 usage 时才出现，避免给旧调用方增加空字段。
    ...(normalizeUsage(usage) ? { usage: normalizeUsage(usage) } : {}),
    // 依赖失败收敛专用：该任务从未进入 running。只在为 true 时出现，
    // 其余结果形状保持不变（既有断言依赖原字段集）。
    ...(neverStarted === true
      ? {
          neverStarted: true,
          blockedBy: Array.isArray(blockedBy)
            ? blockedBy.slice(0, 8).map(item => String(item).slice(0, 120))
            : [],
        }
      : {}),
  };
}

module.exports = {
  TERMINAL_STATUSES,
  normalizeWorkerResult,
};
