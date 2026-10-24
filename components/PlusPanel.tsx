import React, { useEffect, useMemo, useState } from 'react';
import {
  Modal,
  ScrollView,
  StyleSheet,
  Text,
  TouchableOpacity,
  View,
} from 'react-native';
import { Image } from 'expo-image';

import type { Theme } from '../theme';
import type { Attachment } from '../lib/types';
import { IMAGE_AUTH_HEADERS, listStickerRepo, stickerImageUrl } from '../lib/uploads';

// 加号面板：底部弹层，提供「相册 / 拍照 / 表情包」三个入口。
// 表情包页直接展示服务端表情包仓库（GET /sticker-repo），点按即发送；
// 「添加」把相册图片登记进仓库（POST /sticker-repo，sha256 去重）。
// 面板本身不持有聊天状态：选图、发送全部通过回调上抛给 App。
export function PlusPanel({
  theme,
  visible,
  onClose,
  onPickImage,
  onAddSticker,
  onSendSticker,
  busy,
}: {
  theme: Theme;
  visible: boolean;
  onClose: () => void;
  // 从相册 / 相机选一张聊天图片（上传成功后进入待发送预览）
  onPickImage: (source: 'album' | 'camera') => void;
  // 从相册选一张图登记为表情包，返回新表情包（失败返回 null）
  onAddSticker: () => Promise<Attachment | null>;
  // 点按库中表情包：立即作为一条消息发出
  onSendSticker: (attachment: Attachment) => void;
  // 上传/发送进行中：禁用入口防连点
  busy?: boolean;
}) {
  const styles = useMemo(() => createStyles(theme), [theme]);

  const [stickersOpen, setStickersOpen] = useState(false);
  const [stickers, setStickers] = useState<Attachment[] | null>(null);
  const [stickerError, setStickerError] = useState<string | null>(null);

  // 打开表情包页时重新拉取库列表（添加后也会触发刷新）
  useEffect(() => {
    if (!visible || !stickersOpen) return;

    let cancelled = false;

    (async () => {
      try {
        setStickerError(null);
        const list = await listStickerRepo();
        if (!cancelled) setStickers(list);
      } catch {
        if (!cancelled) setStickerError('表情包加载失败，请检查后端连接');
      }
    })();

    return () => {
      cancelled = true;
    };
  }, [visible, stickersOpen]);

  // 面板关闭时收起表情包页，下次打开回到入口行
  useEffect(() => {
    if (!visible) setStickersOpen(false);
  }, [visible]);

  const handleAddSticker = async () => {
    const added = await onAddSticker();
    if (added) setStickers(prev => (prev ? [added, ...prev] : [added]));
  };

  return (
    <Modal
      visible={visible}
      transparent
      animationType="fade"
      onRequestClose={onClose}
    >
      <View style={styles.backdrop}>
        {/* 点击空白处关闭 */}
        <TouchableOpacity
          style={StyleSheet.absoluteFill}
          onPress={onClose}
          activeOpacity={1}
          accessibilityLabel="关闭"
        />

        <View style={styles.sheet}>
          <View style={styles.actionRow}>
            <TouchableOpacity
              style={[styles.actionButton, busy && styles.disabled]}
              onPress={() => onPickImage('album')}
              disabled={busy}
              activeOpacity={0.7}
            >
              <Text style={styles.actionText}>相册</Text>
            </TouchableOpacity>

            <TouchableOpacity
              style={[styles.actionButton, busy && styles.disabled]}
              onPress={() => onPickImage('camera')}
              disabled={busy}
              activeOpacity={0.7}
            >
              <Text style={styles.actionText}>拍照</Text>
            </TouchableOpacity>

            <TouchableOpacity
              style={[
                styles.actionButton,
                stickersOpen && styles.actionButtonActive,
                busy && styles.disabled,
              ]}
              onPress={() => setStickersOpen(prev => !prev)}
              disabled={busy}
              activeOpacity={0.7}
            >
              <Text
                style={[
                  styles.actionText,
                  stickersOpen && styles.actionTextActive,
                ]}
              >
                表情包
              </Text>
            </TouchableOpacity>
          </View>

          {stickersOpen && (
            <View style={styles.stickerArea}>
              {stickers === null && !stickerError && (
                <Text style={styles.stickerHint}>加载中…</Text>
              )}

              {stickerError && (
                <Text style={styles.stickerError}>{stickerError}</Text>
              )}

              {stickers !== null && (
                <ScrollView style={styles.stickerScroll}>
                  <View style={styles.stickerGrid}>
                    <TouchableOpacity
                      style={[styles.stickerCell, styles.stickerAdd]}
                      onPress={handleAddSticker}
                      disabled={busy}
                      activeOpacity={0.7}
                    >
                      <Text style={styles.stickerAddText}>＋ 添加</Text>
                    </TouchableOpacity>

                    {stickers.map(att => (
                      <TouchableOpacity
                        key={att.id}
                        style={styles.stickerCell}
                        onPress={() => onSendSticker(att)}
                        disabled={busy}
                        activeOpacity={0.7}
                        accessibilityLabel={att.name || '表情包'}
                      >
                        <Image
                          source={{
                            uri: stickerImageUrl(att.id),
                            headers: IMAGE_AUTH_HEADERS,
                          }}
                          style={styles.stickerImage}
                          contentFit="contain"
                          transition={100}
                        />
                      </TouchableOpacity>
                    ))}
                  </View>

                  {stickers.length === 0 && (
                    <Text style={styles.stickerHint}>
                      还没有表情包，点「＋ 添加」从相册选一张。
                    </Text>
                  )}
                </ScrollView>
              )}
            </View>
          )}
        </View>
      </View>
    </Modal>
  );
}

// 样式由主题派生：只包含本组件用到的键
const createStyles = (theme: Theme) =>
  StyleSheet.create({
    backdrop: {
      flex: 1,
      backgroundColor: 'rgba(0,0,0,0.35)',
      justifyContent: 'flex-end',
    },
    sheet: {
      backgroundColor: theme.surface,
      borderTopLeftRadius: 16,
      borderTopRightRadius: 16,
      borderWidth: 1,
      borderColor: theme.borderStrong,
      paddingHorizontal: 16,
      paddingTop: 14,
      paddingBottom: 28,
    },
    actionRow: {
      flexDirection: 'row',
      gap: 12,
    },
    actionButton: {
      flex: 1,
      borderRadius: 12,
      borderWidth: 1,
      borderColor: theme.borderStrong,
      paddingVertical: 14,
      alignItems: 'center',
    },
    actionButtonActive: {
      borderColor: theme.accentBorder,
    },
    actionText: {
      color: theme.textPrimary,
      fontSize: 15,
      fontWeight: '600',
    },
    actionTextActive: {
      color: theme.accent,
    },
    disabled: {
      opacity: 0.5,
    },
    stickerArea: {
      marginTop: 14,
    },
    stickerScroll: {
      maxHeight: 260,
    },
    stickerGrid: {
      flexDirection: 'row',
      flexWrap: 'wrap',
      gap: 10,
    },
    stickerCell: {
      width: 72,
      height: 72,
      borderRadius: 12,
      borderWidth: 1,
      borderColor: theme.borderStrong,
      alignItems: 'center',
      justifyContent: 'center',
      overflow: 'hidden',
    },
    stickerAdd: {
      borderStyle: 'dashed',
    },
    stickerAddText: {
      color: theme.textSecondary,
      fontSize: 13,
    },
    stickerImage: {
      width: 64,
      height: 64,
    },
    stickerHint: {
      color: theme.textMuted,
      fontSize: 13,
      paddingVertical: 14,
      textAlign: 'center',
    },
    stickerError: {
      color: theme.danger,
      fontSize: 13,
      paddingVertical: 14,
      textAlign: 'center',
    },
  });
