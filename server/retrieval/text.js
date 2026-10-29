/**
 * 云岫 Bluebird — 检索文本处理（retrieval/text.js）
 *
 * 只做确定性的本地文本处理：规范化、分词（CJK 单字 + 二元组，ASCII 词项）、
 * 精确标识符提取、HTML 转文本、注入风险标记。没有外部模型调用。
 */
const { normalizeContent } = require('./contract');
const { textLength, truncateText } = require('../text-utils');

const CJK_RANGES = [
  [0x3400, 0x4dbf],
  [0x4e00, 0x9fff],
  [0xf900, 0xfaff],
  [0x3040, 0x30ff],
  [0xac00, 0xd7af],
];

function isCjkCode(code) {
  return CJK_RANGES.some(([start, end]) => code >= start && code <= end);
}

function isWordCode(code) {
  return (
    (code >= 0x30 && code <= 0x39) ||
    (code >= 0x41 && code <= 0x5a) ||
    (code >= 0x61 && code <= 0x7a) ||
    code === 0x5f ||
    code === 0x2d
  );
}

function splitIdentifier(word) {
  const parts = [];
  const segments = word.split(/[_\-.]+/).filter(Boolean);
  for (const segment of segments) {
    parts.push(segment);
    const camel = segment
      .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
      .toLowerCase()
      .split(/\s+/)
      .filter(Boolean);
    if (camel.length > 1) parts.push(...camel);
  }
  return parts;
}

/**
 * 返回有重复的词项数组（词频由重复次数体现）。上限 4000 项，
 * 防止超长代码文件把索引膨胀成不可控规模。
 */
function tokenize(value, maxTokens = 4000) {
  const text = normalizeContent(value);
  const tokens = [];
  let word = '';
  let previousCjk = '';

  const push = token => {
    if (tokens.length >= maxTokens) return;
    if (token && token.length >= 2) tokens.push(token);
  };

  const flushWord = () => {
    if (!word) return;
    const lower = word.toLowerCase();
    push(lower);
    for (const part of splitIdentifier(word)) {
      const normalized = part.toLowerCase();
      if (normalized !== lower) push(normalized);
    }
    word = '';
  };

  for (const char of text) {
    const code = char.codePointAt(0);

    if (isCjkCode(code)) {
      flushWord();
      push(char);
      if (previousCjk) push(previousCjk + char);
      previousCjk = char;
      continue;
    }

    previousCjk = '';

    if (isWordCode(code) || (code >= 0x80 && /\p{L}|\p{N}/u.test(char))) {
      word += char;
      continue;
    }

    flushWord();
  }

  flushWord();
  return tokens;
}

const EXACT_RE =
  /(?:[A-Za-z_][A-Za-z0-9_]{3,}|[A-Za-z0-9_.-]*\/[A-Za-z0-9_./-]+|[A-Z0-9_]{3,})/g;

/**
 * 精确检索词：代码标识符、路径、错误码、全大写常量、带引号的短语。
 * 不把普通自然语言词当精确词，避免精确通道退化成第二个词法通道。
 */
function exactTerms(value, maxTerms = 32) {
  const text = normalizeContent(value);
  const result = new Set();

  const quoted = text.match(/"([^"\n]{2,80})"|“([^”\n]{2,80})”/g) || [];
  for (const raw of quoted) {
    const term = raw.replace(/^["“]|["”]$/g, '').trim().toLowerCase();
    if (term) result.add(term);
    if (result.size >= maxTerms) return [...result];
  }

  const matches = text.match(EXACT_RE) || [];
  for (const raw of matches) {
    if (result.size >= maxTerms) break;
    const term = raw.trim().toLowerCase();
    if (!term || term.length < 4) continue;
    const hasStructure = /[./_\-]/.test(term);
    const isUpper = raw === raw.toUpperCase() && /[A-Z]/.test(raw);
    if (hasStructure || isUpper) result.add(term);
  }

  return [...result];
}

function codeIntent(value) {
  const text = String(value || '');
  return (
    /[A-Za-z_][A-Za-z0-9_]*\s*\(/.test(text) ||
    /[A-Za-z0-9_.-]+\/[A-Za-z0-9_./-]+/.test(text) ||
    /(function|class|const|import|export|报错|堆栈|stack|error code|文件路径|函数|变量|接口)/i.test(
      text
    )
  );
}

function detectLanguage(value) {
  const text = String(value || '');
  const cjk = (text.match(/[\u3400-\u9fff]/g) || []).length;
  return cjk > 0 ? 'zh' : 'en';
}

function jaccard(a, b) {
  const left = new Set(tokenize(a, 800));
  const right = new Set(tokenize(b, 800));
  if (!left.size && !right.size) return 1;
  let shared = 0;
  for (const item of left) if (right.has(item)) shared += 1;
  return shared / (left.size + right.size - shared || 1);
}

const INJECTION_PATTERNS = [
  { re: /ignore\s+(all\s+|the\s+)?(previous|above|prior)\s+(instructions?|prompts?)/i, weight: 2 },
  { re: /忽略(以上|之前|前面|上述|此前).{0,10}(指令|提示|要求|规则)/, weight: 2 },
  { re: /<\s*\/?\s*(system|assistant|developer)\s*>/i, weight: 2 },
  { re: /(BEGIN|END)\s+SYSTEM\s+PROMPT/i, weight: 2 },
  { re: /(system prompt|系统提示词|开发者消息|developer message)/i, weight: 1 },
  { re: /(you are now|从现在开始你是|扮演.{0,10}(系统|管理员|开发者))/, weight: 1 },
];

function injectionRisk(value) {
  const text = String(value || '');
  let score = 0;
  const matched = [];
  for (const pattern of INJECTION_PATTERNS) {
    if (pattern.re.test(text)) {
      score += pattern.weight;
      matched.push(pattern.re.source.slice(0, 40));
    }
  }
  return { score, matched, high: score >= 2 };
}

function decodeEntities(value) {
  const named = {
    amp: '&',
    lt: '<',
    gt: '>',
    quot: '"',
    apos: "'",
    nbsp: ' ',
    hellip: '…',
    mdash: '—',
    ndash: '–',
  };
  return String(value).replace(
    /&(#x?[0-9a-f]+|[a-z][a-z0-9]+);/gi,
    (match, entity) => {
      if (entity[0] === '#') {
        const hex = entity[1] === 'x' || entity[1] === 'X';
        const code = Number.parseInt(entity.slice(hex ? 2 : 1), hex ? 16 : 10);
        return Number.isFinite(code) && code > 0 && code <= 0x10ffff
          ? String.fromCodePoint(code)
          : match;
      }
      return named[entity.toLowerCase()] || match;
    }
  );
}

function htmlToText(html) {
  const source = String(html || '');
  return normalizeContent(
    decodeEntities(
      source
        .replace(/<(script|style|noscript|svg|template)[\s\S]*?<\/\1>/gi, ' ')
        .replace(/<!--[\s\S]*?-->/g, ' ')
        .replace(/<(br|hr)\s*\/?>/gi, '\n')
        .replace(/<\/(p|div|li|tr|h[1-6]|section|article|blockquote|pre)>/gi, '\n')
        .replace(/<[^>]+>/g, ' ')
    )
  );
}

function extractHtmlTitle(html) {
  const match = String(html || '').match(/<title[^>]*>([\s\S]*?)<\/title>/i);
  return match ? normalizeContent(decodeEntities(match[1].replace(/<[^>]+>/g, ' '))) : '';
}

function splitPlainText(value, maxChars) {
  const text = normalizeContent(value);
  if (!text) return [];
  const limit = Number.isFinite(maxChars) && maxChars > 0 ? maxChars : 1800;
  if (text.length <= limit) return [text];

  const paragraphs = text.split(/\n{2,}/);
  const chunks = [];
  let current = '';

  const flush = () => {
    const trimmed = current.trim();
    if (trimmed) chunks.push(trimmed);
    current = '';
  };

  for (const paragraph of paragraphs) {
    if (paragraph.length > limit) {
      flush();
      let rest = paragraph;
      while (rest.length > limit) {
        let cut = rest.lastIndexOf('\n', limit);
        if (cut < limit * 0.5) cut = rest.lastIndexOf('。', limit);
        if (cut < limit * 0.5) cut = rest.lastIndexOf('. ', limit);
        if (cut < limit * 0.5) cut = limit;
        chunks.push(rest.slice(0, cut).trim());
        rest = rest.slice(cut).trim();
      }
      if (rest) current = rest;
      continue;
    }

    if (current && current.length + paragraph.length + 2 > limit) flush();
    current = current ? `${current}\n\n${paragraph}` : paragraph;
  }

  flush();
  return chunks.filter(Boolean);
}

function freshnessOf(timestamp, { staleAfterDays = 30, now = Date.now() } = {}) {
  const parsed = typeof timestamp === 'string' ? Date.parse(timestamp) : NaN;
  if (!Number.isFinite(parsed)) {
    return { status: 'unknown', at: null, ageMs: null };
  }
  const ageMs = Math.max(0, now - parsed);
  const staleMs = staleAfterDays * 24 * 60 * 60 * 1000;
  return {
    status: ageMs > staleMs ? 'stale' : 'fresh',
    at: new Date(parsed).toISOString(),
    ageMs,
  };
}

function authorityForSource(sourceType) {
  if (sourceType === 'memory') return 'user_memory';
  if (sourceType === 'conversation') return 'conversation';
  if (sourceType === 'document') return 'document';
  if (sourceType === 'web') return 'web';
  if (sourceType === 'code') return 'code';
  return 'unknown';
}

module.exports = {
  tokenize,
  exactTerms,
  codeIntent,
  detectLanguage,
  jaccard,
  injectionRisk,
  htmlToText,
  extractHtmlTitle,
  splitPlainText,
  freshnessOf,
  authorityForSource,
  truncateText,
  textLength,
};
