// BUG-03 回归测试：表情包标记解析纯函数。
// 运行：node --test tests/sticker-markers.test.js
// 只依赖 node 内置 test/assert，不触碰 server/data 与任何网络。

const test = require('node:test');
const assert = require('node:assert/strict');

const {
  parseStickerMarkers,
  parseStickerMarkersForStream,
  isValidStickerId,
} = require('../lib/sticker-markers');

const ID = '9829f216-d27f-4006-973e-4642cc739c96';
const OTHER_ID = '00000000-0000-4000-8000-000000000001';

test('单条合法标记：整条正文只有一个表情包', () => {
  const segments = parseStickerMarkers(`[sticker:${ID}]`);

  assert.deepEqual(segments, [
    {
      type: 'sticker',
      id: ID,
      valid: true,
      marker: `[sticker:${ID}]`,
    },
  ]);
});

test('非法 ID：仍解析为表情包片段且 valid=false，不残留原始标记文本', () => {
  const text = '给你 [sticker:not-a-uuid] 看';
  const segments = parseStickerMarkers(text);

  assert.equal(segments.length, 3);
  assert.deepEqual(segments[1], {
    type: 'sticker',
    id: 'not-a-uuid',
    valid: false,
    marker: '[sticker:not-a-uuid]',
  });

  // 任何 text 片段都不包含原始标记，前端不可能把它当普通文字显示
  for (const segment of segments) {
    if (segment.type === 'text') {
      assert.ok(!segment.text.includes('[sticker:'));
    }
  }
});

test('一段文字里出现多处标记：文字/表情包交替且顺序正确', () => {
  const text = `早[sticker:${ID}]午[sticker:${OTHER_ID}]晚`;
  const segments = parseStickerMarkers(text);

  assert.deepEqual(
    segments.map(segment =>
      segment.type === 'text' ? `text:${segment.text}` : `sticker:${segment.id}`
    ),
    ['text:早', `sticker:${ID}`, 'text:午', `sticker:${OTHER_ID}`, 'text:晚']
  );
});

test('完全没有标记：原样返回单个 text 片段', () => {
  const text = '今天风很大，早点睡。\n别硬撑。';

  assert.deepEqual(parseStickerMarkers(text), [{ type: 'text', text }]);
});

test('标记夹在文字中间：切成 text / sticker / text', () => {
  const segments = parseStickerMarkers(`那就别撑了[sticker:${ID}]先躺会儿`);

  assert.equal(segments.length, 3);
  assert.deepEqual(segments[0], { type: 'text', text: '那就别撑了' });
  assert.equal(segments[1].type, 'sticker');
  assert.equal(segments[1].id, ID);
  assert.deepEqual(segments[2], { type: 'text', text: '先躺会儿' });
});

test('全角冒号与标记内空白同样识别', () => {
  const segments = parseStickerMarkers(`[sticker： ${ID} ]`);

  assert.equal(segments.length, 1);
  assert.equal(segments[0].type, 'sticker');
  assert.equal(segments[0].id, ID);
  assert.equal(segments[0].valid, true);
});

test('多行正文：换行保留在 text 片段中，不被标记解析破坏', () => {
  const segments = parseStickerMarkers(`第一行\n[sticker:${ID}]\n第三行`);

  assert.deepEqual(segments, [
    { type: 'text', text: '第一行\n' },
    { type: 'sticker', id: ID, valid: true, marker: `[sticker:${ID}]` },
    { type: 'text', text: '\n第三行' },
  ]);
});

test('ID 校验：UUID 合法、短串与空串非法', () => {
  assert.equal(isValidStickerId(ID), true);
  assert.equal(isValidStickerId(` ${ID} `), true);
  assert.equal(isValidStickerId('abc'), false);
  assert.equal(isValidStickerId(''), false);
});

test('空字符串 / 非字符串输入返回空数组，不抛异常', () => {
  assert.deepEqual(parseStickerMarkers(''), []);
  assert.deepEqual(parseStickerMarkers(null), []);
  assert.deepEqual(parseStickerMarkers(undefined), []);
});

test('流式前缀：标记逐字符到达时，任何中间态都不露出原始标记', () => {
  const prefixText = '等等';
  const full = `[sticker:${ID}]`;

  for (let i = 0; i <= full.length; i += 1) {
    const segments = parseStickerMarkersForStream(
      `${prefixText}${full.slice(0, i)}`
    );

    for (const segment of segments) {
      if (segment.type === 'text') {
        assert.ok(
          !segment.text.includes('['),
          `第 ${i} 个字符到达时泄露了标记：${segment.text}`
        );
      }
    }
  }

  // 右括号到齐后立即成为表情包片段，文字部分保持完整
  const done = parseStickerMarkersForStream(`${prefixText}${full}`);
  assert.deepEqual(done[0], { type: 'text', text: prefixText });
  assert.equal(done[1].type, 'sticker');
  assert.equal(done[1].id, ID);
});

test('流式半截标记：只扣留未闭合的尾部，前面的文字照常显示', () => {
  assert.deepEqual(
    parseStickerMarkersForStream('那就别撑了[sticker:9829f2'),
    [{ type: 'text', text: '那就别撑了' }]
  );

  // 单独一个 "[" 也不作为文字露出（随后续 delta 补齐）
  assert.deepEqual(parseStickerMarkersForStream('['), []);

  // 已闭合的标记不受影响
  const closed = parseStickerMarkersForStream(`[sticker:${ID}]`);
  assert.equal(closed.length, 1);
  assert.equal(closed[0].type, 'sticker');
});

test('完整但无效的 ID 在流式中同样只给 sticker 片段（valid=false）', () => {
  const segments = parseStickerMarkersForStream('[sticker:not-a-uuid]');

  assert.equal(segments.length, 1);
  assert.equal(segments[0].type, 'sticker');
  assert.equal(segments[0].valid, false);

  for (const segment of segments) {
    if (segment.type === 'text') {
      assert.ok(!segment.text.includes('[sticker:'));
    }
  }
});
