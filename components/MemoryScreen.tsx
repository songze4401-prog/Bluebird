import React, { useLayoutEffect, useMemo, useState } from 'react';
import {
  View,
  Text,
  TouchableOpacity,
  FlatList,
  StyleSheet,
  Modal,
  Alert,
  ActivityIndicator,
} from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';

import type { Theme } from '../theme';
import { API_TOKEN } from '../lib/constants';
import { readJsonResponse } from '../lib/utils';

// 长期记忆条目（与服务端 memory.json 的结构一致，无 id 字段）
type MemoryItem = {
  content: string;
  type?: string;
  keywords?: string[];
  confidence?: number;
  sourceQuote?: string;
  createdAt?: string;
  updatedAt?: string;
};

// 记忆库单条定位键：与后端删除接口的 createdAt + content 保持一致
function memoryKey(item: MemoryItem): string {
  return `${item.createdAt || ''}::${item.content}`;
}

function formatMemoryTime(iso?: string): string {
  if (!iso) return '';

  const date = new Date(iso);

  if (Number.isNaN(date.getTime())) return '';

  const pad = (value: number) => String(value).padStart(2, '0');

  return (
    `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}` +
    ` ${pad(date.getHours())}:${pad(date.getMinutes())}`
  );
}

// 记忆类型 -> 中文徽章（仅展示，不参与任何逻辑）
const MEMORY_TYPE_LABELS: Record<string, string> = {
  identity: '身份',
  preference: '偏好',
  fact: '事实',
  goal: '目标',
  relationship: '关系',
};

// 记忆摘要：只做展示，由已有记忆就地归并生成（不调接口、不改写任何记忆数据）。
// 优先展示"核心"类别，最多取前几条，避免摘要变成第二个完整列表。
const SUMMARY_TYPE_ORDER = ['identity', 'relationship', 'goal', 'preference', 'fact'];
const MEMORY_SUMMARY_MAX = 6;

function buildMemorySummary(items: MemoryItem[]): string {
  if (!items.length) return '';

  const rank = (type?: string) => {
    const index = SUMMARY_TYPE_ORDER.indexOf(type || '');
    return index < 0 ? SUMMARY_TYPE_ORDER.length : index;
  };

  // 注意：先 slice() 拷贝再排序，绝不改动传入的 memories 原始顺序
  const merged = items
    .slice()
    .sort((a, b) => rank(a.type) - rank(b.type))
    .slice(0, MEMORY_SUMMARY_MAX)
    .map(item => item.content.trim().replace(/[。，,.\s]+$/, ''))
    .filter(Boolean)
    .join('，');

  return merged ? `${merged}。` : '';
}

// 记忆库（自治）：状态、加载、删除、清空逻辑全部内聚在此。
// 父级只保留打开开关（visible）与关闭回调（onClose）；打开即加载。
export function MemoryScreen({
  visible,
  onClose,
  theme,
}: {
  visible: boolean;
  onClose: () => void;
  theme: Theme;
}) {
  const styles = useMemo(() => createStyles(theme), [theme]);

  const [memories, setMemories] = useState<MemoryItem[]>([]);
  const [loadingMemories, setLoadingMemories] = useState(false);
  const [memoryError, setMemoryError] = useState('');
  const [deletingMemoryKey, setDeletingMemoryKey] = useState<string | null>(
    null
  );

  const fetchMemories = async () => {
    setLoadingMemories(true);
    setMemoryError('');

    try {
      const response = await fetch(
        `${process.env.EXPO_PUBLIC_API_URL}/memory`,
        {
          headers: {
            Authorization: `Bearer ${API_TOKEN}`,
          },
        }
      );

      const data = await readJsonResponse(response);

      if (!response.ok) {
        throw new Error(data.error || '读取失败');
      }

      setMemories(Array.isArray(data.memories) ? data.memories : []);
    } catch (error) {
      console.error('Load memories error:', error);
      setMemoryError('读取长期记忆失败，请稍后再试。');
    } finally {
      setLoadingMemories(false);
    }
  };

  // 打开即加载：useLayoutEffect 保证"先是 loading、再拉取"在同一帧内生效，
  // 与原实现（打开时立即调用 fetchMemories）的时序一致，不会闪一帧旧数据。
  useLayoutEffect(() => {
    if (!visible) return;

    fetchMemories();
  }, [visible]);

  const deleteOneMemory = (item: MemoryItem) => {
    Alert.alert('删除这条记忆？', item.content, [
      { text: '取消', style: 'cancel' },
      {
        text: '删除',
        style: 'destructive',
        onPress: async () => {
          const key = memoryKey(item);

          setDeletingMemoryKey(key);

          try {
            const response = await fetch(
              `${process.env.EXPO_PUBLIC_API_URL}/memory/delete`,
              {
                method: 'POST',
                headers: {
                  'Content-Type': 'application/json',
                  Authorization: `Bearer ${API_TOKEN}`,
                },
                body: JSON.stringify({
                  createdAt: item.createdAt,
                  content: item.content,
                }),
              }
            );

            const data = await readJsonResponse(response);

            if (!response.ok) {
              throw new Error(data.error || '删除失败');
            }

            // 后端确认删除成功后才更新 UI，不做乐观更新
            setMemories(prev =>
              prev.filter(entry => memoryKey(entry) !== key)
            );
          } catch (error) {
            console.error('Delete memory error:', error);
            Alert.alert('失败', '删除这条记忆失败，请稍后再试。');
          } finally {
            setDeletingMemoryKey(null);
          }
        },
      },
    ]);
  };

  const clearAllMemories = () => {
    Alert.alert(
      '清空全部记忆',
      '确定要清空所有长期记忆吗？\n这不会删除聊天记录。',
      [
        { text: '取消', style: 'cancel' },
        {
          text: '清空',
          style: 'destructive',
          onPress: async () => {
            try {
              const response = await fetch(
                `${process.env.EXPO_PUBLIC_API_URL}/memory/clear`,
                {
                  method: 'POST',
                  headers: {
                    Authorization: `Bearer ${API_TOKEN}`,
                  },
                }
              );

              const data = await readJsonResponse(response);

              if (!response.ok) {
                throw new Error(data.error || '清空失败');
              }

              setMemories([]);
              Alert.alert('完成', '长期记忆已经清空。');
            } catch (error) {
              console.error('Clear memories error:', error);
              Alert.alert('失败', '清空长期记忆失败，请稍后再试。');
            }
          },
        },
      ]
    );
  };

  return (
    <Modal
      visible={visible}
      animationType="slide"
      onRequestClose={onClose}
    >
      <SafeAreaView style={styles.memoryContainer}>
        <View style={styles.memoryHeader}>
          <TouchableOpacity
            style={styles.memoryBack}
            onPress={onClose}
          >
            <Text style={[styles.memoryBackText, { color: theme.accent }]}>
              ‹ 返回
            </Text>
          </TouchableOpacity>

          <Text style={styles.memoryTitle}>记忆库</Text>

          <TouchableOpacity
            style={styles.memoryRefresh}
            onPress={fetchMemories}
            disabled={loadingMemories}
            activeOpacity={0.6}
            accessibilityLabel="刷新记忆库"
          >
            <Text
              style={[styles.memoryRefreshText, { color: theme.accent }]}
            >
              {loadingMemories ? '···' : '↻'}
            </Text>
          </TouchableOpacity>
        </View>

        <Text style={styles.memoryCaption}>
          共 {memories.length} 条 · 这里是 Bluebird 长期保存的信息，与聊天记录相互独立
        </Text>

        {!loadingMemories && !memoryError && memories.length > 0 && (
          <View style={styles.summaryCard}>
            <Text style={styles.summaryTitle}>记忆摘要</Text>

            <Text style={styles.summaryText}>
              {buildMemorySummary(memories)}
            </Text>

            <Text style={styles.summaryNote}>
              由已有 {memories.length} 条记忆归并生成，仅作概览，原始记忆见下方
            </Text>
          </View>
        )}

        {loadingMemories ? (
          <View style={styles.memoryCenter}>
            <ActivityIndicator color={theme.accent} />
            <Text style={styles.memoryHint}>正在读取…</Text>
          </View>
        ) : memoryError ? (
          <View style={styles.memoryCenter}>
            <Text style={styles.memoryErrorText}>{memoryError}</Text>

            <TouchableOpacity
              style={styles.memoryRetry}
              onPress={fetchMemories}
            >
              <Text style={[styles.memoryRetryText, { color: theme.accent }]}>
                重试
              </Text>
            </TouchableOpacity>
          </View>
        ) : memories.length === 0 ? (
          <View style={styles.memoryCenter}>
            <Text style={styles.memoryEmptyTitle}>目前还没有长期记忆</Text>

            <Text style={styles.memoryHint}>
              Bluebird 会在聊天过程中自动记住一些重要的信息。
            </Text>
          </View>
        ) : (
          <FlatList
            data={memories}
            keyExtractor={item => memoryKey(item)}
            contentContainerStyle={styles.memoryList}
            renderItem={({ item }) => {
              const key = memoryKey(item);
              const typeLabel = item.type
                ? MEMORY_TYPE_LABELS[item.type]
                : '';
              const deleting = deletingMemoryKey === key;

              return (
                <View style={styles.memoryCard}>
                  <View style={styles.memoryCardTop}>
                    <Text style={styles.memoryContent}>{item.content}</Text>

                    {!!typeLabel && (
                      <View
                        style={[
                          styles.memoryBadge,
                          { borderColor: theme.accentBorder },
                        ]}
                      >
                        <Text
                          style={[
                            styles.memoryBadgeText,
                            { color: theme.accent },
                          ]}
                        >
                          {typeLabel}
                        </Text>
                      </View>
                    )}
                  </View>

                  {!!item.sourceQuote && (
                    <Text style={styles.memorySource}>
                      “{item.sourceQuote}”
                    </Text>
                  )}

                  <View style={styles.memoryCardBottom}>
                    <Text style={styles.memoryTime}>
                      {formatMemoryTime(item.createdAt)}
                    </Text>

                    <TouchableOpacity
                      style={styles.memoryDelete}
                      onPress={() => deleteOneMemory(item)}
                      disabled={deleting}
                    >
                      <Text style={styles.memoryDeleteText}>
                        {deleting ? '删除中…' : '删除'}
                      </Text>
                    </TouchableOpacity>
                  </View>
                </View>
              );
            }}
          />
        )}

        {!loadingMemories && !memoryError && memories.length > 0 && (
          <TouchableOpacity
            style={styles.memoryClearAll}
            onPress={clearAllMemories}
          >
            <Text style={styles.memoryClearAllText}>清空全部记忆</Text>
          </TouchableOpacity>
        )}
      </SafeAreaView>
    </Modal>
  );
}

// 样式由主题派生：只包含本组件用到的键
const createStyles = (theme: Theme) =>
  StyleSheet.create({
    memoryContainer: {
      flex: 1,
      backgroundColor: theme.background,
    },
    memoryHeader: {
      height: 72,
      paddingHorizontal: 20,
      flexDirection: 'row',
      alignItems: 'center',
      justifyContent: 'space-between',
      borderBottomWidth: 1,
      borderBottomColor: theme.border,
    },
    memoryBack: {
      minWidth: 64,
      paddingVertical: 6,
    },
    memoryBackText: {
      color: theme.accent,
      fontSize: 16,
    },
    memoryTitle: {
      color: theme.textPrimary,
      fontSize: 20,
      fontWeight: '700',
    },
    // 记忆库右上角刷新按钮：复用同一套强调色，适配浅色/深色
    memoryRefresh: {
      minWidth: 64,
      paddingVertical: 6,
      alignItems: 'flex-end',
    },
    memoryRefreshText: {
      fontSize: 19,
      lineHeight: 23,
      fontWeight: '700',
    },
    memoryCaption: {
      color: theme.textSecondary,
      fontSize: 13,
      lineHeight: 19,
      paddingHorizontal: 20,
      paddingTop: 14,
      paddingBottom: 6,
    },
    // ---- 记忆摘要（仅展示，不替代原始记忆；随 memories 更新自动刷新） ----
    summaryCard: {
      marginHorizontal: 16,
      marginTop: 10,
      padding: 14,
      borderRadius: 12,
      borderWidth: 1,
      backgroundColor: theme.surface,
      borderColor: theme.borderStrong,
    },
    summaryTitle: {
      color: theme.accent,
      fontSize: 13,
      fontWeight: '700',
      marginBottom: 8,
    },
    summaryText: {
      color: theme.textBody,
      fontSize: 15,
      lineHeight: 22,
    },
    summaryNote: {
      color: theme.textMuted,
      fontSize: 11,
      lineHeight: 16,
      marginTop: 9,
    },
    memoryCenter: {
      flex: 1,
      alignItems: 'center',
      justifyContent: 'center',
      paddingHorizontal: 32,
    },
    memoryEmptyTitle: {
      color: theme.textPrimary,
      fontSize: 17,
      fontWeight: '600',
      marginBottom: 8,
    },
    memoryHint: {
      color: theme.textSecondary,
      fontSize: 14,
      lineHeight: 21,
      textAlign: 'center',
      marginTop: 8,
    },
    memoryErrorText: {
      color: theme.danger,
      fontSize: 14,
      lineHeight: 21,
      textAlign: 'center',
      marginBottom: 14,
    },
    memoryRetry: {
      borderWidth: 1,
      borderColor: theme.borderStrong,
      borderRadius: 10,
      paddingHorizontal: 18,
      paddingVertical: 9,
    },
    memoryRetryText: {
      color: theme.accent,
      fontSize: 14,
    },
    memoryList: {
      paddingHorizontal: 16,
      paddingTop: 8,
      paddingBottom: 24,
    },
    memoryCard: {
      backgroundColor: theme.surface,
      borderWidth: 1,
      borderColor: theme.borderStrong,
      borderRadius: 12,
      padding: 14,
      marginBottom: 10,
    },
    memoryCardTop: {
      flexDirection: 'row',
      alignItems: 'flex-start',
      justifyContent: 'space-between',
    },
    memoryContent: {
      flex: 1,
      color: theme.textBody,
      fontSize: 16,
      lineHeight: 23,
      marginRight: 10,
    },
    memoryBadge: {
      backgroundColor: theme.avatarBg,
      borderWidth: 1,
      borderColor: theme.accentBorder,
      borderRadius: 8,
      paddingHorizontal: 8,
      paddingVertical: 3,
    },
    memoryBadgeText: {
      color: theme.accent,
      fontSize: 12,
    },
    memorySource: {
      color: theme.textSecondary,
      fontSize: 13,
      lineHeight: 19,
      marginTop: 8,
    },
    memoryCardBottom: {
      flexDirection: 'row',
      alignItems: 'center',
      justifyContent: 'space-between',
      marginTop: 12,
    },
    memoryTime: {
      color: theme.textMuted,
      fontSize: 12,
      fontVariant: ['tabular-nums'],
    },
    memoryDelete: {
      paddingHorizontal: 12,
      paddingVertical: 6,
    },
    memoryDeleteText: {
      color: theme.danger,
      fontSize: 14,
    },
    memoryClearAll: {
      marginHorizontal: 16,
      marginBottom: 16,
      paddingVertical: 14,
      borderRadius: 12,
      borderWidth: 1,
      borderColor: theme.dangerBorder,
      alignItems: 'center',
    },
    memoryClearAllText: {
      color: theme.danger,
      fontSize: 15,
    },
  });