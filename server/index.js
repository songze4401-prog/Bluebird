/* global __dirname */
const path = require('path');
require('dotenv').config({ path: path.join(__dirname, '.env') });

const express = require('express');
const cors = require('cors');
// 版本号单一来源：package.json。GET / 不再自带一份会漂移的字面量。
const { version: SERVER_VERSION } = require('../package.json');
const retrieval = require('./retrieval');
const { createRetrievalRouter } = require('./retrieval/routes');
const { createAgentRouter } = require('./agents/routes');
const agentRuntime = require('./agents/runtime');
const orchestrationChat = require('./orchestration-chat');
const agentApprovals = require('./agents/approvals');
const toolWorkspace = require('./tool-workspace');
const workspacePending = require('./workspace-pending');

// 生产级可观测性：独立模块 + 只读查询 API。记录失败绝不影响主业务；
// BLUEBIRD_MONITORING=0 可关闭，前端会显示 disabled 而不是健康。
const monitoring = require('./monitoring');
const { createMonitoringRouter } = require('./monitoring/routes');

// 模型客户端统一由 model-adapter.js 按服务商配置创建（内置 DeepSeek 从
// DEEPSEEK_API_KEY 派生）。缺 key 时服务照常启动（管理接口可用），
// /chat 返回明确提示，而不是模块加载即崩溃。

const app = express();
const PORT = process.env.PORT || 3000;

// 统一错误体：{ error: 中文短句, code: 机器可读码 }。
// 前端 ApiError 直接读这两个字段（lib/api/errors.ts），不再各自拼文案。
// 503 = 服务当前不可用但没坏（存储只读、限流锁定）；500 只留给真正的内部错误。
function storeUnavailable(res, message) {
  return res.status(503).json({ error: message, code: 'store_unavailable' });
}

// CORS 只放行显式来源；原生客户端/curl 不携带 Origin，不受影响。
// 默认仅本地 Expo Web 开发端口，生产必须用 BLUEBIRD_CORS_ORIGINS 配置。
const DEFAULT_CORS_ORIGINS = [
  'http://localhost:8081',
  'http://127.0.0.1:8081',
  'http://localhost:19006',
  'http://127.0.0.1:19006',
];
const CORS_ALLOWED_ORIGINS = (() => {
  const raw = process.env.BLUEBIRD_CORS_ORIGINS;
  const list = (typeof raw === 'string' ? raw : '')
    .split(',')
    .map(item => item.trim())
    .filter(Boolean);
  return new Set(list.length ? list : DEFAULT_CORS_ORIGINS);
})();

function isAllowedCorsOrigin(origin) {
  return Boolean(origin) && CORS_ALLOWED_ORIGINS.has(origin);
}

// 不在允许列表的浏览器来源直接 403，避免把 CORS 配置错误伪装成业务错误。
app.use((req, res, next) => {
  const origin = req.headers.origin;
  if (origin && !isAllowedCorsOrigin(origin)) {
    return res.status(403).json({ error: 'Origin 不在允许列表' });
  }
  next();
});
app.use(
  cors({
    origin(origin, callback) {
      if (!origin || isAllowedCorsOrigin(origin)) {
        callback(null, origin || false);
        return;
      }
      callback(null, false);
    },
    methods: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'],
    allowedHeaders: ['Content-Type', 'Authorization', 'X-Requested-With'],
    maxAge: 600,
  })
);

// 简单内存限流：客户端 bundle 里必然带 EXPO_PUBLIC_ token（纯前端无法隐藏），
// 这是缓解 token 泄露后被暴力/盗刷的基本防线。按 IP 限频，不能靠旋转
// Authorization 换桶绕过；认证失败另有独立锁定计数。
const RATE_LIMIT_WINDOW = 60 * 1000;
const AUTH_FAILURE_WINDOW = 5 * 60 * 1000;
const AUTH_FAILURE_MAX = 10;
const rateBuckets = new Map();
const authFailures = new Map();

function clientIp(req) {
  return req.ip || req.socket.remoteAddress || 'unknown';
}

function rateLimit({ maxPerWindow = 60 } = {}) {
  return (req, res, next) => {
    const key = clientIp(req);
    const now = Date.now();
    const bucket = rateBuckets.get(key);

    if (!bucket || now - bucket.start > RATE_LIMIT_WINDOW) {
      rateBuckets.set(key, { start: now, count: 1 });
      return next();
    }

    if (bucket.count >= maxPerWindow) {
      res.set('Retry-After', String(Math.ceil((bucket.start + RATE_LIMIT_WINDOW - now) / 1000)));
      return res.status(429).json({ error: '请求过于频繁，请稍后再试' });
    }

    bucket.count++;
    next();
  };
}

app.use(rateLimit());

// 鉴权必须先于 body 解析：未认证请求即使带 8MB JSON 也不会进入 body-parser。
// 只放行根路径（版本探测）与 CORS 预检；所有业务路由仍保留各自的 requireAuth。
app.use((req, res, next) => {
  if (req.method === 'OPTIONS') return next();
  if (req.method === 'GET' && req.path === '/') return next();
  return requireAuth(req, res, next);
});

// 图片上传路由单独放宽 body limit（base64 比原图大约 33%，5MB 图约 6.7MB）。
// 必须注册在全局 1mb parser 之前：body-parser 按注册顺序消费请求体，
// 反序的话大 body 会先被全局限制拦死，路由级的 8mb 永远等不到。
// 已解析过的请求（req._body）会被后续 parser 跳过，不会解析两次。
app.use('/uploads/image', express.json({ limit: '8mb' }));
// 表情包仓库上传同理：图片以 dataURL 提交，与 uploads 共用 8mb 路由级限额
app.use('/sticker-repo', express.json({ limit: '8mb' }));
app.use(express.json({ limit: '1mb' }));

// 埋点中间件注册在 body 解析之后（需要 sessionId 生成脱敏 session_ref）。
// 监控初始化放在单实例锁之后（见文件末尾），避免被拒绝启动的实例先写监控文件。
app.use(monitoring.monitoringMiddleware());

// 统一检索：查询只读，摄取/删除/重建写索引；全部复用 Bearer 鉴权与全局限流。
app.use('/retrieval', createRetrievalRouter({ requireAuth }));
// Memory Bot：独立配置/凭证/会话/任务；写操作复用 Bearer 鉴权与全局限流。
app.use(createAgentRouter({ requireAuth, auditAction }));
// 只读监控 API：复用现有 Bearer 鉴权与全局限流；没有任何写接口。
app.use('/monitoring', createMonitoringRouter({ requireAuth }));

// 定期清理过期限流桶，防止内存无限增长
setInterval(() => {
  const now = Date.now();
  for (const [key, bucket] of rateBuckets) {
    if (now - bucket.start > RATE_LIMIT_WINDOW) rateBuckets.delete(key);
  }
  for (const [key, failure] of authFailures) {
    if (now - failure.start > AUTH_FAILURE_WINDOW) authFailures.delete(key);
  }
}, RATE_LIMIT_WINDOW).unref();

function getTimeContext(timeZone) {
  const tz = typeof timeZone === 'string' && timeZone.trim()
    ? timeZone
    : 'UTC';

  try {
    const parts = new Intl.DateTimeFormat('zh-CN', {
      timeZone: tz,
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      weekday: 'short',
      hour12: false,
    }).formatToParts(new Date());

    const v = Object.fromEntries(
      parts.filter(x => x.type !== 'literal').map(x => [x.type, x.value])
    );

    const hour = Number(v.hour);
    const period =
      hour < 6 ? '凌晨' :
      hour < 12 ? '上午' :
      hour < 14 ? '中午' :
      hour < 18 ? '下午' :
      hour < 23 ? '晚上' : '深夜';

    return `【当前时间】
${v.year}年${v.month}月${v.day}日 ${v.weekday} ${v.hour}:${v.minute}
时间段：${period}`;
  } catch {
    return '【当前时间】暂时无法确定';
  }
}

function tokenMatches(provided, expected) {
  const { timingSafeEqual } = require('crypto');
  const actual = Buffer.from(String(provided || ''));
  const wanted = Buffer.from(String(expected || ''));
  if (!wanted.length) return false;
  if (actual.length !== wanted.length) {
    // 长度不同也走一次恒定时间比较，避免用长度快速探测 token。
    timingSafeEqual(wanted, wanted);
    return false;
  }
  return timingSafeEqual(actual, wanted);
}

function requireAuth(req, res, next) {
  const expected = process.env.BLUEBIRD_API_TOKEN;
  const auth = req.headers.authorization || "";
  const token = auth.startsWith("Bearer ") ? auth.slice(7) : "";

  if (!expected || !tokenMatches(token, expected)) {
    const key = clientIp(req);
    const now = Date.now();
    let failure = authFailures.get(key);
    if (!failure || now - failure.start > AUTH_FAILURE_WINDOW) {
      failure = { start: now, count: 0 };
    }
    failure.count += 1;
    authFailures.set(key, failure);
    res.set('WWW-Authenticate', 'Bearer');
    if (failure.count > AUTH_FAILURE_MAX) {
      res.set(
        'Retry-After',
        String(Math.ceil((failure.start + AUTH_FAILURE_WINDOW - now) / 1000))
      );
      return res.status(429).json({ error: '认证失败次数过多，请稍后再试' });
    }
    return res.status(401).json({ error: "Unauthorized" });
  }

  authFailures.delete(clientIp(req));
  next();
}

// 高风险数据操作审计：只记录动作、对象类别、结果、操作者/会话的哈希引用，
// 不记录任何数据正文、路径或令牌原文。监控未启用时为 no-op。
function auditAction(
  req,
  action,
  { target = 'system', result = 'success', sessionId = null, reason = null } = {}
) {
  try {
    monitoring.recordAudit({
      action,
      target,
      result,
      reason,
      actorRef: monitoring.actorRefFor(req.headers.authorization),
      sessionRef: monitoring.sessionRefFor(sessionId),
    });
  } catch (_) {
    /* 审计失败不影响主业务 */
  }
}


const {
  processMemory,
  clearMemories,
  clearSessionMemories,
  recallMemoryBySourceQuote,
  getMemoriesForUser,
  getPendingMemoriesForUser,
  confirmPending,
  rejectPending,
  archiveMemory,
  deleteMemory,
  verifyStoreConsistency,
  getWriteOutcomes,
} = require('./memory');

const { logDataEvent } = require('./data-events');
const { buildProfile, applyProfileFeedback } = require('./profile');

const {
  getEmotion,
  buildEmotionContext,
  applyTimeDecay,
  applyObservation,
} = require('./emotion');

const crypto = require('crypto');

// 多会话存储：会话列表 / 新建会话 / 按会话读写消息 / 旧数据迁移
// 全部收在 sessions.js，index.js 只负责路由与请求编排。
const {
  DEFAULT_SESSION_ID,
  HISTORY_PAGE_MAX,
  HISTORY_PAGE_DEFAULT,
  getHistoryPage,
  listSessions,
  getSessionForUser,
  checkSessionOwnership,
  createSession,
  getMessages,
  appendMessagesDetailed,
  replaceMessages,
  getAllMessages,
  deleteSession,
} = require('./sessions');

// 在线状态感知：用户活跃状态与「Blue 等待用户回复」分开记录，
// 独立存于 presence.json，不触碰会话、记忆、情绪数据。
const {
  recordReport: recordPresenceReport,
  recordUserMessage: recordPresenceUserMessage,
  recordBlueMessage: recordPresenceBlueMessage,
  resetSessionWait,
  forgetSession,
  getPresence,
} = require('./presence');

// 人格面板配置：独立存于 persona.json，每次 /chat 读取当前值翻译成风格规则。
const {
  DEFAULTS: PERSONA_DEFAULTS,
  CUSTOM_PROMPT_MAX_CHARS: PERSONA_CUSTOM_PROMPT_MAX_CHARS,
  SYSTEM_PROMPT_MAX_CHARS: PERSONA_SYSTEM_PROMPT_MAX_CHARS,
  getConfig: getPersonaConfig,
  saveConfig: savePersonaConfig,
  resetConfig: resetPersonaConfig,
} = require('./persona');

// 内置后端提示词：用户未自定义时使用；控制面板读取/重置也以它为准。
const { BLUEBIRD_SYSTEM_PROMPT } = require('./blue-system-prompt');

// 回复分段：默认一条消息；只有超过单条硬上限才按语义边界分片（纯函数）。
const { splitReplyIntoSegments, DEFAULT_MAX_CHARS } = require('./split-reply');

// 聊天文本/解析/格式化纯函数簇：R3a 自本文件迁出（server/chat-text.js），
// 经解构回注保持调用点零改动。
const {
  MAX_ATTACHMENTS,
  REPLY_MAX_CHARS,
  STICKER_SYNTAX,
  STICKER_GUIDANCE,
  orchestrationPromptAppendix,
  withOrchestrationAppendix,
  evaluateAgentGate,
  agentStopReply,
  auditChatReply,
  estimateAgentToolsReserve,
  isImageAttachment,
  attachmentDataUrl,
  renderProjectedHistoryMessage,
  parseReplyAttachments,
  buildAssistantReplyText,
  buildTimeGapContext,
  gapSemanticLabel,
  buildPersonaPrompt,
} = require('./chat-text');

// ---- 路由族（健康度审计 R3b：按域拆出，deps 显式注入）----
const { createSessionsRouter } = require('./routes/sessions');
const { createUploadsRouter } = require('./routes/uploads');
const { createModelProvidersRouter } = require('./routes/model-providers');
const { createMemoryRouter } = require('./routes/memory');

// 多模态图片模块：上传校验 / 存储 / 读取 / 表情包索引
const {
  UploadError,
  KIND_STICKER,
  saveImage,
  getImageMeta,
  readImageBuffer,
  listStickers,
  deleteImage,
} = require('./uploads');

// 表情包仓库：用户与 AI 共享的自包含模块（sha256 去重 / 物理删除 / 候选列表）。
// 不依赖 uploads.js；聊天消息里的 sticker 附件直接引用仓库 ID。
const {
  StickerRepoError,
  SEMANTIC_AUTO: STICKER_SEMANTIC_AUTO,
  MAX_CANDIDATES: STICKER_MAX_CANDIDATES,
  addSticker,
  getSticker,
  listStickers: listStickerRepo,
  updateSticker,
  deleteSticker,
  countStickers,
  readStickerImage,
  buildStickerCandidates,
  formatCandidateLine,
  generateStickerSemantic,
} = require('./sticker-repo');

// 多服务商 / 多模型配置：持久化在 api-configs.js（元数据与密钥分离存储），
// 网络调用与 SSRF 防护在 model-adapter.js。内置 DeepSeek 服务商从环境变量
// 派生，默认服务商/模型即内置 DeepSeek——升级后无需任何重新配置。
const {
  BUILTIN_PROVIDER_ID,
  listModelProviders,
  getModelProvider,
  getDefaults,
  isConfigCorrupted,
  addModelProvider,
  updateModelProvider,
  deleteModelProvider,
  setDefaultModel,
  setProviderEnabled,
} = require('./api-configs');

const {
  ModelCallError,
  assertPublicUrl,
  resolveTarget,
  resolveVisionTarget,
  createChatCompletion,
  supportsTools,
  classifyError,
  testProviderConnection,
  invalidateProviderCache,
  getMemoryClient,
} = require('./model-adapter');

// Agent 工作策略：独立于人格，服务端策略文件为唯一事实来源。
const {
  DEFAULTS: AGENT_POLICY_DEFAULTS,
  LIMITS: AGENT_POLICY_LIMITS,
  getPolicy: getAgentPolicy,
  getMeta: getAgentPolicyMeta,
  getPolicyForRequest: getAgentPolicyForRequest,
  savePolicy: saveAgentPolicy,
  resetPolicy: resetAgentPolicy,
} = require('./agent-policy');

// Agent 工具调用（V1）：工具注册、多轮循环与开关判定都在 agent-runtime。
// 默认关闭，只有 BLUEBIRD_AGENT_TOOLS=1 且模型声明 tools 能力时才启用。
const {
  runAgentTurn,
  agentToolsEnabled,
  noteSwitchObservation,
  listToolSpecs,
  listToolMetadata,
  MAX_ROUNDS,
  TOOL_TIMEOUT_DEFAULT,
} = require('./agent-runtime');

// Context Runtime v3：唯一上下文链路（无兼容双路径）。
const { runContextRuntime } = require('./context/engine');
const { resolveUserId } = require('./user-scope');
const {
  projectStoredMessages,
} = require('./context/projection');
const { config: contextConfig } = require('./context/config');

// 情绪标签剥离：全量（/chat）与增量（/chat/stream）共用同一套规则。
const { stripMoodTags, createMoodTagStripper } = require('./stream-strip');

// 单实例守卫：必须在 listen 之前、且必须在路由注册之后调用，
// 这样被测试 require 时不会先抢锁再崩，而是走到 listen 拦截那里正常起来。
const {
  acquireSingleInstance,
  installShutdownHooks,
} = require('./single-instance');

// 解析请求里的会话 id：显式传入则用显式值，未传则落到「默认会话」。
// 这样旧客户端（不带 sessionId）的 /chat、/history 行为与改造前完全一致。
function resolveSessionId(req, source) {
  const raw =
    source === 'query'
      ? req.query && req.query.sessionId
      : req.body && req.body.sessionId;

  const value = typeof raw === 'string' ? raw.trim() : '';

  return value || DEFAULT_SESSION_ID;
}

// ============ 多模态（图片 / 表情包）辅助 ============

// 表情包发送语法（V1 候选列表模式）：仓库非空时与候选列表一起注入。
// 关键规则——只能使用候选列表里的 ID，从机制上杜绝编造不存在的表情包。

// 清理类接口的确认闸门（D-2）。
// clear 会整体清空数据：此前"数据目录位于系统临时目录"就直接放行，于是容器化
// 或临时部署的真实实例会静默失去二次确认（审计 P3-12）。现在确认与否只取决于
// 请求方是否显式声明 intent（body.confirm === true），与目录位置无关：
// 前端在用户点确认后本来就带这个字段，能力不受影响。
// 返回 null 表示允许；否则返回拒绝原因。
function clearGuardError(req) {
  if (req.body && req.body.confirm === true) return null;

  return '该操作会清空数据，需要二次确认（请求体传 confirm: true）';
}

// 多模态附件回收：撤回 / 清理消息后，删掉不再被任何消息引用的图片文件。
// 同一张图被多个消息引用（重发）时不会误删；删文件失败只记日志，
// 不影响撤回/清理本身的结果（消息已删，孤儿文件可后续手动清理）。
function releaseOrphanAttachments(attachmentsList) {
  const candidates = new Set();

  for (const attachments of attachmentsList) {
    if (!Array.isArray(attachments)) continue;
    for (const item of attachments) {
      if (item && typeof item.id === 'string') candidates.add(item.id);
    }
  }

  if (!candidates.size) return [];

  const referenced = new Set();
  for (const message of getAllMessages()) {
    if (!message || !Array.isArray(message.attachments)) continue;
    for (const item of message.attachments) {
      if (item && typeof item.id === 'string') referenced.add(item.id);
    }
  }

  const removed = [];
  for (const id of candidates) {
    if (referenced.has(id)) continue;
    try {
      if (deleteImage(id)) removed.push(id);
    } catch (error) {
      console.error('Orphan image cleanup error:', id, error.message);
    }
  }
  return removed;
}

// ---- 路由族（健康度审计 R3b：按域拆出，deps 显式注入）----
app.use(createSessionsRouter({
  requireAuth,
  resolveSessionId,
  auditAction,
  storeUnavailable,
  clearGuardError,
  releaseOrphanAttachments,
}));
app.use(createUploadsRouter({ requireAuth, auditAction }));
app.use(createModelProvidersRouter({ requireAuth, auditAction }));
app.use(createMemoryRouter({
  requireAuth,
  resolveUserId,
  auditAction,
  clearGuardError,
}));

app.get('/', (req, res) => {
  res.json({
    name: 'Bluebird API',
    status: 'online',
    version: SERVER_VERSION,
  });
});

// ---- 会话管理 ----

// 会话列表：按最近活跃（updatedAt）倒序；只列本人的会话
app.get('/emotion', requireAuth, (req, res) => {
  try {
    res.json(getEmotion());
  } catch (error) {
    console.error('Emotion API Error:', error);
    res.status(500).json({ error: '读取情绪状态失败' });
  }
});

// ---- 在线状态（Presence V1） ----

// 客户端上报：前后台切换、心跳、用户互动。三类信息都走同一个接口，
// 重复请求按 eventId 去重，乱序到达的旧事件不会回滚状态。
app.post('/presence/report', requireAuth, (req, res) => {
  try {
    const body = req.body || {};
    const appState = body.appState;
    const heartbeat = body.heartbeat === true;
    const interaction = body.interaction === true;

    if (
      appState !== undefined &&
      appState !== 'foreground' &&
      appState !== 'background'
    ) {
      return res.status(400).json({
        error: 'appState 只能是 foreground 或 background',
      });
    }

    if (!appState && !heartbeat && !interaction) {
      return res.status(400).json({ error: '缺少状态上报内容' });
    }

    if (
      body.eventId !== undefined &&
      (typeof body.eventId !== 'string' || !body.eventId.trim())
    ) {
      return res.status(400).json({ error: 'eventId 必须是非空字符串' });
    }

    if (
      body.occurredAt !== undefined &&
      (typeof body.occurredAt !== 'string' ||
        Number.isNaN(Date.parse(body.occurredAt)))
    ) {
      return res.status(400).json({ error: 'occurredAt 必须是合法时间' });
    }

    if (body.sessionId !== undefined && typeof body.sessionId !== 'string') {
      return res.status(400).json({ error: 'sessionId 必须是字符串' });
    }

    // 只接受真实存在且属于本人的会话，避免上报把等待状态写到任意 id 上
    const requested = typeof body.sessionId === 'string' ? body.sessionId.trim() : '';
    const sessionId =
      requested && getSessionForUser(requested, resolveUserId(req)) ? requested : null;

    const result = recordPresenceReport(
      {
        appState: appState || null,
        heartbeat,
        interaction,
        eventId:
          typeof body.eventId === 'string' ? body.eventId.trim() : null,
        occurredAt: body.occurredAt,
        sessionId,
      },
      Date.now()
    );

    res.json({
      ok: true,
      duplicate: result.duplicate,
      presence: result.presence,
    });
  } catch (error) {
    console.error('Presence report error:', error);
    res.status(500).json({ error: '状态上报失败' });
  }
});

// 读取当前状态快照：用户活跃状态 + 指定会话的 Blue 等待回复状态。
app.get('/presence', requireAuth, (req, res) => {
  try {
    const sessionId = resolveSessionId(req, 'query');

    if (!getSessionForUser(sessionId, resolveUserId(req))) {
      return res.status(404).json({ error: '会话不存在' });
    }

    res.json({ presence: getPresence(sessionId, Date.now()) });
  } catch (error) {
    console.error('Presence API Error:', error);
    res.status(500).json({ error: '读取在线状态失败' });
  }
});

// 人格面板：读取当前配置 + 服务端默认值（前端「恢复默认」以此为准）
// + 字段上限（前端字数提示与服务端校验共用同一个数，避免两处写死漂移）。
app.get('/persona', requireAuth, (req, res) => {
  const config = getPersonaConfig();

  res.json({
    config,
    defaults: PERSONA_DEFAULTS,
    limits: {
      customPromptMaxChars: PERSONA_CUSTOM_PROMPT_MAX_CHARS,
      systemPromptMaxChars: PERSONA_SYSTEM_PROMPT_MAX_CHARS,
    },
    // 后端提示词：default 是代码内置版本，effective 是下一轮实际注入的版本。
    // 用户清空自定义时 effective 会回退到 default，面板据此展示真实内容。
    systemPrompt: {
      default: BLUEBIRD_SYSTEM_PROMPT,
      effective: config.systemPrompt || BLUEBIRD_SYSTEM_PROMPT,
      customized: Boolean(config.systemPrompt),
    },
  });
});

// 保存人格配置：{ config: {...} } 整体覆盖；{ reset: true } 恢复服务端默认。
// 三态错误码：400 校验失败（旧配置与编辑内容都不丢）、409 文件损坏原地保护、
// 500 落盘失败。customPrompt 是用户自填文本，长度/类型超限一律整份拒绝。
app.put('/persona', requireAuth, (req, res) => {
  const body = req.body || {};
  const result =
    body.reset === true ? resetPersonaConfig() : savePersonaConfig(body.config);

  if (!result.ok) {
    if (result.code === 'invalid_config') {
      return res.status(400).json({ error: result.error, code: result.code });
    }

    if (result.code === 'persona_file_corrupted') {
      return res.status(409).json({ error: result.error, code: result.code });
    }

    return res.status(500).json({ error: result.error, code: result.code });
  }

  res.json({ config: result.config });
});

// Agent 工作策略：GET 返回服务端策略、默认值、版本摘要与已注册工具；
// PUT 整体保存或 reset:true 恢复默认。策略文件损坏时由模块安全回退默认并
// 拒绝不安全覆盖，路由只返回受控错误码。
app.get('/agent-policy', requireAuth, (req, res) => {
  try {
    res.json({
      policy: getAgentPolicy(),
      defaults: AGENT_POLICY_DEFAULTS,
      meta: getAgentPolicyMeta(),
      limits: AGENT_POLICY_LIMITS,
      runtimeLimits: { maxRounds: MAX_ROUNDS },
      runtime: {
        // 只读状态：UI 可以展示，不能通过本接口改写服务端环境开关。
        switchOn: agentToolsEnabled(),
        maxRounds: MAX_ROUNDS,
        toolTimeoutDefaultMs: TOOL_TIMEOUT_DEFAULT,
        imageRequestsDisableTools: true,
      },
      availableTools: listToolMetadata(),
    });
  } catch (_) {
    res.status(500).json({ error: '读取 Agent 策略失败', code: 'policy_read_failed' });
  }
});

app.put('/agent-policy', requireAuth, (req, res) => {
  const body = req.body || {};
  const outcome =
    body.reset === true
      ? resetAgentPolicy()
      : saveAgentPolicy(body.policy !== undefined ? body.policy : body.config);

  if (!outcome.ok) {
    if (outcome.code === 'policy_file_corrupted') {
      return res.status(409).json({ error: outcome.error, code: outcome.code });
    }
    if (outcome.code === 'invalid_policy') {
      return res.status(400).json({
        error: outcome.error,
        code: outcome.code,
        details: Array.isArray(outcome.errors) ? outcome.errors : [],
      });
    }
    return res.status(500).json({ error: outcome.error || '保存 Agent 策略失败', code: outcome.code });
  }

  res.json({ policy: outcome.policy, meta: outcome.meta });
});

// 记忆库：删除单条记忆。优先用稳定 id，旧的 createdAt + content 定位继续支持。
// ---- /chat 与 /chat/stream 共享的内部流程 ----
// 两条路由的差异只在模型调用方式（一次性 / 流式）与响应形式（JSON / SSE），
// 前置校验、上下文组装、清洗分条、落盘、presence、记忆提取完全一致。

// 前置：解析参数 + 校验 + 组装 systemPrompt。
// 校验失败返回 { error: [status, body] }，路由直接回 JSON（此时未切 SSE）；
// 成功返回 { ctx }。
async function prepareChatRequest(req) {
  // 每个聊天请求一个 requestId：贯穿上下文 trace、日志、记忆提取与响应，
  // 便于把「主控检索 → 过滤 → 注入 → 写入」整条链路的日志串起来排查。
  const requestId = `req_${crypto.randomUUID()}`;
  const { message, history = [], attachmentIds, stickerIds } = req.body;
  const sessionId = resolveSessionId(req, 'body');
  // 可信用户身份：只从服务端身份解析，绝不读 req.body/query 里的 userId。
  // 长期记忆的读作用域用它（用户级），会话作用域仍用于消息与任务状态。
  const userId = resolveUserId(req);

  // 多模态附件：引用已上传图片的 id（POST /uploads/image 返回值）。
  const attachments = [];

  {
    const rawIds = Array.isArray(attachmentIds) ? attachmentIds : [];

    if (rawIds.length > MAX_ATTACHMENTS) {
      return {
        error: [400, { error: `单条消息最多携带 ${MAX_ATTACHMENTS} 张图片` }],
      };
    }

    for (const rawId of rawIds) {
      const meta = getImageMeta(String(rawId || ''));

      if (!meta) {
        return {
          error: [400, { error: `图片不存在或已失效：${rawId}` }],
        };
      }

      attachments.push(meta);
    }

    // 表情包消息：引用仓库 ID（POST /sticker-repo 返回值）。
    // 与临时图片共用同一个 attachments 数组与同一条数量上限，
    // 消息结构对前端统一（kind==='sticker' 走仓库图片接口）。
    const rawStickerIds = Array.isArray(stickerIds) ? stickerIds : [];

    if (rawStickerIds.length + rawIds.length > MAX_ATTACHMENTS) {
      return {
        error: [
          400,
          { error: `单条消息最多携带 ${MAX_ATTACHMENTS} 个图片或表情包` },
        ],
      };
    }

    for (const rawId of rawStickerIds) {
      const entry = getSticker(String(rawId || ''));

      if (!entry) {
        return {
          error: [400, { error: `表情包不存在：${rawId}` }],
        };
      }

      attachments.push({
        id: entry.id,
        kind: KIND_STICKER,
        mime: entry.mime,
        name: entry.name,
      });
    }
  }

  // 纯发图（无文字）合法：有附件时放空文本校验
  if (!attachments.length && (typeof message !== 'string' || !message.trim())) {
    return { error: [400, { error: '消息不能为空' }] };
  }

  // 会话必须已存在且属于本人：跨会话或未知会话一律拒绝，保证严格隔离
  if (!getSessionForUser(sessionId, resolveUserId(req))) {
    return { error: [404, { error: '会话不存在' }] };
  }

  // message 非字符串且无附件时已在上面 400；这里兼容纯发图场景
  const userText = typeof message === 'string' ? message.trim() : '';

  // 用户消息 id 在模型回合之前生成：Agent 工具（tasks.createTask 的
  // parentMessageId、memory_remember 的 messageId）要引用这条消息，
  // id 必须先于工具调用存在。落盘时复用同一个 id（completeChatTurn）。
  const userMessageId = crypto.randomUUID();

  // 上下文历史以服务端存储为准：不同会话严格隔离，客户端就算传来别的
  // 会话的历史也不会串进来。图片消息在这里转成模型可用的形态。
  const storedItems = getMessages(sessionId) || [];

  // 会话加载证据：只记录条数，不记录任何消息正文或原始会话 ID。
  monitoring.recordSessionLoaded({ messageCount: storedItems.length });

  // 历史里只有 user 消息会产生 image blocks（AI 的图片/表情包本就降级为文本），
  // 所以只统计用户图片；它决定目标模型能否承载完整上下文。
  const historyHasUserImages = storedItems.some(
    item =>
      item &&
      item.role === 'user' &&
      Array.isArray(item.attachments) &&
      item.attachments.some(isImageAttachment)
  );

  // 模型目标解析（多服务商）：
  // 1) 请求级 providerId/modelId 优先——前端每次聊天都带上当前所选模型；
  // 2) 两者都缺省时回退到服务端全局默认模型（兼容旧客户端，行为与改造前一致）；
  // 3) 缺失/无效/已禁用的服务商或模型一律明确报错，绝不静默改用其他文本模型。
  // 请求级选择只影响本次请求，不写回全局默认配置（resolveTarget 纯读）。
  const requestedProviderId =
    typeof req.body.providerId === 'string' ? req.body.providerId.trim() : '';
  const requestedModelId =
    typeof req.body.modelId === 'string' ? req.body.modelId.trim() : '';

  let modelTarget;

  try {
    modelTarget = resolveTarget({
      providerId: requestedProviderId || undefined,
      modelId: requestedModelId || undefined,
    });
  } catch (error) {
    const info = classifyError(error);
    return {
      error: [info.status, { error: info.error, code: info.code }],
    };
  }

  // 解析成功后先记下「用户所选模型」：它是自动路由提示里要展示的对照目标
  const selectedTarget = modelTarget;

  // 图片能力路由：所选模型未声明视觉能力时，沿用现有的能力路由
  // （同一服务商内挑默认视觉模型，其次第一个启用的视觉模型），
  // 并把实际使用的模型如实回报给前端——绝不把纯文本模型当成「看过图」。
  // 服务商没有可用视觉模型时明确报错，不跨服务商乱跳，也不静默降级。
  let visionAutoRouted = false;

  if (attachments.length && modelTarget.model.capabilities?.vision !== true) {
    try {
      const visionTarget = resolveVisionTarget({
        providerId: modelTarget.providerId,
      });

      visionAutoRouted = visionTarget.modelId !== modelTarget.modelId;
      modelTarget = visionTarget;
    } catch (error) {
      const info = classifyError(error);
      return {
        error: [info.status, { error: info.error, code: info.code }],
      };
    }
  }

  // 本次请求新上传的图片。Agent 工具互斥只看这个变量；
  // 历史图片不再单独关闭 Agent。
  const hasNewImage = attachments.some(isImageAttachment);

  // 历史图片只在目标模型声明视觉能力时才随上下文上行；否则降级为文本占位，
  // 保证「选哪个模型就用哪个模型」，不因历史图片被迫换模型。
  const includeHistoryImages =
    historyHasUserImages && modelTarget.model.capabilities?.vision === true;

  const useVision = hasNewImage || includeHistoryImages;

  // B1：客户端历史回退只对「默认会话」开放。
  // 服务端存储是权威来源；默认会话存储为空时沿用旧客户端历史，
  // 具名会话即使为空也绝不注入客户端传来的其他会话历史。
  const historySourceItems =
    storedItems.length || sessionId !== DEFAULT_SESSION_ID
      ? storedItems
      : Array.isArray(history)
        ? history
        : [];

  const projectedHistory = projectStoredMessages(historySourceItems, {
    sessionId,
  });

  const memoryQuery = userText;

  const timeContext = getTimeContext(req.body.timeZone || 'Asia/Shanghai');
  const gapContext = buildTimeGapContext(
    req.body.timeZone || 'Asia/Shanghai',
    sessionId
  );

  // 情绪惯性：先做时间衰减，再生成情绪上下文。
  // E3：衰减基于"全局上次衰减检查时间"（emotion 模块内部维护），
  // 不再使用当前会话的 gapSeconds —— 切换旧会话不会额外衰减全局情绪。
  applyTimeDecay();
  const emotionContext = buildEmotionContext();

  // 人格面板：每轮读取当前配置（用户可能刚在面板里改过），翻译成风格规则
  const personaConfig = getPersonaConfig();
  const personaContext = buildPersonaPrompt(personaConfig);

  console.log(
    `Time gap: ${gapContext.timeContext}` +
      (gapContext.gapSeconds != null ? ` (${gapContext.gapSeconds}s)` : '')
  );

  // 多模态上下文说明：STICKER_GUIDANCE 仅在本次会话涉及图片时注入；
  // 纯文本请求在无表情包仓库时 system prompt 与改造前逐字节一致。
  const visionInstructions = [];

  if (useVision) {
    if (attachments.some(att => att.kind === KIND_STICKER)) {
      visionInstructions.push(STICKER_GUIDANCE);
    }
  }

  // AI 候选列表（V1）：按当前情绪打分取前 N 条（上限 STICKER_MAX_CANDIDATES），
  // 仓库非空即注入。注入后纯文本会话的 AI 也能主动发表情包——"是否发、
  // 发哪一个"由模型按对话情境判断，prompt 规则约束不硬发；
  // 后端只校验 ID 真实性（parseReplyAttachments），编造的 ID 一律忽略。
  // 候选列表注入不改变模型选择：纯文本会话仍走默认文本模型。
  const stickerCandidates = buildStickerCandidates({
    emotion: getEmotion().emotion,
    limit: STICKER_MAX_CANDIDATES,
  });

  if (stickerCandidates.length) {
    visionInstructions.push(STICKER_SYNTAX);
    visionInstructions.push(
      `【可发送的表情包】\n${stickerCandidates
        .map(formatCandidateLine)
        .join('\n')}`
    );
  }

  // 当前用户消息：带附件时转成 content blocks（文本 + 图片 dataURL）。
  // 图片从服务端磁盘读取，不信任客户端传来的任何图片字节。
  let userContent = userText;

  if (attachments.length) {
    const blocks = [];
    if (userText) blocks.push({ type: 'text', text: userText });

    for (const att of attachments) {
      const dataUrl = attachmentDataUrl(att);
      if (dataUrl) {
        blocks.push({ type: 'image_url', image_url: { url: dataUrl } });
      }
    }

    if (blocks.length) userContent = blocks;
  }

  // 当前任务消息：与历史消息共用同一模型消息契约。
  const currentMessage = { role: 'user', content: userContent };

  // 基础系统块按优先级声明：core 永不裁剪；时间/表情/情绪/人格等非关键块
  // 在输入保护阶段可先让位，决策记录在 trace.build.dropped。
  // 后端提示词由用户在控制面板编辑；空值回退内置默认。
  const activeSystemPrompt = personaConfig.systemPrompt || BLUEBIRD_SYSTEM_PROMPT;

  const baseSystemBlocks = [
    {
      id: 'core',
      kind: 'core',
      priority: 100,
      critical: true,
      text: activeSystemPrompt,
    },
    ...(timeContext || gapContext.promptText
      ? [
          {
            id: 'time',
            kind: 'time',
            priority: 80,
            critical: false,
            text: [timeContext, gapContext.promptText].filter(Boolean).join('\n\n'),
          },
        ]
      : []),
    ...(emotionContext
      ? [{ id: 'emotion', kind: 'emotion', priority: 20, critical: false, text: emotionContext }]
      : []),
    ...(personaContext
      ? [{ id: 'persona', kind: 'persona', priority: 25, critical: false, text: personaContext }]
      : []),
    ...(visionInstructions.length
      ? [
          {
            id: 'sticker',
            kind: 'sticker',
            priority: 10,
            critical: false,
            text: visionInstructions.join('\n\n'),
          },
        ]
      : []),
  ];

  // Agent 工具循环会在请求内追加 tool 消息：按工具 schema + 每轮结果预留
  // 输入预算。这是保守上界；轮数仍由 agent-runtime 的 MAX_ROUNDS 控制。
  const agentPolicyState = getAgentPolicyForRequest();
  const agentPolicy = agentPolicyState.policy;
  const agentPolicyMeta = agentPolicyState.meta;
  const agentPossible = evaluateAgentGate({
    switchOn: agentToolsEnabled(),
    toolsSupported: supportsTools(modelTarget.providerId, modelTarget.modelId),
    hasNewImage,
    policyMode: agentPolicy.mode,
    policyToolCount: listToolSpecs(agentPolicy).length,
  }).allowed;
  const toolsReserveTokens = agentPossible ? estimateAgentToolsReserve() : 0;

  let contextRuntime;
  const contextBuildStartedAt = Date.now();
  const contextSpan = monitoring.startSpan('context.build', {
    history_total: projectedHistory.length,
  });
  monitoring.recordEvent({
    event_name: monitoring.EVENTS.CONTEXT_BUILD_STARTED,
    component: 'context',
    status: 'unknown',
    attributes: {
      history_total: projectedHistory.length,
    },
  });

  try {
    contextRuntime = await runContextRuntime({
      task: memoryQuery,
      sessionId,
      userId,
      requestId,
      projectedMessages: projectedHistory,
      renderMessage: item =>
        renderProjectedHistoryMessage(item, {
          includeImages: includeHistoryImages,
          placeholderImages: true,
        }),
      renderFinalMessage: item =>
        renderProjectedHistoryMessage(item, {
          includeImages: includeHistoryImages,
        }),
      systemBlocks: baseSystemBlocks,
      currentMessage,
      model: {
        providerId: modelTarget.providerId,
        modelId: modelTarget.modelId,
        contextWindow: modelTarget.model.contextWindow,
      },
      toolsReserveTokens,
      config: contextConfig,
    });
  } catch (error) {
    contextSpan.end({ status: 'failed', errorCode: 'context_runtime_error' });
    monitoring.recordContextBuild({
      runtime: {
        ok: false,
        errorCode: 'context_runtime_error',
        error: '上下文组装失败',
        trace: { stages: {}, history: {}, retrieval: {} },
        measurement: {},
        memory: { accepted: [] },
        summary: { count: 0 },
        dropped: [],
      },
      durationMs: Date.now() - contextBuildStartedAt,
    });
    monitoring.recordTask({
      status: 'failed',
      termination: 'context_runtime_error',
      durationMs: Date.now() - contextBuildStartedAt,
      errorCode: 'context_runtime_error',
    });
    console.error(
      `[context] runtime 异常 session=${sessionId}` +
        ` error=${error && error.message ? error.message : error}`
    );
    return {
      error: [500, { error: '上下文组装失败', code: 'context_runtime_error' }],
    };
  }

  contextSpan.end({
    status: contextRuntime.ok ? 'success' : 'failed',
    errorCode: contextRuntime.errorCode || null,
  });
  monitoring.recordContextBuild({
    runtime: contextRuntime,
    durationMs: Date.now() - contextBuildStartedAt,
  });

  if (!contextRuntime.ok) {
    monitoring.recordTask({
      status: 'failed',
      termination:
        contextRuntime.errorCode === 'context_too_large'
          ? 'context_rejected'
          : 'context_build_failed',
      durationMs: Date.now() - contextBuildStartedAt,
      errorCode: contextRuntime.errorCode || 'context_runtime_error',
    });
    console.error(`[context-trace] ${JSON.stringify(contextRuntime.trace)}`);
    const status = contextRuntime.errorCode === 'context_too_large' ? 413 : 500;
    return {
      error: [
        status,
        {
          error: contextRuntime.error || '上下文组装失败',
          code: contextRuntime.errorCode || 'context_runtime_error',
        },
      ],
    };
  }

  const contextTrace = contextRuntime.traceApi;
  const systemPrompt = contextRuntime.systemPrompt;
  const requestMessages = contextRuntime.messages;
  const promptHistory = contextRuntime.historyMessages;

  console.log(
    `[context] runtime session=${sessionId}` +
      ` req=${requestId}` +
      ` history=${contextRuntime.trace.history.totalMessages}` +
      ` recent=${contextRuntime.trace.history.recent}` +
      ` recalled=${contextRuntime.trace.history.recalled}` +
      ` summary=${contextRuntime.summary.count}` +
      ` memory=${contextRuntime.memory.accepted.length}/${contextRuntime.trace.retrieval.candidates}` +
      ` memStatus=${contextRuntime.memoryStatus}` +
      ` memState=${contextRuntime.memoryState}` +
      ` memError=${contextRuntime.memoryError || '-'}` +
      ` dropped=${contextRuntime.dropped.length}` +
      ` window=${contextRuntime.measurement.window.tokens}` +
      ` windowSource=${contextRuntime.measurement.window.source}` +
      ` estInput=${contextRuntime.measurement.estimatedInputTokens}` +
      ` toolsReserve=${contextRuntime.measurement.toolsReserveTokens}`
  );

  return {
    ctx: {
      requestId,
      sessionId,
      userId,
      userText,
      userMessageId,
      attachments,
      hasNewImage,
      includeHistoryImages,
      useVision,
      userContent,
      promptHistory,
      requestMessages,
      systemPrompt,
      personaConfig,
      agentPolicy,
      agentPolicyMeta,
      contextTrace,
      contextMeasurement: contextRuntime.measurement,
      contextSummary: contextRuntime.summary,
      contextDropped: contextRuntime.dropped,
      contextIds: contextRuntime.contextIds,
      // 记忆编排状态（阶段3 可观测性）：memoryState 为标准契约状态
      // （ok / empty / degraded / failed），memoryStatus 为内部检索状态。
      contextMemoryState: contextRuntime.memoryState || 'empty',
      contextMemoryStatus: contextRuntime.memoryStatus || 'no_result',
      providerId: modelTarget.providerId,
      providerName: modelTarget.provider.name,
      modelId: modelTarget.modelId,
      // 结构化路由结果（前端提示的唯一来源）：
      // requested 是本次「所选模型」（请求级 ids 优先，缺省为全局默认），
      // actual 才是真正下发的服务商/模型；auto=true 表示图片触发了能力路由。
      modelRoute: {
        requested: {
          providerId: selectedTarget.providerId,
          providerName: selectedTarget.provider.name,
          modelId: selectedTarget.modelId,
          source: requestedProviderId || requestedModelId ? 'request' : 'default',
        },
        actual: {
          providerId: modelTarget.providerId,
          providerName: modelTarget.provider.name,
          modelId: modelTarget.modelId,
        },
        auto: visionAutoRouted,
        reason: visionAutoRouted ? 'vision_unsupported' : null,
      },
    },
  };
}

// 收尾：清洗情绪标签 -> 分条 -> 落盘 -> presence。
// isClientGone 是函数：流式路由里客户端可能在生成中途断开，取值发生在收尾时刻。
// toolSteps：Agent 工具执行摘要（可选）。作为消息独立字段挂在最后一条
// assistant 消息上并随落盘保存，绝不拼进 content；普通聊天不传即零变化。
function completeChatTurn({
  ctx,
  rawReply,
  isClientGone,
  userMessageReceivedAt,
  toolSteps,
}) {
  const { sessionId, userText, userMessageId, attachments, personaConfig } = ctx;

  const { reply: cleanedReply, mood } = stripMoodTags(rawReply);

  // 图片/表情包声明解析（[sticker:ID] / [image:ID]）在情绪标签清洗之后：
  // 标记可能在正文任意位置，三级校验通过转为消息附件，不通过整段删除。
  const parsedReply = parseReplyAttachments(cleanedReply, MAX_ATTACHMENTS);

  // BUG-03：整条回复只有一个表情包标记时，剥离后正文为空；旧实现用
  // `body || cleanedReply` 兜底，把原始 [sticker:...] 又拼回正文。
  // 现在统一走兜底函数：清残留标记 → 压缩空白 → 空则补文案。
  const reply = buildAssistantReplyText(parsedReply.body, parsedReply.attachments);
  const replyAttachments = parsedReply.attachments;

  // 一条回复默认只落一条 assistant 消息；只有超过单条硬上限才按语义边界分片。
  // 旧 messageMode 仍随 persona 配置传入，但不再改变切分规则。
  const segments = splitReplyIntoSegments(reply, personaConfig.messageMode, {
    maxChars: REPLY_MAX_CHARS,
  });

  // 同步生成稳定 id 并立即返回给前端（撤回需要）；appendMessagesDetailed 会沿用已有 id。
  const now = new Date().toISOString();

  // 回复带出的图片/表情包附件挂在最后一格气泡上：阅读顺序与
  // 「先文字后表情」的自然节奏一致，历史读回时也在同一条消息里
  // Agent 工具摘要同理：只在最后一格带，前端可据此展示执行痕迹。
  const hasToolSteps = Array.isArray(toolSteps) && toolSteps.length > 0;
  const assistantMessages = segments.map((content, index) => ({
    id: crypto.randomUUID(),
    role: 'assistant',
    content,
    createdAt: now,
    ...(index === segments.length - 1 && replyAttachments.length
      ? { attachments: replyAttachments }
      : {}),
    ...(index === segments.length - 1 && hasToolSteps ? { toolSteps } : {}),
  }));

  const stamped = [
        {
          // 复用模型回合前生成的 id：Agent 工具里引用的 parentMessageId
          // 与落盘后的用户消息 id 是同一个值。
          id: userMessageId || crypto.randomUUID(),
          role: 'user',
          content: userText,
          createdAt: now,
          ...(attachments.length ? { attachments } : {}),
        },
        ...assistantMessages,
      ];

  // 本轮 [mood:] 只是"观察信号"，交给情绪系统做惯性更新后再返回当期真实状态
  const emotion = applyObservation(mood);

  // A1：落盘改到返回之前同步完成。此前是 setImmediate 异步写盘，客户端先拿到
  // 200、写失败却完全看不到；同步写还顺带消掉了同一会话并发读-改-写的毫秒级
  // 竞争（Node 单线程下这段同步代码不可被打断）。
  // 客户端已断开时不落盘，避免回复成为"幽灵消息"（用户没收到却已入库）。
  let persisted = false;
  let trimmedMessages = [];
  const persistStartedAt = Date.now();
  const persistSpan = monitoring.startSpan('persistence.write', {
    message_count: stamped.length,
  });
  monitoring.recordEvent({
    event_name: monitoring.EVENTS.PERSISTENCE_WRITE_STARTED,
    component: 'persistence',
    status: 'unknown',
    attributes: { message_count: stamped.length },
  });

  if (!isClientGone()) {
    try {
      const appended = appendMessagesDetailed(sessionId, stamped);
      persisted = !!appended.messages;
      trimmedMessages = Array.isArray(appended.trimmed) ? appended.trimmed : [];

      if (!persisted) {
        console.error(
          'History persist FAILED:',
          sessionId,
          stamped.length,
          'messages were NOT saved'
        );
      }

      persistSpan.end({
        status: persisted ? 'success' : 'failed',
        errorCode: persisted ? null : 'write_failed',
      });
      monitoring.recordPersistence({
        status: persisted ? 'success' : 'failed',
        messageCount: stamped.length,
        trimmedCount: trimmedMessages.length,
        durationMs: Date.now() - persistStartedAt,
      });
    } catch (error) {
      console.error('History save error:', error);
      persistSpan.end({ status: 'failed', errorCode: 'write_exception' });
      monitoring.recordPersistence({
        status: 'failed',
        messageCount: stamped.length,
        trimmedCount: 0,
        durationMs: Date.now() - persistStartedAt,
      });
    }
  } else {
    persistSpan.end({ status: 'skipped', errorCode: 'client_closed' });
    monitoring.recordPersistence({
      status: 'skipped',
      messageCount: stamped.length,
      trimmedCount: 0,
      durationMs: Date.now() - persistStartedAt,
    });
  }

  // 达到保留上限后裁掉的旧消息：它们的图片/表情包引用可能已无人使用。
  // 必须等落盘成功后再扫描全库；只删确认无引用的文件，清理失败不影响回复。
  if (persisted && trimmedMessages.length) {
    try {
      const removed = releaseOrphanAttachments(
        trimmedMessages.map(item => item && item.attachments)
      );
      console.log(
        `[sessions] trimmed=${trimmedMessages.length}` +
          ` session=${sessionId} releasedUploads=${removed.length}`
      );
    } catch (error) {
      console.error('Trim orphan cleanup error:', error.message);
    }
  }

  // Presence 联动：用户消息无论是否落盘都算一次真实互动；
  // Blue 的回复只有真正返回给客户端（非 clientGone）才开启等待计时。
  // 失败只记录日志，绝不影响聊天主流程。
  try {
    recordPresenceUserMessage(sessionId, userMessageReceivedAt);

    if (!isClientGone()) {
      recordPresenceBlueMessage(sessionId, Date.now());
    }
  } catch (error) {
    console.error('Presence update error:', error);
  }

  return {
    // reply 保留完整原文：旧客户端（不识 replies）显示行为不变
    reply,
    // 分条后的气泡数组：新客户端按此逐条展示；每条都是已落盘的独立消息
    replies: assistantMessages.map(
      ({ id, content, createdAt, attachments: att, toolSteps: steps }) => ({
        id,
        content,
        createdAt,
        ...(att ? { attachments: att } : {}),
        // Agent 工具执行摘要（仅最后一格可能出现）：独立字段，不含敏感内容
        ...(steps ? { toolSteps: steps } : {}),
      })
    ),
    persisted,
    mood: emotion.emotion,
    intensity: emotion.intensity,
    userMessageId: stamped[0].id,
    assistantMessageId: assistantMessages[0].id,
    // 多模态附件：前端据此展示图片/表情包，历史接口同样会返回
    userAttachments: attachments,
    assistantAttachments: replyAttachments,
    // Agent 工具执行摘要：有则随响应返回，无则整个字段不出现（旧响应零变化）
    ...(hasToolSteps ? { toolSteps } : {}),
    // 服务端统一时间，供前端展示，避免客户端时钟偏差
    createdAt: now,
  };
}

// 长期记忆提取：响应完成后异步进行，失败只记日志。
// client 取自适配层：固定内置 DeepSeek（extractMemory 内部硬编码
// deepseek-chat，与改造前逐字节一致）；没有任何可用服务商时跳过。
function scheduleMemoryExtraction(
  userText,
  sessionId,
  attachments = [],
  options = {}
) {
  setImmediate(() => {
    const memoryClient = getMemoryClient();
    if (!memoryClient) return; // 未配置任何模型 key，跳过记忆提取
    // 纯发图（无文字）时给记忆提取一个占位文本，避免空串进提取器
    const memoryText =
      userText ||
      (attachments.length
        ? `（发送了${attachments.length}张${
            attachments[0].kind === KIND_STICKER ? '表情包' : '图片'
          }）`
        : userText);
    // 提取是响应完成后的后台动作，返回值没人接就变成黑洞：
    // 这里把结论（写入/合并/更正/拒写短码）落成结构化事件，
    // 具体原因短码由 memory.js 的 reportSkip 与 writeOutcomes 记录。
    processMemory(memoryClient, memoryText, sessionId, {
      messageId: options.messageId || null,
      // 可信用户身份要一路带到 applyCandidate：否则写侧仍按会话级判定，
      // 新会话里的"改口"会被拒成 unauthorized_target。
      userId: options.userId || null,
    })
      .then(outcome => {
        if (!outcome) return;
        if (outcome.reason === 'not_triggered') return; // 普通闲聊，不值得记

        monitoring.recordMemoryWrite({
          action: outcome.action || 'none',
          status: outcome.written ? 'success' : 'skipped',
          written: outcome.written === true,
          reason: outcome.written ? null : outcome.reason,
          channel: 'extraction',
          decision: outcome.decision || null,
          detail: outcome.detail || null,
          observerMode: outcome.observerMode || null,
        });

        logDataEvent({
          module: 'memory',
          event: outcome.written
            ? 'memory_write_applied'
            : 'memory_write_skipped',
          level: 'info',
          action: outcome.action || 'none',
          reason: outcome.written ? null : outcome.reason,
          extra: {
            sessionId,
            requestId: options.requestId || null,
            written: outcome.written === true,
            id: outcome.id || null,
            supersededId: outcome.supersededId || null,
          },
        });
      })
      .catch(error => {
        monitoring.recordMemoryWrite({
          action: 'extract',
          status: 'failed',
          written: false,
          reason: error && error.name ? error.name : 'extract_failed',
        });
        logDataEvent({
          module: 'memory',
          event: 'memory_extract_failed',
          level: 'error',
          error,
          action: 'extract',
          extra: { sessionId, requestId: options.requestId || null },
        });
      });
  });
}

// 每次真正调用提供方之前记录 sent 证据：使用与 createChatCompletion 完全
// 相同的 messages 数组；只记录标识/角色/数量，不记录正文。
function recordSentForContext(ctx, { round = 1, messages = ctx.requestMessages, toolsCount = 0 } = {}) {
  if (!ctx.contextTrace) return;
  ctx.contextTrace.recordSent({
    round,
    messages,
    contextIds: ctx.contextIds || [],
    model: {
      providerId: ctx.providerId,
      modelId: ctx.modelId,
      providerKind: monitoring.providerKind(),
    },
    toolsCount,
  });

  const list = Array.isArray(messages) ? messages : [];
  const nonSystem = list.filter(message => message && message.role !== 'system').length;
  monitoring.recordSent({
    count: nonSystem + (Array.isArray(ctx.contextIds) ? ctx.contextIds.length : 0),
    round,
    toolsCount,
    contextCount: Array.isArray(ctx.contextIds) ? ctx.contextIds.length : 0,
    messageCount: list.length,
  });
}

// Provider 返回后立即对账：把真实 usage 写进 trace，并与本地估算输入 Token 比对。
// 桩返回一律标 stub，不参与校准；没有 usage 就记 missing，不猜数字。
function recordUsageForContext(ctx, completion, round = 1) {
  if (!ctx) return null;

  const usage =
    completion && completion.usage && typeof completion.usage === 'object'
      ? completion.usage
      : null;
  const kind = monitoring.providerKind();
  const estimatedInputTokens =
    ctx.contextMeasurement && Number.isFinite(ctx.contextMeasurement.estimatedInputTokens)
      ? ctx.contextMeasurement.estimatedInputTokens
      : null;

  if (ctx.contextTrace) {
    ctx.contextTrace.recordProviderUsage({ round, usage, providerKind: kind });
  }

  return monitoring.recordTokenReconciliation({
    estimatedInputTokens,
    promptTokens: usage && Number.isFinite(usage.prompt_tokens) ? usage.prompt_tokens : null,
    providerKind: kind,
  });
}

// trace 只输出一次：成功、模型错误、工具路径共用同一个出口，避免重复行；
// 失败路径也必须留下证据，不能只在成功时记录。
function emitContextTrace(ctx) {
  if (!ctx || !ctx.contextTrace || ctx.contextTraceEmitted) return;
  console.error(`[context-trace] ${JSON.stringify(ctx.contextTrace.toJSON())}`);
  ctx.contextTraceEmitted = true;
}

app.post('/chat', requireAuth, async (req, res) => {
  // 客户端提前断开时标记，避免回复落盘成"幽灵消息"（用户没收到却已入库）；
  // 同时中止进行中的工具执行——已完成的只读工具不回滚，但不再做无用功。
  let clientGone = false;
  const disconnect = new AbortController();
  res.on('close', () => {
    if (!res.writableEnded) {
      clientGone = true;
      disconnect.abort();
    }
  });

  // 用户消息的到达时刻：Presence 用它计算「用户最后互动时间」，
  // 与模型耗时无关（回复可能几十秒后才完成）。
  const userMessageReceivedAt = Date.now();
  let ctxForTrace = null;
  // 失败路径也要记录真实的 Agent 轮数/工具数；这些变量必须在 try 外声明。
  let lastAgentRounds = 0;
  let lastAgentToolCount = 0;

  try {
    const prepared = await prepareChatRequest(req);

    if (prepared.error) {
      const [status, body] = prepared.error;
      return res.status(status).json(body);
    }

    const { ctx } = prepared;
    ctxForTrace = ctx;

    monitoring.recordModelRoute({
      requested: ctx.modelRoute.requested,
      actual: ctx.modelRoute.actual,
      auto: ctx.modelRoute.auto,
      reason: ctx.modelRoute.reason,
    });

    // 真实 API 调用流水：每次消耗密钥都在日志留痕，便于与服务商控制台
    // 用量对账、排查意外调用来源。纯日志，不影响逻辑，绝不含密钥本身。
    console.log(
      `[AI call] main-reply session=${ctx.sessionId} at=${new Date().toISOString()}` +
        ` provider=${ctx.providerId} model=${ctx.modelId}` +
        ` attachments=${ctx.attachments.length}`
    );

    // Agent 工具调用（V1）三重门控，全部在后端强制执行：
    // ① 紧急开关 BLUEBIRD_AGENT_TOOLS=1（默认关，每请求重读）；
    // ② 模型显式声明支持 Tool Calling（supportsTools，未知一律 false）；
    // ③ 非带图请求——带图（useVision）后端强制无工具，不依赖前端。
    // 任一不满足都走下方原路径，行为与改造前逐字节一致。
    noteSwitchObservation();
    const agentSwitchOn = agentToolsEnabled();
    const agentToolsSupported = supportsTools(ctx.providerId, ctx.modelId);
    const agentGate = evaluateAgentGate({
      switchOn: agentSwitchOn,
      toolsSupported: agentToolsSupported,
      hasNewImage: ctx.hasNewImage,
      policyMode: ctx.agentPolicy.mode,
      policyToolCount: listToolSpecs(ctx.agentPolicy).length,
    });
    const agentOn = agentGate.allowed;

    // 轮 4：编排开关开启时给模型追加计划块协议。
    const orchestrationAppendix = agentOn
      ? orchestrationPromptAppendix(ctx.agentPolicy)
      : null;
    if (orchestrationAppendix) {
      ctx.requestMessages = withOrchestrationAppendix(ctx.requestMessages, orchestrationAppendix);
    }

    if (ctx.contextTrace) {
      ctx.contextTrace.recordPolicy(ctx.agentPolicy, ctx.agentPolicyMeta, agentGate);
    }
    monitoring.recordAgentGate({
      path: 'chat',
      switchOn: agentSwitchOn,
      toolsSupported: agentToolsSupported,
      hasNewImage: ctx.hasNewImage,
      includeHistoryImages: ctx.includeHistoryImages,
      useVision: ctx.useVision,
      reason: agentGate.reason,
      allowed: agentOn,
    });

    // 只记录判定元数据：模型、开关、能力、新图/历史图、原因、是否放行。
    // 不记录用户消息、附件内容、工具参数或记忆正文。
    console.log(
      `[agent-gate] path=chat provider=${ctx.providerId} model=${ctx.modelId}` +
        ` switch=${agentSwitchOn} toolsCapability=${agentToolsSupported}` +
        ` hasNewImage=${ctx.hasNewImage} includeHistoryImages=${ctx.includeHistoryImages}` +
        ` hasImage=${ctx.useVision} reason=${agentGate.reason} allowed=${agentOn}` +
        ` policyMode=${ctx.agentPolicy.mode} policyRevision=${ctx.agentPolicyMeta.revision}`
    );

    if (agentOn) {
      console.log(
        `[agent] tools enabled session=${ctx.sessionId} provider=${ctx.providerId}` +
          ` model=${ctx.modelId}`
      );
    }

    let completion;
    let rawReply;
    let toolSteps = null;
    let agentOutcome = null;
    let agentReachedMaxRounds = false;
    // 轮 4（Orchestrator）：编排回执（agent 分支外声明，直答路径恒为 null）。
    let orchestrationMeta = null;

    if (agentOn) {
      const outcome = await runAgentTurn({
        providerId: ctx.providerId,
        modelId: ctx.modelId,
        sessionId: ctx.sessionId,
        userId: ctx.userId,
        userText: ctx.userText,
        userMessageId: ctx.userMessageId,
        temperature: 0.8,
        maxTokens: 8192,
        timeout: 90000,
        isClientGone: () => clientGone,
        abortSignal: disconnect.signal,
        messages: ctx.requestMessages,
        policy: ctx.agentPolicy,
        onRequest: requestMeta => recordSentForContext(ctx, requestMeta),
        // 用户明确点名 Memory Bot / 子 agent 时由运行时先真实派发，
        // 不依赖模型是否自愿发起工具调用。
        enforceExplicitDelegation: true,
      });

      agentOutcome = outcome;
      completion = outcome.completion;
      rawReply = outcome.rawReply;
      toolSteps = outcome.toolSteps.length ? outcome.toolSteps : null;
      agentReachedMaxRounds = outcome.reachedMaxRounds === true;
      lastAgentRounds = outcome.rounds;
      lastAgentToolCount = outcome.toolSteps.length;

      console.log(
        `[agent] finished session=${ctx.sessionId} rounds=${outcome.rounds}` +
          ` tools=${outcome.toolSteps.length}` +
          ` stop=${outcome.stopReason || 'none'}`
      );

      // 轮 4（Orchestrator）：主聊天编排接线——开关开启且回复携带计划块时，
      // 剥块 → 服务端编译 → 编排派发（父会话 = 当前聊天会话）；编译失败降级直答。
      // 开关关闭或无块：零行为差异。（变量在 agent 分支外声明，供响应块引用）
      {
        const wired = orchestrationChat.wireOrchestration({
          policy: ctx.agentPolicy,
          reply: rawReply,
          userText: ctx.userText,
          userId: ctx.userId,
          sessionId: ctx.sessionId,
        });
        rawReply = wired.reply;
        orchestrationMeta = wired.orchestration;
        if (
          wired.reason !== 'dispatched' &&
          wired.reason !== 'no_block' &&
          wired.reason !== 'disabled'
        ) {
          console.warn(
            `[orchestration-chat] not dispatched session=${ctx.sessionId} reason=${wired.reason}`
          );
        }
      }

      // Context Engine trace 收尾：把真实工具调用结果写入 trace（结构化、可测试验证）
      if (ctx.contextTrace) {
        for (const step of outcome.toolSteps) {
          ctx.contextTrace.recordTool({
            name: step.name,
            ok: step.ok,
            code: step.code,
            summary: step.summary,
            durationMs: step.durationMs,
          });
        }
        // Provider 真实 usage 必须在 emitContextTrace 之前写入，否则 trace 里没有。
        recordUsageForContext(ctx, completion, outcome.rounds || 1);
        ctx.contextTrace.recordAgent(outcome);
        emitContextTrace(ctx);
      }

      if (!completion) {
        // 客户端在首轮模型调用前就已断开：没有任何可收尾内容
        throw new Error('模型没有返回有效内容');
      }
    } else {
      recordSentForContext(ctx);
      completion = await createChatCompletion({
        providerId: ctx.providerId,
        modelId: ctx.modelId,
        wantVision: ctx.useVision,
        temperature: 0.8,
        maxTokens: 8192,
        timeout: 90000,
        messages: ctx.requestMessages,
        // 客户端断开时中止上游调用，不让模型把额度耗在没人要的回复上
        signal: disconnect.signal,
      });

      rawReply = completion.choices?.[0]?.message?.content;
      recordUsageForContext(ctx, completion, 1);
    }

    if (!rawReply && agentOn && agentOutcome && agentOutcome.stopReason) {
      rawReply = agentStopReply(agentOutcome.stopReason);
    }

    if (!rawReply) {
      throw new Error('模型没有返回有效内容');
    }

    rawReply = auditChatReply(rawReply, ctx, toolSteps);

    const result = completeChatTurn({
      ctx,
      rawReply,
      isClientGone: () => clientGone,
      userMessageReceivedAt,
      ...(toolSteps ? { toolSteps } : {}),
    });

    // 非 Agent 路径的 trace 收尾（无工具调用，同样输出结构化 trace）
    emitContextTrace(ctx);

    monitoring.recordTask({
      status: clientGone
        ? 'cancelled'
        : agentReachedMaxRounds
          ? 'partial_success'
          : 'success',
      termination: clientGone
        ? 'client_closed'
        : agentReachedMaxRounds
          ? 'max_rounds'
          : 'model_end',
      durationMs: Date.now() - userMessageReceivedAt,
      rounds: agentOn ? lastAgentRounds : 1,
      toolCount: lastAgentToolCount,
    });

    res.json({
      ...result,
      // model 是本次请求实际解析并按此下发的服务商模型（与设置页所选一致）；
      // upstreamModel 才是供应商响应里回显的 model 字段（部分供应商会改写，
      // 例如 DeepSeek 对 deepseek-chat 也回显 deepseek-flash，不能用来判断切换）。
      model: ctx.modelId,
      providerId: ctx.providerId,
      upstreamModel: typeof completion.model === 'string' ? completion.model : null,
      // 结构化路由结果：requested / actual / auto / reason，与流式 done 语义一致
      modelRoute: ctx.modelRoute,
      sessionId: ctx.sessionId,
      // 新图触发了 Agent 工具互斥时给用户的提示（不落盘、不进历史）
      ...(agentGate.notice ? { agentNotice: agentGate.notice } : {}),
      // 轮 4（Orchestrator）：编排回执（additive；未派发时缺省不出现该键）
      ...(orchestrationMeta ? { orchestration: orchestrationMeta } : {}),
      // 记忆编排状态（阶段3 可观测性，additive）：标准契约状态 ok/empty/degraded/failed
      memoryState: ctx.contextMemoryState,
      memoryStatus: ctx.contextMemoryStatus,
      // 请求级追踪标识：贯穿上下文 trace 与记忆提取日志
      requestId: ctx.requestId,
    });

    scheduleMemoryExtraction(ctx.userText, ctx.sessionId, ctx.attachments, {
      messageId: result.userMessageId || null,
      requestId: ctx.requestId,
      // 自动抽取的更正同样按用户级作用域判定可见性：新会话里改口要能覆盖旧记忆。
      userId: ctx.userId,
    });
  } catch (error) {
    emitContextTrace(ctxForTrace);
    // 客户端已断开：不再往已关闭的连接写响应（会抛 ERR_STREAM_WRITE_AFTER_END），
    // 只按取消记账，不落盘。
    if (clientGone) {
      monitoring.recordTask({
        status: 'cancelled',
        termination: 'client_closed',
        durationMs: Date.now() - userMessageReceivedAt,
        rounds: lastAgentRounds || 1,
        toolCount: lastAgentToolCount,
        errorCode: 'client_closed',
      });
      return;
    }
    // 模型调用类错误：按 kind 映射 HTTP 状态，返回结构化错误（已脱敏）；
    // 其余（内部 bug）保持原有 500 语义不变。
    if (error instanceof ModelCallError) {
      console.error('AI API Error:', error.kind, error.message);
      monitoring.recordTask({
        status:
          error.kind === 'timeout'
            ? 'timeout'
            : error.kind === 'auth'
              ? 'denied'
              : 'failed',
        termination: 'model_error',
        durationMs: Date.now() - userMessageReceivedAt,
        rounds: lastAgentRounds || 1,
        toolCount: lastAgentToolCount,
        errorCode: error.kind,
      });
      return res.status(error.status).json({
        error: error.message,
        code: error.kind,
        ...(process.env.NODE_ENV === 'development' && error.detail
          ? { detail: String(error.detail).slice(0, 300) }
          : {}),
      });
    }

    console.error('AI API Error:', error);
    monitoring.recordTask({
      status: 'failed',
      termination: 'internal_error',
      durationMs: Date.now() - userMessageReceivedAt,
      rounds: lastAgentRounds || 1,
      toolCount: lastAgentToolCount,
      errorCode: 'internal_error',
    });

    res.status(500).json({
      error: 'AI 请求失败',
      detail:
        process.env.NODE_ENV === 'development'
          ? error.message
          : undefined,
    });
  }
});

// 流式聊天：与 /chat 完全相同的前置校验、上下文组装与收尾落盘，
// 差异仅在模型以 stream:true 调用，回复增量通过 SSE 逐段推送给客户端。
// 事件协议（每事件一行 data: JSON + 空行）：
//   {"type":"delta","content":"..."}  增量正文（前导情绪标签已被服务端剥掉）
//   {"type":"done", ...}              收尾，字段与 /chat 响应完全一致
//   {"type":"error","error":"..."}    失败（不落盘、不产生幽灵消息）
app.post('/chat/stream', requireAuth, async (req, res) => {
  let clientGone = false;
  const disconnect = new AbortController();
  res.on('close', () => {
    if (!res.writableEnded) {
      clientGone = true;
      disconnect.abort();
    }
  });

  const userMessageReceivedAt = Date.now();
  let ctxForTrace = null;
  // 失败/断连路径也要记录 Agent 真实轮数与工具数，声明在 try 之外。
  let lastAgentRounds = 0;
  let lastAgentToolCount = 0;

  // 校验与上下文组装：失败时还没切 SSE，按普通 JSON 错误返回，
  // 客户端收到非 200 可走旧 /chat 回退路径
  let prepared;

  try {
    prepared = await prepareChatRequest(req);
  } catch (error) {
    monitoring.recordSseCompleted({
      status: 'rejected',
      durationMs: Date.now() - userMessageReceivedAt,
      errorCode: 'prepare_failed',
    });
    console.error('AI API Error:', error);
    return res.status(500).json({ error: 'AI 请求失败' });
  }

  if (prepared.error) {
    const [status, body] = prepared.error;
    monitoring.recordSseCompleted({
      status: 'rejected',
      durationMs: Date.now() - userMessageReceivedAt,
      errorCode: body && body.code ? body.code : `http_${status}`,
    });
    return res.status(status).json(body);
  }

  const { ctx } = prepared;
  ctxForTrace = ctx;

  monitoring.recordModelRoute({
    requested: ctx.modelRoute.requested,
    actual: ctx.modelRoute.actual,
    auto: ctx.modelRoute.auto,
    reason: ctx.modelRoute.reason,
  });

  const sseStartedAt = Date.now();
  let sseFirstTokenAt = null;
  let sseDeltaEvents = 0;
  let sseFinalized = false;
  const sseSpan = monitoring.startSpan('response.stream', {
    stream: true,
  });

  const finishSse = (status, errorCode = null) => {
    if (sseFinalized) return;
    sseFinalized = true;
    sseSpan.end({
      status:
        status === 'completed'
          ? 'success'
          : status === 'aborted'
            ? 'cancelled'
            : status === 'rejected'
              ? 'denied'
              : 'failed',
      errorCode,
    });
    monitoring.recordSseCompleted({
      status,
      durationMs: Date.now() - sseStartedAt,
      firstTokenMs: sseFirstTokenAt ? sseFirstTokenAt - sseStartedAt : null,
      deltaEvents: sseDeltaEvents,
      errorCode,
    });
  };

  res.status(200);
  res.set({
    'Content-Type': 'text/event-stream; charset=utf-8',
    'Cache-Control': 'no-cache, no-transform',
    Connection: 'keep-alive',
    // 反向代理（如有）禁用缓冲，保证 delta 即时到达
    'X-Accel-Buffering': 'no',
  });
  res.flushHeaders();
  monitoring.recordSseStarted();

  const sendEvent = payload => {
    if (clientGone || res.writableEnded) return false;

    try {
      res.write(`data: ${JSON.stringify(payload)}\n\n`);
      if (payload && payload.type === 'delta') {
        sseDeltaEvents += 1;
        if (sseFirstTokenAt === null) sseFirstTokenAt = Date.now();
      }
      return true;
    } catch (_error) {
      return false;
    }
  };

  // 分段模式随流下发（首个事件，早于所有 delta）：
  // 前端据此在流式期用同一套 splitReplyIntoSegments 切气泡，
  // done 时替换成权威分条不会有「先并后分」的跳变。
  // 旧客户端忽略未知 type 即可，不改变 delta / done 语义。
  sendEvent({
    type: 'meta',
    messageMode:
      (ctx.personaConfig && ctx.personaConfig.messageMode) || 'auto',
    // 流式期与服务端 done 使用同一上限；旧客户端缺省时用 lib 默认 400。
    replyMaxChars: REPLY_MAX_CHARS,
    sessionId: ctx.sessionId,
  });

  console.log(
    `[AI call] main-reply session=${ctx.sessionId} (stream) at=${new Date().toISOString()}` +
      ` provider=${ctx.providerId} model=${ctx.modelId}` +
      ` attachments=${ctx.attachments.length}`
  );

  let rawReply = '';
  // 轮 4（Orchestrator）：编排回执元数据（done 事件 additive 字段）。
  let streamOrchestrationMeta = null;
  // model 保持为「本次实际请求的模型」，不被上游回显覆盖；
  // upstreamModel 单独记录供应商响应里的 model（部分供应商会改写）。
  const model = ctx.modelId;
  let upstreamModel = null;
  let toolSteps = null;
  let agentReachedMaxRounds = false;
  const stripper = createMoodTagStripper();
  let streamError = null;

  // Agent 工具调用（V1）：与 /chat 完全相同的三重门控（开关 / 模型能力 /
  // 非带图），全部后端强制。工具轮以非流式执行，经 tool_start / tool_end
  // 事件向客户端反馈进度；最终文本仍走 stripper → delta → done，
  // 不新增也不改变既有事件格式（旧客户端忽略新 type 即可）。
  noteSwitchObservation();
  const agentSwitchOn = agentToolsEnabled();
  const agentToolsSupported = supportsTools(ctx.providerId, ctx.modelId);
  const agentGate = evaluateAgentGate({
    switchOn: agentSwitchOn,
    toolsSupported: agentToolsSupported,
    hasNewImage: ctx.hasNewImage,
    policyMode: ctx.agentPolicy.mode,
    policyToolCount: listToolSpecs(ctx.agentPolicy).length,
  });
  const agentOn = agentGate.allowed;

  if (ctx.contextTrace) {
    ctx.contextTrace.recordPolicy(ctx.agentPolicy, ctx.agentPolicyMeta, agentGate);
  }
  monitoring.recordAgentGate({
    path: 'stream',
    switchOn: agentSwitchOn,
    toolsSupported: agentToolsSupported,
    hasNewImage: ctx.hasNewImage,
    includeHistoryImages: ctx.includeHistoryImages,
    useVision: ctx.useVision,
    reason: agentGate.reason,
    allowed: agentOn,
  });

  // 只记录判定元数据：模型、开关、能力、新图/历史图、原因、是否放行。
  // 不记录用户消息、附件内容、工具参数或记忆正文。
  console.log(
    `[agent-gate] path=stream provider=${ctx.providerId} model=${ctx.modelId}` +
      ` switch=${agentSwitchOn} toolsCapability=${agentToolsSupported}` +
      ` hasNewImage=${ctx.hasNewImage} includeHistoryImages=${ctx.includeHistoryImages}` +
      ` hasImage=${ctx.useVision} reason=${agentGate.reason} allowed=${agentOn}` +
      ` policyMode=${ctx.agentPolicy.mode} policyRevision=${ctx.agentPolicyMeta.revision}`
  );

  if (agentOn) {
    console.log(
      `[agent] tools enabled (stream) session=${ctx.sessionId}` +
        ` provider=${ctx.providerId} model=${ctx.modelId}`
    );
  }

  // 轮 4：编排开关开启时给模型追加计划块协议（与 /chat 同一协议）。
  const orchestrationAppendix =
    agentOn ? orchestrationPromptAppendix(ctx.agentPolicy) : null;
  if (orchestrationAppendix) {
    ctx.requestMessages = withOrchestrationAppendix(ctx.requestMessages, orchestrationAppendix);
  }

  try {
    if (agentOn) {
      const outcome = await runAgentTurn({
        providerId: ctx.providerId,
        modelId: ctx.modelId,
        sessionId: ctx.sessionId,
        userId: ctx.userId,
        userText: ctx.userText,
        userMessageId: ctx.userMessageId,
        temperature: 0.8,
        maxTokens: 8192,
        timeout: 90000,
        isClientGone: () => clientGone,
        abortSignal: disconnect.signal,
        onToolEvent: event => {
          sendEvent(event);
        },
        messages: ctx.requestMessages,
        policy: ctx.agentPolicy,
        onRequest: requestMeta => recordSentForContext(ctx, requestMeta),
        // 与 /chat 一致：显式子 agent 请求必须真实派发，不能只靠模型自觉。
        enforceExplicitDelegation: true,
      });

      if (outcome.completion) {
        rawReply = outcome.rawReply;
        if (!rawReply && outcome.stopReason) {
          rawReply = agentStopReply(outcome.stopReason);
        }
        // model 语义与 /chat 一致：始终是本系统实际下发的 ctx.modelId；
        // 供应商回显只写入 upstreamModel，绝不覆盖 model。
        upstreamModel =
          typeof outcome.completion.model === 'string'
            ? outcome.completion.model
            : null;
        toolSteps = outcome.toolSteps.length ? outcome.toolSteps : null;
        lastAgentRounds = outcome.rounds;
        lastAgentToolCount = outcome.toolSteps.length;
        agentReachedMaxRounds = outcome.reachedMaxRounds === true;

        console.log(
          `[agent] finished (stream) session=${ctx.sessionId}` +
            ` rounds=${outcome.rounds} tools=${outcome.toolSteps.length}` +
            ` stop=${outcome.stopReason || 'none'}`
        );

        // Context Engine trace 收尾（stream 路由）：写入真实工具调用结果
        if (ctx.contextTrace) {
          for (const step of outcome.toolSteps) {
            ctx.contextTrace.recordTool({
              name: step.name,
              ok: step.ok,
              code: step.code,
              summary: step.summary,
              durationMs: step.durationMs,
            });
          }
          recordUsageForContext(ctx, outcome.completion, outcome.rounds || 1);
          ctx.contextTrace.recordAgent(outcome);
          emitContextTrace(ctx);
        }

        // 轮 4（Orchestrator）：与 /chat 同一编排接线（stream 侧剥块 + 回执）。
        let orchestrationMeta = null;
        {
          const wired = orchestrationChat.wireOrchestration({
            policy: ctx.agentPolicy,
            reply: rawReply,
            userText: ctx.userText,
            userId: ctx.userId,
            sessionId: ctx.sessionId,
          });
          rawReply = wired.reply;
          orchestrationMeta = wired.orchestration;
          if (
            wired.reason !== 'dispatched' &&
            wired.reason !== 'no_block' &&
            wired.reason !== 'disabled'
          ) {
            console.warn(
              `[orchestration-chat] not dispatched (stream) session=${ctx.sessionId} reason=${wired.reason}`
            );
          }
        }

        // 最终文本经同一套情绪标签剥离后以 delta 发出
        const emit = stripper.push(rawReply);
        if (emit) sendEvent({ type: 'delta', content: emit });
        streamOrchestrationMeta = orchestrationMeta;
      }
    } else {
      recordSentForContext(ctx);
      const stream = await createChatCompletion({
        providerId: ctx.providerId,
        modelId: ctx.modelId,
        wantVision: ctx.useVision,
        temperature: 0.8,
        maxTokens: 8192,
        timeout: 90000,
        stream: true,
        messages: ctx.requestMessages,
      });

      // 流式 usage 由供应商在末帧给出（不保证存在）：拿到就记，拿不到记 missing。
      let streamUsage = null;

      for await (const chunk of stream) {
        // 客户端已断开：中止上游流，不落盘，避免幽灵消息
        if (clientGone) {
          try {
            if (stream.controller) stream.controller.abort();
          } catch (_) {
            /* 中止失败不影响主流程 */
          }
          break;
        }

        if (chunk && typeof chunk.model === 'string') upstreamModel = chunk.model;
        if (chunk && chunk.usage && typeof chunk.usage === 'object') {
          streamUsage = chunk.usage;
        }

        const delta =
          chunk &&
          chunk.choices &&
          chunk.choices[0] &&
          chunk.choices[0].delta &&
          typeof chunk.choices[0].delta.content === 'string'
            ? chunk.choices[0].delta.content
            : '';

        if (!delta) continue;

        rawReply += delta;

        const emit = stripper.push(delta);
        if (emit && !sendEvent({ type: 'delta', content: emit })) break;
      }

      recordUsageForContext(ctx, { usage: streamUsage }, 1);
    }
  } catch (error) {
    streamError = error;
  }

  // 客户端断开：直接结束，不落盘、不发 done
  if (clientGone) {
    finishSse('aborted', 'client_closed');
    monitoring.recordTask({
      status: 'cancelled',
      termination: 'client_closed',
      durationMs: Date.now() - userMessageReceivedAt,
      rounds: agentOn ? lastAgentRounds : 1,
      toolCount: lastAgentToolCount,
      errorCode: 'client_closed',
    });
    try {
      res.end();
    } catch (_) {
      /* ignore */
    }
    return;
  }

  if (streamError) {
    emitContextTrace(ctxForTrace);
    finishSse(
      'failed',
      streamError instanceof ModelCallError ? streamError.kind : 'stream_error'
    );
    monitoring.recordTask({
      status:
        streamError instanceof ModelCallError && streamError.kind === 'timeout'
          ? 'timeout'
          : streamError instanceof ModelCallError && streamError.kind === 'auth'
            ? 'denied'
            : 'failed',
      termination: 'model_error',
      durationMs: Date.now() - userMessageReceivedAt,
      rounds: agentOn ? lastAgentRounds : 1,
      toolCount: lastAgentToolCount,
      errorCode:
        streamError instanceof ModelCallError ? streamError.kind : 'stream_error',
    });
    // 模型调用类错误带 code（连接/限流/超时/服务商/模型，已脱敏）；
    // 内部错误保持原有通用文案。客户端断开的场景上面已提前返回。
    if (streamError instanceof ModelCallError) {
      console.error('AI stream error:', streamError.kind, streamError.message);
      sendEvent({
        type: 'error',
        error: streamError.message,
        code: streamError.kind,
      });
    } else {
      console.error('AI stream error:', streamError);
      sendEvent({ type: 'error', error: 'AI 请求失败' });
    }
    res.end();
    return;
  }

  if (!rawReply) {
    finishSse('failed', 'empty_response');
    monitoring.recordTask({
      status: 'failed',
      termination: 'empty_response',
      durationMs: Date.now() - userMessageReceivedAt,
      rounds: agentOn ? lastAgentRounds : 1,
      toolCount: lastAgentToolCount,
      errorCode: 'empty_response',
    });
    sendEvent({ type: 'error', error: '模型没有返回有效内容' });
    res.end();
    return;
  }

  // 缓冲里剩余的非标签内容放行（若有半截标签说明模型输出截断，
  // done 事件的权威文本仍由 stripMoodTags 全量清洗兜底）
  const beforeClaimCheck = rawReply;
  rawReply = auditChatReply(rawReply, ctx, toolSteps);
  if (rawReply !== beforeClaimCheck) {
    // 校验说明是服务端追加的纯文本，直接作为末段 delta 让用户当场看到，
    // done 事件里的权威文本同样是修正后的内容。
    sendEvent({ type: 'delta', content: rawReply.slice(beforeClaimCheck.length) });
  }

  const tail = stripper.flush();
  if (tail) sendEvent({ type: 'delta', content: tail });

  let result;

  try {
    result = completeChatTurn({
      ctx,
      rawReply,
      isClientGone: () => clientGone,
      userMessageReceivedAt,
      ...(toolSteps ? { toolSteps } : {}),
    });
  } catch (error) {
    console.error('AI stream finalize error:', error);
    emitContextTrace(ctxForTrace);
    finishSse('failed', 'finalize_error');
    monitoring.recordTask({
      status: 'failed',
      termination: 'finalize_error',
      durationMs: Date.now() - userMessageReceivedAt,
      rounds: agentOn ? lastAgentRounds : 1,
      toolCount: lastAgentToolCount,
      errorCode: 'finalize_error',
    });
    sendEvent({ type: 'error', error: 'AI 请求失败' });
    res.end();
    return;
  }

  // 非 Agent 路径的 trace 收尾（无工具调用，同样输出结构化 trace）
  emitContextTrace(ctx);

  monitoring.recordTask({
    status: agentReachedMaxRounds ? 'partial_success' : 'success',
    termination: agentReachedMaxRounds ? 'max_rounds' : 'model_end',
    durationMs: Date.now() - userMessageReceivedAt,
    rounds: agentOn ? lastAgentRounds : 1,
    toolCount: lastAgentToolCount,
  });
  finishSse('completed');

  sendEvent({ type: 'done', ...result, ...(agentGate.notice ? { agentNotice: agentGate.notice } : {}), ...(streamOrchestrationMeta ? { orchestration: streamOrchestrationMeta } : {}), model, providerId: ctx.providerId, upstreamModel, modelRoute: ctx.modelRoute, sessionId: ctx.sessionId, memoryState: ctx.contextMemoryState, memoryStatus: ctx.contextMemoryStatus, requestId: ctx.requestId });
  res.end();

  scheduleMemoryExtraction(ctx.userText, ctx.sessionId, ctx.attachments, {
    messageId: result && result.userMessageId ? result.userMessageId : null,
    requestId: ctx.requestId,
    // 与 /chat 一致：更正按用户级作用域判定，新会话改口能覆盖旧记忆。
    userId: ctx.userId,
  });
});

// 未匹配的路由统一回 JSON 404：不再落回 Express 默认的 HTML 页面，
// 前端拿到的始终是 { error, code }。
app.use((req, res) => {
  res.status(404).json({ error: '接口不存在', code: 'not_found' });
});

// 统一 JSON 错误出口：body-parser 的 400/413 与未捕获路由错误不再返回
// Express 默认 HTML 堆栈页；只回受控短句，不泄露内部实现。
app.use((error, req, res, next) => {
  if (res.headersSent) return next(error);
  const status = Number(error && (error.status || error.statusCode)) || 500;
  let message = '请求格式无效';
  let code = 'bad_request';
  if (status === 413) {
    message = '请求体过大';
    code = 'payload_too_large';
  } else if (status === 400 && error && error.type === 'entity.parse.failed') {
    message = '请求体不是合法 JSON';
    code = 'invalid_json';
  } else if (status >= 500) {
    message = '服务器内部错误';
    code = 'internal_error';
    console.error(
      'Unhandled request error:',
      error && error.message ? error.message : error
    );
  }
  res.status(status).json({ error: message, code });
});

// 先抢占数据目录锁：已有实例在跑、或数据目录不可用，都直接退出，
// 绝不带病启动造成静默覆盖（acquireSingleInstance 失败时不会返回）。
acquireSingleInstance({ port: PORT });

// 检索索引初始化失败不阻止聊天服务启动：状态接口会显式返回 degraded，
// 上下文只降级外部知识块，主链路仍可用。
const retrievalStatus = retrieval.initialize();
if (!retrievalStatus.enabled) {
  console.log('[retrieval] 统一检索已关闭（BLUEBIRD_RETRIEVAL=0）');
} else {
  console.log(`[retrieval] 统一检索状态：${retrievalStatus.state || 'unknown'}`);
}
// 拿到锁之后再初始化监控：初始化失败只降级，不影响聊天主链路。
monitoring.initMonitoring();

// 重启恢复：crash 时停在 accepted/running 的任务重新入队；
// executing 审批按幂等账本收敛：已成功→收敛为已执行，可能已执行→recovery 等人工核对，
// 只有账本确认没执行过才判失败；一律不自动重试。
const approvalRecovery = agentApprovals.recoverInterrupted();
const agentQueue = agentRuntime.initializeTaskQueue();
console.log(
  `[agents] task queue concurrency=${agentQueue.concurrency} recovered=${agentQueue.recovered} ` +
    `approvalsInterrupted=${approvalRecovery.recovered} ` +
    `approvalsOverdue=${approvalRecovery.overdue}`
);

const server = app.listen(PORT, '0.0.0.0', () => {
  // PORT 为 0 时由操作系统分配空闲端口，日志回显真实端口
  console.log(`Bluebird API running on port ${server.address().port}`);
});

installShutdownHooks(server, {
  onShutdown: () => monitoring.shutdownMonitoring(),
});

// 导出 app 与 server 实例：测试可用 PORT=0 拿到系统分配的空闲端口，
// 避免固定端口被占用时误连到别的服务（会读写对方的真实数据目录）。
// buildTimeGapContext / gapSemanticLabel 导出仅供时间间隔测试断言，运行行为不变。
module.exports = { app, server, buildTimeGapContext, gapSemanticLabel };
