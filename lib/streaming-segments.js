// 流式分段（纯函数）：把流式累计文本按「与最终分条完全相同的规则」切成气泡。
//
// 关键不变量：服务端 done 时对完整回复调用的是同一个 splitReplyIntoSegments，
// 因此前端流式期最后一次切分 == done 的权威分条（文本相同、mode 相同），
// 替换时不会出现「先并成一个气泡、下一帧才分裂」的跳变。
//
// 同时保留 A-1 的扣留语义：每个气泡内部再经 parseStickerMarkersForStream，
// 末尾未闭合的 [sticker: 片段先扣留，不会闪出方括号。

const { parseStickerMarkersForStream } = require('./sticker-markers');
const { splitReplyIntoSegments } = require('./split-reply');

/**
 * 把流式累计文本切成可直接渲染的气泡数组（plain object，与前端 Message 结构一致）。
 *
 * @param {string} text 累计正文（已剥情绪标签的 delta 拼接）
 * @param {'single'|'auto'|'frequent'} mode 分段模式（与服务端 personaConfig.messageMode 一致）
 * @param {{ idPrefix?: string, createdAt?: string }} [options]
 * @returns {Array<{id:string, role:'assistant', content:string, createdAt?:string, segments:Array}>}
 */
function buildStreamingBubbles(text, mode, options = {}) {
  const raw = typeof text === 'string' ? text : '';
  const idPrefix =
    typeof options.idPrefix === 'string' && options.idPrefix
      ? options.idPrefix
      : 'stream';
  const createdAt = options.createdAt;

  let chunks = splitReplyIntoSegments(raw, mode || 'auto');

  // 纯空白（流式刚起步，比如先到的是换行）时不要返回空数组让气泡消失：
  // 保留一个原样气泡占位，等后续 delta 补齐后再按规则切分。
  if (!chunks.length) {
    if (!raw) return [];
    chunks = [raw];
  }

  return chunks.map((content, index) => ({
    id: `${idPrefix}#${index}`,
    role: 'assistant',
    content,
    ...(createdAt ? { createdAt } : {}),
    segments: parseStickerMarkersForStream(content),
  }));
}

/** 判断某条消息是否属于某个流式气泡块（id 为 prefix 或 prefix#N）。 */
function isStreamingBubble(message, idPrefix) {
  const id = message && typeof message.id === 'string' ? message.id : '';
  return id === idPrefix || id.startsWith(`${idPrefix}#`);
}

/**
 * 用新气泡整体替换旧的流式气泡块（保持在原位置）；块不存在则追加到末尾。
 * done 时也用同一个函数把流式块替换成服务端权威气泡。
 *
 * @param {Array} prev 现有消息数组
 * @param {string} idPrefix 流式块前缀（等同流式临时 id）
 * @param {Array} bubbles 新气泡数组
 * @returns {Array} 新数组（不修改入参）
 */
function replaceStreamingBlock(prev, idPrefix, bubbles) {
  const list = Array.isArray(prev) ? prev : [];
  const nextBubbles = Array.isArray(bubbles) ? bubbles : [];
  const first = list.findIndex(m => isStreamingBubble(m, idPrefix));

  if (first < 0) return [...list, ...nextBubbles];

  const before = list.slice(0, first);
  const after = list
    .slice(first + 1)
    .filter(m => !isStreamingBubble(m, idPrefix));

  return [...before, ...nextBubbles, ...after];
}

module.exports = {
  buildStreamingBubbles,
  replaceStreamingBlock,
  isStreamingBubble,
};
