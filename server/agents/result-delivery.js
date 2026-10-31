/* global module */
/**
 * 统一的 Agent Result Delivery。
 *
 * 任务完成/失败后只走这里：
 *   Task Store → 父主控会话消息 → 投递状态/事件 → 在线 SSE 订阅者
 * 消息 id 固定为 bot-result-<taskId>，重复投递不会生成第二条。
 * 重连时由 snapshot 重发最近结果，前端按消息 id 去重。
 */
const { EventEmitter } = require('events');
const tasks = require('./tasks');
const mainSessions = require('../sessions');

const emitter = new EventEmitter();
emitter.setMaxListeners(50);

const MESSAGE_PREFIX = 'bot-result-';
const SNAPSHOT_LIMIT = 20;

function messageIdFor(taskId) {
  return `${MESSAGE_PREFIX}${taskId}`;
}

function formatDelivery(task, status, result, errorCode) {
  const lines = [
    status === 'completed' ? '【Memory Bot 任务完成】' : '【Memory Bot 任务未完成】',
    `任务 ID：${task.taskId}`,
    `状态：${status}`,
    `目标：${task.goal}`,
  ];
  if (result && result.summary) lines.push(`摘要：${result.summary}`);
  if (result && Array.isArray(result.toolSteps) && result.toolSteps.length) {
    lines.push(
      '工具：' +
        result.toolSteps.map(step => `${step.name}${step.ok ? '✓' : '✗'}`).join('、')
    );
  }
  if (result && Array.isArray(result.evidence) && result.evidence.length) {
    lines.push(
      '证据：' +
        result.evidence.map(item => `${item.kind}:${item.id}`).join('、')
    );
  }
  if (result && Array.isArray(result.changes) && result.changes.length) {
    lines.push(
      '变更：' +
        result.changes
          .map(item => `${item.kind}:${item.id}:${item.decision}`)
          .join('、')
    );
  }
  if (result && result.requiresConfirmation) {
    lines.push('需要用户确认后才会执行相关维护操作。');
  }
  if (errorCode) lines.push(`错误码：${errorCode}`);
  return lines.join('\n');
}

function markDelivery(taskId, patch) {
  try {
    tasks.updateTask(taskId, patch);
  } catch (_) {
    // 任务结果已存在；投递状态写入失败只记录，不回滚任务。
  }
}

function recordDeliveryEvent(task, status, messageId, errorCode) {
  try {
    tasks.appendEvent({
      botId: task.botId,
      taskId: task.taskId,
      sessionId: task.parentSessionId || null,
      eventType: 'task.delivery',
      payload: {
        status,
        ...(messageId ? { messageId } : {}),
        ...(errorCode ? { errorCode } : {}),
        mode: 'result_delivery',
      },
      correlationId: task.taskId,
    });
  } catch (_) {
    // 事件 outbox 已负责持久化；投递本身不因事件写入失败而回滚。
  }
}

function notify(event) {
  for (const listener of [...emitter.listeners('delivery')]) {
    try {
      listener(event);
    } catch (_) {
      // 单个 SSE 客户端失败不能影响其他订阅者。
    }
  }
}

function existingMessage(task) {
  if (!task.parentSessionId || !task.deliveryMessageId) return null;
  const messages = mainSessions.getMessages(task.parentSessionId);
  if (!Array.isArray(messages)) return null;
  return messages.find(message => message.id === task.deliveryMessageId) || null;
}

function deliverTaskOutcome(taskOrId, {
  status,
  result = null,
  errorCode = null,
} = {}) {
  const task =
    typeof taskOrId === 'string' ? tasks.getRawTask(taskOrId) : taskOrId;
  if (!task || !task.parentSessionId) {
    return { delivered: false, reason: 'no_parent_session' };
  }

  if (task.deliveredToParentAt && !task.deliveryMessageId) {
    // 旧版本已投递但没有消息 id：不能再次追加，避免升级后重复消息。
    return { delivered: true, alreadyDelivered: true, legacy: true };
  }

  const messageId = messageIdFor(task.taskId);
  const already = existingMessage({
    ...task,
    deliveryMessageId: task.deliveryMessageId || messageId,
  });
  if (already) {
    if (task.deliveryMessageId !== messageId || task.deliveryStatus !== 'delivered') {
      markDelivery(task.taskId, {
        deliveredToParentAt: new Date().toISOString(),
        deliveryMessageId: messageId,
        deliveryStatus: 'delivered',
        deliveryErrorCode: null,
      });
    }
    return { delivered: true, alreadyDelivered: true, message: already };
  }

  const parent = mainSessions.getSession(task.parentSessionId);
  if (!parent) {
    markDelivery(task.taskId, {
      deliveryStatus: 'failed',
      deliveryErrorCode: 'parent_session_missing',
    });
    recordDeliveryEvent(task, 'failed', null, 'parent_session_missing');
    notify({
      type: 'delivery_failed',
      taskId: task.taskId,
      sessionId: task.parentSessionId,
      errorCode: 'parent_session_missing',
    });
    return { delivered: false, reason: 'parent_session_missing' };
  }

  const content = formatDelivery(task, status, result, errorCode);
  let appended;
  try {
    appended = mainSessions.appendMessages(task.parentSessionId, [
      {
        id: messageId,
        role: 'assistant',
        content,
        createdAt: new Date().toISOString(),
        ...(result && Array.isArray(result.toolSteps) && result.toolSteps.length
          ? { toolSteps: result.toolSteps }
          : {}),
      },
    ]);
  } catch (_) {
    appended = null;
  }

  if (!appended) {
    markDelivery(task.taskId, {
      deliveryStatus: 'failed',
      deliveryErrorCode: 'parent_session_write_failed',
    });
    recordDeliveryEvent(task, 'failed', null, 'parent_session_write_failed');
    notify({
      type: 'delivery_failed',
      taskId: task.taskId,
      sessionId: task.parentSessionId,
      errorCode: 'parent_session_write_failed',
    });
    return { delivered: false, reason: 'parent_session_write_failed' };
  }

  const message = appended[0];
  markDelivery(task.taskId, {
    deliveredToParentAt: message.createdAt || new Date().toISOString(),
    deliveryMessageId: messageId,
    deliveryStatus: 'delivered',
    deliveryErrorCode: null,
  });
  recordDeliveryEvent(task, 'delivered', messageId, null);
  notify({
    type: 'result',
    taskId: task.taskId,
    sessionId: task.parentSessionId,
    status,
    result: result || null,
    errorCode,
    message,
  });
  return { delivered: true, message };
}

function recoverPending() {
  let delivered = 0;
  let failed = 0;
  for (const task of tasks.allTasks()) {
    if (!task.parentSessionId) continue;
    if (!tasks.isTerminalStatus(task.status)) continue;
    if (task.deliveryStatus === 'delivered' && task.deliveredToParentAt) {
      continue;
    }
    const outcome = deliverTaskOutcome(task, {
      status: task.status,
      result: task.result,
      errorCode: task.errorCode,
    });
    if (outcome.delivered) delivered += 1;
    else failed += 1;
  }
  return { delivered, failed };
}

function snapshotForSession(sessionId, limit = SNAPSHOT_LIMIT) {
  if (!sessionId) return [];
  try {
    recoverPending();
  } catch (_) {
    // 单个会话恢复失败不影响 SSE 建连。
  }
  const results = [];
  for (const task of tasks.listTasks('memory', {
    limit,
    parentSessionId: sessionId,
  })) {
    if (task.deliveryMessageId) {
      const messages = mainSessions.getMessages(sessionId);
      const message = Array.isArray(messages)
        ? messages.find(item => item.id === task.deliveryMessageId)
        : null;
      if (message) {
        results.push({
          type: 'result',
          taskId: task.taskId,
          sessionId,
          status: task.status,
          result: task.result,
          errorCode: task.errorCode,
          message,
        });
        continue;
      }
    }
    if (task.deliveryStatus === 'failed') {
      results.push({
        type: 'delivery_failed',
        taskId: task.taskId,
        sessionId,
        errorCode: task.deliveryErrorCode || 'delivery_failed',
      });
    }
  }
  return results;
}

function subscribe(listener) {
  emitter.on('delivery', listener);
  return () => emitter.off('delivery', listener);
}

module.exports = {
  messageIdFor,
  deliverTaskOutcome,
  recoverPending,
  snapshotForSession,
  subscribe,
};
