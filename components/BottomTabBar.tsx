import React, { useMemo } from 'react';
import { StyleSheet, Text, TouchableOpacity, View } from 'react-native';

import type { Theme } from '../theme';
import { CHAT_LAYOUT, CHAT_TYPE } from '../lib/design';

export type ChatTab = 'chat' | 'tasks' | 'memory';

const TABS: { id: ChatTab; label: string }[] = [
  { id: 'chat', label: '对话' },
  { id: 'tasks', label: '任务' },
  { id: 'memory', label: '记忆' },
];

// 标签图标：全部用 View 画（圆角矩形 + 点 / 勾 / 圆），不用图片也不用 emoji。
// 设计图三个图标分别是气泡、带勾方框、带点的圆，都能用几何形状稳定复现，
// 且能随主题换色 —— 图片资源做不到这点。
function TabIcon({
  kind,
  active,
  theme,
  styles,
}: {
  kind: ChatTab;
  active: boolean;
  theme: Theme;
  styles: ReturnType<typeof createStyles>;
}) {
  const stroke = active ? theme.sendButton : theme.chatMuted;
  const size = CHAT_LAYOUT.tabIconSize;

  if (kind === 'chat') {
    return (
      <View
        style={[
          styles.bubble,
          {
            width: size + 4,
            height: size,
            backgroundColor: stroke,
            borderColor: stroke,
          },
        ]}
      >
        {[0, 1, 2].map(i => (
          <View
            key={i}
            style={[
              styles.bubbleDot,
              {
                backgroundColor: active ? theme.textOnAccent : theme.chatBg,
              },
            ]}
          />
        ))}
      </View>
    );
  }

  if (kind === 'tasks') {
    return (
      <View
        style={[styles.taskBox, { width: size, height: size, borderColor: stroke }]}
      >
        <Text style={[styles.taskCheck, { color: stroke }]}>✓</Text>
      </View>
    );
  }

  return (
    <View style={[styles.memoryRing, { width: size, height: size, borderColor: stroke }]}>
      <View style={[styles.memoryCore, { backgroundColor: stroke }]} />
    </View>
  );
}

// 底部标签栏（设计图 nav.tabbar）：对话 / 任务 / 记忆，顶部一条 1px 细线。
// 状态由 App 持有（项目没有导航库，三个「页」是同一屏的三种内容），
// 这里只负责渲染与上抛点击。
export function BottomTabBar({
  theme,
  active,
  onChange,
}: {
  theme: Theme;
  active: ChatTab;
  onChange: (tab: ChatTab) => void;
}) {
  const styles = useMemo(() => createStyles(theme), [theme]);

  return (
    <View style={styles.bar}>
      {TABS.map(tab => {
        const isActive = tab.id === active;

        return (
          <TouchableOpacity
            key={tab.id}
            style={styles.tab}
            onPress={() => onChange(tab.id)}
            activeOpacity={0.7}
            accessibilityRole="tab"
            accessibilityState={{ selected: isActive }}
            accessibilityLabel={tab.label}
          >
            <TabIcon
              kind={tab.id}
              active={isActive}
              theme={theme}
              styles={styles}
            />

            <Text
              style={[
                styles.label,
                isActive ? styles.labelActive : styles.labelIdle,
              ]}
            >
              {tab.label}
            </Text>
          </TouchableOpacity>
        );
      })}
    </View>
  );
}

// 样式由主题派生：只包含本组件用到的键
const createStyles = (theme: Theme) =>
  StyleSheet.create({
    bar: {
      height: CHAT_LAYOUT.tabBarHeight,
      flexDirection: 'row',
      alignItems: 'center',
      // 实测：标签栏上方只有一条极浅的分隔线，没有阴影
      borderTopWidth: StyleSheet.hairlineWidth,
      borderTopColor: theme.hairline,
      backgroundColor: theme.chatBg,
    },
    tab: {
      flex: 1,
      alignItems: 'center',
      justifyContent: 'center',
    },
    label: {
      fontSize: CHAT_TYPE.tabLabel,
      lineHeight: 15,
      marginTop: CHAT_LAYOUT.tabIconGap,
    },
    labelActive: {
      color: theme.accent,
      fontWeight: '600',
    },
    labelIdle: {
      color: theme.chatMuted,
    },
    // ---- 图标 ----
    bubble: {
      borderRadius: 7,
      flexDirection: 'row',
      alignItems: 'center',
      justifyContent: 'center',
      gap: 3,
    },
    bubbleDot: {
      width: 3,
      height: 3,
      borderRadius: 1.5,
    },
    taskBox: {
      borderRadius: 6,
      borderWidth: 1.5,
      alignItems: 'center',
      justifyContent: 'center',
    },
    taskCheck: {
      fontSize: 12,
      lineHeight: 14,
      fontWeight: '700',
    },
    memoryRing: {
      borderRadius: CHAT_LAYOUT.tabIconSize / 2,
      borderWidth: 1.5,
      alignItems: 'center',
      justifyContent: 'center',
    },
    memoryCore: {
      width: 6,
      height: 6,
      borderRadius: 3,
    },
  });
