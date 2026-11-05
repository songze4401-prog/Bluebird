/* global module */
/**
 * Memory Bot 领域错误：所有对外错误只带受控短码与中文说明，
 * 不包含 API Key、Prompt、记忆正文或上游响应体。
 */
const crypto = require('crypto');

class AgentError extends Error {
  constructor(code, message, status = 400, details = null) {
    super(message || code);
    this.name = 'AgentError';
    this.code = code;
    this.status = status;
    // 仅新增错误码（当前为 conflict）携带结构化附加字段；其余错误保持原样，
    // 避免一次性改造全部错误码而扩大测试面。
    this.details = details && typeof details === 'object' ? details : null;
  }
}

function agentError(code, message, status) {
  return new AgentError(code, message, status);
}

/**
 * ② CAS 冲突错误契约（§23）：七个字段。
 * code / retryable / errorFingerprint / failedAt / taskId / runId / 可选 causeRef。
 * errorFingerprint = sha256("<taskId>:<expectedVersion>:<currentStateVersion>")，
 * 用于同一次冲突的去重与日志关联；不含记忆正文或用户数据。
 */
function conflictError({ taskId, expectedVersion, currentVersion, runId = null, causeRef = null } = {}) {
  const fingerprint = crypto
    .createHash('sha256')
    .update(`${String(taskId || '')}:${String(expectedVersion)}:${String(currentVersion)}`)
    .digest('hex');
  const details = {
    retryable: true,
    errorFingerprint: fingerprint,
    failedAt: new Date().toISOString(),
    taskId: String(taskId || ''),
    runId: runId === null || runId === undefined ? null : String(runId),
  };
  if (causeRef) details.causeRef = String(causeRef).slice(0, 120);
  return new AgentError('conflict', '任务已被其他写入更新，请重读后再试', 409, details);
}

/**
 * B-06 预算超限错误契约（§25 / §30）：`budget_exceeded` 一律 retryable=false。
 * 重试不得重置额度，因此这里不提供任何“可重试”字段；details 与 conflict 同形，
 * 复用七字段（errorFingerprint 为 sha256("<taskId>:<scope>:<required>")）。
 * 不含记忆正文或用户数据。
 */
function budgetExceededError({
  taskId,
  scope = 'task',
  required = 0,
  remaining = 0,
  runId = null,
  causeRef = null,
} = {}) {
  const fingerprint = crypto
    .createHash('sha256')
    .update(`${String(taskId || '')}:${String(scope)}:${String(required)}`)
    .digest('hex');
  const details = {
    retryable: false,
    errorFingerprint: fingerprint,
    failedAt: new Date().toISOString(),
    taskId: String(taskId || ''),
    runId: runId === null || runId === undefined ? null : String(runId),
    scope: String(scope),
    required: Number(required) || 0,
    remaining: Number(remaining) || 0,
  };
  if (causeRef) details.causeRef = String(causeRef).slice(0, 120);
  return new AgentError('budget_exceeded', 'Token 预算不足，任务被硬限制拒绝', 409, details);
}

/**
 * §23 六类错误码的默认 retryable（取自原文表格）。
 * retryable=true 不是自动重试命令；conflict / dependency_failed 的 true 是
 * 「有条件的」——是否真的重试仍由 Workflow Engine 结合 attempt、预算、依赖
 * 状态与 deadline 决定；internal_error 的 true 受重试上限与熔断约束。
 */
const ERROR_RETRYABLE = Object.freeze({
  validation_failed: false,
  not_authorized: false,
  conflict: true,
  budget_exceeded: false,
  dependency_failed: true,
  internal_error: true,
});

/**
 * 七字段契约的指纹：同输入（code/taskId/runId/causeRef/message）稳定同指纹，
 * 用于去重与日志关联；不含记忆正文或用户数据。
 */
function errorContractFingerprint({ code, taskId, runId, causeRef, message }) {
  return crypto
    .createHash('sha256')
    .update(
      `${String(code)}|${String(taskId)}|${String(runId)}|${String(causeRef)}|${String(message)}`
    )
    .digest('hex');
}

// §23：把六类错误统一补齐七字段。既有键 code/error/status 与既有附加字段
// 保持不变，只补缺失字段（conflict/budget_exceeded 已带全套时不覆盖）。
function attachErrorContract(error, info) {
  const code = error && error.code;
  if (!Object.prototype.hasOwnProperty.call(ERROR_RETRYABLE, code)) return info;
  const details = error.details && typeof error.details === 'object' ? error.details : {};
  const taskId =
    details.taskId === undefined || details.taskId === null ? '' : String(details.taskId);
  const runId =
    details.runId === undefined || details.runId === null ? null : String(details.runId);
  const causeRef =
    details.causeRef === undefined || details.causeRef === null
      ? null
      : String(details.causeRef).slice(0, 120);
  if (info.retryable === undefined) info.retryable = ERROR_RETRYABLE[code];
  if (info.errorFingerprint === undefined) {
    info.errorFingerprint = errorContractFingerprint({
      code,
      taskId,
      runId,
      causeRef,
      message: error.message || '',
    });
  }
  if (info.failedAt === undefined) info.failedAt = new Date().toISOString();
  if (info.taskId === undefined) info.taskId = taskId;
  if (info.runId === undefined) info.runId = runId;
  if (info.causeRef === undefined) info.causeRef = causeRef;
  return info;
}

function describeAgentError(error) {
  if (error instanceof AgentError) {
    const info = { code: error.code, error: error.message, status: error.status };
    if (error.details) {
      for (const [key, value] of Object.entries(error.details)) {
        // 保留 code/error/status 兼容键；附加字段只做新增，不覆盖既有键。
        if (info[key] === undefined) info[key] = value;
      }
    }
    return attachErrorContract(error, info);
  }
  return {
    code: 'agent_failed',
    error: 'Agent 操作失败',
    status: 500,
  };
}

module.exports = {
  AgentError,
  agentError,
  conflictError,
  budgetExceededError,
  ERROR_RETRYABLE,
  errorContractFingerprint,
  describeAgentError,
};
