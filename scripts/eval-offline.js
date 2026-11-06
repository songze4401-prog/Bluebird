/* global process, console, __dirname */
/**
 * Phase 4 第 1 项 + P5-A：离线评测集 CLI（确定性 stub，不调用真实模型）。
 *
 * 用法：
 *   node scripts/eval-offline.js                          # 跑评测集并落基线快照
 *   node scripts/eval-offline.js --out=path                # 指定快照路径
 *   node scripts/eval-offline.js --compare=a.json,b.json   # 对比两份快照（带配置记录时出对照报告）
 *   node scripts/eval-offline.js --strategy-version=v1      # 先切换策略版本
 *
 * P5-A（§14 五类基线 + 分层）：
 *   node scripts/eval-offline.js --comparator=candidate --tiered --splits=dev,val \
 *        --model=offline-stub --prompt-version=p12 --tool-permissions=memory.recall \
 *        --budget-json='{"tokenCapPerCase":600,"deadlineMs":30000}' --out=... --record-usage=true
 *   node scripts/eval-offline.js --comparator=ablation --ablating=teamReview          # 消融版本
 *   node scripts/eval-offline.js --matrix=prod.json,cand.json,abl.json               # N 路对照矩阵
 *   node scripts/eval-offline.js --rotation-plan=true [--apply-rotation=true]        # 轮换与退役计划
 *   node scripts/eval-offline.js --leak-scan=prompt.txt [--mark-leak=true]           # 泄漏扫描
 *   node scripts/eval-offline.js --audience=optimizer                                 # 只出可给被优化方看的报告
 *
 * §7 八项质量指标（只读既有存储，不写）：
 *   node scripts/eval-offline.js --indicators=true
 *   node scripts/eval-offline.js --indicators=true --parallel-single=prod.json --parallel-team=cand.json
 *   node scripts/eval-offline.js --indicators=true --require-indicators=over_decomposition,failure_recovery
 *       # 显式要求某几项必须有数时，缺数退出码 1（真实评测轮用；默认 unknown 不拦）
 *
 * 隔离纪律：每个 comparator 的 safety 指标读的是任务事件聚合，同目录混跑会互相污染；
 * 一次进程一次比较对象，快照用不同 --out 区分，缺省目录每次跑前清空。
 * 重规划余地来自既有 BLUEBIRD_AGENT_TASK_MAX_ATTEMPTS（默认 1，钳位 1–3）；
 * 对照重规划效果时要显式设为 3，取值会写进配置记录的 budget.maxAttempts。
 */
const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');

const REPO_ROOT = path.resolve(__dirname, '..');
const DEFAULT_DATA_DIR = path.join(REPO_ROOT, '.eval-data');
const SUITE_V1 = path.join(REPO_ROOT, 'server', 'agents', 'eval-suite-v1.json');
const SUITE_ROTATION = path.join(REPO_ROOT, 'server', 'agents', 'eval-suite-rotation-v1.json');

if (!process.env.BLUEBIRD_DATA_DIR) {
  process.env.BLUEBIRD_DATA_DIR = DEFAULT_DATA_DIR;
}

const { runSuite } = require('../server/agents/eval-runner');
const { computeMetrics } = require('../server/agents/eval-metrics');
const tasks = require('../server/agents/tasks');
const baseline = require('../server/agents/eval-baseline');
const strategyVersion = require('../server/agents/strategy-version');
const comparators = require('../server/agents/eval-comparators');
const tiers = require('../server/agents/eval-tiers');
const indicators = require('../server/agents/eval-indicators');
const artifactStore = require('../server/agents/artifact-store');
const opLedger = require('../server/agents/op-ledger');
const approvals = require('../server/agents/approvals');
const manifest = require('../server/agents/manifest');

function parseArgs(argv) {
  const args = {};
  for (const item of argv) {
    const match = /^--([a-z-]+)=([\s\S]*)$/.exec(item);
    if (match) args[match[1]] = match[2];
    else if (/^--[a-z-]+$/.test(item)) args[item.slice(2)] = 'true';
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

function listArg(value) {
  return String(value || '').split(',').map(item => item.trim()).filter(Boolean);
}

function jsonArg(value, label) {
  if (value === undefined || value === null || value === '') return undefined;
  try {
    return JSON.parse(String(value));
  } catch (error) {
    throw new Error(`--${label} 不是合法 JSON：${error.message}`);
  }
}

function defaultOutPath(snapshot) {
  const short = String(snapshot.codeCommit || 'working-tree').slice(0, 8);
  const comparator = snapshot.comparator ? `.${snapshot.comparator.id}` : '';
  return path.join(REPO_ROOT, 'eval-baselines', `${snapshot.suite.version}-${short}${comparator}.json`);
}

function freshDataDir() {
  if (process.env.BLUEBIRD_DATA_DIR !== DEFAULT_DATA_DIR) return;
  fs.rmSync(DEFAULT_DATA_DIR, { recursive: true, force: true });
}

function comparatorFromArgs(args) {
  if (!args.comparator) return null;
  const id = String(args.comparator).trim();
  return comparators.resolveComparator({
    id,
    kind: id.startsWith('ablation') ? 'ablation' : id,
    ablating: listArg(args.ablating),
    forceSingle: args['force-single'] === 'true',
  });
}

function suitePathsFromArgs(args) {
  if (args.suite) return listArg(args.suite).map(item => path.resolve(REPO_ROOT, item));
  if (args.tiered) return [SUITE_V1, SUITE_ROTATION];
  return null;
}

/** 配置记录：§14 要求报告必须钉住模型/参数/提示词/权限/数据集/预算/时间。 */
function configFromArgs({ args, comparator, commit, datasetVersion, budget }) {
  if (!comparator) return null;
  return comparators.buildConfig(comparator, {
    codeCommit: commit || 'working-tree',
    model: args.model || 'offline-stub',
    modelParams: jsonArg(args['model-params-json'], 'model-params-json') || {},
    promptVersion: args['prompt-version'] || 'eval-offline-v1',
    toolPermissions: listArg(args['tool-permissions']),
    datasetVersion,
    budget: jsonArg(args['budget-json'], 'budget-json') || budget,
    evaluatedAt: args['evaluated-at'] || new Date().toISOString(),
  });
}

function tieredView(args) {
  return tiers.loadTieredSuites({
    suitePaths: suitePathsFromArgs(args) || [SUITE_V1, SUITE_ROTATION],
    statePath: args['state-path'] ? path.resolve(REPO_ROOT, args['state-path']) : undefined,
  });
}

function rotationMode(args) {
  const view = tieredView(args);
  const plan = tiers.planRotation(view, { now: Date.parse(args.now || '') || Date.now() });
  console.log(`[EVIDENCE] eval-rotation-plan ${JSON.stringify({
    datasetVersions: view.datasetVersions,
    counts: view.counts,
    policy: plan.policy,
    retired: plan.retired,
    usable: plan.usable,
    hiddenPool: plan.hiddenPool,
    hiddenPoolExhausted: plan.hiddenPoolExhausted,
    replacementsRequired: plan.replacementsRequired,
    rotationDue: plan.rotationDue,
    nextRotationAt: plan.nextRotationAt,
  })}`);
  if (args['apply-rotation'] === 'true') {
    const statePath = args['state-path'] ? path.resolve(REPO_ROOT, args['state-path']) : undefined;
    const applied = tiers.markRotationApplied({ at: args.now || new Date().toISOString(), statePath });
    console.log(`[EVIDENCE] eval-rotation-applied ${JSON.stringify({ lastRotationAt: applied.lastRotationAt })}`);
  }
  return 0;
}

function leakMode(args) {
  const target = path.resolve(REPO_ROOT, String(args['leak-scan'] || ''));
  const text = fs.readFileSync(target, 'utf8');
  const view = tieredView(args);
  const hits = tiers.scanLeak(text, view.cases);
  for (const caseId of hits) {
    if (args['mark-leak'] === 'true') {
      tiers.markLeak(caseId, {
        at: args.now || new Date().toISOString(),
        evidence: path.relative(REPO_ROOT, target).slice(0, 120),
        statePath: args['state-path'] ? path.resolve(REPO_ROOT, args['state-path']) : undefined,
      });
    }
  }
  console.log(`[EVIDENCE] eval-leak-scan ${JSON.stringify({
    file: path.relative(REPO_ROOT, target),
    hiddenSplits: view.counts.holdout + view.counts.rotation,
    hits,
    marked: args['mark-leak'] === 'true',
  })}`);
  // 泄漏命中即非零退出：CI 里这就是门，不能只打一行日志继续绿。
  return hits.length ? 1 : 0;
}

/**
 * §7 八项质量指标的实数据汇总。只读既有存储（任务、事件、账本、审批、产物），
 * 不写任何东西——指标的意义就在于它和实际执行事实同源。
 *
 * 快照参数（`--parallel-single=` / `--parallel-team=`）是并行耗时收益的唯一来源：
 * 没有成对的单跑/组队快照时这一项就是 unknown，脚本不会替它编一个 0。
 */
function indicatorsMode(args) {
  const tasksModule = require('../server/agents/tasks');
  const all = tasksModule.allTasks();
  const botIds = Array.from(new Set(
    [all.map(task => task.botId), manifest.listManifests().map(item => item.botId)]
      .reduce((sum, list) => sum.concat(list.filter(Boolean)), ['memory', 'researcher', 'executor', 'reviewer'])
  ));
  const events = [];
  const approvalsList = [];
  for (const botId of botIds) {
    try {
      events.push(...tasksModule.listEvents(botId, { limit: Number(args['event-limit'] || 500) }));
    } catch (_) {
      // 单个 Bot 的事件读不到不影响整体：未知就是未知，不猜。
    }
    try {
      approvalsList.push(...approvals.listApprovals(botId, { limit: Number(args['approval-limit'] || 200) }));
    } catch (_) {
      /* 同上 */
    }
  }
  const artifactsByProducer = new Map();
  for (const artifact of artifactStore.all()) {
    const key = String(artifact && artifact.taskId ? artifact.taskId : '');
    if (!key) continue;
    const list = artifactsByProducer.get(key) || [];
    list.push(artifact);
    artifactsByProducer.set(key, list);
  }
  const view = indicators.computeAll({
    tasks: all,
    events,
    ops: Object.values(opLedger.read().ops || {}),
    approvals: approvalsList,
    singleSnapshot: args['parallel-single'] ? baseline.readSnapshot(path.resolve(REPO_ROOT, args['parallel-single'])) : null,
    teamSnapshot: args['parallel-team'] ? baseline.readSnapshot(path.resolve(REPO_ROOT, args['parallel-team'])) : null,
    verifyRefs: refs => artifactStore.verifyRefsReadable(refs),
    artifactLookup: id => artifactStore.get(id),
    // §16 的证据链一半钉在产物上（共享结论/交付物的 provenanceRefs），只看任务字段会把
    // 真实 e2e 判成零证据，所以这里按产生任务把产物分组一起注入。
    artifactsOfTask: taskId => artifactsByProducer.get(String(taskId || '')) || [],
  });
  const requiredUnknown = args['require-indicators']
    ? listArg(args['require-indicators']).filter(name => {
      const item = view.indicators.find(row => row.name === name);
      return !item || item.known !== true;
    })
    : [];
  console.log(`[EVIDENCE] eval-indicators ${JSON.stringify(view)}`);
  // 默认不因 unknown 失败：全新仓库没有样本时 unknown 是事实。
  // 只有显式要求"这几项必须有数"（真实评测轮）时，缺数才拦。
  if (requiredUnknown.length) {
    console.error(`[EVIDENCE] eval-indicators-required-missing ${JSON.stringify({ indicators: requiredUnknown })}`);
    return 1;
  }
  return 0;
}

function run(args) {
  freshDataDir();
  if (args['strategy-version']) {
    strategyVersion.apply({ version: args['strategy-version'] });
  }
  const comparator = comparatorFromArgs(args);
  const splits = args.splits ? listArg(args.splits) : null;
  const suitePaths = suitePathsFromArgs(args);
  const suiteRun = runSuite({
    suitePaths,
    splits,
    baseTime: args['base-time'] || undefined,
    comparator,
  });
  const metrics = computeMetrics({ suite: suiteRun.suite, results: suiteRun.results });
  const commit = codeCommit();
  // maxAttempts 直接决定重规划有没有余地，必须进配置记录：两次跑若重试次数不同，
  // 就不是同一基线。取值从刚落盘的任务上读，避免在 CLI 里重复一遍 tasks 的钳位逻辑。
  const effectiveMaxAttempts = suiteRun.results.length
    ? tasks.getTask(suiteRun.results[0].taskId).maxAttempts
    : null;
  const config = configFromArgs({
    args,
    comparator,
    commit,
    datasetVersion: suiteRun.suites.map(item => item.datasetVersion || item.version).join('+'),
    budget: {
      tokenCapPerCase: Math.max(...suiteRun.results.map(item => item.budgetTokenCap || 0)),
      deadlineMs: null,
      maxAttempts: effectiveMaxAttempts,
    },
  });
  const snapshot = baseline.createSnapshot({
    metrics,
    codeCommit: commit,
    strategy: strategyVersion.get(),
    comparator,
    config,
  });
  const out = path.resolve(args.out || defaultOutPath(snapshot));
  baseline.writeSnapshot(snapshot, out);

  if (args['record-usage'] === 'true') {
    const statePath = args['state-path'] ? path.resolve(REPO_ROOT, args['state-path']) : undefined;
    const recorded = suiteRun.results.map(item => {
      const result = tiers.recordUse(item.caseId, {
        split: item.split,
        datasetVersion: (config && config.datasetVersion) || null,
        at: (config && config.evaluatedAt) || new Date().toISOString(),
        statePath,
      });
      return { caseId: item.caseId, split: item.split, uses: result.row.uses, recorded: result.recorded };
    });
    console.log(`[EVIDENCE] eval-usage-recorded ${JSON.stringify({ count: recorded.length, recorded })}`);
  }

  const m = snapshot.metrics;
  console.log(
    `[EVIDENCE] eval-baseline ${JSON.stringify({
      suite: snapshot.suite,
      codeCommit: snapshot.codeCommit,
      strategy: snapshot.strategy,
      comparator: snapshot.comparator,
      config: snapshot.config,
      out,
      splits: suiteRun.splits,
      successRate: { ...m.successRate, bySplit: m.bySplit, unsplitCases: m.unsplitCases },
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
  // 默认受众是评测方（逐例证据照常全出）；受众为被优化方时只出裁剪后的报告，
  // holdout/rotation 的样例与答案不进 stdout。
  if (args.audience === 'optimizer') {
    const view = tieredView(args);
    const report = tiers.optimizerReport(view, snapshot.cases.map(item => ({
      caseId: item.caseId,
      success: item.success,
      terminal: item.terminal,
    })));
    console.log(`[EVIDENCE] eval-optimizer-report ${JSON.stringify(report)}`);
  } else {
    for (const item of snapshot.cases) console.log(`[EVIDENCE] eval-case ${JSON.stringify(item)}`);
  }
  return 0;
}

function readPair(args) {
  const parts = String(args.compare || '').split(',').map(item => item.trim()).filter(Boolean);
  if (parts.length !== 2) throw new Error('--compare 需要两个快照路径，用逗号分隔');
  return parts.map(item => baseline.readSnapshot(path.resolve(REPO_ROOT, item)));
}

function compare(args) {
  const [left, right] = readPair(args);
  if (left.config && right.config) {
    // 两份快照都带配置记录时，必须先说清是不是同一基线，再谈差值。
    const report = comparators.compareReports(left, right, { diff: baseline.diff });
    console.log(`[EVIDENCE] eval-compare ${JSON.stringify(report)}`);
    return 0;
  }
  console.log(`[EVIDENCE] eval-diff ${JSON.stringify(baseline.diff(left, right))}`);
  return 0;
}

function matrix(args) {
  const files = listArg(args.matrix).map(item => baseline.readSnapshot(path.resolve(REPO_ROOT, item)));
  if (files.length < 2) throw new Error('--matrix 需要参照快照 + 至少一个候选快照');
  const report = comparators.compareMatrix({ reference: files[0], candidates: files.slice(1), diff: baseline.diff });
  console.log(`[EVIDENCE] eval-matrix ${JSON.stringify(report)}`);
  // 安全退化或全部候选都不可升级时退出码非零，供 CI 直接拦。
  const blocked = report.summary.degradedSafety.length > 0 || report.summary.upgradeEligible.length === 0;
  return blocked ? 1 : 0;
}

function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.compare) return compare(args);
  if (args.matrix) return matrix(args);
  if (args.indicators) return indicatorsMode(args);
  if (args['rotation-plan']) return rotationMode(args);
  if (args['leak-scan']) return leakMode(args);
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

module.exports = {
  parseArgs,
  codeCommit,
  defaultOutPath,
  comparatorFromArgs,
  configFromArgs,
  indicatorsMode,
  listArg,
  run,
  compare,
  matrix,
  rotationMode,
  leakMode,
};
