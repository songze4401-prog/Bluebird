/* global require, process, __dirname */
/**
 * P5-A：五类可比较基线对象、配置记录与对照矩阵（Notion §14）。
 *
 * 覆盖用户验收句「基线不锁死为单一方案，每轮可比较…不同配置不得混称同一基线」：
 *  a) 注册表五类齐全，ablation 必须显式声明关的是已接线机制；
 *  b) 配置记录字段完整，身份哈希对 codeCommit/评测时间不敏感、对配置敏感；
 *  c) 对照报告区分「同一基线复现」与「换配置对照」；
 *  d) 五类比较对象在执行层跑出可观测差异（轨迹、组队子任务、重规划是否真的多跑一次）；
 *  e) 指标层：候选相对生产可升级，且不是同一基线的复现；
 *  f) CLI 端到端：分层跑、用量登记、轮换计划、泄漏扫描、N 路矩阵与裁剪后的优化方报告。
 *
 * 隔离纪律：BLUEBIRD_DATA_DIR 在 require server/ 之前指向临时目录；
 * 每次比较对象单跑一个数据目录，避免安全指标的事件聚合跨轮污染。
 */
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const test = require('node:test');
const { spawnSync } = require('child_process');

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'bluebird-eval-cmp-'));
process.env.BLUEBIRD_DATA_DIR = path.join(TMP, 'store');
process.env.DEEPSEEK_API_KEY = '';
process.env.BLUEBIRD_MONITORING = '0';
// 重规划复用既有 maxAttempts；对照轮统一给 3 次，避免把配置差异当成策略效果。
process.env.BLUEBIRD_AGENT_TASK_MAX_ATTEMPTS = '3';

const REPO_ROOT = path.resolve(__dirname, '..');
const tasks = require('../server/agents/tasks');
const strategyVersion = require('../server/agents/strategy-version');
const comparators = require('../server/agents/eval-comparators');
const baseline = require('../server/agents/eval-baseline');
const runner = require('../server/agents/eval-runner');
const metrics = require('../server/agents/eval-metrics');
const tiers = require('../server/agents/eval-tiers');

const SUITE_FILE = path.join(TMP, 'cmp-suite.json');
const CLI = path.join(REPO_ROOT, 'scripts', 'eval-offline.js');

const CASES = [
  {
    id: 'cmp-recover',
    goal: '执行一次高危动作并在审校驳回后重规划',
    agentId: 'executor',
    taskType: 'action.execute',
    split: 'dev',
    expectedTerminal: 'completed',
    allowedErrorCodes: ['review_rejected'],
    expectReview: true,
    budgetTokenCap: 600,
    script: [{ outcome: 'failed', errorCode: 'review_rejected', simulatedMs: 400, usage: { prompt_tokens: 100, completion_tokens: 20, total_tokens: 120 } }],
  },
  {
    id: 'cmp-low-risk',
    goal: '汇总多来源知识',
    agentId: 'researcher',
    taskType: 'knowledge.search',
    split: 'dev',
    expectedTerminal: 'completed',
    allowedErrorCodes: [],
    expectReview: false,
    budgetTokenCap: 400,
    script: [{ outcome: 'completed', simulatedMs: 200, usage: { prompt_tokens: 60, completion_tokens: 20, total_tokens: 80 } }],
  },
  {
    id: 'cmp-hard-failure',
    goal: '高危执行但证据缺失',
    agentId: 'executor',
    taskType: 'action.execute',
    split: 'dev',
    expectedTerminal: 'failed',
    allowedErrorCodes: ['evidence_missing'],
    expectReview: true,
    budgetTokenCap: 600,
    script: [{ outcome: 'failed', errorCode: 'evidence_missing', simulatedMs: 300, usage: { prompt_tokens: 90, completion_tokens: 10, total_tokens: 100 } }],
  },
  {
    id: 'cmp-high-risk-success',
    goal: '高危写入需独立复核',
    agentId: 'executor',
    taskType: 'action.execute',
    split: 'dev',
    expectedTerminal: 'completed',
    allowedErrorCodes: [],
    expectReview: true,
    budgetTokenCap: 600,
    script: [{ outcome: 'completed', simulatedMs: 250, usage: { prompt_tokens: 80, completion_tokens: 20, total_tokens: 100 } }],
  },
];

fs.writeFileSync(SUITE_FILE, `${JSON.stringify({
  version: 'p5a-cmp-suite-v1',
  datasetVersion: 'p5a-cmp-dataset-v1',
  cases: CASES,
}, null, 2)}\n`, 'utf8');

function resetStore() {
  fs.rmSync(path.join(TMP, 'store', 'agents'), { recursive: true, force: true });
  tasks.reloadForTests();
}

function runAs(comparator) {
  resetStore();
  const suiteRun = runner.runSuite({ suitePath: SUITE_FILE, comparator });
  const computed = metrics.computeMetrics({ suite: suiteRun.suite, results: suiteRun.results });
  return { suiteRun, computed, byId: new Map(computed.cases.map(item => [item.caseId, item])) };
}

function fullConfigFields(overrides = {}) {
  return {
    codeCommit: 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
    model: 'offline-stub',
    modelParams: { temperature: 0 },
    promptVersion: 'p12',
    toolPermissions: ['memory.recall', 'knowledge.search'],
    datasetVersion: 'p5a-cmp-dataset-v1',
    budget: { tokenCapPerCase: 600, deadlineMs: 30000 },
    evaluatedAt: '2026-11-06T05:00:00.000Z',
    ...overrides,
  };
}

test('a. 注册表：五类比较对象齐全，ablation 只能关已接线的机制', () => {
  assert.deepEqual(comparators.KINDS.slice().sort(), [
    'ablation',
    'candidate',
    'production',
    'runtime_with_capability',
    'single_agent_fast_path',
  ]);
  const production = comparators.resolveComparator('production');
  assert.deepEqual(production.enabled, { autonomyPolicy: false, teamReview: false, replan: false });
  assert.equal(production.forceSingle, true);
  const fast = comparators.resolveComparator({ id: 'single_agent_fast_path' });
  assert.deepEqual(fast.enabled, { autonomyPolicy: true, teamReview: false, replan: false });
  assert.deepEqual(fast.ablating, ['replan', 'teamReview']);
  const capable = comparators.resolveComparator('runtime_with_capability');
  assert.equal(capable.enabled.teamReview, true);
  assert.equal(capable.enabled.replan, false);
  const candidate = comparators.resolveComparator('candidate');
  assert.deepEqual(candidate.enabled, { autonomyPolicy: true, teamReview: true, replan: true });

  const ablation = comparators.resolveComparator({ id: 'ablation', kind: 'ablation', ablating: ['replan'] });
  assert.equal(ablation.enabled.replan, false);
  assert.equal(ablation.enabled.teamReview, true);
  assert.equal(ablation.policyVersion, comparators.COMPARATOR_POLICY_VERSION);

  assert.throws(() => comparators.resolveComparator('production_v2'), /未知比较对象类型/);
  assert.throws(() => comparators.resolveComparator({ id: 'prod', kind: 'production' }), /id 必须是/);
  assert.throws(() => comparators.resolveComparator({ kind: 'ablation' }), /必须显式声明/);
  assert.throws(() => comparators.resolveComparator({ kind: 'ablation', ablating: ['memoryCache'] }), /未接线机制/);
  // 机制依赖：复核子任务由组队判定产生，只关策略却声明开复核的对照得不到任何差异，必须拒绝。
  assert.throws(() => comparators.resolveComparator({ kind: 'ablation', ablating: ['autonomyPolicy'] }), /不能单独开启/);
  assert.equal(
    comparators.resolveComparator({ kind: 'ablation', ablating: ['autonomyPolicy', 'teamReview'] }).enabled.replan,
    true
  );
  assert.throws(
    () => comparators.resolveComparator({ kind: 'ablation', ablating: comparators.MECHANISMS.slice() }),
    /等于 production/
  );
  assert.throws(() => comparators.isEnabled(production, 'memoryCache'), /未知机制/);
});

test('b. 配置记录：字段缺失显式拒绝，身份只对配置敏感、不对提交与时间敏感', () => {
  const production = comparators.resolveComparator('production');
  assert.throws(
    () => comparators.buildConfig(production, { model: 'offline-stub' }),
    /基线配置记录缺少字段：.*codeCommit.*evaluatedAt/
  );
  assert.throws(
    () => comparators.buildConfig(production, { ...fullConfigFields(), modelParams: [] }),
    /modelParams 必须是对象/
  );
  assert.throws(
    () => comparators.buildConfig(production, { ...fullConfigFields(), toolPermissions: 'read' }),
    /toolPermissions 必须是数组/
  );
  assert.throws(
    () => comparators.buildConfig(production, { ...fullConfigFields(), budget: 600 }),
    /budget 必须是对象/
  );

  const config = comparators.buildConfig(production, fullConfigFields());
  assert.match(config.identity, /^[0-9a-f]{64}$/);
  assert.deepEqual(config.toolPermissions, ['knowledge.search', 'memory.recall'], '权限排序后入库，避免顺序造成伪差异');

  const sameIdentity = comparators.buildConfig(production, fullConfigFields({
    codeCommit: 'bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb',
    evaluatedAt: '2026-11-07T09:30:00.000Z',
  }));
  assert.equal(sameIdentity.identity, config.identity, '换提交/换时间仍是同一基线配置');

  for (const field of ['model', 'promptVersion', 'datasetVersion', 'toolPermissions', 'budget']) {
    const overrides = { [field]: field === 'toolPermissions' ? ['memory.recall'] : field === 'budget' ? { tokenCapPerCase: 900, deadlineMs: 30000 } : `${config[field]}-x` };
    const other = comparators.buildConfig(production, fullConfigFields(overrides));
    assert.notEqual(other.identity, config.identity, `${field} 变化必须换基线身份`);
    assert.deepEqual(comparators.baselineMismatch(config, other), [field]);
  }

  const candidate = comparators.buildConfig(comparators.resolveComparator('candidate'), fullConfigFields());
  assert.deepEqual(comparators.baselineMismatch(config, candidate).sort(), ['comparatorId', 'mechanisms'], '两个都不消融机制的比较对象只差身份与机制开关');
});

function fakeMetrics(successRate) {
  return {
    suite: { version: 'p5a-cmp-suite-v1', digest: 'x'.repeat(64), caseCount: 4 },
    cases: [],
    metrics: {
      successRate: { value: successRate, successCount: Math.round(successRate * 4), caseCount: 4 },
      rework: { total: 0, casesWithRework: 0, rate: 0 },
      tokenCost: { total: 400, knownCases: 4, unknownCases: 0, unknownTokens: null, complete: true },
      latency: { totalMs: 1000, avgMs: 250, maxMs: 400, unknownCases: 0, complete: true },
      bySplit: {},
      unsplitCases: 0,
    },
    safety: { approvalBypass: 0, failClosedHits: 0, unauthorizedDenied: 0, approvalRequested: 0, approvalResolved: 0, deadLetters: 0 },
  };
}

function snap(comparator, config, successRate, codeCommit = 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa') {
  return baseline.createSnapshot({ metrics: fakeMetrics(successRate), comparator, config, codeCommit });
}

test('c. 对照报告：同一基线复现与换配置对照必须区分称呼', () => {
  const production = comparators.resolveComparator('production');
  const candidate = comparators.resolveComparator('candidate');
  const config = comparators.buildConfig(production, fullConfigFields());
  const replay = comparators.buildConfig(production, fullConfigFields({ evaluatedAt: '2026-11-06T06:00:00.000Z' }));

  const before = snap(production, config, 0.5);
  const after = snap(production, replay, 0.6);
  const sameBaseline = comparators.compareReports(before, after, { diff: baseline.diff });
  assert.equal(sameBaseline.comparisonKind, 'same_baseline_replay');
  assert.equal(sameBaseline.sameBaseline, true);
  assert.deepEqual(sameBaseline.mismatchedFields, []);
  assert.equal(sameBaseline.changes.metrics.successRate.change, 'improved');

  const candidateConfig = comparators.buildConfig(candidate, fullConfigFields());
  const changed = comparators.compareReports(before, snap(candidate, candidateConfig, 0.75), { diff: baseline.diff });
  assert.equal(changed.comparisonKind, 'config_change');
  assert.ok(changed.mismatchedFields.includes('comparatorId'));
  assert.equal(changed.after.comparator.kind, 'candidate');

  assert.throws(() => comparators.compareReports({ config: null }, after, { diff: baseline.diff }), /缺少基线配置记录/);
  assert.throws(() => comparators.compareReports(null, after, { diff: baseline.diff }), /需要两份快照/);
  assert.equal(before.config.identity, replay.identity, '复现轮的身份必须与基线一致');
});

test('d. 执行层差异：五类比较对象在轨迹、组队子任务与重规划上各不相同', () => {
  const production = runAs('production');
  const pRecover = production.byId.get('cmp-recover');
  assert.equal(pRecover.policy, null, '自治关闭时不写编排轨迹');
  assert.equal(tasks.getTask(pRecover.taskId).route, null);
  assert.equal(pRecover.replan, 'comparator_ablated');
  assert.equal(pRecover.terminal, 'failed', '关掉重规划就不能把驳回改成通过');
  assert.deepEqual(pRecover.teamTaskIds, []);

  const fast = runAs('single_agent_fast_path');
  const fHigh = fast.byId.get('cmp-high-risk-success');
  assert.equal(fHigh.policy.decision, 'single', '快速路径强制单执行体');
  assert.ok(fHigh.policy.rationale.includes('comparator_force_single'));
  assert.deepEqual(fHigh.teamTaskIds, []);
  assert.equal(fast.byId.get('cmp-recover').replan, 'comparator_ablated');

  const capable = runAs('runtime_with_capability');
  const cHigh = capable.byId.get('cmp-high-risk-success');
  assert.equal(cHigh.policy.decision, 'team');
  assert.equal(cHigh.teamTaskIds.length, 1, '指定能力对照必须真的起复核子任务');
  assert.equal(cHigh.reviewTriggered, true);
  assert.equal(capable.byId.get('cmp-recover').replan, 'comparator_ablated');
  assert.equal(capable.byId.get('cmp-recover').terminal, 'failed', '该对照只加复核，不加重规划');

  const candidate = runAs('candidate');
  const kRecover = candidate.byId.get('cmp-recover');
  assert.equal(kRecover.replan, 'replan_allowed');
  assert.equal(kRecover.terminal, 'completed');
  assert.equal(kRecover.attempts, 2, '重规划真的多跑了一个 attempt');
  assert.equal(kRecover.teamTaskIds.length, 1);
  const kHard = candidate.byId.get('cmp-hard-failure');
  assert.equal(kHard.replan, 'non_recoverable_error', '硬失败不能被重规划成假成功');
  assert.equal(kHard.terminal, 'failed');

  const ablated = runAs({ id: 'ablation', kind: 'ablation', ablating: ['teamReview'] });
  const aHigh = ablated.byId.get('cmp-high-risk-success');
  assert.equal(aHigh.policy.decision, 'team', '策略仍判高危组队，只是复核机制被消融掉');
  assert.deepEqual(aHigh.teamTaskIds, [], '消融 teamReview 后不得留复核子任务');
  // 消融是外科手术：只关声明的那一个机制，重规划照常生效。
  assert.equal(ablated.byId.get('cmp-recover').replan, 'replan_allowed');
  assert.equal(ablated.byId.get('cmp-recover').terminal, 'completed');

  assert.equal(strategyVersion.get().version, 'p4-default', '对照跑不依赖落盘策略开关');
  assert.equal(strategyVersion.get().enabled, true);
});

test('e. 指标层：候选相对生产可升级，且报告必须声明这不是同一基线复现', () => {
  const prod = runAs('production');
  const production = comparators.resolveComparator('production');
  const before = baseline.createSnapshot({
    metrics: prod.computed,
    codeCommit: 'cccccccccccccccccccccccccccccccccccccccc',
    comparator: production,
    config: comparators.buildConfig(production, fullConfigFields({ codeCommit: 'cccccccccccccccccccccccccccccccccccccccc' })),
  });
  const cand = runAs('candidate');
  const candidate = comparators.resolveComparator('candidate');
  const after = baseline.createSnapshot({
    metrics: cand.computed,
    codeCommit: 'dddddddddddddddddddddddddddddddddddddddd',
    comparator: candidate,
    config: comparators.buildConfig(candidate, fullConfigFields({ codeCommit: 'dddddddddddddddddddddddddddddddddddddddd' })),
  });

  // stub 语义下用例的 expectReview 会直接开审校事件（Phase 4 口径，历史基线不变），
  // 因此两轮的唯一差别落在重规划能否把审校驳回救回来：0.75 → 1.00。
  assert.equal(before.metrics.successRate.value, 0.75);
  assert.equal(after.metrics.successRate.value, 1);
  assert.equal(before.safety.approvalBypass, 0);
  assert.equal(after.safety.approvalBypass, 0);
  assert.throws(
    () => baseline.createSnapshot({ metrics: after, codeCommit: 'x', comparator: candidate, config: after.config }),
    /codeCommit 与基线配置记录不一致/
  );

  const report = comparators.compareReports(before, after, { diff: baseline.diff });
  assert.equal(report.comparisonKind, 'config_change');
  assert.equal(report.changes.metrics.successRate.change, 'improved');
  assert.equal(report.changes.safetyDegraded, false);
  assert.equal(report.changes.tokenComparable, true, '两轮 token 都完整，成本差可比较');

  const matrix = comparators.compareMatrix({
    reference: before,
    candidates: [after, { ...after, config: { ...after.config, identity: 'other' } }],
    diff: baseline.diff,
  });
  assert.equal(matrix.summary.candidatesCompared, 2);
  assert.deepEqual(matrix.summary.upgradeEligible, ['candidate', 'candidate']);
  assert.deepEqual(matrix.summary.degradedSafety, []);
  assert.equal(matrix.rows[0].comparisonKind, 'config_change');

  // 安全退化一票否决：成功率再高也不能进可升级名单。
  const unsafe = JSON.parse(JSON.stringify(after));
  unsafe.safety.approvalBypass = 9;
  const strict = comparators.compareMatrix({ reference: before, candidates: [unsafe], diff: baseline.diff });
  assert.deepEqual(strict.summary.improved, ['candidate']);
  assert.deepEqual(strict.summary.upgradeEligible, []);
  assert.deepEqual(strict.summary.degradedSafety, ['candidate']);
});

test('f. CLI 端到端：分层跑、用量登记、轮换计划、泄漏扫描与优化方裁剪报告', () => {
  const statePath = path.join(TMP, 'tiers-cli.json');
  const dirProd = path.join(TMP, 'cli-prod');
  const dirCand = path.join(TMP, 'cli-cand');
  const outProd = path.join(TMP, 'snap-prod.json');
  const outCand = path.join(TMP, 'snap-cand.json');
  const cli = dir => args => spawnSync(process.execPath, [CLI, ...args], {
    cwd: REPO_ROOT,
    encoding: 'utf8',
    env: {
      ...process.env,
      BLUEBIRD_DATA_DIR: dir,
      DEEPSEEK_API_KEY: '',
      BLUEBIRD_MONITORING: '0',
      BLUEBIRD_AGENT_TASK_MAX_ATTEMPTS: '3',
    },
    maxBuffer: 64 * 1024 * 1024,
  });
  const text = res => {
    assert.equal(res.status, 0, `CLI 失败：${res.stderr}`);
    return res.stdout;
  };
  const line = (res, tag, expectStatus = 0) => {
    assert.equal(res.status, expectStatus, `CLI 退出码不符（期望 ${expectStatus}）：${res.stderr}`);
    const row = String(res.stdout).split('\n').find(item => item.includes(`] ${tag} `));
    assert.ok(row, `CLI 缺少 ${tag} 证据行`);
    return JSON.parse(row.slice(row.indexOf('{')));
  };

  const prodRes = cli(dirProd)(['--comparator=production', '--tiered', '--splits=dev,val', `--out=${outProd}`, '--audience=optimizer']);
  const candRes = cli(dirCand)([
    '--comparator=candidate', '--tiered', '--splits=dev,val', `--out=${outCand}`,
    '--audience=optimizer', '--record-usage=true', '--tool-permissions=memory.recall,knowledge.search',
    `--state-path=${statePath}`,
  ]);
  const prodOut = text(prodRes);
  const prodReport = line(prodRes, 'eval-baseline');
  assert.equal(prodReport.suite.version, 'p4-eval-v1+p5a-eval-rotation-v1', '多文件同跑的基线身份必须覆盖两个文件');
  assert.deepEqual(prodReport.splits, ['dev', 'val']);
  assert.equal(prodReport.comparator.id, 'production');
  assert.equal(prodReport.config.datasetVersion, 'p5a-eval-dataset-v1+p5a-eval-rotation-v1');
  assert.match(prodReport.config.identity, /^[0-9a-f]{64}$/);
  assert.equal(prodReport.config.budget.maxAttempts, 3, '重试次数进配置记录：不同 maxAttempts 不算同一基线');
  assert.deepEqual(prodReport.config.toolPermissions, [], '未声明权限时是显式空数组');
  assert.equal(prodReport.successRate.bySplit.dev.count, 6);
  assert.equal(prodReport.successRate.bySplit.val.count, 4);
  assert.equal(prodReport.successRate.bySplit.holdout.count, 0, '未选中的分层不产出用例');
  assert.equal(prodReport.successRate.unsplitCases, 0);
  assert.ok(!prodOut.includes('] eval-case '), '优化方受众不得逐例打印隐藏集结果');

  const candReport = line(candRes, 'eval-baseline');
  assert.deepEqual(candReport.config.toolPermissions, ['knowledge.search', 'memory.recall']);
  assert.equal(candReport.comparator.kind, 'candidate');
  const usage = line(candRes, 'eval-usage-recorded');
  assert.equal(usage.count, 10);
  assert.ok(usage.recorded.every(item => item.recorded && item.uses === 1));
  assert.ok(usage.recorded.every(item => item.split === 'dev' || item.split === 'val'), '未选中的分层不得被记账');

  const hidden = tiers.loadTieredSuites({
    suitePaths: [
      path.join(REPO_ROOT, 'server', 'agents', 'eval-suite-v1.json'),
      path.join(REPO_ROOT, 'server', 'agents', 'eval-suite-rotation-v1.json'),
    ],
    statePath,
  });
  const hiddenGoals = hidden.cases.filter(item => item.split === 'holdout').map(item => item.goal);
  assert.equal(hiddenGoals.length, 3);
  for (const goal of hiddenGoals) {
    assert.ok(!prodOut.includes(goal), `优化方报告泄漏了保留集样例：${goal.slice(0, 12)}`);
  }
  const optimizerReport = line(prodRes, 'eval-optimizer-report');
  assert.equal(optimizerReport.perCase.length, 6);
  assert.equal(optimizerReport.valAggregate.count, 4);
  assert.equal(optimizerReport.hiddenAggregate.count, 0);
  assert.ok(!JSON.stringify(optimizerReport).includes('script'));

  const matrixReport = line(cli(dirProd)([`--matrix=${outProd},${outCand}`]), 'eval-matrix');
  assert.equal(matrixReport.rows.length, 1);
  assert.equal(matrixReport.rows[0].comparisonKind, 'config_change');
  assert.deepEqual(matrixReport.summary.improved, ['candidate']);
  assert.deepEqual(matrixReport.summary.upgradeEligible, ['candidate']);
  const reverse = cli(dirProd)([`--matrix=${outCand},${outProd}`]);
  assert.equal(reverse.status, 1, '没有可升级候选时矩阵必须非零退出，供 CI 直接拦');

  const beforeLeak = line(cli(dirCand)(['--rotation-plan=true', `--state-path=${statePath}`, '--now=2026-11-06T04:00:00.000Z']), 'eval-rotation-plan');
  assert.equal(beforeLeak.counts.dev, 6);
  assert.deepEqual(beforeLeak.retired, [], '每层只用一次，未超量也未泄漏');
  assert.equal(beforeLeak.hiddenPool, 6);
  assert.equal(beforeLeak.rotationDue, true, '从未补过轮换集时必须报"该轮换"');
  const applied = line(cli(dirCand)(['--rotation-plan=true', '--apply-rotation=true', `--state-path=${statePath}`, '--now=2026-11-06T04:00:00.000Z']), 'eval-rotation-applied');
  assert.equal(applied.lastRotationAt, '2026-11-06T04:00:00.000Z');
  const afterApply = line(cli(dirCand)(['--rotation-plan=true', `--state-path=${statePath}`, '--now=2026-11-10T04:00:00.000Z']), 'eval-rotation-plan');
  assert.equal(afterApply.rotationDue, false, '补过之后的间隔期内不得重复催轮换');
  assert.equal(afterApply.nextRotationAt, '2026-11-13T04:00:00.000Z');

  const leakFile = path.join(TMP, 'prompt-template.txt');
  fs.writeFileSync(leakFile, `系统提示词片段：请围绕「${hiddenGoals[0]}」组织答案。\n`, 'utf8');
  const leakRes = cli(dirCand)([`--leak-scan=${leakFile}`, `--state-path=${statePath}`, '--mark-leak=true']);
  const leakReport = line(leakRes, 'eval-leak-scan', 1);
  assert.equal(leakReport.hits.length, 1);
  assert.equal(leakReport.marked, true);
  const afterLeak = line(cli(dirCand)(['--rotation-plan=true', `--state-path=${statePath}`]), 'eval-rotation-plan');
  assert.equal(afterLeak.retired.length, 1);
  assert.equal(afterLeak.retired[0].reason, 'leaked');
  assert.equal(afterLeak.hiddenPool, 5);
});

test.after(() => {
  fs.rmSync(TMP, { recursive: true, force: true });
});
