/* 记忆删除墓碑：删除/撤回/清空后阻止同源异步写入复活。
 *
 * 只存哈希与来源标识，不存正文或原话；墓碑文件是派生保护数据，
 * 与 memory.json 分开原子落盘，避免改变现有记忆条目的磁盘形状。
 */
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const { writeFileAtomic } = require('./atomic-write');

const TOMBSTONE_VERSION = 1;
const MESSAGE_MATCH_TTL_MS = 24 * 60 * 60 * 1000;
const CONTENT_MATCH_TTL_MS = 10 * 60 * 1000;
const RETENTION_MS = 30 * 24 * 60 * 60 * 1000;
const MAX_TOMBSTONES = 5000;

function normalizeText(value) {
  return typeof value === 'string'
    ? value.replace(/\s+/g, ' ').trim().toLowerCase()
    : '';
}

function cleanId(value) {
  return typeof value === 'string' && value.trim() ? value.trim() : null;
}

function hashText(value) {
  const text = normalizeText(value);
  if (!text) return null;
  return crypto.createHash('sha256').update(text).digest('hex');
}

function normalizeSources(contributions) {
  const sources = [];
  const seen = new Set();

  for (const contribution of Array.isArray(contributions) ? contributions : []) {
    if (!contribution || !contribution.sourceQuote) continue;

    const source = {
      sessionId: cleanId(contribution.sessionId),
      messageId: cleanId(contribution.messageId),
      sourceQuoteHash: hashText(contribution.sourceQuote),
    };
    const key = JSON.stringify([
      source.sessionId,
      source.messageId,
      source.sourceQuoteHash,
    ]);

    if (!source.sourceQuoteHash || seen.has(key)) continue;
    seen.add(key);
    sources.push(source);
  }

  return sources;
}

function createTombstone(entry, { reason = 'delete', now = new Date().toISOString() } = {}) {
  if (!entry || typeof entry !== 'object' || typeof entry.content !== 'string') {
    return null;
  }

  const sources = normalizeSources(entry.contributions);

  // 旧条目可能只有平铺的 sourceQuote/sessionId，没有 contributions。
  if (!sources.length && entry.sourceQuote) {
    const source = {
      sessionId: cleanId(entry.sessionId),
      messageId: null,
      sourceQuoteHash: hashText(entry.sourceQuote),
    };

    if (source.sourceQuoteHash) sources.push(source);
  }

  return {
    version: TOMBSTONE_VERSION,
    id: `tomb-${crypto.randomUUID()}`,
    entryId: cleanId(entry.id),
    userId: cleanId(entry.userId),
    contentHash: hashText(entry.content),
    deletedAt: now,
    reason,
    sources,
  };
}

function isValidTombstone(value) {
  if (!value || typeof value !== 'object') return false;
  if (value.version !== TOMBSTONE_VERSION) return false;
  if (typeof value.id !== 'string' || !value.id) return false;
  if (!Number.isFinite(Date.parse(value.deletedAt))) return false;
  if (!Array.isArray(value.sources)) return false;

  return value.sources.every(
    source =>
      source &&
      typeof source === 'object' &&
      (source.sessionId === null || typeof source.sessionId === 'string') &&
      (source.messageId === null || typeof source.messageId === 'string') &&
      (source.sourceQuoteHash === null ||
        typeof source.sourceQuoteHash === 'string')
  );
}

function pruneTombstones(tombstones, nowMs = Date.now()) {
  const cutoff = nowMs - RETENTION_MS;

  return (Array.isArray(tombstones) ? tombstones : [])
    .filter(
      tombstone =>
        isValidTombstone(tombstone) &&
        Date.parse(tombstone.deletedAt) >= cutoff
    )
    .sort((a, b) => Date.parse(b.deletedAt) - Date.parse(a.deletedAt))
    .slice(0, MAX_TOMBSTONES);
}

function loadTombstones(file) {
  try {
    if (!fs.existsSync(file)) {
      return { tombstones: [], corrupt: false, reason: null, error: null };
    }

    const parsed = JSON.parse(fs.readFileSync(file, 'utf8'));

    if (!Array.isArray(parsed)) {
      return {
        tombstones: [],
        corrupt: true,
        reason: 'invalid_shape',
        error: null,
      };
    }

    const tombstones = parsed.filter(isValidTombstone);

    return {
      tombstones: pruneTombstones(tombstones),
      corrupt: tombstones.length !== parsed.length,
      reason: tombstones.length !== parsed.length ? 'invalid_entry' : null,
      error: null,
    };
  } catch (error) {
    return {
      tombstones: [],
      corrupt: true,
      reason:
        error && error.code === 'ENOENT' ? 'file_missing' : 'json_parse_error',
      error,
    };
  }
}

async function saveTombstones(file, tombstones) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  await writeFileAtomic(
    file,
    JSON.stringify(pruneTombstones(tombstones), null, 2)
  );
}

function appendTombstones(existing, entries, options = {}) {
  const list = Array.isArray(existing) ? existing.slice() : [];
  const now = options.now || new Date().toISOString();

  for (const entry of Array.isArray(entries) ? entries : []) {
    const tombstone = createTombstone(entry, {
      reason: options.reason || 'delete',
      now,
    });

    if (!tombstone) continue;

    const duplicate = list.some(
      item =>
        item &&
        item.entryId === tombstone.entryId &&
        item.contentHash === tombstone.contentHash &&
        item.deletedAt === tombstone.deletedAt
    );

    if (!duplicate) list.push(tombstone);
  }

  return pruneTombstones(list);
}

// 返回命中短码或 null。只拦截能证明是同一来源的候选：当前异步抽取和
// Agent 写入都带 messageId；没有 messageId 的新语句按新来源处理，避免误挡。
function tombstoneBlocksCandidate(
  tombstones,
  candidate,
  scope = {},
  nowMs = Date.now()
) {
  if (!candidate || typeof candidate.content !== 'string') return null;

  const firstContribution =
    candidate.contributions && candidate.contributions[0]
      ? candidate.contributions[0]
      : null;
  const messageId = cleanId(firstContribution && firstContribution.messageId);

  if (!messageId) return null;

  const sourceQuoteHash = hashText(
    (firstContribution && firstContribution.sourceQuote) ||
      candidate.sourceQuote
  );
  const userId = scope.mode === 'user' ? cleanId(scope.userId) : null;
  const sessionId = cleanId(scope.sessionId);

  for (const tombstone of Array.isArray(tombstones) ? tombstones : []) {
    if (!tombstone || !Number.isFinite(Date.parse(tombstone.deletedAt))) {
      continue;
    }

    const age = nowMs - Date.parse(tombstone.deletedAt);
    if (age < 0 || age > RETENTION_MS) continue;

    const tombstoneUser = cleanId(tombstone.userId);
    if (userId && tombstoneUser && tombstoneUser !== userId) continue;

    const sources = Array.isArray(tombstone.sources) ? tombstone.sources : [];
    const sessionMatches = source =>
      !sessionId || !source.sessionId || source.sessionId === sessionId;

    const sourceHit = sources.some(source => {
      if (
        source.messageId &&
        source.messageId === messageId &&
        age <= MESSAGE_MATCH_TTL_MS
      ) {
        return true;
      }

      // 旧墓碑没有 messageId 时，只在一个短窗口内按原话+会话兜底。
      return (
        !source.messageId &&
        sourceQuoteHash &&
        source.sourceQuoteHash === sourceQuoteHash &&
        sessionMatches(source) &&
        age <= CONTENT_MATCH_TTL_MS
      );
    });

    if (sourceHit) return 'deleted_source';
  }

  return null;
}

module.exports = {
  TOMBSTONE_VERSION,
  MESSAGE_MATCH_TTL_MS,
  CONTENT_MATCH_TTL_MS,
  RETENTION_MS,
  MAX_TOMBSTONES,
  hashText,
  createTombstone,
  loadTombstones,
  saveTombstones,
  appendTombstones,
  pruneTombstones,
  tombstoneBlocksCandidate,
};
