// 前端调用的后端端点路径与超时预算，集中定义在此。
//
// 只收录「当前前端实际调用」的端点；服务端存在但前端未调用的端点不在此列。
// 路径用函数处理需要编码的动态段，避免调用方各自拼接时漏掉 encodeURIComponent。

export const API_PATHS = {
  // 会话
  sessions: '/sessions',
  session: (sessionId: string) => `/sessions/${encodeURIComponent(sessionId)}`,

  // 历史
  history: '/history',
  historyClear: '/history/clear',
  historyRecall: '/history/recall',

  // 聊天（流式 /chat/stream 由 lib/stream.ts 的 XHR 负责，不经过 client）
  chat: '/chat',
  chatStream: '/chat/stream',

  // 情绪 / 人格
  emotion: '/emotion',
  persona: '/persona',

  // 记忆
  memory: '/memory',
  memoryDelete: '/memory/delete',
  memoryClear: '/memory/clear',

  // 多服务商
  modelProviders: '/model-providers',
  modelProvider: (id: string) => `/model-providers/${encodeURIComponent(id)}`,
  modelProvidersDefault: '/model-providers/default',
  modelProviderEnabled: (id: string) =>
    `/model-providers/${encodeURIComponent(id)}/enabled`,
  modelProviderTest: (id: string) =>
    `/model-providers/${encodeURIComponent(id)}/test`,

  // 上传 / 表情包
  uploadsImage: '/uploads/image',
  uploadsImageById: (id: string) =>
    `/uploads/image/${encodeURIComponent(id)}`,
  stickerRepo: '/sticker-repo',
  stickerRepoById: (id: string) => `/sticker-repo/${encodeURIComponent(id)}`,
  stickerRepoImage: (id: string) =>
    `/sticker-repo/${encodeURIComponent(id)}/image`,

  // 在线状态
  presenceReport: '/presence/report',
} as const;

// 超时预算（毫秒）。
//   default 15s：新增的 JSON 请求默认值。
//   chat 60s：保持改造前 /chat 非流式的 60s。
//   stream 60s：保持 lib/stream.ts 的 XHR 60s（client 不接管流式）。
//   presence 10s：保持改造前 presence 上报的 10s。
//   upload 60s：上传 base64 图片体积较大，给更宽预算。
export const TIMEOUTS = {
  default: 15_000,
  chat: 60_000,
  stream: 60_000,
  presence: 10_000,
  upload: 60_000,
} as const;
