// 流式分段（运行时实现在 ./streaming-segments.js，CommonJS）。
// 保留 CJS 的原因见 split-reply.d.ts。

import type { ContentSegment, Message, ReplyMode } from './types';

// 流式期的临时气泡：id 为 `${idPrefix}#${index}`，
// content 是该段累计文本，segments 已按流式规则解析好
export type StreamingBubble = {
  id: string;
  role: 'assistant';
  content: string;
  createdAt?: string;
  segments: ContentSegment[];
};

// 把流式累计文本切成可直接渲染的气泡数组。
// 纯空白时返回单个占位气泡（不返回空数组，避免气泡闪没）；空串返回 []。
export declare function buildStreamingBubbles(
  text: string,
  mode: ReplyMode,
  options?: { idPrefix?: string; createdAt?: string }
): StreamingBubble[];

// 用新气泡整体替换旧的流式气泡块（保持原位置）；块不存在则追加到末尾。
// 入参与返回保持同一元素类型，便于调用方传 Message[]。
export declare function replaceStreamingBlock<T extends Message>(
  prev: T[],
  idPrefix: string,
  bubbles: T[]
): T[];

// 判断某条消息是否属于某个流式气泡块（id 为 prefix 或 prefix#N）
export declare function isStreamingBubble(
  message: Pick<Message, 'id'> | null | undefined,
  idPrefix: string
): boolean;
