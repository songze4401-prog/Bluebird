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

// A-10 / §17：失败模式的可编码清单（中间件/编排层统一口径）。
// 这里只做「识别 + 默认处置」的纯函数，不引入新状态：
// 处置动作只允许 retry / recovery / terminal / escalate，复用既有状态与审批门禁。
// 原文未给处置映射的条目按既有语义落表，标注为「本仓库裁决」。
// v2：P5-C 第 1 轮补入 FM-4 plan_version_race（代次被取代/撤销仍尝试写副作用），
// 处置表内容变了就升版本，不让同一版本号指向两份不同的表。
// v3：P5-D 补入原文点名、此前未命名未检测的四类：FM-1 role_drift（角色漂移）、
// FM-2 handoff_context_lost（交接上下文丢失）、FM-3 delegation_privilege_escalation
// （委派链权限逐跳放大）、FM-5 verification_source_bias（验证器同源偏差）。
// FM-4 已由 v2 覆盖；FM-6 重规划风暴的熔断/停止重规划由 P5-B 落地，
// 「部分结果交付/请求决策」接线在 runtime.js 终态收口，复用 budget_exhausted/
// 既有分类，不新增键。
const FAILURE_MODE_POLICY_VERSION = 'failure-modes-v3';
const FAILURE_MODES = Object.freeze({
  dependency_cycle: 'dependency_cycle',
  dependency_deadlock: 'dependency_deadlock',
  event_out_of_order: 'event_out_of_order',
  duplicate_execution: 'duplicate_execution',
  stale_lease: 'stale_lease',
  artifact_chain_broken: 'artifact_chain_broken',
  partial_commit: 'partial_commit',
  budget_exhausted: 'budget_exhausted',
  approval_stall: 'approval_stall',
  plan_version_race: 'plan_version_race',
  role_drift: 'role_drift',
  handoff_context_lost: 'handoff_context_lost',
  delegation_privilege_escalation: 'delegation_privilege_escalation',
  verification_source_bias: 'verification_source_bias',
});
const FAILURE_MODE_LABELS = Object.freeze({
  dependency_cycle: '依赖图成环（§17，图环检测）',
  dependency_deadlock: '任务互相等待形成死锁（§17）',
  event_out_of_order: '事件乱序或重复投递（§17）',
  duplicate_execution: '同一幂等键重复执行（§17，本仓库裁决）',
  stale_lease: '租约过期或丢失仍尝试落结果（§17）',
  artifact_chain_broken: '产物引用断链/版本不可读（§17）',
  partial_commit: '提交中断或半写（§17）',
  budget_exhausted: 'Token/调用预算耗尽（§17）',
  approval_stall: '人工审批悬挂/超时（§17）',
  plan_version_race: '计划版本竞争：旧代次仍尝试写副作用（§17 FM-4，fencing token）',
  role_drift: '角色漂移：输出越出 Manifest 声明的职责与 schema（§17 FM-1）',
  handoff_context_lost: '交接上下文丢失：必需约束或决策未传递（§17 FM-2）',
  delegation_privilege_escalation:
    '委派链权限逐跳放大：子任务权限超出父任务授权交集（§17 FM-3）',
  verification_source_bias:
    '验证器同源偏差：Reviewer 与 Producer 共享错误来源（§17 FM-5）',
});
// 默认处置（本仓库裁决要点见注释）：
// - dependency_cycle/deadlock：无法靠重试自愈 → 终态 failed；
// - event_out_of_order/artifact_chain_broken/partial_commit：需对账或重建 → recovery；
// - duplicate_execution：幂等丢弃重复结果 → 终态（completed，保留首次结果）；
// - stale_lease：失去租约后结果不可信 → 终态 failed（沿用 runtime 现状）；
// - plan_version_race（FM-4）：代次已被取代或撤销，副作用一次都没做 → 终态 failed；
//   任务本身的归属由持有当前代次的那一次运行决定，runtime 不在旧运行里改写它的状态；
// - budget_exhausted：硬限制，不可重试 → 终态 failed；
// - approval_stall：不自动批准 → 升级审批（复用 review.escalate）；
// - role_drift（FM-1）：拒绝越界输出后缩小上下文重路由（retry，受 attempts 上限约束，
//   耗尽即终态 failed）；
// - handoff_context_lost（FM-2）：必需约束未传递，阻断执行转 recovery，
//   从已验证引用（contextRef 产物）重建后由恢复路径放行；
// - delegation_privilege_escalation（FM-3）：创建期 fail-closed 拒绝且零落盘，
//   分类为 terminal 供监控聚合（真实路径在 tasks.createTask 抛错，任务不创建）；
// - verification_source_bias（FM-5）：同源 Reviewer 不采信、转人工
//   （复用 waiting_approval + review.escalate，不自动批准）。
const FAILURE_MODE_DISPOSITIONS = Object.freeze({
  dependency_cycle: Object.freeze({
    action: 'terminal',
    retryable: false,
    status: 'failed',
    errorCode: 'dependency_cycle',
    escalationOperation: null,
  }),
  dependency_deadlock: Object.freeze({
    action: 'terminal',
    retryable: false,
    status: 'failed',
    errorCode: 'dependency_deadlock',
    escalationOperation: null,
  }),
  event_out_of_order: Object.freeze({
    action: 'recovery',
    retryable: false,
    status: 'recovery',
    errorCode: 'recovery_event_order_violation',
    escalationOperation: null,
  }),
  duplicate_execution: Object.freeze({
    action: 'terminal',
    retryable: false,
    status: 'completed',
    errorCode: 'duplicate_execution_dropped',
    escalationOperation: null,
  }),
  stale_lease: Object.freeze({
    action: 'terminal',
    retryable: false,
    status: 'failed',
    errorCode: 'task_lease_lost',
    escalationOperation: null,
  }),
  artifact_chain_broken: Object.freeze({
    action: 'recovery',
    retryable: false,
    status: 'recovery',
    errorCode: 'recovery_artifact_reference_broken',
    escalationOperation: null,
  }),
  partial_commit: Object.freeze({
    action: 'recovery',
    retryable: false,
    status: 'recovery',
    errorCode: 'recovery_partial_commit',
    escalationOperation: null,
  }),
  budget_exhausted: Object.freeze({
    action: 'terminal',
    retryable: false,
    status: 'failed',
    errorCode: 'budget_exceeded',
    escalationOperation: null,
  }),
  approval_stall: Object.freeze({
    action: 'escalate',
    retryable: false,
    status: 'waiting_approval',
    errorCode: 'approval_stalled',
    escalationOperation: 'review.escalate',
  }),
  plan_version_race: Object.freeze({
    action: 'terminal',
    retryable: false,
    status: 'failed',
    errorCode: 'stale_generation',
    escalationOperation: null,
  }),
  role_drift: Object.freeze({
    action: 'retry',
    retryable: true,
    status: null,
    errorCode: 'role_drift_reroute',
    escalationOperation: null,
  }),
  handoff_context_lost: Object.freeze({
    action: 'recovery',
    retryable: false,
    status: 'recovery',
    errorCode: 'handoff_context_missing',
    escalationOperation: null,
  }),
  delegation_privilege_escalation: Object.freeze({
    action: 'terminal',
    retryable: false,
    status: 'failed',
    errorCode: 'delegation_permission_escalation',
    escalationOperation: null,
  }),
  verification_source_bias: Object.freeze({
    action: 'escalate',
    retryable: false,
    status: 'waiting_approval',
    errorCode: 'verification_source_bias_escalated',
    escalationOperation: 'review.escalate',
  }),
});

/**
 * 把一次失败观测归类到九类之一；无法归类返回 null（交给既有错误码语义处理）。
 * signals 允许直接给 failureMode（已由检测器判定），也允许给 errorCode/reason
 * （由 runtime、恢复流程、审批 SLA 等既有路径传入）。
 */
function classifyFailureMode(signals = {}) {
  const explicit = signals && signals.failureMode;
  if (explicit && Object.prototype.hasOwnProperty.call(FAILURE_MODES, explicit)) {
    return explicit;
  }
  const code = String((signals && signals.errorCode) || '');
  const reason = String((signals && signals.reason) || '');
  const text = `${code}|${reason}`;
  if (/dependency_cycle/.test(text)) return FAILURE_MODES.dependency_cycle;
  if (/deadlock/.test(text)) return FAILURE_MODES.dependency_deadlock;
  if (/event_order|duplicate_delivery|timestamp_regression/.test(text)) {
    return FAILURE_MODES.event_out_of_order;
  }
  if (/duplicate_execution|idempotent_drop/.test(text)) {
    return FAILURE_MODES.duplicate_execution;
  }
  if (/task_lease_lost|lease_expired|stale_lease/.test(text)) {
    return FAILURE_MODES.stale_lease;
  }
  // FM-4：代次被取代/撤销后仍尝试写。fencing_unavailable 是存储不可用（需对账，
  // 不是版本竞争），刻意不入这一类——与 plan_store_corrupted 一样交给恢复流程。
  if (/stale_generation|fencing_revoked|fencing_token_(invalid|missing)|plan_version_race/.test(text)) {
    return FAILURE_MODES.plan_version_race;
  }
  if (/recovery_artifact_reference_broken|artifact_chain_broken/.test(text)) {
    return FAILURE_MODES.artifact_chain_broken;
  }
  if (/pending_commit|partial_commit|orphan_artifact|side_effect_|uncertain_side_effects/.test(text)) {
    return FAILURE_MODES.partial_commit;
  }
  if (/budget_exceeded/.test(text)) return FAILURE_MODES.budget_exhausted;
  if (/approval_(expired|stalled|escalated|overdue)/.test(text)) {
    return FAILURE_MODES.approval_stall;
  }
  // FM-1：角色漂移（verification 的 role_scope 检查与运行期重路由都落这个短码族）。
  if (/role_drift|role_scope/.test(text)) return FAILURE_MODES.role_drift;
  // FM-2：交接上下文丢失（必需约束未传递；重建失败也归这类，交 recovery）。
  if (/handoff_context_missing|handoff_context_lost/.test(text)) {
    return FAILURE_MODES.handoff_context_lost;
  }
  // FM-3：委派链权限逐跳放大（创建期拒绝，任务不落盘）。
  if (/delegation_permission_escalation|delegation_privilege_escalation/.test(text)) {
    return FAILURE_MODES.delegation_privilege_escalation;
  }
  // FM-5：验证器同源偏差（审校不独立/裁决主体越权都属「共享错误来源」）。
  if (/verification_review_not_independent|verification_source_bias|arbiter_(not_independent|scope_exceeded)/.test(text)) {
    return FAILURE_MODES.verification_source_bias;
  }
  return null;
}

function failureModeDisposition(mode) {
  const disposition = FAILURE_MODE_DISPOSITIONS[mode];
  if (!disposition) return null;
  return { policyVersion: FAILURE_MODE_POLICY_VERSION, failureMode: mode, ...disposition };
}

module.exports = {
  AgentError,
  agentError,
  conflictError,
  budgetExceededError,
  ERROR_RETRYABLE,
  errorContractFingerprint,
  describeAgentError,
  FAILURE_MODE_POLICY_VERSION,
  FAILURE_MODES,
  FAILURE_MODE_LABELS,
  FAILURE_MODE_DISPOSITIONS,
  classifyFailureMode,
  failureModeDisposition,
};
