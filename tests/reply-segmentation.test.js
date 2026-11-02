/**
 * 回复分段回归：一条回复默认一条消息；只有超过硬上限才按语义边界分片。
 * 纯函数测试（node:test），不依赖服务进程。
 */
const test = require('node:test');
const assert = require('node:assert/strict');

const {
  DEFAULT_MAX_CHARS,
  splitReplyIntoSegments,
} = require('../lib/split-reply');

function assertInvariant(text, segments) {
  assert.equal(
    segments.join('').replace(/\s+/g, ''),
    text.replace(/\s+/g, ''),
    '分片不得丢字或重复'
  );
}

test('80 字以内短回复只有一条消息', () => {
  const text = '好的，我记住了：你更喜欢浅烘咖啡，不加糖。'.repeat(3);
  assert.ok([...text].length <= 80);
  const segments = splitReplyIntoSegments(text);
  assert.deepEqual(segments, [text]);
});

test('1200 字、5 段中文：按段落切分且不出现半句结尾', () => {
  const paragraph = `测试段落：${'这是一句用于验证语义切分的内容。'.repeat(16)}`;
  const text = [1, 2, 3, 4, 5].map(i => `${i}. ${paragraph}`).join('\n\n');
  assert.ok([...text].length >= 1200);
  const segments = splitReplyIntoSegments(text);
  assert.ok(segments.length >= 3, `actual=${segments.length}`);
  for (const segment of segments) {
    assert.ok([...segment].length <= DEFAULT_MAX_CHARS, `len=${[...segment].length}`);
    assert.match(segment, /[。！？!?]$/, `半句结尾：${segment.slice(-12)}`);
  }
  assertInvariant(text, segments);
});

test('800 字无标点长串：按长度硬切但不切坏代码块', () => {
  const text =
    'A'.repeat(300) +
    '\n\n```js\n' +
    'const value = 1;\n'.repeat(12) +
    '```\n\n' +
    'B'.repeat(300);
  assert.ok([...text].length >= 800);
  const segments = splitReplyIntoSegments(text);
  const codeSegments = segments.filter(segment => segment.includes('```'));
  assert.equal(codeSegments.length, 1, '代码块应完整落在同一条消息里');
  assert.equal((codeSegments[0].match(/```/g) || []).length, 2, '围栏必须成对');
  assert.equal(
    codeSegments[0].split('\n').filter(line => line.startsWith('const ')).length,
    12,
    '代码内容不得丢失'
  );
  assertInvariant(text, segments);
});

test('代码块本身超过上限时保持完整（允许单条超限，不截断代码）', () => {
  const text = '```js\n' + 'x'.repeat(520) + '\n```';
  const segments = splitReplyIntoSegments(text);
  assert.equal(segments.length, 1);
  assert.equal(segments[0], text);
});

test('Markdown 链接不会被硬切拆开', () => {
  const link = '[项目文档](https://example.com/docs/architecture?from=chat)';
  const text = '前缀说明文字。'.repeat(60) + ` 参考 ${link} 了解详情。`;
  const segments = splitReplyIntoSegments(text);
  const linkSegments = segments.filter(segment => segment.includes(']('));
  assert.equal(linkSegments.length, 1);
  assert.ok(linkSegments[0].includes(link), '链接必须完整保留在同一片');
  assert.ok(segments.every(segment => !segment.endsWith('[')));
  assertInvariant(text, segments);
});

test('英文长文本按单词边界切分，不拆单词', () => {
  const words = ['alpha', 'beta', 'gamma', 'delta'];
  const text = Array.from({ length: 200 }, (_, i) => words[i % words.length]).join(' ');
  const segments = splitReplyIntoSegments(text);
  assert.ok(segments.length >= 2);
  for (const segment of segments) {
    assert.ok(
      segment.split(/\s+/).every(word => words.includes(word)),
      `出现被拆断的单词：${segment.slice(0, 20)}`
    );
  }
  assertInvariant(text, segments);
});

test('优先在双换行处切分，而不是单换行或长度硬切', () => {
  const first = `${'甲'.repeat(230)}。`;
  const second = `${'乙'.repeat(230)}。`;
  const text = `${first}\n\n${second}`;
  const segments = splitReplyIntoSegments(text);
  assert.equal(segments[0], first);
  assert.equal(segments[1], second);
});

test('maxChars 可覆盖默认上限，且仍按标点边界切分', () => {
  const text = '这是一句完整的话。'.repeat(20);
  const segments = splitReplyIntoSegments(text, 'auto', { maxChars: 50 });
  assert.ok(segments.length > 1);
  for (const segment of segments) {
    assert.ok([...segment].length <= 50, `len=${[...segment].length}`);
    assert.match(segment, /[。！？!?]$/);
  }
  assertInvariant(text, segments);
});

test('没有任何边界时才按长度硬切', () => {
  const text = 'X'.repeat(500);
  const segments = splitReplyIntoSegments(text);
  assert.deepEqual(segments.map(segment => segment.length), [400, 100]);
  assertInvariant(text, segments);
});

test('空文本返回空数组；短文本不受 maxChars 默认值影响', () => {
  assert.deepEqual(splitReplyIntoSegments('   '), []);
  assert.deepEqual(splitReplyIntoSegments('只有一句。'), ['只有一句。']);
});
