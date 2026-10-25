// 流式分段纯函数测试（node:test）。
// 核心保障：流式期切分与 done 的权威分条同源，替换时零跳变（C-1）。

const test = require('node:test');
const assert = require('node:assert/strict');

const { splitReplyIntoSegments } = require('../lib/split-reply');
const {
  buildStreamingBubbles,
  replaceStreamingBlock,
  isStreamingBubble,
} = require('../lib/streaming-segments');

test('auto：多段文本切成多气泡，id 连续带前缀', () => {
  const text = '第一段内容足够长，超过六十个字符才会触发分段，这里再多写一点凑足长度。\n\n第二段也足够长，用来确保它会被独立切成一条气泡，不至于被并回第一段里面。';
  const bubbles = buildStreamingBubbles(text, 'auto', { idPrefix: 'p' });

  assert.ok(bubbles.length >= 2, `应切成多条，实际 ${bubbles.length}`);
  assert.deepEqual(
    bubbles.map(b => b.id),
    bubbles.map((_, i) => `p#${i}`)
  );
  assert.ok(bubbles.every(b => b.role === 'assistant'));
  assert.ok(bubbles.every(b => Array.isArray(b.segments)));
});

test('single：强制单气泡', () => {
  const text = '第一段够长够长够长够长够长够长。\n\n第二段也够长够长够长够长够长。';
  const bubbles = buildStreamingBubbles(text, 'single', { idPrefix: 'p' });
  assert.equal(bubbles.length, 1);
  assert.equal(bubbles[0].id, 'p#0');
});

test('封装上限：段落再多也不超过 4 条', () => {
  const text = [1, 2, 3, 4, 5, 6]
    .map(i => `这是第${i}段，长度需要超过六十个字符才会被自然分条处理，所以这里多写一些字。`)
    .join('\n\n');
  const bubbles = buildStreamingBubbles(text, 'auto', { idPrefix: 'p' });
  assert.equal(bubbles.length, 4);
});

test('done 一致性：流式切分内容与最终 splitReplyIntoSegments 逐字相同', () => {
  const samples = [
    '短回复',
    '第一段内容足够长，超过六十个字符才会触发分段，这里再多写一点凑足长度。\n\n第二段同样足够长，确保被独立成条。',
    '一句话。第二句。第三句。第四句。第五句。第六句。第七句。第八句。第九句。',
    'A\n\nB',
    '很长的一段没有任何换行但是这个段落本身也没有超过一百六十字所以它应该保持一条气泡不动。',
  ];

  for (const mode of ['single', 'auto', 'frequent']) {
    for (const text of samples) {
      const bubbles = buildStreamingBubbles(text, mode, { idPrefix: 'x' });
      assert.deepEqual(
        bubbles.map(b => b.content),
        splitReplyIntoSegments(text, mode),
        `mode=${mode} text=${JSON.stringify(text)}`
      );
    }
  }
});

test('空文本返回空数组；纯空白保留占位气泡', () => {
  assert.deepEqual(buildStreamingBubbles('', 'auto', { idPrefix: 'p' }), []);

  const blank = buildStreamingBubbles('\n\n', 'auto', { idPrefix: 'p' });
  assert.equal(blank.length, 1, '纯空白不应让气泡消失');
  assert.equal(blank[0].id, 'p#0');
});

test('未闭合 sticker 标记在尾段被扣留（A-1 不回归）', () => {
  const bubbles = buildStreamingBubbles('你好 [sticker:9829f2', 'auto', {
    idPrefix: 'p',
  });
  assert.equal(bubbles.length, 1);
  const json = JSON.stringify(bubbles[0].segments);
  assert.ok(!json.includes('sticker:9829f2'), `不应残留原始标记: ${json}`);
});

test('replaceStreamingBlock：原位置替换、无重复、保序', () => {
  const prev = [
    { id: 'u1', role: 'user', content: 'hi' },
    { id: 'p#0', role: 'assistant', content: 'a' },
    { id: 'p#1', role: 'assistant', content: 'b' },
    { id: 'u2', role: 'user', content: 'next' },
  ];
  const next = replaceStreamingBlock(prev, 'p', [
    { id: 'p#0', role: 'assistant', content: 'X' },
  ]);

  assert.deepEqual(
    next.map(m => m.id),
    ['u1', 'p#0', 'u2']
  );
  assert.equal(next[1].content, 'X');
});

test('replaceStreamingBlock：块不存在时追加到末尾', () => {
  const prev = [{ id: 'u1', role: 'user', content: 'hi' }];
  const next = replaceStreamingBlock(prev, 'p', [
    { id: 'p#0', role: 'assistant', content: 'x' },
  ]);
  assert.deepEqual(
    next.map(m => m.id),
    ['u1', 'p#0']
  );
});

test('isStreamingBubble：前缀判定', () => {
  assert.equal(isStreamingBubble({ id: 'p' }, 'p'), true);
  assert.equal(isStreamingBubble({ id: 'p#3' }, 'p'), true);
  assert.equal(isStreamingBubble({ id: 'other' }, 'p'), false);
  assert.equal(isStreamingBubble(null, 'p'), false);
});

test('frequent 比 auto 更积极（同等长文切得更多）', () => {
  const text = '一二三四五六七八九十。一二三四五六七八九十。一二三四五六七八九十。一二三四五六七八九十。一二三四五六七八九十。';
  const auto = buildStreamingBubbles(text, 'auto', { idPrefix: 'p' }).length;
  const freq = buildStreamingBubbles(text, 'frequent', { idPrefix: 'p' }).length;
  assert.ok(freq >= auto, `frequent=${freq} auto=${auto}`);
});
