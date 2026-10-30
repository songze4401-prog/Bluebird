import React, { useMemo } from 'react';
import { Text, TouchableOpacity, View, StyleSheet } from 'react-native';

import type { Theme } from '../theme';
import { CHAT_LAYOUT } from '../lib/design';

// 顶部栏（设计图 .topbar）：☰ + Bluebird | ＋ ⌕ ，无描边、无头像、无在线状态。
// 与重构前的差别：心情 Emoji 移到每条助手的 who-line（设计图如此），
// 「● 在线」与共享时钟移进设置抽屉，原来的 160px 绝对定位下拉换成抽屉。
//
// 三个入口的语义（设计图未标注，按下述约定实现，已在交付说明里标为假设）：
//   ☰ → 设置抽屉（用户明确要求：三个杠打开是设置 + 历史对话）
//   ＋ → 新建对话
//   ⌕ → 历史对话
export function ChatHeader({
  theme,
  onOpenDrawer,
  onNewChat,
  onOpenHistory,
  sessionTitle,
  creatingChat,
}: {
  theme: Theme;
  onOpenDrawer: () => void;
  onNewChat: () => void;
  onOpenHistory: () => void;
  sessionTitle?: string;
  // 新建会话请求进行中：禁用入口防连点，避免创建出多余的空会话
  creatingChat?: boolean;
}) {
  const styles = useMemo(() => createStyles(theme), [theme]);

  return (
    <View style={styles.bar}>
      <View style={styles.left}>
        <TouchableOpacity
          style={styles.iconButton}
          onPress={onOpenDrawer}
          activeOpacity={0.6}
          hitSlop={8}
          accessibilityLabel="打开设置"
        >
          {/* ☰ 用三条 View 画：字形 ☰ 在不同字体下粗细不一，画出来才稳定 */}
          <View style={styles.burger}>
            <View style={styles.burgerLine} />
            <View style={styles.burgerLine} />
            <View style={styles.burgerLine} />
          </View>
        </TouchableOpacity>
      </View>

      <Text style={styles.sessionTitle} numberOfLines={1}>
        {sessionTitle || 'Bluebird'}
      </Text>

      <View style={styles.right}>
        <TouchableOpacity
          style={styles.iconButton}
          onPress={onNewChat}
          disabled={creatingChat}
          activeOpacity={0.6}
          accessibilityLabel="新建对话"
        >
          <Text style={[styles.icon, creatingChat && styles.iconDim]}>＋</Text>
        </TouchableOpacity>

        <TouchableOpacity
          style={styles.iconButton}
          onPress={onOpenHistory}
          activeOpacity={0.6}
          accessibilityLabel="历史对话"
        >
          <Text style={styles.icon}>⌕</Text>
        </TouchableOpacity>

      </View>
    </View>
  );
}

// 样式由主题派生：只包含本组件用到的键
const createStyles = (theme: Theme) =>
  StyleSheet.create({
    bar: {
      height: CHAT_LAYOUT.topBarHeight,
      paddingHorizontal: CHAT_LAYOUT.gutter,
      flexDirection: 'row',
      alignItems: 'center',
      justifyContent: 'space-between',
      backgroundColor: 'transparent',
    },
    left: {
      width: 84,
      flexDirection: 'row',
      alignItems: 'center',
      flexShrink: 0,
    },
    sessionTitle: {
      flex: 1,
      color: theme.chatText,
      fontSize: 16,
      lineHeight: 21,
      fontWeight: '600',
      textAlign: 'center',
      marginHorizontal: 10,
    },
    right: {
      width: 84,
      flexDirection: 'row',
      alignItems: 'center',
      justifyContent: 'flex-end',
      gap: 8,
      flexShrink: 0,
    },
    burger: {
      width: 16,
      gap: 4,
    },
    burgerLine: {
      height: 2,
      borderRadius: 1,
      backgroundColor: theme.chatText,
    },
    iconButton: {
      width: CHAT_LAYOUT.controlSize,
      height: CHAT_LAYOUT.controlSize,
      borderRadius: CHAT_LAYOUT.controlSize / 2,
      alignItems: 'center',
      justifyContent: 'center',
      backgroundColor: theme.surface,
      borderWidth: StyleSheet.hairlineWidth,
      borderColor: theme.border,
      shadowColor: '#000',
      shadowOffset: { width: 0, height: 3 },
      shadowOpacity: theme.mode === 'dark' ? 0.2 : 0.05,
      shadowRadius: 6,
      elevation: 1,
    },
    icon: {
      color: theme.chatText,
      fontSize: 19,
      lineHeight: 23,
    },
    iconDim: {
      color: theme.chatMuted,
    },
  });
