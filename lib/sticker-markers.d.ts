// 表情包标记解析（运行时实现在 ./sticker-markers.js，CommonJS）。
// 保留 CJS 的原因见 split-reply.d.ts：前端 / 服务端 / node:test 共用同一份实现。
// 类型在此声明，运行体保持零依赖、可直接 require。

import type { ContentSegment } from './types';

// `[sticker:ID]` / `[sticker：ID]` 的全局正则（供需要自行扫描的调用方复用）
export declare const STICKER_MARKER_RE: RegExp;

// 服务端分配的表情包 id 是否形如合法 uuid
export declare function isValidStickerId(id: unknown): boolean;

// 完整文本解析：所有标记立即生效（用于已落库的历史消息）
export declare function parseStickerMarkers(text: string): ContentSegment[];

// 流式解析：末尾未闭合的 `[sticker:` 片段先扣留，避免闪出方括号
export declare function parseStickerMarkersForStream(
  text: string
): ContentSegment[];
