/* global module */
/**
 * Phase 4 第 2 项：受控自治策略（默认关闭，由 strategy-version 开关控制）。
 *
 * 三件事，全部复用既有能力与既有口径：
 *  1. 动态组队：按已注册 Agent 的能力覆盖、风险等级、历史成功率决定单 Agent 直跑还是组队；
 *  2. 重规划：失败时允许一次换 Agent，受既有 maxAttempts 与预算约束，不新造计数；
 *  3. 验证强度：按风险/证据强度决定 requiresReview，复用 Phase 3 的审校/审批闸门。
 * 决策与依据写入既有 task.route.orchestration，不新造轨迹口径。
 */
const strategyVersion = require('./strategy-version');
const { listManifests } = require('./manifest');
const riskPolicy = require('./risk-policy');

const ACTIVE_VERSION = 'p4-autonomy-v1';
const HIGH_RISK_TASK_TYPES = new Set(['action.execute', 'memory.write']);
// 只有「策略/审校不通过」这类失败才值得换策略重规划；瞬态错误走既有 retry，
// 硬失败（证据缺失/超时）重规划只会制造假成功，因此不重规划。
const RECOVERABLE_ERRORS = new Set(['review_rejected', 'evidence_insufficient', 'capability_mismatch']);

const REQUIRED_CAPABILITIES = {
  'memory.recall': ['memory.recall'],
  'knowledge.search': ['memory.recall', 'summary.synthesize'],
  'summary.synthesize': ['summary.synthesize'],
  'action.execute': ['action.execute', 'review.verify'],
  'memory.write': ['memory.write'],
};

function isEnabled(state = strategyVersion.get()) {
  return state.enabled !== false && state.version === ACTIVE_VERSION;
}

function requiredCapabilities(taskType) {
  return REQUIRED_CAPABILITIES[taskType] || [taskType];
}

function capabilitiesOf(agentId) {
  const manifest = listManifests().find(item => item.botId === agentId);
  return (manifest && manifest.capabilities) || [];
}

// 单 Agent 直跑：选能力覆盖该任务类型的已注册 Agent（按能力匹配，不按角色名写分支）。
function singleAgentFor(taskType) {
  const agent = listManifests().find(
    item => Array.isArray(item.capabilities) && item.capabilities.includes(taskType)
  );
  return agent ? agent.botId : 'researcher';
}

function teamMembers(required) {
  const agents = listManifests();
  const selected = [];
  const covered = new Set();
  for (const agent of agents) {
    const hit = required.some(capability => agent.capabilities.includes(capability) && !covered.has(capability));
    if (hit) {
      selected.push(agent.botId);
      for (const capability of required) {
        if (agent.capabilities.includes(capability)) covered.add(capability);
      }
    }
  }
  return selected;
}

function plan({ goal = '', taskType, riskLevel = null, historicalSuccessRate = null, activeOverride = null } = {}) {
  const state = strategyVersion.get();
  // activeOverride 只给离线评测的五类比较对象用：对照跑要按「声明的开关」出结果，
  // 而不是被当前落盘的 strategy-version.json 牵着走。线上调用不传，行为完全不变。
  const override = activeOverride === null || activeOverride === undefined ? null : Boolean(activeOverride);
  const active = override === null ? isEnabled(state) : override;
  const required = requiredCapabilities(taskType);
  const highRisk = riskLevel ? riskLevel === 'high' : HIGH_RISK_TASK_TYPES.has(taskType);
  const rationale = [];

  let decision = 'single';
  if (!active) {
    rationale.push('policy_disabled');
  } else {
    if (highRisk) {
      decision = 'team';
      rationale.push('high_risk_requires_review');
    }
    if (typeof historicalSuccessRate === 'number' && historicalSuccessRate < 0.6) {
      decision = 'team';
      rationale.push('historical_success_below_0.6');
    }
  }

  const members = decision === 'team' ? teamMembers(required) : [singleAgentFor(taskType)];
  for (const capability of required) {
    if (!members.some(id => capabilitiesOf(id).includes(capability))) {
      rationale.push(`capability_gap:${capability}`);
    }
  }

  const dependencies = decision === 'team'
    ? members.slice(0, -1).map((member, index) => ({ from: member, to: members[index + 1] }))
    : [];

  return {
    policy: ACTIVE_VERSION,
    enabled: active,
    version: override === true ? ACTIVE_VERSION : state.version,
    decision,
    riskLevel: highRisk ? 'high' : 'low',
    requiredCapabilities: required,
    members,
    dependencies,
    rationale,
    goalDigest: String(goal).slice(0, 80),
    orchestration: {
      entry: 'autonomy-policy.plan',
      basis: active ? rationale.join(',') || 'policy_enabled_single' : 'policy_disabled',
      intentDigest: String(goal).slice(0, 80),
      capability: required.join(','),
      taskType: taskType || '',
      matchingRule: 'capability_coverage',
      matchedAgentIds: members,
      registeredAgents: listManifests().length,
      selectedAgentId: members[0],
      excludedReasons: decision === 'team' ? 'team_required' : '',
    },
  };
}

/**
 * 失败后是否允许一次重规划。只读既有 attempts/maxAttempts 与预算余量，
 * 不新增重规划计数器：attempts < maxAttempts 即"还有一次机会"。
 */
function decideReplan({ task = {}, errorCode = null, maxAttempts = 1, tokenBudget = null, tokenUsed = null, activeOverride = null } = {}) {
  const state = strategyVersion.get();
  const override = activeOverride === null || activeOverride === undefined ? null : Boolean(activeOverride);
  const active = override === null ? isEnabled(state) : override;
  const attempts = Number(task.attempts || 0);
  const limit = Number(task.maxAttempts || maxAttempts || 1);
  const used = tokenUsed === null ? null : Number(tokenUsed);
  const cap = tokenBudget === null ? null : Number(tokenBudget);
  const budgetLeft = cap === null || used === null ? true : used < cap;
  const canRetry = attempts < limit;
  const recoverable = RECOVERABLE_ERRORS.has(String(errorCode || ''));
  const replan = Boolean(active && canRetry && budgetLeft && recoverable);
  const reason = !active
    ? 'policy_disabled'
    : !recoverable
      ? 'non_recoverable_error'
      : !canRetry
        ? 'max_attempts_reached'
        : !budgetLeft
          ? 'budget_exhausted'
          : 'replan_allowed';
  return {
    replan,
    reason,
    attempts,
    maxAttempts: limit,
    errorCode,
    nextAgentId: replan ? (String(task.agentId || '') === 'executor' ? 'reviewer' : 'researcher') : null,
  };
}

/**
 * 验证强度（P5-E 升级为 §13 七因子路由）：等级由 risk-policy.assessRisk 按
 * 七因子取最高、缺信息升一级得出，验证组合查最低验证矩阵；证据不足只把
 * R3 的「审批」位真正触发，绝不降低任何门槛。
 * 输出保持既有契约字段（requiresReview/requiresApproval/reason），新增
 * level/assessment/verification 供 §13 聚合与评测消费。
 */
function verificationStrength({
  taskType,
  riskLevel = null,
  evidenceStrength = 'strong',
  toolRisks = null,
  taintLabels = null,
  externalSideEffects = null,
  failureCost = null,
} = {}) {
  const active = isEnabled();
  const highRisk = riskLevel ? riskLevel === 'high' : HIGH_RISK_TASK_TYPES.has(taskType);
  const assessment = riskPolicy.assessRisk({
    highRiskTaskType: highRisk,
    taskType,
    toolRisks,
    taintLabels,
    externalSideEffects,
    // 证据不足按「失败代价高」进入七因子（缺证据的结果更不可信，代价更高）；
    // 这是既有「high && weak → approval」语义的因子化表达，不是新口径。
    failureCost: evidenceStrength === 'weak' ? 'high' : failureCost,
  });
  const verification = riskPolicy.minimumVerification(assessment.level);
  const requiresReview = verification.independentReview;
  const requiresApproval = verification.approvalOnWeakEvidence && evidenceStrength === 'weak';
  return {
    enabled: active,
    requiresReview,
    requiresApproval,
    reason: requiresApproval
      ? 'high_risk_weak_evidence'
      : requiresReview
        ? `risk_level_${assessment.level}`
        : `risk_level_${assessment.level}`,
    level: assessment.level,
    assessment,
    verification,
  };
}

module.exports = {
  ACTIVE_VERSION,
  HIGH_RISK_TASK_TYPES,
  isEnabled,
  requiredCapabilities,
  plan,
  decideReplan,
  verificationStrength,
  riskPolicy,
};
