// 记忆检索路径簇（健康度审计 R2c，2026-11-21 自 memory.js 迁出）。
//
// 职责：读作用域体系（normalizeScopeInput/sessionScopeOf/userScopeOf/scopeOf/
// ownerAllows）、用户视角 getter（getMemoriesForUser/getPendingMemoriesForUser/
// checkMemoryOwnership）、可见候选池（visiblePool）与状态/来源/类型/类别/
// 情景/时间窗六类过滤器、固定评测注入渲染入口（buildMemoryContext）、
// 线上检索（selectSearchCandidates/resolveReadScope/searchMemories）。
//
// 设计边界（勿破坏）：
// - 零回边：不 require memory.js（否则入圈，触发 scc-freeze 门禁）。
//   状态经共享容器 injectMemoryCore 注入：getMemories/getPendingMemories 是
//   memory.js 的留守公开 getter，memoryEnabled 是 memory.js 的模块级
//   快照——注入使行为与迁移前完全一致（freshModule 重载 memory.js 时
//   注入值随之更新，避免 R2b 在 memory-extraction 上踩过的快照固化坑）。
// - buildMemoryContext 与 searchMemories 共用 scopeOf/visiblePool/
//   rankMemories（「不另造轮子」）：评测作用域结论与线上读路径一致。
//   buildMemoryContext 非线上注入路径（线上走 context/retriever.js →
//   searchMemories → context/builder.js），保留给固定评测与作用域回归。
//
// 消费方：memory.js 经解构回注（写路径 scopeOf/ownerAllows、管理接口
// getMemoriesForUser/checkMemoryOwnership、module.exports 的
// searchMemories/buildMemoryContext 等留守代码继续裸名调用），调用点零改动。
const {
  CATEGORY,
  INJECT_TOKEN_BUDGET,
  SEARCH_TOKEN_BUDGET_DEFAULT,
  cleanText,
  contributionSourceTypes,
  neutralizeContextText,
  normalizeSearchFilters,
  rankMemories,
  renderMemoryContext,
} = require('./memory-ranking');
const {
  STATUS_ACTIVE,
  classifyIneffective,
  isEffectiveAt,
  isHistoricalAt,
  parseTimestamp,
} = require('./memory-lifecycle');
const {
  estimateTokens,
  textLength,
  TOKEN_ESTIMATOR_VERSION,
  truncateText,
  truncateToTokenBudget,
} = require('./text-utils');
const { semanticCapability } = require('./memory-semantic');

// 状态注入经共享容器 server/memory-core.js（state-holder 统一设计）：
// 键 { getMemories, getMemoryList, getPendingMemories, memoryEnabled }，
// memory.js 顶层注入。
const { memoryCore } = require('./memory-core');

// 记忆读作用域。两种模式，语义完全不同：
//
//   session —— 会话级隔离（P0 修隐私外泄时引入的旧语义，保留用于兼容与回归）
//     primary  : 有一条贡献属于本会话
//     legacy   : 没有任何带归属的旧数据（无贡献，或贡献的 sessionId 为空）
//     excluded : 贡献全部登记在别的会话名下
//
//   user —— 用户级共享（P1 目标语义：长期记忆是用户的认知，不是会话的）
//     primary  : 条目归属用户 == 当前可信用户
//     excluded : 归属用户不同，或无法建立可信身份（fail-closed）
//
// 三条读路径（注入 / 工具检索 / 引擎检索）必须共用这一个函数：
// 只要还有一条路径自己判断归属，跨会话串读就只是"少了一条"而不是"没有"。
//
// 注意：user 模式不是"关掉隔离"，而是把边界从会话换成用户。没有可信 userId
// 时一律 excluded，绝不退回"全库可见"。
function normalizeScopeInput(input) {
  if (typeof input === 'string' || input === null || input === undefined) {
    return { mode: 'session', userId: null, sessionId: cleanText(input) };
  }

  if (typeof input === 'object') {
    return {
      mode: input.mode === 'user' ? 'user' : 'session',
      userId: cleanText(input.userId),
      sessionId: cleanText(input.sessionId),
    };
  }

  return { mode: 'session', userId: null, sessionId: null };
}

function sessionScopeOf(item, targetSessionId) {
  const contributions = Array.isArray(item.contributions)
    ? item.contributions
    : [];

  if (
    targetSessionId !== null &&
    contributions.some(c => c && c.sessionId === targetSessionId)
  ) {
    return 'primary';
  }

  if (!contributions.some(c => c && c.sessionId)) {
    return 'legacy';
  }

  if (contributions.some(c => c && c.sessionId === null)) {
    return 'legacy';
  }

  return 'excluded';
}

function userScopeOf(item, userId) {
  // 无法建立可信用户身份：不放行任何记忆（fail-closed，绝不退回全库可见）。
  if (!userId) return 'excluded';

  const owner = cleanText(item && item.userId);

  // 没有归属用户的条目（未经 stampIdentity 的对象）同样不放行：
  // 读盘路径一定会补上 userId，走到这里说明来源不可信。
  if (!owner) return 'excluded';

  return owner === userId ? 'primary' : 'excluded';
}

function scopeOf(item, rawScope) {
  const scope = normalizeScopeInput(rawScope);

  return scope.mode === 'user'
    ? userScopeOf(item, scope.userId)
    : sessionScopeOf(item, scope.sessionId);
}

// ---- 归属校验（多用户上线前的 P0 阻断项） ----
// 管理类接口（读列表 / 删除 / 归档 / 清空）过去是「全库」语义。单用户部署下
// 全库 == 本人，所以看不出问题；一旦接入真实多用户，任意已认证用户就能读写
// 他人的记忆。这里把归属判断收敛成一个函数，读写两侧共用：
//
//   userId 为空  → 不做限制（内部调用 / 兼容旧调用点，保持既有行为）
//   userId 非空  → 必须与条目 userId 完全一致，否则拒绝
//
// 注意：空 userId 不做限制是"兼容内部调用"，不是"放行外部请求"。
// HTTP 层必须显式传 resolveUserId(req)，不得省略。
function ownerAllows(item, userId) {
  const owner = cleanText(userId);
  if (!owner) return true;
  return cleanText(item && item.userId) === owner;
}

// 按归属用户读取。无可信身份时返回空数组（fail-closed），绝不退回全库。
function getMemoriesForUser(userId, options = {}) {
  const owner = cleanText(userId);
  if (!owner) return [];
  return memoryCore()
    .getMemories(options)
    .filter(item => ownerAllows(item, owner));
}

function getPendingMemoriesForUser(userId) {
  const owner = cleanText(userId);
  if (!owner) return [];
  return memoryCore()
    .getPendingMemories()
    .filter(item => ownerAllows(item, owner));
}

// 变更前的归属预检：返回 { ok, reason }，不修改任何数据。
// 供管理接口与审批执行器在"执行动作"之前先判断能不能动这条记忆。
function checkMemoryOwnership(id, userId) {
  const targetId = cleanText(id);
  const owner = cleanText(userId);

  if (!targetId) return { ok: false, reason: 'invalid' };

  const pool = memoryCore().getMemoryList();
  const item = (Array.isArray(pool) ? pool : []).find(
    entryItem => entryItem && entryItem.id === targetId
  );

  if (!item) return { ok: false, reason: 'not-found' };
  if (!ownerAllows(item, owner)) return { ok: false, reason: 'forbidden' };

  return { ok: true, reason: null };
}

// 当前作用域可用的候选池：先按状态与时间窗口过滤（被更正、归档、过期、
// 未到生效时间的旧条目不再对外生效），再按作用域过滤。
function visiblePool(rawScope, list = null) {
  const scope = normalizeScopeInput(rawScope);
  if (!list) list = memoryCore().getMemoryList();

  const valid = list.filter(
    item =>
      item &&
      typeof item.content === 'string' &&
      item.content.trim() &&
      isEffectiveAt(item)
  );

  const primary = valid.filter(item => scopeOf(item, scope) === 'primary');

  if (primary.length) return primary;

  return valid.filter(item => scopeOf(item, scope) === 'legacy');
}

// 注入上限：与旧实现一致，相关性过滤后最多注入 10 条。
const INJECT_CAP = 10;

// scope 支持两种形态：
//   - 字符串 / 省略：按会话级隔离（旧语义，等同于 { mode: 'session', sessionId }）
//   - 对象：{ mode: 'user', userId } 按用户级共享；{ mode: 'session', sessionId } 按会话隔离
//
// 作用域为空时绝不退回「全库可见」：会话模式下只注入无归属的旧数据，
// 用户模式下没有可信 userId 则一律不注入。线上路径必须显式给作用域。
//
// 注意：这不是生产注入路径。线上注入走 Context Runtime v3
// （server/context/retriever.js → searchMemories → server/context/builder.js
// 的 renderMemoryBlock）。本函数保留给固定评测（tests/memory-eval/）与
// 作用域回归断言使用：它与 searchMemories 共用 scopeOf / visiblePool /
// rankMemories，因此评测里的作用域结论与线上读路径一致。
function buildMemoryContext(message, scope = null) {
  if (!memoryCore().memoryEnabled) return '';

  try {
    const current = String(message || '').trim();

    if (!current) {
      return '';
    }

    const pool = visiblePool(scope);

    if (!pool.length) {
      return '';
    }

    // 小记忆集不再无条件全量注入：相关性过滤对每条都执行，
    // identity 由 rankMemories 的类型保底规则保留，其余事实仍须命中查询。
    const ranked = rankMemories(pool, current, INJECT_CAP, {
      now: Date.now(),
    });

    if (!ranked.length) return '';

    return renderMemoryContext(
      ranked.map(entry => entry.item),
      { maxTokens: INJECT_TOKEN_BUDGET }
    );
  } catch (error) {
    console.error(
      'Memory context error:',
      error.message
    );

    return '';
  }
}
function matchesStatusFilter(item, statuses) {
  if (!statuses) return true;

  return statuses.includes(item.status || STATUS_ACTIVE);
}

function matchesSourceFilter(item, sources) {
  if (!sources) return true;

  const types = contributionSourceTypes(item);

  return types.some(type => sources.includes(type));
}

function matchesTypeFilter(item, types) {
  if (!types) return true;
  return types.includes(item.type);
}

function matchesCategoryFilter(item, categories) {
  if (!categories) return true;

  const category = cleanText(item.category);

  // 旧条目没有 P1 类别：保留在层内，避免升级后旧事实突然不可见。
  return !category || category === CATEGORY.LEGACY || categories.includes(category);
}

function matchesEpisodicFilter(item, episodicOnly) {
  if (!episodicOnly) return true;

  return Boolean(
    item.type === 'fact' &&
      (cleanText(item.eventAt) ||
        cleanText(item.condition) ||
        cleanText(item.validTo) ||
        item.category === CATEGORY.TEMPORARY_STATE)
  );
}

function matchesTimeRange(item, range) {
  if (!range) return true;

  if (range.field === 'valid') {
    const start = parseTimestamp(item.validFrom);
    if (start === null) return false;

    const end = parseTimestamp(item.validTo);

    return (
      (range.to === null || start <= range.to) &&
      (range.from === null || (end === null ? Infinity : end) >= range.from)
    );
  }

  const value = parseTimestamp(
    range.field === 'created' ? item.createdAt : item.updatedAt
  );

  if (value === null) return false;

  return (
    (range.from === null || value >= range.from) &&
    (range.to === null || value <= range.to)
  );
}

function selectSearchCandidates({
  scope,
  history,
  asOfMs,
  filters,
}) {
  const poolSrc = memoryCore().getMemoryList();
  const all = Array.isArray(poolSrc) ? poolSrc : [];
  const exclusions = {
    invalid: 0,
    visibility: 0,
    session_scope: 0,
    status: 0,
    source: 0,
    time: 0,
    type: 0,
    category: 0,
    episodic: 0,
  };
  // 不可见原因分解（P2）：过期的、被替代的、归档的、待确认的分别计数，
  // 这样 Trace 能回答「这条记忆为什么没进候选池」，而不是只有一个总数。
  const visibilityReasons = {
    pending: 0,
    superseded: 0,
    archived: 0,
    not_yet_valid: 0,
    expired: 0,
    unknown_status: 0,
  };
  const base = [];

  for (const item of all) {
    if (
      !item ||
      typeof item.content !== 'string' ||
      !item.content.trim()
    ) {
      exclusions.invalid += 1;
      continue;
    }

    const visible = history
      ? isHistoricalAt(item, asOfMs)
      : isEffectiveAt(item);

    if (!visible) {
      exclusions.visibility += 1;
      const reason = classifyIneffective(item, asOfMs);
      if (reason && visibilityReasons[reason] !== undefined) {
        visibilityReasons[reason] += 1;
      } else {
        visibilityReasons.unknown_status += 1;
      }
      continue;
    }

    base.push(item);
  }

  const primary = base.filter(item => scopeOf(item, scope) === 'primary');
  const legacy = base.filter(item => scopeOf(item, scope) === 'legacy');
  const pool = primary.length ? primary : legacy;

  // 用户模式下没有 legacy 兜底语义：primary 为空就是"没有可见记忆"。
  exclusions.session_scope = base.length - pool.length;

  let filtered = pool;

  if (filters.statuses) {
    const before = filtered.length;
    filtered = filtered.filter(item =>
      matchesStatusFilter(item, filters.statuses)
    );
    exclusions.status += before - filtered.length;
  }

  if (filters.sources) {
    const before = filtered.length;
    filtered = filtered.filter(item =>
      matchesSourceFilter(item, filters.sources)
    );
    exclusions.source += before - filtered.length;
  }

  if (filters.timeRange) {
    const before = filtered.length;
    filtered = filtered.filter(item =>
      matchesTimeRange(item, filters.timeRange)
    );
    exclusions.time += before - filtered.length;
  }

  if (filters.types) {
    const before = filtered.length;
    filtered = filtered.filter(item => matchesTypeFilter(item, filters.types));
    exclusions.type += before - filtered.length;
  }

  if (filters.categories) {
    const before = filtered.length;
    filtered = filtered.filter(item =>
      matchesCategoryFilter(item, filters.categories)
    );
    exclusions.category += before - filtered.length;
  }

  if (filters.episodicOnly) {
    const before = filtered.length;
    filtered = filtered.filter(item =>
      matchesEpisodicFilter(item, filters.episodicOnly)
    );
    exclusions.episodic += before - filtered.length;
  }

  return {
    pool: filtered,
    exclusions,
    visibilityReasons,
    storeTotal: all.length,
    eligible: base.length,
  };
}

// ---- Agent 工具 / 上下文引擎专用：scope 化记忆检索 ----
// 与 buildMemoryContext 的差异：结构化返回 + 四维过滤 + 多类预算；相同的部分：
// 候选池由 selectSearchCandidates() 复用同一个 scopeOf 规则生成，所以两条读
// 路径不可能对「这条记忆当前能不能看」给出不同答案。
// 预算（条数 / 单条长度 / 字符 / 近似 token）由调用方传入，工具层再兜底；
// 长度一律按 text-utils 的码点规则计算并截断。
//
// 作用域选择（显式优先，缺省按是否给了可信 userId 推导）：
//   传 userId           → 用户级共享（P1 生产路径）
//   只传 sessionId      → 会话级隔离（旧行为，兼容老调用与回归测试）
//   两者都没传          → 会话级、且 sessionId 为空 ⇒ 只见无归属旧数据（fail-closed）
function resolveReadScope({ scope, userId, sessionId }) {
  if (scope !== undefined && scope !== null) {
    return normalizeScopeInput(scope);
  }

  const uid = cleanText(userId);

  return uid
    ? { mode: 'user', userId: uid, sessionId: cleanText(sessionId) }
    : { mode: 'session', userId: null, sessionId: cleanText(sessionId) };
}

function searchMemories({
  query,
  sessionId,
  userId,
  scope,
  limits = {},
  mode = 'current',
  asOf = null,
  filters: rawFilters = null,
} = {}) {
  const history = mode === 'history';
  const readScope = resolveReadScope({ scope, userId, sessionId });
  const maxItems =
    Number.isFinite(limits.maxItems) && limits.maxItems > 0
      ? Math.min(Math.floor(limits.maxItems), 50)
      : 10;
  const perItemMax =
    Number.isFinite(limits.perItemMax) && limits.perItemMax > 0
      ? Math.floor(limits.perItemMax)
      : 300;
  const totalMax =
    Number.isFinite(limits.totalMax) && limits.totalMax > 0
      ? Math.floor(limits.totalMax)
      : 2000;
  const maxTokens =
    Number.isFinite(limits.maxTokens) && limits.maxTokens > 0
      ? Math.min(Math.floor(limits.maxTokens), 8000)
      : SEARCH_TOKEN_BUDGET_DEFAULT;

  const emptyDiagnostics = {
    candidates: 0,
    returned: 0,
    excluded: {
      invalid: 0,
      visibility: 0,
      session_scope: 0,
      status: 0,
      source: 0,
      time: 0,
      irrelevant: 0,
    },
    // 不可见原因分解：与 excluded.visibility 是同一个集合的细分。
    visibilityReasons: {
      pending: 0,
      superseded: 0,
      archived: 0,
      not_yet_valid: 0,
      expired: 0,
      unknown_status: 0,
    },
    // 检索漏斗：库总量 → 状态/时间可见 → 作用域可见 → 过滤 → 命中。
    // 撤回/删除是物理删除，不在此处计数（见 docs/p2-memory-observability.md）。
    funnel: {
      store_total: 0,
      eligible: 0,
      candidates: 0,
      returned: 0,
    },
    // 作用域模式进 diagnostics：Trace 里能区分「用户级没命中」与「会话级被隔离」。
    scopeMode: readScope.mode,
    scopeUserId: readScope.mode === 'user' ? readScope.userId : null,
    truncatedItems: 0,
    limitTruncated: false,
    budgetTruncated: false,
    maxItems,
    perItemMax,
    totalMax,
    maxTokens,
    tokenEstimator: TOKEN_ESTIMATOR_VERSION,
    semantic: semanticCapability(),
    estimatedTokens: 0,
  };

  const emptyResult = (reason, extra = {}) => ({
    results: [],
    total: 0,
    estimatedTokens: 0,
    truncated: false,
    truncatedItems: 0,
    mode,
    ...(reason ? { reason } : {}),
    ...extra,
    diagnostics: { ...emptyDiagnostics, ...(extra.diagnostics || {}) },
  });

  if (!memoryCore().memoryEnabled) return emptyResult('memory_disabled');

  const current = String(query || '').trim();
  if (!current) return emptyResult('empty_query');

  let asOfMs = Date.now();

  if (history) {
    const parsed = parseTimestamp(asOf);

    if (parsed === null) {
      return emptyResult('invalid_as_of');
    }

    asOfMs = parsed;
  }

  const normalizedFilters = normalizeSearchFilters(rawFilters);

  if (!normalizedFilters.ok) {
    return emptyResult('invalid_filters', {
      diagnostics: { filterError: normalizedFilters.error },
    });
  }

  const selection = selectSearchCandidates({
    scope: readScope,
    history,
    asOfMs,
    filters: normalizedFilters.filters,
  });
  const diagnostics = {
    ...emptyDiagnostics,
    candidates: selection.pool.length,
    excluded: {
      ...emptyDiagnostics.excluded,
      ...selection.exclusions,
    },
    visibilityReasons: {
      ...emptyDiagnostics.visibilityReasons,
      ...(selection.visibilityReasons || {}),
    },
    funnel: {
      store_total: selection.storeTotal || 0,
      eligible: selection.eligible || 0,
      candidates: selection.pool.length,
      returned: 0,
    },
  };

  if (!selection.pool.length) {
    return emptyResult('empty_store', { diagnostics });
  }

  // 先完成过滤与全部候选的排序，再在最后一步做条数/长度/token 截断；
  // 这样“未返回原因”不会把排序上限误报成低相关。
  const ranked = rankMemories(selection.pool, current, selection.pool.length, {
    candidateFilter: () => true,
    now: Date.now(),
  });

  diagnostics.excluded.irrelevant = Math.max(
    0,
    selection.pool.length - ranked.length
  );

  const results = [];
  let total = 0;
  let totalTokens = 0;
  let truncated = false;
  let truncatedItems = 0;
  let limitTruncated = false;
  let budgetTruncated = false;
  const notReturned = { limit: 0, token_budget: 0, char_budget: 0 };

  for (let index = 0; index < ranked.length; index += 1) {
    const entry = ranked[index];
    const item = entry.item;

    if (results.length >= maxItems) {
      limitTruncated = true;
      truncated = true;
      notReturned.limit += ranked.length - index;
      break;
    }

    const originalContent = neutralizeContextText(item.content);
    let content = truncateText(originalContent, perItemMax);
    let itemCut = textLength(content) < textLength(originalContent);
    let contentTokens = estimateTokens(content);
    const remainingTokens = maxTokens - totalTokens;

    if (contentTokens > remainingTokens) {
      content = truncateToTokenBudget(content, remainingTokens);
      contentTokens = estimateTokens(content);
      budgetTruncated = true;
      itemCut = true;
    }

    if (!content) {
      budgetTruncated = true;
      notReturned.token_budget += 1;
      continue;
    }

    let cost = textLength(content);

    // 单条就吃掉全部字符预算：截到预算内，后续不再追加。
    if (cost > totalMax) {
      content = truncateText(content, totalMax);
      cost = textLength(content);
      contentTokens = estimateTokens(content);
      budgetTruncated = true;
      itemCut = true;
    }

    if (results.length && total + cost > totalMax) {
      truncated = true;
      budgetTruncated = true;
      notReturned.char_budget += 1;
      break;
    }

    if (itemCut) {
      truncated = true;
      truncatedItems += 1;
    }

    results.push({
      content,
      type: item.type,
      id: item.id,
      status: item.status || STATUS_ACTIVE,
      confidence: item.confidence,
      validFrom: item.validFrom,
      validTo: item.validTo || null,
      supersededBy: item.supersededBy || null,
      updatedAt: item.updatedAt || null,
      relevance: +entry.relevance.toFixed(6),
      score: +entry.score.toFixed(6),
      match: {
        reason: entry.matchReason,
        keywords: entry.matchKeywords,
        keywordScore: +entry.keywordScore.toFixed(6),
        contentScore: +entry.contentScore.toFixed(6),
        semantic: {
          matched: entry.semanticScore > 0,
          score: +entry.semanticScore.toFixed(6),
          coverage: +entry.semanticCoverage.toFixed(6),
          precision: +entry.semanticPrecision.toFixed(6),
          concepts: entry.semanticConcepts,
          evidence: entry.semanticEvidence,
          provider: entry.semanticProvider,
          kind: entry.semanticKind,
          neural: entry.semanticNeural,
          limited: entry.semanticLimited,
          blocked: entry.semanticBlocked,
        },
      },
      components: {
        lexicalRelevance: +entry.lexicalRelevance.toFixed(6),
        hybridRelevance: +entry.relevance.toFixed(6),
        bigramScore: +entry.bigramScore.toFixed(6),
        semanticScore: +entry.semanticScore.toFixed(6),
        semanticCoverage: +entry.semanticCoverage.toFixed(6),
        semanticPrecision: +entry.semanticPrecision.toFixed(6),
        semanticKind: entry.semanticKind,
        semanticProvider: entry.semanticProvider,
        semanticNeural: entry.semanticNeural,
        semanticLimited: entry.semanticLimited,
        semanticBlocked: entry.semanticBlocked,
        typeWeight: entry.typeWeight,
        timeDecay: +entry.timeDecay.toFixed(6),
        statusWeight: entry.statusWeight,
        confidenceWeight: +entry.weight.toFixed(6),
      },
      sourceTypes: entry.sourceTypes,
      scope: scopeOf(item, readScope),
      contentTruncated: itemCut,
    });
    total += cost;
    totalTokens += contentTokens;

    if (contentTokens >= maxTokens) {
      budgetTruncated = true;
      truncated = true;
      notReturned.token_budget += Math.max(0, ranked.length - index - 1);
      break;
    }
  }

  if (results.length < ranked.length) truncated = true;

  diagnostics.returned = results.length;
  if (diagnostics.funnel) diagnostics.funnel.returned = results.length;
  diagnostics.truncatedItems = truncatedItems;
  diagnostics.limitTruncated = limitTruncated;
  diagnostics.budgetTruncated = budgetTruncated;
  diagnostics.estimatedTokens = totalTokens;
  diagnostics.notReturned = notReturned;

  return {
    results,
    total,
    estimatedTokens: totalTokens,
    truncated,
    truncatedItems,
    mode,
    diagnostics,
  };
}


module.exports = {
  normalizeScopeInput,
  sessionScopeOf,
  userScopeOf,
  scopeOf,
  ownerAllows,
  getMemoriesForUser,
  getPendingMemoriesForUser,
  checkMemoryOwnership,
  visiblePool,
  INJECT_CAP,
  buildMemoryContext,
  matchesStatusFilter,
  matchesSourceFilter,
  matchesTypeFilter,
  matchesCategoryFilter,
  matchesEpisodicFilter,
  matchesTimeRange,
  selectSearchCandidates,
  resolveReadScope,
  searchMemories,
};
