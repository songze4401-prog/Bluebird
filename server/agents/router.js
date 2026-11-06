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
const circuitBreaker = require('./circuit-breaker');
const { getInstanceUserId } = require('../user-scope');
const { CONTRACT_VERSION } = require('./contract');
const orchestrator = require('../context/orchestrator');
const PRIORITY_VALUES = Object.freeze(['high', 'normal', 'low']);
// B-06（§25）：路由冻结的 Task Token 硬上限。
// A 类常量：与路由 profile 的轮次/工具上限一同冻结进任务，不代表供应商真实配额，
// 需随后续真实 usage 数据校准；显式调用方仍可通过 budget.tokenBudget 覆盖。
const TOKEN_BUDGET_BY_PATH = Object.freeze({ fast: 12000, slow: 20000 });
const STATUS_BY_CODE = Object.freeze({
  invalid_task: 400,
  tool_not_allowed: 403,
  capability_not_found: 400,
  agent_not_found: 404,
  agent_not_available: 409,
  agent_queue_full: 409,
  agent_circuit_open: 503,
});
// 多个候选都被拒绝时，取最能说明输入问题的错误。
const REJECTION_PRECEDENCE = Object.freeze([
  'invalid_task',
  'tool_not_allowed',
  'agent_not_available',
  'agent_queue_full',
  'agent_circuit_open',
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
  agent_circuit_open: '该 Agent 近期连续失败，已暂时熔断，请稍后重试',
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
    load = { queuedTotal: 0, runningByAgent: {}, circuitByAgent: {} },
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
    tokenBudget: TOKEN_BUDGET_BY_PATH[path],
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
    // §26 Worker 维度熔断：连续故障的 Agent 先不进候选池，
    // 与"队列满""并发饱和"是三种不同原因，各用各的码，便于路由事件按原因聚合。
    const circuit = (load.circuitByAgent || {})[agent.botId];
    if (circuit && circuit.allowed === false) {
      decision.rejected.push({
        agentId: agent.botId,
        code: 'agent_circuit_open',
        // 刻意不占 reason 字段：reason 会被拼进给用户的那句话，
        // 而 'circuit_open' 对用户没有增量信息；熔断细节放独立字段。
        circuitReason: circuit.reason || 'circuit_open',
        retryAfterMs: circuit.retryAfterMs || 0,
      });
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
  return { queuedTotal: 0, runningByAgent: {}, circuitByAgent: {} };
}

/**
 * 只把"当前不健康"的 Worker 列进负载快照：decide() 要保持纯函数契约
 * （只读 Agent 描述、路由配置和负载快照，不写存储），所以熔断状态在这里读，
 * 判定处只看传入的快照。状态文件读坏时按"无熔断"处理并交给下一次写入显式报错——
 * 让路由因为观测文件损坏而全量拒绝，是把观测故障升级成可用性故障。
 */
function collectOpenCircuits() {
  try {
    const state = circuitBreaker.load();
    const policy = circuitBreaker.effectivePolicy();
    const opened = {};
    for (const key of Object.keys(state.targets || {})) {
      if (!key.startsWith('worker:')) continue;
      const agentId = key.slice('worker:'.length);
      const verdict = circuitBreaker.guard(state, { kind: 'worker', targetId: agentId }, policy);
      if (!verdict.allowed) {
        opened[agentId] = { allowed: false, reason: verdict.reason, retryAfterMs: verdict.retryAfterMs };
      }
    }
    return opened;
  } catch (_) {
    return {};
  }
}

function computeLoad(taskStore) {
  try {
    const load = emptyLoad();
    for (const task of taskStore.allTasks()) {
      // S7：retrying 计入队列深度（不是运行中占用）。
      if (!['queued', 'retrying', 'accepted', 'running'].includes(task.status)) continue;
      load.queuedTotal += 1;
      if (task.status === 'queued' || task.status === 'retrying') continue;
      const agentId = task.agentId || task.botId;
      load.runningByAgent[agentId] = (Number(load.runningByAgent[agentId]) || 0) + 1;
    }
    load.circuitByAgent = collectOpenCircuits();
    return load;
  } catch (_) {
    return { ...emptyLoad(), circuitByAgent: collectOpenCircuits() };
  }
}

function normalizeOrchestration(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  if (value.entry !== 'orchestrator') return null;
  return {
    entry: 'orchestrator',
    version: Number.isInteger(value.version) ? value.version : 1,
    intentDigest: String(value.intentDigest || '').slice(0, 80),
    capability: String(value.capability || '').slice(0, 80),
    taskType: String(value.taskType || '').slice(0, 80),
    basis: String(value.basis || '').slice(0, 40),
    matchingRule: String(value.matchingRule || '').slice(0, 80),
    registeredAgents: Number.isInteger(value.registeredAgents) ? value.registeredAgents : 0,
    matchedAgentIds: Array.isArray(value.matchedAgentIds)
      ? value.matchedAgentIds.slice(0, 10).map(String)
      : [],
    requestedAgentId: value.requestedAgentId
      ? String(value.requestedAgentId).slice(0, 80)
      : null,
    // 交付物 2：容量感知择一的轨迹（容量口径来自 decideInternal，不在这里重算）。
    capacityRule: value.capacityRule ? String(value.capacityRule).slice(0, 80) : null,
    priorityRule: value.priorityRule ? String(value.priorityRule).slice(0, 80) : null,
    candidateOrder: Array.isArray(value.candidateOrder)
      ? value.candidateOrder.slice(0, 10).map(item => String(item).slice(0, 80))
      : [],
    saturatedAgentIds: Array.isArray(value.saturatedAgentIds)
      ? value.saturatedAgentIds.slice(0, 10).map(item => String(item).slice(0, 80))
      : [],
    allocation: value.allocation ? String(value.allocation).slice(0, 40) : null,
    selectedAgentId: value.selectedAgentId
      ? String(value.selectedAgentId).slice(0, 80)
      : null,
    excludedReasons: value.excludedReasons
      ? String(value.excludedReasons).slice(0, 200)
      : '',
  };
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
    // 编排轨迹只在使用统一入口时出现；旧调用路径不新增字段，事件形状保持兼容。
    // 事件 payload 只接受白名单标量，因此这里把轨迹摊平（与 task.route.orchestration 同源）。
    ...(decision.orchestration
      ? {
          orchestrationEntry: decision.orchestration.entry,
          orchestrationBasis: decision.orchestration.basis,
          orchestrationIntentDigest: decision.orchestration.intentDigest,
          orchestrationCapability: decision.orchestration.capability,
          orchestrationTaskType: decision.orchestration.taskType,
          orchestrationMatchingRule: decision.orchestration.matchingRule,
          orchestrationMatchedAgents: decision.orchestration.matchedAgentIds.join(','),
          orchestrationRegisteredAgents: decision.orchestration.registeredAgents,
          // 交付物 2：容量感知择一的轨迹同样摊平进既有事件（嵌套对象不入白名单）。
          orchestrationCapacityRule: decision.orchestration.capacityRule || '',
          orchestrationPriorityRule: decision.orchestration.priorityRule || '',
          orchestrationCandidateOrder: decision.orchestration.candidateOrder.join(',').slice(0, 200),
          orchestrationSaturated: decision.orchestration.saturatedAgentIds.join(','),
          orchestrationAllocation: decision.orchestration.allocation || '',
          orchestrationSelected: decision.orchestration.selectedAgentId || '',
          orchestrationExcluded: decision.orchestration.excludedReasons || '',
        }
      : {}),
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

/**
 * 冻结本次请求的上下文加载计划（可持久化事实，不是执行中间态）。
 * 只存决策所需字段：intent / 层开关 / 预算 / 阈值 / 理由 / 冻结的工具白名单。
 * 检索结果、token 级中间态、会话正文一律不进计划——它们不是「当时怎么决定」的事实。
 */
function buildWorkflowPlan(normalized, decision) {
  const base = orchestrator.planContext({ task: normalized.goal });
  return {
    intent: base.intent,
    enabled: base.enabled,
    layers: base.layers,
    budgets: base.budgets,
    noAnswerThreshold: base.noAnswerThreshold,
    reasons: base.reasons,
    // 本段不生成执行步骤；steps 留空，等重规划接入后由 Workflow Engine 填充。
    steps: [],
    allowedTools: Array.isArray(normalized.allowedTools) ? normalized.allowedTools : [],
    budget: decision.budget || null,
    goalDigest: `sha256:${crypto
      .createHash('sha256')
      .update(String(normalized.goal || ''))
      .digest('hex')}`,
  };
}

function createRouter(overrides = {}) {
  const getAgents = overrides.getAgents || (() => require('./registry').listAgents());
  const getConfig = overrides.getConfig || (() => require('./routing-config').getRoutingConfig());
  const taskStore = overrides.tasks || require('./tasks');
  const workflowStore = overrides.workflowStore || require('./workflow-store');
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
    decision.orchestration = normalizeOrchestration(request.orchestration);
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

    // Phase 1 交付物 1（Planner 侧）：批量计划一次落盘，多任务共享同一个
    // (planId, planVersion)。调用方传入 workflowPlan 时**只校验并复用**，
    // 不再 appendVersion；未传时保持原行为（每个任务冻结自己的单步计划）。
    let workflowPlan;
    if (input.workflowPlan) {
      const pinned = input.workflowPlan;
      const frozen = workflowStore.getVersion(pinned.planId, pinned.planVersion);
      workflowPlan = { planId: frozen.planId, planVersion: frozen.planVersion };
    } else {
      // 写序（硬要求）：计划先落盘并 fsync，任务才带着指针创建。
      // appendVersion 内部是 writeFileAtomicSync（fsync + rename + 目录 fsync），
      // 返回时计划已经可读；因此不存在「任务引用了不存在的计划」的持久态。
      // 若 createTask 随后失败（如任务总数上限），计划会留成孤儿，24h 后由 Store 清理，
      // 但磁盘上绝不会出现指向不存在计划的任务。
      workflowPlan = workflowStore.appendVersion({
        plan: buildWorkflowPlan(normalized, decision),
      });
    }

    const task = taskStore.createTask({
      agentId,
      workerSessionId,
      planId: workflowPlan.planId,
      planVersion: workflowPlan.planVersion,
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
        orchestration: decision.orchestration || null,
      },
      budget: decision.budget,
      parentSessionId: normalizeString(input.parentSessionId) || null,
      parentMessageId: normalizeString(input.parentMessageId) || null,
      parentUserText: typeof input.parentUserText === 'string' ? input.parentUserText : '',
      // 记忆归属用户：调用方给可信身份就用它，否则落回实例用户（服务端身份）。
      parentUserId: normalizeString(input.parentUserId) || getInstanceUserId(),
      // B-06：父子覆盖与 Run 总闸门由调用方显式声明；缺省时任务只受自身 tokenBudget 约束。
      parentTaskId: normalizeString(input.parentTaskId) || null,
      runId: normalizeString(input.runId) || null,
      runBudget:
        Number.isInteger(input.runBudget) && input.runBudget > 0 ? input.runBudget : null,
      // Phase 1 交付物 2：依赖边原样交给 Task Store 做同 botId/上限校验；
      // Router 不重算依赖语义，也不在此落盘。
      dependsOn: input.dependsOn === undefined ? [] : input.dependsOn,
    });

    if (task.idempotent === true) {
      writeRouteEvent(appendEvent, agentId, 'route.decided', decision, {
        taskId: task.taskId,
        priority: normalized.priority,
        idempotent: true,
      });
      return { task, decision: { ...decision, idempotent: true }, idempotent: true };
    }

    // 反向引用只是裁剪保护，不是事实源：写失败不阻塞任务（任务文件里的指针
    // 才是唯一事实，启动时按它解析并补写引用）。
    try {
      workflowStore.pinRef({
        taskId: task.taskId,
        planId: workflowPlan.planId,
        planVersion: workflowPlan.planVersion,
      });
    } catch (error) {
      console.warn(
        `[agent-route] plan pin failed task=${task.taskId} code=${
          (error && error.code) || 'plan_pin_failed'
        }`
      );
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
