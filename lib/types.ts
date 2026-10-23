// 跨模块共享的类型定义

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
};

// /chat 响应里的单条回复气泡（replies 数组的元素）
export type ReplySegment = {
  id: string;
  content: string;
  createdAt?: string;
  // AI 回复带出的图片/表情包附件（服务端约定挂在最后一格气泡上）
  attachments?: Attachment[];
};
