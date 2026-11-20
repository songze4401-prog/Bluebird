// 记忆抽取管道簇（健康度审计 R2b，2026-11-21 自 memory.js 迁出）。
//
// 职责：记忆触发的意图去重与待办状态、触发词门禁、观察者模式、
// 锚点/关键词接地校验、模型抽取调用（extractMemory）与贡献归一化。
//
// 设计边界（勿破坏）：
// - pendingMemoryIntents 是本模块与 memory.js processMemory 之间的
//   共享协调状态：Set 经 module.exports 导出，memory.js 解构回注拿到
//   同一引用（add/has/delete 语义与迁移前完全一致）。除此之外本模块
//   不反读 memory.js 任何状态，也不 require 回 memory.js（否则入圈，
//   触发 scc-freeze 门禁）。
// - 数据目录与 memory.json 路径不在本模块固化：一律经注入/留守方拼装
//   （理由见下方 MEMORY_FILE 段）。
//
// 消费方：memory.js 经解构回注（processMemory/诊断端点/merge 路径等
// 留守代码继续裸名调用），调用点零改动。
//
// 圈依赖注入：data-events / monitoring 都在 46 文件加载圈中（R1 冻结），
// 本模块顶层 require 它们会把自身拉入圈内（scc-freeze 门禁红线）。
// 因此这两个能力由 memory.js 加载后经 injectExtractionDeps 回注：
// reportSkip 在未注入时直接抛错（显式失败，绝不静默丢埋点）；
// extractMemory 的未注入检查在外层 try 内，会被兜底 catch 转成
// skip('model_error')——同样显式可见，但不是裸抛错。
// 仓库先例：user-scope.js 不 require permissions.js 同款取舍。
//
// MEMORY_FILE 同理经注入：数据目录（BLUEBIRD_DATA_DIR）必须跟随 memory.js
// 的加载语境——测试基建 freshModule 只重载 memory.js，本模块若顶层固化
// 路径，事件里的 file 会残留旧目录（data-events 套件 J 段实证过）。
const crypto = require('crypto');
const { getInstanceUserId } = require('./user-scope');
const { STATUS_ACTIVE, isActiveStatus } = require('./memory-lifecycle');
const { PROVENANCE, CATEGORY, hasHedge } = require('./memory-evidence');
const {
  ALLOWED_TYPES,
  cleanText,
  normalize,
  similarity,
  isSensitive,
  SOURCE_TYPES,
} = require('./memory-ranking');

// 注入容器：{ logDataEvent, monitoring, memoryFile }。memory.js 是唯一
// 注入方（全部消费方——processMemory/测试/eval driver——都经 memory.js 加载）。
let extractionDeps = null;
function injectExtractionDeps(deps) {
  extractionDeps = deps;
}
function extractionDepsOrThrow() {
  if (!extractionDeps) {
    throw new Error(
      'memory-extraction: 圈依赖未注入（injectExtractionDeps）——本模块须在 memory.js 加载后使用'
    );
  }
  return extractionDeps;
}

// hedged 候选落盘时正文带的不确定性前缀（见 processMemory 的 sourceHedged 分支）。
// 合并配对必须先把前缀剥掉再算相似度：不剥的话「可能：X」对「X」相似度只有
// 0.70 左右，跨会话的同一候选永远配不上对，同正文 pending 按会话各自成条
// （2026-11-19 记忆评测 Phase5 实证实锤；fix 由 Owner 拍板落地）。
const HEDGE_PENDING_MARK = '可能：';

// 模块级 env 快照：本模块被 require 后不随 BLUEBIRD_DATA_DIR 式的
// freshModule 重载重估（freshModule 只清 memory.js 的缓存）。迁移前该
// 值随 memory.js 重载重估——现无测试改它后重载，将来要加此类测试需改
// 为调用时读取。
const MEMORY_ENABLED = process.env.MEMORY_ENABLED !== 'false';

// 记忆触发词：覆盖「记住 / 记下」这类显式指令，以及口语化的
// 「记一下 / 帮我记 / 别忘了 / 记一笔 / 记录一下」等请求。
// 注意：「记下来」已含「记下」，无需单列。
const MEMORY_TRIGGER =
  /(记一下|记一笔|记录一下|帮我记|别忘了|记住|记着|记下|保存|我叫|我的名字|我是|我喜欢|我不喜欢|我想要|我的目标|以后请|请不要|忘记|别记|不要记)/;

// 跨消息的"待记忆"状态：用户先单独发一句「记住」，下一条才给出内容时，
// 由它让同一会话的下一条消息也走一次记忆提取。按可信用户与会话隔离，消费一次即清除。
const pendingMemoryIntents = new Set();
const ID_PREFIX_DERIVED = 'legacy-';
const ID_PREFIX_ISSUED = 'mem-';

// 相似度分档与临时状态规则在 memory-decision.js 中定义并测试。


function pendingMemoryIntentKey(sessionId, userId) {
  return JSON.stringify([cleanText(userId), cleanText(sessionId)]);
}

// 旧条目的 id 由已有字段推出（正文 + 落库时间 + 最早那条原话），
// 因此同一份数据反复推导得到同一个 id —— 迁移可以每次启动都跑而不产生分叉。
function derivedId(item) {
  const anchor =
    (item.contributions && item.contributions[0]
      ? item.contributions[0].sourceQuote
      : null) || '';

  const seed = [item.content || '', item.createdAt || '', anchor].join('|');

  return `${ID_PREFIX_DERIVED}${crypto
    .createHash('sha1')
    .update(seed)
    .digest('hex')
    .slice(0, 16)}`;
}

function issuedId() {
  return `${ID_PREFIX_ISSUED}${crypto.randomUUID()}`;
}

// 只补字段，不改正文、不改时间、不删条目：缺省值全部由已有字段推出。
// 已有 id / status 的原样保留，所以重复执行迁移是恒等操作；补出来的字段
// 要落盘只能等下一次真实写入 —— 读盘路径绝不写文件。
//
// userId 是 P1 引入的用户级作用域键：长期记忆的读边界从「会话」上提到「用户」。
// 旧数据没有这个字段，读盘时一律归到实例用户（单实例部署下本来就同属一个用户），
// 因此迁移是幂等的，也不会改变任何既有条目的正文与归属。
function stampIdentity(item) {
  const status = cleanText(item.status) || STATUS_ACTIVE;
  const createdAt = cleanText(item.createdAt);

  return {
    ...item,
    id: cleanText(item.id) || derivedId(item),
    status,
    userId: cleanText(item.userId) || getInstanceUserId(),
    validFrom: cleanText(item.validFrom) || createdAt,
    validTo: cleanText(item.validTo),
    supersededBy: cleanText(item.supersededBy),
    provenance: cleanText(item.provenance) || PROVENANCE.IMPORTED,
    category: cleanText(item.category) || CATEGORY.LEGACY,
    observedAt: cleanText(item.observedAt) || createdAt,
    policyVersion: cleanText(item.policyVersion) || 'legacy',
    decisionVersion: cleanText(item.decisionVersion) || null,
    evidence:
      item.evidence && typeof item.evidence === 'object' ? item.evidence : null,
  };
}

// pending / archived 均不属于“当前有效事实”；只有 active 且时间窗口命中才注入。
const isActive = isActiveStatus;

function shouldProcessMemory(message) {
  if (!MEMORY_ENABLED) return false;

  const text = String(message || '').trim();

  if (!text || text.length > 500) return false;

  return MEMORY_TRIGGER.test(text);
}

// ---- 观察模式（Phase 1 自动观察闭环）----
// trigger（默认）：维持触发词 + 跨消息意图门控的历史行为。
// every_turn：每条用户消息都尝试一次提取，不再依赖记忆口令；
//   提取输入截到 EXTRACT_INPUT_MAX 码点控成本（真实评测校准前先定 2000，TBD）。
// 回滚 = 不设置 BLUEBIRD_MEMORY_OBSERVER（或设为 trigger）。env 每次写入时读取，
// 与 BLUEBIRD_MEMORY_EVIDENCE_POLICY 同一口径：改 .env 后重启后端生效。
const OBSERVER_TRIGGER = 'trigger';
const OBSERVER_EVERY_TURN = 'every_turn';
const EXTRACT_INPUT_MAX = 2000;

function getObserverMode(env = process.env) {
  return String(env.BLUEBIRD_MEMORY_OBSERVER || '').trim() === OBSERVER_EVERY_TURN
    ? OBSERVER_EVERY_TURN
    : OBSERVER_TRIGGER;
}

// ---- 拒写原因（可观测）----
// 每条被拒的候选都带一个稳定短码，一路回传给调用方并落到结构化日志，
// 不再只留一行「Memory skipped」把三种成因混成一件事。
const ANCHOR_MIN = 0.15;
const ANCHOR_FALLBACK_MIN = 0.05;
const KEYWORD_GROUNDING_MIN = 0.5;

const MEMORY_SKIP_REASONS = [
  'memory_disabled',
  'not_triggered',
  'sensitive_input',
  'model_error',
  'model_empty',
  'no_content',
  'content_too_long',
  'quote_too_short',
  'type_not_allowed',
  'low_confidence',
  'stale_evidence',
  'low_utility',
  'insufficient_specificity',
  'weak_source_evidence',
  'sensitive_output',
  'quote_not_grounded',
  'ungrounded_content',
  'temporary_state',
  'ambiguous_conflict',
  'ambiguous_duplicate',
  'target_not_found',
  'unauthorized_target',
  'invalid_confidence',
  'invalid_valid_to',
  'invalid_event_at',
  'condition_too_long',
  'ungrounded_source',
  'unsupported_source',
  'sensitive_content',
  // 提取全过了但落盘失败（磁盘不可写等）：与「模型没提取」是两回事。
  'write_failed',
];

// 只带短码与数值，绝不把正文 / 原话 / 模型给的 type 字符串写进日志。
function skip(reason, detail) {
  return { entry: null, reason, detail: detail || null };
}

function reportSkip(reason, detail) {
  console.log('Memory skipped:', reason);

  extractionDepsOrThrow().logDataEvent({
    module: 'memory',
    file: extractionDepsOrThrow().memoryFile,
    event: 'memory_write_rejected',
    level: 'info',
    reason,
    action: 'rejected',
    extra: {
      anchorScore: detail && detail.anchorScore !== undefined ? detail.anchorScore : null,
      keywordHits: detail && detail.keywordHits !== undefined ? detail.keywordHits : null,
      keywordTotal:
        detail && detail.keywordTotal !== undefined ? detail.keywordTotal : null,
    },
  });
}

// 关键词接地：有效关键词（归一化后长度 ≥2）里有多少能在用户原话里逐字找到。
// 关键词由模型给出，逐字命中用户原话才算接住了原话，而不是模型自己发挥。
function keywordGrounding(keywords, normalizedMessage) {
  const usable = (Array.isArray(keywords) ? keywords : [])
    .map(item => normalize(item))
    .filter(item => item.length >= 2);

  if (!usable.length) {
    return { hits: 0, total: 0, covered: false };
  }

  const hits = usable.filter(item => normalizedMessage.includes(item)).length;

  return {
    hits,
    total: usable.length,
    covered: hits / usable.length >= KEYWORD_GROUNDING_MIN,
  };
}

// 记忆条目的"贡献列表"：同一条事实可能被多个会话各自说过，每说一次就留下
// 一条 { sessionId, sourceQuote, createdAt } 贡献。
// 撤回某条消息只摘掉它对应的那条贡献，贡献被摘空才删整条记忆 —— 这样
// 「A 撤回自己说的话」和「B 也说过、事实仍成立」可以同时成立。
function normalizeContribution(raw) {
  if (!raw || typeof raw !== 'object') return null;

  const sourceQuote =
    typeof raw.sourceQuote === 'string' ? raw.sourceQuote.trim() : '';

  if (!sourceQuote) return null;

  const contribution = {
    sessionId:
      typeof raw.sessionId === 'string' && raw.sessionId.trim()
        ? raw.sessionId.trim()
        : null,
    sourceQuote,
    createdAt:
      typeof raw.createdAt === 'string' && raw.createdAt
        ? raw.createdAt
        : null,
  };

  // 新贡献可携带来源定位与来源类型；旧贡献保持原形状，避免读盘迁移改写历史对象。
  const messageId = cleanText(raw.messageId);
  if (messageId) contribution.messageId = messageId;

  const sourceType = cleanText(raw.sourceType);
  if (sourceType && SOURCE_TYPES.has(sourceType)) {
    contribution.sourceType = sourceType;
  }

  return contribution;
}

// 旧数据（引入贡献列表之前）把归属与撤回锚点平铺成 sourceQuote + 可选 sessionId；
// 读盘时统一升级成一条贡献，其余字段原样保留。
// 身份与时效字段（id / status / validFrom / validTo / supersededBy）在这里补齐：
// 纯读盘推导，不写文件，因此每次进程启动重跑都是恒等结果。
function normalizeEntry(item) {
  const { sourceQuote, sessionId, ...rest } = item;

  const contributions = Array.isArray(rest.contributions)
    ? rest.contributions.map(normalizeContribution).filter(Boolean)
    : [];

  if (!contributions.length && typeof sourceQuote === 'string') {
    const legacy = normalizeContribution({
      sessionId,
      sourceQuote,
      createdAt: item.createdAt,
    });

    if (legacy) contributions.push(legacy);
  }

  return stampIdentity({ ...rest, contributions });
}

// 正文与时间都相同的重复条目会推出同一个 id：按文件里的出现次序给第二条起
// 追加 #2 / #3 后缀。次序固定 ⇒ 后缀固定 ⇒ 仍然幂等，且 id 全局唯一，
// 更正与删除才能放心按 id 定位。
function ensureUniqueIds(list) {
  const seen = new Set();

  return list.map(item => {
    if (!seen.has(item.id)) {
      seen.add(item.id);

      return item;
    }

    let ordinal = 2;

    while (seen.has(`${item.id}#${ordinal}`)) ordinal += 1;

    const id = `${item.id}#${ordinal}`;

    seen.add(id);

    return { ...item, id };
  });
}

// 同会话 + 同原话的重复贡献只保留最早一条：同一句话在同一会话里重复出现时，
// 撤回其中任意一条都应连带撤掉这条贡献，不重复计数。
function mergeContributions(existing, incoming) {
  const merged = Array.isArray(existing) ? existing.slice() : [];

  for (const contribution of Array.isArray(incoming) ? incoming : []) {
    const duplicated = merged.some(item => {
      if (item.sessionId !== contribution.sessionId) return false;

      // 有 messageId 时按来源消息去重；只有双方都没有定位信息时才退回原话去重，
      // 这样同文重复消息不会互相吞掉来源。
      if (item.messageId || contribution.messageId) {
        return (
          Boolean(item.messageId) &&
          item.messageId === contribution.messageId
        );
      }

      return item.sourceQuote === contribution.sourceQuote;
    });

    if (!duplicated) merged.push(contribution);
  }

  return merged;
}

function cloneEntry(item) {
  return {
    ...item,
    contributions: (Array.isArray(item.contributions)
      ? item.contributions
      : []
    ).map(contribution => ({ ...contribution })),
  };
}

function shareKeyword(a, b) {
  const listA = Array.isArray(a) ? a.map(item => normalize(item)) : [];
  const listB = new Set(Array.isArray(b) ? b.map(item => normalize(item)) : []);

  return listA.some(item => item && listB.has(item));
}

// ---- 统一候选与决策执行 ----


function parseModelJson(text) {
  try {
    const cleaned = String(text || '')
      .trim()
      .replace(/^```json\s*/i, '')
      .replace(/^```\s*/i, '')
      .replace(/\s*```$/i, '')
      .trim();

    if (!cleaned) return null;

    try {
      return JSON.parse(cleaned);
    } catch (_) {
      const match = cleaned.match(/\{[\s\S]*\}/);

      if (!match) return null;

      return JSON.parse(match[0]);
    }
  } catch (_) {
    return null;
  }
}

async function extractMemory(client, message, force = false, sessionId = null, options = {}) {
  try {
    // force=true 表示上一条留下了待记忆意图，本条即使没有触发词也要尝试提取
    if (!force && !shouldProcessMemory(message)) {
      return skip('not_triggered');
    }

    if (isSensitive(message)) {
      return skip('sensitive_input');
    }

    // 真实 API 调用流水：与 index.js 主回复同一格式，便于统一 grep / 对账。
    console.log(
      `[AI call] memory-extraction session=${sessionId || 'default'} at=${new Date().toISOString()}`
    );

    // B3：瞬时模型错误（timeout/connection/server）单次有界重试，退避 400ms。
    // 确定性错误（auth/bad_request 等）与空返回（{} → no_content）不重试：
    // 前者重试也不会变好，后者是模型的真实结论，翻倍成本没有收益。
    // 每次尝试都是独立的 auxiliary 埋点，重试在监控里可见。
    const TRANSIENT_EXTRACT_KINDS = new Set(['timeout', 'connection', 'server']);
    const EXTRACT_MAX_ATTEMPTS = 2;
    let completion;
    let extractAttempts = 0;
    for (;;) {
      extractAttempts += 1;
      const monitoringApi = extractionDepsOrThrow().monitoring;
      const auxiliary = monitoringApi.beginAuxiliaryModel({
        providerId: 'deepseek',
        modelId: 'deepseek-chat',
        kind: 'memory_extract',
        sessionRef: monitoringApi.sessionRefFor(sessionId),
      });
      try {
        completion = await client.chat.completions.create(
          {
            model: 'deepseek-chat',
            temperature: 0,
            max_tokens: 300,
            messages: [
              {
                role: 'system',
                content: `
你是一个长期记忆提取器。当前阶段提出可能值得跨会话保留的候选；后续证据策略会决定存储、待确认或拒绝，不要只因为置信度不高就隐去有价值候选。
优先提取清晰、稳定、具体的信息；不要把临时情绪、一次性状态、玩笑、假设或反问当作长期事实。
sourceQuote 必须逐字引用用户当前消息中的连续原文，不得润色、改写或合并不同片段。
content 应忠实表达原话。若原话含“可能、也许、似乎、大概、不确定、好像”等犹豫语气，content 必须保留同等不确定性，不能改成确定事实。
只有当结论不是用户直接说出的内容时才标记 inferred=true；模型推断必须显式标记，且不得伪装成用户直述。
可以提出需要确认的推断或模糊候选，但必须保留来源与不确定性。
不要保存密码、密钥、验证码、银行卡、身份证等敏感信息。

如果没有值得保存的信息，返回 {}。

返回严格 JSON：

{
  "content": "简短的长期记忆",
  "type": "identity|preference|fact|goal|relationship",
  "keywords": ["关键词1", "关键词2", "关键词3"],
  "confidence": 0.0,
  "inferred": false,
  "uncertainty": "none|source_hedged",
  "sourceQuote": "用户原话中的连续片段"
}

content 不要超过 100 个字符。
keywords 提取 3-5 个与这条记忆直接相关的具体关键词或同义词。
不要使用“什么”“应该”“这个”“那个”“以后”等低信息量词。
uncertainty 在原话有犹豫表达时必须为 source_hedged，否则为 none。
`.trim(),
              },
              {
                role: 'user',
                content: message,
              },
            ],
          },
          {
            timeout: 15000,
          }
        );

        auxiliary.complete({
          status: 'success',
          usage: completion && completion.usage ? completion.usage : null,
        });
        break;
      } catch (error) {
        const kind = String(
          (error && (error.kind || error.code)) || 'model_error'
        );
        auxiliary.complete({
          status: error && error.kind === 'timeout' ? 'timeout' : 'failed',
          errorCode: kind,
        });
        if (
          !TRANSIENT_EXTRACT_KINDS.has(kind) ||
          extractAttempts >= EXTRACT_MAX_ATTEMPTS
        ) {
          throw error;
        }
        await new Promise(resolve => setTimeout(resolve, 400));
      }
    }

    const raw =
      completion.choices?.[0]?.message?.content;

    const candidate = parseModelJson(raw);

    if (!candidate || typeof candidate !== 'object') {
      return skip('model_empty');
    }

    let content =
      typeof candidate.content === 'string'
        ? candidate.content
            .replace(/\s+/g, ' ')
            .trim()
        : '';

    const sourceQuote =
      typeof candidate.sourceQuote === 'string'
        ? candidate.sourceQuote.trim()
        : '';

    const type = candidate.type;
    const confidence = Number(candidate.confidence);
    const keywords = Array.isArray(candidate.keywords)
      ? candidate.keywords
          .filter(item => typeof item === 'string')
          .map(item => item.trim())
          .filter(Boolean)
          .slice(0, 5)
      : [];

    const normalizedMessage = normalize(message);
    const normalizedQuote = normalize(sourceQuote);

    if (!content || !sourceQuote) return skip('no_content');

    const sourceHedged =
      hasHedge(message) ||
      hasHedge(sourceQuote) ||
      candidate.uncertainty === 'source_hedged';
    const uncertainty = sourceHedged ? 'source_hedged' : 'none';
    // 模型漏掉语气词时用显式说明补回语义，且策略会把此条限制在待确认状态。
    if (sourceHedged && !hasHedge(content)) {
      content = `${HEDGE_PENDING_MARK}${content}`;
    }

    if (content.length > 100) return skip('content_too_long', { length: content.length });

    if (sourceQuote.length < 2) return skip('quote_too_short');

    if (!ALLOWED_TYPES.has(type)) return skip('type_not_allowed', { type });

    if (!Number.isFinite(confidence) || confidence < 0 || confidence > 1) {
      return skip('invalid_confidence');
    }

    if (isSensitive(content) || isSensitive(sourceQuote)) {
      return skip('sensitive_output');
    }

    if (
      !normalizedQuote ||
      !normalizedMessage.includes(normalizedQuote)
    ) {
      return skip('quote_not_grounded');
    }

    // 正文必须接地于用户原话，否则视为模型自己编的。接地有两条路，任一成立即可：
    //   1. 与原话的字面二元组相似度 ≥ ANCHOR_MIN；
    //   2. 改写式更正：相似度虽低但没过底线（≥ ANCHOR_FALLBACK_MIN），
    //      且至少一半有效关键词能在原话里逐字找到。
    // 旧实现只有第 1 条，「我把猫的名字从小雪改成糯糯了」→「用户的猫名字叫糯糯，两岁」
    // 这类改写（相似度 0.095）被静默丢弃，更正永远写不进库。
    const anchorScore = similarity(content, sourceQuote);
    const grounding = keywordGrounding(keywords, normalizedMessage);

    if (
      anchorScore < ANCHOR_MIN &&
      !(
        anchorScore >= ANCHOR_FALLBACK_MIN &&
        grounding.covered
      )
    ) {
      return skip('ungrounded_content', {
        anchorScore: +anchorScore.toFixed(4),
        keywordHits: grounding.hits,
        keywordTotal: grounding.total,
      });
    }

    const inferred = candidate.inferred === true;
    const provenance = inferred
      ? PROVENANCE.MODEL_INFERRED
      : PROVENANCE.USER_ASSERTED;
    const now = new Date().toISOString();
    const messageId = cleanText(options.messageId);

    return {
      entry: {
        // 稳定身份 + 时效：新建即 active，validFrom 就是落库时间。
        id: issuedId(),
        status: STATUS_ACTIVE,
        content,
        type,
        keywords,
        confidence,
        validFrom: cleanText(options.validFrom) || now,
        validTo: cleanText(options.validTo),
        supersededBy: null,
        // 归属 + 撤回锚点合成一条贡献。不再平铺 sourceQuote/sessionId，
        // 合并时才能只追加贡献、不覆盖原会话的归属与原话锚点。
        contributions: [
          {
            sessionId: cleanText(sessionId),
            sourceQuote,
            createdAt: now,
            sourceType: 'user',
            ...(messageId ? { messageId } : {}),
          },
        ],
        createdAt: now,
        updatedAt: now,
        sourceType: 'user',
        provenance: inferred
          ? PROVENANCE.MODEL_INFERRED
          : PROVENANCE.USER_ASSERTED,
        uncertainty,
        intent: options.intent || 'auto',
        targetId: cleanText(options.targetId),
        eventAt: cleanText(options.eventAt),
        condition: cleanText(options.condition),
        requiresConfirmation: options.requiresConfirmation === true,
      },
      reason: null,
      anchorScore,
      grounding,
    };
  } catch (error) {
    console.error(
      'Memory extraction error:',
      error.message
    );

    return skip('model_error');
  }
}


module.exports = {
  injectExtractionDeps,
  HEDGE_PENDING_MARK,
  MEMORY_ENABLED,
  MEMORY_TRIGGER,
  pendingMemoryIntents,
  ID_PREFIX_DERIVED,
  ID_PREFIX_ISSUED,
  pendingMemoryIntentKey,
  derivedId,
  issuedId,
  stampIdentity,
  isActive,
  shouldProcessMemory,
  OBSERVER_TRIGGER,
  OBSERVER_EVERY_TURN,
  EXTRACT_INPUT_MAX,
  getObserverMode,
  ANCHOR_MIN,
  ANCHOR_FALLBACK_MIN,
  KEYWORD_GROUNDING_MIN,
  MEMORY_SKIP_REASONS,
  skip,
  reportSkip,
  keywordGrounding,
  normalizeContribution,
  normalizeEntry,
  ensureUniqueIds,
  mergeContributions,
  cloneEntry,
  shareKeyword,
  parseModelJson,
  extractMemory,
};
