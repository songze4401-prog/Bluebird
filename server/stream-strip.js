// 情绪标签剥离：/chat（全量）与 /chat/stream（增量）共用同一套规则。
// 规则与旧版内联实现完全一致：
//   1) 循环剥掉开头的标签（模型偶发连发多个），第一个合法值作为本轮观察信号；
//   2) 兜底清掉正文中任何位置残留的标签；
//   3) 清洗后为空则保留原文，避免发出空消息。
// 兼容三种形式：规范 [mood:calm]、裸 [calm]（严格限定已知情绪值）、[mood:任意词]（只剥不认领）。
const { EMOTIONS } = require('./emotion');

const MOOD_VALUES = new Set(EMOTIONS);

const MOOD_TAG_SOURCE = `(?:［|\\[)\\s*(?:mood\\s*[:：]\\s*)?(${EMOTIONS.join(
  '|'
)})\\s*(?:］|\\])`;
const PREFIXED_TAG_SOURCE = `(?:［|\\[)\\s*mood\\s*[:：]\\s*[a-z]+\\s*(?:］|\\])`;

const LEADING_TAG_RE = new RegExp(
  `^\\s*(?:${MOOD_TAG_SOURCE}|${PREFIXED_TAG_SOURCE})`,
  'i'
);
const ANY_TAG_RE = new RegExp(`${PREFIXED_TAG_SOURCE}|${MOOD_TAG_SOURCE}`, 'gi');

// 完整回复的标签处理：返回清洗后的正文与本轮情绪观察信号
function stripMoodTags(rawReply) {
  let mood = 'calm';
  let moodSignalSet = false;
  let body = String(rawReply == null ? '' : rawReply);

  let leading = body.match(LEADING_TAG_RE);

  while (leading) {
    const value =
      typeof leading[1] === 'string' ? leading[1].toLowerCase() : '';

    if (!moodSignalSet && MOOD_VALUES.has(value)) {
      mood = value;
      moodSignalSet = true;
    }

    body = body.slice(leading[0].length);
    leading = body.match(LEADING_TAG_RE);
  }

  const cleaned = body.replace(ANY_TAG_RE, '').trim();

  return { reply: cleaned || String(rawReply), mood };
}

// 流式增量剥离：缓冲开头可能是情绪标签的字符，识别出完整标签即剥掉，
// 确认不是标签后开始原样放行。正文中间残留的已发出标签无法增量撤回，
// 由收尾的 stripMoodTags 全量清洗兜底（done 事件的权威文本）。
const MAX_TAG_BUFFER = 64;

// 缓冲区内容仍可能是某个标签的前缀：纯空白，或 空白+开括号+尚未闭合
const POTENTIAL_TAG_PREFIX_RE = /^\s*(?:[［[][^］\]]*)?$/;

function createMoodTagStripper() {
  let buffer = '';
  let resolved = false; // 已开始放行正文：之后内容不再缓冲

  function push(chunk) {
    if (resolved) return chunk;

    buffer += chunk;

    // 循环剥掉所有已完整到达的前导标签
    for (;;) {
      const match = buffer.match(LEADING_TAG_RE);
      if (!match) break;
      buffer = buffer.slice(match[0].length);
    }

    if (!buffer) return ''; // 目前全是标签，继续等正文

    if (
      buffer.length <= MAX_TAG_BUFFER &&
      POTENTIAL_TAG_PREFIX_RE.test(buffer)
    ) {
      return ''; // 仍可能是标签前缀（半个标签/前导空白），继续缓冲
    }

    // 确认不是标签：整体放行，之后不再缓冲
    const out = buffer;
    buffer = '';
    resolved = true;
    return out;
  }

  function flush() {
    const out = buffer;
    buffer = '';
    resolved = true;
    return out;
  }

  return { push, flush };
}

module.exports = { stripMoodTags, createMoodTagStripper };
