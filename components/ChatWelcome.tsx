import React, { useMemo } from 'react';
import { StyleSheet, Text, TouchableOpacity, View } from 'react-native';

import type { Theme } from '../theme';
import { APP_VERSION } from '../lib/constants';
import { withAlpha } from '../lib/utils';

// 新对话首屏：把原主页的编辑式排版收进聊天流，并换成和抽屉同一套材质：
// 暖白画布、白色圆角卡片、低对比描边和柔和阴影。
// 只保留真实入口，不伪造建议话题或最近消息。
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
        <View style={styles.seal}>
          <Spark styles={styles} />
        </View>

        <View style={styles.brandPill}>
          <Text style={styles.brandPillText}>BLUEBIRD · PRIVATE AGENT</Text>
        </View>

        <Text style={styles.title}>今天，想一起{'\n'}完成什么？</Text>

        <Text style={styles.lead}>
          Blue 会带着你的上下文，检索、思考，并把事情做完。
        </Text>
      </View>

      <View style={styles.actions}>
        <ActionCard
          theme={theme}
          styles={styles}
          glyph="↗"
          label="继续上次对话"
          hint={
            hasRecent ? `回到「${recentTitle}」` : '还没有可以继续的对话'
          }
          disabled={!hasRecent}
          onPress={onResumeRecent}
        />
        <ActionCard
          theme={theme}
          styles={styles}
          glyph="⌕"
          label="历史聊天"
          hint="查看、继续或管理过去的对话"
          onPress={onOpenHistory}
        />
        <ActionCard
          theme={theme}
          styles={styles}
          glyph="◈"
          label="记忆库"
          hint="看看 Blue 已经记住了什么"
          onPress={onOpenMemory}
        />
      </View>

      <View style={styles.footer}>
        <Text style={styles.footerText}>
          Bluebird {APP_VERSION} · 本机数据优先
        </Text>
      </View>
    </View>
  );
}

// 品牌火花：四根圆角短线绕中心旋转 45°，拼成八向星。
// 用 View 画而不是图片，才能随强调色变化、在任何分辨率下都清晰。
function Spark({ styles }: { styles: ReturnType<typeof createStyles> }) {
  return (
    <View style={styles.spark}>
      {[0, 45, 90, 135].map(angle => (
        <View
          key={angle}
          style={[styles.sparkRay, { transform: [{ rotate: `${angle}deg` }] }]}
        />
      ))}
    </View>
  );
}

function ActionCard({
  theme,
  styles,
  glyph,
  label,
  hint,
  disabled,
  onPress,
}: {
  theme: Theme;
  styles: ReturnType<typeof createStyles>;
  glyph: string;
  label: string;
  hint: string;
  disabled?: boolean;
  onPress: () => void;
}) {
  return (
    <TouchableOpacity
      style={[styles.actionCard, disabled && styles.actionDisabled]}
      onPress={onPress}
      disabled={disabled}
      activeOpacity={0.72}
      accessibilityRole="button"
      accessibilityLabel={label}
    >
      <View
        style={[
          styles.actionIcon,
          { backgroundColor: withAlpha(theme.accent, 0.13) },
        ]}
      >
        <Text style={styles.actionGlyph}>{glyph}</Text>
      </View>

      <View style={styles.actionMain}>
        <Text style={styles.actionLabel}>{label}</Text>
        <Text style={styles.actionHint} numberOfLines={1}>
          {hint}
        </Text>
      </View>

      <Text style={styles.chevron}>›</Text>
    </TouchableOpacity>
  );
}

const createStyles = (theme: Theme) =>
  StyleSheet.create({
    wrapper: {
      flex: 1,
      minHeight: 510,
      justifyContent: 'space-between',
      paddingTop: 22,
      paddingBottom: 10,
    },
    hero: {
      flex: 1,
      alignItems: 'center',
      justifyContent: 'center',
      paddingBottom: 24,
    },
    seal: {
      width: 88,
      height: 88,
      borderRadius: 44,
      alignItems: 'center',
      justifyContent: 'center',
      backgroundColor: theme.surface,
      borderWidth: StyleSheet.hairlineWidth,
      borderColor: theme.border,
      shadowColor: '#000',
      shadowOffset: { width: 0, height: 10 },
      shadowOpacity: theme.mode === 'dark' ? 0.4 : 0.08,
      shadowRadius: 20,
      elevation: 4,
    },
    spark: {
      width: 40,
      height: 40,
    },
    sparkRay: {
      position: 'absolute',
      top: 2,
      left: 18,
      width: 4,
      height: 36,
      borderRadius: 2,
      backgroundColor: theme.accent,
    },
    brandPill: {
      marginTop: 18,
      height: 27,
      paddingHorizontal: 12,
      borderRadius: 14,
      alignItems: 'center',
      justifyContent: 'center',
      backgroundColor: theme.surfaceAlt,
    },
    brandPillText: {
      color: theme.textMuted,
      fontSize: 9.5,
      lineHeight: 13,
      fontWeight: '600',
      letterSpacing: 1.2,
    },
    title: {
      maxWidth: 320,
      marginTop: 20,
      color: theme.chatText,
      fontSize: 34,
      lineHeight: 42,
      fontWeight: '600',
      letterSpacing: -1.1,
      textAlign: 'center',
    },
    lead: {
      maxWidth: 300,
      marginTop: 14,
      color: theme.textSecondary,
      fontSize: 14,
      lineHeight: 23,
      textAlign: 'center',
    },
    actions: {
      gap: 10,
    },
    actionCard: {
      minHeight: 64,
      paddingHorizontal: 14,
      paddingVertical: 10,
      borderRadius: 18,
      backgroundColor: theme.surface,
      borderWidth: StyleSheet.hairlineWidth,
      borderColor: theme.borderStrong,
      flexDirection: 'row',
      alignItems: 'center',
      shadowColor: '#000',
      shadowOffset: { width: 0, height: 7 },
      shadowOpacity: theme.mode === 'dark' ? 0.3 : 0.06,
      shadowRadius: 14,
      elevation: 2,
    },
    actionDisabled: {
      opacity: 0.5,
    },
    actionIcon: {
      width: 34,
      height: 34,
      borderRadius: 12,
      alignItems: 'center',
      justifyContent: 'center',
      marginRight: 12,
    },
    actionGlyph: {
      color: theme.accent,
      fontSize: 15,
      lineHeight: 19,
      fontWeight: '600',
    },
    actionMain: {
      flex: 1,
      minWidth: 0,
    },
    actionLabel: {
      color: theme.chatText,
      fontSize: 14,
      lineHeight: 19,
      fontWeight: '600',
    },
    actionHint: {
      marginTop: 3,
      color: theme.textMuted,
      fontSize: 10.5,
      lineHeight: 15,
    },
    chevron: {
      marginLeft: 8,
      color: theme.textMuted,
      fontSize: 17,
      lineHeight: 21,
    },
    footer: {
      marginTop: 18,
      alignItems: 'center',
    },
    footerText: {
      color: theme.textMuted,
      fontSize: 9,
      lineHeight: 13,
      letterSpacing: 0.3,
      textAlign: 'center',
    },
  });
