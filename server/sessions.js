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

// 只读保护：数据文件存在但读不出来（损坏/结构不对）时置位。
// 期间拒绝一切写入、且不做任何自动落盘，避免用重建出的空库覆盖掉
// 待人工恢复的原始文件；内存里仅保留按旧历史拼出的只读回退视图。
let storeReadOnly = false;

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

  const knownIds = new Set(next.sessions.map(meta => meta.id));

  // C5：messages 里存在但 sessions 里没有对应会话的 key（孤儿数据）。
  // 以 sessions 为权威：孤儿消息不并入任何会话，但必须显式告警，
  // 因为下一次 saveStore 会把它永久清掉，静默丢弃等于无声丢数据。
  const orphanIds = Object.keys(source).filter(id => !knownIds.has(id));

  if (orphanIds.length) {
    console.error(
      `Session store orphan messages detected: ${orphanIds.length} key(s) ` +
        `without a matching session -> ${orphanIds.join(', ')}`
    );
    console.error(
      '  这些消息不会并入任何会话，并将在下次写入时从文件中移除。' +
        '如需保留，请先手动备份 sessions.json。'
    );
  }

  for (const meta of next.sessions) {
    const list = Array.isArray(source[meta.id]) ? source[meta.id] : [];
    next.messages[meta.id] = list.slice(-SESSION_MESSAGE_MAX);
  }

  return next;
}

// 结构校验：文件必须是我们存下来的「会话库」形状。
// 合法 JSON 但不是该形状（例如被误写成数组或别的对象）同样按损坏处理，
// 否则会被当成空库静默覆盖，等于把用户数据丢掉。
function isStoreShape(value) {
  return (
    !!value &&
    typeof value === 'object' &&
    !Array.isArray(value) &&
    Array.isArray(value.sessions)
  );
}

// 进入只读保护：原始文件保持原样不动，靠重命名/移走备份的动作一概不做，
// 因为文件留在原路径才最容易被人工发现与恢复；写入由 saveStore 统一拒绝。
function enterReadOnly(reason) {
  storeReadOnly = true;

  console.error('==================================================');
  console.error('会话数据文件不可用，已进入只读保护模式（写入全部被拒绝）');
  console.error(`  文件：${STORE_FILE}（保持原样，未被修改或删除）`);
  console.error(`  原因：${reason}`);
  console.error(
    '  影响：/chat 的回复不会落盘；新建会话、清空、撤回都会返回失败。'
  );
  console.error('  处理：先手动备份该文件，再修复或移走它，然后重启服务。');
  console.error('==================================================');
}

function tryReadStore() {
  let raw;

  try {
    raw = fs.readFileSync(STORE_FILE, 'utf8');
  } catch (error) {
    enterReadOnly(`文件读取失败：${error.message}`);
    return null;
  }

  let parsed;

  try {
    parsed = JSON.parse(raw);
  } catch (error) {
    enterReadOnly(`JSON 解析失败：${error.message}`);
    return null;
  }

  if (!isStoreShape(parsed)) {
    enterReadOnly('内容不是会话库结构（缺少 sessions 数组）');
    return null;
  }

  return sanitizeStore(parsed);
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

  // 旧历史备份只留一份：迁移是在只读文件上做的，重复备份只会堆文件。
  // （只读保护模式下每次启动都会走一次迁移，故需要这个去重。）
  const backupPrefix = `${path.basename(LEGACY_HISTORY_FILE)}.pre-multisession.bak`;
  let hasBackup = false;

  try {
    hasBackup = fs
      .readdirSync(DATA_DIR)
      .some(name => name.startsWith(backupPrefix));
  } catch (error) {
    console.error('Legacy backup scan error:', error.message);
  }

  if (!hasBackup) {
    const backupPath = uniquePath(`${LEGACY_HISTORY_FILE}.pre-multisession.bak`);

    try {
      fs.copyFileSync(LEGACY_HISTORY_FILE, backupPath);
      console.log(`Legacy history backed up: ${backupPath}`);
    } catch (error) {
      console.error('Legacy history backup error:', error.message);
    }
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

  // 只读保护下不做任何自动落盘：磁盘上的原始文件必须原封不动，
  // 内存里这份只是给 /sessions、/history 读的回退视图。
  if (storeReadOnly) return store;

  if (!loadedFromDisk || addedDefault) {
    saveStore();
  }

  return store;
}

// 落盘。返回是否成功——调用方据此回滚内存并向上报错，
// 绝不允许"写失败了还当成功"这种静默丢数据的行为。
function saveStore() {
  if (storeReadOnly) {
    console.error(
      'Session store write refused: read-only protection is active ->',
      STORE_FILE
    );
    return false;
  }

  try {
    fs.mkdirSync(DATA_DIR, { recursive: true });

    const tmpFile = `${STORE_FILE}.tmp`;
    const payload = JSON.stringify(store, null, 2);

    // C2：先写临时文件并 fsync 落盘，再原子 rename 覆盖目标。
    // 只 writeFile + rename 的话，rename 可能先于数据落盘被提交，
    // 断电后目标文件可能变成空文件或旧内容；fsync 把"数据已写稳"钉在
    // rename 之前，把这个窗口关掉。
    // 注：memory.js / emotion.js 仍是旧的 writeFile + rename 写法，
    // 该差异已在 AGENTS.md 记录为已知限制（本阶段不动这两个模块）。
    const fd = fs.openSync(tmpFile, 'w');

    try {
      fs.writeFileSync(fd, payload, 'utf8');
      fs.fsyncSync(fd);
    } finally {
      fs.closeSync(fd);
    }

    fs.renameSync(tmpFile, STORE_FILE);

    console.log('Session store saved:', store.sessions.length, 'sessions');
    return true;
  } catch (error) {
    console.error(
      'Session store save FAILED:',
      error.message,
      '->',
      STORE_FILE
    );
    return false;
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

  if (!saveStore()) {
    // 落盘失败：回滚内存，保证内存视图与磁盘事实一致
    current.sessions.pop();
    delete current.messages[meta.id];
    return null;
  }

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
  const prevUpdatedAt = meta.updatedAt;

  current.messages[sessionId] = [...existing, ...stamped].slice(
    -SESSION_MESSAGE_MAX
  );
  meta.updatedAt = createdAt;

  if (!saveStore()) {
    // 落盘失败：回滚内存，避免内存里多出磁盘上不存在的消息
    current.messages[sessionId] = existing;
    meta.updatedAt = prevUpdatedAt;
    return null;
  }

  return stamped;
}

// 用给定数组整体替换某会话消息（撤回/清理用）。刻意不改 updatedAt：
// updatedAt 语义是"最后一条消息时间"，只由 appendMessages 推进。
function replaceMessages(sessionId, messages) {
  const current = loadStore();

  if (!findMeta(sessionId)) return false;

  const prev = current.messages[sessionId] || [];

  current.messages[sessionId] = messages.slice(-SESSION_MESSAGE_MAX);

  if (!saveStore()) {
    // 落盘失败：回滚内存，避免撤回/清空只在内存里生效
    current.messages[sessionId] = prev;
    return false;
  }

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
