/* global module, __dirname, Buffer */
/**
 * Bot 独立会话存储：与主控聊天 sessions.json 完全分离。
 *
 * 隔离键是 botId + sessionId；所有读写都要求两者同时匹配，
 * 主控 /history 与 Bot 工作台不会互相看到对方会话。
 *
 * lifecycle.status 不是第二套状态机：它是对所属 Task 状态的投影，
 * 词表（active/running/completed/failed/cancelled/timed_out/closed）只为兼容
 * 既有 API 而保留；会话收尾一律经 deriveLifecycleStatus 后再写。
 */
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { writeFileAtomicSync } = require('../atomic-write');
const { isKnownBot } = require('./manifest');
const { AgentError } = require('./errors');
const { LEGACY_ALIASES } = require('./status-vocabulary');

const DATA_DIR = process.env.BLUEBIRD_DATA_DIR
  ? path.resolve(process.env.BLUEBIRD_DATA_DIR)
  : path.join(__dirname, '..', 'data');
const AGENTS_DIR = path.join(DATA_DIR, 'agents');
const STORE_FILE = path.join(AGENTS_DIR, 'agent-sessions.json');
const STORE_VERSION = 1;
const MESSAGE_MAX = 1000;
const TITLE_MAX = 60;
const CONTENT_MAX = 12000;
const TOOL_STEPS_MAX = 12;
const SCOPES = Object.freeze(['direct', 'worker']);
const LIFECYCLE_STATES = Object.freeze([
  'active',
  'running',
  'completed',
  'failed',
  'cancelled',
  'timed_out',
  'closed',
]);

// Task 状态 → Session 生命周期投影：5 个同名值直接沿用，非终态任务投影为
// running（会话存在但任务未完成）。closeSession 只接受这张表 + closed 的产物。
const TASK_STATUS_PROJECTION = Object.freeze({
  running: 'running',
  completed: 'completed',
  failed: 'failed',
  cancelled: 'cancelled',
  timed_out: 'timed_out',
});
const PENDING_TASK_STATUSES = Object.freeze([
  'queued',
  'accepted',
  'waiting_approval',
]);
// recovery 不呈现给会话层：结果未知且需人工核对，投影为 failed（不是仍在运行）。
const RECOVERY_LIFECYCLE_STATUS = 'failed';
const PROJECTED_LIFECYCLE_STATUSES = Object.freeze([
  'running',
  'completed',
  'failed',
  'cancelled',
  'timed_out',
  'closed',
]);

function deriveLifecycleStatus(taskStatus) {
  // 旧记录/旧客户端可能仍传 uncertain；读边界先归一为 recovery 再投影。
  const normalized = LEGACY_ALIASES[taskStatus] || taskStatus;
  if (Object.prototype.hasOwnProperty.call(TASK_STATUS_PROJECTION, normalized)) {
    return TASK_STATUS_PROJECTION[normalized];
  }
  if (PENDING_TASK_STATUSES.includes(normalized)) return 'running';
  if (normalized === 'recovery') return RECOVERY_LIFECYCLE_STATUS;
  console.warn(
    '[agents] deriveLifecycleStatus 收到未知 Task 状态，会话生命周期回退 closed:',
    JSON.stringify(taskStatus)
  );
  return 'closed';
}

let cache = null;

function nowIso() {
  return new Date().toISOString();
}

function defaultLifecycle() {
  return { status: 'active', startedAt: null, closedAt: null, closeReason: null };
}

function ensureDir() {
  fs.mkdirSync(AGENTS_DIR, { recursive: true });
}

function emptyStore() {
  return { version: STORE_VERSION, sessions: [], messages: {} };
}

// 旧会话没有 owner/scope/lifecycle：读取时补齐为 direct 作用域，
// 不改变既有会话的可见性与消息语义。
function normalizeStoredSession(meta) {
  if (!meta || typeof meta !== 'object') return false;
  let changed = false;
  if (!SCOPES.includes(meta.scope)) {
    meta.scope = 'direct';
    changed = true;
  }
  if (meta.owner === undefined) {
    meta.owner = null;
    changed = true;
  }
  if (!meta.lifecycle || typeof meta.lifecycle !== 'object') {
    meta.lifecycle = defaultLifecycle();
    changed = true;
  }
  return changed;
}

function load() {
  if (cache) return cache;
  ensureDir();
  if (!fs.existsSync(STORE_FILE)) {
    cache = emptyStore();
    return cache;
  }
  let parsed;
  try {
    parsed = JSON.parse(fs.readFileSync(STORE_FILE, 'utf8'));
  } catch (_) {
    throw new AgentError('agent_sessions_corrupted', 'Bot 会话存储无法解析', 500);
  }
  if (
    !parsed ||
    parsed.version !== STORE_VERSION ||
    !Array.isArray(parsed.sessions) ||
    !parsed.messages ||
    typeof parsed.messages !== 'object' ||
    Array.isArray(parsed.messages)
  ) {
    throw new AgentError('agent_sessions_corrupted', 'Bot 会话存储结构无效', 500);
  }
  cache = parsed;
  let migrated = false;
  for (const meta of cache.sessions) {
    if (normalizeStoredSession(meta)) migrated = true;
  }
  if (migrated) {
    try {
      save();
    } catch (_) {
      // 存储暂不可写时保留内存中的规范视图。
    }
  }
  return cache;
}

function save() {
  ensureDir();
  writeFileAtomicSync(STORE_FILE, JSON.stringify(cache, null, 2));
}

function assertBot(botId) {
  if (!isKnownBot(botId)) {
    throw new AgentError('agent_not_found', 'Agent 不存在', 404);
  }
}

function clone(value) {
  return JSON.parse(JSON.stringify(value));
}

function normalizeTitle(value) {
  const text = typeof value === 'string' ? value.trim() : '';
  return text ? text.slice(0, TITLE_MAX) : '新对话';
}

function findMeta(botId, sessionId) {
  const current = load();
  return (
    current.sessions.find(
      item => item.id === sessionId && item.botId === botId
    ) || null
  );
}

function publicMeta(meta, messageCount) {
  return {
    id: meta.id,
    botId: meta.botId,
    title: meta.title,
    createdAt: meta.createdAt,
    updatedAt: meta.updatedAt,
    messageCount,
    scope: meta.scope || 'direct',
    owner: meta.owner ? clone(meta.owner) : null,
    lifecycle: meta.lifecycle ? clone(meta.lifecycle) : defaultLifecycle(),
  };
}

function listSessions(botId) {
  assertBot(botId);
  const current = load();
  return current.sessions
    .filter(item => item.botId === botId)
    .map(item => publicMeta(item, (current.messages[item.id] || []).length))
    .sort((a, b) => String(b.updatedAt).localeCompare(String(a.updatedAt)));
}

function getSession(botId, sessionId) {
  assertBot(botId);
  const meta = findMeta(botId, sessionId);
  if (!meta) return null;
  const current = load();
  return publicMeta(meta, (current.messages[meta.id] || []).length);
}

function createSession(botId, { title, scope = 'direct' } = {}) {
  assertBot(botId);
  if (!SCOPES.includes(scope)) {
    throw new AgentError('invalid_scope', 'Bot 会话作用域无效');
  }
  const current = load();
  const t = nowIso();
  const botSessions = current.sessions.filter(item => item.botId === botId);

  if (botSessions.length >= 200) {
    // 委派任务通常不需要独立的对话历史；到达硬上限时复用最早的空会话，
    // 避免长期派发把 Bot 会话撑满后再也无法创建任务。
    const reusable = botSessions.find(
      item => (current.messages[item.id] || []).length === 0
    );
    if (!reusable) {
      throw new AgentError('agent_session_limit', 'Bot 会话数量已达上限');
    }
    const previous = clone(reusable);
    reusable.title = normalizeTitle(title);
    reusable.updatedAt = t;
    reusable.scope = scope;
    reusable.owner = null;
    reusable.lifecycle = defaultLifecycle();
    try {
      save();
    } catch (error) {
      Object.assign(reusable, previous);
      throw error;
    }
    return publicMeta(reusable, 0);
  }

  const meta = {
    id: `bs_${crypto.randomUUID()}`,
    botId,
    title: normalizeTitle(title),
    createdAt: t,
    updatedAt: t,
    scope,
    owner: null,
    lifecycle: defaultLifecycle(),
  };
  current.sessions.push(meta);
  current.messages[meta.id] = [];
  try {
    save();
  } catch (error) {
    current.sessions.pop();
    delete current.messages[meta.id];
    throw error;
  }
  return publicMeta(meta, 0);
}

// Worker 会话归属：一个任务只能使用自己的 worker 会话；已归属其他任务的
// 会话拒绝复用，避免两个 Worker 读写同一份轨迹。
function attachOwner(
  botId,
  sessionId,
  { agentId, taskId, runId = null, allowTakeover = false } = {}
) {
  assertBot(botId);
  const current = load();
  const meta = findMeta(botId, sessionId);
  if (!meta) throw new AgentError('agent_session_not_found', 'Bot 会话不存在', 404);
  if (meta.owner && meta.owner.taskId !== taskId) {
    if (!allowTakeover) {
      throw new AgentError(
        'worker_session_owner_mismatch',
        'Bot 会话已归属其他任务',
        409
      );
    }
    meta.owner = null;
  }
  meta.owner = {
    agentId,
    taskId,
    runId: runId || null,
    attachedAt: meta.owner ? meta.owner.attachedAt : nowIso(),
  };
  meta.scope = 'worker';
  save();
  return publicMeta(meta, (current.messages[meta.id] || []).length);
}

function assertWorkerSession(botId, sessionId, taskId) {
  assertBot(botId);
  const meta = findMeta(botId, sessionId);
  if (!meta) {
    throw new AgentError('worker_session_missing', 'Worker 会话不存在', 409);
  }
  if (meta.owner && meta.owner.taskId !== taskId) {
    throw new AgentError(
      'worker_session_owner_mismatch',
      'Worker 会话已归属其他任务',
      409
    );
  }
  return publicMeta(meta, (load().messages[meta.id] || []).length);
}

function markRunning(botId, sessionId, runId) {
  assertBot(botId);
  const current = load();
  const meta = findMeta(botId, sessionId);
  if (!meta) throw new AgentError('worker_session_missing', 'Worker 会话不存在', 409);
  const previous = clone(meta.lifecycle);
  meta.lifecycle = {
    ...(meta.lifecycle || defaultLifecycle()),
    status: 'running',
    startedAt: nowIso(),
  };
  if (meta.owner) meta.owner.runId = runId || meta.owner.runId;
  try {
    save();
  } catch (error) {
    meta.lifecycle = previous;
    throw error;
  }
  return publicMeta(meta, (current.messages[meta.id] || []).length);
}

function closeSession(botId, sessionId, { status = 'closed', reason = null } = {}) {
  assertBot(botId);
  const current = load();
  const meta = findMeta(botId, sessionId);
  if (!meta) return null;
  // 只接受投影产物，避免调用方绕过 Task 状态再写第二套生命周期。
  if (!PROJECTED_LIFECYCLE_STATUSES.includes(status)) {
    throw new AgentError(
      'invalid_lifecycle_status',
      '会话生命周期状态必须由 Task 状态投影产生'
    );
  }
  meta.lifecycle = {
    ...(meta.lifecycle || defaultLifecycle()),
    status,
    closedAt: nowIso(),
    closeReason: typeof reason === 'string' ? reason.slice(0, 120) : null,
  };
  save();
  return publicMeta(meta, (current.messages[meta.id] || []).length);
}

function getMessages(botId, sessionId) {
  assertBot(botId);
  const meta = findMeta(botId, sessionId);
  if (!meta) return null;
  const current = load();
  return clone(current.messages[sessionId] || []);
}

function sanitizeToolSteps(value) {
  if (!Array.isArray(value)) return [];
  return value.slice(0, TOOL_STEPS_MAX).map(item => ({
    name: String(item && item.name ? item.name : '').slice(0, 60),
    ok: Boolean(item && item.ok === true),
    summary: String(item && item.summary ? item.summary : '').slice(0, 160),
    durationMs:
      Number.isFinite(item && item.durationMs) && item.durationMs >= 0
        ? Math.floor(item.durationMs)
        : 0,
  }));
}

function sanitizeMessage(message) {
  if (!message || typeof message !== 'object') {
    throw new AgentError('invalid_message', '消息格式无效');
  }
  const role = message.role === 'assistant' ? 'assistant' : message.role === 'user' ? 'user' : null;
  if (!role) throw new AgentError('invalid_message', '消息角色无效');
  const content = typeof message.content === 'string' ? message.content.slice(0, CONTENT_MAX) : '';
  if (!content.trim()) throw new AgentError('invalid_message', '消息内容不能为空');
  return {
    id: typeof message.id === 'string' && message.id ? message.id : crypto.randomUUID(),
    role,
    content,
    createdAt:
      typeof message.createdAt === 'string' && message.createdAt
        ? message.createdAt
        : nowIso(),
    ...(role === 'assistant'
      ? { toolSteps: sanitizeToolSteps(message.toolSteps) }
      : {}),
  };
}

function appendMessages(botId, sessionId, messages) {
  assertBot(botId);
  const current = load();
  const meta = findMeta(botId, sessionId);
  if (!meta) throw new AgentError('agent_session_not_found', 'Bot 会话不存在', 404);
  const incoming = (Array.isArray(messages) ? messages : []).map(sanitizeMessage);
  if (!incoming.length) {
    return { messageCount: (current.messages[sessionId] || []).length };
  }

  const previous = current.messages[sessionId] || [];
  const next = [...previous, ...incoming].slice(-MESSAGE_MAX);
  current.messages[sessionId] = next;
  meta.updatedAt = nowIso();

  try {
    save();
  } catch (error) {
    current.messages[sessionId] = previous;
    throw error;
  }

  return { messageCount: next.length, messages: clone(incoming) };
}

function deleteSession(botId, sessionId) {
  assertBot(botId);
  const current = load();
  const meta = findMeta(botId, sessionId);
  if (!meta) return false;
  const previousSessions = current.sessions;
  const previousMessages = current.messages[sessionId];
  current.sessions = current.sessions.filter(item => item.id !== sessionId);
  delete current.messages[sessionId];
  try {
    save();
  } catch (error) {
    current.sessions = previousSessions;
    current.messages[sessionId] = previousMessages;
    throw error;
  }
  return true;
}

function reloadForTests() {
  cache = null;
}

module.exports = {
  STORE_FILE,
  MESSAGE_MAX,
  SCOPES,
  LIFECYCLE_STATES,
  deriveLifecycleStatus,
  listSessions,
  getSession,
  createSession,
  getMessages,
  appendMessages,
  deleteSession,
  attachOwner,
  assertWorkerSession,
  markRunning,
  closeSession,
  reloadForTests,
};
