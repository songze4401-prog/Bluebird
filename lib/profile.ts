import type {
  MemoryItem,
  ProfileFeedbackAction,
  ProfileFeedbackEvent,
  ProfileItem,
} from './api/types';
import { reasonLabel } from './memory-center';

// P5 画像的展示规则：只做真实字段映射，不重新推断事实。
// 画像条目可以回落到 /memory?scope=all 的同一 memoryId；找不到时用画像
// 自带字段构造一个只读 MemoryItem，仍可打开现有的记忆详情/治理界面。

export const PROFILE_SECTION_ORDER = [
  'identity',
  'preferences',
  'goals',
  'relationships',
  'facts',
  'other',
] as const;

export const PROFILE_SECTION_DEFAULT_LABELS: Record<string, string> = {
  identity: '身份',
  preferences: '偏好',
  goals: '目标',
  relationships: '关系',
  facts: '事实',
  other: '其他',
};

export function createFeedbackId(action: ProfileFeedbackAction = 'confirm') {
  const suffix = Math.random().toString(36).slice(2, 10);
  return `ui-${action}-${Date.now().toString(36)}-${suffix}`;
}

export function feedbackActionLabel(action?: string | null): string {
  if (action === 'confirm') return '确认';
  if (action === 'deny') return '否认';
  if (action === 'correct') return '纠正';
  return action ? `反馈：${action}` : '反馈';
}

export function feedbackReasonLabel(reason?: string | null): string {
  if (!reason) return '';
  if (reason === 'user_correction') return '用户纠正内容';
  if (reason === 'user_resolved_contest') return '用户裁决冲突';
  if (reason === 'user_confirmed_supersede') return '用户确认并取代旧版本';
  if (reason === 'user_confirmed_update') return '用户确认并更新原记忆';
  if (reason === 'user_confirmed') return '用户确认';
  if (reason === 'user_denied') return '用户否认';
  if (reason === 'contest_resolved_by_user_confirmation') {
    return '冲突已由用户确认解决';
  }
  if (reason === 'contested_replaced_by_confirmation') {
    return '冲突项被用户确认替代';
  }
  return reasonLabel(reason);
}

export function profileItemStatusLabel(item: ProfileItem): string {
  if (item.status === 'pending') return '待确认';
  if (item.status === 'contested') return '冲突待裁决';
  if (item.status === 'superseded') return '历史版本';
  if (item.status === 'archived') {
    return item.feedback.withdrawnAt ? '已否认' : '已归档';
  }
  if (item.status === 'active' && !item.effective) return '已过期';
  return '活跃';
}

export function profileDigestShort(digest: string, length = 12): string {
  return digest ? digest.slice(0, Math.max(6, length)) : '—';
}

export function profileFeedbackEventLabel(event: ProfileFeedbackEvent): string {
  const action = feedbackActionLabel(event.action);
  const reason = feedbackReasonLabel(event.reason);
  return reason ? `${action} · ${reason}` : action;
}

export function profileItemToMemoryItem(item: ProfileItem): MemoryItem {
  return {
    id: item.memoryId,
    content: item.content,
    type: item.type,
    confidence: item.confidence ?? undefined,
    status: item.status as MemoryItem['status'],
    validFrom: item.validFrom ?? undefined,
    validTo: item.validTo ?? null,
    supersededBy: item.supersededBy ?? null,
    supersedes: item.supersedes ?? null,
    sourceQuote: item.sourceQuote,
    contributions: item.sources.map(source => ({
      sessionId: source.sessionId,
      sourceQuote: source.sourceQuote,
      createdAt: source.createdAt,
      messageId: source.messageId ?? undefined,
      sourceType: source.sourceType ?? undefined,
    })),
    pendingReason: item.pendingReason ?? undefined,
    pendingAt: item.pendingAt ?? null,
    pendingTargetId: item.pendingTargetId ?? null,
    pendingMutation: item.proposedAction ?? null,
    contestedIds: item.contestedIds,
    contestedAt: item.contestedAt ?? null,
    contestedReason: item.contestedReason ?? null,
    contestedBy: item.contestedBy ?? null,
    resolvedContestAt: item.resolvedContestAt ?? null,
    withdrawnAt: item.feedback.withdrawnAt ?? null,
    withdrawnReason: item.feedback.withdrawnReason ?? null,
    archivedReason: item.feedback.archivedReason ?? null,
    provenance: item.provenance ?? undefined,
    category: item.category ?? undefined,
    evidence: item.evidence,
    confirmationCount: item.feedback.confirmationCount,
    lastConfirmedAt: item.feedback.lastConfirmedAt ?? null,
    feedbackHistory: item.feedback.history || [],
    lastDecision: item.feedback.lastDecision ?? undefined,
    observedAt: item.observedAt ?? undefined,
    createdAt: item.validFrom ?? undefined,
    updatedAt: item.updatedAt ?? undefined,
  };
}

export function findMemoryForProfile(
  profileItem: ProfileItem,
  items: MemoryItem[]
): MemoryItem {
  return (
    items.find(item => item.id === profileItem.memoryId) ||
    profileItemToMemoryItem(profileItem)
  );
}

export function profileActiveCount(profile: {
  counts: { active: number };
}): number {
  return profile.counts.active;
}
