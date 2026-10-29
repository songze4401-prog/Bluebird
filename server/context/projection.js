/**
 * 云岫 Bluebird — Context Runtime v3 消息投影契约（projection.js）
 *
 * 存储消息 → 上下文消息的显式投影。所有历史选择、摘要、检索去重、输入保护
 * 都消费同一份投影，避免不同模块各自解释 session JSON。
 *
 * 契约版本：v3。字段：
 *   id / role / content / createdAt / attachments / hasImage / toolSteps / contentKind
 *
 * - 附件只保留渲染与视觉判断需要的元数据（id/kind/mime/name），不复制图片字节；
 * - toolSteps 是落盘展示字段，不是模型 tool_calls 协议：只随投影保留，不注入提示词；
 * - 不支持的存储形态（content 不是字符串）显式标记 unsupported，不静默当成空文本。
 */
const PROJECTION_VERSION = 3;

// 模型消息不是内部投影对象：用 symbol 附带追溯标识，JSON.stringify 不会发送，
// agent-runtime 的浅拷贝会保留它。sent trace 因此能对应真实发出的消息。
const CONTEXT_ID = Symbol.for('bluebird.context.messageId');

const ROLES = new Set(['user', 'assistant']);
const MAX_ID_LEN = 80;
const MAX_NAME_LEN = 80;
const MAX_MIME_LEN = 80;
const MAX_SUMMARY_LEN = 160;

function isObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function cleanString(value, max) {
  return typeof value === 'string' && value.length <= max ? value : null;
}

function isIsoTimestamp(value) {
  return (
    typeof value === 'string' &&
    value.length <= 40 &&
    Number.isFinite(Date.parse(value))
  );
}

function sanitizeAttachments(raw) {
  if (!Array.isArray(raw)) return [];

  const out = [];
  for (const att of raw) {
    if (!isObject(att)) continue;
    const id = cleanString(att.id, MAX_ID_LEN);
    // id 是读取文件的唯一凭据；没有 id 的附件无法渲染，显式丢弃并计入 unsupported。
    if (!id) continue;
    const kind = att.kind === 'sticker' ? 'sticker' : 'image';
    const mime = cleanString(att.mime, MAX_MIME_LEN);
    const name = cleanString(att.name, MAX_NAME_LEN);
    out.push({
      id,
      kind,
      ...(mime ? { mime } : {}),
      ...(name ? { name } : {}),
    });
  }

  return out;
}

function sanitizeToolSteps(raw) {
  if (!Array.isArray(raw)) return [];

  return raw
    .filter(isObject)
    .map(step => {
      const name = cleanString(step.name, MAX_NAME_LEN);
      if (!name) return null;
      return {
        name,
        ok: step.ok === true,
        ...(typeof step.code === 'string' ? { code: cleanString(step.code, 40) } : {}),
        ...(typeof step.summary === 'string'
          ? { summary: step.summary.slice(0, MAX_SUMMARY_LEN) }
          : {}),
        ...(Number.isFinite(step.durationMs) ? { durationMs: step.durationMs } : {}),
      };
    })
    .filter(Boolean);
}

function projectStoredMessage(item, index, { sessionId = null } = {}) {
  if (!isObject(item) || !ROLES.has(item.role)) return null;

  const rawContent = item.content;
  const content = typeof rawContent === 'string' ? rawContent : '';
  const attachments = sanitizeAttachments(item.attachments);
  const toolSteps = sanitizeToolSteps(item.toolSteps);
  const unsupported = [];

  if (typeof rawContent !== 'string') {
    // 存储层只应有字符串正文；一旦出现 blocks/对象，明确标记而不是当成空串。
    unsupported.push('content_not_string');
  }
  if (Array.isArray(item.attachments) && item.attachments.length > attachments.length) {
    unsupported.push('attachment_without_id');
  }

  return {
    projectionVersion: PROJECTION_VERSION,
    index,
    id: cleanString(item.id, MAX_ID_LEN),
    sessionId: cleanString(sessionId, MAX_ID_LEN),
    role: item.role,
    content,
    createdAt: isIsoTimestamp(item.createdAt) ? item.createdAt : null,
    attachments,
    hasImage: attachments.some(
      att => typeof att.mime === 'string' && att.mime.startsWith('image/')
    ),
    toolSteps,
    contentKind:
      content.length > 0
        ? 'text'
        : attachments.length > 0
          ? 'attachment_only'
          : 'empty',
    unsupported,
  };
}

function projectStoredMessages(items, { sessionId = null } = {}) {
  if (!Array.isArray(items)) return [];
  return items
    .map((item, index) => projectStoredMessage(item, index, { sessionId }))
    .filter(Boolean);
}

function tagModelMessage(message, contextId) {
  if (!isObject(message) || !contextId) return message;
  message[CONTEXT_ID] = contextId;
  return message;
}

function modelMessageId(message) {
  return isObject(message) ? message[CONTEXT_ID] || null : null;
}

/**
 * 投影消息 → 模型消息。保留现有 DeepSeek 多模态约束：
 * - 用户图片转为 text + image_url blocks；
 * - 助手图片/表情包降级为文本占位（原样回传会被上游 400 拒绝）；
 * - 图片读取失败退化为纯文本，不让整轮请求崩掉；
 * - includeImages=false 时用户图片也降级为文本占位。
 */
function toModelMessages(projected, { includeImages = true, readAttachment } = {}) {
  const out = [];

  for (const item of projected) {
    if (!isObject(item) || !ROLES.has(item.role)) continue;

    const text = typeof item.content === 'string' ? item.content : '';
    const attachments = Array.isArray(item.attachments) ? item.attachments : [];

    if (item.role === 'user' && attachments.length) {
      if (!includeImages) {
        out.push(tagModelMessage({ role: 'user', content: text.trim() || '（图片消息）' }, item.id));
        continue;
      }

      const blocks = [];
      if (text.trim()) blocks.push({ type: 'text', text });

      for (const att of attachments) {
        const dataUrl =
          typeof readAttachment === 'function' ? readAttachment(att) : null;
        if (dataUrl) {
          blocks.push({ type: 'image_url', image_url: { url: dataUrl } });
        }
      }

      out.push(
        tagModelMessage(
          {
            role: 'user',
            content: blocks.length ? blocks : text || '（图片已失效）',
          },
          item.id
        )
      );
      continue;
    }

    if (item.role === 'assistant' && attachments.length) {
      const labels = attachments.map(att =>
        att.kind === 'sticker' ? `[sticker:${att.id}]` : '（发送了图片）'
      );
      const content = [text, ...labels].filter(Boolean).join('\n');
      out.push(
        tagModelMessage(
          { role: 'assistant', content: content || '（发送了图片）' },
          item.id
        )
      );
      continue;
    }

    if (text) {
      out.push(tagModelMessage({ role: item.role, content: text }, item.id));
    }
  }

  return out;
}

module.exports = {
  PROJECTION_VERSION,
  CONTEXT_ID,
  projectStoredMessages,
  toModelMessages,
  tagModelMessage,
  modelMessageId,
};
