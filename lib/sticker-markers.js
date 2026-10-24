// 表情包标记解析（纯函数）：把正文按 [sticker:ID] 切成文本 / 表情包片段。
// 放在 lib/ 下与其它工具并列，不依赖 React Native 或 Node 专有 API，
// 前端渲染与 node 内置测试（tests/sticker-markers.test.js）共用同一份实现。
//
// 约定：任何形态的标记都不会作为原始文字返回——无法识别的 ID 标为
// valid=false，由渲染层显示「表情包已失效」，绝不回退成 [sticker:...]。

// token 上限 40：仓库 ID 是 36 字符 UUID，同时兼容旧关键词语法
const STICKER_MARKER_RE = /\[sticker[:：]\s*([^[\]\s]{1,40})\s*\]/g;

const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function isValidStickerId(id) {
  return UUID_RE.test(String(id || '').trim());
}

/**
 * @typedef {{ type: 'text', text: string }} TextSegment
 * @typedef {{ type: 'sticker', id: string, valid: boolean, marker: string }} StickerSegment
 */

/**
 * 把文本切成片段数组（按出现顺序）：
 *   { type: 'text', text: '...' }
 *   { type: 'sticker', id: '...', valid: boolean, marker: '[sticker:...]' }
 * 无标记时返回单个 text 片段（原文原样，保留换行）。
 *
 * @param {string} text
 * @returns {Array<TextSegment | StickerSegment>}
 */
function parseStickerMarkers(text) {
  /** @type {Array<TextSegment | StickerSegment>} */
  const segments = [];
  const source = typeof text === 'string' ? text : '';
  let lastIndex = 0;

  // 全局正则带 lastIndex 状态：每次解析前重置，避免并发/重复调用串味
  STICKER_MARKER_RE.lastIndex = 0;

  let match = STICKER_MARKER_RE.exec(source);

  while (match) {
    if (match.index > lastIndex) {
      segments.push({ type: 'text', text: source.slice(lastIndex, match.index) });
    }

    const id = String(match[1] || '').trim();

    segments.push({
      type: 'sticker',
      id,
      valid: isValidStickerId(id),
      marker: match[0],
    });

    lastIndex = match.index + match[0].length;
    match = STICKER_MARKER_RE.exec(source);
  }

  if (lastIndex < source.length) {
    segments.push({ type: 'text', text: source.slice(lastIndex) });
  }

  return segments;
}

// 流式专用：SSE 的 delta 会先到 "[sticker:9829f2" 这种半截标记。
// 若直接按普通文本渲染，用户会先看到一串方括号+数字，等 "]" 到齐才变图片。
// 这里把「末尾尚未闭合的 [ 片段」整段扣留，等后续 delta 补齐；
// 已闭合的标记不受影响，所以从消息出现到图片出现全程不露原始标记。
//   parseStickerMarkersForStream('你好 [sticker:98') → [{type:'text',text:'你好 '}]
function parseStickerMarkersForStream(text) {
  const segments = parseStickerMarkers(text);
  const last = segments[segments.length - 1];

  if (last && last.type === 'text') {
    const pending = last.text.match(/\[[^\]\n]*$/);

    if (pending) {
      const kept = last.text.slice(0, pending.index);

      if (kept) {
        last.text = kept;
      } else {
        segments.pop();
      }
    }
  }

  return segments;
}

module.exports = {
  parseStickerMarkers,
  parseStickerMarkersForStream,
  isValidStickerId,
  STICKER_MARKER_RE,
};
