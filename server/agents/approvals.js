/* global module, __dirname */
/**
 * Memory Bot 人工审批闭环：
 * pending → approved / rejected → executing → completed / failed。
 *
 * 审批记录保存在独立文件；事件只写安全字段。执行只能由已批准记录触发，
 * 且执行器只能调用 memory-service.js 的稳定维护接口。
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

// A 类：R2 审批 SLA 初始默认硬阈值 30 分钟（v1.3 §36.2，用户 2026-11-03 裁决）。
// 到期只转人工（overdue 标记 + 升级事件 + 保持 pending），绝不解释为批准，也不改写 Task。
// 调整必须按 §31.2 留版本记录，不得静默调参。
const R2_SLA_MS = 30 * 60 * 1000;
// A 类：§32.3 建议 escalationAt 由 SLA 派生（取 50%），待实测校准并留痕。
const R2_ESCALATION_RATIO = 0.5;
// 风险等级映射：medium → R2（人工审批 + 30 分钟 SLA）；high → R3（无自动批准超时）。
// 未知风险一律按 R3 处理（fail-closed，不降级）。
const RISK_LEVEL_BY_RISK = Object.freeze({ medium: 'R2', high: 'R3' });
const APPROVAL_POLICY_FIELDS = Object.freeze([
  'riskLevel',
  'expiresAt',
  'escalationAt',
  'policyVersion',
]);

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
    overdue: record.overdue === true,
    overdueAt: record.overdueAt || null,
    escalatedAt: record.escalatedAt || null,
    status: record.status,
    requestedBy: record.requestedBy,
    requestedAt: record.requestedAt,
    decidedBy: record.decidedBy || null,
    decidedAt: record.decidedAt || null,
    executedBy: record.executedBy || null,
    executedAt: record.executedAt || null,
    reason: record.reason || null,
    errorCode: record.errorCode || null,
    result: record.result ? clone(record.result) : null,
  };
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
  return Object.values(load().approvals).filter(item => item.status === 'pending').length;
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
  save();
  for (const eventType of events) {
    recordEvent(
      record.botId,
      eventType,
      {
        status: 'pending',
        taskType: record.operation,
        mode: 'approval',
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

function createApproval({
  botId,
  operation,
  payload,
  taskId = null,
  sessionId = null,
  requestedBy = 'agent',
} = {}) {
  assertBot(botId);
  const checked = memoryService.validate(operation, payload);
  if (!checked.ok) {
    throw new AgentError('invalid_approval', `审批参数无效：${checked.error}`);
  }
  const profile = permissions.getPermissionProfile(botId);
  if (!profile.allowedOperations.includes(operation)) {
    throw new AgentError('operation_not_allowed', '该操作不在当前 Bot 权限范围');
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
  const risk = memoryService.RISK[operation] || 'high';
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
    requestedBy:
      requestedBy === 'user' || requestedBy === 'agent' ? requestedBy : 'agent',
    requestedAt: now,
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
    },
    { approvalId: record.approvalId, taskId: requestTaskId, sessionId: requestSessionId }
  );
  return publicApproval(record);
}

function decide(approvalId, decision, { actor = permissions.SINGLE_USER_ACTOR, reason = null } = {}) {
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

  const now = nowIso();
  record.status = decision === 'approve' ? 'approved' : 'rejected';
  record.decidedBy = String(actor || permissions.SINGLE_USER_ACTOR).slice(0, 80);
  record.decidedAt = now;
  record.reason = typeof reason === 'string' ? reason.slice(0, 200) : null;
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

async function execute(approvalId, { actor = permissions.SINGLE_USER_ACTOR } = {}) {
  const current = load();
  const record = current.approvals[String(approvalId || '')];
  if (!record) throw new AgentError('approval_not_found', '审批不存在', 404);
  if (record.status !== 'approved') {
    throw new AgentError('approval_not_approved', '审批尚未批准，不能执行', 409);
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

  const permission = permissions.checkOperation({
    botId: record.botId,
    operation: record.operation,
    approved: true,
  });
  if (!permission.ok) {
    throw new AgentError('operation_not_allowed', '当前权限不允许执行该操作', 403);
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
    if (record.taskId && !TERMINAL.has(record.status)) covered.add(record.taskId);
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
  R2_SLA_MS,
  R2_ESCALATION_RATIO,
  createApproval,
  listApprovals,
  getApproval,
  getRawApproval,
  approve,
  reject,
  execute,
  expireDueApprovals,
  markOverdue,
  approvalPolicyState,
  recoverInterrupted,
  reloadForTests,
};
