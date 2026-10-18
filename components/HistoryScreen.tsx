import React, { useLayoutEffect, useMemo, useState } from 'react';
import {
  Alert,
  View,
  Text,
  TouchableOpacity,
  FlatList,
  StyleSheet,
  Modal,
  ActivityIndicator,
} from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';

import type { Theme } from '../theme';
import type { SessionMeta } from '../lib/types';
import { API_TOKEN } from '../lib/constants';
import { formatMessageTime, readJsonResponse } from '../lib/utils';

// 历史聊天（自治）：状态、加载、选择逻辑全部内聚在此。
// 父级只保留打开开关（visible）与回调；打开即加载。
// 列表顺序直接采用服务端返回（listSessions 已按 updatedAt 倒序），不在前端二次排序。
export function HistoryScreen({
  visible,
  onClose,
  theme,
  currentSessionId,
  onSelectSession,
  onDeleteSession,
}: {
  visible: boolean;
  onClose: () => void;
  theme: Theme;
  currentSessionId: string;
  onSelectSession: (sessionId: string) => void;
  // 删除会话：由父级请求后端，成功返回 true（列表据此重拉）
  onDeleteSession: (sessionId: string) => Promise<boolean>;
}) {
  const styles = useMemo(() => createStyles(theme), [theme]);

  const [sessions, setSessions] = useState<SessionMeta[]>([]);
  const [loadingSessions, setLoadingSessions] = useState(false);
  const [sessionsError, setSessionsError] = useState('');

  const fetchSessions = async () => {
    setLoadingSessions(true);
    setSessionsError('');

    try {
      const response = await fetch(
        `${process.env.EXPO_PUBLIC_API_URL}/sessions`,
        {
          headers: {
            Authorization: `Bearer ${API_TOKEN}`,
          },
        }
      );

      const data = await readJsonResponse(response);

      if (!response.ok || !Array.isArray(data.sessions)) {
        throw new Error(data.error || '读取失败');
      }

      setSessions(data.sessions as SessionMeta[]);
    } catch (error) {
      console.error('Load sessions error:', error);
      setSessionsError('读取会话列表失败，请稍后再试。');
    } finally {
      setLoadingSessions(false);
    }
  };

  // 删除确认：二次确认防误触；成功后重拉列表，保证与服务端一致
  const confirmDelete = (sessionId: string) => {
    Alert.alert(
      '删除会话',
      '会话与其聊天记录将被删除，无法恢复。确定删除？',
      [
        { text: '取消', style: 'cancel' },
        {
          text: '删除',
          style: 'destructive',
          onPress: async () => {
            const ok = await onDeleteSession(sessionId);

            if (ok) fetchSessions();
          },
        },
      ]
    );
  };

  // 打开即加载：与 MemoryScreen 同一时序约定，不闪旧数据
  useLayoutEffect(() => {
    if (!visible) return;

    fetchSessions();
  }, [visible]);

  return (
    <Modal visible={visible} animationType="slide" onRequestClose={onClose}>
      <SafeAreaView style={styles.historyContainer}>
        <View style={styles.historyHeader}>
          <TouchableOpacity style={styles.historyBack} onPress={onClose}>
            <Text style={[styles.historyBackText, { color: theme.accent }]}>
              ‹ 返回
            </Text>
          </TouchableOpacity>

          <Text style={styles.historyTitle}>历史聊天</Text>

          <TouchableOpacity
            style={styles.historyRefresh}
            onPress={fetchSessions}
            disabled={loadingSessions}
            activeOpacity={0.6}
            accessibilityLabel="刷新会话列表"
          >
            <Text
              style={[styles.historyRefreshText, { color: theme.accent }]}
            >
              {loadingSessions ? '···' : '↻'}
            </Text>
          </TouchableOpacity>
        </View>

        <Text style={styles.historyCaption}>
          共 {sessions.length} 个会话 · 每个会话的聊天记录相互独立
        </Text>

        {loadingSessions ? (
          <View style={styles.historyCenter}>
            <ActivityIndicator color={theme.accent} />
            <Text style={styles.historyHint}>正在读取…</Text>
          </View>
        ) : sessionsError ? (
          <View style={styles.historyCenter}>
            <Text style={styles.historyErrorText}>{sessionsError}</Text>

            <TouchableOpacity
              style={styles.historyRetry}
              onPress={fetchSessions}
            >
              <Text
                style={[styles.historyRetryText, { color: theme.accent }]}
              >
                重试
              </Text>
            </TouchableOpacity>
          </View>
        ) : sessions.length === 0 ? (
          <View style={styles.historyCenter}>
            <Text style={styles.historyEmptyTitle}>还没有任何会话</Text>

            <Text style={styles.historyHint}>
              回到主页点「新建聊天」即可开始一个独立会话。
            </Text>
          </View>
        ) : (
          <FlatList
            data={sessions}
            keyExtractor={item => item.id}
            contentContainerStyle={styles.historyList}
            renderItem={({ item }) => {
              const isCurrent = item.id === currentSessionId;

              return (
                <TouchableOpacity
                  style={styles.historyCard}
                  activeOpacity={0.75}
                  onPress={() => onSelectSession(item.id)}
                  accessibilityLabel={`打开会话 ${item.title}`}
                >
                  <View style={styles.historyCardTop}>
                    <Text style={styles.historyCardTitle} numberOfLines={1}>
                      {item.title || '未命名会话'}
                    </Text>

                    {isCurrent && (
                      <View
                        style={[
                          styles.historyBadge,
                          { borderColor: theme.accentBorder },
                        ]}
                      >
                        <Text
                          style={[
                            styles.historyBadgeText,
                            { color: theme.accent },
                          ]}
                        >
                          当前
                        </Text>
                      </View>
                    )}

                    <TouchableOpacity
                      style={styles.historyDelete}
                      onPress={() => confirmDelete(item.id)}
                      activeOpacity={0.7}
                      accessibilityLabel={`删除会话 ${item.title || '未命名会话'}`}
                    >
                      <Text
                        style={[
                          styles.historyDeleteText,
                          { color: theme.danger },
                        ]}
                      >
                        删除
                      </Text>
                    </TouchableOpacity>
                  </View>

                  <View style={styles.historyCardBottom}>
                    <Text style={styles.historyMetaText}>
                      {item.messageCount > 0
                        ? `${item.messageCount} 条消息`
                        : '暂无消息'}
                    </Text>

                    <Text style={styles.historyMetaTime}>
                      {formatMessageTime(item.updatedAt)}
                    </Text>
                  </View>
                </TouchableOpacity>
              );
            }}
          />
        )}
      </SafeAreaView>
    </Modal>
  );
}

// 样式由主题派生：只包含本组件用到的键
const createStyles = (theme: Theme) =>
  StyleSheet.create({
    historyContainer: {
      flex: 1,
      backgroundColor: theme.background,
    },
    historyHeader: {
      height: 72,
      paddingHorizontal: 20,
      flexDirection: 'row',
      alignItems: 'center',
      justifyContent: 'space-between',
      borderBottomWidth: 1,
      borderBottomColor: theme.border,
    },
    historyBack: {
      minWidth: 64,
      paddingVertical: 6,
    },
    historyBackText: {
      color: theme.accent,
      fontSize: 16,
    },
    historyTitle: {
      color: theme.textPrimary,
      fontSize: 20,
      fontWeight: '700',
    },
    historyRefresh: {
      minWidth: 64,
      paddingVertical: 6,
      alignItems: 'flex-end',
    },
    historyRefreshText: {
      fontSize: 19,
      lineHeight: 23,
      fontWeight: '700',
    },
    historyCaption: {
      color: theme.textSecondary,
      fontSize: 13,
      lineHeight: 19,
      paddingHorizontal: 20,
      paddingTop: 14,
      paddingBottom: 6,
    },
    historyCenter: {
      flex: 1,
      alignItems: 'center',
      justifyContent: 'center',
      paddingHorizontal: 32,
    },
    historyEmptyTitle: {
      color: theme.textPrimary,
      fontSize: 17,
      fontWeight: '600',
      marginBottom: 8,
    },
    historyHint: {
      color: theme.textSecondary,
      fontSize: 14,
      lineHeight: 21,
      textAlign: 'center',
      marginTop: 8,
    },
    historyErrorText: {
      color: theme.danger,
      fontSize: 14,
      lineHeight: 21,
      textAlign: 'center',
      marginBottom: 14,
    },
    historyRetry: {
      borderWidth: 1,
      borderColor: theme.borderStrong,
      borderRadius: 10,
      paddingHorizontal: 18,
      paddingVertical: 9,
    },
    historyRetryText: {
      color: theme.accent,
      fontSize: 14,
    },
    historyList: {
      paddingHorizontal: 16,
      paddingTop: 8,
      paddingBottom: 24,
    },
    historyCard: {
      backgroundColor: theme.surface,
      borderWidth: 1,
      borderColor: theme.borderStrong,
      borderRadius: 12,
      padding: 14,
      marginBottom: 10,
    },
    historyCardTop: {
      flexDirection: 'row',
      alignItems: 'center',
      justifyContent: 'space-between',
    },
    historyCardTitle: {
      flex: 1,
      color: theme.textBody,
      fontSize: 16,
      fontWeight: '600',
      marginRight: 10,
    },
    historyBadge: {
      backgroundColor: theme.avatarBg,
      borderWidth: 1,
      borderColor: theme.accentBorder,
      borderRadius: 8,
      paddingHorizontal: 8,
      paddingVertical: 3,
    },
    historyBadgeText: {
      color: theme.accent,
      fontSize: 12,
    },
    historyDelete: {
      paddingHorizontal: 6,
      paddingVertical: 4,
    },
    historyDeleteText: {
      fontSize: 12,
      fontWeight: '600',
    },
    historyCardBottom: {
      flexDirection: 'row',
      alignItems: 'center',
      justifyContent: 'space-between',
      marginTop: 10,
    },
    historyMetaText: {
      color: theme.textMuted,
      fontSize: 12,
      fontVariant: ['tabular-nums'],
    },
    historyMetaTime: {
      color: theme.textMuted,
      fontSize: 12,
      fontVariant: ['tabular-nums'],
    },
  });