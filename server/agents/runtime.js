/* global module */
/**
 * Memory Bot Runtime：直接对话与主控委派共用同一套执行循环。
 *
 * 运行时只消费服务端配置、加密凭证、Bot 会话与记忆工具；
 * 两个入口的差别只有消息构造、结果交付对象与是否记录任务。
 */
const crypto = require('crypto');
const { runAgentTurn } = require('../agent-runtime');
const { classifyError } = require('../model-adapter');
const { getManifest } = require('./manifest');
const { assertRunnable } = require('./registry');
const { getCredentialKey } = require('./credentials');
const sessions = require('./sessions');
const mainSessions = require('../sessions');
const tasks = require('./tasks');
const { AgentError } = require('./errors');

const MAX_USER_MESSAGE = 4000;
const HISTORY_MESSAGES = 24;
const MAX_TASK_TOOLS = 6;
const activeRuns = new Map();
const TASK_CONCURRENCY = Math.min(
  4,
  Math.max(1, Number(process.env.BLUEBIRD_AGENT_TASK_CONCURRENCY) || 2)
);
let scheduling = false;

function scheduleTaskQueue() {
  if (scheduling) return;
  scheduling = true;
  try {
    while (activeRuns.size < TASK_CONCURRENCY) {
      const next = tasks.nextQueuedTask();
      if (!next) break;
      runTask(next.taskId).catch(error => {
        console.warn(
          `[agent-queue] task=${next.taskId} code=${
            (error && error.code) || 'agent_task_failed'
          }`
        );
        try {
          const task = tasks.getRawTask(next.taskId);
          if (task && !tasks.isTerminalStatus(task.status)) {
            tasks.updateTask(next.taskId, {
              status: 'failed',
              completedAt: new Date().toISOString(),
              errorCode: (error && error.code) || 'agent_task_failed',
            });
          }
        } catch (_) {
          // 存储损坏时保持显式失败日志，避免队列无限重试同一任务。
        }
        scheduleTaskQueue();
      });
    }
  } finally {
    scheduling = false;
  }
}

function safeEvent(botId, eventType, payload = {}, context = {}) {
  try {
    tasks.appendEvent({
      botId,
      taskId: context.taskId || null,
      runId: context.runId || null,
      sessionId: context.sessionId || null,
      eventType,
      payload,
    });
  } catch (error) {
    // 事件落盘失败不能把已经完成的模型答案伪装成失败；错误只记录短码。
    console.warn(
      `[agent-event] write failed bot=${botId} type=${eventType} code=${
        (error && error.code) || 'event_write_failed'
      }`
    );
  }
}

function allowedToolsFor(config, manifest, taskTools) {
  const manifestSet = new Set(manifest.toolAllowlist);
  const configTools = config.toolAllowlist.filter(name => manifestSet.has(name));
  if (!Array.isArray(taskTools)) return configTools;
  const taskSet = new Set(taskTools);
  return configTools.filter(name => taskSet.has(name));
}

function buildPolicy({ config, allowedTools, toolsSupported }) {
  return {
    schemaVersion: 1,
    mode: 'bounded_autonomy',
    planning: {
      generatePlan: false,
      stagedExecution: false,
      resultSummary: false,
    },
    tools: {
      allowedTools: toolsSupported ? allowedTools.slice(0, MAX_TASK_TOOLS) : [],
      maxToolCalls: toolsSupported ? Math.min(6, allowedTools.length || 1) : 0,
      maxReadOnlyRetries: toolsSupported ? 1 : 0,
    },
    budgets: {
      maxRounds: 3,
      maxTotalMs: config.modelProfile.timeoutMs,
    },
  };
}

function normalizeHistory(messages) {
  return messages
    .filter(message => message && (message.role === 'user' || message.role === 'assistant'))
    .slice(-HISTORY_MESSAGES)
    .map(message => ({ role: message.role, content: String(message.content || '') }))
    .filter(message => message.content.trim());
}

function taskInstruction(task) {
  const lines = [
    '【主控委派任务】',
    `任务类型：${task.taskType}`,
    `目标：${task.goal}`,
  ];
  if (task.context) lines.push(`必要上下文：${task.context}`);
  lines.push(
    `允许的记忆工具：${task.allowedTools.length ? task.allowedTools.join('、') : '无'}`,
    '请完成该任务，并用简洁中文给出结果摘要、依据的记忆/知识 ID、发生的变更与仍需确认的事项。',
    '不要编造未通过工具验证的记忆或变更；不能执行的操作要明确说明。'
  );
  return lines.join('\n');
}

function extractEvidence(name, result, evidence, changes) {
  if (!result || result.ok !== true) return;
  if (name === 'memory_search' && Array.isArray(result.results)) {
    for (const item of result.results.slice(0, 10)) {
      if (item && item.id) evidence.push({ kind: 'memory', id: String(item.id) });
    }
  }
  if (name === 'memory_remember') {
    for (const id of [result.entryId, result.targetId, result.supersededId]) {
      if (id) evidence.push({ kind: 'memory', id: String(id) });
    }
    if (result.entryId || result.targetId) {
      changes.push({
        kind: result.pending ? 'memory.pending' : 'memory',
        id: String(result.entryId || result.targetId),
        decision: String(result.decision || ''),
      });
    }
  }
  if (name === 'knowledge_search' && Array.isArray(result.citations)) {
    for (const citation of result.citations.slice(0, 10)) {
      if (citation && (citation.id || citation.label)) {
        evidence.push({
          kind: 'knowledge',
          id: String(citation.id || citation.label),
        });
      }
    }
  }
}

function formatTaskDelivery(task, result) {
  const lines = [
    '【Memory Bot 任务完成】',
    `任务 ID：${task.taskId}`,
    `目标：${task.goal}`,
    `摘要：${result.summary}`,
  ];
  if (Array.isArray(result.toolSteps) && result.toolSteps.length) {
    lines.push(
      '工具：' +
        result.toolSteps
          .map(step => `${step.name}${step.ok ? '✓' : '✗'}`)
          .join('、')
    );
  }
  if (Array.isArray(result.evidence) && result.evidence.length) {
    lines.push(
      '证据：' +
        result.evidence
          .map(item => `${item.kind}:${item.id}`)
          .join('、')
    );
  }
  if (Array.isArray(result.changes) && result.changes.length) {
    lines.push(
      '变更：' +
        result.changes
          .map(item => `${item.kind}:${item.id}:${item.decision}`)
          .join('、')
    );
  }
  if (result.requiresConfirmation) {
    lines.push('状态：需要用户确认后才会执行相关维护操作。');
  }
  return lines.join('\n');
}

function deliverTaskToParent(task, result) {
  const current = tasks.getRawTask(task.taskId);
  if (current && current.deliveredToParentAt) {
    return { delivered: true, alreadyDelivered: true };
  }
  if (!task.parentSessionId) {
    return { delivered: false, reason: 'no_parent_session' };
  }
  try {
    const appended = mainSessions.appendMessages(task.parentSessionId, [
      {
        role: 'assistant',
        content: formatTaskDelivery(task, result),
        createdAt: new Date().toISOString(),
      },
    ]);
    if (!appended) {
      tasks.updateTask(task.taskId, {
        deliveryErrorCode: 'parent_session_write_failed',
      });
      return { delivered: false, reason: 'parent_session_write_failed' };
    }
    tasks.updateTask(task.taskId, {
      deliveredToParentAt: new Date().toISOString(),
      deliveryErrorCode: null,
    });
    return { delivered: true };
  } catch (error) {
    const code = (error && error.code) || 'parent_delivery_failed';
    try {
      tasks.updateTask(task.taskId, { deliveryErrorCode: code });
    } catch (_) {
      // 任务已完成；投递失败只记录，不回滚任务结果。
    }
    return { delivered: false, reason: code };
  }
}

function dedupeById(items) {

  const seen = new Set();
  const out = [];
  for (const item of items) {
    const key = `${item.kind}:${item.id}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(item);
  }
  return out;
}

async function execute({
  botId,
  messages,
  sessionId = null,
  userText = '',
  taskId = null,
  taskTools = null,
  mode = 'direct_chat',
  signal = null,
  onToolEvent = null,
  stream = false,
  onDelta = null,
}) {
  const { config, model } = assertRunnable(botId);
  const manifest = getManifest(botId);
  const credentialKey = getCredentialKey(config.modelProfile.credentialId, botId);
  const toolsSupported = Boolean(model.capabilities && model.capabilities.tools === true);
  const allowedTools = allowedToolsFor(config, manifest, taskTools);
  const policy = buildPolicy({ config, allowedTools, toolsSupported });
  const evidence = [];
  const changes = [];
  const runId = `run_${crypto.randomUUID()}`;

  if (signal && signal.aborted) {
    throw new AgentError('cancelled', '运行已取消', 409);
  }

  let outcome;
  try {
    outcome = await runAgentTurn({
      providerId: config.modelProfile.providerId,
      modelId: config.modelProfile.modelId,
      messages,
      sessionId,
      userText,
      temperature: config.modelProfile.temperature,
      maxTokens: config.modelProfile.maxTokens,
      timeout: config.modelProfile.timeoutMs,
      policy,
      isClientGone: signal ? () => signal.aborted : undefined,
      abortSignal: signal,
      credentialKey,
      stream,
      onDelta,
      onRequest: ({ round }) => {
        safeEvent(
          botId,
          'model.requested',
          {
            round,
            providerId: config.modelProfile.providerId,
            modelId: config.modelProfile.modelId,
            mode,
          },
          { taskId, runId, sessionId }
        );
      },
      onToolEvent: event => {
        const eventType =
          event.type === 'tool_start'
            ? 'tool.started'
            : event.ok
              ? 'tool.completed'
              : 'tool.failed';
        safeEvent(
          botId,
          eventType,
          {
            tool: event.name,
            ok: event.ok === true,
            ...(event.code ? { errorCode: event.code } : {}),
            mode,
          },
          { taskId, runId, sessionId }
        );
        if (typeof onToolEvent === 'function') {
          onToolEvent(event);
        }
      },
      onToolResult: result => {
        extractEvidence(result.name, result.result, evidence, changes);
        if (result.ok && result.name === 'memory_search') {
          safeEvent(
            botId,
            'memory.read',
            {
              resultCount: Array.isArray(result.result.results)
                ? result.result.results.length
                : 0,
              mode,
            },
            { taskId, runId, sessionId }
          );
        }
        if (result.ok && result.name === 'memory_remember') {
          safeEvent(
            botId,
            'memory.write_proposed',
            {
              decision: result.result.decision || '',
              pending: result.result.pending === true,
              mode,
            },
            { taskId, runId, sessionId }
          );
          if (result.result.entryId || result.result.targetId) {
            safeEvent(
              botId,
              'memory.changed',
              {
                decision: result.result.decision || '',
                pending: result.result.pending === true,
                mode,
              },
              { taskId, runId, sessionId }
            );
          }
        }
      },
    });
  } catch (error) {
    if (signal && signal.aborted) {
      throw new AgentError('cancelled', '运行已取消', 409);
    }
    const info = classifyError(error);
    const code = info.kind === 'timeout' ? 'model_timeout' : `model_${info.kind || 'failed'}`;
    safeEvent(
      botId,
      'model.failed',
      { errorCode: code, mode },
      { taskId, runId, sessionId }
    );
    throw new AgentError(code, info.message || '模型调用失败', info.status || 502);
  }

  if (signal && signal.aborted) {
    throw new AgentError('cancelled', '运行已取消', 409);
  }

  safeEvent(
    botId,
    'model.completed',
    {
      rounds: outcome.rounds,
      stopReason: outcome.stopReason || null,
      mode,
    },
    { taskId, runId, sessionId }
  );

  return {
    rawReply: outcome.rawReply,
    toolSteps: outcome.toolSteps,
    rounds: outcome.rounds,
    stopReason: outcome.stopReason,
    toolsEnabled: toolsSupported && allowedTools.length > 0,
    evidence: dedupeById(evidence),
    changes,
    requiresConfirmation: changes.some(item => item.kind === 'memory.pending'),
    model: {
      providerId: config.modelProfile.providerId,
      modelId: config.modelProfile.modelId,
    },
    runId,
  };
}

function requireText(value, label, max) {
  const text = typeof value === 'string' ? value.trim() : '';
  if (!text) throw new AgentError('invalid_message', `${label}不能为空`);
  if (text.length > max) throw new AgentError('invalid_message', `${label}过长`);
  return text;
}

async function chat(botId, {
  sessionId = null,
  message,
  signal = null,
  onToolEvent = null,
  stream = false,
  onDelta = null,
} = {}) {
  const text = requireText(message, '消息', MAX_USER_MESSAGE);
  let session = sessionId ? sessions.getSession(botId, sessionId) : null;
  if (sessionId && !session) {
    throw new AgentError('agent_session_not_found', 'Bot 会话不存在', 404);
  }
  if (!session) {
    session = sessions.createSession(botId, { title: text.slice(0, 30) });
  }

  sessions.appendMessages(botId, session.id, [
    { role: 'user', content: text, createdAt: new Date().toISOString() },
  ]);
  const history = sessions.getMessages(botId, session.id) || [];
  const config = require('./config').getRuntimeConfig(botId);
  const messages = [
    { role: 'system', content: config.prompt.systemPrompt },
    ...normalizeHistory(history),
  ];

  const result = await execute({
    botId,
    messages,
    sessionId: session.id,
    userText: text,
    mode: 'direct_chat',
    signal,
    onToolEvent,
    stream,
    onDelta,
  });

  const reply = typeof result.rawReply === 'string' ? result.rawReply.trim() : '';
  if (!reply) {
    throw new AgentError('empty_reply', 'Memory Bot 没有返回内容', 502);
  }
  const appended = sessions.appendMessages(botId, session.id, [
    {
      role: 'assistant',
      content: reply,
      createdAt: new Date().toISOString(),
      toolSteps: result.toolSteps,
    },
  ]);

  return {
    ok: true,
    botId,
    sessionId: session.id,
    session: sessions.getSession(botId, session.id),
    message: appended.messages[0],
    toolSteps: result.toolSteps,
    evidence: result.evidence,
    changes: result.changes,
    requiresConfirmation: result.requiresConfirmation,
    toolsEnabled: result.toolsEnabled,
    model: result.model,
    stopReason: result.stopReason,
    messageCount: appended.messageCount,
  };
}

async function runTask(taskId) {
  const task = tasks.getRawTask(taskId);
  if (!task) return;
  if (tasks.isTerminalStatus(task.status)) return;

  const controller = new AbortController();
  activeRuns.set(task.taskId, controller);

  try {
    tasks.updateTask(task.taskId, {
      status: 'accepted',
      attempts: (Number.isInteger(task.attempts) ? task.attempts : 0) + 1,
    });
    safeEvent(task.botId, 'task.accepted', { status: 'accepted', taskType: task.taskType }, {
      taskId: task.taskId,
    });

    const afterAccept = tasks.getRawTask(task.taskId);
    if (!afterAccept || tasks.isTerminalStatus(afterAccept.status) || afterAccept.cancelRequested) {
      return;
    }

    tasks.updateTask(task.taskId, {
      status: 'running',
      startedAt: new Date().toISOString(),
    });
    safeEvent(task.botId, 'task.started', { status: 'running', taskType: task.taskType }, {
      taskId: task.taskId,
    });

    const config = require('./config').getRuntimeConfig(task.botId);
    const messages = [
      { role: 'system', content: config.prompt.systemPrompt },
      { role: 'user', content: taskInstruction(task) },
    ];
    const result = await execute({
      botId: task.botId,
      messages,
      sessionId: task.sessionId,
      userText: task.goal,
      taskId: task.taskId,
      taskTools: task.allowedTools,
      mode: 'delegated_task',
      signal: controller.signal,
    });

    const latest = tasks.getRawTask(task.taskId);
    if (!latest || tasks.isTerminalStatus(latest.status) || latest.cancelRequested) {
      return;
    }

    const summary = typeof result.rawReply === 'string' ? result.rawReply.trim() : '';
    if (!summary) {
      throw new AgentError('empty_reply', 'Memory Bot 没有返回内容', 502);
    }

    tasks.updateTask(task.taskId, {
      status: 'completed',
      completedAt: new Date().toISOString(),
      result: {
        summary,
        toolSteps: result.toolSteps,
        evidence: result.evidence,
        changes: result.changes,
        requiresConfirmation: result.requiresConfirmation === true,
        rounds: result.rounds,
        stopReason: result.stopReason,
        model: result.model,
      },
    });
    safeEvent(
      task.botId,
      'task.completed',
      {
        status: 'completed',
        rounds: result.rounds,
        toolCalls: result.toolSteps.length,
        stopReason: result.stopReason || null,
      },
      { taskId: task.taskId }
    );
    deliverTaskToParent(task, {
      summary,
      toolSteps: result.toolSteps,
      evidence: result.evidence,
      changes: result.changes,
      requiresConfirmation: result.requiresConfirmation === true,
    });
  } catch (error) {
    const latest = tasks.getRawTask(task.taskId);
    if (!latest || tasks.isTerminalStatus(latest.status)) return;

    const cancelled =
      latest.cancelRequested || (error && error.code === 'cancelled');
    const timedOut = error && error.code === 'model_timeout';
    const errorCode =
      (error && error.code) || (timedOut ? 'model_timeout' : 'agent_failed');
    const attempts = Number.isInteger(latest.attempts) ? latest.attempts : 0;
    const maxAttempts = Number.isInteger(latest.maxAttempts) ? latest.maxAttempts : 1;
    const retryable =
      !cancelled &&
      !latest.allowedTools.includes('memory_remember') &&
      ['model_connection', 'model_rate_limit', 'model_timeout'].includes(errorCode) &&
      attempts < maxAttempts;

    if (retryable) {
      tasks.updateTask(task.taskId, {
        status: 'queued',
        recoveredAt: new Date().toISOString(),
        errorCode,
      });
      safeEvent(
        task.botId,
        'task.recovered',
        { status: 'queued', errorCode, mode: 'retry' },
        { taskId: task.taskId }
      );
      return;
    }

    const status = cancelled ? 'cancelled' : timedOut ? 'timed_out' : 'failed';
    tasks.updateTask(task.taskId, {
      status,
      completedAt: new Date().toISOString(),
      errorCode,
    });
    safeEvent(
      task.botId,
      status === 'cancelled'
        ? 'task.cancelled'
        : status === 'timed_out'
          ? 'task.timed_out'
          : 'task.failed',
      { status, errorCode },
      { taskId: task.taskId }
    );
  } finally {
    activeRuns.delete(task.taskId);
    scheduleTaskQueue();
  }
}

function startTask(taskId) {
  setImmediate(() => {
    const task = tasks.getTask(taskId);
    if (task && !tasks.isTerminalStatus(task.status)) {
      scheduleTaskQueue();
    }
  });
}

function initializeTaskQueue() {
  try {
    tasks.flushEventOutbox();
  } catch (_) {
    // 事件主文件不可写时 outbox 仍在磁盘，下一次读取会继续重试。
  }
  const recovered = tasks.recoverInterrupted();
  for (const taskId of recovered.taskIds || []) {
    const task = tasks.getRawTask(taskId);
    if (!task) continue;
    safeEvent(
      task.botId,
      'task.recovered',
      { status: 'queued', mode: 'queue_recovery' },
      { taskId }
    );
  }
  scheduleTaskQueue();
  return {
    recovered: recovered.recovered,
    queued: tasks.queuedCount(),
    concurrency: TASK_CONCURRENCY,
  };
}

function getQueueStats() {
  return {
    concurrency: TASK_CONCURRENCY,
    active: activeRuns.size,
    queued: tasks.queuedCount(),
  };
}

function cancelTask(taskId) {
  const task = tasks.getTask(taskId);
  if (!task) throw new AgentError('task_not_found', '任务不存在', 404);
  if (tasks.isTerminalStatus(task.status)) return task;
  tasks.updateTask(taskId, {
    cancelRequested: true,
    status: 'cancelled',
    completedAt: new Date().toISOString(),
  });
  const controller = activeRuns.get(taskId);
  if (controller) controller.abort();
  safeEvent(task.botId, 'task.cancelled', { status: 'cancelled' }, { taskId });
  setImmediate(scheduleTaskQueue);
  return tasks.getTask(taskId);
}

module.exports = {
  chat,
  execute,
  startTask,
  cancelTask,
  runTask,
  initializeTaskQueue,
  getQueueStats,
  allowedToolsFor,
  buildPolicy,
};
