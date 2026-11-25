/* 记忆写入证据与类别策略（P1，纯函数，不含 IO）。
 *
 * 目标：把“是否值得保留 / 能相信到什么程度 / 现在允许做什么”分开建模。
 * evidence 只保留可解释分量，不合成一个看似精确的总分；最终动作由类别策略
 * 与显式持久意图决定，模型自报的 confidence 只是一个原始特征。
 */
const { DECISION } = require('./memory-decision');

const POLICY_VERSION = 'p2.0';
const DECISION_VERSION = 'p2.0';
// S9：反馈纠正路径（user_correction 重写记忆）使用的版本。它与首次写入的
// POLICY_VERSION / DECISION_VERSION 分开治理；值固定为 'p5.0' 以兼容已存数据。
const FEEDBACK_POLICY_VERSION = 'p5.0';
const FEEDBACK_DECISION_VERSION = 'p5.0';

const PROVENANCE = Object.freeze({
  USER_ASSERTED: 'user_asserted',
  AGENT_OBSERVED: 'agent_observed',
  MODEL_INFERRED: 'model_inferred',
  TOOL_OBSERVED: 'tool_observed',
  IMPORTED: 'imported',
});

const VALID_PROVENANCE = new Set(Object.values(PROVENANCE));

const CATEGORY = Object.freeze({
  STABLE_FACT: 'stable_fact',
  TEMPORARY_STATE: 'temporary_state',
  LONG_TERM_PREFERENCE: 'long_term_preference',
  BEHAVIOR_PATTERN: 'behavior_pattern',
  PROJECT_DECISION: 'project_decision',
  MODEL_INFERENCE: 'model_inference',
  SENSITIVE: 'sensitive',
  LEGACY: 'legacy',
});

const POLICY_MODES = new Set(['compat', 'strict']);

const TEMPORARY_RE =
  /(今天|今晚|明天|昨天|此刻|现在|目前|这周|本周|这个月|临时|暂时|短期|一次性|最近|这几天)/;
const MOOD_RE = /(心情|情绪|有点累|累了|困了|饿了|开心|难过|生气|焦虑|无聊)/;
const DECISION_RE = /(决定|采用|选择|方案|架构|迁移|上线|改用|换成)/;
// 「好像」在 memory-confidence-candidates.md 的犹豫语气词清单里，2026-11-19 补齐：
// 此前漏列导致 hedged 候选（如「我好像挺喜欢…」）在 compat 下被直接晋升为 active，
// 由评测 Phase5 探针实证实锤后修复。
const HEDGE_RE = /(可能|也许|似乎|大概|好像|倾向于|应该是|估计|或许|不确定)/;
const PERSISTENT_INTENT_RE =
  /(记住|记下|记着|别忘|不要忘|以后|今后|从今以后|长期|始终|一直|永远|每次|往后)/;
// 仅接受当前用户直接发出的肯定保存指令。它刻意比 persistent-intent
// 更窄：普通长期事实、否定、条件句和转述都不能仅凭一个“记住”字样授权 Agent 落盘。
const DIRECT_MEMORY_REQUEST_RE =
  /(?:^|[。.!?;，,:：\n])\s*(?:(?:请|麻烦|帮我|请帮我|你|please|kindly|can you|could you|would you|help me|I want you to|I need you to|我希望你(?:能)?|我想让你|我要你|(?:从今以后|以后|今后|往后)\s*(?:帮我)?)\s*)*(?:把.{0,30}(?:记住|记下|记着|记一下|记下来|记录|保存|存到记忆里)|记住(?!了|过)|记下(?!了|过)|记着(?!了|过)|记一下|记一笔|记录(?:一下|下来)?|保存(?:到记忆里?)?|存(?:到记忆里?|起来)|写入记忆|加入记忆|remember(?!ed|ing)(?:\s+(?:that|this))?|save(?!d|s|ing)(?:\s+(?:this|that|it)(?:\s+to memory)?)?|store(?!d|s|ing)(?:\s+(?:this|that|it)(?:\s+in memory)?)?|keep in mind|note(?:\s+down)?|make a note)/i;
const CONDITIONAL_MEMORY_INTENT_RE =
  /(如果|假如|假设|要是|倘若|万一|假使|假定|\bif\b|\bsuppose(?:d)?\b|\bhypothetical(?:ly)?\b)/i;
const REPORTED_MEMORY_INTENT_RE =
  /(?:(?:他说|她说|朋友(?:曾)?说|有人说|别人说|同事说|家人说|they said|he said|she said|someone said)|(?:我在)?[^。.!?;\n]{0,24}(?:文章|帖子|书|邮件|网页|新闻|视频|聊天记录|评论|原文|引用)(?:里|中|上)?[^。.!?;\n]{0,12}(?:看到|看见|读到|听到|写着|写道|提到|表示|说|要求|建议)|\baccording to\b[^.!?\n]{0,80}|\b(?:a|an|the|this)\s+(?:article|post|book|email|webpage|news(?: report)?|video|message|quote|citation)\s+(?:says|said|writes|wrote|asks|asked|recommends|recommended|states|stated)\b|\bI (?:read|saw|heard|found)\b[^.!?\n]{0,80}\b(?:article|post|book|email|webpage|news|video|message|quote|citation)\b[^.!?\n]{0,20}(?:says|said|writes|wrote|asks|asked|recommends|recommended)?)$/i;
const EXPLICIT_CORRECTION_RE =
  /(更正|纠正|改成|改为|改(?:喝|用|叫|住|选)|换成|现在(?:我|用户)?(?:喜欢|用|叫|住|选择)|不再|已经不|不是.{0,20}(而是|改为|换成))/;
const MEMORY_CORRECTION_CONTEXT_RE =
  /(记忆|偏好|画像|记住|记下|常住|居住地|住在|搬到|搬家|居住|名字|职业|过敏|项目代号|生日|车牌|编辑器|喜欢|不爱|改(?:喝|用|叫|住|选)|不再(?:喝|用|叫|住|选|喜欢)|现在(?:我|用户)?(?:喜欢|用|叫|住|选择))/;
const MEMORY_CORRECTION_MARKER_RE =
  /(更正|纠正|改成|改为|换成|不再|已经不|不是.{0,20}(?:而是|改为|换成))/;
const MEMORY_CORRECTION_STRONG_RE = /(改(?:喝|用|叫|住|选)|换成)/;
const ACTIVE_CONFIDENCE = Object.freeze({
  [CATEGORY.STABLE_FACT]: 0.82,
  [CATEGORY.LONG_TERM_PREFERENCE]: 0.88,
  [CATEGORY.PROJECT_DECISION]: 0.86,
});
const PENDING_CONFIDENCE = Object.freeze({
  [CATEGORY.STABLE_FACT]: 0.55,
  [CATEGORY.LONG_TERM_PREFERENCE]: 0.62,
  [CATEGORY.PROJECT_DECISION]: 0.58,
  [CATEGORY.BEHAVIOR_PATTERN]: 0.6,
  [CATEGORY.MODEL_INFERENCE]: 0.55,
  [CATEGORY.LEGACY]: 0.65,
});

function normalizeText(value) {
  return typeof value === 'string'
    ? value.replace(/\s+/g, ' ').trim()
    : '';
}

function getPolicyMode(env = process.env) {
  const raw = String(env.BLUEBIRD_MEMORY_EVIDENCE_POLICY || '')
    .trim()
    .toLowerCase();

  return POLICY_MODES.has(raw) ? raw : 'compat';
}

function hasHedge(text) {
  return HEDGE_RE.test(String(text || ''));
}

function hasTemporaryMarker(text) {
  return TEMPORARY_RE.test(String(text || '')) || MOOD_RE.test(String(text || ''));
}

function detectPersistentIntent(text) {
  return PERSISTENT_INTENT_RE.test(String(text || ''));
}

function detectExplicitMemoryIntent(text) {
  const value = String(text || '').trim();
  if (!value || CONDITIONAL_MEMORY_INTENT_RE.test(value)) return false;

  // 否定命令不是保存授权；“别忘了”不在此列，因为它是肯定的记忆请求。
  if (
    /(?:不要|别|不必|无需|不用|不能|不需要|拒绝|停止)\s*(?:再\s*)?(?:请\s*)?(?:记住|记下|记着|记一下|记录|保存|存到记忆|写入记忆|加入记忆)|\b(?:do not|don't|never|not)\s+(?:please\s+)?(?:remember|save|store|note|keep in mind)\b/i.test(
      value
    )
  ) {
    return false;
  }

  const match = DIRECT_MEMORY_REQUEST_RE.exec(value);
  if (!match) return false;

  const prefix = value
    .slice(0, match.index)
    .replace(/[\s，,。.!?;:：]+$/u, '');
  const currentClausePrefix = prefix.split(/[。.!?;\n]/).pop().trim();
  if (REPORTED_MEMORY_INTENT_RE.test(currentClausePrefix)) return false;

  return true;
}

function detectExplicitCorrection(text) {
  return EXPLICIT_CORRECTION_RE.test(String(text || ''));
}

function detectMemoryCorrectionIntent(text) {
  const value = String(text || '');
  const correction =
    MEMORY_CORRECTION_MARKER_RE.test(value) || MEMORY_CORRECTION_STRONG_RE.test(value);
  return correction && MEMORY_CORRECTION_CONTEXT_RE.test(value);
}

function resolveProvenance(candidate = {}, options = {}) {
  const explicit = candidate.provenance || options.provenance;

  if (VALID_PROVENANCE.has(explicit)) return explicit;
  if (candidate.inferred === true || options.inferred === true) {
    return PROVENANCE.MODEL_INFERRED;
  }

  switch (candidate.sourceType || options.sourceType || 'user') {
    case 'agent':
      return PROVENANCE.AGENT_OBSERVED;
    case 'model':
      return PROVENANCE.MODEL_INFERRED;
    case 'tool':
      return PROVENANCE.TOOL_OBSERVED;
    case 'import':
      return PROVENANCE.IMPORTED;
    default:
      return PROVENANCE.USER_ASSERTED;
  }
}

function classifyCategory(candidate = {}, provenance) {
  const text = String(candidate.content || '');
  const type = candidate.type;

  if (provenance === PROVENANCE.MODEL_INFERRED) {
    return CATEGORY.MODEL_INFERENCE;
  }

  if (
    hasHedge(text) ||
    hasHedge(candidate.sourceQuote) ||
    hasHedge(candidate.userText)
  ) {
    return CATEGORY.BEHAVIOR_PATTERN;
  }
  if (MOOD_RE.test(text)) return CATEGORY.TEMPORARY_STATE;
  if (candidate.explicitCorrection === true) {
    if (type === 'identity' || type === 'relationship') return CATEGORY.STABLE_FACT;
    if (type === 'preference') return CATEGORY.LONG_TERM_PREFERENCE;
    if (type === 'goal' || DECISION_RE.test(text)) return CATEGORY.PROJECT_DECISION;
    return CATEGORY.STABLE_FACT;
  }
  if (TEMPORARY_RE.test(text) && type !== 'goal') {
    return CATEGORY.TEMPORARY_STATE;
  }
  if (type === 'identity' || type === 'relationship') {
    return CATEGORY.STABLE_FACT;
  }
  // 偏好优先于“方案/选择”等词：否则“喜欢某个方案”会被误判为项目决策。
  if (type === 'preference') return CATEGORY.LONG_TERM_PREFERENCE;
  if (type === 'goal' || DECISION_RE.test(text)) {
    return CATEGORY.PROJECT_DECISION;
  }

  return CATEGORY.STABLE_FACT;
}

function categoryUtility(category) {
  switch (category) {
    case CATEGORY.PROJECT_DECISION:
      return 0.9;
    case CATEGORY.STABLE_FACT:
    case CATEGORY.LONG_TERM_PREFERENCE:
      return 0.8;
    case CATEGORY.TEMPORARY_STATE:
      return 0.4;
    case CATEGORY.BEHAVIOR_PATTERN:
      return 0.5;
    case CATEGORY.MODEL_INFERENCE:
      return 0.3;
    case CATEGORY.SENSITIVE:
      return 0;
    default:
      return 0.5;
  }
}

function sourceReliabilityOf(provenance) {
  switch (provenance) {
    case PROVENANCE.USER_ASSERTED:
      return 1;
    case PROVENANCE.TOOL_OBSERVED:
      return 0.85;
    case PROVENANCE.AGENT_OBSERVED:
      return 0.7;
    case PROVENANCE.IMPORTED:
      return 0.6;
    case PROVENANCE.MODEL_INFERRED:
      return 0.3;
    default:
      return 0.5;
  }
}

function directnessOf(provenance, grounded) {
  const base =
    provenance === PROVENANCE.USER_ASSERTED
      ? 0.9
      : provenance === PROVENANCE.TOOL_OBSERVED
        ? 0.8
        : provenance === PROVENANCE.AGENT_OBSERVED
          ? 0.7
          : provenance === PROVENANCE.IMPORTED
            ? 0.5
            : 0.3;

  return Math.min(1, grounded ? base + 0.1 : base);
}

function specificityOf(candidate) {
  const keywords = Array.isArray(candidate.keywords) ? candidate.keywords.length : 0;
  const contentLength = String(candidate.content || '').length;

  return Math.min(
    1,
    Math.round(
      ((Math.min(5, keywords) / 5) * 0.6 +
        Math.min(1, contentLength / 40) * 0.4) *
        100
    ) / 100
  );
}

function contributionStats(existing, candidate) {
  const contributions =
    existing && Array.isArray(existing.contributions)
      ? existing.contributions.slice()
      : [];
  const sessions = new Set(
    contributions.map(contribution => contribution && contribution.sessionId).filter(Boolean)
  );
  const candidateSession =
    candidate.contributions && candidate.contributions[0]
      ? candidate.contributions[0].sessionId
      : null;

  if (candidateSession) sessions.add(candidateSession);

  return {
    repetition: contributions.length + 1,
    independentSessions: sessions.size,
  };
}

function recencyOf(candidate, now = Date.now()) {
  if (candidate.validTo) {
    const expiresAt = Date.parse(candidate.validTo);
    if (Number.isFinite(expiresAt) && expiresAt <= now) return 0;
  }
  const observedAt = Date.parse(candidate.observedAt || candidate.createdAt || '');
  if (!Number.isFinite(observedAt)) return 0.6;
  const ageDays = Math.max(0, (now - observedAt) / 86400000);
  if (ageDays <= 30) return 1;
  if (ageDays <= 180) return 0.85;
  if (ageDays <= 365) return 0.65;
  if (ageDays <= 730) return 0.4;
  return 0.2;
}

function buildEvidence({
  candidate,
  decision,
  existing = null,
  userText = '',
  counterEvidence = 0,
  policyMode = 'compat',
} = {}) {
  const firstContribution =
    candidate.contributions && candidate.contributions[0]
      ? candidate.contributions[0]
      : null;
  const quote = normalizeText(
    (firstContribution && firstContribution.sourceQuote) || candidate.sourceQuote
  );
  const normalizedUser = normalizeText(userText);
  const quoteGrounded = Boolean(
    quote && normalizedUser && normalizedUser.includes(quote)
  );
  const stats = contributionStats(existing, candidate);
  const counterexamples = Math.max(
    0,
    Number.isFinite(counterEvidence) ? counterEvidence : 0
  );
  const resolvedByUserCorrection =
    candidate.provenance === PROVENANCE.USER_ASSERTED &&
    candidate.sourceType === 'user' &&
    candidate.explicitCorrection === true;
  const consistency =
    !resolvedByUserCorrection &&
    (counterexamples > 0 ||
      (decision &&
        [DECISION.SUPERSEDE, DECISION.NEEDS_CONFIRMATION].includes(
          decision.decision
        )))
      ? 0.5
      : 1;

  return {
    directness: directnessOf(candidate.provenance, quoteGrounded),
    sourceReliability: sourceReliabilityOf(candidate.provenance),
    repetition: stats.repetition,
    independentSessions: stats.independentSessions,
    consistency,
    counterEvidence: counterexamples,
    recency: recencyOf(candidate),
    specificity: specificityOf(candidate),
    utility: categoryUtility(candidate.category),
    sensitivity: candidate.sensitive === true ? 1 : 0,
    modelConfidence: Number(candidate.confidence),
    persistentIntent: candidate.persistentIntent === true,
    explicitMemoryIntent: candidate.explicitMemoryIntent === true,
    contentGrounded: candidate.contentGrounded === true,
    quotePresent: Boolean(quote),
    quoteGrounded,
    hedged: candidate.uncertainty === 'source_hedged' || hasHedge(quote),
    explicitCorrection: candidate.explicitCorrection === true,
    policyMode,
  };
}

function withDecision(decision, action, reason) {
  return { ...decision, decision: action, reason };
}

function pending(decision, reason) {
  return withDecision(decision, DECISION.NEEDS_CONFIRMATION, reason);
}

function reject(decision, reason) {
  return withDecision(decision, DECISION.REJECT, reason);
}

function needsReview(decision, reason) {
  // 已有同事实 active 条目时，不因低置信候选再造一份重复 pending。
  return decision.decision === DECISION.MERGE
    ? reject(decision, 'low_confidence')
    : pending(decision, reason);
}

function applyEvidencePolicy({
  candidate,
  decision,
  evidence,
  policyMode = 'compat',
} = {}) {
  if (!decision || decision.decision === DECISION.REJECT) return decision;
  if (evidence.sensitivity > 0) return reject(decision, 'sensitive_content');
  if (candidate.category === CATEGORY.TEMPORARY_STATE) {
    return reject(decision, 'temporary_state');
  }
  if (evidence.recency < 0.25) return reject(decision, 'stale_evidence');
  if (evidence.utility < 0.3) return reject(decision, 'low_utility');
  if (evidence.specificity < 0.18) {
    return reject(decision, 'insufficient_specificity');
  }
  if (
    evidence.sourceReliability < 0.5 &&
    evidence.independentSessions < 2 &&
    candidate.category !== CATEGORY.MODEL_INFERENCE
  ) {
    return reject(decision, 'weak_source_evidence');
  }
  const confidence = Number(evidence.modelConfidence);
  const categoryFloor = PENDING_CONFIDENCE[candidate.category] || 0.65;
  const repetitionCredit = evidence.independentSessions >= 2 ? 0.1 : 0;
  const intentCredit = evidence.persistentIntent ? 0.08 : 0;
  if (confidence + repetitionCredit + intentCredit < categoryFloor) {
    return reject(decision, 'low_confidence');
  }
  if (candidate.requiresConfirmation) {
    return pending(
      decision,
      candidate.confirmationReason || 'ambiguous_candidate'
    );
  }
  // 推断和带犹豫语气的原话不能自动成为确定事实；重复也不抹掉原话中的不确定性。
  if (
    candidate.provenance === PROVENANCE.MODEL_INFERRED ||
    candidate.category === CATEGORY.MODEL_INFERENCE
  ) {
    return pending(decision, 'model_inference_requires_confirmation');
  }
  if (evidence.hedged || candidate.category === CATEGORY.BEHAVIOR_PATTERN) {
    return pending(decision, 'user_hedged_requires_confirmation');
  }
  if (decision.decision === DECISION.NEEDS_CONFIRMATION) return decision;

  const directUserEvidence =
    candidate.provenance === PROVENANCE.USER_ASSERTED &&
    candidate.sourceType === 'user' &&
    evidence.quotePresent &&
    evidence.directness >= 0.9 &&
    evidence.sourceReliability >= 0.95;
  // Agent 工具只有在原话确实接地到当前用户消息时，才可作为较低可靠度的直接来源；
  // 对已有 active 记忆的更新/合并仍由 memory.js 的用户确认门禁拦住。
  const directAgentQuoteEvidence =
    candidate.provenance === PROVENANCE.AGENT_OBSERVED &&
    candidate.sourceType === 'agent' &&
    candidate.explicitMemoryIntent === true &&
    evidence.quoteGrounded &&
    evidence.directness >= 0.79 &&
    evidence.sourceReliability >= 0.7;
  // 2026-11-23：显式要求「记住」的 Agent 写入不再强制逐字原话。
  // 用户在聊天里明确要求记录时，允许模型用自己的话概括并直接落地；
  // 改写/合并已有记忆仍走 requireMutationConfirmation 的确认门禁。
  const directAgentExplicitEvidence =
    candidate.provenance === PROVENANCE.AGENT_OBSERVED &&
    candidate.sourceType === 'agent' &&
    candidate.intent === 'explicit' &&
    candidate.explicitMemoryIntent === true &&
    evidence.contentGrounded === true &&
    confidence >= 0.7;
  const directEvidence =
    directUserEvidence || directAgentQuoteEvidence || directAgentExplicitEvidence;
  // 长期偏好允许用户用一条明确记忆意图更新旧偏好；这不是通用冲突豁免，
  // 必须是直接用户原话、原话接地、近期且高置信，并有足够具体信息。
  const currentPreferenceUpdate =
    candidate.category === CATEGORY.LONG_TERM_PREFERENCE &&
    decision.decision === DECISION.SUPERSEDE &&
    directUserEvidence &&
    evidence.quoteGrounded &&
    evidence.persistentIntent &&
    confidence >= 0.9 &&
    evidence.recency >= 0.8 &&
    evidence.specificity >= 0.25;
  const corroborated =
    directEvidence &&
    evidence.independentSessions >= 2 &&
    evidence.consistency >= 0.9 &&
    evidence.recency >= 0.5;
  const hasUnresolvedConflict = evidence.counterEvidence > 0;
  if (
    hasUnresolvedConflict &&
    !(directUserEvidence && evidence.explicitCorrection && confidence >= 0.7) &&
    !currentPreferenceUpdate
  ) {
    return pending(decision, 'contradictory_evidence_requires_confirmation');
  }
  if (!directEvidence) {
    return pending(decision, 'source_evidence_requires_confirmation');
  }

  const stableOrDirect = evidence.consistency >= 0.9 && evidence.recency >= 0.6;
  switch (candidate.category) {
    case CATEGORY.STABLE_FACT: {
      const supported =
        (confidence >= ACTIVE_CONFIDENCE[CATEGORY.STABLE_FACT] && stableOrDirect) ||
        (evidence.persistentIntent && confidence >= 0.65 && stableOrDirect) ||
        (corroborated && confidence >= 0.65);
      return supported
        ? { decision: decision.decision, reason: decision.reason }
        : needsReview(decision, 'low_confidence_candidate');
    }
    case CATEGORY.LONG_TERM_PREFERENCE: {
      const repeated = corroborated && confidence >= 0.7;
      const explicit = evidence.persistentIntent && confidence >= 0.65 && stableOrDirect;
      const corrected = evidence.explicitCorrection && confidence >= 0.65 && stableOrDirect;
      const compatibleSingleStatement =
        policyMode === 'compat' &&
        confidence >= 0.9 &&
        evidence.consistency >= 0.9 &&
        evidence.recency >= 0.6;
      const supported =
        repeated ||
        explicit ||
        corrected ||
        currentPreferenceUpdate ||
        compatibleSingleStatement;
      return supported
        ? { decision: decision.decision, reason: decision.reason }
        : needsReview(
            decision,
            policyMode === 'strict' &&
            !repeated &&
            !explicit &&
            !corrected &&
            !currentPreferenceUpdate
              ? 'single_preference_candidate'
              : 'low_confidence_candidate'
          );
    }
    case CATEGORY.PROJECT_DECISION: {
      const supported =
        (confidence >= ACTIVE_CONFIDENCE[CATEGORY.PROJECT_DECISION] && stableOrDirect) ||
        (evidence.persistentIntent && confidence >= 0.7 && stableOrDirect) ||
        (corroborated && confidence >= 0.72);
      return supported
        ? { decision: decision.decision, reason: decision.reason }
        : needsReview(decision, 'low_confidence_candidate');
    }
    default:
      return pending(decision, 'category_requires_confirmation');
  }
}

module.exports = {
  POLICY_VERSION,
  DECISION_VERSION,
  FEEDBACK_POLICY_VERSION,
  FEEDBACK_DECISION_VERSION,
  PROVENANCE,
  VALID_PROVENANCE,
  CATEGORY,
  POLICY_MODES,
  TEMPORARY_RE,
  MOOD_RE,
  DECISION_RE,
  HEDGE_RE,
  PERSISTENT_INTENT_RE,
  DIRECT_MEMORY_REQUEST_RE,
  ACTIVE_CONFIDENCE,
  PENDING_CONFIDENCE,
  getPolicyMode,
  hasHedge,
  hasTemporaryMarker,
  detectPersistentIntent,
  detectExplicitMemoryIntent,
  detectExplicitCorrection,
  detectMemoryCorrectionIntent,
  resolveProvenance,
  classifyCategory,
  buildEvidence,
  applyEvidencePolicy,
};
