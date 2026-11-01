/* global module, __dirname */
/**
 * Bot 任务与事件存储。
 *
 * - 任务保存目标、状态与结构化结果；事件只允许安全标量字段，
 *   绝不记录 Prompt、Key、记忆正文或模型推理。
 * - 事件是 UI 状态的唯一事实来源；客户端不得自行编造进度。
 */
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { writeFileAtomicSync } = require('../atomic-write');
const { getManifest, isKnownBot } = require('./manifest');
const { AgentError } = require('./errors');
const taskStore = require('./task-store');
const stateMachine = require('./state-machine');
const { normalizeWorkerResult } = require('./worker-result');

const DATA_DIR = process.env.BLUEBIRD_DATA_DIR
  ? path.resolve(process.env.BLUEBIRD_DATA_DIR)
  : path.join(__dirname, '..', 'data');
const AGENTS_DIR = path.join(DATA_DIR, 'agents');
const TASKS_FILE = taskStore.TASKS_FILE;
const EVENTS_FILE = path.join(AGENTS_DIR, 'agent-events.json');
const OUTBOX_FILE = path.join(AGENTS_DIR, 'agent-event-outbox.json');
// 任务存储用 Store 的 schema 版本；事件/outbox 仍使用自己的 v1 结构。
const TASK_SCHEMA_VERSION = taskStore.SCHEMA_VERSION;
const AUX_SCHEMA_VERSION = 1;
const TASK_MAX = 500;
const EVENT_MAX = 3000;
// 事件 outbox 的增长硬上限：主事件文件写不进去时，事件会先堆在 outbox 里。
// 没有上限时磁盘可能被写满；超出后只保留最近的 OUTBOX_MAX 条并记录被丢弃的条数，
// 不假装"全都保存了"。
const OUTBOX_MAX = 500;
const GOAL_MAX = 2000;
const CONTEXT_MAX = 8000;
const PARENT_USER_TEXT_MAX = 4000;
const RESULT_SUMMARY_MAX = 8000;
// Task Contract v1：这些字段是 Router/Worker 之间的冻结契约。
// 旧字段 botId / sessionId 保留为同一值的别名，避免破坏既有 API 与前端。
const CONTRACT_VERSION = 1;
const CONTEXT_REF_MAX = 200;
const IDEMPOTENCY_KEY_MAX = 120;
const PRIORITIES = Object.freeze(['high', 'normal', 'low']);
const PRIORITY_RANK = Object.freeze({ high: 0, normal: 1, low: 2 });

const STATUSES = stateMachine.STATUSES;
const TERMINAL = stateMachine.TERMINAL;

const EVENT_TYPES = Object.freeze([
  'task.created',
  'task.accepted',
  'task.recovered',
  'route.decided',
  'route.rejected',
  'task.started',
  'worker.checkpoint',
  'worker.heartbeat',
  'tool.denied',
  'model.requested',
  'model.completed',
  'model.failed',
  'tool.started',
  'tool.completed',
  'tool.failed',
  'memory.read',
  'memory.write_proposed',
  'memory.changed',
  'approval.requested',
  'approval.resolved',
  'task.completed',
  'task.delivery',
  'task.failed',
  'task.cancelled',
  'task.timed_out',
  'task.uncertain',
]);

const SAFE_PAYLOAD_KEYS = new Set([
  'status',
  'taskType',
  'tool',
  'ok',
  'durationMs',
  'rounds',
  'toolCalls',
  'requestId',
  'providerId',
  'modelId',
  'resultCount',
  'stopReason',
  'errorCode',
  'mode',
  'decision',
  'messageId',
  'pending',
  'routeId',
  'path',
  'pathReason',
  'capability',
  'candidateCount',
  'candidates',
  'rejected',
  'selected',
  'degraded',
  'priority',
  'contractVersion',
  'idempotent',
  'policyDigest',
  'round',
  'phase',
  'attempts',
  'leaseOwner',
  'retryAt',
]);

let taskCache = null;
let eventCache = null;
let outboxCache = null;

function nowIso() {
  return new Date().toISOString();
}

function ensureDir() {
  fs.mkdirSync(AGENTS_DIR, { recursive: true });
}

function readJson(file, code) {
  if (!fs.existsSync(file)) return null;
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch (_) {
    throw new AgentError(code, 'Bot 数据文件无法解析', 500);
  }
}

function emptyTasks() {
  return taskStore.empty();
}
function emptyEvents() {
  return { version: AUX_SCHEMA_VERSION, events: [] };
}

function emptyOutbox() {
  return { version: AUX_SCHEMA_VERSION, events: [] };
}

// Task Store 接口负责读取、schema 迁移（v1 → v2）与结构校验；
// 这里只缓存业务层视图，并在迁移发生后尽力回写一次。
function loadTasks() {
  if (taskCache) return taskCache;
  const result = taskStore.read();
  taskCache = result.store;
  if (result.migrated) {
    try {
      saveTasks();
    } catch (_) {
      // 存储暂不可写时保留内存中的规范视图；下一次成功写入会一并落盘。
    }
  }
  return taskCache;
}

function loadEvents() {
  if (eventCache) return eventCache;
  ensureDir();
  const parsed = readJson(EVENTS_FILE, 'agent_events_corrupted');
  if (!parsed) {
    eventCache = emptyEvents();
    return eventCache;
  }
  if (parsed.version !== AUX_SCHEMA_VERSION || !Array.isArray(parsed.events)) {
    throw new AgentError('agent_events_corrupted', 'Bot 事件存储结构无效', 500);
  }
  eventCache = parsed;
  return eventCache;
}

function saveTasks() {
  taskStore.write(taskCache);
}
function saveEvents() {
  ensureDir();
  writeFileAtomicSync(EVENTS_FILE, JSON.stringify(eventCache, null, 2));
}

function loadOutbox() {
  if (outboxCache) return outboxCache;
  ensureDir();
  const parsed = readJson(OUTBOX_FILE, 'agent_event_outbox_corrupted');
  if (!parsed) {
    outboxCache = emptyOutbox();
    return outboxCache;
  }
  if (parsed.version !== AUX_SCHEMA_VERSION || !Array.isArray(parsed.events)) {
    throw new AgentError('agent_event_outbox_corrupted', '事件投递队列结构无效', 500);
  }
  outboxCache = parsed;
  return outboxCache;
}

function saveOutbox() {
  ensureDir();
  writeFileAtomicSync(OUTBOX_FILE, JSON.stringify(outboxCache, null, 2));
}

// 先把事件放入持久 outbox，再尝试写主事件文件；写主文件失败时事件仍在
// outbox 中，可由下次启动/读取重试，不再被 safeEvent 静默吞掉。
function flushEventOutbox() {
  const outbox = loadOutbox();
  if (!outbox.events.length) return { flushed: 0, pending: 0 };
  const events = loadEvents();
  const known = new Set(events.events.map(event => event.eventId));
  const pending = outbox.events.filter(event => !known.has(event.eventId));
  events.events.push(...pending);
  if (events.events.length > EVENT_MAX) {
    events.events = events.events.slice(-EVENT_MAX);
  }
  try {
    saveEvents();
    outbox.events = [];
    saveOutbox();
    return { flushed: pending.length, pending: 0 };
  } catch (error) {
    outboxCache = outbox;
    return { flushed: 0, pending: outbox.events.length, errorCode: (error && error.code) || 'event_write_failed' };
  }
}

function assertBot(botId) {
  if (!isKnownBot(botId)) {
    throw new AgentError('agent_not_found', 'Agent 不存在', 404);
  }
}

function clone(value) {
  return JSON.parse(JSON.stringify(value));
}

function safePayload(payload) {
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) return {};
  const out = {};
  for (const [key, value] of Object.entries(payload)) {
    if (!SAFE_PAYLOAD_KEYS.has(key)) continue;
    if (value === null || typeof value === 'boolean' || typeof value === 'string') {
      out[key] = typeof value === 'string' ? value.slice(0, 200) : value;
    } else if (typeof value === 'number' && Number.isFinite(value)) {
      out[key] = value;
    }
  }
  return out;
}

function appendEvent({
  botId,
  taskId = null,
  runId = null,
  sessionId = null,
  eventType,
  payload = {},
  correlationId = null,
}) {
  assertBot(botId);
  if (!EVENT_TYPES.includes(eventType)) {
    throw new AgentError('invalid_event', '事件类型无效');
  }
  const events = loadEvents();
  const event = {
    eventId: `evt_${crypto.randomUUID()}`,
    taskId,
    runId,
    botId,
    sessionId,
    timestamp: nowIso(),
    eventType,
    payload: safePayload(payload),
    correlationId: correlationId || taskId || runId || null,
  };
  const outbox = loadOutbox();
  outbox.events.push(event);
  if (outbox.events.length > OUTBOX_MAX) {
    const dropped = outbox.events.length - OUTBOX_MAX;
    outbox.events = outbox.events.slice(-OUTBOX_MAX);
    console.error(
      JSON.stringify({
        ts: nowIso(),
        level: 'error',
        event: 'agent_event_outbox_overflow',
        module: 'agents',
        file: OUTBOX_FILE,
        reason: 'outbox_overflow',
        action: 'drop_oldest',
        dropped,
        cap: OUTBOX_MAX,
      })
    );
  }
  saveOutbox();

  try {
    if (!events.events.some(item => item.eventId === event.eventId)) {
      events.events.push(event);
      if (events.events.length > EVENT_MAX) {
        events.events = events.events.slice(-EVENT_MAX);
      }
      saveEvents();
    }
    outbox.events = outbox.events.filter(item => item.eventId !== event.eventId);
    saveOutbox();
    return { ...event, payload: { ...event.payload } };
  } catch (error) {
    // 主事件文件暂时不可写：事件已在 outbox 持久化，返回 queued 供调用方记录。
    return {
      ...event,
      payload: { ...event.payload },
      queued: true,
      errorCode: (error && error.code) || 'event_write_failed',
    };
  }
}

function listEvents(botId, { limit = 50 } = {}) {
  assertBot(botId);
  try {
    flushEventOutbox();
  } catch (_) {
    // outbox 自身不可读时仍返回主事件文件中的可用部分。
  }
  const events = loadEvents();
  let queued = [];
  try {
    queued = loadOutbox().events;
  } catch (_) {
    queued = [];
  }
  const merged = new Map();
  for (const event of [...events.events, ...queued]) {
    merged.set(event.eventId, event);
  }
  const max = Math.min(Math.max(Number(limit) || 50, 1), 200);
  return [...merged.values()]
    .filter(event => event.botId === botId)
    .sort((a, b) => String(a.timestamp).localeCompare(String(b.timestamp)))
    .slice(-max)
    .reverse()
    .map(event => ({ ...event, payload: { ...event.payload } }));
}

function publicTask(task, { includeResult = true } = {}) {
  if (!task) return null;
  const agentId = task.agentId || task.botId;
  const workerSessionId = task.workerSessionId || task.sessionId;
  return {
    taskId: task.taskId,
    // Task Contract v1（规范字段）；botId/sessionId 是同一值的兼容别名。
    contractVersion: task.contractVersion || CONTRACT_VERSION,
    agentId,
    workerSessionId,
    botId: agentId,
    taskType: task.taskType,
    goal: task.goal,
    sessionId: workerSessionId,
    parentSessionId: task.parentSessionId || null,
    parentMessageId: task.parentMessageId || null,
    priority: task.priority || 'normal',
    contextRef: task.contextRef || null,
    idempotencyKey: task.idempotencyKey || null,
    route: task.route ? clone(task.route) : null,
    budget: task.budget ? clone(task.budget) : null,
    // Worker 运行期元数据（不属于 Task Contract 字段，随执行更新）。
    runId: task.runId || null,
    runStartedAt: task.runStartedAt || null,
    heartbeatAt: task.heartbeatAt || null,
    checkpoint: task.checkpoint ? clone(task.checkpoint) : null,
    // 阶段 3：租约、重试与运行历史。
    lease: task.lease ? clone(task.lease) : null,
    retryAt: task.retryAt || null,
    lastErrorCode: task.lastErrorCode || null,
    checkpointVersion: Number.isInteger(task.checkpointVersion)
      ? task.checkpointVersion
      : 0,
    runs: Array.isArray(task.runs) ? clone(task.runs) : [],
    requiresReview: task.requiresReview === true,
    deliveredToParentAt: task.deliveredToParentAt || null,
    deliveryMessageId: task.deliveryMessageId || null,
    deliveryStatus: task.deliveryStatus || 'not_applicable',
    deliveryErrorCode: task.deliveryErrorCode || null,
    allowedTools: [...task.allowedTools],
    deadlineMs: task.deadlineMs,
    status: task.status,
    cancelRequested: task.cancelRequested === true,
    attempts: Number.isInteger(task.attempts) ? task.attempts : 0,
    maxAttempts: Number.isInteger(task.maxAttempts) ? task.maxAttempts : 1,
    recoveredAt: task.recoveredAt || null,
    createdAt: task.createdAt,
    updatedAt: task.updatedAt,
    startedAt: task.startedAt,
    completedAt: task.completedAt,
    errorCode: task.errorCode,
    result: includeResult && task.result ? clone(task.result) : null,
  };
}

// 只有“终态且已投递（或无需投递）”的任务可以被裁剪。未完成的队列任务、
// waiting_approval 和投递失败的任务仍需要恢复/展示，不能在容量压力下被删掉。
function isDeliveredTerminal(task) {
  if (!task || !TERMINAL.has(task.status)) return false;
  return (
    task.deliveryStatus === 'delivered' ||
    task.deliveryStatus === 'not_applicable'
  );
}

function pruneDeliveredTerminalTasks(tasks) {
  const removable = Object.values(tasks.tasks)
    .filter(isDeliveredTerminal)
    .sort((a, b) => String(a.createdAt).localeCompare(String(b.createdAt)));
  const removed = [];
  for (const item of removable) {
    if (Object.keys(tasks.tasks).length < TASK_MAX) break;
    removed.push(item);
    delete tasks.tasks[item.taskId];
  }
  return removed;
}

function normalizeBudget(budget) {
  if (budget === null || budget === undefined) return null;
  if (typeof budget !== 'object' || Array.isArray(budget)) {
    throw new AgentError('invalid_task', 'budget 必须是对象或 null');
  }
  const maxRounds = Number(budget.maxRounds);
  const maxToolCalls = Number(budget.maxToolCalls);
  const maxReadOnlyRetries = Number(budget.maxReadOnlyRetries);
  if (!Number.isInteger(maxRounds) || maxRounds < 2 || maxRounds > 5) {
    throw new AgentError('invalid_task', 'budget.maxRounds 必须在 2 到 5 之间');
  }
  if (!Number.isInteger(maxToolCalls) || maxToolCalls < 1 || maxToolCalls > 12) {
    throw new AgentError('invalid_task', 'budget.maxToolCalls 必须在 1 到 12 之间');
  }
  if (
    !Number.isInteger(maxReadOnlyRetries) ||
    maxReadOnlyRetries < 0 ||
    maxReadOnlyRetries > 1
  ) {
    throw new AgentError('invalid_task', 'budget.maxReadOnlyRetries 必须在 0 到 1 之间');
  }
  return {
    maxRounds,
    maxToolCalls,
    maxReadOnlyRetries,
    generatePlan: budget.generatePlan === true,
  };
}

function normalizeRoute(route) {
  if (route === null || route === undefined) return null;
  if (typeof route !== 'object' || Array.isArray(route)) {
    throw new AgentError('invalid_task', 'route 必须是对象或 null');
  }
  return {
    routeId: String(route.routeId || '').slice(0, 80),
    path: route.path === 'slow' ? 'slow' : 'fast',
    capability: String(route.capability || '').slice(0, 80),
    policyDigest: String(route.policyDigest || '').slice(0, 32),
    decidedAt: typeof route.decidedAt === 'string' ? route.decidedAt : null,
  };
}

function findByIdempotencyKey(agentId, idempotencyKey) {
  const key = typeof idempotencyKey === 'string' ? idempotencyKey.trim() : '';
  if (!key) return null;
  const tasks = loadTasks();
  const match = Object.values(tasks.tasks).find(
    task =>
      (task.agentId || task.botId) === agentId &&
      (task.idempotencyKey || null) === key
  );
  return match ? publicTask(match) : null;
}

function createTask({
  agentId = null,
  botId = null,
  taskType,
  goal,
  context = '',
  workerSessionId = null,
  sessionId = null,
  allowedTools = null,
  deadlineMs = 60000,
  priority = 'normal',
  contextRef = null,
  idempotencyKey = null,
  route = null,
  budget = null,
  parentSessionId = null,
  parentMessageId = null,
  parentUserText = null,
} = {}) {
  const resolvedAgentId = String(agentId || botId || '');
  assertBot(resolvedAgentId);
  const manifest = getManifest(resolvedAgentId);
  if (!manifest.acceptedTaskTypes.includes(taskType)) {
    throw new AgentError('invalid_task_type', '该 Bot 不接受此任务类型');
  }
  const cleanGoal = typeof goal === 'string' ? goal.trim() : '';
  if (!cleanGoal) throw new AgentError('invalid_task', '任务目标不能为空');
  if (cleanGoal.length > GOAL_MAX) throw new AgentError('invalid_task', '任务目标过长');
  const cleanContext = typeof context === 'string' ? context.trim() : '';
  if (cleanContext.length > CONTEXT_MAX) {
    throw new AgentError('invalid_task', '任务上下文过长');
  }
  const cleanSession =
    typeof workerSessionId === 'string' && workerSessionId.trim()
      ? workerSessionId.trim()
      : typeof sessionId === 'string' && sessionId.trim()
        ? sessionId.trim()
        : null;
  const cleanParentSession =
    typeof parentSessionId === 'string' && parentSessionId.trim()
      ? parentSessionId.trim()
      : null;
  const cleanParentMessage =
    typeof parentMessageId === 'string' && parentMessageId.trim()
      ? parentMessageId.trim()
      : null;
  // 委派写入的接地来源是主控用户原话，不是模型生成的 goal。
  const cleanParentUserText =
    typeof parentUserText === 'string'
      ? parentUserText.trim().slice(0, PARENT_USER_TEXT_MAX)
      : '';
  const cleanDeadline = Number(deadlineMs);
  if (
    !Number.isInteger(cleanDeadline) ||
    cleanDeadline < 5000 ||
    cleanDeadline > 120000
  ) {
    throw new AgentError('invalid_task', 'deadlineMs 必须在 5000 到 120000 之间');
  }

  let tools = [...manifest.toolAllowlist];
  if (allowedTools !== null) {
    if (!Array.isArray(allowedTools)) {
      throw new AgentError('invalid_task', 'allowedTools 必须是数组或 null');
    }
    const allowed = new Set(manifest.toolAllowlist);
    tools = [];
    for (const name of allowedTools) {
      if (!allowed.has(name)) {
        throw new AgentError('invalid_task', 'allowedTools 超出 Bot 能力范围');
      }
      if (!tools.includes(name)) tools.push(name);
    }
  }

  const cleanPriority = priority === null || priority === undefined ? 'normal' : String(priority);
  if (!PRIORITIES.includes(cleanPriority)) {
    throw new AgentError('invalid_task', 'priority 必须是 high、normal 或 low');
  }
  const cleanContextRef =
    typeof contextRef === 'string' && contextRef.trim() ? contextRef.trim() : null;
  if (cleanContextRef && cleanContextRef.length > CONTEXT_REF_MAX) {
    throw new AgentError('invalid_task', `contextRef 不能超过 ${CONTEXT_REF_MAX} 字`);
  }
  const cleanIdempotencyKey =
    typeof idempotencyKey === 'string' && idempotencyKey.trim()
      ? idempotencyKey.trim()
      : null;
  if (cleanIdempotencyKey && cleanIdempotencyKey.length > IDEMPOTENCY_KEY_MAX) {
    throw new AgentError('invalid_task', `idempotencyKey 不能超过 ${IDEMPOTENCY_KEY_MAX} 字`);
  }
  const cleanRoute = normalizeRoute(route);
  const cleanBudget = normalizeBudget(budget);

  // 同一 Agent 的相同幂等键返回既有任务，不重复创建、不重复入队。
  // Router 在建立 Worker 会话之前也会先查一次，避免产生空会话。
  const existing = findByIdempotencyKey(resolvedAgentId, cleanIdempotencyKey);
  if (existing) return { ...existing, idempotent: true };

  const tasks = loadTasks();
  const pruned =
    Object.keys(tasks.tasks).length >= TASK_MAX
      ? pruneDeliveredTerminalTasks(tasks)
      : [];
  if (Object.keys(tasks.tasks).length >= TASK_MAX) {
    throw new AgentError(
      'agent_task_limit',
      '任务数量已达上限，且没有可裁剪的已投递终态任务',
      409
    );
  }

  const t = nowIso();
  const task = {
    taskId: `task_${crypto.randomUUID()}`,
    contractVersion: CONTRACT_VERSION,
    agentId: resolvedAgentId,
    workerSessionId: cleanSession,
    // 兼容别名：与上面的规范字段保持同值，旧调用方/前端继续可读。
    botId: resolvedAgentId,
    sessionId: cleanSession,
    taskType,
    goal: cleanGoal,
    context: cleanContext,
    priority: cleanPriority,
    contextRef: cleanContextRef,
    idempotencyKey: cleanIdempotencyKey,
    route: cleanRoute,
    budget: cleanBudget,
    runId: null,
    runStartedAt: null,
    heartbeatAt: null,
    checkpoint: null,
    lease: null,
    retryAt: null,
    lastErrorCode: null,
    checkpointVersion: 0,
    runs: [],
    requiresReview: false,
    parentSessionId: cleanParentSession,
    parentMessageId: cleanParentMessage,
    parentUserText: cleanParentUserText,
    deliveredToParentAt: null,
    deliveryMessageId: null,
    deliveryStatus: cleanParentSession ? 'pending' : 'not_applicable',
    deliveryErrorCode: null,
    allowedTools: tools,
    deadlineMs: cleanDeadline,
    status: 'queued',
    cancelRequested: false,
    attempts: 0,
    maxAttempts: Math.min(3, Math.max(1, Number(process.env.BLUEBIRD_AGENT_TASK_MAX_ATTEMPTS) || 1)),
    recoveredAt: null,
    createdAt: t,
    updatedAt: t,
    startedAt: null,
    completedAt: null,
    errorCode: null,
    result: null,
  };
  tasks.tasks[task.taskId] = task;
  try {
    saveTasks();
  } catch (error) {
    for (const removed of pruned) tasks.tasks[removed.taskId] = removed;
    delete tasks.tasks[task.taskId];
    throw error;
  }
  appendEvent({
    botId: resolvedAgentId,
    taskId: task.taskId,
    eventType: 'task.created',
    payload: { status: 'queued', taskType, mode: 'delegated_task' },
  });
  return publicTask(task);
}

function getTask(taskId) {
  const tasks = loadTasks();
  const task = tasks.tasks[String(taskId || '')] || null;
  return task ? publicTask(task) : null;
}

function getRawTask(taskId) {
  const tasks = loadTasks();
  return tasks.tasks[String(taskId || '')] || null;
}

function listTasks(botId, { limit = 20, parentSessionId = null } = {}) {
  assertBot(botId);
  const tasks = loadTasks();
  const max = Math.min(Math.max(Number(limit) || 20, 1), 100);
  const parent =
    typeof parentSessionId === 'string' && parentSessionId.trim()
      ? parentSessionId.trim()
      : null;
  return Object.values(tasks.tasks)
    .filter(task => (task.agentId || task.botId) === botId)
    .filter(task => !parent || task.parentSessionId === parent)
    .sort((a, b) => String(b.createdAt).localeCompare(String(a.createdAt)))
    .slice(0, max)
    .map(task => publicTask(task));
}

function updateTask(taskId, patch = {}) {
  const tasks = loadTasks();
  const task = tasks.tasks[String(taskId || '')];
  if (!task) throw new AgentError('task_not_found', '任务不存在', 404);

  if (patch.status !== undefined) {
    stateMachine.assertTransition(task.status, patch.status);
    task.status = patch.status;
  }
  if (patch.cancelRequested !== undefined) {
    task.cancelRequested = patch.cancelRequested === true;
  }
  if (Number.isInteger(patch.attempts) && patch.attempts >= 0) {
    task.attempts = patch.attempts;
  }
  if (patch.startedAt !== undefined) task.startedAt = patch.startedAt;
  if (patch.completedAt !== undefined) task.completedAt = patch.completedAt;
  if (patch.errorCode !== undefined) task.errorCode = patch.errorCode;
  if (patch.runId !== undefined) task.runId = patch.runId;
  if (patch.runStartedAt !== undefined) task.runStartedAt = patch.runStartedAt;
  if (patch.heartbeatAt !== undefined) task.heartbeatAt = patch.heartbeatAt;
  // 旧任务/直接建任务可能没有 Worker 会话：运行开始时补建并回填，
  // 只允许从空值变为实际会话，不允许改写已存在的会话身份。
  if (
    (patch.workerSessionId !== undefined || patch.sessionId !== undefined) &&
    !task.sessionId
  ) {
    const next = String(patch.workerSessionId || patch.sessionId || '').trim();
    if (next) {
      task.workerSessionId = next;
      task.sessionId = next;
    }
  }
  if (patch.checkpoint !== undefined) {
    if (patch.checkpoint === null) {
      task.checkpoint = null;
    } else if (typeof patch.checkpoint === 'object') {
      task.checkpoint = {
        round: Number.isInteger(patch.checkpoint.round) ? patch.checkpoint.round : 0,
        toolCalls: Number.isInteger(patch.checkpoint.toolCalls)
          ? patch.checkpoint.toolCalls
          : 0,
        phase: String(patch.checkpoint.phase || '').slice(0, 40),
        at: typeof patch.checkpoint.at === 'string' ? patch.checkpoint.at : nowIso(),
      };
    }
  }
  if (patch.retryAt !== undefined) {
    task.retryAt = typeof patch.retryAt === 'string' ? patch.retryAt : null;
  }
  if (patch.lastErrorCode !== undefined) {
    task.lastErrorCode =
      typeof patch.lastErrorCode === 'string'
        ? patch.lastErrorCode.slice(0, 60)
        : null;
  }
  if (patch.requiresReview !== undefined) {
    task.requiresReview = patch.requiresReview === true;
  }
  if (patch.lease !== undefined) {
    if (patch.lease === null) {
      task.lease = null;
    } else if (typeof patch.lease === 'object') {
      task.lease = {
        ownerId: String(patch.lease.ownerId || '').slice(0, 120),
        acquiredAt:
          typeof patch.lease.acquiredAt === 'string' ? patch.lease.acquiredAt : null,
        expiresAt:
          typeof patch.lease.expiresAt === 'string' ? patch.lease.expiresAt : null,
        heartbeatAt:
          typeof patch.lease.heartbeatAt === 'string' ? patch.lease.heartbeatAt : null,
      };
    }
  }
  if (Number.isInteger(patch.checkpointVersion) && patch.checkpointVersion >= 0) {
    task.checkpointVersion = patch.checkpointVersion;
  }
  if (patch.deliveredToParentAt !== undefined) {
    task.deliveredToParentAt = patch.deliveredToParentAt;
  }
  if (patch.deliveryMessageId !== undefined) {
    task.deliveryMessageId = patch.deliveryMessageId;
  }
  if (patch.deliveryStatus !== undefined) {
    task.deliveryStatus = patch.deliveryStatus;
  }
  if (patch.deliveryErrorCode !== undefined) {
    task.deliveryErrorCode = patch.deliveryErrorCode;
  }
  if (patch.result !== undefined) {
    if (!patch.result || typeof patch.result !== 'object') {
      throw new AgentError('invalid_task_result', '任务结果必须是对象');
    }
    const result = patch.result;
    task.result = {
      // 统一结果 schema：终态（completed/failed/cancelled/timed_out）都按
      // 这一形状落库，status/errorCode 不再只存在于任务顶层。
      status: STATUSES.includes(result.status) ? result.status : null,
      summary:
        typeof result.summary === 'string'
          ? result.summary.slice(0, RESULT_SUMMARY_MAX)
          : '',
      artifacts: Array.isArray(result.artifacts)
        ? result.artifacts
            .filter(item => item && typeof item === 'object')
            .slice(0, 40)
            .map(item => ({
              kind: String(item.kind || '').slice(0, 40),
              id: String(item.id || '').slice(0, 120),
            }))
        : [],
      toolSteps: Array.isArray(result.toolSteps)
        ? result.toolSteps.slice(0, 20).map(step => ({
            name: String(step && step.name ? step.name : '').slice(0, 60),
            ok: Boolean(step && step.ok === true),
            summary: String(step && step.summary ? step.summary : '').slice(0, 160),
            durationMs:
              Number.isFinite(step && step.durationMs) && step.durationMs >= 0
                ? Math.floor(step.durationMs)
                : 0,
          }))
        : [],
      evidence: Array.isArray(result.evidence)
        ? result.evidence
            .filter(item => item && typeof item === 'object')
            .slice(0, 40)
            .map(item => ({
              kind: String(item.kind || '').slice(0, 40),
              id: String(item.id || '').slice(0, 120),
            }))
        : [],
      changes: Array.isArray(result.changes)
        ? result.changes
            .filter(item => item && typeof item === 'object')
            .slice(0, 20)
            .map(item => ({
              kind: String(item.kind || '').slice(0, 40),
              id: String(item.id || '').slice(0, 120),
              decision: String(item.decision || '').slice(0, 40),
            }))
        : [],
      requiresConfirmation: result.requiresConfirmation === true,
      requiresApproval:
        result.requiresApproval === true || result.requiresConfirmation === true,
      errorCode:
        typeof result.errorCode === 'string' ? result.errorCode.slice(0, 60) : null,
      runId: typeof result.runId === 'string' ? result.runId.slice(0, 80) : null,
      finishedAt: typeof result.finishedAt === 'string' ? result.finishedAt : null,
      rounds: Number.isInteger(result.rounds) ? result.rounds : 0,
      stopReason: typeof result.stopReason === 'string' ? result.stopReason : null,
      model: result.model && typeof result.model === 'object'
        ? {
            providerId: String(result.model.providerId || '').slice(0, 120),
            modelId: String(result.model.modelId || '').slice(0, 120),
          }
        : null,
    };
  }
  task.updatedAt = nowIso();
  saveTasks();
  return publicTask(task);
}

function isTerminalStatus(status) {
  return TERMINAL.has(status);
}

function allTasks() {
  return Object.values(loadTasks().tasks);
}

function priorityRank(priority) {
  return PRIORITY_RANK[priority] === undefined ? PRIORITY_RANK.normal : PRIORITY_RANK[priority];
}

// ---- 阶段 3：租约、运行历史、重试与恢复 ----

const SIDE_EFFECT_TOOLS = Object.freeze(['memory_remember']);
const LEASE_TTL_DEFAULT_MS = 60000;
const RUN_HISTORY_MAX = 5;

function leaseExpired(lease, nowMs = Date.now()) {
  if (!lease || !lease.expiresAt) return true;
  const expires = Date.parse(lease.expiresAt);
  return !Number.isFinite(expires) || expires <= nowMs;
}

function acquireLease(
  taskId,
  { ownerId = '', ttlMs = LEASE_TTL_DEFAULT_MS, now = Date.now() } = {}
) {
  const state = loadTasks();
  const task = state.tasks[String(taskId || '')];
  if (!task) throw new AgentError('task_not_found', '任务不存在', 404);
  if (!ownerId) throw new AgentError('invalid_lease_owner', '租约 owner 不能为空');
  if (stateMachine.isTerminal(task.status)) {
    throw new AgentError('task_lease_terminal', '终态任务不能再获取租约', 409);
  }
  if (task.lease && task.lease.ownerId !== ownerId && !leaseExpired(task.lease, now)) {
    throw new AgentError('task_lease_held', '任务租约由其他 Worker 持有', 409);
  }
  const iso = new Date(now).toISOString();
  task.lease = {
    ownerId: String(ownerId).slice(0, 120),
    acquiredAt: iso,
    expiresAt: new Date(now + Math.max(1000, ttlMs)).toISOString(),
    heartbeatAt: iso,
  };
  task.updatedAt = iso;
  saveTasks();
  return publicTask(task);
}

function renewLease(
  taskId,
  { ownerId = '', ttlMs = LEASE_TTL_DEFAULT_MS, now = Date.now() } = {}
) {
  const state = loadTasks();
  const task = state.tasks[String(taskId || '')];
  if (!task) throw new AgentError('task_not_found', '任务不存在', 404);
  if (
    !task.lease ||
    task.lease.ownerId !== ownerId ||
    leaseExpired(task.lease, now)
  ) {
    throw new AgentError('task_lease_lost', '任务租约已丢失', 409);
  }
  const iso = new Date(now).toISOString();
  task.lease.heartbeatAt = iso;
  task.lease.expiresAt = new Date(now + Math.max(1000, ttlMs)).toISOString();
  task.heartbeatAt = iso;
  task.updatedAt = iso;
  saveTasks();
  return publicTask(task);
}

function releaseLease(taskId) {
  const state = loadTasks();
  const task = state.tasks[String(taskId || '')];
  if (!task) return null;
  task.lease = null;
  task.updatedAt = nowIso();
  saveTasks();
  return publicTask(task);
}

function recordRunStart(taskId, { runId, attempt, startedAt } = {}) {
  const state = loadTasks();
  const task = state.tasks[String(taskId || '')];
  if (!task) throw new AgentError('task_not_found', '任务不存在', 404);
  const at = typeof startedAt === 'string' ? startedAt : nowIso();
  task.runId = runId || task.runId || null;
  task.runStartedAt = at;
  if (Number.isInteger(attempt) && attempt >= 0) task.attempts = attempt;
  const runs = Array.isArray(task.runs) ? task.runs : [];
  runs.push({
    runId: task.runId,
    attempt: Number.isInteger(task.attempts) ? task.attempts : 0,
    startedAt: at,
    finishedAt: null,
    status: 'running',
    errorCode: null,
  });
  task.runs = runs.slice(-RUN_HISTORY_MAX);
  task.updatedAt = at;
  saveTasks();
  return publicTask(task);
}

function recordRunFinish(taskId, { runId, status, errorCode = null, finishedAt } = {}) {
  const state = loadTasks();
  const task = state.tasks[String(taskId || '')];
  if (!task) return null;
  const at = typeof finishedAt === 'string' ? finishedAt : nowIso();
  const runs = Array.isArray(task.runs) ? task.runs : [];
  const entry =
    runs.find(item => item.runId === runId && !item.finishedAt) ||
    runs.find(item => item.runId === runId) ||
    null;
  if (entry) {
    entry.finishedAt = at;
    entry.status = status || entry.status;
    entry.errorCode = errorCode || null;
  } else {
    runs.push({
      runId: runId || task.runId || null,
      attempt: Number.isInteger(task.attempts) ? task.attempts : 0,
      startedAt: task.runStartedAt || at,
      finishedAt: at,
      status: status || null,
      errorCode: errorCode || null,
    });
  }
  task.runs = runs.slice(-RUN_HISTORY_MAX);
  task.updatedAt = at;
  saveTasks();
  return publicTask(task);
}

function recordCheckpoint(taskId, checkpoint = {}, now = Date.now()) {
  const state = loadTasks();
  const task = state.tasks[String(taskId || '')];
  if (!task) throw new AgentError('task_not_found', '任务不存在', 404);
  const at = typeof checkpoint.at === 'string' ? checkpoint.at : new Date(now).toISOString();
  task.checkpoint = {
    round: Number.isInteger(checkpoint.round) ? checkpoint.round : 0,
    toolCalls: Number.isInteger(checkpoint.toolCalls) ? checkpoint.toolCalls : 0,
    phase: String(checkpoint.phase || 'progress').slice(0, 40),
    at,
  };
  task.checkpointVersion =
    (Number.isInteger(task.checkpointVersion) ? task.checkpointVersion : 0) + 1;
  task.heartbeatAt = at;
  task.updatedAt = at;
  saveTasks();
  return publicTask(task);
}

function setRetry(taskId, { errorCode, retryAt, now = Date.now() } = {}) {
  const state = loadTasks();
  const task = state.tasks[String(taskId || '')];
  if (!task) throw new AgentError('task_not_found', '任务不存在', 404);
  stateMachine.assertTransition(task.status, 'queued');
  const at = new Date(now).toISOString();
  task.status = 'queued';
  task.retryAt =
    typeof retryAt === 'string'
      ? retryAt
      : new Date(now + Math.min(30000, 1000 * Math.max(1, task.attempts || 1))).toISOString();
  task.lastErrorCode =
    typeof errorCode === 'string' ? errorCode.slice(0, 60) : null;
  task.errorCode = null;
  task.recoveredAt = at;
  task.runId = null;
  task.heartbeatAt = null;
  task.lease = null;
  task.updatedAt = at;
  saveTasks();
  return publicTask(task);
}

function hasSideEffectTools(task) {
  return (
    Array.isArray(task.allowedTools) &&
    task.allowedTools.some(name => SIDE_EFFECT_TOOLS.includes(name))
  );
}

// 启动恢复：租约仍由未过期且不同的 owner 持有时保持 running；
// 只读任务重新排队；可能产生副作用的任务标记 uncertain 等待人工处理，
// 绝不凭空报告成功。
function recoverInterrupted({ ownerId = null, now = Date.now() } = {}) {
  const state = loadTasks();
  const at = new Date(now).toISOString();
  let recovered = 0;
  let uncertain = 0;
  let leftRunning = 0;
  const taskIds = [];
  const uncertainTaskIds = [];
  let changed = false;

  for (const task of Object.values(state.tasks)) {
    if (!stateMachine.isRecoverable(task.status)) continue;
    if (
      task.lease &&
      ownerId &&
      task.lease.ownerId !== ownerId &&
      !leaseExpired(task.lease, now)
    ) {
      leftRunning += 1;
      continue;
    }
    changed = true;
    task.updatedAt = at;
    task.lease = null;
    task.retryAt = null;
    task.heartbeatAt = null;
    if (hasSideEffectTools(task)) {
      task.status = 'uncertain';
      task.completedAt = at;
      task.errorCode = 'recovery_uncertain_side_effects';
      task.lastErrorCode = 'recovery_uncertain_side_effects';
      task.requiresReview = true;
      task.result = normalizeWorkerResult({
        status: 'uncertain',
        summary: '',
        errorCode: 'recovery_uncertain_side_effects',
        runId: task.runId || null,
        finishedAt: at,
      });
      uncertain += 1;
      uncertainTaskIds.push(task.taskId);
    } else {
      task.status = 'queued';
      task.recoveredAt = at;
      task.lastErrorCode = 'recovered_after_restart';
      task.errorCode = null;
      task.requiresReview = false;
      recovered += 1;
      taskIds.push(task.taskId);
    }
  }
  if (changed) saveTasks();
  return {
    recovered,
    uncertain,
    leftRunning,
    taskIds,
    uncertainTaskIds,
    queued: Object.values(state.tasks).filter(task => task.status === 'queued').length,
  };
}

// 给 Watchdog / 运维读取的稳定健康快照：只有计数与时间点，不含任务正文。
function healthSnapshot(now = Date.now()) {
  const state = loadTasks();
  const counts = {
    queued: 0,
    accepted: 0,
    running: 0,
    waitingApproval: 0,
    terminal: 0,
    uncertain: 0,
  };
  let expiredLeases = 0;
  let retryScheduled = 0;
  let oldestQueuedAt = null;
  for (const task of Object.values(state.tasks)) {
    if (task.status === 'waiting_approval') counts.waitingApproval += 1;
    else if (task.status === 'uncertain') counts.uncertain += 1;
    else if (stateMachine.isTerminal(task.status)) counts.terminal += 1;
    else if (task.status === 'queued') {
      counts.queued += 1;
      if (!oldestQueuedAt || String(task.createdAt) < oldestQueuedAt) {
        oldestQueuedAt = task.createdAt || null;
      }
      if (task.retryAt && Date.parse(task.retryAt) > now) retryScheduled += 1;
    } else if (task.status === 'accepted') counts.accepted += 1;
    else if (task.status === 'running') counts.running += 1;

    if (
      (task.status === 'accepted' || task.status === 'running') &&
      leaseExpired(task.lease, now)
    ) {
      expiredLeases += 1;
    }
  }
  return {
    schemaVersion: TASK_SCHEMA_VERSION,
    counts,
    oldestQueuedAt,
    retryScheduled,
    expiredLeases,
    checkedAt: new Date(now).toISOString(),
  };
}

// 队列顺序：优先级（high → normal → low）优先，同级按创建时间，最后用 taskId
// 兜底。尚未到 retryAt 的任务暂不出队，避免失败后立即重试形成风暴。
function nextQueuedTask(now = Date.now()) {
  const current = loadTasks();
  return (
    Object.values(current.tasks)
      .filter(task => task.status === 'queued' && task.cancelRequested !== true)
      .filter(task => !task.retryAt || Date.parse(task.retryAt) <= now)
      .sort((a, b) => {
        const byPriority = priorityRank(a.priority) - priorityRank(b.priority);
        if (byPriority !== 0) return byPriority;
        const byCreated = String(a.createdAt).localeCompare(String(b.createdAt));
        if (byCreated !== 0) return byCreated;
        return String(a.taskId).localeCompare(String(b.taskId));
      })[0] || null
  );
}

function queuedCount() {
  return Object.values(loadTasks().tasks).filter(
    task => task.status === 'queued' && task.cancelRequested !== true
  ).length;
}

function reloadForTests() {
  taskCache = null;
  eventCache = null;
  outboxCache = null;
}

module.exports = {
  TASKS_FILE,
  EVENTS_FILE,
  OUTBOX_FILE,
  OUTBOX_MAX,
  STATUSES,
  CONTRACT_VERSION,
  PRIORITIES,
  SIDE_EFFECT_TOOLS,
  TASK_SCHEMA_VERSION,
  createTask,
  getTask,
  getRawTask,
  listTasks,
  updateTask,
  appendEvent,
  listEvents,
  flushEventOutbox,
  safePayload,
  isTerminalStatus,
  allTasks,
  nextQueuedTask,
  queuedCount,
  recoverInterrupted,
  findByIdempotencyKey,
  priorityRank,
  acquireLease,
  renewLease,
  releaseLease,
  leaseExpired,
  recordRunStart,
  recordRunFinish,
  recordCheckpoint,
  setRetry,
  healthSnapshot,
  reloadForTests,
};
