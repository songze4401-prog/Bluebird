/**
 * 云岫 Bluebird — 长期记忆连接器（retrieval/connectors/memory.js）
 *
 * 长期记忆的 canonical source 仍是 memory.js；本连接器只生成派生 chunk。
 * 作用域是「用户级」（P1）：长期记忆属于用户，不属于某个会话，因此同一用户的
 * 任意会话都能检索到。派生 chunk 带 visibility='user' + userId，由
 * retrieval/engine.js 的 scopeAllows 按可信用户身份过滤。
 */
const memory = require('../../memory');
const { isEffectiveAt } = require('../../memory-lifecycle');
const { getInstanceUserId } = require('../../user-scope');
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
  let skippedNonEffective = 0;

  for (const item of items) {
    if (!item || typeof item.content !== 'string' || !item.content.trim()) continue;
    scanned += 1;

    // 生命周期一致性：只索引当前有效的记忆（active 且在 validFrom/validTo 窗口内）。
    // pending / superseded / archived 条目不入索引，引擎不再可能把它们当现行事实检索到。
    if (!isEffectiveAt(item)) {
      skippedNonEffective += 1;
      continue;
    }

    // 归属用户由 stampIdentity 在读盘时补齐；缺失时按实例用户处理（单实例部署）。
    const userId =
      typeof item.userId === 'string' && item.userId.trim()
        ? item.userId.trim()
        : getInstanceUserId();

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
        scope: { visibility: 'user', userId },
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
          ownerUserId: userId,
          chunkCount: chunks.length,
        },
      },
      chunks,
    });
  }

  return {
    sources,
    scanned,
    skipped: skippedNonEffective,
    skippedNonEffective,
    reason: null,
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
          // 与 collectMemoryChunks 保持同一生命周期口径：只保留当前有效记忆的源。
          isEffectiveAt(item)
      )
      .map(item => `memory:${item.id}`)
  );
}

module.exports = { collectMemoryChunks, sourceIdsForMemory };
