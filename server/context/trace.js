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
const { textLength, truncateText } = require('../text-utils');
const { modelMessageId } = require('./projection');

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

function createTrace({ task, sessionId, ts } = {}) {
  const trace = {
    ts: ts || new Date().toISOString(),
    taskLength: textLength(typeof task === 'string' ? task : ''),
    sessionId: typeof sessionId === 'string' ? sessionId : null,
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
      accepted: 0,
      skipped: [],
      conflicts: [],
      error: null,
    },
    build: {
      ok: null,
      error: null,
      blocks: [],
      contextIds: [],
      dropped: [],
      measurement: null,
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
      consumed: null,
      consumedNote: '未采集模型实际消费证据；HTTP 成功不等于模型已消费',
    },
  };

  return {
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

    recordRetrieval(outcome, adjudication) {
      trace.retrieval = {
        source: 'memory',
        status: outcome.status || null,
        candidates: outcome.count || 0,
        accepted: adjudication ? adjudication.accepted.length : 0,
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
        measurement: inputFit ? inputFit.measurement : null,
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
        systemLength: list[0] && list[0].role === 'system'
          ? textLength(String(list[0].content || ''))
          : 0,
      });
      trace.stages.sent = Math.max(
        trace.stages.sent,
        nonSystem.length + (Array.isArray(contextIds) ? contextIds.length : 0)
      );
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
