/* 记忆写入证据与类别策略（P1，纯函数，不含 IO）。
 *
 * 目标：把“是否值得保留 / 能相信到什么程度 / 现在允许做什么”分开建模。
 * evidence 只保留可解释分量，不合成一个看似精确的总分；最终动作由类别策略
 * 与显式持久意图决定，模型自报的 confidence 只是一个原始特征。
 */
const { DECISION } = require('./memory-decision');

const POLICY_VERSION = 'p1.0';
const DECISION_VERSION = 'p1.0';

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
const HEDGE_RE = /(可能|也许|似乎|大概|倾向于|应该是|估计|或许|不确定)/;
const PERSISTENT_INTENT_RE =
  /(记住|记下|记着|别忘|不要忘|以后|今后|从今以后|长期|始终|一直|永远|每次|往后)/;

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

  if (hasHedge(text)) return CATEGORY.BEHAVIOR_PATTERN;
  if (hasTemporaryMarker(text)) return CATEGORY.TEMPORARY_STATE;
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

function buildEvidence({
  candidate,
  decision,
  existing = null,
  userText = '',
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
  const grounded = Boolean(quote && normalizedUser && normalizedUser.includes(quote));
  const stats = contributionStats(existing, candidate);
  const consistency =
    decision && [DECISION.SUPERSEDE, DECISION.NEEDS_CONFIRMATION].includes(decision.decision)
      ? 0.5
      : 1;

  return {
    directness: directnessOf(candidate.provenance, grounded),
    sourceReliability: sourceReliabilityOf(candidate.provenance),
    repetition: stats.repetition,
    independentSessions: stats.independentSessions,
    consistency,
    recency: 1,
    specificity: specificityOf(candidate),
    utility: categoryUtility(candidate.category),
    sensitivity: candidate.sensitive === true ? 1 : 0,
    modelConfidence: Number(candidate.confidence),
    persistentIntent: candidate.persistentIntent === true,
    policyMode,
  };
}

// compat 只收紧“推断/行为模式必须确认”；strict 额外要求单次偏好先成为候选。
function applyEvidencePolicy({
  candidate,
  decision,
  evidence,
  policyMode = 'compat',
} = {}) {
  if (
    candidate.provenance === PROVENANCE.MODEL_INFERRED ||
    candidate.category === CATEGORY.MODEL_INFERENCE
  ) {
    return {
      decision: DECISION.NEEDS_CONFIRMATION,
      reason: 'model_inference_requires_confirmation',
    };
  }

  if (candidate.category === CATEGORY.BEHAVIOR_PATTERN) {
    return {
      decision: DECISION.NEEDS_CONFIRMATION,
      reason: 'behavior_pattern_requires_confirmation',
    };
  }

  if (
    policyMode === 'strict' &&
    candidate.category === CATEGORY.LONG_TERM_PREFERENCE &&
    decision.decision === DECISION.CREATE &&
    candidate.persistentIntent !== true &&
    evidence.independentSessions < 2
  ) {
    return {
      decision: DECISION.NEEDS_CONFIRMATION,
      reason: 'single_preference_candidate',
    };
  }

  return { decision: decision.decision, reason: decision.reason };
}

module.exports = {
  POLICY_VERSION,
  DECISION_VERSION,
  PROVENANCE,
  VALID_PROVENANCE,
  CATEGORY,
  POLICY_MODES,
  TEMPORARY_RE,
  MOOD_RE,
  DECISION_RE,
  HEDGE_RE,
  PERSISTENT_INTENT_RE,
  getPolicyMode,
  hasHedge,
  hasTemporaryMarker,
  detectPersistentIntent,
  resolveProvenance,
  classifyCategory,
  buildEvidence,
  applyEvidencePolicy,
};
