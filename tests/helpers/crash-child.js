/* global process */
/**
 * P5 崩溃注入子进程。
 *
 * 父进程给 BLUEBIRD_TEST_CRASH_HOOK=<注入点>，本进程执行到该点后会：
 *   1) 同步写 marker 文件（父进程据此确认「已经在窗口里」）；
 *   2) 阻塞事件循环等待父进程发 SIGKILL。
 * 被杀是外部的真信号，不是 mock；本文件只负责把进程固定在窗口内。
 *
 * 同一个文件既跑「做动作」场景，也跑「重启后观察」场景（-restart 后缀）。
 * 观察场景把磁盘上的真实状态打成一行 JSON，父进程解析后断言。
 */
const fs = require('fs');
const path = require('path');

const SCENARIO = String(process.env.BLUEBIRD_CRASH_SCENARIO || '');
if (!process.env.BLUEBIRD_DATA_DIR) {
  console.error('BLUEBIRD_DATA_DIR 未设置');
  process.exit(2);
}

const tasks = require('../../server/agents/tasks');
const approvals = require('../../server/agents/approvals');
const opLedger = require('../../server/agents/op-ledger');
const artifactStore = require('../../server/agents/artifact-store');
const runtime = require('../../server/agents/runtime');
const memory = require('../../server/memory');
const { createSideEffectGuard } = require('../../server/agents/side-effect-guard');
const agentRuntime = require('../../server/agent-runtime');

const BOT = 'memory';

function print(payload) {
  console.log(`CRASH_CHILD_JSON ${JSON.stringify(payload)}`);
}

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

function makeTask({ allowedTools, deadlineMs = 60000, toRunning = true } = {}) {
  const task = tasks.createTask({
    botId: BOT,
    taskType: 'memory.search',
    goal: 'P5 崩溃注入',
    allowedTools,
    deadlineMs,
  });
  if (toRunning) {
    tasks.transitionTask(task.taskId, { to: 'accepted' });
    tasks.transitionTask(task.taskId, { to: 'running' });
  }
  return task.taskId;
}

// 直接写记忆库再载入（memory-service 没有「新建」操作，复用既有测试的种子方式）。
function seedMemory() {
  const t = new Date().toISOString();
  const items = [
    {
      id: 'mem_p5',
      content: 'P5 崩溃注入种子记忆',
      type: 'preference',
      keywords: ['P5'],
      confidence: 0.95,
      status: 'active',
      validFrom: t,
      validTo: null,
      createdAt: t,
      updatedAt: t,
      contributions: [
        { sessionId: 'sess_p5', sourceQuote: 'P5 种子记忆', createdAt: t, sourceType: 'user' },
      ],
    },
  ];
  fs.writeFileSync(
    path.join(process.env.BLUEBIRD_DATA_DIR, 'memory.json'),
    JSON.stringify(items, null, 2)
  );
  memory.loadMemories();
  return 'mem_p5';
}

function ledgerRows() {
  return Object.values(opLedger.read().ops);
}

function snapshotTask(taskId) {
  const task = tasks.getTask(taskId);
  if (!task) return null;
  return {
    taskId: task.taskId,
    status: task.status,
    errorCode: task.errorCode || null,
    attempts: task.attempts,
    retryAt: task.retryAt || null,
  };
}

function approvalRecords() {
  const store = JSON.parse(fs.readFileSync(approvals.APPROVALS_FILE, 'utf8'));
  return Object.values(store.approvals);
}

async function main() {
  switch (SCENARIO) {
    // 1) 工具已执行、结果未落账本
    case 'tool-after-handler': {
      const taskId = makeTask({ allowedTools: ['memory_remember'] });
      const guard = createSideEffectGuard({ agentId: BOT, taskId });
      await agentRuntime.executeToolCall(
        'memory_remember',
        {
          content: 'P5 崩溃注入记忆',
          type: 'fact',
          sourceQuote: 'P5 崩溃注入记忆',
        },
        {
          sessionId: 'sess_p5',
          memoryScopeSessionId: 'sess_p5',
          userText: '请记住这条：P5 崩溃注入记忆',
          userMessageId: 'msg_p5',
          cache: new Map(),
          sideEffect: guard,
        }
      );
      print({ unexpected: 'handler 返回后没有被杀' });
      process.exit(9);
      return;
    }
    case 'tool-after-handler-restart': {
      const queue = runtime.initializeTaskQueue();
      const task = tasks.allTasks()[0] || null;
      print({
        scenario: SCENARIO,
        task: task ? snapshotTask(task.taskId) : null,
        ledger: ledgerRows().map(row => ({
          status: row.status,
          attempt: row.attempt,
          errorCode: row.errorCode || null,
        })),
        sealedOps: queue.sealedOps,
      });
      process.exit(0);
      return;
    }

    // 2) 产物已写、任务状态未提交
    case 'artifact-after-persist': {
      const taskId = makeTask({ allowedTools: ['memory_remember'] });
      const memoryId = seedMemory();
      const approval = approvals.createApproval({
        botId: BOT,
        operation: 'update',
        payload: { id: memoryId, content: 'P5 产物提交测试内容' },
        taskId,
      });
      approvals.approve(approval.approvalId);
      await approvals.execute(approval.approvalId);
      print({ unexpected: '产物落盘后没有被杀' });
      process.exit(9);
      return;
    }
    case 'artifact-after-persist-restart': {
      const approvalRecovery = approvals.recoverInterrupted();
      const queue = runtime.initializeTaskQueue();
      const task = tasks.allTasks()[0] || null;
      const record = approvalRecords()[0] || null;
      print({
        scenario: SCENARIO,
        task: task ? snapshotTask(task.taskId) : null,
        approval: record
          ? {
              status: record.status,
              errorCode: record.errorCode || null,
              resultOk: Boolean(record.result && record.result.ok),
            }
          : null,
        ledger: ledgerRows().map(row => ({ status: row.status, errorCode: row.errorCode || null })),
        artifacts: artifactStore.all().map(item => ({ id: item.id, commit: item.commit })),
        artifactScan: queue.artifactScan,
        approvalRecovery: {
          recovered: approvalRecovery.recovered,
          executed: approvalRecovery.executed,
          uncertain: approvalRecovery.uncertain,
        },
      });
      process.exit(0);
      return;
    }

    // 3) 审批记录已落盘、任务未进 waiting_approval（W5 窗口）
    case 'approval-after-record-save': {
      const taskId = makeTask({ allowedTools: ['memory_search'], deadlineMs: 60000 });
      const memoryId = seedMemory();
      approvals.createApproval({
        botId: BOT,
        operation: 'update',
        payload: { id: memoryId, content: 'P5 W5 窗口测试内容' },
        taskId,
      });
      print({ unexpected: '审批记录落盘后没有被杀' });
      process.exit(9);
      return;
    }
    case 'approval-after-record-save-restart': {
      const approvalRecovery = approvals.recoverInterrupted();
      const queue = runtime.initializeTaskQueue();
      const task = tasks.allTasks()[0] || null;
      const record = approvalRecords()[0] || null;
      print({
        scenario: SCENARIO,
        task: task ? snapshotTask(task.taskId) : null,
        approval: record ? { status: record.status, errorCode: record.errorCode || null } : null,
        approvalRecovery: {
          recovered: approvalRecovery.recovered,
          reconciled: approvalRecovery.reconciled,
          dangling: approvalRecovery.dangling,
        },
        queueRecovery: { recovered: queue.recovered, recovery: queue.recovery },
      });
      process.exit(0);
      return;
    }

    // 4) 正常执行中途崩溃（无副作用工具）
    case 'task-after-running': {
      const taskId = makeTask({ allowedTools: ['memory_search'], toRunning: false });
      await runtime.runTask(taskId);
      print({ unexpected: '任务进 running 后没有被杀' });
      process.exit(9);
      return;
    }
    case 'task-after-running-restart': {
      runtime.initializeTaskQueue();
      const task = tasks.allTasks()[0] || null;
      const taskId = task ? task.taskId : null;
      let snap = snapshotTask(taskId);
      const deadline = Date.now() + 20000;
      while (
        snap &&
        ['running', 'accepted', 'queued'].includes(snap.status) &&
        Date.now() < deadline
      ) {
        await sleep(150);
        snap = snapshotTask(taskId);
      }
      print({
        scenario: SCENARIO,
        task: snap,
        terminal: snap ? tasks.isTerminalStatus(snap.status) : false,
        ledger: ledgerRows().map(row => ({ status: row.status })),
      });
      process.exit(0);
      return;
    }

    default:
      console.error(`未知场景：${SCENARIO}`);
      process.exit(2);
  }
}

main().catch(error => {
  console.error(`CRASH_CHILD_ERROR ${error && error.stack ? error.stack : error}`);
  process.exit(1);
});
