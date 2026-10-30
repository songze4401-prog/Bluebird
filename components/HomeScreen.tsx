import React, { useMemo } from 'react';
import {
  ScrollView,
  StyleSheet,
  Text,
  TouchableOpacity,
  View,
} from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import { APP_VERSION } from '../lib/constants';

// 固定品牌入口：深色、编辑式排版、只保留三个真实入口。
// 不展示假的历史/假的任务；会话列表仍由 App 的 /sessions 数据源负责。
export function HomeScreen({
  onContinue,
  onNewChat,
  onHistory,
  onOpenMenu,
  creatingChat,
}: {
  onContinue: () => void;
  onNewChat: () => void;
  onHistory: () => void;
  onOpenMenu?: () => void;
  creatingChat?: boolean;
}) {
  const styles = useMemo(() => createStyles(), []);
  const insets = useSafeAreaInsets();

  return (
    <View style={styles.container}>
      <ScrollView
        contentContainerStyle={[
          styles.content,
          {
            paddingTop: insets.top + 20,
            paddingBottom: insets.bottom + 28,
          },
        ]}
        showsVerticalScrollIndicator={false}
        bounces={false}
      >
        <View style={styles.header}>
          <View style={styles.headerLeft}>
            {onOpenMenu && (
              <TouchableOpacity
                onPress={onOpenMenu}
                style={styles.menu}
                hitSlop={8}
                accessibilityLabel="打开菜单"
              >
                <View style={styles.menuLine} />
                <View style={styles.menuLine} />
                <View style={styles.menuLine} />
              </TouchableOpacity>
            )}
            <Text style={styles.wordmark}>Bluebird</Text>
          </View>
          <Text style={styles.headerMeta}>PRIVATE AGENT</Text>
        </View>

        <View style={styles.hero}>
          <Text style={styles.eyebrow}>悄悄记住，认真完成</Text>
          <Text style={styles.title}>今天，想一起{'\n'}完成什么？</Text>
          <Text style={styles.lead}>
            Blue 会带着你的上下文，检索、思考，并把事情做完。
          </Text>
        </View>

        <View style={styles.actions}>
          <ActionRow
            styles={styles}
            label="继续聊天"
            hint="回到最近的对话"
            glyph="↗"
            onPress={onContinue}
          />
          <ActionRow
            styles={styles}
            label={creatingChat ? '正在新建…' : '新建聊天'}
            hint="从一个干净的上下文开始"
            glyph="＋"
            disabled={creatingChat}
            onPress={onNewChat}
          />
          <ActionRow
            styles={styles}
            label="历史聊天"
            hint="查看、继续或管理过去的对话"
            glyph="↗"
            onPress={onHistory}
          />
        </View>

        <View style={styles.footer}>
          <Text style={styles.footerText}>Bluebird {APP_VERSION}</Text>
          <Text style={styles.footerText}>本机数据优先</Text>
        </View>
      </ScrollView>
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
        <Text style={styles.actionHint}>{hint}</Text>
      </View>
      <Text style={styles.actionGlyph}>{glyph}</Text>
    </TouchableOpacity>
  );
}

const createStyles = () =>
  StyleSheet.create({
    container: {
      flex: 1,
      backgroundColor: '#08090b',
    },
    content: {
      flexGrow: 1,
      paddingHorizontal: 20,
    },
    header: {
      height: 52,
      flexDirection: 'row',
      alignItems: 'center',
      justifyContent: 'space-between',
    },
    headerLeft: {
      flexDirection: 'row',
      alignItems: 'center',
      gap: 12,
    },
    menu: {
      width: 22,
      height: 28,
      justifyContent: 'center',
      gap: 4,
    },
    menuLine: {
      height: 1.5,
      borderRadius: 1,
      backgroundColor: '#a3a8b2',
    },
    wordmark: {
      color: '#f2f3f5',
      fontSize: 16,
      lineHeight: 21,
      fontWeight: '600',
      letterSpacing: 0.1,
    },
    headerMeta: {
      color: '#4a505a',
      fontSize: 9,
      lineHeight: 13,
      fontWeight: '600',
      letterSpacing: 1.3,
    },
    hero: {
      flex: 1,
      justifyContent: 'center',
      paddingBottom: 30,
    },
    eyebrow: {
      color: '#6c727d',
      fontSize: 10,
      lineHeight: 14,
      letterSpacing: 1,
      marginBottom: 14,
    },
    title: {
      maxWidth: 300,
      color: '#f2f3f5',
      fontSize: 34,
      lineHeight: 42,
      fontWeight: '600',
      letterSpacing: -1.1,
    },
    lead: {
      maxWidth: 290,
      marginTop: 16,
      color: '#a3a8b2',
      fontSize: 14,
      lineHeight: 23,
    },
    actions: {
      borderTopWidth: StyleSheet.hairlineWidth,
      borderTopColor: 'rgba(255,255,255,0.065)',
    },
    action: {
      minHeight: 66,
      flexDirection: 'row',
      alignItems: 'center',
      borderBottomWidth: StyleSheet.hairlineWidth,
      borderBottomColor: 'rgba(255,255,255,0.065)',
    },
    actionDisabled: {
      opacity: 0.45,
    },
    actionMain: {
      flex: 1,
      gap: 4,
    },
    actionLabel: {
      color: '#f2f3f5',
      fontSize: 15,
      lineHeight: 21,
      fontWeight: '500',
    },
    actionHint: {
      color: '#4a505a',
      fontSize: 11,
      lineHeight: 16,
    },
    actionGlyph: {
      color: '#7e9bff',
      fontSize: 17,
      lineHeight: 22,
    },
    footer: {
      marginTop: 28,
      flexDirection: 'row',
      justifyContent: 'space-between',
    },
    footerText: {
      color: '#4a505a',
      fontSize: 9,
      lineHeight: 13,
      letterSpacing: 0.3,
    },
  });
