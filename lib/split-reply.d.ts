// 分段规则（运行时实现在 ./split-reply.js，CommonJS）。
//
// 为什么保留 .js + CJS：这份实现同时被
//   - 服务端 server/index.js（`node server/index.js` 直接运行，无构建步骤）
//   - node:test（tests/streaming-segments.test.js 直接 require）
//   - 前端（Metro 打包，可解析 .js）
// 三处共用。改成 TS/ESM 会让服务端与测试需要引入构建步骤，
// 因此类型在这里以声明文件形式给出，运行体保持 CJS。

import type { ReplyMode } from './types';

// 单次回复最多切成的条数（超过则合并尾段）
export declare const MAX_SEGMENTS: number;

// 把完整回复按模式切成若干条；空/纯空白文本返回空数组
export declare function splitReplyIntoSegments(
  text: string,
  mode?: ReplyMode
): string[];
