/* global __dirname */
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

// 数据目录可通过 BLUEBIRD_DATA_DIR 覆盖：测试用临时目录，避免碰到真实数据。
// 未设置时与 memory.js / emotion.js 保持一致，落在 server/data/。
const DATA_DIR = process.env.BLUEBIRD_DATA_DIR
  ? path.resolve(process.env.BLUEBIRD_DATA_DIR)
  : path.join(__dirname, 'data');

const STORE_FILE = path.join(DATA_DIR, 'sessions.json');
// 多会话改造前的唯一历史文件：只读取与备份，永不删除或覆盖。
const LEGACY_HISTORY_FILE = path.join(DATA_DIR, 'chat-history.json');

const DEFAULT_SESSION_ID = 'default';
const DEFAULT_SESSION_TITLE = '默认会话';
const NEW_SESSION_TITLE = '新会话';
const SESSION_MESSAGE_MAX = 200;
const STORE_VERSION = 1;

// 内存缓存：与旧 chat-historyCache 同思路，避免每次 /chat、/history 都读盘。
// 所有写操作都经 saveStore 落盘，保证缓存与文件一致。
let store = null;

function nowIso() {
  return new Date().toISOString();
}

function emptyStore() {
  return { version: STORE_VERSION, sessions: [], messages: {} };
}

function statMtime(file) {
  try {
    return fs.statSync(file).mtime.toISOString();
  } catch {
    return nowIso();
  }
}

// 备份文件名唯一化：绝不覆盖已存在的备份
function uniquePath(base) {
  if (!fs.existsSync(base)) return base;

  let index = 1;
  let candidate = `${base}-${index}`;

  while (fs.existsSync(candidate)) {
    index++;
    candidate = `${base}-${index}`;
  }

  return candidate;
}

// 迁移旧数据时的补齐逻辑：与旧 loadChatHistory 完全一致，保证不丢字段、不丢条目
function migrateLegacyItems(list, fallbackCreatedAt) {
  return list
    .map(item =>
      item && typeof item === 'object'
        ? {
            ...item,
            id: item.id || crypto.randomUUID(),
            createdAt: item.createdAt || fallbackCreatedAt,
          }
        : item
    )
    .slice(-SESSION_MESSAGE_MAX);
}

function sanitizeStore(parsed) {
  const next = emptyStore();

  if (parsed && Array.isArray(parsed.sessions)) {
    for (const item of parsed.sessions) {
      if (!item || typeof item !== 'object') continue;
      if (typeof item.id !== 'string' || !item.id) continue;

      const createdAt =
        typeof item.createdAt === 'string' && item.createdAt
          ? item.createdAt
          : nowIso();

      next.sessions.push({
        id: item.id,
        title:
          typeof item.title === 'string' && item.title.trim()
            ? item.title.trim()
            : DEFAULT_SESSION_TITLE,
        createdAt,
        updatedAt:
          typeof item.updatedAt === 'string' && item.updatedAt
            ? item.updatedAt
            : createdAt,
      });
    }
  }

  const source =
    parsed && parsed.messages && typeof parsed.messages === 'object'
      ? parsed.messages
      : {};

  for (const meta of next.sessions) {
    const list = Array.isArray(source[meta.id]) ? source[meta.id] : [];
    next.messages[meta.id] = list.slice(-SESSION_MESSAGE_MAX);
  }

  return next;
}

function tryReadStore() {
  try {
    const parsed = JSON.parse(fs.readFileSync(STORE_FILE, 'utf8'));
    return sanitizeStore(parsed);
  } catch (error) {
    console.error('Session store load error:', error.message);

    try {
      const corruptPath = `${STORE_FILE}.corrupt-${Date.now()}`;
      fs.renameSync(STORE_FILE, corruptPath);
      console.error(`Corrupt session store backed up: ${corruptPath}`);
    } catch (backupError) {
      console.error('Session store backup error:', backupError.message);
    }

    return null;
  }
}

// 首次启动（无 sessions.json）：把旧的单份 chat-history.json 迁进「默认会话」。
// 先复制一份备份，原始文件原地保留，不做任何删除或覆盖。
function importLegacyHistory() {
  if (!fs.existsSync(LEGACY_HISTORY_FILE)) return false;

  let list;

  try {
    const parsed = JSON.parse(fs.readFileSync(LEGACY_HISTORY_FILE, 'utf8'));
    list = Array.isArray(parsed) ? parsed : [];
  } catch (error) {
    console.error('Legacy history read error:', error.message);
    return false;
  }

  const backupPath = uniquePath(`${LEGACY_HISTORY_FILE}.pre-multisession.bak`);

  try {
    fs.copyFileSync(LEGACY_HISTORY_FILE, backupPath);
    console.log(`Legacy history backed up: ${backupPath}`);
  } catch (error) {
    console.error('Legacy history backup error:', error.message);
  }

  const fallbackCreatedAt = statMtime(LEGACY_HISTORY_FILE);
  const messages = migrateLegacyItems(list, fallbackCreatedAt);

  store.sessions.push({
    id: DEFAULT_SESSION_ID,
    title: DEFAULT_SESSION_TITLE,
    createdAt: (messages[0] && messages[0].createdAt) || fallbackCreatedAt,
    updatedAt:
      (messages[messages.length - 1] && messages[messages.length - 1].createdAt) ||
      fallbackCreatedAt,
  });
  store.messages[DEFAULT_SESSION_ID] = messages;

  console.log(
    `Legacy history migrated: ${messages.length} messages -> session "${DEFAULT_SESSION_ID}"`
  );

  return true;
}

function ensureDefaultSession() {
  if (store.sessions.some(item => item.id === DEFAULT_SESSION_ID)) return false;

  const t = nowIso();

  store.sessions.push({
    id: DEFAULT_SESSION_ID,
    title: DEFAULT_SESSION_TITLE,
    createdAt: t,
    updatedAt: t,
  });
  store.messages[DEFAULT_SESSION_ID] = [];

  return true;
}

function loadStore() {
  if (store) return store;

  try {
    fs.mkdirSync(DATA_DIR, { recursive: true });
  } catch (error) {
    console.error('Session data dir error:', error.message);
  }

  let loadedFromDisk = false;

  if (fs.existsSync(STORE_FILE)) {
    const parsed = tryReadStore();

    if (parsed) {
      store = parsed;
      loadedFromDisk = true;
    }
  }

  if (!loadedFromDisk) {
    store = emptyStore();
    importLegacyHistory();
  }

  // 保证「默认会话」始终存在：无 sessionId 的旧客户端请求全部落到它上面
  const addedDefault = ensureDefaultSession();

  if (!loadedFromDisk || addedDefault) {
    saveStore();
  }

  return store;
}

function saveStore() {
  try {
    fs.mkdirSync(DATA_DIR, { recursive: true });

    const tmpFile = `${STORE_FILE}.tmp`;

    fs.writeFileSync(tmpFile, JSON.stringify(store, null, 2), 'utf8');
    fs.renameSync(tmpFile, STORE_FILE);

    console.log('Session store saved:', store.sessions.length, 'sessions');
  } catch (error) {
    console.error('Session store save error:', error.message);
  }
}

function findMeta(sessionId) {
  return store.sessions.find(item => item.id === sessionId) || null;
}

// ---- 对外 API ----

function listSessions() {
  const current = loadStore();

  return current.sessions
    .map(meta => ({
      id: meta.id,
      title: meta.title,
      createdAt: meta.createdAt,
      updatedAt: meta.updatedAt,
      messageCount: (current.messages[meta.id] || []).length,
    }))
    .sort((a, b) => new Date(b.updatedAt) - new Date(a.updatedAt));
}

function getSession(sessionId) {
  const current = loadStore();
  const meta = findMeta(sessionId);

  if (!meta) return null;

  return {
    id: meta.id,
    title: meta.title,
    createdAt: meta.createdAt,
    updatedAt: meta.updatedAt,
    messageCount: (current.messages[meta.id] || []).length,
  };
}

function createSession({ title } = {}) {
  const current = loadStore();
  const t = nowIso();

  const meta = {
    id: crypto.randomUUID(),
    title:
      typeof title === 'string' && title.trim()
        ? title.trim().slice(0, 60)
        : NEW_SESSION_TITLE,
    createdAt: t,
    updatedAt: t,
  };

  current.sessions.push(meta);
  current.messages[meta.id] = [];
  saveStore();

  return { ...meta, messageCount: 0 };
}

// 读取某会话消息。会话不存在返回 null（调用方据此回 404）；
// 会话存在但为空返回 []（合法空会话）。
function getMessages(sessionId, limit) {
  const current = loadStore();

  if (!findMeta(sessionId)) return null;

  const list = current.messages[sessionId] || [];
  const cap =
    Number.isFinite(limit) && limit > 0
      ? Math.min(limit, SESSION_MESSAGE_MAX)
      : SESSION_MESSAGE_MAX;

  return list.slice(-cap).map(item => ({ ...item }));
}

// 追加消息到指定会话，返回带 id/createdAt 的消息数组；会话不存在返回 null
function appendMessages(sessionId, messages) {
  const current = loadStore();
  const meta = findMeta(sessionId);

  if (!meta) return null;

  const createdAt = nowIso();

  const stamped = messages.map(item => ({
    id: item.id || crypto.randomUUID(),
    role: item.role,
    content: String(item.content),
    createdAt: item.createdAt || createdAt,
  }));

  const existing = current.messages[sessionId] || [];

  current.messages[sessionId] = [...existing, ...stamped].slice(
    -SESSION_MESSAGE_MAX
  );
  meta.updatedAt = createdAt;

  saveStore();

  return stamped;
}

// 用给定数组整体替换某会话消息（撤回/清理用）。刻意不改 updatedAt：
// updatedAt 语义是"最后一条消息时间"，只由 appendMessages 推进。
function replaceMessages(sessionId, messages) {
  const current = loadStore();

  if (!findMeta(sessionId)) return false;

  current.messages[sessionId] = messages.slice(-SESSION_MESSAGE_MAX);
  saveStore();

  return true;
}

module.exports = {
  DEFAULT_SESSION_ID,
  DEFAULT_SESSION_TITLE,
  NEW_SESSION_TITLE,
  SESSION_MESSAGE_MAX,
  DATA_DIR,
  STORE_FILE,
  LEGACY_HISTORY_FILE,
  listSessions,
  getSession,
  createSession,
  getMessages,
  appendMessages,
  replaceMessages,
};
