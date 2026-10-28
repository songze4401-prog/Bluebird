/**
 * 云岫 Bluebird — Context Engine 结构化 trace（trace.js）
 *
 * 职责（冻结基线第 6 节 / RULES.md 第 12 节）：
 * - 还原任务及路由结果、Planner 是否调用及原因、检索来源/数量/失败分类、
 *   时效检查与冲突裁决理由、上下文组装与预算裁剪摘要、
 *   工具调用结果/重试次数/执行状态、最终验证结果与失败原因；
 * - 结构化（JSON 可序列化），支持自动化测试逐字段断言，
 *   而不是一段无法解析的自然语言日志；
 * - 遵守项目隐私规范：trace 只记录元数据（长度、数量、状态、阶段、策略理由），
 *   **绝不记录**用户任务原文、记忆条目原文、工具结果内容片段；
 *   也绝不记录 API 密钥、认证令牌、密码等敏感原文。
 *   需要还原规模时用长度/计数，而不是截断正文。
 *
 * trace 对象生命周期：由 engine.js 创建，各阶段通过 record* 方法追加字段，
 * 最终由 engine.js 输出（toJSON）。测试可直接断言其字段。
 */
const { textLength, truncateText } = require('../text-utils');

// 诊断类文本（策略理由 / 错误码）仍做敏感词兜底打码，避免上游错误信息里
// 意外夹带密钥；这类字段只允许策略/错误描述，不允许用户或记忆正文。
const SENSITIVE_PATTERN =
  /(密码|口令|私钥|助记词|验证码|信用卡|银行卡|身份证|手机号|cvv|api[\s_-]?key|secret|bearer|token|sk-[a-zA-Z0-9_-]{8,}|(?:\d[\s-]?){11,})/i;

function maskSensitive(text) {
  if (typeof text !== 'string' || !text) return text;
  // 命中敏感模式（密码/密钥/长数字串等）即整段打码：
  // 绝不把敏感词或疑似密钥的片段原文带进 trace
  return SENSITIVE_PATTERN.test(text) ? '[REDACTED]' : text;
}

// 诊断文本统一截断：只用于策略理由/错误描述，不用于正文。
const TRACE_TEXT_MAX = 60;

function sanitizeText(value) {
  const truncated = truncateText(typeof value === 'string' ? value : '', TRACE_TEXT_MAX);
  return maskSensitive(truncated);
}

// 标识/时间只做长度与格式限制，不记录任何正文。
function sanitizeId(value) {
  return typeof value === 'string' && value.length <= 80 ? value : null;
}

function sanitizeTimestamp(value) {
  return typeof value === 'string' &&
    value.length <= 40 &&
    Number.isFinite(Date.parse(value))
    ? value
    : null;
}

function createTrace({ task, sessionId, ts } = {}) {
  const startedAt = ts || new Date().toISOString();

  const trace = {
    ts: startedAt,
    // 只记录任务长度，不记录任务原文（隐私要求）
    taskLength: textLength(typeof task === 'string' ? task : ''),
    sessionId: typeof sessionId === 'string' ? sessionId : null,
    route: null, // { decision: 'direct' | 'planner', reason, skippedPlanner }
    planner: null, // { called: bool, reason, plan }
    retrieval: {
      sources: [], // [{ source, status: 'ok'|'no_result'|'retrieval_error'|'tool_missing', count, error? }]
      total: 0,
    },
    adjudication: {
      inputs: 0,
      selected: 0,
      demoted: 0,
      conflicts: 0,
      expired: 0,
      // 只记录条目长度 + 裁决类型/理由，不记录条目正文
      reasons: [], // [{ itemLength, decision, reason }]
    },
    build: {
      ok: null, // 最终组装是否成功（false 时上层必须显式降级/报错）
      error: null,
      inputItems: 0, // 进入组装器的已选中条目数，不等于实际注入数
      injectedItems: 0, // 实际写入 systemContexts / untrustedContexts 的条目数
      // 已选中但按规则跳过的历史条目：只记录标识/原因，不记录正文
      skippedHistory: [],
      trimmed: 0,
      totalTokens: 0,
      perTypeSummary: {}, // { type: { kept, trimmed, tokens } }
      guaranteed: { system: 0, task: 0 },
    },
    tools: [], // [{ name, ok, code, retries, durationMs }]
    verification: {
      ok: null,
      reason: null,
    },
  };

  return {
    recordRoute(route) {
      trace.route = {
        decision: route.decision,
        reason: sanitizeText(route.reason),
        skippedPlanner: route.skippedPlanner === true,
      };
    },

    recordPlanner(planner) {
      trace.planner = {
        called: planner.called === true,
        reason: sanitizeText(planner.reason),
        plan: planner.plan ? sanitizeText(JSON.stringify(planner.plan)) : null,
      };
    },

    recordRetrieval(source, status, meta = {}) {
      trace.retrieval.sources.push({
        source,
        status,
        count: meta.count || 0,
        ...(meta.error ? { error: sanitizeText(meta.error) } : {}),
        ...(meta.toolMissingKind ? { toolMissingKind: meta.toolMissingKind } : {}),
      });
      trace.retrieval.total += meta.count || 0;
    },

    recordAdjudication(inputs, decisions) {
      const len = arr => (Array.isArray(arr) ? arr.length : Number(arr) || 0);
      trace.adjudication.inputs = inputs;
      trace.adjudication.selected = len(decisions.selected);
      trace.adjudication.demoted = len(decisions.demoted);
      trace.adjudication.conflicts = len(decisions.conflicts);
      trace.adjudication.expired = len(decisions.expired);
      if (Array.isArray(decisions.reasons)) {
        trace.adjudication.reasons = decisions.reasons
          .slice(0, 50)
          .map(r => ({
            // 只保留长度，绝不把条目正文带进 trace
            itemLength: textLength(typeof r.item === 'string' ? r.item : ''),
            decision: r.decision,
            reason: sanitizeText(r.reason),
          }));
      }
    },

    recordBuild(summary) {
      const guaranteed =
        summary.guaranteed && typeof summary.guaranteed === 'object'
          ? summary.guaranteed
          : { system: summary.guaranteedSystem, task: summary.guaranteedTask };
      const skippedHistory = Array.isArray(summary.skippedHistoryItems)
        ? summary.skippedHistoryItems.map(item => ({
            id: sanitizeId(item && item.id),
            messageId: sanitizeId(item && item.messageId),
            source: sanitizeId(item && item.source),
            type: sanitizeId(item && item.type),
            reason: sanitizeText(item && item.reason ? item.reason : ''),
            fetchedAt: sanitizeTimestamp(item && item.fetchedAt),
          }))
        : [];
      trace.build = {
        ok: summary.ok === true,
        error: summary.error ? sanitizeText(summary.error) : null,
        inputItems: summary.inputItems || 0,
        injectedItems: Number(summary.injectedItems) || 0,
        skippedHistory,
        trimmed: summary.trimmed || 0,
        totalTokens: summary.totalTokens || 0,
        perTypeSummary: summary.perTypeSummary || {},
        guaranteed: {
          system: guaranteed.system || 0,
          task: guaranteed.task || 0,
        },
      };
    },

    recordTool(tool) {
      // 只记录元数据：名称、成败、错误码、重试次数、耗时；
      // 工具结果/参数内容一律不进 trace（隐私要求）。
      trace.tools.push({
        name: tool.name,
        ok: tool.ok === true,
        ...(tool.code ? { code: tool.code } : {}),
        ...(tool.retries ? { retries: tool.retries } : {}),
        ...(tool.durationMs ? { durationMs: tool.durationMs } : {}),
      });
    },

    recordVerification(result) {
      trace.verification = {
        ok: result.ok === true,
        ...(result.reason ? { reason: sanitizeText(result.reason) } : {}),
      };
    },

    toJSON() {
      return JSON.parse(JSON.stringify(trace));
    },

    // 测试辅助：返回是否所有关键阶段都已记录
    isComplete() {
      return (
        trace.route !== null &&
        trace.planner !== null &&
        trace.retrieval.sources.length > 0 &&
        trace.build.ok !== null &&
        trace.verification.ok !== null
      );
    },
  };
}

module.exports = {
  createTrace,
  sanitizeText,
  TRACE_TEXT_MAX,
};
