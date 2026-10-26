// 纯文本规则层的唯一接入点（阶段 5 模块边界）。
//
// 背景：lib 下有三份 CommonJS 运行时模块（split-reply / sticker-markers /
// streaming-segments）。它们必须是 CJS，因为同一份实现要同时被
//   1. 服务端直接 `node server/index.js` require（无构建步骤）
//   2. node:test 直接 require（tests/streaming-segments.test.js 等）
//   3. 前端 Metro 打包（可解析 .js）
// 共用。改成 TS/ESM 会给 1、2 引入构建步骤，收益不足以抵掉风险。
//
// 因此边界规则是：**整个前端只允许通过本文件访问这三份 CJS 模块**。
//   - 类型由同目录的 *.d.ts 提供（不再是 any 推断）
//   - 想迁移到 TS 时只需改这一个文件 + 删掉三个 .js
// 若新增调用方直接 import './streaming-segments'，边界即被打破。

export {
  MAX_SEGMENTS,
  splitReplyIntoSegments,
} from './split-reply';

export {
  STICKER_MARKER_RE,
  isValidStickerId,
  parseStickerMarkers,
  parseStickerMarkersForStream,
} from './sticker-markers';

export {
  buildStreamingBubbles,
  isStreamingBubble,
  replaceStreamingBlock,
  type StreamingBubble,
} from './streaming-segments';
