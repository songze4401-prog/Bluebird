/* global module, __dirname, Buffer */
/**
 * Bot 独立会话存储：与主控聊天 sessions.json 完全分离。
 *
 * 隔离键是 botId + sessionId；所有读写都要求两者同时匹配，
 * 主控 /history 与 Bot 工作台不会互相看到对方会话。
 */
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { writeFileAtomicSync } = require('../atomic-write');
const { isKnownBot } = require('./manifest');
const { AgentError } = require('./errors');

const DATA_DIR = process.env.BLUEBIRD_DATA_DIR
  ? path.resolve(process.env.BLUEBIRD_DATA_DIR)
  : path.join(__dirname, '..', 'data');
const AGENTS_DIR = path.join(DATA_DIR, 'agents');
const STORE_FILE = path.join(AGENTS_DIR, 'agent-sessions.json');
const STORE_VERSION = 1;
const MESSAGE_MAX = 1000;
const TITLE_MAX = 60;
const CONTENT_MAX = 12000;
const TOOL_STEPS_MAX = 12;

let cache = null;

function nowIso() {
  return new Date().toISOString();
}

function ensureDir() {
  fs.mkdirSync(AGENTS_DIR, { recursive: true });
}

function emptyStore() {
  return { version: STORE_VERSION, sessions: [], messages: {} };
}

function load() {
  if (cache) return cache;
  ensureDir();
  if (!fs.existsSync(STORE_FILE)) {
    cache = emptyStore();
    return cache;
  }
  let parsed;
  try {
    parsed = JSON.parse(fs.readFileSync(STORE_FILE, 'utf8'));
  } catch (_) {
    throw new AgentError('agent_sessions_corrupted', 'Bot 会话存储无法解析', 500);
  }
  if (
    !parsed ||
    parsed.version !== STORE_VERSION ||
    !Array.isArray(parsed.sessions) ||
    !parsed.messages ||
    typeof parsed.messages !== 'object' ||
    Array.isArray(parsed.messages)
  ) {
    throw new AgentError('agent_sessions_corrupted', 'Bot 会话存储结构无效', 500);
  }
  cache = parsed;
  return cache;
}

function save() {
  ensureDir();
  writeFileAtomicSync(STORE_FILE, JSON.stringify(cache, null, 2));
}

function assertBot(botId) {
  if (!isKnownBot(botId)) {
    throw new AgentError('agent_not_found', 'Agent 不存在', 404);
  }
}

function clone(value) {
  return JSON.parse(JSON.stringify(value));
}

function normalizeTitle(value) {
  const text = typeof value === 'string' ? value.trim() : '';
  return text ? text.slice(0, TITLE_MAX) : '新对话';
}

function findMeta(botId, sessionId) {
  const current = load();
  return (
    current.sessions.find(
      item => item.id === sessionId && item.botId === botId
    ) || null
  );
}

function listSessions(botId) {
  assertBot(botId);
  const current = load();
  return current.sessions
    .filter(item => item.botId === botId)
    .map(item => ({
      id: item.id,
      botId: item.botId,
      title: item.title,
      createdAt: item.createdAt,
      updatedAt: item.updatedAt,
      messageCount: (current.messages[item.id] || []).length,
    }))
    .sort((a, b) => String(b.updatedAt).localeCompare(String(a.updatedAt)));
}

function getSession(botId, sessionId) {
  assertBot(botId);
  const meta = findMeta(botId, sessionId);
  if (!meta) return null;
  const current = load();
  return {
    id: meta.id,
    botId: meta.botId,
    title: meta.title,
    createdAt: meta.createdAt,
    updatedAt: meta.updatedAt,
    messageCount: (current.messages[meta.id] || []).length,
  };
}

function createSession(botId, { title } = {}) {
  assertBot(botId);
  const current = load();
  if (current.sessions.filter(item => item.botId === botId).length >= 200) {
    throw new AgentError('agent_session_limit', 'Bot 会话数量已达上限');
  }
  const t = nowIso();
  const meta = {
    id: `bs_${crypto.randomUUID()}`,
    botId,
    title: normalizeTitle(title),
    createdAt: t,
    updatedAt: t,
  };
  current.sessions.push(meta);
  current.messages[meta.id] = [];
  try {
    save();
  } catch (error) {
    current.sessions.pop();
    delete current.messages[meta.id];
    throw error;
  }
  return { ...meta, messageCount: 0 };
}

function getMessages(botId, sessionId) {
  assertBot(botId);
  const meta = findMeta(botId, sessionId);
  if (!meta) return null;
  const current = load();
  return clone(current.messages[sessionId] || []);
}

function sanitizeToolSteps(value) {
  if (!Array.isArray(value)) return [];
  return value.slice(0, TOOL_STEPS_MAX).map(item => ({
    name: String(item && item.name ? item.name : '').slice(0, 60),
    ok: Boolean(item && item.ok === true),
    summary: String(item && item.summary ? item.summary : '').slice(0, 160),
    durationMs:
      Number.isFinite(item && item.durationMs) && item.durationMs >= 0
        ? Math.floor(item.durationMs)
        : 0,
  }));
}

function sanitizeMessage(message) {
  if (!message || typeof message !== 'object') {
    throw new AgentError('invalid_message', '消息格式无效');
  }
  const role = message.role === 'assistant' ? 'assistant' : message.role === 'user' ? 'user' : null;
  if (!role) throw new AgentError('invalid_message', '消息角色无效');
  const content = typeof message.content === 'string' ? message.content.slice(0, CONTENT_MAX) : '';
  if (!content.trim()) throw new AgentError('invalid_message', '消息内容不能为空');
  return {
    id: typeof message.id === 'string' && message.id ? message.id : crypto.randomUUID(),
    role,
    content,
    createdAt:
      typeof message.createdAt === 'string' && message.createdAt
        ? message.createdAt
        : nowIso(),
    ...(role === 'assistant'
      ? { toolSteps: sanitizeToolSteps(message.toolSteps) }
      : {}),
  };
}

function appendMessages(botId, sessionId, messages) {
  assertBot(botId);
  const current = load();
  const meta = findMeta(botId, sessionId);
  if (!meta) throw new AgentError('agent_session_not_found', 'Bot 会话不存在', 404);
  const incoming = (Array.isArray(messages) ? messages : []).map(sanitizeMessage);
  if (!incoming.length) {
    return { messageCount: (current.messages[sessionId] || []).length };
  }

  const previous = current.messages[sessionId] || [];
  const next = [...previous, ...incoming].slice(-MESSAGE_MAX);
  current.messages[sessionId] = next;
  meta.updatedAt = nowIso();

  try {
    save();
  } catch (error) {
    current.messages[sessionId] = previous;
    throw error;
  }

  return { messageCount: next.length, messages: clone(incoming) };
}

function deleteSession(botId, sessionId) {
  assertBot(botId);
  const current = load();
  const meta = findMeta(botId, sessionId);
  if (!meta) return false;
  const previousSessions = current.sessions;
  const previousMessages = current.messages[sessionId];
  current.sessions = current.sessions.filter(item => item.id !== sessionId);
  delete current.messages[sessionId];
  try {
    save();
  } catch (error) {
    current.sessions = previousSessions;
    current.messages[sessionId] = previousMessages;
    throw error;
  }
  return true;
}

function reloadForTests() {
  cache = null;
}

module.exports = {
  STORE_FILE,
  MESSAGE_MAX,
  listSessions,
  getSession,
  createSession,
  getMessages,
  appendMessages,
  deleteSession,
  reloadForTests,
};
