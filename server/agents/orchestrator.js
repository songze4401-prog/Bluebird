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
 * 明确不做（属于交付物第 2 项）：Worker Pool、并行执行、依赖管理、动态组队、重规划。
 */
const crypto = require('crypto');
const { AgentError } = require('./errors');

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

function createOrchestrator(overrides = {}) {
  const getAgents = overrides.getAgents || (() => require('./registry').listAgents());
  const router = overrides.router || require('./router');

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
      version: 1,
      intentDigest: digestOf(goal),
      capability,
      taskType,
      basis,
      matchingRule: 'capabilities ∩ acceptedTaskTypes',
      registeredAgents: agents.length,
      matchedAgentIds,
      requestedAgentId,
    };

    // 复用现有 Router：主体选择、契约、预算、幂等、事件与任务创建都不在这里重写。
    const result = router.dispatch(
      { ...request, goal, capability, taskType, orchestration },
      context
    );
    return { ...result, orchestration };
  }

  return { orchestrate };
}

module.exports = {
  createOrchestrator,
  orchestrate: (input, context) => createOrchestrator().orchestrate(input, context),
  resolveCapability,
  INTENT_CAPABILITY_RULES,
  CAPABILITY_TASK_TYPE,
};
