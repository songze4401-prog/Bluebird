/* global module */
/**
 * P5-A（Notion §14）：五类可比较基线对象与配置记录。
 *
 * 原文要求：基线不锁死为单一方案，每轮可比较「当前生产 / 主分支 Runtime、
 * 单 Agent 快速路径、当前 Runtime + 指定能力、关闭某机制的消融版本、候选架构」，
 * 并且报告必须记录代码 commit、模型与参数、提示词版本、工具权限、数据集版本、
 * 预算和评测时间，**不同配置不得混称同一基线**。
 *
 * 本模块只定义「比较对象 + 配置身份 + 对照报告」三件事，执行仍由 eval-runner 完成，
 * 指标仍由 eval-metrics 计算，避免第二套评测口径。
 *
 * 机制开关刻意只取 runner 真正听得懂的三个：autonomyPolicy / teamReview / replan。
 * 未接线的机制不允许写进 ablating，否则"消融"会变成一句空话。
 */
const crypto = require('crypto');

const COMPARATOR_POLICY_VERSION = 'p5a-comparators-v1';
const KINDS = Object.freeze(['production', 'single_agent_fast_path', 'runtime_with_capability', 'ablation', 'candidate']);
const MECHANISMS = Object.freeze(['autonomyPolicy', 'teamReview', 'replan']);

// 报告必须带上的配置字段（§14 原句逐项）。缺任一项就拒绝出报告，
// 而不是留 null 让人误以为两次跑的口径相同。
const REQUIRED_CONFIG_FIELDS = Object.freeze([
  'codeCommit',
  'model',
  'modelParams',
  'promptVersion',
  'toolPermissions',
  'datasetVersion',
  'budget',
  'evaluatedAt',
]);

// 身份字段：参与"是不是同一基线"判定的部分。刻意排除 codeCommit 与 evaluatedAt
// ——代码提交变化正是被测对象，评测时间必然不同。
const IDENTITY_FIELDS = Object.freeze([
  'model',
  'modelParams',
  'promptVersion',
  'toolPermissions',
  'datasetVersion',
  'budget',
]);

const REGISTRY = Object.freeze({
  production: Object.freeze({
    id: 'production',
    kind: 'production',
    label: '当前生产 / 主分支 Runtime（自治策略关闭，单路径、不组队、不重规划）',
    enabled: Object.freeze({ autonomyPolicy: false, teamReview: false, replan: false }),
    forceSingle: true,
    ablating: Object.freeze([]),
  }),
  single_agent_fast_path: Object.freeze({
    id: 'single_agent_fast_path',
    kind: 'single_agent_fast_path',
    label: '单 Agent 快速路径（记录计划与判定，但强制单执行体）',
    enabled: Object.freeze({ autonomyPolicy: true, teamReview: false, replan: false }),
    forceSingle: true,
    ablating: Object.freeze(['teamReview', 'replan']),
  }),
  runtime_with_capability: Object.freeze({
    id: 'runtime_with_capability',
    kind: 'runtime_with_capability',
    label: '当前 Runtime + 指定能力（启用独立复核子任务，不启用重规划）',
    enabled: Object.freeze({ autonomyPolicy: true, teamReview: true, replan: false }),
    forceSingle: false,
    ablating: Object.freeze(['replan']),
  }),
  candidate: Object.freeze({
    id: 'candidate',
    kind: 'candidate',
    label: '候选架构（自治策略 + 独立复核 + 受控重规划全部启用）',
    enabled: Object.freeze({ autonomyPolicy: true, teamReview: true, replan: true }),
    forceSingle: false,
    ablating: Object.freeze([]),
  }),
});

function canonicalize(value) {
  if (Array.isArray(value)) return `[${value.map(canonicalize).join(',')}]`;
  if (value && typeof value === 'object') {
    return `{${Object.keys(value).sort().map(key => `${JSON.stringify(key)}:${canonicalize(value[key])}`).join(',')}}`;
  }
  return JSON.stringify(value === undefined ? null : value);
}

/**
 * 归一化比较对象。ablation 必须显式声明关掉哪些机制，且不允许三个全关
 * （那已经是 production），也不允许关到只剩 0 个机制之外的非法值。
 */
function resolveComparator(input) {
  if (!input) throw new Error('缺少比较对象配置');
  if (typeof input === 'string') input = { id: input };
  const id = String(input.id || '').trim();
  const kind = String(input.kind || id).trim();
  if (!KINDS.includes(kind)) throw new Error(`未知比较对象类型：${kind}`);
  if (kind === 'ablation') {
    const ablating = Array.isArray(input.ablating) ? input.ablating.map(String) : [];
    if (ablating.length === 0) throw new Error('ablation 必须显式声明 ablating 关闭哪些机制');
    const unknown = ablating.filter(name => !MECHANISMS.includes(name));
    if (unknown.length) throw new Error(`ablation 含未接线机制：${unknown.join('、')}`);
    if (ablating.length === MECHANISMS.length) throw new Error('ablation 不能关闭全部机制，那等于 production');
    const enabled = { autonomyPolicy: true, teamReview: true, replan: true };
    for (const name of ablating) enabled[name] = false;
    assertMechanismCoherence(enabled);
    return {
      id: String(id || `ablation:${ablating.join('+')}`),
      kind: 'ablation',
      label: `消融版本（关闭：${ablating.join('、')}）`,
      enabled,
      forceSingle: input.forceSingle === true,
      ablating: Array.from(new Set(ablating)).sort(),
      policyVersion: COMPARATOR_POLICY_VERSION,
    };
  }
  const base = REGISTRY[kind];
  if (!base) throw new Error(`注册表缺少比较对象：${kind}`);
  if (id && id !== kind && id !== base.id) throw new Error(`${kind} 的 id 必须是 ${base.id}`);
  return {
    id: base.id,
    kind: base.kind,
    label: base.label,
    enabled: assertMechanismCoherence({ ...base.enabled }),
    forceSingle: base.forceSingle,
    ablating: Array.from(new Set(base.ablating)).sort(),
    policyVersion: COMPARATOR_POLICY_VERSION,
  };
}

function isEnabled(comparator, mechanism) {
  if (!MECHANISMS.includes(mechanism)) throw new Error(`未知机制：${mechanism}`);
  return comparator.enabled[mechanism] === true;
}

/**
 * 机制之间的既有依赖：独立复核子任务由自治策略的组队判定产生，
 * 关掉策略却声明开着复核只会得到一个永不触发的空开关——这种对照直接拒绝，
 * 免得报告把「没有差异」说成「该机制无效果」。
 */
function assertMechanismCoherence(enabled) {
  if (enabled.teamReview && !enabled.autonomyPolicy) {
    throw new Error('teamReview 依赖 autonomyPolicy 的组队判定，不能单独开启');
  }
  return enabled;
}

/**
 * 构造报告配置记录。字段缺失、类型错误或权限数组缺省都直接拒绝：
 * 「不同配置不得混称同一基线」的前提是配置被完整记录下来。
 */
function buildConfig(comparator, fields = {}) {
  const missing = REQUIRED_CONFIG_FIELDS.filter(name => fields[name] === undefined || fields[name] === null || fields[name] === '');
  if (missing.length) throw new Error(`基线配置记录缺少字段：${missing.join('、')}`);
  const model = String(fields.model);
  if (!fields.modelParams || typeof fields.modelParams !== 'object' || Array.isArray(fields.modelParams)) {
    throw new Error('modelParams 必须是对象（无参数也要显式给 {}）');
  }
  if (!Array.isArray(fields.toolPermissions)) throw new Error('toolPermissions 必须是数组（无权限也要显式给 []）');
  if (!fields.budget || typeof fields.budget !== 'object' || Array.isArray(fields.budget)) {
    throw new Error('budget 必须是对象（tokenCapPerCase、deadlineMs 等）');
  }
  const evaluatedAtMs = Date.parse(fields.evaluatedAt);
  if (!Number.isFinite(evaluatedAtMs)) throw new Error('evaluatedAt 必须是合法时间');
  const config = {
    comparatorId: comparator.id,
    comparatorKind: comparator.kind,
    mechanisms: { ...comparator.enabled },
    ablating: [...comparator.ablating],
    codeCommit: String(fields.codeCommit),
    model,
    modelParams: { ...fields.modelParams },
    promptVersion: String(fields.promptVersion),
    toolPermissions: fields.toolPermissions.map(String).sort(),
    datasetVersion: String(fields.datasetVersion),
    budget: { ...fields.budget },
    evaluatedAt: new Date(evaluatedAtMs).toISOString(),
    policyVersion: COMPARATOR_POLICY_VERSION,
  };
  return { ...config, identity: identityOf(config) };
}

function identityOf(config) {
  const subset = {};
  for (const field of IDENTITY_FIELDS) subset[field] = config[field];
  subset.comparatorKind = config.comparatorKind;
  subset.comparatorId = config.comparatorId;
  subset.mechanisms = config.mechanisms;
  subset.ablating = config.ablating;
  return crypto.createHash('sha256').update(canonicalize(subset)).digest('hex');
}

/** 逐字段列出差异，供报告直接写清"这不是同一基线的复现，是换配置的对照"。 */
function baselineMismatch(before, after) {
  const fields = [];
  for (const field of IDENTITY_FIELDS) {
    if (canonicalize(before[field]) !== canonicalize(after[field])) fields.push(field);
  }
  if (before.comparatorId !== after.comparatorId) fields.push('comparatorId');
  if (canonicalize(before.mechanisms) !== canonicalize(after.mechanisms)) fields.push('mechanisms');
  if (canonicalize(before.ablating) !== canonicalize(after.ablating)) fields.push('ablating');
  return fields;
}

/**
 * 对照报告：把两个带配置的快照放在一起。
 * sameBaseline=true 才是「同一基线复现」；false 时必须叫「配置对照」，
 * 且报告里要同时列出两个身份，禁止只报差值不报配置。
 */
function compareReports(before, after, { diff } = {}) {
  if (!before || !after) throw new Error('对照报告需要两份快照');
  const beforeConfig = before.config || null;
  const afterConfig = after.config || null;
  if (!beforeConfig || !afterConfig) throw new Error('快照缺少基线配置记录，无法判定是否同一基线');
  const mismatched = baselineMismatch(beforeConfig, afterConfig);
  const changes = diff(before, after);
  return {
    comparisonKind: mismatched.length === 0 ? 'same_baseline_replay' : 'config_change',
    sameBaseline: mismatched.length === 0,
    mismatchedFields: mismatched,
    before: {
      comparator: { id: beforeConfig.comparatorId, kind: beforeConfig.comparatorKind, mechanisms: beforeConfig.mechanisms, ablating: beforeConfig.ablating },
      codeCommit: beforeConfig.codeCommit,
      identity: beforeConfig.identity,
    },
    after: {
      comparator: { id: afterConfig.comparatorId, kind: afterConfig.comparatorKind, mechanisms: afterConfig.mechanisms, ablating: afterConfig.ablating },
      codeCommit: afterConfig.codeCommit,
      identity: afterConfig.identity,
    },
    changes,
  };
}

/**
 * N 路对照矩阵（纯函数）：以 production 为参照，逐个比较对象给出关键指标差与安全退化。
 * 每个 comparator 的快照必须由**独立数据目录**的一次运行产出（safety 指标读的是
 * 任务事件聚合，同进程混跑会互相污染），本函数只负责汇总与判定。
 */
function compareMatrix({ reference, candidates, diff }) {
  if (!reference || !Array.isArray(candidates)) throw new Error('compareMatrix 需要参照快照与候选数组');
  const rows = candidates.map(candidate => compareReports(reference, candidate, { diff }));
  const improved = rows.filter(row => row.changes.metrics.successRate.change === 'improved').map(row => row.after.comparator.id);
  const degradedSafety = rows.filter(row => row.changes.safetyDegraded).map(row => row.after.comparator.id);
  const eligible = rows.filter(row => row.changes.metrics.successRate.change === 'improved' && !row.changes.safetyDegraded)
    .map(row => row.after.comparator.id);
  return {
    reference: { id: (reference.config && reference.config.comparatorId) || null, identity: reference.config ? reference.config.identity : null },
    rows: rows.map(row => ({
      comparator: row.after.comparator,
      comparisonKind: row.comparisonKind,
      successRate: row.changes.metrics.successRate,
      reworkRate: row.changes.metrics.reworkRate,
      tokenCostTotal: row.changes.metrics.tokenCostTotal,
      latencyAvgMs: row.changes.metrics.latencyAvgMs,
      safetyDegraded: row.changes.safetyDegraded,
      safetyRegressions: row.changes.safetyRegressions,
      tokenComparable: row.changes.tokenComparable,
      mismatchedFields: row.mismatchedFields,
    })),
    summary: {
      candidatesCompared: rows.length,
      improved,
      degradedSafety,
      // 原文验收句：相对基线有可重复改善且安全指标不退化，才算可升级。
      upgradeEligible: eligible,
    },
  };
}

module.exports = {
  COMPARATOR_POLICY_VERSION,
  IDENTITY_FIELDS,
  KINDS,
  MECHANISMS,
  REGISTRY,
  REQUIRED_CONFIG_FIELDS,
  baselineMismatch,
  buildConfig,
  canonicalize,
  compareMatrix,
  compareReports,
  identityOf,
  isEnabled,
  resolveComparator,
};
