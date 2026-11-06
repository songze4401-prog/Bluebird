/* global module, __dirname, process */
/**
 * P5-B（Notion §26 第 3 项）：Provider / 工具 / Worker 三态熔断。
 *
 * 原文要求：`closed / open / half-open` 三态 + 滑动窗口 + 半开探测，
 * 并且**确定性错误不计入故障率**——配置错、权限错、请求格式错不应该把熔断打开，
 * 否则一个坏请求会伪装成"上游不可用"，把可修的错藏进不可修的错里。
 *
 * 与 `watchdog-policy.js` 的 breaker 区分清楚（台账 B-07 正是为此留了限定）：
 * 那一个数的是"同一自愈动作在窗口内被尝试了几次"（动作防抖，无失败率概念），
 * 本模块数的是"某个被调对象的健康度"（成功率 + 半开探测），两者不可互相顶替。
 *
 * 状态落盘（读即事实来源，模块不缓存），因为熔断的意义正是跨进程重启仍然有效：
 * 重启即清零的 breaker 在崩溃循环里等于没有。
 */
const fs = require('fs');
const path = require('path');
const { writeFileAtomicSync } = require('../atomic-write');

const BREAKER_POLICY_VERSION = 'p5b-breaker-v1';
const SCHEMA_VERSION = 1;
const TARGET_KINDS = Object.freeze(['provider', 'tool', 'worker']);
const STATES = Object.freeze(['closed', 'open', 'half_open']);

const DATA_DIR = process.env.BLUEBIRD_DATA_DIR
  ? path.resolve(process.env.BLUEBIRD_DATA_DIR)
  : path.join(__dirname, '..', 'data');
const AGENTS_DIR = path.join(DATA_DIR, 'agents');
const BREAKER_FILE = path.join(AGENTS_DIR, 'circuit-breaker.json');

// 默认按 model-adapter 的 ModelCallError.kind 分类（tests/agent-circuit-breaker.test.js
// 会用 model-adapter 的 ERROR_STATUS 键集反查本表，防止两处漂移）：
//   瞬态（计入故障率）：连接、超时、服务商 5xx、服务商限流
//   确定性（不计故障率）：密钥被拒、模型/请求格式被拒、未配置、能力不支持、客户端取消
const TRANSIENT_KINDS = Object.freeze(['timeout', 'connection', 'server', 'rate_limit']);
const DETERMINISTIC_KINDS = Object.freeze(['auth', 'model', 'bad_request', 'not_configured', 'capability', 'cancelled']);

function clampInt(value, fallback, min, max) {
  const number = Number(value);
  if (!Number.isFinite(number)) return fallback;
  return Math.min(max, Math.max(min, Math.floor(number)));
}

/**
 * 保守默认：至少要 10 个样本才允许开闸（避免小样本把一次抖动当崩盘），
 * 失败率过半才开；开闸 30 秒后半开放 2 次探测，两次都成才合闸。
 */
const DEFAULT_POLICY = Object.freeze({
  windowMs: 60000,
  minSamples: 10,
  failureRatio: 0.5,
  openMs: 30000,
  halfOpenMaxProbes: 2,
  halfOpenRequiredSuccesses: 2,
  maxEventsPerTarget: 200,
  maxTargets: 64,
});

function effectivePolicy(overrides = {}) {
  const next = { ...DEFAULT_POLICY };
  const env = process.env;
  next.windowMs = clampInt(env.BLUEBIRD_BREAKER_WINDOW_MS, next.windowMs, 1000, 900000);
  next.minSamples = clampInt(env.BLUEBIRD_BREAKER_MIN_SAMPLES, next.minSamples, 2, 1000);
  next.openMs = clampInt(env.BLUEBIRD_BREAKER_OPEN_MS, next.openMs, 500, 900000);
  next.halfOpenMaxProbes = clampInt(env.BLUEBIRD_BREAKER_PROBE_CALLS, next.halfOpenMaxProbes, 1, 20);
  const ratio = Number(env.BLUEBIRD_BREAKER_FAILURE_RATIO);
  if (Number.isFinite(ratio) && ratio > 0 && ratio <= 1) next.failureRatio = ratio;
  for (const [key, value] of Object.entries(overrides || {})) {
    if (!(key in DEFAULT_POLICY)) throw new Error(`未知熔断阈值：${key}`);
    next[key] = value;
  }
  if (next.halfOpenRequiredSuccesses > next.halfOpenMaxProbes) {
    throw new Error('halfOpenRequiredSuccesses 不得大于 halfOpenMaxProbes，否则半开永远合不上');
  }
  return next;
}

function classifyOutcome({ ok = false, errorCode = null, isTransient = null } = {}) {
  if (ok) return 'ok';
  const kind = String(errorCode || '');
  if (typeof isTransient === 'function') return isTransient(kind) ? 'transient' : 'deterministic';
  if (TRANSIENT_KINDS.includes(kind)) return 'transient';
  // 未知错误码保守当瞬态：漏判瞬态会让熔断形同虚设，比多算一次故障更危险。
  if (!DETERMINISTIC_KINDS.includes(kind)) return 'transient';
  return 'deterministic';
}

function targetKey(kind, targetId) {
  if (!TARGET_KINDS.includes(kind)) throw new Error(`未知熔断对象类型：${kind}`);
  const clean = String(targetId === null || targetId === undefined ? '' : targetId).trim();
  if (!clean) throw new Error(`熔断对象缺少标识：${kind}`);
  return `${kind}:${clean}`;
}

function emptyTarget(key) {
  return {
    key,
    state: 'closed',
    events: [],
    openedAt: null,
    openUntil: null,
    probes: 0,
    lastChangedAt: null,
    lastChangeReason: null,
    deterministicStreak: 0,
    lastProbeAt: null,
    // 开闸期间要能把"上游最近一次的真实错误类别"原样回给调用方：
    // 熔断不是新错误码，改写码名会让既有逐码断言与客户端分支全部失真。
    lastTransientCode: null,
    lastDeterministicCode: null,
  };
}

function load(filePath = BREAKER_FILE) {
  const target = String(filePath || BREAKER_FILE);
  if (!fs.existsSync(target)) {
    return { version: SCHEMA_VERSION, policyVersion: BREAKER_POLICY_VERSION, targets: {}, updatedAt: null };
  }
  let parsed;
  try {
    parsed = JSON.parse(fs.readFileSync(target, 'utf8'));
  } catch (error) {
    // 读坏按"未知健康度"处理，不当成"全绿"：熔断器坏掉时宁可保守拒绝，
    // 也不要在上游疑似不可用时把全部流量放行。
    throw new Error(`熔断状态不可读：${error.message}`);
  }
  if (parsed.version !== SCHEMA_VERSION) throw new Error(`熔断状态版本不匹配：${parsed.version}`);
  return {
    version: SCHEMA_VERSION,
    // 阈值换版即重算：旧窗口事件不能带着新阈值继续判定。
    policyVersion: parsed.policyVersion || BREAKER_POLICY_VERSION,
    targets: parsed.targets && typeof parsed.targets === 'object' ? parsed.targets : {},
    updatedAt: parsed.updatedAt || null,
  };
}

function save(state, filePath = BREAKER_FILE) {
  const target = String(filePath || BREAKER_FILE);
  fs.mkdirSync(path.dirname(target), { recursive: true });
  state.policyVersion = BREAKER_POLICY_VERSION;
  state.updatedAt = new Date().toISOString();
  writeFileAtomicSync(target, JSON.stringify(state, null, 2));
  return target;
}

/** 窗口内样本与失败率；确定性错误只进计数，不进分母。 */
function healthOf(events, policy, now) {
  const inWindow = (Array.isArray(events) ? events : []).filter(item => now - Number(item.at) < policy.windowMs);
  const counted = inWindow.filter(item => item.outcome !== 'deterministic');
  const failures = counted.filter(item => item.outcome === 'transient').length;
  const deterministicOnly = inWindow.length > 0 && counted.length === 0;
  return {
    events: inWindow,
    samples: counted.length,
    failures,
    failureRatio: counted.length ? failures / counted.length : 0,
    deterministic: inWindow.length - counted.length,
    deterministicOnly,
  };
}

/**
 * 纯函数状态机：输入当前目标状态 + 一次结果 + 时间，输出新状态与迁移记录。
 * 不读文件、不看时间源，因此所有边界（半开探测数、窗口过期、开闸再命中）都可单测。
 */
function applyOutcome(target, { outcome, at, code = null }, policy) {
  const state = target.state === 'half_open' || target.state === 'open' || target.state === 'closed' ? target.state : 'closed';
  const next = { ...emptyTarget(target.key), ...target, state, events: [...(target.events || [])].filter(item => at - Number(item.at) < policy.windowMs) };
  const transitions = [];
  if (outcome !== 'ok') {
    if (code) {
      if (outcome === 'transient') next.lastTransientCode = String(code);
      else next.lastDeterministicCode = String(code);
    }
    next.events.push({ at, outcome: outcome === 'transient' ? 'transient' : 'deterministic', code: code ? String(code) : null });
  }
  if (next.events.length > policy.maxEventsPerTarget) next.events = next.events.slice(-policy.maxEventsPerTarget);

  const health = healthOf(next.events, policy, at);

  if (state === 'open') {
    // 开闸期间的真实调用不该发生；若外部仍打进来（旧租约、并发漏网），
    // 记录它但保持开闸，直到 openUntil 到期才允许半开。
    if (next.openUntil && at >= Number(next.openUntil)) {
      next.state = 'half_open';
      next.probes = 0;
      next.lastChangedAt = new Date(at).toISOString();
      next.lastChangeReason = 'open_expired';
      transitions.push({ from: 'open', to: 'half_open', reason: 'open_expired', at });
    } else {
      next.deterministicStreak = outcome === 'deterministic' ? (target.deterministicStreak || 0) + 1 : 0;
      return { target: next, transitions, health: healthOf(next.events, policy, at) };
    }
  }

  if (next.state === 'closed') {
    next.deterministicStreak = outcome === 'deterministic' ? (target.deterministicStreak || 0) + 1 : 0;
    const shouldOpen =
      health.samples >= policy.minSamples && health.failureRatio >= policy.failureRatio;
    if (shouldOpen) {
      next.state = 'open';
      next.openedAt = new Date(at).toISOString();
      next.openUntil = at + policy.openMs;
      next.probes = 0;
      next.lastChangedAt = new Date(at).toISOString();
      next.lastChangeReason = health.deterministicOnly ? 'deterministic_only' : 'failure_ratio';
      transitions.push({
        from: 'closed',
        to: 'open',
        reason: 'failure_ratio',
        at,
        samples: health.samples,
        failures: health.failures,
        failureRatio: Number(health.failureRatio.toFixed(4)),
        threshold: policy.failureRatio,
        minSamples: policy.minSamples,
        openUntil: new Date(next.openUntil).toISOString(),
      });
      return { target: next, transitions, health };
    }
    if (outcome === 'ok') next.deterministicStreak = 0;
    return { target: next, transitions, health };
  }

  // half_open：只允许有限次探测，成功攒够才合闸；一次瞬态失败立即再开。
  const probeOutcome = outcome;
  if (probeOutcome === 'deterministic') {
    // 确定性错误不能把半开探测判死，也不能算成功：探测数不推进，状态不变。
    return { target: { ...next, deterministicStreak: (target.deterministicStreak || 0) + 1 }, transitions: [], health };
  }
  const probes = Number(next.probes) || 0;
  if (probeOutcome === 'ok') {
    const advanced = probes + 1;
    next.probes = advanced;
    if (advanced >= policy.halfOpenRequiredSuccesses) {
      next.state = 'closed';
      next.events = [];
      next.openedAt = null;
      next.openUntil = null;
      next.probes = 0;
      next.lastChangedAt = new Date(at).toISOString();
      next.lastChangeReason = 'probe_success';
      transitions.push({ from: 'half_open', to: 'closed', reason: 'probe_success', probes: advanced, at });
      return { target: next, transitions, health: healthOf([], policy, at) };
    }
    return { target: next, transitions, health };
  }
  next.state = 'open';
  next.openedAt = new Date(at).toISOString();
  next.openUntil = at + policy.openMs;
  next.probes = 0;
  next.lastChangedAt = new Date(at).toISOString();
  next.lastChangeReason = 'probe_failed';
  transitions.push({ from: 'half_open', to: 'open', reason: 'probe_failed', at, openUntil: new Date(next.openUntil).toISOString() });
  return { target: next, transitions, health };
}

/**
 * 判定是否放行。
 * `reserveProbe` 给真实调用点用：半开期一次探测占一个名额，名额用尽即回到 open
 * 并把下次到期时间推后一个 openMs——否则并发探测会同时打穿上游（探测上限形同虚设）。
 * 判定函数本身保持纯净，只读状态；带 filePath 时才落盘。
 */
function guard(state, { kind, targetId, now = Date.now() }, policy = DEFAULT_POLICY, { reserveProbe = false, filePath = null } = {}) {
  const key = targetKey(kind, targetId);
  const target = state.targets[key] || emptyTarget(key);
  const resolved = target.state === 'open' && target.openUntil && now >= Number(target.openUntil)
    ? { ...target, state: 'half_open', probes: 0, lastChangeReason: 'open_expired' }
    : target;

  if (reserveProbe && resolved.state === 'half_open') {
    const used = Number(resolved.probes) || 0;
    const stale = now - (Number(resolved.lastProbeAt) || 0) >= policy.openMs;
    if (used >= policy.halfOpenMaxProbes && !stale) {
      return denyProbe(resolved, key, now);
    }
    const base = used >= policy.halfOpenMaxProbes && stale ? { ...resolved, probes: 0 } : resolved;
    const reserved = { ...base, probes: (Number(base.probes) || 0) + 1, lastProbeAt: now };
    state.targets[key] = reserved;
    if (filePath) save(state, filePath);
    return {
      allowed: true,
      state: 'half_open',
      reason: null,
      retryAfterMs: 0,
      targetKey: key,
      probeReserved: reserved.probes,
      // 探测名额被占用过久（调用挂住、进程被杀）时，一个 openMs 后重新武装，
      // 否则半开期会变成永久拒绝，比开闸更糟。
      probeReArmed: stale && used >= policy.halfOpenMaxProbes,
    };
  }

  if (resolved.state === 'open') {
    return {
      allowed: false,
      state: resolved.state,
      reason: 'circuit_open',
      retryAfterMs: Math.max(0, Number(resolved.openUntil) - now),
      targetKey: key,
      // 调用方据此把"被熔断挡住"表达成上游自己的错误类别，而不是一个新码。
      lastTransientCode: resolved.lastTransientCode || null,
      openedAt: resolved.openedAt || null,
      lastChangeReason: resolved.lastChangeReason || null,
    };
  }
  if (resolved.state === 'half_open' && (Number(resolved.probes) || 0) >= policy.halfOpenMaxProbes) {
    return denyProbe(resolved, key, now);
  }
  return { allowed: true, state: resolved.state, reason: null, retryAfterMs: 0, targetKey: key };
}

function denyProbe(target, key, now) {
  return {
    allowed: false,
    state: target.state,
    reason: 'probe_budget_used',
    retryAfterMs: Math.max(0, Number(target.openUntil || now) - now),
    targetKey: key,
    lastTransientCode: target.lastTransientCode || null,
    openedAt: target.openedAt || null,
    lastChangeReason: target.lastChangeReason || null,
  };
}

/** 记录一次结果（默认落盘），返回迁移列表与新的健康度视图。 */
function record({
  kind,
  targetId,
  ok = false,
  errorCode = null,
  at = Date.now(),
  isTransient = null,
  filePath = BREAKER_FILE,
  persist = true,
  policy = null,
}) {
  const active = policy || effectivePolicy();
  const state = load(filePath);
  const key = targetKey(kind, targetId);
  const current = state.targets[key] || emptyTarget(key);
  const outcome = classifyOutcome({ ok, errorCode, isTransient });
  const result = applyOutcome(current, { outcome, at, code: ok ? null : errorCode }, active);
  state.targets[key] = result.target;
  pruneTargets(state, active);
  if (persist) save(state, filePath);
  return {
    targetKey: key,
    outcome,
    state: result.target.state,
    transitions: result.transitions,
    health: result.health,
    deterministicStreak: result.target.deterministicStreak || 0,
  };
}

/** 目标数上限：熔断记录本身不能变成无界增长（与 §25 存储上限同一取向）。 */
function pruneTargets(state, policy) {
  const keys = Object.keys(state.targets || {});
  if (keys.length <= policy.maxTargets) return 0;
  const byAge = keys.sort((a, b) => {
    const left = Date.parse(state.targets[a].lastChangedAt || '') || 0;
    const right = Date.parse(state.targets[b].lastChangedAt || '') || 0;
    return left - right;
  });
  const drop = byAge.slice(0, keys.length - policy.maxTargets);
  for (const key of drop) delete state.targets[key];
  return drop.length;
}

function snapshot({ filePath = BREAKER_FILE, now = Date.now(), policy = null } = {}) {
  const active = policy || effectivePolicy();
  const state = load(filePath);
  const rows = Object.values(state.targets || {}).map(target => {
    const health = healthOf(target.events || [], active, now);
    return {
      targetKey: target.key,
      state: target.state,
      samples: health.samples,
      failures: health.failures,
      failureRatio: Number(health.failureRatio.toFixed(4)),
      deterministic: health.deterministic,
      deterministicOnly: health.deterministicOnly,
      probes: Number(target.probes) || 0,
      openedAt: target.openedAt || null,
      openUntil: target.openUntil || null,
      nextProbeAt: target.state === 'open' && target.openUntil ? new Date(Number(target.openUntil)).toISOString() : null,
      lastChangeReason: target.lastChangeReason || null,
      lastTransientCode: target.lastTransientCode || null,
      lastDeterministicCode: target.lastDeterministicCode || null,
    };
  });
  return {
    policyVersion: BREAKER_POLICY_VERSION,
    thresholds: active,
    updatedAt: state.updatedAt,
    targets: rows,
    openTargets: rows.filter(row => row.state !== 'closed').map(row => row.targetKey),
  };
}

function resetForTests(filePath = BREAKER_FILE) {
  try {
    fs.rmSync(filePath, { force: true });
  } catch (error) {
    /* 夹具清理失败不改变判定 */
  }
}

module.exports = {
  BREAKER_FILE,
  BREAKER_POLICY_VERSION,
  DETERMINISTIC_KINDS,
  STATES,
  TARGET_KINDS,
  TRANSIENT_KINDS,
  applyOutcome,
  classifyOutcome,
  effectivePolicy,
  emptyTarget,
  guard,
  healthOf,
  load,
  pruneTargets,
  record,
  resetForTests,
  save,
  snapshot,
  targetKey,
};
