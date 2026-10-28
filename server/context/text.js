/**
 * 云岫 Bluebird — Context Runtime v3 文本度量与匹配（text.js）
 *
 * 只做确定性的词面匹配：CJK 二元组 + 拉丁词/数字词。
 * 它不是 embedding，也不声称语义等价；用途是历史召回、摘要抽取、
 * 记忆覆盖判定与输入计量，全部可单测复现。
 */
const { estimateTokens, textLength, truncateText } = require('../text-utils');

const CJK_RE = /[\u2e80-\u9fff\uac00-\ud7af\uf900-\ufaff\uff00-\uffef]/;
const LATIN_WORD_RE = /[a-z0-9]+(?:[-_.:][a-z0-9]+)*/gi;
const ENTITY_RE = /[A-Z]{2,}[A-Z0-9_-]*\d[A-Z0-9_-]*|\b\d{3,}\b|《[^》]{1,40}》|「[^」]{1,40}」|“[^”]{1,40}”|"[^"]{1,40}"/g;

function normalizeForMatch(value) {
  return String(value || '')
    .toLowerCase()
    .replace(/\[sticker[:：][^\]]*\]/gi, ' ')
    .replace(/\[image[:：][^\]]*\]/gi, ' ')
    .replace(/\s+/g, '');
}

// 词元：CJK 二元组 + 拉丁/数字词。去重后用于集合匹配。
function tokenSet(value) {
  const text = normalizeForMatch(value);
  const tokens = new Set();

  for (const match of text.matchAll(LATIN_WORD_RE)) {
    const word = match[0];
    if (word.length >= 2) tokens.add(`w:${word}`);
  }

  const chars = Array.from(text);
  for (let i = 0; i < chars.length - 1; i++) {
    if (CJK_RE.test(chars[i]) && CJK_RE.test(chars[i + 1])) {
      tokens.add(`c:${chars[i]}${chars[i + 1]}`);
    }
  }

  return tokens;
}

// candidate 有多少内容出现在 context 中（0~1）。短文本要求更严格。
function containment(candidate, context) {
  const a = tokenSet(candidate);
  if (!a.size) return 0;
  const b = tokenSet(context);
  if (!b.size) return 0;
  let hit = 0;
  for (const token of a) if (b.has(token)) hit += 1;
  return hit / a.size;
}

function jaccard(a, b) {
  const setA = tokenSet(a);
  const setB = tokenSet(b);
  if (!setA.size || !setB.size) return 0;
  let inter = 0;
  for (const token of setA) if (setB.has(token)) inter += 1;
  return inter / new Set([...setA, ...setB]).size;
}

function extractEntities(value) {
  const text = String(value || '');
  const entities = new Set();

  for (const match of text.matchAll(ENTITY_RE)) {
    const entity = match[0].replace(/[《》「」“”"]/g, '').trim();
    if (entity.length >= 2) entities.add(entity.toLowerCase());
  }

  for (const match of text.matchAll(LATIN_WORD_RE)) {
    const word = match[0].toLowerCase();
    if (word.length >= 3 && !/^\d+$/.test(word)) entities.add(word);
  }

  return entities;
}

function entityOverlap(query, text) {
  const q = extractEntities(query);
  if (!q.size) return 0;
  const t = extractEntities(text);
  if (!t.size) return 0;
  let hit = 0;
  for (const entity of q) if (t.has(entity)) hit += 1;
  return hit / q.size;
}


// 数值签名：阿拉伯数字 + 中文数字串。用于“同主题不同值”的冲突判定，
// 不做单位换算，也不声称理解全部中文数词；只回答“值是否明显不同”。
function valueSignature(value) {
  const text = String(value || '');
  const digits = (text.match(/\d+(?:\.\d+)?/g) || [])
    .map(token => token.replace(/\.0+$/, ''))
    .sort();
  const chinese = (text.match(/[零〇一二三四五六七八九十百千万亿两]+/g) || [])
    .map(token => token.replace(/^[零〇]+/, ''))
    .filter(Boolean)
    .sort();
  return { digits, chinese };
}

function valuesDiffer(a, b) {
  const sigA = valueSignature(a);
  const sigB = valueSignature(b);
  const digitsDiffer =
    sigA.digits.length > 0 &&
    sigB.digits.length > 0 &&
    sigA.digits.join(',') !== sigB.digits.join(',');
  const chineseDiffer =
    sigA.chinese.length > 0 &&
    sigB.chinese.length > 0 &&
    sigA.chinese.join(',') !== sigB.chinese.join(',');
  return digitsDiffer || chineseDiffer;
}

function overlapScore(query, text) {
  return containment(query, text) * 0.7 + entityOverlap(query, text) * 0.3;
}

// 上下文正文中和：用户/历史内容可以包含任意文字，但不能伪造区块边界或角色标记。
// 这是渲染层的结构防护，不改变原文语义。
function neutralizeContextText(value) {
  return String(value || '')
    .replace(/<<<[^>]*>>>/g, '[已屏蔽的边界标记]')
    .replace(/【([^】]*)】/g, '「$1」')
    .replace(/```/g, "'''")
    .replace(/^\s*(system|assistant|user|tool)\s*[:：]/gim, '$1：')
    .replace(/^[\s\-*>#]+/u, '')
    .trim();
}

function stripProtocolMarkers(value) {
  return String(value || '')
    .replace(/\[sticker[:：][^\]]*\]/gi, '')
    .replace(/\[image[:：][^\]]*\]/gi, '')
    .replace(/\s+/g, ' ')
    .trim();
}

// 模型消息的文本与图片数量（input guard 用）。图片 URL 不参与字符计量，
// 否则一张 dataURL 会被误当成数万 token 文本。
function describeMessageContent(content) {
  if (typeof content === 'string') {
    return { text: content, imageCount: 0, hasUnsupportedBlock: false };
  }

  if (Array.isArray(content)) {
    let text = '';
    let imageCount = 0;
    let hasUnsupportedBlock = false;

    for (const block of content) {
      if (!block || typeof block !== 'object') {
        hasUnsupportedBlock = true;
        continue;
      }
      if (block.type === 'text' && typeof block.text === 'string') {
        text += block.text;
      } else if (block.type === 'image_url') {
        imageCount += 1;
      } else {
        hasUnsupportedBlock = true;
      }
    }

    return { text, imageCount, hasUnsupportedBlock };
  }

  return { text: '', imageCount: 0, hasUnsupportedBlock: content != null };
}

function estimateModelTokens(message, { perImageTokens = 1024, overheadTokens = 4 } = {}) {
  const { text, imageCount } = describeMessageContent(message && message.content);
  return estimateTokens(text) + imageCount * perImageTokens + overheadTokens;
}

module.exports = {
  normalizeForMatch,
  tokenSet,
  containment,
  jaccard,
  extractEntities,
  entityOverlap,
  overlapScore,
  valueSignature,
  valuesDiffer,
  neutralizeContextText,
  stripProtocolMarkers,
  describeMessageContent,
  estimateModelTokens,
  estimateTokens,
  textLength,
  truncateText,
};
