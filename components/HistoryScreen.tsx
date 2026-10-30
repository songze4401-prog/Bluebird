import React, { useMemo, useState } from 'react';
import {
  ActivityIndicator,
  Alert,
  FlatList,
  Modal,
  StyleSheet,
  Text,
  TextInput,
  TouchableOpacity,
  View,
} from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';

import type { Theme } from '../theme';
import type { SessionMeta } from '../lib/types';
import { formatMessageTime } from '../lib/utils';

// 空白会话统一显示「新对话」，与顶栏、抽屉保持一致；
// 服务端的「新会话」只是占位标题，不对用户暴露。
function sessionDisplayTitle(item: SessionMeta): string {
  if (item.messageCount === 0) return '新对话';

  return item.title || '未命名会话';
}

// 历史聊天：分组列表 + 本地搜索 + 删除/长按管理。
// 数据仍由 App 的 useSessionList 注入，组件不直接请求 /sessions。
export function HistoryScreen({
  visible,
  onClose,
  theme,
  currentSessionId,
  sessions,
  loadingSessions,
  sessionsError,
  onRefresh,
  onSelectSession,
  onDeleteSession,
  onNewChat,
}: {
  visible: boolean;
  onClose: () => void;
  theme: Theme;
  currentSessionId: string;
  sessions: SessionMeta[];
  loadingSessions: boolean;
  sessionsError: string;
  onRefresh: () => void;
  onSelectSession: (sessionId: string) => void;
  onDeleteSession: (sessionId: string) => Promise<boolean>;
  onNewChat?: () => void;
}) {
  const styles = useMemo(() => createStyles(theme), [theme]);
  const [query, setQuery] = useState('');

  const filtered = useMemo(() => {
    const needle = query.trim().toLowerCase();
    if (!needle) return sessions;
    return sessions.filter(item =>
      `${item.title || ''} ${item.id}`.toLowerCase().includes(needle)
    );
  }, [query, sessions]);

  const groups = useMemo(() => {
    const today: SessionMeta[] = [];
    const yesterday: SessionMeta[] = [];
    const earlier: SessionMeta[] = [];
    const now = new Date();
    const startOfToday = new Date(
      now.getFullYear(),
      now.getMonth(),
      now.getDate()
    ).getTime();
    const startOfYesterday = startOfToday - 24 * 60 * 60 * 1000;

    for (const item of filtered) {
      const time = Date.parse(item.updatedAt || '');
      if (Number.isFinite(time) && time >= startOfToday) today.push(item);
      else if (Number.isFinite(time) && time >= startOfYesterday)
        yesterday.push(item);
      else earlier.push(item);
    }

    return [
      { label: '今天', data: today },
      { label: '昨天', data: yesterday },
      { label: '更早', data: earlier },
    ].filter(group => group.data.length);
  }, [filtered]);

  const confirmDelete = (sessionId: string, title: string) => {
    Alert.alert(
      '删除会话',
      `「${title || '未命名会话'}」及其聊天记录将被删除，无法恢复。`,
      [
        { text: '取消', style: 'cancel' },
        {
          text: '删除',
          style: 'destructive',
          onPress: () => void onDeleteSession(sessionId),
        },
      ]
    );
  };

  const openRowMenu = (item: SessionMeta) => {
    const title = sessionDisplayTitle(item);

    Alert.alert(title, '选择操作', [
      { text: '取消', style: 'cancel' },
      {
        text: '重命名（暂未开放）',
        onPress: () =>
          Alert.alert('暂未开放', '重命名需要服务端接口，当前版本暂未接入。'),
      },
      {
        text: '删除',
        style: 'destructive',
        onPress: () => confirmDelete(item.id, title),
      },
    ]);
  };

  return (
    <Modal visible={visible} animationType="slide" onRequestClose={onClose}>
      <SafeAreaView style={styles.root}>
        <View style={styles.header}>
          <TouchableOpacity
            style={styles.headerButton}
            onPress={onClose}
            hitSlop={8}
            accessibilityLabel="返回"
          >
            <Text style={styles.backText}>‹</Text>
          </TouchableOpacity>
          <Text style={styles.headerTitle}>历史对话</Text>
          <TouchableOpacity
            style={[styles.headerButton, styles.headerRight]}
            onPress={onRefresh}
            disabled={loadingSessions}
            hitSlop={8}
            accessibilityLabel="刷新会话列表"
          >
            <Text style={styles.refreshText}>
              {loadingSessions ? '···' : '↻'}
            </Text>
          </TouchableOpacity>
        </View>

        <View style={styles.titleBlock}>
          <Text style={styles.title}>对话</Text>
          <Text style={styles.caption}>
            {sessions.length
              ? `共 ${sessions.length} 个会话 · 每个会话相互独立`
              : '所有正在发生和已经完成的事。'}
          </Text>
        </View>

        <View style={styles.search}>
          <Text style={styles.searchGlyph}>⌕</Text>
          <TextInput
            value={query}
            onChangeText={setQuery}
            placeholder="搜索对话"
            placeholderTextColor={theme.textMuted}
            style={styles.searchInput}
            returnKeyType="search"
            accessibilityLabel="搜索对话"
          />
        </View>

        {loadingSessions ? (
          <View style={styles.center}>
            <ActivityIndicator color={theme.accent} />
            <Text style={styles.hint}>正在读取…</Text>
          </View>
        ) : sessionsError ? (
          <View style={styles.center}>
            <Text style={styles.error}>{sessionsError}</Text>
            <TouchableOpacity style={styles.retry} onPress={onRefresh}>
              <Text style={styles.retryText}>重试</Text>
            </TouchableOpacity>
          </View>
        ) : groups.length === 0 ? (
          <View style={styles.center}>
            <Text style={styles.emptyTitle}>
              {query.trim() ? '没有匹配的对话' : '还没有任何会话'}
            </Text>
            <Text style={styles.hint}>
              {query.trim()
                ? '换一个关键词试试。'
                : '开始一个新的对话，Blue 会在本机记住有用的上下文。'}
            </Text>
            {!query.trim() && onNewChat && (
              <TouchableOpacity style={styles.retry} onPress={onNewChat}>
                <Text style={styles.retryText}>新建对话</Text>
              </TouchableOpacity>
            )}
          </View>
        ) : (
          <FlatList
            data={groups}
            keyExtractor={item => item.label}
            contentContainerStyle={styles.list}
            showsVerticalScrollIndicator={false}
            renderItem={({ item: group }) => (
              <View>
                <Text style={styles.groupLabel}>{group.label}</Text>
                {group.data.map(item => {
                  const current = item.id === currentSessionId;
                  const title = sessionDisplayTitle(item);
                  return (
                    <TouchableOpacity
                      key={item.id}
                      style={styles.row}
                      activeOpacity={0.7}
                      onPress={() => onSelectSession(item.id)}
                      onLongPress={() => openRowMenu(item)}
                      delayLongPress={350}
                      accessibilityLabel={`打开会话 ${title}`}
                    >
                      <View style={styles.rowMain}>
                        <View style={styles.rowTitleLine}>
                          {current && <View style={styles.currentDot} />}
                          <Text style={styles.rowTitle} numberOfLines={1}>
                            {title}
                          </Text>
                        </View>
                        <Text style={styles.rowMeta} numberOfLines={1}>
                          {item.messageCount > 0
                            ? `${item.messageCount} 条消息`
                            : '暂无消息'}
                          {'  ·  '}
                          {formatMessageTime(item.updatedAt)}
                        </Text>
                      </View>
                      <TouchableOpacity
                        onPress={() => openRowMenu(item)}
                        hitSlop={8}
                        style={styles.more}
                        accessibilityLabel="会话操作"
                      >
                        <Text style={styles.moreText}>⋯</Text>
                      </TouchableOpacity>
                    </TouchableOpacity>
                  );
                })}
              </View>
            )}
            ListFooterComponent={
              <Text style={styles.footerHint}>长按对话可管理</Text>
            }
          />
        )}
      </SafeAreaView>
    </Modal>
  );
}

const createStyles = (theme: Theme) =>
  StyleSheet.create({
    root: {
      flex: 1,
      backgroundColor: theme.background,
    },
    header: {
      height: 52,
      paddingHorizontal: 16,
      flexDirection: 'row',
      alignItems: 'center',
      justifyContent: 'space-between',
    },
    headerButton: {
      width: 40,
      height: 40,
      alignItems: 'flex-start',
      justifyContent: 'center',
    },
    headerRight: {
      alignItems: 'flex-end',
    },
    backText: {
      color: theme.textSecondary,
      fontSize: 27,
      lineHeight: 31,
    },
    headerTitle: {
      color: theme.textPrimary,
      fontSize: 14,
      fontWeight: '600',
    },
    refreshText: {
      color: theme.textSecondary,
      fontSize: 18,
    },
    titleBlock: {
      paddingHorizontal: 20,
      paddingTop: 12,
    },
    title: {
      color: theme.textPrimary,
      fontSize: 30,
      lineHeight: 38,
      fontWeight: '600',
      letterSpacing: -0.5,
    },
    caption: {
      marginTop: 6,
      color: theme.textMuted,
      fontSize: 11,
      lineHeight: 17,
    },
    search: {
      marginHorizontal: 20,
      marginTop: 18,
      height: 40,
      borderRadius: 21,
      backgroundColor: theme.surface,
      borderWidth: StyleSheet.hairlineWidth,
      borderColor: theme.borderStrong,
      flexDirection: 'row',
      alignItems: 'center',
      paddingHorizontal: 12,
      gap: 8,
    },
    searchGlyph: {
      color: theme.textMuted,
      fontSize: 17,
    },
    searchInput: {
      flex: 1,
      color: theme.textBody,
      fontSize: 12,
      paddingVertical: 0,
    },
    list: {
      paddingHorizontal: 20,
      paddingBottom: 34,
    },
    groupLabel: {
      marginTop: 22,
      marginBottom: 2,
      color: theme.textMuted,
      fontSize: 10,
      lineHeight: 14,
      letterSpacing: 0.6,
    },
    row: {
      minHeight: 58,
      flexDirection: 'row',
      alignItems: 'center',
      borderBottomWidth: StyleSheet.hairlineWidth,
      borderBottomColor: theme.border,
      paddingVertical: 8,
    },
    rowMain: {
      flex: 1,
      minWidth: 0,
    },
    rowTitleLine: {
      flexDirection: 'row',
      alignItems: 'center',
      gap: 7,
    },
    currentDot: {
      width: 5,
      height: 5,
      borderRadius: 3,
      backgroundColor: theme.accent,
    },
    rowTitle: {
      flex: 1,
      color: theme.textBody,
      fontSize: 13,
      lineHeight: 18,
      fontWeight: '500',
    },
    rowMeta: {
      marginTop: 4,
      color: theme.textMuted,
      fontSize: 10,
      lineHeight: 15,
    },
    more: {
      width: 30,
      height: 36,
      alignItems: 'center',
      justifyContent: 'center',
    },
    moreText: {
      color: theme.textMuted,
      fontSize: 18,
      lineHeight: 22,
    },
    center: {
      flex: 1,
      alignItems: 'center',
      justifyContent: 'center',
      paddingHorizontal: 32,
    },
    emptyTitle: {
      color: theme.textPrimary,
      fontSize: 17,
      lineHeight: 24,
      fontWeight: '600',
    },
    hint: {
      marginTop: 8,
      color: theme.textSecondary,
      fontSize: 13,
      lineHeight: 20,
      textAlign: 'center',
    },
    error: {
      color: theme.danger,
      fontSize: 13,
      lineHeight: 20,
      textAlign: 'center',
    },
    retry: {
      marginTop: 14,
      paddingHorizontal: 18,
      paddingVertical: 9,
      borderRadius: 10,
      borderWidth: StyleSheet.hairlineWidth,
      borderColor: theme.borderStrong,
    },
    retryText: {
      color: theme.accent,
      fontSize: 13,
    },
    footerHint: {
      marginTop: 22,
      color: theme.textMuted,
      fontSize: 9,
      lineHeight: 14,
      textAlign: 'center',
    },
  });
