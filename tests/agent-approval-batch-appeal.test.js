/* global require, process */
/**
 * A-08 / §15：审批批量、申诉改判与审批负载。
 *
 * 口径：
 *  a) 批量裁决仅聚合「同风险等级 + 同动作类型」；逐条落 approval.resolved 审计，
 *     部分失败不吞掉其它条；
 *  b) 被拒后可申诉一次；申诉与改判都写回原记录并保留原裁决快照，不覆盖历史；
 *  c) 待审队列分布可按风险/等待时长查询；性能指标留位（需压测，不填数值）；
 *  d) 批量上限 10 / 申诉窗口 24h / 仅 Owner 可申诉 = 本仓库裁决，非 Notion 原文。
 */
const fs = require('fs');
const os = require('os');
const path = require('path');
const test = require('node:test');
const assert = require('node:assert');

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'bluebird-approval-batch-appeal-'));
process.env.BLUEBIRD_DATA_DIR = TMP;
process.env.DEEPSEEK_API_KEY = '';
process.env.BLUEBIRD_AGENT_TOOLS = '';
process.env.BLUEBIRD_MONITORING = '0';

const approvals = require('../server/agents/approvals');
const tasks = require('../server/agents/tasks');
const permissions = require('../server/agents/permissions');

let seq = 0;

function makeMergeApproval() {
  seq += 1;
  return approvals.createApproval({
    botId: 'memory',
    operation: 'merge',
    payload: { targetId: `mem_batch_target_${seq}`, sourceIds: [`mem_batch_source_${seq}`] },
  });
}

function makeArchiveApproval() {
  seq += 1;
  return approvals.createApproval({
    botId: 'memory',
    operation: 'archive',
    payload: { id: `mem_archive_${seq}` },
  });
}

function countEvents(eventType) {
  return tasks.listEvents('memory', { limit: 500 }).filter(item => item.eventType === eventType)
    .length;
}

test('A-08 批量审批：同风险/同动作一次裁决，逐条审计并写回 batchId', () => {
  const items = [makeMergeApproval(), makeMergeApproval(), makeMergeApproval()];
  const before = countEvents('approval.resolved');
  const result = approvals.batchDecide({
    approvalIds: items.map(item => item.approvalId),
    decision: 'approve',
    reason: '批量通过',
  });
  assert.strictEqual(result.policyVersion, approvals.APPROVAL_BATCH_POLICY_VERSION);
  assert.strictEqual(result.requested, 3);
  assert.strictEqual(result.applied, 3);
  assert.strictEqual(result.failed, 0);
  assert.ok(result.batchId);
  for (const item of items) {
    const record = approvals.getApproval(item.approvalId);
    assert.strictEqual(record.status, 'approved');
    assert.strictEqual(record.requestStatus, 'approved');
    assert.strictEqual(record.batchId, result.batchId);
  }
  // 逐条落审计：三条 approval.resolved，而不是只留一条批量事件。
  assert.strictEqual(countEvents('approval.resolved') - before, 3);
});

test('A-08 批量部分失败：不存在的记录被单独记账，其它条照常裁决', () => {
  const items = [makeMergeApproval(), makeMergeApproval(), makeMergeApproval()];
  const result = approvals.batchDecide({
    approvalIds: [...items.map(item => item.approvalId), 'appr_missing_for_batch'],
    decision: 'approve',
  });
  assert.strictEqual(result.requested, 4);
  assert.strictEqual(result.applied, 3);
  assert.strictEqual(result.failed, 1);
  const missing = result.results.find(item => item.approvalId === 'appr_missing_for_batch');
  assert.strictEqual(missing.ok, false);
  assert.strictEqual(missing.errorCode, 'approval_not_found');
  for (const item of items) {
    assert.strictEqual(approvals.getApproval(item.approvalId).status, 'approved');
  }
});

test('A-08 批量分组：风险等级或动作类型不一致的条目单独失败，基准条仍裁决', () => {
  const merge = makeMergeApproval();
  const archive = makeArchiveApproval();
  assert.strictEqual(merge.riskLevel, 'R2');
  assert.strictEqual(archive.riskLevel, 'R3');
  const result = approvals.batchDecide({
    approvalIds: [merge.approvalId, archive.approvalId],
    decision: 'approve',
  });
  assert.strictEqual(result.applied, 1);
  assert.strictEqual(result.failed, 1);
  const mismatch = result.results.find(item => item.approvalId === archive.approvalId);
  assert.strictEqual(mismatch.errorCode, 'approval_batch_mismatch');
  assert.strictEqual(approvals.getApproval(merge.approvalId).status, 'approved');
  assert.strictEqual(approvals.getApproval(archive.approvalId).status, 'pending');
});

test('A-08 批量边界：超过上限、重复 id、空数组均拒绝且不改任何记录', () => {
  const tooMany = Array.from({ length: approvals.APPROVAL_BATCH_MAX + 1 }, () =>
    makeMergeApproval()
  );
  assert.throws(
    () =>
      approvals.batchDecide({
        approvalIds: tooMany.map(item => item.approvalId),
        decision: 'approve',
      }),
    error => {
      assert.strictEqual(error.code, 'invalid_approval');
      return true;
    }
  );
  for (const item of tooMany) {
    assert.strictEqual(approvals.getApproval(item.approvalId).status, 'pending');
  }
  assert.throws(
    () => approvals.batchDecide({ approvalIds: [], decision: 'approve' }),
    error => error.code === 'invalid_approval'
  );
  const one = makeMergeApproval();
  assert.throws(
    () =>
      approvals.batchDecide({
        approvalIds: [one.approvalId, one.approvalId],
        decision: 'approve',
      }),
    error => error.code === 'invalid_approval'
  );
});

test('A-08 申诉：被拒后申诉一次，维持原判不覆盖历史', () => {
  const approval = makeMergeApproval();
  const rejected = approvals.reject(approval.approvalId, { reason: '证据不足' });
  assert.strictEqual(rejected.status, 'rejected');
  assert.strictEqual(rejected.requestStatus, 'rejected');

  const appealed = approvals.appealApproval(approval.approvalId, {
    actor: permissions.SINGLE_USER_ACTOR,
    reason: '补充了来源证据',
  });
  assert.strictEqual(appealed.appealStatus, 'pending');
  assert.strictEqual(appealed.status, 'rejected', '申诉不覆盖原裁决');
  assert.strictEqual(appealed.appeals.length, 1);
  assert.strictEqual(appealed.appeals[0].outcome, 'pending');
  assert.strictEqual(countEvents('approval.appealed') > 0, true);

  const resolved = approvals.resolveAppeal(approval.approvalId, {
    decision: 'uphold',
    actor: permissions.SINGLE_USER_ACTOR,
    reason: '证据仍不足',
  });
  assert.strictEqual(resolved.appealStatus, 'upheld');
  assert.strictEqual(resolved.status, 'rejected');
  assert.strictEqual(resolved.appeals[0].outcome, 'upheld');
  assert.strictEqual(resolved.decidedBy, rejected.decidedBy, '原裁决人保留');

  // 只能申诉一次。
  assert.throws(
    () =>
      approvals.appealApproval(approval.approvalId, {
        actor: permissions.SINGLE_USER_ACTOR,
        reason: '再次申诉',
      }),
    error => error.code === 'approval_appeal_exhausted'
  );
});

test('A-08 改判：overturn 写回原记录并冻结原裁决快照', () => {
  const approval = makeMergeApproval();
  approvals.reject(approval.approvalId, { reason: '初次拒绝' });
  approvals.appealApproval(approval.approvalId, {
    actor: permissions.SINGLE_USER_ACTOR,
    reason: '新证据',
  });
  const overturned = approvals.resolveAppeal(approval.approvalId, {
    decision: 'overturn',
    actor: permissions.SINGLE_USER_ACTOR,
    reason: '新证据成立',
  });
  assert.strictEqual(overturned.status, 'approved');
  assert.strictEqual(overturned.requestStatus, 'approved');
  assert.strictEqual(overturned.appealStatus, 'overturned');
  assert.strictEqual(overturned.appeals[0].outcome, 'overturned');
  // 原裁决（rejected + 裁决人/时间/理由）完整保留。
  assert.ok(overturned.originalDecision);
  assert.strictEqual(overturned.originalDecision.status, 'rejected');
  assert.strictEqual(overturned.originalDecision.requestStatus, 'rejected');
  assert.strictEqual(overturned.originalDecision.decidedBy, overturned.decidedBy);
  assert.strictEqual(overturned.originalDecision.reason, '初次拒绝');
  // 复读一致（写回原记录，不是另建一条）。
  assert.strictEqual(approvals.getApproval(approval.approvalId).status, 'approved');
});

test('A-08 申诉规则：仅 Owner、需理由、仅被拒记录、超 24h 窗口关闭', () => {
  const approval = makeMergeApproval();
  assert.throws(
    () =>
      approvals.appealApproval(approval.approvalId, {
        actor: 'agent',
        reason: 'Agent 代申诉',
      }),
    error => error.code === 'not_authorized' && error.status === 403
  );
  const rejected = approvals.reject(approval.approvalId, { reason: '拒绝' });
  assert.strictEqual(rejected.status, 'rejected');
  assert.throws(
    () => approvals.appealApproval(approval.approvalId, { reason: '   ' }),
    error => error.code === 'invalid_approval'
  );
  assert.throws(
    () =>
      approvals.appealApproval(approval.approvalId, {
        reason: '晚到的申诉',
        now: Date.now() + approvals.APPEAL_WINDOW_MS + 60 * 1000,
      }),
    error => error.code === 'approval_appeal_window_closed'
  );

  // 未被拒绝的记录不能申诉。
  const pending = makeMergeApproval();
  assert.throws(
    () => approvals.appealApproval(pending.approvalId, { reason: '未拒绝也申诉' }),
    error => error.code === 'approval_appeal_not_rejected'
  );
});

test('A-08 审批负载：按风险/动作/等待时长可查询，性能指标留位不填数值', () => {
  const before = approvals.approvalQueueDistribution({ botId: 'memory' });
  const m1 = makeMergeApproval();
  const m2 = makeMergeApproval();
  const a1 = makeArchiveApproval();
  const after = approvals.approvalQueueDistribution({ botId: 'memory' });

  assert.strictEqual(after.policyVersion, 'approval-workload-v1');
  assert.strictEqual(after.totalPending, before.totalPending + 3);
  assert.ok(after.byRiskLevel.R2 >= before.byRiskLevel.R2 + 2);
  assert.ok(after.byRiskLevel.R3 >= before.byRiskLevel.R3 + 1);
  assert.ok(after.byOperation.merge >= before.byOperation.merge + 2);
  assert.ok(after.byOperation.archive >= before.byOperation.archive + 1);
  const bucketSum = Object.values(after.waitingBuckets).reduce((sum, value) => sum + value, 0);
  assert.strictEqual(bucketSum, after.totalPending);
  assert.ok(after.oldestWaitMs >= 0);

  // 指标数值需压测：只留字段位，必须为 null / 明确来源。
  assert.strictEqual(after.metrics.source, 'requires_load_test');
  for (const key of ['throughputPerHour', 'slaComplianceRate', 'p50WaitMs', 'p95WaitMs']) {
    assert.strictEqual(after.metrics[key], null, `${key} 不得填估算值`);
  }

  // 按等待时长过滤：把 created 记录按 2 小时后的时间点读，应落入 gte2h。
  const later = approvals.approvalQueueDistribution({
    botId: 'memory',
    now: Date.now() + 3 * 60 * 60 * 1000,
  });
  assert.ok(later.waitingBuckets.gte2h >= after.totalPending);
  assert.ok([m1, m2, a1].every(item => item.status === 'pending'));
});
