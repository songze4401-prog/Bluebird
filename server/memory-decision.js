/* 记忆写入决策规则（纯函数；匹配分数由 memory.js 计算后传入） */
const DECISION = Object.freeze({
  CREATE: 'create',
  MERGE: 'merge',
  UPDATE: 'update',
  SUPERSEDE: 'supersede',
  REJECT: 'reject',
  NEEDS_CONFIRMATION: 'needs_confirmation',
});

const DEFAULT_RULES = Object.freeze({
  minConfidence: 0.85,
  confirmableConfidence: 0.6,
  duplicateMin: 0.8,
  conflictMin: 0.3,
});

const LONG_TERM_TYPES = new Set(['identity', 'preference', 'relationship']);
const TEMPORARY_RE =
  /(今天|今晚|明天|昨天|此刻|现在|目前|这周|本周|这个月|临时|暂时|短期|一次性)/;
const MOOD_RE = /(心情|情绪|有点累|累了|困了|饿了|开心|难过|生气|焦虑|无聊)/;

function isTemporaryCandidate(candidate) {
  if (!candidate || !candidate.content) return false;
  // 显式给出有效期的事件不按“临时状态污染长期偏好”处理。
  if (candidate.validTo) return false;

  if (MOOD_RE.test(candidate.content)) return true;

  return (
    LONG_TERM_TYPES.has(candidate.type) && TEMPORARY_RE.test(candidate.content)
  );
}

function reject(reason) {
  return { decision: DECISION.REJECT, reason, target: null };
}

function needsConfirmation(reason, target = null, extra = {}) {
  return { decision: DECISION.NEEDS_CONFIRMATION, reason, target, ...extra };
}

/**
 * @param {object} input
 * @param {object} input.candidate 已归一化的候选（content/type/confidence/sourceType/validTo）
 * @param {Array} input.matches [{item, similarity, sameType, sharedKeyword}]
 * @param {object|null} input.target 显式指定的更新目标
 * @param {object} input.rules
 * @returns {{decision:string, reason:string, target:object|null}}
 */
function decide({ candidate, matches = [], target = null, rules = DEFAULT_RULES } = {}) {
  if (!candidate || typeof candidate.content !== 'string' || !candidate.content) {
    return reject('no_content');
  }

  if (isTemporaryCandidate(candidate)) {
    return reject('temporary_state');
  }

  const confidence = Number(candidate.confidence);

  if (!Number.isFinite(confidence) || confidence < rules.minConfidence) {
    const confirmable =
      candidate.sourceType === 'agent' &&
      Number.isFinite(confidence) &&
      confidence >= rules.confirmableConfidence;

    return confirmable
      ? needsConfirmation('low_confidence')
      : reject('low_confidence');
  }

  if (candidate.requiresConfirmation) {
    return needsConfirmation(candidate.confirmationReason || 'ambiguous_candidate');
  }

  if (target) {
    return {
      decision: DECISION.UPDATE,
      reason: 'explicit_target_update',
      target,
    };
  }

  const duplicates = matches.filter(
    match => match && match.contextConflict !== true && match.similarity >= rules.duplicateMin
  );

  if (duplicates.length > 1) {
    return needsConfirmation('ambiguous_duplicate', null, {
      duplicates: duplicates.map(match => match.item),
    });
  }

  if (duplicates.length === 1) {
    // 去重目标不在当前会话作用域内（别的会话的私有事实）：全局去重是既有
    // 能力，仍然合并为同一条事实，但必须标记出来——写入时只追加贡献，
    // 不得用本次候选改写对方条目的正文、类型与关键词。
    const crossSession = duplicates[0].visible === false;

    return {
      decision: DECISION.MERGE,
      reason: crossSession ? 'same_fact_other_session' : 'same_fact',
      target: duplicates[0].item,
    };
  }

  const conflicts = matches.filter(
    match =>
      match &&
      match.contextConflict !== true &&
      match.visible !== false &&
      match.sameType &&
      match.sharedKeyword &&
      match.similarity >= rules.conflictMin &&
      match.similarity < rules.duplicateMin
  );

  if (conflicts.length > 1) {
    return needsConfirmation('ambiguous_conflict', null, {
      conflicts: conflicts.map(match => match.item),
    });
  }

  if (conflicts.length === 1) {
    return {
      decision: DECISION.SUPERSEDE,
      reason: 'contradicts_existing',
      target: conflicts[0].item,
    };
  }

  return { decision: DECISION.CREATE, reason: 'new_fact', target: null };
}

module.exports = {
  DECISION,
  DEFAULT_RULES,
  LONG_TERM_TYPES,
  TEMPORARY_RE,
  MOOD_RE,
  isTemporaryCandidate,
  decide,
};