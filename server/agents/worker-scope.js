/* global module, require */
/**
 * Worker Session 隔离边界（Phase 1 验收：Worker Session 隔离）。
 *
 * 每个 Worker 执行上下文以自己的 (botId, taskId, sessionId) 为作用域，
 * 只能读自己的会话历史与自己的产物；跨 Worker 读取默认拒绝。
 *
 * 身份令牌（本轮补齐的最小授权）：
 * - 作用域打开时由**服务端**签发不可伪造的 `wst_` 令牌（随机 24 字节 + 服务端哈希映射）；
 * - 令牌显式声明允许读取的 target（allowedTaskIds / allowedSessionIds），
 *   并带过期时间；`revokeScopeToken` 吊销后立即失效；
 * - 跨作用域读取只认令牌，不再以调用方自报的 requesterTaskId / grantedBy 为依据；
 * - 令牌缺失/伪造/过期/吊销 → 401 `worker_scope_token_invalid`，
 *   有效令牌但 target 越界 → 409 `worker_session_owner_mismatch`；
 *   两种情况都写 `worker.scope_denied` 审计，且错误响应不回显对方内容。
 *
 * 边界与复用说明（不要过度解读）：
 * - 归属判定直接复用 sessions.attachOwner / assertWorkerSession；
 *   本模块不改 deriveLifecycleStatus、closeSession 的投影/校验语义，也不新增
 *   sessions.js 字段——隔离靠的是"读路径统一走本边界"，不是改存储格式。
 * - 拒绝沿用既有错误码；只新增一个令牌无效码，不新造错误码族。
 * - 审计复用 tasks.appendEvent（worker.scope_read / worker.scope_denied），
 *   不新建第二套审计存储；审计里不落令牌原文。
 * - 未覆盖：跨进程隔离（超出 Notion Phase 1 范围，需跨进程锁）。
 */
const crypto = require('crypto');
const sessions = require('./sessions');
const tasks = require('./tasks');
const artifactStore = require('./artifact-store');
const { AgentError } = require('./errors');

const OWNER_MISMATCH = 'worker_session_owner_mismatch';
const SCOPE_TOKEN_INVALID = 'worker_scope_token_invalid';
const TOKEN_PREFIX = 'wst_';
const DEFAULT_TOKEN_TTL_MS = 60 * 60 * 1000;
const TARGET_ID_MAX = 120;

// 服务端令牌映射：key 是令牌的 sha256，record 不含令牌原文。
const scopeTokens = new Map();

function truncate(value) {
  return String(value || '').slice(0, TARGET_ID_MAX);
}

function tokenDigest(token) {
  return crypto.createHash('sha256').update(String(token)).digest('hex');
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

/**
 * 服务端签发作用域令牌（不可猜随机值 + 服务端映射）。
 * 令牌只能表达"允许读哪些 target"，不承载用户体系或多用户模型。
 */
function issueScopeToken({
  botId,
  taskId,
  sessionId,
  runId = null,
  allowedTaskIds = [],
  allowedSessionIds = [],
  ttlMs = DEFAULT_TOKEN_TTL_MS,
  grantedBy = null,
  reason = null,
} = {}) {
  const boundBotId = truncate(botId);
  const boundTaskId = truncate(taskId);
  const boundSessionId = truncate(sessionId);
  if (!boundBotId || !boundTaskId || !boundSessionId) {
    throw new AgentError('worker_session_missing', 'Worker 会话不存在', 409);
  }
  const ttl = Number(ttlMs);
  const effectiveTtl = Number.isFinite(ttl) && ttl > 0 ? ttl : DEFAULT_TOKEN_TTL_MS;
  const allowedTasks = [
    ...new Set([boundTaskId, ...(Array.isArray(allowedTaskIds) ? allowedTaskIds : [])].map(truncate).filter(Boolean)),
  ];
  const allowedSessions = [
    ...new Set(
      [boundSessionId, ...(Array.isArray(allowedSessionIds) ? allowedSessionIds : [])]
        .map(truncate)
        .filter(Boolean)
    ),
  ];
  const token = `${TOKEN_PREFIX}${crypto.randomBytes(24).toString('base64url')}`;
  scopeTokens.set(tokenDigest(token), {
    botId: boundBotId,
    taskId: boundTaskId,
    sessionId: boundSessionId,
    runId: runId ? truncate(runId) : null,
    allowedTaskIds: allowedTasks,
    allowedSessionIds: allowedSessions,
    issuedAt: Date.now(),
    expiresAt: Date.now() + effectiveTtl,
    revokedAt: null,
    grantedBy: String(grantedBy || 'worker-scope').slice(0, 120),
    reason: String(reason || 'scope_binding').slice(0, 200),
  });
  return token;
}

/** 吊销令牌：立即失效（保留记录用于区分 revoked 原因）。 */
function revokeScopeToken(token) {
  const raw = typeof token === 'string' ? token.trim() : '';
  if (!raw) return false;
  const record = scopeTokens.get(tokenDigest(raw));
  if (!record) return false;
  if (!record.revokedAt) record.revokedAt = Date.now();
  return true;
}

function resolveScopeToken(token, { botId = null, now = Date.now() } = {}) {
  const raw = typeof token === 'string' ? token.trim() : '';
  if (!raw) return { ok: false, state: 'token_missing', record: null };
  if (!raw.startsWith(TOKEN_PREFIX)) return { ok: false, state: 'token_forged', record: null };
  const record = scopeTokens.get(tokenDigest(raw));
  if (!record) return { ok: false, state: 'token_forged', record: null };
  if (botId && record.botId !== truncate(botId)) {
    return { ok: false, state: 'token_bot_mismatch', record };
  }
  if (record.revokedAt) return { ok: false, state: 'token_revoked', record };
  if (now >= record.expiresAt) return { ok: false, state: 'token_expired', record };
  return { ok: true, state: 'valid', record };
}

// 令牌只允许读显式声明的 target：会话按 sessionId / owner.taskId，
// 产物按所属 taskId。
function recordAllows(record, { targetType, targetId, ownerTaskId = null }) {
  if (targetType === 'session') {
    return (
      record.sessionId === targetId ||
      record.allowedSessionIds.includes(targetId) ||
      Boolean(ownerTaskId && record.allowedTaskIds.includes(ownerTaskId))
    );
  }
  return Boolean(ownerTaskId && record.allowedTaskIds.includes(ownerTaskId));
}

function denyToken({
  botId,
  taskId,
  sessionId,
  runId,
  targetType,
  targetId,
  state,
}) {
  auditRead(botId, taskId, sessionId, runId, 'worker.scope_denied', {
    targetType,
    targetId: truncate(targetId),
    requesterTaskId: taskId ? truncate(taskId) : null,
    access: 'denied',
    reason: state,
    errorCode: SCOPE_TOKEN_INVALID,
  });
  throw new AgentError(SCOPE_TOKEN_INVALID, 'Worker 作用域令牌无效', 401, {
    targetType,
    targetId: truncate(targetId),
  });
}

function denyTarget({
  botId,
  taskId,
  sessionId,
  runId,
  targetType,
  targetId,
}) {
  auditRead(botId, taskId, sessionId, runId, 'worker.scope_denied', {
    targetType,
    targetId: truncate(targetId),
    requesterTaskId: taskId ? truncate(taskId) : null,
    access: 'denied',
    reason: 'target_not_allowed',
    errorCode: OWNER_MISMATCH,
  });
  throw new AgentError(
    OWNER_MISMATCH,
    '目标属于其他 Worker 作用域，读取被拒绝',
    409,
    { targetType, targetId: truncate(targetId), requesterTaskId: taskId ? truncate(taskId) : null }
  );
}

/**
 * 打开一个 Worker 作用域：校验会话存在、归属可接管后绑定 owner，并签发令牌。
 * 与 runtime 既有路径保持一致：owner 已属于其他任务时抛
 * worker_session_owner_mismatch，只有调用方显式 allowTakeover 才接管。
 */
function openWorkerScope({
  botId,
  taskId,
  sessionId,
  runId = null,
  allowTakeover = false,
  allowedTaskIds = [],
  allowedSessionIds = [],
  tokenTtlMs = DEFAULT_TOKEN_TTL_MS,
  grantedBy = null,
  reason = null,
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

  const token = issueScopeToken({
    botId,
    taskId: boundTaskId,
    sessionId: boundSessionId,
    runId,
    allowedTaskIds,
    allowedSessionIds,
    ttlMs: tokenTtlMs,
    grantedBy,
    reason,
  });

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

  // 跨作用域统一走令牌：令牌必须属于当前作用域，且显式允许该 target。
  function authorizeCross(targetType, targetId, ownerTaskId, providedToken) {
    const resolved = resolveScopeToken(providedToken);
    if (resolved.ok) {
      const record = resolved.record;
      if (
        record.botId !== truncate(botId) ||
        record.taskId !== boundTaskId ||
        record.sessionId !== boundSessionId
      ) {
        denyToken({
          botId,
          taskId: boundTaskId,
          sessionId: boundSessionId,
          runId,
          targetType,
          targetId,
          state: 'token_wrong_scope',
        });
      }
      if (!recordAllows(record, { targetType, targetId, ownerTaskId })) {
        denyTarget({
          botId,
          taskId: boundTaskId,
          sessionId: boundSessionId,
          runId,
          targetType,
          targetId,
        });
      }
      auditRead(botId, boundTaskId, boundSessionId, runId, 'worker.scope_read', {
        targetType,
        targetId: truncate(targetId),
        requesterTaskId: boundTaskId,
        access: 'granted',
        grantedBy: record.grantedBy,
        reason: record.reason,
      });
      return;
    }
    denyToken({
      botId,
      taskId: boundTaskId,
      sessionId: boundSessionId,
      runId,
      targetType,
      targetId,
      state: resolved.state,
    });
  }

  function readOwnArtifact(id, { token } = {}) {
    assertOwn();
    const artifactId = truncate(id);
    const artifact = artifactStore.get(artifactId);
    if (!artifact) {
      throw new AgentError('artifact_not_found', '产物不可读', 409, {
        artifactId,
      });
    }
    if (artifact.taskId === boundTaskId) return artifactStore.readContent(artifactId);
    authorizeCross('artifact', artifactId, artifact.taskId, token);
    return artifactStore.readContent(artifactId);
  }

  function readOtherMessages(targetSessionId, { token } = {}) {
    const targetId = truncate(targetSessionId);
    if (!targetId) {
      throw new AgentError('worker_session_missing', 'Worker 会话不存在', 409);
    }
    if (targetId === boundSessionId) return readOwnMessages();
    assertOwn();
    const targetSession = sessions.getSession(botId, targetId);
    if (!targetSession) {
      throw new AgentError('worker_session_missing', 'Worker 会话不存在', 409);
    }
    authorizeCross(
      'session',
      targetId,
      targetSession.owner ? targetSession.owner.taskId : null,
      token
    );
    return sessions.getMessages(botId, targetId);
  }

  function readOtherArtifact(id, { token } = {}) {
    assertOwn();
    const artifactId = truncate(id);
    const artifact = artifactStore.get(artifactId);
    if (!artifact) {
      throw new AgentError('artifact_not_found', '产物不可读', 409, {
        artifactId,
      });
    }
    if (artifact.taskId === boundTaskId) return artifactStore.readContent(artifactId);
    authorizeCross('artifact', artifactId, artifact.taskId, token);
    return artifactStore.readContent(artifactId);
  }

  return {
    botId,
    taskId: boundTaskId,
    sessionId: boundSessionId,
    runId,
    token,
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
 * - worker 会话只认服务端签发的令牌：令牌有效且允许该 target 才放行；
 *   缺失/伪造/过期/吊销 → 401，越界 → 409，均写 worker.scope_* 审计。
 *
 * 边界说明：令牌不可猜且由服务端保存映射，调用方无法自报身份伪造放行。
 */
function authorizeSessionRead({ botId, sessionId, token = null } = {}) {
  const targetId = truncate(sessionId);
  const session = sessions.getSession(botId, targetId);
  if (!session) {
    throw new AgentError('agent_session_not_found', 'Bot 会话不存在', 404);
  }
  if (!session.owner) return session;
  const resolved = resolveScopeToken(token, { botId });
  if (!resolved.ok) {
    denyToken({
      botId,
      taskId: null,
      sessionId: targetId,
      runId: null,
      targetType: 'session',
      targetId,
      state: resolved.state,
    });
  }
  const record = resolved.record;
  if (!recordAllows(record, {
    targetType: 'session',
    targetId,
    ownerTaskId: session.owner.taskId,
  })) {
    denyTarget({
      botId,
      taskId: record.taskId,
      sessionId: targetId,
      runId: null,
      targetType: 'session',
      targetId,
    });
  }
  auditRead(botId, record.taskId, targetId, null, 'worker.scope_read', {
    targetType: 'session',
    targetId,
    requesterTaskId: record.taskId,
    access: 'granted',
    grantedBy: record.grantedBy,
    reason: record.reason,
  });
  return session;
}

module.exports = {
  openWorkerScope,
  authorizeSessionRead,
  issueScopeToken,
  revokeScopeToken,
};
