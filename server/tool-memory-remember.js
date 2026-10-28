/**
 * Agent 受控记忆写入工具：memory_remember
 *
 * Agent 只能提交候选；真正的创建/合并/更新/取代/拒绝/待确认由 memory.js
 * 的统一决策管线执行。服务端强制：
 * - sourceQuote 必须是当前用户原话中的连续片段；
 * - 正文必须接地于该原话；
 * - 会话归属来自运行时上下文，不能由模型指定；
 * - 工具结果不含记忆正文。
 */
const { applyCandidate } = require('./memory');
const { textLength } = require('./text-utils');

const LIMITS = Object.freeze({
  contentMax: 100,
  quoteMax: 200,
  keywordsMax: 5,
  targetIdMax: 120,
});

const ALLOWED_TYPES = Object.freeze([
  'identity',
  'preference',
  'fact',
  'goal',
  'relationship',
]);

function isIsoDate(value) {
  return typeof value === 'string' && Number.isFinite(Date.parse(value));
}

const definition = Object.freeze({
  name: 'memory_remember',
  description:
    '提交一条关于用户的候选长期记忆。只能用于用户明确说出、值得跨会话保留的事实/偏好；' +
    'sourceQuote 必须逐字来自当前用户消息。临时情绪、一次性状态、模型推测不要提交。' +
    '如果用户是在纠正旧事实，可传 targetId 指定要更新的记忆。',
  parameters: Object.freeze({
    type: 'object',
    properties: Object.freeze({
      content: Object.freeze({
        type: 'string',
        description: '候选记忆正文，不超过 100 字',
        maxLength: LIMITS.contentMax,
      }),
      type: Object.freeze({
        type: 'string',
        enum: ALLOWED_TYPES,
        description: '记忆类别',
      }),
      sourceQuote: Object.freeze({
        type: 'string',
        description: '当前用户消息中的连续原话片段',
        maxLength: LIMITS.quoteMax,
      }),
      keywords: Object.freeze({
        type: 'array',
        items: Object.freeze({ type: 'string', maxLength: 20 }),
        maxItems: LIMITS.keywordsMax,
        description: '3-5 个与事实直接相关的关键词',
      }),
      confidence: Object.freeze({
        type: 'number',
        minimum: 0,
        maximum: 1,
        default: 0.9,
        description: '候选置信度；低置信候选可能进入待确认',
      }),
      targetId: Object.freeze({
        type: 'string',
        description: '可选：用户明确纠正时，要更新的记忆 id',
        maxLength: LIMITS.targetIdMax,
      }),
      validFrom: Object.freeze({
        type: 'string',
        description: '可选：事实开始生效的 ISO 时间',
      }),
      validTo: Object.freeze({
        type: 'string',
        description: '可选：事实失效的 ISO 时间；临时事件应提供',
      }),
      eventAt: Object.freeze({
        type: 'string',
        description: '可选：事实实际发生的时间（ISO）；用于避免把不同时间的事件合并',
      }),
      condition: Object.freeze({
        type: 'string',
        maxLength: 80,
        description: '可选：事实适用的条件；条件不同不得合并',
      }),
    }),
    required: Object.freeze(['content', 'type', 'sourceQuote']),
  }),
  timeoutMs: 5000,
  // 受控写入工具：运行层要求 context 同时带 sessionId 与当前用户原话，
  // 真正的创建/合并/拒绝仍由 applyCandidate 的授权管线决定。
  readOnly: false,

  validate(args) {
    if (!args || typeof args !== 'object' || Array.isArray(args)) {
      return { ok: false, error: '参数必须是 JSON 对象' };
    }

    const content = typeof args.content === 'string' ? args.content.trim() : '';
    if (!content) return { ok: false, error: '缺少必填参数 content' };
    if (textLength(content) > LIMITS.contentMax) {
      return { ok: false, error: `content 超过 ${LIMITS.contentMax} 字上限` };
    }

    if (!ALLOWED_TYPES.includes(args.type)) {
      return { ok: false, error: 'type 不在允许范围内' };
    }

    const sourceQuote =
      typeof args.sourceQuote === 'string' ? args.sourceQuote.trim() : '';
    if (!sourceQuote) return { ok: false, error: '缺少必填参数 sourceQuote' };
    if (textLength(sourceQuote) > LIMITS.quoteMax) {
      return { ok: false, error: `sourceQuote 超过 ${LIMITS.quoteMax} 字上限` };
    }

    const keywords = Array.isArray(args.keywords)
      ? args.keywords
          .filter(item => typeof item === 'string')
          .map(item => item.trim())
          .filter(Boolean)
      : [];

    if (keywords.length > LIMITS.keywordsMax) {
      return { ok: false, error: `keywords 不能超过 ${LIMITS.keywordsMax} 个` };
    }

    let confidence = 0.9;
    if (args.confidence !== undefined) {
      if (typeof args.confidence !== 'number' || !Number.isFinite(args.confidence)) {
        return { ok: false, error: 'confidence 必须是数字' };
      }
      if (args.confidence < 0 || args.confidence > 1) {
        return { ok: false, error: 'confidence 必须在 0-1 之间' };
      }
      confidence = args.confidence;
    }

    const targetId =
      typeof args.targetId === 'string' && args.targetId.trim()
        ? args.targetId.trim()
        : null;

    if (targetId && textLength(targetId) > LIMITS.targetIdMax) {
      return { ok: false, error: 'targetId 过长' };
    }

    for (const key of ['validFrom', 'validTo', 'eventAt']) {
      if (args[key] !== undefined && !isIsoDate(args[key])) {
        return { ok: false, error: `${key} 必须是 ISO 时间` };
      }
    }

    const condition =
      typeof args.condition === 'string' ? args.condition.trim() : null;

    if (condition && textLength(condition) > 80) {
      return { ok: false, error: 'condition 不能超过 80 字' };
    }

    return {
      ok: true,
      args: {
        content,
        type: args.type,
        sourceQuote,
        keywords,
        confidence,
        targetId,
        validFrom: args.validFrom || null,
        validTo: args.validTo || null,
        eventAt: args.eventAt || null,
        condition,
      },
    };
  },

  async handler(args, context = {}) {
    if (!context.sessionId || !context.userText) {
      return {
        ok: false,
        code: 'ungrounded_source',
        error: '缺少当前会话或用户原话，拒绝提交候选',
        summary: '未写入：缺少来源上下文',
      };
    }

    const result = await applyCandidate(
      {
        content: args.content,
        type: args.type,
        sourceQuote: args.sourceQuote,
        keywords: args.keywords,
        confidence: args.confidence,
        targetId: args.targetId,
        validFrom: args.validFrom,
        validTo: args.validTo,
        eventAt: args.eventAt,
        condition: args.condition,
      },
      {
        sessionId: context.sessionId,
        messageId: context.userMessageId || null,
        sourceType: 'agent',
        intent: args.targetId ? 'correction' : 'explicit',
        actor: 'agent',
        userText: context.userText,
        requireUserGrounding: true,
        signal: context.signal,
      }
    );

    if (result.decision === 'reject') {
      return {
        ok: false,
        code: 'memory_rejected',
        decision: result.decision,
        reason: result.reason,
        summary: `未写入：${result.reason}`,
      };
    }

    if (result.decision === 'needs_confirmation') {
      return {
        ok: true,
        pending: true,
        decision: result.decision,
        reason: result.reason,
        entryId: result.id || null,
        summary: '已提交，等待用户确认',
      };
    }

    return {
      ok: true,
      decision: result.decision,
      entryId: result.id || null,
      targetId: result.targetId || null,
      supersededId: result.supersededId || null,
      status: result.status || null,
      durable: result.durable === true,
      summary: `记忆已${result.decision === 'create' ? '新增' : '更新'}`,
    };
  },
});

module.exports = { definition, LIMITS };