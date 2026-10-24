/* global __dirname */
const fs = require('fs');
const path = require('path');
const { writeFileAtomicSync } = require('./atomic-write');
const { logDataEvent } = require('./data-events');
const { registerCorruptionHandler, handleCorruption } = require('./corruption');

// 数据目录可通过 BLUEBIRD_DATA_DIR 覆盖：测试用临时目录，避免碰到真实数据。
// 与 sessions.js / memory.js / emotion.js 保持同一套解析规则。
const DATA_DIR = process.env.BLUEBIRD_DATA_DIR
  ? path.resolve(process.env.BLUEBIRD_DATA_DIR)
  : path.join(__dirname, 'data');

// 在线状态是运行时观测数据，与聊天历史 / 长期记忆 / 情绪完全分文件存放，
// 不触碰 sessions.json、memory.json、emotion-state.json。
const PRESENCE_FILE = path.join(DATA_DIR, 'presence.json');

const PRESENCE_VERSION = 1;

// 活跃窗口：前台 + 最近 5 分钟内有有效互动才算 active。
const ACTIVE_INTERACTION_WINDOW_MS = 5 * 60 * 1000;
// 心跳有效期：前端每 30 秒上报一次，容忍一次丢失 + 网络延迟。
// 超过该时间没有任何联系，就无法确认客户端状态，只能判 unknown（绝不当作离线）。
const HEARTBEAT_TTL_MS = 90 * 1000;

// 去重事件 id 只保留最近一批，避免文件无限增长。
const MAX_EVENT_IDS = 200;
// 单用户会话数上限：只保留最近活跃的若干会话的等待状态。
const MAX_SESSION_ENTRIES = 200;
// 客户端时间最多允许超前 60 秒（时钟偏差），超过则改用服务端时间。
const FUTURE_SKEW_MS = 60 * 1000;
// 超过 24 小时的陈旧上报不再采信其发生时间，改用服务端接收时间。
const MAX_REPORT_AGE_MS = 24 * 60 * 60 * 1000;

const STATUS = {
  ACTIVE: 'active',
  AWAY: 'away',
  UNKNOWN: 'unknown',
};

const APP_STATE = {
  FOREGROUND: 'foreground',
  BACKGROUND: 'background',
  UNKNOWN: 'unknown',
};

let state = null;

function nowIso(ms) {
  return new Date(ms).toISOString();
}

function isoOrNull(value) {
  if (typeof value !== 'string') return null;

  const ms = Date.parse(value);

  return Number.isFinite(ms) ? new Date(ms).toISOString() : null;
}

function maxIso(left, right) {
  const a = isoOrNull(left);
  const b = isoOrNull(right);

  if (!a) return b;
  if (!b) return a;

  return Date.parse(a) >= Date.parse(b) ? a : b;
}

// 客户端上报的发生时间：非法 / 明显超前 / 过于陈旧时回退到服务端接收时间。
// 这样即使设备时钟不准或请求迟到，也不会把状态推到未来或过去。
function normalizeOccurredAt(value, nowMs) {
  const ms = typeof value === 'string' ? Date.parse(value) : NaN;

  if (!Number.isFinite(ms)) return nowMs;
  if (ms > nowMs + FUTURE_SKEW_MS) return nowMs;
  if (ms < nowMs - MAX_REPORT_AGE_MS) return nowMs;

  return ms;
}

function emptyState() {
  return {
    version: PRESENCE_VERSION,
    // 最后一次收到客户端任何上报的时间（心跳 / 前后台切换 / 互动）
    lastSeenAt: null,
    // 最后一次用户互动时间（发消息、切回前台等）
    lastInteractionAt: null,
    // 最后一条 Blue 消息时间（全局，跨会话取最新）
    lastBlueMessageAt: null,
    // 派生状态的缓存：状态与状态更新时间
    status: STATUS.UNKNOWN,
    statusReason: 'no_data',
    statusUpdatedAt: null,
    // 客户端前后台状态单独记录，不靠计时推断
    appState: APP_STATE.UNKNOWN,
    appStateUpdatedAt: null,
    lastHeartbeatAt: null,
    // 已处理的事件 id（重复请求 / 重放直接忽略）
    eventIds: [],
    // 每个会话各自的等待用户回复状态
    sessions: {},
  };
}

function normalizeSessionEntry(raw) {
  if (!raw || typeof raw !== 'object') return null;

  const lastUserMessageAt = isoOrNull(raw.lastUserMessageAt);
  const lastBlueMessageAt = isoOrNull(raw.lastBlueMessageAt);

  if (!lastUserMessageAt && !lastBlueMessageAt) return null;

  return { lastUserMessageAt, lastBlueMessageAt };
}

function normalizeState(raw) {
  const next = emptyState();

  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return next;

  next.lastSeenAt = isoOrNull(raw.lastSeenAt);
  next.lastInteractionAt = isoOrNull(raw.lastInteractionAt);
  next.lastBlueMessageAt = isoOrNull(raw.lastBlueMessageAt);
  next.statusUpdatedAt = isoOrNull(raw.statusUpdatedAt);
  next.appStateUpdatedAt = isoOrNull(raw.appStateUpdatedAt);
  next.lastHeartbeatAt = isoOrNull(raw.lastHeartbeatAt);

  if (Object.values(STATUS).includes(raw.status)) next.status = raw.status;
  if (typeof raw.statusReason === 'string' && raw.statusReason) {
    next.statusReason = raw.statusReason;
  }

  if (Object.values(APP_STATE).includes(raw.appState)) {
    next.appState = raw.appState;
  }

  if (Array.isArray(raw.eventIds)) {
    next.eventIds = raw.eventIds
      .filter(item => typeof item === 'string' && item)
      .slice(-MAX_EVENT_IDS);
  }

  const sessions =
    raw.sessions && typeof raw.sessions === 'object' && !Array.isArray(raw.sessions)
      ? raw.sessions
      : {};

  for (const [sessionId, entry] of Object.entries(sessions)) {
    if (typeof sessionId !== 'string' || !sessionId) continue;

    const normalized = normalizeSessionEntry(entry);

    if (normalized) next.sessions[sessionId] = normalized;
  }

  pruneSessions(next);

  return next;
}

function sessionTime(current, id) {
  const entry = current.sessions[id] || {};
  const value = entry.lastBlueMessageAt || entry.lastUserMessageAt;

  return value ? Date.parse(value) : 0;
}

// 只保留最近活跃的会话条目，防止 presence.json 随会话数无限膨胀。
// protectedId 是本次刚写入的会话——即使它暂时还没有时间戳也不会被裁掉。
function pruneSessions(current, protectedId) {
  const ids = Object.keys(current.sessions);

  if (ids.length <= MAX_SESSION_ENTRIES) return;

  const keepCount = MAX_SESSION_ENTRIES - (protectedId ? 1 : 0);
  const removable = ids
    .filter(id => id !== protectedId)
    .sort((a, b) => sessionTime(current, b) - sessionTime(current, a));

  for (const id of removable.slice(keepCount)) {
    delete current.sessions[id];
  }
}

// 损坏处理契约：presence.json 只是运行时状态，读不出来就隔离重命名并从空状态继续，
// 不影响聊天、记忆、情绪。形状不对由 normalizeState 容忍，不算损坏。
registerCorruptionHandler('presence', {
  detect(data) {
    if (data.error) {
      return { corrupt: true, reason: 'read_error', error: data.error };
    }

    try {
      return { corrupt: false, parsed: JSON.parse(data.text) };
    } catch (error) {
      return { corrupt: true, reason: 'json_parse_error', error };
    }
  },

  recover(context) {
    let isolatedPath = null;

    try {
      const corruptPath = `${context.file}.corrupt-${Date.now()}`;

      fs.renameSync(context.file, corruptPath);

      isolatedPath = corruptPath;

      console.error(`Corrupt presence backed up: ${isolatedPath}`);
    } catch (backupError) {
      console.error('Presence backup error:', backupError.message);
    }

    return {
      action: isolatedPath ? 'isolated_file' : 'isolation_failed',
      isolatedPath,
    };
  },
});

function loadState() {
  if (state) return state;

  try {
    fs.mkdirSync(DATA_DIR, { recursive: true });
  } catch (error) {
    console.error('Presence data dir error:', error.message);
    logDataEvent({
      module: 'presence',
      file: DATA_DIR,
      event: 'data_dir_error',
      error,
      action: 'continuing',
    });
  }

  if (!fs.existsSync(PRESENCE_FILE)) {
    state = emptyState();
    return state;
  }

  let text = null;
  let error = null;

  try {
    text = fs.readFileSync(PRESENCE_FILE, 'utf8');
  } catch (readError) {
    error = readError;
  }

  const outcome = handleCorruption(
    'presence',
    { text, error },
    { file: PRESENCE_FILE }
  );

  state = outcome.corrupt ? emptyState() : normalizeState(outcome.parsed);

  return state;
}

// 原子写：presence 是观测数据，写失败只记录并继续，绝不影响业务请求。
function persist() {
  try {
    fs.mkdirSync(DATA_DIR, { recursive: true });
    writeFileAtomicSync(PRESENCE_FILE, JSON.stringify(state, null, 2));
    return true;
  } catch (error) {
    logDataEvent({
      module: 'presence',
      file: PRESENCE_FILE,
      event: 'store_write_failed',
      error,
      action: 'write_failed',
    });
    return false;
  }
}

// 状态判定（优先级即规则顺序）：
//   1. 从未收到任何上报 -> unknown（没有数据不等于离线）
//   2. 明确的 background -> away（后台状态单独记录，不靠计时推断）
//   3. 心跳过期 -> unknown（无法确认客户端状态，绝不能当作离线）
//   4. 前台 + 5 分钟内有互动 -> active
//   5. 前台 + 互动已超过 5 分钟 -> away
// 注意 unknown 只用于"无法确认"，任何时候都不会被换算成 away/offline。
function computeStatus(current, nowMs) {
  if (!current.lastSeenAt) {
    return { status: STATUS.UNKNOWN, reason: 'no_data' };
  }

  if (current.appState === APP_STATE.BACKGROUND) {
    return { status: STATUS.AWAY, reason: 'app_background' };
  }

  const lastSeenMs = Date.parse(current.lastSeenAt);

  if (!Number.isFinite(lastSeenMs) || nowMs - lastSeenMs > HEARTBEAT_TTL_MS) {
    return { status: STATUS.UNKNOWN, reason: 'heartbeat_expired' };
  }

  if (current.appState !== APP_STATE.FOREGROUND) {
    return { status: STATUS.UNKNOWN, reason: 'app_state_unknown' };
  }

  const lastInteractionMs = current.lastInteractionAt
    ? Date.parse(current.lastInteractionAt)
    : NaN;

  if (
    Number.isFinite(lastInteractionMs) &&
    nowMs - lastInteractionMs <= ACTIVE_INTERACTION_WINDOW_MS
  ) {
    return {
      status: STATUS.ACTIVE,
      reason: 'foreground_recent_interaction',
    };
  }

  return { status: STATUS.AWAY, reason: 'interaction_stale' };
}

// 只在派生状态真正变化时推进 statusUpdatedAt，避免每次心跳都改写它。
function recomputeStatus(current, nowMs) {
  const next = computeStatus(current, nowMs);

  if (current.status === next.status && current.statusReason === next.reason) {
    return false;
  }

  current.status = next.status;
  current.statusReason = next.reason;
  current.statusUpdatedAt = nowIso(nowMs);

  return true;
}

function ensureSessionEntry(current, sessionId) {
  if (typeof sessionId !== 'string' || !sessionId) return null;

  if (!current.sessions[sessionId]) {
    current.sessions[sessionId] = {
      lastUserMessageAt: null,
      lastBlueMessageAt: null,
    };
  }

  pruneSessions(current, sessionId);

  return current.sessions[sessionId] || null;
}

function buildWait(current, sessionId, nowMs) {
  const entry =
    sessionId && current.sessions[sessionId]
      ? current.sessions[sessionId]
      : null;

  const lastUserMessageAt = entry ? entry.lastUserMessageAt : null;
  const lastBlueMessageAt = entry ? entry.lastBlueMessageAt : null;

  // Blue 等待用户回复：最后一条 Blue 消息晚于最后一条用户消息（或用户从未回复）。
  const waiting =
    !!lastBlueMessageAt &&
    (!lastUserMessageAt ||
      Date.parse(lastBlueMessageAt) > Date.parse(lastUserMessageAt));

  const waitingSince = waiting ? lastBlueMessageAt : null;

  const waitedSeconds = waiting
    ? Math.max(
        0,
        Math.floor((nowMs - Date.parse(lastBlueMessageAt)) / 1000)
      )
    : 0;

  return {
    waiting,
    sessionId: sessionId || null,
    lastUserMessageAt,
    lastBlueMessageAt,
    waitingSince,
    waitedSeconds,
  };
}

function buildSnapshot(current, sessionId, nowMs) {
  const computed = computeStatus(current, nowMs);
  const lastSeenMs = current.lastSeenAt ? Date.parse(current.lastSeenAt) : NaN;
  const heartbeatExpired =
    !Number.isFinite(lastSeenMs) || nowMs - lastSeenMs > HEARTBEAT_TTL_MS;

  return {
    serverTime: nowIso(nowMs),
    sessionId: sessionId || null,
    lastBlueMessageAt: current.lastBlueMessageAt,
    user: {
      status: computed.status,
      reason: computed.reason,
      lastSeenAt: current.lastSeenAt,
      lastInteractionAt: current.lastInteractionAt,
      statusUpdatedAt: current.statusUpdatedAt,
      appState: current.appState,
      appStateUpdatedAt: current.appStateUpdatedAt,
      lastHeartbeatAt: current.lastHeartbeatAt,
      heartbeatExpired,
      activeWindowSeconds: ACTIVE_INTERACTION_WINDOW_MS / 1000,
      heartbeatTtlSeconds: HEARTBEAT_TTL_MS / 1000,
    },
    wait: buildWait(current, sessionId, nowMs),
  };
}

// ---- 对外 API ----

/**
 * 记录一次客户端上报（前后台切换 / 心跳 / 互动）。
 * - 相同 eventId 的重复请求直接忽略（网络重试 / 重放）
 * - appState 只接受比已记录时间更新的事件（乱序到达的旧事件不会回滚状态）
 */
function recordReport(report, nowMs) {
  const current = loadState();
  const now = Number.isFinite(nowMs) ? nowMs : Date.now();

  const source = report && typeof report === 'object' ? report : {};
  const sessionId =
    typeof source.sessionId === 'string' && source.sessionId
      ? source.sessionId.slice(0, 128)
      : null;

  const eventId =
    typeof source.eventId === 'string' && source.eventId.trim()
      ? source.eventId.trim().slice(0, 128)
      : null;

  if (eventId && current.eventIds.includes(eventId)) {
    return {
      accepted: false,
      duplicate: true,
      presence: buildSnapshot(current, sessionId, now),
    };
  }

  const appState =
    source.appState === APP_STATE.FOREGROUND ||
    source.appState === APP_STATE.BACKGROUND
      ? source.appState
      : null;
  const heartbeat = source.heartbeat === true;
  const interaction = source.interaction === true;

  if (!appState && !heartbeat && !interaction) {
    return {
      accepted: false,
      duplicate: false,
      presence: buildSnapshot(current, sessionId, now),
    };
  }

  current.lastSeenAt = nowIso(now);

  if (heartbeat) current.lastHeartbeatAt = nowIso(now);

  if (appState) {
    const occurredAt = normalizeOccurredAt(source.occurredAt, now);
    const previous = current.appStateUpdatedAt
      ? Date.parse(current.appStateUpdatedAt)
      : -Infinity;

    // 只有不早于已记录时间的事件才生效；同时到达时以最后到达的为准。
    if (occurredAt >= previous) {
      current.appState = appState;
      current.appStateUpdatedAt = nowIso(occurredAt);
    }
  }

  if (interaction) {
    const occurredAt = normalizeOccurredAt(source.occurredAt, now);

    current.lastInteractionAt = maxIso(
      current.lastInteractionAt,
      nowIso(occurredAt)
    );
  }

  if (eventId) {
    current.eventIds.push(eventId);

    if (current.eventIds.length > MAX_EVENT_IDS) {
      current.eventIds = current.eventIds.slice(-MAX_EVENT_IDS);
    }
  }

  recomputeStatus(current, now);
  persist();

  return {
    accepted: true,
    duplicate: false,
    presence: buildSnapshot(current, sessionId, now),
  };
}

/**
 * 记录用户消息（服务端 /chat 收到用户消息时调用）。
 * 同时把最后一次用户互动、lastSeen 和会话内的用户消息时间推进到该时刻。
 * /chat 的请求只能来自前台界面，因此这里也把 appState 显式记为前台。
 */
function recordUserMessage(sessionId, atMs, nowMs) {
  const current = loadState();
  // atMs：用户消息到达时刻（计算互动 / 等待计时）；nowMs：本次写入的服务端时间。
  // 长回复期间心跳可能已把 lastSeenAt 推得更晚，这里只允许前进、不后退。
  const at = Number.isFinite(atMs) ? atMs : Date.now();
  const now = Number.isFinite(nowMs) ? nowMs : Date.now();
  const atIso = nowIso(at);

  const entry = ensureSessionEntry(current, sessionId);

  if (entry) entry.lastUserMessageAt = maxIso(entry.lastUserMessageAt, atIso);

  current.lastSeenAt = maxIso(current.lastSeenAt, nowIso(now));
  current.lastInteractionAt = maxIso(current.lastInteractionAt, atIso);

  const previous = current.appStateUpdatedAt
    ? Date.parse(current.appStateUpdatedAt)
    : -Infinity;

  if (at >= previous) {
    current.appState = APP_STATE.FOREGROUND;
    current.appStateUpdatedAt = atIso;
  }

  recomputeStatus(current, now);
  persist();

  return buildSnapshot(current, sessionId, now);
}

/**
 * 记录 Blue 已发出的消息（服务端 /chat 回复成功返回时调用）。
 * 等待计时从"最后一条 Blue 消息"开始，新的用户消息会把等待清掉。
 */
function recordBlueMessage(sessionId, atMs) {
  const current = loadState();
  const at = Number.isFinite(atMs) ? atMs : Date.now();
  const atIso = nowIso(at);

  const entry = ensureSessionEntry(current, sessionId);

  if (entry) entry.lastBlueMessageAt = maxIso(entry.lastBlueMessageAt, atIso);

  current.lastBlueMessageAt = maxIso(current.lastBlueMessageAt, atIso);

  persist();

  return buildSnapshot(current, sessionId, at);
}

/** 清空 / 撤回会话时，会话内等待状态一并归零，避免残留"Blue 还在等回复"。 */
function resetSessionWait(sessionId) {
  const current = loadState();

  if (!sessionId || !current.sessions[sessionId]) return false;

  current.sessions[sessionId] = {
    lastUserMessageAt: null,
    lastBlueMessageAt: null,
  };

  persist();

  return true;
}

/** 会话被删除时移除对应等待状态，避免 presence.json 残留孤儿条目。 */
function forgetSession(sessionId) {
  const current = loadState();

  if (!sessionId || !current.sessions[sessionId]) return false;

  delete current.sessions[sessionId];

  persist();

  return true;
}

/**
 * 读取当前在线状态快照。读取时按当前时间重新判定，因此超过 5 分钟无互动、
 * 心跳过期等转变无需依赖写入即能正确反映。
 */
function getPresence(sessionId, nowMs) {
  const current = loadState();
  const now = Number.isFinite(nowMs) ? nowMs : Date.now();

  if (recomputeStatus(current, now)) persist();

  return buildSnapshot(current, sessionId, now);
}

module.exports = {
  DATA_DIR,
  PRESENCE_FILE,
  ACTIVE_INTERACTION_WINDOW_MS,
  HEARTBEAT_TTL_MS,
  STATUS,
  APP_STATE,
  recordReport,
  recordUserMessage,
  recordBlueMessage,
  resetSessionWait,
  forgetSession,
  getPresence,
};
