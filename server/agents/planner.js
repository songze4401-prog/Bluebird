/* global module */
/**
 * Phase 1 交付物第 1 项（Planner 侧）：确定性规划器。
 *
 * 只做「高层目标 → 可执行计划」的规则拆解，**不接真实模型**：
 *   - 固定模板：检索→总结（两步，第二步 dependsOn 第一步）、纯检索（一步）；
 *   - 拆不出来（没有命中模板）→ 显式失败 `capability_not_found`，且**不写计划**；
 *   - 计划**只落既有 workflow-store**（appendVersion / getVersion），复用
 *     planId/planVersion 的不可变版本语义，不另存副本、不引入第二套版本口径；
 *   - 任务创建复用上一轮的 `orchestrator.createTaskGraph`（批量依赖入口），
 *     每条任务在 `router.dispatch` 同一次写入里冻结同一个 (planId, planVersion)。
 *
 * 明确不做：真实模型规划、重规划、动态组队、Blackboard、新 HTTP 路由。
 *
 * 写序：先 plan（appendVersion 内部 fsync）→ 再批量建任务。若建任务失败，
 * 计划成为孤儿，按 workflow-store 既有 ORPHAN_TTL_MS（24h）裁剪，不存在
 * 「任务指向不存在计划」的持久态。
 */
const crypto = require('crypto');
const { AgentError } = require('./errors');
const workflowStore = require('./workflow-store');

// 关键词只服务于「能不能拆」的判定，不做 NLU、不扩展语义。
const SEARCH_RE = /检索|搜索|查找|查一下|回忆|回想|记得|记忆|偏好|上次|之前/;
const EXPLAIN_RE = /总结|汇总|整理|归纳|解释|为什么|依据|来源|怎么理解/;

const STEP_GOAL_MAX = 200;

function normalizeGoal(value) {
  return typeof value === 'string' ? value.trim().slice(0, 2000) : '';
}

function sha256(text) {
  return crypto.createHash('sha256').update(text).digest('hex');
}

function planIdFor(goal, template) {
  // 确定性 planId：同一目标+模板永远落在同一血缘；联合 digest 保证不同目标不撞车。
  return `plan_pg_${sha256(`${template}\n${goal}`).slice(0, 32)}`;
}

function makeStep({ role, capability, taskType, prefix, goal, dependsOn = [] }) {
  const stepGoal = `${prefix}${goal}`.slice(0, STEP_GOAL_MAX);
  return {
    stepKey: workflowStore.stepKeyFor({
      toolName: capability,
      args: { goal: stepGoal, capability, role },
    }),
    toolName: capability,
    argsDigest: workflowStore.digestArgs({ goal: stepGoal, capability, role }),
    label: role,
    goal: stepGoal,
    capability,
    taskType,
    dependsOn,
  };
}

function buildSteps(template, goal) {
  if (template === 'search_then_summarize') {
    const search = makeStep({
      role: '检索',
      capability: 'memory.search',
      taskType: 'memory.search',
      prefix: '围绕目标检索记忆：',
      goal,
    });
    const summarize = makeStep({
      role: '总结',
      capability: 'memory.explain',
      taskType: 'memory.explain',
      prefix: '基于检索结果总结与解释：',
      goal,
      dependsOn: [search.stepKey],
    });
    return [search, summarize];
  }
  return [
    makeStep({
      role: '检索',
      capability: 'memory.search',
      taskType: 'memory.search',
      prefix: '围绕目标检索记忆：',
      goal,
    }),
  ];
}

function selectTemplate(goal) {
  if (EXPLAIN_RE.test(goal)) return 'search_then_summarize';
  if (SEARCH_RE.test(goal)) return 'memory_search';
  throw new AgentError(
    'capability_not_found',
    '无法用确定性规则拆解该目标：请给出可检索/可总结的目标，或显式指定 capability',
    400
  );
}

function buildPlan(template, steps, goal, publishGate) {
  const plan = {
    intent: 'agent_task_graph',
    enabled: true,
    layers: Object.freeze({ history: false, retrieval: true, knowledge: false }),
    budgets: {},
    noAnswerThreshold: 0,
    reasons: [`planner_rule:${template}`],
    steps,
    allowedTools: [],
    budget: null,
    goalDigest: `sha256:${sha256(goal)}`,
  };
  // P5-C2：发布门声明原样进入计划（workflow-store 校验形状；未声明不带键，
  // digest 与既有计划一致）。
  if (publishGate && typeof publishGate === 'object' && !Array.isArray(publishGate)) {
    plan.publishGate = publishGate;
  }
  return plan;
}

/**
 * 规划但**不**创建任务。
 * 返回 `created=false` 时表示命中了同一 planId 的 head 版本且内容 digest 相同
 * （取出语义）；`created=true` 表示新建或追加了一个版本。
 */
function plan(input = {}, store = workflowStore) {
  const goal = normalizeGoal(input.goal || input.intent);
  if (!goal) {
    throw new AgentError('capability_not_found', '规划输入缺少非空 goal', 400);
  }
  const template = selectTemplate(goal);
  const steps = buildSteps(template, goal);
  const publishGate =
    input.publishGate && typeof input.publishGate === 'object' && !Array.isArray(input.publishGate)
      ? input.publishGate
      : null;
  const requestedPlanId =
    typeof input.planId === 'string' && input.planId.trim()
      ? input.planId.trim()
      : null;
  const planId = requestedPlanId || planIdFor(goal, template);
  const normalized = store.validatePlan(buildPlan(template, steps, goal, publishGate));
  const digest = store.digestPlan(normalized);

  const state = store.read();
  const lineage = state.plans[planId];
  if (lineage) {
    const head = store.getVersion(planId, lineage.headVersion);
    if (head.digest === digest) {
      return {
        planId,
        planVersion: head.planVersion,
        digest,
        created: false,
        headVersion: head.headVersion,
        template,
        plan: head.plan,
        steps: head.plan.steps,
      };
    }
  }

  const appended = store.appendVersion({
    plan: normalized,
    planId,
    // 同一目标固定 planId；只有 Planner 会显式允许「用指定 id 新建血缘」。
    allowCreate: true,
  });
  return {
    planId: appended.planId,
    planVersion: appended.planVersion,
    digest: appended.digest,
    created: true,
    headVersion: appended.headVersion,
    template,
    plan: store.getVersion(appended.planId, appended.planVersion).plan,
    steps,
  };
}

/**
 * 规划 + 批量建任务：步骤 key 即 workflow-store 的 stepKey，依赖原样转成
 * `dependsOn`；创建路径完全复用 `orchestrator.createTaskGraph`。
 */
function planAndCreate(input = {}, context = {}, overrides = {}) {
  const store = overrides.workflowStore || workflowStore;
  const orchestrator = overrides.orchestrator || require('./orchestrator');
  const planned = plan(input, store);
  const definitions = planned.steps.map(step => ({
    key: step.stepKey,
    goal: step.goal,
    capability: step.capability,
    taskType: step.taskType,
    dependsOn: step.dependsOn,
    // 冻结同一个计划版本：Router 不再为本批任务各追加一份单步计划。
    workflowPlan: {
      planId: planned.planId,
      planVersion: planned.planVersion,
    },
    ...(typeof input.context === 'string' ? { context: input.context } : {}),
  }));
  const graph = orchestrator.createTaskGraph(
    { ...(input.agentId ? { agentId: input.agentId } : {}), definitions },
    context
  );
  return {
    planId: planned.planId,
    planVersion: planned.planVersion,
    digest: planned.digest,
    created: planned.created,
    template: planned.template,
    plan: planned.plan,
    steps: planned.steps,
    order: graph.order,
    tasks: graph.tasks,
  };
}

// 便于测试注入 Orchestrator（真实 Router 的创建路径不变，只换 Agent 快照）。
function createPlanner(overrides = {}) {
  const store = overrides.workflowStore || workflowStore;
  return {
    plan: input => plan(input, store),
    planAndCreate: (input, context) =>
      planAndCreate(input, context, {
        workflowStore: store,
        ...(overrides.orchestrator ? { orchestrator: overrides.orchestrator } : {}),
      }),
  };
}

module.exports = {
  createPlanner,
  plan,
  planAndCreate,
  planIdFor,
  selectTemplate,
  STEP_GOAL_MAX,
};
