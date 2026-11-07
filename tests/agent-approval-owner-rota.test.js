/**
 * P5-F / A-08 / B-11 / §15+§29：审批责任队列回归。
 *
 * 口径：
 *  a) 责任人轮值分配：创建时按轮值游标落一名责任人，游标持久化、重启不重置；
 *     单用户实例默认池就是 local-owner，机制不因池子小而缺席（approval-assignee-v1）；
 *  b) 升级即重派：escalateApproval 把记录重派给轮值下一位（幂等：只重派一次），
 *     单人池保持原责任人并如实留痕；
 *  c) 待处理量按责任人分布：byAssignee 覆盖 pending 记录，旧记录如实进 unassigned；
 *  d) 指标 v2（approval-workload-v2）：p50/p95 等待、SLA 达成率（只对有 SLA 的
 *     R2 计，R3 单独计数不进分母）、24h 吞吐，全部从记录实算；无样本 null + caveat；
 *  e) 既有批量/申诉/升级/取消语义不回退（跑既有用例确认）。
 */
const fs = require('fs');
const os = require('os');
const path = require('path');
const test = require('node:test');
const assert = require('node:assert');

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'bluebird-approval-owner-rota-'));
process.env.BLUEBIRD_DATA_DIR = TMP;
process.env.DEEPSEEK_API_KEY = '';
process.env.BLUEBIRD_AGENT_TOOLS = '';
process.env.BLUEBIRD_MONITORING = '0';

const approvals = require('../server/agents/approvals');
const tasks = require('../server/agents/tasks');

const AGENTS_DIR = path.join(TMP, 'agents');
let seq = 0;

function resetStore() {
  fs.rmSync(AGENTS_DIR, { recursive: true, force: true });
  tasks.reloadForTests();
  if (typeof approvals.reloadForTests === 'function') approvals.reloadForTests();
  // 每个用例自带轮值池设定，不复用上一个用例的池子。
  approvals.setAssigneeRotaForTests(['local-owner']);
}

function makeGateApproval({ operation = 'review.conflict', producerTaskId = null } = {}) {
  seq += 1;
  return approvals.createApproval({
    botId: 'memory',
    operation,
    payload: {
      producerTaskId: producerTaskId || `task_p5f_${seq}`,
      artifactId: '',
      version: 1,
      verdict: 'needs_human',
      checkCode: '',
      decision: 'needs_human',
      conflict: false,
    },
    requestedBy: 'agent',
  });
}

test.after(() => {
  try {
    fs.rmSync(TMP, { recursive: true, force: true });
  } catch (_) {
    // ignore
  }
});

test('a. P5-F 轮值分配：创建时按游标轮流落责任人，游标持久化、重启不重置', () => {
  resetStore();
  approvals.setAssigneeRotaForTests(['owner-a', 'owner-b']);
  const first = makeGateApproval();
  const second = makeGateApproval();
  const third = makeGateApproval();
  assert.equal(first.assignee, 'owner-a');
  assert.equal(second.assignee, 'owner-b');
  assert.equal(third.assignee, 'owner-a', '游标循环');
  assert.equal(first.assigneePolicyVersion, 'approval-assignee-v1');

  // 游标持久化：清缓存重读后继续轮转，不重置。
  if (typeof approvals.reloadForTests === 'function') approvals.reloadForTests();
  const fourth = makeGateApproval();
  assert.equal(fourth.assignee, 'owner-b', '重启后游标从上次位置继续');

  // 恢复默认单用户池。
  approvals.setAssigneeRotaForTests(['local-owner']);
  const single = makeGateApproval();
  assert.equal(single.assignee, 'local-owner');
});

test('b. P5-F 升级重派：escalate 换下一位且只重派一次；单人池保持原责任人', () => {
  resetStore();
  approvals.setAssigneeRotaForTests(['owner-a', 'owner-b']);
  const record = makeGateApproval();
  assert.equal(record.assignee, 'owner-a');

  const escalated = approvals.escalateApproval(record.approvalId, { actor: 'sla', source: 'sla' });
  assert.equal(escalated.assignee, 'owner-b', '升级重派到轮值下一位');
  assert.equal(escalated.assigneeReassignedFrom, 'owner-a');

  const again = approvals.escalateApproval(record.approvalId, { actor: 'sla', source: 'sla' });
  assert.equal(again.assignee, 'owner-b', '升级幂等：不二次重派');

  // 单人池：无下一位可换，保持原责任人（如实，不伪造轮换）。
  approvals.setAssigneeRotaForTests(['local-owner']);
  const solo = makeGateApproval();
  const soloEscalated = approvals.escalateApproval(solo.approvalId, { actor: 'sla', source: 'sla' });
  assert.equal(soloEscalated.assignee, 'local-owner');
  assert.equal(soloEscalated.assigneeReassignedFrom, 'local-owner');
});

test('c. P5-F 待处理量按责任人分布：byAssignee 覆盖 pending，旧记录进 unassigned', () => {
  resetStore();
  approvals.setAssigneeRotaForTests(['owner-a', 'owner-b']);
  const first = makeGateApproval();
  const second = makeGateApproval();
  const third = makeGateApproval();
  // third 未决即被裁决后，pending 只剩前两条。
  approvals.reject(third.approvalId, { actor: 'local-owner', reason: '测试裁决' });

  const view = approvals.approvalQueueDistribution({});
  assert.equal(view.policyVersion, 'approval-workload-v2');
  assert.equal(view.totalPending, 2);
  assert.equal(view.byAssignee['owner-a'], 1);
  assert.equal(view.byAssignee['owner-b'], 1);
  assert.ok('unassigned' in view.byAssignee, 'unassigned 桶必须存在（旧记录归口）');

  // 旧记录（没有 assignee 字段）按 unassigned 统计：模拟方式是把一条记录
  // 的责任人抹掉再读分布——通过 pending 记录直接删字段后重读。
  approvals.setAssigneeRotaForTests(['owner-a']);
  const legacy = makeGateApproval();
  const raw = approvals.getRawApproval(legacy.approvalId);
  delete raw.assignee;
  // getRawApproval 返回的是缓存内对象的引用，直接改字段后需要落盘；
  // approvals 的 save 是内部函数——这里用 reload 前的同一缓存读取即可命中。
  const after = approvals.approvalQueueDistribution({});
  assert.equal(after.byAssignee.unassigned, 1, '缺 assignee 的记录如实计入 unassigned');
});

test('d. P5-F 指标 v2：等待分位与 SLA 达成率从记录实算，无样本 null + caveat', () => {
  resetStore();
  // R2（review.conflict，medium）两条：一条批准、一条拒绝——裁决即时完成，
  // 等待时长 0ms，SLA（30min）内达成。
  const first = makeGateApproval();
  const second = makeGateApproval({ operation: 'review.escalate' }); // R3，无 SLA
  approvals.approve(first.approvalId, { actor: 'local-owner', reason: '测试通过' });
  approvals.reject(second.approvalId, { actor: 'local-owner', reason: '测试拒绝' });

  const view = approvals.approvalQueueDistribution({});
  assert.equal(view.metrics.source, 'computed_from_records');
  assert.equal(view.metrics.sampleCount, 2);
  assert.ok(
    Number.isFinite(view.metrics.p50WaitMs) && view.metrics.p50WaitMs >= 0,
    '等待分位是实算数值（本用例即时裁决，接近 0 但不假设恰好 0）'
  );
  assert.ok(view.metrics.p50WaitMs < 30000, '即时裁决的等待远小于 R2 SLA');
  assert.equal(view.metrics.slaSampleCount, 1, '只有 R2 计入 SLA 分母');
  assert.equal(view.metrics.slaComplianceRate, 1, '即时裁决在 30min SLA 内');
  assert.equal(view.metrics.slaNotApplicable, 1, 'R3 无 SLA，单独计数');
  assert.ok(view.metrics.throughputPerHour > 0, '24h 内有裁决，吞吐可算');
  assert.ok(
    view.metrics.caveat && view.metrics.caveat.includes('不足 5'),
    '样本 <5 时如实标注波动，但不冒充不可算'
  );

  // 空存储：无样本 → null + caveat，绝不回落成 0。
  resetStore();
  const empty = approvals.approvalQueueDistribution({});
  assert.equal(empty.metrics.sampleCount, 0);
  assert.equal(empty.metrics.p50WaitMs, null);
  assert.equal(empty.metrics.p95WaitMs, null);
  assert.equal(empty.metrics.slaComplianceRate, null);
  assert.equal(empty.metrics.throughputPerHour, null);
  assert.ok(empty.metrics.caveat && empty.metrics.caveat.length > 4);
});

test('e. P5-F 不回退：批量、申诉、取消、提醒语义原样（抽样断言）', () => {
  resetStore();
  approvals.setAssigneeRotaForTests(['owner-a', 'owner-b']);
  const first = makeGateApproval();
  const second = makeGateApproval();
  // 批量裁决仍按既有语义逐条落 approval.resolved。
  const batch = approvals.batchDecide({
    approvalIds: [first.approvalId, second.approvalId],
    decision: 'approve',
    actor: 'local-owner',
    reason: 'P5-F 批量回归',
  });
  assert.equal(batch.applied, 2);
  assert.equal(batch.failed, 0);
  // createApproval 返回快照；裁决后必须重读。
  const firstAfter = approvals.getApproval(first.approvalId);
  const secondAfter = approvals.getApproval(second.approvalId);
  assert.equal(firstAfter.status, 'approved');
  assert.equal(secondAfter.status, 'approved');
  // 责任人字段不改变既有读取面：decidedBy/decidedAt 原样。
  assert.ok(firstAfter.decidedAt);
  assert.equal(firstAfter.decidedBy, 'local-owner');
  assert.equal(firstAfter.assignee, 'owner-a', '裁决不改变责任人与轮值痕迹');
});
