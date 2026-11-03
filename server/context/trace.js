/**
 * 云岫 Bluebird — Context Runtime v3 结构化 trace（trace.js）
 *
 * 必须能证明上下文每个阶段实际发生了什么：
 *   candidate → selected → accepted → injected → sent；consumed 仅在有可靠
 *   消费证据时才可记录，本系统不采集该证据，因此固定为 null 并注明。
 *
 * 隐私：只记录稳定标识、数量、长度、来源、阶段、原因、计量与模型标识；
 * 绝不记录用户任务原文、历史正文、记忆正文、工具参数或工具结果正文。
 */
const { textLength, truncateText, estimateTokens } = require('../text-utils');
const { modelMessageId } = require('./projection');
const crypto = require('crypto');

const SENSITIVE_PATTERN =
  /(密码|口令|私钥|助记词|验证码|信用卡|银行卡|身份证|手机号|cvv|api[\s_-]?key|secret|bearer|token\s*[:=]|sk-[a-zA-Z0-9_-]{8,}|(?:\d[\s-]?){11,})/i;

function maskSensitive(text) {
  if (typeof text !== 'string' || !text) return text;
  return SENSITIVE_PATTERN.test(text) ? '[REDACTED]' : text;
}

const TRACE_TEXT_MAX = 80;

function sanitizeText(value) {
  const truncated = truncateText(typeof value === 'string' ? value : '', TRACE_TEXT_MAX);
  return maskSensitive(truncated);
}

function sanitizeId(value) {
  return typeof value === 'string' && value.length <= 120 ? value : null;
}

function sanitizeTimestamp(value) {
  return typeof value === 'string' &&
    value.length <= 40 &&
    Number.isFinite(Date.parse(value))
    ? value
    : null;
}

function sanitizeReason(value) {
  return sanitizeText(value);
}

// 发送内容的稳定指纹：只序列化 role / content / tool_calls 三个字段后取 sha256。
// 用途是核对「Trace 里这一轮 == 真正发给 Provider 的那一份」，
// 不把正文写进 trace，也不需要保存原始请求体。
function hashMessages(list) {
  try {
    const canonical = list.map(message => ({
      role: (message && message.role) || null,
      content:
        message && typeof message.content === 'string' ? message.content : null,
      ...(message && message.tool_calls ? { tool_calls: message.tool_calls } : {}),
    }));
    return crypto
      .createHash('sha256')
      .update(JSON.stringify(canonical))
      .digest('hex');
  } catch (_) {
    return null;
  }
}

// 与 input-guard 的估算口径一致：文本 token + 每条消息固定开销。
// 这是估算值，不能当作 Provider 的 prompt_tokens。
const MESSAGE_OVERHEAD_TOKENS = 4;

function estimateMessagesTokens(list) {
  let total = 0;
  for (const message of list) {
    const text = message && typeof message.content === 'string' ? message.content : '';
    total += estimateTokens(text) + MESSAGE_OVERHEAD_TOKENS;
  }
  return total;
}

function createTrace({ task, sessionId, ts, requestId } = {}) {
  const trace = {
    ts: ts || new Date().toISOString(),
    taskLength: textLength(typeof task === 'string' ? task : ''),
    sessionId: typeof sessionId === 'string' ? sessionId : null,
    requestId: sanitizeId(requestId),
    history: {
      totalMessages: 0,
      recent: 0,
      recalled: 0,
      summarized: 0,
      omitted: 0,
      tokens: { recent: 0, recalled: 0, summaryInputMessages: 0 },
      decisions: [],
      summary: { count: 0, sources: [], conflicts: [], warning: null },
    },
    retrieval: {
      source: 'memory',
      status: null,
      candidates: 0,
      returned: 0,
      accepted: 0,
      scopeMode: null,
      funnel: null,
      excluded: null,
      visibilityReasons: null,
      skipped: [],
      conflicts: [],
      error: null,
    },
    knowledge: {
      status: null,
      candidates: 0,
      accepted: 0,
      skipped: [],
      error: null,
      degraded: [],
      trace: null,
    },
    build: {
      ok: null,
      error: null,
      blocks: [],
      contextIds: [],
      dropped: [],
      measurement: null,
    },
    orchestration: {
      enabled: null,
      intent: null,
      layers: null,
      budgets: null,
      noAnswerThreshold: null,
      reasons: [],
    },
    tools: [],
    verification: { ok: null, reason: null, checks: [] },
    stages: {
      candidate: 0,
      selected: 0,
      accepted: 0,
      injected: 0,
      sent: 0,
    },
    sent: {
      rounds: [],
      usage: [],
      consumed: null,
      consumedNote: '未采集模型实际消费证据；HTTP 成功不等于模型已消费',
    },
  };

  return {
    recordOrchestration(plan) {
      if (!plan) return;

      trace.orchestration = {
        enabled: plan.enabled !== false,
        intent: plan.intent ? sanitizeId(plan.intent) : null,
        layers: plan.layers
          ? {
              history: plan.layers.history === true,
              summary: plan.layers.summary === true,
              memory: plan.layers.memory === true,
              knowledge: plan.layers.knowledge === true,
              memoryTypes: Array.isArray(plan.layers.memoryTypes)
                ? plan.layers.memoryTypes.map(sanitizeId)
                : null,
              memoryCategories: Array.isArray(plan.layers.memoryCategories)
                ? plan.layers.memoryCategories.map(sanitizeId)
                : null,
              episodicOnly: plan.layers.episodicOnly === true,
              knowledgeSources: Array.isArray(plan.layers.knowledgeSources)
                ? plan.layers.knowledgeSources.map(sanitizeId)
                : null,
            }
          : null,
        budgets: plan.budgets
          ? {
              history: plan.budgets.history || {},
              retrieval: plan.budgets.retrieval || {},
              knowledge: plan.budgets.knowledge || {},
            }
          : null,
        noAnswerThreshold: Number.isFinite(plan.noAnswerThreshold)
          ? plan.noAnswerThreshold
          : null,
        reasons: Array.isArray(plan.reasons)
          ? plan.reasons.slice(0, 20).map(sanitizeId)
          : [],
      };
    },

    recordHistory(selection, summary) {
      const decisions = Array.isArray(selection.decisions) ? selection.decisions : [];
      const count = stage => decisions.filter(item => item.stage === stage).length;

      trace.history.totalMessages = selection.tokens.totalMessages || 0;
      trace.history.recent = selection.recent.length;
      trace.history.recalled = selection.recalled.length;
      trace.history.summarized = count('summarized');
      trace.history.omitted = count('omitted');
      trace.history.tokens = selection.tokens;
      trace.history.decisions = decisions.slice(0, 200).map(item => ({
        messageId: sanitizeId(item.messageId),
        index: Number.isInteger(item.index) ? item.index : null,
        stage: item.stage,
        reason: sanitizeReason(item.reason),
        ...(Number.isFinite(item.score) ? { score: item.score } : {}),
      }));

      if (summary) {
        trace.history.summary = {
          count: summary.count || 0,
          sources: (summary.sources || []).map(source => ({
            ref: sanitizeId(source.ref),
            messageId: sanitizeId(source.messageId),
            role: source.role,
            section: source.section,
            createdAt: sanitizeTimestamp(source.createdAt),
          })),
          conflicts: (summary.conflicts || []).map(conflict => ({
            section: conflict.section,
            refs: conflict.refs,
            reason: conflict.reason,
          })),
          warning: summary.error ? sanitizeText(summary.error) : null,
        };
      }

      trace.stages.candidate = selection.tokens.totalMessages || 0;
    },

    recordRetrieval(outcome, adjudication, diagnostics) {
      const funnel = diagnostics && diagnostics.funnel ? diagnostics.funnel : null;
      const excluded = diagnostics && diagnostics.excluded ? diagnostics.excluded : null;
      const reasons =
        diagnostics && diagnostics.visibilityReasons
          ? diagnostics.visibilityReasons
          : null;

      trace.retrieval = {
        source: 'memory',
        status: outcome.status || null,
        // candidates 是候选池大小（进入排序之前的可见记忆数），
        // returned 是本次实际返回条数；两者必须分开，不能互相冒充。
        candidates: funnel && Number.isFinite(funnel.candidates)
          ? funnel.candidates
          : outcome.count || 0,
        returned: funnel && Number.isFinite(funnel.returned)
          ? funnel.returned
          : outcome.count || 0,
        accepted: adjudication ? adjudication.accepted.length : 0,
        scopeMode: diagnostics ? diagnostics.scopeMode || null : null,
        funnel,
        excluded,
        visibilityReasons: reasons,
        skipped: adjudication
          ? adjudication.skipped.slice(0, 100).map(item => ({
              id: sanitizeId(item.id),
              source: item.source || null,
              stage: item.stage || 'accepted',
              reason: sanitizeReason(item.reason),
              ...(Number.isFinite(item.score) ? { score: item.score } : {}),
              ...(item.against ? { against: sanitizeId(item.against) } : {}),
            }))
          : [],
        conflicts: adjudication
          ? adjudication.conflicts.slice(0, 100).map(item => ({
              id: sanitizeId(item.id),
              source: item.source || null,
              reason: sanitizeReason(item.reason),
              against: sanitizeId(item.against),
            }))
          : [],
        error: outcome.error ? sanitizeText(outcome.error) : null,
      };
    },

    recordKnowledge(outcome, adjudication) {
      trace.knowledge = {
        status: outcome.status || null,
        candidates: outcome.count || 0,
        accepted: adjudication ? adjudication.accepted.length : 0,
        skipped: adjudication
          ? adjudication.skipped.slice(0, 100).map(item => ({
              id: sanitizeId(item.id),
              source: item.source || 'knowledge',
              stage: item.stage || 'accepted',
              reason: sanitizeReason(item.reason),
              ...(Number.isFinite(item.score) ? { score: item.score } : {}),
              ...(item.against ? { against: sanitizeId(item.against) } : {}),
            }))
          : [],
        error: outcome.error ? sanitizeText(outcome.error) : null,
        degraded: Array.isArray(outcome.degraded) ? outcome.degraded.slice(0, 20) : [],
        trace: outcome.trace
          ? {
              traceId: sanitizeId(outcome.trace.traceId),
              channels: (outcome.trace.channels || []).map(channel => ({
                name: channel.name,
                status: channel.status,
                count: channel.count,
                ...(channel.errorCode ? { errorCode: sanitizeText(channel.errorCode) } : {}),
              })),
              fusion: outcome.trace.fusion,
              packing: outcome.trace.packing,
              degraded: outcome.trace.degraded || [],
            }
          : null,
      };
    },

    recordPolicy(policy, meta, gate) {
      if (!policy) return;
      trace.policy = {
        schemaVersion: policy.schemaVersion || null,
        revision: meta && Number.isInteger(meta.revision) ? meta.revision : null,
        digest: meta && meta.digest ? sanitizeId(meta.digest) : null,
        mode: sanitizeId(policy.mode),
        allowedToolCount:
          policy.tools && Array.isArray(policy.tools.allowedTools)
            ? policy.tools.allowedTools.length
            : null,
        maxRounds: policy.budgets ? policy.budgets.maxRounds : null,
        maxToolCalls: policy.tools ? policy.tools.maxToolCalls : null,
        maxTotalMs: policy.budgets ? policy.budgets.maxTotalMs : null,
        gateReason: gate ? sanitizeId(gate.reason) : null,
        gateAllowed: gate ? gate.allowed === true : null,
        corrupted: meta ? meta.corrupted === true : false,
      };
    },

    recordAgent(outcome) {
      if (!outcome) return;
      trace.agent = {
        rounds: Number.isInteger(outcome.rounds) ? outcome.rounds : 0,
        toolCalls: Number.isInteger(outcome.toolCallCount) ? outcome.toolCallCount : 0,
        readOnlyRetries: Number.isInteger(outcome.readOnlyRetries)
          ? outcome.readOnlyRetries
          : 0,
        stopReason: outcome.stopReason ? sanitizeId(outcome.stopReason) : null,
      };
    },

    recordBuild(build, inputFit) {
      const measurement = inputFit ? inputFit.measurement : null;

      trace.build = {
        ok: build.ok === true && (!inputFit || inputFit.ok !== false),
        error: build.error
          ? sanitizeText(build.error)
          : inputFit && inputFit.error
            ? sanitizeText(inputFit.error)
            : null,
        blocks: (build.blocks || []).map(block => ({
          id: sanitizeId(block.id),
          kind: block.kind,
          priority: block.priority,
          itemIds: (block.itemIds || []).map(sanitizeId),
        })),
        contextIds: (inputFit && inputFit.injectedContextIds
          ? inputFit.injectedContextIds
          : []
        ).map(sanitizeId),
        dropped: (inputFit && inputFit.dropped ? inputFit.dropped : []).map(item => ({
          id: sanitizeId(item.id),
          kind: item.kind,
          stage: item.stage,
          reason: sanitizeReason(item.reason),
          ...(Number.isFinite(item.priority) ? { priority: item.priority } : {}),
        })),
        measurement,
        // 上下文块 Token 归属（估算器口径，非 Provider 计数）。
        blockTokens: measurement && Array.isArray(measurement.blocks)
          ? measurement.blocks.map(block => ({
              id: sanitizeId(block.id),
              kind: block.kind,
              tokens: block.tokens,
            }))
          : [],
        memoryTokens: measurement ? measurement.memoryTokens ?? null : null,
        tokenSource: measurement ? measurement.tokenSource || 'estimate' : null,
      };

      const injectedMessageIds =
        inputFit && Array.isArray(inputFit.injectedMessageIds)
          ? inputFit.injectedMessageIds
          : [];
      const injectedContextIds =
        inputFit && Array.isArray(inputFit.injectedContextIds)
          ? inputFit.injectedContextIds
          : [];
      trace.stages.injected = injectedMessageIds.length + injectedContextIds.length;
    },

    recordTool(tool) {
      trace.tools.push({
        name: sanitizeId(tool.name),
        ok: tool.ok === true,
        ...(tool.code ? { code: sanitizeText(tool.code) } : {}),
        ...(Number.isFinite(tool.durationMs) ? { durationMs: tool.durationMs } : {}),
      });
    },

    recordStages(stages = {}) {
      for (const key of ['candidate', 'selected', 'accepted', 'injected', 'sent']) {
        if (Number.isFinite(stages[key])) trace.stages[key] = stages[key];
      }
    },

    recordVerification(result) {
      trace.verification = {
        ok: result.ok === true,
        ...(result.reason ? { reason: sanitizeText(result.reason) } : {}),
        checks: (result.checks || []).map(check => ({
          ok: check.ok === true,
          rule: sanitizeId(check.rule),
        })),
      };
    },

    // 必须在调用提供方之前、用真实要发送的 messages 调用。
    recordSent({ round = 1, messages = [], contextIds = [], model = {}, toolsCount = 0 } = {}) {
      const list = Array.isArray(messages) ? messages : [];
      const nonSystem = list.filter(message => message && message.role !== 'system');

      trace.sent.rounds.push({
        round,
        messageCount: list.length,
        roles: list.map(message => (message && message.role) || null),
        messageIds: nonSystem.map(message => sanitizeId(modelMessageId(message))),
        contextIds: (contextIds || []).map(sanitizeId),
        toolsCount,
        providerId: sanitizeId(model.providerId),
        modelId: sanitizeId(model.modelId),
        providerKind: model.providerKind || null,
        systemLength: list[0] && list[0].role === 'system'
          ? textLength(String(list[0].content || ''))
          : 0,
        // 发送内容的指纹：可用来核对「实际发出去的就是这一份」，
        // 而不必把正文写进 trace（隐私）。
        contentHash: hashMessages(list),
        estimatedTokens: estimateMessagesTokens(list),
        tokenSource: 'estimate',
      });
      trace.stages.sent = Math.max(
        trace.stages.sent,
        nonSystem.length + (Array.isArray(contextIds) ? contextIds.length : 0)
      );
    },

    /**
     * 记录 Provider 返回的真实 usage。
     * 与 recordSent 的 estimatedTokens 配对，才能回答「估算 vs 真实差多少」。
     * providerKind='stub' 时 usageSource 记 'stub'，绝不冒充真实调用统计。
     */
    recordProviderUsage({ round = 1, usage = null, providerKind = null, tolerance = 0.35 } = {}) {
      const promptTokens = Number.isFinite(usage && usage.prompt_tokens)
        ? usage.prompt_tokens
        : null;
      const completionTokens = Number.isFinite(usage && usage.completion_tokens)
        ? usage.completion_tokens
        : null;
      const totalTokens = Number.isFinite(usage && usage.total_tokens)
        ? usage.total_tokens
        : Number.isFinite(promptTokens) && Number.isFinite(completionTokens)
          ? promptTokens + completionTokens
          : null;

      const usageSource =
        providerKind === 'stub'
          ? 'stub'
          : promptTokens !== null || completionTokens !== null
            ? 'provider'
            : 'missing';

      const sentRound = trace.sent.rounds.find(item => item.round === round);
      const estimated =
        sentRound && Number.isFinite(sentRound.estimatedTokens)
          ? sentRound.estimatedTokens
          : null;
      const estimateRatio =
        Number.isFinite(promptTokens) && Number.isFinite(estimated) && estimated > 0
          ? +(promptTokens / estimated).toFixed(4)
          : null;

      trace.sent.usage.push({
        round,
        providerKind: providerKind || null,
        usageSource,
        promptTokens,
        completionTokens,
        totalTokens,
        estimatedInputTokens: estimated,
        estimateRatio,
        // 只有真实 Provider 的计数才有校准意义；stub 的数字不参与判定。
        calibration: usageSource === 'provider',
        withinTolerance:
          usageSource === 'provider' && estimateRatio !== null
            ? Math.abs(estimateRatio - 1) <= tolerance
            : null,
      });

      return trace.sent.usage[trace.sent.usage.length - 1];
    },

    toJSON() {
      return JSON.parse(JSON.stringify(trace));
    },

    isComplete() {
      return (
        trace.history.totalMessages >= 0 &&
        trace.build.ok !== null &&
        trace.verification.ok !== null &&
        trace.sent.rounds.length > 0
      );
    },
  };
}

module.exports = {
  createTrace,
  sanitizeText,
  sanitizeId,
  TRACE_TEXT_MAX,
};
