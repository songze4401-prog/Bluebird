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
      // 实测：设计图顶栏下方没有任何分隔线
      backgroundColor: 'transparent',
    },
    left: {
      width: 44,
      flexDirection: 'row',
      alignItems: 'center',
      flexShrink: 0,
    },
    sessionTitle: {
      flex: 1,
      color: theme.chatText,
      fontSize: 14,
      lineHeight: 19,
      fontWeight: '500',
      textAlign: 'center',
      marginHorizontal: 8,
    },
    right: {
      flexDirection: 'row',
      alignItems: 'center',
      flexShrink: 0,
    },
    burger: {
      width: 18,
      marginRight: 14,
      gap: 4,
    },
    burgerLine: {
      height: 2,
      borderRadius: 1,
      backgroundColor: theme.chatText,
    },
    name: {
      color: theme.chatText,
      fontSize: 16,
      fontWeight: '600',
      letterSpacing: 0.2,
    },
    iconButton: {
      marginLeft: 16,
      paddingHorizontal: 4,
      paddingVertical: 6,
    },
    icon: {
      color: theme.chatText,
      fontSize: 18,
      lineHeight: 22,
    },
    iconDim: {
      color: theme.chatMuted,
    },
  });
