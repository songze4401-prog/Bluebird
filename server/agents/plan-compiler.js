/* global module */
/**
 * 轮 2（Orchestrator 立项书）：计划编译器（plan-compiler-v1）。
 *
 * 职责边界（纯服务端校验与落盘，**不执行任何任务、不调用模型**，输入是字符串）：
 *   模型产计划 JSON（nodes[{key?, taskType, goal, dependsOn?, context?}]）
 *     → schema 校验（1..8 节点、key 唯一、dependsOn 引用已知 key）
 *     → DAG 无环（dependencies.validateGraph）
 *     → 执行者由路由解析：taskType 必须命中某 Agent 的 capabilities ∩
 *       acceptedTaskTypes（routingPriority 升序 → botId，与 router.decideInternal
 *       同口径）；**模型声明的 agent 名一律丢弃**，只在诊断与审计里留计数；
 *     → 每节点 risk-policy 分级入诊断（不改变计划内容）；
 *     → 落 workflow-store（appendVersion 唯一版本分配器；同内容取出语义：
 *       head digest 相同 → created:false 不追加版本）；
 *     → 输出 definitions（createTaskGraph 可直接消费的形状，含解析出的 agentId）。
 *
 * 事件：plan.proposed / plan.compiled / plan.rejected（payload 只含扁平标量）。
 * 任何校验失败：先记 plan.rejected 再抛 AgentError（调用方降级处理）。
 */
const crypto = require('crypto');
const tasks = require('./tasks');
const workflowStore = require('./workflow-store');
const riskPolicy = require('./risk-policy');
const { HIGH_RISK_TASK_TYPES } = require('./autonomy-policy');
const dependencies = require('./dependencies');

const PLAN_COMPILER_VERSION = 'plan-compiler-v1';
const MAX_NODES = 8;
const NODE_GOAL_MAX = 200; // 与 workflow-store STEP_GOAL_MAX 对齐
const NODE_CONTEXT_MAX = 2000;
const NODE_DEPENDS_MAX = 8;
const NODE_KEY_MAX = 80;

function recordEvent(botId, eventType, payload, context = {}) {
  try {
    tasks.appendEvent({ botId: botId || 'system', eventType, payload, ...context });
  } catch (_) {
    /* 事件失败不改变编译结论 */
  }
}

function sha256(text) {
  return crypto.createHash('sha256').update(String(text || '')).digest('hex');
}

function planIdFor(steps) {
  // 内容寻址：同一步骤集永远落在同一血缘（与 planner.planIdFor 同思路）。
  return `plan_pc_${workflowStore.digestPlan({ steps }).slice(7, 39)}`;
}

/**
 * 执行者解析：与 router.decideInternal 同口径（capabilities ∩ acceptedTaskTypes
 * 双匹配，routingPriority 升序 → botId）。匹配不到返回 null。
 */
function resolveAgentId(taskType) {
  const { listManifests } = require('./manifest');
  const manifests = Array.isArray(listManifests()) ? listManifests() : [];
  const matched = manifests
    .filter(agent => {
      const capabilities = Array.isArray(agent.capabilities) ? agent.capabilities : [];
      const accepted = Array.isArray(agent.acceptedTaskTypes) ? agent.acceptedTaskTypes : [];
      return (
        capabilities.includes(taskType) &&
        accepted.includes(taskType) &&
        agent.enabled !== false
      );
    })
    .sort((a, b) => (a.routingPriority || 0) - (b.routingPriority || 0) || String(a.botId).localeCompare(String(b.botId)));
  return matched.length ? matched[0].botId : null;
}

function reject(mode, nodeCount, errorCode, message, status = 400) {
  const { AgentError } = require('./errors');
  // 编译失败没有可信执行者归属，事件挂默认注册主体（memory）——appendEvent
  // 校验 botId，'system' 不在注册表会被静默丢弃。
  recordEvent(
    'memory',
    'plan.rejected',
    { mode, nodeCount, skipReason: errorCode },
    {}
  );
  throw new AgentError(errorCode, message, status);
}

/**
 * 编译入口。nodes：模型产计划 JSON 的节点数组；declaredAgents：模型若声明了
 * agent 名，这里原样收下用于审计（**不参与执行者判定**）。
 */
function compilePlan({ goal = '', mode = 'dag', nodes = [], declaredAgents = null } = {}) {
  const { AgentError } = require('./errors');
  const planMode = mode === 'single' || mode === 'dag' ? mode : null;
  if (!planMode) {
    reject(mode, 0, 'plan_mode_invalid', "mode 只接受 'single' 或 'dag'");
  }
  if (!Array.isArray(nodes) || nodes.length === 0) {
    reject(planMode, 0, 'plan_nodes_missing', '计划至少需要一个节点');
  }
  if (nodes.length > MAX_NODES) {
    reject(planMode, nodes.length, 'plan_node_limit', `计划节点不能超过 ${MAX_NODES} 个`);
  }

  // 1) schema：key 归一（缺省 k1..kN）、唯一；taskType/goal 必备。
  const declaredAgentCount = Array.isArray(declaredAgents)
    ? declaredAgents.filter(item => typeof item === 'string' && item.trim()).length
    : 0;
  const byKey = new Map();
  const order = [];
  nodes.forEach((node, index) => {
    if (!node || typeof node !== 'object' || Array.isArray(node)) {
      reject(planMode, nodes.length, 'plan_node_invalid', `nodes[${index}] 必须是纯对象`);
    }
    const key =
      typeof node.key === 'string' && node.key.trim()
        ? node.key.trim().slice(0, NODE_KEY_MAX)
        : `k${index + 1}`;
    if (byKey.has(key)) {
      reject(planMode, nodes.length, 'plan_node_key_dup', `节点 key 重复：${key}`);
    }
    const taskType = typeof node.taskType === 'string' ? node.taskType.trim() : '';
    if (!taskType || taskType.length > 64) {
      reject(planMode, nodes.length, 'plan_node_task_type', `nodes[${index}].taskType 必须是 1 到 64 字的字符串`);
    }
    const nodeGoal = typeof node.goal === 'string' && node.goal.trim() ? node.goal.trim() : taskType;
    byKey.set(key, {
      key,
      index,
      taskType,
      goal: nodeGoal.slice(0, NODE_GOAL_MAX),
      context:
        typeof node.context === 'string' && node.context.trim()
          ? node.context.trim().slice(0, NODE_CONTEXT_MAX)
          : null,
      dependsOn: Array.isArray(node.dependsOn) ? node.dependsOn : [],
    });
    order.push(key);
  });

  // 2) dependsOn：只能引用已知 key，数量 ≤8；环检测复用 dependencies.validateGraph。
  for (const node of byKey.values()) {
    const refs = node.dependsOn
      .map(ref => (typeof ref === 'string' ? ref.trim() : ''))
      .filter(Boolean);
    if (refs.length > NODE_DEPENDS_MAX) {
      reject(planMode, nodes.length, 'plan_node_deps_limit', `节点依赖不能超过 ${NODE_DEPENDS_MAX} 条`);
    }
    for (const ref of refs) {
      if (!byKey.has(ref)) {
        reject(planMode, nodes.length, 'plan_dep_unknown', `节点 ${node.key} 依赖了未知 key：${ref}`);
      }
    }
    node.dependsOn = refs;
  }
  try {
    dependencies.validateGraph({
      nodes: order.map(key => ({ key, dependsOn: byKey.get(key).dependsOn })),
      tasksById: {},
    });
  } catch (error) {
    reject(planMode, nodes.length, (error && error.code) || 'plan_dependency_invalid', (error && error.message) || '依赖图非法', (error && error.status) || 400);
  }

  // 3) 执行者解析：模型 agent 名丢弃（declaredAgentCount 只进审计）。
  const nodesResolved = order.map(key => {
    const node = byKey.get(key);
    const agentId = resolveAgentId(node.taskType);
    if (!agentId) {
      reject(
        planMode,
        nodes.length,
        'capability_not_found',
        `没有已注册主体同时声明能力「${node.taskType}」与任务类型「${node.taskType}」`
      );
    }
    return { node, agentId };
  });

  // 4) 构造 steps（stepKey 内容寻址；dependsOn 解析为批内 stepKey）。
  const stepKeyByKey = new Map();
  for (const { node } of nodesResolved) {
    const args = { goal: node.goal, taskType: node.taskType, role: 'plan-compiler' };
    stepKeyByKey.set(
      node.key,
      workflowStore.stepKeyFor({ toolName: node.taskType, args })
    );
  }
  const keyToDigest = node => {
    const args = { goal: node.goal, taskType: node.taskType, role: 'plan-compiler' };
    return workflowStore.digestArgs(args);
  };
  const steps = nodesResolved.map(({ node, agentId }) => ({
    stepKey: stepKeyByKey.get(node.key),
    toolName: node.taskType,
    argsDigest: keyToDigest(node),
    label: 'plan-compiler',
    goal: node.goal,
    capability: node.taskType,
    taskType: node.taskType,
    dependsOn: node.dependsOn.map(ref => stepKeyByKey.get(ref)),
    agentId,
  }));
  const plan = {
    intent: 'agent_task_graph',
    enabled: true,
    layers: { history: false, retrieval: true, knowledge: false },
    budgets: {},
    noAnswerThreshold: 0,
    reasons: [`plan-compiler:${planMode}`],
    steps,
    allowedTools: [],
    budget: null,
    goalDigest: `sha256:${sha256(goal)}`,
  };

  // 5) 落盘：同内容取出语义（head digest 相同 → 不追加版本）。
  const planId = planIdFor(steps);
  const emitBot = nodesResolved[0] ? nodesResolved[0].agentId : 'memory';
  recordEvent(
    emitBot,
    'plan.proposed',
    { mode: planMode, nodeCount: nodes.length, declaredAgentCount },
    {}
  );
  let saved;
  let created = true;
  const state = workflowStore.read();
  const lineage = state.plans[planId];
  if (lineage) {
    const head = workflowStore.getVersion(planId, lineage.headVersion);
    if (head.digest === workflowStore.digestPlan(workflowStore.validatePlan(plan))) {
      created = false;
      saved = { planId, planVersion: head.planVersion, digest: head.digest };
    }
  }
  if (created) {
    saved = workflowStore.appendVersion({ plan, planId, allowCreate: true });
  }

  // 6) 风险分级入诊断（不改计划内容；运行期仍由 runtime 现算）。
  const nodeViews = nodesResolved.map(({ node, agentId }) => {
    const assessment = riskPolicy.assessRisk({
      taskType: node.taskType,
      toolRisks: [],
      highRiskTaskType:
        HIGH_RISK_TASK_TYPES && typeof HIGH_RISK_TASK_TYPES.has === 'function'
          ? HIGH_RISK_TASK_TYPES.has(node.taskType)
          : false,
    });
    return {
      key: node.key,
      stepKey: stepKeyByKey.get(node.key),
      taskType: node.taskType,
      agentId,
      goal: node.goal,
      dependsOn: node.dependsOn.slice(),
      context: node.context,
      riskLevel: assessment.level,
      riskPolicyVersion: assessment.policyVersion || riskPolicy.RISK_POLICY_VERSION,
    };
  });

  // 7) definitions：createTaskGraph 可直接消费的形状（执行在轮 3 接线）。
  const definitions = nodeViews.map(node => ({
    key: node.stepKey,
    stepKey: node.stepKey,
    goal: node.goal,
    capability: node.taskType,
    taskType: node.taskType,
    // definitions 的 dependsOn 与 definition key 同一空间（stepKey，createTaskGraph
    // 批内解析）；nodeViews 里保留模型原始 key 作诊断。
    dependsOn: node.dependsOn.map(ref => stepKeyByKey.get(ref)).filter(Boolean),
    agentId: node.agentId,
    workflowPlan: { planId: saved.planId, planVersion: saved.planVersion },
    ...(node.context ? { context: node.context } : {}),
  }));

  recordEvent(
    emitBot,
    'plan.compiled',
    { planId, planVersion: saved.planVersion, nodeCount: nodes.length, mode: planMode },
    {}
  );

  return {
    planId: saved.planId,
    planVersion: saved.planVersion,
    digest: saved.digest,
    created,
    mode: planMode,
    policyVersion: PLAN_COMPILER_VERSION,
    nodes: nodeViews,
    definitions,
    diagnostics: {
      declaredAgentCount,
      declaredAgentsIgnored: true,
      maxNodes: MAX_NODES,
    },
  };
}

function getCompiledPlan(planId) {
  if (typeof planId !== 'string' || !planId.startsWith('plan_pc_')) return null;
  try {
    const state = workflowStore.read();
    const lineage = state.plans[planId];
    if (!lineage) return null;
    const head = workflowStore.getVersion(planId, lineage.headVersion);
    return {
      planId,
      planVersion: head.planVersion,
      digest: head.digest,
      headVersion: head.headVersion,
      plan: head.plan,
      policyVersion: PLAN_COMPILER_VERSION,
    };
  } catch (_) {
    return null;
  }
}

module.exports = {
  compilePlan,
  getCompiledPlan,
  resolveAgentId,
  planIdFor,
  MAX_NODES,
  PLAN_COMPILER_VERSION,
};
