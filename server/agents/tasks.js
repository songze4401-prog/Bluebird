/* global module, __dirname */
/**
 * Bot 任务与事件存储。
 *
 * - 任务保存目标、状态与结构化结果；事件只允许安全标量字段，
 *   绝不记录 Prompt、Key、记忆正文或模型推理。
 * - 任务状态的唯一事实来源是 task-store 的持久化记录（见 task-store.js）；
 *   事件只是通知/审计通道，不拥有状态权威，客户端不得自行编造进度。
 * - 状态只有一个写入入口：transitionTask（迁移校验 + 与其余字段同一次落盘）。
 *   updateTask 只写非状态字段，收到 status 会显式拒绝，避免出现第二条写入路径。
 */
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { writeFileAtomicSync } = require('../atomic-write');
const { getManifest, isKnownBot } = require('./manifest');
const { AgentError, conflictError, budgetExceededError } = require('./errors');
const taskStore = require('./task-store');
const stateMachine = require('./state-machine');
const artifactStore = require('./artifact-store');
const { normalizeWorkerResult } = require('./worker-result');
const dependencies = require('./dependencies');
const agentLimits = require('./agent-limits');
const { LEGACY_ALIASES } = require('./status-vocabulary');
const approvalDeadline = require('./approval-deadline');
const crashHook = require('./crash-hook');

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
// S9：契约版本唯一定义在 contract.js，避免多处常量漂移。
const { CONTRACT_VERSION } = require('./contract');
const CONTEXT_REF_MAX = 200;
const IDEMPOTENCY_KEY_MAX = 120;
// 事件幂等键上限：与任务 idempotencyKey 同口径，便于调用方复用同一个业务键。
const EVENT_DEDUPE_KEY_MAX = 120;
const PRIORITIES = Object.freeze(['high', 'normal', 'low']);
const PRIORITY_RANK = Object.freeze({ high: 0, normal: 1, low: 2 });
// B-06（§25）：Task 级 Token 硬上限的边界与缺省值。
// A 类常量：12000 是服务端缺省上限，仅用于「调用方未显式给 budget」的内部/旧调用，
// 不是供应商真实配额，必须随后续真实 usage 数据校准；显式 budget 仍必须自带 tokenBudget。
const DEFAULT_TASK_TOKEN_BUDGET = 12000;
const TOKEN_BUDGET_MIN = 1;
const TOKEN_BUDGET_MAX = 500000;
// 父链最多回溯 8 层：超过视为异常数据，fail-closed 而不是继续放行。
const BUDGET_CHAIN_MAX_DEPTH = 8;

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
  'worker.scope_read',
  'worker.scope_denied',
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
  'approval.escalated',
  'approval.overdue',
  'approval.resolved',
  // §29 提醒 / 取消两条完整路径的审计事件（只记状态与来源，不记正文）。
  'approval.reminded',
  'approval.cancelled',
  // A-08：申诉的发起与裁决（原裁决保留在记录内，事件只记结果与理由摘要）。
  'approval.appealed',
  // Phase 3 第 1 项：验证闭环的审计事件（只记录裁决与引用，不记录正文）。
  'verification.review_opened',
  'verification.verdict',
  'verification.rejected',
  'verification.conflict',
  'verification.approval_requested',
  'task.dead_letter',
  'task.dead_letter_redelivered',
  'task.completed',
  'task.delivery',
  'task.failed',
  'task.dependency_failed',
  'task.cancelled',
  'task.timed_out',
  'task.uncertain',
  // §24.3 第 5 条：非法迁移被拒绝时留审计（只记 from/to 与拒绝原因，不改状态）。
  'task.transition_rejected',
  // §27：trustLevel 只允许 Verification Engine 写入产物记录；任务写入路径拒绝并留痕。
  'task.trust_level_write_rejected',
  // §16：provenanceRefs / taintLabels 只允许创建时继承或被验证路径改写；
  // 任务写入路径（updateTask / transitionTask）拒绝并留痕。
  'task.taint_write_rejected',
  // §16：跨 Agent 读取自动追加来源引用 / 读取工具返回追加污点标签（只追加不覆盖）。
  'task.provenance_appended',
  // §16：Gateway 每次工具调用的污点策略判定（含 policyVersion 与 ruleId）。
  'tool.policy_decision',
  // §26 第 4 项：重规划被风暴判据收口成终态时留痕（只记规则名、计数与计划摘要）。
  'replan.storm_denied',
  // §20 第 349 步 / FM-4：代次签发、写入资格被拒、资格撤销（只记 id、代次与短码）。
  'plan.fencing_issued',
  'plan.fencing_denied',
  'plan.fencing_revoked',
  // P5-D / §17 FM-2：必需约束从已验证引用重建成功（只记键名与引用 id，不记正文）。
  'handoff.context_rebuilt',
  // P5-D / §17 FM-6：重试耗尽且无可交付部分结果时请求决策（只记计数与短码）。
  'task.decision_requested',
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
  'detail',
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
  'policyVersion',
  'ruleId',
  'added',
  // Phase 1 交付物 1：编排轨迹以扁平标量写入既有事件（嵌套对象不入白名单），
  // 与 task.route.orchestration 同源，不新建审计存储。
  'orchestrationEntry',
  'orchestrationBasis',
  'orchestrationIntentDigest',
  'orchestrationCapability',
  'orchestrationTaskType',
  'orchestrationMatchingRule',
  'orchestrationMatchedAgents',
  'orchestrationRegisteredAgents',
  // Phase 1 交付物 2：容量感知择一的轨迹（容量口径来自 decideInternal.atCapacity）。
  'orchestrationCapacityRule',
  'orchestrationPriorityRule',
  'orchestrationCandidateOrder',
  'orchestrationSaturated',
  'orchestrationAllocation',
  'orchestrationSelected',
  'orchestrationExcluded',
  // Phase 1 验收「Worker Session 隔离」：跨作用域读取的审计字段
  // （targetType/targetId 标明被访问对象，access 区分放行/拒绝）。
  'targetType',
  'targetId',
  'requesterTaskId',
  'access',
  'grantedBy',
  'reason',
  'round',
  'phase',
  'attempts',
  'leaseOwner',
  'retryAt',
  // Phase 1 交付物 2（依赖管理）：依赖失败收敛轨迹。neverStarted 明确写
  // 「该任务从未进入 running」，避免把 accepted 误读成真的执行过。
  'neverStarted',
  'blockedBy',
  'dependencyTaskId',
  // Phase 3 第 1 项：验证闭环只落扁平标量（审校任务 id、被审产物引用与裁决码）。
  'verdict',
  'reviewTaskId',
  'producerTaskId',
  'artifactId',
  'version',
  'deterministicOk',
  'conflict',
  'approvalId',
  'riskLevel',
  'checkCode',
  'attempts',
  'maxAttempts',
  'redeliveredTaskId',
  // §24.3 第 5 条：非法迁移审计只落扁平标量（from/to 与拒绝原因）。
  'fromStatus',
  'toStatus',
  // §27：越权写入 trustLevel 的审计字段（字段名 + 拒绝来源）。
  'field',
  // A-10 / §17：九类失败模式的分类标签，随既有失败/恢复/升级事件一起落审计。
  'failureMode',
  // §26：限流与风暴判定落审计时需要的扁平标量（规则名、计数、摘要与退避时长），
  // 全部是非正文量；不加进白名单就会被隐私过滤静默丢掉，事件只剩个空壳。
  // 注意 `safePayload` 只收 null/boolean/string/number，数组与对象一律丢弃——
  // 所以列表类字段必须先用逗号拼成字符串（与路由事件的 orchestration* 同一口径）。
  'rule',
  'rulesHit',
  'replanCount',
  'retryAfterMs',
  'planDigest',
  // FM-4：代次判定的原料全是扁平标量（计划指针 + 持有/当前代次）。
  // 不加进白名单就会被 safePayload 静默丢掉，事件只剩一个空壳。
  'planId',
  'planVersion',
  'generation',
  'heldGeneration',
  'currentGeneration',
  // P5-D / §17 FM：失败模式命名化的事件标量（全部扁平，数组先 join 成字符串）。
  // FM-3：委派权限放大被拒（只记父任务 id 与越界工具名，不记参数正文）。
  'security',
  'parentTaskId',
  'escalatedTools',
  // FM-2：必需约束缺失/重建审计（只记键名列表与引用 id，不记正文）。
  'requiredKeys',
  'missingKeys',
  'rebuilt',
  'rebuiltFrom',
  // FM-6：部分结果交付与请求决策（只记计数、产物 id 列表与短码）。
  'partial',
  'partialCount',
  'partialArtifactIds',
  'decisionRequested',
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
  // S5 读边界：旧记录里的 uncertain 在内存中映射为 recovery，
  // 不回写文件（migrate 不批量改写，原文件字节保持不变）。
  applyLegacyStatusAliases(taskCache);
  return taskCache;
}

function applyLegacyStatusAliases(state) {
  for (const task of Object.values(state.tasks || {})) {
    if (!task) continue;
    const aliasedStatus = LEGACY_ALIASES[task.status];
    if (aliasedStatus) task.status = aliasedStatus;
    if (task.result) {
      const aliasedResultStatus = LEGACY_ALIASES[task.result.status];
      if (aliasedResultStatus) task.result.status = aliasedResultStatus;
    }
  }
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

function assertEventDedupeKey(value) {
  if (typeof value !== 'string') {
    throw new AgentError('invalid_event_dedupe_key', '事件幂等键必须是字符串');
  }
  const key = value.trim();
  if (!key || key.length > EVENT_DEDUPE_KEY_MAX) {
    throw new AgentError('invalid_event_dedupe_key', `事件幂等键为空或超过 ${EVENT_DEDUPE_KEY_MAX} 字符`);
  }
  return key;
}

// 幂等键 → 确定性 eventId：同一 (botId, dedupeKey) 永远落到同一个事件槽位。
// 重放/重启/重复投递只会命中既有槽位，不会再产生第二行事件。
function eventIdForDedupeKey(botId, dedupeKey) {
  return `evt_${crypto
    .createHash('sha256')
    .update(`${botId}\u0000${dedupeKey}`)
    .digest('hex')
    .slice(0, 32)}`;
}

// 事件可能停在主事件文件或 outbox 任一处（崩溃窗口里只在前者或只在后者）。
function findEventById(eventId) {
  const hit = loadEvents().events.find(item => item.eventId === eventId);
  if (hit) return { event: hit, store: 'events' };
  const queued = loadOutbox().events.find(item => item.eventId === eventId);
  if (queued) return { event: queued, store: 'outbox' };
  return null;
}

// 去重不是静默丢弃：命中槽位后在原记录上累加 dedupeCount/lastDedupedAt，
// 审计能看出「这条事件被重复投递过几次」，而事件行数仍然只有一行。
function markEventDeduped(found, now) {
  const event = found.event;
  event.dedupeCount = (Number(event.dedupeCount) || 0) + 1;
  event.lastDedupedAt = now;
  try {
    if (found.store === 'events') saveEvents();
    else saveOutbox();
  } catch (_) {
    // 计数落盘失败不影响「只生效一次」的结论：事件行已经在唯一槽位里。
  }
  return { ...event, payload: { ...event.payload }, deduped: true };
}

function appendEvent({
  botId,
  taskId = null,
  runId = null,
  sessionId = null,
  eventType,
  payload = {},
  correlationId = null,
  dedupeKey = null,
}) {
  assertBot(botId);
  if (!EVENT_TYPES.includes(eventType)) {
    throw new AgentError('invalid_event', '事件类型无效');
  }
  const now = nowIso();
  const key = dedupeKey === null || dedupeKey === undefined
    ? null
    : assertEventDedupeKey(dedupeKey);
  const eventId = key ? eventIdForDedupeKey(botId, key) : `evt_${crypto.randomUUID()}`;
  if (key) {
    const found = findEventById(eventId);
    if (found) return markEventDeduped(found, now);
  }
  const events = loadEvents();
  const event = {
    eventId,
    ...(key ? { dedupeKey: key } : {}),
    dedupeCount: 0,
    taskId,
    runId,
    botId,
    sessionId,
    timestamp: now,
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
  // 崩溃窗口：outbox 已落盘、主事件文件尚未写入。此处被杀后，重启的
  // flushEventOutbox 会按 eventId 补写一次，不丢也不重。
  crashHook.hold('event.after-outbox-save');

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

/**
 * A-10 / §17：事件乱序 / 重复投递检测（只读，不改事件历史）。
 * - duplicate_delivery：同一 dedupeKey 被重复投递（appendEvent 只累加 dedupeCount）；
 * - timestamp_regression：同一 task 的事件在文件顺序上出现时间倒序。
 * 返回 [{ taskId, reason, eventId }]，由启动恢复流程消费。
 */
function detectEventOrderViolations({ botId = null } = {}) {
  let events = [];
  try {
    events = loadEvents().events || [];
  } catch (_) {
    events = [];
  }
  const violations = [];
  const lastTimestampByTask = new Map();
  for (const event of events) {
    if (!event || typeof event.taskId !== 'string' || !event.taskId) continue;
    if (botId && event.botId !== botId) continue;
    if (Number.isInteger(event.dedupeCount) && event.dedupeCount > 0) {
      violations.push({
        taskId: event.taskId,
        reason: 'duplicate_delivery',
        eventId: event.eventId,
      });
      continue;
    }
    const timestamp = Date.parse(event.timestamp);
    const previous = lastTimestampByTask.get(event.taskId);
    if (Number.isFinite(timestamp) && Number.isFinite(previous) && timestamp < previous) {
      violations.push({
        taskId: event.taskId,
        reason: 'timestamp_regression',
        eventId: event.eventId,
      });
    }
    if (Number.isFinite(timestamp)) lastTimestampByTask.set(event.taskId, timestamp);
  }
  return violations;
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
    parentUserId: task.parentUserId || null,
    priority: task.priority || 'normal',
    contextRef: task.contextRef || null,
    // FM-2：必需约束键名（只读）。null 表示委派方未声明必需约束。
    requiredContextKeys: Array.isArray(task.requiredContextKeys)
      ? [...task.requiredContextKeys]
      : null,
    idempotencyKey: task.idempotencyKey || null,
    route: task.route ? clone(task.route) : null,
    budget: task.budget ? clone(task.budget) : null,
    // B-06：Token 计量的只读视图（limit 在 budget.tokenBudget 内）。
    tokenUsage: task.tokenUsage
      ? { reserved: task.tokenUsage.reserved || 0, used: task.tokenUsage.used || 0 }
      : { reserved: 0, used: 0 },
    parentTaskId: task.parentTaskId || null,
    budgetRunId: task.budgetRunId || null,
    // Phase 1 交付物 2：依赖边（只读）。空数组表示无依赖，保持快速路径。
    dependsOn: Array.isArray(task.dependsOn) ? [...task.dependsOn] : [],
    // S8：计划版本指针。仅在 Workflow Engine 创建/重规划计划时由引擎写入；
    // 未接入 Workflow Store 时保持 null，绝不返回占位版本（0 也视为未写入）。
    planId: task.planId || null,
    planVersion:
      Number.isInteger(task.planVersion) && task.planVersion > 0
        ? task.planVersion
        : null,
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
    // ② CAS：对外只读的当前版本，调用方写入时据此传 expectedVersion。
    stateVersion: Number.isInteger(task.stateVersion) ? task.stateVersion : 0,
    runs: Array.isArray(task.runs) ? clone(task.runs) : [],
    requiresReview: task.requiresReview === true,
    // §16：来源引用与污点标签（只读）。旧记录缺字段读作 unknown，绝不默认"干净"。
    provenanceRefs: Array.isArray(task.provenanceRefs)
      ? task.provenanceRefs.map(item => ({ ...item }))
      : [],
    taintLabels: artifactStore.readTaintLabels(task),
    taintPolicyVersion: task.taintPolicyVersion || null,
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
  if (budget === null || budget === undefined) {
    // B-06：Token 上限是 Task 的强制字段。调用方完全不给 budget 时，服务端补一份
    // 默认硬上限（含默认次数上限），落库任务不存在「无上限」状态；
    // 若显式给了 budget 却缺 tokenBudget，则拒绝创建（validation_failed）。
    return {
      maxRounds: 3,
      maxToolCalls: 6,
      maxReadOnlyRetries: 1,
      generatePlan: false,
      tokenBudget: DEFAULT_TASK_TOKEN_BUDGET,
    };
  }
  if (typeof budget !== 'object' || Array.isArray(budget)) {
    throw new AgentError('invalid_task', 'budget 必须是对象或 null');
  }
  const maxRounds = Number(budget.maxRounds);
  const maxToolCalls = Number(budget.maxToolCalls);
  const maxReadOnlyRetries = Number(budget.maxReadOnlyRetries);
  const tokenBudget = Number(budget.tokenBudget);
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
  // 显式 budget 必须自带 Token 上限；上限缺失即拒绝创建，不允许“无上限”任务。
  if (
    !Number.isInteger(tokenBudget) ||
    tokenBudget < TOKEN_BUDGET_MIN ||
    tokenBudget > TOKEN_BUDGET_MAX
  ) {
    throw new AgentError(
      'validation_failed',
      `budget.tokenBudget 必填，且必须是 ${TOKEN_BUDGET_MIN} 到 ${TOKEN_BUDGET_MAX} 的整数`,
      400
    );
  }
  return {
    maxRounds,
    maxToolCalls,
    maxReadOnlyRetries,
    generatePlan: budget.generatePlan === true,
    tokenBudget,
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
    // Phase 1 交付物 1：编排轨迹（候选集 + 匹配依据 + 最终选择）随任务落库，
    // 不新建第二套审计存储；最终选择的执行主体仍是 task.agentId/botId。
    orchestration:
      route.orchestration &&
      typeof route.orchestration === 'object' &&
      !Array.isArray(route.orchestration)
        ? {
            entry: String(route.orchestration.entry || '').slice(0, 40),
            version: Number.isInteger(route.orchestration.version)
              ? route.orchestration.version
              : 1,
            intentDigest: String(route.orchestration.intentDigest || '').slice(0, 80),
            capability: String(route.orchestration.capability || '').slice(0, 80),
            taskType: String(route.orchestration.taskType || '').slice(0, 80),
            basis: String(route.orchestration.basis || '').slice(0, 40),
            matchingRule: String(route.orchestration.matchingRule || '').slice(0, 80),
            registeredAgents: Number.isInteger(route.orchestration.registeredAgents)
              ? route.orchestration.registeredAgents
              : 0,
            matchedAgentIds: Array.isArray(route.orchestration.matchedAgentIds)
              ? route.orchestration.matchedAgentIds.slice(0, 10).map(String)
              : [],
            requestedAgentId: route.orchestration.requestedAgentId
              ? String(route.orchestration.requestedAgentId).slice(0, 80)
              : null,
            // 交付物 2：容量感知择一的轨迹；capacityRule 说明容量口径来源
            // （decideInternal.atCapacity），excludedReasons 说明其余候选为何未被选中。
            capacityRule: route.orchestration.capacityRule
              ? String(route.orchestration.capacityRule).slice(0, 80)
              : null,
            priorityRule: route.orchestration.priorityRule
              ? String(route.orchestration.priorityRule).slice(0, 80)
              : null,
            candidateOrder: Array.isArray(route.orchestration.candidateOrder)
              ? route.orchestration.candidateOrder.slice(0, 10).map(item => String(item).slice(0, 80))
              : [],
            saturatedAgentIds: Array.isArray(route.orchestration.saturatedAgentIds)
              ? route.orchestration.saturatedAgentIds.slice(0, 10).map(item => String(item).slice(0, 80))
              : [],
            allocation: route.orchestration.allocation
              ? String(route.orchestration.allocation).slice(0, 40)
              : null,
            selectedAgentId: route.orchestration.selectedAgentId
              ? String(route.orchestration.selectedAgentId).slice(0, 80)
              : null,
            excludedReasons: route.orchestration.excludedReasons
              ? String(route.orchestration.excludedReasons).slice(0, 200)
              : '',
          }
        : null,
  };
}

// ---- B-06：Token 预算账本（Task / 父链 / Run） ----
// 所有读写都复用 task-store 的单写者与 task.stateVersion；预留在一次同步调用内
// 完成「全部闸门校验 → 改内存 → write()」，不存在 check 与 write 之间的 await 缝隙。

function ensureTokenRuns(store) {
  if (
    !store.tokenRuns ||
    typeof store.tokenRuns !== 'object' ||
    Array.isArray(store.tokenRuns)
  ) {
    store.tokenRuns = {};
  }
  return store.tokenRuns;
}

function tokenLimitOf(task) {
  const limit = task && task.budget ? Number(task.budget.tokenBudget) : NaN;
  return Number.isInteger(limit) && limit >= TOKEN_BUDGET_MIN ? limit : null;
}

function usageOf(task) {
  if (!task.tokenUsage || typeof task.tokenUsage !== 'object') {
    task.tokenUsage = { reserved: 0, used: 0 };
  }
  const usage = task.tokenUsage;
  if (!Number.isInteger(usage.reserved) || usage.reserved < 0) usage.reserved = 0;
  if (!Number.isInteger(usage.used) || usage.used < 0) usage.used = 0;
  return usage;
}

// 父链：自己 + 所有祖先。父任务余额是子任务上限的硬上界；缺口径一律 fail-closed。
function budgetChain(tasks, task) {
  const chain = [task];
  const seen = new Set([task.taskId]);
  let cursor = task;
  for (let depth = 0; depth < BUDGET_CHAIN_MAX_DEPTH; depth += 1) {
    const parentId = cursor.parentTaskId;
    if (!parentId) return chain;
    if (seen.has(parentId)) {
      throw new AgentError('budget_chain_cycle', 'Token 预算父链存在环', 500);
    }
    const parent = tasks.tasks[parentId];
    if (!parent) {
      throw new AgentError('budget_parent_missing', 'Token 预算父任务不存在', 409);
    }
    seen.add(parentId);
    chain.push(parent);
    cursor = parent;
  }
  if (cursor.parentTaskId) {
    throw new AgentError('budget_chain_too_deep', 'Token 预算父链超过 8 层', 409);
  }
  return chain;
}

function budgetSnapshot(task) {
  const limit = tokenLimitOf(task);
  const usage = usageOf(task);
  return {
    taskId: task.taskId,
    limit,
    used: usage.used,
    reserved: usage.reserved,
    remaining: limit === null ? null : limit - usage.used - usage.reserved,
    runId: task.budgetRunId || null,
  };
}

function getTaskBudgetSnapshot(taskId) {
  const tasks = loadTasks();
  const task = tasks.tasks[String(taskId || '')];
  if (!task) throw new AgentError('task_not_found', '任务不存在', 404);
  return budgetSnapshot(task);
}

function requireTokenAmount(amount, label) {
  const value = Number(amount);
  if (!Number.isInteger(value) || value <= 0) {
    throw new AgentError('validation_failed', `${label} 必须是正整数`, 400);
  }
  return value;
}

/**
 * 原子预留：Task 自身、全部祖先、所属 Run 三处同时校验并同时占用额度。
 * 任一闸门不足 → budget_exceeded（retryable=false），且**不修改任何内存/磁盘状态**。
 */
function reserveTaskBudget(taskId, { amount } = {}) {
  const tasks = loadTasks();
  const task = tasks.tasks[String(taskId || '')];
  if (!task) throw new AgentError('task_not_found', '任务不存在', 404);
  const cleanAmount = requireTokenAmount(amount, '预留 token');
  const chain = budgetChain(tasks, task);
  const runId = task.budgetRunId || null;

  for (const item of chain) {
    const limit = tokenLimitOf(item);
    if (limit === null) {
      throw budgetExceededError({
        taskId: task.taskId,
        scope: item === task ? 'task' : `parent:${item.taskId}`,
        required: cleanAmount,
        remaining: 0,
        runId,
        causeRef: 'budget_not_configured',
      });
    }
    const usage = usageOf(item);
    const remaining = limit - usage.used - usage.reserved;
    if (remaining < cleanAmount) {
      throw budgetExceededError({
        taskId: task.taskId,
        scope: item === task ? 'task' : `parent:${item.taskId}`,
        required: cleanAmount,
        remaining: Math.max(0, remaining),
        runId,
      });
    }
  }

  const run = runId ? ensureTokenRuns(tasks)[runId] || null : null;
  if (run) {
    const remaining = run.budget - run.used - run.reserved;
    if (remaining < cleanAmount) {
      throw budgetExceededError({
        taskId: task.taskId,
        scope: `run:${runId}`,
        required: cleanAmount,
        remaining: Math.max(0, remaining),
        runId,
      });
    }
  }

  const stamp = nowIso();
  for (const item of chain) {
    usageOf(item).reserved += cleanAmount;
    bumpStateVersion(item);
    item.updatedAt = stamp;
  }
  if (run) {
    run.reserved += cleanAmount;
    run.updatedAt = stamp;
  }
  saveTasks();
  return budgetSnapshot(task);
}

/**
 * 结算：按真实用量扣减，并释放本次预留；差额（预留多、实际少）自动回冲。
 * reserved 必须是本次 reserve 的金额；actual 可为 0（失败/取消时由 release 调用）。
 */
function settleTaskBudget(taskId, { reserved = 0, actual = 0 } = {}) {
  const tasks = loadTasks();
  const task = tasks.tasks[String(taskId || '')];
  if (!task) throw new AgentError('task_not_found', '任务不存在', 404);
  const cleanReserved = Number(reserved);
  const cleanActual = Number(actual);
  if (!Number.isInteger(cleanReserved) || cleanReserved < 0) {
    throw new AgentError('validation_failed', 'reserved 必须是非负整数', 400);
  }
  if (!Number.isInteger(cleanActual) || cleanActual < 0) {
    throw new AgentError('validation_failed', 'actual 必须是非负整数', 400);
  }
  const chain = budgetChain(tasks, task);
  const runId = task.budgetRunId || null;
  const run = runId ? ensureTokenRuns(tasks)[runId] || null : null;

  const stamp = nowIso();
  for (const item of chain) {
    const usage = usageOf(item);
    usage.reserved = Math.max(0, usage.reserved - cleanReserved);
    usage.used += cleanActual;
    bumpStateVersion(item);
    item.updatedAt = stamp;
  }
  if (run) {
    run.reserved = Math.max(0, run.reserved - cleanReserved);
    run.used += cleanActual;
    run.updatedAt = stamp;
  }
  saveTasks();
  return budgetSnapshot(task);
}

/** 释放未结算的预留（失败/取消/未产生 usage）。 */
function releaseTaskBudget(taskId, { amount } = {}) {
  return settleTaskBudget(taskId, { reserved: requireTokenAmount(amount, '释放 token'), actual: 0 });
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
  // FM-2 交接上下文丢失（§17）：委派方声明的必需约束/决策键名。
  // 执行入口按 context（JSON 对象）与 contextRef（已验证产物）核对，缺失即阻断。
  requiredContextKeys = null,
  idempotencyKey = null,
  route = null,
  budget = null,
  parentSessionId = null,
  parentMessageId = null,
  parentUserText = null,
  parentUserId = null,
  planId = null,
  planVersion = null,
  // B-06：父子覆盖与 Run 总闸门。runId 是「预算归属 Run」，与执行期每次 attempt
  // 重写的 task.runId 不同口径，因此单独落 budgetRunId。
  parentTaskId = null,
  runId = null,
  runBudget = null,
  // Phase 1 交付物 2：依赖边。只允许指向**已存在**且同 agentId 的任务，
  // 上限 8；循环依赖只能由批量编排入口产生，那里会在落盘前整图校验。
  dependsOn = null,
  // §16：来源引用与污点标签。Task 上的这两类字段与 Artifact 同构；
  // 生产者只能追加/继承，不能清除（updateTask/transitionTask 会拒绝改写）。
  provenanceRefs = null,
  taintLabels = null,
  taintPolicyVersion = null,
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
  // FM-2：必需约束键名归一化（去重、去空白，单键上限 60 字，总数上限 12）。
  const cleanRequiredContextKeys = Array.isArray(requiredContextKeys)
    ? [
        ...new Set(
          requiredContextKeys
            .filter(key => typeof key === 'string' && key.trim())
            .map(key => key.trim().slice(0, 60))
        ),
      ]
    : null;
  if (cleanRequiredContextKeys && cleanRequiredContextKeys.length > 12) {
    throw new AgentError('invalid_task', 'requiredContextKeys 数量超限');
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
  // 委派任务的记忆归属用户：由服务端可信身份写入，Worker 侧据此按用户级读记忆。
  const cleanParentUserId =
    typeof parentUserId === 'string' && parentUserId.trim()
      ? parentUserId.trim().slice(0, 120)
      : null;
  const cleanDeadline = Number(deadlineMs);
  if (
    !Number.isInteger(cleanDeadline) ||
    cleanDeadline < 5000 ||
    cleanDeadline > 120000
  ) {
    throw new AgentError('invalid_task', 'deadlineMs 必须在 5000 到 120000 之间');
  }

  // §16：来源引用复用 {kind,id,version}；污点取"继承 ∪ 声明"，空集读作 unknown。
  let cleanProvenanceRefs;
  try {
    cleanProvenanceRefs = artifactStore.normalizeProvenanceRefs(provenanceRefs);
  } catch (error) {
    throw new AgentError('invalid_task', '任务 provenanceRefs 非法', 400, {
      reason: (error && error.code) || 'invalid',
    });
  }
  let declaredTaint;
  try {
    declaredTaint = artifactStore.normalizeTaintLabels(taintLabels, 'taintLabels');
  } catch (error) {
    throw new AgentError('invalid_task', '任务 taintLabels 非法', 400, {
      reason: (error && error.code) || 'invalid',
    });
  }
  const inheritedTaint = artifactStore.inheritedTaintOf(cleanProvenanceRefs);
  const mergedTaint = [...new Set([...inheritedTaint, ...declaredTaint])].sort();
  // 新任务未读取任何上游内容时是"无污点"（空集合），不是"未知"；
  // unknown 只用于旧数据缺字段与断裂引用（未知即最保守，见 readTaintLabels）。
  const cleanTaintLabels = mergedTaint;
  const cleanTaintPolicyVersion =
    typeof taintPolicyVersion === 'string' && taintPolicyVersion.trim()
      ? taintPolicyVersion.trim().slice(0, 60)
      : artifactStore.currentTaintPolicyVersion();

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
  const cleanParentTaskId =
    typeof parentTaskId === 'string' && parentTaskId.trim()
      ? parentTaskId.trim().slice(0, 120)
      : null;
  const cleanRunId =
    typeof runId === 'string' && runId.trim() ? runId.trim().slice(0, 80) : null;
  const cleanRunBudget = runBudget === null || runBudget === undefined ? null : Number(runBudget);
  if (
    cleanRunBudget !== null &&
    (!Number.isInteger(cleanRunBudget) ||
      cleanRunBudget < TOKEN_BUDGET_MIN ||
      cleanRunBudget > TOKEN_BUDGET_MAX)
  ) {
    throw new AgentError(
      'validation_failed',
      `runBudget 必须是 ${TOKEN_BUDGET_MIN} 到 ${TOKEN_BUDGET_MAX} 的整数`,
      400
    );
  }

  // 计划指针只接受「两个都在」或「两个都不在」：单边取值无法表达冻结版本，
  // 写入后只会变成无法解析的悬空引用（启动时会被收敛为 recovery）。
  const cleanPlanId = planId === null || planId === undefined ? null : planId;
  const cleanPlanVersion =
    planVersion === null || planVersion === undefined ? null : planVersion;
  if (cleanPlanId !== null || cleanPlanVersion !== null) {
    if (
      typeof cleanPlanId !== 'string' ||
      cleanPlanId.trim().length === 0 ||
      cleanPlanId.length > 80
    ) {
      throw new AgentError('invalid_task', 'planId 必须是 1 到 80 字的非空字符串');
    }
    if (!Number.isInteger(cleanPlanVersion) || cleanPlanVersion <= 0) {
      throw new AgentError('invalid_task', 'planVersion 必须是正整数');
    }
  }

  // 同一 Agent 的相同幂等键返回既有任务，不重复创建、不重复入队。
  // Router 在建立 Worker 会话之前也会先查一次，避免产生空会话。
  const existing = findByIdempotencyKey(resolvedAgentId, cleanIdempotencyKey);
  if (existing) return { ...existing, idempotent: true };

  const tasks = loadTasks();
  // 依赖边校验：必须在任何裁剪/落盘之前完成，失败时磁盘与内存都不变。
  const cleanDependsOn =
    dependsOn === null || dependsOn === undefined ? [] : dependencies.normalizeRefs(dependsOn);
  for (const depTaskId of cleanDependsOn) {
    const dep = tasks.tasks[depTaskId];
    if (!dep) {
      throw new AgentError('dependency_not_found', `依赖任务不存在：${depTaskId}`, 400);
    }
    if ((dep.agentId || dep.botId) !== resolvedAgentId) {
      throw new AgentError(
        'dependency_not_found',
        `依赖任务不属于同一 Agent：${depTaskId}`,
        400
      );
    }
  }
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

  // B-06 父子覆盖：父任务余额是子任务上限的硬上界；不够就拒绝创建。
  const parentTask = cleanParentTaskId ? tasks.tasks[cleanParentTaskId] : null;
  if (cleanParentTaskId && !parentTask) {
    throw new AgentError('validation_failed', 'parentTaskId 指向的任务不存在', 400);
  }
  // §25：委派深度最多 2 层；超限在创建入口拒绝，避免多建一层再回滚。
  if (parentTask) {
    agentLimits.assertDelegationAllowed(cleanParentTaskId, tasks.tasks);
  }
  // FM-3 委派链权限逐跳放大（§17）：子任务的权限必须落在父任务授权的交集内。
  // 父任务未显式声明 allowedTools（等于 Manifest 全量白名单）时不额外收窄；
  // 父任务收窄过而子任务声明了父任务没有的工具 → fail-closed 拒绝且零落盘
  //（此时任务尚未创建，安全事件由调用方（router/route 层）记 route.rejected）。
  if (parentTask && allowedTools !== null && Array.isArray(parentTask.allowedTools)) {
    const parentAuthorized = new Set(parentTask.allowedTools);
    const escalated = tools.filter(name => !parentAuthorized.has(name));
    if (escalated.length) {
      throw new AgentError(
        'delegation_permission_escalation',
        '子任务 allowedTools 超出父任务授权交集（§17 FM-3）',
        403,
        { parentTaskId: cleanParentTaskId, escalatedTools: escalated.join(',') }
      );
    }
  }
  // FM-3：父任务收窄过而子任务未声明 allowedTools 时，默认授权也必须落在
  // 父任务授权交集内——不能靠「不声明」拿到父任务没有的工具。收窄后为空
  // 表示该子任务不授权任何工具（fail-closed，不拒绝创建）。
  if (parentTask && allowedTools === null && Array.isArray(parentTask.allowedTools)) {
    const parentAuthorized = new Set(parentTask.allowedTools);
    tools = tools.filter(name => parentAuthorized.has(name));
  }
  const effectiveRunId =
    cleanRunId || (parentTask && parentTask.budgetRunId ? parentTask.budgetRunId : null);
  if (parentTask) {
    const parentLimit = tokenLimitOf(parentTask);
    if (parentLimit === null) {
      throw new AgentError('validation_failed', '父任务未配置 token 上限，不能接收子任务', 400);
    }
    const parentUsage = usageOf(parentTask);
    const parentRemaining = parentLimit - parentUsage.used - parentUsage.reserved;
    if (parentRemaining < cleanBudget.tokenBudget) {
      throw budgetExceededError({
        taskId: '',
        scope: `parent:${parentTask.taskId}`,
        required: cleanBudget.tokenBudget,
        remaining: Math.max(0, parentRemaining),
        runId: effectiveRunId,
      });
    }
  }

  // B-06 Run 级总闸门：同 Run 的预算只由首个任务建立；后续任务不能改写，
  // 且每个任务的 tokenBudget 在 reserve/settle 时都会累加到同一本账。
  if (effectiveRunId) {
    const runs = ensureTokenRuns(tasks);
    const existingRun = runs[effectiveRunId];
    if (!existingRun) {
      if (cleanRunBudget === null) {
        throw new AgentError(
          'validation_failed',
          'Run 首次创建必须提供 runBudget（Run 总预算）',
          400
        );
      }
      const stamp = nowIso();
      runs[effectiveRunId] = {
        runId: effectiveRunId,
        budget: cleanRunBudget,
        used: 0,
        reserved: 0,
        createdAt: stamp,
        updatedAt: stamp,
      };
    } else if (cleanRunBudget !== null && cleanRunBudget !== existingRun.budget) {
      throw new AgentError('validation_failed', 'runBudget 与既有 Run 预算不一致', 400);
    }
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
    requiredContextKeys: cleanRequiredContextKeys,
    idempotencyKey: cleanIdempotencyKey,
    route: cleanRoute,
    budget: cleanBudget,
    // S8：计划版本指针（Task Contract 新增可空字段）。由 Workflow Store 在任务
    // 创建之前落盘，router 在**同一次任务写入**里带上 planId + planVersion，
    // 因此不存在「任务先引用、计划后落盘」的窗口。null 表示该任务没有冻结计划。
    planId: cleanPlanId,
    planVersion: cleanPlanVersion,
    // B-06：预算归属与计量初值。reserved/used 只由 reserve/settle/release 改写。
    parentTaskId: cleanParentTaskId,
    budgetRunId: effectiveRunId,
    dependsOn: cleanDependsOn,
    tokenUsage: { reserved: 0, used: 0 },
    runId: null,
    runStartedAt: null,
    heartbeatAt: null,
    checkpoint: null,
    lease: null,
    retryAt: null,
    lastErrorCode: null,
    // checkpointVersion 是 checkpoint 序号（recordCheckpoint 每次 +1），
    // 不是 CAS/并发版本；CAS 版本是 stateVersion（创建时为 0，首次写入 +1）。
    checkpointVersion: 0,
    // ② CAS：任务记录的单调递增版本。只有存储层（本文件的写入路径）能分配，
    // 调用方只能通过 expectedVersion 声明“基于哪一版修改”。
    stateVersion: 0,
    runs: [],
    requiresReview: false,
    // §16：来源引用 + 污点并集；旧数据缺字段时由读取边界按 unknown 返回。
    provenanceRefs: cleanProvenanceRefs,
    taintLabels: cleanTaintLabels,
    taintPolicyVersion: cleanTaintPolicyVersion,
    parentSessionId: cleanParentSession,
    parentMessageId: cleanParentMessage,
    parentUserText: cleanParentUserText,
    parentUserId: cleanParentUserId,
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

// ② CAS：版本由存储层分配，调用方只读。每次真实落盘 +1，绝不信任写入方自报。
function bumpStateVersion(task) {
  task.stateVersion = (Number.isInteger(task.stateVersion) ? task.stateVersion : 0) + 1;
  return task.stateVersion;
}

// ② CAS：先校验后写。expectedVersion 为空（undefined/null）表示“旧调用方不带版本”，
// 保持既有可写行为；携带时必须与当前 stateVersion 严格相等，否则抛 conflict。
// 冲突发生在任何内存改动之前，因此内存与磁盘都不会被改动。
function assertExpectedVersion(task, expectedVersion) {
  if (expectedVersion === undefined || expectedVersion === null) return;
  const current = Number.isInteger(task.stateVersion) ? task.stateVersion : 0;
  if (expectedVersion !== current) {
    throw conflictError({
      taskId: task.taskId,
      expectedVersion,
      currentVersion: current,
      runId: task.runId || null,
      causeRef: task.taskId ? `task:${task.taskId}` : null,
    });
  }
}

// §27：trustLevel 是产物记录字段，唯一写入者是 Verification Engine；
// 任务写入路径（updateTask / transitionTask 及其调用点）一律拒绝，并留审计。
const TRUST_WRITE_FIELDS = Object.freeze(['trustLevel', 'trust']);

function rejectTrustWrite(task, field, source) {
  try {
    appendEvent({
      botId: task.botId,
      taskId: task.taskId,
      runId: task.runId || null,
      eventType: 'task.trust_level_write_rejected',
      payload: {
        status: task.status,
        field,
        reason: 'not_authorized',
        mode: source,
      },
    });
  } catch (_) {
    // 审计通道不可用时不改变拒绝结论。
  }
  throw new AgentError(
    'not_authorized',
    'trustLevel 只能由 Verification Engine 写入产物记录',
    403,
    { field, source }
  );
}

function assertNoTrustWrite(task, patch, source) {
  for (const field of TRUST_WRITE_FIELDS) {
    if (patch && patch[field] !== undefined) rejectTrustWrite(task, field, source);
  }
}

// §16：provenanceRefs / taintLabels 只能由创建时继承或验证路径改写；
// 任务更新路径不得追加/清除（尤其是"清除标签"必须被拒并留痕）。
const TAINT_WRITE_FIELDS = Object.freeze([
  'provenanceRefs',
  'taintLabels',
  'taintPolicyVersion',
]);

function rejectTaintWrite(task, field, source) {
  try {
    appendEvent({
      botId: task.botId,
      taskId: task.taskId,
      runId: task.runId || null,
      eventType: 'task.taint_write_rejected',
      payload: {
        status: task.status,
        field,
        reason: 'not_authorized',
        mode: source,
      },
    });
  } catch (_) {
    // 审计通道不可用时不改变拒绝结论。
  }
  throw new AgentError(
    'not_authorized',
    'provenanceRefs/taintLabels 只能由验证路径写入',
    403,
    { field, source }
  );
}

function assertNoTaintWrite(task, patch, source) {
  for (const field of TAINT_WRITE_FIELDS) {
    if (patch && patch[field] !== undefined) rejectTaintWrite(task, field, source);
  }
}

// §16 读路径专用：跨 Agent / 上下文投影 / 记忆检索读到的内容自动进入任务来源链。
// 只追加不覆盖、去重、按上限截断；只改任务记录，不改被读对象。
const PROVENANCE_APPEND_MAX = 20;

function provenanceRefKey(ref) {
  return `${ref.kind || ''}|${ref.id}|${ref.version === undefined ? '' : ref.version}`;
}

function appendProvenanceRefs(taskId, refs, { source = 'read' } = {}) {
  const store = loadTasks();
  const task = store.tasks[String(taskId || '')];
  if (!task) return null;
  const existing = Array.isArray(task.provenanceRefs) ? task.provenanceRefs.slice() : [];
  const seen = new Set(existing.map(provenanceRefKey));
  const labels = new Set(Array.isArray(task.taintLabels) ? task.taintLabels : []);
  let added = 0;
  let incoming = null;
  try {
    incoming = artifactStore.normalizeProvenanceRefs(refs, 'provenanceRefs');
  } catch (_) {
    // 读取到不可解析的引用：不得默认干净，记 unknown。
    labels.add(artifactStore.TAINT_UNKNOWN);
  }
  if (incoming) {
    for (const ref of incoming) {
      const key = provenanceRefKey(ref);
      if (!seen.has(key) && existing.length < PROVENANCE_APPEND_MAX) {
        existing.push(ref);
        seen.add(key);
        added += 1;
      }
    }
    for (const label of artifactStore.inheritedTaintOf(incoming)) labels.add(label);
  }
  // 旧任务缺 taintLabels 字段：读作 unknown 后再追加，不得被当成干净。
  if (!Array.isArray(task.taintLabels)) labels.add(artifactStore.TAINT_UNKNOWN);
  const nextLabels = [...labels].sort();
  const labelsChanged =
    nextLabels.length !== (Array.isArray(task.taintLabels) ? task.taintLabels.length : -1) ||
    nextLabels.some((label, index) => label !== task.taintLabels[index]);
  if (added === 0 && !labelsChanged) return task;

  task.provenanceRefs = existing;
  task.taintLabels = nextLabels;
  task.updatedAt = Date.now();
  saveTasks();
  try {
    appendEvent({
      botId: task.botId,
      taskId: task.taskId,
      runId: task.runId || null,
      eventType: 'task.provenance_appended',
      payload: { status: task.status, mode: source, added },
    });
  } catch (_) {
    // 审计通道不可用不影响已经落地的只追加传播。
  }
  return task;
}

function appendTaintLabels(taskId, labels, { source = 'read' } = {}) {
  const store = loadTasks();
  const task = store.tasks[String(taskId || '')];
  if (!task) return null;
  let clean;
  try {
    clean = artifactStore.normalizeTaintLabels(labels, 'taintLabels');
  } catch (_) {
    clean = [artifactStore.TAINT_UNKNOWN];
  }
  const base = Array.isArray(task.taintLabels)
    ? task.taintLabels.slice()
    : [artifactStore.TAINT_UNKNOWN];
  const next = [...new Set([...base, ...clean])].sort();
  const changed =
    next.length !== (Array.isArray(task.taintLabels) ? task.taintLabels.length : -1) ||
    next.some((label, index) => label !== task.taintLabels[index]);
  if (!changed) return task;
  task.taintLabels = next;
  task.updatedAt = Date.now();
  saveTasks();
  try {
    appendEvent({
      botId: task.botId,
      taskId: task.taskId,
      runId: task.runId || null,
      eventType: 'task.provenance_appended',
      payload: { status: task.status, mode: source, added: next.length - base.length },
    });
  } catch (_) {
    // 同上
  }
  return task;
}

function updateTask(taskId, patch = {}) {
  const tasks = loadTasks();
  const task = tasks.tasks[String(taskId || '')];
  if (!task) throw new AgentError('task_not_found', '任务不存在', 404);

  // §27：越权写 trustLevel 必须在任何字段被修改之前拒绝。
  assertNoTrustWrite(task, patch, 'updateTask');
  // §16：provenanceRefs/taintLabels 同理，任务更新路径不得清除污点。
  assertNoTaintWrite(task, patch, 'updateTask');

  // 状态只允许经 transitionTask 写入；这里显式拒绝而不是静默丢弃，
  // 否则会留下一条看不见的第二写入路径。
  if (patch.status !== undefined) {
    throw new AgentError(
      'task_status_requires_transition',
      '任务状态只能经 transitionTask 写入',
      400
    );
  }
  // S9：checkpointVersion 是 checkpoint 序号，只能由 recordCheckpoint 递增写入。
  // 它不是 CAS 版本；并发版本是 stateVersion（② 实现，见下方 assertExpectedVersion）。
  if (patch.checkpointVersion !== undefined) {
    throw new AgentError(
      'task_checkpoint_version_read_only',
      'checkpointVersion 只能由 recordCheckpoint 写入',
      400
    );
  }
  // ②/§24.3：stateVersion 由存储层分配（CAS 版本），调用方只读；
  // 直接写入视为越权，显式拒绝而不是静默忽略。
  if (patch.stateVersion !== undefined) {
    throw new AgentError(
      'task_state_version_read_only',
      'stateVersion 由存储层分配，调用方只读',
      400
    );
  }
  // ② CAS：在任何字段被修改之前校验版本，冲突时内存与磁盘都保持原样。
  // 与 checkpointVersion 无关（后者是检查点序号，不是并发版本）。
  assertExpectedVersion(task, patch.expectedVersion);
  if (patch.cancelRequested !== undefined) {
    task.cancelRequested = patch.cancelRequested === true;
  }
  if (Number.isInteger(patch.attempts) && patch.attempts >= 0) {
    task.attempts = patch.attempts;
  }
  if (patch.startedAt !== undefined) task.startedAt = patch.startedAt;
  if (patch.completedAt !== undefined) task.completedAt = patch.completedAt;
  if (patch.errorCode !== undefined) task.errorCode = patch.errorCode;
  // 死信是既有终态上的标记字段，不新增状态：只有 deadLetter 模块会写它。
  if (patch.deadLetter !== undefined) {
    task.deadLetter = patch.deadLetter && typeof patch.deadLetter === 'object'
      ? { ...patch.deadLetter }
      : null;
  }
  if (patch.runId !== undefined) task.runId = patch.runId;
  if (patch.runStartedAt !== undefined) task.runStartedAt = patch.runStartedAt;
  if (patch.heartbeatAt !== undefined) task.heartbeatAt = patch.heartbeatAt;
  // FM-1（§17）：角色漂移重路由时收窄上下文——runtime 只允许在重试路径里
  // 传字符串（置空或缩短），不给任何其他调用方扩大或改写语义的空间。
  if (patch.context !== undefined) {
    task.context = String(patch.context ?? '').slice(0, CONTEXT_MAX);
  }
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
      // ③ 产物引用沿用既有 {kind,id} 形状，只增量一个可选 version（§11 第 1 步）。
      artifacts: Array.isArray(result.artifacts)
        ? result.artifacts
            .filter(item => item && typeof item === 'object')
            .slice(0, 40)
            .map(item => ({
              kind: String(item.kind || '').slice(0, 40),
              id: String(item.id || '').slice(0, 120),
              ...(Number.isInteger(item.version) ? { version: item.version } : {}),
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
      // 依赖失败收敛标记：只在结果显式声明时保留，普通结果形状不变。
      ...(result.neverStarted === true
        ? {
            neverStarted: true,
            blockedBy: Array.isArray(result.blockedBy)
              ? result.blockedBy.slice(0, 8).map(item => String(item).slice(0, 120))
              : [],
          }
        : {}),
    };
  }
  task.updatedAt = nowIso();
  bumpStateVersion(task);
  saveTasks();
  return publicTask(task);
}

// 状态写入的唯一实现：先校验迁移合法性，再改内存。
// recoverInterrupted 需要批量改状态后只落盘一次，因此复用这个内部函数；
// 对外只能经 transitionTask。
function applyTransition(task, to) {
  try {
    stateMachine.assertTransition(task.status, to);
  } catch (error) {
    // §24.3 第 5 条：拒绝非法迁移要记录原因。审计写入失败不得掩盖原拒绝
    // （吞掉审计异常后仍抛出原错误）。
    try {
      appendEvent({
        botId: task.botId,
        taskId: task.taskId,
        runId: task.runId || null,
        eventType: 'task.transition_rejected',
        payload: {
          fromStatus: task.status,
          toStatus: to,
          reason: (error && error.code) || 'invalid_transition',
        },
      });
    } catch (_) {
      // 审计通道不可用时不改变拒绝结论。
    }
    throw error;
  }
  // S6b：审批等待期同样受 Task deadline 约束。进入 waiting_approval 时统一挂计时，
  // 离开时统一清除，避免任何一条入口路径留下永久等待的资源占用。
  if (task.status === 'waiting_approval' && to !== 'waiting_approval') {
    approvalDeadline.disarm(task.taskId);
  }
  task.status = to;
  if (to === 'waiting_approval') {
    const dueAt = getTaskDeadlineAt(task);
    if (dueAt !== null) approvalDeadline.arm(task.taskId, dueAt - Date.now());
  }
}

/**
 * 任务状态唯一对外写入入口。
 * options.to             目标状态（必经 assertTransition 校验）
 * options.expectedVersion ② CAS：可选，基于哪一版修改；不匹配抛 conflict 且不改动
 * options.writer         审计/日志标识，不改变行为，也不写入任务记录
 * 其余字段（result/completedAt/errorCode/...）与状态在同一次落盘内写入，
 * 保持“状态与结果同一次写”的既有语义。
 */
function transitionTask(taskId, options = {}) {
  const tasks = loadTasks();
  const task = tasks.tasks[String(taskId || '')];
  if (!task) throw new AgentError('task_not_found', '任务不存在', 404);
  // §27：必须在 applyTransition 改内存之前拒绝，避免半截状态变化。
  assertNoTrustWrite(task, options, 'transitionTask');
  // §16：污点字段同样在任何状态变更前拒绝。
  assertNoTaintWrite(task, options, 'transitionTask');
  // ② CAS：必须在 applyTransition 之前校验，否则冲突会留下已改的内存状态。
  assertExpectedVersion(task, options.expectedVersion);
  // ③ §11 第 3 步：产物引用必须在进入 completed 之前可读、schema 合格。
  // 校验失败直接抛 artifact_* 错误，任务保持 running，由调用方转入 retrying/recovery。
  // 空引用放行：没有产物要求的任务保持既有完成路径。
  if (options.to === 'completed') {
    artifactStore.assertRefsCommitReady(
      options.result && Array.isArray(options.result.artifacts)
        ? options.result.artifacts
        : []
    );
  }
  applyTransition(task, options.to);
  const patch = { ...options };
  delete patch.to;
  return updateTask(taskId, patch);
}

function isTerminalStatus(status) {
  return TERMINAL.has(status);
}

function allTasks() {
  return Object.values(loadTasks().tasks);
}

// 只读任务表快照（同一内存视图）：runTask 前置就绪校验与 nextQueuedTask
// 共用 dependencies.isReady 时，需要同一份 tasksById 口径。
function rawTasksById() {
  return loadTasks().tasks;
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
  bumpStateVersion(task);
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
  bumpStateVersion(task);
  saveTasks();
  return publicTask(task);
}

function releaseLease(taskId) {
  const state = loadTasks();
  const task = state.tasks[String(taskId || '')];
  if (!task) return null;
  task.lease = null;
  task.updatedAt = nowIso();
  bumpStateVersion(task);
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
  bumpStateVersion(task);
  saveTasks();
  return publicTask(task);
}

function normalizeRunUsage(usage) {
  if (!usage || typeof usage !== 'object') return null;
  const total = Number(usage.total_tokens);
  if (!Number.isFinite(total) || total < 0) return null;
  const asInt = value => (Number.isFinite(Number(value)) ? Math.floor(Number(value)) : null);
  return {
    prompt_tokens: asInt(usage.prompt_tokens),
    completion_tokens: asInt(usage.completion_tokens),
    total_tokens: Math.floor(total),
  };
}

function recordRunFinish(taskId, { runId, status, errorCode = null, finishedAt, usage = null } = {}) {
  const state = loadTasks();
  const task = state.tasks[String(taskId || '')];
  if (!task) return null;
  const at = typeof finishedAt === 'string' ? finishedAt : nowIso();
  const observed = normalizeRunUsage(usage);
  const runs = Array.isArray(task.runs) ? task.runs : [];
  const entry =
    runs.find(item => item.runId === runId && !item.finishedAt) ||
    runs.find(item => item.runId === runId) ||
    null;
  if (entry) {
    entry.finishedAt = at;
    entry.status = status || entry.status;
    entry.errorCode = errorCode || null;
    // 真实供应商 usage：只有本次 attempt 拿到了才写，缺失时保持 null（绝不估算）。
    entry.usage = observed;
  } else {
    runs.push({
      runId: runId || task.runId || null,
      attempt: Number.isInteger(task.attempts) ? task.attempts : 0,
      startedAt: task.runStartedAt || at,
      finishedAt: at,
      status: status || null,
      errorCode: errorCode || null,
      usage: observed,
    });
  }
  task.runs = runs.slice(-RUN_HISTORY_MAX);
  task.updatedAt = at;
  bumpStateVersion(task);
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
  bumpStateVersion(task);
  saveTasks();
  return publicTask(task);
}

// S7：运行失败进入正式重试态 retrying；退避到期由调度器直接启动 attempt。
// 不再写 queued，也不再把 retryAt 藏在排队态里。
function setRetry(taskId, { errorCode, retryAt, now = Date.now() } = {}) {
  const state = loadTasks();
  const task = state.tasks[String(taskId || '')];
  if (!task) throw new AgentError('task_not_found', '任务不存在', 404);
  applyTransition(task, 'retrying');
  const at = new Date(now).toISOString();
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
  bumpStateVersion(task);
  saveTasks();
  return publicTask(task);
}

function hasSideEffectTools(task) {
  return (
    Array.isArray(task.allowedTools) &&
    task.allowedTools.some(name => SIDE_EFFECT_TOOLS.includes(name))
  );
}

// S6b：deadline 沿用既有语义——本次执行起点 + deadlineMs（与 runtime.js 的
// runningSince + deadlineMs 一致）。审批等待的墙钟时间计入，不重新计时。
// 旧数据缺少 startedAt 时退回 updatedAt / createdAt，绝不新造第二个期限来源。
function getTaskDeadlineAt(task) {
  if (!task) return null;
  const budget =
    Number.isInteger(task.deadlineMs) && task.deadlineMs > 0 ? task.deadlineMs : null;
  if (!budget) return null;
  const anchor = Date.parse(task.startedAt || task.updatedAt || task.createdAt || '');
  return Number.isFinite(anchor) ? anchor + budget : null;
}

// S6b 收敛：与 S6 的 convergeExpiredWaitingApproval 同一规则。
// 副作用未知 → recovery；否则 → timed_out。审批记录不在本函数内改动。
function expireWaitingApproval(task, now = Date.now()) {
  const finishedAt = new Date(now).toISOString();
  const status = hasSideEffectTools(task) ? 'recovery' : 'timed_out';
  const errorCode =
    status === 'recovery' ? 'recovery_uncertain_side_effects' : 'deadline_exceeded';
  applyTransition(task, status);
  task.completedAt = finishedAt;
  task.errorCode = errorCode;
  task.lastErrorCode = errorCode;
  if (status === 'recovery') task.requiresReview = true;
  task.result = normalizeWorkerResult({
    status,
    summary: '',
    errorCode,
    runId: task.runId || null,
    finishedAt,
  });
  task.lease = null;
  task.retryAt = null;
  task.heartbeatAt = null;
  task.updatedAt = finishedAt;
  return { status, errorCode, result: task.result, finishedAt, runId: task.runId || null };
}

/**
 * S6b：把已过期的 waiting_approval 任务按 §32.1 收敛。
 * 只处理“仍在等待且期限已到”的任务；未到期或已离开等待态返回 null（不早触发）。
 * 返回收敛结果供 runtime 补 run history / 投递 / 事件；审批记录保持 pending。
 */
function convergeWaitingApprovalDeadline(taskId, { now = Date.now() } = {}) {
  const state = loadTasks();
  const task = state.tasks[String(taskId || '')];
  if (!task || task.status !== 'waiting_approval') return null;
  const dueAt = getTaskDeadlineAt(task);
  if (dueAt === null || dueAt > now) return null;
  const outcome = expireWaitingApproval(task, now);
  bumpStateVersion(task);
  saveTasks();
  return outcome;
}

// 启动恢复：租约仍由未过期且不同的 owner 持有时保持 running；
// 只读任务重新排队；可能产生副作用的任务标记 recovery 等待人工核对，
// 绝不凭空报告成功。
function recoverInterrupted({ ownerId = null, now = Date.now() } = {}) {
  const state = loadTasks();
  const at = new Date(now).toISOString();
  let recovered = 0;
  let recovery = 0;
  let leftRunning = 0;
  const taskIds = [];
  const recoveryTaskIds = [];
  const expiredWaitingApproval = [];
  let changed = false;
  // A-10 / §17：启动恢复时一次性对账事件，避免逐任务重复扫描。
  const eventViolations = detectEventOrderViolations();
  const eventViolationTaskIds = new Set(
    eventViolations.map(item => item.taskId).filter(Boolean)
  );

  for (const task of Object.values(state.tasks)) {
    // S6b：重启后 waiting_approval 也必须按 deadline 收敛——不能只依赖“活着的计时器”。
    if (task.status === 'waiting_approval') {
      const dueAt = getTaskDeadlineAt(task);
      if (dueAt === null) continue;
      if (dueAt > now) {
        approvalDeadline.arm(task.taskId, dueAt - now);
        continue;
      }
      changed = true;
      expireWaitingApproval(task, now);
      expiredWaitingApproval.push(task.taskId);
      continue;
    }
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

    // A-03：跨 Store 恢复校验。Task 状态只信 State Store，产物引用只信 Blackboard；
    // 这里只读校验引用是否仍可读（存在/版本/superseded 链/正文），断裂即进既有
    // recovery 收敛并写 task.recovered 事件留痕，不改写任何 artifact 记录。
    const referencedArtifacts = Array.isArray(task.result && task.result.artifacts)
      ? task.result.artifacts
      : [];
    const refIssues = referencedArtifacts.length
      ? artifactStore.verifyRefsReadable(referencedArtifacts)
      : [];
    const brokenRefPath = refIssues.length ? recoveryPath(task.status) : null;
    if (brokenRefPath) {
      changed = true;
      bumpStateVersion(task);
      for (const step of brokenRefPath) applyTransition(task, step);
      task.updatedAt = at;
      task.completedAt = at;
      task.lease = null;
      task.retryAt = null;
      task.heartbeatAt = null;
      task.errorCode = 'recovery_artifact_reference_broken';
      task.lastErrorCode = 'recovery_artifact_reference_broken';
      task.requiresReview = true;
      task.result = normalizeWorkerResult({
        status: 'recovery',
        summary: '',
        errorCode: 'recovery_artifact_reference_broken',
        runId: task.runId || null,
        finishedAt: at,
      });
      recovery += 1;
      recoveryTaskIds.push(task.taskId);
      try {
        appendEvent({
          botId: task.botId,
          taskId: task.taskId,
          runId: task.runId || null,
          sessionId: task.sessionId || null,
          eventType: 'task.recovered',
          payload: {
            status: 'recovery',
            errorCode: 'recovery_artifact_reference_broken',
            mode: 'cross_store_verify',
            failureMode: 'artifact_chain_broken',
            detail: refIssues
              .map(item => `${item.artifactId || 'unknown'}:${item.reason}`)
              .join(','),
          },
        });
      } catch (_) {
        // 留痕失败不阻断恢复收敛；任务仍以 recovery + errorCode 可查。
      }
      continue;
    }

    // A-10 / §17：事件乱序/重复投递按既有 recovery 收敛（对账后人工核对），
    // 只读事件历史，不重排、不覆盖、不重放。
    if (eventViolationTaskIds.has(task.taskId)) {
      const violation = eventViolations.find(item => item.taskId === task.taskId) || {};
      const eventPath = recoveryPath(task.status);
      if (eventPath) {
        changed = true;
        bumpStateVersion(task);
        for (const step of eventPath) applyTransition(task, step);
        task.updatedAt = at;
        task.completedAt = at;
        task.lease = null;
        task.retryAt = null;
        task.heartbeatAt = null;
        task.errorCode = 'recovery_event_order_violation';
        task.lastErrorCode = 'recovery_event_order_violation';
        task.requiresReview = true;
        task.result = normalizeWorkerResult({
          status: 'recovery',
          summary: '',
          errorCode: 'recovery_event_order_violation',
          runId: task.runId || null,
          finishedAt: at,
        });
        recovery += 1;
        recoveryTaskIds.push(task.taskId);
        try {
          appendEvent({
            botId: task.botId,
            taskId: task.taskId,
            runId: task.runId || null,
            sessionId: task.sessionId || null,
            eventType: 'task.recovered',
            payload: {
              status: 'recovery',
              errorCode: 'recovery_event_order_violation',
              mode: 'event_order_reconcile',
              failureMode: 'event_out_of_order',
              detail: `${violation.reason || 'unknown'}:${violation.eventId || ''}`,
            },
          });
        } catch (_) {
          // 留痕失败不阻断恢复收敛。
        }
        continue;
      }
    }

    changed = true;
    bumpStateVersion(task);
    task.updatedAt = at;
    task.lease = null;
    task.retryAt = null;
    task.heartbeatAt = null;
    if (hasSideEffectTools(task)) {
      applyTransition(task, 'recovery');
      task.completedAt = at;
      task.errorCode = 'recovery_uncertain_side_effects';
      task.lastErrorCode = 'recovery_uncertain_side_effects';
      task.requiresReview = true;
      task.result = normalizeWorkerResult({
        status: 'recovery',
        summary: '',
        errorCode: 'recovery_uncertain_side_effects',
        runId: task.runId || null,
        finishedAt: at,
      });
      recovery += 1;
      recoveryTaskIds.push(task.taskId);
    } else if (task.status === 'running') {
      // S7：running → queued 的回退边已删除；重启时未完成的运行态按重试收口，
      // retryAt 设为当前时刻，调度器下一次遍历即可直接启动 attempt。
      applyTransition(task, 'retrying');
      task.retryAt = at;
      task.recoveredAt = at;
      task.lastErrorCode = 'recovered_after_restart';
      task.errorCode = null;
      task.requiresReview = false;
      recovered += 1;
      taskIds.push(task.taskId);
    } else {
      applyTransition(task, 'queued');
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
    // 自 S5 起该字段随正式状态改名；语义仍是“进入 recovery 的任务数”。
    recovery,
    leftRunning,
    taskIds,
    recoveryTaskIds,
    expiredWaitingApproval,
    // S7：retrying 也是“等待下一次调度”的队列成员。
    queued: Object.values(state.tasks).filter(
      task => task.status === 'queued' || task.status === 'retrying'
    ).length,
  };
}

// 计划不可用时的收敛：非终态任务一律落 recovery（fail-closed）。
// 只用状态机已声明的边：queued → accepted → recovery、retrying → running → recovery，
// 不新增状态、不改迁移表。已终态任务不反转（终态没有出边），只计入 skippedTerminal。
function forcePlanRecovery(taskId, { errorCode, now = Date.now() } = {}) {
  const state = loadTasks();
  const task = state.tasks[String(taskId || '')];
  if (!task) return { changed: false, status: null, skipped: 'not_found' };
  if (stateMachine.isTerminal(task.status)) {
    return { changed: false, status: task.status, skipped: 'terminal' };
  }
  const path = recoveryPath(task.status);
  if (!path) return { changed: false, status: task.status, skipped: 'no_path' };

  for (const step of path) applyTransition(task, step);
  const at = new Date(now).toISOString();
  bumpStateVersion(task);
  task.updatedAt = at;
  task.completedAt = at;
  task.lease = null;
  task.retryAt = null;
  task.heartbeatAt = null;
  task.errorCode = errorCode;
  task.lastErrorCode = errorCode;
  task.requiresReview = true;
  task.result = normalizeWorkerResult({
    status: 'recovery',
    summary: '',
    errorCode,
    runId: task.runId || null,
    finishedAt: at,
  });
  saveTasks();
  return { changed: true, status: 'recovery', errorCode };
}

function recoveryPath(from) {
  if (from === 'recovery') return null;
  if (stateMachine.canTransition(from, 'recovery')) return ['recovery'];
  const next = stateMachine.TRANSITIONS[from] || [];
  for (const mid of next) {
    if (mid === from) continue;
    if (stateMachine.canTransition(mid, 'recovery')) return [mid, 'recovery'];
  }
  return null;
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
    recovery: 0,
  };
  let expiredLeases = 0;
  let retryScheduled = 0;
  let oldestQueuedAt = null;
  for (const task of Object.values(state.tasks)) {
    if (task.status === 'waiting_approval') counts.waitingApproval += 1;
    else if (task.status === 'recovery') counts.recovery += 1;
    else if (stateMachine.isTerminal(task.status)) counts.terminal += 1;
    else if (task.status === 'queued' || task.status === 'retrying') {
      // S7：retrying 归入队列计数，保持 healthSnapshot 的字段集合不变。
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

// 依赖失败收敛（Phase 1 交付物 2）。
// 未开始（status=queued）且依赖已终态未成功的任务 → failed；
// 状态机没有 queued → failed 这条边（queued 只到 accepted/cancelled/timed_out），
// 因此按 queued → accepted → failed 两步收敛，并在 result 与事件里写
// neverStarted=true，明确「该任务从未进入 running」。
// 返回已收敛的 [taskId, errorCode, blockedBy] 列表，供调度与探针核对。
function settleDependencies() {
  const state = loadTasks();
  const settled = [];
  let progressed = true;
  while (progressed) {
    progressed = false;
    for (const task of Object.values(state.tasks)) {
      if (task.status !== 'queued' || task.cancelRequested === true) continue;
      const deps = Array.isArray(task.dependsOn) ? task.dependsOn : [];
      if (!deps.length) continue;
      const blocked = dependencies.blockers(task, state.tasks);
      // 还有依赖在跑 → 继续排队，不判死。
      if (!blocked.failed.length && !blocked.missing.length) continue;

      const cancelledOnly =
        blocked.failed.length > 0 &&
        blocked.failed.every(item => item.status === 'cancelled');
      const errorCode = cancelledOnly ? 'dependency_cancelled' : 'dependency_failed';
      const blockedBy = [
        ...blocked.failed.map(item => item.taskId),
        ...blocked.missing,
      ];
      const finishedAt = nowIso();
      const result = normalizeWorkerResult({
        status: 'failed',
        summary: `依赖未成功完成，任务未开始执行：${blockedBy.join(', ')}`.slice(0, 500),
        errorCode,
        finishedAt,
        neverStarted: true,
        blockedBy,
      });
      transitionTask(task.taskId, { to: 'accepted' });
      transitionTask(task.taskId, {
        to: 'failed',
        completedAt: finishedAt,
        errorCode,
        lastErrorCode: errorCode,
        result,
      });
      settled.push({ taskId: task.taskId, errorCode, blockedBy });
      appendEvent({
        botId: task.agentId || task.botId,
        taskId: task.taskId,
        eventType: 'task.dependency_failed',
        payload: {
          status: 'failed',
          errorCode,
          neverStarted: true,
          blockedBy: blockedBy.join(','),
          dependencyTaskId: blockedBy[0] || '',
        },
      });
      settled.push({ taskId: task.taskId, errorCode, blockedBy });
      progressed = true;
    }
  }

  // A-10 / §17：纯死锁环（互相等待）不会命中上面的 failed/missing 分支，
  // 这里用纯图检测把仍是 queued 的环成员按既有 failed 终态收口。
  // 处置口径：环依赖无法靠重试自愈 → 终态（errorCode=dependency_deadlock），不新增状态。
  const latest = loadTasks();
  const deadlocked = dependencies.detectDeadlocks(latest.tasks);
  for (const taskId of deadlocked) {
    const task = latest.tasks[taskId];
    if (!task || task.status !== 'queued' || task.cancelRequested === true) continue;
    const cycle = (Array.isArray(task.dependsOn) ? task.dependsOn : []).slice();
    const finishedAt = nowIso();
    const result = normalizeWorkerResult({
      status: 'failed',
      summary: `依赖环导致任务无法开始执行：${cycle.join(', ')}`.slice(0, 500),
      errorCode: 'dependency_deadlock',
      finishedAt,
      neverStarted: true,
      blockedBy: cycle,
    });
    transitionTask(task.taskId, { to: 'accepted' });
    transitionTask(task.taskId, {
      to: 'failed',
      completedAt: finishedAt,
      errorCode: 'dependency_deadlock',
      lastErrorCode: 'dependency_deadlock',
      result,
    });
    appendEvent({
      botId: task.agentId || task.botId,
      taskId: task.taskId,
      eventType: 'task.dependency_failed',
      payload: {
        status: 'failed',
        errorCode: 'dependency_deadlock',
        failureMode: 'dependency_deadlock',
        neverStarted: true,
        blockedBy: cycle.join(','),
        dependencyTaskId: cycle[0] || '',
      },
    });
    settled.push({ taskId: task.taskId, errorCode: 'dependency_deadlock', blockedBy: cycle });
  }
  return settled;
}

// 队列顺序：优先级（high → normal → low）优先，同级按创建时间，最后用 taskId
// 兜底。S7 起队列成员含正式重试态 retrying；尚未到 retryAt 的任务暂不出队，
// 避免失败后立即重试形成风暴。
// Phase 1 交付物 2：依赖未就绪的任务不出队；就绪判定复用 dependencies.isReady（唯一实现）。
function nextQueuedTask(now = Date.now()) {
  const current = loadTasks();
  return (
    Object.values(current.tasks)
      .filter(
        task =>
          (task.status === 'queued' || task.status === 'retrying') &&
          task.cancelRequested !== true
      )
      .filter(task => !task.retryAt || Date.parse(task.retryAt) <= now)
      .filter(task => dependencies.isReady(task, current.tasks))
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
    task =>
      (task.status === 'queued' || task.status === 'retrying') &&
      task.cancelRequested !== true
  ).length;
}

function reloadForTests() {
  taskCache = null;
  eventCache = null;
  outboxCache = null;
}

// 死信只落在既有终态任务的 deadLetter 标记上，不新增状态、不建第二套存储。
function listDeadLetters({ status = 'open', limit = 50 } = {}) {
  const state = loadTasks();
  const rows = Object.values(state.tasks)
    .filter(task => task.deadLetter && (!status || task.deadLetter.status === status))
    .map(task => {
      const detail = publicTask(task);
      const artifacts = Array.isArray(task.result && task.result.artifacts)
        ? task.result.artifacts.map(ref => ({
            kind: ref && ref.kind,
            id: ref && ref.id,
            version: ref && ref.version,
          }))
        : [];
      return {
        taskId: task.taskId,
        botId: task.botId,
        taskType: task.taskType,
        goal: task.goal,
        status: detail.status,
        errorCode: detail.errorCode,
        attempts: Number(task.attempts) || 0,
        deadLetter: { ...task.deadLetter },
        artifacts,
      };
    })
    .sort((left, right) =>
      String((right.deadLetter && right.deadLetter.createdAt) || '').localeCompare(
        String((left.deadLetter && left.deadLetter.createdAt) || '')
      )
    );
  return rows.slice(0, Math.max(1, Number(limit) || 50));
}

// 成本/死信只读视图：全部任务（跨 bot）与 Run 预算账，避免调用方自建第二套存储。
function listAllTasks() {
  const state = loadTasks();
  return Object.values(state.tasks).map(publicTask);
}

function getRunUsage(runId) {
  const key = String(runId || '');
  if (!key) return null;
  const run = ensureTokenRuns(loadTasks())[key];
  if (!run) return null;
  return {
    runId: key,
    budget: Number.isInteger(run.budget) ? run.budget : null,
    used: Number(run.used) || 0,
    reserved: Number(run.reserved) || 0,
  };
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
  DEFAULT_TASK_TOKEN_BUDGET,
  TASK_SCHEMA_VERSION,
  createTask,
  getTask,
  listDeadLetters,
  getRawTask,
  listTasks,
  listAllTasks,
  getRunUsage,
  updateTask,
  transitionTask,
  appendEvent,
  listEvents,
  detectEventOrderViolations,
  flushEventOutbox,
  safePayload,
  isTerminalStatus,
  allTasks,
  rawTasksById,
  nextQueuedTask,
  settleDependencies,
  queuedCount,
  recoverInterrupted,
  forcePlanRecovery,
  getTaskDeadlineAt,
  convergeWaitingApprovalDeadline,
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
  getTaskBudgetSnapshot,
  reserveTaskBudget,
  settleTaskBudget,
  releaseTaskBudget,
  appendProvenanceRefs,
  appendTaintLabels,
};
