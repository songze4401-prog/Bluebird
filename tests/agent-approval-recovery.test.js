/**
 * Phase 1 / P3：审批执行接入幂等账本后的崩溃恢复回归。
 *
 * 覆盖：
 *  a) e1 审批执行后崩溃残留（账本 started）→ 重启 recovery，handler 不重跑；
 *  b) e2 账本 succeeded 的残留 → 收敛为「已执行」而不是 failed；
 *  c) e3 W5 悬空：审批记录已落盘、任务还没进 waiting_approval → 重启后补齐，不悬空；
 *     反向：任务停在 waiting_approval 却没有任何审批记录 → recovery（approval_record_missing）；
 *  d) e4 正常审批路径行为不变：执行一次、账本恰好一行 succeeded、任务 completed。
 *
 * 隔离纪律：BLUEBIRD_DATA_DIR 在 require server/ 之前指向临时目录；
 * 崩溃用真实文件状态模拟（写 executing + opKey、写账本），不 mock 关键判定。
 */
const fs = require('fs');
const os = require('os');
const path = require('path');
const test = require('node:test');
const assert = require('node:assert');

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'bluebird-agent-approval-recovery-'));
process.env.BLUEBIRD_DATA_DIR = TMP;
process.env.DEEPSEEK_API_KEY = '';
process.env.BLUEBIRD_AGENT_TOOLS = '';
process.env.BLUEBIRD_MONITORING = '0';

const tasks = require('../server/agents/tasks');
const approvals = require('../server/agents/approvals');
const opLedger = require('../server/agents/op-ledger');
const memoryService = require('../server/memory-service');

// 执行器计数桩：审批执行走 memoryService.execute，用计数验证「崩溃后 handler 不重跑」。
let executeCalls = 0;
memoryService.execute = async (operation, payload) => {
  executeCalls += 1;
  return { reason: 'ok', ok: true, id: payload && payload.id ? payload.id : 'mem_p3' };
};

let taskSeq = 0;

function makeTask(overrides = {}) {
  taskSeq += 1;
  return tasks.createTask({
    botId: 'memory',
    taskType: 'memory.search',
    goal: `审批恢复任务 ${taskSeq}`,
    allowedTools: ['memory_remember'],
    deadlineMs: 5000,
    ...overrides,
  });
}

function openApproval(overrides = {}) {
  const task = makeTask();
  const approval = approvals.createApproval({
    botId: 'memory',
    operation: 'update',
    payload: { id: 'mem_p3', content: '审批恢复测试内容' },
    taskId: task.taskId,
    ...overrides,
  });
  approvals.approve(approval.approvalId);
  return { task, approval };
}

// 与 approvals.js 的 approvalLedgerKey 同一口径：taskId（或 approvalId）+
// 内容寻址 stepId（approvalId 作为稳定身份分量）。
function keyFor(record) {
  const ledgerTaskId = record.taskId || record.approvalId;
  const stepId = opLedger.deriveStepId({
    toolName: record.operation,
    args: record.payload,
    override: record.approvalId,
  });
  return {
    ledgerTaskId,
    stepId,
    opKey: opLedger.buildOpKey({
      agentId: record.botId,
      taskId: ledgerTaskId,
      stepId,
      toolName: record.operation,
      args: record.payload,
    }),
  };
}

/**
 * 模拟「执行到一半进程被杀」：账本先有行，审批记录停在 executing 并带 opKey，
 * 任务已回 running（真实执行路径里这一步发生在 begin 之后）。
 */
function seedExecuting(approvalId, ledgerStatus) {
  const record = approvals.getRawApproval(approvalId);
  const keyed = keyFor(record);

  if (record.taskId) tasks.transitionTask(record.taskId, { to: 'running' });

  const begun = opLedger.begin({
    agentId: record.botId,
    taskId: keyed.ledgerTaskId,
    stepId: keyed.stepId,
    toolName: record.operation,
    args: record.payload,
  });
  assert.strictEqual(begun.reused, false, '种子账本行必须是新写入的');

  if (ledgerStatus === 'succeeded') {
    opLedger.finish(begun.opKey, {
      status: 'succeeded',
      result: { operation: record.operation, ok: true, reason: 'ok', id: 'mem_p3' },
    });
  }

  const store = JSON.parse(fs.readFileSync(approvals.APPROVALS_FILE, 'utf8'));
  store.approvals[approvalId].status = 'executing';
  store.approvals[approvalId].opKey = keyed.opKey;
  store.approvals[approvalId].executedBy = 'local-owner';
  store.approvals[approvalId].executedAt = new Date().toISOString();
  fs.writeFileSync(approvals.APPROVALS_FILE, JSON.stringify(store, null, 2), 'utf8');

  return keyed;
}

function restart() {
  approvals.reloadForTests();
  tasks.reloadForTests();
  executeCalls = 0;
}

test.after(() => {
  try {
    fs.rmSync(TMP, { recursive: true, force: true });
  } catch (_) {
    // ignore
  }
});

test('e1. 审批执行后崩溃残留 → 重启后 recovery，handler 不重跑', () => {
  const { task, approval } = openApproval();
  const keyed = seedExecuting(approval.approvalId, 'started');

  restart();
  const recovery = approvals.recoverInterrupted();

  assert.equal(recovery.recovered, 1);
  assert.equal(recovery.uncertain, 1);

  const after = approvals.getApproval(approval.approvalId);
  assert.equal(after.status, 'approved', '不确定时审批退回待核对，不写成 failed');
  assert.equal(after.errorCode, 'side_effect_unknown');

  const taskAfter = tasks.getTask(task.taskId);
  assert.equal(taskAfter.status, 'recovery');
  assert.equal(taskAfter.errorCode, 'side_effect_unknown');

  assert.equal(opLedger.get(keyed.opKey).status, 'unknown', 'started 残留要封成 unknown');
  assert.equal(executeCalls, 0, 'handler 绝不重跑');

  console.log(
    `[p3-e1] recovered=${recovery.recovered} uncertain=${recovery.uncertain} ` +
      `handlerCalls=${executeCalls} approval=${after.status} task=${taskAfter.status} ` +
      `ledger=${opLedger.get(keyed.opKey).status}`
  );
});

test('e2. 账本有 succeeded 的残留 → 收敛为已执行而非 failed', () => {
  const { task, approval } = openApproval();
  const keyed = seedExecuting(approval.approvalId, 'succeeded');

  restart();
  const recovery = approvals.recoverInterrupted();

  assert.equal(recovery.recovered, 1);
  assert.equal(recovery.executed, 1);

  const after = approvals.getApproval(approval.approvalId);
  assert.equal(after.status, 'completed');
  assert.equal(after.errorCode, null);
  assert.equal(after.result && after.result.ok, true);

  const taskAfter = tasks.getTask(task.taskId);
  assert.equal(taskAfter.status, 'completed');
  assert.equal(opLedger.get(keyed.opKey).status, 'succeeded');
  assert.equal(executeCalls, 0, '已执行过就不再跑 handler');

  console.log(
    `[p3-e2] recovered=${recovery.recovered} executed=${recovery.executed} ` +
      `handlerCalls=${executeCalls} approval=${after.status} task=${taskAfter.status} ` +
      `resultOk=${Boolean(after.result && after.result.ok)}`
  );
});

test('e3a. W5：审批记录已落盘、任务还没进 waiting_approval → 重启补齐，不悬空', () => {
  const task = makeTask();
  // 新顺序下崩在「记录落盘」与「任务迁移」之间：记录已经 pending、任务还在 running。
  const approval = approvals.createApproval({
    botId: 'memory',
    operation: 'update',
    payload: { id: 'mem_p3', content: '审批恢复测试内容' },
    taskId: task.taskId,
  });
  tasks.transitionTask(task.taskId, { to: 'running' });
  assert.equal(tasks.getTask(task.taskId).status, 'running');

  restart();
  const recovery = approvals.recoverInterrupted();

  assert.equal(recovery.reconciled, 1);
  assert.equal(recovery.dangling, 0);
  assert.equal(tasks.getTask(task.taskId).status, 'waiting_approval');
  assert.equal(approvals.getApproval(approval.approvalId).status, 'pending');

  console.log(
    `[p3-e3a] reconciled=${recovery.reconciled} dangling=${recovery.dangling} ` +
      `task=${tasks.getTask(task.taskId).status} approval=${approvals.getApproval(approval.approvalId).status}`
  );
});

test('e3b. 反向悬空：任务停在 waiting_approval 却没有审批记录 → recovery', () => {
  const task = makeTask();
  tasks.transitionTask(task.taskId, { to: 'accepted' });
  tasks.transitionTask(task.taskId, { to: 'running' });
  tasks.transitionTask(task.taskId, { to: 'waiting_approval' });

  restart();
  const recovery = approvals.recoverInterrupted();

  assert.equal(recovery.dangling, 1);
  const after = tasks.getTask(task.taskId);
  assert.equal(after.status, 'recovery');
  assert.equal(after.errorCode, 'approval_record_missing');

  console.log(
    `[p3-e3b] dangling=${recovery.dangling} task=${after.status} errorCode=${after.errorCode}`
  );
});

test('e4. 正常审批路径行为不变：执行一次、账本一行 succeeded、任务 completed', async () => {
  const { task, approval } = openApproval();
  const keyed = keyFor(approvals.getRawApproval(approval.approvalId));

  restart();
  const result = await approvals.execute(approval.approvalId);

  assert.equal(result.status, 'completed');
  assert.equal(result.result && result.result.ok, true);
  assert.equal(executeCalls, 1, '正常路径只执行一次');
  assert.equal(tasks.getTask(task.taskId).status, 'completed');

  const raw = approvals.getRawApproval(approval.approvalId);
  assert.equal(raw.opKey, keyed.opKey, '执行的键必须与恢复对账口径一致');

  const rows = Object.values(opLedger.read().ops).filter(item => item.taskId === task.taskId);
  assert.equal(rows.length, 1, '一次审批执行只留一行账本');
  assert.equal(rows[0].status, 'succeeded');
  assert.equal(rows[0].opKey, keyed.opKey);

  console.log(
    `[p3-e4] handlerCalls=${executeCalls} approval=${result.status} ` +
      `task=${tasks.getTask(task.taskId).status} ledgerRows=${rows.length} ledger=${rows[0].status}`
  );
});
