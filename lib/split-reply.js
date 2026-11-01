// 回复分段：默认一条回复 = 一条消息；只有超过硬上限才按语义边界分片。
//
// 纯函数、无 I/O。分片优先级：
//   1) 两个及以上换行（段落）
//   2) 单个换行
//   3) 中文句末标点（。！？!?…；;）
//   4) 没有任何边界时才按长度硬切；硬切不得切进代码块、Markdown 链接、
//      英文单词或代理对
//
// messageMode 仅为兼容旧调用保留，不再改变切分；单条上限由
// DEFAULT_MAX_CHARS 单一来源提供，可经 options.maxChars 覆盖（服务端读取
// BLUEBIRD_REPLY_MAX_CHARS 后传入）。
//
// 不变量：所有分片去空白后拼接 === 原文去空白（不丢字、不重复）。

const DEFAULT_MAX_CHARS = 400;

function codePointLength(text) {
  return Array.from(text).length;
}

function takeCodePoints(text, count) {
  return Array.from(text).slice(0, count).join('');
}

// 围栏代码块（``` / ~~~）作为原子区间：不在块内任何位置切分。
function findFencedRanges(text) {
  const ranges = [];
  const lines = text.split('\n');
  let offset = 0;
  let open = null;
  for (const line of lines) {
    const lineStart = offset;
    const lineEnd = lineStart + line.length;
    const match = line.match(/^[ \t]*(`{3,}|~{3,})/);
    if (match) {
      const marker = match[1][0];
      const length = match[1].length;
      if (!open) {
        open = { start: lineStart, marker, length };
      } else if (marker === open.marker && length >= open.length) {
        ranges.push({ start: open.start, end: Math.min(lineEnd + 1, text.length) });
        open = null;
      }
    }
    offset = lineEnd + 1;
  }
  if (open) ranges.push({ start: open.start, end: text.length });
  return ranges;
}

// Markdown 行内链接 [label](url) 作为原子区间：硬切时不得拆开。
function findLinkRanges(text) {
  const ranges = [];
  const re = /\[[^\]]*\]\([^)]*\)/g;
  let match;
  while ((match = re.exec(text))) {
    ranges.push({ start: match.index, end: match.index + match[0].length });
  }
  return ranges;
}

function insideRange(index, ranges) {
  return ranges.some(range => index > range.start && index < range.end);
}

// 在 prefix 内找该优先级下最后一个合法边界；边界不得落在原子区间内部。
function lastBoundary(prefix, pattern, endIndex, ranges) {
  const re = new RegExp(pattern.source, pattern.flags.includes('g') ? pattern.flags : `${pattern.flags}g`);
  let last = 0;
  let match;
  while ((match = re.exec(prefix))) {
    const index = endIndex(match);
    if (index > 0 && index <= prefix.length && !insideRange(index, ranges)) {
      last = index;
    }
  }
  return last;
}

// 没有任何语义边界时的硬切点：避开代码块/链接/英文单词/代理对。
function hardCutPoint(text, maxChars, ranges) {
  const prefix = takeCodePoints(text, maxChars);
  let target = prefix.length;

  const targetInsideLetter =
    target > 0 &&
    target < text.length &&
    /[A-Za-z0-9]/.test(text[target - 1] || '') &&
    /[A-Za-z0-9]/.test(text[target] || '');

  if (targetInsideLetter) {
    let i = target - 1;
    while (i > 0 && !/\s/.test(text[i])) i -= 1;
    if (i > 0) {
      target = i;
    } else {
      const nextSpace = text.slice(target).search(/\s/);
      if (nextSpace >= 0) target += nextSpace;
    }
  }

  // 原子区间保护：切点落在代码块/链接内部时，退到区间起点；区间从 0 开始时
  // 只能让该原子单元独占一条（可能超过上限，但绝不截断）。
  for (const range of ranges) {
    if (target > range.start && target < range.end) {
      target = range.start > 0 ? range.start : Math.min(range.end, text.length);
    }
  }

  if (target <= 0) return prefix.length;
  return Math.min(target, text.length);
}

function resolveMaxChars(value) {
  const number = Number(value);
  return Number.isInteger(number) && number > 0 ? number : DEFAULT_MAX_CHARS;
}

/**
 * 把一条完整回复切成消息片段。
 * @param {string} text
 * @param {'single'|'auto'|'frequent'} [mode] 兼容旧调用；不再影响切分
 * @param {{ maxChars?: number }} [options]
 * @returns {string[]}
 */
function splitReplyIntoSegments(text, mode = 'auto', options = {}) {
  void mode;
  const maxChars = resolveMaxChars(options && options.maxChars);
  const normalized = String(text == null ? '' : text)
    .replace(/\r\n/g, '\n')
    .trim();

  if (!normalized) return [];
  if (codePointLength(normalized) <= maxChars) return [normalized];

  const segments = [];
  let remaining = normalized;
  let guard = 0;

  while (codePointLength(remaining) > maxChars && guard < 1000) {
    guard += 1;
    const ranges = [...findFencedRanges(remaining), ...findLinkRanges(remaining)];
    const prefix = takeCodePoints(remaining, maxChars);

    let cut = lastBoundary(prefix, /\n{2,}/g, match => match.index + match[0].length, ranges);
    if (!cut) {
      cut = lastBoundary(prefix, /\n/g, match => match.index + 1, ranges);
    }
    if (!cut) {
      cut = lastBoundary(
        prefix,
        /[。！？!?][”’」』）)]*/g,
        match => match.index + match[0].length,
        ranges
      );
    }
    if (!cut) {
      cut = hardCutPoint(remaining, maxChars, ranges);
    }
    if (!cut || cut <= 0 || cut >= remaining.length) break;

    const piece = remaining.slice(0, cut).trim();
    if (piece) segments.push(piece);
    remaining = remaining.slice(cut).replace(/^\s+/, '');
  }

  if (remaining.trim()) segments.push(remaining.trim());
  return segments;
}

module.exports = {
  DEFAULT_MAX_CHARS,
  splitReplyIntoSegments,
  resolveMaxChars,
};
