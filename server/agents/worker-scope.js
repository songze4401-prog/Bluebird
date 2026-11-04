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

/**
 * HTTP 读端点的作用域校验（只读，不绑定 owner、不修改会话）。
 * - direct 会话不参与 Worker 隔离，保持既有可见性（旧调用零回归）；
 * - worker 会话：owner.taskId === requesterTaskId 放行（本任务读自己）；
 * - 其余一律默认拒绝（worker_session_owner_mismatch 409），
 *   显式 {grantedBy, reason} 授权才放行；拒绝与放行都写 worker.scope_* 审计。
 *
 * 边界说明：requesterTaskId 是调用方自报的上下文标识（当前单用户 local-owner
 * 模型没有可验证的调用者身份），因此这里挡的是"误读/越界读"，不是抗恶意伪造。
 */
function authorizeSessionRead({
  botId,
  sessionId,
  requesterTaskId = null,
  authorization = null,
} = {}) {
  const targetId = truncate(sessionId);
  const session = sessions.getSession(botId, targetId);
  if (!session) {
    throw new AgentError('agent_session_not_found', 'Bot 会话不存在', 404);
  }
  if (!session.owner) return session;
  const requester = truncate(requesterTaskId) || null;
  if (requester && session.owner.taskId === requester) return session;
  if (!isGranted(authorization)) {
    auditRead(botId, requester, targetId, null, 'worker.scope_denied', {
      targetType: 'session',
      targetId,
      requesterTaskId: requester,
      access: 'denied',
      reason: 'no_authorization',
      errorCode: OWNER_MISMATCH,
    });
    throw new AgentError(
      OWNER_MISMATCH,
      'Worker 会话属于其他任务，读取被拒绝',
      409,
      { targetType: 'session', targetId, requesterTaskId: requester }
    );
  }
  auditRead(botId, requester, targetId, null, 'worker.scope_read', {
    targetType: 'session',
    targetId,
    requesterTaskId: requester,
    access: 'granted',
    grantedBy: authorization.grantedBy,
    reason: authorization.reason,
  });
  return session;
}

module.exports = {
  openWorkerScope,
  authorizeSessionRead,
};
