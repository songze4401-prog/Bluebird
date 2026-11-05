/**
 * Phase 3 第 3 项：死信。
 *
 * 复用既有任务存储与 maxAttempts 语义，不新增状态、不新造计数：
 *  - 连续失败达到 maxAttempts → 在既有终态（failed）上打 deadLetter 标记；
 *  - deadLetter 可列出（原因/最后一次错误码/原任务/产物引用）；
 *  - 人工重投用 createTask 的 idempotencyKey 保证「恰好创建一次」；
 *  - 死信任务仍是 failed 终态，调度器只认 queued/retrying，天然不占队列容量。
 */
const tasks = require('./tasks');

const STATES = Object.freeze({ open: 'open', redelivered: 'redelivered' });

function mark(taskId, { errorCode = null, attempts = null, maxAttempts = null, now = null } = {}) {
  const task = tasks.getRawTask(taskId);
  if (!task) return null;
  const limit = Number.isInteger(maxAttempts)
    ? maxAttempts
    : (Number.isInteger(task.maxAttempts) ? task.maxAttempts : 1);
  const used = Number.isInteger(attempts)
    ? attempts
    : (Number.isInteger(task.attempts) ? task.attempts : 0);
  // 还有重试额度就不进死信：调用方只应在最后一次失败时打标。
  if (used < limit) return null;
  if (task.deadLetter && task.deadLetter.status === STATES.open) return { ...task.deadLetter };
  const at = typeof now === 'string' ? now : new Date().toISOString();
  const record = {
    status: STATES.open,
    lastErrorCode: errorCode || task.errorCode || task.lastErrorCode || null,
    attempts: used,
    maxAttempts: limit,
    createdAt: at,
    redeliveredTaskId: null,
    redeliveredAt: null,
    redeliveryCount: 0,
  };
  tasks.updateTask(task.taskId, { deadLetter: record });
  tasks.appendEvent({
    botId: task.botId,
    taskId: task.taskId,
    eventType: 'task.dead_letter',
    payload: {
      status: 'dead_letter',
      attempts: used,
      maxAttempts: limit,
      ...(record.lastErrorCode ? { errorCode: record.lastErrorCode } : {}),
    },
    correlationId: task.taskId,
  });
  return record;
}

function list({ status = STATES.open, limit = 50 } = {}) {
  return tasks.listDeadLetters({ status, limit });
}

function describe(taskId) {
  const rows = tasks.listDeadLetters({ status: null, limit: 500 });
  return rows.find(row => row.taskId === String(taskId || '')) || null;
}

/**
 * 人工重投：新建同源任务并交给调度器。
 * idempotencyKey 固定为 `<原任务>:redeliver`，重复调用只会拿到同一个新任务，
 * 不会产生第二个重投任务（崩溃在 create 与 mark 之间也能自愈）。
 */
function redeliver(taskId, { now = null, start = true } = {}) {
  const task = tasks.getRawTask(taskId);
  const at = typeof now === 'string' ? now : new Date().toISOString();
  if (!task) return { redelivered: false, reason: 'task_not_found', taskId: String(taskId || '') };
  const record = task.deadLetter;
  if (!record) {
    return { redelivered: false, reason: 'not_dead_letter', taskId: task.taskId };
  }
  if (record.status !== STATES.open) {
    return {
      redelivered: false,
      reason: 'already_redelivered',
      taskId: task.taskId,
      redeliveredTaskId: record.redeliveredTaskId || null,
    };
  }
  const created = tasks.createTask({
    botId: task.botId,
    taskType: task.taskType,
    goal: task.goal,
    context: task.context || '',
    allowedTools: task.allowedTools,
    priority: task.priority,
    deadlineMs: task.deadlineMs,
    parentSessionId: task.parentSessionId || null,
    budget: task.budget || null,
    idempotencyKey: `${task.taskId}:redeliver`,
  });
  if (task.requiresReview === true) {
    tasks.updateTask(created.taskId, { requiresReview: true });
  }
  const next = {
    ...record,
    status: STATES.redelivered,
    redeliveredTaskId: created.taskId,
    redeliveredAt: at,
    redeliveryCount: (Number(record.redeliveryCount) || 0) + 1,
  };
  tasks.updateTask(task.taskId, { deadLetter: next });
  tasks.appendEvent({
    botId: task.botId,
    taskId: task.taskId,
    eventType: 'task.dead_letter_redelivered',
    payload: { status: 'redelivered', redeliveredTaskId: created.taskId },
    correlationId: task.taskId,
  });
  if (start) {
    // 延迟 require：避免与 runtime → dead-letter 的加载顺序形成环。
    try {
      const runtime = require('./runtime');
      runtime.startTask(created.taskId);
    } catch (_) {
      // 调度未就绪时保持 queued，由启动恢复接手。
    }
  }
  return {
    redelivered: true,
    idempotent: created.idempotent === true,
    taskId: task.taskId,
    redeliveredTaskId: created.taskId,
  };
}

module.exports = { STATES, mark, list, describe, redeliver };
