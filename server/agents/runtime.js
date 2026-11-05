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
const tasks = require('./tasks');
const dependencies = require('./dependencies');
const workerScope = require('./worker-scope');
const resultDelivery = require('./result-delivery');
const deadLetter = require('./dead-letter');
const { projectWorkerContext } = require('./context-projection');
const { normalizeWorkerResult } = require('./worker-result');
const { createToolAuthorizer } = require('./tool-gateway');
const { AgentError, budgetExceededError } = require('./errors');
const approvalDeadline = require('./approval-deadline');
const conflictRecord = require('./conflict-record');
const artifactCommit = require('./artifact-commit');
const { createSideEffectGuard } = require('./side-effect-guard');
const crashHook = require('./crash-hook');
const opLedger = require('./op-ledger');
const workflowStore = require('./workflow-store');
const { createCleanupScheduler } = require('./orphan-scheduler');
const verificationLoop = require('./verification-loop');

const MAX_USER_MESSAGE = 4000;
const HISTORY_MESSAGES = 24;
const MAX_TASK_TOOLS = 6;
// 工具调用次数预算与“允许的工具种类数”无关。旧实现用工具种类数当上限，
// 3 个工具就只能调用 3 次，正常的多次检索会提前耗尽预算。
const MAX_TASK_TOOL_CALLS = 6;
// Phase 3 第 1 项：生产者等待独立审校任务收敛的上限。超时即按"审校不可用"
// 保守处理（转人工），绝不当成通过；上限不超过单个 Task deadline 的量级。
const REVIEW_WAIT_MS = Math.min(
  60000,
  Math.max(5000, Number(process.env.BLUEBIRD_AGENT_REVIEW_WAIT_MS) || 30000)
);
// Worker 心跳：运行期间每 N 毫秒刷新任务 heartbeatAt 并写一条安全事件。
// 只证明"执行器仍活着"，不携带任何内容。
const HEARTBEAT_MS = Math.min(
  60000,
  Math.max(20, Number(process.env.BLUEBIRD_AGENT_HEARTBEAT_MS) || 5000)
);
// 单进程部署的写者身份：pid + 进程内唯一实例 id。租约据此判断"是否还是我"。
const WORKER_OWNER_ID = `${process.pid}:${crypto.randomUUID()}`;
const LEASE_TTL_MS = Math.min(
  300000,
  Math.max(15000, Number(process.env.BLUEBIRD_AGENT_LEASE_MS) || 60000)
);
const activeRuns = new Map();
const TASK_CONCURRENCY = Math.min(
  4,
  Math.max(1, Number(process.env.BLUEBIRD_AGENT_TASK_CONCURRENCY) || 2)
);
let scheduling = false;

function nowIso() {
  return new Date().toISOString();
}

function scheduleTaskQueue() {
  if (scheduling) return;
  scheduling = true;
  try {
    // Phase 1 交付物 2：每次取队前先收敛依赖失败（含下游的下游），
    // 这样所有终态写入路径都不必各自埋钩子——它们最终都会走到这里。
    tasks.settleDependencies();
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
            if (task.status === 'queued' || task.status === 'retrying') {
              // 未能进入 accepted 的失败：延后重试而不是原地热循环。
              tasks.updateTask(next.taskId, {
                retryAt: new Date(Date.now() + 2000).toISOString(),
              });
            } else {
              tasks.transitionTask(next.taskId, {
                to: 'failed',
                completedAt: new Date().toISOString(),
                errorCode: (error && error.code) || 'agent_task_failed',
              });
            }
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

async function waitForReviewTask(taskId, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const reviewTask = tasks.getRawTask(taskId);
    if (!reviewTask) return null;
    if (tasks.isTerminalStatus(reviewTask.status)) return reviewTask;
    await new Promise(resolve => setTimeout(resolve, 25));
  }
  return tasks.getRawTask(taskId);
}

function allowedToolsFor(config, manifest, taskTools) {
  const manifestSet = new Set(manifest.toolAllowlist);
  const configTools = config.toolAllowlist.filter(name => manifestSet.has(name));
  if (!Array.isArray(taskTools)) return configTools;
  const taskSet = new Set(taskTools);
  return configTools.filter(name => taskSet.has(name));
}

function buildPolicy({ config, allowedTools, toolsSupported, budget = null }) {
  const planned = budget && Number.isInteger(budget.maxRounds) ? budget : null;
  return {
    schemaVersion: 1,
    mode: 'bounded_autonomy',
    planning: {
      generatePlan: planned ? planned.generatePlan === true : false,
      stagedExecution: false,
      resultSummary: false,
    },
    tools: {
      allowedTools: toolsSupported ? allowedTools.slice(0, MAX_TASK_TOOLS) : [],
      maxToolCalls: toolsSupported
        ? planned
          ? planned.maxToolCalls
          : MAX_TASK_TOOL_CALLS
        : 0,
      maxReadOnlyRetries: toolsSupported
        ? planned
          ? planned.maxReadOnlyRetries
          : 1
        : 0,
    },
    budgets: {
      maxRounds: planned ? planned.maxRounds : 3,
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

// ③ §11 第 1 步的生产者：把工具实际产出、值得长期留存的输出登记为产物候选。
// 这里只收集元数据（引用/决定），正文不复制到产物存储，避免重复与泄漏。
function collectArtifacts(name, result, artifacts) {
  if (!result || result.ok !== true) return;
  if (name === 'memory_remember') {
    for (const id of [result.entryId, result.targetId]) {
      if (!id) continue;
      artifacts.push({
        kind: 'memory',
        content: {
          id: String(id),
          decision: String(result.decision || ''),
          pending: result.pending === true,
        },
      });
    }
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
  // 记忆作用域独立于 Bot 对话会话；委派任务由 runTask 传入父主控 session。
  memoryScopeSessionId = null,
  // 长期记忆是用户级：委派任务沿用父请求的可信用户身份。
  userId = null,
  userText = '',
  taskId = null,
  taskTools = null,
  budget = null,
  mode = 'direct_chat',
  signal = null,
  onToolEvent = null,
  onProgress = null,
  toolAuthorizer = null,
  onToolDenied = null,
  // 收口 C：预授权作用域（只对 failOpenEligible 工具生效）
  failOpen = null,
  runId: runIdOverride = null,
  stream = false,
  onDelta = null,
}) {
  const { config, model } = assertRunnable(botId);
  const manifest = getManifest(botId);
  const credentialKey = getCredentialKey(
    config.modelProfile.credentialId,
    botId,
    config.modelProfile.providerId
  );
  const toolsSupported = Boolean(model.capabilities && model.capabilities.tools === true);
  const allowedTools = allowedToolsFor(config, manifest, taskTools);
  const policy = buildPolicy({ config, allowedTools, toolsSupported, budget });
  const evidence = [];
  const changes = [];
  const artifactInputs = [];
  // Worker 生命周期已经有 runId 时复用它，保证任务、事件与结果指向同一次运行。
  const runId = runIdOverride || `run_${crypto.randomUUID()}`;
  // P2：只有委派任务接幂等账本；主控直聊没有 taskId，不产生任何账本行。
  const sideEffectGuard =
    taskId && mode === 'delegated_task'
      ? createSideEffectGuard({ agentId: botId, taskId })
      : null;
  let lastRound = 0;
  let progressToolCalls = 0;

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
      memoryScopeSessionId,
      userId,
      userText,
      temperature: config.modelProfile.temperature,
      maxTokens: config.modelProfile.maxTokens,
      timeout: config.modelProfile.timeoutMs,
      policy,
      isClientGone: signal
        ? () => signal.aborted || Boolean(sideEffectGuard && sideEffectGuard.blocked())
        : sideEffectGuard
          ? () => sideEffectGuard.blocked()
          : undefined,
      abortSignal: signal,
      credentialKey,
      toolAuthorizer,
      onToolDenied,
      failOpen,
      sideEffect: sideEffectGuard,
      stream,
      onDelta,
      onRequest: ({ round }) => {
        lastRound = round;
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
        if (typeof onProgress === 'function') {
          onProgress({ round, toolCalls: progressToolCalls, phase: 'model_requested' });
        }
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
        progressToolCalls += 1;
        extractEvidence(result.name, result.result, evidence, changes);
        collectArtifacts(result.name, result.result, artifactInputs);
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
        if (typeof onProgress === 'function') {
          onProgress({
            round: lastRound,
            toolCalls: progressToolCalls,
            phase: 'tool_result',
          });
        }
      },
    });
  } catch (error) {
    if (signal && signal.aborted) {
      throw new AgentError('cancelled', '运行已取消', 409);
    }
    const info = classifyError(error);
    // classifyError 返回 { code, status, error }；S7 修复：此前误读 info.kind，
    // 导致所有模型错误都退化成 model_failed，重试白名单永不命中。
    const code =
      info.code === 'timeout' ? 'model_timeout' : `model_${info.code || 'failed'}`;
    safeEvent(
      botId,
      'model.failed',
      { errorCode: code, mode },
      { taskId, runId, sessionId }
    );
    throw new AgentError(code, info.message || '模型调用失败', info.status || 502);
  }

  // 副作用结果不确定优先于取消/超时：已经发生的写操作不能因为任务超时就当没发生。
  if (sideEffectGuard && sideEffectGuard.blocked()) {
    throw new AgentError(
      sideEffectGuard.status || 'side_effect_unknown',
      '副作用结果不确定，转入 recovery 等待人工核对',
      409
    );
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
    artifacts: artifactInputs,
    requiresConfirmation: changes.some(item => item.kind === 'memory.pending'),
    model: {
      providerId: config.modelProfile.providerId,
      modelId: config.modelProfile.modelId,
    },
    // B-06：供应商真实 usage（多轮累计）；缺失时为 null，绝不估算。
    usage: outcome.usage || null,
    runId,
  };
}

function requireText(value, label, max) {
  const text = typeof value === 'string' ? value.trim() : '';
  if (!text) throw new AgentError('invalid_message', `${label}不能为空`);
  if (text.length > max) throw new AgentError('invalid_message', `${label}过长`);
  return text;
}

function emptyReplyError(stopReason) {
  if (stopReason === 'tool_call_budget') {
    return new AgentError(
      'tool_call_budget',
      'Memory Bot 工具调用预算已用尽，未能生成总结',
      502
    );
  }
  return new AgentError('empty_reply', 'Memory Bot 没有返回内容', 502);
}

async function chat(botId, {
  sessionId = null,
  message,
  // 可信用户身份：直接对话没有父主控会话，但仍要按用户级读长期记忆。
  userId = null,
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
    userId,
    userText: text,
    mode: 'direct_chat',
    signal,
    onToolEvent,
    stream,
    onDelta,
  });

  const reply = typeof result.rawReply === 'string' ? result.rawReply.trim() : '';
  if (!reply) {
    throw emptyReplyError(result.stopReason);
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

// S6 / v1.3 §32.1：审批等待期间只有“资源期限耗尽”能收敛 Task，
// 审批记录保持 pending；deadlineExceeded 是唯一触发源。
// 有副作用工具时结果未知 → recovery；否则 → timed_out。
// S6b：状态收敛统一由 tasks.convergeWaitingApprovalDeadline 完成（与重启恢复同一实现），
// 这里只补 run history、租约、结果投递与事件。
function finalizeWaitingApprovalExpiry(task, outcome) {
  const { status, errorCode, result, finishedAt, runId } = outcome;
  tasks.recordRunFinish(task.taskId, {
    runId,
    status,
    errorCode,
    finishedAt,
    usage: (result && result.usage) || null,
  });
  tasks.releaseLease(task.taskId);
  resultDelivery.deliverTaskOutcome(task.taskId, { status, result, errorCode });
  safeEvent(
    task.botId,
    status === 'recovery' ? 'task.uncertain' : 'task.timed_out',
    { status, errorCode, phase: 'waiting_approval' },
    { taskId: task.taskId, runId, sessionId: task.sessionId }
  );
}

function convergeExpiredWaitingApproval(task, runId) {
  const outcome = tasks.convergeWaitingApprovalDeadline(task.taskId);
  if (!outcome) return;
  finalizeWaitingApprovalExpiry(task, { ...outcome, runId: runId || outcome.runId });
}

// S6b：计时器到期回调。任务已离开 waiting_approval 时直接跳过，避免误收敛。
function handleWaitingApprovalExpiry(taskId) {
  const task = tasks.getRawTask(taskId);
  if (!task || task.status !== 'waiting_approval') return;
  convergeExpiredWaitingApproval(task, task.runId || null);
}

approvalDeadline.setExpireHandler(handleWaitingApprovalExpiry);

async function runTask(taskId) {
  const task = tasks.getRawTask(taskId);
  if (!task) return;
  // waiting_approval 是暂停态，不是终态；由 approvals.execute/reject 收尾。
  if (tasks.isTerminalStatus(task.status) || task.status === 'waiting_approval') return;
  // Phase 1 交付物 2：依赖未就绪不在执行侧启动。
  // 判定复用 dependencies.isReady（与 tasks.nextQueuedTask 是同一实现），
  // 这里只是防「取队后依赖态变化」的二次确认，未就绪立即回队列。
  if (!dependencies.isReady(task, tasks.rawTasksById())) return;

  const controller = new AbortController();
  activeRuns.set(task.taskId, controller);
  const runId = `run_${crypto.randomUUID()}`;
  let deadlineExceeded = false;
  let leaseLost = false;
  let deadlineTimer = null;
  let heartbeatTimer = null;

  const recordCheckpoint = ({ round = 0, toolCalls = 0, phase = 'progress' } = {}) => {
    const checkpoint = {
      round: Number.isInteger(round) ? round : 0,
      toolCalls: Number.isInteger(toolCalls) ? toolCalls : 0,
      phase: String(phase || 'progress').slice(0, 40),
      at: nowIso(),
    };
    try {
      tasks.recordCheckpoint(task.taskId, checkpoint);
    } catch (_) {
      // checkpoint 落盘失败不中止执行；事件仍提供可追溯信号。
    }
    safeEvent(
      task.botId,
      'worker.checkpoint',
      {
        status: 'running',
        rounds: checkpoint.round,
        toolCalls: checkpoint.toolCalls,
        phase: checkpoint.phase,
      },
      { taskId: task.taskId, runId, sessionId: task.sessionId }
    );
  };

  // S7：retrying 任务退避到期后直接启动 attempt（retrying → running），
  // 不再经 queued/accepted 中转。
  const retryAttempt = task.status === 'retrying';

  // B-06：本次 attempt 的 Token 预留。reserve 在 execute 之前一次性占用剩余额度，
  // 结束后按真实 usage 结算并回冲差额；失败/取消/未拿到 usage 时释放。
  let reservation = null;
  const settleReservation = usage => {
    if (!reservation || reservation.settled) return;
    const total =
      usage && Number.isFinite(usage.total_tokens) && usage.total_tokens > 0
        ? Math.floor(usage.total_tokens)
        : 0;
    reservation.settled = true;
    tasks.settleTaskBudget(task.taskId, {
      reserved: reservation.amount,
      actual: total,
    });
  };
  const releaseReservation = () => {
    if (!reservation || reservation.settled) return;
    reservation.settled = true;
    try {
      tasks.releaseTaskBudget(task.taskId, { amount: reservation.amount });
    } catch (_) {
      // 释放失败由下一次 reserve 的账本校验兜底，不能影响任务终态。
    }
  };

  try {
    // ---- accept ----
    // 先拿租约：已有其他存活 Worker 持有时不执行；租约在手才进入 accepted。
    tasks.acquireLease(task.taskId, {
      ownerId: WORKER_OWNER_ID,
      ttlMs: LEASE_TTL_MS,
    });
    tasks.recordRunStart(task.taskId, {
      runId,
      attempt: (Number.isInteger(task.attempts) ? task.attempts : 0) + 1,
      startedAt: nowIso(),
    });
    if (retryAttempt) {
      // 重试启动前最后一次确认：期间被取消/已离开 retrying 则不再执行。
      const due = tasks.getRawTask(task.taskId);
      if (
        !due ||
        tasks.isTerminalStatus(due.status) ||
        due.status !== 'retrying' ||
        due.cancelRequested
      ) {
        return;
      }
    } else {
      tasks.transitionTask(task.taskId, {
        to: 'accepted',
        runId,
        runStartedAt: nowIso(),
        heartbeatAt: nowIso(),
        checkpoint: null,
      });
      safeEvent(
        task.botId,
        'task.accepted',
        { status: 'accepted', taskType: task.taskType },
        { taskId: task.taskId, runId, sessionId: task.sessionId }
      );

      const afterAccept = tasks.getRawTask(task.taskId);
      if (
        !afterAccept ||
        tasks.isTerminalStatus(afterAccept.status) ||
        afterAccept.status === 'waiting_approval' ||
        afterAccept.cancelRequested
      ) {
        return;
      }
    }

    // ---- Worker 会话：缺失时补建，归属检查 + 生命周期 ----
    let workerSessionId = task.sessionId;
    if (!workerSessionId) {
      const created = sessions.createSession(task.botId, {
        title: String(task.goal || '').slice(0, 30),
        scope: 'worker',
      });
      workerSessionId = created.id;
      tasks.updateTask(task.taskId, {
        workerSessionId,
        sessionId: workerSessionId,
      });
      task.workerSessionId = workerSessionId;
      task.sessionId = workerSessionId;
    }
    const workerSession = sessions.getSession(task.botId, workerSessionId);
    if (!workerSession) {
      throw new AgentError('worker_session_missing', 'Worker 会话不存在', 409);
    }
    // 归属检查：已在运行的 Worker 保留自己的会话；已终态任务的会话允许
    // 顺序复用，避免 API 调用方传回旧会话时永久不可用。
    let allowTakeover = false;
    if (workerSession.owner && workerSession.owner.taskId !== task.taskId) {
      const ownerTask = tasks.getTask(workerSession.owner.taskId);
      allowTakeover = Boolean(ownerTask && tasks.isTerminalStatus(ownerTask.status));
    }
    // 隔离边界：归属判定与 owner 绑定统一走 worker-scope（拒绝码仍是
    // worker_session_owner_mismatch），运行时不再手工 attachOwner。
    workerScope.openWorkerScope({
      botId: task.botId,
      taskId: task.taskId,
      sessionId: workerSessionId,
      runId,
      allowTakeover,
    });
    sessions.markRunning(task.botId, workerSessionId, runId);

    // ---- start ----
    const runningSince = Date.now();
    tasks.transitionTask(task.taskId, {
      to: 'running',
      startedAt: new Date(runningSince).toISOString(),
      retryAt: null,
    });
    // P5 注入点：任务已进入 running，回合还没开始。
    crashHook.hold('task.after-running');
    safeEvent(
      task.botId,
      'task.started',
      { status: 'running', taskType: task.taskType },
      { taskId: task.taskId, runId, sessionId: task.sessionId }
    );

    heartbeatTimer = setInterval(() => {
      try {
        tasks.renewLease(task.taskId, {
          ownerId: WORKER_OWNER_ID,
          ttlMs: LEASE_TTL_MS,
        });
        tasks.updateTask(task.taskId, { heartbeatAt: nowIso() });
      } catch (error) {
        if (error && error.code === 'task_lease_lost') {
          leaseLost = true;
          if (heartbeatTimer) clearInterval(heartbeatTimer);
          heartbeatTimer = null;
          controller.abort();
          return;
        }
        // 其他心跳写入失败只影响可观测性，不中止执行。
      }
      safeEvent(
        task.botId,
        'worker.heartbeat',
        { status: 'running' },
        { taskId: task.taskId, runId, sessionId: task.sessionId }
      );
    }, HEARTBEAT_MS);
    if (typeof heartbeatTimer.unref === 'function') heartbeatTimer.unref();

    // deadlineMs 此前只被存储与校验，运行时不执行，任务可以无限跑。
    // 这里在任务真正开始执行时起算截止时间：到期中止本次运行，
    // 并把任务收敛成 timed_out（而不是被误判成用户取消）。
    const deadlineMs =
      Number.isInteger(task.deadlineMs) && task.deadlineMs > 0 ? task.deadlineMs : null;
    if (deadlineMs) {
      const remaining = Math.max(0, deadlineMs - (Date.now() - runningSince));
      deadlineTimer = setTimeout(() => {
        deadlineExceeded = true;
        controller.abort();
      }, remaining);
      if (typeof deadlineTimer.unref === 'function') deadlineTimer.unref();
    }

    // ---- execute：只投影任务所需的摘要/引用/授权数据 ----
    const config = require('./config').getRuntimeConfig(task.botId);
    const projection = projectWorkerContext({
      task,
      systemPrompt: config.prompt.systemPrompt,
    });
    const authorizer = createToolAuthorizer({ allowedTools: task.allowedTools });
    recordCheckpoint({ round: 0, toolCalls: 0, phase: 'started' });

    // B-06：执行前原子预留。按 Task 剩余上限全额预留（预估不精确，结算时回冲），
    // 无上限/额度耗尽一律 budget_exceeded 且 retryable=false。
    const budgetSnapshot = tasks.getTaskBudgetSnapshot(task.taskId);
    const budgetLimit = budgetSnapshot ? budgetSnapshot.limit : null;
    const budgetRemaining = budgetSnapshot ? budgetSnapshot.remaining : null;
    if (budgetLimit === null || budgetRemaining === null || budgetRemaining <= 0) {
      throw budgetExceededError({
        taskId: task.taskId,
        scope: 'task',
        required: 1,
        remaining: budgetRemaining === null ? 0 : Math.max(0, budgetRemaining),
        runId: task.budgetRunId || null,
        causeRef: budgetLimit === null ? 'budget_not_configured' : 'budget_exhausted',
      });
    }
    tasks.reserveTaskBudget(task.taskId, { amount: budgetRemaining });
    reservation = { amount: budgetRemaining, settled: false };

    const result = await execute({
      botId: task.botId,
      messages: projection.messages,
      sessionId: task.sessionId,
      // 委派任务：Bot 会话只承载执行轨迹，记忆读写归属父主控会话。
      memoryScopeSessionId: projection.memoryScopeSessionId,
      userId: projection.userId,
      // 写入接地优先使用主控用户原话；旧任务或直接任务才回落到 goal。
      userText: projection.userText,
      taskId: task.taskId,
      taskTools: task.allowedTools,
      runId,
      // 路由层冻结的 Fast/Slow 预算随任务落库，执行时不再读当前配置。
      budget: task.budget || null,
      mode: 'delegated_task',
      signal: controller.signal,
      toolAuthorizer: authorizer,
      // 作用域取自任务记录（planId/planVersion 是创建时冻结的），
      // 老任务缺这两个字段时如实传 null——判定侧会拒绝而不是当成"无计划继续跑"。
      failOpen: {
        taskId: task.taskId,
        runId,
        planId: task.planId || null,
        planVersion: task.planVersion === undefined ? null : task.planVersion,
        targetScope: `task:${task.taskId}`,
        subject: projection.userId || null,
        environment: process.env.BLUEBIRD_ENV || 'dev',
        resource: `bot:${task.botId}`,
        operation: 'execute',
      },
      onToolDenied: ({ name, code }) => {
        safeEvent(
          task.botId,
          'tool.denied',
          { tool: name, errorCode: code, mode: 'delegated_task' },
          { taskId: task.taskId, runId, sessionId: task.sessionId }
        );
      },
      onProgress: recordCheckpoint,
    });

    // B-06：结算本次预留。真实 usage 缺失时按 0 结算（相当于全额回冲），
    // 不拿字符数估算冒充 token；该限制已在用例注释中如实标注。
    settleReservation(result && result.usage);

    const latest = tasks.getRawTask(task.taskId);
    if (!latest || tasks.isTerminalStatus(latest.status) || latest.cancelRequested) {
      return;
    }
    if (latest.status === 'waiting_approval') {
      // 审批在模型执行期间创建：保留等待态，不覆盖为 completed。
      // 但若资源期限已耗尽，按不变量只收敛 Task，审批记录保持 pending。
      if (deadlineExceeded) convergeExpiredWaitingApproval(latest, runId);
      return;
    }

    const summary = typeof result.rawReply === 'string' ? result.rawReply.trim() : '';
    if (!summary) {
      throw emptyReplyError(result.stopReason);
    }

    // ③ §11 第 1 步：先把产物落盘并拿到 artifactRef（含 version），
    // 再在第 2/3 步把引用与状态一起提交。落盘失败会抛 artifact_*，由 catch 转 retry/recovery。
    // 产物来源：工具产出的持久对象（如记忆写入）+ 本次最终回复本身（message）。
    const produced = Array.isArray(result.artifacts) ? result.artifacts.slice() : [];
    produced.push({ kind: 'message', content: { text: summary } });
    const artifactRefs = artifactCommit.persistTaskArtifacts({
      taskId: task.taskId,
      runId: result.runId || runId,
      artifacts: produced,
    });

    const finalResult = normalizeWorkerResult({
      status: 'completed',
      summary,
      artifacts: artifactRefs,
      toolSteps: result.toolSteps,
      evidence: result.evidence,
      changes: result.changes,
      requiresConfirmation: result.requiresConfirmation === true,
      rounds: result.rounds,
      stopReason: result.stopReason,
      model: result.model,
      runId: result.runId || runId,
      finishedAt: nowIso(),
    });

    // Phase 3 第 1 项：进入 completed 前先过确定性验证（不依赖模型的机械校验）。
    // 校验失败不得进入 completed；错误码直接落到任务 errorCode。
    const verification = verificationLoop.verifyDeterministic({
      taskId: task.taskId,
      result: finalResult,
    });

    const current = tasks.getRawTask(task.taskId);
    if (!current) return;

    const primary = verificationLoop.primaryArtifactRef(finalResult);
    let review = null;
    if (current.requiresReview === true) {
      // 独立审校：必须是一个独立任务（不同 taskId + 独立 worker 作用域），
      // 由既有 orchestrator 路由到 reviewer；绝不在本任务内自查自批。
      if (!primary) {
        review = {
          decision: 'needs_human',
          valid: false,
          code: 'review_artifact_missing',
          evidence: [],
          reviewTaskId: null,
        };
      } else {
        let opened = null;
        try {
          opened = verificationLoop.openReview({
            producerTaskId: task.taskId,
            artifactRef: primary,
            runId,
          });
        } catch (error) {
          // 无法建立独立审校：按"审校不可用"保守处理，绝不当作通过。
          safeEvent(
            task.botId,
            'verification.verdict',
            {
              verdict: 'needs_human',
              producerTaskId: task.taskId,
              deterministicOk: verification.ok,
              errorCode: (error && error.code) || 'verification_review_unavailable',
              mode: 'review',
            },
            { taskId: task.taskId, runId, sessionId: task.sessionId }
          );
          review = {
            decision: 'needs_human',
            valid: false,
            code: 'review_unavailable',
            evidence: [],
            reviewTaskId: null,
          };
        }
        if (opened) {
          // 审校任务由 orchestrator → router 创建时已入队，这里只等待其终态，
          // 不重复执行（避免与队列调度并发跑同一任务）。
          review = verificationLoop.parseVerdict(
            await waitForReviewTask(opened.reviewTaskId, REVIEW_WAIT_MS)
          );
        }
      }

      // 审校期间任务可能已取消/被审批冻结/超时收敛：以当前状态为准。
      const afterReview = tasks.getRawTask(task.taskId);
      if (
        deadlineExceeded ||
        !afterReview ||
        tasks.isTerminalStatus(afterReview.status) ||
        afterReview.cancelRequested ||
        afterReview.status === 'waiting_approval'
      ) {
        return;
      }

      const resolution = verificationLoop.planGate({
        deterministic: verification,
        review,
        task: afterReview,
      });
      verificationLoop.auditResolution({
        producerTask: afterReview,
        deterministic: verification,
        review,
        resolution,
        runId,
      });

      if (resolution.action === 'approval') {
        // 冲突 / 高风险审校不通过 / 审校无法给出结论：默认保守（不通过 + 标 conflict），
        // 停在审批节点等人工；审批超时只标 overdue，绝不解释为通过。
        // §28：冲突先落 ConflictRecord，再进入人工审批，保证裁决前就有可复读的记录。
        if (resolution.outcome === 'conflict') {
          conflictRecord.persist(
            conflictRecord.createRecord({
              subjectKey: `${afterReview.taskId}:${primary && primary.id ? primary.id : 'verification'}`,
              candidateRefs: primary && primary.id ? [String(primary.id)] : [],
              conflictType: 'factual',
              evidenceRefs: [
                `deterministic:${verification.errorCode || 'pass'}`,
                `review:${review && review.decision ? review.decision : 'needs_human'}`,
              ],
              resolutionStatus: 'open',
              rationale: resolution.errorCode || 'verification_conflict',
              taskId: afterReview.taskId,
              runId,
            })
          );
        }
        verificationLoop.invalidateArtifactRefs(finalResult, {
          reason: resolution.errorCode || 'verification_conflict',
        });
        verificationLoop.requestHumanApproval({
          producerTask: afterReview,
          artifactRef: primary,
          resolution,
          deterministic: verification,
          review,
          runId,
        });
        return;
      }
      if (resolution.action === 'reject') {
        verificationLoop.invalidateArtifactRefs(finalResult, {
          reason: resolution.errorCode || 'review_rejected',
        });
        safeEvent(
          task.botId,
          'verification.rejected',
          {
            status: 'failed',
            errorCode: resolution.errorCode,
            checkCode: verification.errorCode || '',
            deterministicOk: verification.ok,
            verdict: review && review.decision ? review.decision : 'needs_human',
            mode: 'verification',
          },
          { taskId: task.taskId, runId, sessionId: task.sessionId }
        );
        throw new AgentError(
          resolution.errorCode || 'review_rejected',
          '独立审校与机械校验一致判定不通过',
          409
        );
      }
      // action === complete：两边一致通过，继续进入 completed。
    } else if (!verification.ok) {
      verificationLoop.invalidateArtifactRefs(finalResult, {
        reason: verification.errorCode,
      });
      safeEvent(
        task.botId,
        'verification.rejected',
        {
          status: 'failed',
          errorCode: verification.errorCode,
          checkCode: verification.errorCode,
          deterministicOk: false,
          mode: 'verification',
        },
        { taskId: task.taskId, runId, sessionId: task.sessionId }
      );
      throw new AgentError(
        verification.errorCode || verificationLoop.VERIFY_CODES.structure,
        '确定性验证未通过，不得进入 completed',
        409
      );
    }

    // §11 第 2/3 步：进入 completed 前，任务记录已持有产物引用；校验门禁在
    // transitionTask 内执行，状态与 result 同一次落盘（stateVersion 同一次 +1）。
    artifactCommit.completeTask(task.taskId, {
      completedAt: finalResult.finishedAt,
      result: finalResult,
    });
    tasks.recordRunFinish(task.taskId, {
      runId,
      status: 'completed',
      finishedAt: finalResult.finishedAt,
      usage: finalResult.usage || null,
    });
    tasks.releaseLease(task.taskId);
    safeEvent(
      task.botId,
      'task.completed',
      {
        status: 'completed',
        rounds: result.rounds,
        toolCalls: result.toolSteps.length,
        stopReason: result.stopReason || null,
      },
      { taskId: task.taskId, runId, sessionId: task.sessionId }
    );
    resultDelivery.deliverTaskOutcome(task, {
      status: 'completed',
      result: finalResult,
    });
  } catch (error) {
    const latest = tasks.getRawTask(task.taskId);
    if (!latest || tasks.isTerminalStatus(latest.status)) return;
    if (latest.status === 'waiting_approval') {
      // 同上：只有 deadline 触发的收敛，审批 SLA/取消都不改写 Task 终态。
      if (deadlineExceeded) convergeExpiredWaitingApproval(latest, runId);
      return;
    }

    // 租约已被其他 Worker 持有：本实例不执行，稍后再试，不改变任务状态。
    if (error && error.code === 'task_lease_held') {
      try {
        tasks.updateTask(task.taskId, {
          retryAt: new Date(Date.now() + 2000).toISOString(),
        });
      } catch (_) {
        // 状态竞争不影响结论。
      }
      safeEvent(
        task.botId,
        'task.recovered',
        { status: latest.status, errorCode: 'task_lease_held', mode: 'retry' },
        { taskId: task.taskId, sessionId: task.sessionId }
      );
      return;
    }

    // 心跳续租失败：租约丢失后必须停止执行，不能继续写入结果。
    if (leaseLost) {
      const lostResult = normalizeWorkerResult({
        status: 'failed',
        summary: '',
        errorCode: 'task_lease_lost',
        runId,
        finishedAt: nowIso(),
      });
      tasks.transitionTask(task.taskId, {
        to: 'failed',
        completedAt: lostResult.finishedAt,
        errorCode: 'task_lease_lost',
        result: lostResult,
      });
      tasks.recordRunFinish(task.taskId, {
        runId,
        status: 'failed',
        errorCode: 'task_lease_lost',
        finishedAt: lostResult.finishedAt,
      });
      resultDelivery.deliverTaskOutcome(task.taskId, {
        status: 'failed',
        result: lostResult,
        errorCode: 'task_lease_lost',
      });
      safeEvent(
        task.botId,
        'task.failed',
        { status: 'failed', errorCode: 'task_lease_lost' },
        { taskId: task.taskId, runId, sessionId: task.sessionId }
      );
      return;
    }

    // 截止时间到期的中止在 execute() 里会被归一成 cancelled（信号已断），
    // 这里必须先认出来：它是超时，不是用户取消，且不可重试。
    const cancelled =
      !deadlineExceeded &&
      (latest.cancelRequested || (error && error.code === 'cancelled'));
    const timedOut = deadlineExceeded || (error && error.code === 'model_timeout');
    const errorCode = deadlineExceeded
      ? 'deadline_exceeded'
      : (error && error.code) || (timedOut ? 'model_timeout' : 'agent_failed');
    const attempts = Number.isInteger(latest.attempts) ? latest.attempts : 0;
    const maxAttempts = Number.isInteger(latest.maxAttempts) ? latest.maxAttempts : 1;
    // ③ §11 第 4 步：产物写失败绝不允许 completed。无副作用工具的任务按 retry 退避，
    // 有副作用（已写记忆等）时不能重跑，收口为 recovery 等人工核对。
    const artifactFailure =
      typeof errorCode === 'string' && errorCode.startsWith('artifact_');
    // P2：副作用结果不确定（账本里 started/unknown，或账本不可用而阻止执行）。
    // 既不能重试（可能已经写过），也不能当 failed（可能已经成功）→ recovery 人工核对。
    const sideEffectFailure =
      typeof errorCode === 'string' && errorCode.startsWith('side_effect_');
    const retryable =
      !cancelled &&
      !sideEffectFailure &&
      !latest.allowedTools.includes('memory_remember') &&
      (artifactFailure || ['model_connection', 'model_rate_limit', 'model_timeout'].includes(errorCode)) &&
      attempts < maxAttempts;

    if (retryable) {
      tasks.recordRunFinish(task.taskId, {
        runId,
        status: 'retry',
        errorCode,
        finishedAt: nowIso(),
      });
      const retried = tasks.setRetry(task.taskId, { errorCode });
      safeEvent(
        task.botId,
        'task.recovered',
        {
          status: retried.status,
          errorCode,
          mode: 'retry',
          attempts: retried.attempts,
          ...(retried.retryAt ? { retryAt: retried.retryAt } : {}),
        },
        { taskId: task.taskId, sessionId: task.sessionId }
      );
      return;
    }

    const status = cancelled
      ? 'cancelled'
      : sideEffectFailure
        ? 'recovery'
        : timedOut
          ? 'timed_out'
          : artifactFailure
            ? 'recovery'
            : 'failed';
    // 统一结果 schema：失败/取消/超时也落一份结果，而不是 result: null。
    const failureResult = normalizeWorkerResult({
      status,
      summary: '',
      errorCode,
      runId,
      finishedAt: nowIso(),
    });
    tasks.transitionTask(task.taskId, {
      to: status,
      completedAt: failureResult.finishedAt,
      errorCode,
      result: failureResult,
    });
    tasks.recordRunFinish(task.taskId, {
      runId,
      status,
      errorCode,
      finishedAt: failureResult.finishedAt,
    });
    // 死信：连续失败已达上限 → 在既有 failed 终态上打标记（不新增状态）。
    // 只有真正重试耗尽才算死信；取消/超时/结果不确定（recovery）不走这里。
    if (status === 'failed' && attempts >= maxAttempts) {
      try {
        deadLetter.mark(task.taskId, { errorCode, attempts, maxAttempts });
      } catch (_) {
        // 死信标记失败不反转任务终态；下次启动可补标。
      }
    }
    tasks.releaseLease(task.taskId);
    resultDelivery.deliverTaskOutcome(task.taskId, {
      status,
      result: failureResult,
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
      { taskId: task.taskId, runId, sessionId: task.sessionId }
    );
  } finally {
    if (deadlineTimer) clearTimeout(deadlineTimer);
    if (heartbeatTimer) clearInterval(heartbeatTimer);
    activeRuns.delete(task.taskId);
    // B-06：未经 settle 的预留必须释放（失败/取消/提前返回/抛错的所有路径）。
    releaseReservation();
    // 租约只在本次运行结束时释放；释放失败由过期机制兜底。
    try {
      const finalTask = tasks.getRawTask(task.taskId);
      if (finalTask && finalTask.lease) {
        tasks.releaseLease(task.taskId);
      }
    } catch (_) {
      // 忽略释放失败，避免影响任务终态。
    }
    // Worker 会话生命周期收口：状态由 Task 状态投影，未知值在投影函数内记日志后回退 closed。
    try {
      const finalTask = tasks.getRawTask(task.taskId);
      sessions.closeSession(task.botId, task.sessionId, {
        status: sessions.deriveLifecycleStatus(finalTask ? finalTask.status : null),
        reason: finalTask ? finalTask.errorCode : null,
      });
    } catch (_) {
      // 会话收口失败不影响任务终态。
    }
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

// 计划解析失败的三种码（与 Workflow Store 抛出的错误一一对应）。
const PLAN_FAILURE_CODES = new Set([
  'plan_missing',
  'plan_version_mismatch',
  'plan_corrupt',
  'plan_store_corrupted',
  'plan_unavailable',
]);

/**
 * 启动时按 (planId, planVersion) 解析每个已绑定任务。
 *
 * 收敛规则（fail-closed）：
 * - 计划中存在且 digest 自洽 → 照常调度，并补写 pin（上次可能死在 pin 之前）；
 * - 计划缺失 / 版本不符 / 内容损坏 → 任务一律 recovery + 对应 errorCode，不续跑；
 * - Store 文件整体损坏 → 所有绑定任务一律 recovery + plan_store_corrupted。
 *
 * 已终态任务不反转：状态机的终态没有出边，把 completed 改回 recovery 既非法也会
 * 改写历史结论。它们仍占用 pin（裁剪不会删），只计入 skippedTerminal。
 *
 * 与「任务文件损坏直接退出」的区别：任务文件是整个 Agent 子系统的事实源，
 * 读不出来就无法判断该投递/取消什么，只能退出；计划文件是附加层，损坏只影响
 * 引用它的任务，把它们收敛到 recovery 之后，其余任务仍可正常处理——
 * 服务继续启动是「把损坏局部化」，而不是「假装没有计划」。
 */
function convergeWorkflowPlans({ now = Date.now() } = {}) {
  const summary = {
    checked: 0,
    resolved: 0,
    failed: 0,
    failedTaskIds: [],
    errorCodes: {},
    skippedTerminal: 0,
    skippedUnbound: 0,
    storeCorrupted: false,
    pinned: 0,
  };
  const all = tasks.allTasks();
  const bound = all.filter(task => task && task.planId !== null && task.planId !== undefined);
  summary.skippedUnbound = all.length - bound.length;
  if (bound.length === 0) return summary;

  let storeError = null;
  try {
    workflowStore.read();
  } catch (error) {
    storeError = error;
  }

  if (storeError) {
    summary.storeCorrupted = true;
    for (const task of bound) {
      summary.checked += 1;
      if (tasks.isTerminalStatus(task.status)) {
        summary.skippedTerminal += 1;
        continue;
      }
      const result = tasks.forcePlanRecovery(task.taskId, {
        errorCode: 'plan_store_corrupted',
        now,
      });
      if (result.changed) {
        summary.failed += 1;
        summary.failedTaskIds.push(task.taskId);
        summary.errorCodes.plan_store_corrupted =
          (summary.errorCodes.plan_store_corrupted || 0) + 1;
        safeEvent(
          task.botId,
          'task.uncertain',
          { status: 'recovery', errorCode: 'plan_store_corrupted', phase: 'workflow_plan' },
          { taskId: task.taskId }
        );
      }
    }
    return summary;
  }

  for (const task of bound) {
    summary.checked += 1;
    let errorCode = null;
    try {
      if (typeof task.planId !== 'string' || !Number.isInteger(task.planVersion)) {
        throw new AgentError('plan_version_mismatch', '任务计划指针不完整', 409);
      }
      workflowStore.getVersion(task.planId, task.planVersion);
    } catch (error) {
      errorCode = PLAN_FAILURE_CODES.has(error && error.code) ? error.code : 'plan_corrupt';
    }

    if (errorCode === null) {
      summary.resolved += 1;
      try {
        workflowStore.pinRef({
          taskId: task.taskId,
          planId: task.planId,
          planVersion: task.planVersion,
          now,
        });
        summary.pinned += 1;
      } catch (_) {
        // 补写 pin 失败只影响裁剪保护；任务文件里的指针仍可解析。
      }
      continue;
    }

    if (tasks.isTerminalStatus(task.status)) {
      summary.skippedTerminal += 1;
      continue;
    }
    const result = tasks.forcePlanRecovery(task.taskId, { errorCode, now });
    if (result.changed) {
      summary.failed += 1;
      summary.failedTaskIds.push(task.taskId);
      summary.errorCodes[errorCode] = (summary.errorCodes[errorCode] || 0) + 1;
      safeEvent(
        task.botId,
        'task.uncertain',
        { status: 'recovery', errorCode, phase: 'workflow_plan' },
        { taskId: task.taskId }
      );
    }
  }
  return summary;
}

// 进程内唯一调度器：initializeTaskQueue 可能被多次调用（测试、热重启路径），
// start() 幂等，不会叠加定时器。
let orphanScheduler = null;

function ensureOrphanScheduler() {
  if (!orphanScheduler) orphanScheduler = createCleanupScheduler();
  return orphanScheduler;
}

function initializeTaskQueue() {
  try {
    tasks.flushEventOutbox();
  } catch (_) {
    // 事件主文件不可写时 outbox 仍在磁盘，下一次读取会继续重试。
  }
  // 计划解析必须早于中断恢复：计划不可用是更上游的失败原因，先把这些任务
  // fail-closed 掉，再让 recoverInterrupted 处理剩下的中间态任务。
  let planSummary = null;
  try {
    planSummary = convergeWorkflowPlans();
  } catch (_) {
    planSummary = null;
  }
  // 单进程部署：启动时不存在仍存活的其他 Worker，旧租约一律视为过期。
  // 多 Worker 场景由调用方传入存活 owner 集合，未过期的租约保持 running。
  const recovered = tasks.recoverInterrupted({ ownerId: null });
  // P5：启动即封账——上次崩溃留下的 started 全部转 unknown，绝不留给下一次调用复用。
  let sealedOps = [];
  try {
    sealedOps = opLedger.sealStarted();
  } catch (_) {
    sealedOps = [];
  }
  for (const taskId of recovered.taskIds || []) {
    const task = tasks.getRawTask(taskId);
    if (!task) continue;
    safeEvent(
      task.botId,
      'task.recovered',
      { status: task.status, mode: 'queue_recovery' },
      { taskId }
    );
  }
  for (const taskId of recovered.recoveryTaskIds || []) {
    const task = tasks.getRawTask(taskId);
    if (!task) continue;
    // 事件类型名与 errorCode 沿用历史拼写，保持事件/审计字段集合不变；
    // payload.status 自 S5 起反映正式状态 recovery。
    safeEvent(
      task.botId,
      'task.uncertain',
      { status: 'recovery', errorCode: 'recovery_uncertain_side_effects' },
      { taskId }
    );
  }
  for (const taskId of recovered.expiredWaitingApproval || []) {
    const task = tasks.getRawTask(taskId);
    if (!task) continue;
    // S6b：重启时已过期的审批等待任务，按与活计时器同一规则收敛后补事件。
    safeEvent(
      task.botId,
      task.status === 'recovery' ? 'task.uncertain' : 'task.timed_out',
      {
        status: task.status,
        errorCode: task.errorCode,
        phase: 'waiting_approval',
      },
      { taskId, runId: task.runId || null, sessionId: task.sessionId }
    );
  }
  try {
    // 恢复后再补投递：终态（含 recovery）且未投递的结果会在这里补发一次。
    resultDelivery.recoverPending();
  } catch (_) {
    // 结果投递恢复失败不阻塞任务队列；下次 SSE/snapshot 或启动再试。
  }
  // ③ §11 第 5 步（恢复侧）：产物已写但状态提交失败时，启动扫描重新关联同一产物；
  // 无引用且超过 §38 TTL 的才标记 orphan。扫描失败不影响任务队列启动。
  let artifactScan = null;
  try {
    artifactScan = artifactCommit.scanPendingCommits();
  } catch (_) {
    artifactScan = null;
  }
  // 收口 B：孤儿清理挂生产节奏——启动跑一次 + 周期跑（默认 6 小时，A 类）。
  // 单实例防重入；失败只记账不崩服务；进程崩溃后不补跑漏掉的周期。
  let orphanCleanup = null;
  try {
    orphanCleanup = ensureOrphanScheduler().start({ now: Date.now() });
  } catch (_) {
    orphanCleanup = null;
  }
  scheduleTaskQueue();
  return {
    recovered: recovered.recovered,
    recovery: recovered.recovery,
    leftRunning: recovered.leftRunning,
    queued: tasks.queuedCount(),
    concurrency: TASK_CONCURRENCY,
    sealedOps: sealedOps.length,
    plans: planSummary,
    artifactScan: artifactScan
      ? {
          scanned: artifactScan.scanned,
          reconciled: artifactScan.reconciled.length,
          orphaned: artifactScan.orphaned.length,
          pending: artifactScan.pending.length,
        }
      : null,
    orphanCleanup: orphanCleanup ? orphanCleanup.stats : null,
  };
}

function getQueueStats() {
  return {
    concurrency: TASK_CONCURRENCY,
    active: activeRuns.size,
    queued: tasks.queuedCount(),
    health: tasks.healthSnapshot(),
  };
}

function cancelTask(taskId) {
  const task = tasks.getTask(taskId);
  if (!task) throw new AgentError('task_not_found', '任务不存在', 404);
  if (tasks.isTerminalStatus(task.status)) return task;
  const finishedAt = nowIso();
  const result = normalizeWorkerResult({
    status: 'cancelled',
    summary: '',
    errorCode: 'cancelled',
    runId: task.runId || null,
    finishedAt,
  });
  tasks.transitionTask(taskId, {
    to: 'cancelled',
    cancelRequested: true,
    completedAt: finishedAt,
    errorCode: 'cancelled',
    result,
  });
  const controller = activeRuns.get(taskId);
  if (controller) controller.abort();
  resultDelivery.deliverTaskOutcome(taskId, {
    status: 'cancelled',
    result,
    errorCode: 'cancelled',
  });
  safeEvent(task.botId, 'task.cancelled', { status: 'cancelled' }, { taskId });
  try {
    sessions.closeSession(task.botId, task.sessionId, {
      status: sessions.deriveLifecycleStatus('cancelled'),
      reason: 'cancelled',
    });
  } catch (_) {
    // 会话收口失败不影响取消结果。
  }
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
  convergeWorkflowPlans,
  getQueueStats,
  allowedToolsFor,
  buildPolicy,
};
