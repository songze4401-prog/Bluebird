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

let seq = 0;

function makeApproval() {
  seq += 1;
  return approvals.createApproval({
    botId: 'memory',
    operation: 'merge',
    payload: { targetId: `mem_target_${seq}`, sourceIds: [`mem_source_${seq}`] },
  });
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
