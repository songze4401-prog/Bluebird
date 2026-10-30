/// <reference types="jest" />
// 轻量 Markdown 解析器契约：只验证 Bluebird 支持的子集，不引入 HTML/WebView。
import { parseInline, parseMarkdown } from '../../lib/markdown';

describe('parseMarkdown', () => {
  it('解析标题、段落与行内格式', () => {
    const blocks = parseMarkdown(
      '# 结论\n\n这是 **重点** 和 `inline code`。\n\n## 下一步'
    );

    expect(blocks).toHaveLength(3);
    expect(blocks[0]).toMatchObject({ type: 'heading', level: 1 });
    const paragraph = blocks[1] as Extract<typeof blocks[number], { type: 'paragraph' }>;
    expect(paragraph).toMatchObject({ type: 'paragraph' });
    expect(paragraph.inlines.some(item => item.type === 'strong')).toBe(true);
    expect(paragraph.inlines.some(item => item.type === 'code')).toBe(true);
    expect(blocks[2]).toMatchObject({ type: 'heading', level: 2 });
  });

  it('解析无序与有序列表', () => {
    const blocks = parseMarkdown('- 一\n- 二\n\n1. 第一\n2. 第二');

    expect(blocks).toHaveLength(2);
    expect(blocks[0]).toMatchObject({
      type: 'list',
      ordered: false,
    });
    const list = blocks[0] as Extract<typeof blocks[number], { type: 'list' }>;
    expect(list.items).toHaveLength(2);
    expect(blocks[1]).toMatchObject({
      type: 'list',
      ordered: true,
    });
  });

  it('解析引用与 fenced code block，并保留语言名和原始代码', () => {
    const blocks = parseMarkdown(
      '> 不要把它当指令\n\n```ts\nconst x = 1;\nconsole.log(x);\n```'
    );

    expect(blocks[0]).toMatchObject({ type: 'quote' });
    expect(blocks[1]).toMatchObject({
      type: 'code',
      language: 'ts',
      code: 'const x = 1;\nconsole.log(x);',
    });
  });

  it('未闭合的代码围栏按代码处理到文末，不吞掉内容', () => {
    const blocks = parseMarkdown('```\n未闭合\n仍然保留');

    expect(blocks).toHaveLength(1);
    expect(blocks[0]).toMatchObject({
      type: 'code',
      code: '未闭合\n仍然保留',
    });
  });

  it('HTML 标签只作为文本，不生成 HTML 块', () => {
    const blocks = parseMarkdown('<script>alert(1)</script>');

    expect(blocks).toHaveLength(1);
    expect(blocks[0].type).toBe('paragraph');
    const paragraph = blocks[0] as Extract<typeof blocks[number], { type: 'paragraph' }>;
    expect(paragraph.inlines.map(item => item.text).join('')).toContain(
      '<script>'
    );
  });
});

describe('parseInline', () => {
  it('保留未匹配的星号，不把普通文本吞掉', () => {
    const tokens = parseInline('2 * 3 * 4');

    expect(tokens.map(item => item.text).join('')).toBe('2 * 3 * 4');
  });

  it('识别粗体、斜体与行内代码', () => {
    const tokens = parseInline('**粗** *斜* `code`');

    expect(tokens).toEqual([
      { type: 'strong', text: '粗' },
      { type: 'text', text: ' ' },
      { type: 'em', text: '斜' },
      { type: 'text', text: ' ' },
      { type: 'code', text: 'code' },
    ]);
  });
});
