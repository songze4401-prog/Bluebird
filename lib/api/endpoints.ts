// 端点路径与查询串的唯一出口（阶段 4）。
//
// 重构前路径以模板字符串散落在 hooks / 组件 / lib 里（'/model-providers/${id}/test'
// 这类拼接错一个字符，只有运行到才炸）。集中在这里后：
//   - 路径拼错在 tsc 阶段就会被发现
//   - 加参数（如 sessionId）时只需改一处
//   - 测试与文档可以直接引用同一份常量

export const API_PATHS = {
  // 会话
  sessions: '/sessions',
  session: (id: string) => `/sessions/${encodeURIComponent(id)}`,

  // 历史
  history: (sessionId: string, limit = 200, before?: string | null) =>
    `/history?sessionId=${encodeURIComponent(sessionId)}&limit=${limit}` +
    (before ? `&before=${encodeURIComponent(before)}` : ''),
  historyClear: '/history/clear',
  historyRecall: '/history/recall',

  // 情绪 / 人格
  emotion: '/emotion',
  persona: '/persona',
  agentPolicy: '/agent-policy',

  // 记忆
  memory: '/memory',
  memoryDelete: '/memory/delete',
  memoryClear: '/memory/clear',
  memoryPending: '/memory/pending',
  memoryConfirm: '/memory/confirm',
  memoryReject: '/memory/reject',
  memoryArchive: '/memory/archive',

  // 附件上传
  uploads: '/uploads/image',
  uploadImage: (id: string) => `/uploads/image/${encodeURIComponent(id)}`,

  // 表情包仓库
  stickerRepo: '/sticker-repo',
  sticker: (id: string) => `/sticker-repo/${encodeURIComponent(id)}`,
  stickerImage: (id: string) => `/sticker-repo/${encodeURIComponent(id)}/image`,

  // 聊天
  chat: '/chat',
  chatStream: '/chat/stream',

  // 模型服务商
  modelProviders: '/model-providers',
  modelProvider: (id: string) =>
    `/model-providers/${encodeURIComponent(id)}`,
  modelProviderTest: (id: string) =>
    `/model-providers/${encodeURIComponent(id)}/test`,
  modelProviderEnabled: (id: string) =>
    `/model-providers/${encodeURIComponent(id)}/enabled`,
  modelDefaults: '/model-providers/default',

  // 在线状态
  presenceReport: '/presence/report',
  presence: (sessionId: string) =>
    `/presence?sessionId=${encodeURIComponent(sessionId)}`,

  // 系统监控（只读）
  monitoringMeta: '/monitoring/meta',
  monitoringOverview: (from: string, to: string) =>
    monitoringQuery('/monitoring/overview', { from, to }),
  monitoringMetrics: (from: string, to: string, names?: string[]) =>
    monitoringQuery('/monitoring/metrics', {
      from,
      to,
      ...(names && names.length ? { names: names.join(',') } : {}),
    }),
  monitoringTraces: (params: Record<string, string | number | undefined>) =>
    monitoringQuery('/monitoring/traces', params),
  monitoringTrace: (traceId: string) =>
    `/monitoring/traces/${encodeURIComponent(traceId)}`,
  monitoringEvents: (params: Record<string, string | number | undefined>) =>
    monitoringQuery('/monitoring/events', params),
  monitoringAudit: (from: string, to: string, limit = 50) =>
    monitoringQuery('/monitoring/audit', { from, to, limit }),
  monitoringTools: (from: string, to: string) =>
    monitoringQuery('/monitoring/tools', { from, to }),
  monitoringModels: (from: string, to: string) =>
    monitoringQuery('/monitoring/models', { from, to }),
  monitoringAlerts: '/monitoring/alerts',
  monitoringHealth: '/monitoring/health',
} as const;

function monitoringQuery(
  path: string,
  params: Record<string, string | number | undefined>
): string {
  const query = Object.entries(params)
    .filter(([, value]) => value !== undefined && value !== '')
    .map(([key, value]) => `${encodeURIComponent(key)}=${encodeURIComponent(String(value))}`)
    .join('&');

  return query ? `${path}?${query}` : path;
}
