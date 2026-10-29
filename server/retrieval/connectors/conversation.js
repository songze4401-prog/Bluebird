/**
 * 云岫 Bluebird — 历史对话连接器（retrieval/connectors/conversation.js）
 *
 * 只索引当前会话的消息，chunk scope 固定为本会话；不做跨会话全局索引。
 * 检索只提供“更早对话原文”的证据通道，是否注入上下文仍由 Context Engine
 * 的历史选择/去重决定，不在这里改变对话轮次结构。
 */
const sessions = require('../../sessions');
const { createChunk, contentHashOf, sha256 } = require('../contract');
const { splitPlainText, detectLanguage, exactTerms } = require('../text');
const { textLength } = require('../../text-utils');

function collectConversationChunks(sessionId, { maxChunkChars }) {
  const id = typeof sessionId === 'string' ? sessionId.trim() : '';
  if (!id) return { exists: false, empty: true, source: null, chunks: [] };

  const meta = sessions.getSession(id);
  if (!meta) return { exists: false, empty: true, source: null, chunks: [] };

  const messages = sessions.getMessages(id) || [];
  const selected = [];

  for (let index = 0; index < messages.length; index += 1) {
    const message = messages[index];
    if (!message || (message.role !== 'user' && message.role !== 'assistant')) {
      continue;
    }
    if (typeof message.content !== 'string' || !message.content.trim()) continue;

    const parts = splitPlainText(message.content, maxChunkChars);
    if (!parts.length) continue;
    selected.push({ message, index, parts });
  }

  if (!selected.length) {
    return { exists: true, empty: true, source: null, chunks: [] };
  }

  const sourceVersion = sha256(
    selected
      .map(entry => hashMessage(entry.message))
      .join('|') +
      '|' +
      textLength(messages.map(item => item.content || '').join(''))
  ).slice(0, 32);

  const chunks = [];
  for (const { message, index, parts } of selected) {
    for (let partIndex = 0; partIndex < parts.length; partIndex += 1) {
      const part = parts[partIndex];
      chunks.push(
        createChunk({
          sourceType: 'conversation',
          sourceId: `conversation:${id}`,
          content: part,
          title: meta.title || '会话历史',
          uri: `session://${id}`,
          locator: `message/${message.id}${parts.length > 1 ? `#p${partIndex + 1}` : ''}`,
          language: detectLanguage(part),
          mimeType: 'text/plain',
          createdAt: message.createdAt,
          updatedAt: message.createdAt,
          validFrom: message.createdAt,
          status: 'active',
          sourceVersion,
          scope: { visibility: 'session', sessions: [id] },
          metadata: {
            messageId: message.id,
            role: message.role,
            messageIndex: index,
            hasImage: message.attachments && message.attachments.length > 0,
            exactTerms: exactTerms(part, 16),
          },
        })
      );
    }
  }

  return {
    exists: true,
    empty: false,
    source: {
      id: `conversation:${id}`,
      type: 'conversation',
      title: meta.title || '会话历史',
      uri: `session://${id}`,
      state: 'indexed',
      sourceVersion,
      contentHash: contentHashOf(chunks.map(chunk => chunk.content).join('\n')),
      createdAt: meta.createdAt,
      updatedAt: meta.updatedAt,
      metadata: {
        messageCount: messages.length,
        chunkCount: chunks.length,
        scope: 'session',
      },
    },
    chunks,
  };
}

function hashMessage(message) {
  return sha256(
    [message.id, message.createdAt, message.role, String(message.content || '')].join('|')
  ).slice(0, 24);
}

module.exports = { collectConversationChunks };
