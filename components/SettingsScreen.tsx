import React, { useMemo } from 'react';
import {
  Alert,
  Modal,
  ScrollView,
  StyleSheet,
  Text,
  TouchableOpacity,
  View,
} from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';

import type { Theme } from '../theme';
import { APP_VERSION } from '../lib/constants';

export function SettingsScreen({
  visible,
  onClose,
  theme,
  modelLabel,
  streamingEnabled,
  onToggleStreaming,
  onOpenModels,
  onOpenMemory,
  onOpenControlPanel,
  onOpenAgentTools,
  onOpenMonitoring,
  onOpenTheme,
  onClearHistory,
}: {
  visible: boolean;
  onClose: () => void;
  theme: Theme;
  modelLabel: string;
  streamingEnabled: boolean;
  onToggleStreaming: (enabled: boolean) => void;
  onOpenModels: () => void;
  onOpenMemory: () => void;
  onOpenControlPanel: () => void;
  onOpenAgentTools: () => void;
  onOpenMonitoring: () => void;
  onOpenTheme: () => void;
  onClearHistory: () => void;
}) {
  const styles = useMemo(() => createStyles(theme), [theme]);

  const notOpen = (label: string) => {
    Alert.alert(label, '该能力尚未接入当前版本，暂未开放。');
  };

  return (
    <Modal visible={visible} animationType="slide" onRequestClose={onClose}>
      <SafeAreaView style={styles.root}>
        <View style={styles.header}>
          <TouchableOpacity
            onPress={onClose}
            style={styles.back}
            hitSlop={8}
            accessibilityLabel="返回"
          >
            <Text style={styles.backText}>‹</Text>
          </TouchableOpacity>
          <Text style={styles.headerTitle}>设置</Text>
          <TouchableOpacity
            onPress={onClose}
            style={styles.close}
            hitSlop={8}
            accessibilityLabel="关闭设置"
          >
            <Text style={styles.closeText}>✕</Text>
          </TouchableOpacity>
        </View>

        <ScrollView
          contentContainerStyle={styles.content}
          showsVerticalScrollIndicator={false}
        >
          <Text style={styles.title}>设置</Text>

          <View style={styles.profile}>
            <View style={styles.monogram}>
              <Text style={styles.monogramText}>S</Text>
            </View>
            <View style={styles.profileMain}>
              <Text style={styles.profileName}>个人空间</Text>
              <Text style={styles.profileHint}>本机数据优先</Text>
            </View>
          </View>

          <Section styles={styles} label="模型与上下文">
            <Row
              theme={theme}
              styles={styles}
              label="默认模型"
              value={modelLabel || '未读取'}
              onPress={onOpenModels}
            />
            <Row
              theme={theme}
              styles={styles}
              label="上下文预算"
              value="自动"
              onPress={() => notOpen('上下文预算')}
            />
            <Row
              theme={theme}
              styles={styles}
              label="流式输出"
              toggle={streamingEnabled}
              onPress={() => onToggleStreaming(!streamingEnabled)}
            />
          </Section>

          <Section styles={styles} label="Agent">
            <Row
              theme={theme}
              styles={styles}
              label="Agent 工具"
              value="服务端配置"
              onPress={onOpenAgentTools}
            />
            <Row
              theme={theme}
              styles={styles}
              label="高级策略"
              value="控制面板"
              onPress={onOpenControlPanel}
            />
            <Row
              theme={theme}
              styles={styles}
              label="系统监控"
              value="只读"
              onPress={onOpenMonitoring}
            />
          </Section>

          <Section styles={styles} label="记忆与人格">
            <Row
              theme={theme}
              styles={styles}
              label="Memory Center"
              value="记忆管理中心"
              onPress={onOpenMemory}
            />
            <Row
              theme={theme}
              styles={styles}
              label="人格与表达"
              onPress={onOpenControlPanel}
            />
            <Row
              theme={theme}
              styles={styles}
              label="外观与主题"
              onPress={onOpenTheme}
            />
          </Section>

          <Section styles={styles} label="数据与隐私">
            <Row
              theme={theme}
              styles={styles}
              label="备份与导出"
              value="暂未接入"
              onPress={() => notOpen('备份与导出')}
            />
            <Row
              theme={theme}
              styles={styles}
              label="Agent 运行日志"
              value="暂未接入"
              onPress={() => notOpen('Agent 运行日志')}
            />
            <Row
              theme={theme}
              styles={styles}
              label="清除当前会话"
              danger
              onPress={onClearHistory}
            />
          </Section>

          <Text style={styles.footer}>Bluebird {APP_VERSION} · 本机数据优先</Text>
        </ScrollView>
      </SafeAreaView>
    </Modal>
  );
}

function Section({
  label,
  children,
  styles,
}: {
  label: string;
  children: React.ReactNode;
  styles: ReturnType<typeof createStyles>;
}) {
  return (
    <View style={styles.section}>
      <Text style={styles.sectionLabel}>{label}</Text>
      <View style={styles.sectionBody}>{children}</View>
    </View>
  );
}

function Row({
  label,
  value,
  toggle,
  danger,
  onPress,
  styles,
}: {
  theme: Theme;
  label: string;
  value?: string;
  toggle?: boolean;
  danger?: boolean;
  onPress: () => void;
  styles: ReturnType<typeof createStyles>;
}) {
  return (
    <TouchableOpacity
      style={styles.row}
      onPress={onPress}
      activeOpacity={0.65}
      accessibilityLabel={label}
    >
      <Text style={[styles.rowLabel, danger && styles.danger]}>{label}</Text>
      {toggle !== undefined ? (
        <View style={[styles.toggle, toggle && styles.toggleOn]}>
          <View style={[styles.knob, toggle && styles.knobOn]} />
        </View>
      ) : (
        <>
          {!!value && <Text style={styles.rowValue}>{value}</Text>}
          <Text style={styles.chev}>›</Text>
        </>
      )}
    </TouchableOpacity>
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
    back: {
      width: 40,
      height: 40,
      alignItems: 'flex-start',
      justifyContent: 'center',
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
    close: {
      width: 40,
      height: 40,
      alignItems: 'flex-end',
      justifyContent: 'center',
    },
    closeText: {
      color: theme.textSecondary,
      fontSize: 17,
    },
    content: {
      paddingHorizontal: 20,
      paddingTop: 12,
      paddingBottom: 44,
    },
    title: {
      color: theme.textPrimary,
      fontSize: 30,
      lineHeight: 38,
      fontWeight: '600',
      letterSpacing: -0.5,
    },
    profile: {
      marginTop: 18,
      minHeight: 55,
      flexDirection: 'row',
      alignItems: 'center',
      gap: 11,
      borderBottomWidth: StyleSheet.hairlineWidth,
      borderBottomColor: theme.border,
    },
    monogram: {
      width: 32,
      height: 32,
      borderRadius: 16,
      borderWidth: StyleSheet.hairlineWidth,
      borderColor: theme.borderStrong,
      alignItems: 'center',
      justifyContent: 'center',
    },
    monogramText: {
      color: theme.textSecondary,
      fontSize: 12,
      fontWeight: '600',
    },
    profileMain: {
      flex: 1,
    },
    profileName: {
      color: theme.textBody,
      fontSize: 13,
      lineHeight: 18,
      fontWeight: '500',
    },
    profileHint: {
      color: theme.textMuted,
      fontSize: 10,
      lineHeight: 15,
      marginTop: 2,
    },
    section: {
      marginTop: 25,
    },
    sectionLabel: {
      color: theme.textMuted,
      fontSize: 10,
      lineHeight: 14,
      letterSpacing: 0.6,
      marginBottom: 2,
    },
    sectionBody: {
      borderTopWidth: StyleSheet.hairlineWidth,
      borderTopColor: theme.border,
    },
    row: {
      minHeight: 48,
      flexDirection: 'row',
      alignItems: 'center',
      gap: 10,
      borderBottomWidth: StyleSheet.hairlineWidth,
      borderBottomColor: theme.border,
    },
    rowLabel: {
      flex: 1,
      color: theme.textBody,
      fontSize: 13,
      lineHeight: 18,
    },
    rowValue: {
      color: theme.textMuted,
      fontSize: 10,
      lineHeight: 15,
    },
    chev: {
      color: theme.textMuted,
      fontSize: 15,
    },
    danger: {
      color: theme.danger,
    },
    toggle: {
      width: 38,
      height: 23,
      borderRadius: 12,
      backgroundColor: theme.pill,
      borderWidth: StyleSheet.hairlineWidth,
      borderColor: theme.borderStrong,
      justifyContent: 'center',
      paddingHorizontal: 2,
    },
    toggleOn: {
      backgroundColor: theme.avatarBg,
      borderColor: theme.accentBorder,
    },
    knob: {
      width: 17,
      height: 17,
      borderRadius: 9,
      backgroundColor: theme.textMuted,
    },
    knobOn: {
      alignSelf: 'flex-end',
      backgroundColor: theme.accent,
    },
    footer: {
      marginTop: 25,
      color: theme.textMuted,
      fontSize: 9,
      lineHeight: 14,
      letterSpacing: 0.3,
    },
  });
