// 多模态上传客户端：图片（base64 dataURL）上传换稳定附件 id，
// 表情包库列表读取，以及图片 URL / 鉴权头的统一出口。
// 上传、读取全部经过服务端鉴权路由，API 密钥只存在于这些请求头里。
//
// 阶段 3：请求统一走 lib/api/client（带上超时）。上传是 base64 大 body，
// 沿用原有 60s 预算，不再是无超时请求。

import { API_TOKEN } from './constants';
import { readJsonResponse } from './utils';
import { apiFetch, TIMEOUTS } from './api/client';
import { API_PATHS } from './api/endpoints';
import { apiErrorFromPayload } from './api/errors';
import type {
  AddStickerResponse,
  StickerRepoResponse,
  UploadImageResponse,
} from './api/types';
import type { Attachment } from './types';

const API_URL = process.env.EXPO_PUBLIC_API_URL;

// 图片读取地址：GET /uploads/image/:id（需鉴权，配合 expo-image 的 source.headers）
export function imageUrl(id: string): string {
  return `${API_URL}${API_PATHS.uploadImage(id)}`;
}

// expo-image 读取受保护图片时挂在 source.headers 上的鉴权头
export const IMAGE_AUTH_HEADERS = { Authorization: `Bearer ${API_TOKEN}` };

// 上传一张图片：服务端做魔数/大小校验与持久化，返回干净附件元数据。
// kind: 'image'（聊天图片）| 'sticker'（登记进表情包库）
export async function uploadImage(
  dataUrl: string,
  kind: 'image' | 'sticker',
  name?: string
): Promise<Attachment> {
  const response = await apiFetch(API_PATHS.uploads, {
    method: 'POST',
    timeoutMs: TIMEOUTS.upload,
    body: JSON.stringify({ image: dataUrl, kind, name }),
  });

  const data = (await readJsonResponse(response)) as UploadImageResponse;

  if (!response.ok) {
    throw apiErrorFromPayload(data, response.status, '图片上传失败，请稍后再试。');
  }

  return { id: data.id, kind: data.kind, mime: data.mime, name: data.name };
}

// 表情包仓库列表（GET /sticker-repo）：加号面板的表情包选择器用。
// 响应 { stickers, total }，这里只取面板需要的字段。
export async function listStickerRepo(): Promise<Attachment[]> {
  const response = await apiFetch(API_PATHS.stickerRepo);

  const data = (await readJsonResponse(response)) as StickerRepoResponse;

  if (!response.ok || !Array.isArray(data.stickers)) {
    throw apiErrorFromPayload(data, response.status, '读取表情包仓库失败');
  }

  return data.stickers.map((item: Attachment) => ({
    id: item.id,
    kind: 'sticker' as const,
    mime: item.mime,
    name: item.name,
  }));
}

// 仓库表情包图片地址：GET /sticker-repo/:id/image（与聊天图片不同路由）
export function stickerImageUrl(id: string): string {
  return `${API_URL}${API_PATHS.stickerImage(id)}`;
}

// 登记一张图片进表情包仓库（POST /sticker-repo）。
// 服务端做魔数/大小校验与 sha256 去重，重复图片返回已有条目。
export async function addSticker(
  dataUrl: string,
  name?: string
): Promise<Attachment> {
  const response = await apiFetch(API_PATHS.stickerRepo, {
    method: 'POST',
    timeoutMs: TIMEOUTS.upload,
    body: JSON.stringify({ image: dataUrl, name }),
  });

  const data = (await readJsonResponse(response)) as AddStickerResponse;

  if (!response.ok) {
    throw apiErrorFromPayload(data, response.status, '表情包添加失败，请稍后再试。');
  }

  const sticker = data.sticker;
  return {
    id: sticker.id,
    kind: 'sticker' as const,
    mime: sticker.mime,
    name: sticker.name,
  };
}
