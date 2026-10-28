/**
 * 云岫 Bluebird — Agent 工具：memory_search（只读记忆检索）
 *
 * Agent V1 的只读检索工具；写入候选走 memory_remember。设计约束（任务书）：
 * - 只读：第一阶段禁止文件访问 / Shell / 写文件 / Git / 任意函数执行；
 * - 复用 memory.js 的检索算分与 scope 隔离规则，不绕过现有记忆权限；
 * - 三类硬上限在后端强制执行（条数 / 单条长度 / 总预算），
 *   长度计算统一走 text-utils（码点计数）；
 * - 参数非法 / 无匹配 / 无权限均返回结构化结果，不泄露其他会话数据；
 * - 工具名进服务端白名单（agent-runtime 注册表），参数全部经服务端校验。
 */
const { searchMemories } = require('./memory');
const { textLength, truncateText } = require('./text-utils');

const LIMITS = Object.freeze({
  queryMax: 200, // query 参数长度上限（码点）
  limitMin: 1,
  limitMax: 10, // 单次最多返回条数（硬上限）
  limitDefault: 5,
  perItemMax: 300, // 单条记忆内容上限（码点）
  totalMax: 2000, // 全部结果总字符预算（码点）
  maxTokens: 1200, // 全部结果 content 的近似 token 预算
  sourcesMax: 5,
  statusesMax: 3,
});

const SOURCE_VALUES = Object.freeze(['user', 'agent', 'tool', 'model', 'import']);
const STATUS_VALUES = Object.freeze(['active', 'superseded', 'archived']);
const TIME_FIELDS = Object.freeze(['valid', 'created', 'updated']);

function validateEnumList(value, allowed, label) {
  if (!Array.isArray(value) || !value.length) {
    return { ok: false, error: `${label} 必须是非空数组` };
  }
  if (value.length > allowed.length) {
    return { ok: false, error: `${label} 元素过多` };
  }
  const result = [];
  for (const item of value) {
    if (typeof item !== 'string' || !allowed.includes(item)) {
      return { ok: false, error: `${label} 包含非法值` };
    }
    if (!result.includes(item)) result.push(item);
  }
  return { ok: true, value: result };
}

function validateTime(value, label) {
  if (typeof value !== 'string' || !value.trim()) {
    return { ok: false, error: `${label} 必须是非空 ISO 时间` };
  }
  if (!Number.isFinite(Date.parse(value))) {
    return { ok: false, error: `${label} 不是合法时间` };
  }
  return { ok: true, value };
}

const definition = Object.freeze({
  name: 'memory_search',
  description:
    '检索与当前会话相关的长期记忆（只读），同时使用关键词与本地概念语义（同义/跨语言）；' +
    '当用户问到关于自己的事实、偏好、身份，或需要回忆过去明确说过的事情时使用。' +
    '不要用它检索临时对话内容。',
  parameters: Object.freeze({
    type: 'object',
    properties: Object.freeze({
      query: Object.freeze({
        type: 'string',
        description: '检索关键词或自然语言问题',
        maxLength: LIMITS.queryMax,
      }),
      limit: Object.freeze({
        type: 'integer',
        description: `期望返回条数（${LIMITS.limitMin}-${LIMITS.limitMax}，默认 ${LIMITS.limitDefault}）`,
        minimum: LIMITS.limitMin,
        maximum: LIMITS.limitMax,
        default: LIMITS.limitDefault,
      }),
      mode: Object.freeze({
        type: 'string',
        enum: ['current', 'history'],
        description:
          'current=当前有效事实（默认）；history=按 asOf 读取历史事实，必须同时提供 asOf',
      }),
      asOf: Object.freeze({
        type: 'string',
        description: '历史查询的时间点（ISO 时间）；仅 mode=history 时必填',
      }),
      sources: Object.freeze({
        type: 'array',
        items: Object.freeze({ type: 'string', enum: SOURCE_VALUES }),
        maxItems: LIMITS.sourcesMax,
        description:
          '可选：按来源类型过滤（user/agent/tool/model/import）；缺省不过滤，指定时缺少来源的旧条目不算匹配',
      }),
      statuses: Object.freeze({
        type: 'array',
        items: Object.freeze({ type: 'string', enum: STATUS_VALUES }),
        maxItems: LIMITS.statusesMax,
        description:
          '可选：按状态过滤（active/superseded/archived）；pending 不属于可检索事实',
      }),
      timeFrom: Object.freeze({
        type: 'string',
        description: '可选：时间范围起点（ISO）',
      }),
      timeTo: Object.freeze({
        type: 'string',
        description: '可选：时间范围终点（ISO）',
      }),
      timeField: Object.freeze({
        type: 'string',
        enum: TIME_FIELDS,
        description:
          '时间范围作用字段：valid=有效期（默认）/created=创建时间/updated=更新时间',
      }),
    }),
    required: Object.freeze(['query']),
  }),
  timeoutMs: 5000,

  /**
   * 服务端白名单校验：不信任模型传入的任何参数。
   * 返回 { ok: true, args } 或 { ok: false, error }。
   */
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
      if (typeof args.limit !== 'number' || !Number.isInteger(args.limit)) {
        return { ok: false, error: 'limit 必须是整数' };
      }
      if (args.limit < LIMITS.limitMin || args.limit > LIMITS.limitMax) {
        return {
          ok: false,
          error: `limit 必须在 ${LIMITS.limitMin}-${LIMITS.limitMax} 之间`,
        };
      }
      limit = args.limit;
    }

    const mode = args.mode === undefined ? 'current' : args.mode;

    if (mode !== 'current' && mode !== 'history') {
      return { ok: false, error: 'mode 必须是 current 或 history' };
    }

    let asOf = null;

    if (mode === 'history') {
      if (typeof args.asOf !== 'string' || !Number.isFinite(Date.parse(args.asOf))) {
        return { ok: false, error: 'history 模式必须提供合法 asOf 时间' };
      }
      asOf = args.asOf;
    }

    const filters = {};

    if (args.sources !== undefined) {
      const sources = validateEnumList(args.sources, SOURCE_VALUES, 'sources');
      if (!sources.ok) return sources;
      filters.sources = sources.value;
    }

    if (args.statuses !== undefined) {
      const statuses = validateEnumList(
        args.statuses,
        STATUS_VALUES,
        'statuses'
      );
      if (!statuses.ok) return statuses;
      filters.statuses = statuses.value;
    }

    const hasTimeFrom = args.timeFrom !== undefined;
    const hasTimeTo = args.timeTo !== undefined;

    if (hasTimeFrom || hasTimeTo) {
      if (hasTimeFrom) {
        const from = validateTime(args.timeFrom, 'timeFrom');
        if (!from.ok) return from;
        filters.timeFrom = from.value;
      }
      if (hasTimeTo) {
        const to = validateTime(args.timeTo, 'timeTo');
        if (!to.ok) return to;
        filters.timeTo = to.value;
      }
      if (
        filters.timeFrom &&
        filters.timeTo &&
        Date.parse(filters.timeFrom) > Date.parse(filters.timeTo)
      ) {
        return { ok: false, error: 'timeFrom 不能晚于 timeTo' };
      }
    }

    if (args.timeField !== undefined) {
      if (!TIME_FIELDS.includes(args.timeField)) {
        return {
          ok: false,
          error: 'timeField 必须是 valid/created/updated',
        };
      }
      if (!hasTimeFrom && !hasTimeTo) {
        return { ok: false, error: 'timeField 必须与 timeFrom/timeTo 一起使用' };
      }
      filters.timeField = args.timeField;
    }

    return {
      ok: true,
      args: {
        query,
        limit,
        mode,
        asOf,
        filters: Object.keys(filters).length ? filters : null,
      },
    };
  },

  /**
   * 执行检索。context: { sessionId, signal }。
   * signal 由编排层传入（AbortSignal）：handler 必须在可等待点检查它，
   * 超时被中止时尽快收尾，不做无谓的后台工作。
   */
  async handler(args, context) {
    const found = searchMemories({
      query: args.query,
      sessionId: context && context.sessionId,
      mode: args.mode || 'current',
      asOf: args.asOf || null,
      filters: args.filters || null,
      limits: {
        maxItems: LIMITS.limitMax,
        perItemMax: LIMITS.perItemMax,
        totalMax: LIMITS.totalMax,
        maxTokens: LIMITS.maxTokens,
      },
    });

    const results = found.results.slice(0, args.limit).map(item => ({
      content: truncateText(item.content, LIMITS.perItemMax),
      type: item.type,
      id: item.id,
      status: item.status,
      validFrom: item.validFrom,
      validTo: item.validTo,
      confidence: item.confidence,
      relevance: item.relevance,
      score: item.score,
      match: item.match,
      sourceTypes: item.sourceTypes,
      scope: item.scope,
      contentTruncated: item.contentTruncated === true,
    }));

    return {
      ok: true,
      mode: found.mode || args.mode || 'current',
      results,
      total: found.total,
      estimatedTokens: found.estimatedTokens || 0,
      truncated: found.truncated === true,
      truncatedItems: found.truncatedItems || 0,
      budget: {
        estimatedTokens: found.estimatedTokens || 0,
        maxTokens: LIMITS.maxTokens,
        estimator:
          found.diagnostics && found.diagnostics.tokenEstimator
            ? found.diagnostics.tokenEstimator
            : null,
        exceeded:
          Boolean(found.diagnostics) &&
          found.diagnostics.budgetTruncated === true,
      },
      excluded:
        found.diagnostics && found.diagnostics.excluded
          ? found.diagnostics.excluded
          : null,
      notReturned:
        found.diagnostics && found.diagnostics.notReturned
          ? found.diagnostics.notReturned
          : null,
      semantic:
        found.diagnostics && found.diagnostics.semantic
          ? found.diagnostics.semantic
          : null,
      ...(found.reason ? { reason: found.reason } : {}),
      summary:
        found.reason === 'memory_disabled'
          ? '记忆功能未启用'
          : results.length
            ? `找到 ${results.length} 条${found.mode === 'history' ? '历史' : ''}相关记忆`
            : '未找到相关记忆',
    };
  },
});

module.exports = { definition, LIMITS };
