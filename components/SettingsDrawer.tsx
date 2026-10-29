import React, { useMemo } from 'react';
import {
  Modal,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  TouchableOpacity,
  View,
} from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';

import { MODE_OPTIONS, type Theme, type ThemeMode } from '../theme';
import { moodEmoji } from '../lib/utils';
import { APP_VERSION, MOOD_LABEL } from '../lib/constants';
import { CHAT_LAYOUT, CHAT_TYPE } from '../lib/design';
import { SharedTime } from './SharedTime';

// 设置抽屉：☰ / ⋮ 从左侧滑出的总入口。
// 承载原顶栏下拉菜单的全部功能（记忆库 / 模式 / 主题色 / 控制面板 / 模型 /
// 清理当前会话），并按用户要求把「历史对话」也放进来；其余没有明确归属的
// 模块（返回主页、新建对话、当前心情、共享时钟、版本）同样收在这里。
//
// 用 Modal 而不是绝对定位浮层：项目没有导航库，且浮层会被 KeyboardAvoidingView
// 与安全区裁切；Modal 自带返回键处理（onRequestClose）。
export function SettingsDrawer({
  visible,
  onClose,
  theme,
  mood,
  onOpenHistory,
  onNewChat,
  onReturnHome,
  onOpenMemory,
  onOpenControlPanel,
  onOpenMonitoring,
  onOpenModels,
  onOpenThemePicker,
  onSelectMode,
  onClearHistory,
  creatingChat,
}: {
  visible: boolean;
  onClose: () => void;
  theme: Theme;
  mood: string;
  onOpenHistory: () => void;
  onNewChat: () => void;
  onReturnHome: () => void;
  onOpenMemory: () => void;
  onOpenControlPanel: () => void;
  onOpenMonitoring?: () => void;
  onOpenModels: () => void;
  onOpenThemePicker: () => void;
  onSelectMode: (mode: ThemeMode) => void;
  onClearHistory: () => void;
  creatingChat?: boolean;
}) {
  const styles = useMemo(() => createStyles(theme), [theme]);

  return (
    <Modal
      visible={visible}
      transparent
      animationType="none"
      onRequestClose={onClose}
    >
      <View style={styles.root}>
        <Pressable
          style={styles.scrim}
          onPress={onClose}
          accessibilityLabel="关闭设置"
        />

        <SafeAreaView style={styles.panel} edges={['top', 'bottom', 'left']}>
          <View style={styles.header}>
            <Text style={styles.title}>设置</Text>

            <TouchableOpacity
              onPress={onClose}
              activeOpacity={0.6}
              hitSlop={10}
              accessibilityLabel="关闭"
            >
              <Text style={styles.close}>✕</Text>
            </TouchableOpacity>
          </View>

          {/* 当前心情 + 共享时钟：原来挂在顶栏（表情 + 在线 + 时钟），
              设计图顶栏不再放这些，收进抽屉同一行，功能一个不少 */}
          <View style={styles.statusCard}>
            <Text style={styles.statusEmoji}>{moodEmoji(mood)}</Text>

            <View style={styles.statusTexts}>
              <Text style={styles.statusLabel}>
                当前心情 · {MOOD_LABEL[mood] ?? mood}
              </Text>
              <Text style={styles.statusHint}>
                由 Emotion System 实时同步
              </Text>
            </View>

            <SharedTime theme={theme} />
          </View>

          <ScrollView
            style={styles.scroll}
            contentContainerStyle={styles.list}
            showsVerticalScrollIndicator={false}
          >
            <Text style={styles.groupLabel}>会话</Text>

            <DrawerItem
              theme={theme}
              label="历史对话"
              onPress={onOpenHistory}
            />

            <DrawerItem
              theme={theme}
              label={creatingChat ? '正在新建…' : '新建对话'}
              disabled={creatingChat}
              onPress={onNewChat}
            />

            <DrawerItem theme={theme} label="返回主页" onPress={onReturnHome} />

            <Text style={styles.groupLabel}>功能模块</Text>

            <DrawerItem
              theme={theme}
              label="记忆库"
              onPress={onOpenMemory}
            />

            <DrawerItem
              theme={theme}
              label="控制面板"
              onPress={onOpenControlPanel}
            />

            {onOpenMonitoring ? (
              <DrawerItem
                theme={theme}
                label="系统监控"
                onPress={onOpenMonitoring}
              />
            ) : null}

            <DrawerItem theme={theme} label="模型" onPress={onOpenModels} />

            <DrawerItem
              theme={theme}
              label="主题色"
              value={theme.accentLabel}
              onPress={onOpenThemePicker}
            />

            <Text style={styles.groupLabel}>外观</Text>

            {MODE_OPTIONS.map(option => (
              <DrawerItem
                key={option.id}
                theme={theme}
                label={option.label}
                selected={theme.mode === option.id}
                onPress={() => onSelectMode(option.id)}
              />
            ))}

            <Text style={styles.groupLabel}>当前会话</Text>

            <DrawerItem
              theme={theme}
              label="清理当前会话"
              danger
              onPress={onClearHistory}
            />

            <View style={styles.footer}>
              <Text style={styles.version}>Bluebird {APP_VERSION}</Text>
            </View>
          </ScrollView>
        </SafeAreaView>
      </View>
    </Modal>
  );
}

function DrawerItem({
  theme,
  label,
  value,
  selected,
  danger,
  disabled,
  onPress,
}: {
  theme: Theme;
  label: string;
  value?: string;
  selected?: boolean;
  danger?: boolean;
  disabled?: boolean;
  onPress: () => void;
}) {
  const styles = useMemo(() => createStyles(theme), [theme]);

  return (
    <TouchableOpacity
      style={styles.item}
      onPress={onPress}
      disabled={disabled}
      activeOpacity={0.7}
      accessibilityRole="button"
      accessibilityLabel={label}
    >
      <Text
        style={[
          styles.itemLabel,
          danger && styles.itemDanger,
          disabled && styles.itemDisabled,
        ]}
      >
        {label}
      </Text>

      {!!value && <Text style={styles.itemValue}>{value}</Text>}

      {selected && (
        <Text style={[styles.itemCheck, { color: theme.accent }]}>✓</Text>
      )}
    </TouchableOpacity>
  );
}

// 样式由主题派生：只包含本组件用到的键
const createStyles = (theme: Theme) =>
  StyleSheet.create({
    root: {
      flex: 1,
      flexDirection: 'row',
    },
    scrim: {
      flex: 1,
      backgroundColor: theme.scrim,
    },
    panel: {
      width: '78%',
      maxWidth: 320,
      backgroundColor: theme.surface,
      borderRightWidth: 1,
      borderRightColor: theme.borderStrong,
    },
    header: {
      height: CHAT_LAYOUT.topBarHeight,
      paddingHorizontal: 18,
      flexDirection: 'row',
      alignItems: 'center',
      justifyContent: 'space-between',
    },
    title: {
      color: theme.textPrimary,
      fontSize: 19,
      fontWeight: '700',
    },
    close: {
      color: theme.textSecondary,
      fontSize: 18,
      lineHeight: 22,
      paddingHorizontal: 4,
    },
    statusCard: {
      marginHorizontal: 14,
      marginBottom: 6,
      padding: 14,
      borderRadius: 14,
      backgroundColor: theme.avatarBg,
      borderWidth: 1,
      borderColor: theme.borderStrong,
      flexDirection: 'row',
      alignItems: 'center',
    },
    statusEmoji: {
      fontSize: 26,
      marginRight: 10,
    },
    statusTexts: {
      flex: 1,
      flexShrink: 1,
    },
    statusLabel: {
      color: theme.textPrimary,
      fontSize: 14,
      fontWeight: '600',
    },
    statusHint: {
      color: theme.textMuted,
      fontSize: CHAT_TYPE.meta,
      marginTop: 3,
    },
    scroll: {
      flex: 1,
    },
    list: {
      paddingTop: 6,
      paddingBottom: 24,
    },
    groupLabel: {
      color: theme.textMuted,
      fontSize: CHAT_TYPE.meta,
      letterSpacing: 0.4,
      paddingHorizontal: 18,
      paddingTop: 16,
      paddingBottom: 4,
    },
    item: {
      minHeight: 48,
      paddingHorizontal: 18,
      flexDirection: 'row',
      alignItems: 'center',
    },
    itemLabel: {
      flex: 1,
      color: theme.textBody,
      fontSize: 15,
    },
    itemDanger: {
      color: theme.danger,
    },
    itemDisabled: {
      color: theme.textMuted,
    },
    itemValue: {
      color: theme.textSecondary,
      fontSize: 13,
      marginLeft: 8,
    },
    itemCheck: {
      fontSize: 15,
      fontWeight: '700',
      marginLeft: 8,
    },
    footer: {
      marginTop: 18,
      alignItems: 'center',
    },
    version: {
      color: theme.textMuted,
      fontSize: CHAT_TYPE.meta,
    },
  });
