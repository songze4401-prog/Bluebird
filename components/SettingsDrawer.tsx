import React, { useMemo, useState } from 'react';
import {
  ActivityIndicator,
  KeyboardAvoidingView,
  Modal,
  Platform,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  TouchableOpacity,
  View,
} from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';

import { MODE_OPTIONS, type Theme, type ThemeMode } from '../theme';
import type { SessionMeta } from '../lib/types';
import { formatMessageTime, moodEmoji, withAlpha } from '../lib/utils';
import { APP_VERSION, MOOD_LABEL } from '../lib/constants';
import { CHAT_LAYOUT, CHAT_TYPE } from '../lib/design';
import { SharedTime } from './SharedTime';

// 左侧设置抽屉：☰ 的唯一目的地。
// 本轮重做把「空间 / 系统 / 外观 / 数据」的长列表换成有体积的卡片面板：
//   个人空间 → 四张功能卡 → Agent 主色横幅 → 真实最近对话 → 外观 → 更多 → 底栏。
// 所有入口仍是原有真实能力；最近对话直接消费 App 的 /sessions 数据源，
// 底栏搜索只过滤这份列表，不另发请求、不伪造会话。
export function SettingsDrawer({
  visible,
  onClose,
  theme,
  mood,
  sessions,
  currentSessionId,
  loadingSessions,
  sessionsError,
  onSelectSession,
  onOpenHistory,
  onNewChat,
  onOpenMemory,
  onOpenControlPanel,
  onOpenMonitoring,
  onOpenAgentTools,
  onOpenSettings,
  onOpenTasks,
  onOpenChat,
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
  sessions: SessionMeta[];
  currentSessionId: string;
  loadingSessions?: boolean;
  sessionsError?: string;
  onSelectSession: (sessionId: string) => void;
  onOpenHistory: () => void;
  onNewChat: () => void;
  onOpenMemory: () => void;
  onOpenControlPanel: () => void;
  onOpenMonitoring?: () => void;
  onOpenAgentTools?: () => void;
  onOpenSettings?: () => void;
  onOpenTasks?: () => void;
  onOpenChat?: () => void;
  onOpenModels: () => void;
  onOpenThemePicker: () => void;
  onSelectMode: (mode: ThemeMode) => void;
  onClearHistory: () => void;
  creatingChat?: boolean;
}) {
  const styles = useMemo(() => createStyles(theme), [theme]);
  const [query, setQuery] = useState('');

  const close = () => {
    setQuery('');
    onClose();
  };

  const visibleSessions = useMemo(() => {
    // 除当前会话外，空白会话不占「最近对话」名额；它们仍可在历史页管理。
    const listed = sessions.filter(
      item => item.messageCount > 0 || item.id === currentSessionId
    );
    const needle = query.trim().toLowerCase();
    const matched = needle
      ? listed.filter(item =>
          `${item.title || ''} ${item.id}`.toLowerCase().includes(needle)
        )
      : listed;

    return matched.slice(0, 5);
  }, [currentSessionId, query, sessions]);

  const runAndClose = (action: () => void) => {
    close();
    action();
  };

  return (
    <Modal
      visible={visible}
      transparent
      animationType="none"
      onRequestClose={close}
    >
      <View style={styles.root}>
        <SafeAreaView style={styles.panel} edges={['top', 'bottom', 'left']}>
          <KeyboardAvoidingView
            style={styles.panelInner}
            behavior={Platform.OS === 'ios' ? 'padding' : undefined}
          >
            <View style={styles.topBar}>
              <View style={styles.wordmarkLine}>
                <View style={styles.wordmarkDot} />
                <Text style={styles.wordmark}>BLUEBIRD</Text>
              </View>

              <TouchableOpacity
                style={styles.closeButton}
                onPress={close}
                activeOpacity={0.6}
                hitSlop={8}
                accessibilityLabel="关闭"
              >
                <Text style={styles.close}>✕</Text>
              </TouchableOpacity>
            </View>

            <ScrollView
              style={styles.scroll}
              contentContainerStyle={styles.list}
              showsVerticalScrollIndicator={false}
              keyboardShouldPersistTaps="handled"
            >
              <View style={styles.profile}>
                <View style={styles.monogramOuter}>
                  <View style={styles.monogramInner}>
                    <Text style={styles.monogramText}>B</Text>
                  </View>
                </View>

                <View style={styles.profileTexts}>
                  <Text style={styles.profileName}>个人空间</Text>
                  <Text style={styles.profileMeta}>
                    {moodEmoji(mood)} {MOOD_LABEL[mood] ?? mood} · 本机数据优先
                  </Text>
                </View>

                <View style={styles.profileClock}>
                  <SharedTime theme={theme} />
                </View>
              </View>

              <View style={styles.quickRow}>
                {onOpenTasks && (
                  <QuickCard
                    theme={theme}
                    styles={styles}
                    glyph="✓"
                    label="任务"
                    hint="后台执行与状态"
                    onPress={() => runAndClose(onOpenTasks)}
                  />
                )}

                <QuickCard
                  theme={theme}
                  styles={styles}
                  glyph="◈"
                  label="记忆库"
                  hint="长期记忆与检索"
                  onPress={() => runAndClose(onOpenMemory)}
                />
              </View>

              <View style={styles.quickRow}>
                <QuickCard
                  theme={theme}
                  styles={styles}
                  glyph="◇"
                  label="模型"
                  hint="服务商与默认模型"
                  onPress={() => runAndClose(onOpenModels)}
                />

                {onOpenAgentTools && (
                  <QuickCard
                    theme={theme}
                    styles={styles}
                    glyph="✦"
                    label="Agent 工具"
                    hint="权限与工具清单"
                    onPress={() => runAndClose(onOpenAgentTools)}
                  />
                )}
              </View>

              <TouchableOpacity
                style={styles.banner}
                activeOpacity={0.88}
                onPress={() => runAndClose(onOpenControlPanel)}
                accessibilityRole="button"
                accessibilityLabel="Bluebird Agent 控制面板"
              >
                <View style={styles.bannerIcon}>
                  <Text style={styles.bannerIconText}>✦</Text>
                </View>

                <View style={styles.bannerTexts}>
                  <Text style={styles.bannerTitle}>Bluebird Agent</Text>
                  <Text style={styles.bannerSubtitle} numberOfLines={1}>
                    记忆、工具与上下文已就位
                  </Text>
                </View>

                <View style={styles.bannerButton}>
                  <Text style={styles.bannerButtonText}>控制</Text>
                </View>
              </TouchableOpacity>

              <View style={styles.sectionHead}>
                <Text style={styles.sectionHeadLabel}>最近对话</Text>
                <TouchableOpacity
                  onPress={() => runAndClose(onOpenHistory)}
                  activeOpacity={0.6}
                  hitSlop={6}
                  accessibilityLabel="查看全部历史对话"
                >
                  <Text style={styles.sectionAction}>查看全部</Text>
                </TouchableOpacity>
              </View>

              <View style={styles.sessionCard}>
                {loadingSessions && sessions.length === 0 ? (
                  <View style={styles.sessionNotice}>
                    <ActivityIndicator color={theme.accent} size="small" />
                    <Text style={styles.sessionNoticeText}>正在读取会话…</Text>
                  </View>
                ) : sessionsError && sessions.length === 0 ? (
                  <TouchableOpacity
                    style={styles.sessionNotice}
                    onPress={() => runAndClose(onOpenHistory)}
                    activeOpacity={0.7}
                    accessibilityLabel="会话列表读取失败，查看历史对话"
                  >
                    <Text style={styles.sessionErrorText}>
                      会话列表读取失败
                    </Text>
                    <Text style={styles.sessionNoticeText}>点此查看与重试</Text>
                  </TouchableOpacity>
                ) : visibleSessions.length === 0 ? (
                  <View style={styles.sessionNotice}>
                    <Text style={styles.sessionNoticeText}>
                      {query.trim() ? '没有匹配的对话' : '还没有任何对话'}
                    </Text>
                  </View>
                ) : (
                  visibleSessions.map((item, index) => {
                    const current = item.id === currentSessionId;
                    const title = item.messageCount
                      ? item.title || '未命名会话'
                      : '新对话';
                    const time = formatMessageTime(item.updatedAt);
                    const meta = item.messageCount
                      ? `${item.messageCount} 条消息${time ? ` · ${time}` : ''}`
                      : `空白对话${time ? ` · ${time}` : ''}`;

                    return (
                      <TouchableOpacity
                        key={item.id}
                        style={[
                          styles.sessionRow,
                          index < visibleSessions.length - 1 &&
                            styles.sessionRowDivider,
                        ]}
                        activeOpacity={0.7}
                        onPress={() => {
                          close();
                          // 当前对话已经在屏幕上：只收抽屉，不重复拉历史，
                          // 避免空白新对话被服务器欢迎语替换掉首屏。
                          if (item.id === currentSessionId) return;
                          onSelectSession(item.id);
                        }}
                        accessibilityLabel={`打开会话 ${title}`}
                      >
                        <View style={styles.sessionMain}>
                          <View style={styles.sessionTitleLine}>
                            {current && <View style={styles.currentDot} />}
                            <Text style={styles.sessionTitle} numberOfLines={1}>
                              {title}
                            </Text>
                          </View>
                          <Text style={styles.sessionMeta} numberOfLines={1}>
                            {meta}
                          </Text>
                        </View>
                        <Text style={styles.chevron}>›</Text>
                      </TouchableOpacity>
                    );
                  })
                )}
              </View>

              <Text style={styles.sectionLabel}>外观</Text>

              <View style={styles.appearanceCard}>
                <View style={styles.modeRow}>
                  {MODE_OPTIONS.map(option => {
                    const selected = theme.mode === option.id;

                    return (
                      <TouchableOpacity
                        key={option.id}
                        style={[
                          styles.modePill,
                          selected && styles.modePillActive,
                        ]}
                        onPress={() => onSelectMode(option.id)}
                        activeOpacity={0.75}
                        accessibilityRole="button"
                        accessibilityLabel={option.label}
                      >
                        <Text
                          style={[
                            styles.modeText,
                            selected && styles.modeTextActive,
                          ]}
                        >
                          {option.label}
                        </Text>
                      </TouchableOpacity>
                    );
                  })}
                </View>

                <TouchableOpacity
                  style={styles.accentRow}
                  onPress={() => runAndClose(onOpenThemePicker)}
                  activeOpacity={0.7}
                  accessibilityLabel="主题色"
                >
                  <View
                    style={[
                      styles.accentSwatch,
                      { backgroundColor: theme.accent },
                    ]}
                  />
                  <Text style={styles.rowLabel}>主题色</Text>
                  <Text style={styles.rowValue}>{theme.accentLabel}</Text>
                  <Text style={styles.chevron}>›</Text>
                </TouchableOpacity>
              </View>

              <Text style={styles.sectionLabel}>更多</Text>

              <View style={styles.moreCard}>
                {onOpenChat && (
                  <NavRow
                    styles={styles}
                    label="返回对话"
                    onPress={() => runAndClose(onOpenChat)}
                  />
                )}
                {onOpenMonitoring && (
                  <NavRow
                    styles={styles}
                    label="系统监控"
                    onPress={() => runAndClose(onOpenMonitoring)}
                  />
                )}
              </View>

              <TouchableOpacity
                style={styles.dangerRow}
                onPress={() => runAndClose(onClearHistory)}
                activeOpacity={0.7}
                accessibilityRole="button"
                accessibilityLabel="清理当前会话"
              >
                <Text style={styles.dangerText}>清理当前会话</Text>
              </TouchableOpacity>

              <Text style={styles.version}>
                Bluebird {APP_VERSION} · 本机数据优先
              </Text>
            </ScrollView>

            <View style={styles.dock}>
              <View style={styles.search}>
                <Text style={styles.searchGlyph}>⌕</Text>
                <TextInput
                  value={query}
                  onChangeText={setQuery}
                  placeholder="搜索对话"
                  placeholderTextColor={theme.textMuted}
                  selectionColor={theme.accent}
                  style={styles.searchInput}
                  returnKeyType="search"
                  accessibilityLabel="搜索对话"
                />
                {!!query && (
                  <TouchableOpacity
                    onPress={() => setQuery('')}
                    hitSlop={8}
                    accessibilityLabel="清除搜索"
                  >
                    <Text style={styles.searchClear}>✕</Text>
                  </TouchableOpacity>
                )}
              </View>

              {onOpenSettings && (
                <TouchableOpacity
                  style={styles.dockButton}
                  onPress={() => runAndClose(onOpenSettings)}
                  activeOpacity={0.7}
                  accessibilityLabel="设置"
                >
                  <Text style={styles.dockGlyph}>⚙</Text>
                </TouchableOpacity>
              )}

              <TouchableOpacity
                style={[
                  styles.dockButton,
                  styles.newChatButton,
                  creatingChat && styles.dim,
                ]}
                onPress={() => runAndClose(onNewChat)}
                disabled={creatingChat}
                activeOpacity={0.8}
                accessibilityLabel="新建对话"
              >
                <Text style={styles.newChatGlyph}>＋</Text>
              </TouchableOpacity>
            </View>
          </KeyboardAvoidingView>
        </SafeAreaView>

        <Pressable
          style={styles.scrim}
          onPress={close}
          accessibilityLabel="关闭菜单"
        />
      </View>
    </Modal>
  );
}

function QuickCard({
  theme,
  styles,
  glyph,
  label,
  hint,
  onPress,
}: {
  theme: Theme;
  styles: ReturnType<typeof createStyles>;
  glyph: string;
  label: string;
  hint: string;
  onPress: () => void;
}) {
  return (
    <TouchableOpacity
      style={styles.quickCard}
      onPress={onPress}
      activeOpacity={0.78}
      accessibilityRole="button"
      accessibilityLabel={label}
    >
      <View
        style={[
          styles.quickIcon,
          { backgroundColor: withAlpha(theme.accent, 0.13) },
        ]}
      >
        <Text style={styles.quickGlyph}>{glyph}</Text>
      </View>
      <Text style={styles.quickLabel}>{label}</Text>
      <Text style={styles.quickHint} numberOfLines={1}>
        {hint}
      </Text>
    </TouchableOpacity>
  );
}

function NavRow({
  styles,
  label,
  onPress,
}: {
  styles: ReturnType<typeof createStyles>;
  label: string;
  onPress: () => void;
}) {
  return (
    <TouchableOpacity
      style={styles.navRow}
      onPress={onPress}
      activeOpacity={0.7}
      accessibilityRole="button"
      accessibilityLabel={label}
    >
      <Text style={styles.rowLabel}>{label}</Text>
      <Text style={styles.chevron}>›</Text>
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
      width: '92%',
      maxWidth: 412,
      backgroundColor: theme.background,
      borderTopRightRadius: 26,
      borderBottomRightRadius: 26,
      borderRightWidth: StyleSheet.hairlineWidth,
      borderRightColor: theme.borderStrong,
      shadowColor: '#000',
      shadowOffset: { width: 12, height: 0 },
      shadowOpacity: theme.mode === 'dark' ? 0.5 : 0.16,
      shadowRadius: 24,
      elevation: 18,
    },
    panelInner: {
      flex: 1,
    },
    topBar: {
      height: CHAT_LAYOUT.topBarHeight,
      paddingHorizontal: 20,
      flexDirection: 'row',
      alignItems: 'center',
      justifyContent: 'space-between',
    },
    wordmarkLine: {
      flexDirection: 'row',
      alignItems: 'center',
      gap: 7,
    },
    wordmarkDot: {
      width: 5,
      height: 5,
      borderRadius: 3,
      backgroundColor: theme.accent,
    },
    wordmark: {
      color: theme.textSecondary,
      fontSize: 10,
      lineHeight: 14,
      fontWeight: '600',
      letterSpacing: 1.8,
    },
    closeButton: {
      width: 32,
      height: 32,
      borderRadius: 16,
      alignItems: 'center',
      justifyContent: 'center',
      backgroundColor: theme.surface,
      borderWidth: StyleSheet.hairlineWidth,
      borderColor: theme.border,
    },
    close: {
      color: theme.textSecondary,
      fontSize: 12,
      lineHeight: 16,
    },
    scroll: {
      flex: 1,
    },
    list: {
      paddingBottom: 22,
    },
    profile: {
      paddingHorizontal: 20,
      paddingTop: 8,
      paddingBottom: 4,
      flexDirection: 'row',
      alignItems: 'center',
    },
    monogramOuter: {
      width: 56,
      height: 56,
      borderRadius: 28,
      alignItems: 'center',
      justifyContent: 'center',
      backgroundColor: theme.surface,
      borderWidth: 1,
      borderColor: theme.accentBorder,
      shadowColor: '#000',
      shadowOffset: { width: 0, height: 6 },
      shadowOpacity: theme.mode === 'dark' ? 0.35 : 0.1,
      shadowRadius: 12,
      elevation: 4,
    },
    monogramInner: {
      width: 44,
      height: 44,
      borderRadius: 22,
      alignItems: 'center',
      justifyContent: 'center',
      backgroundColor: withAlpha(theme.accent, 0.16),
    },
    monogramText: {
      color: theme.accent,
      fontSize: 20,
      lineHeight: 25,
      fontWeight: '700',
    },
    profileTexts: {
      flex: 1,
      minWidth: 0,
      marginLeft: 13,
    },
    profileName: {
      color: theme.textPrimary,
      fontSize: 20,
      lineHeight: 26,
      fontWeight: '600',
      letterSpacing: -0.3,
    },
    profileMeta: {
      marginTop: 4,
      color: theme.textMuted,
      fontSize: 10.5,
      lineHeight: 15,
    },
    profileClock: {
      marginRight: -12,
    },
    quickRow: {
      flexDirection: 'row',
      gap: 10,
      paddingHorizontal: 20,
      marginTop: 10,
    },
    quickCard: {
      flex: 1,
      minHeight: 96,
      padding: 14,
      borderRadius: 20,
      backgroundColor: theme.surface,
      borderWidth: StyleSheet.hairlineWidth,
      borderColor: theme.borderStrong,
      shadowColor: '#000',
      shadowOffset: { width: 0, height: 7 },
      shadowOpacity: theme.mode === 'dark' ? 0.34 : 0.07,
      shadowRadius: 14,
      elevation: 3,
    },
    quickIcon: {
      width: 30,
      height: 30,
      borderRadius: 11,
      alignItems: 'center',
      justifyContent: 'center',
      marginBottom: 11,
    },
    quickGlyph: {
      color: theme.accent,
      fontSize: 15,
      lineHeight: 19,
      fontWeight: '600',
    },
    quickLabel: {
      color: theme.textPrimary,
      fontSize: 13.5,
      lineHeight: 18,
      fontWeight: '600',
    },
    quickHint: {
      marginTop: 3,
      color: theme.textMuted,
      fontSize: 9.5,
      lineHeight: 14,
    },
    banner: {
      marginHorizontal: 20,
      marginTop: 16,
      minHeight: 86,
      paddingHorizontal: 16,
      paddingVertical: 14,
      borderRadius: 24,
      backgroundColor: theme.accent,
      flexDirection: 'row',
      alignItems: 'center',
      shadowColor: theme.accent,
      shadowOffset: { width: 0, height: 9 },
      shadowOpacity: theme.mode === 'dark' ? 0.34 : 0.28,
      shadowRadius: 18,
      elevation: 8,
    },
    bannerIcon: {
      width: 38,
      height: 38,
      borderRadius: 19,
      alignItems: 'center',
      justifyContent: 'center',
      backgroundColor: withAlpha(theme.textOnAccent, 0.15),
    },
    bannerIconText: {
      color: theme.textOnAccent,
      fontSize: 17,
      lineHeight: 21,
    },
    bannerTexts: {
      flex: 1,
      minWidth: 0,
      marginLeft: 12,
      marginRight: 8,
    },
    bannerTitle: {
      color: theme.textOnAccent,
      fontSize: 15.5,
      lineHeight: 21,
      fontWeight: '600',
    },
    bannerSubtitle: {
      marginTop: 3,
      color: theme.textOnAccent,
      opacity: 0.86,
      fontSize: 10.5,
      lineHeight: 15,
    },
    bannerButton: {
      height: 30,
      paddingHorizontal: 13,
      borderRadius: 15,
      alignItems: 'center',
      justifyContent: 'center',
      backgroundColor: withAlpha(theme.textOnAccent, 0.16),
    },
    bannerButtonText: {
      color: theme.textOnAccent,
      fontSize: 11,
      lineHeight: 15,
      fontWeight: '600',
    },
    sectionHead: {
      marginTop: 24,
      marginBottom: 9,
      paddingHorizontal: 20,
      flexDirection: 'row',
      alignItems: 'center',
      justifyContent: 'space-between',
    },
    sectionHeadLabel: {
      color: theme.textMuted,
      fontSize: 10,
      lineHeight: 14,
      fontWeight: '600',
      letterSpacing: 1,
    },
    sectionLabel: {
      marginTop: 24,
      marginBottom: 9,
      paddingHorizontal: 20,
      color: theme.textMuted,
      fontSize: 10,
      lineHeight: 14,
      fontWeight: '600',
      letterSpacing: 1,
    },
    sectionAction: {
      color: theme.accent,
      fontSize: 11,
      lineHeight: 15,
      fontWeight: '500',
    },
    sessionCard: {
      marginHorizontal: 20,
      backgroundColor: theme.surface,
      borderRadius: 18,
      borderWidth: StyleSheet.hairlineWidth,
      borderColor: theme.borderStrong,
      overflow: 'hidden',
      shadowColor: '#000',
      shadowOffset: { width: 0, height: 7 },
      shadowOpacity: theme.mode === 'dark' ? 0.3 : 0.06,
      shadowRadius: 14,
      elevation: 3,
    },
    sessionRow: {
      minHeight: 58,
      paddingHorizontal: 14,
      paddingVertical: 10,
      flexDirection: 'row',
      alignItems: 'center',
    },
    sessionRowDivider: {
      borderBottomWidth: StyleSheet.hairlineWidth,
      borderBottomColor: theme.border,
    },
    sessionMain: {
      flex: 1,
      minWidth: 0,
    },
    sessionTitleLine: {
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
    sessionTitle: {
      flex: 1,
      color: theme.textBody,
      fontSize: 13,
      lineHeight: 18,
      fontWeight: '500',
    },
    sessionMeta: {
      marginTop: 3,
      color: theme.textMuted,
      fontSize: 10,
      lineHeight: 15,
    },
    chevron: {
      marginLeft: 8,
      color: theme.textMuted,
      fontSize: 17,
      lineHeight: 21,
    },
    sessionNotice: {
      minHeight: 64,
      paddingHorizontal: 16,
      paddingVertical: 14,
      alignItems: 'center',
      justifyContent: 'center',
      gap: 7,
    },
    sessionNoticeText: {
      color: theme.textMuted,
      fontSize: 11,
      lineHeight: 16,
      textAlign: 'center',
    },
    sessionErrorText: {
      color: theme.danger,
      fontSize: 11,
      lineHeight: 16,
      textAlign: 'center',
    },
    appearanceCard: {
      marginHorizontal: 20,
      padding: 12,
      borderRadius: 18,
      backgroundColor: theme.surface,
      borderWidth: StyleSheet.hairlineWidth,
      borderColor: theme.borderStrong,
    },
    modeRow: {
      flexDirection: 'row',
      gap: 8,
    },
    modePill: {
      flex: 1,
      height: 34,
      borderRadius: 12,
      alignItems: 'center',
      justifyContent: 'center',
      backgroundColor: theme.surfaceAlt,
    },
    modePillActive: {
      backgroundColor: theme.accent,
    },
    modeText: {
      color: theme.textSecondary,
      fontSize: 12,
      fontWeight: '500',
    },
    modeTextActive: {
      color: theme.textOnAccent,
      fontWeight: '600',
    },
    accentRow: {
      marginTop: 12,
      paddingTop: 12,
      borderTopWidth: StyleSheet.hairlineWidth,
      borderTopColor: theme.border,
      flexDirection: 'row',
      alignItems: 'center',
    },
    accentSwatch: {
      width: 14,
      height: 14,
      borderRadius: 7,
      marginRight: 9,
    },
    moreCard: {
      marginHorizontal: 20,
      backgroundColor: theme.surface,
      borderRadius: 18,
      borderWidth: StyleSheet.hairlineWidth,
      borderColor: theme.borderStrong,
      overflow: 'hidden',
    },
    navRow: {
      minHeight: 50,
      paddingHorizontal: 14,
      flexDirection: 'row',
      alignItems: 'center',
    },
    rowLabel: {
      flex: 1,
      color: theme.textBody,
      fontSize: 13.5,
      lineHeight: 18,
      fontWeight: '500',
    },
    rowValue: {
      color: theme.textSecondary,
      fontSize: 11,
      marginRight: 2,
    },
    dangerRow: {
      marginHorizontal: 20,
      marginTop: 18,
      minHeight: 46,
      paddingHorizontal: 14,
      borderRadius: 14,
      alignItems: 'flex-start',
      justifyContent: 'center',
      borderWidth: StyleSheet.hairlineWidth,
      borderColor: theme.dangerBorder,
    },
    dangerText: {
      color: theme.danger,
      fontSize: 12.5,
      lineHeight: 17,
    },
    version: {
      marginTop: 20,
      color: theme.textMuted,
      fontSize: CHAT_TYPE.meta,
      lineHeight: 15,
      letterSpacing: 0.3,
      textAlign: 'center',
    },
    dock: {
      paddingHorizontal: 16,
      paddingTop: 10,
      paddingBottom: 8,
      flexDirection: 'row',
      alignItems: 'center',
      gap: 8,
      borderTopWidth: StyleSheet.hairlineWidth,
      borderTopColor: theme.hairline,
      backgroundColor: theme.background,
    },
    search: {
      flex: 1,
      height: 44,
      paddingHorizontal: 13,
      borderRadius: 22,
      backgroundColor: theme.surface,
      borderWidth: StyleSheet.hairlineWidth,
      borderColor: theme.borderStrong,
      flexDirection: 'row',
      alignItems: 'center',
      gap: 7,
    },
    searchGlyph: {
      color: theme.textMuted,
      fontSize: 16,
      lineHeight: 20,
    },
    searchInput: {
      flex: 1,
      color: theme.textBody,
      fontSize: 12,
      paddingVertical: 0,
    },
    searchClear: {
      color: theme.textMuted,
      fontSize: 12,
      lineHeight: 16,
      paddingHorizontal: 2,
    },
    dockButton: {
      width: 44,
      height: 44,
      borderRadius: 22,
      alignItems: 'center',
      justifyContent: 'center',
      backgroundColor: theme.surface,
      borderWidth: StyleSheet.hairlineWidth,
      borderColor: theme.borderStrong,
    },
    dockGlyph: {
      color: theme.textSecondary,
      fontSize: 17,
      lineHeight: 21,
    },
    newChatButton: {
      backgroundColor: theme.accent,
      borderColor: theme.accent,
      shadowColor: theme.accent,
      shadowOffset: { width: 0, height: 5 },
      shadowOpacity: theme.mode === 'dark' ? 0.3 : 0.22,
      shadowRadius: 10,
      elevation: 6,
    },
    newChatGlyph: {
      color: theme.textOnAccent,
      fontSize: 22,
      lineHeight: 26,
      fontWeight: '600',
    },
    dim: {
      opacity: 0.5,
    },
  });
