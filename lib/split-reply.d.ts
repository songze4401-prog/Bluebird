// 分段规则（运行时实现在 ./split-reply.js，CommonJS）。
//
// 为什么保留 .js + CJS：这份实现同时被
//   - 服务端 server/index.js（`node server/index.js` 直接运行，无构建步骤）
//   - node:test（tests/*.test.js 直接 require）
//   - 前端（Metro 打包，可解析 .js）
// 三处共用。改成 TS/ESM 会让服务端与测试需要引入构建步骤，
// 因此类型在这里以声明文件形式给出，运行体保持 CJS。

import type { ReplyMode } from './types';

// 单条回复的硬上限（码点）；超过才允许分片。唯一默认值来源。
export declare const DEFAULT_MAX_CHARS: number;

export declare function resolveMaxChars(value?: number | string): number;

// 把完整回复按语义边界切成若干条；空/纯空白文本返回空数组。
// mode 仅为兼容旧调用保留，不再影响切分。
export declare function splitReplyIntoSegments(
  text: string,
  mode?: ReplyMode,
  options?: { maxChars?: number }
): string[];
