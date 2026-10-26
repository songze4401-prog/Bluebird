// 聊天消息的纯变换层。
// 从 App.tsx 抽出：这些函数只做「服务端响应 / 流式文本 → 渲染用 Message[]」的
// 数据变换，不依赖 React、不发请求。抽出的目的是让 App 只做组合，
// 同时让这些规则可以被单独验证（不再埋在 1400 行组件里）。

import { Message, ModelRoute, ReplySegment } from './types';
import { makeLocalId, parseStickerMarkers } from './utils';
import {
  buildStreamingBubbles,
  isStreamingBubble,
  replaceStreamingBlock,
} from './streaming-segments';

// 服务端下发的分条模式（meta 事件与 persona 配置同源）
export type StreamMode = 'single' | 'auto' | 'frequent';

// /chat 响应归一化为分条数组：优先服务端 replies[]（连续消息模式），
// 字段缺失时回退为单条 reply —— 新旧服务端双向兼容
export function normalizeSegments(data: {
  reply?: string;
  replies?: ReplySegment[];
  assistantMessageId?: string;
  createdAt?: string;
}): ReplySegment[] {
  if (Array.isArray(data.replies)) {
    const valid = data.replies.filter(
      seg => seg && typeof seg.content === 'string' && seg.content.length > 0
    );

    if (valid.length > 0) return valid;
  }

  return typeof data.reply === 'string' && data.reply.length > 0
    ? [
        {
          id:
            typeof data.assistantMessageId === 'string'
              ? data.assistantMessageId
              : '',
          content: data.reply,
          createdAt: data.createdAt,
        },
      ]
    : [];
}

// 图片触发了服务端视觉能力路由时的提示文案。
// 唯一依据是后端返回的 modelRoute（前端不按预设规则猜测），
// auto=false 时返回 undefined，避免展示误导性的切换提示。
export function buildModelNote(route?: ModelRoute): string | undefined {
  if (!route || !route.auto || !route.actual) return undefined;

  const actual = [route.actual.providerName, route.actual.modelId]
    .filter(Boolean)
    .join(' · ');

  if (!actual) return undefined;

  const requested = [route.requested?.providerName, route.requested?.modelId]
    .filter(Boolean)
    .join(' · ');

  return requested
    ? `所选模型 ${requested} 不支持图片输入，本条由 ${actual} 处理`
    : `所选模型不支持图片输入，本条由 ${actual} 处理`;
}

// 数据层切分：assistant 消息进入 state 时就把 [sticker:ID] 解析成片段，
// 渲染层只拿可直接渲染的结构，不再对原始字符串跑正则。
// 已有片段的对象原样返回，避免流式每个 delta 都重建全部历史消息。
export function ensureSegments(message: Message): Message {
  if (message.role !== 'assistant' || message.segments) return message;

  return { ...message, segments: parseStickerMarkers(message.content) };
}

// 批量版本：所有写入 messages state 的入口都过这一层
export function ensureSegmentsAll(messages: Message[]): Message[] {
  return messages.map(ensureSegments);
}

// 流式分段：每收到一段 delta，就用与服务端 done 完全相同的规则
// （splitReplyIntoSegments）把累计文本切成气泡，最后一个是增长中的尾段。
// 之前是「全塞进一个临时气泡、done 时整体替换成 N 个」——那正是
// 「三段回复先并成一坨、下一帧才分裂」的根因。现在边界在流式期就按数据层
// 规则定死，done 时权威分条与这里同源，替换不会有跳变。
export function applyStreamingText(
  prev: Message[],
  tempId: string,
  text: string,
  mode: StreamMode,
  createdAt: string
): Message[] {
  return replaceStreamingBlock(
    prev,
    tempId,
    buildStreamingBubbles(text, mode, {
      idPrefix: tempId,
      createdAt,
    }) as Message[]
  );
}

// 流式收尾：用一组气泡替换整个流式块（done 的权威分条，或失败时的错误气泡）。
// 流式期可能已切成 tempId#0..#n 多个气泡，这里按前缀整体替换；
// 块不存在（用户已切走会话等）时直接追加。
export function reconcileStreamDone(
  prev: Message[],
  tempId: string,
  bubbles: Message[]
): Message[] {
  return replaceStreamingBlock(prev, tempId, bubbles) as Message[];
}

// 移除流式临时气泡（失败且不展示错误气泡的场景，如「继续说」失败）。
// 必须按块根判定：流式期气泡 id 是 `${tempId}#0..#n`，
// 精确比较 tempId 一条都删不到，会把半截回复留在屏幕上。
export function removeStreamBubble(
  prev: Message[],
  tempId: string
): Message[] {
  return prev.filter(m => !isStreamingBubble(m, tempId));
}

// 服务端最终回复（流式 done 或非流式 /chat）统一切成气泡数组。
// 两条路径共用这一个切分函数，避免"复制消息处理逻辑"：边界、mood、
// modelNote、附件透传全部在此处，done 与回退路径零差异。
export function buildReplyBubbles(
  data: {
    mood?: string;
    createdAt?: string;
    modelRoute?: ModelRoute;
  },
  segments: ReplySegment[]
): { bubbles: Message[]; replyMood: string } {
  const replyMood = typeof data.mood === 'string' ? data.mood : 'calm';
  const modelNote = buildModelNote(data.modelRoute);

  const bubbles: Message[] = segments.map((seg, index) => ({
    id: seg.id || `${makeLocalId()}-ai`,
    role: 'assistant',
    content: seg.content,
    mood: replyMood,
    createdAt: seg.createdAt ?? data.createdAt ?? new Date().toISOString(),
    // AI 回复的图片/表情包附件（服务端约定挂在最后一格气泡）
    ...(seg.attachments?.length ? { attachments: seg.attachments } : {}),
    // 自动视觉路由提示只挂在最后一格，避免整轮重复
    ...(index === segments.length - 1 && modelNote ? { modelNote } : {}),
  }));

  return { bubbles, replyMood };
}

// 空会话欢迎语：纯本地展示，不落盘、不计入服务端 messageCount
export function buildWelcomeMessages(): Message[] {
  return [
    {
      id: 'welcome-1',
      role: 'assistant',
      content: '我在',
    },
  ];
}

// 服务端 /history 条目 → 渲染用 Message
export function mapHistoryItem(
  item: {
    id?: string;
    role: 'user' | 'assistant';
    content: string;
    createdAt?: string;
    attachments?: Message['attachments'];
  },
  index: number
): Message {
  return {
    id: item.id ?? `history-${index}`,
    role: item.role,
    content: item.content,
    createdAt: item.createdAt,
    // 图片/表情包附件原样透传，气泡按 id 从服务端读取渲染
    ...(Array.isArray(item.attachments) && item.attachments.length
      ? { attachments: item.attachments }
      : {}),
  };
}
