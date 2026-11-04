/* global module */
/**
 * Phase 1 交付物第 1 项：统一 Planner / Orchestrator 入口。
 *
 * 这是**唯一编排入口**：输入是意图或高层目标，输出是「选中的执行主体 + 创建出的任务」。
 * 它**不另起一套路由**：
 *   - 能力/候选筛选复用 `registry.listAgents()` 的 Manifest 声明；
 *   - 选主体、契约校验、预算冻结、幂等、事件落盘、任务创建全部复用 `router.dispatch`；
 *   - 本模块只做两件 Router 不该承担的事：①意图 → 能力的最小解析；②把
 *     「候选集 / 匹配依据 / 最终选择」作为编排轨迹交给 Router 落进既有任务字段与事件。
 *
 * 明确不做（属于交付物第 3 项）：Worker Pool、并行执行、依赖管理、动态组队、重规划。
 *
 * Phase 1 交付物第 2 项（本轮最小实现）：容量感知的「择一分配」。
 *   - 候选的并发余量**只取 Router `decideInternal` 的 atCapacity**（running >= concurrencyLimit），
 *     本模块不重算 running / limit，也不引入第二套容量口径；
 *   - 选择顺序沿用 Router 既有规则：routingPriority 升序 → botId；
 *     先选「有余量」中排序最前的一个，全部饱和时选排序第一并进入既有队列（degraded）；
 *   - 选择依据与排除原因作为编排轨迹落进既有 task.route.orchestration 与既有事件；
 *   - 本模块不执行任务、不调度并发：选中主体后仍由 `router.dispatch` 创建任务。
 */
const crypto = require('crypto');
const { AgentError } = require('./errors');
const dependencies = require('./dependencies');

// A 类常量：意图关键词 → 能力 的最小映射。只覆盖已注册 Memory Bot 的能力，
// 是「最小可用」而不是通用 NLU；后续有第二个专业 Agent 时必须由 Manifest 扩展，
// 不能在这里继续堆关键词而不改注册契约。
const INTENT_CAPABILITY_RULES = Object.freeze([
  Object.freeze({
    capability: 'memory.search',
    keywords: Object.freeze(['记忆', '回忆', '回想', '记得', '记住', '偏好', '上次', '之前', '检索', '查一下']),
  }),
  Object.freeze({
    capability: 'memory.explain',
    keywords: Object.freeze(['解释', '为什么', '依据', '来源', '怎么理解']),
  }),
]);

// 能力名与任务类型同名是当前 Manifest 的既有口径；不引入第二套命名表。
const CAPABILITY_TASK_TYPE = Object.freeze({
  'memory.search': 'memory.search',
  'memory.explain': 'memory.explain',
  'memory.propose': 'memory.propose',
  'memory.audit.read': 'memory.audit.read',
});

function normalizeText(value, maxChars = 2000) {
  return typeof value === 'string' ? value.trim().slice(0, maxChars) : '';
}

function digestOf(value) {
  return `sha256:${crypto.createHash('sha256').update(String(value || '')).digest('hex')}`;
}

function resolveCapability(request) {
  const explicit = normalizeText(request.capability, 80);
  if (explicit) return { capability: explicit, basis: 'explicit_capability' };

  const taskType = normalizeText(request.taskType, 80);
  if (taskType) return { capability: taskType, basis: 'task_type' };

  const intent = normalizeText(request.intent) || normalizeText(request.goal);
  for (const rule of INTENT_CAPABILITY_RULES) {
    if (rule.keywords.some(keyword => intent.includes(keyword))) {
      return { capability: rule.capability, basis: 'intent_keywords' };
    }
  }
  throw new AgentError(
    'capability_not_found',
    '无法从意图解析出可执行能力：请给出 capability 或 taskType，或补充更明确的目标',
    400
  );
}

function priorityOf(agent) {
  const value = Number(agent && agent.routingPriority);
  return Number.isFinite(value) && value > 0 ? value : 100;
}

// 把 `decideInternal` 的决策（尤其是 atCapacity / selectedAgentId / degraded）
// 翻译成交付物 2 的「择一依据」轨迹。这里只做归档，不参与选择：
// 选哪个主体完全由 Router 的优先级 + 并发余量规则决定，本函数不复制该规则。
function buildAllocation(probe, agents, matchedAgentIds) {
  if (!probe || probe.ok !== true) return null;
  const agentById = new Map(agents.map(agent => [agent.botId, agent]));
  const candidates = (Array.isArray(probe.candidates) ? probe.candidates : [])
    .filter(item => matchedAgentIds.includes(item.agentId))
    .map(item => ({
      agentId: item.agentId,
      priority: priorityOf(agentById.get(item.agentId)),
      atCapacity: item.atCapacity === true,
      code: item.code || null,
      selected: item.agentId === probe.selectedAgentId,
    }))
    .sort(
      (a, b) =>
        a.priority - b.priority || String(a.agentId).localeCompare(String(b.agentId))
    );
  if (!candidates.length) return null;

  const excludedReasons = candidates
    .filter(item => !item.selected)
    .map(item => `${item.agentId}:${item.code || (item.atCapacity ? 'at_capacity' : 'lower_priority')}`)
    .join(';')
    .slice(0, 200);

  return {
    capacityRule: 'decideInternal.atCapacity (running >= concurrencyLimit)',
    priorityRule: 'routingPriority asc → botId asc',
    candidateOrder: candidates.map(item => item.agentId),
    saturatedAgentIds: candidates.filter(item => item.atCapacity).map(item => item.agentId),
    // 全部候选都饱和时 Router 仍会创建任务并进入既有队列（degraded），
    // 因此这里显式标注为 queued_all_at_capacity，而不是静默改投别的通道。
    allocation: probe.degraded === true ? 'queued_all_at_capacity' : 'selected_with_capacity',
    selectedAgentId: probe.selectedAgentId || null,
    excludedReasons,
  };
}

function createOrchestrator(overrides = {}) {
  const getAgents = overrides.getAgents || (() => require('./registry').listAgents());
  const router = overrides.router || require('./router');
  const taskStore = overrides.tasks || require('./tasks');
  // 容量探针必须复用 Router 的 decideInternal（同一份 load 快照口径），
  // 不在编排层重新统计 running / concurrencyLimit。
  const decide =
    overrides.decide ||
    (typeof router.decideWithConfig === 'function'
      ? input => router.decideWithConfig(input)
      : typeof router.decide === 'function'
        ? input => router.decide(input)
        : null);

  /**
   * @param {object} input { intent/goal, capability?, taskType?, agentId?, ...其余字段原样交给 Router }
   * @returns {{task, decision, idempotent, orchestration}}
   */
  function orchestrate(input, context = {}) {
    const request = input && typeof input === 'object' && !Array.isArray(input) ? input : {};
    const goal = normalizeText(request.goal) || normalizeText(request.intent);
    if (!goal) {
      throw new AgentError('validation_failed', '编排入口需要 goal 或 intent', 400);
    }

    const { capability, basis } = resolveCapability(request);
    const taskType =
      normalizeText(request.taskType, 80) || CAPABILITY_TASK_TYPE[capability] || capability;
    const requestedAgentId = normalizeText(request.agentId, 80) || null;
    const agents = Array.isArray(getAgents()) ? getAgents() : [];

    // 候选集：按已注册主体的能力标签 ∩ 受理任务类型筛选，不静默回落到默认 Bot。
    const matchedAgentIds = agents
      .filter(agent => {
        if (requestedAgentId && agent.botId !== requestedAgentId) return false;
        const capabilities = Array.isArray(agent.capabilities) ? agent.capabilities : [];
        const accepted = Array.isArray(agent.acceptedTaskTypes) ? agent.acceptedTaskTypes : [];
        return capabilities.includes(capability) && accepted.includes(taskType);
      })
      .map(agent => agent.botId)
      .sort();

    if (!matchedAgentIds.length) {
      throw new AgentError(
        'capability_not_found',
        `没有已注册主体同时声明能力「${capability}」与任务类型「${taskType}」`,
        400
      );
    }

    const orchestration = {
      entry: 'orchestrator',
      version: 2,
      intentDigest: digestOf(goal),
      capability,
      taskType,
      basis,
      matchingRule: 'capabilities ∩ acceptedTaskTypes',
      registeredAgents: agents.length,
      matchedAgentIds,
      requestedAgentId,
    };

    // 容量探针：直接读 Router `decideInternal` 的候选与 atCapacity 结果（纯决策，无副作用）。
    // 只有探针成功时才补写分配轨迹；探针失败交由 dispatch 按既有错误码与事件处理。
    const allocation = buildAllocation(
      decide ? decide({ ...request, goal, capability, taskType }) : null,
      agents,
      matchedAgentIds
    );
    if (allocation) Object.assign(orchestration, allocation);

    // 选中主体以 Router 的决策为准；显式回填 agentId 让 dispatch 落在同一主体上，
    // 避免「探针选 A、落库却选 B」造成轨迹与事实不一致。
    const selectedAgentId = allocation ? allocation.selectedAgentId : requestedAgentId;

    // 复用现有 Router：契约、预算、幂等、事件与任务创建都不在这里重写。
    const result = router.dispatch(
      {
        ...request,
        goal,
        capability,
        taskType,
        orchestration,
        ...(selectedAgentId ? { agentId: selectedAgentId } : {}),
      },
      context
    );
    return { ...result, orchestration };
  }

  /**
   * Phase 1 交付物 2「依赖管理」批量入口。
   *
   * definitions: [{ key, goal|intent, dependsOn?: [key|taskId], 其余字段交给 orchestrate }]
   * - 先整图校验（上限/悬空引用/环）再落盘：校验失败时**零任务创建**；
   * - 通过后按拓扑序逐条复用 orchestrate → router.dispatch 创建，key 解析为真实 taskId；
   * - 依赖边必须同 agentId，跨主体直接拒绝。
   */
  function createTaskGraph(input = {}, context = {}) {
    const request = input && typeof input === 'object' && !Array.isArray(input) ? input : {};
    const definitions = Array.isArray(request.definitions) ? request.definitions : [];
    if (!definitions.length) {
      throw new AgentError('validation_failed', '依赖图需要至少一个节点', 400);
    }

    const requestedAgentId = normalizeText(request.agentId || request.botId, 80) || null;
    const declaredAgentIds = definitions
      .map(item => normalizeText(item && (item.agentId || item.botId), 80) || null)
      .filter(Boolean);
    const distinct = [...new Set(declaredAgentIds)];
    if (distinct.length > 1) {
      throw new AgentError('dependency_not_found', '依赖图节点必须属于同一 Agent', 400);
    }
    if (requestedAgentId && distinct.length === 1 && distinct[0] !== requestedAgentId) {
      throw new AgentError('dependency_not_found', '依赖图节点与请求的 Agent 不一致', 400);
    }
    const agentId = requestedAgentId || distinct[0] || null;

    // 零副作用校验：任何任务创建之前完成。
    const { order } = dependencies.validateGraph({
      nodes: definitions.map(item => ({
        key: item && typeof item.key === 'string' ? item.key.trim() : '',
        // 原样传入，让 normalizeRefs 对非法类型/空值/重复/超限给出 400。
        dependsOn: item ? item.dependsOn : undefined,
      })),
      tasksById: taskStore.rawTasksById(),
    });

    const byKey = new Map(
      definitions.map(item => [String(item.key).trim(), item])
    );
    const created = {};
    const results = [];
    for (const key of order) {
      const definition = byKey.get(key) || {};
      const dependsOn = (Array.isArray(definition.dependsOn) ? definition.dependsOn : []).map(
        ref => (created[ref] ? created[ref].taskId : ref)
      );
      const payload = { ...definition, dependsOn };
      delete payload.key;
      const result = orchestrate(
        { ...payload, ...(agentId ? { agentId } : {}) },
        context
      );
      created[key] = result.task;
      results.push({ key, ...result });
    }
    return { agentId, order, tasks: created, results };
  }

  return { orchestrate, createTaskGraph };
}

module.exports = {
  createOrchestrator,
  orchestrate: (input, context) => createOrchestrator().orchestrate(input, context),
  createTaskGraph: (input, context) => createOrchestrator().createTaskGraph(input, context),
  resolveCapability,
  buildAllocation,
  INTENT_CAPABILITY_RULES,
  CAPABILITY_TASK_TYPE,
};
