/* global require, process, __dirname */
/**
 * P5-A：评测集分层与轮换退役（Notion §14）。
 *
 * 覆盖用户要求的四件事：
 *  a) 分层校验：四个桶必须齐全，缺 split 或非法 split 显式失败；
 *  b) 可见性裁剪：holdout 与 rotation 的样例和答案都不给被优化对象；
 *  c) 泄漏检测与退役：泄漏优先于超量，人工退役优先于自动判定；
 *  d) 用量幂等与乱序保护：重复时间戳不累加，旧时间戳不回拨计数；
 *  e) 重启读回与轮换计划：状态落盘可读回，隐藏池耗尽必须显式报警；
 *  f) 优化方报告：dev 逐例、val 只聚合、holdout/rotation 只给数量。
 *
 * 隔离纪律：BLUEBIRD_DATA_DIR 在 require server/ 之前指向临时目录。
 */
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const test = require('node:test');

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'bluebird-eval-tiers-'));
process.env.BLUEBIRD_DATA_DIR = TMP;
process.env.DEEPSEEK_API_KEY = '';
process.env.BLUEBIRD_MONITORING = '0';

const tiers = require('../server/agents/eval-tiers');
const { loadSuite } = require('../server/agents/eval-suite');

const V1 = path.join(__dirname, '..', 'server', 'agents', 'eval-suite-v1.json');
const ROTATION = path.join(__dirname, '..', 'server', 'agents', 'eval-suite-rotation-v1.json');
const STATE = path.join(TMP, 'agents', 'eval-tiers.json');

function tiered() {
  return tiers.loadTieredSuites({ suitePaths: [V1, ROTATION], statePath: STATE });
}

test('a. 分层校验：四个桶齐全，缺 split、非法 split 与空桶都显式失败', () => {
  const view = tiered();
  assert.equal(view.caseCount, 16);
  assert.deepEqual(view.counts, { dev: 6, val: 4, holdout: 3, rotation: 3 });
  assert.deepEqual(view.datasetVersions.sort(), ['p5a-eval-dataset-v1', 'p5a-eval-rotation-v1']);

  assert.throws(() => tiers.validateSplits([{ id: 'x' }]), /缺少 split/);
  assert.throws(() => tiers.validateSplits([{ id: 'x', split: 'train' }]), /split 非法/);
  assert.throws(
    () => tiers.validateSplits([{ id: 'x', split: 'dev' }, { id: 'y', split: 'dev' }]),
    /缺少桶/
  );
  const v1 = loadSuite(V1);
  assert.equal(v1.datasetVersion, 'p5a-eval-dataset-v1');
  assert.equal(v1.cases.filter(item => item.split === 'holdout').length, 3);
});

test('b. 可见性裁剪：holdout 与 rotation 的样例与答案都不给优化方', () => {
  const view = tiered();
  const bySplit = split => view.cases.filter(item => item.split === split);
  const dev = tiers.agentVisibleCase(bySplit('dev')[0]);
  assert.ok(dev.goal && dev.expectedTerminal, '开发集允许带答案');
  assert.ok(Array.isArray(dev.allowedErrorCodes));

  const val = tiers.agentVisibleCase(bySplit('val')[0]);
  assert.ok(val.goal, '验证集样例可见（用于阶段选型）');
  assert.equal(val.expectedTerminal, undefined, '验证集答案不回给优化方');
  assert.equal('script' in val, false);

  for (const item of bySplit('holdout').concat(bySplit('rotation'))) {
    const visible = tiers.agentVisibleCase(item);
    assert.equal(visible.goal, undefined, `${item.id} 的样例不得暴露`);
    assert.equal(visible.expectedTerminal, undefined);
    assert.equal(visible.allowedErrorCodes, undefined);
    assert.ok(visible.withheldFields.includes('goal'));
    assert.ok(visible.withheldFields.includes('expectedTerminal'));
    assert.ok(visible.withheldFields.includes('allowedErrorCodes'));
    assert.ok(visible.withheldFields.includes('script'));
  }
});

test('c. 泄漏检测：holdout 样例或答案出现在优化方文本里即命中', () => {
  const view = tiered();
  const holdout = view.cases.filter(item => item.split === 'holdout');
  const clean = '本轮只看 research-success 的失败码，不涉及其它用例。';
  assert.deepEqual(tiers.scanLeak(clean, view.cases), []);

  const leakedGoal = `请按 ${holdout[0].goal} 继续优化提示词`;
  assert.ok(tiers.scanLeak(leakedGoal, view.cases).includes(holdout[0].id));

  const valAnswer = `val 用例的期望终态是 ${view.cases.find(item => item.split === 'val').expectedTerminal}`;
  const hits = tiers.scanLeak(valAnswer, view.cases);
  assert.ok(hits.length > 0, '验证集答案泄漏也要命中');
  assert.equal(tiers.scanLeak('', view.cases).length, 0);
});

test('d. 退役判定：泄漏优先于超量，人工退役优先于自动判定', () => {
  const statePath = path.join(TMP, 'agents', 'retire-case.json');
  const view = tiers.loadTieredSuites({ suitePaths: [V1, ROTATION], statePath });
  const holdoutCase = view.cases.find(item => item.split === 'holdout');
  const holdoutId = holdoutCase.id;
  for (let index = 0; index < 8; index += 1) {
    tiers.recordUse(holdoutId, {
      split: holdoutCase.split,
      datasetVersion: holdoutCase.datasetVersion,
      at: new Date(Date.UTC(2026, 10, 6, 0, index)).toISOString(),
      statePath,
    });
  }
  // 用量是刚落盘的，计划必须读新状态，不能拿循环之前加载的旧视图判定。
  let plan = tiers.planRotation(tiers.loadTieredSuites({ suitePaths: [V1, ROTATION], statePath }), { now: Date.UTC(2026, 10, 6, 12) });
  const first = plan.retired.find(row => row.caseId === holdoutId);
  assert.equal(first.reason, 'overused');
  assert.ok(first.uses > plan.policy.holdoutMaxUses);

  tiers.markLeak(holdoutId, { at: new Date(Date.UTC(2026, 10, 6, 11)).toISOString(), evidence: 'prompt 模板里出现保留集样例', statePath });
  plan = tiers.planRotation(tiers.loadTieredSuites({ suitePaths: [V1, ROTATION], statePath }), { now: Date.UTC(2026, 10, 6, 12) });
  assert.equal(plan.retired.find(row => row.caseId === holdoutId).reason, 'leaked');

  tiers.retireCase(holdoutId, { reason: 'manual_freeze', at: new Date(Date.UTC(2026, 10, 6, 12)).toISOString(), statePath });
  plan = tiers.planRotation(tiers.loadTieredSuites({ suitePaths: [V1, ROTATION], statePath }), { now: Date.UTC(2026, 10, 6, 12) });
  assert.equal(plan.retired.find(row => row.caseId === holdoutId).reason, 'manual_freeze');
});

test('e. 用量幂等与乱序保护：重复时间戳不累加，旧时间戳不回拨计数', () => {
  const statePath = path.join(TMP, 'agents', 'idempotent-use.json');
  const view = tiers.loadTieredSuites({ suitePaths: [V1, ROTATION], statePath });
  const devCase = view.cases.find(item => item.split === 'dev');
  const devId = devCase.id;
  const stamp = '2026-11-06T02:00:00.000Z';
  const first = tiers.recordUse(devId, { split: devCase.split, datasetVersion: devCase.datasetVersion, at: stamp, statePath });
  assert.equal(first.recorded, true);
  assert.equal(first.row.split, 'dev', '用量行必须记住分层，否则隐藏集可以被误记成开发集');
  assert.deepEqual(first.row.datasetVersions, [devCase.datasetVersion]);

  // 同一时间戳重放（重跑同一轮打分）：幂等，不累加。
  const again = tiers.recordUse(devId, { split: devCase.split, at: stamp, statePath });
  assert.equal(again.recorded, false);
  assert.equal(again.reason, 'duplicate_use_stamp');
  assert.equal(again.row.uses, 1);

  // 更旧的时间戳：不回拨计数，也不改 lastUsedAt。
  const older = tiers.recordUse(devId, { split: devCase.split, at: '2026-11-06T01:00:00.000Z', statePath });
  assert.equal(older.recorded, false);
  assert.equal(older.reason, 'out_of_order');
  assert.equal(older.row.uses, 1);
  assert.equal(older.row.lastUsedAt, stamp);

  // 更晚的时间戳：正常累加。
  const later = tiers.recordUse(devId, { split: devCase.split, at: '2026-11-06T02:30:00.000Z', statePath });
  assert.equal(later.recorded, true);
  assert.equal(later.row.uses, 2);

  const reloaded = tiers.loadState(statePath);
  assert.equal(reloaded.cases[devId].uses, 2);
  assert.equal(reloaded.cases[devId].split, 'dev');
  // 不知道分层就不允许记用量：否则一个被误标成 dev 的 holdout 会悄悄拿到计数。
  assert.throws(() => tiers.recordUse('ghost-case', { statePath }), /必须知道用例分层/);
  assert.equal(tiers.loadState(statePath).cases['ghost-case'], undefined, '失败的 recordUse 不得留下半知用量行');
});

test('f. 轮换计划与优化方报告：隐藏池耗尽要报警，dev 逐例、val 与 holdout 只聚合', () => {
  const statePath = path.join(TMP, 'agents', 'rotation-plan.json');
  let view = tiers.loadTieredSuites({ suitePaths: [V1, ROTATION], statePath });
  const rotationIds = view.cases.filter(item => item.split === 'rotation').map(item => item.caseId || item.id);
  for (const caseId of view.cases.filter(item => item.split === 'holdout').map(item => item.id)) {
    tiers.retireCase(caseId, { reason: 'leaked_batch_1', at: '2026-11-06T03:00:00.000Z', statePath });
  }
  for (const caseId of rotationIds) {
    tiers.retireCase(caseId, { reason: 'overused_batch_1', at: '2026-11-06T03:00:00.000Z', statePath });
  }
  view = tiers.loadTieredSuites({ suitePaths: [V1, ROTATION], statePath });
  const plan = tiers.planRotation(view, { now: Date.UTC(2026, 10, 6, 4) });
  assert.equal(plan.hiddenPool, 0);
  assert.equal(plan.hiddenPoolExhausted, true);
  assert.equal(plan.retired.length, 6);
  assert.ok(plan.replacementsRequired >= 1, '轮换集被掏空后必须补入新用例');
  assert.deepEqual(plan.usable.holdout, []);
  assert.deepEqual(plan.usable.dev.length, 6);
  tiers.markRotationApplied({ at: '2026-11-06T04:00:00.000Z', statePath });
  const applied = tiers.planRotation(tiers.loadTieredSuites({ suitePaths: [V1, ROTATION], statePath }), { now: Date.UTC(2026, 10, 10, 4) });
  assert.equal(applied.rotationDue, false, '7 天间隔内补过就不该再报"该轮换"');
  assert.equal(applied.nextRotationAt, '2026-11-13T04:00:00.000Z');
  const overdue = tiers.planRotation(tiers.loadTieredSuites({ suitePaths: [V1, ROTATION], statePath }), { now: Date.UTC(2026, 10, 14, 4) });
  assert.equal(overdue.rotationDue, true);

  const report = tiers.optimizerReport(view, [
    { caseId: view.cases.find(item => item.split === 'dev').id, success: true, terminal: 'completed' },
    { caseId: view.cases.find(item => item.split === 'val').id, success: false, terminal: 'failed' },
    { caseId: view.cases.find(item => item.split === 'holdout').id, success: true, terminal: 'completed', leakDetected: true },
  ]);
  assert.equal(report.perCase.length, 1);
  assert.equal(report.valAggregate.count, 1);
  assert.equal(report.valAggregate.successRate, 0);
  assert.equal(report.hiddenAggregate.count, 1);
  assert.deepEqual(report.hiddenAggregate.splits, { holdout: 1 });
  assert.equal(report.leakedDetected.length, 1);
  assert.ok(!JSON.stringify(report.perCase).includes('expectedTerminal'));
  assert.throws(() => tiers.optimizerReport(view, [{ caseId: 'ghost', success: true }]), /不属于当前分层数据集/);
});

test.after(() => {
  fs.rmSync(TMP, { recursive: true, force: true });
});
