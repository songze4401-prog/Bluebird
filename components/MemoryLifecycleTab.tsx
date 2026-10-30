import React, { useMemo, useState } from 'react';
import {
  ScrollView,
  StyleSheet,
  Text,
  TouchableOpacity,
  View,
} from 'react-native';

import type { Theme } from '../theme';
import type { MemoryItem, MemoryWriteAttempt } from '../lib/api/types';
import {
  collectEntryLifecycleEvents,
  collectLocalLifecycleEvents,
  collectWriteAttemptEvents,
  mergeLifecycleEvents,
  type LifecycleEvent,
  type LifecycleEventType,
  type LocalMemoryAction,
} from '../lib/memory-center';
import { formatMessageTime } from '../lib/utils';
import type { MemoryCenterStyles } from './memory-center-styles';

type LifecycleFilter =
  | 'all'
  | 'create'
  | 'update'
  | 'merge'
  | 'supersede'
  | 'archive'
  | 'other';

const FILTERS: { id: LifecycleFilter; label: string }[] = [
  { id: 'all', label: '全部' },
  { id: 'create', label: '创建' },
  { id: 'update', label: '更新' },
  { id: 'merge', label: '合并' },
  { id: 'supersede', label: '取代' },
  { id: 'archive', label: '归档' },
  { id: 'other', label: '其他' },
];

function matchesFilter(
  event: LifecycleEvent,
  filter: LifecycleFilter
): boolean {
  if (filter === 'all') return true;
  if (filter === 'other') {
    return !['create', 'update', 'merge', 'supersede', 'archive'].includes(
      event.type
    );
  }
  return event.type === filter;
}

function dotStyle(
  type: LifecycleEventType,
  styles: MemoryCenterStyles
) {
  if (type === 'pending') return styles.eventDotPending;
  if (type === 'reject' || type === 'delete' || type === 'recall') {
    return styles.eventDotDanger;
  }
  if (type === 'archive' || type === 'supersede') {
    return styles.eventDotMuted;
  }
  return undefined;
}

export function MemoryLifecycleTab({
  theme,
  styles,
  items,
  attempts,
  attemptsError,
  localActions,
  onOpenMemory,
}: {
  theme: Theme;
  styles: MemoryCenterStyles;
  items: MemoryItem[];
  attempts: MemoryWriteAttempt[];
  attemptsError: string;
  localActions: LocalMemoryAction[];
  onOpenMemory: (item: MemoryItem) => void;
}) {
  const localStyles = useMemo(() => createStyles(theme), [theme]);
  const [filter, setFilter] = useState<LifecycleFilter>('all');
  const [technicalOpen, setTechnicalOpen] = useState(false);

  const byId = useMemo(
    () =>
      new Map(
        items.filter(item => item.id).map(item => [item.id as string, item])
      ),
    [items]
  );

  const entryEvents = useMemo(
    () => collectEntryLifecycleEvents(items),
    [items]
  );

  const events = useMemo(() => {
    // 服务端 lastDecision 已记录的同一次确认/归档不再重复展示；
    // 删除/拒绝后条目已不存在，必须保留本地操作事件。
    const localEvents = collectLocalLifecycleEvents(localActions).filter(
      local =>
        !entryEvents.some(
          entry =>
            entry.memoryId === local.memoryId &&
            entry.type === local.type &&
            Math.abs(Date.parse(entry.at) - Date.parse(local.at)) < 15000
        )
    );

    return mergeLifecycleEvents(entryEvents, localEvents);
  }, [entryEvents, localActions]);
  const writeEvents = useMemo(
    () => collectWriteAttemptEvents(attempts, items),
    [attempts, items]
  );
  const filtered = events.filter(event => matchesFilter(event, filter));

  return (
    <ScrollView
      style={localStyles.fill}
      contentContainerStyle={styles.content}
      showsVerticalScrollIndicator={false}
    >
      <View style={styles.lifecycleNotice}>
        <Text style={styles.lifecycleNoticeText}>
          事件来自条目字段（创建、最近决策、待确认、归档、取代）和本次
          Memory Center 操作。服务端只保留最近 20 次写入尝试，没有完整的
          拒绝/撤回/删除审计流；已删除的记忆及其事件不可回溯。
        </Text>
      </View>

      <View style={styles.noticeCard}>
        <Text style={styles.noticeTitle}>回答调用记忆 · 未接入</Text>
        <Text style={styles.noticeBody}>
          当前聊天响应和可查询的 trace 都不返回被注入记忆的 ID，只能看到
          检索次数与注入数量。为避免把计数伪装成“用了哪几条”，这里不展示
          单次回答的记忆清单。
        </Text>
        <View style={styles.noticeBadge}>
          <Text style={styles.noticeBadgeText}>未接入</Text>
        </View>
      </View>

      <ScrollView
        horizontal
        showsHorizontalScrollIndicator={false}
        style={styles.filterScroll}
        contentContainerStyle={styles.filterContent}
      >
        {FILTERS.map(item => {
          const active = filter === item.id;

          return (
            <TouchableOpacity
              key={item.id}
              style={[styles.chip, active && styles.chipActive]}
              onPress={() => setFilter(item.id)}
              activeOpacity={0.7}
              accessibilityLabel={`生命周期筛选 ${item.label}`}
            >
              <Text
                style={[styles.chipText, active && styles.chipTextActive]}
              >
                {item.label}
              </Text>
            </TouchableOpacity>
          );
        })}
      </ScrollView>

      <View style={styles.sectionHead}>
        <Text style={styles.sectionLabel}>生命周期时间线</Text>
        <Text style={styles.sectionHint}>{filtered.length} 条</Text>
      </View>

      {filtered.length === 0 ? (
        <View style={styles.emptyState}>
          <Text style={styles.emptyTitle}>没有符合筛选的事件</Text>
          <Text style={styles.emptyHint}>
            当前筛选下没有可验证的事件；这不会补造历史记录。
          </Text>
        </View>
      ) : (
        <View style={styles.card}>
          {filtered.map((event, index) => {
            const linked = event.memoryId
              ? byId.get(event.memoryId)
              : undefined;
            const body = (
              <>
                <View style={styles.eventHead}>
                  <Text style={styles.eventTitle}>{event.title}</Text>
                  <Text style={styles.eventTime}>
                    {formatMessageTime(event.at)}
                  </Text>
                </View>
                {!!event.content && (
                  <Text style={styles.eventContent} numberOfLines={2}>
                    {event.content}
                  </Text>
                )}
                {!!event.detail && (
                  <Text style={styles.eventDetail}>{event.detail}</Text>
                )}
                <View style={styles.eventSource}>
                  <Text style={styles.eventSourceText}>
                    {event.source === 'local' ? '本次操作' : '条目字段'}
                  </Text>
                </View>
              </>
            );

            return (
              <View key={event.key} style={styles.eventRow}>
                <View style={styles.eventRail}>
                  <View style={[styles.eventDot, dotStyle(event.type, styles)]} />
                  {index < filtered.length - 1 && (
                    <View style={styles.eventLine} />
                  )}
                </View>
                {linked ? (
                  <TouchableOpacity
                    style={styles.eventBody}
                    activeOpacity={0.7}
                    onPress={() => onOpenMemory(linked)}
                    accessibilityLabel={`查看事件关联记忆 ${event.content || linked.content}`}
                  >
                    {body}
                  </TouchableOpacity>
                ) : (
                  <View style={styles.eventBody}>{body}</View>
                )}
              </View>
            );
          })}
        </View>
      )}

      <TouchableOpacity
        style={[styles.technicalToggle, localStyles.technicalToggle]}
        onPress={() => setTechnicalOpen(open => !open)}
        activeOpacity={0.7}
        accessibilityLabel={
          technicalOpen ? '折叠写入尝试记录' : '展开写入尝试记录'
        }
      >
        <Text style={styles.technicalToggleText}>写入尝试记录</Text>
        <Text style={styles.technicalMeta}>
          {attempts.length} 条 · {technicalOpen ? '收起' : '展开'}
        </Text>
      </TouchableOpacity>

      {technicalOpen && (
        <View style={styles.card}>
          {attemptsError ? (
            <Text style={styles.cardBody}>{attemptsError}</Text>
          ) : writeEvents.length === 0 ? (
            <Text style={styles.cardBody}>暂无写入尝试记录。</Text>
          ) : (
            writeEvents.map(event => (
              <View key={event.key} style={styles.attemptRow}>
                <View style={styles.attemptHead}>
                  <Text style={styles.attemptAction}>{event.title}</Text>
                  <Text style={styles.attemptTime}>
                    {formatMessageTime(event.at)}
                  </Text>
                </View>
                <Text style={styles.attemptReason}>
                  {event.detail || '服务端未提供原因'}
                  {event.sessionId ? ` · 会话 ${event.sessionId.slice(0, 8)}` : ''}
                </Text>
                {!!event.content && (
                  <Text style={styles.attemptReason} numberOfLines={1}>
                    条目：{event.content}
                  </Text>
                )}
              </View>
            ))
          )}
          <Text style={styles.summaryNote}>
            仅当前服务进程最近 20 次写入尝试，不含正文；用于排查“为什么没记住”，
            不能替代完整审计。
          </Text>
        </View>
      )}
    </ScrollView>
  );
}

const createStyles = (theme: Theme) =>
  StyleSheet.create({
    fill: {
      flex: 1,
    },
    technicalToggle: {
      marginTop: 18,
    },
  });
