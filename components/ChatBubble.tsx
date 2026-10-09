import React, { useMemo } from 'react';
import { View, Text, TouchableOpacity, StyleSheet } from 'react-native';

import type { Theme } from '../theme';
import type { Message } from '../lib/types';
import {
  withAlpha,
  shouldShowMessageTime,
  formatMessageTime,
} from '../lib/utils';

// 单条消息气泡（纯展示）：时间标签 + 用户/Bluebird 两种气泡 + 重新发送 + 继续说。
// 所有交互通过回调上抛，组件内不持有任何状态（除样式 memo）。
export function ChatBubble({
  theme,
  item,
  previous,
  isLast,
  sending,
  continuing,
  onRecall,
  onRetry,
  onContinue,
}: {
  theme: Theme;
  item: Message;
  previous?: Message;
  isLast: boolean;
  sending: boolean;
  continuing: boolean;
  onRecall: (message: Message) => void;
  onRetry: (text?: string) => void;
  onContinue: () => void;
}) {
  const styles = useMemo(() => createStyles(theme), [theme]);

  const showTime = shouldShowMessageTime(item, previous);

  // 只有"最新一条且是 Bluebird 正常回复"时才显示续写按钮
  const showContinue =
    isLast && item.role === 'assistant' && !item.retryText && !sending;

  return (
    <View>
      {showTime && item.createdAt && (
        <Text style={styles.messageTime}>
          {formatMessageTime(item.createdAt)}
        </Text>
      )}

      <View
        style={[styles.messageRow, item.role === 'user' && styles.userRow]}
      >
        {item.role === 'user' ? (
          <TouchableOpacity
            // 底色交给 styles.userBubble：半透明材质需要 alpha，
            // 内联的 theme.bubble 是不透明 hex，会覆盖掉它
            style={[styles.bubble, styles.userBubble]}
            activeOpacity={0.75}
            onLongPress={() => onRecall(item)}
          >
            <Text style={[styles.messageText, styles.userMessageText]}>
              {item.content}
            </Text>
          </TouchableOpacity>
        ) : (
          // 气泡与「继续说」包在同一列里：列宽 = 气泡宽，按钮靠右即贴住气泡右边缘
          <View style={styles.assistantColumn}>
            <View style={[styles.bubble, styles.bluebirdBubble]}>
              <Text style={styles.messageText}>{item.content}</Text>

              {!!item.retryText && (
                <TouchableOpacity
                  style={[styles.retryButton, { backgroundColor: theme.bubble }]}
                  onPress={() => onRetry(item.retryText)}
                  disabled={sending}
                >
                  <Text style={styles.retryText}>重新发送</Text>
                </TouchableOpacity>
              )}
            </View>

            {showContinue && (
              <View style={styles.continueRow}>
                <TouchableOpacity
                  style={[
                    styles.continueButton,
                    { borderColor: theme.accentBorder },
                  ]}
                  onPress={onContinue}
                  disabled={continuing}
                  activeOpacity={0.6}
                >
                  <Text
                    style={[
                      styles.continueText,
                      {
                        color: continuing
                          ? theme.accentBorder
                          : theme.accent,
                      },
                    ]}
                  >
                    {continuing ? '···' : '→'}
                  </Text>
                </TouchableOpacity>
              </View>
            )}
          </View>
        )}
      </View>
    </View>
  );
}

// 样式由主题派生：只包含本组件用到的键
const createStyles = (theme: Theme) =>
  StyleSheet.create({
    messageTime: {
      alignSelf: 'center',
      color: theme.textMuted,
      fontSize: 12,
      marginBottom: 12,
      marginTop: 4,
      fontVariant: ['tabular-nums'],
    },
    messageRow: {
      flexDirection: 'row',
      alignItems: 'flex-end',
      marginBottom: 12,
    },
    userRow: {
      justifyContent: 'flex-end',
    },
    bubble: {
      paddingHorizontal: 14,
      paddingVertical: 10,
      borderRadius: 18,
    },
    // 对方消息：气泡与「继续说」同一列，列宽由气泡决定
    assistantColumn: {
      // 相对 messageRow（宽度确定），限制整列不超过 85%
      maxWidth: '85%',
      // 让气泡按内容收缩，而不是被拉伸到整列宽度
      alignItems: 'flex-start',
    },
    bluebirdBubble: {
      // 通透材质：半透明底（深色模式更透、浅色模式略实，保证文字对比度）
      backgroundColor: withAlpha(
        theme.bubbleIncoming,
        theme.mode === 'dark' ? 0.74 : 0.84
      ),
      borderWidth: 1,
      borderColor: theme.bubbleIncomingBorder,
      borderBottomLeftRadius: 6,
      // 光感：用强调色做柔和外发光，而不是黑色投影（避免"厚重阴影"）
      shadowColor: theme.accent,
      shadowOpacity: theme.mode === 'dark' ? 0.2 : 0.14,
      shadowRadius: 10,
      shadowOffset: { width: 0, height: 2 },
      elevation: 2,
    },
    userBubble: {
      // 78% 从共享的 bubble 挪到这里：用户气泡父级是 messageRow（宽度确定），百分比有效
      maxWidth: '78%',
      // 用户气泡更实体、更稳定：不透明度高于 Bluebird 气泡
      backgroundColor: withAlpha(theme.bubble, theme.mode === 'dark' ? 0.88 : 0.92),
      borderWidth: 1,
      // 细边缘高光：只用一条极淡的白边体现"材质边界"，不做强描边
      borderColor: 'rgba(255,255,255,0.14)',
      borderBottomRightRadius: 6,
      shadowColor: '#000',
      shadowOpacity: 0.14,
      shadowRadius: 6,
      shadowOffset: { width: 0, height: 2 },
      elevation: 1,
    },
    messageText: {
      color: theme.textBody,
      fontSize: 16,
      lineHeight: 23,
    },
    // 用户气泡是饱和底色，需要铺在其上的浅色文字
    userMessageText: {
      color: theme.textOnAccent,
    },
    // ---- 「继续说」按钮 ----
    continueRow: {
      flexDirection: 'row',
      // 撑满整列（列宽 = 气泡宽），内容靠右 → 按钮右边缘贴住气泡右边缘
      alignSelf: 'stretch',
      justifyContent: 'flex-end',
      // 与气泡下方留出间距（进同一列后原来的 -2 会压住气泡）
      marginTop: 6,
      marginBottom: 10,
    },
    continueButton: {
      paddingHorizontal: 10,
      paddingVertical: 3,
      borderRadius: 9,
      borderWidth: 1,
    },
    continueText: {
      fontSize: 12,
      fontWeight: '700',
      letterSpacing: 1,
    },
    retryButton: {
      marginTop: 9,
      alignSelf: 'flex-start',
      paddingHorizontal: 10,
      paddingVertical: 5,
      borderRadius: 8,
      backgroundColor: theme.bubble,
    },
    retryText: {
      color: theme.textOnAccent,
      fontSize: 13,
    },
  });