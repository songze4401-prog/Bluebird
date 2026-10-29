// 跨模块共享的类型定义

// 分条模式：服务端 persona 配置、SSE meta 事件、前端流式分段共用同一套取值。
// 阶段 5 起在这里唯一定义（此前 StreamMode / messageMode 各写一份字面量联合）。
export type ReplyMode = 'single' | 'auto' | 'frequent';

// 图片/表情包附件（与服务端 sessions.js sanitizeAttachments 的落库形状一致）
export type Attachment = {
  id: string; // 服务端 uploads / sticker-repo 模块分配的 UUID
  kind: 'image' | 'sticker';
  mime: string;
  name?: string;
  // 仅表情包：仓库条目已被物理删除时由 GET /history 标注，前端显示占位
  expired?: boolean;
};

// 待发送附件：上传已完成（拿到服务端 id），本地 dataURL 仅用于发送前预览
export type PendingAttachment = {
  attachment: Attachment;
  previewUri: string;
};

// 正文渲染结构：消息进入 state 前由 parseStickerMarkers 切好，
// 渲染层不再对原始字符串跑正则（避免流式半截标记闪成文字）。
export type TextSegment = { type: 'text'; text: string };
export type StickerSegment = {
  type: 'sticker';
  id: string;
  valid: boolean;
  marker: string;
};
export type ContentSegment = TextSegment | StickerSegment;

// Agent 工具执行摘要（服务端 sessions.js sanitizeToolSteps 的形状为准）。
// 刻意只有元数据：不含调用参数、不含记忆原文、不含模型推理，
// 所以可以直接渲染给用户。挂在一条 assistant 消息上（本轮最后一格）。
export type ToolStep = {
  name: string;
  ok: boolean;
  summary: string;
  durationMs: number;
};

// 渲染用形状：落盘的 ToolStep 与流式期 tool_start / tool_end 现场拼出来的
// 半成品统一收敛到这一个视图模型，pill 组件只认它。
// running=true 表示只收到了 tool_start、还没收到 tool_end（此时 ok 无意义）。
export type ToolStepView = {
  name: string;
  ok: boolean;
  summary: string;
  running: boolean;
};

// SSE 的工具进度事件（服务端 agent-runtime.js 的 onToolEvent 载荷）。
// callId 是同一次调用的配对键：tool_end 靠它找到自己的 tool_start。
export type ToolStreamEvent =
  | { type: 'tool_start'; name: string; callId: string }
  | {
      type: 'tool_end';
      name: string;
      callId: string;
      ok: boolean;
      summary?: string;
    };

export type Message = {
  id: string;
  role: 'user' | 'assistant';
  content: string;
  createdAt?: string; // ISO 时间，后端返回；前端发送时自己打
  retryText?: string;
  // 发送失败时随错误气泡记住附件，重试时原样带回（避免重试丢图）
  retryAttachments?: Attachment[];
  mood?: string;
  attachments?: Attachment[];
  // 已切好的正文片段（仅 assistant）：有值即直接渲染，不再解析 content
  segments?: ContentSegment[];
  // 模型路由提示（仅 assistant）：后端 modelRoute.auto 为真时展示
  // 「所选模型不支持图片输入，实际由哪个模型处理」，不落盘
  modelNote?: string;
  // Agent 新图互斥提示（仅 assistant）：本次响应携带，不落盘
  agentNotice?: string;
  // Agent 工具调用摘要（仅 assistant）：设计图里的「调用工具」pill
  toolSteps?: ToolStepView[];
};

// 会话元数据（与 GET /sessions 返回结构一致）
export type SessionMeta = {
  id: string;
  title: string;
  createdAt: string;
  updatedAt: string;
  messageCount: number;
};

// 人格面板配置（与 GET/PUT /persona 的结构一致，服务端 persona.js 为准）
export type PersonaConfig = {
  colloquial: number; // 口语化 0-100
  warmth: number; // 温暖程度 0-100
  initiative: number; // 主动表达 0-100
  length: number; // 表达长度 0-100
  messageMode: 'single' | 'auto' | 'frequent'; // 连续消息模式
  // 用户自填的人格提示词：只调表达方式，不授予工具权限（上限见服务端
  // CUSTOM_PROMPT_MAX_CHARS）。旧配置缺该字段时服务端迁移为 ''。
  customPrompt: string;
};

// 模型服务商（GET /model-providers 的脱敏视图）
// 后端永不下发完整 Key：只有 keyConfigured 布尔与脱敏 keyHint
export type ModelCapabilities = {
  vision: boolean;
};

export type ModelEntry = {
  id: string;
  name: string;
  enabled: boolean;
  capabilities: ModelCapabilities;
};

export type ModelProvider = {
  id: string;
  name: string;
  type: string;
  baseUrl: string;
  builtin: boolean;
  enabled: boolean;
  keyConfigured: boolean;
  keyHint: string | null;
  models: ModelEntry[];
};

export type ModelDefaults = {
  providerId: string;
  modelId: string;
};

// 后端路由结果（/chat 响应与 /chat/stream 的 done 事件同结构）
// requested 是本次所选模型（source=request 表示请求级选择，default 表示全局默认）
// actual 是真正下发的服务商/模型；auto 表示图片触发了视觉能力路由
export type ModelRoute = {
  requested: {
    providerId: string;
    providerName: string;
    modelId: string;
    source: 'request' | 'default';
  };
  actual: {
    providerId: string;
    providerName: string;
    modelId: string;
  };
  auto: boolean;
  reason: 'vision_unsupported' | null;
};

// /chat 响应里的单条回复气泡（replies 数组的元素）
export type ReplySegment = {
  id: string;
  content: string;
  createdAt?: string;
  // AI 回复带出的图片/表情包附件（服务端约定挂在最后一格气泡上）
  attachments?: Attachment[];
  // Agent 工具执行摘要（服务端同样只挂在最后一格）
  toolSteps?: ToolStep[];
};
