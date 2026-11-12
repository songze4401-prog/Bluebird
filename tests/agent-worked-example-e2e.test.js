/* global require, process, __dirname */
/**
 * A-13 / §20（十三步口径）：端到端 worked example 可重跑。
 *
 * 断言脚本真实跑完十三步，并核对：
 *  - 环境如实标注「非真实模型」；
 *  - 两个 Worker 并行窗口成立；
 *  - A1/B1 带来源/provenance/taint；
 *  - schema/引用/来源三类检查全过；
 *  - Reviewer 独立裁决冲突 C1 并写回 ConflictRecord；
 *  - 交付产物 provenance 链完整；
 *  - Token 取 provider 实际 usage，成本未采集（不估算）；
 *  - P5-C2：验证拒绝注入 → 修订 v2 + 只重跑缺证节点；重跑命中发布门
 *    waiting_approval → 批准后幂等交付；对照场景拒绝 → fail-closed 不交付。
 */
const fs = require('fs');
const os = require('os');
const path = require('path');
const test = require('node:test');
const assert = require('node:assert');
const { execFileSync } = require('child_process');

const ROOT = path.join(__dirname, '..');
const SCRIPT = path.join(ROOT, 'scripts', 'run-worked-example.js');

test('A-13 worked example：十三步真跑、可复核、可重跑', { timeout: 180000 }, () => {
  const outFile = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'bluebird-e2e-out-')), 'run.json');
  execFileSync(process.execPath, [SCRIPT, '--out', outFile], {
    cwd: ROOT,
    encoding: 'utf8',
    timeout: 150000,
  });
  const record = JSON.parse(fs.readFileSync(outFile, 'utf8'));

  // 环境必须如实标注，不能包装成真实端到端。
  assert.strictEqual(record.environment.realModel, false);
  assert.match(record.environment.note, /非真实模型/);
  assert.strictEqual(record.stepCount, 13);
  assert.deepStrictEqual(
    record.steps.map(step => step.step),
    [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13]
  );

  // 十三步内容齐全。
  const names = record.steps.map(step => step.name).join('|');
  for (const keyword of ['Worker 并行研究', 'A1/B1', 'schema', '引用', '来源', 'Reviewer', '交付', 'trace', '修订', '发布门']) {
    assert.ok(names.includes(keyword), `十三步缺少「${keyword}」`);
  }

  // 两个 Worker 真并行（事件窗口重叠）。
  assert.strictEqual(record.parallel, true);
  assert.ok(record.taskIds.workerA && record.taskIds.workerB && record.taskIds.reviewer);

  // A1/B1 的 provenance/taint/来源时间。
  for (const key of ['A1', 'B1']) {
    const artifact = record.artifacts[key];
    assert.ok(artifact.id && artifact.version >= 1, `${key} 必须有 id/version`);
    assert.ok(artifact.provenanceRefs.length >= 1, `${key} 必须带 provenanceRefs`);
    assert.ok(artifact.taintLabels.includes('unverified'), `${key} 必须带 unverified taint`);
    assert.ok(artifact.createdAt, `${key} 必须带写入时间`);
  }
  assert.ok(record.artifacts.A1.provenanceRefs[0].id !== record.artifacts.B1.provenanceRefs[0].id);

  // 三类确定性检查全过。
  for (const stepNo of [4, 5, 6]) {
    const step = record.steps.find(item => item.step === stepNo);
    assert.strictEqual(step.result.A1.ok, true, `步骤 ${stepNo} A1 必须通过`);
    assert.strictEqual(step.result.B1.ok, true, `步骤 ${stepNo} B1 必须通过`);
    assert.ok(step.result.A1.checks.length > 0);
  }

  // Reviewer 独立裁决冲突 C1。
  const reviewStep = record.steps.find(item => item.step === 7);
  assert.strictEqual(reviewStep.reviewerIndependent, true);
  assert.strictEqual(record.conflict.resolutionStatus, 'resolved');
  assert.ok(record.conflict.conflictId);
  assert.ok(record.conflict.selectedCandidateRef);
  assert.ok([record.artifacts.A1.id, record.artifacts.B1.id].includes(record.conflict.selectedCandidateRef));
  assert.ok(record.conflict.rationale);

  // 交付：来源、分歧处理、剩余不确定性、provenance 链。
  const deliveryStep = record.steps.find(item => item.step === 8);
  assert.ok(deliveryStep.deliveryRef.id);
  assert.ok(deliveryStep.provenanceChain);
  assert.ok(deliveryStep.remainingUncertainty.length >= 1);
  assert.strictEqual(record.artifacts.delivery.id, deliveryStep.deliveryRef.id);

  // Token 按 provider 实际 usage；成本不估算。
  assert.strictEqual(record.usage.totalTokens, 244 + 242 + 408);
  assert.strictEqual(record.usage.source, 'provider_reported');
  assert.strictEqual(record.usage.cost, '未采集');
  assert.deepStrictEqual(record.usage.runtimeUsage.workerA, {
    prompt_tokens: 180,
    completion_tokens: 64,
    total_tokens: 244,
  });
  assert.ok(record.latencyMs.workerA >= 0 && record.latencyMs.reviewer >= 0);

  // trace 与事件 id 可复核。
  assert.ok(record.traceId);
  for (const key of ['workerA', 'workerB', 'reviewer']) {
    assert.ok(record.trace.eventIds[key].length > 0, `${key} 必须有事件 id`);
    assert.ok(record.trace.eventIds[key][0].eventId);
  }

  // P5-C2 步骤 10–13：修订闭环 + 发布门。
  const revisionStep = record.steps.find(item => item.step === 10);
  assert.strictEqual(revisionStep.toVersion, 2, '修订必须追加 v2');
  assert.strictEqual(revisionStep.rerunTaskIds.length, 1, '只重跑缺证节点');
  assert.strictEqual(revisionStep.failedErrorCode, 'review_rejected');
  assert.ok(revisionStep.revisionEventIds.length >= 1, 'plan.revision_created 必须落审计');

  const gateStep = record.steps.find(item => item.step === 11);
  assert.strictEqual(gateStep.commitState, 'pending-commit', '获批前 delivery 产物不得提交');
  assert.strictEqual(gateStep.riskLevel, 'R2');

  const approveStep = record.steps.find(item => item.step === 12);
  assert.strictEqual(approveStep.stopReason, 'publish_gate');
  assert.strictEqual(approveStep.commitState, 'committed', '批准后 delivery 产物必须提交');
  assert.strictEqual(approveStep.duplicateRejected, true, '重复执行必须被拒绝');

  const rejectStep = record.steps.find(item => item.step === 13);
  assert.strictEqual(rejectStep.finalStatus, 'cancelled');
  assert.strictEqual(rejectStep.errorCode, 'approval_rejected');
  assert.strictEqual(rejectStep.commitState, 'pending-commit', '拒绝路径不交付');
});
