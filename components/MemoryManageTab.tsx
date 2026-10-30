import React, { useMemo } from 'react';
import {
  FlatList,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  TouchableOpacity,
  View,
} from 'react-native';

import type { Theme } from '../theme';
import type { MemoryItem } from '../lib/api/types';
import {
  MEMORY_TYPE_LABELS,
  MEMORY_TYPE_ORDER,
  isEffectiveMemory,
  memoryConfidencePercent,
  memoryDisplayStatusLabel,
  memoryStatus,
  memoryTimestamp,
  memoryTypeLabel,
  sourceQuotes,
  type MemoryStatus,
} from '../lib/memory-center';
import { formatMessageTime } from '../lib/utils';
import type { MemoryCenterStyles } from './memory-center-styles';

export type ManageStatusFilter = MemoryStatus | 'all';

function rowKey(item: MemoryItem): string {
  return item.id || `${item.createdAt || ''}::${item.content}`;
}

function statusMatches(item: MemoryItem, filter: ManageStatusFilter): boolean {
  if (filter === 'all') return true;
  if (filter === 'active') return isEffectiveMemory(item);
  return memoryStatus(item) === filter;
}

function matchesQuery(item: MemoryItem, query: string): boolean {
  const needle = query.trim().toLowerCase();

  if (!needle) return true;

  return [
    item.content,
    item.id || '',
    memoryTypeLabel(item.type),
    ...(item.keywords || []),
    ...sourceQuotes(item),
  ]
    .join(' ')
    .toLowerCase()
    .includes(needle);
}

function MemoryRow({
  item,
  styles,
  onPress,
}: {
  item: MemoryItem;
  styles: MemoryCenterStyles;
  onPress: () => void;
}) {
  const status = memoryStatus(item);
  const expired = status === 'active' && !isEffectiveMemory(item);
  const statusStyle =
    status === 'pending'
      ? styles.badgeWarning
      : status === 'active' && !expired
        ? styles.badgeAccent
        : styles.badgeMuted;
  const statusTextStyle =
    status === 'pending'
      ? styles.badgeWarningText
      : status === 'active' && !expired
        ? styles.badgeAccentText
        : undefined;

  return (
    <TouchableOpacity
      style={styles.memoryRow}
      onPress={onPress}
      activeOpacity={0.72}
      accessibilityLabel={`打开记忆 ${item.content}`}
    >
      <View style={styles.memoryRowTop}>
        <Text style={styles.memoryRowContent} numberOfLines={3}>
          {item.content}
        </Text>
        <Text style={styles.memoryRowChevron}>›</Text>
      </View>

      <View style={styles.badges}>
        <View style={[styles.badge, styles.badgeAccent]}>
          <Text style={[styles.badgeText, styles.badgeAccentText]}>
            {memoryTypeLabel(item.type)}
          </Text>
        </View>
        <View style={[styles.badge, statusStyle]}>
          <Text style={[styles.badgeText, statusTextStyle]}>
            {memoryDisplayStatusLabel(item)}
          </Text>
        </View>
        {status === 'active' && !expired && (
          <View style={styles.badge}>
            <Text style={styles.badgeText}>
              置信度 {memoryConfidencePercent(item)}
            </Text>
          </View>
        )}
      </View>

      <View style={styles.memoryRowMeta}>
        <Text style={styles.memoryRowTime}>
          {formatMessageTime(item.updatedAt || item.createdAt || '')}
        </Text>
        <Text style={styles.memoryRowTime}>
          来源 {sourceQuotes(item).length} 条
        </Text>
      </View>
    </TouchableOpacity>
  );
}

export function MemoryManageTab({
  theme,
  styles,
  items,
  query,
  onChangeQuery,
  statusFilter,
  onChangeStatusFilter,
  typeFilter,
  onChangeTypeFilter,
  duplicateCount,
  conflictCount,
  onOpenInspection,
  onOpenMemory,
  onClearAll,
  clearing,
}: {
  theme: Theme;
  styles: MemoryCenterStyles;
  items: MemoryItem[];
  query: string;
  onChangeQuery: (value: string) => void;
  statusFilter: ManageStatusFilter;
  onChangeStatusFilter: (value: ManageStatusFilter) => void;
  typeFilter: string;
  onChangeTypeFilter: (value: string) => void;
  duplicateCount: number;
  conflictCount: number;
  onOpenInspection: () => void;
  onOpenMemory: (item: MemoryItem) => void;
  onClearAll: () => void;
  clearing?: boolean;
}) {
  const localStyles = useMemo(() => createStyles(theme), [theme]);

  const filtered = useMemo(() => {
    return items
      .filter(
        item =>
          statusMatches(item, statusFilter) &&
          (typeFilter === 'all' || (item.type || '') === typeFilter) &&
          matchesQuery(item, query)
      )
      .sort((a, b) => memoryTimestamp(b) - memoryTimestamp(a));
  }, [items, query, statusFilter, typeFilter]);

  const statusFilters: { id: ManageStatusFilter; label: string }[] = [
    { id: 'all', label: '全部' },
    { id: 'active', label: '活跃' },
    { id: 'pending', label: '待确认' },
    { id: 'archived', label: '已归档' },
    { id: 'superseded', label: '历史版本' },
  ];

  const header = (
    <View>
      <View style={styles.searchBar}>
        <Text style={styles.searchGlyph}>⌕</Text>
        <TextInput
          value={query}
          onChangeText={onChangeQuery}
          placeholder="搜索内容、类型、关键词或原话"
          placeholderTextColor={theme.textMuted}
          selectionColor={theme.accent}
          style={styles.searchInput}
          returnKeyType="search"
          accessibilityLabel="搜索记忆"
        />
        {!!query && (
          <TouchableOpacity
            onPress={() => onChangeQuery('')}
            hitSlop={8}
            accessibilityLabel="清除搜索"
          >
            <Text style={styles.searchClear}>✕</Text>
          </TouchableOpacity>
        )}
      </View>

      <ScrollView
        horizontal
        showsHorizontalScrollIndicator={false}
        style={styles.filterScroll}
        contentContainerStyle={styles.filterContent}
      >
        {statusFilters.map(filter => {
          const active = statusFilter === filter.id;

          return (
            <TouchableOpacity
              key={filter.id}
              style={[styles.chip, active && styles.chipActive]}
              onPress={() => onChangeStatusFilter(filter.id)}
              activeOpacity={0.7}
              accessibilityLabel={`状态筛选 ${filter.label}`}
            >
              <Text
                style={[styles.chipText, active && styles.chipTextActive]}
              >
                {filter.label}
              </Text>
            </TouchableOpacity>
          );
        })}
      </ScrollView>

      <ScrollView
        horizontal
        showsHorizontalScrollIndicator={false}
        style={localStyles.typeScroll}
        contentContainerStyle={styles.filterContent}
      >
        <TouchableOpacity
          style={[styles.chip, typeFilter === 'all' && styles.chipActive]}
          onPress={() => onChangeTypeFilter('all')}
          activeOpacity={0.7}
          accessibilityLabel="类型筛选 全部类型"
        >
          <Text
            style={[
              styles.chipText,
              typeFilter === 'all' && styles.chipTextActive,
            ]}
          >
            全部类型
          </Text>
        </TouchableOpacity>
        {MEMORY_TYPE_ORDER.map(type => {
          const active = typeFilter === type;

          return (
            <TouchableOpacity
              key={type}
              style={[styles.chip, active && styles.chipActive]}
              onPress={() => onChangeTypeFilter(type)}
              activeOpacity={0.7}
              accessibilityLabel={`类型筛选 ${MEMORY_TYPE_LABELS[type]}`}
            >
              <Text
                style={[styles.chipText, active && styles.chipTextActive]}
              >
                {MEMORY_TYPE_LABELS[type]}
              </Text>
            </TouchableOpacity>
          );
        })}
      </ScrollView>

      <TouchableOpacity
        style={[styles.healthCard, localStyles.inspectionCard]}
        onPress={onOpenInspection}
        activeOpacity={0.75}
        accessibilityLabel="打开记忆重复与冲突检查"
      >
        <View style={styles.healthBlock}>
          <Text style={styles.healthValue}>{duplicateCount}</Text>
          <Text style={styles.healthLabel}>疑似重复</Text>
        </View>
        <View style={styles.healthDivider} />
        <View style={styles.healthBlock}>
          <Text
            style={[styles.healthValue, conflictCount > 0 && styles.healthValueWarn]}
          >
            {conflictCount}
          </Text>
          <Text style={styles.healthLabel}>潜在冲突</Text>
        </View>
        <Text style={styles.healthAction}>
          查看检查 ›
        </Text>
      </TouchableOpacity>

      <View style={styles.sectionHead}>
        <Text style={styles.sectionLabel}>记忆列表</Text>
        <Text style={styles.sectionHint}>{filtered.length} 条</Text>
      </View>
    </View>
  );

  return (
    <FlatList
      style={localStyles.list}
      data={filtered}
      keyExtractor={rowKey}
      renderItem={({ item }) => (
        <MemoryRow
          item={item}
          styles={styles}
          onPress={() => onOpenMemory(item)}
        />
      )}
      ListHeaderComponent={header}
      contentContainerStyle={styles.content}
      keyboardShouldPersistTaps="handled"
      showsVerticalScrollIndicator={false}
      ListEmptyComponent={
        <View style={styles.emptyState}>
          <Text style={styles.emptyTitle}>没有匹配的记忆</Text>
          <Text style={styles.emptyHint}>
            调整搜索词或筛选条件后再试。
          </Text>
          <TouchableOpacity
            style={styles.retryButton}
            onPress={() => {
              onChangeQuery('');
              onChangeStatusFilter('all');
              onChangeTypeFilter('all');
            }}
            activeOpacity={0.7}
          >
            <Text style={styles.retryText}>清除筛选</Text>
          </TouchableOpacity>
        </View>
      }
      ListFooterComponent={
        items.length > 0 ? (
          <TouchableOpacity
            style={[localStyles.clearAll, clearing && styles.miniButtonDisabled]}
            onPress={onClearAll}
            disabled={clearing}
            activeOpacity={0.7}
            accessibilityLabel="清空全部记忆"
          >
            <Text style={localStyles.clearAllText}>
              {clearing ? '清空中…' : '清空全部记忆'}
            </Text>
          </TouchableOpacity>
        ) : undefined
      }
    />
  );
}

const createStyles = (theme: Theme) =>
  StyleSheet.create({
    list: {
      flex: 1,
    },
    typeScroll: {
      marginTop: 8,
    },
    inspectionCard: {
      marginTop: 14,
    },
    clearAll: {
      marginTop: 10,
      marginBottom: 18,
      height: 44,
      borderRadius: 15,
      alignItems: 'center',
      justifyContent: 'center',
      borderWidth: StyleSheet.hairlineWidth,
      borderColor: theme.dangerBorder,
      backgroundColor: theme.surface,
    },
    clearAllText: {
      color: theme.danger,
      fontSize: 12,
      lineHeight: 16,
      fontWeight: '500',
    },
  });
