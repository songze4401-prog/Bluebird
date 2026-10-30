import React, { useMemo, useState } from 'react';
import {
  View,
  Text,
  TouchableOpacity,
  Pressable,
  StyleSheet,
  Image as RNImage,
} from 'react-native';
import { Image } from 'expo-image';

import type { Theme } from '../theme';
import type { Attachment, ContentSegment, Message } from '../lib/types';
import {
  IMAGE_AUTH_HEADERS,
  imageUrl,
  stickerImageUrl,
} from '../lib/uploads';
import { formatMessageTime, parseStickerMarkers } from '../lib/utils';
import { CHAT_LAYOUT, CHAT_TYPE } from '../lib/design';
import { AgentRunBlock } from './AgentRunBlock';
import { MarkdownMessage } from './MarkdownMessage';

// 附件（图片 / 表情包）：渲染在正文上方，经服务端鉴权路由读取真实图片。
function BubbleAttachments({
  attachments,
  styles,
  alignEnd,
}: {
  attachments: Attachment[];
  styles: ReturnType<typeof createStyles>;
  alignEnd?: boolean;
}) {
  return (
    <View style={[styles.attachmentStack, alignEnd && styles.attachmentEnd]}>
      {attachments.map(att =>
        att.expired ? (
          // 仓库条目已被物理删除（GET /history 标注）：图片不可达，显示占位
          <View
            key={att.id}
            style={[styles.stickerImage, styles.stickerExpired]}
          >
            <Text style={styles.stickerExpiredText}>表情已删除</Text>
          </View>
        ) : (
          <Image
            key={att.id}
            source={{
              // 表情包存仓库（物理删除后不可达），聊天图片走 uploads 临时附件
              uri:
                att.kind === 'sticker'
                  ? stickerImageUrl(att.id)
                  : imageUrl(att.id),
              headers: IMAGE_AUTH_HEADERS,
            }}
            style={
              att.kind === 'sticker'
                ? styles.stickerImage
                : styles.attachmentImage
            }
            contentFit={att.kind === 'sticker' ? 'contain' : 'cover'}
            transition={120}
            accessibilityLabel={att.name || '图片'}
          />
        )
      )}
    </View>
  );
}

// 正文里的表情包标记（[sticker:ID]）渲染为行内图片：
// 图片走现有的表情包仓库路由 /sticker-repo/:id/image，不另造路径。
// 请求失败或 410（仓库条目已删）时显示灰色「表情包已失效」，
// 绝不把原始标记退回成文字（BUG-03）。
function InlineSticker({
  id,
  valid,
  styles,
}: {
  id: string;
  valid: boolean;
  styles: ReturnType<typeof createStyles>;
}) {
  const [failed, setFailed] = useState(!valid);

  if (failed) {
    return <Text style={styles.inlineStickerExpired}>表情包已失效</Text>;
  }

  return (
    <RNImage
      source={{ uri: stickerImageUrl(id), headers: IMAGE_AUTH_HEADERS }}
      style={styles.inlineSticker}
      onError={() => setFailed(true)}
      accessibilityLabel="表情包"
    />
  );
}

// Bluebird 正文：直接渲染数据层切好的片段（消息进入 state 前已解析）。
// segments 缺失只可能来自绕过数据层的调用，此时才退回一次解析（不会闪）。
function AssistantContent({
  content,
  segments,
  styles,
}: {
  content: string;
  segments?: ContentSegment[];
  styles: ReturnType<typeof createStyles>;
}) {
  const resolved = segments ?? parseStickerMarkers(content);

  return (
    <Text style={styles.text}>
      {resolved.map((segment, index) =>
        segment.type === 'text' ? (
          <Text key={`text-${index}`}>{segment.text}</Text>
        ) : (
          <InlineSticker
            key={`sticker-${index}`}
            id={segment.id}
            valid={segment.valid}
            styles={styles}
          />
        )
      )}
    </Text>
  );
}

// 单条消息（设计图 ui6 的无气泡排版）：
//   用户 → 右对齐「时间戳 / 正文」两行；
//   助手 → 左对齐 who-line（Bluebird + 心情表情 + 时间戳）、可选工具 pill、正文。
// 没有任何气泡底、描边与阴影：整页只有文字与灰底 pill，这是设计图的核心差别。
// 纯展示组件：交互全部通过回调上抛。
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
  onOpenActions,
  isFavorite = false,
}: {
  theme: Theme;
  item: Message;
  previous?: Message;
  isLast: boolean;
  sending: boolean;
  continuing: boolean;
  onRecall: (message: Message) => void;
  onRetry: (text?: string, attachments?: Attachment[]) => void;
  onContinue: () => void;
  onOpenActions?: (message: Message) => void;
  isFavorite?: boolean;
}) {
  const styles = useMemo(() => createStyles(theme), [theme]);

  const isUser = item.role === 'user';

  // 同一轮流式/分条的助手续接用较小的空档（设计图 .msg.same），
  // 换轮次（用户↔助手）才用大空档
  const isContinuation = !isUser && previous?.role === 'assistant';

  // 只有「最新一条且是 Bluebird 正常回复」时才显示续写入口
  const showContinue =
    isLast && !isUser && !item.retryText && !sending;

  const timeText = item.createdAt
    ? formatMessageTime(item.createdAt, true)
    : '';

  return (
    <View
      // 单测靠它取到这一行的实际间距（版式规则见 lib/design 的 turnGap/sameGap）
      testID="chat-row"
      style={[
        styles.row,
        isUser && styles.rowEnd,
        { marginTop: isContinuation ? CHAT_LAYOUT.sameGap : CHAT_LAYOUT.turnGap },
      ]}
    >
      {isUser ? (
        <TouchableOpacity
          style={styles.userColumn}
          activeOpacity={1}
          onLongPress={() => (onOpenActions ? onOpenActions(item) : onRecall(item))}
          accessibilityLabel="长按打开消息操作"
        >
          <View style={styles.userMeta}>
            {isFavorite && <Text style={styles.favoriteStar}>★</Text>}
            {!!timeText && <Text style={styles.time}>{timeText}</Text>}
          </View>

          {!!item.attachments?.length && (
            <BubbleAttachments
              attachments={item.attachments}
              styles={styles}
              alignEnd
            />
          )}

          {!!item.content && (
            <Text style={[styles.text, styles.textAfterTs]}>{item.content}</Text>
          )}
        </TouchableOpacity>
      ) : (
        <Pressable
          style={styles.assistantColumn}
          onLongPress={() => onOpenActions?.(item)}
          delayLongPress={350}
          accessibilityLabel="长按打开消息操作"
        >
          {/* who-line：名字用强调色，表情是当前心情，时间是这条自己的时间戳 */}
          <View style={styles.whoLine}>
            <View style={styles.whoDot} />
            <Text style={styles.name}>BLUE</Text>

            {isFavorite && <Text style={styles.favoriteStar}>★</Text>}
            {!!timeText && <Text style={styles.time}>{timeText}</Text>}
          </View>

          {!!item.toolSteps?.length && (
            <AgentRunBlock theme={theme} steps={item.toolSteps} />
          )}

          {!!item.attachments?.length && (
            <BubbleAttachments attachments={item.attachments} styles={styles} />
          )}

          {!!item.content &&
            (item.segments?.some(segment => segment.type === 'sticker') ||
            (!item.segments && /\[sticker:[^\]]+\]/.test(item.content)) ? (
              <AssistantContent
                content={item.content}
                segments={item.segments}
                styles={styles}
              />
            ) : (
              <MarkdownMessage content={item.content} theme={theme} />
            ))}

          {/* 图片触发了视觉能力路由：如实说明实际使用的模型（后端结果） */}
          {!!item.stopped && (
            <Text style={styles.stoppedNote}>已停止生成 · 本机保留的部分回复</Text>
          )}

          {!!item.modelNote && (
            <Text style={styles.modelNote}>{item.modelNote}</Text>
          )}

          {/* 新图触发了 Agent 工具互斥：提示用户本次工具不可用 */}
          {!!item.agentNotice && (
            <Text style={styles.modelNote}>{item.agentNotice}</Text>
          )}

          {!!item.retryText && (
            <TouchableOpacity
              style={styles.retryButton}
              onPress={() => onRetry(item.retryText, item.retryAttachments)}
              disabled={sending}
              activeOpacity={0.7}
            >
              <Text style={styles.retryText}>重新发送</Text>
            </TouchableOpacity>
          )}

          {showContinue && (
            // 设计图 .acts：正文下方的图标操作行。
            // 这里只放真实存在的动作：撤回仅支持用户消息（后端 recall 只认
            // role=user），所以助手侧只有「继续说」。
            <View style={styles.actsRow}>
              <TouchableOpacity
                style={styles.actButton}
                onPress={onContinue}
                disabled={continuing}
                activeOpacity={0.6}
                accessibilityLabel="继续说"
              >
                <Text style={styles.actIcon}>{continuing ? '···' : '→'}</Text>
              </TouchableOpacity>
            </View>
          )}
        </Pressable>
      )}
    </View>
  );
}

// 样式由主题派生：只包含本组件用到的键
const createStyles = (theme: Theme) =>
  StyleSheet.create({
    row: {
      flexDirection: 'row',
    },
    rowEnd: {
      justifyContent: 'flex-end',
    },
    // 定宽 86%：流式正文持续变长，宽度恒定可避免整块内容左右抖
    userColumn: {
      width: '86%',
      alignItems: 'flex-end',
    },
    assistantColumn: {
      width: '100%',
      alignItems: 'flex-start',
    },
    whoLine: {
      flexDirection: 'row',
      alignItems: 'center',
    },
    userMeta: {
      flexDirection: 'row',
      alignItems: 'center',
      gap: 5,
    },
    favoriteStar: {
      color: theme.accent,
      fontSize: 10,
      lineHeight: 14,
    },
    whoDot: {
      width: 5,
      height: 5,
      borderRadius: 3,
      backgroundColor: theme.accent,
      marginRight: 6,
      opacity: 0.85,
    },
    name: {
      color: theme.textSecondary,
      fontSize: 11,
      fontWeight: '600',
      letterSpacing: 0.8,
      marginRight: 8,
    },
    time: {
      color: theme.chatMuted,
      fontSize: CHAT_TYPE.meta,
      fontVariant: ['tabular-nums'],
      // who-line 里的时间与名字基线对齐；单独成行时由 tsToText 控制下方间距
      marginBottom: 0,
    },
    text: {
      color: theme.chatText,
      fontSize: CHAT_TYPE.body,
      lineHeight: CHAT_TYPE.bodyLine,
      marginTop: CHAT_LAYOUT.nameToText,
    },
    // 用户消息是「时间戳 → 正文」，实测间距 12dp（助手是 who-line → 正文 10dp）
    textAfterTs: {
      marginTop: CHAT_LAYOUT.tsToText,
    },
    stoppedNote: {
      color: theme.textMuted,
      fontSize: 11,
      lineHeight: 16,
      marginTop: 7,
    },
    // 模型路由提示：弱化的小字，附在正文下方，不参与正文排版
    modelNote: {
      color: theme.chatMuted,
      fontSize: 11,
      lineHeight: 16,
      marginTop: 6,
    },
    // ---- 附件 ----
    attachmentStack: {
      gap: 8,
      marginTop: CHAT_LAYOUT.nameToText,
    },
    attachmentEnd: {
      alignItems: 'flex-end',
    },
    attachmentImage: {
      width: 200,
      height: 200,
      borderRadius: 14,
      backgroundColor: theme.pill,
    },
    stickerImage: {
      width: 120,
      height: 120,
    },
    // 正文行内表情包：尺寸与行高配合，避免撑破行
    inlineSticker: {
      width: 96,
      height: 96,
      borderRadius: 8,
      marginHorizontal: 2,
    },
    inlineStickerExpired: {
      color: theme.chatMuted,
      fontSize: 13,
    },
    // 已删除表情包的占位盒：与 stickerImage 同尺寸，虚线框 + 弱化文字
    stickerExpired: {
      borderWidth: 1,
      borderStyle: 'dashed',
      borderColor: theme.borderStrong,
      borderRadius: 12,
      alignItems: 'center',
      justifyContent: 'center',
      backgroundColor: theme.pill,
    },
    stickerExpiredText: {
      color: theme.chatMuted,
      fontSize: 12,
    },
    // ---- 操作行 / 重试 ----
    actsRow: {
      flexDirection: 'row',
      alignItems: 'center',
      gap: 10,
      marginTop: CHAT_LAYOUT.textToActions,
    },
    actButton: {
      width: 28,
      height: 24,
      alignItems: 'center',
      justifyContent: 'center',
    },
    actIcon: {
      color: theme.chatMuted,
      fontSize: 16,
      lineHeight: 20,
      fontWeight: '700',
    },
    retryButton: {
      marginTop: CHAT_LAYOUT.nameToText,
      alignSelf: 'flex-start',
      paddingHorizontal: 14,
      height: 30,
      borderRadius: 15,
      backgroundColor: theme.pill,
      alignItems: 'center',
      justifyContent: 'center',
    },
    retryText: {
      color: theme.pillText,
      fontSize: CHAT_TYPE.pill,
    },
  });
