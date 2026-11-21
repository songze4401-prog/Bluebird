/* global __dirname */
const fs = require('fs');
const path = require('path');
const { logDataEvent } = require('./data-events');
const monitoring = require('./monitoring');
const { writeFileAtomic, writeFileExclusiveSync } = require('./atomic-write');
const {
  hashText,
  loadTombstones,
  saveTombstones,
  appendTombstones,
  tombstoneBlocksCandidate,
} = require('./memory-tombstones');
const { registerCorruptionHandler, handleCorruption } = require('./corruption');
const {
  STATUS_ACTIVE,
  STATUS_PENDING,
  STATUS_CONTESTED,
  STATUS_SUPERSEDED,
  STATUS_ARCHIVED,
  isPending,
  isEffectiveAt,
} = require('./memory-lifecycle');
const {
  DECISION,
  DEFAULT_RULES,
  decide,
} = require('./memory-decision');
const {
  POLICY_VERSION,
  DECISION_VERSION,
  PROVENANCE,
  CATEGORY,
  VALID_PROVENANCE,
  getPolicyMode,
  detectPersistentIntent,
  detectExplicitCorrection,
  hasHedge,
  resolveProvenance,
  classifyCategory,
  buildEvidence,
  applyEvidencePolicy,
} = require('./memory-evidence');

// 文本基础件与常量：R2a 自本文件迁出（server/memory-ranking.js）。留守仅
// 消费这些（合并配对相似度/敏感词/来源与类型校验）；评分与渲染路径已随
// R2c 迁至 memory-retrieval.js 消费。
const {
  normalize,
  similarity,
  isSensitive,
  SOURCE_TYPES,
  cleanText,
  ALLOWED_TYPES,
} = require('./memory-ranking');

// 记忆抽取管道：R2b 自本文件迁出（server/memory-extraction.js），经解构
// 回注保持调用点零改动（processMemory/诊断端点/merge 路径等留守代码继续
// 裸名调用）。pendingMemoryIntents 是共享协调状态：这里拿到的是与抽取
// 模块同一 Set 实例。
const {
  pendingMemoryIntents,
  pendingMemoryIntentKey,
  issuedId,
  isActive,
  shouldProcessMemory,
  OBSERVER_EVERY_TURN,
  EXTRACT_INPUT_MAX,
  getObserverMode,
  ANCHOR_MIN,
  ANCHOR_FALLBACK_MIN,
  MEMORY_SKIP_REASONS,
  reportSkip,
  keywordGrounding,
  normalizeContribution,
  normalizeEntry,
  ensureUniqueIds,
  mergeContributions,
  cloneEntry,
  shareKeyword,
  extractMemory,

  MEMORY_ENABLED,
} = require('./memory-extraction');

// 记忆检索路径簇：R2c 自本文件迁出（server/memory-retrieval.js），经解构
// 回注保持调用点零改动（写路径 scopeOf、管理接口与
// module.exports 的 searchMemories/buildMemoryContext 等留守代码继续裸名
// 调用同一套读路径）。
const {
  scopeOf,
  getMemoriesForUser,
  getPendingMemoriesForUser,
  checkMemoryOwnership,
  buildMemoryContext,
  resolveReadScope,
  searchMemories,
} = require('./memory-retrieval');

// 记忆反馈三联：R3a 自本文件迁出（server/memory-feedback.js），经解构
// 回注保持调用点零改动（applyFeedback/confirmPending 区域的裁决记录
// 调用点与 module.exports 的三联继续裸名调用）。
const {
  confirmMemoryFeedback,
  denyMemoryFeedback,
  correctMemoryFeedback,
} = require('./memory-feedback');

// 记忆生命周期变更簇：R4 自本文件迁出（server/memory-lifecycle-ops.js），
// 经解构回注保持调用点零改动（module.exports 九操作 + 留守写路径的
// stripHedgePendingMark/PENDING_CANDIDATE_MATCH_MIN 调用点）。
const {
  stripHedgePendingMark,
  PENDING_CANDIDATE_MATCH_MIN,
  confirmPending,
  rejectPending,
  archiveMemory,
  updateMemory,
  mergeMemories,
  planPendingConsolidation,
  consolidatePendingDuplicates,
  supersedeMemory,
  withdrawMemory,
} = require('./memory-lifecycle-ops');

// 记忆读侧 CRUD 与删除簇：R5 自本文件迁出（server/memory-crud.js），
// 经解构回注保持调用点零改动（module.exports 四操作）。
const {
  clearMemories,
  clearSessionMemories,
  recallMemoryBySourceQuote,
  deleteMemory,
} = require('./memory-crud');

// 记忆核心状态注入：迁移模块共用唯一容器（server/memory-core.js，
// state-holder 统一设计）。键分三域：
// - 状态读写：getMemoryList/setMemoryList（memories 是 let 数组的唯一
//   读写通道）、getMemories（公开 getter，过滤+副本——getMemoriesForUser
//   原语义，与 getMemoryList 语义不同不可混用）、getPendingMemories、
//   memoryEnabled（快照，freshModule 重载时随本文件更新）
// - 写基础设施：enqueueWrite/saveMemories/commitWithTombstones/
//   refreshDerivedMemoryIndex/trimToCapacity/maintenanceKeywords
// - 圈依赖与观测：logDataEvent/monitoring/memoryFile（抽取埋点 file
//   跟随本文件加载语境）/logLifecycleEvent/logLifecycleRejection
// 必须在本模块顶层同步完成——全部消费方（processMemory/测试/eval
// driver）都经本文件加载。
const { injectMemoryCore } = require('./memory-core');
// 数据目录可通过 BLUEBIRD_DATA_DIR 覆盖：测试用临时目录，避免碰到真实数据。
// 未设置时与 sessions.js / emotion.js 保持一致，落在 server/data/。
const DATA_DIR = process.env.BLUEBIRD_DATA_DIR
  ? path.resolve(process.env.BLUEBIRD_DATA_DIR)
  : path.join(__dirname, 'data');

const MEMORY_TOMBSTONE_FILE = path.join(DATA_DIR, 'memory-tombstones.json');
const MEMORY_FILE = path.join(DATA_DIR, 'memory.json');
const MEMORY_LIMIT = 100;

injectMemoryCore({
  logDataEvent,
  monitoring,
  memoryFile: MEMORY_FILE,
  getMemories,
  getMemoryList: () => memories,
  setMemoryList: (next) => { memories = next; },
  getPendingMemories,
  memoryEnabled: MEMORY_ENABLED,
  enqueueWrite,
  saveMemories,
  commitWithTombstones,
  refreshDerivedMemoryIndex,
  logLifecycleEvent,
  logLifecycleRejection,
  trimToCapacity,
  maintenanceKeywords,
});

const { getInstanceUserId } = require('./user-scope');
const memoryObservationLedger = require('./memory-observation-ledger');


// 待确认候选只有高度相似的后续表达才合并，避免将相近但不同的事实并成一条。
// 被更正的旧条目不立刻删除（审计与回滚要看得见的），但只留最近的这么多条。
const SUPERSEDED_HISTORY = 20;
// 待确认、冲突与已归档条目也属于历史留档，必须有显式上限，避免无限堆积。
const PENDING_LIMIT = 20;
const CONTESTED_LIMIT = 20;
const ARCHIVED_HISTORY = 20;
// identity 类记忆的显式配额：超过就淘汰最旧的，不再假装「identity 永不淘汰」。
const IDENTITY_QUOTA = 20;

let memories = [];
let memoryTombstones = [];
let writeQueue = Promise.resolve();
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

  const contributions = rawContributions.length
    ? rawContributions
    : [
        {
          sessionId: sessionId || null,
          sourceQuote,
          createdAt: now,
          sourceType,
          ...(messageId ? { messageId } : {}),
        },
      ];

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
    intent: cleanText(options.intent) || cleanText(source.intent) || 'auto',
    targetId: cleanText(options.targetId) || cleanText(source.targetId),
    eventAt: cleanText(source.eventAt),
    condition: cleanText(source.condition),
    requiresConfirmation:
      options.requiresConfirmation === true ||
      source.requiresConfirmation === true,
    confirmationReason: cleanText(source.confirmationReason),
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
  if (!quote || quote.length < 2) return 'quote_too_short';
  if (isSensitive(candidate.content) || isSensitive(quote)) {
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

    if (!userText || !normalizedQuote || !userText.includes(normalizedQuote)) {
      return 'ungrounded_source';
    }

    const anchorScore = similarity(candidate.content, quote);
    const grounding = keywordGrounding(candidate.keywords, userText);

    if (
      anchorScore < ANCHOR_MIN &&
      !(anchorScore >= ANCHOR_FALLBACK_MIN && grounding.covered)
    ) {
      return 'ungrounded_content';
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
  logDataEvent({
    module: 'memory',
    file: MEMORY_FILE,
    event: 'memory_lifecycle_transition',
    level: 'info',
    reason: reason || null,
    action: action || null,
    extra: { id: id || null, from: from || null, to: to || null },
  });
}

function logLifecycleRejection({ action, from, id, reason }) {
  logDataEvent({
    module: 'memory',
    file: MEMORY_FILE,
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

// 损坏处理契约：detect 负责判定（读取失败 / JSON 解析失败 / 不是数组），
// recover 保持原有隔离策略（重命名为 <file>.corrupt-<ts>，失败则原地保留）。
registerCorruptionHandler('memory', {
  detect(data) {
    if (data.error) {
      return {
        corrupt: true,
        // 允许调用方为"非解析型异常"（如初始化写盘失败）显式指定原因短码。
        reason: data.reason || 'read_error',
        error: data.error,
      };
    }

    let parsed;

    try {
      parsed = JSON.parse(data.text);
    } catch (error) {
      return { corrupt: true, reason: 'json_parse_error', error };
    }

    if (!Array.isArray(parsed)) {
      return { corrupt: true, reason: 'invalid_shape' };
    }

    return { corrupt: false, parsed };
  },

  recover(context) {
    // 处理策略不变（隔离重命名 + 回退空库）；结构化日志由 handleCorruption 统一记录，
    // 刻意不再打印 error.message：JSON.parse 的报错可能夹带文件内容（记忆正文）。
    let isolatedPath = null;

    try {
      const corruptPath = `${context.file}.corrupt-${Date.now()}`;

      fs.renameSync(context.file, corruptPath);

      isolatedPath = corruptPath;

      console.error(`Corrupt memory backed up: ${isolatedPath}`);
    } catch (backupError) {
      console.error('Memory backup error:', backupError.message);
    }

    return {
      action: isolatedPath ? 'isolated_file' : 'isolation_failed',
      isolatedPath,
    };
  },
});

// 磁盘数组 → 内存条目：过滤无效项、补齐贡献列表与身份/时效字段、id 去重。
// 读盘与写后自检都走这一条，两边才是同一种形态，比较结果才有意义。
function hydrateEntries(parsed) {
  return ensureUniqueIds(
    (Array.isArray(parsed) ? parsed : [])
      .filter(
        item =>
          item &&
          typeof item === 'object' &&
          typeof item.content === 'string' &&
          item.content.trim()
      )
      .map(normalizeEntry)
  );
}

function loadTombstoneState() {
  const loaded = loadTombstones(MEMORY_TOMBSTONE_FILE);

  memoryTombstones = loaded.tombstones;

  if (loaded.corrupt) {
    logDataEvent({
      module: 'memory',
      file: MEMORY_TOMBSTONE_FILE,
      event: 'data_file_corruption',
      level: 'error',
      reason: loaded.reason || 'invalid_shape',
      action: 'tombstones_unavailable',
      error: loaded.error,
    });
  }
}

function loadMemories() {
  loadTombstoneState();

  if (!fs.existsSync(MEMORY_FILE)) {
    let created = false;

    try {
      // 排他创建：并发启动时只有一个进程能创建空库。
      // 另一个进程得到 false（EEXIST）后必须继续读取现存文件，不能把内存设成空库。
      created = writeFileExclusiveSync(MEMORY_FILE, '[]\n');
    } catch (error) {
      // 初始化写盘失败：与旧实现一致地走损坏兜底（隔离 + 回退空库），不向上抛。
      handleCorruption(
        'memory',
        { text: null, error, reason: 'io_error' },
        { file: MEMORY_FILE }
      );
      memories = [];
      return;
    }

    if (created) {
      memories = [];
      return;
    }
  }

  let text = null;
  let error = null;

  try {
    text = fs.readFileSync(MEMORY_FILE, 'utf8');
  } catch (readError) {
    error = readError;
  }

  const outcome = handleCorruption(
    'memory',
    { text, error },
    { file: MEMORY_FILE }
  );

  if (outcome.corrupt) {
    memories = [];
    return;
  }

  memories = hydrateEntries(outcome.parsed);

  console.log(`Memory loaded: ${memories.length}`);
}

// 先在副本上算出新库 → await 落盘成功 → 才把内存换成新库。
// 落盘失败时异常原样抛给调用方（内存与磁盘都还是旧的，两边一致），
// 绝不出现"接口回 200、磁盘没改"的假成功。
async function saveMemories(nextMemories) {
  const dir = path.dirname(MEMORY_FILE);

  fs.mkdirSync(dir, { recursive: true });

  // 原子写（临时文件 'wx' + fsync + rename + 尽力 fsync 父目录），
  // 崩溃时不会出现空文件 / 截断文件。
  await writeFileAtomic(MEMORY_FILE, JSON.stringify(nextMemories, null, 2));
}

// 删除类操作先写墓碑再落记忆库：宁可删除失败，也不让已删除内容
// 在异步抽取的下一次写入里复活。记忆库写入失败时回滚墓碑。
async function commitWithTombstones(nextMemories, tombstoneEntries, reason) {
  const hasTombstones =
    Array.isArray(tombstoneEntries) && tombstoneEntries.some(Boolean);
  const previousTombstones = memoryTombstones;

  if (hasTombstones) {
    const nextTombstones = appendTombstones(
      previousTombstones,
      tombstoneEntries,
      { reason, now: new Date().toISOString() }
    );

    await saveTombstones(MEMORY_TOMBSTONE_FILE, nextTombstones);
    memoryTombstones = nextTombstones;
  }

  try {
    await saveMemories(nextMemories);
  } catch (error) {
    if (hasTombstones) {
      memoryTombstones = previousTombstones;

      try {
        await saveTombstones(MEMORY_TOMBSTONE_FILE, previousTombstones);
      } catch (rollbackError) {
        logDataEvent({
          module: 'memory',
          file: MEMORY_TOMBSTONE_FILE,
          event: 'memory_tombstone_rollback_failed',
          level: 'error',
          reason: 'rollback_failed',
          action: 'tombstone_rollback',
          error: rollbackError,
        });
      }
    }

    throw error;
  }
}

function enqueueWrite(task) {
  const run = writeQueue.then(task, task);

  writeQueue = run.catch(error => {
    // 结构化记录写入队列里的落盘失败（原本只有一行裸 message，无模块/路径/时间戳）。
    logDataEvent({
      module: 'memory',
      file: MEMORY_FILE,
      event: 'write_queue_error',
      error,
      action: 'write_failed',
    });
  });

  return run;
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

  if (!MEMORY_ENABLED) {
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

  return enqueueWrite(async () => {
    if (options.signal && options.signal.aborted) {
      return abortedResult();
    }

    const current = Array.isArray(memories) ? memories : [];
    const next = current.map(cloneEntry);
    const persist = async () => {
      if (options.signal && options.signal.aborted) return false;
      await saveMemories(next);
      return true;
    };
    const nowIso = new Date().toISOString();
    const nowMs = Date.now();
    const effective = next.filter(item => isEffectiveAt(item, nowMs));

    const tombstoneReason = tombstoneBlocksCandidate(
      memoryTombstones,
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
      memories = next;
      refreshDerivedMemoryIndex(
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
      memories = next;
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
      memories = next;
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
      memories = next;
      refreshDerivedMemoryIndex('merge_update');
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
      memories = next;
      refreshDerivedMemoryIndex('supersede');
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
    memories = next;
    refreshDerivedMemoryIndex('create');
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

async function attemptMemoryWrite(client, message, sessionId = null, options = {}) {
  const outcome = {
    written: false,
    action: 'none',
    reason: null,
    id: null,
    supersededId: null,
    targetId: null,
    decision: null,
    status: null,
  };

  if (!MEMORY_ENABLED) {
    outcome.reason = 'memory_disabled';

    return outcome;
  }

  const text = String(message || '').trim();

  // 观察模式：every_turn 下每轮都尝试提取（不再依赖触发词）；trigger 维持历史门控。
  // 待记忆意图按当前可信用户/会话读取并消费，避免跨会话串用或并发重复使用。
  const observerMode = getObserverMode();
  const intentKey = pendingMemoryIntentKey(sessionId, options.userId);
  const hasPendingIntent = pendingMemoryIntents.has(intentKey);
  const shouldTryMemory =
    observerMode === OBSERVER_EVERY_TURN
      ? Boolean(text)
      : hasPendingIntent || shouldProcessMemory(text);
  pendingMemoryIntents.delete(intentKey);

  if (!shouldTryMemory) {
    outcome.reason = 'not_triggered';

    return outcome;
  }

  // every_turn 的成本护栏：超长消息只把前 EXTRACT_INPUT_MAX 码点交给抽取器
  // （sourceQuote 接地与内容校验都在这份输入上进行）；trigger 模式维持 500 上限不变。
  const extractionText =
    observerMode === OBSERVER_EVERY_TURN && text.length > EXTRACT_INPUT_MAX
      ? Array.from(text).slice(0, EXTRACT_INPUT_MAX).join('')
      : text;
  outcome.observerMode = observerMode;

  const extracted = await extractMemory(
    client,
    extractionText,
    true,
    sessionId,
    options
  );

  if (!extracted.entry) {
    outcome.reason = extracted.reason;
    // 数值细节随结果回传（锚点分 / 关键词接地），调用方无需翻日志就能判断
    // 「是差一点过线」还是「差得远」；正文与原话不进这里。
    outcome.detail = extracted.detail || null;

    reportSkip(extracted.reason, extracted.detail);

    // 本条看着像记忆指令（例如只发了「记住」）却没提取到内容 —— 把意图交给下一条
    if (shouldProcessMemory(text)) {
      pendingMemoryIntents.add(intentKey);
    }

    return outcome;
  }

  const result = await applyCandidate(extracted.entry, {
    ...options,
    sessionId,
    userText: text,
    requireUserGrounding: true,
  });

  Object.assign(outcome, {
    written: result.written,
    action: result.action,
    reason: result.reason,
    id: result.id,
    supersededId: result.supersededId,
    targetId: result.targetId,
    decision: result.decision,
    status: result.status,
  });

  if (!result.written) {
    if (result.decision === DECISION.NEEDS_CONFIRMATION) {
      logDataEvent({
        module: 'memory',
        file: MEMORY_FILE,
        event: 'memory_write_pending',
        level: 'info',
        reason: result.reason,
        action: 'pending',
        extra: { sessionId, id: result.id },
      });
    } else {
      if (result.reason === 'low_confidence') {
        // 台账仅保留内容哈希和会话计数；正文、原话、关键词不会进入文件。
        memoryObservationLedger.observe({
          content: extracted.entry.content,
          sessionId,
          reason: result.reason,
          confidence: extracted.entry.confidence,
        });
      }
      reportSkip(result.reason, null);
    }
  }

  return outcome;
}

// ---- 写尝试的可观测记录（P2-2）----
// 只留最近若干次的结论：是否写入、动作、拒写短码、涉及的稳定 id。
// 绝不记正文/原话/关键词，否则这份内存记录会变成第二份用户数据。
// 用途：/chat 的记忆提取是响应完成后的后台动作，返回值没人接；
// 想让「为什么这条没记住」可见，就得有个不依赖日志的查询口子。
const WRITE_OUTCOME_LOG_MAX = 20;
const writeOutcomes = [];

function recordWriteOutcome(sessionId, outcome, error) {
  writeOutcomes.unshift({
    at: new Date().toISOString(),
    sessionId: sessionId || null,
    written: outcome.written === true,
    action: outcome.action || 'none',
    reason: error ? 'write_failed' : outcome.reason || null,
    id: outcome.id || null,
    supersededId: outcome.supersededId || null,
    ...(outcome.decision ? { decision: outcome.decision } : {}),
    ...(outcome.status ? { status: outcome.status } : {}),
    ...(outcome.targetId ? { targetId: outcome.targetId } : {}),
    ...(error && error.code ? { errorCode: String(error.code) } : {}),
  });

  if (writeOutcomes.length > WRITE_OUTCOME_LOG_MAX) {
    writeOutcomes.length = WRITE_OUTCOME_LOG_MAX;
  }
}

function getWriteOutcomes(limit = WRITE_OUTCOME_LOG_MAX) {
  const count =
    Number.isFinite(limit) && limit > 0
      ? Math.min(Math.floor(limit), WRITE_OUTCOME_LOG_MAX)
      : WRITE_OUTCOME_LOG_MAX;

  return writeOutcomes.slice(0, count).map(item => ({ ...item }));
}

// 对外入口：包一层记录，再把结果/异常原样交回，不改变调用方看到的语义。
async function processMemory(client, message, sessionId = null, options = {}) {
  const target = cleanText(sessionId);

  let outcome;
  try {
    outcome = await attemptMemoryWrite(client, message, target, options);
  } catch (error) {
    // 落盘失败也留痕：内存与磁盘都还是旧库，但调用方需要知道这次尝试没成。
    recordWriteOutcome(target, { written: false, action: 'none' }, error);

    logDataEvent({
      module: 'memory',
      file: MEMORY_FILE,
      event: 'memory_write_failed',
      level: 'error',
      error,
      action: 'write',
    });

    throw error;
  }

  // 没触发提取的普通消息不进记录，否则一次闲聊就冲掉了真正的拒写线索。
  if (outcome.reason !== 'not_triggered' && outcome.reason !== 'memory_disabled') {
    recordWriteOutcome(target, outcome);
  }

  return outcome;
}
loadMemories();

// 记忆是 canonical source，检索索引是派生数据。删除/归档/撤回后立即同步，
// 避免已删除内容或已失去会话可见性的 chunk 继续留在 index.json。
// 索引失败不回滚已落盘的记忆删除；派生索引可由下一次 search/rebuild 修复。
function refreshDerivedMemoryIndex(reason) {
  try {
    const retrieval = require('./retrieval');
    const result = retrieval.cleanupMemoryIndex();
    if (result && result.ok === false) {
      console.error(
        `[retrieval] 记忆索引同步失败（${reason}）：${result.errorCode || result.status || 'unknown'}`
      );
    }
  } catch (error) {
    console.error(
      `[retrieval] 记忆索引同步异常（${reason}）：`,
      error && error.message ? error.message : error
    );
  }
}

// 三个写入口（processMemory / recall / delete / clear）统一遵守同一顺序：

// 记忆库读取：默认只给"仍在生效"的条目（被更正的旧条目要显式点名才给，
// 审计与回滚才看得到）。返回的是逐条深拷贝：外部改 contributions 数组
// 不会串改内部状态，也不会串改下一份读到的同一份磁盘数据。
// 刻意不调用 loadMemories()——它会重置内存数组，不适合作为读取入口。
// 落盘格式里归属与锚点按"贡献"存；这里额外补一个展示用的 sourceQuote
// （最早一条贡献的原话），前端记忆库仍按单条 sourceQuote 渲染。
function getMemories(options = {}) {
  const includeHistory =
    options.includeSuperseded === true ||
    options.includeArchived === true ||
    options.includePending === true ||
    options.includeContested === true;
  const current = Array.isArray(memories) ? memories : [];

  return current
    .filter(item => includeHistory || isEffectiveAt(item))
    .map(item => {
      const contributions = Array.isArray(item.contributions)
        ? item.contributions
        : [];

      return {
        ...item,
        contributions: contributions.map(contribution => ({
          ...contribution,
        })),
        sourceQuote: contributions.length ? contributions[0].sourceQuote : '',
      };
    });
}

function getPendingMemories() {
  return (Array.isArray(memories) ? memories : [])
    .filter(isPending)
    .map(item => ({
      ...item,
      contributions: (item.contributions || []).map(contribution => ({
        ...contribution,
      })),
      sourceQuote:
        item.contributions && item.contributions[0]
          ? item.contributions[0].sourceQuote
          : '',
    }));
}

// 用户确认一个冲突候选后，把被它标记为 contested 的旧条目归档；
// 保留审计，但不再作为当前事实参与注入。
function maintenanceKeywords(value) {
  if (!Array.isArray(value)) return null;
  return [...new Set(
    value
      .filter(item => typeof item === 'string')
      .map(item => item.trim())
      .filter(Boolean)
  )].slice(0, 5);
}

function storeFingerprint(list) {
  return (Array.isArray(list) ? list : [])
    .map(item =>
      JSON.stringify([
        (item && item.id) || null,
        (item && item.status) || null,
        (item && item.validFrom) || null,
        (item && item.validTo) || null,
        (item && item.supersededBy) || null,
        (Array.isArray(item && item.contributions) ? item.contributions : []).map(
          c => [
            (c && c.sessionId) || null,
            (c && c.createdAt) || null,
            (c && c.sourceQuote) || null,
            (c && c.messageId) || null,
            (c && c.sourceType) || null,
          ]
        ),
      ])
    )
    .join(';');
}

function verifyStoreConsistency() {
  const memoryList = Array.isArray(memories) ? memories : [];

  let raw;
  try {
    raw = fs.readFileSync(MEMORY_FILE, 'utf8');
  } catch (error) {
    // 从没写过盘（首次运行 / 空库）时文件不存在，与「内存也是空」一致。
    if (error && error.code === 'ENOENT' && !memoryList.length) {
      return { consistent: true, entries: 0, reason: 'ok' };
    }

    return {
      consistent: false,
      entries: memoryList.length,
      reason: error && error.code === 'ENOENT' ? 'missing' : 'corrupt',
    };
  }

  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch (_) {
    return { consistent: false, entries: memoryList.length, reason: 'corrupt' };
  }

  if (!Array.isArray(parsed)) {
    return { consistent: false, entries: memoryList.length, reason: 'corrupt' };
  }

  // 磁盘形态先过一遍与读盘相同的升级（贡献列表 + 身份/时效字段 + id 去重）：
  // 旧数据在内存里是升级后的形态，直接拿原始 JSON 比会假报不一致。
  // 这套升级是幂等的，已升级过的库再过一次结果不变。
  const hydratedDisk = hydrateEntries(parsed);
  const diskFingerprint = storeFingerprint(hydratedDisk);
  const memoryFingerprint = storeFingerprint(memoryList);

  if (hydratedDisk.length !== memoryList.length) {
    return {
      consistent: false,
      entries: memoryList.length,
      diskEntries: parsed.length,
      diskValidEntries: hydratedDisk.length,
      reason: 'count-mismatch',
    };
  }

  if (diskFingerprint !== memoryFingerprint) {
    return {
      consistent: false,
      entries: memoryList.length,
      diskEntries: parsed.length,
      diskValidEntries: hydratedDisk.length,
      reason: 'mismatch',
    };
  }

  return { consistent: true, entries: memoryList.length, reason: 'ok' };
}

module.exports = {
  MEMORY_ENABLED,
  MEMORY_SKIP_REASONS,
  STATUS_ACTIVE,
  STATUS_PENDING,
  STATUS_CONTESTED,
  STATUS_SUPERSEDED,
  STATUS_ARCHIVED,
  loadMemories,
  getMemories,
  getMemoriesForUser,
  getPendingMemories,
  getPendingMemoriesForUser,
  checkMemoryOwnership,
  confirmPending,
  confirmMemoryFeedback,
  denyMemoryFeedback,
  correctMemoryFeedback,
  rejectPending,
  archiveMemory,
  updateMemory,
  mergeMemories,
  consolidatePendingDuplicates,
  planPendingConsolidation,
  supersedeMemory,
  withdrawMemory,
  deleteMemory,
  buildMemoryContext,
  searchMemories,
  processMemory,
  applyCandidate,
  getObserverMode,
  OBSERVER_EVERY_TURN,
  EXTRACT_INPUT_MAX,
  clearMemories,
  clearSessionMemories,
  recallMemoryBySourceQuote,
  getWriteOutcomes,
  verifyStoreConsistency,
};
