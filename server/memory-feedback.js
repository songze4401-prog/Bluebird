// 记忆反馈三联（健康度审计 R3a，2026-11-21 自 memory.js 迁出）。
//
// 职责：记忆反馈的三个用户裁决动作——confirmMemoryFeedback（确认待确认
// 候选）/ denyMemoryFeedback（否决归档）/ correctMemoryFeedback（更正
// 正文），加上裁决记录基础件（feedbackDecision/appendFeedbackHistory/
// normalizeFeedbackId/findFeedbackResult）与 FEEDBACK_HISTORY_LIMIT。
//
// 设计边界（勿破坏）：
// - 这是写路径模块：写基础设施（写队列 enqueueWrite、持久化 saveMemories/
//   commitWithTombstones、派生索引 refreshDerivedMemoryIndex、状态数组
//   memories 的读写）全部留守 memory.js，经共享容器 injectMemoryCore 注入。
//   setMemoryList(next) 是状态重赋值的唯一通道（memories 是 let 数组，
//   不能像 pendingMemoryIntents 那样共享 Set 引用）。
// - 零回边：不 require memory.js（否则入圈，触发 scc-freeze 门禁）。
//   同层依赖允许：ownerAllows 来自 memory-retrieval、issuedId 来自
//   memory-extraction（均为已迁出模块，无反向边）。
// - pending 的确认语义上走 confirmPending（需要处理 pendingTargetId /
//   contestedIds）——confirmMemoryFeedback 与它同级协作但代码上不调用。
//
// 消费方：memory.js 经解构回注（applyFeedback/confirmPending 区域的
// feedbackDecision/appendFeedbackHistory 调用点与 module.exports 的三联
// 继续裸名调用），调用点零改动。
const {
  cleanText,
  isSensitive,
  ALLOWED_TYPES,
} = require('./memory-ranking');
const {
  STATUS_ACTIVE,
  STATUS_ARCHIVED,
  STATUS_CONTESTED,
  STATUS_PENDING,
  STATUS_SUPERSEDED,
} = require('./memory-lifecycle');
const {
  classifyCategory,
  FEEDBACK_DECISION_VERSION,
  FEEDBACK_POLICY_VERSION,
  PROVENANCE,
} = require('./memory-evidence');
const { issuedId } = require('./memory-extraction');
const { ownerAllows } = require('./memory-retrieval');

// 写路径注入经共享容器 server/memory-core.js（state-holder 统一设计）：
// 10 键，memory.js 顶层注入。
const { memoryCore } = require('./memory-core');

// 反馈历史留档上限（appendFeedbackHistory 裁剪用）。
const FEEDBACK_HISTORY_LIMIT = 20;

function feedbackDecision(action, reason, feedbackId, at) {
  return {
    action,
    reason,
    at,
    actor: 'user',
    sourceType: 'user',
    ...(feedbackId ? { feedbackId } : {}),
  };
}

function appendFeedbackHistory(item, decision) {
  const history = Array.isArray(item && item.feedbackHistory)
    ? item.feedbackHistory.slice()
    : [];

  if (
    decision &&
    decision.feedbackId &&
    history.some(
      event =>
        event &&
        event.feedbackId === decision.feedbackId &&
        event.action === decision.action
    )
  ) {
    return history;
  }

  if (decision) history.push(decision);

  return history.slice(-FEEDBACK_HISTORY_LIMIT);
}
function normalizeFeedbackId(value) {
  if (value === undefined || value === null || value === '') return null;
  if (typeof value !== 'string') return undefined;
  const trimmed = value.trim();
  if (!/^[A-Za-z0-9][A-Za-z0-9._:-]{0,119}$/.test(trimmed)) return undefined;
  return trimmed;
}

function findFeedbackResult(list, feedbackId, action) {
  if (!feedbackId) return null;

  const matches = list.filter(
    item => {
      if (!item) return false;
      if (
        item.lastDecision &&
        item.lastDecision.feedbackId === feedbackId &&
        item.lastDecision.action === action
      ) {
        return true;
      }
      return (
        Array.isArray(item.feedbackHistory) &&
        item.feedbackHistory.some(
          event =>
            event &&
            event.feedbackId === feedbackId &&
            event.action === action
        )
      );
    }
  );

  // 纠正会同时标记旧条目和新条目；优先返回带 supersedes 的新条目。
  return (
    matches.find(item => item.supersedes) ||
    matches.find(item => (item.status || STATUS_ACTIVE) === STATUS_ACTIVE) ||
    matches[0] ||
    null
  );
}

// 确认 active/contested，或把 contested 一方的裁决落成 active。
// pending 的确认走 confirmPending（需要处理 pendingTargetId / contestedIds）。
async function confirmMemoryFeedback({ id, userId = null, feedbackId = null } = {}) {
  const targetId = cleanText(id);
  const owner = cleanText(userId);
  const fbId = normalizeFeedbackId(feedbackId);

  if (!targetId) return { updated: 0, reason: 'invalid' };
  if (fbId === undefined) return { updated: 0, reason: 'invalid_feedback_id' };

  const deps = memoryCore();
  return deps.enqueueWrite(async () => {
    const currentList = deps.getMemoryList();
    const current = Array.isArray(currentList) ? currentList : [];
    const index = current.findIndex(item => item && item.id === targetId);

    if (index < 0) return { updated: 0, reason: 'not-found' };

    const item = current[index];

    if (!ownerAllows(item, owner)) {
      return { updated: 0, reason: 'forbidden' };
    }

    const duplicate = findFeedbackResult(current, fbId, 'confirm');

    if (duplicate) {
      if (duplicate.id !== targetId) {
        return { updated: 0, reason: 'feedback_id_conflict' };
      }
      return {
        updated: 0,
        reason: 'ok',
        duplicate: true,
        id: duplicate.id,
        status: duplicate.status || STATUS_ACTIVE,
      };
    }

    const status = item.status || STATUS_ACTIVE;

    if (status === STATUS_PENDING) {
      return { updated: 0, reason: 'use-confirm-pending' };
    }

    if (status !== STATUS_ACTIVE && status !== STATUS_CONTESTED) {
      deps.logLifecycleRejection({
        action: 'confirm',
        from: status,
        id: targetId,
        reason: 'invalid-state',
      });
      return { updated: 0, reason: 'invalid-state' };
    }

    const now = new Date().toISOString();
    let next = current.slice();

    if (status === STATUS_ACTIVE) {
      const decision = feedbackDecision(
        'confirm',
        'user_confirmed',
        fbId,
        now
      );
      next[index] = {
        ...item,
        confirmationCount: (Number(item.confirmationCount) || 0) + 1,
        lastConfirmedAt: now,
        updatedAt: now,
        lastDecision: decision,
        feedbackHistory: appendFeedbackHistory(item, decision),
      };

      await deps.saveMemories(next);
      deps.setMemoryList(next);
      deps.logLifecycleEvent({
        action: 'confirm',
        from: status,
        to: STATUS_ACTIVE,
        id: targetId,
        reason: 'user_confirmed',
      });

      return { updated: 1, reason: 'ok', id: targetId, status: STATUS_ACTIVE };
    }

    // contested：用户直接确认旧条目，等同于否决挑战它的 pending 候选。
    const decision = feedbackDecision(
      'confirm',
      'user_resolved_contest',
      fbId,
      now
    );
    next[index] = {
      ...item,
      status: STATUS_ACTIVE,
      validTo: null,
      resolvedContestAt: now,
      confirmationCount: (Number(item.confirmationCount) || 0) + 1,
      lastConfirmedAt: now,
      updatedAt: now,
      lastDecision: decision,
      feedbackHistory: appendFeedbackHistory(item, decision),
    };

    const pendingId = cleanText(item.contestedBy);
    const pendingIndex = pendingId
      ? next.findIndex(
          candidate =>
            candidate && candidate.id === pendingId && candidate.status === STATUS_PENDING
        )
      : -1;
    let archivedContested = 0;

    if (pendingIndex >= 0) {
      const pending = next[pendingIndex];
      const contestedIds = new Set(
        Array.isArray(pending.contestedIds) ? pending.contestedIds : []
      );

      next[pendingIndex] = {
        ...pending,
        status: STATUS_ARCHIVED,
        validTo: pending.validTo || now,
        archivedReason: 'contest_resolved_by_user_confirmation',
        updatedAt: now,
        lastDecision: feedbackDecision(
          'archive',
          'contest_resolved_by_user_confirmation',
          null,
          now
        ),
      };

      next = next.map(entry => {
        if (
          !entry ||
          entry.id === targetId ||
          entry.status !== STATUS_CONTESTED ||
          !contestedIds.has(entry.id)
        ) {
          return entry;
        }

        archivedContested += 1;

        return {
          ...entry,
          status: STATUS_ARCHIVED,
          validTo: entry.validTo || now,
          archivedReason: 'contested_replaced_by_confirmation',
          updatedAt: now,
          lastDecision: feedbackDecision(
            'archive',
            'contested_replaced_by_confirmation',
            null,
            now
          ),
        };
      });
    }

    await deps.saveMemories(next);
    deps.setMemoryList(next);
    deps.refreshDerivedMemoryIndex('confirm');
    deps.logLifecycleEvent({
      action: 'confirm',
      from: status,
      to: STATUS_ACTIVE,
      id: targetId,
      reason: 'user_resolved_contest',
    });

    return {
      updated: 1,
      reason: 'ok',
      id: targetId,
      status: STATUS_ACTIVE,
      archivedContested,
    };
  });
}

// 否认：不物理删除，归档并写墓碑。这样画像审计仍能看到「被谁否认过」，
// 同时异步抽取无法借同一条来源把已否认的事实复活。
async function denyMemoryFeedback({
  id,
  userId = null,
  feedbackId = null,
  reason = 'user_denied',
} = {}) {
  const targetId = cleanText(id);
  const owner = cleanText(userId);
  const fbId = normalizeFeedbackId(feedbackId);
  const denyReason = cleanText(reason) || 'user_denied';

  if (!targetId) return { denied: 0, reason: 'invalid' };
  if (fbId === undefined) return { denied: 0, reason: 'invalid_feedback_id' };

  const deps = memoryCore();
  return deps.enqueueWrite(async () => {
    const currentList = deps.getMemoryList();
    const current = Array.isArray(currentList) ? currentList : [];
    const index = current.findIndex(item => item && item.id === targetId);

    if (index < 0) return { denied: 0, reason: 'not-found' };

    const item = current[index];

    if (!ownerAllows(item, owner)) {
      return { denied: 0, reason: 'forbidden' };
    }

    const duplicate = findFeedbackResult(current, fbId, 'deny');

    if (duplicate) {
      if (duplicate.id !== targetId) {
        return { denied: 0, reason: 'feedback_id_conflict' };
      }
      return {
        denied: 0,
        reason: 'ok',
        duplicate: true,
        id: duplicate.id,
        status: duplicate.status,
      };
    }

    const status = item.status || STATUS_ACTIVE;

    if (![STATUS_PENDING, STATUS_ACTIVE, STATUS_CONTESTED].includes(status)) {
      deps.logLifecycleRejection({
        action: 'deny',
        from: status,
        id: targetId,
        reason: 'invalid-state',
      });
      return { denied: 0, reason: 'invalid-state' };
    }

    const now = new Date().toISOString();
    const next = current.slice();
    const decision = feedbackDecision('deny', denyReason, fbId, now);
    next[index] = {
      ...item,
      status: STATUS_ARCHIVED,
      validTo: item.validTo || now,
      withdrawnAt: now,
      withdrawnReason: denyReason,
      updatedAt: now,
      lastDecision: decision,
      feedbackHistory: appendFeedbackHistory(item, decision),
    };

    await deps.commitWithTombstones(next, [{ ...item }], 'deny');
    deps.setMemoryList(next);
    deps.refreshDerivedMemoryIndex('deny');
    deps.logLifecycleEvent({
      action: 'deny',
      from: status,
      to: STATUS_ARCHIVED,
      id: targetId,
      reason: denyReason,
    });

    return {
      denied: 1,
      reason: 'ok',
      id: targetId,
      status: STATUS_ARCHIVED,
      archived: true,
    };
  });
}

// 纠正：保留旧条目的历史（active → superseded；pending → archived），
// 另建一条 active 新条目，并把用户给出的更正原话作为新的来源贡献。
// 旧条目的原有贡献全部保留，因此画像仍然能追溯“改之前是什么、谁说的”。
async function correctMemoryFeedback({
  id,
  userId = null,
  feedbackId = null,
  content,
  type,
  keywords,
  confidence,
} = {}) {
  const deps = memoryCore();
  const targetId = cleanText(id);
  const owner = cleanText(userId);
  const fbId = normalizeFeedbackId(feedbackId);
  const value =
    typeof content === 'string' ? content.replace(/\s+/g, ' ').trim() : '';

  if (!targetId) return { updated: 0, reason: 'invalid' };
  if (fbId === undefined) return { updated: 0, reason: 'invalid_feedback_id' };
  if (!value) return { updated: 0, reason: 'no_content' };
  if (value.length > 100) return { updated: 0, reason: 'content_too_long' };
  if (isSensitive(value)) return { updated: 0, reason: 'sensitive_content' };

  let nextType = null;
  if (type !== undefined) {
    if (!ALLOWED_TYPES.has(type)) return { updated: 0, reason: 'type_not_allowed' };
    nextType = type;
  }

  let nextKeywords = null;
  if (keywords !== undefined) {
    nextKeywords = deps.maintenanceKeywords(keywords);
    if (nextKeywords === null) return { updated: 0, reason: 'invalid_keywords' };
  }

  let nextConfidence = null;
  if (confidence !== undefined) {
    const parsed = Number(confidence);
    if (!Number.isFinite(parsed) || parsed < 0 || parsed > 1) {
      return { updated: 0, reason: 'invalid_confidence' };
    }
    nextConfidence = parsed;
  }

  return deps.enqueueWrite(async () => {
    const currentList = deps.getMemoryList();
    const current = Array.isArray(currentList) ? currentList : [];
    const duplicate = findFeedbackResult(current, fbId, 'correct');

    if (duplicate) {
      if (duplicate.supersedes !== targetId && duplicate.id !== targetId) {
        return { updated: 0, reason: 'feedback_id_conflict' };
      }
      return {
        updated: 0,
        reason: 'ok',
        duplicate: true,
        id: duplicate.id,
        supersededId: duplicate.supersedes || null,
        status: duplicate.status,
      };
    }

    const index = current.findIndex(item => item && item.id === targetId);

    if (index < 0) return { updated: 0, reason: 'not-found' };

    const item = current[index];

    if (!ownerAllows(item, owner)) {
      return { updated: 0, reason: 'forbidden' };
    }

    const status = item.status || STATUS_ACTIVE;

    if (![STATUS_PENDING, STATUS_ACTIVE, STATUS_CONTESTED].includes(status)) {
      deps.logLifecycleRejection({
        action: 'correct',
        from: status,
        id: targetId,
        reason: 'invalid-state',
      });
      return { updated: 0, reason: 'invalid-state' };
    }

    const targetType = nextType || item.type;
    const targetKeywords =
      nextKeywords === null
        ? Array.isArray(item.keywords)
          ? item.keywords.slice(0, 5)
          : []
        : nextKeywords;
    const targetConfidence =
      nextConfidence === null
        ? Number.isFinite(Number(item.confidence))
          ? Number(item.confidence)
          : 0.9
        : nextConfidence;

    if (
      item.content === value &&
      item.type === targetType &&
      JSON.stringify(Array.isArray(item.keywords) ? item.keywords : []) ===
        JSON.stringify(targetKeywords) &&
      Number(item.confidence) === targetConfidence
    ) {
      return { updated: 0, reason: 'no_change' };
    }

    const now = new Date().toISOString();
    const newId = issuedId();
    const contributions = Array.isArray(item.contributions)
      ? item.contributions.map(contribution => ({ ...contribution }))
      : [];

    contributions.push({
      sessionId: null,
      sourceQuote: value,
      createdAt: now,
      sourceType: 'user',
      ...(fbId ? { messageId: `feedback:${fbId}` } : {}),
    });

    const {
      pendingReason,
      pendingAt,
      pendingTargetId,
      pendingMutation,
      contestedIds,
      contestedAt,
      contestedReason,
      contestedBy,
      withdrawnAt,
      withdrawnReason,
      lastWithdrawalAt,
      archivedReason,
      resolvedContestAt,
      confirmationCount,
      lastConfirmedAt,
      feedbackHistory,
      ...base
    } = item;

    const newEntry = {
      ...base,
      id: newId,
      status: STATUS_ACTIVE,
      content: value,
      type: targetType,
      keywords: targetKeywords,
      confidence: targetConfidence,
      validFrom: now,
      validTo: null,
      supersededBy: null,
      supersedes: targetId,
      contributions,
      createdAt: now,
      updatedAt: now,
      sourceType: 'user',
      provenance: PROVENANCE.USER_ASSERTED,
      category: classifyCategory(
        { content: value, type: targetType },
        PROVENANCE.USER_ASSERTED
      ),
      observedAt: now,
      persistentIntent: true,
      policyVersion: FEEDBACK_POLICY_VERSION,
      decisionVersion: FEEDBACK_DECISION_VERSION,
      evidence:
        item.evidence && typeof item.evidence === 'object' ? item.evidence : null,
      lastDecision: feedbackDecision('correct', 'user_correction', fbId, now),
      feedbackHistory: [feedbackDecision('correct', 'user_correction', fbId, now)],
    };

    const oldNextStatus =
      status === STATUS_PENDING ? STATUS_ARCHIVED : STATUS_SUPERSEDED;
    const next = current.slice();
    const decision = feedbackDecision('correct', 'user_correction', fbId, now);

    next[index] = {
      ...item,
      status: oldNextStatus,
      validTo: item.validTo || now,
      supersededBy: newId,
      updatedAt: now,
      ...(oldNextStatus === STATUS_ARCHIVED
        ? { archivedReason: 'corrected_by_profile_feedback' }
        : {}),
      lastDecision: decision,
      feedbackHistory: appendFeedbackHistory(item, decision),
    };
    next.push(newEntry);
    deps.trimToCapacity(next);

    await deps.commitWithTombstones(next, [{ ...item }], 'correct');
    deps.setMemoryList(next);
    deps.refreshDerivedMemoryIndex('correct');
    deps.logLifecycleEvent({
      action: 'correct',
      from: status,
      to: oldNextStatus,
      id: targetId,
      reason: 'user_correction',
    });
    deps.logLifecycleEvent({
      action: 'create',
      from: null,
      to: STATUS_ACTIVE,
      id: newId,
      reason: 'user_correction',
    });

    return {
      updated: 1,
      reason: 'ok',
      id: newId,
      supersededId: targetId,
      replacedStatus: oldNextStatus,
      status: STATUS_ACTIVE,
    };
  });
}


// 写后自检：把磁盘上的记忆库重新读一遍，与内存做「定位字段」指纹比较。
// 只比较 id / status / validFrom / 每条贡献的会话归属，不比较正文——
// 正文只影响展示，定位字段才决定「这条记忆属于谁、还能不能被撤回/更正」。
// 用途：撤回、清理、删除这类接口的响应之前先证明确实落盘成功，
// 而不是只看 HTTP 状态码或只看内存数组。
// reason：ok / corrupt（文件读不出合法数组）/ missing / count-mismatch / mismatch

module.exports = {
  FEEDBACK_HISTORY_LIMIT,
  feedbackDecision,
  appendFeedbackHistory,
  normalizeFeedbackId,
  findFeedbackResult,
  confirmMemoryFeedback,
  denyMemoryFeedback,
  correctMemoryFeedback,
};
