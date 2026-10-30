import React, { useMemo } from 'react';
import { StyleSheet, Text, TouchableOpacity, View } from 'react-native';

import type { Theme } from '../theme';
import { APP_VERSION } from '../lib/constants';

// 新对话首屏：沿用原主页的编辑式排版，直接长在聊天流里。
// 不再有独立「主页」路由，进入应用即是新对话；这里只放真实的继续/历史/记忆入口，
// 不伪造建议话题，也不展示假的最近消息。
export function ChatWelcome({
  theme,
  recentTitle,
  onResumeRecent,
  onOpenHistory,
  onOpenMemory,
}: {
  theme: Theme;
  recentTitle?: string;
  onResumeRecent: () => void;
  onOpenHistory: () => void;
  onOpenMemory: () => void;
}) {
  const styles = useMemo(() => createStyles(theme), [theme]);
  const hasRecent = !!recentTitle;

  return (
    <View style={styles.wrapper}>
      <View style={styles.hero}>
        <View style={styles.eyebrowRow}>
          <View style={styles.eyebrowDot} />
          <Text style={styles.eyebrow}>BLUEBIRD · PRIVATE AGENT</Text>
        </View>

        <Text style={styles.title}>今天，想一起{'\n'}完成什么？</Text>

        <Text style={styles.lead}>
          Blue 会带着你的上下文，检索、思考，并把事情做完。
        </Text>
      </View>

      <View style={styles.actions}>
        <ActionRow
          styles={styles}
          label="继续上次对话"
          hint={
            hasRecent ? `回到「${recentTitle}」` : '还没有可以继续的对话'
          }
          glyph="↗"
          disabled={!hasRecent}
          onPress={onResumeRecent}
        />
        <ActionRow
          styles={styles}
          label="历史聊天"
          hint="查看、继续或管理过去的对话"
          glyph="↗"
          onPress={onOpenHistory}
        />
        <ActionRow
          styles={styles}
          label="记忆库"
          hint="看看 Blue 已经记住了什么"
          glyph="↗"
          onPress={onOpenMemory}
        />
      </View>

      <View style={styles.footer}>
        <Text style={styles.footerText}>Bluebird {APP_VERSION}</Text>
        <Text style={styles.footerText}>本机数据优先</Text>
      </View>
    </View>
  );
}

function ActionRow({
  styles,
  label,
  hint,
  glyph,
  disabled,
  onPress,
}: {
  styles: ReturnType<typeof createStyles>;
  label: string;
  hint: string;
  glyph: string;
  disabled?: boolean;
  onPress: () => void;
}) {
  return (
    <TouchableOpacity
      style={[styles.action, disabled && styles.actionDisabled]}
      onPress={onPress}
      disabled={disabled}
      activeOpacity={0.65}
      accessibilityRole="button"
      accessibilityLabel={label}
    >
      <View style={styles.actionMain}>
        <Text style={styles.actionLabel}>{label}</Text>
        <Text style={styles.actionHint} numberOfLines={1}>
          {hint}
        </Text>
      </View>
      <Text style={styles.actionGlyph}>{glyph}</Text>
    </TouchableOpacity>
  );
}

const createStyles = (theme: Theme) =>
  StyleSheet.create({
    wrapper: {
      flex: 1,
      minHeight: 430,
      justifyContent: 'space-between',
      paddingTop: 12,
      paddingBottom: 10,
    },
    hero: {
      flex: 1,
      justifyContent: 'center',
      paddingBottom: 28,
    },
    eyebrowRow: {
      flexDirection: 'row',
      alignItems: 'center',
      gap: 7,
      marginBottom: 15,
    },
    eyebrowDot: {
      width: 5,
      height: 5,
      borderRadius: 3,
      backgroundColor: theme.accent,
    },
    eyebrow: {
      color: theme.textMuted,
      fontSize: 10,
      lineHeight: 14,
      fontWeight: '600',
      letterSpacing: 1.2,
    },
    title: {
      maxWidth: 310,
      color: theme.chatText,
      fontSize: 34,
      lineHeight: 42,
      fontWeight: '600',
      letterSpacing: -1.1,
    },
    lead: {
      maxWidth: 300,
      marginTop: 16,
      color: theme.textSecondary,
      fontSize: 14,
      lineHeight: 23,
    },
    actions: {
      borderTopWidth: StyleSheet.hairlineWidth,
      borderTopColor: theme.hairline,
    },
    action: {
      minHeight: 64,
      flexDirection: 'row',
      alignItems: 'center',
      borderBottomWidth: StyleSheet.hairlineWidth,
      borderBottomColor: theme.hairline,
    },
    actionDisabled: {
      opacity: 0.42,
    },
    actionMain: {
      flex: 1,
      gap: 4,
      paddingRight: 12,
    },
    actionLabel: {
      color: theme.chatText,
      fontSize: 15,
      lineHeight: 21,
      fontWeight: '500',
    },
    actionHint: {
      color: theme.textMuted,
      fontSize: 11,
      lineHeight: 16,
    },
    actionGlyph: {
      color: theme.accent,
      fontSize: 17,
      lineHeight: 22,
    },
    footer: {
      marginTop: 24,
      flexDirection: 'row',
      justifyContent: 'space-between',
    },
    footerText: {
      color: theme.textMuted,
      fontSize: 9,
      lineHeight: 13,
      letterSpacing: 0.3,
    },
  });
