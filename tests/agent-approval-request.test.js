/* global require, process */
/**
 * §29 通知重试记录 + Approval Request 六态迁移回归。
 *
 * 断言口径（对齐原文）：
 *  a) 通知失败只记账（次数、最后错误、下次时间），不阻塞主流程、不改审批状态；
 *  b) 达到上限后置 exhausted、停止排期，重复失败不再累加；
 *  c) 六态取值 pending/approved/rejected/expired/escalated/cancelled；
 *     非法迁移被拒（含 expired 的原请求不得被批准）。
 *
 * 隔离纪律：BLUEBIRD_DATA_DIR 在 require server/ 之前指向临时目录。
 */
const fs = require('fs');
const os = require('os');
const path = require('path');
const test = require('node:test');
const assert = require('node:assert');

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'bluebird-approval-request-'));
process.env.BLUEBIRD_DATA_DIR = TMP;
process.env.DEEPSEEK_API_KEY = '';
process.env.BLUEBIRD_AGENT_TOOLS = '';
process.env.BLUEBIRD_MONITORING = '0';

const approvals = require('../server/agents/approvals');
const tasks = require('../server/agents/tasks');

let seq = 0;
let taskSeq = 0;

function makeApproval() {
  seq += 1;
  return approvals.createApproval({
    botId: 'memory',
    operation: 'merge',
    payload: { targetId: `mem_target_${seq}`, sourceIds: [`mem_source_${seq}`] },
  });
}

function makeTaskWithApproval() {
  taskSeq += 1;
  const task = tasks.createTask({
    botId: 'memory',
    taskType: 'memory.search',
    goal: `审批取消任务 ${taskSeq}`,
    allowedTools: ['memory_search'],
    deadlineMs: 5000,
  });
  const approval = approvals.createApproval({
    botId: 'memory',
    operation: 'merge',
    payload: { targetId: `mem_target_task_${taskSeq}`, sourceIds: [`mem_source_${taskSeq}`] },
    taskId: task.taskId,
  });
  return { task, approval };
}

function eventsOf(botId, eventType) {
  return tasks.listEvents(botId, { limit: 200 }).filter(event => event.eventType === eventType);
}

test('§29 通知失败重试：次数/最后错误/下次时间入库，不阻塞审批主流程', () => {
  const approval = makeApproval();
  assert.deepStrictEqual(approval.requestStatus, 'pending');
  assert.strictEqual(approval.notification.attempts, 0);

  const base = Date.now();
  const first = approvals.recordNotificationOutcome(approval.approvalId, {
    ok: false,
    error: 'webhook_5xx',
    now: base,
    retryDelayMs: 60 * 1000,
  });
  assert.strictEqual(first.notification.attempts, 1);
  assert.strictEqual(first.notification.lastError, 'webhook_5xx');
  assert.strictEqual(first.notification.nextRetryAt, new Date(base + 60 * 1000).toISOString());
  assert.strictEqual(first.notification.exhausted, false);

  const second = approvals.recordNotificationOutcome(approval.approvalId, {
    ok: false,
    error: 'webhook_timeout',
    now: base + 60 * 1000,
    retryDelayMs: 60 * 1000,
  });
  assert.strictEqual(second.notification.attempts, 2);
  assert.strictEqual(second.notification.lastError, 'webhook_timeout');
  assert.ok(second.notification.nextRetryAt);

  // 通知失败不影响审批本身：仍可正常批准。
  assert.strictEqual(second.status, 'pending');
  assert.strictEqual(second.requestStatus, 'pending');
  const approved = approvals.approve(approval.approvalId, { reason: '通知失败后人工批准' });
  assert.strictEqual(approved.status, 'approved');
  assert.strictEqual(approved.requestStatus, 'approved');
});

test('§29 通知达到上限：置 exhausted、停止排期、重复失败不再累加', () => {
  const approval = makeApproval();
  const base = Date.now();
  let latest = null;
  for (let index = 0; index < approvals.MAX_NOTIFICATION_ATTEMPTS; index += 1) {
    latest = approvals.recordNotificationOutcome(approval.approvalId, {
      ok: false,
      error: `delivery_failed_${index}`,
      now: base + index * 60 * 1000,
    });
  }
  assert.strictEqual(latest.notification.attempts, approvals.MAX_NOTIFICATION_ATTEMPTS);
  assert.strictEqual(latest.notification.exhausted, true);
  assert.strictEqual(latest.notification.nextRetryAt, null);

  // 达上限后的处置：不再重试，次数不再增长，审批仍 pending（不静默放行）。
  const afterLimit = approvals.recordNotificationOutcome(approval.approvalId, {
    ok: false,
    error: 'delivery_again',
    now: base + 10 * 60 * 1000,
  });
  assert.strictEqual(afterLimit.notification.attempts, approvals.MAX_NOTIFICATION_ATTEMPTS);
  assert.strictEqual(afterLimit.status, 'pending');
  assert.strictEqual(afterLimit.requestStatus, 'pending');
});

test('§29 六态迁移：合法迁移放行，非法迁移被拒', () => {
  assert.deepStrictEqual(approvals.REQUEST_STATUSES, [
    'pending',
    'approved',
    'rejected',
    'expired',
    'escalated',
    'cancelled',
  ]);
  assert.throws(
    () => approvals.assertRequestStatusTransition('rejected', 'approved'),
    error => {
      assert.strictEqual(error.code, 'approval_request_transition_invalid');
      assert.strictEqual(error.status, 409);
      return true;
    }
  );
  assert.doesNotThrow(() => approvals.assertRequestStatusTransition('pending', 'approved'));
  assert.doesNotThrow(() => approvals.assertRequestStatusTransition('pending', 'cancelled'));

  const approval = makeApproval();
  const rejected = approvals.reject(approval.approvalId, { reason: '人工拒绝' });
  assert.strictEqual(rejected.requestStatus, 'rejected');
  assert.throws(
    () => approvals.transitionRequestStatus(approval.approvalId, 'approved'),
    error => {
      assert.strictEqual(error.code, 'approval_request_transition_invalid');
      return true;
    }
  );
});

test('§29 R2 超时：请求转 expired；原请求不得被批准，可拒绝/取消', () => {
  const approval = makeApproval();
  assert.strictEqual(approval.riskLevel, 'R2');
  const escalated = approvals.markOverdue(approval.approvalId, {
    now: Date.parse(approval.escalationAt) + 60 * 1000,
  });
  assert.strictEqual(escalated.requestStatus, 'escalated');
  assert.strictEqual(escalated.status, 'pending');

  const expired = approvals.markOverdue(approval.approvalId, {
    now: Date.parse(approval.expiresAt) + 60 * 1000,
  });
  assert.strictEqual(expired.requestStatus, 'expired');
  assert.strictEqual(expired.status, 'pending');

  // 超时不得被解释为批准；也不能事后直接批准原请求。
  assert.throws(
    () => approvals.approve(approval.approvalId, { reason: '过期后批准' }),
    error => {
      assert.strictEqual(error.code, 'approval_request_transition_invalid');
      return true;
    }
  );
  const cancelled = approvals.transitionRequestStatus(approval.approvalId, 'cancelled');
  assert.strictEqual(cancelled.requestStatus, 'cancelled');
  assert.strictEqual(cancelled.status, 'pending');
});

test('B-11 SLA 持久化：新记录冻结 sla，旧记录缺省时只读派生', () => {
  const approval = makeApproval();
  assert.strictEqual(approval.sla.slaPolicyVersion, approvals.APPROVAL_SLA_POLICY_VERSION);
  assert.strictEqual(approval.sla.riskLevel, 'R2');
  assert.strictEqual(approval.sla.slaMs, approvals.R2_SLA_MS);
  assert.strictEqual(approval.sla.escalationRatio, approvals.R2_ESCALATION_RATIO);
  assert.ok(approval.sla.startedAt);
  assert.strictEqual(approval.sla.escalationAt, approval.escalationAt);
  assert.strictEqual(approval.sla.expiresAt, approval.expiresAt);
  assert.strictEqual(approval.state, 'pending');
  assert.deepStrictEqual(approvals.APPROVAL_STATES, [
    'pending',
    'approved',
    'rejected',
    'expired',
    'escalated',
    'cancelled',
    'executing',
    'completed',
    'failed',
  ]);

  // 旧记录：删掉持久化字段后仍可读，且不回写历史数据。
  const raw = approvals.getRawApproval(approval.approvalId);
  const snapshot = JSON.parse(JSON.stringify(raw));
  delete raw.sla;
  delete raw.state;
  const legacyView = approvals.getApproval(approval.approvalId);
  assert.strictEqual(legacyView.status, 'pending');
  assert.strictEqual(legacyView.state, 'pending');
  assert.strictEqual(legacyView.sla.slaPolicyVersion, approvals.APPROVAL_SLA_POLICY_VERSION);
  assert.strictEqual(legacyView.sla.slaMs, approvals.R2_SLA_MS);
  assert.strictEqual(legacyView.sla.escalationAt, snapshot.escalationAt);
  assert.strictEqual(legacyView.sla.expiresAt, snapshot.expiresAt);
  assert.strictEqual(Object.prototype.hasOwnProperty.call(raw, 'sla'), false);
  assert.strictEqual(approvals.mergedStateOf(raw), 'pending');
});

test('B-11 提醒路径：计数/事件入库，不改状态；关闭后拒绝提醒', () => {
  const approval = makeApproval();
  const base = Date.now();
  const first = approvals.remindApproval(approval.approvalId, {
    actor: 'operator',
    now: base,
    channel: 'inbox',
  });
  assert.strictEqual(first.reminder.count, 1);
  assert.strictEqual(first.reminder.lastBy, 'operator');
  assert.strictEqual(first.reminder.channel, 'inbox');
  assert.strictEqual(first.status, 'pending');
  assert.strictEqual(first.requestStatus, 'pending');
  assert.strictEqual(first.state, 'pending');

  const second = approvals.remindApproval(approval.approvalId, { now: base + 60 * 1000 });
  assert.strictEqual(second.reminder.count, 2);
  assert.strictEqual(eventsOf('memory', 'approval.reminded').length >= 2, true);

  const cancelled = approvals.cancelApproval(approval.approvalId, { reason: '撤回' });
  assert.throws(
    () => approvals.remindApproval(approval.approvalId),
    error => {
      assert.strictEqual(error.code, 'approval_not_remindable');
      assert.strictEqual(cancelled.requestStatus, 'cancelled');
      return true;
    }
  );
});

test('B-11 升级路径：显式升级只写 requestStatus，重复升级幂等且只留一条事件', () => {
  const approval = makeApproval();
  const before = eventsOf('memory', 'approval.escalated').length;
  const escalated = approvals.escalateApproval(approval.approvalId, {
    actor: 'operator',
    reason: 'SLA 升级到更高一级人工',
    source: 'manual',
  });
  assert.strictEqual(escalated.requestStatus, 'escalated');
  assert.strictEqual(escalated.status, 'pending');
  assert.strictEqual(escalated.state, 'escalated');
  assert.strictEqual(escalated.escalationSource, 'manual');
  assert.ok(escalated.escalatedAt);

  const again = approvals.escalateApproval(approval.approvalId, { source: 'manual' });
  assert.strictEqual(again.requestStatus, 'escalated');
  assert.strictEqual(eventsOf('memory', 'approval.escalated').length, before + 1);

  // 升级不等于过期：仍允许人工批准。
  const approved = approvals.approve(approval.approvalId, { reason: '升级后人工批准' });
  assert.strictEqual(approved.requestStatus, 'approved');
  assert.strictEqual(approved.state, 'approved');
});

test('B-11 取消路径：关闭请求、收口任务、停用 SLA 计时且幂等', () => {
  const before = approvals.pendingCount();
  const beforeCancelledEvents = eventsOf('memory', 'approval.cancelled').length;
  const { task, approval } = makeTaskWithApproval();
  assert.strictEqual(approvals.pendingCount(), before + 1);
  assert.strictEqual(approval.state, 'pending');

  const cancelled = approvals.cancelApproval(approval.approvalId, {
    actor: 'operator',
    reason: '用户撤回审批',
  });
  assert.strictEqual(cancelled.requestStatus, 'cancelled');
  assert.strictEqual(cancelled.status, 'pending');
  assert.strictEqual(cancelled.state, 'cancelled');
  assert.strictEqual(cancelled.cancelledBy, 'operator');
  assert.strictEqual(cancelled.cancelReason, '用户撤回审批');
  assert.strictEqual(approvals.pendingCount(), before);

  const rawTask = tasks.getRawTask(task.taskId);
  assert.strictEqual(rawTask.status, 'cancelled');
  assert.strictEqual(rawTask.errorCode, 'approval_cancelled');
  assert.strictEqual(eventsOf('memory', 'approval.cancelled').length, beforeCancelledEvents + 1);

  // SLA 已摘除：后续到期检查不再把它标成过期/升级。
  const due = approvals.expireDueApprovals({
    now: Date.parse(approval.expiresAt) + 60 * 1000,
  });
  assert.strictEqual(due.overdue.includes(approval.approvalId), false);
  assert.strictEqual(due.escalated.includes(approval.approvalId), false);
  const reread = approvals.getApproval(approval.approvalId);
  assert.strictEqual(reread.requestStatus, 'cancelled');
  assert.strictEqual(reread.state, 'cancelled');

  // 重复取消幂等，不重复迁移任务、不重复写事件。
  const again = approvals.cancelApproval(approval.approvalId, { reason: '重复取消' });
  assert.strictEqual(again.requestStatus, 'cancelled');
  assert.strictEqual(tasks.getRawTask(task.taskId).status, 'cancelled');
  assert.strictEqual(eventsOf('memory', 'approval.cancelled').length, beforeCancelledEvents + 1);
});

test('B-11 取消后不得执行：已批准请求被取消仍拒绝执行', async () => {
  const approval = makeApproval();
  approvals.approve(approval.approvalId, { reason: '先批准' });
  const cancelled = approvals.cancelApproval(approval.approvalId, { reason: '批准后撤回' });
  assert.strictEqual(cancelled.requestStatus, 'cancelled');
  assert.strictEqual(cancelled.status, 'approved');
  assert.strictEqual(cancelled.state, 'cancelled');
  await assert.rejects(
    () => approvals.execute(approval.approvalId),
    error => {
      assert.strictEqual(error.code, 'approval_cancelled');
      assert.strictEqual(error.status, 409);
      return true;
    }
  );
});
