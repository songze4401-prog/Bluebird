/* global require, process, __dirname */
/**
 * P5-B：四维限流、三态熔断与重规划风暴抑制（Notion §26，台账 B-07）。
 *
 * 覆盖：
 *  a) 阈值表：四个维度齐全、版本化、env 夹位、任务维度与运行时取值一致、
 *     Run 维度引用 §25 常量而不是另建计数；
 *  b) 信号量：占用/重入续租/满位拒绝带 retryAfterMs/租约到期自动回收；
 *  c) 令牌桶与有界队列：速率到顶拒绝、时间推进回填、队列到顶拒绝且不消耗额度；
 *  d) 熔断三态：小样本不开闸、确定性错误不计故障率、开闸→半开探测→合闸、
 *     半开遇瞬态立即再开、状态读盘可续（跨重启）；
 *  e) 错误分类表与 model-adapter 的 ERROR_STATUS 键集对齐（防两处漂移）；
 *  f) 风暴五条：缺声明、改正即刻放行、等价计划+同指纹、冷却、无实质 diff、
 *     换 runId 规避、每 Task 上限补位、覆盖值不得放宽 §25、digest 与 workflow-store 同源；
 *  g) 端到端 createChatCompletion：成功记账、熔断打开后零上游请求且错误码保持上游类别、
 *     限流拒绝带可识别明细；
 *  h) 生产接入点 runtime.admitRetryAttempt：无计划任务放行到 §25 上限后收口。
 *
 * 隔离纪律：BLUEBIRD_DATA_DIR 在 require server/ 之前指向临时目录；
 * 纯函数用例一律显式传 filePath，只有走生产代码的 g/h 用默认路径并先重置。
 */
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const test = require('node:test');

const ROOT = path.resolve(__dirname, '..');
const SERVER = path.join(ROOT, 'server');
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'bluebird-p5b-'));
process.env.BLUEBIRD_DATA_DIR = TMP;
process.env.BLUEBIRD_MONITORING = '0';

// openai 桩必须在 model-adapter 之前装好（它在加载时就 require SDK）。
const RealOpenAI = require('openai');
const openaiTarget = require.resolve('openai', { paths: [SERVER] });
const stubState = { calls: [], error: null, reply: '桩回复' };

require.cache[openaiTarget] = {
  id: openaiTarget,
  filename: openaiTarget,
  loaded: true,
  exports: class StubOpenAI {
    constructor(config) {
      this.config = config;
      if (config && config.baseURL === 'https://api.deepseek.com') {
        this.chat = {
          completions: {
            create: async args => {
              stubState.calls.push(args);
              if (stubState.error) {
                const err = new Error(stubState.error.message || 'stub failure');
                err.status = stubState.error.status;
                err.name = stubState.error.name || 'APIError';
                throw err;
              }
              if (args && args.stream) {
                return (async function* emit() {
                  yield { model: args.model, choices: [{ index: 0, delta: { content: stubState.reply } }] };
                })();
              }
              return { model: args.model, choices: [{ index: 0, message: { role: 'assistant', content: stubState.reply } }] };
            },
          },
        };
      } else {
        this._real = new RealOpenAI(config);
        this.chat = this._real.chat;
      }
    }
  },
};

const throttle = require('../server/agents/throttle-policy');
const breaker = require('../server/agents/circuit-breaker');
const storm = require('../server/agents/storm-suppression');
const workflowStore = require('../server/agents/workflow-store');
const planner = require('../server/agents/planner');
const agentLimits = require('../server/agents/agent-limits');
const modelAdapter = require('../server/model-adapter');
const runtime = require('../server/agents/runtime');
const tasks = require('../server/agents/tasks');

const N = Date.UTC(2026, 10, 7, 0, 0, 0);
const THROTTLE_FILE = path.join(TMP, 'throttle-case.json');
const BREAKER_FILE = path.join(TMP, 'breaker-case.json');
const STORM_FILE = path.join(TMP, 'storm-case.json');
const GATE_TEST_KEY = 'sk-p5b-gate-test-key';

function freshThrottle() {
  throttle.resetForTests(THROTTLE_FILE);
  return throttle.load(THROTTLE_FILE);
}

function freshBreaker() {
  breaker.resetForTests(BREAKER_FILE);
  return breaker.load(BREAKER_FILE);
}

function freshStorm() {
  storm.resetForTests(STORM_FILE);
  return storm.load(STORM_FILE);
}

test('a. 阈值表：四维齐全且版本化，取值来源单一，env 夹位不越界', () => {
  const snapshot = throttle.policySnapshot();
  assert.equal(snapshot.policyVersion, 'p5b-throttle-v1');
  assert.deepEqual(snapshot.dimensions, ['run', 'task', 'agent', 'provider']);
  assert.deepEqual(snapshot.mechanisms, ['concurrency', 'rate', 'queue']);
  assert.equal(snapshot.throttleCode, 'throttle_limited');

  // Run 维度引用 §25 常量：不是另建一套计数，而是把既有上限登记进阈值表。
  assert.equal(snapshot.thresholds.run.replans.limit, agentLimits.MAX_REPLANS_PER_RUN);
  assert.equal(snapshot.thresholds.run.retries.limit, agentLimits.MAX_RUN_RETRIES);
  assert.equal(snapshot.thresholds.run.delegationDepth.limit, agentLimits.MAX_DELEGATION_DEPTH);
  // Agent 维度的执行归属留在 router，本模块不自建第二份并发统计。
  assert.match(snapshot.thresholds.agent.concurrency.owner, /router\.decideInternal/);
  assert.equal(snapshot.owners.provider, 'throttle-policy.js（本轮新增：信号量 + 令牌桶 + 有界队列）');

  // 任务维度与运行时取值一致（夹到 1..4，默认 2）。
  assert.equal(runtime.getQueueStats().concurrency, snapshot.thresholds.task.concurrency.limit);
  const original = process.env.BLUEBIRD_AGENT_TASK_CONCURRENCY;
  process.env.BLUEBIRD_AGENT_TASK_CONCURRENCY = '99';
  assert.equal(throttle.effectiveThresholds().thresholds.task.concurrency.limit, 4, 'env 越界必须夹到上限');
  process.env.BLUEBIRD_AGENT_TASK_CONCURRENCY = '0';
  assert.equal(throttle.effectiveThresholds().thresholds.task.concurrency.limit, 1);
  if (original === undefined) delete process.env.BLUEBIRD_AGENT_TASK_CONCURRENCY;
  else process.env.BLUEBIRD_AGENT_TASK_CONCURRENCY = original;

  assert.throws(() => throttle.effectiveThresholds({ gateway: {} }), /未知限流维度/);
  assert.throws(() => throttle.effectiveThresholds({ provider: { depth: {} } }), /没有机制/);
  assert.throws(() => throttle.keyOf('provider', ''), /缺少限流对象标识/);
});

test('b. 信号量：重入续租不重复占位，满位给出 retryAfterMs，租约到期自动回收', () => {
  const state = freshThrottle();
  const limit = 2;
  const leaseMs = 60000;
  const take = (holderId, at) =>
    throttle.acquireSlot(state, {
      dimension: 'provider',
      scopeId: 'deepseek',
      holderId,
      now: at,
      limit,
      leaseMs,
    });

  assert.equal(take('a', N).allowed, true);
  assert.equal(take('b', N + 10).allowed, true);
  const full = take('c', N + 20);
  assert.equal(full.allowed, false);
  assert.equal(full.reason, 'concurrency_limit');
  assert.equal(full.limit, limit);
  assert.ok(full.retryAfterMs > 0 && full.retryAfterMs <= leaseMs);
  assert.deepEqual(full.waiters, ['a', 'b'], '被拒时要能看见是谁占着槽位');

  const renew = take('a', N + 30);
  assert.equal(renew.allowed, true);
  assert.equal(renew.reason, 'renewed');
  assert.equal(renew.used, 2, '同一持有者重入不得多占一个槽位');

  const released = throttle.releaseSlot(state, { dimension: 'provider', scopeId: 'deepseek', holderId: 'b', now: N + 40 });
  assert.equal(released.released, true);
  assert.equal(take('c', N + 50).allowed, true);

  // 租约到期：持有者崩溃后不需要外部清理，下一次判定自然回收。
  const expired = throttle.acquireSlot(state, {
    dimension: 'provider',
    scopeId: 'deepseek',
    holderId: 'd',
    now: N + leaseMs + 1000,
    limit,
    leaseMs,
  });
  assert.equal(expired.allowed, true);
  assert.equal(expired.used, 1, '过期槽位必须被清掉，只留新持有者');
  assert.throws(() => throttle.acquireSlot(state, { dimension: 'gateway', scopeId: 'x', holderId: 'h', now: N, limit: 1, leaseMs: 1000 }), /未知限流维度/);
});

test('c. 令牌桶与有界队列：到顶拒绝、时间推进回填、被拒不消耗额度', () => {
  const rate = { requests: 10, windowMs: 10000, burst: 3 };
  let bucket;
  const kinds = [];
  for (let index = 0; index < 5; index += 1) {
    const result = throttle.takeTokens(bucket, { ...rate, now: N });
    kinds.push(result.allowed ? 'ok' : 'deny');
    bucket = result.bucket;
  }
  assert.deepEqual(kinds, ['ok', 'ok', 'ok', 'deny', 'deny'], '突发容量=burst，之后必须拒绝');
  assert.equal(bucket.capacity, 3);
  // 每 1000ms 补 1 个令牌：推进 2 秒后放行 2 次，第 3 次仍拒。
  const after = [];
  let cursor = bucket;
  for (let index = 0; index < 3; index += 1) {
    const result = throttle.takeTokens(cursor, { ...rate, now: N + 2000 });
    after.push(result.allowed);
    cursor = result.bucket;
  }
  assert.deepEqual(after, [true, true, false]);
  assert.equal(throttle.takeTokens(undefined, { requests: 10, windowMs: 10000, burst: 3, now: N }).allowed, true, '空桶首次调用按满桶起算');

  const state = freshThrottle();
  const admitted = throttle.admitQueue(state, { dimension: 'provider', scopeId: 'deepseek', now: N, maxDepth: 2 });
  assert.equal(admitted.allowed, true);
  throttle.admitQueue(state, { dimension: 'provider', scopeId: 'deepseek', now: N, maxDepth: 2 });
  const overflow = throttle.admitQueue(state, { dimension: 'provider', scopeId: 'deepseek', now: N, maxDepth: 2 });
  assert.equal(overflow.allowed, false);
  assert.equal(overflow.reason, 'queue_full');
  assert.equal(overflow.used, 2);
  assert.equal(throttle.leaveQueue(state, { dimension: 'provider', scopeId: 'deepseek' }).used, 1);
  assert.equal(throttle.leaveQueue(state, { dimension: 'provider', scopeId: 'deepseek' }).used, 0);
  assert.equal(throttle.leaveQueue(state, { dimension: 'provider', scopeId: 'deepseek' }).used, 0, '深度不会减成负数');

  // 队列到顶时，闸门在任何写盘之前返回：一次被拒不该吃掉令牌或槽位。
  const file = path.join(TMP, 'throttle-queue.json');
  throttle.resetForTests(file);
  const denied = [];
  for (let index = 0; index < 4; index += 1) {
    denied.push(
      throttle.admitProvider({
        providerId: 'deepseek',
        holderId: `q${index}`,
        now: N,
        filePath: file,
        overrides: { provider: { queue: { maxDepth: 1 } } },
      })
    );
  }
  assert.equal(denied[0].allowed, true);
  assert.equal(denied[1].allowed, false);
  assert.equal(denied[1].decision.mechanism, 'queue');
  assert.equal(denied[1].decision.dimension, 'provider');
  assert.match(denied[1].decision.errorFingerprint, /^[0-9a-f]{64}$/);
  assert.equal(denied[1].decision.retryable, true, '限流是可重试的，与 §23 契约同构');
  const reloaded = throttle.load(file);
  assert.equal(Object.keys(reloaded.buckets).length, 1, '被拒的三次调用不得留下令牌桶痕迹');
  assert.equal(reloaded.queues['provider:deepseek'].depth, 1);

  const info = throttle.throttleError({ dimension: 'provider', mechanism: 'rate', reason: 'rate_limit', limit: 3, used: 3, retryAfterMs: 1200, scopeId: 'deepseek', taskId: 't1', runId: 'r1' });
  assert.equal(info.causeRef, 'provider:rate:rate_limit');
  assert.equal(info.code, 'throttle_limited');
  assert.ok(Number.isFinite(Date.parse(info.failedAt)), 'failedAt 必须是合法时间');
  assert.equal(info.taskId, 't1');
  assert.equal(info.runId, 'r1');
});

test('d. 熔断三态：小样本不开闸、确定性错误不计故障率、半开探测合闸与再开', () => {
  const file = path.join(TMP, 'breaker-state.json');
  breaker.resetForTests(file);
  const policy = breaker.effectivePolicy();

  for (let index = 0; index < 9; index += 1) {
    breaker.record({ kind: 'provider', targetId: 'deepseek', ok: false, errorCode: 'timeout', at: N + index * 100, filePath: file });
  }
  let snap = breaker.snapshot({ filePath: file, now: N + 1000 });
  assert.equal(snap.targets[0].state, 'closed', '9 个样本不足以开闸，一次抖动不能当崩盘');
  assert.equal(snap.targets[0].samples, 9);

  breaker.record({ kind: 'provider', targetId: 'deepseek', ok: false, errorCode: 'server', at: N + 1000, filePath: file });
  snap = breaker.snapshot({ filePath: file, now: N + 1100 });
  assert.equal(snap.targets[0].state, 'open');
  assert.equal(snap.targets[0].failureRatio, 1);
  assert.equal(snap.targets[0].lastTransientCode, 'server', '开闸后要能回上游自己的错误类别');

  const active = breaker.guard(breaker.load(file), { kind: 'provider', targetId: 'deepseek', now: N + 1200 }, policy);
  assert.equal(active.allowed, false);
  assert.equal(active.reason, 'circuit_open');
  assert.equal(active.lastTransientCode, 'server');
  assert.ok(active.retryAfterMs > 0 && active.retryAfterMs <= policy.openMs);

  const afterOpen = breaker.guard(breaker.load(file), { kind: 'provider', targetId: 'deepseek', now: N + 1200 + policy.openMs + 1 }, policy);
  assert.equal(afterOpen.allowed, true, '开闸到期后必须进半开并放探测');
  assert.equal(afterOpen.state, 'half_open');

  breaker.record({ kind: 'provider', targetId: 'deepseek', ok: false, errorCode: 'connection', at: N + 1200 + policy.openMs + 10, filePath: file });
  const reopened = breaker.guard(breaker.load(file), { kind: 'provider', targetId: 'deepseek', now: N + 1200 + policy.openMs + 20 }, policy);
  assert.equal(reopened.allowed, false);
  assert.equal(reopened.state, 'open', '半开探测遇到瞬态失败立即再开');

  // 半开探测名额：并发探测不能一起打穿上游；名额用尽即拒，长期未收口则重新武装。
  const probeFile = path.join(TMP, 'breaker-probe.json');
  breaker.resetForTests(probeFile);
  for (let index = 0; index < 10; index += 1) {
    // Worker 域用任务级错误码（model_*），不是 model-adapter 的 kind：
    // 两个域的错误码空间不同，分类表也分别定义（见 circuit-breaker 的 DOMAIN_POLICIES）。
    breaker.record({ kind: 'worker', targetId: 'executor', ok: false, errorCode: 'model_timeout', at: N + index * 100, filePath: probeFile });
  }
  const halfAt = N + 1000 + policy.openMs + 5;
  const probeOptions = { reserveProbe: true, filePath: probeFile };
  const first = breaker.guard(breaker.load(probeFile), { kind: 'worker', targetId: 'executor', now: halfAt }, policy, probeOptions);
  assert.equal(first.allowed, true);
  assert.equal(first.probeReserved, 1);
  const second = breaker.guard(breaker.load(probeFile), { kind: 'worker', targetId: 'executor', now: halfAt + 1 }, policy, probeOptions);
  assert.equal(second.allowed, true);
  assert.equal(second.probeReserved, 2);
  const third = breaker.guard(breaker.load(probeFile), { kind: 'worker', targetId: 'executor', now: halfAt + 2 }, policy, probeOptions);
  assert.equal(third.allowed, false);
  assert.equal(third.reason, 'probe_budget_used');
  // 探测成功仍然要能合闸：名额是并发上限，不是"必须先失败几次"。
  const healed = breaker.record({ kind: 'worker', targetId: 'executor', ok: true, at: halfAt + 3, filePath: probeFile });
  assert.equal(healed.state, 'closed');

  const stuckState = breaker.load(probeFile);
  stuckState.targets['worker:executor'] = {
    ...breaker.emptyTarget('worker:executor'),
    state: 'half_open',
    openUntil: N + 1000,
    probes: policy.halfOpenMaxProbes,
    lastProbeAt: N + 1000 + policy.openMs + 3,
  };
  breaker.save(stuckState, probeFile);
  const rearmed = breaker.guard(
    breaker.load(probeFile),
    { kind: 'worker', targetId: 'executor', now: N + 1000 + policy.openMs * 2 + 5000 },
    policy,
    probeOptions
  );
  assert.equal(rearmed.allowed, true, '探测名额挂死不能变成永久拒绝');
  assert.equal(rearmed.probeReArmed, true);

  // 确定性错误：100% 的 bad_request 也不该把熔断打开。
  const detFile = path.join(TMP, 'breaker-deterministic.json');
  breaker.resetForTests(detFile);
  for (let index = 0; index < 15; index += 1) {
    const outcome = breaker.record({ kind: 'tool', targetId: 'memory_remember', ok: false, errorCode: 'bad_request', at: N + index * 100, filePath: detFile });
    assert.equal(outcome.outcome, 'deterministic');
  }
  const detSnap = breaker.snapshot({ filePath: detFile, now: N + 2000 });
  assert.equal(detSnap.targets[0].state, 'closed');
  assert.equal(detSnap.targets[0].samples, 0, '确定性错误不进故障率分母');
  assert.equal(detSnap.targets[0].deterministic, 15);
  assert.equal(detSnap.targets[0].deterministicOnly, true);

  // 合闸路径：开闸 → 到期 → 两次探测成功 → closed 且窗口清空。
  breaker.record({ kind: 'provider', targetId: 'deepseek', ok: true, at: N + 1200 + policy.openMs * 2 + 2000, filePath: file });
  const closedOnce = breaker.snapshot({ filePath: file, now: N + 1200 + policy.openMs * 2 + 2100 });
  assert.equal(closedOnce.targets[0].state, 'half_open');
  assert.equal(closedOnce.targets[0].probes, 1);
  breaker.record({ kind: 'provider', targetId: 'deepseek', ok: true, at: N + 1200 + policy.openMs * 2 + 2200, filePath: file });
  const closed = breaker.snapshot({ filePath: file, now: N + 1200 + policy.openMs * 2 + 2300 });
  assert.equal(closed.targets[0].state, 'closed');
  assert.equal(closed.targets[0].samples, 0);
  assert.equal(closed.targets[0].lastChangeReason, 'probe_success');

  // 状态必须能从盘上读回（进程重启后熔断仍然有效）。
  const reread = breaker.load(file);
  assert.equal(reread.targets['provider:deepseek'].state, 'closed');
  assert.equal(reread.policyVersion, breaker.BREAKER_POLICY_VERSION);

  assert.throws(() => breaker.targetKey('gateway', 'x'), /未知熔断对象类型/);
  assert.throws(() => breaker.targetKey('provider', ' '), /缺少标识/);
  assert.throws(() => breaker.effectivePolicy({ halfOpenRequiredSuccesses: 9 }), /halfOpenRequiredSuccesses 不得大于/);
  assert.throws(() => breaker.effectivePolicy({ unknown: 1 }), /未知熔断阈值/);

  // 目标数上限：熔断记录自己不能变成无界文件。
  const many = { targets: {} };
  for (let index = 0; index < policy.maxTargets + 5; index += 1) {
    many.targets[`provider:p${index}`] = breaker.emptyTarget(`provider:p${index}`);
  }
  assert.equal(breaker.pruneTargets(many, policy), 5);
  assert.equal(Object.keys(many.targets).length, policy.maxTargets);
});

test('e. 错误分类表与 model-adapter 对齐，未知码保守当瞬态', () => {
  const kinds = Object.keys(modelAdapter.ERROR_STATUS);
  const covered = new Set([...breaker.TRANSIENT_KINDS, ...breaker.DETERMINISTIC_KINDS]);
  for (const kind of kinds) {
    assert.ok(covered.has(kind), `model-adapter 的 ${kind} 未纳入熔断分类表`);
  }
  for (const transient of ['timeout', 'connection', 'server', 'rate_limit']) {
    assert.equal(breaker.classifyOutcome({ ok: false, errorCode: transient }), 'transient');
  }
  for (const deterministic of ['auth', 'model', 'bad_request', 'not_configured', 'capability', 'cancelled']) {
    assert.equal(breaker.classifyOutcome({ ok: false, errorCode: deterministic }), 'deterministic');
  }
  assert.equal(breaker.classifyOutcome({ ok: true }), 'ok');
  assert.equal(breaker.classifyOutcome({ ok: false, errorCode: 'brand_new_code' }), 'transient', '未知码必须保守当瞬态');
  assert.equal(breaker.classifyOutcome({ ok: false, errorCode: 'auth', isTransient: () => true }), 'transient', '调用方注入的分类器优先');
});

test('f. 风暴抑制五条细则 + 上限补位 + digest 与 workflow-store 同源', () => {
  const file = STORM_FILE;
  freshStorm();
  const policy = storm.effectivePolicy();
  const baselineDigest = `sha256:${'a'.repeat(64)}`;
  const claim = { benefit: '去掉一轮无证据的检索', baselineDigest, comparatorId: 'candidate' };
  const badClaim = { benefit: '只写了收益' };
  const planA = { steps: [{ toolName: 'memory_search', args: { q: 'a' } }, { toolName: 'summarize', args: { n: 1 } }] };
  const planSameButReordered = { steps: [planA.steps[1], planA.steps[0]] };
  const planB = { steps: [{ toolName: 'memory_search', args: { q: 'b' } }, { toolName: 'summarize', args: { n: 1 } }] };
  const decide = (extra, at = N) =>
    storm.decide({ taskId: 't1', claim: badClaim, errorFingerprint: 'fp-1', ...extra }, { filePath: file, policy, now: at });

  // 细则 1：缺收益声明字段即拒；且拒绝不该武装冷却（改正后要能立刻再来）。
  const missing = decide({ plan: planA, runId: 'r1' });
  assert.equal(missing.allowed, false);
  assert.equal(missing.rule, 'missing_improvement_claim');
  assert.deepEqual(missing.violations[0].missing, ['baselineDigest', 'comparatorId']);

  const fixed = decide({ plan: planA, runId: 'r1', claim }, N + 3000);
  assert.equal(fixed.allowed, true, '契约错改正后不得被冷却卡住');
  assert.equal(fixed.replans, 0);

  // 细则 2：同一计划 + 同一错误指纹 = 等价重投。
  const equivalent = decide({ plan: planA, runId: 'r1', claim }, N + 70000);
  assert.equal(equivalent.rule, 'equivalent_rejected_plan');
  assert.equal(equivalent.digest, workflowStore.digestPlan(planA), '计划哈希必须与 workflow-store 同源');

  // 细则 3：撞墙类拒绝武装冷却，改进版计划也要等冷却过。
  const cooling = decide({ plan: planB, runId: 'r1', claim }, N + 70500);
  assert.equal(cooling.rule, 'cooldown_active');
  assert.ok(cooling.retryAfterMs > 0 && cooling.retryAfterMs <= policy.cooldownMs);
  const cooled = decide({ plan: planB, runId: 'r1', claim }, N + 200000);
  assert.equal(cooled.allowed, true, '冷却期满后换过计划的改进版应可放行');

  // 细则 4：步骤键完全相同（仅顺序不同）算无实质差异。
  const freshState = freshStorm();
  const immaterial = storm.evaluate(freshState, {
    taskId: 't2',
    runId: 'r1',
    plan: planSameButReordered,
    previousPlan: planA,
    claim,
    errorFingerprint: 'fp-2',
    now: N,
  }, policy);
  assert.equal(immaterial.allowed, false);
  assert.ok(immaterial.violations.some(item => item.rule === 'immaterial_plan_diff'));
  const material = storm.evaluate(freshStorm(), {
    taskId: 't3',
    runId: 'r1',
    plan: planB,
    previousPlan: planA,
    claim,
    errorFingerprint: 'fp-3',
    now: N,
  }, policy);
  assert.equal(material.allowed, true, '真改了步骤就要放行');

  // 细则 5：换 runId 但计划与错误都没变 → 想洗掉计数，拒。
  const evadeFile = path.join(TMP, 'storm-evade.json');
  storm.resetForTests(evadeFile);
  const firstRun = storm.decide({ taskId: 't4', runId: 'run-a', plan: planA, claim, errorFingerprint: 'fp-4' }, { filePath: evadeFile, policy, now: N });
  assert.equal(firstRun.allowed, true);
  const secondRun = storm.decide({ taskId: 't4', runId: 'run-b', plan: planA, claim, errorFingerprint: 'fp-4' }, { filePath: evadeFile, policy, now: N + policy.cooldownMs + 1000 });
  assert.equal(secondRun.allowed, false);
  assert.ok(secondRun.violations.map(item => item.rule).includes('new_run_evade'));

  // §25 每 Run 2 次的上限在风暴处补位执行（生产此前没有调用方）。
  const limitFile = path.join(TMP, 'storm-limit.json');
  storm.resetForTests(limitFile);
  const plain = (fp, at) =>
    storm.decide({ taskId: 't5', runId: 'r1', requiresClaim: false, errorFingerprint: fp }, { filePath: limitFile, policy, now: at });
  assert.equal(plain('fp-a', N).allowed, true);
  assert.equal(plain('fp-b', N + 1).allowed, true);
  assert.equal(plain('fp-c', N + 2).rule, 'replan_limit_reached');

  // 阈值只能更严，不得放宽到超过 §25。
  assert.throws(() => storm.effectivePolicy({ maxReplansPerTask: agentLimits.MAX_REPLANS_PER_RUN + 1 }), /不得超过/);
  assert.throws(() => storm.taskKey(''), /需要 Task 归属/);
  assert.throws(() => storm.decide({ taskId: 't6' }, { filePath: limitFile, now: { bad: 1 } }), /必须是数值时间戳/);

  // 收益声明里的比较对象必须是 §14 真实类型，不能自造一个名字蒙过去。
  const bogus = storm.checkImprovementClaim({ benefit: 'x', baselineDigest, comparatorId: 'self_invented' }, policy);
  assert.equal(bogus.violated, true);
  assert.match(bogus.note, /不属于 §14 五类/);
  const digestFormat = storm.checkImprovementClaim({ benefit: 'x', baselineDigest: 'not-a-digest', comparatorId: 'candidate' }, policy);
  assert.equal(digestFormat.violated, true);
  assert.deepEqual(digestFormat.missing, ['baselineDigest']);

  // 记账边界：条目数上限、拒绝历史上限、状态读回。
  const statusView = storm.status({ filePath: limitFile, now: N + 3 });
  assert.equal(statusView.entries.length, 1);
  assert.equal(statusView.entries[0].limit, policy.maxReplansPerTask);
  assert.equal(statusView.policyVersion, 'p5b-storm-v1');
  const bigState = { entries: {} };
  for (let index = 0; index < policy.maxEntries + 7; index += 1) {
    bigState.entries[`task:${index}`] = { replans: 0, denials: [], lastReplanAt: new Date(N + index).toISOString() };
  }
  assert.equal(storm.pruneEntries(bigState, policy), 7);
});

test('g. 端到端：createChatCompletion 的熔断与限流都在发请求之前，且不改写错误码', async () => {
  const throttleDefault = throttle.THROTTLE_FILE;
  const breakerDefault = breaker.BREAKER_FILE;
  throttle.resetForTests(throttleDefault);
  breaker.resetForTests(breakerDefault);
  stubState.calls = [];
  stubState.error = null;

  const call = () =>
    modelAdapter.createChatCompletion({
      providerId: 'deepseek',
      modelId: 'deepseek-chat',
      messages: [{ role: 'user', content: '闸门测试' }],
      credentialKey: GATE_TEST_KEY,
      maxTokens: 32,
    });

  const ok = await call();
  assert.ok(ok.choices[0].message.content === stubState.reply);
  assert.equal(stubState.calls.length, 1);
  assert.equal(breaker.snapshot({ now: Date.now() }).targets[0].state, 'closed');

  // 连续 10 次服务商 5xx → 熔断开闸；第 11 次必须零上游请求且错误码仍是 server。
  stubState.error = { status: 503, message: 'upstream boom' };
  for (let index = 0; index < 10; index += 1) {
    await assert.rejects(call, error => error.kind === 'server');
  }
  assert.equal(stubState.calls.length, 11);
  const open = breaker.snapshot({ now: Date.now() });
  assert.equal(open.targets[0].state, 'open');
  assert.equal(open.targets[0].lastTransientCode, 'server');

  const blocked = await call().then(() => null, error => error);
  assert.equal(blocked.kind, 'server', '被熔断挡住要回上游自己的错误类别，而不是新码');
  assert.equal(blocked.status, modelAdapter.ERROR_STATUS.server);
  assert.equal(blocked.throttle.mechanism, 'breaker');
  assert.equal(blocked.throttle.upstreamRequested, false);
  assert.ok(blocked.throttle.retryAfterMs >= 0);
  assert.equal(stubState.calls.length, 11, '开闸期间一次上游请求都不许发');

  // 限流路径：熔断恢复后，队列深度到顶同样零上游，且带可识别明细。
  breaker.resetForTests(breakerDefault);
  throttle.resetForTests(throttleDefault);
  stubState.error = null;
  const queueFull = await modelAdapter
    .createChatCompletion({
      providerId: 'deepseek',
      modelId: 'deepseek-chat',
      messages: [{ role: 'user', content: '闸门测试' }],
      credentialKey: GATE_TEST_KEY,
      maxTokens: 32,
    })
    .then(result => ({ ok: result }))
    .catch(error => ({ error }));
  assert.ok(queueFull.ok, '默认阈值下第一次调用应放行');

  const originalDepth = process.env.BLUEBIRD_PROVIDER_QUEUE_DEPTH;
  process.env.BLUEBIRD_PROVIDER_QUEUE_DEPTH = '0';
  const denied = await call().then(() => null, error => error);
  assert.equal(denied.kind, 'rate_limit', '限流复用既有 rate_limit（429），不新造码');
  assert.equal(denied.status, 429);
  assert.equal(denied.throttle.mechanism, 'queue');
  assert.equal(denied.throttle.dimension, 'provider');
  assert.equal(denied.throttle.policyVersion, 'p5b-throttle-v1');
  assert.match(denied.throttle.errorFingerprint, /^[0-9a-f]{64}$/);
  if (originalDepth === undefined) delete process.env.BLUEBIRD_PROVIDER_QUEUE_DEPTH;
  else process.env.BLUEBIRD_PROVIDER_QUEUE_DEPTH = originalDepth;
  assert.equal(stubState.calls.length, 12, '限流拒绝也不发上游请求（11 次上游调用 + 放行这一次）');
  const holdersNow = throttle.statusOf(throttle.load(throttleDefault), throttle.effectiveThresholds().thresholds, Date.now()).slots;
  assert.deepEqual(holdersNow, [], '到这里的每次放行都必须已释放槽位（空槽位不进快照）');

  // 流式路径：记账收口在 finish()，成功流要把槽位释放掉。
  const streamed = await modelAdapter.createChatCompletion({
    providerId: 'deepseek',
    modelId: 'deepseek-chat',
    messages: [{ role: 'user', content: '流式闸门' }],
    credentialKey: GATE_TEST_KEY,
    stream: true,
    maxTokens: 32,
  });
  for await (const chunk of streamed) assert.ok(chunk.choices[0].delta.content);
  const slotsAfterStream = throttle.statusOf(throttle.load(throttleDefault), throttle.effectiveThresholds().thresholds, Date.now()).slots;
  assert.equal(slotsAfterStream.length, 0, `流式结束后槽位必须释放：${JSON.stringify(slotsAfterStream)}`);

  // 客户端断开不算服务商故障。
  assert.equal(modelAdapter.streamSettleKind('client_closed'), 'cancelled');
  assert.equal(modelAdapter.streamSettleKind('stream_error'), 'server');
  assert.equal(modelAdapter.streamSettleKind('timeout'), 'timeout');

  // 观测出口：闸门状态可以从运行时的 limits 快照里一次读全。
  const snapshot = runtime.limitsSnapshot();
  assert.equal(snapshot.available, true);
  assert.equal(snapshot.policy.policyVersion, 'p5b-throttle-v1');
  assert.equal(snapshot.breaker.policyVersion, 'p5b-breaker-v1');
  assert.equal(snapshot.storm.policyVersion, 'p5b-storm-v1');
  assert.deepEqual(Object.keys(snapshot.throttle).sort(), ['buckets', 'policyVersion', 'queues', 'slots', 'updatedAt']);
});

test('h. 生产接入点：admitRetryAttempt 把 §25 上限真正落到重试决策上', () => {
  const stateFile = path.join(TMP, 'agents', 'replan-storm.json');
  storm.resetForTests(stateFile);
  const task = tasks.createTask({ botId: 'memory', taskType: 'memory.search', goal: '风暴抑制生产接线' });
  tasks.transitionTask(task.taskId, { to: 'accepted' });
  tasks.transitionTask(task.taskId, { to: 'running' });

  const attempt = (runId, errorCode, at) =>
    runtime.admitRetryAttempt({ task: tasks.getTask(task.taskId), runId, errorCode, now: at });

  const first = attempt('run-1', 'model_timeout', N);
  assert.equal(first.allowed, true);
  assert.equal(first.planDigest, null, '未绑定工作流计划的任务没有计划哈希');
  const second = attempt('run-2', 'model_timeout', N + 120000);
  assert.equal(second.allowed, true);
  const third = attempt('run-3', 'model_timeout', N + 240000);
  assert.equal(third.allowed, false);
  assert.equal(third.rule, 'replan_limit_reached');
  assert.equal(third.replans, 2);

  // 终态收口由既有分支负责：disposition 仍是 retry，风暴只是把 retry 关掉。
  const disposition = runtime.decideFailureDisposition({
    errorCode: 'model_timeout',
    attempts: 3,
    maxAttempts: 5,
  });
  assert.equal(disposition.retryable, true, '§25 之内仍允许重试，风暴在此之上再加一道');

  // 绑定计划的任务要带上计划哈希，供等价判定使用。
  const planned = planner.plan({ goal: '检索记忆并汇总成三条要点' });
  const boundTask = tasks.createTask({
    botId: 'memory',
    taskType: 'memory.search',
    goal: '带计划的重试',
    planId: planned.planId,
    planVersion: planned.planVersion,
  });
  const withPlan = runtime.admitRetryAttempt({ task: tasks.getTask(boundTask.taskId), runId: 'run-1', errorCode: 'model_connection', now: N });
  assert.equal(withPlan.allowed, true);
  assert.match(String(withPlan.planDigest), /^sha256:[0-9a-f]{64}$/);
  assert.equal(withPlan.planDigest, planned.digest, '风暴用的计划哈希必须与 Planner 落盘的同一个');

  // 等价判据必须跨 attempt 成立：每次重试都会换一个新 runId，
  // 若身份里带 runId，"同一任务反复撞同一个错"就永远不相等，细则 2 形同虚设。
  const again = runtime.admitRetryAttempt({ task: tasks.getTask(boundTask.taskId), runId: 'run-2', errorCode: 'model_connection', now: N + 700000 });
  assert.equal(again.rule, 'equivalent_rejected_plan', '换了 runId 但计划与错误类别都没变 = 等价重投，拒');
  assert.ok(again.retryAfterMs > 0, '等价重投武装冷却');
  assert.ok(again.violations.map(item => item.rule).includes('new_run_evade'), '同时命中"新建 Run 规避"');

  // 计划读不回时不猜哈希：其余细则照常生效，且不因为读不到计划而放行成"永远不等价"。
  const ghost = runtime.admitRetryAttempt({
    task: { taskId: 'ghost-task', planId: 'plan_00000000000000000000000000000000', planVersion: 7 },
    runId: 'run-1',
    errorCode: 'model_timeout',
    now: N,
  });
  assert.equal(ghost.planDigest, null);
  assert.equal(ghost.allowed, true);
});

test.after(() => {
  fs.rmSync(TMP, { recursive: true, force: true });
});
