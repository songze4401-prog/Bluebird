/**
 * 云岫 Bluebird — 统一检索数据契约（retrieval/contract.js）
 *
 * 每个可检索 chunk 的稳定身份由 sourceType + sourceId + 切片规则版本 +
 * 内容哈希 + locator 共同决定；内容变化会产生新 chunkId，旧 chunk 由
 * 索引生命周期清理，避免“同 id 悄悄换内容”。
 *
 * 约束：
 * - content 是规范化后的检索文本，不改写原始来源；
 * - scope 显式声明可见域，绝不把不同会话/权限域混在一起只靠提示词隔离；
 * - metadata 只允许浅层标量/字符串数组，禁止把任意对象塞进索引。
 */
const crypto = require('crypto');

const CHUNK_SCHEMA_VERSION = 1;
const CHUNK_RULE_VERSION = 'v1';
const SOURCE_TYPES = Object.freeze([
  'memory',
  'conversation',
  'document',
  'web',
  'code',
]);
const SOURCE_TYPE_SET = new Set(SOURCE_TYPES);
const VISIBILITIES = new Set(['global', 'session']);

const MAX_TITLE = 200;
const MAX_URI = 500;
const MAX_LOCATOR = 240;
const MAX_SOURCE_ID = 160;
const MAX_VERSION = 200;
const MAX_LANGUAGE = 32;
const MAX_MIME = 80;
const MAX_METADATA_KEYS = 24;
const MAX_METADATA_STRING = 300;
const MAX_METADATA_ARRAY = 40;
const MAX_CONTENT_CHARS = 12000;

function stripControl(value) {
  return String(value === undefined || value === null ? '' : value).replace(
    /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g,
    ''
  );
}

function cleanText(value, max) {
  const text = stripControl(value).trim();
  if (!max || text.length <= max) return text;
  return text.slice(0, max);
}

function normalizeContent(value) {
  return stripControl(value)
    .replace(/\r\n?/g, '\n')
    .split('\n')
    .map(line => line.replace(/[ \t]+$/, ''))
    .join('\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

function sha256(value) {
  return crypto.createHash('sha256').update(String(value)).digest('hex');
}

function contentHashOf(content) {
  return sha256(normalizeContent(content));
}

function stableChunkId({ sourceType, sourceId, locator, contentHash }) {
  return (
    'chk_' +
    sha256(
      [sourceType, sourceId, CHUNK_RULE_VERSION, contentHash, locator].join('\u0000')
    ).slice(0, 32)
  );
}

function normalizeScope(scope) {
  if (!scope || typeof scope !== 'object') {
    return { visibility: 'global' };
  }
  if (scope.visibility === 'global') return { visibility: 'global' };
  if (scope.visibility === 'session') {
    const sessions = Array.isArray(scope.sessions)
      ? scope.sessions
          .filter(id => typeof id === 'string' && id && id.length <= 120)
          .slice(0, 100)
      : [];
    if (!sessions.length) throw new Error('invalid_scope_sessions');
    return { visibility: 'session', sessions: [...new Set(sessions)] };
  }
  throw new Error('invalid_scope_visibility');
}

function sanitizeMetadata(raw) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return {};
  const out = {};
  let keys = 0;

  for (const [key, value] of Object.entries(raw)) {
    if (keys >= MAX_METADATA_KEYS) break;
    if (typeof key !== 'string' || !/^[a-zA-Z][a-zA-Z0-9_]{0,39}$/.test(key)) {
      continue;
    }
    if (typeof value === 'string') {
      out[key] = cleanText(value, MAX_METADATA_STRING);
      keys += 1;
      continue;
    }
    if (typeof value === 'number' && Number.isFinite(value)) {
      out[key] = value;
      keys += 1;
      continue;
    }
    if (typeof value === 'boolean') {
      out[key] = value;
      keys += 1;
      continue;
    }
    if (Array.isArray(value)) {
      out[key] = value
        .filter(item => typeof item === 'string')
        .slice(0, MAX_METADATA_ARRAY)
        .map(item => cleanText(item, MAX_METADATA_STRING));
      keys += 1;
    }
  }

  return out;
}

function cleanTimestamp(value) {
  return typeof value === 'string' &&
    value.length <= 40 &&
    Number.isFinite(Date.parse(value))
    ? new Date(value).toISOString()
    : null;
}

function createChunk(input) {
  const sourceType = input && input.sourceType;
  if (!SOURCE_TYPE_SET.has(sourceType)) {
    throw new Error('invalid_source_type');
  }

  const sourceId = cleanText(input.sourceId, MAX_SOURCE_ID);
  if (!sourceId) throw new Error('missing_source_id');

  const content = normalizeContent(input.content);
  if (!content) throw new Error('empty_content');
  if (content.length > MAX_CONTENT_CHARS) {
    throw new Error('content_too_large');
  }

  const locator = cleanText(input.locator || sourceId, MAX_LOCATOR) || sourceId;
  const contentHash = contentHashOf(content);
  const now = new Date().toISOString();

  return {
    schemaVersion: CHUNK_SCHEMA_VERSION,
    ruleVersion: CHUNK_RULE_VERSION,
    chunkId: stableChunkId({ sourceType, sourceId, locator, contentHash }),
    sourceType,
    sourceId,
    content,
    contentHash,
    title: cleanText(input.title || '', MAX_TITLE),
    uri: cleanText(input.uri || '', MAX_URI),
    locator,
    language: cleanText(input.language || '', MAX_LANGUAGE),
    mimeType: cleanText(input.mimeType || '', MAX_MIME),
    tokenCount:
      Number.isFinite(input.tokenCount) && input.tokenCount > 0
        ? Math.floor(input.tokenCount)
        : 0,
    createdAt: cleanTimestamp(input.createdAt) || now,
    updatedAt: cleanTimestamp(input.updatedAt) || now,
    indexedAt: now,
    validFrom: cleanTimestamp(input.validFrom),
    validTo: cleanTimestamp(input.validTo),
    status: input.status === 'superseded' || input.status === 'archived'
      ? input.status
      : 'active',
    sourceVersion: cleanText(input.sourceVersion || '', MAX_VERSION) || null,
    scope: normalizeScope(input.scope),
    metadata: sanitizeMetadata(input.metadata),
  };
}

function validateChunk(chunk) {
  if (!chunk || typeof chunk !== 'object') return 'not_object';
  if (chunk.schemaVersion !== CHUNK_SCHEMA_VERSION) return 'schema_version';
  if (!SOURCE_TYPE_SET.has(chunk.sourceType)) return 'source_type';
  if (typeof chunk.sourceId !== 'string' || !chunk.sourceId) return 'source_id';
  if (typeof chunk.content !== 'string' || !chunk.content) return 'content';
  if (chunk.content.length > MAX_CONTENT_CHARS) return 'content_too_large';
  if (typeof chunk.chunkId !== 'string' || !/^chk_[a-f0-9]{32}$/.test(chunk.chunkId)) {
    return 'chunk_id';
  }
  const expected = stableChunkId({
    sourceType: chunk.sourceType,
    sourceId: chunk.sourceId,
    locator: chunk.locator,
    contentHash: chunk.contentHash,
  });
  if (expected !== chunk.chunkId) return 'chunk_id_mismatch';
  if (typeof chunk.contentHash !== 'string' || !/^[a-f0-9]{64}$/.test(chunk.contentHash)) {
    return 'content_hash';
  }
  if (!chunk.scope || !VISIBILITIES.has(chunk.scope.visibility)) return 'scope';
  if (
    chunk.scope.visibility === 'session' &&
    (!Array.isArray(chunk.scope.sessions) || !chunk.scope.sessions.length)
  ) {
    return 'scope_sessions';
  }
  for (const key of ['title', 'uri', 'locator']) {
    if (typeof chunk[key] !== 'string') return key;
  }
  return null;
}

function sourceIdFor(type, raw) {
  if (!SOURCE_TYPE_SET.has(type)) throw new Error('invalid_source_type');
  return `${type}:${sha256(raw).slice(0, 24)}`;
}

module.exports = {
  CHUNK_SCHEMA_VERSION,
  CHUNK_RULE_VERSION,
  SOURCE_TYPES,
  SOURCE_TYPE_SET,
  MAX_CONTENT_CHARS,
  normalizeContent,
  contentHashOf,
  sha256,
  stableChunkId,
  normalizeScope,
  sanitizeMetadata,
  createChunk,
  validateChunk,
  sourceIdFor,
};
