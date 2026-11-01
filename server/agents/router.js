/* global module */
/**
 * 一期 Router：统一委派入口（控制面）。
 *
 * 决策链固定为：任务分类 → 能力匹配 → Policy 校验 → 选择 Agent → 创建任务 → 入队。
 * - decide() 是纯函数：只读 Agent 描述、路由配置和负载快照，不写任何存储，
 *   相同输入与策略得到相同的决策（routeId / decidedAt / durationMs 除外）。
 * - dispatch() 负责副作用：幂等检查、Worker 会话、任务落库、路由事件与入队。
 *
 * 隐私边界：决策与事件只记录任务类型、路径、候选数量、拒绝短码与耗时，
 * 绝不记录 goal / context / Prompt / 记忆正文。
 */
const crypto = require('crypto');
const { AgentError } = require('./errors');
const intakeControl = require('./intake-control');

const CONTRACT_VERSION = 1;
const PRIORITY_VALUES = Object.freeze(['high', 'normal', 'low']);
const STATUS_BY_CODE = Object.freeze({
  invalid_task: 400,
  tool_not_allowed: 403,
  capability_not_found: 400,
  agent_not_found: 404,
  agent_not_available: 409,
  agent_queue_full: 409,
});
// 多个候选都被拒绝时，取最能说明输入问题的错误。
const REJECTION_PRECEDENCE = Object.freeze([
  'invalid_task',
  'tool_not_allowed',
  'agent_not_available',
  'agent_queue_full',
]);

function fail(field, reason) {
  return { ok: false, field, reason };
}

function validateSpec(spec, value) {
  if (value === undefined || value === null) {
    if (spec.required) return fail(undefined, 'missing');
    return { ok: true, value: null };
  }
  if (spec.type === 'string') {
    if (typeof value !== 'string') return fail(undefined, 'invalid_type');
    const trimmed = value.trim();
    if (!trimmed) return spec.required ? fail(undefined, 'missing') : { ok: true, value: null };
    if (trimmed.length > spec.maxChars) return fail(undefined, 'too_long');
    if (spec.values && !spec.values.includes(trimmed)) return fail(undefined, 'not_in_values');
    return { ok: true, value: trimmed };
  }
  if (spec.type === 'integer') {
    const number = Number(value);
    if (!Number.isInteger(number)) return fail(undefined, 'invalid_type');
    if (number < spec.min || number > spec.max) return fail(undefined, 'out_of_range');
    return { ok: true, value: number };
  }
  if (spec.type === 'array') {
    if (!Array.isArray(value)) return fail(undefined, 'invalid_type');
    if (value.length > spec.maxItems) return fail(undefined, 'too_many');
    const values = spec.values || null;
    const out = [];
    for (const item of value) {
      if (typeof item !== 'string' || !item.trim()) return fail(undefined, 'invalid_item');
      if (values && !values.includes(item)) return fail(undefined, 'not_in_values');
      if (!out.includes(item)) out.push(item);
    }
    return { ok: true, value: out };
  }
  return fail(undefined, 'unsupported_spec');
}

function normalizeString(value) {
  return typeof value === 'string' ? value.trim() : '';
}

/**
 * 按 Agent 的任务契约校验并规范化输入。
 * allowedTools 的有效集合取该 Agent 运行配置与 Manifest 的交集（effectiveTools）。
 */
function validateContractInput(agent, taskType, input, { effectiveTools = null } = {}) {
  const contracts = agent.taskContracts || {};
  const contract = contracts[taskType];
  if (!contract || !contract.input) {
    return { ok: false, code: 'capability_not_found', field: 'taskType', reason: 'no_contract' };
  }
  const fields = contract.input;
  const normalized = {};
  for (const [name, spec] of Object.entries(fields)) {
    const merged =
      name === 'allowedTools' && effectiveTools
        ? { ...spec, values: effectiveTools }
        : spec;
    const result = validateSpec(merged, input[name]);
    if (!result.ok) {
      const code = name === 'allowedTools' && result.reason === 'not_in_values'
        ? 'tool_not_allowed'
        : 'invalid_task';
      return { ok: false, code, field: name, reason: result.reason };
    }
    if (result.value !== null && result.value !== undefined) {
      normalized[name] = result.value;
    }
  }
  const defaults = {
    context: '',
    contextRef: null,
    allowedTools: null,
    deadlineMs: agent.defaultTimeoutMs || 60000,
    priority: 'normal',
    idempotencyKey: null,
  };
  for (const [name, value] of Object.entries(defaults)) {
    if (normalized[name] === undefined || normalized[name] === null) {
      normalized[name] = value;
    }
  }
  return { ok: true, value: normalized };
}

function classifyPath({ taskType, goalChars, contextChars }, routingConfig) {
  const slowTypes = routingConfig.slowTaskTypes || [];
  if (slowTypes.includes(taskType)) {
    return { path: 'slow', reason: 'task_type_requires_planning' };
  }
  if (goalChars > routingConfig.fast.maxGoalChars) {
    return { path: 'slow', reason: 'goal_exceeds_fast_limit' };
  }
  if (contextChars > routingConfig.fast.maxContextChars) {
    return { path: 'slow', reason: 'context_exceeds_fast_limit' };
  }
  return { path: 'fast', reason: 'within_fast_limits' };
}

function selectSorted(agents) {
  return [...agents].sort((a, b) => {
    const byPriority =
      (Number(a.routingPriority) || 100) - (Number(b.routingPriority) || 100);
    if (byPriority !== 0) return byPriority;
    return String(a.botId).localeCompare(String(b.botId));
  });
}

function pickError(rejections) {
  for (const code of REJECTION_PRECEDENCE) {
    const match = rejections.find(item => item.code === code);
    if (match) return match;
  }
  return rejections[0] || { code: 'capability_not_found', message: '没有 Agent 接受该任务类型' };
}

const MESSAGES = Object.freeze({
  invalid_task: '任务参数不符合任务契约',
  tool_not_allowed: 'allowedTools 超出该 Agent 的能力范围',
  capability_not_found: '没有 Agent 接受该任务类型',
  agent_not_found: 'Agent 不存在',
  agent_not_available: 'Agent 当前不可用',
  agent_queue_full: '任务队列已满，请稍后重试',
});

function rejection(decision, { code, status, message, field }) {
  return {
    ...decision,
    ok: false,
    code,
    status: status || STATUS_BY_CODE[code] || 400,
    message: message || MESSAGES[code] || '路由失败',
    ...(field ? { field } : {}),
    selectedAgentId: null,
  };
}

function decideInternal(input, options = {}) {
  const {
    agents = [],
    routingConfig,
    load = { queuedTotal: 0, runningByAgent: {} },
    policyDigest = '',
    now = Date.now,
  } = options;
  if (!routingConfig || typeof routingConfig !== 'object') {
    throw new TypeError('decide 需要 routingConfig');
  }
  const started = now();
  const request = input && typeof input === 'object' && !Array.isArray(input) ? input : {};
  const agentId = normalizeString(request.agentId) || normalizeString(request.botId) || null;
  const taskType = normalizeString(request.taskType);
  const goal = normalizeString(request.goal);
  const context = normalizeString(request.context);
  const { path, reason } = classifyPath(
    { taskType, goalChars: goal.length, contextChars: context.length },
    routingConfig
  );
  const profile = routingConfig.profiles[path];
  const budget = {
    maxRounds: profile.maxRounds,
    maxToolCalls: profile.maxToolCalls,
    maxReadOnlyRetries: profile.maxReadOnlyRetries,
    generatePlan: profile.generatePlan === true,
  };
  const decision = {
    ok: true,
    routeId: `route_${crypto.randomUUID()}`,
    contractVersion: CONTRACT_VERSION,
    capability: taskType,
    taskType,
    path,
    pathReason: reason,
    policyDigest,
    selectedAgentId: null,
    candidates: [],
    rejected: [],
    degraded: false,
    degradedReason: null,
    budget,
    decidedAt: new Date(started).toISOString(),
    durationMs: Math.max(0, now() - started),
  };

  let pool;
  if (agentId) {
    const exact = agents.find(agent => agent.botId === agentId);
    if (!exact) {
      return {
        decision: rejection(decision, { code: 'agent_not_found', field: 'agentId' }),
        normalized: null,
        eventAgentId: null,
      };
    }
    pool = [exact];
  } else {
    pool = [...agents];
  }

  const capable = pool.filter(
    agent =>
      Array.isArray(agent.acceptedTaskTypes) &&
      agent.acceptedTaskTypes.includes(taskType) &&
      Array.isArray(agent.capabilities) &&
      agent.capabilities.includes(taskType)
  );
  decision.candidates = capable.map(agent => ({ agentId: agent.botId, code: null }));
  if (!capable.length) {
    decision.candidates = pool.map(agent => ({ agentId: agent.botId, code: 'capability_not_found' }));
    decision.rejected = pool.map(agent => ({
      agentId: agent.botId,
      code: 'capability_not_found',
    }));
    return {
      decision: rejection(decision, {
        code: 'capability_not_found',
        field: 'taskType',
      }),
      normalized: null,
      eventAgentId: agentId,
    };
  }

  const queueFull =
    Number(load.queuedTotal || 0) >= Number(routingConfig.limits.maxQueueDepth || 100);
  const passed = [];
  for (const agent of selectSorted(capable)) {
    const checked = validateContractInput(agent, taskType, { ...request, goal, context }, {
      effectiveTools: agent.toolAllowlist,
    });
    if (!checked.ok) {
      decision.rejected.push({
        agentId: agent.botId,
        code: checked.code,
        field: checked.field,
      });
      continue;
    }
    if (agent.status !== 'enabled') {
      decision.rejected.push({
        agentId: agent.botId,
        code: 'agent_not_available',
        reason: agent.statusReason || agent.status,
      });
      continue;
    }
    if (queueFull) {
      decision.rejected.push({ agentId: agent.botId, code: 'agent_queue_full' });
      continue;
    }
    const running = Number(load.runningByAgent[agent.botId] || 0);
    const limit = Number(agent.concurrencyLimit) || 1;
    passed.push({ agent, normalized: checked.value, atCapacity: running >= limit });
  }

  if (!passed.length) {
    const picked = pickError(decision.rejected);
    decision.candidates = decision.candidates.map(item => {
      const rejectedItem = decision.rejected.find(r => r.agentId === item.agentId);
      return rejectedItem ? { agentId: item.agentId, code: rejectedItem.code } : item;
    });
    return {
      decision: rejection(decision, {
        code: picked.code,
        message: picked.reason
          ? `${MESSAGES[picked.code] || '路由失败'}（${picked.reason}）`
          : undefined,
        field: picked.field,
      }),
      normalized: null,
      eventAgentId: agentId || (capable[0] && capable[0].botId) || null,
    };
  }

  // 选择顺序：routingPriority → botId；优先选择仍有并发余量的 Agent，
  // 全部饱和时选择排序第一的 Agent 并标记 degraded（任务仍会排队执行）。
  const withCapacity = passed.find(item => !item.atCapacity);
  const chosen = withCapacity || passed[0];
  const selected = chosen.agent;
  decision.selectedAgentId = selected.botId;
  decision.degraded = chosen.atCapacity;
  decision.degradedReason = chosen.atCapacity ? 'agent_concurrency_full' : null;
  decision.candidates = capable.map(agent => {
    const rejectedItem = decision.rejected.find(item => item.agentId === agent.botId);
    return {
      agentId: agent.botId,
      selected: agent.botId === selected.botId,
      code: rejectedItem ? rejectedItem.code : null,
      atCapacity: passed.find(item => item.agent.botId === agent.botId)?.atCapacity ?? null,
    };
  });
  return {
    decision,
    normalized: chosen.normalized,
    selectedAgent: selected,
    eventAgentId: selected.botId,
  };
}

function decide(input, options) {
  return decideInternal(input, options).decision;
}

function emptyLoad() {
  return { queuedTotal: 0, runningByAgent: {} };
}

function computeLoad(taskStore) {
  try {
    const load = emptyLoad();
    for (const task of taskStore.allTasks()) {
      if (!['queued', 'accepted', 'running'].includes(task.status)) continue;
      load.queuedTotal += 1;
      if (task.status === 'queued') continue;
      const agentId = task.agentId || task.botId;
      load.runningByAgent[agentId] = (Number(load.runningByAgent[agentId]) || 0) + 1;
    }
    return load;
  } catch (_) {
    return emptyLoad();
  }
}

function routeEventPayload(decision, extra = {}) {
  const rejected = decision.rejected
    .map(item => `${item.agentId}:${item.code}`)
    .join(';')
    .slice(0, 200);
  const candidates = decision.candidates
    .map(item => item.agentId)
    .join(',')
    .slice(0, 200);
  return {
    routeId: decision.routeId,
    path: decision.path,
    pathReason: decision.pathReason,
    capability: decision.capability,
    candidateCount: decision.candidates.length,
    candidates,
    rejected,
    selected: decision.selectedAgentId || '',
    decision: decision.ok ? 'selected' : 'rejected',
    degraded: decision.degraded === true,
    durationMs: decision.durationMs,
    priority: extra.priority || 'normal',
    contractVersion: decision.contractVersion,
    policyDigest: decision.policyDigest,
    ...(extra.idempotent !== undefined ? { idempotent: extra.idempotent === true } : {}),
  };
}

function writeRouteEvent(appendEvent, agentId, eventType, decision, extra = {}) {
  if (!agentId) return;
  try {
    appendEvent({
      botId: agentId,
      taskId: extra.taskId || null,
      eventType,
      payload: routeEventPayload(decision, extra),
    });
  } catch (error) {
    console.warn(
      `[agent-route] event write failed agent=${agentId} type=${eventType} code=${
        (error && error.code) || 'route_event_write_failed'
      }`
    );
  }
}

function createRouter(overrides = {}) {
  const getAgents = overrides.getAgents || (() => require('./registry').listAgents());
  const getConfig = overrides.getConfig || (() => require('./routing-config').getRoutingConfig());
  const taskStore = overrides.tasks || require('./tasks');
  const sessionStore = overrides.sessions || require('./sessions');
  const appendEvent = overrides.appendEvent || (args => require('./tasks').appendEvent(args));
  const startTask = overrides.startTask || (taskId => require('./runtime').startTask(taskId));
  const loadSnapshot = overrides.load || (() => computeLoad(taskStore));
  const now = overrides.now || Date.now;

  function dispatch(input, context = {}) {
    const intake = intakeControl.getState();
    if (intake.paused) {
      throw new AgentError(
        'agent_intake_paused',
        `Watchdog 已暂停接收新任务（${intake.reason || 'paused'}）`,
        503
      );
    }
    const request = input && typeof input === 'object' && !Array.isArray(input) ? input : {};
    const { config, digest } = getConfig();
    const internal = decideInternal(request, {
      agents: getAgents(),
      routingConfig: config,
      load: loadSnapshot(),
      policyDigest: digest,
      now,
    });
    const decision = internal.decision;
    if (!decision.ok) {
      writeRouteEvent(appendEvent, internal.eventAgentId, 'route.rejected', decision, {
        priority: normalizeString(request.priority) || 'normal',
      });
      throw new AgentError(decision.code, decision.message, decision.status);
    }

    const normalized = internal.normalized;
    const agentId = decision.selectedAgentId;
    const existing = taskStore.findByIdempotencyKey(agentId, normalized.idempotencyKey);
    if (existing) {
      writeRouteEvent(appendEvent, agentId, 'route.decided', decision, {
        taskId: existing.taskId,
        priority: normalized.priority,
        idempotent: true,
      });
      return {
        task: existing,
        decision: { ...decision, idempotent: true },
        idempotent: true,
      };
    }

    let workerSessionId = normalizeString(context.workerSessionId) || null;
    if (workerSessionId) {
      const meta = sessionStore.getSession(agentId, workerSessionId);
      if (!meta) {
        throw new AgentError('agent_session_not_found', 'Bot 会话不存在', 404);
      }
      if (meta.owner && meta.owner.taskId) {
        const ownerTask = taskStore.getTask(meta.owner.taskId);
        if (!ownerTask || !taskStore.isTerminalStatus(ownerTask.status)) {
          throw new AgentError(
            'worker_session_owner_mismatch',
            'Bot 会话已归属其他任务',
            409
          );
        }
      }
    } else {
      const session = sessionStore.createSession(agentId, {
        title: normalizeString(input.goal).slice(0, 30),
        scope: 'worker',
      });
      workerSessionId = session.id;
    }

    const task = taskStore.createTask({
      agentId,
      workerSessionId,
      taskType: decision.taskType,
      goal: normalized.goal,
      context: normalized.context || '',
      contextRef: normalized.contextRef,
      allowedTools: normalized.allowedTools,
      deadlineMs: normalized.deadlineMs,
      priority: normalized.priority,
      idempotencyKey: normalized.idempotencyKey,
      route: {
        routeId: decision.routeId,
        path: decision.path,
        capability: decision.capability,
        policyDigest: decision.policyDigest,
        decidedAt: decision.decidedAt,
      },
      budget: decision.budget,
      parentSessionId: normalizeString(input.parentSessionId) || null,
      parentMessageId: normalizeString(input.parentMessageId) || null,
      parentUserText: typeof input.parentUserText === 'string' ? input.parentUserText : '',
    });

    if (task.idempotent === true) {
      writeRouteEvent(appendEvent, agentId, 'route.decided', decision, {
        taskId: task.taskId,
        priority: normalized.priority,
        idempotent: true,
      });
      return { task, decision: { ...decision, idempotent: true }, idempotent: true };
    }

    // 任务创建后把 Worker 会话绑定到该任务；绑定失败不阻塞任务本身，
    // Worker 启动时会再次尝试并做归属校验。
    try {
      sessionStore.attachOwner(agentId, workerSessionId, {
        agentId,
        taskId: task.taskId,
      });
    } catch (error) {
      console.warn(
        `[agent-route] session owner attach failed task=${task.taskId} code=${
          (error && error.code) || 'owner_attach_failed'
        }`
      );
    }

    writeRouteEvent(appendEvent, agentId, 'route.decided', decision, {
      taskId: task.taskId,
      priority: normalized.priority,
      idempotent: false,
    });
    startTask(task.taskId);
    return { task, decision, idempotent: false };
  }

  function decideWithContext(input, context = {}) {
    const { config, digest } = getConfig();
    return decide(input, {
      agents: getAgents(),
      routingConfig: config,
      load: loadSnapshot(),
      policyDigest: digest,
      now,
      ...context,
    });
  }

  return { decide: decideWithContext, dispatch };
}

const defaultRouter = createRouter();

module.exports = {
  CONTRACT_VERSION,
  PRIORITY_VALUES,
  STATUS_BY_CODE,
  classifyPath,
  validateContractInput,
  decide,
  createRouter,
  computeLoad,
  routeEventPayload,
  dispatch: (input, context) => defaultRouter.dispatch(input, context),
  decideWithConfig: (input, context) => defaultRouter.decide(input, context),
};
