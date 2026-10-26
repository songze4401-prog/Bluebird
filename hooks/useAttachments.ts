// 待发送附件与上传（阶段 2）。
//
// 重构前 pickImage / pickSticker / pendingAttachments / uploadingImage 全部散在
// App 里（约 100 行），与聊天编排混在一起。现在只保留「选图 → 上传 → 预览」
// 这一段，发送由 App 转交给 useChatSession。
// 并发守卫（sending / loadingHistory）留在调用方，避免与 useChatSession 循环依赖。

import { useState } from 'react';
import { Alert } from 'react-native';
import * as ImagePicker from 'expo-image-picker';

import { addSticker, uploadImage } from '../lib/uploads';
import type { Attachment, PendingAttachment } from '../lib/types';

// 与服务端 MAX_ATTACHMENTS 对齐：单条消息最多 4 张
export const MAX_PENDING_ATTACHMENTS = 4;

export type AttachmentsApi = {
  pendingAttachments: PendingAttachment[];
  uploadingImage: boolean;
  pickImage: (source: 'album' | 'camera') => Promise<void>;
  pickSticker: () => Promise<Attachment | null>;
  removeAttachment: (id: string) => void;
  clearAttachments: () => void;
};

export function useAttachments({
  onUploadStart,
}: {
  // 开始上传时收起加号面板（由 App 持有开关）
  onUploadStart: () => void;
}): AttachmentsApi {
  const [pendingAttachments, setPendingAttachments] = useState<
    PendingAttachment[]
  >([]);
  const [uploadingImage, setUploadingImage] = useState(false);

  // 选图 → 上传（POST /uploads/image）→ 进入待发送预览行。
  // 上传完成后才出现在预览里，失败只弹提示不留半成品。
  const pickImage = async (source: 'album' | 'camera') => {
    if (uploadingImage) return;

    if (pendingAttachments.length >= MAX_PENDING_ATTACHMENTS) {
      Alert.alert('最多 4 张', '单条消息最多携带 4 张图片。');
      return;
    }

    try {
      if (source === 'camera') {
        const permission =
          await ImagePicker.requestCameraPermissionsAsync();

        if (!permission.granted) {
          Alert.alert('无法拍照', '请在系统设置中允许使用相机。');
          return;
        }
      }

      const result =
        source === 'camera'
          ? await ImagePicker.launchCameraAsync({
              base64: true,
              quality: 0.85,
            })
          : await ImagePicker.launchImageLibraryAsync({
              mediaTypes: ['images'],
              base64: true,
              quality: 0.85,
            });

      if (result.canceled) return;

      const asset = result.assets?.[0];

      if (!asset?.base64) {
        Alert.alert('读取图片失败', '请换一张图片再试。');
        return;
      }

      const dataUrl = `data:${asset.mimeType || 'image/jpeg'};base64,${asset.base64}`;

      setUploadingImage(true);
      onUploadStart();

      const attachment = await uploadImage(
        dataUrl,
        'image',
        asset.fileName ?? undefined
      );

      setPendingAttachments(prev => [
        ...prev,
        { attachment, previewUri: dataUrl },
      ]);
    } catch (error) {
      console.error('Pick image error:', error);
      Alert.alert(
        '图片上传失败',
        error instanceof Error ? error.message : '请稍后再试。'
      );
    } finally {
      setUploadingImage(false);
    }
  };

  // 从相册选图登记为表情包（入仓库，sha256 去重），返回新表情包供面板插入网格
  const pickSticker = async (): Promise<Attachment | null> => {
    try {
      const result = await ImagePicker.launchImageLibraryAsync({
        mediaTypes: ['images'],
        base64: true,
        quality: 0.85,
      });

      if (result.canceled) return null;

      const asset = result.assets?.[0];

      if (!asset?.base64) {
        Alert.alert('读取图片失败', '请换一张图片再试。');
        return null;
      }

      const dataUrl = `data:${asset.mimeType || 'image/jpeg'};base64,${asset.base64}`;

      return await addSticker(dataUrl, asset.fileName ?? undefined);
    } catch (error) {
      console.error('Add sticker error:', error);
      Alert.alert(
        '添加表情包失败',
        error instanceof Error ? error.message : '请稍后再试。'
      );
      return null;
    }
  };

  const removeAttachment = (id: string) =>
    setPendingAttachments(prev =>
      prev.filter(item => item.attachment.id !== id)
    );

  const clearAttachments = () => setPendingAttachments([]);

  return {
    pendingAttachments,
    uploadingImage,
    pickImage,
    pickSticker,
    removeAttachment,
    clearAttachments,
  };
}
