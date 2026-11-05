/* global process, console, __dirname */
/**
 * Phase 4 第 1 项：离线评测集 CLI（确定性 stub，不调用真实模型）。
 *
 * 用法：
 *   node scripts/eval-offline.js                          # 跑评测集并落基线快照
 *   node scripts/eval-offline.js --out=path                # 指定快照路径
 *   node scripts/eval-offline.js --compare=a.json,b.json   # 对比两份快照
 *   node scripts/eval-offline.js --strategy-version=v1      # 先切换策略版本
 */
const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');

const REPO_ROOT = path.resolve(__dirname, '..');
const DEFAULT_DATA_DIR = path.join(REPO_ROOT, '.eval-data');

if (!process.env.BLUEBIRD_DATA_DIR) {
  process.env.BLUEBIRD_DATA_DIR = DEFAULT_DATA_DIR;
}

const { runSuite } = require('../server/agents/eval-runner');
const { computeMetrics } = require('../server/agents/eval-metrics');
const baseline = require('../server/agents/eval-baseline');
const strategyVersion = require('../server/agents/strategy-version');

function parseArgs(argv) {
  const args = {};
  for (const item of argv) {
    const match = /^--([a-z-]+)=([\s\S]*)$/.exec(item);
    if (match) args[match[1]] = match[2];
  }
  return args;
}

function codeCommit() {
  try {
    return execSync('git rev-parse HEAD', { cwd: REPO_ROOT, encoding: 'utf8' }).trim();
  } catch (_) {
    return null;
  }
}

function defaultOutPath(snapshot) {
  const short = String(snapshot.codeCommit || 'working-tree').slice(0, 8);
  return path.join(REPO_ROOT, 'eval-baselines', `${snapshot.suite.version}-${short}.json`);
}

function freshDataDir() {
  if (process.env.BLUEBIRD_DATA_DIR !== DEFAULT_DATA_DIR) return;
  fs.rmSync(DEFAULT_DATA_DIR, { recursive: true, force: true });
}

function run(args) {
  freshDataDir();
  if (args['strategy-version']) {
    strategyVersion.apply({ version: args['strategy-version'] });
  }
  const suite = runSuite({ suitePath: args.suite || null, baseTime: args['base-time'] || undefined });
  const metrics = computeMetrics({ suite: suite.suite, results: suite.results });
  const snapshot = baseline.createSnapshot({
    metrics,
    codeCommit: codeCommit(),
    strategy: strategyVersion.get(),
  });
  const out = path.resolve(args.out || defaultOutPath(snapshot));
  baseline.writeSnapshot(snapshot, out);

  const m = snapshot.metrics;
  console.log(
    `[EVIDENCE] eval-baseline ${JSON.stringify({
      suite: snapshot.suite,
      codeCommit: snapshot.codeCommit,
      strategy: snapshot.strategy,
      out,
      successRate: m.successRate,
      rework: m.rework,
      tokenCost: m.tokenCost,
      latency: m.latency,
      safety: {
        approvalBypass: snapshot.safety.approvalBypass,
        failClosedHits: snapshot.safety.failClosedHits,
        unauthorizedDenied: snapshot.safety.unauthorizedDenied,
        deadLetters: snapshot.safety.deadLetters,
      },
    })}`
  );
  for (const item of snapshot.cases) console.log(`[EVIDENCE] eval-case ${JSON.stringify(item)}`);
  return 0;
}

function compare(args) {
  const [left, right] = String(args.compare || '').split(',');
  if (!left || !right) throw new Error('--compare 需要两个快照路径，用逗号分隔');
  const report = baseline.diff(baseline.readSnapshot(path.resolve(left)), baseline.readSnapshot(path.resolve(right)));
  console.log(`[EVIDENCE] eval-diff ${JSON.stringify(report)}`);
  return 0;
}

function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.compare) return compare(args);
  return run(args);
}

if (require.main === module) {
  try {
    process.exitCode = main();
  } catch (error) {
    console.error(`[EVIDENCE] eval-error ${error && error.message}`);
    process.exitCode = 1;
  }
}

module.exports = { parseArgs, codeCommit, defaultOutPath, run, compare };
