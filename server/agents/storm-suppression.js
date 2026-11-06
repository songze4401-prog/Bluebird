/* global module, __dirname, process */
/**
 * P5-B（Notion §26 第 4 项）：重规划风暴抑制五条细则。
 *
 * 原文要的是"重规划不能变成风暴"：每一次重跑都必须说清收益、不能拿等价计划
 * 反复撞同一堵墙、不能靠换一个 runId 绕过上限。五条细则各自是一个纯函数：
 *  1) 收益声明：改计划必须带 `benefit` + 基线摘要 + 比较对象标识（§14 的五类基线），
 *     没有证据的"我觉得这样更好"不放行；
 *  2) 等价计划拒绝：同一 `planDigest` + 同一 `errorFingerprint` 在窗口内已被拒过，
 *     不再给它重跑的机会；
 *  3) 冷却窗口：同一 Task 被拒后进入冷却，冷却期内不再接受新的重规划；
 *  4) 计划 diff 判据：新计划与旧计划的步骤键必须有实质差异（复用 workflow-store
 *     的 key 顺序无关 digest 与 stepKeyFor，不另建哈希口径）；
 *  5) 禁止新建 Run 规避：状态按 `task:<taskId>` 记账，runId 变化不清零——
 *     这正是 §25 计数"不得被重试重置"的同一条取向。
 *
 * 生产事实来源约束（调研结论，写在这里防止后来者误接）：
 *  - §25 的 `agent-limits.recordReplan / recordRunRetry` 在生产路径**没有调用方**，
 *    真实重试决策只有 `agents/runtime.js:decideFailureDisposition`；
 *    本模块只挂在那一个决策点上，不在别处再判一次"要不要重跑"。
 *  - 错误指纹口径复用 `agents/errors.js` 的 `errorFingerprint`，不新造指纹算法。
 */
const fs = require('fs');
const path = require('path');
const { writeFileAtomicSync } = require('../atomic-write');
const workflowStore = require('./workflow-store');
const comparators = require('./eval-comparators');

const STORM_POLICY_VERSION = 'p5b-storm-v1';
const SCHEMA_VERSION = 1;

const DATA_DIR = process.env.BLUEBIRD_DATA_DIR
  ? path.resolve(process.env.BLUEBIRD_DATA_DIR)
  : path.join(__dirname, '..', 'data');
const AGENTS_DIR = path.join(DATA_DIR, 'agents');
const STORM_FILE = path.join(AGENTS_DIR, 'replan-storm.json');

const RULES = Object.freeze({
  missing_claim: 'missing_improvement_claim',
  equivalent_plan: 'equivalent_rejected_plan',
  cooldown: 'cooldown_active',
  immaterial_diff: 'immaterial_plan_diff',
  new_run_evade: 'new_run_evade',
  // 不是原文的第六条，而是 §25 每 Run 重规划上限在风暴处的补位执行（生产缺调用方）。
  replan_limit: 'replan_limit_reached',
});

function clampInt(value, fallback, min, max) {
  const number = Number(value);
  if (!Number.isFinite(number)) return fallback;
  return Math.min(max, Math.max(min, Math.floor(number)));
}

/**
 * 保守默认：窗口 5 分钟；每 Task 最多 2 次重规划（与 §25 同一数值，不另开口径）；
 * 被拒后冷却 60 秒；步骤 diff 至少改动 1 个键；条目上限 500 防无界增长。
 */
const DEFAULT_POLICY = Object.freeze({
  windowMs: 300000,
  maxReplansPerTask: 2,
  cooldownMs: 60000,
  minChangedStepKeys: 1,
  maxEntries: 500,
  maxDenialsPerTask: 32,
});

const CLAIM_FIELDS = Object.freeze(['benefit', 'baselineDigest', 'comparatorId']);

function effectivePolicy(overrides = {}) {
  const next = { ...DEFAULT_POLICY };
  next.windowMs = clampInt(process.env.BLUEBIRD_STORM_WINDOW_MS, next.windowMs, 1000, 3600000);
  next.cooldownMs = clampInt(process.env.BLUEBIRD_STORM_COOLDOWN_MS, next.cooldownMs, 0, 600000);
  next.maxReplansPerTask = clampInt(process.env.BLUEBIRD_STORM_MAX_REPLANS, next.maxReplansPerTask, 0, 10);
  if (Number.isFinite(Number(overrides.maxReplansPerTask))) {
    // 覆盖值不得越过 §25 的每 Run 2 次上限：风暴抑制只能更严，不能更松。
    const agentLimits = require('./agent-limits');
    if (Number(overrides.maxReplansPerTask) > agentLimits.MAX_REPLANS_PER_RUN) {
      throw new Error(`maxReplansPerTask 不得超过 §25 上限 ${agentLimits.MAX_REPLANS_PER_RUN}`);
    }
    next.maxReplansPerTask = clampInt(overrides.maxReplansPerTask, next.maxReplansPerTask, 0, 10);
  }
  return next;
}

function digestOfPlan(plan) {
  // 计划形态直接交给 workflow-store 的 digest：与 planner.js 的"同计划不追加版本"同一口径。
  return workflowStore.digestPlan(plan);
}

function stepKeysOf(plan) {
  const steps = Array.isArray(plan && plan.steps) ? plan.steps : [];
  return steps.map((step, index) => {
    try {
      return workflowStore.stepKeyFor(step || {});
    } catch (error) {
      // 取不到步骤键时退到序号：宁可把 diff 判成"看不出来"，也不要用一个假哈希。
      return `step:${index}:unkeyed`;
    }
  });
}

/** 细则 1：收益声明必须齐全，且比较对象必须是 §14 注册表里的真实类型。 */
function checkImprovementClaim(claim) {
  if (!claim || typeof claim !== 'object') {
    return { rule: RULES.missing_claim, violated: true, missing: CLAIM_FIELDS.slice(), note: '缺少收益声明对象' };
  }
  const missing = CLAIM_FIELDS.filter(field => {
    const value = claim[field];
    return value === null || value === undefined || String(value).trim() === '';
  });
  if (missing.length) return { rule: RULES.missing_claim, violated: true, missing, note: '收益声明字段不全' };
  if (!/^sha256:[0-9a-f]{64}$/.test(String(claim.baselineDigest)) && !/^[0-9a-f]{64}$/.test(String(claim.baselineDigest))) {
    return { rule: RULES.missing_claim, violated: true, missing: ['baselineDigest'], note: '基线摘要不是合法 digest' };
  }
  if (!comparators.KINDS.includes(String(claim.comparatorId)) && !comparators.REGISTRY[String(claim.comparatorId)]) {
    return {
      rule: RULES.missing_claim,
      violated: true,
      missing: ['comparatorId'],
      note: `比较对象标识不属于 §14 五类：${String(claim.comparatorId)}`,
    };
  }
  return { rule: RULES.missing_claim, violated: false, missing: [], note: null, benefit: String(claim.benefit).slice(0, 200) };
}

/**
 * 哪些细则会武装冷却：只有"反复撞同一堵墙"这类才配冷却。
 * 收益声明缺字段是调用方契约错，不该让同一 Task 接下来 60 秒内连改正的机会都没有。
 */
const COOLDOWN_RULES = Object.freeze([
  RULES.equivalent_plan,
  RULES.immaterial_diff,
  RULES.new_run_evade,
  RULES.replan_limit,
]);

function taskKey(taskId) {
  const clean = String(taskId === null || taskId === undefined ? '' : taskId).trim();
  if (!clean) throw new Error('风暴抑制需要 Task 归属才能防新建 Run 规避');
  // 键只按 Task 计，不含 runId：细则 5 的实现要点就在这里。
  return `task:${clean}`;
}

function entryOf(state, key) {
  if (!state.entries[key]) {
    state.entries[key] = { replans: 0, denials: [], lastRejectedAt: null, lastClaimDeniedAt: null, lastReplanAt: null, lastPlanDigest: null, lastErrorFingerprint: null, lastRunId: null };
  }
  const entry = state.entries[key];
  if (!Array.isArray(entry.denials)) entry.denials = [];
  // 窗口外的旧拒绝记录先丢掉：风暴判据只看窗口内，不能让历史永久卡死一个任务。
  entry.denials = entry.denials.filter(item => Number.isFinite(Number(item.at)));
  return entry;
}

function recentDenials(entry, now, policy) {
  return entry.denials.filter(item => now - Number(item.at) < policy.windowMs);
}

/**
 * 纯函数决策：输入本次重规划意图与既有状态，输出放行/拒绝与命中的细则。
 * 不读文件、不写文件，所以五条细则都能独立单测。
 */
function evaluate(state, {
  taskId,
  runId = null,
  plan = null,
  previousPlan = null,
  planDigest = null,
  errorFingerprint = null,
  claim = null,
  requiresClaim = null,
  now = Date.now(),
} = {}, policy = DEFAULT_POLICY) {
  const key = taskKey(taskId);
  const entry = entryOf(state, key);
  const recent = recentDenials(entry, now, policy);
  const deniedBy = [];
  const digest = planDigest || (plan ? digestOfPlan(plan) : null);
  const needClaim = requiresClaim === null ? Boolean(plan || planDigest) : Boolean(requiresClaim);

  if (needClaim) {
    const claimCheck = checkImprovementClaim(claim);
    if (claimCheck.violated) deniedBy.push(claimCheck);
  }

  if (policy.cooldownMs > 0 && entry.lastRejectedAt) {
    const elapsed = now - Date.parse(entry.lastRejectedAt);
    if (Number.isFinite(elapsed) && elapsed < policy.cooldownMs) {
      deniedBy.push({
        rule: RULES.cooldown,
        violated: true,
        remainingMs: policy.cooldownMs - elapsed,
        lastRejectedAt: entry.lastRejectedAt,
      });
    }
  }

  if (entry.replans >= policy.maxReplansPerTask) {
    // 每 Task 的重规划上限：§25 的 recordReplan 在生产路径没有调用方，
    // 这里按同一数值补位执行，且 effectivePolicy 保证覆盖值永远不会高于 §25 上限。
    deniedBy.push({
      rule: RULES.replan_limit,
      violated: true,
      reason: 'replan_limit_per_task',
      replans: entry.replans,
      limit: policy.maxReplansPerTask,
    });
  }

  const sameDigest = digest && entry.lastPlanDigest === digest;
  const sameFingerprint = errorFingerprint && entry.lastErrorFingerprint === errorFingerprint;
  if (sameDigest && sameFingerprint) {
    deniedBy.push({ rule: RULES.equivalent_plan, violated: true, planDigest: digest, errorFingerprint: String(errorFingerprint).slice(0, 64) });
  }

  if (digest && entry.lastRunId && String(entry.lastRunId) !== String(runId || '') && sameDigest && sameFingerprint) {
    // 换了 runId 但计划与错误都没变 = 想靠新 Run 洗掉计数。
    deniedBy.push({ rule: RULES.new_run_evade, violated: true, previousRunId: entry.lastRunId, runId: runId === null ? null : String(runId) });
  }

  if (plan && previousPlan) {
    const before = new Set(stepKeysOf(previousPlan));
    const after = stepKeysOf(plan);
    const changed = after.filter(step => !before.has(step)).length;
    if (changed < policy.minChangedStepKeys) {
      deniedBy.push({
        rule: RULES.immaterial_diff,
        violated: true,
        changed,
        required: policy.minChangedStepKeys,
        beforeDigest: digestOfPlan(previousPlan),
        afterDigest: digest,
      });
    }
  }

  const violations = deniedBy.filter(item => item.violated);
  return {
    key,
    allowed: violations.length === 0,
    violations,
    digest: digest || null,
    replans: entry.replans,
    recentDenials: recent.length,
    policyVersion: STORM_POLICY_VERSION,
  };
}

/** 拒绝时记账：写窗口内的拒绝历史；只有撞墙类细则才武装冷却。 */
function recordDenial(state, { taskId, runId = null, rule, now = Date.now() }, policy) {
  const key = taskKey(taskId);
  const entry = entryOf(state, key);
  entry.denials.push({ at: now, rule: String(rule), runId: runId ? String(runId) : null });
  if (entry.denials.length > policy.maxDenialsPerTask) {
    entry.denials = entry.denials.slice(-policy.maxDenialsPerTask);
  }
  if (COOLDOWN_RULES.includes(String(rule))) entry.lastRejectedAt = new Date(now).toISOString();
  else entry.lastClaimDeniedAt = new Date(now).toISOString();
  // 刻意不在这里写 lastPlanDigest / lastErrorFingerprint：等价判据比较的是
  // "上一次真的跑过的计划 + 那一次真的撞到的错误"。把被拒的提交也记进去，
  // 会让一次契约错（缺收益声明）把随后改正的合法重规划误判成等价重投。
  state.entries[key] = entry;
  return entry;
}

/** 放行即计数：一次成功的重规划占用该 Task 的一次机会，runId 变化不会退回额度。 */
function recordReplan(state, { taskId, runId = null, planDigest = null, errorFingerprint = null, now = Date.now() }) {
  const key = taskKey(taskId);
  const entry = entryOf(state, key);
  entry.replans += 1;
  entry.lastRunId = runId ? String(runId) : entry.lastRunId;
  // 成功放行也要记住"这次跑的是哪份计划、撞的是哪个错误"，
  // 否则下一次等价重投没有任何东西可比，细则 2/5 会永久失效。
  if (planDigest) entry.lastPlanDigest = String(planDigest);
  if (errorFingerprint) entry.lastErrorFingerprint = String(errorFingerprint);
  entry.lastReplanAt = new Date(now).toISOString();
  state.entries[key] = entry;
  return entry;
}

function pruneEntries(state, policy) {
  const keys = Object.keys(state.entries || {});
  if (keys.length <= policy.maxEntries) return 0;
  const byAge = keys.sort((a, b) => {
    const left = Date.parse(state.entries[a].lastRejectedAt || state.entries[a].lastReplanAt || '') || 0;
    const right = Date.parse(state.entries[b].lastRejectedAt || state.entries[b].lastReplanAt || '') || 0;
    return left - right;
  });
  const drop = byAge.slice(0, keys.length - policy.maxEntries);
  for (const key of drop) delete state.entries[key];
  return drop.length;
}

function load(filePath = STORM_FILE) {
  const target = String(filePath || STORM_FILE);
  if (!fs.existsSync(target)) {
    return { version: SCHEMA_VERSION, policyVersion: STORM_POLICY_VERSION, entries: {}, updatedAt: null };
  }
  let parsed;
  try {
    parsed = JSON.parse(fs.readFileSync(target, 'utf8'));
  } catch (error) {
    // 读坏按"最严"处理：调用方拿不到历史就不能确认放行，这里抛错由上层按拒绝处置。
    throw new Error(`重规划风暴状态不可读：${error.message}`);
  }
  if (parsed.version !== SCHEMA_VERSION) throw new Error(`重规划风暴状态版本不匹配：${parsed.version}`);
  return {
    version: SCHEMA_VERSION,
    policyVersion: parsed.policyVersion || STORM_POLICY_VERSION,
    entries: parsed.entries && typeof parsed.entries === 'object' ? parsed.entries : {},
    updatedAt: parsed.updatedAt || null,
  };
}

function save(state, filePath = STORM_FILE) {
  const target = String(filePath || STORM_FILE);
  fs.mkdirSync(path.dirname(target), { recursive: true });
  state.policyVersion = STORM_POLICY_VERSION;
  state.updatedAt = new Date().toISOString();
  writeFileAtomicSync(target, JSON.stringify(state, null, 2));
  return target;
}

/**
 * 一次完整判定（默认落盘）。返回形态刻意与 decideFailureDisposition 需要的字段对齐：
 * `{ allowed, rule, retryAfterMs, details }`，调用方只需要把 allowed=false 折成终态。
 */
function decide(input, { filePath = STORM_FILE, policy = null, persist = true, now = Date.now() } = {}) {
  if (!Number.isFinite(Number(now))) throw new Error(`decide 的 now 必须是数值时间戳：${String(now)}`);
  const active = policy || effectivePolicy();
  const state = load(filePath);
  const result = evaluate(state, { ...input, now }, active);
  if (result.allowed) {
    recordReplan(state, { ...input, planDigest: result.digest, now });
    pruneEntries(state, active);
    if (persist) save(state, filePath);
    return { ...result, rule: null, retryAfterMs: 0, denialsRecorded: 0 };
  }
  const first = result.violations[0];
  recordDenial(state, { ...input, planDigest: result.digest, rule: first.rule, now }, active);
  pruneEntries(state, active);
  if (persist) save(state, filePath);
  return {
    ...result,
    rule: first.rule,
    retryAfterMs: first.remainingMs !== undefined
      ? first.remainingMs
      : Math.max(0, active.cooldownMs),
    details: result.violations,
  };
}

function status({ filePath = STORM_FILE, now = Date.now(), policy = null } = {}) {
  const active = policy || effectivePolicy();
  const state = load(filePath);
  const rows = Object.entries(state.entries || {}).map(([key, entry]) => ({
    key,
    replans: Number(entry.replans) || 0,
    limit: active.maxReplansPerTask,
    recentDenials: recentDenials(entryOf(state, key), now, active).map(item => ({ at: item.at, rule: item.rule })),
    lastRejectedAt: entry.lastRejectedAt || null,
    cooldownUntil: entry.lastRejectedAt ? new Date(Date.parse(entry.lastRejectedAt) + active.cooldownMs).toISOString() : null,
    lastPlanDigest: entry.lastPlanDigest ? String(entry.lastPlanDigest).slice(0, 24) : null,
  }));
  return { policyVersion: STORM_POLICY_VERSION, thresholds: active, entries: rows, updatedAt: state.updatedAt };
}

function resetForTests(filePath = STORM_FILE) {
  try {
    fs.rmSync(filePath, { force: true });
  } catch (error) {
    /* 夹具清理失败不改变判定 */
  }
}

module.exports = {
  CLAIM_FIELDS,
  DEFAULT_POLICY,
  RULES,
  STORM_FILE,
  STORM_POLICY_VERSION,
  decide,
  digestOfPlan,
  effectivePolicy,
  entryOf,
  evaluate,
  checkImprovementClaim,
  load,
  pruneEntries,
  recordDenial,
  recordReplan,
  resetForTests,
  save,
  status,
  stepKeysOf,
  taskKey,
};
