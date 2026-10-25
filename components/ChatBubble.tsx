import React, { useMemo, useState } from 'react';
import {
  View,
  Text,
  TouchableOpacity,
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
import {
  withAlpha,
  shouldShowMessageTime,
  formatMessageTime,
  parseStickerMarkers,
} from '../lib/utils';

// 单条消息气泡（纯展示）：时间标签 + 用户/Bluebird 两种气泡 + 重新发送 + 继续说。
// 所有交互通过回调上抛，组件内不持有任何状态（除样式 memo）。
// 附件（图片/表情包）渲染在气泡内文字上方，经服务端鉴权路由读取。
function BubbleAttachments({
  attachments,
  styles,
}: {
  attachments: Attachment[];
  styles: ReturnType<typeof createStyles>;
}) {
  return (
    <View style={styles.attachmentStack}>
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

// Bluebird 正文：直接渲染数据层切好的片段（App 在消息进入 state 前已解析）。
// 命中标记的片段换成行内图片，其余片段原样传给孩子 Text，
// 换行与字号/行高完全沿用气泡样式。
// segments 缺失只可能来自绕过 App 数据层的调用，此时才退回一次解析（不会闪）。
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
    <Text style={styles.messageText}>
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
  onRetry: (text?: string, attachments?: Attachment[]) => void;
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
            {!!item.attachments?.length && (
              <BubbleAttachments
                attachments={item.attachments}
                styles={styles}
              />
            )}
            {!!item.content && (
              <Text style={[styles.messageText, styles.userMessageText]}>
                {item.content}
              </Text>
            )}
          </TouchableOpacity>
        ) : (
          // 气泡与「继续说」包在同一列里：列宽 = 气泡宽，按钮靠右即贴住气泡右边缘
          <View style={styles.assistantColumn}>
            <View style={[styles.bubble, styles.bluebirdBubble]}>
              {!!item.attachments?.length && (
                <BubbleAttachments
                  attachments={item.attachments}
                  styles={styles}
                />
              )}
              {!!item.content && (
                <AssistantContent
                  content={item.content}
                  segments={item.segments}
                  styles={styles}
                />
              )}

              {/* 图片触发了视觉能力路由：如实说明实际使用的模型（后端结果） */}
              {!!item.modelNote && (
                <Text style={styles.modelNote}>{item.modelNote}</Text>
              )}

              {!!item.retryText && (
                <TouchableOpacity
                  style={[styles.retryButton, { backgroundColor: theme.bubble }]}
                  onPress={() => onRetry(item.retryText, item.retryAttachments)}
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
    // 模型路由提示：弱化的小字，附在气泡正文下方，不参与正文排版
    modelNote: {
      color: theme.textMuted,
      fontSize: 11,
      lineHeight: 16,
      marginTop: 6,
    },
    // ---- 气泡内附件（图片 / 表情包） ----
    attachmentStack: {
      gap: 8,
      marginBottom: 2,
    },
    attachmentImage: {
      width: 200,
      height: 200,
      borderRadius: 12,
      backgroundColor: theme.surface,
    },
    stickerImage: {
      width: 120,
      height: 120,
    },
    // 正文行内表情包：尺寸与行高配合，避免撑破气泡
    inlineSticker: {
      width: 96,
      height: 96,
      borderRadius: 8,
      marginHorizontal: 2,
    },
    inlineStickerExpired: {
      color: theme.textMuted,
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
      backgroundColor: theme.surface,
    },
    stickerExpiredText: {
      color: theme.textMuted,
      fontSize: 12,
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