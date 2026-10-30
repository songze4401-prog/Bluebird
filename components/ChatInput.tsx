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
import { CHAT_LAYOUT } from '../lib/design';

// 底部输入区：一张大圆角输入卡片，输入行在上、控件行（加号、模型、语音、发送）在下。
// 与抽屉共用白色卡片 + 轻描边 + 柔和阴影的材质；模型 pill 从卡片外移进控件行。
// 纯受控组件：value / sending / onSend 全部由 App 提供，内部不持有任何聊天状态。
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

      <View style={styles.composer}>
        <TextInput
          value={value}
          onChangeText={onChangeText}
          placeholder={sending ? '继续和 Blue 说…' : '与 Blue 对话…'}
          placeholderTextColor={theme.chatMuted}
          cursorColor={theme.accent}
          selectionColor={theme.accentBorder}
          style={styles.input}
          multiline
        />

        <View style={styles.controlRow}>
          <TouchableOpacity
            style={styles.roundButton}
            onPress={onPlus}
            activeOpacity={0.75}
            accessibilityLabel="更多功能"
          >
            <Text style={styles.plusIcon}>＋</Text>
          </TouchableOpacity>

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

          <View style={styles.controlSpacer} />

          <TouchableOpacity
            style={styles.roundButton}
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
    </View>
  );
}

// 样式由主题派生：只包含本组件用到的键
const createStyles = (theme: Theme) =>
  StyleSheet.create({
    dock: {
      paddingHorizontal: CHAT_LAYOUT.gutter,
      paddingTop: 8,
      paddingBottom: 10,
      backgroundColor: 'transparent',
    },
    // ---- 待发送附件预览行 ----
    pendingRow: {
      flexDirection: 'row',
      flexWrap: 'wrap',
      gap: 10,
      marginBottom: 12,
    },
    pendingItem: {
      width: 54,
      height: 54,
      borderRadius: 14,
    },
    pendingThumb: {
      width: 54,
      height: 54,
      borderRadius: 14,
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
    // ---- 输入卡片：输入行在上、控件行在下 ----
    composer: {
      minHeight: CHAT_LAYOUT.composerMinHeight,
      padding: CHAT_LAYOUT.composerPadding,
      borderRadius: CHAT_LAYOUT.composerRadius,
      backgroundColor: theme.surface,
      borderWidth: StyleSheet.hairlineWidth,
      borderColor: theme.borderStrong,
      justifyContent: 'space-between',
      shadowColor: '#000',
      shadowOffset: { width: 0, height: 9 },
      shadowOpacity: theme.mode === 'dark' ? 0.35 : 0.07,
      shadowRadius: 18,
      elevation: 4,
    },
    input: {
      width: '100%',
      minHeight: 44,
      maxHeight: 110,
      backgroundColor: 'transparent',
      paddingHorizontal: 2,
      paddingTop: 2,
      paddingBottom: 6,
      color: theme.chatText,
      fontSize: 16,
      lineHeight: 23,
      textAlignVertical: 'top',
    },
    controlRow: {
      flexDirection: 'row',
      alignItems: 'center',
      gap: 8,
      marginTop: 4,
    },
    controlSpacer: {
      flex: 1,
    },
    roundButton: {
      width: CHAT_LAYOUT.controlSize,
      height: CHAT_LAYOUT.controlSize,
      borderRadius: CHAT_LAYOUT.controlSize / 2,
      alignItems: 'center',
      justifyContent: 'center',
      backgroundColor: theme.surfaceAlt,
    },
    plusIcon: {
      color: theme.chatText,
      fontSize: 22,
      lineHeight: 26,
      fontWeight: '400',
    },
    // ---- 模型 pill（输入卡片控件行）----
    modelPill: {
      height: CHAT_LAYOUT.modelPillHeight,
      maxWidth: '48%',
      paddingHorizontal: 11,
      borderRadius: CHAT_LAYOUT.modelPillHeight / 2,
      backgroundColor: theme.surfaceAlt,
      flexDirection: 'row',
      alignItems: 'center',
      flexShrink: 1,
    },
    modelGlyph: {
      color: theme.accent,
      fontSize: 11,
      marginRight: 6,
    },
    modelText: {
      color: theme.textSecondary,
      fontSize: 12,
      flexShrink: 1,
    },
    modelChevron: {
      color: theme.textMuted,
      fontSize: 12,
      marginLeft: 5,
    },
    sendButton: {
      width: CHAT_LAYOUT.controlSize,
      height: CHAT_LAYOUT.controlSize,
      borderRadius: CHAT_LAYOUT.controlSize / 2,
      backgroundColor: theme.sendButton,
      alignItems: 'center',
      justifyContent: 'center',
      shadowColor: theme.accent,
      shadowOffset: { width: 0, height: 4 },
      shadowOpacity: theme.mode === 'dark' ? 0.32 : 0.2,
      shadowRadius: 8,
      elevation: 3,
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
      borderColor: theme.textSecondary,
      borderRadius: 4,
    },
    micStem: {
      width: 1.4,
      height: 5,
      backgroundColor: theme.textSecondary,
    },
    stopButton: {
      backgroundColor: theme.surfaceAlt,
      borderWidth: StyleSheet.hairlineWidth,
      borderColor: theme.borderStrong,
      shadowOpacity: 0,
      elevation: 0,
    },
    stopGlyph: {
      width: 10,
      height: 10,
      borderRadius: 2,
      backgroundColor: theme.accent,
    },
    sendText: {
      color: theme.textOnAccent,
      fontSize: 18,
      lineHeight: 22,
      fontWeight: '700',
    },
    sendButtonDisabled: {
      opacity: 0.38,
    },
  });
