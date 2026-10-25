/**
 * 云岫 Bluebird — Agent 工具：memory_search（只读记忆检索）
 *
 * Agent V1 唯一开放的工具。设计约束（任务书）：
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
});

const definition = Object.freeze({
  name: 'memory_search',
  description:
    '检索与当前会话相关的长期记忆（只读）。当用户问到关于自己的事实、偏好、身份，' +
    '或需要回忆过去明确说过的事情时使用。不要用它检索临时对话内容。',
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

    return { ok: true, args: { query, limit } };
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
      limits: {
        maxItems: LIMITS.limitMax,
        perItemMax: LIMITS.perItemMax,
        totalMax: LIMITS.totalMax,
      },
    });

    const results = found.results
      .slice(0, args.limit)
      .map(item => ({
        content: truncateText(item.content, LIMITS.perItemMax),
        type: item.type,
      }));

    return {
      ok: true,
      results,
      total: found.total,
      truncated: found.truncated === true,
      ...(found.reason ? { reason: found.reason } : {}),
      summary:
        found.reason === 'memory_disabled'
          ? '记忆功能未启用'
          : results.length
            ? `找到 ${results.length} 条相关记忆`
            : '未找到相关记忆',
    };
  },
});

module.exports = { definition, LIMITS };
