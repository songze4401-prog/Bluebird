/**
 * W3 委派写入的任务级授权测试。
 *
 * 用临时数据目录，不触碰真实 server/data；runtime.runTask 在审批执行测试里
 * 被替换为记录器，避免真的调用模型。
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'bluebird-w3-'));
process.env.BLUEBIRD_DATA_DIR = dataDir;
process.env.BLUEBIRD_WORKSPACE_DIR = path.join(dataDir, 'workspace');
process.env.BLUEBIRD_WORKSPACE_TOOLS = '1';
process.env.BLUEBIRD_AGENT_TOOLS = '1';
process.env.BLUEBIRD_CLAIM_GUARD = '0';
fs.mkdirSync(process.env.BLUEBIRD_WORKSPACE_DIR, { recursive: true });

const tasks = require('../server/agents/tasks');
const approvals = require('../server/agents/approvals');
const sessions = require('../server/agents/sessions');
const router = require('../server/agents/router');
const runtime = require('../server/agents/runtime');
const agentRuntime = require('../server/agent-runtime');

function makeTask({ goal = '创建工作区文件 w3.txt，内容 ok' } = {}) {
  const session = sessions.createSession('executor', { title: 'w3-test', scope: 'worker' });
  const task = tasks.createTask({
    agentId: 'executor',
    workerSessionId: session.id,
    taskType: 'workspace.file',
    goal,
    allowedTools: ['workspace_list', 'workspace_read', 'workspace_write'],
    deadlineMs: 60000,
  });
  return task;
}

function createWriteApproval(task) {
  tasks.updateTask(task.taskId, {
    writeApprovalScope: { taskId: task.taskId, maxBytes: 1024 },
  });
  return approvals.createApproval({
    botId: 'executor',
    operation: 'workspace.write',
    payload: {
      producerTaskId: task.taskId,
      taskType: 'workspace.file',
      maxBytes: 1024,
    },
    taskId: task.taskId,
    sessionId: task.sessionId,
    requestedBy: 'agent',
  });
}

test('W3: 写入目标 + workspace_write 才需要审批', () => {
  assert.equal(
    router.shouldRequireWriteApproval({
      allowedTools: ['workspace_write'],
      taskType: 'workspace.file',
      goal: '创建工作区文件',
    }),
    true
  );
  assert.equal(
    router.shouldRequireWriteApproval({
      allowedTools: ['workspace_read'],
      taskType: 'workspace.file',
      goal: '创建工作区文件',
    }),
    false
  );
  assert.equal(
    router.shouldRequireWriteApproval({
      allowedTools: ['workspace_write'],
      taskType: 'workspace.file',
      goal: '汇报当前进度',
    }),
    false
  );
});

test('W3: 审批执行把任务从 waiting_approval 放回 running 并写入授权', async () => {
  const task = makeTask();
  const approval = createWriteApproval(task);
  const waiting = tasks.getTask(task.taskId);
  assert.equal(waiting.status, 'waiting_approval');
  assert.equal(waiting.writeApproved, false);
  assert.equal(approval.operation, 'workspace.write');

  const originalRunTask = runtime.runTask;
  let resumed = null;
  runtime.runTask = async (taskId, options) => {
    resumed = { taskId, options };
  };
  try {
    approvals.approve(approval.approvalId);
    const done = await approvals.execute(approval.approvalId);
    await new Promise(resolve => setImmediate(resolve));
    const after = tasks.getTask(task.taskId);
    assert.equal(done.status, 'completed');
    assert.equal(done.result.decision, 'write_authorized');
    assert.equal(after.status, 'running');
    assert.equal(after.writeApproved, true);
    assert.equal(after.writeApprovalId, approval.approvalId);
    assert.equal(after.writeApprovalScope.maxBytes, 1024);
    assert.deepEqual(resumed, {
      taskId: task.taskId,
      options: { resumeFromApproval: true },
    });
  } finally {
    runtime.runTask = originalRunTask;
  }
});

test('W3: 拒绝审批取消任务，不产生写入授权', async () => {
  const task = makeTask();
  const approval = createWriteApproval(task);
  approvals.reject(approval.approvalId, { reason: 'test reject' });
  const after = tasks.getTask(task.taskId);
  assert.equal(after.status, 'cancelled');
  assert.equal(after.writeApproved, false);
});

test('W3: 没有审批授权时 workspace_write 仍被 confirmation_required 拒绝', async () => {
  const result = await agentRuntime.executeToolCall(
    'workspace_write',
    { path: 'w3-denied.txt', mode: 'create', content: 'no' },
    {
      sessionId: 's-w3',
      userText: '创建工作区文件',
      cache: new Map(),
      policy: { tools: { allowedTools: ['workspace_write'] } },
      authorizer: () => ({ ok: true }),
      sideEffect: {
        splitOverride: args => ({ args, override: null }),
        before: () => ({ mode: 'execute' }),
        after: () => {},
      },
    }
  );
  assert.equal(result.ok, false);
  assert.equal(result.code, 'confirmation_required');
  assert.equal(fs.existsSync(path.join(process.env.BLUEBIRD_WORKSPACE_DIR, 'w3-denied.txt')), false);
});

test('W3: 有审批授权时可写；超出 scope 上限仍拒绝', async () => {
  const base = {
    sessionId: 's-w3',
    userText: '创建工作区文件',
    cache: new Map(),
    policy: { tools: { allowedTools: ['workspace_write'] } },
    authorizer: () => ({ ok: true }),
    sideEffect: {
      splitOverride: args => ({ args, override: null }),
      before: () => ({ mode: 'execute' }),
      after: () => {},
    },
  };
  const denied = await agentRuntime.executeToolCall(
    'workspace_write',
    { path: 'w3-too-big.txt', mode: 'create', content: '12345' },
    {
      ...base,
      writeAuthorization: {
        approved: true,
        taskId: 'task_w3',
        approvalId: 'appr_w3',
        scope: { taskId: 'task_w3', maxBytes: 4 },
      },
    }
  );
  assert.equal(denied.code, 'write_scope_exceeded');

  const allowed = await agentRuntime.executeToolCall(
    'workspace_write',
    { path: 'w3-ok.txt', mode: 'create', content: 'ok' },
    {
      ...base,
      writeAuthorization: {
        approved: true,
        taskId: 'task_w3',
        approvalId: 'appr_w3',
        scope: { taskId: 'task_w3', maxBytes: 4 },
      },
    }
  );
  assert.equal(allowed.ok, true, JSON.stringify(allowed));
  assert.equal(
    fs.readFileSync(path.join(process.env.BLUEBIRD_WORKSPACE_DIR, 'w3-ok.txt'), 'utf8'),
    'ok'
  );
});

test.after(() => {
  try {
    fs.rmSync(dataDir, { recursive: true, force: true });
  } catch (_) {
    /* 清理失败不影响测试结论 */
  }
});
