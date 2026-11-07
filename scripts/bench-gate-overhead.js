#!/usr/bin/env node
/* global __dirname, process, require, module */
/**
 * P5-B 第 3 轮第 1 项：§26 闸门「开 / 关」两态的本地吞吐与延迟基准。
 *
 * 为什么能做：只依赖本机（本地 HTTP stub 当上游），不需要供应商额度。
 * 它回答 §26 落地后必须先知道的那件事——**闸门自身值多少钱**。
 *
 * 三个态的定义（不写清就没有可比性；全部在本进程内替换入口，
 * 生产代码里没有任何"关闭闸门"的开关或环境变量）：
 *  - A「闸门开」= 生产路径 `createChatCompletion`：`circuitBreaker.load()` → `guard()`
 *    → `throttlePolicy.admitProvider()`（放行落盘）→ `record()` + `release()`（再读再写）。
 *  - B「照常判定、去掉落盘」= 熔断读与判定、限流判定都跑真逻辑，只把三处落盘
 *    （`record`、admit 的 `persist`、release 的重读重写）摘掉。
 *    A−B = **同步写状态文件**的成本。
 *  - C「闸门关」= 四个入口全换成本地常量放行。B−C = 判定与读盘的成本。
 *
 * 上游延迟用 --delay 控制（默认 20ms）：闸门开销加在 delay 之上，
 * 报告同时给绝对增量与占上游延迟的比例——占比才是能否拿去定阈值的依据。
 *
 * 可比性由 `comparability()` 判定：任一态出现拒绝或样本数不足，三态增量一律为 null。
 * 超过并发上限时 A 会秒拒一批、B 因为不落盘而攒不出租约（结构上不会拒），
 * 此时相减得到的是"语义差"而不是"开销差"，属于假数字。
 *
 * 用法：node scripts/bench-gate-overhead.js [--delay=20] [--concurrency=1,4,8,16]
 *       [--calls=64] [--sequential=60] [--component-rounds=2000]
 */
const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');

const DEFAULTS = Object.freeze({
  delay: '20',
  sequential: '60',
  concurrency: '1,4,8,16',
  calls: '64',
  'component-rounds': '2000',
});

/** 与 scripts/eval-offline.js 同一套 `--key=value` 约定，同时接受 `--key value`；无法识别就报错，不静默忽略。 */
function parseArgs(argv = process.argv.slice(2)) {
  const args = { ...DEFAULTS };
  for (let index = 0; index < argv.length; index += 1) {
    const token = String(argv[index]);
    const eq = /^--([a-z-]+)=([\s\S]*)$/.exec(token);
    const bare = /^--([a-z-]+)$/.exec(token);
    let key;
    let value;
    if (eq) {
      key = eq[1];
      value = eq[2];
    } else if (bare) {
      key = bare[1];
      const next = argv[index + 1];
      if (next === undefined || String(next).startsWith('--')) throw new Error(`--${key} 缺少取值`);
      value = String(next);
      index += 1;
    } else {
      throw new Error(`无法识别的参数：${token}`);
    }
    if (!Object.prototype.hasOwnProperty.call(DEFAULTS, key)) throw new Error(`未知参数：--${key}`);
    args[key] = value;
  }
  return args;
}

function positiveNumber(value, label, { min = 0 } = {}) {
  const number = Number(value);
  if (!Number.isFinite(number) || number < min) throw new Error(`${label} 必须是 ≥${min} 的有限数，收到：${value}`);
  return number;
}

function prepareEnvironment() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bluebird-gate-bench-'));
  process.env.BLUEBIRD_DATA_DIR = dir;
  // 上游是 127.0.0.1 的本地 stub：测试旁路必须显式打开，否则内网拦截会先拒掉请求。
  process.env.BLUEBIRD_ALLOW_PRIVATE_BASE_URL = '1';
  process.env.DEEPSEEK_API_KEY = '';
  // 监控自身也是一段开销；基准要把变量锁在闸门上，所以关掉监控，并在限制里写明。
  process.env.BLUEBIRD_MONITORING = '0';
  return dir;
}

/** 服务端模块在 require 时就会读 BLUEBIRD_DATA_DIR，所以必须在 prepareEnvironment() 之后加载；纯函数可被单测直接 require。 */
function loadRuntime() {
  return {
    modelAdapter: require('../server/model-adapter'),
    circuitBreaker: require('../server/agents/circuit-breaker'),
    throttlePolicy: require('../server/agents/throttle-policy'),
    apiConfigs: require('../server/api-configs'),
  };
}

const MODEL_ID = 'gate-bench-stub';

function completionBody() {
  return {
    id: `chatcmpl-${Date.now()}`,
    object: 'chat.completion',
    created: Math.floor(Date.now() / 1000),
    model: MODEL_ID,
    choices: [{ index: 0, message: { role: 'assistant', content: 'ok' }, finish_reason: 'stop' }],
    usage: { prompt_tokens: 20, completion_tokens: 8, total_tokens: 28 },
  };
}

function startStubServer({ delayMs }) {
  const server = http.createServer((req, res) => {
    if (req.method === 'GET' && req.url === '/v1/models') {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ data: [{ id: MODEL_ID }] }));
      return;
    }
    if (req.method !== 'POST' || req.url !== '/v1/chat/completions') {
      res.writeHead(404, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'not_found' }));
      return;
    }
    let body = '';
    req.on('data', chunk => {
      body += chunk;
    });
    req.on('end', () => {
      // 固定延迟：让三态的唯一变量落在闸门上。
      setTimeout(() => {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify(completionBody()));
      }, delayMs);
    });
  });
  return new Promise(resolve => {
    server.listen(0, '127.0.0.1', () => resolve(server));
  });
}

function armPatches(rt, real) {
  return {
    // B：判定照跑，落盘摘掉。
    decideNoPersist() {
      rt.circuitBreaker.record = () => ({ state: 'closed' });
      rt.throttlePolicy.admitProvider = options => {
        const admit = real.admitProvider({ ...options, persist: false });
        if (!admit.allowed) return admit;
        return { ...admit, release: () => ({}) };
      };
    },
    // C：整个闸门不参与。
    gateOff() {
      rt.circuitBreaker.load = () => ({ targets: {}, policyVersion: 'bench-off' });
      rt.circuitBreaker.guard = () => ({ allowed: true, state: 'closed', retryAfterMs: 0, reason: 'bench_off' });
      rt.circuitBreaker.record = () => ({ state: 'closed' });
      rt.throttlePolicy.admitProvider = () => ({ allowed: true, decision: null, denials: [], release() {} });
    },
  };
}

/** 跑一个态：装补丁→执行→立刻还原。补丁只存在于本进程。 */
async function withArm(rt, arm, run) {
  if (arm === 'gateOn') return run();
  const real = {
    breakerLoad: rt.circuitBreaker.load,
    breakerGuard: rt.circuitBreaker.guard,
    breakerRecord: rt.circuitBreaker.record,
    admitProvider: rt.throttlePolicy.admitProvider,
  };
  armPatches(rt, real)[arm]();
  try {
    return await run();
  } finally {
    rt.circuitBreaker.load = real.breakerLoad;
    rt.circuitBreaker.guard = real.breakerGuard;
    rt.circuitBreaker.record = real.breakerRecord;
    rt.throttlePolicy.admitProvider = real.admitProvider;
    // 上一态留下的状态文件会影响下一态（槽位租约 120 秒），跑完就清。
    rt.throttlePolicy.resetForTests();
    rt.circuitBreaker.resetForTests();
  }
}

function percentile(sorted, p) {
  if (!sorted.length) return null;
  const index = Math.min(sorted.length - 1, Math.ceil((p / 100) * sorted.length) - 1);
  return sorted[Math.max(0, index)];
}

function summarize(samples, { wallMs, denied, denyReasons }) {
  const sorted = [...samples].sort((a, b) => a - b);
  const reasons = Object.keys(denyReasons || {}).length ? { denyReasons } : {};
  if (!sorted.length) {
    return { n: 0, denied, ...reasons, meanMs: null, p50Ms: null, p95Ms: null, maxMs: null, wallMs, perSecond: 0 };
  }
  const mean = sorted.reduce((sum, value) => sum + value, 0) / sorted.length;
  return {
    n: sorted.length,
    denied,
    ...reasons,
    meanMs: Number(mean.toFixed(3)),
    p50Ms: Number(percentile(sorted, 50).toFixed(3)),
    p95Ms: Number(percentile(sorted, 95).toFixed(3)),
    maxMs: Number(sorted[sorted.length - 1].toFixed(3)),
    wallMs: Number(wallMs.toFixed(1)),
    perSecond: Number(((sorted.length / wallMs) * 1000).toFixed(2)),
  };
}

async function callOnce(rt, target) {
  const started = process.hrtime.bigint();
  const elapsed = () => Number(process.hrtime.bigint() - started) / 1e6;
  try {
    await rt.modelAdapter.createChatCompletion({
      providerId: target.providerId,
      modelId: target.modelId,
      messages: [{ role: 'user', content: 'gate bench' }],
      stream: false,
      timeout: 20000,
    });
    return { ms: elapsed(), denied: false };
  } catch (error) {
    if (error && error.throttle) {
      return { ms: elapsed(), denied: true, reason: error.throttle.mechanism };
    }
    throw error;
  }
}

/**
 * 一个并发档位、一个态：固定总调用数，worker 轮流取号。
 * 被闸门挡下的调用单独计数，不进延迟样本——拒绝是闸门的语义而不是开销，
 * 混进去会把"本地秒拒"统计成"上游很快"。
 */
async function runLevel(rt, target, { concurrency, total, arm }) {
  return withArm(rt, arm, async () => {
    const samples = [];
    const denyReasons = {};
    let denied = 0;
    let cursor = 0;
    const startedAt = Date.now();
    const worker = async () => {
      for (;;) {
        const index = cursor;
        cursor += 1;
        if (index >= total) return;
        const outcome = await callOnce(rt, target);
        if (outcome.denied) {
          denied += 1;
          const key = outcome.reason || 'unknown';
          denyReasons[key] = (denyReasons[key] || 0) + 1;
        } else {
          samples.push(outcome.ms);
        }
      }
    };
    await Promise.all(Array.from({ length: concurrency }, worker));
    return summarize(samples, { wallMs: Date.now() - startedAt, denied, denyReasons });
  });
}

function delta(a, b, delayMs) {
  if (a.meanMs === null || b.meanMs === null) return null;
  return {
    meanMs: Number((a.meanMs - b.meanMs).toFixed(3)),
    p95Ms: Number((a.p95Ms - b.p95Ms).toFixed(3)),
    wallMs: Number((a.wallMs - b.wallMs).toFixed(1)),
    perSecond: Number((a.perSecond - b.perSecond).toFixed(2)),
    shareOfUpstreamPercent: Number((((a.meanMs - b.meanMs) / delayMs) * 100).toFixed(2)),
  };
}

/** 三态是否可比：样本集必须完全一致（同样多的放行、零拒绝）。 */
function comparability(arms, total) {
  const mismatched = Object.entries(arms).filter(([, summary]) => summary.denied > 0 || summary.n !== total);
  if (!mismatched.length) return { comparable: true, reason: null };
  const detail = mismatched
    .map(([name, summary]) => {
      const reasons = summary.denyReasons
        ? `（${Object.entries(summary.denyReasons).map(([key, count]) => `${key}×${count}`).join(', ')}）`
        : '';
      return `${name} 放行 ${summary.n}/${total}、拒绝 ${summary.denied}${reasons}`;
    })
    .join('；');
  return {
    comparable: false,
    reason: `样本集不一致：${detail}。被拒调用是闸门语义而非开销；去掉落盘的态攒不出租约，结构上不会触发并发上限，两者相减得不到开销。`,
  };
}

function costs(arms, { total, delayMs }) {
  const verdict = comparability(arms, total);
  if (!verdict.comparable) {
    return { comparability: verdict, writeCost: null, decideCost: null, totalGateCost: null };
  }
  return {
    comparability: verdict,
    writeCost: delta(arms.gateOn, arms.decideNoPersist, delayMs),
    decideCost: delta(arms.decideNoPersist, arms.gateOff, delayMs),
    totalGateCost: delta(arms.gateOn, arms.gateOff, delayMs),
  };
}

/**
 * 组件分解：每项每轮跑前清空两个状态文件，并记录实际走了哪条分支。
 * 不隔离就会踩坑：令牌桶与 120 秒租约被前面的测量占满后，
 * "放行路径"的计时其实落在"被拒路径"上，数字会自相矛盾。
 */
function timeEach(rt, label, fn, rounds) {
  const samples = [];
  const paths = {};
  for (let index = 0; index < rounds; index += 1) {
    rt.throttlePolicy.resetForTests();
    rt.circuitBreaker.resetForTests();
    const started = process.hrtime.bigint();
    const key = fn(index) || 'done';
    samples.push(Number(process.hrtime.bigint() - started) / 1e3);
    paths[key] = (paths[key] || 0) + 1;
  }
  const sorted = [...samples].sort((a, b) => a - b);
  return {
    label,
    rounds,
    paths,
    medianUs: Number(percentile(sorted, 50).toFixed(2)),
    p95Us: Number(percentile(sorted, 95).toFixed(2)),
  };
}

function componentBreakdown(rt, target, rounds) {
  const policy = rt.circuitBreaker.effectivePolicy();
  const holder = `bench:${process.pid}`;
  const admitted = index => {
    const admit = rt.throttlePolicy.admitProvider({ providerId: target.providerId, holderId: `${holder}:${index}` });
    if (!admit.allowed) return `denied:${admit.decision.mechanism}`;
    admit.release();
    return 'admitted';
  };
  const decideOnly = index => {
    const admit = rt.throttlePolicy.admitProvider({ providerId: target.providerId, holderId: `${holder}:np${index}`, persist: false });
    if (!admit.allowed) return `denied:${admit.decision.mechanism}`;
    admit.release();
    return 'admitted(no persist)';
  };
  return [
    timeEach(rt, 'circuitBreaker.load()（读状态文件）', () => {
      rt.circuitBreaker.load();
      return 'loaded';
    }, rounds),
    timeEach(rt, 'guard(load())（熔断判定，含读）', () => {
      rt.circuitBreaker.guard(rt.circuitBreaker.load(), { kind: 'provider', targetId: target.providerId }, policy);
      return 'allowed';
    }, rounds),
    timeEach(rt, 'guard(内存态)（纯判定，无读盘）', () => {
      rt.circuitBreaker.guard({ targets: {}, policyVersion: 'mem' }, { kind: 'provider', targetId: target.providerId }, policy);
      return 'allowed';
    }, rounds),
    timeEach(rt, 'admitProvider() 放行 + release()（两次写）', admitted, rounds),
    timeEach(rt, 'admitProvider({persist:false}) + release()', decideOnly, rounds),
    timeEach(rt, 'throttlePolicy.save()（单次同步原子写）', () => {
      rt.throttlePolicy.save(rt.throttlePolicy.load(), rt.throttlePolicy.THROTTLE_FILE);
      return 'written';
    }, rounds),
    timeEach(rt, 'circuitBreaker.save()（单次同步原子写）', () => {
      rt.circuitBreaker.save(rt.circuitBreaker.load(), rt.circuitBreaker.BREAKER_FILE);
      return 'written';
    }, rounds),
    timeEach(rt, 'circuitBreaker.record(ok)（记账，含写）', () => {
      rt.circuitBreaker.record({ kind: 'provider', targetId: target.providerId, ok: true, at: Date.now() });
      return 'recorded';
    }, rounds),
    timeEach(rt, 'enterProviderGate() + release()（整条闸门）', index => {
      const gate = rt.modelAdapter.enterProviderGate({ providerId: target.providerId, holderId: `${holder}:g${index}` });
      if (!gate.allowed) return 'gate-denied';
      gate.release();
      return 'gate-passed';
    }, rounds),
  ];
}

async function main(argv = process.argv.slice(2)) {
  const args = parseArgs(argv);
  // 报告的关键一列是"占上游延迟的比例"，上游为 0 时该比例无定义，所以不允许 --delay=0。
  const delayMs = positiveNumber(args.delay, '--delay', { min: 1 });
  const sequentialCalls = positiveNumber(args.sequential, '--sequential', { min: 1 });
  const callsPerLevel = positiveNumber(args.calls, '--calls', { min: 1 });
  const componentRounds = positiveNumber(args['component-rounds'], '--component-rounds', { min: 1 });
  const concurrencies = String(args.concurrency)
    .split(',')
    .map(item => positiveNumber(item.trim(), '--concurrency', { min: 1 }));

  const dataDir = prepareEnvironment();
  const rt = loadRuntime();
  const server = await startStubServer({ delayMs });
  const base = `http://127.0.0.1:${server.address().port}/v1`;
  let exitCode = 0;
  try {
    const added = rt.apiConfigs.addModelProvider({
      name: 'Gate Bench Local Stub',
      baseUrl: base,
      apiKey: 'bench-not-used',
      models: [{ id: MODEL_ID, name: MODEL_ID, capabilities: { tools: false, vision: false } }],
    });
    const target = { providerId: added.provider.id, modelId: MODEL_ID };
    // 预热：把 SDK 与连接建立的首次成本从三态里都排除掉。
    await callOnce(rt, target);

    const workloads = [];
    for (const concurrency of concurrencies) {
      const total = concurrency === 1 ? sequentialCalls : callsPerLevel;
      const arms = {
        gateOn: await runLevel(rt, target, { concurrency, total, arm: 'gateOn' }),
        decideNoPersist: await runLevel(rt, target, { concurrency, total, arm: 'decideNoPersist' }),
        gateOff: await runLevel(rt, target, { concurrency, total, arm: 'gateOff' }),
      };
      workloads.push({
        concurrency,
        total,
        upstreamDelayMs: delayMs,
        ...arms,
        // 归因：写盘 vs 判定；样本集不一致时三项增量都为 null（见 comparability）。
        ...costs(arms, { total, delayMs }),
      });
    }

    console.log(`[EVIDENCE] gate-bench ${JSON.stringify({
      policyVersion: {
        limiter: rt.throttlePolicy.LIMIT_POLICY_VERSION,
        breaker: rt.circuitBreaker.BREAKER_POLICY_VERSION,
      },
      providerThresholds: rt.throttlePolicy.effectiveThresholds({}).thresholds.provider,
      environment: {
        node: process.version,
        platform: `${process.platform} ${process.arch}`,
        monitoring: 'off',
        upstream: `local http stub, fixed ${delayMs}ms`,
        arms: {
          gateOn: '生产路径原样',
          decideNoPersist: '判定照跑，record/admit 落盘/release 重写摘掉',
          gateOff: '四个闸门入口常量放行',
        },
        writesPerAdmittedCall: {
          throttle: 2,
          breaker: 1,
          syncReads: 4,
          note: '闭合态：admit 落盘 1 次 + record 写 1 次 + release 重写 1 次；同步读 4 次（breaker.load、admitProvider 的 load、record 的 load、release 的 load）；均 writeFileAtomicSync（含 fsync）。半开态 guard(reserveProbe) 会多写 1 次探测名额，本基准全程闭合态，不含这一次。',
        },
      },
      workloads,
      components: componentBreakdown(rt, target, componentRounds),
    }, null, 2)}`);
  } catch (error) {
    console.error(`[EVIDENCE] gate-bench-error ${String((error && error.message) || error)}`);
    exitCode = 1;
  } finally {
    if (typeof server.closeAllConnections === 'function') server.closeAllConnections();
    server.close();
    try {
      fs.rmSync(dataDir, { recursive: true, force: true });
    } catch (_) {
      /* 清理失败不影响基准结论 */
    }
  }
  return exitCode;
}

if (require.main === module) {
  main().then(code => {
    process.exitCode = code;
  }).catch(error => {
    console.error(`[EVIDENCE] gate-bench-error ${String((error && error.message) || error)}`);
    process.exitCode = 1;
  });
}

module.exports = { main, parseArgs, percentile, summarize, delta, comparability, costs, runLevel, componentBreakdown, withArm };
