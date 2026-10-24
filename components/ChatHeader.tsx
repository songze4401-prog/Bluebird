import React, { useEffect, useMemo, useRef, useState } from 'react';
import { View, Text, TouchableOpacity, StyleSheet } from 'react-native';

import { MODE_OPTIONS, type Theme, type ThemeMode } from '../theme';
import { moodEmoji } from '../lib/utils';
import { MOOD_LABEL } from '../lib/constants';
import { SharedTime } from './SharedTime';

// 顶部栏 + 下拉菜单。
// 注意：必须用 Fragment 返回两个兄弟节点 —— menu 是绝对定位（top: 62），
// 定位基准是 KeyboardAvoidingView；若在此多包一层 View，菜单会错位。
// menuOpen 由 App 持有：清理聊天记录等动作的关闭时机在异步回调里，
// 属于 App 的业务逻辑，组件只负责渲染与回调。
export function ChatHeader({
  theme,
  mood,
  menuOpen,
  onToggleMenu,
  onOpenMemory,
  onSelectMode,
  onOpenThemePicker,
  onOpenControlPanel,
  onClearHistory,
}: {
  theme: Theme;
  mood: string;
  menuOpen: boolean;
  onToggleMenu: () => void;
  onOpenMemory: () => void;
  onSelectMode: (mode: ThemeMode) => void;
  onOpenThemePicker: () => void;
  onOpenControlPanel: () => void;
  onClearHistory: () => void;
}) {
  const styles = useMemo(() => createStyles(theme), [theme]);

  // 心情气泡：点表情显示/再点收起，2.5s 后自动消失。纯 UI 状态，不外抛
  const [moodTipVisible, setMoodTipVisible] = useState(false);
  const moodTipTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  const toggleMoodTip = () => {
    if (moodTipTimer.current) {
      clearTimeout(moodTipTimer.current);
      moodTipTimer.current = null;
    }

    setMoodTipVisible(prev => {
      const next = !prev;
      if (next) {
        moodTipTimer.current = setTimeout(() => {
          setMoodTipVisible(false);
          moodTipTimer.current = null;
        }, 2500);
      }
      return next;
    });
  };

  useEffect(
    () => () => {
      if (moodTipTimer.current) clearTimeout(moodTipTimer.current);
    },
    []
  );

  return (
    <>
      <View style={styles.header}>
        <View style={styles.headerLeft}>
          <View style={styles.moodWrap}>
            <TouchableOpacity
              onPress={toggleMoodTip}
              activeOpacity={0.7}
              accessibilityLabel="查看当前心情"
            >
              <Text style={styles.headerMood}>{moodEmoji(mood)}</Text>
            </TouchableOpacity>

            {moodTipVisible && (
              <View style={styles.moodTip}>
                <Text style={styles.moodTipText}>
                  {MOOD_LABEL[mood] ?? mood}
                </Text>
              </View>
            )}
          </View>
          <View style={styles.headerTitle}>
            <Text style={styles.title} numberOfLines={1}>
              Bluebird
            </Text>
            <Text style={styles.status}>● 在线</Text>
          </View>
        </View>

        <View style={styles.headerRight}>
          <SharedTime theme={theme} />

          <TouchableOpacity style={styles.menuButton} onPress={onToggleMenu}>
            <Text style={styles.menuIcon}>☰</Text>
          </TouchableOpacity>
        </View>
      </View>

      {menuOpen && (
        <View style={styles.menu}>
          <TouchableOpacity style={styles.menuItem} onPress={onOpenMemory}>
            <Text style={styles.menuItemText}>记忆库</Text>
          </TouchableOpacity>

          {MODE_OPTIONS.map(option => {
            const active = theme.mode === option.id;

            return (
              <TouchableOpacity
                key={option.id}
                style={styles.menuItem}
                onPress={() => onSelectMode(option.id)}
              >
                <Text
                  style={[
                    styles.menuItemText,
                    active && { color: theme.accent },
                  ]}
                >
                  {option.label}
                  {active ? '  ✓' : ''}
                </Text>
              </TouchableOpacity>
            );
          })}

          <TouchableOpacity style={styles.menuItem} onPress={onOpenThemePicker}>
            <Text style={styles.menuItemText}>主题色</Text>
          </TouchableOpacity>

          <TouchableOpacity
            style={styles.menuItem}
            onPress={onOpenControlPanel}
          >
            <Text style={styles.menuItemText}>控制面板</Text>
          </TouchableOpacity>

          <TouchableOpacity style={styles.menuItem} onPress={onClearHistory}>
            <Text style={styles.menuItemText}>清理当前会话</Text>
          </TouchableOpacity>

          <View style={styles.menuVersion}>
            <Text style={styles.version}>V0.3</Text>
          </View>
        </View>
      )}
    </>
  );
}

// 样式由主题派生：只包含本组件用到的键
const createStyles = (theme: Theme) =>
  StyleSheet.create({
    header: {
      height: 72,
      paddingHorizontal: 20,
      flexDirection: 'row',
      alignItems: 'center',
      justifyContent: 'space-between',
      borderBottomWidth: 1,
      borderBottomColor: theme.border,
    },
    title: {
      color: theme.textPrimary,
      fontSize: 24,
      fontWeight: '700',
    },
    status: {
      color: theme.online,
      fontSize: 12,
      marginTop: 3,
    },
    version: {
      color: theme.textMuted,
      fontSize: 12,
    },
    headerRight: {
      flexDirection: 'row',
      alignItems: 'center',
      flexShrink: 0,
    },

    menuButton: {
      marginLeft: 14,
      padding: 6,
    },

    menuIcon: {
      color: theme.textPrimary,
      fontSize: 22,
    },

    menu: {
      position: 'absolute',
      top: 62,
      right: 16,
      zIndex: 100,
      width: 160,
      backgroundColor: theme.surface,
      borderRadius: 12,
      paddingVertical: 6,
      borderWidth: 1,
      borderColor: theme.borderStrong,
    },

    menuItem: {
      paddingHorizontal: 16,
      paddingVertical: 13,
    },

    menuItemText: {
      color: theme.textPrimary,
      fontSize: 15,
    },

    menuVersion: {
      alignItems: 'center',
      marginTop: 4,
      paddingTop: 9,
      paddingBottom: 5,
      borderTopWidth: 1,
      borderTopColor: theme.border,
    },

    headerLeft: {
      flexDirection: 'row',
      alignItems: 'center',
      flexShrink: 1,
    },

    headerTitle: {
      flexShrink: 1,
    },

    headerMood: {
      fontSize: 26,
    },

    // 表情 + 心情气泡的锚点：气泡相对它绝对定位
    moodWrap: {
      marginRight: 10,
    },

    // 心情小气泡：浮在表情正下方，不挤压标题布局
    moodTip: {
      position: 'absolute',
      top: 34,
      left: -4,
      zIndex: 60,
      backgroundColor: theme.surface,
      borderWidth: 1,
      borderColor: theme.borderStrong,
      borderRadius: 8,
      paddingHorizontal: 9,
      paddingVertical: 4,
      shadowColor: '#000',
      shadowOpacity: 0.18,
      shadowRadius: 6,
      shadowOffset: { width: 0, height: 2 },
      elevation: 4,
    },

    moodTipText: {
      color: theme.textPrimary,
      fontSize: 12,
    },
  });