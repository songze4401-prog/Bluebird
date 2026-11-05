/* global require */
/**
 * §23 六类错误码统一七字段契约回归（本项覆盖 conflict 之外的五类）。
 *
 * 断言口径（对齐原文）：
 *  a) code/retryable/errorFingerprint/failedAt/taskId/runId/causeRef 七字段齐备；
 *  b) 同输入同指纹（同 code/taskId/runId/causeRef/message）；
 *  c) retryable 取原文默认：validation_failed / not_authorized / budget_exceeded 为
 *     false；dependency_failed / internal_error 为 true（条件性/受限，非自动重试）；
 *  d) 既有键 code/error/status 与 HTTP 状态码不变，只新增附加字段。
 */
const test = require('node:test');
const assert = require('node:assert');

const {
  AgentError,
  budgetExceededError,
  describeAgentError,
} = require('../server/agents/errors');

const SEVEN = ['code', 'retryable', 'errorFingerprint', 'failedAt', 'taskId', 'runId', 'causeRef'];

function assertContract(body, { code, status, retryable }) {
  for (const key of SEVEN) {
    assert.ok(Object.prototype.hasOwnProperty.call(body, key), `${code} 缺少字段 ${key}`);
  }
  assert.strictEqual(body.code, code);
  assert.strictEqual(body.status, status);
  assert.strictEqual(body.retryable, retryable);
  assert.match(body.errorFingerprint, /^[0-9a-f]{64}$/);
  assert.ok(Number.isFinite(Date.parse(body.failedAt)));
}

function assertStable(makeError) {
  const first = describeAgentError(makeError());
  const second = describeAgentError(makeError());
  assert.strictEqual(first.errorFingerprint, second.errorFingerprint);
  return first;
}

test('§23 validation_failed：七字段齐备、指纹稳定、retryable=false', () => {
  const body = assertStable(
    () =>
      new AgentError('validation_failed', '输入 schema 校验失败', 400, {
        taskId: 'task_v',
        runId: 'run_v',
        causeRef: 'schema_invalid',
      })
  );
  assertContract(body, { code: 'validation_failed', status: 400, retryable: false });
  assert.strictEqual(body.taskId, 'task_v');
  assert.strictEqual(body.runId, 'run_v');
  assert.strictEqual(body.causeRef, 'schema_invalid');
});

test('§23 not_authorized：七字段齐备、指纹稳定、retryable=false', () => {
  const body = assertStable(
    () =>
      new AgentError('not_authorized', '工具权限不足', 403, {
        taskId: 'task_a',
        runId: 'run_a',
        causeRef: 'tool_not_allowed',
      })
  );
  assertContract(body, { code: 'not_authorized', status: 403, retryable: false });
});

test('§23 budget_exceeded：七字段齐备、指纹稳定、retryable=false', () => {
  const body = assertStable(() =>
    budgetExceededError({
      taskId: 'task_b',
      scope: 'task',
      required: 1000,
      remaining: 0,
      runId: 'run_b',
      causeRef: 'token_hard_budget',
    })
  );
  assertContract(body, { code: 'budget_exceeded', status: 409, retryable: false });
  // 既有附加字段（scope/required/remaining）不被覆盖
  assert.strictEqual(body.scope, 'task');
  assert.strictEqual(body.required, 1000);
});

test('§23 dependency_failed：七字段齐备、指纹稳定、retryable=true（有条件）', () => {
  const body = assertStable(
    () =>
      new AgentError('dependency_failed', '前置任务失败', 409, {
        taskId: 'task_d',
        runId: 'run_d',
        causeRef: 'dep_task_failed',
      })
  );
  assertContract(body, { code: 'dependency_failed', status: 409, retryable: true });
});

test('§23 internal_error：七字段齐备、指纹稳定、retryable=true（受限）', () => {
  const body = assertStable(
    () =>
      new AgentError('internal_error', '未分类内部异常', 500, {
        taskId: 'task_i',
        runId: 'run_i',
        causeRef: 'store_unreadable',
      })
  );
  assertContract(body, { code: 'internal_error', status: 500, retryable: true });
});

test('§23 不改变既有响应键：无 details 的错误只补附加字段', () => {
  const body = describeAgentError(new AgentError('validation_failed', '参数缺失', 400));
  assert.strictEqual(body.code, 'validation_failed');
  assert.strictEqual(body.error, '参数缺失');
  assert.strictEqual(body.status, 400);
  assert.strictEqual(body.taskId, '');
  assert.strictEqual(body.runId, null);
  assert.strictEqual(body.causeRef, null);
});
