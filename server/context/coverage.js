/**
 * 云岫 Bluebird — Context Runtime v3 覆盖判定（coverage.js）
 *
 * 替代旧的 `fromHistory` 一刀切过滤：
 * - 检索条目与近期原文/长程召回/历史摘要做词面覆盖比较；
 * - 充分覆盖才跳过；部分覆盖保留为补充事实；未覆盖正常进入；
 * - 记忆与更新的用户陈述冲突时，以更新的用户陈述为准，并记录冲突，
 *   不让旧记忆静默覆盖当前事实。
 */
const { containment, jaccard, valuesDiffer } = require('./text');

const CONFLICT_NEGATION_RE = /(不|没|没有|别|禁止|取消|不是)/;

function conflictsWith(a, b) {
  const similarity = containment(a, b);
  if (similarity < 0.5) return null;

  const numsDiffer = valuesDiffer(a, b);
  const negationDiffers =
    CONFLICT_NEGATION_RE.test(String(a || '')) !==
    CONFLICT_NEGATION_RE.test(String(b || ''));

  if (!numsDiffer && !negationDiffers) return null;
  return {
    similarity: Math.round(similarity * 10000) / 10000,
    reason: numsDiffer ? 'same_topic_different_value' : 'same_topic_negation_differs',
  };
}

function buildCoverageContexts({ recent = [], recalled = [], summary = null } = {}) {
  const contexts = [];
  for (const entry of recent) {
    if (entry.message && entry.message.content) {
      contexts.push({ id: entry.message.id, kind: 'recent', text: entry.message.content });
    }
  }
  for (const entry of recalled) {
    if (entry.message && entry.message.content) {
      contexts.push({ id: entry.message.id, kind: 'recalled', text: entry.message.content });
    }
  }
  if (summary && summary.rendered) {
    contexts.push({ id: 'summary', kind: 'summary', text: summary.rendered });
  }
  return contexts;
}

function evaluateCoverage(item, contexts) {
  let best = { score: 0, against: null, kind: null };
  for (const context of contexts) {
    const score = containment(item.content, context.text);
    if (score > best.score) {
      best = { score, against: context.id, kind: context.kind };
    }
  }
  const rounded = Math.round(best.score * 10000) / 10000;
  return { ...best, score: rounded };
}

function dedupeRetrievalItems(items, contexts, config) {
  const accepted = [];
  const skipped = [];
  const retrieval = config.retrieval;

  const ordered = items
    .slice()
    .sort((a, b) => (b.relevance || 0) - (a.relevance || 0));

  for (const item of ordered) {
    const coverage = evaluateCoverage(item, contexts);

    if (coverage.score >= retrieval.coverageSkipThreshold) {
      skipped.push({
        id: item.id,
        source: item.source,
        reason: 'covered_by_context',
        score: coverage.score,
        against: coverage.against,
        stage: 'accepted',
      });
      continue;
    }

    // 检索条目之间的重复：只去掉高度重复的低分项，不做跨来源清空。
    const duplicate = accepted.find(other => {
      if (other.source !== item.source) return false;
      return jaccard(other.content, item.content) >= retrieval.pairwiseDedupeThreshold;
    });

    if (duplicate) {
      skipped.push({
        id: item.id,
        source: item.source,
        reason: 'duplicate_retrieval_item',
        score: Math.round(jaccard(duplicate.content, item.content) * 10000) / 10000,
        against: duplicate.id,
        stage: 'accepted',
      });
      continue;
    }

    accepted.push({
      ...item,
      coverage: {
        status:
          coverage.score >= retrieval.coveragePartialThreshold ? 'partial_supplement' : 'novel',
        score: coverage.score,
        against: coverage.against,
        kind: coverage.kind,
      },
    });
  }

  return { accepted, skipped };
}

// 记忆与近期用户陈述冲突：更新的用户消息在历史里，旧记忆不得压过它。
function findHistoryConflict(item, recentUserMessages) {
  for (let i = recentUserMessages.length - 1; i >= 0; i -= 1) {
    const message = recentUserMessages[i];
    const conflict = conflictsWith(item.content, message.content);
    if (!conflict) continue;

    const itemTime = item.freshness && item.freshness.fetched_at
      ? Date.parse(item.freshness.fetched_at)
      : 0;
    const messageTime = message.createdAt ? Date.parse(message.createdAt) : 0;
    const newerIsHistory = !Number.isFinite(itemTime) || !Number.isFinite(messageTime) || messageTime >= itemTime;

    return {
      messageId: message.id,
      messageCreatedAt: message.createdAt,
      similarity: conflict.similarity,
      reason: conflict.reason,
      resolution: newerIsHistory ? 'newer_user_history_wins' : 'memory_newer_keep',
    };
  }

  return null;
}

module.exports = {
  buildCoverageContexts,
  evaluateCoverage,
  dedupeRetrievalItems,
  findHistoryConflict,
  conflictsWith,
};
