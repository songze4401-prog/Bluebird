// 记忆候选写入决策簇（健康度审计 R7 收官，2026-11-21 自 memory.js 迁出）。
//
// 职责：自动写入的最高风险路径——normalizeCandidate（候选归一化）/
// candidateValidationError（校验）/ decisionRecord/storedCandidate（裁决
// 记录）/ findDuplicateSourceEntry/rulesForCandidate/findPendingCandidate
// ForPromotion（去重与晋升规则）/ trimToCapacity（配额淘汰，六常量随迁）/
// applyCandidate（632 行主体：写入/晋升/合并/supersede 决策与落盘）。
//
// 设计边界（勿破坏）：
// - 写路径经共享容器 server/memory-core.js（23 键，本刀零新增收官）：
//   enqueueWrite/saveMemories/commitWithTombstones/refreshDerivedMemoryIndex/
//   logDataEvent/memoryFile/memoryEnabled/getMemoryList/setMemoryList/
//   getTombstones。memories = next 六处改写带括号配平校验。
// - 零回边：不 require memory.js。同层依赖九源（ranking/lifecycle/decision/
//   evidence/extraction/retrieval/tombstones/user-scope/lifecycle-ops——
//   44 符号运行时断言过，oracle 独立复核口径）。
// - logLifecycleEvent/logLifecycleRejection/trimToCapacity 随迁后由
//   memory.js 回注续注容器（feedback/lifecycle-ops/crud 三模块的容器
//   消费链不变）。
// - attemptMemoryWrite/processMemory/writeOutcomes 簇留守 memory.js
//   （writeOutcomes 是模块级状态，迁出需第四组闭包对——R8 显式决策）。
//
// 消费方：memory.js 经解构回注（applyCandidate 被 processMemory 调用、
// logLifecycle 三件续注容器），调用点零改动。
const { memoryCore } = require('./memory-core');
const {
  ALLOWED_TYPES,
  cleanText,
  isSensitive,
  normalize,
  similarity,
  SOURCE_TYPES,
} = require('./memory-ranking');
const {
  STATUS_ACTIVE,
  STATUS_ARCHIVED,
  STATUS_CONTESTED,
  STATUS_PENDING,
  STATUS_SUPERSEDED,
  isEffectiveAt,
} = require('./memory-lifecycle');
const { DECISION, DEFAULT_RULES, decide } = require('./memory-decision');
const {
  CATEGORY,
  DECISION_VERSION,
  POLICY_VERSION,
  PROVENANCE,
  VALID_PROVENANCE,
  applyEvidencePolicy,
  buildEvidence,
  classifyCategory,
  detectExplicitCorrection,
  detectExplicitMemoryIntent,
  detectPersistentIntent,
  getPolicyMode,
  hasHedge,
  resolveProvenance,
} = require('./memory-evidence');
const {
  ANCHOR_FALLBACK_MIN,
  ANCHOR_MIN,
  cloneEntry,
  isActive,
  issuedId,
  keywordGrounding,
  mergeContributions,
  normalizeContribution,
  shareKeyword,
} = require('./memory-extraction');
const { resolveReadScope, scopeOf } = require('./memory-retrieval');
const { hashText, tombstoneBlocksCandidate } = require('./memory-tombstones');
const { getInstanceUserId } = require('./user-scope');
const { PENDING_CANDIDATE_MATCH_MIN, stripHedgePendingMark } = require('./memory-lifecycle-ops');
const MEMORY_LIMIT = 100;
// 待确认候选只有高度相似的后续表达才合并，避免将相近但不同的事实并成一条。
// 被更正的旧条目不立刻删除（审计与回滚要看得见的），但只留最近的这么多条。
const SUPERSEDED_HISTORY = 20;
// 待确认、冲突与已归档条目也属于历史留档，必须有显式上限，避免无限堆积。
const PENDING_LIMIT = 20;
const CONTESTED_LIMIT = 20;
const ARCHIVED_HISTORY = 20;
// identity 类记忆的显式配额：超过就淘汰最旧的，不再假装「identity 永不淘汰」。
const IDENTITY_QUOTA = 20;

function candidateContentGrounded(content, sourceQuote, userText, keywords) {
  const normalizedUser = normalize(userText || '');
  const normalizedQuote = normalize(sourceQuote || '');
  if (!normalizedUser) return false;
  if (normalizedQuote && !normalizedUser.includes(normalizedQuote)) return false;

  const supportText = sourceQuote || userText;
  const anchorScore = similarity(content, supportText);
  const grounding = keywordGrounding(keywords, userText);
  return (
    anchorScore >= ANCHOR_MIN ||
    (anchorScore >= ANCHOR_FALLBACK_MIN && grounding.covered)
  );
}

function normalizeCandidate(raw, options = {}) {
  const now = new Date().toISOString();
  const source = raw && typeof raw === 'object' ? raw : {};
  const rawContributions = Array.isArray(source.contributions)
    ? source.contributions.map(normalizeContribution).filter(Boolean)
    : [];
  const firstContribution = rawContributions[0] || null;
  const content =
    typeof source.content === 'string'
      ? source.content.replace(/\s+/g, ' ').trim()
      : '';
  const sourceQuote =
    typeof source.sourceQuote === 'string'
      ? source.sourceQuote.trim()
      : firstContribution
        ? firstContribution.sourceQuote
        : '';
  const sessionId =
    cleanText(options.sessionId) ||
    (firstContribution && firstContribution.sessionId) ||
    cleanText(source.sessionId);
  const messageId =
    cleanText(options.messageId) ||
    (firstContribution && firstContribution.messageId) ||
    cleanText(source.messageId);
  const sourceTypeCandidate =
    cleanText(options.sourceType) ||
    cleanText(source.sourceType) ||
    (firstContribution && firstContribution.sourceType) ||
    'user';
  const sourceType = SOURCE_TYPES.has(sourceTypeCandidate)
    ? sourceTypeCandidate
    : 'user';
  const provenance = resolveProvenance({ ...source, sourceType }, options);
  const userText = options.userText || source.userText || '';
  const persistentIntent = detectPersistentIntent(userText);
  const category = classifyCategory(
    {
      content,
      type: source.type,
      sourceQuote,
      userText,
    },
    provenance
  );
  const observedAt = cleanText(source.observedAt) || now;
  const keywords = Array.isArray(source.keywords)
    ? source.keywords
        .filter(item => typeof item === 'string')
        .map(item => item.trim())
        .filter(Boolean)
        .slice(0, 5)
    : [];
  // Agent 的保存许可和内容接地均从可信运行时 userText 派生，绝不采信
  // 模型候选中的 intent / explicitMemoryIntent / contentGrounded 字段。
  const explicitMemoryIntent =
    sourceType === 'agent' && detectExplicitMemoryIntent(userText);
  const contentGrounded =
    sourceType === 'agent' &&
    candidateContentGrounded(content, sourceQuote, userText, keywords);
  const verifiedAgentIntent = explicitMemoryIntent && contentGrounded;

  // 2026-11-23：Agent 概括写入可以没有原话。贡献的本质是「用户说过的原话」，
  // 没有原话就不造空贡献——hydrateEntries 会把空原话的贡献丢掉，存空贡献会
  // 让磁盘与内存指纹不一致（落盘校验报 mismatch）。此时贡献列表为空，
  // 前端 sourceQuote 回落成空串，不影响正文与来源类型。
  const contributions = rawContributions.length
    ? rawContributions
    : sourceQuote
      ? [
          {
            sessionId: sessionId || null,
            sourceQuote,
            createdAt: now,
            sourceType,
            ...(messageId ? { messageId } : {}),
          },
        ]
      : [];

  return {
    id: cleanText(source.id) || issuedId(),
    status: STATUS_ACTIVE,
    content,
    type: source.type,
    keywords,
    confidence: Number(source.confidence),
    validFrom: cleanText(source.validFrom) || now,
    validTo: cleanText(source.validTo),
    supersededBy: null,
    contributions,
    createdAt: cleanText(source.createdAt) || now,
    updatedAt: now,
    sourceType,
    provenance,
    category,
    persistentIntent,
    uncertainty:
      source.uncertainty === 'source_hedged' ||
      hasHedge(sourceQuote) ||
      hasHedge(userText)
        ? 'source_hedged'
        : cleanText(source.uncertainty),
    explicitCorrection:
      options.intent === 'correction' ||
      detectExplicitCorrection(userText),
    observedAt,
    evidence: null,
    policyVersion: POLICY_VERSION,
    decisionVersion: DECISION_VERSION,
    intent:
      sourceType === 'agent'
        ? options.intent === 'correction'
          ? 'correction'
          : verifiedAgentIntent
            ? 'explicit'
            : 'auto'
        : cleanText(options.intent) || cleanText(source.intent) || 'auto',
    explicitMemoryIntent,
    contentGrounded,
    targetId: cleanText(options.targetId) || cleanText(source.targetId),
    eventAt: cleanText(source.eventAt),
    condition: cleanText(source.condition),
    requiresConfirmation:
      options.requiresConfirmation === true ||
      source.requiresConfirmation === true ||
      (sourceType === 'agent' && !verifiedAgentIntent),
    confirmationReason:
      cleanText(options.confirmationReason) ||
      cleanText(source.confirmationReason) ||
      (sourceType === 'agent' && !explicitMemoryIntent
        ? 'user_save_intent_required'
        : sourceType === 'agent' && !contentGrounded
          ? 'content_not_grounded_requires_confirmation'
          : null),
  };
}

function candidateValidationError(candidate, options = {}) {
  if (!candidate.content) return 'no_content';
  if (candidate.content.length > 100) return 'content_too_long';
  if (!candidate.type || !ALLOWED_TYPES.has(candidate.type)) {
    return 'type_not_allowed';
  }
  if (
    !Number.isFinite(candidate.confidence) ||
    candidate.confidence < 0 ||
    candidate.confidence > 1
  ) {
    return 'invalid_confidence';
  }
  if (!Number.isFinite(Date.parse(candidate.validTo || ''))) {
    if (candidate.validTo) return 'invalid_valid_to';
  }
  if (candidate.eventAt && !Number.isFinite(Date.parse(candidate.eventAt))) {
    return 'invalid_event_at';
  }
  if (candidate.condition && candidate.condition.length > 80) {
    return 'condition_too_long';
  }
  const quote =
    candidate.contributions[0] && candidate.contributions[0].sourceQuote;
  // 2026-11-23：Agent 显式写入允许省略原话（由模型概括）；抽取通道仍必须带原话。
  if ((!quote || quote.length < 2) && !options.allowMissingQuote) {
    return 'quote_too_short';
  }
  if (isSensitive(candidate.content) || (quote && isSensitive(quote))) {
    return 'sensitive_content';
  }
  if (!VALID_PROVENANCE.has(candidate.provenance)) {
    return 'invalid_provenance';
  }
  if (
    candidate.sourceType === 'model' &&
    candidate.provenance !== PROVENANCE.MODEL_INFERRED
  ) {
    return 'unsupported_source';
  }
  if (
    candidate.sourceType === 'tool' &&
    candidate.provenance !== PROVENANCE.TOOL_OBSERVED
  ) {
    return 'unsupported_source';
  }

  if (options.requireUserGrounding) {
    const userText = normalize(options.userText || '');
    const normalizedQuote = normalize(quote);

    // 2026-11-23：不再强制用户原话——sourceQuote 可以省略，正文由模型概括。
    // 但只要提供了原话，就必须真实出现在当前用户消息里，防止编造引文；
    // 此时正文仍需与该原话相关（原有相似度校验保留）。
    if (!userText) return 'ungrounded_source';

    if (normalizedQuote) {
      if (!userText.includes(normalizedQuote)) return 'ungrounded_source';

      const anchorScore = similarity(candidate.content, quote);
      const grounding = keywordGrounding(candidate.keywords, userText);

      if (
        anchorScore < ANCHOR_MIN &&
        !(anchorScore >= ANCHOR_FALLBACK_MIN && grounding.covered)
      ) {
        return 'ungrounded_content';
      }
    }
  }

  return null;
}

function decisionRecord(action, reason, candidate, actor, at) {
  return {
    action,
    reason,
    at,
    actor: actor || 'system',
    sourceType: candidate.sourceType || 'user',
    provenance: candidate.provenance || null,
    category: candidate.category || null,
    policyVersion: candidate.policyVersion || POLICY_VERSION,
    decisionVersion: candidate.decisionVersion || DECISION_VERSION,
    evidence: candidate.evidence || null,
  };
}

// 生命周期审计只记录 ID、动作、状态与短码，不记录正文/原话。
function logLifecycleEvent({ action, from, to, id, reason }) {
  memoryCore().logDataEvent({
    module: 'memory',
    file: memoryCore().memoryFile,
    event: 'memory_lifecycle_transition',
    level: 'info',
    reason: reason || null,
    action: action || null,
    extra: { id: id || null, from: from || null, to: to || null },
  });
}

function logLifecycleRejection({ action, from, id, reason }) {
  memoryCore().logDataEvent({
    module: 'memory',
    file: memoryCore().memoryFile,
    event: 'memory_lifecycle_rejected',
    level: 'warn',
    reason: reason || 'invalid_transition',
    action: action || null,
    extra: { id: id || null, from: from || null },
  });
}

function storedCandidate(candidate, extra = {}) {
  const {
    targetId,
    requiresConfirmation,
    confirmationReason,
    intent,
    sourceType,
    persistentIntent,
    ...stored
  } = candidate;

  // 归属用户由服务端身份决定，不信任候选里可能夹带的任何 userId。
  return { ...stored, userId: getInstanceUserId(), ...extra };
}

// 同一条消息的同一事实只处理一次：异步抽取重跑或 Agent 重复提交时
// 不再产生第二条条目（同一消息里的不同事实内容哈希不同，仍会分别写入）。
function findDuplicateSourceEntry(current, candidate) {
  const messageId = cleanText(
    candidate.contributions[0] && candidate.contributions[0].messageId
  );

  if (!messageId) return null;

  const contentHash = hashText(candidate.content);
  if (!contentHash) return null;

  return (
    current.find(
      item =>
        Array.isArray(item.contributions) &&
        item.contributions.some(
          contribution =>
            contribution &&
            cleanText(contribution.messageId) === messageId
        ) &&
        hashText(item.content) === contentHash
    ) || null
  );
}

function rulesForCandidate() {
  // 通用决策器只计算重复/冲突/生命周期关系；准入由 P2 证据策略按类别评估。
  return DEFAULT_RULES;
}

// strict 偏好与安全暂存的低置信候选都可累计后续来源；模型推断只合并同来源，
// 绝不能被用户直述覆盖 provenance，或因重复推断自动晋升为 active。
function findPendingCandidateForPromotion(
  current,
  candidate,
  writeScope,
  policyMode
) {
  const matches = current.filter(item => {
    if (!item || item.status !== STATUS_PENDING) return false;

    // hedged 直述（「我好像挺喜欢…」）统一归 behavior_pattern 类（classifyCategory），
    // 但 provenance 仍是 user_asserted——用户自己的原话，跨会话重复应当并入
    // 同一条 pending 累积贡献。晋升不会被重复撬开：pending-merge 的 promote
    // 要求 decision !== NEEDS_CONFIRMATION，hedged 候选每次都被策略钉在
    // 待确认，重复只攒证据不改判（2026-11-19 Owner 拍板翻转；此前被
    // behavior_pattern 排除 + 「可能：」前缀破坏相似度双重卡死，各会话自成一条）。
    const eligibleReason =
      item.pendingReason === 'low_confidence_candidate' ||
      item.pendingReason === 'model_inference_requires_confirmation' ||
      item.pendingReason === 'user_hedged_requires_confirmation' ||
      (item.pendingReason === 'single_preference_candidate' &&
        policyMode === 'strict' &&
        candidate.category === CATEGORY.LONG_TERM_PREFERENCE);

    return (
      eligibleReason &&
      scopeOf(item, writeScope) !== 'excluded' &&
      item.type === candidate.type &&
      item.provenance === candidate.provenance &&
      // 双侧剥掉 hedged 前缀再比对：库里的条目与后续候选都可能带「可能：」
      similarity(
        stripHedgePendingMark(item.content),
        stripHedgePendingMark(candidate.content)
      ) >= PENDING_CANDIDATE_MATCH_MIN
    );
  });

  return matches.length === 1 ? matches[0] : null;
}

// 容量控制。旧实现只在"全部是 identity"时 next.shift()，等于把
// 「identity 永不被淘汰」这个并不成立的承诺写在了注释里：真到那一步
// 它照样删 identity，而且删的是数组第一条、不是最旧一条。
// 现在把规则写明确，按优先级淘汰：
//   1. 已被更正的历史条目（从最新的 superseded 往后留 SUPERSEDED_HISTORY）
//   2. 最久未更新的非 identity 生效条目
//   3. 超出 IDENTITY_QUOTA 的最旧 identity 条目（显式配额，不再是隐性承诺）
function trimToCapacity(list) {
  const identityIndex = type => (type === 'identity' ? 0 : 1);

  const byOldest = (a, b) =>
    identityIndex(a.item.type) - identityIndex(b.item.type) ||
    new Date(a.item.updatedAt || a.item.createdAt || 0) -
      new Date(b.item.updatedAt || b.item.createdAt || 0);

  while (list.length > MEMORY_LIMIT) {
    const tagged = list.map((item, index) => ({ item, index }));

    const superseded = tagged
      .filter(({ item }) => item.status === STATUS_SUPERSEDED)
      .sort(byOldest);

    if (superseded.length > SUPERSEDED_HISTORY) {
      list.splice(superseded[0].index, 1);

      continue;
    }

    const archived = tagged
      .filter(({ item }) => item.status === STATUS_ARCHIVED)
      .sort(byOldest);

    if (archived.length > ARCHIVED_HISTORY) {
      list.splice(archived[0].index, 1);

      continue;
    }

    const pending = tagged
      .filter(({ item }) => item.status === STATUS_PENDING)
      .sort(byOldest);

    if (pending.length > PENDING_LIMIT) {
      list.splice(pending[0].index, 1);

      continue;
    }

    const contested = tagged
      .filter(({ item }) => item.status === STATUS_CONTESTED)
      .sort(byOldest);

    if (contested.length > CONTESTED_LIMIT) {
      list.splice(contested[0].index, 1);

      continue;
    }

    const ordinary = tagged
      .filter(
        ({ item }) =>
          isActive(item) && item.type !== 'identity'
      )
      .sort(byOldest);

    if (ordinary.length) {
      list.splice(ordinary[0].index, 1);

      continue;
    }

    const identities = tagged
      .filter(({ item }) => isActive(item) && item.type === 'identity')
      .sort(byOldest);

    if (identities.length > IDENTITY_QUOTA) {
      list.splice(identities[0].index, 1);

      continue;
    }

    // 剩下的全是被配额保护起来的 identity：容量让位于身份记忆，不再自相矛盾地偷删。
    break;
  }

  // identity 超配额但库还没满（例如一次性导入 30 条 identity）也要收敛。
  // 每删一条都重算：splice 之后旧的 index 就不再指向同一条记忆。
  while (true) {
    const surplus = list
      .map((item, index) => ({ item, index }))
      .filter(({ item }) => isActive(item) && item.type === 'identity')
      .sort(byOldest);

    if (surplus.length <= IDENTITY_QUOTA) break;

    list.splice(surplus[0].index, 1);
  }

  return list;
}

async function applyCandidate(raw, options = {}) {
  const candidate = normalizeCandidate(raw, options);
  const base = {
    written: false,
    action: 'none',
    reason: null,
    id: null,
    supersededId: null,
    targetId: null,
    decision: null,
    status: null,
    durable: false,
  };

  if (!memoryCore().memoryEnabled) {
    return { ...base, reason: 'memory_disabled', decision: DECISION.REJECT };
  }

  const invalid = candidateValidationError(candidate, options);

  if (invalid) {
    return { ...base, reason: invalid, decision: DECISION.REJECT };
  }

  const sessionId = cleanText(options.sessionId);
  // 写侧与读侧共用同一作用域判定：拿到可信 userId 就是用户级 —— 同一用户的
  // 任意会话都能更正 / 合并 / 替代自己的记忆（否则新会话里说「我改名叫X」
  // 会被拒，旧名字与新名字作为两条记忆同时被注入）。
  // 没有可信 userId 时回落到会话级隔离，跨用户仍然拒绝。
  const writeScope = resolveReadScope({
    scope: options.scope,
    userId: options.userId,
    sessionId,
  });
  const abortedResult = () => ({
    ...base,
    reason: 'aborted',
    decision: DECISION.REJECT,
  });

  return memoryCore().enqueueWrite(async () => {
    if (options.signal && options.signal.aborted) {
      return abortedResult();
    }

    const current = Array.isArray(memoryCore().getMemoryList()) ? memoryCore().getMemoryList() : [];
    const next = current.map(cloneEntry);
    const persist = async () => {
      if (options.signal && options.signal.aborted) return false;
      await memoryCore().saveMemories(next);
      return true;
    };
    const nowIso = new Date().toISOString();
    const nowMs = Date.now();
    const effective = next.filter(item => isEffectiveAt(item, nowMs));

    const tombstoneReason = tombstoneBlocksCandidate(
      memoryCore().getTombstones(),
      candidate,
      {
        mode: writeScope.mode,
        userId: writeScope.userId,
        sessionId,
      },
      nowMs
    );

    if (tombstoneReason) {
      return {
        ...base,
        reason: tombstoneReason,
        decision: DECISION.REJECT,
      };
    }

    if (findDuplicateSourceEntry(current, candidate)) {
      return {
        ...base,
        reason: 'duplicate_source',
        decision: DECISION.REJECT,
      };
    }

    let target = null;

    if (candidate.targetId) {
      target = effective.find(item => item.id === candidate.targetId) || null;

      if (!target) {
        return {
          ...base,
          reason: 'target_not_found',
          decision: DECISION.REJECT,
        };
      }

      // 更正/合并/替代的目标按当前作用域判定可见性：用户级下同一用户的
      // 任意会话都可以改自己的记忆；跨用户仍然拒绝。
      if (scopeOf(target, writeScope) === 'excluded') {
        return {
          ...base,
          reason: 'unauthorized_target',
          decision: DECISION.REJECT,
        };
      }
    }

    // 用户级作用域下，其他用户的条目连候选都不算：既不能 merge，
    // 也不能参与冲突判断，更不能被本次写入复活。
    const matches = effective
      .filter(
        item =>
          writeScope.mode !== 'user' ||
          scopeOf(item, writeScope) !== 'excluded'
      )
      .map(item => ({
      item,
      similarity: similarity(item.content, candidate.content),
      sameType: item.type === candidate.type,
      sharedKeyword: shareKeyword(item.keywords, candidate.keywords),
      visible: scopeOf(item, writeScope) !== 'excluded',
      contextConflict:
        (() => {
          const currentEvent = Date.parse(candidate.eventAt || '');
          const existingEvent = Date.parse(item.eventAt || '');

          if (
            Number.isFinite(currentEvent) &&
            Number.isFinite(existingEvent) &&
            currentEvent !== existingEvent
          ) {
            return true;
          }

          return Boolean(
            candidate.condition &&
              item.condition &&
              candidate.condition !== item.condition
          );
        })(),
    }));

    const candidateRules = rulesForCandidate(candidate);
    const evaluatedDecision = decide({
      candidate,
      matches,
      target,
      rules: candidateRules,
    });
    const decision = evaluatedDecision;
    const policyMode = getPolicyMode();
    const hasExistingDuplicate = matches.some(
      match =>
        match &&
        match.contextConflict !== true &&
        match.similarity >= candidateRules.duplicateMin
    );
    const pendingCandidate =
      !hasExistingDuplicate && decision.decision === DECISION.CREATE
        ? findPendingCandidateForPromotion(
            next,
            candidate,
            writeScope,
            policyMode
          )
        : null;
    const counterEvidence = matches.filter(
      match =>
        match &&
        match.contextConflict !== true &&
        match.sameType &&
        match.sharedKeyword &&
        match.similarity >= candidateRules.conflictMin &&
        match.similarity < candidateRules.duplicateMin
    ).length;
    const evidence = buildEvidence({
      candidate,
      decision,
      existing: decision.target || pendingCandidate,
      userText: options.userText || '',
      counterEvidence,
      policyMode,
    });

    candidate.evidence = evidence;
    candidate.policyVersion = POLICY_VERSION;
    candidate.decisionVersion = DECISION_VERSION;

    const policy = applyEvidencePolicy({
      candidate,
      decision,
      evidence,
      policyMode,
    });
    const finalDecision =
      policy.decision === decision.decision && policy.reason === decision.reason
        ? decision
        : { ...decision, decision: policy.decision, reason: policy.reason };

    const record = (action, reason) =>
      decisionRecord(action, reason, candidate, options.actor, nowIso);

    // strict 偏好沿用既有规则；直接来源的低置信候选可在独立会话证据充足后晋升。
    if (
      pendingCandidate &&
      finalDecision.decision !== DECISION.REJECT
    ) {
      const index = next.findIndex(item => item.id === pendingCandidate.id);
      const contributions = mergeContributions(
        pendingCandidate.contributions,
        candidate.contributions
      );
      const sessions = new Set(
        contributions
          .map(contribution => contribution && contribution.sessionId)
          .filter(Boolean)
      );
      const promote =
        candidate.provenance === PROVENANCE.USER_ASSERTED &&
        finalDecision.decision !== DECISION.NEEDS_CONFIRMATION &&
        (candidate.persistentIntent === true ||
          sessions.size >= 2 ||
          finalDecision.decision === DECISION.CREATE);
      const pendingReason =
        finalDecision.reason === 'single_preference_candidate'
          ? finalDecision.reason
          : pendingCandidate.pendingReason ||
            finalDecision.reason ||
            'low_confidence_candidate';
      const promotedEvidence = {
        ...evidence,
        repetition: contributions.length,
        independentSessions: sessions.size,
        ...(promote &&
        candidate.provenance === PROVENANCE.USER_ASSERTED &&
        sessions.size >= 2
          ? { consistency: 1, promotion: 'independent_support' }
          : {}),
      };

      candidate.evidence = promotedEvidence;

      const updated = {
        ...pendingCandidate,
        contributions,
        confidence: candidate.confidence,
        category: candidate.category,
        sourceType: candidate.sourceType,
        provenance: candidate.provenance,
        evidence: promotedEvidence,
        policyVersion: POLICY_VERSION,
        decisionVersion: DECISION_VERSION,
        observedAt: nowIso,
        updatedAt: nowIso,
        status: promote ? STATUS_ACTIVE : STATUS_PENDING,
        lastDecision: record(
          promote ? 'reinforce' : 'needs_confirmation',
          promote
            ? 'repeated_independent_evidence'
            : pendingReason
        ),
      };

      if (promote) {
        delete updated.pendingReason;
        delete updated.pendingAt;
        delete updated.pendingTargetId;
        delete updated.pendingMutation;
        // 晋升即转正：正文剥掉待确认期的「可能：」前缀，active 事实不再
        // 带犹豫标记（uncertainty 字段保留溯源）。合并自 hedged pending、
        // 由后续自信直述触发晋升时，残留前缀会低估已确认事实。
        updated.content = stripHedgePendingMark(updated.content);
      }

      next[index] = updated;
      trimToCapacity(next);
      if (!(await persist())) return abortedResult();
      memoryCore().setMemoryList(next);
      memoryCore().refreshDerivedMemoryIndex(
        promote ? 'candidate_promoted' : 'candidate_merged'
      );

      return {
        written: promote,
        action: promote ? 'reinforced' : 'pending',
        reason: promote ? null : pendingReason,
        id: updated.id,
        supersededId: null,
        targetId: updated.id,
        decision: promote ? 'reinforce' : DECISION.NEEDS_CONFIRMATION,
        status: updated.status,
        durable: true,
      };
    }

    // Agent 工具路径：改写/合并/替代已有记忆必须由用户确认，不能自动落盘。
    // 自动记忆抽取仍保留既有策略，避免改变主控聊天既有行为。
    const mutationDecisions = new Set([
      DECISION.UPDATE,
      DECISION.MERGE,
      DECISION.SUPERSEDE,
    ]);
    if (
      options.requireMutationConfirmation === true &&
      mutationDecisions.has(decision.decision)
    ) {
      const pendingTargetId = decision.target
        ? decision.target.id
        : candidate.targetId || null;
      const pending = storedCandidate(candidate, {
        status: STATUS_PENDING,
        pendingReason: 'mutation_requires_confirmation',
        pendingAt: nowIso,
        pendingTargetId,
        pendingMutation: decision.decision,
        lastDecision: record('needs_confirmation', 'mutation_requires_confirmation'),
      });

      next.push(pending);
      trimToCapacity(next);
      if (!(await persist())) return abortedResult();
      memoryCore().setMemoryList(next);
      logLifecycleEvent({
        action: 'pending',
        from: null,
        to: STATUS_PENDING,
        id: pending.id,
        reason: 'mutation_requires_confirmation',
      });

      return {
        written: false,
        action: 'pending',
        reason: 'mutation_requires_confirmation',
        id: pending.id,
        supersededId: null,
        targetId: pendingTargetId,
        decision: DECISION.NEEDS_CONFIRMATION,
        status: STATUS_PENDING,
        durable: true,
      };
    }

    if (finalDecision.decision === DECISION.REJECT) {
      return {
        ...base,
        reason: finalDecision.reason,
        decision: finalDecision.decision,
      };
    }

    if (finalDecision.decision === DECISION.NEEDS_CONFIRMATION) {
      const pendingTargetId = finalDecision.target
        ? finalDecision.target.id
        : candidate.targetId || null;
      const contestedIds = [];

      if (
        finalDecision.reason === 'ambiguous_conflict' &&
        Array.isArray(finalDecision.conflicts)
      ) {
        for (const conflict of finalDecision.conflicts) {
          const conflictIndex = next.findIndex(
            item => item && item.id === conflict.id
          );

          if (conflictIndex < 0) continue;

          const current = next[conflictIndex];

          if (current.status !== STATUS_ACTIVE) continue;

          next[conflictIndex] = {
            ...current,
            status: STATUS_CONTESTED,
            contestedAt: nowIso,
            contestedReason: 'ambiguous_conflict',
            contestedBy: candidate.id,
            updatedAt: nowIso,
            lastDecision: record('contest', 'ambiguous_conflict'),
          };
          contestedIds.push(current.id);
          logLifecycleEvent({
            action: 'contest',
            from: current.status,
            to: STATUS_CONTESTED,
            id: current.id,
            reason: 'ambiguous_conflict',
          });
        }
      }

      const pending = storedCandidate(candidate, {
        status: STATUS_PENDING,
        pendingReason: finalDecision.reason,
        pendingAt: nowIso,
        pendingTargetId,
        pendingMutation: mutationDecisions.has(decision.decision)
          ? decision.decision
          : null,
        ...(contestedIds.length ? { contestedIds } : {}),
        lastDecision: record('needs_confirmation', finalDecision.reason),
      });

      next.push(pending);
      trimToCapacity(next);
      if (!(await persist())) return abortedResult();
      memoryCore().setMemoryList(next);
      logLifecycleEvent({
        action: 'pending',
        from: null,
        to: STATUS_PENDING,
        id: pending.id,
        reason: finalDecision.reason,
      });

      return {
        written: false,
        action: 'pending',
        reason: finalDecision.reason,
        id: pending.id,
        supersededId: null,
        targetId: pendingTargetId,
        decision: finalDecision.decision,
        status: STATUS_PENDING,
        durable: true,
      };
    }

    if (
      finalDecision.decision === DECISION.MERGE ||
      finalDecision.decision === DECISION.UPDATE
    ) {
      const index = next.findIndex(item => item.id === finalDecision.target.id);
      const existing = next[index];

      if (
        writeScope.mode === 'user' &&
        scopeOf(existing, writeScope) === 'excluded'
      ) {
        return {
          ...base,
          reason: 'unauthorized_target',
          decision: DECISION.REJECT,
        };
      }

      const contributions = mergeContributions(
        existing.contributions,
        candidate.contributions
      );
      const existingSessions = new Set(
        (Array.isArray(existing.contributions) ? existing.contributions : [])
          .map(contribution => contribution && contribution.sessionId)
          .filter(Boolean)
      );
      const candidateSessions = Array.isArray(candidate.contributions)
        ? candidate.contributions
            .map(contribution => contribution && contribution.sessionId)
            .filter(Boolean)
        : [];
      const independentSupport =
        finalDecision.decision === DECISION.MERGE &&
        candidateSessions.some(session => !existingSessions.has(session));
      const mergedEvidence = {
        ...(evidence || {}),
        repetition: contributions.length,
        independentSessions: new Set(
          contributions
            .map(contribution => contribution && contribution.sessionId)
            .filter(Boolean)
        ).size,
        ...(independentSupport ? { promotion: 'independent_support' } : {}),
      };
      const mergeAction = independentSupport
        ? 'reinforce'
        : finalDecision.decision;

      candidate.evidence = mergedEvidence;

      // 合并到别的会话的条目时，只追加贡献：对方条目的正文、类型、关键词、
      // 置信度保持原样，否则一次写入会改写别的会话已经存下来的事实。
      const updated =
        finalDecision.reason === 'same_fact_other_session'
          ? {
              ...existing,
              status: STATUS_ACTIVE,
              validTo: null,
              supersededBy: null,
              contributions,
              evidence: mergedEvidence,
              updatedAt: nowIso,
              lastDecision: record(mergeAction, finalDecision.reason),
            }
          : storedCandidate(candidate, {
              id: existing.id,
              status: STATUS_ACTIVE,
              createdAt: existing.createdAt || candidate.createdAt,
              validFrom: existing.validFrom || candidate.validFrom,
              validTo: null,
              supersededBy: null,
              contributions,
              evidence: mergedEvidence,
              updatedAt: nowIso,
              lastDecision: record(mergeAction, finalDecision.reason),
              confirmationCount: existing.confirmationCount,
              lastConfirmedAt: existing.lastConfirmedAt,
              feedbackHistory: existing.feedbackHistory,
            });

      next[index] = updated;
      trimToCapacity(next);
      if (!(await persist())) return abortedResult();
      memoryCore().setMemoryList(next);
      memoryCore().refreshDerivedMemoryIndex('merge_update');
      logLifecycleEvent({
        action: mergeAction,
        from: existing.status || STATUS_ACTIVE,
        to: STATUS_ACTIVE,
        id: updated.id,
        reason: finalDecision.reason,
      });

      return {
        written: true,
        action:
          finalDecision.decision === DECISION.MERGE ? 'merged' : 'updated',
        reason: null,
        id: updated.id,
        supersededId: null,
        targetId: updated.id,
        decision: finalDecision.decision,
        status: STATUS_ACTIVE,
        durable: true,
      };
    }

    if (finalDecision.decision === DECISION.SUPERSEDE) {
      const index = next.findIndex(item => item.id === finalDecision.target.id);
      const outdated = next[index];

      if (
        writeScope.mode === 'user' &&
        scopeOf(outdated, writeScope) === 'excluded'
      ) {
        return {
          ...base,
          reason: 'unauthorized_target',
          decision: DECISION.REJECT,
        };
      }

      next[index] = {
        ...outdated,
        status: STATUS_SUPERSEDED,
        validTo: nowIso,
        supersededBy: candidate.id,
        updatedAt: nowIso,
        lastDecision: record(DECISION.SUPERSEDE, finalDecision.reason),
      };

      const replacement = storedCandidate(candidate, {
        status: STATUS_ACTIVE,
        supersedes: outdated.id,
        lastDecision: record(DECISION.CREATE, 'supersedes_existing'),
      });

      next.push(replacement);
      trimToCapacity(next);
      if (!(await persist())) return abortedResult();
      memoryCore().setMemoryList(next);
      memoryCore().refreshDerivedMemoryIndex('supersede');
      logLifecycleEvent({
        action: 'supersede',
        from: outdated.status || STATUS_ACTIVE,
        to: STATUS_SUPERSEDED,
        id: outdated.id,
        reason: finalDecision.reason,
      });
      logLifecycleEvent({
        action: 'create',
        from: null,
        to: STATUS_ACTIVE,
        id: replacement.id,
        reason: 'supersedes_existing',
      });

      return {
        written: true,
        action: 'superseded',
        reason: null,
        id: replacement.id,
        supersededId: outdated.id,
        targetId: outdated.id,
        decision: finalDecision.decision,
        status: STATUS_ACTIVE,
        durable: true,
      };
    }

    const created = storedCandidate(candidate, {
      status: STATUS_ACTIVE,
      lastDecision: record(DECISION.CREATE, finalDecision.reason),
    });

    next.push(created);
    trimToCapacity(next);
    if (!(await persist())) return abortedResult();
    memoryCore().setMemoryList(next);
    memoryCore().refreshDerivedMemoryIndex('create');
    logLifecycleEvent({
      action: 'create',
      from: null,
      to: STATUS_ACTIVE,
      id: created.id,
      reason: finalDecision.reason,
    });

    return {
      written: true,
      action: 'inserted',
      reason: null,
      id: created.id,
      supersededId: null,
      targetId: null,
      decision: DECISION.CREATE,
      status: STATUS_ACTIVE,
      durable: true,
    };
  });
}


module.exports = {
  logLifecycleEvent,
  logLifecycleRejection,
  trimToCapacity,
  applyCandidate,
};
