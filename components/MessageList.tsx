import React, {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from 'react';
import {
  View,
  Text,
  TouchableOpacity,
  FlatList,
  StyleSheet,
} from 'react-native';

import type { Theme } from '../theme';
import type { Attachment, Message } from '../lib/types';
import { AT_BOTTOM_DISTANCE, FOLLOW_RESUME_DISTANCE } from '../lib/constants';
import { withAlpha } from '../lib/utils';

import { BlueAvatar } from './BlueAvatar';
import { ChatBubble } from './ChatBubble';

// 自动跟随的三态状态机（放在 ref 里：只影响「要不要滚」，不参与渲染）。
// - follow：贴底跟随，新消息到达即滚到底
// - locked：用户正在阅读历史，一律不自动滚
// - batch ：向上分页载入更早历史期间，一律不自动滚；载入完成后转 locked，不回 follow
type AutoScrollState = 'follow' | 'locked' | 'batch';

// 流式气泡 id 形如 `${tempId}#${index}`，tempId 由 App 侧生成、固定以 stream- 开头。
// 同一轮流式回复切出的所有气泡共享同一个「块根」，据此把
// 「同一轮的内容增量」与「真正的新消息」区分开。
const STREAM_ID_PREFIX = 'stream-';

function streamRootOf(id: string): string | null {
  if (!id.startsWith(STREAM_ID_PREFIX)) return null;

  const hash = id.indexOf('#');

  return hash > 0 ? id.slice(0, hash) : id;
}

type ScrollMetricsEvent = {
  nativeEvent: {
    contentOffset: { y: number };
    contentSize: { height: number };
    layoutMeasurement: { height: number };
  };
};

// 消息列表（自治）：消息渲染 + 滚动定位 + 「返回底部」按钮 + 「正在输入」全部内聚在此。
// 滚动相关状态与 ref 完全闭环（外部输入只有 messages / sessionId / loadingHistory），
// 因此无需向父级暴露任何 ref 或方法。
export function MessageList({
  theme,
  messages,
  sessionId,
  loadingHistory,
  sending,
  continuing,
  onRecall,
  onRetry,
  onContinue,
}: {
  theme: Theme;
  messages: Message[];
  /** 当前会话 id：变化即视为「切换会话」→ 置 follow 并贴底一次 */
  sessionId: string;
  /** 真·批载锁：载入期间禁止任何自动滚；分页载入结束后停在 locked */
  loadingHistory: boolean;
  sending: boolean;
  continuing: boolean;
  onRecall: (message: Message) => void;
  onRetry: (text?: string, attachments?: Attachment[]) => void;
  onContinue: () => void;
}) {
  const styles = useMemo(() => createStyles(theme), [theme]);

  const flatListRef = useRef<FlatList<Message>>(null);

  // 三态状态机：进入会话默认 follow
  const autoScrollState = useRef<AutoScrollState>('follow');

  // 最新消息的镜像：效应里读它不必把 messages 挂进依赖。
  // 用「首个效应」同步而不是渲染期赋值，避免并发渲染下读到未提交的值。
  const messagesRef = useRef(messages);

  useEffect(() => {
    messagesRef.current = messages;
  });

  // 锁定期累计到达的新消息条数（>0 时底部显示「N 条新消息」）
  const [pendingNewCount, setPendingNewCount] = useState(0);

  // 「返回底部」箭头：只由距底距离（AT_BOTTOM_DISTANCE = 80）决定
  const [showScrollToBottom, setShowScrollToBottom] = useState(false);

  // 上一轮的消息条数与流式块根，用来判定「是否真的追加了新消息」
  const prevCountRef = useRef(messages.length);
  const lastStreamRootRef = useRef<string | null>(
    messages.length ? streamRootOf(messages[messages.length - 1].id) : null
  );

  // 会话切换：历史可能已先一步到位，也可能随后才到，两种都要贴底一次
  const prevSessionRef = useRef(sessionId);
  const sessionScrollPendingRef = useRef(false);

  // 进入 batch 时的消息条数：区分「向上分页」（已有消息）与「首屏载入」（无消息）
  const batchStartCountRef = useRef(0);

  // 最近一次贴底所对应的消息数组：首屏「历史先到、会话 id 后到」会让
  // 消息效应与切会话效应在同一批内容上各滚一次，用它去重。
  const lastScrolledMessagesRef = useRef<Message[] | null>(null);

  // 内容尺寸通道：只跟「变高」，且只跟 follow 态（见 handleContentSizeChange）
  const lastContentHeightRef = useRef(0);
  const contentScrollTimerRef = useRef<ReturnType<typeof setTimeout> | null>(
    null
  );

  // 唯一允许的自动贴底入口。调用方只有四处：
  // 新消息追加、切换会话、内容变高（仅 follow 态）、用户主动要求（箭头 / 新消息提示）。
  const scrollToEndOnce = useCallback((animated: boolean) => {
    lastScrolledMessagesRef.current = messagesRef.current;

    flatListRef.current?.scrollToEnd({ animated });
  }, []);

  // 内容变高的跟随通道：流式增量、流式收尾渲染撑高、图片消息都靠它跟住。
  // 第一道闸就是状态机 —— locked / batch 直接返回，不会把正在翻历史的用户拽回底部；
  // 只有 follow（用户就在底部）才允许跟随。
  const handleContentSizeChange = useCallback(
    (_width: number, height: number) => {
      const prevHeight = lastContentHeightRef.current;

      lastContentHeightRef.current = height;

      if (autoScrollState.current !== 'follow') return;
      // 只跟变高：footer 隐藏、键盘收起导致的变小不触发，避免上跳
      if (height <= prevHeight) return;
      // 节流：避免流式逐 token 贴底堆积滚动
      if (contentScrollTimerRef.current !== null) return;

      contentScrollTimerRef.current = setTimeout(() => {
        contentScrollTimerRef.current = null;

        // 定时器触发前用户可能已开始拖动（状态已转 locked），必须再确认一次
        if (autoScrollState.current !== 'follow') return;

        scrollToEndOnce(false);
      }, 100);
    },
    [scrollToEndOnce]
  );

  // 卸载时清理内容尺寸通道的节流定时器
  useEffect(
    () => () => {
      if (contentScrollTimerRef.current !== null) {
        clearTimeout(contentScrollTimerRef.current);
        contentScrollTimerRef.current = null;
      }
    },
    []
  );

  // 1) 切换会话 → 置 follow、清空未读、贴底一次
  useEffect(() => {
    if (prevSessionRef.current === sessionId) return;

    prevSessionRef.current = sessionId;

    autoScrollState.current = 'follow';
    setPendingNewCount(0);
    setShowScrollToBottom(false);

    const current = messagesRef.current;

    prevCountRef.current = current.length;
    lastStreamRootRef.current = current.length
      ? streamRootOf(current[current.length - 1].id)
      : null;

    if (current.length > 0) {
      // 新会话的历史已在上一轮渲染到位：直接贴底。
      // 若这批内容刚刚被消息效应贴过底（首屏的常见路径），则不重复滚。
      if (lastScrolledMessagesRef.current !== current) scrollToEndOnce(false);
    } else {
      // 历史还没到：等它到达时由下面的「消息变化」效应贴底
      sessionScrollPendingRef.current = true;
    }
  }, [sessionId, scrollToEndOnce]);

  // 2) 消息变化 → 只认「新消息追加」；内容撑高走 onContentSizeChange（仅 follow 态）
  useEffect(() => {
    const prevCount = prevCountRef.current;
    const nextCount = messages.length;
    const last = nextCount > 0 ? messages[nextCount - 1] : undefined;
    const root = last ? streamRootOf(last.id) : null;
    const prevRoot = lastStreamRootRef.current;

    lastStreamRootRef.current = root;

    // 2a) 切换会话后历史才到：补上那一次贴底
    if (sessionScrollPendingRef.current) {
      sessionScrollPendingRef.current = false;
      prevCountRef.current = nextCount;

      if (nextCount > 0) scrollToEndOnce(false);

      return;
    }

    // 2b) 分页批载期间：不滚、不计数（向上插入的更早消息不是「新消息」）
    if (autoScrollState.current === 'batch') {
      prevCountRef.current = nextCount;

      return;
    }

    // 2c) 被清空（清空历史 / 删除当前会话）→ 复位为 follow
    if (nextCount === 0) {
      prevCountRef.current = 0;

      if (prevCount !== 0) {
        autoScrollState.current = 'follow';
        setPendingNewCount(0);
        setShowScrollToBottom(false);
      }

      return;
    }

    // 2d) 同一轮流式回复的内容增量 / 追加分段：一律不滚、不计数
    if (root !== null && root === prevRoot) {
      prevCountRef.current = nextCount;

      return;
    }

    // 非追加（等长替换、变短）不产生滚动
    if (nextCount <= prevCount) {
      prevCountRef.current = nextCount;

      return;
    }

    // 2e) 真正的新消息
    prevCountRef.current = nextCount;

    if (autoScrollState.current === 'follow') {
      scrollToEndOnce(false);

      return;
    }

    // 锁定期：不滚动，只累计提示数。
    // 新的一轮流式回复按「1 条」计，避免逐 delta 把数字刷爆。
    const appended = nextCount - prevCount;
    setPendingNewCount(count => count + (root !== null ? 1 : appended));
  }, [messages, scrollToEndOnce]);

  // 3) loadingHistory 是真正的批载锁。
  //    载入开始时已展示着消息 → 说明是「向上分页加载更早历史」→ batch；
  //    载入结束时从 batch 转 locked（停在用户当前阅读位置，不回 follow）。
  //    首屏 / 切会话载入时消息为 0，不抢会话切换逻辑的 follow。
  useEffect(() => {
    if (loadingHistory) {
      batchStartCountRef.current = messagesRef.current.length;

      if (batchStartCountRef.current > 0) {
        autoScrollState.current = 'batch';
      }

      return;
    }

    if (autoScrollState.current === 'batch' && batchStartCountRef.current > 0) {
      autoScrollState.current = 'locked';
    }

    batchStartCountRef.current = 0;
  }, [loadingHistory]);

  // 用户按下拖动：立刻置 locked
  const handleScrollBeginDrag = useCallback(() => {
    autoScrollState.current = 'locked';
  }, []);

  // 滚动中「只读不写」：无论离底多近，都不得把 locked 改回 follow。
  // 这里的 80 只决定箭头显不显示。
  const handleScroll = useCallback((event: ScrollMetricsEvent) => {
    const { contentOffset, contentSize, layoutMeasurement } = event.nativeEvent;

    const distanceFromBottom =
      contentSize.height - (contentOffset.y + layoutMeasurement.height);

    const shouldShow = distanceFromBottom >= AT_BOTTOM_DISTANCE;

    setShowScrollToBottom(prev => (prev === shouldShow ? prev : shouldShow));
  }, []);

  // 拖拽结束 / 惯性结束：唯一能「自己滚回底部」解除锁定的地方（阈值 20）。
  // batch 期间不解除 —— 分页完成后必须停在 locked。
  const handleScrollSettled = useCallback((event: ScrollMetricsEvent) => {
    if (autoScrollState.current !== 'locked') return;

    const { contentOffset, contentSize, layoutMeasurement } = event.nativeEvent;

    const distanceFromBottom =
      contentSize.height - (contentOffset.y + layoutMeasurement.height);

    if (distanceFromBottom > FOLLOW_RESUME_DISTANCE) return;

    autoScrollState.current = 'follow';
    setPendingNewCount(0);
  }, []);

  // 用户主动回到底部（箭头 / 新消息提示）→ 滚到底并解锁
  const scrollToBottom = useCallback(() => {
    autoScrollState.current = 'follow';
    setPendingNewCount(0);
    setShowScrollToBottom(false);

    scrollToEndOnce(true);
  }, [scrollToEndOnce]);

  const badgeText =
    pendingNewCount > 99 ? '99+ 条新消息' : `${pendingNewCount} 条新消息`;

  return (
    <>
      <FlatList
        ref={flatListRef}
        data={messages}
        keyExtractor={item => item.id}
        // 只有用户主动拖拽才进入 locked；滚动事件本身不再改写状态机
        onScrollBeginDrag={handleScrollBeginDrag}
        onScroll={handleScroll}
        // 内容变高时仅 follow 态跟随（流式增量 / 图片 / footer 撑高）
        onContentSizeChange={handleContentSizeChange}
        // 解除锁定只有两条路：用户自己滚回底部（下面两个回调），
        // 或点右下角箭头 / 新消息提示（scrollToBottom）
        onScrollEndDrag={handleScrollSettled}
        onMomentumScrollEnd={handleScrollSettled}
        scrollEventThrottle={100}
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
          ) : undefined
        }
      />

      {/* 锁定期有新消息：底部提示，点击才滚到底并解锁 */}
      {pendingNewCount > 0 && (
        <TouchableOpacity
          style={[
            styles.newMessagesPill,
            {
              backgroundColor: theme.surface,
              borderColor: theme.borderStrong,
            },
          ]}
          onPress={scrollToBottom}
          activeOpacity={0.75}
          accessibilityLabel={`${badgeText}，点击查看`}
        >
          <Text style={[styles.newMessagesText, { color: theme.accent }]}>
            {badgeText} ↓
          </Text>
        </TouchableOpacity>
      )}

      {(showScrollToBottom || pendingNewCount > 0) && (
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
    // ---- 「N 条新消息」提示：与箭头同一行，排在箭头左侧，不重叠 ----
    newMessagesPill: {
      position: 'absolute',
      right: 64,
      bottom: 84,
      height: 40,
      paddingHorizontal: 14,
      borderRadius: 20,
      alignItems: 'center',
      justifyContent: 'center',
      borderWidth: 1,
      elevation: 3,
      zIndex: 50,
    },
    newMessagesText: {
      fontSize: 13,
      fontWeight: '600',
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
