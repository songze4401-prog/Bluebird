/**
 * 云岫 Bluebird — Context Engine 外部知识入口（context/knowledge.js）
 *
 * 只检索 document / web / code 三类外部知识；记忆仍走原有
 * context/retriever.js，历史对话仍走 history.js。这样统一检索服务是
 * 五类来源的共同底座，但不会把同一份记忆/对话重复注入提示词。
 *
 * 失败语义：检索失败只降级本轮外部知识块，不影响聊天主链路；错误码与
 * trace 保留在上下文 trace 中，绝不把“索引不可用”当成“没有知识”。
 */
const retrieval = require('../retrieval');

function mapFreshness(freshness) {
  if (!freshness) return { status: 'unknown', fetched_at: null, label: '时效未知' };
  return {
    status: freshness.status,
    fetched_at: freshness.fetched_at,
    label: freshness.label,
  };
}

async function retrieveKnowledge({ task, sessionId = null, now = Date.now() } = {}) {
  if (!retrieval.config.enabled || !retrieval.config.contextEnabled) {
    return { status: 'disabled', count: 0, items: [], trace: null };
  }

  const query = typeof task === 'string' ? task.trim() : '';
  if (!query) {
    return { status: 'no_result', count: 0, items: [], trace: null };
  }

  try {
    const outcome = await retrieval.searchForContext({
      query,
      sessionId,
      now,
    });

    if (outcome.status === 'error') {
      return {
        status: 'error',
        count: 0,
        items: [],
        trace: outcome.trace || null,
        errorCode: outcome.errorCode,
        error: outcome.error,
      };
    }

    const items = (outcome.items || []).map(item => ({
      ...item,
      id: `knowledge:${item.id}`,
      freshness: mapFreshness(item.freshness),
    }));

    return {
      status: items.length ? 'ok' : 'no_result',
      count: items.length,
      items,
      trace: outcome.trace || null,
      degraded: outcome.degraded || [],
      ...(outcome.errorCode ? { errorCode: outcome.errorCode } : {}),
    };
  } catch (error) {
    return {
      status: 'error',
      count: 0,
      items: [],
      trace: null,
      errorCode: (error && error.code) || 'knowledge_retrieval_failed',
      error: '外部知识检索失败',
    };
  }
}

module.exports = { retrieveKnowledge };
