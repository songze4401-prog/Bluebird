/**
 * 云岫 Bluebird — Context Runtime v3 历史选择（history.js）
 *
 * 目标：不再用"最近 N 条"作为唯一策略。
 * - 近期原文：按真实模型消息的 token 预算从新到旧装入，保证时间顺序与完整性；
 * - 长程召回：对近期窗口之外的旧消息按当前任务做词面/实体/回指匹配，
 *   命中者以原文摘录进入独立上下文块（不伪造对话轮次）；
 * - 其余旧消息交给摘要模块做抽取式摘要，保留来源标识。
 *
 * 本模块是纯函数：输入投影消息、查询与预算，输出可复现的选择结果。
 */
const {
  estimateModelTokens,
  overlapScore,
  entityOverlap,
} = require('./text');

const BACK_REFERENCE_RE =
  /(之前|刚才|上次|前面|早先|我说过|提过|还记得|继续|接着|那个|那件事|上回|先前)/;

function hasBackReference(query) {
  return BACK_REFERENCE_RE.test(String(query || ''));
}

function scoreMessage({ message, query, index, total, backReference, backReferenceBoost = 0.15 }) {
  const content = message.content || '';
  const lexical = overlapScore(query, content);
  const entity = entityOverlap(query, content);
  // 回指词表示用户明确指向更早内容：给旧消息一个与"越近越优先"相反的补偿。
  const backrefBoost = backReference
    ? (1 - index / Math.max(total, 1)) * backReferenceBoost
    : 0;
  const roleBoost = message.role === 'user' ? 0.05 : 0;
  const recencyBoost = total > 0 ? (index / total) * 0.05 : 0;

  return {
    score: Math.round((lexical + entity * 0.2 + backrefBoost + roleBoost + recencyBoost) * 10000) / 10000,
    lexical: Math.round(lexical * 10000) / 10000,
    entity: Math.round(entity * 10000) / 10000,
    backrefBoost: Math.round(backrefBoost * 10000) / 10000,
  };
}

function selectHistory({
  messages = [],
  query = '',
  render,
  config,
  perImageTokens = 1024,
  overheadTokens = 4,
}) {
  const historyConfig = config.history;
  const rendered = [];

  for (const message of messages) {
    let modelMessage = null;
    try {
      modelMessage = typeof render === 'function' ? render(message) : null;
    } catch (_) {
      modelMessage = null;
    }

    if (!modelMessage) {
      rendered.push({
        message,
        modelMessage: null,
        cost: 0,
        reason: 'empty_model_message',
      });
      continue;
    }

    rendered.push({
      message,
      modelMessage,
      cost: estimateModelTokens(modelMessage, { perImageTokens, overheadTokens }),
    });
  }

  const usable = rendered.filter(entry => entry.modelMessage);
  const recent = [];
  const omitted = [];
  let recentTokens = 0;
  let recentStart = usable.length;

  for (let i = usable.length - 1; i >= 0; i -= 1) {
    const entry = usable[i];
    const mustKeep = recent.length < historyConfig.minRecentMessages;

    if (!mustKeep && recentTokens + entry.cost > historyConfig.recentBudgetTokens) {
      break;
    }

    recent.unshift(entry);
    recentTokens += entry.cost;
    recentStart = i;
  }

  for (const entry of rendered) {
    if (!entry.modelMessage) {
      omitted.push({
        messageId: entry.message.id,
        index: entry.message.index,
        stage: 'omitted',
        reason: entry.reason,
      });
    }
  }

  const older = usable.slice(0, recentStart);
  const backReference = hasBackReference(query);
  const scored = older.map(entry =>
    ({
      ...entry,
      ...scoreMessage({
        message: entry.message,
        query,
        index: entry.message.index,
        total: messages.length,
        backReference,
        backReferenceBoost: historyConfig.backReferenceBoost,
      }),
    })
  );

  const qualified = scored
    .filter(entry => {
      // 短消息（"好的""嗯"）没有独立回忆价值，除非实体/词面命中很高。
      const short = (entry.message.content || '').trim().length < 4;
      const threshold = short ? Math.max(historyConfig.longRangeThreshold, 0.5) : historyConfig.longRangeThreshold;
      return entry.score >= threshold && entry.lexical + entry.entity > 0;
    })
    .sort((a, b) => b.score - a.score || b.message.index - a.message.index);

  const recalledEntries = [];
  const recalledIds = new Set();
  const recentIds = new Set(recent.map(entry => entry.message.id));
  let recalledTokens = 0;

  const tryRecall = entry => {
    if (!entry || recalledIds.has(entry.message.id)) return false;
    if (recentIds.has(entry.message.id)) return false;
    if (recalledEntries.length >= historyConfig.longRangeMaxItems) return false;
    if (recalledTokens + entry.cost > historyConfig.longRangeBudgetTokens) return false;
    recalledEntries.push(entry);
    recalledIds.add(entry.message.id);
    recalledTokens += entry.cost;
    return true;
  };

  for (const entry of qualified) {
    const added = tryRecall(entry);
    if (!added) continue;

    // 助手回复依赖上一句用户提问才有意义：配对召回，但不越过预算。
    if (entry.message.role === 'assistant') {
      const previous = older.find(
        candidate =>
          candidate.message.index === entry.message.index - 1 &&
          candidate.message.role === 'user'
      );
      if (previous) tryRecall(previous);
    }
  }

  recalledEntries.sort((a, b) => a.message.index - b.message.index);

  const summaryInput = older
    .filter(entry => !recalledIds.has(entry.message.id))
    .map(entry => entry.message);

  const decisions = [];
  for (const entry of rendered) {
    if (!entry.modelMessage) continue;
    const id = entry.message.id;
    const recentEntry = recent.find(item => item.message.id === id);
    if (recentEntry) {
      decisions.push({
        messageId: id,
        index: entry.message.index,
        stage: 'recent',
        reason: '近期原文：在 recentBudgetTokens 内按时间顺序保留',
      });
      continue;
    }
    const recalled = recalledEntries.find(item => item.message.id === id);
    if (recalled) {
      decisions.push({
        messageId: id,
        index: entry.message.index,
        stage: 'recalled',
        reason: `长程召回：相关度 ${recalled.score.toFixed(3)}（词面 ${recalled.lexical.toFixed(3)} / 实体 ${recalled.entity.toFixed(3)}）`,
        score: recalled.score,
      });
      continue;
    }
    decisions.push({
      messageId: id,
      index: entry.message.index,
      stage: 'summarized',
      reason: '近期窗口之外：进入抽取式历史摘要',
    });
  }
  decisions.push(...omitted);

  return {
    ok: true,
    recent,
    recalled: recalledEntries,
    summaryInput,
    decisions,
    tokens: {
      recent: recentTokens,
      recalled: recalledTokens,
      summaryInputMessages: summaryInput.length,
      totalMessages: messages.length,
    },
    recentStartIndex: recent.length ? recent[0].message.index : null,
    backReference,
  };
}

module.exports = {
  selectHistory,
  scoreMessage,
  hasBackReference,
  BACK_REFERENCE_RE,
};
