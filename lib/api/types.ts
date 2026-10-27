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
  ToolStep,
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
// 服务端 /history 返回的条目：id 可选（旧数据可能没有），附件原样透传，
// toolSteps 为 Agent 工具执行摘要（仅 assistant、仅本轮最后一格，server
// sessions.js sanitizeToolSteps 产出）
export type HistoryMessage = {
  id?: string;
  role: 'user' | 'assistant';
  content: string;
  createdAt?: string;
  attachments?: Attachment[];
  toolSteps?: ToolStep[];
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

// 撤回响应：消息撤回与记忆撤回是分开的两件事。
// 服务端只有在两边都干净时才回 ok:true；
// 消息删成、记忆没删成时回 503 + partial:true + messagesRecalled:true，
// 客户端必须按 removedIds 收敛本地列表，再单独提示记忆失败。
export type RecallMemoryResult = {
  removedEntries?: number;
  removedContributions?: number;
  consistent?: boolean;
  reason?: string;
  status?: 'failed';
};

export type RecallResponse = {
  ok?: boolean;
  sessionId: string;
  removedCount: number;
  removedIds: string[];
  memory?: RecallMemoryResult;
  partial?: boolean;
  messagesRecalled?: boolean;
  error?: string;
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
  // 稳定 id：更正/删除优先用它定位（旧的 createdAt + content 定位仍受支持）
  id?: string;
  content: string;
  type?: string;
  keywords?: string[];
  confidence?: number;
  status?: 'active' | 'pending' | 'superseded' | 'archived';
  validFrom?: string;
  validTo?: string | null;
  supersededBy?: string | null;
  supersedes?: string | null;
  sourceQuote?: string;
  pendingReason?: string;
  pendingTargetId?: string | null;
  eventAt?: string | null;
  condition?: string | null;
  lastDecision?: {
    action?: string;
    reason?: string;
    at?: string;
    actor?: string;
    sourceType?: string;
  };
  createdAt?: string;
  updatedAt?: string;
};

export type MemoryListResponse = { memories: MemoryItem[] };

export type MemoryLifecycleResponse = {
  ok: true;
  id: string;
  removed?: number;
  updated?: number;
  reason?: string;
  status?: string;
};

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
  // Agent 工具执行摘要：有则同时出现在顶层与 replies 最后一格，
  // 无则整个字段不出现（旧响应零变化）
  toolSteps?: ToolStep[];
};

// ---- 在线状态 ----
export type PresenceReportResponse = {
  ok: true;
  duplicate: boolean;
  presence: unknown;
};
