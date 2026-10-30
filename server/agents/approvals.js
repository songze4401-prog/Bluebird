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
const { isKnownBot } = require('./manifest');
const { AgentError } = require('./errors');

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

let cache = null;

function nowIso() {
  return new Date().toISOString();
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
  const record = {
    approvalId: `appr_${crypto.randomUUID()}`,
    botId,
    taskId: requestTaskId,
    sessionId: requestSessionId,
    operation,
    payload: checked.value,
    risk: memoryService.RISK[operation] || 'high',
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
  current.approvals[record.approvalId] = record;
  save();

  if (requestTaskId) {
    const task = tasks.getRawTask(requestTaskId);
    if (task && !tasks.isTerminalStatus(task.status) && task.status !== 'waiting_approval') {
      try {
        tasks.updateTask(requestTaskId, { status: 'waiting_approval' });
      } catch (_) {
        // 任务状态竞争不影响审批记录本身。
      }
    }
  }

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
  save();

  if (decision === 'reject' && record.taskId) {
    const task = tasks.getRawTask(record.taskId);
    if (task && !tasks.isTerminalStatus(task.status)) {
      try {
        tasks.updateTask(record.taskId, {
          status: 'cancelled',
          completedAt: now,
          errorCode: 'approval_rejected',
        });
      } catch (_) {
        // 任务状态竞争不影响审批结果。
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

  const permission = permissions.checkOperation({
    botId: record.botId,
    operation: record.operation,
    approved: true,
  });
  if (!permission.ok) {
    throw new AgentError('operation_not_allowed', '当前权限不允许执行该操作', 403);
  }

  record.status = 'executing';
  record.executedBy = String(actor || permissions.SINGLE_USER_ACTOR).slice(0, 80);
  record.executedAt = nowIso();
  save();

  let result;
  let errorCode = null;
  try {
    result = await memoryService.execute(record.operation, record.payload);
    if (!result || result.reason !== 'ok') {
      errorCode = (result && result.reason) || 'memory_operation_failed';
    }
  } catch (error) {
    errorCode = (error && error.code) || 'memory_operation_failed';
  }

  const now = nowIso();
  const summary = memoryService.summarize(record.operation, result);
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
    const task = tasks.getRawTask(record.taskId);
    if (task && !tasks.isTerminalStatus(task.status)) {
      try {
        if (record.status === 'completed') {
          tasks.updateTask(record.taskId, {
            status: 'completed',
            completedAt: now,
            result: {
              summary: `已执行审批操作：${record.operation}`,
              toolSteps: [],
              evidence: Array.isArray(summary.supersededIds)
                ? summary.supersededIds.map(id => ({ kind: 'memory', id }))
                : summary.id
                  ? [{ kind: 'memory', id: summary.id }]
                  : [],
              changes: summary.id
                ? [{ kind: 'memory', id: summary.id, decision: record.operation }]
                : [],
              requiresConfirmation: false,
              rounds: 0,
              stopReason: null,
              model: null,
            },
          });
        } else {
          tasks.updateTask(record.taskId, {
            status: 'failed',
            completedAt: now,
            errorCode: record.errorCode,
          });
        }
      } catch (_) {
        // 任务状态竞争不影响审批执行结果。
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
      ...(record.errorCode ? { errorCode: record.errorCode } : {}),
      mode: 'approval',
    },
    { approvalId: record.approvalId, taskId: record.taskId, sessionId: record.sessionId }
  );
  return publicApproval(record);
}

function recoverInterrupted() {
  const current = load();
  let recovered = 0;
  for (const record of Object.values(current.approvals)) {
    if (record.status === 'executing') {
      record.status = 'failed';
      record.errorCode = 'interrupted';
      record.executedAt = nowIso();
      record.result = null;
      recovered += 1;
      recordEvent(
        record.botId,
        'approval.resolved',
        { status: 'failed', decision: 'failed', errorCode: 'interrupted', mode: 'approval' },
        { approvalId: record.approvalId, taskId: record.taskId, sessionId: record.sessionId }
      );
      if (record.taskId) {
        const task = tasks.getRawTask(record.taskId);
        if (task && !tasks.isTerminalStatus(task.status)) {
          try {
            tasks.updateTask(record.taskId, {
              status: 'failed',
              completedAt: nowIso(),
              errorCode: 'approval_interrupted',
            });
          } catch (_) {
            // 任务状态竞争不影响审批恢复。
          }
        }
      }
    }
  }
  if (recovered) save();
  return { recovered };
}

function reloadForTests() {
  cache = null;
}

module.exports = {
  APPROVALS_FILE,
  STATUSES,
  createApproval,
  listApprovals,
  getApproval,
  getRawApproval,
  approve,
  reject,
  execute,
  recoverInterrupted,
  reloadForTests,
};
