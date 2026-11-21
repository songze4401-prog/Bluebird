// 记忆读侧 CRUD 与删除簇（健康度审计 R5，2026-11-21 自 memory.js 迁出）。
//
// 职责：clearMemories（按用户清空）/ clearSessionMemories（按会话清理）/
// recallMemoryBySourceQuote（按原话撤回，B3 风格有界写）/ deleteMemory
// （按 id+createdAt 删除）。四个都是写路径操作（经写队列+墓碑+派生索引）。
//
// 设计边界（勿破坏）：
// - 写路径经共享容器 server/memory-core.js（state-holder 16 键，本刀
//   零新增键）：getMemoryList/setMemoryList 是 memories 的唯一读写通道，
//   enqueueWrite/commitWithTombstones/refreshDerivedMemoryIndex/
//   memoryEnabled 经容器。
// - 零回边：不 require memory.js。同层依赖：cleanText/normalize←
//   memory-ranking、STATUS_ACTIVE←memory-lifecycle、ownerAllows←
//   memory-retrieval。
// - recallMemoryBySourceQuote 刻意不调用 loadMemories()——它会重置
//   内存数组，不适合作为读取入口（原注释保留在函数头）。
//
// 消费方：memory.js 经解构回注（module.exports 四操作），调用点零改动。
const { memoryCore } = require('./memory-core');
const { cleanText, normalize, similarity } = require('./memory-ranking');
const { STATUS_ACTIVE } = require('./memory-lifecycle');
const { ownerAllows } = require('./memory-retrieval');
// 清空整库。removedEntries 是真正被删掉的条目数（含已被更正的历史条目），
// 回 0 会让调用方以为「库本来就是空的」。
//
// userId 非空时只清掉该用户名下的条目：管理接口在多用户下不能"清空别人的记忆"。
async function clearMemories(userId = null) {
  const owner = cleanText(userId);

  return memoryCore().enqueueWrite(async () => {
    const currentList = memoryCore().getMemoryList();
    const current = Array.isArray(currentList) ? currentList : [];
    const remaining = owner
      ? current.filter(item => !ownerAllows(item, owner))
      : [];
    const removed = current.filter(item => !remaining.includes(item));
    const removedEntries = removed.length;

    await memoryCore().commitWithTombstones(
      remaining,
      removed,
      owner ? 'clear_user' : 'clear'
    );

    memoryCore().setMemoryList(remaining);

    memoryCore().refreshDerivedMemoryIndex(owner ? 'clear_user' : 'clear');

    console.log(`Memory cleared: ${removedEntries}`);

    return { removedEntries, cleared: true };
  });
}

// 按会话清理：只摘掉登记在该会话名下的贡献，贡献被摘空的条目整条删除。
// 别的会话说过的同一事实（还有其它贡献）必须留着 —— 与撤回同一条规则，
// 否则"删掉我这个会话的记忆"会把别人的会话记录一并抹掉。
async function clearSessionMemories(sessionId, userId = null) {
  const target = cleanText(sessionId);
  const owner = cleanText(userId);

  if (!target) {
    return {
      removedEntries: 0,
      removedContributions: 0,
      remaining: Array.isArray(memoryCore().getMemoryList())
        ? memoryCore().getMemoryList().length
        : 0,
      reason: 'invalid',
    };
  }

  return memoryCore().enqueueWrite(async () => {
    const currentList = memoryCore().getMemoryList();
    const current = Array.isArray(currentList) ? currentList : [];

    const remaining = [];
    const removedForTombstone = [];
    let removedEntries = 0;
    let removedContributions = 0;

    for (const item of current) {
      // 不属于该用户的条目一律原样保留（多用户下不能借 sessionId 越界删除）。
      if (!ownerAllows(item, owner)) {
        remaining.push(item);
        continue;
      }

      const contributions = Array.isArray(item.contributions)
        ? item.contributions
        : [];

      const kept = contributions.filter(
        contribution => !contribution || contribution.sessionId !== target
      );

      if (kept.length === contributions.length) {
        remaining.push(item);

        continue;
      }

      const removed = contributions.filter(
        contribution => contribution && contribution.sessionId === target
      );

      if (removed.length) {
        removedForTombstone.push({ ...item, contributions: removed });
      }

      removedContributions += contributions.length - kept.length;

      if (kept.length) {
        remaining.push({ ...item, contributions: kept, updatedAt: new Date().toISOString() });
      } else {
        removedEntries += 1;
      }
    }

    if (!removedEntries && !removedContributions) {
      return {
        removedEntries: 0,
        removedContributions: 0,
        remaining: current.length,
        reason: 'no-match',
      };
    }

    await memoryCore().commitWithTombstones(
      remaining,
      removedForTombstone,
      'clear_session'
    );

    memoryCore().setMemoryList(remaining);

    memoryCore().refreshDerivedMemoryIndex('clear_session');

    console.log(
      `Memory session cleared: ${target} entries=${removedEntries} contributions=${removedContributions}`
    );

    return {
      removedEntries,
      removedContributions,
      remaining: remaining.length,
      reason: 'ok',
    };
  });
}

// 撤回用户消息时，同步撤回由该消息产生的长期记忆。
// 通过贡献自身的 sourceQuote 与原文做包含/相似度匹配，并用时间窗防止误删无关记忆。
// 归属规则（E2 + 贡献列表）：
//   1) 优先只摘掉 sourceQuote 匹配且同为"本会话"的那条贡献；
//   2) 本会话没有任何匹配时，回退摘掉"无归属"的旧贡献（引入 sessionId 之前
//      写入的记忆，没有会话信息，按旧行为处理）；
//   3) 其他会话的贡献一律不动 —— 这正是旧实现里"A 会话撤回误删 B 会话
//      同内容记忆"的漏洞；
//   4) 贡献被摘空的记忆整条删除；还有别的会话贡献撑着时，记忆保留。
// 返回两个计数：摘掉的贡献数 + 删除的条目数。只返回条目数时，
// 「摘掉一条贡献、条目还在」和「什么都没匹配上」在调用方眼里都是 0。
async function recallMemoryBySourceQuote(
  sourceText,
  sourceCreatedAt,
  sessionId = null,
  sourceMessageId = null
) {
  const empty = { removedEntries: 0, removedContributions: 0 };

  if (!memoryCore().memoryEnabled) return empty;

  const source = normalize(sourceText);
  if (!source) return empty;

  const sourceTime = sourceCreatedAt
    ? new Date(sourceCreatedAt).getTime()
    : null;
  const targetMessageId = cleanText(sourceMessageId);

  const targetSessionId = cleanText(sessionId);

  // 单条贡献是否与本条被撤回消息匹配（文本 + 时间窗）。
  // 有 messageId 时优先按来源消息精确定位；旧贡献没有 messageId，才退回文本+时间窗。
  const isMatch = contribution => {
    if (targetMessageId && contribution && contribution.messageId) {
      return contribution.messageId === targetMessageId;
    }

    const quote = normalize(contribution && contribution.sourceQuote);

    if (!quote) return false;

    const textMatch =
      quote === source ||
      (quote.length >= 4 && source.includes(quote)) ||
      similarity(quote, source) >= 0.7;

    if (!textMatch) return false;

    const contributionTime =
      contribution && contribution.createdAt
        ? new Date(contribution.createdAt).getTime()
        : null;

    return (
      sourceTime === null ||
      contributionTime === null ||
      (contributionTime >= sourceTime - 5000 &&
        contributionTime <= sourceTime + 2 * 60 * 60 * 1000)
    );
  };

  return memoryCore().enqueueWrite(async () => {
    const currentList = memoryCore().getMemoryList();
    const current = Array.isArray(currentList) ? currentList : [];

    // 本会话名下是否存在任何匹配贡献
    const hasPrimaryMatch = current.some(
      item =>
        Array.isArray(item.contributions) &&
        item.contributions.some(
          contribution =>
            contribution.sessionId === targetSessionId &&
            isMatch(contribution)
        )
    );

    // 本会话没有任何匹配时，才回退到无归属旧贡献；其他会话的贡献永不动。
    const useFallback = !hasPrimaryMatch;

    const isTargeted = contribution =>
      useFallback
        ? contribution.sessionId === null
        : contribution.sessionId === targetSessionId;

    const remaining = [];
    const removedForTombstone = [];
    let removedContributions = 0;

    for (const item of current) {
      const contributions = Array.isArray(item.contributions)
        ? item.contributions
        : [];

      const removed = contributions.filter(
        contribution => isTargeted(contribution) && isMatch(contribution)
      );
      const kept = contributions.filter(
        contribution => !(isTargeted(contribution) && isMatch(contribution))
      );

      if (removed.length) {
        removedForTombstone.push({ ...item, contributions: removed });
      }

      removedContributions += contributions.length - kept.length;

      if (!contributions.length || kept.length) {
        remaining.push(
          kept.length === contributions.length
            ? item
            : { ...item, contributions: kept }
        );
      }
      // 贡献被摘空的记忆整条删除
    }

    const removedEntries = current.length - remaining.length;

    if (!removedContributions && !removedEntries) return empty;

    await memoryCore().commitWithTombstones(remaining, removedForTombstone, 'recall');

    memoryCore().setMemoryList(remaining);

    memoryCore().refreshDerivedMemoryIndex('recall');

    console.log(
      `Memory recalled: entries=${removedEntries} contributions=${removedContributions}`
    );

    return { removedEntries, removedContributions };
  });
}

// 记忆库单条删除。定位方式两种都支持，新的优先：
//   1) id —— 稳定身份，前端与接口都应改用这个；
//   2) createdAt + content —— 旧数据与旧客户端仍在用的定位键，保留不废。
// 必须走 enqueueWrite，与 processMemory 的自动写入串行化，
// 否则会出现"用户刚删除 → 后台提取写入"把这次删除覆盖掉。
async function deleteMemory({ id, createdAt, content, userId = null } = {}) {
  const targetId = cleanText(id);
  const targetCreatedAt = typeof createdAt === 'string' ? createdAt : '';
  const targetContent = typeof content === 'string' ? content : '';
  const owner = cleanText(userId);

  if (!targetId && !(targetCreatedAt && targetContent)) {
    return { removed: 0, reason: 'invalid' };
  }

  return memoryCore().enqueueWrite(async () => {
    const currentList = memoryCore().getMemoryList();
    const current = Array.isArray(currentList) ? currentList : [];

    const index = current.findIndex(item => {
      if (!item) return false;

      if (targetId) return item.id === targetId;

      return (
        item.createdAt === targetCreatedAt && item.content === targetContent
      );
    });

    if (index < 0) {
      return { removed: 0, reason: 'not-found' };
    }

    // 归属不符：不删、不暴露目标是否存在（reason 与 not-found 同属拒绝语义，
    // 但分开返回便于调用方区分"不存在"与"无权"）。
    if (!ownerAllows(current[index], owner)) {
      return { removed: 0, reason: 'forbidden' };
    }

    const next = current.slice();
    const removedItem = next[index];

    next.splice(index, 1);

    await memoryCore().commitWithTombstones(next, [removedItem], 'delete');

    memoryCore().setMemoryList(next);

    memoryCore().refreshDerivedMemoryIndex('delete');
    memoryCore().logLifecycleEvent({
      action: 'delete',
      from: removedItem ? removedItem.status || STATUS_ACTIVE : null,
      to: 'deleted',
      id: removedItem ? removedItem.id : null,
      reason: 'user_deleted',
    });

    console.log('Memory deleted');

    return {
      removed: 1,
      reason: 'ok',
      id: removedItem ? removedItem.id : null,
    };
  });
}



module.exports = {
  clearMemories,
  clearSessionMemories,
  recallMemoryBySourceQuote,
  deleteMemory,
};
