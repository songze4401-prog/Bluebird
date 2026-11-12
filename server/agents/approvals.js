/* global module, __dirname */
/**
 * Memory Bot 人工审批闭环：
 * pending → approved / rejected → executing → completed / failed。
 *
 * 审批记录保存在独立文件；事件只写安全字段。执行只能由已批准记录触发，
 * 且执行器只能调用 memory-service.js 的稳定维护接口。
 *
 * §29 双词表口径（B-11，向后兼容读）：
 *  - status：既有执行生命周期，保持原语义（pending/approved/rejected/executing/completed/failed）；
 *  - requestStatus：§29 Approval Request 六态（pending/approved/rejected/expired/escalated/cancelled）；
 *  - state：二者合并后的只读派生视图，不落盘、不参与迁移校验。
 * 提醒 / 升级 / 取消三条路径都只写 requestStatus，绝不把请求态硬塞进 status；
 * SLA 参数在创建时冻结进 record.sla（旧记录由 slaViewOf 只读派生）。
 */
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { writeFileAtomicSync } = require('../atomic-write');
const memoryService = require('../memory-service');
const permissions = require('./permissions');
const tasks = require('./tasks');
const sessions = require('./sessions');
const resultDelivery = require('./result-delivery');
const { normalizeWorkerResult } = require('./worker-result');
const { isKnownBot } = require('./manifest');
const { AgentError } = require('./errors');
const artifactCommit = require('./artifact-commit');
const failOpenPolicy = require('./failopen-policy');
const opLedger = require('./op-ledger');
const crashHook = require('./crash-hook');
const { createSideEffectGuard } = require('./side-effect-guard');
const { getInstanceUserId } = require('../user-scope');

const DATA_DIR = process.env.BLUEBIRD_DATA_DIR
  ? path.resolve(process.env.BLUEBIRD_DATA_DIR)
  : path.join(__dirname, '..', 'data');
const AGENTS_DIR = path.join(DATA_DIR, 'agents');
const APPROVALS_FILE = path.join(AGENTS_DIR, 'agent-approvals.json');
const SCHEMA_VERSION = 1;
const APPROVAL_MAX = 500;
const PENDING_MAX = 100;
const STATUSES = Object.freeze([
  'pending',
  'approved',
  'rejected',
  'executing',
  'completed',
  'failed',
]);
const TERMINAL = new Set(['rejected', 'completed', 'failed']);

// §29：Approval Request 自身的六态（原文取值，顺序不构成优先级）。
// 与既有执行生命周期 status 并列存在，不改既有 status 语义（待确认：是否最终合并）。
const REQUEST_STATUSES = Object.freeze([
  'pending',
  'approved',
  'rejected',
  'expired',
  'escalated',
  'cancelled',
]);
// §29 原文未给出迁移表；按下文语义推导最小合法边（待确认）。
// 关键约束：expired 的原请求不得被批准（人工通过需新 Approval Request）；
// 但允许 reject/cancel 关闭，兼容既有"超时后仍可人工拒绝"的行为。
const REQUEST_TRANSITIONS = Object.freeze({
  pending: Object.freeze(['approved', 'rejected', 'expired', 'escalated', 'cancelled']),
  escalated: Object.freeze(['approved', 'rejected', 'expired', 'cancelled']),
  approved: Object.freeze(['rejected', 'expired', 'cancelled']),
  expired: Object.freeze(['rejected', 'cancelled']),
  rejected: Object.freeze([]),
  cancelled: Object.freeze([]),
});
// §29 要求"通知重试记录"；上限与退避原文未定义（待确认）。
const MAX_NOTIFICATION_ATTEMPTS = 3;
const NOTIFICATION_BACKOFF_MS = 60 * 1000;

// A 类：R2 审批 SLA 初始默认硬阈值 30 分钟（v1.3 §36.2，用户 2026-11-03 裁决）。
// 到期只转人工（overdue 标记 + 升级事件 + 保持 pending），绝不解释为批准，也不改写 Task。
// 调整必须按 §31.2 留版本记录，不得静默调参。
const R2_SLA_MS = 30 * 60 * 1000;
// A 类：§32.3 建议 escalationAt 由 SLA 派生（取 50%），待实测校准并留痕。
const R2_ESCALATION_RATIO = 0.5;
// 风险等级映射：medium → R2（人工审批 + 30 分钟 SLA）；high → R3（无自动批准超时）。
// 未知风险一律按 R3 处理（fail-closed，不降级）。
const RISK_LEVEL_BY_RISK = Object.freeze({ medium: 'R2', high: 'R3' });

// §29 SLA 持久化版本位：新记录把 SLA 参数冻结到 record.sla，便于审计与后续迁移；
// 旧记录没有该字段时由 publicApproval 只读派生，不回写历史数据。
const APPROVAL_SLA_POLICY_VERSION = 'approval-sla-v1';
// 审批的单一读视图词表：§29 六态 + 既有执行生命周期三态（executing/completed/failed）。
// 仅作为派生的 state 暴露，不参与写入，也不改既有 status / requestStatus 语义。
const APPROVAL_STATES = Object.freeze([
  'pending',
  'approved',
  'rejected',
  'expired',
  'escalated',
  'cancelled',
  'executing',
  'completed',
  'failed',
]);
const APPROVAL_POLICY_FIELDS = Object.freeze([
  'riskLevel',
  'expiresAt',
  'escalationAt',
  'policyVersion',
]);

// A-08 / §15：批量审批、申诉改判与审批负载。
// 原文只写了「审批吞吐」与批量/申诉的存在，未给批量上限、申诉时限与申诉主体；
// 以下三条均为**本仓库裁决（非 Notion 原文）**，变更必须升版本并留记录：
//  - 批量上限 10 条：单次裁决过大时审计与失败隔离都不可控；
//  - 申诉窗口 24 小时、仅一次：拒绝后给一次人工复核，不设无限上诉；
//  - 仅 `local-owner`（单用户 Owner）可申诉：Agent 不能替自己申诉。
const APPROVAL_BATCH_POLICY_VERSION = 'approval-batch-v1';
const APPROVAL_BATCH_MAX = 10;
const APPROVAL_APPEAL_POLICY_VERSION = 'approval-appeal-v1';
const APPEAL_WINDOW_MS = 24 * 60 * 60 * 1000;
const APPEAL_MAX_TIMES = 1;
const APPEAL_ALLOWED_ACTORS = Object.freeze([permissions.SINGLE_USER_ACTOR]);
const APPEAL_DECISIONS = Object.freeze(['overturn', 'uphold']);

// P5-F / §15：审批责任人与轮值。原文要求「轮值与责任人分配」；单用户实例的
// 合法轮值池默认只有 local-owner，但机制必须真实存在——轮值游标持久化、
// 逐条分配、升级重派到下一位——不能因为池子小就不建。改动必须升版本。
const APPROVAL_ASSIGNEE_POLICY_VERSION = 'approval-assignee-v1';
let assigneeRota = Object.freeze([permissions.SINGLE_USER_ACTOR]);
function setAssigneeRotaForTests(rota) {
  const list = Array.isArray(rota) ? rota : [];
  const cleaned = [...new Set(list.map(item => String(item || '').trim()).filter(Boolean))];
  if (!cleaned.length) {
    throw new AgentError('invalid_assignee_rota', '轮值池不能为空', 400);
  }
  assigneeRota = Object.freeze(cleaned);
}

/** 轮值取下一位：游标持久化在审批存储里，重启不重置；exclude 用于升级重派。 */
function nextAssignee(state, { exclude = null } = {}) {
  const cursor = Number.isInteger(state.assigneeCursor) ? state.assigneeCursor : 0;
  const pool = assigneeRota.filter(item => item !== exclude);
  const effective = pool.length ? pool : assigneeRota;
  const assignee = effective[cursor % effective.length];
  state.assigneeCursor = cursor + 1;
  return assignee;
}

// Phase 3 第 1 项：验证闭环的"人工审批门"。
// 这两个操作的执行不触碰记忆/外部副作用，因此不走 memoryService 参数校验与
// 权限白名单；但仍复用同一条审批记录、riskLevel/expiresAt/SLA 与超时语义：
// - review.conflict：冲突裁决（机械校验与审校相反），R2 + 30 分钟 SLA，
//   到期只标 overdue，**绝不**自动通过。
// - review.escalate：高风险审校不通过或审校无法给出结论，R3（无自动超时）。
// payload 只允许固定标量键，防止把正文/凭证塞进审批记录。
const GATE_OPERATIONS = Object.freeze({
  'review.conflict': Object.freeze({
    risk: 'medium',
    allowedKeys: Object.freeze([
      'producerTaskId',
      'artifactId',
      'version',
      'verdict',
      'checkCode',
      'decision',
      'conflict',
    ]),
  }),
  'review.escalate': Object.freeze({
    risk: 'high',
    allowedKeys: Object.freeze([
      'producerTaskId',
      'artifactId',
      'version',
      'verdict',
      'checkCode',
      'decision',
      'conflict',
    ]),
  }),
  // P5-C2：对外发布门。唯一副作用是把已收口的结果交付到父会话（幂等通道）。
  // R2 + 30 分钟 SLA：到期只标 overdue 并由既有收敛路径取消任务，绝不自动通过。
  // 正文不进审批记录——待交付结果落 kind='delivery' 产物，这里只带引用标量。
  'plan.publish': Object.freeze({
    risk: 'medium',
    allowedKeys: Object.freeze([
      'producerTaskId',
      'planId',
      'planVersion',
      'deliveryArtifactId',
      'deliveryArtifactVersion',
      'taskType',
    ]),
  }),
});

function gateOperation(operation) {
  return Object.prototype.hasOwnProperty.call(GATE_OPERATIONS, String(operation || ''))
    ? GATE_OPERATIONS[String(operation)]
    : null;
}

function validateGatePayload(gate, payload) {
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) {
    return { ok: false, error: 'payload' };
  }
  const value = {};
  for (const key of gate.allowedKeys) {
    const item = payload[key];
    if (item === undefined || item === null) continue;
    if (typeof item === 'string') value[key] = item.slice(0, 200);
    else if (typeof item === 'number' && Number.isFinite(item)) value[key] = item;
    else if (typeof item === 'boolean') value[key] = item;
    else return { ok: false, error: key };
  }
  if (!value.producerTaskId) return { ok: false, error: 'producerTaskId' };
  return { ok: true, value };
}

let cache = null;
// R2 的 escalation/overdue 计时器：只做标记与事件，不推进任何批准流程。
const deadlineTimers = new Map();

function nowIso(ms = Date.now()) {
  return new Date(ms).toISOString();
}

function ensureDir() {
  fs.mkdirSync(AGENTS_DIR, { recursive: true });
}

function emptyStore() {
  return { version: SCHEMA_VERSION, approvals: {} };
}

function load() {
  if (cache) return cache;
  ensureDir();
  if (!fs.existsSync(APPROVALS_FILE)) {
    cache = emptyStore();
    return cache;
  }
  let parsed;
  try {
    parsed = JSON.parse(fs.readFileSync(APPROVALS_FILE, 'utf8'));
  } catch (_) {
    throw new AgentError('agent_approvals_corrupted', '审批存储无法解析', 500);
  }
  if (
    !parsed ||
    parsed.version !== SCHEMA_VERSION ||
    !parsed.approvals ||
    typeof parsed.approvals !== 'object' ||
    Array.isArray(parsed.approvals)
  ) {
    throw new AgentError('agent_approvals_corrupted', '审批存储结构无效', 500);
  }
  cache = parsed;
  return cache;
}

function save() {
  ensureDir();
  writeFileAtomicSync(APPROVALS_FILE, JSON.stringify(cache, null, 2));
  try {
    fs.chmodSync(APPROVALS_FILE, 0o600);
  } catch (_) {
    // Windows chmod 语义有限；审批文件仍在数据目录内。
  }
}

function assertBot(botId) {
  if (!isKnownBot(botId)) throw new AgentError('agent_not_found', 'Agent 不存在', 404);
}

function clone(value) {
  return JSON.parse(JSON.stringify(value));
}

function recordEvent(botId, eventType, payload, context = {}) {
  try {
    tasks.appendEvent({
      botId,
      taskId: context.taskId || null,
      runId: null,
      sessionId: context.sessionId || null,
      eventType,
      payload,
      correlationId: context.approvalId || context.taskId || null,
    });
  } catch (error) {
    console.warn(
      `[agent-approval] event failed type=${eventType} code=${
        (error && error.code) || 'event_failed'
      }`
    );
  }
}

function deliverTaskResult(taskId, outcome) {
  if (!taskId) return;
  try {
    resultDelivery.deliverTaskOutcome(taskId, outcome);
  } catch (_) {
    // 结果投递失败不能把已经完成的审批伪装成失败；任务侧保留 failed 状态。
  }
}

function publicApproval(record) {
  if (!record) return null;
  return {
    approvalId: record.approvalId,
    botId: record.botId,
    taskId: record.taskId,
    sessionId: record.sessionId,
    operation: record.operation,
    payload: clone(record.payload || {}),
    risk: record.risk,
    // ④ 四字段：新增审批记录带全量；老记录保持 null，由 execute 做 fail-closed。
    riskLevel: typeof record.riskLevel === 'string' ? record.riskLevel : null,
    expiresAt: typeof record.expiresAt === 'string' ? record.expiresAt : null,
    escalationAt: typeof record.escalationAt === 'string' ? record.escalationAt : null,
    policyVersion: Number.isInteger(record.policyVersion) ? record.policyVersion : null,
    // A-08：批量裁决归属（单条裁决为 null）与申诉历史（原裁决快照另存）。
    batchId: record.batchId || null,
    appealStatus: record.appealStatus || null,
    appeals: Array.isArray(record.appeals) ? clone(record.appeals) : [],
    originalDecision: record.originalDecision ? clone(record.originalDecision) : null,
    overdue: record.overdue === true,
    overdueAt: record.overdueAt || null,
    escalatedAt: record.escalatedAt || null,
    status: record.status,
    // §29 六态；旧记录缺字段时按 status 只读推导，不静默改历史数据。
    requestStatus: requestStatusOf(record),
    // 单一读视图：§29 六态与执行生命周期合并后的派生值。
    // 只读派生，权威写入仍是 status（生命周期）与 requestStatus（§29 请求态）。
    state: mergedStateOf(record),
    // 持久化 SLA：新记录按 record.sla 读；旧记录由四字段只读派生。
    sla: slaViewOf(record),
    reminder: record.reminder
      ? clone(record.reminder)
      : { count: 0, lastAt: null, lastBy: null, channel: null },
    cancelledAt: record.cancelledAt || null,
    cancelledBy: record.cancelledBy || null,
    cancelReason: record.cancelReason || null,
    escalationSource: record.escalationSource || null,
    notification: record.notification
      ? clone(record.notification)
      : { attempts: 0, lastError: null, lastAttemptAt: null, nextRetryAt: null, exhausted: false },
    requestedBy: record.requestedBy,
    requestedAt: record.requestedAt,
    // P5-F / §15：责任人与轮值（创建时分配、升级时重派）。旧记录缺字段读作 null。
    assignee: record.assignee || null,
    assigneePolicyVersion: record.assigneePolicyVersion || null,
    assigneeReassignedFrom: record.assigneeReassignedFrom || null,
    decidedBy: record.decidedBy || null,
    decidedAt: record.decidedAt || null,
    executedBy: record.executedBy || null,
    executedAt: record.executedAt || null,
    reason: record.reason || null,
    errorCode: record.errorCode || null,
    result: record.result ? clone(record.result) : null,
  };
}

function requestStatusOf(record) {
  if (!record || typeof record !== 'object') return 'pending';
  if (REQUEST_STATUSES.includes(record.requestStatus)) return record.requestStatus;
  // 读边界兼容旧记录：按既有 status 只读推导，不回写。
  if (['approved', 'executing', 'completed', 'failed'].includes(record.status)) return 'approved';
  if (record.status === 'rejected') return 'rejected';
  return 'pending';
}

/**
 * §29 六态与既有执行生命周期 status 的合并读视图（只读派生）。
 * 规则：请求级终态（cancelled/rejected/expired/escalated）优先；
 * 请求已批准时再映射执行生命周期（executing/completed/failed），否则 approved。
 * 写入仍以 status + requestStatus 为准，state 不落盘、不参与迁移校验。
 */
function mergedStateOf(record) {
  const request = requestStatusOf(record);
  if (request !== 'approved') return request;
  if (record.status === 'executing') return 'executing';
  if (record.status === 'completed') return 'completed';
  if (record.status === 'failed') return 'failed';
  return 'approved';
}

/**
 * SLA 视图：新记录读持久化的 record.sla；旧记录用既有四字段只读派生，
 * 从而保证向后兼容读，也不对历史数据做静默回写。
 */
function slaViewOf(record) {
  const stored = record && typeof record.sla === 'object' && record.sla ? record.sla : null;
  const riskLevel =
    (stored && typeof stored.riskLevel === 'string' ? stored.riskLevel : null) ||
    (typeof record.riskLevel === 'string' ? record.riskLevel : null);
  const slaMs =
    stored && Number.isInteger(stored.slaMs)
      ? stored.slaMs
      : riskLevel === 'R2'
        ? R2_SLA_MS
        : null;
  return {
    slaPolicyVersion:
      (stored && typeof stored.slaPolicyVersion === 'string' ? stored.slaPolicyVersion : null) ||
      (record.riskLevel ? APPROVAL_SLA_POLICY_VERSION : null),
    policyVersion:
      stored && Number.isInteger(stored.policyVersion)
        ? stored.policyVersion
        : Number.isInteger(record.policyVersion)
          ? record.policyVersion
          : null,
    riskLevel,
    slaMs,
    escalationRatio:
      stored && typeof stored.escalationRatio === 'number'
        ? stored.escalationRatio
        : riskLevel === 'R2'
          ? R2_ESCALATION_RATIO
          : null,
    startedAt: (stored && stored.startedAt) || record.requestedAt || null,
    escalationAt:
      (stored && stored.escalationAt !== undefined ? stored.escalationAt : null) ||
      record.escalationAt ||
      null,
    expiresAt:
      (stored && stored.expiresAt !== undefined ? stored.expiresAt : null) ||
      record.expiresAt ||
      null,
    escalatedAt: record.escalatedAt || null,
    overdueAt: record.overdueAt || null,
  };
}

// §29 六态迁移校验：非法迁移一律拒绝（不自动纠正、不静默通过）。
function assertRequestStatusTransition(from, to) {
  const allowed = REQUEST_TRANSITIONS[from];
  if (!allowed || !allowed.includes(to)) {
    throw new AgentError(
      'approval_request_transition_invalid',
      `审批请求不允许从 ${from} 迁移到 ${to}`,
      409,
      { from, to }
    );
  }
}

function transitionRequestStatus(approvalId, to, { now = Date.now() } = {}) {
  const current = load();
  const record = current.approvals[String(approvalId || '')];
  if (!record) throw new AgentError('approval_not_found', '审批不存在', 404);
  const from = requestStatusOf(record);
  if (from === to) return publicApproval(record);
  assertRequestStatusTransition(from, to);
  record.requestStatus = to;
  record.requestStatusChangedAt = nowIso(now);
  save();
  return publicApproval(record);
}

/**
 * §29 通知重试记录：次数、最后错误、下次重试时间。
 * 通知失败不阻塞主流程——本函数只记账，不改审批状态、不抛审批语义错误。
 * 达到上限后置 exhausted=true 并停止排期（原文未定义上限/退避，待确认）。
 */
function recordNotificationOutcome(
  approvalId,
  { ok = false, error = null, now = Date.now(), retryDelayMs = NOTIFICATION_BACKOFF_MS } = {}
) {
  const current = load();
  const record = current.approvals[String(approvalId || '')];
  if (!record) return null;
  const previous =
    record.notification && typeof record.notification === 'object' ? record.notification : {};
  // 已达上限后不再重试、不再排期；成功的通知仍可清除 exhausted。
  if (!ok && previous.exhausted === true) return publicApproval(record);
  const attempts = Number.isInteger(previous.attempts) ? previous.attempts : 0;
  const notification = {
    attempts: attempts + 1,
    lastAttemptAt: nowIso(now),
    lastError: ok ? null : String(error || 'notification_failed').slice(0, 120),
    nextRetryAt: null,
    exhausted: ok ? false : previous.exhausted === true,
  };
  if (!ok) {
    if (notification.attempts >= MAX_NOTIFICATION_ATTEMPTS) {
      notification.exhausted = true;
    } else {
      const delay = Number.isFinite(Number(retryDelayMs)) ? Math.max(0, Number(retryDelayMs)) : 0;
      notification.nextRetryAt = new Date(now + delay).toISOString();
    }
  }
  record.notification = notification;
  save();
  return publicApproval(record);
}

function listApprovals(botId, { limit = 50, status = null } = {}) {
  assertBot(botId);
  const current = load();
  const max = Math.min(Math.max(Number(limit) || 50, 1), 200);
  return Object.values(current.approvals)
    .filter(item => item.botId === botId && (!status || item.status === status))
    .sort((a, b) => String(b.requestedAt).localeCompare(String(a.requestedAt)))
    .slice(0, max)
    .map(publicApproval);
}

function getApproval(approvalId) {
  const current = load();
  return publicApproval(current.approvals[String(approvalId || '')] || null);
}

function getRawApproval(approvalId) {
  const current = load();
  return current.approvals[String(approvalId || '')] || null;
}

function pendingCount() {
  // 已取消的请求即使执行生命周期仍是 pending（向后兼容读），也不再占用待审批额度。
  return Object.values(load().approvals).filter(
    item => item.status === 'pending' && requestStatusOf(item) !== 'cancelled'
  ).length;
}

// S6：审批入口只能从 running 进入。既有调用方（HTTP 与测试）可能对 queued/accepted
// 任务发起审批，这里按主链路补齐执行前迁移，最后停在 waiting_approval。
// S6b：执行前审批也必须受 Task deadline 约束——accepted→running 时补写本次执行
// 起点 startedAt，供 waiting_approval 计时按既有 deadline 语义（起点 + deadlineMs）起算。
function moveTaskToApproval(task) {
  try {
    if (task.status === 'queued') tasks.transitionTask(task.taskId, { to: 'accepted' });
    if (task.status === 'accepted') {
      tasks.transitionTask(task.taskId, {
        to: 'running',
        ...(task.startedAt ? {} : { startedAt: nowIso() }),
      });
    }
    if (task.status === 'running') {
      tasks.transitionTask(task.taskId, { to: 'waiting_approval' });
    }
    if (task.status !== 'waiting_approval') {
      throw new AgentError(
        'invalid_transition',
        `任务状态不能进入 waiting_approval：${task.status}`,
        409
      );
    }
  } catch (error) {
    // 入口迁移失败是结构性错误，不再静默吞掉；调用方收到原始错误码。
    console.warn(
      `[agent-approval] task approval entry failed task=${task.taskId} code=${
        (error && error.code) || 'approval_entry_failed'
      }`
    );
    throw error;
  }
}

/**
 * P3：审批执行的幂等键。
 *
 * taskId 走账本的 taskId 字段（没有关联任务时退化为 approvalId，账本要求非空）；
 * stepId 仍然内容寻址（工具 + 参数），但额外用 approvalId 作为第三分量加盐：
 * 每个审批是一次独立的用户授权，两条同参审批不能互相合并成一次执行；
 * approvalId 是稳定身份而非位置量，重启后照样算得出同一个键。
 */
function approvalLedgerKey(record) {
  const ledgerTaskId = record.taskId || record.approvalId;
  const stepId = opLedger.deriveStepId({
    toolName: record.operation,
    args: record.payload,
    override: record.approvalId,
  });
  const opKey = opLedger.buildOpKey({
    agentId: record.botId,
    taskId: ledgerTaskId,
    stepId,
    toolName: record.operation,
    args: record.payload,
  });
  return { ledgerTaskId, opKey };
}

/**
 * 结果不确定（账本 started/unknown、执行抛异常、账本读不出来）。
 * 审批状态词表里没有 recovery，所以记录退回 approved 并带 errorCode 等人工核对；
 * 任务收口为 recovery，绝不自动重试，也绝不写成 failed。
 */
function settleUncertain(record, code) {
  const at = nowIso();
  record.status = 'approved';
  record.errorCode = code;
  record.executedAt = at;
  record.result = null;
  save();

  const taskId = record.taskId;
  if (taskId) {
    const task = tasks.getRawTask(taskId);
    if (task && !tasks.isTerminalStatus(task.status) && task.status !== 'recovery') {
      const recoveryResult = normalizeWorkerResult({
        status: 'recovery',
        summary: '',
        errorCode: code,
        runId: task.runId || null,
        finishedAt: at,
      });
      try {
        tasks.transitionTask(taskId, {
          to: 'recovery',
          completedAt: at,
          errorCode: code,
          result: recoveryResult,
        });
        deliverTaskResult(taskId, { status: 'recovery', result: recoveryResult, errorCode: code });
      } catch (error) {
        console.warn(
          `[agent-approval] task recovery settle failed task=${taskId} code=${
            (error && error.code) || 'invalid_transition'
          }`
        );
      }
    }
  }

  recordEvent(
    record.botId,
    'approval.resolved',
    {
      status: 'approved',
      decision: 'recovery_required',
      taskType: record.operation,
      errorCode: code,
      mode: 'approval',
    },
    { approvalId: record.approvalId, taskId: record.taskId, sessionId: record.sessionId }
  );
  return publicApproval(record);
}

/** 审批出口：任务从 waiting_approval 回到 running；其他状态原样返回。 */
function resumeApprovalTask(record) {
  if (!record.taskId) return null;
  const task = tasks.getRawTask(record.taskId);
  if (!task || tasks.isTerminalStatus(task.status)) return null;
  if (task.status === 'waiting_approval') {
    tasks.transitionTask(record.taskId, { to: 'running' });
  }
  return tasks.getRawTask(record.taskId);
}

/** 已确认执行成功：产物先落盘，再提交引用与完成状态（§11 第 1–3 步）。 */
function completeApprovalTask(record, summary, now) {
  const task = resumeApprovalTask(record);
  if (!task || task.status !== 'running') return;
  const safeSummary = summary && typeof summary === 'object' ? summary : {};
  try {
    const artifactRefs = artifactCommit.persistTaskArtifacts({
      taskId: record.taskId,
      runId: task.runId || null,
      artifacts: safeSummary.id
        ? [
            {
              kind: 'memory',
              content: { id: String(safeSummary.id), decision: record.operation },
            },
          ]
        : [],
    });
    // P5 注入点：产物已落盘（pending-commit）、任务状态还没提交。
    crashHook.hold('artifact.after-persist');
    const taskResult = normalizeWorkerResult({
      status: 'completed',
      summary: `已执行审批操作：${record.operation}`,
      artifacts: artifactRefs,
      toolSteps: [],
      evidence: Array.isArray(safeSummary.supersededIds)
        ? safeSummary.supersededIds.map(id => ({ kind: 'memory', id }))
        : safeSummary.id
          ? [{ kind: 'memory', id: safeSummary.id }]
          : [],
      changes: safeSummary.id
        ? [{ kind: 'memory', id: safeSummary.id, decision: record.operation }]
        : [],
      requiresConfirmation: false,
      rounds: 0,
      stopReason: null,
      model: null,
      runId: task.runId || null,
      finishedAt: now,
    });
    artifactCommit.completeTask(record.taskId, {
      completedAt: now,
      result: taskResult,
    });
    deliverTaskResult(record.taskId, { status: 'completed', result: taskResult });
    sessions.closeSession(record.botId, task.sessionId, {
      status: sessions.deriveLifecycleStatus('completed'),
      reason: null,
    });
  } catch (error) {
    // ③ §11 第 4 步：产物写失败不能静默留在 running，也不能当作 completed；
    // 已产生副作用（审批操作已执行），收口为 recovery 等人工核对。
    if (error && typeof error.code === 'string' && error.code.startsWith('artifact_')) {
      const current = tasks.getRawTask(record.taskId);
      if (current && current.status === 'running') {
        const recoveryResult = normalizeWorkerResult({
          status: 'recovery',
          summary: '',
          errorCode: error.code,
          runId: current.runId || null,
          finishedAt: nowIso(),
        });
        tasks.transitionTask(record.taskId, {
          to: 'recovery',
          completedAt: recoveryResult.finishedAt,
          errorCode: error.code,
          result: recoveryResult,
        });
        deliverTaskResult(record.taskId, {
          status: 'recovery',
          result: recoveryResult,
          errorCode: error.code,
        });
      }
    }
    // 其他任务状态竞争不影响审批执行结果。
  }
}

/** 已确认执行失败（无副作用残留）：任务收口为 failed。 */
function failApprovalTask(record, errorCode, now) {
  const task = resumeApprovalTask(record);
  if (!task || task.status !== 'running') return;
  const failureResult = normalizeWorkerResult({
    status: 'failed',
    summary: '',
    errorCode,
    runId: task.runId || null,
    finishedAt: now,
  });
  tasks.transitionTask(record.taskId, {
    to: 'failed',
    completedAt: now,
    errorCode,
    result: failureResult,
  });
  deliverTaskResult(record.taskId, { status: 'failed', result: failureResult, errorCode });
  sessions.closeSession(record.botId, task.sessionId, {
    status: sessions.deriveLifecycleStatus('failed'),
    reason: errorCode,
  });
}

// ④ 老记录缺四字段一律 fail-closed：不做“缺省即低风险”的兜底。
// R3 的 expiresAt / escalationAt 允许为 null（表示不设自动批准超时），但键必须存在。
function approvalPolicyState(record) {
  if (!record || typeof record !== 'object') {
    return { ok: false, problems: ['record'] };
  }
  const problems = [];
  for (const field of APPROVAL_POLICY_FIELDS) {
    if (!Object.prototype.hasOwnProperty.call(record, field)) problems.push(field);
  }
  if (typeof record.riskLevel !== 'string' || !['R0', 'R1', 'R2', 'R3'].includes(record.riskLevel)) {
    problems.push('riskLevel');
  }
  for (const field of ['expiresAt', 'escalationAt']) {
    const value = record[field];
    if (value === null) continue;
    if (typeof value !== 'string' || !Number.isFinite(Date.parse(value))) {
      problems.push(field);
    }
  }
  if (!Number.isInteger(record.policyVersion) || record.policyVersion < 0) {
    problems.push('policyVersion');
  }
  return { ok: problems.length === 0, problems: [...new Set(problems)] };
}

function nextDueAt(record) {
  const candidates = [];
  if (record.escalationAt && !record.escalatedAt) candidates.push(Date.parse(record.escalationAt));
  if (record.expiresAt && !record.overdueAt) candidates.push(Date.parse(record.expiresAt));
  const valid = candidates.filter(value => Number.isFinite(value));
  return valid.length ? Math.min(...valid) : null;
}

function disarmDeadline(approvalId) {
  const key = String(approvalId || '');
  const timer = deadlineTimers.get(key);
  if (timer) clearTimeout(timer);
  deadlineTimers.delete(key);
}

function scheduleDeadline(record) {
  const key = String(record.approvalId || '');
  if (!key) return;
  disarmDeadline(key);
  if (record.status !== 'pending') return;
  // 已取消的请求不再挂 SLA 计时（status 仍是 pending 只是向后兼容读）。
  if (requestStatusOf(record) === 'cancelled') return;
  const dueAt = nextDueAt(record);
  if (dueAt === null) return;
  const timer = setTimeout(() => {
    deadlineTimers.delete(key);
    markOverdue(key);
    const latest = getRawApproval(key);
    if (latest && latest.status === 'pending') scheduleDeadline(latest);
  }, Math.max(0, dueAt - Date.now()));
  if (typeof timer.unref === 'function') timer.unref();
  deadlineTimers.set(key, timer);
}

/**
 * R2 到期只转人工：标记 escalation/overdue 并写事件，状态保持 pending，
 * 不改 Task 状态，更不产生批准效果（§32.1 第 4 条、§32.3）。
 */
function markOverdue(approvalId, { now = Date.now() } = {}) {
  const current = load();
  const record = current.approvals[String(approvalId || '')];
  if (!record || record.status !== 'pending') return null;
  // 已取消的请求不再产生升级/过期标记与事件。
  if (requestStatusOf(record) === 'cancelled') return null;
  const at = nowIso(now);
  const events = [];
  if (record.escalationAt && !record.escalatedAt && Date.parse(record.escalationAt) <= now) {
    record.escalatedAt = at;
    events.push('approval.escalated');
  }
  if (record.expiresAt && !record.overdueAt && Date.parse(record.expiresAt) <= now) {
    record.overdue = true;
    record.overdueAt = at;
    events.push('approval.overdue');
  }
  if (!events.length) return publicApproval(record);
  // §29：升级 → escalated；过期 → expired（原请求过期，需新 Approval Request）。
  if (events.includes('approval.escalated') && requestStatusOf(record) === 'pending') {
    record.requestStatus = 'escalated';
    record.requestStatusChangedAt = at;
  }
  if (events.includes('approval.overdue')) {
    const from = requestStatusOf(record);
    if (REQUEST_TRANSITIONS[from] && REQUEST_TRANSITIONS[from].includes('expired')) {
      record.requestStatus = 'expired';
      record.requestStatusChangedAt = at;
    }
  }
  save();
  for (const eventType of events) {
    recordEvent(
      record.botId,
      eventType,
      {
        status: 'pending',
        taskType: record.operation,
        mode: 'approval',
        // A-10 / §17：审批悬挂/超时统一归入 approval_stall，处置=升级审批。
        failureMode: 'approval_stall',
        decision: eventType === 'approval.overdue' ? 'overdue' : 'escalated',
      },
      { approvalId: record.approvalId, taskId: record.taskId, sessionId: record.sessionId }
    );
  }
  return publicApproval(record);
}

/**
 * 启动恢复 / 定时检查：把已到期的 R2 标记为 overdue，并给未来的到期点挂计时器。
 * R3（无 expiresAt/escalationAt）永不在这里被“超时处理”，可长期 pending。
 */
function expireDueApprovals({ now = Date.now() } = {}) {
  const current = load();
  const result = { checked: 0, escalated: [], overdue: [] };
  for (const record of Object.values(current.approvals)) {
    if (record.status !== 'pending') continue;
    // 已取消的请求不再参与 SLA 检查（status 仍是 pending 只是向后兼容读）。
    if (requestStatusOf(record) === 'cancelled') continue;
    result.checked += 1;
    if (!record.expiresAt && !record.escalationAt) continue;
    const beforeEscalated = record.escalatedAt || null;
    const beforeOverdue = record.overdueAt || null;
    markOverdue(record.approvalId, { now });
    if (!beforeEscalated && record.escalatedAt) result.escalated.push(record.approvalId);
    if (!beforeOverdue && record.overdueAt) result.overdue.push(record.approvalId);
    scheduleDeadline(record);
  }
  return result;
}

/**
 * §29 提醒路径：只对仍在等待人工处理的请求记账并写事件。
 * 提醒不改变审批状态、不产生批准效果，也不重置 SLA 计时。
 */
function remindApproval(
  approvalId,
  { actor = 'system', now = Date.now(), channel = null } = {}
) {
  const current = load();
  const record = current.approvals[String(approvalId || '')];
  if (!record) throw new AgentError('approval_not_found', '审批不存在', 404);
  if (record.status !== 'pending') {
    throw new AgentError('approval_not_pending', '审批当前状态不允许提醒', 409);
  }
  const request = requestStatusOf(record);
  if (request === 'cancelled' || request === 'rejected' || request === 'expired') {
    throw new AgentError('approval_not_remindable', '审批请求已关闭，不能再提醒', 409);
  }
  const previous =
    record.reminder && typeof record.reminder === 'object' ? record.reminder : {};
  const at = nowIso(now);
  record.reminder = {
    count: (Number.isInteger(previous.count) ? previous.count : 0) + 1,
    lastAt: at,
    lastBy: String(actor || 'system').slice(0, 80),
    channel: typeof channel === 'string' ? channel.slice(0, 60) : null,
  };
  save();
  recordEvent(
    record.botId,
    'approval.reminded',
    {
      status: record.status,
      requestStatus: request,
      decision: 'reminded',
      taskType: record.operation,
      mode: 'approval',
      ...(channel ? { channel: String(channel).slice(0, 60) } : {}),
    },
    { approvalId: record.approvalId, taskId: record.taskId, sessionId: record.sessionId }
  );
  return publicApproval(record);
}

/**
 * §29 升级路径：显式把 pending 请求升级给更高一级人工（不自动批准）。
 * 与 SLA 到点的 markOverdue 走同一条 requestStatus 迁移，只是触发来源不同。
 */
function escalateApproval(
  approvalId,
  { actor = 'system', reason = null, now = Date.now(), source = 'manual' } = {}
) {
  const current = load();
  const record = current.approvals[String(approvalId || '')];
  if (!record) throw new AgentError('approval_not_found', '审批不存在', 404);
  if (record.status !== 'pending') {
    throw new AgentError('approval_not_pending', '审批当前状态不允许升级', 409);
  }
  const request = requestStatusOf(record);
  if (request === 'cancelled') {
    throw new AgentError('approval_not_escalatable', '审批请求已取消，不能升级', 409);
  }
  if (request === 'escalated') return publicApproval(record);
  assertRequestStatusTransition(request, 'escalated');
  const at = nowIso(now);
  record.requestStatus = 'escalated';
  record.requestStatusChangedAt = at;
  if (!record.escalatedAt) record.escalatedAt = at;
  record.escalationSource = String(source || 'manual').slice(0, 40);
  record.escalatedBy = String(actor || 'system').slice(0, 80);
  if (typeof reason === 'string') record.escalationReason = reason.slice(0, 200);
  // P5-F / §15：升级即重派——原责任人未响应，轮值取下一位（池子里只有他
  // 一人时保持原责任人，并如实记录）。幂等性由上方 request === 'escalated'
  // 的早退保证：重派只在首次升级发生一次。
  const previousAssignee = record.assignee || null;
  const reassigned = nextAssignee(current, { exclude: previousAssignee });
  record.assignee = reassigned;
  record.assigneeReassignedFrom = previousAssignee;
  save();
  recordEvent(
    record.botId,
    'approval.escalated',
    {
      status: record.status,
      requestStatus: 'escalated',
      decision: 'escalated',
      taskType: record.operation,
      mode: 'approval',
      failureMode: 'approval_stall',
      source: record.escalationSource,
      assignee: record.assignee || '',
    },
    { approvalId: record.approvalId, taskId: record.taskId, sessionId: record.sessionId }
  );
  return publicApproval(record);
}

/**
 * §29 取消路径（完整版）：
 *  - requestStatus → cancelled（status 保持原值，保证向后兼容读）；
 *  - 摘除 SLA 计时器，此后不再产生升级/过期标记；
 *  - 关联任务离开 waiting_approval，收口为 cancelled 并投递结果、关闭会话；
 *  - 已进入执行阶段的记录不允许取消，避免“执行中/已执行”被伪造成取消。
 */
function cancelApproval(
  approvalId,
  { actor = 'system', reason = null, now = Date.now() } = {}
) {
  const current = load();
  const record = current.approvals[String(approvalId || '')];
  if (!record) throw new AgentError('approval_not_found', '审批不存在', 404);
  if (['executing', 'completed', 'failed'].includes(record.status)) {
    throw new AgentError('approval_not_cancellable', '审批已进入执行阶段，不能取消', 409);
  }
  const request = requestStatusOf(record);
  if (request === 'cancelled') return publicApproval(record);
  assertRequestStatusTransition(request, 'cancelled');
  const at = nowIso(now);
  record.requestStatus = 'cancelled';
  record.requestStatusChangedAt = at;
  record.cancelledAt = at;
  record.cancelledBy = String(actor || 'system').slice(0, 80);
  record.cancelReason = typeof reason === 'string' ? reason.slice(0, 200) : null;
  disarmDeadline(record.approvalId);
  save();

  let taskCancelled = false;
  if (record.taskId) {
    const task = tasks.getRawTask(record.taskId);
    if (task && !tasks.isTerminalStatus(task.status) && task.status !== 'recovery') {
      const cancelResult = normalizeWorkerResult({
        status: 'cancelled',
        summary: '',
        errorCode: 'approval_cancelled',
        runId: task.runId || null,
        finishedAt: at,
      });
      try {
        tasks.transitionTask(record.taskId, {
          to: 'cancelled',
          completedAt: at,
          errorCode: 'approval_cancelled',
          result: cancelResult,
        });
        taskCancelled = true;
      } catch (_) {
        // 任务状态竞争不影响审批取消结果；等待审批对账会在重启时处理悬空。
      }
      if (taskCancelled) {
        deliverTaskResult(record.taskId, {
          status: 'cancelled',
          result: cancelResult,
          errorCode: 'approval_cancelled',
        });
        try {
          sessions.closeSession(record.botId, task.sessionId, {
            status: sessions.deriveLifecycleStatus('cancelled'),
            reason: 'approval_cancelled',
          });
        } catch (_) {
          // 会话收口失败不影响审批取消结果。
        }
      }
    }
  }

  recordEvent(
    record.botId,
    'approval.cancelled',
    {
      status: record.status,
      requestStatus: 'cancelled',
      decision: 'cancelled',
      taskType: record.operation,
      mode: 'approval',
    },
    { approvalId: record.approvalId, taskId: record.taskId, sessionId: record.sessionId }
  );
  return publicApproval(record);
}

function createApproval({
  botId,
  operation,
  payload,
  taskId = null,
  sessionId = null,
  requestedBy = 'agent',
} = {}) {
  assertBot(botId);
  const gate = gateOperation(operation);
  const checked = gate
    ? validateGatePayload(gate, payload)
    : memoryService.validate(operation, payload);
  if (!checked.ok) {
    throw new AgentError('invalid_approval', `审批参数无效：${checked.error}`);
  }
  // 门禁操作没有记忆副作用，不受记忆操作权限白名单约束（风险由 riskLevel 表达）。
  if (!gate) {
    const profile = permissions.getPermissionProfile(botId);
    if (!profile.allowedOperations.includes(operation)) {
      throw new AgentError('operation_not_allowed', '该操作不在当前 Bot 权限范围');
    }
  }

  const requestTaskId =
    typeof taskId === 'string' && taskId.trim() ? taskId.trim() : null;
  const requestSessionId =
    typeof sessionId === 'string' && sessionId.trim() ? sessionId.trim() : null;

  if (requestTaskId) {
    const task = tasks.getRawTask(requestTaskId);
    if (!task || task.botId !== botId) {
      throw new AgentError('task_not_found', '关联任务不存在', 404);
    }
  }
  if (requestSessionId && !sessions.getSession(botId, requestSessionId)) {
    throw new AgentError('agent_session_not_found', '关联 Bot 会话不存在', 404);
  }
  if (pendingCount() >= PENDING_MAX) {
    throw new AgentError('approval_limit', '待审批数量已达上限，请先处理现有申请');
  }

  const current = load();
  if (Object.keys(current.approvals).length >= APPROVAL_MAX) {
    const prune = Object.values(current.approvals)
      .filter(item => TERMINAL.has(item.status))
      .sort((a, b) => String(a.requestedAt).localeCompare(String(b.requestedAt)))
      .slice(0, 100);
    for (const item of prune) delete current.approvals[item.approvalId];
  }

  const now = nowIso();
  const risk = gate ? gate.risk : memoryService.RISK[operation] || 'high';
  const riskLevel = RISK_LEVEL_BY_RISK[risk] || 'R3';
  const createdAt = Date.parse(now);
  // R2 有 30 分钟审批 SLA 与升级点；R3 两者为 null，表示不设自动批准超时。
  const expiresAt =
    riskLevel === 'R2' ? new Date(createdAt + R2_SLA_MS).toISOString() : null;
  const escalationAt =
    riskLevel === 'R2'
      ? new Date(createdAt + R2_SLA_MS * R2_ESCALATION_RATIO).toISOString()
      : null;
  // 冻结审批当时的策略版本；策略表不可读时为 null，执行侧按 fail-closed 拒绝。
  const policyVersion = failOpenPolicy.currentPolicyVersion();
  const record = {
    approvalId: `appr_${crypto.randomUUID()}`,
    botId,
    taskId: requestTaskId,
    sessionId: requestSessionId,
    operation,
    payload: checked.value,
    risk,
    riskLevel,
    expiresAt,
    escalationAt,
    policyVersion,
    overdue: false,
    overdueAt: null,
    escalatedAt: null,
    status: 'pending',
    // §29：Approval Request 自身状态与执行生命周期 status 并列。
    requestStatus: 'pending',
    requestStatusChangedAt: now,
    // §29 SLA 持久化：冻结创建时的版本、风险等级、阈值与到期点，
    // 供重启恢复、提醒/升级/取消路径与审计复读；旧记录缺省时只读派生。
    sla: {
      slaPolicyVersion: APPROVAL_SLA_POLICY_VERSION,
      policyVersion,
      riskLevel,
      slaMs: riskLevel === 'R2' ? R2_SLA_MS : null,
      escalationRatio: riskLevel === 'R2' ? R2_ESCALATION_RATIO : null,
      startedAt: now,
      escalationAt,
      expiresAt,
    },
    reminder: { count: 0, lastAt: null, lastBy: null, channel: null },
    cancelledAt: null,
    cancelledBy: null,
    cancelReason: null,
    escalationSource: null,
    notification: {
      attempts: 0,
      lastError: null,
      lastAttemptAt: null,
      nextRetryAt: null,
      exhausted: false,
    },
    requestedBy:
      requestedBy === 'user' || requestedBy === 'agent' ? requestedBy : 'agent',
    requestedAt: now,
    // P5-F / §15：责任人与轮值分配（创建时按轮值游标落一名责任人；
    // 升级时重派，见 escalateApproval）。旧记录缺该字段读作 null。
    assignee: nextAssignee(current),
    assigneePolicyVersion: APPROVAL_ASSIGNEE_POLICY_VERSION,
    decidedBy: null,
    decidedAt: null,
    executedBy: null,
    executedAt: null,
    reason: null,
    errorCode: null,
    result: null,
  };
  // P3 / W5：先落审批记录，再迁任务状态。
  // 旧顺序（先迁 waiting_approval 再落记录）在两步之间崩溃会留下「任务等审批、
  // 却没有任何审批记录」的永久悬空；新顺序崩在中间只会留下「记录 pending、
  // 任务还在原状态」，重启时由 recoverInterrupted 的待审批对账推回 waiting_approval。
  current.approvals[record.approvalId] = record;
  save();
  // P5 注入点：审批记录已落盘、任务还没迁到 waiting_approval（W5 的崩溃窗口）。
  crashHook.hold('approval.after-record-save');

  // S6 入口前置：审批只能从 running 进入；queued/accepted 先补齐执行前迁移，
  // 再把任务暂停在 waiting_approval。迁移失败时回滚审批记录并向上抛出。
  if (requestTaskId) {
    const task = tasks.getRawTask(requestTaskId);
    if (task && !tasks.isTerminalStatus(task.status) && task.status !== 'waiting_approval') {
      try {
        moveTaskToApproval(task);
      } catch (error) {
        delete current.approvals[record.approvalId];
        save();
        throw error;
      }
    }
  }

  // R2 的升级/到期只挂计时器做标记；R3 没有自动批准超时，不挂计时。
  scheduleDeadline(record);

  recordEvent(
    botId,
    'approval.requested',
    {
      status: 'pending',
      taskType: operation,
      mode: 'approval',
      assignee: record.assignee || '',
    },
    { approvalId: record.approvalId, taskId: requestTaskId, sessionId: requestSessionId }
  );
  return publicApproval(record);
}

function decide(
  approvalId,
  decision,
  { actor = permissions.SINGLE_USER_ACTOR, reason = null, batchId = null } = {}
) {
  const current = load();
  const record = current.approvals[String(approvalId || '')];
  if (!record) throw new AgentError('approval_not_found', '审批不存在', 404);
  if (!['pending', 'approved'].includes(record.status)) {
    throw new AgentError('approval_not_pending', '审批当前状态不允许该操作', 409);
  }
  if (decision === 'reject' && !['pending', 'approved'].includes(record.status)) {
    throw new AgentError('approval_not_pending', '审批当前状态不允许拒绝', 409);
  }
  if (decision === 'approve' && record.status !== 'pending') {
    throw new AgentError('approval_not_pending', '只有待审批记录可以批准', 409);
  }

  // §29：六态迁移先校验后落库；expired 的原请求不得被批准（需新审批）。
  const requestTo = decision === 'approve' ? 'approved' : 'rejected';
  assertRequestStatusTransition(requestStatusOf(record), requestTo);

  const now = nowIso();
  record.status = decision === 'approve' ? 'approved' : 'rejected';
  record.requestStatus = requestTo;
  record.requestStatusChangedAt = now;
  record.decidedBy = String(actor || permissions.SINGLE_USER_ACTOR).slice(0, 80);
  record.decidedAt = now;
  record.reason = typeof reason === 'string' ? reason.slice(0, 200) : null;
  if (batchId) record.batchId = String(batchId).slice(0, 80);
  // 离开 pending 后不再需要 escalation/overdue 计时。
  disarmDeadline(record.approvalId);
  save();

  if (decision === 'reject' && record.taskId) {
    const task = tasks.getRawTask(record.taskId);
    if (task && !tasks.isTerminalStatus(task.status)) {
      let updated = false;
      const rejectResult = normalizeWorkerResult({
        status: 'cancelled',
        summary: '',
        errorCode: 'approval_rejected',
        runId: task.runId || null,
        finishedAt: now,
      });
      try {
        tasks.transitionTask(record.taskId, {
          to: 'cancelled',
          completedAt: now,
          errorCode: 'approval_rejected',
          result: rejectResult,
        });
        updated = true;
      } catch (_) {
        // 任务状态竞争不影响审批结果。
      }
      if (updated) {
        deliverTaskResult(record.taskId, {
          status: 'cancelled',
          result: rejectResult,
          errorCode: 'approval_rejected',
        });
        try {
          sessions.closeSession(record.botId, task.sessionId, {
            status: sessions.deriveLifecycleStatus('cancelled'),
            reason: 'approval_rejected',
          });
        } catch (_) {
          // 会话收口失败不影响审批结果。
        }
      }
    }
  }

  recordEvent(
    record.botId,
    'approval.resolved',
    {
      status: record.status,
      decision: record.status,
      taskType: record.operation,
      mode: 'approval',
    },
    { approvalId: record.approvalId, taskId: record.taskId, sessionId: record.sessionId }
  );
  return publicApproval(record);
}

function approve(approvalId, options) {
  return decide(approvalId, 'approve', options);
}

function reject(approvalId, options) {
  return decide(approvalId, 'reject', options);
}

/**
 * A-08 批量裁决：同风险等级、同动作类型的多条审批一次裁决。
 *
 * - 单条失败不吞掉其它条：每条独立 try/catch，返回逐条结果；
 * - 组基准取第一条存在的记录；风险等级/动作类型不一致的条目单独记失败、不裁决；
 * - 每条成功裁决都由 decide() 落 `approval.resolved` 审计，并写回 batchId 供追溯。
 */
function batchDecide({
  approvalIds,
  decision,
  actor = permissions.SINGLE_USER_ACTOR,
  reason = null,
} = {}) {
  if (!Array.isArray(approvalIds) || approvalIds.length === 0) {
    throw new AgentError('invalid_approval', '批量审批必须提供非空 approvalIds 数组', 400);
  }
  if (approvalIds.length > APPROVAL_BATCH_MAX) {
    throw new AgentError(
      'invalid_approval',
      `批量审批最多 ${APPROVAL_BATCH_MAX} 条（本仓库裁决，非 Notion 原文）`,
      400
    );
  }
  if (!['approve', 'reject'].includes(decision)) {
    throw new AgentError('invalid_approval', '批量裁决只支持 approve / reject', 400);
  }
  const ids = approvalIds.map(id => String(id === null || id === undefined ? '' : id).trim());
  if (ids.some(id => !id)) {
    throw new AgentError('invalid_approval', 'approvalIds 不能包含空值', 400);
  }
  if (new Set(ids).size !== ids.length) {
    throw new AgentError('invalid_approval', 'approvalIds 不能重复', 400);
  }

  const current = load();
  const batchId = `bat_${crypto.randomUUID()}`;
  const results = [];
  let group = null;
  for (const approvalId of ids) {
    const record = current.approvals[approvalId];
    if (!record) {
      results.push({ approvalId, ok: false, errorCode: 'approval_not_found' });
      continue;
    }
    const riskLevel = typeof record.riskLevel === 'string' ? record.riskLevel : null;
    if (!group) {
      group = { operation: record.operation, riskLevel };
    } else if (record.operation !== group.operation || riskLevel !== group.riskLevel) {
      results.push({
        approvalId,
        ok: false,
        errorCode: 'approval_batch_mismatch',
        error: `与批量基准不一致（基准 ${group.operation}/${group.riskLevel || 'unknown'}）`,
      });
      continue;
    }
    try {
      const approval = decide(approvalId, decision, { actor, reason, batchId });
      results.push({ approvalId, ok: true, approval });
    } catch (error) {
      results.push({
        approvalId,
        ok: false,
        errorCode: (error && error.code) || 'internal_error',
        error: error && error.message ? error.message : String(error),
      });
    }
  }
  const applied = results.filter(item => item.ok).length;
  return {
    policyVersion: APPROVAL_BATCH_POLICY_VERSION,
    batchId,
    decision,
    requested: ids.length,
    applied,
    failed: ids.length - applied,
    results,
  };
}

/**
 * A-08 申诉：被拒绝的审批可由 Owner 发起一次申诉（24 小时窗口）。
 * 只追加 appeals 历史与 appealStatus，不改原裁决字段；改判在 resolveAppeal() 里落。
 */
function appealApproval(
  approvalId,
  { actor = permissions.SINGLE_USER_ACTOR, reason = null, now = Date.now() } = {}
) {
  if (!APPEAL_ALLOWED_ACTORS.includes(String(actor || ''))) {
    throw new AgentError('not_authorized', '只有 Owner 可以发起审批申诉', 403);
  }
  const current = load();
  const record = current.approvals[String(approvalId || '')];
  if (!record) throw new AgentError('approval_not_found', '审批不存在', 404);
  if (record.status !== 'rejected' || requestStatusOf(record) !== 'rejected') {
    throw new AgentError('approval_appeal_not_rejected', '只有被拒绝的审批可以申诉', 409);
  }
  const appeals = Array.isArray(record.appeals) ? record.appeals : [];
  if (appeals.length >= APPEAL_MAX_TIMES) {
    throw new AgentError(
      'approval_appeal_exhausted',
      '该审批已申诉过，不能再次申诉（本仓库裁决，非 Notion 原文）',
      409
    );
  }
  const decidedAt = Date.parse(record.decidedAt || '');
  if (!Number.isFinite(decidedAt)) {
    throw new AgentError('approval_appeal_window_closed', '缺少原裁决时间，不能申诉', 409);
  }
  if (now - decidedAt > APPEAL_WINDOW_MS) {
    throw new AgentError(
      'approval_appeal_window_closed',
      '申诉窗口已关闭（本仓库裁决：拒绝后 24 小时内，非 Notion 原文）',
      409
    );
  }
  const cleanReason = typeof reason === 'string' ? reason.trim().slice(0, 200) : '';
  if (!cleanReason) {
    throw new AgentError('invalid_approval', '申诉必须填写理由', 400);
  }

  const appeal = {
    appealId: `apl_${crypto.randomUUID()}`,
    requestedBy: String(actor).slice(0, 80),
    requestedAt: nowIso(now),
    reason: cleanReason,
    outcome: 'pending',
    decidedBy: null,
    decidedAt: null,
    decisionReason: null,
  };
  appeals.push(appeal);
  record.appeals = appeals;
  record.appealStatus = 'pending';
  record.appealPolicyVersion = APPROVAL_APPEAL_POLICY_VERSION;
  save();

  recordEvent(
    record.botId,
    'approval.appealed',
    {
      status: 'pending',
      decision: 'appeal_requested',
      mode: 'approval_appeal',
      policyVersion: APPROVAL_APPEAL_POLICY_VERSION,
      detail: cleanReason,
    },
    { approvalId: record.approvalId, taskId: record.taskId, sessionId: record.sessionId }
  );
  return publicApproval(record);
}

/**
 * A-08 申诉裁决：uphold 维持原拒绝；overturn 改判为 approved。
 * 改判前先把原裁决冻结到 originalDecision，status/requestStatus 改判后仍保留完整历史。
 *
 * 限定（本仓库裁决）：改判只写回审批记录，不复活 reject 时已 cancelled 的任务；
 * 任务侧需重新发起。改判不重置 SLA（不重新计时、不自动执行）。
 */
function resolveAppeal(
  approvalId,
  { decision, actor = permissions.SINGLE_USER_ACTOR, reason = null, now = Date.now() } = {}
) {
  if (!APPEAL_ALLOWED_ACTORS.includes(String(actor || ''))) {
    throw new AgentError('not_authorized', '只有 Owner 可以裁决申诉', 403);
  }
  if (!APPEAL_DECISIONS.includes(decision)) {
    throw new AgentError('invalid_approval', '申诉裁决只支持 overturn / uphold', 400);
  }
  const current = load();
  const record = current.approvals[String(approvalId || '')];
  if (!record) throw new AgentError('approval_not_found', '审批不存在', 404);
  const appeals = Array.isArray(record.appeals) ? record.appeals : [];
  const index = appeals.findIndex(item => item && item.outcome === 'pending');
  if (index < 0) {
    throw new AgentError('approval_appeal_not_pending', '没有待处理的申诉', 409);
  }

  const cleanReason = typeof reason === 'string' ? reason.trim().slice(0, 200) : null;
  const appeal = appeals[index];
  appeal.outcome = decision === 'overturn' ? 'overturned' : 'upheld';
  appeal.decidedBy = String(actor).slice(0, 80);
  appeal.decidedAt = nowIso(now);
  appeal.decisionReason = cleanReason;
  record.appealStatus = appeal.outcome;
  record.appeals = appeals;

  if (decision === 'overturn') {
    if (!record.originalDecision) {
      record.originalDecision = {
        status: record.status,
        requestStatus: requestStatusOf(record),
        decidedBy: record.decidedBy || null,
        decidedAt: record.decidedAt || null,
        reason: record.reason || null,
      };
    }
    record.status = 'approved';
    record.requestStatus = 'approved';
    record.requestStatusChangedAt = nowIso(now);
    record.reappliedAt = nowIso(now);
  }
  save();

  recordEvent(
    record.botId,
    'approval.appealed',
    {
      status: record.appealStatus,
      decision: decision === 'overturn' ? 'appeal_overturned' : 'appeal_upheld',
      mode: 'approval_appeal',
      policyVersion: APPROVAL_APPEAL_POLICY_VERSION,
      ...(cleanReason ? { detail: cleanReason } : {}),
    },
    { approvalId: record.approvalId, taskId: record.taskId, sessionId: record.sessionId }
  );
  return publicApproval(record);
}

/**
 * A-08 审批负载：待审队列分布（按风险等级 / 动作类型 / 等待时长）。
 * 计数来自真实待审记录；吞吐、SLA 达成率、P95 等待等性能指标需要压测，
 * 这里只留字段位并固定为 null，不填估算值。
 */
function approvalQueueDistribution({ botId = null, now = Date.now() } = {}) {
  if (botId) assertBot(botId);
  const current = load();
  const pending = Object.values(current.approvals).filter(
    item =>
      item.status === 'pending' &&
      requestStatusOf(item) !== 'cancelled' &&
      (!botId || item.botId === botId)
  );
  const byRiskLevel = { R2: 0, R3: 0, unknown: 0 };
  const byOperation = {};
  const byAssignee = { unassigned: 0 };
  const waitingBuckets = { lt5m: 0, lt30m: 0, lt2h: 0, gte2h: 0 };
  let oldestWaitMs = 0;
  for (const item of pending) {
    const riskLevel = typeof item.riskLevel === 'string' ? item.riskLevel : 'unknown';
    byRiskLevel[riskLevel] = (byRiskLevel[riskLevel] || 0) + 1;
    byOperation[item.operation] = (byOperation[item.operation] || 0) + 1;
    // P5-F / §15：按责任人的待处理量；旧记录没有 assignee，如实在 unassigned 里。
    const assignee = typeof item.assignee === 'string' && item.assignee ? item.assignee : 'unassigned';
    byAssignee[assignee] = (byAssignee[assignee] || 0) + 1;
    const requestedAt = Date.parse(item.requestedAt || '');
    const waitMs = Number.isFinite(requestedAt) ? Math.max(0, now - requestedAt) : 0;
    if (waitMs < 5 * 60 * 1000) waitingBuckets.lt5m += 1;
    else if (waitMs < 30 * 60 * 1000) waitingBuckets.lt30m += 1;
    else if (waitMs < 2 * 60 * 60 * 1000) waitingBuckets.lt2h += 1;
    else waitingBuckets.gte2h += 1;
    if (waitMs > oldestWaitMs) oldestWaitMs = waitMs;
  }

  // P5-F / §15 + §18（A-08/A-11）：等待时长分位与 SLA 达成率直接从审批记录算出，
  // 不再留 requires_load_test 空位。口径（本仓库裁决，改动升版本）：
  //  - 样本 = 有 decidedAt 的**裁决**记录（approved/rejected/expired/escalated；
  //    cancelled 不是对事项的裁决，不入分母）；
  //  - 等待时长 = decidedAt - requestedAt；分位是样本分位点（近似值，如实标注）；
  //  - SLA 达成率只对有 SLA 的等级（R2 有 slaMs）计算；R3 无 SLA，单独计数
  //    不进分母——把"没有期限"算成"达成"会虚高。
  const decidedScope = botId
    ? item => item.botId === botId
    : () => true;
  const decided = Object.values(current.approvals).filter(
    item =>
      decidedScope(item) &&
      item.status !== 'pending' &&
      typeof item.decidedAt === 'string' &&
      Date.parse(item.decidedAt) > 0 &&
      requestStatusOf(item) !== 'cancelled'
  );
  const waits = decided
    .map(item => Date.parse(item.decidedAt) - Date.parse(item.requestedAt || item.decidedAt))
    .filter(ms => Number.isFinite(ms) && ms >= 0)
    .sort((a, b) => a - b);
  const percentile = (sorted, ratio) => {
    if (!sorted.length) return null;
    const index = Math.min(sorted.length - 1, Math.ceil(sorted.length * ratio) - 1);
    return sorted[Math.max(0, index)];
  };
  const p50WaitMs = percentile(waits, 0.5);
  const p95WaitMs = percentile(waits, 0.95);

  const withSla = decided.filter(item => {
    const view = slaViewOf(item);
    return view.riskLevel === 'R2' && Number.isInteger(view.slaMs);
  });
  const withinSla = withSla.filter(item => {
    const view = slaViewOf(item);
    return Date.parse(item.decidedAt) - Date.parse(item.requestedAt) <= view.slaMs;
  });
  const slaComplianceRate = withSla.length ? withinSla.length / withSla.length : null;

  const DAY_MS = 24 * 60 * 60 * 1000;
  const decidedLastDay = decided.filter(
    item => now - Date.parse(item.decidedAt) <= DAY_MS
  ).length;
  const throughputPerHour = decidedLastDay > 0 ? decidedLastDay / 24 : null;

  const noSamples = waits.length === 0;
  return {
    // v2（P5-F / §15 + §18）：分位与 SLA 达成率改为从记录实算；样本不足如实 null。
    policyVersion: 'approval-workload-v2',
    generatedAt: nowIso(now),
    botId: botId || null,
    totalPending: pending.length,
    byRiskLevel,
    byOperation,
    byAssignee,
    waitingBuckets,
    oldestWaitMs,
    metrics: {
      source: 'computed_from_records',
      sampleCount: waits.length,
      // 近似分位：直接取排位样本点，不是插值；样本少时波动大，读数须带 caveat。
      p50WaitMs,
      p95WaitMs,
      slaComplianceRate,
      slaSampleCount: withSla.length,
      slaNotApplicable: decided.filter(item => {
        const view = slaViewOf(item);
        return !(view.riskLevel === 'R2' && Number.isInteger(view.slaMs));
      }).length,
      throughputPerHour,
      caveat: noSamples
        ? '样本里还没有已裁决的审批记录，等待分位与 SLA 达成率不可算'
        : waits.length < 5
          ? '裁决样本不足 5 条，分位波动大，只作参考'
          : null,
    },
  };
}

async function execute(approvalId, { actor = permissions.SINGLE_USER_ACTOR } = {}) {
  const current = load();
  const record = current.approvals[String(approvalId || '')];
  if (!record) throw new AgentError('approval_not_found', '审批不存在', 404);
  if (record.status !== 'approved') {
    throw new AgentError('approval_not_approved', '审批尚未批准，不能执行', 409);
  }
  // §29：请求已取消时，即使执行生命周期仍是 approved（向后兼容读），也绝不执行。
  if (requestStatusOf(record) === 'cancelled') {
    throw new AgentError('approval_cancelled', '审批请求已取消，不能执行', 409);
  }
  // ④ 老记录缺 riskLevel/expiresAt/escalationAt/policyVersion 时 fail-closed：
  // 不执行、不推进任务、不把“缺字段”当作低风险。
  const policyState = approvalPolicyState(record);
  if (!policyState.ok) {
    throw new AgentError(
      'approval_policy_missing',
      `审批记录缺少必需字段（${policyState.problems.join('、')}），按 fail-closed 拒绝执行`,
      409
    );
  }

  const gate = gateOperation(record.operation);
  if (!gate) {
    const permission = permissions.checkOperation({
      botId: record.botId,
      operation: record.operation,
      approved: true,
    });
    if (!permission.ok) {
      throw new AgentError('operation_not_allowed', '当前权限不允许执行该操作', 403);
    }
  }

  if (record.taskId) {
    const linked = tasks.getRawTask(record.taskId);
    if (!linked || linked.status !== 'waiting_approval') {
      throw new AgentError(
        'task_not_waiting_approval',
        '关联任务不在等待审批状态，不能执行该审批',
        409
      );
    }
  }

  // 门禁操作（review.conflict / review.escalate）没有外部副作用与记忆写入，
  // 因此不进操作账本、不调用 memoryService；人工批准只表达"允许越过保守裁决"，
  // 任务按既有 completeApprovalTask 收口。拒绝走既有 decide() → cancelled。
  if (gate) {
    // P5-C2：plan.publish 的批准即交付。交付动作（读回 delivery 产物 → 产物提交
    // → 任务 completed → 幂等回写父会话）由 publish-gate 统一执行；失败按其
    // 既有口径收口，审批记录停留 pending 可重试。
    if (record.operation === 'plan.publish') {
      const publishGate = require('./publish-gate');
      const gateNow = nowIso();
      const delivery = publishGate.deliverOnApproval(record, { actor, now: gateNow });
      record.status = 'completed';
      record.errorCode = null;
      record.result = {
        reason: 'ok',
        gate: record.operation,
        decision: 'publish_delivered',
        artifactId: delivery.ref.id,
      };
      record.executedBy = String(actor || permissions.SINGLE_USER_ACTOR).slice(0, 80);
      record.executedAt = gateNow;
      save();
      recordEvent(
        record.botId,
        'approval.resolved',
        {
          status: 'completed',
          decision: 'publish_delivered',
          taskType: record.operation,
          mode: 'approval',
        },
        { approvalId: record.approvalId, taskId: record.taskId, sessionId: record.sessionId }
      );
      // 轮 3：发布审批收口后回查编排——发布门要求全部命中节点批准完毕才根交付，
      // 最后一条批准在这里触发归约重查（fail-safe，失败不影响审批结论）。
      if (record.payload && record.payload.planId) {
        try {
          require('./orchestration-engine')
            .maybeReducePlan(String(record.payload.planId))
            .catch(() => {});
        } catch (_) {
          // 回查失败不改变审批结论。
        }
      }
      return publicApproval(record);
    }
    const gateNow = nowIso();
    const gateResult = {
      reason: 'ok',
      gate: record.operation,
      decision: 'human_override',
      artifactId: record.payload.artifactId || null,
    };
    record.status = 'completed';
    record.errorCode = null;
    record.result = gateResult;
    record.executedBy = String(actor || permissions.SINGLE_USER_ACTOR).slice(0, 80);
    record.executedAt = gateNow;
    save();
    if (record.taskId) completeApprovalTask(record, gateResult, gateNow);
    recordEvent(
      record.botId,
      'approval.resolved',
      {
        status: 'completed',
        decision: 'human_override',
        taskType: record.operation,
        mode: 'approval',
      },
      { approvalId: record.approvalId, taskId: record.taskId, sessionId: record.sessionId }
    );
    return publicApproval(record);
  }

  // P3：幂等键先算出来并与 executing 同一笔落盘，重启时才能按 opKey 精确对账；
  // 参数无法规范化时 fail-closed（不执行、不推进任务）。
  let keyed;
  try {
    keyed = approvalLedgerKey(record);
  } catch (error) {
    record.errorCode = (error && error.code) || 'agent_op_args_invalid';
    save();
    throw error;
  }

  const guard = createSideEffectGuard({ agentId: record.botId, taskId: keyed.ledgerTaskId });

  record.status = 'executing';
  record.opKey = keyed.opKey;
  record.executedBy = String(actor || permissions.SINGLE_USER_ACTOR).slice(0, 80);
  record.executedAt = nowIso();
  save();

  // ① begin 先于 handler 落盘；账本写不下去就不执行。
  const begun = guard.before({
    toolName: record.operation,
    args: record.payload,
    override: record.approvalId,
  });

  if (begun.mode === 'blocked') {
    // 同键已有 started/unknown：副作用可能已经发生，绝不重跑。
    return settleUncertain(record, begun.code);
  }

  let summary = null;
  let errorCode = null;

  if (begun.mode === 'reuse') {
    // 同键已有 succeeded：上次崩在「已执行、未落盘」，这里收敛为已执行。
    summary = begun.result || null;
  } else {
    // ② begin 之后才把任务放回 running；崩在中间时任务仍停在 waiting_approval，
    //    恢复按账本结论收敛，不会出现「任务在跑、审批却不知道执行没执行」。
    if (record.taskId) {
      const linked = tasks.getRawTask(record.taskId);
      if (linked && linked.status === 'waiting_approval') {
        tasks.transitionTask(record.taskId, { to: 'running' });
      }
    }

    let result;
    let thrown = null;
    try {
      // 归属校验：审批执行器按服务端可信用户身份操作，不能越界改他人记忆。
      result = await memoryService.execute(record.operation, record.payload, {
        userId: getInstanceUserId(),
      });
      if (!result || result.reason !== 'ok') {
        errorCode = (result && result.reason) || 'memory_operation_failed';
      }
    } catch (error) {
      thrown = error;
    }

    if (thrown) {
      // 抛异常 ≠ 确定没执行：可能已经写了一半。按 unknown 收口，等人工核对。
      guard.after({
        opKey: keyed.opKey,
        status: 'unknown',
        errorCode: (thrown && thrown.code) || 'memory_operation_interrupted',
      });
      return settleUncertain(record, 'side_effect_unknown');
    }

    summary = memoryService.summarize(record.operation, result);
    guard.after({
      opKey: keyed.opKey,
      status: errorCode ? 'failed' : 'succeeded',
      result: summary,
      errorCode,
    });
  }

  const now = nowIso();
  if (errorCode) {
    record.status = 'failed';
    record.errorCode = errorCode;
    record.result = summary;
  } else {
    record.status = 'completed';
    record.errorCode = null;
    record.result = summary;
  }
  record.executedAt = now;
  save();

  if (record.taskId) {
    if (errorCode) failApprovalTask(record, errorCode, now);
    else completeApprovalTask(record, summary, now);
  }

  recordEvent(
    record.botId,
    'approval.resolved',
    {
      status: record.status,
      decision: record.status,
      taskType: record.operation,
      ...(record.errorCode ? { errorCode: record.errorCode } : {}),
      mode: 'approval',
    },
    { approvalId: record.approvalId, taskId: record.taskId, sessionId: record.sessionId }
  );
  return publicApproval(record);
}

/**
 * 单条 executing 记录按账本收敛。返回 'executed' | 'failed' | 'absent' | 'uncertain'。
 *
 * 纪律：unknown 绝不一律标 failed。账本说「可能已执行」就进 recovery 待核对；
 * 账本说「已成功」就收敛为已执行；只有账本**明确没有这一行**才判失败。
 */
function reconcileExecuting(record, at) {
  // P3 起 executing 与 opKey 同一笔落盘；没有 opKey 的是旧版本残留，
  // 旧版本执行前不写账本，账本里查不到并不能证明「没执行过」——按不确定处理。
  if (!record.opKey) {
    return { branch: 'uncertain', code: 'side_effect_unknown' };
  }

  let entry = null;
  try {
    entry = opLedger.get(record.opKey);
  } catch (_) {
    // 账本读不出来就无法确认，不能判失败。
    return { branch: 'uncertain', code: 'side_effect_ledger_unavailable' };
  }

  if (entry && entry.status === 'succeeded') {
    record.status = 'completed';
    record.errorCode = null;
    record.result = entry.result || null;
    record.executedAt = at;
    recordEvent(
      record.botId,
      'approval.resolved',
      {
        status: 'completed',
        decision: 'recovered_completed',
        taskType: record.operation,
        mode: 'approval',
      },
      { approvalId: record.approvalId, taskId: record.taskId, sessionId: record.sessionId }
    );
    completeApprovalTask(record, entry.result, at);
    return { branch: 'executed' };
  }

  if (entry && (entry.status === 'started' || entry.status === 'unknown')) {
    if (entry.status === 'started') {
      try {
        opLedger.markUnknown(record.opKey, { errorCode: 'recovery_side_effect_unknown' });
      } catch (_) {
        // 标 unknown 失败不影响结论：不清账就不重用。
      }
    }
    return { branch: 'uncertain', code: 'side_effect_unknown' };
  }

  const errorCode =
    entry && entry.status === 'failed'
      ? entry.errorCode || 'approval_interrupted'
      : 'approval_interrupted';

  record.status = 'failed';
  record.errorCode = errorCode;
  record.executedAt = at;
  record.result = null;
  recordEvent(
    record.botId,
    'approval.resolved',
    { status: 'failed', decision: 'failed', errorCode, mode: 'approval' },
    { approvalId: record.approvalId, taskId: record.taskId, sessionId: record.sessionId }
  );
  failApprovalTask(record, errorCode, at);
  return { branch: entry ? 'failed' : 'absent' };
}

/**
 * 重启恢复。除了 executing 记录，还要对账两处中间态：
 *  - pending 记录 + 任务没进 waiting_approval（W5 新顺序下崩在两步之间）→ 推回 waiting_approval；
 *  - 任务停在 waiting_approval 却没有任何未终结审批记录 → recovery（approval_record_missing），
 *    避免旧顺序留下的永久悬空。
 */
function recoverInterrupted() {
  const current = load();
  const at = nowIso();
  const result = { recovered: 0, executed: 0, uncertain: 0, reconciled: 0, dangling: 0 };
  let changed = false;

  for (const record of Object.values(current.approvals)) {
    if (record.status === 'executing') {
      changed = true;
      result.recovered += 1;
      const outcome = reconcileExecuting(record, at);
      if (outcome.branch === 'executed') result.executed += 1;
      if (outcome.branch === 'uncertain') {
        result.uncertain += 1;
        settleUncertain(record, outcome.code);
      }
      continue;
    }

    if (record.status === 'pending' && record.taskId) {
      // §29 已取消请求不再推回 waiting_approval（它本就不该继续等待）。
      if (requestStatusOf(record) === 'cancelled') continue;
      const task = tasks.getRawTask(record.taskId);
      if (task && !tasks.isTerminalStatus(task.status) && task.status !== 'waiting_approval') {
        try {
          moveTaskToApproval(task);
          result.reconciled += 1;
          changed = true;
        } catch (error) {
          // 对账失败不静默吞掉，但也不能让启动恢复整体失败。
          console.warn(
            `[agent-approval] pending reconcile failed approval=${record.approvalId} code=${
              (error && error.code) || 'invalid_transition'
            }`
          );
        }
      }
    }
  }

  const covered = new Set();
  for (const record of Object.values(current.approvals)) {
    // 已取消的请求不覆盖任务：避免取消时任务迁移失败被永久掩盖。
    if (
      record.taskId &&
      !TERMINAL.has(record.status) &&
      requestStatusOf(record) !== 'cancelled'
    ) {
      covered.add(record.taskId);
    }
  }
  for (const task of tasks.allTasks()) {
    if (task.status !== 'waiting_approval' || covered.has(task.taskId)) continue;
    const recoveryResult = normalizeWorkerResult({
      status: 'recovery',
      summary: '',
      errorCode: 'approval_record_missing',
      runId: task.runId || null,
      finishedAt: at,
    });
    try {
      tasks.transitionTask(task.taskId, {
        to: 'recovery',
        completedAt: at,
        errorCode: 'approval_record_missing',
        result: recoveryResult,
      });
      deliverTaskResult(task.taskId, {
        status: 'recovery',
        result: recoveryResult,
        errorCode: 'approval_record_missing',
      });
      result.dangling += 1;
      changed = true;
    } catch (_) {
      // 任务状态竞争不影响审批恢复。
    }
  }

  // ④ 重启后同样要补齐 R2 的 overdue 标记；R3 不会被“超时处理”。
  const deadlines = expireDueApprovals();
  if (changed) save();
  return {
    ...result,
    escalated: deadlines.escalated.length,
    overdue: deadlines.overdue.length,
  };
}

function reloadForTests() {
  for (const approvalId of [...deadlineTimers.keys()]) disarmDeadline(approvalId);
  cache = null;
}

module.exports = {
  APPROVALS_FILE,
  STATUSES,
  REQUEST_STATUSES,
  REQUEST_TRANSITIONS,
  APPROVAL_STATES,
  APPROVAL_SLA_POLICY_VERSION,
  APPROVAL_BATCH_POLICY_VERSION,
  APPROVAL_BATCH_MAX,
  APPROVAL_APPEAL_POLICY_VERSION,
  APPEAL_WINDOW_MS,
  APPEAL_MAX_TIMES,
  MAX_NOTIFICATION_ATTEMPTS,
  R2_SLA_MS,
  R2_ESCALATION_RATIO,
  createApproval,
  listApprovals,
  getApproval,
  getRawApproval,
  pendingCount,
  approve,
  reject,
  execute,
  expireDueApprovals,
  markOverdue,
  remindApproval,
  escalateApproval,
  cancelApproval,
  batchDecide,
  appealApproval,
  resolveAppeal,
  setAssigneeRotaForTests,
  APPROVAL_ASSIGNEE_POLICY_VERSION,
  approvalQueueDistribution,
  requestStatusOf,
  mergedStateOf,
  slaViewOf,
  assertRequestStatusTransition,
  transitionRequestStatus,
  recordNotificationOutcome,
  approvalPolicyState,
  recoverInterrupted,
  reloadForTests,
  GATE_OPERATIONS,
};
