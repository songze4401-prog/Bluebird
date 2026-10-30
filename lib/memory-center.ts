import type {
  MemoryItem,
  MemoryWriteAttempt,
} from './api/types';

// Memory Center 的纯展示规则：状态判定、概览、趋势、重复/冲突检测、生命周期事件。
// 这些函数不读写网络，也不改动服务端记忆；所有输入都来自真实 /memory 数据。

export type MemoryStatus = 'active' | 'pending' | 'superseded' | 'archived';

export const MEMORY_TYPE_LABELS: Record<string, string> = {
  identity: '身份',
  preference: '偏好',
  fact: '事实',
  goal: '目标',
  relationship: '关系',
};

export const MEMORY_TYPE_ORDER = [
  'identity',
  'relationship',
  'goal',
  'preference',
  'fact',
];

export const MEMORY_STATUS_LABELS: Record<MemoryStatus, string> = {
  active: '活跃',
  pending: '待确认',
  superseded: '历史版本',
  archived: '已归档',
};

export function memoryTypeLabel(type?: string): string {
  return (type && MEMORY_TYPE_LABELS[type]) || '未分类';
}

export function memoryStatus(item: MemoryItem): MemoryStatus {
  const status = item.status;

  return status === 'pending' ||
    status === 'superseded' ||
    status === 'archived'
    ? status
    : 'active';
}

export function memoryStatusLabel(item: MemoryItem): string {
  return MEMORY_STATUS_LABELS[memoryStatus(item)];
}

export function memoryDisplayStatusLabel(
  item: MemoryItem,
  now = Date.now()
): string {
  if (memoryStatus(item) === 'active' && !isEffectiveMemory(item, now)) {
    return '已过期';
  }

  return memoryStatusLabel(item);
}

// 与服务端 memory-lifecycle.isEffectiveAt 保持同一口径：
// active（未写 status 视为 active）且在 [validFrom, validTo) 窗口内。
export function isEffectiveMemory(
  item: MemoryItem,
  now = Date.now()
): boolean {
  if (memoryStatus(item) !== 'active') return false;

  const from = Date.parse(item.validFrom || '');
  if (Number.isFinite(from) && from > now) return false;

  const to = Date.parse(item.validTo || '');
  if (Number.isFinite(to) && to <= now) return false;

  return true;
}

export function memoryTimestamp(item: MemoryItem): number {
  for (const value of [item.updatedAt, item.createdAt, item.validFrom]) {
    const time = Date.parse(value || '');

    if (Number.isFinite(time)) return time;
  }

  return 0;
}

export function sortMemories(items: MemoryItem[]): MemoryItem[] {
  return items.slice().sort((a, b) => memoryTimestamp(b) - memoryTimestamp(a));
}

export type MemoryOverview = {
  total: number;
  active: number;
  pending: number;
  archived: number;
  history: number;
  expired: number;
};

export function buildMemoryOverview(
  items: MemoryItem[],
  now = Date.now()
): MemoryOverview {
  let active = 0;
  let pending = 0;
  let archived = 0;
  let history = 0;
  let expired = 0;

  for (const item of items) {
    const status = memoryStatus(item);

    if (status === 'pending') pending += 1;
    else if (status === 'archived') archived += 1;
    else if (status === 'superseded') history += 1;
    else if (isEffectiveMemory(item, now)) active += 1;
    else expired += 1;
  }

  return {
    total: items.length,
    active,
    pending,
    archived,
    history,
    expired,
  };
}

export type MemoryGrowthPoint = {
  key: string;
  label: string;
  count: number;
};

// 近 N 天新增：按本地日期切桶，使用真实 createdAt。
// superseded 是被更新版本替换的历史版本，不算一次新的记忆增长。
export function buildGrowthSeries(
  items: MemoryItem[],
  now = Date.now(),
  days = 7
): MemoryGrowthPoint[] {
  const safeDays = Math.max(1, Math.min(14, Math.floor(days)));
  const base = new Date(now);
  const startOfToday = new Date(
    base.getFullYear(),
    base.getMonth(),
    base.getDate()
  ).getTime();

  const points: MemoryGrowthPoint[] = [];

  for (let offset = safeDays - 1; offset >= 0; offset -= 1) {
    const start = startOfToday - offset * 86400000;
    const end = start + 86400000;
    const date = new Date(start);
    const key = `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(
      2,
      '0'
    )}-${String(date.getDate()).padStart(2, '0')}`;

    let count = 0;

    for (const item of items) {
      if (memoryStatus(item) === 'superseded') continue;

      const created = Date.parse(item.createdAt || '');
      if (!Number.isFinite(created) || created < start || created >= end) {
        continue;
      }

      count += 1;
    }

    points.push({
      key,
      label: `${date.getMonth() + 1}/${date.getDate()}`,
      count,
    });
  }

  return points;
}

// 与旧记忆库一致的摘要：仅展示，不改写任何记忆。
export function buildMemorySummary(items: MemoryItem[], max = 6): string {
  const active = items.filter(item => isEffectiveMemory(item));

  if (!active.length) return '';

  const rank = (type?: string) => {
    const index = MEMORY_TYPE_ORDER.indexOf(type || '');
    return index < 0 ? MEMORY_TYPE_ORDER.length : index;
  };

  const merged = active
    .slice()
    .sort((a, b) => rank(a.type) - rank(b.type))
    .slice(0, max)
    .map(item => item.content.trim().replace(/[。，,.\s]+$/, ''))
    .filter(Boolean)
    .join('，');

  return merged ? `${merged}。` : '';
}

function normalizeText(text: string): string {
  return String(text || '')
    .toLowerCase()
    .replace(/\s+/g, '')
    .replace(/[\p{P}\p{S}]/gu, '');
}

function bigrams(text: string): Set<string> {
  const normalized = normalizeText(text);
  const result = new Set<string>();

  if (normalized.length < 2) {
    if (normalized) result.add(normalized);
    return result;
  }

  for (let i = 0; i < normalized.length - 1; i += 1) {
    result.add(normalized.slice(i, i + 2));
  }

  return result;
}

// 与服务端去重同形的字符二元组 Jaccard；仅用于前端提示，不参与写入。
export function memorySimilarity(a: string, b: string): number {
  const left = bigrams(a);
  const right = bigrams(b);

  if (!left.size || !right.size) return 0;

  let intersection = 0;
  left.forEach(token => {
    if (right.has(token)) intersection += 1;
  });

  return intersection / (left.size + right.size - intersection);
}

export type DuplicatePair = {
  a: MemoryItem;
  b: MemoryItem;
  similarity: number;
};

export function detectDuplicates(items: MemoryItem[]): DuplicatePair[] {
  const active = items
    .filter(item => isEffectiveMemory(item))
    .slice()
    .sort((a, b) => memoryTimestamp(b) - memoryTimestamp(a));
  const pairs: DuplicatePair[] = [];

  for (let i = 0; i < active.length; i += 1) {
    for (let j = i + 1; j < active.length; j += 1) {
      const similarity = memorySimilarity(
        active[i].content,
        active[j].content
      );

      if (similarity >= 0.8) {
        pairs.push({ a: active[i], b: active[j], similarity });
      }
    }
  }

  return pairs.sort((a, b) => b.similarity - a.similarity);
}

const NEGATIVE_PATTERN = /(不|没|无|别|讨厌|拒绝|停止|不想|不要|不再)/;

function hasNegativePolarity(text: string): boolean {
  return NEGATIVE_PATTERN.test(text);
}

function normalizedKeywords(item: MemoryItem): string[] {
  return (Array.isArray(item.keywords) ? item.keywords : [])
    .map(keyword => normalizeText(keyword))
    .filter(keyword => keyword.length >= 2);
}

export type ConflictPair = {
  a: MemoryItem;
  b: MemoryItem;
  similarity: number;
  sharedKeywords: string[];
  reason: string;
};

// 前端启发式冲突检测：同类型、共享关键词、正负表述不同、正文又不是重复。
// 只做提示，不代表服务端裁决，也不会自动改动记忆。
export function detectConflicts(items: MemoryItem[]): ConflictPair[] {
  const active = items
    .filter(item => isEffectiveMemory(item))
    .slice()
    .sort((a, b) => memoryTimestamp(b) - memoryTimestamp(a));
  const pairs: ConflictPair[] = [];

  for (let i = 0; i < active.length; i += 1) {
    for (let j = i + 1; j < active.length; j += 1) {
      const a = active[i];
      const b = active[j];

      if ((a.type || '') !== (b.type || '')) continue;

      const left = new Set(normalizedKeywords(a));
      const shared = normalizedKeywords(b).filter(keyword =>
        left.has(keyword)
      );

      if (!shared.length) continue;

      const similarity = memorySimilarity(a.content, b.content);

      if (similarity >= 0.8 || similarity < 0.15) continue;
      if (hasNegativePolarity(a.content) === hasNegativePolarity(b.content)) {
        continue;
      }

      pairs.push({
        a,
        b,
        similarity,
        sharedKeywords: [...new Set(shared)],
        reason: '同类型、共享关键词，但正负表述不一致',
      });
    }
  }

  return pairs.sort((a, b) => b.similarity - a.similarity);
}

export type LifecycleEventType =
  | 'create'
  | 'update'
  | 'merge'
  | 'supersede'
  | 'confirm'
  | 'archive'
  | 'pending'
  | 'reject'
  | 'recall'
  | 'delete'
  | 'write_failed';

export type LifecycleEventSource = 'entry' | 'write' | 'local';

export type LifecycleEvent = {
  key: string;
  at: string;
  type: LifecycleEventType;
  title: string;
  detail?: string;
  memoryId?: string;
  content?: string;
  sessionId?: string | null;
  targetId?: string | null;
  source: LifecycleEventSource;
  technical?: boolean;
};

const LIFECYCLE_TITLES: Record<LifecycleEventType, string> = {
  create: '创建',
  update: '更新',
  merge: '合并',
  supersede: '取代',
  confirm: '确认',
  archive: '归档',
  pending: '待确认',
  reject: '拒绝',
  recall: '撤回',
  delete: '删除',
  write_failed: '写入失败',
};

export function lifecycleTitle(type: LifecycleEventType): string {
  return LIFECYCLE_TITLES[type];
}

const REASON_LABELS: Record<string, string> = {
  user_confirmed: '用户确认',
  user_confirmed_update: '用户确认并更新原记忆',
  user_archived: '用户归档',
  supersedes_existing: '新事实取代旧事实',
  explicit_target_update: '指定目标更新',
  needs_confirmation: '需要用户确认',
  low_confidence: '置信度不足',
  temporary_state: '临时状态不入库',
  no_content: '没有可写入内容',
  sensitive_content: '命中敏感内容',
  sensitive_output: '输出命中敏感内容',
  quote_not_grounded: '无法追溯到用户原话',
  ungrounded_content: '正文与原话不够接近',
  quote_too_short: '原话太短',
  type_not_allowed: '记忆类型不在白名单',
  content_too_long: '内容超过长度上限',
  duplicate_merge: '重复内容合并',
  similar_content: '相近内容合并',
  write_failed: '落盘失败',
  conflict: '与原记忆冲突',
};

export function reasonLabel(reason?: string | null): string {
  if (!reason) return '';
  return REASON_LABELS[reason] || `服务端原因码：${reason}`;
}

const DECISION_ACTION_LABELS: Record<string, string> = {
  create: '创建',
  update: '更新',
  merge: '合并',
  supersede: '取代',
  needs_confirmation: '待确认',
  confirm: '确认',
  archive: '归档',
  reject: '拒绝',
};

export function decisionActionLabel(action?: string | null): string {
  if (!action) return '';
  return DECISION_ACTION_LABELS[action] || `服务端动作码：${action}`;
}

const SOURCE_TYPE_LABELS: Record<string, string> = {
  user: '用户',
  agent: 'Agent',
  tool: '工具',
  model: '模型',
  import: '导入',
};

export function sourceTypeLabel(sourceType?: string | null): string {
  if (!sourceType) return '';
  return SOURCE_TYPE_LABELS[sourceType] || `来源码：${sourceType}`;
}

function decisionType(action?: string): LifecycleEventType | null {
  switch (action) {
    case 'create':
      return 'create';
    case 'update':
      return 'update';
    case 'merge':
      return 'merge';
    case 'supersede':
      return 'supersede';
    case 'needs_confirmation':
      return 'pending';
    case 'confirm':
      return 'confirm';
    case 'archive':
      return 'archive';
    case 'reject':
      return 'reject';
    default:
      return null;
  }
}

function validTime(value?: string | null): string | null {
  if (!value) return null;

  return Number.isFinite(Date.parse(value)) ? value : null;
}

export function collectEntryLifecycleEvents(
  items: MemoryItem[]
): LifecycleEvent[] {
  const events: LifecycleEvent[] = [];
  const seen = new Set<string>();

  const push = (event: LifecycleEvent) => {
    if (!validTime(event.at) || seen.has(event.key)) return;
    seen.add(event.key);
    events.push(event);
  };

  for (const item of items) {
    if (!item.id) continue;

    const created = validTime(item.createdAt || item.validFrom);
    const memoryId = item.id;
    const content = item.content;

    if (created) {
      push({
        key: `entry:${memoryId}:create`,
        at: created,
        type: 'create',
        title: LIFECYCLE_TITLES.create,
        detail: '记忆引擎写入',
        memoryId,
        content,
        source: 'entry',
      });
    }

    const decision = item.lastDecision;
    const decisionAt = validTime(decision?.at);
    const decisionEventType = decisionType(decision?.action);

    if (decisionEventType && decisionAt) {
      const sameAsCreate =
        decisionEventType === 'create' &&
        created &&
        Math.abs(Date.parse(created) - Date.parse(decisionAt)) < 2000;

      if (!sameAsCreate) {
        const reason = reasonLabel(decision?.reason);
        const detail =
          decisionEventType === 'supersede' && item.supersededBy
            ? `${reason || '被新版本取代'} · 目标 ${item.supersededBy}`
            : reason;

        push({
          key: `entry:${memoryId}:decision:${decisionAt}:${decisionEventType}`,
          at: decisionAt,
          type: decisionEventType,
          title: LIFECYCLE_TITLES[decisionEventType],
          detail,
          memoryId,
          content,
          targetId:
            decisionEventType === 'supersede' ? item.supersededBy : null,
          source: 'entry',
        });
      }
    }

    // 最近决策已经表达了同一个状态迁移时，不再补一条重复事件。
    if (memoryStatus(item) === 'pending' && decisionEventType !== 'pending') {
      const at = validTime(item.pendingAt || item.updatedAt) || created;

      if (at) {
        push({
          key: `entry:${memoryId}:pending`,
          at,
          type: 'pending',
          title: LIFECYCLE_TITLES.pending,
          detail: reasonLabel(item.pendingReason),
          memoryId,
          content,
          source: 'entry',
        });
      }
    }

    if (
      memoryStatus(item) === 'superseded' &&
      item.supersededBy &&
      decisionEventType !== 'supersede'
    ) {
      const at = validTime(item.updatedAt || item.validTo) || created;

      if (at) {
        push({
          key: `entry:${memoryId}:superseded`,
          at,
          type: 'supersede',
          title: LIFECYCLE_TITLES.supersede,
          detail: `被新版本取代 · 目标 ${item.supersededBy}`,
          memoryId,
          content,
          targetId: item.supersededBy,
          source: 'entry',
        });
      }
    }

    if (memoryStatus(item) === 'archived' && decisionEventType !== 'archive') {
      const at =
        validTime(item.updatedAt || item.validTo || item.validFrom) || created;

      if (at) {
        push({
          key: `entry:${memoryId}:archived`,
          at,
          type: 'archive',
          title: LIFECYCLE_TITLES.archive,
          detail: reasonLabel(decision?.reason),
          memoryId,
          content,
          source: 'entry',
        });
      }
    }
  }

  return events.sort((a, b) => Date.parse(b.at) - Date.parse(a.at));
}

function attemptType(attempt: MemoryWriteAttempt): LifecycleEventType {
  if (attempt.errorCode || attempt.reason === 'write_failed') {
    return 'write_failed';
  }

  switch (attempt.action) {
    case 'inserted':
      return 'create';
    case 'merged':
      return 'merge';
    case 'updated':
      return 'update';
    case 'superseded':
      return 'supersede';
    case 'pending':
      return 'pending';
    default:
      return 'reject';
  }
}

export function collectWriteAttemptEvents(
  attempts: MemoryWriteAttempt[],
  items: MemoryItem[]
): LifecycleEvent[] {
  const byId = new Map(
    items.filter(item => item.id).map(item => [item.id as string, item])
  );

  return attempts
    .filter(attempt => Number.isFinite(Date.parse(attempt.at)))
    .map((attempt, index) => {
      const type = attemptType(attempt);
      const memoryId = attempt.id || undefined;
      const linked = memoryId ? byId.get(memoryId) : undefined;

      return {
        key: `write:${attempt.at}:${memoryId || index}`,
        at: attempt.at,
        type,
        title: LIFECYCLE_TITLES[type],
        detail: attempt.written
          ? reasonLabel(attempt.reason) || '记忆引擎写入尝试'
          : reasonLabel(attempt.reason) || '未写入',
        memoryId,
        content: linked?.content,
        sessionId: attempt.sessionId,
        targetId: attempt.supersededId || attempt.targetId || null,
        source: 'write' as const,
        technical: true,
      };
    })
    .sort((a, b) => Date.parse(b.at) - Date.parse(a.at));
}

export type LocalMemoryAction = {
  at: string;
  type: 'confirm' | 'reject' | 'archive' | 'delete';
  memoryId?: string;
  content?: string;
  targetId?: string | null;
};

export function collectLocalLifecycleEvents(
  actions: LocalMemoryAction[]
): LifecycleEvent[] {
  return actions
    .filter(action => Number.isFinite(Date.parse(action.at)))
    .map(action => ({
      key: `local:${action.at}:${action.type}:${action.memoryId || ''}`,
      at: action.at,
      type: action.type,
      title: LIFECYCLE_TITLES[action.type],
      detail: '本次 Memory Center 操作',
      memoryId: action.memoryId,
      content: action.content,
      targetId: action.targetId || null,
      source: 'local' as const,
    }))
    .sort((a, b) => Date.parse(b.at) - Date.parse(a.at));
}

export function mergeLifecycleEvents(
  ...groups: LifecycleEvent[][]
): LifecycleEvent[] {
  const seen = new Set<string>();
  const merged: LifecycleEvent[] = [];

  for (const group of groups) {
    for (const event of group) {
      if (seen.has(event.key)) continue;
      seen.add(event.key);
      merged.push(event);
    }
  }

  return merged.sort((a, b) => Date.parse(b.at) - Date.parse(a.at));
}

export function memoryConfidencePercent(item: MemoryItem): string {
  const value = Number(item.confidence);

  if (!Number.isFinite(value)) return '—';

  return `${Math.round(Math.min(1, Math.max(0, value)) * 100)}%`;
}

export type MemoryRelation = {
  item: MemoryItem;
  label: string;
};

export function sourceQuotes(item: MemoryItem): string[] {
  const fromContributions = (item.contributions || [])
    .map(contribution => contribution.sourceQuote)
    .filter(Boolean);

  if (fromContributions.length) return [...new Set(fromContributions)];
  return item.sourceQuote ? [item.sourceQuote] : [];
}
