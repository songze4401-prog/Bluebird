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

const DATA_DIR = process.env.BLUEBIRD_DATA_DIR
  ? path.resolve(process.env.BLUEBIRD_DATA_DIR)
  : path.join(__dirname, '..', 'data');
const AGENTS_DIR = path.join(DATA_DIR, 'agents');
const TASKS_FILE = path.join(AGENTS_DIR, 'agent-tasks.json');
const EVENTS_FILE = path.join(AGENTS_DIR, 'agent-events.json');
const SCHEMA_VERSION = 1;
const TASK_MAX = 500;
const EVENT_MAX = 3000;
const GOAL_MAX = 2000;
const CONTEXT_MAX = 8000;
const RESULT_SUMMARY_MAX = 8000;

const STATUSES = Object.freeze([
  'queued',
  'accepted',
  'running',
  'waiting_approval',
  'completed',
  'failed',
  'cancelled',
  'timed_out',
]);
const TERMINAL = new Set(['completed', 'failed', 'cancelled', 'timed_out']);

const EVENT_TYPES = Object.freeze([
  'task.created',
  'task.accepted',
  'task.recovered',
  'task.started',
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
  'task.failed',
  'task.cancelled',
  'task.timed_out',
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
  'pending',
]);

let taskCache = null;
let eventCache = null;

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
  return { version: SCHEMA_VERSION, tasks: {} };
}
function emptyEvents() {
  return { version: SCHEMA_VERSION, events: [] };
}

function loadTasks() {
  if (taskCache) return taskCache;
  ensureDir();
  const parsed = readJson(TASKS_FILE, 'agent_tasks_corrupted');
  if (!parsed) {
    taskCache = emptyTasks();
    return taskCache;
  }
  if (
    parsed.version !== SCHEMA_VERSION ||
    !parsed.tasks ||
    typeof parsed.tasks !== 'object' ||
    Array.isArray(parsed.tasks)
  ) {
    throw new AgentError('agent_tasks_corrupted', 'Bot 任务存储结构无效', 500);
  }
  taskCache = parsed;
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
  if (parsed.version !== SCHEMA_VERSION || !Array.isArray(parsed.events)) {
    throw new AgentError('agent_events_corrupted', 'Bot 事件存储结构无效', 500);
  }
  eventCache = parsed;
  return eventCache;
}

function saveTasks() {
  ensureDir();
  writeFileAtomicSync(TASKS_FILE, JSON.stringify(taskCache, null, 2));
}
function saveEvents() {
  ensureDir();
  writeFileAtomicSync(EVENTS_FILE, JSON.stringify(eventCache, null, 2));
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
  events.events.push(event);
  if (events.events.length > EVENT_MAX) {
    events.events = events.events.slice(-EVENT_MAX);
  }
  saveEvents();
  return { ...event, payload: { ...event.payload } };
}

function listEvents(botId, { limit = 50 } = {}) {
  assertBot(botId);
  const events = loadEvents();
  const max = Math.min(Math.max(Number(limit) || 50, 1), 200);
  return events.events
    .filter(event => event.botId === botId)
    .slice(-max)
    .reverse()
    .map(event => ({ ...event, payload: { ...event.payload } }));
}

function publicTask(task, { includeResult = true } = {}) {
  if (!task) return null;
  return {
    taskId: task.taskId,
    botId: task.botId,
    taskType: task.taskType,
    goal: task.goal,
    sessionId: task.sessionId,
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

function createTask({
  botId,
  taskType,
  goal,
  context = '',
  sessionId = null,
  allowedTools = null,
  deadlineMs = 60000,
} = {}) {
  assertBot(botId);
  const manifest = getManifest(botId);
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
    typeof sessionId === 'string' && sessionId.trim() ? sessionId.trim() : null;
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

  const tasks = loadTasks();
  if (Object.keys(tasks.tasks).length >= TASK_MAX) {
    const oldest = Object.values(tasks.tasks)
      .sort((a, b) => String(a.createdAt).localeCompare(String(b.createdAt)))
      .slice(0, 50)
      .map(item => item.taskId);
    for (const id of oldest) delete tasks.tasks[id];
  }

  const t = nowIso();
  const task = {
    taskId: `task_${crypto.randomUUID()}`,
    botId,
    taskType,
    goal: cleanGoal,
    context: cleanContext,
    sessionId: cleanSession,
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
  saveTasks();
  appendEvent({
    botId,
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

function listTasks(botId, { limit = 20 } = {}) {
  assertBot(botId);
  const tasks = loadTasks();
  const max = Math.min(Math.max(Number(limit) || 20, 1), 100);
  return Object.values(tasks.tasks)
    .filter(task => task.botId === botId)
    .sort((a, b) => String(b.createdAt).localeCompare(String(a.createdAt)))
    .slice(0, max)
    .map(task => publicTask(task));
}

function updateTask(taskId, patch = {}) {
  const tasks = loadTasks();
  const task = tasks.tasks[String(taskId || '')];
  if (!task) throw new AgentError('task_not_found', '任务不存在', 404);

  if (patch.status !== undefined) {
    if (!STATUSES.includes(patch.status)) {
      throw new AgentError('invalid_task_status', '任务状态无效');
    }
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
  if (patch.result !== undefined) {
    if (!patch.result || typeof patch.result !== 'object') {
      throw new AgentError('invalid_task_result', '任务结果必须是对象');
    }
    const result = patch.result;
    task.result = {
      summary:
        typeof result.summary === 'string'
          ? result.summary.slice(0, RESULT_SUMMARY_MAX)
          : '',
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

function nextQueuedTask() {
  const current = loadTasks();
  return (
    Object.values(current.tasks)
      .filter(task => task.status === 'queued' && task.cancelRequested !== true)
      .sort((a, b) => String(a.createdAt).localeCompare(String(b.createdAt)))[0] ||
    null
  );
}

function queuedCount() {
  return Object.values(loadTasks().tasks).filter(
    task => task.status === 'queued' && task.cancelRequested !== true
  ).length;
}

// 进程重启恢复：crash 时停在 accepted/running 的任务重新入队；
// waiting_approval 不自动执行，交给人工审批。
function recoverInterrupted() {
  const current = loadTasks();
  const now = nowIso();
  let recovered = 0;
  const taskIds = [];
  for (const task of Object.values(current.tasks)) {
    if (task.status === 'accepted' || task.status === 'running') {
      task.status = 'queued';
      task.recoveredAt = now;
      task.updatedAt = now;
      recovered += 1;
      taskIds.push(task.taskId);
    }
  }
  if (recovered) saveTasks();
  return { recovered, taskIds, queued: queuedCount() };
}

function reloadForTests() {
  taskCache = null;
  eventCache = null;
}

module.exports = {
  TASKS_FILE,
  EVENTS_FILE,
  STATUSES,
  createTask,
  getTask,
  getRawTask,
  listTasks,
  updateTask,
  appendEvent,
  listEvents,
  safePayload,
  isTerminalStatus,
  nextQueuedTask,
  queuedCount,
  recoverInterrupted,
  reloadForTests,
};
