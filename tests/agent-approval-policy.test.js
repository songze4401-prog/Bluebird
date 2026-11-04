/**
 * Phase 1 前置 ④：审批 TTL/SLA 与 fail-open 策略表回归（v1.3 §32、§33、§36）。
 *
 * 覆盖：
 *  a) R2 到期只转人工：审批保持 pending、标记 overdue，任务未被放行执行；
 *  b) R3 长时间 pending 仍 pending，期间资源期限照常生效；
 *  c) waiting_approval 资源期限耗尽：无副作用 → timed_out，有副作用 → recovery，审批仍 pending；
 *  d) 命中 fail-open 白名单 → 放行，审计含 policyVersion；
 *  e) 未命中 → fail-closed；
 *  f) 撤销后立即不再命中，策略版本递增；
 *  g) 老审批记录缺四字段 → fail-closed，不执行、不放行。
 *
 * 隔离纪律：BLUEBIRD_DATA_DIR 在 require server/ 之前指向临时目录；
 * 全部走真实文件与真实状态迁移，不 mock 关键判定。
 */
const fs = require('fs');
const os = require('os');
const path = require('path');
const test = require('node:test');
const assert = require('node:assert');

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'bluebird-agent-approval-policy-'));
process.env.BLUEBIRD_DATA_DIR = TMP;
process.env.DEEPSEEK_API_KEY = '';
process.env.BLUEBIRD_AGENT_TOOLS = '';
process.env.BLUEBIRD_MONITORING = '0';

const tasks = require('../server/agents/tasks');
const approvals = require('../server/agents/approvals');
const failopen = require('../server/agents/failopen-policy');

let taskSeq = 0;

function makeTask(overrides = {}) {
  taskSeq += 1;
  return tasks.createTask({
    botId: 'memory',
    taskType: 'memory.search',
    goal: `审批策略任务 ${taskSeq}`,
    allowedTools: ['memory_search'],
    deadlineMs: 5000,
    ...overrides,
  });
}

function deadlineNow(taskId, extraMs = 1000) {
  const raw = tasks.getRawTask(taskId);
  const anchor = Date.parse(raw.startedAt || raw.updatedAt || raw.createdAt || '');
  return anchor + raw.deadlineMs + extraMs;
}

function iso(ms) {
  return new Date(ms).toISOString();
}

function basePolicy(action, now) {
  return {
    actionScope: {
      tool: action.tool,
      operation: action.operation,
      paramsDigest: action.paramsDigest,
      targetScope: 'memory:local-owner',
    },
    preAuthorizedSubjects: ['local-owner'],
    riskLevel: 'R1',
    validity: {
      notBefore: iso(now - 60 * 1000),
      expiresAt: iso(now + 60 * 60 * 1000),
      maxUses: 1,
      type: 'single',
    },
    environmentScope: { environment: 'dev', resources: ['memory-store'] },
    auditRecord: {
      schema: 'failopen.v1',
      requiredFields: [...failopen.REQUIRED_AUDIT_FIELDS],
    },
    revocation: {
      authority: ['local-owner'],
      effect: 'immediate',
      propagation: 'next-request',
    },
    createdBy: 'local-owner',
    approvedBy: 'local-owner',
  };
}

function requestFor(action, now, traceId) {
  return {
    tool: action.tool,
    operation: action.operation,
    paramsDigest: action.paramsDigest,
    targetScope: 'memory:local-owner',
    subject: 'local-owner',
    environment: 'dev',
    resource: 'memory-store',
    riskLevel: 'R1',
    taskId: 'task_failopen',
    runId: 'run_failopen',
    traceId,
    now,
  };
}

test.after(() => {
  try {
    fs.rmSync(TMP, { recursive: true, force: true });
  } catch (_) {
    // ignore
  }
});

test('a. R2 到期只转人工：审批仍 pending，任务未被放行执行', async () => {
  const task = makeTask();
  const approval = approvals.createApproval({
    botId: 'memory',
    operation: 'merge',
    payload: { targetId: 'mem_target', sourceIds: ['mem_source'] },
    taskId: task.taskId,
  });

  assert.equal(approval.riskLevel, 'R2');
  assert.ok(approval.expiresAt);
  assert.ok(approval.escalationAt);

  const expiresAt = Date.parse(approval.expiresAt);
  const early = approvals.expireDueApprovals({ now: expiresAt - 60 * 1000 });
  assert.equal(early.overdue.includes(approval.approvalId), false);

  const due = approvals.expireDueApprovals({ now: expiresAt + 60 * 1000 });
  assert.deepEqual(due.overdue, [approval.approvalId]);

  const after = approvals.getApproval(approval.approvalId);
  assert.equal(after.status, 'pending');
  assert.equal(after.overdue, true);
  assert.ok(after.overdueAt);
  assert.equal(tasks.getTask(task.taskId).status, 'waiting_approval');

  // 到期不是批准：execute 仍以 approval_not_approved 拒绝。
  await assert.rejects(
    () => approvals.execute(approval.approvalId),
    error => error && error.code === 'approval_not_approved'
  );
  assert.equal(tasks.getTask(task.taskId).status, 'waiting_approval');
});

test('b. R3 长时间 pending 仍 pending，期间资源期限照常生效', () => {
  const task = makeTask();
  const approval = approvals.createApproval({
    botId: 'memory',
    operation: 'delete',
    payload: { id: 'mem_r3' },
    taskId: task.taskId,
  });

  assert.equal(approval.riskLevel, 'R3');
  assert.equal(approval.expiresAt, null);
  assert.equal(approval.escalationAt, null);

  // 模拟 7 天后：R3 不设自动批准超时，不会被标记 overdue。
  const long = approvals.expireDueApprovals({ now: Date.now() + 7 * 24 * 60 * 60 * 1000 });
  assert.equal(long.overdue.includes(approval.approvalId), false);
  assert.equal(approvals.getApproval(approval.approvalId).status, 'pending');

  // 资源期限独立有效：deadline 到期即收敛 Task，审批记录仍是 pending。
  const outcome = tasks.convergeWaitingApprovalDeadline(task.taskId, {
    now: deadlineNow(task.taskId),
  });
  assert.equal(outcome.status, 'timed_out');
  assert.equal(tasks.getTask(task.taskId).status, 'timed_out');
  assert.equal(approvals.getApproval(approval.approvalId).status, 'pending');
});

test('c. waiting_approval 资源期限耗尽：无副作用 timed_out、有副作用 recovery，审批仍 pending', () => {
  const noEffectTask = makeTask({ allowedTools: ['memory_search'] });
  const noEffectApproval = approvals.createApproval({
    botId: 'memory',
    operation: 'archive',
    payload: { id: 'mem_nosid' },
    taskId: noEffectTask.taskId,
  });
  const noEffect = tasks.convergeWaitingApprovalDeadline(noEffectTask.taskId, {
    now: deadlineNow(noEffectTask.taskId),
  });
  assert.equal(noEffect.status, 'timed_out');
  assert.equal(noEffect.errorCode, 'deadline_exceeded');
  assert.equal(approvals.getApproval(noEffectApproval.approvalId).status, 'pending');

  const sideEffectTask = makeTask({ allowedTools: ['memory_remember'] });
  const sideEffectApproval = approvals.createApproval({
    botId: 'memory',
    operation: 'archive',
    payload: { id: 'mem_side' },
    taskId: sideEffectTask.taskId,
  });
  const sideEffect = tasks.convergeWaitingApprovalDeadline(sideEffectTask.taskId, {
    now: deadlineNow(sideEffectTask.taskId),
  });
  assert.equal(sideEffect.status, 'recovery');
  assert.equal(sideEffect.errorCode, 'recovery_uncertain_side_effects');
  assert.equal(approvals.getApproval(sideEffectApproval.approvalId).status, 'pending');
});

test('d. 命中 fail-open 白名单 → 放行，审计含 policyVersion', () => {
  const now = Date.now();
  const action = {
    tool: 'memory.write',
    operation: 'update',
    paramsDigest: 'sha256:allow-1',
  };
  const added = failopen.addPolicy(basePolicy(action, now), { now });
  assert.equal(added.ok, true, JSON.stringify(added.problems));

  const traceId = 'trace_allow_1';
  const decision = failopen.evaluate(
    requestFor(action, now + 1000, traceId),
    { now: now + 1000 }
  );
  assert.equal(decision.allowed, true);
  assert.equal(decision.reason, 'allowed');
  assert.equal(decision.policyId, added.policy.policyId);
  assert.ok(decision.policyVersion >= 1);
  assert.equal(decision.auditWritten, true);

  const audited = failopen.listAudit({ limit: 10 }).find(item => item.traceId === traceId);
  assert.ok(audited, '命中必须写审计');
  assert.equal(audited.decision, 'allowed');
  assert.equal(audited.policyVersion, decision.policyVersion);
  assert.equal(audited.preAuthorizedBy, 'local-owner');
});

test('e. 未命中 → fail-closed', () => {
  const now = Date.now();
  const missAction = {
    tool: 'memory.write',
    operation: 'update',
    paramsDigest: 'sha256:not-allowlisted',
  };
  const traceId = 'trace_deny_1';
  const decision = failopen.evaluate(
    requestFor(missAction, now + 1000, traceId),
    { now: now + 1000 }
  );
  assert.equal(decision.allowed, false);
  assert.notEqual(decision.reason, 'allowed');

  const audited = failopen.listAudit({ limit: 10 }).find(item => item.traceId === traceId);
  assert.ok(audited);
  assert.equal(audited.decision, 'denied');
});

test('f. 撤销后立即不再命中，策略版本递增', () => {
  const now = Date.now();
  const action = {
    tool: 'memory.write',
    operation: 'merge',
    paramsDigest: 'sha256:revoke-1',
  };
  const before = failopen.getPolicyVersion();
  const added = failopen.addPolicy(basePolicy(action, now), { now });
  assert.equal(added.ok, true, JSON.stringify(added.problems));
  const afterAdd = failopen.getPolicyVersion();
  assert.ok(afterAdd > before);

  const revoked = failopen.revokePolicy(added.policy.policyId, {
    revokedBy: 'local-owner',
    reason: '测试撤销',
    now,
  });
  assert.equal(revoked.ok, true);
  const afterRevoke = failopen.getPolicyVersion();
  assert.ok(afterRevoke > afterAdd);

  const traceId = 'trace_revoked_1';
  const decision = failopen.evaluate(
    requestFor(action, now + 1000, traceId),
    { now: now + 1000 }
  );
  assert.equal(decision.allowed, false);
  assert.equal(decision.reason, 'revoked');
});

test('g. 老审批记录缺四字段 → fail-closed，不执行、不放行', async () => {
  const task = makeTask();
  const approval = approvals.createApproval({
    botId: 'memory',
    operation: 'merge',
    payload: { targetId: 'mem_legacy_target', sourceIds: ['mem_legacy_source'] },
    taskId: task.taskId,
  });
  approvals.approve(approval.approvalId);

  // 模拟升级前落库的老记录：四字段整体缺失。
  const store = JSON.parse(fs.readFileSync(approvals.APPROVALS_FILE, 'utf8'));
  const legacy = store.approvals[approval.approvalId];
  delete legacy.riskLevel;
  delete legacy.expiresAt;
  delete legacy.escalationAt;
  delete legacy.policyVersion;
  fs.writeFileSync(approvals.APPROVALS_FILE, JSON.stringify(store, null, 2), 'utf8');
  approvals.reloadForTests();

  await assert.rejects(
    () => approvals.execute(approval.approvalId),
    error => error && error.code === 'approval_policy_missing'
  );

  const after = approvals.getApproval(approval.approvalId);
  assert.equal(after.status, 'approved');
  assert.equal(after.riskLevel, null);
  assert.equal(after.policyVersion, null);
  assert.equal(tasks.getTask(task.taskId).status, 'waiting_approval');
});
