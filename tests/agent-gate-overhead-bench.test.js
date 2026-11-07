/* global require, process, __dirname */
/**
 * P5-B 第 3 轮第 1 项：闸门开销基准（scripts/bench-gate-overhead.js）的口径守卫。
 *
 * 基准脚本本身不是产品代码，但它产出的数字会被拿去定 §26 阈值，
 * 所以"数字怎么算、什么时候不许算"必须是确定性纯函数并有单测：
 *  - 参数解析不许静默忽略（写错一个 flag 就换了一套负载，结论会假）；
 *  - 被闸门拒绝的调用不进延迟样本（拒绝是语义不是开销）；
 *  - 三态样本集不一致时增量必须为 null，而不是给一个看着像开销的差值。
 *
 * 隔离纪律：本文件只 require 基准脚本的纯函数，不 require server/，
 * 也不改 process.env；脚本的环境准备与模块加载都在 main() 里，require 无副作用。
 */
const assert = require('node:assert');
const path = require('path');
const test = require('node:test');
const { spawnSync } = require('child_process');

const REPO_ROOT = path.resolve(__dirname, '..');
const CLI = path.join(REPO_ROOT, 'scripts', 'bench-gate-overhead.js');
const envBefore = { ...process.env };
const bench = require('../scripts/bench-gate-overhead');

function summary({ n, denied = 0, meanMs, p95Ms = meanMs, wallMs = 1000, denyReasons }) {
  return {
    n,
    denied,
    ...(denyReasons ? { denyReasons } : {}),
    meanMs,
    p50Ms: meanMs,
    p95Ms,
    maxMs: meanMs,
    wallMs,
    perSecond: Number(((n / wallMs) * 1000).toFixed(2)),
  };
}

test('a. require 无副作用：不建临时目录、不改环境变量', () => {
  assert.deepEqual(process.env, envBefore, '基准脚本被 require 时不许动进程环境');
  assert.equal(typeof bench.main, 'function');
  assert.equal(typeof bench.comparability, 'function');
});

test('b. 参数解析：两种写法等价，写错就报错而不是静默用默认值', () => {
  assert.deepEqual(bench.parseArgs([]), {
    delay: '20',
    sequential: '60',
    concurrency: '1,4,8,16',
    calls: '64',
    'component-rounds': '2000',
  });
  assert.deepEqual(
    bench.parseArgs(['--delay=5', '--component-rounds=400']),
    bench.parseArgs(['--delay', '5', '--component-rounds', '400']),
    '--key=value 与 --key value 必须等价'
  );
  assert.equal(bench.parseArgs(['--delay=5']).delay, '5');
  assert.throws(() => bench.parseArgs(['--component-rounds=400', '--typo=1']), /未知参数：--typo/);
  assert.throws(() => bench.parseArgs(['--delay']), /--delay 缺少取值/);
  assert.throws(() => bench.parseArgs(['--delay', '--calls=4']), /--delay 缺少取值/);
  assert.throws(() => bench.parseArgs(['positional']), /无法识别的参数/);
});

test('c. 分位数与汇总：拒绝不进样本，空样本给 null 而不是 0', () => {
  assert.equal(bench.percentile([], 50), null);
  assert.equal(bench.percentile([10], 95), 10);
  assert.equal(bench.percentile([1, 2, 3, 4], 0), 1, 'p=0 不许取到 -1 下标');
  assert.equal(bench.percentile([1, 2, 3, 4], 50), 2);
  assert.equal(bench.percentile([1, 2, 3, 4], 95), 4);

  const row = bench.summarize([30, 10, 20], { wallMs: 500, denied: 2, denyReasons: { concurrency: 2 } });
  assert.equal(row.n, 3);
  assert.equal(row.denied, 2);
  assert.deepEqual(row.denyReasons, { concurrency: 2 });
  assert.equal(row.meanMs, 20);
  assert.equal(row.p50Ms, 20);
  assert.equal(row.maxMs, 30);
  assert.equal(row.perSecond, 6, '吞吐只按放行样本算：3/500ms');

  const clean = bench.summarize([10], { wallMs: 100, denied: 0, denyReasons: {} });
  assert.equal(Object.prototype.hasOwnProperty.call(clean, 'denyReasons'), false, '没有拒绝就不留空对象');

  const empty = bench.summarize([], { wallMs: 100, denied: 4, denyReasons: { rate: 4 } });
  assert.equal(empty.n, 0);
  assert.equal(empty.meanMs, null);
  assert.equal(empty.p95Ms, null);
  assert.equal(empty.perSecond, 0);
});

test('d. 增量：绝对值与占上游延迟的比例，缺样本时为 null', () => {
  const a = summary({ n: 10, meanMs: 32, p95Ms: 40, wallMs: 400 });
  const b = summary({ n: 10, meanMs: 30, p95Ms: 32, wallMs: 320 });
  const d = bench.delta(a, b, 20);
  assert.equal(d.meanMs, 2);
  assert.equal(d.p95Ms, 8);
  assert.equal(d.wallMs, 80);
  assert.equal(d.shareOfUpstreamPercent, 10, '2ms 占 20ms 上游延迟的 10%');
  assert.equal(bench.delta({ meanMs: null }, b, 20), null);
  assert.equal(bench.delta(a, { meanMs: null }, 20), null);
});

test('e. 可比性：任一态有拒绝或样本不足，就不许给增量', () => {
  const arms = {
    gateOn: summary({ n: 64, meanMs: 76 }),
    decideNoPersist: summary({ n: 64, meanMs: 32 }),
    gateOff: summary({ n: 64, meanMs: 31 }),
  };
  assert.deepEqual(bench.comparability(arms, 64), { comparable: true, reason: null });

  // 并发超过上限：闸门开态秒拒 56 次，另两态因为不落盘攒不出租约、结构上不会拒。
  const overCap = {
    gateOn: summary({ n: 8, denied: 56, meanMs: 71, wallMs: 91, denyReasons: { concurrency: 56 } }),
    decideNoPersist: summary({ n: 64, meanMs: 43, wallMs: 177 }),
    gateOff: summary({ n: 64, meanMs: 31, wallMs: 128 }),
  };
  const verdict = bench.comparability(overCap, 64);
  assert.equal(verdict.comparable, false);
  assert.match(verdict.reason, /gateOn 放行 8\/64、拒绝 56（concurrency×56）/);
  assert.match(verdict.reason, /语义而非开销/);

  const short = { ...arms, gateOff: summary({ n: 60, meanMs: 31 }) };
  assert.equal(bench.comparability(short, 64).comparable, false, '样本数不足也不可比');
});

test('f. costs：可比时三项增量自洽，不可比时三项全 null', () => {
  const arms = {
    gateOn: summary({ n: 64, meanMs: 76, p95Ms: 83, wallMs: 632 }),
    decideNoPersist: summary({ n: 64, meanMs: 32, p95Ms: 37, wallMs: 258 }),
    gateOff: summary({ n: 64, meanMs: 31, p95Ms: 35, wallMs: 252 }),
  };
  const ok = bench.costs(arms, { total: 64, delayMs: 20 });
  assert.equal(ok.comparability.comparable, true);
  assert.equal(ok.writeCost.meanMs, 44);
  assert.equal(ok.decideCost.meanMs, 1);
  assert.equal(ok.totalGateCost.meanMs, 45);
  assert.equal(
    Number((ok.writeCost.meanMs + ok.decideCost.meanMs).toFixed(3)),
    ok.totalGateCost.meanMs,
    '写盘成本 + 判定成本 = 闸门总成本'
  );
  assert.equal(ok.writeCost.shareOfUpstreamPercent, 220);

  const bad = bench.costs({
    gateOn: summary({ n: 8, denied: 56, meanMs: 71, denyReasons: { concurrency: 56 } }),
    decideNoPersist: arms.decideNoPersist,
    gateOff: arms.gateOff,
  }, { total: 64, delayMs: 20 });
  assert.equal(bad.comparability.comparable, false);
  assert.equal(bad.writeCost, null);
  assert.equal(bad.decideCost, null);
  assert.equal(bad.totalGateCost, null);
});

test('g. CLI 实跑：低并发可比、超上限不可比，参数写错非零退出', () => {
  const run = extraArgs => spawnSync(process.execPath, [CLI, ...extraArgs], {
    cwd: REPO_ROOT,
    encoding: 'utf8',
    // 并发上限显式钉住：开发者本地 .env 或 CI 若改了 BLUEBIRD_PROVIDER_MAX_CONCURRENCY，
    // "16 超过上限"这个前提就不成立，断言会变成对环境的猜测。
    env: { ...process.env, DEEPSEEK_API_KEY: '', BLUEBIRD_PROVIDER_MAX_CONCURRENCY: '8' },
    maxBuffer: 64 * 1024 * 1024,
    timeout: 180000,
  });
  // 总调用数必须大于并发上限（8），否则 16 个 worker 也凑不出 9 个在途，拒绝不会发生。
  const tiny = ['--delay=5', '--sequential=4', '--calls=32', '--concurrency=1,16', '--component-rounds=2'];
  const res = run(tiny);
  assert.equal(res.status, 0, res.stderr);
  const lines = String(res.stdout).split('\n');
  const start = lines.findIndex(line => line.includes('[EVIDENCE] gate-bench '));
  assert.ok(start >= 0, 'CLI 缺少 gate-bench 证据行');
  const view = JSON.parse(lines.slice(start).join('\n').slice(lines[start].indexOf('{')));
  assert.equal(view.environment.monitoring, 'off');
  assert.equal(view.providerThresholds.concurrency.limit, 8, '并发上限必须是钉住的 8，否则"16 超上限"的前提不成立');
  assert.equal(view.environment.writesPerAdmittedCall.throttle, 2);
  assert.equal(view.environment.writesPerAdmittedCall.breaker, 1);
  assert.equal(view.workloads.length, 2);
  assert.equal(view.components.length, 9);
  for (const component of view.components) {
    assert.equal(component.rounds, 2, '--component-rounds 必须真的生效，不许静默回落默认值');
    assert.ok(Object.values(component.paths).reduce((sum, value) => sum + value, 0) === 2);
  }

  const low = view.workloads.find(item => item.concurrency === 1);
  assert.equal(low.comparability.comparable, true);
  assert.equal(low.gateOn.n, 4);
  assert.equal(low.gateOn.denied, 0);
  assert.equal(typeof low.totalGateCost.meanMs, 'number');

  const high = view.workloads.find(item => item.concurrency === 16);
  assert.ok(high.gateOn.denied > 0, '并发 16 超过供应商上限 8，闸门开态必须真的拒绝');
  assert.equal(high.gateOn.denyReasons.concurrency, high.gateOn.denied);
  assert.equal(high.comparability.comparable, false);
  assert.equal(high.writeCost, null);
  assert.equal(high.decideCost, null);
  assert.equal(high.totalGateCost, null);

  const badFlag = run(['--component-roundz=2']);
  assert.equal(badFlag.status, 1, '未知参数必须非零退出');
  assert.match(String(badFlag.stderr), /未知参数：--component-roundz/);
  const badNumber = run(['--delay=abc']);
  assert.equal(badNumber.status, 1);
  assert.match(String(badNumber.stderr), /--delay 必须是/);
  const zeroDelay = run(['--delay=0']);
  assert.equal(zeroDelay.status, 1, '上游延迟为 0 时"占上游比例"无定义，必须拒绝而不是给出 Infinity/null');
  assert.match(String(zeroDelay.stderr), /--delay 必须是 ≥1/);
});