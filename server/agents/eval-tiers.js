/* global module, __dirname */
/**
 * P5-A（Notion §14）：评测集分层与轮换退役。
 *
 * 原文要求四类分层，且各自的可见范围不同：
 *  - 开发集 dev：可用于日常迭代，样例与答案都对优化方可见；
 *  - 验证集 val：受限访问，只用于阶段选型——逐例答案不回给优化方，只给聚合；
 *  - 保留测试集 holdout：不向被优化 Agent 暴露样例和答案；
 *  - 轮换挑战集 rotation：定期补充新任务、边界和失败案例，
 *    泄漏或使用过多的 holdout 必须退役。
 *
 * 本模块只做「分层判定 + 可见性裁剪 + 泄漏检测 + 退役计划 + 用量落盘」，
 * 不执行任务、不算指标：执行仍走 eval-runner，指标仍走 eval-metrics，
 * 避免出现第二套评测口径（§2.4 / Phase 0 的硬要求）。
 *
 * 数值口径（B 类，需实测校准，这里给保守默认并在台账登记）：
 *  - holdoutMaxUses = 6：一个 holdout 用例被用于打分 6 次即视为「使用过多」，
 *    超过就退役。理由：同一保留用例反复参与选型会把它变成事实上的开发集。
 *  - rotationIntervalMs = 7 天：轮换挑战集的最小补充间隔。
 *  - minNewCasesPerRotation = 1：每次轮换至少要补入的新用例数。
 * 单写者假设与其余 agent 存储一致（进程启动单实例锁兜底）。
 */
const fs = require('fs');
const path = require('path');
const { writeFileAtomicSync } = require('../atomic-write');
const { loadSuite } = require('./eval-suite');

const DATA_DIR = process.env.BLUEBIRD_DATA_DIR
  ? path.resolve(process.env.BLUEBIRD_DATA_DIR)
  : path.join(__dirname, '..', 'data');
const AGENTS_DIR = path.join(DATA_DIR, 'agents');
const TIERS_FILE = path.join(AGENTS_DIR, 'eval-tiers.json');

const SCHEMA_VERSION = 1;
const TIERS_POLICY_VERSION = 'eval-tiers-v1';
const SPLITS = Object.freeze(['dev', 'val', 'holdout', 'rotation']);

const DEFAULT_POLICY = Object.freeze({
  holdoutMaxUses: 6,
  rotationIntervalMs: 7 * 24 * 60 * 60 * 1000,
  minNewCasesPerRotation: 1,
});

// 每个分层的可见性。answerVisible=false 的分层，其 expectedTerminal /
// allowedErrorCodes / script 绝不进优化方视图；sampleVisible=false 的分层
// 连 goal 都不给优化方看。
const VISIBILITY = Object.freeze({
  dev: Object.freeze({ sampleVisible: true, answerVisible: true, perCaseVisible: true, bucket: 'reported' }),
  val: Object.freeze({ sampleVisible: true, answerVisible: false, perCaseVisible: false, bucket: 'aggregate' }),
  holdout: Object.freeze({ sampleVisible: false, answerVisible: false, perCaseVisible: false, bucket: 'hidden' }),
  rotation: Object.freeze({ sampleVisible: false, answerVisible: false, perCaseVisible: false, bucket: 'hidden' }),
});

// 答案字段：这三项决定"对不对"，泄漏出去就等于把答案交给被优化对象。
const ANSWER_FIELDS = Object.freeze(['expectedTerminal', 'allowedErrorCodes', 'script']);

function ensureDir() {
  fs.mkdirSync(AGENTS_DIR, { recursive: true });
}

function emptyState() {
  return {
    version: SCHEMA_VERSION,
    policyVersion: TIERS_POLICY_VERSION,
    policy: { ...DEFAULT_POLICY },
    cases: {},
    lastRotationAt: null,
    updatedAt: null,
  };
}

function normalizePolicy(policy = {}) {
  const next = { ...DEFAULT_POLICY };
  if (Number.isInteger(policy.holdoutMaxUses) && policy.holdoutMaxUses >= 1) next.holdoutMaxUses = policy.holdoutMaxUses;
  if (Number.isFinite(policy.rotationIntervalMs) && policy.rotationIntervalMs > 0) next.rotationIntervalMs = policy.rotationIntervalMs;
  if (Number.isInteger(policy.minNewCasesPerRotation) && policy.minNewCasesPerRotation >= 0) {
    next.minNewCasesPerRotation = policy.minNewCasesPerRotation;
  }
  return next;
}

function loadState(filePath = TIERS_FILE) {
  const target = String(filePath || TIERS_FILE);
  if (!fs.existsSync(target)) return emptyState();
  let raw;
  try {
    raw = JSON.parse(fs.readFileSync(target, 'utf8'));
  } catch (error) {
    // 读坏的用量状态不能当作"零用量"继续：那会让已泄漏或已超量的 holdout
    // 重新变成可用样本，等于把污染洗白。这里显式拒绝，由调用方处理。
    throw new Error(`评测分层用量状态不可读：${error.message}`);
  }
  if (raw.version !== SCHEMA_VERSION) throw new Error(`评测分层用量状态版本不匹配：${raw.version}`);
  return {
    version: SCHEMA_VERSION,
    policyVersion: raw.policyVersion || TIERS_POLICY_VERSION,
    policy: normalizePolicy(raw.policy || {}),
    cases: raw.cases && typeof raw.cases === 'object' ? raw.cases : {},
    // lastRotationAt 必须读回来：丢了它，轮换计划每轮都会把「刚补过的新用例」
    // 当成从未轮换，于是永远报"该轮换了"，补充节奏形同虚设。
    lastRotationAt: raw.lastRotationAt || null,
    updatedAt: raw.updatedAt || null,
  };
}

function saveState(state, filePath = TIERS_FILE) {
  const target = String(filePath || TIERS_FILE);
  ensureDir();
  writeFileAtomicSync(target, `${JSON.stringify(state, null, 2)}\n`, 'utf8');
  return target;
}

function caseRow(state, caseId) {
  if (!state.cases[caseId]) {
    state.cases[caseId] = { split: null, uses: 0, lastUsedAt: null, leakedAt: null, retiredAt: null, retiredReason: null, datasetVersions: [] };
  }
  const row = state.cases[caseId];
  if (!Array.isArray(row.datasetVersions)) row.datasetVersions = [];
  return row;
}

/** 校验用例分层：缺字段、非法值、分层为空都要显式失败，不静默按 dev 处理。 */
function validateSplits(cases, { requireNonEmptyBuckets = true } = {}) {
  if (!Array.isArray(cases) || cases.length === 0) throw new Error('评测集 cases 不能为空');
  const counts = { dev: 0, val: 0, holdout: 0, rotation: 0 };
  const missing = [];
  const illegal = [];
  for (const item of cases) {
    const split = item && item.split;
    if (!split) {
      missing.push(item ? item.id : '(无 id)');
      continue;
    }
    if (!SPLITS.includes(split)) {
      illegal.push(`${item.id}=${split}`);
      continue;
    }
    counts[split] += 1;
  }
  if (missing.length) throw new Error(`用例缺少 split：${missing.join('、')}`);
  if (illegal.length) throw new Error(`用例 split 非法：${illegal.join('、')}`);
  if (requireNonEmptyBuckets) {
    const empty = SPLITS.filter(name => counts[name] === 0);
    if (empty.length) throw new Error(`评测分层缺少桶：${empty.join('、')}`);
  }
  return { caseCount: cases.length, counts };
}

/** 加载多个数据集文件，合并成一层带 split 的用例视图。 */
function loadTieredSuites({ suitePaths = null, statePath = TIERS_FILE } = {}) {
  const paths = suitePaths && suitePaths.length
    ? suitePaths
    : [path.join(__dirname, 'eval-suite-v1.json'), path.join(__dirname, 'eval-suite-rotation-v1.json')];
  const suites = paths.map(filePath => loadSuite(filePath));
  const state = loadState(statePath);
  const cases = [];
  for (const suite of suites) {
    const datasetVersion = suite.datasetVersion || suite.version;
    for (const item of suite.cases) {
      cases.push({ ...item, split: item.split, datasetVersion, suiteVersion: suite.version });
    }
  }
  const ids = new Set();
  for (const item of cases) {
    if (ids.has(item.id)) throw new Error(`跨数据集用例 id 重复：${item.id}`);
    ids.add(item.id);
  }
  const { counts } = validateSplits(cases);
  return {
    suites: suites.map(suite => ({ version: suite.version, file: suite.file, digest: suite.digest, caseCount: suite.caseCount })),
    datasetVersions: Array.from(new Set(cases.map(item => item.datasetVersion))),
    caseCount: cases.length,
    counts,
    cases,
    state,
  };
}

function visibilityOf(split) {
  if (!VISIBILITY[split]) throw new Error(`未知评测分层：${split}`);
  return VISIBILITY[split];
}

/**
 * 交给被优化对象的用例视图。答案字段按分层裁剪；
 * holdout/rotation 连 goal 都不给（原文：不向被优化 Agent 暴露样例和答案）。
 */
function agentVisibleCase(item) {
  const view = visibilityOf(item.split);
  const base = { id: item.id, split: item.split, taskType: item.taskType };
  if (view.sampleVisible) {
    base.goal = item.goal;
    base.agentId = item.agentId;
    base.budgetTokenCap = item.budgetTokenCap;
  }
  if (view.answerVisible) {
    base.expectedTerminal = item.expectedTerminal;
    base.allowedErrorCodes = item.allowedErrorCodes;
  }
  base.withheldFields = ANSWER_FIELDS.filter(field => !(field in base)).concat(view.sampleVisible ? [] : ['goal']);
  return base;
}

/** 评分侧视图：始终完整，评测器是唯一能看答案的一方。 */
function evaluatorCase(item) {
  return { ...item };
}

/**
 * 泄漏检测：把优化方可见文本与 holdout/rotation 的样例与答案做子串比对。
 * 命中即返回 caseId 列表，调用方据此 markLeak 并让该用例退役。
 */
function scanLeak(text, cases, { audience = 'optimizer' } = {}) {
  const haystack = String(text === null || text === undefined ? '' : text);
  if (!haystack) return [];
  const targets = audience === 'optimizer'
    ? cases.filter(item => visibilityOf(item.split).bucket === 'hidden' || visibilityOf(item.split).answerVisible === false)
    : [];
  const hits = [];
  for (const item of targets) {
    const needles = [item.goal, item.expectedTerminal].filter(value => typeof value === 'string' && value.length >= 4);
    if (haystack.includes(`${item.id}:`) || haystack.includes(`caseId:${item.id}`)) needles.push(String(item.id));
    if (needles.some(needle => haystack.includes(needle))) hits.push(item.id);
  }
  return Array.from(new Set(hits));
}

/** 记录一次打分用量。同一 at 重复调用不累加（幂等），避免重跑放大使用次数。 */
function recordUse(caseId, { split, datasetVersion = null, at = new Date().toISOString(), statePath = TIERS_FILE } = {}) {
  const state = loadState(statePath);
  // 校验必须发生在建行之前的语义：一个不知道分层的用例不能因为一次误调用
  // 就在用量表里留下半知记录（那会让它下次"看起来有分层"）。
  if (split !== undefined && split !== null && !SPLITS.includes(split)) {
    throw new Error(`recordUse 的 split 非法：${split}`);
  }
  const known = split || (state.cases[caseId] && state.cases[caseId].split) || null;
  if (!known) throw new Error(`recordUse 前必须知道用例分层：${caseId}`);
  const row = caseRow(state, caseId);
  row.split = known;
  if (datasetVersion && !row.datasetVersions.includes(datasetVersion)) row.datasetVersions.push(datasetVersion);
  const stamp = String(at);
  if (row.lastUsedAt === stamp) {
    return { row, recorded: false, reason: 'duplicate_use_stamp' };
  }
  if (row.lastUsedAt && Date.parse(stamp) < Date.parse(row.lastUsedAt)) {
    // 乱序用量不回拨计数：计数只会单调增长，否则可以把超量样本改回年轻。
    return { row, recorded: false, reason: 'out_of_order' };
  }
  row.uses += 1;
  row.lastUsedAt = stamp;
  state.updatedAt = stamp;
  saveState(state, statePath);
  return { row, recorded: true, reason: null };
}

/** 标记泄漏：一旦被优化方看到 holdout 样例或答案，立刻置位，退役计划会处理它。 */
function markLeak(caseId, { at = new Date().toISOString(), evidence = null, statePath = TIERS_FILE } = {}) {
  const state = loadState(statePath);
  const row = caseRow(state, caseId);
  if (row.leakedAt) return { row, alreadyLeaked: true };
  row.leakedAt = String(at);
  row.leakEvidence = evidence === null ? null : String(evidence).slice(0, 200);
  state.updatedAt = String(at);
  saveState(state, statePath);
  return { row, alreadyLeaked: false };
}

/** 人工强制退役（例如某用例已被写进提示词模板）。 */
function retireCase(caseId, { reason = 'manual', at = new Date().toISOString(), statePath = TIERS_FILE } = {}) {
  const state = loadState(statePath);
  const row = caseRow(state, caseId);
  row.retiredAt = String(at);
  row.retiredReason = String(reason);
  state.updatedAt = String(at);
  saveState(state, statePath);
  return row;
}

/**
 * 轮换与退役计划（纯函数，不改状态）。
 * 退役原因优先级：leaked > overused > already retired。
 */
function planRotation(tiered, { policy = null, now = Date.now() } = {}) {
  const active = normalizePolicy(policy || (tiered.state && tiered.state.policy) || {});
  const rows = tiered.state.cases || {};
  const retired = [];
  const bySplit = { dev: [], val: [], holdout: [], rotation: [] };
  for (const item of tiered.cases) {
    const row = rows[item.id] || { split: item.split, uses: 0, leakedAt: null, retiredAt: null };
    const bucket = { caseId: item.id, split: item.split, uses: Number(row.uses) || 0, leakedAt: row.leakedAt || null, retiredAt: row.retiredAt || null };
    let reason = null;
    if (bucket.retiredAt) reason = row.retiredReason || 'retired';
    else if (bucket.leakedAt) reason = 'leaked';
    else if ((bucket.split === 'holdout' || bucket.split === 'rotation') && bucket.uses > active.holdoutMaxUses) reason = 'overused';
    if (reason) {
      retired.push({ ...bucket, reason });
      continue;
    }
    bySplit[item.split].push(bucket);
  }
  const hiddenPool = bySplit.holdout.length + bySplit.rotation.length;
  const lastRotationAt = tiered.state.lastRotationAt || null;
  const dueAt = lastRotationAt ? Date.parse(lastRotationAt) + active.rotationIntervalMs : now;
  const rotationDue = now >= dueAt;
  return {
    now: new Date(now).toISOString(),
    policy: active,
    retired,
    usable: {
      dev: bySplit.dev.map(item => item.caseId),
      val: bySplit.val.map(item => item.caseId),
      holdout: bySplit.holdout.map(item => item.caseId),
      rotation: bySplit.rotation.map(item => item.caseId),
    },
    hiddenPool,
    replacementsRequired: Math.max(active.minNewCasesPerRotation - bySplit.rotation.length, 0),
    // 隐藏池被掏空后，选型不能再声称"保留集独立"——必须显式报警而不是悄悄用开发集顶替。
    hiddenPoolExhausted: retired.length > 0 && hiddenPool === 0,
    rotationDue,
    nextRotationAt: new Date(dueAt).toISOString(),
  };
}

function markRotationApplied({ at = new Date().toISOString(), statePath = TIERS_FILE } = {}) {
  const state = loadState(statePath);
  state.lastRotationAt = String(at);
  state.updatedAt = String(at);
  saveState(state, statePath);
  return state;
}

/**
 * 优化方报告：dev 逐例给，val 只给聚合，holdout/rotation 合并成计数桶。
 * 这是"不暴露样例和答案"的落点——任何把逐例结果发给优化方的调用都必须走这里。
 */
function optimizerReport(tiered, caseResults = []) {
  const byId = new Map(tiered.cases.map(item => [item.id, item]));
  const devRows = [];
  const valRows = [];
  const hiddenRows = [];
  for (const result of caseResults) {
    const item = byId.get(result.caseId);
    if (!item) throw new Error(`结果里的用例不属于当前分层数据集：${result.caseId}`);
    const bucket = visibilityOf(item.split).bucket;
    if (bucket === 'reported') devRows.push(result);
    else if (bucket === 'aggregate') valRows.push(result);
    else hiddenRows.push(result);
  }
  const rate = rows => (rows.length ? rows.filter(row => row.success === true).length / rows.length : null);
  return {
    perCase: devRows.map(row => ({ caseId: row.caseId, success: row.success === true, terminal: row.terminal })),
    valAggregate: { count: valRows.length, successRate: rate(valRows) },
    hiddenAggregate: {
      count: hiddenRows.length,
      successRate: rate(hiddenRows),
      splits: hiddenRows.reduce((sum, row) => {
        const split = (byId.get(row.caseId) || {}).split;
        sum[split] = (sum[split] || 0) + 1;
        return sum;
      }, {}),
    },
    leakedDetected: hiddenRows.filter(row => row.leakDetected === true).map(row => row.caseId),
    note: 'holdout/rotation 只给数量与聚合成功率，不返回 goal 或期望终态',
  };
}

function resetForTests(filePath = TIERS_FILE) {
  try {
    fs.rmSync(filePath, { force: true });
  } catch (error) {
    /* 测试夹具清理失败不影响判定 */
  }
}

module.exports = {
  AGENTS_DIR,
  ANSWER_FIELDS,
  DATA_DIR,
  DEFAULT_POLICY,
  SPLITS,
  TIERS_FILE,
  TIERS_POLICY_VERSION,
  VISIBILITY,
  agentVisibleCase,
  evaluatorCase,
  loadState,
  loadTieredSuites,
  markLeak,
  markRotationApplied,
  normalizePolicy,
  optimizerReport,
  planRotation,
  recordUse,
  resetForTests,
  retireCase,
  saveState,
  scanLeak,
  validateSplits,
  visibilityOf,
};
