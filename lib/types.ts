// 跨模块共享的类型定义

export type Message = {
  id: string;
  role: 'user' | 'assistant';
  content: string;
  createdAt?: string; // ISO 时间，后端返回；前端发送时自己打
  retryText?: string;
  mood?: string;
};

// 会话元数据（与 GET /sessions 返回结构一致）
export type SessionMeta = {
  id: string;
  title: string;
  createdAt: string;
  updatedAt: string;
  messageCount: number;
};
