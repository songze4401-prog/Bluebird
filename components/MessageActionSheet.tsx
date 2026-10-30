import React, { useMemo } from 'react';
import {
  Alert,
  Clipboard,
  Modal,
  Pressable,
  Share,
  StyleSheet,
  Text,
  TouchableOpacity,
  View,
} from 'react-native';

import type { Theme } from '../theme';
import type { Message } from '../lib/types';

export type MessageActionSheetProps = {
  visible: boolean;
  message: Message | null;
  theme: Theme;
  isFavorite: boolean;
  onClose: () => void;
  onToggleFavorite: (message: Message) => void;
  onDelete: (message: Message) => void;
};

/**
 * 统一消息操作面板。复制/分享使用 RN 内置能力；收藏由父级持久化到本机；
 * 删除仅对用户消息走后端撤回，assistant 消息只做本机隐藏（父级明确提示）。
 */
export function MessageActionSheet({
  visible,
  message,
  theme,
  isFavorite,
  onClose,
  onToggleFavorite,
  onDelete,
}: MessageActionSheetProps) {
  const styles = useMemo(() => createStyles(theme), [theme]);

  if (!message) return null;

  const hasText = Boolean(message.content && message.content.trim());
  const isUser = message.role === 'user';

  const copy = () => {
    if (!hasText) {
      Alert.alert('暂无可复制文本', '这条消息只有图片或表情包。');
      return;
    }
    try {
      Clipboard.setString(message.content);
      onClose();
      Alert.alert('已复制', '消息正文已复制到剪贴板。');
    } catch {
      Alert.alert('复制失败', '当前设备无法访问剪贴板。');
    }
  };

  const share = () => {
    if (!hasText) {
      Alert.alert('暂无可分享文本', '这条消息只有图片或表情包。');
      return;
    }
    void Share.share({ message: message.content }).catch(() => {
      Alert.alert('分享未完成', '系统分享面板未能打开。');
    });
    onClose();
  };

  const favorite = () => {
    onToggleFavorite(message);
    onClose();
  };

  const remove = () => {
    onClose();
    onDelete(message);
  };

  return (
    <Modal
      visible={visible}
      transparent
      animationType="slide"
      onRequestClose={onClose}
    >
      <View style={styles.root}>
        <Pressable style={styles.scrim} onPress={onClose} />
        <View style={styles.sheet}>
          <View style={styles.handle} />
          <Text style={styles.title} numberOfLines={2}>
            {message.content.trim() || '图片 / 表情包'}
          </Text>
          <Text style={styles.meta}>
            {isUser ? '你的消息' : 'Bluebird 的回复'}
          </Text>

          <View style={styles.actions}>
            <Action
              styles={styles}
              label="复制"
              hint={hasText ? '复制正文' : '无可复制文本'}
              disabled={!hasText}
              onPress={copy}
            />
            <Action
              styles={styles}
              label={isFavorite ? '取消收藏' : '收藏'}
              hint="仅保存在本机"
              onPress={favorite}
            />
            <Action
              styles={styles}
              label="分享"
              hint="调用系统分享面板"
              disabled={!hasText}
              onPress={share}
            />
            <Action
              styles={styles}
              label={isUser ? '删除并撤回' : '从本机隐藏'}
              hint={
                isUser
                  ? '会同时移除配对的 AI 回复'
                  : '服务端删除暂未开放，不会伪装成功'
              }
              danger
              onPress={remove}
            />
          </View>

          <TouchableOpacity
            style={styles.cancel}
            onPress={onClose}
            activeOpacity={0.7}
            accessibilityLabel="取消消息操作"
          >
            <Text style={styles.cancelText}>取消</Text>
          </TouchableOpacity>
        </View>
      </View>
    </Modal>
  );
}

function Action({
  styles,
  label,
  hint,
  disabled,
  danger,
  onPress,
}: {
  styles: ReturnType<typeof createStyles>;
  label: string;
  hint: string;
  disabled?: boolean;
  danger?: boolean;
  onPress: () => void;
}) {
  return (
    <TouchableOpacity
      style={[styles.action, disabled && styles.actionDisabled]}
      onPress={onPress}
      disabled={disabled}
      activeOpacity={0.65}
      accessibilityLabel={label}
    >
      <Text
        style={[
          styles.actionLabel,
          danger && styles.actionDanger,
          disabled && styles.actionDisabledText,
        ]}
      >
        {label}
      </Text>
      <Text style={styles.actionHint}>{hint}</Text>
    </TouchableOpacity>
  );
}

const createStyles = (theme: Theme) =>
  StyleSheet.create({
    root: {
      flex: 1,
      justifyContent: 'flex-end',
    },
    scrim: {
      position: 'absolute',
      top: 0,
      right: 0,
      bottom: 0,
      left: 0,
      backgroundColor: theme.scrim,
    },
    sheet: {
      backgroundColor: theme.surface,
      borderTopLeftRadius: 26,
      borderTopRightRadius: 26,
      borderWidth: 1,
      borderBottomWidth: 0,
      borderColor: theme.borderStrong,
      paddingHorizontal: 20,
      paddingTop: 9,
      paddingBottom: 28,
    },
    handle: {
      width: 38,
      height: 4,
      borderRadius: 2,
      backgroundColor: theme.borderStrong,
      alignSelf: 'center',
      marginBottom: 16,
    },
    title: {
      color: theme.textPrimary,
      fontSize: 15,
      lineHeight: 22,
      fontWeight: '600',
    },
    meta: {
      color: theme.textMuted,
      fontSize: 11,
      lineHeight: 16,
      marginTop: 4,
      marginBottom: 12,
    },
    actions: {
      borderTopWidth: StyleSheet.hairlineWidth,
      borderTopColor: theme.border,
    },
    action: {
      height: 50,
      borderBottomWidth: StyleSheet.hairlineWidth,
      borderBottomColor: theme.border,
      justifyContent: 'center',
    },
    actionDisabled: {
      opacity: 0.42,
    },
    actionLabel: {
      color: theme.textBody,
      fontSize: 14,
      lineHeight: 20,
    },
    actionDanger: {
      color: theme.danger,
    },
    actionDisabledText: {
      color: theme.textMuted,
    },
    actionHint: {
      color: theme.textMuted,
      fontSize: 10,
      lineHeight: 15,
      marginTop: 1,
    },
    cancel: {
      height: 46,
      marginTop: 12,
      borderRadius: 14,
      alignItems: 'center',
      justifyContent: 'center',
      backgroundColor: theme.pill,
    },
    cancelText: {
      color: theme.textSecondary,
      fontSize: 14,
    },
  });
