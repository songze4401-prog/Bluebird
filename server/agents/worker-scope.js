/* global module */
/**
 * Worker Session 隔离边界（Phase 1 验收：Worker Session 隔离）。
 *
 * 每个 Worker 执行上下文以自己的 (botId, taskId, sessionId) 为作用域，
 * 只能读自己的会话历史与自己的产物；跨 Worker 读取默认拒绝，
 * 显式授权（{grantedBy, reason}）才放行，拒绝与放行都写审计事件。
 *
 * 边界与复用说明（不要过度解读）：
 * - 归属判定直接复用 sessions.attachOwner / assertWorkerSession；
 *   本模块不改 deriveLifecycleStatus、closeSession 的投影/校验语义，也不新增
 *   sessions.js 字段——隔离靠的是"读路径统一走本边界"，不是改存储格式。
 * - 拒绝沿用既有错误码：会话归属冲突 worker_session_owner_mismatch(409)、
 *   产物不可读 artifact_not_found(409)，不新造错误码族。
 * - 审计复用 tasks.appendEvent（worker.scope_read / worker.scope_denied），
 *   不新建第二套审计存储。
 * - 未覆盖：跨进程隔离、真并发下的隔离验证（同一进程内数据仍落在同一批文件上）。
 */
const sessions = require('./sessions');
const tasks = require('./tasks');
const artifactStore = require('./artifact-store');
const { AgentError } = require('./errors');

const OWNER_MISMATCH = 'worker_session_owner_mismatch';
const TARGET_ID_MAX = 120;

function truncate(value) {
  return String(value || '').slice(0, TARGET_ID_MAX);
}

// 显式授权必须有可追溯的授权人与理由；缺一按"未授权"处理（fail-closed）。
function isGranted(authorization) {
  return Boolean(
    authorization &&
      typeof authorization === 'object' &&
      typeof authorization.grantedBy === 'string' &&
      authorization.grantedBy.trim() &&
      typeof authorization.reason === 'string' &&
      authorization.reason.trim()
  );
}

function auditRead(botId, taskId, sessionId, runId, eventType, payload) {
  tasks.appendEvent({
    botId,
    taskId,
    runId,
    sessionId,
    eventType,
    payload,
    correlationId: taskId,
  });
}

function denyRead({
  botId,
  taskId,
  sessionId,
  runId,
  targetType,
  targetId,
  reason,
}) {
  auditRead(botId, taskId, sessionId, runId, 'worker.scope_denied', {
    targetType,
    targetId: truncate(targetId),
    requesterTaskId: taskId,
    access: 'denied',
    reason,
    errorCode: OWNER_MISMATCH,
  });
  throw new AgentError(
    OWNER_MISMATCH,
    '目标属于其他 Worker 作用域，读取被拒绝',
    409,
    { targetType, targetId: truncate(targetId), requesterTaskId: taskId }
  );
}

/**
 * 打开一个 Worker 作用域：校验会话存在、归属可接管后绑定 owner。
 * 与 runtime 既有路径保持一致：owner 已属于其他任务时抛
 * worker_session_owner_mismatch，只有调用方显式 allowTakeover 才接管。
 */
function openWorkerScope({
  botId,
  taskId,
  sessionId,
  runId = null,
  allowTakeover = false,
} = {}) {
  const boundTaskId = truncate(taskId);
  const boundSessionId = truncate(sessionId);
  if (!boundTaskId || !boundSessionId) {
    throw new AgentError('worker_session_missing', 'Worker 会话不存在', 409);
  }
  if (!sessions.getSession(botId, boundSessionId)) {
    throw new AgentError('worker_session_missing', 'Worker 会话不存在', 409);
  }
  const session = sessions.attachOwner(botId, boundSessionId, {
    agentId: botId,
    taskId: boundTaskId,
    runId,
    allowTakeover,
  });
  if (!session.owner || session.owner.taskId !== boundTaskId) {
    throw new AgentError(OWNER_MISMATCH, 'Worker 会话归属校验失败', 409, {
      taskId: boundTaskId,
      sessionId: boundSessionId,
    });
  }

  function assertOwn() {
    sessions.assertWorkerSession(botId, boundSessionId, boundTaskId);
  }

  function readOwnMessages() {
    assertOwn();
    return sessions.getMessages(botId, boundSessionId);
  }

  function listOwnArtifacts() {
    assertOwn();
    return artifactStore.all().filter(item => item && item.taskId === boundTaskId);
  }

  function readOwnArtifact(id) {
    assertOwn();
    const artifactId = truncate(id);
    const artifact = artifactStore.get(artifactId);
    if (!artifact) {
      throw new AgentError('artifact_not_found', '产物不可读', 409, {
        artifactId,
      });
    }
    if (artifact.taskId !== boundTaskId) {
      denyRead({
        botId,
        taskId: boundTaskId,
        sessionId: boundSessionId,
        runId,
        targetType: 'artifact',
        targetId: artifactId,
        reason: 'artifact_out_of_scope',
      });
    }
    return artifactStore.readContent(artifactId);
  }

  function readOtherMessages(targetSessionId, { authorization } = {}) {
    const targetId = truncate(targetSessionId);
    if (!targetId) {
      throw new AgentError('worker_session_missing', 'Worker 会话不存在', 409);
    }
    if (targetId === boundSessionId) return readOwnMessages();
    assertOwn();
    if (!sessions.getSession(botId, targetId)) {
      throw new AgentError('worker_session_missing', 'Worker 会话不存在', 409);
    }
    if (!isGranted(authorization)) {
      denyRead({
        botId,
        taskId: boundTaskId,
        sessionId: boundSessionId,
        runId,
        targetType: 'session',
        targetId,
        reason: 'no_authorization',
      });
    }
    auditRead(botId, boundTaskId, boundSessionId, runId, 'worker.scope_read', {
      targetType: 'session',
      targetId,
      requesterTaskId: boundTaskId,
      access: 'granted',
      grantedBy: authorization.grantedBy,
      reason: authorization.reason,
    });
    return sessions.getMessages(botId, targetId);
  }

  function readOtherArtifact(id, { authorization } = {}) {
    assertOwn();
    const artifactId = truncate(id);
    const artifact = artifactStore.get(artifactId);
    if (!artifact) {
      throw new AgentError('artifact_not_found', '产物不可读', 409, {
        artifactId,
      });
    }
    if (artifact.taskId === boundTaskId) return artifactStore.readContent(artifactId);
    if (!isGranted(authorization)) {
      denyRead({
        botId,
        taskId: boundTaskId,
        sessionId: boundSessionId,
        runId,
        targetType: 'artifact',
        targetId: artifactId,
        reason: 'no_authorization',
      });
    }
    auditRead(botId, boundTaskId, boundSessionId, runId, 'worker.scope_read', {
      targetType: 'artifact',
      targetId: artifactId,
      requesterTaskId: boundTaskId,
      access: 'granted',
      grantedBy: authorization.grantedBy,
      reason: authorization.reason,
    });
    return artifactStore.readContent(artifactId);
  }

  return {
    botId,
    taskId: boundTaskId,
    sessionId: boundSessionId,
    runId,
    readOwnMessages,
    listOwnArtifacts,
    readOwnArtifact,
    readOtherMessages,
    readOtherArtifact,
  };
}

module.exports = {
  openWorkerScope,
};
