import React, { useMemo } from 'react';
import {
  Alert,
  View,
  Text,
  TextInput,
  TouchableOpacity,
  StyleSheet,
} from 'react-native';
import { Image } from 'expo-image';

import type { Theme } from '../theme';
import type { PendingAttachment } from '../lib/types';
import { CHAT_LAYOUT, CHAT_TYPE } from '../lib/design';

// 底部输入区（设计图 .dock）：模型 pill 在上、输入胶囊在下，两段都在正常流里。
// 纯受控组件：value / sending / onSend 全部由 App 提供，内部不持有任何聊天状态。
//
// 与重构前的差别：胶囊里的头像去掉（返回主页改由顶栏 ☰ 抽屉承担），
// 胶囊不再是浮在消息上的半透明阴影条，而是设计图的实色灰底；
// 模型选择从「只能进模型设置页」变成胶囊上方一个可点的一行 pill。
export function ChatInput({
  theme,
  value,
  onChangeText,
  sending,
  onSend,
  onStop,
  loadingHistory,
  pendingAttachments = [],
  onRemoveAttachment,
  onPlus,
  uploadingImage,
  modelLabel,
  onOpenModels,
}: {
  theme: Theme;
  value: string;
  onChangeText: (text: string) => void;
  sending: boolean;
  onSend: () => void;
  // 用户主动停止生成；仅 sending 时生效
  onStop?: () => void;
  // 会话历史加载中：发送会带错上下文，先禁用
  loadingHistory?: boolean;
  // 已上传待发送的图片附件（点 × 移除）
  pendingAttachments?: PendingAttachment[];
  onRemoveAttachment?: (id: string) => void;
  // 「＋」打开加号面板（图片 / 表情包入口）
  onPlus?: () => void;
  // 图片上传进行中：预览行显示占位，并禁用发送避免半成品请求
  uploadingImage?: boolean;
  // 当前所选模型的展示名（来自 /model-providers）；空串表示还没读到
  modelLabel?: string;
  // 点模型 pill 打开模型与 API 管理
  onOpenModels?: () => void;
}) {
  const styles = useMemo(() => createStyles(theme), [theme]);

  const hasPending = pendingAttachments.length > 0 || !!uploadingImage;
  const canSend = value.trim().length > 0 || pendingAttachments.length > 0;
  const sendDisabled = sending || loadingHistory || !!uploadingImage;

  return (
    <View style={styles.dock}>
      {/* 待发送附件预览行：浮在输入胶囊正上方 */}
      {hasPending && (
        <View style={styles.pendingRow}>
          {pendingAttachments.map(item => (
            <View key={item.attachment.id} style={styles.pendingItem}>
              <Image
                source={{ uri: item.previewUri }}
                style={styles.pendingThumb}
                contentFit="cover"
              />
              <TouchableOpacity
                style={styles.pendingRemove}
                onPress={() => onRemoveAttachment?.(item.attachment.id)}
                accessibilityLabel="移除图片"
                hitSlop={6}
              >
                <Text style={styles.pendingRemoveText}>×</Text>
              </TouchableOpacity>
            </View>
          ))}

          {!!uploadingImage && (
            <View style={[styles.pendingItem, styles.pendingUploading]}>
              <Text style={styles.pendingUploadingText}>…</Text>
            </View>
          )}
        </View>
      )}

      {/* 模型 pill：只在读到选择后出现，避免显示一个假的模型名 */}
      {!!modelLabel && (
        <TouchableOpacity
          style={styles.modelPill}
          onPress={onOpenModels}
          activeOpacity={0.7}
          accessibilityLabel={`当前模型 ${modelLabel}，点击管理`}
        >
          <Text style={styles.modelGlyph}>◉</Text>

          <Text style={styles.modelText} numberOfLines={1}>
            {modelLabel}
          </Text>

          <Text style={styles.modelChevron}>⌄</Text>
        </TouchableOpacity>
      )}

      <View style={styles.capsule}>
        <TouchableOpacity
          style={styles.plusButton}
          onPress={onPlus}
          activeOpacity={0.75}
          accessibilityLabel="更多功能"
        >
          <Text style={styles.plusIcon}>＋</Text>
        </TouchableOpacity>

        <TextInput
          value={value}
          onChangeText={onChangeText}
          placeholder={sending ? '继续和 Blue 说…' : '问 Blue 任何事'}
          placeholderTextColor={theme.chatMuted}
          cursorColor={theme.accent}
          selectionColor={theme.accentBorder}
          style={styles.input}
          multiline
        />

        <TouchableOpacity
          style={styles.micButton}
          onPress={() =>
            Alert.alert('语音输入', '该能力尚未接入当前版本，暂未开放。')
          }
          activeOpacity={0.7}
          accessibilityLabel="语音输入（暂未开放）"
        >
          <View style={styles.micGlyph}>
            <View style={styles.micCapsule} />
            <View style={styles.micStem} />
          </View>
        </TouchableOpacity>

        {sending ? (
          <TouchableOpacity
            style={[styles.sendButton, styles.stopButton]}
            onPress={onStop}
            activeOpacity={0.75}
            accessibilityLabel="停止生成"
          >
            <View style={styles.stopGlyph} />
          </TouchableOpacity>
        ) : (
          <TouchableOpacity
            style={[
              styles.sendButton,
              (!canSend || sendDisabled) && styles.sendButtonDisabled,
            ]}
            onPress={onSend}
            disabled={!canSend || sendDisabled}
            activeOpacity={0.75}
            accessibilityLabel="发送"
          >
            <Text style={styles.sendText}>↑</Text>
          </TouchableOpacity>
        )}
      </View>
    </View>
  );
}

// 样式由主题派生：只包含本组件用到的键
const createStyles = (theme: Theme) =>
  StyleSheet.create({
    dock: {
      paddingHorizontal: CHAT_LAYOUT.gutter,
      paddingTop: 8,
      paddingBottom: 8,
      backgroundColor: 'transparent',
    },
    // ---- 待发送附件预览行 ----
    pendingRow: {
      flexDirection: 'row',
      flexWrap: 'wrap',
      gap: 10,
      marginBottom: 10,
    },
    pendingItem: {
      width: 52,
      height: 52,
      borderRadius: 12,
    },
    pendingThumb: {
      width: 52,
      height: 52,
      borderRadius: 12,
      backgroundColor: theme.pill,
    },
    pendingRemove: {
      position: 'absolute',
      top: -6,
      right: -6,
      width: 20,
      height: 20,
      borderRadius: 10,
      backgroundColor: 'rgba(0,0,0,0.75)',
      alignItems: 'center',
      justifyContent: 'center',
    },
    pendingRemoveText: {
      color: '#fff',
      fontSize: 13,
      lineHeight: 16,
      fontWeight: '700',
    },
    pendingUploading: {
      backgroundColor: theme.pill,
      alignItems: 'center',
      justifyContent: 'center',
    },
    pendingUploadingText: {
      color: theme.chatMuted,
      fontSize: 18,
    },
    // ---- 模型 pill（实测：高 26、内容宽、灰底无描边）----
    modelPill: {
      alignSelf: 'flex-start',
      height: CHAT_LAYOUT.modelPillHeight,
      maxWidth: '78%',
      paddingHorizontal: 12,
      borderRadius: CHAT_LAYOUT.modelPillHeight / 2,
      backgroundColor: theme.pill,
      flexDirection: 'row',
      alignItems: 'center',
      marginBottom: CHAT_LAYOUT.modelPillGap,
    },
    modelGlyph: {
      color: theme.pillText,
      fontSize: 11,
      marginRight: 7,
    },
    modelText: {
      color: theme.pillText,
      fontSize: CHAT_TYPE.pill,
      flexShrink: 1,
    },
    modelChevron: {
      color: theme.pillText,
      fontSize: 12,
      marginLeft: 6,
    },
    // ---- 输入胶囊（实测：高 50、r 25、灰底、无阴影）----
    capsule: {
      minHeight: CHAT_LAYOUT.capsuleHeight,
      borderRadius: CHAT_LAYOUT.capsuleHeight / 2,
      backgroundColor: theme.pill,
      borderWidth: StyleSheet.hairlineWidth,
      borderColor: theme.border,
      flexDirection: 'row',
      alignItems: 'center',
      paddingLeft: CHAT_LAYOUT.capsuleInset + 4,
      paddingRight: CHAT_LAYOUT.capsuleInset,
    },
    plusButton: {
      width: CHAT_LAYOUT.controlSize,
      height: CHAT_LAYOUT.controlSize,
      borderRadius: CHAT_LAYOUT.controlSize / 2,
      alignItems: 'center',
      justifyContent: 'center',
      marginRight: 4,
    },
    plusIcon: {
      color: theme.chatText,
      fontSize: 24,
      lineHeight: 28,
      fontWeight: '400',
    },
    input: {
      flex: 1,
      maxHeight: 110,
      minHeight: CHAT_LAYOUT.capsuleHeight,
      // 去掉独立背景与边框，直接融进胶囊
      backgroundColor: 'transparent',
      paddingHorizontal: 8,
      paddingVertical: 13,
      color: theme.chatText,
      fontSize: 16,
      lineHeight: 22,
      textAlignVertical: 'center',
    },
    sendButton: {
      width: CHAT_LAYOUT.controlSize,
      height: CHAT_LAYOUT.controlSize,
      borderRadius: CHAT_LAYOUT.controlSize / 2,
      backgroundColor: theme.sendButton,
      alignItems: 'center',
      justifyContent: 'center',
    },
    micButton: {
      width: 32,
      height: 34,
      alignItems: 'center',
      justifyContent: 'center',
      flexShrink: 0,
    },
    micGlyph: {
      width: 12,
      height: 18,
      alignItems: 'center',
    },
    micCapsule: {
      width: 7,
      height: 11,
      borderWidth: 1.4,
      borderColor: theme.chatMuted,
      borderRadius: 4,
    },
    micStem: {
      width: 1.4,
      height: 5,
      backgroundColor: theme.chatMuted,
    },
    stopButton: {
      backgroundColor: 'transparent',
      borderWidth: 1,
      borderColor: theme.borderStrong,
    },
    stopGlyph: {
      width: 9,
      height: 9,
      borderRadius: 2,
      backgroundColor: theme.chatText,
    },
    sendText: {
      color: theme.textOnAccent,
      fontSize: 17,
      lineHeight: 21,
      fontWeight: '700',
    },
    sendButtonDisabled: {
      opacity: 0.55,
    },
  });
