import React, { useEffect, useMemo, useRef, useState } from 'react';
import {
  View,
  Text,
  TouchableOpacity,
  FlatList,
  StyleSheet,
} from 'react-native';

import type { Theme } from '../theme';
import type { Message } from '../lib/types';
import { AT_BOTTOM_DISTANCE } from '../lib/constants';
import { withAlpha } from '../lib/utils';

import { BlueAvatar } from './BlueAvatar';
import { ChatBubble } from './ChatBubble';

// 消息列表（自治）：消息渲染 + 滚动定位 + 「返回底部」按钮 + 「正在输入」全部内聚在此。
// 滚动相关状态与 ref 完全闭环（外部输入只有 messages / loadingHistory），
// 因此无需向父级暴露任何 ref 或方法。
export function MessageList({
  theme,
  messages,
  loadingHistory,
  sending,
  continuing,
  onRecall,
  onRetry,
  onContinue,
}: {
  theme: Theme;
  messages: Message[];
  loadingHistory: boolean;
  sending: boolean;
  continuing: boolean;
  onRecall: (message: Message) => void;
  onRetry: (text?: string) => void;
  onContinue: () => void;
}) {
  const styles = useMemo(() => createStyles(theme), [theme]);

  const flatListRef = useRef<FlatList<Message>>(null);
  const isAtBottomRef = useRef(true);
  const hasInitialScrolledRef = useRef(false);
  const previousMessageCountRef = useRef(0);
  const pendingInitialScrollRef = useRef(false);

  // 「返回底部」悬浮按钮：仅在用户向上翻看历史时出现
  const [showScrollToBottom, setShowScrollToBottom] = useState(false);

  useEffect(() => {
    if (messages.length === 0) {
      previousMessageCountRef.current = 0;
      hasInitialScrolledRef.current = false;
      pendingInitialScrollRef.current = false;
      return;
    }

    if (!hasInitialScrolledRef.current) {
      pendingInitialScrollRef.current = true;
      previousMessageCountRef.current = messages.length;
      return;
    }

    if (
      messages.length > previousMessageCountRef.current &&
      isAtBottomRef.current
    ) {
      previousMessageCountRef.current = messages.length;

      requestAnimationFrame(() => {
        flatListRef.current?.scrollToEnd({ animated: true });
      });

      return;
    }

    previousMessageCountRef.current = messages.length;
  }, [messages.length, loadingHistory]);

  // 「返回底部」：平滑滚到底部，并立即隐藏按钮（后续 onScroll 会复核）
  const scrollToBottom = () => {
    isAtBottomRef.current = true;
    setShowScrollToBottom(false);

    flatListRef.current?.scrollToEnd({ animated: true });
  };

  return (
    <>
      <FlatList
        ref={flatListRef}
        data={messages}
        keyExtractor={item => item.id}
        onScroll={event => {
          const { contentOffset, contentSize, layoutMeasurement } =
            event.nativeEvent;

          const distanceFromBottom =
            contentSize.height - (contentOffset.y + layoutMeasurement.height);

          const atBottom = distanceFromBottom < AT_BOTTOM_DISTANCE;

          // 自动跟随的判断依据（ref，不触发渲染）
          isAtBottomRef.current = atBottom;

          // 按钮显隐与自动跟随互补：离开底部才显示。
          // 仅状态真正变化时才 setState，避免滚动过程中频繁渲染。
          const shouldShow = !atBottom;
          setShowScrollToBottom(prev =>
            prev === shouldShow ? prev : shouldShow
          );
        }}
        scrollEventThrottle={100}
        onContentSizeChange={() => {
          if (pendingInitialScrollRef.current && messages.length > 0) {
            pendingInitialScrollRef.current = false;
            hasInitialScrolledRef.current = true;

            requestAnimationFrame(() => {
              flatListRef.current?.scrollToEnd({ animated: false });
            });
          }
        }}
        contentContainerStyle={styles.messages}
        renderItem={({ item, index }) => (
          <ChatBubble
            theme={theme}
            item={item}
            previous={messages[index - 1]}
            isLast={index === messages.length - 1}
            sending={sending}
            continuing={continuing}
            onRecall={onRecall}
            onRetry={onRetry}
            onContinue={onContinue}
          />
        )}
        ListFooterComponent={
          sending ? (
            <View style={styles.typingRow}>
              <BlueAvatar theme={theme} />
              <View style={styles.typingBubble}>
                <Text style={styles.typingText}>Bluebird 正在输入…</Text>
              </View>
            </View>
          ) : null
        }
      />

      {showScrollToBottom && (
        <TouchableOpacity
          style={[
            styles.scrollToBottom,
            {
              backgroundColor: theme.surface,
              borderColor: theme.borderStrong,
            },
          ]}
          onPress={scrollToBottom}
          activeOpacity={0.75}
          accessibilityLabel="返回底部"
        >
          <Text style={[styles.scrollToBottomIcon, { color: theme.accent }]}>
            ↓
          </Text>
        </TouchableOpacity>
      )}
    </>
  );
}

// 样式由主题派生：只包含本组件用到的键
const createStyles = (theme: Theme) =>
  StyleSheet.create({
    messages: {
      padding: 16,
      // 让最后一条消息能滚出悬浮胶囊之外：胶囊高度 56 + 底部间距 8 + 余量 16
      paddingBottom: 80,
    },
    // ---- 「返回底部」悬浮按钮 ----
    scrollToBottom: {
      position: 'absolute',
      right: 16,
      // 输入区高度约 71，这里让按钮浮在它正上方，不遮挡输入框
      bottom: 84,
      width: 40,
      height: 40,
      borderRadius: 20,
      alignItems: 'center',
      justifyContent: 'center',
      borderWidth: 1,
      elevation: 3,
      zIndex: 50,
    },
    scrollToBottomIcon: {
      fontSize: 20,
      lineHeight: 24,
      fontWeight: '700',
    },
    typingRow: {
      flexDirection: 'row',
      alignItems: 'flex-end',
      marginBottom: 12,
    },
    typingBubble: {
      paddingHorizontal: 14,
      paddingVertical: 10,
      borderRadius: 18,
      borderBottomLeftRadius: 6,
      // 与 Bluebird 气泡同一材质，避免"正在输入"时出现一块实底造成割裂
      backgroundColor: withAlpha(
        theme.bubbleIncoming,
        theme.mode === 'dark' ? 0.74 : 0.84
      ),
      borderWidth: 1,
      borderColor: theme.bubbleIncomingBorder,
      shadowColor: theme.accent,
      shadowOpacity: theme.mode === 'dark' ? 0.2 : 0.14,
      shadowRadius: 10,
      shadowOffset: { width: 0, height: 2 },
      elevation: 2,
    },
    typingText: {
      color: theme.textMuted,
      fontSize: 14,
    },
  });