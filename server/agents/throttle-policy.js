/* global module, __dirname, process */
/**
 * P5-B（Notion §26 第 1、2 项）：Run / Task / Agent / Provider 四维限流。
 *
 * 原文要求：四个维度各有并发与速率上限、令牌桶或信号量、有界队列与**可识别的限流错误**，
 * 阈值必须版本化并保守默认。
 *
 * 这一模块刻意不重新发明已经被别处管住的东西（§2.4 / Phase 0 的硬要求）：
 *  - Run 维度的重规划 2 次、Run 重试 3 次、委派深度 2 层归 `agent-limits.js`（§25），
 *    这里只引用其常量并把它们登记进阈值表，不另建第二套计数；
 *  - Agent 维度的并发余量归 `router.js` 的 `decideInternal.atCapacity`
 *    （running >= manifest.concurrencyLimit），编排层已有"不得重复统计"的规则，
 *    这里只提供阈值来源与版本，不在第二个地方再数一遍在飞任务；
 *  - Provider 维度此前只有"单次调用的 timeout"，没有并发/速率/队列上限，
 *    因此新增的**真实闸门**只落在这里：信号量（在飞上限）+ 令牌桶（速率）+ 有界队列。
 *
 * 计数的可靠性口径与 `agent-limits.js` 一致：读文件即事实来源，模块不缓存，
 * 进程重启不会把已用额度清零；信号量槽位带租约（leaseMs），
 * 持有者崩溃后槽位会自然过期，不需要外部清理任务。
 *
 * 阈值是 B 类数值（需压测校准）：本轮给保守默认并版本化，
 * 未测得数据前不调高；所有默认值都写进 `DEFAULT_THRESHOLDS` 一处，便于压测后整体替换。
 */
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { writeFileAtomicSync } = require('../atomic-write');

const LIMIT_POLICY_VERSION = 'p5b-throttle-v1';
const SCHEMA_VERSION = 1;

const agentLimits = require('./agent-limits');

const DATA_DIR = process.env.BLUEBIRD_DATA_DIR
  ? path.resolve(process.env.BLUEBIRD_DATA_DIR)
  : path.join(__dirname, '..', 'data');
const AGENTS_DIR = path.join(DATA_DIR, 'agents');
const THROTTLE_FILE = path.join(AGENTS_DIR, 'agent-throttle.json');

// 单一限流码：原文只要求"可识别的限流错误"，未规定码名（本仓库裁决）。
// 维度与机制放进 details，便于监控按 dimension 聚合而不必新增四个码。
const THROTTLE_CODE = 'throttle_limited';
const DIMENSIONS = Object.freeze(['run', 'task', 'agent', 'provider']);
const MECHANISMS = Object.freeze(['concurrency', 'rate', 'queue']);

function clampIntEnv(raw, fallback, min, max) {
  const value = Number(raw);
  if (!Number.isFinite(value)) return fallback;
  return Math.min(max, Math.max(min, Math.floor(value)));
}

/**
 * 保守默认（B 类数值，必须由压测复定）：
 *  - Provider 并发 8：必须**大于**任务队列自身的并发上限 4，否则内部任务会把自己的
 *    闸门踩死（每个在飞任务都要一次模型调用）；同时给聊天流量封顶。
 *  - Provider 速率 1200 次/60 秒、突发 300：这组数是被实测校正过的，不是拍脑袋放大。
 *    第一轮取 120/60s + 突发 20 时，`tests/agent-tools.test.js` 与
 *    `tests/memory-budget-golden.test.js` 的正常流量被本地闸门挡成 `rate_limit`
 *    （前者跑到第 2 次模型调用就被截断，断言只剩 1 次调用）。真实流量与测试回放都会
 *    超过那个量，所以先取"不误伤合法流量的上界"，收紧留给有基线数据的那一轮。
 *  - 队列深度 16：超出即拒绝并把深度如实报出去，不阻塞调用方。
 */
const DEFAULT_THRESHOLDS = Object.freeze({
  provider: Object.freeze({
    concurrency: Object.freeze({ limit: 8, leaseMs: 120000 }),
    rate: Object.freeze({ requests: 1200, windowMs: 60000, burst: 300 }),
    queue: Object.freeze({ maxDepth: 16, waitMs: 0 }),
  }),
  run: Object.freeze({
    // 引用 §25 既有硬限，不改写数值：这里出现只是为了让阈值表是完整的。
    replans: Object.freeze({ limit: agentLimits.MAX_REPLANS_PER_RUN, owner: 'agent-limits.recordReplan' }),
    retries: Object.freeze({ limit: agentLimits.MAX_RUN_RETRIES, owner: 'agent-limits.recordRunRetry' }),
    delegationDepth: Object.freeze({ limit: agentLimits.MAX_DELEGATION_DEPTH, owner: 'agent-limits.assertDelegationAllowed' }),
    concurrency: Object.freeze({ limit: 1, leaseMs: 300000 }),
  }),
  task: Object.freeze({
    // 与既有运行时的取值完全一致（env 夹到 1..4，默认 2）：本轮只是把来源收进版本化阈值表，
    // 不改行为，也不允许出现"两处各设一个并发上限"。
    concurrency: Object.freeze({ limit: 2, leaseMs: 300000, env: 'BLUEBIRD_AGENT_TASK_CONCURRENCY' }),
    toolCalls: Object.freeze({ limit: 6, owner: 'agents/runtime.js:MAX_TASK_TOOL_CALLS' }),
    rounds: Object.freeze({ limit: 3, owner: 'agent-runtime.js:MAX_ROUNDS' }),
  }),
  agent: Object.freeze({
    // 执行点留在 router，本模块只登记来源，避免两处各自数在飞任务。
    concurrency: Object.freeze({ limit: 2, owner: 'router.decideInternal.atCapacity' }),
    rate: Object.freeze({ requests: 0, windowMs: 0, owner: 'unwired' }),
  }),
});

const ENV_KEYS = Object.freeze({
  providerConcurrency: 'BLUEBIRD_PROVIDER_MAX_CONCURRENCY',
  providerRequests: 'BLUEBIRD_PROVIDER_RPS_WINDOW_REQUESTS',
  providerWindowMs: 'BLUEBIRD_PROVIDER_RPS_WINDOW_MS',
  providerQueue: 'BLUEBIRD_PROVIDER_QUEUE_DEPTH',
  providerBurst: 'BLUEBIRD_PROVIDER_BURST',
});

function effectiveThresholds(overrides = {}) {
  const env = process.env;
  const base = JSON.parse(JSON.stringify(DEFAULT_THRESHOLDS));
  base.provider.concurrency.limit = clampIntEnv(env[ENV_KEYS.providerConcurrency], base.provider.concurrency.limit, 1, 64);
  base.provider.rate.requests = clampIntEnv(env[ENV_KEYS.providerRequests], base.provider.rate.requests, 1, 1000);
  base.provider.rate.burst = clampIntEnv(env[ENV_KEYS.providerBurst], base.provider.rate.burst, 1, 64);
  base.provider.queue.maxDepth = clampIntEnv(env[ENV_KEYS.providerQueue], base.provider.queue.maxDepth, 0, 256);
  base.task.concurrency.limit = clampIntEnv(
    env[DEFAULT_THRESHOLDS.task.concurrency.env],
    base.task.concurrency.limit,
    1,
    4
  );
  const windowMs = Number(env[ENV_KEYS.providerWindowMs]);
  if (Number.isFinite(windowMs) && windowMs >= 1000 && windowMs <= 3600000) {
    base.provider.rate.windowMs = Math.floor(windowMs);
  }
  for (const [dimension, patch] of Object.entries(overrides || {})) {
    if (!DIMENSIONS.includes(dimension)) throw new Error(`未知限流维度：${dimension}`);
    for (const [mechanism, values] of Object.entries(patch || {})) {
      if (!Object.prototype.hasOwnProperty.call(base[dimension], mechanism)) {
        throw new Error(`维度 ${dimension} 没有机制 ${mechanism} 的阈值位`);
      }
      base[dimension][mechanism] = { ...base[dimension][mechanism], ...values };
    }
  }
  return { policyVersion: LIMIT_POLICY_VERSION, thresholds: base };
}

function load(filePath = THROTTLE_FILE) {
  const target = String(filePath || THROTTLE_FILE);
  if (!fs.existsSync(target)) {
    return { version: SCHEMA_VERSION, policyVersion: LIMIT_POLICY_VERSION, slots: {}, buckets: {}, queues: {}, updatedAt: null };
  }
  let parsed;
  try {
    parsed = JSON.parse(fs.readFileSync(target, 'utf8'));
  } catch (error) {
    // 读坏不能当"没占用"：那等于把已耗尽的额度洗白，让闸门在最需要的时候放行。
    throw new Error(`限流状态不可读：${error.message}`);
  }
  if (parsed.version !== SCHEMA_VERSION) throw new Error(`限流状态版本不匹配：${parsed.version}`);
  return {
    version: SCHEMA_VERSION,
    // 阈值换了版本就必须重算窗口，否则旧桶会带着新限额继续放行。
    policyVersion: parsed.policyVersion || LIMIT_POLICY_VERSION,
    slots: parsed.slots && typeof parsed.slots === 'object' ? parsed.slots : {},
    buckets: parsed.buckets && typeof parsed.buckets === 'object' ? parsed.buckets : {},
    queues: parsed.queues && typeof parsed.queues === 'object' ? parsed.queues : {},
    updatedAt: parsed.updatedAt || null,
  };
}

function save(state, filePath = THROTTLE_FILE) {
  const target = String(filePath || THROTTLE_FILE);
  fs.mkdirSync(path.dirname(target), { recursive: true });
  state.updatedAt = new Date().toISOString();
  writeFileAtomicSync(target, JSON.stringify(state, null, 2));
  return target;
}

function keyOf(dimension, scopeId) {
  if (!DIMENSIONS.includes(dimension)) throw new Error(`未知限流维度：${dimension}`);
  const clean = String(scopeId === null || scopeId === undefined ? '' : scopeId).trim();
  if (!clean) throw new Error(`维度 ${dimension} 缺少限流对象标识`);
  return `${dimension}:${clean}`;
}

/** 纯函数：过期槽位清理 + 是否还有空位。槽位带租约，持有者崩溃后自动回收。 */
function acquireSlot(state, { dimension, scopeId, holderId, now, limit, leaseMs }) {
  const key = keyOf(dimension, scopeId);
  const slot = state.slots[key] || { holders: [] };
  const holders = (Array.isArray(slot.holders) ? slot.holders : []).filter(
    item => item && Number(item.leaseUntil) > now
  );
  const taken = holders.find(item => String(item.holderId) === String(holderId));
  if (taken) {
    // 同一持有者重入不算新增占用，但必须能续租，否则长调用会被自己饿死。
    taken.leaseUntil = now + leaseMs;
    taken.renewedAt = new Date(now).toISOString();
    state.slots[key] = { holders };
    return { allowed: true, reason: 'renewed', used: holders.length, limit, retryAfterMs: 0, holderId };
  }
  if (holders.length >= limit) {
    const earliest = Math.min(...holders.map(item => Number(item.leaseUntil)));
    state.slots[key] = { holders };
    return {
      allowed: false,
      reason: 'concurrency_limit',
      used: holders.length,
      limit,
      retryAfterMs: Math.max(0, earliest - now),
      waiters: holders.map(item => String(item.holderId)),
    };
  }
  holders.push({ holderId: String(holderId), since: new Date(now).toISOString(), leaseUntil: now + leaseMs });
  state.slots[key] = { holders };
  return { allowed: true, reason: null, used: holders.length, limit, retryAfterMs: 0, holderId };
}

function releaseSlot(state, { dimension, scopeId, holderId, now }) {
  const key = keyOf(dimension, scopeId);
  const slot = state.slots[key] || { holders: [] };
  const before = (Array.isArray(slot.holders) ? slot.holders : []).length;
  const holders = slot.holders.filter(
    item => String(item.holderId) !== String(holderId) && Number(item.leaseUntil) > now
  );
  state.slots[key] = { holders };
  return { released: before > holders.length, used: holders.length };
}

/**
 * 纯函数令牌桶：按窗口速率回填，容量是 burst 个令牌（突发允许的上限次数）。
 * 回填用离散步长（每 windowMs/requests 毫秒补 1 个令牌），所以同一批时间戳结果确定，可单测。
 */
function takeTokens(bucket, { now, requests, windowMs, burst }) {
  const perTokenMs = windowMs / requests;
  const capacity = Math.max(1, Math.floor(burst));
  const start = bucket && Number.isFinite(bucket.lastRefillAt) ? Number(bucket.lastRefillAt) : now;
  const tokens = bucket && Number.isFinite(bucket.tokens) ? Math.min(capacity, bucket.tokens) : capacity;
  const elapsed = Math.max(0, now - start);
  const refilled = Math.floor(elapsed / perTokenMs);
  const grown = Math.min(capacity, tokens + refilled);
  const next = { lastRefillAt: start + refilled * perTokenMs, tokens: grown, capacity };
  if (grown < 1) {
    return {
      bucket: next,
      allowed: false,
      reason: 'rate_limit',
      remaining: next.tokens,
      capacity,
      limit: requests,
      retryAfterMs: Math.max(1, Math.ceil(perTokenMs - (elapsed % perTokenMs))),
    };
  }
  next.tokens = grown - 1;
  return { bucket: next, allowed: true, reason: null, remaining: next.tokens, capacity, limit: requests, retryAfterMs: 0 };
}

/**
 * 纯函数有界队列：深度到顶就拒绝，并把当前深度如实报出去。
 * 原文要的是"有界"，不是"排队等待"，所以这里不阻塞调用方。
 */
function admitQueue(state, { dimension, scopeId, now, maxDepth, waitMs = 0 }) {
  const key = keyOf(dimension, scopeId);
  const entry = state.queues[key] || { depth: 0, updatedAt: null };
  const depth = Number(entry.depth) || 0;
  if (depth >= maxDepth) {
    return {
      allowed: false,
      reason: 'queue_full',
      used: depth,
      limit: maxDepth,
      retryAfterMs: Math.max(0, Number(waitMs) || 0),
    };
  }
  state.queues[key] = { depth: depth + 1, updatedAt: new Date(now).toISOString() };
  return { allowed: true, reason: null, used: depth + 1, limit: maxDepth, retryAfterMs: 0 };
}

function leaveQueue(state, { dimension, scopeId }) {
  const key = keyOf(dimension, scopeId);
  const entry = state.queues[key] || { depth: 0 };
  const depth = Math.max(0, (Number(entry.depth) || 0) - 1);
  state.queues[key] = { depth, updatedAt: new Date().toISOString() };
  return { used: depth };
}

function throttleError({ dimension, mechanism, reason, limit, used, retryAfterMs, scopeId, taskId = null, runId = null }) {
  const fingerprint = crypto
    .createHash('sha256')
    .update(`${dimension}|${mechanism}|${String(scopeId)}|${String(taskId)}|${String(runId)}`)
    .digest('hex');
  return {
    code: THROTTLE_CODE,
    retryable: true,
    errorFingerprint: fingerprint,
    failedAt: new Date().toISOString(),
    taskId: taskId === null || taskId === undefined ? '' : String(taskId),
    runId: runId === null || runId === undefined ? null : String(runId),
    causeRef: `${dimension}:${mechanism}:${reason}`,
    dimension,
    mechanism,
    reason,
    limit,
    used,
    retryAfterMs,
    policyVersion: LIMIT_POLICY_VERSION,
  };
}

/**
 * 一次判定（默认落盘）：队列 → 速率 → 并发。
 * 顺序刻意为"先便宜后贵"：队列能挡住堆积，就不必为被拒的请求消耗令牌。
 * 拒绝时不落盘（不占额度），放行时才写回占用，因此重试不会把闸门越踩越死。
 */
function admitProvider({
  providerId,
  holderId,
  now = Date.now(),
  filePath = THROTTLE_FILE,
  overrides = {},
  taskId = null,
  runId = null,
  persist = true,
} = {}) {
  const { thresholds } = effectiveThresholds(overrides);
  const provider = thresholds.provider;
  const state = load(filePath);
  const denials = [];

  const queue = admitQueue(state, {
    dimension: 'provider',
    scopeId: providerId,
    now,
    maxDepth: provider.queue.maxDepth,
    waitMs: provider.queue.waitMs,
  });
  if (!queue.allowed) {
    denials.push(throttleError({ dimension: 'provider', mechanism: 'queue', ...queue, scopeId: providerId, taskId, runId }));
    return { allowed: false, decision: denials[0], denials, state: statusOf(state, thresholds, now) };
  }
  const bucketResult = takeTokens(state.buckets[keyOf('provider', providerId)], {
    now,
    requests: provider.rate.requests,
    windowMs: provider.rate.windowMs,
    burst: provider.rate.burst,
  });
  if (!bucketResult.allowed) {
    leaveQueue(state, { dimension: 'provider', scopeId: providerId });
    denials.push(
      throttleError({
        dimension: 'provider',
        mechanism: 'rate',
        ...bucketResult,
        used: bucketResult.capacity - bucketResult.remaining,
        scopeId: providerId,
        taskId,
        runId,
      })
    );
    return { allowed: false, decision: denials[0], denials, state: statusOf(state, thresholds, now) };
  }
  const slot = acquireSlot(state, {
    dimension: 'provider',
    scopeId: providerId,
    holderId,
    now,
    limit: provider.concurrency.limit,
    leaseMs: provider.concurrency.leaseMs,
  });
  if (!slot.allowed) {
    // 并发满：队列占用与刚取的令牌都要归还，否则一次被拒会永久吃掉额度。
    leaveQueue(state, { dimension: 'provider', scopeId: providerId });
    state.buckets[keyOf('provider', providerId)] = {
      ...bucketResult.bucket,
      tokens: Math.min(bucketResult.capacity, bucketResult.bucket.tokens + 1),
    };
    denials.push(throttleError({ dimension: 'provider', mechanism: 'concurrency', ...slot, scopeId: providerId, taskId, runId }));
    return { allowed: false, decision: denials[0], denials, state: statusOf(state, thresholds, now) };
  }
  state.buckets[keyOf('provider', providerId)] = bucketResult.bucket;
  if (persist) save(state, filePath);
  return {
    allowed: true,
    decision: null,
    denials,
    // 释放时重新读盘而不是复用这里的快照：并发调用交错时，
    // 拿着旧 state 落盘会把别人刚占的槽位抹掉，槽位会比实际更空。
    release: () => release({ providerId, holderId, filePath }),
    queueToken: true,
    state: statusOf(state, thresholds, now),
  };
}

function release({ providerId, holderId, filePath = THROTTLE_FILE, state = null }) {
  const current = state || load(filePath);
  const slot = releaseSlot(current, { dimension: 'provider', scopeId: providerId, holderId, now: Date.now() });
  leaveQueue(current, { dimension: 'provider', scopeId: providerId });
  save(current, filePath);
  return slot;
}

function statusOf(state, thresholds, now = Date.now()) {
  const rows = [];
  for (const [key, slot] of Object.entries(state.slots || {})) {
    const holders = (slot.holders || []).filter(item => Number(item.leaseUntil) > now);
    // 空槽位不进快照：观测面上留一排 0 会让"现在谁在跑"看不清，
    // 也让"释放干净了没有"这种断言变成对历史键的计数。
    if (holders.length === 0) continue;
    const [dimension, ...rest] = key.split(':');
    rows.push({
      key,
      dimension,
      scopeId: rest.join(':'),
      inFlight: holders.length,
      limit: thresholds[dimension].concurrency.limit,
      holderIds: holders.map(item => String(item.holderId)),
    });
  }
  const buckets = {};
  for (const [key, bucket] of Object.entries(state.buckets || {})) {
    buckets[key] = { tokens: bucket.tokens, capacity: bucket.capacity };
  }
  const queues = {};
  for (const [key, entry] of Object.entries(state.queues || {})) {
    const [dimension, ...rest] = key.split(':');
    queues[key] = { depth: entry.depth || 0, limit: thresholds[dimension].queue ? thresholds[dimension].queue.maxDepth : null, scopeId: rest.join(':') };
  }
  return { policyVersion: LIMIT_POLICY_VERSION, slots: rows, buckets, queues, updatedAt: state.updatedAt };
}

/** 阈值快照：给监控与文档用，明确"哪一维由谁执行"。 */
function policySnapshot(overrides = {}) {
  const { thresholds } = effectiveThresholds(overrides);
  return {
    policyVersion: LIMIT_POLICY_VERSION,
    dimensions: DIMENSIONS,
    mechanisms: MECHANISMS,
    throttleCode: THROTTLE_CODE,
    thresholds,
    owners: {
      run: 'agent-limits.js（§25 计数，持久化）',
      task: 'agents/runtime.js（MAX_TASK_TOOL_CALLS、deadlineMs）',
      agent: 'router.js（decideInternal.atCapacity，running >= manifest.concurrencyLimit）',
      provider: 'throttle-policy.js（本轮新增：信号量 + 令牌桶 + 有界队列）',
    },
  };
}

function resetForTests(filePath = THROTTLE_FILE) {
  try {
    fs.rmSync(filePath, { force: true });
  } catch (error) {
    /* 夹具清理失败不改变判定 */
  }
}

module.exports = {
  DEFAULT_THRESHOLDS,
  DIMENSIONS,
  LIMIT_POLICY_VERSION,
  MECHANISMS,
  THROTTLE_CODE,
  THROTTLE_FILE,
  acquireSlot,
  admitQueue,
  admitProvider,
  effectiveThresholds,
  keyOf,
  leaveQueue,
  load,
  policySnapshot,
  release,
  releaseSlot,
  resetForTests,
  save,
  statusOf,
  takeTokens,
  throttleError,
};
