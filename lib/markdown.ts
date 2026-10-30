/**
 * 轻量 Markdown 解析（无第三方依赖）。
 *
 * 只支持 Bluebird 实际会显示的子集：标题、段落、无序/有序列表、引用、
 * fenced code block、行内 code、bold、italic。解析器只产出结构化数据，
 * 渲染层从不使用 HTML/WebView，因此模型输出不可能注入 DOM。
 */

export type MarkdownInline =
  | { type: 'text'; text: string }
  | { type: 'code'; text: string }
  | { type: 'strong'; text: string }
  | { type: 'em'; text: string };

export type MarkdownBlock =
  | { type: 'heading'; level: 1 | 2 | 3; inlines: MarkdownInline[] }
  | { type: 'paragraph'; inlines: MarkdownInline[] }
  | { type: 'list'; ordered: boolean; items: MarkdownInline[][] }
  | { type: 'quote'; inlines: MarkdownInline[] }
  | { type: 'code'; language: string; code: string };

const INLINE_RE =
  /(\*\*[^*\s][^*]*\*\*|`[^`\r\n]+`|\*[^*\s][^*]*\*)/g;

export function parseInline(text: string): MarkdownInline[] {
  const source = String(text || '');
  const out: MarkdownInline[] = [];
  let lastIndex = 0;

  for (const match of source.matchAll(INLINE_RE)) {
    const index = match.index ?? 0;

    if (index > lastIndex) {
      out.push({ type: 'text', text: source.slice(lastIndex, index) });
    }

    const token = match[0];

    if (token.startsWith('**')) {
      out.push({ type: 'strong', text: token.slice(2, -2) });
    } else if (token.startsWith('`')) {
      out.push({ type: 'code', text: token.slice(1, -1) });
    } else {
      out.push({ type: 'em', text: token.slice(1, -1) });
    }

    lastIndex = index + token.length;
  }

  if (lastIndex < source.length) {
    out.push({ type: 'text', text: source.slice(lastIndex) });
  }

  return out.length ? out : [{ type: 'text', text: source }];
}

export function parseMarkdown(source: string): MarkdownBlock[] {
  const lines = String(source || '').replace(/\r\n?/g, '\n').split('\n');
  const blocks: MarkdownBlock[] = [];
  let paragraph: string[] = [];
  let index = 0;

  const flushParagraph = () => {
    if (!paragraph.length) return;
    const text = paragraph.join('\n').trim();
    if (text) blocks.push({ type: 'paragraph', inlines: parseInline(text) });
    paragraph = [];
  };

  while (index < lines.length) {
    const line = lines[index];
    const trimmed = line.trim();

    if (!trimmed) {
      flushParagraph();
      index += 1;
      continue;
    }

    const fence = trimmed.match(/^```([a-zA-Z0-9_+-]*)\s*$/);
    if (fence) {
      flushParagraph();
      const code: string[] = [];
      index += 1;
      while (index < lines.length && !/^```\s*$/.test(lines[index].trim())) {
        code.push(lines[index]);
        index += 1;
      }
      if (index < lines.length) index += 1;
      blocks.push({
        type: 'code',
        language: fence[1] || '',
        code: code.join('\n'),
      });
      continue;
    }

    const heading = trimmed.match(/^(#{1,3})\s+(.+)$/);
    if (heading) {
      flushParagraph();
      blocks.push({
        type: 'heading',
        level: Math.min(3, heading[1].length) as 1 | 2 | 3,
        inlines: parseInline(heading[2]),
      });
      index += 1;
      continue;
    }

    if (/^>\s?/.test(trimmed)) {
      flushParagraph();
      const quote: string[] = [];
      while (index < lines.length && /^>\s?/.test(lines[index].trim())) {
        quote.push(lines[index].trim().replace(/^>\s?/, ''));
        index += 1;
      }
      blocks.push({ type: 'quote', inlines: parseInline(quote.join('\n')) });
      continue;
    }

    const unordered = trimmed.match(/^[-*+]\s+(.+)$/);
    const ordered = trimmed.match(/^\d+[.)]\s+(.+)$/);
    if (unordered || ordered) {
      flushParagraph();
      const isOrdered = Boolean(ordered);
      const items: MarkdownInline[][] = [];
      while (index < lines.length) {
        const current = lines[index].trim();
        const match = isOrdered
          ? current.match(/^\d+[.)]\s+(.+)$/)
          : current.match(/^[-*+]\s+(.+)$/);
        if (!match) break;
        items.push(parseInline(match[1]));
        index += 1;
      }
      blocks.push({ type: 'list', ordered: isOrdered, items });
      continue;
    }

    paragraph.push(trimmed);
    index += 1;
  }

  flushParagraph();
  return blocks;
}
