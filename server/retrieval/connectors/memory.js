/**
 * 云岫 Bluebird — 长期记忆连接器（retrieval/connectors/memory.js）
 *
 * 长期记忆的 canonical source 仍是 memory.js；本连接器只生成派生 chunk。
 * 只索引带明确会话归属（contributions[].sessionId）的有效记忆：
 * 无法判断归属的旧条目继续走原 memory_search，不进入统一索引，
 * 避免把“无归属”误当成“所有会话可见”。
 */
const memory = require('../../memory');
const {
  createChunk,
  contentHashOf,
  sha256,
} = require('../contract');
const { splitPlainText, detectLanguage } = require('../text');

function collectMemoryChunks({ maxChunkChars }) {
  if (!memory.MEMORY_ENABLED) {
    return { sources: [], scanned: 0, skipped: 0, reason: 'memory_disabled' };
  }

  const items = memory.getMemories();
  const sources = [];
  let scanned = 0;
  let skippedLegacy = 0;

  for (const item of items) {
    if (!item || typeof item.content !== 'string' || !item.content.trim()) continue;
    scanned += 1;

    const sessions = [
      ...new Set(
        (Array.isArray(item.contributions) ? item.contributions : [])
          .map(contribution => contribution && contribution.sessionId)
          .filter(sessionId => typeof sessionId === 'string' && sessionId)
      ),
    ];

    if (!sessions.length) {
      skippedLegacy += 1;
      continue;
    }

    const sourceId = `memory:${item.id}`;
    const parts = splitPlainText(item.content, maxChunkChars);
    if (!parts.length) continue;

    const chunks = parts.map((part, index) =>
      createChunk({
        sourceType: 'memory',
        sourceId,
        content: part,
        title: `记忆：${item.type || 'fact'}`,
        uri: `memory://${item.id}`,
        locator: `memory/${item.id}${parts.length > 1 ? `#p${index + 1}` : ''}`,
        language: detectLanguage(part),
        mimeType: 'text/plain',
        createdAt: item.createdAt,
        updatedAt: item.updatedAt || item.createdAt,
        validFrom: item.validFrom,
        validTo: item.validTo,
        status: 'active',
        sourceVersion: sha256(
          [item.id, item.updatedAt || item.createdAt, item.status || 'active'].join('|')
        ).slice(0, 32),
        scope: { visibility: 'session', sessions },
        metadata: {
          memoryId: item.id,
          memoryType: item.type || 'fact',
          confidence: Number.isFinite(item.confidence) ? item.confidence : null,
          keywords: Array.isArray(item.keywords) ? item.keywords.slice(0, 20) : [],
          sourceTypes: Array.isArray(item.sourceTypes) ? item.sourceTypes.slice(0, 8) : [],
          exactTerms: Array.isArray(item.keywords) ? item.keywords.slice(0, 20) : [],
        },
      })
    );

    const newest = chunks.reduce(
      (latest, chunk) => (chunk.updatedAt > latest ? chunk.updatedAt : latest),
      chunks[0].updatedAt
    );

    sources.push({
      source: {
        id: sourceId,
        type: 'memory',
        title: `记忆：${item.type || 'fact'}`,
        uri: `memory://${item.id}`,
        state: 'indexed',
        sourceVersion: chunks[0].sourceVersion,
        contentHash: contentHashOf(item.content),
        createdAt: item.createdAt,
        updatedAt: newest,
        metadata: {
          memoryType: item.type || 'fact',
          sessionCount: sessions.length,
          chunkCount: chunks.length,
        },
      },
      chunks,
    });
  }

  return {
    sources,
    scanned,
    skipped: skippedLegacy,
    reason: skippedLegacy ? 'legacy_unscoped_memories_skipped' : null,
  };
}

function sourceIdsForMemory() {
  return new Set(
    memory
      .getMemories()
      .filter(
        item =>
          item &&
          item.id &&
          Array.isArray(item.contributions) &&
          item.contributions.some(
            contribution => contribution && contribution.sessionId
          )
      )
      .map(item => `memory:${item.id}`)
  );
}

module.exports = { collectMemoryChunks, sourceIdsForMemory };
