/**
 * fail-open 判定接入真实工具执行路径回归（Phase 1 收口 C）。
 *
 * 断言口径：
 *  a) 命中 allowlist → 工具真被调用，审计里带 policyVersion；
 *  b) 未命中 → 拒绝执行，工具调用计数为 0，审计有 denied 行；
 *  c) 策略撤销后立即拒绝（下一次调用即生效）；
 *  d) 老任务缺 planId/planVersion → 拒绝（fail-closed，不当作"无计划继续跑"）；
 *  e) R2/R3 即使 allowlist 命中也仍走审批，不因命中白名单被绕过；
 *  f) 未登记 failOpenEligible 的工具行为完全不变（回归）。
 *
 * 隔离纪律：BLUEBIRD_DATA_DIR 在 require server/ 之前指向临时目录。
 */
const crypto = require('crypto');
const fs = require('fs');
const os = require('os');
const path = require('path');
const test = require('node:test');
const assert = require('node:assert');

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'bluebird-failopen-enforce-'));
process.env.BLUEBIRD_DATA_DIR = TMP;
process.env.BLUEBIRD_ENV = 'dev';

const agent = require('../server/agent-runtime');
const failOpenPolicy = require('../server/agents/failopen-policy');

const SUBJECT = 'local-owner';
const OPERATION = 'execute';
const ARGS = { text: '预授权写入' };
const PARAMS_DIGEST = crypto
  .createHash('sha256')
  .update(JSON.stringify({ text: '预授权写入' }))
  .digest('hex');

const toolCalls = { eligible: 0, high: 0, plain: 0 };

agent.registerTool({
  name: 'c_preauth_write',
  description: '测试用：登记为预授权动作的可逆写入',
  parameters: { type: 'object', properties: { text: { type: 'string' } }, required: ['text'] },
  readOnly: false,
  risk: 'reversible_write',
  failOpenEligible: true,
  validate: value =>
    value && typeof value.text === 'string'
      ? { ok: true, args: { text: value.text } }
      : { ok: false, error: 'text 必填' },
  handler: async value => {
    toolCalls.eligible += 1;
    return { ok: true, written: value.text };
  },
});

agent.registerTool({
  name: 'c_preauth_high',
  description: '测试用：登记为预授权动作的高风险工具（R3）',
  parameters: { type: 'object', properties: { text: { type: 'string' } }, required: ['text'] },
  readOnly: false,
  risk: 'high_risk',
  failOpenEligible: true,
  validate: value => ({ ok: true, args: { text: String((value && value.text) || '') } }),
  handler: async () => {
    toolCalls.high += 1;
    return { ok: true };
  },
});

agent.registerTool({
  name: 'c_plain_write',
  description: '测试用：未登记 failOpenEligible，行为必须完全不变',
  parameters: { type: 'object', properties: { text: { type: 'string' } } },
  readOnly: false,
  risk: 'reversible_write',
  validate: value => ({ ok: true, args: { text: String((value && value.text) || '') } }),
  handler: async () => {
    toolCalls.plain += 1;
    return { ok: true };
  },
});

function iso(offsetMs) {
  return new Date(Date.now() + offsetMs).toISOString();
}

function makePolicy({ tool = 'c_preauth_write', riskLevel = 'R1', paramsDigest = PARAMS_DIGEST } = {}) {
  return failOpenPolicy.addPolicy({
    actionScope: {
      tool,
      operation: OPERATION,
      paramsDigest,
      targetScope: 'task:task_fp',
      planVersion: '1',
    },
    preAuthorizedSubjects: [SUBJECT],
    riskLevel,
    validity: {
      notBefore: iso(-60 * 1000),
      expiresAt: iso(60 * 60 * 1000),
      maxUses: 3,
      type: 'long-lived',
    },
    environmentScope: { environment: 'dev', resources: ['bot:memory'] },
    auditRecord: {
      schema: 'failopen/v1',
      requiredFields: [...failOpenPolicy.REQUIRED_AUDIT_FIELDS],
    },
    revocation: { authority: [SUBJECT], effect: 'immediate', propagation: 'next-request' },
    createdBy: SUBJECT,
    approvedBy: SUBJECT,
  });
}

function scopeFor(overrides = {}) {
  return {
    taskId: 'task_fp',
    runId: 'run_fp',
    planId: 'plan_fp',
    planVersion: 1,
    targetScope: 'task:task_fp',
    subject: SUBJECT,
    environment: 'dev',
    resource: 'bot:memory',
    operation: OPERATION,
    ...overrides,
  };
}

function contextFor(scope) {
  return {
    sessionId: 'session_fp',
    userText: '原始请求',
    cache: new Map(),
    round: 1,
    failOpen: scope,
  };
}

function lastAudit() {
  const records = failOpenPolicy.listAudit({ limit: 5 });
  return records[records.length - 1] || null;
}

test('命中 allowlist：工具真被调用，审计含 policyVersion', async () => {
  const created = makePolicy();
  assert.strictEqual(created.ok, true, `策略应可用：${JSON.stringify(created.problems)}`);

  const result = await agent.executeToolCall('c_preauth_write', ARGS, contextFor(scopeFor()));
  assert.strictEqual(result.ok, true);
  assert.strictEqual(toolCalls.eligible, 1, '命中必须真的调用工具');
  assert.strictEqual(result.written, ARGS.text);

  const audit = lastAudit();
  assert.strictEqual(audit.decision, 'allowed');
  assert.strictEqual(audit.policyId, created.policy.policyId);
  assert.strictEqual(audit.policyVersion, failOpenPolicy.currentPolicyVersion());
  assert.strictEqual(audit.paramsDigest, PARAMS_DIGEST);
});

test('未命中 allowlist：拒绝执行，工具调用计数为 0，审计有 denied 行', async () => {
  const before = toolCalls.eligible;
  const result = await agent.executeToolCall(
    'c_preauth_write',
    { text: '不在白名单的参数' },
    contextFor(scopeFor())
  );
  assert.strictEqual(result.ok, false);
  assert.strictEqual(result.code, 'failopen_denied');
  assert.strictEqual(result.failOpenReason, 'params_mismatch');
  assert.strictEqual(toolCalls.eligible, before, '未命中时 handler 不得被调用');

  const audit = lastAudit();
  assert.strictEqual(audit.decision, 'denied');
  assert.strictEqual(audit.reason, 'params_mismatch');
});

test('策略撤销后立即拒绝', async () => {
  const policyId = failOpenPolicy.listPolicies().policies[0].policyId;
  const revoked = failOpenPolicy.revokePolicy(policyId, {
    revokedBy: SUBJECT,
    reason: '收口 C 用例：撤销生效',
  });
  assert.strictEqual(revoked.ok, true);

  const before = toolCalls.eligible;
  const result = await agent.executeToolCall('c_preauth_write', ARGS, contextFor(scopeFor()));
  assert.strictEqual(result.ok, false);
  assert.strictEqual(result.code, 'failopen_denied');
  assert.strictEqual(result.failOpenReason, 'revoked');
  assert.strictEqual(toolCalls.eligible, before, '撤销后 handler 不得被调用');
});

test('老记录缺 planId/planVersion：拒绝而不是当作无计划继续跑', async () => {
  const before = toolCalls.eligible;
  const result = await agent.executeToolCall(
    'c_preauth_write',
    ARGS,
    contextFor(scopeFor({ planId: null, planVersion: null }))
  );
  assert.strictEqual(result.ok, false);
  assert.strictEqual(result.code, 'failopen_scope_incomplete');
  assert.strictEqual(toolCalls.eligible, before, '作用域不全时 handler 不得被调用');
});

test('R2/R3 命中 allowlist 仍走审批，不因白名单被绕过', async () => {
  // 为高风险工具建一条合法 allowlist（R1 语义）——命中也不允许 fail-open
  const created = makePolicy({ tool: 'c_preauth_high' });
  assert.strictEqual(created.ok, true, `策略应可用：${JSON.stringify(created.problems)}`);

  const before = toolCalls.high;
  const result = await agent.executeToolCall(
    'c_preauth_high',
    { text: '高风险动作' },
    contextFor(scopeFor())
  );
  assert.strictEqual(result.ok, false);
  assert.strictEqual(result.code, 'approval_required');
  assert.strictEqual(toolCalls.high, before, 'R3 命中白名单也不得执行');

  const audit = lastAudit();
  assert.strictEqual(audit.decision, 'denied');
  // R3 在匹配阶段之前就被拒绝（不是"匹配到但风险不符"）：风险等级本身不允许 fail-open。
  assert.strictEqual(audit.reason, 'risk_not_allowed');
});

test('未登记 failOpenEligible 的工具行为完全不变', async () => {
  const before = toolCalls.plain;
  const result = await agent.executeToolCall(
    'c_plain_write',
    { text: '普通写入' },
    contextFor(scopeFor())
  );
  assert.strictEqual(result.ok, true, '未登记的工具不参与判定');
  assert.strictEqual(toolCalls.plain, before + 1);
});
