/**
 * W5 恢复与证据保全：结果 schema、任务落库、父会话投递、写入复核。
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');

const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'bluebird-w5-'));
process.env.BLUEBIRD_DATA_DIR = dataDir;
process.env.BLUEBIRD_WORKSPACE_DIR = path.join(dataDir, 'workspace');
process.env.BLUEBIRD_WORKSPACE_TOOLS = '1';
process.env.BLUEBIRD_RECOVERY_EVIDENCE = '1';
process.env.BLUEBIRD_CLAIM_GUARD = '0';
fs.mkdirSync(process.env.BLUEBIRD_WORKSPACE_DIR, { recursive: true });

const { normalizeWorkerResult } = require('../server/agents/worker-result');
const resultDelivery = require('../server/agents/result-delivery');
const tasks = require('../server/agents/tasks');
const runtime = require('../server/agents/runtime');
const { sanitizeToolEvidence } = require('../server/tool-step');
const workspaceTools = require('../server/tool-workspace');

function recoveryResult() {
  return normalizeWorkerResult({
    status: 'recovery',
    summary: '任务未完成（deadline_exceeded）：已执行 3 项工具。',
    errorCode: 'deadline_exceeded',
    toolSteps: [
      {
        name: 'workspace_write',
        ok: true,
        summary: '已写入 w5.txt',
        durationMs: 12,
        evidence: { path: 'w5.txt', bytes: 2, sha256: 'a'.repeat(64), status: 'success' },
      },
    ],
    evidence: [{ kind: 'workspace', id: 'w5.txt' }],
    changes: [{ kind: 'workspace', id: 'w5.txt', decision: 'created' }],
    sideEffectState: 'uncertain',
    requiresReview: true,
    recovery: {
      attemptedWrites: [{ path: 'w5.txt', exists: true, size: 2, sha256: 'a'.repeat(64) }],
      nextSteps: ['核对 w5.txt 的 hash', '确认后再重试'],
    },
    finishedAt: new Date().toISOString(),
  });
}

test('W5: recovery 结果保留工具回执、副作用状态和写入复核', () => {
  const result = recoveryResult();
  assert.equal(result.status, 'recovery');
  assert.equal(result.toolSteps.length, 1);
  assert.equal(result.toolSteps[0].evidence.path, 'w5.txt');
  assert.equal(result.toolSteps[0].evidence.sha256, 'a'.repeat(64));
  assert.equal(result.sideEffectState, 'uncertain');
  assert.equal(result.requiresReview, true);
  assert.equal(result.recovery.attemptedWrites[0].path, 'w5.txt');
  assert.deepEqual(result.recovery.nextSteps, ['核对 w5.txt 的 hash', '确认后再重试']);
});

test('W5: 父会话投递消息包含部分结果、人工核对与下一步', () => {
  const task = {
    taskId: 'task_w5_delivery',
    botId: 'executor',
    goal: '创建 w5.txt',
  };
  const content = resultDelivery.formatDelivery(
    task,
    'recovery',
    recoveryResult(),
    'deadline_exceeded'
  );
  assert.match(content, /任务未完成/);
  assert.match(content, /workspace_write✓/);
  assert.match(content, /副作用状态：副作用结果不确定/);
  assert.match(content, /需要人工核对/);
  assert.match(content, /已尝试写入：w5\.txt/);
  assert.match(content, /下一步：核对 w5\.txt 的 hash/);
});

test('W5: 任务结果落库不丢恢复字段', () => {
  const task = tasks.createTask({
    agentId: 'executor',
    taskType: 'workspace.file',
    goal: '创建 w5-persist.txt',
    allowedTools: ['workspace_write'],
  });
  const result = recoveryResult();
  tasks.transitionTask(task.taskId, { to: 'accepted' });
  tasks.transitionTask(task.taskId, { to: 'running' });
  tasks.updateTask(task.taskId, {
    result,
    errorCode: 'deadline_exceeded',
    completedAt: result.finishedAt,
  });
  const saved = tasks.getTask(task.taskId).result;
  assert.equal(saved.status, 'recovery');
  assert.equal(saved.toolSteps[0].evidence.path, 'w5.txt');
  assert.equal(saved.sideEffectState, 'uncertain');
  assert.equal(saved.requiresReview, true);
  assert.equal(saved.recovery.attemptedWrites[0].sha256, 'a'.repeat(64));
});

test('W5: 写入路径可复核存在性与 hash，不回传正文', () => {
  const content = Buffer.from('ok', 'utf8');
  fs.writeFileSync(path.join(workspaceTools.WORKSPACE_ROOT, 'w5-check.txt'), content);
  const inspected = runtime.inspectAttemptedWrites([
    { path: 'w5-check.txt', backup: 'w5-check.txt.backup' },
    { path: 'w5-missing.txt' },
  ]);
  assert.equal(inspected[0].exists, true);
  assert.equal(inspected[0].size, content.length);
  assert.equal(
    inspected[0].sha256,
    crypto.createHash('sha256').update(content).digest('hex')
  );
  assert.equal(inspected[0].backup, 'w5-check.txt.backup');
  assert.equal(inspected[1].exists, false);
  assert.equal(inspected[1].status, 'missing');
  assert.equal(JSON.stringify(inspected).includes('正文'), false);
});

test('W5: 备份文件名进入证据白名单', () => {
  const evidence = sanitizeToolEvidence({
    path: 'f02.txt',
    bytes: 2,
    sha256: 'b'.repeat(64),
    backup: 'f02.txt.20261126T000000-000',
  });
  assert.equal(evidence.backup, 'f02.txt.20261126T000000-000');
  assert.equal(sanitizeToolEvidence({ backup: '../secrets.txt' }), undefined);
});

test('W5: BLUEBIRD_RECOVERY_EVIDENCE=0 恢复旧结果形状', () => {
  const previous = process.env.BLUEBIRD_RECOVERY_EVIDENCE;
  process.env.BLUEBIRD_RECOVERY_EVIDENCE = '0';
  try {
    const result = normalizeWorkerResult({
      status: 'recovery',
      errorCode: 'deadline_exceeded',
      toolSteps: [{ name: 'workspace_write', ok: true, evidence: { path: 'w5.txt' } }],
      sideEffectState: 'uncertain',
      requiresReview: true,
      recovery: { attemptedWrites: [{ path: 'w5.txt' }] },
    });
    assert.equal(result.toolSteps[0].evidence, undefined);
    assert.equal(result.sideEffectState, undefined);
    assert.equal(result.requiresReview, undefined);
    assert.equal(result.recovery, undefined);
    assert.deepEqual(runtime.inspectAttemptedWrites([{ path: 'w5-check.txt' }]), []);
  } finally {
    process.env.BLUEBIRD_RECOVERY_EVIDENCE = previous;
  }
});

test.after(() => {
  try {
    fs.rmSync(dataDir, { recursive: true, force: true });
  } catch (_) {
    /* 清理失败不影响结论 */
  }
});
