/* global module */
/**
 * P5-E（Notion §13）：七因子风险路由 Policy Engine。
 *
 * 原文要求（台账 A-06 行 2026-11-06 原文对齐）：
 *  - 按风险、可逆性、影响范围、数据敏感度、来源污点、外部副作用、失败代价
 *    七因子计算风险等级，**取最高适用等级**；
 *  - **缺信息升一级**，且 Agent 不得自行降级；
 *  - 等级 → 最低验证组合矩阵（R0–R3）；
 *  - R2/R3 门槛不可被成本或延迟降级。
 *
 * 本模块是纯函数引擎：只读调用方给的信号，不读存储、不写状态、不做 IO。
 * 原文只给因子名与「取最高 / 升一级 / 不得降级」三条规则，未给各因子到等级的
 * 映射表；下列映射为**本仓库裁决（非 Notion 原文）**，改动必须升版本。
 *
 * 三条硬规则（违反就是造了第二套口径）：
 *  1. 等级只由服务端信号计算；调用方自称的等级（claimedLevel）只记录、
 *     只用于对比，永不参与计算——这就是「Agent 不得自行降级」的执行点。
 *  2. 有任何因子未知 → 整体升一级（缺信息升一级）；全未知只可能发生在
 *     连任务类型都没有的调用里，此时按 R3 收口（fail-closed）。
 *  3. R2/R3 的独立审校门槛不接受任何成本/延迟理由的下调；确定性校验
 *     是所有等级的绝对下限，任何等级都关不掉。
 */

const RISK_POLICY_VERSION = 'risk-policy-v1';
const LEVELS = Object.freeze(['R0', 'R1', 'R2', 'R3']);

const FACTOR_NAMES = Object.freeze([
  'inherent_risk', // 风险
  'reversibility', // 可逆性
  'blast_radius', // 影响范围
  'data_sensitivity', // 数据敏感度
  'source_taint', // 来源污点
  'external_side_effects', // 外部副作用
  'failure_cost', // 失败代价
]);

// 因子 → 等级映射（0..3，对应 R0..R3）。查不到的输入一律 missing，绝不猜档。
const FACTOR_MAPPINGS = Object.freeze({
  inherent_risk: Object.freeze({
    high_risk: 3,
    reversible_write: 1,
    read: 0,
  }),
  reversibility: Object.freeze({
    irreversible: 3,
    hard_to_reverse: 2,
    reversible: 1,
    read_only: 0,
  }),
  blast_radius: Object.freeze({
    global: 3,
    user: 2,
    task: 1,
  }),
  data_sensitivity: Object.freeze({
    secret: 3,
    sensitive: 2,
    public: 0,
  }),
  // 来源污点：与 taint-policy 同口径。只有 verified 是「已知干净」（0 档）；
  // unknown（任务上没有污点字段，缺信息）与 unverified（有标签但未验证）都按
  // missing 处理、走整体升一级——不把「未验证」伪装成某个确定档位。
  source_taint: Object.freeze({
    verified: 0,
  }),
  external_side_effects: Object.freeze({
    true: 3,
    false: 0,
  }),
  // 失败代价映射最高只到 2 档：代价高说明要更严的验证与审批，但等级上限还取决于
  // 动作本身的因子（风险/可逆性/外部副作用）；映射本身不产生 R3，缺信息升级
  // 走通用规则。
  failure_cost: Object.freeze({
    high: 2,
    medium: 1,
    low: 0,
  }),
});

function levelRank(level) {
  const index = LEVELS.indexOf(String(level || ''));
  return index === -1 ? -1 : index;
}

function rankLevel(rank) {
  return LEVELS[Math.max(0, Math.min(LEVELS.length - 1, rank))];
}

function mapFactor(name, value) {
  if (value === undefined || value === null || value === '') {
    return { level: null, missing: true, reason: `${name}:missing` };
  }
  const mapping = FACTOR_MAPPINGS[name];
  const key = String(value);
  if (!Object.prototype.hasOwnProperty.call(mapping, key)) {
    return { level: null, missing: true, reason: `${name}:unrecognized_value` };
  }
  return { level: mapping[key], missing: false, reason: `${name}:${key}` };
}

/**
 * 七因子评估。等级 = max(已知因子) ，有任何未知因子再 +1（封顶 R3）。
 * inherent_risk 的输入是工具风险标签数组（取最高）+ 任务类型是否高风险；
 * source_taint 输入是任务污点标签数组（取最高）。
 */
function assessRisk({
  highRiskTaskType = false,
  taskType = null,
  toolRisks = null,
  reversibility = null,
  blastRadius = null,
  dataSensitivity = null,
  taintLabels = null,
  externalSideEffects = null,
  failureCost = null,
  claimedLevel = null,
} = {}) {
  const factors = {};
  const reasons = [];

  // 因子 1 风险：任务类型在库里就是高风险（ HIGH_RISK_TASK_TYPES）→ 直接 R3；
  // 否则取工具风险标签的最高档。两者都没有 → 按只读边界记 0（不是 missing）：
  // 任务类型总是已知的，这里不会出现「全因子未知」。
  const toolLevels = (Array.isArray(toolRisks) ? toolRisks : [])
    .map(label => mapFactor('inherent_risk', label))
    .filter(item => !item.missing)
    .map(item => item.level);
  const unrecognisedTools = (Array.isArray(toolRisks) ? toolRisks : []).filter(
    label => !Object.prototype.hasOwnProperty.call(FACTOR_MAPPINGS.inherent_risk, String(label))
  );
  let inherent;
  if (highRiskTaskType || toolLevels.includes(3)) {
    inherent = { level: 3, missing: false, reason: 'inherent_risk:high_risk' };
  } else if (unrecognisedTools.length) {
    // 工具标签不认识 → 缺信息，交给整体升一级，而不是猜成只读。
    inherent = { level: null, missing: true, reason: 'inherent_risk:unrecognized_tool_risk' };
  } else if (toolLevels.length) {
    inherent = {
      level: Math.max(...toolLevels),
      missing: false,
      reason: `inherent_risk:tools_${rankLevel(Math.max(...toolLevels))}`,
    };
  } else if (toolRisks !== null && toolRisks !== undefined) {
    // 显式给了工具清单且没有未识别标签：空清单 = 无工具边界，按只读 0 档。
    inherent = { level: 0, missing: false, reason: 'inherent_risk:no_tools' };
  } else if (taskType !== null && taskType !== undefined) {
    // 只知道任务类型、没有工具信号：任务类型按低风险 0 档（known），
    // 其余未知因子走整体升一级——不会在这里误判成全未知 R3。
    inherent = { level: 0, missing: false, reason: 'inherent_risk:low_risk_task_type' };
  } else {
    inherent = { level: null, missing: true, reason: 'inherent_risk:missing' };
  }
  factors.inherent_risk = inherent;
  reasons.push(inherent.reason);

  factors.reversibility = mapFactor('reversibility', reversibility);
  reasons.push(factors.reversibility.reason);
  factors.blast_radius = mapFactor('blast_radius', blastRadius);
  reasons.push(factors.blast_radius.reason);
  factors.data_sensitivity = mapFactor('data_sensitivity', dataSensitivity);
  reasons.push(factors.data_sensitivity.reason);

  // 因子 5 来源污点：全部标签都是 verified 才算「已知干净」（0 档）；
  // 只要混入任何非 verified 标签（unknown/unverified/未知标签）就按 missing
  // 处理、走整体升一级——部分验证过的来源不能按干净计。
  let taint;
  if (!Array.isArray(taintLabels)) {
    taint = { level: null, missing: true, reason: 'source_taint:missing' };
  } else if (taintLabels.length === 0) {
    taint = { level: null, missing: true, reason: 'source_taint:no_labels' };
  } else if (taintLabels.every(label => label === 'verified')) {
    taint = { level: 0, missing: false, reason: 'source_taint:verified' };
  } else {
    taint = { level: null, missing: true, reason: 'source_taint:not_fully_verified' };
  }
  factors.source_taint = taint;
  reasons.push(taint.reason);

  // 因子 6 外部副作用：布尔值；未提供 → missing。
  factors.external_side_effects =
    externalSideEffects === true
      ? { level: 3, missing: false, reason: 'external_side_effects:true' }
      : externalSideEffects === false
        ? { level: 0, missing: false, reason: 'external_side_effects:false' }
        : { level: null, missing: true, reason: 'external_side_effects:missing' };
  reasons.push(factors.external_side_effects.reason);

  factors.failure_cost = mapFactor('failure_cost', failureCost);
  reasons.push(factors.failure_cost.reason);

  const knownLevels = Object.values(factors)
    .filter(item => !item.missing)
    .map(item => item.level);
  const missingFactors = FACTOR_NAMES.filter(name => factors[name].missing);
  // 全未知只指「连任务类型都没有」的调用；有任务类型但因子全缺失
  //（如工具标签不认识）按低风险基线 + 缺信息升一级，不是 R3。
  const nothingKnown = knownLevels.length === 0 && (taskType === null || taskType === undefined);

  // 取最高适用等级；缺信息升一级；全未知按 R3 收口。
  let rank;
  if (nothingKnown) {
    rank = LEVELS.length - 1;
  } else if (knownLevels.length) {
    rank = Math.max(...knownLevels);
  } else {
    rank = 0;
  }
  const escalated = !nothingKnown && missingFactors.length > 0;
  if (escalated) rank += 1;
  const level = rankLevel(rank);

  // Agent 不得自行降级：自称等级只记录、只对比，永不参与计算。
  const claimedRank = claimedLevel === null || claimedLevel === undefined
    ? null
    : levelRank(claimedLevel);
  const claimedLevelRejected =
    claimedRank !== null && claimedRank !== -1 && claimedRank < levelRank(level);

  return {
    policyVersion: RISK_POLICY_VERSION,
    level,
    factors,
    missingFactors,
    escalated,
    nothingKnown,
    reasons,
    taskType: taskType === null || taskType === undefined ? null : String(taskType),
    claimedLevel:
      claimedRank === null || claimedRank === -1 ? null : rankLevel(claimedRank),
    claimedLevelRejected,
    assessedAt: new Date().toISOString(),
  };
}

/**
 * 等级 → 最低验证组合矩阵（本仓库裁决，映射到既有验证闭环的档位）：
 *  - deterministic：确定性校验（verification-loop.verifyDeterministic），绝对下限；
 *  - evidenceChecked：证据可解析（trustLevel evidence_checked）；
 *  - independentReview：独立审校（requiresReview）；
 *  - approvalOnWeakEvidence：R3 且证据不足时转人工审批（复用 review.escalate）。
 */
function minimumVerification(level) {
  const rank = levelRank(level);
  if (rank === -1) {
    throw new Error(`minimumVerification: 未知风险等级 ${String(level)}`);
  }
  return Object.freeze({
    level: rankLevel(rank),
    deterministic: true,
    evidenceChecked: rank >= 1,
    independentReview: rank >= 2,
    approvalOnWeakEvidence: rank >= 3,
  });
}

/**
 * R2/R3 门槛不可被成本或延迟降级（§13）。
 * requested 是调用方想要的验证组合；costPressure/latencyPressure 只能作为
 * 理由记录，不能改变判定。确定性校验在任何等级都关不掉。
 */
function enforceVerificationFloor({
  level,
  requested = {},
  costPressure = false,
  latencyPressure = false,
} = {}) {
  const floor = minimumVerification(level);
  const rank = levelRank(level);
  const req = {
    deterministic: requested.deterministic !== false,
    evidenceChecked: requested.evidenceChecked === true,
    independentReview: requested.independentReview === true,
  };
  if (!req.deterministic) {
    return {
      allowed: false,
      reason: 'deterministic_floor_mandatory',
      verification: { ...floor },
      requested: req,
      policyVersion: RISK_POLICY_VERSION,
    };
  }
  if (rank >= 2 && !req.independentReview) {
    return {
      allowed: false,
      reason: costPressure || latencyPressure
        ? 'r2_r3_floor_not_downgradable_by_cost_or_latency'
        : 'r2_r3_floor_requires_independent_review',
      verification: { ...floor },
      requested: req,
      policyVersion: RISK_POLICY_VERSION,
    };
  }
  return {
    allowed: true,
    reason: req.independentReview
      ? 'floor_met_or_exceeded'
      : `below_r2_no_review_floor`,
    verification: {
      ...floor,
      evidenceChecked: floor.evidenceChecked || req.evidenceChecked,
      independentReview: floor.independentReview || req.independentReview,
    },
    requested: req,
    policyVersion: RISK_POLICY_VERSION,
  };
}

module.exports = {
  RISK_POLICY_VERSION,
  LEVELS,
  FACTOR_NAMES,
  FACTOR_MAPPINGS,
  assessRisk,
  minimumVerification,
  enforceVerificationFloor,
  levelRank,
};
