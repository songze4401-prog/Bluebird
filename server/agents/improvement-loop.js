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
// 匹配用归一化 + 词边界前缀（见 isForbiddenTargetModule），不是精确字符串——
// `permissions.v2` / `permission` / `server/agents/permissions.js` 这类变体
// 必须同样命中，否则清单可被改名绕过。
const FORBIDDEN_TARGETS = Object.freeze({
  permissions: '权限策略',
  credentials: '密钥',
  'agent-limits': '预算硬上限',
  approvals: '审批规则',
  audit: '审计机制',
  'release-authority': '生产发布权限',
});

// 常见别名/单复数归一到清单键。
const TARGET_ALIASES = Object.freeze({
  permission: 'permissions',
  credential: 'credentials',
  secret: 'credentials',
  secrets: 'credentials',
  budget: 'agent-limits',
  'cost-tracker': 'agent-limits',
  'agent-limits-config': 'agent-limits',
  'approval-policy': 'approvals',
  'approval-rules': 'approvals',
  'audit-log': 'audit',
  'audit-policy': 'audit',
  'release-permission': 'release-authority',
  'production-release': 'release-authority',
});

/**
 * 目标模块名归一：去路径取末段、去扩展名、去版本后缀（-v2/.v2/@3）、
 * 小写、套别名。归一后的名字同时用于判定与落库（原始输入另存 moduleRaw 留审计）。
 */
function normalizeTargetModule(raw) {
  let name = String(raw || '').trim().toLowerCase();
  name = name.split(/[\\/]/).pop() || name;
  name = name.replace(/\.(js|ts|json|cjs|mjs)$/i, '');
  name = name.replace(/[.@-]v\d+$/i, '');
  name = name.trim();
  if (TARGET_ALIASES[name]) name = TARGET_ALIASES[name];
  return name;
}

/** 单段归一（路径逐段判定用）：去扩展名/版本后缀 + 别名。 */
function normalizeSegment(segment) {
  let name = String(segment || '').trim().toLowerCase();
  name = name.replace(/\.(js|ts|json|cjs|mjs)$/i, '');
  name = name.replace(/[.@-]v\d+$/i, '');
  name = name.trim();
  if (TARGET_ALIASES[name]) name = TARGET_ALIASES[name];
  return name;
}

/** 路径逐段判定：任一段（含别名/版本变体）命中清单键即禁止。 */
function forbiddenSegment(raw) {
  const segments = String(raw || '')
    .toLowerCase()
    .split(/[\\/]/)
    .map(normalizeSegment)
    .filter(Boolean);
  for (const name of segments) {
    const hit = Object.keys(FORBIDDEN_TARGETS).find(
      key =>
        name === key ||
        name.startsWith(`${key}.`) ||
        name.startsWith(`${key}/`) ||
        name.startsWith(`${key}:`) ||
        name.startsWith(`${key}-`)
    );
    if (hit) return { key: hit, segment: name };
  }
  return null;
}

/**
 * 禁止判定：归一后等于清单键，或以「键 + 词边界（. / : -）」开头。
 * 词边界避免误伤：`auditor-notes` 不因 `audit` 命中（audit. 才算），
 * 但 `approvals-next` 属于审批规则变体，命中。
 */
function isForbiddenTargetModule(raw) {
  return forbiddenSegment(raw) !== null;
}

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
  const raw = String((target && target.module) || '').trim();
  if (!raw) {
    throw new AgentError('improvement_target_missing', '提案必须声明 target.module', 400);
  }
  // 先对**原始输入**判禁（逐段 + 词边界前缀 + 别名），再做叶段归一——
  // 顺序反了会把 audit/X 归一成 x 后漏判。
  const hit = forbiddenSegment(raw);
  if (hit) {
    throw new AgentError(
      'improvement_forbidden_target',
      `${raw}（${FORBIDDEN_TARGETS[hit.key]}）在禁止自改清单内，不能成为提案目标`,
      403
    );
  }
  const module = normalizeTargetModule(raw);
  if (isForbiddenTargetModule(module)) {
    throw new AgentError(
      'improvement_forbidden_target',
      `${module}（${FORBIDDEN_TARGETS[module] || '禁止自改清单'}）在禁止自改清单内，不能成为提案目标`,
      403
    );
  }
  return { module, raw };
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
  const asserted = assertProposalTarget(target);
  const module = asserted.module;
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
    target: {
      module,
      moduleRaw: asserted.raw,
      configKey: String((target && target.configKey) || '').slice(0, 120),
    },
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
 * 生产入口（定时器/路由共用）：跨 bot 聚合最近的失败模式事件并起草。
 * 去重守卫：同一失败模式已有未否决的提案（draft/evaluated/approved/released）
 * 时不重复起草——定时器每小时跑一次，没有这条守卫会制造提案垃圾。
 */
function draftFromRecentFailures({ eventsLimit = 500, botIds = null } = {}) {
  const { listManifests } = require('./manifest');
  const ids = Array.isArray(botIds) && botIds.length
    ? botIds
    : listManifests().map(item => item.botId);
  const events = [];
  for (const botId of ids) {
    try {
      events.push(...tasks.listEvents(botId, { limit: eventsLimit }));
    } catch (_) {
      // 单 bot 事件读取失败不阻塞其它 bot 的聚合。
    }
  }
  // 只看最近的失败/恢复事件（带 failureMode 标签的那些）。
  const failureEvents = events.filter(
    event => event && event.payload && event.payload.failureMode
  );
  if (!failureEvents.length) {
    return { drafted: null, skipped: 'no_failure_signals', scannedEvents: events.length };
  }
  const dominant = dominantFailureMode(failureEvents);
  const open = listProposals({ status: null, limit: 200 }).find(
    item =>
      item.status !== 'rejected' &&
      item.status !== 'rolled_back' &&
      item.reason.includes(dominant.mode)
  );
  if (open) {
    return {
      drafted: null,
      skipped: 'open_proposal_exists',
      dominantMode: dominant.mode,
      openProposalId: open.proposalId,
      scannedEvents: events.length,
    };
  }
  const drafted = draftFromFailureModes({ events: failureEvents });
  return {
    drafted,
    skipped: drafted ? null : 'below_threshold',
    dominantMode: dominant ? dominant.mode : null,
    scannedEvents: events.length,
  };
}

function dominantFailureMode(events) {
  const counts = {};
  for (const event of events) {
    const mode = event && event.payload && event.payload.failureMode;
    if (!mode || !classifyFailureMode({ failureMode: mode })) continue;
    counts[mode] = (counts[mode] || 0) + 1;
  }
  const ranked = Object.entries(counts).sort((a, b) => b[1] - a[1]);
  return ranked.length ? { mode: ranked[0][0], count: ranked[0][1] } : null;
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
    // 评测输入随结果落档：发布后的回归检查缺省用同一份输入重跑 candidate，
    // 保证「发布之后才出现的退化」也能被发现（见 checkAutoRollback）。
    inputs: { suitePaths: suitePaths || null, baseTime },
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
function checkAutoRollback({ proposalId, report = null, fresh = null } = {}) {
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
  // 缺省路径必须重新跑评测（用提案自己的评测输入重跑 candidate 一侧），
  // 拿「当前代码/配置」的数字对照发布前基线——拿发布时的数字和自己比
  // 永远发现不了发布之后的退化。
  let reportSource = 'caller_report';
  let current = report;
  if (!current) {
    if (fresh && typeof fresh === 'function') {
      current = fresh();
    } else {
      // 评测输入随提案落档；缺省（默认套件）也可重跑——runSuite 对空路径取默认评测集。
      const inputs = evaluation.inputs || {};
      const rerun = evalRunner.runSuite({
        suitePaths: Array.isArray(inputs.suitePaths) ? inputs.suitePaths : null,
        baseTime: inputs.baseTime,
        comparator: 'candidate',
      });
      const metrics = evalMetrics.computeMetrics({ suite: rerun.suite, results: rerun.results });
      current = { metrics: metrics.metrics, safety: metrics.safety };
    }
    reportSource = 'fresh_evaluation';
  }
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
      reportSource,
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
    reportSource,
    successDelta,
    regressedCounters,
    reasons,
  };
}

// ---- P5-G 生产入口：周期调度器（起草 + 已发布提案的回归检查）----
const DEFAULT_SCHEDULER_INTERVAL_MS = 60 * 60 * 1000;

function schedulerIntervalFromEnv() {
  const raw = Number(process.env.BLUEBIRD_IMPROVEMENT_LOOP_INTERVAL_MS);
  if (!Number.isFinite(raw) || raw <= 0) return DEFAULT_SCHEDULER_INTERVAL_MS;
  return Math.max(60000, Math.floor(raw));
}

/**
 * 周期调度器：与 orphan-scheduler 同一套模式（启动跑一次 + 周期跑、
 * 单飞防重入、失败只记账不崩服务、timer unref 不阻进程退出）。
 * 环境变量 BLUEBIRD_IMPROVEMENT_LOOP_INTERVAL_MS=0 可显式停用。
 */
function createImprovementScheduler({
  intervalMs = schedulerIntervalFromEnv(),
  logger = console,
  setTimer = setTimeout,
  clearTimer = clearTimeout,
  now = () => Date.now(),
} = {}) {
  const stats = {
    runs: 0,
    draftsCreated: 0,
    rollbacksTriggered: 0,
    failures: 0,
    lastRunAt: null,
    lastError: null,
    running: false,
    started: false,
    intervalMs,
  };
  let timer = null;

  function runOnce() {
    if (stats.running) {
      stats.skipped = (stats.skipped || 0) + 1;
      return { skipped: true };
    }
    stats.running = true;
    const summary = { drafts: null, rollbackChecks: [] };
    try {
      // 1) 失败模式起草（去重守卫在 draftFromRecentFailures 内）。
      const draft = draftFromRecentFailures({});
      summary.drafts = draft;
      if (draft && draft.drafted) stats.draftsCreated += 1;
      // 2) 所有 released 提案跑一次回归检查（缺省重跑评测）。
      for (const item of listProposals({ status: 'released', limit: 50 })) {
        try {
          const result = checkAutoRollback({ proposalId: item.proposalId });
          summary.rollbackChecks.push({ proposalId: item.proposalId, ...result });
          if (result.rolledBack) stats.rollbacksTriggered += 1;
        } catch (error) {
          // 单个提案的检查失败不阻塞其它提案（如缺可重跑输入）。
          summary.rollbackChecks.push({
            proposalId: item.proposalId,
            error: (error && error.code) || 'check_failed',
          });
        }
      }
      stats.runs += 1;
      stats.lastRunAt = new Date(now()).toISOString();
      return summary;
    } catch (error) {
      stats.failures += 1;
      stats.lastError = (error && error.message) || String(error);
      logger.warn(`[improvement-loop] scheduler run failed: ${stats.lastError}`);
      return { error: stats.lastError };
    } finally {
      stats.running = false;
    }
  }

  return {
    start({ runOnStart = false } = {}) {
      if (stats.started) return { ...stats, timer: 'already_started' };
      if (intervalMs <= 0) {
        stats.started = true;
        return { ...stats, disabled: true };
      }
      stats.started = true;
      if (runOnStart) runOnce();
      timer = setTimer(() => {
        runOnce();
      }, intervalMs);
      if (typeof timer.unref === 'function') timer.unref();
      return { ...stats };
    },
    runOnce,
    stats() {
      return { ...stats };
    },
    stop() {
      if (timer) clearTimer(timer);
      timer = null;
      stats.started = false;
    },
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
  normalizeTargetModule,
  isForbiddenTargetModule,
  draftFromRecentFailures,
  createImprovementScheduler,
  schedulerIntervalFromEnv,
  DEFAULT_SCHEDULER_INTERVAL_MS,
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
