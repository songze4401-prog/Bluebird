// 接口契约：各端点的请求 / 响应类型（阶段 4）。
//
// 每个类型都能在服务端找到对应证据（server/index.js 的 res.json 与 model-adapter 的
// 错误归一化），不按"应该长这样"推测。前端只在消费这些字段的地方声明类型，
// 不为了"看起来完整"去描述服务端没返回的东西。

import type {
  Attachment,
  ModelDefaults,
  ModelProvider,
  ModelRoute,
  PersonaConfig,
  ReplySegment,
  SessionMeta,
} from '../types';

// ---- 通用错误体 ----
// 服务端异常统一形状：{ error }；模型类错误额外带 code（= ModelCallError.kind）；
// development 下可能带 detail；清理类接口的 403 带 requireConfirm。
export type ApiErrorPayload = {
  error?: string;
  code?: string;
  detail?: string;
  requireConfirm?: boolean;
};

// ---- 会话 ----
export type SessionsResponse = { sessions: SessionMeta[] };

export type CreateSessionResponse = { session: SessionMeta };

export type DeleteSessionResponse = {
  ok: true;
  sessionId: string;
  message: string;
};

// ---- 历史 ----
// 服务端 /history 返回的条目：id 可选（旧数据可能没有），附件原样透传
export type HistoryMessage = {
  id?: string;
  role: 'user' | 'assistant';
  content: string;
  createdAt?: string;
  attachments?: Attachment[];
};

export type HistoryResponse = {
  sessionId: string;
  history: HistoryMessage[];
};

export type ClearHistoryResponse = {
  ok: true;
  sessionId: string;
  message: string;
};

export type RecallResponse = {
  ok: true;
  sessionId: string;
  removedCount: number;
  removedIds: string[];
};

// ---- 情绪 ----
// 服务端 getEmotion() 直接返回情绪 state 的浅拷贝
export type EmotionResponse = {
  emotion?: string;
  intensity?: number;
  [key: string]: unknown;
};

// ---- 人格 ----
export type PersonaResponse = {
  config: PersonaConfig;
  defaults?: PersonaConfig;
};

export type PersonaSaveResponse = { config: PersonaConfig };

// ---- 记忆 ----
export type MemoryItem = {
  content: string;
  type?: string;
  keywords?: string[];
  confidence?: number;
  sourceQuote?: string;
  createdAt?: string;
  updatedAt?: string;
};

export type MemoryListResponse = { memories: MemoryItem[] };

export type MemoryDeleteResponse = { ok: true; removed: boolean };

export type MemoryClearResponse = { ok: true; message: string };

// ---- 上传 / 表情包 ----
// 服务端 res.json({ ok: true, ...meta })，meta 即落库的附件元数据
export type UploadImageResponse = { ok: true } & Attachment;

export type StickerRepoResponse = {
  stickers: Attachment[];
  total: number;
};

export type AddStickerResponse = {
  ok: true;
  // true 表示服务端按 sha256 命中已有条目，没有新建
  existing: boolean;
  sticker: Attachment;
};

// ---- 模型服务商 ----
export type ModelProvidersResponse = {
  providers: ModelProvider[];
  defaults: ModelDefaults | null;
  builtinProviderId: string;
  configCorrupted: boolean;
};

export type ModelProviderResponse = { provider: ModelProvider };

export type ModelDefaultsResponse = { defaults: ModelDefaults | null };

// 连接测试：ok=false 时带 code（endpoint_missing / auth / rate_limit / ...）
export type ModelTestResponse = {
  ok: boolean;
  code?: string;
  error?: string;
  latencyMs?: number;
  httpStatus?: number;
};

// ---- 聊天 ----
// POST /chat 的成功响应；/chat/stream 的 done 事件字段与它完全一致
export type ChatResponse = {
  reply?: string;
  replies?: ReplySegment[];
  mood?: string;
  intensity?: number;
  model?: string;
  providerId?: string;
  upstreamModel?: string | null;
  modelRoute?: ModelRoute;
  sessionId?: string;
  userMessageId?: string | null;
  assistantMessageId?: string;
  createdAt?: string;
  persisted?: boolean;
};

// ---- 在线状态 ----
export type PresenceReportResponse = {
  ok: true;
  duplicate: boolean;
  presence: unknown;
};
