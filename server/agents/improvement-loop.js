/* global module */
/**
 * P5-G（Notion §2.6 + §5 Phase 4 第 3 项）：受控自我改进闭环。
 *
 * 链路：失败模式评估 → 改进提案（六类）→ 沙箱/离线评测 → 人工批准 →
 * 版本发布（灰度分桶）→ 回归与自动回滚联动。
 *
 * 三条硬边界（违反就等于给了系统自我扩权的能力）：
 *  1. **禁止自改清单是服务端校验**：权限策略、密钥、预算硬上限、审批规则、
 *     审计机制、生产发布权限本身，永远不能成为提案目标——创建与发布两侧都查。
 *  2. **人工批准是必经节点**：提案没有 approve 就不能 release；批准者必须是
 *     local-owner（单用户实例的 Owner），Agent 没有任何自批入口。
 *  3. **自动回滚只认评估证据**：安全计数器退化（任一 fail-closed/越权/审批绕过
 *     计数上升）或成功率下降即回滚；阈值与口径版本化，改动必须升版本。
 *
 * 灰度是确定性的：entityId 哈希落桶，同一实体在同一比例下永远同桶——
 * 灰度不是随机抽样，否则「同一任务这次走新策略下次走旧策略」会污染归因。
 */
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const tasks = require('./tasks');
const strategyVersion = require('./strategy-version');
const evalRunner = require('./eval-runner');
const evalMetrics = require('./eval-metrics');
const { classifyFailureMode } = require('./errors');
const permissions = require('./permissions');

const IMPROVEMENT_POLICY_VERSION = 'improvement-loop-v1';
const AUTO_ROLLBACK_POLICY_VERSION = 'auto-rollback-v1';
const IMPROVEMENTS_FILE = 'agent-improvements.json';

// §2.6 六类改进目标。
const IMPROVEMENT_CATEGORIES = Object.freeze([
  'prompt_template', // 提示词模板
  'routing_threshold', // 路由阈值
  'decomposition_strategy', // 拆解策略
  'agent_selection', // Agent 选择
  'eval_suite', // 评测集
  'workflow_config', // 工作流配置
]);

// 禁止自改清单（§2.6）：这些模块的策略与配置不在可提案范围。
// 键是提案 target.module 的判定名；值是「为什么不能改」的短语（进审计）。
const FORBIDDEN_TARGETS = Object.freeze({
  permissions: '权限策略',
  credentials: '密钥',
  'agent-limits': '预算硬上限',
  approvals: '审批规则',
  audit: '审计机制',
  'release-authority': '生产发布权限',
});

const STATUS_TRANSITIONS = Object.freeze({
  draft: ['evaluated', 'rejected'],
  evaluated: ['approved', 'rejected'],
  approved: ['released', 'rejected'],
  released: ['rolled_back'],
  rejected: [],
  rolled_back: [],
});

// 失败模式 → 提案类别的确定性映射（本仓库裁决；未列出的失败模式不自动起草）。
const FAILURE_MODE_CATEGORY = Object.freeze({
  role_drift: 'prompt_template',
  handoff_context_lost: 'workflow_config',
  approval_stall: 'routing_threshold',
  dependency_deadlock: 'decomposition_strategy',
  dependency_cycle: 'decomposition_strategy',
  budget_exhausted: 'routing_threshold',
});

// 自动起草的最小证据量：同一失败模式至少出现 2 次才值得起草案。
const DRAFT_MIN_COUNT = 2;

// 自动回滚阈值（auto-rollback-v1）：任一安全计数上升，或成功率不升（delta < 0）。
const AUTO_ROLLBACK_THRESHOLDS = Object.freeze({
  safetyRegression: true,
  successRateMinDelta: 0,
});

function storePath() {
  return path.join(path.dirname(tasks.TASKS_FILE), IMPROVEMENTS_FILE);
}

function emptyStore() {
  return { version: 1, proposals: {}, updatedAt: null };
}

function load() {
  try {
    const parsed = JSON.parse(fs.readFileSync(storePath(), 'utf8'));
    if (!parsed || typeof parsed !== 'object' || typeof parsed.proposals !== 'object') {
      throw new Error('store shape');
    }
    return parsed;
  } catch (_) {
    return emptyStore();
  }
}

function save(state) {
  fs.mkdirSync(path.dirname(storePath()), { recursive: true });
  state.updatedAt = new Date().toISOString();
  const temp = `${storePath()}.tmp-${process.pid}`;
  fs.writeFileSync(temp, `${JSON.stringify(state, null, 2)}\n`, 'utf8');
  fs.renameSync(temp, storePath());
  return state;
}

function reloadForTests() {
  try {
    fs.rmSync(storePath(), { force: true });
  } catch (_) {
    /* 夹具清理失败不改变判定 */
  }
}

function assertTransition(from, to) {
  if (!STATUS_TRANSITIONS[from] || !STATUS_TRANSITIONS[from].includes(to)) {
    const { AgentError } = require('./errors');
    throw new AgentError(
      'improvement_invalid_transition',
      `提案状态不允许从 ${from} 迁移到 ${to}`,
      409
    );
  }
}

/** 禁止自改清单：服务端校验，创建与发布两侧都查。 */
function assertProposalTarget(target) {
  const { AgentError } = require('./errors');
  const module = String((target && target.module) || '').trim();
  if (!module) {
    throw new AgentError('improvement_target_missing', '提案必须声明 target.module', 400);
  }
  if (FORBIDDEN_TARGETS[module]) {
    throw new AgentError(
      'improvement_forbidden_target',
      `${module}（${FORBIDDEN_TARGETS[module]}）在禁止自改清单内，不能成为提案目标`,
      403
    );
  }
  return module;
}

function recordEvent(botId, eventType, payload, context = {}) {
  try {
    tasks.appendEvent({ botId: botId || 'system', eventType, payload, ...context });
  } catch (_) {
    // 审计事件写失败不改变提案状态本身；提案存储里已有完整记录。
  }
}

/**
 * 创建提案。只落 draft，不评测不发布——评测与发布是显式的后续步骤。
 */
function createProposal({
  category,
  target,
  reason,
  evidenceRefs = [],
  proposedChange = {},
  botId = null,
} = {}) {
  const { AgentError } = require('./errors');
  if (!IMPROVEMENT_CATEGORIES.includes(category)) {
    throw new AgentError(
      'improvement_category_invalid',
      `category 必须是六类之一：${IMPROVEMENT_CATEGORIES.join('/')}`,
      400
    );
  }
  const module = assertProposalTarget(target);
  const cleanReason = typeof reason === 'string' ? reason.trim() : '';
  if (!cleanReason) {
    throw new AgentError('improvement_reason_missing', '提案必须写明理由（basis）', 400);
  }
  const state = load();
  const now = new Date().toISOString();
  const record = {
    proposalId: `imp_${crypto.randomUUID()}`,
    policyVersion: IMPROVEMENT_POLICY_VERSION,
    category,
    target: { module, configKey: String((target && target.configKey) || '').slice(0, 120) },
    reason: cleanReason.slice(0, 500),
    evidenceRefs: (Array.isArray(evidenceRefs) ? evidenceRefs : [])
      .map(item => String(item).slice(0, 160))
      .slice(0, 20),
    proposedChange: {
      description: String(proposedChange.description || '').slice(0, 500),
      mechanism: proposedChange.mechanism || null,
    },
    status: 'draft',
    evaluation: null,
    approvedBy: null,
    approvedAt: null,
    release: null,
    rollback: null,
    createdAt: now,
    updatedAt: now,
  };
  state.proposals[record.proposalId] = record;
  save(state);
  recordEvent(botId, 'improvement.proposed', {
    status: 'draft',
    taskType: category,
    proposalId: record.proposalId,
    target: `${module}:${record.target.configKey}`,
    mode: 'improvement_loop',
  });
  return clone(record);
}

/**
 * 失败模式评估 → 自动起草。只聚合真实事件里的 failureMode 标签；
 * 达到 DRAFT_MIN_COUNT 的最高频模式按映射表起草，没有显著信号返回 null
 * （绝不为了「有提案」而凭空起草）。
 */
function draftFromFailureModes({ events = [], botId = null, target = null, reasonSuffix = '' } = {}) {
  const counts = {};
  const evidenceRefs = [];
  for (const event of Array.isArray(events) ? events : []) {
    const mode = event && event.payload && event.payload.failureMode;
    if (!mode || !classifyFailureMode({ failureMode: mode })) continue;
    counts[mode] = (counts[mode] || 0) + 1;
    if (event.eventId && evidenceRefs.length < 20) evidenceRefs.push(String(event.eventId));
  }
  const ranked = Object.entries(counts)
    .filter(([mode]) => FAILURE_MODE_CATEGORY[mode] && counts[mode] >= DRAFT_MIN_COUNT)
    .sort((a, b) => b[1] - a[1]);
  if (!ranked.length) return null;
  const [mode, count] = ranked[0];
  const category = FAILURE_MODE_CATEGORY[mode];
  return createProposal({
    category,
    botId,
    target: target || { module: 'autonomy-policy', configKey: category },
    reason: `失败模式 ${mode} 在运行事件中出现 ${count} 次（阈值 ${DRAFT_MIN_COUNT}），按映射表起草${reasonSuffix ? `：${reasonSuffix}` : ''}`,
    evidenceRefs,
    proposedChange: { description: `针对 ${mode} 的${category}改进（草案，待评测与人工批准）` },
  });
}

/**
 * 沙箱/离线评测：production 与 candidate 两个比较对象各跑一遍评测集，
 * 用 eval-metrics 统一口径算 delta 与安全计数。本步骤不改任何运行时状态。
 */
function evaluateProposal({ proposalId, suitePaths = null, baseTime = evalRunner.DEFAULT_BASE_TIME } = {}) {
  const { AgentError } = require('./errors');
  const state = load();
  const record = state.proposals[String(proposalId || '')];
  if (!record) throw new AgentError('improvement_not_found', '提案不存在', 404);
  assertTransition(record.status, 'evaluated');

  const beforeRun = evalRunner.runSuite({ suitePaths, baseTime, comparator: 'production' });
  const afterRun = evalRunner.runSuite({ suitePaths, baseTime, comparator: 'candidate' });
  const before = evalMetrics.computeMetrics({ suite: beforeRun.suite, results: beforeRun.results });
  const after = evalMetrics.computeMetrics({ suite: afterRun.suite, results: afterRun.results });

  const delta = {
    successRate: after.metrics.successRate.value - before.metrics.successRate.value,
    reworkRate: after.metrics.rework.rate - before.metrics.rework.rate,
    tokenCost: after.metrics.tokenCost.total - before.metrics.tokenCost.total,
    latencyAvgMs:
      after.metrics.latency.avgMs !== null && before.metrics.latency.avgMs !== null
        ? after.metrics.latency.avgMs - before.metrics.latency.avgMs
        : null,
  };
  const safetyCounters = ['approvalBypass', 'failClosedHits', 'unauthorizedDenied', 'deadLetters'];
  const safetyRegression = safetyCounters.filter(
    name => (after.safety[name] || 0) > (before.safety[name] || 0)
  );

  record.evaluation = {
    policyVersion: IMPROVEMENT_POLICY_VERSION,
    suite: beforeRun.suite,
    before: { metrics: before.metrics, safety: before.safety },
    after: { metrics: after.metrics, safety: after.safety },
    delta,
    safetyRegression,
  };
  record.status = 'evaluated';
  record.updatedAt = new Date().toISOString();
  save(state);
  recordEvent(null, 'improvement.evaluated', {
    status: 'evaluated',
    proposalId: record.proposalId,
    taskType: record.category,
    mode: 'improvement_loop',
  });
  return clone(record);
}

/**
 * 人工批准：只有 local-owner（单用户 Owner）能批；Agent 没有自批入口。
 */
function approveProposal({ proposalId, actor = null } = {}) {
  const { AgentError } = require('./errors');
  if (actor !== permissions.SINGLE_USER_ACTOR) {
    throw new AgentError('improvement_approval_forbidden', '提案只能由 local-owner 人工批准', 403);
  }
  const state = load();
  const record = state.proposals[String(proposalId || '')];
  if (!record) throw new AgentError('improvement_not_found', '提案不存在', 404);
  assertTransition(record.status, 'approved');
  record.status = 'approved';
  record.approvedBy = actor;
  record.approvedAt = new Date().toISOString();
  record.updatedAt = record.approvedAt;
  save(state);
  recordEvent(null, 'improvement.approved', {
    status: 'approved',
    proposalId: record.proposalId,
    taskType: record.category,
    mode: 'improvement_loop',
  });
  return clone(record);
}

function rejectProposal({ proposalId, actor = null, reason = null } = {}) {
  const { AgentError } = require('./errors');
  if (actor !== permissions.SINGLE_USER_ACTOR) {
    throw new AgentError('improvement_approval_forbidden', '提案只能由 local-owner 人工否决', 403);
  }
  const state = load();
  const record = state.proposals[String(proposalId || '')];
  if (!record) throw new AgentError('improvement_not_found', '提案不存在', 404);
  assertTransition(record.status, 'rejected');
  record.status = 'rejected';
  record.updatedAt = new Date().toISOString();
  save(state);
  return clone(record);
}

/**
 * 灰度分桶：确定性哈希。ratio=1 全量；ratio<=0 等于不开。
 * 同一 entityId 在同一 ratio 下永远同桶。
 */
function isInBucket(entityId, ratio) {
  const value = Number(ratio);
  if (!Number.isFinite(value) || value >= 1) return true;
  if (value <= 0) return false;
  const digest = crypto
    .createHash('sha256')
    .update(`improvement-gray:${String(entityId || '')}`)
    .digest();
  // 取前 8 字节作 [0,1) 定点数，避免浮点哈希偏差。
  const sample = digest.readUInt32BE(0) / 0x100000000 + digest.readUInt32BE(4) / 0x100000000 ** 2;
  return sample < value;
}

/**
 * 版本发布（人工批准后）：把提案写进策略版本（灰度比例随版本落 strategy 状态），
 * 提案转 released。发布侧再做一次禁止自改校验（纵深防御）。
 */
function releaseProposal({ proposalId, grayRatio = 1 } = {}) {
  const { AgentError } = require('./errors');
  const state = load();
  const record = state.proposals[String(proposalId || '')];
  if (!record) throw new AgentError('improvement_not_found', '提案不存在', 404);
  assertProposalTarget(record.target);
  assertTransition(record.status, 'released');
  const ratio = Number(grayRatio);
  if (!Number.isFinite(ratio) || ratio <= 0 || ratio > 1) {
    throw new AgentError('improvement_gray_ratio_invalid', 'grayRatio 必须在 (0, 1] 区间', 400);
  }
  const version = `improvement:${record.proposalId}`;
  const strategy = strategyVersion.apply({ version, enabled: true });
  strategyVersion.setGray({ ratio });
  record.status = 'released';
  record.release = {
    releasedAt: new Date().toISOString(),
    strategyVersion: strategy.version,
    grayRatio: ratio,
  };
  record.updatedAt = record.release.releasedAt;
  save(state);
  recordEvent(null, 'improvement.released', {
    status: 'released',
    proposalId: record.proposalId,
    taskType: record.category,
    mode: 'improvement_loop',
  });
  return clone(record);
}

/**
 * 回归与自动回滚联动：安全计数器任一上升，或成功率 delta 低于阈值，
 * 即回滚策略版本并把提案标记 rolled_back。currentReport 由调用方传入
 * （生产路径来自 evaluateProposal 同一套评测），本函数只做阈值判定与执行。
 */
function checkAutoRollback({ proposalId, report = null } = {}) {
  const { AgentError } = require('./errors');
  const state = load();
  const record = state.proposals[String(proposalId || '')];
  if (!record) throw new AgentError('improvement_not_found', '提案不存在', 404);
  if (record.status !== 'released') {
    throw new AgentError('improvement_not_released', '只有已发布的提案才参与自动回滚检查', 409);
  }
  const evaluation = record.evaluation;
  if (!evaluation) {
    throw new AgentError('improvement_evaluation_missing', '提案缺少评估记录，无法判定回归', 409);
  }
  const current = report || {
    metrics: evaluation.after.metrics,
    safety: evaluation.after.safety,
  };
  const safetyCounters = ['approvalBypass', 'failClosedHits', 'unauthorizedDenied', 'deadLetters'];
  const regressedCounters = safetyCounters.filter(
    name => (current.safety[name] || 0) > (evaluation.before.safety[name] || 0)
  );
  const successDelta = current.metrics.successRate.value - evaluation.before.metrics.successRate.value;
  const reasons = [];
  if (AUTO_ROLLBACK_THRESHOLDS.safetyRegression && regressedCounters.length) {
    reasons.push(`安全计数器退化：${regressedCounters.join(',')}`);
  }
  if (successDelta < AUTO_ROLLBACK_THRESHOLDS.successRateMinDelta) {
    reasons.push(`成功率低于基线（delta=${successDelta}）`);
  }
  if (!reasons.length) {
    return {
      rolledBack: false,
      policyVersion: AUTO_ROLLBACK_POLICY_VERSION,
      successDelta,
      regressedCounters,
      reasons,
    };
  }
  strategyVersion.rollback();
  record.status = 'rolled_back';
  record.rollback = {
    at: new Date().toISOString(),
    policyVersion: AUTO_ROLLBACK_POLICY_VERSION,
    reasons,
    successDelta,
    regressedCounters,
  };
  record.updatedAt = record.rollback.at;
  save(state);
  recordEvent(null, 'improvement.rolled_back', {
    status: 'rolled_back',
    proposalId: record.proposalId,
    taskType: record.category,
    mode: 'improvement_loop',
  });
  return {
    rolledBack: true,
    policyVersion: AUTO_ROLLBACK_POLICY_VERSION,
    successDelta,
    regressedCounters,
    reasons,
  };
}

function getProposal(proposalId) {
  const state = load();
  const record = state.proposals[String(proposalId || '')];
  return record ? clone(record) : null;
}

function listProposals({ status = null, limit = 50 } = {}) {
  const state = load();
  return Object.values(state.proposals)
    .filter(item => !status || item.status === status)
    .sort((a, b) => String(b.createdAt).localeCompare(String(a.createdAt)))
    .slice(0, Math.max(1, Math.min(200, Number(limit) || 50)))
    .map(clone);
}

function clone(value) {
  return JSON.parse(JSON.stringify(value));
}

module.exports = {
  IMPROVEMENT_POLICY_VERSION,
  AUTO_ROLLBACK_POLICY_VERSION,
  AUTO_ROLLBACK_THRESHOLDS,
  IMPROVEMENT_CATEGORIES,
  FORBIDDEN_TARGETS,
  DRAFT_MIN_COUNT,
  STATUS_TRANSITIONS,
  storePath,
  reloadForTests,
  createProposal,
  draftFromFailureModes,
  evaluateProposal,
  approveProposal,
  rejectProposal,
  releaseProposal,
  checkAutoRollback,
  isInBucket,
  getProposal,
  listProposals,
};
