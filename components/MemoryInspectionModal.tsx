import React, { useMemo } from 'react';
import {
  ScrollView,
  StyleSheet,
  Text,
  TouchableOpacity,
  View,
} from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';

import type { Theme } from '../theme';
import type { MemoryItem } from '../lib/api/types';
import type {
  ConflictPair,
  DuplicatePair,
} from '../lib/memory-center';
import {
  memoryStatusLabel,
  memoryTypeLabel,
} from '../lib/memory-center';
import type { MemoryCenterStyles } from './memory-center-styles';

function MemoryPick({
  item,
  styles,
  onPress,
}: {
  item: MemoryItem;
  styles: MemoryCenterStyles;
  onPress: () => void;
}) {
  return (
    <TouchableOpacity
      style={styles.relationRow}
      onPress={onPress}
      activeOpacity={0.7}
      accessibilityLabel={`打开检查项记忆 ${item.content}`}
    >
      <View style={styles.badges}>
        <View style={[styles.badge, styles.badgeAccent]}>
          <Text style={[styles.badgeText, styles.badgeAccentText]}>
            {memoryTypeLabel(item.type)}
          </Text>
        </View>
        <View style={styles.badge}>
          <Text style={styles.badgeText}>{memoryStatusLabel(item)}</Text>
        </View>
      </View>
      <Text style={styles.relationText}>{item.content}</Text>
    </TouchableOpacity>
  );
}

export function MemoryInspectionModal({
  visible,
  theme,
  styles,
  duplicates,
  conflicts,
  onClose,
  onOpenMemory,
}: {
  visible: boolean;
  theme: Theme;
  styles: MemoryCenterStyles;
  duplicates: DuplicatePair[];
  conflicts: ConflictPair[];
  onClose: () => void;
  onOpenMemory: (item: MemoryItem) => void;
}) {
  const localStyles = useMemo(() => createStyles(theme), [theme]);

  if (!visible) return null;

  return (
    <View style={styles.overlayRoot}>
      <SafeAreaView style={localStyles.root} edges={['top', 'bottom']}>
        <View style={styles.header}>
          <TouchableOpacity
            style={styles.headerButton}
            onPress={onClose}
            accessibilityLabel="返回记忆中心"
            activeOpacity={0.6}
          >
            <Text style={styles.headerGlyph}>‹</Text>
          </TouchableOpacity>

          <View style={styles.headerCenter}>
            <Text style={styles.headerTitle}>记忆检查</Text>
            <Text style={styles.headerSubtitle}>重复与冲突 · 本地推导</Text>
          </View>

          <View style={{ width: 38 }} />
        </View>

        <ScrollView
          style={localStyles.scroll}
          contentContainerStyle={styles.overlayContent}
          showsVerticalScrollIndicator={false}
        >
          <View style={styles.noticeCard}>
            <Text style={styles.noticeTitle}>只提示，不自动改动记忆</Text>
            <Text style={styles.noticeBody}>
              重复检测沿用引擎的字符二元组相似度阈值 0.8；冲突检测是前端启发式
              （同类型、共享关键词、正负表述不同）。两项结果都需要人工判断；
              当前服务端没有面向单条记忆的编辑或合并接口。
            </Text>
            <View style={styles.noticeBadge}>
              <Text style={styles.noticeBadgeText}>本地检测</Text>
            </View>
          </View>

          <View style={styles.sectionHead}>
            <Text style={styles.sectionLabel}>疑似重复</Text>
            <Text style={styles.sectionHint}>{duplicates.length} 组</Text>
          </View>

          {duplicates.length === 0 ? (
            <View style={styles.card}>
              <Text style={styles.cardBody}>未发现高相似活跃记忆。</Text>
            </View>
          ) : (
            duplicates.slice(0, 12).map(pair => (
              <View
                key={`${pair.a.id || pair.a.content}:${pair.b.id || pair.b.content}`}
                style={styles.card}
              >
                <Text style={styles.cardTitle}>
                  相似度 {Math.round(pair.similarity * 100)}%
                </Text>
                <MemoryPick
                  item={pair.a}
                  styles={styles}
                  onPress={() => onOpenMemory(pair.a)}
                />
                <MemoryPick
                  item={pair.b}
                  styles={styles}
                  onPress={() => onOpenMemory(pair.b)}
                />
              </View>
            ))
          )}

          <View style={styles.sectionHead}>
            <Text style={styles.sectionLabel}>潜在冲突</Text>
            <Text style={styles.sectionHint}>{conflicts.length} 组</Text>
          </View>

          {conflicts.length === 0 ? (
            <View style={styles.card}>
              <Text style={styles.cardBody}>
                未发现“同类型、共享关键词但正负表述不同”的活跃记忆。
              </Text>
            </View>
          ) : (
            conflicts.slice(0, 12).map(pair => (
              <View
                key={`${pair.a.id || pair.a.content}:${pair.b.id || pair.b.content}`}
                style={styles.card}
              >
                <Text style={styles.cardTitle}>{pair.reason}</Text>
                <Text style={styles.summaryNote}>
                  共享关键词：{pair.sharedKeywords.join('、')} · 相似度{' '}
                  {Math.round(pair.similarity * 100)}%
                </Text>
                <MemoryPick
                  item={pair.a}
                  styles={styles}
                  onPress={() => onOpenMemory(pair.a)}
                />
                <MemoryPick
                  item={pair.b}
                  styles={styles}
                  onPress={() => onOpenMemory(pair.b)}
                />
              </View>
            ))
          )}
        </ScrollView>
      </SafeAreaView>
    </View>
  );
}

const createStyles = (theme: Theme) =>
  StyleSheet.create({
    root: {
      flex: 1,
      backgroundColor: theme.background,
    },
    scroll: {
      flex: 1,
    },
  });
