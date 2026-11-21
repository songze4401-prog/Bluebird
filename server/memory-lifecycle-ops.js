// 记忆生命周期变更簇（健康度审计 R4，2026-11-21 自 memory.js 迁出）。
//
// 职责：记忆条目的显式生命周期裁决——confirmPending（确认待确认候选，
// 含 pendingTargetId/contestedIds 级联）/ rejectPending / archiveMemory /
// updateMemory / mergeMemories（330 行，合并与待确认晋升）/ supersedeMemory /
// withdrawMemory（按会话撤回），加 #122 的存量收敛工具
// （planPendingConsolidation/consolidatePendingDuplicates）与辅助件
// （archiveContestedForConfirmation/maintenanceDate/stripHedgePendingMark/
// PENDING_CANDIDATE_MATCH_MIN）。
//
// 设计边界（勿破坏）：
// - 写路径经共享容器 server/memory-core.js（state-holder 统一设计，
//   R3a 后 16 键，本刀零新增键）：getMemoryList/setMemoryList 是
//   memories 的唯一读写通道，enqueueWrite/saveMemories/commitWithTombstones/
//   refreshDerivedMemoryIndex/logLifecycle*/logDataEvent/trimToCapacity/
//   maintenanceKeywords/memoryFile 全部经容器。
// - 零回边：不 require memory.js。同层依赖：ownerAllows←memory-retrieval、
//   issuedId/mergeContributions←memory-extraction、feedbackDecision/
//   appendFeedbackHistory←memory-feedback、cleanText/similarity/
//   ALLOWED_TYPES←memory-ranking、STATUS_*/canTransition/isPending/
//   isEffectiveAt←memory-lifecycle、DECISION←memory-decision。
// - confirmPending 与 feedback 三联同级协作（R3a 拆分时已确认互不调用）。
//
// 消费方：memory.js 经解构回注（module.exports 的九个操作 + 留守写路径
// 的 stripHedgePendingMark/PENDING_CANDIDATE_MATCH_MIN 3+1 处调用），调用点零改动。
const { memoryCore } = require('./memory-core');
const {
  ALLOWED_TYPES,
  cleanText,
  similarity,
} = require('./memory-ranking');
const {
  STATUS_ACTIVE,
  STATUS_ARCHIVED,
  STATUS_CONTESTED,
  STATUS_PENDING,
  STATUS_SUPERSEDED,
  canTransition,
  isEffectiveAt,
  isPending,
} = require('./memory-lifecycle');
const { DECISION } = require('./memory-decision');
const { issuedId, mergeContributions, HEDGE_PENDING_MARK } = require('./memory-extraction');
const { ownerAllows } = require('./memory-retrieval');
const { feedbackDecision, appendFeedbackHistory } = require('./memory-feedback');
const PENDING_CANDIDATE_MATCH_MIN = 0.9;
function stripHedgePendingMark(value) {
  return typeof value === 'string' && value.startsWith(HEDGE_PENDING_MARK)
    ? value.slice(HEDGE_PENDING_MARK.length)
    : value;
}
function archiveContestedForConfirmation(list, contestedIds, now) {
  if (!Array.isArray(contestedIds) || !contestedIds.length) return list;

  const idSet = new Set(contestedIds);

  return list.map(entry => {
    if (!entry || !idSet.has(entry.id) || entry.status !== STATUS_CONTESTED) {
      return entry;
    }

    if (!canTransition(entry.status, STATUS_ARCHIVED)) return entry;

    memoryCore().logLifecycleEvent({
      action: 'archive',
      from: entry.status,
      to: STATUS_ARCHIVED,
      id: entry.id,
      reason: 'contested_replaced_by_confirmation',
    });

    return {
      ...entry,
      status: STATUS_ARCHIVED,
      validTo: entry.validTo || now,
      archivedReason: 'contested_replaced_by_confirmation',
      updatedAt: now,
      lastDecision: {
        action: 'archive',
        reason: 'contested_replaced_by_confirmation',
        at: now,
        actor: 'user',
        sourceType: 'user',
      },
    };
  });
}

async function confirmPending(id, userId = null, options = {}) {
  const targetId = cleanText(id);
  const owner = cleanText(userId);
  const feedbackId = cleanText(options.feedbackId);

  if (!targetId) return { updated: 0, reason: 'invalid' };

  return memoryCore().enqueueWrite(async () => {
    const currentList = memoryCore().getMemoryList();
    const current = Array.isArray(currentList) ? currentList : [];
    const index = current.findIndex(item => item && item.id === targetId);

    if (index < 0) return { updated: 0, reason: 'not-found' };

    if (!ownerAllows(current[index], owner)) {
      return { updated: 0, reason: 'forbidden' };
    }

    const item = current[index];

    if (!isPending(item) || !canTransition(STATUS_PENDING, STATUS_ACTIVE)) {
      memoryCore().logLifecycleRejection({
        action: 'confirm',
        from: item.status || null,
        id: targetId,
        reason: 'not-pending',
      });
      return { updated: 0, reason: 'not-pending' };
    }

    const {
      pendingReason,
      pendingAt,
      pendingTargetId,
      pendingMutation,
      contestedIds,
      ...rest
    } = item;
    const now = new Date().toISOString();
    const next = current.slice();
    const targetIndex = pendingTargetId
      ? current.findIndex(
          candidate =>
            candidate &&
            candidate.id === pendingTargetId &&
            isEffectiveAt(candidate)
        )
      : -1;

    if (targetIndex >= 0) {
      const target = current[targetIndex];

      if (pendingMutation === DECISION.SUPERSEDE) {
        const decision = feedbackDecision(
          'confirm',
          'user_confirmed_supersede',
          feedbackId,
          now
        );
        const replacement = {
          ...rest,
          status: STATUS_ACTIVE,
          validFrom: now,
          validTo: item.validTo || null,
          supersededBy: null,
          supersedes: target.id,
          confirmationCount: (Number(item.confirmationCount) || 0) + 1,
          lastConfirmedAt: now,
          updatedAt: now,
          lastDecision: decision,
          feedbackHistory: appendFeedbackHistory(item, decision),
        };
        const rewritten = current
          .filter((_, position) => position !== index)
          .map(candidate =>
            candidate.id === target.id
              ? {
                  ...candidate,
                  status: STATUS_SUPERSEDED,
                  validTo: now,
                  supersededBy: item.id,
                  updatedAt: now,
                  lastDecision: {
                    action: 'confirm_supersede',
                    reason: 'user_confirmed_supersede',
                    at: now,
                    actor: 'user',
                    sourceType: 'user',
                  },
                }
              : candidate
          );
        rewritten.push(replacement);

        const resolved = archiveContestedForConfirmation(
          rewritten,
          contestedIds,
          now
        );

        await memoryCore().saveMemories(resolved);
        memoryCore().setMemoryList(resolved);
        memoryCore().refreshDerivedMemoryIndex('confirm_supersede');
        memoryCore().logLifecycleEvent({
          action: 'confirm',
          from: STATUS_PENDING,
          to: STATUS_ACTIVE,
          id: replacement.id,
          reason: 'user_confirmed_supersede',
        });

        return {
          updated: 1,
          reason: 'ok',
          id: replacement.id,
          supersededId: target.id,
          status: STATUS_ACTIVE,
        };
      }

      const decision = feedbackDecision(
        'confirm',
        'user_confirmed_update',
        feedbackId,
        now
      );
      next[targetIndex] = {
        ...target,
        content: item.content,
        type: item.type,
        keywords: item.keywords,
        confidence: item.confidence,
        validTo: item.validTo || null,
        supersededBy: null,
        contributions: mergeContributions(
          target.contributions,
          item.contributions
        ),
        confirmationCount: (Number(item.confirmationCount) || 0) + 1,
        lastConfirmedAt: now,
        updatedAt: now,
        lastDecision: decision,
        feedbackHistory: appendFeedbackHistory(target, decision),
      };
      next.splice(index, 1);

      const resolved = archiveContestedForConfirmation(
        next,
        contestedIds,
        now
      );

      await memoryCore().saveMemories(resolved);
      memoryCore().setMemoryList(resolved);
      memoryCore().refreshDerivedMemoryIndex('confirm_update');
      memoryCore().logLifecycleEvent({
        action: 'confirm',
        from: STATUS_PENDING,
        to: STATUS_ACTIVE,
        id: target.id,
        reason: 'user_confirmed_update',
      });

      return {
        updated: 1,
        reason: 'ok',
        id: target.id,
        status: STATUS_ACTIVE,
      };
    }

    const decision = feedbackDecision(
      'confirm',
      'user_confirmed',
      feedbackId,
      now
    );
    next[index] = {
      ...rest,
      status: STATUS_ACTIVE,
      validFrom: now,
      validTo: item.validTo || null,
      supersededBy: null,
      confirmationCount: (Number(item.confirmationCount) || 0) + 1,
      lastConfirmedAt: now,
      updatedAt: now,
      lastDecision: decision,
      feedbackHistory: appendFeedbackHistory(item, decision),
    };

    const resolved = archiveContestedForConfirmation(
      next,
      contestedIds,
      now
    );

    await memoryCore().saveMemories(resolved);
    memoryCore().setMemoryList(resolved);
    memoryCore().refreshDerivedMemoryIndex('confirm');
    memoryCore().logLifecycleEvent({
      action: 'confirm',
      from: STATUS_PENDING,
      to: STATUS_ACTIVE,
      id: targetId,
      reason: 'user_confirmed',
    });

    return { updated: 1, reason: 'ok', id: targetId, status: STATUS_ACTIVE };
  });
}

async function rejectPending(id, userId = null) {
  const targetId = cleanText(id);
  const owner = cleanText(userId);

  if (!targetId) return { removed: 0, reason: 'invalid' };

  return memoryCore().enqueueWrite(async () => {
    const currentList = memoryCore().getMemoryList();
    const current = Array.isArray(currentList) ? currentList : [];
    const index = current.findIndex(item => item && item.id === targetId);

    if (index < 0) return { removed: 0, reason: 'not-found' };

    if (!ownerAllows(current[index], owner)) {
      return { removed: 0, reason: 'forbidden' };
    }

    if (!isPending(current[index]) || !canTransition(STATUS_PENDING, 'deleted')) {
      return { removed: 0, reason: 'not-pending' };
    }

    const next = current.slice();
    const rejected = next[index];
    next.splice(index, 1);

    // 拒绝是对该候选来源的显式撤销：只记哈希/来源标识，阻止异步重试复活。
    await memoryCore().commitWithTombstones(next, [rejected], 'reject_pending');
    memoryCore().setMemoryList(next);
    memoryCore().logLifecycleEvent({
      action: 'reject',
      from: STATUS_PENDING,
      to: 'deleted',
      id: targetId,
      reason: 'user_rejected_pending',
    });

    return { removed: 1, reason: 'ok', id: targetId };
  });
}

async function archiveMemory(id, userId = null) {
  const targetId = cleanText(id);
  const owner = cleanText(userId);

  if (!targetId) return { updated: 0, reason: 'invalid' };

  return memoryCore().enqueueWrite(async () => {
    const currentList = memoryCore().getMemoryList();
    const current = Array.isArray(currentList) ? currentList : [];
    const index = current.findIndex(item => item && item.id === targetId);

    if (index < 0) return { updated: 0, reason: 'not-found' };

    if (!ownerAllows(current[index], owner)) {
      return { updated: 0, reason: 'forbidden' };
    }

    const item = current[index];
    const status = item.status || STATUS_ACTIVE;

    if (!canTransition(status, STATUS_ARCHIVED)) {
      memoryCore().logLifecycleRejection({
        action: 'archive',
        from: status,
        id: targetId,
        reason: 'invalid-state',
      });
      return { updated: 0, reason: 'invalid-state' };
    }

    const now = new Date().toISOString();
    const next = current.slice();

    next[index] = {
      ...item,
      status: STATUS_ARCHIVED,
      validTo: item.validTo || now,
      updatedAt: now,
      lastDecision: {
        action: 'archive',
        reason: 'user_archived',
        at: now,
        actor: 'user',
        sourceType: 'user',
      },
    };

    await memoryCore().saveMemories(next);
    memoryCore().setMemoryList(next);

    memoryCore().refreshDerivedMemoryIndex('archive');
    memoryCore().logLifecycleEvent({
      action: 'archive',
      from: status,
      to: STATUS_ARCHIVED,
      id: targetId,
      reason: 'user_archived',
    });

    return { updated: 1, reason: 'ok', id: targetId, status: STATUS_ARCHIVED };
  });
}

// ---- 显式维护服务（供审批执行器与 Memory Center 使用） ----
// 这些方法不替代自动写入决策；它们只在用户已批准的前提下修改现有条目，
// 并复用同一份内存状态、写队列与原子落盘规则。
function maintenanceDate(value) {
  if (value === null || value === '') return null;
  if (typeof value !== 'string' || !Number.isFinite(Date.parse(value))) return undefined;
  return value;
}

async function updateMemory({
  id,
  content,
  type,
  keywords,
  confidence,
  validFrom,
  validTo,
  condition,
  actor = 'user',
} = {}) {
  const targetId = cleanText(id);
  if (!targetId) return { updated: 0, reason: 'invalid' };
  if (
    content === undefined &&
    type === undefined &&
    keywords === undefined &&
    confidence === undefined &&
    validFrom === undefined &&
    validTo === undefined &&
    condition === undefined
  ) {
    return { updated: 0, reason: 'no_changes' };
  }

  return memoryCore().enqueueWrite(async () => {
    const currentList = memoryCore().getMemoryList();
    const current = Array.isArray(currentList) ? currentList : [];
    const index = current.findIndex(item => item && item.id === targetId);
    if (index < 0) return { updated: 0, reason: 'not-found' };

    const item = current[index];
    const status = item.status || STATUS_ACTIVE;
    if (status !== STATUS_ACTIVE) {
      return { updated: 0, reason: 'invalid-state' };
    }

    const updated = { ...item };
    if (content !== undefined) {
      const value = cleanText(content);
      if (!value || value.length > 100) return { updated: 0, reason: 'invalid_content' };
      updated.content = value;
    }
    if (type !== undefined) {
      if (!ALLOWED_TYPES.has(type)) return { updated: 0, reason: 'type_not_allowed' };
      updated.type = type;
    }
    if (keywords !== undefined) {
      const value = memoryCore().maintenanceKeywords(keywords);
      if (value === null) return { updated: 0, reason: 'invalid_keywords' };
      updated.keywords = value;
    }
    if (confidence !== undefined) {
      const value = Number(confidence);
      if (!Number.isFinite(value) || value < 0 || value > 1) {
        return { updated: 0, reason: 'invalid_confidence' };
      }
      updated.confidence = value;
    }
    if (validFrom !== undefined) {
      const value = maintenanceDate(validFrom);
      if (value === undefined) return { updated: 0, reason: 'invalid_valid_from' };
      updated.validFrom = value || updated.validFrom;
    }
    if (validTo !== undefined) {
      const value = maintenanceDate(validTo);
      if (value === undefined) return { updated: 0, reason: 'invalid_valid_to' };
      updated.validTo = value;
    }
    if (condition !== undefined) {
      const value = cleanText(condition);
      if (value.length > 80) return { updated: 0, reason: 'condition_too_long' };
      updated.condition = value || null;
    }

    const now = new Date().toISOString();
    updated.updatedAt = now;
    updated.lastDecision = {
      action: 'update',
      reason: 'approved_update',
      at: now,
      actor,
      sourceType: 'user',
    };

    const next = current.slice();
    next[index] = updated;
    await memoryCore().saveMemories(next);
    memoryCore().setMemoryList(next);
    return { updated: 1, reason: 'ok', id: targetId, status: STATUS_ACTIVE };
  });
}

async function mergeMemories({
  targetId,
  sourceIds,
  content,
  keywords,
  actor = 'user',
} = {}) {
  const target = cleanText(targetId);
  const sources = [...new Set(
    (Array.isArray(sourceIds) ? sourceIds : [])
      .filter(item => typeof item === 'string')
      .map(item => item.trim())
      .filter(Boolean)
  )].filter(item => item !== target);

  if (!target || !sources.length) return { updated: 0, reason: 'invalid' };
  if (content !== undefined) {
    const value = cleanText(content);
    if (!value || value.length > 100) return { updated: 0, reason: 'invalid_content' };
  }
  const extraKeywords = keywords === undefined ? [] : memoryCore().maintenanceKeywords(keywords);
  if (extraKeywords === null) return { updated: 0, reason: 'invalid_keywords' };

  return memoryCore().enqueueWrite(async () => {
    const currentList = memoryCore().getMemoryList();
    const current = Array.isArray(currentList) ? currentList : [];
    const targetIndex = current.findIndex(item => item && item.id === target);
    if (targetIndex < 0) return { updated: 0, reason: 'not-found' };

    const targetItem = current[targetIndex];
    if ((targetItem.status || STATUS_ACTIVE) !== STATUS_ACTIVE) {
      return { updated: 0, reason: 'invalid-state' };
    }

    const sourceIndexes = [];
    const sourceItems = [];
    for (const sourceId of sources) {
      const index = current.findIndex(item => item && item.id === sourceId);
      if (index < 0) return { updated: 0, reason: 'source_not_found', sourceId };
      const item = current[index];
      if ((item.status || STATUS_ACTIVE) !== STATUS_ACTIVE) {
        return { updated: 0, reason: 'source_not_active', sourceId };
      }
      if (item.type !== targetItem.type) {
        return { updated: 0, reason: 'type_mismatch', sourceId };
      }
      sourceIndexes.push(index);
      sourceItems.push(item);
    }

    const now = new Date().toISOString();
    let contributions = Array.isArray(targetItem.contributions)
      ? targetItem.contributions.map(item => ({ ...item }))
      : [];
    let mergedKeywords = Array.isArray(targetItem.keywords)
      ? targetItem.keywords.slice(0, 5)
      : [];
    let confidence = Number(targetItem.confidence) || 0;

    for (const item of sourceItems) {
      contributions = mergeContributions(contributions, item.contributions);
      for (const keyword of Array.isArray(item.keywords) ? item.keywords : []) {
        if (!mergedKeywords.includes(keyword) && mergedKeywords.length < 5) {
          mergedKeywords.push(keyword);
        }
      }
      confidence = Math.max(confidence, Number(item.confidence) || 0);
    }
    for (const keyword of extraKeywords) {
      if (!mergedKeywords.includes(keyword) && mergedKeywords.length < 5) {
        mergedKeywords.push(keyword);
      }
    }

    const next = current.slice();
    next[targetIndex] = {
      ...targetItem,
      content: content !== undefined ? cleanText(content) : targetItem.content,
      keywords: mergedKeywords,
      confidence,
      contributions,
      updatedAt: now,
      lastDecision: {
        action: 'merge',
        reason: 'approved_merge',
        at: now,
        actor,
        sourceType: 'user',
      },
    };

    for (const index of sourceIndexes) {
      const item = next[index];
      next[index] = {
        ...item,
        status: STATUS_SUPERSEDED,
        validTo: item.validTo || now,
        supersededBy: target,
        updatedAt: now,
        lastDecision: {
          action: 'merge_source',
          reason: 'merged_into_target',
          at: now,
          actor,
          sourceType: 'user',
        },
      };
    }

    await memoryCore().saveMemories(next);
    memoryCore().setMemoryList(next);
    return {
      updated: 1,
      reason: 'ok',
      id: target,
      merged: sources.length,
      supersededIds: sources,
    };
  });
}

// ---------------------------------------------------------------- 存量 pending 收敛
//
// 2026-11-21 收尾条 2：合并语义只对新写入生效。旧库里同一 hedged/推断候选
// 可能已经按会话各存一条（当时写作用域还是会话级、且「可能：」前缀破坏过
// 相似度匹配），这些副本不会被后续写入顺手收掉——本函数按与写入路径同一套
// 匹配规则把它们并回一条。
//
// 分组键：userId + type + provenance + pendingReason（同因同源才可能是同一条），
// 相似度用 PENDING_CANDIDATE_MATCH_MIN，比较前双侧剥掉「可能：」前缀。
// 收敛只做三件事：贡献并进 keeper、重复条目退场、留 consolidatedFrom 审计链；
// 状态一律留在 pending —— hedged 证据再多也不自动晋升，这是既有策略。
const PENDING_CONSOLIDATE_REASONS = new Set([
  'user_hedged_requires_confirmation',
  'low_confidence_candidate',
  'model_inference_requires_confirmation',
]);

function planPendingConsolidation(current, options = {}) {
  const owner = cleanText(options.userId);
  const candidates = (Array.isArray(current) ? current : []).filter(
    item =>
      item &&
      isPending(item) &&
      PENDING_CONSOLIDATE_REASONS.has(item.pendingReason) &&
      (!owner || cleanText(item.userId) === owner)
  );

  const consumed = new Set();
  const groups = [];

  for (const seed of candidates) {
    if (consumed.has(seed.id)) continue;

    const bucket = [seed];
    const seedContent = stripHedgePendingMark(seed.content);

    for (const other of candidates) {
      if (other === seed || consumed.has(other.id)) continue;
      if (other.type !== seed.type) continue;
      if (other.provenance !== seed.provenance) continue;
      if (other.pendingReason !== seed.pendingReason) continue;
      if (cleanText(other.userId) !== cleanText(seed.userId)) continue;
      if (
        similarity(stripHedgePendingMark(other.content), seedContent) <
        PENDING_CANDIDATE_MATCH_MIN
      ) {
        continue;
      }

      bucket.push(other);
      consumed.add(other.id);
    }

    if (bucket.length < 2) continue;

    // keeper = 最早落库的那条（时间相同按 id 字典序，保证可复跑同结果）。
    const keeper = bucket
      .slice()
      .sort(
        (a, b) =>
          String(a.createdAt || a.pendingAt || '').localeCompare(
            String(b.createdAt || b.pendingAt || '')
          ) || String(a.id).localeCompare(String(b.id))
      )[0];

    groups.push({
      keeperId: keeper.id,
      content: keeper.content,
      pendingReason: keeper.pendingReason,
      duplicateIds: bucket.filter(item => item.id !== keeper.id).map(item => item.id),
      sessions: [
        ...new Set(
          bucket.flatMap(item =>
            (Array.isArray(item.contributions) ? item.contributions : [])
              .map(contribution => cleanText(contribution && contribution.sessionId))
              .filter(Boolean)
          )
        ),
      ].sort(),
    });
  }

  return { groups };
}

async function consolidatePendingDuplicates(options = {}) {
  const apply = options.apply === true;

  return memoryCore().enqueueWrite(async () => {
    const currentList = memoryCore().getMemoryList();
    const current = Array.isArray(currentList) ? currentList : [];
    const { groups } = planPendingConsolidation(current, options);
    const summary = {
      applied: apply,
      groups: groups.map(group => ({
        keeperId: group.keeperId,
        duplicateIds: group.duplicateIds,
        pendingReason: group.pendingReason,
        sessions: group.sessions,
        content: group.content,
      })),
      mergedEntries: 0,
      removedEntries: 0,
      remaining: current.length,
    };

    if (!groups.length || !apply) return summary;

    const byId = new Map(current.map(item => [item.id, item]));
    const dropped = new Set();
    const now = new Date().toISOString();

    for (const group of groups) {
      const keeper = byId.get(group.keeperId);

      if (!keeper) continue;

      let contributions = Array.isArray(keeper.contributions)
        ? keeper.contributions.map(item => ({ ...item }))
        : [];

      for (const duplicateId of group.duplicateIds) {
        const duplicate = byId.get(duplicateId);

        if (!duplicate) continue;

        contributions = mergeContributions(contributions, duplicate.contributions);
        dropped.add(duplicateId);
      }

      const sessions = new Set(
        contributions.map(item => cleanText(item && item.sessionId)).filter(Boolean)
      );
      const evidence =
        keeper.evidence && typeof keeper.evidence === 'object'
          ? {
              ...keeper.evidence,
              repetition: Math.max(
                Number(keeper.evidence.repetition) || 0,
                contributions.length
              ),
              independentSessions: Math.max(
                Number(keeper.evidence.independentSessions) || 0,
                sessions.size
              ),
            }
          : keeper.evidence;

      byId.set(keeper.id, {
        ...keeper,
        contributions,
        evidence,
        updatedAt: now,
        consolidatedFrom: [
          ...new Set([
            ...(Array.isArray(keeper.consolidatedFrom) ? keeper.consolidatedFrom : []),
            ...group.duplicateIds,
          ]),
        ],
      });
    }

    const next = current
      .filter(item => !dropped.has(item.id))
      .map(item => byId.get(item.id) || item);

    try {
      await memoryCore().saveMemories(next);
    } catch (error) {
      memoryCore().logDataEvent({
        module: 'memory',
        file: memoryCore().memoryFile,
        event: 'memory_pending_consolidate_failed',
        level: 'error',
        reason: 'write_failed',
        action: 'pending_consolidate',
        error,
      });

      return { ...summary, reason: 'write_failed' };
    }

    memoryCore().setMemoryList(next);
    memoryCore().refreshDerivedMemoryIndex('pending_consolidated');

    memoryCore().logDataEvent({
      module: 'memory',
      file: memoryCore().memoryFile,
      event: 'memory_pending_consolidated',
      level: 'info',
      action: 'pending_consolidate',
      // 只落 id 与计数：记忆正文不进日志。
      mergedEntries: groups.reduce(
        (sum, group) => sum + group.duplicateIds.length,
        0
      ),
      groups: groups.length,
    });

    return {
      ...summary,
      mergedEntries: groups.reduce(
        (sum, group) => sum + group.duplicateIds.length,
        0
      ),
      removedEntries: dropped.size,
      remaining: next.length,
    };
  });
}

async function supersedeMemory({ id, replacement, actor = 'user' } = {}) {
  const targetId = cleanText(id);
  const source = replacement && typeof replacement === 'object' ? replacement : null;
  if (!targetId || !source) return { updated: 0, reason: 'invalid' };

  const content = cleanText(source.content);
  if (!content || content.length > 100) return { updated: 0, reason: 'invalid_content' };
  if (source.type !== undefined && !ALLOWED_TYPES.has(source.type)) {
    return { updated: 0, reason: 'type_not_allowed' };
  }
  if (
    source.confidence !== undefined &&
    (!Number.isFinite(Number(source.confidence)) ||
      Number(source.confidence) < 0 ||
      Number(source.confidence) > 1)
  ) {
    return { updated: 0, reason: 'invalid_confidence' };
  }
  const newKeywords = source.keywords === undefined ? null : memoryCore().maintenanceKeywords(source.keywords);
  if (newKeywords === null && source.keywords !== undefined) {
    return { updated: 0, reason: 'invalid_keywords' };
  }
  const validFrom = source.validFrom === undefined ? null : maintenanceDate(source.validFrom);
  const validTo = source.validTo === undefined ? null : maintenanceDate(source.validTo);
  if (validFrom === undefined) return { updated: 0, reason: 'invalid_valid_from' };
  if (validTo === undefined) return { updated: 0, reason: 'invalid_valid_to' };

  return memoryCore().enqueueWrite(async () => {
    const currentList = memoryCore().getMemoryList();
    const current = Array.isArray(currentList) ? currentList : [];
    const index = current.findIndex(item => item && item.id === targetId);
    if (index < 0) return { updated: 0, reason: 'not-found' };
    const target = current[index];
    const targetStatus = target.status || STATUS_ACTIVE;

    if (!canTransition(targetStatus, STATUS_SUPERSEDED)) {
      memoryCore().logLifecycleRejection({
        action: 'supersede',
        from: targetStatus,
        id: targetId,
        reason: 'invalid-state',
      });
      return { updated: 0, reason: 'invalid-state' };
    }

    const now = new Date().toISOString();
    const newId = issuedId();
    const replacementEntry = {
      id: newId,
      status: STATUS_ACTIVE,
      content,
      type: source.type || target.type,
      keywords: newKeywords === null
        ? Array.isArray(target.keywords) ? target.keywords.slice(0, 5) : []
        : newKeywords,
      confidence:
        source.confidence !== undefined
          ? Number(source.confidence)
          : Number(target.confidence) || 0.9,
      validFrom: validFrom || now,
      validTo: validTo || null,
      supersededBy: null,
      supersedes: targetId,
      contributions: Array.isArray(target.contributions)
        ? target.contributions.map(item => ({ ...item }))
        : [],
      createdAt: now,
      updatedAt: now,
      sourceType: 'user',
      intent: 'maintenance',
      eventAt: cleanText(source.eventAt) || null,
      condition: cleanText(source.condition) || null,
      lastDecision: {
        action: 'supersede',
        reason: 'approved_supersede',
        at: now,
        actor,
        sourceType: 'user',
      },
    };

    const next = current.slice();
    next[index] = {
      ...target,
      status: STATUS_SUPERSEDED,
      validTo: target.validTo || now,
      supersededBy: newId,
      updatedAt: now,
      lastDecision: {
        action: 'supersede',
        reason: 'replaced_by_approved_entry',
        at: now,
        actor,
        sourceType: 'user',
      },
    };
    next.push(replacementEntry);
    memoryCore().trimToCapacity(next);
    await memoryCore().saveMemories(next);
    memoryCore().setMemoryList(next);
    memoryCore().logLifecycleEvent({
      action: 'supersede',
      from: targetStatus,
      to: STATUS_SUPERSEDED,
      id: targetId,
      reason: 'approved_supersede',
    });
    memoryCore().logLifecycleEvent({
      action: 'create',
      from: null,
      to: STATUS_ACTIVE,
      id: newId,
      reason: 'approved_supersede',
    });

    return {
      updated: 1,
      reason: 'ok',
      id: newId,
      supersededId: targetId,
      status: STATUS_ACTIVE,
    };
  });
}

async function withdrawMemory({ id, sessionId = null, actor = 'user' } = {}) {
  const targetId = cleanText(id);
  const targetSession = cleanText(sessionId);
  if (!targetId) return { withdrawn: 0, reason: 'invalid' };

  return memoryCore().enqueueWrite(async () => {
    const currentList = memoryCore().getMemoryList();
    const current = Array.isArray(currentList) ? currentList : [];
    const index = current.findIndex(item => item && item.id === targetId);
    if (index < 0) return { withdrawn: 0, reason: 'not-found' };

    const item = current[index];
    const status = item.status || STATUS_ACTIVE;

    if (![STATUS_ACTIVE, STATUS_CONTESTED].includes(status)) {
      memoryCore().logLifecycleRejection({
        action: 'withdraw',
        from: status,
        id: targetId,
        reason: 'invalid-state',
      });
      return { withdrawn: 0, reason: 'invalid-state' };
    }

    const contributions = Array.isArray(item.contributions) ? item.contributions : [];
    const kept = targetSession
      ? contributions.filter(contribution => contribution.sessionId !== targetSession)
      : [];
    const removed = targetSession
      ? contributions.filter(contribution => contribution.sessionId === targetSession)
      : contributions.slice();
    const removedContributions = contributions.length - kept.length;
    if (!removedContributions) {
      return { withdrawn: 0, reason: 'no-match' };
    }

    const now = new Date().toISOString();
    const next = current.slice();
    const nextStatus = kept.length ? status : STATUS_ARCHIVED;

    if (kept.length) {
      next[index] = {
        ...item,
        contributions: kept,
        lastWithdrawalAt: now,
        updatedAt: now,
        lastDecision: {
          action: 'withdraw',
          reason: 'withdrawn_session_contributions',
          at: now,
          actor,
          sourceType: 'user',
        },
      };
    } else {
      next[index] = {
        ...item,
        status: STATUS_ARCHIVED,
        contributions: [],
        validTo: item.validTo || now,
        withdrawnAt: now,
        withdrawnReason: 'withdrawn_all_contributions',
        updatedAt: now,
        lastDecision: {
          action: 'withdraw',
          reason: 'withdrawn_all_contributions',
          at: now,
          actor,
          sourceType: 'user',
        },
      };
    }

    await memoryCore().commitWithTombstones(
      next,
      [{ ...item, contributions: removed }],
      'withdraw'
    );
    memoryCore().setMemoryList(next);
    memoryCore().refreshDerivedMemoryIndex('withdraw');
    memoryCore().logLifecycleEvent({
      action: 'withdraw',
      from: status,
      to: nextStatus,
      id: targetId,
      reason: kept.length
        ? 'withdrawn_session_contributions'
        : 'withdrawn_all_contributions',
    });
    return {
      withdrawn: 1,
      reason: 'ok',
      id: targetId,
      removedContributions,
      archived: kept.length === 0,
      status: nextStatus,
    };
  });
}

// ---- P5 画像反馈：确认 / 否认 / 纠正 ----
// 反馈是用户对既有记忆的显式裁决，必须走同一个写队列与原子落盘，
// 并且带 feedbackId 幂等键；它不是一次新的自动抽取。


module.exports = {
  stripHedgePendingMark,
  PENDING_CANDIDATE_MATCH_MIN,
  archiveContestedForConfirmation,
  confirmPending,
  rejectPending,
  archiveMemory,
  maintenanceDate,
  updateMemory,
  mergeMemories,
  PENDING_CONSOLIDATE_REASONS,
  planPendingConsolidation,
  consolidatePendingDuplicates,
  supersedeMemory,
  withdrawMemory,
};
