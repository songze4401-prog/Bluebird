// 接口契约：各端点的请求 / 响应类型（阶段 4）。
//
// 每个类型都能在服务端找到对应证据（server/index.js 的 res.json 与 model-adapter 的
// 错误归一化），不按"应该长这样"推测。前端只在消费这些字段的地方声明类型，
// 不为了"看起来完整"去描述服务端没返回的东西。

import type {
  AgentPolicyConfig,
  AgentPolicyTool,
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
  // 分页字段为新增可选项：旧服务端不返回时前端按“没有更早消息”处理。
  hasMore?: boolean;
  nextCursor?: string | null;
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

// ---- Agent 工作策略 ----
export type AgentPolicyMeta = {
  schemaVersion: number;
  revision: number;
  updatedAt: string | null;
  digest: string;
  corrupted: boolean;
  writeBlocked: boolean;
  error?: string;
  recovery?: string;
};

export type AgentPolicyResponse = {
  policy: AgentPolicyConfig;
  defaults: AgentPolicyConfig;
  meta: AgentPolicyMeta;
  limits: {
    maxRounds: { min: number; max: number };
    maxToolCalls: { min: number; max: number };
    maxTotalMs: { min: number; max: number };
    maxReadOnlyRetries: { min: number; max: number };
    maxAllowedTools: number;
  };
  runtimeLimits: { maxRounds: number };
  // 服务端只读运行状态：全局开关由环境变量控制，前端不得伪造可写开关。
  runtime?: {
    switchOn: boolean;
    maxRounds: number;
    toolTimeoutDefaultMs: number;
    imageRequestsDisableTools: boolean;
  };
  availableTools: AgentPolicyTool[];
};

export type AgentPolicySaveResponse = {
  policy: AgentPolicyConfig;
  meta: AgentPolicyMeta;
};

// ---- 人格 ----
export type PersonaResponse = {
  config: PersonaConfig;
  defaults?: PersonaConfig;
  // 字段上限由服务端下发（persona.js 为唯一来源），前端字数提示直接用它
  limits?: { customPromptMaxChars?: number };
};

export type PersonaSaveResponse = { config: PersonaConfig };

// ---- 记忆 ----
export type MemoryContribution = {
  sessionId?: string | null;
  sourceQuote: string;
  createdAt?: string | null;
  messageId?: string;
  sourceType?: string;
};

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
  contributions?: MemoryContribution[];
  pendingReason?: string;
  pendingAt?: string | null;
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

export type MemoryListResponse = {
  memories: MemoryItem[];
  scope?: 'active' | 'all';
};

export type MemoryWriteAttempt = {
  at: string;
  sessionId?: string | null;
  written: boolean;
  action: string;
  reason?: string | null;
  id?: string | null;
  supersededId?: string | null;
  decision?: string;
  status?: string;
  targetId?: string | null;
  errorCode?: string;
};

export type MemoryWriteAttemptsResponse = { attempts: MemoryWriteAttempt[] };

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
  // 新图触发 Agent 工具互斥时的用户提示（仅本次响应，不落盘）
  agentNotice?: string;
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

// ---- 系统监控（只读） ----
// 字段与服务端 server/monitoring/* 的真实返回一一对应；未知/未采集用 null，
// 不用 0 冒充健康。所有时间均为 UTC ISO。
export type MonitoringMetricValue = {
  label: string;
  value: number | string | number[] | null;
  unit: string;
  note?: string;
  definition?: string;
  approximate?: boolean;
};

export type MonitoringCard = {
  key: string;
  title: string;
  data_status: 'ok' | 'no_data' | 'disabled' | 'unknown';
  primary: MonitoringMetricValue;
  metrics: MonitoringMetricValue[];
};

export type MonitoringCoverage = {
  retained_events?: number;
  retained_traces?: number;
  retention_days?: number | null;
  approximate_percentiles?: boolean;
};

export type MonitoringOverviewResponse = {
  ok: boolean;
  reason?: string;
  data_status?: string;
  generated_at?: string;
  range?: { from: string; to: string; duration_minutes: number };
  cards?: MonitoringCard[];
  alerts?: {
    firing: number;
    by_severity: Record<string, number>;
    notifications: { configured: boolean; reason?: string };
  };
  monitoring_health?: {
    status: string;
    reasons: string[];
    data_freshness_seconds: number | null;
  };
  backup?: MonitoringBackup;
  cost?: { status: string; value: number | null; currency: string | null; note: string };
  definitions?: Record<string, MonitoringMetricDefinition>;
  coverage?: MonitoringCoverage;
};

export type MonitoringMetricDefinition = {
  type: 'counter' | 'histogram';
  unit: string;
  description: string;
  labels: string[];
  buckets?: number[];
};

export type MonitoringMetricPoint = {
  ts: string;
  count: number;
  sum: number;
  avg: number | null;
  p50?: { value: number; approximate: boolean } | null;
  p95?: { value: number; approximate: boolean } | null;
  p99?: { value: number; approximate: boolean } | null;
  approximate?: boolean;
  samples: number;
};

export type MonitoringMetricsResponse = {
  ok: boolean;
  reason?: string;
  generated_at?: string;
  approximate_percentiles?: boolean;
  series?: {
    name: string;
    definition: MonitoringMetricDefinition;
    interval_minutes: number;
    points: MonitoringMetricPoint[];
  }[];
};

export type MonitoringTraceSummary = {
  trace_id: string;
  name: string;
  started_at: string;
  duration_ms: number | null;
  status: string;
  error_code: string | null;
  error_category: string | null;
  session_ref: string | null;
  task: { status: string; termination: string | null };
  stages: {
    candidate: number | null;
    selected: number | null;
    accepted: number | null;
    injected: number | null;
    sent: number | null;
    consumed: number | null;
  };
  model: {
    rounds: number;
    calls: number;
    total_tokens: number | null;
    usage_source: string;
    model_ids: string[];
    cached_tokens?: number | null;
  };
  tools: {
    requested: number;
    executed: number;
    succeeded: number;
    failed: number;
    deduped: number;
    duration_ms: number;
  };
  span_count: number;
  event_count: number;
};

export type MonitoringTracesResponse = {
  ok: boolean;
  reason?: string;
  generated_at?: string;
  items?: MonitoringTraceSummary[];
  nextCursor?: string | null;
  hasMore?: boolean;
  total?: number;
  coverage?: MonitoringCoverage;
};

export type MonitoringSpan = {
  span_id: string;
  parent_span_id: string | null;
  name: string;
  started_at: string;
  ended_at: string | null;
  duration_ms: number | null;
  status: string;
  error_code: string | null;
  attributes: Record<string, unknown>;
};

export type MonitoringTraceDetail = {
  trace_id: string;
  name: string;
  started_at: string;
  ended_at: string | null;
  duration_ms: number | null;
  status: string;
  error_code: string | null;
  error_category: string | null;
  session_ref: string | null;
  spans: MonitoringSpan[];
  spans_dropped: number;
  stages: MonitoringTraceSummary['stages'];
  event_count: number;
  model: MonitoringTraceSummary['model'] & {
    input_tokens: number | null;
    output_tokens: number | null;
    cached_tokens?: number | null;
    provider_ids: string[];
  };
  tools: MonitoringTraceSummary['tools'];
  task: { status: string; termination: string | null; duration_ms?: number };
  context: Record<string, unknown> | null;
  counts: Record<string, number>;
};

export type MonitoringTraceDetailResponse = {
  ok: boolean;
  reason?: string;
  trace?: MonitoringTraceDetail;
  events?: MonitoringEvent[];
  events_total?: number;
  events_truncated?: boolean;
};

export type MonitoringEvent = {
  schema_version: number;
  event_id: string;
  event_name: string;
  occurred_at: string;
  collected_at: string;
  component: string;
  level: string;
  status: string;
  duration_ms: number | null;
  trace_id: string | null;
  span_id: string | null;
  session_ref: string | null;
  error_code: string | null;
  error_category: string | null;
  attributes: Record<string, unknown>;
};

export type MonitoringEventsResponse = {
  ok: boolean;
  reason?: string;
  generated_at?: string;
  items?: MonitoringEvent[];
  nextCursor?: string | null;
  hasMore?: boolean;
  total?: number;
  coverage?: MonitoringCoverage;
};

export type MonitoringAuditRecord = {
  audit_id: string;
  occurred_at: string;
  action: string;
  target: string | null;
  result: string;
  actor_ref: string | null;
  session_ref: string | null;
  reason: string | null;
};

export type MonitoringAuditResponse = {
  ok: boolean;
  reason?: string;
  items?: MonitoringAuditRecord[];
  total?: number;
};

export type MonitoringTool = {
  name: string;
  description?: string;
  read_only: boolean;
  side_effect: boolean;
  timeout_ms: number;
  registered: boolean;
  calls: number;
  success: number;
  failed: number;
  timeout: number;
  denied: number;
  p95: number | null;
};

export type MonitoringToolsResponse = {
  ok: boolean;
  reason?: string;
  data_status?: string;
  agent_switch_on?: boolean;
  agent_switch_note?: string;
  tools?: MonitoringTool[];
  missing_capabilities?: string[];
};

export type MonitoringModelRow = {
  provider_id: string;
  model_id: string;
  requests: number;
  success: number;
  failed: number;
  timeout: number;
  denied: number;
  cancelled: number;
  input_tokens: number | null;
  output_tokens: number | null;
  cached_tokens?: number | null;
  usage_missing: number;
  duration: { avg: number | null; p50: number | null; p95: number | null; p99: number | null };
};

export type MonitoringModelsResponse = {
  ok: boolean;
  reason?: string;
  models?: MonitoringModelRow[];
  cost?: { status: string; note: string };
};

export type MonitoringAlert = {
  alert_id: string;
  rule_id: string;
  rule_name: string;
  rule_version: number;
  severity: string;
  status: 'firing' | 'resolved';
  triggered_at: string;
  last_evaluated_at: string;
  resolved_at: string | null;
  suppressed_evaluations: number;
  evidence: Record<string, unknown>;
  note: string;
};

export type MonitoringAlertRule = {
  id: string;
  name: string;
  severity: string;
  version: number;
  description: string;
  window_minutes: number;
  min_samples: number;
  enabled: boolean;
  disabled_reason?: string;
};

export type MonitoringAlertsResponse = {
  ok: boolean;
  reason?: string;
  items?: MonitoringAlert[];
  total?: number;
  rules?: MonitoringAlertRule[];
  states?: { rule: MonitoringAlertRule; state: string; last_evaluated_at: string | null }[];
  health?: {
    initialized: boolean;
    rule_count: number;
    enabled_rules: number;
    evaluations: number;
    evaluation_errors: number;
    last_evaluated_at: string | null;
    active_alerts: number;
    notifications: { configured: boolean; reason: string };
  };
};

export type MonitoringBackup = {
  source: string;
  code_present?: boolean;
  exists: boolean;
  ok: boolean;
  stale?: boolean | null;
  age_hours?: number | null;
  reason?: string | null;
  last_success_at?: string | null;
  consecutive_failures?: number | null;
  same_volume_as_source?: boolean | null;
  disaster_recovery_grade?: boolean | null;
  restore_drill?: string;
  restore_drill_note?: string;
  scheduled_task_configured?: string;
  scheduled_task_note?: string;
};

export type MonitoringHealthResponse = {
  ok: boolean;
  data_status?: string;
  status: string;
  enabled: boolean;
  reasons: string[];
  generated_at?: string;
  uptime_seconds?: number;
  data_freshness_seconds?: number | null;
  last_event_at?: string | null;
  counters?: Record<string, number | string | null>;
  metrics?: Record<string, unknown>;
  alerting?: MonitoringAlertsResponse['health'];
  persistence?: {
    source: string;
    writes: number;
    failed: number;
    ok: boolean | null;
    note: string;
  };
  backup?: MonitoringBackup;
  storage?: {
    retained_events: number;
    retained_traces: number;
    retained_audit: number;
    retained_alerts: number;
    queue_depth: number;
    bytes: { total_bytes: number; files: Record<string, number | null> } | null;
    limits: Record<string, unknown> | null;
  };
  memory?: { rss_bytes: number; heap_used_bytes: number; external_bytes: number } | null;
  capabilities?: Record<string, unknown>;
  query_layer?: { calls: number; errors: number; last_query_at: string | null };
};

// ---- Memory Bot ----
export type AgentCredentialSummary = {
  credentialId: string;
  botId: string;
  providerId: string;
  keyHint: string;
  createdAt: string;
  updatedAt: string;
  lastVerifiedAt?: string | null;
  lastVerifyOk?: boolean | null;
};

export type AgentSummary = {
  botId: string;
  displayName: string;
  version: string;
  description: string;
  capabilities: string[];
  acceptedTaskTypes: string[];
  entrypoints: string[];
  permissionProfileId: string;
  toolAllowlist: string[];
  availableTools: string[];
  permission: AgentPermissionProfile;
  status: 'enabled' | 'disabled' | 'degraded';
  statusReason: string | null;
  enabled: boolean;
  model: {
    providerId: string;
    modelId: string;
    temperature: number;
    maxTokens: number;
    timeoutMs: number;
  };
  credential: AgentCredentialSummary | null;
  sessionsCount: number;
  lastActivityAt: string | null;
  updatedAt: string;
};

export type AgentPermissionProfile = {
  profileId: string;
  mode: 'single_user' | string;
  actorId: string;
  allowedOperations: string[];
  approvalRequired: string[];
  extensionPoint: { multiUser: boolean; aclResolver: string };
};

export type AgentApproval = {
  approvalId: string;
  botId: string;
  taskId: string | null;
  sessionId: string | null;
  operation: string;
  payload: Record<string, unknown>;
  risk: string;
  status: 'pending' | 'approved' | 'rejected' | 'executing' | 'completed' | 'failed';
  requestedBy: string;
  requestedAt: string;
  decidedBy: string | null;
  decidedAt: string | null;
  executedBy: string | null;
  executedAt: string | null;
  reason: string | null;
  errorCode: string | null;
  result: Record<string, unknown> | null;
};

export type AgentApprovalsResponse = { approvals: AgentApproval[] };
export type AgentApprovalResponse = { approval: AgentApproval };

export type AgentsResponse = { agents: AgentSummary[] };
export type AgentResponse = { agent: AgentSummary };

export type AgentConfig = {
  botId: string;
  enabled: boolean;
  modelProfile: {
    providerId: string;
    modelId: string;
    credentialId?: string | null;
    temperature: number;
    maxTokens: number;
    timeoutMs: number;
  };
  prompt: { systemPrompt: string; version: string };
  toolAllowlist: string[];
  permissionProfileId: string;
  updatedAt: string;
};

export type AgentConfigResponse = {
  config: AgentConfig;
  agent: AgentSummary;
};

export type AgentCredentialResponse = {
  credential: AgentCredentialSummary;
  agent: AgentSummary;
};

export type AgentVerifyResponse = {
  ok: boolean;
  code: string;
  error: string;
  httpStatus: number | null;
  latencyMs: number;
  credential?: AgentCredentialSummary | null;
  agent: AgentSummary;
};

export type AgentSession = {
  id: string;
  botId: string;
  title: string;
  createdAt: string;
  updatedAt: string;
  messageCount: number;
};

export type AgentChatMessage = {
  id: string;
  role: 'user' | 'assistant';
  content: string;
  createdAt: string;
  toolSteps?: ToolStep[];
};

export type AgentSessionDetailResponse = {
  session: AgentSession;
  messages: AgentChatMessage[];
};

export type AgentSessionsResponse = { sessions: AgentSession[] };

export type AgentChatResponse = {
  ok: true;
  botId: string;
  sessionId: string;
  session: AgentSession;
  message: AgentChatMessage;
  toolSteps: ToolStep[];
  evidence?: Array<{ kind: string; id: string }>;
  changes?: Array<{ kind: string; id: string; decision: string }>;
  requiresConfirmation?: boolean;
  toolsEnabled: boolean;
  model: { providerId: string; modelId: string };
  stopReason: string | null;
  messageCount: number;
};

export type AgentEvent = {
  eventId: string;
  taskId: string | null;
  runId: string | null;
  botId: string;
  sessionId: string | null;
  timestamp: string;
  eventType: string;
  payload: Record<string, string | number | boolean | null>;
  correlationId: string | null;
};

export type AgentEventsResponse = { events: AgentEvent[] };

export type AgentTask = {
  taskId: string;
  botId: string;
  taskType: string;
  goal: string;
  sessionId: string | null;
  parentSessionId?: string | null;
  parentMessageId?: string | null;
  deliveredToParentAt?: string | null;
  deliveryErrorCode?: string | null;
  allowedTools: string[];
  deadlineMs: number;
  status:
    | 'queued'
    | 'accepted'
    | 'running'
    | 'waiting_approval'
    | 'completed'
    | 'failed'
    | 'cancelled'
    | 'timed_out';
  cancelRequested: boolean;
  attempts: number;
  maxAttempts: number;
  recoveredAt: string | null;
  createdAt: string;
  updatedAt: string;
  startedAt: string | null;
  completedAt: string | null;
  errorCode: string | null;
  result: {
    summary: string;
    toolSteps: ToolStep[];
    evidence: Array<{ kind: string; id: string }>;
    changes: Array<{ kind: string; id: string; decision: string }>;
    requiresConfirmation: boolean;
    rounds: number;
    stopReason: string | null;
    model: { providerId: string; modelId: string } | null;
  } | null;
};

export type AgentTasksResponse = { tasks: AgentTask[] };
export type AgentTaskResponse = { task: AgentTask };
