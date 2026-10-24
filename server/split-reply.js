// 回复分条：把一条完整回复按自然边界拆成 1-4 条气泡，模拟即时聊天节奏。
// 纯函数、无 I/O；只在段落 / 句末标点处切分，绝不为了凑条数拆句。
// 不变量：所有分条去除空白后拼接 === 原文去除空白（不丢字、不重复）。
//
// messageMode:
//   single   强制 1 条（与旧行为完全一致）
//   auto     自然分条：短回复 1 条，多段 / 长文 2-4 条
//   frequent 更积极：阈值更低，倾向 2-4 条

const MAX_SEGMENTS = 4;

// auto: 单段 <= 60 字不拆；超过 160 字的段落按句子再分组（每组目标 70-160 字）
const AUTO_SHORT_LEN = 60;
const AUTO_LONG_PARAGRAPH = 160;
const AUTO_GROUP_TARGET = 70;

// frequent: 更积极的阈值
const FREQ_SHORT_LEN = 30;
const FREQ_LONG_PARAGRAPH = 80;
const FREQ_GROUP_TARGET = 35;

// 过短的尾巴（1-3 字，如"嗯"）并入前一条，避免碎片气泡；
// 4 字以上视为合法短段，保留独立气泡
const MIN_TAIL_LEN = 4;

// 句末标点（切分点保留在句子尾部）
const SENTENCE_RE = /[^。！？!?…～\n]+[。！？!?…～]*["'」』』)]*|[^。！？!?…～\n]+/g;

function splitSentences(text) {
  return text.match(SENTENCE_RE) || [text];
}

// 把句子按目标长度分组：组达到 target 后且还有剩余句子时收组
function groupSentences(sentences, target) {
  const groups = [];
  let current = '';

  for (const sentence of sentences) {
    current += sentence;

    if (current.length >= target) {
      groups.push(current);
      current = '';
    }
  }

  if (current) groups.push(current);

  return groups;
}

// 过短尾巴并入前一条——但前提是前一条足够长。
// 该规则只为吞掉长文结尾的碎片客套（如 "……一大段。\n嗯"）；
// 多条显式换行的短段（如用户点名要的 "1\n2"）是合法分条，不得压回一条。
const MIN_HEAD_LEN_FOR_MERGE = 12;

function mergeTinyTail(chunks) {
  if (
    chunks.length > 1 &&
    chunks[chunks.length - 1].length < MIN_TAIL_LEN &&
    chunks[chunks.length - 2].length >= MIN_HEAD_LEN_FOR_MERGE
  ) {
    const tail = chunks.pop();
    chunks[chunks.length - 1] += tail;
  }

  return chunks;
}

// 封顶 MAX_SEGMENTS：超出的并入最后一条
function capSegments(chunks) {
  if (chunks.length <= MAX_SEGMENTS) return chunks;

  const head = chunks.slice(0, MAX_SEGMENTS - 1);

  head.push(chunks.slice(MAX_SEGMENTS - 1).join(''));
  return head;
}

function splitReplyIntoSegments(text, mode = 'auto') {
  const normalized = String(text == null ? '' : text)
    .replace(/\r\n/g, '\n')
    .trim();

  if (!normalized) return [];
  if (mode === 'single') return [normalized];

  const shortLen = mode === 'frequent' ? FREQ_SHORT_LEN : AUTO_SHORT_LEN;
  const longParagraph =
    mode === 'frequent' ? FREQ_LONG_PARAGRAPH : AUTO_LONG_PARAGRAPH;
  const groupTarget =
    mode === 'frequent' ? FREQ_GROUP_TARGET : AUTO_GROUP_TARGET;

  // 短回复：单段且不超阈值 -> 1 条
  if (normalized.length <= shortLen && !normalized.includes('\n')) {
    return [normalized];
  }

  const paragraphs = normalized
    .split(/\n+/)
    .map(s => s.trim())
    .filter(Boolean);

  let chunks = [];

  for (const paragraph of paragraphs) {
    if (paragraph.length <= longParagraph) {
      chunks.push(paragraph);
    } else {
      // 超长段落按句子分组
      chunks = chunks.concat(
        groupSentences(splitSentences(paragraph), groupTarget)
      );
    }
  }

  return capSegments(mergeTinyTail(chunks.filter(Boolean)));
}

module.exports = { splitReplyIntoSegments, MAX_SEGMENTS };
