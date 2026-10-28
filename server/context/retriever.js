/**
 * 云岫 Bluebird — Context Engine 检索器（retriever.js）
 *
 * 职责（RULES.md 第 2/4/6/7 节）：
 * - 多来源并行检索：memory（复用 memory.js 的 searchMemories）、user（历史消息）、
 *   tool（工具结果，调用方注入）、doc / web（外部不可信内容，调用方注入）；
 * - 每个检索条目携带三维元数据（source / verification / freshness），
 *   不压缩成单一 trust 分数；
 * - 失败分类：no_result（正常空）/ retrieval_error（检索出错）/ tool_missing
 *   （not_implemented vs not_found），严禁把 retrieval_error 表述为"没有相关信息"；
 * - ranker 并入本模块（冻结基线：不提前拆模块）：结构化规则两阶段的第一阶段
 *   （当前任务匹配 > 高验证等级 > 时效新近），第二阶段 Embedding 重排为规划项；
 * - 熔断按 data_source 粒度（v2.3）：单源连续 failureThreshold 次
 *   retrieval_error 进入 windowMs 熔断，只隔离该源，不影响其他源；
 * - 自动重试仅限只读/幂等源，最多 maxRetries 次（默认 1），副作用源不重试。
 *
 * 本模块只读 config（由调用方传入或默认使用 config.js 的全局已校验配置），
 * 不修改、不重新解释策略。
 */
const { config: defaultConfig } = require('./config');
const { searchMemories } = require('../memory');
const { textLength } = require('../text-utils');

// ---- 信息类型（TTL 配置键）----
// 记忆条目类型映射：preference → user_preference，其余（identity/fact/goal/
// relationship）→ project_fact；外部 doc/web/tool/user 各自为类型。
const MEMORY_TYPE_MAP = {
  preference: 'user_preference',
  identity: 'project_fact',
  fact: 'project_fact',
  goal: 'project_fact',
  relationship: 'project_fact',
};

// ---- 熔断状态（进程级，按 data_source 粒度）----
const breakerState = new Map(); // source -> { failures, until }

function isTripped(source, config, now = Date.now()) {
  const state = breakerState.get(source);
  if (!state) return false;
  if (state.until && state.until > now) return true;
  if (state.until && state.until <= now) breakerState.delete(source);
  return false;
}

function recordRetrievalFailure(source, config, now = Date.now()) {
  const threshold = config.circuitBreaker.failureThreshold;
  const windowMs = config.circuitBreaker.windowMs;
  const state = breakerState.get(source) || { failures: 0, until: 0 };
  state.failures = state.failures + 1;
  if (state.failures >= threshold) {
    state.until = now + windowMs;
    state.failures = 0;
  }
  breakerState.set(source, state);
}

function resetBreaker(source) {
  breakerState.delete(source);
}

// ---- freshness 计算（v2.3 时效状态机）----
// 实时类型（realtime_data）：TTL 内 fresh，超过即 expired（必须排除 + refetch）。
// 非实时类型：TTL 内 fresh，超过即 stale（可进入，标注"可能过时"）。
// 无 TTL：unknown（可进入，标注"时效未知"，与 stale 分开统计）。
function computeFreshness({ type, ttl, fetchedAt, config, now = Date.now() }) {
  const nowMs = typeof now === 'number' ? now : new Date(now).getTime();
  const fetchedMs = fetchedAt ? new Date(fetchedAt).getTime() : null;

  if (!fetchedMs || Number.isNaN(fetchedMs)) {
    return { fetched_at: fetchedAt || null, ttl, status: 'unknown', label: '时效未知' };
  }

  const ttlConfig = (config && config.ttl && config.ttl[type]) || null;

  if (!ttlConfig || typeof ttlConfig.ttlMs !== 'number') {
    // 该类型未配置 TTL：unknown（不臆测，不默认为 stale——v2.3 分开统计）
    return { fetched_at: fetchedAt, ttl, status: 'unknown', label: '时效未知' };
  }

  const ttlMs = Number.isFinite(ttl) && ttl > 0 ? ttl : ttlConfig.ttlMs;
  const age = nowMs - fetchedMs;

  if (age <= ttlMs) {
    return { fetched_at: fetchedAt, ttl: ttlMs, status: 'fresh', label: 'fresh' };
  }

  if (type === 'realtime_data') {
    return { fetched_at: fetchedAt, ttl: ttlMs, status: 'expired', label: '已过期，必须重新获取' };
  }

  return { fetched_at: fetchedAt, ttl: ttlMs, status: 'stale', label: '可能过时' };
}

// ---- ranker（结构化规则第一阶段；Embedding 重排为规划项）----
// 打分维度：
//   1) 任务文本匹配（bigram 重合，复用 memory.js 的相似度思路，但本模块不
//      依赖 memory 内部实现——使用简单分词重合度）；
//   2) 验证等级加成（delivered=0 / schema_valid=1 / cross_checked=2 / user_confirmed=3）；
//   3) 时效加成：fresh +2 / stale +1 / unknown +1 / expired -10。
// 输出 relevance 分数与 rankReasons（供 trace 还原）。
const VERIFICATION_BONUS = {
  delivered: 0,
  schema_valid: 1,
  cross_checked: 2,
  user_confirmed: 3,
};

const FRESHNESS_BONUS = {
  fresh: 2,
  stale: 1,
  unknown: 1,
  expired: -10,
};

function normalize(text) {
  return String(text || '')
    .toLowerCase()
    .replace(/\s+/g, '');
}

function bigramSet(text) {
  const normalized = normalize(text);
  const result = new Set();
  if (normalized.length < 2) return result;
  for (let i = 0; i < normalized.length - 1; i++) {
    result.add(normalized.slice(i, i + 2));
  }
  return result;
}

function taskOverlapScore(itemContent, task) {
  const itemBigrams = bigramSet(itemContent);
  const taskBigrams = bigramSet(task);

  if (!itemBigrams.size || !taskBigrams.size) return 0;

  let hits = 0;
  for (const b of taskBigrams) {
    if (itemBigrams.has(b)) hits++;
  }
  return hits / Math.max(taskBigrams.size, 1);
}

function rankItems(items, task) {
  return items
    .map(item => {
      const overlap = taskOverlapScore(item.content, task);
      const verificationBonus =
        VERIFICATION_BONUS[item.verification.status] || 0;
      const freshnessBonus =
        FRESHNESS_BONUS[item.freshness.status] || 0;

      const relevance =
        Math.round((overlap * 10 + verificationBonus + freshnessBonus) * 100) / 100;

      return {
        ...item,
        relevance,
        rankReasons: [
          `任务匹配 ${overlap.toFixed(2)}`,
          `验证等级 ${item.verification.status} (+${verificationBonus})`,
          `时效 ${item.freshness.status} (+${freshnessBonus})`,
        ],
      };
    })
    .sort((a, b) => b.relevance - a.relevance);
}

// ---- 条目构造 ----

let entrySeq = 0;

function makeItem({
  content,
  source,
  type,
  verification,
  freshness,
  untrusted = false,
  relevance = null,
  fromHistory = false,
}) {
  entrySeq += 1;
  return {
    id: `ctx-${source}-${entrySeq}`,
    content,
    source,
    type,
    verification,
    freshness,
    untrusted,
    // 检索侧的相关度（0~1）；来源不提供时为 null，组内决胜退回原有次序。
    relevance,
    // 该条目来自已进入模型消息历史的用户消息。它仍需参与裁决，
    // 但不能再渲染进 systemPrompt，否则同一句话会被注入两次。
    fromHistory,
  };
}

// ---- 内置源处理器 ----
// 每个源是一个 async 函数：输入 { task, sessionId, injected, config, now }，
// 返回 { status: 'ok', items } 或 { status: 'no_result'|'retrieval_error'|'tool_missing' }。
// 绝不抛出（编排层靠 status 分类，与 agent-runtime 的错误隔离风格一致）。

const memorySource = {
  name: 'memory',
  readonly: true,
  async fetch({ task, sessionId, injected, config }) {
    // 注入覆盖优先（测试/上层可显式提供带时间戳与 TTL 的记忆条目）；
    // 否则走真实记忆库检索。
    const injectedEntries = Array.isArray(injected.memory) ? injected.memory : [];
    if (injectedEntries.length) {
      const items = injectedEntries
        .map(entry => {
          const type = MEMORY_TYPE_MAP[entry.type] || 'project_fact';
          const ttlConfig = config.ttl[type];
          return makeItem({
            content: typeof entry.content === 'string' ? entry.content : '',
            source: 'memory',
            type,
            verification: {
              status: 'schema_valid',
              checked_items: ['extracted', 'source_verified', 'sensitive_filtered'],
            },
            freshness: computeFreshness({
              type,
              ttl: entry.ttl || (ttlConfig && ttlConfig.ttlMs),
              fetchedAt: entry.fetchedAt || null,
              config,
            }),
          });
        })
        .filter(item => item.content);

      return { status: items.length ? 'ok' : 'no_result', items, count: items.length };
    }

    const limits = {
      maxItems: 10,
      perItemMax: 300,
      totalMax: 2000,
    };

    const found = searchMemories({
      query: task,
      sessionId,
      limits,
    });

    if (found.reason === 'memory_disabled') {
      return { status: 'no_result', count: 0, error: null };
    }
    if (found.reason === 'empty_query' || found.reason === 'empty_store') {
      return { status: 'no_result', count: 0 };
    }

    const items = found.results.map(result => {
      const type = MEMORY_TYPE_MAP[result.type] || 'project_fact';
      const ttlConfig = config.ttl[type];
      // 记忆条目的时效起点用 validFrom（生效时间），缺失时退回 updatedAt：
      // 有真实时间戳才能算 fresh/stale/expired，不再一律标 unknown。
      const fetchedAt = result.validFrom || result.updatedAt || null;
      return makeItem({
        content: result.content,
        source: 'memory',
        type,
        verification: {
          status: 'schema_valid',
          checked_items: ['extracted', 'source_verified', 'sensitive_filtered'],
        },
        freshness: computeFreshness({
          type,
          ttl: ttlConfig && ttlConfig.ttlMs,
          fetchedAt,
          config,
        }),
        // 组内决胜信号：记忆检索自带相关度，同组多条同源同时间戳时不再判平局弃权。
        relevance: Number.isFinite(result.relevance) ? result.relevance : null,
      });
    });

    return { status: 'ok', items, count: items.length };
  },
};

const userSource = {
  name: 'user',
  readonly: true,
  async fetch({ history, injected, config }) {
    // 注入覆盖优先（上层可显式提供带时间戳的用户消息/纠正，参与裁决）
    const injectedEntries = Array.isArray(injected.user) ? injected.user : [];
    if (injectedEntries.length) {
      const items = injectedEntries
        .map(entry =>
          makeItem({
            content: typeof entry.content === 'string' ? entry.content : '',
            source: 'user',
            type: 'user',
            verification: {
              status: 'user_confirmed',
              checked_items: ['user_stated'],
            },
            freshness: computeFreshness({
              type: 'user',
              ttl: null,
              fetchedAt: entry.fetchedAt || entry.createdAt || null,
              config,
            }),
          })
        )
        .filter(item => item.content);
      return { status: items.length ? 'ok' : 'no_result', items, count: items.length };
    }

    const recentUserMessages = (Array.isArray(history) ? history : [])
      .filter(m => m && m.role === 'user' && typeof m.content === 'string' && m.content.trim())
      .slice(-5)
      .map((m, i) =>
        makeItem({
          content: m.content,
          source: 'user',
          type: 'user',
          verification: {
            status: 'user_confirmed',
            checked_items: ['user_stated'],
          },
          freshness: computeFreshness({
            type: 'user',
            ttl: null,
            fetchedAt: m.createdAt || null,
            config,
          }),
          fromHistory: true,
        })
      );

    if (!recentUserMessages.length) {
      return { status: 'no_result', count: 0 };
    }
    return { status: 'ok', items: recentUserMessages, count: recentUserMessages.length };
  },
};

// doc / web：外部内容，一律不可信（untrusted=true），只按调用方注入的条目返回。
function externalSource(name) {
  return {
    name,
    readonly: true,
    async fetch({ injected, source }) {
      const entries = Array.isArray(injected[source]) ? injected[source] : [];
      if (!entries.length) {
        return { status: 'no_result', count: 0 };
      }

      const items = entries.map(entry =>
        makeItem({
          content: typeof entry.content === 'string' ? entry.content : '',
          source,
          type: source, // 'doc' | 'web'
          verification: {
            status: 'delivered',
            checked_items: [],
          },
          freshness: computeFreshness({
            type: source,
            ttl: null,
            fetchedAt: entry.fetchedAt || null,
            config: null,
          }),
          untrusted: true,
        })
      ).filter(item => item.content);

      return { status: items.length ? 'ok' : 'no_result', items, count: items.length };
    },
  };
}

const docSource = externalSource('doc');
const webSource = externalSource('web');

// tool 源：调用方注入工具结果摘要。验证等级 delivered（工具结果未经用户确认）。
// 条目类型默认 tool，但允许 entry.type 覆盖（如实时数据标 realtime_data，
// 走对应 TTL 语义）。
const toolSource = {
  name: 'tool',
  readonly: true,
  async fetch({ injected, config }) {
    const entries = Array.isArray(injected.tool) ? injected.tool : [];
    if (!entries.length) {
      return { status: 'no_result', count: 0 };
    }
    const items = entries.map(entry =>
      makeItem({
        content: typeof entry.content === 'string' ? entry.content : '',
        source: 'tool',
        type: entry.type || 'tool',
        verification: {
          status: 'delivered',
          checked_items: [],
        },
        freshness: computeFreshness({
          type: entry.type || 'tool',
          ttl: entry.ttl || null,
          fetchedAt: entry.fetchedAt || null,
          config,
        }),
      })
    ).filter(item => item.content);
    return { status: items.length ? 'ok' : 'no_result', items, count: items.length };
  },
};

const SOURCE_HANDLERS = {
  memory: memorySource,
  user: userSource,
  tool: toolSource,
  doc: docSource,
  web: webSource,
};

// ---- 主检索入口 ----
// 并行检索所有启用且未熔断的源；单源失败不影响其他源（v2.3 熔断粒度）。
// 返回 { items, sources: [{ source, status, count, error?, toolMissingKind? }] }。
async function retrieve({
  task,
  sessionId = null,
  history = [],
  enabledSources = ['memory'],
  injected = {},
  config = defaultConfig,
  now = Date.now(),
} = {}) {
  const results = [];
  const failures = [];

  const jobs = enabledSources
    .filter(source => SOURCE_HANDLERS[source])
    .map(async source => {
      const handler = SOURCE_HANDLERS[source];

      // 熔断（按源粒度）：熔断期间该源直接跳过，不调用
      if (isTripped(source, config, now)) {
        return {
          source,
          status: 'retrieval_error',
          count: 0,
          error: `数据源 ${source} 已熔断（暂时不可用）`,
          breaker: true,
        };
      }

      // 只读/幂等源失败才允许按策略重试（最多 maxRetries 次）
      const maxRetries = handler.readonly ? config.retry.maxRetries : 0;
      let lastOutcome = null;

      for (let attempt = 0; attempt <= maxRetries; attempt += 1) {
        try {
          lastOutcome = await handler.fetch({
            task,
            sessionId,
            history,
            injected,
            source,
            config,
          });
          break;
        } catch (error) {
          lastOutcome = {
            status: 'retrieval_error',
            count: 0,
            error: error && error.message ? error.message : '检索失败',
            retried: attempt < maxRetries,
          };
          if (attempt < maxRetries) {
            recordRetrievalFailure(source, config, now);
          }
        }
      }

      if (lastOutcome.status === 'retrieval_error') {
        recordRetrievalFailure(source, config, now);
      } else {
        resetBreaker(source);
      }

      return { source, ...lastOutcome };
    });

  const settled = await Promise.all(jobs);

  for (const outcome of settled) {
    results.push(...(outcome.items || []));
    failures.push({
      source: outcome.source,
      status: outcome.status,
      count: outcome.count || 0,
      ...(outcome.error ? { error: outcome.error } : {}),
      ...(outcome.toolMissingKind ? { toolMissingKind: outcome.toolMissingKind } : {}),
      ...(outcome.breaker ? { breaker: true } : {}),
    });
  }

  return { items: rankItems(results, task), sources: failures };
}

// 供测试/集成使用的失败分类辅助（区分 no_result / retrieval_error / tool_missing）
function classifySourceFailure(status, extra = {}) {
  if (status === 'tool_missing') {
    return {
      status,
      toolMissingKind: extra.kind === 'not_implemented' ? 'not_implemented' : 'not_found',
      error: extra.error || (extra.kind === 'not_implemented' ? '工具尚未实现' : '工具不存在'),
    };
  }
  if (status === 'retrieval_error') {
    return { status, error: extra.error || '检索失败（查询失败，非无结果）' };
  }
  return { status: 'no_result', count: 0 };
}

module.exports = {
  retrieve,
  computeFreshness,
  rankItems,
  classifySourceFailure,
  SOURCE_HANDLERS,
  resetBreaker,
  textLength,
};
