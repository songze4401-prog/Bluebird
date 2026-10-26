/**
 * 云岫 Bluebird — Context Engine 结构化 trace（trace.js）
 *
 * 职责（冻结基线第 6 节 / RULES.md 第 12 节）：
 * - 还原任务及路由结果、Planner 是否调用及原因、检索来源/数量/失败分类、
 *   时效检查与冲突裁决理由、上下文组装与预算裁剪摘要、
 *   工具调用结果/重试次数/执行状态、最终验证结果与失败原因；
 * - 结构化（JSON 可序列化），支持自动化测试逐字段断言，
 *   而不是一段无法解析的自然语言日志；
 * - 遵守项目现有隐私规范：绝不记录 API 密钥、认证令牌、密码等敏感原文，
 *   工具结果只记录摘要（与 agent-runtime 的 toolSteps 摘要口径一致），
 *   用户/记忆正文按截断 + 敏感词打码处理。
 *
 * trace 对象生命周期：由 engine.js 创建，各阶段通过 record* 方法追加字段，
 * 最终由 engine.js 输出（toJSON）。测试可直接断言其字段。
 */
const { textLength, truncateText } = require('../text-utils');

// 敏感模式与 memory.js 的 SENSITIVE_PATTERN 对齐（密码/口令/私钥/密钥/令牌等），
// 命中即打码，避免完整敏感内容进入 trace。
const SENSITIVE_PATTERN =
  /(密码|口令|私钥|助记词|验证码|信用卡|银行卡|身份证|手机号|cvv|api[\s_-]?key|secret|bearer|token|sk-[a-zA-Z0-9_-]{8,}|(?:\d[\s-]?){11,})/i;

function maskSensitive(text) {
  if (typeof text !== 'string' || !text) return text;
  // 命中敏感模式（密码/密钥/长数字串等）即整段打码：
  // 绝不把敏感词或疑似密钥的片段原文带进 trace
  return SENSITIVE_PATTERN.test(text) ? '[REDACTED]' : text;
}

// 入 trace 的正文统一截断：完整正文是用户/记忆/工具内容，不进 trace；
// 只保留 60 码点的摘要供还原，超长截断加省略号（与 text-utils 口径一致）。
const TRACE_TEXT_MAX = 60;

function sanitizeText(value) {
  const truncated = truncateText(typeof value === 'string' ? value : '', TRACE_TEXT_MAX);
  return maskSensitive(truncated);
}

// 工具结果只保留摘要（与 agent-runtime 的 buildToolSummary / toolSteps 同口径），
// 不落参数、不落记忆正文、不落模型推理。
function sanitizeToolSummary(summary) {
  return truncateText(typeof summary === 'string' ? summary : '', 120);
}

function createTrace({ task, sessionId, ts } = {}) {
  const startedAt = ts || new Date().toISOString();

  const trace = {
    ts: startedAt,
    task: sanitizeText(task),
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
      reasons: [], // [{ item: 摘要, decision: 'selected'|'demoted'|'conflict'|'expired', reason }]
    },
    build: {
      ok: null, // 最终组装是否成功（false 时上层必须显式降级/报错）
      error: null,
      inputItems: 0,
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
            item: sanitizeText(r.item),
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
      trace.build = {
        ok: summary.ok === true,
        error: summary.error ? sanitizeText(summary.error) : null,
        inputItems: summary.inputItems || 0,
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
      const summary = sanitizeToolSummary(tool.summary);
      trace.tools.push({
        name: tool.name,
        ok: tool.ok === true,
        ...(tool.code ? { code: tool.code } : {}),
        ...(tool.retries ? { retries: tool.retries } : {}),
        ...(tool.durationMs ? { durationMs: tool.durationMs } : {}),
        // 摘要先截断到 120，再打码敏感内容（与正文同一套规则）
        ...(summary ? { summary: maskSensitive(summary) } : {}),
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
  sanitizeToolSummary,
  TRACE_TEXT_MAX,
};
