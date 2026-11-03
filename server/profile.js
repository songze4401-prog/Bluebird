/**
 * 云岫 Bluebird — P5 可追溯画像与反馈（profile.js）
 *
 * 画像不是第二份存储：每次读取都从 memory.json 的长期记忆派生，因此
 * 「画像可重建」不是口号——没有可漂移的画像缓存，只有派生视图。
 * 每个画像条目都带来源贡献（sessionId / messageId / 原话 / 时间）、
 * 生命周期、证据与最近反馈，用户能看到「为什么相信、从哪里来」。
 *
 * 反馈三动作：
 * - confirm：确认 pending（含冲突候选）或给 active/contested 增加确认证据；
 * - deny：归档并写墓碑，保留审计，异步抽取不能复活；
 * - correct：新 active 条目取代旧条目，旧条目保留历史，新原话进入来源。
 *
 * 所有反馈带 feedbackId 幂等键；写操作复用 memory.js 的写队列与原子落盘。
 */
const crypto = require('crypto');
const {
  getMemoriesForUser,
  checkMemoryOwnership,
  confirmPending,
  confirmMemoryFeedback,
  denyMemoryFeedback,
  correctMemoryFeedback,
} = require('./memory');
const {
  isEffectiveAt,
  STATUS_ACTIVE,
  STATUS_PENDING,
  STATUS_CONTESTED,
  STATUS_SUPERSEDED,
  STATUS_ARCHIVED,
} = require('./memory-lifecycle');

const PROFILE_VERSION = 'p5.0';
const DIGEST_ALGORITHM = 'sha256-profile-v1';
const FEEDBACK_ACTIONS = Object.freeze(['confirm', 'deny', 'correct']);
const FEEDBACK_REASON_MAX = 80;
const FEEDBACK_REASON_RE = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,79}$/;
const FEEDBACK_ID_RE = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,119}$/;

const SECTION_ORDER = Object.freeze([
  'identity',
  'preferences',
  'goals',
  'relationships',
  'facts',
  'other',
]);

const SECTION_LABELS = Object.freeze({
  identity: '身份',
  preferences: '偏好',
  goals: '目标',
  relationships: '关系',
  facts: '事实',
  other: '其他',
});

const TYPE_SECTION = Object.freeze({
  identity: 'identity',
  preference: 'preferences',
  goal: 'goals',
  relationship: 'relationships',
  fact: 'facts',
});

const STATUS_PRIORITY = Object.freeze({
  [STATUS_ACTIVE]: 0,
  [STATUS_PENDING]: 1,
  [STATUS_CONTESTED]: 2,
  [STATUS_SUPERSEDED]: 3,
  [STATUS_ARCHIVED]: 4,
});

function cleanText(value) {
  return typeof value === 'string' && value.trim() ? value.trim() : null;
}

function normalizeFeedbackId(value) {
  if (value === undefined || value === null || value === '') return null;
  if (typeof value !== 'string') return undefined;
  const trimmed = value.trim();
  return FEEDBACK_ID_RE.test(trimmed) ? trimmed : undefined;
}

function timeMs(value) {
  const parsed = Date.parse(value || '');
  return Number.isFinite(parsed) ? parsed : 0;
}

function sectionFor(type) {
  return TYPE_SECTION[type] || 'other';
}

function normalizeSource(contribution) {
  return {
    sessionId: cleanText(contribution && contribution.sessionId),
    messageId: cleanText(contribution && contribution.messageId),
    sourceQuote:
      contribution && typeof contribution.sourceQuote === 'string'
        ? contribution.sourceQuote
        : '',
    createdAt:
      contribution && typeof contribution.createdAt === 'string'
        ? contribution.createdAt
        : null,
    sourceType: cleanText(contribution && contribution.sourceType),
  };
}

function normalizeDecision(decision) {
  if (!decision || typeof decision !== 'object') return null;
  return {
    action: cleanText(decision.action),
    reason: cleanText(decision.reason),
    at: cleanText(decision.at),
    actor: cleanText(decision.actor),
    sourceType: cleanText(decision.sourceType),
    feedbackId: cleanText(decision.feedbackId),
  };
}

function inactiveReason(item, nowMs) {
  const status = item.status || STATUS_ACTIVE;

  if (status === STATUS_SUPERSEDED) return 'superseded';
  if (status === STATUS_ARCHIVED) {
    return item.withdrawnAt ? 'denied' : 'archived';
  }
  if (status === STATUS_ACTIVE && !isEffectiveAt(item, nowMs)) return 'expired';

  return null;
}

function toItem(item, nowMs) {
  const status = item.status || STATUS_ACTIVE;
  const sources = (Array.isArray(item.contributions) ? item.contributions : [])
    .map(normalizeSource)
    .filter(source => source.sourceQuote)
    .sort((a, b) => timeMs(a.createdAt) - timeMs(b.createdAt));
  const independentSessions = new Set(
    sources.map(source => source.sessionId).filter(Boolean)
  ).size;

  return {
    memoryId: item.id,
    content: item.content,
    type: item.type,
    category: item.category || null,
    status,
    effective: status === STATUS_ACTIVE && isEffectiveAt(item, nowMs),
    inactiveReason: inactiveReason(item, nowMs),
    confidence: Number.isFinite(Number(item.confidence)) ? Number(item.confidence) : null,
    provenance: item.provenance || null,
    policyVersion: item.policyVersion || null,
    decisionVersion: item.decisionVersion || null,
    validFrom: item.validFrom || null,
    validTo: item.validTo || null,
    observedAt: item.observedAt || null,
    updatedAt: item.updatedAt || null,
    supersedes: item.supersedes || null,
    supersededBy: item.supersededBy || null,
    sourceQuote: sources.length ? sources[0].sourceQuote : '',
    sourceCount: sources.length,
    independentSessions,
    sources,
    evidence: item.evidence && typeof item.evidence === 'object' ? item.evidence : null,
    feedback: {
      confirmationCount: Number.isInteger(item.confirmationCount)
        ? item.confirmationCount
        : 0,
      lastConfirmedAt: item.lastConfirmedAt || null,
      lastDecision: normalizeDecision(item.lastDecision),
      history: (Array.isArray(item.feedbackHistory) ? item.feedbackHistory : [])
        .map(normalizeDecision)
        .filter(Boolean)
        .slice(-20),
      withdrawnAt: item.withdrawnAt || null,
      withdrawnReason: item.withdrawnReason || null,
      archivedReason: item.archivedReason || null,
    },
    ...(status === STATUS_PENDING
      ? {
          pendingReason: item.pendingReason || null,
          pendingAt: item.pendingAt || null,
          pendingTargetId: item.pendingTargetId || null,
          proposedAction: item.pendingMutation || null,
          contestedIds: Array.isArray(item.contestedIds)
            ? item.contestedIds.slice()
            : [],
        }
      : {}),
    ...(status === STATUS_CONTESTED
      ? {
          contestedAt: item.contestedAt || null,
          contestedReason: item.contestedReason || null,
          contestedBy: item.contestedBy || null,
          resolvedContestAt: item.resolvedContestAt || null,
        }
      : {}),
  };
}

function sortItems(items) {
  return items
    .slice()
    .sort(
      (a, b) =>
        SECTION_ORDER.indexOf(sectionFor(a.type)) -
          SECTION_ORDER.indexOf(sectionFor(b.type)) ||
        String(a.id || '').localeCompare(String(b.id || ''))
    );
}

function buildDigest(all) {
  const canonical = all
    .slice()
    .sort((a, b) => String(a.id || '').localeCompare(String(b.id || '')))
    .map(item => ({
      id: item.id || null,
      userId: item.userId || null,
      status: item.status || STATUS_ACTIVE,
      content: item.content || '',
      type: item.type || null,
      category: item.category || null,
      confidence: Number.isFinite(Number(item.confidence))
        ? Number(item.confidence)
        : null,
      validFrom: item.validFrom || null,
      validTo: item.validTo || null,
      updatedAt: item.updatedAt || null,
      supersedes: item.supersedes || null,
      supersededBy: item.supersededBy || null,
      withdrawnAt: item.withdrawnAt || null,
      withdrawnReason: item.withdrawnReason || null,
      archivedReason: item.archivedReason || null,
      contestedAt: item.contestedAt || null,
      resolvedContestAt: item.resolvedContestAt || null,
      confirmationCount: Number.isInteger(item.confirmationCount)
        ? item.confirmationCount
        : 0,
      lastConfirmedAt: item.lastConfirmedAt || null,
      contributions: (Array.isArray(item.contributions) ? item.contributions : []).map(
        contribution => ({
          sessionId: contribution.sessionId || null,
          messageId: contribution.messageId || null,
          sourceQuote: contribution.sourceQuote || '',
          createdAt: contribution.createdAt || null,
          sourceType: contribution.sourceType || null,
        })
      ),
      lastDecision: normalizeDecision(item.lastDecision),
      feedbackHistory: (Array.isArray(item.feedbackHistory)
        ? item.feedbackHistory
        : []
      ).map(normalizeDecision),
    }));

  return crypto
    .createHash('sha256')
    .update(JSON.stringify(canonical))
    .digest('hex');
}

function buildRecentFeedback(all) {
  const events = new Map();

  for (const item of all) {
    const history = Array.isArray(item.feedbackHistory)
      ? item.feedbackHistory
      : [];
    const last = item.lastDecision ? [item.lastDecision] : [];
    const seen = new Set();

    for (const raw of [...history, ...last]) {
      const decision = normalizeDecision(raw);
      if (!decision || !['confirm', 'deny', 'correct'].includes(decision.action)) {
        continue;
      }

      const localKey = decision.feedbackId
        ? `${decision.action}:${decision.feedbackId}`
        : `${decision.action}:${decision.at || ''}`;
      if (seen.has(localKey)) continue;
      seen.add(localKey);

      const key = decision.feedbackId
        ? `${decision.action}:${decision.feedbackId}`
        : `${item.id}:${decision.action}:${decision.at || ''}`;
      const candidate = {
        memoryId: item.id,
        action: decision.action,
        reason: decision.reason,
        at: decision.at,
        actor: decision.actor,
        feedbackId: decision.feedbackId,
        supersededId: item.supersedes || null,
        status: item.status || STATUS_ACTIVE,
      };
      const existing = events.get(key);

      // 纠正会同时标记旧条目与新条目；优先保留带 supersedes 的新条目。
      if (!existing || (!existing.supersededId && candidate.supersededId)) {
        events.set(key, candidate);
      }
    }
  }

  return [...events.values()].sort((a, b) => timeMs(b.at) - timeMs(a.at));
}

function buildProfile({ userId, now = Date.now(), includeInactive = false } = {}) {
  const nowMs = typeof now === 'number' ? now : timeMs(now) || Date.now();
  const all = getMemoriesForUser(userId, {
    includeSuperseded: true,
    includeArchived: true,
    includePending: true,
    includeContested: true,
  });

  const active = [];
  const pending = [];
  const contested = [];
  const inactive = [];
  const counts = {
    active: 0,
    pending: 0,
    contested: 0,
    superseded: 0,
    archived: 0,
    denied: 0,
    expired: 0,
    total: all.length,
  };

  for (const raw of sortItems(all)) {
    const item = toItem(raw, nowMs);
    const status = item.status;

    if (status === STATUS_ACTIVE) {
      if (item.effective) {
        active.push(item);
        counts.active += 1;
      } else {
        counts.expired += 1;
        if (includeInactive) inactive.push(item);
      }
      continue;
    }

    if (status === STATUS_PENDING) {
      pending.push(item);
      counts.pending += 1;
      continue;
    }

    if (status === STATUS_CONTESTED) {
      contested.push(item);
      counts.contested += 1;
      continue;
    }

    if (status === STATUS_SUPERSEDED) counts.superseded += 1;
    if (status === STATUS_ARCHIVED) {
      if (item.feedback.withdrawnAt) counts.denied += 1;
      else counts.archived += 1;
    }
    if (includeInactive) inactive.push(item);
  }

  const sections = {
    identity: [],
    preferences: [],
    goals: [],
    relationships: [],
    facts: [],
    other: [],
  };

  for (const item of active) {
    sections[sectionFor(item.type)].push(item);
  }

  const feedbackEvents = buildRecentFeedback(all);
  const recentFeedback = feedbackEvents.slice(0, 20);
  const feedbackCounts = { confirm: 0, deny: 0, correct: 0 };
  for (const event of feedbackEvents) feedbackCounts[event.action] += 1;

  return {
    profileVersion: PROFILE_VERSION,
    generatedAt: new Date(nowMs).toISOString(),
    userId: cleanText(userId),
    sourceOfTruth: 'memory',
    rebuildable: true,
    digestAlgorithm: DIGEST_ALGORITHM,
    digest: buildDigest(all),
    includeInactive: includeInactive === true,
    counts,
    sectionLabels: SECTION_LABELS,
    sections,
    pending,
    contested,
    inactive: includeInactive ? inactive : [],
    feedback: {
      counts: feedbackCounts,
      recent: recentFeedback,
    },
  };
}

const REASON_MESSAGE = Object.freeze({
  invalid_action: 'action 必须是 confirm / deny / correct',
  invalid_feedback_id: 'feedbackId 格式非法',
  missing_id: '缺少记忆 id',
  missing_user: '缺少可信用户身份',
  not_found: '记忆不存在',
  forbidden: '无权操作该记忆',
  invalid_state: '当前状态不允许该反馈',
  feedback_id_conflict: 'feedbackId 已用于另一条记忆',
  invalid_reason: 'reason 必须是字符串',
  reason_too_long: 'reason 超过 80 字上限',
  no_change: '纠正内容与当前记忆相同',
  no_content: '纠正内容不能为空',
  content_too_long: '纠正内容超过 100 字上限',
  sensitive_content: '纠正内容包含敏感信息',
  type_not_allowed: 'type 不在允许范围',
  invalid_confidence: 'confidence 必须在 0-1 之间',
  invalid_keywords: 'keywords 必须是最多 5 个字符串',
  use_confirm_pending: '待确认候选请走确认流程',
});

function validateFeedbackInput(input = {}) {
  const raw = input && typeof input === 'object' ? input : {};
  const action = cleanText(raw.action);
  const id = cleanText(raw.id);
  const userId = cleanText(raw.userId);
  const feedbackId = normalizeFeedbackId(raw.feedbackId);

  if (!FEEDBACK_ACTIONS.includes(action)) {
    return { ok: false, reason: 'invalid_action' };
  }
  if (!id) return { ok: false, reason: 'missing_id' };
  if (!userId) return { ok: false, reason: 'missing_user' };
  if (feedbackId === undefined) return { ok: false, reason: 'invalid_feedback_id' };

  let reason = null;
  if (raw.reason !== undefined && raw.reason !== null) {
    if (typeof raw.reason !== 'string') {
      return { ok: false, reason: 'invalid_reason' };
    }
    reason = raw.reason.trim();
    if (reason.length > FEEDBACK_REASON_MAX) {
      return { ok: false, reason: 'reason_too_long' };
    }
    if (reason && !FEEDBACK_REASON_RE.test(reason)) {
      return { ok: false, reason: 'invalid_reason' };
    }
    if (!reason) reason = null;
  }

  if (action === 'correct') {
    const content =
      typeof raw.content === 'string'
        ? raw.content.replace(/\s+/g, ' ').trim()
        : '';
    if (!content) return { ok: false, reason: 'no_content' };
    if (content.length > 100) return { ok: false, reason: 'content_too_long' };

    if (raw.type !== undefined) {
      if (typeof raw.type !== 'string') return { ok: false, reason: 'type_not_allowed' };
    }
    if (raw.keywords !== undefined) {
      if (
        !Array.isArray(raw.keywords) ||
        raw.keywords.length > 5 ||
        raw.keywords.some(item => typeof item !== 'string')
      ) {
        return { ok: false, reason: 'invalid_keywords' };
      }
    }
    if (raw.confidence !== undefined) {
      const confidence = Number(raw.confidence);
      if (!Number.isFinite(confidence) || confidence < 0 || confidence > 1) {
        return { ok: false, reason: 'invalid_confidence' };
      }
    }
  }

  return {
    ok: true,
    action,
    id,
    userId,
    feedbackId: feedbackId || `fb-${crypto.randomUUID()}`,
    reason,
  };
}

function errorStatus(reason) {
  if (reason === 'not_found') return 404;
  if (reason === 'forbidden') return 403;
  if (
    reason === 'invalid_state' ||
    reason === 'no_change' ||
    reason === 'feedback_id_conflict'
  ) {
    return 409;
  }
  if (reason === 'missing_user') return 500;
  return 400;
}

function errorMessage(reason) {
  return REASON_MESSAGE[reason] || '画像反馈失败';
}

async function applyProfileFeedback(input = {}) {
  const validated = validateFeedbackInput(input);

  if (!validated.ok) {
    return {
      ok: false,
      reason: validated.reason,
      status: errorStatus(validated.reason),
      error: errorMessage(validated.reason),
    };
  }

  const { action, id, userId, feedbackId, reason } = validated;
  const ownership = checkMemoryOwnership(id, userId);

  if (!ownership.ok) {
    return {
      ok: false,
      reason:
        ownership.reason === 'not-found' ? 'not_found' : ownership.reason,
      status: errorStatus(
        ownership.reason === 'not-found' ? 'not_found' : ownership.reason
      ),
      error: errorMessage(
        ownership.reason === 'not-found' ? 'not_found' : ownership.reason
      ),
    };
  }

  const all = getMemoriesForUser(userId, {
    includeSuperseded: true,
    includeArchived: true,
    includePending: true,
    includeContested: true,
  });
  const target = all.find(item => item && item.id === id);

  if (!target) {
    return {
      ok: false,
      reason: 'not_found',
      status: 404,
      error: errorMessage('not_found'),
    };
  }

  let result;

  if (action === 'confirm') {
    if (target.status === STATUS_PENDING) {
      result = await confirmPending(id, userId, { feedbackId });
    } else {
      result = await confirmMemoryFeedback({ id, userId, feedbackId });
    }
    if (result.reason === 'use-confirm-pending') {
      result = await confirmPending(id, userId, { feedbackId });
    }
  } else if (action === 'deny') {
    result = await denyMemoryFeedback({
      id,
      userId,
      feedbackId,
      reason: reason || 'user_denied',
    });
  } else {
    result = await correctMemoryFeedback({
      id,
      userId,
      feedbackId,
      content: input.content,
      type: input.type,
      keywords: input.keywords,
      confidence: input.confidence,
    });
  }

  if (result.reason !== 'ok') {
    const rawReason = String(result.reason || '');
    const reasonCode = rawReason === 'use-confirm-pending'
      ? 'invalid_state'
      : rawReason.replace(/-/g, '_');
    return {
      ok: false,
      reason: reasonCode,
      status: errorStatus(reasonCode),
      error: errorMessage(reasonCode),
      feedbackId,
    };
  }

  const profile = buildProfile({ userId });

  return {
    ok: true,
    action,
    feedbackId,
    result,
    profile,
  };
}

module.exports = {
  PROFILE_VERSION,
  DIGEST_ALGORITHM,
  FEEDBACK_ACTIONS,
  SECTION_ORDER,
  SECTION_LABELS,
  buildProfile,
  applyProfileFeedback,
  validateFeedbackInput,
  errorStatus,
  errorMessage,
};
