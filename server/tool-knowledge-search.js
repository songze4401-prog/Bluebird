/**
 * 云岫 Bluebird — Agent 工具：knowledge_search（统一只读知识检索）
 *
 * 复用 server/retrieval 的五类来源混合检索；会话 ID 只由运行层注入，
 * 模型参数里没有 sessionId，无法越权检索其他会话。工具只读，不写索引。
 */
const retrieval = require('./retrieval');
const { textLength, truncateText } = require('./text-utils');

const LIMITS = Object.freeze({
  queryMax: 200,
  limitMin: 1,
  limitMax: 10,
  limitDefault: 5,
  perItemMax: 500,
});

const SOURCES = Object.freeze(['memory', 'conversation', 'document', 'web', 'code']);

function validateSources(value) {
  if (value === undefined) return { ok: true, value: null };
  if (!Array.isArray(value) || !value.length) {
    return { ok: false, error: 'sources 必须是非空数组' };
  }
  const result = [];
  for (const item of value) {
    if (typeof item !== 'string' || !SOURCES.includes(item)) {
      return { ok: false, error: 'sources 包含非法来源' };
    }
    if (!result.includes(item)) result.push(item);
  }
  return { ok: true, value: result };
}

const definition = Object.freeze({
  name: 'knowledge_search',
  description:
    '统一搜索长期记忆、当前会话历史、已索引的文档/网页/代码仓库（只读）。' +
    '当问题需要跨来源证据、查文档、查代码符号/路径，或需要给出来源位置时使用。' +
    '个人事实的精确读取仍优先用 memory_search。',
  parameters: Object.freeze({
    type: 'object',
    properties: Object.freeze({
      query: Object.freeze({
        type: 'string',
        description: '自然语言问题或代码符号/路径/错误码',
        maxLength: LIMITS.queryMax,
      }),
      limit: Object.freeze({
        type: 'integer',
        minimum: LIMITS.limitMin,
        maximum: LIMITS.limitMax,
        default: LIMITS.limitDefault,
        description: '返回证据条数',
      }),
      sources: Object.freeze({
        type: 'array',
        items: Object.freeze({ type: 'string', enum: SOURCES }),
        description: '可选：限定来源；缺省检索全部可用来源',
      }),
      asOf: Object.freeze({
        type: 'string',
        description: '可选：按有效期过滤的历史时间点（ISO）',
      }),
    }),
    required: Object.freeze(['query']),
  }),
  timeoutMs: 5000,
  readOnly: true,

  validate(args) {
    if (!args || typeof args !== 'object' || Array.isArray(args)) {
      return { ok: false, error: '参数必须是 JSON 对象' };
    }
    const query = typeof args.query === 'string' ? args.query.trim() : '';
    if (!query) return { ok: false, error: '缺少必填参数 query' };
    if (textLength(query) > LIMITS.queryMax) {
      return { ok: false, error: `query 超过 ${LIMITS.queryMax} 字上限` };
    }

    let limit = LIMITS.limitDefault;
    if (args.limit !== undefined) {
      if (!Number.isInteger(args.limit) || args.limit < LIMITS.limitMin || args.limit > LIMITS.limitMax) {
        return { ok: false, error: `limit 必须在 ${LIMITS.limitMin}-${LIMITS.limitMax} 之间` };
      }
      limit = args.limit;
    }

    const sources = validateSources(args.sources);
    if (!sources.ok) return sources;

    let asOf = null;
    if (args.asOf !== undefined) {
      if (typeof args.asOf !== 'string' || !Number.isFinite(Date.parse(args.asOf))) {
        return { ok: false, error: 'asOf 不是合法时间' };
      }
      asOf = args.asOf;
    }

    return {
      ok: true,
      args: {
        query,
        limit,
        sources: sources.value,
        asOf,
      },
    };
  },

  async handler(args, context) {
    const sessionId = context && context.sessionId ? context.sessionId : null;
    let sources = args.sources;
    if (!sessionId) {
      sources = (sources || SOURCES).filter(
        item => item !== 'memory' && item !== 'conversation'
      );
    }

    const found = await retrieval.search({
      query: args.query,
      sessionId,
      sources,
      limit: args.limit,
      tokenBudget: 1600,
      asOf: args.asOf,
    });

    if (!found.ok) {
      return {
        ok: false,
        code: found.errorCode || 'knowledge_search_failed',
        error: found.error || '统一检索失败',
      };
    }

    const results = found.evidence.map(item => ({
      content: truncateText(item.content, LIMITS.perItemMax),
      sourceType: item.sourceType,
      title: item.title,
      locator: item.locator,
      citation: item.citation.label,
      authority: item.signals.authority,
      freshness: item.signals.freshness.status,
      version: item.signals.sourceVersion,
      relevance: item.scores.retrieval,
      truncated: item.flags.truncated,
    }));

    return {
      ok: true,
      status: found.status,
      results,
      total: results.length,
      citations: found.citations,
      degraded: found.degraded,
      traceId: found.trace ? found.trace.traceId : null,
      summary: results.length
        ? `找到 ${results.length} 条跨来源证据`
        : '未找到相关证据',
    };
  },
});

module.exports = { definition, LIMITS };
