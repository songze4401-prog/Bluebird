/* global __dirname */
const path = require('path');
const { logDataEvent } = require('./data-events');
const monitoring = require('./monitoring');
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
const { DECISION } = require('./memory-decision');

// 文本基础件与常量：R2a 自本文件迁出（server/memory-ranking.js）。留守仅
// 消费这些（合并配对相似度/敏感词/来源与类型校验）；评分与渲染路径已随
// R2c 迁至 memory-retrieval.js 消费。
const { cleanText } = require('./memory-ranking');

// 记忆抽取管道：R2b 自本文件迁出（server/memory-extraction.js），经解构
// 回注保持调用点零改动（processMemory/诊断端点/merge 路径等留守代码继续
// 裸名调用）。pendingMemoryIntents 是共享协调状态：这里拿到的是与抽取
// 模块同一 Set 实例。
const {
  pendingMemoryIntents,
  pendingMemoryIntentKey,
  shouldProcessMemory,
  OBSERVER_EVERY_TURN,
  EXTRACT_INPUT_MAX,
  getObserverMode,
  MEMORY_SKIP_REASONS,
  reportSkip,
  extractMemory,

  MEMORY_ENABLED,
} = require('./memory-extraction');

// 记忆检索路径簇：R2c 自本文件迁出（server/memory-retrieval.js），经解构
// 回注保持调用点零改动（写路径 scopeOf、管理接口与
// module.exports 的 searchMemories/buildMemoryContext 等留守代码继续裸名
// 调用同一套读路径）。
const {
  getMemoriesForUser,
  getPendingMemoriesForUser,
  checkMemoryOwnership,
  buildMemoryContext,
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
// 经解构回注保持调用点零改动（module.exports 九操作；stripHedgePendingMark/
// PENDING_CANDIDATE_MATCH_MIN 的调用点已随 R7 迁至 memory-apply.js）。
const {
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

// 候选写入决策簇：R7 自本文件迁出（server/memory-apply.js），经解构
// 回注保持调用点零改动（applyCandidate 被 processMemory 调用；
// logLifecycle 三件回注后续注容器——容器消费链不变）。
const {
  logLifecycleEvent,
  logLifecycleRejection,
  trimToCapacity,
  applyCandidate,
} = require('./memory-apply');

// 记忆读侧 CRUD 与删除簇：R5 自本文件迁出（server/memory-crud.js），
// 经解构回注保持调用点零改动（module.exports 四操作）。
const {
  clearMemories,
  clearSessionMemories,
  recallMemoryBySourceQuote,
  deleteMemory,
} = require('./memory-crud');

// 记忆持久化簇：R6 自本文件迁出（server/memory-persist.js），经解构
// 回注保持调用点零改动（顶层 loadMemories() 调用、verifyStoreConsistency
// 的 hydrateEntries、容器注入的六函数引用）。
const {
  registerMemoryCorruptionHandler,
  loadMemories,
  saveMemories,
  commitWithTombstones,
  enqueueWrite,
  verifyStoreConsistency,
} = require('./memory-persist');

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
  memoryTombstoneFile: MEMORY_TOMBSTONE_FILE,
  getTombstones: () => memoryTombstones,
  setTombstones: (next) => { memoryTombstones = next; },
  getWriteQueue: () => writeQueue,
  setWriteQueue: (next) => { writeQueue = next; },
  handleCorruption,
  registerCorruptionHandler,
});

// corruption 注册：须在容器注入后执行（回调经容器触达圈依赖）。
registerMemoryCorruptionHandler();

const memoryObservationLedger = require('./memory-observation-ledger');



let memories = [];
let memoryTombstones = [];
let writeQueue = Promise.resolve();
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
